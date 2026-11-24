-- =============================================================================
-- Buy-U Phase 6D — Complete Financial Ecosystem Consolidated Migration
-- STATUS: PROPOSAL ONLY — DO NOT APPLY WITHOUT EXPLICIT OWNER APPROVAL
-- TARGET PROJECT: duwwlcpdidrxkixvflag
--
-- Covers in ONE atomic, dependency-ordered migration:
--   Section 1: Three-Day (72-Hour) Buyer Protection Policy Update
--   Section 2: Phase 6D.2 Refund Execution, Physical Return & Restock Integrity
--   Section 3: Phase 6D.3 Seller Bank Account Hardening (Encrypted at Rest)
--   Section 4: Immutable Financial Adjustments & Order-Level Payout Allocations
--   Section 5: Phase 6D.4 Automated Seller Withdrawals & Shared Seller-Level Lock
--   Section 6: Phase 6D.5 Admin Financial Reconciliation & Exception Recovery
--   Section 7: Idempotent Financial Notifications, Grants & Privacy Lockdown
--
-- Shared Lock Order (deadlock-free across ALL Phase 6C/6D RPCs):
--   profiles (seller_id FOR UPDATE) -> orders (ORDER BY id FOR UPDATE)
--   -> order_disputes -> order_refunds -> payout_requests -> payout_allocations
--   -> listings (ORDER BY id) -> listing_variants (ORDER BY id)
--
-- Historical Transition Policy:
--   - Existing disputes opened under the previous 7-day policy remain valid.
--   - Completed-order protection uses `completed_at + interval '72 hours'`
--     with exact boundary: dispute `< protection_expires_at`,
--     withdrawal `>= protection_expires_at`.
--   - All historical orders, payments, disputes, and evidence are preserved.
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION 1: Notification Idempotency & Order Refund / Return / Restock Tables
-- =============================================================================
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS dedupe_key text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_user_dedupe_key
  ON public.notifications (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.order_refunds (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_code             text NOT NULL UNIQUE,
  dispute_id              uuid NOT NULL UNIQUE REFERENCES public.order_disputes(id) ON DELETE RESTRICT,
  order_id                uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  original_payment_ref    text,
  refund_type             text NOT NULL CHECK (refund_type IN ('full_refund', 'partial_refund')),
  refund_amount_sen       integer NOT NULL CHECK (refund_amount_sen > 0),
  commission_reversal_sen integer NOT NULL CHECK (commission_reversal_sen >= 0),
  seller_deduction_sen    integer NOT NULL CHECK (seller_deduction_sen >= 0),
  CONSTRAINT order_refunds_accounting_check
    CHECK (refund_amount_sen = commission_reversal_sen + seller_deduction_sen),
  status                  text NOT NULL DEFAULT 'pending_execution'
    CHECK (status IN (
      'pending_execution',
      'awaiting_return',
      'processing',
      'succeeded',
      'failed',
      'reconciliation_required'
    )),
  provider                text NOT NULL DEFAULT 'simulated_refund',
  simulation_mode         boolean NOT NULL DEFAULT true,
  idempotency_key         text NOT NULL UNIQUE,
  attempt_token           uuid,
  attempt_count           integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  refund_ref              text UNIQUE,
  return_required         boolean NOT NULL DEFAULT false,
  return_status           text NOT NULL DEFAULT 'not_required'
    CHECK (return_status IN (
      'not_required',
      'awaiting_return',
      'buyer_reported_returned',
      'return_confirmed',
      'return_exception'
    )),
  return_instructions     text,
  return_reported_at      timestamptz,
  return_reported_by      uuid REFERENCES public.profiles(id),
  return_confirmed_at     timestamptz,
  return_confirmed_by     uuid REFERENCES public.profiles(id),
  item_condition          text NOT NULL DEFAULT 'unknown'
    CHECK (item_condition IN ('unknown', 'resellable', 'damaged', 'missing')),
  restock_status          text NOT NULL DEFAULT 'not_applicable'
    CHECK (restock_status IN (
      'not_applicable',
      'pending_decision',
      'approved_restocked',
      'declined',
      'inventory_exception'
    )),
  restock_approved_by     uuid REFERENCES public.profiles(id),
  restocked_at            timestamptz,
  failure_reason          text,
  reconciliation_reason   text,
  initiated_by            uuid REFERENCES public.profiles(id),
  processing_started_at   timestamptz,
  completed_at            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- Enforce at most ONE succeeded refund per order (prevents duplicate/over-refunds)
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_refunds_one_succeeded_per_order
  ON public.order_refunds (order_id)
  WHERE status = 'succeeded';

CREATE INDEX IF NOT EXISTS idx_order_refunds_order_id
  ON public.order_refunds (order_id);

CREATE INDEX IF NOT EXISTS idx_order_refunds_status
  ON public.order_refunds (status);

-- Immutable restock ledger (guarantees ZERO duplicate restocking across retries/concurrency)
CREATE TABLE IF NOT EXISTS public.order_restock_logs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_id         uuid NOT NULL REFERENCES public.order_refunds(id) ON DELETE RESTRICT,
  order_id          uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  order_item_id     uuid NOT NULL REFERENCES public.order_items(id) ON DELETE RESTRICT,
  listing_id        uuid,
  variant_id        uuid,
  quantity_restored integer NOT NULL CHECK (quantity_restored >= 0),
  outcome           text NOT NULL CHECK (outcome IN ('restocked', 'inventory_exception')),
  note              text,
  approved_by       uuid NOT NULL REFERENCES public.profiles(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (refund_id, order_item_id)
);

-- Immutable financial adjustment ledger
CREATE TABLE IF NOT EXISTS public.financial_adjustments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  refund_id   uuid NOT NULL REFERENCES public.order_refunds(id) ON DELETE RESTRICT,
  dispute_id  uuid NOT NULL REFERENCES public.order_disputes(id) ON DELETE RESTRICT,
  seller_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  kind        text NOT NULL CHECK (kind IN (
    'refund_product',
    'commission_reversal',
    'seller_earnings_deduction'
  )),
  amount_sen  integer NOT NULL CHECK (amount_sen >= 0),
  note        text,
  created_by  uuid REFERENCES public.profiles(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (refund_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_financial_adjustments_seller_id
  ON public.financial_adjustments (seller_id);

-- =============================================================================
-- SECTION 2: Seller Bank Accounts Hardening (Phase 6D.3)
-- =============================================================================
ALTER TABLE public.seller_payout_accounts
  ADD COLUMN IF NOT EXISTS account_number_encrypted text,
  ADD COLUMN IF NOT EXISTS account_number_last4 text,
  ADD COLUMN IF NOT EXISTS account_number_masked text,
  ADD COLUMN IF NOT EXISTS validation_status text NOT NULL DEFAULT 'validated',
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'seller_payout_accounts_validation_status_check'
      AND conrelid = 'public.seller_payout_accounts'::regclass
  ) THEN
    ALTER TABLE public.seller_payout_accounts
      ADD CONSTRAINT seller_payout_accounts_validation_status_check
      CHECK (validation_status IN ('validated', 'deactivated'));
  END IF;
END;
$$;

-- Backfill masked display for any pre-existing rows (without exposing full account numbers)
UPDATE public.seller_payout_accounts
SET account_number_last4 = right(regexp_replace(COALESCE(account_number, ''), '\D', '', 'g'), 4),
    account_number_masked = '****' || right(regexp_replace(COALESCE(account_number, ''), '\D', '', 'g'), 4)
WHERE account_number_masked IS NULL
  AND account_number IS NOT NULL;

-- Lock down direct client access: NEVER allow authenticated/anon to read raw account_number or ciphertext
REVOKE ALL ON public.seller_payout_accounts FROM PUBLIC, anon, authenticated;

GRANT SELECT (
  seller_id,
  bank_name,
  account_holder_name,
  account_number_last4,
  account_number_masked,
  validation_status,
  is_active,
  deactivated_at,
  created_at,
  updated_at
) ON public.seller_payout_accounts TO authenticated;

-- =============================================================================
-- SECTION 3: Payout Requests & Order-Level Payout Allocations (Phase 6D.4)
-- =============================================================================
ALTER TABLE public.payout_requests
  ADD COLUMN IF NOT EXISTS withdrawal_code text,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS masked_bank_summary text,
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'simulated_bank',
  ADD COLUMN IF NOT EXISTS simulation_mode boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS attempt_token uuid,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS failure_reason text,
  ADD COLUMN IF NOT EXISTS reconciliation_reason text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE public.payout_requests
SET withdrawal_code = 'WDR-' || to_char(COALESCE(created_at, now()) AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYMM')
                      || '-' || upper(substr(replace(id::text, '-', ''), 1, 6))
WHERE withdrawal_code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_requests_withdrawal_code
  ON public.payout_requests (withdrawal_code)
  WHERE withdrawal_code IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_requests_idempotency_key
  ON public.payout_requests (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_requests_transfer_ref
  ON public.payout_requests (transfer_ref)
  WHERE transfer_ref IS NOT NULL;

-- Expand status CHECK safely to support automated simulated payout lifecycle
DO $$
DECLARE
  v_con text;
BEGIN
  FOR v_con IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.payout_requests'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE public.payout_requests DROP CONSTRAINT IF EXISTS %I', v_con);
  END LOOP;

  ALTER TABLE public.payout_requests
    ADD CONSTRAINT payout_requests_status_check
    CHECK (status IN (
      'pending',
      'processing',
      'paid',
      'failed',
      'rejected',
      'reconciliation_required'
    ));
END;
$$;

-- Order-level payout allocations (prevents double-spending and tracks exact fund attribution)
CREATE TABLE IF NOT EXISTS public.payout_allocations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_request_id uuid NOT NULL REFERENCES public.payout_requests(id) ON DELETE RESTRICT,
  order_id          uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  seller_id         uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  allocated_sen     integer NOT NULL CHECK (allocated_sen > 0),
  status            text NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'paid', 'released')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payout_request_id, order_id)
);

CREATE INDEX IF NOT EXISTS idx_payout_allocations_order_id
  ON public.payout_allocations (order_id);

CREATE INDEX IF NOT EXISTS idx_payout_allocations_seller_id
  ON public.payout_allocations (seller_id);

-- Column-level privacy & write lockdown on payout_requests + new financial tables
REVOKE ALL ON public.payout_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT (
  id,
  withdrawal_code,
  seller_id,
  amount_sen,
  masked_bank_summary,
  status,
  provider,
  simulation_mode,
  transfer_ref,
  failure_reason,
  reconciliation_reason,
  processing_started_at,
  processed_at,
  completed_at,
  created_at,
  updated_at
) ON public.payout_requests TO authenticated;

REVOKE ALL ON public.order_refunds FROM PUBLIC, anon, authenticated;
GRANT SELECT (
  id,
  refund_code,
  dispute_id,
  order_id,
  refund_type,
  refund_amount_sen,
  commission_reversal_sen,
  seller_deduction_sen,
  status,
  provider,
  simulation_mode,
  refund_ref,
  return_required,
  return_status,
  return_instructions,
  return_reported_at,
  return_confirmed_at,
  item_condition,
  restock_status,
  restocked_at,
  failure_reason,
  completed_at,
  created_at,
  updated_at
) ON public.order_refunds TO authenticated;

REVOKE ALL ON public.order_restock_logs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.financial_adjustments FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.payout_allocations FROM PUBLIC, anon, authenticated;

-- Enable RLS on all new tables (participant read on order_refunds; server/service_role for internal ledgers)
ALTER TABLE public.order_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_restock_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payout_allocations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS order_refunds_select_participant ON public.order_refunds;
CREATE POLICY order_refunds_select_participant ON public.order_refunds
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_refunds.order_id
        AND (o.buyer_id = auth.uid() OR o.seller_id = auth.uid())
    )
    OR public.is_active_admin()
  );

-- Ensure NONE of the financial tables are in Realtime publication
DO $$
DECLARE
  v_tbl text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY[
    'seller_payout_accounts',
    'payout_requests',
    'order_refunds',
    'order_restock_logs',
    'financial_adjustments',
    'payout_allocations'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = v_tbl
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE public.%I', v_tbl);
    END IF;
  END LOOP;
END;
$$;

-- =============================================================================
-- SECTION 4: Authoritative 72-Hour Buyer Protection & Dispute RPC Updates
-- =============================================================================
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
  v_seller_id uuid;
  v_order public.orders;
  v_now timestamptz;
  v_clean_code text := lower(trim(COALESCE(p_reason_code, '')));
  v_clean_desc text := trim(COALESCE(p_description, ''));
  v_paths text[] := COALESCE(p_evidence_paths, '{}'::text[]);
  v_path text;
  v_reason_label text;
  v_payment_ok boolean := false;
  v_allocated_sen integer := 0;
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

  FOREACH v_path IN ARRAY v_paths LOOP
    IF v_path IS NULL
       OR v_path LIKE '%..%'
       OR v_path !~ ('^' || v_uid::text || '/' || p_order_id::text || '/[A-Za-z0-9._-]+$') THEN
      RAISE EXCEPTION 'INVALID_EVIDENCE_PATH';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM storage.objects so
      WHERE so.bucket_id = 'dispute-evidence' AND so.name = v_path
    ) THEN
      RAISE EXCEPTION 'EVIDENCE_OBJECT_NOT_FOUND';
    END IF;
  END LOOP;

  -- Non-locking peek to acquire shared seller-level lock FIRST (deadlock-free with withdrawals)
  SELECT o.seller_id INTO v_seller_id
  FROM public.orders o
  WHERE o.id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;

  PERFORM 1 FROM public.profiles p WHERE p.id = v_seller_id FOR UPDATE;

  SELECT o.* INTO v_order
  FROM public.orders o
  WHERE o.id = p_order_id
  FOR UPDATE;

  IF v_order.buyer_id <> v_uid OR v_order.seller_id = v_uid THEN
    RAISE EXCEPTION 'FORBIDDEN_BUYER_ONLY' USING ERRCODE = '42501';
  END IF;

  v_now := clock_timestamp();

  IF v_order.status = 'disputed' THEN
    RAISE EXCEPTION 'DISPUTE_ALREADY_ACTIVE';
  END IF;

  IF v_order.status NOT IN ('paid', 'handed_over', 'completed') THEN
    RAISE EXCEPTION 'ORDER_NOT_DISPUTABLE';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.order_disputes d
    WHERE d.order_id = v_order.id
      AND (
        lower(COALESCE(d.status, '')) IN ('open', 'under_review')
        OR d.refund_execution_status IN ('pending_execution', 'executed')
      )
  ) THEN
    RAISE EXCEPTION 'DISPUTE_ALREADY_ACTIVE';
  END IF;

  -- Authoritative payment proof (unified checkout OR legacy payment)
  IF v_order.paid_at IS NOT NULL THEN
    IF v_order.checkout_session_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1 FROM public.checkout_sessions cs
        WHERE cs.id = v_order.checkout_session_id
          AND cs.buyer_id = v_order.buyer_id
          AND cs.status = 'paid'
          AND cs.payment_status = 'paid'
          AND cs.paid_at IS NOT NULL
      ) INTO v_payment_ok;
    ELSE
      SELECT EXISTS (
        SELECT 1 FROM public.payments p
        WHERE p.order_id = v_order.id
          AND p.status = 'paid'
          AND p.verified_at IS NOT NULL
      ) INTO v_payment_ok;
    END IF;
  END IF;

  IF NOT v_payment_ok THEN
    RAISE EXCEPTION 'PAYMENT_UNVERIFIED';
  END IF;

  -- THREE-DAY (72-HOUR) BUYER PROTECTION BOUNDARY:
  -- Dispute eligible strictly when v_now < completed_at + interval '72 hours'
  -- AND this order has NOT already been allocated to a reserved/paid withdrawal.
  IF v_order.status = 'completed' THEN
    IF v_order.completed_at IS NULL
       OR v_now >= (v_order.completed_at + interval '72 hours') THEN
      RAISE EXCEPTION 'DISPUTE_WINDOW_EXPIRED';
    END IF;

    SELECT COALESCE(SUM(pa.allocated_sen), 0)::integer
    INTO v_allocated_sen
    FROM public.payout_allocations pa
    WHERE pa.order_id = v_order.id
      AND pa.status IN ('reserved', 'paid');

    IF v_allocated_sen > 0 THEN
      RAISE EXCEPTION 'FUNDS_ALREADY_DISBURSED';
    END IF;
  END IF;

  v_dispute_code := 'DSP-'
    || to_char(v_now AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYMM')
    || '-'
    || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

  INSERT INTO public.order_disputes (
    dispute_code, order_id, opened_by, reason, reason_code, description,
    evidence_paths, previous_order_status, status, refund_execution_status,
    created_at, updated_at
  ) VALUES (
    v_dispute_code, v_order.id, v_uid, v_reason_label, v_clean_code, v_clean_desc,
    v_paths, v_order.status, 'open', 'not_applicable', v_now, v_now
  )
  RETURNING * INTO v_dispute;

  UPDATE public.orders o
  SET status = 'disputed', updated_at = v_now
  WHERE o.id = v_order.id;

  -- Idempotent notification to seller
  INSERT INTO public.notifications (user_id, kind, title, body, href, dedupe_key)
  VALUES (
    v_order.seller_id,
    'dispute_opened',
    'Dispute opened on #' || v_order.order_code,
    v_dispute_code || ': ' || v_reason_label,
    '/seller/disputes',
    'dispute-opened-' || v_dispute.id::text
  )
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT
    v_dispute.id, v_dispute.dispute_code, v_dispute.order_id,
    v_dispute.status, v_dispute.previous_order_status, v_dispute.created_at;
END;
$$;

-- Update admin_resolve_order_dispute_atomic to:
--   1. Acquire shared seller-level lock FIRST.
--   2. Automatically seed `public.order_refunds` when `full_refund` or `partial_refund` is approved!
CREATE OR REPLACE FUNCTION public.admin_resolve_order_dispute_atomic(
  p_dispute_id uuid,
  p_resolution_type text,
  p_refund_amount_sen integer DEFAULT NULL,
  p_admin_notes text DEFAULT NULL,
  p_return_required boolean DEFAULT false,
  p_return_instructions text DEFAULT NULL
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
  v_seller_id uuid;
  v_order public.orders;
  v_dispute public.order_disputes;
  v_now timestamptz;
  v_res_type text := lower(trim(COALESCE(p_resolution_type, '')));
  v_prior_refunded_sen integer := 0;
  v_remaining_refundable integer := 0;
  v_refund_sen integer := 0;
  v_retained_sub integer := 0;
  v_adjusted_comm integer := 0;
  v_comm_rev integer := 0;
  v_seller_deduct integer := 0;
  v_exec_status text := 'not_applicable';
  v_next_order_status text;
  v_payment_ref text := NULL;
  v_refund_code text;
  v_return_req boolean := COALESCE(p_return_required, false);
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

  SELECT o.seller_id INTO v_seller_id FROM public.orders o WHERE o.id = v_order_id;
  PERFORM 1 FROM public.profiles p WHERE p.id = v_seller_id FOR UPDATE;

  SELECT o.* INTO v_order FROM public.orders o WHERE o.id = v_order_id FOR UPDATE;
  SELECT d.* INTO v_dispute FROM public.order_disputes d WHERE d.id = p_dispute_id FOR UPDATE;

  IF v_dispute.status = 'resolved' THEN
    RAISE EXCEPTION 'DISPUTE_ALREADY_RESOLVED';
  END IF;

  IF v_order.status <> 'disputed' THEN
    RAISE EXCEPTION 'ORDER_NOT_DISPUTED';
  END IF;

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
    v_next_order_status := 'disputed';
  ELSE
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
    v_next_order_status := 'disputed';
  END IF;

  v_now := clock_timestamp();

  UPDATE public.order_disputes d
  SET status = 'resolved',
      resolution_type = v_res_type,
      refund_amount_sen = v_refund_sen,
      refund_execution_status = v_exec_status,
      refund_ref = NULL,
      admin_notes = CASE WHEN p_admin_notes IS NOT NULL THEN trim(p_admin_notes) ELSE d.admin_notes END,
      resolved_by = v_uid,
      resolved_at = v_now,
      updated_at = v_now
  WHERE d.id = v_dispute.id
  RETURNING * INTO v_dispute;

  UPDATE public.orders o
  SET status = v_next_order_status, updated_at = v_now
  WHERE o.id = v_order.id;

  -- Seed `public.order_refunds` record when refund is proposed
  IF v_res_type IN ('full_refund', 'partial_refund') THEN
    v_retained_sub := GREATEST(0, v_order.subtotal_sen - v_refund_sen);
    v_adjusted_comm := round(v_retained_sub * 0.02)::integer;
    v_comm_rev := GREATEST(0, v_order.commission_sen - v_adjusted_comm);
    v_seller_deduct := v_refund_sen - v_comm_rev;

    IF v_order.checkout_session_id IS NOT NULL THEN
      SELECT cs.transaction_ref INTO v_payment_ref
      FROM public.checkout_sessions cs WHERE cs.id = v_order.checkout_session_id;
    ELSE
      SELECT p.transaction_ref INTO v_payment_ref
      FROM public.payments p WHERE p.order_id = v_order.id AND p.status = 'paid' LIMIT 1;
    END IF;

    v_refund_code := 'RFD-'
      || to_char(v_now AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYMM')
      || '-'
      || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

    INSERT INTO public.order_refunds (
      refund_code, dispute_id, order_id, original_payment_ref,
      refund_type, refund_amount_sen, commission_reversal_sen, seller_deduction_sen,
      status, provider, simulation_mode, idempotency_key,
      return_required, return_status, return_instructions,
      restock_status, initiated_by, created_at, updated_at
    ) VALUES (
      v_refund_code, v_dispute.id, v_order.id, v_payment_ref,
      v_res_type, v_refund_sen, v_comm_rev, v_seller_deduct,
      CASE WHEN v_return_req THEN 'awaiting_return' ELSE 'pending_execution' END,
      'simulated_refund', true, 'rfd-' || v_dispute.id::text,
      v_return_req,
      CASE WHEN v_return_req THEN 'awaiting_return' ELSE 'not_required' END,
      NULLIF(trim(COALESCE(p_return_instructions, '')), ''),
      CASE WHEN v_res_type = 'full_refund' THEN 'pending_decision' ELSE 'not_applicable' END,
      v_uid, v_now, v_now
    )
    ON CONFLICT (dispute_id) DO NOTHING;

    INSERT INTO public.notifications (user_id, kind, title, body, href, dedupe_key)
    VALUES (
      v_order.buyer_id,
      CASE WHEN v_return_req THEN 'return_required' ELSE 'refund_approved' END,
      CASE WHEN v_return_req
        THEN 'Return required for #' || v_order.order_code
        ELSE 'Refund approved for #' || v_order.order_code END,
      'Approved simulated refund: RM ' || to_char(v_refund_sen / 100.0, 'FM999990.00'),
      '/orders',
      'refund-approved-' || v_dispute.id::text
    )
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN QUERY SELECT
    v_dispute.id, v_dispute.dispute_code, v_dispute.status, v_dispute.resolution_type,
    v_dispute.refund_amount_sen, v_dispute.refund_execution_status,
    v_next_order_status, v_dispute.resolved_at;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_resolve_order_dispute_atomic(uuid, text, integer, text, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_resolve_order_dispute_atomic(uuid, text, integer, text, boolean, text) TO authenticated;

-- Backfill `public.order_refunds` for existing preserved Phase 6D.1 pending_execution disputes (DSP-2611-218ADE, DSP-2611-21DDF7)
INSERT INTO public.order_refunds (
  refund_code, dispute_id, order_id, original_payment_ref,
  refund_type, refund_amount_sen, commission_reversal_sen, seller_deduction_sen,
  status, provider, simulation_mode, idempotency_key,
  return_required, return_status, restock_status, initiated_by, created_at, updated_at
)
SELECT
  'RFD-' || to_char(COALESCE(d.resolved_at, now()) AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYMM')
         || '-' || upper(substr(replace(d.id::text, '-', ''), 1, 6)),
  d.id,
  d.order_id,
  COALESCE(
    (SELECT cs.transaction_ref FROM public.checkout_sessions cs WHERE cs.id = o.checkout_session_id),
    (SELECT p.transaction_ref FROM public.payments p WHERE p.order_id = o.id AND p.status = 'paid' LIMIT 1)
  ),
  d.resolution_type,
  d.refund_amount_sen,
  GREATEST(0, o.commission_sen - round(GREATEST(0, o.subtotal_sen - d.refund_amount_sen) * 0.02)::integer),
  d.refund_amount_sen - GREATEST(0, o.commission_sen - round(GREATEST(0, o.subtotal_sen - d.refund_amount_sen) * 0.02)::integer),
  'pending_execution',
  'simulated_refund',
  true,
  'rfd-' || d.id::text,
  false,
  'not_required',
  CASE WHEN d.resolution_type = 'full_refund' THEN 'pending_decision' ELSE 'not_applicable' END,
  d.resolved_by,
  COALESCE(d.resolved_at, now()),
  now()
FROM public.order_disputes d
JOIN public.orders o ON o.id = d.order_id
WHERE d.status = 'resolved'
  AND d.refund_execution_status = 'pending_execution'
  AND d.resolution_type IN ('full_refund', 'partial_refund')
  AND d.refund_amount_sen > 0
ON CONFLICT (dispute_id) DO NOTHING;

-- =============================================================================
-- SECTION 5: Phase 6D.2 Return, Restock & Atomic Refund Execution RPCs
-- =============================================================================

-- 5.1 Admin configures return requirement before refund execution
CREATE OR REPLACE FUNCTION public.admin_configure_refund_return_atomic(
  p_refund_id uuid,
  p_return_required boolean,
  p_return_instructions text DEFAULT NULL
)
RETURNS public.order_refunds
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_refund public.order_refunds;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY' USING ERRCODE = '42501';
  END IF;

  SELECT r.* INTO v_refund FROM public.order_refunds r WHERE r.id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'REFUND_NOT_FOUND'; END IF;
  IF v_refund.status NOT IN ('pending_execution', 'awaiting_return', 'failed') THEN
    RAISE EXCEPTION 'REFUND_NOT_CONFIGURABLE';
  END IF;

  UPDATE public.order_refunds r
  SET return_required = COALESCE(p_return_required, false),
      return_status = CASE WHEN COALESCE(p_return_required, false) THEN 'awaiting_return' ELSE 'not_required' END,
      return_instructions = NULLIF(trim(COALESCE(p_return_instructions, '')), ''),
      status = CASE WHEN COALESCE(p_return_required, false) THEN 'awaiting_return' ELSE 'pending_execution' END,
      updated_at = v_now
  WHERE r.id = v_refund.id
  RETURNING * INTO v_refund;

  RETURN v_refund;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_configure_refund_return_atomic(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_configure_refund_return_atomic(uuid, boolean, text) TO authenticated;

-- 5.2 Buyer reports item returned (cannot bypass seller/admin confirmation!)
CREATE OR REPLACE FUNCTION public.buyer_report_return_atomic(p_refund_id uuid)
RETURNS public.order_refunds
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_refund public.order_refunds;
  v_order public.orders;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;

  SELECT r.* INTO v_refund FROM public.order_refunds r WHERE r.id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'REFUND_NOT_FOUND'; END IF;

  SELECT o.* INTO v_order FROM public.orders o WHERE o.id = v_refund.order_id;
  IF v_order.buyer_id <> v_uid THEN
    RAISE EXCEPTION 'FORBIDDEN_BUYER_ONLY' USING ERRCODE = '42501';
  END IF;

  IF NOT v_refund.return_required OR v_refund.return_status <> 'awaiting_return' THEN
    RAISE EXCEPTION 'RETURN_NOT_AWAITING_BUYER';
  END IF;

  UPDATE public.order_refunds r
  SET return_status = 'buyer_reported_returned',
      return_reported_at = v_now,
      return_reported_by = v_uid,
      updated_at = v_now
  WHERE r.id = v_refund.id
  RETURNING * INTO v_refund;

  RETURN v_refund;
END;
$$;

REVOKE ALL ON FUNCTION public.buyer_report_return_atomic(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buyer_report_return_atomic(uuid) TO authenticated;

-- 5.3 Seller or Admin confirms physical return receipt + item condition
CREATE OR REPLACE FUNCTION public.confirm_return_receipt_atomic(
  p_refund_id uuid,
  p_item_condition text,
  p_is_admin_exception boolean DEFAULT false
)
RETURNS public.order_refunds
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_is_admin boolean := public.is_active_admin();
  v_refund public.order_refunds;
  v_order public.orders;
  v_cond text := lower(trim(COALESCE(p_item_condition, '')));
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;

  IF v_cond NOT IN ('resellable', 'damaged', 'missing') THEN
    RAISE EXCEPTION 'INVALID_ITEM_CONDITION';
  END IF;

  SELECT r.* INTO v_refund FROM public.order_refunds r WHERE r.id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'REFUND_NOT_FOUND'; END IF;

  SELECT o.* INTO v_order FROM public.orders o WHERE o.id = v_refund.order_id;
  IF NOT v_is_admin AND v_order.seller_id <> v_uid THEN
    RAISE EXCEPTION 'FORBIDDEN_SELLER_OR_ADMIN_ONLY' USING ERRCODE = '42501';
  END IF;

  IF NOT v_refund.return_required THEN
    RAISE EXCEPTION 'RETURN_NOT_REQUIRED';
  END IF;

  IF v_refund.return_status = 'return_confirmed' THEN
    RETURN v_refund;
  END IF;

  IF NOT v_is_admin AND v_refund.return_status <> 'buyer_reported_returned' THEN
    RAISE EXCEPTION 'RETURN_NOT_REPORTED_BY_BUYER';
  END IF;

  UPDATE public.order_refunds r
  SET return_status = CASE WHEN p_is_admin_exception AND v_is_admin THEN 'return_exception' ELSE 'return_confirmed' END,
      return_confirmed_at = v_now,
      return_confirmed_by = v_uid,
      item_condition = v_cond,
      status = CASE WHEN r.status = 'awaiting_return' THEN 'pending_execution' ELSE r.status END,
      updated_at = v_now
  WHERE r.id = v_refund.id
  RETURNING * INTO v_refund;

  INSERT INTO public.notifications (user_id, kind, title, body, href, dedupe_key)
  VALUES (
    v_order.buyer_id,
    'return_confirmed',
    'Return confirmed for #' || v_order.order_code,
    'Your returned item was confirmed. Refund is ready for execution.',
    '/orders',
    'return-confirmed-' || v_refund.id::text
  )
  ON CONFLICT DO NOTHING;

  RETURN v_refund;
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_return_receipt_atomic(uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_return_receipt_atomic(uuid, text, boolean) TO authenticated;

-- 5.4 Explicit Admin Restock Approval (immutable restock log prevents duplicates; handles missing listing/variant)
CREATE OR REPLACE FUNCTION public.admin_approve_refund_restock_atomic(
  p_refund_id uuid,
  p_approve boolean
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_refund public.order_refunds;
  v_dispute public.order_disputes;
  v_order public.orders;
  v_item RECORD;
  v_listing public.listings;
  v_variant public.listing_variants;
  v_any_exception boolean := false;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY' USING ERRCODE = '42501';
  END IF;

  SELECT r.* INTO v_refund FROM public.order_refunds r WHERE r.id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'REFUND_NOT_FOUND'; END IF;

  IF v_refund.restock_status IN ('approved_restocked', 'declined', 'inventory_exception') THEN
    RETURN v_refund.restock_status;
  END IF;

  -- Partial refunds never auto-restock
  IF v_refund.refund_type <> 'full_refund' THEN
    RAISE EXCEPTION 'RESTOCK_FULL_REFUND_ONLY';
  END IF;

  IF NOT COALESCE(p_approve, false) THEN
    UPDATE public.order_refunds r
    SET restock_status = 'declined', restock_approved_by = v_uid, updated_at = v_now
    WHERE r.id = v_refund.id;
    RETURN 'declined';
  END IF;

  SELECT d.* INTO v_dispute FROM public.order_disputes d WHERE d.id = v_refund.dispute_id;
  SELECT o.* INTO v_order FROM public.orders o WHERE o.id = v_refund.order_id FOR UPDATE;

  -- If product was handed over, require confirmed return + resellable condition
  IF v_dispute.previous_order_status IN ('handed_over', 'completed') OR v_order.handed_over_at IS NOT NULL THEN
    IF v_refund.return_status <> 'return_confirmed' OR v_refund.item_condition <> 'resellable' THEN
      RAISE EXCEPTION 'RESTOCK_REQUIRES_RESELLABLE_RETURN';
    END IF;
  END IF;

  FOR v_item IN
    SELECT oi.id, oi.listing_id, oi.variant_id, oi.quantity
    FROM public.order_items oi
    WHERE oi.order_id = v_order.id
    ORDER BY oi.listing_id NULLS LAST, oi.variant_id NULLS LAST, oi.id
  LOOP
    -- Skip if already logged (idempotent guard)
    IF EXISTS (
      SELECT 1 FROM public.order_restock_logs l
      WHERE l.refund_id = v_refund.id AND l.order_item_id = v_item.id
    ) THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_listing FROM public.listings WHERE id = v_item.listing_id FOR UPDATE;
    IF NOT FOUND THEN
      v_any_exception := true;
      INSERT INTO public.order_restock_logs (
        refund_id, order_id, order_item_id, listing_id, variant_id,
        quantity_restored, outcome, note, approved_by, created_at
      ) VALUES (
        v_refund.id, v_order.id, v_item.id, v_item.listing_id, v_item.variant_id,
        0, 'inventory_exception', 'Listing no longer exists', v_uid, v_now
      );
      CONTINUE;
    END IF;

    IF v_item.variant_id IS NOT NULL THEN
      SELECT * INTO v_variant
      FROM public.listing_variants
      WHERE id = v_item.variant_id AND listing_id = v_listing.id
      FOR UPDATE;

      IF NOT FOUND THEN
        v_any_exception := true;
        INSERT INTO public.order_restock_logs (
          refund_id, order_id, order_item_id, listing_id, variant_id,
          quantity_restored, outcome, note, approved_by, created_at
        ) VALUES (
          v_refund.id, v_order.id, v_item.id, v_item.listing_id, v_item.variant_id,
          0, 'inventory_exception', 'Variant no longer exists', v_uid, v_now
        );
        CONTINUE;
      END IF;

      UPDATE public.listing_variants
      SET quantity = quantity + v_item.quantity
      WHERE id = v_variant.id;
    END IF;

    UPDATE public.listings
    SET quantity = quantity + v_item.quantity, updated_at = v_now
    WHERE id = v_listing.id;

    INSERT INTO public.order_restock_logs (
      refund_id, order_id, order_item_id, listing_id, variant_id,
      quantity_restored, outcome, note, approved_by, created_at
    ) VALUES (
      v_refund.id, v_order.id, v_item.id, v_item.listing_id, v_item.variant_id,
      v_item.quantity, 'restocked', 'Admin approved restock', v_uid, v_now
    );
  END LOOP;

  UPDATE public.order_refunds r
  SET restock_status = CASE WHEN v_any_exception THEN 'inventory_exception' ELSE 'approved_restocked' END,
      restock_approved_by = v_uid,
      restocked_at = v_now,
      updated_at = v_now
  WHERE r.id = v_refund.id;

  RETURN CASE WHEN v_any_exception THEN 'inventory_exception' ELSE 'approved_restocked' END;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_approve_refund_restock_atomic(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_approve_refund_restock_atomic(uuid, boolean) TO authenticated;

-- 5.5 Atomic Refund Execution Claim (service_role only after server admin verification)
CREATE OR REPLACE FUNCTION public.claim_order_refund_execution_atomic(
  p_refund_id uuid,
  p_admin_id uuid
)
RETURNS TABLE (
  action          text,
  attempt_token   uuid,
  refund_code     text,
  refund_amount   integer,
  refund_type     text,
  order_id        uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_refund public.order_refunds;
  v_order public.orders;
  v_token uuid;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admin_users au WHERE au.user_id = p_admin_id AND au.active = true) THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY' USING ERRCODE = '42501';
  END IF;

  SELECT o.* INTO v_order
  FROM public.order_refunds r
  JOIN public.orders o ON o.id = r.order_id
  WHERE r.id = p_refund_id;

  IF NOT FOUND THEN RAISE EXCEPTION 'REFUND_NOT_FOUND'; END IF;

  PERFORM 1 FROM public.profiles p WHERE p.id = v_order.seller_id FOR UPDATE;
  PERFORM 1 FROM public.orders o WHERE o.id = v_order.id FOR UPDATE;

  SELECT r.* INTO v_refund FROM public.order_refunds r WHERE r.id = p_refund_id FOR UPDATE;

  IF v_refund.status = 'succeeded' THEN
    RETURN QUERY SELECT 'already_succeeded'::text, NULL::uuid, v_refund.refund_code, v_refund.refund_amount_sen, v_refund.refund_type, v_refund.order_id;
    RETURN;
  END IF;

  IF v_refund.status = 'processing' THEN
    RETURN QUERY SELECT 'in_progress'::text, NULL::uuid, v_refund.refund_code, v_refund.refund_amount_sen, v_refund.refund_type, v_refund.order_id;
    RETURN;
  END IF;

  IF v_refund.status = 'reconciliation_required' THEN
    RETURN QUERY SELECT 'reconciliation_required'::text, NULL::uuid, v_refund.refund_code, v_refund.refund_amount_sen, v_refund.refund_type, v_refund.order_id;
    RETURN;
  END IF;

  IF v_refund.return_required AND v_refund.return_status NOT IN ('return_confirmed', 'return_exception') THEN
    RAISE EXCEPTION 'RETURN_CONFIRMATION_REQUIRED';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.order_refunds r2
    WHERE r2.order_id = v_refund.order_id AND r2.status = 'succeeded'
  ) THEN
    RAISE EXCEPTION 'ORDER_ALREADY_REFUNDED';
  END IF;

  v_token := gen_random_uuid();

  UPDATE public.order_refunds r
  SET status = 'processing',
      attempt_token = v_token,
      attempt_count = r.attempt_count + 1,
      initiated_by = p_admin_id,
      processing_started_at = v_now,
      failure_reason = NULL,
      updated_at = v_now
  WHERE r.id = v_refund.id
  RETURNING * INTO v_refund;

  RETURN QUERY SELECT 'claimed'::text, v_token, v_refund.refund_code, v_refund.refund_amount_sen, v_refund.refund_type, v_refund.order_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_order_refund_execution_atomic(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_order_refund_execution_atomic(uuid, uuid) TO service_role;

-- 5.6 Trusted Refund Finalization (service_role only; atomic financial adjustments + order lifecycle)
CREATE OR REPLACE FUNCTION public.finalize_order_refund_atomic(
  p_refund_id uuid,
  p_attempt_token uuid,
  p_outcome text,
  p_refund_ref text DEFAULT NULL,
  p_failure_reason text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_refund public.order_refunds;
  v_dispute public.order_disputes;
  v_order public.orders;
  v_now timestamptz := clock_timestamp();
  v_next_order_status text;
BEGIN
  IF p_outcome NOT IN ('succeeded', 'failed', 'reconciliation_required') THEN
    RAISE EXCEPTION 'INVALID_REFUND_OUTCOME';
  END IF;

  SELECT o.* INTO v_order
  FROM public.order_refunds r
  JOIN public.orders o ON o.id = r.order_id
  WHERE r.id = p_refund_id;

  IF NOT FOUND THEN RAISE EXCEPTION 'REFUND_NOT_FOUND'; END IF;

  PERFORM 1 FROM public.profiles p WHERE p.id = v_order.seller_id FOR UPDATE;
  SELECT o.* INTO v_order FROM public.orders o WHERE o.id = v_order.id FOR UPDATE;
  SELECT r.* INTO v_refund FROM public.order_refunds r WHERE r.id = p_refund_id FOR UPDATE;
  SELECT d.* INTO v_dispute FROM public.order_disputes d WHERE d.id = v_refund.dispute_id FOR UPDATE;

  IF v_refund.status = 'succeeded' THEN
    RETURN 'already_succeeded';
  END IF;

  IF v_refund.status <> 'processing' OR v_refund.attempt_token IS DISTINCT FROM p_attempt_token THEN
    RETURN 'stale_attempt';
  END IF;

  IF p_outcome = 'failed' THEN
    UPDATE public.order_refunds r
    SET status = 'failed',
        attempt_token = NULL,
        failure_reason = COALESCE(NULLIF(trim(p_failure_reason), ''), 'Simulated refund provider failure'),
        updated_at = v_now
    WHERE r.id = v_refund.id;

    UPDATE public.order_disputes d
    SET refund_execution_status = 'failed', updated_at = v_now
    WHERE d.id = v_dispute.id;

    RETURN 'failed';
  END IF;

  IF p_outcome = 'reconciliation_required' THEN
    UPDATE public.order_refunds r
    SET status = 'reconciliation_required',
        attempt_token = NULL,
        reconciliation_reason = COALESCE(NULLIF(trim(p_failure_reason), ''), 'Uncertain refund provider response'),
        updated_at = v_now
    WHERE r.id = v_refund.id;

    RETURN 'reconciliation_required';
  END IF;

  -- SUCCEEDED: require unique refund_ref, insert immutable financial adjustments, update dispute & order
  IF p_refund_ref IS NULL OR length(trim(p_refund_ref)) = 0 THEN
    RAISE EXCEPTION 'MISSING_REFUND_REF';
  END IF;

  UPDATE public.order_refunds r
  SET status = 'succeeded',
      refund_ref = trim(p_refund_ref),
      attempt_token = NULL,
      completed_at = v_now,
      updated_at = v_now
  WHERE r.id = v_refund.id;

  UPDATE public.order_disputes d
  SET refund_execution_status = 'executed',
      refund_ref = trim(p_refund_ref),
      updated_at = v_now
  WHERE d.id = v_dispute.id;

  INSERT INTO public.financial_adjustments (order_id, refund_id, dispute_id, seller_id, kind, amount_sen, note, created_by, created_at)
  VALUES
    (v_order.id, v_refund.id, v_dispute.id, v_order.seller_id, 'refund_product', v_refund.refund_amount_sen, 'Simulated refund ' || trim(p_refund_ref), v_refund.initiated_by, v_now),
    (v_order.id, v_refund.id, v_dispute.id, v_order.seller_id, 'commission_reversal', v_refund.commission_reversal_sen, '2% commission reversal on refunded subtotal', v_refund.initiated_by, v_now),
    (v_order.id, v_refund.id, v_dispute.id, v_order.seller_id, 'seller_earnings_deduction', v_refund.seller_deduction_sen, 'Seller earnings reduction', v_refund.initiated_by, v_now)
  ON CONFLICT (refund_id, kind) DO NOTHING;

  IF v_refund.refund_type = 'full_refund' THEN
    -- Full refund -> status 'refunded', clear pickup_pin
    UPDATE public.orders o
    SET status = 'refunded',
        pickup_pin = NULL,
        updated_at = v_now
    WHERE o.id = v_order.id;
  ELSE
    -- Partial refund -> restore exact previous lifecycle state, preserve completed_at & valid unconsumed PIN
    IF v_dispute.previous_order_status IN ('paid', 'handed_over', 'completed') THEN
      v_next_order_status := v_dispute.previous_order_status;
    ELSIF v_order.completed_at IS NOT NULL THEN
      v_next_order_status := 'completed';
    ELSIF v_order.handed_over_at IS NOT NULL THEN
      v_next_order_status := 'handed_over';
    ELSE
      v_next_order_status := 'paid';
    END IF;

    UPDATE public.orders o
    SET status = v_next_order_status,
        updated_at = v_now
    WHERE o.id = v_order.id;
  END IF;

  INSERT INTO public.notifications (user_id, kind, title, body, href, dedupe_key)
  VALUES (
    v_order.buyer_id,
    'refund_succeeded',
    'Simulated refund completed for #' || v_order.order_code,
    'Ref ' || trim(p_refund_ref) || ' · RM ' || to_char(v_refund.refund_amount_sen / 100.0, 'FM999990.00'),
    '/orders',
    'refund-succeeded-' || v_refund.id::text
  )
  ON CONFLICT DO NOTHING;

  RETURN 'succeeded';
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_order_refund_atomic(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_order_refund_atomic(uuid, uuid, text, text, text) TO service_role;

-- =============================================================================
-- SECTION 6: Phase 6D.3 Seller Bank Account Upsert / Deactivate (service_role)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.upsert_seller_bank_account_secure(
  p_seller_id uuid,
  p_bank_name text,
  p_account_holder_name text,
  p_account_number_encrypted text,
  p_account_number_last4 text,
  p_account_number_masked text
)
RETURNS TABLE (
  seller_id             uuid,
  bank_name             text,
  account_holder_name   text,
  account_number_masked text,
  validation_status     text,
  is_active             boolean,
  updated_at            timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_row public.seller_payout_accounts;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = p_seller_id
      AND lower(COALESCE(p.university_role, '')) = 'student'
      AND lower(COALESCE(p.status, '')) = 'active'
  ) THEN
    RAISE EXCEPTION 'FORBIDDEN_ACTIVE_STUDENT_ONLY' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.seller_payout_accounts (
    seller_id, bank_name, account_holder_name,
    account_number, account_number_encrypted,
    account_number_last4, account_number_masked,
    validation_status, is_active, deactivated_at, created_at, updated_at
  ) VALUES (
    p_seller_id, trim(p_bank_name), trim(p_account_holder_name),
    p_account_number_masked, p_account_number_encrypted,
    p_account_number_last4, p_account_number_masked,
    'validated', true, NULL, v_now, v_now
  )
  ON CONFLICT (seller_id) DO UPDATE
  SET bank_name = EXCLUDED.bank_name,
      account_holder_name = EXCLUDED.account_holder_name,
      account_number = EXCLUDED.account_number_masked,
      account_number_encrypted = EXCLUDED.account_number_encrypted,
      account_number_last4 = EXCLUDED.account_number_last4,
      account_number_masked = EXCLUDED.account_number_masked,
      validation_status = 'validated',
      is_active = true,
      deactivated_at = NULL,
      updated_at = v_now
  RETURNING * INTO v_row;

  RETURN QUERY SELECT
    v_row.seller_id, v_row.bank_name, v_row.account_holder_name,
    v_row.account_number_masked, v_row.validation_status, v_row.is_active, v_row.updated_at;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_seller_bank_account_secure(uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_seller_bank_account_secure(uuid, text, text, text, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.deactivate_seller_bank_account_secure(p_seller_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.payout_requests pr
    WHERE pr.seller_id = p_seller_id AND pr.status IN ('pending', 'processing')
  ) THEN
    RAISE EXCEPTION 'ACTIVE_WITHDRAWAL_IN_PROGRESS';
  END IF;

  UPDATE public.seller_payout_accounts
  SET is_active = false,
      validation_status = 'deactivated',
      deactivated_at = v_now,
      updated_at = v_now
  WHERE seller_id = p_seller_id;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.deactivate_seller_bank_account_secure(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.deactivate_seller_bank_account_secure(uuid) TO service_role;

-- =============================================================================
-- SECTION 7: Phase 6D.4 Atomic Seller Withdrawal Reservation & Finalization
--            (Shared seller-level lock, 72-hour protection boundary, order-level
--             payout_allocations, automatic simulated disbursement, NO manual
--             admin approval!)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.create_seller_withdrawal_atomic(
  p_seller_id uuid,
  p_amount_sen integer,
  p_idempotency_key text
)
RETURNS TABLE (
  action              text,
  withdrawal_id       uuid,
  withdrawal_code     text,
  amount_sen          integer,
  attempt_token       uuid,
  masked_bank_summary text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_key text := trim(COALESCE(p_idempotency_key, ''));
  v_existing public.payout_requests;
  v_bank public.seller_payout_accounts;
  v_now timestamptz;
  v_ord RECORD;
  v_eligible_total integer := 0;
  v_remaining_to_alloc integer;
  v_take integer;
  v_wdr_code text;
  v_token uuid;
  v_wdr public.payout_requests;
  v_masked text;
  v_snapshot jsonb;
BEGIN
  IF length(v_key) < 8 THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY';
  END IF;

  IF p_amount_sen IS NULL OR p_amount_sen < 200 THEN
    RAISE EXCEPTION 'BELOW_MINIMUM_WITHDRAWAL';
  END IF;

  -- Acquire shared seller-level lock FIRST (deadlock-free with disputes & refunds!)
  PERFORM 1 FROM public.profiles p WHERE p.id = p_seller_id FOR UPDATE;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = p_seller_id
      AND lower(COALESCE(p.university_role, '')) = 'student'
      AND lower(COALESCE(p.status, '')) = 'active'
  ) THEN
    RAISE EXCEPTION 'FORBIDDEN_ACTIVE_STUDENT_ONLY' USING ERRCODE = '42501';
  END IF;

  -- Idempotent replay check
  SELECT pr.* INTO v_existing
  FROM public.payout_requests pr
  WHERE pr.idempotency_key = v_key AND pr.seller_id = p_seller_id;

  IF FOUND THEN
    RETURN QUERY SELECT
      'existing'::text, v_existing.id, v_existing.withdrawal_code,
      v_existing.amount_sen, v_existing.attempt_token, v_existing.masked_bank_summary;
    RETURN;
  END IF;

  -- Require active validated payout bank account
  SELECT b.* INTO v_bank
  FROM public.seller_payout_accounts b
  WHERE b.seller_id = p_seller_id
    AND b.is_active = true
    AND b.validation_status = 'validated';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_ACTIVE_BANK_ACCOUNT';
  END IF;

  v_now := clock_timestamp();

  -- Lock all eligible completed orders for this seller (deterministic ORDER BY id)
  -- Eligibility: status='completed', paid_at IS NOT NULL, completed_at + 72h <= v_now,
  --              no active dispute or pending_execution refund!
  FOR v_ord IN
    SELECT
      o.id,
      GREATEST(0, o.seller_net_sen - COALESCE((
        SELECT SUM(fa.amount_sen) FROM public.financial_adjustments fa
        WHERE fa.order_id = o.id AND fa.kind = 'seller_earnings_deduction'
      ), 0))::integer AS adjusted_net_sen,
      COALESCE((
        SELECT SUM(pa.allocated_sen) FROM public.payout_allocations pa
        WHERE pa.order_id = o.id AND pa.status IN ('reserved', 'paid')
      ), 0)::integer AS already_allocated_sen
    FROM public.orders o
    WHERE o.seller_id = p_seller_id
      AND o.status = 'completed'
      AND o.paid_at IS NOT NULL
      AND o.completed_at IS NOT NULL
      AND v_now >= (o.completed_at + interval '72 hours')
      AND NOT EXISTS (
        SELECT 1 FROM public.order_disputes d
        WHERE d.order_id = o.id
          AND (
            lower(COALESCE(d.status, '')) IN ('open', 'under_review')
            OR d.refund_execution_status = 'pending_execution'
          )
      )
    ORDER BY o.completed_at ASC, o.id ASC
    FOR UPDATE OF o
  LOOP
    v_eligible_total := v_eligible_total + GREATEST(0, v_ord.adjusted_net_sen - v_ord.already_allocated_sen);
  END LOOP;

  IF p_amount_sen > v_eligible_total THEN
    RAISE EXCEPTION 'INSUFFICIENT_AVAILABLE_BALANCE';
  END IF;

  v_masked := v_bank.bank_name || ' · ' || COALESCE(v_bank.account_number_masked, '****') || ' (' || v_bank.account_holder_name || ')';
  v_snapshot := jsonb_build_object(
    'bank_name', v_bank.bank_name,
    'account_holder_name', v_bank.account_holder_name,
    'account_number_last4', v_bank.account_number_last4,
    'account_number_masked', v_bank.account_number_masked,
    'account_number_encrypted', v_bank.account_number_encrypted,
    'captured_at', v_now
  );

  v_wdr_code := 'WDR-'
    || to_char(v_now AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYMM')
    || '-'
    || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
  v_token := gen_random_uuid();

  INSERT INTO public.payout_requests (
    withdrawal_code, seller_id, amount_sen, bank_snapshot, masked_bank_summary,
    status, provider, simulation_mode, idempotency_key, attempt_token,
    attempt_count, processing_started_at, created_at, updated_at
  ) VALUES (
    v_wdr_code, p_seller_id, p_amount_sen, v_snapshot, v_masked,
    'processing', 'simulated_bank', true, v_key, v_token,
    1, v_now, v_now, v_now
  )
  RETURNING * INTO v_wdr;

  -- Allocate exact sen FIFO across matured eligible completed orders
  v_remaining_to_alloc := p_amount_sen;
  FOR v_ord IN
    SELECT
      o.id,
      GREATEST(0, o.seller_net_sen - COALESCE((
        SELECT SUM(fa.amount_sen) FROM public.financial_adjustments fa
        WHERE fa.order_id = o.id AND fa.kind = 'seller_earnings_deduction'
      ), 0))::integer AS adjusted_net_sen,
      COALESCE((
        SELECT SUM(pa.allocated_sen) FROM public.payout_allocations pa
        WHERE pa.order_id = o.id AND pa.status IN ('reserved', 'paid')
      ), 0)::integer AS already_allocated_sen
    FROM public.orders o
    WHERE o.seller_id = p_seller_id
      AND o.status = 'completed'
      AND o.paid_at IS NOT NULL
      AND o.completed_at IS NOT NULL
      AND v_now >= (o.completed_at + interval '72 hours')
      AND NOT EXISTS (
        SELECT 1 FROM public.order_disputes d
        WHERE d.order_id = o.id
          AND (
            lower(COALESCE(d.status, '')) IN ('open', 'under_review')
            OR d.refund_execution_status = 'pending_execution'
          )
      )
    ORDER BY o.completed_at ASC, o.id ASC
  LOOP
    EXIT WHEN v_remaining_to_alloc <= 0;
    v_take := LEAST(v_remaining_to_alloc, GREATEST(0, v_ord.adjusted_net_sen - v_ord.already_allocated_sen));
    IF v_take > 0 THEN
      INSERT INTO public.payout_allocations (
        payout_request_id, order_id, seller_id, allocated_sen, status, created_at, updated_at
      ) VALUES (
        v_wdr.id, v_ord.id, p_seller_id, v_take, 'reserved', v_now, v_now
      );
      v_remaining_to_alloc := v_remaining_to_alloc - v_take;
    END IF;
  END LOOP;

  IF v_remaining_to_alloc <> 0 THEN
    RAISE EXCEPTION 'ALLOCATION_INVARIANT_FAILED';
  END IF;

  RETURN QUERY SELECT
    'created'::text, v_wdr.id, v_wdr.withdrawal_code,
    v_wdr.amount_sen, v_token, v_masked;
END;
$$;

REVOKE ALL ON FUNCTION public.create_seller_withdrawal_atomic(uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_seller_withdrawal_atomic(uuid, integer, text) TO service_role;

-- Trusted Withdrawal Finalization (service_role only; immutable once paid; exact-once release on definitive failure)
CREATE OR REPLACE FUNCTION public.finalize_seller_withdrawal_atomic(
  p_withdrawal_id uuid,
  p_attempt_token uuid,
  p_outcome text,
  p_transfer_ref text DEFAULT NULL,
  p_failure_reason text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_wdr public.payout_requests;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_outcome NOT IN ('paid', 'failed', 'reconciliation_required') THEN
    RAISE EXCEPTION 'INVALID_WITHDRAWAL_OUTCOME';
  END IF;

  SELECT pr.* INTO v_wdr FROM public.payout_requests pr WHERE pr.id = p_withdrawal_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'WITHDRAWAL_NOT_FOUND'; END IF;

  PERFORM 1 FROM public.profiles p WHERE p.id = v_wdr.seller_id FOR UPDATE;
  SELECT pr.* INTO v_wdr FROM public.payout_requests pr WHERE pr.id = p_withdrawal_id FOR UPDATE;

  -- Successful withdrawal is strictly immutable
  IF v_wdr.status = 'paid' THEN
    RETURN 'already_paid';
  END IF;

  IF v_wdr.status <> 'processing' OR v_wdr.attempt_token IS DISTINCT FROM p_attempt_token THEN
    RETURN 'stale_attempt';
  END IF;

  IF p_outcome = 'failed' THEN
    UPDATE public.payout_requests pr
    SET status = 'failed',
        attempt_token = NULL,
        failure_reason = COALESCE(NULLIF(trim(p_failure_reason), ''), 'Simulated bank transfer failed'),
        updated_at = v_now
    WHERE pr.id = v_wdr.id;

    -- Release reserved order allocations exactly once
    UPDATE public.payout_allocations pa
    SET status = 'released', updated_at = v_now
    WHERE pa.payout_request_id = v_wdr.id AND pa.status = 'reserved';

    INSERT INTO public.notifications (user_id, kind, title, body, href, dedupe_key)
    VALUES (
      v_wdr.seller_id,
      'withdrawal_failed',
      'Withdrawal ' || v_wdr.withdrawal_code || ' failed',
      'Reserved balance RM ' || to_char(v_wdr.amount_sen / 100.0, 'FM999990.00') || ' has been restored.',
      '/seller/withdrawals',
      'wdr-failed-' || v_wdr.id::text
    )
    ON CONFLICT DO NOTHING;

    RETURN 'failed';
  END IF;

  IF p_outcome = 'reconciliation_required' THEN
    -- Keep funds reserved! Never blindly release or retry uncertain transfers
    UPDATE public.payout_requests pr
    SET status = 'reconciliation_required',
        attempt_token = NULL,
        reconciliation_reason = COALESCE(NULLIF(trim(p_failure_reason), ''), 'Uncertain transfer outcome'),
        updated_at = v_now
    WHERE pr.id = v_wdr.id;

    RETURN 'reconciliation_required';
  END IF;

  IF p_transfer_ref IS NULL OR length(trim(p_transfer_ref)) = 0 THEN
    RAISE EXCEPTION 'MISSING_TRANSFER_REF';
  END IF;

  UPDATE public.payout_requests pr
  SET status = 'paid',
      transfer_ref = trim(p_transfer_ref),
      attempt_token = NULL,
      processed_at = v_now,
      completed_at = v_now,
      updated_at = v_now
  WHERE pr.id = v_wdr.id;

  UPDATE public.payout_allocations pa
  SET status = 'paid', updated_at = v_now
  WHERE pa.payout_request_id = v_wdr.id AND pa.status = 'reserved';

  INSERT INTO public.notifications (user_id, kind, title, body, href, dedupe_key)
  VALUES (
    v_wdr.seller_id,
    'withdrawal_succeeded',
    'Simulated withdrawal ' || v_wdr.withdrawal_code || ' completed',
    'Ref ' || trim(p_transfer_ref) || ' · RM ' || to_char(v_wdr.amount_sen / 100.0, 'FM999990.00'),
    '/seller/withdrawals',
    'wdr-paid-' || v_wdr.id::text
  )
  ON CONFLICT DO NOTHING;

  RETURN 'paid';
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_seller_withdrawal_atomic(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_seller_withdrawal_atomic(uuid, uuid, text, text, text) TO service_role;

-- Admin-only safe exception recovery for `reconciliation_required` or stale `processing` withdrawals
-- (NO arbitrary Mark Paid button! Only allows safe `release_failed` back to seller balance when confirmed not transferred)
CREATE OR REPLACE FUNCTION public.admin_release_failed_withdrawal_atomic(
  p_withdrawal_id uuid,
  p_admin_notes text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_wdr public.payout_requests;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY' USING ERRCODE = '42501';
  END IF;

  SELECT pr.* INTO v_wdr FROM public.payout_requests pr WHERE pr.id = p_withdrawal_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'WITHDRAWAL_NOT_FOUND'; END IF;

  PERFORM 1 FROM public.profiles p WHERE p.id = v_wdr.seller_id FOR UPDATE;
  SELECT pr.* INTO v_wdr FROM public.payout_requests pr WHERE pr.id = p_withdrawal_id FOR UPDATE;

  IF v_wdr.status = 'paid' THEN
    RAISE EXCEPTION 'WITHDRAWAL_ALREADY_PAID';
  END IF;

  IF v_wdr.status NOT IN ('reconciliation_required', 'processing') THEN
    RAISE EXCEPTION 'WITHDRAWAL_NOT_RECOVERABLE';
  END IF;

  UPDATE public.payout_requests pr
  SET status = 'failed',
      attempt_token = NULL,
      processed_by = v_uid,
      admin_notes = NULLIF(trim(COALESCE(p_admin_notes, '')), ''),
      failure_reason = 'Admin exception recovery: confirmed not disbursed; reserved funds released',
      updated_at = v_now
  WHERE pr.id = v_wdr.id;

  UPDATE public.payout_allocations pa
  SET status = 'released', updated_at = v_now
  WHERE pa.payout_request_id = v_wdr.id AND pa.status = 'reserved';

  RETURN 'released_to_failed';
END;
$$;

REVOKE ALL ON FUNCTION public.admin_release_failed_withdrawal_atomic(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_release_failed_withdrawal_atomic(uuid, text) TO authenticated;

COMMIT;

-- =============================================================================
-- INSTALLATION & RECOVERY NOTES:
--   1. Run this single file in Supabase SQL Editor on `duwwlcpdidrxkixvflag`.
--   2. Zero historical data is deleted; preserved pending disputes
--      (DSP-2611-218ADE, DSP-2611-21DDF7) are automatically seeded into
--      `public.order_refunds` with `status = 'pending_execution'`.
--   3. Rollback must NEVER delete succeeded `order_refunds`,
--      `financial_adjustments`, `order_restock_logs`, or paid `payout_requests`.
-- =============================================================================
