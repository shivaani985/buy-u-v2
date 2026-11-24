-- =============================================================================
-- Buy-U Phase 6D — Minimal Corrective SQL: Explicit service_role Grants
-- STATUS: PROPOSAL ONLY — AWAITING OWNER APPROVAL
-- TARGET PROJECT: duwwlcpdidrxkixvflag
--
-- Root cause (Gate A): The 5 newly created Phase 6D tables did not receive an
-- explicit `service_role` grant after `REVOKE ALL ... FROM PUBLIC, anon, authenticated`.
-- This restores server-only `service_role` access while preserving all RLS and
-- column-level lockdown for `anon` and `authenticated`.
-- =============================================================================

BEGIN;

GRANT ALL ON TABLE public.order_refunds TO service_role;
GRANT ALL ON TABLE public.order_restock_logs TO service_role;
GRANT ALL ON TABLE public.financial_adjustments TO service_role;
GRANT ALL ON TABLE public.payout_allocations TO service_role;
GRANT ALL ON TABLE public.financial_execution_attempts TO service_role;

COMMIT;
