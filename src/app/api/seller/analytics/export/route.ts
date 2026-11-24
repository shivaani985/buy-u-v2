import { NextResponse, type NextRequest } from "next/server";
import { loadAnalyticsDataset } from "@/lib/analytics/data";
import {
  buildAnalyticsCsv,
  computeSellerAnalytics,
  resolveAnalyticsWindow,
  type AnalyticsRangeKey,
} from "@/lib/analytics/metrics";
import { formatCurrencySen } from "@/lib/format";
import { evaluateSellerEligibility } from "@/lib/seller/validation";
import { getSessionSummary } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const session = await getSessionSummary();
  const elig = evaluateSellerEligibility(session);
  if (!elig.eligible || !session.profile?.id) {
    return NextResponse.json({ error: "Seller authentication required." }, { status: 403 });
  }

  const rawRange = request.nextUrl.searchParams.get("range");
  const customStart = request.nextUrl.searchParams.get("start")?.trim() || null;
  const customEnd = request.nextUrl.searchParams.get("end")?.trim() || null;
  const range: AnalyticsRangeKey =
    rawRange === "7d" ||
    rawRange === "30d" ||
    rawRange === "90d" ||
    rawRange === "this_month" ||
    rawRange === "all" ||
    (rawRange === "custom" && customStart && customEnd)
      ? rawRange
      : "30d";

  const dataset = await loadAnalyticsDataset();
  if (!dataset) return NextResponse.json({ error: "Analytics unavailable." }, { status: 503 });

  const analytics = computeSellerAnalytics(
    session.profile.id,
    dataset,
    resolveAnalyticsWindow(range, Date.now(), customStart, customEnd)
  );
  const periodLabel = range === "custom" && customStart && customEnd ? `${customStart}_to_${customEnd}` : range;
  const csv = buildAnalyticsCsv([
    { period: periodLabel, section: "Sales", metric: "Gross Verified Sales", value: formatCurrencySen(analytics.kpis.grossSalesSen) },
    { period: periodLabel, section: "Sales", metric: "Executed Refunds", value: formatCurrencySen(analytics.kpis.executedRefundsSen) },
    { period: periodLabel, section: "Sales", metric: "Net Sales", value: formatCurrencySen(analytics.kpis.netSalesSen) },
    { period: periodLabel, section: "Sales", metric: "Net Seller Earnings (Pre-Expense)", value: formatCurrencySen(analytics.kpis.netSellerEarningsSen) },
    { period: periodLabel, section: "Sales", metric: "Net Platform Commission (2%)", value: formatCurrencySen(analytics.kpis.netCommissionSen) },
    { period: periodLabel, section: "Orders", metric: "Verified Orders", value: String(analytics.kpis.verifiedOrders) },
    { period: periodLabel, section: "Orders", metric: "Completed Orders", value: String(analytics.kpis.completedOrders) },
    { period: periodLabel, section: "Orders", metric: "Units Sold", value: String(analytics.kpis.unitsSold) },
    { period: periodLabel, section: "Engagement", metric: "Listing Views", value: String(analytics.kpis.totalViews) },
    { period: periodLabel, section: "Services", metric: "Completed Services", value: String(analytics.kpis.completedServices) },
    { period: periodLabel, section: "Reviews", metric: "Average Verified Rating", value: analytics.kpis.averageRating !== null ? String(analytics.kpis.averageRating) : "N/A" },
  ]);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="buyu-seller-analytics-${periodLabel}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
