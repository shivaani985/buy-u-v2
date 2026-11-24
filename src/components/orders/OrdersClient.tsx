"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Clock,
  ExternalLink,
  KeyRound,
  Loader2,
  MapPin,
  RefreshCw,
  ShieldAlert,
  Store,
} from "lucide-react";
import {
  retryCheckoutSandboxBillAction,
  retryOrderSandboxBillAction,
} from "@/app/checkout/actions";
import { formatSenToRm, formatShortDate } from "@/lib/format";
import type {
  BuyerOrderView,
  BuyerPendingCheckoutView,
} from "@/lib/orders/data";

interface OrdersClientProps {
  pendingCheckouts: BuyerPendingCheckoutView[];
  orders: BuyerOrderView[];
}

function formatOrderStatus(
  status: string,
  paymentStatus?: string | null
): { label: string; color: string } {
  if (paymentStatus === "late_payment_review") {
    return { label: "Late Payment · Refund Review", color: "text-[#B54708]" };
  }
  switch (status.toLowerCase()) {
    case "completed":
    case "settled":
      return { label: "Completed", color: "text-[#008285]" };
    case "paid":
    case "ready_for_pickup":
      return { label: "Paid · Ready for Pickup", color: "text-[#008285]" };
    case "pending_payment":
      return { label: "Awaiting FPX Payment", color: "text-[#4E2A84]" };
    case "expired":
    case "cancelled":
    case "refunded":
      return {
        label: status.charAt(0).toUpperCase() + status.slice(1),
        color: "text-[#B42318]",
      };
    default:
      return { label: status.replace(/_/g, " "), color: "text-[#6B6779]" };
  }
}

function formatDeadlineMyt(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-MY", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kuala_Lumpur",
  }).format(d);
}

export function OrdersClient({ pendingCheckouts, orders }: OrdersClientProps) {
  const router = useRouter();
  const [nowMs] = useState<number>(() => Date.now());
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [feedbackByKey, setFeedbackByKey] = useState<
    Record<string, { type: "info" | "error"; text: string }>
  >({});

  async function handlePayCheckout(checkout: BuyerPendingCheckoutView) {
    const key = `chk:${checkout.id}`;
    setFeedbackByKey((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

    if (checkout.paymentStatus === "pending" && checkout.billUrl) {
      window.location.assign(checkout.billUrl);
      return;
    }

    setBusyKey(key);
    try {
      const res = await retryCheckoutSandboxBillAction(checkout.id);
      if (!res.ok || !res.billUrl) {
        setFeedbackByKey((prev) => ({
          ...prev,
          [key]: {
            type: "error",
            text: res.error || "Could not open ToyyibPay bill right now.",
          },
        }));
        return;
      }
      window.location.assign(res.billUrl);
    } catch {
      setFeedbackByKey((prev) => ({
        ...prev,
        [key]: {
          type: "error",
          text: "Network error while preparing payment bill. Please try again.",
        },
      }));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleCheckCheckoutStatus(checkout: BuyerPendingCheckoutView) {
    const key = `chk:${checkout.id}`;
    setBusyKey(key);
    setFeedbackByKey((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    try {
      const res = await fetch("/api/payments/toyyibpay/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checkoutSessionId: checkout.id }),
      });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        message?: string;
        error?: string;
      } | null;

      setFeedbackByKey((prev) => ({
        ...prev,
        [key]: {
          type: res.ok && json?.ok ? "info" : "error",
          text:
            json?.message ||
            json?.error ||
            "Could not verify payment status right now.",
        },
      }));
      router.refresh();
    } catch {
      setFeedbackByKey((prev) => ({
        ...prev,
        [key]: {
          type: "error",
          text: "Network error while checking payment status.",
        },
      }));
    } finally {
      setBusyKey(null);
    }
  }

  async function handlePayLegacyOrder(order: BuyerOrderView) {
    const key = `ord:${order.id}`;
    setFeedbackByKey((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

    if (
      order.latestPayment?.status === "pending" &&
      order.latestPayment.billUrl
    ) {
      window.location.assign(order.latestPayment.billUrl);
      return;
    }

    setBusyKey(key);
    try {
      const res = await retryOrderSandboxBillAction(order.id);
      if (!res.ok || !res.billUrl) {
        setFeedbackByKey((prev) => ({
          ...prev,
          [key]: {
            type: "error",
            text: res.error || "Could not open ToyyibPay bill right now.",
          },
        }));
        return;
      }
      window.location.assign(res.billUrl);
    } catch {
      setFeedbackByKey((prev) => ({
        ...prev,
        [key]: {
          type: "error",
          text: "Network error while preparing payment bill. Please try again.",
        },
      }));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleCheckLegacyOrderStatus(order: BuyerOrderView) {
    const key = `ord:${order.id}`;
    setBusyKey(key);
    setFeedbackByKey((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    try {
      const res = await fetch("/api/payments/toyyibpay/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: order.id }),
      });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        message?: string;
        error?: string;
      } | null;

      setFeedbackByKey((prev) => ({
        ...prev,
        [key]: {
          type: res.ok && json?.ok ? "info" : "error",
          text:
            json?.message ||
            json?.error ||
            "Could not verify payment status right now.",
        },
      }));
      router.refresh();
    } catch {
      setFeedbackByKey((prev) => ({
        ...prev,
        [key]: {
          type: "error",
          text: "Network error while checking payment status.",
        },
      }));
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="space-y-5">
      {/* Phase 6B.4 Unified Pending Checkouts (ONE Pay Now button covering all sellers) */}
      {pendingCheckouts.map((checkout) => {
        const key = `chk:${checkout.id}`;
        const st = formatOrderStatus(checkout.status, checkout.paymentStatus);
        const deadlineMs = new Date(checkout.paymentDeadline).getTime();
        const isUnexpiredPending =
          checkout.status === "pending_payment" && nowMs < deadlineMs;
        const deadlineLabel = formatDeadlineMyt(checkout.paymentDeadline);
        const isBusy = busyKey === key;
        const feedback = feedbackByKey[key];

        return (
          <section
            key={checkout.id}
            className="overflow-hidden rounded-2xl border border-[#4E2A84]/25 bg-white"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#ECEAF3] bg-[#FAF8FD] px-5 py-3.5 text-xs">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <span className="font-extrabold text-[#4E2A84]">
                  Checkout #{checkout.checkoutCode}
                </span>
                <span className="text-[#C7C3D4]" aria-hidden="true">
                  &middot;
                </span>
                <span className="font-semibold text-[#14121A]">
                  {checkout.orders.length}{" "}
                  {checkout.orders.length === 1
                    ? "seller order"
                    : "seller orders"}
                </span>
                <span className="text-[#C7C3D4]" aria-hidden="true">
                  &middot;
                </span>
                <span className="text-[#6B6779]">
                  {formatShortDate(checkout.createdAt)}
                </span>
              </div>
              <span className={`font-bold ${st.color}`}>{st.label}</span>
            </div>

            <div className="divide-y divide-[#ECEAF3]">
              {checkout.orders.map((ord) => (
                <div key={ord.id} className="px-5 py-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="inline-flex items-center gap-1.5 font-bold text-[#14121A]">
                      <Store
                        className="h-3.5 w-3.5 text-[#4E2A84]"
                        aria-hidden="true"
                      />
                      <span>{ord.sellerName}</span>
                      <span className="font-normal text-[#6B6779]">
                        #{ord.orderCode}
                      </span>
                    </span>
                    <span className="font-bold text-[#14121A]">
                      {formatSenToRm(ord.subtotalSen)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-[#6B6779]">
                    {ord.items
                      .map((i) => `${i.title} × ${i.quantity}`)
                      .join(", ")}{" "}
                    &middot; Collection: {ord.collectionAreaName}
                  </p>
                </div>
              ))}
            </div>

            {checkout.paymentStatus === "late_payment_review" ? (
              <div className="flex items-start gap-2 border-t border-[#F6E4C6] bg-[#FFFBF2] px-5 py-3 text-xs text-[#93370D]">
                <ShieldAlert
                  className="mt-0.5 h-4 w-4 shrink-0"
                  aria-hidden="true"
                />
                <span>
                  Payment arrived after this checkout&apos;s reservation expired.
                  Stock was not oversold and your payment is flagged for admin
                  refund reconciliation.
                </span>
              </div>
            ) : null}

            {isUnexpiredPending && checkout.paymentStatus === "failed" ? (
              <div className="border-t border-[#F6E4C6] bg-[#FFFBF2] px-5 py-2.5 text-xs text-[#93370D]">
                Previous FPX attempt failed. ToyyibPay may apply a ~10-minute
                retry cooldown on the same bill; your hold stays active until{" "}
                <strong>{deadlineLabel} MYT</strong>.
              </div>
            ) : null}

            {isUnexpiredPending ? (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#ECEAF3] bg-white px-5 py-3.5">
                <div className="flex items-center gap-1.5 text-xs text-[#4A4656]">
                  <Clock
                    className="h-3.5 w-3.5 shrink-0 text-[#4E2A84]"
                    aria-hidden="true"
                  />
                  <span>
                    {deadlineLabel
                      ? `Pay before ${deadlineLabel} MYT`
                      : "Complete ToyyibPay FPX payment before hold expires"}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {checkout.billCode ? (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => handleCheckCheckoutStatus(checkout)}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-[#E6E3EE] bg-white px-3.5 py-2 text-xs font-semibold text-[#14121A] transition hover:border-[#4E2A84] hover:text-[#4E2A84] disabled:opacity-50"
                    >
                      {isBusy ? (
                        <Loader2
                          className="h-3.5 w-3.5 animate-spin"
                          aria-hidden="true"
                        />
                      ) : (
                        <RefreshCw
                          className="h-3.5 w-3.5"
                          aria-hidden="true"
                        />
                      )}
                      <span>Check Status</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => handlePayCheckout(checkout)}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-[#4E2A84] px-4 py-2 text-xs font-bold text-white transition hover:bg-[#3F216B] disabled:opacity-50"
                  >
                    {isBusy ? (
                      <Loader2
                        className="h-3.5 w-3.5 animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <ExternalLink
                        className="h-3.5 w-3.5"
                        aria-hidden="true"
                      />
                    )}
                    <span>
                      {checkout.paymentStatus === "failed"
                        ? `Retry Pay Now · ${formatSenToRm(checkout.totalPaidSen)}`
                        : `Pay Now · ${formatSenToRm(checkout.totalPaidSen)}`}
                    </span>
                  </button>
                </div>
              </div>
            ) : null}

            {feedback ? (
              <p
                role={feedback.type === "error" ? "alert" : "status"}
                className={`border-t border-[#F1EFF6] px-5 py-2.5 text-xs font-semibold ${
                  feedback.type === "error"
                    ? "text-[#B42318]"
                    : "text-[#008285]"
                }`}
              >
                {feedback.text}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#ECEAF3] bg-[#FAF9FC] px-5 py-3 text-xs">
              <span className="text-[#4A4656]">
                One consolidated ToyyibPay FPX payment
              </span>
              <div className="flex items-baseline gap-3">
                <span className="text-[#6B6779]">
                  Subtotal {formatSenToRm(checkout.combinedSubtotalSen)} + FPX{" "}
                  {formatSenToRm(checkout.fpxFeeSen)}
                </span>
                <span className="text-sm font-extrabold text-[#4E2A84]">
                  {formatSenToRm(checkout.totalPaidSen)}
                </span>
              </div>
            </div>
          </section>
        );
      })}

      {/* Individual Seller Orders (Paid, Completed, Expired, & Legacy Orders) */}
      {orders.map((order) => {
        const key = `ord:${order.id}`;
        const st = formatOrderStatus(order.status, order.latestPayment?.status);
        const deadlineMs = order.paymentDeadline
          ? new Date(order.paymentDeadline).getTime()
          : null;
        const isUnexpiredLegacyPending =
          !order.checkoutSessionId &&
          order.status === "pending_payment" &&
          (deadlineMs === null || nowMs < deadlineMs);
        const deadlineLabel = formatDeadlineMyt(order.paymentDeadline);
        const isBusy = busyKey === key;
        const feedback = feedbackByKey[key];

        return (
          <section
            key={order.id}
            className="overflow-hidden rounded-2xl border border-[#E6E3EE] bg-white"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#ECEAF3] px-5 py-3.5 text-xs">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <span className="font-bold text-[#14121A]">
                  #{order.orderCode}
                </span>
                <span className="text-[#C7C3D4]" aria-hidden="true">
                  &middot;
                </span>
                <span className="inline-flex items-center gap-1 font-semibold text-[#4A4656]">
                  <Store
                    className="h-3.5 w-3.5 text-[#4E2A84]"
                    aria-hidden="true"
                  />
                  <span>{order.sellerName}</span>
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
              <span className={`font-bold ${st.color}`}>{st.label}</span>
            </div>

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
                      Qty {item.quantity} &times; {formatSenToRm(item.unitSen)}
                    </p>
                  </div>
                  <p className="shrink-0 text-sm font-bold text-[#14121A]">
                    {formatSenToRm(item.unitSen * item.quantity)}
                  </p>
                </li>
              ))}
            </ul>

            {order.pickupPin ? (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#E1F1F1] bg-[#F4FAFA] px-5 py-3 text-xs">
                <span className="inline-flex items-center gap-1.5 font-semibold text-[#008285]">
                  <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Private Pickup PIN (buyer-only):</span>
                  <strong className="font-mono text-sm font-extrabold tracking-[0.2em] text-[#14121A]">
                    {order.pickupPin}
                  </strong>
                </span>
                <span className="text-[#4A4656]">
                  Share only in person at campus handover
                </span>
              </div>
            ) : null}

            {order.latestPayment?.status === "late_payment_review" ? (
              <div className="flex items-start gap-2 border-t border-[#F6E4C6] bg-[#FFFBF2] px-5 py-3 text-xs text-[#93370D]">
                <ShieldAlert
                  className="mt-0.5 h-4 w-4 shrink-0"
                  aria-hidden="true"
                />
                <span>
                  Payment arrived after this order&apos;s reservation expired.
                  Stock was not oversold and your payment is flagged for admin
                  refund reconciliation.
                </span>
              </div>
            ) : null}

            {isUnexpiredLegacyPending ? (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#ECEAF3] bg-white px-5 py-3.5">
                <div className="flex items-center gap-1.5 text-xs text-[#4A4656]">
                  <Clock
                    className="h-3.5 w-3.5 shrink-0 text-[#4E2A84]"
                    aria-hidden="true"
                  />
                  <span>
                    {deadlineLabel
                      ? `Pay before ${deadlineLabel} MYT`
                      : "Complete ToyyibPay FPX payment before hold expires"}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {order.latestPayment?.billCode ? (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => handleCheckLegacyOrderStatus(order)}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-[#E6E3EE] bg-white px-3.5 py-2 text-xs font-semibold text-[#14121A] transition hover:border-[#4E2A84] hover:text-[#4E2A84] disabled:opacity-50"
                    >
                      {isBusy ? (
                        <Loader2
                          className="h-3.5 w-3.5 animate-spin"
                          aria-hidden="true"
                        />
                      ) : (
                        <RefreshCw
                          className="h-3.5 w-3.5"
                          aria-hidden="true"
                        />
                      )}
                      <span>Check Status</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => handlePayLegacyOrder(order)}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-[#4E2A84] px-4 py-2 text-xs font-bold text-white transition hover:bg-[#3F216B] disabled:opacity-50"
                  >
                    {isBusy ? (
                      <Loader2
                        className="h-3.5 w-3.5 animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <ExternalLink
                        className="h-3.5 w-3.5"
                        aria-hidden="true"
                      />
                    )}
                    <span>
                      {order.latestPayment?.status === "failed"
                        ? "Retry ToyyibPay FPX"
                        : "Pay via ToyyibPay FPX"}
                    </span>
                  </button>
                </div>
              </div>
            ) : null}

            {feedback ? (
              <p
                role={feedback.type === "error" ? "alert" : "status"}
                className={`border-t border-[#F1EFF6] px-5 py-2.5 text-xs font-semibold ${
                  feedback.type === "error"
                    ? "text-[#B42318]"
                    : "text-[#008285]"
                }`}
              >
                {feedback.text}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#ECEAF3] bg-[#FAF9FC] px-5 py-3 text-xs">
              <span className="inline-flex items-center gap-1 text-[#4A4656]">
                <MapPin
                  className="h-3.5 w-3.5 text-[#4E2A84]"
                  aria-hidden="true"
                />
                <span>Collection: {order.collectionAreaName}</span>
              </span>
              <div className="flex items-baseline gap-3">
                <span className="text-[#6B6779]">
                  {order.fpxFeeSen > 0
                    ? `Subtotal ${formatSenToRm(order.subtotalSen)} + FPX ${formatSenToRm(order.fpxFeeSen)}`
                    : "Item subtotal (checkout FPX billed once)"}
                </span>
                <span className="text-sm font-extrabold text-[#4E2A84]">
                  {formatSenToRm(order.totalPaidSen)}
                </span>
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}
