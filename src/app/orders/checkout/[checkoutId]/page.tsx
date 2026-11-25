import { notFound, redirect } from "next/navigation";
import { CheckoutOrderDetails } from "@/components/orders/CheckoutOrderDetails";
import { isValidUuid } from "@/lib/disputes/validation";
import { getBuyerOrdersData } from "@/lib/orders/data";
import { orderListQuery, withOrderListQuery, type OrderSearchParams } from "@/lib/orders/navigation";
import { getSessionSummary } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Checkout Details" };

export default async function Page({ params, searchParams }: {
  params: Promise<{ checkoutId: string }>; searchParams: Promise<OrderSearchParams>;
}) {
  const [{ checkoutId }, filters, session] = await Promise.all([params, searchParams, getSessionSummary()]);
  if (!isValidUuid(checkoutId)) notFound();
  const { eligibility, orders, pendingCheckouts, error, serverNow } = await getBuyerOrdersData(session, { checkoutId });
  if (eligibility.code === "unauthenticated") redirect(`/login?next=${encodeURIComponent(withOrderListQuery(`/orders/checkout/${checkoutId}`, filters))}`);
  if (error) return <p role="alert" className="mx-auto max-w-3xl p-6">{error}</p>;
  const checkout = pendingCheckouts[0] ?? (orders[0]?.checkout ? { ...orders[0].checkout, orders } : null);
  if (!checkout) notFound();
  const query = orderListQuery(filters).toString();
  const summary = {
    id: checkout.id, checkoutCode: checkout.checkoutCode, status: checkout.status,
    paymentStatus: checkout.paymentStatus, transactionRef: checkout.transactionRef, billCode: checkout.billCode,
    combinedSubtotalSen: checkout.combinedSubtotalSen, fpxFeeSen: checkout.fpxFeeSen,
    totalPaidSen: checkout.totalPaidSen, paymentDeadline: checkout.paymentDeadline, createdAt: checkout.createdAt,
    orders: checkout.orders.map(({ id, sellerName, orderCode, items }) => ({
      id, sellerName, orderCode,
      items: items.map(({ id, title, variantLabel, quantity, unitSen, imageUrl, isService }) =>
        ({ id, title, variantLabel, quantity, unitSen, imageUrl, isService })),
    })),
  };
  return <CheckoutOrderDetails checkout={summary} back={withOrderListQuery("/orders", filters)}
    listSuffix={query ? `?${query}` : ""} serverNow={serverNow} />;
}
