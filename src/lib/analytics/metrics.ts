/**
 * Authoritative Analytics Engine for:
 *   - Phase 8E: Seller Business Analytics
 *   - Phase 9A: Admin Platform Analytics
 *   - Section 11: Student Entrepreneurship Insights & Community Impact
 *
 * Uses exact integer sen, Malaysian timezone (UTC+8), authoritative payment verification,
 * zero double-counting, and spreadsheet formula-injection-safe CSV sanitization.
 */
import { isAuthoritativeOrderPaymentVerified } from "../financials/policy.ts";
import { computeCommunityImpact, computeRatingSummary } from "../marketplace/phase8.ts";

export type AnalyticsRangeKey = "7d" | "30d" | "90d" | "this_month" | "all" | "custom";

export interface AnalyticsDateWindow {
  key: AnalyticsRangeKey;
  startMs: number | null;
  endMs: number;
  prevStartMs: number | null;
  prevEndMs: number | null;
}

const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function resolveAnalyticsWindow(
  range: AnalyticsRangeKey,
  nowMs: number = Date.now(),
  customStartIso?: string | null,
  customEndIso?: string | null
): AnalyticsDateWindow {
  if (range === "all") {
    return { key: "all", startMs: null, endMs: nowMs, prevStartMs: null, prevEndMs: null };
  }
  if (range === "custom" && customStartIso && customEndIso) {
    // Date-only inputs (YYYY-MM-DD) span full MYT calendar days [00:00:00+08:00, 23:59:59.999+08:00]
    const normStart = /^\d{4}-\d{2}-\d{2}$/.test(customStartIso.trim())
      ? `${customStartIso.trim()}T00:00:00+08:00`
      : customStartIso;
    const normEnd = /^\d{4}-\d{2}-\d{2}$/.test(customEndIso.trim())
      ? `${customEndIso.trim()}T23:59:59.999+08:00`
      : customEndIso;
    const s = Date.parse(normStart);
    const e = Date.parse(normEnd);
    if (!Number.isNaN(s) && !Number.isNaN(e) && e >= s) {
      const span = Math.max(DAY_MS, e - s);
      return { key: "custom", startMs: s, endMs: e, prevStartMs: s - span, prevEndMs: s };
    }
  }
  if (range === "this_month") {
    const myt = new Date(nowMs + MYT_OFFSET_MS);
    const monthStartUtc = Date.UTC(myt.getUTCFullYear(), myt.getUTCMonth(), 1) - MYT_OFFSET_MS;
    const span = Math.max(DAY_MS, nowMs - monthStartUtc);
    return {
      key: "this_month",
      startMs: monthStartUtc,
      endMs: nowMs,
      prevStartMs: monthStartUtc - span,
      prevEndMs: monthStartUtc,
    };
  }
  const days = range === "90d" ? 90 : range === "30d" ? 30 : 7;
  const span = days * DAY_MS;
  return {
    key: range,
    startMs: nowMs - span,
    endMs: nowMs,
    prevStartMs: nowMs - span * 2,
    prevEndMs: nowMs - span,
  };
}

export function computeGrowthPct(current: number, previous: number | null): number | null {
  if (previous === null || previous <= 0) return null;
  return Number((((current - previous) / previous) * 100).toFixed(1));
}

export function toMytDayKey(isoOrMs: string | number): string {
  const ms = typeof isoOrMs === "number" ? isoOrMs : Date.parse(isoOrMs);
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms + MYT_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function inRange(iso: string | null | undefined, startMs: number | null, endMs: number): boolean {
  if (!iso) return false;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return false;
  if (startMs !== null && ms < startMs) return false;
  return ms <= endMs;
}

export interface AnalyticsDatasetInput {
  profiles: Array<{
    id: string;
    university_role: string;
    status: string;
    faculty?: string | null;
    created_at: string;
    last_active_at?: string | null;
  }>;
  listings: Array<{
    id: string;
    seller_id: string;
    title: string;
    kind: string;
    category_id: string;
    is_food: boolean;
    has_variants?: boolean;
    quantity: number;
    reserved_quantity: number;
    status: string;
    created_at: string;
  }>;
  orders: Array<{
    id: string;
    buyer_id: string;
    seller_id: string;
    checkout_session_id: string | null;
    subtotal_sen: number;
    commission_sen: number;
    seller_net_sen: number;
    status: string;
    paid_at: string | null;
    completed_at: string | null;
    created_at: string;
  }>;
  orderItems: Array<{
    order_id: string;
    listing_id: string | null;
    title_snapshot: string;
    unit_sen: number;
    quantity: number;
    is_service?: boolean | null;
  }>;
  checkoutSessions: Array<{
    id: string;
    buyer_id?: string | null;
    status: string;
    payment_status: string;
    paid_at: string | null;
  }>;
  legacyPayments: Array<{
    order_id: string;
    status: string;
    verified_at: string | null;
  }>;
  refunds: Array<{
    order_id: string;
    refund_type: string;
    refund_amount_sen: number;
    commission_reversal_sen: number;
    seller_deduction_sen: number;
    status: string;
  }>;
  views: Array<{ viewer_id: string; listing_id: string; viewed_at: string }>;
  favourites: Array<{ user_id: string; listing_id: string; created_at?: string | null }>;
  serviceRequests: Array<{
    id: string;
    listing_id: string;
    buyer_id: string;
    seller_id: string;
    status: string;
    created_at: string;
    completed_at?: string | null;
  }>;
  freeNotices: Array<{ id: string; contributor_id: string; status: string; spot_id: string | null; created_at: string }>;
  freeClaims: Array<{
    notice_id: string;
    donor_id: string;
    recipient_id: string;
    quantity: number;
    status: string;
    collected_at?: string | null;
    created_at: string;
  }>;
  reviews: Array<{
    id: string;
    listing_id: string | null;
    seller_id: string;
    rating: number;
    hidden: boolean;
    created_at: string;
  }>;
  reports: Array<{ id: string; reason: string; status: string; created_at: string; resolved_at?: string | null }>;
  disputes: Array<{ id: string; order_id: string; status: string; created_at: string; resolved_at?: string | null }>;
}

/**
 * Exact integer-sen proportional allocation using largest-remainder distribution
 * (tie-broken deterministically by ascending index). Guarantees SUM(result) === totalNetSen
 * whenever totalWeight > 0, with zero floating-point rounding drift.
 * Note: Used for proportional order-level refund allocation estimates across multi-item orders.
 */
export function allocateProportionalSen(
  totalNetSen: number,
  lineGrossWeights: number[]
): number[] {
  const n = lineGrossWeights.length;
  if (n === 0) return [];
  const target = Math.max(0, Math.round(totalNetSen));
  const cleanWeights = lineGrossWeights.map((w) => Math.max(0, Math.round(w)));
  const totalWeight = cleanWeights.reduce((s, w) => s + w, 0);
  if (target === 0 || totalWeight === 0) {
    return new Array<number>(n).fill(0);
  }

  const allocations: number[] = new Array<number>(n).fill(0);
  const remainders: Array<{ index: number; rem: number }> = [];
  let allocatedSum = 0;

  for (let i = 0; i < n; i += 1) {
    const numerator = target * cleanWeights[i]!;
    const floorVal = Math.floor(numerator / totalWeight);
    const rem = numerator % totalWeight;
    allocations[i] = floorVal;
    allocatedSum += floorVal;
    remainders.push({ index: i, rem });
  }

  let residual = target - allocatedSum;
  remainders.sort((a, b) => (b.rem !== a.rem ? b.rem - a.rem : a.index - b.index));
  for (let i = 0; i < remainders.length && residual > 0; i += 1) {
    allocations[remainders[i]!.index]! += 1;
    residual -= 1;
  }

  return allocations;
}

const EXCLUDED_UNPAID = new Set(["pending_payment", "expired", "cancelled", "canceled", "failed"]);

export function computeSellerAnalytics(
  sellerId: string,
  data: AnalyticsDatasetInput,
  window: AnalyticsDateWindow
) {
  const csById = new Map(data.checkoutSessions.map((c) => [c.id, c]));
  const payByOrder = new Map(data.legacyPayments.map((p) => [p.order_id, p]));
  const refundByOrder = new Map<string, { product: number; commRev: number; sellerDeduct: number }>();
  for (const r of data.refunds) {
    if (r.status === "succeeded") {
      const cur = refundByOrder.get(r.order_id) ?? { product: 0, commRev: 0, sellerDeduct: 0 };
      cur.product += r.refund_amount_sen;
      cur.commRev += r.commission_reversal_sen;
      cur.sellerDeduct += r.seller_deduction_sen;
      refundByOrder.set(r.order_id, cur);
    }
  }

  const sellerListings = data.listings.filter((l) => l.seller_id === sellerId);
  const listingIds = new Set(sellerListings.map((l) => l.id));
  const sellerOrders = data.orders.filter((o) => {
    if (o.seller_id !== sellerId) return false;
    if (EXCLUDED_UNPAID.has(o.status)) return false;
    return isAuthoritativeOrderPaymentVerified({
      order: o,
      checkoutSession: o.checkout_session_id ? csById.get(o.checkout_session_id) ?? null : null,
      legacyPayment: payByOrder.get(o.id) ?? null,
    });
  });

  const periodOrders = sellerOrders.filter((o) => inRange(o.paid_at, window.startMs, window.endMs));
  const prevOrders =
    window.prevStartMs !== null && window.prevEndMs !== null
      ? sellerOrders.filter((o) => inRange(o.paid_at, window.prevStartMs, window.prevEndMs!))
      : [];

  let grossSalesSen = 0;
  let executedRefundsSen = 0;
  let netSellerEarningsSen = 0;
  let netCommissionSen = 0;
  let completedOrders = 0;
  const trendMap = new Map<string, { day: string; salesSen: number; orders: number }>();

  for (const o of periodOrders) {
    const adj = refundByOrder.get(o.id);
    const refProd = adj?.product ?? 0;
    const commRev = adj?.commRev ?? 0;
    const selDeduct = adj?.sellerDeduct ?? 0;
    grossSalesSen += o.subtotal_sen;
    executedRefundsSen += refProd;
    netCommissionSen += Math.max(0, o.commission_sen - commRev);
    netSellerEarningsSen += Math.max(0, o.seller_net_sen - selDeduct);
    if (o.status === "completed") completedOrders += 1;

    const dk = toMytDayKey(o.paid_at ?? o.created_at);
    if (dk) {
      const cur = trendMap.get(dk) ?? { day: dk, salesSen: 0, orders: 0 };
      cur.salesSen += Math.max(0, o.subtotal_sen - refProd);
      cur.orders += 1;
      trendMap.set(dk, cur);
    }
  }

  let prevNetSalesSen = 0;
  for (const o of prevOrders) {
    const refProd = refundByOrder.get(o.id)?.product ?? 0;
    prevNetSalesSen += Math.max(0, o.subtotal_sen - refProd);
  }

  const netSalesSen = Math.max(0, grossSalesSen - executedRefundsSen);
  const periodOrderById = new Map(periodOrders.map((o) => [o.id, o]));
  const itemsByOrder = new Map<string, typeof data.orderItems>();
  for (const oi of data.orderItems) {
    if (!periodOrderById.has(oi.order_id)) continue;
    const arr = itemsByOrder.get(oi.order_id) ?? [];
    arr.push(oi);
    itemsByOrder.set(oi.order_id, arr);
  }

  const productPerf = new Map<
    string,
    {
      listingId: string;
      title: string;
      unitsSold: number;
      revenueSen: number;
      orders: number;
      purchaserEvents: Array<{ buyerId: string; orderTs: number }>;
    }
  >();
  let unitsSold = 0;
  for (const [orderId, items] of itemsByOrder.entries()) {
    const ord = periodOrderById.get(orderId);
    if (!ord) continue;
    const refProd = refundByOrder.get(orderId)?.product ?? 0;
    const netOrdSen = Math.max(0, ord.subtotal_sen - refProd);
    const lineAllocations = allocateProportionalSen(
      netOrdSen,
      items.map((it) => it.unit_sen * it.quantity)
    );
    const orderTs = Date.parse(ord.paid_at ?? ord.created_at);

    for (let idx = 0; idx < items.length; idx += 1) {
      const oi = items[idx]!;
      unitsSold += oi.quantity;
      const lid = oi.listing_id ?? oi.title_snapshot;
      const cur = productPerf.get(lid) ?? {
        listingId: lid,
        title: oi.title_snapshot,
        unitsSold: 0,
        revenueSen: 0,
        orders: 0,
        purchaserEvents: [],
      };
      cur.unitsSold += oi.quantity;
      cur.revenueSen += lineAllocations[idx] ?? 0;
      cur.orders += 1;
      cur.purchaserEvents.push({ buyerId: ord.buyer_id, orderTs });
      productPerf.set(lid, cur);
    }
  }

  const periodViews = data.views.filter(
    (v) =>
      listingIds.has(v.listing_id) &&
      v.viewer_id !== sellerId &&
      inRange(v.viewed_at, window.startMs, window.endMs)
  );
  // Earliest qualifying view timestamp per (listing, viewer) for true pre-purchase cohort attribution
  const firstViewByListingViewer = new Map<string, Map<string, number>>();
  for (const v of periodViews) {
    const ts = Date.parse(v.viewed_at);
    if (Number.isNaN(ts)) continue;
    const m = firstViewByListingViewer.get(v.listing_id) ?? new Map<string, number>();
    const prev = m.get(v.viewer_id);
    if (prev === undefined || ts < prev) m.set(v.viewer_id, ts);
    firstViewByListingViewer.set(v.listing_id, m);
  }
  const favCountByListing = new Map<string, number>();
  for (const f of data.favourites) {
    if (listingIds.has(f.listing_id)) {
      favCountByListing.set(f.listing_id, (favCountByListing.get(f.listing_id) ?? 0) + 1);
    }
  }

  const listingPerformance = sellerListings.map((l) => {
    const viewerMap = firstViewByListingViewer.get(l.id);
    const uniqueViewers = viewerMap?.size ?? 0;
    const perf = productPerf.get(l.id);
    const ordCount = perf?.orders ?? 0;
    const uniquePurchasers = new Set((perf?.purchaserEvents ?? []).map((e) => e.buyerId)).size;

    // P0.17: True attributable viewer-to-purchaser cohort (purchase timestamp >= qualifying view in window).
    // Strictly a subset of uniqueViewers — NEVER relies on clamping! Returns null (N/A) if unattributable.
    const attributablePurchasers = new Set<string>();
    if (viewerMap && perf) {
      for (const ev of perf.purchaserEvents) {
        const firstViewTs = viewerMap.get(ev.buyerId);
        if (firstViewTs !== undefined && !Number.isNaN(ev.orderTs) && ev.orderTs >= firstViewTs) {
          attributablePurchasers.add(ev.buyerId);
        }
      }
    }

    const conversionPct =
      uniqueViewers > 0 && (ordCount === 0 || attributablePurchasers.size > 0)
        ? Number(((attributablePurchasers.size / uniqueViewers) * 100).toFixed(1))
        : null;
    const ordersPerViewer =
      uniqueViewers > 0 ? Number((ordCount / uniqueViewers).toFixed(2)) : null;

    return {
      id: l.id,
      title: l.title,
      kind: l.kind,
      status: l.status,
      availableStock: Math.max(0, l.quantity - l.reserved_quantity),
      views: periodViews.filter((v) => v.listing_id === l.id).length,
      uniqueViewers,
      uniquePurchasers,
      attributablePurchasers: attributablePurchasers.size,
      favourites: favCountByListing.get(l.id) ?? 0,
      unitsSold: perf?.unitsSold ?? 0,
      revenueSen: perf?.revenueSen ?? 0,
      conversionPct,
      ordersPerViewer,
    };
  });

  const sellerServiceListingIds = new Set(
    sellerListings.filter((l) => l.kind === "service").map((l) => l.id)
  );
  const periodServiceOrders = periodOrders.filter((o) => {
    const items = itemsByOrder.get(o.id) ?? [];
    return items.some(
      (oi) =>
        Boolean(oi.is_service) ||
        (oi.listing_id !== null && sellerServiceListingIds.has(oi.listing_id))
    );
  });
  const sellerLegacyServices = data.serviceRequests.filter(
    (sr) => sr.seller_id === sellerId && inRange(sr.created_at, window.startMs, window.endMs)
  );
  const sellerServiceTotal = periodServiceOrders.length + sellerLegacyServices.length;
  const sellerServiceCompleted =
    periodServiceOrders.filter((o) => o.status === "completed").length +
    sellerLegacyServices.filter((s) => s.status === "completed").length;
  const sellerServiceAccepted =
    periodServiceOrders.length +
    sellerLegacyServices.filter((s) =>
      ["accepted", "in_progress", "delivered", "completed"].includes(s.status)
    ).length;

  const sellerReviews = data.reviews.filter((r) => r.seller_id === sellerId);
  const ratingSummary = computeRatingSummary(sellerReviews);

  const byUnits = Array.from(productPerf.values()).sort((a, b) => b.unitsSold - a.unitsSold);
  const byRevenue = Array.from(productPerf.values()).sort((a, b) => b.revenueSen - a.revenueSen);

  const insights: string[] = [];
  if (byRevenue[0]) {
    insights.push(`Highest-revenue item: ${byRevenue[0].title} (RM ${(byRevenue[0].revenueSen / 100).toFixed(2)}).`);
  }
  if (byUnits[0] && byUnits[0].listingId !== byRevenue[0]?.listingId) {
    insights.push(`Best-selling by units: ${byUnits[0].title} (${byUnits[0].unitsSold} units).`);
  }
  const highInterestLowConv = listingPerformance.find((l) => l.uniqueViewers >= 5 && l.unitsSold === 0);
  if (highInterestLowConv) {
    insights.push(`"${highInterestLowConv.title}" has ${highInterestLowConv.uniqueViewers} unique viewers but 0 orders yet.`);
  }

  return {
    kpis: {
      grossSalesSen,
      executedRefundsSen,
      netSalesSen,
      salesGrowthPct: computeGrowthPct(netSalesSen, window.prevStartMs !== null ? prevNetSalesSen : null),
      verifiedOrders: periodOrders.length,
      completedOrders,
      unitsSold,
      averageOrderValueSen: periodOrders.length > 0 ? Math.round(netSalesSen / periodOrders.length) : 0,
      netSellerEarningsSen,
      netCommissionSen,
      activeListings: sellerListings.filter((l) => l.status === "published").length,
      totalViews: periodViews.length,
      totalFavourites: data.favourites.filter((f) => listingIds.has(f.listing_id)).length,
      serviceRequests: sellerServiceTotal,
      completedServices: sellerServiceCompleted,
      averageRating: ratingSummary.averageRating,
      reviewCount: ratingSummary.totalReviews,
    },
    salesTrend: Array.from(trendMap.values()).sort((a, b) => a.day.localeCompare(b.day)),
    topByUnits: byUnits.slice(0, 5),
    topByRevenue: byRevenue.slice(0, 5),
    listingPerformance,
    serviceSummary: {
      total: sellerServiceTotal,
      accepted: sellerServiceAccepted,
      completed: sellerServiceCompleted,
      declined: sellerLegacyServices.filter((s) => s.status === "declined").length,
      cancelled: sellerLegacyServices.filter((s) => s.status === "cancelled").length,
    },
    ratingSummary,
    insights,
  };
}

export function computeAdminPlatformAnalytics(
  data: AnalyticsDatasetInput,
  window: AnalyticsDateWindow
) {
  const csById = new Map(data.checkoutSessions.map((c) => [c.id, c]));
  const payByOrder = new Map(data.legacyPayments.map((p) => [p.order_id, p]));
  const refundByOrder = new Map<string, { product: number; commRev: number; sellerDeduct: number }>();
  for (const r of data.refunds) {
    if (r.status === "succeeded") {
      const cur = refundByOrder.get(r.order_id) ?? { product: 0, commRev: 0, sellerDeduct: 0 };
      cur.product += r.refund_amount_sen;
      cur.commRev += r.commission_reversal_sen;
      cur.sellerDeduct += r.seller_deduction_sen;
      refundByOrder.set(r.order_id, cur);
    }
  }

  const verifiedOrdersAll = data.orders.filter((o) => {
    if (EXCLUDED_UNPAID.has(o.status)) return false;
    return isAuthoritativeOrderPaymentVerified({
      order: o,
      checkoutSession: o.checkout_session_id ? csById.get(o.checkout_session_id) ?? null : null,
      legacyPayment: payByOrder.get(o.id) ?? null,
    });
  });

  const periodOrders = verifiedOrdersAll.filter((o) => inRange(o.paid_at, window.startMs, window.endMs));
  const listingById = new Map(data.listings.map((l) => [l.id, l]));

  // Genuine active users in period (dated platform events + last_active_at — NEVER merely status='active')
  const activeUserIds = new Set<string>();
  const activeUsersByDay = new Map<string, Set<string>>();
  function recordDatedActivity(iso: string | null | undefined, userId: string) {
    if (!inRange(iso, window.startMs, window.endMs)) return;
    activeUserIds.add(userId);
    const dk = toMytDayKey(iso!);
    if (!dk) return;
    const s = activeUsersByDay.get(dk) ?? new Set<string>();
    s.add(userId);
    activeUsersByDay.set(dk, s);
  }

  for (const p of data.profiles) {
    if (inRange(p.last_active_at, window.startMs, window.endMs)) activeUserIds.add(p.id);
  }
  for (const o of periodOrders) {
    recordDatedActivity(o.paid_at ?? o.created_at, o.buyer_id);
    recordDatedActivity(o.paid_at ?? o.created_at, o.seller_id);
  }
  for (const v of data.views) {
    recordDatedActivity(v.viewed_at, v.viewer_id);
  }
  for (const sr of data.serviceRequests) {
    recordDatedActivity(sr.created_at, sr.buyer_id);
    recordDatedActivity(sr.created_at, sr.seller_id);
  }
  for (const fc of data.freeClaims) {
    recordDatedActivity(fc.created_at, fc.donor_id);
    recordDatedActivity(fc.created_at, fc.recipient_id);
  }

  const orderItemsByOrder = new Map<string, typeof data.orderItems>();
  for (const oi of data.orderItems) {
    const arr = orderItemsByOrder.get(oi.order_id) ?? [];
    arr.push(oi);
    orderItemsByOrder.set(oi.order_id, arr);
  }

  // Student Entrepreneurship distinct cohorts (P0.9 & P0.17: strictly kind === 'business', never mixing via is_food)
  const studentBusinessListingIds = new Set(
    data.listings.filter((l) => l.kind === "business").map((l) => l.id)
  );
  const studentBusinessSellersPublished = new Set(
    data.listings
      .filter((l) => l.kind === "business" && l.status === "published")
      .map((l) => l.seller_id)
  );
  const preLovedSellers = new Set(
    data.listings.filter((l) => l.kind === "pre_loved").map((l) => l.seller_id)
  );
  const serviceProviders = new Set(
    data.listings.filter((l) => l.kind === "service" && l.status === "published").map((l) => l.seller_id)
  );

  // P0.17: Distinguish first-ever marketplace completed sale vs first-ever qualifying Student Business completed sale!
  // An earlier pre-loved sale NEVER disqualifies a seller's first Student Business sale.
  const earliestCompletedAnyBySeller = new Map<string, number>();
  const earliestCompletedBusinessBySeller = new Map<string, number>();
  for (const o of verifiedOrdersAll) {
    if (o.status !== "completed") continue;
    const ts = Date.parse(o.completed_at ?? o.paid_at ?? o.created_at);
    if (Number.isNaN(ts)) continue;
    const prevAny = earliestCompletedAnyBySeller.get(o.seller_id);
    if (prevAny === undefined || ts < prevAny) {
      earliestCompletedAnyBySeller.set(o.seller_id, ts);
    }
    const items = orderItemsByOrder.get(o.id) ?? [];
    const hasBizItem = items.some(
      (oi) => oi.listing_id !== null && studentBusinessListingIds.has(oi.listing_id)
    );
    if (hasBizItem) {
      const prevBiz = earliestCompletedBusinessBySeller.get(o.seller_id);
      if (prevBiz === undefined || ts < prevBiz) {
        earliestCompletedBusinessBySeller.set(o.seller_id, ts);
      }
    }
  }
  let firstTimeSuccessfulSellers = 0;
  for (const firstTs of earliestCompletedAnyBySeller.values()) {
    if ((window.startMs === null || firstTs >= window.startMs) && firstTs <= window.endMs) {
      firstTimeSuccessfulSellers += 1;
    }
  }
  let firstTimeSuccessfulBusinessSellers = 0;
  for (const firstTs of earliestCompletedBusinessBySeller.values()) {
    if ((window.startMs === null || firstTs >= window.startMs) && firstTs <= window.endMs) {
      firstTimeSuccessfulBusinessSellers += 1;
    }
  }

  let grossSalesSen = 0;
  let executedRefundsSen = 0;
  let netCommissionSen = 0;
  let completedOrders = 0;
  const salesByDay = new Map<string, number>();
  const salesByCat = new Map<string, number>();
  const sellerSales = new Map<string, number>();
  const buyerOrderCounts = new Map<string, number>();
  const activeBusinessSellersInPeriod = new Set<string>();
  let studentBusinessSalesSen = 0;
  let studentBusinessEarningsSen = 0;
  let studentBusinessOrders = 0;
  let preLovedCompletedTransactions = 0;

  for (const o of periodOrders) {
    const adj = refundByOrder.get(o.id);
    const refProd = adj?.product ?? 0;
    const netOrd = Math.max(0, o.subtotal_sen - refProd);
    const netEarns = Math.max(0, o.seller_net_sen - (adj?.sellerDeduct ?? 0));
    grossSalesSen += o.subtotal_sen;
    executedRefundsSen += refProd;
    netCommissionSen += Math.max(0, o.commission_sen - (adj?.commRev ?? 0));
    if (o.status === "completed") completedOrders += 1;

    const dk = toMytDayKey(o.paid_at ?? o.created_at);
    if (dk) salesByDay.set(dk, (salesByDay.get(dk) ?? 0) + netOrd);
    sellerSales.set(o.seller_id, (sellerSales.get(o.seller_id) ?? 0) + netOrd);
    buyerOrderCounts.set(o.buyer_id, (buyerOrderCounts.get(o.buyer_id) ?? 0) + 1);

    const items = orderItemsByOrder.get(o.id) ?? [];
    const lineWeights = items.map((it) => it.unit_sen * it.quantity);
    // Exact integer-sen largest-remainder allocation: sum(lineNetSales) === netOrd & sum(lineNetEarns) === netEarns!
    const lineNetSales = allocateProportionalSen(netOrd, lineWeights);
    const lineNetEarns = allocateProportionalSen(netEarns, lineWeights);
    let hasBusinessItem = false;
    let hasPreLovedItem = false;
    let bizSales = 0;
    let bizEarns = 0;

    for (let idx = 0; idx < items.length; idx += 1) {
      const oi = items[idx]!;
      const listing = oi.listing_id ? listingById.get(oi.listing_id) : null;
      const cat = listing?.category_id ?? "other-goods";
      const allocSales = lineNetSales[idx] ?? 0;
      const allocEarns = lineNetEarns[idx] ?? 0;
      salesByCat.set(cat, (salesByCat.get(cat) ?? 0) + allocSales);

      if (oi.listing_id && studentBusinessListingIds.has(oi.listing_id)) {
        hasBusinessItem = true;
        bizSales += allocSales;
        bizEarns += allocEarns;
      } else if (listing && listing.kind === "pre_loved") {
        hasPreLovedItem = true;
      }
    }

    if (hasBusinessItem) {
      activeBusinessSellersInPeriod.add(o.seller_id);
      studentBusinessSalesSen += bizSales;
      studentBusinessEarningsSen += bizEarns;
      studentBusinessOrders += 1;
    }
    if (hasPreLovedItem && o.status === "completed") {
      preLovedCompletedTransactions += 1;
    }
  }

  const periodServiceOrders = periodOrders.filter((o) => {
    const items = orderItemsByOrder.get(o.id) ?? [];
    return items.some(
      (oi) =>
        Boolean(oi.is_service) ||
        (oi.listing_id !== null && listingById.get(oi.listing_id)?.kind === "service")
    );
  });
  const periodLegacyServices = data.serviceRequests.filter((s) =>
    inRange(s.created_at, window.startMs, window.endMs)
  );
  // Paid service orders (orders table) and historical legacy requests (service_requests table) are disjoint; no double-counting.
  const periodServices = [...periodLegacyServices];
  const completedServices =
    periodServiceOrders.filter((o) => o.status === "completed").length +
    periodLegacyServices.filter((s) => s.status === "completed").length;
  const acceptedServices =
    periodServiceOrders.length +
    periodLegacyServices.filter((s) =>
      ["accepted", "in_progress", "delivered", "completed"].includes(s.status)
    ).length;
  const totalServiceTransactions =
    periodServiceOrders.length + periodLegacyServices.length;

  const community = computeCommunityImpact({
    notices: data.freeNotices,
    claims: data.freeClaims.filter((c) => inRange(c.collected_at ?? c.created_at, window.startMs, window.endMs)),
  });

  const periodReports = data.reports.filter((r) => inRange(r.created_at, window.startMs, window.endMs));
  const periodDisputes = data.disputes.filter((d) => inRange(d.created_at, window.startMs, window.endMs));
  const repeatBuyers = Array.from(buyerOrderCounts.values()).filter((c) => c >= 2).length;
  // Count unified multi-seller checkout_session_id ONCE; standalone legacy orders count once each
  const verifiedCheckoutKeys = new Set(
    periodOrders.map((o) => (o.checkout_session_id ? `cs:${o.checkout_session_id}` : `ord:${o.id}`))
  );

  return {
    overview: {
      totalMembers: data.profiles.length,
      studentsCount: data.profiles.filter((p) => p.university_role === "student").length,
      staffCount: data.profiles.filter((p) => p.university_role === "staff").length,
      activeStatusCount: data.profiles.filter((p) => p.status === "active").length,
      restrictedCount: data.profiles.filter((p) => p.status !== "active").length,
      measuredActiveUsers: activeUserIds.size,
      newRegistrations: data.profiles.filter((p) => inRange(p.created_at, window.startMs, window.endMs)).length,
      activeSellers: new Set(data.listings.filter((l) => l.status === "published").map((l) => l.seller_id)).size,
      activeListings: data.listings.filter((l) => l.status === "published").length,
      verifiedCheckouts: verifiedCheckoutKeys.size,
      verifiedTransactions: periodOrders.length,
      completedOrders,
      grossProductSalesSen: grossSalesSen,
      executedRefundsSen,
      netProductSalesSen: Math.max(0, grossSalesSen - executedRefundsSen),
      netPlatformCommissionSen: netCommissionSen,
      averageOrderValueSen: periodOrders.length > 0 ? Math.round(Math.max(0, grossSalesSen - executedRefundsSen) / periodOrders.length) : 0,
      completedServices,
      completedDonations: community.completedDonations,
    },
    listingsByType: {
      preLoved: data.listings.filter((l) => l.kind === "pre_loved").length,
      studentBusiness: data.listings.filter((l) => l.kind === "business").length,
      services: data.listings.filter((l) => l.kind === "service").length,
      freeItems: data.freeNotices.filter((n) => n.status === "active" || n.status === "closed").length,
    },
    salesTrend: Array.from(salesByDay.entries())
      .map(([day, amountSen]) => ({ day, amountSen }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    activeUsersTrend: Array.from(activeUsersByDay.entries())
      .map(([day, set]) => ({ day, users: set.size }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    categorySales: Array.from(salesByCat.entries())
      .map(([categoryId, amountSen]) => ({ categoryId, amountSen }))
      .sort((a, b) => b.amountSen - a.amountSen),
    services: {
      activeServiceListings: data.listings.filter((l) => l.kind === "service" && l.status === "published").length,
      totalRequests: totalServiceTransactions,
      completedServices,
      acceptanceRatePct: totalServiceTransactions > 0 ? Number(((acceptedServices / totalServiceTransactions) * 100).toFixed(1)) : null,
      completionRatePct: acceptedServices > 0 ? Number(((completedServices / acceptedServices) * 100).toFixed(1)) : null,
    },
    community,
    engagement: {
      totalViews: data.views.filter((v) => inRange(v.viewed_at, window.startMs, window.endMs)).length,
      uniqueViewers: new Set(data.views.filter((v) => inRange(v.viewed_at, window.startMs, window.endMs)).map((v) => v.viewer_id)).size,
      totalFavourites: data.favourites.length,
    },
    trustAndSafety: {
      totalReports: periodReports.length,
      openReports: data.reports.filter(
        (r) => r.status === "submitted" || r.status === "under_review"
      ).length,
      resolvedReports: data.reports.filter(
        (r) => r.status === "resolved" || r.status === "dismissed"
      ).length,
      activeDisputes: data.disputes.filter((d) => d.status === "open" || d.status === "under_review").length,
      resolvedDisputes: data.disputes.filter((d) => d.status === "resolved").length,
      disputeRatePct:
        periodOrders.length > 0 ? Number(((periodDisputes.length / periodOrders.length) * 100).toFixed(1)) : null,
      hiddenReviews: data.reviews.filter((r) => r.hidden).length,
    },
    entrepreneurship: {
      publishedStudentBusinessSellers: studentBusinessSellersPublished.size,
      activeStudentBusinessSellers: activeBusinessSellersInPeriod.size,
      firstTimeSuccessfulSellers,
      firstTimeSuccessfulBusinessSellers,
      preLovedSellersCount: preLovedSellers.size,
      activeServiceProviders: serviceProviders.size,
      completedStudentBusinessOrders: studentBusinessOrders,
      studentBusinessSalesSen,
      studentBusinessEarningsSen,
      avgEarningsPerBusinessSellerSen:
        activeBusinessSellersInPeriod.size > 0
          ? Math.round(studentBusinessEarningsSen / activeBusinessSellersInPeriod.size)
          : 0,
      repeatBuyers,
      preLovedCompletedTransactions,
      donorsCount: community.activeDonors,
      donatedUnits: community.totalUnitsDonated,
    },
  };
}

export interface PaginatedResult<T> {
  data: T[] | null;
  error: { message?: string } | null;
}

/**
 * Fetches all rows from a PostgREST query in chunks of `pageSize` using `.range()`,
 * avoiding Supabase's default 1,000-row truncation on analytics aggregates.
 */
export async function fetchAllPaginated<T>(
  fetchPage: (from: number, to: number) => PromiseLike<PaginatedResult<T>>,
  pageSize: number = 1000,
  maxPages: number = 50
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 0; page < maxPages; page += 1) {
    const from = page * pageSize;
    const to = from + pageSize - 1;
    const res = await fetchPage(from, to);
    if (res.error || !Array.isArray(res.data)) {
      if (page === 0) return [];
      break;
    }
    rows.push(...res.data);
    if (res.data.length < pageSize) break;
  }
  return rows;
}

/**
 * Spreadsheet formula-injection-safe CSV cell escaping (Section 10.12).
 */
export function sanitizeCsvCell(value: string | number | null | undefined): string {
  let s = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function buildAnalyticsCsv(
  rows: Array<{ period: string; section: string; metric: string; value: string; note?: string }>
): string {
  const header = "Period,Section,Metric,Value,Note";
  const lines = rows.map((r) =>
    [r.period, r.section, r.metric, r.value, r.note ?? ""].map(sanitizeCsvCell).join(",")
  );
  return [header, ...lines].join("\n");
}
