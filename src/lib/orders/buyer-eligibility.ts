import type { BuyerOrderView } from "@/lib/orders/data";
import { isBlockingRefundStatus } from "@/lib/orders/lifecycle";

export function isBuyerOrderBlocked(order: BuyerOrderView) {
  return order.status === "disputed"
    || ["open", "under_review"].includes(order.dispute?.status ?? "")
    || ["pending_execution", "failed"].includes(order.dispute?.refundExecutionStatus ?? "")
    || isBlockingRefundStatus(order.refund?.status);
}

export function getUnreviewedItems(order: BuyerOrderView) {
  if (order.status !== "completed" || !order.paymentVerified || isBuyerOrderBlocked(order)) return [];
  if (order.refund?.refundType === "full_refund" && order.refund.status === "succeeded") return [];
  const reviewed = new Set(order.reviews.map((review) => review.listingId));
  return order.items.filter((item) => {
    if (item.listingId === null || reviewed.has(item.listingId)) return false;
    reviewed.add(item.listingId);
    return true;
  });
}
