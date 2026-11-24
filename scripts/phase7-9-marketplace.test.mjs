import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { formatCurrencySen, formatSenToRm } from "../src/lib/format.ts";
import {
  FREE_NOTICE_STATUSES,
  REPORT_REASONS,
  SERVICE_REQUEST_MODES,
  SERVICE_REQUEST_STATUSES,
  computeCommunityImpact,
  computeFreeAvailableQuantity,
  computeRatingSummary,
  getAllowedFreeClaimActions,
  getAllowedServiceActions,
  parsePreferredServiceTimestamp,
  validateFreeNoticeInput,
  validateReviewInput,
  validateServiceRequestInput,
} from "../src/lib/marketplace/phase8.ts";
import {
  buildAnalyticsCsv,
  computeAdminPlatformAnalytics,
  computeGrowthPct,
  computeSellerAnalytics,
  fetchAllPaginated,
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

// 2. P0.2 — Services timestamptz preferred_date, remote/in_person mode & expired status
test("P0.2: service request validation enforces remote/in_person mode, valid timestamptz & expired status", () => {
  assert.deepEqual([...SERVICE_REQUEST_MODES], ["in_person", "remote"]);
  assert.ok(SERVICE_REQUEST_STATUSES.includes("expired"));

  // Valid MYT datetime-local converts cleanly to UTC ISO-8601
  const tsOk = parsePreferredServiceTimestamp("2026-11-26T15:00");
  assert.equal(tsOk.ok, true);
  if (tsOk.ok) assert.equal(tsOk.iso, "2026-11-26T07:00:00.000Z");

  // Malformed text date MUST be rejected (not cast blindly into timestamptz!)
  assert.equal(parsePreferredServiceTimestamp("Tomorrow 3 PM").ok, false);
  assert.equal(
    validateServiceRequestInput({
      mode: "in_person",
      requirements: "Need 20 color-printed assignment pages bound before 4 PM.",
      preferredDate: "Tomorrow 3 PM",
    }).ok,
    false
  );

  // 'both' is valid on a service listing, NEVER on an individual request
  assert.equal(
    validateServiceRequestInput({
      mode: "both",
      requirements: "Need 20 color-printed assignment pages bound before 4 PM.",
    }).ok,
    false
  );

  // Mode mismatch against listing's allowed mode is rejected
  assert.equal(
    validateServiceRequestInput({
      mode: "remote",
      listingServiceMode: "in_person",
      requirements: "Need 20 color-printed assignment pages bound before 4 PM.",
    }).ok,
    false
  );

  // Valid request with ISO timestamptz passes
  const validReq = validateServiceRequestInput({
    mode: "in_person",
    listingServiceMode: "both",
    requirements: "Need 20 color-printed assignment pages bound before 4 PM.",
    preferredDate: "2026-11-26T15:00",
  });
  assert.equal(validReq.ok, true);
  if (validReq.ok) assert.equal(validReq.preferredDate, "2026-11-26T07:00:00.000Z");

  // Role-gated lifecycle actions
  assert.deepEqual(getAllowedServiceActions("requested", "seller"), ["accept", "decline"]);
  assert.deepEqual(getAllowedServiceActions("requested", "buyer"), ["cancel"]);
  assert.deepEqual(getAllowedServiceActions("delivered", "seller"), []);
  assert.deepEqual(getAllowedServiceActions("delivered", "buyer"), ["complete"]);
  assert.deepEqual(getAllowedServiceActions("expired", "buyer"), []);
});

// 3. P0.1 & P0.6 — Hosted free_notices status model (active/closed/hidden), 1-5 images & draft support
test("P0.1/P0.6: free item hosted constraints (active/closed/hidden, 1-5 images, relaxed drafts, completed-only impact)", () => {
  assert.deepEqual([...FREE_NOTICE_STATUSES], ["active", "closed", "hidden"]);

  // Publishing REQUIRES 1-5 images and title 5-100 + desc 10-2000
  assert.equal(
    validateFreeNoticeInput({
      title: "Calculus 2 Textbook",
      description: "Clean textbook with highlighted notes for UMSKAL students.",
      condition: "Good / Usable",
      quantity: 2,
      spotId: "blok-alpha",
      imagePaths: [],
      mode: "published",
    }).ok,
    false,
    "Publishing free item without photos must fail hosted image_paths constraint"
  );
  assert.equal(
    validateFreeNoticeInput({
      title: "Calculus 2 Textbook",
      description: "Clean textbook with highlighted notes for UMSKAL students.",
      condition: "Good / Usable",
      quantity: 2,
      spotId: "blok-alpha",
      imagePaths: ["u1/photo1.jpg"],
      mode: "published",
    }).ok,
    true
  );

  // Incomplete draft without photos or full description IS allowed in free_notice_drafts!
  assert.equal(
    validateFreeNoticeInput({
      title: "Calc",
      description: "",
      condition: "Good / Usable",
      quantity: 1,
      spotId: "",
      imagePaths: [],
      mode: "draft",
    }).ok,
    true
  );

  assert.equal(computeFreeAvailableQuantity(3, 1), 2);
  assert.equal(computeFreeAvailableQuantity(1, 5), 0);

  assert.deepEqual(getAllowedFreeClaimActions("requested", "donor"), ["accept", "decline"]);
  assert.deepEqual(getAllowedFreeClaimActions("reserved", "donor"), ["handover", "cancel"]);
  assert.deepEqual(getAllowedFreeClaimActions("handed_over", "recipient"), ["collect"]);
  assert.deepEqual(getAllowedFreeClaimActions("handed_over", "donor"), []);

  // Community impact uses hosted active/closed statuses and counts ONLY collected claims!
  const impact = computeCommunityImpact({
    notices: [
      { id: "n1", status: "active", spot_id: "blok-alpha" },
      { id: "n2", status: "closed", spot_id: "blok-beta" },
      { id: "n3", status: "hidden", spot_id: "blok-alpha" },
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

// 4. Phase 8D / P0.8 — Verified Reviews & Zero-Review Rating Safety
test("Phase 8D/P0.8: rating aggregation excludes hidden reviews and never returns 5.0 for zero reviews", () => {
  const empty = computeRatingSummary([]);
  assert.equal(empty.averageRating, null);
  assert.equal(empty.totalReviews, 0);

  const summary = computeRatingSummary([
    { rating: 5, hidden: false },
    { rating: 4, hidden: false },
    { rating: 1, hidden: true },
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

// 5. P0.9 — Bounded Conversion, Strict Business Cohort, First-Time Sellers, Proportional Multi-Item Refunds & Custom MYT Dates
test("P0.9: analytics conversion <=100%, strict business cohort, first-time sellers, multi-item refund attribution & submitted reports", () => {
  const nowMs = Date.parse("2026-11-24T12:00:00Z");
  const win30 = resolveAnalyticsWindow("30d", nowMs);
  assert.equal(computeGrowthPct(1000, 0), null, "Zero previous period must yield null (N/A)");
  assert.equal(computeGrowthPct(1500, 1000), 50);

  // Custom date range spans full MYT days
  const customWin = resolveAnalyticsWindow("custom", nowMs, "2026-11-20", "2026-11-21");
  assert.equal(customWin.key, "custom");
  assert.equal(customWin.startMs, Date.parse("2026-11-20T00:00:00+08:00"));
  assert.equal(customWin.endMs, Date.parse("2026-11-21T23:59:59.999+08:00"));

  const dataset = {
    profiles: [
      { id: "stu-biz", university_role: "student", status: "active", created_at: "2026-11-01T00:00:00Z", last_active_at: "2026-11-24T01:00:00Z" },
      { id: "stu-pre", university_role: "student", status: "active", created_at: "2026-11-02T00:00:00Z", last_active_at: null },
      { id: "staff-1", university_role: "staff", status: "active", created_at: "2026-11-03T00:00:00Z", last_active_at: null },
      { id: "stu-idle", university_role: "student", status: "active", created_at: "2026-10-01T00:00:00Z", last_active_at: null },
    ],
    listings: [
      { id: "l-biz", seller_id: "stu-biz", title: "Homemade Brownies", kind: "business", category_id: "food", is_food: true, quantity: 10, reserved_quantity: 0, status: "published", created_at: "2026-11-05T00:00:00Z" },
      // Pre-loved listing with is_food=true MUST NOT be misclassified as student business!
      { id: "l-pre", seller_id: "stu-pre", title: "Used Calculator", kind: "pre_loved", category_id: "electronics", is_food: true, quantity: 1, reserved_quantity: 0, status: "published", created_at: "2026-11-06T00:00:00Z" },
      { id: "l-svc", seller_id: "stu-biz", title: "Thesis Formatting", kind: "service", category_id: "printing-errands", is_food: false, quantity: 1, reserved_quantity: 0, status: "published", created_at: "2026-11-07T00:00:00Z" },
      { id: "l-noview", seller_id: "stu-biz", title: "Unviewed Item", kind: "business", category_id: "food", is_food: true, quantity: 5, reserved_quantity: 0, status: "published", created_at: "2026-11-07T00:00:00Z" },
    ],
    orders: [
      // Repeat buyer makes TWO orders on l-biz with only 1 unique viewer -> conversion MUST stay <= 100%!
      { id: "o-biz-1", buyer_id: "staff-1", seller_id: "stu-biz", checkout_session_id: "cs-1", subtotal_sen: 2000, commission_sen: 40, seller_net_sen: 1960, status: "completed", paid_at: "2026-11-20T00:00:00Z", completed_at: "2026-11-21T00:00:00Z", created_at: "2026-11-20T00:00:00Z" },
      { id: "o-biz-2", buyer_id: "staff-1", seller_id: "stu-biz", checkout_session_id: "cs-1", subtotal_sen: 1000, commission_sen: 20, seller_net_sen: 980, status: "completed", paid_at: "2026-11-21T00:00:00Z", completed_at: "2026-11-22T00:00:00Z", created_at: "2026-11-21T00:00:00Z" },
      // Prior-period completed order for stu-pre (so stu-pre is NOT a first-time successful seller in 30d!)
      { id: "o-pre-old", buyer_id: "staff-1", seller_id: "stu-pre", checkout_session_id: "cs-1", subtotal_sen: 500, commission_sen: 10, seller_net_sen: 490, status: "completed", paid_at: "2026-09-10T00:00:00Z", completed_at: "2026-09-11T00:00:00Z", created_at: "2026-09-10T00:00:00Z" },
      { id: "o-pre", buyer_id: "staff-1", seller_id: "stu-pre", checkout_session_id: "cs-1", subtotal_sen: 1500, commission_sen: 30, seller_net_sen: 1470, status: "completed", paid_at: "2026-11-20T00:00:00Z", completed_at: "2026-11-21T00:00:00Z", created_at: "2026-11-20T00:00:00Z" },
      // Unverified order MUST be excluded
      { id: "o-unver", buyer_id: "staff-1", seller_id: "stu-biz", checkout_session_id: null, subtotal_sen: 9900, commission_sen: 198, seller_net_sen: 9702, status: "completed", paid_at: "2026-11-20T00:00:00Z", completed_at: "2026-11-21T00:00:00Z", created_at: "2026-11-20T00:00:00Z" },
    ],
    orderItems: [
      { order_id: "o-biz-1", listing_id: "l-biz", title_snapshot: "Homemade Brownies", unit_sen: 1000, quantity: 2 },
      { order_id: "o-biz-2", listing_id: "l-biz", title_snapshot: "Homemade Brownies", unit_sen: 1000, quantity: 1 },
      { order_id: "o-pre-old", listing_id: "l-pre", title_snapshot: "Old Calc", unit_sen: 500, quantity: 1 },
      { order_id: "o-pre", listing_id: "l-pre", title_snapshot: "Used Calculator", unit_sen: 1500, quantity: 1 },
      { order_id: "o-unver", listing_id: "l-biz", title_snapshot: "Fake Unverified", unit_sen: 9900, quantity: 1 },
    ],
    checkoutSessions: [
      { id: "cs-1", buyer_id: "staff-1", status: "paid", payment_status: "paid", paid_at: "2026-11-20T00:00:00Z" },
    ],
    legacyPayments: [],
    refunds: [
      { order_id: "o-biz-1", refund_type: "partial_refund", refund_amount_sen: 500, commission_reversal_sen: 10, seller_deduction_sen: 490, status: "succeeded" },
    ],
    views: [
      { viewer_id: "staff-1", listing_id: "l-biz", viewed_at: "2026-11-19T00:00:00Z" },
    ],
    favourites: [{ user_id: "staff-1", listing_id: "l-biz", created_at: "2026-11-19T00:00:00Z" }],
    serviceRequests: [
      { id: "sr-1", listing_id: "l-svc", buyer_id: "staff-1", seller_id: "stu-biz", status: "completed", created_at: "2026-11-22T00:00:00Z", completed_at: "2026-11-23T00:00:00Z" },
    ],
    freeNotices: [{ id: "fn-1", contributor_id: "stu-pre", status: "closed", spot_id: "blok-alpha", created_at: "2026-11-15T00:00:00Z" }],
    freeClaims: [{ notice_id: "fn-1", donor_id: "stu-pre", recipient_id: "staff-1", quantity: 1, status: "collected", collected_at: "2026-11-16T00:00:00Z", created_at: "2026-11-15T00:00:00Z" }],
    reviews: [{ id: "rev-1", listing_id: "l-biz", seller_id: "stu-biz", rating: 5, hidden: false, created_at: "2026-11-22T00:00:00Z" }],
    reports: [{ id: "rpt-1", reason: "Spam", status: "submitted", created_at: "2026-11-23T00:00:00Z" }],
    disputes: [],
  };

  // Seller analytics isolated to stu-biz
  const sellerAn = computeSellerAnalytics("stu-biz", dataset, win30);
  assert.equal(sellerAn.kpis.grossSalesSen, 3000);
  assert.equal(sellerAn.kpis.executedRefundsSen, 500);
  assert.equal(sellerAn.kpis.netSalesSen, 2500);
  assert.equal(sellerAn.kpis.netSellerEarningsSen, 2450);
  assert.equal(sellerAn.kpis.netCommissionSen, 50);

  const bizPerf = sellerAn.listingPerformance.find((l) => l.id === "l-biz");
  assert.equal(bizPerf?.uniquePurchasers, 1);
  assert.equal(bizPerf?.conversionPct, 100, "Repeat buyer across 2 orders with 1 viewer must stay <= 100%");
  assert.equal(bizPerf?.ordersPerViewer, 2);
  assert.equal(sellerAn.listingPerformance.find((l) => l.id === "l-noview")?.conversionPct, null, "0 views => null (N/A)");

  // Admin platform analytics
  const adminAn = computeAdminPlatformAnalytics(dataset, win30);
  assert.equal(adminAn.overview.measuredActiveUsers, 3, "Idle active-status account excluded");
  assert.equal(adminAn.overview.grossProductSalesSen, 4500);
  assert.equal(adminAn.overview.netProductSalesSen, 4000);
  assert.equal(adminAn.entrepreneurship.activeStudentBusinessSellers, 1, "Pre-loved seller never counted as business even if is_food=true");
  assert.equal(adminAn.entrepreneurship.firstTimeSuccessfulSellers, 1, "Only stu-biz had earliest-ever completed order in 30d window");
  assert.equal(adminAn.entrepreneurship.studentBusinessSalesSen, 2500);
  assert.equal(adminAn.trustAndSafety.openReports, 1, "Hosted reports initial status 'submitted' counted as open");
  assert.ok(adminAn.activeUsersTrend.length >= 2, "Daily active users trend built from dated events");

  // CSV formula neutralization
  assert.equal(sanitizeCsvCell("=CMD|' /C calc'!A0"), "'=CMD|' /C calc'!A0");
  assert.equal(sanitizeCsvCell("+1+1"), "'+1+1");
  const csv = buildAnalyticsCsv([{ period: "30d", section: "Sales", metric: "@Inject", value: "RM 30.00" }]);
  assert.match(csv, /'@Inject/);
  assert.ok(REPORT_REASONS.includes("Scam or suspicious activity"));
});

// 6. P0.9 — Pagination helper never silently truncates at 1 page
test("P0.9: fetchAllPaginated loops across multiple pages without truncating", async () => {
  const full = Array.from({ length: 25 }, (_, i) => ({ id: i + 1 }));
  let calls = 0;
  const rows = await fetchAllPaginated(
    async (from, to) => {
      calls += 1;
      return { data: full.slice(from, to + 1), error: null };
    },
    10
  );
  assert.equal(rows.length, 25);
  assert.equal(calls, 3);
});

// 7. P0.1–P0.11 — Consolidated Hardened SQL Invariants
test("P0.1-P0.11 SQL: hosted schema compatibility, revoked direct writes, block triggers, bigint audit, report privacy & free-item expiry", () => {
  // P0.1: Hosted statuses preserved (free_notices active/closed/hidden + free_notice_drafts, reports submitted, listings hidden never removed, profiles suspended)
  assert.match(SQL, /CREATE TABLE IF NOT EXISTS public\.free_notice_drafts/);
  assert.doesNotMatch(SQL, /status = 'published'\s*,\s*--.*free_notices|status = 'claimed'/);
  assert.doesNotMatch(SQL, /status = 'removed'/);
  assert.match(SQL, /status IN \('submitted', 'under_review', 'resolved', 'dismissed'\)/);
  assert.match(SQL, /trg_listings_guard_admin_hidden/);

  // P0.2: service_requests typed timestamptz + remote/in_person + expired + duplicate index
  assert.match(SQL, /p_preferred_date timestamptz DEFAULT NULL/);
  assert.match(SQL, /'expired'/);
  assert.match(SQL, /idx_service_requests_one_active_per_buyer_listing/);

  // P0.3: admin_audit_logs bigint return + nullable uuid target_id + catalog toggle RPC + sequence grants
  assert.match(SQL, /FUNCTION public\.log_admin_audit_internal[\s\S]*RETURNS bigint/);
  assert.match(SQL, /FUNCTION public\.admin_toggle_catalog_item_atomic/);
  assert.match(SQL, /GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;/);

  // P0.4: Direct client writes revoked + profile last_active_at tamper guard + atomic free publish & review edit
  assert.match(SQL, /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.service_requests FROM PUBLIC, anon, authenticated;/);
  assert.match(SQL, /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.reviews FROM PUBLIC, anon, authenticated;/);
  assert.match(SQL, /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.free_notices FROM PUBLIC, anon, authenticated;/);
  assert.match(SQL, /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.listing_views FROM PUBLIC, anon, authenticated;/);
  assert.match(SQL, /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.notifications FROM PUBLIC, anon, authenticated;/);
  assert.match(SQL, /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.member_blocks FROM PUBLIC, anon, authenticated;/);
  assert.match(SQL, /trg_profiles_guard_system_fields/);
  assert.match(SQL, /FUNCTION public\.publish_free_notice_atomic/);
  assert.match(SQL, /FUNCTION public\.edit_verified_review_atomic/);

  // P0.5: Block privacy + DB-level triggers on conversations, messages (controlled paid-order exception), offers
  assert.match(SQL, /FUNCTION public\.internal_is_blocked_between/);
  assert.match(SQL, /FUNCTION public\.is_member_blocked_between/);
  assert.match(SQL, /trg_conversations_block_guard/);
  assert.match(SQL, /trg_messages_block_guard/);
  assert.match(SQL, /trg_offers_block_guard/);

  // P0.6: Free-item expiry + no silent GREATEST(0, ...) inventory corruption masking
  assert.match(SQL, /reservation_expires_at/);
  assert.match(SQL, /FUNCTION public\.expire_stale_free_claims_atomic/);
  assert.match(SQL, /INVENTORY_INTEGRITY_ERROR/);
  assert.doesNotMatch(SQL, /GREATEST\(0,\s*reserved_quantity/);

  // P0.7: Report target validation, message participant access, admin_notes column-level restriction, free_notice admin moderation
  assert.match(SQL, /REPORT_TARGET_NOT_FOUND/);
  assert.match(SQL, /INVALID_REPORT_REASON/);
  assert.match(SQL, /REVOKE ALL ON TABLE public\.reports FROM PUBLIC, anon, authenticated;/);
  assert.match(SQL, /GRANT SELECT \([^)]*report_code[^)]*\) ON TABLE public\.reports TO authenticated;/);
  assert.doesNotMatch(SQL, /GRANT SELECT \([^)]*admin_notes[^)]*\) ON TABLE public\.reports TO authenticated;/);
  assert.match(SQL, /FUNCTION public\.admin_moderate_free_notice_atomic/);

  // Explicit service_role grants for every table
  for (const tbl of [
    "free_notice_drafts",
    "free_notice_claims",
    "service_requests",
    "reviews",
    "reports",
    "member_blocks",
    "admin_audit_logs",
    "listing_views",
  ]) {
    assert.match(SQL, new RegExp(`GRANT ALL ON TABLE public\\.${tbl} TO service_role;`));
  }
});
