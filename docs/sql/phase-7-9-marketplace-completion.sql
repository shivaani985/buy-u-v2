-- =============================================================================
-- Buy-U Phases 7–9 — Consolidated Marketplace Completion Migration (Hardened)
-- STATUS: PROPOSAL ONLY — DO NOT APPLY WITHOUT EXPLICIT OWNER APPROVAL
-- TARGET PROJECT: duwwlcpdidrxkixvflag
--
-- Preflight-verified against actual hosted Supabase schema (P0.1–P0.11):
--   - free_notices statuses: active | closed | hidden (incomplete drafts in separate free_notice_drafts)
--   - reports statuses: submitted | under_review | resolved | dismissed
--   - profiles statuses: active | suspended | closed (restriction maps to suspended + reason)
--   - listings statuses: draft | published | archived | hidden (never 'removed')
--   - service_requests: preferred_date timestamptz, mode IN ('remote','in_person'), preserves 'expired'
--   - admin_audit_logs: id bigint, target_id uuid (nullable; text catalog refs stored in details)
--   - Direct client write bypasses revoked on service_requests, reviews, free_notices,
--     listing_views, notifications, member_blocks; all writes routed through atomic RPCs.
--   - Blocking enforced via DB triggers on conversations, messages (allowing active paid-order
--     obligations only), offers, service_requests, and free_notice_claims.
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION 1: Profiles, Privacy-Safe Blocking & Admin Audit Helper (P0.1/P0.3/P0.5/P0.13/P0.16)
-- =============================================================================
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS last_active_at timestamptz,
  ADD COLUMN IF NOT EXISTS notification_prefs jsonb NOT NULL DEFAULT '{"inquiries":true,"reviews":true,"community":true}'::jsonb;

-- Strict JSON structure constraint on notification_prefs (P0.13: exact 3 boolean keys only)
DO $$
BEGIN
  ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_notification_prefs_valid_check;
  ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_notification_prefs_valid_check CHECK (
      jsonb_typeof(notification_prefs) = 'object'
      AND notification_prefs ?& ARRAY['inquiries', 'reviews', 'community']
      AND jsonb_typeof(notification_prefs->'inquiries') = 'boolean'
      AND jsonb_typeof(notification_prefs->'reviews') = 'boolean'
      AND jsonb_typeof(notification_prefs->'community') = 'boolean'
      AND (notification_prefs - 'inquiries' - 'reviews' - 'community') = '{}'::jsonb
    );
END;
$$;

-- P0.13: SECURITY INVOKER guard matching hosted guard_profile_sensitive_columns() semantics!
-- Trusted SECURITY DEFINER RPCs execute with current_user = 'postgres' and CAN update last_active_at
-- & notification_prefs; direct authenticated client UPDATEs (current_user = 'authenticated') are rejected!
CREATE OR REPLACE FUNCTION public.guard_profile_system_fields_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user IN ('postgres', 'service_role') THEN
    RETURN NEW;
  END IF;

  IF NEW.last_active_at IS DISTINCT FROM OLD.last_active_at
     OR NEW.notification_prefs IS DISTINCT FROM OLD.notification_prefs THEN
    RAISE EXCEPTION 'FORBIDDEN_SYSTEM_PROFILE_FIELD' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_guard_system_fields ON public.profiles;
CREATE TRIGGER trg_profiles_guard_system_fields
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_profile_system_fields_trigger();

-- P0.13: Dedicated validated RPC for member non-essential notification preferences
-- (keeps profiles column-level UPDATE grants minimal without exposing notification_prefs directly!)
DROP FUNCTION IF EXISTS public.update_notification_preferences_atomic(boolean, boolean, boolean);
CREATE OR REPLACE FUNCTION public.update_notification_preferences_atomic(
  p_inquiries boolean,
  p_reviews boolean,
  p_community boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_prefs jsonb;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;
  IF p_inquiries IS NULL OR p_reviews IS NULL OR p_community IS NULL THEN
    RAISE EXCEPTION 'INVALID_NOTIFICATION_PREFS';
  END IF;

  v_prefs := jsonb_build_object(
    'inquiries', p_inquiries,
    'reviews', p_reviews,
    'community', p_community
  );

  UPDATE public.profiles
  SET notification_prefs = v_prefs,
      updated_at = v_now
  WHERE id = v_uid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROFILE_NOT_FOUND';
  END IF;

  RETURN v_prefs;
END;
$$;

REVOKE ALL ON FUNCTION public.update_notification_preferences_atomic(boolean, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_notification_preferences_atomic(boolean, boolean, boolean) TO authenticated;

-- Internal-only symmetric block helper (NEVER callable directly by authenticated/anon!)
CREATE OR REPLACE FUNCTION public.internal_is_blocked_between(p_user_a uuid, p_user_b uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.member_blocks mb
    WHERE (mb.blocker_id = p_user_a AND mb.blocked_id = p_user_b)
       OR (mb.blocker_id = p_user_b AND mb.blocked_id = p_user_a)
  );
$$;

REVOKE ALL ON FUNCTION public.internal_is_blocked_between(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Harden existing is_member_blocked_between so third parties CANNOT probe unrelated users (P0.5)
DROP FUNCTION IF EXISTS public.is_blocked_between(uuid, uuid);
CREATE OR REPLACE FUNCTION public.is_member_blocked_between(p_user_a uuid, p_user_b uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NOT NULL
     AND v_uid <> p_user_a
     AND v_uid <> p_user_b
     AND NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_BLOCK_LOOKUP' USING ERRCODE = '42501';
  END IF;
  RETURN public.internal_is_blocked_between(p_user_a, p_user_b);
END;
$$;

REVOKE ALL ON FUNCTION public.is_member_blocked_between(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_member_blocked_between(uuid, uuid) TO authenticated, service_role;

-- Atomic block/unblock RPC (P0.4 & P0.5)
DROP FUNCTION IF EXISTS public.toggle_member_block_atomic(uuid, boolean);
CREATE OR REPLACE FUNCTION public.toggle_member_block_atomic(
  p_target_user_id uuid,
  p_block boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;
  IF p_target_user_id IS NULL OR p_target_user_id = v_uid THEN
    RAISE EXCEPTION 'CANNOT_BLOCK_SELF';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_target_user_id) THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;

  IF COALESCE(p_block, true) THEN
    INSERT INTO public.member_blocks (blocker_id, blocked_id, created_at)
    VALUES (v_uid, p_target_user_id, clock_timestamp())
    ON CONFLICT (blocker_id, blocked_id) DO NOTHING;
    RETURN true;
  ELSE
    DELETE FROM public.member_blocks
    WHERE blocker_id = v_uid AND blocked_id = p_target_user_id;
    RETURN false;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.toggle_member_block_atomic(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.toggle_member_block_atomic(uuid, boolean) TO authenticated;

-- P0.5 & P0.16: Backend blocking & immutable-relationship enforcement on conversations, messages, and offers!
CREATE OR REPLACE FUNCTION public.enforce_block_on_conversation_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF public.internal_is_blocked_between(NEW.member_a, NEW.member_b) THEN
    RAISE EXCEPTION 'INTERACTION_BLOCKED' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_conversations_block_guard ON public.conversations;
CREATE TRIGGER trg_conversations_block_guard
  BEFORE INSERT ON public.conversations
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_block_on_conversation_trigger();

CREATE OR REPLACE FUNCTION public.guard_conversation_immutable_fields_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user IN ('postgres', 'service_role') THEN
    RETURN NEW;
  END IF;
  IF NEW.member_a IS DISTINCT FROM OLD.member_a OR NEW.member_b IS DISTINCT FROM OLD.member_b THEN
    RAISE EXCEPTION 'IMMUTABLE_CONVERSATION_PARTICIPANTS' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_conversations_immutable_guard ON public.conversations;
CREATE TRIGGER trg_conversations_immutable_guard
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_conversation_immutable_fields_trigger();

CREATE OR REPLACE FUNCTION public.enforce_block_on_message_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_conv public.conversations;
  v_other uuid;
  v_order_valid boolean := false;
BEGIN
  SELECT c.* INTO v_conv FROM public.conversations c WHERE c.id = NEW.conversation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONVERSATION_NOT_FOUND';
  END IF;
  IF NEW.sender_id <> v_conv.member_a AND NEW.sender_id <> v_conv.member_b THEN
    RAISE EXCEPTION 'FORBIDDEN_CONVERSATION_SENDER' USING ERRCODE = '42501';
  END IF;
  v_other := CASE WHEN v_conv.member_a = NEW.sender_id THEN v_conv.member_b ELSE v_conv.member_a END;

  -- P0.16: ALWAYS verify attached order_id belongs to these two participants (even if not blocked!)
  IF NEW.order_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = NEW.order_id
        AND ((o.buyer_id = NEW.sender_id AND o.seller_id = v_other)
          OR (o.seller_id = NEW.sender_id AND o.buyer_id = v_other))
    ) INTO v_order_valid;
    IF NOT v_order_valid THEN
      RAISE EXCEPTION 'INVALID_ORDER_ATTACHMENT' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF public.internal_is_blocked_between(NEW.sender_id, v_other) THEN
    -- Preserve ONLY controlled active/disputed AUTHORITATIVELY PAID order obligation messages
    -- reusing the accepted Phase 6 `public.is_order_payment_verified(o.id)` helper!
    IF NEW.order_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = NEW.order_id
        AND o.status IN ('paid', 'handed_over', 'disputed')
        AND ((o.buyer_id = NEW.sender_id AND o.seller_id = v_other)
          OR (o.seller_id = NEW.sender_id AND o.buyer_id = v_other))
        AND public.is_order_payment_verified(o.id)
    ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'INTERACTION_BLOCKED' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_messages_block_guard ON public.messages;
CREATE TRIGGER trg_messages_block_guard
  BEFORE INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_block_on_message_trigger();

CREATE OR REPLACE FUNCTION public.guard_message_immutable_fields_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user IN ('postgres', 'service_role') THEN
    RETURN NEW;
  END IF;
  IF NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.sender_id IS DISTINCT FROM OLD.sender_id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.listing_id IS DISTINCT FROM OLD.listing_id
     OR NEW.free_notice_id IS DISTINCT FROM OLD.free_notice_id
     OR NEW.service_request_id IS DISTINCT FROM OLD.service_request_id THEN
    RAISE EXCEPTION 'IMMUTABLE_MESSAGE_LINKS' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_messages_immutable_guard ON public.messages;
CREATE TRIGGER trg_messages_immutable_guard
  BEFORE UPDATE ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_message_immutable_fields_trigger();

CREATE OR REPLACE FUNCTION public.enforce_block_on_offer_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF public.internal_is_blocked_between(NEW.buyer_id, NEW.seller_id) THEN
    RAISE EXCEPTION 'INTERACTION_BLOCKED' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_offers_block_guard ON public.offers;
CREATE TRIGGER trg_offers_block_guard
  BEFORE INSERT ON public.offers
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_block_on_offer_trigger();

-- P0.16: Enforce blocking on pending -> accepted offer transitions & immutability of relationship columns
-- (while preserving cancel/decline on pending offers and expiry/fulfilment on already-accepted offers!)
CREATE OR REPLACE FUNCTION public.enforce_block_on_offer_update_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user NOT IN ('postgres', 'service_role') THEN
    IF NEW.buyer_id IS DISTINCT FROM OLD.buyer_id
       OR NEW.seller_id IS DISTINCT FROM OLD.seller_id
       OR NEW.listing_id IS DISTINCT FROM OLD.listing_id
       OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id THEN
      RAISE EXCEPTION 'IMMUTABLE_OFFER_RELATIONSHIPS' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF OLD.status = 'pending' AND NEW.status = 'accepted' THEN
    IF public.internal_is_blocked_between(OLD.buyer_id, OLD.seller_id) THEN
      RAISE EXCEPTION 'INTERACTION_BLOCKED' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_offers_update_block_guard ON public.offers;
CREATE TRIGGER trg_offers_update_block_guard
  BEFORE UPDATE ON public.offers
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_block_on_offer_update_trigger();

-- P0.3: Admin audit log helper matching EXACT hosted types (id bigint, target_id uuid nullable!)
DROP FUNCTION IF EXISTS public.log_admin_audit_internal(uuid, text, text, text, text, jsonb);
DROP FUNCTION IF EXISTS public.log_admin_audit_internal(uuid, text, text, uuid, text, jsonb);
CREATE OR REPLACE FUNCTION public.log_admin_audit_internal(
  p_admin_id uuid,
  p_action text,
  p_target_kind text,
  p_target_id uuid,
  p_reason text,
  p_details jsonb DEFAULT '{}'::jsonb
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id bigint;
BEGIN
  INSERT INTO public.admin_audit_logs (
    admin_id, action, target_kind, target_id, reason, details, created_at
  ) VALUES (
    p_admin_id, p_action, p_target_kind, p_target_id,
    COALESCE(NULLIF(trim(p_reason), ''), 'Admin action'),
    COALESCE(p_details, '{}'::jsonb),
    clock_timestamp()
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.log_admin_audit_internal(uuid, text, text, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;

-- Preference-respecting notification helper for non-essential categories (P0.10 & P0.13)
-- Safely guards against malformed JSONB so notification failures NEVER abort parent transactions!
CREATE OR REPLACE FUNCTION public.safe_insert_member_notification(
  p_user_id uuid,
  p_kind text,
  p_pref_group text,
  p_title text,
  p_body text,
  p_href text,
  p_dedupe_key text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prefs jsonb;
  v_enabled boolean := true;
BEGIN
  IF p_user_id IS NULL THEN RETURN; END IF;
  IF p_pref_group IS NOT NULL THEN
    SELECT p.notification_prefs INTO v_prefs FROM public.profiles p WHERE p.id = p_user_id;
    IF v_prefs IS NOT NULL
       AND jsonb_typeof(v_prefs) = 'object'
       AND jsonb_typeof(v_prefs->p_pref_group) = 'boolean' THEN
      v_enabled := (v_prefs->>p_pref_group)::boolean;
    END IF;
    IF NOT v_enabled THEN
      RETURN;
    END IF;
  END IF;
  BEGIN
    PERFORM public.safe_insert_notification(p_user_id, p_kind, p_title, p_body, p_href, p_dedupe_key);
  EXCEPTION WHEN OTHERS THEN
    RETURN;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.safe_insert_member_notification(uuid, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- SECTION 2: Listing View Deduplication & Activity Tracking (P0.4 / Phase 8F)
-- =============================================================================
DROP FUNCTION IF EXISTS public.record_listing_view_atomic(uuid);
CREATE OR REPLACE FUNCTION public.record_listing_view_atomic(p_listing_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_seller_id uuid;
  v_now timestamptz := clock_timestamp();
  v_day date := (v_now AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
  IF v_uid IS NULL OR p_listing_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT l.seller_id INTO v_seller_id
  FROM public.listings l
  WHERE l.id = p_listing_id AND l.status = 'published';

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE public.profiles SET last_active_at = v_now WHERE id = v_uid;

  IF v_seller_id = v_uid THEN
    RETURN false;
  END IF;

  INSERT INTO public.listing_views (viewer_id, listing_id, view_day, viewed_at)
  VALUES (v_uid, p_listing_id, v_day, v_now)
  ON CONFLICT (viewer_id, listing_id, view_day) DO NOTHING;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.record_listing_view_atomic(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_listing_view_atomic(uuid) TO authenticated;

-- =============================================================================
-- SECTION 3: Services Marketplace Lifecycle (P0.2 — Off-Platform Agreement)
-- =============================================================================
ALTER TABLE public.service_requests
  ADD COLUMN IF NOT EXISTS request_code text,
  ADD COLUMN IF NOT EXISTS proposed_arrangement text,
  ADD COLUMN IF NOT EXISTS cancellation_reason text,
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS idx_service_requests_request_code
  ON public.service_requests (request_code)
  WHERE request_code IS NOT NULL;

-- P0.2: Database-enforced unique active request per buyer & service listing!
CREATE UNIQUE INDEX IF NOT EXISTS idx_service_requests_one_active_per_buyer_listing
  ON public.service_requests (buyer_id, listing_id)
  WHERE status IN ('requested', 'accepted', 'in_progress', 'delivered');

CREATE INDEX IF NOT EXISTS idx_service_requests_buyer_id
  ON public.service_requests (buyer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_service_requests_seller_id
  ON public.service_requests (seller_id, created_at DESC);

-- P0.2: Preserve 'expired' status!
DO $$
DECLARE v_con text;
BEGIN
  FOR v_con IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.service_requests'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE public.service_requests DROP CONSTRAINT IF EXISTS %I', v_con);
  END LOOP;

  ALTER TABLE public.service_requests
    ADD CONSTRAINT service_requests_status_check
    CHECK (status IN (
      'requested', 'accepted', 'declined', 'in_progress', 'delivered', 'completed', 'cancelled', 'expired'
    ));
END;
$$;

-- P0.2: Typed timestamptz preferred_date, remote/in_person mode only, active-student provider check, opportunistic expiry!
DROP FUNCTION IF EXISTS public.create_service_request_atomic(uuid, text, text, text);
DROP FUNCTION IF EXISTS public.create_service_request_atomic(uuid, text, text, timestamptz);
CREATE OR REPLACE FUNCTION public.create_service_request_atomic(
  p_listing_id uuid,
  p_mode text,
  p_requirements text,
  p_preferred_date timestamptz DEFAULT NULL
)
RETURNS TABLE (
  out_id           uuid,
  out_request_code text,
  out_status       text,
  out_created_at   timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_listing public.listings;
  v_clean_req text := trim(COALESCE(p_requirements, ''));
  v_clean_mode text := lower(trim(COALESCE(p_mode, '')));
  v_now timestamptz := clock_timestamp();
  v_code text;
  v_row public.service_requests;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;

  IF length(v_clean_req) < 15 OR length(v_clean_req) > 1500 THEN
    RAISE EXCEPTION 'INVALID_REQUIREMENTS';
  END IF;

  -- Hosted service_requests.mode supports ONLY 'remote' or 'in_person'
  IF v_clean_mode NOT IN ('remote', 'in_person') THEN
    RAISE EXCEPTION 'INVALID_SERVICE_MODE';
  END IF;

  SELECT l.* INTO v_listing FROM public.listings l WHERE l.id = p_listing_id FOR SHARE;
  IF NOT FOUND OR lower(COALESCE(v_listing.kind, '')) <> 'service' OR v_listing.status <> 'published' THEN
    RAISE EXCEPTION 'SERVICE_UNAVAILABLE';
  END IF;

  IF NOT COALESCE(v_listing.accepting_requests, true) THEN
    RAISE EXCEPTION 'SERVICE_PAUSED';
  END IF;

  -- Validate requested mode is compatible with listing's configured service_mode
  IF v_listing.service_mode IN ('remote', 'in_person') AND v_listing.service_mode <> v_clean_mode THEN
    RAISE EXCEPTION 'INCOMPATIBLE_SERVICE_MODE';
  END IF;

  IF v_listing.seller_id = v_uid THEN
    RAISE EXCEPTION 'CANNOT_REQUEST_OWN_SERVICE';
  END IF;

  -- Verify provider is an eligible active student
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = v_listing.seller_id
      AND lower(COALESCE(p.university_role, '')) = 'student'
      AND lower(COALESCE(p.status, '')) = 'active'
  ) THEN
    RAISE EXCEPTION 'SERVICE_PROVIDER_UNAVAILABLE';
  END IF;

  IF public.internal_is_blocked_between(v_uid, v_listing.seller_id) THEN
    RAISE EXCEPTION 'INTERACTION_BLOCKED' USING ERRCODE = '42501';
  END IF;

  -- Opportunistically expire overdue 'requested' rows so expired requests never block new requests!
  UPDATE public.service_requests sr
  SET status = 'expired', updated_at = v_now
  WHERE sr.buyer_id = v_uid
    AND sr.listing_id = v_listing.id
    AND sr.status = 'requested'
    AND sr.respond_by <= v_now;

  v_code := 'SVC-'
    || to_char(v_now AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYMM')
    || '-'
    || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

  INSERT INTO public.service_requests (
    request_code, listing_id, buyer_id, seller_id, mode, requirements,
    preferred_date, status, respond_by, created_at, updated_at
  ) VALUES (
    v_code, v_listing.id, v_uid, v_listing.seller_id, v_clean_mode, v_clean_req,
    p_preferred_date, 'requested', v_now + interval '48 hours', v_now, v_now
  )
  RETURNING * INTO v_row;

  UPDATE public.profiles SET last_active_at = v_now WHERE id = v_uid;

  PERFORM public.safe_insert_member_notification(
    v_listing.seller_id,
    'service_requested',
    'inquiries',
    'New service request ' || v_code,
    'A member requested "' || v_listing.title || '".',
    '/seller/services',
    'svc-req-' || v_row.id::text
  );

  RETURN QUERY SELECT v_row.id, v_row.request_code, v_row.status, v_row.created_at;
END;
$$;

REVOKE ALL ON FUNCTION public.create_service_request_atomic(uuid, text, text, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_service_request_atomic(uuid, text, text, timestamptz) TO authenticated;

-- P0.14: Trusted standalone expiry sweeper for overdue 'requested' service requests (Phase 11 cron & server calls)
-- NEVER expires accepted, in_progress, delivered, completed, declined, or cancelled requests!
DROP FUNCTION IF EXISTS public.expire_stale_service_requests_atomic(uuid);
CREATE OR REPLACE FUNCTION public.expire_stale_service_requests_atomic(p_request_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz;
  v_req RECORD;
  v_count integer := 0;
BEGIN
  FOR v_req IN
    SELECT sr.id, sr.buyer_id, sr.seller_id, sr.request_code
    FROM public.service_requests sr
    WHERE sr.status = 'requested'
      AND (p_request_id IS NULL OR sr.id = p_request_id)
      AND sr.respond_by <= clock_timestamp()
    ORDER BY sr.id
    FOR UPDATE SKIP LOCKED
  LOOP
    v_now := clock_timestamp();
    UPDATE public.service_requests
    SET status = 'expired', updated_at = v_now
    WHERE id = v_req.id AND status = 'requested' AND respond_by <= v_now;

    IF FOUND THEN
      v_count := v_count + 1;
      PERFORM public.safe_insert_member_notification(
        v_req.buyer_id,
        'service_expired',
        'inquiries',
        'Service request ' || COALESCE(v_req.request_code, '') || ' expired',
        'Provider did not respond within the 48-hour window. You may submit a new request.',
        '/requests',
        'svc-' || v_req.id::text || '-expired'
      );
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_stale_service_requests_atomic(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_service_requests_atomic(uuid) TO service_role;

DROP FUNCTION IF EXISTS public.update_service_request_status_atomic(uuid, text, text);
CREATE OR REPLACE FUNCTION public.update_service_request_status_atomic(
  p_request_id uuid,
  p_action text,
  p_note text DEFAULT NULL
)
RETURNS TABLE (
  out_id         uuid,
  out_status     text,
  out_updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_sr public.service_requests;
  v_listing public.listings;
  v_act text := lower(trim(COALESCE(p_action, '')));
  v_note text := NULLIF(trim(COALESCE(p_note, '')), '');
  v_now timestamptz;
  v_next text;
  v_notify_uid uuid;
  v_notify_title text;
  v_notify_href text;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;

  SELECT sr.* INTO v_sr FROM public.service_requests sr WHERE sr.id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SERVICE_REQUEST_NOT_FOUND'; END IF;

  -- Evaluate authoritative DB time AFTER acquiring row lock (P0.14)
  v_now := clock_timestamp();

  IF v_uid <> v_sr.buyer_id AND v_uid <> v_sr.seller_id THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  -- P0.14: Persist 'expired' cleanly and RETURN structured outcome (NEVER raise exception that rolls back!)
  IF v_sr.status = 'requested' AND v_sr.respond_by <= v_now THEN
    UPDATE public.service_requests
    SET status = 'expired', updated_at = v_now
    WHERE id = v_sr.id
    RETURNING * INTO v_sr;

    PERFORM public.safe_insert_member_notification(
      v_sr.buyer_id,
      'service_expired',
      'inquiries',
      'Service request ' || COALESCE(v_sr.request_code, '') || ' expired',
      'The 48-hour response deadline passed. You can now submit a new request.',
      '/requests',
      'svc-' || v_sr.id::text || '-expired'
    );

    RETURN QUERY SELECT v_sr.id, v_sr.status, v_sr.updated_at;
    RETURN;
  END IF;

  IF v_act = 'accept' THEN
    IF v_uid <> v_sr.seller_id THEN RAISE EXCEPTION 'FORBIDDEN_SELLER_ONLY' USING ERRCODE = '42501'; END IF;
    IF v_sr.status <> 'requested' THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
    -- Both participants must remain eligible before accepting a new obligation (no suspended accounts!)
    IF NOT public.is_active_student() THEN
      RAISE EXCEPTION 'FORBIDDEN_ACTIVE_STUDENT_ONLY' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = v_sr.buyer_id AND lower(COALESCE(p.status, '')) = 'active'
    ) THEN
      RAISE EXCEPTION 'BUYER_ACCOUNT_INACTIVE';
    END IF;
    SELECT l.* INTO v_listing FROM public.listings l WHERE l.id = v_sr.listing_id;
    IF NOT FOUND
       OR lower(COALESCE(v_listing.kind, '')) <> 'service'
       OR v_listing.status <> 'published'
       OR NOT COALESCE(v_listing.accepting_requests, true) THEN
      RAISE EXCEPTION 'SERVICE_UNAVAILABLE';
    END IF;
    IF v_listing.service_mode IN ('remote', 'in_person') AND v_listing.service_mode <> v_sr.mode THEN
      RAISE EXCEPTION 'INCOMPATIBLE_SERVICE_MODE';
    END IF;
    IF public.internal_is_blocked_between(v_sr.buyer_id, v_sr.seller_id) THEN
      RAISE EXCEPTION 'INTERACTION_BLOCKED' USING ERRCODE = '42501';
    END IF;
    v_next := 'accepted';
    v_notify_uid := v_sr.buyer_id;
    v_notify_title := 'Service request ' || COALESCE(v_sr.request_code, '') || ' accepted';
    v_notify_href := '/requests';
  ELSIF v_act = 'decline' THEN
    IF v_uid <> v_sr.seller_id THEN RAISE EXCEPTION 'FORBIDDEN_SELLER_ONLY' USING ERRCODE = '42501'; END IF;
    IF v_sr.status <> 'requested' THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
    v_next := 'declined';
    v_notify_uid := v_sr.buyer_id;
    v_notify_title := 'Service request ' || COALESCE(v_sr.request_code, '') || ' declined';
    v_notify_href := '/requests';
  ELSIF v_act = 'start' THEN
    IF v_uid <> v_sr.seller_id THEN RAISE EXCEPTION 'FORBIDDEN_SELLER_ONLY' USING ERRCODE = '42501'; END IF;
    IF v_sr.status <> 'accepted' THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
    v_next := 'in_progress';
    v_notify_uid := v_sr.buyer_id;
    v_notify_title := 'Service ' || COALESCE(v_sr.request_code, '') || ' is in progress';
    v_notify_href := '/requests';
  ELSIF v_act = 'deliver' THEN
    IF v_uid <> v_sr.seller_id THEN RAISE EXCEPTION 'FORBIDDEN_SELLER_ONLY' USING ERRCODE = '42501'; END IF;
    IF v_sr.status NOT IN ('accepted', 'in_progress') THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
    v_next := 'delivered';
    v_notify_uid := v_sr.buyer_id;
    v_notify_title := 'Service ' || COALESCE(v_sr.request_code, '') || ' marked delivered';
    v_notify_href := '/requests';
  ELSIF v_act = 'complete' THEN
    IF v_uid <> v_sr.buyer_id THEN RAISE EXCEPTION 'FORBIDDEN_BUYER_ONLY' USING ERRCODE = '42501'; END IF;
    IF v_sr.status <> 'delivered' THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
    v_next := 'completed';
    v_notify_uid := v_sr.seller_id;
    v_notify_title := 'Service ' || COALESCE(v_sr.request_code, '') || ' completed';
    v_notify_href := '/seller/services';
  ELSIF v_act = 'cancel' THEN
    IF v_sr.status NOT IN ('requested', 'accepted', 'in_progress') THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
    v_next := 'cancelled';
    v_notify_uid := CASE WHEN v_uid = v_sr.buyer_id THEN v_sr.seller_id ELSE v_sr.buyer_id END;
    v_notify_title := 'Service request ' || COALESCE(v_sr.request_code, '') || ' cancelled';
    v_notify_href := CASE WHEN v_uid = v_sr.buyer_id THEN '/seller/services' ELSE '/requests' END;
  ELSE
    RAISE EXCEPTION 'INVALID_ACTION';
  END IF;

  UPDATE public.service_requests sr
  SET status = v_next,
      proposed_arrangement = CASE WHEN v_act IN ('accept', 'start', 'deliver') AND v_note IS NOT NULL THEN v_note ELSE sr.proposed_arrangement END,
      cancellation_reason = CASE WHEN v_act IN ('decline', 'cancel') THEN COALESCE(v_note, sr.cancellation_reason) ELSE sr.cancellation_reason END,
      delivered_at = CASE WHEN v_next = 'delivered' THEN v_now ELSE sr.delivered_at END,
      completed_at = CASE WHEN v_next = 'completed' THEN v_now ELSE sr.completed_at END,
      cancelled_at = CASE WHEN v_next IN ('cancelled', 'declined') THEN v_now ELSE sr.cancelled_at END,
      updated_at = v_now
  WHERE sr.id = v_sr.id
  RETURNING * INTO v_sr;

  UPDATE public.profiles SET last_active_at = v_now WHERE id = v_uid;

  PERFORM public.safe_insert_notification(
    v_notify_uid,
    'service_' || v_next,
    v_notify_title,
    COALESCE(v_note, 'Status updated to ' || replace(v_next, '_', ' ') || '.'),
    v_notify_href,
    'svc-' || v_sr.id::text || '-' || v_next
  );

  RETURN QUERY SELECT v_sr.id, v_sr.status, v_sr.updated_at;
END;
$$;

REVOKE ALL ON FUNCTION public.update_service_request_status_atomic(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_service_request_status_atomic(uuid, text, text) TO authenticated;

-- =============================================================================
-- SECTION 4: Free Items, Private Persistent Drafts & Atomic Claims (P0.1/P0.4/P0.6)
-- =============================================================================
ALTER TABLE public.donation_spots
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS operating_info text,
  ADD COLUMN IF NOT EXISTS safety_note text;

-- Keep hosted free_notices statuses (active | closed | hidden) & constraints 100% intact!
ALTER TABLE public.free_notices
  ADD COLUMN IF NOT EXISTS category_id text REFERENCES public.categories(id),
  ADD COLUMN IF NOT EXISTS quantity integer NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  ADD COLUMN IF NOT EXISTS reserved_quantity integer NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0 AND reserved_quantity <= quantity),
  ADD COLUMN IF NOT EXISTS collection_instructions text,
  ADD COLUMN IF NOT EXISTS moderated_prev_status text;

-- Minimal MIME-type & 5 MB file-size metadata guard ONLY on already-public 'free-items' bucket.
-- Preserves existing hosted storage.objects policies (which already enforce active student & UID folder ownership)
-- and never alters visibility of any private bucket!
UPDATE storage.buckets
SET file_size_limit = 5242880,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp']
WHERE id = 'free-items';

-- Separate private draft table so incomplete drafts persist & recover cleanly without weakening free_notices constraints!
CREATE TABLE IF NOT EXISTS public.free_notice_drafts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contributor_id          uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title                   text NOT NULL DEFAULT '',
  description             text NOT NULL DEFAULT '',
  condition               text NOT NULL DEFAULT 'Good',
  quantity                integer NOT NULL DEFAULT 1 CHECK (quantity >= 1 AND quantity <= 99),
  spot_id                 text REFERENCES public.donation_spots(id),
  category_id             text REFERENCES public.categories(id),
  collection_instructions text,
  image_paths             text[] NOT NULL DEFAULT '{}'::text[],
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_free_notice_drafts_owner
  ON public.free_notice_drafts (contributor_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.free_notice_claims (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_code             text NOT NULL UNIQUE,
  notice_id              uuid NOT NULL REFERENCES public.free_notices(id) ON DELETE RESTRICT,
  donor_id               uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  recipient_id           uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  quantity               integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  note                   text,
  status                 text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'reserved', 'handed_over', 'collected', 'declined', 'cancelled', 'expired')),
  cancellation_reason    text,
  reservation_expires_at timestamptz,
  accepted_at            timestamptz,
  handed_over_at         timestamptz,
  collected_at           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_free_notice_claims_active_unique
  ON public.free_notice_claims (notice_id, recipient_id)
  WHERE status IN ('requested', 'reserved', 'handed_over');

CREATE INDEX IF NOT EXISTS idx_free_notice_claims_donor
  ON public.free_notice_claims (donor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_free_notice_claims_recipient
  ON public.free_notice_claims (recipient_id, created_at DESC);

-- P0.15: Authorized publish RPC for free_notices:
--   - Exact hosted condition vocabulary ('New/Unused','Like New','Good','Fair')
--   - Active donation spot + active product category validation
--   - 1..5 distinct, safe, student-owned image paths verified to exist in storage.objects (bucket_id = 'free-items')
--   - Concurrency-safe FOR UPDATE draft locking preventing duplicate publication on replay!
DROP FUNCTION IF EXISTS public.publish_free_notice_atomic(text, text, text, integer, text, text, text, text[], uuid);
CREATE OR REPLACE FUNCTION public.publish_free_notice_atomic(
  p_title text,
  p_description text,
  p_condition text,
  p_quantity integer,
  p_spot_id text,
  p_category_id text DEFAULT NULL,
  p_collection_instructions text DEFAULT NULL,
  p_image_paths text[] DEFAULT '{}'::text[],
  p_draft_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_title text := trim(COALESCE(p_title, ''));
  v_desc text := trim(COALESCE(p_description, ''));
  v_cond text := trim(COALESCE(p_condition, ''));
  v_qty integer := COALESCE(p_quantity, 1);
  v_cat text := NULLIF(trim(COALESCE(p_category_id, '')), '');
  v_imgs text[] := COALESCE(p_image_paths, '{}'::text[]);
  v_img text;
  v_distinct_count integer;
  v_now timestamptz := clock_timestamp();
  v_notice_id uuid;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_student() THEN
    RAISE EXCEPTION 'FORBIDDEN_ACTIVE_STUDENT_ONLY' USING ERRCODE = '42501';
  END IF;
  IF length(v_title) < 5 OR length(v_title) > 100 THEN
    RAISE EXCEPTION 'INVALID_FREE_TITLE';
  END IF;
  IF length(v_desc) < 10 OR length(v_desc) > 2000 THEN
    RAISE EXCEPTION 'INVALID_FREE_DESCRIPTION';
  END IF;
  IF v_cond NOT IN ('New/Unused', 'Like New', 'Good', 'Fair') THEN
    RAISE EXCEPTION 'INVALID_FREE_CONDITION';
  END IF;
  IF v_qty < 1 OR v_qty > 99 THEN
    RAISE EXCEPTION 'INVALID_FREE_DETAILS';
  END IF;
  IF COALESCE(cardinality(v_imgs), 0) < 1 OR COALESCE(cardinality(v_imgs), 0) > 5 THEN
    RAISE EXCEPTION 'FREE_ITEM_IMAGES_REQUIRED';
  END IF;

  -- Reject duplicate image paths
  SELECT count(DISTINCT trim(x)) INTO v_distinct_count FROM unnest(v_imgs) AS x;
  IF v_distinct_count <> cardinality(v_imgs) THEN
    RAISE EXCEPTION 'DUPLICATE_IMAGE_PATHS';
  END IF;

  -- Validate every image path: safe, student-owned prefix `<uid>/...`, and actually exists in storage.objects ('free-items')!
  FOREACH v_img IN ARRAY v_imgs LOOP
    v_img := trim(COALESCE(v_img, ''));
    IF v_img = ''
       OR position('..' in v_img) > 0
       OR position('\' in v_img) > 0
       OR left(v_img, 1) = '/'
       OR v_img !~ ('^' || v_uid::text || '/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$') THEN
      RAISE EXCEPTION 'INVALID_FREE_IMAGE_PATH';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM storage.objects so
      WHERE so.bucket_id = 'free-items' AND so.name = v_img
    ) THEN
      RAISE EXCEPTION 'FREE_IMAGE_OBJECT_NOT_FOUND';
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM public.donation_spots ds WHERE ds.id = p_spot_id AND ds.active = true) THEN
    RAISE EXCEPTION 'INVALID_DONATION_SPOT';
  END IF;

  IF v_cat IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.categories c WHERE c.id = v_cat AND c.kind = 'product' AND c.active = true
  ) THEN
    RAISE EXCEPTION 'INVALID_CATEGORY';
  END IF;

  -- Lock & validate draft ownership atomically BEFORE inserting to block concurrent replay / duplicate publication!
  IF p_draft_id IS NOT NULL THEN
    PERFORM 1 FROM public.free_notice_drafts d
    WHERE d.id = p_draft_id AND d.contributor_id = v_uid
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'DRAFT_NOT_FOUND_OR_ALREADY_PUBLISHED';
    END IF;
  END IF;

  INSERT INTO public.free_notices (
    contributor_id, title, description, condition, quantity, reserved_quantity,
    quantity_note, spot_id, category_id, collection_instructions,
    image_paths, already_placed, status, published_at, expires_at, created_at, updated_at
  ) VALUES (
    v_uid, v_title, v_desc, v_cond, v_qty, 0,
    v_qty::text || ' available', p_spot_id, v_cat,
    NULLIF(trim(COALESCE(p_collection_instructions, '')), ''),
    v_imgs, true, 'active', v_now, v_now + interval '72 hours', v_now, v_now
  )
  RETURNING id INTO v_notice_id;

  IF p_draft_id IS NOT NULL THEN
    DELETE FROM public.free_notice_drafts WHERE id = p_draft_id AND contributor_id = v_uid;
  END IF;

  UPDATE public.profiles SET last_active_at = v_now WHERE id = v_uid;
  RETURN v_notice_id;
END;
$$;

REVOKE ALL ON FUNCTION public.publish_free_notice_atomic(text, text, text, integer, text, text, text, text[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.publish_free_notice_atomic(text, text, text, integer, text, text, text, text[], uuid) TO authenticated;

-- P0.15: Authorized donor management RPC (edit / close own published free notice after direct writes were revoked!)
DROP FUNCTION IF EXISTS public.manage_free_notice_atomic(uuid, text, text, text, text, integer, text);
CREATE OR REPLACE FUNCTION public.manage_free_notice_atomic(
  p_notice_id uuid,
  p_action text,
  p_title text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_condition text DEFAULT NULL,
  p_quantity integer DEFAULT NULL,
  p_collection_instructions text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_fn public.free_notices;
  v_act text := lower(trim(COALESCE(p_action, '')));
  v_title text;
  v_desc text;
  v_cond text;
  v_qty integer;
  v_now timestamptz;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_student() THEN
    RAISE EXCEPTION 'FORBIDDEN_ACTIVE_STUDENT_ONLY' USING ERRCODE = '42501';
  END IF;

  SELECT fn.* INTO v_fn FROM public.free_notices fn WHERE fn.id = p_notice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FREE_NOTICE_NOT_FOUND'; END IF;
  IF v_fn.contributor_id <> v_uid THEN RAISE EXCEPTION 'FORBIDDEN_DONOR_ONLY' USING ERRCODE = '42501'; END IF;
  IF v_fn.status = 'hidden' THEN RAISE EXCEPTION 'FREE_NOTICE_MODERATED_HIDDEN' USING ERRCODE = '42501'; END IF;

  v_now := clock_timestamp();

  IF v_act = 'close' THEN
    IF v_fn.reserved_quantity > 0 THEN
      RAISE EXCEPTION 'CANNOT_CLOSE_WITH_ACTIVE_RESERVATIONS';
    END IF;
    UPDATE public.free_notices
    SET status = 'closed', updated_at = v_now
    WHERE id = v_fn.id;
    RETURN 'closed';
  ELSIF v_act = 'edit' THEN
    v_title := COALESCE(NULLIF(trim(COALESCE(p_title, '')), ''), v_fn.title);
    v_desc := COALESCE(NULLIF(trim(COALESCE(p_description, '')), ''), v_fn.description);
    v_cond := COALESCE(NULLIF(trim(COALESCE(p_condition, '')), ''), v_fn.condition);
    v_qty := COALESCE(p_quantity, v_fn.quantity);

    IF length(v_title) < 5 OR length(v_title) > 100 THEN RAISE EXCEPTION 'INVALID_FREE_TITLE'; END IF;
    IF length(v_desc) < 10 OR length(v_desc) > 2000 THEN RAISE EXCEPTION 'INVALID_FREE_DESCRIPTION'; END IF;
    IF v_cond NOT IN ('New/Unused', 'Like New', 'Good', 'Fair') THEN RAISE EXCEPTION 'INVALID_FREE_CONDITION'; END IF;
    IF v_qty < 1 OR v_qty > 99 THEN RAISE EXCEPTION 'INVALID_FREE_DETAILS'; END IF;
    IF v_qty < v_fn.reserved_quantity THEN RAISE EXCEPTION 'QUANTITY_BELOW_RESERVED'; END IF;

    UPDATE public.free_notices
    SET title = v_title,
        description = v_desc,
        condition = v_cond,
        quantity = v_qty,
        quantity_note = (v_qty - v_fn.reserved_quantity)::text || ' available',
        collection_instructions = CASE
          WHEN p_collection_instructions IS NOT NULL THEN NULLIF(trim(p_collection_instructions), '')
          ELSE collection_instructions
        END,
        updated_at = v_now
    WHERE id = v_fn.id;
    RETURN v_fn.status;
  ELSE
    RAISE EXCEPTION 'INVALID_ACTION';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.manage_free_notice_atomic(uuid, text, text, text, text, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manage_free_notice_atomic(uuid, text, text, text, text, integer, text) TO authenticated;

-- P0.6 & Critical Notifications: Safe exact-once expiry for overdue 'reserved' claims (NEVER expires 'handed_over'!)
-- Generates mandatory deduplicated transactional notifications to BOTH recipient & donor!
DROP FUNCTION IF EXISTS public.expire_stale_free_claims_atomic(uuid);
CREATE OR REPLACE FUNCTION public.expire_stale_free_claims_atomic(p_notice_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_claim RECORD;
  v_notice public.free_notices;
  v_count integer := 0;
BEGIN
  FOR v_claim IN
    SELECT c.id, c.notice_id, c.quantity, c.donor_id, c.recipient_id, c.claim_code
    FROM public.free_notice_claims c
    WHERE c.status = 'reserved'
      AND c.reservation_expires_at IS NOT NULL
      AND c.reservation_expires_at <= v_now
      AND (p_notice_id IS NULL OR c.notice_id = p_notice_id)
    ORDER BY c.notice_id, c.id
  LOOP
    SELECT fn.* INTO v_notice FROM public.free_notices fn WHERE fn.id = v_claim.notice_id FOR UPDATE;
    PERFORM 1 FROM public.free_notice_claims c2 WHERE c2.id = v_claim.id AND c2.status = 'reserved' FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;

    IF v_notice.reserved_quantity < v_claim.quantity THEN
      RAISE EXCEPTION 'INVENTORY_INTEGRITY_ERROR';
    END IF;

    UPDATE public.free_notices
    SET reserved_quantity = reserved_quantity - v_claim.quantity, updated_at = v_now
    WHERE id = v_notice.id;

    UPDATE public.free_notice_claims
    SET status = 'expired', updated_at = v_now
    WHERE id = v_claim.id;

    -- Mandatory transactional notifications (p_pref_group = NULL so optional community prefs cannot suppress!)
    PERFORM public.safe_insert_member_notification(
      v_claim.recipient_id,
      'free_claim_expired',
      NULL,
      'Reservation expired (' || v_claim.claim_code || ')',
      'Your 48-hour pickup reservation for "' || v_notice.title || '" expired and units were released.',
      '/free-items',
      'don-' || v_claim.id::text || '-expired-recipient'
    );
    PERFORM public.safe_insert_member_notification(
      v_claim.donor_id,
      'free_claim_expired',
      NULL,
      'Reservation expired (' || v_claim.claim_code || ')',
      'An uncollected 48-hour reservation for "' || v_notice.title || '" expired and units returned to available stock.',
      '/free-items',
      'don-' || v_claim.id::text || '-expired-donor'
    );

    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_stale_free_claims_atomic(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_free_claims_atomic(uuid) TO service_role;

-- Claim request RPC (P0.1 active status + expires_at + active donor; stale claims expired via standalone sweeper!)
DROP FUNCTION IF EXISTS public.create_free_notice_claim_atomic(uuid, integer, text);
CREATE OR REPLACE FUNCTION public.create_free_notice_claim_atomic(
  p_notice_id uuid,
  p_quantity integer DEFAULT 1,
  p_note text DEFAULT NULL
)
RETURNS TABLE (
  out_id         uuid,
  out_claim_code text,
  out_status     text,
  out_created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_notice public.free_notices;
  v_qty integer := COALESCE(p_quantity, 1);
  v_avail integer;
  v_now timestamptz;
  v_code text;
  v_row public.free_notice_claims;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;
  IF v_qty <= 0 THEN RAISE EXCEPTION 'INVALID_QUANTITY'; END IF;

  SELECT fn.* INTO v_notice FROM public.free_notices fn WHERE fn.id = p_notice_id FOR UPDATE;
  v_now := clock_timestamp();
  IF NOT FOUND OR v_notice.status <> 'active' OR v_notice.expires_at <= v_now THEN
    RAISE EXCEPTION 'FREE_ITEM_UNAVAILABLE';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_notice.contributor_id AND p.status = 'active') THEN
    RAISE EXCEPTION 'FREE_ITEM_UNAVAILABLE';
  END IF;

  IF v_notice.contributor_id = v_uid THEN
    RAISE EXCEPTION 'CANNOT_CLAIM_OWN_ITEM';
  END IF;

  IF public.internal_is_blocked_between(v_uid, v_notice.contributor_id) THEN
    RAISE EXCEPTION 'INTERACTION_BLOCKED' USING ERRCODE = '42501';
  END IF;

  v_avail := v_notice.quantity - v_notice.reserved_quantity;
  IF v_qty > v_avail THEN
    RAISE EXCEPTION 'INSUFFICIENT_FREE_QUANTITY';
  END IF;

  v_code := 'DON-'
    || to_char(v_now AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYMM')
    || '-'
    || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

  INSERT INTO public.free_notice_claims (
    claim_code, notice_id, donor_id, recipient_id, quantity, note, status, created_at, updated_at
  ) VALUES (
    v_code, v_notice.id, v_notice.contributor_id, v_uid, v_qty,
    NULLIF(trim(COALESCE(p_note, '')), ''), 'requested', v_now, v_now
  )
  RETURNING * INTO v_row;

  UPDATE public.profiles SET last_active_at = v_now WHERE id = v_uid;

  PERFORM public.safe_insert_member_notification(
    v_notice.contributor_id,
    'free_claim_requested',
    'community',
    'New free-item claim ' || v_code,
    'A member requested "' || v_notice.title || '" (qty ' || v_qty || ').',
    '/free-items',
    'don-req-' || v_row.id::text
  );

  RETURN QUERY SELECT v_row.id, v_row.claim_code, v_row.status, v_row.created_at;
END;
$$;

REVOKE ALL ON FUNCTION public.create_free_notice_claim_atomic(uuid, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_free_notice_claim_atomic(uuid, integer, text) TO authenticated;

-- Atomic donor/recipient claim lifecycle (P0.6: strict inventory checks, 48h reservation deadline, free_notices locked first!)
DROP FUNCTION IF EXISTS public.update_free_notice_claim_atomic(uuid, text, text);
CREATE OR REPLACE FUNCTION public.update_free_notice_claim_atomic(
  p_claim_id uuid,
  p_action text,
  p_reason text DEFAULT NULL
)
RETURNS TABLE (
  out_id         uuid,
  out_status     text,
  out_updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_notice_id uuid;
  v_notice public.free_notices;
  v_claim public.free_notice_claims;
  v_act text := lower(trim(COALESCE(p_action, '')));
  v_reason text := NULLIF(trim(COALESCE(p_reason, '')), '');
  v_now timestamptz := clock_timestamp();
  v_prev_status text;
  v_next text;
  v_notify_uid uuid;
  v_notify_title text;
  v_notify_pref_group text;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;

  SELECT c.notice_id INTO v_notice_id FROM public.free_notice_claims c WHERE c.id = p_claim_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLAIM_NOT_FOUND'; END IF;

  -- Lock free_notices FIRST -> free_notice_claims SECOND; read authoritative DB time AFTER locks!
  SELECT fn.* INTO v_notice FROM public.free_notices fn WHERE fn.id = v_notice_id FOR UPDATE;
  SELECT c.* INTO v_claim FROM public.free_notice_claims c WHERE c.id = p_claim_id FOR UPDATE;
  v_now := clock_timestamp();
  v_prev_status := v_claim.status;

  IF v_uid <> v_claim.donor_id AND v_uid <> v_claim.recipient_id THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  -- P0.15: Revalidate reservation deadline AFTER locks before handover; commit & return 'expired' cleanly!
  -- (Already handed_over claims are NEVER expired and remain intact for recipient collection!)
  IF v_act = 'handover'
     AND v_claim.status = 'reserved'
     AND v_claim.reservation_expires_at IS NOT NULL
     AND v_claim.reservation_expires_at <= v_now THEN
    IF v_uid <> v_claim.donor_id THEN
      RAISE EXCEPTION 'FORBIDDEN_DONOR_ONLY' USING ERRCODE = '42501';
    END IF;
    IF v_notice.reserved_quantity < v_claim.quantity THEN
      RAISE EXCEPTION 'INVENTORY_INTEGRITY_ERROR';
    END IF;
    UPDATE public.free_notices
    SET reserved_quantity = reserved_quantity - v_claim.quantity, updated_at = v_now
    WHERE id = v_notice.id;

    UPDATE public.free_notice_claims
    SET status = 'expired', updated_at = v_now
    WHERE id = v_claim.id
    RETURNING * INTO v_claim;

    -- Mandatory transactional notifications (NULL pref_group: never suppressed by optional community prefs!)
    PERFORM public.safe_insert_member_notification(
      v_claim.recipient_id,
      'free_claim_expired',
      NULL,
      'Reservation expired (' || v_claim.claim_code || ')',
      'Your 48-hour pickup reservation for "' || v_notice.title || '" expired and units were released.',
      '/free-items',
      'don-' || v_claim.id::text || '-expired-recipient'
    );
    PERFORM public.safe_insert_member_notification(
      v_claim.donor_id,
      'free_claim_expired',
      NULL,
      'Reservation expired (' || v_claim.claim_code || ')',
      'An uncollected 48-hour reservation for "' || v_notice.title || '" expired and units returned to available stock.',
      '/free-items',
      'don-' || v_claim.id::text || '-expired-donor'
    );

    RETURN QUERY SELECT v_claim.id, v_claim.status, v_claim.updated_at;
    RETURN;
  END IF;

  IF v_act = 'accept' THEN
    IF v_uid <> v_claim.donor_id THEN RAISE EXCEPTION 'FORBIDDEN_DONOR_ONLY' USING ERRCODE = '42501'; END IF;
    IF v_claim.status <> 'requested' THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
    -- Both donor (active student) and recipient (active member) must remain eligible before accepting a reservation!
    IF NOT public.is_active_student() THEN
      RAISE EXCEPTION 'FORBIDDEN_ACTIVE_STUDENT_ONLY' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = v_claim.recipient_id AND lower(COALESCE(p.status, '')) = 'active'
    ) THEN
      RAISE EXCEPTION 'RECIPIENT_ACCOUNT_INACTIVE';
    END IF;
    IF v_notice.status <> 'active' OR v_notice.expires_at <= v_now THEN
      RAISE EXCEPTION 'FREE_ITEM_UNAVAILABLE';
    END IF;
    IF public.internal_is_blocked_between(v_claim.donor_id, v_claim.recipient_id) THEN
      RAISE EXCEPTION 'INTERACTION_BLOCKED' USING ERRCODE = '42501';
    END IF;
    IF (v_notice.quantity - v_notice.reserved_quantity) < v_claim.quantity THEN
      RAISE EXCEPTION 'INSUFFICIENT_FREE_QUANTITY';
    END IF;
    UPDATE public.free_notices
    SET reserved_quantity = reserved_quantity + v_claim.quantity, updated_at = v_now
    WHERE id = v_notice.id;
    v_next := 'reserved';
    v_notify_uid := v_claim.recipient_id;
    v_notify_title := 'Free item reserved (' || v_claim.claim_code || ')';
    v_notify_pref_group := NULL; -- Mandatory: accepted reservation
  ELSIF v_act = 'decline' THEN
    IF v_uid <> v_claim.donor_id THEN RAISE EXCEPTION 'FORBIDDEN_DONOR_ONLY' USING ERRCODE = '42501'; END IF;
    IF v_claim.status <> 'requested' THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
    v_next := 'declined';
    v_notify_uid := v_claim.recipient_id;
    v_notify_title := 'Free item claim declined (' || v_claim.claim_code || ')';
    v_notify_pref_group := 'community'; -- Optional inquiry response
  ELSIF v_act = 'handover' THEN
    IF v_uid <> v_claim.donor_id THEN RAISE EXCEPTION 'FORBIDDEN_DONOR_ONLY' USING ERRCODE = '42501'; END IF;
    IF v_claim.status <> 'reserved' THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
    v_next := 'handed_over';
    v_notify_uid := v_claim.recipient_id;
    v_notify_title := 'Donor recorded handover (' || v_claim.claim_code || ')';
    v_notify_pref_group := NULL; -- Mandatory: handover recorded
  ELSIF v_act = 'collect' THEN
    IF v_uid <> v_claim.recipient_id THEN RAISE EXCEPTION 'FORBIDDEN_RECIPIENT_ONLY' USING ERRCODE = '42501'; END IF;
    IF v_claim.status <> 'handed_over' THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
    -- P0.6: Explicit inventory integrity check (NEVER use GREATEST(0,...) to hide corruption!)
    IF v_notice.reserved_quantity < v_claim.quantity OR v_notice.quantity < v_claim.quantity THEN
      RAISE EXCEPTION 'INVENTORY_INTEGRITY_ERROR';
    END IF;
    UPDATE public.free_notices
    SET quantity = quantity - v_claim.quantity,
        reserved_quantity = reserved_quantity - v_claim.quantity,
        status = CASE WHEN (quantity - v_claim.quantity) = 0 THEN 'closed' ELSE status END,
        updated_at = v_now
    WHERE id = v_notice.id;
    v_next := 'collected';
    v_notify_uid := v_claim.donor_id;
    v_notify_title := 'Donation collected (' || v_claim.claim_code || ')';
    v_notify_pref_group := NULL; -- Mandatory: collection confirmed
  ELSIF v_act = 'cancel' THEN
    IF v_claim.status NOT IN ('requested', 'reserved') THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
    IF v_claim.status = 'reserved' THEN
      IF v_notice.reserved_quantity < v_claim.quantity THEN
        RAISE EXCEPTION 'INVENTORY_INTEGRITY_ERROR';
      END IF;
      UPDATE public.free_notices
      SET reserved_quantity = reserved_quantity - v_claim.quantity, updated_at = v_now
      WHERE id = v_notice.id;
    END IF;
    v_next := 'cancelled';
    v_notify_uid := CASE WHEN v_uid = v_claim.donor_id THEN v_claim.recipient_id ELSE v_claim.donor_id END;
    v_notify_title := 'Free item claim cancelled (' || v_claim.claim_code || ')';
    -- Mandatory when cancelling an accepted reservation; optional when cancelling an unaccepted inquiry!
    v_notify_pref_group := CASE WHEN v_prev_status = 'reserved' THEN NULL ELSE 'community' END;
  ELSE
    RAISE EXCEPTION 'INVALID_ACTION';
  END IF;

  UPDATE public.free_notice_claims c
  SET status = v_next,
      cancellation_reason = CASE WHEN v_act IN ('decline', 'cancel') THEN COALESCE(v_reason, c.cancellation_reason) ELSE c.cancellation_reason END,
      reservation_expires_at = CASE WHEN v_next = 'reserved' THEN v_now + interval '48 hours' ELSE c.reservation_expires_at END,
      accepted_at = CASE WHEN v_next = 'reserved' THEN v_now ELSE c.accepted_at END,
      handed_over_at = CASE WHEN v_next = 'handed_over' THEN v_now ELSE c.handed_over_at END,
      collected_at = CASE WHEN v_next = 'collected' THEN v_now ELSE c.collected_at END,
      updated_at = v_now
  WHERE c.id = v_claim.id
  RETURNING * INTO v_claim;

  UPDATE public.profiles SET last_active_at = v_now WHERE id = v_uid;

  PERFORM public.safe_insert_member_notification(
    v_notify_uid,
    'free_claim_' || v_next,
    v_notify_pref_group,
    v_notify_title,
    'Free item "' || v_notice.title || '" updated to ' || replace(v_next, '_', ' ') || '.',
    '/free-items',
    'don-' || v_claim.id::text || '-' || v_next
  );

  RETURN QUERY SELECT v_claim.id, v_claim.status, v_claim.updated_at;
END;
$$;

REVOKE ALL ON FUNCTION public.update_free_notice_claim_atomic(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_free_notice_claim_atomic(uuid, text, text) TO authenticated;

-- =============================================================================
-- SECTION 5: Public Storefront Enhancements (P0.10)
-- =============================================================================
ALTER TABLE public.storefronts
  ADD COLUMN IF NOT EXISTS banner_path text,
  ADD COLUMN IF NOT EXISTS business_info text,
  ADD COLUMN IF NOT EXISTS is_open boolean NOT NULL DEFAULT true;

-- =============================================================================
-- SECTION 6: Verified Reviews, Buyer Edit, Seller Response & Moderation (P0.4/P0.8)
-- =============================================================================
ALTER TABLE public.reviews
  ALTER COLUMN order_id DROP NOT NULL;

ALTER TABLE public.reviews
  ADD COLUMN IF NOT EXISTS service_request_id uuid REFERENCES public.service_requests(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS seller_response text,
  ADD COLUMN IF NOT EXISTS seller_responded_at timestamptz,
  ADD COLUMN IF NOT EXISTS moderation_reason text,
  ADD COLUMN IF NOT EXISTS moderated_by uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS moderated_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_one_per_order_listing
  ON public.reviews (order_id, listing_id)
  WHERE order_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_one_per_service_request
  ON public.reviews (service_request_id)
  WHERE service_request_id IS NOT NULL;

DROP FUNCTION IF EXISTS public.submit_verified_review_atomic(uuid, uuid, uuid, integer, text);
CREATE OR REPLACE FUNCTION public.submit_verified_review_atomic(
  p_order_id uuid,
  p_listing_id uuid,
  p_service_request_id uuid,
  p_rating integer,
  p_comment text
)
RETURNS TABLE (
  out_id         uuid,
  out_rating     integer,
  out_created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_order public.orders;
  v_sr public.service_requests;
  v_seller_id uuid;
  v_listing_id uuid := p_listing_id;
  v_clean_comment text := trim(COALESCE(p_comment, ''));
  v_now timestamptz := clock_timestamp();
  v_row public.reviews;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;
  IF p_rating IS NULL OR p_rating < 1 OR p_rating > 5 THEN
    RAISE EXCEPTION 'INVALID_RATING';
  END IF;
  IF length(v_clean_comment) < 5 OR length(v_clean_comment) > 1000 THEN
    RAISE EXCEPTION 'INVALID_REVIEW_COMMENT';
  END IF;
  IF (p_order_id IS NULL AND p_service_request_id IS NULL)
     OR (p_order_id IS NOT NULL AND p_service_request_id IS NOT NULL) THEN
    RAISE EXCEPTION 'INVALID_REVIEW_TARGET';
  END IF;

  IF p_order_id IS NOT NULL THEN
    SELECT o.* INTO v_order FROM public.orders o WHERE o.id = p_order_id FOR SHARE;
    IF NOT FOUND OR v_order.buyer_id <> v_uid THEN
      RAISE EXCEPTION 'FORBIDDEN_BUYER_ONLY' USING ERRCODE = '42501';
    END IF;
    IF v_order.seller_id = v_uid THEN RAISE EXCEPTION 'CANNOT_SELF_REVIEW'; END IF;
    IF v_order.status <> 'completed' OR NOT public.is_order_payment_verified(v_order.id) THEN
      RAISE EXCEPTION 'ORDER_NOT_ELIGIBLE_FOR_REVIEW';
    END IF;
    -- Block reviews on fully refunded or actively disputed orders
    IF EXISTS (
      SELECT 1 FROM public.order_refunds r
      WHERE r.order_id = v_order.id AND r.refund_type = 'full_refund' AND r.status = 'succeeded'
    ) OR EXISTS (
      SELECT 1 FROM public.order_disputes d
      WHERE d.order_id = v_order.id AND d.status IN ('open', 'under_review')
    ) THEN
      RAISE EXCEPTION 'ORDER_NOT_ELIGIBLE_FOR_REVIEW';
    END IF;
    IF v_listing_id IS NULL THEN
      SELECT oi.listing_id INTO v_listing_id FROM public.order_items oi WHERE oi.order_id = v_order.id LIMIT 1;
    ELSIF NOT EXISTS (
      SELECT 1 FROM public.order_items oi WHERE oi.order_id = v_order.id AND oi.listing_id = v_listing_id
    ) THEN
      RAISE EXCEPTION 'LISTING_NOT_IN_ORDER';
    END IF;
    v_seller_id := v_order.seller_id;
  ELSE
    SELECT sr.* INTO v_sr FROM public.service_requests sr WHERE sr.id = p_service_request_id FOR SHARE;
    IF NOT FOUND OR v_sr.buyer_id <> v_uid THEN
      RAISE EXCEPTION 'FORBIDDEN_BUYER_ONLY' USING ERRCODE = '42501';
    END IF;
    IF v_sr.seller_id = v_uid THEN RAISE EXCEPTION 'CANNOT_SELF_REVIEW'; END IF;
    IF v_sr.status <> 'completed' THEN RAISE EXCEPTION 'SERVICE_NOT_ELIGIBLE_FOR_REVIEW'; END IF;
    v_seller_id := v_sr.seller_id;
    v_listing_id := v_sr.listing_id;
  END IF;

  INSERT INTO public.reviews (
    order_id, listing_id, service_request_id, buyer_id, seller_id,
    rating, comment, hidden, created_at, updated_at
  ) VALUES (
    p_order_id, v_listing_id, p_service_request_id, v_uid, v_seller_id,
    p_rating, v_clean_comment, false, v_now, v_now
  )
  RETURNING * INTO v_row;

  UPDATE public.profiles SET last_active_at = v_now WHERE id = v_uid;

  PERFORM public.safe_insert_member_notification(
    v_seller_id,
    'review_received',
    'reviews',
    'New ' || p_rating || '-star verified review',
    left(v_clean_comment, 120),
    '/seller/analytics',
    'rev-' || v_row.id::text
  );

  RETURN QUERY SELECT v_row.id, v_row.rating, v_row.created_at;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_verified_review_atomic(uuid, uuid, uuid, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_verified_review_atomic(uuid, uuid, uuid, integer, text) TO authenticated;

-- Buyer own-review edit RPC (within 7 days of creation; cannot alter seller_response or hidden!)
DROP FUNCTION IF EXISTS public.edit_verified_review_atomic(uuid, integer, text);
CREATE OR REPLACE FUNCTION public.edit_verified_review_atomic(
  p_review_id uuid,
  p_rating integer,
  p_comment text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_rev public.reviews;
  v_clean text := trim(COALESCE(p_comment, ''));
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;
  IF p_rating IS NULL OR p_rating < 1 OR p_rating > 5 THEN RAISE EXCEPTION 'INVALID_RATING'; END IF;
  IF length(v_clean) < 5 OR length(v_clean) > 1000 THEN RAISE EXCEPTION 'INVALID_REVIEW_COMMENT'; END IF;

  SELECT r.* INTO v_rev FROM public.reviews r WHERE r.id = p_review_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'REVIEW_NOT_FOUND'; END IF;
  IF v_rev.buyer_id <> v_uid THEN RAISE EXCEPTION 'FORBIDDEN_BUYER_ONLY' USING ERRCODE = '42501'; END IF;
  IF v_rev.hidden THEN RAISE EXCEPTION 'REVIEW_MODERATED'; END IF;
  IF v_now > v_rev.created_at + interval '7 days' THEN RAISE EXCEPTION 'REVIEW_EDIT_WINDOW_EXPIRED'; END IF;

  UPDATE public.reviews
  SET rating = p_rating, comment = v_clean, edited_at = v_now, updated_at = v_now
  WHERE id = v_rev.id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.edit_verified_review_atomic(uuid, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.edit_verified_review_atomic(uuid, integer, text) TO authenticated;

DROP FUNCTION IF EXISTS public.respond_to_review_atomic(uuid, text);
CREATE OR REPLACE FUNCTION public.respond_to_review_atomic(
  p_review_id uuid,
  p_response text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_rev public.reviews;
  v_clean text := trim(COALESCE(p_response, ''));
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;
  IF length(v_clean) < 3 OR length(v_clean) > 800 THEN RAISE EXCEPTION 'INVALID_RESPONSE'; END IF;

  SELECT r.* INTO v_rev FROM public.reviews r WHERE r.id = p_review_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'REVIEW_NOT_FOUND'; END IF;
  IF v_rev.seller_id <> v_uid THEN RAISE EXCEPTION 'FORBIDDEN_SELLER_ONLY' USING ERRCODE = '42501'; END IF;

  UPDATE public.reviews
  SET seller_response = v_clean, seller_responded_at = v_now, updated_at = v_now
  WHERE id = v_rev.id;

  PERFORM public.safe_insert_member_notification(
    v_rev.buyer_id,
    'review_response',
    'reviews',
    'Seller replied to your review',
    left(v_clean, 120),
    '/orders',
    'rev-reply-' || v_rev.id::text
  );

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.respond_to_review_atomic(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.respond_to_review_atomic(uuid, text) TO authenticated;

-- =============================================================================
-- SECTION 7: Reports, Admin Moderation, Catalog & Notifications (P0.1/P0.3/P0.7/P0.16/P0.18)
-- =============================================================================
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS moderated_prev_status text,
  ADD COLUMN IF NOT EXISTS moderated_by uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS moderated_at timestamptz,
  ADD COLUMN IF NOT EXISTS moderation_reason text;

-- P0.16 & Moderation Integrity: SECURITY INVOKER guard protecting listing moderation fields
-- on INSERT, UPDATE, and DELETE (blocks owner DELETE of admin-hidden listings to preserve moderation history!)
CREATE OR REPLACE FUNCTION public.guard_admin_hidden_listing_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user IN ('postgres', 'service_role') OR public.is_active_admin() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'hidden' THEN
      RAISE EXCEPTION 'LISTING_MODERATED_BY_ADMIN' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.moderated_prev_status IS NOT NULL
       OR NEW.moderated_by IS NOT NULL
       OR NEW.moderated_at IS NOT NULL
       OR NEW.moderation_reason IS NOT NULL
       OR NEW.status = 'hidden' THEN
      RAISE EXCEPTION 'FORBIDDEN_MODERATION_FIELDS' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE by non-admin owner: moderation metadata is strictly immutable & admin-hidden listings cannot be restored!
  IF NEW.moderated_prev_status IS DISTINCT FROM OLD.moderated_prev_status
     OR NEW.moderated_by IS DISTINCT FROM OLD.moderated_by
     OR NEW.moderated_at IS DISTINCT FROM OLD.moderated_at
     OR NEW.moderation_reason IS DISTINCT FROM OLD.moderation_reason THEN
    RAISE EXCEPTION 'FORBIDDEN_MODERATION_FIELDS' USING ERRCODE = '42501';
  END IF;

  IF OLD.status = 'hidden' AND NEW.status <> 'hidden' THEN
    RAISE EXCEPTION 'LISTING_MODERATED_BY_ADMIN' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_listings_guard_admin_hidden ON public.listings;
CREATE TRIGGER trg_listings_guard_admin_hidden
  BEFORE INSERT OR UPDATE OR DELETE ON public.listings
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_admin_hidden_listing_trigger();

ALTER TABLE public.reports
  ADD COLUMN IF NOT EXISTS report_code text,
  ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS admin_notes text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- P0.1: Canonical report statuses preserving hosted 'submitted' + safely adding 'dismissed'
DO $$
DECLARE v_con text;
BEGIN
  FOR v_con IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.reports'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE public.reports DROP CONSTRAINT IF EXISTS %I', v_con);
  END LOOP;

  ALTER TABLE public.reports
    ADD CONSTRAINT reports_status_check
    CHECK (status IN ('submitted', 'under_review', 'resolved', 'dismissed'));
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_report_code
  ON public.reports (report_code)
  WHERE report_code IS NOT NULL;

DROP INDEX IF EXISTS public.idx_reports_one_open_per_reporter_target;
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_one_open_per_reporter_target
  ON public.reports (reporter_id, target_kind, target_id)
  WHERE status IN ('submitted', 'under_review');

-- P0.7: Validate target existence, participant access, and controlled reason whitelist in SQL!
DROP FUNCTION IF EXISTS public.submit_report_atomic(text, uuid, text, text);
CREATE OR REPLACE FUNCTION public.submit_report_atomic(
  p_target_kind text,
  p_target_id uuid,
  p_reason text,
  p_explanation text
)
RETURNS TABLE (
  out_id          uuid,
  out_report_code text,
  out_status      text,
  out_created_at  timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_kind text := lower(trim(COALESCE(p_target_kind, '')));
  v_reason text := trim(COALESCE(p_reason, ''));
  v_expl text := trim(COALESCE(p_explanation, ''));
  v_now timestamptz := clock_timestamp();
  v_code text;
  v_priority text;
  v_row public.reports;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;

  IF v_kind NOT IN ('listing', 'user', 'review', 'message', 'free_notice') OR p_target_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_REPORT_TARGET';
  END IF;

  IF v_reason NOT IN (
    'Misleading listing',
    'Prohibited item',
    'Scam or suspicious activity',
    'Harassment',
    'Inappropriate content',
    'Spam',
    'Impersonation',
    'Other policy violation'
  ) THEN
    RAISE EXCEPTION 'INVALID_REPORT_REASON';
  END IF;

  IF length(v_expl) < 10 OR length(v_expl) > 1500 THEN
    RAISE EXCEPTION 'INVALID_REPORT_DETAILS';
  END IF;

  -- Target visibility & participant authorization checks (neutral REPORT_TARGET_NOT_FOUND prevents probing private drafts/messages!)
  IF v_kind = 'user' THEN
    IF p_target_id = v_uid THEN RAISE EXCEPTION 'CANNOT_REPORT_SELF'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_target_id) THEN
      RAISE EXCEPTION 'REPORT_TARGET_NOT_FOUND';
    END IF;
  ELSIF v_kind = 'listing' THEN
    -- Published listings OR legitimate historical participant (orders/services/offers); unrelated private drafts cannot be probed!
    IF NOT EXISTS (
      SELECT 1 FROM public.listings l
      WHERE l.id = p_target_id
        AND (
          l.status = 'published'
          OR EXISTS (
            SELECT 1 FROM public.order_items oi
            JOIN public.orders o ON o.id = oi.order_id
            WHERE oi.listing_id = l.id AND (o.buyer_id = v_uid OR o.seller_id = v_uid)
          )
          OR EXISTS (
            SELECT 1 FROM public.service_requests sr
            WHERE sr.listing_id = l.id AND (sr.buyer_id = v_uid OR sr.seller_id = v_uid)
          )
          OR EXISTS (
            SELECT 1 FROM public.offers ofr
            WHERE ofr.listing_id = l.id AND (ofr.buyer_id = v_uid OR ofr.seller_id = v_uid)
          )
        )
    ) THEN
      RAISE EXCEPTION 'REPORT_TARGET_NOT_FOUND';
    END IF;
  ELSIF v_kind = 'free_notice' THEN
    -- Active notices OR legitimate historical claim participant
    IF NOT EXISTS (
      SELECT 1 FROM public.free_notices fn
      WHERE fn.id = p_target_id
        AND (
          fn.status = 'active'
          OR EXISTS (
            SELECT 1 FROM public.free_notice_claims fc
            WHERE fc.notice_id = fn.id AND (fc.donor_id = v_uid OR fc.recipient_id = v_uid)
          )
        )
    ) THEN
      RAISE EXCEPTION 'REPORT_TARGET_NOT_FOUND';
    END IF;
  ELSIF v_kind = 'review' THEN
    -- Publicly visible review OR authorized participant (buyer/seller)
    IF NOT EXISTS (
      SELECT 1 FROM public.reviews r
      WHERE r.id = p_target_id
        AND (r.hidden = false OR r.buyer_id = v_uid OR r.seller_id = v_uid)
    ) THEN
      RAISE EXCEPTION 'REPORT_TARGET_NOT_FOUND';
    END IF;
  ELSIF v_kind = 'message' THEN
    -- Conversation participant only; neutral error avoids probing unrelated private message UUIDs
    IF NOT EXISTS (
      SELECT 1 FROM public.messages m
      JOIN public.conversations c ON c.id = m.conversation_id
      WHERE m.id = p_target_id AND (c.member_a = v_uid OR c.member_b = v_uid)
    ) THEN
      RAISE EXCEPTION 'REPORT_TARGET_NOT_FOUND';
    END IF;
  END IF;

  v_priority := CASE
    WHEN lower(v_reason) IN ('scam or suspicious activity', 'prohibited item', 'harassment') THEN 'high'
    ELSE 'normal'
  END;

  v_code := 'RPT-'
    || to_char(v_now AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYMM')
    || '-'
    || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

  INSERT INTO public.reports (
    report_code, reporter_id, target_kind, target_id, reason, explanation,
    priority, status, created_at, updated_at
  ) VALUES (
    v_code, v_uid, v_kind, p_target_id, v_reason, v_expl,
    v_priority, 'submitted', v_now, v_now
  )
  RETURNING * INTO v_row;

  UPDATE public.profiles SET last_active_at = v_now WHERE id = v_uid;

  RETURN QUERY SELECT v_row.id, v_row.report_code, v_row.status, v_row.created_at;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_report_atomic(text, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_report_atomic(text, uuid, text, text) TO authenticated;

-- Admin report moderation (prevents invalid reopening of resolved/dismissed reports)
DROP FUNCTION IF EXISTS public.admin_moderate_report_atomic(uuid, text, text, text);
CREATE OR REPLACE FUNCTION public.admin_moderate_report_atomic(
  p_report_id uuid,
  p_status text,
  p_outcome text,
  p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_rep public.reports;
  v_st text := lower(trim(COALESCE(p_status, '')));
  v_reason text := trim(COALESCE(p_reason, ''));
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_st NOT IN ('under_review', 'resolved', 'dismissed') THEN
    RAISE EXCEPTION 'INVALID_REPORT_STATUS';
  END IF;
  IF length(v_reason) < 5 THEN
    RAISE EXCEPTION 'MODERATION_REASON_REQUIRED';
  END IF;

  SELECT r.* INTO v_rep FROM public.reports r WHERE r.id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'REPORT_NOT_FOUND'; END IF;

  IF v_rep.status IN ('resolved', 'dismissed') THEN
    RAISE EXCEPTION 'REPORT_ALREADY_FINALIZED';
  END IF;

  UPDATE public.reports
  SET status = v_st,
      outcome = NULLIF(trim(COALESCE(p_outcome, '')), ''),
      admin_notes = v_reason,
      resolved_by = CASE WHEN v_st IN ('resolved', 'dismissed') THEN v_uid ELSE resolved_by END,
      resolved_at = CASE WHEN v_st IN ('resolved', 'dismissed') THEN v_now ELSE resolved_at END,
      updated_at = v_now
  WHERE id = v_rep.id;

  PERFORM public.log_admin_audit_internal(
    v_uid, 'report_' || v_st, 'report', v_rep.id, v_reason,
    jsonb_build_object('report_code', v_rep.report_code, 'previous_status', v_rep.status, 'new_status', v_st, 'outcome', p_outcome)
  );

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_moderate_report_atomic(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_moderate_report_atomic(uuid, text, text, text) TO authenticated;

-- P0.1: User moderation mapped cleanly to hosted profiles statuses ('active' | 'suspended')!
DROP FUNCTION IF EXISTS public.admin_moderate_user_atomic(uuid, text, text);
CREATE OR REPLACE FUNCTION public.admin_moderate_user_atomic(
  p_target_user_id uuid,
  p_action text,
  p_reason text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_prof public.profiles;
  v_act text := lower(trim(COALESCE(p_action, '')));
  v_reason text := trim(COALESCE(p_reason, ''));
  v_next_status text;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY' USING ERRCODE = '42501';
  END IF;
  IF length(v_reason) < 5 THEN RAISE EXCEPTION 'MODERATION_REASON_REQUIRED'; END IF;

  SELECT p.* INTO v_prof FROM public.profiles p WHERE p.id = p_target_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;

  IF v_act = 'warn' THEN
    v_next_status := v_prof.status;
  ELSIF v_act IN ('restrict', 'suspend') THEN
    -- Block suspend-then-restore bypass on permanently closed accounts!
    IF v_prof.status = 'closed' THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_CLOSED_ACCOUNT';
    END IF;
    -- Maps cleanly to hosted profiles_status_check ('suspended') with explicit restriction_reason
    v_next_status := 'suspended';
  ELSIF v_act = 'restore' THEN
    -- NEVER reactivate permanently closed accounts! Only suspended accounts may be restored.
    IF v_prof.status = 'closed' THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_CLOSED_ACCOUNT';
    END IF;
    v_next_status := 'active';
  ELSE
    RAISE EXCEPTION 'INVALID_USER_MODERATION_ACTION';
  END IF;

  UPDATE public.profiles
  SET status = v_next_status,
      restriction_reason = CASE WHEN v_next_status = 'active' THEN NULL ELSE v_reason END,
      updated_at = v_now
  WHERE id = v_prof.id;

  PERFORM public.log_admin_audit_internal(
    v_uid, 'user_' || v_act, 'user', v_prof.id, v_reason,
    jsonb_build_object('previous_status', v_prof.status, 'new_status', v_next_status)
  );

  PERFORM public.safe_insert_notification(
    v_prof.id,
    'account_' || v_act,
    CASE v_act
      WHEN 'warn' THEN 'Account warning from Buy-U Moderation'
      WHEN 'restrict' THEN 'Account suspended / restricted'
      WHEN 'suspend' THEN 'Account suspended'
      ELSE 'Account restored to active'
    END,
    v_reason,
    '/account',
    'mod-user-' || v_prof.id::text || '-' || extract(epoch from v_now)::bigint::text
  );

  RETURN v_next_status;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_moderate_user_atomic(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_moderate_user_atomic(uuid, text, text) TO authenticated;

-- P0.1: Listing moderation uses hosted 'hidden' (NEVER 'removed') and restores exact previous status!
DROP FUNCTION IF EXISTS public.admin_moderate_listing_atomic(uuid, boolean, text);
CREATE OR REPLACE FUNCTION public.admin_moderate_listing_atomic(
  p_listing_id uuid,
  p_hide boolean,
  p_reason text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_listing public.listings;
  v_reason text := trim(COALESCE(p_reason, ''));
  v_next text;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY' USING ERRCODE = '42501';
  END IF;
  IF length(v_reason) < 5 THEN RAISE EXCEPTION 'MODERATION_REASON_REQUIRED'; END IF;

  SELECT l.* INTO v_listing FROM public.listings l WHERE l.id = p_listing_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LISTING_NOT_FOUND'; END IF;

  IF COALESCE(p_hide, true) THEN
    v_next := 'hidden';
    UPDATE public.listings
    SET status = 'hidden',
        moderated_prev_status = CASE WHEN status <> 'hidden' THEN status ELSE moderated_prev_status END,
        moderated_by = v_uid,
        moderated_at = v_now,
        moderation_reason = v_reason,
        updated_at = v_now
    WHERE id = v_listing.id;
  ELSE
    -- Idempotent: repeated restore on a non-hidden listing MUST NOT archive a currently published listing!
    IF v_listing.status <> 'hidden' THEN
      RETURN v_listing.status;
    END IF;
    -- Restore exact prior status (defaults to 'archived' if unknown, never blind-publishing drafts!)
    v_next := CASE
      WHEN v_listing.moderated_prev_status IN ('draft', 'published', 'archived') THEN v_listing.moderated_prev_status
      ELSE 'archived'
    END;
    UPDATE public.listings
    SET status = v_next,
        moderated_prev_status = NULL,
        moderated_by = NULL,
        moderated_at = NULL,
        moderation_reason = NULL,
        updated_at = v_now
    WHERE id = v_listing.id;
  END IF;

  PERFORM public.log_admin_audit_internal(
    v_uid, CASE WHEN COALESCE(p_hide, true) THEN 'listing_hidden' ELSE 'listing_restored' END,
    'listing', v_listing.id, v_reason,
    jsonb_build_object('previous_status', v_listing.status, 'new_status', v_next)
  );

  RETURN v_next;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_moderate_listing_atomic(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_moderate_listing_atomic(uuid, boolean, text) TO authenticated;

-- P0.7: Free-item moderation RPC (uses hosted 'hidden' and restores exact previous status!)
DROP FUNCTION IF EXISTS public.admin_moderate_free_notice_atomic(uuid, boolean, text);
CREATE OR REPLACE FUNCTION public.admin_moderate_free_notice_atomic(
  p_notice_id uuid,
  p_hide boolean,
  p_reason text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_fn public.free_notices;
  v_reason text := trim(COALESCE(p_reason, ''));
  v_next text;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY' USING ERRCODE = '42501';
  END IF;
  IF length(v_reason) < 5 THEN RAISE EXCEPTION 'MODERATION_REASON_REQUIRED'; END IF;

  SELECT fn.* INTO v_fn FROM public.free_notices fn WHERE fn.id = p_notice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FREE_NOTICE_NOT_FOUND'; END IF;

  IF COALESCE(p_hide, true) THEN
    v_next := 'hidden';
    UPDATE public.free_notices
    SET status = 'hidden',
        moderated_prev_status = CASE WHEN status <> 'hidden' THEN status ELSE moderated_prev_status END,
        updated_at = v_now
    WHERE id = v_fn.id;
  ELSE
    -- Idempotent: repeated restore on a non-hidden free notice MUST NOT change an active notice to closed!
    IF v_fn.status <> 'hidden' THEN
      RETURN v_fn.status;
    END IF;
    v_next := CASE WHEN v_fn.moderated_prev_status IN ('active', 'closed') THEN v_fn.moderated_prev_status ELSE 'closed' END;
    UPDATE public.free_notices
    SET status = v_next, moderated_prev_status = NULL, updated_at = v_now
    WHERE id = v_fn.id;
  END IF;

  PERFORM public.log_admin_audit_internal(
    v_uid, CASE WHEN COALESCE(p_hide, true) THEN 'free_notice_hidden' ELSE 'free_notice_restored' END,
    'free_notice', v_fn.id, v_reason,
    jsonb_build_object('previous_status', v_fn.status, 'new_status', v_next)
  );

  RETURN v_next;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_moderate_free_notice_atomic(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_moderate_free_notice_atomic(uuid, boolean, text) TO authenticated;

DROP FUNCTION IF EXISTS public.admin_moderate_review_atomic(uuid, boolean, text);
CREATE OR REPLACE FUNCTION public.admin_moderate_review_atomic(
  p_review_id uuid,
  p_hide boolean,
  p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_rev public.reviews;
  v_reason text := trim(COALESCE(p_reason, ''));
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY' USING ERRCODE = '42501';
  END IF;
  IF length(v_reason) < 5 THEN RAISE EXCEPTION 'MODERATION_REASON_REQUIRED'; END IF;

  SELECT r.* INTO v_rev FROM public.reviews r WHERE r.id = p_review_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'REVIEW_NOT_FOUND'; END IF;

  UPDATE public.reviews
  SET hidden = COALESCE(p_hide, true),
      moderation_reason = v_reason,
      moderated_by = v_uid,
      moderated_at = v_now,
      updated_at = v_now
  WHERE id = v_rev.id;

  PERFORM public.log_admin_audit_internal(
    v_uid, CASE WHEN COALESCE(p_hide, true) THEN 'review_hidden' ELSE 'review_restored' END,
    'review', v_rev.id, v_reason,
    jsonb_build_object('previous_hidden', v_rev.hidden, 'new_hidden', COALESCE(p_hide, true))
  );

  RETURN COALESCE(p_hide, true);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_moderate_review_atomic(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_moderate_review_atomic(uuid, boolean, text) TO authenticated;

-- P0.3: Audited catalog toggle for text-ID tables (stores target_ref in details, target_id = NULL!)
DROP FUNCTION IF EXISTS public.admin_toggle_catalog_item_atomic(text, text, boolean, text);
CREATE OR REPLACE FUNCTION public.admin_toggle_catalog_item_atomic(
  p_table text,
  p_item_id text,
  p_active boolean,
  p_reason text DEFAULT 'Admin catalog visibility update'
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_tbl text := lower(trim(COALESCE(p_table, '')));
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_tbl NOT IN ('categories', 'collection_areas', 'donation_spots') THEN
    RAISE EXCEPTION 'INVALID_CATALOG_TABLE';
  END IF;

  IF v_tbl = 'categories' THEN
    UPDATE public.categories SET active = COALESCE(p_active, true) WHERE id = p_item_id;
  ELSIF v_tbl = 'collection_areas' THEN
    UPDATE public.collection_areas SET active = COALESCE(p_active, true) WHERE id = p_item_id;
  ELSE
    UPDATE public.donation_spots SET active = COALESCE(p_active, true) WHERE id = p_item_id;
  END IF;

  IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_ITEM_NOT_FOUND'; END IF;

  PERFORM public.log_admin_audit_internal(
    v_uid, v_tbl || '_' || CASE WHEN COALESCE(p_active, true) THEN 'activated' ELSE 'deactivated' END,
    v_tbl, NULL, p_reason,
    jsonb_build_object('target_ref', p_item_id, 'active', COALESCE(p_active, true))
  );

  RETURN COALESCE(p_active, true);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_toggle_catalog_item_atomic(text, text, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_toggle_catalog_item_atomic(text, text, boolean, text) TO authenticated;

DROP FUNCTION IF EXISTS public.mark_notifications_read_atomic(uuid);
CREATE OR REPLACE FUNCTION public.mark_notifications_read_atomic(p_notification_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_count integer;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501'; END IF;

  IF p_notification_id IS NULL THEN
    UPDATE public.notifications SET read_at = v_now WHERE user_id = v_uid AND read_at IS NULL;
  ELSE
    UPDATE public.notifications SET read_at = v_now WHERE id = p_notification_id AND user_id = v_uid AND read_at IS NULL;
  END IF;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_notifications_read_atomic(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_notifications_read_atomic(uuid) TO authenticated;

-- P0.18: Authorized RPC for Phase 5 messaging `markConversationReadAction` (preserves unread badge clearing after revoking direct notifications UPDATE!)
DROP FUNCTION IF EXISTS public.mark_conversation_notifications_read_atomic(uuid);
CREATE OR REPLACE FUNCTION public.mark_conversation_notifications_read_atomic(p_conversation_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_now timestamptz := clock_timestamp();
  v_remaining integer := 0;
BEGIN
  IF v_uid IS NULL OR p_conversation_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = p_conversation_id
      AND (c.member_a = v_uid OR c.member_b = v_uid)
  ) THEN
    RAISE EXCEPTION 'FORBIDDEN_CONVERSATION' USING ERRCODE = '42501';
  END IF;

  UPDATE public.notifications
  SET read_at = v_now
  WHERE user_id = v_uid
    AND read_at IS NULL
    AND kind IN ('new_message', 'message')
    AND href ILIKE ('%' || p_conversation_id::text || '%');

  SELECT count(*)::integer INTO v_remaining
  FROM public.notifications
  WHERE user_id = v_uid
    AND read_at IS NULL
    AND kind IN ('new_message', 'message');

  RETURN COALESCE(v_remaining, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_conversation_notifications_read_atomic(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_conversation_notifications_read_atomic(uuid) TO authenticated;

-- =============================================================================
-- SECTION 8: Revoke Direct Client State-Machine Bypasses & Explicit Grants (P0.4/P0.7/P0.11/P0.18)
-- =============================================================================
-- Eliminate direct client INSERT/UPDATE/DELETE bypasses; keep required participant SELECT!
REVOKE INSERT, UPDATE, DELETE ON TABLE public.service_requests FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.free_notices FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.listing_views FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.notifications FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.member_blocks FROM PUBLIC, anon, authenticated;

-- P0.18: Protect reviews.moderation_reason, moderated_by & moderated_at from non-admin members via column-level SELECT!
REVOKE ALL ON TABLE public.reviews FROM PUBLIC, anon, authenticated;
GRANT SELECT (
  id, order_id, listing_id, service_request_id, buyer_id, seller_id,
  rating, comment, seller_response, seller_responded_at, hidden, edited_at, created_at
) ON TABLE public.reviews TO authenticated;

-- Protect reports.admin_notes from reporters via column-level SELECT grants (P0.7)
REVOKE ALL ON TABLE public.reports FROM PUBLIC, anon, authenticated;
GRANT SELECT (
  id, report_code, reporter_id, target_kind, target_id, reason, explanation,
  priority, status, outcome, resolved_at, created_at, updated_at
) ON TABLE public.reports TO authenticated;

-- Private drafts table RLS + owner-only access
ALTER TABLE public.free_notice_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.free_notice_drafts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.free_notice_drafts TO authenticated;
DROP POLICY IF EXISTS free_notice_drafts_owner_all ON public.free_notice_drafts;
CREATE POLICY free_notice_drafts_owner_all ON public.free_notice_drafts
  FOR ALL TO authenticated
  USING (contributor_id = auth.uid() AND public.is_active_student())
  WITH CHECK (contributor_id = auth.uid() AND public.is_active_student());

-- Free notice claims RLS + participant SELECT
ALTER TABLE public.free_notice_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.free_notice_claims FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.free_notice_claims TO authenticated;
DROP POLICY IF EXISTS free_notice_claims_select_participant ON public.free_notice_claims;
CREATE POLICY free_notice_claims_select_participant ON public.free_notice_claims
  FOR SELECT TO authenticated
  USING (donor_id = auth.uid() OR recipient_id = auth.uid() OR public.is_active_admin());

-- Explicit service_role grants on ALL new & touched tables + sequences
GRANT ALL ON TABLE public.free_notice_drafts TO service_role;
GRANT ALL ON TABLE public.free_notice_claims TO service_role;
GRANT ALL ON TABLE public.service_requests TO service_role;
GRANT ALL ON TABLE public.free_notices TO service_role;
GRANT ALL ON TABLE public.donation_spots TO service_role;
GRANT ALL ON TABLE public.reviews TO service_role;
GRANT ALL ON TABLE public.reports TO service_role;
GRANT ALL ON TABLE public.member_blocks TO service_role;
GRANT ALL ON TABLE public.admin_audit_logs TO service_role;
GRANT ALL ON TABLE public.listing_views TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- Exclude sensitive/private tables from Realtime publication
DO $$
DECLARE v_tbl text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY[
    'free_notice_drafts', 'free_notice_claims', 'reports', 'member_blocks', 'admin_audit_logs'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = v_tbl
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE public.%I', v_tbl);
    END IF;
  END LOOP;
END;
$$;

COMMIT;
