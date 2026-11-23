import type { Metadata } from "next";
import Link from "next/link";
import { AlertCircle, ArrowLeft, Lock, RefreshCw } from "lucide-react";
import { CartClient } from "@/components/cart/CartClient";
import { getCartPageData } from "@/lib/buyer/cart-data";
import { getSessionSummary } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Shopping Cart",
  description: "Review items grouped by UMSKAL campus sellers before checkout.",
};

export default async function CartPage() {
  const session = await getSessionSummary();
  const { eligibility, summary, error } = await getCartPageData(session);

  return (
    <div className="mx-auto w-full max-w-[1320px] px-4 py-6 sm:px-6 lg:px-10">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link
            href="/marketplace"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#6B6779] transition hover:text-[#4E2A84]"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Back to Marketplace</span>
          </Link>
          <h1 className="mt-2 text-2xl font-extrabold tracking-[-0.02em] text-[#14121A] sm:text-3xl">
            Shopping Cart
          </h1>
          <p className="mt-1 text-sm text-[#6B6779]">
            Items are grouped by campus seller and validated against live stock.
          </p>
        </div>

        {eligibility.eligible && summary.totalQuantity > 0 ? (
          <p className="text-sm font-semibold text-[#4E2A84]">
            {summary.totalQuantity}{" "}
            {summary.totalQuantity === 1 ? "item" : "items"} in cart
          </p>
        ) : null}
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
                  ? "Sign in to view your cart"
                  : "Shopping access required"}
              </h2>
              <p className="mt-1 text-sm text-[#6B6779]">
                {eligibility.reason}
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                {eligibility.code === "unauthenticated" ? (
                  <Link
                    href="/login?next=%2Fcart"
                    className="inline-flex items-center rounded-xl bg-[#4E2A84] px-5 py-2.5 text-sm font-bold text-white transition hover:bg-[#3F216B]"
                  >
                    Sign In with UMS Email
                  </Link>
                ) : null}
                <Link
                  href="/marketplace"
                  className="inline-flex items-center rounded-xl border border-[#E6E3EE] bg-white px-4 py-2.5 text-sm font-semibold text-[#14121A] transition hover:border-[#4E2A84] hover:text-[#4E2A84]"
                >
                  Browse Marketplace
                </Link>
              </div>
            </div>
          </div>
        </section>
      ) : error ? (
        <section
          role="alert"
          className="rounded-2xl border border-[#E6E3EE] bg-white p-6 sm:p-8"
        >
          <div className="flex items-start gap-3">
            <AlertCircle
              className="mt-0.5 h-5 w-5 shrink-0 text-[#B42318]"
              aria-hidden="true"
            />
            <div>
              <h2 className="text-base font-bold text-[#14121A]">
                Could not load your cart
              </h2>
              <p className="mt-1 text-sm text-[#6B6779]">{error}</p>
              <div className="mt-4">
                <Link
                  href="/cart"
                  className="inline-flex items-center gap-2 rounded-xl bg-[#4E2A84] px-4 py-2 text-sm font-bold text-white transition hover:bg-[#3F216B]"
                >
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                  <span>Try Again</span>
                </Link>
              </div>
            </div>
          </div>
        </section>
      ) : (
        <CartClient summary={summary} />
      )}
    </div>
  );
}
