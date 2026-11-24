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

test("P0.4 & P0.5 & P0.14: all 7 interrupted-processing recovery scenarios execute cleanly", async () => {
  const nowMs = Date.parse("2026-11-24T01:05:00Z");
  const bankProvider = new SimulatedBankPayoutProvider();
  const refundProvider = new SimulatedRefundProvider();

  // State across all 7 scenarios:
  //   1. wClaimCrash:  Crash after claim, before provider execution (stale started > 60s)
  //   2. rExecCrash:   Crash after simulated provider execution, before outcome persistence (stale started > 60s)
  //   3. wPersistCrash: Crash after outcome persistence, before finalization
  //   4. wInFlight:    Concurrent normal processing (< 60s old started -> active_in_flight, NOT raced!)
  //   5. (Duplicate sweep verified on Pass 2 -> zero duplicate writes/releases!)
  //   6. wDefFail:     Definitive provider failure -> restores withdrawal allocations once
  //   7. wUncertain:   Truly uncertain outcome (`reconciliation_required`) -> retains reservation
  const dbState = {
    wClaimCrash: { status: "processing", allocations: "reserved", ref: null, recordedOutcome: null },
    rExecCrash: { status: "processing", ref: null, recordedOutcome: null },
    wPersistCrash: { status: "processing", allocations: "reserved", ref: null, recordedOutcome: "paid" },
    wInFlight: { status: "processing", allocations: "reserved", ref: null, recordedOutcome: null },
    wDefFail: { status: "processing", allocations: "reserved", ref: null, recordedOutcome: "failed" },
    wUncertain: { status: "reconciliation_required", allocations: "reserved", ref: null, recordedOutcome: "reconciliation_required" },
  };
  let providerReexecCalls = 0;
  let finalizeCalls = 0;

  const entities = [
    {
      entityType: "withdrawal",
      entityId: "wClaimCrash",
      code: "WDR-2611-CLAIM1",
      logicalTxId: "wdr-claim-1",
      status: "processing",
      attemptToken: "tok-claim1",
      amountSen: 1000,
      sellerId: "s1",
      maskedBankSummary: "Maybank · ****5678",
      latestAttempt: {
        entityType: "withdrawal",
        entityId: "wClaimCrash",
        logicalTxId: "wdr-claim-1",
        attemptToken: "tok-claim1",
        attemptNumber: 1,
        simulationMode: true,
        status: "started",
        providerOutcome: null,
        simulationRef: null,
        failureOrUncertaintyReason: null,
        startedAt: "2026-11-24T01:00:00Z", // 5 min old -> stale
        providerRecordedAt: null,
        finalizedAt: null,
      },
    },
    {
      entityType: "refund",
      entityId: "rExecCrash",
      code: "RFD-2611-EXEC02",
      logicalTxId: "rfd-exec-2",
      status: "processing",
      attemptToken: "tok-exec2",
      amountSen: 500,
      orderId: "ord-2",
      latestAttempt: {
        entityType: "refund",
        entityId: "rExecCrash",
        logicalTxId: "rfd-exec-2",
        attemptToken: "tok-exec2",
        attemptNumber: 1,
        simulationMode: true,
        status: "started",
        providerOutcome: null,
        simulationRef: null,
        failureOrUncertaintyReason: null,
        startedAt: "2026-11-24T01:00:00Z", // 5 min old -> stale
        providerRecordedAt: null,
        finalizedAt: null,
      },
    },
    {
      entityType: "withdrawal",
      entityId: "wPersistCrash",
      code: "WDR-2611-PERS03",
      logicalTxId: "wdr-pers-3",
      status: "processing",
      attemptToken: "tok-pers3",
      amountSen: 1470,
      sellerId: "s1",
      maskedBankSummary: "Maybank · ****5678",
      latestAttempt: {
        entityType: "withdrawal",
        entityId: "wPersistCrash",
        logicalTxId: "wdr-pers-3",
        attemptToken: "tok-pers3",
        attemptNumber: 1,
        simulationMode: true,
        status: "provider_succeeded",
        providerOutcome: "paid",
        simulationRef: "SIM-TRF-2611-PERS03-12345678",
        failureOrUncertaintyReason: null,
        startedAt: "2026-11-24T01:00:00Z",
        providerRecordedAt: "2026-11-24T01:00:02Z",
        finalizedAt: null,
      },
    },
    {
      entityType: "withdrawal",
      entityId: "wInFlight",
      code: "WDR-2611-LIVE04",
      logicalTxId: "wdr-live-4",
      status: "processing",
      attemptToken: "tok-live4",
      amountSen: 500,
      sellerId: "s1",
      maskedBankSummary: "Maybank · ****5678",
      latestAttempt: {
        entityType: "withdrawal",
        entityId: "wInFlight",
        logicalTxId: "wdr-live-4",
        attemptToken: "tok-live4",
        attemptNumber: 1,
        simulationMode: true,
        status: "started",
        providerOutcome: null,
        simulationRef: null,
        failureOrUncertaintyReason: null,
        startedAt: "2026-11-24T01:04:45Z", // 15s old -> active in-flight!
        providerRecordedAt: null,
        finalizedAt: null,
      },
    },
    {
      entityType: "withdrawal",
      entityId: "wDefFail",
      code: "WDR-2611-FAIL06",
      logicalTxId: "wdr-fail-6",
      status: "processing",
      attemptToken: "tok-fail6",
      amountSen: 800,
      sellerId: "s1",
      maskedBankSummary: "Maybank · ****5678",
      latestAttempt: {
        entityType: "withdrawal",
        entityId: "wDefFail",
        logicalTxId: "wdr-fail-6",
        attemptToken: "tok-fail6",
        attemptNumber: 1,
        simulationMode: true,
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
      entityId: "wUncertain",
      code: "WDR-2611-UNCT07",
      logicalTxId: "wdr-unct-7",
      status: "reconciliation_required",
      attemptToken: "tok-unct7",
      amountSen: 900,
      sellerId: "s1",
      maskedBankSummary: "Maybank · ****5678",
      latestAttempt: {
        entityType: "withdrawal",
        entityId: "wUncertain",
        logicalTxId: "wdr-unct-7",
        attemptToken: "tok-unct7",
        attemptNumber: 1,
        simulationMode: true,
        status: "provider_uncertain",
        providerOutcome: "reconciliation_required",
        simulationRef: null,
        failureOrUncertaintyReason: "Gateway timeout",
        startedAt: "2026-11-20T01:00:00Z",
        providerRecordedAt: "2026-11-20T01:00:05Z",
        finalizedAt: null,
      },
    },
  ];

  // Verify Scenario 4 (concurrent normal processing) and Scenario 7 (uncertain) classifications
  assert.equal(classifyPersistedRecoveryEvidence(entities[3], nowMs), "active_in_flight");
  assert.equal(classifyPersistedRecoveryEvidence(entities[5], nowMs), "hold_uncertain");

  // Pre-compute what Scenario 2's provider returned BEFORE the crash so we prove deterministic match
  const preCrashRefundRef = refundProvider.deriveDeterministicRef("RFD-2611-EXEC02", "rfd-exec-2");

  const store = {
    async listPendingEntities() {
      return entities;
    },
    async executeAndRecordSimulatedProvider(entity) {
      providerReexecCalls += 1;
      if (entity.entityType === "withdrawal") {
        const r = await bankProvider.executeDisbursement({
          withdrawalCode: entity.code,
          sellerId: entity.sellerId ?? "",
          amountSen: entity.amountSen,
          idempotencyKey: entity.logicalTxId,
          bankName: "Maybank",
          accountLast4: "5678",
        });
        dbState[entity.entityId].recordedOutcome = r.outcome;
        dbState[entity.entityId].ref = r.transferRef ?? null;
        return { outcome: r.outcome, simulationRef: r.transferRef ?? null, reason: null };
      }
      const r = await refundProvider.executeRefund({
        refundCode: entity.code,
        orderId: entity.orderId ?? "",
        amountSen: entity.amountSen,
        idempotencyKey: entity.logicalTxId,
      });
      dbState[entity.entityId].recordedOutcome = r.outcome;
      dbState[entity.entityId].ref = r.refundRef ?? null;
      return { outcome: r.outcome, simulationRef: r.refundRef ?? null, reason: null };
    },
    async finalizeFromPersistedEvidence(_entityType, entityId) {
      finalizeCalls += 1;
      const idx = entities.findIndex((e) => e.entityId === entityId);
      if (entityId === "wClaimCrash" || entityId === "wPersistCrash") {
        dbState[entityId].status = "paid";
        dbState[entityId].allocations = "paid";
        entities[idx].status = "paid";
        return "paid";
      }
      if (entityId === "rExecCrash") {
        dbState.rExecCrash.status = "succeeded";
        entities[idx].status = "succeeded";
        return "succeeded";
      }
      if (entityId === "wDefFail") {
        dbState.wDefFail.status = "failed";
        dbState.wDefFail.allocations = "released";
        entities[idx].status = "failed";
        return "failed";
      }
      return "held_uncertain";
    },
  };

  // Sweep 1 (post-crash recovery)
  const res1 = await runDurableRecoverySweep(store, { nowMs });
  assert.equal(res1.find((x) => x.entityId === "wClaimCrash")?.result, "paid");
  assert.equal(res1.find((x) => x.entityId === "rExecCrash")?.result, "succeeded");
  assert.equal(dbState.rExecCrash.ref, preCrashRefundRef, "Crash after provider exec recovers exact deterministic ref");
  assert.equal(res1.find((x) => x.entityId === "wPersistCrash")?.result, "paid");
  assert.equal(res1.find((x) => x.entityId === "wInFlight")?.result, "active_in_flight");
  assert.equal(res1.find((x) => x.entityId === "wDefFail")?.result, "failed");
  assert.equal(res1.find((x) => x.entityId === "wUncertain")?.result, "held_uncertain");
  assert.equal(dbState.wDefFail.allocations, "released");
  assert.equal(dbState.wUncertain.allocations, "reserved", "Uncertain withdrawal MUST retain reservation");
  assert.equal(providerReexecCalls, 2);
  assert.equal(finalizeCalls, 4);

  // Sweep 2 (Scenario 5: duplicate recovery execution -> ZERO duplicate provider calls or finalizations!)
  const res2 = await runDurableRecoverySweep(store, { nowMs });
  assert.equal(providerReexecCalls, 2);
  assert.equal(finalizeCalls, 4);
  assert.equal(res2.find((x) => x.entityId === "wUncertain")?.result, "held_uncertain");
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
// 7b. P0.11, P0.12 & P0.13 — Column Grant, Immutable Provider Evidence & Two-Phase Restock Locks
// -----------------------------------------------------------------------------
test("P0.11, P0.12 & P0.13: protection_expires_at grant, immutable provider evidence, and two-phase restock locks", () => {
  // P0.11: explicit column-level SELECT grant on orders.protection_expires_at (no table-level GRANT SELECT ON public.orders!)
  assert.match(SQL, /GRANT SELECT \(protection_expires_at\) ON public\.orders TO authenticated;/);
  assert.doesNotMatch(SQL, /GRANT SELECT ON public\.orders TO authenticated/i);

  // P0.12: immutable provider evidence & zero fabrication of provider_recorded_at in finalizers
  assert.match(SQL, /CONFLICTING_PROVIDER_OUTCOME/);
  assert.match(SQL, /ATTEMPT_EVIDENCE_MISMATCH/);
  assert.match(SQL, /UNVERIFIED_PROVIDER_FAILURE/);
  assert.match(SQL, /UNVERIFIED_PROVIDER_SUCCESS/);
  assert.match(SQL, /v_refund\.refund_amount_sen <> v_dispute\.refund_amount_sen/);
  const finalizeRefundBlock = SQL.slice(
    SQL.indexOf("FUNCTION public.finalize_order_refund_atomic"),
    SQL.indexOf("SECTION 6: Seller Bank Account Upsert")
  );
  assert.doesNotMatch(
    finalizeRefundBlock,
    /provider_recorded_at\s*=/,
    "finalize_order_refund_atomic must NEVER fabricate provider_recorded_at"
  );
  const finalizeWdrBlock = SQL.slice(
    SQL.indexOf("FUNCTION public.finalize_seller_withdrawal_atomic"),
    SQL.indexOf("DROP FUNCTION IF EXISTS public.admin_release_failed_withdrawal_atomic")
  );
  assert.doesNotMatch(
    finalizeWdrBlock,
    /provider_recorded_at\s*=/,
    "finalize_seller_withdrawal_atomic must NEVER fabricate provider_recorded_at"
  );

  // P0.13: two-phase listing -> variant locking, duplicate item rejection, multi-item explicit qty, food snapshot & has_variants
  assert.match(SQL, /DUPLICATE_RESTOCK_ORDER_ITEM/);
  assert.match(SQL, /EXPLICIT_MULTI_ITEM_RESTOCK_REQUIRED/);
  assert.match(SQL, /COALESCE\(oi\.is_food, false\) AS snapshot_is_food/);
  assert.match(SQL, /COALESCE\(v_listing\.has_variants, false\)/);
  const restockExecBlock = SQL.slice(
    SQL.indexOf("FUNCTION public.execute_approved_refund_restock_internal"),
    SQL.indexOf("FUNCTION public.admin_approve_refund_restock_atomic")
  );
  const lockListingsIdx = restockExecBlock.indexOf("FROM public.listings l");
  const lockVariantsIdx = restockExecBlock.indexOf("FROM public.listing_variants lv");
  const loopIdx = restockExecBlock.indexOf("FOR v_plan_item IN");
  assert.ok(
    lockListingsIdx > 0 && lockVariantsIdx > lockListingsIdx && loopIdx > lockVariantsIdx,
    "Restock executor MUST lock ALL listings first, ALL variants second, then mutate in loop"
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
