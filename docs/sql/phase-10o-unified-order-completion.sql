BEGIN;

-- Phase 10O — Unified product and service order completion.
-- The verification script runs this exact body in a rollback-only transaction.

CREATE OR REPLACE FUNCTION public.is_order_completion_blocked(p_order_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.order_disputes d
    WHERE d.order_id = p_order_id
      AND (lower(COALESCE(d.status, '')) IN ('open', 'under_review')
           OR d.refund_execution_status IN ('pending_execution', 'failed'))
  ) OR EXISTS (
    SELECT 1 FROM public.order_refunds r
    WHERE r.order_id = p_order_id
      AND r.status IN ('pending_execution', 'awaiting_return', 'processing', 'failed', 'reconciliation_required')
  );
$function$;
REVOKE ALL ON FUNCTION public.is_order_completion_blocked(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.verify_order_pickup_pin_atomic(p_order_id uuid, p_pin text)
 RETURNS TABLE(outcome text, order_id uuid, status text, handed_over_at timestamp with time zone, failed_attempts integer, attempts_remaining integer, locked_until timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_order public.orders;
  v_now timestamptz;
  v_clean_pin text;
  v_payment_ok boolean := false;
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

  IF v_order.status = 'disputed' OR public.is_order_completion_blocked(v_order.id) THEN
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
  SET status = 'completed',
      handed_over_at = COALESCE(o.handed_over_at, v_now),
      completed_at = v_now,
      completed_method = 'pickup_pin',
      pickup_pin = NULL,
      pin_failed_attempts = 0,
      pin_locked_until = NULL,
      updated_at = v_now
  WHERE o.id = v_order.id;

  RETURN QUERY SELECT
    'completed'::text, v_order.id, 'completed'::text, COALESCE(v_order.handed_over_at, v_now), 0, v_max_attempts, NULL::timestamptz;
END;
$function$;

REVOKE ALL ON FUNCTION public.verify_order_pickup_pin_atomic(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_order_pickup_pin_atomic(uuid, text) TO authenticated;

-- Only existing handed-over orders can use the prior buyer confirmation.
CREATE OR REPLACE FUNCTION public.confirm_buyer_order_receipt_atomic(p_order_id uuid)
 RETURNS TABLE(outcome text, order_id uuid, status text, completed_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_order public.orders;
  v_now timestamptz;
  v_payment_ok boolean := false;
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

  IF v_order.status = 'disputed' OR public.is_order_completion_blocked(v_order.id) THEN
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
$function$;

REVOKE ALL ON FUNCTION public.confirm_buyer_order_receipt_atomic(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_buyer_order_receipt_atomic(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.reveal_order_completion_pin(p_order_id uuid, p_acknowledged boolean)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_order public.orders;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() OR p_acknowledged IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PIN_REVEAL_NOT_AUTHORIZED' USING ERRCODE = '42501';
  END IF;

  SELECT o.* INTO v_order FROM public.orders o
  WHERE o.id = p_order_id AND o.buyer_id = v_uid AND o.seller_id <> v_uid
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PIN_REVEAL_NOT_AUTHORIZED' USING ERRCODE = '42501';
  END IF;

  IF v_order.status <> 'paid' OR v_order.pickup_pin IS NULL
     OR NOT public.is_order_payment_verified(v_order.id)
     OR public.is_order_completion_blocked(v_order.id) THEN
    RETURN NULL;
  END IF;

  RETURN v_order.pickup_pin;
END;
$function$;
REVOKE ALL ON FUNCTION public.reveal_order_completion_pin(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reveal_order_completion_pin(uuid, boolean) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.get_buyer_order_pickup_pins(uuid[]) FROM PUBLIC, anon, authenticated;

-- The application uses this capability to distinguish the installed lifecycle.
CREATE OR REPLACE FUNCTION public.get_order_completion_mode()
RETURNS text
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
  SELECT 'unified_pin_v1'::text;
$function$;
REVOKE ALL ON FUNCTION public.get_order_completion_mode() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_order_completion_mode() TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
