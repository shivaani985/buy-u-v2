import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  Coins,
  ExternalLink,
  FileText,
  Hourglass,
  Info,
  Landmark,
  Layers,
  ListOrdered,
  MessageCircle,
  Package,
  PlusCircle,
  Radio,
  ShieldCheck,
  Store,
  Wallet,
  Zap,
} from "lucide-react";
import { initializeStorefrontAction } from "@/app/seller/actions";
import { DeleteListingButton } from "@/components/seller/DeleteListingButton";
import { SalesRangeSelect } from "@/components/seller/SalesRangeSelect";
import { SellerGate } from "@/components/seller/SellerGate";
import { SellerNav } from "@/components/seller/SellerNav";
import { WeeklySalesChart } from "@/components/seller/WeeklySalesChart";
import { ListingImage } from "@/components/shared/ListingImage";
import { formatRelativeTime } from "@/lib/format";
import { getHeaderCounters } from "@/lib/header-counts";
import { getSellerHubData } from "@/lib/seller/data";
import {
  parseSalesRange,
  type SellerTransactionItem,
} from "@/lib/seller/financials";
import { evaluateSellerEligibility } from "@/lib/seller/validation";
import { getSessionSummary } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Seller Hub",
  description:
    "Your campus selling dashboard. Track verified sales, manage listings, and grow your storefront on Buy-U.",
};

function formatRm(sen: number): string {
  return `RM ${(Math.max(0, sen) / 100).toFixed(2)}`;
}

function formatPriceNumber(sen: number): string {
  return (Math.max(0, sen) / 100).toFixed(2);
}

/**
 * Plain-text muted colors only — strictly NO pill backgrounds.
 */
function getListingStatusText(
  status: string,
  availableStock: number,
  kind: string
): { label: string; colorClass: string } {
  if (status === "published" && kind !== "service" && availableStock === 0) {
    return { label: "Out of Stock", colorClass: "text-[#B42318]" };
  }
  if (status === "published") {
    return { label: "Live", colorClass: "text-[#0F766E]" };
  }
  if (status === "draft") {
    return { label: "Draft", colorClass: "text-[#6E6A7C]" };
  }
  return { label: status, colorClass: "text-[#6E6A7C]" };
}

function getTransactionToneClass(
  tone: SellerTransactionItem["statusTone"]
): string {
  switch (tone) {
    case "live":
      return "text-[#0F766E]";
    case "pending":
      return "text-[#B45309]";
    case "paid_out":
      return "text-[#4E2A84]";
    case "danger":
      return "text-[#B42318]";
    default:
      return "text-[#6E6A7C]";
  }
}

interface SellerHubPageProps {
  searchParams: Promise<{ range?: string }>;
}

export default async function SellerHubPage({
  searchParams,
}: SellerHubPageProps) {
  const params = await searchParams;
  const range = parseSalesRange(params.range);

  const session = await getSessionSummary();
  const eligibility = evaluateSellerEligibility(session);

  if (!eligibility.eligible) {
    return <SellerGate eligibility={eligibility} nextPath="/seller" />;
  }

  const [hub, counters] = await Promise.all([
    getSellerHubData(session, range),
    getHeaderCounters(session),
  ]);
  const newOrderCount = hub.newOrderCount;

  const displayName =
    session.profile?.display_name ||
    session.profile?.full_name ||
    session.email?.split("@")[0] ||
    "UMS Student";
  const shopInitials = (hub.storefront?.shopName || displayName)
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  // ONE consistent neutral KPI card class shared by all 8 cards
  const kpiCardClass =
    "rounded-2xl border border-[#E6E3EE] border-l-[3px] border-l-[#4E2A84] bg-white px-4 py-3.5 shadow-[0_1px_4px_rgba(20,18,26,0.03)]";

  const listingKpis = [
    { label: "Total Listings", value: hub.counts.total, icon: Layers },
    { label: "Published Live", value: hub.counts.published, icon: Radio },
    { label: "Saved Drafts", value: hub.counts.draft, icon: FileText },
    { label: "Out of Stock", value: hub.counts.soldOut, icon: Package },
  ];

  const fin = hub.financials;
  const financialKpis = [
    {
      label: "Total Sales",
      value: fin.available ? formatRm(fin.totalSalesSen) : "Not available yet",
      icon: BarChart3,
      hint:
        fin.available && fin.verifiedOrderCount > 0
          ? `${fin.verifiedOrderCount} verified ${fin.verifiedOrderCount === 1 ? "order" : "orders"}`
          : fin.unavailableReason,
    },
    {
      label: "Pending Settlement",
      value: fin.available
        ? formatRm(fin.pendingSettlementSen)
        : "Not available yet",
      icon: Hourglass,
      hint: fin.available
        ? [
            fin.protectionReserveSen > 0
              ? `72h Reserve: ${formatRm(fin.protectionReserveSen)}`
              : null,
            fin.frozenDisputeSen > 0
              ? `Frozen (Disputes): ${formatRm(fin.frozenDisputeSen)}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ") || undefined
        : undefined,
      tooltip:
        "Verified paid orders awaiting handover/confirmation. Completed orders enter a 72-hour Buyer Protection Reserve before becoming withdrawable.",
    },
    {
      label: "Available for Payout",
      value: fin.available
        ? formatRm(fin.availableForPayoutSen)
        : "Not available yet",
      icon: Wallet,
      hint:
        fin.available && fin.commissionTotalSen > 0
          ? "Net after platform commission"
          : undefined,
    },
    {
      label: "Total Paid Out",
      value: fin.available
        ? formatRm(fin.totalPaidOutSen)
        : "Not available yet",
      icon: Coins,
    },
  ];

  return (
    <div className="bg-[#FAFAFC]">
      <div className="bori-container py-6 lg:py-8">
        {/* Top Editorial Header */}
        <div>
          <h1 className="text-3xl font-extrabold italic tracking-[-0.02em] text-[#111018] sm:text-[36px]">
            Seller{" "}
            <span className="inline-block bg-[#4E2A84] px-3 py-0.5 text-white hero-marketplace-slab">
              Hub
            </span>
          </h1>
          <p className="mt-1.5 text-sm text-[#555062]">
            Your campus selling dashboard. Track sales, manage listings, and
            grow your storefront on Buy-U.
          </p>
        </div>

        {/* Shared Seller Navigation */}
        <div className="mt-4">
          <SellerNav newOrderCount={newOrderCount} />
        </div>

        {hub.error ? (
          <div
            role="alert"
            className="mt-5 rounded-xl border border-[#B42318]/30 bg-white px-4 py-3 text-sm text-[#B42318]"
          >
            {hub.error}
          </div>
        ) : null}

        {/* Main 2-Column Dashboard Grid */}
        <div className="mt-5 grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* LEFT MAIN CONTENT */}
          <div className="space-y-6 lg:col-span-8 xl:col-span-9">
            {/* 1. Listing Summary — 4 Uniform Neutral KPI Cards */}
            <section
              aria-label="Listing summary"
              className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4"
            >
              {listingKpis.map((kpi) => {
                const Icon = kpi.icon;
                return (
                  <div
                    key={kpi.label}
                    className={`${kpiCardClass} flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-2`}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <Icon
                        className="h-4 w-4 shrink-0 text-[#4E2A84]"
                        aria-hidden="true"
                      />
                      <span className="text-[10.5px] font-bold uppercase leading-tight tracking-wider text-[#555062] sm:text-[11px]">
                        {kpi.label}
                      </span>
                    </div>
                    <span className="tabular-price shrink-0 text-2xl font-extrabold tracking-tight text-[#4E2A84]">
                      {kpi.value}
                    </span>
                  </div>
                );
              })}
            </section>

            {/* 2. Earnings & Payouts Panel */}
            <section
              aria-labelledby="earnings-heading"
              className="rounded-2xl border border-[#E6E3EE] bg-white p-5 shadow-[0_1px_4px_rgba(20,18,26,0.03)]"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2
                  id="earnings-heading"
                  className="flex items-center gap-2 text-lg font-extrabold italic tracking-[-0.02em] text-[#111018] sm:text-xl"
                >
                  <Coins
                    className="h-5 w-5 text-[#4E2A84]"
                    aria-hidden="true"
                  />
                  <span>Earnings &amp; Payouts</span>
                </h2>
                <SalesRangeSelect value={range} />
              </div>

              {/* 4 Financial KPI Cards — Exact Same Neutral Style */}
              <div className="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
                {financialKpis.map((kpi) => {
                  const Icon = kpi.icon;
                  return (
                    <div key={kpi.label} className={kpiCardClass}>
                      <div className="flex items-center justify-between gap-1.5">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <Icon
                            className="h-3.5 w-3.5 shrink-0 text-[#4E2A84]"
                            aria-hidden="true"
                          />
                          <span className="truncate text-[10.5px] font-bold uppercase tracking-wider text-[#555062]">
                            {kpi.label}
                          </span>
                        </div>
                        {kpi.tooltip ? (
                          <span
                            title={kpi.tooltip}
                            aria-label={kpi.tooltip}
                            className="shrink-0 text-[#858094] hover:text-[#4E2A84]"
                          >
                            <Info className="h-3.5 w-3.5" aria-hidden="true" />
                          </span>
                        ) : null}
                      </div>

                      <p
                        className={`tabular-price mt-2 font-extrabold tracking-tight text-[#4E2A84] ${
                          fin.available ? "text-xl sm:text-[22px]" : "text-sm"
                        }`}
                      >
                        {kpi.value}
                      </p>

                      {kpi.hint ? (
                        <p className="mt-0.5 text-[11px] text-[#6E6A7C]">
                          {kpi.hint}
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              {/* Weekly Sales Chart + Recent Orders / Transactions */}
              <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-12">
                {/* Weekly Sales Chart */}
                <div className="xl:col-span-6">
                  <h3 className="text-sm font-extrabold text-[#14121A]">
                    Weekly Sales (RM)
                  </h3>
                  <div className="mt-3">
                    <WeeklySalesChart
                      points={fin.chartPoints}
                      available={fin.available}
                    />
                  </div>
                </div>

                {/* Recent Orders / Transactions */}
                <div className="xl:col-span-6">
                  <div className="flex items-center justify-between">
                    <h3 className="flex items-center gap-1.5 text-sm font-extrabold italic text-[#14121A]">
                      <ListOrdered
                        className="h-4 w-4 text-[#4E2A84]"
                        aria-hidden="true"
                      />
                      <span>Recent Orders / Transactions</span>
                    </h3>
                  </div>

                  {!fin.available ? (
                    <p className="mt-3 rounded-xl border border-[#ECEAF2] bg-[#FAFAFC] p-4 text-xs text-[#6E6A7C]">
                      Order history is not available yet.
                    </p>
                  ) : fin.transactions.length === 0 ? (
                    <div className="mt-3 flex h-[180px] flex-col items-center justify-center rounded-xl border border-[#ECEAF2] bg-[#FAFAFC] p-4 text-center">
                      <p className="text-xs font-bold text-[#14121A]">
                        No orders yet
                      </p>
                      <p className="mt-1 text-[11.5px] text-[#6E6A7C]">
                        Verified student and staff purchases will appear here.
                      </p>
                    </div>
                  ) : (
                    <div className="mt-3 divide-y divide-[#F0EDF5] border-t border-[#F0EDF5]">
                      {fin.transactions.map((tx) => (
                        <div
                          key={tx.id}
                          className="grid grid-cols-12 items-center gap-2 py-2.5 text-xs"
                        >
                          <span className="col-span-4 truncate font-mono font-bold text-[#14121A] sm:col-span-3">
                            #{tx.orderCode}
                          </span>
                          <span className="col-span-4 truncate text-[#3E3B4B] sm:col-span-4">
                            {tx.itemTitle}
                          </span>
                          <span className="tabular-price col-span-2 text-right font-bold text-[#14121A] sm:col-span-3">
                            {formatRm(tx.amountSen)}
                          </span>
                          <span
                            className={`col-span-2 text-right font-bold ${getTransactionToneClass(
                              tx.statusTone
                            )}`}
                          >
                            {tx.statusLabel}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </section>

            {/* 3. Your Campus Listings — Clean Table (Zero Colored Pills) */}
            <section aria-labelledby="campus-listings-heading">
              <div className="flex items-center justify-between pb-3">
                <h2
                  id="campus-listings-heading"
                  className="text-lg font-extrabold italic tracking-[-0.02em] text-[#111018] sm:text-xl"
                >
                  Your Campus Listings
                </h2>
                <Link
                  href="/sell"
                  className="inline-flex items-center gap-1 text-xs font-bold text-[#4E2A84] hover:underline sm:text-sm"
                >
                  <span>New Listing</span>
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              </div>

              {hub.listings.length === 0 ? (
                <div className="flex flex-col items-center gap-4 rounded-2xl border border-[#E6E3EE] bg-white p-6 text-center sm:flex-row sm:text-left">
                  <div className="relative h-20 w-20 shrink-0">
                    <Image
                      src="/images/bori/bori-free-items.png"
                      alt="Bori holding a campus box"
                      fill
                      sizes="80px"
                      className="object-contain select-none"
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-base font-extrabold text-[#14121A]">
                      No listings posted yet
                    </h3>
                    <p className="mt-1 text-sm text-[#555062]">
                      Create your first campus listing to start selling
                      pre-loved goods, student ventures, food, or services.
                    </p>
                    <Link
                      href="/sell"
                      className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-[#4E2A84] px-4 py-2 text-xs font-bold text-white hover:bg-[#3A1E66] press-feedback"
                    >
                      <PlusCircle className="h-4 w-4" aria-hidden="true" />
                      <span>Create Listing</span>
                    </Link>
                  </div>
                </div>
              ) : (
                <div className="overflow-hidden rounded-2xl border border-[#E6E3EE] bg-white shadow-[0_1px_4px_rgba(20,18,26,0.03)]">
                  {/* Desktop & Tablet Table */}
                  <div className="hidden overflow-x-auto sm:block">
                    <table className="w-full border-collapse text-left text-sm">
                      <thead>
                        <tr className="border-b border-[#ECEAF2] bg-[#FAFAFC] text-[11px] font-bold uppercase tracking-wider text-[#6E6A7C]">
                          <th className="px-4 py-3">Item</th>
                          <th className="px-3 py-3">Category</th>
                          <th className="px-3 py-3">Price (RM)</th>
                          <th className="px-3 py-3">Stock</th>
                          <th className="px-3 py-3">Status</th>
                          <th className="px-3 py-3">Updated</th>
                          <th className="px-4 py-3 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#F0EDF5]">
                        {hub.listings.map((item) => {
                          const st = getListingStatusText(
                            item.status,
                            item.availableStock,
                            item.kind
                          );
                          const fallback = (
                            <div className="flex h-full w-full items-center justify-center bg-[#F5F4F8] text-[#6E6A7C]">
                              <Package className="h-4 w-4" aria-hidden="true" />
                            </div>
                          );
                          return (
                            <tr
                              key={item.id}
                              className="transition-colors hover:bg-[#FAFAFC]"
                            >
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-3">
                                  <div className="relative h-10 w-12 shrink-0 overflow-hidden rounded-lg border border-[#ECEAF2] bg-[#F5F4F8]">
                                    <ListingImage
                                      src={item.imageUrl}
                                      alt={item.title}
                                      fallback={fallback}
                                    />
                                  </div>
                                  <span className="max-w-[200px] truncate font-bold text-[#14121A]">
                                    {item.title}
                                  </span>
                                </div>
                              </td>
                              <td className="px-3 py-3 text-xs font-medium text-[#555062]">
                                {item.categoryName}
                              </td>
                              <td className="tabular-price px-3 py-3 text-xs font-bold text-[#14121A]">
                                {formatPriceNumber(item.priceSen)}
                              </td>
                              <td className="px-3 py-3 text-xs font-semibold text-[#3E3B4B]">
                                {item.kind === "service"
                                  ? "—"
                                  : item.availableStock}
                              </td>
                              <td
                                className={`px-3 py-3 text-xs font-bold ${st.colorClass}`}
                              >
                                {st.label}
                              </td>
                              <td className="px-3 py-3 text-xs text-[#6E6A7C]">
                                {formatRelativeTime(item.updatedAt)}
                              </td>
                              <td className="px-4 py-3 text-right text-xs">
                                <div className="inline-flex items-center justify-end gap-3">
                                  <Link
                                    href={`/sell/${encodeURIComponent(item.id)}`}
                                    className="font-bold text-[#4E2A84] hover:underline"
                                  >
                                    Edit
                                  </Link>
                                  {item.status === "published" ? (
                                    <Link
                                      href={`/listings/${encodeURIComponent(item.id)}`}
                                      className="inline-flex items-center gap-1 font-semibold text-[#555062] hover:text-[#14121A] hover:underline"
                                    >
                                      <span>View</span>
                                      <ExternalLink
                                        className="h-3 w-3"
                                        aria-hidden="true"
                                      />
                                    </Link>
                                  ) : null}
                                  <DeleteListingButton
                                    listingId={item.id}
                                    listingTitle={item.title}
                                  />
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Mobile Compact Rows (Zero Horizontal Overflow) */}
                  <div className="divide-y divide-[#F0EDF5] sm:hidden">
                    {hub.listings.map((item) => {
                      const st = getListingStatusText(
                        item.status,
                        item.availableStock,
                        item.kind
                      );
                      const fallback = (
                        <div className="flex h-full w-full items-center justify-center bg-[#F5F4F8] text-[#6E6A7C]">
                          <Package className="h-4 w-4" aria-hidden="true" />
                        </div>
                      );
                      return (
                        <div key={item.id} className="flex gap-3 p-3.5">
                          <div className="relative h-14 w-16 shrink-0 overflow-hidden rounded-lg border border-[#ECEAF2] bg-[#F5F4F8]">
                            <ListingImage
                              src={item.imageUrl}
                              alt={item.title}
                              fallback={fallback}
                            />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-2">
                              <p className="truncate text-sm font-bold text-[#14121A]">
                                {item.title}
                              </p>
                              <span
                                className={`shrink-0 text-xs font-bold ${st.colorClass}`}
                              >
                                {st.label}
                              </span>
                            </div>
                            <p className="mt-0.5 text-xs text-[#6E6A7C]">
                              {item.categoryName}
                            </p>
                            <div className="mt-1.5 flex items-center justify-between text-xs">
                              <span className="tabular-price font-bold text-[#14121A]">
                                {formatRm(item.priceSen)} ·{" "}
                                <span className="font-normal text-[#6E6A7C]">
                                  {item.kind === "service"
                                    ? "Service"
                                    : `Stock: ${item.availableStock}`}
                                </span>
                              </span>
                              <div className="flex items-center gap-3">
                                <Link
                                  href={`/sell/${encodeURIComponent(item.id)}`}
                                  className="font-bold text-[#4E2A84] hover:underline"
                                >
                                  Edit
                                </Link>
                                {item.status === "published" ? (
                                  <Link
                                    href={`/listings/${encodeURIComponent(item.id)}`}
                                    className="font-semibold text-[#555062] hover:underline"
                                  >
                                    View
                                  </Link>
                                ) : null}
                                <DeleteListingButton
                                  listingId={item.id}
                                  listingTitle={item.title}
                                />
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </section>
          </div>

          {/* RIGHT SIDEBAR: Storefront Status + Quick Actions (No Bori Tips Card) */}
          <aside className="space-y-5 lg:col-span-4 xl:col-span-3">
            {/* Storefront Status Card */}
            <section
              aria-labelledby="storefront-status-heading"
              className="rounded-2xl border border-[#E6E3EE] bg-white p-5 shadow-[0_1px_4px_rgba(20,18,26,0.03)]"
            >
              <div className="flex items-center justify-between gap-2">
                <h2
                  id="storefront-status-heading"
                  className="flex items-center gap-2 text-base font-extrabold italic text-[#14121A]"
                >
                  <Store
                    className="h-4 w-4 text-[#4E2A84]"
                    aria-hidden="true"
                  />
                  <span>Storefront Status</span>
                </h2>
                <span
                  className={`text-xs font-bold ${
                    hub.storefront ? "text-[#0F766E]" : "text-[#6E6A7C]"
                  }`}
                >
                  {hub.storefront ? "Active" : "Not Initialized"}
                </span>
              </div>

              {hub.storefront ? (
                <div className="mt-4">
                  <div className="flex items-center gap-3">
                    {hub.storefront.logoUrl ? (
                      <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-xl border border-[#E6E3EE] bg-[#FAFAFC]">
                        <Image
                          src={hub.storefront.logoUrl}
                          alt={hub.storefront.shopName}
                          fill
                          sizes="48px"
                          className="object-cover"
                        />
                      </div>
                    ) : (
                      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[#4E2A84] text-sm font-extrabold text-white">
                        {shopInitials}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-extrabold text-[#14121A]">
                        {hub.storefront.shopName}
                      </p>
                      <p className="mt-0.5 flex items-center gap-1 text-xs text-[#6E6A7C]">
                        <ShieldCheck
                          className="h-3.5 w-3.5 shrink-0 text-[#4E2A84]"
                          aria-hidden="true"
                        />
                        <span className="truncate">
                          Verified Student
                          {session.profile?.faculty
                            ? ` · ${session.profile.faculty}`
                            : ""}
                        </span>
                      </p>
                    </div>
                  </div>

                  <p className="mt-3 line-clamp-3 text-xs leading-relaxed text-[#555062]">
                    {hub.storefront.description ||
                      "Add a short storefront bio so campus buyers know what you sell and where you meet."}
                  </p>

                  <Link
                    href="/seller/storefront"
                    className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-[#4E2A84] bg-white px-4 py-2 text-xs font-bold text-[#4E2A84] hover:bg-[#4E2A84] hover:text-white press-feedback"
                  >
                    <span>Edit Storefront &amp; Preview</span>
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </Link>
                </div>
              ) : (
                <div className="mt-3">
                  <p className="text-xs leading-relaxed text-[#555062]">
                    Initialize your single verified UMS student storefront to
                    customize your shop bio and logo.
                  </p>
                  <form action={initializeStorefrontAction} className="mt-4">
                    <button
                      type="submit"
                      className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-[#4E2A84] px-4 py-2.5 text-xs font-bold text-white hover:bg-[#3A1E66] press-feedback"
                    >
                      <Store className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Initialize My Storefront</span>
                    </button>
                  </form>
                </div>
              )}

              {/* Compact Masked Payout Account Line */}
              <div className="mt-4 border-t border-[#F0EDF5] pt-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 font-semibold text-[#555062]">
                    <Landmark
                      className="h-3.5 w-3.5 text-[#4E2A84]"
                      aria-hidden="true"
                    />
                    <span>Payout Account</span>
                  </span>
                  <span
                    className={`font-bold ${
                      hub.payout.configured
                        ? "text-[#0F766E]"
                        : "text-[#6E6A7C]"
                    }`}
                  >
                    {hub.payout.configured ? "Configured" : "Not Set Up"}
                  </span>
                </div>
                {hub.payout.configured ? (
                  <p className="mt-1 font-mono text-[11px] text-[#6E6A7C]">
                    {hub.payout.bankName} · {hub.payout.maskedAccountNumber}
                    {hub.payout.hasDuitNow ? " · DuitNow" : ""}
                  </p>
                ) : null}
              </div>
            </section>

            {/* Quick Actions Card */}
            <section
              aria-labelledby="quick-actions-heading"
              className="rounded-2xl border border-[#E6E3EE] bg-white p-5 shadow-[0_1px_4px_rgba(20,18,26,0.03)]"
            >
              <h2
                id="quick-actions-heading"
                className="flex items-center gap-2 text-base font-extrabold italic text-[#14121A]"
              >
                <Zap className="h-4 w-4 text-[#4E2A84]" aria-hidden="true" />
                <span>Quick Actions</span>
              </h2>

              <div className="mt-3.5 space-y-2.5">
                <Link
                  href="/sell"
                  className="flex w-full items-center gap-2.5 rounded-xl bg-[#4E2A84] px-4 py-2.5 text-sm font-bold text-white shadow-[0_2px_6px_rgba(78,42,132,0.2)] hover:bg-[#3A1E66] press-feedback"
                >
                  <PlusCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>Create Listing</span>
                </Link>

                <Link
                  href="/seller/storefront"
                  className="flex w-full items-center gap-2.5 rounded-xl border border-[#E6E3EE] bg-white px-4 py-2.5 text-sm font-bold text-[#14121A] hover:border-[#4E2A84]/50 hover:text-[#4E2A84] press-feedback"
                >
                  <Store
                    className="h-4 w-4 shrink-0 text-[#555062]"
                    aria-hidden="true"
                  />
                  <span>Edit Storefront</span>
                </Link>

                <Link
                  href="/marketplace"
                  className="flex w-full items-center gap-2.5 rounded-xl border border-[#E6E3EE] bg-white px-4 py-2.5 text-sm font-bold text-[#14121A] hover:border-[#4E2A84]/50 hover:text-[#4E2A84] press-feedback"
                >
                  <ExternalLink
                    className="h-4 w-4 shrink-0 text-[#555062]"
                    aria-hidden="true"
                  />
                  <span>View Marketplace</span>
                </Link>

                <button
                  type="button"
                  disabled
                  aria-disabled="true"
                  title="Campus messaging inbox is coming in a later phase"
                  aria-label={
                    counters.unreadMessageCount > 0
                      ? `Messages, ${counters.unreadMessageCount} unread (inbox coming soon)`
                      : "Messages (inbox coming soon)"
                  }
                  className="flex w-full items-center justify-between gap-2 rounded-xl border border-[#E6E3EE] bg-white px-4 py-2.5 text-sm font-bold text-[#555062] opacity-80 cursor-not-allowed"
                >
                  <span className="inline-flex items-center gap-2.5">
                    <MessageCircle
                      className="h-4 w-4 shrink-0 text-[#555062]"
                      aria-hidden="true"
                    />
                    <span>Messages</span>
                  </span>
                  {counters.unreadMessageCount > 0 ? (
                    <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[#4E2A84] px-1.5 text-[11px] font-bold text-white">
                      {counters.unreadMessageCount}
                    </span>
                  ) : null}
                </button>
              </div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
