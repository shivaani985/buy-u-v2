-- =============================================================================
-- BUY-U PHASE 10V — ROLLBACK-ONLY VERIFICATION SUITE
-- =============================================================================
-- Strictly wrapped in BEGIN ... ROLLBACK. Zero persistent mutations.
-- Preserves all existing user data. Never deletes directly from storage.objects.
-- Embedded Migration File SHA-256: CD3E8A80E24DCF77A155488BE455A14208BD0AE41ED8F0BD4EF7E2AF3764BF71
--
-- Scope note on Storage fixtures:
--   Rows inserted into `storage.objects` inside this transaction are metadata-only
--   rollback fixtures used to verify SQL path validation, reference checks, and
--   order/offer image snapshots. Live Storage API deletion RLS enforcement is
--   verified separately via Supabase Storage API.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. EXACT EMBEDDED MIGRATION BODY (docs/sql/phase-10v-variation-images.sql)
-- =============================================================================

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


-- =============================================================================
-- 2. ISOLATED ROLLBACK ASSERTIONS (FIX 1â€“5 + P0.1â€“P0.8)
-- =============================================================================
DO $$
DECLARE
  v_seller_id       uuid := gen_random_uuid();
  v_other_seller_id uuid := gen_random_uuid();
  v_buyer_id        uuid := gen_random_uuid();
  v_cat_prod        public.categories.id%TYPE;
  v_cat_svc         public.categories.id%TYPE;
  v_area_id         public.collection_areas.id%TYPE;
  v_conv_id         uuid;
  v_now             timestamptz := now();

  v_desc_biz        text := 'Verify Student Business listing with valid length for Phase 10V variation integrity checks.';
  v_desc_scale      text := 'Verify scale listing with valid length for testing 50 vs 51 variation limits safely.';
  v_desc_pre        text := 'Verify Pre-Loved non-variant listing with valid description length for cover image snapshot.';
  v_desc_svc        text := 'Verify campus service listing with valid description length for partial service checkout.';

  v_biz_id          uuid := gen_random_uuid();
  v_scale_id        uuid := gen_random_uuid();
  v_preloved_id     uuid := gen_random_uuid();
  v_svc_id          uuid := gen_random_uuid();
  v_create_ok_id    uuid;

  v_v_bm            uuid;
  v_v_bl            uuid;
  v_v_bxl           uuid;
  v_v_bxl_react     uuid;
  v_v_tm            uuid;
  v_v_tl            uuid;
  v_v_tl_hold_id    uuid;

  v_p1              text;
  v_p2              text;
  v_p3              text;
  v_p4              text;
  v_unreferenced    text;
  v_imgs_10         text[] := '{}'::text[];
  v_imgs_11         text[] := '{}'::text[];
  v_foreign_img     text;
  v_svc_att_path    text;

  v_vars_4          jsonb;
  v_vars_5          jsonb;
  v_vars_50         jsonb := '[]'::jsonb;
  v_vars_50_repl    jsonb := '[]'::jsonb;
  v_vars_51         jsonb := '[]'::jsonb;
  v_imgs_4          jsonb;
  v_imgs_5          jsonb;
  v_updated_at      timestamptz;
  v_prev_updated_at timestamptz;
  v_failed          boolean;
  v_cnt             integer;
  v_qty             integer;
  v_price           integer;
  v_active_flag     boolean;
  v_img_val         text;
  v_err_state       text;
  v_err_msg         text;

  v_offer_var       uuid;
  v_offer_hold      uuid;
  v_offer_legacy    uuid := gen_random_uuid();
  v_offer_nonvar    uuid;
  v_ci_var          uuid := gen_random_uuid();
  v_ci_nonvar       uuid := gen_random_uuid();
  v_ci_svc          uuid := gen_random_uuid();

  v_s_cart_part     RECORD;
  v_s_cart_replay   RECORD;
  v_s_cart_rest     RECORD;
  v_s_offer_var     RECORD;
  v_s_offer_leg     RECORD;
  v_s_offer_nonvar  RECORD;
  v_oi              RECORD;
  i                 integer;
BEGIN
  -- Lookup active hosted category & collection_area TEXT IDs
  SELECT id INTO v_cat_prod FROM public.categories WHERE kind = 'product' AND active = true LIMIT 1;
  SELECT id INTO v_cat_svc  FROM public.categories WHERE kind = 'service' AND active = true LIMIT 1;
  SELECT id INTO v_area_id  FROM public.collection_areas WHERE active = true LIMIT 1;
  IF v_cat_prod IS NULL OR v_cat_svc IS NULL OR v_area_id IS NULL THEN
    RAISE EXCEPTION 'VERIFY_SETUP_FAILED: active product/service category and collection_area required';
  END IF;

  -- Create isolated synthetic users & active profiles
  INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at)
  VALUES
    (v_seller_id,       'v10v-seller-' || left(v_seller_id::text, 8)       || '@iluv.ums.edu.my', 'x', v_now, '{}', '{}', 'authenticated', 'authenticated', v_now, v_now),
    (v_other_seller_id, 'v10v-other-'  || left(v_other_seller_id::text, 8) || '@iluv.ums.edu.my', 'x', v_now, '{}', '{}', 'authenticated', 'authenticated', v_now, v_now),
    (v_buyer_id,        'v10v-buyer-'  || left(v_buyer_id::text, 8)        || '@iluv.ums.edu.my', 'x', v_now, '{}', '{}', 'authenticated', 'authenticated', v_now, v_now);

  INSERT INTO public.profiles (id, email, full_name, display_name, university_role, status)
  VALUES
    (v_seller_id,       'v10v-seller-' || left(v_seller_id::text, 8)       || '@iluv.ums.edu.my', 'Seller 10V', 'Seller 10V', 'student', 'active'),
    (v_other_seller_id, 'v10v-other-'  || left(v_other_seller_id::text, 8) || '@iluv.ums.edu.my', 'Other 10V',  'Other 10V',  'student', 'active'),
    (v_buyer_id,        'v10v-buyer-'  || left(v_buyer_id::text, 8)        || '@iluv.ums.edu.my', 'Buyer 10V',  'Buyer 10V',  'student', 'active')
  ON CONFLICT (id) DO UPDATE SET status = 'active', university_role = 'student';

  -- FIX 4: Synthetic seller payout fixtures via authoritative RPC (no real bank info)
  PERFORM * FROM public.upsert_seller_bank_account_secure(
    v_seller_id,
    'Maybank',
    'Verify Seller 10V',
    'v1:verify_rollback_only_ciphertext',
    '1234',
    '****1234'
  );
  PERFORM * FROM public.upsert_seller_bank_account_secure(
    v_other_seller_id,
    'Maybank',
    'Verify Other 10V',
    'v1:verify_rollback_only_ciphertext',
    '5678',
    '****5678'
  );

  INSERT INTO public.conversations (member_a, member_b)
  VALUES (LEAST(v_seller_id, v_buyer_id), GREATEST(v_seller_id, v_buyer_id))
  RETURNING id INTO v_conv_id;

  -- Metadata-only storage.objects fixtures (rolled back at ROLLBACK; Storage API RLS tested separately)
  FOR i IN 1..11 LOOP
    INSERT INTO storage.objects (bucket_id, name, owner, metadata)
    VALUES (
      'listings',
      v_seller_id::text || '/verify-p' || i::text || '.jpg',
      v_seller_id,
      jsonb_build_object('mimetype', 'image/jpeg', 'size', 20480)
    );
    IF i <= 10 THEN
      v_imgs_10 := array_append(v_imgs_10, v_seller_id::text || '/verify-p' || i::text || '.jpg');
    END IF;
    v_imgs_11 := array_append(v_imgs_11, v_seller_id::text || '/verify-p' || i::text || '.jpg');
  END LOOP;

  v_p1 := v_imgs_10[1];
  v_p2 := v_imgs_10[2];
  v_p3 := v_imgs_10[3];
  v_p4 := v_imgs_10[4];

  v_unreferenced := v_seller_id::text || '/verify-unused-orphan.jpg';
  INSERT INTO storage.objects (bucket_id, name, owner, metadata)
  VALUES (
    'listings',
    v_unreferenced,
    v_seller_id,
    jsonb_build_object('mimetype', 'image/jpeg', 'size', 10240)
  );

  v_foreign_img := v_other_seller_id::text || '/verify-foreign.jpg';
  INSERT INTO storage.objects (bucket_id, name, owner, metadata)
  VALUES (
    'listings',
    v_foreign_img,
    v_other_seller_id,
    jsonb_build_object('mimetype', 'image/jpeg', 'size', 20480)
  );

  v_svc_att_path := v_buyer_id::text || '/validated/' || v_ci_svc::text || '/1700000000-brief.pdf';
  INSERT INTO storage.objects (bucket_id, name, owner, metadata)
  VALUES (
    'service-order-attachments',
    v_svc_att_path,
    v_buyer_id,
    jsonb_build_object('mimetype', 'application/pdf', 'size', 10240)
  );

  -- Create base listings
  INSERT INTO public.listings (
    id, seller_id, kind, is_food, title, description, category_id, condition,
    limitations, price_sen, quantity, reserved_quantity, collection_area_id,
    allow_offers, has_variants, option_groups, availability_mode, pickup_note,
    food_notes, accepting_requests, service_mode, image_paths, rules_acknowledged,
    status, published_at, updated_at
  ) VALUES
    (v_biz_id,      v_seller_id, 'business',  false, '[VERIFY] 10V Hoodie',  v_desc_biz,   v_cat_prod, 'New/Unused', '', 2500, 12, 0, v_area_id, true,  true,  ARRAY['Colour','Size']::text[], 'ready', '', '', false, NULL,     ARRAY[v_p1, v_p2, v_p3], true, 'published', v_now, v_now),
    (v_scale_id,    v_seller_id, 'business',  false, '[VERIFY] 10V Scale',   v_desc_scale, v_cat_prod, 'New/Unused', '', 1000, 50, 0, v_area_id, false, true,  ARRAY['Option']::text[],        'ready', '', '', false, NULL,     ARRAY[v_p1],             true, 'published', v_now, v_now),
    (v_preloved_id, v_seller_id, 'pre_loved', false, '[VERIFY] 10V Mug',     v_desc_pre,   v_cat_prod, 'Good', '', 1800,  5, 0, v_area_id, true,  false, '{}'::text[],                   'ready', '', '', false, NULL,     ARRAY[v_p3],             true, 'published', v_now, v_now),
    (v_svc_id,      v_seller_id, 'service',   false, '[VERIFY] 10V Design',  v_desc_svc,   v_cat_svc,  NULL,   '', 1500,  1, 0, v_area_id, false, false, '{}'::text[],                   'ready', '', '', true,  'remote', ARRAY[v_p4],             true, 'published', v_now, v_now);

  INSERT INTO public.listing_variants (listing_id, option_values, price_sen, quantity, reserved_quantity, active)
  VALUES
    (v_biz_id, '{"Colour":"Black","Size":"M"}'::jsonb, 2500, 3, 0, true),
    (v_biz_id, '{"Colour":"Black","Size":"L"}'::jsonb, 2700, 3, 0, true),
    (v_biz_id, '{"Colour":"Teal","Size":"M"}'::jsonb,  2900, 3, 0, true),
    (v_biz_id, '{"Colour":"Teal","Size":"L"}'::jsonb,  3100, 3, 0, true);

  SELECT id INTO v_v_bm FROM public.listing_variants WHERE listing_id = v_biz_id AND option_values = '{"Colour":"Black","Size":"M"}'::jsonb;
  SELECT id INTO v_v_bl FROM public.listing_variants WHERE listing_id = v_biz_id AND option_values = '{"Colour":"Black","Size":"L"}'::jsonb;
  SELECT id INTO v_v_tm FROM public.listing_variants WHERE listing_id = v_biz_id AND option_values = '{"Colour":"Teal","Size":"M"}'::jsonb;
  SELECT id INTO v_v_tl FROM public.listing_variants WHERE listing_id = v_biz_id AND option_values = '{"Colour":"Teal","Size":"L"}'::jsonb;

  -- Switch to authenticated Seller (explicit JWT claims)
  PERFORM set_config('request.jwt.claim.sub', v_seller_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seller_id::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  v_vars_4 := jsonb_build_array(
    jsonb_build_object('id', v_v_bm, 'option_values', jsonb_build_object('Colour','Black','Size','M'), 'price_sen', 2500, 'quantity', 3),
    jsonb_build_object('id', v_v_bl, 'option_values', jsonb_build_object('Colour','Black','Size','L'), 'price_sen', 2700, 'quantity', 3),
    jsonb_build_object('id', v_v_tm, 'option_values', jsonb_build_object('Colour','Teal','Size','M'),  'price_sen', 2900, 'quantity', 3),
    jsonb_build_object('id', v_v_tl, 'option_values', jsonb_build_object('Colour','Teal','Size','L'),  'price_sen', 3100, 'quantity', 3)
  );

  -- ---------------------------------------------------------------------------
  -- TEST 1: Gallery accepts 10 photos and rejects 11 (RPC + table CHECK)
  -- ---------------------------------------------------------------------------
  SELECT updated_at INTO v_updated_at FROM public.listings WHERE id = v_biz_id;
  PERFORM public.update_listing_atomic(
    v_biz_id,
    v_updated_at,
    jsonb_build_object(
      'title', '[VERIFY] 10V Hoodie', 'description', v_desc_biz, 'kind', 'business',
      'is_food', false, 'category_id', v_cat_prod, 'condition', NULL,
      'price_sen', 2500, 'quantity', 12, 'collection_area_id', v_area_id,
      'allow_offers', true, 'has_variants', true, 'option_groups', jsonb_build_array('Colour','Size'),
      'image_paths', to_jsonb(v_imgs_10), 'rules_acknowledged', true, 'status', 'published'
    ),
    v_vars_4
  );
  IF (SELECT cardinality(image_paths) FROM public.listings WHERE id = v_biz_id) <> 10 THEN
    RAISE EXCEPTION 'T1_FAILED: expected 10 saved gallery photos';
  END IF;

  SELECT updated_at INTO v_updated_at FROM public.listings WHERE id = v_biz_id;
  v_failed := false;
  v_err_state := NULL;
  v_err_msg := NULL;
  BEGIN
    PERFORM public.update_listing_atomic(
      v_biz_id,
      v_updated_at,
      jsonb_build_object(
        'title', '[VERIFY] 10V Hoodie', 'description', v_desc_biz, 'kind', 'business',
        'is_food', false, 'category_id', v_cat_prod, 'condition', NULL,
        'price_sen', 2500, 'quantity', 12, 'collection_area_id', v_area_id,
        'allow_offers', true, 'has_variants', true, 'option_groups', jsonb_build_array('Colour','Size'),
        'image_paths', to_jsonb(v_imgs_11), 'rules_acknowledged', true, 'status', 'published'
      ),
      v_vars_4
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    GET STACKED DIAGNOSTICS v_err_state = RETURNED_SQLSTATE, v_err_msg = MESSAGE_TEXT;
  END;
  IF NOT v_failed OR (v_err_state <> '23514' AND v_err_msg !~* 'image|photo|10') THEN
    RAISE EXCEPTION 'T1_FAILED: expected image limit failure on 11 photos, got % / %', v_err_state, v_err_msg;
  END IF;

  -- Authenticated seller direct gallery update succeeds (must not hit 42703 in shared trigger)
  UPDATE public.listings SET image_paths = ARRAY[v_p1, v_p2, v_p3] WHERE id = v_biz_id;
  IF (SELECT cardinality(image_paths) FROM public.listings WHERE id = v_biz_id) <> 3 THEN
    RAISE EXCEPTION 'T1_FAILED: authenticated seller direct gallery update failed';
  END IF;

  -- Eleven photos must be rejected by the intended CHECK (23514), not a trigger field error (42703)
  v_failed := false;
  v_err_state := NULL;
  v_err_msg := NULL;
  BEGIN
    UPDATE public.listings SET image_paths = v_imgs_11 WHERE id = v_biz_id;
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    GET STACKED DIAGNOSTICS v_err_state = RETURNED_SQLSTATE, v_err_msg = MESSAGE_TEXT;
  END;
  IF NOT v_failed OR v_err_state <> '23514' THEN
    RAISE EXCEPTION 'T1_FAILED: expected SQLSTATE 23514 CHECK violation on 11 photos, got % / %', v_err_state, v_err_msg;
  END IF;

  -- ---------------------------------------------------------------------------
  -- TEST 2: Variation limit (50 accepted, 50->50 replacement works, 51 rejected)
  -- ---------------------------------------------------------------------------
  FOR i IN 1..51 LOOP
    IF i <= 50 THEN
      v_vars_50 := v_vars_50 || jsonb_build_array(
        jsonb_build_object('option_values', jsonb_build_object('Option', 'Opt-' || i::text), 'price_sen', 1000, 'quantity', 1)
      );
      v_vars_50_repl := v_vars_50_repl || jsonb_build_array(
        jsonb_build_object('option_values', jsonb_build_object('Option', 'Repl-' || i::text), 'price_sen', 1200, 'quantity', 2)
      );
    END IF;
    v_vars_51 := v_vars_51 || jsonb_build_array(
      jsonb_build_object('option_values', jsonb_build_object('Option', 'Opt-' || i::text), 'price_sen', 1000, 'quantity', 1)
    );
  END LOOP;

  SELECT updated_at INTO v_updated_at FROM public.listings WHERE id = v_scale_id;
  PERFORM public.update_listing_atomic(
    v_scale_id,
    v_updated_at,
    jsonb_build_object(
      'title', '[VERIFY] 10V Scale', 'description', v_desc_scale, 'kind', 'business',
      'is_food', false, 'category_id', v_cat_prod, 'condition', NULL,
      'price_sen', 1000, 'quantity', 50, 'collection_area_id', v_area_id,
      'allow_offers', false, 'has_variants', true, 'option_groups', jsonb_build_array('Option'),
      'image_paths', jsonb_build_array(v_p1), 'rules_acknowledged', true, 'status', 'published'
    ),
    v_vars_50
  );
  SELECT count(*)::integer INTO v_cnt FROM public.listing_variants WHERE listing_id = v_scale_id AND active IS TRUE;
  IF v_cnt <> 50 THEN
    RAISE EXCEPTION 'T2_FAILED: expected 50 active variants, got %', v_cnt;
  END IF;

  -- Replace all 50 combinations with 50 new combinations at the 50-variant ceiling
  SELECT updated_at INTO v_updated_at FROM public.listings WHERE id = v_scale_id;
  PERFORM public.save_listing_edit_atomic(
    v_scale_id,
    v_updated_at,
    jsonb_build_object(
      'title', '[VERIFY] 10V Scale', 'description', v_desc_scale, 'kind', 'business',
      'is_food', false, 'category_id', v_cat_prod, 'condition', NULL,
      'price_sen', 1200, 'quantity', 100, 'collection_area_id', v_area_id,
      'allow_offers', false, 'has_variants', true, 'option_groups', jsonb_build_array('Option'),
      'image_paths', jsonb_build_array(v_p1), 'rules_acknowledged', true, 'status', 'published'
    ),
    v_vars_50_repl,
    NULL,
    '[]'::jsonb
  );
  SELECT count(*)::integer INTO v_cnt FROM public.listing_variants WHERE listing_id = v_scale_id AND active IS TRUE;
  IF v_cnt <> 50 THEN
    RAISE EXCEPTION 'T2_FAILED: expected 50 active variants after 50->50 replacement, got %', v_cnt;
  END IF;

  SELECT updated_at INTO v_updated_at FROM public.listings WHERE id = v_scale_id;
  v_failed := false;
  v_err_msg := NULL;
  BEGIN
    PERFORM public.update_listing_atomic(
      v_scale_id,
      v_updated_at,
      jsonb_build_object(
        'title', '[VERIFY] 10V Scale', 'description', v_desc_scale, 'kind', 'business',
        'is_food', false, 'category_id', v_cat_prod, 'condition', NULL,
        'price_sen', 1000, 'quantity', 51, 'collection_area_id', v_area_id,
        'allow_offers', false, 'has_variants', true, 'option_groups', jsonb_build_array('Option'),
        'image_paths', jsonb_build_array(v_p1), 'rules_acknowledged', true, 'status', 'published'
      ),
      v_vars_51
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    GET STACKED DIAGNOSTICS v_err_msg = MESSAGE_TEXT;
  END;
  IF NOT v_failed OR v_err_msg !~* 'variant|50|TOO_MANY_LISTING_VARIANTS' THEN
    RAISE EXCEPTION 'T2_FAILED: expected 50-variant error on 51 variants, got %', v_err_msg;
  END IF;

  v_failed := false;
  v_err_msg := NULL;
  BEGIN
    INSERT INTO public.listing_variants (listing_id, option_values, price_sen, quantity, reserved_quantity, active)
    VALUES (v_scale_id, '{"Option":"Opt-51"}'::jsonb, 1000, 1, 0, true);
    SET CONSTRAINTS trg_guard_listing_variant_consistency IMMEDIATE;
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    GET STACKED DIAGNOSTICS v_err_msg = MESSAGE_TEXT;
  END;
  IF NOT v_failed OR v_err_msg <> 'TOO_MANY_LISTING_VARIANTS' THEN
    RAISE EXCEPTION 'T2_FAILED: expected TOO_MANY_LISTING_VARIANTS on direct 51st active insert, got %', v_err_msg;
  END IF;

  -- ---------------------------------------------------------------------------
  -- TEST 3 (FIX 1): Assign photos, then add Black XL to photographed Black group
  -- ---------------------------------------------------------------------------
  v_imgs_4 := jsonb_build_array(
    jsonb_build_object('variant_id', v_v_bm, 'option_values', jsonb_build_object('Colour','Black','Size','M'), 'image_path', v_p1, 'active', true),
    jsonb_build_object('variant_id', v_v_bl, 'option_values', jsonb_build_object('Colour','Black','Size','L'), 'image_path', v_p1, 'active', true),
    jsonb_build_object('variant_id', v_v_tm, 'option_values', jsonb_build_object('Colour','Teal','Size','M'),  'image_path', v_p2, 'active', true),
    jsonb_build_object('variant_id', v_v_tl, 'option_values', jsonb_build_object('Colour','Teal','Size','L'),  'image_path', v_p2, 'active', true)
  );

  SELECT updated_at INTO v_updated_at FROM public.listings WHERE id = v_biz_id;
  PERFORM public.save_listing_edit_atomic(
    v_biz_id,
    v_updated_at,
    jsonb_build_object(
      'title', '[VERIFY] 10V Hoodie', 'description', v_desc_biz, 'kind', 'business',
      'is_food', false, 'category_id', v_cat_prod, 'condition', NULL,
      'price_sen', 2500, 'quantity', 12, 'collection_area_id', v_area_id,
      'allow_offers', true, 'has_variants', true, 'option_groups', jsonb_build_array('Colour','Size'),
      'image_paths', jsonb_build_array(v_p1, v_p2, v_p3), 'rules_acknowledged', true, 'status', 'published'
    ),
    v_vars_4,
    'Colour',
    v_imgs_4
  );

  -- Now add new size XL for Black while Black M & L already have v_p1 (FIX 1 scenario)
  v_vars_5 := v_vars_4 || jsonb_build_array(
    jsonb_build_object('option_values', jsonb_build_object('Colour','Black','Size','XL'), 'price_sen', 2800, 'quantity', 4)
  );
  v_imgs_5 := v_imgs_4 || jsonb_build_array(
    jsonb_build_object('variant_id', NULL, 'option_values', jsonb_build_object('Colour','Black','Size','XL'), 'image_path', v_p1, 'active', true)
  );

  SELECT updated_at INTO v_updated_at FROM public.listings WHERE id = v_biz_id;
  PERFORM public.save_listing_edit_atomic(
    v_biz_id,
    v_updated_at,
    jsonb_build_object(
      'title', '[VERIFY] 10V Hoodie', 'description', v_desc_biz, 'kind', 'business',
      'is_food', false, 'category_id', v_cat_prod, 'condition', NULL,
      'price_sen', 2500, 'quantity', 16, 'collection_area_id', v_area_id,
      'allow_offers', true, 'has_variants', true, 'option_groups', jsonb_build_array('Colour','Size'),
      'image_paths', jsonb_build_array(v_p1, v_p2, v_p3), 'rules_acknowledged', true, 'status', 'published'
    ),
    v_vars_5,
    'Colour',
    v_imgs_5
  );

  SELECT id, image_path INTO v_v_bxl, v_img_val
  FROM public.listing_variants
  WHERE listing_id = v_biz_id AND option_values = '{"Colour":"Black","Size":"XL"}'::jsonb;
  IF v_v_bxl IS NULL OR v_img_val IS DISTINCT FROM v_p1 THEN
    RAISE EXCEPTION 'T3_FAILED: new Black XL expected id & image %, got id=%, img=%', v_p1, v_v_bxl, v_img_val;
  END IF;

  -- ---------------------------------------------------------------------------
  -- TEST 4 (FIX 2): Active toggle persistence, stock exclusion & ID preservation
  -- ---------------------------------------------------------------------------
  -- Deactivate Black XL (updated qty=6, price=3500) -> ID preserved, parent qty becomes 12
  v_vars_5 := v_vars_4 || jsonb_build_array(
    jsonb_build_object('id', v_v_bxl, 'option_values', jsonb_build_object('Colour','Black','Size','XL'), 'price_sen', 3500, 'quantity', 6)
  );
  v_imgs_5 := v_imgs_4 || jsonb_build_array(
    jsonb_build_object('variant_id', v_v_bxl, 'option_values', jsonb_build_object('Colour','Black','Size','XL'), 'image_path', v_p1, 'active', false)
  );

  SELECT updated_at INTO v_updated_at FROM public.listings WHERE id = v_biz_id;
  PERFORM public.save_listing_edit_atomic(
    v_biz_id,
    v_updated_at,
    jsonb_build_object(
      'title', '[VERIFY] 10V Hoodie', 'description', v_desc_biz, 'kind', 'business',
      'is_food', false, 'category_id', v_cat_prod, 'condition', NULL,
      'price_sen', 2500, 'quantity', 12, 'collection_area_id', v_area_id,
      'allow_offers', true, 'has_variants', true, 'option_groups', jsonb_build_array('Colour','Size'),
      'image_paths', jsonb_build_array(v_p1, v_p2, v_p3), 'rules_acknowledged', true, 'status', 'published'
    ),
    v_vars_5,
    'Colour',
    v_imgs_5
  );

  SELECT lv.active, lv.quantity, lv.price_sen INTO v_active_flag, v_qty, v_price
  FROM public.listing_variants lv WHERE lv.id = v_v_bxl;
  IF v_active_flag IS NOT FALSE OR v_qty <> 6 OR v_price <> 3500 THEN
    RAISE EXCEPTION 'T4_FAILED: deactivated Black XL expected active=false qty=6 price=3500, got active=% qty=% price=%', v_active_flag, v_qty, v_price;
  END IF;

  IF (SELECT quantity FROM public.listings WHERE id = v_biz_id) <> 12 THEN
    RAISE EXCEPTION 'T4_FAILED: parent quantity should exclude inactive Black XL (expected 12)';
  END IF;

  -- Reactivate Black XL -> preserves exact same UUID and restores parent stock to 18
  v_imgs_5 := v_imgs_4 || jsonb_build_array(
    jsonb_build_object('variant_id', v_v_bxl, 'option_values', jsonb_build_object('Colour','Black','Size','XL'), 'image_path', v_p1, 'active', true)
  );
  SELECT updated_at INTO v_updated_at FROM public.listings WHERE id = v_biz_id;
  PERFORM public.save_listing_edit_atomic(
    v_biz_id,
    v_updated_at,
    jsonb_build_object(
      'title', '[VERIFY] 10V Hoodie', 'description', v_desc_biz, 'kind', 'business',
      'is_food', false, 'category_id', v_cat_prod, 'condition', NULL,
      'price_sen', 2500, 'quantity', 18, 'collection_area_id', v_area_id,
      'allow_offers', true, 'has_variants', true, 'option_groups', jsonb_build_array('Colour','Size'),
      'image_paths', jsonb_build_array(v_p1, v_p2, v_p3), 'rules_acknowledged', true, 'status', 'published'
    ),
    v_vars_5,
    'Colour',
    v_imgs_5
  );
  SELECT id, active INTO v_v_bxl_react, v_active_flag
  FROM public.listing_variants
  WHERE listing_id = v_biz_id AND option_values = '{"Colour":"Black","Size":"XL"}'::jsonb;
  IF v_v_bxl_react IS DISTINCT FROM v_v_bxl OR v_active_flag IS NOT TRUE OR (SELECT quantity FROM public.listings WHERE id = v_biz_id) <> 18 THEN
    RAISE EXCEPTION 'T4_FAILED: reactivated Black XL lost ID or stock mismatch';
  END IF;

  -- Clean back to 4 variants via omitting Black XL (deactivates Black XL) before T5
  SELECT updated_at INTO v_updated_at FROM public.listings WHERE id = v_biz_id;
  PERFORM public.save_listing_edit_atomic(
    v_biz_id,
    v_updated_at,
    jsonb_build_object(
      'title', '[VERIFY] 10V Hoodie', 'description', v_desc_biz, 'kind', 'business',
      'is_food', false, 'category_id', v_cat_prod, 'condition', NULL,
      'price_sen', 2500, 'quantity', 12, 'collection_area_id', v_area_id,
      'allow_offers', true, 'has_variants', true, 'option_groups', jsonb_build_array('Colour','Size'),
      'image_paths', jsonb_build_array(v_p1, v_p2, v_p3), 'rules_acknowledged', true, 'status', 'published'
    ),
    v_vars_4,
    'Colour',
    v_imgs_4
  );

  -- ---------------------------------------------------------------------------
  -- TEST 5: Cross-listing / Unauthorized / Invalid Payloads / Atomic Rollback
  -- ---------------------------------------------------------------------------
  v_failed := false;
  v_err_msg := NULL;
  BEGIN
    PERFORM public.sync_listing_variation_images_atomic(
      v_biz_id,
      'Colour',
      jsonb_build_array(jsonb_build_object('variant_id', v_v_bm, 'image_path', v_foreign_img))
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    GET STACKED DIAGNOSTICS v_err_msg = MESSAGE_TEXT;
  END;
  IF NOT v_failed OR v_err_msg <> 'INVALID_VARIATION_IMAGE_PATH' THEN
    RAISE EXCEPTION 'T5_FAILED: expected INVALID_VARIATION_IMAGE_PATH via RPC, got %', v_err_msg;
  END IF;

  v_failed := false;
  v_err_msg := NULL;
  BEGIN
    UPDATE public.listing_variants SET image_path = v_foreign_img WHERE id = v_v_bm;
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    GET STACKED DIAGNOSTICS v_err_msg = MESSAGE_TEXT;
  END;
  IF NOT v_failed OR v_err_msg <> 'INVALID_VARIATION_IMAGE_PATH' THEN
    RAISE EXCEPTION 'T5_FAILED: expected INVALID_VARIATION_IMAGE_PATH on direct write, got %', v_err_msg;
  END IF;

  -- Direct variant reassignment to another listing must remain forbidden (42501)
  -- Clear image_path in NEW so BEFORE UPDATE image validation passes and the reassignment guard fires
  v_failed := false;
  v_err_state := NULL;
  v_err_msg := NULL;
  BEGIN
    UPDATE public.listing_variants
    SET listing_id = v_scale_id,
        image_path = NULL
    WHERE id = v_v_bm;
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    GET STACKED DIAGNOSTICS v_err_state = RETURNED_SQLSTATE, v_err_msg = MESSAGE_TEXT;
  END;
  IF NOT v_failed OR v_err_state <> '42501' OR v_err_msg <> 'Cannot reassign variant to another listing' THEN
    RAISE EXCEPTION 'T5_FAILED: expected 42501 variant reassignment rejection, got % / %', v_err_state, v_err_msg;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.listing_variants
    WHERE id = v_v_bm AND listing_id = v_biz_id AND image_path IS NOT DISTINCT FROM v_p1
  ) THEN
    RAISE EXCEPTION 'T5_FAILED: original variant changed after reassignment rejection';
  END IF;

  -- Unauthorized other seller
  PERFORM set_config('request.jwt.claim.sub', v_other_seller_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other_seller_id::text, 'role', 'authenticated')::text, true);
  v_failed := false;
  v_err_msg := NULL;
  BEGIN
    PERFORM public.sync_listing_variation_images_atomic(v_biz_id, 'Colour', v_imgs_4);
  EXCEPTION WHEN SQLSTATE '42501' THEN
    v_failed := true;
    v_err_msg := SQLERRM;
  END;
  IF NOT v_failed OR v_err_msg <> 'FORBIDDEN_LISTING_OWNER' THEN
    RAISE EXCEPTION 'T5_FAILED: expected FORBIDDEN_LISTING_OWNER, got %', v_err_msg;
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_seller_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seller_id::text, 'role', 'authenticated')::text, true);

  -- Invalid group, non-array, invalid UUID, unmatched UUID, conflicting option images
  v_failed := false;
  v_err_msg := NULL;
  BEGIN
    PERFORM public.sync_listing_variation_images_atomic(v_biz_id, 'Material', v_imgs_4);
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    GET STACKED DIAGNOSTICS v_err_msg = MESSAGE_TEXT;
  END;
  IF NOT v_failed OR v_err_msg <> 'INVALID_VARIATION_PHOTO_GROUP' THEN
    RAISE EXCEPTION 'T5_FAILED: expected INVALID_VARIATION_PHOTO_GROUP, got %', v_err_msg;
  END IF;

  v_failed := false;
  v_err_msg := NULL;
  BEGIN
    PERFORM public.sync_listing_variation_images_atomic(v_biz_id, 'Colour', '{}'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    GET STACKED DIAGNOSTICS v_err_msg = MESSAGE_TEXT;
  END;
  IF NOT v_failed OR v_err_msg <> 'INVALID_VARIANT_IMAGES_PAYLOAD' THEN
    RAISE EXCEPTION 'T5_FAILED: expected INVALID_VARIANT_IMAGES_PAYLOAD, got %', v_err_msg;
  END IF;

  v_failed := false;
  v_err_msg := NULL;
  BEGIN
    PERFORM public.sync_listing_variation_images_atomic(
      v_biz_id,
      'Colour',
      jsonb_build_array(jsonb_build_object('variant_id', 'bad-uuid', 'image_path', v_p1))
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    GET STACKED DIAGNOSTICS v_err_msg = MESSAGE_TEXT;
  END;
  IF NOT v_failed OR v_err_msg <> 'INVALID_VARIANT_ID' THEN
    RAISE EXCEPTION 'T5_FAILED: expected INVALID_VARIANT_ID, got %', v_err_msg;
  END IF;

  v_failed := false;
  v_err_msg := NULL;
  BEGIN
    PERFORM public.sync_listing_variation_images_atomic(
      v_biz_id,
      'Colour',
      jsonb_build_array(jsonb_build_object('variant_id', gen_random_uuid(), 'image_path', v_p1))
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    GET STACKED DIAGNOSTICS v_err_msg = MESSAGE_TEXT;
  END;
  IF NOT v_failed OR v_err_msg <> 'UNMATCHED_VARIANT_ID' THEN
    RAISE EXCEPTION 'T5_FAILED: expected UNMATCHED_VARIANT_ID, got %', v_err_msg;
  END IF;

  v_failed := false;
  v_err_msg := NULL;
  BEGIN
    PERFORM public.sync_listing_variation_images_atomic(
      v_biz_id,
      'Colour',
      jsonb_build_array(
        jsonb_build_object('variant_id', v_v_bm, 'image_path', v_p1),
        jsonb_build_object('variant_id', v_v_bl, 'image_path', v_p2)
      )
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    GET STACKED DIAGNOSTICS v_err_msg = MESSAGE_TEXT;
  END;
  IF NOT v_failed OR v_err_msg <> 'CONFLICTING_VARIATION_IMAGE_MAPPING' THEN
    RAISE EXCEPTION 'T5_FAILED: expected CONFLICTING_VARIATION_IMAGE_MAPPING via RPC, got %', v_err_msg;
  END IF;

  -- Direct conflicting write caught by deferred constraint triggers on immediate check
  v_failed := false;
  v_err_msg := NULL;
  BEGIN
    UPDATE public.listing_variants SET image_path = v_p2 WHERE id = v_v_bm;
    SET CONSTRAINTS trg_guard_listings_final_variation, trg_guard_listing_variant_consistency IMMEDIATE;
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    GET STACKED DIAGNOSTICS v_err_msg = MESSAGE_TEXT;
  END;
  IF NOT v_failed OR v_err_msg <> 'CONFLICTING_VARIATION_IMAGE_MAPPING' THEN
    RAISE EXCEPTION 'T5_FAILED: expected CONFLICTING_VARIATION_IMAGE_MAPPING on direct write, got %', v_err_msg;
  END IF;

  -- Deferred listing trigger verifies valid photo-group & variant image membership together
  PERFORM public.assert_listing_variation_integrity(v_biz_id);

  -- Atomic rollback test (FIX 5): failed image sync must roll back listing title & updated_at
  SELECT updated_at INTO v_prev_updated_at FROM public.listings WHERE id = v_biz_id;
  v_failed := false;
  v_err_msg := NULL;
  BEGIN
    PERFORM public.save_listing_edit_atomic(
      v_biz_id,
      v_prev_updated_at,
      jsonb_build_object(
        'title', '[SHOULD ROLLBACK] Modified Title', 'description', v_desc_biz, 'kind', 'business',
        'is_food', false, 'category_id', v_cat_prod, 'condition', NULL,
        'price_sen', 2500, 'quantity', 12, 'collection_area_id', v_area_id,
        'allow_offers', true, 'has_variants', true, 'option_groups', jsonb_build_array('Colour','Size'),
        'image_paths', jsonb_build_array(v_p1, v_p2, v_p3), 'rules_acknowledged', true, 'status', 'published'
      ),
      v_vars_4,
      'Colour',
      jsonb_build_array(
        jsonb_build_object('variant_id', v_v_bm, 'image_path', v_foreign_img)
      )
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    GET STACKED DIAGNOSTICS v_err_msg = MESSAGE_TEXT;
  END;
  IF NOT v_failed OR v_err_msg <> 'INVALID_VARIATION_IMAGE_PATH' THEN
    RAISE EXCEPTION 'T5_FAILED: expected atomic rollback error INVALID_VARIATION_IMAGE_PATH, got %', v_err_msg;
  END IF;
  IF (SELECT title FROM public.listings WHERE id = v_biz_id) <> '[VERIFY] 10V Hoodie' THEN
    RAISE EXCEPTION 'T5_FAILED: failed sync did NOT roll back listing edit';
  END IF;

  -- Clearing variation_photo_group clears stale active & inactive mappings
  PERFORM public.sync_listing_variation_images_atomic(v_biz_id, NULL, '[]'::jsonb);
  SELECT count(*)::integer INTO v_cnt FROM public.listing_variants WHERE listing_id = v_biz_id AND image_path IS NOT NULL;
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'T5_FAILED: clearing variation_photo_group left % stale variant images', v_cnt;
  END IF;

  -- Restore Colour -> p1/p2 mappings before T6
  PERFORM public.sync_listing_variation_images_atomic(v_biz_id, 'Colour', v_imgs_4);

  -- ---------------------------------------------------------------------------
  -- TEST 6: Atomic create across Standard, Food Pre-Order, Service & Rollback
  -- ---------------------------------------------------------------------------
  -- 6a: Student Business with variations + valid condition + active/inactive stock exclusion
  SELECT public.create_listing_with_variations_atomic(
    jsonb_build_object(
      'kind', 'business', 'is_food', false, 'title', '[VERIFY] 10V Atomic Create',
      'description', v_desc_biz, 'category_id', v_cat_prod, 'condition', 'New/Unused',
      'price_sen', 2000, 'quantity', 99, 'collection_area_id', v_area_id,
      'allow_offers', false, 'has_variants', true, 'option_groups', jsonb_build_array('Colour'),
      'variation_photo_group', 'Colour', 'image_paths', jsonb_build_array(v_p1, v_p2),
      'rules_acknowledged', true, 'status', 'published'
    ),
    jsonb_build_array(
      jsonb_build_object('option_values', jsonb_build_object('Colour', 'Black'), 'price_sen', 2000, 'quantity', 3, 'active', true,  'image_path', v_p1),
      jsonb_build_object('option_values', jsonb_build_object('Colour', 'Teal'),  'price_sen', 1500, 'quantity', 5, 'active', false, 'image_path', v_p2)
    )
  ) INTO v_create_ok_id;

  IF (SELECT quantity FROM public.listings WHERE id = v_create_ok_id) <> 3
     OR (SELECT price_sen FROM public.listings WHERE id = v_create_ok_id) <> 2000 THEN
    RAISE EXCEPTION 'T6_FAILED: atomic create did not exclude inactive variant stock/price';
  END IF;

  -- Published non-food business with condition=NULL must fail with CONDITION_REQUIRED; draft succeeds
  v_failed := false;
  v_err_msg := NULL;
  BEGIN
    PERFORM public.create_listing_with_variations_atomic(
      jsonb_build_object(
        'kind', 'business', 'is_food', false, 'title', '[VERIFY] Missing Biz Condition',
        'description', v_desc_biz, 'category_id', v_cat_prod, 'condition', NULL,
        'price_sen', 2000, 'quantity', 3, 'collection_area_id', v_area_id,
        'rules_acknowledged', true, 'status', 'published'
      ),
      '[]'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    GET STACKED DIAGNOSTICS v_err_msg = MESSAGE_TEXT;
  END;
  IF NOT v_failed OR v_err_msg <> 'CONDITION_REQUIRED' THEN
    RAISE EXCEPTION 'T6_FAILED: expected CONDITION_REQUIRED for published business without condition, got %', v_err_msg;
  END IF;

  SELECT public.create_listing_with_variations_atomic(
    jsonb_build_object(
      'kind', 'business', 'is_food', false, 'title', '[VERIFY] Draft Biz No Condition',
      'description', v_desc_biz, 'category_id', v_cat_prod, 'condition', NULL,
      'price_sen', 2000, 'quantity', 0, 'status', 'draft'
    ),
    '[]'::jsonb
  ) INTO v_create_ok_id;
  IF (SELECT status FROM public.listings WHERE id = v_create_ok_id) <> 'draft' THEN
    RAISE EXCEPTION 'T6_FAILED: draft business creation without condition failed';
  END IF;

  -- 6b: Standard Pre-Loved product creation + Pre-Loved variants forbidden
  SELECT public.create_listing_with_variations_atomic(
    jsonb_build_object(
      'kind', 'pre_loved', 'is_food', false, 'title', '[VERIFY] 10V Standard Pre-Loved',
      'description', v_desc_pre, 'category_id', v_cat_prod, 'condition', 'Like New',
      'price_sen', 1500, 'quantity', 2, 'collection_area_id', v_area_id,
      'allow_offers', true, 'has_variants', false, 'option_groups', '[]'::jsonb,
      'image_paths', jsonb_build_array(v_p3), 'rules_acknowledged', true, 'status', 'published'
    ),
    '[]'::jsonb
  ) INTO v_create_ok_id;
  IF (SELECT allow_offers FROM public.listings WHERE id = v_create_ok_id) IS NOT TRUE
     OR (SELECT condition FROM public.listings WHERE id = v_create_ok_id) <> 'Like New' THEN
    RAISE EXCEPTION 'T6_FAILED: standard Pre-Loved creation mismatch';
  END IF;

  v_failed := false;
  v_err_msg := NULL;
  BEGIN
    PERFORM public.create_listing_with_variations_atomic(
      jsonb_build_object(
        'kind', 'pre_loved', 'is_food', false, 'title', '[VERIFY] Invalid Pre-Loved Variants',
        'description', v_desc_pre, 'category_id', v_cat_prod, 'condition', 'Like New',
        'price_sen', 1500, 'quantity', 1, 'collection_area_id', v_area_id,
        'has_variants', true, 'option_groups', jsonb_build_array('Size'),
        'rules_acknowledged', true, 'status', 'published'
      ),
      jsonb_build_array(
        jsonb_build_object('option_values', jsonb_build_object('Size', 'M'), 'price_sen', 1500, 'quantity', 1)
      )
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    GET STACKED DIAGNOSTICS v_err_msg = MESSAGE_TEXT;
  END;
  IF NOT v_failed OR v_err_msg <> 'PRELOVED_VARIANTS_FORBIDDEN' THEN
    RAISE EXCEPTION 'T6_FAILED: expected PRELOVED_VARIANTS_FORBIDDEN, got %', v_err_msg;
  END IF;

  -- 6c: Campus Food pre-order & Food with variants (condition=NULL allowed)
  SELECT public.create_listing_with_variations_atomic(
    jsonb_build_object(
      'kind', 'business', 'is_food', true, 'title', '[VERIFY] 10V Campus Food Pre-Order',
      'description', v_desc_biz, 'category_id', v_cat_prod, 'condition', NULL,
      'price_sen', 1200, 'quantity', 10, 'collection_area_id', v_area_id,
      'allow_offers', false, 'has_variants', true, 'option_groups', jsonb_build_array('Pack'),
      'availability_mode', 'pre_order',
      'preorder_close_at', (v_now + interval '4 hours')::text,
      'pickup_window_start', (v_now + interval '6 hours')::text,
      'pickup_window_end', (v_now + interval '8 hours')::text,
      'pickup_note', 'Outside Cafe UMSKAL',
      'food_notes', 'Contains peanuts',
      'image_paths', jsonb_build_array(v_p1), 'rules_acknowledged', true, 'status', 'published'
    ),
    jsonb_build_array(
      jsonb_build_object('option_values', jsonb_build_object('Pack', 'Regular'), 'price_sen', 1200, 'quantity', 10, 'active', true)
    )
  ) INTO v_create_ok_id;
  IF (SELECT availability_mode FROM public.listings WHERE id = v_create_ok_id) <> 'pre_order'
     OR (SELECT preorder_close_at FROM public.listings WHERE id = v_create_ok_id) IS NULL
     OR (SELECT pickup_window_start FROM public.listings WHERE id = v_create_ok_id) IS NULL
     OR (SELECT pickup_window_end FROM public.listings WHERE id = v_create_ok_id) IS NULL
     OR (SELECT condition FROM public.listings WHERE id = v_create_ok_id) IS NOT NULL THEN
    RAISE EXCEPTION 'T6_FAILED: Campus Food pre-order/variant fields were not persisted cleanly';
  END IF;

  -- 6d: Campus Service creation (valid service_mode required on publish, variants forbidden)
  SELECT public.create_listing_with_variations_atomic(
    jsonb_build_object(
      'kind', 'service', 'is_food', false, 'title', '[VERIFY] 10V Campus Service',
      'description', v_desc_svc, 'category_id', v_cat_svc, 'condition', NULL,
      'price_sen', 2000, 'quantity', 1, 'collection_area_id', NULL,
      'allow_offers', false, 'has_variants', false, 'option_groups', '[]'::jsonb,
      'service_mode', 'both', 'accepting_requests', true,
      'image_paths', jsonb_build_array(v_p4), 'rules_acknowledged', true, 'status', 'published'
    ),
    '[]'::jsonb
  ) INTO v_create_ok_id;
  IF (SELECT service_mode FROM public.listings WHERE id = v_create_ok_id) <> 'both'
     OR (SELECT accepting_requests FROM public.listings WHERE id = v_create_ok_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'T6_FAILED: Campus Service mode/flags were not persisted';
  END IF;

  v_failed := false;
  v_err_msg := NULL;
  BEGIN
    PERFORM public.create_listing_with_variations_atomic(
      jsonb_build_object(
        'kind', 'service', 'is_food', false, 'title', '[VERIFY] Missing Service Mode',
        'description', v_desc_svc, 'category_id', v_cat_svc, 'price_sen', 2000, 'quantity', 1,
        'has_variants', false, 'service_mode', NULL, 'rules_acknowledged', true, 'status', 'published'
      ),
      '[]'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    GET STACKED DIAGNOSTICS v_err_msg = MESSAGE_TEXT;
  END;
  IF NOT v_failed OR v_err_msg <> 'SERVICE_MODE_REQUIRED' THEN
    RAISE EXCEPTION 'T6_FAILED: expected SERVICE_MODE_REQUIRED, got %', v_err_msg;
  END IF;

  v_failed := false;
  v_err_msg := NULL;
  BEGIN
    PERFORM public.create_listing_with_variations_atomic(
      jsonb_build_object(
        'kind', 'service', 'is_food', false, 'title', '[VERIFY] Invalid Service Variants',
        'description', v_desc_svc, 'category_id', v_cat_svc, 'price_sen', 2000, 'quantity', 1,
        'has_variants', true, 'service_mode', 'remote', 'rules_acknowledged', true, 'status', 'published'
      ),
      jsonb_build_array(
        jsonb_build_object('option_values', jsonb_build_object('Tier', 'Pro'), 'price_sen', 2000, 'quantity', 1)
      )
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    GET STACKED DIAGNOSTICS v_err_msg = MESSAGE_TEXT;
  END;
  IF NOT v_failed OR v_err_msg <> 'SERVICE_VARIANTS_FORBIDDEN' THEN
    RAISE EXCEPTION 'T6_FAILED: expected SERVICE_VARIANTS_FORBIDDEN, got %', v_err_msg;
  END IF;

  -- 6e: Seller payout account required before publishing (allowed for draft)
  PERFORM set_config('request.jwt.claim.sub', v_buyer_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_buyer_id::text, 'role', 'authenticated')::text, true);

  v_failed := false;
  v_err_state := NULL;
  v_err_msg := NULL;
  BEGIN
    PERFORM public.create_listing_with_variations_atomic(
      jsonb_build_object(
        'kind', 'pre_loved', 'is_food', false, 'title', '[VERIFY] No Payout Publish',
        'description', v_desc_pre, 'category_id', v_cat_prod, 'condition', 'Good',
        'price_sen', 1500, 'quantity', 1, 'collection_area_id', v_area_id,
        'rules_acknowledged', true, 'status', 'published'
      ),
      '[]'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    GET STACKED DIAGNOSTICS v_err_state = RETURNED_SQLSTATE, v_err_msg = MESSAGE_TEXT;
  END;
  IF NOT v_failed OR v_err_state <> '42501' OR v_err_msg <> 'PAYOUT_ACCOUNT_REQUIRED' THEN
    RAISE EXCEPTION 'T6_FAILED: expected 42501/PAYOUT_ACCOUNT_REQUIRED without payout account, got %/%', v_err_state, v_err_msg;
  END IF;

  SELECT public.create_listing_with_variations_atomic(
    jsonb_build_object(
      'kind', 'pre_loved', 'is_food', false, 'title', '[VERIFY] No Payout Draft',
      'description', v_desc_pre, 'category_id', v_cat_prod, 'condition', 'Good',
      'price_sen', 1500, 'quantity', 1, 'status', 'draft'
    ),
    '[]'::jsonb
  ) INTO v_create_ok_id;
  IF (SELECT status FROM public.listings WHERE id = v_create_ok_id) <> 'draft' THEN
    RAISE EXCEPTION 'T6_FAILED: draft creation without payout account failed';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_seller_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seller_id::text, 'role', 'authenticated')::text, true);

  -- 6f (original T6e): Failed variation image reaches INVALID_VARIATION_IMAGE_PATH and rolls back completely
  v_failed := false;
  v_err_msg := NULL;
  BEGIN
    PERFORM public.create_listing_with_variations_atomic(
      jsonb_build_object(
        'kind', 'business', 'is_food', false, 'title', '[VERIFY] Should Not Exist',
        'description', v_desc_biz, 'category_id', v_cat_prod, 'condition', 'New/Unused',
        'price_sen', 2000, 'quantity', 3, 'collection_area_id', v_area_id,
        'allow_offers', false, 'has_variants', true, 'option_groups', jsonb_build_array('Colour'),
        'variation_photo_group', 'Colour', 'image_paths', jsonb_build_array(v_p1),
        'rules_acknowledged', true, 'status', 'published'
      ),
      jsonb_build_array(
        jsonb_build_object('option_values', jsonb_build_object('Colour', 'Black'), 'price_sen', 2000, 'quantity', 3, 'active', true, 'image_path', v_foreign_img)
      )
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    GET STACKED DIAGNOSTICS v_err_msg = MESSAGE_TEXT;
  END;
  IF NOT v_failed OR v_err_msg <> 'INVALID_VARIATION_IMAGE_PATH' THEN
    RAISE EXCEPTION 'T6_FAILED: expected atomic create error INVALID_VARIATION_IMAGE_PATH, got %', v_err_msg;
  END IF;
  IF EXISTS (SELECT 1 FROM public.listings WHERE title = '[VERIFY] Should Not Exist') THEN
    RAISE EXCEPTION 'T6_FAILED: failed atomic create left partial listing in database';
  END IF;

  -- ---------------------------------------------------------------------------
  -- TEST 7: Gallery reordering & assigned-photo removal
  -- ---------------------------------------------------------------------------
  SELECT updated_at INTO v_updated_at FROM public.listings WHERE id = v_biz_id;
  PERFORM public.save_listing_edit_atomic(
    v_biz_id,
    v_updated_at,
    jsonb_build_object(
      'title', '[VERIFY] 10V Hoodie', 'description', v_desc_biz, 'kind', 'business',
      'is_food', false, 'category_id', v_cat_prod, 'condition', NULL,
      'price_sen', 2500, 'quantity', 12, 'collection_area_id', v_area_id,
      'allow_offers', true, 'has_variants', true, 'option_groups', jsonb_build_array('Colour','Size'),
      'image_paths', jsonb_build_array(v_p3, v_p2, v_p1), 'rules_acknowledged', true, 'status', 'published'
    ),
    v_vars_4,
    'Colour',
    v_imgs_4
  );
  IF (SELECT image_path FROM public.listing_variants WHERE id = v_v_bm) IS DISTINCT FROM v_p1
     OR (SELECT image_path FROM public.listing_variants WHERE id = v_v_tm) IS DISTINCT FROM v_p2 THEN
    RAISE EXCEPTION 'T7_FAILED: gallery reorder altered variant photo mappings';
  END IF;

  UPDATE public.listings SET image_paths = ARRAY[v_p3, v_p1] WHERE id = v_biz_id;
  IF (SELECT image_path FROM public.listing_variants WHERE id = v_v_tm) IS NOT NULL
     OR (SELECT image_path FROM public.listing_variants WHERE id = v_v_bm) IS DISTINCT FROM v_p1 THEN
    RAISE EXCEPTION 'T7_FAILED: removed gallery photo left broken or wrong variant image';
  END IF;

  v_failed := false;
  v_err_msg := NULL;
  BEGIN
    UPDATE public.listing_variants SET image_path = v_p2 WHERE id = v_v_tm;
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    GET STACKED DIAGNOSTICS v_err_msg = MESSAGE_TEXT;
  END;
  IF NOT v_failed OR v_err_msg <> 'INVALID_VARIATION_IMAGE_PATH' THEN
    RAISE EXCEPTION 'T7_FAILED: expected INVALID_VARIATION_IMAGE_PATH on removed photo, got %', v_err_msg;
  END IF;

  -- Restore gallery [p1, p2, p3] & p1/p2 mappings
  SELECT updated_at INTO v_updated_at FROM public.listings WHERE id = v_biz_id;
  PERFORM public.save_listing_edit_atomic(
    v_biz_id,
    v_updated_at,
    jsonb_build_object(
      'title', '[VERIFY] 10V Hoodie', 'description', v_desc_biz, 'kind', 'business',
      'is_food', false, 'category_id', v_cat_prod, 'condition', NULL,
      'price_sen', 2500, 'quantity', 12, 'collection_area_id', v_area_id,
      'allow_offers', true, 'has_variants', true, 'option_groups', jsonb_build_array('Colour','Size'),
      'image_paths', jsonb_build_array(v_p1, v_p2, v_p3), 'rules_acknowledged', true, 'status', 'published'
    ),
    v_vars_4,
    'Colour',
    v_imgs_4
  );

  -- ---------------------------------------------------------------------------
  -- TEST 8: Offer snapshot immutability & deactivation offer-hold protection
  -- ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', v_buyer_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_buyer_id::text, 'role', 'authenticated')::text, true);

  INSERT INTO public.offers (
    conversation_id, listing_id, variant_id, buyer_id, seller_id, offer_price_sen, variant_image_path
  ) VALUES (
    v_conv_id, v_biz_id, v_v_bm, v_buyer_id, v_seller_id, 2200, v_foreign_img
  )
  RETURNING id INTO v_offer_var;

  IF (SELECT variant_image_path FROM public.offers WHERE id = v_offer_var) IS DISTINCT FROM v_p1 THEN
    RAISE EXCEPTION 'T8_FAILED: offer insert trusted forged variant_image_path instead of server v_p1';
  END IF;

  v_failed := false;
  BEGIN
    UPDATE public.offers SET variant_image_path = v_p3 WHERE id = v_offer_var;
  EXCEPTION WHEN SQLSTATE '42501' THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'T8_FAILED: buyer modification of offer variant_image_path was not blocked with 42501';
  END IF;

  -- Second offer on Teal L -> accept it to create an active hold, verify deactivation blocked
  INSERT INTO public.offers (
    conversation_id, listing_id, variant_id, buyer_id, seller_id, offer_price_sen
  ) VALUES (
    v_conv_id, v_biz_id, v_v_tl, v_buyer_id, v_seller_id, 2800
  )
  RETURNING id INTO v_offer_hold;

  PERFORM set_config('request.jwt.claim.sub', v_seller_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seller_id::text, 'role', 'authenticated')::text, true);

  v_failed := false;
  BEGIN
    UPDATE public.offers SET variant_image_path = v_p3 WHERE id = v_offer_var;
  EXCEPTION WHEN SQLSTATE '42501' THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'T8_FAILED: seller modification of offer variant_image_path was not blocked with 42501';
  END IF;

  PERFORM public.accept_offer_atomic(v_offer_hold);

  -- Direct reserved-stock tampering on parent listing and held variant must remain blocked (42501)
  v_failed := false;
  v_err_state := NULL;
  BEGIN
    UPDATE public.listings SET reserved_quantity = 0 WHERE id = v_biz_id;
  EXCEPTION WHEN SQLSTATE '42501' THEN
    v_failed := true;
    v_err_state := SQLSTATE;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'T8_FAILED: direct modification of listing reserved_quantity was not blocked with 42501';
  END IF;

  v_failed := false;
  v_err_state := NULL;
  BEGIN
    UPDATE public.listing_variants SET reserved_quantity = 0 WHERE id = v_v_tl;
  EXCEPTION WHEN SQLSTATE '42501' THEN
    v_failed := true;
    v_err_state := SQLSTATE;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'T8_FAILED: direct modification of variant reserved_quantity was not blocked with 42501';
  END IF;

  v_failed := false;
  v_err_state := NULL;
  BEGIN
    UPDATE public.listing_variants SET quantity = 0 WHERE id = v_v_tl;
  EXCEPTION WHEN SQLSTATE '42501' THEN
    v_failed := true;
    v_err_state := SQLSTATE;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'T8_FAILED: reducing variant quantity below reserved_quantity was not blocked with 42501';
  END IF;

  -- Seller attempting to deactivate reserved / offer-held Teal L must fail (42501)
  v_failed := false;
  BEGIN
    PERFORM public.sync_listing_variation_images_atomic(
      v_biz_id,
      'Colour',
      jsonb_build_array(jsonb_build_object('variant_id', v_v_tl, 'image_path', v_p2, 'active', false))
    );
  EXCEPTION WHEN SQLSTATE '42501' THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'T8_FAILED: deactivating reserved/offer-held variant did not raise 42501';
  END IF;

  -- ---------------------------------------------------------------------------
  -- TEST 9: Partial cart checkout + service snapshots + order separation + invalid selections
  -- ---------------------------------------------------------------------------
  RESET ROLE;
  INSERT INTO public.cart_items (id, user_id, listing_id, variant_id, quantity)
  VALUES
    (v_ci_var,    v_buyer_id, v_biz_id,      v_v_tm, 1),
    (v_ci_nonvar, v_buyer_id, v_preloved_id, NULL,   1),
    (v_ci_svc,    v_buyer_id, v_svc_id,      NULL,   2);

  PERFORM set_config('request.jwt.claim.sub', v_buyer_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_buyer_id::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  SELECT * INTO v_s_cart_part
  FROM public.create_cart_checkout_atomic(
    'v10v-cart-1-' || left(v_buyer_id::text, 8),
    jsonb_build_object(
      v_ci_svc::text, jsonb_build_object(
        'requirements', 'Logo poster in campus purple',
        'attachment_paths', jsonb_build_array(v_svc_att_path)
      )
    ),
    ARRAY[v_ci_var, v_ci_svc]
  );

  SELECT * INTO v_s_cart_replay
  FROM public.create_cart_checkout_atomic(
    'v10v-cart-1-' || left(v_buyer_id::text, 8),
    NULL,
    ARRAY[v_ci_var, v_ci_svc]
  );
  IF v_s_cart_part.id IS DISTINCT FROM v_s_cart_replay.id THEN
    RAISE EXCEPTION 'T9_FAILED: idempotent replay did not return original session';
  END IF;

  IF v_s_cart_part.combined_subtotal_sen <> 5900 OR v_s_cart_part.fpx_fee_sen <> 100 THEN
    RAISE EXCEPTION 'T9_FAILED: unexpected totals %, %', v_s_cart_part.combined_subtotal_sen, v_s_cart_part.fpx_fee_sen;
  END IF;

  SELECT count(*)::integer INTO v_cnt FROM public.orders WHERE checkout_session_id = v_s_cart_part.id;
  IF v_cnt <> 2 THEN
    RAISE EXCEPTION 'T9_FAILED: expected 2 split orders (product + service), got %', v_cnt;
  END IF;

  SELECT oi.* INTO v_oi
  FROM public.order_items oi
  JOIN public.orders o ON o.id = oi.order_id
  WHERE o.checkout_session_id = v_s_cart_part.id AND oi.listing_id = v_biz_id;
  IF v_oi.image_path IS DISTINCT FROM v_p2 OR v_oi.variant_id IS DISTINCT FROM v_v_tm THEN
    RAISE EXCEPTION 'T9_FAILED: cart variant order item expected %, got %', v_p2, v_oi.image_path;
  END IF;

  SELECT oi.* INTO v_oi
  FROM public.order_items oi
  JOIN public.orders o ON o.id = oi.order_id
  WHERE o.checkout_session_id = v_s_cart_part.id AND oi.listing_id = v_svc_id;
  IF v_oi.image_path IS DISTINCT FROM v_p4
     OR v_oi.service_requirements IS DISTINCT FROM 'Logo poster in campus purple'
     OR v_oi.service_attachment_paths IS DISTINCT FROM ARRAY[v_svc_att_path] THEN
    RAISE EXCEPTION 'T9_FAILED: service order snapshot mismatch';
  END IF;

  v_failed := false;
  v_err_msg := NULL;
  BEGIN
    PERFORM * FROM public.create_cart_checkout_atomic('v10v-empty-' || left(v_buyer_id::text, 8), NULL, ARRAY[]::uuid[]);
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    GET STACKED DIAGNOSTICS v_err_msg = MESSAGE_TEXT;
  END;
  IF NOT v_failed OR v_err_msg <> 'INVALID_CART_SELECTION' THEN
    RAISE EXCEPTION 'T9_FAILED: expected INVALID_CART_SELECTION on empty selection, got %', v_err_msg;
  END IF;

  -- ---------------------------------------------------------------------------
  -- TEST 10: Historical offer & cart order snapshots survive subsequent listing edits
  -- ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', v_seller_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seller_id::text, 'role', 'authenticated')::text, true);

  -- Seller edits Black variants photo from p1 -> p3 AND cover to p3 AFTER cart order & offer created
  SELECT updated_at INTO v_updated_at FROM public.listings WHERE id = v_biz_id;
  PERFORM public.save_listing_edit_atomic(
    v_biz_id,
    v_updated_at,
    jsonb_build_object(
      'title', '[VERIFY] 10V Hoodie', 'description', v_desc_biz, 'kind', 'business',
      'is_food', false, 'category_id', v_cat_prod, 'condition', NULL,
      'price_sen', 2500, 'quantity', 12, 'collection_area_id', v_area_id,
      'allow_offers', true, 'has_variants', true, 'option_groups', jsonb_build_array('Colour','Size'),
      'image_paths', jsonb_build_array(v_p3, v_p2, v_p1), 'rules_acknowledged', true, 'status', 'published'
    ),
    v_vars_4,
    'Colour',
    jsonb_build_array(
      jsonb_build_object('variant_id', v_v_bm, 'option_values', jsonb_build_object('Colour','Black','Size','M'), 'image_path', v_p3, 'active', true),
      jsonb_build_object('variant_id', v_v_bl, 'option_values', jsonb_build_object('Colour','Black','Size','L'), 'image_path', v_p3, 'active', true),
      jsonb_build_object('variant_id', v_v_tm, 'option_values', jsonb_build_object('Colour','Teal','Size','M'),  'image_path', v_p2, 'active', true),
      jsonb_build_object('variant_id', v_v_tl, 'option_values', jsonb_build_object('Colour','Teal','Size','L'),  'image_path', v_p2, 'active', true)
    )
  );

  IF (SELECT variant_image_path FROM public.offers WHERE id = v_offer_var) IS DISTINCT FROM v_p1 THEN
    RAISE EXCEPTION 'T10_FAILED: listing edit mutated historical offer variant_image_path';
  END IF;

  PERFORM public.accept_offer_atomic(v_offer_var);

  PERFORM set_config('request.jwt.claim.sub', v_buyer_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_buyer_id::text, 'role', 'authenticated')::text, true);

  SELECT * INTO v_s_offer_var
  FROM public.create_offer_checkout_atomic(v_offer_var, 'v10v-ofr-1-' || left(v_buyer_id::text, 8));

  IF (SELECT oi.image_path FROM public.order_items oi JOIN public.orders o ON o.id = oi.order_id WHERE o.checkout_session_id = v_s_offer_var.id) IS DISTINCT FROM v_p1 THEN
    RAISE EXCEPTION 'T10_FAILED: negotiated order_item did not preserve historical offer image v_p1';
  END IF;

  -- Legacy NULL-snapshot offer fallback to live variant image (v_p3)
  RESET ROLE;
  INSERT INTO public.offers (
    id, conversation_id, listing_id, variant_id, variant_snapshot, variant_image_path,
    buyer_id, seller_id, offer_price_sen, status
  ) VALUES (
    v_offer_legacy, v_conv_id, v_biz_id, v_v_bl, '{"Colour":"Black","Size":"L"}'::jsonb, NULL,
    v_buyer_id, v_seller_id, 2400, 'pending'
  );
  PERFORM set_config('request.jwt.claim.sub', v_seller_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seller_id::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM public.accept_offer_atomic(v_offer_legacy);

  PERFORM set_config('request.jwt.claim.sub', v_buyer_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_buyer_id::text, 'role', 'authenticated')::text, true);
  SELECT * INTO v_s_offer_leg
  FROM public.create_offer_checkout_atomic(v_offer_legacy, 'v10v-ofr-leg-' || left(v_buyer_id::text, 8));
  IF (SELECT oi.image_path FROM public.order_items oi JOIN public.orders o ON o.id = oi.order_id WHERE o.checkout_session_id = v_s_offer_leg.id) IS DISTINCT FROM v_p3 THEN
    RAISE EXCEPTION 'T10_FAILED: legacy NULL offer failed to fall back to variant image p3';
  END IF;

  -- ---------------------------------------------------------------------------
  -- TEST 11: Non-variant listings correctly use cover image (cart + offer)
  -- ---------------------------------------------------------------------------
  SELECT * INTO v_s_cart_rest
  FROM public.create_cart_checkout_atomic('v10v-cart-2-' || left(v_buyer_id::text, 8), NULL, ARRAY[v_ci_nonvar]);

  IF (SELECT oi.image_path FROM public.order_items oi JOIN public.orders o ON o.id = oi.order_id WHERE o.checkout_session_id = v_s_cart_rest.id) IS DISTINCT FROM v_p3 THEN
    RAISE EXCEPTION 'T11_FAILED: non-variant cart checkout did not capture cover v_p3';
  END IF;

  INSERT INTO public.offers (
    conversation_id, listing_id, variant_id, buyer_id, seller_id, offer_price_sen
  ) VALUES (
    v_conv_id, v_preloved_id, NULL, v_buyer_id, v_seller_id, 1500
  )
  RETURNING id INTO v_offer_nonvar;

  IF (SELECT variant_image_path FROM public.offers WHERE id = v_offer_nonvar) IS DISTINCT FROM v_p3 THEN
    RAISE EXCEPTION 'T11_FAILED: non-variant offer did not snapshot cover v_p3';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_seller_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seller_id::text, 'role', 'authenticated')::text, true);
  PERFORM public.accept_offer_atomic(v_offer_nonvar);

  PERFORM set_config('request.jwt.claim.sub', v_buyer_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_buyer_id::text, 'role', 'authenticated')::text, true);
  SELECT * INTO v_s_offer_nonvar
  FROM public.create_offer_checkout_atomic(v_offer_nonvar, 'v10v-ofr-nv-' || left(v_buyer_id::text, 8));
  IF (SELECT oi.image_path FROM public.order_items oi JOIN public.orders o ON o.id = oi.order_id WHERE o.checkout_session_id = v_s_offer_nonvar.id) IS DISTINCT FROM v_p3 THEN
    RAISE EXCEPTION 'T11_FAILED: non-variant offer checkout did not capture cover v_p3';
  END IF;

  -- ---------------------------------------------------------------------------
  -- TEST 12 (FIX 3): Historical storage protection helper & RESTRICTIVE policy check
  --   (Note: zero direct DELETE FROM storage.objects; Storage API tested separately)
  -- ---------------------------------------------------------------------------
  IF NOT public.is_listing_storage_object_referenced(v_p1)
     OR NOT public.is_listing_storage_object_referenced(v_p2)
     OR NOT public.is_listing_storage_object_referenced(v_p3) THEN
    RAISE EXCEPTION 'T12_FAILED: historical listing/variant/offer/order image reported as unreferenced';
  END IF;

  IF public.is_listing_storage_object_referenced(v_unreferenced) THEN
    RAISE EXCEPTION 'T12_FAILED: genuinely unreferenced upload reported as referenced';
  END IF;

  RESET ROLE;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'listings_preserve_referenced_objects_delete'
      AND permissive = 'RESTRICTIVE'
      AND cmd = 'DELETE'
  ) THEN
    RAISE EXCEPTION 'T12_FAILED: restrictive Storage DELETE policy missing';
  END IF;

  RAISE NOTICE 'PHASE 10V VERIFICATION PASSED: ALL 12 ASSERTION GROUPS VERIFIED CLEANLY (ROLLBACK PENDING)';
END;
$$;

ROLLBACK;
