import { OrderList, type OrderListEntry } from "@/components/orders/OrderList";
import type { SellerOrderView } from "@/lib/orders/seller-data";

export function SellerOrdersClient({ orders, mode, serverNow }: {
  orders: SellerOrderView[]; serverNow: number; mode: "unified" | "legacy" | "unavailable";
}) {
  const entries: OrderListEntry[] = orders.map((order) => ({
    id: order.id, code: order.orderCode, name: order.buyerName, status: order.status, createdAt: order.createdAt,
    amount: order.subtotalSen, deadline: order.paymentDeadline, hasFinancialIssue: order.hasActiveDispute,
    refundStatus: order.refund?.status, paymentStatus: order.paymentStatus,
    items: order.items.map(({ id, title, variantLabel, quantity, unitSen, imageUrl, isService }) =>
      ({ id, title, variantLabel, quantity, unitSen, imageUrl, isService })),
    isService: order.isServiceOrder, recipientId: order.paymentVerified ? order.buyerId : undefined,
    listingId: order.items[0]?.listingId,
    pin: order.paymentVerified && order.status === "paid" && !order.hasActiveDispute
      ? { failedAttempts: order.pinFailedAttempts, lockedUntil: order.pinLockedUntil } : undefined,
  }));
  return <OrderList entries={entries} seller serverNow={serverNow} completionMode={mode} />;
}
