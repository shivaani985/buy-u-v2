import type { Metadata } from "next";
import Link from "next/link";
import { AlertCircle, Lock } from "lucide-react";
import { OrdersClient } from "@/components/orders/OrdersClient";
import { getBuyerOrdersData } from "@/lib/orders/data";
import { getSessionSummary } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "My Orders",
  description: "Track payments, purchases and services.",
};

export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  const session = await getSessionSummary();
  const { eligibility, pendingCheckouts, orders, error, serverNow } =
    await getBuyerOrdersData(session);

  return (
    <div className="bg-[#FAFAFC]">
      <div className="bori-container py-6 lg:py-8">
        {!eligibility.eligible ? (
          <section className="rounded-2xl border border-[#E6E3EE] bg-white p-6 shadow-[0_1px_4px_rgba(20,18,26,0.03)] sm:p-8">
            <div className="flex items-start gap-3">
              <Lock
                className="mt-0.5 h-5 w-5 shrink-0 text-[#4E2A84]"
                aria-hidden="true"
              />
              <div>
                <h1 className="text-base font-extrabold text-[#14121A]">
                  {eligibility.code === "unauthenticated"
                    ? "Sign in to view your orders"
                    : "Buyer access required"}
                </h1>
                <p className="mt-1 text-sm text-[#555062]">
                  {eligibility.reason}
                </p>
                {eligibility.code === "unauthenticated" ? (
                  <Link
                    href="/login?next=%2Forders"
                    className="mt-4 inline-flex items-center rounded-xl bg-[#4E2A84] px-5 py-2.5 text-sm font-bold text-white shadow-[0_2px_6px_rgba(78,42,132,0.2)] transition hover:bg-[#3A1E66] press-feedback"
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
            className="flex items-start gap-3 rounded-2xl border border-[#B42318]/30 bg-white p-6 shadow-[0_1px_4px_rgba(20,18,26,0.03)]"
          >
            <AlertCircle
              className="mt-0.5 h-5 w-5 shrink-0 text-[#B42318]"
              aria-hidden="true"
            />
            <p className="text-sm font-medium text-[#3E3A4A]">{error}</p>
          </section>
        ) : (
          <OrdersClient pendingCheckouts={pendingCheckouts} orders={orders} serverNow={serverNow} />
        )}
      </div>
    </div>
  );
}
