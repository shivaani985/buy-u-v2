-- =============================================================================
-- Buy-U Phase 6B.3 — Gate 1 Payment Security Hardening Migration
-- STATUS: PROPOSAL ONLY — DO NOT APPLY WITHOUT EXPLICIT OWNER APPROVAL
-- TARGET PROJECT: duwwlcpdidrxkixvflag
--
-- Hardens 5 verified findings:
--   1. DB-level Pickup PIN privacy: revokes SELECT on `orders.pickup_pin` from
--      `authenticated`/`anon` (so sellers cannot read PINs via `orders_select_participant`)
--      and provides buyer-only `get_buyer_order_pickup_pins(uuid[])`.
--   2. Raw payment callback privacy: revokes SELECT on `payments.raw_callback`
--      from `authenticated`/`anon`.
--   3. Realtime safety: removes `public.orders` and `public.payments` from
--      `supabase_realtime` publication if present.
--   4. Persistent DB-backed bill-creation coordination (`claim_order_bill_slot` /
--      `finalize_order_bill_slot`) reusing existing `UNIQUE(payments.order_id)`
--      (NO redundant index), preventing duplicate gateway bills across concurrent
--      requests, restarts, and ambiguous gateway timeouts.
--   5. Atomic failed-payment guard (`mark_order_payment_failed_atomic`) preventing
--      delayed/concurrent failed callbacks from overwriting `paid` or
--      `late_payment_review` states.
-- =============================================================================

BEGIN;

-- 1. Column-level SELECT privacy on `public.orders` (exclude `pickup_pin` for authenticated/anon)
REVOKE SELECT ON public.orders FROM authenticated, anon;

GRANT SELECT (
  id,
  order_code,
  buyer_id,
  seller_id,
  source,
  subtotal_sen,
  fpx_fee_sen,
  total_paid_sen,
  commission_sen,
  seller_net_sen,
  status,
  is_food_order,
  collection_area_name,
  pickup_scheduled_at,
  payment_deadline,
  paid_at,
  handed_over_at,
  auto_complete_at,
  completed_at,
  completed_method,
  created_at,
  updated_at,
  pin_failed_attempts,
  pin_locked_until,
  idempotency_key
) ON public.orders TO authenticated;

-- 2. Column-level SELECT privacy on `public.payments` (exclude `raw_callback` for authenticated/anon)
REVOKE SELECT ON public.payments FROM authenticated, anon;

GRANT SELECT (
  id,
  order_id,
  provider,
  bill_code,
  bill_url,
  transaction_ref,
  amount_sen,
  status,
  verified_at,
  created_at,
  updated_at
) ON public.payments TO authenticated;

-- 3. Ensure `orders` and `payments` are NOT exposed over Realtime publication
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'orders'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.orders;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'payments'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.payments;
  END IF;
END;
$$;

-- 4. Buyer-only authorized Pickup PIN retrieval RPC
CREATE OR REPLACE FUNCTION public.get_buyer_order_pickup_pins(
  p_order_ids uuid[]
)
RETURNS TABLE (
  order_id uuid,
  pickup_pin text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;

  IF p_order_ids IS NULL OR cardinality(p_order_ids) = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT o.id AS order_id, o.pickup_pin
    FROM public.orders o
    WHERE o.id = ANY(p_order_ids)
      AND o.buyer_id = v_uid
      AND o.status IN ('paid', 'ready_for_pickup')
      AND o.pickup_pin IS NOT NULL;
END;
$$;

-- 5. Persistent DB-backed bill-creation coordination on existing `UNIQUE(payments.order_id)`
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS bill_creation_state text NOT NULL DEFAULT 'ready',
  ADD COLUMN IF NOT EXISTS bill_creation_started_at timestamptz;

ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_bill_creation_state_check;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_bill_creation_state_check
  CHECK (bill_creation_state IN ('creating', 'ready', 'ambiguous', 'failed'));

CREATE OR REPLACE FUNCTION public.claim_order_bill_slot(
  p_order_id uuid
)
RETURNS TABLE (
  action text,
  bill_code text,
  bill_url text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.orders;
  v_payment public.payments;
  v_now timestamptz := now();
  v_placeholder text;
BEGIN
  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'order_not_found'::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  IF v_order.paid_at IS NOT NULL
     OR v_order.status IN ('paid', 'ready_for_pickup', 'handed_over', 'completed') THEN
    RETURN QUERY SELECT 'already_paid'::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  IF v_order.status <> 'pending_payment'
     OR (v_order.payment_deadline IS NOT NULL AND v_now >= v_order.payment_deadline) THEN
    RETURN QUERY SELECT 'order_expired'::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  -- Existing UNIQUE(payments.order_id) guarantees at most one row per order
  SELECT * INTO v_payment
  FROM public.payments
  WHERE order_id = v_order.id
  FOR UPDATE;

  IF FOUND THEN
    IF v_payment.status IN ('paid', 'late_payment_review') THEN
      RETURN QUERY SELECT 'already_terminal'::text, v_payment.bill_code, v_payment.bill_url;
      RETURN;
    END IF;

    IF v_payment.bill_creation_state = 'ready'
       AND v_payment.status = 'pending'
       AND v_payment.bill_code IS NOT NULL
       AND v_payment.bill_url IS NOT NULL
       AND left(v_payment.bill_code, 9) <> 'creating:' THEN
      RETURN QUERY SELECT 'reuse_bill'::text, v_payment.bill_code, v_payment.bill_url;
      RETURN;
    END IF;

    IF v_payment.bill_creation_state = 'creating' THEN
      IF v_payment.bill_creation_started_at IS NOT NULL
         AND v_payment.bill_creation_started_at > v_now - interval '30 seconds' THEN
        RETURN QUERY SELECT 'in_progress'::text, NULL::text, NULL::text;
        RETURN;
      END IF;

      -- Stale creating lock (e.g., process restart/crash mid-gateway call): NEVER blindly recreate
      UPDATE public.payments
      SET bill_creation_state = 'ambiguous',
          updated_at = v_now
      WHERE id = v_payment.id;

      RETURN QUERY SELECT 'ambiguous_hold'::text, NULL::text, NULL::text;
      RETURN;
    END IF;

    IF v_payment.bill_creation_state = 'ambiguous' THEN
      RETURN QUERY SELECT 'ambiguous_hold'::text, NULL::text, NULL::text;
      RETURN;
    END IF;

    -- Definite prior failure (`status = 'failed'` or `bill_creation_state = 'failed'`): safe to retry
    v_placeholder := 'creating:' || v_order.id::text || ':' || floor(extract(epoch from v_now))::bigint::text;
    UPDATE public.payments
    SET bill_code = v_placeholder,
        bill_url = NULL,
        amount_sen = v_order.total_paid_sen,
        status = 'pending',
        bill_creation_state = 'creating',
        bill_creation_started_at = v_now,
        updated_at = v_now
    WHERE id = v_payment.id;

    RETURN QUERY SELECT 'create_new'::text, v_placeholder, NULL::text;
    RETURN;
  END IF;

  v_placeholder := 'creating:' || v_order.id::text;
  INSERT INTO public.payments (
    order_id, provider, bill_code, bill_url, amount_sen,
    status, bill_creation_state, bill_creation_started_at
  ) VALUES (
    v_order.id, 'toyyibpay', v_placeholder, NULL, v_order.total_paid_sen,
    'pending', 'creating', v_now
  );

  RETURN QUERY SELECT 'create_new'::text, v_placeholder, NULL::text;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_order_bill_slot(
  p_order_id uuid,
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
  SELECT * INTO v_payment
  FROM public.payments
  WHERE order_id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'missing_slot';
  END IF;

  -- Never overwrite a terminal or already-ready payment
  IF v_payment.status IN ('paid', 'late_payment_review')
     OR v_payment.bill_creation_state <> 'creating' THEN
    RETURN 'ignored_state';
  END IF;

  IF p_outcome = 'ready' AND p_bill_code IS NOT NULL AND p_bill_url IS NOT NULL THEN
    UPDATE public.payments
    SET bill_code = p_bill_code,
        bill_url = p_bill_url,
        status = 'pending',
        bill_creation_state = 'ready',
        updated_at = v_now
    WHERE id = v_payment.id;
    RETURN 'ready';
  ELSIF p_outcome = 'failed' THEN
    UPDATE public.payments
    SET status = 'failed',
        bill_creation_state = 'failed',
        updated_at = v_now
    WHERE id = v_payment.id;
    RETURN 'failed';
  ELSE
    -- Ambiguous timeout / network failure: hold slot so we NEVER blindly create duplicate bills
    UPDATE public.payments
    SET bill_creation_state = 'ambiguous',
        updated_at = v_now
    WHERE id = v_payment.id;
    RETURN 'ambiguous';
  END IF;
END;
$$;

-- 6. Atomic failed-payment guard (never overwrites `paid` or `late_payment_review`)
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
  -- Consistent lock order matching confirm_order_payment_atomic: orders -> payments
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

  UPDATE public.payments
  SET status = 'failed',
      bill_creation_state = 'failed',
      raw_callback = COALESCE(p_raw_callback, raw_callback),
      updated_at = v_now
  WHERE id = v_payment.id;

  RETURN 'marked_failed';
END;
$$;

REVOKE ALL ON FUNCTION public.get_buyer_order_pickup_pins(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_buyer_order_pickup_pins(uuid[]) TO authenticated;

REVOKE ALL ON FUNCTION public.claim_order_bill_slot(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_order_bill_slot(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.finalize_order_bill_slot(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_order_bill_slot(uuid, text, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.mark_order_payment_failed_atomic(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_order_payment_failed_atomic(uuid, text, jsonb) TO service_role;

COMMIT;

-- =============================================================================
-- ROLLBACK SQL (if ever needed after approval):
--   BEGIN;
--   DROP FUNCTION IF EXISTS public.mark_order_payment_failed_atomic(uuid, text, jsonb);
--   DROP FUNCTION IF EXISTS public.finalize_order_bill_slot(uuid, text, text, text);
--   DROP FUNCTION IF EXISTS public.claim_order_bill_slot(uuid);
--   DROP FUNCTION IF EXISTS public.get_buyer_order_pickup_pins(uuid[]);
--   ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_bill_creation_state_check;
--   ALTER TABLE public.payments
--     DROP COLUMN IF EXISTS bill_creation_started_at,
--     DROP COLUMN IF EXISTS bill_creation_state;
--   GRANT SELECT ON public.orders TO authenticated;
--   GRANT SELECT ON public.payments TO authenticated;
--   COMMIT;
-- =============================================================================
