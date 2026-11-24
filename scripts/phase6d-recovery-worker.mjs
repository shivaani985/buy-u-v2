/**
 * Buy-U Phase 6D — Executable Durable Financial Recovery Worker (P0.5)
 *
 * Scans `payout_requests` and `order_refunds` stuck in `processing` or
 * `reconciliation_required` (e.g. after browser close, server crash, or
 * lost response before DB finalization) and invokes the authoritative
 * `recover_financial_execution_atomic` RPC using trusted persisted provider
 * evidence from `financial_execution_attempts`.
 *
 * Safe by design:
 *   - NEVER releases reserved/frozen funds without definitive persisted provider failure.
 *   - Recovers confirmed provider successes idempotently without duplicating transfers.
 *   - Keeps uncertain outcomes reserved (`held_uncertain`).
 *
 * Usage (after owner applies docs/sql/phase-6d-financial-ecosystem.sql):
 *   node scripts/phase6d-recovery-worker.mjs
 *   (Schedule every 5 minutes via cron / host scheduler / GitHub Actions.)
 */
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

function loadEnvLocal() {
  const p = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (!process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

async function main() {
  loadEnvLocal();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error("RECOVERY_WORKER_ERROR: Supabase service credentials missing.");
    process.exit(1);
  }

  const service = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const [wdrRes, rfdRes] = await Promise.all([
    service
      .from("payout_requests")
      .select("id, withdrawal_code, status")
      .in("status", ["processing", "reconciliation_required"])
      .limit(100),
    service
      .from("order_refunds")
      .select("id, refund_code, status")
      .in("status", ["processing", "reconciliation_required"])
      .limit(100),
  ]);

  if (wdrRes.error || rfdRes.error) {
    console.error(
      "RECOVERY_WORKER_ERROR:",
      wdrRes.error?.message || rfdRes.error?.message
    );
    process.exit(1);
  }

  const summary = { checkedWithdrawals: 0, checkedRefunds: 0, outcomes: [] };

  for (const w of wdrRes.data ?? []) {
    summary.checkedWithdrawals += 1;
    const { data, error } = await service.rpc("recover_financial_execution_atomic", {
      p_entity_type: "withdrawal",
      p_entity_id: w.id,
      p_admin_id: null,
    });
    summary.outcomes.push({
      type: "withdrawal",
      code: w.withdrawal_code,
      outcome: error ? `error:${error.message}` : data,
    });
  }

  for (const r of rfdRes.data ?? []) {
    summary.checkedRefunds += 1;
    const { data, error } = await service.rpc("recover_financial_execution_atomic", {
      p_entity_type: "refund",
      p_entity_id: r.id,
      p_admin_id: null,
    });
    summary.outcomes.push({
      type: "refund",
      code: r.refund_code,
      outcome: error ? `error:${error.message}` : data,
    });
  }

  console.log(JSON.stringify(summary));
}

main().catch((err) => {
  console.error("RECOVERY_WORKER_FATAL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
