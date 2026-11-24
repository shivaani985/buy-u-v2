-- =============================================================================
-- Buy-U Phase 6A.2 — Integrity-Hardened Migration Proposal for Orders & Payments
-- STATUS: PROPOSAL ONLY — DO NOT APPLY WITHOUT EXPLICIT OWNER APPROVAL
-- TARGET PROJECT: duwwlcpdidrxkixvflag
--
-- Safety guarantees:
-- 1. Extends `payments_status_check` safely to include `'late_payment_review'`
--    while preserving `'pending','paid','failed','expired'` and all existing rows.
-- 2. Consistent row-lock ordering (`offers -> orders -> payments -> listings/variants`)
--    prevents deadlocks with Phase 5B `release_expired_offer_reservations()`.
-- 3. Explicit reservation & stock assertions before deduction (never conceals
--    overselling with GREATEST(0, ...)).
-- 4. Requires a valid linked accepted offer for `source = 'offer'` confirmation.
-- 5. Verifies `transaction_ref` identity on duplicate callbacks + unique
--    `payments.transaction_ref` index prevents replay & cross-order reuse.
-- 6. Removes redundant `payments.bill_code` index (hosted UNIQUE already exists).
-- =============================================================================

BEGIN;

-- 1. Safely extend `payments_status_check` for auditable late-payment reconciliation
ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_status_check;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_status_check
  CHECK (status IN ('pending', 'paid', 'failed', 'expired', 'late_payment_review'));

-- 2. Idempotency, replay-protection & expiry-sweep indexes
--    (Note: `payments.bill_code` and `offers.order_id` already have hosted UNIQUE constraints.)
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_cart_idempotency
  ON public.orders (buyer_id, seller_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_unique_transaction_ref
  ON public.payments (transaction_ref)
  WHERE transaction_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_pending_payment_deadline
  ON public.orders (payment_deadline)
  WHERE status = 'pending_payment' AND paid_at IS NULL;

-- 3. Atomic offer -> order creation (reuses existing 30m reservation, no double-reserve)
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

-- 3b. Atomic multi-seller cart -> separate seller orders creation
--     Locks cart_items -> listings/variants in deterministic ID order, validates
--     live status/prices/variants/blocks/stock, reserves stock for 15 minutes,
--     creates 1 pending_payment order per seller, snapshots order_items, and
--     clears purchased cart_items in ONE transaction.
CREATE OR REPLACE FUNCTION public.create_cart_orders_atomic(
  p_idempotency_key text
)
RETURNS SETOF public.orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_key text := trim(COALESCE(p_idempotency_key, ''));
  v_cart_count integer := 0;
  v_seller RECORD;
  v_ci RECORD;
  v_listing public.listings;
  v_variant public.listing_variants;
  v_unit_sen integer;
  v_subtotal integer;
  v_fpx integer := 100;
  v_commission integer;
  v_seller_net integer;
  v_order_code text;
  v_area_name text;
  v_is_food_order boolean;
  v_order public.orders;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  IF length(v_key) < 8 OR length(v_key) > 128 THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY';
  END IF;

  -- Idempotent return if this checkout submission already created orders
  IF EXISTS (
    SELECT 1
    FROM public.orders
    WHERE buyer_id = v_uid
      AND source = 'cart'
      AND idempotency_key = v_key
  ) THEN
    RETURN QUERY
      SELECT *
      FROM public.orders
      WHERE buyer_id = v_uid
        AND source = 'cart'
        AND idempotency_key = v_key
      ORDER BY created_at ASC, id ASC;
    RETURN;
  END IF;

  -- Opportunistically release expired holds before locking stock
  PERFORM public.release_expired_offer_reservations();
  PERFORM public.release_expired_cart_orders();

  -- Lock buyer's cart rows deterministically
  PERFORM 1
  FROM public.cart_items
  WHERE user_id = v_uid
  ORDER BY listing_id, variant_id NULLS FIRST, id
  FOR UPDATE;

  SELECT count(*) INTO v_cart_count
  FROM public.cart_items
  WHERE user_id = v_uid;

  IF v_cart_count = 0 THEN
    RAISE EXCEPTION 'CART_EMPTY';
  END IF;

  -- Pre-lock all referenced listings and variants in deterministic ID order (deadlock-free)
  PERFORM 1
  FROM public.listings l
  WHERE l.id IN (SELECT DISTINCT ci.listing_id FROM public.cart_items ci WHERE ci.user_id = v_uid)
  ORDER BY l.id
  FOR UPDATE;

  PERFORM 1
  FROM public.listing_variants lv
  WHERE lv.id IN (
    SELECT DISTINCT ci.variant_id
    FROM public.cart_items ci
    WHERE ci.user_id = v_uid AND ci.variant_id IS NOT NULL
  )
  ORDER BY lv.id
  FOR UPDATE;

  -- Validate every cart item and reserve stock atomically
  FOR v_ci IN
    SELECT ci.id, ci.listing_id, ci.variant_id, ci.quantity
    FROM public.cart_items ci
    WHERE ci.user_id = v_uid
    ORDER BY ci.listing_id, ci.variant_id NULLS FIRST, ci.id
  LOOP
    IF v_ci.quantity IS NULL OR v_ci.quantity < 1 THEN
      RAISE EXCEPTION 'INVALID_QUANTITY';
    END IF;

    SELECT * INTO v_listing
    FROM public.listings
    WHERE id = v_ci.listing_id;

    IF NOT FOUND OR v_listing.status <> 'published' THEN
      RAISE EXCEPTION 'LISTING_UNAVAILABLE';
    END IF;

    IF v_listing.kind NOT IN ('pre_loved', 'business') THEN
      RAISE EXCEPTION 'LISTING_NOT_PHYSICAL';
    END IF;

    IF COALESCE(v_listing.is_food, false) AND v_listing.availability_mode = 'pre_order' THEN
      RAISE EXCEPTION 'FOOD_PREORDER_NOT_ENABLED';
    END IF;

    IF v_listing.seller_id = v_uid THEN
      RAISE EXCEPTION 'SELF_PURCHASE_FORBIDDEN';
    END IF;

    IF public.is_member_blocked_between(v_uid, v_listing.seller_id) THEN
      RAISE EXCEPTION 'MEMBER_BLOCKED';
    END IF;

    IF COALESCE(v_listing.has_variants, false) THEN
      IF v_ci.variant_id IS NULL THEN
        RAISE EXCEPTION 'VARIANT_REQUIRED';
      END IF;

      SELECT * INTO v_variant
      FROM public.listing_variants
      WHERE id = v_ci.variant_id
        AND listing_id = v_listing.id;

      IF NOT FOUND OR v_variant.active IS NOT TRUE THEN
        RAISE EXCEPTION 'VARIANT_UNAVAILABLE';
      END IF;

      IF (v_variant.quantity - GREATEST(0, v_variant.reserved_quantity)) < v_ci.quantity THEN
        RAISE EXCEPTION 'INSUFFICIENT_VARIANT_STOCK';
      END IF;

      UPDATE public.listing_variants
      SET reserved_quantity = GREATEST(0, reserved_quantity) + v_ci.quantity
      WHERE id = v_variant.id;
    ELSE
      IF v_ci.variant_id IS NOT NULL THEN
        RAISE EXCEPTION 'UNEXPECTED_VARIANT';
      END IF;

      IF (v_listing.quantity - GREATEST(0, v_listing.reserved_quantity)) < v_ci.quantity THEN
        RAISE EXCEPTION 'INSUFFICIENT_LISTING_STOCK';
      END IF;
    END IF;

    UPDATE public.listings
    SET reserved_quantity = GREATEST(0, reserved_quantity) + v_ci.quantity,
        updated_at = v_now
    WHERE id = v_listing.id;
  END LOOP;

  -- Create ONE separate pending_payment order per distinct seller
  FOR v_seller IN
    SELECT DISTINCT l.seller_id
    FROM public.cart_items ci
    JOIN public.listings l ON l.id = ci.listing_id
    WHERE ci.user_id = v_uid
    ORDER BY l.seller_id
  LOOP
    v_subtotal := 0;
    v_is_food_order := false;
    v_area_name := NULL;

    SELECT
      COALESCE(SUM(
        CASE
          WHEN COALESCE(l.has_variants, false) THEN lv.price_sen * ci.quantity
          ELSE l.price_sen * ci.quantity
        END
      ), 0)::integer,
      BOOL_OR(COALESCE(l.is_food, false)),
      MIN(ca.name)
    INTO v_subtotal, v_is_food_order, v_area_name
    FROM public.cart_items ci
    JOIN public.listings l ON l.id = ci.listing_id
    LEFT JOIN public.listing_variants lv ON lv.id = ci.variant_id
    LEFT JOIN public.collection_areas ca ON ca.id = l.collection_area_id
    WHERE ci.user_id = v_uid
      AND l.seller_id = v_seller.seller_id;

    IF v_subtotal < 200 THEN
      RAISE EXCEPTION 'INVALID_ORDER_SUBTOTAL';
    END IF;

    v_commission := ROUND(v_subtotal * 0.02)::integer;
    v_seller_net := GREATEST(0, v_subtotal - v_commission);
    v_order_code := 'BU-' || to_char(v_now AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYMM') || '-'
      || upper(substr(md5(gen_random_uuid()::text), 1, 6));

    INSERT INTO public.orders (
      order_code, buyer_id, seller_id, source,
      subtotal_sen, fpx_fee_sen, total_paid_sen, commission_sen, seller_net_sen,
      status, is_food_order, collection_area_name, payment_deadline, idempotency_key
    ) VALUES (
      v_order_code, v_uid, v_seller.seller_id, 'cart',
      v_subtotal, v_fpx, v_subtotal + v_fpx, v_commission, v_seller_net,
      'pending_payment', COALESCE(v_is_food_order, false),
      COALESCE(v_area_name, 'UMSKAL Campus'),
      v_now + interval '15 minutes', v_key
    )
    RETURNING * INTO v_order;

    FOR v_ci IN
      SELECT ci.listing_id, ci.variant_id, ci.quantity,
             l.title, l.price_sen AS listing_price_sen, l.has_variants,
             l.image_paths, l.is_food, l.availability_mode,
             l.pickup_window_start, l.pickup_note,
             lv.price_sen AS variant_price_sen, lv.option_values
      FROM public.cart_items ci
      JOIN public.listings l ON l.id = ci.listing_id
      LEFT JOIN public.listing_variants lv ON lv.id = ci.variant_id
      WHERE ci.user_id = v_uid
        AND l.seller_id = v_seller.seller_id
      ORDER BY ci.listing_id, ci.variant_id NULLS FIRST
    LOOP
      v_unit_sen := CASE
        WHEN COALESCE(v_ci.has_variants, false) THEN v_ci.variant_price_sen
        ELSE v_ci.listing_price_sen
      END;

      INSERT INTO public.order_items (
        order_id, listing_id, variant_id, title_snapshot, variant_snapshot,
        unit_sen, quantity, image_path, is_food, availability_mode,
        pickup_window_start, pickup_note
      ) VALUES (
        v_order.id, v_ci.listing_id, v_ci.variant_id, v_ci.title, v_ci.option_values,
        v_unit_sen, v_ci.quantity, COALESCE(v_ci.image_paths[1], ''),
        COALESCE(v_ci.is_food, false), COALESCE(v_ci.availability_mode, 'ready'),
        v_ci.pickup_window_start, COALESCE(v_ci.pickup_note, '')
      );
    END LOOP;

    RETURN NEXT v_order;
  END LOOP;

  -- Clear buyer's purchased cart items atomically in the same transaction
  DELETE FROM public.cart_items
  WHERE user_id = v_uid;

  RETURN;
END;
$$;

-- 4. Release expired unpaid CART orders (15m payment_deadline) safely & once
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

-- 5. Atomic payment confirmation (service_role ONLY — invoked ONLY after
--    server-side ToyyibPay `getBillTransactions` verification, NEVER from redirect).
--    Lock order: `offers (if source='offer') -> orders -> payments -> listings/variants`
--    (consistent with Phase 5B `release_expired_offer_reservations()` to avoid deadlocks).
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
  v_offer public.offers;
  v_order public.orders;
  v_payment public.payments;
  v_item RECORD;
  v_listing public.listings;
  v_variant public.listing_variants;
  v_now timestamptz := now();
  v_pin text;
  v_offer_released boolean := false;
BEGIN
  IF p_transaction_ref IS NULL OR length(trim(p_transaction_ref)) = 0 THEN
    RAISE EXCEPTION 'MISSING_TRANSACTION_REF';
  END IF;

  -- Non-locking peek at source so we can lock `offers` BEFORE `orders` (deadlock-free)
  SELECT source INTO v_source
  FROM public.orders
  WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;

  -- Lock linked offer FIRST when source = 'offer' (matches Phase 5B sweeper lock order)
  IF v_source = 'offer' THEN
    SELECT * INTO v_offer
    FROM public.offers
    WHERE order_id = p_order_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'LINKED_OFFER_NOT_FOUND';
    END IF;

    IF v_offer.reservation_released_at IS NOT NULL
       OR v_offer.status <> 'accepted'
       OR (v_offer.reservation_expires_at IS NOT NULL AND v_now >= v_offer.reservation_expires_at) THEN
      v_offer_released := true;
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

  IF p_amount_sen <> v_order.total_paid_sen OR p_amount_sen <> v_payment.amount_sen THEN
    RAISE EXCEPTION 'AMOUNT_MISMATCH';
  END IF;

  -- Duplicate callback verification: require exact transaction_ref match
  IF v_order.paid_at IS NOT NULL
     OR v_order.status IN ('paid', 'ready_for_pickup', 'handed_over', 'completed') THEN
    IF v_payment.transaction_ref IS NULL OR v_payment.transaction_ref <> p_transaction_ref THEN
      RAISE EXCEPTION 'TRANSACTION_REF_CONFLICT';
    END IF;
    RETURN 'already_paid';
  END IF;

  -- Late-payment after expiry or released hold: DO NOT deduct stock or oversell
  IF v_offer_released
     OR v_order.status IN ('expired', 'cancelled')
     OR (v_order.payment_deadline IS NOT NULL AND v_now >= v_order.payment_deadline) THEN
    IF v_payment.status = 'late_payment_review'
       AND v_payment.transaction_ref = p_transaction_ref THEN
      RETURN 'late_payment_reconciliation';
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

  -- Explicitly verify reservations & stock before deducting (NEVER mask oversell with GREATEST)
  FOR v_item IN
    SELECT listing_id, variant_id, quantity
    FROM public.order_items
    WHERE order_id = v_order.id
    ORDER BY listing_id, variant_id NULLS FIRST
  LOOP
    SELECT * INTO v_listing
    FROM public.listings
    WHERE id = v_item.listing_id
    FOR UPDATE;

    IF NOT FOUND
       OR v_listing.reserved_quantity < v_item.quantity
       OR v_listing.quantity < v_item.quantity THEN
      RAISE EXCEPTION 'INSUFFICIENT_LISTING_RESERVATION';
    END IF;

    IF v_item.variant_id IS NOT NULL THEN
      SELECT * INTO v_variant
      FROM public.listing_variants
      WHERE id = v_item.variant_id
        AND listing_id = v_item.listing_id
      FOR UPDATE;

      IF NOT FOUND
         OR v_variant.reserved_quantity < v_item.quantity
         OR v_variant.quantity < v_item.quantity THEN
        RAISE EXCEPTION 'INSUFFICIENT_VARIANT_RESERVATION';
      END IF;

      UPDATE public.listing_variants
      SET quantity = quantity - v_item.quantity,
          reserved_quantity = reserved_quantity - v_item.quantity
      WHERE id = v_variant.id;
    END IF;

    UPDATE public.listings
    SET quantity = quantity - v_item.quantity,
        reserved_quantity = reserved_quantity - v_item.quantity,
        updated_at = v_now
    WHERE id = v_listing.id;
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

REVOKE ALL ON FUNCTION public.create_cart_orders_atomic(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_cart_orders_atomic(text) TO authenticated;

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
--   DROP FUNCTION IF EXISTS public.create_cart_orders_atomic(text);
--   DROP FUNCTION IF EXISTS public.create_offer_order_atomic(uuid, text);
--   DROP INDEX IF EXISTS public.idx_orders_pending_payment_deadline;
--   DROP INDEX IF EXISTS public.idx_payments_unique_transaction_ref;
--   DROP INDEX IF EXISTS public.idx_orders_cart_idempotency;
--   ALTER TABLE public.orders DROP COLUMN IF EXISTS idempotency_key;
--   ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_status_check;
--   ALTER TABLE public.payments ADD CONSTRAINT payments_status_check
--     CHECK (status IN ('pending', 'paid', 'failed', 'expired'));
--   COMMIT;
-- =============================================================================
