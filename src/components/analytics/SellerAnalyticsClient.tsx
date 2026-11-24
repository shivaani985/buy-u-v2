"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Download, Star } from "lucide-react";
import { respondToReviewAction } from "@/app/marketplace-actions";
import { HorizontalBarList, TrendLineChart } from "@/components/analytics/SimpleCharts";
import type { AnalyticsRangeKey } from "@/lib/analytics/metrics";
import { formatCurrencySen, formatShortDate } from "@/lib/format";

export interface SellerAnalyticsViewProps {
  range: AnalyticsRangeKey;
  customStart?: string | null;
  customEnd?: string | null;
  analytics: {
    kpis: {
      grossSalesSen: number;
      executedRefundsSen: number;
      netSalesSen: number;
      salesGrowthPct: number | null;
      verifiedOrders: number;
      completedOrders: number;
      unitsSold: number;
      averageOrderValueSen: number;
      netSellerEarningsSen: number;
      netCommissionSen: number;
      activeListings: number;
      totalViews: number;
      totalFavourites: number;
      serviceRequests: number;
      completedServices: number;
      averageRating: number | null;
      reviewCount: number;
    };
    salesTrend: Array<{ day: string; salesSen: number; orders: number }>;
    topByUnits: Array<{ listingId: string; title: string; unitsSold: number; revenueSen: number }>;
    topByRevenue: Array<{ listingId: string; title: string; unitsSold: number; revenueSen: number }>;
    listingPerformance: Array<{
      id: string;
      title: string;
      kind: string;
      status: string;
      availableStock: number;
      views: number;
      uniqueViewers: number;
      uniquePurchasers?: number;
      attributablePurchasers?: number;
      favourites: number;
      unitsSold: number;
      revenueSen: number;
      conversionPct: number | null;
      ordersPerViewer?: number | null;
    }>;
    serviceSummary: {
      total: number;
      accepted: number;
      completed: number;
      declined: number;
      cancelled: number;
    };
    insights: string[];
  };
  recentReviews: Array<{
    id: string;
    rating: number;
    comment: string;
    sellerResponse: string | null;
    createdAt: string;
  }>;
}

const RANGES: Array<{ key: AnalyticsRangeKey; label: string }> = [
  { key: "7d", label: "Last 7 Days" },
  { key: "30d", label: "Last 30 Days" },
  { key: "90d", label: "Last 90 Days" },
  { key: "this_month", label: "This Month" },
  { key: "all", label: "All Time" },
];

export function SellerAnalyticsClient({
  range,
  customStart = null,
  customEnd = null,
  analytics,
  recentReviews,
}: SellerAnalyticsViewProps) {
  const router = useRouter();
  const [startDate, setStartDate] = useState(customStart ?? "");
  const [endDate, setEndDate] = useState(customEnd ?? "");
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [replyStatus, setReplyStatus] = useState<string | null>(null);
  const { kpis } = analytics;
  const exportQuery =
    range === "custom" && customStart && customEnd
      ? `range=custom&start=${encodeURIComponent(customStart)}&end=${encodeURIComponent(customEnd)}`
      : `range=${range}`;

  async function sendReply(reviewId: string) {
    const text = (replyDrafts[reviewId] ?? "").trim();
    if (text.length < 3) return;
    const res = await respondToReviewAction({ reviewId, response: text });
    setReplyStatus(res.message);
    if (res.ok) router.refresh();
  }

  return (
    <div className="space-y-6">
      {/* Range filters + Sanitized CSV Export */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#E6E3EE] bg-white p-3.5">
        <div className="flex flex-wrap gap-1.5">
          {RANGES.map((r) => (
            <Link
              key={r.key}
              href={`/seller/analytics?range=${r.key}`}
              className={`rounded-xl px-3 py-1.5 text-xs font-bold ${
                range === r.key
                  ? "bg-[#4E2A84] text-white"
                  : "border border-[#E6E3EE] bg-[#FAF9FC] text-[#4A4656] hover:border-[#4E2A84]"
              }`}
            >
              {r.label}
            </Link>
          ))}
          <form
            className="flex flex-wrap items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (startDate && endDate && endDate >= startDate) {
                router.push(
                  `/seller/analytics?range=custom&start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(endDate)}`
                );
              }
            }}
          >
            <input
              type="date"
              aria-label="Custom start date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="rounded-lg border border-[#E6E3EE] bg-white px-2 py-1 text-xs"
            />
            <span className="text-xs text-[#6B6779]">to</span>
            <input
              type="date"
              aria-label="Custom end date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="rounded-lg border border-[#E6E3EE] bg-white px-2 py-1 text-xs"
            />
            <button
              type="submit"
              disabled={!startDate || !endDate || endDate < startDate}
              className="rounded-lg bg-[#008285] px-2.5 py-1 text-xs font-bold text-white disabled:opacity-40"
            >
              Apply
            </button>
          </form>
        </div>
        <a
          href={`/api/seller/analytics/export?${exportQuery}`}
          className="inline-flex items-center gap-1.5 rounded-xl border border-[#4E2A84] px-3.5 py-1.5 text-xs font-bold text-[#4E2A84] hover:bg-[#F3EEFA]"
        >
          <Download className="h-3.5 w-3.5" />
          <span>Export CSV</span>
        </a>
      </div>

      {/* KPI Grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {[
          { label: "Gross Verified Sales", val: formatCurrencySen(kpis.grossSalesSen) },
          { label: "Net Sales (After Refunds)", val: formatCurrencySen(kpis.netSalesSen), sub: kpis.salesGrowthPct !== null ? `${kpis.salesGrowthPct >= 0 ? "+" : ""}${kpis.salesGrowthPct}% vs prior` : "vs prior: N/A" },
          { label: "Net Earnings (Pre-Expense)", val: formatCurrencySen(kpis.netSellerEarningsSen) },
          { label: "Platform Commission (2%)", val: formatCurrencySen(kpis.netCommissionSen) },
          { label: "Average Order Value", val: formatCurrencySen(kpis.averageOrderValueSen) },
          { label: "Verified / Completed Orders", val: `${kpis.verifiedOrders} / ${kpis.completedOrders}` },
          { label: "Units Sold", val: String(kpis.unitsSold) },
          { label: "Listing Views / Favourites", val: `${kpis.totalViews} / ${kpis.totalFavourites}` },
          { label: "Services (Req / Done)", val: `${kpis.serviceRequests} / ${kpis.completedServices}` },
          {
            label: "Verified Rating",
            val: kpis.averageRating !== null ? `${kpis.averageRating.toFixed(1)} ★ (${kpis.reviewCount})` : "No reviews yet",
          },
        ].map((c) => (
          <div key={c.label} className="rounded-2xl border border-[#E6E3EE] bg-white px-4 py-3">
            <p className="text-[11px] font-bold text-[#6B6779]">{c.label}</p>
            <p className="mt-1 text-base font-extrabold text-[#14121A]">{c.val}</p>
            {c.sub ? <p className="mt-0.5 text-[10.5px] font-semibold text-[#006A6D]">{c.sub}</p> : null}
          </div>
        ))}
      </div>

      {/* Deterministic Insights */}
      {analytics.insights.length > 0 ? (
        <div className="rounded-2xl border border-[#DCD0F0] bg-[#F7F3FD] p-4 text-xs text-[#3E2468]">
          <p className="font-extrabold">Data-Backed Observations</p>
          <ul className="mt-1.5 list-disc space-y-1 pl-4">
            {analytics.insights.map((ins) => (
              <li key={ins}>{ins}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Charts */}
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="rounded-2xl border border-[#E6E3EE] bg-white p-5 lg:col-span-2">
          <h2 className="mb-3 text-sm font-extrabold text-[#14121A]">Net Sales Trend (MYT)</h2>
          <TrendLineChart
            points={analytics.salesTrend.map((p) => ({ label: p.day, value: p.salesSen }))}
            valueFormatter={formatCurrencySen}
          />
        </div>
        <div className="space-y-4 rounded-2xl border border-[#E6E3EE] bg-white p-5">
          <div>
            <h2 className="mb-1 text-sm font-extrabold text-[#14121A]">
              Highest-Revenue Products (Proportional Est.)
            </h2>
            <p className="mb-2 text-[10.5px] text-[#6B6779]">
              Order-level refunds allocated proportionally in integer sen.
            </p>
            <HorizontalBarList
              items={analytics.topByRevenue.map((i) => ({ label: i.title, value: i.revenueSen, color: "#4E2A84" }))}
              valueFormatter={formatCurrencySen}
            />
          </div>
          <div className="border-t border-[#F1EFF6] pt-3">
            <h2 className="mb-2 text-sm font-extrabold text-[#14121A]">Best-Selling by Units</h2>
            <HorizontalBarList
              items={analytics.topByUnits.map((i) => ({ label: i.title, value: i.unitsSold, color: "#008285" }))}
              valueFormatter={(v) => `${v} units`}
            />
          </div>
        </div>
      </div>

      {/* Listing Performance Table */}
      <div className="overflow-x-auto rounded-2xl border border-[#E6E3EE] bg-white">
        <div className="border-b border-[#F1EFF6] px-4 py-3">
          <h2 className="text-sm font-extrabold text-[#14121A]">Listing Performance</h2>
        </div>
        <table className="w-full text-left text-xs">
          <thead className="border-b border-[#ECEAF3] bg-[#FAF9FC] text-[11px] font-bold text-[#6B6779]">
            <tr>
              <th className="px-4 py-2.5">Listing</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5">Stock</th>
              <th className="px-4 py-2.5">Views (Unique)</th>
              <th className="px-4 py-2.5">Favourites</th>
              <th className="px-4 py-2.5">Units Sold</th>
              <th className="px-4 py-2.5">Attributed Conversion</th>
              <th className="px-4 py-2.5">Orders / Viewer</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#F1EFF6]">
            {analytics.listingPerformance.map((l) => (
              <tr key={l.id}>
                <td className="px-4 py-2.5 font-bold text-[#14121A]">{l.title}</td>
                <td className="px-4 py-2.5 capitalize">{l.status}</td>
                <td className="px-4 py-2.5">{l.availableStock}</td>
                <td className="px-4 py-2.5">{l.views} ({l.uniqueViewers})</td>
                <td className="px-4 py-2.5">{l.favourites}</td>
                <td className="px-4 py-2.5 font-bold text-[#4E2A84]">{l.unitsSold}</td>
                <td className="px-4 py-2.5">{l.conversionPct !== null ? `${l.conversionPct}%` : "N/A"}</td>
                <td className="px-4 py-2.5">{l.ordersPerViewer != null ? l.ordersPerViewer.toFixed(2) : "N/A"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Seller Review Responses */}
      <div className="space-y-3 rounded-2xl border border-[#E6E3EE] bg-white p-5">
        <h2 className="inline-flex items-center gap-1.5 text-sm font-extrabold text-[#14121A]">
          <Star className="h-4 w-4 text-amber-500" />
          <span>Customer Reviews ({recentReviews.length})</span>
        </h2>
        {replyStatus ? <p className="text-xs font-semibold text-[#006A6D]">{replyStatus}</p> : null}
        {recentReviews.length === 0 ? (
          <p className="text-xs text-[#6B6779]">No verified reviews received yet.</p>
        ) : (
          recentReviews.map((r) => (
            <div key={r.id} className="space-y-2 rounded-xl border border-[#ECEAF3] bg-[#FAF9FC] p-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-extrabold text-amber-600">{"★".repeat(r.rating)} ({r.rating}/5)</span>
                <span className="text-[11px] text-[#8B869B]">{formatShortDate(r.createdAt)}</span>
              </div>
              <p className="text-[#14121A]">{r.comment}</p>
              {r.sellerResponse ? (
                <p className="rounded-lg bg-white p-2 text-[11px] text-[#4E2A84]">
                  <strong>Your Public Reply:</strong> {r.sellerResponse}
                </p>
              ) : (
                <div className="flex gap-2">
                  <input
                    value={replyDrafts[r.id] ?? ""}
                    onChange={(e) => setReplyDrafts((prev) => ({ ...prev, [r.id]: e.target.value }))}
                    placeholder="Write a public seller response..."
                    className="flex-1 rounded-lg border border-[#DFDCE8] bg-white px-2.5 py-1.5 text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => sendReply(r.id)}
                    className="rounded-lg bg-[#4E2A84] px-3 py-1.5 text-xs font-bold text-white"
                  >
                    Reply
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
