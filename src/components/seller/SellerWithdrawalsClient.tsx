"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Landmark,
  Loader2,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import { requestSellerWithdrawalAction } from "@/app/financials/actions";
import {
  BUYER_PROTECTION_HOURS,
  formatMytDateTime,
  MIN_WITHDRAWAL_SEN,
} from "@/lib/financials/policy";
import { formatSenToRm } from "@/lib/format";
import type { SellerFinancialSummary } from "@/lib/seller/financials";
import { parseRmToSen } from "@/lib/seller/validation";

export interface SellerWithdrawalHistoryItem {
  id: string;
  withdrawalCode: string;
  amountSen: number;
  maskedBankSummary: string;
  status: string;
  transferRef: string | null;
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface SellerWithdrawalsClientProps {
  financials: SellerFinancialSummary;
  activeBankSummary: string | null;
  withdrawals: SellerWithdrawalHistoryItem[];
}

export function SellerWithdrawalsClient({
  financials,
  activeBankSummary,
  withdrawals,
}: SellerWithdrawalsClientProps) {
  const router = useRouter();
  const [amountInput, setAmountInput] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingSen, setPendingSen] = useState(0);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const availSen = financials.availableForPayoutSen;

  function openConfirmation() {
    setFeedback(null);
    if (!activeBankSummary) {
      setFeedback({
        type: "error",
        text: "Register an active payout bank account first.",
      });
      return;
    }
    const parsed = parseRmToSen(amountInput);
    if (!parsed.ok) {
      setFeedback({ type: "error", text: parsed.error });
      return;
    }
    if (parsed.sen < MIN_WITHDRAWAL_SEN) {
      setFeedback({
        type: "error",
        text: `Minimum withdrawal is ${formatSenToRm(MIN_WITHDRAWAL_SEN)}.`,
      });
      return;
    }
    if (parsed.sen > availSen) {
      setFeedback({
        type: "error",
        text: `Amount exceeds your available balance (${formatSenToRm(availSen)}).`,
      });
      return;
    }
    setPendingSen(parsed.sen);
    setConfirmOpen(true);
  }

  async function executeWithdrawal() {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await requestSellerWithdrawalAction({
        amountSen: pendingSen,
      });
      setConfirmOpen(false);
      setFeedback({
        type: res.ok ? "success" : "error",
        text: res.message,
      });
      if (res.ok) {
        setAmountInput("");
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  const cards = [
    {
      label: "Available for Withdrawal",
      value: formatSenToRm(availSen),
      sub: `Passed ${BUYER_PROTECTION_HOURS}h buyer protection`,
      accent: "border-l-[#008285]",
    },
    {
      label: "Buyer Protection Reserve (72h)",
      value: formatSenToRm(financials.protectionReserveSen),
      sub: financials.nextProtectionReleaseAt
        ? `Next release: ${formatMytDateTime(financials.nextProtectionReleaseAt)}`
        : "No orders in 72h reserve",
      accent: "border-l-[#4E2A84]",
    },
    {
      label: "Pending Settlement",
      value: formatSenToRm(financials.pendingSettlementSen),
      sub: "Awaiting handover or buyer confirmation",
      accent: "border-l-[#4E2A84]",
    },
    {
      label: "Frozen (Disputes / Refunds)",
      value: formatSenToRm(financials.frozenDisputeSen),
      sub: "Held until dispute/refund resolves",
      accent: "border-l-[#B42318]",
    },
    {
      label: "Processing Withdrawals",
      value: formatSenToRm(financials.reservedWithdrawalsSen),
      sub: "Reserved for active transfer",
      accent: "border-l-[#4E2A84]",
    },
    {
      label: "Total Paid Out (Simulated)",
      value: formatSenToRm(financials.totalPaidOutSen),
      sub: `${financials.failedWithdrawalCount} failed attempts excluded`,
      accent: "border-l-[#008285]",
    },
  ];

  return (
    <div className="space-y-6">
      {/* 6-Bucket Mutually Exclusive Ledger */}
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => (
          <div
            key={c.label}
            className={`rounded-2xl border border-[#E6E3EE] border-l-[3px] ${c.accent} bg-white px-4 py-3.5`}
          >
            <p className="text-[11.5px] font-bold text-[#6B6779]">{c.label}</p>
            <p className="mt-1 text-xl font-extrabold text-[#14121A]">
              {c.value}
            </p>
            <p className="mt-0.5 text-[11px] text-[#6B6779]">{c.sub}</p>
          </div>
        ))}
      </div>

      {/* Withdraw Form */}
      <section className="rounded-2xl border border-[#E6E3EE] bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="inline-flex items-center gap-2 text-base font-extrabold text-[#14121A]">
              <Wallet className="h-4 w-4 text-[#4E2A84]" />
              <span>Withdraw Funds (Automatic Simulated Disbursement)</span>
            </h2>
            <p className="mt-0.5 text-xs text-[#6B6779]">
              Minimum RM 2.00 · Withdrawal fee RM 0.00 · Processed automatically
              without manual admin approval (FYP simulation — no real bank
              transfer).
            </p>
          </div>
          {!activeBankSummary ? (
            <Link
              href="/seller/bank"
              className="inline-flex items-center gap-1.5 rounded-xl bg-[#4E2A84] px-3.5 py-2 text-xs font-bold text-white hover:bg-[#3F216B]"
            >
              <Landmark className="h-3.5 w-3.5" />
              <span>Register Bank Account</span>
            </Link>
          ) : null}
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-12">
          <div className="rounded-xl border border-[#ECEAF3] bg-[#FAF9FC] p-3.5 text-xs md:col-span-5">
            <p className="font-bold text-[#6B6779]">Payout Destination</p>
            <p className="mt-1 font-extrabold text-[#14121A]">
              {activeBankSummary || "No active bank account registered"}
            </p>
            <p className="mt-2 inline-flex items-center gap-1 text-[11px] text-[#4E2A84]">
              <Clock className="h-3.5 w-3.5" />
              <span>
                Completed orders release automatically after 72 hours unless
                disputed.
              </span>
            </p>
          </div>

          <div className="flex flex-col justify-between gap-3 md:col-span-7">
            <div className="flex flex-wrap items-end gap-2.5">
              <div className="flex-1 min-w-[160px]">
                <label
                  htmlFor="withdraw-amount"
                  className="block text-xs font-bold text-[#14121A]"
                >
                  Amount (RM)
                </label>
                <input
                  id="withdraw-amount"
                  type="text"
                  inputMode="decimal"
                  disabled={!activeBankSummary || availSen < MIN_WITHDRAWAL_SEN || busy}
                  value={amountInput}
                  onChange={(e) => setAmountInput(e.target.value)}
                  placeholder="e.g. 14.70"
                  className="mt-1 w-full rounded-xl border border-[#E6E3EE] bg-white px-3.5 py-2.5 text-sm font-bold text-[#14121A] focus:border-[#4E2A84] focus:outline-none disabled:bg-[#F3F2F7]"
                />
              </div>
              <button
                type="button"
                disabled={!activeBankSummary || availSen < MIN_WITHDRAWAL_SEN || busy}
                onClick={() => setAmountInput((availSen / 100).toFixed(2))}
                className="rounded-xl border border-[#E6E3EE] bg-[#FAF9FC] px-3.5 py-2.5 text-xs font-bold text-[#4E2A84] hover:border-[#4E2A84] disabled:opacity-50"
              >
                Withdraw All ({formatSenToRm(availSen)})
              </button>
              <button
                type="button"
                disabled={!activeBankSummary || availSen < MIN_WITHDRAWAL_SEN || busy}
                onClick={openConfirmation}
                className="inline-flex items-center gap-1.5 rounded-xl bg-[#008285] px-5 py-2.5 text-xs font-bold text-white hover:bg-[#006B6E] disabled:opacity-50"
              >
                <ShieldCheck className="h-4 w-4" />
                <span>Withdraw Funds</span>
              </button>
            </div>

            {feedback ? (
              <p
                role={feedback.type === "success" ? "status" : "alert"}
                className={`flex items-center gap-1.5 text-xs font-semibold ${
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
          </div>
        </div>
      </section>

      {/* Withdrawal History */}
      <section className="overflow-hidden rounded-2xl border border-[#E6E3EE] bg-white">
        <div className="border-b border-[#ECEAF3] px-5 py-3.5">
          <h2 className="text-sm font-extrabold text-[#14121A]">
            Withdrawal History ({withdrawals.length})
          </h2>
        </div>
        {withdrawals.length === 0 ? (
          <p className="px-5 py-8 text-center text-xs text-[#6B6779]">
            No withdrawals yet. Once completed orders pass the 72-hour
            protection window, you can withdraw automatically.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[#ECEAF3] bg-[#FAF9FC] text-[11px] font-bold text-[#6B6779]">
                <tr>
                  <th className="px-4 py-2.5">Reference</th>
                  <th className="px-4 py-2.5">Destination</th>
                  <th className="px-4 py-2.5">Amount</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Simulated Transfer Ref</th>
                  <th className="px-4 py-2.5">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F1EFF6]">
                {withdrawals.map((w) => (
                  <tr key={w.id}>
                    <td className="px-4 py-3 font-mono font-bold text-[#14121A]">
                      {w.withdrawalCode}
                    </td>
                    <td className="px-4 py-3 text-[#4A4656]">
                      {w.maskedBankSummary}
                    </td>
                    <td className="px-4 py-3 font-extrabold text-[#4E2A84]">
                      {formatSenToRm(w.amountSen)}
                    </td>
                    <td className="px-4 py-3 font-bold capitalize">
                      {w.status.replace(/_/g, " ")}
                      {w.failureReason ? (
                        <span className="block text-[10.5px] font-normal text-[#B42318]">
                          {w.failureReason}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-[#4A4656]">
                      {w.transferRef || "—"}
                    </td>
                    <td className="px-4 py-3 text-[#6B6779]">
                      {formatMytDateTime(w.completedAt || w.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Confirmation Dialog */}
      {confirmOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-wdr-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-md rounded-2xl border border-[#E6E3EE] bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between gap-2">
              <h2
                id="confirm-wdr-title"
                className="text-base font-extrabold text-[#14121A]"
              >
                Confirm Simulated Withdrawal
              </h2>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setConfirmOpen(false)}
                className="rounded-lg p-1 text-[#6B6779]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <dl className="mt-3 space-y-2 rounded-xl bg-[#FAF9FC] p-3.5 text-xs">
              <div className="flex justify-between">
                <dt className="text-[#6B6779]">Destination</dt>
                <dd className="font-bold text-[#14121A]">{activeBankSummary}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-[#6B6779]">Withdrawal Amount</dt>
                <dd className="font-extrabold text-[#4E2A84]">
                  {formatSenToRm(pendingSen)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-[#6B6779]">Fee (Simulated)</dt>
                <dd className="font-bold text-[#008285]">RM 0.00</dd>
              </div>
              <div className="flex justify-between border-t border-[#ECEAF3] pt-2">
                <dt className="text-[#6B6779]">Remaining Available</dt>
                <dd className="font-bold text-[#14121A]">
                  {formatSenToRm(Math.max(0, availSen - pendingSen))}
                </dd>
              </div>
            </dl>
            <p className="mt-2.5 text-[11px] text-[#6B6779]">
              FYP Simulation Disclosure: Disbursed automatically through the
              simulated Malaysian bank provider. No real money transfer occurs.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="rounded-xl border border-[#E6E3EE] bg-white px-4 py-2 text-xs font-bold text-[#14121A]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={executeWithdrawal}
                className="inline-flex items-center gap-1.5 rounded-xl bg-[#008285] px-4 py-2 text-xs font-bold text-white hover:bg-[#006B6E] disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                <span>Confirm &amp; Withdraw</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
