# Buy-U v2 — Phase 2 Security Audit Findings

**Project:** Buy-U (`duwwlcpdidrxkixvflag`)  
**Audit Mode:** Strictly Read-Only (zero schema, RLS, or data mutations)  
**Companion Proposal:** [`PROPOSED-REMEDIATIONS.sql`](./PROPOSED-REMEDIATIONS.sql) *(REVIEW-ONLY — NOT EXECUTED)*

---

## Finding 1 — Profile UPDATE Column-Level Privilege Escalation (CRITICAL)

- **Actual Risk:** Any authenticated member can call PostgREST `PATCH /rest/v1/profiles?id=eq.<own_id>` and overwrite `status` (e.g., self-unsuspending from `suspended` -> `active`), `university_role` (e.g., `staff` -> `student` to unlock selling), `restriction_reason`, `email`, or `matric_number`.
- **Evidence:** Independently verified SQL finding #7: `profiles_update_own` allows row updates by `auth.uid() = id`, while PostgreSQL table-level `UPDATE` privileges for `authenticated` include sensitive columns (`status`, `university_role`, `restriction_reason`, `email`, `matric_number`).
- **Proposed Least-Privilege Fix:** Revoke blanket `UPDATE` on `public.profiles` from `authenticated`, grant column-level `UPDATE` ONLY on safe editable columns (`display_name`, `faculty`, `bio`, `avatar_url`, `phone`), and add a `BEFORE UPDATE` guard trigger rejecting changes to immutable/admin-owned columns unless called by `is_active_admin()` or service role.
- **Compatibility Impact:** Existing client profile edit forms will continue working if they only send safe editable columns; any legacy code sending `email` or `status` in the PATCH payload will receive `42501` and must be trimmed to safe columns.
- **Regression Tests:**
  1. Authenticated student `UPDATE profiles SET display_name = 'New'` -> PASS.
  2. Authenticated staff `UPDATE profiles SET university_role = 'student'` -> FAIL (`42501`).
  3. Suspended member `UPDATE profiles SET status = 'active'` -> FAIL (`42501`).
- **Owner Approval Required:** **YES** (Profile editing remains locked read-only in `/account` until applied and tested).

---

## Finding 2 — Account Status & University Role Escalation (HIGH)

- **Actual Risk:** Coupled with Finding 1, a suspended/closed user or staff member could self-elevate or regain active marketplace access without admin review. Additionally, trusting `auth.users.raw_user_meta_data` on the frontend would allow client-supplied role spoofing.
- **Evidence:** `profiles.status` and `profiles.university_role` control marketplace eligibility and selling rights; Buy-U v2 enforces reading them strictly from `public.profiles` on the server (never `user_metadata`), but DB-level protection depends on Finding 1 remediation.
- **Proposed Least-Privilege Fix:** Enforce column-level UPDATE revocation (Finding 1) and keep `handle_new_auth_user` as the sole authority assigning `university_role` from verified exact email domain (`@iluv.ums.edu.my` vs `@ums.edu.my`).
- **Compatibility Impact:** None for normal registration or login.
- **Regression Tests:** Verify new `@iluv.ums.edu.my` signup receives `student`, `@ums.edu.my` receives `staff`, and client-supplied `data: { university_role: 'admin' }` is ignored.
- **Owner Approval Required:** **YES** (via Finding 1 SQL).

---

## Finding 3 — `offers` UPDATE Policy Lacks Field & State-Transition Guard (HIGH)

- **Actual Risk:** In a negotiation between buyer and seller, a buyer could update `status = 'accepted'` on their own offer, or a participant could mutate `amount_sen`, `buyer_id`, `seller_id`, or `listing_id` after an offer was already accepted/declined/expired.
- **Evidence:** Independently verified SQL finding #8: `offers` UPDATE policy allows participant updates without enforcing field-level immutability or valid state transitions.
- **Proposed Least-Privilege Fix:** Revoke direct `UPDATE` on `public.offers` from `authenticated` (or restrict via column grants + `BEFORE UPDATE` state-machine trigger / dedicated `SECURITY DEFINER` RPCs for `accept_offer`, `decline_offer`, `withdraw_offer` that check actor role and valid transitions).
- **Compatibility Impact:** Direct client `supabase.from('offers').update(...)` calls must be routed through validated state transitions or RPCs in Phase 5.
- **Regression Tests:**
  1. Buyer attempts `status = 'accepted'` on own offer -> FAIL.
  2. Participant mutates `amount_sen` on `accepted` offer -> FAIL.
  3. Seller accepts `pending` offer -> PASS.
- **Owner Approval Required:** **YES** (Offer mutations remain blocked until Phase 5 + remediation).

---

## Finding 4 — `public_profiles` View Missing `security_invoker = true` (MEDIUM)

- **Actual Risk:** Views created without `security_invoker = true` execute with the view owner's privileges (typically `postgres`), bypassing RLS policies on the underlying `public.profiles` table.
- **Evidence:** Independently verified SQL finding #6: `public_profiles` does not currently set `security_invoker = true`. Read-only OpenAPI inspection confirmed it exposes `id, display_name, university_role, status, faculty, bio, avatar_url, masked_matric, created_at` (no email/phone/full matric), and `anon` has no `SELECT` grant on it.
- **Proposed Least-Privilege Fix:** Evaluate setting `ALTER VIEW public.public_profiles SET (security_invoker = true)` together with a narrow `authenticated` RLS policy on `profiles` (or keep a tightly scoped `SECURITY DEFINER` public directory view with an explicit `WHERE status = 'active'` filter and verified `REVOKE ALL FROM anon`).
- **Compatibility Impact:** Enabling `security_invoker = true` will cause `public_profiles` to return ONLY the caller's own row unless `profiles` has an `authenticated` SELECT policy for active members' public rows — which would expose private `profiles` columns unless column-level SELECT grants are also restricted! **Review carefully before applying** (see `PROPOSED-REMEDIATIONS.sql`).
- **Regression Tests:** Authenticated member queries `public_profiles` for another active seller -> returns public fields only; querying `profiles` for another user's `phone`/`matric_number` -> returns 0 rows or `42501`.
- **Owner Approval Required:** **YES**.

---

## Finding 5 — `SECURITY DEFINER` Functions & `EXECUTE` Privileges (MEDIUM)

- **Actual Risk:** `SECURITY DEFINER` functions exposed in `public` can be invoked via PostgREST `/rpc/<name>` by `anon` or `authenticated` if `EXECUTE` is granted to `PUBLIC` and internal authorization checks are missing.
- **Evidence:** Phase 1.5 read-only probe verified 6 RPCs exposed in OpenAPI (`is_active_admin`, `is_active_member`, `is_active_student`, `mask_matric`, `rls_auto_enable`, `update_listing_atomic`). `anon` calls to `is_active_*` safely returned `false`. Raw `pg_proc` bodies and `proacl` grants were not readable over PostgREST.
- **Proposed Least-Privilege Fix:** Audit `prosecdef` and `proconfig` (`SET search_path = public, pg_temp`) for all 6 functions in SQL Editor; revoke `EXECUTE` from `anon` / `PUBLIC` on mutating or internal functions (`update_listing_atomic`, `rls_auto_enable`).
- **Compatibility Impact:** Low — `anon` should never call `update_listing_atomic` or `rls_auto_enable`.
- **Regression Tests:** `anon` calling `update_listing_atomic` -> `42501`; authenticated seller calling `update_listing_atomic` on another seller's listing -> denied.
- **Owner Approval Required:** **YES**.

---

## Finding 6 — Authenticated RLS Behavior & `anon` Catalog Access (LOW / INFO)

- **Actual Risk:** `anon` has zero `SELECT` grants on all 28 tables (strong default privacy). Authenticated active members have `SELECT` via `listings_select_visible` and `categories_select_all`.
- **Evidence:** Verified in Phase 1.5 (`anon` -> `42501` on all tables) and independent SQL findings #1–#5.
- **Proposed Fix:** Keep `anon` blocked (do NOT add anonymous SELECT grants). Buy-U v2 Phase 2 routes guests to a clean UMS Sign-In / Register invitation instead of raw `42501` errors.
- **Owner Approval Required:** No DB change needed; live authenticated catalog verification awaits an owner-approved test member sign-in.

---

## Finding 7 — Admin Authorization Separation (VERIFIED SAFE IN APP)

- **Actual Risk:** Email-based or client-metadata-based admin checks can be spoofed or accidentally expose admin controls to students.
- **Evidence:** Buy-U v2 implements dedicated `/admin/login` and `/admin`, verifies `supabase.rpc('is_active_admin') === true` on the server, signs out non-admin accounts attempting `/admin/login`, and never renders Admin navigation links to students or staff.
- **Regression Tests:** Unauthenticated `/admin` -> redirects to `/admin/login`; regular student on `/admin/login` -> denied & signed out; regular student header -> no Admin link.
- **Owner Approval Required:** No DB change required.

---

## Finding 8 — Password Reset & Session Handling (VERIFIED SAFE IN APP)

- **Actual Risk:** Open redirects on `/auth/callback` or trusting unverified `getSession()` cookies can lead to session fixation or phishing redirects.
- **Evidence:** Buy-U v2 uses `src/proxy.ts` for SSR cookie refresh, `supabase.auth.getUser()` for server-side identity verification, `sanitizeNextPath()` to block external redirects on `/auth/callback` and `/login`, generic forgot-password responses to prevent account enumeration, and requires an active recovery session on `/reset-password`.
- **Owner Approval Required:** Ensure Supabase Auth Dashboard Redirect URLs include `http://localhost:3000/auth/callback` (and future production domain) so email verification & password recovery links work smoothly.
