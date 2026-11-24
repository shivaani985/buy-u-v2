"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  CheckCircle2,
  KeyRound,
  Loader2,
  Lock,
  MapPin,
  MessageCircle,
  Package,
  Search,
  User,
} from "lucide-react";
import { startConversationAction } from "@/app/messages/actions";
import { verifySellerPickupPinAction } from "@/app/orders/actions";
import { OrderTimeline } from "@/components/orders/OrderTimeline";
import { formatSenToRm, formatShortDate } from "@/lib/format";
import {
  getOrderStatusBadge,
  getSellerEarningsLedgerState,
  isValidPickupPinFormat,
  matchesSellerOrderFilter,
  matchesSellerOrderSearch,
  normalizePickupPinInput,
  SELLER_ORDER_FILTER_TABS,
  type SellerOrderFilterKey,
} from "@/lib/orders/lifecycle";
import type { SellerOrderView } from "@/lib/orders/seller-data";

interface SellerOrdersClientProps {
  orders: SellerOrderView[];
}

function formatLockUntilMyt(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-MY", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kuala_Lumpur",
  }).format(d);
}

export function SellerOrdersClient({ orders }: SellerOrdersClientProps) {
  const router = useRouter();
  const [nowMs] = useState<number>(() => Date.now());
  const [activeFilter, setActiveFilter] = useState<SellerOrderFilterKey>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [pinByOrder, setPinByOrder] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [feedbackByOrder, setFeedbackByOrder] = useState<
    Record<string, { type: "success" | "error" | "locked"; text: string }>
  >({});
  const [lockOverrides, setLockOverrides] = useState<
    Record<string, string | null>
  >({});

  const countsByFilter = useMemo(() => {
    const counts: Record<SellerOrderFilterKey, number> = {
      all: orders.length,
      awaiting_payment: 0,
      awaiting_handover: 0,
      awaiting_receipt: 0,
      completed: 0,
      disputed_refunded: 0,
    };
    for (const o of orders) {
      if (matchesSellerOrderFilter(o.status, "awaiting_payment")) {
        counts.awaiting_payment += 1;
      }
      if (matchesSellerOrderFilter(o.status, "awaiting_handover")) {
        counts.awaiting_handover += 1;
      }
      if (matchesSellerOrderFilter(o.status, "awaiting_receipt")) {
        counts.awaiting_receipt += 1;
      }
      if (matchesSellerOrderFilter(o.status, "completed")) {
        counts.completed += 1;
      }
      if (matchesSellerOrderFilter(o.status, "disputed_refunded")) {
        counts.disputed_refunded += 1;
      }
    }
    return counts;
  }, [orders]);

  const filteredOrders = useMemo(
    () =>
      orders.filter(
        (o) =>
          matchesSellerOrderFilter(o.status, activeFilter) &&
          matchesSellerOrderSearch(o, searchQuery)
      ),
    [orders, activeFilter, searchQuery]
  );

  async function handleContactBuyer(order: SellerOrderView) {
    const key = `msg:${order.id}`;
    setBusyKey(key);
    try {
      const res = await startConversationAction({
        sellerId: order.buyerId,
        listingId: order.items[0]?.listingId ?? null,
      });
      if (!res.ok || !res.href) {
        setFeedbackByOrder((prev) => ({
          ...prev,
          [order.id]: {
            type: "error",
            text: res.error || "Could not open chat with buyer right now.",
          },
        }));
        return;
      }
      router.push(res.href);
    } finally {
      setBusyKey(null);
    }
  }

  async function handleVerifyPin(order: SellerOrderView) {
    const pin = (pinByOrder[order.id] ?? "").trim();
    if (!isValidPickupPinFormat(pin)) {
      setFeedbackByOrder((prev) => ({
        ...prev,
        [order.id]: {
          type: "error",
          text: "Enter the buyer's exact 6-digit numeric pickup PIN.",
        },
      }));
      return;
    }

    setBusyKey(`pin:${order.id}`);
    setFeedbackByOrder((prev) => {
      const next = { ...prev };
      delete next[order.id];
      return next;
    });

    try {
      const res = await verifySellerPickupPinAction(order.id, pin);
      if (res.ok) {
        setPinByOrder((prev) => ({ ...prev, [order.id]: "" }));
        setLockOverrides((prev) => ({ ...prev, [order.id]: null }));
        setFeedbackByOrder((prev) => ({
          ...prev,
          [order.id]: { type: "success", text: res.message },
        }));
        router.refresh();
      } else {
        if (res.outcome === "locked" && res.lockedUntil) {
          setLockOverrides((prev) => ({
            ...prev,
            [order.id]: res.lockedUntil ?? null,
          }));
        }
        setFeedbackByOrder((prev) => ({
          ...prev,
          [order.id]: {
            type: res.outcome === "locked" ? "locked" : "error",
            text: res.message,
          },
        }));
      }
    } catch {
      setFeedbackByOrder((prev) => ({
        ...prev,
        [order.id]: {
          type: "error",
          text: "Network error while verifying PIN. Please try again.",
        },
      }));
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="space-y-5">
      {/* Filter tabs + search bar */}
      <div className="flex flex-col gap-3 rounded-2xl border border-[#E6E3EE] bg-white p-4">
        <div
          role="tablist"
          aria-label="Filter seller orders by status"
          className="flex flex-wrap gap-1.5"
        >
          {SELLER_ORDER_FILTER_TABS.map((tab) => {
            const active = activeFilter === tab.key;
            const count = countsByFilter[tab.key];
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setActiveFilter(tab.key)}
                className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold transition ${
                  active
                    ? "bg-[#4E2A84] text-white shadow-[0_2px_6px_rgba(78,42,132,0.18)]"
                    : "border border-[#E6E3EE] bg-[#FAF9FC] text-[#4A4656] hover:border-[#4E2A84]/50 hover:text-[#4E2A84]"
                }`}
              >
                <span>{tab.label}</span>
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10.5px] font-extrabold ${
                    active
                      ? "bg-white/20 text-white"
                      : "bg-white text-[#6B6779]"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8B869B]"
            aria-hidden="true"
          />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by order code, buyer name, item title, or collection area..."
            aria-label="Search seller orders"
            className="w-full rounded-xl border border-[#E6E3EE] bg-[#FAF9FC] py-2.5 pl-10 pr-4 text-sm text-[#14121A] placeholder:text-[#8B869B] focus:border-[#4E2A84] focus:bg-white focus:outline-none"
          />
        </div>
      </div>

      {/* Empty state */}
      {filteredOrders.length === 0 ? (
        <section className="rounded-2xl border border-[#E6E3EE] bg-white px-6 py-12 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-[#E6E3EE] bg-[#FAF9FC] text-[#4E2A84]">
            <Package className="h-5 w-5" aria-hidden="true" />
          </div>
          <h2 className="mt-3 text-base font-bold text-[#14121A]">
            No matching orders
          </h2>
          <p className="mt-1 text-xs text-[#6B6779]">
            {orders.length === 0
              ? "Verified buyer orders for your listings will appear here."
              : "Try switching status tabs or clearing your search query."}
          </p>
        </section>
      ) : (
        <div className="space-y-4">
          {filteredOrders.map((order) => {
            const badge = getOrderStatusBadge(order.status);
            const ledger = getSellerEarningsLedgerState(
              order.status,
              order.hasActiveDispute
            );
            const statusLower = order.status.toLowerCase();
            const canVerifyPin =
              (statusLower === "paid" || statusLower === "ready_for_pickup") &&
              !order.hasActiveDispute;
            const effectiveLockUntil =
              order.id in lockOverrides
                ? lockOverrides[order.id]
                : order.pinLockedUntil;
            const isLocked = Boolean(
              effectiveLockUntil &&
                new Date(effectiveLockUntil).getTime() > nowMs
            );
            const lockTimeLabel = formatLockUntilMyt(effectiveLockUntil ?? null);
            const pinValue = pinByOrder[order.id] ?? "";
            const isPinBusy = busyKey === `pin:${order.id}`;
            const isMsgBusy = busyKey === `msg:${order.id}`;
            const feedback = feedbackByOrder[order.id];

            return (
              <section
                key={order.id}
                className="overflow-hidden rounded-2xl border border-[#E6E3EE] bg-white"
              >
                {/* Header */}
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#ECEAF3] px-5 py-3.5 text-xs">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <span className="font-bold text-[#14121A]">
                      #{order.orderCode}
                    </span>
                    <span className="text-[#C7C3D4]" aria-hidden="true">
                      &middot;
                    </span>
                    <span className="inline-flex items-center gap-1 font-semibold text-[#4A4656]">
                      <User
                        className="h-3.5 w-3.5 text-[#4E2A84]"
                        aria-hidden="true"
                      />
                      <span>{order.buyerName}</span>
                    </span>
                    <span className="text-[#C7C3D4]" aria-hidden="true">
                      &middot;
                    </span>
                    <span className="text-[#6B6779]">
                      {formatShortDate(order.createdAt)}
                    </span>
                    {order.source === "offer" ? (
                      <>
                        <span className="text-[#C7C3D4]" aria-hidden="true">
                          &middot;
                        </span>
                        <span className="font-semibold text-[#4E2A84]">
                          Bargained Offer
                        </span>
                      </>
                    ) : null}
                  </div>
                  <span
                    className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-bold ${badge.toneClass}`}
                  >
                    {badge.label}
                  </span>
                </div>

                {/* Items */}
                <ul className="divide-y divide-[#F1EFF6]">
                  {order.items.map((item) => (
                    <li
                      key={item.id}
                      className="flex items-center gap-3.5 px-5 py-3.5"
                    >
                      <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl border border-[#E6E3EE] bg-[#F7F6FA]">
                        {item.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={item.imageUrl}
                            alt={item.title}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-[10px] font-semibold text-[#6B6779]">
                            No Photo
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-bold text-[#14121A]">
                          {item.title}
                        </p>
                        <p className="mt-0.5 text-xs text-[#6B6779]">
                          Qty {item.quantity} &times;{" "}
                          {formatSenToRm(item.unitSen)}
                        </p>
                      </div>
                      <p className="shrink-0 text-sm font-bold text-[#14121A]">
                        {formatSenToRm(item.unitSen * item.quantity)}
                      </p>
                    </li>
                  ))}
                </ul>

                {/* Order Progress Timeline */}
                <OrderTimeline
                  status={order.status}
                  createdAt={order.createdAt}
                  paidAt={order.paidAt}
                  handedOverAt={order.handedOverAt}
                  completedAt={order.completedAt}
                />

                {/* Seller Verify Pickup PIN Panel (ONLY for eligible paid orders; NEVER reveals buyer PIN) */}
                {canVerifyPin ? (
                  <div className="border-t border-[#D6EEEE] bg-[#F2FAFA] px-5 py-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="inline-flex items-center gap-1.5 text-xs font-extrabold text-[#006A6D]">
                          <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Verify Buyer Pickup PIN</span>
                        </p>
                        <p className="mt-0.5 text-xs text-[#4A4656]">
                          Ask the buyer for their private 6-digit PIN in person
                          during campus handover.
                        </p>
                      </div>

                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          handleVerifyPin(order);
                        }}
                        className="flex flex-wrap items-center gap-2"
                      >
                        <input
                          type="text"
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          maxLength={6}
                          disabled={isLocked || isPinBusy}
                          value={pinValue}
                          onChange={(e) =>
                            setPinByOrder((prev) => ({
                              ...prev,
                              [order.id]: normalizePickupPinInput(
                                e.target.value
                              ),
                            }))
                          }
                          placeholder="6-digit PIN"
                          aria-label={`Enter 6-digit pickup PIN for order ${order.orderCode}`}
                          className="w-36 rounded-xl border border-[#B8E3E4] bg-white px-3.5 py-2 text-center font-mono text-sm font-extrabold tracking-[0.22em] text-[#14121A] placeholder:font-sans placeholder:text-xs placeholder:font-normal placeholder:tracking-normal placeholder:text-[#8B869B] focus:border-[#008285] focus:outline-none disabled:bg-[#F3F2F7] disabled:text-[#8B869B]"
                        />
                        <button
                          type="submit"
                          disabled={
                            isLocked ||
                            isPinBusy ||
                            !isValidPickupPinFormat(pinValue)
                          }
                          className="inline-flex items-center gap-1.5 rounded-xl bg-[#008285] px-4 py-2 text-xs font-bold text-white transition hover:bg-[#006B6E] disabled:opacity-50"
                        >
                          {isPinBusy ? (
                            <Loader2
                              className="h-3.5 w-3.5 animate-spin"
                              aria-hidden="true"
                            />
                          ) : (
                            <CheckCircle2
                              className="h-3.5 w-3.5"
                              aria-hidden="true"
                            />
                          )}
                          <span>Verify Handover</span>
                        </button>
                      </form>
                    </div>

                    {isLocked ? (
                      <p
                        role="alert"
                        className="mt-2.5 inline-flex items-center gap-1.5 text-xs font-semibold text-[#B42318]"
                      >
                        <Lock className="h-3.5 w-3.5 shrink-0" />
                        <span>
                          PIN entry locked after 5 failed attempts. Try again
                          after {lockTimeLabel ?? "15 minutes"} MYT.
                        </span>
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {/* Feedback banner */}
                {feedback ? (
                  <p
                    role={feedback.type === "success" ? "status" : "alert"}
                    className={`flex items-center gap-1.5 border-t border-[#F1EFF6] px-5 py-2.5 text-xs font-semibold ${
                      feedback.type === "success"
                        ? "bg-[#F2FAFA] text-[#006A6D]"
                        : "bg-[#FEF6F6] text-[#B42318]"
                    }`}
                  >
                    {feedback.type === "success" ? (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                    ) : feedback.type === "locked" ? (
                      <Lock className="h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    )}
                    <span>{feedback.text}</span>
                  </p>
                ) : null}

                {/* Footer: Collection, Contact Buyer, Earnings Ledger */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#ECEAF3] bg-[#FAF9FC] px-5 py-3 text-xs">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="inline-flex items-center gap-1 text-[#4A4656]">
                      <MapPin
                        className="h-3.5 w-3.5 text-[#4E2A84]"
                        aria-hidden="true"
                      />
                      <span>{order.collectionAreaName}</span>
                    </span>
                    <button
                      type="button"
                      disabled={isMsgBusy}
                      onClick={() => handleContactBuyer(order)}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-[#E6E3EE] bg-white px-3 py-1.5 font-semibold text-[#14121A] transition hover:border-[#4E2A84] hover:text-[#4E2A84] disabled:opacity-50"
                    >
                      {isMsgBusy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <MessageCircle className="h-3.5 w-3.5 text-[#4E2A84]" />
                      )}
                      <span>Contact Buyer / Arrange Collection</span>
                    </button>
                  </div>

                  <div className="flex flex-wrap items-baseline gap-2.5 text-right">
                    <span className="text-[#6B6779]">
                      Subtotal {formatSenToRm(order.subtotalSen)} &minus; 2% fee{" "}
                      {formatSenToRm(order.commissionSen)}
                    </span>
                    <span className="text-sm font-extrabold text-[#4E2A84]">
                      Net {formatSenToRm(order.sellerNetSen)}
                    </span>
                    {ledger.state !== "none" ? (
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10.5px] font-bold ${
                          ledger.state === "available_for_payout"
                            ? "bg-[#E6F6F6] text-[#006A6D]"
                            : ledger.state === "frozen"
                              ? "bg-[#FEF2F2] text-[#B42318]"
                              : "bg-[#F3EEFA] text-[#4E2A84]"
                        }`}
                      >
                        {ledger.label}
                      </span>
                    ) : null}
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
