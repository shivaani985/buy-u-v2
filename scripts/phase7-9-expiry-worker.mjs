/**
 * Buy-U Phases 7–9 — Scheduled Expiry Sweeper Worker (Phase 11 Cron Ready)
 *
 * Safely runs trusted service_role expiry RPCs without requiring any open browser:
 *   1. `expire_stale_service_requests_atomic(NULL)` — expires overdue 'requested' service requests (>48h respond_by)
 *   2. `expire_stale_free_claims_atomic(NULL)` — expires overdue 'reserved' free-item claims (>48h) & releases stock
 *      (NEVER touches handed_over claims or accepted/in_progress/delivered services)
 *
 * Usage:
 *   node scripts/phase7-9-expiry-worker.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

function loadEnvLocal() {
  const p = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

loadEnvLocal();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const service = createClient(url, serviceKey, { auth: { persistSession: false } });

async function main() {
  const [svcRes, freeRes] = await Promise.all([
    service.rpc("expire_stale_service_requests_atomic", { p_request_id: null }),
    service.rpc("expire_stale_free_claims_atomic", { p_notice_id: null }),
  ]);

  if (svcRes.error) {
    console.error("expire_stale_service_requests_atomic failed:", svcRes.error.message);
    process.exit(1);
  }
  if (freeRes.error) {
    console.error("expire_stale_free_claims_atomic failed:", freeRes.error.message);
    process.exit(1);
  }

  console.log(
    JSON.stringify({
      ok: true,
      ranAt: new Date().toISOString(),
      expiredServiceRequests: svcRes.data ?? 0,
      expiredFreeClaims: freeRes.data ?? 0,
    })
  );
}

main();
