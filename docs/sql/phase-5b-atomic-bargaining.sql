-- =============================================================================
-- Buy-U Phase 5B.1 — Safety-Reviewed Minimal Migration for Atomic Bargaining
-- STATUS: PROPOSAL ONLY — DO NOT APPLY WITHOUT EXPLICIT OWNER APPROVAL
-- TARGET PROJECT: duwwlcpdidrxkixvflag
--
-- PRE-FLIGHT READ-ONLY CHECKS (run separately before BEGIN to verify live DB):
--   1. Check existing offers triggers & constraints (ensure no legacy 5-offer cap
--      and verify status CHECK constraint allows 'pending','accepted','declined',
--      'cancelled','expired'):
--      SELECT conname, pg_get_constraintdef(oid)
--      FROM pg_constraint WHERE conrelid = 'public.offers'::regclass;
--      SELECT tgname, pg_get_triggerdef(oid)
--      FROM pg_trigger WHERE tgrelid = 'public.offers'::regclass AND NOT tgisinternal;
--   2. Check whether pg_cron is installed:
--      SELECT extname FROM pg_extension WHERE extname = 'pg_cron';
-- =============================================================================

BEGIN;

-- 1. Extend `public.offers` with authoritative 24h expiry & 30m reservation columns
--    Add nullable first so existing rows backfill from `created_at + 24h` accurately.
ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS reservation_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS reservation_released_at timestamptz;

UPDATE public.offers
SET expires_at = created_at + interval '24 hours'
WHERE expires_at IS NULL;

ALTER TABLE public.offers
  ALTER COLUMN expires_at SET DEFAULT (now() + interval '24 hours'),
  ALTER COLUMN expires_at SET NOT NULL;

-- Partial index for fast expired 30m reservation reconciliation
CREATE INDEX IF NOT EXISTS idx_offers_active_reservation
  ON public.offers (reservation_expires_at)
  WHERE status = 'accepted' AND reservation_released_at IS NULL;

-- Partial index for fast 24h pending offer expiry sweep
CREATE INDEX IF NOT EXISTS idx_offers_pending_expiry
  ON public.offers (expires_at)
  WHERE status = 'pending';

-- Guarantee 1-to-1 offer -> order mapping (prevents duplicate offer-linked orders in Phase 6)
CREATE UNIQUE INDEX IF NOT EXISTS idx_offers_unique_order_id
  ON public.offers (order_id)
  WHERE order_id IS NOT NULL;

-- 2. Publish `public.offers` to Supabase Realtime idempotently
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

-- 3. Release expired unpaid 30-minute offer reservations safely & exactly once,
--    and sweep expired 24-hour pending offers.
CREATE OR REPLACE FUNCTION public.release_expired_offer_reservations()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_offer RECORD;
  v_now timestamptz := now();
  v_released_count integer := 0;
BEGIN
  -- 3a. Sweep expired 24-hour pending offers (no stock held)
  UPDATE public.offers
  SET status = 'expired',
      responded_at = COALESCE(responded_at, v_now)
  WHERE status = 'pending'
    AND COALESCE(expires_at, created_at + interval '24 hours') <= v_now;

  -- 3b. Release expired 30-minute accepted holds that remain unpaid
  FOR v_offer IN
    SELECT o.id, o.listing_id, o.order_id
    FROM public.offers o
    LEFT JOIN public.orders ord ON ord.id = o.order_id
    WHERE o.status = 'accepted'
      AND o.reservation_released_at IS NULL
      AND o.reservation_expires_at IS NOT NULL
      AND o.reservation_expires_at <= v_now
      AND (
        o.order_id IS NULL
        OR (
          ord.status = 'pending_payment'
          AND ord.paid_at IS NULL
          AND (ord.payment_deadline IS NULL OR ord.payment_deadline <= v_now)
        )
      )
    FOR UPDATE OF o SKIP LOCKED
  LOOP
    -- Lock listing row before updating stock to keep lock ordering consistent
    PERFORM 1
    FROM public.listings
    WHERE id = v_offer.listing_id
    FOR UPDATE;

    -- Mark any linked unpaid pending_payment order expired in the same transaction
    -- so ToyyibPay checkout/webhook cannot later pay an already-released hold.
    IF v_offer.order_id IS NOT NULL THEN
      UPDATE public.orders
      SET status = 'expired',
          updated_at = v_now
      WHERE id = v_offer.order_id
        AND status = 'pending_payment'
        AND paid_at IS NULL;
    END IF;

    UPDATE public.listings
    SET reserved_quantity = GREATEST(0, reserved_quantity - 1),
        updated_at = v_now
    WHERE id = v_offer.listing_id;

    UPDATE public.offers
    SET status = 'expired',
        reservation_released_at = v_now
    WHERE id = v_offer.id
      AND reservation_released_at IS NULL;

    v_released_count := v_released_count + 1;
  END LOOP;

  RETURN v_released_count;
END;
$$;

-- 4. Atomically accept a pending offer and reserve exactly 1 unit for 30 minutes
--    Supports UNLIMITED proposals (no legacy 5-proposal cap).
CREATE OR REPLACE FUNCTION public.accept_offer_atomic(p_offer_id uuid)
RETURNS public.offers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_offer public.offers;
  v_listing public.listings;
  v_buyer_status text;
  v_now timestamptz := now();
  v_blocked boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  IF NOT public.is_active_member() THEN
    RAISE EXCEPTION 'SELLER_RESTRICTED';
  END IF;

  -- Opportunistically release any expired 30m holds before locking stock
  PERFORM public.release_expired_offer_reservations();

  -- Lock offer row first (consistent lock order: offers -> listings)
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

  IF v_offer.buyer_id = v_uid THEN
    RAISE EXCEPTION 'SELF_OFFER_FORBIDDEN';
  END IF;

  IF v_offer.status <> 'pending' THEN
    RAISE EXCEPTION 'OFFER_NOT_PENDING';
  END IF;

  IF v_offer.order_id IS NOT NULL THEN
    RAISE EXCEPTION 'OFFER_ALREADY_LINKED';
  END IF;

  -- Reject strictly after 24h server expiry (no dead UPDATE before RAISE)
  IF v_now >= COALESCE(v_offer.expires_at, v_offer.created_at + interval '24 hours') THEN
    RAISE EXCEPTION 'OFFER_EXPIRED';
  END IF;

  -- Verify buyer account is still active
  SELECT status INTO v_buyer_status
  FROM public.profiles
  WHERE id = v_offer.buyer_id;

  IF COALESCE(lower(v_buyer_status), '') <> 'active' THEN
    RAISE EXCEPTION 'BUYER_RESTRICTED';
  END IF;

  -- Enforce bidirectional member_blocks
  SELECT EXISTS (
    SELECT 1
    FROM public.member_blocks
    WHERE (blocker_id = v_offer.buyer_id AND blocked_id = v_offer.seller_id)
       OR (blocker_id = v_offer.seller_id AND blocked_id = v_offer.buyer_id)
  ) INTO v_blocked;

  IF v_blocked THEN
    RAISE EXCEPTION 'MEMBER_BLOCKED';
  END IF;

  -- Lock listing row before checking & reserving stock
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

  -- Atomically reserve exactly 1 unit for 30 minutes
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

-- 5. Automatic scheduled release if pg_cron is enabled on this Supabase project
--    (App server also calls `reconcileExpiredOfferReservations()` opportunistically
--    via service_role on listing/cart/messages reads as a guaranteed fallback.)
DO $$
DECLARE
  v_job_id bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    SELECT jobid INTO v_job_id
    FROM cron.job
    WHERE jobname = 'buyu_release_expired_offer_reservations'
    LIMIT 1;

    IF v_job_id IS NOT NULL THEN
      PERFORM cron.unschedule(v_job_id);
    END IF;

    PERFORM cron.schedule(
      'buyu_release_expired_offer_reservations',
      '*/2 * * * *',
      'SELECT public.release_expired_offer_reservations();'
    );
  END IF;
END $$;

COMMIT;

-- =============================================================================
-- ROLLBACK PLAN (if ever needed after approval; preserves existing rows):
--   BEGIN;
--   DO $$
--   DECLARE v_job_id bigint;
--   BEGIN
--     IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
--       SELECT jobid INTO v_job_id FROM cron.job
--       WHERE jobname = 'buyu_release_expired_offer_reservations' LIMIT 1;
--       IF v_job_id IS NOT NULL THEN PERFORM cron.unschedule(v_job_id); END IF;
--     END IF;
--   END $$;
--   DROP FUNCTION IF EXISTS public.accept_offer_atomic(uuid);
--   DROP FUNCTION IF EXISTS public.release_expired_offer_reservations();
--   DROP INDEX IF EXISTS public.idx_offers_unique_order_id;
--   DROP INDEX IF EXISTS public.idx_offers_pending_expiry;
--   DROP INDEX IF EXISTS public.idx_offers_active_reservation;
--   ALTER TABLE public.offers
--     DROP COLUMN IF EXISTS reservation_released_at,
--     DROP COLUMN IF EXISTS reservation_expires_at,
--     DROP COLUMN IF EXISTS expires_at;
--   COMMIT;
-- =============================================================================
