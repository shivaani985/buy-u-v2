-- =============================================================================
-- Buy-U Phase 6B.3 — Incremental Bill Lifecycle Hardening Hotfix
-- STATUS: PROPOSAL ONLY — DO NOT APPLY WITHOUT EXPLICIT OWNER APPROVAL
-- TARGET PROJECT: duwwlcpdidrxkixvflag
-- PREREQUISITE: `docs/sql/phase-6b3-payment-security-hardening.sql` ALREADY APPLIED
-- (Do NOT rerun the prior migration; apply ONLY this incremental hotfix.)
--
-- Fixes two targeted bill-lifecycle risks:
--   1. Distinguishes failed bill creation (`bill_creation_state = 'failed'`, no
--      gateway bill) from failed payment attempts on an existing valid gateway
--      bill (`bill_creation_state = 'ready'`, valid `bill_code`/`bill_url`).
--      Never discards an existing valid `bill_code` or creates a duplicate bill;
--      reuses the existing ToyyibPay bill on retry and preserves reconciliation.
--   2. Adds persistent `payments.bill_creation_attempt_token uuid` to
--      `claim_order_bill_slot` / `finalize_order_bill_slot`:
--      - Rejects stale finalizations (`stale_attempt`) when token does not match.
--      - Safely recovers a verified `'ready'` bill response arriving after
--        `'ambiguous'` state when the attempt token matches.
-- =============================================================================

BEGIN;

-- 1. Persistent unique creation-attempt token column
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS bill_creation_attempt_token uuid;

-- 2. Replace `claim_order_bill_slot` with attempt-token & valid-bill reuse semantics
DROP FUNCTION IF EXISTS public.claim_order_bill_slot(uuid);

CREATE OR REPLACE FUNCTION public.claim_order_bill_slot(
  p_order_id uuid
)
RETURNS TABLE (
  action text,
  bill_code text,
  bill_url text,
  attempt_token uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.orders;
  v_payment public.payments;
  v_now timestamptz := now();
  v_token uuid;
  v_placeholder text;
  v_has_valid_bill boolean := false;
BEGIN
  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'order_not_found'::text, NULL::text, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  IF v_order.paid_at IS NOT NULL
     OR v_order.status IN ('paid', 'ready_for_pickup', 'handed_over', 'completed') THEN
    RETURN QUERY SELECT 'already_paid'::text, NULL::text, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  IF v_order.status <> 'pending_payment'
     OR (v_order.payment_deadline IS NOT NULL AND v_now >= v_order.payment_deadline) THEN
    RETURN QUERY SELECT 'order_expired'::text, NULL::text, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  -- Existing UNIQUE(payments.order_id) guarantees at most one row per order
  SELECT * INTO v_payment
  FROM public.payments
  WHERE order_id = v_order.id
  FOR UPDATE;

  IF FOUND THEN
    IF v_payment.status IN ('paid', 'late_payment_review') THEN
      RETURN QUERY SELECT 'already_terminal'::text, v_payment.bill_code, v_payment.bill_url, NULL::uuid;
      RETURN;
    END IF;

    v_has_valid_bill := (
      v_payment.bill_creation_state = 'ready'
      AND v_payment.bill_code IS NOT NULL
      AND v_payment.bill_url IS NOT NULL
      AND left(v_payment.bill_code, 9) <> 'creating:'
    );

    -- Reuse an existing valid gateway bill (even after a failed bank attempt on that bill).
    -- Never discard a valid bill_code or create a duplicate gateway bill.
    IF v_has_valid_bill AND v_payment.status IN ('pending', 'failed') THEN
      IF v_payment.status = 'failed' THEN
        UPDATE public.payments
        SET status = 'pending',
            updated_at = v_now
        WHERE id = v_payment.id;
      END IF;
      RETURN QUERY SELECT 'reuse_bill'::text, v_payment.bill_code, v_payment.bill_url, NULL::uuid;
      RETURN;
    END IF;

    IF v_payment.bill_creation_state = 'creating' THEN
      IF v_payment.bill_creation_started_at IS NOT NULL
         AND v_payment.bill_creation_started_at > v_now - interval '30 seconds' THEN
        RETURN QUERY SELECT 'in_progress'::text, NULL::text, NULL::text, NULL::uuid;
        RETURN;
      END IF;

      -- Stale creating lock: transition to ambiguous while keeping attempt_token for safe late recovery
      UPDATE public.payments
      SET bill_creation_state = 'ambiguous',
          updated_at = v_now
      WHERE id = v_payment.id;

      RETURN QUERY SELECT 'ambiguous_hold'::text, NULL::text, NULL::text, NULL::uuid;
      RETURN;
    END IF;

    IF v_payment.bill_creation_state = 'ambiguous' THEN
      RETURN QUERY SELECT 'ambiguous_hold'::text, NULL::text, NULL::text, NULL::uuid;
      RETURN;
    END IF;

    -- Only retry bill creation when prior creation DEFINITELY failed AND no valid gateway bill exists
    IF v_payment.bill_creation_state = 'failed'
       AND (v_payment.bill_code IS NULL OR left(v_payment.bill_code, 9) = 'creating:') THEN
      v_token := gen_random_uuid();
      v_placeholder := 'creating:' || v_order.id::text || ':' || v_token::text;

      UPDATE public.payments
      SET bill_code = v_placeholder,
          bill_url = NULL,
          amount_sen = v_order.total_paid_sen,
          status = 'pending',
          bill_creation_state = 'creating',
          bill_creation_started_at = v_now,
          bill_creation_attempt_token = v_token,
          updated_at = v_now
      WHERE id = v_payment.id;

      RETURN QUERY SELECT 'create_new'::text, v_placeholder, NULL::text, v_token;
      RETURN;
    END IF;

    -- Defensive fallback: never overwrite an unrecognized non-placeholder bill record
    RETURN QUERY SELECT 'ambiguous_hold'::text, v_payment.bill_code, v_payment.bill_url, NULL::uuid;
    RETURN;
  END IF;

  v_token := gen_random_uuid();
  v_placeholder := 'creating:' || v_order.id::text || ':' || v_token::text;

  INSERT INTO public.payments (
    order_id, provider, bill_code, bill_url, amount_sen,
    status, bill_creation_state, bill_creation_started_at, bill_creation_attempt_token
  ) VALUES (
    v_order.id, 'toyyibpay', v_placeholder, NULL, v_order.total_paid_sen,
    'pending', 'creating', v_now, v_token
  );

  RETURN QUERY SELECT 'create_new'::text, v_placeholder, NULL::text, v_token;
END;
$$;

-- 3. Replace `finalize_order_bill_slot` with attempt-token verification & ambiguous recovery
DROP FUNCTION IF EXISTS public.finalize_order_bill_slot(uuid, text, text, text);

CREATE OR REPLACE FUNCTION public.finalize_order_bill_slot(
  p_order_id uuid,
  p_attempt_token uuid,
  p_outcome text,
  p_bill_code text DEFAULT NULL,
  p_bill_url text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := now();
  v_payment public.payments;
BEGIN
  IF p_attempt_token IS NULL THEN
    RETURN 'missing_attempt_token';
  END IF;

  SELECT * INTO v_payment
  FROM public.payments
  WHERE order_id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'missing_slot';
  END IF;

  -- Never overwrite a terminal payment
  IF v_payment.status IN ('paid', 'late_payment_review') THEN
    RETURN 'ignored_terminal';
  END IF;

  -- Reject stale finalization from a superseded or mismatched attempt
  IF v_payment.bill_creation_attempt_token IS DISTINCT FROM p_attempt_token THEN
    RETURN 'stale_attempt';
  END IF;

  -- Safe recovery: verified 'ready' bill response arriving from either 'creating' OR 'ambiguous'
  IF p_outcome = 'ready' AND p_bill_code IS NOT NULL AND p_bill_url IS NOT NULL THEN
    IF v_payment.bill_creation_state NOT IN ('creating', 'ambiguous') THEN
      RETURN 'ignored_state';
    END IF;

    UPDATE public.payments
    SET bill_code = p_bill_code,
        bill_url = p_bill_url,
        status = 'pending',
        bill_creation_state = 'ready',
        bill_creation_attempt_token = NULL,
        updated_at = v_now
    WHERE id = v_payment.id;

    IF v_payment.bill_creation_state = 'ambiguous' THEN
      RETURN 'recovered_ready';
    END IF;
    RETURN 'ready';
  END IF;

  -- Only active 'creating' attempts may transition to 'failed' or 'ambiguous'
  IF v_payment.bill_creation_state <> 'creating' THEN
    RETURN 'ignored_state';
  END IF;

  IF p_outcome = 'failed' THEN
    UPDATE public.payments
    SET status = 'failed',
        bill_creation_state = 'failed',
        bill_creation_attempt_token = NULL,
        updated_at = v_now
    WHERE id = v_payment.id;
    RETURN 'failed';
  END IF;

  -- Ambiguous timeout / network failure: keep attempt_token so a late verified response can recover
  UPDATE public.payments
  SET bill_creation_state = 'ambiguous',
      updated_at = v_now
  WHERE id = v_payment.id;
  RETURN 'ambiguous';
END;
$$;

-- 4. Update `mark_order_payment_failed_atomic` to preserve valid gateway bill (`bill_creation_state = 'ready'`)
CREATE OR REPLACE FUNCTION public.mark_order_payment_failed_atomic(
  p_order_id uuid,
  p_bill_code text,
  p_raw_callback jsonb DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.orders;
  v_payment public.payments;
  v_now timestamptz := now();
BEGIN
  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'order_not_found';
  END IF;

  SELECT * INTO v_payment
  FROM public.payments
  WHERE order_id = v_order.id
    AND bill_code = p_bill_code
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'payment_not_found';
  END IF;

  IF v_order.paid_at IS NOT NULL
     OR v_order.status IN ('paid', 'ready_for_pickup', 'handed_over', 'completed')
     OR v_payment.status IN ('paid', 'late_payment_review') THEN
    RETURN 'ignored_terminal';
  END IF;

  IF v_payment.status <> 'pending' THEN
    RETURN 'already_' || v_payment.status;
  END IF;

  -- Mark payment attempt failed while PRESERVING bill_creation_state='ready', bill_code, and bill_url
  UPDATE public.payments
  SET status = 'failed',
      raw_callback = COALESCE(p_raw_callback, raw_callback),
      updated_at = v_now
  WHERE id = v_payment.id;

  RETURN 'marked_failed';
END;
$$;

REVOKE ALL ON FUNCTION public.claim_order_bill_slot(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_order_bill_slot(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.finalize_order_bill_slot(uuid, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_order_bill_slot(uuid, uuid, text, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.mark_order_payment_failed_atomic(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_order_payment_failed_atomic(uuid, text, jsonb) TO service_role;

COMMIT;

-- =============================================================================
-- ROLLBACK SQL (if ever needed):
--   BEGIN;
--   DROP FUNCTION IF EXISTS public.finalize_order_bill_slot(uuid, uuid, text, text, text);
--   DROP FUNCTION IF EXISTS public.claim_order_bill_slot(uuid);
--   ALTER TABLE public.payments DROP COLUMN IF EXISTS bill_creation_attempt_token;
--   COMMIT;
-- =============================================================================
