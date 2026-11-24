import assert from "node:assert/strict";
import test from "node:test";
import { buildCartSummary } from "../src/lib/buyer/cart.ts";
import { buildCheckoutPreparation } from "../src/lib/buyer/checkout.ts";
import { evaluateBuyerEligibility } from "../src/lib/buyer/validation.ts";
import {
  computeOfferExpiresAt,
  OFFER_RESERVATION_TTL_MS,
} from "../src/lib/messages/offers.ts";
import {
  calculateOrderFinancials,
  prepareCartOrderPlans,
  prepareOfferOrderPlan,
  TOYYIBPAY_FPX_FEE_SEN,
} from "../src/lib/orders/pricing.ts";
import {
  buildToyyibPayCreateBillPayload,
  evaluateToyyibPayVerification,
  formatToyyibPayExpiryMyt,
  parseToyyibPayAmountToSen,
  parseToyyibPayWebhookEnvelope,
} from "../src/lib/payments/toyyibpay.ts";

const BUYER_ID = "17d414ce-8349-4dc2-bccd-94d9bd0ebc52";
const SELLER_A = "d3b398d8-9103-4bc2-84d3-6e0101b7659a";
const SELLER_B = "e4c498d8-9103-4bc2-84d3-6e0101b7659b";

function makeEligibility(role = "student", id = BUYER_ID) {
  return evaluateBuyerEligibility({
    isAuthenticated: true,
    isEmailVerified: true,
    isActiveMember: true,
    profile: {
      id,
      email: "buyer@iluv.ums.edu.my",
      university_role: role,
      status: "active",
      restriction_reason: null,
      full_name: "Buyer",
      display_name: "Buyer",
      faculty: "FKI",
      bio: null,
      avatar_url: null,
      created_at: "2026-01-01T00:00:00Z",
    },
  });
}

test("calculateOrderFinancials matches hosted 2% commission and RM 1.00 FPX fee exactly", () => {
  // Matches live hosted order BU-2611-0DB3 (subtotal 1500 -> commission 30, seller_net 1470, fpx 100, total 1600)
  const fin = calculateOrderFinancials(1500);
  assert.equal(fin.subtotalSen, 1500);
  assert.equal(fin.fpxFeeSen, TOYYIBPAY_FPX_FEE_SEN);
  assert.equal(fin.commissionSen, 30);
  assert.equal(fin.sellerNetSen, 1470);
  assert.equal(fin.totalPaidSen, 1600);

  // Zero subtotal produces zero fees safely
  const zero = calculateOrderFinancials(0);
  assert.equal(zero.totalPaidSen, 0);
  assert.equal(zero.commissionSen, 0);
});

test("prepareCartOrderPlans splits multi-seller cart into separate seller orders with per-order FPX fees", () => {
  const cart = buildCartSummary([
    {
      id: "r1",
      listingId: "2990db4c-11d6-4ec9-b4dd-5209a80ed74f",
      variantId: null,
      variantLabel: null,
      title: "Hirono",
      imageUrl: null,
      campusArea: "Cafe UMSKAL",
      condition: "New",
      sellerId: SELLER_A,
      sellerDisplayName: "HazIq Hazim",
      storefrontName: "HazIq Hazim",
      sellerLogoUrl: null,
      sellerBadge: "Verified UMS Student",
      unitPriceSen: 2000,
      quantity: 2,
      availableStock: 5,
      reservedQuantity: 0,
      lineSubtotalSen: 4000,
      isValid: true,
      issueCode: null,
      issueMessage: null,
      canAdjustToMax: false,
    },
    {
      id: "r2",
      listingId: "3990db4c-11d6-4ec9-b4dd-5209a80ed74f",
      variantId: null,
      variantLabel: null,
      title: "Calculator",
      imageUrl: null,
      campusArea: "Library",
      condition: "Good",
      sellerId: SELLER_B,
      sellerDisplayName: "Aina",
      storefrontName: null,
      sellerLogoUrl: null,
      sellerBadge: "Verified UMS Student",
      unitPriceSen: 5000,
      quantity: 1,
      availableStock: 2,
      reservedQuantity: 0,
      lineSubtotalSen: 5000,
      isValid: true,
      issueCode: null,
      issueMessage: null,
      canAdjustToMax: false,
    },
  ]);

  const prep = buildCheckoutPreparation(cart);
  const result = prepareCartOrderPlans(makeEligibility("student"), prep);
  assert.equal(result.ok, true);
  assert.equal(result.orders.length, 2);
  assert.equal(result.combinedSubtotalSen, 9000);
  assert.equal(result.combinedFpxFeeSen, 200); // 2 separate seller orders * RM 1.00
  assert.equal(result.combinedTotalPayableSen, 9200);
  assert.equal(result.orders[0]?.financials.commissionSen, 80); // 2% of 4000
  assert.equal(result.orders[1]?.financials.commissionSen, 100); // 2% of 5000
});

test("prepareOfferOrderPlan enforces locked negotiated price, buyer ownership, and strict 30m hold deadline", () => {
  const tAccept = new Date("2026-11-24T01:00:00.000Z").getTime();
  const offer = {
    id: "offer-1",
    conversationId: "53c1fcba-804e-4743-a429-7c4c57ca8d29",
    listingId: "2990db4c-11d6-4ec9-b4dd-5209a80ed74f",
    buyerId: BUYER_ID,
    sellerId: SELLER_A,
    offerPriceSen: 1200,
    status: "accepted",
    orderId: null,
    createdAt: "2026-11-24T00:00:00.000Z",
    respondedAt: new Date(tAccept).toISOString(),
    expiresAt: computeOfferExpiresAt("2026-11-24T00:00:00.000Z"),
    reservationExpiresAt: new Date(tAccept + OFFER_RESERVATION_TTL_MS).toISOString(),
    reservationReleasedAt: null,
  };

  const base = {
    eligibility: makeEligibility("student", BUYER_ID),
    offer,
    listingSellerId: SELLER_A,
    listingStatus: "published",
    listingKind: "pre_loved",
    listingTitle: "Pre-Loved Book",
    listingPriceSen: 2000,
    collectionAreaName: "Cafe UMSKAL",
    sellerName: "HazIq Hazim",
    isBlocked: false,
    nowMs: tAccept + OFFER_RESERVATION_TTL_MS - 1000,
  };

  // Valid within 30m hold: uses locked 1200 sen (NOT listing's 2000 sen)
  const ok = prepareOfferOrderPlan(base);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.lockedOfferPriceSen, 1200);
    assert.equal(ok.orderPlan.financials.subtotalSen, 1200);
    assert.equal(ok.orderPlan.financials.commissionSen, 24);
    assert.equal(ok.orderPlan.financials.totalPaidSen, 1300);
  }

  // Expired at exact 30m: blocked
  assert.equal(
    prepareOfferOrderPlan({ ...base, nowMs: tAccept + OFFER_RESERVATION_TTL_MS }).ok,
    false
  );

  // Wrong buyer or blocked member: blocked
  assert.equal(
    prepareOfferOrderPlan({
      ...base,
      eligibility: makeEligibility("student", SELLER_B),
    }).ok,
    false
  );
  assert.equal(prepareOfferOrderPlan({ ...base, isBlocked: true }).ok, false);
});

test("ToyyibPay contracts format MYT expiry, reject browser redirects, verify exact amounts, and route late payments safely", () => {
  assert.equal(
    formatToyyibPayExpiryMyt("2026-11-24T01:30:00.000Z"),
    "24-11-2026 09:30:00"
  );
  assert.equal(parseToyyibPayAmountToSen("16.00"), 1600);
  assert.equal(parseToyyibPayAmountToSen("bad"), null);

  const payload = buildToyyibPayCreateBillPayload({
    secretKey: "sandbox-secret",
    categoryCode: "cat-123",
    orderCode: "BU-2611-0DB3",
    itemCount: 1,
    subtotalSen: 1500,
    fpxFeeSen: 100,
    totalPaidSen: 1600,
    buyerName: "Demo Student Buyer",
    buyerEmail: "examiner.buyer@iluv.ums.edu.my",
    returnUrl: "http://localhost:3000/orders/return",
    callbackUrl: "http://localhost:3000/api/payments/toyyibpay/callback",
    paymentDeadlineIso: "2026-11-24T01:30:00.000Z",
  });
  assert.equal(payload.billAmount, 1600);
  // Official ToyyibPay API: 1 = charge FPX to bill owner ("Amount"), preventing RM 1.00 double-charge
  assert.equal(payload.billChargeToCustomer, 1);
  assert.equal(payload.billExternalReferenceNo, "BU-2611-0DB3");

  // Mismatched subtotal + FPX fee throws immediately
  assert.throws(() =>
    buildToyyibPayCreateBillPayload({
      secretKey: "sandbox-secret",
      categoryCode: "cat-123",
      orderCode: "BU-2611-0DB3",
      itemCount: 1,
      subtotalSen: 1500,
      fpxFeeSen: 100,
      totalPaidSen: 1700,
      buyerName: "Buyer",
      buyerEmail: "buyer@iluv.ums.edu.my",
      returnUrl: "http://localhost:3000/orders/return",
      callbackUrl: "http://localhost:3000/api/payments/toyyibpay/callback",
      paymentDeadlineIso: "2026-11-24T01:30:00.000Z",
    })
  );

  // Webhook envelope parser + raw webhook NEVER marks paid directly
  assert.deepEqual(
    parseToyyibPayWebhookEnvelope({
      billcode: "u4jq05z9",
      order_id: "BU-2611-0DB3",
      status: "1",
      refno: "TP2611233721702887",
    }),
    {
      billCode: "u4jq05z9",
      orderCode: "BU-2611-0DB3",
      status: "1",
      refNo: "TP2611233721702887",
    }
  );
  assert.equal(parseToyyibPayWebhookEnvelope({ billcode: "" }), null);

  const order = {
    orderCode: "BU-2611-0DB3",
    status: "pending_payment",
    totalPaidSen: 1600,
    paymentDeadlineIso: "2026-11-24T01:30:00.000Z",
    paidAt: null,
  };
  const validTx = {
    billCode: "u4jq05z9",
    billExternalReferenceNo: "BU-2611-0DB3",
    billpaymentStatus: "1",
    billpaymentAmount: "16.00",
    billpaymentInvoiceNo: "TP2611233721702887",
  };
  const beforeDeadline = new Date("2026-11-24T01:20:00.000Z").getTime();
  const afterDeadline = new Date("2026-11-24T01:35:00.000Z").getTime();

  // Browser redirect and raw unverified webhook NEVER confirm paid
  assert.equal(
    evaluateToyyibPayVerification({
      source: "browser_redirect",
      order,
      expectedBillCode: "u4jq05z9",
      transaction: validTx,
      nowMs: beforeDeadline,
    }).action,
    "await_verification"
  );
  assert.equal(
    evaluateToyyibPayVerification({
      source: "raw_webhook",
      order,
      expectedBillCode: "u4jq05z9",
      transaction: validTx,
      nowMs: beforeDeadline,
    }).action,
    "await_verification"
  );

  // Verified server transaction confirms paid
  assert.equal(
    evaluateToyyibPayVerification({
      source: "verified_server_transaction",
      order,
      expectedBillCode: "u4jq05z9",
      transaction: validTx,
      nowMs: beforeDeadline,
    }).action,
    "confirm_paid"
  );

  // Amount tampering rejected
  assert.equal(
    evaluateToyyibPayVerification({
      source: "verified_server_transaction",
      order,
      expectedBillCode: "u4jq05z9",
      transaction: { ...validTx, billpaymentAmount: "1.00" },
      nowMs: beforeDeadline,
    }).action,
    "reject"
  );

  // Idempotent repeat callback on already-paid order
  assert.equal(
    evaluateToyyibPayVerification({
      source: "verified_server_transaction",
      order: { ...order, status: "paid", paidAt: "2026-11-24T01:21:00.000Z" },
      expectedBillCode: "u4jq05z9",
      transaction: validTx,
      nowMs: beforeDeadline,
    }).action,
    "idempotent_already_paid"
  );

  // Late verified payment after expiry routes to reconciliation (NEVER oversells)
  assert.equal(
    evaluateToyyibPayVerification({
      source: "verified_server_transaction",
      order: { ...order, status: "expired" },
      expectedBillCode: "u4jq05z9",
      transaction: validTx,
      nowMs: afterDeadline,
    }).action,
    "late_payment_reconciliation"
  );

  // Failed FPX bank status
  assert.equal(
    evaluateToyyibPayVerification({
      source: "verified_server_transaction",
      order,
      expectedBillCode: "u4jq05z9",
      transaction: { ...validTx, billpaymentStatus: "3" },
      nowMs: beforeDeadline,
    }).action,
    "mark_failed"
  );
});
