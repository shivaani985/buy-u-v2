"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  Clock,
  ExternalLink,
  Flag,
  KeyRound,
  Loader2,
  MapPin,
  MessageCircle,
  Pencil,
  RefreshCw,
  ShieldAlert,
  Star,
  Store,
  X,
} from "lucide-react";
import {
  retryCheckoutSandboxBillAction,
  retryOrderSandboxBillAction,
} from "@/app/checkout/actions";
import { openOrderDisputeAction } from "@/app/disputes/actions";
import { buyerReportReturnAction } from "@/app/financials/actions";
import {
  editVerifiedReviewAction,
  submitVerifiedReviewAction,
} from "@/app/marketplace-actions";
import { startConversationAction } from "@/app/messages/actions";
import { confirmOrderReceiptAction } from "@/app/orders/actions";
import { DisputeDetailCard } from "@/components/disputes/DisputeDetailCard";
import {
  DisputeEvidenceUploader,
  type UploadedEvidenceItem,
} from "@/components/disputes/DisputeEvidenceUploader";
import { OrderTimeline } from "@/components/orders/OrderTimeline";
import {
  COMPLETED_ORDER_DISPUTE_WINDOW_HOURS,
  DISPUTE_REASONS,
  evaluateBuyerDisputeEligibility,
  type DisputeReasonCode,
} from "@/lib/disputes/validation";
import {
  formatMytDateTime,
  getProtectionExpiresAt,
  isWithinBuyerProtectionWindow,
} from "@/lib/financials/policy";
import { formatSenToRm, formatShortDate } from "@/lib/format";
import type {
  BuyerOrderReviewView,
  BuyerOrderView,
  BuyerPendingCheckoutView,
} from "@/lib/orders/data";
import { getOrderStatusBadge } from "@/lib/orders/lifecycle";

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
      return { label: "Completed", color: "text-[#008285]" };
    case "paid":
      return { label: "Paid — Awaiting Handover", color: "text-[#008285]" };
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
  const [confirmingOrder, setConfirmingOrder] = useState<BuyerOrderView | null>(
    null
  );
  const [reportingOrder, setReportingOrder] = useState<BuyerOrderView | null>(
    null
  );
  const [disputeReason, setDisputeReason] =
    useState<DisputeReasonCode>("not_received");
  const [disputeDesc, setDisputeDesc] = useState("");
  const [disputeEvidence, setDisputeEvidence] = useState<
    UploadedEvidenceItem[]
  >([]);
  const [disputeConfirmed, setDisputeConfirmed] = useState(false);
  const [disputeFormError, setDisputeFormError] = useState<string | null>(null);
  const [reviewingOrder, setReviewingOrder] = useState<BuyerOrderView | null>(
    null
  );
  const [editingReview, setEditingReview] =
    useState<BuyerOrderReviewView | null>(null);
  const [reviewListingId, setReviewListingId] = useState<string>("");
  const [reviewRating, setReviewRating] = useState<number>(5);
  const [reviewComment, setReviewComment] = useState<string>("");
  const [reviewFormError, setReviewFormError] = useState<string | null>(null);
  const [feedbackByKey, setFeedbackByKey] = useState<
    Record<string, { type: "info" | "error"; text: string }>
  >({});

  function openNewReviewDialog(order: BuyerOrderView) {
    const reviewedIds = new Set(order.reviews.map((r) => r.listingId).filter(Boolean));
    const nextItem =
      order.items.find((it) => it.listingId && !reviewedIds.has(it.listingId)) ??
      order.items[0];
    setReviewingOrder(order);
    setEditingReview(null);
    setReviewListingId(nextItem?.listingId ?? "");
    setReviewRating(5);
    setReviewComment("");
    setReviewFormError(null);
  }

  function openEditReviewDialog(order: BuyerOrderView, review: BuyerOrderReviewView) {
    setReviewingOrder(order);
    setEditingReview(review);
    setReviewListingId(review.listingId ?? "");
    setReviewRating(review.rating);
    setReviewComment(review.comment);
    setReviewFormError(null);
  }

  async function handleSubmitProductReview() {
    if (!reviewingOrder) return;
    const trimmed = reviewComment.trim();
    if (trimmed.length < 5 || trimmed.length > 1000) {
      setReviewFormError("Review comment must be 5 to 1,000 characters.");
      return;
    }
    const order = reviewingOrder;
    setBusyKey(`rev:${order.id}`);
    setReviewFormError(null);
    try {
      const res = editingReview
        ? await editVerifiedReviewAction({
            reviewId: editingReview.id,
            rating: reviewRating,
            comment: trimmed,
          })
        : await submitVerifiedReviewAction({
            orderId: order.id,
            listingId: reviewListingId || order.items[0]?.listingId || null,
            rating: reviewRating,
            comment: trimmed,
          });
      if (!res.ok) {
        setReviewFormError(res.message);
        return;
      }
      setReviewingOrder(null);
      setEditingReview(null);
      setFeedbackByKey((prev) => ({
        ...prev,
        [`ord:${order.id}`]: { type: "info", text: res.message },
      }));
      router.refresh();
    } catch {
      setReviewFormError("Network error while saving review. Please try again.");
    } finally {
      setBusyKey(null);
    }
  }

  function openReportDialog(order: BuyerOrderView) {
    setReportingOrder(order);
    setDisputeReason("not_received");
    setDisputeDesc("");
    setDisputeEvidence([]);
    setDisputeConfirmed(false);
    setDisputeFormError(null);
  }

  async function handleSubmitDispute() {
    if (!reportingOrder) return;
    if (disputeDesc.trim().length < 20) {
      setDisputeFormError(
        "Please describe the issue in at least 20 characters."
      );
      return;
    }
    if (!disputeConfirmed) {
      setDisputeFormError(
        "Please tick the confirmation box before opening a dispute."
      );
      return;
    }

    const order = reportingOrder;
    setBusyKey(`disp:${order.id}`);
    setDisputeFormError(null);
    try {
      const res = await openOrderDisputeAction({
        orderId: order.id,
        reasonCode: disputeReason,
        description: disputeDesc.trim(),
        evidencePaths: disputeEvidence.map((e) => e.path),
      });
      if (!res.ok) {
        setDisputeFormError(res.message);
        return;
      }
      setReportingOrder(null);
      setFeedbackByKey((prev) => ({
        ...prev,
        [`ord:${order.id}`]: { type: "info", text: res.message },
      }));
      router.refresh();
    } catch {
      setDisputeFormError(
        "Network error while opening dispute. Please try again."
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function handleContactSeller(order: BuyerOrderView) {
    const key = `msg:${order.id}`;
    setBusyKey(key);
    try {
      const res = await startConversationAction({
        sellerId: order.sellerId,
        listingId: order.items[0]?.listingId ?? null,
      });
      if (!res.ok || !res.href) {
        setFeedbackByKey((prev) => ({
          ...prev,
          [`ord:${order.id}`]: {
            type: "error",
            text: res.error || "Could not open chat with seller right now.",
          },
        }));
        return;
      }
      router.push(res.href);
    } finally {
      setBusyKey(null);
    }
  }

  async function handleConfirmReceipt(order: BuyerOrderView) {
    const key = `ord:${order.id}`;
    setBusyKey(`rcpt:${order.id}`);
    setFeedbackByKey((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    try {
      const res = await confirmOrderReceiptAction(order.id);
      setConfirmingOrder(null);
      setFeedbackByKey((prev) => ({
        ...prev,
        [key]: {
          type: res.ok ? "info" : "error",
          text: res.message,
        },
      }));
      if (res.ok) {
        router.refresh();
      }
    } catch {
      setConfirmingOrder(null);
      setFeedbackByKey((prev) => ({
        ...prev,
        [key]: {
          type: "error",
          text: "Network error while confirming receipt. Please try again.",
        },
      }));
    } finally {
      setBusyKey(null);
    }
  }

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

      {/* Individual Seller Orders (Paid, Handed Over, Completed, Expired & Legacy Orders) */}
      {orders.map((order) => {
        const key = `ord:${order.id}`;
        const badge = getOrderStatusBadge(
          order.status,
          order.latestPayment?.status
        );
        const statusLower = order.status.toLowerCase();
        const isEligibleForPin =
          Boolean(order.pickupPin) && statusLower === "paid";
        const canConfirmReceipt = statusLower === "handed_over";
        const hasActiveDispute = Boolean(
          order.dispute &&
            (order.dispute.status === "open" ||
              order.dispute.status === "under_review")
        );
        const hasPendingRefundExecution = Boolean(
          order.dispute &&
            order.dispute.refundExecutionStatus === "pending_execution"
        );
        const disputeEligibility = evaluateBuyerDisputeEligibility({
          status: order.status,
          paidAt: order.paidAt,
          completedAt: order.completedAt,
          hasActiveDispute,
          hasPendingRefundExecution,
          nowMs,
        });
        const canContactOrReport =
          statusLower === "paid" ||
          statusLower === "handed_over" ||
          statusLower === "completed" ||
          statusLower === "disputed";
        const deadlineMs = order.paymentDeadline
          ? new Date(order.paymentDeadline).getTime()
          : null;
        const isUnexpiredLegacyPending =
          !order.checkoutSessionId &&
          order.status === "pending_payment" &&
          (deadlineMs === null || nowMs < deadlineMs);
        const deadlineLabel = formatDeadlineMyt(order.paymentDeadline);
        const isBusy = busyKey === key;
        const isMsgBusy = busyKey === `msg:${order.id}`;
        const isRcptBusy = busyKey === `rcpt:${order.id}`;
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
              <span
                className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-bold ${badge.toneClass}`}
              >
                {badge.label}
              </span>
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

            <OrderTimeline
              status={order.status}
              createdAt={order.createdAt}
              paidAt={order.paidAt}
              handedOverAt={order.handedOverAt}
              completedAt={order.completedAt}
            />

            {isEligibleForPin ? (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#D6EEEE] bg-[#F2FAFA] px-5 py-3 text-xs">
                <span className="inline-flex items-center gap-1.5 font-semibold text-[#008285]">
                  <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Private Pickup PIN (buyer-only):</span>
                  <strong className="rounded-md bg-white px-2 py-0.5 font-mono text-sm font-extrabold tracking-[0.2em] text-[#14121A] ring-1 ring-[#C6E4E4]">
                    {order.pickupPin}
                  </strong>
                </span>
                <span className="text-[#4A4656]">
                  Share only in person at campus handover
                </span>
              </div>
            ) : null}

            {canConfirmReceipt ? (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#E6DDF7] bg-[#F7F3FD] px-5 py-3.5 text-xs">
                <div className="flex items-start gap-2 text-[#3E2468]">
                  <CheckCircle2
                    className="mt-0.5 h-4 w-4 shrink-0 text-[#4E2A84]"
                    aria-hidden="true"
                  />
                  <span>
                    <strong className="font-bold">Handover verified.</strong>{" "}
                    Inspect your item(s) and confirm receipt to complete this
                    order.
                  </span>
                </div>
                <button
                  type="button"
                  disabled={isRcptBusy}
                  onClick={() => setConfirmingOrder(order)}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-[#008285] px-4 py-2 text-xs font-bold text-white transition hover:bg-[#006B6E] disabled:opacity-50"
                >
                  {isRcptBusy ? (
                    <Loader2
                      className="h-3.5 w-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  <span>Confirm Receipt</span>
                </button>
              </div>
            ) : null}

            {order.status === "completed" && order.completedAt ? (
              <div className="border-t border-[#ECEAF3] bg-[#FAF9FC] px-5 py-2.5 text-[11.5px] text-[#4A4656]">
                {isWithinBuyerProtectionWindow(order.completedAt, nowMs) ? (
                  <span>
                    <strong className="text-[#4E2A84]">
                      3-Day (72h) Buyer Protection Active:
                    </strong>{" "}
                    Eligible to report a problem until{" "}
                    <strong>
                      {formatMytDateTime(
                        getProtectionExpiresAt(order.completedAt)
                      )}
                    </strong>
                    .
                  </span>
                ) : (
                  <span className="text-[#6B6779]">
                    3-day (72h) buyer protection window ended on{" "}
                    {formatMytDateTime(
                      getProtectionExpiresAt(order.completedAt)
                    )}
                    .
                  </span>
                )}
              </div>
            ) : null}

            {order.refund ? (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#DCD0F0] bg-[#F7F3FD] px-5 py-3 text-xs text-[#3E2468]">
                <div>
                  <p className="font-extrabold">
                    {order.refund.refundType === "partial_refund"
                      ? "Partially Refunded"
                      : "Refund"}{" "}
                    · {order.refund.refundCode} (
                    {formatSenToRm(order.refund.refundAmountSen)})
                  </p>
                  <p className="mt-0.5 text-[11px]">
                    Status: <strong>{order.refund.status.replace(/_/g, " ")}</strong>
                    {order.refund.returnRequired ? (
                      <>
                        {" "}· Return:{" "}
                        <strong>{order.refund.returnStatus.replace(/_/g, " ")}</strong>
                      </>
                    ) : null}
                    {order.refund.refundRef
                      ? ` · Simulated Ref ${order.refund.refundRef} (FYP simulation — no real bank transfer)`
                      : " · Pending simulated execution"}
                  </p>
                  {order.refund.returnRequired &&
                  order.refund.returnInstructions ? (
                    <p className="mt-1 text-[11px] text-[#4E2A84]">
                      Return instructions: {order.refund.returnInstructions}
                    </p>
                  ) : null}
                </div>
                {order.refund.returnRequired &&
                order.refund.returnStatus === "awaiting_return" ? (
                  <button
                    type="button"
                    disabled={busyKey === `ret:${order.refund.id}`}
                    onClick={async () => {
                      const rid = order.refund!.id;
                      setBusyKey(`ret:${rid}`);
                      try {
                        const res = await buyerReportReturnAction(rid);
                        setFeedbackByKey((prev) => ({
                          ...prev,
                          [key]: {
                            type: res.ok ? "info" : "error",
                            text: res.message,
                          },
                        }));
                        if (res.ok) router.refresh();
                      } finally {
                        setBusyKey(null);
                      }
                    }}
                    className="rounded-xl bg-[#4E2A84] px-3.5 py-2 text-xs font-bold text-white hover:bg-[#3F216B] disabled:opacity-50"
                  >
                    Mark Item Returned
                  </button>
                ) : null}
              </div>
            ) : null}

            {order.dispute ? (
              <DisputeDetailCard dispute={order.dispute} />
            ) : null}

            {/* P0.8: Verified Purchase Reviews (Buyer Product Review UI on /orders) */}
            {statusLower === "completed" ? (() => {
              const isFullyRefunded = Boolean(
                order.refund &&
                  order.refund.refundType === "full_refund" &&
                  order.refund.status === "succeeded"
              );
              const reviewedListingIds = new Set(
                order.reviews.map((r) => r.listingId).filter(Boolean)
              );
              const unreviewedItems = order.items.filter(
                (it) => it.listingId && !reviewedListingIds.has(it.listingId)
              );
              const canWriteProductReview =
                !hasActiveDispute &&
                !isFullyRefunded &&
                (unreviewedItems.length > 0 || order.reviews.length === 0);

              return (
                <div className="space-y-2.5 border-t border-[#ECEAF3] bg-[#FAF9FC] px-5 py-3.5 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 font-bold text-[#14121A]">
                      <Star className="h-3.5 w-3.5 text-amber-500" aria-hidden="true" />
                      <span>Verified Purchase Reviews</span>
                    </span>
                    {canWriteProductReview ? (
                      <button
                        type="button"
                        onClick={() => openNewReviewDialog(order)}
                        className="inline-flex items-center gap-1 rounded-xl border border-[#4E2A84] bg-white px-3 py-1.5 text-xs font-bold text-[#4E2A84] transition hover:bg-[#F3EEFA]"
                      >
                        <Star className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Write Verified Purchase Review</span>
                      </button>
                    ) : null}
                  </div>
                  {order.reviews.length > 0 ? (
                    <div className="space-y-2">
                      {order.reviews.map((rv) => {
                        const itemMatch = order.items.find(
                          (it) => it.listingId && it.listingId === rv.listingId
                        );
                        return (
                          <div
                            key={rv.id}
                            className="rounded-xl border border-[#E6E3EE] bg-white p-3"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="rounded-full bg-[#F3EEFA] px-2 py-0.5 text-[10px] font-extrabold text-[#4E2A84]">
                                  Verified Purchase
                                </span>
                                <span className="font-extrabold text-amber-600">
                                  {"★".repeat(rv.rating)} ({rv.rating}/5)
                                </span>
                                {itemMatch ? (
                                  <span className="text-[11px] font-semibold text-[#6B6779]">
                                    · {itemMatch.title}
                                  </span>
                                ) : null}
                              </div>
                              {!rv.hidden ? (
                                <button
                                  type="button"
                                  onClick={() => openEditReviewDialog(order, rv)}
                                  className="inline-flex items-center gap-1 text-[11px] font-bold text-[#4E2A84] hover:underline"
                                >
                                  <Pencil className="h-3 w-3" aria-hidden="true" />
                                  <span>Edit Review</span>
                                </button>
                              ) : (
                                <span className="text-[11px] font-semibold text-[#6B6779]">
                                  Hidden by moderation
                                </span>
                              )}
                            </div>
                            <p className="mt-1.5 text-[#14121A]">{rv.comment}</p>
                            {rv.sellerResponse ? (
                              <p className="mt-2 rounded-lg bg-[#FAF9FC] p-2 text-[11px] text-[#4E2A84]">
                                <strong>Seller Public Reply:</strong> {rv.sellerResponse}
                              </p>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : isFullyRefunded ? (
                    <p className="text-[11px] text-[#6B6779]">
                      Fully refunded orders are not eligible for verified purchase reviews.
                    </p>
                  ) : null}
                </div>
              );
            })() : null}

            {canContactOrReport ? (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#ECEAF3] bg-white px-5 py-3 text-xs">
                <button
                  type="button"
                  disabled={isMsgBusy}
                  onClick={() => handleContactSeller(order)}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-[#E6E3EE] bg-white px-3.5 py-2 font-semibold text-[#14121A] transition hover:border-[#4E2A84] hover:text-[#4E2A84] disabled:opacity-50"
                >
                  {isMsgBusy ? (
                    <Loader2
                      className="h-3.5 w-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <MessageCircle
                      className="h-3.5 w-3.5 text-[#4E2A84]"
                      aria-hidden="true"
                    />
                  )}
                  <span>Contact Seller / Arrange Collection</span>
                </button>
                {disputeEligibility.eligible ? (
                  <button
                    type="button"
                    onClick={() => openReportDialog(order)}
                    className="inline-flex items-center gap-1 rounded-xl border border-[#F4D5D3] bg-[#FFF8F8] px-3 py-1.5 font-semibold text-[#B42318] transition hover:bg-[#FEF2F2]"
                  >
                    <Flag className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Report a Problem</span>
                  </button>
                ) : null}
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

      {/* Buyer Receipt Confirmation Dialog */}
      {confirmingOrder ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-receipt-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-md rounded-2xl border border-[#E6E3EE] bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <h2
                id="confirm-receipt-title"
                className="text-base font-extrabold text-[#14121A]"
              >
                Confirm Order Receipt
              </h2>
              <button
                type="button"
                aria-label="Close dialog"
                onClick={() => setConfirmingOrder(null)}
                className="rounded-lg p-1 text-[#6B6779] hover:bg-[#FAF9FC] hover:text-[#14121A]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-2 text-sm text-[#4A4656]">
              Confirm that you have received order{" "}
              <strong className="text-[#14121A]">
                #{confirmingOrder.orderCode}
              </strong>{" "}
              from{" "}
              <strong className="text-[#14121A]">
                {confirmingOrder.sellerName}
              </strong>{" "}
              in good condition.
            </p>
            <p className="mt-2 rounded-xl bg-[#FAF9FC] p-3 text-xs text-[#6B6779]">
              Once confirmed, this order is marked Completed and the
              seller&apos;s net earnings move from Pending Settlement to
              Available for Payout.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmingOrder(null)}
                className="rounded-xl border border-[#E6E3EE] bg-white px-4 py-2 text-xs font-bold text-[#14121A] hover:bg-[#FAF9FC]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busyKey === `rcpt:${confirmingOrder.id}`}
                onClick={() => handleConfirmReceipt(confirmingOrder)}
                className="inline-flex items-center gap-1.5 rounded-xl bg-[#008285] px-4 py-2 text-xs font-bold text-white hover:bg-[#006B6E] disabled:opacity-50"
              >
                {busyKey === `rcpt:${confirmingOrder.id}` ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                )}
                <span>Yes, Confirm Receipt</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Phase 6D.1 Buyer Dispute Creation Dialog */}
      {reportingOrder ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="report-problem-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-[#E6E3EE] bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2
                  id="report-problem-title"
                  className="text-base font-extrabold text-[#14121A]"
                >
                  Report a Problem &middot; #{reportingOrder.orderCode}
                </h2>
                <p className="mt-0.5 text-xs text-[#6B6779]">
                  Seller: {reportingOrder.sellerName} &middot;{" "}
                  {formatSenToRm(reportingOrder.subtotalSen)}
                </p>
              </div>
              <button
                type="button"
                aria-label="Close dialog"
                onClick={() => setReportingOrder(null)}
                className="rounded-lg p-1 text-[#6B6779] hover:bg-[#FAF9FC] hover:text-[#14121A]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Order & Product Summary */}
            <div className="mt-3 rounded-xl border border-[#ECEAF3] bg-[#FAF9FC] p-3 text-xs">
              {reportingOrder.items.map((it) => (
                <p key={it.id} className="truncate font-semibold text-[#14121A]">
                  {it.title} &times; {it.quantity} ({formatSenToRm(it.unitSen)})
                </p>
              ))}
              {reportingOrder.status === "completed" ? (
                <p className="mt-1.5 text-[11px] text-[#4E2A84]">
                  Within 3-day ({COMPLETED_ORDER_DISPUTE_WINDOW_HOURS}-hour)
                  buyer protection window (ending{" "}
                  {formatMytDateTime(
                    getProtectionExpiresAt(reportingOrder.completedAt)
                  ) ?? "72h after completion"}
                  ). Approved refunds are subject to admin review and return
                  requirements.
                </p>
              ) : null}
            </div>

            <div className="mt-4 space-y-3.5">
              <div>
                <label
                  htmlFor="dispute-reason-select"
                  className="block text-xs font-bold text-[#14121A]"
                >
                  Reason
                </label>
                <select
                  id="dispute-reason-select"
                  value={disputeReason}
                  onChange={(e) =>
                    setDisputeReason(e.target.value as DisputeReasonCode)
                  }
                  className="mt-1 w-full rounded-xl border border-[#E6E3EE] bg-white px-3 py-2 text-xs font-semibold text-[#14121A] focus:border-[#4E2A84] focus:outline-none"
                >
                  {DISPUTE_REASONS.map((r) => (
                    <option key={r.code} value={r.code}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="dispute-description-input"
                  className="block text-xs font-bold text-[#14121A]"
                >
                  Detailed Description (20&ndash;2,000 characters)
                </label>
                <textarea
                  id="dispute-description-input"
                  rows={4}
                  maxLength={2000}
                  value={disputeDesc}
                  onChange={(e) => setDisputeDesc(e.target.value)}
                  placeholder="Describe what went wrong, dates/times, and what resolution you are seeking..."
                  className="mt-1 w-full rounded-xl border border-[#E6E3EE] bg-white px-3 py-2 text-xs text-[#14121A] focus:border-[#4E2A84] focus:outline-none"
                />
              </div>

              <DisputeEvidenceUploader
                orderId={reportingOrder.id}
                items={disputeEvidence}
                onChange={setDisputeEvidence}
                disabled={busyKey === `disp:${reportingOrder.id}`}
              />

              <label className="flex items-start gap-2 rounded-xl border border-[#ECEAF3] bg-[#FAF9FC] p-3 text-xs text-[#4A4656]">
                <input
                  type="checkbox"
                  checked={disputeConfirmed}
                  onChange={(e) => setDisputeConfirmed(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-[#C7C0DB] accent-[#4E2A84]"
                />
                <span>
                  I confirm this report is truthful. Opening a dispute freezes
                  this order&apos;s earnings while Buy-U admin reviews both
                  sides.
                </span>
              </label>

              {disputeFormError ? (
                <p role="alert" className="text-xs font-semibold text-[#B42318]">
                  {disputeFormError}
                </p>
              ) : null}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setReportingOrder(null)}
                className="rounded-xl border border-[#E6E3EE] bg-white px-4 py-2 text-xs font-bold text-[#14121A] hover:bg-[#FAF9FC]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busyKey === `disp:${reportingOrder.id}`}
                onClick={handleSubmitDispute}
                className="inline-flex items-center gap-1.5 rounded-xl bg-[#B42318] px-4 py-2 text-xs font-bold text-white hover:bg-[#912018] disabled:opacity-50"
              >
                {busyKey === `disp:${reportingOrder.id}` ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Flag className="h-3.5 w-3.5" />
                )}
                <span>Submit Dispute</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {/* P0.8: Buyer Verified Purchase Review Dialog (Create / Edit) */}
      {reviewingOrder ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="product-review-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-md rounded-2xl border border-[#E6E3EE] bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <span className="inline-block rounded-full bg-[#F3EEFA] px-2.5 py-0.5 text-[10px] font-extrabold text-[#4E2A84]">
                  Verified Purchase
                </span>
                <h2
                  id="product-review-title"
                  className="mt-1 text-base font-extrabold text-[#14121A]"
                >
                  {editingReview
                    ? `Edit Review · #${reviewingOrder.orderCode}`
                    : `Review Order #${reviewingOrder.orderCode}`}
                </h2>
                <p className="mt-0.5 text-xs text-[#6B6779]">
                  Seller: {reviewingOrder.sellerName}
                </p>
              </div>
              <button
                type="button"
                aria-label="Close review dialog"
                onClick={() => {
                  setReviewingOrder(null);
                  setEditingReview(null);
                }}
                className="rounded-lg p-1 text-[#6B6779] hover:bg-[#FAF9FC] hover:text-[#14121A]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 space-y-3.5">
              {!editingReview && reviewingOrder.items.length > 1 ? (
                <div>
                  <label
                    htmlFor="review-item-select"
                    className="block text-xs font-bold text-[#14121A]"
                  >
                    Item to Review
                  </label>
                  <select
                    id="review-item-select"
                    value={reviewListingId}
                    onChange={(e) => setReviewListingId(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-[#E6E3EE] bg-white px-3 py-2 text-xs font-semibold text-[#14121A] focus:border-[#4E2A84] focus:outline-none"
                  >
                    {reviewingOrder.items
                      .filter(
                        (it) =>
                          it.listingId &&
                          !reviewingOrder.reviews.some(
                            (r) => r.listingId === it.listingId
                          )
                      )
                      .map((it) => (
                        <option key={it.id} value={it.listingId ?? ""}>
                          {it.title}
                        </option>
                      ))}
                  </select>
                </div>
              ) : null}

              <div>
                <label
                  htmlFor="review-rating-select"
                  className="block text-xs font-bold text-[#14121A]"
                >
                  Star Rating (1–5)
                </label>
                <select
                  id="review-rating-select"
                  value={reviewRating}
                  onChange={(e) => setReviewRating(Number(e.target.value))}
                  className="mt-1 w-full rounded-xl border border-[#E6E3EE] bg-white px-3 py-2 text-xs font-semibold text-[#14121A] focus:border-[#4E2A84] focus:outline-none"
                >
                  {[5, 4, 3, 2, 1].map((n) => (
                    <option key={n} value={n}>
                      {"★".repeat(n)} ({n} {n === 1 ? "Star" : "Stars"})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="review-comment-input"
                  className="block text-xs font-bold text-[#14121A]"
                >
                  Your Honest Review (5&ndash;1,000 characters)
                </label>
                <textarea
                  id="review-comment-input"
                  rows={4}
                  maxLength={1000}
                  value={reviewComment}
                  onChange={(e) => setReviewComment(e.target.value)}
                  placeholder="Share item quality, campus handover experience, and accuracy..."
                  className="mt-1 w-full rounded-xl border border-[#E6E3EE] bg-white px-3 py-2 text-xs text-[#14121A] focus:border-[#4E2A84] focus:outline-none"
                />
              </div>

              {reviewFormError ? (
                <p role="alert" className="text-xs font-semibold text-[#B42318]">
                  {reviewFormError}
                </p>
              ) : null}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setReviewingOrder(null);
                  setEditingReview(null);
                }}
                className="rounded-xl border border-[#E6E3EE] bg-white px-4 py-2 text-xs font-bold text-[#14121A] hover:bg-[#FAF9FC]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busyKey === `rev:${reviewingOrder.id}`}
                onClick={handleSubmitProductReview}
                className="inline-flex items-center gap-1.5 rounded-xl bg-[#4E2A84] px-4 py-2 text-xs font-bold text-white hover:bg-[#3F216B] disabled:opacity-50"
              >
                {busyKey === `rev:${reviewingOrder.id}` ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Star className="h-3.5 w-3.5" />
                )}
                <span>{editingReview ? "Save Changes" : "Publish Review"}</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
