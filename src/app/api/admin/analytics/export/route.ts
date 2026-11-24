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
  const range: AnalyticsRangeKey =
    rawRange === "7d" || rawRange === "30d" || rawRange === "90d" || rawRange === "this_month" || rawRange === "all"
      ? rawRange
      : "30d";

  const dataset = await loadAnalyticsDataset();
  if (!dataset) return NextResponse.json({ error: "Analytics unavailable." }, { status: 503 });

  const stats = computeAdminPlatformAnalytics(dataset, resolveAnalyticsWindow(range));
  const csv = buildAnalyticsCsv([
    { period: range, section: "Overview", metric: "Total Registered Members", value: String(stats.overview.totalMembers) },
    { period: range, section: "Overview", metric: "Students / Staff", value: `${stats.overview.studentsCount} / ${stats.overview.staffCount}` },
    { period: range, section: "Overview", metric: "Measured Active Users", value: String(stats.overview.measuredActiveUsers) },
    { period: range, section: "Sales", metric: "Gross Verified Product Sales", value: formatCurrencySen(stats.overview.grossProductSalesSen) },
    { period: range, section: "Sales", metric: "Executed Refunds", value: formatCurrencySen(stats.overview.executedRefundsSen) },
    { period: range, section: "Sales", metric: "Net Product Sales", value: formatCurrencySen(stats.overview.netProductSalesSen) },
    { period: range, section: "Sales", metric: "Net Platform Commission (2%)", value: formatCurrencySen(stats.overview.netPlatformCommissionSen) },
    { period: range, section: "Entrepreneurship", metric: "Published Student Business Sellers", value: String(stats.entrepreneurship.publishedStudentBusinessSellers) },
    { period: range, section: "Entrepreneurship", metric: "Active Student Business Sellers", value: String(stats.entrepreneurship.activeStudentBusinessSellers) },
    { period: range, section: "Entrepreneurship", metric: "Student Business Net Sales", value: formatCurrencySen(stats.entrepreneurship.studentBusinessSalesSen) },
    { period: range, section: "Entrepreneurship", metric: "Student Business Earnings (Pre-Expense)", value: formatCurrencySen(stats.entrepreneurship.studentBusinessEarningsSen) },
    { period: range, section: "Entrepreneurship", metric: "Active Student Service Providers", value: String(stats.entrepreneurship.activeServiceProviders) },
    { period: range, section: "Community", metric: "Pre-Loved Completed Resales", value: String(stats.entrepreneurship.preLovedCompletedTransactions) },
    { period: range, section: "Community", metric: "Completed Donations", value: String(stats.community.completedDonations) },
    { period: range, section: "Community", metric: "Units Donated", value: String(stats.community.totalUnitsDonated) },
    { period: range, section: "Trust & Safety", metric: "Open Reports", value: String(stats.trustAndSafety.openReports) },
    { period: range, section: "Trust & Safety", metric: "Active Disputes", value: String(stats.trustAndSafety.activeDisputes) },
  ]);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="buyu-admin-platform-analytics-${range}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
