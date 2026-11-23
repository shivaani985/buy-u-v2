-- =============================================================================
-- Buy-U Phase 5B — Minimal Migration Proposal for Atomic Bargaining
-- STATUS: PROPOSAL ONLY — DO NOT APPLY WITHOUT EXPLICIT OWNER APPROVAL
--
-- Why required:
-- 1. `public.offers` currently has no `expires_at`, `reservation_expires_at`,
--    or `reservation_released_at` columns.
-- 2. No atomic `accept_offer_atomic` or `release_expired_offer_reservations`
--    RPC exists on hosted Supabase; non-atomic JS updates risk double-accept,
--    overselling, and double-release races.
-- 3. `public.offers` must be in `supabase_realtime` for instant live card sync.
-- =============================================================================

-- 1. Extend `public.offers` with authoritative expiry & hold-release columns
ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  ADD COLUMN IF NOT EXISTS reservation_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS reservation_released_at timestamptz;

UPDATE public.offers
SET expires_at = created_at + interval '24 hours'
WHERE expires_at IS NULL;

-- Fast index for finding active 30-minute holds to reconcile/release
CREATE INDEX IF NOT EXISTS idx_offers_active_reservation
  ON public.offers (reservation_expires_at)
  WHERE status = 'accepted' AND reservation_released_at IS NULL;

-- Ensure `public.offers` publishes Realtime INSERT/UPDATE events
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'offers'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.offers;
  END IF;
END $$;

-- 2. Release expired unpaid 30-minute offer holds safely and exactly once
CREATE OR REPLACE FUNCTION public.release_expired_offer_reservations()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_offer RECORD;
  v_released_count integer := 0;
BEGIN
  FOR v_offer IN
    SELECT o.id, o.listing_id
    FROM public.offers o
    LEFT JOIN public.orders ord ON ord.id = o.order_id
    WHERE o.status = 'accepted'
      AND o.reservation_released_at IS NULL
      AND o.reservation_expires_at IS NOT NULL
      AND o.reservation_expires_at <= now()
      AND (o.order_id IS NULL OR ord.paid_at IS NULL)
    FOR UPDATE OF o SKIP LOCKED
  LOOP
    UPDATE public.listings
    SET reserved_quantity = GREATEST(0, reserved_quantity - 1),
        updated_at = now()
    WHERE id = v_offer.listing_id;

    UPDATE public.offers
    SET status = 'expired',
        reservation_released_at = now()
    WHERE id = v_offer.id
      AND reservation_released_at IS NULL;

    v_released_count := v_released_count + 1;
  END LOOP;

  RETURN v_released_count;
END;
$$;

-- 3. Atomically accept a pending offer and reserve 1 unit for 30 minutes
CREATE OR REPLACE FUNCTION public.accept_offer_atomic(p_offer_id uuid)
RETURNS public.offers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_offer public.offers;
  v_listing public.listings;
  v_now timestamptz := now();
  v_blocked boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  -- Opportunistically release any expired holds before checking stock
  PERFORM public.release_expired_offer_reservations();

  SELECT * INTO v_offer
  FROM public.offers
  WHERE id = p_offer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'OFFER_NOT_FOUND';
  END IF;

  IF v_offer.seller_id <> v_uid THEN
    RAISE EXCEPTION 'FORBIDDEN_SELLER_ONLY';
  END IF;

  IF v_offer.status <> 'pending' THEN
    RAISE EXCEPTION 'OFFER_NOT_PENDING';
  END IF;

  IF v_now >= COALESCE(v_offer.expires_at, v_offer.created_at + interval '24 hours') THEN
    UPDATE public.offers
    SET status = 'expired',
        responded_at = v_now
    WHERE id = v_offer.id;
    RAISE EXCEPTION 'OFFER_EXPIRED';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.member_blocks
    WHERE (blocker_id = v_offer.buyer_id AND blocked_id = v_offer.seller_id)
       OR (blocker_id = v_offer.seller_id AND blocked_id = v_offer.buyer_id)
  ) INTO v_blocked;

  IF v_blocked THEN
    RAISE EXCEPTION 'MEMBER_BLOCKED';
  END IF;

  SELECT * INTO v_listing
  FROM public.listings
  WHERE id = v_offer.listing_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_listing.status <> 'published'
     OR v_listing.kind <> 'pre_loved'
     OR v_listing.allow_offers IS NOT TRUE THEN
    RAISE EXCEPTION 'LISTING_NOT_ELIGIBLE';
  END IF;

  IF (v_listing.quantity - GREATEST(0, v_listing.reserved_quantity)) < 1 THEN
    RAISE EXCEPTION 'OUT_OF_STOCK';
  END IF;

  -- Reserve exactly 1 unit atomically
  UPDATE public.listings
  SET reserved_quantity = GREATEST(0, reserved_quantity) + 1,
      updated_at = v_now
  WHERE id = v_listing.id;

  UPDATE public.offers
  SET status = 'accepted',
      responded_at = v_now,
      reservation_expires_at = v_now + interval '30 minutes'
  WHERE id = v_offer.id
  RETURNING * INTO v_offer;

  RETURN v_offer;
END;
$$;

REVOKE ALL ON FUNCTION public.accept_offer_atomic(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.accept_offer_atomic(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.release_expired_offer_reservations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.release_expired_offer_reservations() TO service_role;

-- Optional scheduled reconciliation (if pg_cron is enabled on the project):
-- SELECT cron.schedule(
--   'release-expired-offer-reservations',
--   '*/2 * * * *',
--   $$SELECT public.release_expired_offer_reservations();$$
-- );
