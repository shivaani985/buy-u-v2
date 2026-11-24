import type { Metadata } from "next";
import { AlertCircle } from "lucide-react";
import { SellerGate } from "@/components/seller/SellerGate";
import { SellerNav } from "@/components/seller/SellerNav";
import { SellerOrdersClient } from "@/components/seller/SellerOrdersClient";
import { getSellerOrdersData } from "@/lib/orders/seller-data";
import { evaluateSellerEligibility } from "@/lib/seller/validation";
import { getSessionSummary } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Seller Orders",
  description:
    "Manage buyer orders, verify campus pickup PINs, and track settlement status.",
};

export const dynamic = "force-dynamic";

export default async function SellerOrdersPage() {
  const session = await getSessionSummary();
  const eligibility = evaluateSellerEligibility(session);

  if (!eligibility.eligible) {
    return <SellerGate eligibility={eligibility} nextPath="/seller/orders" />;
  }

  const { orders, error } = await getSellerOrdersData(session);

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-6 px-4 py-6 sm:px-6 lg:px-10">
      <SellerNav />

      <div>
        <h1 className="text-2xl font-extrabold tracking-[-0.02em] text-[#14121A] sm:text-3xl">
          Seller Orders
        </h1>
        <p className="mt-1 text-sm text-[#6B6779]">
          Coordinate campus pickup, verify buyer pickup PINs at handover, and
          track settlement status.
        </p>
      </div>

      {error ? (
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
      ) : (
        <SellerOrdersClient orders={orders} />
      )}
    </div>
  );
}
