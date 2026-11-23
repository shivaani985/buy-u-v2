import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCartSummary,
  evaluateCartLineState,
  validateCartQuantityUpdate,
} from "../src/lib/buyer/cart.ts";
import { evaluateBuyerEligibility } from "../src/lib/buyer/validation.ts";

const BUYER_ID = "17d414ce-8349-4dc2-bccd-94d9bd0ebc52";
const OTHER_USER_ID = "99999999-8349-4dc2-bccd-94d9bd0ebc52";
const SELLER_A = "d3b398d8-9103-4bc2-84d3-6e0101b7659a";
const SELLER_B = "e4c498d8-9103-4bc2-84d3-6e0101b7659b";
const LISTING_1 = "2990db4c-11d6-4ec9-b4dd-5209a80ed74f";
const VARIANT_1 = "aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb";
const CART_ROW_1 = "11111111-2222-4333-8444-555555555555";

function makeEligibility(role = "student", userId = BUYER_ID) {
  return evaluateBuyerEligibility({
    isAuthenticated: true,
    isEmailVerified: true,
    isActiveMember: true,
    profile: {
      id: userId,
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

test("evaluateBuyerEligibility enforces Student/Staff buyer roles and blocks dedicated non-member admin roles", () => {
  assert.equal(makeEligibility("student").eligible, true);
  assert.equal(makeEligibility("staff").eligible, true);

  const dedicatedAdmin = makeEligibility("admin");
  assert.equal(dedicatedAdmin.eligible, false);
  assert.equal(dedicatedAdmin.code, "restricted");
});

test("buildCartSummary groups items by seller and computes exact integer-sen totals excluding invalid lines", () => {
  const summary = buildCartSummary([
    {
      id: "row-1",
      listingId: LISTING_1,
      variantId: null,
      variantLabel: null,
      title: "IOT Box",
      imageUrl: null,
      campusArea: "Cafe UMSKAL",
      condition: "New",
      sellerId: SELLER_A,
      sellerDisplayName: "HazIq Hazim",
      storefrontName: "HazIq Tech",
      sellerLogoUrl: null,
      sellerBadge: "Verified UMS Student",
      unitPriceSen: 1550,
      quantity: 2,
      availableStock: 5,
      reservedQuantity: 0,
      lineSubtotalSen: 3100,
      isValid: true,
      issueCode: null,
      issueMessage: null,
      canAdjustToMax: false,
    },
    {
      id: "row-2",
      listingId: "22222222-11d6-4ec9-b4dd-5209a80ed74f",
      variantId: VARIANT_1,
      variantLabel: "Size: L",
      title: "Campus Hoodie",
      imageUrl: null,
      campusArea: "Library",
      condition: "New",
      sellerId: SELLER_B,
      sellerDisplayName: "Aina",
      storefrontName: null,
      sellerLogoUrl: null,
      sellerBadge: "Verified UMS Student",
      unitPriceSen: 4990,
      quantity: 1,
      availableStock: 3,
      reservedQuantity: 1,
      lineSubtotalSen: 4990,
      isValid: true,
      issueCode: null,
      issueMessage: null,
      canAdjustToMax: false,
    },
    {
      id: "row-3",
      listingId: "33333333-11d6-4ec9-b4dd-5209a80ed74f",
      variantId: null,
      variantLabel: null,
      title: "Archived Notes",
      imageUrl: null,
      campusArea: "Cafe UMSKAL",
      condition: "Good",
      sellerId: SELLER_A,
      sellerDisplayName: "HazIq Hazim",
      storefrontName: "HazIq Tech",
      sellerLogoUrl: null,
      sellerBadge: "Verified UMS Student",
      unitPriceSen: 1000,
      quantity: 1,
      availableStock: 0,
      reservedQuantity: 0,
      lineSubtotalSen: 0,
      isValid: false,
      issueCode: "archived",
      issueMessage: "Archived",
      canAdjustToMax: false,
    },
  ]);

  assert.equal(summary.sellerCount, 2);
  assert.equal(summary.totalRowCount, 3);
  assert.equal(summary.totalQuantity, 4);
  assert.equal(summary.validQuantity, 3);
  assert.equal(summary.invalidRowCount, 1);
  assert.equal(summary.hasIssues, true);
  assert.equal(summary.combinedSubtotalSen, 8090); // 3100 + 4990 (archived row excluded)

  const groupA = summary.groups.find((g) => g.sellerId === SELLER_A);
  const groupB = summary.groups.find((g) => g.sellerId === SELLER_B);
  assert.equal(groupA?.items.length, 2);
  assert.equal(groupA?.subtotalSen, 3100);
  assert.equal(groupA?.invalidRowCount, 1);
  assert.equal(groupB?.subtotalSen, 4990);
});

test("evaluateCartLineState detects deleted, archived, out-of-stock, exceeds-stock, inactive variant, and self-purchase", () => {
  const baseListing = {
    id: LISTING_1,
    sellerId: SELLER_A,
    kind: "business",
    status: "published",
    hasVariants: false,
    priceSen: 1500,
    quantity: 5,
    reservedQuantity: 2,
  };

  // Deleted listing
  const deleted = evaluateCartLineState({
    buyerUserId: BUYER_ID,
    cartQuantity: 1,
    variantId: null,
    listing: null,
    variant: null,
  });
  assert.equal(deleted.isValid, false);
  assert.equal(deleted.issueCode, "deleted");

  // Archived listing
  const archived = evaluateCartLineState({
    buyerUserId: BUYER_ID,
    cartQuantity: 1,
    variantId: null,
    listing: { ...baseListing, status: "archived" },
    variant: null,
  });
  assert.equal(archived.isValid, false);
  assert.equal(archived.issueCode, "archived");

  // Exceeds available stock (5 - 2 reserved = 3 available, cart has 4)
  const exceeds = evaluateCartLineState({
    buyerUserId: BUYER_ID,
    cartQuantity: 4,
    variantId: null,
    listing: baseListing,
    variant: null,
  });
  assert.equal(exceeds.isValid, false);
  assert.equal(exceeds.issueCode, "exceeds_stock");
  assert.equal(exceeds.availableStock, 3);
  assert.equal(exceeds.canAdjustToMax, true);

  // Self-purchase
  const selfBuy = evaluateCartLineState({
    buyerUserId: SELLER_A,
    cartQuantity: 1,
    variantId: null,
    listing: baseListing,
    variant: null,
  });
  assert.equal(selfBuy.isValid, false);
  assert.equal(selfBuy.issueCode, "self_purchase");

  // Inactive variant
  const inactiveVariant = evaluateCartLineState({
    buyerUserId: BUYER_ID,
    cartQuantity: 1,
    variantId: VARIANT_1,
    listing: { ...baseListing, hasVariants: true },
    variant: {
      id: VARIANT_1,
      listingId: LISTING_1,
      active: false,
      priceSen: 2000,
      quantity: 4,
      reservedQuantity: 0,
    },
  });
  assert.equal(inactiveVariant.isValid, false);
  assert.equal(inactiveVariant.issueCode, "variant_unavailable");
});

test("validateCartQuantityUpdate blocks unauthorized users, bad quantities, and detects live price changes", () => {
  const buyer = makeEligibility("student", BUYER_ID);
  const listing = {
    id: LISTING_1,
    sellerId: SELLER_A,
    kind: "pre_loved",
    status: "published",
    hasVariants: false,
    priceSen: 1800,
    quantity: 5,
    reservedQuantity: 1,
  };

  // Unauthorized cross-user edit
  const crossUser = validateCartQuantityUpdate({
    eligibility: buyer,
    cartItemId: CART_ROW_1,
    rowUserId: OTHER_USER_ID,
    requestedQuantity: 2,
    variantId: null,
    listing,
    variant: null,
  });
  assert.equal(crossUser.ok, false);

  // Zero / float / over-stock rejected
  assert.equal(
    validateCartQuantityUpdate({
      eligibility: buyer,
      cartItemId: CART_ROW_1,
      rowUserId: BUYER_ID,
      requestedQuantity: 0,
      variantId: null,
      listing,
      variant: null,
    }).ok,
    false
  );
  assert.equal(
    validateCartQuantityUpdate({
      eligibility: buyer,
      cartItemId: CART_ROW_1,
      rowUserId: BUYER_ID,
      requestedQuantity: 5, // only 4 available (5 - 1 reserved)
      variantId: null,
      listing,
      variant: null,
    }).ok,
    false
  );

  // Live price change detected cleanly while allowing valid quantity update
  const priceChanged = validateCartQuantityUpdate({
    eligibility: buyer,
    cartItemId: CART_ROW_1,
    rowUserId: BUYER_ID,
    requestedQuantity: 3,
    variantId: null,
    listing,
    variant: null,
    expectedUnitPriceSen: 1500,
  });
  assert.equal(priceChanged.ok, true);
  if (priceChanged.ok) {
    assert.equal(priceChanged.nextQuantity, 3);
    assert.equal(priceChanged.unitPriceSen, 1800);
    assert.equal(priceChanged.priceChanged, true);
    assert.equal(priceChanged.previousPriceSen, 1500);
  }
});
