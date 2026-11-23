import assert from "node:assert/strict";
import test from "node:test";
import { computeSellerFinancials } from "../src/lib/seller/financials.ts";
import {
  evaluateSellerEligibility,
  maskPayoutAccount,
  parseRmToSen,
  validateImageFileMeta,
  validateListingInput,
  validateStorefrontInput,
} from "../src/lib/seller/validation.ts";

function makeSession(overrides = {}) {
  return {
    isAuthenticated: true,
    userId: "user-123",
    email: "student@iluv.ums.edu.my",
    isEmailVerified: true,
    isActiveMember: true,
    isActiveAdmin: false,
    profile: {
      id: "user-123",
      display_name: "Test Student",
      full_name: "Test Student",
      university_role: "student",
      status: "active",
      faculty: "FKI",
    },
    source: "supabase",
    ...overrides,
  };
}

test("allows active, email-verified UMS student to sell", () => {
  const res = evaluateSellerEligibility(makeSession());
  assert.equal(res.eligible, true);
});

test("blocks UMS staff from selling", () => {
  const res = evaluateSellerEligibility(
    makeSession({
      email: "staff@ums.edu.my",
      profile: {
        id: "staff-1",
        display_name: "Staff Member",
        full_name: "Staff Member",
        university_role: "staff",
        status: "active",
        faculty: "FKI",
      },
    })
  );
  assert.equal(res.eligible, false);
  if (!res.eligible) assert.equal(res.reason, "staff_restricted");
});

test("admin privileges do NOT automatically grant selling access", () => {
  const res = evaluateSellerEligibility(
    makeSession({
      email: "buyu.platform@gmail.com",
      isActiveAdmin: true,
      profile: {
        id: "admin-1",
        display_name: "Platform Admin",
        full_name: "Platform Admin",
        university_role: "admin",
        status: "active",
        faculty: null,
      },
    })
  );
  assert.equal(res.eligible, false);
  if (!res.eligible) assert.equal(res.reason, "non_student_restricted");
});

test("blocks unverified email, inactive status, and guests", () => {
  const unverified = evaluateSellerEligibility(
    makeSession({ isEmailVerified: false })
  );
  assert.equal(unverified.eligible, false);
  if (!unverified.eligible) assert.equal(unverified.reason, "unverified_email");

  const suspended = evaluateSellerEligibility(
    makeSession({
      profile: {
        id: "u2",
        display_name: "Suspended",
        full_name: "Suspended",
        university_role: "student",
        status: "suspended",
        faculty: "FKI",
      },
    })
  );
  assert.equal(suspended.eligible, false);
  if (!suspended.eligible) assert.equal(suspended.reason, "inactive_account");

  const guest = evaluateSellerEligibility(
    makeSession({ isAuthenticated: false, userId: null, profile: null })
  );
  assert.equal(guest.eligible, false);
  if (!guest.eligible) assert.equal(guest.reason, "auth_required");
});

test("parseRmToSen converts exact Ringgit amounts without float drift", () => {
  assert.deepEqual(parseRmToSen("19.99"), { ok: true, sen: 1999 });
  assert.deepEqual(parseRmToSen("15"), { ok: true, sen: 1500 });
  assert.deepEqual(parseRmToSen("RM 7.5"), { ok: true, sen: 750 });
  assert.deepEqual(parseRmToSen("0.00"), { ok: true, sen: 0 });
  assert.equal(parseRmToSen("-5").ok, false);
  assert.equal(parseRmToSen("12.345").ok, false);
  assert.equal(parseRmToSen("999999").ok, false);
  assert.equal(parseRmToSen("abc").ok, false);
});

test("validateStorefrontInput enforces name bounds and trims whitespace", () => {
  const ok = validateStorefrontInput({
    shopName: "  Aina's Study Shop  ",
    description: "  Pre-loved textbooks and notes. ",
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.shopName, "Aina's Study Shop");
    assert.equal(ok.description, "Pre-loved textbooks and notes.");
  }
  assert.equal(
    validateStorefrontInput({ shopName: "A", description: "" }).ok,
    false
  );
});

test("validateListingInput enforces draft vs publish rules and maps food/service", () => {
  // Draft allowed without rules acknowledgement or collection area
  const draft = validateListingInput({
    title: "Casio Calculator",
    description: "",
    listingType: "preloved",
    categoryId: "electronics",
    priceRm: "45.00",
    quantity: 1,
    collectionAreaId: "",
    condition: "",
    status: "draft",
    rulesAcknowledged: false,
  });
  assert.equal(draft.ok, true);
  if (draft.ok) {
    assert.equal(draft.data.status, "draft");
    assert.equal(draft.data.priceSen, 4500);
  }

  // Publish blocked without rules acknowledgement
  const blockedPublish = validateListingInput({
    title: "Casio Calculator",
    description: "Used for one semester, works like new.",
    listingType: "preloved",
    categoryId: "electronics",
    priceRm: "45.00",
    quantity: 1,
    collectionAreaId: "cafe-umskal",
    condition: "Like New",
    status: "published",
    rulesAcknowledged: false,
  });
  assert.equal(blockedPublish.ok, false);

  // Publish food maps to dbKind="business" and isFood=true
  const food = validateListingInput({
    title: "Homemade Kek Batik",
    description: "Freshly baked every Friday at Kolej Kediaman Alpha.",
    listingType: "food",
    categoryId: "campus-food",
    priceRm: "8.50",
    quantity: 10,
    collectionAreaId: "kk-alpha",
    condition: "New/Unused",
    status: "published",
    rulesAcknowledged: true,
    allowOffers: false,
  });
  assert.equal(food.ok, true);
  if (food.ok) {
    assert.equal(food.data.dbKind, "business");
    assert.equal(food.data.isFood, true);
    assert.equal(food.data.priceSen, 850);
  }

  // Publish service does not require condition or collection area
  const service = validateListingInput({
    title: "Canva Poster Design",
    description: "Fast turnaround for UMS club events and presentations.",
    listingType: "service",
    categoryId: "design",
    priceRm: "20",
    quantity: 1,
    collectionAreaId: "",
    condition: "",
    status: "published",
    rulesAcknowledged: true,
  });
  assert.equal(service.ok, true);
  if (service.ok) {
    assert.equal(service.data.dbKind, "service");
    assert.equal(service.data.condition, null);
  }
});

test("maskPayoutAccount hides raw account numbers and DuitNow IDs", () => {
  const masked = maskPayoutAccount({
    bank_name: "Maybank",
    account_number: "162012345678",
    account_holder_name: "HazIq Hazim",
    duitnow_id: "0123456789",
    updated_at: "2026-11-23T00:00:00Z",
  });
  assert.equal(masked.configured, true);
  assert.equal(masked.maskedAccountNumber, "•••• 5678");
  assert.equal(masked.hasDuitNow, true);
  assert.equal(JSON.stringify(masked).includes("162012345678"), false);
  assert.equal(JSON.stringify(masked).includes("0123456789"), false);
});

test("validateImageFileMeta enforces MIME whitelist and 5MB cap", () => {
  assert.equal(
    validateImageFileMeta({ name: "item.jpg", type: "image/jpeg", size: 1024 }).ok,
    true
  );
  assert.equal(
    validateImageFileMeta({ name: "doc.pdf", type: "application/pdf", size: 1024 }).ok,
    false
  );
  assert.equal(
    validateImageFileMeta({ name: "huge.png", type: "image/png", size: 6 * 1024 * 1024 }).ok,
    false
  );
});

test("computeSellerFinancials excludes unpaid orders, deducts commissions/refunds/payouts accurately", () => {
  const now = new Date("2026-11-23T12:00:00Z");
  const result = computeSellerFinancials({
    now,
    range: "7d",
    orders: [
      {
        id: "o1",
        order_code: "BU-2611-0DB3",
        subtotal_sen: 1500,
        commission_sen: 30,
        seller_net_sen: 1470,
        total_paid_sen: 1600,
        status: "completed",
        paid_at: "2026-11-22T10:00:00Z",
        completed_at: "2026-11-22T11:00:00Z",
        created_at: "2026-11-22T09:50:00Z",
      },
      {
        id: "o2",
        order_code: "BU-2611-0DB4",
        subtotal_sen: 2500,
        commission_sen: 50,
        seller_net_sen: 2450,
        total_paid_sen: 2600,
        status: "paid",
        paid_at: "2026-11-23T08:00:00Z",
        completed_at: null,
        created_at: "2026-11-23T07:55:00Z",
      },
      {
        // Unpaid order must NEVER count toward sales or pending settlement
        id: "o3",
        order_code: "BU-2611-UNPD",
        subtotal_sen: 9900,
        commission_sen: 198,
        seller_net_sen: 9702,
        total_paid_sen: 10000,
        status: "pending_payment",
        paid_at: null,
        completed_at: null,
        created_at: "2026-11-23T09:00:00Z",
      },
    ],
    orderItems: [
      { order_id: "o1", title_snapshot: "IOT Box", quantity: 1 },
      { order_id: "o2", title_snapshot: "Study Notes", quantity: 2 },
    ],
    payments: [
      { order_id: "o1", status: "paid", verified_at: "2026-11-22T10:00:00Z" },
      { order_id: "o2", status: "paid", verified_at: "2026-11-23T08:00:00Z" },
    ],
    payoutRequests: [
      {
        id: "p1",
        amount_sen: 500,
        status: "paid",
        processed_at: "2026-11-23T06:00:00Z",
        created_at: "2026-11-23T05:00:00Z",
      },
    ],
    disputes: [],
  });

  assert.equal(result.available, true);
  assert.equal(result.totalSalesSen, 4000); // o1 (1500) + o2 (2500), excludes o3 (unpaid)
  assert.equal(result.pendingSettlementSen, 2450); // o2 net awaiting handover
  assert.equal(result.availableForPayoutSen, 970); // o1 net (1470) - paid payout (500)
  assert.equal(result.totalPaidOutSen, 500);
  assert.equal(result.verifiedOrderCount, 2);
  assert.equal(result.chartPoints.length, 7);
  assert.equal(
    result.chartPoints.reduce((sum, p) => sum + p.amountSen, 0),
    4000
  );
});
