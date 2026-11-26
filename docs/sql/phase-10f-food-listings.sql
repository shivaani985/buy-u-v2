BEGIN;

ALTER TABLE public.listings ADD COLUMN IF NOT EXISTS packaged_food_acknowledged boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS food_event_closed_at timestamptz;
ALTER TABLE public.cart_items ADD COLUMN IF NOT EXISTS food_schedule jsonb;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS preorder_close_at timestamptz,
  ADD COLUMN IF NOT EXISTS pickup_window_end timestamptz,
  ADD COLUMN IF NOT EXISTS packaged_food_acknowledged boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.food_schedule(p_listing public.listings)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN p_listing.is_food AND p_listing.availability_mode = 'pre_order' THEN
    jsonb_build_array(p_listing.collection_area_id, extract(epoch from p_listing.preorder_close_at),
      extract(epoch from p_listing.pickup_window_start), extract(epoch from p_listing.pickup_window_end))
  END
$$;

CREATE OR REPLACE FUNCTION public.food_terms_valid(p_listing public.listings)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN NOT p_listing.is_food THEN true
    WHEN p_listing.availability_mode = 'ready' THEN p_listing.packaged_food_acknowledged
    ELSE COALESCE(p_listing.collection_area_id IS NOT NULL
      AND p_listing.preorder_close_at < p_listing.pickup_window_start
      AND p_listing.pickup_window_start < p_listing.pickup_window_end
      AND (p_listing.pickup_window_start AT TIME ZONE 'Asia/Kuala_Lumpur')::date =
          (p_listing.pickup_window_end AT TIME ZONE 'Asia/Kuala_Lumpur')::date,false)
  END
$$;

CREATE OR REPLACE FUNCTION public.guard_food_listing_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_preorder boolean := NEW.is_food AND NEW.availability_mode = 'pre_order';
  v_old_event boolean;
  v_closed boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_old_event := OLD.is_food AND OLD.availability_mode = 'pre_order'
      AND (OLD.published_at IS NOT NULL OR OLD.status = 'published');
    IF v_old_event THEN
      IF NOT v_preorder THEN RAISE EXCEPTION 'FOOD_EVENT_TYPE_LOCKED'; END IF;
      v_closed := OLD.food_event_closed_at IS NOT NULL OR OLD.preorder_close_at <= v_now;
      IF v_closed AND (public.food_schedule(NEW) IS DISTINCT FROM public.food_schedule(OLD)
        OR NEW.quantity > OLD.quantity OR NEW.reserved_quantity > OLD.reserved_quantity
        OR NEW.has_variants IS DISTINCT FROM OLD.has_variants
        OR (NEW.status = 'published' AND OLD.status <> 'published')) THEN
        RAISE EXCEPTION 'FOOD_EVENT_PERMANENTLY_CLOSED';
      END IF;
      IF (public.food_schedule(NEW) IS DISTINCT FROM public.food_schedule(OLD)
          OR NEW.has_variants IS DISTINCT FROM OLD.has_variants)
         AND (OLD.reserved_quantity > 0 OR EXISTS (
           SELECT 1 FROM public.order_items oi JOIN public.orders o ON o.id = oi.order_id
           WHERE oi.listing_id = OLD.id AND o.paid_at IS NOT NULL
         )) THEN RAISE EXCEPTION 'FOOD_EVENT_SCHEDULE_LOCKED'; END IF;
      NEW.published_at := COALESCE(OLD.published_at, NEW.published_at, v_now);
      NEW.food_event_closed_at := COALESCE(OLD.food_event_closed_at,
        CASE WHEN OLD.preorder_close_at <= v_now THEN OLD.preorder_close_at END,
        CASE WHEN NEW.food_event_closed_at IS NOT NULL THEN v_now END);
    ELSE
      IF v_preorder AND (OLD.reserved_quantity > 0 OR EXISTS (
        SELECT 1 FROM public.order_items oi JOIN public.orders o ON o.id=oi.order_id
        WHERE oi.listing_id=OLD.id AND o.paid_at IS NOT NULL
      )) THEN RAISE EXCEPTION 'FOOD_EVENT_TYPE_LOCKED'; END IF;
      NEW.food_event_closed_at := NULL;
    END IF;
  ELSE
    NEW.food_event_closed_at := NULL;
  END IF;
  IF v_preorder THEN NEW.packaged_food_acknowledged := false; END IF;
  IF NEW.is_food AND NEW.allow_offers THEN RAISE EXCEPTION 'FOOD_OFFERS_FORBIDDEN'; END IF;
  IF NEW.is_food AND NEW.status = 'published' THEN
    IF NOT public.food_terms_valid(NEW) AND (
      TG_OP = 'INSERT' OR OLD.status <> 'published'
      OR NEW.is_food IS DISTINCT FROM OLD.is_food
      OR NEW.availability_mode IS DISTINCT FROM OLD.availability_mode
      OR public.food_schedule(NEW) IS DISTINCT FROM public.food_schedule(OLD)
      OR NEW.packaged_food_acknowledged IS DISTINCT FROM OLD.packaged_food_acknowledged
    ) THEN RAISE EXCEPTION 'FOOD_CLASSIFICATION_REQUIRED'; END IF;
    IF v_preorder AND (TG_OP = 'INSERT' OR OLD.status <> 'published') AND NEW.quantity < 1 THEN
      RAISE EXCEPTION 'FOOD_CAPACITY_REQUIRED';
    END IF;
    IF v_preorder AND (TG_OP = 'INSERT' OR OLD.status <> 'published'
      OR NOT COALESCE(v_old_event,false) OR public.food_schedule(NEW) IS DISTINCT FROM public.food_schedule(OLD))
      AND (NEW.preorder_close_at IS NULL OR NEW.preorder_close_at <= v_now)
    THEN RAISE EXCEPTION 'FOOD_ORDER_CUTOFF_INVALID'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_food_listing_event ON public.listings;
CREATE TRIGGER trg_guard_food_listing_event BEFORE INSERT OR UPDATE ON public.listings
FOR EACH ROW EXECUTE FUNCTION public.guard_food_listing_event();

CREATE OR REPLACE FUNCTION public.guard_food_variant_capacity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_listing public.listings;
  v_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.listing_id IS DISTINCT FROM OLD.listing_id AND EXISTS (
    SELECT 1 FROM public.listings l WHERE l.id IN (OLD.listing_id,NEW.listing_id)
    AND l.is_food AND l.availability_mode = 'pre_order'
  ) THEN RAISE EXCEPTION 'FOOD_COMMITTED_VARIANT'; END IF;
  v_id := CASE WHEN TG_OP = 'INSERT' THEN NEW.listing_id ELSE OLD.listing_id END;
  SELECT * INTO v_listing FROM public.listings WHERE id = v_id;
  IF NOT FOUND OR NOT v_listing.is_food OR v_listing.availability_mode <> 'pre_order' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO v_listing FROM public.listings WHERE id = v_id FOR UPDATE NOWAIT;
  IF v_listing.food_event_closed_at IS NOT NULL OR v_listing.preorder_close_at <= clock_timestamp() THEN
    IF TG_OP <> 'UPDATE' OR NEW.quantity > OLD.quantity OR NEW.reserved_quantity > OLD.reserved_quantity
      OR NEW.active IS DISTINCT FROM OLD.active
      OR NEW.option_values IS DISTINCT FROM OLD.option_values THEN RAISE EXCEPTION 'FOOD_EVENT_PERMANENTLY_CLOSED'; END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.reserved_quantity < OLD.reserved_quantity
    AND NEW.quantity = OLD.quantity - (OLD.reserved_quantity - NEW.reserved_quantity) THEN
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' AND EXISTS (
    SELECT 1 FROM public.order_items oi JOIN public.orders o ON o.id = oi.order_id
    WHERE oi.variant_id = OLD.id AND o.paid_at IS NOT NULL
  ) AND (TG_OP = 'DELETE' OR NEW.option_values IS DISTINCT FROM OLD.option_values OR NEW.listing_id IS DISTINCT FROM OLD.listing_id)
    THEN RAISE EXCEPTION 'FOOD_COMMITTED_VARIANT'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_food_variant_capacity ON public.listing_variants;
CREATE TRIGGER trg_guard_food_variant_capacity BEFORE INSERT OR UPDATE OR DELETE ON public.listing_variants
FOR EACH ROW EXECUTE FUNCTION public.guard_food_variant_capacity();

CREATE OR REPLACE FUNCTION public.close_food_preorder(p_listing_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.is_active_student() THEN RAISE EXCEPTION 'FORBIDDEN_ACTIVE_STUDENT_ONLY' USING ERRCODE='42501'; END IF;
  UPDATE public.listings SET food_event_closed_at = clock_timestamp()
  WHERE id = p_listing_id AND seller_id = auth.uid() AND is_food AND availability_mode = 'pre_order'
    AND status = 'published' AND food_event_closed_at IS NULL;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.close_food_preorder(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_food_preorder(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.guard_food_cart_schedule()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_listing public.listings;
  v_schedule jsonb;
BEGIN
  SELECT * INTO v_listing FROM public.listings WHERE id = NEW.listing_id FOR SHARE;
  IF NOT FOUND OR NOT v_listing.is_food THEN RETURN NEW; END IF;
  IF v_listing.status <> 'published' OR NOT public.food_terms_valid(v_listing)
     OR (v_listing.availability_mode = 'pre_order' AND (
       v_listing.food_event_closed_at IS NOT NULL OR v_listing.preorder_close_at <= clock_timestamp()
     )) THEN RAISE EXCEPTION 'FOOD_UNAVAILABLE'; END IF;
  v_schedule := public.food_schedule(v_listing);
  IF TG_OP = 'INSERT' THEN NEW.food_schedule := v_schedule;
  ELSIF NEW.food_schedule IS DISTINCT FROM v_schedule THEN RAISE EXCEPTION 'FOOD_SCHEDULE_RECONFIRM';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_food_cart_schedule ON public.cart_items;
CREATE TRIGGER trg_guard_food_cart_schedule BEFORE INSERT OR UPDATE OF quantity,listing_id,variant_id,food_schedule
ON public.cart_items FOR EACH ROW EXECUTE FUNCTION public.guard_food_cart_schedule();

CREATE OR REPLACE FUNCTION public.reconfirm_food_cart_schedule(p_cart_item_id uuid,p_expected_schedule jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.is_active_member() THEN RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE='42501'; END IF;
  UPDATE public.cart_items ci SET food_schedule = public.food_schedule(l)
  FROM public.listings l WHERE l.id = ci.listing_id AND l.is_food AND l.availability_mode = 'pre_order'
    AND ci.id = p_cart_item_id AND ci.user_id = auth.uid()
    AND public.food_schedule(l) = p_expected_schedule;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.reconfirm_food_cart_schedule(uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reconfirm_food_cart_schedule(uuid,jsonb) TO authenticated;

-- Preserve the hosted Phase 10S/10V functions, changing only exact known fragments.
CREATE OR REPLACE FUNCTION pg_temp.food_replace(s text, old text, new text, occurrences integer DEFAULT 1)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  s := replace(s,E'\r\n',E'\n');
  old := replace(old,E'\r\n',E'\n');
  new := replace(new,E'\r\n',E'\n');
  IF (length(s) - length(replace(s,old,''))) / length(old) <> occurrences THEN
    RAISE EXCEPTION 'PHASE_10F_HOSTED_FUNCTION_CHANGED: %', old;
  END IF;
  RETURN replace(s,old,new);
END;
$$;

DO $food_checkout$
DECLARE
  s text := replace(pg_get_functiondef('public.create_cart_checkout_atomic(text,jsonb,uuid[])'::regprocedure),E'\r\n',E'\n');
  v_kind text := 'CASE WHEN l.kind = ''service'' THEN ''service'' ELSE ''product'' END';
  v_groups text := 'CASE WHEN l.kind = ''service'' THEN ''service'' WHEN l.is_food AND l.availability_mode = ''pre_order'' THEN ''food:'' || jsonb_build_array(l.collection_area_id,extract(epoch from l.pickup_window_start),extract(epoch from l.pickup_window_end))::text ELSE ''product'' END';
BEGIN
  IF position('FOOD_SCHEDULE_RECONFIRM' in s)=0 THEN
    s := pg_temp.food_replace(s,'  v_now timestamptz := now();',E'  v_now timestamptz := now();\n  v_food_deadline timestamptz;');
    s := pg_temp.food_replace(s,'SELECT ci.id, ci.listing_id, ci.variant_id, ci.quantity', 'SELECT ci.id, ci.listing_id, ci.variant_id, ci.quantity, ci.food_schedule');
    s := pg_temp.food_replace(s,$old$    IF COALESCE(v_listing.is_food, false) AND v_listing.availability_mode = 'pre_order' THEN
      RAISE EXCEPTION 'FOOD_PREORDER_NOT_ENABLED';
    END IF;$old$,$new$    IF v_listing.is_food THEN
      IF NOT public.food_terms_valid(v_listing) THEN RAISE EXCEPTION 'FOOD_CLASSIFICATION_REQUIRED'; END IF;
      IF v_listing.availability_mode = 'pre_order' THEN
        IF v_listing.food_event_closed_at IS NOT NULL OR v_listing.preorder_close_at <= clock_timestamp() THEN RAISE EXCEPTION 'FOOD_UNAVAILABLE'; END IF;
        IF v_ci.food_schedule IS DISTINCT FROM public.food_schedule(v_listing) THEN RAISE EXCEPTION 'FOOD_SCHEDULE_RECONFIRM'; END IF;
        v_food_deadline := least(v_food_deadline,v_listing.preorder_close_at);
      END IF;
    END IF;$new$);
    s := pg_temp.food_replace(s,$old$'pending_payment', v_now + interval '15 minutes'$old$,$new$'pending_payment', least(v_now + interval '15 minutes',v_food_deadline)$new$);
    s := pg_temp.food_replace(s,v_kind,v_groups,3);
    s := pg_temp.food_replace(s,$old$      WHEN v_group.fulfillment_kind = 'service' THEN v_key || ':svc'$old$,
      $new$      WHEN v_group.fulfillment_kind = 'service' THEN v_key || ':svc'
      WHEN v_group.fulfillment_kind LIKE 'food:%' THEN v_key || ':' || md5(v_group.fulfillment_kind)$new$);
    s := pg_temp.food_replace(s,'l.pickup_window_start, l.pickup_note,','l.pickup_window_start, l.pickup_window_end, l.preorder_close_at, l.packaged_food_acknowledged, l.pickup_note,');
    s := pg_temp.food_replace(s,'pickup_window_start, pickup_note,','pickup_window_start, pickup_window_end, preorder_close_at, packaged_food_acknowledged, pickup_note,');
    s := pg_temp.food_replace(s,'        v_ci.pickup_window_start,',E'        v_ci.pickup_window_start,\n        v_ci.pickup_window_end,\n        v_ci.preorder_close_at,\n        v_ci.packaged_food_acknowledged,');
    EXECUTE s;
  END IF;
END;
$food_checkout$;

DO $food_seller_and_payment$
DECLARE
  s text;
BEGIN
  s := replace(pg_get_functiondef('public.create_listing_with_variations_atomic(jsonb,jsonb)'::regprocedure),E'\r\n',E'\n');
  IF position('packaged_food_acknowledged' in s)=0 THEN
    s := pg_temp.food_replace(s,'availability_mode, preorder_close_at, pickup_window_start, pickup_window_end,','availability_mode, preorder_close_at, pickup_window_start, pickup_window_end, packaged_food_acknowledged,',2);
    s := pg_temp.food_replace(s,'      v_rec.pickup_window_end,',E'      v_rec.pickup_window_end,\n      COALESCE(v_rec.packaged_food_acknowledged,false),',2);
    EXECUTE s;
  END IF;
  s := replace(pg_get_functiondef('public.update_listing_atomic(uuid,timestamptz,jsonb,jsonb)'::regprocedure),E'\r\n',E'\n');
  IF position('packaged_food_acknowledged' in s)=0 THEN
    s := pg_temp.food_replace(s,$old$    preorder_close_at = nullif(p_payload->>'preorder_close_at', '')::timestamptz,$old$,
      $new$    packaged_food_acknowledged = coalesce((p_payload->>'packaged_food_acknowledged')::boolean,v_listing.packaged_food_acknowledged),
    preorder_close_at = nullif(p_payload->>'preorder_close_at', '')::timestamptz,$new$);
    EXECUTE s;
  END IF;
  s := replace(pg_get_functiondef('public.confirm_checkout_payment_atomic(uuid,text,text,integer,jsonb)'::regprocedure),E'\r\n',E'\n');
  IF position('food_event_closed_at' in s)=0 THEN
    s := pg_temp.food_replace(s,'  v_now timestamptz;',E'  v_now timestamptz;\n  v_food_on_time boolean := false;\n  v_verified_paid_at timestamptz;');
    s := pg_temp.food_replace(s,$old$  IF v_offer_released
     OR v_session.status IN ('expired', 'cancelled')
     OR v_now >= v_session.payment_deadline THEN$old$,$new$  -- Only the service-side verified provider lookup supplies this timestamp.
  IF v_session.source = 'cart' AND v_session.status = 'pending_payment'
    AND EXISTS (SELECT 1 FROM public.orders o JOIN public.order_items oi ON oi.order_id=o.id
       WHERE o.checkout_session_id=v_session.id AND oi.is_food AND oi.availability_mode='pre_order') THEN
    BEGIN
      v_verified_paid_at := (p_raw_callback->'verified_tx'->>'paidAt')::timestamptz;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
      v_verified_paid_at := NULL;
    END;
    v_food_on_time := COALESCE(v_verified_paid_at >= v_session.created_at
      AND v_verified_paid_at < v_session.payment_deadline AND v_verified_paid_at <= v_now,false);
  END IF;
  IF v_offer_released
     OR v_session.status IN ('expired', 'cancelled')
     OR (v_now >= v_session.payment_deadline AND NOT v_food_on_time) THEN$new$);
    s := pg_temp.food_replace(s,'  IF v_now >= v_session.payment_deadline','  IF (v_now >= v_session.payment_deadline AND NOT v_food_on_time)');
    s := pg_temp.food_replace(s,$old$  UPDATE public.checkout_sessions
  SET status = 'paid',$old$,$new$  UPDATE public.listings l
  SET food_event_closed_at = clock_timestamp()
  WHERE l.is_food AND l.availability_mode = 'pre_order' AND l.food_event_closed_at IS NULL
    AND (CASE WHEN l.has_variants THEN NOT EXISTS (
      SELECT 1 FROM public.listing_variants lv WHERE lv.listing_id=l.id AND lv.active AND lv.quantity>0
    ) ELSE l.quantity=0 END)
    AND EXISTS (
      SELECT 1 FROM public.order_items oi JOIN public.orders o ON o.id=oi.order_id
      WHERE o.checkout_session_id=v_session.id AND oi.listing_id=l.id
    );
  UPDATE public.checkout_sessions
  SET status = 'paid',$new$);
    EXECUTE s;
  END IF;
END;
$food_seller_and_payment$;

DO $food_refund$
DECLARE s text;
BEGIN
  s := replace(pg_get_functiondef('public.admin_approve_refund_restock_atomic(uuid,boolean,jsonb)'::regprocedure),E'\r\n',E'\n');
  IF position('packaged_food_acknowledged' in s)=0 THEN
    s := pg_temp.food_replace(s,'COALESCE(v_oi.is_food, false) OR', '(v_oi.is_food AND NOT v_oi.packaged_food_acknowledged) OR',2);
    s := pg_temp.food_replace(s,'COALESCE(v_listing.is_food, false) OR', '(v_listing.is_food AND (v_listing.availability_mode = ''pre_order'' OR NOT v_listing.packaged_food_acknowledged)) OR',2);
    EXECUTE s;
  END IF;
  s := replace(pg_get_functiondef('public.execute_approved_refund_restock_internal(uuid,uuid)'::regprocedure),E'\r\n',E'\n');
  IF position('packaged_food_acknowledged' in s)=0 THEN
    s := pg_temp.food_replace(s,'COALESCE(oi.is_food, false) AS snapshot_is_food','(oi.is_food AND NOT oi.packaged_food_acknowledged) AS snapshot_is_food');
    s := pg_temp.food_replace(s,'OR COALESCE(v_listing.is_food, false)','OR (v_listing.is_food AND (v_listing.availability_mode = ''pre_order'' OR NOT v_listing.packaged_food_acknowledged))');
    EXECUTE s;
  END IF;
END;
$food_refund$;

DO $food_chat$
DECLARE s text;
BEGIN
  s := replace(pg_get_functiondef('public.build_chat_context(uuid,text,uuid,uuid,uuid)'::regprocedure),E'\r\n',E'\n');
  IF position('foodPickupStart' in s)=0 THEN
    s := pg_temp.food_replace(s,$old$'title',v_listing.title,'imagePath',v_image,'variantId',p_variant,'variation',v_variant.option_values,$old$,
      $new$'title',v_listing.title,'imagePath',v_image,'variantId',p_variant,'variation',v_variant.option_values,
      'foodCutoff',CASE WHEN v_listing.is_food AND v_listing.availability_mode='pre_order' THEN v_listing.preorder_close_at END,
      'foodPickupStart',CASE WHEN v_listing.is_food AND v_listing.availability_mode='pre_order' THEN v_listing.pickup_window_start END,
      'foodPickupEnd',CASE WHEN v_listing.is_food AND v_listing.availability_mode='pre_order' THEN v_listing.pickup_window_end END,$new$);
    EXECUTE s;
  END IF;
  s := replace(pg_get_functiondef('public.present_chat_context(jsonb,uuid,uuid)'::regprocedure),E'\r\n',E'\n');
  IF position('food_event_closed_at' in s)=0 THEN
    s := pg_temp.food_replace(s,$old$IF v_listing.is_food AND v_listing.availability_mode = 'pre_order' AND v_listing.preorder_close_at <= now() THEN$old$,
      $new$IF v_listing.is_food AND NOT public.food_terms_valid(v_listing) THEN
          v_result := v_result || jsonb_build_object('availability','Food details required');
        ELSIF v_listing.is_food AND v_listing.availability_mode = 'pre_order' AND
          (v_listing.food_event_closed_at IS NOT NULL OR v_listing.preorder_close_at <= now()) THEN$new$);
    EXECUTE s;
  END IF;
END;
$food_chat$;

COMMIT;
