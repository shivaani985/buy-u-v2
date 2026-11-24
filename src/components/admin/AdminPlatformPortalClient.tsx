"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  AlertCircle,
  Download,
  TrendingUp,
  Sparkles,
  Shield,
} from "lucide-react";
import {
  adminModerateFreeNoticeAction,
  adminModerateListingAction,
  adminModerateReportAction,
  adminModerateReviewAction,
  adminModerateUserAction,
  adminToggleSpotOrCategoryAction,
} from "@/app/marketplace-actions";
import {
  HorizontalBarList,
  SimpleDonutBreakdown,
  TrendLineChart,
} from "@/components/analytics/SimpleCharts";
import type {
  AnalyticsRangeKey,
  computeAdminPlatformAnalytics,
} from "@/lib/analytics/metrics";
import { formatCurrencySen, formatShortDate } from "@/lib/format";

type AdminStats = ReturnType<typeof computeAdminPlatformAnalytics>;

export interface AdminPortalProps {
  range: AnalyticsRangeKey;
  customStart?: string | null;
  customEnd?: string | null;
  stats: AdminStats;
  users: Array<{
    id: string;
    displayName: string;
    email: string;
    role: string;
    status: string;
    faculty: string | null;
    createdAt: string;
  }>;
  listings: Array<{
    id: string;
    title: string;
    kind: string;
    status: string;
    sellerName: string;
    priceSen: number;
  }>;
  freeNotices: Array<{
    id: string;
    title: string;
    donorName: string;
    spotId: string;
    status: string;
    createdAt: string;
  }>;
  reports: Array<{
    id: string;
    reportCode: string;
    targetKind: string;
    targetId: string;
    reason: string;
    explanation: string;
    status: string;
    priority: string;
    createdAt: string;
  }>;
  reviews: Array<{
    id: string;
    rating: number;
    comment: string;
    hidden: boolean;
    createdAt: string;
  }>;
  catalog: {
    categories: Array<{ id: string; name: string; kind: string; active: boolean }>;
    collectionAreas: Array<{ id: string; name: string; active: boolean }>;
    donationSpots: Array<{ id: string; name: string; active: boolean }>;
  };
  auditLogs: Array<{
    id: string;
    action: string;
    targetKind: string;
    targetId: string | null;
    targetRef: string;
    reason: string;
    createdAt: string;
  }>;
}

type PortalTab =
  | "analytics"
  | "entrepreneurship"
  | "users"
  | "listings"
  | "reports"
  | "reviews"
  | "catalog"
  | "audit";

export function AdminPlatformPortalClient({
  range,
  customStart = null,
  customEnd = null,
  stats,
  users,
  listings,
  freeNotices,
  reports,
  reviews,
  catalog,
  auditLogs,
}: AdminPortalProps) {
  const router = useRouter();
  const [tab, setTab] = useState<PortalTab>("analytics");
  const [userSearch, setUserSearch] = useState("");
  const [startDate, setStartDate] = useState(customStart ?? "");
  const [endDate, setEndDate] = useState(customEnd ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const exportQuery =
    range === "custom" && customStart && customEnd
      ? `range=custom&start=${encodeURIComponent(customStart)}&end=${encodeURIComponent(customEnd)}`
      : `range=${range}`;

  async function run(key: string, fn: () => Promise<{ ok: boolean; message: string }>) {
    setBusy(key);
    setFeedback(null);
    const res = await fn();
    setBusy(null);
    setFeedback({ ok: res.ok, text: res.message });
    if (res.ok) router.refresh();
  }

  const filteredUsers = users.filter((u) => {
    if (!userSearch.trim()) return true;
    const q = userSearch.toLowerCase();
    return u.displayName.toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
  });

  const ov = stats.overview;
  const ent = stats.entrepreneurship;

  return (
    <div className="space-y-5">
      {/* Top Portal Navigation */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#E6E3EE] bg-white p-3.5">
        <div role="tablist" className="flex flex-wrap gap-1.5">
          {[
            { k: "analytics" as const, l: "Platform Analytics" },
            { k: "entrepreneurship" as const, l: "Student Entrepreneurship" },
            { k: "users" as const, l: `Users & Sellers (${users.length})` },
            { k: "listings" as const, l: `Listings (${listings.length})` },
            { k: "reports" as const, l: `Reports (${reports.length})` },
            { k: "reviews" as const, l: `Reviews (${reviews.length})` },
            { k: "catalog" as const, l: "Categories & Spots" },
            { k: "audit" as const, l: `Audit Logs (${auditLogs.length})` },
          ].map((t) => (
            <button
              key={t.k}
              type="button"
              role="tab"
              aria-selected={tab === t.k}
              onClick={() => setTab(t.k)}
              className={`rounded-xl px-3 py-1.5 text-xs font-bold ${
                tab === t.k
                  ? "bg-[#4E2A84] text-white"
                  : "border border-[#E6E3EE] bg-[#FAF9FC] text-[#4A4656] hover:border-[#4E2A84]"
              }`}
            >
              {t.l}
            </button>
          ))}
        </div>

        <a
          href={`/api/admin/analytics/export?${exportQuery}`}
          className="inline-flex items-center gap-1.5 rounded-xl border border-[#4E2A84] px-3 py-1.5 text-xs font-bold text-[#4E2A84] hover:bg-[#F3EEFA]"
        >
          <Download className="h-3.5 w-3.5" />
          <span>Export Analytics CSV</span>
        </a>
      </div>

      {/* Date Range Filter Strip (including Custom MYT dates) */}
      {tab === "analytics" || tab === "entrepreneurship" ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-bold text-[#6B6779]">Date Scope (MYT):</span>
          {(["7d", "30d", "90d", "this_month", "all"] as const).map((rk) => (
            <Link
              key={rk}
              href={`/admin?range=${rk}`}
              className={`rounded-lg px-2.5 py-1 font-bold ${
                range === rk
                  ? "bg-[#008285] text-white"
                  : "border border-[#E6E3EE] bg-white text-[#4A4656]"
              }`}
            >
              {rk === "this_month" ? "This Month" : rk === "all" ? "All Time" : `Last ${rk}`}
            </Link>
          ))}
          <form
            className="flex flex-wrap items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (startDate && endDate && endDate >= startDate) {
                router.push(`/admin?range=custom&start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(endDate)}`);
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
            <span className="text-[#6B6779]">to</span>
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
              className="rounded-lg bg-[#4E2A84] px-2.5 py-1 font-bold text-white disabled:opacity-40"
            >
              Apply
            </button>
          </form>
        </div>
      ) : null}

      {feedback ? (
        <p
          role={feedback.ok ? "status" : "alert"}
          className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-xs font-semibold ${
            feedback.ok
              ? "border-[#B8E3E4] bg-[#F2FAFA] text-[#006A6D]"
              : "border-[#F9C6C2] bg-[#FEF2F2] text-[#B42318]"
          }`}
        >
          {feedback.ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
          <span>{feedback.text}</span>
        </p>
      ) : null}

      {/* TAB: PLATFORM ANALYTICS (Phase 9A) */}
      {tab === "analytics" ? (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {[
              { l: "Registered Members", v: `${ov.totalMembers} (${ov.studentsCount} stu / ${ov.staffCount} staff)` },
              { l: "Measured Active Users", v: String(ov.measuredActiveUsers) },
              { l: "Active Sellers / Listings", v: `${ov.activeSellers} / ${ov.activeListings}` },
              { l: "Verified / Completed Orders", v: `${ov.verifiedTransactions} / ${ov.completedOrders}` },
              { l: "Gross Verified Sales", v: formatCurrencySen(ov.grossProductSalesSen) },
              { l: "Net Product Sales", v: formatCurrencySen(ov.netProductSalesSen) },
              { l: "Net Commission (2%)", v: formatCurrencySen(ov.netPlatformCommissionSen) },
              { l: "Average Order Value", v: formatCurrencySen(ov.averageOrderValueSen) },
              { l: "Completed Services", v: String(ov.completedServices) },
              { l: "Completed Donations", v: `${ov.completedDonations} (${stats.community.totalUnitsDonated} units)` },
            ].map((k) => (
              <div key={k.l} className="rounded-2xl border border-[#E6E3EE] bg-white px-4 py-3">
                <p className="text-[11px] font-bold text-[#6B6779]">{k.l}</p>
                <p className="mt-1 text-sm font-extrabold text-[#14121A]">{k.v}</p>
              </div>
            ))}
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            <div className="rounded-2xl border border-[#E6E3EE] bg-white p-5 lg:col-span-2">
              <h3 className="mb-3 inline-flex items-center gap-1.5 text-sm font-extrabold text-[#14121A]">
                <TrendingUp className="h-4 w-4 text-[#4E2A84]" />
                <span>Verified Net Product Sales Trend</span>
              </h3>
              <TrendLineChart
                points={stats.salesTrend.map((p) => ({ label: p.day, value: p.amountSen }))}
                valueFormatter={formatCurrencySen}
              />
            </div>

            <div className="space-y-4 rounded-2xl border border-[#E6E3EE] bg-white p-5">
              <h3 className="text-sm font-extrabold text-[#14121A]">Listings by Type</h3>
              <SimpleDonutBreakdown
                segments={[
                  { label: "Pre-Loved", value: stats.listingsByType.preLoved, color: "#4E2A84" },
                  { label: "Student Business", value: stats.listingsByType.studentBusiness, color: "#008285" },
                  { label: "Services", value: stats.listingsByType.services, color: "#D97706" },
                  { label: "Free Items", value: stats.listingsByType.freeItems, color: "#16A34A" },
                ]}
              />
            </div>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <div className="rounded-2xl border border-[#E6E3EE] bg-white p-5">
              <h3 className="mb-1 text-sm font-extrabold text-[#14121A]">
                Sales by Category (Proportional Est.)
              </h3>
              <p className="mb-3 text-[11px] text-[#6B6779]">
                Order-level refunds allocated proportionally across items via exact integer-sen distribution.
              </p>
              <HorizontalBarList
                items={stats.categorySales.slice(0, 6).map((c) => ({
                  label: c.categoryId,
                  value: c.amountSen,
                  color: "#4E2A84",
                }))}
                valueFormatter={formatCurrencySen}
              />
            </div>
            <div className="space-y-2 rounded-2xl border border-[#E6E3EE] bg-white p-5 text-xs">
              <h3 className="inline-flex items-center gap-1.5 text-sm font-extrabold text-[#14121A]">
                <Shield className="h-4 w-4 text-[#008285]" />
                <span>Engagement &amp; Trust Metrics</span>
              </h3>
              <p>Legitimate Listing Views: <strong>{stats.engagement.totalViews}</strong> ({stats.engagement.uniqueViewers} unique viewers)</p>
              <p>Saved Favourites: <strong>{stats.engagement.totalFavourites}</strong></p>
              <p>Reports: <strong>{stats.trustAndSafety.openReports} open</strong> · {stats.trustAndSafety.resolvedReports} resolved</p>
              <p>Disputes: <strong>{stats.trustAndSafety.activeDisputes} active</strong> · {stats.trustAndSafety.resolvedDisputes} resolved (rate: {stats.trustAndSafety.disputeRatePct !== null ? `${stats.trustAndSafety.disputeRatePct}%` : "N/A"})</p>
              <p>Restricted / Suspended Accounts: <strong>{ov.restrictedCount}</strong> · Hidden Reviews: <strong>{stats.trustAndSafety.hiddenReviews}</strong></p>
            </div>
          </div>
        </div>
      ) : null}

      {/* TAB: STUDENT ENTREPRENEURSHIP INSIGHTS (Section 11) */}
      {tab === "entrepreneurship" ? (
        <div className="space-y-4">
          <div className="rounded-2xl border border-[#DCD0F0] bg-[#F7F3FD] p-4 text-xs text-[#3E2468]">
            <p className="inline-flex items-center gap-1.5 font-extrabold">
              <Sparkles className="h-4 w-4" />
              <span>Student Entrepreneurship &amp; Community Impact (FYP Evaluation Metrics)</span>
            </p>
            <p className="mt-1">
              Distinguishes Student Business entrepreneurs from one-off Pre-Loved sellers, Service Providers, and Community Donors using verified database transactions only.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {[
              { l: "Published Student Business Sellers", v: String(ent.publishedStudentBusinessSellers) },
              { l: "Active Business Sellers (Period)", v: String(ent.activeStudentBusinessSellers) },
              { l: "First-Time Business Sellers (Qualifying)", v: String(ent.firstTimeSuccessfulBusinessSellers) },
              { l: "First-Time Marketplace Sellers (Any)", v: String(ent.firstTimeSuccessfulSellers) },
              { l: "Student Business Net Sales", v: formatCurrencySen(ent.studentBusinessSalesSen) },
              { l: "Business Seller Earnings (Pre-Exp)", v: formatCurrencySen(ent.studentBusinessEarningsSen) },
              { l: "Avg Earnings / Active Business Seller", v: formatCurrencySen(ent.avgEarningsPerBusinessSellerSen) },
              { l: "Active Student Service Providers", v: String(ent.activeServiceProviders) },
              { l: "Pre-Loved Sellers / Completed Resales", v: `${ent.preLovedSellersCount} / ${ent.preLovedCompletedTransactions}` },
              { l: "Repeat Buyers / Donors (Units)", v: `${ent.repeatBuyers} / ${ent.donorsCount} (${ent.donatedUnits}u)` },
            ].map((k) => (
              <div key={k.l} className="rounded-2xl border border-[#E6E3EE] bg-white px-4 py-3">
                <p className="text-[11px] font-bold text-[#6B6779]">{k.l}</p>
                <p className="mt-1 text-base font-extrabold text-[#4E2A84]">{k.v}</p>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* TAB: USERS & SELLERS MODERATION */}
      {tab === "users" ? (
        <div className="space-y-3">
          <input
            type="search"
            value={userSearch}
            onChange={(e) => setUserSearch(e.target.value)}
            placeholder="Search members by name or UMS email..."
            className="w-full max-w-sm rounded-xl border border-[#DFDCE8] bg-white px-3 py-2 text-xs"
          />
          <div className="overflow-x-auto rounded-2xl border border-[#E6E3EE] bg-white">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[#ECEAF3] bg-[#FAF9FC] text-[11px] font-bold text-[#6B6779]">
                <tr>
                  <th className="px-4 py-2.5">Member</th>
                  <th className="px-4 py-2.5">Role</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Moderation Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F1EFF6]">
                {filteredUsers.map((u) => (
                  <tr key={u.id}>
                    <td className="px-4 py-2.5">
                      <p className="font-bold text-[#14121A]">{u.displayName}</p>
                      <p className="font-mono text-[10.5px] text-[#6B6779]">{u.email}</p>
                    </td>
                    <td className="px-4 py-2.5 capitalize">{u.role}</td>
                    <td className="px-4 py-2.5 font-bold capitalize">{u.status}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() =>
                            run(`warn:${u.id}`, () =>
                              adminModerateUserAction({ userId: u.id, action: "warn", reason: "Official moderation reminder." })
                            )
                          }
                          className="rounded-lg border border-[#E6E3EE] px-2.5 py-1 text-[11px] font-bold"
                        >
                          Warn
                        </button>
                        {u.status === "active" ? (
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() =>
                              run(`rest:${u.id}`, () =>
                                adminModerateUserAction({ userId: u.id, action: "restrict", reason: "Policy review restriction." })
                              )
                            }
                            className="rounded-lg border border-[#F9C6C2] px-2.5 py-1 text-[11px] font-bold text-[#B42318]"
                          >
                            Restrict
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() =>
                              run(`act:${u.id}`, () =>
                                adminModerateUserAction({ userId: u.id, action: "restore", reason: "Account restored after review." })
                              )
                            }
                            className="rounded-lg border border-[#008285] px-2.5 py-1 text-[11px] font-bold text-[#008285]"
                          >
                            Restore Active
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {/* TAB: LISTINGS & FREE ITEMS MODERATION */}
      {tab === "listings" ? (
        <div className="space-y-5">
          <div className="overflow-x-auto rounded-2xl border border-[#E6E3EE] bg-white">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[#ECEAF3] bg-[#FAF9FC] text-[11px] font-bold text-[#6B6779]">
                <tr>
                  <th className="px-4 py-2.5">Listing</th>
                  <th className="px-4 py-2.5">Type</th>
                  <th className="px-4 py-2.5">Seller</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F1EFF6]">
                {listings.map((l) => (
                  <tr key={l.id}>
                    <td className="px-4 py-2.5 font-bold text-[#14121A]">{l.title}</td>
                    <td className="px-4 py-2.5 capitalize">{l.kind.replace("_", " ")}</td>
                    <td className="px-4 py-2.5">{l.sellerName}</td>
                    <td className="px-4 py-2.5 font-bold capitalize">{l.status}</td>
                    <td className="px-4 py-2.5">
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() =>
                          run(`lst:${l.id}`, () =>
                            adminModerateListingAction({
                              listingId: l.id,
                              hide: l.status !== "hidden",
                              reason: l.status !== "hidden" ? "Admin policy moderation hide" : "Admin restored listing",
                            })
                          )
                        }
                        className="rounded-lg border border-[#4E2A84] px-2.5 py-1 text-[11px] font-bold text-[#4E2A84]"
                      >
                        {l.status !== "hidden" ? "Hide Listing" : "Restore"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="overflow-x-auto rounded-2xl border border-[#E6E3EE] bg-white">
            <div className="border-b border-[#ECEAF3] bg-[#FAF9FC] px-4 py-2.5 text-xs font-extrabold text-[#14121A]">
              Community Free Items Moderation ({freeNotices.length})
            </div>
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[#ECEAF3] bg-[#FAF9FC] text-[11px] font-bold text-[#6B6779]">
                <tr>
                  <th className="px-4 py-2.5">Free Item</th>
                  <th className="px-4 py-2.5">Donor</th>
                  <th className="px-4 py-2.5">Spot</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F1EFF6]">
                {freeNotices.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-[#6B6779]">No free item notices posted yet.</td>
                  </tr>
                ) : (
                  freeNotices.map((fn) => (
                    <tr key={fn.id}>
                      <td className="px-4 py-2.5 font-bold text-[#14121A]">{fn.title}</td>
                      <td className="px-4 py-2.5">{fn.donorName}</td>
                      <td className="px-4 py-2.5">{fn.spotId}</td>
                      <td className="px-4 py-2.5 font-bold capitalize">{fn.status}</td>
                      <td className="px-4 py-2.5">
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() =>
                            run(`fn:${fn.id}`, () =>
                              adminModerateFreeNoticeAction({
                                noticeId: fn.id,
                                hide: fn.status !== "hidden",
                                reason:
                                  fn.status !== "hidden"
                                    ? "Admin policy moderation hide"
                                    : "Admin restored free item",
                              })
                            )
                          }
                          className="rounded-lg border border-[#008285] px-2.5 py-1 text-[11px] font-bold text-[#008285]"
                        >
                          {fn.status !== "hidden" ? "Hide Free Item" : "Restore"}
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {/* TAB: REPORTS QUEUE */}
      {tab === "reports" ? (
        <div className="space-y-3">
          {reports.length === 0 ? (
            <p className="rounded-2xl border border-[#E6E3EE] bg-white p-8 text-center text-xs text-[#6B6779]">No member reports submitted yet.</p>
          ) : (
            reports.map((r) => (
              <div key={r.id} className="space-y-2 rounded-2xl border border-[#E6E3EE] bg-white p-4 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono font-extrabold text-[#14121A]">
                    {r.reportCode} · {r.targetKind} · {r.reason}
                  </span>
                  <span className="rounded-full bg-[#F3EEFA] px-2.5 py-0.5 text-[11px] font-bold capitalize text-[#4E2A84]">
                    {r.priority} · {r.status}
                  </span>
                </div>
                <p className="text-[#4A4656]">{r.explanation}</p>
                {r.status === "submitted" || r.status === "under_review" ? (
                  <div className="flex flex-wrap gap-2">
                    {r.status === "submitted" ? (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() =>
                          run(`rpt-rev:${r.id}`, () =>
                            adminModerateReportAction({ reportId: r.id, status: "under_review", outcome: "Under review", reason: "Moderator started investigation." })
                          )
                        }
                        className="rounded-lg border border-[#4E2A84] px-3 py-1 text-xs font-bold text-[#4E2A84]"
                      >
                        Mark Under Review
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() =>
                        run(`rpt-res:${r.id}`, () =>
                          adminModerateReportAction({ reportId: r.id, status: "resolved", outcome: "Action taken", reason: "Verified and resolved by admin." })
                        )
                      }
                      className="rounded-lg bg-[#008285] px-3 py-1 text-xs font-bold text-white"
                    >
                      Mark Resolved
                    </button>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() =>
                        run(`rpt-dis:${r.id}`, () =>
                          adminModerateReportAction({ reportId: r.id, status: "dismissed", outcome: "No violation", reason: "Reviewed; no policy violation found." })
                        )
                      }
                      className="rounded-lg border border-[#E6E3EE] px-3 py-1 text-xs font-bold text-[#4A4656]"
                    >
                      Dismiss
                    </button>
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
      ) : null}

      {/* TAB: REVIEWS MODERATION */}
      {tab === "reviews" ? (
        <div className="space-y-3">
          {reviews.length === 0 ? (
            <p className="rounded-2xl border border-[#E6E3EE] bg-white p-8 text-center text-xs text-[#6B6779]">No verified reviews to moderate yet.</p>
          ) : (
            reviews.map((rv) => (
              <div key={rv.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#E6E3EE] bg-white p-4 text-xs">
                <div>
                  <p className="font-bold text-[#14121A]">
                    {"★".repeat(rv.rating)} ({rv.rating}/5) · {rv.hidden ? "Hidden" : "Published"}
                  </p>
                  <p className="mt-0.5 text-[#4A4656]">{rv.comment}</p>
                </div>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() =>
                    run(`rev:${rv.id}`, () =>
                      adminModerateReviewAction({
                        reviewId: rv.id,
                        hide: !rv.hidden,
                        reason: rv.hidden ? "Restored after admin review" : "Hidden for review policy violation",
                      })
                    )
                  }
                  className="rounded-lg border border-[#4E2A84] px-3 py-1 text-xs font-bold text-[#4E2A84]"
                >
                  {rv.hidden ? "Restore Review" : "Hide Review"}
                </button>
              </div>
            ))
          )}
        </div>
      ) : null}

      {/* TAB: CATEGORIES, COLLECTION AREAS & DONATION SPOTS */}
      {tab === "catalog" ? (
        <div className="grid gap-4 md:grid-cols-3">
          {(
            [
              ["Categories", "categories" as const, catalog.categories],
              ["Collection Areas", "collection_areas" as const, catalog.collectionAreas],
              ["Donation Spots", "donation_spots" as const, catalog.donationSpots],
            ] as const
          ).map(([title, table, rows]) => (
            <div key={title} className="space-y-2 rounded-2xl border border-[#E6E3EE] bg-white p-4 text-xs">
              <h3 className="font-extrabold text-[#14121A]">{title}</h3>
              {rows.map((row) => (
                <div key={row.id} className="flex items-center justify-between border-b border-[#F1EFF6] py-1.5">
                  <span className="font-semibold">{row.name}</span>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      run(`cat:${table}:${row.id}`, () =>
                        adminToggleSpotOrCategoryAction({ table, id: row.id, active: !row.active })
                      )
                    }
                    className={`rounded-full px-2.5 py-0.5 text-[10.5px] font-bold ${
                      row.active ? "bg-[#E6F6F6] text-[#006A6D]" : "bg-[#F1EFF6] text-[#6B6779]"
                    }`}
                  >
                    {row.active ? "Active" : "Inactive"}
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}

      {/* TAB: CENTRALIZED AUDIT LOGS */}
      {tab === "audit" ? (
        <div className="overflow-x-auto rounded-2xl border border-[#E6E3EE] bg-white">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-[#ECEAF3] bg-[#FAF9FC] text-[11px] font-bold text-[#6B6779]">
              <tr>
                <th className="px-4 py-2.5">Action</th>
                <th className="px-4 py-2.5">Target</th>
                <th className="px-4 py-2.5">Reason</th>
                <th className="px-4 py-2.5">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F1EFF6]">
              {auditLogs.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-[#6B6779]">No admin audit entries recorded yet.</td>
                </tr>
              ) : (
                auditLogs.map((a) => (
                  <tr key={a.id}>
                    <td className="px-4 py-2.5 font-mono font-bold text-[#4E2A84]">{a.action}</td>
                    <td className="px-4 py-2.5">{a.targetKind} ({a.targetRef})</td>
                    <td className="px-4 py-2.5">{a.reason}</td>
                    <td className="px-4 py-2.5 text-[#6B6779]">{formatShortDate(a.createdAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
