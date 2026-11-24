-- =============================================================================
-- Buy-U Phase 6D.1 — Disputes & Buyer Protection Migration
-- STATUS: PROPOSAL ONLY — DO NOT APPLY WITHOUT EXPLICIT OWNER APPROVAL
-- TARGET PROJECT: duwwlcpdidrxkixvflag
--
-- Safety & Integrity Guarantees:
--   1. Reuses existing `public.order_disputes` table and statuses
--      (`open`, `under_review`, `resolved`), adding only minimal incremental
--      columns (`dispute_code`, `reason_code`, `description`,
--      `previous_order_status`, `seller_response`, `seller_evidence_paths`,
--      `seller_responded_at`, `under_review_at`, `under_review_by`,
--      `refund_execution_status`).
--   2. Partial unique index prevents concurrent duplicate active disputes per order.
--   3. Preserves direct client INSERT/UPDATE/DELETE REVOKE on `order_disputes`
--      and revokes SELECT on admin-only columns (`admin_notes`, `under_review_by`,
--      `resolved_by`) from `authenticated`/`anon`.
--   4. Authorized SECURITY DEFINER RPCs lock `public.orders` BEFORE
--      `public.order_disputes` (consistent with Phase 6C, deadlock-free):
--        - `open_order_dispute_atomic` (buyer-only, 7-day completed-order
--          protection window + undisbursed-funds check, freezes ONLY affected order)
--        - `submit_seller_dispute_response_atomic` (seller-only, cannot alter
--          buyer complaint/evidence or resolve/unfreeze)
--        - `admin_mark_dispute_under_review_atomic` (`is_active_admin()` enforced)
--        - `admin_resolve_order_dispute_atomic` (`is_active_admin()` enforced;
--          `release_to_seller` restores `previous_order_status` without skipping
--          receipt confirmation; `full_refund`/`partial_refund` marks
--          `refund_execution_status = 'pending_execution'` and keeps order frozen
--          until Phase 6D.2 executes the refund).
--   5. Keeps `dispute-evidence` storage bucket private (`public = false`) and
--      preserves `pickup_pin` privacy and Phase 6B/6C invariants.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Incremental columns & constraints on `public.order_disputes`
-- -----------------------------------------------------------------------------
ALTER TABLE public.order_disputes
  ADD COLUMN IF NOT EXISTS dispute_code text,
  ADD COLUMN IF NOT EXISTS reason_code text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS previous_order_status text,
  ADD COLUMN IF NOT EXISTS seller_response text,
  ADD COLUMN IF NOT EXISTS seller_evidence_paths text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS seller_responded_at timestamptz,
  ADD COLUMN IF NOT EXISTS under_review_at timestamptz,
  ADD COLUMN IF NOT EXISTS under_review_by uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS refund_execution_status text NOT NULL DEFAULT 'not_applicable';

-- Backfill dispute_code for any pre-existing rows (idempotent)
UPDATE public.order_disputes
SET dispute_code = 'DSP-' || to_char(COALESCE(created_at, now()) AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYMM')
                   || '-' || upper(substr(replace(id::text, '-', ''), 1, 6))
WHERE dispute_code IS NULL;

ALTER TABLE public.order_disputes
  ALTER COLUMN dispute_code SET NOT NULL;

-- Drop legacy single-dispute-ever UNIQUE(order_id) so a new eligible dispute can
-- be opened after a `release_to_seller` resolution while still blocking duplicate
-- active disputes via `idx_order_disputes_one_active_per_order`.
ALTER TABLE public.order_disputes
  DROP CONSTRAINT IF EXISTS order_disputes_order_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_order_disputes_dispute_code
  ON public.order_disputes (dispute_code);

-- Concurrency-safe guarantee: at most ONE active dispute (`open`/`under_review`) per order
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_disputes_one_active_per_order
  ON public.order_disputes (order_id)
  WHERE status IN ('open', 'under_review');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'order_disputes_reason_code_check'
      AND conrelid = 'public.order_disputes'::regclass
  ) THEN
    ALTER TABLE public.order_disputes
      ADD CONSTRAINT order_disputes_reason_code_check
      CHECK (
        reason_code IS NULL
        OR reason_code IN (
          'not_received',
          'not_as_described',
          'damaged',
          'wrong_item',
          'missing_item',
          'other'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'order_disputes_previous_status_check'
      AND conrelid = 'public.order_disputes'::regclass
  ) THEN
    ALTER TABLE public.order_disputes
      ADD CONSTRAINT order_disputes_previous_status_check
      CHECK (
        previous_order_status IS NULL
        OR previous_order_status IN ('paid', 'handed_over', 'completed')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'order_disputes_refund_exec_status_check'
      AND conrelid = 'public.order_disputes'::regclass
  ) THEN
    ALTER TABLE public.order_disputes
      ADD CONSTRAINT order_disputes_refund_exec_status_check
      CHECK (
        refund_execution_status IN (
          'not_applicable',
          'pending_execution',
          'executed',
          'failed'
        )
      );
  END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. Column-level SELECT privacy & write lockdown on `public.order_disputes`
--    (Excludes admin-only columns: `admin_notes`, `under_review_by`, `resolved_by`)
-- -----------------------------------------------------------------------------
REVOKE ALL ON public.order_disputes FROM PUBLIC, anon, authenticated;

GRANT SELECT (
  id,
  dispute_code,
  order_id,
  opened_by,
  reason,
  reason_code,
  description,
  evidence_paths,
  previous_order_status,
  seller_response,
  seller_evidence_paths,
  seller_responded_at,
  status,
  under_review_at,
  resolution_type,
  refund_amount_sen,
  refund_execution_status,
  refund_ref,
  resolved_at,
  created_at,
  updated_at
) ON public.order_disputes TO authenticated;

-- Ensure `order_disputes` is NOT exposed over Realtime publication
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'order_disputes'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.order_disputes;
  END IF;
END;
$$;

-- Ensure `dispute-evidence` storage bucket stays strictly private
UPDATE storage.buckets
SET public = false
WHERE id = 'dispute-evidence';

-- Temporarily close direct client writes on `public.payout_requests` until
-- Phase 6D.4 implements atomic withdrawal RPCs (preserves SELECT & existing rows)
REVOKE INSERT, UPDATE, DELETE ON public.payout_requests FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. Buyer-only Atomic Dispute Creation (`open_order_dispute_atomic`)
--    Completed-order protection window: 7 days from `completed_at` AND seller's
--    undisbursed completed earnings must cover `order.seller_net_sen`.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.open_order_dispute_atomic(uuid, text, text, text[]);

CREATE OR REPLACE FUNCTION public.open_order_dispute_atomic(
  p_order_id uuid,
  p_reason_code text,
  p_description text,
  p_evidence_paths text[] DEFAULT '{}'::text[]
)
RETURNS TABLE (
  id                    uuid,
  dispute_code          text,
  order_id              uuid,
  status                text,
  previous_order_status text,
  created_at            timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_order public.orders;
  v_now timestamptz;
  v_clean_code text := lower(trim(COALESCE(p_reason_code, '')));
  v_clean_desc text := trim(COALESCE(p_description, ''));
  v_paths text[] := COALESCE(p_evidence_paths, '{}'::text[]);
  v_path text;
  v_reason_label text;
  v_payment_ok boolean := false;
  v_completed_net_total bigint := 0;
  v_active_payouts_total bigint := 0;
  v_dispute_code text;
  v_dispute public.order_disputes;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;

  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;

  v_reason_label := CASE v_clean_code
    WHEN 'not_received'     THEN 'Item not received / seller no-show'
    WHEN 'not_as_described' THEN 'Item not as described'
    WHEN 'damaged'          THEN 'Damaged or defective item'
    WHEN 'wrong_item'       THEN 'Wrong item received'
    WHEN 'missing_item'     THEN 'Missing item or quantity'
    WHEN 'other'            THEN 'Other order issue'
    ELSE NULL
  END;

  IF v_reason_label IS NULL THEN
    RAISE EXCEPTION 'INVALID_DISPUTE_REASON';
  END IF;

  IF length(v_clean_desc) < 20 OR length(v_clean_desc) > 2000 THEN
    RAISE EXCEPTION 'INVALID_DISPUTE_DESCRIPTION';
  END IF;

  IF COALESCE(cardinality(v_paths), 0) > 5 THEN
    RAISE EXCEPTION 'TOO_MANY_EVIDENCE_FILES';
  END IF;

  -- Validate every evidence path belongs strictly to `<buyer_uid>/<order_id>/<safe-file>`
  -- AND actually exists in the private `dispute-evidence` storage bucket
  FOREACH v_path IN ARRAY v_paths LOOP
    IF v_path IS NULL
       OR v_path LIKE '%..%'
       OR v_path !~ ('^' || v_uid::text || '/' || p_order_id::text || '/[A-Za-z0-9._-]+$') THEN
      RAISE EXCEPTION 'INVALID_EVIDENCE_PATH';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM storage.objects so
      WHERE so.bucket_id = 'dispute-evidence'
        AND so.name = v_path
    ) THEN
      RAISE EXCEPTION 'EVIDENCE_OBJECT_NOT_FOUND';
    END IF;
  END LOOP;

  -- Lock order row FIRST (consistent lock order with Phase 6C lifecycle RPCs)
  SELECT o.* INTO v_order
  FROM public.orders o
  WHERE o.id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;

  IF v_order.buyer_id <> v_uid OR v_order.seller_id = v_uid THEN
    RAISE EXCEPTION 'FORBIDDEN_BUYER_ONLY' USING ERRCODE = '42501';
  END IF;

  v_now := clock_timestamp();

  -- Block unpaid, expired, cancelled, refunded, or already-disputed orders
  IF v_order.status = 'disputed' THEN
    RAISE EXCEPTION 'DISPUTE_ALREADY_ACTIVE';
  END IF;

  IF v_order.status NOT IN ('paid', 'handed_over', 'completed') THEN
    RAISE EXCEPTION 'ORDER_NOT_DISPUTABLE';
  END IF;

  -- Block if an active dispute OR pending/executed refund already exists on this order
  -- (Allows a new eligible dispute after `release_to_seller`, never repeated refunds)
  IF EXISTS (
    SELECT 1
    FROM public.order_disputes d
    WHERE d.order_id = v_order.id
      AND (
        lower(COALESCE(d.status, '')) IN ('open', 'under_review')
        OR d.refund_execution_status IN ('pending_execution', 'executed')
      )
  ) THEN
    RAISE EXCEPTION 'DISPUTE_ALREADY_ACTIVE';
  END IF;

  -- Verify authoritative payment proof (parent unified checkout OR legacy payment)
  IF v_order.paid_at IS NOT NULL THEN
    IF v_order.checkout_session_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1
        FROM public.checkout_sessions cs
        WHERE cs.id = v_order.checkout_session_id
          AND cs.buyer_id = v_order.buyer_id
          AND cs.status = 'paid'
          AND cs.payment_status = 'paid'
          AND cs.paid_at IS NOT NULL
      ) INTO v_payment_ok;
    ELSE
      SELECT EXISTS (
        SELECT 1
        FROM public.payments p
        WHERE p.order_id = v_order.id
          AND p.status = 'paid'
          AND p.verified_at IS NOT NULL
      ) INTO v_payment_ok;
    END IF;
  END IF;

  IF NOT v_payment_ok THEN
    RAISE EXCEPTION 'PAYMENT_UNVERIFIED';
  END IF;

  -- Completed-order protection window (7 days) + prevent disputing already-disbursed funds
  IF v_order.status = 'completed' THEN
    IF v_order.completed_at IS NULL
       OR v_now > (v_order.completed_at + interval '7 days') THEN
      RAISE EXCEPTION 'DISPUTE_WINDOW_EXPIRED';
    END IF;

    SELECT COALESCE(SUM(o2.seller_net_sen), 0)::bigint
    INTO v_completed_net_total
    FROM public.orders o2
    WHERE o2.seller_id = v_order.seller_id
      AND o2.status = 'completed'
      AND o2.paid_at IS NOT NULL;

    -- Actual hosted payout_requests statuses: pending, paid, rejected.
    -- Phase 6D.4 must coordinate withdrawals & disputes via a shared seller-level
    -- lock and reserve sufficient funds for the 7-day buyer protection window.
    SELECT COALESCE(SUM(pr.amount_sen), 0)::bigint
    INTO v_active_payouts_total
    FROM public.payout_requests pr
    WHERE pr.seller_id = v_order.seller_id
      AND lower(COALESCE(pr.status, '')) IN ('pending', 'paid');

    IF (v_completed_net_total - v_active_payouts_total) < v_order.seller_net_sen THEN
      RAISE EXCEPTION 'FUNDS_ALREADY_DISBURSED';
    END IF;
  END IF;

  v_dispute_code := 'DSP-'
    || to_char(v_now AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYMM')
    || '-'
    || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

  INSERT INTO public.order_disputes (
    dispute_code,
    order_id,
    opened_by,
    reason,
    reason_code,
    description,
    evidence_paths,
    previous_order_status,
    status,
    refund_execution_status,
    created_at,
    updated_at
  ) VALUES (
    v_dispute_code,
    v_order.id,
    v_uid,
    v_reason_label,
    v_clean_code,
    v_clean_desc,
    v_paths,
    v_order.status,
    'open',
    'not_applicable',
    v_now,
    v_now
  )
  RETURNING * INTO v_dispute;

  -- Freeze ONLY this affected seller order (never touches sibling orders or payment records)
  UPDATE public.orders o
  SET status = 'disputed',
      updated_at = v_now
  WHERE o.id = v_order.id;

  RETURN QUERY SELECT
    v_dispute.id,
    v_dispute.dispute_code,
    v_dispute.order_id,
    v_dispute.status,
    v_dispute.previous_order_status,
    v_dispute.created_at;
END;
$$;

REVOKE ALL ON FUNCTION public.open_order_dispute_atomic(uuid, text, text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.open_order_dispute_atomic(uuid, text, text, text[]) TO authenticated;

-- -----------------------------------------------------------------------------
-- 4. Seller-only Dispute Response (`submit_seller_dispute_response_atomic`)
--    Seller can submit explanation & up to 5 evidence images while open/under_review.
--    Cannot alter buyer complaint/evidence, resolve dispute, or unfreeze earnings.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.submit_seller_dispute_response_atomic(uuid, text, text[]);

CREATE OR REPLACE FUNCTION public.submit_seller_dispute_response_atomic(
  p_dispute_id uuid,
  p_response text,
  p_evidence_paths text[] DEFAULT '{}'::text[]
)
RETURNS TABLE (
  id                  uuid,
  dispute_code        text,
  status              text,
  seller_responded_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_order_id uuid;
  v_order public.orders;
  v_dispute public.order_disputes;
  v_now timestamptz;
  v_clean_resp text := trim(COALESCE(p_response, ''));
  v_paths text[] := COALESCE(p_evidence_paths, '{}'::text[]);
  v_path text;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;

  IF p_dispute_id IS NULL THEN
    RAISE EXCEPTION 'DISPUTE_NOT_FOUND';
  END IF;

  IF length(v_clean_resp) < 10 OR length(v_clean_resp) > 2000 THEN
    RAISE EXCEPTION 'INVALID_SELLER_RESPONSE';
  END IF;

  IF COALESCE(cardinality(v_paths), 0) > 5 THEN
    RAISE EXCEPTION 'TOO_MANY_EVIDENCE_FILES';
  END IF;

  -- Non-locking peek for consistent lock order: orders -> order_disputes
  SELECT d.order_id INTO v_order_id
  FROM public.order_disputes d
  WHERE d.id = p_dispute_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DISPUTE_NOT_FOUND';
  END IF;

  SELECT o.* INTO v_order
  FROM public.orders o
  WHERE o.id = v_order_id
  FOR UPDATE;

  SELECT d.* INTO v_dispute
  FROM public.order_disputes d
  WHERE d.id = p_dispute_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DISPUTE_NOT_FOUND';
  END IF;

  IF v_order.seller_id <> v_uid OR v_order.buyer_id = v_uid THEN
    RAISE EXCEPTION 'FORBIDDEN_SELLER_ONLY' USING ERRCODE = '42501';
  END IF;

  IF v_dispute.status NOT IN ('open', 'under_review') THEN
    RAISE EXCEPTION 'DISPUTE_ALREADY_RESOLVED';
  END IF;

  FOREACH v_path IN ARRAY v_paths LOOP
    IF v_path IS NULL
       OR v_path LIKE '%..%'
       OR v_path !~ ('^' || v_uid::text || '/' || v_order.id::text || '/[A-Za-z0-9._-]+$') THEN
      RAISE EXCEPTION 'INVALID_EVIDENCE_PATH';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM storage.objects so
      WHERE so.bucket_id = 'dispute-evidence'
        AND so.name = v_path
    ) THEN
      RAISE EXCEPTION 'EVIDENCE_OBJECT_NOT_FOUND';
    END IF;
  END LOOP;

  v_now := clock_timestamp();

  UPDATE public.order_disputes d
  SET seller_response = v_clean_resp,
      seller_evidence_paths = v_paths,
      seller_responded_at = v_now,
      updated_at = v_now
  WHERE d.id = v_dispute.id
  RETURNING * INTO v_dispute;

  RETURN QUERY SELECT
    v_dispute.id,
    v_dispute.dispute_code,
    v_dispute.status,
    v_dispute.seller_responded_at;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_seller_dispute_response_atomic(uuid, text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_seller_dispute_response_atomic(uuid, text, text[]) TO authenticated;

-- -----------------------------------------------------------------------------
-- 5. Admin-only Mark Under Review (`admin_mark_dispute_under_review_atomic`)
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.admin_mark_dispute_under_review_atomic(uuid, text);

CREATE OR REPLACE FUNCTION public.admin_mark_dispute_under_review_atomic(
  p_dispute_id uuid,
  p_admin_notes text DEFAULT NULL
)
RETURNS TABLE (
  id              uuid,
  dispute_code    text,
  status          text,
  under_review_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_order_id uuid;
  v_dispute public.order_disputes;
  v_now timestamptz;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY' USING ERRCODE = '42501';
  END IF;

  SELECT d.order_id INTO v_order_id
  FROM public.order_disputes d
  WHERE d.id = p_dispute_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DISPUTE_NOT_FOUND';
  END IF;

  PERFORM 1 FROM public.orders o WHERE o.id = v_order_id FOR UPDATE;

  SELECT d.* INTO v_dispute
  FROM public.order_disputes d
  WHERE d.id = p_dispute_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DISPUTE_NOT_FOUND';
  END IF;

  IF v_dispute.status = 'resolved' THEN
    RAISE EXCEPTION 'DISPUTE_ALREADY_RESOLVED';
  END IF;

  v_now := clock_timestamp();

  UPDATE public.order_disputes d
  SET status = 'under_review',
      under_review_at = COALESCE(d.under_review_at, v_now),
      under_review_by = COALESCE(d.under_review_by, v_uid),
      admin_notes = CASE
        WHEN p_admin_notes IS NOT NULL THEN trim(p_admin_notes)
        ELSE d.admin_notes
      END,
      updated_at = v_now
  WHERE d.id = v_dispute.id
  RETURNING * INTO v_dispute;

  RETURN QUERY SELECT
    v_dispute.id,
    v_dispute.dispute_code,
    v_dispute.status,
    v_dispute.under_review_at;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_mark_dispute_under_review_atomic(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_mark_dispute_under_review_atomic(uuid, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 6. Admin-only Dispute Resolution (`admin_resolve_order_dispute_atomic`)
--    - `release_to_seller`: restores `previous_order_status` (`paid`,
--      `handed_over`, or `completed`) without skipping receipt confirmation.
--    - `full_refund` / `partial_refund`: records `refund_execution_status =
--      'pending_execution'`, keeps `refund_ref = NULL` and keeps `orders.status =
--      'disputed'` (frozen) until Phase 6D.2 executes the refund!
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.admin_resolve_order_dispute_atomic(uuid, text, integer, text);

CREATE OR REPLACE FUNCTION public.admin_resolve_order_dispute_atomic(
  p_dispute_id uuid,
  p_resolution_type text,
  p_refund_amount_sen integer DEFAULT NULL,
  p_admin_notes text DEFAULT NULL
)
RETURNS TABLE (
  id                      uuid,
  dispute_code            text,
  status                  text,
  resolution_type         text,
  refund_amount_sen       integer,
  refund_execution_status text,
  order_status            text,
  resolved_at             timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_order_id uuid;
  v_order public.orders;
  v_dispute public.order_disputes;
  v_now timestamptz;
  v_res_type text := lower(trim(COALESCE(p_resolution_type, '')));
  v_prior_refunded_sen integer := 0;
  v_remaining_refundable integer := 0;
  v_refund_sen integer := 0;
  v_exec_status text := 'not_applicable';
  v_next_order_status text;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY' USING ERRCODE = '42501';
  END IF;

  IF v_res_type NOT IN ('release_to_seller', 'full_refund', 'partial_refund') THEN
    RAISE EXCEPTION 'INVALID_RESOLUTION_TYPE';
  END IF;

  SELECT d.order_id INTO v_order_id
  FROM public.order_disputes d
  WHERE d.id = p_dispute_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DISPUTE_NOT_FOUND';
  END IF;

  SELECT o.* INTO v_order
  FROM public.orders o
  WHERE o.id = v_order_id
  FOR UPDATE;

  SELECT d.* INTO v_dispute
  FROM public.order_disputes d
  WHERE d.id = p_dispute_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DISPUTE_NOT_FOUND';
  END IF;

  IF v_dispute.status = 'resolved' THEN
    RAISE EXCEPTION 'DISPUTE_ALREADY_RESOLVED';
  END IF;

  -- Require a genuinely disputed order before recording any admin resolution
  IF v_order.status <> 'disputed' THEN
    RAISE EXCEPTION 'ORDER_NOT_DISPUTED';
  END IF;

  -- Prevent repeated refunds against already-refunded or pending-execution amounts
  SELECT COALESCE(SUM(d2.refund_amount_sen), 0)::integer
  INTO v_prior_refunded_sen
  FROM public.order_disputes d2
  WHERE d2.order_id = v_order.id
    AND d2.id <> v_dispute.id
    AND d2.refund_execution_status IN ('pending_execution', 'executed');

  v_remaining_refundable := GREATEST(0, v_order.subtotal_sen - v_prior_refunded_sen);

  IF v_res_type = 'release_to_seller' THEN
    v_refund_sen := 0;
    v_exec_status := 'not_applicable';
    -- Restore exact pre-dispute lifecycle state without skipping receipt confirmation
    IF v_dispute.previous_order_status IN ('paid', 'handed_over', 'completed') THEN
      v_next_order_status := v_dispute.previous_order_status;
    ELSIF v_order.completed_at IS NOT NULL THEN
      v_next_order_status := 'completed';
    ELSIF v_order.handed_over_at IS NOT NULL THEN
      v_next_order_status := 'handed_over';
    ELSE
      v_next_order_status := 'paid';
    END IF;
  ELSIF v_res_type = 'full_refund' THEN
    IF v_remaining_refundable <= 0 THEN
      RAISE EXCEPTION 'ORDER_ALREADY_REFUNDED';
    END IF;
    v_refund_sen := v_remaining_refundable;
    v_exec_status := 'pending_execution';
    -- Keep order frozen (`disputed`) until Phase 6D.2 executes refund
    v_next_order_status := 'disputed';
  ELSE
    -- partial_refund
    IF v_remaining_refundable <= 1 THEN
      RAISE EXCEPTION 'ORDER_ALREADY_REFUNDED';
    END IF;
    IF p_refund_amount_sen IS NULL
       OR p_refund_amount_sen <= 0
       OR p_refund_amount_sen >= v_remaining_refundable THEN
      RAISE EXCEPTION 'INVALID_PARTIAL_REFUND_AMOUNT';
    END IF;
    v_refund_sen := p_refund_amount_sen;
    v_exec_status := 'pending_execution';
    -- Keep order frozen (`disputed`) until Phase 6D.2 executes refund
    v_next_order_status := 'disputed';
  END IF;

  v_now := clock_timestamp();

  UPDATE public.order_disputes d
  SET status = 'resolved',
      resolution_type = v_res_type,
      refund_amount_sen = v_refund_sen,
      refund_execution_status = v_exec_status,
      refund_ref = NULL,
      admin_notes = CASE
        WHEN p_admin_notes IS NOT NULL THEN trim(p_admin_notes)
        ELSE d.admin_notes
      END,
      resolved_by = v_uid,
      resolved_at = v_now,
      updated_at = v_now
  WHERE d.id = v_dispute.id
  RETURNING * INTO v_dispute;

  UPDATE public.orders o
  SET status = v_next_order_status,
      updated_at = v_now
  WHERE o.id = v_order.id;

  RETURN QUERY SELECT
    v_dispute.id,
    v_dispute.dispute_code,
    v_dispute.status,
    v_dispute.resolution_type,
    v_dispute.refund_amount_sen,
    v_dispute.refund_execution_status,
    v_next_order_status,
    v_dispute.resolved_at;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_resolve_order_dispute_atomic(uuid, text, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_resolve_order_dispute_atomic(uuid, text, integer, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 7. Update Phase 6C lifecycle RPCs so orders with `pending_execution` refunds
--    remain blocked from handover or receipt confirmation until Phase 6D.2
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_order_pickup_pin_atomic(
  p_order_id uuid,
  p_pin text
)
RETURNS TABLE (
  outcome            text,
  order_id           uuid,
  status             text,
  handed_over_at     timestamptz,
  failed_attempts    integer,
  attempts_remaining integer,
  locked_until       timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_order public.orders;
  v_now timestamptz;
  v_clean_pin text;
  v_payment_ok boolean := false;
  v_has_blocking_dispute boolean := false;
  v_base_attempts integer := 0;
  v_new_attempts integer := 0;
  v_locked_until timestamptz := NULL;
  v_max_attempts CONSTANT integer := 5;
  v_lockout_window CONSTANT interval := interval '15 minutes';
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;

  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;

  SELECT o.* INTO v_order
  FROM public.orders o
  WHERE o.id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;

  IF v_order.seller_id <> v_uid OR v_order.buyer_id = v_uid THEN
    RAISE EXCEPTION 'FORBIDDEN_SELLER_ONLY' USING ERRCODE = '42501';
  END IF;

  v_now := clock_timestamp();

  IF v_order.status = 'handed_over' THEN
    RETURN QUERY SELECT
      'already_handed_over'::text, v_order.id, v_order.status, v_order.handed_over_at,
      COALESCE(v_order.pin_failed_attempts, 0), v_max_attempts, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_order.status = 'completed' THEN
    RETURN QUERY SELECT
      'already_completed'::text, v_order.id, v_order.status, v_order.handed_over_at,
      0, v_max_attempts, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.order_disputes d
    WHERE d.order_id = v_order.id
      AND (
        lower(COALESCE(d.status, '')) IN ('open', 'under_review')
        OR d.refund_execution_status = 'pending_execution'
      )
  ) INTO v_has_blocking_dispute;

  IF v_order.status = 'disputed' OR v_has_blocking_dispute THEN
    RETURN QUERY SELECT
      'order_disputed'::text, v_order.id, v_order.status, v_order.handed_over_at,
      COALESCE(v_order.pin_failed_attempts, 0),
      GREATEST(0, v_max_attempts - COALESCE(v_order.pin_failed_attempts, 0)),
      v_order.pin_locked_until;
    RETURN;
  END IF;

  IF v_order.status <> 'paid' THEN
    RETURN QUERY SELECT
      'invalid_status'::text, v_order.id, v_order.status, v_order.handed_over_at,
      COALESCE(v_order.pin_failed_attempts, 0),
      GREATEST(0, v_max_attempts - COALESCE(v_order.pin_failed_attempts, 0)),
      v_order.pin_locked_until;
    RETURN;
  END IF;

  IF v_order.paid_at IS NOT NULL THEN
    IF v_order.checkout_session_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1
        FROM public.checkout_sessions cs
        WHERE cs.id = v_order.checkout_session_id
          AND cs.buyer_id = v_order.buyer_id
          AND cs.status = 'paid'
          AND cs.payment_status = 'paid'
          AND cs.paid_at IS NOT NULL
      ) INTO v_payment_ok;
    ELSE
      SELECT EXISTS (
        SELECT 1
        FROM public.payments p
        WHERE p.order_id = v_order.id
          AND p.status = 'paid'
          AND p.verified_at IS NOT NULL
      ) INTO v_payment_ok;
    END IF;
  END IF;

  IF NOT v_payment_ok THEN
    RETURN QUERY SELECT
      'payment_unverified'::text, v_order.id, v_order.status, v_order.handed_over_at,
      COALESCE(v_order.pin_failed_attempts, 0),
      GREATEST(0, v_max_attempts - COALESCE(v_order.pin_failed_attempts, 0)),
      v_order.pin_locked_until;
    RETURN;
  END IF;

  IF v_order.pickup_pin IS NULL OR length(trim(v_order.pickup_pin)) <> 6 THEN
    RETURN QUERY SELECT
      'pin_unavailable'::text, v_order.id, v_order.status, v_order.handed_over_at,
      COALESCE(v_order.pin_failed_attempts, 0),
      GREATEST(0, v_max_attempts - COALESCE(v_order.pin_failed_attempts, 0)),
      v_order.pin_locked_until;
    RETURN;
  END IF;

  IF v_order.pin_locked_until IS NOT NULL AND v_now < v_order.pin_locked_until THEN
    RETURN QUERY SELECT
      'locked'::text, v_order.id, v_order.status, v_order.handed_over_at,
      COALESCE(v_order.pin_failed_attempts, v_max_attempts), 0, v_order.pin_locked_until;
    RETURN;
  END IF;

  IF v_order.pin_locked_until IS NOT NULL AND v_now >= v_order.pin_locked_until THEN
    v_base_attempts := 0;
  ELSE
    v_base_attempts := GREATEST(0, COALESCE(v_order.pin_failed_attempts, 0));
  END IF;

  v_clean_pin := trim(COALESCE(p_pin, ''));
  IF v_clean_pin !~ '^[0-9]{6}$' THEN
    RETURN QUERY SELECT
      'invalid_pin_format'::text, v_order.id, v_order.status, v_order.handed_over_at,
      v_base_attempts, GREATEST(0, v_max_attempts - v_base_attempts), NULL::timestamptz;
    RETURN;
  END IF;

  IF encode(sha256(convert_to(v_clean_pin, 'UTF8')), 'hex')
     <> encode(sha256(convert_to(v_order.pickup_pin, 'UTF8')), 'hex') THEN
    v_new_attempts := v_base_attempts + 1;
    IF v_new_attempts >= v_max_attempts THEN
      v_locked_until := v_now + v_lockout_window;
    ELSE
      v_locked_until := NULL;
    END IF;

    UPDATE public.orders o
    SET pin_failed_attempts = v_new_attempts,
        pin_locked_until = v_locked_until,
        updated_at = v_now
    WHERE o.id = v_order.id;

    RETURN QUERY SELECT
      CASE WHEN v_locked_until IS NOT NULL THEN 'locked' ELSE 'invalid_pin' END::text,
      v_order.id, v_order.status, v_order.handed_over_at,
      v_new_attempts, GREATEST(0, v_max_attempts - v_new_attempts), v_locked_until;
    RETURN;
  END IF;

  UPDATE public.orders o
  SET status = 'handed_over',
      handed_over_at = v_now,
      pickup_pin = NULL,
      pin_failed_attempts = 0,
      pin_locked_until = NULL,
      updated_at = v_now
  WHERE o.id = v_order.id;

  RETURN QUERY SELECT
    'handed_over'::text, v_order.id, 'handed_over'::text, v_now, 0, v_max_attempts, NULL::timestamptz;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_order_pickup_pin_atomic(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_order_pickup_pin_atomic(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.confirm_buyer_order_receipt_atomic(
  p_order_id uuid
)
RETURNS TABLE (
  outcome      text,
  order_id     uuid,
  status       text,
  completed_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_order public.orders;
  v_now timestamptz;
  v_payment_ok boolean := false;
  v_has_blocking_dispute boolean := false;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;

  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;

  SELECT o.* INTO v_order
  FROM public.orders o
  WHERE o.id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;

  IF v_order.buyer_id <> v_uid OR v_order.seller_id = v_uid THEN
    RAISE EXCEPTION 'FORBIDDEN_BUYER_ONLY' USING ERRCODE = '42501';
  END IF;

  IF v_order.status = 'completed' THEN
    RETURN QUERY SELECT
      'already_completed'::text, v_order.id, v_order.status, v_order.completed_at;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.order_disputes d
    WHERE d.order_id = v_order.id
      AND (
        lower(COALESCE(d.status, '')) IN ('open', 'under_review')
        OR d.refund_execution_status = 'pending_execution'
      )
  ) INTO v_has_blocking_dispute;

  IF v_order.status = 'disputed' OR v_has_blocking_dispute THEN
    RETURN QUERY SELECT
      'order_disputed'::text, v_order.id, v_order.status, v_order.completed_at;
    RETURN;
  END IF;

  IF v_order.status <> 'handed_over' OR v_order.handed_over_at IS NULL THEN
    RETURN QUERY SELECT
      'invalid_status'::text, v_order.id, v_order.status, v_order.completed_at;
    RETURN;
  END IF;

  IF v_order.paid_at IS NOT NULL THEN
    IF v_order.checkout_session_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1
        FROM public.checkout_sessions cs
        WHERE cs.id = v_order.checkout_session_id
          AND cs.buyer_id = v_order.buyer_id
          AND cs.status = 'paid'
          AND cs.payment_status = 'paid'
          AND cs.paid_at IS NOT NULL
      ) INTO v_payment_ok;
    ELSE
      SELECT EXISTS (
        SELECT 1
        FROM public.payments p
        WHERE p.order_id = v_order.id
          AND p.status = 'paid'
          AND p.verified_at IS NOT NULL
      ) INTO v_payment_ok;
    END IF;
  END IF;

  IF NOT v_payment_ok THEN
    RETURN QUERY SELECT
      'payment_unverified'::text, v_order.id, v_order.status, v_order.completed_at;
    RETURN;
  END IF;

  v_now := clock_timestamp();

  UPDATE public.orders o
  SET status = 'completed',
      completed_at = v_now,
      completed_method = 'pickup_pin',
      pickup_pin = NULL,
      updated_at = v_now
  WHERE o.id = v_order.id;

  RETURN QUERY SELECT
    'completed'::text, v_order.id, 'completed'::text, v_now;
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_buyer_order_receipt_atomic(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_buyer_order_receipt_atomic(uuid) TO authenticated;

COMMIT;

-- =============================================================================
-- ROLLBACK NOTES (manual, only if needed):
--   DROP FUNCTION IF EXISTS public.open_order_dispute_atomic(uuid, text, text, text[]);
--   DROP FUNCTION IF EXISTS public.submit_seller_dispute_response_atomic(uuid, text, text[]);
--   DROP FUNCTION IF EXISTS public.admin_mark_dispute_under_review_atomic(uuid, text);
--   DROP FUNCTION IF EXISTS public.admin_resolve_order_dispute_atomic(uuid, text, integer, text);
--   (Keep column-level privacy REVOKE on `order_disputes` and `orders.pickup_pin`.)
-- =============================================================================
