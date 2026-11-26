BEGIN;

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS context_ref jsonb;

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

COMMIT;
