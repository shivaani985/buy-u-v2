-- =============================================================================
-- Buy-U Phase 6D — Complete Financial Ecosystem Consolidated Migration (Hardened)
-- STATUS: PROPOSAL ONLY — DO NOT APPLY WITHOUT EXPLICIT OWNER APPROVAL
-- TARGET PROJECT: duwwlcpdidrxkixvflag
--
-- Covers in ONE atomic, dependency-ordered migration:
--   Section 1: Safe Notifications, Durable Attempt History & Order Refund/Restock Tables
--   Section 2: Legacy Bank Account Security & Encrypted Storage (Phase 6D.3)
--   Section 3: Payout Requests, Order-Level Allocations & Authoritative Payment Proof
--   Section 4: Historical 7d -> New 72h Protection Transition & Single Dispute Resolution RPC
--   Section 5: Return, Separated Restock, Durable Refund Execution & Safe Recovery RPCs
--   Section 6: Bank Account Upsert / Deactivate (Explicit PK + Shared Seller Lock)
--   Section 7: Automated Seller Withdrawals & Evidence-Based Exception Recovery
--
-- Shared Lock Order (deadlock-free across ALL Phase 6B/6C/6D RPCs):
--   profiles (seller_id FOR UPDATE) -> orders (ORDER BY id FOR UPDATE)
--   -> order_disputes -> order_refunds -> payout_requests -> payout_allocations
--   -> listings (ORDER BY id FOR UPDATE) -> listing_variants (ORDER BY id FOR UPDATE)
--
-- Historical Transition Policy (P0.7):
--   - `orders.protection_expires_at` is the SINGLE authoritative deadline.
--   - Existing completed orders before Phase 6D activation keep their promised
--     7-day deadline (`completed_at + interval '7 days'`).
--   - All new completions after Phase 6D activation receive exactly 72 hours
--     (`completed_at + interval '72 hours'`).
--   - Completion timestamps are NEVER reset; existing disputes remain frozen
--     indefinitely until resolved.
--   - Exact boundary: dispute strictly `< protection_expires_at`,
--     withdrawal `>= protection_expires_at`.
--
-- Legacy Bank Account Migration Policy (P0.2):
--   - Existing plaintext `seller_payout_accounts` rows without `v1:` ciphertext
--     are safely deactivated (`is_active = false`, `validation_status = 're_registration_required'`),
--     their masked display (`****1234`) is preserved, plaintext `account_number` is
--     overwritten with the masked placeholder (satisfying NOT NULL), and `duitnow_id`
--     is cleared. Sellers must re-register via encrypted Phase 6D.3 flow before withdrawing.
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION 1: Safe Notifications, Durable Execution Attempts & Refund/Restock Tables
-- =============================================================================
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS dedupe_key text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_user_dedupe_key
  ON public.notifications (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- Notification helper that NEVER aborts a valid financial transaction (P0.9)
CREATE OR REPLACE FUNCTION public.safe_insert_notification(
  p_user_id uuid,
  p_kind text,
  p_title text,
  p_body text,
  p_href text,
  p_dedupe_key text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO public.notifications (user_id, kind, title, body, href, dedupe_key)
  VALUES (p_user_id, p_kind, p_title, p_body, p_href, p_dedupe_key)
  ON CONFLICT DO NOTHING;
EXCEPTION WHEN OTHERS THEN
  -- Never fail an authoritative financial state transition due to notification issues
  NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.safe_insert_notification(uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;

-- Durable provider execution attempt history (P0.4 / P0.5)
CREATE TABLE IF NOT EXISTS public.financial_execution_attempts (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type                   text NOT NULL CHECK (entity_type IN ('refund', 'withdrawal')),
  entity_id                     uuid NOT NULL,
  logical_tx_id                 text NOT NULL,
  attempt_token                 uuid NOT NULL UNIQUE,
  attempt_number                integer NOT NULL CHECK (attempt_number > 0),
  provider                      text NOT NULL,
  simulation_mode               boolean NOT NULL DEFAULT true,
  status                        text NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'provider_succeeded', 'provider_failed', 'provider_uncertain', 'finalized')),
  provider_outcome              text
    CHECK (provider_outcome IS NULL OR provider_outcome IN ('succeeded', 'paid', 'failed', 'reconciliation_required')),
  simulation_ref                text,
  failure_or_uncertainty_reason text,
  started_at                    timestamptz NOT NULL DEFAULT now(),
  provider_recorded_at          timestamptz,
  finalized_at                  timestamptz,
  UNIQUE (entity_type, entity_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_fin_exec_attempts_entity
  ON public.financial_execution_attempts (entity_type, entity_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_fin_exec_attempts_logical_tx
  ON public.financial_execution_attempts (logical_tx_id);

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
  return_exception_reason text,
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
      'approved_pending_refund',
      'approved_restocked',
      'declined',
      'inventory_exception'
    )),
  restock_plan            jsonb,
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

-- Enforce at most ONE succeeded refund per order
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
-- SECTION 2: Seller Bank Accounts Hardening & Safe Legacy Migration (P0.2)
-- =============================================================================
ALTER TABLE public.seller_payout_accounts
  ADD COLUMN IF NOT EXISTS account_number_encrypted text,
  ADD COLUMN IF NOT EXISTS account_number_last4 text,
  ADD COLUMN IF NOT EXISTS account_number_masked text,
  ADD COLUMN IF NOT EXISTS validation_status text NOT NULL DEFAULT 're_registration_required',
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;

-- Safely migrate legacy plaintext rows:
--   1. Preserve last4 + masked display (`****1234`) for historical context.
--   2. Overwrite plaintext `account_number` with safe masked placeholder (keeps NOT NULL intact).
--   3. Clear legacy `duitnow_id` so no sensitive identifier leaks through old columns.
--   4. Mark `is_active = false`, `validation_status = 're_registration_required'` until re-registered.
UPDATE public.seller_payout_accounts
SET account_number_last4 = COALESCE(
      NULLIF(account_number_last4, ''),
      right(regexp_replace(COALESCE(account_number, ''), '\D', '', 'g'), 4)
    ),
    account_number_masked = COALESCE(
      NULLIF(account_number_masked, ''),
      '****' || right(regexp_replace(COALESCE(account_number, ''), '\D', '', 'g'), 4)
    ),
    account_number = COALESCE(
      NULLIF(account_number_masked, ''),
      '****' || right(regexp_replace(COALESCE(account_number, ''), '\D', '', 'g'), 4)
    ),
    duitnow_id = NULL,
    validation_status = 're_registration_required',
    is_active = false,
    deactivated_at = COALESCE(deactivated_at, now()),
    updated_at = now()
WHERE account_number_encrypted IS NULL
   OR account_number_encrypted NOT LIKE 'v1:%';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'seller_payout_accounts_validation_status_check'
      AND conrelid = 'public.seller_payout_accounts'::regclass
  ) THEN
    ALTER TABLE public.seller_payout_accounts
      DROP CONSTRAINT seller_payout_accounts_validation_status_check;
  END IF;

  ALTER TABLE public.seller_payout_accounts
    ADD CONSTRAINT seller_payout_accounts_validation_status_check
    CHECK (validation_status IN ('validated', 'deactivated', 're_registration_required'));

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'seller_payout_accounts_active_encrypted_check'
      AND conrelid = 'public.seller_payout_accounts'::regclass
  ) THEN
    ALTER TABLE public.seller_payout_accounts
      ADD CONSTRAINT seller_payout_accounts_active_encrypted_check
      CHECK (
        NOT is_active
        OR (
          validation_status = 'validated'
          AND account_number_encrypted IS NOT NULL
          AND account_number_encrypted LIKE 'v1:%'
        )
      );
  END IF;
END;
$$;

-- Lock down direct client access: NEVER allow authenticated/anon to read raw account_number, ciphertext, or duitnow_id
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
-- SECTION 3: Payout Requests, Order Allocations & Authoritative Payment Proof (P0.6)
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

-- Shared authoritative payment verification helper (P0.6)
CREATE OR REPLACE FUNCTION public.is_order_payment_verified(p_order_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.orders o
    WHERE o.id = p_order_id
      AND o.paid_at IS NOT NULL
      AND (
        (
          o.checkout_session_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM public.checkout_sessions cs
            WHERE cs.id = o.checkout_session_id
              AND cs.buyer_id = o.buyer_id
              AND cs.status = 'paid'
              AND cs.payment_status = 'paid'
              AND cs.paid_at IS NOT NULL
          )
        )
        OR (
          o.checkout_session_id IS NULL
          AND EXISTS (
            SELECT 1 FROM public.payments p
            WHERE p.order_id = o.id
              AND p.status = 'paid'
              AND p.verified_at IS NOT NULL
          )
        )
      )
  );
$$;

REVOKE ALL ON FUNCTION public.is_order_payment_verified(uuid) FROM PUBLIC, anon, authenticated;

-- Column-level privacy & write lockdown on all financial tables
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
REVOKE ALL ON public.financial_execution_attempts FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public.order_refunds TO service_role;
GRANT ALL ON TABLE public.order_restock_logs TO service_role;
GRANT ALL ON TABLE public.financial_adjustments TO service_role;
GRANT ALL ON TABLE public.payout_allocations TO service_role;
GRANT ALL ON TABLE public.financial_execution_attempts TO service_role;

ALTER TABLE public.order_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_restock_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payout_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_execution_attempts ENABLE ROW LEVEL SECURITY;

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
    'payout_allocations',
    'financial_execution_attempts'
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
-- SECTION 4: Historical 7-Day -> New 72-Hour Protection Transition (P0.7)
--            & Single Authoritative Dispute Resolution RPC (P0.1)
-- =============================================================================
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS protection_expires_at timestamptz;

-- P0.11: Grant explicit column-level SELECT on protection_expires_at (preserves RLS & pickup_pin lockdown)
GRANT SELECT (protection_expires_at) ON public.orders TO authenticated;

-- Preserve already-promised 7-day deadline for orders completed BEFORE Phase 6D activation
UPDATE public.orders
SET protection_expires_at = completed_at + interval '7 days'
WHERE completed_at IS NOT NULL
  AND protection_expires_at IS NULL;

-- Automatically stamp 72-hour protection deadline on ALL new completions (never resets completed_at!)
CREATE OR REPLACE FUNCTION public.set_order_protection_deadline_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.completed_at IS NOT NULL AND NEW.protection_expires_at IS NULL THEN
    NEW.protection_expires_at := NEW.completed_at + interval '72 hours';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_orders_set_protection_deadline ON public.orders;
CREATE TRIGGER trg_orders_set_protection_deadline
  BEFORE INSERT OR UPDATE OF completed_at ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.set_order_protection_deadline_trigger();

-- Open dispute RPC using single authoritative protection_expires_at + authoritative payment proof
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
  v_deadline timestamptz;
  v_clean_code text := lower(trim(COALESCE(p_reason_code, '')));
  v_clean_desc text := trim(COALESCE(p_description, ''));
  v_paths text[] := COALESCE(p_evidence_paths, '{}'::text[]);
  v_path text;
  v_reason_label text;
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

  SELECT o.seller_id INTO v_seller_id FROM public.orders o WHERE o.id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;

  PERFORM 1 FROM public.profiles p WHERE p.id = v_seller_id FOR UPDATE;
  SELECT o.* INTO v_order FROM public.orders o WHERE o.id = p_order_id FOR UPDATE;

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
  ) OR EXISTS (
    SELECT 1 FROM public.order_refunds r
    WHERE r.order_id = v_order.id
      AND r.status IN ('pending_execution', 'awaiting_return', 'processing', 'succeeded', 'failed', 'reconciliation_required')
  ) THEN
    RAISE EXCEPTION 'DISPUTE_ALREADY_ACTIVE';
  END IF;

  IF NOT public.is_order_payment_verified(v_order.id) THEN
    RAISE EXCEPTION 'PAYMENT_UNVERIFIED';
  END IF;

  IF v_order.status = 'completed' THEN
    v_deadline := COALESCE(v_order.protection_expires_at, v_order.completed_at + interval '72 hours');
    IF v_order.completed_at IS NULL OR v_deadline IS NULL OR v_now >= v_deadline THEN
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

  PERFORM public.safe_insert_notification(
    v_order.seller_id,
    'dispute_opened',
    'Dispute opened on #' || v_order.order_code,
    v_dispute_code || ': ' || v_reason_label,
    '/seller/disputes',
    'dispute-opened-' || v_dispute.id::text
  );

  RETURN QUERY SELECT
    v_dispute.id, v_dispute.dispute_code, v_dispute.order_id,
    v_dispute.status, v_dispute.previous_order_status, v_dispute.created_at;
END;
$$;

-- P0.1: REMOVE legacy 4-parameter overload so PostgREST has ONE unambiguous resolution RPC!
DROP FUNCTION IF EXISTS public.admin_resolve_order_dispute_atomic(uuid, text, integer, text);

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

  SELECT d.order_id INTO v_order_id FROM public.order_disputes d WHERE d.id = p_dispute_id;
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

    PERFORM public.safe_insert_notification(
      v_order.buyer_id,
      CASE WHEN v_return_req THEN 'return_required' ELSE 'refund_approved' END,
      CASE WHEN v_return_req
        THEN 'Return required for #' || v_order.order_code
        ELSE 'Refund approved for #' || v_order.order_code END,
      'Approved simulated refund: RM ' || to_char(v_refund_sen / 100.0, 'FM999990.00'),
      '/orders',
      'refund-approved-' || v_dispute.id::text
    );
  END IF;

  RETURN QUERY SELECT
    v_dispute.id, v_dispute.dispute_code, v_dispute.status, v_dispute.resolution_type,
    v_dispute.refund_amount_sen, v_dispute.refund_execution_status,
    v_next_order_status, v_dispute.resolved_at;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_resolve_order_dispute_atomic(uuid, text, integer, text, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_resolve_order_dispute_atomic(uuid, text, integer, text, boolean, text) TO authenticated;

-- Backfill `public.order_refunds` for preserved Phase 6D.1 pending_execution disputes
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
-- SECTION 5: Return, Separated Restock, Durable Refund Execution & Recovery (P0.4/P0.5/P0.8/P0.9)
-- =============================================================================

-- 5.1 Admin configures return requirement (participant-safe return type, shared lock order)
DROP FUNCTION IF EXISTS public.admin_configure_refund_return_atomic(uuid, boolean, text);
CREATE OR REPLACE FUNCTION public.admin_configure_refund_return_atomic(
  p_refund_id uuid,
  p_return_required boolean,
  p_return_instructions text DEFAULT NULL
)
RETURNS TABLE (
  refund_id           uuid,
  refund_code         text,
  status              text,
  return_required     boolean,
  return_status       text,
  return_instructions text,
  updated_at          timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_order public.orders;
  v_refund public.order_refunds;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_admin() THEN
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

  IF v_refund.status NOT IN ('pending_execution', 'awaiting_return', 'failed') THEN
    RAISE EXCEPTION 'REFUND_NOT_CONFIGURABLE';
  END IF;

  UPDATE public.order_refunds r
  SET return_required = COALESCE(p_return_required, false),
      return_status = CASE WHEN COALESCE(p_return_required, false) THEN 'awaiting_return' ELSE 'not_required' END,
      return_instructions = NULLIF(trim(COALESCE(p_return_instructions, '')), ''),
      status = CASE WHEN COALESCE(p_return_required, false) THEN 'awaiting_return' ELSE 'pending_execution' END,
      -- P0.13: Changing return requirements invalidates any pre-approved pending restock plan
      restock_status = CASE WHEN r.restock_status = 'approved_pending_refund' THEN 'pending_decision' ELSE r.restock_status END,
      restock_plan = CASE WHEN r.restock_status = 'approved_pending_refund' THEN NULL ELSE r.restock_plan END,
      updated_at = v_now
  WHERE r.id = v_refund.id
  RETURNING * INTO v_refund;

  RETURN QUERY SELECT
    v_refund.id, v_refund.refund_code, v_refund.status,
    v_refund.return_required, v_refund.return_status,
    v_refund.return_instructions, v_refund.updated_at;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_configure_refund_return_atomic(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_configure_refund_return_atomic(uuid, boolean, text) TO authenticated;

-- 5.2 Buyer reports item returned (participant-safe return type, shared lock order)
DROP FUNCTION IF EXISTS public.buyer_report_return_atomic(uuid);
CREATE OR REPLACE FUNCTION public.buyer_report_return_atomic(p_refund_id uuid)
RETURNS TABLE (
  refund_id          uuid,
  refund_code        text,
  status             text,
  return_status      text,
  return_reported_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_order public.orders;
  v_refund public.order_refunds;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;

  SELECT o.* INTO v_order
  FROM public.order_refunds r
  JOIN public.orders o ON o.id = r.order_id
  WHERE r.id = p_refund_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'REFUND_NOT_FOUND'; END IF;

  PERFORM 1 FROM public.profiles p WHERE p.id = v_order.seller_id FOR UPDATE;
  SELECT o.* INTO v_order FROM public.orders o WHERE o.id = v_order.id FOR UPDATE;
  SELECT r.* INTO v_refund FROM public.order_refunds r WHERE r.id = p_refund_id FOR UPDATE;

  IF v_order.buyer_id <> v_uid THEN
    RAISE EXCEPTION 'FORBIDDEN_BUYER_ONLY' USING ERRCODE = '42501';
  END IF;

  IF v_refund.status = 'succeeded' THEN
    RAISE EXCEPTION 'REFUND_ALREADY_COMPLETED';
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

  RETURN QUERY SELECT
    v_refund.id, v_refund.refund_code, v_refund.status,
    v_refund.return_status, v_refund.return_reported_at;
END;
$$;

REVOKE ALL ON FUNCTION public.buyer_report_return_atomic(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buyer_report_return_atomic(uuid) TO authenticated;

-- 5.3 Seller or Admin confirms return receipt (P0.8: active seller/admin, missing != confirmed, justification required for exceptions, immutable after refund succeeded)
DROP FUNCTION IF EXISTS public.confirm_return_receipt_atomic(uuid, text, boolean);
DROP FUNCTION IF EXISTS public.confirm_return_receipt_atomic(uuid, text, boolean, text);
CREATE OR REPLACE FUNCTION public.confirm_return_receipt_atomic(
  p_refund_id uuid,
  p_item_condition text,
  p_is_admin_exception boolean DEFAULT false,
  p_exception_reason text DEFAULT NULL
)
RETURNS TABLE (
  refund_id           uuid,
  refund_code         text,
  status              text,
  return_status       text,
  item_condition      text,
  return_confirmed_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_is_admin boolean := public.is_active_admin();
  v_is_member boolean := public.is_active_member();
  v_order public.orders;
  v_refund public.order_refunds;
  v_cond text := lower(trim(COALESCE(p_item_condition, '')));
  v_exc_reason text := NULLIF(trim(COALESCE(p_exception_reason, '')), '');
  v_next_return_status text;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_uid IS NULL OR (NOT v_is_admin AND NOT v_is_member) THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;

  IF v_cond NOT IN ('resellable', 'damaged', 'missing') THEN
    RAISE EXCEPTION 'INVALID_ITEM_CONDITION';
  END IF;

  SELECT o.* INTO v_order
  FROM public.order_refunds r
  JOIN public.orders o ON o.id = r.order_id
  WHERE r.id = p_refund_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'REFUND_NOT_FOUND'; END IF;

  PERFORM 1 FROM public.profiles p WHERE p.id = v_order.seller_id FOR UPDATE;
  SELECT o.* INTO v_order FROM public.orders o WHERE o.id = v_order.id FOR UPDATE;
  SELECT r.* INTO v_refund FROM public.order_refunds r WHERE r.id = p_refund_id FOR UPDATE;

  IF NOT v_is_admin AND NOT (v_is_member AND v_order.seller_id = v_uid) THEN
    RAISE EXCEPTION 'FORBIDDEN_SELLER_OR_ADMIN_ONLY' USING ERRCODE = '42501';
  END IF;

  IF v_refund.status = 'succeeded' THEN
    RAISE EXCEPTION 'REFUND_ALREADY_COMPLETED';
  END IF;

  IF NOT v_refund.return_required THEN
    RAISE EXCEPTION 'RETURN_NOT_REQUIRED';
  END IF;

  IF v_refund.return_status IN ('return_confirmed', 'return_exception') THEN
    RAISE EXCEPTION 'RETURN_ALREADY_RECORDED';
  END IF;

  -- Missing items are NEVER classified as successfully returned; require admin exception + justification
  IF v_cond = 'missing' THEN
    IF NOT v_is_admin OR NOT COALESCE(p_is_admin_exception, false) THEN
      RAISE EXCEPTION 'MISSING_ITEM_REQUIRES_ADMIN_EXCEPTION';
    END IF;
  END IF;

  IF COALESCE(p_is_admin_exception, false) THEN
    IF NOT v_is_admin THEN
      RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY' USING ERRCODE = '42501';
    END IF;
    IF v_exc_reason IS NULL OR length(v_exc_reason) < 10 THEN
      RAISE EXCEPTION 'ADMIN_EXCEPTION_REASON_REQUIRED';
    END IF;
    v_next_return_status := 'return_exception';
  ELSE
    IF NOT v_is_admin AND v_refund.return_status <> 'buyer_reported_returned' THEN
      RAISE EXCEPTION 'RETURN_NOT_REPORTED_BY_BUYER';
    END IF;
    v_next_return_status := 'return_confirmed';
  END IF;

  UPDATE public.order_refunds r
  SET return_status = v_next_return_status,
      return_exception_reason = COALESCE(v_exc_reason, r.return_exception_reason),
      return_confirmed_at = v_now,
      return_confirmed_by = v_uid,
      item_condition = v_cond,
      status = CASE WHEN r.status = 'awaiting_return' THEN 'pending_execution' ELSE r.status END,
      updated_at = v_now
  WHERE r.id = v_refund.id
  RETURNING * INTO v_refund;

  PERFORM public.safe_insert_notification(
    v_order.buyer_id,
    'return_confirmed',
    'Return status updated for #' || v_order.order_code,
    CASE WHEN v_next_return_status = 'return_exception'
      THEN 'Admin recorded a return exception. Refund is ready for review.'
      ELSE 'Your returned item was confirmed. Refund is ready for execution.' END,
    '/orders',
    'return-confirmed-' || v_refund.id::text
  );

  RETURN QUERY SELECT
    v_refund.id, v_refund.refund_code, v_refund.status,
    v_refund.return_status, v_refund.item_condition, v_refund.return_confirmed_at;
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_return_receipt_atomic(uuid, text, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_return_receipt_atomic(uuid, text, boolean, text) TO authenticated;

-- 5.4 Internal guarded post-success restock executor (P0.13: two-phase deterministic locking ALL listings -> ALL variants -> mutate; revalidates return/condition/has_variants/food snapshot)
CREATE OR REPLACE FUNCTION public.execute_approved_refund_restock_internal(
  p_refund_id uuid,
  p_actor_id uuid
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
  v_plan_item RECORD;
  v_listing public.listings;
  v_variant public.listing_variants;
  v_any_exception boolean := false;
  v_now timestamptz := clock_timestamp();
BEGIN
  SELECT r.* INTO v_refund FROM public.order_refunds r WHERE r.id = p_refund_id;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_refund.status <> 'succeeded' THEN RETURN v_refund.restock_status; END IF;
  IF v_refund.restock_status IN ('approved_restocked', 'declined', 'inventory_exception', 'not_applicable') THEN
    RETURN v_refund.restock_status;
  END IF;

  SELECT o.* INTO v_order FROM public.orders o WHERE o.id = v_refund.order_id;
  SELECT d.* INTO v_dispute FROM public.order_disputes d WHERE d.id = v_refund.dispute_id;

  -- Revalidate return & resellable condition immediately before any stock mutation (never rolls back refund!)
  IF (v_dispute.previous_order_status IN ('handed_over', 'completed') OR v_order.handed_over_at IS NOT NULL)
     AND (v_refund.return_status <> 'return_confirmed' OR v_refund.item_condition <> 'resellable') THEN
    UPDATE public.order_refunds r
    SET restock_status = 'inventory_exception', updated_at = v_now
    WHERE r.id = v_refund.id;
    RETURN 'inventory_exception';
  END IF;

  IF v_refund.item_condition IN ('damaged', 'missing') THEN
    UPDATE public.order_refunds r
    SET restock_status = 'inventory_exception', updated_at = v_now
    WHERE r.id = v_refund.id;
    RETURN 'inventory_exception';
  END IF;

  -- Phase 1: Lock ALL affected listings in deterministic ID order BEFORE any mutation (Phase 6B compatible!)
  PERFORM 1
  FROM public.listings l
  WHERE l.id IN (
    SELECT DISTINCT oi.listing_id
    FROM jsonb_array_elements(COALESCE(v_refund.restock_plan, '[]'::jsonb)) elem
    JOIN public.order_items oi
      ON oi.id = (elem->>'order_item_id')::uuid
     AND oi.order_id = v_order.id
    WHERE oi.listing_id IS NOT NULL
  )
  ORDER BY l.id
  FOR UPDATE;

  -- Phase 2: Lock ALL affected variants in deterministic ID order BEFORE any mutation
  PERFORM 1
  FROM public.listing_variants lv
  WHERE lv.id IN (
    SELECT DISTINCT oi.variant_id
    FROM jsonb_array_elements(COALESCE(v_refund.restock_plan, '[]'::jsonb)) elem
    JOIN public.order_items oi
      ON oi.id = (elem->>'order_item_id')::uuid
     AND oi.order_id = v_order.id
    WHERE oi.variant_id IS NOT NULL
  )
  ORDER BY lv.id
  FOR UPDATE;

  -- Phase 3: Validate structure & mutate inventory (exactly once per refund_id + order_item_id)
  FOR v_plan_item IN
    SELECT
      (elem->>'order_item_id')::uuid AS order_item_id,
      (elem->>'quantity')::integer AS restore_qty,
      oi.listing_id,
      oi.variant_id,
      oi.quantity AS purchased_qty,
      COALESCE(oi.is_food, false) AS snapshot_is_food
    FROM jsonb_array_elements(COALESCE(v_refund.restock_plan, '[]'::jsonb)) elem
    JOIN public.order_items oi
      ON oi.id = (elem->>'order_item_id')::uuid
     AND oi.order_id = v_order.id
    ORDER BY oi.listing_id NULLS LAST, oi.variant_id NULLS LAST, oi.id
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.order_restock_logs l
      WHERE l.refund_id = v_refund.id AND l.order_item_id = v_plan_item.order_item_id
    ) THEN
      CONTINUE;
    END IF;

    IF v_plan_item.restore_qty IS NULL
       OR v_plan_item.restore_qty <= 0
       OR v_plan_item.restore_qty > v_plan_item.purchased_qty THEN
      v_any_exception := true;
      INSERT INTO public.order_restock_logs (
        refund_id, order_id, order_item_id, listing_id, variant_id,
        quantity_restored, outcome, note, approved_by, created_at
      ) VALUES (
        v_refund.id, v_order.id, v_plan_item.order_item_id, v_plan_item.listing_id, v_plan_item.variant_id,
        0, 'inventory_exception', 'Invalid restore quantity vs purchased quantity', p_actor_id, v_now
      );
      CONTINUE;
    END IF;

    SELECT * INTO v_listing FROM public.listings WHERE id = v_plan_item.listing_id;
    IF NOT FOUND
       OR v_plan_item.snapshot_is_food
       OR COALESCE(v_listing.is_food, false)
       OR lower(COALESCE(v_listing.kind, '')) = 'service' THEN
      v_any_exception := true;
      INSERT INTO public.order_restock_logs (
        refund_id, order_id, order_item_id, listing_id, variant_id,
        quantity_restored, outcome, note, approved_by, created_at
      ) VALUES (
        v_refund.id, v_order.id, v_plan_item.order_item_id, v_plan_item.listing_id, v_plan_item.variant_id,
        0, 'inventory_exception',
        CASE WHEN NOT FOUND THEN 'Listing no longer exists' ELSE 'Food or service item ineligible for restock' END,
        p_actor_id, v_now
      );
      CONTINUE;
    END IF;

    -- Validate current has_variants structure vs purchased variant_id
    IF COALESCE(v_listing.has_variants, false) AND v_plan_item.variant_id IS NULL THEN
      v_any_exception := true;
      INSERT INTO public.order_restock_logs (
        refund_id, order_id, order_item_id, listing_id, variant_id,
        quantity_restored, outcome, note, approved_by, created_at
      ) VALUES (
        v_refund.id, v_order.id, v_plan_item.order_item_id, v_plan_item.listing_id, v_plan_item.variant_id,
        0, 'inventory_exception', 'Listing switched to variants; non-variant item incompatible', p_actor_id, v_now
      );
      CONTINUE;
    END IF;

    IF NOT COALESCE(v_listing.has_variants, false) AND v_plan_item.variant_id IS NOT NULL THEN
      v_any_exception := true;
      INSERT INTO public.order_restock_logs (
        refund_id, order_id, order_item_id, listing_id, variant_id,
        quantity_restored, outcome, note, approved_by, created_at
      ) VALUES (
        v_refund.id, v_order.id, v_plan_item.order_item_id, v_plan_item.listing_id, v_plan_item.variant_id,
        0, 'inventory_exception', 'Listing no longer uses variants; purchased variant incompatible', p_actor_id, v_now
      );
      CONTINUE;
    END IF;

    IF v_plan_item.variant_id IS NOT NULL THEN
      SELECT * INTO v_variant
      FROM public.listing_variants
      WHERE id = v_plan_item.variant_id AND listing_id = v_listing.id;

      IF NOT FOUND THEN
        v_any_exception := true;
        INSERT INTO public.order_restock_logs (
          refund_id, order_id, order_item_id, listing_id, variant_id,
          quantity_restored, outcome, note, approved_by, created_at
        ) VALUES (
          v_refund.id, v_order.id, v_plan_item.order_item_id, v_plan_item.listing_id, v_plan_item.variant_id,
          0, 'inventory_exception', 'Variant no longer exists or belongs to another listing', p_actor_id, v_now
        );
        CONTINUE;
      END IF;

      UPDATE public.listing_variants
      SET quantity = quantity + v_plan_item.restore_qty
      WHERE id = v_variant.id;
    END IF;

    -- Preserve reserved_quantity <= quantity invariant
    UPDATE public.listings
    SET quantity = GREATEST(reserved_quantity, quantity + v_plan_item.restore_qty),
        updated_at = v_now
    WHERE id = v_listing.id;

    INSERT INTO public.order_restock_logs (
      refund_id, order_id, order_item_id, listing_id, variant_id,
      quantity_restored, outcome, note, approved_by, created_at
    ) VALUES (
      v_refund.id, v_order.id, v_plan_item.order_item_id, v_plan_item.listing_id, v_plan_item.variant_id,
      v_plan_item.restore_qty, 'restocked', 'Post-refund verified stock restoration', p_actor_id, v_now
    );
  END LOOP;

  UPDATE public.order_refunds r
  SET restock_status = CASE WHEN v_any_exception THEN 'inventory_exception' ELSE 'approved_restocked' END,
      restocked_at = v_now,
      updated_at = v_now
  WHERE r.id = v_refund.id;

  RETURN CASE WHEN v_any_exception THEN 'inventory_exception' ELSE 'approved_restocked' END;
END;
$$;

REVOKE ALL ON FUNCTION public.execute_approved_refund_restock_internal(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- 5.5 Admin Restock Approval (P0.8: explicit item/quantity selection, food/damaged guard, separated from stock mutation until refund succeeds)
DROP FUNCTION IF EXISTS public.admin_approve_refund_restock_atomic(uuid, boolean);
DROP FUNCTION IF EXISTS public.admin_approve_refund_restock_atomic(uuid, boolean, jsonb);
CREATE OR REPLACE FUNCTION public.admin_approve_refund_restock_atomic(
  p_refund_id uuid,
  p_approve boolean,
  p_items jsonb DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_order public.orders;
  v_dispute public.order_disputes;
  v_refund public.order_refunds;
  v_plan jsonb := '[]'::jsonb;
  v_seen_items uuid[] := '{}'::uuid[];
  v_item_count integer := 0;
  v_item RECORD;
  v_oi public.order_items;
  v_listing public.listings;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY' USING ERRCODE = '42501';
  END IF;

  SELECT o.* INTO v_order
  FROM public.order_refunds r
  JOIN public.orders o ON o.id = r.order_id
  WHERE r.id = p_refund_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'REFUND_NOT_FOUND'; END IF;

  -- Strict shared lock order: profiles -> orders -> order_disputes -> order_refunds
  PERFORM 1 FROM public.profiles p WHERE p.id = v_order.seller_id FOR UPDATE;
  SELECT o.* INTO v_order FROM public.orders o WHERE o.id = v_order.id FOR UPDATE;
  SELECT d.* INTO v_dispute FROM public.order_disputes d
    WHERE d.id = (SELECT r0.dispute_id FROM public.order_refunds r0 WHERE r0.id = p_refund_id)
    FOR UPDATE;
  SELECT r.* INTO v_refund FROM public.order_refunds r WHERE r.id = p_refund_id FOR UPDATE;

  IF v_refund.restock_status IN ('approved_restocked', 'declined', 'inventory_exception') THEN
    RETURN v_refund.restock_status;
  END IF;

  IF v_refund.refund_type <> 'full_refund' THEN
    RAISE EXCEPTION 'RESTOCK_FULL_REFUND_ONLY';
  END IF;

  IF NOT COALESCE(p_approve, false) THEN
    UPDATE public.order_refunds r
    SET restock_status = 'declined',
        restock_plan = NULL,
        restock_approved_by = v_uid,
        updated_at = v_now
    WHERE r.id = v_refund.id;
    RETURN 'declined';
  END IF;

  -- Handed-over items MUST have confirmed physical return in resellable condition (never damaged/missing!)
  IF v_dispute.previous_order_status IN ('handed_over', 'completed') OR v_order.handed_over_at IS NOT NULL THEN
    IF v_refund.return_status <> 'return_confirmed' OR v_refund.item_condition <> 'resellable' THEN
      RAISE EXCEPTION 'RESTOCK_REQUIRES_RESELLABLE_RETURN';
    END IF;
  END IF;

  IF v_refund.item_condition IN ('damaged', 'missing') THEN
    RAISE EXCEPTION 'RESTOCK_UNSUITABLE_CONDITION';
  END IF;

  SELECT COUNT(*)::integer INTO v_item_count
  FROM public.order_items oi WHERE oi.order_id = v_order.id;

  -- P0.13: Multi-item orders require explicit item/quantity selection
  IF p_items IS NULL AND v_item_count > 1 THEN
    RAISE EXCEPTION 'EXPLICIT_MULTI_ITEM_RESTOCK_REQUIRED';
  END IF;

  -- Build and validate explicit restock plan
  IF p_items IS NOT NULL THEN
    IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
      RAISE EXCEPTION 'INVALID_RESTOCK_ITEMS';
    END IF;
    FOR v_item IN
      SELECT
        (elem->>'order_item_id')::uuid AS order_item_id,
        (elem->>'quantity')::integer AS req_qty
      FROM jsonb_array_elements(p_items) elem
    LOOP
      IF v_item.order_item_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_RESTOCK_ORDER_ITEM';
      END IF;
      IF v_item.order_item_id = ANY(v_seen_items) THEN
        RAISE EXCEPTION 'DUPLICATE_RESTOCK_ORDER_ITEM';
      END IF;
      v_seen_items := array_append(v_seen_items, v_item.order_item_id);

      SELECT oi.* INTO v_oi
      FROM public.order_items oi
      WHERE oi.id = v_item.order_item_id AND oi.order_id = v_order.id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'INVALID_RESTOCK_ORDER_ITEM';
      END IF;
      IF v_item.req_qty IS NULL OR v_item.req_qty <= 0 OR v_item.req_qty > v_oi.quantity THEN
        RAISE EXCEPTION 'INVALID_RESTOCK_QUANTITY';
      END IF;
      IF COALESCE(v_oi.is_food, false) THEN
        RAISE EXCEPTION 'FOOD_OR_SERVICE_NOT_RESTOCKABLE';
      END IF;
      SELECT l.* INTO v_listing FROM public.listings l WHERE l.id = v_oi.listing_id;
      IF FOUND AND (COALESCE(v_listing.is_food, false) OR lower(COALESCE(v_listing.kind, '')) = 'service') THEN
        RAISE EXCEPTION 'FOOD_OR_SERVICE_NOT_RESTOCKABLE';
      END IF;
      v_plan := v_plan || jsonb_build_array(
        jsonb_build_object('order_item_id', v_oi.id, 'quantity', v_item.req_qty)
      );
    END LOOP;
  ELSE
    FOR v_oi IN
      SELECT oi.* FROM public.order_items oi WHERE oi.order_id = v_order.id ORDER BY oi.id
    LOOP
      IF COALESCE(v_oi.is_food, false) THEN
        RAISE EXCEPTION 'FOOD_OR_SERVICE_NOT_RESTOCKABLE';
      END IF;
      SELECT l.* INTO v_listing FROM public.listings l WHERE l.id = v_oi.listing_id;
      IF FOUND AND (COALESCE(v_listing.is_food, false) OR lower(COALESCE(v_listing.kind, '')) = 'service') THEN
        RAISE EXCEPTION 'FOOD_OR_SERVICE_NOT_RESTOCKABLE';
      END IF;
      v_plan := v_plan || jsonb_build_array(
        jsonb_build_object('order_item_id', v_oi.id, 'quantity', v_oi.quantity)
      );
    END LOOP;
  END IF;

  UPDATE public.order_refunds r
  SET restock_status = 'approved_pending_refund',
      restock_plan = v_plan,
      restock_approved_by = v_uid,
      updated_at = v_now
  WHERE r.id = v_refund.id;

  -- Execute stock mutation ONLY if refund has ALREADY succeeded; otherwise wait for refund finalization!
  IF v_refund.status = 'succeeded' THEN
    RETURN public.execute_approved_refund_restock_internal(v_refund.id, v_uid);
  END IF;

  RETURN 'approved_pending_refund';
END;
$$;

REVOKE ALL ON FUNCTION public.admin_approve_refund_restock_atomic(uuid, boolean, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_approve_refund_restock_atomic(uuid, boolean, jsonb) TO authenticated;

-- 5.6 Durable Provider Outcome Recorder (P0.12: immutable once definitive; idempotent on identical replay; rejects conflicts)
CREATE OR REPLACE FUNCTION public.record_provider_attempt_outcome_atomic(
  p_attempt_token uuid,
  p_provider_outcome text,
  p_simulation_ref text DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_attempt public.financial_execution_attempts;
  v_clean_ref text := NULLIF(trim(COALESCE(p_simulation_ref, '')), '');
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_attempt_token IS NULL OR p_provider_outcome IS NULL THEN
    RAISE EXCEPTION 'INVALID_PROVIDER_OUTCOME';
  END IF;

  SELECT a.* INTO v_attempt
  FROM public.financial_execution_attempts a
  WHERE a.attempt_token = p_attempt_token
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF (v_attempt.entity_type = 'refund' AND p_provider_outcome NOT IN ('succeeded', 'failed', 'reconciliation_required'))
     OR (v_attempt.entity_type = 'withdrawal' AND p_provider_outcome NOT IN ('paid', 'failed', 'reconciliation_required')) THEN
    RAISE EXCEPTION 'INVALID_PROVIDER_OUTCOME';
  END IF;

  -- Require valid simulation ref prefix for definitive simulated successes
  IF p_provider_outcome = 'succeeded' AND v_attempt.simulation_mode
     AND (v_clean_ref IS NULL OR v_clean_ref NOT LIKE 'SIM-RFD-%') THEN
    RAISE EXCEPTION 'INVALID_REFUND_REF';
  END IF;
  IF p_provider_outcome = 'paid' AND v_attempt.simulation_mode
     AND (v_clean_ref IS NULL OR v_clean_ref NOT LIKE 'SIM-TRF-%') THEN
    RAISE EXCEPTION 'INVALID_TRANSFER_REF';
  END IF;

  -- P0.12 Immutability: definitive recorded success CANNOT become failure, uncertainty, or a different ref!
  IF v_attempt.provider_outcome IN ('succeeded', 'paid') THEN
    IF p_provider_outcome = v_attempt.provider_outcome
       AND v_clean_ref IS NOT DISTINCT FROM v_attempt.simulation_ref THEN
      RETURN true; -- Idempotent identical replay
    END IF;
    RAISE EXCEPTION 'CONFLICTING_PROVIDER_OUTCOME';
  END IF;

  -- P0.12 Immutability: definitive recorded failure CANNOT become success or uncertainty for the same attempt!
  IF v_attempt.provider_outcome = 'failed' THEN
    IF p_provider_outcome = 'failed' THEN
      RETURN true; -- Idempotent identical replay
    END IF;
    RAISE EXCEPTION 'CONFLICTING_PROVIDER_OUTCOME';
  END IF;

  IF v_attempt.status = 'finalized' THEN
    RETURN true;
  END IF;

  -- Unrecorded (NULL) or uncertain ('reconciliation_required') may transition to trusted definitive outcome
  UPDATE public.financial_execution_attempts a
  SET provider_outcome = p_provider_outcome,
      simulation_ref = COALESCE(v_clean_ref, a.simulation_ref),
      failure_or_uncertainty_reason = COALESCE(NULLIF(trim(p_reason), ''), a.failure_or_uncertainty_reason),
      status = CASE
        WHEN p_provider_outcome IN ('succeeded', 'paid') THEN 'provider_succeeded'
        WHEN p_provider_outcome = 'failed' THEN 'provider_failed'
        ELSE 'provider_uncertain'
      END,
      provider_recorded_at = COALESCE(a.provider_recorded_at, v_now)
  WHERE a.id = v_attempt.id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.record_provider_attempt_outcome_atomic(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_provider_attempt_outcome_atomic(uuid, text, text, text) TO service_role;

-- 5.7 Atomic Refund Execution Claim (service_role only; validates payment proof, dispute state, amount, records attempt history)
CREATE OR REPLACE FUNCTION public.claim_order_refund_execution_atomic(
  p_refund_id uuid,
  p_admin_id uuid
)
RETURNS TABLE (
  action          text,
  attempt_token   uuid,
  logical_tx_id   text,
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
  v_dispute public.order_disputes;
  v_order public.orders;
  v_token uuid;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_admin_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.admin_users au WHERE au.user_id = p_admin_id AND au.active = true
  ) THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY' USING ERRCODE = '42501';
  END IF;

  SELECT o.* INTO v_order
  FROM public.order_refunds r
  JOIN public.orders o ON o.id = r.order_id
  WHERE r.id = p_refund_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'REFUND_NOT_FOUND'; END IF;

  PERFORM 1 FROM public.profiles p WHERE p.id = v_order.seller_id FOR UPDATE;
  SELECT o.* INTO v_order FROM public.orders o WHERE o.id = v_order.id FOR UPDATE;
  SELECT d.* INTO v_dispute FROM public.order_disputes d
    WHERE d.id = (SELECT r0.dispute_id FROM public.order_refunds r0 WHERE r0.id = p_refund_id)
    FOR UPDATE;
  SELECT r.* INTO v_refund FROM public.order_refunds r WHERE r.id = p_refund_id FOR UPDATE;

  IF v_refund.status = 'succeeded' THEN
    RETURN QUERY SELECT 'already_succeeded'::text, NULL::uuid, v_refund.idempotency_key, v_refund.refund_code, v_refund.refund_amount_sen, v_refund.refund_type, v_refund.order_id;
    RETURN;
  END IF;

  IF v_refund.status = 'processing' THEN
    RETURN QUERY SELECT 'in_progress'::text, NULL::uuid, v_refund.idempotency_key, v_refund.refund_code, v_refund.refund_amount_sen, v_refund.refund_type, v_refund.order_id;
    RETURN;
  END IF;

  IF v_refund.status = 'reconciliation_required' THEN
    RETURN QUERY SELECT 'reconciliation_required'::text, NULL::uuid, v_refund.idempotency_key, v_refund.refund_code, v_refund.refund_amount_sen, v_refund.refund_type, v_refund.order_id;
    RETURN;
  END IF;

  IF NOT public.is_order_payment_verified(v_order.id) THEN
    RAISE EXCEPTION 'PAYMENT_UNVERIFIED';
  END IF;

  IF v_dispute.status <> 'resolved'
     OR v_dispute.resolution_type NOT IN ('full_refund', 'partial_refund')
     OR v_refund.refund_type <> v_dispute.resolution_type
     OR v_refund.refund_amount_sen <> v_dispute.refund_amount_sen THEN
    RAISE EXCEPTION 'INVALID_DISPUTE_STATE';
  END IF;

  IF v_order.status <> 'disputed' THEN
    RAISE EXCEPTION 'ORDER_NOT_DISPUTED';
  END IF;

  IF v_refund.refund_amount_sen <= 0 OR v_refund.refund_amount_sen > v_order.subtotal_sen THEN
    RAISE EXCEPTION 'INVALID_REFUND_AMOUNT';
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

  INSERT INTO public.financial_execution_attempts (
    entity_type, entity_id, logical_tx_id, attempt_token, attempt_number,
    provider, simulation_mode, status, started_at
  ) VALUES (
    'refund', v_refund.id, v_refund.idempotency_key, v_token, v_refund.attempt_count,
    v_refund.provider, v_refund.simulation_mode, 'started', v_now
  );

  RETURN QUERY SELECT 'claimed'::text, v_token, v_refund.idempotency_key, v_refund.refund_code, v_refund.refund_amount_sen, v_refund.refund_type, v_refund.order_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_order_refund_execution_atomic(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_order_refund_execution_atomic(uuid, uuid) TO service_role;

-- 5.8 Trusted Refund Finalization (service_role only; explicit NULL/state/ref guards, executes approved restock atomically on success)
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
  v_attempt public.financial_execution_attempts;
  v_now timestamptz := clock_timestamp();
  v_next_order_status text;
  v_clean_ref text := trim(COALESCE(p_refund_ref, ''));
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('succeeded', 'failed', 'reconciliation_required') THEN
    RAISE EXCEPTION 'INVALID_REFUND_OUTCOME';
  END IF;

  IF p_attempt_token IS NULL THEN
    RAISE EXCEPTION 'MISSING_ATTEMPT_TOKEN';
  END IF;

  SELECT o.* INTO v_order
  FROM public.order_refunds r
  JOIN public.orders o ON o.id = r.order_id
  WHERE r.id = p_refund_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'REFUND_NOT_FOUND'; END IF;

  -- Strict lock order: profiles -> orders -> order_disputes -> order_refunds -> financial_execution_attempts
  PERFORM 1 FROM public.profiles p WHERE p.id = v_order.seller_id FOR UPDATE;
  SELECT o.* INTO v_order FROM public.orders o WHERE o.id = v_order.id FOR UPDATE;
  SELECT d.* INTO v_dispute FROM public.order_disputes d
    WHERE d.id = (SELECT r0.dispute_id FROM public.order_refunds r0 WHERE r0.id = p_refund_id)
    FOR UPDATE;
  SELECT r.* INTO v_refund FROM public.order_refunds r WHERE r.id = p_refund_id FOR UPDATE;

  IF v_refund.status = 'succeeded' THEN
    RETURN 'already_succeeded';
  END IF;

  IF v_refund.status NOT IN ('processing', 'reconciliation_required')
     OR v_refund.attempt_token IS DISTINCT FROM p_attempt_token THEN
    RETURN 'stale_attempt';
  END IF;

  -- P0.12: Lock & validate corresponding execution attempt (entity_type, entity_id, token, logical_tx_id)
  SELECT a.* INTO v_attempt
  FROM public.financial_execution_attempts a
  WHERE a.attempt_token = p_attempt_token
  FOR UPDATE;

  IF NOT FOUND
     OR v_attempt.entity_type <> 'refund'
     OR v_attempt.entity_id <> v_refund.id
     OR v_attempt.logical_tx_id <> v_refund.idempotency_key THEN
    RAISE EXCEPTION 'ATTEMPT_EVIDENCE_MISMATCH';
  END IF;

  IF NOT public.is_order_payment_verified(v_order.id) THEN
    RAISE EXCEPTION 'PAYMENT_UNVERIFIED';
  END IF;

  IF v_dispute.status <> 'resolved'
     OR v_refund.refund_type <> v_dispute.resolution_type
     OR v_refund.refund_amount_sen <> v_dispute.refund_amount_sen
     OR v_order.status <> 'disputed' THEN
    RAISE EXCEPTION 'INVALID_DISPUTE_STATE';
  END IF;

  IF p_outcome = 'failed' THEN
    -- P0.12: Require definitive persisted provider failure; NEVER fabricate provider_recorded_at!
    IF v_attempt.provider_recorded_at IS NULL OR v_attempt.provider_outcome <> 'failed' THEN
      RAISE EXCEPTION 'UNVERIFIED_PROVIDER_FAILURE';
    END IF;

    UPDATE public.order_refunds r
    SET status = 'failed',
        attempt_token = NULL,
        failure_reason = COALESCE(NULLIF(trim(p_failure_reason), ''), v_attempt.failure_or_uncertainty_reason, 'Simulated refund provider failure'),
        updated_at = v_now
    WHERE r.id = v_refund.id;

    UPDATE public.order_disputes d
    SET refund_execution_status = 'failed', updated_at = v_now
    WHERE d.id = v_dispute.id;

    UPDATE public.financial_execution_attempts a
    SET status = 'finalized',
        finalized_at = v_now
    WHERE a.id = v_attempt.id;

    RETURN 'failed';
  END IF;

  IF p_outcome = 'reconciliation_required' THEN
    -- Never downgrade a definitive recorded success or failure to uncertain!
    IF v_attempt.provider_outcome IN ('succeeded', 'failed') THEN
      RAISE EXCEPTION 'CONFLICTING_PROVIDER_OUTCOME';
    END IF;

    UPDATE public.order_refunds r
    SET status = 'reconciliation_required',
        reconciliation_reason = COALESCE(NULLIF(trim(p_failure_reason), ''), v_attempt.failure_or_uncertainty_reason, 'Uncertain refund provider response'),
        updated_at = v_now
    WHERE r.id = v_refund.id;

    UPDATE public.financial_execution_attempts a
    SET status = 'provider_uncertain',
        provider_outcome = 'reconciliation_required',
        failure_or_uncertainty_reason = COALESCE(NULLIF(trim(p_failure_reason), ''), a.failure_or_uncertainty_reason)
    WHERE a.id = v_attempt.id;

    RETURN 'reconciliation_required';
  END IF;

  -- SUCCEEDED: require trusted persisted provider success & matching simulation_ref (NEVER fabricate provider_recorded_at!)
  IF length(v_clean_ref) = 0 OR (v_refund.simulation_mode AND v_clean_ref NOT LIKE 'SIM-RFD-%') THEN
    RAISE EXCEPTION 'INVALID_REFUND_REF';
  END IF;

  IF v_attempt.provider_recorded_at IS NULL
     OR v_attempt.provider_outcome <> 'succeeded'
     OR v_attempt.simulation_ref IS DISTINCT FROM v_clean_ref THEN
    RAISE EXCEPTION 'UNVERIFIED_PROVIDER_SUCCESS';
  END IF;

  UPDATE public.order_refunds r
  SET status = 'succeeded',
      refund_ref = v_clean_ref,
      attempt_token = NULL,
      completed_at = v_now,
      updated_at = v_now
  WHERE r.id = v_refund.id;

  UPDATE public.order_disputes d
  SET refund_execution_status = 'executed',
      refund_ref = v_clean_ref,
      updated_at = v_now
  WHERE d.id = v_dispute.id;

  UPDATE public.financial_execution_attempts a
  SET status = 'finalized',
      finalized_at = v_now
  WHERE a.id = v_attempt.id;

  INSERT INTO public.financial_adjustments (order_id, refund_id, dispute_id, seller_id, kind, amount_sen, note, created_by, created_at)
  VALUES
    (v_order.id, v_refund.id, v_dispute.id, v_order.seller_id, 'refund_product', v_refund.refund_amount_sen, 'Simulated refund ' || v_clean_ref, v_refund.initiated_by, v_now),
    (v_order.id, v_refund.id, v_dispute.id, v_order.seller_id, 'commission_reversal', v_refund.commission_reversal_sen, '2% commission reversal on refunded subtotal', v_refund.initiated_by, v_now),
    (v_order.id, v_refund.id, v_dispute.id, v_order.seller_id, 'seller_earnings_deduction', v_refund.seller_deduction_sen, 'Seller earnings reduction', v_refund.initiated_by, v_now)
  ON CONFLICT (refund_id, kind) DO NOTHING;

  IF v_refund.refund_type = 'full_refund' THEN
    UPDATE public.orders o
    SET status = 'refunded',
        pickup_pin = NULL,
        updated_at = v_now
    WHERE o.id = v_order.id;
  ELSE
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

  -- Execute pre-approved restock atomically on refund success (exceptions logged, never block refund!)
  IF v_refund.restock_status = 'approved_pending_refund' THEN
    PERFORM public.execute_approved_refund_restock_internal(
      v_refund.id,
      COALESCE(v_refund.restock_approved_by, v_refund.initiated_by)
    );
  END IF;

  PERFORM public.safe_insert_notification(
    v_order.buyer_id,
    'refund_succeeded',
    'Simulated refund completed for #' || v_order.order_code,
    'Ref ' || v_clean_ref || ' · RM ' || to_char(v_refund.refund_amount_sen / 100.0, 'FM999990.00'),
    '/orders',
    'refund-succeeded-' || v_refund.id::text
  );

  RETURN 'succeeded';
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_order_refund_atomic(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_order_refund_atomic(uuid, uuid, text, text, text) TO service_role;

-- =============================================================================
-- SECTION 6: Seller Bank Account Upsert / Deactivate (P0.2 & P0.3)
--   - Uses explicit PK constraint `ON CONFLICT ON CONSTRAINT seller_payout_accounts_pkey`
--   - Acquires shared seller-level lock `profiles FOR UPDATE`
--   - Rejects unencrypted values & never stores plaintext account numbers
-- =============================================================================
DROP FUNCTION IF EXISTS public.upsert_seller_bank_account_secure(uuid, text, text, text, text, text);
CREATE OR REPLACE FUNCTION public.upsert_seller_bank_account_secure(
  p_seller_id uuid,
  p_bank_name text,
  p_account_holder_name text,
  p_account_number_encrypted text,
  p_account_number_last4 text,
  p_account_number_masked text
)
RETURNS TABLE (
  out_seller_id             uuid,
  out_bank_name             text,
  out_account_holder_name   text,
  out_account_number_masked text,
  out_validation_status     text,
  out_is_active             boolean,
  out_updated_at            timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_row public.seller_payout_accounts;
BEGIN
  IF p_account_number_encrypted IS NULL OR p_account_number_encrypted NOT LIKE 'v1:%' THEN
    RAISE EXCEPTION 'INVALID_ENCRYPTED_ACCOUNT';
  END IF;

  IF p_account_number_masked IS NULL OR p_account_number_masked NOT LIKE '****%' THEN
    RAISE EXCEPTION 'INVALID_MASKED_ACCOUNT';
  END IF;

  -- Acquire shared seller-level lock FIRST (serializes with withdrawal creation!)
  PERFORM 1 FROM public.profiles p WHERE p.id = p_seller_id FOR UPDATE;

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
    duitnow_id, validation_status, is_active, deactivated_at, created_at, updated_at
  ) VALUES (
    p_seller_id, trim(p_bank_name), trim(p_account_holder_name),
    p_account_number_masked, p_account_number_encrypted,
    p_account_number_last4, p_account_number_masked,
    NULL, 'validated', true, NULL, v_now, v_now
  )
  ON CONFLICT ON CONSTRAINT seller_payout_accounts_pkey DO UPDATE
  SET bank_name = EXCLUDED.bank_name,
      account_holder_name = EXCLUDED.account_holder_name,
      account_number = EXCLUDED.account_number_masked,
      account_number_encrypted = EXCLUDED.account_number_encrypted,
      account_number_last4 = EXCLUDED.account_number_last4,
      account_number_masked = EXCLUDED.account_number_masked,
      duitnow_id = NULL,
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
  -- Acquire shared seller-level lock FIRST (serializes with withdrawal creation!)
  PERFORM 1 FROM public.profiles p WHERE p.id = p_seller_id FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.payout_requests pr
    WHERE pr.seller_id = p_seller_id AND pr.status IN ('pending', 'processing')
  ) THEN
    RAISE EXCEPTION 'ACTIVE_WITHDRAWAL_IN_PROGRESS';
  END IF;

  UPDATE public.seller_payout_accounts spa
  SET is_active = false,
      validation_status = 'deactivated',
      deactivated_at = v_now,
      updated_at = v_now
  WHERE spa.seller_id = p_seller_id;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.deactivate_seller_bank_account_secure(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.deactivate_seller_bank_account_secure(uuid) TO service_role;

-- =============================================================================
-- SECTION 7: Automated Seller Withdrawals & Evidence-Based Safe Recovery (P0.4/P0.5/P0.6/P0.7)
-- =============================================================================
DROP FUNCTION IF EXISTS public.create_seller_withdrawal_atomic(uuid, integer, text);
CREATE OR REPLACE FUNCTION public.create_seller_withdrawal_atomic(
  p_seller_id uuid,
  p_amount_sen integer,
  p_idempotency_key text
)
RETURNS TABLE (
  action              text,
  withdrawal_id       uuid,
  withdrawal_code     text,
  logical_tx_id       text,
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

  -- Acquire shared seller-level lock FIRST
  PERFORM 1 FROM public.profiles p WHERE p.id = p_seller_id FOR UPDATE;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = p_seller_id
      AND lower(COALESCE(p.university_role, '')) = 'student'
      AND lower(COALESCE(p.status, '')) = 'active'
  ) THEN
    RAISE EXCEPTION 'FORBIDDEN_ACTIVE_STUDENT_ONLY' USING ERRCODE = '42501';
  END IF;

  SELECT pr.* INTO v_existing
  FROM public.payout_requests pr
  WHERE pr.idempotency_key = v_key AND pr.seller_id = p_seller_id;

  IF FOUND THEN
    RETURN QUERY SELECT
      'existing'::text, v_existing.id, v_existing.withdrawal_code, v_existing.idempotency_key,
      v_existing.amount_sen, v_existing.attempt_token, v_existing.masked_bank_summary;
    RETURN;
  END IF;

  -- P0.2: Require active, validated AND encrypted bank account!
  SELECT b.* INTO v_bank
  FROM public.seller_payout_accounts b
  WHERE b.seller_id = p_seller_id
    AND b.is_active = true
    AND b.validation_status = 'validated'
    AND b.account_number_encrypted IS NOT NULL
    AND b.account_number_encrypted LIKE 'v1:%';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_ACTIVE_BANK_ACCOUNT';
  END IF;

  v_now := clock_timestamp();

  -- P0.6 & P0.7: Lock eligible completed orders with authoritative payment proof,
  --              authoritative protection_expires_at, and NO blocking disputes or outstanding refunds!
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
      AND o.completed_at IS NOT NULL
      AND v_now >= COALESCE(o.protection_expires_at, o.completed_at + interval '72 hours')
      AND public.is_order_payment_verified(o.id)
      AND NOT EXISTS (
        SELECT 1 FROM public.order_disputes d
        WHERE d.order_id = o.id
          AND (
            lower(COALESCE(d.status, '')) IN ('open', 'under_review')
            OR d.refund_execution_status IN ('pending_execution', 'failed')
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.order_refunds r
        WHERE r.order_id = o.id
          AND r.status IN ('pending_execution', 'awaiting_return', 'processing', 'failed', 'reconciliation_required')
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

  INSERT INTO public.financial_execution_attempts (
    entity_type, entity_id, logical_tx_id, attempt_token, attempt_number,
    provider, simulation_mode, status, started_at
  ) VALUES (
    'withdrawal', v_wdr.id, v_wdr.idempotency_key, v_token, 1,
    'simulated_bank', true, 'started', v_now
  );

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
      AND o.completed_at IS NOT NULL
      AND v_now >= COALESCE(o.protection_expires_at, o.completed_at + interval '72 hours')
      AND public.is_order_payment_verified(o.id)
      AND NOT EXISTS (
        SELECT 1 FROM public.order_disputes d
        WHERE d.order_id = o.id
          AND (
            lower(COALESCE(d.status, '')) IN ('open', 'under_review')
            OR d.refund_execution_status IN ('pending_execution', 'failed')
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.order_refunds r
        WHERE r.order_id = o.id
          AND r.status IN ('pending_execution', 'awaiting_return', 'processing', 'failed', 'reconciliation_required')
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
    'created'::text, v_wdr.id, v_wdr.withdrawal_code, v_wdr.idempotency_key,
    v_wdr.amount_sen, v_token, v_masked;
END;
$$;

REVOKE ALL ON FUNCTION public.create_seller_withdrawal_atomic(uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_seller_withdrawal_atomic(uuid, integer, text) TO service_role;

-- Trusted Withdrawal Finalization (P0.4 & P0.9: validates exact allocated sum, trusted ref, immutable paid, exact-once release)
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
  v_attempt public.financial_execution_attempts;
  v_alloc_sum integer := 0;
  v_now timestamptz := clock_timestamp();
  v_clean_ref text := trim(COALESCE(p_transfer_ref, ''));
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('paid', 'failed', 'reconciliation_required') THEN
    RAISE EXCEPTION 'INVALID_WITHDRAWAL_OUTCOME';
  END IF;

  IF p_attempt_token IS NULL THEN
    RAISE EXCEPTION 'MISSING_ATTEMPT_TOKEN';
  END IF;

  SELECT pr.* INTO v_wdr FROM public.payout_requests pr WHERE pr.id = p_withdrawal_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'WITHDRAWAL_NOT_FOUND'; END IF;

  -- Strict lock order: profiles -> payout_requests -> financial_execution_attempts
  PERFORM 1 FROM public.profiles p WHERE p.id = v_wdr.seller_id FOR UPDATE;
  SELECT pr.* INTO v_wdr FROM public.payout_requests pr WHERE pr.id = p_withdrawal_id FOR UPDATE;

  IF v_wdr.status = 'paid' THEN
    RETURN 'already_paid';
  END IF;

  IF v_wdr.status NOT IN ('processing', 'reconciliation_required')
     OR v_wdr.attempt_token IS DISTINCT FROM p_attempt_token THEN
    RETURN 'stale_attempt';
  END IF;

  -- P0.12: Lock & validate corresponding execution attempt (entity_type, entity_id, token, logical_tx_id)
  SELECT a.* INTO v_attempt
  FROM public.financial_execution_attempts a
  WHERE a.attempt_token = p_attempt_token
  FOR UPDATE;

  IF NOT FOUND
     OR v_attempt.entity_type <> 'withdrawal'
     OR v_attempt.entity_id <> v_wdr.id
     OR v_attempt.logical_tx_id <> v_wdr.idempotency_key THEN
    RAISE EXCEPTION 'ATTEMPT_EVIDENCE_MISMATCH';
  END IF;

  IF p_outcome = 'failed' THEN
    -- P0.12: NEVER release reserved funds without definitive recorded provider failure!
    IF v_attempt.provider_recorded_at IS NULL OR v_attempt.provider_outcome <> 'failed' THEN
      RAISE EXCEPTION 'UNVERIFIED_PROVIDER_FAILURE';
    END IF;

    UPDATE public.payout_requests pr
    SET status = 'failed',
        attempt_token = NULL,
        failure_reason = COALESCE(NULLIF(trim(p_failure_reason), ''), v_attempt.failure_or_uncertainty_reason, 'Simulated bank transfer failed'),
        updated_at = v_now
    WHERE pr.id = v_wdr.id;

    UPDATE public.payout_allocations pa
    SET status = 'released', updated_at = v_now
    WHERE pa.payout_request_id = v_wdr.id AND pa.status = 'reserved';

    UPDATE public.financial_execution_attempts a
    SET status = 'finalized',
        finalized_at = v_now
    WHERE a.id = v_attempt.id;

    PERFORM public.safe_insert_notification(
      v_wdr.seller_id,
      'withdrawal_failed',
      'Withdrawal ' || v_wdr.withdrawal_code || ' failed',
      'Reserved balance RM ' || to_char(v_wdr.amount_sen / 100.0, 'FM999990.00') || ' has been restored.',
      '/seller/withdrawals',
      'wdr-failed-' || v_wdr.id::text
    );

    RETURN 'failed';
  END IF;

  IF p_outcome = 'reconciliation_required' THEN
    IF v_attempt.provider_outcome IN ('paid', 'failed') THEN
      RAISE EXCEPTION 'CONFLICTING_PROVIDER_OUTCOME';
    END IF;

    UPDATE public.payout_requests pr
    SET status = 'reconciliation_required',
        reconciliation_reason = COALESCE(NULLIF(trim(p_failure_reason), ''), v_attempt.failure_or_uncertainty_reason, 'Uncertain transfer outcome'),
        updated_at = v_now
    WHERE pr.id = v_wdr.id;

    UPDATE public.financial_execution_attempts a
    SET status = 'provider_uncertain',
        provider_outcome = 'reconciliation_required',
        failure_or_uncertainty_reason = COALESCE(NULLIF(trim(p_failure_reason), ''), a.failure_or_uncertainty_reason)
    WHERE a.id = v_attempt.id;

    RETURN 'reconciliation_required';
  END IF;

  IF length(v_clean_ref) = 0 OR (v_wdr.simulation_mode AND v_clean_ref NOT LIKE 'SIM-TRF-%') THEN
    RAISE EXCEPTION 'INVALID_TRANSFER_REF';
  END IF;

  -- P0.12: Require trusted persisted provider success & matching transfer_ref (NEVER fabricate provider_recorded_at!)
  IF v_attempt.provider_recorded_at IS NULL
     OR v_attempt.provider_outcome <> 'paid'
     OR v_attempt.simulation_ref IS DISTINCT FROM v_clean_ref THEN
    RAISE EXCEPTION 'UNVERIFIED_PROVIDER_SUCCESS';
  END IF;

  -- P0.4: Validate exact allocated total before marking paid!
  SELECT COALESCE(SUM(pa.allocated_sen), 0)::integer
  INTO v_alloc_sum
  FROM public.payout_allocations pa
  WHERE pa.payout_request_id = v_wdr.id AND pa.status = 'reserved';

  IF v_alloc_sum <> v_wdr.amount_sen THEN
    RAISE EXCEPTION 'ALLOCATION_MISMATCH';
  END IF;

  UPDATE public.payout_requests pr
  SET status = 'paid',
      transfer_ref = v_clean_ref,
      attempt_token = NULL,
      processed_at = v_now,
      completed_at = v_now,
      updated_at = v_now
  WHERE pr.id = v_wdr.id;

  UPDATE public.payout_allocations pa
  SET status = 'paid', updated_at = v_now
  WHERE pa.payout_request_id = v_wdr.id AND pa.status = 'reserved';

  UPDATE public.financial_execution_attempts a
  SET status = 'finalized',
      finalized_at = v_now
  WHERE a.id = v_attempt.id;

  PERFORM public.safe_insert_notification(
    v_wdr.seller_id,
    'withdrawal_succeeded',
    'Simulated withdrawal ' || v_wdr.withdrawal_code || ' completed',
    'Ref ' || v_clean_ref || ' · RM ' || to_char(v_wdr.amount_sen / 100.0, 'FM999990.00'),
    '/seller/withdrawals',
    'wdr-paid-' || v_wdr.id::text
  );

  RETURN 'paid';
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_seller_withdrawal_atomic(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_seller_withdrawal_atomic(uuid, uuid, text, text, text) TO service_role;

-- P0.4: REMOVE unsafe admin release function! Never release funds without trusted persisted provider evidence.
DROP FUNCTION IF EXISTS public.admin_release_failed_withdrawal_atomic(uuid, text);

-- Evidence-based durable recovery RPC (service_role only — used by recovery worker & admin recovery check)
-- NEVER releases funds on elapsed time or admin note alone!
--   - If persisted attempt proves provider succeeded -> idempotently finalizes paid/succeeded.
--   - If persisted attempt proves definitive provider failure -> finalizes failed & releases allocations once.
--   - If provider outcome is still uncertain/unrecorded -> keeps funds RESERVED/FROZEN and returns 'held_uncertain'.
CREATE OR REPLACE FUNCTION public.recover_financial_execution_atomic(
  p_entity_type text,
  p_entity_id uuid,
  p_admin_id uuid DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_attempt public.financial_execution_attempts;
  v_wdr public.payout_requests;
  v_refund public.order_refunds;
BEGIN
  IF p_entity_type IS NULL OR p_entity_type NOT IN ('withdrawal', 'refund') THEN
    RAISE EXCEPTION 'INVALID_ENTITY_TYPE';
  END IF;

  IF p_admin_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.admin_users au WHERE au.user_id = p_admin_id AND au.active = true
  ) THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY' USING ERRCODE = '42501';
  END IF;

  IF p_entity_type = 'withdrawal' THEN
    SELECT pr.* INTO v_wdr FROM public.payout_requests pr WHERE pr.id = p_entity_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'WITHDRAWAL_NOT_FOUND'; END IF;
    IF v_wdr.status = 'paid' THEN RETURN 'already_paid'; END IF;
    IF v_wdr.status = 'failed' THEN RETURN 'already_failed'; END IF;
    IF v_wdr.status NOT IN ('processing', 'reconciliation_required') THEN
      RETURN 'not_recoverable';
    END IF;

    SELECT a.* INTO v_attempt
    FROM public.financial_execution_attempts a
    WHERE a.entity_type = 'withdrawal'
      AND a.entity_id = v_wdr.id
      AND a.attempt_token = v_wdr.attempt_token
    ORDER BY a.attempt_number DESC
    LIMIT 1;

    IF NOT FOUND OR v_attempt.provider_recorded_at IS NULL THEN
      RETURN 'held_uncertain';
    END IF;

    IF v_attempt.provider_outcome = 'paid' AND v_attempt.simulation_ref IS NOT NULL THEN
      RETURN public.finalize_seller_withdrawal_atomic(
        v_wdr.id, v_wdr.attempt_token, 'paid', v_attempt.simulation_ref, NULL
      );
    END IF;

    IF v_attempt.provider_outcome = 'failed' THEN
      RETURN public.finalize_seller_withdrawal_atomic(
        v_wdr.id, v_wdr.attempt_token, 'failed', NULL,
        COALESCE(v_attempt.failure_or_uncertainty_reason, 'Verified provider failure')
      );
    END IF;

    RETURN 'held_uncertain';
  ELSE
    SELECT r.* INTO v_refund FROM public.order_refunds r WHERE r.id = p_entity_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'REFUND_NOT_FOUND'; END IF;
    IF v_refund.status = 'succeeded' THEN RETURN 'already_succeeded'; END IF;
    IF v_refund.status = 'failed' THEN RETURN 'already_failed'; END IF;
    IF v_refund.status NOT IN ('processing', 'reconciliation_required') THEN
      RETURN 'not_recoverable';
    END IF;

    SELECT a.* INTO v_attempt
    FROM public.financial_execution_attempts a
    WHERE a.entity_type = 'refund'
      AND a.entity_id = v_refund.id
      AND a.attempt_token = v_refund.attempt_token
    ORDER BY a.attempt_number DESC
    LIMIT 1;

    IF NOT FOUND OR v_attempt.provider_recorded_at IS NULL THEN
      RETURN 'held_uncertain';
    END IF;

    IF v_attempt.provider_outcome = 'succeeded' AND v_attempt.simulation_ref IS NOT NULL THEN
      RETURN public.finalize_order_refund_atomic(
        v_refund.id, v_refund.attempt_token, 'succeeded', v_attempt.simulation_ref, NULL
      );
    END IF;

    IF v_attempt.provider_outcome = 'failed' THEN
      RETURN public.finalize_order_refund_atomic(
        v_refund.id, v_refund.attempt_token, 'failed', NULL,
        COALESCE(v_attempt.failure_or_uncertainty_reason, 'Verified provider failure')
      );
    END IF;

    RETURN 'held_uncertain';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.recover_financial_execution_atomic(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_financial_execution_atomic(text, uuid, uuid) TO service_role;

COMMIT;

-- =============================================================================
-- INSTALLATION & HOSTED ACTIVATION NOTES:
--   1. Apply this single file in Supabase SQL Editor on `duwwlcpdidrxkixvflag`.
--   2. Legacy 4-parameter `admin_resolve_order_dispute_atomic` is dropped cleanly.
--   3. Legacy plaintext `seller_payout_accounts` row is safely masked & deactivated
--      (`re_registration_required`); seller must re-register via encrypted `/seller/bank`.
--   4. Historical completed orders keep their promised 7-day `protection_expires_at`;
--      all new completions automatically receive `completed_at + 72 hours`.
--   5. Schedule `node scripts/phase6d-recovery-worker.mjs` (e.g. every 5 minutes via
--      cron/GitHub Actions/host scheduler) or trigger via `/admin` Safe Recovery Check
--      to finalize any interrupted processing/reconciliation_required executions.
-- =============================================================================
