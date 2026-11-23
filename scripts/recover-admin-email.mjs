/**
 * One-time, owner-operated server-side Admin Account Recovery script.
 * Uses official Supabase Admin API updateUserById() — NEVER raw SQL on auth.users.
 *
 * SAFETY:
 * - Dry-run by default. Makes ZERO changes unless --confirm-execute is passed.
 * - Reads new password privately from env var ADMIN_RECOVERY_NEW_PASSWORD
 *   (never via CLI args, never printed to logs).
 *
 * Usage (dry-run):
 *   node --env-file=.env.local scripts/recover-admin-email.mjs --new-email <confirmed-email>
 *
 * Usage (execute after owner approval):
 *   $env:ADMIN_RECOVERY_NEW_PASSWORD="<strong-password>"
 *   node --env-file=.env.local scripts/recover-admin-email.mjs --new-email <confirmed-email> --confirm-execute
 *   Remove-Item Env:\ADMIN_RECOVERY_NEW_PASSWORD
 */
import { createClient } from "@supabase/supabase-js";

const EXPECTED_ADMIN_ID = "123f4b1d-372f-4c90-8f77-9a91d9a0af5b";

function parseArgs(argv) {
  let newEmail = "";
  let confirmExecute = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--new-email" && argv[i + 1]) {
      newEmail = argv[i + 1].trim().toLowerCase();
      i++;
    } else if (argv[i] === "--confirm-execute") {
      confirmExecute = true;
    }
  }
  return { newEmail, confirmExecute };
}

async function main() {
  const { newEmail, confirmExecute } = parseArgs(process.argv.slice(2));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local.");
    process.exit(1);
  }
  if (!newEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
    console.error("Provide a valid target email with --new-email <email>.");
    process.exit(1);
  }

  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Verify target admin identity exists and is active in public.admin_users
  const { data: adminRow, error: adminErr } = await supabase
    .from("admin_users")
    .select("user_id, active")
    .eq("user_id", EXPECTED_ADMIN_ID)
    .maybeSingle();

  if (adminErr || !adminRow || !adminRow.active) {
    console.error("Expected active admin_users record not found. Aborting.");
    process.exit(1);
  }

  const { data: userRes, error: userErr } =
    await supabase.auth.admin.getUserById(EXPECTED_ADMIN_ID);

  if (userErr || !userRes?.user) {
    console.error("Unable to load existing Auth user by ID. Aborting.");
    process.exit(1);
  }

  const { data: profileRow } = await supabase
    .from("profiles")
    .select("id, email, university_role, status, display_name")
    .eq("id", EXPECTED_ADMIN_ID)
    .maybeSingle();

  console.log("=== ADMIN RECOVERY PREFLIGHT ===");
  console.log("Mode:", confirmExecute ? "EXECUTE" : "DRY-RUN (no changes will be made)");
  console.log("Target Auth ID:", userRes.user.id);
  console.log("Current Auth Email:", userRes.user.email);
  console.log("Proposed New Email:", newEmail);
  console.log("Current public.profiles.email:", profileRow?.email ?? "(none)");
  console.log("public.admin_users.active:", adminRow.active);

  if (!confirmExecute) {
    console.log("\nDRY-RUN complete. No hosted account or database changes were made.");
    console.log("Re-run with ADMIN_RECOVERY_NEW_PASSWORD set and --confirm-execute after owner approval.");
    return;
  }

  const newPassword = process.env.ADMIN_RECOVERY_NEW_PASSWORD ?? "";
  if (newPassword.length < 12) {
    console.error("Set ADMIN_RECOVERY_NEW_PASSWORD (minimum 12 characters) before executing.");
    process.exit(1);
  }

  // 2. Update Auth user via official Supabase Admin API (preserves user ID)
  const { data: updated, error: updateErr } =
    await supabase.auth.admin.updateUserById(EXPECTED_ADMIN_ID, {
      email: newEmail,
      password: newPassword,
      email_confirm: true,
    });

  if (updateErr || !updated?.user) {
    console.error("Supabase Admin updateUserById failed:", updateErr?.message ?? "Unknown error");
    process.exit(1);
  }

  // 3. Synchronize public.profiles.email safely (preserving id, role, status)
  if (profileRow && profileRow.email !== newEmail) {
    const { error: profErr } = await supabase
      .from("profiles")
      .update({ email: newEmail })
      .eq("id", EXPECTED_ADMIN_ID);

    if (profErr) {
      console.error("Auth email updated, but public.profiles.email sync failed:", profErr.message);
      process.exit(1);
    }
  }

  console.log("\nRECOVERY COMPLETE (ID preserved:", updated.user.id, ")");
  console.log("Updated Auth Email:", updated.user.email);
  console.log("public.profiles.email synced:", newEmail);
  console.log("NEXT: Independently verify inbox control by testing Forgot Password on", newEmail);
}

main().catch((err) => {
  console.error("Unexpected error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
