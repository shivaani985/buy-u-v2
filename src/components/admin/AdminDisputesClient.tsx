"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Search,
  ShieldAlert,
  Store,
  User,
} from "lucide-react";
import {
  adminMarkDisputeUnderReviewAction,
  adminResolveDisputeAction,
} from "@/app/disputes/actions";
import { DisputeDetailCard } from "@/components/disputes/DisputeDetailCard";
import { ServiceOrderDetailsBlock } from "@/components/orders/ServiceOrderDetailsBlock";
import type { AdminDisputeItemView } from "@/lib/disputes/data";
import type {
  DisputeResolutionType,
  DisputeStatus,
} from "@/lib/disputes/validation";
import { formatSenToRm, formatShortDate } from "@/lib/format";

interface AdminDisputesClientProps {
  disputes: AdminDisputeItemView[];
}

type FilterKey = "all" | DisputeStatus;

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "under_review", label: "Under Review" },
  { key: "resolved", label: "Resolved" },
];

export function AdminDisputesClient({ disputes }: AdminDisputesClientProps) {
  const router = useRouter();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");
  const [notesById, setNotesById] = useState<Record<string, string>>({});
  const [resTypeById, setResTypeById] = useState<
    Record<string, DisputeResolutionType>
  >({});
  const [partialRmById, setPartialRmById] = useState<Record<string, string>>(
    {}
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedbackById, setFeedbackById] = useState<
    Record<string, { type: "success" | "error"; text: string }>
  >({});

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return disputes.filter((d) => {
      if (filter !== "all" && d.status !== filter) return false;
      if (!q) return true;
      return (
        d.disputeCode.toLowerCase().includes(q) ||
        d.orderCode.toLowerCase().includes(q) ||
        d.buyerName.toLowerCase().includes(q) ||
        d.sellerName.toLowerCase().includes(q)
      );
    });
  }, [disputes, filter, query]);

  async function handleUnderReview(d: AdminDisputeItemView) {
    setBusyId(`rev:${d.id}`);
    try {
      const res = await adminMarkDisputeUnderReviewAction({
        disputeId: d.id,
        adminNotes: notesById[d.id] ?? d.adminNotes ?? undefined,
      });
      setFeedbackById((prev) => ({
        ...prev,
        [d.id]: { type: res.ok ? "success" : "error", text: res.message },
      }));
      if (res.ok) router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function handleResolve(d: AdminDisputeItemView) {
    const resolutionType = resTypeById[d.id] ?? "release_to_seller";
    let refundAmountSen: number | null = null;
    if (resolutionType === "partial_refund") {
      const parsed = Number.parseFloat(partialRmById[d.id] ?? "");
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setFeedbackById((prev) => ({
          ...prev,
          [d.id]: {
            type: "error",
            text: "Enter a valid partial refund amount in RM.",
          },
        }));
        return;
      }
      refundAmountSen = Math.round(parsed * 100);
    }

    setBusyId(`res:${d.id}`);
    try {
      const res = await adminResolveDisputeAction({
        disputeId: d.id,
        resolutionType,
        refundAmountSen,
        adminNotes: notesById[d.id] ?? d.adminNotes ?? undefined,
      });
      setFeedbackById((prev) => ({
        ...prev,
        [d.id]: { type: res.ok ? "success" : "error", text: res.message },
      }));
      if (res.ok) router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-2xl border border-[#E6E3EE] bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
        <div role="tablist" className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => {
            const active = filter === f.key;
            const count =
              f.key === "all"
                ? disputes.length
                : disputes.filter((d) => d.status === f.key).length;
            return (
              <button
                key={f.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setFilter(f.key)}
                className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold transition ${
                  active
                    ? "bg-[#4E2A84] text-white"
                    : "border border-[#E6E3EE] bg-[#FAF9FC] text-[#4A4656] hover:border-[#4E2A84]"
                }`}
              >
                <span>{f.label}</span>
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10.5px] font-extrabold ${
                    active ? "bg-white/20 text-white" : "bg-white text-[#6B6779]"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8B869B]" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search DSP ref, order, buyer, seller..."
            aria-label="Search disputes"
            className="w-full rounded-xl border border-[#E6E3EE] bg-[#FAF9FC] py-2 pl-9 pr-3 text-xs text-[#14121A] focus:border-[#4E2A84] focus:bg-white focus:outline-none"
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-[#E6E3EE] bg-white px-6 py-10 text-center text-xs text-[#6B6779]">
          <ShieldAlert className="mx-auto mb-2 h-6 w-6 text-[#4E2A84]" />
          No disputes match this filter.
        </div>
      ) : (
        <div className="space-y-4">
          {filtered.map((d) => {
            const isResolved = d.status === "resolved";
            const notes = notesById[d.id] ?? d.adminNotes ?? "";
            const resType = resTypeById[d.id] ?? "release_to_seller";
            const fb = feedbackById[d.id];

            return (
              <section
                key={d.id}
                className="overflow-hidden rounded-2xl border border-[#E6E3EE] bg-white"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#ECEAF3] px-5 py-3 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-extrabold text-[#14121A]">
                      {d.disputeCode}
                    </span>
                    <span className="text-[#C7C3D4]">&middot;</span>
                    <span className="font-bold text-[#4E2A84]">
                      #{d.orderCode}
                    </span>
                    {d.isServiceOrder ? (
                      <span className="inline-flex items-center rounded-full bg-[#F3ECFC] px-2 py-0.5 text-[10.5px] font-bold text-[#4E2A84]">
                        Service Order
                      </span>
                    ) : null}
                    <span className="text-[#C7C3D4]">&middot;</span>
                    <span className="inline-flex items-center gap-1 text-[#4A4656]">
                      <User className="h-3.5 w-3.5 text-[#4E2A84]" />
                      <span>Buyer: {d.buyerName}</span>
                    </span>
                    <span className="text-[#C7C3D4]">&middot;</span>
                    <span className="inline-flex items-center gap-1 text-[#4A4656]">
                      <Store className="h-3.5 w-3.5 text-[#008285]" />
                      <span>Seller: {d.sellerName}</span>
                    </span>
                  </div>
                  <span className="font-bold text-[#14121A]">
                    Subtotal {formatSenToRm(d.subtotalSen)} &middot;{" "}
                    {formatShortDate(d.createdAt)}
                  </span>
                </div>

                <DisputeDetailCard dispute={d} />
                <ServiceOrderDetailsBlock
                  orderId={d.orderId}
                  items={d.items}
                  compact
                />

                {/* Internal Admin Notes & Resolution Controls */}
                <div className="space-y-3 border-t border-[#ECEAF3] bg-[#FAF9FC] px-5 py-4 text-xs">
                  <div>
                    <label
                      htmlFor={`admin-notes-${d.id}`}
                      className="block text-[11px] font-extrabold uppercase tracking-wide text-[#4E2A84]"
                    >
                      Internal Admin Notes (Never Visible to Buyer or Seller)
                    </label>
                    <textarea
                      id={`admin-notes-${d.id}`}
                      rows={2}
                      disabled={isResolved}
                      value={notes}
                      onChange={(e) =>
                        setNotesById((prev) => ({
                          ...prev,
                          [d.id]: e.target.value,
                        }))
                      }
                      placeholder="Internal review notes..."
                      className="mt-1 w-full rounded-xl border border-[#E6E3EE] bg-white px-3 py-2 text-xs text-[#14121A] focus:border-[#4E2A84] focus:outline-none disabled:bg-[#F3F2F7]"
                    />
                  </div>

                  {!isResolved ? (
                    <div className="flex flex-wrap items-end justify-between gap-3">
                      <div className="flex flex-wrap items-end gap-2">
                        <div>
                          <label
                            htmlFor={`res-type-${d.id}`}
                            className="block text-[11px] font-bold text-[#14121A]"
                          >
                            Resolution Proposal
                          </label>
                          <select
                            id={`res-type-${d.id}`}
                            value={resType}
                            onChange={(e) =>
                              setResTypeById((prev) => ({
                                ...prev,
                                [d.id]: e.target.value as DisputeResolutionType,
                              }))
                            }
                            className="mt-1 rounded-xl border border-[#E6E3EE] bg-white px-3 py-2 text-xs font-semibold text-[#14121A]"
                          >
                            <option value="release_to_seller">
                              Release to Seller (Restore Pre-Dispute Stage)
                            </option>
                            <option value="full_refund">
                              Full Refund Proposal ({formatSenToRm(d.subtotalSen)})
                            </option>
                            <option value="partial_refund">
                              Partial Refund Proposal
                            </option>
                          </select>
                        </div>

                        {resType === "partial_refund" ? (
                          <div>
                            <label
                              htmlFor={`partial-rm-${d.id}`}
                              className="block text-[11px] font-bold text-[#14121A]"
                            >
                              Refund (RM)
                            </label>
                            <input
                              id={`partial-rm-${d.id}`}
                              type="number"
                              step="0.01"
                              min="0.01"
                              max={((d.subtotalSen - 1) / 100).toFixed(2)}
                              value={partialRmById[d.id] ?? ""}
                              onChange={(e) =>
                                setPartialRmById((prev) => ({
                                  ...prev,
                                  [d.id]: e.target.value,
                                }))
                              }
                              placeholder="e.g. 5.00"
                              className="mt-1 w-28 rounded-xl border border-[#E6E3EE] bg-white px-3 py-2 text-xs font-semibold text-[#14121A]"
                            />
                          </div>
                        ) : null}
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        {d.status === "open" ? (
                          <button
                            type="button"
                            disabled={busyId !== null}
                            onClick={() => handleUnderReview(d)}
                            className="inline-flex items-center gap-1.5 rounded-xl border border-[#4E2A84] bg-white px-3.5 py-2 text-xs font-bold text-[#4E2A84] hover:bg-[#F3EEFA] disabled:opacity-50"
                          >
                            {busyId === `rev:${d.id}` ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : null}
                            <span>Mark Under Review</span>
                          </button>
                        ) : null}
                        <button
                          type="button"
                          disabled={busyId !== null}
                          onClick={() => handleResolve(d)}
                          className="inline-flex items-center gap-1.5 rounded-xl bg-[#008285] px-4 py-2 text-xs font-bold text-white hover:bg-[#006B6E] disabled:opacity-50"
                        >
                          {busyId === `res:${d.id}` ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <CheckCircle2 className="h-3.5 w-3.5" />
                          )}
                          <span>Record Resolution</span>
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {resType !== "release_to_seller" && !isResolved ? (
                    <p className="text-[11px] font-semibold text-[#93370D]">
                      Note: Refund proposals remain Pending Execution until
                      Phase 6D.2. Order earnings stay frozen and refunds are
                      never falsely marked completed.
                    </p>
                  ) : null}

                  {fb ? (
                    <p
                      role={fb.type === "success" ? "status" : "alert"}
                      className={`flex items-center gap-1.5 font-semibold ${
                        fb.type === "success"
                          ? "text-[#006A6D]"
                          : "text-[#B42318]"
                      }`}
                    >
                      {fb.type === "success" ? (
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      ) : (
                        <AlertCircle className="h-3.5 w-3.5" />
                      )}
                      <span>{fb.text}</span>
                    </p>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
