-- Phase 10M rollback verification. Run as database owner after earlier accepted phases.
BEGIN;

DO $fixtures$
DECLARE
  k text := substr(replace(gen_random_uuid()::text,'-',''),1,12);
  buyer uuid := gen_random_uuid();
  seller uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  conv uuid := gen_random_uuid();
  listing uuid := gen_random_uuid();
  variant uuid := gen_random_uuid();
  service uuid := gen_random_uuid();
  second_listing uuid := gen_random_uuid();
  wrong_variant uuid := gen_random_uuid();
  purchase uuid := gen_random_uuid();
  other_purchase uuid := gen_random_uuid();
  item uuid := gen_random_uuid();
  other_item uuid := gen_random_uuid();
  notice uuid := gen_random_uuid();
  legacy uuid := gen_random_uuid();
  cat text;
  service_cat text;
  area text;
BEGIN
  SELECT id INTO STRICT cat FROM public.categories WHERE kind = 'product' AND active LIMIT 1;
  SELECT id INTO STRICT service_cat FROM public.categories WHERE kind = 'service' AND active LIMIT 1;
  SELECT id INTO STRICT area FROM public.collection_areas WHERE active LIMIT 1;
  INSERT INTO auth.users (id,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,aud,role,created_at,updated_at)
  SELECT uid,label || k || '@iluv.ums.edu.my','x',now(),'{}','{}','authenticated','authenticated',now(),now()
    FROM (VALUES (buyer,'m_buyer_'),(seller,'m_seller_'),(outsider,'m_other_')) AS fixture(uid,label);
  INSERT INTO public.profiles (id,email,full_name,display_name,university_role,status)
  SELECT uid,label || k || '@iluv.ums.edu.my',label,label,'student','active'
    FROM (VALUES (buyer,'m_buyer_'),(seller,'m_seller_'),(outsider,'m_other_')) AS fixture(uid,label)
  ON CONFLICT (id) DO UPDATE SET status = 'active', university_role = 'student';

  INSERT INTO public.listings (id,seller_id,title,description,kind,category_id,collection_area_id,condition,price_sen,
    quantity,has_variants,option_groups,variation_photo_group,image_paths,rules_acknowledged,status,published_at,allow_offers)
  VALUES
    (listing,seller,'Fixture campus perfume','Synthetic campus perfume description.','business',cat,area,'New/Unused',1500,
      5,true,ARRAY['Scent'],'Scent',ARRAY['cover.jpg','variant.jpg'],true,'published',now(),true),
    (second_listing,outsider,'Fixture other item','Synthetic other listing description.','business',cat,area,'New/Unused',2300,
      5,true,ARRAY['Colour'],'Colour',ARRAY['other.jpg'],true,'published',now(),true),
    (service,seller,'Fixture campus service','Synthetic campus service description.','service',service_cat,area,NULL,3500,
      1,false,'{}',NULL,ARRAY['service.jpg'],true,'published',now(),false);
  INSERT INTO public.listing_variants (id,listing_id,option_values,price_sen,quantity,active,image_path) VALUES
    (variant,listing,'{"Scent":"Hawas Fire"}',1700,5,true,'variant.jpg'),
    (gen_random_uuid(),listing,'{"Scent":"Hawas Ice"}',2200,2,true,NULL),
    (wrong_variant,second_listing,'{"Colour":"Blue"}',2300,5,true,'other.jpg');

  INSERT INTO public.orders (id,order_code,buyer_id,seller_id,source,subtotal_sen,fpx_fee_sen,total_paid_sen,
    commission_sen,seller_net_sen,status,payment_deadline,paid_at,completed_at)
  VALUES (purchase,'BU-M-' || k,buyer,seller,'cart',4500,100,4600,90,4410,'completed',now(),now(),now()),
         (other_purchase,'BU-M-X-' || k,buyer,outsider,'cart',2300,100,2400,46,2254,'completed',now(),now(),now());
  INSERT INTO public.order_items (id,order_id,listing_id,variant_id,title_snapshot,variant_snapshot,unit_sen,quantity,image_path)
  VALUES (item,purchase,listing,variant,'Historical perfume','{"Scent":"Hawas Fire"}',1500,2,'saved-cover.jpg'),
         (gen_random_uuid(),purchase,listing,NULL,'Other purchased item',NULL,1500,1,NULL),
         (other_item,other_purchase,second_listing,wrong_variant,'Unrelated item','{"Colour":"Blue"}',2300,1,'other.jpg');

  INSERT INTO public.free_notices (id,contributor_id,title,description,condition,image_paths,status,pickup_location,expires_at)
  VALUES (notice,seller,'Fixture giveaway books','','Good',ARRAY[seller::text || '/' || k || '/free.jpg'],
    'active','Block Alpha, level 2',now()+interval '3 days');

  INSERT INTO public.conversations (id,member_a,member_b) VALUES (conv,least(buyer,seller),greatest(buyer,seller));
  INSERT INTO public.messages (id,conversation_id,sender_id,body,order_id) VALUES
    (legacy,conv,buyer,'Existing order-system greeting',purchase);
  PERFORM set_config('buyu.verify_10m',json_build_object(
    'buyer',buyer,'seller',seller,'outsider',outsider,'conv',conv,'listing',listing,'variant',variant,
    'service',service,'second_listing',second_listing,'wrong_variant',wrong_variant,'purchase',purchase,
    'other_purchase',other_purchase,'item',item,'other_item',other_item,'notice',notice,'legacy',legacy
  )::text,true);
END;
$fixtures$;

-- BEGIN EMBEDDED MIGRATION BODY

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS context_ref jsonb;

-- Keep private snapshots out of WAL events, independent of subscriber grants.
DO $message_publication$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_publication_rel r
    JOIN pg_catalog.pg_publication p ON p.oid = r.prpubid
    WHERE p.pubname = 'supabase_realtime' AND r.prrelid = 'public.messages'::regclass
      AND r.prqual IS NULL
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_publication_tables
    WHERE schemaname = 'public' AND tablename = 'messages' AND pubname <> 'supabase_realtime'
  ) THEN
    RAISE EXCEPTION 'UNEXPECTED_CHAT_PUBLICATION';
  END IF;
END;
$message_publication$;

ALTER PUBLICATION supabase_realtime DROP TABLE public.messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.messages (
  id, conversation_id, sender_id, body, image_paths, listing_id, order_id,
  free_notice_id, service_request_id, edited_at, created_at
);

-- Historical private snapshots are available only through the participant projection.
REVOKE SELECT, INSERT ON public.messages FROM PUBLIC, anon, authenticated;
REVOKE SELECT (context_ref) ON public.messages FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.messages TO service_role;
GRANT SELECT (id, conversation_id, sender_id, body, image_paths, listing_id, order_id,
  free_notice_id, service_request_id, edited_at, created_at) ON public.messages TO authenticated;

CREATE OR REPLACE FUNCTION public.chat_context_write_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.context_ref IS DISTINCT FROM OLD.context_ref THEN
      RAISE EXCEPTION 'IMMUTABLE_CHAT_CONTEXT' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.context_ref IS NOT NULL AND current_user NOT IN ('postgres','service_role') THEN
    RAISE EXCEPTION 'USE_CONTEXT_MESSAGE_RPC' USING ERRCODE = '42501';
  END IF;
  IF NEW.context_ref IS NULL AND btrim(NEW.body) = '' AND cardinality(NEW.image_paths) = 0 THEN
    RAISE EXCEPTION 'EMPTY_CHAT_MESSAGE';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_chat_context_write_guard ON public.messages;
CREATE TRIGGER trg_chat_context_write_guard BEFORE INSERT OR UPDATE ON public.messages
FOR EACH ROW EXECUTE FUNCTION public.chat_context_write_guard();

-- Serialize creation by unordered pair without rewriting historical conversations.
CREATE OR REPLACE FUNCTION public.open_contextual_conversation(p_peer uuid, p_order uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_a uuid := least(v_uid, p_peer);
  v_b uuid := greatest(v_uid, p_peer);
  v_id uuid;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() OR p_peer IS NULL OR v_uid = p_peer
     OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_peer AND status = 'active') THEN
    RAISE EXCEPTION 'CHAT_UNAVAILABLE' USING ERRCODE = '42501';
  END IF;
  IF public.internal_is_blocked_between(v_uid, p_peer) AND NOT EXISTS (
    SELECT 1 FROM public.orders o WHERE o.id = p_order AND o.status IN ('paid','handed_over','disputed')
      AND ((o.buyer_id = v_uid AND o.seller_id = p_peer) OR (o.seller_id = v_uid AND o.buyer_id = p_peer))
      AND public.is_order_payment_verified(o.id)
  ) THEN RAISE EXCEPTION 'INTERACTION_BLOCKED' USING ERRCODE = '42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('chat-pair:' || v_a || ':' || v_b, 0));
  SELECT c.id INTO v_id FROM public.conversations c
  WHERE (c.member_a = v_a AND c.member_b = v_b) OR (c.member_a = v_b AND c.member_b = v_a)
  ORDER BY (c.member_a = v_a) DESC, c.created_at, c.id LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  BEGIN
    INSERT INTO public.conversations (member_a, member_b) VALUES (v_a, v_b) RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT c.id INTO STRICT v_id FROM public.conversations c WHERE c.member_a = v_a AND c.member_b = v_b;
  END;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.build_chat_context(
  p_conversation uuid, p_kind text, p_target uuid, p_variant uuid, p_item uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_peer uuid;
  v_listing public.listings;
  v_variant public.listing_variants;
  v_order public.orders;
  v_item public.order_items;
  v_notice public.free_notices;
  v_price_min integer;
  v_price_max integer;
  v_qty integer;
  v_image text;
  v_base jsonb := jsonb_build_object('version', 1, 'kind', p_kind, 'targetId', p_target);
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() THEN
    RAISE EXCEPTION 'CHAT_UNAVAILABLE' USING ERRCODE = '42501';
  END IF;
  SELECT CASE WHEN c.member_a = v_uid THEN c.member_b ELSE c.member_a END INTO v_peer
  FROM public.conversations c WHERE c.id = p_conversation AND v_uid IN (c.member_a,c.member_b);
  IF NOT FOUND THEN RAISE EXCEPTION 'CHAT_UNAVAILABLE' USING ERRCODE = '42501'; END IF;

  IF p_target IS NULL OR p_kind IS NULL OR p_kind NOT IN ('product','service','order','free')
     OR (p_item IS NOT NULL AND p_kind <> 'order')
     OR (p_variant IS NOT NULL AND p_kind NOT IN ('product','service')) THEN
    RAISE EXCEPTION 'INVALID_CHAT_REFERENCE';
  END IF;
  IF p_kind <> 'order' AND public.internal_is_blocked_between(v_uid, v_peer) THEN
    RAISE EXCEPTION 'INTERACTION_BLOCKED' USING ERRCODE = '42501';
  END IF;

  IF p_kind IN ('product','service') THEN
    SELECT l.* INTO v_listing FROM public.listings l JOIN public.profiles p ON p.id = l.seller_id
    WHERE l.id = p_target AND l.seller_id = v_peer AND l.status = 'published' AND p.status = 'active'
      AND (l.kind = 'service') = (p_kind = 'service') FOR SHARE OF l, p;
    IF NOT FOUND THEN RAISE EXCEPTION 'CHAT_REFERENCE_UNAVAILABLE' USING ERRCODE = '42501'; END IF;
    v_image := v_listing.image_paths[1];
    IF p_variant IS NOT NULL THEN
      SELECT lv.* INTO v_variant FROM public.listing_variants lv
      WHERE lv.id = p_variant AND lv.listing_id = p_target AND lv.active AND v_listing.has_variants FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_CHAT_VARIATION'; END IF;
      v_price_min := v_variant.price_sen;
      v_price_max := v_variant.price_sen;
      v_image := COALESCE(NULLIF(btrim(v_variant.image_path), ''), v_image);
    ELSIF v_listing.has_variants THEN
      SELECT min(lv.price_sen), max(lv.price_sen) INTO v_price_min, v_price_max
      FROM public.listing_variants lv WHERE lv.listing_id = p_target AND lv.active;
    END IF;
    RETURN jsonb_strip_nulls(v_base || jsonb_build_object(
      'title',v_listing.title,'imagePath',v_image,'variantId',p_variant,'variation',v_variant.option_values,
      'priceMinSen',COALESCE(v_price_min,v_listing.price_sen),'priceMaxSen',COALESCE(v_price_max,v_listing.price_sen)
    ));
  ELSIF p_kind = 'free' THEN
    SELECT n.* INTO v_notice FROM public.free_notices n JOIN public.profiles p ON p.id = n.contributor_id
    WHERE n.id = p_target AND n.contributor_id = v_peer AND p.status = 'active'
      AND n.status = 'active' AND n.expires_at > now() AND n.pickup_location IS NOT NULL FOR SHARE OF n, p;
    IF NOT FOUND THEN RAISE EXCEPTION 'CHAT_REFERENCE_UNAVAILABLE' USING ERRCODE = '42501'; END IF;
    RETURN jsonb_strip_nulls(v_base || jsonb_build_object('title',v_notice.title,
      'imagePath',v_notice.image_paths[1],'pickup',v_notice.pickup_location));
  END IF;

  SELECT o.* INTO v_order FROM public.orders o WHERE o.id = p_target
    AND ((o.buyer_id = v_uid AND o.seller_id = v_peer) OR (o.seller_id = v_uid AND o.buyer_id = v_peer)) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CHAT_REFERENCE_UNAVAILABLE' USING ERRCODE = '42501'; END IF;
  IF public.internal_is_blocked_between(v_uid, v_peer)
     AND (v_order.status NOT IN ('paid','handed_over','disputed') OR NOT public.is_order_payment_verified(p_target)) THEN
    RAISE EXCEPTION 'INTERACTION_BLOCKED' USING ERRCODE = '42501';
  END IF;
  v_base := v_base || jsonb_build_object('code',v_order.order_code,'orderStatus',v_order.status);
  IF p_item IS NULL THEN
    SELECT COALESCE(sum(oi.quantity), 0)::integer INTO v_qty FROM public.order_items oi WHERE oi.order_id = p_target;
    RETURN v_base || jsonb_build_object('title','Order ' || v_order.order_code,'quantity',v_qty,'priceMinSen',v_order.subtotal_sen);
  END IF;

  SELECT oi.* INTO v_item FROM public.order_items oi WHERE oi.id = p_item AND oi.order_id = p_target FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_CHAT_ORDER_ITEM' USING ERRCODE = '42501'; END IF;
  v_image := NULLIF(btrim(v_item.image_path), '');
  IF v_image IS NULL AND NOT v_item.is_service THEN
    SELECT NULLIF(btrim(o.variant_image_path), '') INTO v_image FROM public.offers o
    WHERE o.order_id = p_target AND o.status = 'accepted' AND o.listing_id = v_item.listing_id
      AND o.variant_id = v_item.variant_id ORDER BY o.id LIMIT 1;
    IF v_image IS NULL THEN
      SELECT NULLIF(btrim(lv.image_path), '') INTO v_image FROM public.listing_variants lv
      WHERE lv.listing_id = v_item.listing_id AND lv.id = v_item.variant_id;
      IF NOT FOUND AND jsonb_typeof(v_item.variant_snapshot) = 'object' THEN
        SELECT NULLIF(btrim(lv.image_path), '') INTO v_image FROM public.listing_variants lv
        WHERE lv.listing_id = v_item.listing_id AND NULLIF(btrim(lv.image_path),'') IS NOT NULL
          AND (SELECT jsonb_object_agg(lower(btrim(k)),lower(btrim(v))) FROM jsonb_each_text(lv.option_values) AS opts(k,v))
            = (SELECT jsonb_object_agg(lower(btrim(k)),lower(btrim(v))) FROM jsonb_each_text(v_item.variant_snapshot) AS opts(k,v))
        ORDER BY lv.id LIMIT 1;
      END IF;
    END IF;
  END IF;
  IF v_image IS NULL THEN
    SELECT l.image_paths[1] INTO v_image FROM public.listings l WHERE l.id = v_item.listing_id;
  END IF;
  RETURN jsonb_strip_nulls(v_base || jsonb_build_object(
    'title',v_item.title_snapshot,'itemId',p_item,'listingId',v_item.listing_id,'imagePath',v_image,
    'variation',v_item.variant_snapshot,'quantity',v_item.quantity,'priceMinSen',v_item.unit_sen
  ));
END;
$$;

CREATE OR REPLACE FUNCTION public.present_chat_context(p_context jsonb, p_viewer uuid, p_message uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_kind text := p_context->>'kind';
  v_target uuid := (p_context->>'targetId')::uuid;
  v_result jsonb := p_context;
  v_listing public.listings;
  v_notice public.free_notices;
  v_order public.orders;
  v_stock integer;
  v_profile_active boolean;
  v_state text;
BEGIN
  IF v_kind IN ('product','service') THEN
    SELECT l.* INTO v_listing FROM public.listings l WHERE l.id = v_target;
    IF FOUND THEN
      SELECT p.status = 'active' INTO v_profile_active FROM public.profiles p WHERE p.id = v_listing.seller_id;
    END IF;
    IF v_listing.id IS NULL OR v_listing.status <> 'published' OR v_profile_active IS NOT TRUE THEN
      v_state := CASE WHEN v_kind = 'product' THEN 'Product Unavailable' ELSE 'Service Unavailable' END;
      v_result := v_result - ARRAY['title','imagePath','variation','priceMinSen','priceMaxSen'];
    ELSE
      IF v_kind = 'service' AND NOT v_listing.accepting_requests THEN
        v_result := v_result || jsonb_build_object('availability','Not accepting requests');
      ELSIF v_kind = 'product' THEN
        v_stock := v_listing.quantity - v_listing.reserved_quantity;
        IF v_listing.has_variants THEN
          SELECT COALESCE(sum(greatest(lv.quantity - lv.reserved_quantity,0)),0)::integer INTO v_stock
          FROM public.listing_variants lv WHERE lv.listing_id = v_target AND lv.active
            AND (p_context->>'variantId' IS NULL OR lv.id = (p_context->>'variantId')::uuid);
        END IF;
        IF v_listing.kind IN ('pre_loved','business') AND NOT v_listing.is_food
           AND v_listing.availability_mode <> 'pre_order' AND v_listing.allow_offers AND v_stock > 0
           AND p_viewer <> v_listing.seller_id
           AND NOT public.internal_is_blocked_between(p_viewer,v_listing.seller_id) THEN
          v_result := v_result || jsonb_build_object('canBargain',true);
        END IF;
        IF v_listing.is_food AND v_listing.availability_mode = 'pre_order' AND v_listing.preorder_close_at <= now() THEN
          v_result := v_result || jsonb_build_object('availability','Pre-order closed');
        ELSIF v_stock <= 0 THEN
          v_result := v_result || jsonb_build_object('availability','Out of stock');
        END IF;
      END IF;
      v_result := v_result || jsonb_build_object('href','/listings/' || v_target);
    END IF;
  ELSIF v_kind = 'free' THEN
    v_result := v_result - ARRAY['imagePath','pickup'];
    SELECT n.* INTO v_notice FROM public.free_notices n JOIN public.profiles p ON p.id = n.contributor_id
    WHERE n.id = v_target AND p.status = 'active';
    IF v_notice.id IS NULL OR v_notice.status = 'hidden' THEN
      v_state := 'Free Item Removed';
      v_result := v_result - 'title';
    ELSIF v_notice.status = 'closed' THEN
      v_state := 'Free Item Removed';
    ELSIF v_notice.expires_at <= now() THEN
      v_state := 'Free Item Expired';
    ELSIF v_notice.status = 'active' AND v_notice.pickup_location IS NOT NULL THEN
      v_result := v_result || jsonb_build_object(
        'href','/free-items?post=' || v_target || '#post-' || v_target,
        'expiresAt',v_notice.expires_at,
        'pickup',CASE WHEN p_context->>'pickup' = v_notice.pickup_location THEN v_notice.pickup_location END,
        'imageUrl',CASE WHEN p_context->>'imagePath' = ANY(v_notice.image_paths)
          THEN CASE WHEN p_message IS NULL THEN '/api/free-items/photo?post=' || v_target || '&index=0'
            ELSE '/api/messages/context-photo?message=' || p_message END END
      );
    ELSE
      v_state := 'Free Item Removed';
    END IF;
  ELSIF v_kind = 'order' THEN
    SELECT o.* INTO v_order FROM public.orders o WHERE o.id = v_target AND p_viewer IN (o.buyer_id,o.seller_id);
    IF NOT FOUND THEN RETURN jsonb_build_object('kind','order','unavailable','Order Unavailable'); END IF;
    IF EXISTS (SELECT 1 FROM public.listings l WHERE l.id = (p_context->>'listingId')::uuid AND l.status = 'hidden') THEN
      v_result := (v_result - ARRAY['imagePath','variation']) || jsonb_build_object('title','Purchased item');
    END IF;
    v_result := v_result || jsonb_build_object(
      'href', CASE WHEN p_viewer = v_order.buyer_id THEN '/orders/' ELSE '/seller/orders/' END || v_target,
      'availability',v_order.status);
  END IF;
  RETURN jsonb_strip_nulls(v_result || jsonb_build_object('unavailable',v_state));
END;
$$;

CREATE OR REPLACE FUNCTION public.preview_chat_context(
  p_conversation uuid, p_kind text, p_target uuid, p_variant uuid DEFAULT NULL, p_item uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.present_chat_context(public.build_chat_context(p_conversation,p_kind,p_target,p_variant,p_item),auth.uid(),NULL)
$$;

CREATE OR REPLACE FUNCTION public.read_chat_contexts(p_messages uuid[])
RETURNS TABLE (message_id uuid, reference jsonb) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.id, public.present_chat_context(m.context_ref,auth.uid(),m.id)
  FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id
  WHERE public.is_active_member() AND auth.uid() IN (c.member_a,c.member_b)
    AND cardinality(p_messages) <= 300 AND m.id = ANY(p_messages) AND m.context_ref IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION public.read_chat_free_photo(p_message uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.context_ref->>'imagePath'
  FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id
  JOIN public.free_notices n ON n.id = (m.context_ref->>'targetId')::uuid
  JOIN public.profiles p ON p.id = n.contributor_id
  WHERE m.id = p_message AND m.context_ref->>'kind' = 'free' AND public.is_active_member()
    AND auth.uid() IN (c.member_a,c.member_b) AND p.status = 'active'
    AND n.status = 'active' AND n.expires_at > now() AND n.pickup_location IS NOT NULL
    AND m.context_ref->>'imagePath' = ANY(n.image_paths)
$$;

CREATE OR REPLACE FUNCTION public.send_contextual_message(
  p_message uuid, p_conversation uuid, p_body text, p_paths text[],
  p_kind text DEFAULT NULL, p_target uuid DEFAULT NULL, p_variant uuid DEFAULT NULL, p_item uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_peer uuid;
  v_exists public.messages;
  v_snapshot jsonb;
  v_body text := btrim(COALESCE(p_body,''));
  v_paths text[] := COALESCE(p_paths,'{}'::text[]);
  v_path text;
  v_created timestamptz;
  v_sender text;
  v_preview text;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() OR p_message IS NULL THEN
    RAISE EXCEPTION 'CHAT_UNAVAILABLE' USING ERRCODE = '42501';
  END IF;
  SELECT CASE WHEN c.member_a = v_uid THEN c.member_b ELSE c.member_a END INTO v_peer
  FROM public.conversations c WHERE c.id = p_conversation AND v_uid IN (c.member_a,c.member_b);
  IF NOT FOUND THEN RAISE EXCEPTION 'CHAT_UNAVAILABLE' USING ERRCODE = '42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('chat-message:' || p_message, 0));
  SELECT m.* INTO v_exists FROM public.messages m WHERE m.id = p_message;
  IF FOUND THEN
    IF v_exists.sender_id <> v_uid OR v_exists.conversation_id <> p_conversation THEN
      RAISE EXCEPTION 'CHAT_UNAVAILABLE' USING ERRCODE = '42501';
    END IF;
    RETURN v_exists.id;
  END IF;

  IF char_length(v_body) > 2000 OR cardinality(v_paths) > 3 THEN RAISE EXCEPTION 'INVALID_CHAT_MESSAGE'; END IF;
  FOREACH v_path IN ARRAY v_paths LOOP
    IF v_path IS NULL OR v_path !~ ('^' || v_uid || '/' || p_conversation || '/[A-Za-z0-9._-]+$')
       OR position('..' IN v_path) > 0 OR NOT EXISTS (
         SELECT 1 FROM storage.objects s WHERE s.bucket_id = 'chat-attachments' AND s.name = v_path
       ) THEN
      RAISE EXCEPTION 'INVALID_CHAT_ATTACHMENT' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  IF p_kind IS NOT NULL THEN
    v_snapshot := public.build_chat_context(p_conversation,p_kind,p_target,p_variant,p_item);
  ELSIF p_target IS NOT NULL OR p_variant IS NOT NULL OR p_item IS NOT NULL THEN
    RAISE EXCEPTION 'INVALID_CHAT_REFERENCE';
  END IF;
  IF v_body = '' AND cardinality(v_paths) = 0 AND v_snapshot IS NULL THEN RAISE EXCEPTION 'EMPTY_CHAT_MESSAGE'; END IF;

  -- The existing block guard also covers direct callers and the verified order exception.
  INSERT INTO public.messages (id,conversation_id,sender_id,body,image_paths,order_id,context_ref)
  VALUES (p_message,p_conversation,v_uid,v_body,v_paths,CASE WHEN p_kind = 'order' THEN p_target END,v_snapshot)
  RETURNING created_at INTO v_created;
  UPDATE public.conversations SET last_message_at = greatest(last_message_at,v_created) WHERE id = p_conversation;
  SELECT COALESCE(NULLIF(btrim(display_name),''),NULLIF(btrim(full_name),''),'UMS Member')
  INTO v_sender FROM public.profiles WHERE id = v_uid;
  v_preview := COALESCE(NULLIF(v_body,''),CASE p_kind WHEN 'product' THEN 'Product shared'
    WHEN 'service' THEN 'Service shared' WHEN 'order' THEN 'Order shared' WHEN 'free' THEN 'Free Item shared' END,
    CASE WHEN cardinality(v_paths) = 1 THEN 'Sent an attachment' ELSE 'Sent ' || cardinality(v_paths) || ' attachments' END);
  PERFORM public.safe_insert_notification(v_peer,'new_message','New message from ' || v_sender,
    left(v_preview,140),'/messages?c=' || p_conversation,'chat-msg-' || p_message);
  RETURN p_message;
END;
$$;

REVOKE ALL ON FUNCTION public.build_chat_context(uuid,text,uuid,uuid,uuid),
  public.present_chat_context(jsonb,uuid,uuid), public.chat_context_write_guard()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.open_contextual_conversation(uuid,uuid), public.preview_chat_context(uuid,text,uuid,uuid,uuid),
  public.read_chat_contexts(uuid[]), public.read_chat_free_photo(uuid),
  public.send_contextual_message(uuid,uuid,text,text[],text,uuid,uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.open_contextual_conversation(uuid,uuid), public.preview_chat_context(uuid,text,uuid,uuid,uuid),
  public.read_chat_contexts(uuid[]), public.read_chat_free_photo(uuid),
  public.send_contextual_message(uuid,uuid,text,text[],text,uuid,uuid,uuid) TO authenticated;

-- END EMBEDDED MIGRATION BODY

DO $verify$
DECLARE
  f jsonb := current_setting('buyu.verify_10m')::jsonb;
  buyer uuid := (f->>'buyer')::uuid;
  seller uuid := (f->>'seller')::uuid;
  outsider uuid := (f->>'outsider')::uuid;
  conv uuid := (f->>'conv')::uuid;
  listing uuid := (f->>'listing')::uuid;
  variant uuid := (f->>'variant')::uuid;
  service uuid := (f->>'service')::uuid;
  purchase uuid := (f->>'purchase')::uuid;
  notice uuid := (f->>'notice')::uuid;
  product_msg uuid := gen_random_uuid();
  free_msg uuid := gen_random_uuid();
  order_msg uuid := gen_random_uuid();
  service_msg uuid := gen_random_uuid();
  plain_msg uuid := gen_random_uuid();
  file_msg uuid := gen_random_uuid();
  report_id uuid;
  buyer_file text := buyer::text || '/' || conv::text || '/fixture.pdf';
  j jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_publication_rel r
    JOIN pg_catalog.pg_publication p ON p.oid = r.prpubid
    JOIN pg_catalog.pg_publication_tables t ON t.pubname = p.pubname
    WHERE p.pubname = 'supabase_realtime' AND r.prrelid = 'public.messages'::regclass
      AND r.prattrs IS NOT NULL AND t.schemaname = 'public' AND t.tablename = 'messages'
      AND t.attnames = ARRAY['id','conversation_id','sender_id','body','image_paths','listing_id','order_id',
        'free_notice_id','service_request_id','edited_at','created_at']::name[]
  ) OR (SELECT count(*) FROM pg_catalog.pg_publication_tables WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public' AND tablename IN ('conversations','offers','notifications')) <> 3 THEN
    RAISE EXCEPTION 'Realtime message allowlist or existing publication membership changed';
  END IF;
  INSERT INTO storage.objects (bucket_id,name,owner,owner_id,metadata) VALUES
    ('chat-attachments',buyer_file,buyer,buyer::text,'{"mimetype":"application/pdf","size":80}');
  PERFORM set_config('request.jwt.claims',json_build_object('sub',buyer,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',buyer::text,true);
  SET LOCAL ROLE authenticated;
  IF public.open_contextual_conversation(seller) IS DISTINCT FROM conv THEN RAISE EXCEPTION 'Pair was not reused'; END IF;
  IF (SELECT count(id) FROM public.messages WHERE conversation_id=conv) <> 1
     OR EXISTS (SELECT 1 FROM public.read_chat_contexts(ARRAY[(f->>'legacy')::uuid])) THEN
    RAISE EXCEPTION 'Opening chat sent a message or fabricated legacy context';
  END IF;

  j := public.preview_chat_context(conv,'product',listing);
  IF (j->>'imagePath') IS DISTINCT FROM 'cover.jpg'
     OR (j->>'priceMinSen')::integer IS DISTINCT FROM 1700 OR (j->>'priceMaxSen')::integer IS DISTINCT FROM 2200
     OR j ? 'variantId' THEN RAISE EXCEPTION 'General listing snapshot selected an arbitrary variation'; END IF;

  PERFORM public.send_contextual_message(product_msg,conv,'','{}','product',listing,variant);
  IF public.send_contextual_message(product_msg,conv,'','{}','product',listing,variant) IS DISTINCT FROM product_msg
     OR (SELECT count(id) FROM public.messages WHERE id=product_msg) <> 1 THEN
    RAISE EXCEPTION 'Message retry was duplicated';
  END IF;
  PERFORM public.send_contextual_message(service_msg,conv,'Can I book on Tuesday?','{}','service',service);
  PERFORM public.send_contextual_message(order_msg,conv,'Please check this purchased item','{}','order',purchase,NULL,(f->>'item')::uuid);
  PERFORM public.send_contextual_message(free_msg,conv,'','{}','free',notice);
  PERFORM public.send_contextual_message(plain_msg,conv,'Regular text','{}');
  PERFORM public.send_contextual_message(file_msg,conv,'',ARRAY[buyer_file]);

  SELECT reference INTO STRICT j FROM public.read_chat_contexts(ARRAY[product_msg]);
  IF j->>'imagePath' IS DISTINCT FROM 'variant.jpg' OR (j->>'priceMinSen')::int IS DISTINCT FROM 1700
     OR j->'variation'->>'Scent' IS DISTINCT FROM 'Hawas Fire' THEN RAISE EXCEPTION 'Incorrect selected variation snapshot'; END IF;
  SELECT reference INTO STRICT j FROM public.read_chat_contexts(ARRAY[service_msg]);
  IF j->>'kind' IS DISTINCT FROM 'service' OR j->>'title' IS DISTINCT FROM 'Fixture campus service'
     OR j ? 'canBargain' THEN RAISE EXCEPTION 'Incorrect service snapshot'; END IF;

  j := public.preview_chat_context(conv,'order',purchase);
  IF j ? 'itemId' OR j ? 'imagePath' OR (j->>'quantity')::int IS DISTINCT FROM 3
     OR j->>'href' IS DISTINCT FROM '/orders/' || purchase THEN RAISE EXCEPTION 'Incorrect buyer order summary'; END IF;
  SELECT reference INTO STRICT j FROM public.read_chat_contexts(ARRAY[order_msg]);
  IF j->>'imagePath' IS DISTINCT FROM 'saved-cover.jpg' OR j->>'title' IS DISTINCT FROM 'Historical perfume'
     OR (j->>'priceMinSen')::int IS DISTINCT FROM 1500 OR (j->>'quantity')::int IS DISTINCT FROM 2
     OR j ?| ARRAY['pickup_pin','service_requirements','service_attachment_paths'] THEN
    RAISE EXCEPTION 'Incorrect exact order item snapshot'; END IF;

  BEGIN
    PERFORM public.send_contextual_message(gen_random_uuid(),conv,'','{}');
    RAISE EXCEPTION 'Empty submission was accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'EMPTY_CHAT_MESSAGE' THEN RAISE; END IF; END;
  BEGIN
    PERFORM public.send_contextual_message(gen_random_uuid(),conv,'','{}','product',listing,(f->>'wrong_variant')::uuid);
    RAISE EXCEPTION 'Foreign variant was accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'INVALID_CHAT_VARIATION' THEN RAISE; END IF; END;
  BEGIN
    PERFORM public.preview_chat_context(conv,'product',(f->>'second_listing')::uuid);
    RAISE EXCEPTION 'Cross-conversation listing accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.preview_chat_context(conv,'order',(f->>'other_purchase')::uuid);
    RAISE EXCEPTION 'Cross-conversation order accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.preview_chat_context(conv,'order',purchase,NULL,(f->>'other_item')::uuid);
    RAISE EXCEPTION 'Foreign purchased item accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.send_contextual_message(gen_random_uuid(),conv,'',ARRAY[buyer::text || '/' || conv::text || '/does-not-exist.pdf']);
    RAISE EXCEPTION 'Forged file was accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    EXECUTE 'SELECT context_ref FROM public.messages LIMIT 1';
    RAISE EXCEPTION 'Raw snapshot accessible';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO public.messages (conversation_id,sender_id,body,context_ref) VALUES (conv,buyer,'Forged', '{"kind":"order"}');
    RAISE EXCEPTION 'Direct context insert bypassed RPC';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE public.messages SET body = 'Unauthorized edit', edited_at = clock_timestamp() WHERE id=product_msg;
    IF FOUND THEN RAISE EXCEPTION 'Authenticated sender bypassed hosted UPDATE policy'; END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF NOT EXISTS (SELECT 1 FROM public.messages WHERE id=product_msg AND body='' AND edited_at IS NULL)
     OR NOT EXISTS (SELECT 1 FROM public.read_chat_contexts(ARRAY[product_msg]) WHERE reference->>'imagePath' = 'variant.jpg')
  THEN RAISE EXCEPTION 'Rejected edit changed message or snapshot'; END IF;
  RESET ROLE;
  BEGIN
    UPDATE public.messages SET context_ref = NULL WHERE id=product_msg;
    RAISE EXCEPTION 'Privileged writer bypassed snapshot immutability';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'IMMUTABLE_CHAT_CONTEXT' THEN RAISE; END IF;
  END;
  SET LOCAL ROLE authenticated;
  INSERT INTO public.offers (conversation_id,listing_id,buyer_id,seller_id,offer_price_sen,variant_id)
  VALUES (conv,listing,buyer,seller,1200,variant);
  SELECT out_id INTO STRICT report_id FROM public.submit_report_atomic(
    'message',product_msg,'Spam','Synthetic participant report.'
  );

  SELECT reference INTO STRICT j FROM public.read_chat_contexts(ARRAY[free_msg]);
  IF j->>'pickup' IS DISTINCT FROM 'Block Alpha, level 2' OR j ? 'imagePath'
     OR public.read_chat_free_photo(free_msg) IS NULL THEN RAISE EXCEPTION 'Incorrect live Free Item projection'; END IF;

  PERFORM set_config('request.jwt.claims',json_build_object('sub',seller,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',seller::text,true);
  IF public.open_contextual_conversation(buyer) IS DISTINCT FROM conv THEN RAISE EXCEPTION 'Reverse pair was not reused'; END IF;
  SELECT reference INTO STRICT j FROM public.read_chat_contexts(ARRAY[order_msg]);
  IF j->>'href' IS DISTINCT FROM '/seller/orders/' || purchase THEN RAISE EXCEPTION 'Incorrect seller order route'; END IF;

  PERFORM set_config('request.jwt.claims',json_build_object('sub',outsider,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',outsider::text,true);
  IF EXISTS (SELECT 1 FROM public.read_chat_contexts(ARRAY[product_msg,order_msg,free_msg]))
     OR public.read_chat_free_photo(free_msg) IS NOT NULL THEN RAISE EXCEPTION 'Outsider could read private references'; END IF;
  BEGIN
    PERFORM public.send_contextual_message(product_msg,conv,'spoof retry','{}');
    RAISE EXCEPTION 'Outsider could reuse submission ID';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.submit_report_atomic('message',product_msg,'Spam','Synthetic nonparticipant report.');
    RAISE EXCEPTION 'Outsider could report private message';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'REPORT_TARGET_NOT_FOUND' THEN RAISE; END IF; END;

  RESET ROLE;
  INSERT INTO public.admin_users (user_id,active) VALUES (outsider,true);
  SET LOCAL ROLE authenticated;
  IF NOT EXISTS (SELECT id FROM public.messages WHERE id = product_msg)
     OR EXISTS (SELECT 1 FROM public.read_chat_contexts(ARRAY[product_msg]))
     OR public.admin_moderate_report_atomic(report_id,'under_review',NULL,'Synthetic admin check') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Existing moderation access or participant-only snapshot projection changed';
  END IF;
  RESET ROLE;
  IF (SELECT count(*) FROM public.notifications WHERE user_id=seller AND dedupe_key='chat-msg-' || product_msg) <> 1
     OR NOT EXISTS (SELECT 1 FROM public.notifications WHERE user_id=seller AND dedupe_key='chat-msg-' || free_msg
       AND body='Free Item shared' AND read_at IS NULL)
     OR NOT EXISTS (SELECT 1 FROM public.notifications WHERE user_id=seller AND dedupe_key='chat-msg-' || service_msg
       AND body='Can I book on Tuesday?')
     OR (SELECT last_message_at FROM public.conversations WHERE id=conv) IS DISTINCT FROM
        (SELECT max(created_at) FROM public.messages WHERE conversation_id=conv)
    THEN RAISE EXCEPTION 'Conversation ordering or deduped unread notifications failed'; END IF;
  UPDATE public.listing_variants SET price_sen=9000,image_path='later.jpg' WHERE id=variant;
  UPDATE public.free_notices SET expires_at=now()-interval '1 second' WHERE id=notice;
  PERFORM set_config('request.jwt.claims',json_build_object('sub',buyer,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',buyer::text,true);
  SET LOCAL ROLE authenticated;
  SELECT reference INTO STRICT j FROM public.read_chat_contexts(ARRAY[product_msg]);
  IF j->>'imagePath' IS DISTINCT FROM 'variant.jpg' OR (j->>'priceMinSen')::int IS DISTINCT FROM 1700
     THEN RAISE EXCEPTION 'Listing edit rewrote a message snapshot'; END IF;
  SELECT reference INTO STRICT j FROM public.read_chat_contexts(ARRAY[free_msg]);
  IF j->>'unavailable' IS DISTINCT FROM 'Free Item Expired' OR j ?| ARRAY['pickup','imagePath','imageUrl']
     OR public.read_chat_free_photo(free_msg) IS NOT NULL THEN RAISE EXCEPTION 'Expired Free Item leaked restricted details'; END IF;
  BEGIN
    PERFORM public.send_contextual_message(gen_random_uuid(),conv,'','{}','free',notice);
    RAISE EXCEPTION 'Expired Free Item accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RESET ROLE;

  UPDATE public.free_notices SET status='hidden' WHERE id=notice;
  UPDATE public.listings SET status='hidden' WHERE id=listing;
  INSERT INTO public.member_blocks (blocker_id,blocked_id) VALUES (seller,buyer);
  SET LOCAL ROLE authenticated;
  SELECT reference INTO STRICT j FROM public.read_chat_contexts(ARRAY[free_msg]);
  IF j->>'unavailable' IS DISTINCT FROM 'Free Item Removed' OR j ?| ARRAY['title','pickup','imagePath','imageUrl']
    THEN RAISE EXCEPTION 'Moderated Free Item snapshot leaked'; END IF;
  SELECT reference INTO STRICT j FROM public.read_chat_contexts(ARRAY[product_msg]);
  IF j->>'unavailable' IS DISTINCT FROM 'Product Unavailable' OR j ?| ARRAY['title','imagePath','href']
    THEN RAISE EXCEPTION 'Moderated listing snapshot leaked'; END IF;
  BEGIN
    PERFORM public.send_contextual_message(gen_random_uuid(),conv,'Blocked', '{}');
    RAISE EXCEPTION 'Existing block guard did not block plain chat';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RESET ROLE;
  UPDATE public.orders SET status='paid', completed_at=NULL WHERE id=purchase;
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.send_contextual_message(gen_random_uuid(),conv,'Unverified active order','{}','order',purchase);
    RAISE EXCEPTION 'Unverified active order bypassed blocking';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RESET ROLE;
  INSERT INTO public.payments (order_id,amount_sen,bill_code,status,verified_at)
  VALUES (purchase,4600,'BILL-M-' || purchase,'paid',now());
  SET LOCAL ROLE authenticated;
  PERFORM public.send_contextual_message(gen_random_uuid(),conv,'Verified active order','{}','order',purchase);
  RESET ROLE;
  -- The trusted system insert still passes through the same verified-order guard.
  SET LOCAL ROLE service_role;
  INSERT INTO public.messages (conversation_id,sender_id,body,order_id)
  VALUES (conv,buyer,'An established system message after migration',purchase)
  RETURNING id INTO plain_msg;
  RESET ROLE;
  IF NOT EXISTS (SELECT 1 FROM public.messages WHERE id=plain_msg AND context_ref IS NULL)
  THEN RAISE EXCEPTION 'Legacy system-initiated insert path changed'; END IF;
  RAISE NOTICE 'PHASE_10M_VERIFY_PASSED';
END;
$verify$;

ROLLBACK;
