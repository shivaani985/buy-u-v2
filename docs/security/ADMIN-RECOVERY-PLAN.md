# Buy-U v2 — Admin Account Recovery Approval Plan

**Status:** AWAITING OWNER APPROVAL — ZERO HOSTED CHANGES MADE  
**Project:** `duwwlcpdidrxkixvflag` (Buy-U Website)  
**Recovery Script:** [`scripts/recover-admin-email.mjs`](../../scripts/recover-admin-email.mjs) *(dry-run by default)*

---

## 1. Exact Identity to Update (Verified Read-Only)

- **Auth User ID (`auth.users.id`):** `123f4b1d-372f-4c90-8f77-9a91d9a0af5b` *(preserved unchanged)*
- **Current Email:** `admin@ums.edu.my`
- **Active Admin Registry (`public.admin_users`):** `user_id = 123f4b1d-372f-4c90-8f77-9a91d9a0af5b`, `active = true` *(preserved unchanged)*
- **Current Profile (`public.profiles`):** `id = 123f4b1d-372f-4c90-8f77-9a91d9a0af5b`, `email = admin@ums.edu.my`, `university_role = staff`, `status = active`, `display_name = Buy-U Admin`
- **Audit Logs (`public.admin_audit_logs`):** 0 rows (untouched)

---

## 2. CRITICAL: Target Email Confirmation Needed

Two different target Gmail addresses appeared in the request:
1. `buyu.platform@gmail.com` (under *Confirmed Owner Decision*)
2. `haxim.2mars@gmail.com` (under *Task 2*)

**Owner must confirm the single exact Gmail address before execution.**

---

## 3. Proposed Recovery Method

1. Owner sets a strong temporary/new password (>= 12 chars) privately in local shell environment variable `ADMIN_RECOVERY_NEW_PASSWORD` (never pasted in chat, never committed).
2. Run `scripts/recover-admin-email.mjs --new-email <confirmed-email> --confirm-execute`, which calls official server-side `supabase.auth.admin.updateUserById(id, { email, password, email_confirm: true })` (never raw SQL on `auth.users`).
3. Synchronize `public.profiles.email` to `<confirmed-email>` for `id = 123f4b1d-372f-4c90-8f77-9a91d9a0af5b` only, keeping `university_role`, `status`, and `admin_users` intact.
4. Clear `ADMIN_RECOVERY_NEW_PASSWORD` from the shell immediately.

---

## 4. Security Impact

- **Inbox verification note:** Admin API `email_confirm: true` bypasses normal email confirmation. After recovery, the owner MUST independently verify inbox control by triggering `/forgot-password` for the new Gmail and confirming receipt in that inbox.
- **Admin authorization unchanged:** `/admin/login` and `/admin` continue to require authenticated Supabase session + backend `is_active_admin() === true` (`public.admin_users`). Email address alone never grants admin privileges.
- **University registration security unchanged:** `/login` and `/register` strictly enforce `@iluv.ums.edu.my` (Student) and `@ums.edu.my` (Staff). Ordinary Gmail accounts cannot register or sign in as university members.

---

## 5. Verification & Rollback Plan

- **Post-Execution Verification:**
  1. Sign in at `http://localhost:3000/admin/login` with new Gmail + new password -> opens `/admin` (`Buy-U Admin Console`).
  2. Verify `auth.users.id` remains `123f4b1d-372f-4c90-8f77-9a91d9a0af5b` and `public.profiles.email` matches.
  3. Verify Student (`examiner.seller@iluv.ums.edu.my`) and Staff (`examiner.staff@ums.edu.my`) logins still work and cannot access `/admin`.
  4. Verify `/forgot-password` delivers a reset link to the new Gmail inbox.
- **Rollback Plan:**
  - Re-run `scripts/recover-admin-email.mjs --new-email admin@ums.edu.my --confirm-execute` with the prior/fallback password to revert `auth.users.email` and `public.profiles.email` while preserving `user_id` and `admin_users`.
