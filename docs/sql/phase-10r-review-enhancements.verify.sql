-- =============================================================================
-- Buy-U v2 — Phase 10R Rollback Verification Script
-- Target Supabase Project: duwwlcpdidrxkixvflag
-- =============================================================================
-- Run as DB owner in Supabase SQL Editor. Wraps synthetic verification inside
-- an explicit transaction ending in ROLLBACK so ZERO hosted data persists.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_suffix          text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  v_buyer_id        uuid := gen_random_uuid();
  v_other_id        uuid := gen_random_uuid();
  v_seller_id       uuid := gen_random_uuid();
  v_area_id         uuid;
  v_cat_id          text;
  v_listing_id      uuid := gen_random_uuid();
  v_var_id          uuid := gen_random_uuid();
  v_order_id        uuid := gen_random_uuid();
  v_offer_id        uuid := gen_random_uuid();
  v_review_id       uuid;
  v_created_at      timestamptz;
  v_img_1           text := v_buyer_id::text || '/validated/' || v_suffix || '-1.jpg';
  v_img_2           text := v_buyer_id::text || '/validated/' || v_suffix || '-2.png';
  v_vid_1           text := v_buyer_id::text || '/validated/' || v_suffix || '-clip.mp4';
  v_hijack_img      text := v_other_id::text || '/validated/' || v_suffix || '-other.jpg';
  v_cover_img       text := v_seller_id::text || '/cover-' || v_suffix || '.jpg';
  v_var_img         text := v_seller_id::text || '/var-' || v_suffix || '.jpg';
  v_rev_row         record;
  v_err_state       text;
  v_backfill_img    text;
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
  ON CONFLICT (id) DO NOTHING;

  -- Verify storage bucket exists and is strictly private
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'review-media' AND public = false AND file_size_limit = 20971520) THEN
    RAISE EXCEPTION 'T1_FAILED: review-media bucket missing or misconfigured';
  END IF;

  -- Create listing + variant + legacy completed verified order (testing cover->variant backfill)
  INSERT INTO public.listings (id, seller_id, title, description, kind, category_id, collection_area_id, condition, price_sen, quantity, reserved_quantity, has_variants, option_groups, variation_photo_group, image_paths, rules_acknowledged, status, published_at)
  VALUES (v_listing_id, v_seller_id, 'Perfume Set ' || v_suffix, 'Long lasting campus fragrance listing description text.', 'business', v_cat_id, v_area_id, 'New / Unused', 2500, 10, 0, true, ARRAY['Fragrance'], 'Fragrance', ARRAY[v_cover_img, v_var_img], true, 'published', now());

  INSERT INTO public.listing_variants (id, listing_id, option_values, price_sen, quantity, reserved_quantity, active, image_path)
  VALUES (v_var_id, v_listing_id, '{"Fragrance":"Hawas Fire"}'::jsonb, 2500, 5, 0, true, v_var_img);

  INSERT INTO public.orders (id, order_code, buyer_id, seller_id, source, subtotal_sen, fpx_fee_sen, total_paid_sen, commission_sen, seller_net_sen, status, collection_area_name, paid_at, completed_at)
  VALUES (v_order_id, 'BU-10R-' || upper(substr(v_suffix, 1, 5)), v_buyer_id, v_seller_id, 'cart', 5000, 100, 5100, 100, 4900, 'completed', 'Cafe UMSKAL', now() - interval '30 days', now() - interval '29 days');

  INSERT INTO public.payments (order_id, bill_code, status, transaction_ref, verified_at)
  VALUES (v_order_id, 'BILL-10R-' || v_suffix, 'paid', 'TXN-10R-' || v_suffix, now() - interval '30 days');

  INSERT INTO public.order_items (order_id, listing_id, variant_id, title_snapshot, variant_snapshot, unit_sen, quantity, image_path, is_service)
  VALUES (v_order_id, v_listing_id, v_var_id, 'Perfume Set ' || v_suffix, '{"Fragrance":"Hawas Fire"}'::jsonb, 2500, 2, v_cover_img, false);

  -- Simulate Phase 10R backfill check on legacy item whose image_path was still cover
  WITH resolved AS (
    SELECT oi.id AS oi_id, lv.image_path AS var_img
    FROM public.order_items oi
    JOIN public.listings l ON l.id = oi.listing_id
    JOIN public.listing_variants lv ON lv.id = oi.variant_id
    WHERE oi.order_id = v_order_id AND oi.image_path = l.image_paths[1]
  )
  UPDATE public.order_items oi SET image_path = r.var_img FROM resolved r WHERE oi.id = r.oi_id;

  SELECT image_path INTO v_backfill_img FROM public.order_items WHERE order_id = v_order_id;
  IF v_backfill_img IS DISTINCT FROM v_var_img THEN
    RAISE EXCEPTION 'T2_FAILED: Legacy variant image backfill failed (got %)', v_backfill_img;
  END IF;

  -- Seed validated review-media objects
  INSERT INTO storage.objects (bucket_id, name, owner, metadata)
  VALUES
    ('review-media', v_img_1, v_buyer_id, jsonb_build_object('mimetype', 'image/jpeg', 'size', 102400)),
    ('review-media', v_img_2, v_buyer_id, jsonb_build_object('mimetype', 'image/png', 'size', 204800)),
    ('review-media', v_vid_1, v_buyer_id, jsonb_build_object('mimetype', 'video/mp4', 'size', 1048576)),
    ('review-media', v_hijack_img, v_other_id, jsonb_build_object('mimetype', 'image/jpeg', 'size', 51200));

  -- Act as buyer to submit anonymous review with media
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_buyer_id::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);

  SELECT out_id, out_created_at INTO v_review_id, v_created_at
  FROM public.submit_verified_review_atomic(
    v_order_id, v_listing_id, NULL, 5, 'Great scent and fast handover!', true, ARRAY[v_img_1], v_vid_1
  );

  IF v_review_id IS NULL THEN
    RAISE EXCEPTION 'T3_FAILED: submit_verified_review_atomic returned NULL';
  END IF;

  -- Verify cross-user media hijack fails
  BEGIN
    PERFORM public.edit_verified_review_atomic(v_review_id, 4, 'Trying hijack image', false, ARRAY[v_hijack_img], NULL);
    RAISE EXCEPTION 'T4_FAILED: Hijacked review image path was not rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%INVALID_REVIEW_MEDIA_PATH%' THEN
      RAISE;
    END IF;
  END;

  -- Verify `buyer_id` column SELECT is blocked for authenticated postgrest callers
  BEGIN
    EXECUTE 'SELECT buyer_id FROM public.reviews LIMIT 1';
    RAISE EXCEPTION 'T5_FAILED: authenticated role still has SELECT privilege on reviews.buyer_id';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- Backdate review > 7 days ago (via privileged reset) and verify buyer edit succeeds!
  RESET role;
  UPDATE public.reviews SET created_at = now() - interval '45 days' WHERE id = v_review_id;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_buyer_id::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);

  PERFORM public.edit_verified_review_atomic(
    v_review_id, 4, 'Updated review after 45 days!', false, ARRAY[v_img_1, v_img_2], NULL
  );

  -- Non-owner cannot edit review
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other_id::text, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.edit_verified_review_atomic(v_review_id, 1, 'Malicious overwrite', true, '{}'::text[], NULL);
    RAISE EXCEPTION 'T6_FAILED: Non-owner review edit was not rejected';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err_state = RETURNED_SQLSTATE;
    IF v_err_state <> '42501' THEN RAISE; END IF;
  END;

  RESET role;
  SELECT * INTO v_rev_row FROM public.reviews WHERE id = v_review_id;
  IF v_rev_row.rating <> 4
     OR v_rev_row.is_anonymous <> false
     OR cardinality(v_rev_row.image_paths) <> 2
     OR v_rev_row.video_path IS NOT NULL
     OR v_rev_row.edited_at IS NULL
     OR v_rev_row.created_at > now() - interval '40 days' THEN
    RAISE EXCEPTION 'T7_FAILED: Edited review row state unexpected (%)', to_jsonb(v_rev_row);
  END IF;

  -- Moderated review cannot be edited by buyer
  UPDATE public.reviews SET hidden = true WHERE id = v_review_id;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_buyer_id::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  BEGIN
    PERFORM public.edit_verified_review_atomic(v_review_id, 5, 'Trying to unhide or edit moderated review', false, '{}'::text[], NULL);
    RAISE EXCEPTION 'T8_FAILED: Moderated review edit was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%REVIEW_MODERATED%' THEN RAISE; END IF;
  END;

  RESET role;
  RAISE NOTICE 'PHASE_10R_VERIFY_PASSED: review_id=% backfill_img=%', v_review_id, v_backfill_img;
END;
$$;

ROLLBACK;
