-- =============================================================================
-- BUY-U V2 — PHASE 2.1 REVIEWED CANDIDATE SECURITY REMEDIATIONS
-- STATUS: REVIEW-ONLY CANDIDATE — DO NOT EXECUTE WITHOUT OWNER APPROVAL
-- TARGET PROJECT: duwwlcpdidrxkixvflag (Buy-U Website)
-- CROSS-CHECKED AGAINST LIVE SCHEMA: 2026-11-23
-- =============================================================================
-- Review docs/security/PHASE-2.1-REMEDIATION-REVIEW.md before running in
-- Supabase SQL Editor. Take a database backup first.

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. PROFILES: Least-Privilege Column-Level UPDATE + Guard Trigger
--    Verified columns: id, email, university_role, status, restriction_reason,
--    full_name, matric_number, display_name, phone, faculty, bio, avatar_url,
--    created_at, updated_at
-- -----------------------------------------------------------------------------
REVOKE UPDATE ON public.profiles FROM authenticated;

GRANT UPDATE (
  display_name,
  faculty,
  bio,
  avatar_url,
  phone,
  updated_at
) ON public.profiles TO authenticated;

CREATE OR REPLACE FUNCTION public.guard_profile_sensitive_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user IN ('postgres', 'service_role') OR public.is_active_admin() THEN
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.email IS DISTINCT FROM OLD.email
     OR NEW.university_role IS DISTINCT FROM OLD.university_role
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.restriction_reason IS DISTINCT FROM OLD.restriction_reason
     OR NEW.full_name IS DISTINCT FROM OLD.full_name
     OR NEW.matric_number IS DISTINCT FROM OLD.matric_number
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Modification of restricted profile columns is not allowed'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_profile_sensitive_columns ON public.profiles;
CREATE TRIGGER trg_guard_profile_sensitive_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_profile_sensitive_columns();

-- -----------------------------------------------------------------------------
-- 2. OFFERS: Least-Privilege Column UPDATE + State-Transition Guard Trigger
--    Verified columns: id, conversation_id, listing_id, buyer_id, seller_id,
--    offer_price_sen, status, order_id, created_at, responded_at
-- -----------------------------------------------------------------------------
REVOKE UPDATE ON public.offers FROM authenticated;

GRANT UPDATE (
  status,
  responded_at
) ON public.offers TO authenticated;

CREATE OR REPLACE FUNCTION public.guard_offer_updates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF current_user IN ('postgres', 'service_role') OR public.is_active_admin() THEN
    RETURN NEW;
  END IF;

  -- Immutable identity, pricing, and order-link fields
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.listing_id IS DISTINCT FROM OLD.listing_id
     OR NEW.buyer_id IS DISTINCT FROM OLD.buyer_id
     OR NEW.seller_id IS DISTINCT FROM OLD.seller_id
     OR NEW.offer_price_sen IS DISTINCT FROM OLD.offer_price_sen
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Offer core fields cannot be modified'
      USING ERRCODE = '42501';
  END IF;

  -- Only pending offers may transition
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'Only pending offers can be updated'
      USING ERRCODE = '42501';
  END IF;

  -- Enforce participant role transitions
  IF v_uid = OLD.buyer_id THEN
    IF NEW.status NOT IN ('withdrawn', 'cancelled') THEN
      RAISE EXCEPTION 'Buyers may only withdraw their own pending offer'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_uid = OLD.seller_id THEN
    IF NEW.status NOT IN ('accepted', 'declined', 'rejected') THEN
      RAISE EXCEPTION 'Sellers may only accept or decline a pending offer'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'Only offer participants may update an offer'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_offer_updates ON public.offers;
CREATE TRIGGER trg_guard_offer_updates
  BEFORE UPDATE ON public.offers
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_offer_updates();

-- -----------------------------------------------------------------------------
-- 3. PUBLIC_PROFILES VIEW: Privacy-Preserving Directory Grants
--    Do NOT blindly set security_invoker=true while profiles RLS is owner/admin
--    only, or seller display names/faculties will disappear for buyers.
-- -----------------------------------------------------------------------------
REVOKE ALL ON public.public_profiles FROM anon, PUBLIC;
GRANT SELECT ON public.public_profiles TO authenticated;

-- -----------------------------------------------------------------------------
-- 4. RPC EXECUTE PRIVILEGES: Least-Privilege Execution
-- -----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.update_listing_atomic(uuid, timestamptz, jsonb, jsonb) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_listing_atomic(uuid, timestamptz, jsonb, jsonb) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM anon, authenticated, PUBLIC;

COMMIT;

-- =============================================================================
-- OPTIONAL READ-ONLY INSPECTION QUERIES (Run in Supabase SQL Editor)
-- =============================================================================
-- SELECT definition FROM pg_views WHERE schemaname = 'public' AND viewname = 'public_profiles';
-- SELECT proname, prosecdef, proconfig, proacl
-- FROM pg_proc
-- WHERE pronamespace = 'public'::regnamespace
--   AND proname IN (
--     'is_active_admin', 'is_active_member', 'is_active_student',
--     'mask_matric', 'rls_auto_enable', 'update_listing_atomic',
--     'handle_new_auth_user'
--   );

-- =============================================================================
-- ROLLBACK SCRIPT (Emergency Use Only)
-- =============================================================================
-- BEGIN;
-- DROP TRIGGER IF EXISTS trg_guard_profile_sensitive_columns ON public.profiles;
-- DROP FUNCTION IF EXISTS public.guard_profile_sensitive_columns();
-- DROP TRIGGER IF EXISTS trg_guard_offer_updates ON public.offers;
-- DROP FUNCTION IF EXISTS public.guard_offer_updates();
-- GRANT UPDATE ON public.profiles TO authenticated;
-- GRANT UPDATE ON public.offers TO authenticated;
-- COMMIT;
