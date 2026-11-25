import { notFound } from "next/navigation";
import { getOrderCompletionMode } from "@/app/orders/actions";
import { OrderTimeline } from "@/components/orders/OrderTimeline";
import { SellerOrderDetails } from "@/components/orders/SellerOrderDetails";
import { SellerGate } from "@/components/seller/SellerGate";
import { isValidUuid } from "@/lib/disputes/validation";
import { withOrderListQuery, type OrderSearchParams } from "@/lib/orders/navigation";
import { getSellerOrdersData } from "@/lib/orders/seller-data";
import { getSessionSummary } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Seller Order Details" };

export default async function Page({ params, searchParams }: {
  params: Promise<{ orderId: string }>; searchParams: Promise<OrderSearchParams>;
}) {
  const [{ orderId }, filters, session] = await Promise.all([params, searchParams, getSessionSummary()]);
  if (!isValidUuid(orderId)) notFound();
  const { eligibility, orders, error, serverNow } = await getSellerOrdersData(session, orderId);
  if (!eligibility.eligible) return <SellerGate eligibility={eligibility} nextPath={withOrderListQuery(`/seller/orders/${orderId}`, filters)} />;
  if (error) return <p role="alert" className="mx-auto max-w-3xl p-6">{error}</p>;
  const order = orders[0];
  if (!order) notFound();
  const mode = order.status === "paid" ? await getOrderCompletionMode() : "unavailable";
  return <SellerOrderDetails order={order} back={withOrderListQuery("/seller/orders", filters)}
    timeline={<OrderTimeline order={order} snapshotAt={serverNow} paymentStatus={order.paymentStatus} />}
    serverNow={serverNow} mode={mode} />;
}
