"use client";

import Link from "next/link";
import { OrderAmounts, OrderDetailsLayout, OrderItems, OrderSection, orderButton, type OrderDisplayItem } from "@/components/orders/OrderDisplay";
import { PaymentControls } from "@/components/orders/OrderControls";
import { useOrderClock, useOrderRefresh } from "@/components/orders/useOrderClock";
import type { BuyerPendingCheckoutView } from "@/lib/orders/data";
import { getOrderPresentation, LATE_PAYMENT_GUIDANCE } from "@/lib/orders/lifecycle";

export function CheckoutOrderDetails({ checkout, back, listSuffix, serverNow }: {
  checkout: Omit<BuyerPendingCheckoutView, "orders" | "source" | "billUrl" | "paidAt"> & {
    orders: Array<{ id: string; sellerName: string; orderCode: string; items: OrderDisplayItem[] }>;
  };
  back: string; listSuffix: string; serverNow: number;
}) {
  const now = useOrderClock(serverNow);
  useOrderRefresh(checkout.status === "pending_payment" || checkout.paymentStatus === "late_payment_review");
  const reviewing = checkout.paymentStatus === "late_payment_review";
  const presentation = getOrderPresentation({
    status: checkout.status, paymentStatus: checkout.paymentStatus, paymentDeadline: checkout.paymentDeadline,
  }, now);
  return (
    <OrderDetailsLayout back={back} backLabel="Back to My Orders" code={checkout.checkoutCode} name={checkout.orders.length > 1 ? "Shared checkout" : "Checkout"}
      date={checkout.createdAt} badge={presentation.badge}
      aside={<OrderSection title="Payment summary">
        <OrderAmounts subtotal={checkout.combinedSubtotalSen} fpxFee={checkout.fpxFeeSen} total={checkout.totalPaidSen} totalLabel="Checkout total" />
        <p className="mt-3 text-sm text-ink-secondary">ToyyibPay FPX Sandbox</p>
        {checkout.transactionRef && <p className="mt-1 break-all text-sm text-ink-secondary">Transaction reference {checkout.transactionRef}</p>}
        {!reviewing && checkout.status !== "paid" && <div className="mt-3">
          <PaymentControls checkoutId={checkout.id} deadline={checkout.paymentDeadline} now={now}
            canPay={checkout.status === "pending_payment"} underReview={false} showStatus={Boolean(checkout.billCode)} />
        </div>}
      </OrderSection>}
    >
      {reviewing && <p role="status" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-950">{LATE_PAYMENT_GUIDANCE}</p>}
      {checkout.status === "paid" && <p className="rounded-xl bg-brand-teal/10 p-4 text-sm">Payment verified. You can open each order below.</p>}
      {checkout.orders.map((order) => <OrderSection key={order.id} title={order.sellerName}>
        <p className="text-xs text-ink-secondary">#{order.orderCode}</p>
        <OrderItems items={order.items} />
        {checkout.status === "paid" && <Link href={`/orders/${order.id}${listSuffix}`} className={orderButton}>View Order</Link>}
      </OrderSection>)}
    </OrderDetailsLayout>
  );
}
