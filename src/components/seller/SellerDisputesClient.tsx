"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  MapPin,
  ShieldAlert,
  User,
} from "lucide-react";
import { submitSellerDisputeResponseAction } from "@/app/disputes/actions";
import { DisputeDetailCard } from "@/components/disputes/DisputeDetailCard";
import {
  DisputeEvidenceUploader,
  type UploadedEvidenceItem,
} from "@/components/disputes/DisputeEvidenceUploader";
import type { SellerDisputeItemView } from "@/lib/disputes/data";
import type { DisputeStatus } from "@/lib/disputes/validation";
import { formatSenToRm, formatShortDate } from "@/lib/format";

interface SellerDisputesClientProps {
  disputes: SellerDisputeItemView[];
}

type FilterKey = "all" | DisputeStatus;

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: "all", label: "All Disputes" },
  { key: "open", label: "Open" },
  { key: "under_review", label: "Under Review" },
  { key: "resolved", label: "Resolved" },
];

export function SellerDisputesClient({ disputes }: SellerDisputesClientProps) {
  const router = useRouter();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [draftById, setDraftById] = useState<Record<string, string>>({});
  const [evidenceById, setEvidenceById] = useState<
    Record<string, UploadedEvidenceItem[]>
  >({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedbackById, setFeedbackById] = useState<
    Record<string, { type: "success" | "error"; text: string }>
  >({});

  const filtered = useMemo(
    () =>
      filter === "all"
        ? disputes
        : disputes.filter((d) => d.status === filter),
    [disputes, filter]
  );

  async function handleSubmitResponse(dispute: SellerDisputeItemView) {
    const responseText = (
      draftById[dispute.id] ??
      dispute.sellerResponse ??
      ""
    ).trim();
    const evidence = evidenceById[dispute.id] ?? [];

    setBusyId(dispute.id);
    setFeedbackById((prev) => {
      const next = { ...prev };
      delete next[dispute.id];
      return next;
    });

    try {
      const res = await submitSellerDisputeResponseAction({
        disputeId: dispute.id,
        orderId: dispute.orderId,
        response: responseText,
        evidencePaths: evidence.map((e) => e.path),
      });
      setFeedbackById((prev) => ({
        ...prev,
        [dispute.id]: {
          type: res.ok ? "success" : "error",
          text: res.message,
        },
      }));
      if (res.ok) {
        router.refresh();
      }
    } catch {
      setFeedbackById((prev) => ({
        ...prev,
        [dispute.id]: {
          type: "error",
          text: "Network error while submitting response.",
        },
      }));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-5">
      <div
        role="tablist"
        aria-label="Filter disputes by status"
        className="flex flex-wrap gap-1.5 rounded-2xl border border-[#E6E3EE] bg-white p-3.5"
      >
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
                  : "border border-[#E6E3EE] bg-[#FAF9FC] text-[#4A4656] hover:border-[#4E2A84]/50 hover:text-[#4E2A84]"
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

      {filtered.length === 0 ? (
        <section className="rounded-2xl border border-[#E6E3EE] bg-white px-6 py-12 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-[#E6E3EE] bg-[#FAF9FC] text-[#4E2A84]">
            <ShieldAlert className="h-5 w-5" aria-hidden="true" />
          </div>
          <h2 className="mt-3 text-base font-bold text-[#14121A]">
            No disputes found
          </h2>
          <p className="mt-1 text-xs text-[#6B6779]">
            Buyer disputes on your orders will appear here with frozen earnings
            tracking until resolved by Buy-U admin.
          </p>
        </section>
      ) : (
        <div className="space-y-4">
          {filtered.map((dispute) => {
            const canRespond =
              dispute.status === "open" || dispute.status === "under_review";
            const draft = draftById[dispute.id] ?? dispute.sellerResponse ?? "";
            const uploaded = evidenceById[dispute.id] ?? [];
            const isBusy = busyId === dispute.id;
            const fb = feedbackById[dispute.id];

            return (
              <section
                key={dispute.id}
                className="overflow-hidden rounded-2xl border border-[#E6E3EE] bg-white"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#ECEAF3] px-5 py-3.5 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold text-[#14121A]">
                      #{dispute.orderCode}
                    </span>
                    <span className="text-[#C7C3D4]">&middot;</span>
                    <span className="inline-flex items-center gap-1 font-semibold text-[#4A4656]">
                      <User className="h-3.5 w-3.5 text-[#4E2A84]" />
                      <span>{dispute.buyerName}</span>
                    </span>
                    <span className="text-[#C7C3D4]">&middot;</span>
                    <span className="text-[#6B6779]">
                      {formatShortDate(dispute.createdAt)}
                    </span>
                  </div>
                  <span className="font-extrabold text-[#B42318]">
                    Net {formatSenToRm(dispute.sellerNetSen)} (Frozen)
                  </span>
                </div>

                {/* Order items */}
                <ul className="divide-y divide-[#F1EFF6]">
                  {dispute.items.map((item) => (
                    <li
                      key={item.id}
                      className="flex items-center gap-3 px-5 py-3 text-xs"
                    >
                      <div className="h-11 w-11 shrink-0 overflow-hidden rounded-lg border border-[#E6E3EE] bg-[#FAF9FC]">
                        {item.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={item.imageUrl}
                            alt={item.title}
                            className="h-full w-full object-cover"
                          />
                        ) : null}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-bold text-[#14121A]">
                          {item.title}
                        </p>
                        <p className="text-[#6B6779]">
                          Qty {item.quantity} &times;{" "}
                          {formatSenToRm(item.unitSen)}
                        </p>
                      </div>
                      <span className="inline-flex items-center gap-1 text-[#6B6779]">
                        <MapPin className="h-3.5 w-3.5 text-[#4E2A84]" />
                        <span>{dispute.collectionAreaName}</span>
                      </span>
                    </li>
                  ))}
                </ul>

                <DisputeDetailCard dispute={dispute} />

                {/* Seller Explanation Form (only while open or under_review) */}
                {canRespond ? (
                  <div className="space-y-3 border-t border-[#ECEAF3] bg-[#FAF9FC] px-5 py-4">
                    <div>
                      <label
                        htmlFor={`seller-resp-${dispute.id}`}
                        className="block text-xs font-extrabold text-[#14121A]"
                      >
                        {dispute.sellerResponse
                          ? "Update Your Explanation & Evidence"
                          : "Submit Your Explanation & Supporting Evidence"}
                      </label>
                      <p className="mt-0.5 text-[11px] text-[#6B6779]">
                        Only Buy-U admins can resolve disputes or release frozen
                        earnings. Provide clear facts and photos for review.
                      </p>
                      <textarea
                        id={`seller-resp-${dispute.id}`}
                        rows={3}
                        maxLength={2000}
                        value={draft}
                        onChange={(e) =>
                          setDraftById((prev) => ({
                            ...prev,
                            [dispute.id]: e.target.value,
                          }))
                        }
                        placeholder="Explain what happened during handover or item condition (10-2,000 characters)..."
                        className="mt-2 w-full rounded-xl border border-[#E6E3EE] bg-white px-3.5 py-2.5 text-xs text-[#14121A] focus:border-[#4E2A84] focus:outline-none"
                      />
                    </div>

                    <DisputeEvidenceUploader
                      orderId={dispute.orderId}
                      items={uploaded}
                      onChange={(next) =>
                        setEvidenceById((prev) => ({
                          ...prev,
                          [dispute.id]: next,
                        }))
                      }
                      disabled={isBusy}
                    />

                    {fb ? (
                      <p
                        role={fb.type === "success" ? "status" : "alert"}
                        className={`flex items-center gap-1.5 text-xs font-semibold ${
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

                    <div className="flex justify-end">
                      <button
                        type="button"
                        disabled={isBusy || draft.trim().length < 10}
                        onClick={() => handleSubmitResponse(dispute)}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-[#4E2A84] px-4 py-2 text-xs font-bold text-white transition hover:bg-[#3F216B] disabled:opacity-50"
                      >
                        {isBusy ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <CheckCircle2 className="h-3.5 w-3.5" />
                        )}
                        <span>Submit Seller Response</span>
                      </button>
                    </div>
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
