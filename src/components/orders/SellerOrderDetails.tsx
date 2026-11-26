"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { DisputeDetailCard } from "@/components/disputes/DisputeDetailCard";
import { OrderContact } from "@/components/orders/OrderControls";
import { OrderDetailsLayout, OrderItems, OrderSection, orderButton, orderPanel } from "@/components/orders/OrderDisplay";
import { ReviewGallery } from "@/components/reviews/ReviewGallery";
import { OrderFulfilment } from "@/components/orders/OrderFulfilment";
import { SellerCompleteOrder } from "@/components/orders/SellerCompleteOrder";
import { useOrderClock, useOrderRefresh } from "@/components/orders/useOrderClock";
import { formatMytDateTime } from "@/lib/financials/policy";
import { formatSenToRm } from "@/lib/format";
import { getOrderPresentation } from "@/lib/orders/lifecycle";
import type { SellerOrderView } from "@/lib/orders/seller-data";

export function SellerOrderDetails({ order, back, mode, serverNow, timeline }: {
  order: SellerOrderView; back: string; serverNow: number; mode: "unified" | "legacy" | "unavailable"; timeline: ReactNode;
}) {
  const now = useOrderClock(serverNow);
  useOrderRefresh(["paid", "handed_over", "pending_payment", "disputed"].includes(order.status));
  const presentation = getOrderPresentation({
    status: order.status, paymentStatus: order.paymentStatus, paymentDeadline: order.paymentDeadline,
    hasFinancialIssue: order.hasActiveDispute, refundStatus: order.refund?.status, isService: order.isServiceOrder,
  }, now);
  const deadline = order.protectionExpiresAt;
  const eligible = order.status === "paid" && order.paymentVerified && !order.hasActiveDispute;
  const available = order.adjustedNetSen === null || order.allocatedSen === null
    ? null : Math.max(0, order.adjustedNetSen - order.allocatedSen);
  const protectionActive = Boolean(deadline && Date.parse(deadline) > now);
  const earningsLabel = order.hasActiveDispute ? "Earnings frozen during dispute or refund processing"
    : order.status === "refunded" ? "Order refunded"
    : !order.paymentVerified ? "Payment awaiting verification"
    : order.status !== "completed" ? "Pending settlement"
    : !deadline ? "Protection deadline unavailable"
    : protectionActive ? "Earnings held during buyer protection"
    : available === null ? "Protection ended. Check Withdrawals for your available balance."
    : available > 0 ? `${formatSenToRm(available)} available from this order for withdrawal`
    : "No earnings from this order remain available for withdrawal";

  return (
    <OrderDetailsLayout back={back} backLabel="Back to Seller Orders" code={order.orderCode} name={order.buyerName}
      badge={presentation.badge} date={order.createdAt} actions={<>
        {order.paymentVerified && <OrderContact seller orderId={order.id} recipientId={order.buyerId} />}
        <SellerCompleteOrder key={order.id} id={order.id} code={order.orderCode} mode={mode} lockedUntil={order.pinLockedUntil}
          failedAttempts={order.pinFailedAttempts} now={now} eligible={eligible} />
      </>}
      aside={<>
        <OrderSection title="Payment and earnings">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-2"><dt>Order amount</dt><dd>{formatSenToRm(order.subtotalSen)}</dd></div>
            <div className="flex justify-between gap-2"><dt>Platform commission</dt><dd>{formatSenToRm(order.commissionSen)}</dd></div>
            <div className="flex justify-between gap-2 border-t border-border-crisp pt-2 font-bold">
              <dt>{order.adjustedNetSen === null ? "Original net earnings" : "Net earnings"}</dt><dd>{formatSenToRm(order.adjustedNetSen ?? order.sellerNetSen)}</dd>
            </div>
            {Boolean(order.allocatedSen) && <div className="flex justify-between gap-2"><dt>Allocated to withdrawals</dt><dd>{formatSenToRm(order.allocatedSen ?? 0)}</dd></div>}
          </dl>
          <p className="mt-3 text-sm font-bold">{earningsLabel}</p>
          <p className="mt-2 text-sm text-ink-secondary">ToyyibPay FPX Sandbox · {order.paymentVerified ? "Verified" : presentation.badge.label}</p>
          {order.transactionRef && !order.checkoutSessionId && <p className="mt-1 break-all text-sm text-ink-secondary">Transaction reference {order.transactionRef}</p>}
          {order.status === "completed" && <Link href="/seller/withdrawals" className={`${orderButton} mt-3`}>View Withdrawals</Link>}
        </OrderSection>
        {deadline && <OrderSection title="Buyer protection">
          <p className="text-sm font-bold">{protectionActive ? "Protection active" : "Protection ended"}</p>
          <p className="text-sm text-ink-secondary">{formatMytDateTime(deadline)}</p>
        </OrderSection>}
      </>}
    >
      {eligible && mode === "unavailable" && <p role="status" className="text-sm">Completion is temporarily unavailable. Refresh to try again.</p>}
      <OrderSection title="Order progress">
        {timeline}
        {order.status === "handed_over" && <p className="mt-2 text-sm text-ink-secondary">{order.handedOverAt ? "PIN verified on " + formatMytDateTime(order.handedOverAt) + ". " : ""}Waiting for the buyer to confirm receipt under the previous order flow.</p>}
      </OrderSection>
      <OrderSection title="Purchased items"><OrderItems items={order.items} itemAction={order.paymentVerified ? (item) => <OrderContact seller orderId={order.id} orderItemId={item.id} recipientId={order.buyerId} /> : undefined} /></OrderSection>
      {order.paymentVerified && <OrderFulfilment id={order.id} area={order.collectionAreaName} service={order.isServiceOrder} items={order.items} />}
      {(order.dispute || order.refund) && <details id="dispute" open className={orderPanel}>
        <summary className="cursor-pointer px-4 py-3 font-bold">Refund &amp; Dispute</summary>
        {order.dispute && <DisputeDetailCard dispute={order.dispute} />}
        <div className="space-y-2 border-t border-border-crisp px-4 py-3 text-sm">
          {order.refund && <>
            <p className="font-bold">Refund {formatSenToRm(order.refund.amountSen)} · <span className="capitalize">{order.refund.status.replaceAll("_", " ")}</span></p>
            {order.refund.status === "succeeded" && <p>Completed in the sandbox.</p>}
            {!order.isServiceOrder && order.refund.returnRequired && <p>Return status {order.refund.returnStatus.replaceAll("_", " ")}</p>}
          </>}
          <Link href="/seller/disputes" className={orderButton}>Manage Dispute or Return</Link>
        </div>
      </details>}
      {order.reviews.length > 0 && <OrderSection title="Verified purchase reviews">
        {order.reviews.map((review) => <div key={review.id} className="mt-3 space-y-1.5 border-t border-border-crisp pt-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-bold">{review.rating}/5</p>
            {review.isAnonymous ? (
              <span className="rounded-md bg-[#F4F1FA] px-2 py-0.5 text-[10px] font-bold text-[#4E2A84]">
                Anonymous Buyer
              </span>
            ) : null}
            {review.editedAt ? (
              <span className="rounded-md bg-[#F4F3F7] px-2 py-0.5 text-[10px] font-semibold text-[#555062]">
                Edited
              </span>
            ) : null}
          </div>
          <p className="whitespace-pre-wrap break-words">{review.comment}</p>
          {review.media && review.media.length > 0 ? <ReviewGallery media={review.media} compact /> : null}
          {review.sellerResponse && <p className="whitespace-pre-wrap break-words text-brand-purple">Your reply · {review.sellerResponse}</p>}
        </div>)}
      </OrderSection>}
    </OrderDetailsLayout>
  );
}
