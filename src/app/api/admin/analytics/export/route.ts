import { NextResponse, type NextRequest } from "next/server";
import { loadAnalyticsDataset } from "@/lib/analytics/data";
import {
  buildAnalyticsCsv,
  computeAdminPlatformAnalytics,
  resolveAnalyticsWindow,
  type AnalyticsRangeKey,
} from "@/lib/analytics/metrics";
import { formatCurrencySen } from "@/lib/format";
import { getSessionSummary } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const session = await getSessionSummary();
  if (!session.isAuthenticated || !session.isActiveAdmin) {
    return NextResponse.json({ error: "Active administrator access required." }, { status: 403 });
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

  const stats = computeAdminPlatformAnalytics(
    dataset,
    resolveAnalyticsWindow(range, Date.now(), customStart, customEnd)
  );
  const periodLabel = range === "custom" && customStart && customEnd ? `${customStart}_to_${customEnd}` : range;
  const csv = buildAnalyticsCsv([
    { period: periodLabel, section: "Overview", metric: "Total Registered Members", value: String(stats.overview.totalMembers) },
    { period: periodLabel, section: "Overview", metric: "Students / Staff", value: `${stats.overview.studentsCount} / ${stats.overview.staffCount}` },
    { period: periodLabel, section: "Overview", metric: "Measured Active Users", value: String(stats.overview.measuredActiveUsers) },
    { period: periodLabel, section: "Sales", metric: "Verified Unified Checkouts", value: String(stats.overview.verifiedCheckouts) },
    { period: periodLabel, section: "Sales", metric: "Verified Child Orders", value: String(stats.overview.verifiedTransactions) },
    { period: periodLabel, section: "Sales", metric: "Gross Verified Product Sales", value: formatCurrencySen(stats.overview.grossProductSalesSen) },
    { period: periodLabel, section: "Sales", metric: "Executed Refunds", value: formatCurrencySen(stats.overview.executedRefundsSen) },
    { period: periodLabel, section: "Sales", metric: "Net Product Sales", value: formatCurrencySen(stats.overview.netProductSalesSen) },
    { period: periodLabel, section: "Sales", metric: "Net Platform Commission (2%)", value: formatCurrencySen(stats.overview.netPlatformCommissionSen) },
    { period: periodLabel, section: "Entrepreneurship", metric: "Published Student Business Sellers", value: String(stats.entrepreneurship.publishedStudentBusinessSellers) },
    { period: periodLabel, section: "Entrepreneurship", metric: "Active Student Business Sellers", value: String(stats.entrepreneurship.activeStudentBusinessSellers) },
    { period: periodLabel, section: "Entrepreneurship", metric: "First-Time Successful Student Business Sellers", value: String(stats.entrepreneurship.firstTimeSuccessfulBusinessSellers) },
    { period: periodLabel, section: "Entrepreneurship", metric: "First-Time Successful Marketplace Sellers (Any)", value: String(stats.entrepreneurship.firstTimeSuccessfulSellers) },
    { period: periodLabel, section: "Entrepreneurship", metric: "Student Business Net Sales", value: formatCurrencySen(stats.entrepreneurship.studentBusinessSalesSen) },
    { period: periodLabel, section: "Entrepreneurship", metric: "Student Business Earnings (Pre-Expense)", value: formatCurrencySen(stats.entrepreneurship.studentBusinessEarningsSen) },
    { period: periodLabel, section: "Entrepreneurship", metric: "Active Student Service Providers", value: String(stats.entrepreneurship.activeServiceProviders) },
    { period: periodLabel, section: "Community", metric: "Pre-Loved Completed Resales", value: String(stats.entrepreneurship.preLovedCompletedTransactions) },
    { period: "All time", section: "Free Items", metric: "Total posts", value: String(stats.noticeboard.total) },
    { period: "Current", section: "Free Items", metric: "Active posts", value: String(stats.noticeboard.active) },
    { period: "Current", section: "Free Items", metric: "Expired posts", value: String(stats.noticeboard.expired) },
    { period: "All time", section: "Free Items", metric: "Unique contributors", value: String(stats.noticeboard.contributors) },
    { period: "All time", section: "Free Items", metric: "Posts renewed at least once", value: String(stats.noticeboard.renewed) },
    { period: periodLabel, section: "Trust & Safety", metric: "Open Reports (Submitted/Under Review)", value: String(stats.trustAndSafety.openReports) },
    { period: periodLabel, section: "Trust & Safety", metric: "Active Disputes", value: String(stats.trustAndSafety.activeDisputes) },
  ]);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="buyu-admin-platform-analytics-${periodLabel}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
