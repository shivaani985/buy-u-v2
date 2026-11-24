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

-- 1b. Narrowly scoped bidirectional block helper:
--     `member_blocks` RLS only exposes rows where `auth.uid() = blocker_id`,
--     so SECURITY INVOKER triggers cannot see `seller -> buyer` blocks directly.
--     This helper returns ONLY a boolean and restricts authenticated callers
--     strictly to pairs involving their own `auth.uid()`.
CREATE OR REPLACE FUNCTION public.is_member_blocked_between(
  p_user_a uuid,
  p_user_b uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF p_user_a IS NULL OR p_user_b IS NULL THEN
    RETURN false;
  END IF;

  IF current_user NOT IN ('postgres', 'service_role')
     AND (v_uid IS NULL OR (v_uid <> p_user_a AND v_uid <> p_user_b)) THEN
    RAISE EXCEPTION 'Forbidden block status lookup'
      USING ERRCODE = '42501';
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.member_blocks
    WHERE (blocker_id = p_user_a AND blocked_id = p_user_b)
       OR (blocker_id = p_user_b AND blocked_id = p_user_a)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.is_member_blocked_between(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_member_blocked_between(uuid, uuid) TO authenticated, service_role;

-- 2a. Add `BEFORE INSERT` guard trigger on `public.offers`:
--     - Blocks forged status != 'pending', pre-linked order_id, responded_at,
--       or reservation fields so NO authenticated/admin user can bypass atomic acceptance
--     - Authoritatively stamps `created_at = now()` and `expires_at = created_at + 24h`
--       (overriding any forged client timestamps)
--     - Enforces conversation participants, listing ownership, published Pre-Loved
--       `allow_offers = true`, stock >= 1, member_blocks, and RM 2.00..listing price
--     - Preserves UNLIMITED proposals (zero 5-proposal cap)
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
BEGIN
  -- Strictly restrict bypass to postgres and service_role (never authenticated/admin)
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

  -- Block forged non-pending status and all server-managed lifecycle columns
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

  -- Authoritatively override client timestamps so 24h expiry cannot be forged
  NEW.status := 'pending';
  NEW.created_at := v_now;
  NEW.expires_at := v_now + interval '24 hours';

  -- Verify buyer & seller match the linked conversation participants
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

  -- Enforce bidirectional member_blocks (buyer->seller AND seller->buyer)
  IF public.is_member_blocked_between(NEW.buyer_id, NEW.seller_id) THEN
    RAISE EXCEPTION 'Offers are unavailable for blocked members'
      USING ERRCODE = '42501';
  END IF;

  -- Verify listing ownership, Pre-Loved allow_offers eligibility, stock, and price bounds
  SELECT * INTO v_listing
  FROM public.listings
  WHERE id = NEW.listing_id;

  IF NOT FOUND OR v_listing.seller_id <> NEW.seller_id THEN
    RAISE EXCEPTION 'Offer seller does not match listing owner'
      USING ERRCODE = '42501';
  END IF;

  IF v_listing.status <> 'published'
     OR v_listing.kind <> 'pre_loved'
     OR v_listing.allow_offers IS NOT TRUE THEN
    RAISE EXCEPTION 'Offers are only allowed on published Pre-Loved listings with offers enabled'
      USING ERRCODE = '42501';
  END IF;

  IF (v_listing.quantity - GREATEST(0, v_listing.reserved_quantity)) < 1 THEN
    RAISE EXCEPTION 'This listing is currently out of stock'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.offer_price_sen IS NULL
     OR NEW.offer_price_sen < 200
     OR NEW.offer_price_sen > v_listing.price_sen THEN
    RAISE EXCEPTION 'Offer price must be between RM 2.00 and the listing price'
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_offer_inserts ON public.offers;
CREATE TRIGGER trg_guard_offer_inserts
  BEFORE INSERT ON public.offers
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_offer_inserts();

-- 2b. Harden existing `guard_offer_updates()` trigger:
--    - Blocks ALL direct authenticated AND admin UPDATE to `status = 'accepted'`
--      (only `postgres` / `service_role`, i.e. `accept_offer_atomic`, can accept)
--    - Protects new expiry/reservation columns from direct mutation
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
  -- Strictly restrict bypass to postgres (SECURITY DEFINER RPCs) and service_role.
  -- Active admins on `authenticated` CANNOT bypass stock reservation via direct UPDATE.
  IF current_user IN ('postgres', 'service_role') THEN
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

  -- Explicitly block direct status = 'accepted' for every authenticated/admin caller
  IF NEW.status = 'accepted' THEN
    RAISE EXCEPTION 'Offers must be accepted via accept_offer_atomic to reserve stock atomically'
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
  --     Enforces strict 30-minute offer hold expiry EVEN IF a linked unpaid order
  --     has a later payment_deadline, expiring that unpaid order atomically.
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
  v_conv public.conversations;
  v_listing public.listings;
  v_buyer_status text;
  v_now timestamptz := now();
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

  -- Verify offer buyer & seller match the linked conversation participants
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

  -- Enforce bidirectional member_blocks (buyer->seller AND seller->buyer)
  IF public.is_member_blocked_between(v_offer.buyer_id, v_offer.seller_id) THEN
    RAISE EXCEPTION 'MEMBER_BLOCKED';
  END IF;

  -- Lock listing row before checking ownership, pricing & reserving stock
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
     OR v_listing.kind <> 'pre_loved'
     OR v_listing.allow_offers IS NOT TRUE THEN
    RAISE EXCEPTION 'LISTING_NOT_ELIGIBLE';
  END IF;

  -- Enforce RM 2.00 minimum and cap at listing price
  IF v_offer.offer_price_sen < 200
     OR v_offer.offer_price_sen > v_listing.price_sen THEN
    RAISE EXCEPTION 'INVALID_OFFER_PRICE';
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
--   DROP TRIGGER IF EXISTS trg_guard_offer_inserts ON public.offers;
--   DROP FUNCTION IF EXISTS public.guard_offer_inserts();
--   DROP FUNCTION IF EXISTS public.is_member_blocked_between(uuid, uuid);
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
