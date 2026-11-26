-- Phase 10G hosted-owner verification. All writes roll back in this transaction.
BEGIN;
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;

-- BEGIN EXACT STANDALONE MIGRATION BODY
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
-- END EXACT STANDALONE MIGRATION BODY

DO $verify$
DECLARE
  tag text := 'verify10g-' || replace(gen_random_uuid()::text, '-', '');
  donor uuid := gen_random_uuid();
  other_student uuid := gen_random_uuid();
  staff uuid := gen_random_uuid();
  admin uuid := gen_random_uuid();
  missing_profile uuid := gen_random_uuid();
  post_id uuid := gen_random_uuid();
  legacy_id uuid := gen_random_uuid();
  legacy_claim uuid := gen_random_uuid();
  foreign_photo text := other_student::text || '/' || tag || '.jpg';
  owned_photo text := donor::text || '/' || tag || '.jpg';
  title text := 'Synthetic Free Textbooks';
  pickup text := 'Block Alpha, outside the common room';
  originals public.free_notices;
  changed public.free_notices;
  before_orders bigint;
  before_payments bigint;
BEGIN
  SELECT count(*) INTO before_orders FROM public.orders;
  SELECT count(*) INTO before_payments FROM public.payments;
  IF (SELECT b.public FROM storage.buckets b WHERE id = 'free-items') IS DISTINCT FROM false
     OR NOT (SELECT b.public FROM storage.buckets b WHERE id = 'listings')
     OR has_table_privilege('anon', 'public.free_notices', 'SELECT')
     OR has_function_privilege('anon','public.write_free_noticeboard_post(uuid,text,text,text,text,text[],boolean)','EXECUTE')
     OR has_function_privilege('authenticated','public.create_free_notice_claim_atomic(uuid,integer,text)','EXECUTE')
     OR has_function_privilege('authenticated','public.update_free_notice_claim_atomic(uuid,text,text)','EXECUTE')
     OR has_function_privilege('service_role','public.expire_stale_free_claims_atomic(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'Unexpected notice, storage, or retired RPC privileges';
  END IF;

  INSERT INTO auth.users (id,email,email_confirmed_at,raw_user_meta_data,raw_app_meta_data)
  VALUES
    (donor,tag||'-donor@iluv.ums.edu.my',now(),'{"full_name":"Fixture Donor"}','{}'),
    (other_student,tag||'-other@iluv.ums.edu.my',now(),'{"full_name":"Fixture Other"}','{}'),
    (staff,tag||'-staff@ums.edu.my',now(),'{"full_name":"Fixture Staff"}','{}'),
    (admin,tag||'-admin@ums.edu.my',now(),'{"full_name":"Fixture Admin"}','{"is_admin":true}'),
    (missing_profile,tag||'-missing@iluv.ums.edu.my',now(),'{"full_name":"Fixture Incomplete"}','{}');
  UPDATE public.profiles SET status = 'active' WHERE id IN (donor,other_student,staff,admin,missing_profile);
  UPDATE public.profiles SET matric_number = 'VERIFY001' WHERE id = donor;
  UPDATE public.profiles SET matric_number = 'VERIFY002' WHERE id = other_student;
  INSERT INTO storage.objects (bucket_id,name,owner,owner_id,metadata) VALUES
    ('free-items',owned_photo,donor,donor::text,'{"size":4096,"mimetype":"image/jpeg"}'),
    ('free-items',foreign_photo,other_student,other_student::text,'{"size":4096,"mimetype":"image/jpeg"}');

  -- Legacy records remain readable by authorized parties, with their original references.
  INSERT INTO public.donation_spots (id,name) VALUES (tag,'Synthetic legacy spot');
  INSERT INTO public.free_notices (id,contributor_id,title,description,condition,spot_id,collection_instructions,image_paths)
  VALUES (legacy_id,donor,'Historical synthetic post','Archive fixture only','Good',tag,'Ask for old instructions',ARRAY[owned_photo]);
  INSERT INTO public.free_notice_claims (id,claim_code,notice_id,donor_id,recipient_id,status)
  VALUES (legacy_claim,tag,legacy_id,donor,staff,'collected');

  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  PERFORM set_config('request.jwt.claim.sub',staff::text,true);
  PERFORM set_config('request.jwt.claims',json_build_object('sub',staff,'role','authenticated')::text,true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.write_free_noticeboard_post(post_id,'publish',title,'',pickup,ARRAY[owned_photo]);
    RAISE EXCEPTION 'Staff published a post';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = donor AND matric_number IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.free_notices WHERE id = legacy_id)
     OR EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id='free-items' AND name=owned_photo) THEN
    RAISE EXCEPTION 'Matric or unconfirmed legacy location/photo was exposed';
  END IF;
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub',missing_profile::text,true);
  PERFORM set_config('request.jwt.claims',json_build_object('sub',missing_profile,'role','authenticated')::text,true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.write_free_noticeboard_post(post_id,'publish',title,'',pickup,ARRAY[owned_photo]);
    RAISE EXCEPTION 'Incomplete student profile published';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'FREE_NOTICEBOARD_PROFILE_REQUIRED' THEN RAISE; END IF;
  END;
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub',donor::text,true);
  PERFORM set_config('request.jwt.claims',json_build_object('sub',donor,'role','authenticated')::text,true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.write_free_noticeboard_post(post_id,'publish',title,'',pickup,ARRAY[foreign_photo]);
    RAISE EXCEPTION 'Another user photo could be published';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'FREE_NOTICEBOARD_INVALID_PHOTOS' THEN RAISE; END IF;
  END;
  PERFORM public.write_free_noticeboard_post(post_id,'publish',title,'',pickup,ARRAY[owned_photo]);
  PERFORM public.write_free_noticeboard_post(post_id,'publish',title,'',pickup,ARRAY[owned_photo]);
  RESET ROLE;

  SELECT * INTO STRICT originals FROM public.free_notices WHERE id = post_id;
  IF originals.contributor_id <> donor OR originals.pickup_location IS DISTINCT FROM pickup
     OR originals.description IS DISTINCT FROM '' OR originals.condition IS NOT NULL OR originals.spot_id IS NOT NULL
     OR originals.status <> 'active' OR originals.expires_at - originals.published_at <> interval '72 hours'
     OR (SELECT count(*) FROM public.free_notices WHERE id = post_id) <> 1 THEN
    RAISE EXCEPTION 'Unexpected publication result';
  END IF;

  PERFORM set_config('request.jwt.claim.sub',staff::text,true);
  PERFORM set_config('request.jwt.claims',json_build_object('sub',staff,'role','authenticated')::text,true);
  SET LOCAL ROLE authenticated;
  IF NOT EXISTS (SELECT 1 FROM public.free_notices WHERE id=post_id AND pickup_location=pickup)
     OR NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id='free-items' AND name=owned_photo) THEN
    RAISE EXCEPTION 'Eligible staff could not discover the post and its photo';
  END IF;
  PERFORM public.submit_report_atomic('free_notice',post_id,'Prohibited item','Synthetic active notice reporting check');
  BEGIN
    PERFORM public.create_free_notice_claim_atomic(post_id,1,'Synthetic obsolete claim');
    RAISE EXCEPTION 'Old claim endpoint accepted a noticeboard claim';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub',other_student::text,true);
  PERFORM set_config('request.jwt.claims',json_build_object('sub',other_student,'role','authenticated')::text,true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.write_free_noticeboard_post(post_id,'edit',title,'',pickup,ARRAY[owned_photo]);
    RAISE EXCEPTION 'Another student edited the post';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.write_free_noticeboard_post(post_id,'remove');
    RAISE EXCEPTION 'Another student removed the post';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.write_free_noticeboard_post(post_id,'renew',p_acknowledged=>true);
    RAISE EXCEPTION 'Another student renewed the post';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub',donor::text,true);
  PERFORM set_config('request.jwt.claims',json_build_object('sub',donor,'role','authenticated')::text,true);
  SET LOCAL ROLE authenticated;
  PERFORM public.write_free_noticeboard_post(post_id,'edit',title,'A short description',pickup,ARRAY[owned_photo]);
  BEGIN
    PERFORM public.write_free_noticeboard_post(post_id,'renew',p_acknowledged=>true);
    RAISE EXCEPTION 'An active post renewed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'FREE_NOTICEBOARD_NOT_RENEWABLE' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE public.free_notices SET expires_at = now() + interval '1 year' WHERE id=post_id;
    RAISE EXCEPTION 'Direct expiry change was permitted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;
  SELECT * INTO STRICT changed FROM public.free_notices WHERE id=post_id;
  IF changed.expires_at IS DISTINCT FROM originals.expires_at OR changed.description <> 'A short description' THEN
    RAISE EXCEPTION 'Editing changed expiry or failed to save fields';
  END IF;

  UPDATE public.free_notices SET expires_at = transaction_timestamp() - interval '1 second' WHERE id=post_id;
  PERFORM set_config('request.jwt.claim.sub',staff::text,true);
  PERFORM set_config('request.jwt.claims',json_build_object('sub',staff,'role','authenticated')::text,true);
  SET LOCAL ROLE authenticated;
  IF EXISTS (SELECT 1 FROM public.free_notices WHERE id=post_id)
     OR EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id='free-items' AND name=owned_photo) THEN
    RAISE EXCEPTION 'Expired notice or its photo remained visible to another member';
  END IF;
  BEGIN
    PERFORM public.submit_report_atomic('free_notice',post_id,'Prohibited item','Synthetic expiry visibility check');
    RAISE EXCEPTION 'Expired post could be probed through reporting';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'REPORT_TARGET_NOT_FOUND' THEN RAISE; END IF;
  END;
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub',donor::text,true);
  PERFORM set_config('request.jwt.claims',json_build_object('sub',donor,'role','authenticated')::text,true);
  SET LOCAL ROLE authenticated;
  IF NOT EXISTS (SELECT 1 FROM public.free_notices WHERE id=post_id) THEN
    RAISE EXCEPTION 'The donor lost access to their expired post';
  END IF;
  BEGIN
    PERFORM public.write_free_noticeboard_post(post_id,'renew');
    RAISE EXCEPTION 'Renewal proceeded without acknowledgement';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'FREE_NOTICEBOARD_CONFIRM_AVAILABILITY' THEN RAISE; END IF;
  END;
  PERFORM public.write_free_noticeboard_post(post_id,'renew',p_acknowledged=>true);
  BEGIN
    PERFORM public.write_free_noticeboard_post(post_id,'renew',p_acknowledged=>true);
    RAISE EXCEPTION 'Duplicate renewal extended the post';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'FREE_NOTICEBOARD_NOT_RENEWABLE' THEN RAISE; END IF;
  END;
  RESET ROLE;
  SELECT * INTO STRICT changed FROM public.free_notices WHERE id=post_id;
  IF changed.renewed_at IS NULL OR changed.expires_at - changed.renewed_at <> interval '72 hours'
     OR changed.created_at IS DISTINCT FROM originals.created_at
     OR changed.published_at IS DISTINCT FROM originals.published_at
     OR changed.image_paths IS DISTINCT FROM originals.image_paths THEN
    RAISE EXCEPTION 'Renewal changed original identity, timing or photos';
  END IF;

  PERFORM set_config('request.jwt.claim.sub',admin::text,true);
  PERFORM set_config('request.jwt.claims',json_build_object('sub',admin,'role','authenticated')::text,true);
  SET LOCAL ROLE authenticated;
  PERFORM public.admin_moderate_free_notice_atomic(post_id,true,'Synthetic moderation check');
  RESET ROLE;
  UPDATE public.free_notices SET expires_at = transaction_timestamp() - interval '1 second' WHERE id=post_id;
  PERFORM set_config('request.jwt.claim.sub',donor::text,true);
  PERFORM set_config('request.jwt.claims',json_build_object('sub',donor,'role','authenticated')::text,true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.write_free_noticeboard_post(post_id,'renew',p_acknowledged=>true);
    RAISE EXCEPTION 'Moderated post was renewed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub',admin::text,true);
  PERFORM set_config('request.jwt.claims',json_build_object('sub',admin,'role','authenticated')::text,true);
  SET LOCAL ROLE authenticated;
  PERFORM public.admin_moderate_free_notice_atomic(post_id,false,'Synthetic moderation restore');
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub',donor::text,true);
  PERFORM set_config('request.jwt.claims',json_build_object('sub',donor,'role','authenticated')::text,true);
  SET LOCAL ROLE authenticated;
  PERFORM public.write_free_noticeboard_post(post_id,'remove');
  BEGIN
    PERFORM public.write_free_noticeboard_post(post_id,'renew',p_acknowledged=>true);
    RAISE EXCEPTION 'Removed post was renewed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'FREE_NOTICEBOARD_REMOVED' THEN RAISE; END IF;
  END;
  RESET ROLE;

  IF NOT EXISTS (SELECT 1 FROM public.free_notices WHERE id=post_id AND status='closed')
     OR NOT EXISTS (SELECT 1 FROM public.free_notice_claims WHERE id=legacy_claim AND status='collected')
     OR NOT EXISTS (SELECT 1 FROM public.free_notices WHERE id=legacy_id AND spot_id=tag AND collection_instructions='Ask for old instructions')
     OR (SELECT count(*) FROM public.orders) <> before_orders
     OR (SELECT count(*) FROM public.payments) <> before_payments THEN
    RAISE EXCEPTION 'Removal, legacy data, or paid-commerce isolation changed unexpectedly';
  END IF;
  RAISE NOTICE 'Phase 10G verification passed. Rolling back all fixtures and migration changes.';
END;
$verify$;

ROLLBACK;
