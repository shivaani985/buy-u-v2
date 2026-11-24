-- =============================================================================
-- Buy-U Phase 6A.1 — Safety-Reviewed Migration Proposal for Orders & Payments
-- STATUS: PROPOSAL ONLY — DO NOT APPLY WITHOUT EXPLICIT OWNER APPROVAL
-- TARGET PROJECT: duwwlcpdidrxkixvflag
--
-- Safety guarantees:
-- 1. Idempotency: unique (buyer_id, seller_id, idempotency_key) on cart orders,
--    existing UNIQUE on offers.order_id, unique payments.bill_code & transaction_ref.
-- 2. Offer checkout reuses the 1-unit reservation held by `accept_offer_atomic`
--    (verifies reserved_quantity >= 1, NEVER double-reserves or double-deducts).
-- 3. ToyyibPay FPX fee: billChargeToCustomer = 1 ("Amount"), billAmount =
--    subtotal_sen + 100 (total_paid_sen) -> zero RM 1.00 double-charge.
-- 4. Payment confirmation requires service_role + exact bill_code + amount_sen
--    match; late verified payments after expiry route to `late_payment_review`
--    without touching stock.
-- =============================================================================

BEGIN;

-- 1. Idempotency, replay-protection & expiry-sweep indexes
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_cart_idempotency
  ON public.orders (buyer_id, seller_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_unique_bill_code
  ON public.payments (bill_code)
  WHERE bill_code IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_unique_transaction_ref
  ON public.payments (transaction_ref)
  WHERE transaction_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_pending_payment_deadline
  ON public.orders (payment_deadline)
  WHERE status = 'pending_payment' AND paid_at IS NULL;

-- 2. Atomic offer -> order creation (reuses existing 30m reservation, no double-reserve)
CREATE OR REPLACE FUNCTION public.create_offer_order_atomic(
  p_offer_id uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS public.orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_offer public.offers;
  v_listing public.listings;
  v_area_name text;
  v_existing public.orders;
  v_order public.orders;
  v_subtotal integer;
  v_fpx integer := 100;
  v_commission integer;
  v_seller_net integer;
  v_order_code text;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  PERFORM public.release_expired_offer_reservations();

  SELECT * INTO v_offer
  FROM public.offers
  WHERE id = p_offer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'OFFER_NOT_FOUND';
  END IF;

  IF v_offer.buyer_id <> v_uid THEN
    RAISE EXCEPTION 'FORBIDDEN_BUYER_ONLY';
  END IF;

  IF v_offer.seller_id = v_uid THEN
    RAISE EXCEPTION 'SELF_PURCHASE_FORBIDDEN';
  END IF;

  -- Idempotent return if already linked to a live pending_payment order
  IF v_offer.order_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.orders WHERE id = v_offer.order_id;
    IF FOUND
       AND v_existing.status = 'pending_payment'
       AND (v_existing.payment_deadline IS NULL OR v_now < v_existing.payment_deadline) THEN
      RETURN v_existing;
    END IF;
    RAISE EXCEPTION 'OFFER_ORDER_ALREADY_TERMINAL';
  END IF;

  IF v_offer.status <> 'accepted'
     OR v_offer.reservation_released_at IS NOT NULL
     OR v_offer.reservation_expires_at IS NULL
     OR v_now >= v_offer.reservation_expires_at THEN
    RAISE EXCEPTION 'OFFER_HOLD_EXPIRED';
  END IF;

  IF public.is_member_blocked_between(v_offer.buyer_id, v_offer.seller_id) THEN
    RAISE EXCEPTION 'MEMBER_BLOCKED';
  END IF;

  SELECT * INTO v_listing
  FROM public.listings
  WHERE id = v_offer.listing_id
  FOR UPDATE;

  IF NOT FOUND OR v_listing.seller_id <> v_offer.seller_id THEN
    RAISE EXCEPTION 'LISTING_OWNER_MISMATCH';
  END IF;

  IF v_listing.status <> 'published' OR v_listing.kind <> 'pre_loved' THEN
    RAISE EXCEPTION 'LISTING_NOT_ELIGIBLE';
  END IF;

  IF v_offer.offer_price_sen < 200 OR v_offer.offer_price_sen > v_listing.price_sen THEN
    RAISE EXCEPTION 'INVALID_OFFER_PRICE';
  END IF;

  -- Confirm the 1-unit reservation held by accept_offer_atomic is intact (no double-reserve)
  IF v_listing.reserved_quantity < 1 OR v_listing.quantity < 1 THEN
    RAISE EXCEPTION 'RESERVATION_INTEGRITY_ERROR';
  END IF;

  SELECT name INTO v_area_name
  FROM public.collection_areas
  WHERE id = v_listing.collection_area_id;

  v_subtotal := v_offer.offer_price_sen;
  v_commission := ROUND(v_subtotal * 0.02)::integer;
  v_seller_net := GREATEST(0, v_subtotal - v_commission);
  v_order_code := 'BU-' || to_char(v_now AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYMM') || '-'
    || upper(substr(md5(gen_random_uuid()::text), 1, 6));

  INSERT INTO public.orders (
    order_code, buyer_id, seller_id, source,
    subtotal_sen, fpx_fee_sen, total_paid_sen, commission_sen, seller_net_sen,
    status, is_food_order, collection_area_name, payment_deadline, idempotency_key
  ) VALUES (
    v_order_code, v_uid, v_offer.seller_id, 'offer',
    v_subtotal, v_fpx, v_subtotal + v_fpx, v_commission, v_seller_net,
    'pending_payment', false, COALESCE(v_area_name, 'UMSKAL Campus'),
    v_offer.reservation_expires_at, p_idempotency_key
  )
  RETURNING * INTO v_order;

  INSERT INTO public.order_items (
    order_id, listing_id, variant_id, title_snapshot, variant_snapshot,
    unit_sen, quantity, image_path, is_food, availability_mode, pickup_note
  ) VALUES (
    v_order.id, v_listing.id, NULL, v_listing.title, NULL,
    v_subtotal, 1, COALESCE(v_listing.image_paths[1], ''), false, 'ready', ''
  );

  UPDATE public.offers
  SET order_id = v_order.id
  WHERE id = v_offer.id;

  RETURN v_order;
END;
$$;

-- 3. Release expired unpaid CART orders (15m payment_deadline) safely & once
CREATE OR REPLACE FUNCTION public.release_expired_cart_orders()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ord RECORD;
  v_item RECORD;
  v_now timestamptz := now();
  v_count integer := 0;
BEGIN
  FOR v_ord IN
    SELECT id
    FROM public.orders
    WHERE source = 'cart'
      AND status = 'pending_payment'
      AND paid_at IS NULL
      AND payment_deadline IS NOT NULL
      AND payment_deadline <= v_now
    FOR UPDATE SKIP LOCKED
  LOOP
    FOR v_item IN
      SELECT listing_id, variant_id, quantity
      FROM public.order_items
      WHERE order_id = v_ord.id
      ORDER BY listing_id, variant_id NULLS FIRST
    LOOP
      IF v_item.variant_id IS NOT NULL THEN
        UPDATE public.listing_variants
        SET reserved_quantity = GREATEST(0, reserved_quantity - v_item.quantity)
        WHERE id = v_item.variant_id;
      END IF;

      UPDATE public.listings
      SET reserved_quantity = GREATEST(0, reserved_quantity - v_item.quantity),
          updated_at = v_now
      WHERE id = v_item.listing_id;
    END LOOP;

    UPDATE public.orders
    SET status = 'expired',
        updated_at = v_now
    WHERE id = v_ord.id
      AND status = 'pending_payment'
      AND paid_at IS NULL;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

-- 4. Atomic payment confirmation (service_role ONLY — invoked ONLY after
--    server-side ToyyibPay `getBillTransactions` verification, NEVER from redirect).
--    Enforces bill_code match, exact amount_sen, replay protection, offer hold
--    integrity, and late-payment reconciliation without overselling.
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
  v_order public.orders;
  v_payment public.payments;
  v_offer public.offers;
  v_item RECORD;
  v_now timestamptz := now();
  v_pin text;
  v_offer_released boolean := false;
BEGIN
  IF p_transaction_ref IS NULL OR length(trim(p_transaction_ref)) = 0 THEN
    RAISE EXCEPTION 'MISSING_TRANSACTION_REF';
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

  IF p_amount_sen <> v_order.total_paid_sen OR p_amount_sen <> v_payment.amount_sen THEN
    RAISE EXCEPTION 'AMOUNT_MISMATCH';
  END IF;

  -- Idempotent repeat callback on already-paid order
  IF v_order.paid_at IS NOT NULL
     OR v_order.status IN ('paid', 'ready_for_pickup', 'handed_over', 'completed') THEN
    RETURN 'already_paid';
  END IF;

  -- Check offer hold integrity when order originated from bargaining
  IF v_order.source = 'offer' THEN
    SELECT * INTO v_offer
    FROM public.offers
    WHERE order_id = v_order.id
    FOR UPDATE;
    IF FOUND AND (
      v_offer.reservation_released_at IS NOT NULL
      OR v_offer.status <> 'accepted'
      OR (v_offer.reservation_expires_at IS NOT NULL AND v_now >= v_offer.reservation_expires_at)
    ) THEN
      v_offer_released := true;
    END IF;
  END IF;

  -- Late-payment after expiry or released hold: DO NOT deduct stock or oversell
  IF v_offer_released
     OR v_order.status IN ('expired', 'cancelled')
     OR (v_order.payment_deadline IS NOT NULL AND v_now >= v_order.payment_deadline) THEN
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

  -- Deduct reserved & total stock atomically in deterministic lock order
  FOR v_item IN
    SELECT listing_id, variant_id, quantity
    FROM public.order_items
    WHERE order_id = v_order.id
    ORDER BY listing_id, variant_id NULLS FIRST
  LOOP
    IF v_item.variant_id IS NOT NULL THEN
      UPDATE public.listing_variants
      SET quantity = GREATEST(0, quantity - v_item.quantity),
          reserved_quantity = GREATEST(0, reserved_quantity - v_item.quantity)
      WHERE id = v_item.variant_id;
    END IF;

    UPDATE public.listings
    SET quantity = GREATEST(0, quantity - v_item.quantity),
        reserved_quantity = GREATEST(0, reserved_quantity - v_item.quantity),
        updated_at = v_now
    WHERE id = v_item.listing_id;
  END LOOP;

  v_pin := lpad((floor(random() * 1000000))::int::text, 6, '0');

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

REVOKE ALL ON FUNCTION public.create_offer_order_atomic(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_offer_order_atomic(uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.release_expired_cart_orders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.release_expired_cart_orders() TO service_role;

REVOKE ALL ON FUNCTION public.confirm_order_payment_atomic(uuid, text, text, integer, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.confirm_order_payment_atomic(uuid, text, text, integer, jsonb) TO service_role;

COMMIT;

-- =============================================================================
-- ROLLBACK PLAN (if ever needed after approval):
--   BEGIN;
--   DROP FUNCTION IF EXISTS public.confirm_order_payment_atomic(uuid, text, text, integer, jsonb);
--   DROP FUNCTION IF EXISTS public.release_expired_cart_orders();
--   DROP FUNCTION IF EXISTS public.create_offer_order_atomic(uuid, text);
--   DROP INDEX IF EXISTS public.idx_orders_pending_payment_deadline;
--   DROP INDEX IF EXISTS public.idx_payments_unique_transaction_ref;
--   DROP INDEX IF EXISTS public.idx_payments_unique_bill_code;
--   DROP INDEX IF EXISTS public.idx_orders_cart_idempotency;
--   ALTER TABLE public.orders DROP COLUMN IF EXISTS idempotency_key;
--   COMMIT;
-- =============================================================================
