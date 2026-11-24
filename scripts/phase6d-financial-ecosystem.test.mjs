import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  BUYER_PROTECTION_HOURS,
  calculateRefundBreakdown,
  getProtectionExpiresAt,
  isEligibleForWithdrawalRelease,
  isWithinBuyerProtectionWindow,
} from "../src/lib/financials/policy.ts";
import {
  encryptBankAccountNumber,
  MALAYSIAN_BANKS,
  validateBankAccountInput,
} from "../src/lib/financials/bank.ts";
import {
  SimulatedBankPayoutProvider,
  SimulatedRefundProvider,
} from "../src/lib/financials/providers.ts";
import {
  buildSanitizedFinancialCsv,
  computePlatformFinancialReconciliation,
} from "../src/lib/financials/reconciliation.ts";
import { computeSellerFinancials } from "../src/lib/seller/financials.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

test("1. Three-day (72-hour) Buyer Protection exact boundary (24h/48h/71h/71:59:59 vs 72:00:00)", () => {
  assert.equal(BUYER_PROTECTION_HOURS, 72);
  const completedAt = "2026-11-20T10:00:00.000Z";
  const baseMs = Date.parse(completedAt);
  assert.equal(getProtectionExpiresAt(completedAt), "2026-11-23T10:00:00.000Z");

  // 24h, 48h, 71h, 71h59m59s -> still protected (dispute eligible, withdrawal blocked)
  for (const offsetMs of [
    24 * 3600_000,
    48 * 3600_000,
    71 * 3600_000,
    72 * 3600_000 - 1000,
  ]) {
    assert.equal(isWithinBuyerProtectionWindow(completedAt, baseMs + offsetMs), true);
    assert.equal(isEligibleForWithdrawalRelease(completedAt, baseMs + offsetMs), false);
  }

  // Exact 72:00:00 and 73h -> protection expired (dispute rejected, withdrawal eligible)
  for (const offsetMs of [72 * 3600_000, 73 * 3600_000]) {
    assert.equal(isWithinBuyerProtectionWindow(completedAt, baseMs + offsetMs), false);
    assert.equal(isEligibleForWithdrawalRelease(completedAt, baseMs + offsetMs), true);
  }
});

test("2. Refund accounting matches preserved QA examples (BU-2611-C3CC55 RM5 partial & BU-2611-3CB12A RM15 full)", () => {
  // Partial RM5 on RM20 order
  const part = calculateRefundBreakdown({
    subtotalSen: 2000,
    originalCommissionSen: 40,
    refundAmountSen: 500,
  });
  assert.equal(part.retainedSubtotalSen, 1500);
  assert.equal(part.adjustedCommissionSen, 30);
  assert.equal(part.adjustedSellerNetSen, 1470);
  assert.equal(part.commissionReversalSen, 10);
  assert.equal(part.sellerDeductionSen, 490);
  assert.equal(part.refundAmountSen, part.commissionReversalSen + part.sellerDeductionSen);

  // Full RM15 on RM15 order
  const full = calculateRefundBreakdown({
    subtotalSen: 1500,
    originalCommissionSen: 30,
    refundAmountSen: 1500,
  });
  assert.equal(full.retainedSubtotalSen, 0);
  assert.equal(full.adjustedCommissionSen, 0);
  assert.equal(full.adjustedSellerNetSen, 0);
  assert.equal(full.commissionReversalSen, 30);
  assert.equal(full.sellerDeductionSen, 1470);
  assert.equal(full.refundAmountSen, full.commissionReversalSen + full.sellerDeductionSen);
});

test("3. Seller bank account validation, masking & AES-256-GCM server encryption", () => {
  assert.ok(MALAYSIAN_BANKS.includes("Maybank"));
  assert.ok(MALAYSIAN_BANKS.includes("CIMB Bank"));

  const ok = validateBankAccountInput({
    bankName: "Maybank",
    accountHolderName: "Ali Bin Ahmad",
    accountNumber: "162012345678",
    confirmAccountNumber: "162012345678",
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.last4, "5678");
    assert.equal(ok.masked, "****5678");
  }

  // Mismatched confirmation & unsupported bank rejected
  assert.equal(
    validateBankAccountInput({
      bankName: "Maybank",
      accountHolderName: "Ali Bin Ahmad",
      accountNumber: "162012345678",
      confirmAccountNumber: "162012345679",
    }).ok,
    false
  );
  assert.equal(
    validateBankAccountInput({
      bankName: "Fake Crypto Bank",
      accountHolderName: "Ali Bin Ahmad",
      accountNumber: "162012345678",
      confirmAccountNumber: "162012345678",
    }).ok,
    false
  );

  // Encryption produces v1 ciphertext without plaintext
  process.env.BUYU_BANK_ENCRYPTION_KEY = "unit-test-ephemeral-key-32-bytes";
  const cipher = encryptBankAccountNumber("162012345678");
  assert.match(cipher, /^v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
  assert.equal(cipher.includes("162012345678"), false);
});

test("4. Simulated refund & bank payout providers handle success/fail/reconciliation and fail closed in production", async () => {
  const refProv = new SimulatedRefundProvider();
  const payProv = new SimulatedBankPayoutProvider();

  const rOk = await refProv.executeRefund({
    refundCode: "RFD-2611-ABC123",
    orderId: "o1",
    amountSen: 500,
    idempotencyKey: "rfd-o1",
  });
  assert.equal(rOk.outcome, "succeeded");
  assert.match(rOk.refundRef || "", /^SIM-RFD-/);

  const rFail = await refProv.executeRefund({
    refundCode: "RFD-2611-ABC123",
    orderId: "o1",
    amountSen: 500,
    idempotencyKey: "rfd-o1",
    qaOutcome: "fail",
  });
  assert.equal(rFail.outcome, "failed");

  const pOk = await payProv.executeDisbursement({
    withdrawalCode: "WDR-2611-XYZ789",
    sellerId: "s1",
    amountSen: 1470,
    idempotencyKey: "wdr-s1",
    bankName: "Maybank",
    accountLast4: "5678",
  });
  assert.equal(pOk.outcome, "paid");
  assert.match(pOk.transferRef || "", /^SIM-TRF-/);

  const pRecon = await payProv.executeDisbursement({
    withdrawalCode: "WDR-2611-XYZ789",
    sellerId: "s1",
    amountSen: 1470,
    idempotencyKey: "wdr-s1",
    bankName: "Maybank",
    accountLast4: "5678",
    qaOutcome: "reconciliation_required",
  });
  assert.equal(pRecon.outcome, "reconciliation_required");

  // Production fail-closed guard
  const prevEnv = process.env.BUYU_PAYMENT_ENV;
  process.env.BUYU_PAYMENT_ENV = "production";
  try {
    await assert.rejects(() =>
      payProv.executeDisbursement({
        withdrawalCode: "WDR-1",
        sellerId: "s1",
        amountSen: 500,
        idempotencyKey: "k1",
        bankName: "Maybank",
        accountLast4: "5678",
      })
    );
  } finally {
    if (prevEnv === undefined) delete process.env.BUYU_PAYMENT_ENV;
    else process.env.BUYU_PAYMENT_ENV = prevEnv;
  }
});

test("5. Seller 6-bucket ledger & Platform reconciliation equations + mismatch detection + sanitized CSV", () => {
  const now = new Date("2026-11-24T12:00:00Z");
  const fin = computeSellerFinancials({
    orders: [
      // Completed 80h ago -> matured Available
      {
        id: "o-matured",
        order_code: "BU-1",
        subtotal_sen: 2000,
        commission_sen: 40,
        seller_net_sen: 1960,
        total_paid_sen: 2000,
        status: "completed",
        paid_at: "2026-11-20T00:00:00Z",
        completed_at: "2026-11-21T00:00:00Z",
        created_at: "2026-11-20T00:00:00Z",
      },
      // Completed 10h ago -> 72h Buyer Protection Reserve!
      {
        id: "o-reserve",
        order_code: "BU-2",
        subtotal_sen: 1500,
        commission_sen: 30,
        seller_net_sen: 1470,
        total_paid_sen: 1500,
        status: "completed",
        paid_at: "2026-11-24T01:00:00Z",
        completed_at: "2026-11-24T02:00:00Z",
        created_at: "2026-11-24T01:00:00Z",
      },
    ],
    orderItems: [],
    payments: [],
    payoutRequests: [
      // Failed withdrawal must NOT reduce available balance or count as paid out!
      { id: "p-fail", amount_sen: 500, status: "failed", processed_at: null, created_at: "2026-11-23T00:00:00Z" },
      // Paid withdrawal deducts once
      { id: "p-paid", amount_sen: 1000, status: "paid", processed_at: "2026-11-24T05:00:00Z", created_at: "2026-11-24T05:00:00Z" },
    ],
    disputes: [],
    range: "all",
    now,
  });

  assert.equal(fin.protectionReserveSen, 1470);
  assert.equal(fin.availableForPayoutSen, 960); // 1960 - 1000 paid
  assert.equal(fin.totalPaidOutSen, 1000);
  assert.equal(fin.failedWithdrawalCount, 1);

  // Platform reconciliation PASS when balanced
  const reconOk = computePlatformFinancialReconciliation({
    checkoutSessions: [
      {
        id: "cs1",
        checkout_code: "CHK-1",
        combined_subtotal_sen: 3500,
        fpx_fee_sen: 100,
        total_paid_sen: 3600,
        status: "paid",
        payment_status: "paid",
        transaction_ref: "TP-1",
        paid_at: "2026-11-20T00:00:00Z",
      },
    ],
    legacyPayments: [],
    orders: [
      {
        id: "o1",
        order_code: "BU-1",
        checkout_session_id: "cs1",
        seller_id: "s1",
        subtotal_sen: 2000,
        fpx_fee_sen: 0,
        commission_sen: 40,
        seller_net_sen: 1960,
        status: "completed",
        paid_at: "2026-11-20T00:00:00Z",
        completed_at: "2026-11-21T00:00:00Z",
      },
      {
        id: "o2",
        order_code: "BU-2",
        checkout_session_id: "cs1",
        seller_id: "s2",
        subtotal_sen: 1500,
        fpx_fee_sen: 0,
        commission_sen: 30,
        seller_net_sen: 1470,
        status: "paid",
        paid_at: "2026-11-20T00:00:00Z",
        completed_at: null,
      },
    ],
    disputes: [],
    refunds: [],
    payouts: [],
    nowMs: now.getTime(),
  });
  assert.equal(reconOk.checks.every((c) => c.status === "PASS"), true);
  assert.equal(reconOk.fpxFeesCollectedSen, 100);
  assert.equal(reconOk.netPlatformCommissionSen, 70);

  // Deliberate over-payout mismatch is FLAGGED
  const reconFlag = computePlatformFinancialReconciliation({
    checkoutSessions: [],
    legacyPayments: [],
    orders: [],
    disputes: [],
    refunds: [],
    payouts: [
      {
        id: "w-bad",
        withdrawal_code: "WDR-BAD",
        seller_id: "s1",
        amount_sen: 500,
        status: "paid",
        transfer_ref: "SIM-TRF-1",
        processing_started_at: null,
        created_at: "2026-11-24T00:00:00Z",
      },
    ],
    nowMs: now.getTime(),
  });
  assert.equal(
    reconFlag.checks.find((c) => c.id === "seller_earnings_equation")?.status,
    "FLAG"
  );

  // CSV export sanitization
  const csv = buildSanitizedFinancialCsv([
    {
      type: "withdrawal",
      reference: "SIM-TRF-1",
      orderOrCheckoutCode: "WDR-1",
      status: "paid",
      amountRm: "14.70",
      maskedDestination: "Maybank · ****5678 (Ali)",
      simulationMode: "simulated",
      timestamp: "2026-11-24T10:00:00Z",
    },
  ]);
  assert.match(csv, /\*{4}5678/);
  assert.match(csv, /SIM-TRF-1/);
  assert.doesNotMatch(csv, /pickup_pin|raw_callback|account_number_encrypted/i);
});

test("6. Consolidated SQL migration enforces 72h protection, shared seller lock, privacy & zero 7-day remnants", () => {
  const sql = fs.readFileSync(
    path.join(REPO_ROOT, "docs/sql/phase-6d-financial-ecosystem.sql"),
    "utf8"
  );
  assert.match(sql, /STATUS:\s*PROPOSAL ONLY/i);
  assert.match(sql, /interval '72 hours'/);
  assert.doesNotMatch(sql, /interval '7 days'/i);
  assert.match(sql, /FROM public\.profiles p WHERE p\.id = v_seller_id FOR UPDATE/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.order_refunds/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.order_restock_logs/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.financial_adjustments/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.payout_allocations/);
  assert.match(sql, /REVOKE ALL ON public\.seller_payout_accounts FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.create_seller_withdrawal_atomic/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.finalize_seller_withdrawal_atomic/);
});
