import type { Metadata } from "next";
import Link from "next/link";
import { AlertCircle, Lock, Package } from "lucide-react";
import { OrdersClient } from "@/components/orders/OrdersClient";
import { getBuyerOrdersData } from "@/lib/orders/data";
import { getSessionSummary } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "My Orders",
  description: "Track your UMSKAL campus marketplace orders and pickup status.",
};

export const dynamic = "force-dynamic";

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
            Track your ToyyibPay FPX payments, pickup PINs, and campus collection
            details.
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
            <Lock
              className="mt-0.5 h-5 w-5 shrink-0 text-[#4E2A84]"
              aria-hidden="true"
            />
            <div>
              <h2 className="text-base font-bold text-[#14121A]">
                {eligibility.code === "unauthenticated"
                  ? "Sign in to view your orders"
                  : "Buyer access required"}
              </h2>
              <p className="mt-1 text-sm text-[#6B6779]">
                {eligibility.reason}
              </p>
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
          <AlertCircle
            className="mt-0.5 h-5 w-5 shrink-0 text-[#B42318]"
            aria-hidden="true"
          />
          <p className="text-sm text-[#3E3A4A]">{error}</p>
        </section>
      ) : orders.length === 0 ? (
        <section className="rounded-2xl border border-[#E6E3EE] bg-white px-6 py-14 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-[#E6E3EE] bg-[#FAF9FC] text-[#4E2A84]">
            <Package className="h-6 w-6" aria-hidden="true" />
          </div>
          <h2 className="mt-4 text-lg font-bold text-[#14121A]">
            No orders yet
          </h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-[#6B6779]">
            Orders placed via Cart checkout or accepted bargaining offers will
            appear here with ToyyibPay FPX status and your private pickup PIN.
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
        <OrdersClient orders={orders} />
      )}
    </div>
  );
}
