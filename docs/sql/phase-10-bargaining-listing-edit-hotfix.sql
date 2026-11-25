-- =============================================================================
-- Buy-U Phase 10 — Bargaining Listing Edit Hotfix (`update_listing_atomic`)
-- STATUS: PROPOSAL ONLY — FOR MANUAL OWNER EXECUTION
-- TARGET PROJECT: duwwlcpdidrxkixvflag
--
-- Root Cause:
--   Hosted `public.update_listing_atomic(uuid, timestamptz, jsonb, jsonb)` still
--   contains the legacy Pre-Loved-only assignment:
--     allow_offers = coalesce((p_payload->>'allow_offers')::boolean, false)
--                    and v_listing.kind = 'pre_loved'
--   which forces `allow_offers = false` on Student Business edits even when the
--   seller enables "Allow price negotiation".
--
-- Design:
--   - Reads the live `pg_get_functiondef(...)` of `public.update_listing_atomic`
--     and surgically replaces ONLY that legacy `allow_offers` expression with
--     `public.is_listing_bargaining_eligible(...)` evaluated against the target
--     kind / is_food / availability_mode values.
--   - Preserves 100% of existing ownership, inventory, variant, reservation,
--     and optimistic-concurrency safeguards untouched.
--   - Fails loudly and rolls back if the expected legacy clause is not found.
--   - No new tables, no new columns, no manual data mutations.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_proc regprocedure := 'public.update_listing_atomic(uuid,timestamptz,jsonb,jsonb)'::regprocedure;
  v_old_def text;
  v_new_def text;
  v_pattern text :=
    'allow_offers\s*=\s*coalesce\s*\(\s*\(\s*p_payload\s*->>\s*''allow_offers''\s*\)\s*::\s*boolean\s*,\s*false\s*\)\s+and\s+v_listing\.kind\s*=\s*''pre_loved''';
  v_replacement text := $r$allow_offers = (
        coalesce((p_payload->>'allow_offers')::boolean, false)
        and public.is_listing_bargaining_eligible(
          coalesce(p_payload->>'kind', v_listing.kind),
          coalesce((p_payload->>'is_food')::boolean, v_listing.is_food),
          coalesce(p_payload->>'availability_mode', v_listing.availability_mode)
        )
      )$r$;
BEGIN
  -- Ensure Phase 10 helper exists before patching
  PERFORM 'public.is_listing_bargaining_eligible(text,boolean,text)'::regprocedure;

  v_old_def := pg_get_functiondef(v_proc);

  IF v_old_def !~* v_pattern THEN
    RAISE EXCEPTION 'HOTFIX_ABORTED: expected legacy allow_offers clause not found in public.update_listing_atomic(uuid,timestamptz,jsonb,jsonb)';
  END IF;

  v_new_def := regexp_replace(v_old_def, v_pattern, v_replacement, 'i');

  IF v_new_def IS NOT DISTINCT FROM v_old_def THEN
    RAISE EXCEPTION 'HOTFIX_ABORTED: function definition unchanged after replacement';
  END IF;

  EXECUTE v_new_def;
END;
$$;

-- Re-affirm least-privilege RPC grants
REVOKE ALL ON FUNCTION public.update_listing_atomic(uuid, timestamptz, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_listing_atomic(uuid, timestamptz, jsonb, jsonb) TO authenticated;

COMMIT;
