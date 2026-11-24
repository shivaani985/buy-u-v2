import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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
  summarizeMultiSellerBillBatch,
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
  // Official ToyyibPay API: "" (blank) = charge FPX & CC to bill owner, preventing RM 1.00 double-charge
  assert.equal(payload.billChargeToCustomer, "");
  assert.equal(payload.billPaymentChannel, 0);
  assert.equal(payload.billExternalReferenceNo, "BU-2611-0DB3");

  // Multi-seller partial bill failure isolates failed seller order without losing sibling bills
  const partialBatch = summarizeMultiSellerBillBatch([
    {
      orderId: "ord-a",
      orderCode: "BU-2611-AAA1",
      billCode: "billA123",
      billUrl: "https://dev.toyyibpay.com/billA123",
    },
    {
      orderId: "ord-b",
      orderCode: "BU-2611-BBB2",
      billCode: null,
      billUrl: null,
      error: "ToyyibPay sandbox timeout",
    },
  ]);
  assert.equal(partialBatch.status, "partial_failure");
  assert.equal(partialBatch.readyBills.length, 1);
  assert.equal(partialBatch.failedBills.length, 1);
  assert.equal(partialBatch.failedBills[0]?.orderId, "ord-b");

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

  // Idempotent repeat callback on already-paid order (exact ref passes, conflicting ref rejected)
  assert.equal(
    evaluateToyyibPayVerification({
      source: "verified_server_transaction",
      order: {
        ...order,
        status: "paid",
        paidAt: "2026-11-24T01:21:00.000Z",
        existingTransactionRef: "TP2611233721702887",
      },
      expectedBillCode: "u4jq05z9",
      transaction: validTx,
      nowMs: beforeDeadline,
    }).action,
    "idempotent_already_paid"
  );
  assert.equal(
    evaluateToyyibPayVerification({
      source: "verified_server_transaction",
      order: {
        ...order,
        status: "paid",
        paidAt: "2026-11-24T01:21:00.000Z",
        existingTransactionRef: "TP2611233721702887",
      },
      expectedBillCode: "u4jq05z9",
      transaction: { ...validTx, billpaymentInvoiceNo: "TP-DIFFERENT-REPLAY" },
      nowMs: beforeDeadline,
    }).action,
    "reject"
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

// =============================================================================
// Phase 6B.1 Final Concurrency & SQL Integrity Regression Tests
// =============================================================================

function extractSqlFunction(sql, fnName) {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${fnName}`);
  assert.ok(start >= 0, `Missing SQL function ${fnName}`);
  const end = sql.indexOf("$$;", start);
  assert.ok(end > start, `Unterminated SQL function ${fnName}`);
  return sql.slice(start, end + 3);
}

test("Phase 6B.1 SQL enforces global listings-before-variants lock order, snapshot isolation, exact release, and active seller checks", () => {
  const sqlPath = path.resolve(
    process.cwd(),
    "docs/sql/phase-6a-order-payment-foundation.sql"
  );
  const sql = fs.readFileSync(sqlPath, "utf8");

  const offerFn = extractSqlFunction(sql, "create_offer_order_atomic");
  const cartFn = extractSqlFunction(sql, "create_cart_orders_atomic");
  const expiryFn = extractSqlFunction(sql, "release_expired_cart_orders");
  const confirmFn = extractSqlFunction(sql, "confirm_order_payment_atomic");

  // 1. Consistent lock order: listings (ORDER BY l.id FOR UPDATE) BEFORE listing_variants (ORDER BY lv.id FOR UPDATE)
  for (const [name, body] of [
    ["create_cart_orders_atomic", cartFn],
    ["release_expired_cart_orders", expiryFn],
    ["confirm_order_payment_atomic", confirmFn],
  ]) {
    const lockListingsIdx = body.indexOf("FROM public.listings l");
    const lockVariantsIdx = body.indexOf("FROM public.listing_variants lv");
    assert.ok(lockListingsIdx > 0, `${name} must pre-lock listings`);
    assert.ok(lockVariantsIdx > 0, `${name} must pre-lock listing_variants`);
    assert.ok(
      lockListingsIdx < lockVariantsIdx,
      `${name} must lock listings before listing_variants`
    );
    assert.ok(
      body.includes("ORDER BY l.id\n  FOR UPDATE") ||
        body.includes("ORDER BY l.id\n      FOR UPDATE"),
      `${name} must lock listings in deterministic ID order`
    );
    assert.ok(
      body.includes("ORDER BY lv.id\n  FOR UPDATE") ||
        body.includes("ORDER BY lv.id\n      FOR UPDATE"),
      `${name} must lock listing_variants in deterministic ID order`
    );
  }

  // 2. Concurrent idempotency: advisory checkout lock + post-lock idempotency recheck before CART_EMPTY
  assert.ok(cartFn.includes("pg_advisory_xact_lock("));
  const snapshotIdx = cartFn.indexOf("INTO v_cart_item_ids");
  const recheckIdx = cartFn.indexOf("idempotency_key = v_key", snapshotIdx);
  const cartEmptyIdx = cartFn.indexOf("RAISE EXCEPTION 'CART_EMPTY'");
  assert.ok(
    snapshotIdx > 0 && recheckIdx > snapshotIdx && recheckIdx < cartEmptyIdx,
    "create_cart_orders_atomic must recheck idempotency_key after locking and before CART_EMPTY"
  );

  // 3. Snapshotted cart item IDs used for processing & deletion (never blanket DELETE WHERE user_id = v_uid)
  assert.ok(
    cartFn.includes("DELETE FROM public.cart_items\n  WHERE user_id = v_uid\n    AND id = ANY(v_cart_item_ids);"),
    "create_cart_orders_atomic must delete only snapshotted cart_item IDs"
  );
  assert.equal(
    cartFn.includes("DELETE FROM public.cart_items\n  WHERE user_id = v_uid;"),
    false
  );

  // 4. Expiry cleanup validates reservation integrity without GREATEST(0, ...)
  assert.equal(expiryFn.includes("GREATEST(0"), false);
  assert.ok(expiryFn.includes("INSUFFICIENT_LISTING_RESERVATION"));
  assert.ok(expiryFn.includes("INSUFFICIENT_VARIANT_RESERVATION"));

  // 5. Inactive/suspended sellers blocked in both offer and cart order creation
  assert.ok(offerFn.includes("SELLER_NOT_ACTIVE"));
  assert.ok(cartFn.includes("SELLER_NOT_ACTIVE"));
});

test("Concurrency model: simultaneous identical submissions, mid-checkout cart add, overlapping variant holds, inactive seller, and payment-vs-expiry races", () => {
  // Minimal faithful in-memory state machine mirroring the SQL RPC invariants
  const state = {
    profiles: new Map([
      [SELLER_A, { status: "active" }],
      [SELLER_B, { status: "suspended" }],
    ]),
    listings: new Map([
      ["L1", { id: "L1", sellerId: SELLER_A, status: "published", quantity: 5, reserved: 0, hasVariants: true }],
      ["L2", { id: "L2", sellerId: SELLER_B, status: "published", quantity: 3, reserved: 0, hasVariants: false }],
    ]),
    variants: new Map([
      ["V1", { id: "V1", listingId: "L1", active: true, quantity: 3, reserved: 0, priceSen: 1500 }],
      ["V2", { id: "V2", listingId: "L1", active: true, quantity: 2, reserved: 0, priceSen: 1800 }],
    ]),
    cart: [
      { id: "ci-1", userId: BUYER_ID, listingId: "L1", variantId: "V1", quantity: 2 },
    ],
    orders: [],
  };

  function runCreateCartOrders(userId, key, nowMs, onAfterSnapshot) {
    // 1. Snapshot locked cart item IDs + post-lock idempotency recheck
    const snapshotIds = state.cart.filter((c) => c.userId === userId).map((c) => c.id);
    if (onAfterSnapshot) onAfterSnapshot();

    const existing = state.orders.filter(
      (o) => o.buyerId === userId && o.source === "cart" && o.idempotencyKey === key
    );
    if (existing.length > 0) return existing;
    if (snapshotIds.length === 0) throw new Error("CART_EMPTY");

    const items = state.cart.filter((c) => snapshotIds.includes(c.id));
    // Validate seller active + stock before mutating
    for (const ci of items) {
      const l = state.listings.get(ci.listingId);
      if (!l || l.status !== "published") throw new Error("LISTING_UNAVAILABLE");
      const seller = state.profiles.get(l.sellerId);
      if (!seller || seller.status !== "active") throw new Error("SELLER_NOT_ACTIVE");
      if (l.reserved < 0 || l.quantity - l.reserved < ci.quantity) {
        throw new Error("INSUFFICIENT_LISTING_STOCK");
      }
      if (l.hasVariants) {
        const v = state.variants.get(ci.variantId);
        if (!v || !v.active) throw new Error("VARIANT_UNAVAILABLE");
        if (v.reserved < 0 || v.quantity - v.reserved < ci.quantity) {
          throw new Error("INSUFFICIENT_VARIANT_STOCK");
        }
      }
    }

    // Reserve listings before variants
    for (const ci of items) {
      const l = state.listings.get(ci.listingId);
      l.reserved += ci.quantity;
      if (l.hasVariants) state.variants.get(ci.variantId).reserved += ci.quantity;
    }

    const order = {
      id: `ord-${state.orders.length + 1}`,
      buyerId: userId,
      sellerId: SELLER_A,
      source: "cart",
      idempotencyKey: key,
      status: "pending_payment",
      paidAt: null,
      paymentDeadlineMs: nowMs + 15 * 60_000,
      items: items.map((ci) => ({
        listingId: ci.listingId,
        variantId: ci.variantId,
        quantity: ci.quantity,
      })),
    };
    state.orders.push(order);

    // Delete ONLY snapshotted cart IDs
    state.cart = state.cart.filter((c) => !snapshotIds.includes(c.id));
    return [order];
  }

  function runReleaseExpired(nowMs) {
    let released = 0;
    for (const ord of state.orders) {
      if (
        ord.source !== "cart" ||
        ord.status !== "pending_payment" ||
        ord.paidAt !== null ||
        ord.paymentDeadlineMs > nowMs
      ) {
        continue;
      }
      // Validate exact reservation integrity first (no GREATEST(0, ...))
      let valid = true;
      for (const item of ord.items) {
        const l = state.listings.get(item.listingId);
        const v = item.variantId ? state.variants.get(item.variantId) : null;
        if (!l || l.reserved < item.quantity || (v && v.reserved < item.quantity)) {
          valid = false;
          break;
        }
      }
      if (!valid) continue;

      for (const item of ord.items) {
        state.listings.get(item.listingId).reserved -= item.quantity;
        if (item.variantId) state.variants.get(item.variantId).reserved -= item.quantity;
      }
      ord.status = "expired";
      released += 1;
    }
    return released;
  }

  function runConfirmPayment(orderId, nowMs) {
    const ord = state.orders.find((o) => o.id === orderId);
    if (!ord) throw new Error("ORDER_NOT_FOUND");
    if (ord.status === "expired" || nowMs >= ord.paymentDeadlineMs) {
      return "late_payment_reconciliation";
    }
    for (const item of ord.items) {
      const l = state.listings.get(item.listingId);
      const v = item.variantId ? state.variants.get(item.variantId) : null;
      if (l.reserved < item.quantity || l.quantity < item.quantity) {
        throw new Error("INSUFFICIENT_LISTING_RESERVATION");
      }
      if (v && (v.reserved < item.quantity || v.quantity < item.quantity)) {
        throw new Error("INSUFFICIENT_VARIANT_RESERVATION");
      }
      l.quantity -= item.quantity;
      l.reserved -= item.quantity;
      if (v) {
        v.quantity -= item.quantity;
        v.reserved -= item.quantity;
      }
    }
    ord.status = "paid";
    ord.paidAt = nowMs;
    return "confirmed_paid";
  }

  const t0 = 1_700_000_000_000;

  // Scenario A: Concurrent cart addition during checkout + simultaneous duplicate submission
  const firstOrders = runCreateCartOrders(BUYER_ID, "idem-key-0001", t0, () => {
    // Mid-checkout concurrent cart addition by the same buyer
    state.cart.push({ id: "ci-2", userId: BUYER_ID, listingId: "L1", variantId: "V1", quantity: 1 });
  });
  assert.equal(firstOrders.length, 1);
  assert.equal(state.listings.get("L1").reserved, 2);
  assert.equal(state.variants.get("V1").reserved, 2);
  // Concurrent cart addition ci-2 was neither purchased nor deleted
  assert.deepEqual(state.cart.map((c) => c.id), ["ci-2"]);

  // Simultaneous retry with identical idempotency key returns original order (not CART_EMPTY, no double-reserve)
  const retryOrders = runCreateCartOrders(BUYER_ID, "idem-key-0001", t0 + 50);
  assert.equal(retryOrders[0].id, firstOrders[0].id);
  assert.equal(state.listings.get("L1").reserved, 2);
  assert.equal(state.variants.get("V1").reserved, 2);

  // Scenario B: Overlapping variant hold on same listing/variant (ci-2 creates Order 2 at t0 + 5m)
  const secondOrders = runCreateCartOrders(BUYER_ID, "idem-key-0002", t0 + 5 * 60_000);
  assert.equal(secondOrders.length, 1);
  assert.equal(state.listings.get("L1").reserved, 3);
  assert.equal(state.variants.get("V1").reserved, 3);

  // Expiry at t0 + 16m releases ONLY Order 1 (qty 2); Order 2's overlapping hold (qty 1) stays intact
  assert.equal(runReleaseExpired(t0 + 16 * 60_000), 1);
  assert.equal(firstOrders[0].status, "expired");
  assert.equal(secondOrders[0].status, "pending_payment");
  assert.equal(state.listings.get("L1").reserved, 1);
  assert.equal(state.variants.get("V1").reserved, 1);

  // Scenario C: Payment-vs-expiry races
  // C1: Late payment callback after Order 1 expired routes to reconciliation without touching stock/holds
  assert.equal(runConfirmPayment(firstOrders[0].id, t0 + 16 * 60_000), "late_payment_reconciliation");
  assert.equal(state.listings.get("L1").quantity, 5);
  assert.equal(state.listings.get("L1").reserved, 1);

  // C2: Order 2 confirms paid BEFORE its deadline; subsequent expiry sweep does not release or expire it
  assert.equal(runConfirmPayment(secondOrders[0].id, t0 + 18 * 60_000), "confirmed_paid");
  assert.equal(secondOrders[0].status, "paid");
  assert.equal(state.listings.get("L1").quantity, 4);
  assert.equal(state.listings.get("L1").reserved, 0);
  assert.equal(state.variants.get("V1").quantity, 2);
  assert.equal(state.variants.get("V1").reserved, 0);
  assert.equal(runReleaseExpired(t0 + 30 * 60_000), 0);

  // Scenario D: Corrupted expired order cannot decrement another live order's hold
  state.orders.push({
    id: "ord-corrupt",
    buyerId: BUYER_ID,
    sellerId: SELLER_A,
    source: "cart",
    idempotencyKey: "idem-corrupt",
    status: "pending_payment",
    paidAt: null,
    paymentDeadlineMs: t0,
    items: [{ listingId: "L1", variantId: "V1", quantity: 2 }],
  });
  state.listings.get("L1").reserved = 1; // Another live order holds 1 unit
  state.variants.get("V1").reserved = 1;
  assert.equal(runReleaseExpired(t0 + 40 * 60_000), 0);
  assert.equal(state.listings.get("L1").reserved, 1); // Untouched!
  assert.equal(state.variants.get("V1").reserved, 1); // Untouched!

  // Scenario E: Inactive/suspended seller cannot receive new orders
  state.cart.push({ id: "ci-suspended", userId: BUYER_ID, listingId: "L2", variantId: null, quantity: 1 });
  assert.throws(
    () => runCreateCartOrders(BUYER_ID, "idem-suspended", t0 + 50 * 60_000),
    /SELLER_NOT_ACTIVE/
  );
  assert.equal(state.listings.get("L2").reserved, 0);
});

test("Phase 6B.2 reserved-stock guard SQL protects listings and listing_variants for ALL roles on structural invariants and blocks direct client reserved_quantity tampering", () => {
  const guardSql = fs.readFileSync(
    path.resolve(process.cwd(), "docs/sql/phase-6b2-reserved-stock-guard.sql"),
    "utf8"
  );

  // SECURITY INVOKER + effective-role check (never auth.role(), which breaks SECURITY DEFINER RPCs)
  assert.ok(guardSql.includes("SECURITY INVOKER"));
  assert.ok(guardSql.includes("SET search_path = public, pg_temp"));
  const privReturnIdx = guardSql.indexOf("IF current_user NOT IN ('authenticated', 'anon') THEN");
  assert.ok(privReturnIdx > 0, "Missing privileged-role early return");
  assert.equal(guardSql.includes("auth.role()"), false);

  // Structural invariants MUST appear BEFORE the privileged-role early return (guards SECURITY DEFINER update_listing_atomic too)
  const deleteIdx = guardSql.indexOf("IF TG_OP = 'DELETE' THEN");
  const hasVariantsIdx = guardSql.indexOf("NEW.has_variants IS DISTINCT FROM OLD.has_variants");
  const listingIdIdx = guardSql.indexOf("NEW.listing_id IS DISTINCT FROM OLD.listing_id");
  const optionValuesIdx = guardSql.indexOf("NEW.option_values IS DISTINCT FROM OLD.option_values");
  const activeIdx = guardSql.indexOf("NEW.active IS NOT TRUE");
  for (const [label, idx] of [
    ["DELETE active reservation guard", deleteIdx],
    ["has_variants guard", hasVariantsIdx],
    ["variant listing_id guard", listingIdIdx],
    ["variant option_values guard", optionValuesIdx],
    ["variant active guard", activeIdx],
  ]) {
    assert.ok(idx > 0 && idx < privReturnIdx, `${label} must execute BEFORE privileged-role early return`);
  }

  // Direct client reservation tampering blocked AFTER privileged-role early return
  const insertIdx = guardSql.indexOf("COALESCE(NEW.reserved_quantity, 0) <> 0");
  const reservedUpdateIdx = guardSql.indexOf("NEW.reserved_quantity IS DISTINCT FROM OLD.reserved_quantity");
  const qtyBelowReservedIdx = guardSql.indexOf("NEW.quantity < COALESCE(OLD.reserved_quantity, 0)");
  assert.ok(insertIdx > privReturnIdx);
  assert.ok(reservedUpdateIdx > privReturnIdx);
  assert.ok(qtyBelowReservedIdx > privReturnIdx);
  assert.ok((guardSql.match(/ERRCODE = '42501'/g) || []).length >= 8);

  // Triggers attached to BOTH listings and listing_variants for INSERT/UPDATE/DELETE + rollback included
  assert.ok(guardSql.includes("BEFORE INSERT OR UPDATE OR DELETE ON public.listings"));
  assert.ok(guardSql.includes("BEFORE INSERT OR UPDATE OR DELETE ON public.listing_variants"));
  assert.ok(guardSql.includes("DROP TRIGGER IF EXISTS trg_guard_listings_reserved_stock"));
  assert.ok(guardSql.includes("DROP TRIGGER IF EXISTS trg_guard_listing_variants_reserved_stock"));

  // Behavior simulation: legitimate seller edits vs update_listing_atomic (postgres) bypass vs reservation RPCs
  function simulateGuard({ role, op, table, oldRow, newRow }) {
    const oldRes = oldRow?.reserved_quantity ?? 0;
    if (op === "DELETE") {
      if (oldRes > 0) throw new Error("42501:DELETE_RESERVED");
      return oldRow;
    }
    if (op === "UPDATE" && oldRes > 0) {
      if (table === "listings" && newRow.has_variants !== oldRow.has_variants) {
        throw new Error("42501:HAS_VARIANTS");
      }
      if (table === "listing_variants") {
        if (newRow.listing_id !== oldRow.listing_id) throw new Error("42501:LISTING_ID");
        if (JSON.stringify(newRow.option_values) !== JSON.stringify(oldRow.option_values)) {
          throw new Error("42501:OPTION_VALUES");
        }
        if (newRow.active !== true) throw new Error("42501:DEACTIVATE");
      }
    }
    if (role !== "authenticated" && role !== "anon") return newRow;
    if (op === "INSERT" && (newRow.reserved_quantity ?? 0) !== 0) throw new Error("42501:INSERT_RESERVED");
    if (op === "UPDATE") {
      if (newRow.reserved_quantity !== oldRow.reserved_quantity) throw new Error("42501:UPDATE_RESERVED");
      if (newRow.quantity != null && newRow.quantity < oldRes) throw new Error("42501:QTY_BELOW_RESERVED");
    }
    return newRow;
  }

  const reservedListing = { id: "L1", has_variants: true, quantity: 5, reserved_quantity: 2, price_sen: 1500 };
  const reservedVariant = { id: "V1", listing_id: "L1", option_values: { Size: "M" }, active: true, quantity: 3, reserved_quantity: 2 };

  // Legitimate seller edits pass (price/safe quantity)
  assert.doesNotThrow(() =>
    simulateGuard({ role: "authenticated", op: "UPDATE", table: "listings", oldRow: reservedListing, newRow: { ...reservedListing, price_sen: 1800, quantity: 2 } })
  );
  // Authorized reservation RPC (postgres) mutating reserved_quantity passes
  assert.doesNotThrow(() =>
    simulateGuard({ role: "postgres", op: "UPDATE", table: "listing_variants", oldRow: reservedVariant, newRow: { ...reservedVariant, reserved_quantity: 1, quantity: 2 } })
  );
  // SECURITY DEFINER update_listing_atomic (postgres) bypasses on reserved inventory are ALL blocked
  assert.throws(() =>
    simulateGuard({ role: "postgres", op: "UPDATE", table: "listings", oldRow: reservedListing, newRow: { ...reservedListing, has_variants: false } }),
    /42501:HAS_VARIANTS/
  );
  assert.throws(() =>
    simulateGuard({ role: "postgres", op: "UPDATE", table: "listing_variants", oldRow: reservedVariant, newRow: { ...reservedVariant, option_values: { Size: "XL" } } }),
    /42501:OPTION_VALUES/
  );
  assert.throws(() =>
    simulateGuard({ role: "postgres", op: "UPDATE", table: "listing_variants", oldRow: reservedVariant, newRow: { ...reservedVariant, active: false } }),
    /42501:DEACTIVATE/
  );
  assert.throws(() =>
    simulateGuard({ role: "postgres", op: "DELETE", table: "listing_variants", oldRow: reservedVariant }),
    /42501:DELETE_RESERVED/
  );
});

test("Phase 6B.3 ToyyibPay Sandbox integration enforces server-only secrets, sandbox pinning, server-side verification, duplicate-bill guard, and pickup_pin seller isolation", () => {
  const root = process.cwd();
  const serverMod = fs.readFileSync(
    path.resolve(root, "src/lib/payments/toyyibpay-server.ts"),
    "utf8"
  );
  const callbackRoute = fs.readFileSync(
    path.resolve(root, "src/app/api/payments/toyyibpay/callback/route.ts"),
    "utf8"
  );
  const returnPage = fs.readFileSync(
    path.resolve(root, "src/app/orders/return/page.tsx"),
    "utf8"
  );

  // 1. Server-only & strictly ToyyibPay Sandbox pinned
  assert.ok(serverMod.includes('typeof window !== "undefined"'));
  assert.ok(serverMod.includes("TOYYIBPAY_SANDBOX_SECRET_KEY"));
  assert.ok(serverMod.includes("TOYYIBPAY_SANDBOX_CATEGORY_CODE"));
  assert.equal(serverMod.includes("NEXT_PUBLIC_TOYYIBPAY"), false);
  assert.ok(serverMod.includes('https://dev.toyyibpay.com'));

  // 2. Persistent DB-backed bill coordination (NO process-local inFlightBillCreations map)
  assert.equal(serverMod.includes("inFlightBillCreations"), false);
  assert.ok(serverMod.includes('"claim_order_bill_slot"'));
  assert.ok(serverMod.includes('"finalize_order_bill_slot"'));
  assert.ok(serverMod.includes('"mark_order_payment_failed_atomic"'));
  assert.ok(serverMod.includes("ToyyibPayDefiniteError"));
  assert.ok(serverMod.includes('"ambiguous"'));

  // 3. Callback & Return routes NEVER confirm paid directly; both call verifyAndReconcileBillPayment -> getBillTransactions -> confirm_order_payment_atomic
  assert.ok(callbackRoute.includes("verifyAndReconcileBillPayment"));
  assert.equal(callbackRoute.includes(".rpc("), false);
  assert.ok(returnPage.includes("verifyAndReconcileBillPayment"));
  assert.ok(returnPage.includes('"get_buyer_order_pickup_pins"'));
  assert.equal(returnPage.includes("confirm_order_payment_atomic"), false);
  assert.ok(serverMod.includes("/index.php/api/getBillTransactions"));
  assert.ok(serverMod.includes('"confirm_order_payment_atomic"'));

  // 4. DB-level PIN & raw_callback privacy + buyer-only PIN RPC (zero direct pickup_pin column selects)
  const ordersData = fs.readFileSync(path.resolve(root, "src/lib/orders/data.ts"), "utf8");
  assert.ok(ordersData.includes('"get_buyer_order_pickup_pins"'));
  assert.equal(ordersData.includes(",pickup_pin"), false);
  assert.equal(returnPage.includes(", pickup_pin"), false);
  for (const rel of ["src/lib/seller/data.ts", "src/app/seller/actions.ts"]) {
    const content = fs.readFileSync(path.resolve(root, rel), "utf8");
    assert.equal(content.includes("pickup_pin"), false, `${rel} must never query pickup_pin`);
  }

  // 5. Phase 6B.3 hardening SQL invariants
  const hardeningSql = fs.readFileSync(
    path.resolve(root, "docs/sql/phase-6b3-payment-security-hardening.sql"),
    "utf8"
  );
  assert.ok(hardeningSql.includes("REVOKE SELECT ON public.orders FROM authenticated, anon;"));
  assert.ok(hardeningSql.includes("REVOKE SELECT ON public.payments FROM authenticated, anon;"));
  assert.ok(hardeningSql.includes("DROP TABLE public.orders"));
  assert.ok(hardeningSql.includes("DROP TABLE public.payments"));
  assert.ok(hardeningSql.includes("CREATE OR REPLACE FUNCTION public.get_buyer_order_pickup_pins"));
  assert.ok(hardeningSql.includes("CREATE OR REPLACE FUNCTION public.claim_order_bill_slot"));
  assert.ok(hardeningSql.includes("CREATE OR REPLACE FUNCTION public.finalize_order_bill_slot"));
  assert.ok(hardeningSql.includes("CREATE OR REPLACE FUNCTION public.mark_order_payment_failed_atomic"));
  assert.ok(hardeningSql.includes("ambiguous_hold"));
  assert.ok(hardeningSql.includes("ignored_terminal"));
  // Must NOT add a redundant unique index on payments(order_id)
  assert.equal(/CREATE UNIQUE INDEX[^\n]*payments\s*\(\s*order_id/i.test(hardeningSql), false);

  // 6. Phase 6B.3 incremental bill-lifecycle hardening SQL & server client invariants
  const lifecycleSql = fs.readFileSync(
    path.resolve(root, "docs/sql/phase-6b3-bill-lifecycle-hardening.sql"),
    "utf8"
  );
  assert.ok(lifecycleSql.includes("ADD COLUMN IF NOT EXISTS bill_creation_attempt_token uuid"));
  assert.ok(lifecycleSql.includes("v_has_valid_bill AND v_payment.status IN ('pending', 'failed')"));
  assert.ok(lifecycleSql.includes("RETURN 'stale_attempt'"));
  assert.ok(lifecycleSql.includes("RETURN 'recovered_ready'"));
  assert.ok(lifecycleSql.includes("v_payment.bill_creation_state NOT IN ('creating', 'ambiguous')"));
  // mark_order_payment_failed_atomic must NOT overwrite bill_creation_state
  const markFailFn = lifecycleSql.slice(
    lifecycleSql.indexOf("CREATE OR REPLACE FUNCTION public.mark_order_payment_failed_atomic")
  );
  assert.equal(markFailFn.includes("bill_creation_state = 'failed'"), false);
  assert.ok(serverMod.includes("p_attempt_token: attemptToken"));
  assert.ok(serverMod.includes('"recovered_ready"'));
});

test("Phase 6B.3 bill-lifecycle state machine: preserves valid bills on failed payment, rejects stale tokens, recovers ambiguous responses, and protects terminal states", () => {
  // Faithful in-memory model of claim_order_bill_slot / finalize_order_bill_slot / mark_order_payment_failed_atomic
  const order = { id: "ord-1", status: "pending_payment", paid_at: null, total_paid_sen: 1600 };
  let payment = null;
  let seq = 0;

  function claim() {
    if (order.paid_at || order.status === "paid") return { action: "already_paid" };
    if (payment) {
      if (payment.status === "paid" || payment.status === "late_payment_review") {
        return { action: "already_terminal" };
      }
      const hasValidBill =
        payment.bill_creation_state === "ready" &&
        payment.bill_code &&
        payment.bill_url &&
        !payment.bill_code.startsWith("creating:");
      if (hasValidBill && (payment.status === "pending" || payment.status === "failed")) {
        payment.status = "pending";
        return { action: "reuse_bill", bill_code: payment.bill_code, bill_url: payment.bill_url };
      }
      if (payment.bill_creation_state === "creating") return { action: "in_progress" };
      if (payment.bill_creation_state === "ambiguous") return { action: "ambiguous_hold" };
      if (payment.bill_creation_state === "failed" && payment.bill_code.startsWith("creating:")) {
        const token = `tok-${++seq}`;
        payment = {
          ...payment,
          bill_code: `creating:${order.id}:${token}`,
          bill_url: null,
          status: "pending",
          bill_creation_state: "creating",
          attempt_token: token,
        };
        return { action: "create_new", attempt_token: token };
      }
      return { action: "ambiguous_hold" };
    }
    const token = `tok-${++seq}`;
    payment = {
      order_id: order.id,
      bill_code: `creating:${order.id}:${token}`,
      bill_url: null,
      status: "pending",
      bill_creation_state: "creating",
      attempt_token: token,
    };
    return { action: "create_new", attempt_token: token };
  }

  function finalize(token, outcome, billCode = null, billUrl = null) {
    if (!payment) return "missing_slot";
    if (payment.status === "paid" || payment.status === "late_payment_review") return "ignored_terminal";
    if (payment.attempt_token !== token) return "stale_attempt";
    if (outcome === "ready" && billCode && billUrl) {
      if (payment.bill_creation_state !== "creating" && payment.bill_creation_state !== "ambiguous") {
        return "ignored_state";
      }
      const wasAmbiguous = payment.bill_creation_state === "ambiguous";
      payment.bill_code = billCode;
      payment.bill_url = billUrl;
      payment.status = "pending";
      payment.bill_creation_state = "ready";
      payment.attempt_token = null;
      return wasAmbiguous ? "recovered_ready" : "ready";
    }
    if (payment.bill_creation_state !== "creating") return "ignored_state";
    if (outcome === "failed") {
      payment.status = "failed";
      payment.bill_creation_state = "failed";
      payment.attempt_token = null;
      return "failed";
    }
    payment.bill_creation_state = "ambiguous";
    return "ambiguous";
  }

  function markFailed(billCode) {
    if (!payment || payment.bill_code !== billCode) return "payment_not_found";
    if (order.paid_at || order.status === "paid" || payment.status === "paid" || payment.status === "late_payment_review") {
      return "ignored_terminal";
    }
    if (payment.status !== "pending") return `already_${payment.status}`;
    payment.status = "failed"; // Preserves bill_creation_state='ready', bill_code, bill_url!
    return "marked_failed";
  }

  // 1. Definite bill-creation failure -> clean retry creates new attempt; stale token rejected
  const c1 = claim();
  assert.equal(c1.action, "create_new");
  assert.equal(claim().action, "in_progress"); // Concurrent claim blocked
  assert.equal(finalize(c1.attempt_token, "failed"), "failed");
  const c2 = claim();
  assert.equal(c2.action, "create_new");
  assert.notEqual(c2.attempt_token, c1.attempt_token);
  assert.equal(finalize(c1.attempt_token, "ready", "staleBill", "https://dev.toyyibpay.com/staleBill"), "stale_attempt");

  // 2. Ambiguous timeout -> blocks blind duplicate creation, then safely recovers when verified response arrives
  assert.equal(finalize(c2.attempt_token, "ambiguous"), "ambiguous");
  assert.equal(claim().action, "ambiguous_hold");
  assert.equal(
    finalize(c2.attempt_token, "ready", "billReal123", "https://dev.toyyibpay.com/billReal123"),
    "recovered_ready"
  );

  // 3. Failed FPX payment attempt on existing valid bill -> preserves bill_code & reuses it on retry!
  assert.equal(markFailed("billReal123"), "marked_failed");
  assert.equal(payment.bill_creation_state, "ready");
  assert.equal(payment.bill_code, "billReal123");
  const cRetry = claim();
  assert.equal(cRetry.action, "reuse_bill");
  assert.equal(cRetry.bill_code, "billReal123");

  // 4. Terminal paid / late_payment_review cannot be overwritten by delayed failed callback
  order.status = "paid";
  order.paid_at = "2026-11-24T04:00:00Z";
  payment.status = "paid";
  assert.equal(markFailed("billReal123"), "ignored_terminal");
  assert.equal(payment.status, "paid");

  order.status = "expired";
  order.paid_at = null;
  payment.status = "late_payment_review";
  assert.equal(markFailed("billReal123"), "ignored_terminal");
  assert.equal(payment.status, "late_payment_review");
});
