-- =============================================================================
-- BUY-U V2 — PHASE 2 PROPOSED SECURITY REMEDIATIONS
-- STATUS: REVIEW-ONLY PROPOSAL — DO NOT EXECUTE WITHOUT OWNER APPROVAL
-- TARGET PROJECT: duwwlcpdidrxkixvflag (Buy-U Website)
-- =============================================================================
-- Run each section ONLY after reviewing compatibility and taking a DB backup.

-- -----------------------------------------------------------------------------
-- 1. PROFILES: Least-Privilege Column-Level UPDATE + Guard Trigger
--    Fixes Finding 1 & Finding 2 (prevents self-unsuspend and role escalation)
-- -----------------------------------------------------------------------------
REVOKE UPDATE ON public.profiles FROM authenticated;

GRANT UPDATE (
  display_name,
  faculty,
  bio,
  avatar_url,
  phone
) ON public.profiles TO authenticated;

CREATE OR REPLACE FUNCTION public.guard_profile_sensitive_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Allow service_role / postgres migrations and verified active admins
  IF current_user IN ('postgres', 'service_role') OR public.is_active_admin() THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.university_role IS DISTINCT FROM OLD.university_role
     OR NEW.restriction_reason IS DISTINCT FROM OLD.restriction_reason
     OR NEW.email IS DISTINCT FROM OLD.email
     OR NEW.matric_number IS DISTINCT FROM OLD.matric_number
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
-- 2. OFFERS: Enforce Valid State Transitions & Immutable Core Fields
--    Fixes Finding 3 (prevents buyer self-acceptance or post-decision tampering)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_offer_updates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF current_user IN ('postgres', 'service_role') OR public.is_active_admin() THEN
    RETURN NEW;
  END IF;

  -- Immutable identity & pricing fields once created
  IF NEW.listing_id IS DISTINCT FROM OLD.listing_id
     OR NEW.buyer_id IS DISTINCT FROM OLD.buyer_id
     OR NEW.seller_id IS DISTINCT FROM OLD.seller_id
     OR NEW.amount_sen IS DISTINCT FROM OLD.amount_sen
  THEN
    RAISE EXCEPTION 'Offer core fields cannot be modified'
      USING ERRCODE = '42501';
  END IF;

  -- Only pending offers can transition
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'Only pending offers can be updated'
      USING ERRCODE = '42501';
  END IF;

  -- Buyer may only withdraw; Seller may only accept or decline
  IF v_uid = OLD.buyer_id AND NEW.status NOT IN ('withdrawn', 'cancelled') THEN
    RAISE EXCEPTION 'Buyers may only withdraw their own pending offer'
      USING ERRCODE = '42501';
  END IF;

  IF v_uid = OLD.seller_id AND NEW.status NOT IN ('accepted', 'declined', 'rejected') THEN
    RAISE EXCEPTION 'Sellers may only accept or decline a pending offer'
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
-- 3. PUBLIC_PROFILES VIEW: Safe Directory Scope
--    Addresses Finding 4.
--    NOTE: Do NOT blindly set security_invoker=true unless profiles has a safe
--    column-restricted SELECT grant for authenticated users; otherwise sellers'
--    public_profiles rows will become invisible to buyers.
--    Safer immediate hardening: ensure anon has zero access and only active
--    profiles are projected (verify current view definition first!).
-- -----------------------------------------------------------------------------
REVOKE ALL ON public.public_profiles FROM anon;
GRANT SELECT ON public.public_profiles TO authenticated;

-- -----------------------------------------------------------------------------
-- 4. RPC EXECUTE PRIVILEGES: Restrict Mutating / Internal Functions
--    Fixes Finding 5
-- -----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.update_listing_atomic(uuid, timestamptz, jsonb, jsonb) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_listing_atomic(uuid, timestamptz, jsonb, jsonb) TO authenticated;

-- Review-only inspection query for owner to run in Supabase SQL Editor:
-- SELECT proname, prosecdef, proconfig, proacl
-- FROM pg_proc
-- WHERE pronamespace = 'public'::regnamespace
--   AND proname IN (
--     'is_active_admin', 'is_active_member', 'is_active_student',
--     'mask_matric', 'rls_auto_enable', 'update_listing_atomic',
--     'handle_new_auth_user'
--   );
