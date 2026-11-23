# Buy-U v2 — Final Admin Account Recovery Procedure

**Status:** FINAL PROCEDURE READY — AWAITING OWNER EXECUTION / APPROVAL  
**Project:** `duwwlcpdidrxkixvflag` (Buy-U Website)  
**Confirmed New Email:** `buyu.platform@gmail.com`  
**Recovery Script:** [`scripts/recover-admin-email.mjs`](../../scripts/recover-admin-email.mjs) *(dry-run by default)*  
**DB Security Remediation Status:** Already applied by owner (do NOT rerun `PROPOSED-REMEDIATIONS.sql`)

---

## 1. Verified Target Identity (Preserved Unchanged)

- **Supabase Auth User ID (`auth.users.id`):** `123f4b1d-372f-4c90-8f77-9a91d9a0af5b`
- **Current Email:** `admin@ums.edu.my` -> **New Email:** `buyu.platform@gmail.com`
- **Admin Registry (`public.admin_users`):** `user_id = 123f4b1d-372f-4c90-8f77-9a91d9a0af5b`, `active = true` *(unchanged)*
- **Profile (`public.profiles`):** `email` synced to `buyu.platform@gmail.com`; `id`, `university_role = staff`, `status = active`, `display_name = Buy-U Admin` preserved
- **Audit History (`public.admin_audit_logs`):** Preserved intact

---

## 2. Final Owner-Operated Execution Procedure (Run Locally in PowerShell)

No password is ever passed via CLI arguments, saved to files, or pasted in chat:

```powershell
cd "C:\FYP VAANI\Buy-U-v2"

# 1. Enter your new strong password privately (hidden input, minimum 12 characters)
$sec = Read-Host "Enter new admin password (min 12 chars)" -AsSecureString
$env:ADMIN_RECOVERY_NEW_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
)

# 2. Execute official Supabase Admin API updateUserById() + profiles.email sync
node --env-file=.env.local scripts/recover-admin-email.mjs --new-email buyu.platform@gmail.com --confirm-execute

# 3. Clear password from shell memory immediately
Remove-Item Env:\ADMIN_RECOVERY_NEW_PASSWORD
Remove-Variable sec
```

---

## 3. Post-Execution Verification Checklist

1. **Inbox Ownership Check (Required):** Trigger `/forgot-password` for `buyu.platform@gmail.com` (or confirm inbox receipt) since Admin API `email_confirm: true` bypasses email confirmation.
2. **Admin Login & Session:** Start local server (`npm run start`), sign in at `http://localhost:3000/admin/login` with `buyu.platform@gmail.com` -> confirm `/admin` opens (`Buy-U Admin Console`, `is_active_admin() === true`), session persists across reload, and Sign Out clears session.
3. **Role Security:** Confirm Student (`@iluv.ums.edu.my`) and Staff (`@ums.edu.my`) logins still work and ordinary users cannot access `/admin`.
4. **Rollback (if ever needed):** Re-run the same script with `--new-email admin@ums.edu.my --confirm-execute`.
