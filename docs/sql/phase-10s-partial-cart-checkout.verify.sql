-- =============================================================================
-- BUY-U PHASE 10S — PARTIAL CART CHECKOUT ROLLBACK-ONLY VERIFICATION
-- =============================================================================
-- Strictly wrapped in BEGIN ... ROLLBACK. Zero persistent mutations.
-- Preserves all existing user data. Never deletes directly from storage.objects.
-- Embedded Migration Body SHA-256: 7AFF70B98909CB3753E165780A1EECD3E7148D46D769864CBCDA571910676C7B
--
-- Scope note on attachments:
--   The storage.objects row inserted below is a metadata-only rollback fixture
--   to verify SQL path-scoping and order_items binding inside this transaction.
--   Actual Storage API upload, overwrite, and deletion RLS enforcement is tested
--   separately in Phase B3 via Supabase Storage API.
-- =============================================================================

BEGIN;

-- 1. Apply exact migration body inside rollback transaction
DROP FUNCTION IF EXISTS public.create_cart_checkout_atomic(text, jsonb);

CREATE OR REPLACE FUNCTION public.create_cart_checkout_atomic(
  p_idempotency_key text,
  p_service_details jsonb DEFAULT NULL,
  p_cart_item_ids   uuid[] DEFAULT NULL
)
RETURNS TABLE (
  id                    uuid,
  checkout_code         text,
  source                text,
  combined_subtotal_sen integer,
  fpx_fee_sen           integer,
  total_paid_sen        integer,
  status                text,
  payment_deadline      timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_key text := trim(COALESCE(p_idempotency_key, ''));
  v_existing public.checkout_sessions;
  v_session public.checkout_sessions;
  v_cart_item_ids uuid[];
  v_group RECORD;
  v_seller_status text;
  v_ci RECORD;
  v_listing public.listings;
  v_variant public.listing_variants;
  v_unit_sen integer;
  v_combined_subtotal integer := 0;
  v_subtotal integer;
  v_fpx integer := 100;
  v_commission integer;
  v_seller_net integer;
  v_checkout_code text;
  v_order_code text;
  v_child_idempotency_key text;
  v_area_name text;
  v_is_food_order boolean;
  v_order public.orders;
  v_svc_entry jsonb;
  v_svc_req text;
  v_svc_paths text[];
  v_raw_path text;
  v_obj_size bigint;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  IF length(v_key) < 8 OR length(v_key) > 128 OR position(':' in v_key) > 0 THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY';
  END IF;

  IF p_service_details IS NOT NULL AND jsonb_typeof(p_service_details) <> 'object' THEN
    RAISE EXCEPTION 'INVALID_SERVICE_DETAILS';
  END IF;

  IF p_cart_item_ids IS NOT NULL THEN
    IF cardinality(p_cart_item_ids) = 0 THEN
      RAISE EXCEPTION 'INVALID_CART_SELECTION';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(p_cart_item_ids) AS x WHERE x IS NULL) THEN
      RAISE EXCEPTION 'INVALID_CART_SELECTION';
    END IF;
    IF (SELECT count(DISTINCT x) FROM unnest(p_cart_item_ids) AS x) <> cardinality(p_cart_item_ids) THEN
      RAISE EXCEPTION 'DUPLICATE_CART_SELECTION';
    END IF;
  END IF;

  -- Serialize concurrent cart checkout submissions for the same buyer before table locks
  PERFORM pg_advisory_xact_lock(hashtextextended('buyu_cart_checkout:' || v_uid::text, 0));

  -- Fast idempotent return (never overwrites existing briefs or duplicates orders)
  SELECT * INTO v_existing
  FROM public.checkout_sessions cs
  WHERE cs.buyer_id = v_uid
    AND cs.source = 'cart'
    AND cs.idempotency_key = v_key;
  IF FOUND THEN
    RETURN QUERY SELECT
      v_existing.id, v_existing.checkout_code, v_existing.source,
      v_existing.combined_subtotal_sen, v_existing.fpx_fee_sen,
      v_existing.total_paid_sen, v_existing.status, v_existing.payment_deadline;
    RETURN;
  END IF;

  -- Lock & snapshot exact selected buyer cart item IDs (unticked & concurrent additions preserved untouched)
  SELECT array_agg(locked.id ORDER BY locked.listing_id, locked.variant_id NULLS FIRST, locked.id)
  INTO v_cart_item_ids
  FROM (
    SELECT ci.id, ci.listing_id, ci.variant_id
    FROM public.cart_items ci
    WHERE ci.user_id = v_uid
      AND (p_cart_item_ids IS NULL OR ci.id = ANY(p_cart_item_ids))
    ORDER BY ci.listing_id, ci.variant_id NULLS FIRST, ci.id
    FOR UPDATE
  ) AS locked;

  -- Recheck idempotency after acquiring checkout locks
  SELECT * INTO v_existing
  FROM public.checkout_sessions cs
  WHERE cs.buyer_id = v_uid
    AND cs.source = 'cart'
    AND cs.idempotency_key = v_key;
  IF FOUND THEN
    RETURN QUERY SELECT
      v_existing.id, v_existing.checkout_code, v_existing.source,
      v_existing.combined_subtotal_sen, v_existing.fpx_fee_sen,
      v_existing.total_paid_sen, v_existing.status, v_existing.payment_deadline;
    RETURN;
  END IF;

  IF v_cart_item_ids IS NULL OR cardinality(v_cart_item_ids) = 0 THEN
    IF p_cart_item_ids IS NOT NULL THEN
      RAISE EXCEPTION 'STALE_OR_UNAUTHORIZED_CART_SELECTION';
    END IF;
    RAISE EXCEPTION 'CART_EMPTY';
  END IF;

  -- Every explicitly requested cart_item_id must exist and belong to the authenticated buyer
  IF p_cart_item_ids IS NOT NULL AND cardinality(v_cart_item_ids) <> cardinality(p_cart_item_ids) THEN
    RAISE EXCEPTION 'STALE_OR_UNAUTHORIZED_CART_SELECTION';
  END IF;

  -- Pre-lock ALL listings BEFORE variants in deterministic ID order (deadlock-free)
  PERFORM 1
  FROM public.listings l
  WHERE l.id IN (
    SELECT DISTINCT ci.listing_id
    FROM public.cart_items ci
    WHERE ci.id = ANY(v_cart_item_ids)
  )
  ORDER BY l.id
  FOR UPDATE;

  PERFORM 1
  FROM public.listing_variants lv
  WHERE lv.id IN (
    SELECT DISTINCT ci.variant_id
    FROM public.cart_items ci
    WHERE ci.id = ANY(v_cart_item_ids)
      AND ci.variant_id IS NOT NULL
  )
  ORDER BY lv.id
  FOR UPDATE;

  -- Refresh wall-clock timestamp after lock acquisition
  v_now := clock_timestamp();

  -- Validate every snapshotted cart item, reserve stock ONLY for physical products,
  -- and accumulate combined subtotal
  FOR v_ci IN
    SELECT ci.id, ci.listing_id, ci.variant_id, ci.quantity
    FROM public.cart_items ci
    WHERE ci.id = ANY(v_cart_item_ids)
    ORDER BY ci.listing_id, ci.variant_id NULLS FIRST, ci.id
  LOOP
    IF v_ci.quantity IS NULL OR v_ci.quantity < 1 OR v_ci.quantity > 999 THEN
      RAISE EXCEPTION 'INVALID_QUANTITY';
    END IF;

    SELECT l.* INTO v_listing
    FROM public.listings l
    WHERE l.id = v_ci.listing_id;

    IF NOT FOUND OR v_listing.status <> 'published' THEN
      RAISE EXCEPTION 'LISTING_UNAVAILABLE';
    END IF;

    IF v_listing.kind NOT IN ('pre_loved', 'business', 'service') THEN
      RAISE EXCEPTION 'LISTING_NOT_PURCHASABLE';
    END IF;

    IF COALESCE(v_listing.is_food, false) AND v_listing.availability_mode = 'pre_order' THEN
      RAISE EXCEPTION 'FOOD_PREORDER_NOT_ENABLED';
    END IF;

    IF v_listing.seller_id = v_uid THEN
      RAISE EXCEPTION 'SELF_PURCHASE_FORBIDDEN';
    END IF;

    SELECT p.status INTO v_seller_status
    FROM public.profiles p
    WHERE p.id = v_listing.seller_id;

    IF COALESCE(lower(v_seller_status), '') <> 'active' THEN
      RAISE EXCEPTION 'SELLER_NOT_ACTIVE';
    END IF;

    IF public.is_member_blocked_between(v_uid, v_listing.seller_id) THEN
      RAISE EXCEPTION 'MEMBER_BLOCKED';
    END IF;

    IF v_listing.kind = 'service' THEN
      IF v_listing.accepting_requests IS FALSE THEN
        RAISE EXCEPTION 'SERVICE_PAUSED';
      END IF;

      IF v_ci.variant_id IS NOT NULL THEN
        RAISE EXCEPTION 'UNEXPECTED_VARIANT';
      END IF;

      IF v_ci.quantity > 99 THEN
        RAISE EXCEPTION 'INVALID_SERVICE_QUANTITY';
      END IF;

      v_unit_sen := v_listing.price_sen;
      IF v_unit_sen IS NULL OR v_unit_sen < 200 THEN
        RAISE EXCEPTION 'INVALID_LISTING_PRICE';
      END IF;

      -- Services NEVER reserve or deduct physical inventory
      v_combined_subtotal := v_combined_subtotal + (v_unit_sen * v_ci.quantity);
    ELSE
      IF v_listing.reserved_quantity < 0 OR (v_listing.quantity - v_listing.reserved_quantity) < v_ci.quantity THEN
        RAISE EXCEPTION 'INSUFFICIENT_LISTING_STOCK';
      END IF;

      IF COALESCE(v_listing.has_variants, false) THEN
        IF v_ci.variant_id IS NULL THEN
          RAISE EXCEPTION 'VARIANT_REQUIRED';
        END IF;

        SELECT lv.* INTO v_variant
        FROM public.listing_variants lv
        WHERE lv.id = v_ci.variant_id
          AND lv.listing_id = v_listing.id;

        IF NOT FOUND OR v_variant.active IS NOT TRUE THEN
          RAISE EXCEPTION 'VARIANT_UNAVAILABLE';
        END IF;

        IF v_variant.reserved_quantity < 0 OR (v_variant.quantity - v_variant.reserved_quantity) < v_ci.quantity THEN
          RAISE EXCEPTION 'INSUFFICIENT_VARIANT_STOCK';
        END IF;

        v_unit_sen := v_variant.price_sen;
      ELSE
        IF v_ci.variant_id IS NOT NULL THEN
          RAISE EXCEPTION 'UNEXPECTED_VARIANT';
        END IF;
        v_unit_sen := v_listing.price_sen;
      END IF;

      v_combined_subtotal := v_combined_subtotal + (v_unit_sen * v_ci.quantity);

      UPDATE public.listings l
      SET reserved_quantity = l.reserved_quantity + v_ci.quantity,
          updated_at = v_now
      WHERE l.id = v_listing.id;

      IF COALESCE(v_listing.has_variants, false) THEN
        UPDATE public.listing_variants lv
        SET reserved_quantity = lv.reserved_quantity + v_ci.quantity
        WHERE lv.id = v_variant.id;
      END IF;
    END IF;
  END LOOP;

  IF v_combined_subtotal < 200 THEN
    RAISE EXCEPTION 'INVALID_ORDER_SUBTOTAL';
  END IF;

  -- Create ONE parent checkout session with ONE RM 1.00 FPX fee
  v_checkout_code := 'CHK-' || to_char(v_now AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYMM') || '-'
    || upper(substr(md5(gen_random_uuid()::text), 1, 6));

  INSERT INTO public.checkout_sessions (
    checkout_code, buyer_id, source, idempotency_key,
    combined_subtotal_sen, fpx_fee_sen, total_paid_sen,
    status, payment_deadline
  ) VALUES (
    v_checkout_code, v_uid, 'cart', v_key,
    v_combined_subtotal, v_fpx, v_combined_subtotal + v_fpx,
    'pending_payment', v_now + interval '15 minutes'
  )
  RETURNING * INTO v_session;

  -- Split child orders by (seller_id, fulfillment_kind: 'product' | 'service')
  FOR v_group IN
    SELECT DISTINCT
      l.seller_id,
      CASE WHEN l.kind = 'service' THEN 'service' ELSE 'product' END AS fulfillment_kind
    FROM public.cart_items ci
    JOIN public.listings l ON l.id = ci.listing_id
    WHERE ci.id = ANY(v_cart_item_ids)
    ORDER BY l.seller_id, fulfillment_kind
  LOOP
    SELECT
      COALESCE(SUM(
        CASE
          WHEN l.kind <> 'service' AND COALESCE(l.has_variants, false) THEN lv.price_sen * ci.quantity
          ELSE l.price_sen * ci.quantity
        END
      ), 0)::integer,
      BOOL_OR(l.kind <> 'service' AND COALESCE(l.is_food, false)),
      MIN(ca.name)
    INTO v_subtotal, v_is_food_order, v_area_name
    FROM public.cart_items ci
    JOIN public.listings l ON l.id = ci.listing_id
    LEFT JOIN public.listing_variants lv ON lv.id = ci.variant_id
    LEFT JOIN public.collection_areas ca ON ca.id = l.collection_area_id
    WHERE ci.id = ANY(v_cart_item_ids)
      AND l.seller_id = v_group.seller_id
      AND (CASE WHEN l.kind = 'service' THEN 'service' ELSE 'product' END) = v_group.fulfillment_kind;

    IF v_subtotal < 200 THEN
      RAISE EXCEPTION 'INVALID_ORDER_SUBTOTAL';
    END IF;

    v_commission := ROUND(v_subtotal * 0.02)::integer;
    v_seller_net := GREATEST(0, v_subtotal - v_commission);
    v_order_code := 'BU-' || to_char(v_now AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYMM') || '-'
      || upper(substr(md5(gen_random_uuid()::text), 1, 6));

    v_child_idempotency_key := CASE
      WHEN v_group.fulfillment_kind = 'service' THEN v_key || ':svc'
      ELSE v_key
    END;

    INSERT INTO public.orders (
      order_code, buyer_id, seller_id, source, checkout_session_id,
      subtotal_sen, fpx_fee_sen, total_paid_sen, commission_sen, seller_net_sen,
      status, is_food_order, collection_area_name, payment_deadline, idempotency_key
    ) VALUES (
      v_order_code, v_uid, v_group.seller_id, 'cart', v_session.id,
      v_subtotal, 0, v_subtotal, v_commission, v_seller_net,
      'pending_payment', COALESCE(v_is_food_order, false),
      COALESCE(v_area_name, 'UMSKAL Campus'),
      v_session.payment_deadline, v_child_idempotency_key
    )
    RETURNING * INTO v_order;

    FOR v_ci IN
      SELECT ci.id AS cart_item_id, ci.listing_id, ci.variant_id, ci.quantity,
             l.kind, l.title, l.price_sen AS listing_price_sen, l.has_variants,
             l.image_paths, l.is_food, l.availability_mode, l.service_mode,
             l.pickup_window_start, l.pickup_note,
             lv.price_sen AS variant_price_sen, lv.option_values
      FROM public.cart_items ci
      JOIN public.listings l ON l.id = ci.listing_id
      LEFT JOIN public.listing_variants lv ON lv.id = ci.variant_id
      WHERE ci.id = ANY(v_cart_item_ids)
        AND l.seller_id = v_group.seller_id
        AND (CASE WHEN l.kind = 'service' THEN 'service' ELSE 'product' END) = v_group.fulfillment_kind
      ORDER BY ci.listing_id, ci.variant_id NULLS FIRST, ci.id
    LOOP
      v_unit_sen := CASE
        WHEN v_ci.kind <> 'service' AND COALESCE(v_ci.has_variants, false) THEN v_ci.variant_price_sen
        ELSE v_ci.listing_price_sen
      END;

      v_svc_req := NULL;
      v_svc_paths := '{}'::text[];

      IF v_ci.kind = 'service' AND p_service_details IS NOT NULL AND p_service_details ? (v_ci.cart_item_id::text) THEN
        v_svc_entry := p_service_details -> (v_ci.cart_item_id::text);
        IF jsonb_typeof(v_svc_entry) <> 'object' THEN
          RAISE EXCEPTION 'INVALID_SERVICE_DETAILS';
        END IF;

        IF v_svc_entry ? 'requirements' AND jsonb_typeof(v_svc_entry -> 'requirements') <> 'null' THEN
          IF jsonb_typeof(v_svc_entry -> 'requirements') <> 'string' THEN
            RAISE EXCEPTION 'INVALID_SERVICE_REQUIREMENTS';
          END IF;
          v_svc_req := NULLIF(trim(v_svc_entry ->> 'requirements'), '');
          IF v_svc_req IS NOT NULL AND char_length(v_svc_req) > 1500 THEN
            RAISE EXCEPTION 'SERVICE_REQUIREMENTS_TOO_LONG';
          END IF;
        END IF;

        IF v_svc_entry ? 'attachment_paths' AND jsonb_typeof(v_svc_entry -> 'attachment_paths') <> 'null' THEN
          IF jsonb_typeof(v_svc_entry -> 'attachment_paths') <> 'array' THEN
            RAISE EXCEPTION 'INVALID_SERVICE_ATTACHMENTS';
          END IF;
          IF jsonb_array_length(v_svc_entry -> 'attachment_paths') > 5 THEN
            RAISE EXCEPTION 'TOO_MANY_SERVICE_ATTACHMENTS';
          END IF;

          FOR v_raw_path IN
            SELECT value
            FROM jsonb_array_elements_text(v_svc_entry -> 'attachment_paths')
          LOOP
            IF v_raw_path IS NULL
               OR position('..' in v_raw_path) > 0
               OR v_raw_path !~ ('^' || v_uid::text || '/validated/' || v_ci.cart_item_id::text || '/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp|pdf)$') THEN
              RAISE EXCEPTION 'INVALID_SERVICE_ATTACHMENT_PATH';
            END IF;

            SELECT COALESCE((o.metadata->>'size')::bigint, 0) INTO v_obj_size
            FROM storage.objects o
            WHERE o.bucket_id = 'service-order-attachments'
              AND o.name = v_raw_path
              AND COALESCE(o.metadata->>'mimetype', '') IN (
                'image/jpeg', 'image/png', 'image/webp', 'application/pdf'
              )
            FOR UPDATE;

            IF NOT FOUND THEN
              RAISE EXCEPTION 'SERVICE_ATTACHMENT_NOT_FOUND';
            END IF;

            IF v_obj_size <= 0 OR v_obj_size > 5242880 THEN
              RAISE EXCEPTION 'SERVICE_ATTACHMENT_SIZE_INVALID';
            END IF;

            IF EXISTS (
              SELECT 1
              FROM public.order_items oi_existing
              WHERE oi_existing.service_attachment_paths @> ARRAY[v_raw_path]
            ) THEN
              RAISE EXCEPTION 'SERVICE_ATTACHMENT_ALREADY_USED';
            END IF;

            IF NOT (v_raw_path = ANY(v_svc_paths)) THEN
              v_svc_paths := array_append(v_svc_paths, v_raw_path);
            END IF;
          END LOOP;
        END IF;
      END IF;

      INSERT INTO public.order_items (
        order_id, listing_id, variant_id, title_snapshot, variant_snapshot,
        unit_sen, quantity, image_path, is_food, availability_mode,
        pickup_window_start, pickup_note,
        is_service, service_mode, service_requirements, service_attachment_paths
      ) VALUES (
        v_order.id,
        v_ci.listing_id,
        CASE WHEN v_ci.kind = 'service' THEN NULL ELSE v_ci.variant_id END,
        v_ci.title,
        CASE WHEN v_ci.kind = 'service' THEN NULL ELSE v_ci.option_values END,
        v_unit_sen,
        v_ci.quantity,
        COALESCE(v_ci.image_paths[1], ''),
        CASE WHEN v_ci.kind = 'service' THEN false ELSE COALESCE(v_ci.is_food, false) END,
        COALESCE(v_ci.availability_mode, 'ready'),
        v_ci.pickup_window_start,
        COALESCE(v_ci.pickup_note, ''),
        (v_ci.kind = 'service'),
        CASE WHEN v_ci.kind = 'service' THEN COALESCE(v_ci.service_mode, 'in_person') ELSE NULL END,
        v_svc_req,
        v_svc_paths
      );
    END LOOP;
  END LOOP;

  -- Delete ONLY the checked-out cart items (unticked items stay in cart_items)
  DELETE FROM public.cart_items ci
  WHERE ci.user_id = v_uid
    AND ci.id = ANY(v_cart_item_ids);

  RETURN QUERY SELECT
    v_session.id, v_session.checkout_code, v_session.source,
    v_session.combined_subtotal_sen, v_session.fpx_fee_sen,
    v_session.total_paid_sen, v_session.status, v_session.payment_deadline;
END;
$$;

REVOKE ALL ON FUNCTION public.create_cart_checkout_atomic(text, jsonb, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_cart_checkout_atomic(text, jsonb, uuid[]) TO authenticated;

-- 2. Isolated verification assertions
DO $$
DECLARE
  v_buyer_id      uuid := gen_random_uuid();
  v_other_buyer   uuid := gen_random_uuid();
  v_seller_id     uuid := gen_random_uuid();
  v_prod_cat_id public.categories.id%TYPE;
  v_svc_cat_id  public.categories.id%TYPE;
  v_area_id     public.collection_areas.id%TYPE;
  v_prod_a_id     uuid := gen_random_uuid();
  v_prod_b_id     uuid := gen_random_uuid();
  v_svc_a_id      uuid := gen_random_uuid();
  v_svc_b_id      uuid := gen_random_uuid();
  v_ci_prod_a     uuid := gen_random_uuid();
  v_ci_prod_b     uuid := gen_random_uuid();
  v_ci_svc_a      uuid := gen_random_uuid();
  v_ci_svc_b      uuid := gen_random_uuid();
  v_ci_foreign    uuid := gen_random_uuid();
  v_valid_path    text;
  v_s1            RECORD;
  v_s1_replay     RECORD;
  v_s2            RECORD;
  v_s3            RECORD;
  v_s4            RECORD;
  v_cnt           integer;
  v_res_qty       integer;
  v_expired_cnt   integer;
  v_order_rec     RECORD;
  v_now           timestamptz := now();
  v_desc_prod_a   text := 'Rollback-only verification product A fixture with valid description length for hosted Buy-U checks.';
  v_desc_prod_b   text := 'Rollback-only verification product B fixture with valid description length for hosted Buy-U checks.';
  v_desc_svc_a    text := 'Rollback-only verification service A fixture with valid description length for hosted Buy-U checks.';
  v_desc_svc_b    text := 'Rollback-only verification service B fixture with valid description length for hosted Buy-U checks.';
BEGIN
  -- Lookup existing active categories & collection area (read-only)
  SELECT id INTO v_prod_cat_id FROM public.categories WHERE kind = 'product' AND active = true LIMIT 1;
  SELECT id INTO v_svc_cat_id  FROM public.categories WHERE kind = 'service' AND active = true LIMIT 1;
  SELECT id INTO v_area_id     FROM public.collection_areas WHERE active = true LIMIT 1;
  IF v_prod_cat_id IS NULL OR v_svc_cat_id IS NULL OR v_area_id IS NULL THEN
    RAISE EXCEPTION 'FIXTURE_PREREQ_MISSING: active product/service category or collection area required';
  END IF;

  -- Isolated auth.users & profiles fixtures (hosted university_role IN ('student','staff'))
  INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at)
  VALUES
    (v_buyer_id,    'verify-buyer-'  || left(v_buyer_id::text, 8)    || '@iluv.ums.edu.my', 'x', v_now, '{}', '{}', 'authenticated', 'authenticated', v_now, v_now),
    (v_other_buyer, 'verify-other-'  || left(v_other_buyer::text, 8) || '@iluv.ums.edu.my', 'x', v_now, '{}', '{}', 'authenticated', 'authenticated', v_now, v_now),
    (v_seller_id,   'verify-seller-' || left(v_seller_id::text, 8)   || '@iluv.ums.edu.my', 'x', v_now, '{}', '{}', 'authenticated', 'authenticated', v_now, v_now);

  INSERT INTO public.profiles (id, email, full_name, display_name, university_role, status)
  VALUES
    (v_buyer_id,    'verify-buyer-'  || left(v_buyer_id::text, 8)    || '@iluv.ums.edu.my', 'Verify Buyer',  'Verify Buyer',  'student', 'active'),
    (v_other_buyer, 'verify-other-'  || left(v_other_buyer::text, 8) || '@iluv.ums.edu.my', 'Verify Other',  'Verify Other',  'student', 'active'),
    (v_seller_id,   'verify-seller-' || left(v_seller_id::text, 8)   || '@iluv.ums.edu.my', 'Verify Seller', 'Verify Seller', 'student', 'active')
  ON CONFLICT (id) DO UPDATE SET status = 'active', university_role = 'student';

  -- Isolated product & service listings (all hosted constraints satisfied: description >= 20 chars,
  -- condition valid for pre_loved / NULL for service, quantity >= 1, rules_acknowledged = true)
  INSERT INTO public.listings (
    id, seller_id, kind, is_food, title, description, category_id, condition,
    limitations, price_sen, quantity, reserved_quantity, collection_area_id,
    allow_offers, has_variants, option_groups, availability_mode, pickup_note,
    food_notes, accepting_requests, service_mode, image_paths, rules_acknowledged,
    status, published_at, updated_at
  ) VALUES
    (v_prod_a_id, v_seller_id, 'pre_loved', false, '[VERIFY] Partial Prod A', v_desc_prod_a, v_prod_cat_id, 'Good', '', 2000, 5, 0, v_area_id, false, false, '{}'::text[], 'ready', '', '', true, NULL,     '{}'::text[], true, 'published', v_now, v_now),
    (v_prod_b_id, v_seller_id, 'pre_loved', false, '[VERIFY] Partial Prod B', v_desc_prod_b, v_prod_cat_id, 'Good', '', 3000, 5, 0, v_area_id, false, false, '{}'::text[], 'ready', '', '', true, NULL,     '{}'::text[], true, 'published', v_now, v_now),
    (v_svc_a_id,  v_seller_id, 'service',   false, '[VERIFY] Partial Svc A',  v_desc_svc_a,  v_svc_cat_id,  NULL,   '', 1500, 1, 0, v_area_id, false, false, '{}'::text[], 'ready', '', '', true, 'remote', '{}'::text[], true, 'published', v_now, v_now),
    (v_svc_b_id,  v_seller_id, 'service',   false, '[VERIFY] Partial Svc B',  v_desc_svc_b,  v_svc_cat_id,  NULL,   '', 2500, 1, 0, v_area_id, false, false, '{}'::text[], 'ready', '', '', true, 'both',   '{}'::text[], true, 'published', v_now, v_now);

  -- Populate buyer cart (2 products + 2 services) + 1 foreign buyer cart item
  INSERT INTO public.cart_items (id, user_id, listing_id, variant_id, quantity)
  VALUES
    (v_ci_prod_a,  v_buyer_id,    v_prod_a_id, NULL, 2),
    (v_ci_prod_b,  v_buyer_id,    v_prod_b_id, NULL, 1),
    (v_ci_svc_a,   v_buyer_id,    v_svc_a_id,  NULL, 2),
    (v_ci_svc_b,   v_buyer_id,    v_svc_b_id,  NULL, 1),
    (v_ci_foreign, v_other_buyer, v_prod_a_id, NULL, 1);

  -- Metadata-only storage.objects fixture for SQL path-binding verification (rolled back by ROLLBACK;
  -- never deleted directly from storage.objects; Storage API security tests run in Phase B3)
  v_valid_path := v_buyer_id::text || '/validated/' || v_ci_svc_a::text || '/1700000000-abc123-brief.pdf';
  INSERT INTO storage.objects (bucket_id, name, owner, metadata)
  VALUES (
    'service-order-attachments',
    v_valid_path,
    v_buyer_id,
    jsonb_build_object('mimetype', 'application/pdf', 'size', 10240)
  );

  -- Act as authenticated buyer
  PERFORM set_config('request.jwt.claim.sub', v_buyer_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  -- ---------------------------------------------------------------------------
  -- T1: Partial product checkout (only v_ci_prod_a selected)
  -- ---------------------------------------------------------------------------
  SELECT * INTO v_s1
  FROM public.create_cart_checkout_atomic('verify-p1-' || left(v_buyer_id::text, 8), NULL, ARRAY[v_ci_prod_a]);

  IF v_s1.combined_subtotal_sen <> 4000 OR v_s1.fpx_fee_sen <> 100 OR v_s1.total_paid_sen <> 4100 THEN
    RAISE EXCEPTION 'T1_FAILED: unexpected totals %, %, %', v_s1.combined_subtotal_sen, v_s1.fpx_fee_sen, v_s1.total_paid_sen;
  END IF;

  SELECT commission_sen, seller_net_sen INTO v_order_rec FROM public.orders WHERE checkout_session_id = v_s1.id;
  IF v_order_rec.commission_sen <> 80 OR v_order_rec.seller_net_sen <> 3920 THEN
    RAISE EXCEPTION 'T1_COMMISSION_FAILED: %, %', v_order_rec.commission_sen, v_order_rec.seller_net_sen;
  END IF;

  -- Unticked items remain in cart_items (3 left)
  SELECT count(*) INTO v_cnt FROM public.cart_items WHERE user_id = v_buyer_id;
  IF v_cnt <> 3 THEN
    RAISE EXCEPTION 'T1_UNTICKED_FAILED: expected 3 remaining cart items, got %', v_cnt;
  END IF;

  -- Physical stock reserved ONLY for prod A (qty=2), prod B stays 0
  SELECT reserved_quantity INTO v_res_qty FROM public.listings WHERE id = v_prod_a_id;
  IF v_res_qty <> 2 THEN RAISE EXCEPTION 'T1_STOCK_A_FAILED: %', v_res_qty; END IF;
  SELECT reserved_quantity INTO v_res_qty FROM public.listings WHERE id = v_prod_b_id;
  IF v_res_qty <> 0 THEN RAISE EXCEPTION 'T1_STOCK_B_FAILED: %', v_res_qty; END IF;

  -- ---------------------------------------------------------------------------
  -- T2: Same-key idempotent replay returns same session without duplicate orders/stock
  -- ---------------------------------------------------------------------------
  SELECT * INTO v_s1_replay
  FROM public.create_cart_checkout_atomic('verify-p1-' || left(v_buyer_id::text, 8), NULL, ARRAY[v_ci_prod_a]);
  IF v_s1_replay.id <> v_s1.id THEN
    RAISE EXCEPTION 'T2_REPLAY_ID_MISMATCH';
  END IF;
  SELECT count(*) INTO v_cnt FROM public.orders WHERE checkout_session_id = v_s1.id;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'T2_REPLAY_DUPLICATE_ORDERS: %', v_cnt; END IF;
  SELECT reserved_quantity INTO v_res_qty FROM public.listings WHERE id = v_prod_a_id;
  IF v_res_qty <> 2 THEN RAISE EXCEPTION 'T2_REPLAY_DOUBLE_RESERVE: %', v_res_qty; END IF;

  -- ---------------------------------------------------------------------------
  -- T3: Negative selection rejections (empty, NULL, duplicate, foreign, stale)
  -- ---------------------------------------------------------------------------
  BEGIN
    PERFORM * FROM public.create_cart_checkout_atomic('verify-neg-empty', NULL, ARRAY[]::uuid[]);
    RAISE EXCEPTION 'T3_EMPTY_NOT_REJECTED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%INVALID_CART_SELECTION%' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM * FROM public.create_cart_checkout_atomic('verify-neg-null', NULL, ARRAY[v_ci_prod_b, NULL::uuid]);
    RAISE EXCEPTION 'T3_NULL_NOT_REJECTED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%INVALID_CART_SELECTION%' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM * FROM public.create_cart_checkout_atomic('verify-neg-dup', NULL, ARRAY[v_ci_prod_b, v_ci_prod_b]);
    RAISE EXCEPTION 'T3_DUP_NOT_REJECTED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%DUPLICATE_CART_SELECTION%' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM * FROM public.create_cart_checkout_atomic('verify-neg-foreign', NULL, ARRAY[v_ci_prod_b, v_ci_foreign]);
    RAISE EXCEPTION 'T3_FOREIGN_NOT_REJECTED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%STALE_OR_UNAUTHORIZED_CART_SELECTION%' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM * FROM public.create_cart_checkout_atomic('verify-neg-stale', NULL, ARRAY[v_ci_prod_b, v_ci_prod_a]);
    RAISE EXCEPTION 'T3_STALE_NOT_REJECTED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%STALE_OR_UNAUTHORIZED_CART_SELECTION%' THEN RAISE; END IF;
  END;

  -- Verify NO partial subset was checked out on rejected calls
  SELECT count(*) INTO v_cnt FROM public.cart_items WHERE user_id = v_buyer_id;
  IF v_cnt <> 3 THEN RAISE EXCEPTION 'T3_MUTATED_CART_ON_REJECT: %', v_cnt; END IF;

  -- ---------------------------------------------------------------------------
  -- T4: Partial service checkout with scoped validated attachment & zero stock reservation
  -- ---------------------------------------------------------------------------
  SELECT * INTO v_s2
  FROM public.create_cart_checkout_atomic(
    'verify-svc-' || left(v_buyer_id::text, 8),
    jsonb_build_object(
      v_ci_svc_a::text,
      jsonb_build_object('requirements', 'Please use UMS purple theme', 'attachment_paths', jsonb_build_array(v_valid_path))
    ),
    ARRAY[v_ci_svc_a]
  );

  IF v_s2.combined_subtotal_sen <> 3000 OR v_s2.fpx_fee_sen <> 100 OR v_s2.total_paid_sen <> 3100 THEN
    RAISE EXCEPTION 'T4_TOTALS_FAILED: %, %, %', v_s2.combined_subtotal_sen, v_s2.fpx_fee_sen, v_s2.total_paid_sen;
  END IF;

  SELECT reserved_quantity INTO v_res_qty FROM public.listings WHERE id = v_svc_a_id;
  IF v_res_qty <> 0 THEN RAISE EXCEPTION 'T4_SERVICE_STOCK_DEDUCTED: %', v_res_qty; END IF;

  SELECT count(*) INTO v_cnt
  FROM public.order_items oi
  JOIN public.orders o ON o.id = oi.order_id
  WHERE o.checkout_session_id = v_s2.id
    AND oi.is_service = true
    AND oi.service_requirements = 'Please use UMS purple theme'
    AND oi.service_attachment_paths = ARRAY[v_valid_path];
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'T4_ATTACHMENT_BIND_FAILED: %', v_cnt; END IF;

  -- 2 items still left untouched in cart (v_ci_prod_b, v_ci_svc_b)
  SELECT count(*) INTO v_cnt FROM public.cart_items WHERE user_id = v_buyer_id;
  IF v_cnt <> 2 THEN RAISE EXCEPTION 'T4_REMAINING_FAILED: %', v_cnt; END IF;

  -- ---------------------------------------------------------------------------
  -- T5: Mixed selected product + service checkout from SAME seller (splits into 2 child orders)
  --     Add one extra unticked product first to verify unticked preservation
  -- ---------------------------------------------------------------------------
  INSERT INTO public.cart_items (id, user_id, listing_id, variant_id, quantity)
  VALUES (gen_random_uuid(), v_buyer_id, v_prod_a_id, NULL, 1);

  SELECT * INTO v_s3
  FROM public.create_cart_checkout_atomic(
    'verify-mix-' || left(v_buyer_id::text, 8),
    NULL,
    ARRAY[v_ci_prod_b, v_ci_svc_b]
  );

  IF v_s3.combined_subtotal_sen <> 5500 OR v_s3.fpx_fee_sen <> 100 OR v_s3.total_paid_sen <> 5600 THEN
    RAISE EXCEPTION 'T5_MIXED_TOTALS_FAILED: %, %, %', v_s3.combined_subtotal_sen, v_s3.fpx_fee_sen, v_s3.total_paid_sen;
  END IF;

  SELECT count(*) INTO v_cnt FROM public.orders WHERE checkout_session_id = v_s3.id;
  IF v_cnt <> 2 THEN RAISE EXCEPTION 'T5_SAME_SELLER_SPLIT_FAILED: expected 2 child orders, got %', v_cnt; END IF;

  SELECT reserved_quantity INTO v_res_qty FROM public.listings WHERE id = v_prod_b_id;
  IF v_res_qty <> 1 THEN RAISE EXCEPTION 'T5_PROD_B_RESERVE_FAILED: %', v_res_qty; END IF;
  SELECT reserved_quantity INTO v_res_qty FROM public.listings WHERE id = v_svc_b_id;
  IF v_res_qty <> 0 THEN RAISE EXCEPTION 'T5_SVC_B_NO_RESERVE_FAILED: %', v_res_qty; END IF;

  -- 1 unticked item remains
  SELECT count(*) INTO v_cnt FROM public.cart_items WHERE user_id = v_buyer_id;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'T5_UNTICKED_REMAIN_FAILED: %', v_cnt; END IF;

  -- ---------------------------------------------------------------------------
  -- T6: Legacy full-cart RPC compatibility (2-arg call with p_cart_item_ids omitted)
  -- ---------------------------------------------------------------------------
  SELECT * INTO v_s4
  FROM public.create_cart_checkout_atomic('verify-leg-' || left(v_buyer_id::text, 8), NULL);

  IF v_s4.combined_subtotal_sen <> 2000 OR v_s4.fpx_fee_sen <> 100 THEN
    RAISE EXCEPTION 'T6_LEGACY_FAILED: %, %', v_s4.combined_subtotal_sen, v_s4.fpx_fee_sen;
  END IF;

  SELECT count(*) INTO v_cnt FROM public.cart_items WHERE user_id = v_buyer_id;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'T6_LEGACY_CART_NOT_EMPTIED: %', v_cnt; END IF;

  -- Foreign buyer cart item completely untouched throughout all tests
  SELECT count(*) INTO v_cnt FROM public.cart_items WHERE id = v_ci_foreign AND user_id = v_other_buyer;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'T6_FOREIGN_CART_AFFECTED'; END IF;

  -- ---------------------------------------------------------------------------
  -- T7: Isolated expiry release (temporarily shield any unrelated pre-existing
  --     pending_payment rows inside this ROLLBACK transaction so the global
  --     sweeper processes ONLY our fixture session v_s1)
  -- ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  UPDATE public.checkout_sessions
  SET payment_deadline = now() + interval '1 hour'
  WHERE status = 'pending_payment'
    AND payment_deadline <= now()
    AND id NOT IN (v_s1.id, v_s2.id, v_s3.id, v_s4.id);

  UPDATE public.orders
  SET payment_deadline = now() + interval '1 hour'
  WHERE status = 'pending_payment'
    AND payment_deadline <= now()
    AND COALESCE(checkout_session_id, '00000000-0000-0000-0000-000000000000'::uuid) NOT IN (v_s1.id, v_s2.id, v_s3.id, v_s4.id);

  UPDATE public.checkout_sessions SET payment_deadline = now() - interval '5 minutes' WHERE id = v_s1.id;
  UPDATE public.orders SET payment_deadline = now() - interval '5 minutes' WHERE checkout_session_id = v_s1.id;

  v_expired_cnt := public.release_expired_cart_orders();
  IF v_expired_cnt <> 1 THEN
    RAISE EXCEPTION 'T7_ISOLATION_FAILED: expected exactly 1 expired fixture session, got %', v_expired_cnt;
  END IF;

  SELECT reserved_quantity INTO v_res_qty FROM public.listings WHERE id = v_prod_a_id;
  -- Prod A had 2 from v_s1 (released) + 1 from v_s4 (still active) => 1
  IF v_res_qty <> 1 THEN RAISE EXCEPTION 'T7_EXPIRY_RELEASE_FAILED: expected 1, got %', v_res_qty; END IF;

  RAISE NOTICE 'ALL PHASE 10S PARTIAL CHECKOUT VERIFICATIONS PASSED (T1-T7)';
END;
$$;

ROLLBACK;
