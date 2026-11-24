-- =============================================================================
-- Buy-U Phase 6B.4 — Targeted Hotfix for `release_expired_offer_reservations()`
-- STATUS: PROPOSAL ONLY — DO NOT APPLY WITHOUT EXPLICIT OWNER APPROVAL
-- TARGET PROJECT: duwwlcpdidrxkixvflag
--
-- Root Cause Found During Hosted PostgreSQL Acceptance (Check 5):
--   `public.offers` does not have an `updated_at` column.
--   `release_expired_offer_reservations()` (installed by phase-6b4-unified-checkout.sql)
--   referenced `updated_at = v_now` in two `UPDATE public.offers` statements,
--   raising PostgreSQL 42703 in both pg_cron Job 1 and `accept_offer_atomic()`.
--
-- Fix:
--   Remove the two `updated_at = v_now` assignments on `public.offers`.
--   Preserves exact lock order (`offers -> checkout_sessions -> orders -> listings`),
--   exact reservation decrement, and `service_role`-only EXECUTE grant.
-- =============================================================================

BEGIN;

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
  SET status = 'expired'
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
          reservation_released_at = v_now
      WHERE id = v_rec.id;

      v_released := v_released + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'release_expired_offer_reservations skipped offer % due to %', v_rec.id, SQLERRM;
    END;
  END LOOP;

  RETURN v_released;
END;
$$;

REVOKE ALL ON FUNCTION public.release_expired_offer_reservations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_expired_offer_reservations() TO service_role;

COMMIT;
