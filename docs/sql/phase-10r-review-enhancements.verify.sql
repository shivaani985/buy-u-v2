-- =============================================================================
-- Buy-U v2 — Phase 10R Rollback Verification Script
-- Target Supabase Project: duwwlcpdidrxkixvflag
-- =============================================================================
-- Run as DB owner in Supabase SQL Editor. Wraps synthetic verification inside
-- an explicit transaction ending in ROLLBACK so ZERO hosted data persists.
-- =============================================================================

BEGIN;

DO $phase10r_setup$
DECLARE
  v_suffix          text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  v_buyer_id        uuid := gen_random_uuid();
  v_other_id        uuid := gen_random_uuid();
  v_seller_id       uuid := gen_random_uuid();
  v_area_id         text;
  v_cat_id          text;
  v_listing_id      uuid := gen_random_uuid();
  v_var_id          uuid := gen_random_uuid();
  v_order_id        uuid := gen_random_uuid();
  v_incomplete uuid := gen_random_uuid();
  v_unverified uuid := gen_random_uuid();
  v_paid timestamptz := now() - interval '48 days';
  v_cover_img       text := v_seller_id::text || '/cover-' || v_suffix || '.jpg';
  v_var_img         text := v_seller_id::text || '/var-' || v_suffix || '.jpg';
BEGIN
  SELECT id INTO v_area_id FROM public.collection_areas WHERE active = true LIMIT 1;
  SELECT id INTO v_cat_id FROM public.categories WHERE active = true AND kind = 'product' LIMIT 1;
  IF v_area_id IS NULL OR v_cat_id IS NULL THEN
    RAISE EXCEPTION 'VERIFY_PREREQ_MISSING: Need active collection_areas and categories';
  END IF;

  -- Create synthetic users + active profiles
  INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at)
  VALUES
    (v_buyer_id, 'buyer_' || v_suffix || '@iluv.ums.edu.my', 'x', now(), '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
    (v_other_id, 'other_' || v_suffix || '@iluv.ums.edu.my', 'x', now(), '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
    (v_seller_id, 'seller_' || v_suffix || '@iluv.ums.edu.my', 'x', now(), '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now());

  INSERT INTO public.profiles (id, email, full_name, display_name, university_role, status)
  VALUES
    (v_buyer_id, 'buyer_' || v_suffix || '@iluv.ums.edu.my', 'Shazim Buyer', 'Shazim', 'student', 'active'),
    (v_other_id, 'other_' || v_suffix || '@iluv.ums.edu.my', 'Other Member', 'Other', 'student', 'active'),
    (v_seller_id, 'seller_' || v_suffix || '@iluv.ums.edu.my', 'Seller Student', 'Seller', 'student', 'active')
  ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, university_role = EXCLUDED.university_role;

  -- Create listing + variant + pre-migration order snapshots
  INSERT INTO public.listings (id, seller_id, title, description, kind, category_id, collection_area_id, condition, price_sen, quantity, reserved_quantity, has_variants, option_groups, variation_photo_group, image_paths, rules_acknowledged, status, published_at)
  VALUES (v_listing_id, v_seller_id, 'Perfume Set ' || v_suffix, 'Long lasting campus fragrance listing description text.', 'business', v_cat_id, v_area_id, 'New/Unused', 2500, 10, 0, true, ARRAY['Fragrance'], 'Fragrance', ARRAY[v_cover_img, v_var_img], true, 'published', now());

  INSERT INTO public.listing_variants (id, listing_id, option_values, price_sen, quantity, reserved_quantity, active, image_path)
  VALUES (v_var_id, v_listing_id, '{"Fragrance":"Hawas Fire"}'::jsonb, 2500, 5, 0, true, v_var_img);

  INSERT INTO public.orders (
    id,order_code,buyer_id,seller_id,source,subtotal_sen,fpx_fee_sen,total_paid_sen,
    commission_sen,seller_net_sen,status,collection_area_name,payment_deadline,
    paid_at,handed_over_at,completed_at
  )
  SELECT oid,'BU-10R-' || v_suffix || '-' || tag,v_buyer_id,v_seller_id,'cart',
    5000,100,5100,100,4900,state,'Cafe UMSKAL',v_paid + interval '15 minutes',v_paid,finished,finished
  FROM (VALUES
    (v_order_id,'V','completed',v_paid + interval '1 day'),
    (v_incomplete,'I','paid',NULL::timestamptz),
    (v_unverified,'U','completed',v_paid + interval '1 day')
  ) AS f(oid,tag,state,finished);

  INSERT INTO public.payments (order_id,amount_sen,bill_code,status,transaction_ref,verified_at)
  SELECT id,5100,'BILL-' || order_code,'paid','TXN-' || order_code,
    CASE WHEN id <> v_unverified THEN v_paid END
  FROM public.orders WHERE id IN (v_order_id,v_incomplete,v_unverified);

  INSERT INTO public.order_items (order_id,listing_id,variant_id,title_snapshot,variant_snapshot,unit_sen,quantity,image_path,is_service)
  SELECT oid,v_listing_id,v_var_id,'Perfume Set ' || v_suffix,'{"Fragrance":"Hawas Fire"}'::jsonb,2500,2,path,false
  FROM (VALUES (v_order_id,v_cover_img),(v_incomplete,v_var_img),(v_unverified,NULL::text)) AS f(oid,path);

  PERFORM set_config('buyu.verify_10r',json_build_object(
    'suffix',v_suffix,'buyer',v_buyer_id,'other',v_other_id,'seller',v_seller_id,'listing',v_listing_id,
    'order',v_order_id,'incomplete',v_incomplete,'unverified',v_unverified,'cover',v_cover_img
  )::text,true);
END;
$phase10r_setup$;

-- BEGIN EMBEDDED MIGRATION BODY

-- -----------------------------------------------------------------------------
-- 1. Additive columns & constraints on `public.reviews`
-- -----------------------------------------------------------------------------
ALTER TABLE public.reviews
  ADD COLUMN IF NOT EXISTS is_anonymous boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS image_paths  text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS video_path   text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS edited_at    timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS updated_at   timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION public.are_valid_review_media_paths(
  p_images text[],
  p_video  text
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_img text;
BEGIN
  IF p_images IS NULL THEN
    RETURN false;
  END IF;

  IF COALESCE(cardinality(p_images), 0) > 5 THEN
    RETURN false;
  END IF;

  FOREACH v_img IN ARRAY p_images LOOP
    IF v_img IS NULL
       OR position('..' in v_img) > 0
       OR v_img !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/validated/[A-Za-z0-9._-]+\.(jpg|png|webp)$' THEN
      RETURN false;
    END IF;
  END LOOP;

  IF p_video IS NOT NULL THEN
    IF position('..' in p_video) > 0
       OR p_video !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/validated/[A-Za-z0-9._-]+\.(mp4|webm)$' THEN
      RETURN false;
    END IF;
  END IF;

  RETURN true;
END;
$$;

ALTER TABLE public.reviews
  DROP CONSTRAINT IF EXISTS reviews_media_paths_check;
ALTER TABLE public.reviews
  ADD CONSTRAINT reviews_media_paths_check
  CHECK (public.are_valid_review_media_paths(image_paths, video_path));

-- Partial GIN/B-tree helpers for fast lookup of listing reviews & media ownership
CREATE INDEX IF NOT EXISTS idx_reviews_listing_visible
  ON public.reviews (listing_id, created_at DESC)
  WHERE listing_id IS NOT NULL AND hidden = false;

CREATE INDEX IF NOT EXISTS idx_reviews_seller_visible
  ON public.reviews (seller_id, created_at DESC)
  WHERE hidden = false;

-- -----------------------------------------------------------------------------
-- 2. Private Storage Bucket & Strict RLS (`review-media`)
--    - Bucket stays private (`public = false`) so hidden/moderated review media
--      cannot bypass moderation via static public URLs and anonymous `buyer_id`
--      storage prefixes are never exposed directly to public browsers.
--    - Supports up to 5 photos (<= 5 MB each: JPG/PNG/WebP) and 1 video (<= 20 MB: MP4/WebM)
-- -----------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'review-media',
  'review-media',
  false,
  20971520,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm']
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = 20971520,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'];

DROP POLICY IF EXISTS review_media_member_staged_insert ON storage.objects;
CREATE POLICY review_media_member_staged_insert
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'review-media'
    AND (storage.foldername(name))[1] = auth.uid()::text
    AND (storage.foldername(name))[2] = 'staged'
    AND public.is_active_member()
  );

DROP POLICY IF EXISTS review_media_member_staged_delete ON storage.objects;
CREATE POLICY review_media_member_staged_delete
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'review-media'
    AND (storage.foldername(name))[1] = auth.uid()::text
    AND (storage.foldername(name))[2] = 'staged'
  );

-- Restrictive policies also cover any broad permissive Storage policies.
DROP POLICY IF EXISTS review_media_staged_insert_only ON storage.objects;
CREATE POLICY review_media_staged_insert_only ON storage.objects AS RESTRICTIVE
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id <> 'review-media' OR (
      auth.uid() IS NOT NULL AND (storage.foldername(name))[1] = auth.uid()::text
      AND (storage.foldername(name))[2] = 'staged'
      AND cardinality(storage.foldername(name)) = 2
      AND public.is_active_member()
    )
  );

DROP POLICY IF EXISTS review_media_no_member_update ON storage.objects;
CREATE POLICY review_media_no_member_update ON storage.objects AS RESTRICTIVE
  FOR UPDATE TO authenticated
  USING (bucket_id <> 'review-media') WITH CHECK (bucket_id <> 'review-media');

DROP POLICY IF EXISTS review_media_staged_delete_only ON storage.objects;
CREATE POLICY review_media_staged_delete_only ON storage.objects AS RESTRICTIVE
  FOR DELETE TO authenticated
  USING (
    bucket_id <> 'review-media' OR (
      (storage.foldername(name))[1] = auth.uid()::text
      AND (storage.foldername(name))[2] = 'staged'
    )
  );

DROP POLICY IF EXISTS review_media_no_anon_access ON storage.objects;
CREATE POLICY review_media_no_anon_access ON storage.objects AS RESTRICTIVE
  FOR ALL TO anon
  USING (bucket_id <> 'review-media') WITH CHECK (bucket_id <> 'review-media');

DROP POLICY IF EXISTS review_media_private_read ON storage.objects;
CREATE POLICY review_media_private_read ON storage.objects AS RESTRICTIVE
  FOR SELECT TO authenticated
  USING (
    bucket_id <> 'review-media' OR (
      (storage.foldername(name))[1] = auth.uid()::text OR public.is_active_admin()
    )
  );

DROP POLICY IF EXISTS review_media_owner_select ON storage.objects;
CREATE POLICY review_media_owner_select
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'review-media'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR public.is_active_admin()
    )
  );

-- -----------------------------------------------------------------------------
-- 3. Internal validator helper for review media attachments
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.internal_validate_review_media(
  p_uid uuid,
  p_review_id uuid,
  p_image_paths text[],
  p_video_path text
)
RETURNS TABLE (
  out_images text[],
  out_video  text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_raw text;
  v_imgs text[] := '{}'::text[];
  v_video text := NULLIF(trim(COALESCE(p_video_path, '')), '');
  v_obj_size bigint;
BEGIN
  IF p_image_paths IS NOT NULL THEN
    FOREACH v_raw IN ARRAY p_image_paths LOOP
      v_raw := NULLIF(trim(COALESCE(v_raw, '')), '');
      IF v_raw IS NULL THEN
        CONTINUE;
      END IF;
      IF NOT (v_raw = ANY(v_imgs)) THEN
        v_imgs := array_append(v_imgs, v_raw);
      END IF;
    END LOOP;
  END IF;

  IF COALESCE(cardinality(v_imgs), 0) > 5 THEN
    RAISE EXCEPTION 'TOO_MANY_REVIEW_IMAGES';
  END IF;

  FOREACH v_raw IN ARRAY v_imgs LOOP
    IF position('..' in v_raw) > 0
       OR v_raw !~ ('^' || p_uid::text || '/validated/[A-Za-z0-9._-]+\.(jpg|png|webp)$') THEN
      RAISE EXCEPTION 'INVALID_REVIEW_MEDIA_PATH';
    END IF;

    SELECT COALESCE((o.metadata->>'size')::bigint, 0)
      INTO v_obj_size
    FROM storage.objects o
    WHERE o.bucket_id = 'review-media'
      AND o.name = v_raw
      AND COALESCE(o.metadata->>'mimetype', '') IN ('image/jpeg', 'image/png', 'image/webp')
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'REVIEW_MEDIA_NOT_FOUND';
    END IF;
    IF v_obj_size <= 0 OR v_obj_size > 5242880 THEN
      RAISE EXCEPTION 'REVIEW_IMAGE_SIZE_INVALID';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.reviews r
      WHERE (p_review_id IS NULL OR r.id <> p_review_id)
        AND r.image_paths @> ARRAY[v_raw]
    ) THEN
      RAISE EXCEPTION 'REVIEW_MEDIA_ALREADY_ATTACHED';
    END IF;
  END LOOP;

  IF v_video IS NOT NULL THEN
    IF position('..' in v_video) > 0
       OR v_video !~ ('^' || p_uid::text || '/validated/[A-Za-z0-9._-]+\.(mp4|webm)$') THEN
      RAISE EXCEPTION 'INVALID_REVIEW_VIDEO_PATH';
    END IF;

    SELECT COALESCE((o.metadata->>'size')::bigint, 0)
      INTO v_obj_size
    FROM storage.objects o
    WHERE o.bucket_id = 'review-media'
      AND o.name = v_video
      AND COALESCE(o.metadata->>'mimetype', '') IN ('video/mp4', 'video/webm')
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'REVIEW_VIDEO_NOT_FOUND';
    END IF;
    IF v_obj_size <= 0 OR v_obj_size > 20971520 THEN
      RAISE EXCEPTION 'REVIEW_VIDEO_SIZE_INVALID';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.reviews r
      WHERE (p_review_id IS NULL OR r.id <> p_review_id)
        AND r.video_path = v_video
    ) THEN
      RAISE EXCEPTION 'REVIEW_MEDIA_ALREADY_ATTACHED';
    END IF;
  END IF;

  RETURN QUERY SELECT v_imgs, v_video;
END;
$$;

REVOKE ALL ON FUNCTION public.internal_validate_review_media(uuid, uuid, text[], text) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. Updated `submit_verified_review_atomic` (supports media & anonymity)
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.submit_verified_review_atomic(uuid, uuid, uuid, integer, text);
DROP FUNCTION IF EXISTS public.submit_verified_review_atomic(uuid, uuid, uuid, integer, text, boolean, text[], text);

CREATE OR REPLACE FUNCTION public.submit_verified_review_atomic(
  p_order_id uuid,
  p_listing_id uuid,
  p_service_request_id uuid,
  p_rating integer,
  p_comment text,
  p_is_anonymous boolean DEFAULT false,
  p_image_paths text[] DEFAULT '{}'::text[],
  p_video_path text DEFAULT NULL
)
RETURNS TABLE (
  out_id         uuid,
  out_rating     integer,
  out_created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_order public.orders;
  v_sr public.service_requests;
  v_seller_id uuid;
  v_listing_id uuid := p_listing_id;
  v_clean_comment text := trim(COALESCE(p_comment, ''));
  v_now timestamptz := clock_timestamp();
  v_row public.reviews;
  v_imgs text[] := '{}'::text[];
  v_video text := NULL;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;
  IF p_rating IS NULL OR p_rating < 1 OR p_rating > 5 THEN
    RAISE EXCEPTION 'INVALID_RATING';
  END IF;
  IF length(v_clean_comment) < 5 OR length(v_clean_comment) > 1000 THEN
    RAISE EXCEPTION 'INVALID_REVIEW_COMMENT';
  END IF;
  IF (p_order_id IS NULL AND p_service_request_id IS NULL)
     OR (p_order_id IS NOT NULL AND p_service_request_id IS NOT NULL) THEN
    RAISE EXCEPTION 'INVALID_REVIEW_TARGET';
  END IF;

  IF p_order_id IS NOT NULL THEN
    SELECT o.* INTO v_order FROM public.orders o WHERE o.id = p_order_id FOR SHARE;
    IF NOT FOUND OR v_order.buyer_id <> v_uid THEN
      RAISE EXCEPTION 'FORBIDDEN_BUYER_ONLY' USING ERRCODE = '42501';
    END IF;
    IF v_order.seller_id = v_uid THEN RAISE EXCEPTION 'CANNOT_SELF_REVIEW'; END IF;
    IF v_order.status <> 'completed' OR NOT public.is_order_payment_verified(v_order.id) THEN
      RAISE EXCEPTION 'ORDER_NOT_ELIGIBLE_FOR_REVIEW';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.order_refunds r
      WHERE r.order_id = v_order.id AND r.refund_type = 'full_refund' AND r.status = 'succeeded'
    ) OR EXISTS (
      SELECT 1 FROM public.order_disputes d
      WHERE d.order_id = v_order.id AND d.status IN ('open', 'under_review')
    ) THEN
      RAISE EXCEPTION 'ORDER_NOT_ELIGIBLE_FOR_REVIEW';
    END IF;
    IF v_listing_id IS NULL THEN
      SELECT oi.listing_id INTO v_listing_id FROM public.order_items oi WHERE oi.order_id = v_order.id LIMIT 1;
    ELSIF NOT EXISTS (
      SELECT 1 FROM public.order_items oi WHERE oi.order_id = v_order.id AND oi.listing_id = v_listing_id
    ) THEN
      RAISE EXCEPTION 'LISTING_NOT_IN_ORDER';
    END IF;
    v_seller_id := v_order.seller_id;
  ELSE
    SELECT sr.* INTO v_sr FROM public.service_requests sr WHERE sr.id = p_service_request_id FOR SHARE;
    IF NOT FOUND OR v_sr.buyer_id <> v_uid THEN
      RAISE EXCEPTION 'FORBIDDEN_BUYER_ONLY' USING ERRCODE = '42501';
    END IF;
    IF v_sr.seller_id = v_uid THEN RAISE EXCEPTION 'CANNOT_SELF_REVIEW'; END IF;
    IF v_sr.status <> 'completed' THEN RAISE EXCEPTION 'SERVICE_NOT_ELIGIBLE_FOR_REVIEW'; END IF;
    v_seller_id := v_sr.seller_id;
    v_listing_id := v_sr.listing_id;
  END IF;

  SELECT vm.out_images, vm.out_video
    INTO v_imgs, v_video
  FROM public.internal_validate_review_media(v_uid, NULL, p_image_paths, p_video_path) vm;

  INSERT INTO public.reviews (
    order_id, listing_id, service_request_id, buyer_id, seller_id,
    rating, comment, is_anonymous, image_paths, video_path,
    hidden, created_at, updated_at
  ) VALUES (
    p_order_id, v_listing_id, p_service_request_id, v_uid, v_seller_id,
    p_rating, v_clean_comment, COALESCE(p_is_anonymous, false), COALESCE(v_imgs, '{}'::text[]), v_video,
    false, v_now, v_now
  )
  RETURNING * INTO v_row;

  UPDATE public.profiles SET last_active_at = v_now WHERE id = v_uid;

  -- Notification intentionally omits buyer identity so anonymous reviews stay confidential
  PERFORM public.safe_insert_member_notification(
    v_seller_id,
    'review_received',
    'reviews',
    'New ' || p_rating || '-star verified review',
    left(v_clean_comment, 120),
    '/seller/analytics',
    'rev-' || v_row.id::text
  );

  RETURN QUERY SELECT v_row.id, v_row.rating, v_row.created_at;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_verified_review_atomic(uuid, uuid, uuid, integer, text, boolean, text[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_verified_review_atomic(uuid, uuid, uuid, integer, text, boolean, text[], text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 5. Updated `edit_verified_review_atomic`
--    - Removes artificial 7-day edit window cap per Phase 10R
--    - Blocks editing moderated (`hidden = true`) reviews
--    - Preserves `id`, `order_id`, `listing_id`, `buyer_id`, `seller_id`,
--      `created_at`, and existing `seller_response`
--    - Updates rating, comment, `is_anonymous`, media, `edited_at`, `updated_at`
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.edit_verified_review_atomic(uuid, integer, text);
DROP FUNCTION IF EXISTS public.edit_verified_review_atomic(uuid, integer, text, boolean, text[], text);

CREATE OR REPLACE FUNCTION public.edit_verified_review_atomic(
  p_review_id uuid,
  p_rating integer,
  p_comment text,
  p_is_anonymous boolean DEFAULT NULL,
  p_image_paths text[] DEFAULT NULL,
  p_video_path text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_rev public.reviews;
  v_order_status text;
  v_clean text := trim(COALESCE(p_comment, ''));
  v_now timestamptz := clock_timestamp();
  v_imgs text[] := '{}'::text[];
  v_video text := NULL;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;
  IF p_rating IS NULL OR p_rating < 1 OR p_rating > 5 THEN RAISE EXCEPTION 'INVALID_RATING'; END IF;
  IF length(v_clean) < 5 OR length(v_clean) > 1000 THEN RAISE EXCEPTION 'INVALID_REVIEW_COMMENT'; END IF;

  SELECT r.* INTO v_rev FROM public.reviews r WHERE r.id = p_review_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'REVIEW_NOT_FOUND'; END IF;
  IF v_rev.buyer_id <> v_uid THEN RAISE EXCEPTION 'FORBIDDEN_BUYER_ONLY' USING ERRCODE = '42501'; END IF;
  IF v_rev.hidden THEN RAISE EXCEPTION 'REVIEW_MODERATED'; END IF;

  IF v_rev.order_id IS NOT NULL THEN
    SELECT o.status INTO v_order_status
    FROM public.orders o WHERE o.id = v_rev.order_id FOR SHARE;
    IF v_order_status IS DISTINCT FROM 'completed'
       OR NOT public.is_order_payment_verified(v_rev.order_id)
       OR EXISTS (
         SELECT 1 FROM public.order_refunds r
         WHERE r.order_id = v_rev.order_id AND r.refund_type = 'full_refund' AND r.status = 'succeeded'
       ) OR EXISTS (
         SELECT 1 FROM public.order_disputes d
         WHERE d.order_id = v_rev.order_id AND d.status IN ('open', 'under_review')
       ) THEN
      RAISE EXCEPTION 'ORDER_NOT_ELIGIBLE_FOR_REVIEW';
    END IF;
  ELSE
    PERFORM 1 FROM public.service_requests sr
    WHERE sr.id = v_rev.service_request_id AND sr.status = 'completed' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'SERVICE_NOT_ELIGIBLE_FOR_REVIEW'; END IF;
  END IF;

  -- NULL means keep the existing media. An empty array or empty video path clears it.
  v_imgs := v_rev.image_paths;
  v_video := v_rev.video_path;
  IF p_image_paths IS NOT NULL OR p_video_path IS NOT NULL THEN
    SELECT vm.out_images, vm.out_video
      INTO v_imgs, v_video
    FROM public.internal_validate_review_media(
      v_uid, v_rev.id, COALESCE(p_image_paths, v_rev.image_paths),
      COALESCE(p_video_path, v_rev.video_path)
    ) vm;
  END IF;

  UPDATE public.reviews
  SET rating       = p_rating,
      comment      = v_clean,
      is_anonymous = COALESCE(p_is_anonymous, v_rev.is_anonymous),
      image_paths  = COALESCE(v_imgs, '{}'::text[]),
      video_path   = v_video,
      edited_at    = v_now,
      updated_at   = v_now
  WHERE id = v_rev.id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.edit_verified_review_atomic(uuid, integer, text, boolean, text[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.edit_verified_review_atomic(uuid, integer, text, boolean, text[], text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 6. Owner-only review lookup and public-safe column grants
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_my_reviews_for_orders(uuid[]);
CREATE OR REPLACE FUNCTION public.get_my_reviews_for_orders(p_order_ids uuid[])
RETURNS TABLE (
  id uuid,
  order_id uuid,
  listing_id uuid,
  rating integer,
  comment text,
  seller_response text,
  hidden boolean,
  is_anonymous boolean,
  image_paths text[],
  video_path text,
  edited_at timestamptz,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR p_order_ids IS NULL OR COALESCE(cardinality(p_order_ids), 0) = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    r.id, r.order_id, r.listing_id, r.rating, r.comment, r.seller_response,
    r.hidden, r.is_anonymous, r.image_paths, r.video_path, r.edited_at, r.created_at
  FROM public.reviews r
  WHERE r.buyer_id = v_uid
    AND r.order_id = ANY(p_order_ids)
  ORDER BY r.created_at DESC, r.id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_reviews_for_orders(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_reviews_for_orders(uuid[]) TO authenticated;

REVOKE ALL ON TABLE public.reviews FROM PUBLIC, anon, authenticated;
REVOKE SELECT (buyer_id, order_id, service_request_id, image_paths, video_path)
  ON TABLE public.reviews FROM PUBLIC, anon, authenticated;
GRANT SELECT (
  id, listing_id, seller_id, rating, comment, is_anonymous,
  seller_response, seller_responded_at, hidden, edited_at, created_at, updated_at
) ON TABLE public.reviews TO authenticated;
GRANT ALL ON TABLE public.reviews TO service_role;

-- END EMBEDDED MIGRATION BODY

DO $phase10r_checks$
DECLARE
  f jsonb := current_setting('buyu.verify_10r')::jsonb;
  buyer uuid := (f->>'buyer')::uuid;
  outsider uuid := (f->>'other')::uuid;
  seller uuid := (f->>'seller')::uuid;
  purchase uuid := (f->>'order')::uuid;
  listing uuid := (f->>'listing')::uuid;
  incomplete uuid := (f->>'incomplete')::uuid;
  unverified uuid := (f->>'unverified')::uuid;
  suffix text := f->>'suffix';
  photo text := buyer::text || '/validated/' || suffix || '.jpg';
  clip text := buyer::text || '/validated/' || suffix || '.mp4';
  staged text := buyer::text || '/staged/' || suffix || '.jpg';
  forged text := buyer::text || '/validated/forged-' || suffix || '.jpg';
  hijack text := outsider::text || '/validated/' || suffix || '.jpg';
  created timestamptz := now() - interval '45 days';
  review_id uuid;
  dispute_id_fixture uuid;
  actor uuid;
  target uuid;
  field text;
  state record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'review-media' AND NOT public AND file_size_limit = 20971520) THEN
    RAISE EXCEPTION 'Unexpected review bucket configuration';
  END IF;
  IF (SELECT image_path FROM public.order_items WHERE order_id = purchase) IS DISTINCT FROM (f->>'cover')
     OR NOT EXISTS (SELECT 1 FROM public.order_items WHERE order_id = unverified AND image_path IS NULL) THEN
    RAISE EXCEPTION 'Historical image snapshot changed';
  END IF;
  IF NOT public.is_order_payment_verified(purchase) OR NOT public.is_order_payment_verified(incomplete)
     OR public.is_order_payment_verified(unverified) THEN
    RAISE EXCEPTION 'Payment proof fixture is invalid';
  END IF;

  -- SQL checks storage privileges and reference validation. Media bytes are tested separately.
  INSERT INTO storage.objects (bucket_id,name,owner,owner_id,metadata) VALUES
    ('review-media',photo,buyer,buyer::text,'{"mimetype":"image/jpeg","size":102400}'),
    ('review-media',clip,buyer,buyer::text,'{"mimetype":"video/mp4","size":1048576}'),
    ('review-media',hijack,outsider,outsider::text,'{"mimetype":"image/jpeg","size":51200}');

  PERFORM set_config('request.jwt.claims',json_build_object('sub',buyer,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',buyer::text,true);
  SET LOCAL ROLE authenticated;
  INSERT INTO storage.objects (bucket_id,name,owner,owner_id,metadata)
  VALUES ('review-media',staged,buyer,buyer::text,'{"mimetype":"image/jpeg","size":102400}');
  BEGIN
    INSERT INTO storage.objects (bucket_id,name,owner,owner_id,metadata)
    VALUES ('review-media',forged,buyer,buyer::text,'{"mimetype":"image/jpeg","size":102400}');
    RAISE EXCEPTION 'Member created a validated object';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  FOREACH target IN ARRAY ARRAY[incomplete,unverified] LOOP
    BEGIN
      PERFORM public.submit_verified_review_atomic(target,listing,NULL,5,'Fixture review comment');
      RAISE EXCEPTION 'Ineligible order accepted';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM <> 'ORDER_NOT_ELIGIBLE_FOR_REVIEW' THEN RAISE; END IF;
    END;
  END LOOP;
  BEGIN
    PERFORM public.submit_verified_review_atomic(purchase,listing,NULL,6,'Fixture review comment');
    RAISE EXCEPTION 'Invalid rating accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'INVALID_RATING' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.submit_verified_review_atomic(purchase,listing,NULL,5,'Fixture review comment',true,
      ARRAY(SELECT buyer::text || '/validated/' || n || '.jpg' FROM generate_series(1,6) AS nums(n)),NULL);
    RAISE EXCEPTION 'Excess images accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'TOO_MANY_REVIEW_IMAGES' THEN RAISE; END IF;
  END;

  FOREACH field IN ARRAY ARRAY[staged,hijack] LOOP
    BEGIN
      PERFORM public.submit_verified_review_atomic(purchase,listing,NULL,5,'Fixture review comment',true,ARRAY[field],NULL);
      RAISE EXCEPTION 'Staged or other buyer media accepted';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM <> 'INVALID_REVIEW_MEDIA_PATH' THEN RAISE; END IF;
    END;
  END LOOP;

  SELECT out_id INTO STRICT review_id FROM public.submit_verified_review_atomic(
    purchase,listing,NULL,5,'Fixture verified review',true,ARRAY[photo],clip
  );
  BEGIN
    PERFORM public.submit_verified_review_atomic(purchase,listing,NULL,4,'Fixture duplicate review');
    RAISE EXCEPTION 'Duplicate review accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  IF NOT EXISTS (SELECT 1 FROM public.get_my_reviews_for_orders(ARRAY[purchase]) WHERE id = review_id AND image_paths = ARRAY[photo]) THEN
    RAISE EXCEPTION 'Buyer cannot retrieve own attachments';
  END IF;

  FOREACH actor IN ARRAY ARRAY[outsider,seller] LOOP
    PERFORM set_config('request.jwt.claims',json_build_object('sub',actor,'role','authenticated')::text,true);
    PERFORM set_config('request.jwt.claim.sub',actor::text,true);
    FOREACH field IN ARRAY ARRAY['buyer_id','order_id','service_request_id','image_paths','video_path'] LOOP
      BEGIN
        EXECUTE format('SELECT %I FROM public.reviews WHERE id = $1',field) USING review_id;
        RAISE EXCEPTION 'Private review field % available to %',field,actor;
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM public.reviews WHERE id = review_id AND is_anonymous)
       OR EXISTS (SELECT 1 FROM public.get_my_reviews_for_orders(ARRAY[purchase]))
       OR EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'review-media' AND name IN (photo,clip)) THEN
      RAISE EXCEPTION 'Public review unavailable or owner data exposed';
    END IF;
    BEGIN
      PERFORM public.edit_verified_review_atomic(review_id,1,'Fixture unauthorized edit');
      RAISE EXCEPTION 'Non-owner edit accepted';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;

  RESET ROLE;
  UPDATE public.reviews SET created_at = created WHERE id = review_id;
  PERFORM set_config('request.jwt.claims',json_build_object('sub',buyer,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',buyer::text,true);
  SET LOCAL ROLE authenticated;
  PERFORM public.edit_verified_review_atomic(review_id,4,'Fixture update after 45 days');
  RESET ROLE;
  SELECT * INTO STRICT state FROM public.reviews WHERE id = review_id;
  IF state.created_at IS DISTINCT FROM created OR state.rating IS DISTINCT FROM 4
     OR state.image_paths IS DISTINCT FROM ARRAY[photo] OR state.video_path IS DISTINCT FROM clip
     OR state.is_anonymous IS DISTINCT FROM true OR state.edited_at IS NULL
     OR (SELECT count(*) FROM public.reviews WHERE order_id = purchase AND listing_id = listing) <> 1 THEN
    RAISE EXCEPTION 'Edit failed to preserve review ID, creation time or attachments';
  END IF;

  SET LOCAL ROLE authenticated;
  PERFORM public.edit_verified_review_atomic(review_id,4,'Fixture explicit media removal',NULL,'{}','');
  RESET ROLE;
  IF NOT EXISTS (SELECT 1 FROM public.reviews WHERE id = review_id AND image_paths = '{}'::text[] AND video_path IS NULL) THEN
    RAISE EXCEPTION 'Explicit removal failed';
  END IF;

  INSERT INTO public.order_disputes (order_id,opened_by,reason,dispute_code,status,previous_order_status)
  VALUES (purchase,buyer,'Synthetic review eligibility dispute.','D10R-' || suffix,'open','completed')
  RETURNING id INTO dispute_id_fixture;
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.edit_verified_review_atomic(review_id,5,'Fixture edit during open dispute');
    RAISE EXCEPTION 'Disputed order review edit accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'ORDER_NOT_ELIGIBLE_FOR_REVIEW' THEN RAISE; END IF;
  END;
  RESET ROLE;
  UPDATE public.order_disputes SET status = 'resolved' WHERE id = dispute_id_fixture;
  INSERT INTO public.order_refunds (refund_code,dispute_id,order_id,refund_type,refund_amount_sen,
    commission_reversal_sen,seller_deduction_sen,idempotency_key,status)
  VALUES ('R10R-' || suffix,dispute_id_fixture,purchase,'full_refund',5000,100,4900,'phase10r-' || suffix,'succeeded');
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.edit_verified_review_atomic(review_id,5,'Fixture refunded order edit');
    RAISE EXCEPTION 'Fully refunded order review edit accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'ORDER_NOT_ELIGIBLE_FOR_REVIEW' THEN RAISE; END IF;
  END;
  RESET ROLE;

  UPDATE public.reviews SET hidden = true WHERE id = review_id;
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.edit_verified_review_atomic(review_id,5,'Fixture moderated review edit');
    RAISE EXCEPTION 'Moderated review edit accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'REVIEW_MODERATED' THEN RAISE; END IF;
  END;
  RESET ROLE;
  RAISE NOTICE 'PHASE_10R_VERIFY_PASSED';
END;
$phase10r_checks$;

ROLLBACK;
