-- =============================================================================
-- Buy-U Phases 7–9 — Consolidated Marketplace Completion Migration
-- STATUS: PROPOSAL ONLY — DO NOT APPLY WITHOUT EXPLICIT OWNER APPROVAL
-- TARGET PROJECT: duwwlcpdidrxkixvflag
--
-- Covers in ONE atomic, additive, dependency-ordered migration:
--   Section 1: Profile Activity, Notification Prefs, Blocking Helpers & Audit Helper
--   Section 2: Listing View Deduplication & Engagement Tracking (Phase 8F)
--   Section 3: Services Marketplace Lifecycle RPCs (Phase 8A — Off-Platform Agreement)
--   Section 4: Free Items, Donation Spots & Atomic Claims (Phase 8B)
--   Section 5: Public Storefront Enhancements (Phase 8C)
--   Section 6: Verified Reviews, Seller Responses & Moderation (Phase 8D)
--   Section 7: Reports, Admin Moderation & Audit Logs (Phase 9B/9C/9D/9F)
--   Section 8: Explicit service_role, authenticated & RLS Grants + Realtime Privacy
--
-- Preserves ALL Phase 1–6 tables, financial records, orders, disputes, refunds,
-- bank accounts, and withdrawals untouched.
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION 1: Profiles Activity/Prefs, Member Blocking & Admin Audit Helpers
-- =============================================================================
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS last_active_at timestamptz,
  ADD COLUMN IF NOT EXISTS notification_prefs jsonb NOT NULL DEFAULT '{"inquiries":true,"reviews":true,"community":true}'::jsonb;

-- Symmetric block check helper
CREATE OR REPLACE FUNCTION public.is_blocked_between(p_user_a uuid, p_user_b uuid)
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

REVOKE ALL ON FUNCTION public.is_blocked_between(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_blocked_between(uuid, uuid) TO authenticated, service_role;

-- Block / unblock RPC (prevents self-block & duplicate rows)
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

-- Centralized admin audit log helper (never stores raw secrets/PINs/bank numbers)
CREATE OR REPLACE FUNCTION public.log_admin_audit_internal(
  p_admin_id uuid,
  p_action text,
  p_target_kind text,
  p_target_id text,
  p_reason text,
  p_details jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
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

REVOKE ALL ON FUNCTION public.log_admin_audit_internal(uuid, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- SECTION 2: Listing View Deduplication & Activity Tracking (Phase 8F)
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

  -- Update member activity timestamp
  UPDATE public.profiles SET last_active_at = v_now WHERE id = v_uid;

  -- Exclude seller viewing own listing from buyer engagement metrics
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
-- SECTION 3: Services Marketplace Lifecycle (Phase 8A — Off-Platform Agreement)
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

CREATE INDEX IF NOT EXISTS idx_service_requests_buyer_id
  ON public.service_requests (buyer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_service_requests_seller_id
  ON public.service_requests (seller_id, created_at DESC);

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
      'requested', 'accepted', 'declined', 'in_progress', 'delivered', 'completed', 'cancelled'
    ));
END;
$$;

DROP FUNCTION IF EXISTS public.create_service_request_atomic(uuid, text, text, text);
CREATE OR REPLACE FUNCTION public.create_service_request_atomic(
  p_listing_id uuid,
  p_mode text,
  p_requirements text,
  p_preferred_date text DEFAULT NULL
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
  v_clean_mode text := lower(trim(COALESCE(p_mode, 'in_person')));
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

  IF v_clean_mode NOT IN ('remote', 'in_person', 'both') THEN
    RAISE EXCEPTION 'INVALID_SERVICE_MODE';
  END IF;

  SELECT l.* INTO v_listing
  FROM public.listings l
  WHERE l.id = p_listing_id
  FOR SHARE;

  IF NOT FOUND OR lower(COALESCE(v_listing.kind, '')) <> 'service' OR v_listing.status <> 'published' THEN
    RAISE EXCEPTION 'SERVICE_UNAVAILABLE';
  END IF;

  IF NOT COALESCE(v_listing.accepting_requests, true) THEN
    RAISE EXCEPTION 'SERVICE_PAUSED';
  END IF;

  IF v_listing.seller_id = v_uid THEN
    RAISE EXCEPTION 'CANNOT_REQUEST_OWN_SERVICE';
  END IF;

  IF public.is_blocked_between(v_uid, v_listing.seller_id) THEN
    RAISE EXCEPTION 'INTERACTION_BLOCKED' USING ERRCODE = '42501';
  END IF;

  -- Prevent duplicate active request from same buyer on same service
  IF EXISTS (
    SELECT 1 FROM public.service_requests sr
    WHERE sr.listing_id = v_listing.id
      AND sr.buyer_id = v_uid
      AND sr.status IN ('requested', 'accepted', 'in_progress', 'delivered')
  ) THEN
    RAISE EXCEPTION 'DUPLICATE_ACTIVE_SERVICE_REQUEST';
  END IF;

  v_code := 'SVC-'
    || to_char(v_now AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYMM')
    || '-'
    || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

  INSERT INTO public.service_requests (
    request_code, listing_id, buyer_id, seller_id, mode, requirements,
    preferred_date, status, respond_by, created_at, updated_at
  ) VALUES (
    v_code, v_listing.id, v_uid, v_listing.seller_id, v_clean_mode, v_clean_req,
    NULLIF(trim(COALESCE(p_preferred_date, '')), ''),
    'requested', v_now + interval '48 hours', v_now, v_now
  )
  RETURNING * INTO v_row;

  UPDATE public.profiles SET last_active_at = v_now WHERE id = v_uid;

  PERFORM public.safe_insert_notification(
    v_listing.seller_id,
    'service_requested',
    'New service request ' || v_code,
    'A member requested "' || v_listing.title || '".',
    '/seller/services',
    'svc-req-' || v_row.id::text
  );

  RETURN QUERY SELECT v_row.id, v_row.request_code, v_row.status, v_row.created_at;
END;
$$;

REVOKE ALL ON FUNCTION public.create_service_request_atomic(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_service_request_atomic(uuid, text, text, text) TO authenticated;

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
  v_act text := lower(trim(COALESCE(p_action, '')));
  v_note text := NULLIF(trim(COALESCE(p_note, '')), '');
  v_now timestamptz := clock_timestamp();
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

  IF v_uid <> v_sr.buyer_id AND v_uid <> v_sr.seller_id THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF v_act = 'accept' THEN
    IF v_uid <> v_sr.seller_id THEN RAISE EXCEPTION 'FORBIDDEN_SELLER_ONLY' USING ERRCODE = '42501'; END IF;
    IF v_sr.status <> 'requested' THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
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
    -- Only buyer confirms satisfactory completion
    IF v_uid <> v_sr.buyer_id THEN RAISE EXCEPTION 'FORBIDDEN_BUYER_ONLY' USING ERRCODE = '42501'; END IF;
    IF v_sr.status <> 'delivered' THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
    v_next := 'completed';
    v_notify_uid := v_sr.seller_id;
    v_notify_title := 'Service ' || COALESCE(v_sr.request_code, '') || ' completed';
    v_notify_href := '/seller/services';
  ELSIF v_act = 'cancel' THEN
    IF v_sr.status NOT IN ('requested', 'accepted', 'in_progress') THEN
      RAISE EXCEPTION 'INVALID_TRANSITION';
    END IF;
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
-- SECTION 4: Free Items, Donation Spots & Atomic Claims (Phase 8B)
-- =============================================================================
ALTER TABLE public.donation_spots
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS operating_info text,
  ADD COLUMN IF NOT EXISTS safety_note text;

ALTER TABLE public.free_notices
  ADD COLUMN IF NOT EXISTS category_id text REFERENCES public.categories(id),
  ADD COLUMN IF NOT EXISTS quantity integer NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  ADD COLUMN IF NOT EXISTS reserved_quantity integer NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0 AND reserved_quantity <= quantity),
  ADD COLUMN IF NOT EXISTS collection_instructions text;

CREATE TABLE IF NOT EXISTS public.free_notice_claims (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_code          text NOT NULL UNIQUE,
  notice_id           uuid NOT NULL REFERENCES public.free_notices(id) ON DELETE RESTRICT,
  donor_id            uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  recipient_id        uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  quantity            integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  note                text,
  status              text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'reserved', 'handed_over', 'collected', 'declined', 'cancelled', 'expired')),
  cancellation_reason text,
  accepted_at         timestamptz,
  handed_over_at      timestamptz,
  collected_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Prevent duplicate active claims by the same recipient on the same free item
CREATE UNIQUE INDEX IF NOT EXISTS idx_free_notice_claims_active_unique
  ON public.free_notice_claims (notice_id, recipient_id)
  WHERE status IN ('requested', 'reserved', 'handed_over');

CREATE INDEX IF NOT EXISTS idx_free_notice_claims_donor
  ON public.free_notice_claims (donor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_free_notice_claims_recipient
  ON public.free_notice_claims (recipient_id, created_at DESC);

-- Claim request RPC (both active Students & Staff may claim; prevents self-claim & over-request)
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
  v_now timestamptz := clock_timestamp();
  v_code text;
  v_row public.free_notice_claims;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;

  IF v_qty <= 0 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY';
  END IF;

  SELECT fn.* INTO v_notice FROM public.free_notices fn WHERE fn.id = p_notice_id FOR UPDATE;
  IF NOT FOUND OR v_notice.status <> 'published' THEN
    RAISE EXCEPTION 'FREE_ITEM_UNAVAILABLE';
  END IF;

  IF v_notice.contributor_id = v_uid THEN
    RAISE EXCEPTION 'CANNOT_CLAIM_OWN_ITEM';
  END IF;

  IF public.is_blocked_between(v_uid, v_notice.contributor_id) THEN
    RAISE EXCEPTION 'INTERACTION_BLOCKED' USING ERRCODE = '42501';
  END IF;

  v_avail := GREATEST(0, v_notice.quantity - v_notice.reserved_quantity);
  IF v_qty > v_avail THEN
    RAISE EXCEPTION 'INSUFFICIENT_FREE_QUANTITY';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.free_notice_claims c
    WHERE c.notice_id = v_notice.id
      AND c.recipient_id = v_uid
      AND c.status IN ('requested', 'reserved', 'handed_over')
  ) THEN
    RAISE EXCEPTION 'DUPLICATE_ACTIVE_CLAIM';
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

  PERFORM public.safe_insert_notification(
    v_notice.contributor_id,
    'free_claim_requested',
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

-- Atomic donor/recipient lifecycle transitions (locks free_notices FIRST -> free_notice_claims)
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
  v_next text;
  v_notify_uid uuid;
  v_notify_title text;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_member() THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;

  SELECT c.notice_id INTO v_notice_id FROM public.free_notice_claims c WHERE c.id = p_claim_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLAIM_NOT_FOUND'; END IF;

  -- Lock free_notices BEFORE free_notice_claims to serialize concurrent acceptances!
  SELECT fn.* INTO v_notice FROM public.free_notices fn WHERE fn.id = v_notice_id FOR UPDATE;
  SELECT c.* INTO v_claim FROM public.free_notice_claims c WHERE c.id = p_claim_id FOR UPDATE;

  IF v_uid <> v_claim.donor_id AND v_uid <> v_claim.recipient_id THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF v_act = 'accept' THEN
    IF v_uid <> v_claim.donor_id THEN RAISE EXCEPTION 'FORBIDDEN_DONOR_ONLY' USING ERRCODE = '42501'; END IF;
    IF v_claim.status <> 'requested' THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
    IF (v_notice.quantity - v_notice.reserved_quantity) < v_claim.quantity THEN
      RAISE EXCEPTION 'INSUFFICIENT_FREE_QUANTITY';
    END IF;
    UPDATE public.free_notices
    SET reserved_quantity = reserved_quantity + v_claim.quantity, updated_at = v_now
    WHERE id = v_notice.id;
    v_next := 'reserved';
    v_notify_uid := v_claim.recipient_id;
    v_notify_title := 'Free item reserved (' || v_claim.claim_code || ')';
  ELSIF v_act = 'decline' THEN
    IF v_uid <> v_claim.donor_id THEN RAISE EXCEPTION 'FORBIDDEN_DONOR_ONLY' USING ERRCODE = '42501'; END IF;
    IF v_claim.status <> 'requested' THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
    v_next := 'declined';
    v_notify_uid := v_claim.recipient_id;
    v_notify_title := 'Free item claim declined (' || v_claim.claim_code || ')';
  ELSIF v_act = 'handover' THEN
    IF v_uid <> v_claim.donor_id THEN RAISE EXCEPTION 'FORBIDDEN_DONOR_ONLY' USING ERRCODE = '42501'; END IF;
    IF v_claim.status <> 'reserved' THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
    v_next := 'handed_over';
    v_notify_uid := v_claim.recipient_id;
    v_notify_title := 'Donor recorded handover (' || v_claim.claim_code || ')';
  ELSIF v_act = 'collect' THEN
    IF v_uid <> v_claim.recipient_id THEN RAISE EXCEPTION 'FORBIDDEN_RECIPIENT_ONLY' USING ERRCODE = '42501'; END IF;
    IF v_claim.status <> 'handed_over' THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
    -- Consume reserved quantity & decrement total available quantity atomically
    UPDATE public.free_notices
    SET quantity = GREATEST(0, quantity - v_claim.quantity),
        reserved_quantity = GREATEST(0, reserved_quantity - v_claim.quantity),
        status = CASE WHEN GREATEST(0, quantity - v_claim.quantity) = 0 THEN 'claimed' ELSE status END,
        updated_at = v_now
    WHERE id = v_notice.id;
    v_next := 'collected';
    v_notify_uid := v_claim.donor_id;
    v_notify_title := 'Donation collected (' || v_claim.claim_code || ')';
  ELSIF v_act = 'cancel' THEN
    IF v_claim.status NOT IN ('requested', 'reserved') THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
    -- Release reservation EXACTLY ONCE if previously reserved
    IF v_claim.status = 'reserved' THEN
      UPDATE public.free_notices
      SET reserved_quantity = GREATEST(0, reserved_quantity - v_claim.quantity), updated_at = v_now
      WHERE id = v_notice.id;
    END IF;
    v_next := 'cancelled';
    v_notify_uid := CASE WHEN v_uid = v_claim.donor_id THEN v_claim.recipient_id ELSE v_claim.donor_id END;
    v_notify_title := 'Free item claim cancelled (' || v_claim.claim_code || ')';
  ELSE
    RAISE EXCEPTION 'INVALID_ACTION';
  END IF;

  UPDATE public.free_notice_claims c
  SET status = v_next,
      cancellation_reason = CASE WHEN v_act IN ('decline', 'cancel') THEN COALESCE(v_reason, c.cancellation_reason) ELSE c.cancellation_reason END,
      accepted_at = CASE WHEN v_next = 'reserved' THEN v_now ELSE c.accepted_at END,
      handed_over_at = CASE WHEN v_next = 'handed_over' THEN v_now ELSE c.handed_over_at END,
      collected_at = CASE WHEN v_next = 'collected' THEN v_now ELSE c.collected_at END,
      updated_at = v_now
  WHERE c.id = v_claim.id
  RETURNING * INTO v_claim;

  UPDATE public.profiles SET last_active_at = v_now WHERE id = v_uid;

  PERFORM public.safe_insert_notification(
    v_notify_uid,
    'free_claim_' || v_next,
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
-- SECTION 5: Public Storefront Enhancements (Phase 8C)
-- =============================================================================
ALTER TABLE public.storefronts
  ADD COLUMN IF NOT EXISTS banner_path text,
  ADD COLUMN IF NOT EXISTS business_info text,
  ADD COLUMN IF NOT EXISTS is_open boolean NOT NULL DEFAULT true;

-- =============================================================================
-- SECTION 6: Verified Reviews, Seller Responses & Moderation (Phase 8D)
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

-- Submit verified review (completed paid order OR completed service request; no self-review; no duplicate)
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
    SELECT o.* INTO v_order FROM public.orders o WHERE o.id = p_order_id;
    IF NOT FOUND OR v_order.buyer_id <> v_uid THEN
      RAISE EXCEPTION 'FORBIDDEN_BUYER_ONLY' USING ERRCODE = '42501';
    END IF;
    IF v_order.seller_id = v_uid THEN
      RAISE EXCEPTION 'CANNOT_SELF_REVIEW';
    END IF;
    IF v_order.status <> 'completed' OR NOT public.is_order_payment_verified(v_order.id) THEN
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
    SELECT sr.* INTO v_sr FROM public.service_requests sr WHERE sr.id = p_service_request_id;
    IF NOT FOUND OR v_sr.buyer_id <> v_uid THEN
      RAISE EXCEPTION 'FORBIDDEN_BUYER_ONLY' USING ERRCODE = '42501';
    END IF;
    IF v_sr.seller_id = v_uid THEN
      RAISE EXCEPTION 'CANNOT_SELF_REVIEW';
    END IF;
    IF v_sr.status <> 'completed' THEN
      RAISE EXCEPTION 'SERVICE_NOT_ELIGIBLE_FOR_REVIEW';
    END IF;
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

  PERFORM public.safe_insert_notification(
    v_seller_id,
    'review_received',
    'New ' || p_rating || '-star verified review',
    left(v_clean_comment, 120),
    '/seller',
    'rev-' || v_row.id::text
  );

  RETURN QUERY SELECT v_row.id, v_row.rating, v_row.created_at;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_verified_review_atomic(uuid, uuid, uuid, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_verified_review_atomic(uuid, uuid, uuid, integer, text) TO authenticated;

-- Seller public response RPC (cannot edit buyer rating/comment or delete review)
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
  IF length(v_clean) < 3 OR length(v_clean) > 800 THEN
    RAISE EXCEPTION 'INVALID_RESPONSE';
  END IF;

  SELECT r.* INTO v_rev FROM public.reviews r WHERE r.id = p_review_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'REVIEW_NOT_FOUND'; END IF;
  IF v_rev.seller_id <> v_uid THEN
    RAISE EXCEPTION 'FORBIDDEN_SELLER_ONLY' USING ERRCODE = '42501';
  END IF;

  UPDATE public.reviews
  SET seller_response = v_clean, seller_responded_at = v_now, updated_at = v_now
  WHERE id = v_rev.id;

  PERFORM public.safe_insert_notification(
    v_rev.buyer_id,
    'review_response',
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
-- SECTION 7: Reports, Admin Moderation, Notifications & Audit Logs (Phase 9)
-- =============================================================================
ALTER TABLE public.reports
  ADD COLUMN IF NOT EXISTS report_code text,
  ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS admin_notes text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_report_code
  ON public.reports (report_code)
  WHERE report_code IS NOT NULL;

-- Prevent duplicate open report spam by the same member on the same target
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_one_open_per_reporter_target
  ON public.reports (reporter_id, target_kind, target_id)
  WHERE status IN ('open', 'under_review');

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

  IF v_kind NOT IN ('listing', 'user', 'review', 'message', 'free_notice') THEN
    RAISE EXCEPTION 'INVALID_REPORT_TARGET';
  END IF;

  IF p_target_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_REPORT_TARGET';
  END IF;

  IF v_kind = 'user' AND p_target_id = v_uid THEN
    RAISE EXCEPTION 'CANNOT_REPORT_SELF';
  END IF;

  IF length(v_reason) < 3 OR length(v_expl) < 10 OR length(v_expl) > 1500 THEN
    RAISE EXCEPTION 'INVALID_REPORT_DETAILS';
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
    v_priority, 'open', v_now, v_now
  )
  RETURNING * INTO v_row;

  UPDATE public.profiles SET last_active_at = v_now WHERE id = v_uid;

  RETURN QUERY SELECT v_row.id, v_row.report_code, v_row.status, v_row.created_at;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_report_atomic(text, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_report_atomic(text, uuid, text, text) TO authenticated;

-- Admin moderation RPCs (all log to admin_audit_logs; never hard-delete financial history)
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
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_st NOT IN ('under_review', 'resolved', 'dismissed') THEN
    RAISE EXCEPTION 'INVALID_REPORT_STATUS';
  END IF;

  SELECT r.* INTO v_rep FROM public.reports r WHERE r.id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'REPORT_NOT_FOUND'; END IF;

  UPDATE public.reports
  SET status = v_st,
      outcome = NULLIF(trim(COALESCE(p_outcome, '')), ''),
      admin_notes = NULLIF(trim(COALESCE(p_reason, '')), ''),
      resolved_by = CASE WHEN v_st IN ('resolved', 'dismissed') THEN v_uid ELSE resolved_by END,
      resolved_at = CASE WHEN v_st IN ('resolved', 'dismissed') THEN v_now ELSE resolved_at END,
      updated_at = v_now
  WHERE id = v_rep.id;

  PERFORM public.log_admin_audit_internal(
    v_uid, 'report_' || v_st, 'report', v_rep.id::text, p_reason,
    jsonb_build_object('report_code', v_rep.report_code, 'previous_status', v_rep.status, 'new_status', v_st, 'outcome', p_outcome)
  );

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_moderate_report_atomic(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_moderate_report_atomic(uuid, text, text, text) TO authenticated;

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
  IF length(v_reason) < 5 THEN
    RAISE EXCEPTION 'MODERATION_REASON_REQUIRED';
  END IF;

  SELECT p.* INTO v_prof FROM public.profiles p WHERE p.id = p_target_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;

  IF v_act = 'warn' THEN
    v_next_status := v_prof.status;
  ELSIF v_act = 'restrict' THEN
    v_next_status := 'restricted';
  ELSIF v_act = 'suspend' THEN
    v_next_status := 'suspended';
  ELSIF v_act = 'restore' THEN
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
    v_uid, 'user_' || v_act, 'user', v_prof.id::text, v_reason,
    jsonb_build_object('previous_status', v_prof.status, 'new_status', v_next_status)
  );

  PERFORM public.safe_insert_notification(
    v_prof.id,
    'account_' || v_act,
    CASE v_act
      WHEN 'warn' THEN 'Account warning from Buy-U Moderation'
      WHEN 'restrict' THEN 'Account restricted'
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
  v_next text := CASE WHEN COALESCE(p_hide, true) THEN 'removed' ELSE 'published' END;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY' USING ERRCODE = '42501';
  END IF;
  IF length(v_reason) < 5 THEN
    RAISE EXCEPTION 'MODERATION_REASON_REQUIRED';
  END IF;

  SELECT l.* INTO v_listing FROM public.listings l WHERE l.id = p_listing_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LISTING_NOT_FOUND'; END IF;

  UPDATE public.listings SET status = v_next, updated_at = v_now WHERE id = v_listing.id;

  PERFORM public.log_admin_audit_internal(
    v_uid, CASE WHEN p_hide THEN 'listing_hidden' ELSE 'listing_restored' END,
    'listing', v_listing.id::text, v_reason,
    jsonb_build_object('previous_status', v_listing.status, 'new_status', v_next)
  );

  RETURN v_next;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_moderate_listing_atomic(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_moderate_listing_atomic(uuid, boolean, text) TO authenticated;

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
  IF length(v_reason) < 5 THEN
    RAISE EXCEPTION 'MODERATION_REASON_REQUIRED';
  END IF;

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
    v_uid, CASE WHEN p_hide THEN 'review_hidden' ELSE 'review_restored' END,
    'review', v_rev.id::text, v_reason,
    jsonb_build_object('previous_hidden', v_rev.hidden, 'new_hidden', COALESCE(p_hide, true))
  );

  RETURN COALESCE(p_hide, true);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_moderate_review_atomic(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_moderate_review_atomic(uuid, boolean, text) TO authenticated;

-- Notification mark-read RPC (user owns notifications only)
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
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;

  IF p_notification_id IS NULL THEN
    UPDATE public.notifications
    SET read_at = v_now
    WHERE user_id = v_uid AND read_at IS NULL;
  ELSE
    UPDATE public.notifications
    SET read_at = v_now
    WHERE id = p_notification_id AND user_id = v_uid AND read_at IS NULL;
  END IF;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_notifications_read_atomic(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_notifications_read_atomic(uuid) TO authenticated;

-- =============================================================================
-- SECTION 8: Explicit Grants, RLS & Realtime Privacy (Zero Missing service_role Grants!)
-- =============================================================================
ALTER TABLE public.free_notice_claims ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.free_notice_claims FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.free_notice_claims TO authenticated;
GRANT ALL ON TABLE public.free_notice_claims TO service_role;

GRANT ALL ON TABLE public.service_requests TO service_role;
GRANT ALL ON TABLE public.free_notices TO service_role;
GRANT ALL ON TABLE public.donation_spots TO service_role;
GRANT ALL ON TABLE public.reviews TO service_role;
GRANT ALL ON TABLE public.reports TO service_role;
GRANT ALL ON TABLE public.member_blocks TO service_role;
GRANT ALL ON TABLE public.admin_audit_logs TO service_role;
GRANT ALL ON TABLE public.listing_views TO service_role;

DROP POLICY IF EXISTS free_notice_claims_select_participant ON public.free_notice_claims;
CREATE POLICY free_notice_claims_select_participant ON public.free_notice_claims
  FOR SELECT TO authenticated
  USING (donor_id = auth.uid() OR recipient_id = auth.uid() OR public.is_active_admin());

-- Ensure private/moderation/audit tables are excluded from Realtime publication
DO $$
DECLARE v_tbl text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY[
    'free_notice_claims', 'reports', 'member_blocks', 'admin_audit_logs'
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
