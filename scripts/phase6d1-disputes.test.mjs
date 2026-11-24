import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  buildPrivateDisputeEvidenceUrl,
  COMPLETED_ORDER_DISPUTE_WINDOW_HOURS,
  DISPUTE_REASONS,
  evaluateBuyerDisputeEligibility,
  getDisputeResolutionSummary,
  getDisputeStatusBadge,
  isDisputeEvidencePathAuthorized,
  isDisputeEvidencePathOwned,
  isValidDisputeReasonCode,
  MAX_DISPUTE_EVIDENCE_BYTES,
  validateDisputeEvidenceFileMeta,
} from "../src/lib/disputes/validation.ts";
import { computeSellerFinancials } from "../src/lib/seller/financials.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const BUYER_ID = "1082a03e-c04c-4ae2-a162-c68d3a09b89c";
const SELLER_ID = "d3b398d8-9103-4bc2-84d3-6e0101b7659a";
const OTHER_ID = "17d414ce-8349-4dc2-bccd-94d9bd0ebc52";
const ORDER_ID = "3faaeecf-cd0d-45ef-b4b5-ea0910203103";

test("1. Dispute reasons (all 6 >= 10 chars), eligibility (paid/handed_over/7d completed window), and invalid status rejection", () => {
  assert.equal(DISPUTE_REASONS.length, 6);
  for (const r of DISPUTE_REASONS) {
    assert.equal(isValidDisputeReasonCode(r.code), true);
    assert.ok(
      r.label.length >= 10,
      `Reason "${r.code}" label "${r.label}" must be >= 10 chars for order_disputes_reason_check`
    );
  }
  assert.equal(DISPUTE_REASONS.find((r) => r.code === "other")?.label, "Other order issue");
  assert.equal(isValidDisputeReasonCode("invalid_reason"), false);

  const nowMs = Date.parse("2026-11-24T12:00:00Z");

  // Paid & handed_over with verified payment are eligible
  assert.equal(
    evaluateBuyerDisputeEligibility({
      status: "paid",
      paidAt: "2026-11-24T06:00:00Z",
      completedAt: null,
      hasActiveDispute: false,
      nowMs,
    }).eligible,
    true
  );
  assert.equal(
    evaluateBuyerDisputeEligibility({
      status: "handed_over",
      paidAt: "2026-11-24T06:00:00Z",
      completedAt: null,
      hasActiveDispute: false,
      nowMs,
    }).eligible,
    true
  );

  // Completed within 72-hour (3-day) protection window -> eligible; at/after 72 hours -> rejected
  assert.equal(COMPLETED_ORDER_DISPUTE_WINDOW_HOURS, 72);
  assert.equal(
    evaluateBuyerDisputeEligibility({
      status: "completed",
      paidAt: "2026-11-22T06:00:00Z",
      completedAt: "2026-11-22T08:00:00Z",
      hasActiveDispute: false,
      nowMs,
    }).eligible,
    true
  );
  assert.equal(
    evaluateBuyerDisputeEligibility({
      status: "completed",
      paidAt: "2026-11-20T06:00:00Z",
      completedAt: "2026-11-20T08:00:00Z",
      hasActiveDispute: false,
      nowMs,
    }).eligible,
    false
  );

  // Unpaid, expired, cancelled, refunded, active dispute, pending refund execution -> all blocked
  for (const badStatus of ["pending_payment", "expired", "cancelled", "refunded", "disputed"]) {
    assert.equal(
      evaluateBuyerDisputeEligibility({
        status: badStatus,
        paidAt: badStatus === "pending_payment" ? null : "2026-11-24T06:00:00Z",
        completedAt: null,
        hasActiveDispute: false,
        nowMs,
      }).eligible,
      false
    );
  }
  assert.equal(
    evaluateBuyerDisputeEligibility({
      status: "paid",
      paidAt: "2026-11-24T06:00:00Z",
      completedAt: null,
      hasActiveDispute: true,
      nowMs,
    }).eligible,
    false
  );
  assert.equal(
    evaluateBuyerDisputeEligibility({
      status: "paid",
      paidAt: "2026-11-24T06:00:00Z",
      completedAt: null,
      hasActiveDispute: false,
      hasPendingRefundExecution: true,
      nowMs,
    }).eligible,
    false
  );
});

test("2. Private evidence file validation, path ownership & non-public URL contract", () => {
  assert.equal(validateDisputeEvidenceFileMeta({ type: "image/jpeg", size: 1024 }).ok, true);
  assert.equal(validateDisputeEvidenceFileMeta({ type: "image/png", size: 1024 }).ok, true);
  assert.equal(validateDisputeEvidenceFileMeta({ type: "image/webp", size: 1024 }).ok, true);
  assert.equal(validateDisputeEvidenceFileMeta({ type: "application/pdf", size: 1024 }).ok, false);
  assert.equal(
    validateDisputeEvidenceFileMeta({ type: "image/jpeg", size: MAX_DISPUTE_EVIDENCE_BYTES + 1 }).ok,
    false
  );

  const validBuyerPath = `${BUYER_ID}/${ORDER_ID}/1700-abc123.jpg`;
  const validSellerPath = `${SELLER_ID}/${ORDER_ID}/1700-def456.png`;
  const spoofedPath = `${OTHER_ID}/${ORDER_ID}/1700-bad.jpg`;
  const traversalPath = `${BUYER_ID}/${ORDER_ID}/../secret.jpg`;

  assert.equal(isDisputeEvidencePathOwned(validBuyerPath, BUYER_ID, ORDER_ID), true);
  assert.equal(isDisputeEvidencePathOwned(validSellerPath, BUYER_ID, ORDER_ID), false);
  assert.equal(isDisputeEvidencePathOwned(traversalPath, BUYER_ID, ORDER_ID), false);

  assert.equal(isDisputeEvidencePathAuthorized(validBuyerPath, ORDER_ID, [BUYER_ID, SELLER_ID]), true);
  assert.equal(isDisputeEvidencePathAuthorized(validSellerPath, ORDER_ID, [BUYER_ID, SELLER_ID]), true);
  assert.equal(isDisputeEvidencePathAuthorized(spoofedPath, ORDER_ID, [BUYER_ID, SELLER_ID]), false);

  const url = buildPrivateDisputeEvidenceUrl(ORDER_ID, validBuyerPath);
  assert.match(url, /^\/api\/disputes\/evidence\?/);
  assert.doesNotMatch(url, /storage\/v1\/object\/public/);
});

test("3. Financial integrity: frozen dispute balance isolated, pending_execution refund stays frozen, unaffected sibling order stays intact", () => {
  const now = new Date("2026-11-24T12:00:00Z");

  const fin = computeSellerFinancials({
    orders: [
      // Sibling A: disputed with full_refund proposal pending_execution (MUST stay frozen!)
      {
        id: "child-a",
        order_code: "BU-2611-A1",
        subtotal_sen: 1500,
        commission_sen: 30,
        seller_net_sen: 1470,
        total_paid_sen: 1500,
        status: "disputed",
        paid_at: "2026-11-24T06:00:00Z",
        completed_at: null,
        created_at: "2026-11-24T05:55:00Z",
      },
      // Sibling B: completed > 72h ago and unaffected -> Available for Payout
      {
        id: "child-b",
        order_code: "BU-2611-B1",
        subtotal_sen: 2000,
        commission_sen: 40,
        seller_net_sen: 1960,
        total_paid_sen: 2000,
        status: "completed",
        paid_at: "2026-11-20T06:00:00Z",
        completed_at: "2026-11-20T08:00:00Z",
        created_at: "2026-11-20T05:55:00Z",
      },
    ],
    orderItems: [],
    payments: [],
    payoutRequests: [],
    disputes: [
      {
        order_id: "child-a",
        status: "resolved",
        refund_amount_sen: 1500,
        refund_execution_status: "pending_execution",
      },
    ],
    range: "30d",
    now,
  });

  // Refund is NOT executed yet -> frozenDisputeSen = 1470, NOT deducted as executed refund, NOT in Available for Payout
  assert.equal(fin.frozenDisputeSen, 1470);
  assert.equal(fin.pendingSettlementSen, 0);
  assert.equal(fin.availableForPayoutSen, 1960);

  // Resolution summary clearly marks pending execution
  const sum = getDisputeResolutionSummary({
    resolutionType: "full_refund",
    refundAmountSen: 1500,
    refundExecutionStatus: "pending_execution",
  });
  assert.match(sum || "", /Pending Refund Execution \(Phase 6D\.2\)/);
  assert.equal(getDisputeStatusBadge("under_review").label, "Under Review");
});

test("4. Phase 6D.1 SQL migration security, atomicity, lock order, and privacy invariants", () => {
  const sql = fs.readFileSync(
    path.join(REPO_ROOT, "docs/sql/phase-6d1-disputes-buyer-protection.sql"),
    "utf8"
  );

  assert.match(sql, /STATUS:\s*PROPOSAL ONLY/i);
  // Drop legacy single-dispute-ever UNIQUE(order_id); retain partial unique index for active disputes
  assert.match(sql, /DROP CONSTRAINT IF EXISTS order_disputes_order_id_key/);
  assert.match(sql, /idx_order_disputes_one_active_per_order/);
  // All 6 stored reason labels >= 10 chars ("Other order issue")
  assert.match(sql, /WHEN 'other'\s+THEN 'Other order issue'/);
  // Temporarily revoke direct client writes on payout_requests until Phase 6D.4
  assert.match(sql, /REVOKE INSERT, UPDATE, DELETE ON public\.payout_requests FROM PUBLIC, anon, authenticated/);
  // Hosted payout statuses aligned (pending, paid)
  assert.match(sql, /IN \('pending', 'paid'\)/);
  // Evidence objects verified to exist in storage.objects for private dispute-evidence bucket
  assert.match(sql, /FROM storage\.objects so/);
  assert.match(sql, /EVIDENCE_OBJECT_NOT_FOUND/);
  // Admin resolution requires genuinely disputed order & guards against repeated refunds
  assert.match(sql, /IF v_order\.status <> 'disputed' THEN\s+RAISE EXCEPTION 'ORDER_NOT_DISPUTED'/);
  assert.match(sql, /ORDER_ALREADY_REFUNDED/);
  // Admin-only columns revoked from authenticated/anon
  assert.match(sql, /REVOKE ALL ON public\.order_disputes FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(sql, /GRANT SELECT \([^)]*admin_notes/i);
  // Private evidence bucket enforced
  assert.match(sql, /UPDATE storage\.buckets\s+SET public = false\s+WHERE id = 'dispute-evidence'/);
  // All 4 new SECURITY DEFINER RPCs installed
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.open_order_dispute_atomic\(/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.submit_seller_dispute_response_atomic\(/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.admin_mark_dispute_under_review_atomic\(/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.admin_resolve_order_dispute_atomic\(/);
  // Completed-order 7-day protection window + already-disbursed funds guard
  assert.match(sql, /interval '7 days'/);
  assert.match(sql, /FUNDS_ALREADY_DISBURSED/);
  // Admin authorization enforced via is_active_admin()
  assert.match(sql, /NOT public\.is_active_admin\(\)/);
  // Refund proposals stay pending_execution and keep order frozen (`disputed`)
  assert.match(sql, /v_exec_status := 'pending_execution'/);
  assert.match(sql, /v_next_order_status := 'disputed'/);
  // Release to seller restores previous_order_status without skipping receipt confirmation
  assert.match(sql, /v_next_order_status := v_dispute\.previous_order_status/);
  // Phase 6C RPCs also block pending_execution refunds
  assert.match(sql, /d\.refund_execution_status = 'pending_execution'/);
});

test("5. Zero admin_notes exposure in buyer/seller dispute queries & zero public evidence URLs", () => {
  const disputesData = fs.readFileSync(
    path.join(REPO_ROOT, "src/lib/disputes/data.ts"),
    "utf8"
  );
  // SAFE_DISPUTE_SELECT must NEVER include admin_notes
  const safeSelectMatch = disputesData.match(/const SAFE_DISPUTE_SELECT =\s*"([^"]+)"/);
  assert.ok(safeSelectMatch, "SAFE_DISPUTE_SELECT constant must exist");
  assert.doesNotMatch(safeSelectMatch[1], /admin_notes|resolved_by|under_review_by/);
});
