import assert from "node:assert/strict";
import test from "node:test";
import { buildCartSummary } from "../src/lib/buyer/cart.ts";
import {
  buildCheckoutPreparation,
  extractPriceSnapshots,
} from "../src/lib/buyer/checkout.ts";

const SELLER_A = "d3b398d8-9103-4bc2-84d3-6e0101b7659a";
const SELLER_B = "e4c498d8-9103-4bc2-84d3-6e0101b7659b";

function makeCartItem(overrides = {}) {
  return {
    id: "row-1",
    listingId: "2990db4c-11d6-4ec9-b4dd-5209a80ed74f",
    variantId: null,
    variantLabel: null,
    title: "Hirono",
    imageUrl: null,
    campusArea: "Cafe UMSKAL",
    condition: "New/Unused",
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
    isFood: false,
    availabilityMode: null,
    pickupWindowStart: null,
    pickupWindowEnd: null,
    pickupNote: null,
    foodNotes: null,
    ...overrides,
  };
}

test("buildCheckoutPreparation prepares single and multi-seller orders with exact sen subtotals and pending gateway fees", () => {
  const cart = buildCartSummary([
    makeCartItem({ id: "r1", sellerId: SELLER_A, unitPriceSen: 2000, quantity: 2, lineSubtotalSen: 4000, campusArea: "Cafe UMSKAL" }),
    makeCartItem({
      id: "r2",
      sellerId: SELLER_B,
      sellerDisplayName: "Aina",
      storefrontName: "Aina Bites",
      title: "Nasi Lemak Ready Pack",
      variantId: "aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb",
      variantLabel: "Portion: Regular",
      unitPriceSen: 650,
      quantity: 3,
      lineSubtotalSen: 1950,
      campusArea: "Dewan Kuliah",
      isFood: true,
      availabilityMode: "ready_now",
      pickupNote: "Meet near lobby",
    }),
  ]);

  const prep = buildCheckoutPreparation(cart);
  assert.equal(prep.sellerOrderCount, 2);
  assert.equal(prep.validQuantity, 5);
  assert.equal(prep.invalidRowCount, 0);
  assert.equal(prep.itemsSubtotalSen, 5950);
  assert.equal(prep.gatewayFeeStatus, "pending");
  assert.equal(prep.canProceedToPayment, true);
  assert.deepEqual(prep.blockingReasons, []);

  assert.equal(prep.sellerOrders[0]?.orderIndex, 1);
  assert.equal(prep.sellerOrders[0]?.subtotalSen, 4000);
  assert.deepEqual(prep.sellerOrders[0]?.collectionAreas, ["Cafe UMSKAL"]);

  assert.equal(prep.sellerOrders[1]?.orderIndex, 2);
  assert.equal(prep.sellerOrders[1]?.subtotalSen, 1950);
  assert.equal(prep.sellerOrders[1]?.hasFoodItems, true);
  assert.equal(prep.sellerOrders[1]?.hasPreorderItems, false);
});

test("buildCheckoutPreparation detects price changes against snapshots and blocks until acknowledged", () => {
  const initialCart = buildCartSummary([
    makeCartItem({ id: "r1", unitPriceSen: 2000, quantity: 2, lineSubtotalSen: 4000 }),
  ]);
  const snapshots = extractPriceSnapshots(buildCheckoutPreparation(initialCart));
  assert.equal(snapshots.r1, 2000);

  // Seller raises price from RM 20.00 to RM 25.00
  const updatedCart = buildCartSummary([
    makeCartItem({ id: "r1", unitPriceSen: 2500, quantity: 2, lineSubtotalSen: 5000 }),
  ]);
  const prepWithChange = buildCheckoutPreparation(updatedCart, snapshots);
  assert.equal(prepWithChange.priceChangedCount, 1);
  assert.equal(prepWithChange.canProceedToPayment, false);
  assert.equal(prepWithChange.itemsSubtotalSen, 5000);
  assert.equal(prepWithChange.sellerOrders[0]?.items[0]?.priceChanged, true);
  assert.equal(prepWithChange.sellerOrders[0]?.items[0]?.previousPriceSen, 2000);

  // Re-snapshotting after buyer review clears the price-change block
  const ackSnapshots = extractPriceSnapshots(prepWithChange);
  const prepAck = buildCheckoutPreparation(updatedCart, ackSnapshots);
  assert.equal(prepAck.priceChangedCount, 0);
  assert.equal(prepAck.canProceedToPayment, true);
});

test("buildCheckoutPreparation blocks unavailable stock, self-purchase, empty cart, and untested food pre-orders", () => {
  // Empty cart
  const emptyPrep = buildCheckoutPreparation(buildCartSummary([]));
  assert.equal(emptyPrep.canProceedToPayment, false);
  assert.equal(emptyPrep.totalRowCount, 0);

  // Food pre-order blocked
  const preorderCart = buildCartSummary([
    makeCartItem({
      id: "r-food",
      isFood: true,
      availabilityMode: "pre_order",
      unitPriceSen: 1200,
      quantity: 1,
      lineSubtotalSen: 1200,
    }),
  ]);
  const preorderPrep = buildCheckoutPreparation(preorderCart);
  assert.equal(preorderPrep.canProceedToPayment, false);
  assert.equal(preorderPrep.invalidRowCount, 1);
  assert.equal(preorderPrep.itemsSubtotalSen, 0);
  assert.equal(preorderPrep.sellerOrders[0]?.hasPreorderItems, true);

  // Unavailable / self-purchase cart item blocked and excluded from subtotal
  const mixedCart = buildCartSummary([
    makeCartItem({ id: "r-ok", unitPriceSen: 1500, quantity: 1, lineSubtotalSen: 1500 }),
    makeCartItem({
      id: "r-bad",
      isValid: false,
      issueCode: "self_purchase",
      issueMessage: "You cannot purchase your own listing.",
      lineSubtotalSen: 0,
    }),
  ]);
  const mixedPrep = buildCheckoutPreparation(mixedCart);
  assert.equal(mixedPrep.canProceedToPayment, false);
  assert.equal(mixedPrep.validQuantity, 1);
  assert.equal(mixedPrep.invalidRowCount, 1);
  assert.equal(mixedPrep.itemsSubtotalSen, 1500);
});
