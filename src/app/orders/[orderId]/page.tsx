import { notFound, redirect } from "next/navigation";
import { getOrderCompletionMode } from "@/app/orders/actions";
import { BuyerOrderDetails } from "@/components/orders/BuyerOrderDetails";
import { OrderTimeline } from "@/components/orders/OrderTimeline";
import { isValidUuid } from "@/lib/disputes/validation";
import { getBuyerOrdersData } from "@/lib/orders/data";
import { withOrderListQuery, type OrderSearchParams } from "@/lib/orders/navigation";
import { getSessionSummary } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Order Details" };

export default async function Page({ params, searchParams }: {
  params: Promise<{ orderId: string }>; searchParams: Promise<OrderSearchParams>;
}) {
  const [{ orderId }, filters, session] = await Promise.all([params, searchParams, getSessionSummary()]);
  if (!isValidUuid(orderId)) notFound();
  const { eligibility, orders, error, serverNow } = await getBuyerOrdersData(session, { orderId });
  if (eligibility.code === "unauthenticated") redirect(`/login?next=${encodeURIComponent(withOrderListQuery(`/orders/${orderId}`, filters))}`);
  if (error) return <p role="alert" className="mx-auto max-w-3xl p-6">{error}</p>;
  const order = orders[0];
  if (!order) notFound();
  if (order.checkout && order.checkout.status !== "paid") {
    redirect(withOrderListQuery(`/orders/checkout/${order.checkout.id}`, filters));
  }
  const mode = order.status === "paid" ? await getOrderCompletionMode() : "unavailable";
  return <BuyerOrderDetails order={order} back={withOrderListQuery("/orders", filters)}
    timeline={<OrderTimeline order={order} snapshotAt={serverNow}
      paymentStatus={order.checkout?.paymentStatus ?? order.latestPayment?.status} />}
    mode={mode} serverNow={serverNow} startReview={filters.review === "1"} />;
}
