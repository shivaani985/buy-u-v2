-- =============================================================================
-- Buy-U Phase 6C — Campus Pickup, Handover & Order Completion Migration
-- STATUS: PROPOSAL ONLY — DO NOT APPLY WITHOUT EXPLICIT OWNER APPROVAL
-- TARGET PROJECT: duwwlcpdidrxkixvflag
--
-- Safety & Integrity Guarantees:
--   1. Cryptographically secure 6-digit Pickup PIN generation (`generate_secure_pickup_pin`)
--      using PostgreSQL core CSPRNG `gen_random_uuid()` with unbiased rejection sampling.
--      Updates `confirm_checkout_payment_atomic` and `confirm_order_payment_atomic`
--      for future orders while preserving all existing valid PINs on paid QA orders.
--   2. Atomic Seller PIN Verification (`verify_order_pickup_pin_atomic`):
--      `paid` / `ready_for_pickup` -> `handed_over`.
--      - Verifies authenticated active seller ownership, verified payment proof
--        (parent `checkout_sessions` OR legacy `payments`), no active dispute,
--        and eligible status.
--      - Persistent rate limiting: 5 failed attempts -> 15-minute lockout
--        (`pin_failed_attempts`, `pin_locked_until`) persisted by returning
--        structured outcomes instead of rolling back via `RAISE EXCEPTION`.
--      - Consumes `pickup_pin = NULL` on successful handover and records
--        `handed_over_at`. Never returns or logs `pickup_pin`.
--   3. Atomic Buyer Receipt Confirmation (`confirm_buyer_order_receipt_atomic`):
--      `handed_over` -> `completed`.
--      - Verifies authenticated active buyer ownership, verified payment proof,
--        no active dispute, and prior verified handover (`handed_over_at IS NOT NULL`).
--      - Records `completed_at` and `completed_method = 'pickup_pin'`.
--      - Unified child seller orders complete independently.
--      - No automatic completion cron job is added.
--   4. Preserves DB-level `pickup_pin` column REVOKE, Realtime exclusion, and
--      buyer-only `get_buyer_order_pickup_pins` (hardened with `o.paid_at IS NOT NULL`).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Cryptographically secure 6-digit Pickup PIN generator (internal helper)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_secure_pickup_pin()
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_raw bigint;
BEGIN
  -- Rejection sampling over 31 random bits from CSPRNG-backed gen_random_uuid()
  -- (first 8 hex chars of UUIDv4 are pure random bits) for uniform [0, 999999].
  LOOP
    v_raw := (('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint) & 2147483647;
    EXIT WHEN v_raw < 2147000000;
  END LOOP;
  RETURN lpad((v_raw % 1000000)::text, 6, '0');
END;
$$;

REVOKE ALL ON FUNCTION public.generate_secure_pickup_pin() FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. Harden buyer-only Pickup PIN retrieval (require paid_at IS NOT NULL)
-- -----------------------------------------------------------------------------
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
      AND o.paid_at IS NOT NULL
      AND o.status IN ('paid', 'ready_for_pickup')
      AND o.pickup_pin IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.get_buyer_order_pickup_pins(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_buyer_order_pickup_pins(uuid[]) TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. Atomic Seller Pickup PIN Verification (paid -> handed_over)
--    Returns structured row so failed attempts & 15-min lockout PERSIST.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.verify_order_pickup_pin_atomic(uuid, text);

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
  v_has_active_dispute boolean := false;
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

  -- Lock target order row exclusively to prevent concurrent PIN brute-force / duplicate handover
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

  -- Duplicate / already completed protection
  IF v_order.status = 'handed_over' THEN
    RETURN QUERY SELECT
      'already_handed_over'::text,
      v_order.id,
      v_order.status,
      v_order.handed_over_at,
      COALESCE(v_order.pin_failed_attempts, 0),
      v_max_attempts,
      NULL::timestamptz;
    RETURN;
  END IF;

  IF v_order.status IN ('completed', 'settled') THEN
    RETURN QUERY SELECT
      'already_completed'::text,
      v_order.id,
      v_order.status,
      v_order.handed_over_at,
      0,
      v_max_attempts,
      NULL::timestamptz;
    RETURN;
  END IF;

  -- Block disputed orders (status or open dispute record)
  SELECT EXISTS (
    SELECT 1
    FROM public.order_disputes d
    WHERE d.order_id = v_order.id
      AND lower(COALESCE(d.status, '')) NOT IN ('cancelled', 'dismissed', 'closed_rejected')
  ) INTO v_has_active_dispute;

  IF v_order.status = 'disputed' OR v_has_active_dispute THEN
    RETURN QUERY SELECT
      'order_disputed'::text,
      v_order.id,
      v_order.status,
      v_order.handed_over_at,
      COALESCE(v_order.pin_failed_attempts, 0),
      GREATEST(0, v_max_attempts - COALESCE(v_order.pin_failed_attempts, 0)),
      v_order.pin_locked_until;
    RETURN;
  END IF;

  -- Only eligible paid orders may transition to handed_over
  IF v_order.status NOT IN ('paid', 'ready_for_pickup') THEN
    RETURN QUERY SELECT
      'invalid_status'::text,
      v_order.id,
      v_order.status,
      v_order.handed_over_at,
      COALESCE(v_order.pin_failed_attempts, 0),
      GREATEST(0, v_max_attempts - COALESCE(v_order.pin_failed_attempts, 0)),
      v_order.pin_locked_until;
    RETURN;
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
    RETURN QUERY SELECT
      'payment_unverified'::text,
      v_order.id,
      v_order.status,
      v_order.handed_over_at,
      COALESCE(v_order.pin_failed_attempts, 0),
      GREATEST(0, v_max_attempts - COALESCE(v_order.pin_failed_attempts, 0)),
      v_order.pin_locked_until;
    RETURN;
  END IF;

  IF v_order.pickup_pin IS NULL OR length(trim(v_order.pickup_pin)) <> 6 THEN
    RETURN QUERY SELECT
      'pin_unavailable'::text,
      v_order.id,
      v_order.status,
      v_order.handed_over_at,
      COALESCE(v_order.pin_failed_attempts, 0),
      GREATEST(0, v_max_attempts - COALESCE(v_order.pin_failed_attempts, 0)),
      v_order.pin_locked_until;
    RETURN;
  END IF;

  -- Persistent rate-limit lockout check
  IF v_order.pin_locked_until IS NOT NULL AND v_now < v_order.pin_locked_until THEN
    RETURN QUERY SELECT
      'locked'::text,
      v_order.id,
      v_order.status,
      v_order.handed_over_at,
      COALESCE(v_order.pin_failed_attempts, v_max_attempts),
      0,
      v_order.pin_locked_until;
    RETURN;
  END IF;

  -- Reset attempt counter window once a previous 15-minute lockout has elapsed
  IF v_order.pin_locked_until IS NOT NULL AND v_now >= v_order.pin_locked_until THEN
    v_base_attempts := 0;
  ELSE
    v_base_attempts := GREATEST(0, COALESCE(v_order.pin_failed_attempts, 0));
  END IF;

  v_clean_pin := trim(COALESCE(p_pin, ''));
  IF v_clean_pin !~ '^[0-9]{6}$' THEN
    RETURN QUERY SELECT
      'invalid_pin_format'::text,
      v_order.id,
      v_order.status,
      v_order.handed_over_at,
      v_base_attempts,
      GREATEST(0, v_max_attempts - v_base_attempts),
      NULL::timestamptz;
    RETURN;
  END IF;

  -- Digest comparison (pg_catalog.sha256) to avoid direct plaintext comparison timing hints
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
      v_order.id,
      v_order.status,
      v_order.handed_over_at,
      v_new_attempts,
      GREATEST(0, v_max_attempts - v_new_attempts),
      v_locked_until;
    RETURN;
  END IF;

  -- Valid PIN -> atomic handover & single-use PIN consumption
  UPDATE public.orders o
  SET status = 'handed_over',
      handed_over_at = v_now,
      pickup_pin = NULL,
      pin_failed_attempts = 0,
      pin_locked_until = NULL,
      updated_at = v_now
  WHERE o.id = v_order.id;

  RETURN QUERY SELECT
    'handed_over'::text,
    v_order.id,
    'handed_over'::text,
    v_now,
    0,
    v_max_attempts,
    NULL::timestamptz;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_order_pickup_pin_atomic(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_order_pickup_pin_atomic(uuid, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 4. Atomic Buyer Receipt Confirmation (handed_over -> completed)
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.confirm_buyer_order_receipt_atomic(uuid);

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
  v_has_active_dispute boolean := false;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;

  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;

  -- Lock order row exclusively to prevent concurrent duplicate completion
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

  IF v_order.status IN ('completed', 'settled') THEN
    RETURN QUERY SELECT
      'already_completed'::text,
      v_order.id,
      v_order.status,
      v_order.completed_at;
    RETURN;
  END IF;

  -- Block disputed orders (status or open dispute record)
  SELECT EXISTS (
    SELECT 1
    FROM public.order_disputes d
    WHERE d.order_id = v_order.id
      AND lower(COALESCE(d.status, '')) NOT IN ('cancelled', 'dismissed', 'closed_rejected')
  ) INTO v_has_active_dispute;

  IF v_order.status = 'disputed' OR v_has_active_dispute THEN
    RETURN QUERY SELECT
      'order_disputed'::text,
      v_order.id,
      v_order.status,
      v_order.completed_at;
    RETURN;
  END IF;

  -- Strict lifecycle: ONLY after verified handover (`handed_over` + `handed_over_at`)
  IF v_order.status <> 'handed_over' OR v_order.handed_over_at IS NULL THEN
    RETURN QUERY SELECT
      'invalid_status'::text,
      v_order.id,
      v_order.status,
      v_order.completed_at;
    RETURN;
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
    RETURN QUERY SELECT
      'payment_unverified'::text,
      v_order.id,
      v_order.status,
      v_order.completed_at;
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
    'completed'::text,
    v_order.id,
    'completed'::text,
    v_now;
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_buyer_order_receipt_atomic(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_buyer_order_receipt_atomic(uuid) TO authenticated;

-- -----------------------------------------------------------------------------
-- 5. Upgrade future Pickup PIN generation in `confirm_checkout_payment_atomic`
--    and `confirm_order_payment_atomic` to use `generate_secure_pickup_pin()`
--    (preserves all Phase 6B.4 invariants & existing valid PINs on paid orders)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.confirm_checkout_payment_atomic(
  p_checkout_session_id uuid,
  p_bill_code text,
  p_transaction_ref text,
  p_amount_sen integer,
  p_raw_callback jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_source text;
  v_offer public.offers;
  v_session public.checkout_sessions;
  v_child_ord RECORD;
  v_item RECORD;
  v_listing public.listings;
  v_variant public.listing_variants;
  v_now timestamptz;
  v_pin text;
  v_offer_released boolean := false;
  v_total_children integer := 0;
  v_invalid_children integer := 0;
  v_child_subtotal_sum integer := 0;
  v_items_total_sum integer := 0;
BEGIN
  IF p_bill_code IS NULL OR length(trim(p_bill_code)) = 0 THEN
    RAISE EXCEPTION 'MISSING_BILL_CODE';
  END IF;

  IF p_transaction_ref IS NULL OR length(trim(p_transaction_ref)) = 0 THEN
    RAISE EXCEPTION 'MISSING_TRANSACTION_REF';
  END IF;

  IF p_amount_sen IS NULL OR p_amount_sen <= 0 THEN
    RAISE EXCEPTION 'AMOUNT_MISMATCH';
  END IF;

  SELECT source INTO v_source
  FROM public.checkout_sessions
  WHERE id = p_checkout_session_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CHECKOUT_NOT_FOUND';
  END IF;

  IF v_source = 'offer' THEN
    SELECT o.* INTO v_offer
    FROM public.offers o
    JOIN public.orders ord ON ord.id = o.order_id
    WHERE ord.checkout_session_id = p_checkout_session_id
    FOR UPDATE OF o;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'LINKED_OFFER_NOT_FOUND';
    END IF;
  END IF;

  SELECT * INTO v_session
  FROM public.checkout_sessions
  WHERE id = p_checkout_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CHECKOUT_NOT_FOUND';
  END IF;

  v_now := clock_timestamp();

  IF v_source = 'offer' THEN
    IF v_offer.reservation_released_at IS NOT NULL
       OR v_offer.status <> 'accepted'
       OR (v_offer.reservation_expires_at IS NOT NULL AND v_now >= v_offer.reservation_expires_at) THEN
      v_offer_released := true;
    END IF;
  END IF;

  IF v_session.bill_creation_state <> 'ready'
     OR v_session.bill_code IS NULL
     OR left(v_session.bill_code, 9) = 'creating:'
     OR v_session.bill_code <> p_bill_code THEN
    RAISE EXCEPTION 'PAYMENT_BILL_NOT_READY';
  END IF;

  IF p_amount_sen <> v_session.total_paid_sen
     OR v_session.total_paid_sen <> (v_session.combined_subtotal_sen + v_session.fpx_fee_sen) THEN
    RAISE EXCEPTION 'AMOUNT_MISMATCH';
  END IF;

  INSERT INTO public.payment_transaction_registry (transaction_ref, owner_kind, owner_id)
  VALUES (p_transaction_ref, 'checkout_session', v_session.id)
  ON CONFLICT (transaction_ref) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
    FROM public.payment_transaction_registry
    WHERE transaction_ref = p_transaction_ref
      AND owner_kind = 'checkout_session'
      AND owner_id = v_session.id
  ) THEN
    RAISE EXCEPTION 'TRANSACTION_REF_REUSED' USING ERRCODE = '23505';
  END IF;

  IF v_session.paid_at IS NOT NULL OR v_session.status = 'paid' THEN
    IF v_session.transaction_ref IS NULL OR v_session.transaction_ref <> p_transaction_ref THEN
      RAISE EXCEPTION 'TRANSACTION_REF_CONFLICT';
    END IF;
    RETURN 'already_paid';
  END IF;

  IF v_offer_released
     OR v_session.status IN ('expired', 'cancelled')
     OR v_now >= v_session.payment_deadline THEN
    IF v_session.payment_status = 'late_payment_review' THEN
      IF v_session.transaction_ref = p_transaction_ref THEN
        RETURN 'late_payment_reconciliation';
      END IF;
      RAISE EXCEPTION 'LATE_PAYMENT_TRANSACTION_REF_CONFLICT';
    END IF;

    UPDATE public.checkout_sessions
    SET payment_status = 'late_payment_review',
        transaction_ref = p_transaction_ref,
        verified_at = v_now,
        raw_callback = p_raw_callback,
        updated_at = v_now
    WHERE id = v_session.id;

    RETURN 'late_payment_reconciliation';
  END IF;

  IF v_session.status <> 'pending_payment' THEN
    RAISE EXCEPTION 'CHECKOUT_NOT_PAYABLE';
  END IF;

  PERFORM 1
  FROM public.orders
  WHERE checkout_session_id = v_session.id
  ORDER BY id
  FOR UPDATE;

  SELECT
    count(*)::integer,
    count(*) FILTER (
      WHERE status <> 'pending_payment'
         OR paid_at IS NOT NULL
         OR buyer_id <> v_session.buyer_id
         OR source <> v_session.source
         OR fpx_fee_sen <> 0
         OR total_paid_sen <> subtotal_sen
    )::integer,
    COALESCE(SUM(subtotal_sen), 0)::integer
  INTO v_total_children, v_invalid_children, v_child_subtotal_sum
  FROM public.orders
  WHERE checkout_session_id = v_session.id;

  IF v_total_children = 0 OR v_invalid_children > 0 THEN
    RAISE EXCEPTION 'CHECKOUT_CHILD_ORDERS_INVALID';
  END IF;

  IF v_child_subtotal_sum <> v_session.combined_subtotal_sen THEN
    RAISE EXCEPTION 'CHECKOUT_SUBTOTAL_MISMATCH';
  END IF;

  SELECT COALESCE(SUM(oi.unit_sen * oi.quantity), 0)::integer
  INTO v_items_total_sum
  FROM public.order_items oi
  JOIN public.orders ord ON ord.id = oi.order_id
  WHERE ord.checkout_session_id = v_session.id;

  IF v_items_total_sum <> v_session.combined_subtotal_sen THEN
    RAISE EXCEPTION 'CHECKOUT_ITEMS_TOTAL_MISMATCH';
  END IF;

  PERFORM 1
  FROM public.listings l
  WHERE l.id IN (
    SELECT DISTINCT oi.listing_id
    FROM public.order_items oi
    JOIN public.orders ord ON ord.id = oi.order_id
    WHERE ord.checkout_session_id = v_session.id
  )
  ORDER BY l.id
  FOR UPDATE;

  PERFORM 1
  FROM public.listing_variants lv
  WHERE lv.id IN (
    SELECT DISTINCT oi.variant_id
    FROM public.order_items oi
    JOIN public.orders ord ON ord.id = oi.order_id
    WHERE ord.checkout_session_id = v_session.id
      AND oi.variant_id IS NOT NULL
  )
  ORDER BY lv.id
  FOR UPDATE;

  v_now := clock_timestamp();
  IF v_now >= v_session.payment_deadline
     OR (v_source = 'offer' AND v_offer.reservation_expires_at IS NOT NULL AND v_now >= v_offer.reservation_expires_at) THEN
    UPDATE public.checkout_sessions
    SET payment_status = 'late_payment_review',
        transaction_ref = p_transaction_ref,
        verified_at = v_now,
        raw_callback = p_raw_callback,
        updated_at = v_now
    WHERE id = v_session.id;

    RETURN 'late_payment_reconciliation';
  END IF;

  FOR v_item IN
    SELECT oi.listing_id, oi.variant_id, oi.quantity
    FROM public.order_items oi
    JOIN public.orders ord ON ord.id = oi.order_id
    WHERE ord.checkout_session_id = v_session.id
    ORDER BY oi.listing_id, oi.variant_id NULLS FIRST, oi.id
  LOOP
    SELECT * INTO v_listing
    FROM public.listings
    WHERE id = v_item.listing_id;

    IF NOT FOUND
       OR v_listing.reserved_quantity < v_item.quantity
       OR v_listing.quantity < v_item.quantity THEN
      RAISE EXCEPTION 'INSUFFICIENT_LISTING_RESERVATION';
    END IF;

    IF v_item.variant_id IS NOT NULL THEN
      SELECT * INTO v_variant
      FROM public.listing_variants
      WHERE id = v_item.variant_id
        AND listing_id = v_item.listing_id;

      IF NOT FOUND
         OR v_variant.reserved_quantity < v_item.quantity
         OR v_variant.quantity < v_item.quantity THEN
        RAISE EXCEPTION 'INSUFFICIENT_VARIANT_RESERVATION';
      END IF;
    END IF;

    UPDATE public.listings
    SET quantity = quantity - v_item.quantity,
        reserved_quantity = reserved_quantity - v_item.quantity,
        updated_at = v_now
    WHERE id = v_listing.id;

    IF v_item.variant_id IS NOT NULL THEN
      UPDATE public.listing_variants
      SET quantity = quantity - v_item.quantity,
          reserved_quantity = reserved_quantity - v_item.quantity
      WHERE id = v_variant.id;
    END IF;
  END LOOP;

  UPDATE public.checkout_sessions
  SET status = 'paid',
      payment_status = 'paid',
      paid_at = v_now,
      transaction_ref = p_transaction_ref,
      verified_at = v_now,
      raw_callback = p_raw_callback,
      bill_creation_attempt_token = NULL,
      updated_at = v_now
  WHERE id = v_session.id;

  FOR v_child_ord IN
    SELECT id
    FROM public.orders
    WHERE checkout_session_id = v_session.id
    ORDER BY id
  LOOP
    v_pin := public.generate_secure_pickup_pin();
    UPDATE public.orders
    SET status = 'paid',
        paid_at = v_now,
        pickup_pin = COALESCE(pickup_pin, v_pin),
        updated_at = v_now
    WHERE id = v_child_ord.id;
  END LOOP;

  RETURN 'confirmed_paid';
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_checkout_payment_atomic(uuid, text, text, integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_checkout_payment_atomic(uuid, text, text, integer, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.confirm_order_payment_atomic(
  p_order_id uuid,
  p_bill_code text,
  p_transaction_ref text,
  p_amount_sen integer,
  p_raw_callback jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_source text;
  v_checkout_session_id uuid;
  v_offer public.offers;
  v_order public.orders;
  v_payment public.payments;
  v_item RECORD;
  v_listing public.listings;
  v_variant public.listing_variants;
  v_now timestamptz;
  v_pin text;
  v_offer_released boolean := false;
BEGIN
  IF p_bill_code IS NULL OR length(trim(p_bill_code)) = 0 THEN
    RAISE EXCEPTION 'MISSING_BILL_CODE';
  END IF;

  IF p_transaction_ref IS NULL OR length(trim(p_transaction_ref)) = 0 THEN
    RAISE EXCEPTION 'MISSING_TRANSACTION_REF';
  END IF;

  IF p_amount_sen IS NULL OR p_amount_sen <= 0 THEN
    RAISE EXCEPTION 'AMOUNT_MISMATCH';
  END IF;

  SELECT source, checkout_session_id INTO v_source, v_checkout_session_id
  FROM public.orders
  WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;

  IF v_checkout_session_id IS NOT NULL THEN
    RAISE EXCEPTION 'UNIFIED_CHECKOUT_USE_SESSION_RPC';
  END IF;

  IF v_source = 'offer' THEN
    SELECT * INTO v_offer
    FROM public.offers
    WHERE order_id = p_order_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'LINKED_OFFER_NOT_FOUND';
    END IF;
  END IF;

  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;

  SELECT * INTO v_payment
  FROM public.payments
  WHERE order_id = v_order.id
    AND bill_code = p_bill_code
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_BILL_NOT_FOUND';
  END IF;

  v_now := clock_timestamp();

  IF v_source = 'offer' THEN
    IF v_offer.reservation_released_at IS NOT NULL
       OR v_offer.status <> 'accepted'
       OR (v_offer.reservation_expires_at IS NOT NULL AND v_now >= v_offer.reservation_expires_at) THEN
      v_offer_released := true;
    END IF;
  END IF;

  IF p_amount_sen <> v_order.total_paid_sen OR p_amount_sen <> v_payment.amount_sen THEN
    RAISE EXCEPTION 'AMOUNT_MISMATCH';
  END IF;

  INSERT INTO public.payment_transaction_registry (transaction_ref, owner_kind, owner_id)
  VALUES (p_transaction_ref, 'legacy_payment', v_order.id)
  ON CONFLICT (transaction_ref) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
    FROM public.payment_transaction_registry
    WHERE transaction_ref = p_transaction_ref
      AND owner_kind = 'legacy_payment'
      AND owner_id = v_order.id
  ) THEN
    RAISE EXCEPTION 'TRANSACTION_REF_REUSED' USING ERRCODE = '23505';
  END IF;

  IF v_order.paid_at IS NOT NULL
     OR v_order.status IN ('paid', 'ready_for_pickup', 'handed_over', 'completed') THEN
    IF v_payment.transaction_ref IS NULL OR v_payment.transaction_ref <> p_transaction_ref THEN
      RAISE EXCEPTION 'TRANSACTION_REF_CONFLICT';
    END IF;
    RETURN 'already_paid';
  END IF;

  IF v_offer_released
     OR v_order.status IN ('expired', 'cancelled')
     OR (v_order.payment_deadline IS NOT NULL AND v_now >= v_order.payment_deadline) THEN
    IF v_payment.status = 'late_payment_review' THEN
      IF v_payment.transaction_ref = p_transaction_ref THEN
        RETURN 'late_payment_reconciliation';
      END IF;
      RAISE EXCEPTION 'LATE_PAYMENT_TRANSACTION_REF_CONFLICT';
    END IF;

    UPDATE public.payments
    SET status = 'late_payment_review',
        transaction_ref = p_transaction_ref,
        verified_at = v_now,
        raw_callback = p_raw_callback,
        updated_at = v_now
    WHERE id = v_payment.id;

    RETURN 'late_payment_reconciliation';
  END IF;

  IF v_order.status <> 'pending_payment' THEN
    RAISE EXCEPTION 'ORDER_NOT_PAYABLE';
  END IF;

  PERFORM 1
  FROM public.listings l
  WHERE l.id IN (SELECT DISTINCT oi.listing_id FROM public.order_items oi WHERE oi.order_id = v_order.id)
  ORDER BY l.id
  FOR UPDATE;

  PERFORM 1
  FROM public.listing_variants lv
  WHERE lv.id IN (
    SELECT DISTINCT oi.variant_id FROM public.order_items oi
    WHERE oi.order_id = v_order.id AND oi.variant_id IS NOT NULL
  )
  ORDER BY lv.id
  FOR UPDATE;

  v_now := clock_timestamp();
  IF (v_order.payment_deadline IS NOT NULL AND v_now >= v_order.payment_deadline)
     OR (v_source = 'offer' AND v_offer.reservation_expires_at IS NOT NULL AND v_now >= v_offer.reservation_expires_at) THEN
    UPDATE public.payments
    SET status = 'late_payment_review',
        transaction_ref = p_transaction_ref,
        verified_at = v_now,
        raw_callback = p_raw_callback,
        updated_at = v_now
    WHERE id = v_payment.id;

    RETURN 'late_payment_reconciliation';
  END IF;

  FOR v_item IN
    SELECT listing_id, variant_id, quantity
    FROM public.order_items
    WHERE order_id = v_order.id
    ORDER BY listing_id, variant_id NULLS FIRST
  LOOP
    SELECT * INTO v_listing FROM public.listings WHERE id = v_item.listing_id;
    IF NOT FOUND OR v_listing.reserved_quantity < v_item.quantity OR v_listing.quantity < v_item.quantity THEN
      RAISE EXCEPTION 'INSUFFICIENT_LISTING_RESERVATION';
    END IF;

    IF v_item.variant_id IS NOT NULL THEN
      SELECT * INTO v_variant
      FROM public.listing_variants
      WHERE id = v_item.variant_id AND listing_id = v_item.listing_id;
      IF NOT FOUND OR v_variant.reserved_quantity < v_item.quantity OR v_variant.quantity < v_item.quantity THEN
        RAISE EXCEPTION 'INSUFFICIENT_VARIANT_RESERVATION';
      END IF;
    END IF;

    UPDATE public.listings
    SET quantity = quantity - v_item.quantity,
        reserved_quantity = reserved_quantity - v_item.quantity,
        updated_at = v_now
    WHERE id = v_listing.id;

    IF v_item.variant_id IS NOT NULL THEN
      UPDATE public.listing_variants
      SET quantity = quantity - v_item.quantity,
          reserved_quantity = reserved_quantity - v_item.quantity
      WHERE id = v_variant.id;
    END IF;
  END LOOP;

  v_pin := public.generate_secure_pickup_pin();

  UPDATE public.orders
  SET status = 'paid',
      paid_at = v_now,
      pickup_pin = COALESCE(pickup_pin, v_pin),
      updated_at = v_now
  WHERE id = v_order.id;

  UPDATE public.payments
  SET status = 'paid',
      transaction_ref = p_transaction_ref,
      verified_at = v_now,
      raw_callback = p_raw_callback,
      updated_at = v_now
  WHERE id = v_payment.id;

  RETURN 'confirmed_paid';
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_order_payment_atomic(uuid, text, text, integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_order_payment_atomic(uuid, text, text, integer, jsonb) TO service_role;

-- -----------------------------------------------------------------------------
-- 6. Re-affirm DB-level Pickup PIN privacy (never exposed via SELECT or Realtime)
-- -----------------------------------------------------------------------------
REVOKE SELECT (pickup_pin) ON public.orders FROM authenticated, anon;

COMMIT;

-- =============================================================================
-- ROLLBACK NOTES (manual, only if needed before Phase 6C UI cutover):
--   DROP FUNCTION IF EXISTS public.verify_order_pickup_pin_atomic(uuid, text);
--   DROP FUNCTION IF EXISTS public.confirm_buyer_order_receipt_atomic(uuid);
--   (Keep `generate_secure_pickup_pin()` and `get_buyer_order_pickup_pins`.)
-- =============================================================================
