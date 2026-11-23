# Buy-U v2 — Phase 2.1 Security Remediation Review

**Target Project:** `duwwlcpdidrxkixvflag` (Buy-U Website)  
**Reviewed Script:** [`PROPOSED-REMEDIATIONS.sql`](./PROPOSED-REMEDIATIONS.sql) *(REVIEW-ONLY — NOT EXECUTED)*  
**Status:** Ready for owner review & explicit approval before any SQL execution.

---

## 1. Critical Corrections Found During Live Schema Cross-Check

Cross-checking the initial Phase 2 draft against the actual `duwwlcpdidrxkixvflag` PostgREST schema caught 4 real issues that have now been fixed in the reviewed candidate script:

1. **`offers.amount_sen` did not exist:** The real column in `public.offers` is **`offer_price_sen`**. Running the old draft would have broken all offer updates at runtime.
2. **Missing immutable offer columns & column-level grants:** `public.offers` also contains `conversation_id`, `order_id`, `created_at`, and `responded_at`. The reviewed candidate now revokes blanket `UPDATE` on `public.offers`, grants column-level `UPDATE (status, responded_at)` only, guards `conversation_id`, `listing_id`, `buyer_id`, `seller_id`, `offer_price_sen`, `order_id`, `created_at`, and rejects non-participants.
3. **Unnecessary `SECURITY DEFINER` on guard triggers:** Both `guard_profile_sensitive_columns()` and `guard_offer_updates()` only inspect `OLD`/`NEW` and call `public.is_active_admin()`, so they are now **`SECURITY INVOKER`** with fixed `SET search_path = public, pg_temp`.
4. **Internal RPC `rls_auto_enable()` exposure:** Added `REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM anon, authenticated, PUBLIC;` alongside `update_listing_atomic` restriction.

---

## 2. Detailed Remediation Summary

### A. `public.profiles` — Least-Privilege Column UPDATE + Guard Trigger
- **Risk:** `profiles_update_own` currently permits authenticated members to overwrite `university_role`, `status`, `restriction_reason`, `email`, and `matric_number`.
- **Proposed Change:**
  - `REVOKE UPDATE ON public.profiles FROM authenticated;`
  - `GRANT UPDATE (display_name, faculty, bio, avatar_url, phone, updated_at) ON public.profiles TO authenticated;`
  - `BEFORE UPDATE` trigger (`guard_profile_sensitive_columns`, `SECURITY INVOKER`) blocking changes to `id`, `email`, `university_role`, `status`, `restriction_reason`, `matric_number`, `full_name`, `created_at` for non-admin users.
- **Expected Behavior:** Active members can edit their own display name, faculty, bio, avatar, and phone; any attempt to change role, status, email, or matric fails with `42501`. Admins and `service_role` remain unrestricted.

### B. `public.offers` — Column Grants + State-Machine Trigger
- **Risk:** Participants can self-accept their own offer, alter `offer_price_sen`, swap `order_id`/`listing_id`/`buyer_id`/`seller_id`, or mutate finalized offers.
- **Proposed Change:**
  - `REVOKE UPDATE ON public.offers FROM authenticated;`
  - `GRANT UPDATE (status, responded_at) ON public.offers TO authenticated;`
  - `BEFORE UPDATE` trigger (`guard_offer_updates`, `SECURITY INVOKER`) enforcing: immutable core fields (`id`, `conversation_id`, `listing_id`, `buyer_id`, `seller_id`, `offer_price_sen`, `order_id`, `created_at`), `OLD.status = 'pending'`, buyer -> `withdrawn`/`cancelled` only, seller -> `accepted`/`declined`/`rejected` only, and rejecting non-participants.
- **Expected Behavior:** Only valid participant transitions on pending offers succeed; server-side order creation (`service_role` / future RPC) remains able to link `order_id`.

### C. `public.public_profiles` View — Privacy-Preserving Access
- **Risk:** View does not use `security_invoker = true`.
- **Why NOT to blindly enable `security_invoker = true`:** `public.profiles` RLS permits `SELECT` only for the row owner and active admins. Setting `security_invoker = true` on `public_profiles` without opening `profiles` RLS would immediately hide seller names/faculties from buyers on all listings and storefronts. Opening `profiles` RLS to all authenticated users would risk exposing `phone`, `email`, and `matric_number` unless column-level SELECT grants are also rewritten.
- **Safe Solution:** Keep `public_profiles` as a tightly scoped projection of non-PII columns (`id, display_name, university_role, status, faculty, bio, avatar_url, masked_matric, created_at`), enforce `REVOKE ALL ON public.public_profiles FROM anon, PUBLIC; GRANT SELECT ON public.public_profiles TO authenticated;`, and inspect its SQL definition in SQL Editor before any future view rewrite.

### D. `SECURITY DEFINER` Functions & `EXECUTE` Privileges
- **Verified Signatures:**
  - `is_active_admin()`, `is_active_member()`, `is_active_student()` — needed by `authenticated` (and safely return `false` for `anon`).
  - `mask_matric(raw_matric text)` — pure helper.
  - `update_listing_atomic(p_listing_id uuid, p_expected_updated_at timestamptz, p_payload jsonb, p_variants jsonb)` — revoke from `anon, PUBLIC`; grant to `authenticated` only.
  - `rls_auto_enable()` — revoke from `anon, authenticated, PUBLIC` (admin/DDL helper only).
- **Important:** Do NOT alter `handle_new_auth_user()` or historical order/payment records.

---

## 3. Rollback Approach

Full rollback statements are included at the bottom of [`PROPOSED-REMEDIATIONS.sql`](./PROPOSED-REMEDIATIONS.sql):
- Drop `trg_guard_profile_sensitive_columns` and `trg_guard_offer_updates` + their trigger functions.
- Restore `GRANT UPDATE ON public.profiles TO authenticated;` and `GRANT UPDATE ON public.offers TO authenticated;` only if an emergency rollback is needed.

---

## 4. Regression Test Cases (Run After Owner Executes Approved SQL)

1. **Profile safe edit:** Authenticated student updates `display_name` & `faculty` -> **PASS**.
2. **Profile role escalation:** Authenticated staff updates `university_role = 'student'` -> **FAIL (`42501`)**.
3. **Profile self-unsuspend:** Suspended user updates `status = 'active'` -> **FAIL (`42501`)**.
4. **Offer buyer self-accept:** Buyer sets `status = 'accepted'` -> **FAIL (`42501`)**.
5. **Offer price/order tamper:** Participant modifies `offer_price_sen` or `order_id` -> **FAIL (`42501`)**.
6. **Offer valid flow:** Seller accepts `pending` offer -> **PASS**; subsequent edit on `accepted` offer -> **FAIL (`42501`)**.
7. **Seller visibility:** Authenticated buyer queries `public_profiles` for another active seller -> **PASS** (public fields only; `profiles` table still denies other users' rows).
8. **RPC execution:** `anon` calling `update_listing_atomic` or `rls_auto_enable` -> **FAIL (`42501`)**.
