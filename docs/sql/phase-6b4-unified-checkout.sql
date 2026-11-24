-- =============================================================================
-- Buy-U Phase 6B.4 — Unified Multi-Seller Checkout Migration (Safety-Hardened)
-- STATUS: PROPOSAL ONLY — DO NOT APPLY WITHOUT EXPLICIT OWNER APPROVAL
-- TARGET PROJECT: duwwlcpdidrxkixvflag
--
-- Safety & Integrity Guarantees:
--   1. One Checkout (`public.checkout_sessions`) = One ToyyibPay Bill = One
--      RM 1.00 FPX Fee = N Independent Internal Seller Orders (`public.orders`).
--   2. Retires `authenticated` access to legacy `create_cart_orders_atomic` and
--      `create_offer_order_atomic` while preserving legacy bill verification,
--      retry, and reconciliation RPCs for historical `checkout_session_id IS NULL` rows.
--   3. Concurrency-safe cross-table `transaction_ref` uniqueness via shared
--      `public.payment_transaction_registry` (backfilled with historical refs).
--   4. Authenticated checkout creation RPCs return ONLY explicitly safe columns
--      (never exposing `raw_callback` or `bill_creation_attempt_token`).
--   5. Zero global expiry sweeps inside checkout creation transactions; consistent
--      lock ordering (`offers -> checkout_sessions -> orders -> listings -> variants`),
--      exact stock release (no `GREATEST(0, ...)`), and post-lock deadline revalidation.
--   6. Strict all-or-nothing pre-confirmation checks (bill readiness, non-null exact
--      amount, all child orders pending/unpaid/same buyer/same source, subtotal sum
--      & order_items total match).
--   7. Protects `late_payment_review` from conflicting `transaction_ref` overwrites
--      and preserves `expired` state during delayed bill finalization.
-- =============================================================================

BEGIN;

-- 1. Shared atomic transaction_ref uniqueness registry across legacy `payments` & `checkout_sessions`
CREATE TABLE IF NOT EXISTS public.payment_transaction_registry (
  transaction_ref text PRIMARY KEY,
  owner_kind      text NOT NULL CHECK (owner_kind IN ('legacy_payment', 'checkout_session')),
  owner_id        uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.payment_transaction_registry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payment_transaction_registry FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.payment_transaction_registry TO service_role;

-- Backfill all existing historical payment transaction_refs (preserves BU-2611-0DB3, BU-2611-3CB12A, etc.)
INSERT INTO public.payment_transaction_registry (transaction_ref, owner_kind, owner_id)
SELECT p.transaction_ref, 'legacy_payment', p.order_id
FROM public.payments p
WHERE p.transaction_ref IS NOT NULL
  AND length(trim(p.transaction_ref)) > 0
ON CONFLICT (transaction_ref) DO NOTHING;

-- 2. Parent `public.checkout_sessions` table (one consolidated gateway bill per checkout)
CREATE TABLE IF NOT EXISTS public.checkout_sessions (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_code               text NOT NULL UNIQUE,
  buyer_id                    uuid NOT NULL REFERENCES public.profiles(id),
  source                      text NOT NULL CHECK (source IN ('cart', 'offer')),
  idempotency_key             text NOT NULL,
  combined_subtotal_sen       integer NOT NULL CHECK (combined_subtotal_sen >= 200),
  fpx_fee_sen                 integer NOT NULL DEFAULT 100 CHECK (fpx_fee_sen = 100),
  total_paid_sen              integer NOT NULL CHECK (total_paid_sen = combined_subtotal_sen + fpx_fee_sen),
  status                      text NOT NULL DEFAULT 'pending_payment'
                                CHECK (status IN ('pending_payment', 'paid', 'expired', 'cancelled')),
  payment_deadline            timestamptz NOT NULL,
  paid_at                     timestamptz,
  provider                    text NOT NULL DEFAULT 'toyyibpay',
  bill_code                   text UNIQUE,
  bill_url                    text,
  bill_creation_state         text NOT NULL DEFAULT 'not_started'
                                CHECK (bill_creation_state IN ('not_started', 'creating', 'ready', 'ambiguous', 'failed')),
  bill_creation_started_at    timestamptz,
  bill_creation_attempt_token uuid,
  payment_status              text NOT NULL DEFAULT 'pending'
                                CHECK (payment_status IN ('pending', 'paid', 'failed', 'expired', 'late_payment_review')),
  transaction_ref             text,
  verified_at                 timestamptz,
  raw_callback                jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (buyer_id, source, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_sessions_unique_tx_ref
  ON public.checkout_sessions (transaction_ref)
  WHERE transaction_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_checkout_sessions_pending_deadline
  ON public.checkout_sessions (payment_deadline)
  WHERE status = 'pending_payment' AND paid_at IS NULL;

-- Buyer-only RLS & column-level privilege privacy on `public.checkout_sessions`
ALTER TABLE public.checkout_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS checkout_sessions_select_buyer ON public.checkout_sessions;
CREATE POLICY checkout_sessions_select_buyer
  ON public.checkout_sessions
  FOR SELECT
  TO authenticated
  USING (auth.uid() = buyer_id);

REVOKE ALL ON public.checkout_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT (
  id,
  checkout_code,
  buyer_id,
  source,
  idempotency_key,
  combined_subtotal_sen,
  fpx_fee_sen,
  total_paid_sen,
  status,
  payment_deadline,
  paid_at,
  provider,
  bill_code,
  bill_url,
  bill_creation_state,
  payment_status,
  transaction_ref,
  verified_at,
  created_at,
  updated_at
) ON public.checkout_sessions TO authenticated;
GRANT ALL ON public.checkout_sessions TO service_role;

-- 3. Additive link on `public.orders` (legacy orders keep `checkout_session_id IS NULL`)
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS checkout_session_id uuid REFERENCES public.checkout_sessions(id);

CREATE INDEX IF NOT EXISTS idx_orders_checkout_session_id
  ON public.orders (checkout_session_id)
  WHERE checkout_session_id IS NOT NULL;

-- Grant SELECT on the new non-sensitive FK column to authenticated (preserving pickup_pin revoke!)
GRANT SELECT (checkout_session_id) ON public.orders TO authenticated;

-- 4. Unified atomic multi-seller cart checkout (returns ONLY explicitly safe columns;
--    NO global expiry sweeps inside checkout transaction — handled by pg_cron Jobs 1 & 2)
DROP FUNCTION IF EXISTS public.create_cart_checkout_atomic(text);

CREATE OR REPLACE FUNCTION public.create_cart_checkout_atomic(
  p_idempotency_key text
)
RETURNS TABLE (
  id                    uuid,
  checkout_code         text,
  source                text,
  combined_subtotal_sen integer,
  fpx_fee_sen           integer,
  total_paid_sen        integer,
  status                text,
  payment_deadline      timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_key text := trim(COALESCE(p_idempotency_key, ''));
  v_existing public.checkout_sessions;
  v_session public.checkout_sessions;
  v_cart_item_ids uuid[];
  v_seller RECORD;
  v_seller_status text;
  v_ci RECORD;
  v_listing public.listings;
  v_variant public.listing_variants;
  v_unit_sen integer;
  v_combined_subtotal integer := 0;
  v_subtotal integer;
  v_fpx integer := 100;
  v_commission integer;
  v_seller_net integer;
  v_checkout_code text;
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

  -- Serialize concurrent cart checkout submissions for the same buyer before table locks
  PERFORM pg_advisory_xact_lock(hashtextextended('buyu_cart_checkout:' || v_uid::text, 0));

  -- Fast idempotent return (explicitly safe fields only)
  SELECT * INTO v_existing
  FROM public.checkout_sessions cs
  WHERE cs.buyer_id = v_uid
    AND cs.source = 'cart'
    AND cs.idempotency_key = v_key;
  IF FOUND THEN
    RETURN QUERY SELECT
      v_existing.id, v_existing.checkout_code, v_existing.source,
      v_existing.combined_subtotal_sen, v_existing.fpx_fee_sen,
      v_existing.total_paid_sen, v_existing.status, v_existing.payment_deadline;
    RETURN;
  END IF;

  -- Lock & snapshot exact buyer cart item IDs (concurrent additions preserved untouched)
  SELECT array_agg(locked.id ORDER BY locked.listing_id, locked.variant_id NULLS FIRST, locked.id)
  INTO v_cart_item_ids
  FROM (
    SELECT ci.id, ci.listing_id, ci.variant_id
    FROM public.cart_items ci
    WHERE ci.user_id = v_uid
    ORDER BY ci.listing_id, ci.variant_id NULLS FIRST, ci.id
    FOR UPDATE
  ) AS locked;

  -- Recheck idempotency after acquiring checkout locks
  SELECT * INTO v_existing
  FROM public.checkout_sessions cs
  WHERE cs.buyer_id = v_uid
    AND cs.source = 'cart'
    AND cs.idempotency_key = v_key;
  IF FOUND THEN
    RETURN QUERY SELECT
      v_existing.id, v_existing.checkout_code, v_existing.source,
      v_existing.combined_subtotal_sen, v_existing.fpx_fee_sen,
      v_existing.total_paid_sen, v_existing.status, v_existing.payment_deadline;
    RETURN;
  END IF;

  IF v_cart_item_ids IS NULL OR cardinality(v_cart_item_ids) = 0 THEN
    RAISE EXCEPTION 'CART_EMPTY';
  END IF;

  -- Pre-lock ALL listings BEFORE variants in deterministic ID order (deadlock-free)
  PERFORM 1
  FROM public.listings l
  WHERE l.id IN (
    SELECT DISTINCT ci.listing_id
    FROM public.cart_items ci
    WHERE ci.id = ANY(v_cart_item_ids)
  )
  ORDER BY l.id
  FOR UPDATE;

  PERFORM 1
  FROM public.listing_variants lv
  WHERE lv.id IN (
    SELECT DISTINCT ci.variant_id
    FROM public.cart_items ci
    WHERE ci.id = ANY(v_cart_item_ids)
      AND ci.variant_id IS NOT NULL
  )
  ORDER BY lv.id
  FOR UPDATE;

  -- Refresh wall-clock timestamp after lock acquisition
  v_now := clock_timestamp();

  -- Validate every snapshotted cart item, reserve stock, and accumulate combined subtotal
  FOR v_ci IN
    SELECT ci.id, ci.listing_id, ci.variant_id, ci.quantity
    FROM public.cart_items ci
    WHERE ci.id = ANY(v_cart_item_ids)
    ORDER BY ci.listing_id, ci.variant_id NULLS FIRST, ci.id
  LOOP
    IF v_ci.quantity IS NULL OR v_ci.quantity < 1 THEN
      RAISE EXCEPTION 'INVALID_QUANTITY';
    END IF;

    SELECT l.* INTO v_listing
    FROM public.listings l
    WHERE l.id = v_ci.listing_id;

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

    SELECT p.status INTO v_seller_status
    FROM public.profiles p
    WHERE p.id = v_listing.seller_id;

    IF COALESCE(lower(v_seller_status), '') <> 'active' THEN
      RAISE EXCEPTION 'SELLER_NOT_ACTIVE';
    END IF;

    IF public.is_member_blocked_between(v_uid, v_listing.seller_id) THEN
      RAISE EXCEPTION 'MEMBER_BLOCKED';
    END IF;

    IF v_listing.reserved_quantity < 0 OR (v_listing.quantity - v_listing.reserved_quantity) < v_ci.quantity THEN
      RAISE EXCEPTION 'INSUFFICIENT_LISTING_STOCK';
    END IF;

    IF COALESCE(v_listing.has_variants, false) THEN
      IF v_ci.variant_id IS NULL THEN
        RAISE EXCEPTION 'VARIANT_REQUIRED';
      END IF;

      SELECT lv.* INTO v_variant
      FROM public.listing_variants lv
      WHERE lv.id = v_ci.variant_id
        AND lv.listing_id = v_listing.id;

      IF NOT FOUND OR v_variant.active IS NOT TRUE THEN
        RAISE EXCEPTION 'VARIANT_UNAVAILABLE';
      END IF;

      IF v_variant.reserved_quantity < 0 OR (v_variant.quantity - v_variant.reserved_quantity) < v_ci.quantity THEN
        RAISE EXCEPTION 'INSUFFICIENT_VARIANT_STOCK';
      END IF;

      v_unit_sen := v_variant.price_sen;
    ELSE
      IF v_ci.variant_id IS NOT NULL THEN
        RAISE EXCEPTION 'UNEXPECTED_VARIANT';
      END IF;
      v_unit_sen := v_listing.price_sen;
    END IF;

    v_combined_subtotal := v_combined_subtotal + (v_unit_sen * v_ci.quantity);

    UPDATE public.listings l
    SET reserved_quantity = l.reserved_quantity + v_ci.quantity,
        updated_at = v_now
    WHERE l.id = v_listing.id;

    IF COALESCE(v_listing.has_variants, false) THEN
      UPDATE public.listing_variants lv
      SET reserved_quantity = lv.reserved_quantity + v_ci.quantity
      WHERE lv.id = v_variant.id;
    END IF;
  END LOOP;

  IF v_combined_subtotal < 200 THEN
    RAISE EXCEPTION 'INVALID_ORDER_SUBTOTAL';
  END IF;

  -- Create ONE parent checkout session with ONE RM 1.00 FPX fee
  v_checkout_code := 'CHK-' || to_char(v_now AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYMM') || '-'
    || upper(substr(md5(gen_random_uuid()::text), 1, 6));

  INSERT INTO public.checkout_sessions (
    checkout_code, buyer_id, source, idempotency_key,
    combined_subtotal_sen, fpx_fee_sen, total_paid_sen,
    status, payment_deadline
  ) VALUES (
    v_checkout_code, v_uid, 'cart', v_key,
    v_combined_subtotal, v_fpx, v_combined_subtotal + v_fpx,
    'pending_payment', v_now + interval '15 minutes'
  )
  RETURNING * INTO v_session;

  -- Create ONE separate internal seller order per distinct seller (`fpx_fee_sen = 0`)
  FOR v_seller IN
    SELECT DISTINCT l.seller_id
    FROM public.cart_items ci
    JOIN public.listings l ON l.id = ci.listing_id
    WHERE ci.id = ANY(v_cart_item_ids)
    ORDER BY l.seller_id
  LOOP
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
    WHERE ci.id = ANY(v_cart_item_ids)
      AND l.seller_id = v_seller.seller_id;

    IF v_subtotal < 200 THEN
      RAISE EXCEPTION 'INVALID_ORDER_SUBTOTAL';
    END IF;

    v_commission := ROUND(v_subtotal * 0.02)::integer;
    v_seller_net := GREATEST(0, v_subtotal - v_commission);
    v_order_code := 'BU-' || to_char(v_now AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYMM') || '-'
      || upper(substr(md5(gen_random_uuid()::text), 1, 6));

    INSERT INTO public.orders (
      order_code, buyer_id, seller_id, source, checkout_session_id,
      subtotal_sen, fpx_fee_sen, total_paid_sen, commission_sen, seller_net_sen,
      status, is_food_order, collection_area_name, payment_deadline, idempotency_key
    ) VALUES (
      v_order_code, v_uid, v_seller.seller_id, 'cart', v_session.id,
      v_subtotal, 0, v_subtotal, v_commission, v_seller_net,
      'pending_payment', COALESCE(v_is_food_order, false),
      COALESCE(v_area_name, 'UMSKAL Campus'),
      v_session.payment_deadline, v_key
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
      WHERE ci.id = ANY(v_cart_item_ids)
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
  END LOOP;

  -- Delete ONLY snapshotted cart items
  DELETE FROM public.cart_items ci
  WHERE ci.user_id = v_uid
    AND ci.id = ANY(v_cart_item_ids);

  RETURN QUERY SELECT
    v_session.id, v_session.checkout_code, v_session.source,
    v_session.combined_subtotal_sen, v_session.fpx_fee_sen,
    v_session.total_paid_sen, v_session.status, v_session.payment_deadline;
END;
$$;

-- 5. Unified accepted-offer checkout (returns ONLY explicitly safe columns;
--    NO global expiry sweep; strict post-lock deadline revalidation)
DROP FUNCTION IF EXISTS public.create_offer_checkout_atomic(uuid, text);

CREATE OR REPLACE FUNCTION public.create_offer_checkout_atomic(
  p_offer_id uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS TABLE (
  id                    uuid,
  checkout_code         text,
  source                text,
  combined_subtotal_sen integer,
  fpx_fee_sen           integer,
  total_paid_sen        integer,
  status                text,
  payment_deadline      timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_now timestamptz;
  v_key text := trim(COALESCE(p_idempotency_key, 'offer-' || p_offer_id::text));
  v_offer public.offers;
  v_listing public.listings;
  v_seller_status text;
  v_area_name text;
  v_existing_order public.orders;
  v_session public.checkout_sessions;
  v_order public.orders;
  v_subtotal integer;
  v_fpx integer := 100;
  v_commission integer;
  v_seller_net integer;
  v_checkout_code text;
  v_order_code text;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  -- Lock order: offers -> checkout_sessions -> orders -> listings
  SELECT o.* INTO v_offer
  FROM public.offers o
  WHERE o.id = p_offer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'OFFER_NOT_FOUND';
  END IF;

  -- Post-lock wall-clock timestamp for authoritative deadline revalidation
  v_now := clock_timestamp();

  IF v_offer.buyer_id <> v_uid THEN
    RAISE EXCEPTION 'FORBIDDEN_BUYER_ONLY';
  END IF;

  IF v_offer.seller_id = v_uid THEN
    RAISE EXCEPTION 'SELF_PURCHASE_FORBIDDEN';
  END IF;

  -- Idempotent return if already linked to a live pending_payment checkout_session
  IF v_offer.order_id IS NOT NULL THEN
    SELECT ord.* INTO v_existing_order
    FROM public.orders ord
    WHERE ord.id = v_offer.order_id;
    IF FOUND AND v_existing_order.checkout_session_id IS NOT NULL THEN
      SELECT cs.* INTO v_session
      FROM public.checkout_sessions cs
      WHERE cs.id = v_existing_order.checkout_session_id
      FOR UPDATE;
      v_now := clock_timestamp();
      IF FOUND
         AND v_session.status = 'pending_payment'
         AND v_now < v_session.payment_deadline THEN
        RETURN QUERY SELECT
          v_session.id, v_session.checkout_code, v_session.source,
          v_session.combined_subtotal_sen, v_session.fpx_fee_sen,
          v_session.total_paid_sen, v_session.status, v_session.payment_deadline;
        RETURN;
      END IF;
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

  SELECT p.status INTO v_seller_status
  FROM public.profiles p
  WHERE p.id = v_offer.seller_id;

  IF COALESCE(lower(v_seller_status), '') <> 'active' THEN
    RAISE EXCEPTION 'SELLER_NOT_ACTIVE';
  END IF;

  SELECT l.* INTO v_listing
  FROM public.listings l
  WHERE l.id = v_offer.listing_id
  FOR UPDATE;

  -- Revalidate offer hold deadline using wall clock after acquiring listing lock
  v_now := clock_timestamp();
  IF v_now >= v_offer.reservation_expires_at THEN
    RAISE EXCEPTION 'OFFER_HOLD_EXPIRED';
  END IF;

  IF NOT FOUND OR v_listing.seller_id <> v_offer.seller_id THEN
    RAISE EXCEPTION 'LISTING_OWNER_MISMATCH';
  END IF;

  IF v_listing.status <> 'published' OR v_listing.kind <> 'pre_loved' THEN
    RAISE EXCEPTION 'LISTING_NOT_ELIGIBLE';
  END IF;

  IF v_offer.offer_price_sen < 200 OR v_offer.offer_price_sen > v_listing.price_sen THEN
    RAISE EXCEPTION 'INVALID_OFFER_PRICE';
  END IF;

  -- Reuse existing 1-unit Phase 5B hold without double-reserving
  IF v_listing.reserved_quantity < 1 OR v_listing.quantity < 1 THEN
    RAISE EXCEPTION 'RESERVATION_INTEGRITY_ERROR';
  END IF;

  SELECT ca.name INTO v_area_name
  FROM public.collection_areas ca
  WHERE ca.id = v_listing.collection_area_id;

  v_subtotal := v_offer.offer_price_sen;
  v_commission := ROUND(v_subtotal * 0.02)::integer;
  v_seller_net := GREATEST(0, v_subtotal - v_commission);
  v_checkout_code := 'CHK-' || to_char(v_now AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYMM') || '-'
    || upper(substr(md5(gen_random_uuid()::text), 1, 6));
  v_order_code := 'BU-' || to_char(v_now AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYMM') || '-'
    || upper(substr(md5(gen_random_uuid()::text), 1, 6));

  INSERT INTO public.checkout_sessions (
    checkout_code, buyer_id, source, idempotency_key,
    combined_subtotal_sen, fpx_fee_sen, total_paid_sen,
    status, payment_deadline
  ) VALUES (
    v_checkout_code, v_uid, 'offer', v_key,
    v_subtotal, v_fpx, v_subtotal + v_fpx,
    'pending_payment', v_offer.reservation_expires_at
  )
  RETURNING * INTO v_session;

  INSERT INTO public.orders (
    order_code, buyer_id, seller_id, source, checkout_session_id,
    subtotal_sen, fpx_fee_sen, total_paid_sen, commission_sen, seller_net_sen,
    status, is_food_order, collection_area_name, payment_deadline, idempotency_key
  ) VALUES (
    v_order_code, v_uid, v_offer.seller_id, 'offer', v_session.id,
    v_subtotal, 0, v_subtotal, v_commission, v_seller_net,
    'pending_payment', false, COALESCE(v_area_name, 'UMSKAL Campus'),
    v_offer.reservation_expires_at, v_key
  )
  RETURNING * INTO v_order;

  INSERT INTO public.order_items (
    order_id, listing_id, variant_id, title_snapshot, variant_snapshot,
    unit_sen, quantity, image_path, is_food, availability_mode, pickup_note
  ) VALUES (
    v_order.id, v_listing.id, NULL, v_listing.title, NULL,
    v_subtotal, 1, COALESCE(v_listing.image_paths[1], ''), false, 'ready', ''
  );

  UPDATE public.offers o
  SET order_id = v_order.id
  WHERE o.id = v_offer.id;

  RETURN QUERY SELECT
    v_session.id, v_session.checkout_code, v_session.source,
    v_session.combined_subtotal_sen, v_session.fpx_fee_sen,
    v_session.total_paid_sen, v_session.status, v_session.payment_deadline;
END;
$$;

-- 6. Persistent attempt-token bill coordination on `public.checkout_sessions`
--    Preserves `expired` state if a delayed bill finalization arrives after expiry!
CREATE OR REPLACE FUNCTION public.claim_checkout_bill_slot(
  p_checkout_session_id uuid
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
  v_session public.checkout_sessions;
  v_now timestamptz;
  v_token uuid;
  v_placeholder text;
  v_has_valid_bill boolean := false;
BEGIN
  SELECT cs.* INTO v_session
  FROM public.checkout_sessions cs
  WHERE cs.id = p_checkout_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'checkout_not_found'::text, NULL::text, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  -- Post-lock wall-clock deadline revalidation
  v_now := clock_timestamp();

  IF v_session.paid_at IS NOT NULL OR v_session.status = 'paid' THEN
    RETURN QUERY SELECT 'already_paid'::text, v_session.bill_code, v_session.bill_url, NULL::uuid;
    RETURN;
  END IF;

  IF v_session.payment_status IN ('paid', 'late_payment_review') THEN
    RETURN QUERY SELECT 'already_terminal'::text, v_session.bill_code, v_session.bill_url, NULL::uuid;
    RETURN;
  END IF;

  IF v_session.status <> 'pending_payment' OR v_now >= v_session.payment_deadline THEN
    RETURN QUERY SELECT 'checkout_expired'::text, NULL::text, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  v_has_valid_bill := (
    v_session.bill_creation_state = 'ready'
    AND v_session.bill_code IS NOT NULL
    AND v_session.bill_url IS NOT NULL
    AND left(v_session.bill_code, 9) <> 'creating:'
  );

  -- Reuse existing valid ToyyibPay bill (including after failed FPX bank attempt)
  IF v_has_valid_bill AND v_session.payment_status IN ('pending', 'failed') THEN
    IF v_session.payment_status = 'failed' THEN
      UPDATE public.checkout_sessions cs
      SET payment_status = 'pending',
          updated_at = v_now
      WHERE cs.id = v_session.id;
    END IF;
    RETURN QUERY SELECT 'reuse_bill'::text, v_session.bill_code, v_session.bill_url, NULL::uuid;
    RETURN;
  END IF;

  IF v_session.bill_creation_state = 'creating' THEN
    IF v_session.bill_creation_started_at IS NOT NULL
       AND v_session.bill_creation_started_at > v_now - interval '30 seconds' THEN
      RETURN QUERY SELECT 'in_progress'::text, NULL::text, NULL::text, NULL::uuid;
      RETURN;
    END IF;

    UPDATE public.checkout_sessions cs
    SET bill_creation_state = 'ambiguous',
        updated_at = v_now
    WHERE cs.id = v_session.id;

    RETURN QUERY SELECT 'ambiguous_hold'::text, NULL::text, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  IF v_session.bill_creation_state = 'ambiguous' THEN
    RETURN QUERY SELECT 'ambiguous_hold'::text, NULL::text, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  IF v_session.bill_creation_state IN ('not_started', 'failed')
     AND (v_session.bill_code IS NULL OR left(v_session.bill_code, 9) = 'creating:') THEN
    v_token := gen_random_uuid();
    -- Independent random placeholder: NEVER embed private attempt_token in buyer-readable bill_code
    v_placeholder := 'creating:' || gen_random_uuid()::text;

    UPDATE public.checkout_sessions cs
    SET bill_code = v_placeholder,
        bill_url = NULL,
        payment_status = 'pending',
        bill_creation_state = 'creating',
        bill_creation_started_at = v_now,
        bill_creation_attempt_token = v_token,
        updated_at = v_now
    WHERE cs.id = v_session.id;

    RETURN QUERY SELECT 'create_new'::text, v_placeholder, NULL::text, v_token;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'ambiguous_hold'::text, v_session.bill_code, v_session.bill_url, NULL::uuid;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_checkout_bill_slot(
  p_checkout_session_id uuid,
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
  v_now timestamptz;
  v_session public.checkout_sessions;
  v_is_expired boolean := false;
BEGIN
  IF p_attempt_token IS NULL THEN
    RETURN 'missing_attempt_token';
  END IF;

  SELECT * INTO v_session
  FROM public.checkout_sessions
  WHERE id = p_checkout_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'missing_slot';
  END IF;

  v_now := clock_timestamp();

  IF v_session.status = 'paid'
     OR v_session.payment_status IN ('paid', 'late_payment_review') THEN
    RETURN 'ignored_terminal';
  END IF;

  IF v_session.bill_creation_attempt_token IS DISTINCT FROM p_attempt_token THEN
    RETURN 'stale_attempt';
  END IF;

  v_is_expired := (
    v_session.status IN ('expired', 'cancelled')
    OR v_session.payment_status = 'expired'
    OR v_now >= v_session.payment_deadline
  );

  IF p_outcome = 'ready' AND p_bill_code IS NOT NULL AND p_bill_url IS NOT NULL THEN
    IF v_session.bill_creation_state NOT IN ('creating', 'ambiguous') THEN
      RETURN 'ignored_state';
    END IF;

    -- Record the real bill_code for reconciliation while STRICTLY preserving expired/cancelled state
    UPDATE public.checkout_sessions
    SET bill_code = p_bill_code,
        bill_url = p_bill_url,
        payment_status = CASE WHEN v_is_expired THEN 'expired' ELSE 'pending' END,
        bill_creation_state = 'ready',
        bill_creation_attempt_token = NULL,
        updated_at = v_now
    WHERE id = v_session.id;

    IF v_is_expired THEN
      RETURN 'recorded_expired';
    END IF;
    IF v_session.bill_creation_state = 'ambiguous' THEN
      RETURN 'recovered_ready';
    END IF;
    RETURN 'ready';
  END IF;

  IF v_is_expired THEN
    RETURN 'ignored_terminal';
  END IF;

  IF v_session.bill_creation_state <> 'creating' THEN
    RETURN 'ignored_state';
  END IF;

  IF p_outcome = 'failed' THEN
    UPDATE public.checkout_sessions
    SET payment_status = 'failed',
        bill_creation_state = 'failed',
        bill_creation_attempt_token = NULL,
        updated_at = v_now
    WHERE id = v_session.id;
    RETURN 'failed';
  END IF;

  UPDATE public.checkout_sessions
  SET bill_creation_state = 'ambiguous',
      updated_at = v_now
  WHERE id = v_session.id;
  RETURN 'ambiguous';
END;
$$;

-- 7. Atomic consolidated payment confirmation (ALL-OR-NOTHING across all child orders;
--    atomic cross-table transaction_ref registry; strict child & subtotal invariants;
--    late_payment_review conflict protection)
--    Lock order: offers (if offer) -> checkout_sessions -> child orders (ORDER BY id)
--                -> listings (ORDER BY id) -> listing_variants (ORDER BY id).
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

  -- Non-locking peek so `offers` is locked BEFORE `checkout_sessions`/`orders` (deadlock-free with Job 1)
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

  -- Refresh wall clock AFTER acquiring all parent locks
  v_now := clock_timestamp();

  IF v_source = 'offer' THEN
    IF v_offer.reservation_released_at IS NOT NULL
       OR v_offer.status <> 'accepted'
       OR (v_offer.reservation_expires_at IS NOT NULL AND v_now >= v_offer.reservation_expires_at) THEN
      v_offer_released := true;
    END IF;
  END IF;

  -- Validate bill readiness & exact bill_code match
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

  -- Atomic cross-table `transaction_ref` claim (concurrency-safe via PRIMARY KEY)
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

  -- Duplicate callback check on already-paid checkout
  IF v_session.paid_at IS NOT NULL OR v_session.status = 'paid' THEN
    IF v_session.transaction_ref IS NULL OR v_session.transaction_ref <> p_transaction_ref THEN
      RAISE EXCEPTION 'TRANSACTION_REF_CONFLICT';
    END IF;
    RETURN 'already_paid';
  END IF;

  -- Late payment after expiry/released hold -> reconciliation ONLY (never overwrite prior late_payment_review ref!)
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

  -- Lock ALL child seller orders deterministically and validate EVERY child invariant
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

  -- Pre-lock ALL listings BEFORE variants across all child orders (deadlock-free)
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

  -- Final post-inventory-lock wall-clock deadline recheck BEFORE deducting stock
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

  -- Verify & deduct stock across EVERY child order (all-or-nothing inside this single TX)
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

  -- Mark parent checkout session PAID
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

  -- Mark EVERY child seller order PAID with its own independent 6-digit Pickup PIN
  FOR v_child_ord IN
    SELECT id
    FROM public.orders
    WHERE checkout_session_id = v_session.id
    ORDER BY id
  LOOP
    v_pin := lpad((floor(random() * 1000000))::int::text, 6, '0');
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

-- 8. Atomic failed-payment guard on `public.checkout_sessions` (preserves valid bill_code)
CREATE OR REPLACE FUNCTION public.mark_checkout_payment_failed_atomic(
  p_checkout_session_id uuid,
  p_bill_code text,
  p_raw_callback jsonb DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session public.checkout_sessions;
  v_now timestamptz := now();
BEGIN
  SELECT * INTO v_session
  FROM public.checkout_sessions
  WHERE id = p_checkout_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'checkout_not_found';
  END IF;

  IF v_session.bill_code IS DISTINCT FROM p_bill_code THEN
    RETURN 'payment_not_found';
  END IF;

  IF v_session.paid_at IS NOT NULL
     OR v_session.status IN ('paid', 'expired', 'cancelled')
     OR v_session.payment_status IN ('paid', 'late_payment_review', 'expired') THEN
    RETURN 'ignored_terminal';
  END IF;

  IF v_session.payment_status <> 'pending' THEN
    RETURN 'already_' || v_session.payment_status;
  END IF;

  UPDATE public.checkout_sessions
  SET payment_status = 'failed',
      raw_callback = COALESCE(p_raw_callback, raw_callback),
      updated_at = v_now
  WHERE id = v_session.id;

  RETURN 'marked_failed';
END;
$$;

-- 9. Harden legacy single-order RPCs: block unified child orders (`checkout_session_id IS NOT NULL`),
--    enforce atomic `payment_transaction_registry` uniqueness, and protect `late_payment_review`.
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
  v_now timestamptz;
  v_token uuid;
  v_placeholder text;
  v_has_valid_bill boolean := false;
BEGIN
  SELECT o.* INTO v_order
  FROM public.orders o
  WHERE o.id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'order_not_found'::text, NULL::text, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  IF v_order.checkout_session_id IS NOT NULL THEN
    RETURN QUERY SELECT 'use_checkout_session'::text, NULL::text, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  v_now := clock_timestamp();

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

  SELECT p.* INTO v_payment
  FROM public.payments p
  WHERE p.order_id = v_order.id
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

    IF v_has_valid_bill AND v_payment.status IN ('pending', 'failed') THEN
      IF v_payment.status = 'failed' THEN
        UPDATE public.payments p
        SET status = 'pending',
            updated_at = v_now
        WHERE p.id = v_payment.id;
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

      UPDATE public.payments p
      SET bill_creation_state = 'ambiguous',
          updated_at = v_now
      WHERE p.id = v_payment.id;

      RETURN QUERY SELECT 'ambiguous_hold'::text, NULL::text, NULL::text, NULL::uuid;
      RETURN;
    END IF;

    IF v_payment.bill_creation_state = 'ambiguous' THEN
      RETURN QUERY SELECT 'ambiguous_hold'::text, NULL::text, NULL::text, NULL::uuid;
      RETURN;
    END IF;

    IF v_payment.bill_creation_state = 'failed'
       AND (v_payment.bill_code IS NULL OR left(v_payment.bill_code, 9) = 'creating:') THEN
      v_token := gen_random_uuid();
      -- Independent random placeholder: NEVER embed private attempt_token in buyer-readable bill_code
      v_placeholder := 'creating:' || gen_random_uuid()::text;

      UPDATE public.payments p
      SET bill_code = v_placeholder,
          bill_url = NULL,
          amount_sen = v_order.total_paid_sen,
          status = 'pending',
          bill_creation_state = 'creating',
          bill_creation_started_at = v_now,
          bill_creation_attempt_token = v_token,
          updated_at = v_now
      WHERE p.id = v_payment.id;

      RETURN QUERY SELECT 'create_new'::text, v_placeholder, NULL::text, v_token;
      RETURN;
    END IF;

    RETURN QUERY SELECT 'ambiguous_hold'::text, v_payment.bill_code, v_payment.bill_url, NULL::uuid;
    RETURN;
  END IF;

  v_token := gen_random_uuid();
  v_placeholder := 'creating:' || gen_random_uuid()::text;

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

  IF v_order.checkout_session_id IS NOT NULL THEN
    RETURN 'use_checkout_session';
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
     OR v_order.status IN ('paid', 'ready_for_pickup', 'handed_over', 'completed', 'expired', 'cancelled')
     OR v_payment.status IN ('paid', 'late_payment_review', 'expired') THEN
    RETURN 'ignored_terminal';
  END IF;

  IF v_payment.status <> 'pending' THEN
    RETURN 'already_' || v_payment.status;
  END IF;

  UPDATE public.payments
  SET status = 'failed',
      raw_callback = COALESCE(p_raw_callback, raw_callback),
      updated_at = v_now
  WHERE id = v_payment.id;

  RETURN 'marked_failed';
END;
$$;

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

  -- Atomic cross-table `transaction_ref` claim (concurrency-safe via PRIMARY KEY)
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

  -- Final post-inventory-lock wall-clock deadline recheck BEFORE deducting stock
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

-- 10. Update `pg_cron` Job 2 (`release_expired_cart_orders`): strictly `source = 'cart'`
--     Part A: legacy standalone cart orders (`checkout_session_id IS NULL`)
--     Part B: unified cart `checkout_sessions` (whole-checkout expiry + exact stock release)
CREATE OR REPLACE FUNCTION public.release_expired_cart_orders()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ord RECORD;
  v_sess RECORD;
  v_item RECORD;
  v_listing public.listings;
  v_variant public.listing_variants;
  v_now timestamptz := now();
  v_count integer := 0;
BEGIN
  -- Part A: Legacy standalone cart orders ONLY (`checkout_session_id IS NULL`)
  FOR v_ord IN
    SELECT id
    FROM public.orders
    WHERE source = 'cart'
      AND checkout_session_id IS NULL
      AND status = 'pending_payment'
      AND paid_at IS NULL
      AND payment_deadline IS NOT NULL
      AND payment_deadline <= v_now
    ORDER BY id
    FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      PERFORM 1
      FROM public.listings l
      WHERE l.id IN (SELECT DISTINCT oi.listing_id FROM public.order_items oi WHERE oi.order_id = v_ord.id)
      ORDER BY l.id
      FOR UPDATE;

      PERFORM 1
      FROM public.listing_variants lv
      WHERE lv.id IN (
        SELECT DISTINCT oi.variant_id FROM public.order_items oi
        WHERE oi.order_id = v_ord.id AND oi.variant_id IS NOT NULL
      )
      ORDER BY lv.id
      FOR UPDATE;

      FOR v_item IN
        SELECT listing_id, variant_id, quantity
        FROM public.order_items
        WHERE order_id = v_ord.id
        ORDER BY listing_id, variant_id NULLS FIRST
      LOOP
        SELECT * INTO v_listing FROM public.listings WHERE id = v_item.listing_id;
        IF NOT FOUND OR v_listing.reserved_quantity < v_item.quantity THEN
          RAISE EXCEPTION 'INSUFFICIENT_LISTING_RESERVATION';
        END IF;

        IF v_item.variant_id IS NOT NULL THEN
          SELECT * INTO v_variant
          FROM public.listing_variants
          WHERE id = v_item.variant_id AND listing_id = v_item.listing_id;
          IF NOT FOUND OR v_variant.reserved_quantity < v_item.quantity THEN
            RAISE EXCEPTION 'INSUFFICIENT_VARIANT_RESERVATION';
          END IF;
        END IF;

        UPDATE public.listings
        SET reserved_quantity = reserved_quantity - v_item.quantity,
            updated_at = v_now
        WHERE id = v_item.listing_id;

        IF v_item.variant_id IS NOT NULL THEN
          UPDATE public.listing_variants
          SET reserved_quantity = reserved_quantity - v_item.quantity
          WHERE id = v_item.variant_id;
        END IF;
      END LOOP;

      UPDATE public.orders
      SET status = 'expired',
          updated_at = v_now
      WHERE id = v_ord.id
        AND status = 'pending_payment'
        AND paid_at IS NULL;

      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'release_expired_cart_orders skipped legacy order % due to %', v_ord.id, SQLERRM;
    END;
  END LOOP;

  -- Part B: Unified cart checkout sessions (whole-checkout expiry + all child orders atomically)
  FOR v_sess IN
    SELECT id
    FROM public.checkout_sessions
    WHERE source = 'cart'
      AND status = 'pending_payment'
      AND paid_at IS NULL
      AND payment_deadline <= v_now
    ORDER BY id
    FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      PERFORM 1
      FROM public.orders
      WHERE checkout_session_id = v_sess.id
      ORDER BY id
      FOR UPDATE;

      PERFORM 1
      FROM public.listings l
      WHERE l.id IN (
        SELECT DISTINCT oi.listing_id
        FROM public.order_items oi
        JOIN public.orders ord ON ord.id = oi.order_id
        WHERE ord.checkout_session_id = v_sess.id
      )
      ORDER BY l.id
      FOR UPDATE;

      PERFORM 1
      FROM public.listing_variants lv
      WHERE lv.id IN (
        SELECT DISTINCT oi.variant_id
        FROM public.order_items oi
        JOIN public.orders ord ON ord.id = oi.order_id
        WHERE ord.checkout_session_id = v_sess.id
          AND oi.variant_id IS NOT NULL
      )
      ORDER BY lv.id
      FOR UPDATE;

      FOR v_item IN
        SELECT oi.listing_id, oi.variant_id, oi.quantity
        FROM public.order_items oi
        JOIN public.orders ord ON ord.id = oi.order_id
        WHERE ord.checkout_session_id = v_sess.id
        ORDER BY oi.listing_id, oi.variant_id NULLS FIRST, oi.id
      LOOP
        SELECT * INTO v_listing FROM public.listings WHERE id = v_item.listing_id;
        IF NOT FOUND OR v_listing.reserved_quantity < v_item.quantity THEN
          RAISE EXCEPTION 'INSUFFICIENT_LISTING_RESERVATION';
        END IF;

        IF v_item.variant_id IS NOT NULL THEN
          SELECT * INTO v_variant
          FROM public.listing_variants
          WHERE id = v_item.variant_id AND listing_id = v_item.listing_id;
          IF NOT FOUND OR v_variant.reserved_quantity < v_item.quantity THEN
            RAISE EXCEPTION 'INSUFFICIENT_VARIANT_RESERVATION';
          END IF;
        END IF;

        UPDATE public.listings
        SET reserved_quantity = reserved_quantity - v_item.quantity,
            updated_at = v_now
        WHERE id = v_item.listing_id;

        IF v_item.variant_id IS NOT NULL THEN
          UPDATE public.listing_variants
          SET reserved_quantity = reserved_quantity - v_item.quantity
          WHERE id = v_item.variant_id;
        END IF;
      END LOOP;

      UPDATE public.orders
      SET status = 'expired',
          updated_at = v_now
      WHERE checkout_session_id = v_sess.id
        AND status = 'pending_payment'
        AND paid_at IS NULL;

      UPDATE public.checkout_sessions
      SET status = 'expired',
          payment_status = CASE
            WHEN payment_status IN ('paid', 'late_payment_review') THEN payment_status
            ELSE 'expired'
          END,
          updated_at = v_now
      WHERE id = v_sess.id
        AND status = 'pending_payment'
        AND paid_at IS NULL;

      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'release_expired_cart_orders skipped checkout_session % due to %', v_sess.id, SQLERRM;
    END;
  END LOOP;

  RETURN v_count;
END;
$$;

-- 11. Update `pg_cron` Job 1 (`release_expired_offer_reservations`): strictly `offer` holds;
--     consistent lock order (`offers -> checkout_sessions -> orders -> listings`) + exact release (NO GREATEST)
CREATE OR REPLACE FUNCTION public.release_expired_offer_reservations()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := now();
  v_rec RECORD;
  v_listing public.listings;
  v_released integer := 0;
  v_checkout_session_id uuid;
BEGIN
  UPDATE public.offers
  SET status = 'expired',
      updated_at = v_now
  WHERE status = 'pending'
    AND expires_at <= v_now;

  FOR v_rec IN
    SELECT o.id, o.listing_id, o.order_id
    FROM public.offers o
    WHERE o.status = 'accepted'
      AND o.reservation_released_at IS NULL
      AND o.reservation_expires_at IS NOT NULL
      AND o.reservation_expires_at <= v_now
      AND NOT EXISTS (
        SELECT 1
        FROM public.orders ord
        WHERE ord.id = o.order_id
          AND (
            ord.paid_at IS NOT NULL
            OR ord.status IN ('paid', 'ready_for_pickup', 'handed_over', 'completed')
          )
      )
    ORDER BY o.id
    FOR UPDATE OF o SKIP LOCKED
  LOOP
    BEGIN
      v_checkout_session_id := NULL;

      IF v_rec.order_id IS NOT NULL THEN
        -- Non-locking peek so we lock `checkout_sessions` BEFORE `orders` (matches confirm_checkout_payment_atomic!)
        SELECT checkout_session_id INTO v_checkout_session_id
        FROM public.orders
        WHERE id = v_rec.order_id;

        IF v_checkout_session_id IS NOT NULL THEN
          PERFORM 1
          FROM public.checkout_sessions
          WHERE id = v_checkout_session_id
          FOR UPDATE;
        END IF;

        PERFORM 1
        FROM public.orders
        WHERE id = v_rec.order_id
        FOR UPDATE;
      END IF;

      SELECT * INTO v_listing
      FROM public.listings
      WHERE id = v_rec.listing_id
      FOR UPDATE;

      IF NOT FOUND OR v_listing.reserved_quantity < 1 THEN
        RAISE EXCEPTION 'INSUFFICIENT_LISTING_RESERVATION';
      END IF;

      UPDATE public.listings
      SET reserved_quantity = reserved_quantity - 1,
          updated_at = v_now
      WHERE id = v_rec.listing_id;

      IF v_rec.order_id IS NOT NULL THEN
        UPDATE public.orders
        SET status = 'expired',
            updated_at = v_now
        WHERE id = v_rec.order_id
          AND status = 'pending_payment'
          AND paid_at IS NULL;

        IF v_checkout_session_id IS NOT NULL THEN
          UPDATE public.checkout_sessions
          SET status = 'expired',
              payment_status = CASE
                WHEN payment_status IN ('paid', 'late_payment_review') THEN payment_status
                ELSE 'expired'
              END,
              updated_at = v_now
          WHERE id = v_checkout_session_id
            AND status = 'pending_payment'
            AND paid_at IS NULL;
        END IF;
      END IF;

      UPDATE public.offers
      SET status = 'expired',
          reservation_released_at = v_now,
          updated_at = v_now
      WHERE id = v_rec.id;

      v_released := v_released + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'release_expired_offer_reservations skipped offer % due to %', v_rec.id, SQLERRM;
    END;
  END LOOP;

  RETURN v_released;
END;
$$;

-- 12. Explicit RPC Grants & Retirement of Legacy Authenticated Order-Creation RPCs
REVOKE ALL ON FUNCTION public.create_cart_orders_atomic(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_offer_order_atomic(uuid, text) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.create_cart_checkout_atomic(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_cart_checkout_atomic(text) TO authenticated;

REVOKE ALL ON FUNCTION public.create_offer_checkout_atomic(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_offer_checkout_atomic(uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.claim_checkout_bill_slot(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_checkout_bill_slot(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.finalize_checkout_bill_slot(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_checkout_bill_slot(uuid, uuid, text, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.confirm_checkout_payment_atomic(uuid, text, text, integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_checkout_payment_atomic(uuid, text, text, integer, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.mark_checkout_payment_failed_atomic(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_checkout_payment_failed_atomic(uuid, text, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.claim_order_bill_slot(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_order_bill_slot(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.mark_order_payment_failed_atomic(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_order_payment_failed_atomic(uuid, text, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.confirm_order_payment_atomic(uuid, text, text, integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_order_payment_atomic(uuid, text, text, integer, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.release_expired_cart_orders() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_expired_cart_orders() TO service_role;

REVOKE ALL ON FUNCTION public.release_expired_offer_reservations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_expired_offer_reservations() TO service_role;

COMMIT;

-- =============================================================================
-- SAFE NON-DESTRUCTIVE ROLLBACK STRATEGY (preserves ALL payment history AND
-- keeps unified expiry & reconciliation active while unified records exist):
--   Step 1: Stop NEW unified checkouts and re-enable legacy authenticated creation:
--     BEGIN;
--     REVOKE ALL ON FUNCTION public.create_cart_checkout_atomic(text) FROM authenticated;
--     REVOKE ALL ON FUNCTION public.create_offer_checkout_atomic(uuid, text) FROM authenticated;
--     GRANT EXECUTE ON FUNCTION public.create_cart_orders_atomic(text) TO authenticated;
--     GRANT EXECUTE ON FUNCTION public.create_offer_order_atomic(uuid, text) TO authenticated;
--     COMMIT;
--   Step 2: DO NOT revert `release_expired_cart_orders()`, `release_expired_offer_reservations()`,
--           `confirm_checkout_payment_atomic()`, `mark_checkout_payment_failed_atomic()`,
--           `claim_checkout_bill_slot()`, or `finalize_checkout_bill_slot()` while ANY
--           `public.checkout_sessions` row remains in `status = 'pending_payment'` or
--           `payment_status IN ('pending', 'ambiguous', 'late_payment_review')`.
--           Keeping them active guarantees unified expiry, stock release, and late-payment
--           reconciliation continue working seamlessly during rollback drain.
--   Step 3: NEVER drop `public.checkout_sessions`, `public.payment_transaction_registry`,
--           or `orders.checkout_session_id` if any unified checkout records exist — retain
--           them read-only for audit & refund reconciliation.
-- =============================================================================
