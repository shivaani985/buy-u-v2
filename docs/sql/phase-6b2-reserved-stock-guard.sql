-- =============================================================================
-- Buy-U Phase 6B.2 — Reserved Stock Security Hotfix (Check 7 ONLY)
-- STATUS: PROPOSAL ONLY — DO NOT APPLY WITHOUT EXPLICIT OWNER APPROVAL
-- TARGET PROJECT: duwwlcpdidrxkixvflag
--
-- Fixes hosted QA Check 7 blocker:
--   Authenticated sellers could directly `UPDATE listings SET reserved_quantity = 0`
--   (and similarly tamper with `listing_variants.reserved_quantity`), bypassing
--   `listings_check` (`quantity >= reserved_quantity`) in two steps and breaking
--   active buyer stock holds.
--
-- Design guarantees:
--   1. SECURITY INVOKER trigger function checks `current_user IN ('authenticated', 'anon')`.
--      - Direct PostgREST INSERT/UPDATE/DELETE by `authenticated`/`anon` -> guarded.
--      - Authorized SECURITY DEFINER RPCs owned by `postgres` (`create_cart_orders_atomic`,
--        `accept_offer_atomic`, `release_expired_offer_reservations`,
--        `release_expired_cart_orders`, `confirm_order_payment_atomic`) run with
--        `current_user = 'postgres'` -> NOT blocked even when invoked by authenticated users.
--      - `service_role` and `pg_cron` Jobs 1 & 2 -> NOT blocked.
--   2. Rejects unauthorized direct `reserved_quantity` mutations with SQLSTATE 42501:
--      - INSERT: forbids non-zero `reserved_quantity` (default 0 / explicit 0 allowed).
--      - UPDATE: forbids changing `reserved_quantity`, setting `quantity < OLD.reserved_quantity`,
--        toggling `listings.has_variants` while `OLD.reserved_quantity > 0`, or deactivating /
--        re-parenting a `listing_variants` row while `OLD.reserved_quantity > 0`.
--      - DELETE: forbids deleting a `listings` or `listing_variants` row while
--        `OLD.reserved_quantity > 0`.
--   3. Preserves legitimate seller listing creation (`reserved_quantity = 0`), edits
--      (title, description, price, status, images, safe `quantity >= reserved_quantity`),
--      and `update_listing_atomic`.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.guard_reserved_stock_mutations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Only enforce against direct client roles (`authenticated` / `anon`).
  -- Authorized SECURITY DEFINER RPCs execute as `postgres`; cron & server jobs as `postgres`/`service_role`.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.reserved_quantity, 0) <> 0 THEN
      RAISE EXCEPTION 'Direct reservation values on INSERT are forbidden'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.reserved_quantity IS DISTINCT FROM OLD.reserved_quantity THEN
      RAISE EXCEPTION 'Direct modification of reserved_quantity is forbidden'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.quantity IS NOT NULL AND NEW.quantity < COALESCE(OLD.reserved_quantity, 0) THEN
      RAISE EXCEPTION 'Quantity cannot be reduced below active reserved_quantity'
        USING ERRCODE = '42501';
    END IF;

    IF TG_TABLE_NAME = 'listings' THEN
      IF COALESCE(OLD.reserved_quantity, 0) > 0
         AND NEW.has_variants IS DISTINCT FROM OLD.has_variants THEN
        RAISE EXCEPTION 'Cannot change variant mode while reservations are active'
          USING ERRCODE = '42501';
      END IF;
    ELSIF TG_TABLE_NAME = 'listing_variants' THEN
      IF NEW.listing_id IS DISTINCT FROM OLD.listing_id THEN
        RAISE EXCEPTION 'Cannot reassign variant to another listing'
          USING ERRCODE = '42501';
      END IF;

      IF COALESCE(OLD.reserved_quantity, 0) > 0
         AND NEW.active IS NOT TRUE THEN
        RAISE EXCEPTION 'Cannot deactivate variant while reservations are active'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF COALESCE(OLD.reserved_quantity, 0) > 0 THEN
      RAISE EXCEPTION 'Cannot delete inventory with active reservations'
        USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_listings_reserved_stock ON public.listings;
CREATE TRIGGER trg_guard_listings_reserved_stock
  BEFORE INSERT OR UPDATE OR DELETE ON public.listings
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_reserved_stock_mutations();

DROP TRIGGER IF EXISTS trg_guard_listing_variants_reserved_stock ON public.listing_variants;
CREATE TRIGGER trg_guard_listing_variants_reserved_stock
  BEFORE INSERT OR UPDATE OR DELETE ON public.listing_variants
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_reserved_stock_mutations();

COMMIT;

-- =============================================================================
-- TARGETED HOSTED RETEST PLAN (run after owner applies this hotfix):
--   1. Seller direct INSERT into `listings` / `listing_variants` with `reserved_quantity = 1`
--      -> MUST FAIL with SQLSTATE 42501.
--   2. Seller direct INSERT with `reserved_quantity = 0` (normal create flow) -> MUST SUCCEED.
--   3. With active reservation (`reserved_quantity > 0`) on `listings` and `listing_variants`:
--      a. Seller direct `UPDATE listings SET reserved_quantity = 0` -> MUST FAIL (42501).
--      b. Seller direct `UPDATE listing_variants SET reserved_quantity = 0` -> MUST FAIL (42501).
--      c. Seller direct `UPDATE listings SET quantity = 0` -> MUST FAIL (42501 / listings_check).
--      d. Seller direct `UPDATE listing_variants SET quantity = 0` -> MUST FAIL (42501).
--      e. Seller direct `UPDATE listing_variants SET active = false` -> MUST FAIL (42501).
--      f. Seller direct `DELETE` on reserved listing or variant -> MUST FAIL (42501).
--      g. Seller legitimate edit (`price_sen`, `title`, safe `quantity >= reserved_quantity`) -> MUST SUCCEED.
--   4. Authenticated buyer `create_cart_orders_atomic`, seller `accept_offer_atomic`,
--      `confirm_order_payment_atomic`, and `pg_cron` Jobs 1 & 2 -> MUST ALL SUCCEED.
--   5. 0-diff cleanup verified across all 9 tables.
-- =============================================================================
-- ROLLBACK SQL (if ever needed):
--   BEGIN;
--   DROP TRIGGER IF EXISTS trg_guard_listing_variants_reserved_stock ON public.listing_variants;
--   DROP TRIGGER IF EXISTS trg_guard_listings_reserved_stock ON public.listings;
--   DROP FUNCTION IF EXISTS public.guard_reserved_stock_mutations();
--   COMMIT;
-- =============================================================================
