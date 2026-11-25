-- Rollback-only Phase 10O verification for the SQL editor.
BEGIN;

-- BEGIN EXACT STANDALONE MIGRATION BODY
-- Phase 10O — Unified product and service order completion.
-- The verification script runs this exact body in a rollback-only transaction.

CREATE OR REPLACE FUNCTION public.is_order_completion_blocked(p_order_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.order_disputes d
    WHERE d.order_id = p_order_id
      AND (lower(COALESCE(d.status, '')) IN ('open', 'under_review')
           OR d.refund_execution_status IN ('pending_execution', 'failed'))
  ) OR EXISTS (
    SELECT 1 FROM public.order_refunds r
    WHERE r.order_id = p_order_id
      AND r.status IN ('pending_execution', 'awaiting_return', 'processing', 'failed', 'reconciliation_required')
  );
$function$;
REVOKE ALL ON FUNCTION public.is_order_completion_blocked(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.verify_order_pickup_pin_atomic(p_order_id uuid, p_pin text)
 RETURNS TABLE(outcome text, order_id uuid, status text, handed_over_at timestamp with time zone, failed_attempts integer, attempts_remaining integer, locked_until timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_order public.orders;
  v_now timestamptz;
  v_clean_pin text;
  v_payment_ok boolean := false;
  v_base_attempts integer := 0;
  v_new_attempts integer := 0;
  v_locked_until timestamptz := NULL;
  v_max_attempts CONSTANT integer := 5;
  v_lockout_window CONSTANT interval := interval '15 minutes';
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;

  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;

  SELECT o.* INTO v_order
  FROM public.orders o
  WHERE o.id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;

  IF v_order.seller_id <> v_uid OR v_order.buyer_id = v_uid THEN
    RAISE EXCEPTION 'FORBIDDEN_SELLER_ONLY' USING ERRCODE = '42501';
  END IF;

  v_now := clock_timestamp();

  IF v_order.status = 'handed_over' THEN
    RETURN QUERY SELECT
      'already_handed_over'::text, v_order.id, v_order.status, v_order.handed_over_at,
      COALESCE(v_order.pin_failed_attempts, 0), v_max_attempts, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_order.status = 'completed' THEN
    RETURN QUERY SELECT
      'already_completed'::text, v_order.id, v_order.status, v_order.handed_over_at,
      0, v_max_attempts, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_order.status = 'disputed' OR public.is_order_completion_blocked(v_order.id) THEN
    RETURN QUERY SELECT
      'order_disputed'::text, v_order.id, v_order.status, v_order.handed_over_at,
      COALESCE(v_order.pin_failed_attempts, 0),
      GREATEST(0, v_max_attempts - COALESCE(v_order.pin_failed_attempts, 0)),
      v_order.pin_locked_until;
    RETURN;
  END IF;

  IF v_order.status <> 'paid' THEN
    RETURN QUERY SELECT
      'invalid_status'::text, v_order.id, v_order.status, v_order.handed_over_at,
      COALESCE(v_order.pin_failed_attempts, 0),
      GREATEST(0, v_max_attempts - COALESCE(v_order.pin_failed_attempts, 0)),
      v_order.pin_locked_until;
    RETURN;
  END IF;

  IF v_order.paid_at IS NOT NULL THEN
    IF v_order.checkout_session_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1
        FROM public.checkout_sessions cs
        WHERE cs.id = v_order.checkout_session_id
          AND cs.buyer_id = v_order.buyer_id
          AND cs.status = 'paid'
          AND cs.payment_status = 'paid'
          AND cs.paid_at IS NOT NULL
      ) INTO v_payment_ok;
    ELSE
      SELECT EXISTS (
        SELECT 1
        FROM public.payments p
        WHERE p.order_id = v_order.id
          AND p.status = 'paid'
          AND p.verified_at IS NOT NULL
      ) INTO v_payment_ok;
    END IF;
  END IF;

  IF NOT v_payment_ok THEN
    RETURN QUERY SELECT
      'payment_unverified'::text, v_order.id, v_order.status, v_order.handed_over_at,
      COALESCE(v_order.pin_failed_attempts, 0),
      GREATEST(0, v_max_attempts - COALESCE(v_order.pin_failed_attempts, 0)),
      v_order.pin_locked_until;
    RETURN;
  END IF;

  IF v_order.pickup_pin IS NULL OR length(trim(v_order.pickup_pin)) <> 6 THEN
    RETURN QUERY SELECT
      'pin_unavailable'::text, v_order.id, v_order.status, v_order.handed_over_at,
      COALESCE(v_order.pin_failed_attempts, 0),
      GREATEST(0, v_max_attempts - COALESCE(v_order.pin_failed_attempts, 0)),
      v_order.pin_locked_until;
    RETURN;
  END IF;

  IF v_order.pin_locked_until IS NOT NULL AND v_now < v_order.pin_locked_until THEN
    RETURN QUERY SELECT
      'locked'::text, v_order.id, v_order.status, v_order.handed_over_at,
      COALESCE(v_order.pin_failed_attempts, v_max_attempts), 0, v_order.pin_locked_until;
    RETURN;
  END IF;

  IF v_order.pin_locked_until IS NOT NULL AND v_now >= v_order.pin_locked_until THEN
    v_base_attempts := 0;
  ELSE
    v_base_attempts := GREATEST(0, COALESCE(v_order.pin_failed_attempts, 0));
  END IF;

  v_clean_pin := trim(COALESCE(p_pin, ''));
  IF v_clean_pin !~ '^[0-9]{6}$' THEN
    RETURN QUERY SELECT
      'invalid_pin_format'::text, v_order.id, v_order.status, v_order.handed_over_at,
      v_base_attempts, GREATEST(0, v_max_attempts - v_base_attempts), NULL::timestamptz;
    RETURN;
  END IF;

  IF encode(sha256(convert_to(v_clean_pin, 'UTF8')), 'hex')
     <> encode(sha256(convert_to(v_order.pickup_pin, 'UTF8')), 'hex') THEN
    v_new_attempts := v_base_attempts + 1;
    IF v_new_attempts >= v_max_attempts THEN
      v_locked_until := v_now + v_lockout_window;
    ELSE
      v_locked_until := NULL;
    END IF;

    UPDATE public.orders o
    SET pin_failed_attempts = v_new_attempts,
        pin_locked_until = v_locked_until,
        updated_at = v_now
    WHERE o.id = v_order.id;

    RETURN QUERY SELECT
      CASE WHEN v_locked_until IS NOT NULL THEN 'locked' ELSE 'invalid_pin' END::text,
      v_order.id, v_order.status, v_order.handed_over_at,
      v_new_attempts, GREATEST(0, v_max_attempts - v_new_attempts), v_locked_until;
    RETURN;
  END IF;

  UPDATE public.orders o
  SET status = 'completed',
      handed_over_at = COALESCE(o.handed_over_at, v_now),
      completed_at = v_now,
      completed_method = 'pickup_pin',
      pickup_pin = NULL,
      pin_failed_attempts = 0,
      pin_locked_until = NULL,
      updated_at = v_now
  WHERE o.id = v_order.id;

  RETURN QUERY SELECT
    'completed'::text, v_order.id, 'completed'::text, COALESCE(v_order.handed_over_at, v_now), 0, v_max_attempts, NULL::timestamptz;
END;
$function$;

REVOKE ALL ON FUNCTION public.verify_order_pickup_pin_atomic(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_order_pickup_pin_atomic(uuid, text) TO authenticated;

-- Only existing handed-over orders can use the prior buyer confirmation.
CREATE OR REPLACE FUNCTION public.confirm_buyer_order_receipt_atomic(p_order_id uuid)
 RETURNS TABLE(outcome text, order_id uuid, status text, completed_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_order public.orders;
  v_now timestamptz;
  v_payment_ok boolean := false;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;

  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;

  SELECT o.* INTO v_order
  FROM public.orders o
  WHERE o.id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;

  IF v_order.buyer_id <> v_uid OR v_order.seller_id = v_uid THEN
    RAISE EXCEPTION 'FORBIDDEN_BUYER_ONLY' USING ERRCODE = '42501';
  END IF;

  IF v_order.status = 'completed' THEN
    RETURN QUERY SELECT
      'already_completed'::text, v_order.id, v_order.status, v_order.completed_at;
    RETURN;
  END IF;

  IF v_order.status = 'disputed' OR public.is_order_completion_blocked(v_order.id) THEN
    RETURN QUERY SELECT
      'order_disputed'::text, v_order.id, v_order.status, v_order.completed_at;
    RETURN;
  END IF;

  IF v_order.status <> 'handed_over' OR v_order.handed_over_at IS NULL THEN
    RETURN QUERY SELECT
      'invalid_status'::text, v_order.id, v_order.status, v_order.completed_at;
    RETURN;
  END IF;

  IF v_order.paid_at IS NOT NULL THEN
    IF v_order.checkout_session_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1
        FROM public.checkout_sessions cs
        WHERE cs.id = v_order.checkout_session_id
          AND cs.buyer_id = v_order.buyer_id
          AND cs.status = 'paid'
          AND cs.payment_status = 'paid'
          AND cs.paid_at IS NOT NULL
      ) INTO v_payment_ok;
    ELSE
      SELECT EXISTS (
        SELECT 1
        FROM public.payments p
        WHERE p.order_id = v_order.id
          AND p.status = 'paid'
          AND p.verified_at IS NOT NULL
      ) INTO v_payment_ok;
    END IF;
  END IF;

  IF NOT v_payment_ok THEN
    RETURN QUERY SELECT
      'payment_unverified'::text, v_order.id, v_order.status, v_order.completed_at;
    RETURN;
  END IF;

  v_now := clock_timestamp();

  UPDATE public.orders o
  SET status = 'completed',
      completed_at = v_now,
      completed_method = 'pickup_pin',
      pickup_pin = NULL,
      updated_at = v_now
  WHERE o.id = v_order.id;

  RETURN QUERY SELECT
    'completed'::text, v_order.id, 'completed'::text, v_now;
END;
$function$;

REVOKE ALL ON FUNCTION public.confirm_buyer_order_receipt_atomic(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_buyer_order_receipt_atomic(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.reveal_order_completion_pin(p_order_id uuid, p_acknowledged boolean)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_order public.orders;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() OR p_acknowledged IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PIN_REVEAL_NOT_AUTHORIZED' USING ERRCODE = '42501';
  END IF;

  SELECT o.* INTO v_order FROM public.orders o
  WHERE o.id = p_order_id AND o.buyer_id = v_uid AND o.seller_id <> v_uid
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PIN_REVEAL_NOT_AUTHORIZED' USING ERRCODE = '42501';
  END IF;

  IF v_order.status <> 'paid' OR v_order.pickup_pin IS NULL
     OR NOT public.is_order_payment_verified(v_order.id)
     OR public.is_order_completion_blocked(v_order.id) THEN
    RETURN NULL;
  END IF;

  RETURN v_order.pickup_pin;
END;
$function$;
REVOKE ALL ON FUNCTION public.reveal_order_completion_pin(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reveal_order_completion_pin(uuid, boolean) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.get_buyer_order_pickup_pins(uuid[]) FROM PUBLIC, anon, authenticated;

-- The application uses this capability to distinguish the installed lifecycle.
CREATE OR REPLACE FUNCTION public.get_order_completion_mode()
RETURNS text
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
  SELECT 'unified_pin_v1'::text;
$function$;
REVOKE ALL ON FUNCTION public.get_order_completion_mode() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_order_completion_mode() TO authenticated;

NOTIFY pgrst, 'reload schema';
-- END EXACT STANDALONE MIGRATION BODY

-- All mutable fixtures are generated for this transaction. Run as the database
-- owner in an isolated verification session. No gateway requests are made.
DO $verify$
DECLARE
  v_key text := 'verify10o_' || replace(gen_random_uuid()::text, '-', '');
  v_buyer uuid := gen_random_uuid();
  v_seller uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_product_category text;
  v_service_category text;
  v_area text;
  v_product uuid;
  v_service uuid;
  v_variant uuid;
  v_image text := v_seller::text || '/' || v_key || '/variant.jpg';
  v_cover text := v_seller::text || '/' || v_key || '/cover.jpg';
  v_cart_ids uuid[];
  v_checkout uuid;
  v_unpaid_checkout uuid;
  v_product_order uuid;
  v_service_order uuid;
  v_unpaid_order uuid;
  v_unverified_order uuid;
  v_legacy uuid;
  v_history uuid;
  v_blocked uuid;
  v_dispute uuid;
  v_refund public.order_refunds;
  v_claim record;
  v_result record;
  v_row public.orders;
  v_completed_at timestamptz;
  v_deadline timestamptz;
  v_lock_started timestamptz;
  v_history_at timestamptz := clock_timestamp() - interval '4 days';
  v_history_deadline timestamptz := v_history_at + interval '7 days';
  v_service_completed_at timestamptz;
  v_service_deadline timestamptz;
  v_pin_result text;
  v_return_rejected boolean := false;
  v_withdrawal_blocked boolean := false;
  v_provider_ref text;
  v_outcome text;
BEGIN
  IF public.get_order_completion_mode() IS DISTINCT FROM 'unified_pin_v1'
     OR has_column_privilege('authenticated', 'public.orders', 'pickup_pin', 'SELECT')
     OR has_function_privilege('authenticated', 'public.get_buyer_order_pickup_pins(uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.reveal_order_completion_pin(uuid,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Unexpected capability or PIN privileges';
  END IF;

  INSERT INTO auth.users (id, email, email_confirmed_at, raw_user_meta_data, raw_app_meta_data)
  VALUES (v_buyer, v_key || '_buyer@ums.edu.my', now(), '{"full_name":"Synthetic Buyer"}', '{}'),
         (v_seller, v_key || '_seller@iluv.ums.edu.my', now(), '{"full_name":"Synthetic Seller"}', '{}'),
         (v_other, v_key || '_other@iluv.ums.edu.my', now(), '{"full_name":"Synthetic Other"}', '{}'),
         (v_admin, v_key || '_admin@ums.edu.my', now(), '{"full_name":"Synthetic Admin"}', '{"is_admin":true}');

  UPDATE public.profiles SET status = 'active' WHERE id IN (v_buyer, v_seller, v_other, v_admin);

  SELECT id INTO STRICT v_product_category FROM public.categories WHERE active AND kind = 'product' ORDER BY id LIMIT 1;
  SELECT id INTO STRICT v_service_category FROM public.categories WHERE active AND kind = 'service' ORDER BY id LIMIT 1;
  SELECT id INTO STRICT v_area FROM public.collection_areas WHERE active ORDER BY id LIMIT 1;

  INSERT INTO public.listings (
    seller_id, kind, title, description, category_id, condition, price_sen, quantity,
    reserved_quantity, collection_area_id, has_variants, option_groups, variation_photo_group,
    allow_offers, availability_mode, image_paths, rules_acknowledged, status, published_at
  ) VALUES (
    v_seller, 'business', 'Synthetic Bottle', 'Rollback fixture for Phase 10O order completion.', v_product_category,
    'New/Unused', 2000, 3, 0, v_area, true, ARRAY['Colour'], 'Colour', false, 'ready',
    ARRAY[v_cover, v_image], true, 'published', now()
  ) RETURNING id INTO v_product;

  INSERT INTO public.listing_variants (listing_id, option_values, price_sen, quantity, reserved_quantity, active, image_path)
  VALUES (v_product, '{"Colour":"Teal"}', 2000, 3, 0, true, v_image) RETURNING id INTO v_variant;

  INSERT INTO public.listings (
    seller_id, kind, title, description, category_id, price_sen, quantity, reserved_quantity,
    allow_offers, has_variants, option_groups, availability_mode, accepting_requests, service_mode,
    rules_acknowledged, status, published_at
  ) VALUES (
    v_seller, 'service', 'Synthetic Design', 'Rollback fixture for Phase 10O service completion.', v_service_category,
    1500, 1, 0, false, false, ARRAY[]::text[], 'ready', true, 'remote', true, 'published', now()
  ) RETURNING id INTO v_service;

  WITH items AS (
    INSERT INTO public.cart_items (user_id, listing_id, variant_id, quantity)
    VALUES (v_buyer, v_product, v_variant, 1), (v_buyer, v_service, NULL, 1)
    RETURNING id
  )
  SELECT array_agg(id) INTO v_cart_ids FROM items;

  PERFORM set_config('request.jwt.claim.sub', v_buyer::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_buyer, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT id INTO STRICT v_checkout FROM public.create_cart_checkout_atomic(v_key || '_cart', NULL, v_cart_ids);
  RESET ROLE;

  UPDATE public.checkout_sessions SET bill_creation_state = 'ready', bill_code = v_key,
    bill_url = 'https://dev.toyyibpay.com/' || v_key WHERE id = v_checkout;
  v_outcome := public.confirm_checkout_payment_atomic(v_checkout, v_key, v_key || '_tx', 3600, '{"synthetic":true}');
  IF v_outcome IS DISTINCT FROM 'confirmed_paid'
     OR public.confirm_checkout_payment_atomic(v_checkout, v_key, v_key || '_tx', 3600, '{"synthetic":true}') IS DISTINCT FROM 'already_paid' THEN
    RAISE EXCEPTION 'Shared checkout or replay verification failed';
  END IF;

  SELECT o.id INTO STRICT v_product_order FROM public.orders o JOIN public.order_items i ON i.order_id = o.id
    WHERE o.checkout_session_id = v_checkout AND NOT i.is_service;
  SELECT o.id INTO STRICT v_service_order FROM public.orders o JOIN public.order_items i ON i.order_id = o.id
    WHERE o.checkout_session_id = v_checkout AND i.is_service;
  IF EXISTS (SELECT 1 FROM public.orders WHERE id IN (v_product_order, v_service_order)
      AND (pickup_pin IS NULL OR pickup_pin !~ '^[0-9]{6}$' OR status <> 'paid')) THEN
    RAISE EXCEPTION 'Payment did not issue six-digit PINs to paid child orders';
  END IF;
  -- Pin fixed, distinct values only after testing real issuance, so guessing and
  -- cross-order checks are deterministic even if random PINs happened to match.
  UPDATE public.orders SET pickup_pin = '012345' WHERE id = v_product_order;
  UPDATE public.orders SET pickup_pin = '123450' WHERE id = v_service_order;

  INSERT INTO public.checkout_sessions (
    checkout_code,buyer_id,source,idempotency_key,combined_subtotal_sen,fpx_fee_sen,total_paid_sen,payment_deadline
  ) VALUES (v_key || '_unpaid',v_buyer,'cart',v_key || '_unpaid',400,100,500,now()-interval '1 minute')
    RETURNING id INTO v_unpaid_checkout;

  INSERT INTO public.orders (
    order_code,buyer_id,seller_id,checkout_session_id,source,status,subtotal_sen,fpx_fee_sen,total_paid_sen,
    commission_sen,seller_net_sen,payment_deadline,pickup_pin,paid_at,handed_over_at,completed_at,protection_expires_at,idempotency_key
  )
  SELECT v_key || '_' || label,v_buyer,v_seller,checkout_id,'cart',status,200,0,200,4,196,
    now()+interval '15 minutes',pin,paid,handover,completed,expiry,v_key || '_' || label
  FROM (VALUES
    ('unpaid', v_unpaid_checkout, 'pending_payment', NULL::text, NULL::timestamptz, NULL::timestamptz, NULL::timestamptz, NULL::timestamptz),
    ('unverified', v_unpaid_checkout, 'paid', '774411', now(), NULL, NULL, NULL),
    ('legacy', v_checkout, 'handed_over', NULL, now(), now(), NULL, NULL),
    ('history', v_checkout, 'completed', NULL, v_history_at, v_history_at, v_history_at, v_history_deadline),
    ('blocked', v_checkout, 'paid', '567890', now(), NULL, NULL, NULL)
  ) AS fixtures(label,checkout_id,status,pin,paid,handover,completed,expiry);
  SELECT id INTO STRICT v_unpaid_order FROM public.orders WHERE order_code = v_key || '_unpaid';
  SELECT id INTO STRICT v_unverified_order FROM public.orders WHERE order_code = v_key || '_unverified';
  SELECT id INTO STRICT v_legacy FROM public.orders WHERE order_code = v_key || '_legacy';
  SELECT id INTO STRICT v_history FROM public.orders WHERE order_code = v_key || '_history';
  SELECT id INTO STRICT v_blocked FROM public.orders WHERE order_code = v_key || '_blocked';

  SELECT action INTO STRICT v_outcome FROM public.claim_checkout_bill_slot(v_unpaid_checkout);
  IF v_outcome IS DISTINCT FROM 'checkout_expired' THEN RAISE EXCEPTION 'Expired checkout can claim a payment bill'; END IF;
  UPDATE public.checkout_sessions SET payment_status = 'late_payment_review' WHERE id = v_unpaid_checkout;
  SELECT action INTO STRICT v_outcome FROM public.claim_checkout_bill_slot(v_unpaid_checkout);
  IF v_outcome IS DISTINCT FROM 'already_terminal' THEN RAISE EXCEPTION 'Under-review checkout can claim a payment bill'; END IF;

  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.reveal_order_completion_pin(v_product_order, false);
    RAISE EXCEPTION 'PIN was available without acknowledgement';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  v_pin_result := public.reveal_order_completion_pin(v_product_order, true);
  IF v_pin_result IS DISTINCT FROM '012345'
     OR public.reveal_order_completion_pin(v_unverified_order, true) IS NOT NULL THEN
    RAISE EXCEPTION 'Buyer reveal did not enforce verified payment and order ownership';
  END IF;
  BEGIN
    PERFORM public.submit_verified_review_atomic(v_product_order,v_product,NULL,5,'Synthetic premature review.');
    RAISE EXCEPTION 'Uncompleted order accepted a verified review';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'ORDER_NOT_ELIGIBLE_FOR_REVIEW' THEN RAISE; END IF;
  END;
  SELECT * INTO STRICT v_result FROM public.confirm_buyer_order_receipt_atomic(v_product_order);
  IF v_result.outcome IS DISTINCT FROM 'invalid_status' THEN RAISE EXCEPTION 'New order bypassed seller PIN'; END IF;
  SELECT * INTO STRICT v_result FROM public.confirm_buyer_order_receipt_atomic(v_legacy);
  IF v_result.outcome IS DISTINCT FROM 'completed' THEN RAISE EXCEPTION 'Legacy confirmation failed'; END IF;
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub', v_other::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.reveal_order_completion_pin(v_product_order, true);
    RAISE EXCEPTION 'Another buyer revealed the PIN';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.verify_order_pickup_pin_atomic(v_product_order, '012345');
    RAISE EXCEPTION 'Unrelated seller completed the order';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub', v_seller::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_seller, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.reveal_order_completion_pin(v_product_order, true);
    RAISE EXCEPTION 'Owning seller revealed the buyer PIN';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  SELECT * INTO STRICT v_result FROM public.verify_order_pickup_pin_atomic(v_unpaid_order, '774411');
  IF v_result.outcome IS DISTINCT FROM 'invalid_status' THEN RAISE EXCEPTION 'Unpaid order accepted a PIN'; END IF;
  SELECT * INTO STRICT v_result FROM public.verify_order_pickup_pin_atomic(v_unverified_order, '774411');
  IF v_result.outcome IS DISTINCT FROM 'payment_unverified' THEN RAISE EXCEPTION 'Paid label bypassed payment proof'; END IF;
  FOR n IN 1..5 LOOP
    IF n = 5 THEN v_lock_started := clock_timestamp(); END IF;
    SELECT * INTO STRICT v_result FROM public.verify_order_pickup_pin_atomic(v_product_order, '123450');
    IF v_result.outcome IS DISTINCT FROM (CASE WHEN n < 5 THEN 'invalid_pin' ELSE 'locked' END)
       OR v_result.failed_attempts IS DISTINCT FROM n OR v_result.attempts_remaining IS DISTINCT FROM 5-n THEN
      RAISE EXCEPTION 'Wrong/cross-order PIN counter or lockout failed at attempt %', n;
    END IF;
  END LOOP;
  SELECT * INTO STRICT v_result FROM public.verify_order_pickup_pin_atomic(v_product_order, '012345');
  IF v_result.outcome IS DISTINCT FROM 'locked' THEN RAISE EXCEPTION 'Correct PIN bypassed lockout'; END IF;
  RESET ROLE;
  SELECT * INTO STRICT v_row FROM public.orders WHERE id = v_product_order;
  IF v_row.status <> 'paid' OR v_row.pin_failed_attempts <> 5
     OR v_row.pin_locked_until NOT BETWEEN v_lock_started + interval '15 minutes'
                                       AND clock_timestamp() + interval '15 minutes' THEN
    RAISE EXCEPTION 'Five-attempt lockout was not persisted for fifteen minutes';
  END IF;
  UPDATE public.orders SET pin_locked_until = now() - interval '1 second' WHERE id = v_product_order;

  INSERT INTO public.order_disputes (order_id, opened_by, reason, dispute_code, status, previous_order_status)
  VALUES (v_blocked, v_buyer, 'Synthetic active dispute.', v_key || '_blocked', 'open', 'paid')
  RETURNING id INTO v_dispute;
  SET LOCAL ROLE authenticated;
  SELECT * INTO STRICT v_result FROM public.verify_order_pickup_pin_atomic(v_blocked, '567890');
  IF v_result.outcome IS DISTINCT FROM 'order_disputed' THEN RAISE EXCEPTION 'Active dispute did not block PIN'; END IF;
  RESET ROLE;
  UPDATE public.order_disputes SET status = 'resolved', refund_execution_status = 'pending_execution' WHERE id = v_dispute;
  SET LOCAL ROLE authenticated;
  SELECT * INTO STRICT v_result FROM public.verify_order_pickup_pin_atomic(v_blocked, '567890');
  IF v_result.outcome IS DISTINCT FROM 'order_disputed' THEN RAISE EXCEPTION 'Pending refund decision did not block PIN'; END IF;
  RESET ROLE;
  UPDATE public.order_disputes SET refund_execution_status = 'not_applicable' WHERE id = v_dispute;
  INSERT INTO public.order_refunds
    (refund_code,dispute_id,order_id,refund_type,refund_amount_sen,commission_reversal_sen,seller_deduction_sen,idempotency_key,status)
  VALUES (v_key || '_blocked',v_dispute,v_blocked,'partial_refund',100,2,98,v_key || '_blocked','reconciliation_required');
  SET LOCAL ROLE authenticated;
  SELECT * INTO STRICT v_result FROM public.verify_order_pickup_pin_atomic(v_blocked, '567890');
  IF v_result.outcome IS DISTINCT FROM 'order_disputed' THEN RAISE EXCEPTION 'Unreconciled refund did not block PIN'; END IF;

  SELECT * INTO STRICT v_result FROM public.verify_order_pickup_pin_atomic(v_product_order, '012345');
  IF v_result.outcome IS DISTINCT FROM 'completed' OR v_result.status IS DISTINCT FROM 'completed' THEN
    RAISE EXCEPTION 'Physical order did not go directly from paid to completed';
  END IF;
  RESET ROLE;
  SELECT * INTO STRICT v_row FROM public.orders WHERE id = v_product_order;
  v_completed_at := v_row.completed_at;
  v_deadline := v_row.protection_expires_at;
  IF v_row.handed_over_at IS NULL OR v_completed_at IS NULL OR v_row.completed_method IS DISTINCT FROM 'pickup_pin'
     OR v_deadline IS DISTINCT FROM v_completed_at + interval '72 hours' OR v_row.pickup_pin IS NOT NULL
     OR v_row.pin_failed_attempts <> 0 OR v_row.pin_locked_until IS NOT NULL THEN
    RAISE EXCEPTION 'Completion stamps, consumed PIN, counters or protection are incorrect';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.order_items WHERE order_id = v_product_order AND variant_id = v_variant
      AND variant_snapshot = '{"Colour":"Teal"}'::jsonb AND image_path = v_image AND unit_sen = 2000 AND quantity = 1)
     OR (SELECT status FROM public.orders WHERE id = v_service_order) IS DISTINCT FROM 'paid'
     OR (SELECT quantity FROM public.listing_variants WHERE id = v_variant) IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'Completion changed purchase snapshots, sibling order or inventory';
  END IF;

  SET LOCAL ROLE authenticated;
  SELECT * INTO STRICT v_result FROM public.verify_order_pickup_pin_atomic(v_product_order, '012345');
  IF v_result.outcome IS DISTINCT FROM 'already_completed' THEN RAISE EXCEPTION 'Duplicate completion was not idempotent'; END IF;
  SELECT * INTO STRICT v_result FROM public.verify_order_pickup_pin_atomic(v_history, '012345');
  IF v_result.outcome IS DISTINCT FROM 'already_completed' THEN RAISE EXCEPTION 'Historical completion was not preserved'; END IF;
  SELECT * INTO STRICT v_result FROM public.verify_order_pickup_pin_atomic(v_service_order, '123450');
  IF v_result.outcome IS DISTINCT FROM 'completed' THEN RAISE EXCEPTION 'Service order did not complete directly via PIN'; END IF;
  RESET ROLE;
  SELECT * INTO STRICT v_row FROM public.orders WHERE id = v_service_order;
  v_service_completed_at := v_row.completed_at;
  v_service_deadline := v_row.protection_expires_at;
  IF v_service_completed_at IS NULL OR v_service_deadline IS DISTINCT FROM v_service_completed_at + interval '72 hours'
     OR v_row.pickup_pin IS NOT NULL OR NOT EXISTS (SELECT 1 FROM public.order_items WHERE order_id = v_service_order AND is_service)
     OR NOT EXISTS (SELECT 1 FROM public.orders WHERE id = v_product_order AND completed_at = v_completed_at AND protection_expires_at = v_deadline)
     OR NOT EXISTS (SELECT 1 FROM public.orders WHERE id = v_history AND status = 'completed' AND completed_at = v_history_at AND protection_expires_at = v_history_deadline) THEN
    RAISE EXCEPTION 'Service protection or timestamp preservation failed';
  END IF;

  PERFORM public.upsert_seller_bank_account_secure(v_seller,'Maybank','Synthetic Holder','v1:rollback-fixture','1234','****1234');
  BEGIN
    PERFORM public.create_seller_withdrawal_atomic(v_seller, 200, v_key || '_wdr');
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'INSUFFICIENT_AVAILABLE_BALANCE' THEN RAISE; END IF;
    v_withdrawal_blocked := true;
  END;
  IF NOT v_withdrawal_blocked OR EXISTS (SELECT 1 FROM public.payout_allocations WHERE order_id IN (v_product_order,v_service_order)) THEN
    RAISE EXCEPTION 'Protection allowed premature withdrawal';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_buyer::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_buyer, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  IF public.reveal_order_completion_pin(v_product_order, true) IS NOT NULL THEN
    RAISE EXCEPTION 'Consumed PIN still revealed after completion';
  END IF;
  PERFORM public.submit_verified_review_atomic(v_product_order,v_product,NULL,5,'Synthetic verified review.');
  BEGIN
    PERFORM public.submit_verified_review_atomic(v_product_order,v_product,NULL,5,'Synthetic duplicate review.');
    RAISE EXCEPTION 'Duplicate review was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  SELECT id INTO STRICT v_dispute FROM public.open_order_dispute_atomic(v_history,'other','Synthetic historical protected dispute.',ARRAY[]::text[]);
  IF v_dispute IS NULL THEN RAISE EXCEPTION 'Seven-day protection was not honored'; END IF;
  RESET ROLE;
  IF NOT EXISTS (SELECT 1 FROM public.reviews WHERE order_id = v_product_order AND listing_id = v_product AND rating = 5) THEN
    RAISE EXCEPTION 'New completion did not enable verified reviews';
  END IF;

  -- Partial service refund must restore Completed without moving protection or inventory.
  SET LOCAL ROLE authenticated;
  SELECT id INTO STRICT v_dispute FROM public.open_order_dispute_atomic(v_service_order,'other','Synthetic service refund compatibility test.',ARRAY[]::text[]);
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.admin_resolve_order_dispute_atomic(v_dispute,'partial_refund',500,'Synthetic admin review',true,'Return to campus');
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'SERVICE_ORDER_RETURN_NOT_APPLICABLE' THEN RAISE; END IF;
    v_return_rejected := true;
  END;
  IF NOT v_return_rejected THEN RAISE EXCEPTION 'Service refund allowed physical return'; END IF;
  PERFORM public.admin_resolve_order_dispute_atomic(v_dispute,'partial_refund',500,'Synthetic admin review',false,NULL);
  RESET ROLE;
  SELECT * INTO STRICT v_refund FROM public.order_refunds WHERE dispute_id = v_dispute;
  SELECT * INTO STRICT v_claim FROM public.claim_order_refund_execution_atomic(v_refund.id, v_admin);
  IF v_claim.attempt_token IS NULL THEN RAISE EXCEPTION 'Could not claim simulated refund'; END IF;
  v_provider_ref := 'SIM-RFD-' || v_key;
  IF NOT public.record_provider_attempt_outcome_atomic(v_claim.attempt_token,'succeeded',v_provider_ref,NULL) THEN
    RAISE EXCEPTION 'Could not record simulated refund';
  END IF;
  PERFORM public.finalize_order_refund_atomic(v_refund.id,v_claim.attempt_token,'succeeded',v_provider_ref,NULL);
  IF NOT EXISTS (SELECT 1 FROM public.orders WHERE id = v_service_order AND status = 'completed'
        AND completed_at = v_service_completed_at AND protection_expires_at = v_service_deadline)
     OR NOT EXISTS (SELECT 1 FROM public.order_refunds WHERE id = v_refund.id AND status = 'succeeded'
        AND refund_amount_sen = 500 AND commission_reversal_sen = 10 AND seller_deduction_sen = 490
        AND NOT return_required AND restock_status = 'not_applicable')
     OR EXISTS (SELECT 1 FROM public.order_restock_logs WHERE refund_id = v_refund.id) THEN
    RAISE EXCEPTION 'Partial refund changed lifecycle, protection, accounting or physical inventory';
  END IF;

  -- Full physical refund after a completed handover preserves the recorded
  -- completion and protection, and does not restock when no plan was approved.
  PERFORM set_config('request.jwt.claim.sub', v_buyer::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_buyer, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT id INTO STRICT v_dispute FROM public.open_order_dispute_atomic(v_product_order,'other','Synthetic full product refund compatibility test.',ARRAY[]::text[]);
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM public.admin_resolve_order_dispute_atomic(v_dispute,'full_refund',NULL,'Synthetic full refund review',false,NULL);
  RESET ROLE;
  SELECT * INTO STRICT v_refund FROM public.order_refunds WHERE dispute_id = v_dispute;
  SELECT * INTO STRICT v_claim FROM public.claim_order_refund_execution_atomic(v_refund.id, v_admin);
  IF v_claim.attempt_token IS NULL THEN RAISE EXCEPTION 'Could not claim simulated full refund'; END IF;
  v_provider_ref := 'SIM-RFD-FULL-' || v_key;
  IF NOT public.record_provider_attempt_outcome_atomic(v_claim.attempt_token,'succeeded',v_provider_ref,NULL) THEN
    RAISE EXCEPTION 'Could not record simulated full refund';
  END IF;
  PERFORM public.finalize_order_refund_atomic(v_refund.id,v_claim.attempt_token,'succeeded',v_provider_ref,NULL);
  IF NOT EXISTS (SELECT 1 FROM public.orders WHERE id = v_product_order AND status = 'refunded'
        AND completed_at = v_completed_at AND protection_expires_at = v_deadline AND pickup_pin IS NULL)
     OR NOT EXISTS (SELECT 1 FROM public.order_refunds WHERE id = v_refund.id AND status = 'succeeded'
        AND refund_amount_sen = 2000 AND commission_reversal_sen = 40 AND seller_deduction_sen = 1960)
     OR (SELECT quantity FROM public.listing_variants WHERE id = v_variant) IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'Full refund changed protected timestamps, settlement accounting or unapproved stock';
  END IF;

  RAISE NOTICE 'Phase 10O verification passed. Synthetic fixtures and installed migration body are rolling back.';
END;
$verify$;

ROLLBACK;
