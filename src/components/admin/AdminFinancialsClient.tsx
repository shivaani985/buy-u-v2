"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  Loader2,
  PackageCheck,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import {
  adminApproveRefundRestockAction,
  adminConfigureRefundReturnAction,
  adminExecuteRefundAction,
  adminRunSafeRecoveryAction,
  confirmReturnReceiptAction,
} from "@/app/financials/actions";
import type { AdminFinancialDashboardData } from "@/lib/financials/admin-data";
import { formatMytDateTime } from "@/lib/financials/policy";
import { formatCurrencySen } from "@/lib/format";

interface AdminFinancialsClientProps {
  data: AdminFinancialDashboardData;
}

type TabKey = "overview" | "refunds" | "payments" | "withdrawals";

export function AdminFinancialsClient({ data }: AdminFinancialsClientProps) {
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>("overview");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const { overview, refunds, withdrawals, checkouts } = data;

  async function runAction(
    key: string,
    fn: () => Promise<{ ok: boolean; message: string }>
  ) {
    setBusyKey(key);
    setFeedback(null);
    try {
      const res = await fn();
      setFeedback({ type: res.ok ? "success" : "error", text: res.message });
      if (res.ok) router.refresh();
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="space-y-5">
      {/* Navigation tabs + Sanitized CSV Export */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#E6E3EE] bg-white p-3.5">
        <div role="tablist" className="flex flex-wrap gap-1.5">
          {[
            { key: "overview" as const, label: "Overview & Reconciliation" },
            { key: "refunds" as const, label: `Refunds & Returns (${refunds.length})` },
            { key: "payments" as const, label: `Payments (${checkouts.length})` },
            { key: "withdrawals" as const, label: `Withdrawals (${withdrawals.length})` },
          ].map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={`rounded-xl px-3.5 py-1.5 text-xs font-bold transition ${
                tab === t.key
                  ? "bg-[#4E2A84] text-white"
                  : "border border-[#E6E3EE] bg-[#FAF9FC] text-[#4A4656] hover:border-[#4E2A84]"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <a
          href="/api/admin/financials/export"
          className="inline-flex items-center gap-1.5 rounded-xl border border-[#4E2A84] bg-white px-3.5 py-1.5 text-xs font-bold text-[#4E2A84] hover:bg-[#F3EEFA]"
        >
          <Download className="h-3.5 w-3.5" />
          <span>Export Sanitized CSV</span>
        </a>
      </div>

      {feedback ? (
        <p
          role={feedback.type === "success" ? "status" : "alert"}
          className={`flex items-center gap-1.5 rounded-xl border px-4 py-3 text-xs font-semibold ${
            feedback.type === "success"
              ? "border-[#B8E3E4] bg-[#F2FAFA] text-[#006A6D]"
              : "border-[#F9C6C2] bg-[#FEF2F2] text-[#B42318]"
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

      {/* TAB 1: Overview & Internal Reconciliation */}
      {tab === "overview" ? (
        <div className="space-y-4">
          <p className="rounded-xl border border-[#DCD0F0] bg-[#F7F3FD] px-4 py-2.5 text-xs text-[#3E2468]">
            <strong>FYP Simulation &amp; Accounting Notice:</strong> Platform
            commission (2%) is tracked separately from ToyyibPay FPX fees (RM
            1.00/checkout — not platform profit). Refunds and bank withdrawals
            execute via simulated providers; internal reconciliation verifies
            database ledger integrity, not external bank statements.
          </p>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {[
              { label: "Verified Collections", val: formatCurrencySen(overview.totalVerifiedCollectionsSen) },
              { label: "Gross Product Sales", val: formatCurrencySen(overview.grossProductSalesSen) },
              { label: "FPX Fees (Not Profit)", val: formatCurrencySen(overview.fpxFeesCollectedSen) },
              { label: "Executed Refunds (Sim)", val: formatCurrencySen(overview.executedRefundsSen) },
              { label: "Net Product Sales", val: formatCurrencySen(overview.netProductSalesSen) },
              { label: "Net Commission (2%)", val: formatCurrencySen(overview.netPlatformCommissionSen) },
              { label: "Pending Settlement", val: formatCurrencySen(overview.pendingSettlementSen) },
              { label: "72h Protection Reserve", val: formatCurrencySen(overview.protectionReserveSen) },
              { label: "Frozen Seller Earnings", val: formatCurrencySen(overview.frozenEarningsSen) },
              { label: "Available Liabilities", val: formatCurrencySen(overview.availableSellerLiabilitiesSen) },
              { label: "Reserved Withdrawals", val: formatCurrencySen(overview.reservedWithdrawalsSen) },
              { label: "Paid Out (Simulated)", val: formatCurrencySen(overview.successfullyPaidOutSen) },
            ].map((k) => (
              <div
                key={k.label}
                className="rounded-2xl border border-[#E6E3EE] bg-white px-4 py-3"
              >
                <p className="text-[11px] font-bold text-[#6B6779]">{k.label}</p>
                <p className="mt-1 text-base font-extrabold text-[#14121A]">
                  {k.val}
                </p>
              </div>
            ))}
          </div>

          {/* Read-only Reconciliation Checks */}
          <div className="rounded-2xl border border-[#E6E3EE] bg-white p-4">
            <h3 className="inline-flex items-center gap-1.5 text-sm font-extrabold text-[#14121A]">
              <ShieldCheck className="h-4 w-4 text-[#008285]" />
              <span>Internal Financial Reconciliation (Read-Only)</span>
            </h3>
            <ul className="mt-3 divide-y divide-[#F1EFF6] text-xs">
              {overview.checks.map((c) => (
                <li
                  key={c.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2.5"
                >
                  <div>
                    <p className="font-bold text-[#14121A]">{c.label}</p>
                    <p className="text-[11px] text-[#6B6779]">{c.detail}</p>
                  </div>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-[11px] font-extrabold ${
                      c.status === "PASS"
                        ? "bg-[#E6F6F6] text-[#006A6D]"
                        : "bg-[#FEF2F2] text-[#B42318]"
                    }`}
                  >
                    {c.status}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {/* TAB 2: Refunds & Returns Execution */}
      {tab === "refunds" ? (
        <div className="space-y-3">
          {refunds.length === 0 ? (
            <p className="rounded-2xl border border-[#E6E3EE] bg-white p-8 text-center text-xs text-[#6B6779]">
              No refund execution records yet.
            </p>
          ) : (
            refunds.map((r) => {
              const canExec =
                (r.status === "pending_execution" || r.status === "failed") &&
                (!r.returnRequired ||
                  r.returnStatus === "return_confirmed" ||
                  r.returnStatus === "return_exception");
              return (
                <div
                  key={r.id}
                  className="rounded-2xl border border-[#E6E3EE] bg-white p-4 text-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono font-extrabold text-[#14121A]">
                        {r.refundCode}
                      </span>
                      <span className="font-bold text-[#4E2A84]">
                        #{r.orderCode}
                      </span>
                      <span className="capitalize text-[#6B6779]">
                        {r.refundType.replace(/_/g, " ")}
                      </span>
                    </div>
                    <span className="rounded-full bg-[#F3EEFA] px-2.5 py-0.5 text-[11px] font-bold text-[#4E2A84]">
                      {r.status.replace(/_/g, " ")}
                    </span>
                  </div>

                  <div className="mt-2.5 grid grid-cols-2 gap-2 rounded-xl bg-[#FAF9FC] p-3 sm:grid-cols-4">
                    <div>
                      <p className="text-[10.5px] text-[#6B6779]">Refund</p>
                      <p className="font-extrabold text-[#14121A]">
                        {formatCurrencySen(r.refundAmountSen)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10.5px] text-[#6B6779]">
                        Commission Reversal
                      </p>
                      <p className="font-bold text-[#4E2A84]">
                        {formatCurrencySen(r.commissionReversalSen)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10.5px] text-[#6B6779]">
                        Seller Deduction
                      </p>
                      <p className="font-bold text-[#B42318]">
                        {formatCurrencySen(r.sellerDeductionSen)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10.5px] text-[#6B6779]">
                        Return / Restock
                      </p>
                      <p className="font-semibold text-[#14121A]">
                        {r.returnStatus.replace(/_/g, " ")} &middot;{" "}
                        {r.restockStatus.replace(/_/g, " ")}
                      </p>
                    </div>
                  </div>

                  {r.refundRef ? (
                    <p className="mt-2 font-mono text-[11px] font-bold text-[#006A6D]">
                      Simulated Refund Ref: {r.refundRef} (Completed{" "}
                      {formatMytDateTime(r.completedAt)})
                    </p>
                  ) : null}

                  <div className="mt-3 flex flex-wrap gap-2">
                    {r.status !== "succeeded" ? (
                      <>
                        <button
                          type="button"
                          disabled={busyKey !== null}
                          onClick={() =>
                            runAction(`ret:${r.id}`, () =>
                              adminConfigureRefundReturnAction({
                                refundId: r.id,
                                returnRequired: !r.returnRequired,
                                returnInstructions: !r.returnRequired
                                  ? "Return item to seller at campus collection point and click Mark Item Returned."
                                  : undefined,
                              })
                            )
                          }
                          className="rounded-xl border border-[#E6E3EE] bg-white px-3 py-1.5 font-bold text-[#4A4656] hover:border-[#4E2A84]"
                        >
                          {r.returnRequired
                            ? "Waive Return Requirement"
                            : "Require Physical Return"}
                        </button>

                        {r.returnRequired &&
                        r.returnStatus !== "return_confirmed" &&
                        r.returnStatus !== "return_exception" ? (
                          <button
                            type="button"
                            disabled={busyKey !== null}
                            onClick={() =>
                              runAction(`cret:${r.id}`, () =>
                                confirmReturnReceiptAction({
                                  refundId: r.id,
                                  itemCondition: "resellable",
                                  isAdminException: false,
                                })
                              )
                            }
                            className="rounded-xl border border-[#4E2A84] bg-white px-3 py-1.5 font-bold text-[#4E2A84]"
                          >
                            Admin Confirm Return (Resellable)
                          </button>
                        ) : null}

                        {r.status === "processing" ||
                        r.status === "reconciliation_required" ? (
                          <button
                            type="button"
                            disabled={busyKey !== null}
                            onClick={() =>
                              runAction(`recr:${r.id}`, () =>
                                adminRunSafeRecoveryAction({
                                  entityType: "refund",
                                  entityId: r.id,
                                })
                              )
                            }
                            className="rounded-xl border border-[#B42318] bg-white px-3 py-1.5 font-bold text-[#B42318] hover:bg-[#FEF2F2]"
                          >
                            Run Safe Recovery Check
                          </button>
                        ) : null}

                        <button
                          type="button"
                          disabled={!canExec || busyKey !== null}
                          onClick={() =>
                            runAction(`exec:${r.id}`, () =>
                              adminExecuteRefundAction(r.id)
                            )
                          }
                          className="inline-flex items-center gap-1.5 rounded-xl bg-[#008285] px-4 py-1.5 font-bold text-white hover:bg-[#006B6E] disabled:opacity-50"
                        >
                          {busyKey === `exec:${r.id}` ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="h-3.5 w-3.5" />
                          )}
                          <span>Execute Simulated Refund</span>
                        </button>
                      </>
                    ) : null}

                    {r.refundType === "full_refund" &&
                    r.restockStatus === "pending_decision" ? (
                      <>
                        <button
                          type="button"
                          disabled={busyKey !== null}
                          onClick={() =>
                            runAction(`rstk:${r.id}`, () =>
                              adminApproveRefundRestockAction({
                                refundId: r.id,
                                approve: true,
                              })
                            )
                          }
                          className="inline-flex items-center gap-1 rounded-xl border border-[#008285] bg-white px-3 py-1.5 font-bold text-[#008285]"
                        >
                          <PackageCheck className="h-3.5 w-3.5" />
                          <span>Approve Restock</span>
                        </button>
                        <button
                          type="button"
                          disabled={busyKey !== null}
                          onClick={() =>
                            runAction(`drstk:${r.id}`, () =>
                              adminApproveRefundRestockAction({
                                refundId: r.id,
                                approve: false,
                              })
                            )
                          }
                          className="rounded-xl border border-[#E6E3EE] bg-white px-3 py-1.5 font-bold text-[#6B6779]"
                        >
                          Decline Restock
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </div>
      ) : null}

      {/* TAB 3: Verified Payment Transactions */}
      {tab === "payments" ? (
        <div className="overflow-x-auto rounded-2xl border border-[#E6E3EE] bg-white">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-[#ECEAF3] bg-[#FAF9FC] text-[11px] font-bold text-[#6B6779]">
              <tr>
                <th className="px-4 py-2.5">Checkout</th>
                <th className="px-4 py-2.5">Subtotal</th>
                <th className="px-4 py-2.5">FPX Fee</th>
                <th className="px-4 py-2.5">Total Paid</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Gateway Ref</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F1EFF6]">
              {checkouts.map((cs) => (
                <tr key={cs.id}>
                  <td className="px-4 py-3 font-mono font-bold text-[#14121A]">
                    {cs.checkout_code}
                  </td>
                  <td className="px-4 py-3">{formatCurrencySen(cs.combined_subtotal_sen)}</td>
                  <td className="px-4 py-3">{formatCurrencySen(cs.fpx_fee_sen)}</td>
                  <td className="px-4 py-3 font-bold text-[#4E2A84]">
                    {formatCurrencySen(cs.total_paid_sen)}
                  </td>
                  <td className="px-4 py-3 font-bold capitalize">{cs.status}</td>
                  <td className="px-4 py-3 font-mono text-[11px] text-[#4A4656]">
                    {cs.transaction_ref || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* TAB 4: Withdrawal Monitoring (NO routine approval, NO arbitrary Mark Paid!) */}
      {tab === "withdrawals" ? (
        <div className="overflow-x-auto rounded-2xl border border-[#E6E3EE] bg-white">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-[#ECEAF3] bg-[#FAF9FC] text-[11px] font-bold text-[#6B6779]">
              <tr>
                <th className="px-4 py-2.5">Reference</th>
                <th className="px-4 py-2.5">Seller</th>
                <th className="px-4 py-2.5">Masked Bank</th>
                <th className="px-4 py-2.5">Amount</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Simulated Ref</th>
                <th className="px-4 py-2.5">Exception Recovery</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F1EFF6]">
              {withdrawals.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-8 text-center text-[#6B6779]"
                  >
                    No seller withdrawals recorded yet.
                  </td>
                </tr>
              ) : (
                withdrawals.map((w) => (
                  <tr key={w.id}>
                    <td className="px-4 py-3 font-mono font-bold text-[#14121A]">
                      {w.withdrawalCode}
                    </td>
                    <td className="px-4 py-3 font-semibold">{w.sellerName}</td>
                    <td className="px-4 py-3 text-[#4A4656]">
                      {w.maskedBankSummary}
                    </td>
                    <td className="px-4 py-3 font-bold text-[#4E2A84]">
                      {formatCurrencySen(w.amountSen)}
                    </td>
                    <td className="px-4 py-3 font-bold capitalize">
                      {w.status.replace(/_/g, " ")}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px]">
                      {w.transferRef || "—"}
                    </td>
                    <td className="px-4 py-3">
                      {w.status === "reconciliation_required" ||
                      w.status === "processing" ? (
                        <button
                          type="button"
                          disabled={busyKey !== null}
                          onClick={() =>
                            runAction(`relw:${w.id}`, () =>
                              adminRunSafeRecoveryAction({
                                entityType: "withdrawal",
                                entityId: w.id,
                              })
                            )
                          }
                          className="rounded-lg border border-[#4E2A84] px-2.5 py-1 text-[11px] font-bold text-[#4E2A84] hover:bg-[#F3EEFA]"
                        >
                          Run Safe Recovery Check
                        </button>
                      ) : (
                        <span className="text-[#8B869B]">—</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
