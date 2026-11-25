import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_SERVICE_ATTACHMENT_BYTES,
  buildStagedServiceAttachmentPath,
  buildUniqueServiceFileName,
  detectServiceAttachmentMagicMime,
  isBuyerOwnedStagedServicePath,
  isValidStagedServicePath,
  isValidValidatedServicePath,
  validateClientServiceFileSelection,
} from "../src/lib/orders/service-attachments.ts";
import { validateAddToCartRequest } from "../src/lib/buyer/validation.ts";
import { evaluateCartLineState } from "../src/lib/buyer/cart.ts";
import { filterCartSummaryByIds } from "../src/lib/buyer/checkout.ts";
import {
  computeAdminPlatformAnalytics,
  computeSellerAnalytics,
  resolveAnalyticsWindow,
} from "../src/lib/analytics/metrics.ts";

const BUYER_ID = "11111111-1111-4111-8111-111111111111";
const SELLER_ID = "22222222-2222-4222-8222-222222222222";
const LISTING_ID = "33333333-3333-4333-8333-333333333333";
const CART_ITEM_ID = "44444444-4444-4444-8444-444444444444";

test("detectServiceAttachmentMagicMime detects JPEG, PNG, WebP, PDF and rejects spoofed bytes", () => {
  assert.equal(
    detectServiceAttachmentMagicMime(
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])
    ),
    "image/jpeg"
  );
  assert.equal(
    detectServiceAttachmentMagicMime(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
    ),
    "image/png"
  );
  assert.equal(
    detectServiceAttachmentMagicMime(
      new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
      ])
    ),
    "image/webp"
  );
  assert.equal(
    detectServiceAttachmentMagicMime(
      new TextEncoder().encode("%PDF-1.7\n1 0 obj\n")
    ),
    "application/pdf"
  );
  assert.equal(
    detectServiceAttachmentMagicMime(
      new TextEncoder().encode("<html><script>alert(1)</script></html>")
    ),
    null
  );
  assert.equal(detectServiceAttachmentMagicMime(new Uint8Array([0xff, 0xd8])), null);
});

test("staged and validated path validators enforce buyer + cart item scoping and block traversal", () => {
  const uniqueName = buildUniqueServiceFileName("Poster Brief (Final).pdf", "pdf", "abcd1234");
  const staged = buildStagedServiceAttachmentPath(BUYER_ID, CART_ITEM_ID, uniqueName);
  assert.equal(isValidStagedServicePath(staged, BUYER_ID, CART_ITEM_ID), true);
  assert.equal(isValidStagedServicePath(staged, SELLER_ID, CART_ITEM_ID), false);
  assert.equal(
    isValidStagedServicePath(`${BUYER_ID}/staged/${CART_ITEM_ID}/../evil.pdf`, BUYER_ID, CART_ITEM_ID),
    false
  );

  const validated = `${BUYER_ID}/validated/${CART_ITEM_ID}/${uniqueName}`;
  assert.equal(isValidValidatedServicePath(validated, BUYER_ID, CART_ITEM_ID), true);
  assert.equal(isValidValidatedServicePath(staged, BUYER_ID, CART_ITEM_ID), false);
  // Staged-only DELETE guard must allow staged/ and strictly reject validated/
  assert.equal(isBuyerOwnedStagedServicePath(staged, BUYER_ID), true);
  assert.equal(isBuyerOwnedStagedServicePath(validated, BUYER_ID), false);
  assert.equal(isBuyerOwnedStagedServicePath(staged, SELLER_ID), false);
});

test("validateClientServiceFileSelection enforces 5 MB limit and MIME/extension allowlist", () => {
  assert.equal(
    validateClientServiceFileSelection({
      name: "brief.pdf",
      size: 1024,
      type: "application/pdf",
    }).ok,
    true
  );
  assert.equal(
    validateClientServiceFileSelection({
      name: "huge.pdf",
      size: MAX_SERVICE_ATTACHMENT_BYTES + 1,
      type: "application/pdf",
    }).ok,
    false
  );
  assert.equal(
    validateClientServiceFileSelection({
      name: "malware.exe",
      size: 1024,
      type: "application/octet-stream",
    }).ok,
    false
  );
});

test("service listings support cart add & quantity 1..99 when active and block when paused", () => {
  const activeRes = validateAddToCartRequest({
    eligibility: {
      eligible: true,
      code: "ok",
      reason: "",
      userId: BUYER_ID,
      role: "student",
    },
    listingId: LISTING_ID,
    sellerId: SELLER_ID,
    kind: "service",
    status: "published",
    hasVariants: false,
    listingQuantity: 0,
    listingReservedQuantity: 0,
    variantId: null,
    selectedVariant: null,
    requestedQuantity: 3,
    existingCartQuantity: 0,
    acceptingRequests: true,
  });
  assert.equal(activeRes.ok, true);
  if (activeRes.ok) {
    assert.equal(activeRes.nextQuantity, 3);
    assert.equal(activeRes.availableStock, 99);
  }

  const pausedRes = validateAddToCartRequest({
    eligibility: {
      eligible: true,
      code: "ok",
      reason: "",
      userId: BUYER_ID,
      role: "student",
    },
    listingId: LISTING_ID,
    sellerId: SELLER_ID,
    kind: "service",
    status: "published",
    hasVariants: false,
    listingQuantity: 0,
    listingReservedQuantity: 0,
    variantId: null,
    selectedVariant: null,
    requestedQuantity: 1,
    existingCartQuantity: 0,
    acceptingRequests: false,
  });
  assert.equal(pausedRes.ok, false);

  const pausedLine = evaluateCartLineState({
    buyerUserId: BUYER_ID,
    cartQuantity: 2,
    variantId: null,
    listing: {
      id: LISTING_ID,
      sellerId: SELLER_ID,
      kind: "service",
      status: "published",
      hasVariants: false,
      priceSen: 1500,
      quantity: 0,
      reservedQuantity: 0,
      acceptingRequests: false,
    },
    variant: null,
  });
  assert.equal(pausedLine.isValid, false);
  assert.equal(pausedLine.issueCode, "service_paused");
});

test("seller & admin analytics include paid service orders without double-counting or leaking into student business", () => {
  const nowIso = new Date().toISOString();
  const win = resolveAnalyticsWindow("30d");
  const dataset = {
    profiles: [
      { id: BUYER_ID, university_role: "student", status: "active", faculty: "FKAL", created_at: nowIso, last_active_at: nowIso },
      { id: SELLER_ID, university_role: "student", status: "active", faculty: "FKAL", created_at: nowIso, last_active_at: nowIso },
    ],
    listings: [
      { id: LISTING_ID, seller_id: SELLER_ID, title: "Poster Design", kind: "service", category_id: "design", is_food: false, has_variants: false, quantity: 0, reserved_quantity: 0, status: "published", created_at: nowIso },
    ],
    orders: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        buyer_id: BUYER_ID,
        seller_id: SELLER_ID,
        checkout_session_id: "66666666-6666-4666-8666-666666666666",
        subtotal_sen: 4500,
        commission_sen: 90,
        seller_net_sen: 4410,
        status: "completed",
        paid_at: nowIso,
        completed_at: nowIso,
        created_at: nowIso,
      },
    ],
    orderItems: [
      {
        order_id: "55555555-5555-4555-8555-555555555555",
        listing_id: LISTING_ID,
        title_snapshot: "Poster Design",
        unit_sen: 1500,
        quantity: 3,
        is_service: true,
      },
    ],
    checkoutSessions: [
      { id: "66666666-6666-4666-8666-666666666666", buyer_id: BUYER_ID, status: "paid", payment_status: "paid", paid_at: nowIso },
    ],
    legacyPayments: [],
    refunds: [],
    views: [],
    favourites: [],
    serviceRequests: [],
    freeNotices: [],
    freeClaims: [],
    reviews: [],
    reports: [],
    disputes: [],
  };

  const sellerStats = computeSellerAnalytics(SELLER_ID, dataset, win);
  assert.equal(sellerStats.kpis.grossSalesSen, 4500);
  assert.equal(sellerStats.kpis.netCommissionSen, 90);
  assert.equal(sellerStats.kpis.netSellerEarningsSen, 4410);
  assert.equal(sellerStats.kpis.completedOrders, 1);
  assert.equal(sellerStats.kpis.serviceRequests, 1);
  assert.equal(sellerStats.kpis.completedServices, 1);

  const adminStats = computeAdminPlatformAnalytics(dataset, win);
  assert.equal(adminStats.overview.grossProductSalesSen, 4500);
  assert.equal(adminStats.overview.netPlatformCommissionSen, 90);
  assert.equal(adminStats.overview.completedOrders, 1);
  assert.equal(adminStats.overview.completedServices, 1);
  assert.equal(adminStats.services.totalRequests, 1);
  // Preserves student entrepreneurship strictly as kind === 'business'
  assert.equal(adminStats.entrepreneurship.completedStudentBusinessOrders, 0);
  assert.equal(adminStats.entrepreneurship.studentBusinessSalesSen, 0);
});

test("filterCartSummaryByIds keeps only ticked items and recomputes seller subtotals cleanly", () => {
  const summary = {
    groups: [
      {
        sellerId: SELLER_ID,
        sellerName: "Shop A",
        sellerSubtext: null,
        sellerLogoUrl: null,
        sellerBadge: "Student",
        validQuantity: 3,
        invalidRowCount: 0,
        subtotalSen: 4500,
        items: [
          { id: "item-1", quantity: 1, lineSubtotalSen: 1500, isValid: true },
          { id: "item-2", quantity: 2, lineSubtotalSen: 3000, isValid: true },
        ],
      },
    ],
    sellerCount: 1,
    totalRowCount: 2,
    validRowCount: 2,
    invalidRowCount: 0,
    totalQuantity: 3,
    validQuantity: 3,
    combinedSubtotalSen: 4500,
    hasIssues: false,
  };

  const filtered = filterCartSummaryByIds(summary, ["item-1"]);
  assert.equal(filtered.sellerCount, 1);
  assert.equal(filtered.totalRowCount, 1);
  assert.equal(filtered.validQuantity, 1);
  assert.equal(filtered.combinedSubtotalSen, 1500);
  assert.equal(filtered.groups[0].items.length, 1);
  assert.equal(filtered.groups[0].subtotalSen, 1500);
});
