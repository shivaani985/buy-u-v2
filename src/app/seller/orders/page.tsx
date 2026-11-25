import { getOrderCompletionMode } from "@/app/orders/actions";
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
    "Manage buyer orders, verify order completion PINs, and track settlement status.",
};

export const dynamic = "force-dynamic";

export default async function SellerOrdersPage() {
  const session = await getSessionSummary();
  const eligibility = evaluateSellerEligibility(session);

  if (!eligibility.eligible) {
    return <SellerGate eligibility={eligibility} nextPath="/seller/orders" />;
  }

  const [{ orders, error, serverNow }, mode] = await Promise.all([getSellerOrdersData(session), getOrderCompletionMode()]);
  const newOrderCount = orders.filter(
    (o) => o.status === "paid" && o.paymentVerified && !o.hasActiveDispute
  ).length;

  return (
    <div className="bg-[#FAFAFC]">
      <div className="bori-container space-y-6 py-6 lg:py-8">
        <SellerNav newOrderCount={newOrderCount} />

        {error ? (
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
          <SellerOrdersClient orders={orders} mode={mode} serverNow={serverNow} />
        )}
      </div>
    </div>
  );
}
