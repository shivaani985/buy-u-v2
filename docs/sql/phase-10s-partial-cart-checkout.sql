-- =============================================================================
-- BUY-U PHASE 10S — PARTIAL CART CHECKOUT (SHOPEE-STYLE SELECTION)
-- =============================================================================
-- Purpose:
--   Extend `public.create_cart_checkout_atomic` with an optional 3rd parameter
--   `p_cart_item_ids uuid[] DEFAULT NULL` so buyers can tick/untick specific
--   cart items (or whole shops) before checkout. Unticked items remain safely
--   in `public.cart_items` untouched.
--
-- Backward-compatible:
--   When `p_cart_item_ids IS NULL`, checks out all buyer `cart_items` as before.
--   Drops the 2-arg overload so no ambiguous overload exists.
--
-- DO NOT RUN AUTOMATICALLY — FOR OWNER REVIEW & EXECUTION.
-- =============================================================================

BEGIN;

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

COMMIT;
