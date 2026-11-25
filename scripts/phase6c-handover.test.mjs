import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import {
  getOrderStatusBadge,
  getOrderTimelineSteps,
  getOrderPresentation,
  isValidPickupPinFormat,
  normalizePickupPinInput,
  ORDER_STATUS_TABS,
} from "../src/lib/orders/lifecycle.ts";
import { computeSellerFinancials } from "../src/lib/seller/financials.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

test("1. PIN input normalization & 6-digit validation", () => {
  assert.equal(normalizePickupPinInput("12-ab 3456789"), "123456");
  assert.equal(isValidPickupPinFormat("048291"), true);
  assert.equal(isValidPickupPinFormat("12345"), false);
  assert.equal(isValidPickupPinFormat("1234567"), false);
  assert.equal(isValidPickupPinFormat("12345a"), false);
});

test("2. Fixed seller transaction labels & earnings ledger transitions (paid -> handed_over -> completed, disputed frozen, no duplicates)", () => {
  const now = new Date("2026-11-24T12:00:00Z");
  const baseOrders = [
    // Unified Seller A child order (paid, awaiting handover -> Pending Settlement)
    {
      id: "ord-paid",
      order_code: "BU-2611-B1C075",
      subtotal_sen: 1500,
      commission_sen: 30,
      seller_net_sen: 1470,
      total_paid_sen: 1500,
      status: "paid",
      paid_at: "2026-11-24T06:50:00Z",
      completed_at: null,
      created_at: "2026-11-24T06:48:00Z",
    },
    // Duplicate entry of ord-paid must NEVER double-count earnings
    {
      id: "ord-paid",
      order_code: "BU-2611-B1C075",
      subtotal_sen: 1500,
      commission_sen: 30,
      seller_net_sen: 1470,
      total_paid_sen: 1500,
      status: "paid",
      paid_at: "2026-11-24T06:50:00Z",
      completed_at: null,
      created_at: "2026-11-24T06:48:00Z",
    },
    // Handed over -> STILL Pending Settlement until buyer confirms receipt
    {
      id: "ord-ho",
      order_code: "BU-2611-HO0001",
      subtotal_sen: 2000,
      commission_sen: 40,
      seller_net_sen: 1960,
      total_paid_sen: 2000,
      status: "handed_over",
      paid_at: "2026-11-24T07:00:00Z",
      completed_at: null,
      created_at: "2026-11-24T06:55:00Z",
    },
    // Completed (> 72h ago, past buyer protection reserve) -> Available for Payout
    {
      id: "ord-comp",
      order_code: "BU-2611-CP0001",
      subtotal_sen: 1000,
      commission_sen: 20,
      seller_net_sen: 980,
      total_paid_sen: 1000,
      status: "completed",
      paid_at: "2026-11-20T05:00:00Z",
      completed_at: "2026-11-20T06:00:00Z",
      created_at: "2026-11-20T04:55:00Z",
    },
    // Disputed -> Frozen (must NOT enter Available for Payout)
    {
      id: "ord-disp",
      order_code: "BU-2611-DP0001",
      subtotal_sen: 3000,
      commission_sen: 60,
      seller_net_sen: 2940,
      total_paid_sen: 3000,
      status: "disputed",
      paid_at: "2026-11-24T04:00:00Z",
      completed_at: null,
      created_at: "2026-11-24T03:55:00Z",
    },
    // Expired -> excluded from sales/settlement, labeled "Payment Expired"
    {
      id: "ord-exp",
      order_code: "BU-2611-EX0001",
      subtotal_sen: 1500,
      commission_sen: 30,
      seller_net_sen: 1470,
      total_paid_sen: 1500,
      status: "expired",
      paid_at: null,
      completed_at: null,
      created_at: "2026-11-24T03:00:00Z",
    },
    // Pending payment -> excluded from sales/settlement, labeled "Awaiting Payment"
    {
      id: "ord-pend",
      order_code: "BU-2611-PN0001",
      subtotal_sen: 1500,
      commission_sen: 30,
      seller_net_sen: 1470,
      total_paid_sen: 1500,
      status: "pending_payment",
      paid_at: null,
      completed_at: null,
      created_at: "2026-11-24T02:00:00Z",
    },
  ];

  const fin = computeSellerFinancials({
    orders: baseOrders,
    orderItems: [],
    payments: [],
    payoutRequests: [],
    disputes: [],
    range: "30d",
    now,
  });

  // Deduplicated sales: 1500 + 2000 + 1000 + 3000 = 7500
  assert.equal(fin.totalSalesSen, 7500);
  // Pending settlement (non-disputed): paid (1470) + handed_over (1960) = 3430
  assert.equal(fin.pendingSettlementSen, 3430);
  // Frozen dispute balance tracked separately: disputed (2940)
  assert.equal(fin.frozenDisputeSen, 2940);
  // Available for payout: ONLY completed (980)
  assert.equal(fin.availableForPayoutSen, 980);

  const labelByCode = new Map(fin.transactions.map((t) => [t.orderCode, t.statusLabel]));
  assert.equal(labelByCode.get("BU-2611-B1C075"), "Paid — In Progress");
  assert.equal(labelByCode.get("BU-2611-HO0001"), "Awaiting Receipt Confirmation");
  assert.equal(labelByCode.get("BU-2611-CP0001"), "Completed");
  assert.equal(labelByCode.get("BU-2611-DP0001"), "Disputed");
  assert.equal(labelByCode.get("BU-2611-EX0001"), "Payment Expired");
});

test("3. Pending payment transaction label is Awaiting Payment", () => {
  const fin = computeSellerFinancials({
    orders: [
      {
        id: "p1",
        order_code: "BU-WAIT-1",
        subtotal_sen: 1500,
        commission_sen: 30,
        seller_net_sen: 1470,
        total_paid_sen: 1600,
        status: "pending_payment",
        paid_at: null,
        completed_at: null,
        created_at: "2026-11-24T02:00:00Z",
      },
    ],
    orderItems: [],
    payments: [],
    payoutRequests: [],
    disputes: [],
    range: "all",
  });
  assert.equal(fin.transactions[0]?.statusLabel, "Awaiting Payment");
});

test("4. Order status tabs, deadlines and timeline reflect the unified lifecycle", () => {
  const paidAt = "2026-11-24T06:50:00Z";
  const deadline = "2026-11-24T07:00:00Z";
  const now = Date.parse(deadline);
  assert.equal(ORDER_STATUS_TABS.length, 6);
  assert.equal(getOrderPresentation({ status: "pending_payment", paymentDeadline: deadline }, now - 1).tab, "to-pay");
  assert.equal(getOrderPresentation({ status: "pending_payment", paymentDeadline: deadline }, now).tab, "cancelled");
  const late = getOrderPresentation({ status: "expired", paymentStatus: "late_payment_review" }, now);
  assert.equal(late.tab, "refund-dispute");
  assert.equal(late.badge.label, "Payment under review");
  assert.equal(getOrderPresentation({ status: "paid" }, now).tab, "in-progress");
  assert.equal(getOrderPresentation({ status: "handed_over" }, now).tab, "in-progress");
  assert.equal(getOrderPresentation({ status: "completed" }, now).tab, "completed");
  assert.equal(getOrderPresentation({ status: "completed", hasFinancialIssue: true }, now).tab, "refund-dispute");
  assert.equal(getOrderPresentation({ status: "paid", refundStatus: "succeeded" }, now).tab, "in-progress");
  assert.equal(getOrderPresentation({ status: "completed", refundStatus: "succeeded" }, now).tab, "completed");
  assert.equal(getOrderPresentation({ status: "disputed", refundStatus: "awaiting_return" }, now).badge.label, "Refund awaiting return");
  assert.equal(getOrderStatusBadge("paid").label, "Awaiting Collection");
  assert.equal(getOrderStatusBadge("paid", null, true).label, "Awaiting Service");
  assert.equal(getOrderStatusBadge("handed_over").label, "Awaiting Receipt Confirmation");
  assert.equal(getOrderStatusBadge("expired").label, "Payment Expired");

  const input = {
    createdAt: "2026-11-24T06:48:00Z",
    paidAt,
    completedAt: null,
    paymentDeadline: deadline,
  };
  const steps = getOrderTimelineSteps({ ...input, status: "paid" }, now);
  assert.deepEqual(steps.map(({ key, done }) => [key, done]), [
    ["placed", true], ["paid", true], ["in_progress", true], ["completed", false],
  ]);
  assert.equal(steps[1].timestamp, paidAt);
  assert.equal(steps[2].timestamp, paidAt);
  assert.equal(steps[3].timestamp, null);
  assert.equal(getOrderTimelineSteps({ ...input, status: "refunded", completedAt: deadline }, now)[3].timestamp, deadline);

  const pending = { ...input, status: "pending_payment", paidAt: null };
  assert.equal(getOrderTimelineSteps(pending, now - 1)[0].active, true);
  assert.equal(getOrderTimelineSteps(pending, now).some((step) => step.active), false);
  assert.equal(getOrderTimelineSteps(pending, now - 1, "late_payment_review").some((step) => step.active), false);
});

test("Order timeline server markup marks exactly one current step from the order snapshot", () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, "src/components/orders/OrderTimeline.tsx"), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  });
  const require = createRequire(import.meta.url);
  const compiled = {};
  new Function("require", "exports", outputText)(
    (id) => id === "@/lib/orders/lifecycle" ? { getOrderTimelineSteps } : require(id),
    compiled,
  );
  const order = {
    status: "paid",
    createdAt: "2026-11-24T16:40:00Z",
    paidAt: "2026-11-24T16:50:00Z",
    completedAt: null,
    paymentDeadline: "2026-11-24T17:00:00Z",
  };
  const render = (snapshot, snapshotAt) =>
    renderToStaticMarkup(createElement(compiled.OrderTimeline, { order: snapshot, snapshotAt }));
  const current = (markup) => [...markup.matchAll(/<li([^>]*)>/g)]
    .map(([, attributes]) => attributes.includes('aria-current="step"'));
  const beforeDeadline = render(order, Date.parse(order.paymentDeadline) - 1);
  assert.deepEqual(current(beforeDeadline), [false, false, true, false]);
  assert.equal(render({ ...order }, Date.parse(order.paymentDeadline)), beforeDeadline);
  assert.match(beforeDeadline, /25 Nov[^<]*12:50/i);

  const completed = render({ ...order, status: "completed", completedAt: "2026-11-24T17:01:00Z" }, Date.parse(order.paymentDeadline));
  assert.deepEqual(current(completed), [false, false, false, true]);
  assert.match(completed, /25 Nov[^<]*1:01/i);
  assert.equal((completed.match(/<svg\b/g) ?? []).length, 4);
});

test("5. Phase 6C SQL migration safety & security invariants", () => {
  const sql = fs.readFileSync(
    path.join(REPO_ROOT, "docs/sql/phase-6c-handover-completion.sql"),
    "utf8"
  );

  // Proposal header
  assert.match(sql, /STATUS:\s*PROPOSAL ONLY/i);
  // CSPRNG PIN generator (no random())
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.generate_secure_pickup_pin\(\)/);
  assert.match(sql, /gen_random_uuid\(\)/);
  assert.doesNotMatch(sql, /floor\(random\(\)/i);
  // Both new atomic RPCs present with FOR UPDATE locking & strict auth/role checks
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.verify_order_pickup_pin_atomic\(/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.confirm_buyer_order_receipt_atomic\(/);
  assert.match(sql, /v_max_attempts CONSTANT integer := 5/);
  assert.match(sql, /interval '15 minutes'/);
  // PIN consumed on handover
  assert.match(sql, /SET status = 'handed_over',\s*handed_over_at = v_now,\s*pickup_pin = NULL/);
  // Payment proof checked for BOTH unified checkout_sessions AND legacy payments
  assert.match(sql, /FROM public\.checkout_sessions cs/);
  assert.match(sql, /FROM public\.payments p/);
  // No auto-complete cron job added
  assert.doesNotMatch(sql, /cron\.schedule/i);
  // Column-level pickup_pin privacy preserved & direct client order_disputes writes closed
  assert.match(sql, /REVOKE SELECT \(pickup_pin\) ON public\.orders FROM authenticated, anon/);
  assert.match(sql, /REVOKE INSERT, UPDATE, DELETE ON public\.order_disputes FROM authenticated, anon/);
  // Exact hosted order_disputes active statuses (open, under_review ONLY)
  assert.match(sql, /IN \('open', 'under_review'\)/);
  assert.doesNotMatch(sql, /closed_rejected/);
  // No unsupported ready_for_pickup or settled status references
  assert.doesNotMatch(sql, /ready_for_pickup/);
  assert.doesNotMatch(sql, /'settled'/);
});

test("6. Zero Pickup PIN leakage in seller queries, components, or actions", () => {
  const sellerData = fs.readFileSync(
    path.join(REPO_ROOT, "src/lib/orders/seller-data.ts"),
    "utf8"
  );
  const sellerClient = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/seller/SellerOrdersClient.tsx"),
    "utf8"
  );
  const actions = fs.readFileSync(
    path.join(REPO_ROOT, "src/app/orders/actions.ts"),
    "utf8"
  );

  // Seller data query must never select pickup_pin or call get_buyer_order_pickup_pins
  assert.doesNotMatch(sellerData, /get_buyer_order_pickup_pins/);
  assert.doesNotMatch(sellerData, /select\([^)]*pickup_pin/i);
  // Seller UI must never display order.pickupPin
  assert.doesNotMatch(sellerClient, /pickupPin/);
  // Server actions must never console.log the PIN
  assert.doesNotMatch(actions, /console\.(log|info|warn|error)/);
});
