import type { Metadata } from "next";
import Link from "next/link";
import { AlertCircle, Lock, MapPin, Package, Store } from "lucide-react";
import { formatSenToRm, formatShortDate } from "@/lib/format";
import { getBuyerOrdersData } from "@/lib/orders/data";
import { getSessionSummary } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "My Orders",
  description: "Track your UMSKAL campus marketplace orders and pickup status.",
};

function formatOrderStatus(status: string): { label: string; color: string } {
  switch (status.toLowerCase()) {
    case "completed":
    case "settled":
      return { label: "Completed", color: "text-[#008285]" };
    case "paid":
    case "ready_for_pickup":
      return { label: "Paid · Ready for Pickup", color: "text-[#1D70B8]" };
    case "pending_payment":
      return { label: "Awaiting Payment", color: "text-[#4E2A84]" };
    case "expired":
    case "cancelled":
    case "refunded":
      return { label: status.charAt(0).toUpperCase() + status.slice(1), color: "text-[#B42318]" };
    default:
      return { label: status.replace(/_/g, " "), color: "text-[#6B6779]" };
  }
}

export default async function OrdersPage() {
  const session = await getSessionSummary();
  const { eligibility, orders, error } = await getBuyerOrdersData(session);

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-6 lg:px-10">
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-[-0.02em] text-[#14121A] sm:text-3xl">
            My Orders
          </h1>
          <p className="mt-1 text-sm text-[#6B6779]">
            Review your campus purchase history and collection details.
          </p>
        </div>
        <Link
          href="/marketplace"
          className="text-xs font-bold text-[#4E2A84] transition hover:underline"
        >
          Browse Marketplace
        </Link>
      </div>

      {!eligibility.eligible ? (
        <section className="rounded-2xl border border-[#E6E3EE] bg-white p-6 sm:p-8">
          <div className="flex items-start gap-3">
            <Lock className="mt-0.5 h-5 w-5 shrink-0 text-[#4E2A84]" aria-hidden="true" />
            <div>
              <h2 className="text-base font-bold text-[#14121A]">
                {eligibility.code === "unauthenticated"
                  ? "Sign in to view your orders"
                  : "Buyer access required"}
              </h2>
              <p className="mt-1 text-sm text-[#6B6779]">{eligibility.reason}</p>
              {eligibility.code === "unauthenticated" ? (
                <Link
                  href="/login?next=%2Forders"
                  className="mt-4 inline-flex items-center rounded-xl bg-[#4E2A84] px-5 py-2.5 text-sm font-bold text-white transition hover:bg-[#3F216B]"
                >
                  Sign In with UMS Email
                </Link>
              ) : null}
            </div>
          </div>
        </section>
      ) : error ? (
        <section
          role="alert"
          className="flex items-start gap-3 rounded-2xl border border-[#E6E3EE] bg-white p-6"
        >
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-[#B42318]" aria-hidden="true" />
          <p className="text-sm text-[#3E3A4A]">{error}</p>
        </section>
      ) : orders.length === 0 ? (
        <section className="rounded-2xl border border-[#E6E3EE] bg-white px-6 py-14 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-[#E6E3EE] bg-[#FAF9FC] text-[#4E2A84]">
            <Package className="h-6 w-6" aria-hidden="true" />
          </div>
          <h2 className="mt-4 text-lg font-bold text-[#14121A]">No orders yet</h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-[#6B6779]">
            Completed and pending campus orders will appear here once checkout
            payment opens in Phase 6B.
          </p>
          <div className="mt-6">
            <Link
              href="/marketplace"
              className="inline-flex items-center rounded-xl bg-[#4E2A84] px-5 py-2.5 text-sm font-bold text-white transition hover:bg-[#3F216B]"
            >
              Explore Listings
            </Link>
          </div>
        </section>
      ) : (
        <div className="space-y-4">
          {orders.map((order) => {
            const st = formatOrderStatus(order.status);
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
                    <span className="text-[#C7C3D4]" aria-hidden="true">&middot;</span>
                    <span className="inline-flex items-center gap-1 font-semibold text-[#4A4656]">
                      <Store className="h-3.5 w-3.5 text-[#4E2A84]" aria-hidden="true" />
                      <span>{order.sellerName}</span>
                    </span>
                    <span className="text-[#C7C3D4]" aria-hidden="true">&middot;</span>
                    <span className="text-[#6B6779]">
                      {formatShortDate(order.createdAt)}
                    </span>
                  </div>
                  <span className={`font-bold ${st.color}`}>{st.label}</span>
                </div>

                <ul className="divide-y divide-[#F1EFF6]">
                  {order.items.map((item) => (
                    <li key={item.id} className="flex items-center gap-3.5 px-5 py-3.5">
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

                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#ECEAF3] bg-[#FAF9FC] px-5 py-3 text-xs">
                  <span className="inline-flex items-center gap-1 text-[#4A4656]">
                    <MapPin className="h-3.5 w-3.5 text-[#4E2A84]" aria-hidden="true" />
                    <span>Collection: {order.collectionAreaName}</span>
                  </span>
                  <div className="flex items-baseline gap-3">
                    <span className="text-[#6B6779]">
                      Subtotal {formatSenToRm(order.subtotalSen)} + FPX{" "}
                      {formatSenToRm(order.fpxFeeSen)}
                    </span>
                    <span className="text-sm font-extrabold text-[#4E2A84]">
                      {formatSenToRm(order.totalPaidSen)}
                    </span>
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
