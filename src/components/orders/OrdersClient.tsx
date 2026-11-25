import { OrderList, type OrderListEntry } from "@/components/orders/OrderList";
import type { BuyerOrderItemView, BuyerOrderView, BuyerPendingCheckoutView } from "@/lib/orders/data";
import { getUnreviewedItems, isBuyerOrderBlocked } from "@/lib/orders/buyer-eligibility";

function preview(item: BuyerOrderItemView) {
  const { id, title, variantLabel, quantity, unitSen, imageUrl, isService } = item;
  return { id, title, variantLabel, quantity, unitSen, imageUrl, isService };
}

export function OrdersClient({ pendingCheckouts, orders, serverNow }: {
  pendingCheckouts: BuyerPendingCheckoutView[]; orders: BuyerOrderView[]; serverNow: number;
}) {
  const entries: OrderListEntry[] = orders.map((order) => ({
    id: order.id, code: order.orderCode, name: order.sellerName, status: order.status, createdAt: order.createdAt,
    amount: order.totalPaidSen, deadline: order.paymentDeadline, paymentStatus: order.latestPayment?.status,
    hasFinancialIssue: isBuyerOrderBlocked(order), refundStatus: order.refund?.status,
    items: order.items.map(preview), isService: order.isServiceOrder,
    canReview: getUnreviewedItems(order).length > 0, recipientId: order.paymentVerified ? order.sellerId : undefined,
    listingId: order.items[0]?.listingId,
  }));
  for (const checkout of pendingCheckouts) {
    const groups = new Map<string, { id: string; name: string; items: ReturnType<typeof preview>[] }>();
    for (const order of checkout.orders) {
      const group = groups.get(order.sellerId) ?? { id: order.sellerId, name: order.sellerName, items: [] };
      group.items.push(...order.items.map(preview));
      groups.set(order.sellerId, group);
    }
    entries.push({
      id: checkout.id, code: checkout.checkoutCode, name: checkout.orders.length > 1 ? "Shared checkout" : "Checkout", status: checkout.status, createdAt: checkout.createdAt,
      amount: checkout.totalPaidSen, deadline: checkout.paymentDeadline, paymentStatus: checkout.paymentStatus,
      items: checkout.orders.flatMap((order) => order.items.map(preview)),
      checkout: { subtotal: checkout.combinedSubtotalSen, fee: checkout.fpxFeeSen,
        groups: [...groups.values()], childCodes: checkout.orders.map((order) => order.orderCode) },
    });
  }
  return <OrderList entries={entries} serverNow={serverNow} />;
}
