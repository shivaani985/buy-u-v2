import { Check, ExternalLink, ShieldAlert } from "lucide-react";
import type { OrderDisputeSummaryView } from "@/lib/disputes/data";
import {
  getDisputeResolutionSummary,
  getDisputeStatusBadge,
} from "@/lib/disputes/validation";

interface DisputeDetailCardProps {
  dispute: OrderDisputeSummaryView;
}

function formatTs(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-MY", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kuala_Lumpur",
  }).format(d);
}

export function DisputeDetailCard({ dispute }: DisputeDetailCardProps) {
  const badge = getDisputeStatusBadge(dispute.status);
  const resolutionSummary = getDisputeResolutionSummary({
    resolutionType: dispute.resolutionType,
    refundAmountSen: dispute.refundAmountSen,
    refundExecutionStatus: dispute.refundExecutionStatus,
  });

  const steps = [
    { label: "Opened", done: true, ts: formatTs(dispute.createdAt) },
    {
      label: "Under Review",
      done: dispute.status === "under_review" || dispute.status === "resolved",
      ts: formatTs(dispute.underReviewAt),
    },
    {
      label: "Resolved",
      done: dispute.status === "resolved",
      ts: formatTs(dispute.resolvedAt),
    },
  ];

  return (
    <div className="border-t border-[#F4D5D3] bg-[#FFFDFD] px-5 py-4 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex items-center gap-1.5 font-extrabold text-[#14121A]">
          <ShieldAlert className="h-4 w-4 text-[#B42318]" aria-hidden="true" />
          <span>Dispute {dispute.disputeCode}</span>
          <span className="font-semibold text-[#6B6779]">
            &middot; {dispute.reason}
          </span>
        </div>
        <span
          className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-bold ${badge.toneClass}`}
        >
          {badge.label}
        </span>
      </div>

      {/* 3-step dispute timeline */}
      <ol className="mt-3 grid grid-cols-3 gap-2 rounded-xl border border-[#ECEAF3] bg-[#FAF9FC] p-2.5">
        {steps.map((s, idx) => (
          <li key={s.label} className="flex items-start gap-1.5">
            <span
              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold ${
                s.done
                  ? "bg-[#4E2A84] text-white"
                  : "border border-[#D7D2E5] bg-white text-[#8B869B]"
              }`}
              aria-hidden="true"
            >
              {s.done ? <Check className="h-2.5 w-2.5" /> : idx + 1}
            </span>
            <div className="min-w-0">
              <p
                className={`text-[11px] font-bold ${
                  s.done ? "text-[#14121A]" : "text-[#8B869B]"
                }`}
              >
                {s.label}
              </p>
              {s.ts ? (
                <p className="truncate text-[10px] text-[#6B6779]">{s.ts}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>

      {/* Buyer Complaint */}
      {dispute.description ? (
        <div className="mt-3 rounded-xl border border-[#ECEAF3] bg-white p-3">
          <p className="text-[11px] font-extrabold uppercase tracking-wide text-[#6B6779]">
            Buyer Complaint
          </p>
          <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-[#14121A]">
            {dispute.description}
          </p>
          {dispute.buyerEvidence.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {dispute.buyerEvidence.map((ev, i) => (
                <a
                  key={ev.path}
                  href={ev.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-lg border border-[#E6E3EE] bg-[#FAF9FC] px-2.5 py-1 text-[11px] font-semibold text-[#4E2A84] hover:border-[#4E2A84]"
                >
                  <span>Photo {i + 1}</span>
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Seller Response */}
      {dispute.sellerResponse ? (
        <div className="mt-2.5 rounded-xl border border-[#D6EEEE] bg-[#F4FAFA] p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-extrabold uppercase tracking-wide text-[#006A6D]">
              Seller Response
            </p>
            {dispute.sellerRespondedAt ? (
              <span className="text-[10.5px] text-[#6B6779]">
                {formatTs(dispute.sellerRespondedAt)}
              </span>
            ) : null}
          </div>
          <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-[#14121A]">
            {dispute.sellerResponse}
          </p>
          {dispute.sellerEvidence.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {dispute.sellerEvidence.map((ev, i) => (
                <a
                  key={ev.path}
                  href={ev.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-lg border border-[#B8E3E4] bg-white px-2.5 py-1 text-[11px] font-semibold text-[#006A6D] hover:border-[#008285]"
                >
                  <span>Seller Photo {i + 1}</span>
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Admin Resolution */}
      {resolutionSummary ? (
        <div className="mt-2.5 rounded-xl border border-[#DCD0F0] bg-[#F7F3FD] p-3 text-[#3E2468]">
          <p className="text-[11px] font-extrabold uppercase tracking-wide text-[#4E2A84]">
            Admin Resolution
          </p>
          <p className="mt-1 text-xs font-bold">{resolutionSummary}</p>
        </div>
      ) : null}
    </div>
  );
}
