import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import crypto from "node:crypto";
import {
  BUYER_PROTECTION_HOURS,
  MIN_WITHDRAWAL_SEN,
  calculateRefundBreakdown,
  getProtectionExpiresAt,
  isAuthoritativeOrderPaymentVerified,
  isEligibleForWithdrawalRelease,
  isWithinBuyerProtectionWindow,
} from "../src/lib/financials/policy.ts";
import {
  MALAYSIAN_BANKS,
  encryptBankAccountNumber,
  maskBankAccountNumber,
  validateBankAccountInput,
} from "../src/lib/financials/bank.ts";
import {
  SimulatedBankPayoutProvider,
  SimulatedRefundProvider,
  getBankPayoutProvider,
  getRefundExecutionProvider,
} from "../src/lib/financials/providers.ts";
import {
  classifyPersistedRecoveryEvidence,
  runDurableRecoverySweep,
} from "../src/lib/financials/recovery.ts";
import {
  buildSanitizedFinancialCsv,
  computePlatformFinancialReconciliation,
} from "../src/lib/financials/reconciliation.ts";
import { computeSellerFinancials } from "../src/lib/seller/financials.ts";

const ROOT = process.cwd();
const SQL = fs.readFileSync(
  path.join(ROOT, "docs/sql/phase-6d-financial-ecosystem.sql"),
  "utf8"
);
const ACTIONS_SRC = fs.readFileSync(
  path.join(ROOT, "src/app/financials/actions.ts"),
  "utf8"
);
const DISPUTE_ACTIONS_SRC = fs.readFileSync(
  path.join(ROOT, "src/app/disputes/actions.ts"),
  "utf8"
);
const SELLER_DATA_SRC = fs.readFileSync(
  path.join(ROOT, "src/lib/seller/data.ts"),
  "utf8"
);

// -----------------------------------------------------------------------------
// 1. P0.1 — Legacy Dispute Resolution RPC Removal & Unambiguous Caller
// -----------------------------------------------------------------------------
test("P0.1: legacy 4-param admin_resolve_order_dispute_atomic is dropped and callers use 6-param RPC", () => {
  assert.match(
    SQL,
    /DROP FUNCTION IF EXISTS public\.admin_resolve_order_dispute_atomic\(uuid,\s*text,\s*integer,\s*text\)/i
  );
  const createMatches =
    SQL.match(/CREATE OR REPLACE FUNCTION public\.admin_resolve_order_dispute_atomic\(/g) ?? [];
  assert.equal(createMatches.length, 1);
  assert.match(SQL, /p_return_required boolean DEFAULT false/);
  assert.match(DISPUTE_ACTIONS_SRC, /p_return_required:/);
  assert.match(DISPUTE_ACTIONS_SRC, /p_return_instructions:/);
});

// -----------------------------------------------------------------------------
// 2. P0.2 — Legacy Bank Account Security & Encrypted Eligibility
// -----------------------------------------------------------------------------
test("P0.2: legacy plaintext bank accounts are safely deactivated, masked, and blocked from withdrawals", () => {
  assert.match(SQL, /validation_status = 're_registration_required'/);
  assert.match(SQL, /duitnow_id = NULL/);
  assert.match(SQL, /seller_payout_accounts_active_encrypted_check/);
  assert.match(SQL, /b\.account_number_encrypted LIKE 'v1:%'/);
  assert.doesNotMatch(
    SELLER_DATA_SRC,
    /\.select\([^)]*account_number[^_]/,
    "seller/data.ts must never select raw account_number"
  );
  assert.doesNotMatch(
    SELLER_DATA_SRC,
    /duitnow_id/,
    "seller/data.ts must never select duitnow_id"
  );
});

test("P0.2: Malaysian bank validation, masking, and AES-256-GCM encryption round-trip", () => {
  assert.ok(MALAYSIAN_BANKS.includes("Maybank"));
  assert.ok(MALAYSIAN_BANKS.includes("Bank Islam"));

  const valid = validateBankAccountInput({
    bankName: "Maybank",
    accountHolderName: "Aisyah Binti Ahmad",
    accountNumber: "1140 1234 5678",
    confirmAccountNumber: "114012345678",
  });
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.masked, "****5678");
    assert.equal(valid.last4, "5678");
  }

  assert.equal(
    validateBankAccountInput({
      bankName: "Unsupported Bank",
      accountHolderName: "Aisyah",
      accountNumber: "114012345678",
      confirmAccountNumber: "114012345678",
    }).ok,
    false
  );

  assert.equal(maskBankAccountNumber("123456789012").masked, "****9012");

  const prevKey = process.env.BUYU_BANK_ENCRYPTION_KEY;
  const testKey = crypto.randomBytes(32).toString("hex");
  process.env.BUYU_BANK_ENCRYPTION_KEY = testKey;
  try {
    const enc = encryptBankAccountNumber("114012345678");
    assert.ok(enc.startsWith("v1:"));
    assert.ok(!enc.includes("114012345678"));
    const [, ivHex, tagHex, dataHex] = enc.split(":");
    const derived = crypto.createHash("sha256").update(testKey, "utf8").digest();
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      derived,
      Buffer.from(ivHex, "hex")
    );
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(dataHex, "hex")),
      decipher.final(),
    ]).toString("utf8");
    assert.equal(plain, "114012345678");
  } finally {
    if (prevKey === undefined) delete process.env.BUYU_BANK_ENCRYPTION_KEY;
    else process.env.BUYU_BANK_ENCRYPTION_KEY = prevKey;
  }
});

// -----------------------------------------------------------------------------
// 3. P0.3 — Bank Upsert PK Constraint & Withdrawal Concurrency Lock
// -----------------------------------------------------------------------------
test("P0.3: bank upsert uses explicit seller_payout_accounts_pkey and shared seller lock", () => {
  assert.match(SQL, /ON CONFLICT ON CONSTRAINT seller_payout_accounts_pkey DO UPDATE/);
  const upsertBlock = SQL.slice(
    SQL.indexOf("FUNCTION public.upsert_seller_bank_account_secure"),
    SQL.indexOf("FUNCTION public.deactivate_seller_bank_account_secure")
  );
  assert.match(upsertBlock, /out_seller_id/);
  assert.match(upsertBlock, /PERFORM 1 FROM public\.profiles p WHERE p\.id = p_seller_id FOR UPDATE/);

  const deactBlock = SQL.slice(
    SQL.indexOf("FUNCTION public.deactivate_seller_bank_account_secure"),
    SQL.indexOf("FUNCTION public.create_seller_withdrawal_atomic")
  );
  assert.match(deactBlock, /PERFORM 1 FROM public\.profiles p WHERE p\.id = p_seller_id FOR UPDATE/);
});

// -----------------------------------------------------------------------------
// 4. P0.4 & P0.5 — Durable Attempt History, Deterministic Refs & Interruption Recovery
// -----------------------------------------------------------------------------
test("P0.4 & P0.5: unsafe admin release removed; durable attempt table & provider outcome persistence present", () => {
  assert.match(SQL, /DROP FUNCTION IF EXISTS public\.admin_release_failed_withdrawal_atomic/i);
  assert.match(SQL, /CREATE TABLE IF NOT EXISTS public\.financial_execution_attempts/);
  assert.match(SQL, /FUNCTION public\.record_provider_attempt_outcome_atomic/);
  assert.match(SQL, /FUNCTION public\.recover_financial_execution_atomic/);
  assert.match(SQL, /ALLOCATION_MISMATCH/);
  assert.match(ACTIONS_SRC, /record_provider_attempt_outcome_atomic/);
  assert.match(ACTIONS_SRC, /recover_financial_execution_atomic/);
  assert.doesNotMatch(ACTIONS_SRC, /admin_release_failed_withdrawal_atomic/);
});

test("P0.5: deterministic provider refs survive replay & fail closed in production", async () => {
  const rfd = new SimulatedRefundProvider();
  const r1 = await rfd.executeRefund({
    refundCode: "RFD-2611-ABC123",
    orderId: "ord-1",
    amountSen: 500,
    idempotencyKey: "rfd-logical-1",
  });
  const r2 = await rfd.executeRefund({
    refundCode: "RFD-2611-ABC123",
    orderId: "ord-1",
    amountSen: 500,
    idempotencyKey: "rfd-logical-1",
  });
  assert.equal(r1.outcome, "succeeded");
  assert.equal(r1.refundRef, r2.refundRef, "Replayed logical_tx_id must yield identical ref");
  assert.match(r1.refundRef ?? "", /^SIM-RFD-2611-ABC123-[A-F0-9]{8}$/);

  const bank = new SimulatedBankPayoutProvider();
  const w1 = await bank.executeDisbursement({
    withdrawalCode: "WDR-2611-XYZ999",
    sellerId: "sel-1",
    amountSen: 1470,
    idempotencyKey: "wdr-logical-1",
    bankName: "Maybank",
    accountLast4: "5678",
  });
  const w2 = await bank.executeDisbursement({
    withdrawalCode: "WDR-2611-XYZ999",
    sellerId: "sel-1",
    amountSen: 1470,
    idempotencyKey: "wdr-logical-1",
    bankName: "Maybank",
    accountLast4: "5678",
  });
  assert.equal(w1.outcome, "paid");
  assert.equal(w1.transferRef, w2.transferRef);

  const prevEnv = process.env.BUYU_PAYMENT_ENV;
  process.env.BUYU_PAYMENT_ENV = "production";
  try {
    assert.throws(() => getRefundExecutionProvider(), /FAIL_CLOSED/);
    assert.throws(() => getBankPayoutProvider(), /FAIL_CLOSED/);
  } finally {
    if (prevEnv === undefined) delete process.env.BUYU_PAYMENT_ENV;
    else process.env.BUYU_PAYMENT_ENV = prevEnv;
  }
});

test("P0.4 & P0.5: interruption/restart recovery finalizes persisted success/failure and HOLDS uncertain funds", async () => {
  // Simulate server crash AFTER provider outcome persisted, BEFORE finalization:
  //   1. Withdrawal A: provider succeeded (SIM-TRF-...) -> crash -> recovery finalizes PAID once
  //   2. Withdrawal B: provider failed -> crash -> recovery finalizes FAILED & releases allocations once
  //   3. Withdrawal C: provider timeout / no recorded outcome -> recovery MUST HOLD (never release!)
  //   4. Refund D: provider succeeded (SIM-RFD-...) -> crash -> recovery finalizes SUCCEEDED once
  const dbState = {
    wA: { status: "processing", allocations: "reserved", ref: null },
    wB: { status: "processing", allocations: "reserved", ref: null },
    wC: { status: "reconciliation_required", allocations: "reserved", ref: null },
    rD: { status: "processing", ref: null },
  };
  let finalizeCalls = 0;

  const entities = [
    {
      entityType: "withdrawal",
      entityId: "wA",
      code: "WDR-2611-AAAAAA",
      logicalTxId: "wdr-a",
      status: "processing",
      attemptToken: "tok-a",
      latestAttempt: {
        entityType: "withdrawal",
        entityId: "wA",
        logicalTxId: "wdr-a",
        attemptToken: "tok-a",
        attemptNumber: 1,
        status: "provider_succeeded",
        providerOutcome: "paid",
        simulationRef: "SIM-TRF-2611-AAAAAA-12345678",
        failureOrUncertaintyReason: null,
        startedAt: "2026-11-24T01:00:00Z",
        providerRecordedAt: "2026-11-24T01:00:02Z",
        finalizedAt: null,
      },
    },
    {
      entityType: "withdrawal",
      entityId: "wB",
      code: "WDR-2611-BBBBBB",
      logicalTxId: "wdr-b",
      status: "processing",
      attemptToken: "tok-b",
      latestAttempt: {
        entityType: "withdrawal",
        entityId: "wB",
        logicalTxId: "wdr-b",
        attemptToken: "tok-b",
        attemptNumber: 1,
        status: "provider_failed",
        providerOutcome: "failed",
        simulationRef: null,
        failureOrUncertaintyReason: "Simulated bank rejection",
        startedAt: "2026-11-24T01:00:00Z",
        providerRecordedAt: "2026-11-24T01:00:02Z",
        finalizedAt: null,
      },
    },
    {
      entityType: "withdrawal",
      entityId: "wC",
      code: "WDR-2611-CCCCCC",
      logicalTxId: "wdr-c",
      status: "reconciliation_required",
      attemptToken: "tok-c",
      latestAttempt: {
        entityType: "withdrawal",
        entityId: "wC",
        logicalTxId: "wdr-c",
        attemptToken: "tok-c",
        attemptNumber: 1,
        status: "provider_uncertain",
        providerOutcome: "reconciliation_required",
        simulationRef: null,
        failureOrUncertaintyReason: "Gateway timeout",
        startedAt: "2026-11-20T01:00:00Z", // Even 4 days old, elapsed time NEVER releases!
        providerRecordedAt: "2026-11-20T01:00:05Z",
        finalizedAt: null,
      },
    },
    {
      entityType: "refund",
      entityId: "rD",
      code: "RFD-2611-DDDDDD",
      logicalTxId: "rfd-d",
      status: "processing",
      attemptToken: "tok-d",
      latestAttempt: {
        entityType: "refund",
        entityId: "rD",
        logicalTxId: "rfd-d",
        attemptToken: "tok-d",
        attemptNumber: 1,
        status: "provider_succeeded",
        providerOutcome: "succeeded",
        simulationRef: "SIM-RFD-2611-DDDDDD-87654321",
        failureOrUncertaintyReason: null,
        startedAt: "2026-11-24T01:00:00Z",
        providerRecordedAt: "2026-11-24T01:00:02Z",
        finalizedAt: null,
      },
    },
  ];

  // Verify unsafe uncertain release is classified as hold_uncertain
  assert.equal(classifyPersistedRecoveryEvidence(entities[2]), "hold_uncertain");

  const store = {
    async listPendingEntities() {
      return entities;
    },
    async finalizeFromPersistedEvidence(entityType, entityId) {
      finalizeCalls += 1;
      if (entityId === "wA") {
        dbState.wA.status = "paid";
        dbState.wA.allocations = "paid";
        dbState.wA.ref = "SIM-TRF-2611-AAAAAA-12345678";
        entities[0].status = "paid";
        return "paid";
      }
      if (entityId === "wB") {
        dbState.wB.status = "failed";
        dbState.wB.allocations = "released";
        entities[1].status = "failed";
        return "failed";
      }
      if (entityId === "rD") {
        dbState.rD.status = "succeeded";
        dbState.rD.ref = "SIM-RFD-2611-DDDDDD-87654321";
        entities[3].status = "succeeded";
        return "succeeded";
      }
      return "held_uncertain";
    },
  };

  // Pass 1 (after simulated crash/restart)
  const res1 = await runDurableRecoverySweep(store);
  assert.equal(res1.find((x) => x.entityId === "wA")?.result, "paid");
  assert.equal(res1.find((x) => x.entityId === "wB")?.result, "failed");
  assert.equal(res1.find((x) => x.entityId === "wC")?.result, "held_uncertain");
  assert.equal(res1.find((x) => x.entityId === "rD")?.result, "succeeded");
  assert.equal(dbState.wA.allocations, "paid");
  assert.equal(dbState.wB.allocations, "released");
  assert.equal(dbState.wC.allocations, "reserved", "Uncertain withdrawal MUST remain reserved");
  assert.equal(finalizeCalls, 3);

  // Pass 2 (idempotent replay — ZERO additional finalization calls!)
  const res2 = await runDurableRecoverySweep(store);
  assert.equal(finalizeCalls, 3, "Replay must not duplicate finalizations or releases");
  assert.equal(res2.find((x) => x.entityId === "wC")?.result, "held_uncertain");
});

// -----------------------------------------------------------------------------
// 5. P0.6 — Authoritative Payment Proof & Unverified Order Rejection
// -----------------------------------------------------------------------------
test("P0.6: rejects unverified completed orders even if orders.paid_at is populated", () => {
  assert.equal(
    isAuthoritativeOrderPaymentVerified({
      order: { id: "o1", buyer_id: "b1", checkout_session_id: "cs1", paid_at: "2026-11-20T00:00:00Z" },
      checkoutSession: { id: "cs1", buyer_id: "b1", status: "paid", payment_status: "paid", paid_at: "2026-11-20T00:00:00Z" },
    }),
    true
  );
  // Spoofed paid_at with unpaid parent checkout -> REJECTED
  assert.equal(
    isAuthoritativeOrderPaymentVerified({
      order: { id: "o2", buyer_id: "b1", checkout_session_id: "cs2", paid_at: "2026-11-20T00:00:00Z" },
      checkoutSession: { id: "cs2", buyer_id: "b1", status: "pending_payment", payment_status: "pending", paid_at: null },
    }),
    false
  );
  // Spoofed paid_at with mismatched buyer_id -> REJECTED
  assert.equal(
    isAuthoritativeOrderPaymentVerified({
      order: { id: "o3", buyer_id: "b1", checkout_session_id: "cs3", paid_at: "2026-11-20T00:00:00Z" },
      checkoutSession: { id: "cs3", buyer_id: "other-buyer", status: "paid", payment_status: "paid", paid_at: "2026-11-20T00:00:00Z" },
    }),
    false
  );
  // Legacy order without verified_at -> REJECTED
  assert.equal(
    isAuthoritativeOrderPaymentVerified({
      order: { id: "o4", buyer_id: "b1", checkout_session_id: null, paid_at: "2026-11-20T00:00:00Z" },
      legacyPayment: { order_id: "o4", status: "paid", verified_at: null },
    }),
    false
  );

  // Seller balance calculation MUST exclude unverified completed fixture
  const now = new Date("2026-11-24T00:00:00Z");
  const sellerFin = computeSellerFinancials({
    orders: [
      {
        id: "unverified-ord",
        order_code: "BU-FAKE-1",
        buyer_id: "b1",
        checkout_session_id: "cs-unpaid",
        subtotal_sen: 2000,
        commission_sen: 40,
        seller_net_sen: 1960,
        total_paid_sen: 2100,
        status: "completed",
        paid_at: "2026-11-18T00:00:00Z",
        completed_at: "2026-11-19T00:00:00Z",
        created_at: "2026-11-18T00:00:00Z",
      },
    ],
    orderItems: [],
    payments: [],
    checkoutSessions: [
      { id: "cs-unpaid", buyer_id: "b1", status: "pending_payment", payment_status: "pending", paid_at: null },
    ],
    payoutRequests: [],
    disputes: [],
    refunds: [],
    range: "all",
    now,
  });
  assert.equal(sellerFin.availableForPayoutSen, 0);
  assert.equal(sellerFin.totalSalesSen, 0);
});

// -----------------------------------------------------------------------------
// 6. P0.7 — Historical 7-Day Transition vs Exact 72-Hour New Completion Boundary
// -----------------------------------------------------------------------------
test("P0.7: historical completed orders keep 7-day deadline; new completions use exact 72-hour boundary", () => {
  assert.equal(BUYER_PROTECTION_HOURS, 72);
  assert.equal(MIN_WITHDRAWAL_SEN, 200);

  const completedAt = "2026-11-20T10:00:00.000Z";
  // New completion (no explicit historical 7-day override): 72h exact boundary
  assert.equal(getProtectionExpiresAt(completedAt), "2026-11-23T10:00:00.000Z");
  const t71h59m59s = Date.parse("2026-11-23T09:59:59.000Z");
  const t72h00m00s = Date.parse("2026-11-23T10:00:00.000Z");
  assert.equal(isWithinBuyerProtectionWindow(completedAt, t71h59m59s), true);
  assert.equal(isEligibleForWithdrawalRelease(completedAt, t71h59m59s), false);
  assert.equal(isWithinBuyerProtectionWindow(completedAt, t72h00m00s), false);
  assert.equal(isEligibleForWithdrawalRelease(completedAt, t72h00m00s), true);

  // Historical pre-6D completion with preserved 7-day protection_expires_at:
  const historicalExp = "2026-11-27T10:00:00.000Z";
  assert.equal(getProtectionExpiresAt(completedAt, historicalExp), historicalExp);
  // At 72h00m00s, historical order is STILL protected (dispute allowed, withdrawal blocked!)
  assert.equal(isWithinBuyerProtectionWindow(completedAt, t72h00m00s, historicalExp), true);
  assert.equal(isEligibleForWithdrawalRelease(completedAt, t72h00m00s, historicalExp), false);
  // At 7d00m00s, historical order releases for withdrawal
  const t7d = Date.parse(historicalExp);
  assert.equal(isWithinBuyerProtectionWindow(completedAt, t7d, historicalExp), false);
  assert.equal(isEligibleForWithdrawalRelease(completedAt, t7d, historicalExp), true);

  // Verify SQL trigger & historical backfill
  assert.match(SQL, /ADD COLUMN IF NOT EXISTS protection_expires_at timestamptz/);
  assert.match(SQL, /SET protection_expires_at = completed_at \+ interval '7 days'/);
  assert.match(SQL, /NEW\.protection_expires_at := NEW\.completed_at \+ interval '72 hours'/);
});

// -----------------------------------------------------------------------------
// 7. P0.8 & P0.9 — Return/Restock Integrity, Shared Lock Order & Privacy Guards
// -----------------------------------------------------------------------------
test("P0.8 & P0.9: restock separation, food/damaged/quantity guards, lock order, and participant-safe RPC returns", () => {
  assert.match(SQL, /approved_pending_refund/);
  assert.match(SQL, /FOOD_OR_SERVICE_NOT_RESTOCKABLE/);
  assert.match(SQL, /RESTOCK_UNSUITABLE_CONDITION/);
  assert.match(SQL, /INVALID_RESTOCK_QUANTITY/);
  assert.match(SQL, /MISSING_ITEM_REQUIRES_ADMIN_EXCEPTION/);
  assert.match(SQL, /ADMIN_EXCEPTION_REASON_REQUIRED/);
  assert.match(SQL, /REFUND_ALREADY_COMPLETED/);
  assert.match(SQL, /GREATEST\(reserved_quantity, quantity \+ v_plan_item\.restore_qty\)/);
  assert.match(SQL, /FUNCTION public\.safe_insert_notification/);
  assert.match(SQL, /p_outcome IS NULL OR p_outcome NOT IN/);

  // Ensure NO public participant RPC returns raw composite `RETURNS public.order_refunds`
  assert.doesNotMatch(
    SQL,
    /RETURNS public\.order_refunds/,
    "Participant RPCs must return explicit safe columns, never raw order_refunds rows"
  );
});

// -----------------------------------------------------------------------------
// 8. P0.10 — Full Fixture Accounting Equations, Blocking Refunds & No Negative Balances
// -----------------------------------------------------------------------------
test("P0.10: full multi-order fixture verifies all financial equations, blocking refunds, and CSV privacy", () => {
  // Exact preserved QA math
  const full = calculateRefundBreakdown({ subtotalSen: 1500, originalCommissionSen: 30, refundAmountSen: 1500 });
  assert.equal(full.commissionReversalSen, 30);
  assert.equal(full.sellerDeductionSen, 1470);
  assert.equal(full.refundAmountSen, full.commissionReversalSen + full.sellerDeductionSen);

  const partial = calculateRefundBreakdown({ subtotalSen: 2000, originalCommissionSen: 40, refundAmountSen: 500 });
  assert.equal(partial.commissionReversalSen, 10);
  assert.equal(partial.sellerDeductionSen, 490);
  assert.equal(partial.adjustedSellerNetSen, 1470);

  const nowMs = Date.parse("2026-11-24T12:00:00Z");
  const overview = computePlatformFinancialReconciliation({
    checkoutSessions: [
      {
        id: "cs-1",
        buyer_id: "b1",
        checkout_code: "CHK-2611-053C84",
        combined_subtotal_sen: 3500,
        fpx_fee_sen: 100,
        total_paid_sen: 3600,
        status: "paid",
        payment_status: "paid",
        transaction_ref: "TP-001",
        paid_at: "2026-11-20T00:00:00Z",
      },
    ],
    legacyPayments: [
      {
        id: "pay-1",
        order_id: "ord-legacy",
        amount_sen: 1600,
        status: "paid",
        transaction_ref: "TP-LEG-001",
        verified_at: "2026-11-19T00:00:00Z",
      },
    ],
    orders: [
      // Matured completed order (RM 15 -> net RM 14.70, RM 10 withdrawn, RM 4.70 available)
      {
        id: "ord-a",
        buyer_id: "b1",
        order_code: "BU-2611-B1C075",
        checkout_session_id: "cs-1",
        seller_id: "s1",
        subtotal_sen: 1500,
        fpx_fee_sen: 0,
        commission_sen: 30,
        seller_net_sen: 1470,
        status: "completed",
        paid_at: "2026-11-20T00:00:00Z",
        completed_at: "2026-11-20T01:00:00Z",
        protection_expires_at: "2026-11-23T01:00:00Z",
      },
      // Order with FAILED refund execution -> MUST remain frozen (never available!)
      {
        id: "ord-b",
        buyer_id: "b1",
        order_code: "BU-2611-C3CC55",
        checkout_session_id: "cs-1",
        seller_id: "s2",
        subtotal_sen: 2000,
        fpx_fee_sen: 0,
        commission_sen: 40,
        seller_net_sen: 1960,
        status: "completed",
        paid_at: "2026-11-20T00:00:00Z",
        completed_at: "2026-11-20T01:00:00Z",
        protection_expires_at: "2026-11-23T01:00:00Z",
      },
      // Legacy fully refunded order (RM 15 refunded, RM 0.30 comm reversed, RM 14.70 seller deducted)
      {
        id: "ord-legacy",
        buyer_id: "b2",
        order_code: "BU-2611-3CB12A",
        checkout_session_id: null,
        seller_id: "s1",
        subtotal_sen: 1500,
        fpx_fee_sen: 100,
        commission_sen: 30,
        seller_net_sen: 1470,
        status: "refunded",
        paid_at: "2026-11-19T00:00:00Z",
        completed_at: null,
      },
    ],
    disputes: [],
    refunds: [
      {
        id: "rfd-1",
        order_id: "ord-legacy",
        refund_amount_sen: 1500,
        commission_reversal_sen: 30,
        seller_deduction_sen: 1470,
        status: "succeeded",
        refund_ref: "SIM-RFD-LEGACY-11223344",
      },
      {
        id: "rfd-failed",
        order_id: "ord-b",
        refund_amount_sen: 500,
        commission_reversal_sen: 10,
        seller_deduction_sen: 490,
        status: "failed",
        refund_ref: null,
      },
    ],
    payouts: [
      {
        id: "wdr-1",
        withdrawal_code: "WDR-2611-111111",
        seller_id: "s1",
        amount_sen: 1000,
        status: "paid",
        transfer_ref: "SIM-TRF-2611-111111-AABBCCDD",
        processing_started_at: "2026-11-24T01:00:00Z",
        created_at: "2026-11-24T01:00:00Z",
      },
      {
        id: "wdr-fail",
        withdrawal_code: "WDR-2611-222222",
        seller_id: "s1",
        amount_sen: 500,
        status: "failed",
        transfer_ref: null,
        processing_started_at: "2026-11-24T02:00:00Z",
        created_at: "2026-11-24T02:00:00Z",
      },
    ],
    nowMs,
  });

  // Verify ALL accounting equations on actual fixture data
  assert.equal(overview.totalVerifiedCollectionsSen, 5200); // 3600 + 1600
  assert.equal(overview.grossProductSalesSen, 5000); // 1500 + 2000 + 1500
  assert.equal(overview.fpxFeesCollectedSen, 200); // 100 + 100
  assert.equal(
    overview.totalVerifiedCollectionsSen,
    overview.grossProductSalesSen + overview.fpxFeesCollectedSen
  );
  assert.equal(overview.executedRefundsSen, 1500);
  assert.equal(overview.netProductSalesSen, 3500);
  assert.equal(overview.netPlatformCommissionSen, 70); // (30+40+30) - 30
  assert.equal(overview.frozenEarningsSen, 1960, "Failed refund order MUST remain frozen");
  assert.equal(overview.successfullyPaidOutSen, 1000);
  assert.equal(overview.availableSellerLiabilitiesSen, 470); // 1470 - 1000
  assert.ok(overview.availableSellerLiabilitiesSen >= 0);
  assert.ok(overview.checks.every((c) => c.status === "PASS"));

  const csv = buildSanitizedFinancialCsv([
    {
      type: "withdrawal",
      reference: "SIM-TRF-2611-111111-AABBCCDD",
      orderOrCheckoutCode: "WDR-2611-111111",
      status: "paid",
      amountRm: "10.00",
      maskedDestination: "Maybank · ****5678",
      simulationMode: "simulated",
      timestamp: "2026-11-24T01:00:00Z",
    },
  ]);
  assert.match(csv, /SIM-TRF-2611-111111-AABBCCDD/);
  assert.match(csv, /\*{4}5678/);
  assert.ok(!csv.includes("114012345678"));
});
