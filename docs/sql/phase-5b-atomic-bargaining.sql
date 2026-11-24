-- =============================================================================
-- Buy-U Phase 5B.2 — Final Safety-Reviewed Migration for Atomic Bargaining
-- STATUS: PROPOSAL ONLY — DO NOT EXECUTE WITHOUT EXPLICIT OWNER APPROVAL
-- TARGET PROJECT: duwwlcpdidrxkixvflag
--
-- Verified against live hosted schema:
-- - `offers.status` already permits 'pending','accepted','declined','cancelled','expired'.
-- - `trg_guard_offer_updates` exists on `public.offers`.
-- - UNIQUE constraint on `offers.order_id` already exists (no duplicate index added).
-- - `pg_cron` is available on this project but NOT yet installed.
-- - Unlimited proposals preserved (no legacy 5-proposal cap).
-- - All existing listings, orders, reservations, and offers remain untouched.
--
-- Phase 6 Late-Payment Reconciliation Contract:
-- - Checkout/bill creation MUST reject any offer where `now() >= reservation_expires_at`
--   or any order where `status <> 'pending_payment'` or `now() >= payment_deadline`,
--   even if the background sweeper has not run yet.
-- - If a ToyyibPay webhook confirms payment AFTER an order was marked 'expired'
--   and its reserved unit released, Phase 6 MUST NOT re-deduct stock or oversell;
--   it must log the payment for refund/admin reconciliation and notify buyer/admin.
-- =============================================================================

BEGIN;

-- 1. Extend `public.offers` with authoritative 24h expiry & 30m reservation columns
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

-- 2. Harden existing `guard_offer_updates()` trigger:
--    - Blocks direct seller UPDATE to `status = 'accepted'` (must use `accept_offer_atomic`)
--    - Protects new expiry/reservation columns from direct authenticated mutation
--    - Preserves authorized buyer cancel/withdraw and seller decline/reject on unexpired pending offers
CREATE OR REPLACE FUNCTION public.guard_offer_updates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF current_user IN ('postgres', 'service_role') OR public.is_active_admin() THEN
    RETURN NEW;
  END IF;

  -- Immutable identity, pricing, order-link, and server-managed expiry/reservation fields
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.listing_id IS DISTINCT FROM OLD.listing_id
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

  -- Only pending offers may transition
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'Only pending offers can be updated'
      USING ERRCODE = '42501';
  END IF;

  -- Enforce 24-hour expiry even before background sweep runs
  IF now() >= COALESCE(OLD.expires_at, OLD.created_at + interval '24 hours') THEN
    RAISE EXCEPTION 'Expired offers cannot be updated'
      USING ERRCODE = '42501';
  END IF;

  -- Enforce participant role transitions
  IF v_uid = OLD.buyer_id THEN
    IF NEW.status NOT IN ('withdrawn', 'cancelled') THEN
      RAISE EXCEPTION 'Buyers may only cancel or withdraw their own pending offer'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_uid = OLD.seller_id THEN
    IF NEW.status = 'accepted' THEN
      RAISE EXCEPTION 'Offers must be accepted via accept_offer_atomic to reserve stock atomically'
        USING ERRCODE = '42501';
    END IF;
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

-- 3. Publish `public.offers` to Supabase Realtime idempotently
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

-- 4. Release expired unpaid 30-minute offer reservations safely & exactly once,
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
  -- 4a. Sweep expired 24-hour pending offers (no stock held)
  UPDATE public.offers
  SET status = 'expired',
      responded_at = COALESCE(responded_at, v_now)
  WHERE status = 'pending'
    AND COALESCE(expires_at, created_at + interval '24 hours') <= v_now;

  -- 4b. Release expired 30-minute accepted holds that remain unpaid
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
    -- Consistent lock order: offers -> listings
    PERFORM 1
    FROM public.listings
    WHERE id = v_offer.listing_id
    FOR UPDATE;

    -- Mark linked unpaid pending_payment order expired in the same transaction
    -- so Phase 6 checkout cannot treat it as payable.
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

-- 5. Atomically accept a pending offer and reserve exactly 1 unit for 30 minutes
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

  -- Reject strictly after 24h server expiry
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

COMMIT;

-- =============================================================================
-- REQUIRED SCHEDULER SETUP (REQUIRES EXPLICIT OWNER APPROVAL)
-- Note: Page-visit opportunistic reconciliation is best-effort only and MUST NOT
-- be relied on as the sole expiry mechanism. Choose ONE scheduler below:
--
-- OPTION A (Recommended — Native Supabase pg_cron, every 2 minutes):
--   CREATE EXTENSION IF NOT EXISTS pg_cron;
--   SELECT cron.schedule(
--     'buyu_release_expired_offer_reservations',
--     '*/2 * * * *',
--     $$SELECT public.release_expired_offer_reservations();$$
--   );
--
-- OPTION B (Alternative — External Cron / Vercel Cron):
--   Configure a 2-minute scheduled POST to a CRON_SECRET-protected route that
--   calls `service.rpc('release_expired_offer_reservations')`.
-- =============================================================================

-- =============================================================================
-- ROLLBACK PLAN (if ever needed after approval; preserves existing rows):
--   BEGIN;
--   -- If Option A pg_cron was enabled:
--   -- SELECT cron.unschedule(jobid) FROM cron.job
--   --   WHERE jobname = 'buyu_release_expired_offer_reservations';
--   DROP FUNCTION IF EXISTS public.accept_offer_atomic(uuid);
--   DROP FUNCTION IF EXISTS public.release_expired_offer_reservations();
--   DROP INDEX IF EXISTS public.idx_offers_pending_expiry;
--   DROP INDEX IF EXISTS public.idx_offers_active_reservation;
--   ALTER TABLE public.offers
--     DROP COLUMN IF EXISTS reservation_released_at,
--     DROP COLUMN IF EXISTS reservation_expires_at,
--     DROP COLUMN IF EXISTS expires_at;
--   COMMIT;
-- =============================================================================
