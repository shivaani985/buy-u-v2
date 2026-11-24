-- =============================================================================
-- Buy-U Phase 6A — Minimal SQL Migration Proposal for Atomic Orders & Payments
-- STATUS: PROPOSAL ONLY — DO NOT APPLY WITHOUT EXPLICIT OWNER APPROVAL
-- TARGET PROJECT: duwwlcpdidrxkixvflag
--
-- Verified against hosted schema (2026-11-24):
-- - `orders` has: id, order_code, buyer_id, seller_id, source, subtotal_sen,
--   fpx_fee_sen (default 100), total_paid_sen, commission_sen, seller_net_sen,
--   status (default 'pending_payment'), is_food_order, pickup_pin,
--   collection_area_name, payment_deadline, paid_at, created_at, updated_at.
-- - `order_items` has: id, order_id, listing_id, variant_id, title_snapshot,
--   variant_snapshot, unit_sen, quantity, image_path, is_food,
--   availability_mode, pickup_window_start, pickup_note.
-- - `payments` has: id, order_id, provider, bill_code, bill_url,
--   transaction_ref, amount_sen, status, verified_at, raw_callback.
-- - `offers.order_id` already has a UNIQUE constraint.
-- =============================================================================

BEGIN;

-- 1. Idempotency & uniqueness guards (prevent duplicate orders and duplicate bills)
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_cart_idempotency
  ON public.orders (buyer_id, seller_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_unique_bill_code
  ON public.payments (bill_code)
  WHERE bill_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_pending_payment_deadline
  ON public.orders (payment_deadline)
  WHERE status = 'pending_payment' AND paid_at IS NULL;

-- 2. Atomic offer -> order creation (reuses the 1-unit reservation already held
--    by `accept_offer_atomic`; enforces strict 30-minute hold deadline).
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

  -- Release expired holds before validating
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

  -- Idempotent return if order was already linked for this accepted offer
  IF v_offer.order_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.orders WHERE id = v_offer.order_id;
    IF FOUND AND v_existing.status = 'pending_payment'
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

  IF NOT FOUND OR v_listing.status <> 'published' OR v_listing.kind <> 'pre_loved' THEN
    RAISE EXCEPTION 'LISTING_NOT_ELIGIBLE';
  END IF;

  SELECT name INTO v_area_name
  FROM public.collection_areas
  WHERE id = v_listing.collection_area_id;

  v_subtotal := v_offer.offer_price_sen;
  v_commission := ROUND(v_subtotal * 0.02)::integer;
  v_seller_net := GREATEST(0, v_subtotal - v_commission);
  v_order_code := 'BU-' || to_char(v_now AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYMM') || '-'
    || upper(substr(md5(gen_random_uuid()::text), 1, 4));

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
--    Handles idempotent retries and late-payment reconciliation without oversell.
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
  v_item RECORD;
  v_now timestamptz := now();
  v_pin text;
BEGIN
  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;

  IF p_amount_sen <> v_order.total_paid_sen THEN
    RAISE EXCEPTION 'AMOUNT_MISMATCH';
  END IF;

  -- Idempotent repeat callback
  IF v_order.paid_at IS NOT NULL OR v_order.status IN ('paid', 'ready_for_pickup', 'handed_over', 'completed') THEN
    RETURN 'already_paid';
  END IF;

  -- Late-payment after expiry: DO NOT deduct stock or oversell
  IF v_order.status IN ('expired', 'cancelled')
     OR (v_order.payment_deadline IS NOT NULL AND v_now >= v_order.payment_deadline) THEN
    UPDATE public.payments
    SET status = 'late_payment_review',
        transaction_ref = p_transaction_ref,
        verified_at = v_now,
        raw_callback = p_raw_callback,
        updated_at = v_now
    WHERE order_id = v_order.id AND bill_code = p_bill_code;

    RETURN 'late_payment_reconciliation';
  END IF;

  IF v_order.status <> 'pending_payment' THEN
    RAISE EXCEPTION 'ORDER_NOT_PAYABLE';
  END IF;

  -- Deduct reserved & total stock atomically
  FOR v_item IN
    SELECT listing_id, variant_id, quantity
    FROM public.order_items
    WHERE order_id = v_order.id
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
  WHERE order_id = v_order.id AND bill_code = p_bill_code;

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
-- PHASE 6B FOLLOW-UP (AFTER OWNER APPROVAL):
-- 1. Add `create_cart_orders_atomic(p_idempotency_key text)` for multi-seller
--    cart checkout (locks cart_items -> listings/variants, reserves stock for
--    15m, creates 1 pending_payment order per seller, clears purchased cart).
-- 2. Schedule `release_expired_cart_orders()` via pg_cron (`*/2 * * * *`).
-- =============================================================================
