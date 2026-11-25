"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Flag, Loader2, Star, X } from "lucide-react";
import { openOrderDisputeAction } from "@/app/disputes/actions";
import { buyerReportReturnAction } from "@/app/financials/actions";
import { editVerifiedReviewAction, submitVerifiedReviewAction } from "@/app/marketplace-actions";
import { confirmOrderReceiptAction } from "@/app/orders/actions";
import { DisputeDetailCard } from "@/components/disputes/DisputeDetailCard";
import { DisputeEvidenceUploader, type UploadedEvidenceItem } from "@/components/disputes/DisputeEvidenceUploader";
import { CompletionPin } from "@/components/orders/CompletionPin";
import { OrderContact, PaymentControls } from "@/components/orders/OrderControls";
import { OrderFulfilment } from "@/components/orders/OrderFulfilment";
import { OrderAmounts, OrderDetailsLayout, OrderItems, OrderSection, orderButton, orderPanel } from "@/components/orders/OrderDisplay";
import { useOrderClock, useOrderRefresh } from "@/components/orders/useOrderClock";
import { DISPUTE_REASONS, evaluateBuyerDisputeEligibility, type DisputeReasonCode } from "@/lib/disputes/validation";
import { formatMytDateTime } from "@/lib/financials/policy";
import { formatSenToRm } from "@/lib/format";
import type { BuyerOrderReviewView, BuyerOrderView } from "@/lib/orders/data";
import { getUnreviewedItems, isBuyerOrderBlocked } from "@/lib/orders/buyer-eligibility";
import { getOrderPresentation, LATE_PAYMENT_GUIDANCE } from "@/lib/orders/lifecycle";

const SERVICE_DISPUTE_REASON_LABELS: Record<DisputeReasonCode, string> = {
  not_received: "Service not delivered / seller no-show",
  not_as_described: "Service not as described",
  damaged: "Poor quality or defective deliverable",
  wrong_item: "Wrong service delivered",
  missing_item: "Incomplete service or missing deliverables",
  other: "Other service issue",
};

export function BuyerOrderDetails({ order, back, mode, serverNow, startReview, timeline }: {
  order: BuyerOrderView; back: string; mode: "unified" | "legacy" | "unavailable";
  serverNow: number; startReview: boolean; timeline: ReactNode;
}) {
  const router = useRouter();
  const now = useOrderClock(serverNow);
  useOrderRefresh(["paid", "handed_over", "pending_payment", "disputed"].includes(order.status));
  const unreviewed = getUnreviewedItems(order);
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
    () => startReview && unreviewed.length > 0 ? order : null
  );
  const [editingReview, setEditingReview] =
    useState<BuyerOrderReviewView | null>(null);
  const [reviewListingId, setReviewListingId] = useState<string>(() => startReview ? unreviewed[0]?.listingId ?? "" : "");
  const [reviewRating, setReviewRating] = useState<number>(5);
  const [reviewComment, setReviewComment] = useState<string>("");
  const [reviewFormError, setReviewFormError] = useState<string | null>(null);
  const [feedbackByKey, setFeedbackByKey] = useState<
    Record<string, { type: "info" | "error"; text: string }>
  >({});

  const key = `ord:${order.id}`;
  const feedback = feedbackByKey[key];
  const blocked = isBuyerOrderBlocked(order);
  const reviewing = (order.checkout?.paymentStatus ?? order.latestPayment?.status) === "late_payment_review";
  const presentation = getOrderPresentation({
    status: order.status, paymentStatus: reviewing ? "late_payment_review" : null,
    paymentDeadline: order.paymentDeadline, hasFinancialIssue: blocked, refundStatus: order.refund?.status, isService: order.isServiceOrder,
  }, now);
  const fulfilmentAvailable = !reviewing && order.paymentVerified;
  const canReveal = fulfilmentAvailable && order.status === "paid" && !blocked;
  const canConfirm = fulfilmentAvailable && order.status === "handed_over" && !blocked;
  const canReport = fulfilmentAvailable && !blocked && evaluateBuyerDisputeEligibility({
    status: order.status, paidAt: order.paidAt, completedAt: order.completedAt,
    protectionExpiresAt: order.protectionExpiresAt, hasActiveDispute: blocked, nowMs: now,
  }).eligible;
  const deadline = order.protectionExpiresAt;
  const protectionMs = deadline ? Math.max(0, Date.parse(deadline) - now) : null;
  const protectionHours = protectionMs === null ? 0 : Math.ceil(protectionMs / (60 * 60 * 1000));
  const transactionRef = order.checkout?.transactionRef ?? order.latestPayment?.transactionRef;

  function openNewReviewDialog(order: BuyerOrderView) {
    const nextItem = getUnreviewedItems(order)[0];
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

  async function markReturned(refundId: string) {
    setBusyKey(`ret:${refundId}`);
    try {
      const result = await buyerReportReturnAction(refundId);
      setFeedbackByKey((previous) => ({ ...previous, [key]: { type: result.ok ? "info" : "error", text: result.message } }));
      if (result.ok) router.refresh();
    } catch {
      setFeedbackByKey((previous) => ({ ...previous, [key]: { type: "error", text: "Could not report the return. Try again." } }));
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <OrderDetailsLayout back={back} backLabel="Back to My Orders" code={order.orderCode} name={order.sellerName}
      date={order.createdAt} badge={presentation.badge}
      actions={fulfilmentAvailable && (
        <OrderContact orderId={order.id} code={order.orderCode} recipientId={order.sellerId} listingId={order.items[0]?.listingId} />
      )}
      aside={<>
        {canReveal && mode !== "unavailable" && <CompletionPin key={order.id} orderId={order.id} mode={mode} />}
        {canReveal && mode === "unavailable" && <OrderSection title="Order Completion PIN">
          <p className="text-sm">Completion instructions are temporarily unavailable. Refresh to try again.</p>
        </OrderSection>}
        {canConfirm && <OrderSection title="Confirm receipt">
          <p className="mb-3 text-sm text-ink-secondary">The seller verified your PIN {order.handedOverAt ? "on " + formatMytDateTime(order.handedOverAt) : "under the previous order flow"}. Confirm receipt to complete this order.</p>
          <button type="button" className={orderButton} onClick={() => setConfirmingOrder(order)}>Confirm Receipt</button>
        </OrderSection>}
        <OrderSection title="Payment summary">
          <OrderAmounts subtotal={order.subtotalSen} fpxFee={order.fpxFeeSen} total={order.totalPaidSen} />
          <div className="mt-3 space-y-1 text-sm text-ink-secondary">
            <p>ToyyibPay FPX Sandbox · {order.paymentVerified ? "Verified" : presentation.badge.label}</p>
            {order.source === "offer" && <p>Includes the accepted offer price.</p>}
            {transactionRef && <p className="break-all">Transaction reference {transactionRef}</p>}
            {order.checkout && <p>{order.checkout.combinedSubtotalSen > order.subtotalSen ? "Shared checkout" : "Checkout"} #{order.checkout.checkoutCode} totals {formatSenToRm(order.checkout.totalPaidSen)}, including one {formatSenToRm(order.checkout.fpxFeeSen)} FPX fee.</p>}
          </div>
          {!order.checkoutSessionId && !order.paymentVerified && !reviewing && ["pending_payment", "expired"].includes(presentation.status) && (
            <div className="mt-3"><PaymentControls orderId={order.id} deadline={order.paymentDeadline} now={now}
              canPay={order.status === "pending_payment"} underReview={false} showStatus={Boolean(order.latestPayment?.billCode)} /></div>
          )}
        </OrderSection>
        {(deadline || canReport) && <OrderSection title="Buyer protection">
          {deadline && <div className="text-sm text-ink-secondary">
            <p className="font-bold">{protectionMs ? "Protection active" : "Protection ended"}</p>
            <p>{formatMytDateTime(deadline)}{protectionMs ? ` · ${protectionHours} ${protectionHours === 1 ? "hour" : "hours"} remaining` : ""}</p>
          </div>}
          {canReport && <button type="button" className={`${orderButton} mt-2`} onClick={() => openReportDialog(order)}>
            <Flag className="size-4" aria-hidden="true" />Report a Problem
          </button>}
        </OrderSection>}
      </>}
    >
      {feedback && <p role={feedback.type === "error" ? "alert" : "status"} className="rounded-lg bg-white p-3 text-sm">{feedback.text}</p>}
      {reviewing && <p role="status" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-950">{LATE_PAYMENT_GUIDANCE}</p>}
      <OrderSection title="Order progress">
        {timeline}
      </OrderSection>
      <OrderSection title="Purchased items"><OrderItems items={order.items} /></OrderSection>
      {fulfilmentAvailable && <OrderFulfilment id={order.id} area={order.collectionAreaName} service={order.isServiceOrder} items={order.items} />}
      {(order.dispute || order.refund) && <details id="dispute" open className={orderPanel}>
        <summary className="cursor-pointer px-4 py-3 font-bold">Refund &amp; Dispute</summary>
        {order.dispute && <DisputeDetailCard dispute={order.dispute} />}
        {order.refund && <div className="space-y-2 border-t border-border-crisp px-4 py-3 text-sm">
          <p className="font-bold">{order.refund.refundType === "partial_refund" ? "Partial refund" : "Refund"} · {order.refund.refundCode} · {formatSenToRm(order.refund.refundAmountSen)}</p>
          <p className="capitalize">{order.refund.status.replaceAll("_", " ")}</p>
          <p className="text-ink-secondary">The checkout FPX fee is excluded.</p>
          {order.refund.refundRef && <p>Simulated refund reference {order.refund.refundRef}</p>}
          {!order.isServiceOrder && order.refund.returnRequired && <>
            <p>Return status {order.refund.returnStatus.replaceAll("_", " ")}</p>
            {order.refund.returnInstructions && <p className="whitespace-pre-wrap">{order.refund.returnInstructions}</p>}
            {order.refund.returnStatus === "awaiting_return" && <button type="button" className={orderButton}
              onClick={() => order.refund && markReturned(order.refund.id)} disabled={Boolean(busyKey)}>Mark Item Returned</button>}
          </>}
        </div>}
      </details>}
      {(unreviewed.length > 0 || order.reviews.length > 0) && <div id="reviews">
        <OrderSection title="Verified purchase reviews">
          {unreviewed.length > 0 && <button type="button" className={orderButton} onClick={() => openNewReviewDialog(order)}>
            <Star className="size-4" aria-hidden="true" />Write Review
          </button>}
          {order.reviews.map((review) => <div key={review.id} className="mt-3 space-y-1 border-t border-border-crisp pt-3 text-sm">
            <p className="font-bold">{review.rating}/5{order.items.find((item) => item.listingId === review.listingId)?.title
              ? ` · ${order.items.find((item) => item.listingId === review.listingId)?.title}` : ""}</p>
            <p className="whitespace-pre-wrap break-words">{review.comment}</p>
            {review.sellerResponse && <p className="whitespace-pre-wrap break-words text-brand-purple">Seller reply · {review.sellerResponse}</p>}
            {review.hidden ? <p className="text-ink-secondary">Hidden by moderation</p>
              : <button type="button" className={orderButton} onClick={() => openEditReviewDialog(order, review)}>Edit Review</button>}
          </div>)}
        </OrderSection>
      </div>}
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
              seller&apos;s earnings remain held during buyer protection.
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
                  Within the buyer protection window (ending{" "}
                  {formatMytDateTime(
                    reportingOrder.protectionExpiresAt
                  ) ?? "the stored deadline"}
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
                      {reportingOrder.isServiceOrder
                        ? SERVICE_DISPUTE_REASON_LABELS[r.code]
                        : r.label}
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
              {!editingReview && getUnreviewedItems(reviewingOrder).length > 1 ? (
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
                    {getUnreviewedItems(reviewingOrder)
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
    </OrderDetailsLayout>
  );
}
