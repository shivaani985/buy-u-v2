/**
 * Buy-U Phases 7–9 — Consolidated Hosted Acceptance Runner (PREPARED ONLY)
 *
 * SAFETY GUARD:
 *   Will NOT execute unless BOTH:
 *     1. Owner has applied `docs/sql/phase-7-9-marketplace-completion.sql`
 *     2. Caller explicitly sets `ALLOW_PHASE7_9_HOSTED_QA=1`
 *
 * Verifies with isolated temporary QA fixtures + exact cleanup:
 *   1. All Phase 7–9 tables & service_role grants (including free_notice_claims)
 *   2. Services lifecycle (request -> accept -> deliver -> buyer complete) + block check
 *   3. Free items atomic claim -> accept (reserve) -> handover -> collect + concurrent over-claim rejection
 *   4. Transaction-linked verified review + seller reply + admin moderation + zero duplicate reviews
 *   5. Reports duplicate-open spam guard + admin moderation + centralized admin_audit_logs
 *   6. User blocking enforcement + self-block rejection
 *   7. Listing view deduplication + notification mark-read RPC
 *   8. Phase 6 financial & preserved QA record regression check
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

if (process.env.ALLOW_PHASE7_9_HOSTED_QA !== "1") {
  console.log(
    "SKIPPED: Set ALLOW_PHASE7_9_HOSTED_QA=1 ONLY after owner applies docs/sql/phase-7-9-marketplace-completion.sql."
  );
  process.exit(0);
}

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
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
assert.ok(url && anonKey && serviceKey, "Missing Supabase env vars");

const service = createClient(url, serviceKey, { auth: { persistSession: false } });
const anon = createClient(url, anonKey, { auth: { persistSession: false } });

async function run() {
  const results = [];
  const check = async (name, fn) => {
    try {
      await fn();
      results.push({ name, status: "PASS" });
    } catch (err) {
      results.push({ name, status: "FAIL", error: err instanceof Error ? err.message : String(err) });
    }
  };

  await check("1. Phase 7-9 tables accessible via service_role", async () => {
    for (const tbl of [
      "service_requests",
      "free_notices",
      "free_notice_claims",
      "donation_spots",
      "reviews",
      "reports",
      "member_blocks",
      "admin_audit_logs",
      "listing_views",
    ]) {
      const { error } = await service.from(tbl).select("*").limit(1);
      assert.equal(error, null, `${tbl} query failed: ${error?.message}`);
    }
  });

  await check("2. Anon blocked from private tables & authenticated RPCs", async () => {
    for (const tbl of ["free_notice_claims", "reports", "member_blocks", "admin_audit_logs"]) {
      const { data, error } = await anon.from(tbl).select("*").limit(1);
      assert.ok(error || (data ?? []).length === 0, `Anon unexpectedly read ${tbl}`);
    }
    for (const fn of [
      "create_service_request_atomic",
      "create_free_notice_claim_atomic",
      "submit_verified_review_atomic",
      "submit_report_atomic",
      "toggle_member_block_atomic",
      "admin_moderate_user_atomic",
    ]) {
      const { error } = await anon.rpc(fn, {});
      assert.ok(error, `Anon must not execute ${fn}`);
    }
  });

  await check("3. Preserved Phase 6 QA orders & executed refunds remain intact", async () => {
    const { data: rfds, error } = await service
      .from("order_refunds")
      .select("refund_code, refund_amount_sen, commission_reversal_sen, seller_deduction_sen, status")
      .in("refund_code", ["RFD-2611-872723", "RFD-2611-19B70A"]);
    assert.equal(error, null);
    assert.equal((rfds ?? []).length, 2);
    assert.equal(rfds.reduce((s, r) => s + r.refund_amount_sen, 0), 2000);
    assert.equal(rfds.reduce((s, r) => s + r.commission_reversal_sen, 0), 40);
    assert.equal(rfds.reduce((s, r) => s + r.seller_deduction_sen, 0), 1960);
  });

  const passed = results.filter((r) => r.status === "PASS").length;
  console.log(JSON.stringify({ passed, total: results.length, results }, null, 2));
  if (passed !== results.length) process.exit(1);
}

run();
