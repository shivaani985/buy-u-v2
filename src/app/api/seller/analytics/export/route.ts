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
  const range: AnalyticsRangeKey =
    rawRange === "7d" || rawRange === "30d" || rawRange === "90d" || rawRange === "this_month" || rawRange === "all"
      ? rawRange
      : "30d";

  const dataset = await loadAnalyticsDataset();
  if (!dataset) return NextResponse.json({ error: "Analytics unavailable." }, { status: 503 });

  const analytics = computeSellerAnalytics(session.profile.id, dataset, resolveAnalyticsWindow(range));
  const csv = buildAnalyticsCsv([
    { period: range, section: "Sales", metric: "Gross Verified Sales", value: formatCurrencySen(analytics.kpis.grossSalesSen) },
    { period: range, section: "Sales", metric: "Executed Refunds", value: formatCurrencySen(analytics.kpis.executedRefundsSen) },
    { period: range, section: "Sales", metric: "Net Sales", value: formatCurrencySen(analytics.kpis.netSalesSen) },
    { period: range, section: "Sales", metric: "Net Seller Earnings (Pre-Expense)", value: formatCurrencySen(analytics.kpis.netSellerEarningsSen) },
    { period: range, section: "Sales", metric: "Net Platform Commission (2%)", value: formatCurrencySen(analytics.kpis.netCommissionSen) },
    { period: range, section: "Orders", metric: "Verified Orders", value: String(analytics.kpis.verifiedOrders) },
    { period: range, section: "Orders", metric: "Completed Orders", value: String(analytics.kpis.completedOrders) },
    { period: range, section: "Orders", metric: "Units Sold", value: String(analytics.kpis.unitsSold) },
    { period: range, section: "Engagement", metric: "Listing Views", value: String(analytics.kpis.totalViews) },
    { period: range, section: "Services", metric: "Completed Services", value: String(analytics.kpis.completedServices) },
    { period: range, section: "Reviews", metric: "Average Verified Rating", value: analytics.kpis.averageRating !== null ? String(analytics.kpis.averageRating) : "N/A" },
  ]);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="buyu-seller-analytics-${range}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
