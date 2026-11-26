"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  ArrowRight,
  CheckCircle2,
  Clock,
  Hourglass,
  Layers,
  Package,
  Search,
  ShoppingBag,
  X,
} from "lucide-react";
import { formatSenToRm } from "@/lib/format";
import { formatMytDateTime } from "@/lib/financials/policy";
import {
  getOrderPresentation,
  ORDER_STATUS_TABS,
  type OrderTab,
  type OrderTypeFilter,
} from "@/lib/orders/lifecycle";
import { orderListQuery } from "@/lib/orders/navigation";
import {
  OrderBadge,
  OrderItems,
  orderButton,
  orderPanel,
  orderPrimary,
  type OrderDisplayItem,
} from "@/components/orders/OrderDisplay";
import { OrderContact, PaymentControls } from "@/components/orders/OrderControls";
import { SellerCompleteOrder } from "@/components/orders/SellerCompleteOrder";
import { useOrderClock, useOrderRefresh } from "@/components/orders/useOrderClock";

export interface OrderListEntry {
  id: string;
  code: string;
  name: string;
  status: string;
  createdAt: string;
  amount: number;
  deadline: string | null;
  paymentStatus?: string | null;
  hasFinancialIssue?: boolean;
  refundStatus?: string | null;
  items: OrderDisplayItem[];
  isService?: boolean;
  canReview?: boolean;
  hasEditableReview?: boolean;
  repurchase?: OrderDisplayItem["repurchase"];
  recipientId?: string;
  listingId?: string | null;
  pin?: { failedAttempts: number; lockedUntil: string | null };
  checkout?: {
    groups: Array<{ id: string; name: string; items: OrderDisplayItem[] }>;
    subtotal: number;
    fee: number;
    childCodes: string[];
  };
}

const types: Array<{ id: OrderTypeFilter; label: string }> = [
  { id: "all", label: "All Types" },
  { id: "products", label: "Products" },
  { id: "services", label: "Services" },
];

function getInitials(name: string): string {
  return (
    name
      .split(" ")
      .filter(Boolean)
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "BU"
  );
}

export function OrderList({
  entries,
  serverNow,
  seller = false,
  completionMode = "unavailable",
}: {
  entries: OrderListEntry[];
  serverNow: number;
  seller?: boolean;
  completionMode?: "unified" | "legacy" | "unavailable";
}) {
  const [notice, setNotice] = useState("");
  const pathname = usePathname();
  const params = useSearchParams();
  const now = useOrderClock(serverNow);
  useOrderRefresh(
    entries.some(
      (entry) =>
        ["paid", "handed_over", "pending_payment", "disputed"].includes(entry.status) ||
        entry.paymentStatus === "late_payment_review"
    )
  );
  const tab =
    ORDER_STATUS_TABS.find((value) => value.key === params.get("status"))?.key ?? "all";
  const type = types.find((value) => value.id === params.get("type"))?.id ?? "all";
  const search = params.get("q") ?? "";
  const oldest = params.get("sort") === "oldest";
  const listQuery = orderListQuery(Object.fromEntries(params)).toString();
  const listSuffix = listQuery ? `?${listQuery}` : "";

  function update(key: "status" | "type" | "q" | "sort", value: string) {
    const query = orderListQuery(Object.fromEntries(params));
    const isDefault =
      ((key === "status" || key === "type") && value === "all") ||
      (key === "sort" && value === "newest");
    if (value && !isDefault) query.set(key, value.slice(0, 200));
    else query.delete(key);
    const next = query.toString();
    window.history.replaceState(null, "", next ? `${pathname}?${next}` : pathname);
  }

  const presentedAll = entries.map((entry) => ({
    entry,
    presentation: getOrderPresentation(
      {
        status: entry.status,
        paymentStatus: entry.paymentStatus,
        paymentDeadline: entry.deadline,
        hasFinancialIssue: entry.hasFinancialIssue,
        refundStatus: entry.refundStatus,
        isService: entry.isService,
      },
      now
    ),
  }));

  const summaryCounts = new Map<OrderTab, number>([["all", presentedAll.length]]);
  for (const { presentation } of presentedAll) {
    summaryCounts.set(presentation.tab, (summaryCounts.get(presentation.tab) ?? 0) + 1);
  }

  const term = search.trim().toLowerCase();
  const rows = presentedAll.filter(({ entry }) => {
    const matchesType =
      type === "all" ||
      (entry.items.length
        ? entry.items.some((item) => item.isService === (type === "services"))
        : Boolean(entry.isService) === (type === "services"));
    return (
      matchesType &&
      [
        entry.code,
        entry.name,
        ...entry.items.flatMap((item) => [item.title, item.variantLabel ?? ""]),
        ...(entry.checkout?.groups.map((group) => group.name) ?? []),
        ...(entry.checkout?.childCodes ?? []),
      ].some((value) => value.toLowerCase().includes(term))
    );
  });

  const counts = new Map<OrderTab, number>([["all", rows.length]]);
  for (const { presentation } of rows) {
    counts.set(presentation.tab, (counts.get(presentation.tab) ?? 0) + 1);
  }
  const visible = rows
    .filter(({ presentation }) => tab === "all" || presentation.tab === tab)
    .sort(
      (a, b) =>
        (Date.parse(a.entry.createdAt) - Date.parse(b.entry.createdAt)) *
        (oldest ? 1 : -1)
    );

  const summaryKpis: Array<{
    tab: OrderTab;
    label: string;
    value: number;
    icon: typeof Layers;
  }> = [
    {
      tab: "all",
      label: "All Orders",
      value: summaryCounts.get("all") ?? 0,
      icon: Layers,
    },
    {
      tab: "to-pay",
      label: "To Pay",
      value: summaryCounts.get("to-pay") ?? 0,
      icon: Clock,
    },
    {
      tab: "in-progress",
      label: "In Progress",
      value: summaryCounts.get("in-progress") ?? 0,
      icon: Hourglass,
    },
    {
      tab: "completed",
      label: "Completed",
      value: summaryCounts.get("completed") ?? 0,
      icon: CheckCircle2,
    },
  ];

  return (
    <div className="min-w-0 space-y-5">
      {/* Editorial Header (matches Seller Hub, Sell & Homepage Hero) */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-extrabold italic tracking-[-0.02em] text-[#111018] sm:text-[36px]">
            {seller ? "Seller" : "My"}{" "}
            <span className="inline-block bg-[#4E2A84] px-3 py-0.5 text-white hero-marketplace-slab">
              Orders
            </span>
          </h1>
          <p className="mt-1.5 text-sm text-[#555062]">
            {seller
              ? "Manage customer purchases, verify completion PINs, and track campus fulfilment."
              : "Track payments, campus pickups, and student service bookings on Buy-U."}
          </p>
        </div>

        {!seller ? (
          <Link
            href="/marketplace"
            className="inline-flex items-center gap-2 rounded-lg border-[1.5px] border-[#00A3A6] bg-white px-4 py-2 text-xs font-bold text-[#008386] transition-colors hover:bg-[#EDF9F9] sm:text-sm press-feedback"
          >
            <ShoppingBag className="h-4 w-4" aria-hidden="true" />
            <span>Browse Marketplace</span>
          </Link>
        ) : null}
      </div>

      {/* 4 Uniform Neutral KPI Summary Cards (matches Seller Hub dashboard) */}
      <section
        aria-label="Order summary"
        className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4"
      >
        {summaryKpis.map((kpi) => {
          const Icon = kpi.icon;
          const isSelected = tab === kpi.tab;
          return (
            <button
              key={kpi.tab}
              type="button"
              aria-pressed={isSelected}
              onClick={() => update("status", kpi.tab)}
              className={`flex cursor-pointer flex-col gap-1.5 rounded-2xl border border-l-[3px] border-l-[#4E2A84] bg-white px-4 py-3.5 text-left shadow-[0_1px_4px_rgba(20,18,26,0.03)] transition-all hover:border-[#4E2A84]/50 sm:flex-row sm:items-center sm:justify-between sm:gap-2 press-feedback ${
                isSelected
                  ? "border-[#4E2A84]/50 ring-1 ring-[#4E2A84]/25"
                  : "border-[#E6E3EE]"
              }`}
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
            </button>
          );
        })}
      </section>

      {/* Unified Filter & Control Card */}
      <section
        aria-label="Filter and search orders"
        className="space-y-3.5 rounded-2xl border border-[#E6E3EE] bg-white p-4 shadow-[0_1px_4px_rgba(20,18,26,0.03)]"
      >
        {/* Status Pill Tabs (matches SellerNav active purple pills) */}
        <div
          role="group"
          aria-label="Order status"
          className="no-scrollbar flex max-w-full items-center gap-2 overflow-x-auto border-b border-[#F0EDF5] pb-3 sm:flex-wrap"
        >
          {ORDER_STATUS_TABS.map(({ key, label }) => {
            const active = tab === key;
            const count = counts.get(key) ?? 0;
            return (
              <button
                type="button"
                key={key}
                aria-pressed={active}
                onClick={() => update("status", key)}
                className={`inline-flex shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap rounded-xl px-3.5 py-2 text-xs font-bold transition-colors sm:text-[13px] press-feedback ${
                  active
                    ? "bg-[#4E2A84] text-white shadow-[0_2px_6px_rgba(78,42,132,0.2)]"
                    : "border border-[#E6E3EE] bg-[#FAFAFC] text-[#14121A] hover:border-[#4E2A84]/50 hover:bg-[#F8F6FD] hover:text-[#4E2A84]"
                }`}
              >
                <span>{label}</span>
                <span
                  className={`tabular-nums inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-extrabold leading-none ${
                    active
                      ? "bg-white text-[#4E2A84]"
                      : "border border-[#E6E3EE] bg-white text-[#555062]"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Search, Type Segmented Control & Sort */}
        <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center lg:justify-between">
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-[#CFCBD9] bg-white px-3.5 transition-colors focus-within:border-[#4E2A84]">
            <Search
              className="size-4 shrink-0 text-[#4E2A84]"
              aria-hidden="true"
            />
            <span className="sr-only">Search orders</span>
            <input
              type="search"
              value={search}
              onChange={(event) => update("q", event.target.value)}
              placeholder={
                seller
                  ? "Search by order code, item, or customer..."
                  : "Search by order code, item, or seller..."
              }
              className="min-h-10 min-w-0 flex-1 bg-transparent text-sm text-[#14121A] placeholder:text-[#858094] focus:outline-none"
            />
            {search ? (
              <button
                type="button"
                onClick={() => update("q", "")}
                aria-label="Clear search"
                className="cursor-pointer rounded-md p-1 text-[#6E6A7C] hover:bg-[#F5F4F8] hover:text-[#14121A]"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ) : null}
          </label>

          <div className="flex flex-wrap items-center justify-between gap-2.5 sm:justify-end">
            <div
              role="group"
              aria-label="Order type"
              className="inline-flex items-center rounded-xl border border-[#E6E3EE] bg-[#F5F4F8] p-1"
            >
              {types.map(({ id, label }) => {
                const active = type === id;
                return (
                  <button
                    type="button"
                    key={id}
                    aria-pressed={active}
                    onClick={() => update("type", id)}
                    className={`cursor-pointer rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${
                      active
                        ? "bg-white text-[#4E2A84] shadow-xs"
                        : "text-[#555062] hover:text-[#14121A]"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            <label className="shrink-0">
              <span className="sr-only">Sort orders</span>
              <select
                value={oldest ? "oldest" : "newest"}
                onChange={(event) => update("sort", event.target.value)}
                className="min-h-10 cursor-pointer rounded-xl border border-[#CFCBD9] bg-white px-3.5 py-2 text-xs font-bold text-[#14121A] focus:border-[#4E2A84] focus:outline-none sm:text-sm"
              >
                <option value="newest">Newest First</option>
                <option value="oldest">Oldest First</option>
              </select>
            </label>
          </div>
        </div>
      </section>

      {notice ? (
        <p
          role="status"
          className="rounded-xl border border-[#00A3A6]/35 bg-[#EDFAF9] px-4 py-3 text-sm font-semibold text-[#006A6D]"
        >
          {notice}
        </p>
      ) : null}

      {/* Order List or Empty State */}
      {visible.length === 0 ? (
        <div
          className={`${orderPanel} flex flex-col items-center gap-3 px-6 py-12 text-center`}
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[#E6E3EE] bg-[#F4F1FA] text-[#4E2A84]">
            <Package className="size-6" aria-hidden="true" />
          </span>
          <div>
            <p className="text-base font-extrabold text-[#14121A]">
              {entries.length ? "No orders match your filters" : "No orders yet"}
            </p>
            <p className="mt-1 text-xs text-[#6E6A7C] sm:text-sm">
              {entries.length
                ? "Try clearing your search or switching status tabs."
                : seller
                  ? "Orders from UMS students and staff will appear here."
                  : "Items, food, and campus services you purchase will show up here."}
            </p>
          </div>
          {entries.length ? (
            <button
              type="button"
              className={orderButton}
              onClick={() => window.history.replaceState(null, "", pathname)}
            >
              Clear filters
            </button>
          ) : !seller ? (
            <Link href="/marketplace" className={orderPrimary}>
              <span>Browse Marketplace</span>
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          ) : null}
        </div>
      ) : (
        <div className="space-y-4">
          {visible.map(({ entry, presentation }) => {
            const reviewing = entry.paymentStatus === "late_payment_review";
            const inProgress = presentation.tab === "in-progress";
            const details = `${pathname}/${entry.checkout ? "checkout/" : ""}${entry.id}${listSuffix}`;
            const itemCount = entry.items.reduce(
              (count, item) => count + item.quantity,
              0
            );
            const sellerCount = new Set(
              entry.checkout?.groups.map((group) => group.id)
            ).size;
            const hasServiceItem =
              Boolean(entry.isService) ||
              entry.items.some((item) => item.isService);

            return (
              <article
                key={entry.id}
                className={`${orderPanel} transition-colors hover:border-[#CFCBD9]`}
              >
                <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#ECEAF2] bg-[#FAFAFC] px-4 py-3 sm:px-5">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#EFEAF8] text-[11px] font-extrabold text-[#4E2A84]">
                      {entry.checkout ? (
                        <ShoppingBag className="h-4 w-4" aria-hidden="true" />
                      ) : (
                        getInitials(entry.name)
                      )}
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="break-words text-sm font-extrabold text-[#14121A]">
                          {entry.name}
                        </h2>
                        <span
                          className={`inline-block rounded-md px-2 py-0.5 text-[10.5px] font-bold ${
                            hasServiceItem
                              ? "bg-[#EDFAF9] text-[#008386]"
                              : "bg-[#F4F1FA] text-[#4E2A84]"
                          }`}
                        >
                          {entry.checkout && itemCount > 1
                            ? "Multi-item"
                            : hasServiceItem
                              ? "Service"
                              : "Product"}
                        </span>
                      </div>
                      <p className="mt-0.5 break-words text-xs text-[#6E6A7C]">
                        <span className="font-mono font-bold text-[#4E2A84]">
                          #{entry.code}
                        </span>{" "}
                        &middot; {formatMytDateTime(entry.createdAt)}
                        {entry.checkout
                          ? ` · ${sellerCount} ${sellerCount === 1 ? "seller" : "sellers"} · ${itemCount} ${itemCount === 1 ? "item" : "items"}`
                          : ""}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <OrderBadge badge={presentation.badge} />
                    {entry.refundStatus === "succeeded" &&
                    presentation.status !== "refunded" ? (
                      <span className="text-xs font-semibold text-[#6E6A7C]">
                        Partial refund recorded
                      </span>
                    ) : null}
                  </div>
                </header>

                <div className="divide-y divide-[#F0EDF5] px-4 sm:px-5">
                  {entry.checkout ? (
                    entry.checkout.groups.map((group) => (
                      <div key={group.id} className="py-2">
                        <h3 className="pt-1 text-xs font-extrabold text-[#555062]">
                          {group.name}
                        </h3>
                        <OrderItems items={group.items} compact />
                      </div>
                    ))
                  ) : (
                    <OrderItems items={entry.items} compact />
                  )}
                </div>

                <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[#ECEAF2] bg-[#FAFAFC]/70 px-4 py-3 sm:px-5">
                  <div className="text-xs text-[#6E6A7C]">
                    {entry.checkout ? (
                      <p className="mb-0.5">
                        Subtotal {formatSenToRm(entry.checkout.subtotal)} &middot; FPX
                        fee {formatSenToRm(entry.checkout.fee)}
                      </p>
                    ) : null}
                    <p className="flex items-baseline gap-1.5">
                      <span className="font-semibold">
                        {entry.checkout ? "Checkout total" : "Order amount"}
                      </span>
                      <strong className="tabular-price text-base font-extrabold text-[#4E2A84]">
                        {formatSenToRm(entry.amount)}
                      </strong>
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {!seller && (presentation.tab === "to-pay" || reviewing) ? (
                      <PaymentControls
                        checkoutId={entry.checkout ? entry.id : undefined}
                        orderId={entry.checkout ? undefined : entry.id}
                        deadline={entry.deadline}
                        now={now}
                        underReview={reviewing}
                        canPay={!reviewing}
                      />
                    ) : null}
                    {inProgress && entry.recipientId ? (
                      <OrderContact
                        orderId={entry.id}
                        recipientId={entry.recipientId}
                        seller={seller}
                      />
                    ) : null}
                    {seller && entry.pin ? (
                      <SellerCompleteOrder
                        id={entry.id}
                        code={entry.code}
                        mode={completionMode}
                        failedAttempts={entry.pin.failedAttempts}
                        lockedUntil={entry.pin.lockedUntil}
                        now={now}
                        eligible={inProgress && entry.status === "paid"}
                        onSuccess={setNotice}
                      />
                    ) : null}
                    {!seller &&
                    entry.canReview &&
                    presentation.tab === "completed" ? (
                      <Link
                        href={`${details}${listSuffix ? "&" : "?"}review=1#reviews`}
                        className={orderButton}
                      >
                        Write Review
                      </Link>
                    ) : !seller &&
                      entry.hasEditableReview &&
                      presentation.tab === "completed" ? (
                      <Link href={`${details}#reviews`} className={orderButton}>
                        Edit Review
                      </Link>
                    ) : null}
                    {!seller &&
                    presentation.tab === "completed" &&
                    entry.repurchase ? (
                      entry.repurchase.href ? (
                        <Link href={entry.repurchase.href} className={orderPrimary}>
                          {entry.repurchase.buttonLabel}
                        </Link>
                      ) : (
                        <span
                          aria-disabled="true"
                          title={entry.repurchase.reason}
                          className="inline-flex min-h-10 cursor-not-allowed items-center justify-center rounded-xl border border-[#E6E3EE] bg-[#F5F4F8] px-3.5 py-2 text-xs font-bold text-[#858094] sm:text-sm"
                        >
                          {entry.repurchase.buttonLabel}
                        </span>
                      )
                    ) : null}
                    {!reviewing &&
                    presentation.tab === "refund-dispute" &&
                    entry.hasFinancialIssue ? (
                      <Link href={`${details}#dispute`} className={orderButton}>
                        View Dispute
                      </Link>
                    ) : null}
                    <Link
                      href={details}
                      className={orderButton}
                      aria-label={`View details for ${entry.code}`}
                    >
                      <span>View Details</span>
                      <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </Link>
                  </div>
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
