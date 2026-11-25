import type { Metadata } from "next";
import {
  SellerBankClient,
  type MaskedSellerBankAccount,
} from "@/components/seller/SellerBankClient";
import { SellerGate } from "@/components/seller/SellerGate";
import { SellerNav } from "@/components/seller/SellerNav";
import { getSellerNewOrderCount } from "@/lib/seller/data";
import { evaluateSellerEligibility } from "@/lib/seller/validation";
import {
  createSupabaseServerClient,
  getSessionSummary,
} from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Payout Bank Account",
  description: "Manage your encrypted Malaysian payout bank account on Buy-U.",
};

export const dynamic = "force-dynamic";

export default async function SellerBankPage() {
  const session = await getSessionSummary();
  const eligibility = evaluateSellerEligibility(session);

  if (!eligibility.eligible) {
    return <SellerGate eligibility={eligibility} nextPath="/seller/bank" />;
  }

  const [supabase, newOrderCount] = await Promise.all([
    createSupabaseServerClient(),
    getSellerNewOrderCount(session),
  ]);
  let account: MaskedSellerBankAccount | null = null;

  if (supabase && session.profile?.id) {
    // Strictly select masked non-sensitive columns ONLY
    const { data } = await supabase
      .from("seller_payout_accounts")
      .select(
        "bank_name,account_holder_name,account_number_masked,validation_status,is_active,updated_at"
      )
      .eq("seller_id", session.profile.id)
      .maybeSingle();

    const row = data as {
      bank_name: string;
      account_holder_name: string;
      account_number_masked: string | null;
      validation_status: string | null;
      is_active: boolean | null;
      updated_at: string;
    } | null;

    if (row) {
      account = {
        bankName: row.bank_name,
        accountHolderName: row.account_holder_name,
        accountNumberMasked: row.account_number_masked || "****",
        validationStatus: row.validation_status || "re_registration_required",
        isActive: row.is_active === true && row.validation_status === "validated",
        updatedAt: row.updated_at,
      };
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-6 px-4 py-6 sm:px-6 lg:px-10">
      <SellerNav newOrderCount={newOrderCount} />
      <div>
        <h1 className="text-2xl font-extrabold tracking-[-0.02em] text-[#14121A] sm:text-3xl">
          Payout Bank Account
        </h1>
        <p className="mt-1 text-sm text-[#6B6779]">
          Register a Malaysian bank account for automated seller withdrawals
          (FYP simulated disbursement).
        </p>
      </div>
      <SellerBankClient account={account} />
    </div>
  );
}
