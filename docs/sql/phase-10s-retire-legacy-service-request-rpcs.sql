-- =============================================================================
-- BUY-U PHASE 10S — RETIRE LEGACY SERVICE REQUEST WRITE RPCs (MINIMAL PATCH)
-- =============================================================================
-- Purpose:
--   Revoke client EXECUTE privileges on obsolete legacy service request write
--   RPCs so authenticated users cannot bypass the unified paid service checkout
--   by invoking PostgREST RPCs directly.
--
-- Preserves:
--   - `public.service_requests` table and any historical rows (read-only).
--   - `submit_verified_review_atomic` historical compatibility.
--   - `service_role` access if ever needed for admin/maintenance.
--
-- DO NOT RUN AUTOMATICALLY — FOR OWNER REVIEW & EXECUTION.
-- =============================================================================

BEGIN;

REVOKE EXECUTE ON FUNCTION public.create_service_request_atomic(uuid, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.update_service_request_status_atomic(uuid, text, text)
  FROM PUBLIC, anon, authenticated;

COMMIT;
