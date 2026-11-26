-- =============================================================================
-- Buy-U v2 — Phase 10R: Reviews, Ratings & Repurchase Enhancements
-- Target Supabase Project: duwwlcpdidrxkixvflag
-- =============================================================================
-- Safe, idempotent migration extending `public.reviews` + private `review-media`
-- storage bucket. Zero new application tables introduced.
-- Preserves Phase 10G, Phase 10O, Phase 10S, and Phase 10V contracts.
-- =============================================================================

BEGIN;

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
  v_obj_mime text;
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

    SELECT COALESCE((o.metadata->>'size')::bigint, 0), COALESCE(o.metadata->>'mimetype', '')
      INTO v_obj_size, v_obj_mime
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

    SELECT COALESCE((o.metadata->>'size')::bigint, 0), COALESCE(o.metadata->>'mimetype', '')
      INTO v_obj_size, v_obj_mime
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
  p_is_anonymous boolean DEFAULT false,
  p_image_paths text[] DEFAULT '{}'::text[],
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

  SELECT vm.out_images, vm.out_video
    INTO v_imgs, v_video
  FROM public.internal_validate_review_media(v_uid, v_rev.id, p_image_paths, p_video_path) vm;

  UPDATE public.reviews
  SET rating       = p_rating,
      comment      = v_clean,
      is_anonymous = COALESCE(p_is_anonymous, false),
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
-- 6. Owner-only review lookup helper & strict column-level `buyer_id` protection
--    Ensures authenticated members querying PostgREST directly cannot select
--    `buyer_id` on other buyers' anonymous reviews.
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
GRANT SELECT (
  id, order_id, listing_id, service_request_id, seller_id,
  rating, comment, is_anonymous, image_paths, video_path,
  seller_response, seller_responded_at, hidden, edited_at, created_at, updated_at
) ON TABLE public.reviews TO authenticated;
GRANT ALL ON TABLE public.reviews TO service_role;

-- -----------------------------------------------------------------------------
-- 7. Historical Purchased Variation Image Backfill (Pre-10V Legacy Orders ONLY)
--    Repairs `order_items.image_path` ONLY when an existing physical item snapshot
--    is missing or equals the generic listing cover while a distinct linked offer
--    or variation photo exists. Never mutates items that already store a custom
--    variation snapshot.
-- -----------------------------------------------------------------------------
WITH resolved_legacy AS (
  SELECT
    oi.id AS order_item_id,
    COALESCE(
      NULLIF(ofr.variant_image_path, ''),
      NULLIF(lv.image_path, '')
    ) AS resolved_variant_image
  FROM public.order_items oi
  JOIN public.orders ord ON ord.id = oi.order_id
  JOIN public.listings l ON l.id = oi.listing_id
  LEFT JOIN public.offers ofr ON ofr.order_id = ord.id
  LEFT JOIN public.listing_variants lv
    ON lv.id = oi.variant_id
    AND lv.listing_id = oi.listing_id
  WHERE COALESCE(oi.is_service, false) = false
    AND (oi.variant_id IS NOT NULL OR oi.variant_snapshot IS NOT NULL)
    AND (
      NULLIF(oi.image_path, '') IS NULL
      OR oi.image_path = l.image_paths[1]
    )
)
UPDATE public.order_items oi
SET image_path = rl.resolved_variant_image
FROM resolved_legacy rl
WHERE oi.id = rl.order_item_id
  AND rl.resolved_variant_image IS NOT NULL
  AND rl.resolved_variant_image IS DISTINCT FROM oi.image_path;

COMMIT;
