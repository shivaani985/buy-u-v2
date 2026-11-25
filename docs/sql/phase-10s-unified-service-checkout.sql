-- =============================================================================
-- Buy-U Phase 10S — Unified Service Commerce (SQL Migration)
-- STATUS: PROPOSAL ONLY — DO NOT APPLY WITHOUT EXPLICIT OWNER APPROVAL
-- TARGET PROJECT: duwwlcpdidrxkixvflag
--
-- Scope:
--   1. Additive service snapshot & requirement columns on `public.order_items`
--      (no new tables; preserves `public.service_requests` untouched).
--   2. Dedicated private storage bucket `service-order-attachments` (5 MB limit,
--      JPG/PNG/WebP/PDF) with strict buyer-staged upload, immutability, participant
--      read, and dispute-only admin read RLS policies.
--   3. `create_cart_checkout_atomic(text, jsonb DEFAULT NULL)` (replaces 1-arg
--      overload cleanly without ambiguity):
--      - Allows `kind = 'service'` (`quantity >= 1`, no stock reservation/deduction,
--        blocks `accepting_requests = false` with `SERVICE_PAUSED`).
--      - Splits mixed carts into separate child orders by `(seller_id, fulfillment_kind)`
--        using deterministic child idempotency keys (`v_key` vs `v_key || ':svc'`)
--        compatible with `idx_orders_cart_idempotency`.
--      - Validates & atomically snapshots optional `service_requirements` (<= 1500 chars)
--        and buyer-owned staged `service_attachment_paths` (<= 5 files, <= 5 MB each,
--        verified in `storage.objects`) onto `order_items`.
--   4. `confirm_checkout_payment_atomic` (Phase 6C CSPRNG PIN baseline):
--      - Skips physical stock deduction for `order_items.is_service = true`.
--      - Generates independent CSPRNG 6-digit PINs per child product/service order.
--   5. `release_expired_cart_orders`:
--      - Skips physical stock release for `order_items.is_service = true`.
--   6. Phase 6D Dispute & Refund Restock Hardening:
--      - Excludes physical return & restocking on service orders using authoritative
--        `order_items.is_service` snapshot while preserving full/partial refunds,
--        commission reversal, buyer protection, and withdrawal rules.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Additive Service Columns & Constraints on `public.order_items`
-- -----------------------------------------------------------------------------
ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS is_service boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS service_mode text NULL,
  ADD COLUMN IF NOT EXISTS service_requirements text NULL,
  ADD COLUMN IF NOT EXISTS service_attachment_paths text[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.order_items'::regclass
      AND conname = 'order_items_service_requirements_len_chk'
  ) THEN
    ALTER TABLE public.order_items
      ADD CONSTRAINT order_items_service_requirements_len_chk
      CHECK (service_requirements IS NULL OR char_length(service_requirements) <= 1500);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.order_items'::regclass
      AND conname = 'order_items_service_attachments_max_chk'
  ) THEN
    ALTER TABLE public.order_items
      ADD CONSTRAINT order_items_service_attachments_max_chk
      CHECK (cardinality(service_attachment_paths) <= 5);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.order_items'::regclass
      AND conname = 'order_items_service_fields_only_for_service_chk'
  ) THEN
    ALTER TABLE public.order_items
      ADD CONSTRAINT order_items_service_fields_only_for_service_chk
      CHECK (
        is_service = true
        OR (service_requirements IS NULL AND cardinality(service_attachment_paths) = 0)
      );
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_order_items_service_attachments_gin
  ON public.order_items USING gin (service_attachment_paths)
  WHERE cardinality(service_attachment_paths) > 0;

-- -----------------------------------------------------------------------------
-- 2. Dedicated Private Storage Bucket & Strict RLS (`service-order-attachments`)
-- -----------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'service-order-attachments',
  'service-order-attachments',
  false,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = 5242880,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

DROP POLICY IF EXISTS service_attachments_buyer_staged_insert ON storage.objects;
CREATE POLICY service_attachments_buyer_staged_insert
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'service-order-attachments'
    AND (storage.foldername(name))[1] = auth.uid()::text
    AND (storage.foldername(name))[2] = 'staged'
    AND public.is_active_member()
  );

DROP POLICY IF EXISTS service_attachments_buyer_staged_delete ON storage.objects;
CREATE POLICY service_attachments_buyer_staged_delete
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'service-order-attachments'
    AND (storage.foldername(name))[1] = auth.uid()::text
    AND (storage.foldername(name))[2] = 'staged'
  );

DROP POLICY IF EXISTS service_attachments_authorized_select ON storage.objects;
CREATE POLICY service_attachments_authorized_select
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'service-order-attachments'
    AND (
      -- Buyer reading their own staged or server-validated upload preview
      (
        (storage.foldername(name))[1] = auth.uid()::text
        AND (storage.foldername(name))[2] IN ('staged', 'validated')
      )
      -- Authorized transaction participant (buyer or seller of the linked order)
      OR EXISTS (
        SELECT 1
        FROM public.order_items oi
        JOIN public.orders ord ON ord.id = oi.order_id
        WHERE oi.service_attachment_paths @> ARRAY[name]
          AND (ord.buyer_id = auth.uid() OR ord.seller_id = auth.uid())
      )
      -- Authorized active admin ONLY when reviewing a disputed order
      OR (
        public.is_active_admin()
        AND EXISTS (
          SELECT 1
          FROM public.order_items oi
          JOIN public.order_disputes d ON d.order_id = oi.order_id
          WHERE oi.service_attachment_paths @> ARRAY[name]
        )
      )
    )
  );

-- -----------------------------------------------------------------------------
-- 3. Unified Cart Checkout (`create_cart_checkout_atomic`)
--    Drop 1-arg overload first so NO ambiguous or obsolete overload remains.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.create_cart_checkout_atomic(text);

CREATE OR REPLACE FUNCTION public.create_cart_checkout_atomic(
  p_idempotency_key text,
  p_service_details jsonb DEFAULT NULL
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

  -- Lock & snapshot exact buyer cart item IDs (concurrent additions preserved untouched)
  SELECT array_agg(locked.id ORDER BY locked.listing_id, locked.variant_id NULLS FIRST, locked.id)
  INTO v_cart_item_ids
  FROM (
    SELECT ci.id, ci.listing_id, ci.variant_id
    FROM public.cart_items ci
    WHERE ci.user_id = v_uid
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
    RAISE EXCEPTION 'CART_EMPTY';
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
  -- Ensures separate Pickup PIN vs Service Completion PIN and independent fulfillment
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

    -- Deterministic child idempotency key satisfies `idx_orders_cart_idempotency`
    -- even when the same seller has BOTH a product order and a service order in one cart
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
            -- Enforce server-validated path ONLY (authenticated users cannot write/modify/delete `validated/`)
            -- Strictly scoped to this buyer and exact cart item
            IF v_raw_path IS NULL
               OR position('..' in v_raw_path) > 0
               OR v_raw_path !~ ('^' || v_uid::text || '/validated/' || v_ci.cart_item_id::text || '/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp|pdf)$') THEN
              RAISE EXCEPTION 'INVALID_SERVICE_ATTACHMENT_PATH';
            END IF;

            -- Lock & verify server-validated object exists in private bucket, respects 5 MB & MIME allowlist,
            -- and is not already bound to another finalized order item (prevents concurrent substitution/reuse)
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

  -- Delete ONLY snapshotted cart items
  DELETE FROM public.cart_items ci
  WHERE ci.user_id = v_uid
    AND ci.id = ANY(v_cart_item_ids);

  RETURN QUERY SELECT
    v_session.id, v_session.checkout_code, v_session.source,
    v_session.combined_subtotal_sen, v_session.fpx_fee_sen,
    v_session.total_paid_sen, v_session.status, v_session.payment_deadline;
END;
$$;

REVOKE ALL ON FUNCTION public.create_cart_checkout_atomic(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_cart_checkout_atomic(text, jsonb) TO authenticated;

-- -----------------------------------------------------------------------------
-- 4. Payment Confirmation (`confirm_checkout_payment_atomic`)
--    Phase 6C CSPRNG PIN baseline; skips physical stock deduction for services
--    using the authoritative `order_items.is_service` snapshot.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.confirm_checkout_payment_atomic(
  p_checkout_session_id uuid,
  p_bill_code text,
  p_transaction_ref text,
  p_amount_sen integer,
  p_raw_callback jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_source text;
  v_offer public.offers;
  v_session public.checkout_sessions;
  v_child_ord RECORD;
  v_item RECORD;
  v_listing public.listings;
  v_variant public.listing_variants;
  v_now timestamptz;
  v_pin text;
  v_offer_released boolean := false;
  v_total_children integer := 0;
  v_invalid_children integer := 0;
  v_child_subtotal_sum integer := 0;
  v_items_total_sum integer := 0;
BEGIN
  IF p_bill_code IS NULL OR length(trim(p_bill_code)) = 0 THEN
    RAISE EXCEPTION 'MISSING_BILL_CODE';
  END IF;

  IF p_transaction_ref IS NULL OR length(trim(p_transaction_ref)) = 0 THEN
    RAISE EXCEPTION 'MISSING_TRANSACTION_REF';
  END IF;

  IF p_amount_sen IS NULL OR p_amount_sen <= 0 THEN
    RAISE EXCEPTION 'AMOUNT_MISMATCH';
  END IF;

  SELECT source INTO v_source
  FROM public.checkout_sessions
  WHERE id = p_checkout_session_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CHECKOUT_NOT_FOUND';
  END IF;

  IF v_source = 'offer' THEN
    SELECT o.* INTO v_offer
    FROM public.offers o
    JOIN public.orders ord ON ord.id = o.order_id
    WHERE ord.checkout_session_id = p_checkout_session_id
    FOR UPDATE OF o;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'LINKED_OFFER_NOT_FOUND';
    END IF;
  END IF;

  SELECT * INTO v_session
  FROM public.checkout_sessions
  WHERE id = p_checkout_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CHECKOUT_NOT_FOUND';
  END IF;

  v_now := clock_timestamp();

  IF v_source = 'offer' THEN
    IF v_offer.reservation_released_at IS NOT NULL
       OR v_offer.status <> 'accepted'
       OR (v_offer.reservation_expires_at IS NOT NULL AND v_now >= v_offer.reservation_expires_at) THEN
      v_offer_released := true;
    END IF;
  END IF;

  IF v_session.bill_creation_state <> 'ready'
     OR v_session.bill_code IS NULL
     OR left(v_session.bill_code, 9) = 'creating:'
     OR v_session.bill_code <> p_bill_code THEN
    RAISE EXCEPTION 'PAYMENT_BILL_NOT_READY';
  END IF;

  IF p_amount_sen <> v_session.total_paid_sen
     OR v_session.total_paid_sen <> (v_session.combined_subtotal_sen + v_session.fpx_fee_sen) THEN
    RAISE EXCEPTION 'AMOUNT_MISMATCH';
  END IF;

  INSERT INTO public.payment_transaction_registry (transaction_ref, owner_kind, owner_id)
  VALUES (p_transaction_ref, 'checkout_session', v_session.id)
  ON CONFLICT (transaction_ref) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
    FROM public.payment_transaction_registry
    WHERE transaction_ref = p_transaction_ref
      AND owner_kind = 'checkout_session'
      AND owner_id = v_session.id
  ) THEN
    RAISE EXCEPTION 'TRANSACTION_REF_REUSED' USING ERRCODE = '23505';
  END IF;

  IF v_session.paid_at IS NOT NULL OR v_session.status = 'paid' THEN
    IF v_session.transaction_ref IS NULL OR v_session.transaction_ref <> p_transaction_ref THEN
      RAISE EXCEPTION 'TRANSACTION_REF_CONFLICT';
    END IF;
    RETURN 'already_paid';
  END IF;

  IF v_offer_released
     OR v_session.status IN ('expired', 'cancelled')
     OR v_now >= v_session.payment_deadline THEN
    IF v_session.payment_status = 'late_payment_review' THEN
      IF v_session.transaction_ref = p_transaction_ref THEN
        RETURN 'late_payment_reconciliation';
      END IF;
      RAISE EXCEPTION 'LATE_PAYMENT_TRANSACTION_REF_CONFLICT';
    END IF;

    UPDATE public.checkout_sessions
    SET payment_status = 'late_payment_review',
        transaction_ref = p_transaction_ref,
        verified_at = v_now,
        raw_callback = p_raw_callback,
        updated_at = v_now
    WHERE id = v_session.id;

    RETURN 'late_payment_reconciliation';
  END IF;

  IF v_session.status <> 'pending_payment' THEN
    RAISE EXCEPTION 'CHECKOUT_NOT_PAYABLE';
  END IF;

  PERFORM 1
  FROM public.orders
  WHERE checkout_session_id = v_session.id
  ORDER BY id
  FOR UPDATE;

  SELECT
    count(*)::integer,
    count(*) FILTER (
      WHERE status <> 'pending_payment'
         OR paid_at IS NOT NULL
         OR buyer_id <> v_session.buyer_id
         OR source <> v_session.source
         OR fpx_fee_sen <> 0
         OR total_paid_sen <> subtotal_sen
    )::integer,
    COALESCE(SUM(subtotal_sen), 0)::integer
  INTO v_total_children, v_invalid_children, v_child_subtotal_sum
  FROM public.orders
  WHERE checkout_session_id = v_session.id;

  IF v_total_children = 0 OR v_invalid_children > 0 THEN
    RAISE EXCEPTION 'CHECKOUT_CHILD_ORDERS_INVALID';
  END IF;

  IF v_child_subtotal_sum <> v_session.combined_subtotal_sen THEN
    RAISE EXCEPTION 'CHECKOUT_SUBTOTAL_MISMATCH';
  END IF;

  SELECT COALESCE(SUM(oi.unit_sen * oi.quantity), 0)::integer
  INTO v_items_total_sum
  FROM public.order_items oi
  JOIN public.orders ord ON ord.id = oi.order_id
  WHERE ord.checkout_session_id = v_session.id;

  IF v_items_total_sum <> v_session.combined_subtotal_sen THEN
    RAISE EXCEPTION 'CHECKOUT_ITEMS_TOTAL_MISMATCH';
  END IF;

  -- Lock ONLY physical product listings and variants (services have zero inventory mutations)
  PERFORM 1
  FROM public.listings l
  WHERE l.id IN (
    SELECT DISTINCT oi.listing_id
    FROM public.order_items oi
    JOIN public.orders ord ON ord.id = oi.order_id
    WHERE ord.checkout_session_id = v_session.id
      AND COALESCE(oi.is_service, false) IS NOT TRUE
  )
  ORDER BY l.id
  FOR UPDATE;

  PERFORM 1
  FROM public.listing_variants lv
  WHERE lv.id IN (
    SELECT DISTINCT oi.variant_id
    FROM public.order_items oi
    JOIN public.orders ord ON ord.id = oi.order_id
    WHERE ord.checkout_session_id = v_session.id
      AND COALESCE(oi.is_service, false) IS NOT TRUE
      AND oi.variant_id IS NOT NULL
  )
  ORDER BY lv.id
  FOR UPDATE;

  v_now := clock_timestamp();
  IF v_now >= v_session.payment_deadline
     OR (v_source = 'offer' AND v_offer.reservation_expires_at IS NOT NULL AND v_now >= v_offer.reservation_expires_at) THEN
    UPDATE public.checkout_sessions
    SET payment_status = 'late_payment_review',
        transaction_ref = p_transaction_ref,
        verified_at = v_now,
        raw_callback = p_raw_callback,
        updated_at = v_now
    WHERE id = v_session.id;

    RETURN 'late_payment_reconciliation';
  END IF;

  -- Deduct inventory ONLY for non-service items
  FOR v_item IN
    SELECT oi.listing_id, oi.variant_id, oi.quantity
    FROM public.order_items oi
    JOIN public.orders ord ON ord.id = oi.order_id
    WHERE ord.checkout_session_id = v_session.id
      AND COALESCE(oi.is_service, false) IS NOT TRUE
    ORDER BY oi.listing_id, oi.variant_id NULLS FIRST, oi.id
  LOOP
    SELECT * INTO v_listing
    FROM public.listings
    WHERE id = v_item.listing_id;

    IF NOT FOUND
       OR v_listing.reserved_quantity < v_item.quantity
       OR v_listing.quantity < v_item.quantity THEN
      RAISE EXCEPTION 'INSUFFICIENT_LISTING_RESERVATION';
    END IF;

    IF v_item.variant_id IS NOT NULL THEN
      SELECT * INTO v_variant
      FROM public.listing_variants
      WHERE id = v_item.variant_id
        AND listing_id = v_item.listing_id;

      IF NOT FOUND
         OR v_variant.reserved_quantity < v_item.quantity
         OR v_variant.quantity < v_item.quantity THEN
        RAISE EXCEPTION 'INSUFFICIENT_VARIANT_RESERVATION';
      END IF;
    END IF;

    UPDATE public.listings
    SET quantity = quantity - v_item.quantity,
        reserved_quantity = reserved_quantity - v_item.quantity,
        updated_at = v_now
    WHERE id = v_listing.id;

    IF v_item.variant_id IS NOT NULL THEN
      UPDATE public.listing_variants
      SET quantity = quantity - v_item.quantity,
          reserved_quantity = reserved_quantity - v_item.quantity
      WHERE id = v_variant.id;
    END IF;
  END LOOP;

  UPDATE public.checkout_sessions
  SET status = 'paid',
      payment_status = 'paid',
      paid_at = v_now,
      transaction_ref = p_transaction_ref,
      verified_at = v_now,
      raw_callback = p_raw_callback,
      bill_creation_attempt_token = NULL,
      updated_at = v_now
  WHERE id = v_session.id;

  -- Generate an independent CSPRNG 6-digit PIN for EVERY child order (product or service)
  FOR v_child_ord IN
    SELECT id
    FROM public.orders
    WHERE checkout_session_id = v_session.id
    ORDER BY id
  LOOP
    v_pin := public.generate_secure_pickup_pin();
    UPDATE public.orders
    SET status = 'paid',
        paid_at = v_now,
        pickup_pin = COALESCE(pickup_pin, v_pin),
        updated_at = v_now
    WHERE id = v_child_ord.id;
  END LOOP;

  RETURN 'confirmed_paid';
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_checkout_payment_atomic(uuid, text, text, integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_checkout_payment_atomic(uuid, text, text, integer, jsonb) TO service_role;

-- -----------------------------------------------------------------------------
-- 5. Cart Expiry (`release_expired_cart_orders`)
--    Skips physical stock release for `order_items.is_service = true`.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_expired_cart_orders()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ord RECORD;
  v_sess RECORD;
  v_item RECORD;
  v_listing public.listings;
  v_variant public.listing_variants;
  v_now timestamptz := clock_timestamp();
  v_count integer := 0;
BEGIN
  -- Part A: Legacy standalone cart orders ONLY (`checkout_session_id IS NULL`)
  FOR v_ord IN
    SELECT id
    FROM public.orders
    WHERE source = 'cart'
      AND checkout_session_id IS NULL
      AND status = 'pending_payment'
      AND paid_at IS NULL
      AND payment_deadline IS NOT NULL
      AND payment_deadline <= v_now
    ORDER BY id
    FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      PERFORM 1
      FROM public.listings l
      WHERE l.id IN (
        SELECT DISTINCT oi.listing_id
        FROM public.order_items oi
        WHERE oi.order_id = v_ord.id
          AND COALESCE(oi.is_service, false) IS NOT TRUE
      )
      ORDER BY l.id
      FOR UPDATE;

      PERFORM 1
      FROM public.listing_variants lv
      WHERE lv.id IN (
        SELECT DISTINCT oi.variant_id
        FROM public.order_items oi
        WHERE oi.order_id = v_ord.id
          AND COALESCE(oi.is_service, false) IS NOT TRUE
          AND oi.variant_id IS NOT NULL
      )
      ORDER BY lv.id
      FOR UPDATE;

      FOR v_item IN
        SELECT listing_id, variant_id, quantity
        FROM public.order_items
        WHERE order_id = v_ord.id
          AND COALESCE(is_service, false) IS NOT TRUE
        ORDER BY listing_id, variant_id NULLS FIRST
      LOOP
        SELECT * INTO v_listing FROM public.listings WHERE id = v_item.listing_id;
        IF NOT FOUND OR v_listing.reserved_quantity < v_item.quantity THEN
          RAISE EXCEPTION 'INSUFFICIENT_LISTING_RESERVATION';
        END IF;

        IF v_item.variant_id IS NOT NULL THEN
          SELECT * INTO v_variant
          FROM public.listing_variants
          WHERE id = v_item.variant_id AND listing_id = v_item.listing_id;
          IF NOT FOUND OR v_variant.reserved_quantity < v_item.quantity THEN
            RAISE EXCEPTION 'INSUFFICIENT_VARIANT_RESERVATION';
          END IF;
        END IF;

        UPDATE public.listings
        SET reserved_quantity = reserved_quantity - v_item.quantity,
            updated_at = v_now
        WHERE id = v_item.listing_id;

        IF v_item.variant_id IS NOT NULL THEN
          UPDATE public.listing_variants
          SET reserved_quantity = reserved_quantity - v_item.quantity
          WHERE id = v_item.variant_id;
        END IF;
      END LOOP;

      UPDATE public.orders
      SET status = 'expired',
          updated_at = v_now
      WHERE id = v_ord.id
        AND status = 'pending_payment'
        AND paid_at IS NULL;

      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'release_expired_cart_orders skipped legacy order % due to %', v_ord.id, SQLERRM;
    END;
  END LOOP;

  -- Part B: Unified cart checkout sessions (whole-checkout expiry + product-only stock release)
  FOR v_sess IN
    SELECT id
    FROM public.checkout_sessions
    WHERE source = 'cart'
      AND status = 'pending_payment'
      AND paid_at IS NULL
      AND payment_deadline <= v_now
    ORDER BY id
    FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      PERFORM 1
      FROM public.orders
      WHERE checkout_session_id = v_sess.id
      ORDER BY id
      FOR UPDATE;

      PERFORM 1
      FROM public.listings l
      WHERE l.id IN (
        SELECT DISTINCT oi.listing_id
        FROM public.order_items oi
        JOIN public.orders ord ON ord.id = oi.order_id
        WHERE ord.checkout_session_id = v_sess.id
          AND COALESCE(oi.is_service, false) IS NOT TRUE
      )
      ORDER BY l.id
      FOR UPDATE;

      PERFORM 1
      FROM public.listing_variants lv
      WHERE lv.id IN (
        SELECT DISTINCT oi.variant_id
        FROM public.order_items oi
        JOIN public.orders ord ON ord.id = oi.order_id
        WHERE ord.checkout_session_id = v_sess.id
          AND COALESCE(oi.is_service, false) IS NOT TRUE
          AND oi.variant_id IS NOT NULL
      )
      ORDER BY lv.id
      FOR UPDATE;

      FOR v_item IN
        SELECT oi.listing_id, oi.variant_id, oi.quantity
        FROM public.order_items oi
        JOIN public.orders ord ON ord.id = oi.order_id
        WHERE ord.checkout_session_id = v_sess.id
          AND COALESCE(oi.is_service, false) IS NOT TRUE
        ORDER BY oi.listing_id, oi.variant_id NULLS FIRST, oi.id
      LOOP
        SELECT * INTO v_listing FROM public.listings WHERE id = v_item.listing_id;
        IF NOT FOUND OR v_listing.reserved_quantity < v_item.quantity THEN
          RAISE EXCEPTION 'INSUFFICIENT_LISTING_RESERVATION';
        END IF;

        IF v_item.variant_id IS NOT NULL THEN
          SELECT * INTO v_variant
          FROM public.listing_variants
          WHERE id = v_item.variant_id AND listing_id = v_item.listing_id;
          IF NOT FOUND OR v_variant.reserved_quantity < v_item.quantity THEN
            RAISE EXCEPTION 'INSUFFICIENT_VARIANT_RESERVATION';
          END IF;
        END IF;

        UPDATE public.listings
        SET reserved_quantity = reserved_quantity - v_item.quantity,
            updated_at = v_now
        WHERE id = v_item.listing_id;

        IF v_item.variant_id IS NOT NULL THEN
          UPDATE public.listing_variants
          SET reserved_quantity = reserved_quantity - v_item.quantity
          WHERE id = v_item.variant_id;
        END IF;
      END LOOP;

      UPDATE public.orders
      SET status = 'expired',
          updated_at = v_now
      WHERE checkout_session_id = v_sess.id
        AND status = 'pending_payment'
        AND paid_at IS NULL;

      UPDATE public.checkout_sessions
      SET status = 'expired',
          payment_status = CASE
            WHEN payment_status IN ('paid', 'late_payment_review') THEN payment_status
            ELSE 'expired'
          END,
          updated_at = v_now
      WHERE id = v_sess.id
        AND status = 'pending_payment'
        AND paid_at IS NULL;

      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'release_expired_cart_orders skipped checkout_session % due to %', v_sess.id, SQLERRM;
    END;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.release_expired_cart_orders() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_expired_cart_orders() TO service_role;

-- -----------------------------------------------------------------------------
-- 6. Phase 6D Dispute & Refund Restock Hardening for Service Orders
--    Excludes physical returns and restocking for service orders using
--    authoritative `order_items.is_service` snapshot; preserves all financial logic.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_resolve_order_dispute_atomic(
  p_dispute_id uuid,
  p_resolution_type text,
  p_refund_amount_sen integer DEFAULT NULL,
  p_admin_notes text DEFAULT NULL,
  p_return_required boolean DEFAULT false,
  p_return_instructions text DEFAULT NULL
)
RETURNS TABLE (
  id                      uuid,
  dispute_code            text,
  status                  text,
  resolution_type         text,
  refund_amount_sen       integer,
  refund_execution_status text,
  order_status            text,
  resolved_at             timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_order_id uuid;
  v_seller_id uuid;
  v_order public.orders;
  v_dispute public.order_disputes;
  v_now timestamptz;
  v_res_type text := lower(trim(COALESCE(p_resolution_type, '')));
  v_prior_refunded_sen integer := 0;
  v_remaining_refundable integer := 0;
  v_refund_sen integer := 0;
  v_retained_sub integer := 0;
  v_adjusted_comm integer := 0;
  v_comm_rev integer := 0;
  v_seller_deduct integer := 0;
  v_exec_status text := 'not_applicable';
  v_next_order_status text;
  v_payment_ref text := NULL;
  v_refund_code text;
  v_return_req boolean := COALESCE(p_return_required, false);
  v_is_service_order boolean := false;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY' USING ERRCODE = '42501';
  END IF;

  IF v_res_type NOT IN ('release_to_seller', 'full_refund', 'partial_refund') THEN
    RAISE EXCEPTION 'INVALID_RESOLUTION_TYPE';
  END IF;

  SELECT d.order_id INTO v_order_id FROM public.order_disputes d WHERE d.id = p_dispute_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DISPUTE_NOT_FOUND';
  END IF;

  SELECT o.seller_id INTO v_seller_id FROM public.orders o WHERE o.id = v_order_id;
  PERFORM 1 FROM public.profiles p WHERE p.id = v_seller_id FOR UPDATE;
  SELECT o.* INTO v_order FROM public.orders o WHERE o.id = v_order_id FOR UPDATE;
  SELECT d.* INTO v_dispute FROM public.order_disputes d WHERE d.id = p_dispute_id FOR UPDATE;

  IF v_dispute.status = 'resolved' THEN
    RAISE EXCEPTION 'DISPUTE_ALREADY_RESOLVED';
  END IF;

  IF v_order.status <> 'disputed' THEN
    RAISE EXCEPTION 'ORDER_NOT_DISPUTED';
  END IF;

  -- Authoritative snapshot check: service orders never support physical returns or restocking
  SELECT EXISTS (
    SELECT 1
    FROM public.order_items oi
    WHERE oi.order_id = v_order.id
      AND COALESCE(oi.is_service, false) IS TRUE
  ) INTO v_is_service_order;

  IF v_is_service_order AND v_return_req THEN
    RAISE EXCEPTION 'SERVICE_ORDER_RETURN_NOT_APPLICABLE';
  END IF;

  SELECT COALESCE(SUM(d2.refund_amount_sen), 0)::integer
  INTO v_prior_refunded_sen
  FROM public.order_disputes d2
  WHERE d2.order_id = v_order.id
    AND d2.id <> v_dispute.id
    AND d2.refund_execution_status IN ('pending_execution', 'executed');

  v_remaining_refundable := GREATEST(0, v_order.subtotal_sen - v_prior_refunded_sen);

  IF v_res_type = 'release_to_seller' THEN
    v_refund_sen := 0;
    v_exec_status := 'not_applicable';
    IF v_dispute.previous_order_status IN ('paid', 'handed_over', 'completed') THEN
      v_next_order_status := v_dispute.previous_order_status;
    ELSIF v_order.completed_at IS NOT NULL THEN
      v_next_order_status := 'completed';
    ELSIF v_order.handed_over_at IS NOT NULL THEN
      v_next_order_status := 'handed_over';
    ELSE
      v_next_order_status := 'paid';
    END IF;
  ELSIF v_res_type = 'full_refund' THEN
    IF v_remaining_refundable <= 0 THEN
      RAISE EXCEPTION 'ORDER_ALREADY_REFUNDED';
    END IF;
    v_refund_sen := v_remaining_refundable;
    v_exec_status := 'pending_execution';
    v_next_order_status := 'disputed';
  ELSE
    IF v_remaining_refundable <= 1 THEN
      RAISE EXCEPTION 'ORDER_ALREADY_REFUNDED';
    END IF;
    IF p_refund_amount_sen IS NULL
       OR p_refund_amount_sen <= 0
       OR p_refund_amount_sen >= v_remaining_refundable THEN
      RAISE EXCEPTION 'INVALID_PARTIAL_REFUND_AMOUNT';
    END IF;
    v_refund_sen := p_refund_amount_sen;
    v_exec_status := 'pending_execution';
    v_next_order_status := 'disputed';
  END IF;

  v_now := clock_timestamp();

  UPDATE public.order_disputes d
  SET status = 'resolved',
      resolution_type = v_res_type,
      refund_amount_sen = v_refund_sen,
      refund_execution_status = v_exec_status,
      refund_ref = NULL,
      admin_notes = CASE WHEN p_admin_notes IS NOT NULL THEN trim(p_admin_notes) ELSE d.admin_notes END,
      resolved_by = v_uid,
      resolved_at = v_now,
      updated_at = v_now
  WHERE d.id = v_dispute.id
  RETURNING * INTO v_dispute;

  UPDATE public.orders o
  SET status = v_next_order_status, updated_at = v_now
  WHERE o.id = v_order.id;

  IF v_res_type IN ('full_refund', 'partial_refund') THEN
    v_retained_sub := GREATEST(0, v_order.subtotal_sen - v_refund_sen);
    v_adjusted_comm := round(v_retained_sub * 0.02)::integer;
    v_comm_rev := GREATEST(0, v_order.commission_sen - v_adjusted_comm);
    v_seller_deduct := v_refund_sen - v_comm_rev;

    IF v_order.checkout_session_id IS NOT NULL THEN
      SELECT cs.transaction_ref INTO v_payment_ref
      FROM public.checkout_sessions cs WHERE cs.id = v_order.checkout_session_id;
    ELSE
      SELECT p.transaction_ref INTO v_payment_ref
      FROM public.payments p WHERE p.order_id = v_order.id AND p.status = 'paid' LIMIT 1;
    END IF;

    v_refund_code := 'RFD-'
      || to_char(v_now AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYMM')
      || '-'
      || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

    INSERT INTO public.order_refunds (
      refund_code, dispute_id, order_id, original_payment_ref,
      refund_type, refund_amount_sen, commission_reversal_sen, seller_deduction_sen,
      status, provider, simulation_mode, idempotency_key,
      return_required, return_status, return_instructions,
      restock_status, initiated_by, created_at, updated_at
    ) VALUES (
      v_refund_code, v_dispute.id, v_order.id, v_payment_ref,
      v_res_type, v_refund_sen, v_comm_rev, v_seller_deduct,
      CASE WHEN v_return_req THEN 'awaiting_return' ELSE 'pending_execution' END,
      'simulated_refund', true, 'rfd-' || v_dispute.id::text,
      v_return_req,
      CASE WHEN v_return_req THEN 'awaiting_return' ELSE 'not_required' END,
      NULLIF(trim(COALESCE(p_return_instructions, '')), ''),
      CASE
        WHEN v_is_service_order THEN 'not_applicable'
        WHEN v_res_type = 'full_refund' THEN 'pending_decision'
        ELSE 'not_applicable'
      END,
      v_uid, v_now, v_now
    )
    ON CONFLICT (dispute_id) DO NOTHING;

    PERFORM public.safe_insert_notification(
      v_order.buyer_id,
      CASE WHEN v_return_req THEN 'return_required' ELSE 'refund_approved' END,
      CASE WHEN v_return_req
        THEN 'Return required for #' || v_order.order_code
        ELSE 'Refund approved for #' || v_order.order_code END,
      'Approved simulated refund: RM ' || to_char(v_refund_sen / 100.0, 'FM999990.00'),
      '/orders',
      'refund-approved-' || v_dispute.id::text
    );
  END IF;

  RETURN QUERY SELECT
    v_dispute.id, v_dispute.dispute_code, v_dispute.status, v_dispute.resolution_type,
    v_dispute.refund_amount_sen, v_dispute.refund_execution_status,
    v_next_order_status, v_dispute.resolved_at;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_resolve_order_dispute_atomic(uuid, text, integer, text, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_resolve_order_dispute_atomic(uuid, text, integer, text, boolean, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_configure_refund_return_atomic(
  p_refund_id uuid,
  p_return_required boolean,
  p_return_instructions text DEFAULT NULL
)
RETURNS TABLE (
  refund_id           uuid,
  refund_code         text,
  status              text,
  return_required     boolean,
  return_status       text,
  return_instructions text,
  updated_at          timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_order public.orders;
  v_refund public.order_refunds;
  v_now timestamptz := clock_timestamp();
  v_is_service_order boolean := false;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY' USING ERRCODE = '42501';
  END IF;

  SELECT o.* INTO v_order
  FROM public.order_refunds r
  JOIN public.orders o ON o.id = r.order_id
  WHERE r.id = p_refund_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'REFUND_NOT_FOUND'; END IF;

  PERFORM 1 FROM public.profiles p WHERE p.id = v_order.seller_id FOR UPDATE;
  PERFORM 1 FROM public.orders o WHERE o.id = v_order.id FOR UPDATE;
  SELECT r.* INTO v_refund FROM public.order_refunds r WHERE r.id = p_refund_id FOR UPDATE;

  IF v_refund.status NOT IN ('pending_execution', 'awaiting_return', 'failed') THEN
    RAISE EXCEPTION 'REFUND_NOT_CONFIGURABLE';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.order_items oi
    WHERE oi.order_id = v_order.id
      AND COALESCE(oi.is_service, false) IS TRUE
  ) INTO v_is_service_order;

  IF v_is_service_order AND COALESCE(p_return_required, false) THEN
    RAISE EXCEPTION 'SERVICE_ORDER_RETURN_NOT_APPLICABLE';
  END IF;

  UPDATE public.order_refunds r
  SET return_required = COALESCE(p_return_required, false),
      return_status = CASE WHEN COALESCE(p_return_required, false) THEN 'awaiting_return' ELSE 'not_required' END,
      return_instructions = NULLIF(trim(COALESCE(p_return_instructions, '')), ''),
      status = CASE WHEN COALESCE(p_return_required, false) THEN 'awaiting_return' ELSE 'pending_execution' END,
      restock_status = CASE WHEN r.restock_status = 'approved_pending_refund' THEN 'pending_decision' ELSE r.restock_status END,
      restock_plan = CASE WHEN r.restock_status = 'approved_pending_refund' THEN NULL ELSE r.restock_plan END,
      updated_at = v_now
  WHERE r.id = v_refund.id
  RETURNING * INTO v_refund;

  RETURN QUERY SELECT
    v_refund.id, v_refund.refund_code, v_refund.status,
    v_refund.return_required, v_refund.return_status,
    v_refund.return_instructions, v_refund.updated_at;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_configure_refund_return_atomic(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_configure_refund_return_atomic(uuid, boolean, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.execute_approved_refund_restock_internal(
  p_refund_id uuid,
  p_actor_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_refund public.order_refunds;
  v_dispute public.order_disputes;
  v_order public.orders;
  v_plan_item RECORD;
  v_listing public.listings;
  v_variant public.listing_variants;
  v_any_exception boolean := false;
  v_now timestamptz := clock_timestamp();
BEGIN
  SELECT r.* INTO v_refund FROM public.order_refunds r WHERE r.id = p_refund_id;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_refund.status <> 'succeeded' THEN RETURN v_refund.restock_status; END IF;
  IF v_refund.restock_status IN ('approved_restocked', 'declined', 'inventory_exception', 'not_applicable') THEN
    RETURN v_refund.restock_status;
  END IF;

  SELECT o.* INTO v_order FROM public.orders o WHERE o.id = v_refund.order_id;
  SELECT d.* INTO v_dispute FROM public.order_disputes d WHERE d.id = v_refund.dispute_id;

  IF (v_dispute.previous_order_status IN ('handed_over', 'completed') OR v_order.handed_over_at IS NOT NULL)
     AND (v_refund.return_status <> 'return_confirmed' OR v_refund.item_condition <> 'resellable') THEN
    UPDATE public.order_refunds r
    SET restock_status = 'inventory_exception', updated_at = v_now
    WHERE r.id = v_refund.id;
    RETURN 'inventory_exception';
  END IF;

  IF v_refund.item_condition IN ('damaged', 'missing') THEN
    UPDATE public.order_refunds r
    SET restock_status = 'inventory_exception', updated_at = v_now
    WHERE r.id = v_refund.id;
    RETURN 'inventory_exception';
  END IF;

  PERFORM 1
  FROM public.listings l
  WHERE l.id IN (
    SELECT DISTINCT oi.listing_id
    FROM jsonb_array_elements(COALESCE(v_refund.restock_plan, '[]'::jsonb)) elem
    JOIN public.order_items oi
      ON oi.id = (elem->>'order_item_id')::uuid
     AND oi.order_id = v_order.id
    WHERE oi.listing_id IS NOT NULL
      AND COALESCE(oi.is_service, false) IS NOT TRUE
  )
  ORDER BY l.id
  FOR UPDATE;

  PERFORM 1
  FROM public.listing_variants lv
  WHERE lv.id IN (
    SELECT DISTINCT oi.variant_id
    FROM jsonb_array_elements(COALESCE(v_refund.restock_plan, '[]'::jsonb)) elem
    JOIN public.order_items oi
      ON oi.id = (elem->>'order_item_id')::uuid
     AND oi.order_id = v_order.id
    WHERE oi.variant_id IS NOT NULL
      AND COALESCE(oi.is_service, false) IS NOT TRUE
  )
  ORDER BY lv.id
  FOR UPDATE;

  FOR v_plan_item IN
    SELECT
      (elem->>'order_item_id')::uuid AS order_item_id,
      (elem->>'quantity')::integer AS restore_qty,
      oi.listing_id,
      oi.variant_id,
      oi.quantity AS purchased_qty,
      COALESCE(oi.is_food, false) AS snapshot_is_food,
      COALESCE(oi.is_service, false) AS snapshot_is_service
    FROM jsonb_array_elements(COALESCE(v_refund.restock_plan, '[]'::jsonb)) elem
    JOIN public.order_items oi
      ON oi.id = (elem->>'order_item_id')::uuid
     AND oi.order_id = v_order.id
    ORDER BY oi.listing_id NULLS LAST, oi.variant_id NULLS LAST, oi.id
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.order_restock_logs l
      WHERE l.refund_id = v_refund.id AND l.order_item_id = v_plan_item.order_item_id
    ) THEN
      CONTINUE;
    END IF;

    IF v_plan_item.restore_qty IS NULL
       OR v_plan_item.restore_qty <= 0
       OR v_plan_item.restore_qty > v_plan_item.purchased_qty THEN
      v_any_exception := true;
      INSERT INTO public.order_restock_logs (
        refund_id, order_id, order_item_id, listing_id, variant_id,
        quantity_restored, outcome, note, approved_by, created_at
      ) VALUES (
        v_refund.id, v_order.id, v_plan_item.order_item_id, v_plan_item.listing_id, v_plan_item.variant_id,
        0, 'inventory_exception', 'Invalid restore quantity vs purchased quantity', p_actor_id, v_now
      );
      CONTINUE;
    END IF;

    SELECT * INTO v_listing FROM public.listings WHERE id = v_plan_item.listing_id;
    IF NOT FOUND
       OR v_plan_item.snapshot_is_food
       OR v_plan_item.snapshot_is_service
       OR COALESCE(v_listing.is_food, false)
       OR lower(COALESCE(v_listing.kind, '')) = 'service' THEN
      v_any_exception := true;
      INSERT INTO public.order_restock_logs (
        refund_id, order_id, order_item_id, listing_id, variant_id,
        quantity_restored, outcome, note, approved_by, created_at
      ) VALUES (
        v_refund.id, v_order.id, v_plan_item.order_item_id, v_plan_item.listing_id, v_plan_item.variant_id,
        0, 'inventory_exception',
        CASE WHEN NOT FOUND THEN 'Listing no longer exists' ELSE 'Food or service item ineligible for restock' END,
        p_actor_id, v_now
      );
      CONTINUE;
    END IF;

    IF COALESCE(v_listing.has_variants, false) AND v_plan_item.variant_id IS NULL THEN
      v_any_exception := true;
      INSERT INTO public.order_restock_logs (
        refund_id, order_id, order_item_id, listing_id, variant_id,
        quantity_restored, outcome, note, approved_by, created_at
      ) VALUES (
        v_refund.id, v_order.id, v_plan_item.order_item_id, v_plan_item.listing_id, v_plan_item.variant_id,
        0, 'inventory_exception', 'Listing switched to variants; non-variant item incompatible', p_actor_id, v_now
      );
      CONTINUE;
    END IF;

    IF NOT COALESCE(v_listing.has_variants, false) AND v_plan_item.variant_id IS NOT NULL THEN
      v_any_exception := true;
      INSERT INTO public.order_restock_logs (
        refund_id, order_id, order_item_id, listing_id, variant_id,
        quantity_restored, outcome, note, approved_by, created_at
      ) VALUES (
        v_refund.id, v_order.id, v_plan_item.order_item_id, v_plan_item.listing_id, v_plan_item.variant_id,
        0, 'inventory_exception', 'Listing no longer uses variants; purchased variant incompatible', p_actor_id, v_now
      );
      CONTINUE;
    END IF;

    IF v_plan_item.variant_id IS NOT NULL THEN
      SELECT * INTO v_variant
      FROM public.listing_variants
      WHERE id = v_plan_item.variant_id AND listing_id = v_listing.id;

      IF NOT FOUND THEN
        v_any_exception := true;
        INSERT INTO public.order_restock_logs (
          refund_id, order_id, order_item_id, listing_id, variant_id,
          quantity_restored, outcome, note, approved_by, created_at
        ) VALUES (
          v_refund.id, v_order.id, v_plan_item.order_item_id, v_plan_item.listing_id, v_plan_item.variant_id,
          0, 'inventory_exception', 'Variant no longer exists or belongs to another listing', p_actor_id, v_now
        );
        CONTINUE;
      END IF;

      UPDATE public.listing_variants
      SET quantity = quantity + v_plan_item.restore_qty
      WHERE id = v_variant.id;
    END IF;

    UPDATE public.listings
    SET quantity = GREATEST(reserved_quantity, quantity + v_plan_item.restore_qty),
        updated_at = v_now
    WHERE id = v_listing.id;

    INSERT INTO public.order_restock_logs (
      refund_id, order_id, order_item_id, listing_id, variant_id,
      quantity_restored, outcome, note, approved_by, created_at
    ) VALUES (
      v_refund.id, v_order.id, v_plan_item.order_item_id, v_plan_item.listing_id, v_plan_item.variant_id,
      v_plan_item.restore_qty, 'restocked', 'Post-refund verified stock restoration', p_actor_id, v_now
    );
  END LOOP;

  UPDATE public.order_refunds r
  SET restock_status = CASE WHEN v_any_exception THEN 'inventory_exception' ELSE 'approved_restocked' END,
      restocked_at = v_now,
      updated_at = v_now
  WHERE r.id = v_refund.id;

  RETURN CASE WHEN v_any_exception THEN 'inventory_exception' ELSE 'approved_restocked' END;
END;
$$;

REVOKE ALL ON FUNCTION public.execute_approved_refund_restock_internal(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_approve_refund_restock_atomic(
  p_refund_id uuid,
  p_approve boolean,
  p_items jsonb DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_order public.orders;
  v_dispute public.order_disputes;
  v_refund public.order_refunds;
  v_plan jsonb := '[]'::jsonb;
  v_seen_items uuid[] := '{}'::uuid[];
  v_item_count integer := 0;
  v_item RECORD;
  v_oi public.order_items;
  v_listing public.listings;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY' USING ERRCODE = '42501';
  END IF;

  SELECT o.* INTO v_order
  FROM public.order_refunds r
  JOIN public.orders o ON o.id = r.order_id
  WHERE r.id = p_refund_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'REFUND_NOT_FOUND'; END IF;

  PERFORM 1 FROM public.profiles p WHERE p.id = v_order.seller_id FOR UPDATE;
  SELECT o.* INTO v_order FROM public.orders o WHERE o.id = v_order.id FOR UPDATE;
  SELECT d.* INTO v_dispute FROM public.order_disputes d
    WHERE d.id = (SELECT r0.dispute_id FROM public.order_refunds r0 WHERE r0.id = p_refund_id)
    FOR UPDATE;
  SELECT r.* INTO v_refund FROM public.order_refunds r WHERE r.id = p_refund_id FOR UPDATE;

  IF v_refund.restock_status IN ('approved_restocked', 'declined', 'inventory_exception', 'not_applicable') THEN
    RETURN v_refund.restock_status;
  END IF;

  IF v_refund.refund_type <> 'full_refund' THEN
    RAISE EXCEPTION 'RESTOCK_FULL_REFUND_ONLY';
  END IF;

  IF NOT COALESCE(p_approve, false) THEN
    UPDATE public.order_refunds r
    SET restock_status = 'declined',
        restock_plan = NULL,
        restock_approved_by = v_uid,
        updated_at = v_now
    WHERE r.id = v_refund.id;
    RETURN 'declined';
  END IF;

  IF v_dispute.previous_order_status IN ('handed_over', 'completed') OR v_order.handed_over_at IS NOT NULL THEN
    IF v_refund.return_status <> 'return_confirmed' OR v_refund.item_condition <> 'resellable' THEN
      RAISE EXCEPTION 'RESTOCK_REQUIRES_RESELLABLE_RETURN';
    END IF;
  END IF;

  IF v_refund.item_condition IN ('damaged', 'missing') THEN
    RAISE EXCEPTION 'RESTOCK_UNSUITABLE_CONDITION';
  END IF;

  SELECT COUNT(*)::integer INTO v_item_count
  FROM public.order_items oi WHERE oi.order_id = v_order.id;

  IF p_items IS NULL AND v_item_count > 1 THEN
    RAISE EXCEPTION 'EXPLICIT_MULTI_ITEM_RESTOCK_REQUIRED';
  END IF;

  IF p_items IS NOT NULL THEN
    IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
      RAISE EXCEPTION 'INVALID_RESTOCK_ITEMS';
    END IF;
    FOR v_item IN
      SELECT
        (elem->>'order_item_id')::uuid AS order_item_id,
        (elem->>'quantity')::integer AS req_qty
      FROM jsonb_array_elements(p_items) elem
    LOOP
      IF v_item.order_item_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_RESTOCK_ORDER_ITEM';
      END IF;
      IF v_item.order_item_id = ANY(v_seen_items) THEN
        RAISE EXCEPTION 'DUPLICATE_RESTOCK_ORDER_ITEM';
      END IF;
      v_seen_items := array_append(v_seen_items, v_item.order_item_id);

      SELECT oi.* INTO v_oi
      FROM public.order_items oi
      WHERE oi.id = v_item.order_item_id AND oi.order_id = v_order.id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'INVALID_RESTOCK_ORDER_ITEM';
      END IF;
      IF v_item.req_qty IS NULL OR v_item.req_qty <= 0 OR v_item.req_qty > v_oi.quantity THEN
        RAISE EXCEPTION 'INVALID_RESTOCK_QUANTITY';
      END IF;
      IF COALESCE(v_oi.is_food, false) OR COALESCE(v_oi.is_service, false) THEN
        RAISE EXCEPTION 'FOOD_OR_SERVICE_NOT_RESTOCKABLE';
      END IF;
      SELECT l.* INTO v_listing FROM public.listings l WHERE l.id = v_oi.listing_id;
      IF FOUND AND (COALESCE(v_listing.is_food, false) OR lower(COALESCE(v_listing.kind, '')) = 'service') THEN
        RAISE EXCEPTION 'FOOD_OR_SERVICE_NOT_RESTOCKABLE';
      END IF;
      v_plan := v_plan || jsonb_build_array(
        jsonb_build_object('order_item_id', v_oi.id, 'quantity', v_item.req_qty)
      );
    END LOOP;
  ELSE
    FOR v_oi IN
      SELECT oi.* FROM public.order_items oi WHERE oi.order_id = v_order.id ORDER BY oi.id
    LOOP
      IF COALESCE(v_oi.is_food, false) OR COALESCE(v_oi.is_service, false) THEN
        RAISE EXCEPTION 'FOOD_OR_SERVICE_NOT_RESTOCKABLE';
      END IF;
      SELECT l.* INTO v_listing FROM public.listings l WHERE l.id = v_oi.listing_id;
      IF FOUND AND (COALESCE(v_listing.is_food, false) OR lower(COALESCE(v_listing.kind, '')) = 'service') THEN
        RAISE EXCEPTION 'FOOD_OR_SERVICE_NOT_RESTOCKABLE';
      END IF;
      v_plan := v_plan || jsonb_build_array(
        jsonb_build_object('order_item_id', v_oi.id, 'quantity', v_oi.quantity)
      );
    END LOOP;
  END IF;

  UPDATE public.order_refunds r
  SET restock_status = 'approved_pending_refund',
      restock_plan = v_plan,
      restock_approved_by = v_uid,
      updated_at = v_now
  WHERE r.id = v_refund.id;

  IF v_refund.status = 'succeeded' THEN
    RETURN public.execute_approved_refund_restock_internal(v_refund.id, v_uid);
  END IF;

  RETURN 'approved_pending_refund';
END;
$$;

REVOKE ALL ON FUNCTION public.admin_approve_refund_restock_atomic(uuid, boolean, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_approve_refund_restock_atomic(uuid, boolean, jsonb) TO authenticated;

COMMIT;
