import type { Metadata } from "next";
import { SellerGate } from "@/components/seller/SellerGate";
import { SellerNav } from "@/components/seller/SellerNav";
import {
  SellerWithdrawalsClient,
  type SellerWithdrawalHistoryItem,
} from "@/components/seller/SellerWithdrawalsClient";
import { getSellerHubData } from "@/lib/seller/data";
import { evaluateSellerEligibility } from "@/lib/seller/validation";
import {
  createSupabaseServerClient,
  getSessionSummary,
} from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Earnings & Withdrawals",
  description:
    "Track 72-hour buyer protection reserve, available earnings, and automated simulated withdrawals.",
};

export const dynamic = "force-dynamic";

export default async function SellerWithdrawalsPage() {
  const session = await getSessionSummary();
  const eligibility = evaluateSellerEligibility(session);

  if (!eligibility.eligible) {
    return (
      <SellerGate eligibility={eligibility} nextPath="/seller/withdrawals" />
    );
  }

  const [hub, supabase] = await Promise.all([
    getSellerHubData(session, "all"),
    createSupabaseServerClient(),
  ]);

  let activeBankSummary: string | null = null;
  let withdrawals: SellerWithdrawalHistoryItem[] = [];

  if (supabase && session.profile?.id) {
    const [bankRes, wdrRes] = await Promise.all([
      supabase
        .from("seller_payout_accounts")
        .select(
          "bank_name,account_holder_name,account_number_masked,validation_status,is_active"
        )
        .eq("seller_id", session.profile.id)
        .maybeSingle(),
      supabase
        .from("payout_requests")
        .select(
          "id,withdrawal_code,amount_sen,masked_bank_summary,status,transfer_ref,failure_reason,created_at,completed_at"
        )
        .eq("seller_id", session.profile.id)
        .order("created_at", { ascending: false })
        .limit(50),
    ]);

    const b = bankRes.data as {
      bank_name: string;
      account_holder_name: string;
      account_number_masked: string | null;
      validation_status: string | null;
      is_active: boolean | null;
    } | null;
    if (b && b.is_active === true && b.validation_status === "validated") {
      activeBankSummary = `${b.bank_name} · ${b.account_number_masked || "****"} (${b.account_holder_name})`;
    }

    if (!wdrRes.error && wdrRes.data) {
      withdrawals = (
        wdrRes.data as Array<{
          id: string;
          withdrawal_code: string | null;
          amount_sen: number;
          masked_bank_summary: string | null;
          status: string;
          transfer_ref: string | null;
          failure_reason: string | null;
          created_at: string;
          completed_at: string | null;
        }>
      ).map((w) => ({
        id: w.id,
        withdrawalCode:
          w.withdrawal_code || `WDR-${w.id.slice(0, 6).toUpperCase()}`,
        amountSen: Number(w.amount_sen ?? 0),
        maskedBankSummary: w.masked_bank_summary || "Registered Bank Account",
        status: w.status,
        transferRef: w.transfer_ref,
        failureReason: w.failure_reason,
        createdAt: w.created_at,
        completedAt: w.completed_at,
      }));
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-6 px-4 py-6 sm:px-6 lg:px-10">
      <SellerNav />
      <div>
        <h1 className="text-2xl font-extrabold tracking-[-0.02em] text-[#14121A] sm:text-3xl">
          Earnings &amp; Withdrawals
        </h1>
        <p className="mt-1 text-sm text-[#6B6779]">
          Completed order earnings enter a 3-day (72-hour) Buyer Protection
          Reserve before becoming automatically withdrawable.
        </p>
      </div>
      <SellerWithdrawalsClient
        financials={hub.financials}
        activeBankSummary={activeBankSummary}
        withdrawals={withdrawals}
      />
    </div>
  );
}
