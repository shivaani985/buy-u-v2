-- =============================================================================
-- Buy-U Phase 10 — Rollback-Only SQL Verification Script
-- STATUS: VERIFICATION ONLY — RUN MANUALLY BY OWNER WHEN READY
-- TARGET PROJECT: duwwlcpdidrxkixvflag
--
-- Generated directly from docs/sql/phase-10-bargaining-eligibility.sql
-- (outer BEGIN/COMMIT stripped so the exact migration runs inside this rollback TX).
-- Never commits DDL or test data. Does not contact ToyyibPay.
-- =============================================================================

BEGIN;

-- =============================================================================
-- PART 1: Exact Proposed Phase 10 Migration (generated from source migration)
-- =============================================================================

-- =============================================================================
-- Buy-U Phase 10 — Expanded Bargaining Eligibility & Variant Offer Support (Revised)
-- STATUS: PROPOSAL ONLY — DO NOT APPLY WITHOUT EXPLICIT OWNER APPROVAL
-- TARGET PROJECT: duwwlcpdidrxkixvflag
--
-- Corrections Applied (P0.1–P0.6):
--   - P0.1: Restores exact hosted `create_offer_checkout_atomic(uuid, text DEFAULT NULL)`
--           return contract (`id uuid`, NOT `checkout_session_id`) via CREATE OR REPLACE.
--   - P0.2: Restores accepted Phase 6B.4 checkout idempotency & deadline safeguards:
--           default idempotency key, post-lock `clock_timestamp()` revalidation,
--           strict `pending_payment` + deadline check on linked order replay,
--           `OFFER_ORDER_ALREADY_TERMINAL` rejection, and removal of unrestricted
--           buyer/idempotency_key lookup.
--   - P0.3: Hardens `release_expired_offer_reservations()` with exact lock order
--           (`offers -> checkout_sessions -> orders -> listings -> listing_variants`),
--           post-lock revalidation of offer/order/checkout_session state & deadline,
--           and exact 1-unit parent + variant reservation release without double-release.
--   - P0.4: Aligns variant reservation/deduction/release with `create_cart_orders_atomic`,
--           `confirm_order_payment_atomic`, `release_expired_cart_orders`, and
--           Phase 6D refund restocking (both parent `listings.reserved_quantity` and
--           `listing_variants.reserved_quantity` move together).
--   - P0.5: Uses `ON DELETE SET NULL` on `offers.variant_id` so historical offers never
--           block legitimate seller variant cleanup once `reserved_quantity = 0`
--           (active holds remain strictly protected by `trg_guard_listing_variants_reserved_stock`).
--   - P0.6: Enforces eligibility on direct `public.listings` writes via `guard_listing_allow_offers()`
--           and restricts EXECUTE grants on `public.is_listing_bargaining_eligible`.
-- =============================================================================
-- 1. Add nullable `variant_id` & `variant_snapshot` to `public.offers` (idempotent)
ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS variant_id uuid NULL,
  ADD COLUMN IF NOT EXISTS variant_snapshot jsonb NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.offers'::regclass
      AND conname = 'offers_variant_id_fkey'
  ) THEN
    ALTER TABLE public.offers DROP CONSTRAINT offers_variant_id_fkey;
  END IF;

  ALTER TABLE public.offers
    ADD CONSTRAINT offers_variant_id_fkey
    FOREIGN KEY (variant_id)
    REFERENCES public.listing_variants(id)
    ON DELETE SET NULL;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_offers_variant_id
  ON public.offers (variant_id)
  WHERE variant_id IS NOT NULL;

-- 1b. Preserve variant history & block/expire offers safely on variant deletion (FIX 3)
--     - Active accepted holds remain blocked (defense-in-depth alongside reserved-stock guard).
--     - Pending offers on a deleted variant are expired immediately so ON DELETE SET NULL
--       can never turn them into non-variant offers.
--     - Historical offers retain `variant_snapshot` before `variant_id` becomes NULL.
CREATE OR REPLACE FUNCTION public.handle_listing_variant_delete_offers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  -- Block ONLY accepted offers with an outstanding (unconsumed, unreleased) inventory hold.
  -- Verified paid offers have already consumed their reservation and are historical records.
  IF EXISTS (
    SELECT 1
    FROM public.offers o
    WHERE o.variant_id = OLD.id
      AND o.status = 'accepted'
      AND o.reservation_released_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.orders ord
        WHERE ord.id = o.order_id
          AND (
            ord.paid_at IS NOT NULL
            OR ord.status IN ('paid', 'ready_for_pickup', 'handed_over', 'completed')
          )
      )
  ) THEN
    RAISE EXCEPTION 'Cannot delete variant with active accepted offer reservation'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.offers
  SET variant_snapshot = COALESCE(variant_snapshot, OLD.option_values),
      status = CASE WHEN status = 'pending' THEN 'expired' ELSE status END,
      responded_at = CASE WHEN status = 'pending' THEN COALESCE(responded_at, v_now) ELSE responded_at END
  WHERE variant_id = OLD.id;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_handle_listing_variant_delete_offers ON public.listing_variants;
CREATE TRIGGER trg_handle_listing_variant_delete_offers
  BEFORE DELETE ON public.listing_variants
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_listing_variant_delete_offers();

-- 2. Centralized authoritative bargaining eligibility helper
CREATE OR REPLACE FUNCTION public.is_listing_bargaining_eligible(
  p_kind text,
  p_is_food boolean,
  p_availability_mode text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    p_kind IN ('pre_loved', 'business')
    AND COALESCE(p_is_food, false) IS NOT TRUE
    AND COALESCE(lower(p_availability_mode), '') <> 'pre_order';
$$;

REVOKE ALL ON FUNCTION public.is_listing_bargaining_eligible(text, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_listing_bargaining_eligible(text, boolean, text) TO authenticated, service_role;

-- 3. Prevent direct DB writes from enabling `allow_offers` on ineligible listings (food, pre-order, service)
CREATE OR REPLACE FUNCTION public.guard_listing_allow_offers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.allow_offers IS TRUE
     AND NOT public.is_listing_bargaining_eligible(
       NEW.kind,
       NEW.is_food,
       NEW.availability_mode
     ) THEN
    RAISE EXCEPTION 'Price negotiation is only allowed on Pre-Loved and non-food Student Business listings'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_listing_allow_offers ON public.listings;
CREATE TRIGGER trg_guard_listing_allow_offers
  BEFORE INSERT OR UPDATE OF kind, is_food, availability_mode, allow_offers
  ON public.listings
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_listing_allow_offers();

-- 4. Update `guard_offer_inserts()` for expanded eligibility + variant validation
CREATE OR REPLACE FUNCTION public.guard_offer_inserts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_conv public.conversations;
  v_listing public.listings;
  v_variant public.listing_variants;
  v_effective_price_sen integer;
  v_available_stock integer;
BEGIN
  IF current_user IN ('postgres', 'service_role') THEN
    NEW.created_at := COALESCE(NEW.created_at, v_now);
    NEW.expires_at := COALESCE(NEW.expires_at, NEW.created_at + interval '24 hours');
    RETURN NEW;
  END IF;

  IF v_uid IS NULL OR NOT public.is_active_member() THEN
    RAISE EXCEPTION 'Only active verified members can create offers'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.buyer_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Offer buyer_id must match the authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.seller_id IS NULL OR NEW.seller_id = v_uid THEN
    RAISE EXCEPTION 'You cannot make an offer on your own listing'
      USING ERRCODE = '42501';
  END IF;

  IF COALESCE(NEW.status, 'pending') <> 'pending' THEN
    RAISE EXCEPTION 'New offers must start with pending status'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.order_id IS NOT NULL
     OR NEW.responded_at IS NOT NULL
     OR NEW.reservation_expires_at IS NOT NULL
     OR NEW.reservation_released_at IS NOT NULL THEN
    RAISE EXCEPTION 'Server-managed offer fields cannot be set on insert'
      USING ERRCODE = '42501';
  END IF;

  NEW.status := 'pending';
  NEW.created_at := v_now;
  NEW.expires_at := v_now + interval '24 hours';

  SELECT * INTO v_conv
  FROM public.conversations
  WHERE id = NEW.conversation_id;

  IF NOT FOUND
     OR NOT (
       (v_conv.member_a = NEW.buyer_id AND v_conv.member_b = NEW.seller_id)
       OR (v_conv.member_a = NEW.seller_id AND v_conv.member_b = NEW.buyer_id)
     ) THEN
    RAISE EXCEPTION 'Offer participants must match the conversation'
      USING ERRCODE = '42501';
  END IF;

  IF public.is_member_blocked_between(NEW.buyer_id, NEW.seller_id) THEN
    RAISE EXCEPTION 'Offers are unavailable for blocked members'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_listing
  FROM public.listings
  WHERE id = NEW.listing_id;

  IF NOT FOUND OR v_listing.seller_id <> NEW.seller_id THEN
    RAISE EXCEPTION 'Offer seller does not match listing owner'
      USING ERRCODE = '42501';
  END IF;

  IF v_listing.status <> 'published'
     OR NOT public.is_listing_bargaining_eligible(
       v_listing.kind,
       v_listing.is_food,
       v_listing.availability_mode
     )
     OR v_listing.allow_offers IS NOT TRUE THEN
    RAISE EXCEPTION 'Offers are only allowed on published Pre-Loved or non-food Student Business listings with negotiation enabled'
      USING ERRCODE = '42501';
  END IF;

  IF COALESCE(v_listing.has_variants, false) THEN
    IF NEW.variant_id IS NULL THEN
      RAISE EXCEPTION 'A valid product variant must be selected before making an offer'
        USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_variant
    FROM public.listing_variants
    WHERE id = NEW.variant_id
      AND listing_id = v_listing.id;

    IF NOT FOUND OR v_variant.active IS NOT TRUE THEN
      RAISE EXCEPTION 'Selected product variant is unavailable'
        USING ERRCODE = '42501';
    END IF;

    IF (v_listing.quantity - GREATEST(0, v_listing.reserved_quantity)) < 1 THEN
      RAISE EXCEPTION 'This listing is currently out of stock'
        USING ERRCODE = '42501';
    END IF;

    v_available_stock := v_variant.quantity - GREATEST(0, v_variant.reserved_quantity);
    v_effective_price_sen := v_variant.price_sen;
    NEW.variant_snapshot := v_variant.option_values;
  ELSE
    IF NEW.variant_id IS NOT NULL THEN
      RAISE EXCEPTION 'Unexpected variant on a non-variant listing'
        USING ERRCODE = '22023';
    END IF;

    v_available_stock := v_listing.quantity - GREATEST(0, v_listing.reserved_quantity);
    v_effective_price_sen := v_listing.price_sen;
    NEW.variant_snapshot := NULL;
  END IF;

  IF v_available_stock < 1 THEN
    RAISE EXCEPTION 'This listing is currently out of stock'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.offer_price_sen IS NULL
     OR NEW.offer_price_sen < 200
     OR NEW.offer_price_sen > v_effective_price_sen THEN
    RAISE EXCEPTION 'Offer price must be between RM 2.00 and the listing price'
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;

-- 5. Update `guard_offer_updates()` to keep `variant_id` immutable for authenticated callers
CREATE OR REPLACE FUNCTION public.guard_offer_updates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF current_user IN ('postgres', 'service_role') THEN
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.listing_id IS DISTINCT FROM OLD.listing_id
     OR NEW.variant_id IS DISTINCT FROM OLD.variant_id
     OR NEW.variant_snapshot IS DISTINCT FROM OLD.variant_snapshot
     OR NEW.buyer_id IS DISTINCT FROM OLD.buyer_id
     OR NEW.seller_id IS DISTINCT FROM OLD.seller_id
     OR NEW.offer_price_sen IS DISTINCT FROM OLD.offer_price_sen
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.reservation_expires_at IS DISTINCT FROM OLD.reservation_expires_at
     OR NEW.reservation_released_at IS DISTINCT FROM OLD.reservation_released_at
  THEN
    RAISE EXCEPTION 'Offer core and reservation fields cannot be modified directly'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.status = 'accepted' THEN
    RAISE EXCEPTION 'Offers must be accepted via accept_offer_atomic to reserve stock atomically'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'Only pending offers can be updated'
      USING ERRCODE = '42501';
  END IF;

  IF now() >= COALESCE(OLD.expires_at, OLD.created_at + interval '24 hours') THEN
    RAISE EXCEPTION 'Expired offers cannot be updated'
      USING ERRCODE = '42501';
  END IF;

  IF v_uid = OLD.buyer_id THEN
    IF NEW.status NOT IN ('withdrawn', 'cancelled') THEN
      RAISE EXCEPTION 'Buyers may only cancel or withdraw their own pending offer'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_uid = OLD.seller_id THEN
    IF NEW.status NOT IN ('declined', 'rejected') THEN
      RAISE EXCEPTION 'Sellers may only decline a pending offer directly'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'Only offer participants may update an offer'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

-- 6. Hardened `release_expired_offer_reservations()` (P0.3)
--    Lock order: offers -> checkout_sessions -> orders -> listings -> listing_variants
--    Revalidates offer/order/checkout_session state and deadline after locks.
CREATE OR REPLACE FUNCTION public.release_expired_offer_reservations()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_rec RECORD;
  v_offer public.offers;
  v_order public.orders;
  v_session public.checkout_sessions;
  v_listing public.listings;
  v_variant public.listing_variants;
  v_released integer := 0;
  v_checkout_session_id uuid;
BEGIN
  UPDATE public.offers
  SET status = 'expired'
  WHERE status = 'pending'
    AND expires_at <= v_now;

  FOR v_rec IN
    SELECT o.id, o.listing_id, o.variant_id, o.order_id
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
    -- Re-read locked offer row and verify post-lock invariants
    SELECT * INTO v_offer
    FROM public.offers
    WHERE id = v_rec.id;

    v_now := clock_timestamp();

    IF NOT FOUND
       OR v_offer.status <> 'accepted'
       OR v_offer.reservation_released_at IS NOT NULL
       OR v_offer.reservation_expires_at IS NULL
       OR v_now < v_offer.reservation_expires_at THEN
      CONTINUE;
    END IF;

    v_checkout_session_id := NULL;
    v_order := NULL;
    v_session := NULL;

    IF v_offer.order_id IS NOT NULL THEN
      SELECT checkout_session_id INTO v_checkout_session_id
      FROM public.orders
      WHERE id = v_offer.order_id;

      -- Lock checkout_sessions BEFORE orders (strict global lock order)
      IF v_checkout_session_id IS NOT NULL THEN
        SELECT * INTO v_session
        FROM public.checkout_sessions
        WHERE id = v_checkout_session_id
        FOR UPDATE;

        -- Skip ONLY genuinely paid checkouts; `late_payment_review` did not deduct or release
        -- inventory and MUST still release its expired hold while preserving reconciliation data.
        IF FOUND AND (
          v_session.paid_at IS NOT NULL
          OR v_session.status IN ('paid', 'completed')
          OR v_session.payment_status = 'paid'
        ) THEN
          CONTINUE;
        END IF;
      END IF;

      SELECT * INTO v_order
      FROM public.orders
      WHERE id = v_offer.order_id
      FOR UPDATE;

      IF FOUND THEN
        -- Never release stock if order was paid or fulfilled.
        -- Do NOT assume an `expired`/`cancelled` order already released offer stock because
        -- `offers.reservation_released_at IS NULL` is the authoritative release flag for offers.
        IF v_order.paid_at IS NOT NULL
           OR v_order.status IN ('paid', 'ready_for_pickup', 'handed_over', 'completed') THEN
          CONTINUE;
        END IF;
      END IF;
    END IF;

    -- Lock listings -> listing_variants
    SELECT * INTO v_listing
    FROM public.listings
    WHERE id = v_offer.listing_id
    FOR UPDATE;

    IF NOT FOUND OR v_listing.reserved_quantity < 1 THEN
      RAISE WARNING 'release_expired_offer_reservations integrity mismatch on listing % for offer % (reserved_quantity=%)',
        v_offer.listing_id, v_offer.id, COALESCE(v_listing.reserved_quantity, -1);
      CONTINUE;
    END IF;

    IF v_offer.variant_id IS NOT NULL THEN
      SELECT * INTO v_variant
      FROM public.listing_variants
      WHERE id = v_offer.variant_id
        AND listing_id = v_offer.listing_id
      FOR UPDATE;

      IF NOT FOUND OR v_variant.reserved_quantity < 1 THEN
        RAISE WARNING 'release_expired_offer_reservations integrity mismatch on variant % for offer % (reserved_quantity=%)',
          v_offer.variant_id, v_offer.id, COALESCE(v_variant.reserved_quantity, -1);
        CONTINUE;
      END IF;

      UPDATE public.listing_variants
      SET reserved_quantity = reserved_quantity - 1
      WHERE id = v_variant.id;
    END IF;

    UPDATE public.listings
    SET reserved_quantity = reserved_quantity - 1,
        updated_at = v_now
    WHERE id = v_offer.listing_id;

    IF v_offer.order_id IS NOT NULL THEN
      UPDATE public.orders
      SET status = 'expired',
          updated_at = v_now
      WHERE id = v_offer.order_id
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
        reservation_released_at = v_now
    WHERE id = v_offer.id;

    v_released := v_released + 1;
  END LOOP;

  RETURN v_released;
END;
$$;

-- 7. Update `accept_offer_atomic()` for expanded eligibility + atomic variant reservation
CREATE OR REPLACE FUNCTION public.accept_offer_atomic(p_offer_id uuid)
RETURNS public.offers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_offer public.offers;
  v_conv public.conversations;
  v_listing public.listings;
  v_variant public.listing_variants;
  v_buyer_status text;
  v_now timestamptz := clock_timestamp();
  v_effective_price_sen integer;
  v_available_stock integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  IF NOT public.is_active_member() THEN
    RAISE EXCEPTION 'SELLER_RESTRICTED';
  END IF;

  PERFORM public.release_expired_offer_reservations();

  -- Lock order: offers -> listings -> listing_variants
  SELECT * INTO v_offer
  FROM public.offers
  WHERE id = p_offer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'OFFER_NOT_FOUND';
  END IF;

  v_now := clock_timestamp();

  IF v_offer.seller_id <> v_uid THEN
    RAISE EXCEPTION 'FORBIDDEN_SELLER_ONLY';
  END IF;

  IF v_offer.buyer_id = v_uid THEN
    RAISE EXCEPTION 'SELF_OFFER_FORBIDDEN';
  END IF;

  IF v_offer.status <> 'pending' THEN
    RAISE EXCEPTION 'OFFER_NOT_PENDING';
  END IF;

  IF v_offer.order_id IS NOT NULL THEN
    RAISE EXCEPTION 'OFFER_ALREADY_LINKED';
  END IF;

  IF v_now >= COALESCE(v_offer.expires_at, v_offer.created_at + interval '24 hours') THEN
    RAISE EXCEPTION 'OFFER_EXPIRED';
  END IF;

  SELECT status INTO v_buyer_status
  FROM public.profiles
  WHERE id = v_offer.buyer_id;

  IF COALESCE(lower(v_buyer_status), '') <> 'active' THEN
    RAISE EXCEPTION 'BUYER_RESTRICTED';
  END IF;

  SELECT * INTO v_conv
  FROM public.conversations
  WHERE id = v_offer.conversation_id;

  IF NOT FOUND
     OR NOT (
       (v_conv.member_a = v_offer.buyer_id AND v_conv.member_b = v_offer.seller_id)
       OR (v_conv.member_a = v_offer.seller_id AND v_conv.member_b = v_offer.buyer_id)
     ) THEN
    RAISE EXCEPTION 'CONVERSATION_MISMATCH';
  END IF;

  IF public.is_member_blocked_between(v_offer.buyer_id, v_offer.seller_id) THEN
    RAISE EXCEPTION 'MEMBER_BLOCKED';
  END IF;

  SELECT * INTO v_listing
  FROM public.listings
  WHERE id = v_offer.listing_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_listing.seller_id <> v_offer.seller_id
     OR v_listing.seller_id <> v_uid THEN
    RAISE EXCEPTION 'LISTING_OWNER_MISMATCH';
  END IF;

  IF v_listing.status <> 'published'
     OR NOT public.is_listing_bargaining_eligible(
       v_listing.kind,
       v_listing.is_food,
       v_listing.availability_mode
     )
     OR v_listing.allow_offers IS NOT TRUE THEN
    RAISE EXCEPTION 'LISTING_NOT_ELIGIBLE';
  END IF;

  IF COALESCE(v_listing.has_variants, false) THEN
    IF v_offer.variant_id IS NULL THEN
      RAISE EXCEPTION 'VARIANT_REQUIRED';
    END IF;

    SELECT * INTO v_variant
    FROM public.listing_variants
    WHERE id = v_offer.variant_id
      AND listing_id = v_listing.id
    FOR UPDATE;

    IF NOT FOUND OR v_variant.active IS NOT TRUE THEN
      RAISE EXCEPTION 'VARIANT_UNAVAILABLE';
    END IF;

    -- Prevent silently negotiating a mutated product configuration
    IF v_offer.variant_snapshot IS NOT NULL
       AND v_variant.option_values IS DISTINCT FROM v_offer.variant_snapshot THEN
      RAISE EXCEPTION 'VARIANT_OPTIONS_CHANGED';
    END IF;

    -- Validate BOTH parent listing and selected variant available stock
    IF v_listing.reserved_quantity < 0
       OR (v_listing.quantity - v_listing.reserved_quantity) < 1 THEN
      RAISE EXCEPTION 'OUT_OF_STOCK';
    END IF;

    v_effective_price_sen := v_variant.price_sen;
    v_available_stock := CASE
      WHEN v_variant.reserved_quantity < 0 THEN 0
      ELSE v_variant.quantity - v_variant.reserved_quantity
    END;
  ELSE
    -- Never allow a variant-specific offer (even after ON DELETE SET NULL) to accept as non-variant
    IF v_offer.variant_id IS NOT NULL OR v_offer.variant_snapshot IS NOT NULL THEN
      RAISE EXCEPTION 'UNEXPECTED_VARIANT';
    END IF;

    v_effective_price_sen := v_listing.price_sen;
    v_available_stock := CASE
      WHEN v_listing.reserved_quantity < 0 THEN 0
      ELSE v_listing.quantity - v_listing.reserved_quantity
    END;
  END IF;

  -- Revalidate 24-hour offer expiry using wall clock AFTER acquiring listing & variant locks
  v_now := clock_timestamp();
  IF v_now >= COALESCE(v_offer.expires_at, v_offer.created_at + interval '24 hours') THEN
    RAISE EXCEPTION 'OFFER_EXPIRED';
  END IF;

  IF v_offer.offer_price_sen < 200
     OR v_offer.offer_price_sen > v_effective_price_sen THEN
    RAISE EXCEPTION 'INVALID_OFFER_PRICE';
  END IF;

  IF v_available_stock < 1 THEN
    RAISE EXCEPTION 'OUT_OF_STOCK';
  END IF;

  -- Atomically reserve 1 unit on parent listing (+ exact variant when variant-based) for 30 minutes
  UPDATE public.listings
  SET reserved_quantity = GREATEST(0, reserved_quantity) + 1,
      updated_at = v_now
  WHERE id = v_listing.id;

  IF COALESCE(v_listing.has_variants, false) THEN
    UPDATE public.listing_variants
    SET reserved_quantity = GREATEST(0, reserved_quantity) + 1
    WHERE id = v_variant.id;
  END IF;

  UPDATE public.offers
  SET status = 'accepted',
      variant_snapshot = CASE
        WHEN COALESCE(v_listing.has_variants, false) THEN COALESCE(variant_snapshot, v_variant.option_values)
        ELSE variant_snapshot
      END,
      responded_at = v_now,
      reservation_expires_at = v_now + interval '30 minutes'
  WHERE id = v_offer.id
  RETURNING * INTO v_offer;

  RETURN v_offer;
END;
$$;

-- 8. Update `create_offer_checkout_atomic()` (P0.1 & P0.2)
--    Preserves EXACT hosted return contract (`id uuid`, ...), default idempotency key,
--    strict pending_payment + deadline replay check, OFFER_ORDER_ALREADY_TERMINAL,
--    no unrestricted buyer/idempotency_key lookup, and post-lock deadline revalidation.
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
  v_variant public.listing_variants;
  v_seller_status text;
  v_area_name text;
  v_existing_order public.orders;
  v_session public.checkout_sessions;
  v_order public.orders;
  v_effective_price_sen integer;
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

  -- Lock order: offers -> checkout_sessions -> orders -> listings -> listing_variants
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

  -- Idempotent return ONLY if already linked to a live pending_payment checkout_session
  -- belonging to this exact offer and strictly before its payment deadline
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

  IF NOT FOUND OR v_listing.seller_id <> v_offer.seller_id THEN
    RAISE EXCEPTION 'LISTING_OWNER_MISMATCH';
  END IF;

  IF v_listing.status <> 'published'
     OR NOT public.is_listing_bargaining_eligible(
       v_listing.kind,
       v_listing.is_food,
       v_listing.availability_mode
     ) THEN
    RAISE EXCEPTION 'LISTING_NOT_ELIGIBLE';
  END IF;

  IF COALESCE(v_listing.has_variants, false) THEN
    IF v_offer.variant_id IS NULL THEN
      RAISE EXCEPTION 'VARIANT_REQUIRED';
    END IF;

    SELECT lv.* INTO v_variant
    FROM public.listing_variants lv
    WHERE lv.id = v_offer.variant_id
      AND lv.listing_id = v_listing.id
    FOR UPDATE;

    IF NOT FOUND OR v_variant.active IS NOT TRUE THEN
      RAISE EXCEPTION 'VARIANT_UNAVAILABLE';
    END IF;

    IF v_variant.reserved_quantity < 1 OR v_variant.quantity < 1 THEN
      RAISE EXCEPTION 'RESERVATION_INTEGRITY_ERROR';
    END IF;

    v_effective_price_sen := v_variant.price_sen;
  ELSE
    IF v_offer.variant_id IS NOT NULL THEN
      RAISE EXCEPTION 'UNEXPECTED_VARIANT';
    END IF;
    v_effective_price_sen := v_listing.price_sen;
  END IF;

  -- Revalidate offer hold deadline using wall clock AFTER acquiring all listing & variant locks
  v_now := clock_timestamp();
  IF v_now >= v_offer.reservation_expires_at THEN
    RAISE EXCEPTION 'OFFER_HOLD_EXPIRED';
  END IF;

  IF v_offer.offer_price_sen < 200 OR v_offer.offer_price_sen > v_effective_price_sen THEN
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
    v_order.id,
    v_listing.id,
    CASE WHEN COALESCE(v_listing.has_variants, false) THEN v_variant.id ELSE NULL END,
    v_listing.title,
    CASE WHEN COALESCE(v_listing.has_variants, false) THEN v_variant.option_values ELSE NULL END,
    v_subtotal,
    1,
    COALESCE(v_listing.image_paths[1], ''),
    false,
    'ready',
    ''
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

-- 9. Preserve exact RPC privileges
REVOKE ALL ON FUNCTION public.accept_offer_atomic(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_offer_atomic(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.release_expired_offer_reservations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_expired_offer_reservations() TO service_role;

REVOKE ALL ON FUNCTION public.create_offer_checkout_atomic(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_offer_checkout_atomic(uuid, text) TO authenticated;

-- =============================================================================
-- PART 2: Isolated Synthetic Verification Suite (Authenticated + Service Roles)
-- =============================================================================

DO $$
DECLARE
  v_seller_id uuid;
  v_buyer_id uuid;
  v_cat_biz text;
  v_cat_srv text;
  v_area_id text;
  v_conv_id uuid;
  v_listing_id uuid;
  v_v1_id uuid;
  v_v2_id uuid;
  v_v3_id uuid;
  v_offer_1 uuid;
  v_offer_2 uuid;
  v_offer_3 uuid;
  v_offer_mut uuid;
  v_offer_row public.offers;
  v_chk RECORD;
  v_chk_replay RECORD;
  v_res text;
  v_res_replay text;
  v_released integer;
  v_l public.listings;
  v_v1 public.listing_variants;
  v_sess public.checkout_sessions;
  v_ord public.orders;
  v_failed boolean;
  v_member_a uuid;
  v_member_b uuid;
  v_tx_late text := 'VERIFY_LATE_' || substr(md5(gen_random_uuid()::text), 1, 10);
  v_tx_paid text := 'VERIFY_PAID_' || substr(md5(gen_random_uuid()::text), 1, 10);
  v_desc text := 'Synthetic Phase 10 verification listing for rollback-only SQL checks.';
BEGIN
  -- 1. Select confirmed active verified QA accounts explicitly
  SELECT p.id INTO v_seller_id
  FROM public.profiles p
  JOIN auth.users u ON u.id = p.id
  WHERE lower(p.email) = 'examiner.seller@iluv.ums.edu.my'
    AND lower(p.status) = 'active'
    AND u.email_confirmed_at IS NOT NULL
  LIMIT 1;

  SELECT p.id INTO v_buyer_id
  FROM public.profiles p
  JOIN auth.users u ON u.id = p.id
  WHERE lower(p.email) = 'examiner.buyer@iluv.ums.edu.my'
    AND lower(p.status) = 'active'
    AND u.email_confirmed_at IS NOT NULL
    AND p.id <> v_seller_id
    AND NOT public.is_member_blocked_between(v_seller_id, p.id)
  LIMIT 1;

  IF v_seller_id IS NULL OR v_buyer_id IS NULL THEN
    RAISE EXCEPTION 'VERIFY_SETUP_FAILED: confirmed QA accounts examiner.seller@iluv.ums.edu.my / examiner.buyer@iluv.ums.edu.my must be active and verified';
  END IF;

  -- Hosted schema uses TEXT ids; categories.kind is 'product' or 'service'
  SELECT id INTO v_cat_biz
  FROM public.categories
  WHERE COALESCE(active, true) IS TRUE
    AND kind = 'product'
  ORDER BY id
  LIMIT 1;

  SELECT id INTO v_cat_srv
  FROM public.categories
  WHERE COALESCE(active, true) IS TRUE
    AND kind = 'service'
  ORDER BY id
  LIMIT 1;

  SELECT id INTO v_area_id
  FROM public.collection_areas
  WHERE COALESCE(active, true) IS TRUE
  ORDER BY id
  LIMIT 1;

  IF v_cat_biz IS NULL OR v_cat_srv IS NULL OR v_area_id IS NULL THEN
    RAISE EXCEPTION 'VERIFY_SETUP_FAILED: missing active product/service category or collection_area';
  END IF;

  -- Reuse or create isolated conversation between seller and buyer
  v_member_a := LEAST(v_seller_id, v_buyer_id);
  v_member_b := GREATEST(v_seller_id, v_buyer_id);

  SELECT id INTO v_conv_id
  FROM public.conversations
  WHERE (member_a = v_member_a AND member_b = v_member_b)
     OR (member_a = v_member_b AND member_b = v_member_a)
  LIMIT 1;

  IF v_conv_id IS NULL THEN
    INSERT INTO public.conversations (member_a, member_b)
    VALUES (v_member_a, v_member_b)
    RETURNING id INTO v_conv_id;
  END IF;

  -- TEST 1: Food and Service bargaining rejection (guard_listing_allow_offers)
  v_failed := false;
  BEGIN
    INSERT INTO public.listings (
      seller_id, kind, is_food, title, description, category_id, condition,
      limitations, price_sen, quantity, reserved_quantity, collection_area_id,
      allow_offers, has_variants, option_groups, availability_mode, pickup_note,
      food_notes, accepting_requests, image_paths, rules_acknowledged, status,
      published_at, updated_at
    ) VALUES (
      v_seller_id, 'business', true, '[VERIFY] Food Item', v_desc, v_cat_biz, NULL,
      '', 1000, 5, 0, v_area_id,
      true, false, ARRAY[]::text[], 'ready', '',
      '', false, ARRAY[]::text[], true, 'published',
      clock_timestamp(), clock_timestamp()
    );
  EXCEPTION WHEN SQLSTATE '42501' THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'ASSERT_FAIL_T1a: food listing with allow_offers=true was not rejected';
  END IF;

  v_failed := false;
  BEGIN
    INSERT INTO public.listings (
      seller_id, kind, is_food, title, description, category_id, condition,
      limitations, price_sen, quantity, reserved_quantity, collection_area_id,
      allow_offers, has_variants, option_groups, availability_mode, pickup_note,
      food_notes, accepting_requests, image_paths, rules_acknowledged, status,
      published_at, updated_at
    ) VALUES (
      v_seller_id, 'service', false, '[VERIFY] Service Item', v_desc, v_cat_srv, NULL,
      '', 1500, 1, 0, v_area_id,
      true, false, ARRAY[]::text[], 'ready', '',
      '', true, ARRAY[]::text[], true, 'published',
      clock_timestamp(), clock_timestamp()
    );
  EXCEPTION WHEN SQLSTATE '42501' THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'ASSERT_FAIL_T1b: service listing with allow_offers=true was not rejected';
  END IF;

  -- Create synthetic non-food Student Business variant listing (parent qty=4, V1=2, V2=1, V3=1)
  INSERT INTO public.listings (
    seller_id, kind, is_food, title, description, category_id, condition,
    limitations, price_sen, quantity, reserved_quantity, collection_area_id,
    allow_offers, has_variants, option_groups, availability_mode, pickup_note,
    food_notes, accepting_requests, image_paths, rules_acknowledged, status,
    published_at, updated_at
  ) VALUES (
    v_seller_id, 'business', false, '[VERIFY] Variant Tumbler', v_desc, v_cat_biz, NULL,
    '', 2500, 4, 0, v_area_id,
    true, true, ARRAY['Color', 'Size']::text[], 'ready', '',
    '', false, ARRAY[]::text[], true, 'published',
    clock_timestamp(), clock_timestamp()
  )
  RETURNING id INTO v_listing_id;

  INSERT INTO public.listing_variants (listing_id, option_values, price_sen, quantity, reserved_quantity, active)
  VALUES (v_listing_id, '{"Color":"Purple","Size":"M"}'::jsonb, 2500, 2, 0, true)
  RETURNING id INTO v_v1_id;

  INSERT INTO public.listing_variants (listing_id, option_values, price_sen, quantity, reserved_quantity, active)
  VALUES (v_listing_id, '{"Color":"Black","Size":"L"}'::jsonb, 3000, 1, 0, true)
  RETURNING id INTO v_v2_id;

  INSERT INTO public.listing_variants (listing_id, option_values, price_sen, quantity, reserved_quantity, active)
  VALUES (v_listing_id, '{"Color":"Silver","Size":"S"}'::jsonb, 2800, 1, 0, true)
  RETURNING id INTO v_v3_id;

  -- TEST 2: Legitimate AUTHENTICATED buyer variant offer insertion + server-generated variant_snapshot
  PERFORM set_config('request.jwt.claim.sub', v_buyer_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_buyer_id::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  INSERT INTO public.offers (
    conversation_id, listing_id, variant_id, buyer_id, seller_id, offer_price_sen
  ) VALUES (
    v_conv_id, v_listing_id, v_v1_id, v_buyer_id, v_seller_id, 2000
  )
  RETURNING id INTO v_offer_1;

  INSERT INTO public.offers (
    conversation_id, listing_id, variant_id, buyer_id, seller_id, offer_price_sen
  ) VALUES (
    v_conv_id, v_listing_id, v_v2_id, v_buyer_id, v_seller_id, 2400
  )
  RETURNING id INTO v_offer_2;

  INSERT INTO public.offers (
    conversation_id, listing_id, variant_id, buyer_id, seller_id, offer_price_sen
  ) VALUES (
    v_conv_id, v_listing_id, v_v3_id, v_buyer_id, v_seller_id, 2200
  )
  RETURNING id INTO v_offer_mut;

  -- Authenticated insert without variant_id on variant listing MUST fail
  v_failed := false;
  BEGIN
    INSERT INTO public.offers (
      conversation_id, listing_id, variant_id, buyer_id, seller_id, offer_price_sen
    ) VALUES (
      v_conv_id, v_listing_id, NULL, v_buyer_id, v_seller_id, 2000
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'ASSERT_FAIL_T2a: missing variant_id on variant listing was not rejected';
  END IF;

  RESET ROLE;

  SELECT * INTO v_offer_row FROM public.offers WHERE id = v_offer_1;
  IF v_offer_row.variant_snapshot IS DISTINCT FROM '{"Color":"Purple","Size":"M"}'::jsonb THEN
    RAISE EXCEPTION 'ASSERT_FAIL_T2b: server-generated variant_snapshot mismatch: %', v_offer_row.variant_snapshot;
  END IF;

  -- TEST 3 (FIX 2): Mutated variant option_values blocks acceptance (VARIANT_OPTIONS_CHANGED)
  UPDATE public.listing_variants
  SET option_values = '{"Color":"Gold","Size":"XL"}'::jsonb
  WHERE id = v_v3_id;

  PERFORM set_config('request.jwt.claim.sub', v_seller_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seller_id::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  v_failed := false;
  BEGIN
    PERFORM public.accept_offer_atomic(v_offer_mut);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%VARIANT_OPTIONS_CHANGED%' THEN
      v_failed := true;
    ELSE
      RAISE;
    END IF;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'ASSERT_FAIL_T3a: mutated variant option_values was not rejected on accept';
  END IF;

  RESET ROLE;

  -- TEST 4: Parent stock depletion blocks acceptance even when variant has stock
  UPDATE public.listings SET reserved_quantity = 4 WHERE id = v_listing_id;

  PERFORM set_config('request.jwt.claim.sub', v_seller_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seller_id::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  v_failed := false;
  BEGIN
    PERFORM public.accept_offer_atomic(v_offer_1);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%OUT_OF_STOCK%' THEN
      v_failed := true;
    ELSE
      RAISE;
    END IF;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'ASSERT_FAIL_T4: depleted parent stock did not block accept_offer_atomic';
  END IF;

  RESET ROLE;
  UPDATE public.listings SET reserved_quantity = 0 WHERE id = v_listing_id;

  -- TEST 5: Authenticated seller accepts v_offer_1 -> reserves +1 parent, +1 V1
  PERFORM set_config('request.jwt.claim.sub', v_seller_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seller_id::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  v_offer_row := public.accept_offer_atomic(v_offer_1);
  RESET ROLE;

  SELECT * INTO v_l FROM public.listings WHERE id = v_listing_id;
  SELECT * INTO v_v1 FROM public.listing_variants WHERE id = v_v1_id;
  IF v_offer_row.status <> 'accepted' OR v_l.reserved_quantity <> 1 OR v_v1.reserved_quantity <> 1 THEN
    RAISE EXCEPTION 'ASSERT_FAIL_T5: expected accepted offer and reserved 1/1, got % %/%',
      v_offer_row.status, v_l.reserved_quantity, v_v1.reserved_quantity;
  END IF;

  -- TEST 6: Active accepted hold blocks V1 deletion; unreserved V2 deletion expires v_offer_2 & preserves snapshot
  v_failed := false;
  BEGIN
    DELETE FROM public.listing_variants WHERE id = v_v1_id;
  EXCEPTION WHEN SQLSTATE '42501' THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'ASSERT_FAIL_T6a: variant with active accepted hold was deleted';
  END IF;

  DELETE FROM public.listing_variants WHERE id = v_v2_id;
  SELECT * INTO v_offer_row FROM public.offers WHERE id = v_offer_2;
  IF v_offer_row.variant_id IS NOT NULL
     OR v_offer_row.status <> 'expired'
     OR v_offer_row.variant_snapshot IS DISTINCT FROM '{"Color":"Black","Size":"L"}'::jsonb THEN
    RAISE EXCEPTION 'ASSERT_FAIL_T6b: pending offer on deleted V2 not expired with snapshot preserved';
  END IF;

  -- TEST 7: Authenticated buyer creates exact variant checkout + idempotent replay
  PERFORM set_config('request.jwt.claim.sub', v_buyer_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_buyer_id::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  SELECT * INTO v_chk FROM public.create_offer_checkout_atomic(v_offer_1, NULL);
  SELECT * INTO v_chk_replay FROM public.create_offer_checkout_atomic(v_offer_1, NULL);
  RESET ROLE;

  IF v_chk.id IS NULL OR v_chk.id <> v_chk_replay.id
     OR v_chk.source <> 'offer' OR v_chk.fpx_fee_sen <> 100 OR v_chk.total_paid_sen <> 2100 THEN
    RAISE EXCEPTION 'ASSERT_FAIL_T7a: checkout contract or idempotent replay failed';
  END IF;

  SELECT * INTO v_l FROM public.listings WHERE id = v_listing_id;
  SELECT * INTO v_v1 FROM public.listing_variants WHERE id = v_v1_id;
  IF v_l.reserved_quantity <> 1 OR v_v1.reserved_quantity <> 1 THEN
    RAISE EXCEPTION 'ASSERT_FAIL_T7b: checkout double-reserved stock (% / %)', v_l.reserved_quantity, v_v1.reserved_quantity;
  END IF;

  -- TEST 8: Late-payment review + expiry release (single release, preserves reconciliation evidence, idempotent)
  UPDATE public.checkout_sessions
  SET bill_creation_state = 'ready',
      bill_code = 'VERIFY_LATE_BILL',
      bill_url = 'https://dev.toyyibpay.com/VERIFY_LATE_BILL',
      payment_deadline = clock_timestamp() - interval '2 minutes'
  WHERE id = v_chk.id;

  UPDATE public.offers
  SET reservation_expires_at = clock_timestamp() - interval '2 minutes'
  WHERE id = v_offer_1;

  v_res := public.confirm_checkout_payment_atomic(
    v_chk.id, 'VERIFY_LATE_BILL', v_tx_late, 2100, '{"verify":"late"}'::jsonb
  );
  IF v_res <> 'late_payment_reconciliation' THEN
    RAISE EXCEPTION 'ASSERT_FAIL_T8a: expected late_payment_reconciliation, got %', v_res;
  END IF;

  v_released := public.release_expired_offer_reservations();
  IF v_released < 1 THEN
    RAISE EXCEPTION 'ASSERT_FAIL_T8b: late_payment_review hold was not released';
  END IF;

  SELECT * INTO v_l FROM public.listings WHERE id = v_listing_id;
  SELECT * INTO v_v1 FROM public.listing_variants WHERE id = v_v1_id;
  SELECT * INTO v_sess FROM public.checkout_sessions WHERE id = v_chk.id;
  SELECT * INTO v_ord FROM public.orders WHERE checkout_session_id = v_chk.id;
  SELECT * INTO v_offer_row FROM public.offers WHERE id = v_offer_1;

  IF v_l.quantity <> 4 OR v_l.reserved_quantity <> 0
     OR v_v1.quantity <> 2 OR v_v1.reserved_quantity <> 0 THEN
    RAISE EXCEPTION 'ASSERT_FAIL_T8c: stock mismatch after late-payment release';
  END IF;

  IF v_sess.status <> 'expired'
     OR v_sess.payment_status <> 'late_payment_review'
     OR v_sess.transaction_ref <> v_tx_late
     OR v_sess.verified_at IS NULL
     OR v_sess.raw_callback IS NULL
     OR v_ord.status <> 'expired'
     OR v_offer_row.status <> 'expired'
     OR v_offer_row.reservation_released_at IS NULL THEN
    RAISE EXCEPTION 'ASSERT_FAIL_T8d: late_payment_review state or reconciliation evidence corrupted';
  END IF;

  -- Repeat expiry sweep is idempotent
  PERFORM public.release_expired_offer_reservations();
  SELECT * INTO v_l FROM public.listings WHERE id = v_listing_id;
  SELECT * INTO v_v1 FROM public.listing_variants WHERE id = v_v1_id;
  IF v_l.reserved_quantity <> 0 OR v_v1.reserved_quantity <> 0 THEN
    RAISE EXCEPTION 'ASSERT_FAIL_T8e: repeat expiry sweep double-released stock';
  END IF;

  -- TEST 9: Successful payment deduction, repeat payment idempotency, and paid historical offer handling (FIX 2)
  PERFORM set_config('request.jwt.claim.sub', v_buyer_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_buyer_id::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  INSERT INTO public.offers (
    conversation_id, listing_id, variant_id, buyer_id, seller_id, offer_price_sen
  ) VALUES (
    v_conv_id, v_listing_id, v_v1_id, v_buyer_id, v_seller_id, 2100
  )
  RETURNING id INTO v_offer_3;

  PERFORM set_config('request.jwt.claim.sub', v_seller_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seller_id::text, 'role', 'authenticated')::text, true);
  PERFORM public.accept_offer_atomic(v_offer_3);

  PERFORM set_config('request.jwt.claim.sub', v_buyer_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_buyer_id::text, 'role', 'authenticated')::text, true);
  SELECT * INTO v_chk FROM public.create_offer_checkout_atomic(v_offer_3, NULL);
  RESET ROLE;

  UPDATE public.checkout_sessions
  SET bill_creation_state = 'ready',
      bill_code = 'VERIFY_PAID_BILL',
      bill_url = 'https://dev.toyyibpay.com/VERIFY_PAID_BILL'
  WHERE id = v_chk.id;

  v_res := public.confirm_checkout_payment_atomic(
    v_chk.id, 'VERIFY_PAID_BILL', v_tx_paid, 2200, '{"verify":"paid"}'::jsonb
  );
  v_res_replay := public.confirm_checkout_payment_atomic(
    v_chk.id, 'VERIFY_PAID_BILL', v_tx_paid, 2200, '{"verify":"paid"}'::jsonb
  );
  IF v_res <> 'confirmed_paid' OR v_res_replay <> 'already_paid' THEN
    RAISE EXCEPTION 'ASSERT_FAIL_T9a: payment confirmation/idempotency failed (%, %)', v_res, v_res_replay;
  END IF;

  SELECT * INTO v_l FROM public.listings WHERE id = v_listing_id;
  SELECT * INTO v_v1 FROM public.listing_variants WHERE id = v_v1_id;
  IF v_l.quantity <> 3 OR v_l.reserved_quantity <> 0
     OR v_v1.quantity <> 1 OR v_v1.reserved_quantity <> 0 THEN
    RAISE EXCEPTION 'ASSERT_FAIL_T9b: paid stock deduction mismatch (L:%/%, V1:%/%)',
      v_l.quantity, v_l.reserved_quantity, v_v1.quantity, v_v1.reserved_quantity;
  END IF;

  -- Paid offer must NOT be altered by expiry sweep even if reservation_expires_at is in the past
  UPDATE public.offers
  SET reservation_expires_at = clock_timestamp() - interval '5 minutes'
  WHERE id = v_offer_3;
  PERFORM public.release_expired_offer_reservations();

  SELECT * INTO v_offer_row FROM public.offers WHERE id = v_offer_3;
  IF v_offer_row.status <> 'accepted' OR v_offer_row.reservation_released_at IS NOT NULL THEN
    RAISE EXCEPTION 'ASSERT_FAIL_T9c: paid offer was altered by expiry sweep';
  END IF;

  -- Paid historical offer must NOT trigger the active-hold delete blocker (FIX 2)
  -- (Existing order_items FK may still protect the row if RESTRICT/NO ACTION; that is preserved)
  BEGIN
    DELETE FROM public.listing_variants WHERE id = v_v1_id;
  EXCEPTION
    WHEN SQLSTATE '23503' THEN
      -- Expected if order_items.variant_id FK protects historical order references
      NULL;
    WHEN SQLSTATE '42501' THEN
      RAISE EXCEPTION 'ASSERT_FAIL_T9d: historical paid offer falsely blocked variant deletion as an active hold (%)', SQLERRM;
  END;

  RAISE NOTICE 'ALL PHASE 10 BARGAINING VERIFICATION ASSERTIONS PASSED (rolling back cleanly)';
END;
$$;

ROLLBACK;
