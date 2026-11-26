BEGIN;

-- Preserve the legacy location and claim columns for audit. Only an explicit
-- pickup location qualifies a post for noticeboard discovery.
ALTER TABLE public.free_notices
  ADD COLUMN pickup_location text,
  ALTER COLUMN spot_id DROP NOT NULL,
  ALTER COLUMN condition DROP NOT NULL,
  ALTER COLUMN description SET DEFAULT '',
  DROP CONSTRAINT free_notices_description_check,
  ADD CONSTRAINT free_notices_description_check CHECK (char_length(btrim(description)) <= 2000),
  ADD CONSTRAINT free_notices_pickup_location_check
    CHECK (pickup_location IS NULL OR char_length(btrim(pickup_location)) BETWEEN 5 AND 500);

-- Authenticated, active members can discover live posts. Owners and moderators
-- retain access to hidden, expired and historical records for legitimate use.
DROP POLICY free_notices_manage_own_student ON public.free_notices;
DROP POLICY free_notices_select_visible ON public.free_notices;
CREATE POLICY free_notices_select_visible ON public.free_notices FOR SELECT TO authenticated
USING (
  public.is_active_admin()
  OR (public.is_active_member() AND (
    auth.uid() = contributor_id
    OR (status = 'active' AND expires_at > now() AND pickup_location IS NOT NULL)
  ))
);
REVOKE INSERT, UPDATE, DELETE ON public.free_notices FROM PUBLIC, anon, authenticated;
REVOKE SELECT ON public.free_notices FROM PUBLIC, anon;

-- Retirement preserves rows, FK references, moderation and historical SELECT.
REVOKE EXECUTE ON FUNCTION public.create_free_notice_claim_atomic(uuid, integer, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.update_free_notice_claim_atomic(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.expire_stale_free_claims_atomic(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.publish_free_notice_atomic(text, text, text, integer, text, text, text, text[], uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.manage_free_notice_atomic(uuid, text, text, text, text, integer, text) FROM PUBLIC, anon, authenticated, service_role;

-- Other listing photos retain their existing public access. Free-item photos
-- use the existing bucket with its 5 MB and allowed-image limits.
UPDATE storage.buckets SET public = false WHERE id = 'free-items';
DROP POLICY storage_public_read_listings ON storage.objects;
CREATE POLICY storage_public_read_listings ON storage.objects FOR SELECT
USING (bucket_id = 'listings');

CREATE POLICY free_noticeboard_photos_select ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'free-items' AND (
    public.is_active_admin()
    OR (public.is_active_student() AND (storage.foldername(name))[1] = auth.uid()::text)
    OR EXISTS (
      SELECT 1 FROM public.free_notices fn
      WHERE fn.status = 'active' AND fn.expires_at > now() AND fn.pickup_location IS NOT NULL
        AND fn.image_paths @> ARRAY[objects.name]
    )
  )
);

CREATE POLICY free_noticeboard_protect_referenced_photos ON storage.objects AS RESTRICTIVE FOR DELETE TO authenticated
USING (
  bucket_id <> 'free-items'
  OR NOT EXISTS (SELECT 1 FROM public.free_notices fn WHERE fn.image_paths @> ARRAY[objects.name])
);

CREATE OR REPLACE FUNCTION public.write_free_noticeboard_post(
  p_id uuid, p_action text, p_title text DEFAULT NULL, p_description text DEFAULT NULL,
  p_pickup_location text DEFAULT NULL, p_image_paths text[] DEFAULT NULL, p_acknowledged boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_post public.free_notices;
  v_now timestamptz;
  v_title text := btrim(coalesce(p_title, ''));
  v_description text := btrim(coalesce(p_description, ''));
  v_pickup text := btrim(coalesce(p_pickup_location, ''));
  v_path text;
BEGIN
  IF v_user IS NULL OR NOT public.is_active_student() OR NOT EXISTS (
    SELECT 1 FROM auth.users u WHERE u.id = v_user AND u.email_confirmed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'FREE_NOTICEBOARD_STUDENT_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF p_id IS NULL OR p_action IS NULL OR p_action NOT IN ('publish', 'edit', 'remove', 'renew') THEN
    RAISE EXCEPTION 'FREE_NOTICEBOARD_INVALID_ACTION';
  END IF;

  SELECT fn.* INTO v_post FROM public.free_notices fn WHERE fn.id = p_id FOR UPDATE;
  IF FOUND THEN
    IF v_post.contributor_id <> v_user THEN
      RAISE EXCEPTION 'FREE_NOTICEBOARD_OWNER_REQUIRED' USING ERRCODE = '42501';
    END IF;
    IF p_action = 'publish' THEN
      RETURN p_id;
    END IF;
    IF v_post.status = 'hidden' THEN
      RAISE EXCEPTION 'FREE_NOTICEBOARD_MODERATED' USING ERRCODE = '42501';
    END IF;
  ELSIF p_action <> 'publish' THEN
    RAISE EXCEPTION 'FREE_NOTICEBOARD_OWNER_REQUIRED' USING ERRCODE = '42501';
  END IF;

  v_now := clock_timestamp();
  IF p_action = 'remove' THEN
    UPDATE public.free_notices SET status = 'closed', updated_at = v_now WHERE id = p_id AND status <> 'closed';
    RETURN p_id;
  END IF;
  IF v_post.status = 'closed' THEN
    RAISE EXCEPTION 'FREE_NOTICEBOARD_REMOVED';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = v_user
      AND coalesce(nullif(btrim(p.display_name), ''), nullif(btrim(p.full_name), '')) IS NOT NULL
      AND nullif(btrim(p.matric_number), '') IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'FREE_NOTICEBOARD_PROFILE_REQUIRED';
  END IF;

  IF p_action = 'renew' THEN
    IF p_acknowledged IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'FREE_NOTICEBOARD_CONFIRM_AVAILABILITY';
    END IF;
    IF v_post.status <> 'active' OR v_post.expires_at > v_now OR v_post.pickup_location IS NULL THEN
      RAISE EXCEPTION 'FREE_NOTICEBOARD_NOT_RENEWABLE';
    END IF;
    UPDATE public.free_notices SET renewed_at = v_now, expires_at = v_now + interval '72 hours',
      updated_at = v_now WHERE id = p_id;
    RETURN p_id;
  END IF;

  IF char_length(v_title) NOT BETWEEN 5 AND 100 OR char_length(v_description) > 2000
     OR char_length(v_pickup) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'FREE_NOTICEBOARD_INVALID_DETAILS';
  END IF;
  IF coalesce(cardinality(p_image_paths), 0) NOT BETWEEN 1 AND 5
     OR (SELECT count(DISTINCT path) FROM unnest(p_image_paths) AS entries(path)) <> cardinality(p_image_paths) THEN
    RAISE EXCEPTION 'FREE_NOTICEBOARD_INVALID_PHOTOS';
  END IF;

  FOREACH v_path IN ARRAY p_image_paths LOOP
    IF v_path IS NULL OR position('..' IN v_path) > 0
       OR v_path !~ ('^' || v_user::text || '/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$')
       OR NOT EXISTS (
         SELECT 1 FROM storage.objects so WHERE so.bucket_id = 'free-items' AND so.name = v_path
           AND (so.owner_id = v_user::text OR (so.owner_id IS NULL AND so.owner = v_user))
       ) THEN
      RAISE EXCEPTION 'FREE_NOTICEBOARD_INVALID_PHOTOS';
    END IF;
  END LOOP;

  IF p_action = 'edit' THEN
    UPDATE public.free_notices SET title = v_title, description = v_description,
      pickup_location = v_pickup, image_paths = p_image_paths, updated_at = clock_timestamp()
    WHERE id = p_id;
    RETURN p_id;
  END IF;

  v_now := clock_timestamp();
  INSERT INTO public.free_notices (id, contributor_id, title, description, pickup_location, image_paths,
    published_at, expires_at, created_at, updated_at)
  VALUES (p_id, v_user, v_title, v_description, v_pickup, p_image_paths,
    v_now, v_now + interval '72 hours', v_now, v_now)
  ON CONFLICT (id) DO NOTHING;

  IF NOT FOUND AND NOT EXISTS (
    SELECT 1 FROM public.free_notices fn WHERE fn.id = p_id AND fn.contributor_id = v_user
  ) THEN
    RAISE EXCEPTION 'FREE_NOTICEBOARD_OWNER_REQUIRED' USING ERRCODE = '42501';
  END IF;
  RETURN p_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.write_free_noticeboard_post(uuid, text, text, text, text, text[], boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.write_free_noticeboard_post(uuid, text, text, text, text, text[], boolean) TO authenticated;

-- Keep existing reporting behavior for other targets and historical claim
-- participants while preventing reports from probing undiscoverable posts.
DO $free_report_patch$
DECLARE
  v_definition text := replace(
    pg_get_functiondef('public.submit_report_atomic(text,uuid,text,text)'::regprocedure),
    chr(13) || chr(10), chr(10)
  );
  v_old constant text := replace($old$          fn.status = 'active'
          OR EXISTS (
            SELECT 1 FROM public.free_notice_claims fc$old$, chr(13) || chr(10), chr(10));
  v_new constant text := replace($new$          (fn.status = 'active' AND fn.expires_at > v_now AND fn.pickup_location IS NOT NULL)
          OR EXISTS (
            SELECT 1 FROM public.free_notice_claims fc$new$, chr(13) || chr(10), chr(10));
  v_match integer := position(v_old IN v_definition);
BEGIN
  IF v_match = 0 OR position(v_old IN substring(v_definition FROM v_match + 1)) > 0 THEN
    RAISE EXCEPTION 'FREE_NOTICEBOARD_REPORT_DEFINITION_CHANGED';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END;
$free_report_patch$;

NOTIFY pgrst, 'reload schema';

COMMIT;
