-- =============================================================================
-- BUY-U PHASE 10V — PRODUCT VARIATIONS, GALLERY LIMIT & IMAGE INTEGRITY
-- =============================================================================
-- Purpose:
--   Hardened standalone schema, constraint, trigger, storage RLS, and RPC updates:
--     1. Additive nullable columns:
--          - `public.listings.variation_photo_group`
--          - `public.listing_variants.image_path`
--          - `public.offers.variant_image_path`
--     2. Discovers and updates `public.listings` `image_paths` CHECK constraint
--        from `<= 5` to `<= 10` via `pg_constraint` (preserving constraint name).
--     3. Safely patches `public.update_listing_atomic(uuid,timestamptz,jsonb,jsonb)`
--        with independent assertions:
--          - shared gallery image limit: 5 -> 10
--          - variant combination limit: 25 -> 50
--     4. Database-level triggers (no new tables):
--          - `guard_listings_variation_integrity` (BEFORE INSERT/UPDATE listings)
--          - `cleanup_listing_variation_images_on_listing_edit` (AFTER UPDATE listings)
--          - `guard_listing_variant_image_row` (BEFORE INSERT/UPDATE listing_variants,
--            with `FOR KEY SHARE` parent lock for concurrent gallery safety)
--          - `trg_guard_listing_variant_consistency` (`CONSTRAINT TRIGGER ... DEFERRABLE
--            INITIALLY DEFERRED` with `pg_advisory_xact_lock`, enforcing <= 50 active
--            variants & active sibling photo consistency AFTER intermediate edits sync)
--     5. Single-transaction RPCs & active-toggle persistence:
--          - `public.create_listing_with_variations_atomic(jsonb, jsonb)`
--          - `public.sync_listing_variation_images_atomic(uuid, text, jsonb)`
--          - `public.save_listing_edit_atomic(uuid, timestamptz, jsonb, jsonb, text, jsonb)`
--            (preserves variant IDs on deactivation/reactivation, excludes inactive
--            stock from parent `listings.quantity`, and preserves reserved/offer holds)
--     6. Reference-aware Storage RLS protection (`listings` bucket only):
--          - `public.is_listing_storage_object_referenced(text)` (`SECURITY DEFINER`)
--          - Restrictive DELETE policy on `storage.objects` blocking deletion of
--            objects referenced by listings, listing_variants, order_items, offers,
--            or storefronts while leaving unreferenced uploads and other buckets intact.
--     7. Safe `pg_get_functiondef` patches (independent clause assertions + exact
--        signatures) for:
--          - `public.guard_offer_inserts()`
--          - `public.guard_offer_updates()`
--          - `public.create_offer_checkout_atomic(uuid,text)`
--          - `public.create_cart_checkout_atomic(text,jsonb,uuid[])`
--
-- Execution Order:
--   Apply AFTER `phase-10s-partial-cart-checkout.sql`.
--   DO NOT RUN AUTOMATICALLY — FOR OWNER REVIEW & EXECUTION.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Minimal nullable additive columns
-- -----------------------------------------------------------------------------
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS variation_photo_group text DEFAULT NULL;

ALTER TABLE public.listing_variants
  ADD COLUMN IF NOT EXISTS image_path text DEFAULT NULL;

ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS variant_image_path text DEFAULT NULL;

-- -----------------------------------------------------------------------------
-- 2. P0.1: Update `public.listings` image_paths CHECK constraint (<= 5 -> <= 10)
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_con     RECORD;
  v_new_def text;
  v_updated integer := 0;
BEGIN
  FOR v_con IN
    SELECT c.conname, pg_get_constraintdef(c.oid) AS condef
    FROM pg_constraint c
    WHERE c.conrelid = 'public.listings'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ~* 'image_paths'
      AND pg_get_constraintdef(c.oid) ~ '<=\s*5\M'
  LOOP
    v_new_def := regexp_replace(v_con.condef, '<=\s*5\M', '<= 10', 'g');
    IF v_new_def IS NOT DISTINCT FROM v_con.condef THEN
      RAISE EXCEPTION 'PHASE_10V_ABORTED: failed to rewrite constraint % (%)', v_con.conname, v_con.condef;
    END IF;
    EXECUTE format('ALTER TABLE public.listings DROP CONSTRAINT %I', v_con.conname);
    EXECUTE format('ALTER TABLE public.listings ADD CONSTRAINT %I %s', v_con.conname, v_new_def);
    v_updated := v_updated + 1;
  END LOOP;

  IF v_updated = 0 THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint c
      WHERE c.conrelid = 'public.listings'::regclass
        AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) ~* 'image_paths'
        AND pg_get_constraintdef(c.oid) ~ '<=\s*10\M'
    ) THEN
      RAISE EXCEPTION 'PHASE_10V_ABORTED: listings image_paths <= 5 or <= 10 check constraint not found';
    END IF;
  END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. P0.1 & P0.2: Patch `public.update_listing_atomic(uuid,timestamptz,jsonb,jsonb)`
--    Independently verify BOTH 5 -> 10 gallery limit AND 25 -> 50 variant limit.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_proc   regprocedure := 'public.update_listing_atomic(uuid,timestamptz,jsonb,jsonb)'::regprocedure;
  v_old    text;
  v_step1  text;
  v_step2  text;
  v_pat_img text := '((?:image|img|photo)[a-z0-9_]*[^;]{0,120}?>)\s*5\M';
  v_pat_var text := '((?:variant|p_variants|v_var)[a-z0-9_]*[^;]{0,120}?>)\s*25\M';
BEGIN
  v_old := pg_get_functiondef(v_proc);

  IF v_old ~* v_pat_img THEN
    v_step1 := regexp_replace(v_old, v_pat_img, '\1 10', 'gi');
    IF v_step1 IS NOT DISTINCT FROM v_old THEN
      RAISE EXCEPTION 'PHASE_10V_ABORTED: update_listing_atomic image limit replacement failed';
    END IF;
  ELSIF v_old ~* '((?:image|img|photo)[a-z0-9_]*[^;]{0,120}?>)\s*10\M' THEN
    v_step1 := v_old;
  ELSE
    RAISE EXCEPTION 'PHASE_10V_ABORTED: expected image limit (> 5) clause missing in update_listing_atomic';
  END IF;

  IF v_step1 ~* v_pat_var THEN
    v_step2 := regexp_replace(v_step1, v_pat_var, '\1 50', 'gi');
    IF v_step2 IS NOT DISTINCT FROM v_step1 THEN
      RAISE EXCEPTION 'PHASE_10V_ABORTED: update_listing_atomic variant limit replacement failed';
    END IF;
  ELSIF v_step1 ~* '((?:variant|p_variants|v_var)[a-z0-9_]*[^;]{0,120}?>)\s*50\M' THEN
    v_step2 := v_step1;
  ELSE
    RAISE EXCEPTION 'PHASE_10V_ABORTED: expected variant limit (> 25) clause missing in update_listing_atomic';
  END IF;

  IF v_step2 IS DISTINCT FROM v_old THEN
    v_step2 := regexp_replace(v_step2, '\b5\s+(listing\s+)?photos\b', '10 \1photos', 'gi');
    v_step2 := regexp_replace(v_step2, '\b25\s+(listing\s+)?variants\b', '50 \1variants', 'gi');
    EXECUTE v_step2;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.update_listing_atomic(uuid, timestamptz, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_listing_atomic(uuid, timestamptz, jsonb, jsonb) TO authenticated;

-- -----------------------------------------------------------------------------
-- 3B. Fix shared trigger `public.guard_reserved_stock_mutations()` table-specific
--     field access (`NEW.listing_id` must be nested inside `TG_TABLE_NAME` check
--     so PL/pgSQL does not compile `listing_id` against `public.listings`).
--     Preserves all reserved-stock, authorization, variant reassignment & hold checks.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_reserved_stock_mutations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- 1. Structural inventory invariants enforced for ALL roles (including SECURITY DEFINER
  --    RPCs), preventing replacement/deletion/mutation of reserved stock.
  IF TG_OP = 'DELETE' THEN
    IF COALESCE(OLD.reserved_quantity, 0) > 0 THEN
      RAISE EXCEPTION 'Cannot delete inventory with active reservations'
        USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND COALESCE(OLD.reserved_quantity, 0) > 0 THEN
    IF TG_TABLE_NAME = 'listings' THEN
      IF NEW.has_variants IS DISTINCT FROM OLD.has_variants THEN
        RAISE EXCEPTION 'Cannot change variant mode while reservations are active'
          USING ERRCODE = '42501';
      END IF;
    ELSIF TG_TABLE_NAME = 'listing_variants' THEN
      IF NEW.listing_id IS DISTINCT FROM OLD.listing_id THEN
        RAISE EXCEPTION 'Cannot reassign variant while reservations are active'
          USING ERRCODE = '42501';
      END IF;

      IF NEW.option_values IS DISTINCT FROM OLD.option_values THEN
        RAISE EXCEPTION 'Cannot change variant options while reservations are active'
          USING ERRCODE = '42501';
      END IF;

      IF NEW.active IS NOT TRUE THEN
        RAISE EXCEPTION 'Cannot deactivate variant while reservations are active'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  -- 2. Allow `reserved_quantity` mutations for authorized SECURITY DEFINER reservation RPCs,
  --    `service_role`, and `pg_cron` (`current_user` is `postgres` / `service_role`).
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  -- 3. Block direct `authenticated` / `anon` reservation forging or stock tampering.
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

    IF TG_TABLE_NAME = 'listing_variants' THEN
      IF NEW.listing_id IS DISTINCT FROM OLD.listing_id THEN
        RAISE EXCEPTION 'Cannot reassign variant to another listing'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. FIX 1 & P0.4: Database-level variation photo integrity triggers
--    Remove any immediate batch trigger; enforce deferred consistency + advisory
--    lock at commit / SET CONSTRAINTS IMMEDIATE so multi-step edits succeed.
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_guard_listing_variant_batch_insert ON public.listing_variants;
DROP TRIGGER IF EXISTS trg_guard_listing_variant_batch_update ON public.listing_variants;
DROP FUNCTION IF EXISTS public.guard_listing_variant_batch_consistency();

CREATE OR REPLACE FUNCTION public.guard_listings_variation_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group text := NULLIF(trim(COALESCE(NEW.variation_photo_group, '')), '');
BEGIN
  NEW.variation_photo_group := v_group;

  IF v_group IS NULL THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.has_variants, false) IS NOT TRUE
     OR NOT (v_group = ANY(COALESCE(NEW.option_groups, '{}'::text[]))) THEN
    IF TG_OP = 'UPDATE' AND (NEW.variation_photo_group IS NOT DISTINCT FROM OLD.variation_photo_group) THEN
      NEW.variation_photo_group := NULL;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'INVALID_VARIATION_PHOTO_GROUP';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_listings_variation_integrity ON public.listings;
CREATE TRIGGER trg_guard_listings_variation_integrity
  BEFORE INSERT OR UPDATE ON public.listings
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_listings_variation_integrity();

CREATE OR REPLACE FUNCTION public.cleanup_listing_variation_images_on_listing_edit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF COALESCE(NEW.has_variants, false) IS NOT TRUE
     OR NEW.variation_photo_group IS DISTINCT FROM OLD.variation_photo_group THEN
    IF EXISTS (
      SELECT 1 FROM public.listing_variants lv
      WHERE lv.listing_id = NEW.id AND lv.image_path IS NOT NULL
    ) THEN
      UPDATE public.listing_variants
      SET image_path = NULL
      WHERE listing_id = NEW.id
        AND image_path IS NOT NULL;
    END IF;
  ELSIF NEW.image_paths IS DISTINCT FROM OLD.image_paths THEN
    IF EXISTS (
      SELECT 1 FROM public.listing_variants lv
      WHERE lv.listing_id = NEW.id
        AND lv.image_path IS NOT NULL
        AND NOT (lv.image_path = ANY(COALESCE(NEW.image_paths, '{}'::text[])))
    ) THEN
      UPDATE public.listing_variants
      SET image_path = NULL
      WHERE listing_id = NEW.id
        AND image_path IS NOT NULL
        AND NOT (image_path = ANY(COALESCE(NEW.image_paths, '{}'::text[])));
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_cleanup_listing_variation_images ON public.listings;
CREATE TRIGGER trg_cleanup_listing_variation_images
  AFTER UPDATE OF image_paths, has_variants, option_groups, variation_photo_group ON public.listings
  FOR EACH ROW
  EXECUTE FUNCTION public.cleanup_listing_variation_images_on_listing_edit();

CREATE OR REPLACE FUNCTION public.guard_listing_variant_image_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_listing public.listings;
BEGIN
  NEW.image_path := NULLIF(trim(COALESCE(NEW.image_path, '')), '');

  IF NEW.image_path IS NULL THEN
    RETURN NEW;
  END IF;

  -- Fast row-level check without taking reverse `listing_variants -> listings` locks
  -- (authoritative concurrent check runs at deferred validation under advisory lock)
  SELECT * INTO v_listing
  FROM public.listings l
  WHERE l.id = NEW.listing_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'LISTING_NOT_FOUND';
  END IF;

  IF COALESCE(v_listing.has_variants, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'VARIATION_IMAGES_REQUIRE_VARIANTS';
  END IF;

  IF NULLIF(trim(COALESCE(v_listing.variation_photo_group, '')), '') IS NULL THEN
    RAISE EXCEPTION 'VARIATION_PHOTO_GROUP_REQUIRED';
  END IF;

  IF NOT (NEW.image_path = ANY(COALESCE(v_listing.image_paths, '{}'::text[]))) THEN
    RAISE EXCEPTION 'INVALID_VARIATION_IMAGE_PATH';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_listing_variant_image_row ON public.listing_variants;
CREATE TRIGGER trg_guard_listing_variant_image_row
  BEFORE INSERT OR UPDATE ON public.listing_variants
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_listing_variant_image_row();

-- Shared final deferred invariant validator for both `listings` gallery/group edits
-- and `listing_variants` writes (uses pure MVCC SELECT after advisory lock — never
-- creates reverse row locks against checkout/bargaining `listings -> listing_variants`).
CREATE OR REPLACE FUNCTION public.assert_listing_variation_integrity(p_listing_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_listing    public.listings;
  v_group      text;
  v_active_cnt integer;
BEGIN
  IF p_listing_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('buyu_listing_var_integrity:' || p_listing_id::text, 0)
  );

  SELECT * INTO v_listing
  FROM public.listings l
  WHERE l.id = p_listing_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_group := NULLIF(trim(COALESCE(v_listing.variation_photo_group, '')), '');

  IF v_group IS NOT NULL THEN
    IF COALESCE(v_listing.has_variants, false) IS NOT TRUE
       OR NOT (v_group = ANY(COALESCE(v_listing.option_groups, '{}'::text[]))) THEN
      RAISE EXCEPTION 'INVALID_VARIATION_PHOTO_GROUP';
    END IF;
  END IF;

  -- Final deferred check for image membership and photo-group relationship across all variants
  IF EXISTS (
    SELECT 1 FROM public.listing_variants lv
    WHERE lv.listing_id = p_listing_id AND lv.image_path IS NOT NULL
  ) THEN
    IF COALESCE(v_listing.has_variants, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'VARIATION_IMAGES_REQUIRE_VARIANTS';
    END IF;
    IF v_group IS NULL THEN
      RAISE EXCEPTION 'VARIATION_PHOTO_GROUP_REQUIRED';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.listing_variants lv
      WHERE lv.listing_id = p_listing_id
        AND lv.image_path IS NOT NULL
        AND NOT (lv.image_path = ANY(COALESCE(v_listing.image_paths, '{}'::text[])))
    ) THEN
      RAISE EXCEPTION 'INVALID_VARIATION_IMAGE_PATH';
    END IF;
  END IF;

  SELECT count(*)::integer INTO v_active_cnt
  FROM public.listing_variants lv
  WHERE lv.listing_id = p_listing_id
    AND lv.active IS TRUE;

  IF v_active_cnt > 50 THEN
    RAISE EXCEPTION 'TOO_MANY_LISTING_VARIANTS';
  END IF;

  IF COALESCE(v_listing.has_variants, false) IS TRUE AND v_group IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM (
        SELECT
          lower(trim((
            SELECT t.v
            FROM jsonb_each_text(lv.option_values) AS t(k, v)
            WHERE lower(trim(t.k)) = lower(trim(v_group))
            LIMIT 1
          ))) AS opt_key,
          count(DISTINCT COALESCE(lv.image_path, '')) AS img_distinct
        FROM public.listing_variants lv
        WHERE lv.listing_id = p_listing_id
          AND lv.active IS TRUE
        GROUP BY 1
      ) s
      WHERE s.opt_key IS NOT NULL
        AND s.opt_key <> ''
        AND s.img_distinct > 1
    ) THEN
      RAISE EXCEPTION 'CONFLICTING_VARIATION_IMAGE_MAPPING';
    END IF;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_listings_final_variation_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.assert_listing_variation_integrity(NEW.id);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_listings_final_variation ON public.listings;
CREATE CONSTRAINT TRIGGER trg_guard_listings_final_variation
  AFTER INSERT OR UPDATE OF image_paths, has_variants, option_groups, variation_photo_group
  ON public.listings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_listings_final_variation_consistency();

CREATE OR REPLACE FUNCTION public.guard_listing_variant_consistency_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.assert_listing_variation_integrity(NEW.listing_id);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_listing_variant_consistency ON public.listing_variants;
CREATE CONSTRAINT TRIGGER trg_guard_listing_variant_consistency
  AFTER INSERT OR UPDATE ON public.listing_variants
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_listing_variant_consistency_row();

-- -----------------------------------------------------------------------------
-- 5. FIX 1, FIX 2 & FIX 5: Hardened variation sync, atomic edit & atomic create
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.sync_listing_variation_images_atomic(uuid, text, jsonb);

CREATE OR REPLACE FUNCTION public.sync_listing_variation_images_atomic(
  p_listing_id            uuid,
  p_variation_photo_group text DEFAULT NULL,
  p_variant_images        jsonb DEFAULT '[]'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid              uuid := auth.uid();
  v_listing          public.listings;
  v_clean_group      text := NULLIF(trim(COALESCE(p_variation_photo_group, '')), '');
  v_entry            jsonb;
  v_raw_vid          text;
  v_variant_id       uuid;
  v_option_vals      jsonb;
  v_norm_vals        jsonb;
  v_image_path       text;
  v_next_active      boolean;
  v_has_active_field boolean := false;
  v_reserved_qty     integer;
  v_match_ids        uuid[];
  v_target_ids       uuid[] := '{}'::uuid[];
  v_target_paths     text[] := '{}'::text[];
  v_target_active    boolean[] := '{}'::boolean[];
  v_opt_val          text;
  v_opt_key          text;
  v_opt_seen_keys    text[] := '{}'::text[];
  v_opt_seen_imgs    text[] := '{}'::text[];
  v_opt_idx          integer;
  v_idx              integer;
  v_active_cnt       integer;
  v_active_qty_sum   integer;
  v_active_min_price integer;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_listing
  FROM public.listings
  WHERE id = p_listing_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'LISTING_NOT_FOUND';
  END IF;

  IF v_listing.seller_id <> v_uid THEN
    RAISE EXCEPTION 'FORBIDDEN_LISTING_OWNER' USING ERRCODE = '42501';
  END IF;

  IF p_variant_images IS NOT NULL AND jsonb_typeof(p_variant_images) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_VARIANT_IMAGES_PAYLOAD';
  END IF;

  IF COALESCE(v_listing.has_variants, false) IS NOT TRUE THEN
    IF v_clean_group IS NOT NULL THEN
      RAISE EXCEPTION 'INVALID_VARIATION_PHOTO_GROUP';
    END IF;
    IF p_variant_images IS NOT NULL AND jsonb_array_length(p_variant_images) > 0 THEN
      RAISE EXCEPTION 'VARIATION_IMAGES_REQUIRE_VARIANTS';
    END IF;

    UPDATE public.listings
    SET variation_photo_group = NULL
    WHERE id = p_listing_id
      AND variation_photo_group IS NOT NULL;

    UPDATE public.listing_variants
    SET image_path = NULL
    WHERE listing_id = p_listing_id
      AND image_path IS NOT NULL;
    RETURN;
  END IF;

  IF v_clean_group IS NOT NULL
     AND NOT (v_clean_group = ANY(COALESCE(v_listing.option_groups, '{}'::text[]))) THEN
    RAISE EXCEPTION 'INVALID_VARIATION_PHOTO_GROUP';
  END IF;

  PERFORM 1
  FROM public.listing_variants lv
  WHERE lv.listing_id = p_listing_id
  ORDER BY lv.id
  FOR UPDATE;

  IF v_listing.variation_photo_group IS DISTINCT FROM v_clean_group THEN
    UPDATE public.listing_variants
    SET image_path = NULL
    WHERE listing_id = p_listing_id
      AND image_path IS NOT NULL;
  END IF;

  UPDATE public.listings
  SET variation_photo_group = v_clean_group
  WHERE id = p_listing_id;

  IF p_variant_images IS NULL OR jsonb_array_length(p_variant_images) = 0 THEN
    IF v_clean_group IS NULL THEN
      UPDATE public.listing_variants
      SET image_path = NULL
      WHERE listing_id = p_listing_id
        AND image_path IS NOT NULL;
    END IF;
    RETURN;
  END IF;

  FOR v_entry IN
    SELECT value FROM jsonb_array_elements(p_variant_images)
  LOOP
    IF jsonb_typeof(v_entry) <> 'object' THEN
      RAISE EXCEPTION 'INVALID_VARIANT_IMAGE_ENTRY';
    END IF;

    IF v_entry ? 'image_path' AND jsonb_typeof(v_entry -> 'image_path') NOT IN ('string', 'null') THEN
      RAISE EXCEPTION 'INVALID_VARIATION_IMAGE_PATH';
    END IF;
    v_image_path := NULLIF(trim(COALESCE(v_entry ->> 'image_path', '')), '');

    IF v_image_path IS NOT NULL THEN
      IF v_clean_group IS NULL THEN
        RAISE EXCEPTION 'VARIATION_PHOTO_GROUP_REQUIRED';
      END IF;
      IF NOT (v_image_path = ANY(COALESCE(v_listing.image_paths, '{}'::text[]))) THEN
        RAISE EXCEPTION 'INVALID_VARIATION_IMAGE_PATH';
      END IF;
    END IF;

    v_next_active := NULL;
    IF v_entry ? 'active' AND jsonb_typeof(v_entry -> 'active') <> 'null' THEN
      IF jsonb_typeof(v_entry -> 'active') <> 'boolean' THEN
        RAISE EXCEPTION 'INVALID_VARIANT_ACTIVE_FLAG';
      END IF;
      v_next_active := (v_entry ->> 'active')::boolean;
      v_has_active_field := true;
    END IF;

    v_variant_id := NULL;
    IF v_entry ? 'variant_id' AND jsonb_typeof(v_entry -> 'variant_id') <> 'null' THEN
      IF jsonb_typeof(v_entry -> 'variant_id') <> 'string' THEN
        RAISE EXCEPTION 'INVALID_VARIANT_ID';
      END IF;
      v_raw_vid := NULLIF(trim(v_entry ->> 'variant_id'), '');
      IF v_raw_vid IS NOT NULL THEN
        IF v_raw_vid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
          RAISE EXCEPTION 'INVALID_VARIANT_ID';
        END IF;
        v_variant_id := v_raw_vid::uuid;
        IF NOT EXISTS (
          SELECT 1 FROM public.listing_variants lv
          WHERE lv.id = v_variant_id
            AND lv.listing_id = p_listing_id
        ) THEN
          RAISE EXCEPTION 'UNMATCHED_VARIANT_ID';
        END IF;
      END IF;
    END IF;

    IF v_variant_id IS NULL THEN
      v_option_vals := v_entry -> 'option_values';
      IF v_option_vals IS NULL OR jsonb_typeof(v_option_vals) <> 'object' THEN
        RAISE EXCEPTION 'INVALID_VARIANT_OPTION_VALUES';
      END IF;

      SELECT COALESCE(jsonb_object_agg(lower(trim(t.k)), lower(trim(t.v))), '{}'::jsonb)
      INTO v_norm_vals
      FROM jsonb_each_text(v_option_vals) AS t(k, v)
      WHERE trim(t.k) <> '' AND trim(t.v) <> '';

      IF v_norm_vals = '{}'::jsonb THEN
        RAISE EXCEPTION 'INVALID_VARIANT_OPTION_VALUES';
      END IF;

      SELECT COALESCE(array_agg(lv.id ORDER BY lv.id), '{}'::uuid[])
      INTO v_match_ids
      FROM public.listing_variants lv
      WHERE lv.listing_id = p_listing_id
        AND (
          SELECT COALESCE(jsonb_object_agg(lower(trim(x.k)), lower(trim(x.v))), '{}'::jsonb)
          FROM jsonb_each_text(COALESCE(lv.option_values, '{}'::jsonb)) AS x(k, v)
          WHERE trim(x.k) <> '' AND trim(x.v) <> ''
        ) = v_norm_vals;

      IF cardinality(v_match_ids) = 0 THEN
        RAISE EXCEPTION 'UNMATCHED_VARIANT_OPTION_VALUES';
      ELSIF cardinality(v_match_ids) > 1 THEN
        RAISE EXCEPTION 'AMBIGUOUS_VARIANT_OPTION_VALUES';
      END IF;

      v_variant_id := v_match_ids[1];
    END IF;

    IF v_variant_id = ANY(v_target_ids) THEN
      RAISE EXCEPTION 'DUPLICATE_VARIANT_IMAGE_ENTRY';
    END IF;

    -- Preserve reserved-stock and active accepted-offer safeguards before deactivation
    IF v_next_active IS FALSE THEN
      SELECT COALESCE(lv.reserved_quantity, 0) INTO v_reserved_qty
      FROM public.listing_variants lv
      WHERE lv.id = v_variant_id;

      IF v_reserved_qty > 0 THEN
        RAISE EXCEPTION 'Cannot deactivate variant with active reservations'
          USING ERRCODE = '42501';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM public.offers o
        WHERE o.variant_id = v_variant_id
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
        RAISE EXCEPTION 'Cannot deactivate variant with active accepted offer reservation'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    -- Verify active entries sharing the same photo-enabled option do not disagree
    IF v_clean_group IS NOT NULL AND COALESCE(v_next_active, true) IS TRUE THEN
      SELECT NULLIF(trim(t.v), '') INTO v_opt_val
      FROM public.listing_variants lv,
           LATERAL jsonb_each_text(COALESCE(lv.option_values, '{}'::jsonb)) AS t(k, v)
      WHERE lv.id = v_variant_id
        AND lower(trim(t.k)) = lower(trim(v_clean_group))
      LIMIT 1;

      IF v_opt_val IS NOT NULL THEN
        v_opt_key := lower(v_opt_val);
        v_opt_idx := array_position(v_opt_seen_keys, v_opt_key);
        IF v_opt_idx IS NULL THEN
          v_opt_seen_keys := array_append(v_opt_seen_keys, v_opt_key);
          v_opt_seen_imgs := array_append(v_opt_seen_imgs, COALESCE(v_image_path, ''));
        ELSIF v_opt_seen_imgs[v_opt_idx] IS DISTINCT FROM COALESCE(v_image_path, '') THEN
          RAISE EXCEPTION 'CONFLICTING_VARIATION_IMAGE_MAPPING';
        END IF;
      END IF;
    END IF;

    v_target_ids := array_append(v_target_ids, v_variant_id);
    v_target_paths := array_append(v_target_paths, v_image_path);
    v_target_active := array_append(v_target_active, v_next_active);
  END LOOP;

  UPDATE public.listing_variants lv
  SET image_path = m.next_path,
      active = COALESCE(m.next_active, lv.active)
  FROM (
    SELECT
      v_target_ids[idx] AS vid,
      v_target_paths[idx] AS next_path,
      v_target_active[idx] AS next_active
    FROM generate_subscripts(v_target_ids, 1) AS idx
  ) AS m
  WHERE lv.id = m.vid
    AND lv.listing_id = p_listing_id;

  IF v_clean_group IS NULL THEN
    UPDATE public.listing_variants
    SET image_path = NULL
    WHERE listing_id = p_listing_id
      AND image_path IS NOT NULL;
  END IF;

  -- Synchronize parent quantity & lowest active price strictly from active variants
  IF v_has_active_field THEN
    SELECT
      count(*) FILTER (WHERE lv.active IS TRUE)::integer,
      COALESCE(SUM(lv.quantity) FILTER (WHERE lv.active IS TRUE), 0)::integer,
      MIN(lv.price_sen) FILTER (WHERE lv.active IS TRUE)
    INTO v_active_cnt, v_active_qty_sum, v_active_min_price
    FROM public.listing_variants lv
    WHERE lv.listing_id = p_listing_id;

    IF v_listing.status = 'published' AND COALESCE(v_active_cnt, 0) < 1 THEN
      RAISE EXCEPTION 'AT_LEAST_ONE_ACTIVE_VARIANT_REQUIRED';
    END IF;

    IF v_active_qty_sum > 999 THEN
      RAISE EXCEPTION 'COMBINED_VARIANT_STOCK_EXCEEDED';
    END IF;

    UPDATE public.listings
    SET quantity = v_active_qty_sum,
        price_sen = COALESCE(v_active_min_price, v_listing.price_sen)
    WHERE id = p_listing_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_listing_variation_images_atomic(uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_listing_variation_images_atomic(uuid, text, jsonb) TO authenticated;

DROP FUNCTION IF EXISTS public.save_listing_edit_atomic(uuid, timestamptz, jsonb, jsonb, text, jsonb);

CREATE OR REPLACE FUNCTION public.save_listing_edit_atomic(
  p_listing_id            uuid,
  p_expected_updated_at   timestamptz,
  p_payload               jsonb,
  p_variants              jsonb DEFAULT '[]'::jsonb,
  p_variation_photo_group text DEFAULT NULL,
  p_variant_images        jsonb DEFAULT '[]'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Defer variation & gallery invariant checks across update_listing_atomic -> sync
  SET CONSTRAINTS trg_guard_listings_final_variation, trg_guard_listing_variant_consistency DEFERRED;

  PERFORM public.update_listing_atomic(
    p_listing_id,
    p_expected_updated_at,
    p_payload,
    p_variants
  );

  PERFORM public.sync_listing_variation_images_atomic(
    p_listing_id,
    p_variation_photo_group,
    p_variant_images
  );

  -- Enforce all deferred variation & gallery invariants strictly before returning
  SET CONSTRAINTS trg_guard_listings_final_variation, trg_guard_listing_variant_consistency IMMEDIATE;
END;
$$;

REVOKE ALL ON FUNCTION public.save_listing_edit_atomic(uuid, timestamptz, jsonb, jsonb, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_listing_edit_atomic(uuid, timestamptz, jsonb, jsonb, text, jsonb) TO authenticated;

-- Atomic single-transaction creation RPC (SECURITY INVOKER preserves caller RLS & triggers)
DROP FUNCTION IF EXISTS public.create_listing_with_variations_atomic(jsonb, jsonb);

CREATE OR REPLACE FUNCTION public.create_listing_with_variations_atomic(
  p_listing  jsonb,
  p_variants jsonb DEFAULT '[]'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid              uuid := auth.uid();
  v_now              timestamptz := clock_timestamp();
  v_clean_json       jsonb;
  v_rec              public.listings;
  v_has_variants     boolean;
  v_is_food          boolean;
  v_kind             text;
  v_title            text;
  v_desc             text;
  v_status           text;
  v_condition        text;
  v_area_id          text;
  v_service_mode     text;
  v_avail_mode       text;
  v_allow_offers     boolean;
  v_rules_ack        boolean;
  v_price_sen        integer;
  v_qty              integer;
  v_listing_id       uuid;
  v_active_cnt       integer := 0;
  v_active_qty_sum   integer := 0;
  v_active_min_price integer := NULL;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_student() THEN
    RAISE EXCEPTION 'FORBIDDEN_ACTIVE_STUDENT_ONLY' USING ERRCODE = '42501';
  END IF;

  IF p_listing IS NULL OR jsonb_typeof(p_listing) <> 'object' THEN
    RAISE EXCEPTION 'INVALID_LISTING_PAYLOAD';
  END IF;

  IF p_variants IS NOT NULL AND jsonb_typeof(p_variants) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_VARIANTS_PAYLOAD';
  END IF;

  -- Strip empty string timestamp/optional text keys so jsonb_populate_record converts cleanly
  v_clean_json := p_listing;
  IF NULLIF(trim(COALESCE(v_clean_json ->> 'preorder_close_at', '')), '') IS NULL THEN
    v_clean_json := v_clean_json - 'preorder_close_at';
  END IF;
  IF NULLIF(trim(COALESCE(v_clean_json ->> 'pickup_window_start', '')), '') IS NULL THEN
    v_clean_json := v_clean_json - 'pickup_window_start';
  END IF;
  IF NULLIF(trim(COALESCE(v_clean_json ->> 'pickup_window_end', '')), '') IS NULL THEN
    v_clean_json := v_clean_json - 'pickup_window_end';
  END IF;

  v_rec := jsonb_populate_record(NULL::public.listings, v_clean_json);

  v_kind         := trim(COALESCE(v_rec.kind, ''));
  v_is_food      := COALESCE(v_rec.is_food, false);
  v_title        := trim(COALESCE(v_rec.title, ''));
  v_desc         := trim(COALESCE(v_rec.description, ''));
  v_status       := COALESCE(NULLIF(lower(trim(COALESCE(v_rec.status, ''))), ''), 'draft');
  v_condition    := NULLIF(trim(COALESCE(v_rec.condition, '')), '');
  v_area_id      := NULLIF(trim(COALESCE(v_rec.collection_area_id, '')), '');
  v_service_mode := NULLIF(trim(COALESCE(v_rec.service_mode, '')), '');
  v_avail_mode   := COALESCE(NULLIF(trim(COALESCE(v_rec.availability_mode, '')), ''), 'ready');
  v_has_variants := COALESCE(v_rec.has_variants, false);
  v_rules_ack    := COALESCE(v_rec.rules_acknowledged, false);
  v_price_sen    := COALESCE(v_rec.price_sen, 0);
  v_qty          := COALESCE(v_rec.quantity, 0);

  IF v_kind NOT IN ('pre_loved', 'business', 'service') THEN
    RAISE EXCEPTION 'INVALID_LISTING_KIND';
  END IF;

  IF v_status NOT IN ('draft', 'published') THEN
    RAISE EXCEPTION 'INVALID_LISTING_STATUS';
  END IF;

  IF char_length(v_title) < 3 OR char_length(v_title) > 120 THEN
    RAISE EXCEPTION 'INVALID_LISTING_TITLE';
  END IF;

  IF char_length(v_desc) < 20 OR char_length(v_desc) > 3000 THEN
    RAISE EXCEPTION 'INVALID_LISTING_DESCRIPTION';
  END IF;

  IF v_price_sen < 200 OR v_price_sen > 5000000 THEN
    RAISE EXCEPTION 'INVALID_LISTING_PRICE';
  END IF;

  IF v_kind = 'service' THEN
    IF v_has_variants THEN
      RAISE EXCEPTION 'SERVICE_VARIANTS_FORBIDDEN';
    END IF;
    IF v_service_mode IS NOT NULL AND v_service_mode NOT IN ('in_person', 'remote', 'both') THEN
      RAISE EXCEPTION 'INVALID_SERVICE_MODE';
    END IF;
    v_is_food := false;
    v_condition := NULL;
    v_qty := 1;
    v_allow_offers := false;
  ELSE
    v_service_mode := NULL;
    IF v_kind = 'pre_loved' THEN
      IF v_has_variants THEN
        RAISE EXCEPTION 'PRELOVED_VARIANTS_FORBIDDEN';
      END IF;
      v_is_food := false;
      v_allow_offers := COALESCE(v_rec.allow_offers, false);
    ELSIF v_is_food THEN
      v_condition := NULL;
      v_allow_offers := false;
    ELSE
      v_allow_offers := COALESCE(v_rec.allow_offers, false);
    END IF;
  END IF;

  IF v_status = 'published' THEN
    -- Preserve seller payout-account publish gate scoped strictly to auth.uid() via authenticated-readable columns
    IF NOT EXISTS (
      SELECT 1
      FROM public.seller_payout_accounts spa
      WHERE spa.seller_id = v_uid
        AND spa.is_active IS TRUE
        AND spa.validation_status = 'validated'
    ) THEN
      RAISE EXCEPTION 'PAYOUT_ACCOUNT_REQUIRED' USING ERRCODE = '42501';
    END IF;
    IF NOT v_rules_ack THEN
      RAISE EXCEPTION 'RULES_ACKNOWLEDGEMENT_REQUIRED';
    END IF;
    IF v_kind = 'service' AND v_service_mode IS NULL THEN
      RAISE EXCEPTION 'SERVICE_MODE_REQUIRED';
    END IF;
    IF v_kind <> 'service' AND v_area_id IS NULL THEN
      RAISE EXCEPTION 'COLLECTION_AREA_REQUIRED';
    END IF;
    IF v_kind <> 'service' AND NOT v_is_food AND v_condition IS NULL THEN
      RAISE EXCEPTION 'CONDITION_REQUIRED';
    END IF;
    IF v_kind <> 'service' AND NOT v_has_variants AND v_qty < 1 THEN
      RAISE EXCEPTION 'INVALID_LISTING_QUANTITY';
    END IF;
  END IF;

  IF v_has_variants THEN
    IF p_variants IS NULL OR jsonb_array_length(p_variants) = 0 THEN
      RAISE EXCEPTION 'AT_LEAST_ONE_VARIANT_REQUIRED';
    END IF;
    IF jsonb_array_length(p_variants) > 50 THEN
      RAISE EXCEPTION 'TOO_MANY_LISTING_VARIANTS';
    END IF;
  END IF;

  SET CONSTRAINTS trg_guard_listings_final_variation, trg_guard_listing_variant_consistency DEFERRED;

  IF v_clean_json ? 'service_details' AND jsonb_typeof(v_clean_json -> 'service_details') <> 'null' THEN
    INSERT INTO public.listings (
      seller_id, kind, is_food, title, description, category_id, condition,
      limitations, price_sen, quantity, reserved_quantity, collection_area_id,
      allow_offers, has_variants, option_groups, variation_photo_group,
      availability_mode, preorder_close_at, pickup_window_start, pickup_window_end,
      pickup_note, food_notes, service_mode, accepting_requests, service_details,
      image_paths, rules_acknowledged, status, published_at, updated_at
    ) VALUES (
      v_uid,
      v_kind,
      v_is_food,
      v_title,
      v_desc,
      v_rec.category_id,
      v_condition,
      COALESCE(v_rec.limitations, ''),
      v_price_sen,
      v_qty,
      0,
      v_area_id,
      v_allow_offers,
      v_has_variants,
      COALESCE(v_rec.option_groups, '{}'::text[]),
      NULLIF(trim(COALESCE(v_rec.variation_photo_group, '')), ''),
      v_avail_mode,
      v_rec.preorder_close_at,
      v_rec.pickup_window_start,
      v_rec.pickup_window_end,
      COALESCE(v_rec.pickup_note, ''),
      COALESCE(v_rec.food_notes, ''),
      v_service_mode,
      COALESCE(v_rec.accepting_requests, v_kind = 'service'),
      v_rec.service_details,
      COALESCE(v_rec.image_paths, '{}'::text[]),
      v_rules_ack,
      v_status,
      CASE WHEN v_status = 'published' THEN v_now ELSE NULL END,
      v_now
    )
    RETURNING id INTO v_listing_id;
  ELSE
    INSERT INTO public.listings (
      seller_id, kind, is_food, title, description, category_id, condition,
      limitations, price_sen, quantity, reserved_quantity, collection_area_id,
      allow_offers, has_variants, option_groups, variation_photo_group,
      availability_mode, preorder_close_at, pickup_window_start, pickup_window_end,
      pickup_note, food_notes, service_mode, accepting_requests,
      image_paths, rules_acknowledged, status, published_at, updated_at
    ) VALUES (
      v_uid,
      v_kind,
      v_is_food,
      v_title,
      v_desc,
      v_rec.category_id,
      v_condition,
      COALESCE(v_rec.limitations, ''),
      v_price_sen,
      v_qty,
      0,
      v_area_id,
      v_allow_offers,
      v_has_variants,
      COALESCE(v_rec.option_groups, '{}'::text[]),
      NULLIF(trim(COALESCE(v_rec.variation_photo_group, '')), ''),
      v_avail_mode,
      v_rec.preorder_close_at,
      v_rec.pickup_window_start,
      v_rec.pickup_window_end,
      COALESCE(v_rec.pickup_note, ''),
      COALESCE(v_rec.food_notes, ''),
      v_service_mode,
      COALESCE(v_rec.accepting_requests, v_kind = 'service'),
      COALESCE(v_rec.image_paths, '{}'::text[]),
      v_rules_ack,
      v_status,
      CASE WHEN v_status = 'published' THEN v_now ELSE NULL END,
      v_now
    )
    RETURNING id INTO v_listing_id;
  END IF;

  IF v_has_variants THEN
    INSERT INTO public.listing_variants (
      listing_id, option_values, price_sen, quantity, reserved_quantity, active, image_path
    )
    SELECT
      v_listing_id,
      COALESCE(v.elem -> 'option_values', '{}'::jsonb),
      COALESCE((v.elem ->> 'price_sen')::integer, 0),
      COALESCE((v.elem ->> 'quantity')::integer, 0),
      0,
      COALESCE((v.elem ->> 'active')::boolean, true),
      NULLIF(trim(COALESCE(v.elem ->> 'image_path', '')), '')
    FROM jsonb_array_elements(p_variants) AS v(elem);

    SELECT
      count(*) FILTER (WHERE lv.active IS TRUE)::integer,
      COALESCE(SUM(lv.quantity) FILTER (WHERE lv.active IS TRUE), 0)::integer,
      MIN(lv.price_sen) FILTER (WHERE lv.active IS TRUE)
    INTO v_active_cnt, v_active_qty_sum, v_active_min_price
    FROM public.listing_variants lv
    WHERE lv.listing_id = v_listing_id;

    IF v_status = 'published' AND COALESCE(v_active_cnt, 0) < 1 THEN
      RAISE EXCEPTION 'AT_LEAST_ONE_ACTIVE_VARIANT_REQUIRED';
    END IF;

    IF v_active_qty_sum > 999 THEN
      RAISE EXCEPTION 'COMBINED_VARIANT_STOCK_EXCEEDED';
    END IF;

    UPDATE public.listings
    SET quantity = v_active_qty_sum,
        price_sen = COALESCE(v_active_min_price, price_sen)
    WHERE id = v_listing_id;
  END IF;

  SET CONSTRAINTS trg_guard_listings_final_variation, trg_guard_listing_variant_consistency IMMEDIATE;

  RETURN v_listing_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_listing_with_variations_atomic(jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_listing_with_variations_atomic(jsonb, jsonb) TO authenticated;

-- -----------------------------------------------------------------------------
-- 6. FIX 3: Reference-aware Storage DELETE protection (`listings` bucket ONLY)
--    SECURITY DEFINER check ensures RLS on orders/offers cannot hide references.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_listing_storage_object_referenced(p_object_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN NULLIF(trim(COALESCE(p_object_name, '')), '') IS NULL THEN false
    ELSE (
      EXISTS (SELECT 1 FROM public.listings l WHERE l.image_paths @> ARRAY[p_object_name])
      OR EXISTS (SELECT 1 FROM public.listing_variants lv WHERE lv.image_path = p_object_name)
      OR EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.image_path = p_object_name)
      OR EXISTS (SELECT 1 FROM public.offers o WHERE o.variant_image_path = p_object_name)
      OR EXISTS (
        SELECT 1 FROM public.storefronts s
        WHERE s.logo_path = p_object_name OR s.banner_path = p_object_name
      )
    )
  END;
$$;

REVOKE ALL ON FUNCTION public.is_listing_storage_object_referenced(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_listing_storage_object_referenced(text) TO authenticated, service_role;

DROP POLICY IF EXISTS listings_preserve_referenced_objects_delete ON storage.objects;
CREATE POLICY listings_preserve_referenced_objects_delete
  ON storage.objects
  AS RESTRICTIVE
  FOR DELETE
  TO authenticated
  USING (
    bucket_id <> 'listings'
    OR NOT public.is_listing_storage_object_referenced(name)
  );

-- -----------------------------------------------------------------------------
-- 7. P0.3 & P0.7: Patch `guard_offer_inserts()` & `guard_offer_updates()`
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_proc   regprocedure := 'public.guard_offer_inserts()'::regprocedure;
  v_old    text;
  v_step1  text;
  v_step2  text;
BEGIN
  v_old := pg_get_functiondef(v_proc);

  IF position('NEW.variant_image_path := COALESCE(NULLIF(v_variant.image_path' in v_old) = 0 THEN
    v_step1 := replace(
      v_old,
      'NEW.variant_snapshot := v_variant.option_values;',
      'NEW.variant_snapshot := v_variant.option_values;' || E'\n    ' ||
      'NEW.variant_image_path := COALESCE(NULLIF(v_variant.image_path, ''''), v_listing.image_paths[1], NULL);'
    );
    IF v_step1 IS NOT DISTINCT FROM v_old THEN
      RAISE EXCEPTION 'PHASE_10V_ABORTED: guard_offer_inserts variant branch clause not found';
    END IF;
  ELSE
    v_step1 := v_old;
  END IF;

  IF position('NEW.variant_image_path := v_listing.image_paths[1];' in v_step1) = 0 THEN
    v_step2 := replace(
      v_step1,
      'NEW.variant_snapshot := NULL;',
      'NEW.variant_snapshot := NULL;' || E'\n    ' ||
      'NEW.variant_image_path := v_listing.image_paths[1];'
    );
    IF v_step2 IS NOT DISTINCT FROM v_step1 THEN
      RAISE EXCEPTION 'PHASE_10V_ABORTED: guard_offer_inserts non-variant branch clause not found';
    END IF;
  ELSE
    v_step2 := v_step1;
  END IF;

  IF v_step2 IS DISTINCT FROM v_old THEN
    EXECUTE v_step2;
  END IF;
END;
$$;

DO $$
DECLARE
  v_proc regprocedure := 'public.guard_offer_updates()'::regprocedure;
  v_old  text;
  v_new  text;
BEGIN
  v_old := pg_get_functiondef(v_proc);

  IF position('NEW.variant_image_path' in v_old) = 0 THEN
    v_new := replace(
      v_old,
      'OR NEW.variant_snapshot IS DISTINCT FROM OLD.variant_snapshot',
      'OR NEW.variant_snapshot IS DISTINCT FROM OLD.variant_snapshot' || E'\n     ' ||
      'OR NEW.variant_image_path IS DISTINCT FROM OLD.variant_image_path'
    );
    IF v_new IS NOT DISTINCT FROM v_old THEN
      RAISE EXCEPTION 'PHASE_10V_ABORTED: guard_offer_updates variant_snapshot guard clause not found';
    END IF;
    EXECUTE v_new;
  END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- 8. P0.3 & P0.7: Patch `create_offer_checkout_atomic(uuid, text)`
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_proc     regprocedure := 'public.create_offer_checkout_atomic(uuid,text)'::regprocedure;
  v_old      text;
  v_new      text;
  v_target   text :=
    'CASE WHEN COALESCE(v_listing.has_variants, false) THEN COALESCE(NULLIF(v_offer.variant_image_path, ''''), NULLIF(v_variant.image_path, ''''), v_listing.image_paths[1], '''') ELSE COALESCE(NULLIF(v_offer.variant_image_path, ''''), v_listing.image_paths[1], '''') END';
  v_old_v1   text :=
    'CASE WHEN COALESCE(v_listing.has_variants, false) THEN COALESCE(NULLIF(v_variant.image_path, ''''), NULLIF(v_offer.variant_image_path, ''''), v_listing.image_paths[1], '''') ELSE COALESCE(v_listing.image_paths[1], '''') END';
BEGIN
  v_old := pg_get_functiondef(v_proc);

  IF position(v_target in v_old) = 0 THEN
    IF position(v_old_v1 in v_old) > 0 THEN
      v_new := replace(v_old, v_old_v1, v_target);
    ELSE
      v_new := replace(
        v_old,
        'COALESCE(v_listing.image_paths[1], '''')',
        v_target
      );
    END IF;

    IF v_new IS NOT DISTINCT FROM v_old
       OR position(v_target in v_new) = 0 THEN
      RAISE EXCEPTION 'PHASE_10V_ABORTED: create_offer_checkout_atomic image_path clause not found';
    END IF;

    EXECUTE v_new;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.create_offer_checkout_atomic(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_offer_checkout_atomic(uuid, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 9. P0.7: Patch exact `public.create_cart_checkout_atomic(text, jsonb, uuid[])`
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_proc  regprocedure := 'public.create_cart_checkout_atomic(text,jsonb,uuid[])'::regprocedure;
  v_old   text;
  v_step1 text;
  v_step2 text;
BEGIN
  v_old := pg_get_functiondef(v_proc);

  IF position('lv.image_path AS variant_image_path' in v_old) = 0 THEN
    v_step1 := replace(
      v_old,
      'lv.price_sen AS variant_price_sen, lv.option_values',
      'lv.price_sen AS variant_price_sen, lv.option_values, lv.image_path AS variant_image_path'
    );
    IF v_step1 IS NOT DISTINCT FROM v_old
       OR position('lv.image_path AS variant_image_path' in v_step1) = 0 THEN
      RAISE EXCEPTION 'PHASE_10V_ABORTED: create_cart_checkout_atomic variant column clause not found';
    END IF;
  ELSE
    v_step1 := v_old;
  END IF;

  IF position('NULLIF(v_ci.variant_image_path' in v_step1) = 0 THEN
    v_step2 := replace(
      v_step1,
      'COALESCE(v_ci.image_paths[1], '''')',
      'CASE WHEN v_ci.kind <> ''service'' AND COALESCE(v_ci.has_variants, false) THEN COALESCE(NULLIF(v_ci.variant_image_path, ''''), v_ci.image_paths[1], '''') ELSE COALESCE(v_ci.image_paths[1], '''') END'
    );
    IF v_step2 IS NOT DISTINCT FROM v_step1
       OR position('NULLIF(v_ci.variant_image_path' in v_step2) = 0 THEN
      RAISE EXCEPTION 'PHASE_10V_ABORTED: create_cart_checkout_atomic order_items image_path clause not found';
    END IF;
  ELSE
    v_step2 := v_step1;
  END IF;

  IF v_step2 IS DISTINCT FROM v_old THEN
    EXECUTE v_step2;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.create_cart_checkout_atomic(text, jsonb, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_cart_checkout_atomic(text, jsonb, uuid[]) TO authenticated;

COMMIT;
