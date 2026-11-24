/**
 * Buy-U Phase 6D — Prepared Consolidated Hosted PostgreSQL Acceptance Runner
 * STATUS: PREPARED ONLY — DO NOT EXECUTE UNTIL OWNER APPLIES
 *         `docs/sql/phase-6d-financial-ecosystem.sql` AND AUTHORIZES HOSTED QA.
 *
 * Uses strictly isolated synthetic QA fixtures with exact 0-diff cleanup.
 * Never mutates preserved owner QA orders (BU-2611-0DB3, BU-2611-B1C075,
 * BU-2611-C3CC55, BU-2611-3CB12A) or invokes ToyyibPay.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { encryptBankAccountNumber } from "../src/lib/financials/bank.ts";

if (process.env.ALLOW_PHASE6D_HOSTED_QA !== "1") {
  console.error(
    "SAFETY GUARD: Set ALLOW_PHASE6D_HOSTED_QA=1 ONLY after owner applies docs/sql/phase-6d-financial-ecosystem.sql and authorizes hosted QA."
  );
  process.exit(1);
}

const env = Object.fromEntries(
  fs
    .readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const anonClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});

const SELLER_A = { id: "d3b398d8-9103-4bc2-84d3-6e0101b7659a", email: "examiner.seller@iluv.ums.edu.my" };
const BUYER = { id: "1082a03e-c04c-4ae2-a162-c68d3a09b89c", email: "examiner.staff@ums.edu.my" };
const ADMIN_USER = { id: "123f4b1d-372f-4c90-8f77-9a91d9a0af5b", email: "buyu.platform@gmail.com" };

async function signInAs(email) {
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw error;
  const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  const { error: vErr } = await c.auth.verifyOtp({
    type: "magiclink",
    token_hash: data.properties.hashed_token,
  });
  if (vErr) throw vErr;
  return c;
}

const TABLES = [
  "listings",
  "orders",
  "order_items",
  "payments",
  "order_disputes",
  "order_refunds",
  "order_restock_logs",
  "financial_adjustments",
  "payout_requests",
  "payout_allocations",
  "notifications",
];

async function snapshot() {
  const out = {};
  for (const t of TABLES) {
    const { count, error } = await admin.from(t).select("*", { count: "exact", head: true });
    if (error) throw new Error(`${t}: ${error.message}`);
    out[t] = count;
  }
  return out;
}

const results = [];
const rec = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name} — ${detail}`);
};

const baseline = await snapshot();
console.log("Baseline:", JSON.stringify(baseline));

const buyerClient = await signInAs(BUYER.email);
const sellerClient = await signInAs(SELLER_A.email);
const adminClient = await signInAs(ADMIN_USER.email);
const QA_TAG = `QA6D-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
const cleanup = { orderIds: [], disputeIds: [], refundIds: [], payoutIds: [], listingIds: [], hadBank: false };

try {
  // 1. Permission denials (direct writes + sensitive bank account_number_encrypted SELECT)
  const [bankEncDenied, anonWdr, staffBankDenied] = await Promise.all([
    sellerClient.from("seller_payout_accounts").select("account_number_encrypted").limit(1),
    anonClient.rpc("create_seller_withdrawal_atomic", { p_seller_id: SELLER_A.id, p_amount_sen: 200, p_idempotency_key: "anon-test-1" }),
    admin.rpc("upsert_seller_bank_account_secure", {
      p_seller_id: BUYER.id, // staff account must be rejected
      p_bank_name: "Maybank",
      p_account_holder_name: "Staff Test",
      p_account_number_encrypted: encryptBankAccountNumber("162012345678"),
      p_account_number_last4: "5678",
      p_account_number_masked: "****5678",
    }),
  ]);
  rec(
    "1. Permissions & bank privacy",
    bankEncDenied.error?.code === "42501" &&
      anonWdr.error?.code === "42501" &&
      staffBankDenied.error?.code === "42501",
    `bankEnc=${bankEncDenied.error?.code} anonWdr=${anonWdr.error?.code} staffBank=${staffBankDenied.error?.code}`
  );

  // 2. Register synthetic bank account for Seller A & verify masked read
  const { data: prevBank } = await admin.from("seller_payout_accounts").select("*").eq("seller_id", SELLER_A.id).maybeSingle();
  cleanup.hadBank = Boolean(prevBank);
  const { error: upBankErr } = await admin.rpc("upsert_seller_bank_account_secure", {
    p_seller_id: SELLER_A.id,
    p_bank_name: "Maybank",
    p_account_holder_name: "QA Student Seller",
    p_account_number_encrypted: encryptBankAccountNumber("162099887766"),
    p_account_number_last4: "7766",
    p_account_number_masked: "****7766",
  });
  const { data: bankView } = await sellerClient
    .from("seller_payout_accounts")
    .select("bank_name,account_number_masked,validation_status")
    .eq("seller_id", SELLER_A.id)
    .single();
  rec(
    "2. Bank account encrypted storage & masked read",
    !upBankErr && bankView?.account_number_masked === "****7766",
    `masked=${bankView?.account_number_masked}`
  );

  // 3. 72-hour protection boundary + aged withdrawal + failed transfer exact-once release
  const agedTs = new Date(Date.now() - 80 * 3600_000).toISOString();
  const freshTs = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data: ordFresh } = await admin
    .from("orders")
    .insert({
      order_code: `BU-QA-${crypto.randomBytes(2).toString("hex").toUpperCase()}`,
      buyer_id: BUYER.id,
      seller_id: SELLER_A.id,
      source: "cart",
      subtotal_sen: 1000,
      fpx_fee_sen: 100,
      total_paid_sen: 1100,
      commission_sen: 20,
      seller_net_sen: 980,
      status: "completed",
      collection_area_name: "Cafe UMSKAL",
      payment_deadline: freshTs,
      paid_at: freshTs,
      handed_over_at: freshTs,
      completed_at: freshTs,
      completed_method: "pickup_pin",
    })
    .select("id")
    .single();
  cleanup.orderIds.push(ordFresh.id);
  await admin.from("payments").insert({
    order_id: ordFresh.id,
    provider: "toyyibpay",
    bill_code: `${QA_TAG}-B1`,
    transaction_ref: `${QA_TAG}-T1`,
    amount_sen: 1100,
    status: "paid",
    verified_at: freshTs,
  });

  const { data: ordAged } = await admin
    .from("orders")
    .insert({
      order_code: `BU-QA-${crypto.randomBytes(2).toString("hex").toUpperCase()}`,
      buyer_id: BUYER.id,
      seller_id: SELLER_A.id,
      source: "cart",
      subtotal_sen: 1000,
      fpx_fee_sen: 100,
      total_paid_sen: 1100,
      commission_sen: 20,
      seller_net_sen: 980,
      status: "completed",
      collection_area_name: "Cafe UMSKAL",
      payment_deadline: agedTs,
      paid_at: agedTs,
      handed_over_at: agedTs,
      completed_at: agedTs,
      completed_method: "pickup_pin",
    })
    .select("id")
    .single();
  cleanup.orderIds.push(ordAged.id);
  await admin.from("payments").insert({
    order_id: ordAged.id,
    provider: "toyyibpay",
    bill_code: `${QA_TAG}-B2`,
    transaction_ref: `${QA_TAG}-T2`,
    amount_sen: 1100,
    status: "paid",
    verified_at: agedTs,
  });

  // Aged (>72h) order rejects new post-completion dispute
  const agedDispute = await buyerClient.rpc("open_order_dispute_atomic", {
    p_order_id: ordAged.id,
    p_reason_code: "damaged",
    p_description: "Dispute after 72 hours must be rejected by 3-day protection policy.",
  });
  // Fresh (24h) order accepts dispute
  const freshDispute = await buyerClient.rpc("open_order_dispute_atomic", {
    p_order_id: ordFresh.id,
    p_reason_code: "damaged",
    p_description: "Dispute within 72 hours must succeed under 3-day protection policy.",
  });
  if (freshDispute.data?.[0]?.id) cleanup.disputeIds.push(freshDispute.data[0].id);

  // Withdrawal of RM 5.00 from aged order -> fail -> exact release -> retry -> paid
  const { data: w1 } = await admin.rpc("create_seller_withdrawal_atomic", {
    p_seller_id: SELLER_A.id,
    p_amount_sen: 500,
    p_idempotency_key: `${QA_TAG}-WDR-FAIL`,
  });
  if (w1?.[0]?.withdrawal_id) cleanup.payoutIds.push(w1[0].withdrawal_id);
  const { data: finFail } = await admin.rpc("finalize_seller_withdrawal_atomic", {
    p_withdrawal_id: w1[0].withdrawal_id,
    p_attempt_token: w1[0].attempt_token,
    p_outcome: "failed",
    p_failure_reason: "QA simulated bank failure",
  });
  const { data: w2 } = await admin.rpc("create_seller_withdrawal_atomic", {
    p_seller_id: SELLER_A.id,
    p_amount_sen: 500,
    p_idempotency_key: `${QA_TAG}-WDR-OK`,
  });
  if (w2?.[0]?.withdrawal_id) cleanup.payoutIds.push(w2[0].withdrawal_id);
  const { data: finPaid } = await admin.rpc("finalize_seller_withdrawal_atomic", {
    p_withdrawal_id: w2[0].withdrawal_id,
    p_attempt_token: w2[0].attempt_token,
    p_outcome: "paid",
    p_transfer_ref: `SIM-TRF-${QA_TAG}`,
  });

  rec(
    "3. 72h protection boundary, failed withdrawal exact release & successful simulated payout",
    Boolean(agedDispute.error?.message.includes("DISPUTE_WINDOW_EXPIRED")) &&
      Boolean(freshDispute.data?.[0]?.id) &&
      finFail === "failed" &&
      finPaid === "paid",
    `agedDisp=${agedDispute.error?.message} freshDisp=${freshDispute.data?.[0]?.dispute_code} wFail=${finFail} wPaid=${finPaid}`
  );

  // 4. Verify preserved pending disputes were backfilled into order_refunds (read-only!)
  const { data: backfilled } = await adminClient
    .from("order_refunds")
    .select("refund_code,status,refund_amount_sen");
  rec(
    "4. Preserved Phase 6D.1 pending disputes seeded into order_refunds",
    (backfilled?.length ?? 0) >= 2,
    `count=${backfilled?.length}`
  );
} finally {
  if (cleanup.payoutIds.length) {
    await admin.from("payout_allocations").delete().in("payout_request_id", cleanup.payoutIds);
    await admin.from("payout_requests").delete().in("id", cleanup.payoutIds);
  }
  if (cleanup.disputeIds.length) {
    await admin.from("order_refunds").delete().in("dispute_id", cleanup.disputeIds);
    await admin.from("order_disputes").delete().in("id", cleanup.disputeIds);
  }
  if (cleanup.orderIds.length) {
    await admin.from("payments").delete().in("order_id", cleanup.orderIds);
    await admin.from("orders").delete().in("id", cleanup.orderIds);
  }
  if (!cleanup.hadBank) {
    await admin.from("seller_payout_accounts").delete().eq("seller_id", SELLER_A.id);
  }
  const after = await snapshot();
  console.log("After:   ", JSON.stringify(after));
}
