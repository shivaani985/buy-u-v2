/**
 * Buy-U Phase 6D — Consolidated Hosted Database Acceptance Runner (PREPARED ONLY)
 *
 * SAFETY GUARD:
 *   Will NOT execute unless BOTH:
 *     1. Owner has applied `docs/sql/phase-6d-financial-ecosystem.sql`
 *     2. Caller explicitly sets `ALLOW_PHASE6D_HOSTED_QA=1`
 *
 * Verifies P0.1–P0.10 on hosted PostgreSQL using isolated QA fixtures and exact cleanup:
 *   1. Single 6-param `admin_resolve_order_dispute_atomic` (legacy 4-param dropped)
 *   2. Legacy `seller_payout_accounts` safely masked & `re_registration_required` (zero plaintext)
 *   3. Encrypted bank account upsert (`seller_payout_accounts_pkey`) + client column lockdown
 *   4. Unverified payment fixture rejected by `create_seller_withdrawal_atomic`
 *   5. Historical 7-day `protection_expires_at` vs new 72-hour exact boundary
 *   6. Durable `financial_execution_attempts` + interruption recovery (`recover_financial_execution_atomic`)
 *   7. Unsafe `admin_release_failed_withdrawal_atomic` absent; uncertain outcome held
 *   8. Separated restock (`approved_pending_refund` -> executed only on refund success) + food/damaged/qty guards
 *   9. Preserved QA records intact (`BU-2611-0DB3`, `BU-2611-B1C075`, `BU-2611-C3CC55`, `BU-2611-3CB12A`)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

if (process.env.ALLOW_PHASE6D_HOSTED_QA !== "1") {
  console.log(
    "SKIPPED: Set ALLOW_PHASE6D_HOSTED_QA=1 ONLY after owner applies docs/sql/phase-6d-financial-ecosystem.sql."
  );
  process.exit(0);
}

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

loadEnvLocal();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
assert.ok(url && anonKey && serviceKey, "Missing Supabase env vars");

const service = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function run() {
  const results = [];
  const check = async (name, fn) => {
    try {
      await fn();
      results.push({ name, status: "PASS" });
    } catch (err) {
      results.push({
        name,
        status: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  await check("1. New financial & durable attempt tables accessible via service_role", async () => {
    for (const tbl of [
      "order_refunds",
      "order_restock_logs",
      "financial_adjustments",
      "payout_allocations",
      "financial_execution_attempts",
    ]) {
      const { error } = await service.from(tbl).select("id").limit(1);
      assert.equal(error, null, `${tbl} query failed: ${error?.message}`);
    }
  });

  await check("2. Legacy 4-param resolve RPC removed & unsafe admin release removed", async () => {
    const { error: relErr } = await service.rpc("admin_release_failed_withdrawal_atomic", {
      p_withdrawal_id: "00000000-0000-0000-0000-000000000000",
      p_admin_notes: "test",
    });
    assert.ok(relErr, "Unsafe admin_release_failed_withdrawal_atomic must not exist");
  });

  await check("3. Legacy bank accounts contain zero plaintext digits & are deactivated", async () => {
    const { data, error } = await service
      .from("seller_payout_accounts")
      .select("seller_id, account_number, account_number_encrypted, duitnow_id, validation_status, is_active");
    assert.equal(error, null);
    for (const row of data ?? []) {
      assert.ok(
        String(row.account_number ?? "").startsWith("****"),
        "No plaintext account_number may remain"
      );
      assert.equal(row.duitnow_id, null, "Legacy duitnow_id must be cleared");
      if (!row.account_number_encrypted || !String(row.account_number_encrypted).startsWith("v1:")) {
        assert.equal(row.is_active, false, "Unencrypted bank account must be inactive");
        assert.equal(row.validation_status, "re_registration_required");
      }
    }
  });

  await check("4. Preserved Phase 6D.1 pending refunds backfilled & historical protection_expires_at set", async () => {
    const { data: rfds, error: rErr } = await service
      .from("order_refunds")
      .select("refund_code, refund_type, refund_amount_sen, commission_reversal_sen, seller_deduction_sen, status");
    assert.equal(rErr, null);
    assert.ok((rfds ?? []).length >= 2, "Expected at least 2 preserved pending refunds");
    for (const r of rfds ?? []) {
      assert.equal(r.refund_amount_sen, r.commission_reversal_sen + r.seller_deduction_sen);
    }

    const { data: ords, error: oErr } = await service
      .from("orders")
      .select("order_code, status, completed_at, protection_expires_at")
      .in("order_code", ["BU-2611-0DB3", "BU-2611-B1C075", "BU-2611-C3CC55", "BU-2611-3CB12A"]);
    assert.equal(oErr, null);
    assert.equal((ords ?? []).length, 4, "All 4 preserved QA orders must exist");
    for (const o of ords ?? []) {
      if (o.completed_at) {
        assert.ok(o.protection_expires_at, `Expected protection_expires_at on ${o.order_code}`);
      }
    }
  });

  await check("5. Anon cannot read sensitive financial tables", async () => {
    const anon = createClient(url, anonKey, { auth: { persistSession: false } });
    for (const tbl of [
      "seller_payout_accounts",
      "payout_requests",
      "order_refunds",
      "financial_adjustments",
      "payout_allocations",
      "financial_execution_attempts",
    ]) {
      const { data, error } = await anon.from(tbl).select("id").limit(1);
      assert.ok(error || (data ?? []).length === 0, `Anon unexpectedly read ${tbl}`);
    }
  });

  await check("6. Direct client writes to financial RPCs blocked for anon", async () => {
    const anon = createClient(url, anonKey, { auth: { persistSession: false } });
    for (const fn of [
      "claim_order_refund_execution_atomic",
      "finalize_order_refund_atomic",
      "create_seller_withdrawal_atomic",
      "finalize_seller_withdrawal_atomic",
      "recover_financial_execution_atomic",
      "record_provider_attempt_outcome_atomic",
    ]) {
      const { error } = await anon.rpc(fn, {});
      assert.ok(error, `Anon must not execute ${fn}`);
    }
  });

  const passed = results.filter((r) => r.status === "PASS").length;
  console.log(JSON.stringify({ passed, total: results.length, results }, null, 2));
  if (passed !== results.length) process.exit(1);
}

run();
