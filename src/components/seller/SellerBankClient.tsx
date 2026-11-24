"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  CheckCircle2,
  Landmark,
  Loader2,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import {
  deactivateSellerBankAccountAction,
  saveSellerBankAccountAction,
} from "@/app/financials/actions";
import { MALAYSIAN_BANKS } from "@/lib/financials/bank";
import { formatMytDateTime } from "@/lib/financials/policy";

export interface MaskedSellerBankAccount {
  bankName: string;
  accountHolderName: string;
  accountNumberMasked: string;
  validationStatus: string;
  isActive: boolean;
  updatedAt: string;
}

interface SellerBankClientProps {
  account: MaskedSellerBankAccount | null;
}

export function SellerBankClient({ account }: SellerBankClientProps) {
  const router = useRouter();
  const [bankName, setBankName] = useState<string>(
    account?.bankName || MALAYSIAN_BANKS[0]
  );
  const [holderName, setHolderName] = useState(
    account?.accountHolderName || ""
  );
  const [accountNumber, setAccountNumber] = useState("");
  const [confirmNumber, setConfirmNumber] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!confirmed) {
      setFeedback({
        type: "error",
        text: "Please tick the confirmation box before saving your bank details.",
      });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const res = await saveSellerBankAccountAction({
        bankName,
        accountHolderName: holderName,
        accountNumber,
        confirmAccountNumber: confirmNumber,
      });
      setFeedback({
        type: res.ok ? "success" : "error",
        text: res.message,
      });
      if (res.ok) {
        setAccountNumber("");
        setConfirmNumber("");
        setConfirmed(false);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleDeactivate() {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await deactivateSellerBankAccountAction();
      setFeedback({
        type: res.ok ? "success" : "error",
        text: res.message,
      });
      if (res.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      {/* Current masked bank account summary */}
      <section className="rounded-2xl border border-[#E6E3EE] bg-white p-5 lg:col-span-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="inline-flex items-center gap-2 text-base font-extrabold text-[#14121A]">
            <Landmark className="h-4 w-4 text-[#4E2A84]" />
            <span>Registered Payout Account</span>
          </h2>
          {account?.isActive ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-[#B8E3E4] bg-[#E6F6F6] px-2.5 py-0.5 text-[11px] font-bold text-[#006A6D]">
              <ShieldCheck className="h-3 w-3" />
              <span>Account Details Validated</span>
            </span>
          ) : null}
        </div>

        {account?.isActive ? (
          <dl className="mt-4 space-y-2.5 rounded-xl border border-[#ECEAF3] bg-[#FAF9FC] p-4 text-xs">
            <div className="flex justify-between gap-2">
              <dt className="text-[#6B6779]">Bank</dt>
              <dd className="font-bold text-[#14121A]">{account.bankName}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-[#6B6779]">Account Holder</dt>
              <dd className="font-bold text-[#14121A]">
                {account.accountHolderName}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-[#6B6779]">Account Number</dt>
              <dd className="font-mono font-extrabold text-[#4E2A84]">
                {account.accountNumberMasked}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-[#6B6779]">Last Updated</dt>
              <dd className="text-[#4A4656]">
                {formatMytDateTime(account.updatedAt)}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="mt-4 rounded-xl border border-dashed border-[#D7D2E5] bg-[#FAF9FC] p-4 text-xs text-[#6B6779]">
            No active payout bank account registered. Register a Malaysian bank
            account to enable automated seller withdrawals (minimum RM 2.00).
          </p>
        )}

        <p className="mt-3 text-[11px] leading-relaxed text-[#6B6779]">
          Buy-U validates internal format only and never requests your banking
          password, ATM PIN, TAC, or OTP. Full account numbers are encrypted at
          rest on the server and masked in all screens. Use synthetic bank
          details for FYP testing.
        </p>

        {account?.isActive ? (
          <button
            type="button"
            disabled={busy}
            onClick={handleDeactivate}
            className="mt-4 inline-flex items-center gap-1.5 rounded-xl border border-[#F9C6C2] bg-[#FFF8F8] px-3.5 py-2 text-xs font-bold text-[#B42318] hover:bg-[#FEF2F2] disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>Deactivate Account</span>
          </button>
        ) : null}
      </section>

      {/* Add / Replace Form */}
      <section className="rounded-2xl border border-[#E6E3EE] bg-white p-5 lg:col-span-7">
        <h2 className="text-base font-extrabold text-[#14121A]">
          {account?.isActive
            ? "Replace Payout Bank Account"
            : "Add Payout Bank Account"}
        </h2>
        <p className="mt-0.5 text-xs text-[#6B6779]">
          Historical withdrawals keep an immutable snapshot of the destination
          used at the time of payout.
        </p>

        <form onSubmit={handleSave} className="mt-4 space-y-3.5 text-xs">
          <div>
            <label
              htmlFor="bank-name"
              className="block font-bold text-[#14121A]"
            >
              Malaysian Bank
            </label>
            <select
              id="bank-name"
              value={bankName}
              onChange={(e) => setBankName(e.target.value)}
              className="mt-1 w-full rounded-xl border border-[#E6E3EE] bg-white px-3.5 py-2.5 text-xs font-semibold text-[#14121A] focus:border-[#4E2A84] focus:outline-none"
            >
              {MALAYSIAN_BANKS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="holder-name"
              className="block font-bold text-[#14121A]"
            >
              Account Holder Name
            </label>
            <input
              id="holder-name"
              type="text"
              required
              minLength={3}
              maxLength={100}
              value={holderName}
              onChange={(e) => setHolderName(e.target.value)}
              placeholder="Full name as registered with bank"
              className="mt-1 w-full rounded-xl border border-[#E6E3EE] bg-white px-3.5 py-2.5 text-xs text-[#14121A] focus:border-[#4E2A84] focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor="acct-num"
                className="block font-bold text-[#14121A]"
              >
                Bank Account Number (8&ndash;18 digits)
              </label>
              <input
                id="acct-num"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                required
                value={accountNumber}
                onChange={(e) =>
                  setAccountNumber(e.target.value.replace(/\D/g, "").slice(0, 18))
                }
                placeholder="e.g. 162012345678"
                className="mt-1 w-full rounded-xl border border-[#E6E3EE] bg-white px-3.5 py-2.5 font-mono text-xs text-[#14121A] focus:border-[#4E2A84] focus:outline-none"
              />
            </div>

            <div>
              <label
                htmlFor="acct-confirm"
                className="block font-bold text-[#14121A]"
              >
                Confirm Account Number
              </label>
              <input
                id="acct-confirm"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                required
                value={confirmNumber}
                onChange={(e) =>
                  setConfirmNumber(e.target.value.replace(/\D/g, "").slice(0, 18))
                }
                placeholder="Re-enter account number"
                className="mt-1 w-full rounded-xl border border-[#E6E3EE] bg-white px-3.5 py-2.5 font-mono text-xs text-[#14121A] focus:border-[#4E2A84] focus:outline-none"
              />
            </div>
          </div>

          <label className="flex items-start gap-2 rounded-xl border border-[#ECEAF3] bg-[#FAF9FC] p-3 text-xs text-[#4A4656]">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[#4E2A84]"
            />
            <span>
              I confirm these payout account details are accurate (FYP simulated
              disbursement mode — no real bank transfers are executed).
            </span>
          </label>

          {feedback ? (
            <p
              role={feedback.type === "success" ? "status" : "alert"}
              className={`flex items-center gap-1.5 font-semibold ${
                feedback.type === "success"
                  ? "text-[#006A6D]"
                  : "text-[#B42318]"
              }`}
            >
              {feedback.type === "success" ? (
                <CheckCircle2 className="h-4 w-4 shrink-0" />
              ) : (
                <AlertCircle className="h-4 w-4 shrink-0" />
              )}
              <span>{feedback.text}</span>
            </p>
          ) : null}

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-xl bg-[#4E2A84] px-5 py-2.5 text-xs font-bold text-white hover:bg-[#3F216B] disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ShieldCheck className="h-3.5 w-3.5" />
              )}
              <span>
                {account?.isActive ? "Save & Replace Account" : "Save Bank Account"}
              </span>
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
