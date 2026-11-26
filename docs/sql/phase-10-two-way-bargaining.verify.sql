-- =============================================================================
-- BUY-U PHASE 10 — TWO-WAY BARGAINING (D03 / M06) ROLLBACK-ONLY VERIFICATION
-- =============================================================================
-- Strictly wrapped in BEGIN ... ROLLBACK. Zero persistent mutations.
-- Preserves all existing user data.
-- Embedded Migration File: docs/sql/phase-10-two-way-bargaining.sql
-- Embedded Migration File SHA-256: A4DAB3754D13FB747652D6E29CD3ACE6C8A47382C61BD1F8A530D6AEE0996A29
-- Embedded Migration Body SHA-256: E3D6A6DF5CF277088EE00665A277758A02D690E8AF4EE162D36661BC0A09899F
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. EXACT EMBEDDED MIGRATION BODY (docs/sql/phase-10-two-way-bargaining.sql)
-- =============================================================================

-- 1. Additive columns on `public.offers`
ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS proposed_by uuid,
  ADD COLUMN IF NOT EXISTS parent_offer_id uuid;

UPDATE public.offers
SET proposed_by = buyer_id
WHERE proposed_by IS NULL;

ALTER TABLE public.offers
  ALTER COLUMN proposed_by SET DEFAULT auth.uid(),
  ALTER COLUMN proposed_by SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.offers'::regclass
      AND conname = 'offers_proposed_by_participant_check'
  ) THEN
    ALTER TABLE public.offers
      ADD CONSTRAINT offers_proposed_by_participant_check
      CHECK (proposed_by = buyer_id OR proposed_by = seller_id);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.offers'::regclass
      AND conname = 'offers_parent_offer_id_fkey'
  ) THEN
    ALTER TABLE public.offers DROP CONSTRAINT offers_parent_offer_id_fkey;
  END IF;

  ALTER TABLE public.offers
    ADD CONSTRAINT offers_parent_offer_id_fkey
    FOREIGN KEY (parent_offer_id)
    REFERENCES public.offers(id)
    ON DELETE SET NULL;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_offers_parent_offer_id
  ON public.offers (parent_offer_id)
  WHERE parent_offer_id IS NOT NULL;

-- 2. Expand `public.offers.status` CHECK constraint to include 'superseded'
DO $$
DECLARE
  v_con RECORD;
BEGIN
  FOR v_con IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'public.offers'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ~* '\mstatus\M'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.offers DROP CONSTRAINT %I',
      v_con.conname
    );
  END LOOP;

  ALTER TABLE public.offers
    ADD CONSTRAINT offers_status_check
    CHECK (
      status IN (
        'pending',
        'accepted',
        'declined',
        'cancelled',
        'expired',
        'superseded',
        'withdrawn',
        'rejected'
      )
    );
END;
$$;

-- 3. Sweep already-expired pending rows before enforcing single active pending slot
UPDATE public.offers
SET status = 'expired',
    responded_at = COALESCE(responded_at, clock_timestamp())
WHERE status = 'pending'
  AND COALESCE(expires_at, created_at + interval '24 hours') <= clock_timestamp();

CREATE UNIQUE INDEX IF NOT EXISTS uq_offers_one_pending_per_context
  ON public.offers (
    conversation_id,
    listing_id,
    COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE status = 'pending';

-- 4. Guard direct INSERT on `public.offers`
--    Preserves buyer-initiated offers, Phase 10 bargaining eligibility, and
--    Phase 10V variant_image_path snapshots; blocks forged counter inserts.
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
    NEW.proposed_by := COALESCE(NEW.proposed_by, NEW.buyer_id);
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

  IF NEW.proposed_by IS NOT NULL AND NEW.proposed_by IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Offer proposed_by must match the authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.parent_offer_id IS NOT NULL THEN
    RAISE EXCEPTION 'Counter-offers must be submitted via counter_offer_atomic'
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
  NEW.proposed_by := v_uid;
  NEW.parent_offer_id := NULL;
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
    NEW.variant_image_path := COALESCE(
      NULLIF(v_variant.image_path, ''),
      v_listing.image_paths[1],
      NULL
    );
  ELSE
    IF NEW.variant_id IS NOT NULL THEN
      RAISE EXCEPTION 'Unexpected variant on a non-variant listing'
        USING ERRCODE = '22023';
    END IF;

    v_available_stock := v_listing.quantity - GREATEST(0, v_listing.reserved_quantity);
    v_effective_price_sen := v_listing.price_sen;
    NEW.variant_snapshot := NULL;
    NEW.variant_image_path := v_listing.image_paths[1];
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

-- 5. Guard direct UPDATE on `public.offers`
--    Only the proposer can cancel/withdraw; only the receiving party can
--    decline directly; accepted & superseded transitions require SECURITY DEFINER RPCs.
CREATE OR REPLACE FUNCTION public.guard_offer_updates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_proposer uuid;
BEGIN
  IF current_user IN ('postgres', 'service_role') THEN
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.listing_id IS DISTINCT FROM OLD.listing_id
     OR NEW.variant_id IS DISTINCT FROM OLD.variant_id
     OR NEW.variant_snapshot IS DISTINCT FROM OLD.variant_snapshot
     OR NEW.variant_image_path IS DISTINCT FROM OLD.variant_image_path
     OR NEW.buyer_id IS DISTINCT FROM OLD.buyer_id
     OR NEW.seller_id IS DISTINCT FROM OLD.seller_id
     OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by
     OR NEW.parent_offer_id IS DISTINCT FROM OLD.parent_offer_id
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

  IF NEW.status IN ('accepted', 'superseded') THEN
    RAISE EXCEPTION 'Accepted and superseded transitions require atomic bargaining RPCs'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'Only pending offers can be updated'
      USING ERRCODE = '42501';
  END IF;

  IF clock_timestamp() >= COALESCE(OLD.expires_at, OLD.created_at + interval '24 hours') THEN
    RAISE EXCEPTION 'Expired offers cannot be updated'
      USING ERRCODE = '42501';
  END IF;

  v_proposer := COALESCE(OLD.proposed_by, OLD.buyer_id);

  IF v_uid = v_proposer THEN
    IF NEW.status NOT IN ('withdrawn', 'cancelled') THEN
      RAISE EXCEPTION 'Proposer may only cancel or withdraw their own pending offer'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_uid = OLD.buyer_id OR v_uid = OLD.seller_id THEN
    IF NEW.status NOT IN ('declined', 'rejected') THEN
      RAISE EXCEPTION 'Receiving party may only decline a pending offer directly'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'Only offer participants may update an offer'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

-- 6. Atomic Two-Way Counter Offer RPC
--    Atomically locks the pending offer + listing (+ variant), supersedes the
--    previous proposal, and creates a new 24h pending counter proposal preserving
--    the exact listing, variation, snapshot, and image.
CREATE OR REPLACE FUNCTION public.counter_offer_atomic(
  p_offer_id uuid,
  p_counter_price_sen integer
)
RETURNS public.offers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_now timestamptz;
  v_parent public.offers;
  v_new_offer public.offers;
  v_proposer uuid;
  v_conv public.conversations;
  v_listing public.listings;
  v_variant public.listing_variants;
  v_buyer_status text;
  v_seller_status text;
  v_effective_price_sen integer;
  v_available_stock integer;
  v_preserved_image_path text;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  IF p_counter_price_sen IS NULL OR p_counter_price_sen < 200 THEN
    RAISE EXCEPTION 'INVALID_OFFER_PRICE';
  END IF;

  -- Lock order: offers -> listings -> listing_variants
  SELECT * INTO v_parent
  FROM public.offers
  WHERE id = p_offer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'OFFER_NOT_FOUND';
  END IF;

  v_proposer := COALESCE(v_parent.proposed_by, v_parent.buyer_id);

  IF v_uid <> v_parent.buyer_id AND v_uid <> v_parent.seller_id THEN
    RAISE EXCEPTION 'FORBIDDEN_PARTICIPANT_ONLY';
  END IF;

  IF v_uid = v_proposer THEN
    RAISE EXCEPTION 'FORBIDDEN_RECEIVER_ONLY';
  END IF;

  IF v_parent.status <> 'pending' THEN
    RAISE EXCEPTION 'OFFER_NOT_PENDING';
  END IF;

  IF v_parent.order_id IS NOT NULL THEN
    RAISE EXCEPTION 'OFFER_ALREADY_LINKED';
  END IF;

  SELECT * INTO v_conv
  FROM public.conversations
  WHERE id = v_parent.conversation_id;

  IF NOT FOUND
     OR NOT (
       (v_conv.member_a = v_parent.buyer_id AND v_conv.member_b = v_parent.seller_id)
       OR (v_conv.member_a = v_parent.seller_id AND v_conv.member_b = v_parent.buyer_id)
     ) THEN
    RAISE EXCEPTION 'CONVERSATION_MISMATCH';
  END IF;

  IF public.is_member_blocked_between(v_parent.buyer_id, v_parent.seller_id) THEN
    RAISE EXCEPTION 'MEMBER_BLOCKED';
  END IF;

  SELECT status INTO v_buyer_status
  FROM public.profiles
  WHERE id = v_parent.buyer_id;

  SELECT status INTO v_seller_status
  FROM public.profiles
  WHERE id = v_parent.seller_id;

  IF COALESCE(lower(v_buyer_status), '') <> 'active'
     OR COALESCE(lower(v_seller_status), '') <> 'active' THEN
    RAISE EXCEPTION 'PARTICIPANT_RESTRICTED';
  END IF;

  SELECT * INTO v_listing
  FROM public.listings
  WHERE id = v_parent.listing_id
  FOR UPDATE;

  IF NOT FOUND OR v_listing.seller_id <> v_parent.seller_id THEN
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
    IF v_parent.variant_id IS NULL THEN
      RAISE EXCEPTION 'VARIANT_REQUIRED';
    END IF;

    SELECT * INTO v_variant
    FROM public.listing_variants
    WHERE id = v_parent.variant_id
      AND listing_id = v_listing.id
    FOR UPDATE;

    IF NOT FOUND OR v_variant.active IS NOT TRUE THEN
      RAISE EXCEPTION 'VARIANT_UNAVAILABLE';
    END IF;

    IF v_parent.variant_snapshot IS NOT NULL
       AND v_variant.option_values IS DISTINCT FROM v_parent.variant_snapshot THEN
      RAISE EXCEPTION 'VARIANT_OPTIONS_CHANGED';
    END IF;

    IF v_listing.reserved_quantity < 0
       OR (v_listing.quantity - v_listing.reserved_quantity) < 1 THEN
      RAISE EXCEPTION 'OUT_OF_STOCK';
    END IF;

    v_effective_price_sen := v_variant.price_sen;
    v_available_stock := CASE
      WHEN v_variant.reserved_quantity < 0 THEN 0
      ELSE v_variant.quantity - v_variant.reserved_quantity
    END;
    v_preserved_image_path := COALESCE(
      NULLIF(v_parent.variant_image_path, ''),
      NULLIF(v_variant.image_path, ''),
      v_listing.image_paths[1],
      NULL
    );
  ELSE
    IF v_parent.variant_id IS NOT NULL OR v_parent.variant_snapshot IS NOT NULL THEN
      RAISE EXCEPTION 'UNEXPECTED_VARIANT';
    END IF;

    v_effective_price_sen := v_listing.price_sen;
    v_available_stock := CASE
      WHEN v_listing.reserved_quantity < 0 THEN 0
      ELSE v_listing.quantity - v_listing.reserved_quantity
    END;
    v_preserved_image_path := COALESCE(
      NULLIF(v_parent.variant_image_path, ''),
      v_listing.image_paths[1],
      NULL
    );
  END IF;

  v_now := clock_timestamp();
  IF v_now >= COALESCE(v_parent.expires_at, v_parent.created_at + interval '24 hours') THEN
    RAISE EXCEPTION 'OFFER_EXPIRED';
  END IF;

  IF p_counter_price_sen > v_effective_price_sen THEN
    RAISE EXCEPTION 'INVALID_OFFER_PRICE';
  END IF;

  IF v_available_stock < 1 THEN
    RAISE EXCEPTION 'OUT_OF_STOCK';
  END IF;

  -- Mark previous pending proposal superseded FIRST so partial unique index stays clean
  UPDATE public.offers
  SET status = 'superseded',
      responded_at = v_now
  WHERE id = v_parent.id
    AND status = 'pending';

  -- Clean up any unswept expired pending proposals in the same negotiation context
  UPDATE public.offers
  SET status = 'expired',
      responded_at = COALESCE(responded_at, v_now)
  WHERE conversation_id = v_parent.conversation_id
    AND listing_id = v_parent.listing_id
    AND COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
        = COALESCE(v_parent.variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
    AND status = 'pending'
    AND COALESCE(expires_at, created_at + interval '24 hours') <= v_now;

  INSERT INTO public.offers (
    conversation_id,
    listing_id,
    variant_id,
    variant_snapshot,
    variant_image_path,
    buyer_id,
    seller_id,
    proposed_by,
    parent_offer_id,
    offer_price_sen,
    status,
    created_at,
    expires_at
  ) VALUES (
    v_parent.conversation_id,
    v_parent.listing_id,
    v_parent.variant_id,
    COALESCE(v_parent.variant_snapshot, v_variant.option_values),
    v_preserved_image_path,
    v_parent.buyer_id,
    v_parent.seller_id,
    v_uid,
    v_parent.id,
    p_counter_price_sen,
    'pending',
    v_now,
    v_now + interval '24 hours'
  )
  RETURNING * INTO v_new_offer;

  UPDATE public.conversations
  SET last_message_at = v_now
  WHERE id = v_parent.conversation_id;

  RETURN v_new_offer;
END;
$$;

REVOKE ALL ON FUNCTION public.counter_offer_atomic(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.counter_offer_atomic(uuid, integer) TO authenticated;

-- 7. Update `accept_offer_atomic(uuid)` for Two-Way Receiving-Party Acceptance
--    Either buyer or seller may accept when they are the RECEIVING party
--    (`auth.uid() <> COALESCE(proposed_by, buyer_id)`).
--    Still reserves exactly 1 unit (+ variant) for 30 minutes and keeps buyer
--    responsible for FPX checkout via `create_offer_checkout_atomic`.
CREATE OR REPLACE FUNCTION public.accept_offer_atomic(p_offer_id uuid)
RETURNS public.offers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_now timestamptz;
  v_offer public.offers;
  v_proposer uuid;
  v_listing public.listings;
  v_variant public.listing_variants;
  v_conv public.conversations;
  v_buyer_status text;
  v_seller_status text;
  v_available_stock integer;
  v_effective_price_sen integer;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  -- Lock order: offers -> listings -> listing_variants
  SELECT * INTO v_offer
  FROM public.offers
  WHERE id = p_offer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'OFFER_NOT_FOUND';
  END IF;

  v_proposer := COALESCE(v_offer.proposed_by, v_offer.buyer_id);

  IF v_uid <> v_offer.buyer_id AND v_uid <> v_offer.seller_id THEN
    RAISE EXCEPTION 'FORBIDDEN_PARTICIPANT_ONLY';
  END IF;

  IF v_uid = v_proposer THEN
    RAISE EXCEPTION 'FORBIDDEN_RECEIVER_ONLY';
  END IF;

  IF v_offer.buyer_id = v_offer.seller_id THEN
    RAISE EXCEPTION 'SELF_OFFER_FORBIDDEN';
  END IF;

  IF v_offer.status <> 'pending' THEN
    RAISE EXCEPTION 'OFFER_NOT_PENDING';
  END IF;

  IF v_offer.order_id IS NOT NULL THEN
    RAISE EXCEPTION 'OFFER_ALREADY_LINKED';
  END IF;

  SELECT status INTO v_buyer_status
  FROM public.profiles
  WHERE id = v_offer.buyer_id;

  SELECT status INTO v_seller_status
  FROM public.profiles
  WHERE id = v_offer.seller_id;

  IF COALESCE(lower(v_buyer_status), '') <> 'active' THEN
    RAISE EXCEPTION 'BUYER_RESTRICTED';
  END IF;

  IF COALESCE(lower(v_seller_status), '') <> 'active' THEN
    RAISE EXCEPTION 'SELLER_RESTRICTED';
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

  IF NOT FOUND OR v_listing.seller_id <> v_offer.seller_id THEN
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

    IF v_offer.variant_snapshot IS NOT NULL
       AND v_variant.option_values IS DISTINCT FROM v_offer.variant_snapshot THEN
      RAISE EXCEPTION 'VARIANT_OPTIONS_CHANGED';
    END IF;

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
    IF v_offer.variant_id IS NOT NULL OR v_offer.variant_snapshot IS NOT NULL THEN
      RAISE EXCEPTION 'UNEXPECTED_VARIANT';
    END IF;

    v_effective_price_sen := v_listing.price_sen;
    v_available_stock := CASE
      WHEN v_listing.reserved_quantity < 0 THEN 0
      ELSE v_listing.quantity - v_listing.reserved_quantity
    END;
  END IF;

  -- Revalidate 24h offer expiry using wall clock AFTER acquiring locks
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

REVOKE ALL ON FUNCTION public.accept_offer_atomic(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_offer_atomic(uuid) TO authenticated;

-- =============================================================================
-- 2. ROLLBACK VERIFICATION TESTS
-- =============================================================================
DO $verify$
DECLARE
  v_key text := 'p10_two_way_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  v_buyer uuid := gen_random_uuid();
  v_seller uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_category text;
  v_area text;
  v_listing uuid;
  v_food_listing uuid;
  v_variant uuid;
  v_conv uuid;
  v_cover text := v_seller::text || '/' || v_key || '/cover.jpg';
  v_variant_img text := v_seller::text || '/' || v_key || '/variant.jpg';
  v_offer_1 public.offers;
  v_offer_2 public.offers;
  v_offer_3 public.offers;
  v_offer_4 public.offers;
  v_offer_exp public.offers;
  v_accepted public.offers;
  v_checkout record;
  v_rejected boolean;
  v_listing_row public.listings;
  v_variant_row public.listing_variants;
  v_item public.order_items;
BEGIN
  IF has_function_privilege('anon', 'public.counter_offer_atomic(uuid,integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.counter_offer_atomic(uuid,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Unexpected counter_offer_atomic execute privileges';
  END IF;

  INSERT INTO auth.users (id, email, email_confirmed_at, raw_user_meta_data, raw_app_meta_data)
  VALUES
    (v_buyer, v_key || '_buyer@iluv.ums.edu.my', now(), '{"full_name":"Synthetic Buyer"}', '{}'),
    (v_seller, v_key || '_seller@iluv.ums.edu.my', now(), '{"full_name":"Synthetic Seller"}', '{}'),
    (v_other, v_key || '_other@iluv.ums.edu.my', now(), '{"full_name":"Synthetic Outsider"}', '{}');

  UPDATE public.profiles SET status = 'active' WHERE id IN (v_buyer, v_seller, v_other);

  SELECT id INTO STRICT v_category FROM public.categories WHERE active AND kind = 'product' ORDER BY id LIMIT 1;
  SELECT id INTO STRICT v_area FROM public.collection_areas WHERE active ORDER BY id LIMIT 1;

  INSERT INTO public.listings (
    seller_id, kind, title, description, category_id, condition, price_sen, quantity,
    reserved_quantity, collection_area_id, has_variants, option_groups, variation_photo_group,
    allow_offers, availability_mode, is_food, image_paths, rules_acknowledged, status, published_at
  ) VALUES (
    v_seller, 'pre_loved', 'Synthetic Perfume', 'Two-way bargaining verification fixture.',
    v_category, 'Like New', 3000, 3, 0, v_area, true, ARRAY['Scent'], 'Scent',
    true, 'ready', false, ARRAY[v_cover, v_variant_img], true, 'published', now()
  ) RETURNING id INTO v_listing;

  INSERT INTO public.listing_variants (listing_id, option_values, price_sen, quantity, reserved_quantity, active, image_path)
  VALUES (v_listing, '{"Scent":"Black"}', 3000, 3, 0, true, v_variant_img)
  RETURNING id INTO v_variant;

  -- Campus food remains excluded from bargaining
  INSERT INTO public.listings (
    seller_id, kind, title, description, category_id, condition, price_sen, quantity,
    reserved_quantity, collection_area_id, has_variants, allow_offers, availability_mode,
    is_food, image_paths, rules_acknowledged, status, published_at
  ) VALUES (
    v_seller, 'business', 'Synthetic Nasi Lemak', 'Excluded campus food fixture.',
    v_category, 'New/Unused', 1200, 5, 0, v_area, false, false, 'ready',
    true, ARRAY[v_cover], true, 'published', now()
  ) RETURNING id INTO v_food_listing;

  INSERT INTO public.conversations (member_a, member_b, listing_id)
  VALUES (LEAST(v_buyer, v_seller), GREATEST(v_buyer, v_seller), v_listing)
  RETURNING id INTO v_conv;

  -- Buyer inserts initial offer RM 15.00
  PERFORM set_config('request.jwt.claim.sub', v_buyer::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_buyer, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  INSERT INTO public.offers (conversation_id, listing_id, variant_id, buyer_id, seller_id, offer_price_sen)
  VALUES (v_conv, v_listing, v_variant, v_buyer, v_seller, 1500)
  RETURNING * INTO v_offer_1;

  IF v_offer_1.proposed_by <> v_buyer OR v_offer_1.parent_offer_id IS NOT NULL
     OR v_offer_1.variant_image_path IS DISTINCT FROM v_variant_img THEN
    RAISE EXCEPTION 'Initial buyer offer did not capture proposed_by or variant_image_path';
  END IF;

  -- Duplicate simultaneous pending offer blocked
  v_rejected := false;
  BEGIN
    INSERT INTO public.offers (conversation_id, listing_id, variant_id, buyer_id, seller_id, offer_price_sen)
    VALUES (v_conv, v_listing, v_variant, v_buyer, v_seller, 1600);
  EXCEPTION WHEN unique_violation THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Duplicate pending offer allowed'; END IF;

  -- Proposer (buyer) cannot accept or counter their own pending proposal
  v_rejected := false;
  BEGIN
    PERFORM public.accept_offer_atomic(v_offer_1.id);
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'FORBIDDEN_RECEIVER_ONLY' THEN RAISE; END IF;
    v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Buyer accepted own offer'; END IF;

  v_rejected := false;
  BEGIN
    PERFORM public.counter_offer_atomic(v_offer_1.id, 1700);
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'FORBIDDEN_RECEIVER_ONLY' THEN RAISE; END IF;
    v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Buyer countered own offer'; END IF;

  -- Campus food offer remains rejected
  v_rejected := false;
  BEGIN
    INSERT INTO public.offers (conversation_id, listing_id, buyer_id, seller_id, offer_price_sen)
    VALUES (v_conv, v_food_listing, v_buyer, v_seller, 800);
  EXCEPTION WHEN insufficient_privilege OR raise_exception THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Campus food listing allowed offer'; END IF;
  RESET ROLE;

  -- Outsider cannot counter or accept
  PERFORM set_config('request.jwt.claim.sub', v_other::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_rejected := false;
  BEGIN
    PERFORM public.counter_offer_atomic(v_offer_1.id, 2000);
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'FORBIDDEN_PARTICIPANT_ONLY' THEN RAISE; END IF;
    v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Outsider countered offer'; END IF;
  RESET ROLE;

  -- Seller counters RM 15 -> RM 22
  PERFORM set_config('request.jwt.claim.sub', v_seller::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seller, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  -- Direct insert/update bypasses must fail
  v_rejected := false;
  BEGIN
    INSERT INTO public.offers (conversation_id, listing_id, variant_id, buyer_id, seller_id, offer_price_sen)
    VALUES (v_conv, v_listing, v_variant, v_buyer, v_seller, 2200);
  EXCEPTION WHEN insufficient_privilege OR raise_exception THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Direct counter insert bypassed RPC'; END IF;

  SELECT * INTO STRICT v_offer_2 FROM public.counter_offer_atomic(v_offer_1.id, 2200);
  IF v_offer_2.proposed_by <> v_seller
     OR v_offer_2.parent_offer_id <> v_offer_1.id
     OR v_offer_2.offer_price_sen <> 2200
     OR v_offer_2.variant_id <> v_variant
     OR v_offer_2.variant_image_path IS DISTINCT FROM v_variant_img THEN
    RAISE EXCEPTION 'Seller counter did not preserve parent, proposer, variation, or image';
  END IF;

  -- Seller cannot accept or counter their own counter-offer
  v_rejected := false;
  BEGIN
    PERFORM public.accept_offer_atomic(v_offer_2.id);
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'FORBIDDEN_RECEIVER_ONLY' THEN RAISE; END IF;
    v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Seller accepted own counter-offer'; END IF;

  -- Superseded parent cannot be re-countered or accepted
  v_rejected := false;
  BEGIN
    PERFORM public.counter_offer_atomic(v_offer_1.id, 2100);
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'OFFER_NOT_PENDING' THEN RAISE; END IF;
    v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Superseded offer was re-countered'; END IF;
  RESET ROLE;

  IF (SELECT status FROM public.offers WHERE id = v_offer_1.id) IS DISTINCT FROM 'superseded' THEN
    RAISE EXCEPTION 'Parent offer was not marked superseded';
  END IF;

  -- Unlimited counter rounds: Buyer counters RM 18 -> Seller counters RM 19 -> Buyer accepts RM 19
  PERFORM set_config('request.jwt.claim.sub', v_buyer::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_buyer, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT * INTO STRICT v_offer_3 FROM public.counter_offer_atomic(v_offer_2.id, 1800);
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub', v_seller::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seller, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT * INTO STRICT v_offer_4 FROM public.counter_offer_atomic(v_offer_3.id, 1900);
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub', v_buyer::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_buyer, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT * INTO STRICT v_accepted FROM public.accept_offer_atomic(v_offer_4.id);

  -- Concurrent duplicate accept must fail
  v_rejected := false;
  BEGIN
    PERFORM public.accept_offer_atomic(v_offer_4.id);
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'OFFER_NOT_PENDING' THEN RAISE; END IF;
    v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Duplicate acceptance allowed'; END IF;

  -- Buyer checks out accepted counter offer atomically
  SELECT * INTO STRICT v_checkout FROM public.create_offer_checkout_atomic(v_accepted.id, v_key || '_chk');
  RESET ROLE;

  SELECT * INTO STRICT v_listing_row FROM public.listings WHERE id = v_listing;
  SELECT * INTO STRICT v_variant_row FROM public.listing_variants WHERE id = v_variant;
  SELECT oi.* INTO STRICT v_item
  FROM public.order_items oi
  JOIN public.orders o ON o.id = oi.order_id
  WHERE o.checkout_session_id = v_checkout.id;

  IF v_listing_row.reserved_quantity <> 1 OR v_variant_row.reserved_quantity <> 1
     OR v_item.unit_price_sen <> 1900 OR v_item.variant_id <> v_variant
     OR v_item.image_path IS DISTINCT FROM v_variant_img THEN
    RAISE EXCEPTION 'Accepted counter-offer checkout did not preserve reservation, price, variation, or image';
  END IF;

  -- Expired offer cannot be countered or accepted
  INSERT INTO public.offers (
    conversation_id, listing_id, variant_id, variant_snapshot, variant_image_path,
    buyer_id, seller_id, proposed_by, offer_price_sen, status, created_at, expires_at
  ) VALUES (
    v_conv, v_listing, v_variant, '{"Scent":"Black"}', v_variant_img,
    v_buyer, v_seller, v_buyer, 1400, 'pending', now() - interval '25 hours', now() - interval '1 hour'
  ) RETURNING id INTO v_offer_exp;

  PERFORM set_config('request.jwt.claim.sub', v_seller::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seller, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_rejected := false;
  BEGIN
    PERFORM public.counter_offer_atomic(v_offer_exp.id, 2000);
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'OFFER_EXPIRED' THEN RAISE; END IF;
    v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Expired offer was countered'; END IF;
  RESET ROLE;

  RAISE NOTICE 'Phase 10 Two-Way Bargaining verification passed cleanly. Rolling back.';
END;
$verify$;

ROLLBACK;
