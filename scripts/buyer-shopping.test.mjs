import assert from "node:assert/strict";
import test from "node:test";
import {
  computeAvailableStock,
  evaluateBuyerEligibility,
  validateAddToCartRequest,
  validateFavouriteToggle,
} from "../src/lib/buyer/validation.ts";

const BUYER_ID = "17d414ce-8349-4dc2-bccd-94d9bd0ebc52";
const STAFF_ID = "1082a03e-c04c-4ae2-a162-c68d3a09b89c";
const SELLER_ID = "d3b398d8-9103-4bc2-84d3-6e0101b7659a";
const LISTING_ID = "2990db4c-11d6-4ec9-b4dd-5209a80ed74f";
const VARIANT_ID = "aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb";

function makeSession(overrides = {}) {
  return {
    isAuthenticated: true,
    isEmailVerified: true,
    isActiveMember: true,
    profile: {
      id: BUYER_ID,
      email: "examiner.buyer@iluv.ums.edu.my",
      university_role: "student",
      status: "active",
      restriction_reason: null,
      full_name: "Examiner Buyer",
      display_name: "Examiner Buyer",
      faculty: "FKI",
      bio: null,
      avatar_url: null,
      created_at: "2026-01-01T00:00:00Z",
    },
    ...overrides,
  };
}

test("evaluateBuyerEligibility allows active verified Students and Staff, blocks guests/unverified/suspended", () => {
  const student = evaluateBuyerEligibility(makeSession());
  assert.equal(student.eligible, true);
  assert.equal(student.userId, BUYER_ID);

  const staff = evaluateBuyerEligibility(
    makeSession({
      profile: {
        ...makeSession().profile,
        id: STAFF_ID,
        university_role: "staff",
      },
    })
  );
  assert.equal(staff.eligible, true);
  assert.equal(staff.userId, STAFF_ID);

  const guest = evaluateBuyerEligibility(
    makeSession({ isAuthenticated: false, profile: null })
  );
  assert.equal(guest.eligible, false);
  assert.equal(guest.code, "unauthenticated");

  const unverified = evaluateBuyerEligibility(
    makeSession({ isEmailVerified: false })
  );
  assert.equal(unverified.eligible, false);
  assert.equal(unverified.code, "unverified");

  const suspended = evaluateBuyerEligibility(
    makeSession({
      isActiveMember: false,
      profile: {
        ...makeSession().profile,
        status: "suspended",
        restriction_reason: "Pending review",
      },
    })
  );
  assert.equal(suspended.eligible, false);
  assert.equal(suspended.code, "restricted");
});

test("computeAvailableStock subtracts reserved stock and floors at zero", () => {
  assert.equal(computeAvailableStock(5, 2), 3);
  assert.equal(computeAvailableStock(2, 2), 0);
  assert.equal(computeAvailableStock(1, 4), 0);
  assert.equal(computeAvailableStock(0, 0), 0);
});

test("validateFavouriteToggle enforces ownership eligibility, published status on add, and allows removing archived", () => {
  const eligible = evaluateBuyerEligibility(makeSession());

  assert.equal(
    validateFavouriteToggle({
      eligibility: eligible,
      listingId: LISTING_ID,
      status: "published",
      currentlyFavourited: false,
    }).ok,
    true
  );

  // Adding a favourite on an archived listing is rejected
  const archivedAdd = validateFavouriteToggle({
    eligibility: eligible,
    listingId: LISTING_ID,
    status: "archived",
    currentlyFavourited: false,
  });
  assert.equal(archivedAdd.ok, false);

  // Removing an already-saved favourite on an archived listing is allowed
  const archivedRemove = validateFavouriteToggle({
    eligibility: eligible,
    listingId: LISTING_ID,
    status: "archived",
    currentlyFavourited: true,
  });
  assert.equal(archivedRemove.ok, true);

  // Demo and free notices are rejected
  assert.equal(
    validateFavouriteToggle({
      eligibility: eligible,
      listingId: LISTING_ID,
      isDemo: true,
      status: "published",
      currentlyFavourited: false,
    }).ok,
    false
  );
  assert.equal(
    validateFavouriteToggle({
      eligibility: eligible,
      listingId: LISTING_ID,
      isFreeNotice: true,
      status: "published",
      currentlyFavourited: false,
    }).ok,
    false
  );
});

test("validateAddToCartRequest blocks self-purchase, non-published, services, out-of-stock, and reserved stock overflow", () => {
  const buyer = evaluateBuyerEligibility(makeSession());
  const sellerAsBuyer = evaluateBuyerEligibility(
    makeSession({
      profile: { ...makeSession().profile, id: SELLER_ID },
    })
  );

  const base = {
    eligibility: buyer,
    listingId: LISTING_ID,
    sellerId: SELLER_ID,
    kind: "pre_loved",
    status: "published",
    hasVariants: false,
    listingQuantity: 5,
    listingReservedQuantity: 2,
    variantId: null,
    selectedVariant: null,
    requestedQuantity: 2,
    existingCartQuantity: 0,
  };

  // Happy path: 5 total - 2 reserved = 3 available, requesting 2 succeeds
  const ok = validateAddToCartRequest(base);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.nextQuantity, 2);
    assert.equal(ok.availableStock, 3);
    assert.equal(ok.merged, false);
  }

  // Self-purchase blocked
  const selfBuy = validateAddToCartRequest({
    ...base,
    eligibility: sellerAsBuyer,
  });
  assert.equal(selfBuy.ok, false);
  if (!selfBuy.ok) assert.match(selfBuy.error, /own listing/i);

  // Archived listing blocked
  const archived = validateAddToCartRequest({ ...base, status: "archived" });
  assert.equal(archived.ok, false);

  // Service listing blocked
  const service = validateAddToCartRequest({ ...base, kind: "service" });
  assert.equal(service.ok, false);

  // Out of stock (quantity 0 or all reserved) blocked
  const oos = validateAddToCartRequest({
    ...base,
    listingQuantity: 2,
    listingReservedQuantity: 2,
  });
  assert.equal(oos.ok, false);
  if (!oos.ok) assert.match(oos.error, /out of stock/i);

  // Duplicate-item merging respects remaining stock
  const mergeOk = validateAddToCartRequest({
    ...base,
    existingCartQuantity: 1,
    requestedQuantity: 2,
  });
  assert.equal(mergeOk.ok, true);
  if (mergeOk.ok) {
    assert.equal(mergeOk.nextQuantity, 3);
    assert.equal(mergeOk.merged, true);
  }

  // Merging beyond available stock (1 in cart + 3 requested > 3 available) blocked
  const mergeOverflow = validateAddToCartRequest({
    ...base,
    existingCartQuantity: 1,
    requestedQuantity: 3,
  });
  assert.equal(mergeOverflow.ok, false);
  if (!mergeOverflow.ok) assert.match(mergeOverflow.error, /Only 2 more available/i);
});

test("validateAddToCartRequest validates active variants and rejects invalid/inactive/stray variants", () => {
  const buyer = evaluateBuyerEligibility(makeSession());
  const activeVariant = {
    id: VARIANT_ID,
    listingId: LISTING_ID,
    active: true,
    quantity: 4,
    reservedQuantity: 1,
    priceSen: 2500,
  };

  const base = {
    eligibility: buyer,
    listingId: LISTING_ID,
    sellerId: SELLER_ID,
    kind: "business",
    status: "published",
    hasVariants: true,
    listingQuantity: 4,
    listingReservedQuantity: 1,
    variantId: VARIANT_ID,
    selectedVariant: activeVariant,
    requestedQuantity: 2,
    existingCartQuantity: 1,
  };

  // Valid variant merge: 1 existing + 2 requested = 3 <= 3 available
  const ok = validateAddToCartRequest(base);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.normalizedVariantId, VARIANT_ID);
    assert.equal(ok.nextQuantity, 3);
    assert.equal(ok.merged, true);
  }

  // Missing variant when hasVariants=true
  assert.equal(
    validateAddToCartRequest({
      ...base,
      variantId: null,
      selectedVariant: null,
    }).ok,
    false
  );

  // Inactive variant rejected
  assert.equal(
    validateAddToCartRequest({
      ...base,
      selectedVariant: { ...activeVariant, active: false },
    }).ok,
    false
  );

  // Variant belonging to another listing rejected
  assert.equal(
    validateAddToCartRequest({
      ...base,
      selectedVariant: {
        ...activeVariant,
        listingId: "cccccccc-1111-4222-8333-dddddddddddd",
      },
    }).ok,
    false
  );

  // Stray variantId on non-variant listing rejected
  assert.equal(
    validateAddToCartRequest({
      ...base,
      hasVariants: false,
      variantId: VARIANT_ID,
      selectedVariant: null,
    }).ok,
    false
  );
});
