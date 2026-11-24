import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { formatCurrencySen, formatSenToRm } from "../src/lib/format.ts";
import {
  REPORT_REASONS,
  computeCommunityImpact,
  computeFreeAvailableQuantity,
  computeRatingSummary,
  getAllowedFreeClaimActions,
  getAllowedServiceActions,
  validateFreeNoticeInput,
  validateReviewInput,
  validateServiceRequestInput,
} from "../src/lib/marketplace/phase8.ts";
import {
  buildAnalyticsCsv,
  computeAdminPlatformAnalytics,
  computeGrowthPct,
  computeSellerAnalytics,
  resolveAnalyticsWindow,
  sanitizeCsvCell,
} from "../src/lib/analytics/metrics.ts";

const ROOT = process.cwd();
const SQL = fs.readFileSync(
  path.join(ROOT, "docs/sql/phase-7-9-marketplace-completion.sql"),
  "utf8"
);

// 1. Section 18.1 — Financial currency formatting vs Free-item price formatting
test("Section 18.1: formatCurrencySen displays RM 0.00 for zero while formatSenToRm keeps FREE", () => {
  assert.equal(formatCurrencySen(0), "RM 0.00");
  assert.equal(formatCurrencySen(1470), "RM 14.70");
  assert.equal(formatCurrencySen(-500), "-RM 5.00");
  assert.equal(formatSenToRm(0), "FREE");
  assert.equal(formatSenToRm(1500), "RM 15.00");
});

// 2. Phase 8A — Services validation & role-gated transitions
test("Phase 8A: service request validation and role-specific lifecycle transitions", () => {
  assert.equal(
    validateServiceRequestInput({
      mode: "in_person",
      requirements: "Need 20 color-printed assignment pages bound before 4 PM.",
      preferredDate: "Tomorrow 3 PM",
    }).ok,
    true
  );
  assert.equal(
    validateServiceRequestInput({ mode: "invalid", requirements: "Valid length text here." }).ok,
    false
  );
  assert.equal(
    validateServiceRequestInput({ mode: "remote", requirements: "Too short" }).ok,
    false
  );

  // Buyer cannot accept or deliver; only buyer can confirm completion!
  assert.deepEqual(getAllowedServiceActions("requested", "seller"), ["accept", "decline"]);
  assert.deepEqual(getAllowedServiceActions("requested", "buyer"), ["cancel"]);
  assert.deepEqual(getAllowedServiceActions("delivered", "seller"), []);
  assert.deepEqual(getAllowedServiceActions("delivered", "buyer"), ["complete"]);
});

// 3. Phase 8B — Free items, atomic quantity math & Community Impact
test("Phase 8B: free item validation, available qty, claim transitions, and completed-only community impact", () => {
  assert.equal(
    validateFreeNoticeInput({
      title: "Calculus 2 Textbook",
      description: "Clean textbook with highlighted notes for UMSKAL students.",
      condition: "Good / Usable",
      quantity: 2,
      spotId: "blok-alpha",
      imagePaths: [],
    }).ok,
    true
  );
  assert.equal(
    validateFreeNoticeInput({
      title: "A",
      description: "short",
      condition: "",
      quantity: 0,
      spotId: "",
      imagePaths: [],
    }).ok,
    false
  );

  assert.equal(computeFreeAvailableQuantity(3, 1), 2);
  assert.equal(computeFreeAvailableQuantity(1, 5), 0);

  assert.deepEqual(getAllowedFreeClaimActions("requested", "donor"), ["accept", "decline"]);
  assert.deepEqual(getAllowedFreeClaimActions("reserved", "donor"), ["handover", "cancel"]);
  assert.deepEqual(getAllowedFreeClaimActions("handed_over", "recipient"), ["collect"]);
  assert.deepEqual(getAllowedFreeClaimActions("handed_over", "donor"), []);

  // Community impact MUST NOT count merely posted or requested items as completed donations!
  const impact = computeCommunityImpact({
    notices: [
      { id: "n1", status: "published", spot_id: "blok-alpha" },
      { id: "n2", status: "claimed", spot_id: "blok-beta" },
      { id: "n3", status: "draft", spot_id: "blok-alpha" },
    ],
    claims: [
      { notice_id: "n1", donor_id: "d1", recipient_id: "r1", quantity: 1, status: "requested" },
      { notice_id: "n1", donor_id: "d1", recipient_id: "r2", quantity: 1, status: "reserved" },
      { notice_id: "n2", donor_id: "d1", recipient_id: "r3", quantity: 2, status: "collected" },
    ],
  });
  assert.equal(impact.publishedFreeItems, 2);
  assert.equal(impact.completedDonations, 1);
  assert.equal(impact.totalUnitsDonated, 2);
  assert.equal(impact.activeDonors, 1);
  assert.equal(impact.uniqueRecipients, 1);
  assert.equal(impact.topSpots[0]?.spotId, "blok-beta");
});

// 4. Phase 8D — Verified Reviews & Zero-Review Rating Safety
test("Phase 8D: rating aggregation excludes hidden reviews and never returns 5.0 for zero reviews", () => {
  const empty = computeRatingSummary([]);
  assert.equal(empty.averageRating, null);
  assert.equal(empty.totalReviews, 0);

  const summary = computeRatingSummary([
    { rating: 5, hidden: false },
    { rating: 4, hidden: false },
    { rating: 1, hidden: true }, // moderated hidden review excluded
  ]);
  assert.equal(summary.totalReviews, 2);
  assert.equal(summary.averageRating, 4.5);
  assert.equal(summary.distribution[5], 1);
  assert.equal(summary.distribution[4], 1);
  assert.equal(summary.distribution[1], 0);

  assert.equal(validateReviewInput({ rating: 5, comment: "Fast campus handover!" }).ok, true);
  assert.equal(validateReviewInput({ rating: 6, comment: "Invalid stars" }).ok, false);
  assert.equal(validateReviewInput({ rating: 4, comment: "Hi" }).ok, false);
});

// 5. Phase 8E & 9A — Seller Analytics, Admin Platform Analytics & Student Entrepreneurship Insights
test("Phase 8E/9A: fixture-verified seller/admin analytics, entrepreneurship cohorts, zero-denom growth & CSV sanitization", () => {
  const nowMs = Date.parse("2026-11-24T12:00:00Z");
  const win30 = resolveAnalyticsWindow("30d", nowMs);
  assert.equal(computeGrowthPct(1000, 0), null, "Zero previous period must yield null (N/A)");
  assert.equal(computeGrowthPct(1500, 1000), 50);

  const dataset = {
    profiles: [
      { id: "stu-biz", university_role: "student", status: "active", created_at: "2026-11-01T00:00:00Z", last_active_at: "2026-11-24T01:00:00Z" },
      { id: "stu-pre", university_role: "student", status: "active", created_at: "2026-11-02T00:00:00Z", last_active_at: null },
      { id: "staff-1", university_role: "staff", status: "active", created_at: "2026-11-03T00:00:00Z", last_active_at: null },
      { id: "stu-idle", university_role: "student", status: "active", created_at: "2026-10-01T00:00:00Z", last_active_at: null },
    ],
    listings: [
      { id: "l-biz", seller_id: "stu-biz", title: "Homemade Brownies", kind: "business", category_id: "food", is_food: true, quantity: 10, reserved_quantity: 0, status: "published", created_at: "2026-11-05T00:00:00Z" },
      { id: "l-pre", seller_id: "stu-pre", title: "Used Calculator", kind: "pre_loved", category_id: "electronics", is_food: false, quantity: 1, reserved_quantity: 0, status: "published", created_at: "2026-11-06T00:00:00Z" },
      { id: "l-svc", seller_id: "stu-biz", title: "Thesis Formatting", kind: "service", category_id: "printing-errands", is_food: false, quantity: 1, reserved_quantity: 0, status: "published", created_at: "2026-11-07T00:00:00Z" },
    ],
    orders: [
      { id: "o-biz", buyer_id: "staff-1", seller_id: "stu-biz", checkout_session_id: "cs-1", subtotal_sen: 2000, commission_sen: 40, seller_net_sen: 1960, status: "completed", paid_at: "2026-11-20T00:00:00Z", completed_at: "2026-11-21T00:00:00Z", created_at: "2026-11-20T00:00:00Z" },
      { id: "o-pre", buyer_id: "staff-1", seller_id: "stu-pre", checkout_session_id: "cs-1", subtotal_sen: 1500, commission_sen: 30, seller_net_sen: 1470, status: "completed", paid_at: "2026-11-20T00:00:00Z", completed_at: "2026-11-21T00:00:00Z", created_at: "2026-11-20T00:00:00Z" },
      // Unverified order MUST be excluded from all sales metrics!
      { id: "o-unver", buyer_id: "staff-1", seller_id: "stu-biz", checkout_session_id: null, subtotal_sen: 9900, commission_sen: 198, seller_net_sen: 9702, status: "completed", paid_at: "2026-11-20T00:00:00Z", completed_at: "2026-11-21T00:00:00Z", created_at: "2026-11-20T00:00:00Z" },
    ],
    orderItems: [
      { order_id: "o-biz", listing_id: "l-biz", title_snapshot: "Homemade Brownies", unit_sen: 1000, quantity: 2 },
      { order_id: "o-pre", listing_id: "l-pre", title_snapshot: "Used Calculator", unit_sen: 1500, quantity: 1 },
      { order_id: "o-unver", listing_id: "l-biz", title_snapshot: "Fake Unverified", unit_sen: 9900, quantity: 1 },
    ],
    checkoutSessions: [
      { id: "cs-1", buyer_id: "staff-1", status: "paid", payment_status: "paid", paid_at: "2026-11-20T00:00:00Z" },
    ],
    legacyPayments: [],
    refunds: [
      { order_id: "o-biz", refund_type: "partial_refund", refund_amount_sen: 500, commission_reversal_sen: 10, seller_deduction_sen: 490, status: "succeeded" },
    ],
    views: [
      { viewer_id: "staff-1", listing_id: "l-biz", viewed_at: "2026-11-19T00:00:00Z" },
      { viewer_id: "stu-pre", listing_id: "l-biz", viewed_at: "2026-11-19T01:00:00Z" },
    ],
    favourites: [{ user_id: "staff-1", listing_id: "l-biz", created_at: "2026-11-19T00:00:00Z" }],
    serviceRequests: [
      { id: "sr-1", listing_id: "l-svc", buyer_id: "staff-1", seller_id: "stu-biz", status: "completed", created_at: "2026-11-22T00:00:00Z", completed_at: "2026-11-23T00:00:00Z" },
    ],
    freeNotices: [{ id: "fn-1", contributor_id: "stu-pre", status: "claimed", spot_id: "blok-alpha", created_at: "2026-11-15T00:00:00Z" }],
    freeClaims: [{ notice_id: "fn-1", donor_id: "stu-pre", recipient_id: "staff-1", quantity: 1, status: "collected", collected_at: "2026-11-16T00:00:00Z", created_at: "2026-11-15T00:00:00Z" }],
    reviews: [{ id: "rev-1", listing_id: "l-biz", seller_id: "stu-biz", rating: 5, hidden: false, created_at: "2026-11-22T00:00:00Z" }],
    reports: [{ id: "rpt-1", reason: "Spam", status: "open", created_at: "2026-11-23T00:00:00Z" }],
    disputes: [],
  };

  // Seller analytics isolated to stu-biz (excludes o-pre and unverified o-unver!)
  const sellerAn = computeSellerAnalytics("stu-biz", dataset, win30);
  assert.equal(sellerAn.kpis.grossSalesSen, 2000);
  assert.equal(sellerAn.kpis.executedRefundsSen, 500);
  assert.equal(sellerAn.kpis.netSalesSen, 1500);
  assert.equal(sellerAn.kpis.netSellerEarningsSen, 1470);
  assert.equal(sellerAn.kpis.netCommissionSen, 30);
  assert.equal(sellerAn.kpis.completedServices, 1);
  assert.equal(sellerAn.kpis.averageRating, 5);
  assert.equal(sellerAn.listingPerformance.find((l) => l.id === "l-biz")?.conversionPct, 50); // 1 order / 2 unique viewers

  // Admin platform analytics & distinct Student Entrepreneurship cohorts
  const adminAn = computeAdminPlatformAnalytics(dataset, win30);
  assert.equal(adminAn.overview.totalMembers, 4);
  assert.equal(adminAn.overview.measuredActiveUsers, 3, "Idle active-status account must NOT be counted as measured active user");
  assert.equal(adminAn.overview.grossProductSalesSen, 3500);
  assert.equal(adminAn.overview.netProductSalesSen, 3000);
  assert.equal(adminAn.overview.netPlatformCommissionSen, 60);
  assert.equal(adminAn.entrepreneurship.activeStudentBusinessSellers, 1, "Pre-loved seller must NOT be counted as student business seller");
  assert.equal(adminAn.entrepreneurship.preLovedSellersCount, 1);
  assert.equal(adminAn.entrepreneurship.preLovedCompletedTransactions, 1);
  assert.equal(adminAn.entrepreneurship.studentBusinessSalesSen, 1500);
  assert.equal(adminAn.entrepreneurship.repeatBuyers, 1);
  assert.equal(adminAn.community.completedDonations, 1);

  // Formula-injection neutralization in CSV exports
  assert.equal(sanitizeCsvCell("=CMD|' /C calc'!A0"), "'=CMD|' /C calc'!A0");
  assert.equal(sanitizeCsvCell("+1+1"), "'+1+1");
  const csv = buildAnalyticsCsv([{ period: "30d", section: "Sales", metric: "@Inject", value: "RM 30.00" }]);
  assert.match(csv, /'@Inject/);
  assert.ok(REPORT_REASONS.includes("Scam or suspicious activity"));
});

// 6. Consolidated Phase 7-9 SQL Invariants
test("Phase 7-9 SQL: explicit service_role grants, blocking enforcement, audit logs & Realtime privacy", () => {
  assert.match(SQL, /GRANT ALL ON TABLE public\.free_notice_claims TO service_role;/);
  assert.match(SQL, /GRANT ALL ON TABLE public\.service_requests TO service_role;/);
  assert.match(SQL, /GRANT ALL ON TABLE public\.reviews TO service_role;/);
  assert.match(SQL, /GRANT ALL ON TABLE public\.reports TO service_role;/);
  assert.match(SQL, /GRANT ALL ON TABLE public\.member_blocks TO service_role;/);
  assert.match(SQL, /GRANT ALL ON TABLE public\.admin_audit_logs TO service_role;/);
  assert.match(SQL, /FUNCTION public\.is_blocked_between/);
  assert.match(SQL, /FUNCTION public\.record_listing_view_atomic/);
  assert.match(SQL, /FUNCTION public\.create_service_request_atomic/);
  assert.match(SQL, /FUNCTION public\.create_free_notice_claim_atomic/);
  assert.match(SQL, /FUNCTION public\.update_free_notice_claim_atomic/);
  assert.match(SQL, /FUNCTION public\.submit_verified_review_atomic/);
  assert.match(SQL, /FUNCTION public\.submit_report_atomic/);
  assert.match(SQL, /FUNCTION public\.admin_moderate_user_atomic/);
  assert.match(SQL, /idx_free_notice_claims_active_unique/);
  assert.match(SQL, /idx_reviews_one_per_order_listing/);
  assert.match(SQL, /idx_reviews_one_per_service_request/);
  assert.match(SQL, /idx_reports_one_open_per_reporter_target/);
});
