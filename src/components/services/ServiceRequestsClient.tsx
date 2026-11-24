"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, AlertCircle, Star } from "lucide-react";
import {
  submitVerifiedReviewAction,
  updateServiceRequestAction,
} from "@/app/marketplace-actions";
import { getAllowedServiceActions } from "@/lib/marketplace/phase8";
import { formatShortDate } from "@/lib/format";

export interface ServiceRequestRow {
  id: string;
  requestCode: string;
  listingId: string;
  serviceTitle: string;
  counterpartyName: string;
  mode: string;
  requirements: string;
  preferredDate: string | null;
  proposedArrangement: string | null;
  cancellationReason: string | null;
  status: string;
  hasReview: boolean;
  createdAt: string;
}

export function ServiceRequestsClient({
  requests,
  role,
}: {
  requests: ServiceRequestRow[];
  role: "buyer" | "seller";
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [reviewTarget, setReviewTarget] = useState<ServiceRequestRow | null>(null);
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState("");

  async function runAction(
    id: string,
    action: "accept" | "decline" | "start" | "deliver" | "complete" | "cancel"
  ) {
    setBusyId(`${id}:${action}`);
    setFeedback(null);
    const res = await updateServiceRequestAction({
      requestId: id,
      action,
      note:
        action === "decline" || action === "cancel"
          ? `${role === "seller" ? "Provider" : "Buyer"} updated status to ${action}.`
          : undefined,
    });
    setBusyId(null);
    setFeedback({ ok: res.ok, text: res.message });
    if (res.ok) router.refresh();
  }

  async function handleReview(e: React.FormEvent) {
    e.preventDefault();
    if (!reviewTarget) return;
    setBusyId(`rev:${reviewTarget.id}`);
    const res = await submitVerifiedReviewAction({
      serviceRequestId: reviewTarget.id,
      listingId: reviewTarget.listingId,
      rating,
      comment,
    });
    setBusyId(null);
    setFeedback({ ok: res.ok, text: res.message });
    if (res.ok) {
      setReviewTarget(null);
      setComment("");
      router.refresh();
    }
  }

  return (
    <div className="space-y-4">
      {feedback ? (
        <p
          role={feedback.ok ? "status" : "alert"}
          className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-xs font-semibold ${
            feedback.ok
              ? "border-[#B8E3E4] bg-[#F2FAFA] text-[#006A6D]"
              : "border-[#F9C6C2] bg-[#FEF2F2] text-[#B42318]"
          }`}
        >
          {feedback.ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
          <span>{feedback.text}</span>
        </p>
      ) : null}

      {requests.length === 0 ? (
        <p className="rounded-2xl border border-[#E6E3EE] bg-white p-8 text-center text-xs text-[#6B6779]">
          No service requests yet.
        </p>
      ) : (
        requests.map((r) => {
          const actions = getAllowedServiceActions(r.status, role);
          return (
            <div key={r.id} className="space-y-3 rounded-2xl border border-[#E6E3EE] bg-white p-4 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-extrabold text-[#14121A]">{r.requestCode}</span>
                  <span className="font-bold text-[#4E2A84]">{r.serviceTitle}</span>
                  <span className="text-[#6B6779]">
                    · {role === "buyer" ? "Provider" : "Requester"}: {r.counterpartyName}
                  </span>
                </div>
                <span className="rounded-full bg-[#F3EEFA] px-2.5 py-0.5 text-[11px] font-bold capitalize text-[#4E2A84]">
                  {r.status.replace("_", " ")}
                </span>
              </div>

              <p className="rounded-xl bg-[#FAF9FC] p-3 text-[#4A4656]">{r.requirements}</p>
              <div className="flex flex-wrap gap-4 text-[11px] text-[#6B6779]">
                <span>Mode: <strong className="capitalize text-[#14121A]">{r.mode.replace("_", " ")}</strong></span>
                {r.preferredDate ? <span>Preferred: <strong className="text-[#14121A]">{r.preferredDate}</strong></span> : null}
                <span>Submitted: {formatShortDate(r.createdAt)}</span>
              </div>

              <div className="flex flex-wrap gap-2 pt-1">
                {actions.map((act) => (
                  <button
                    key={act}
                    type="button"
                    disabled={busyId !== null}
                    onClick={() => runAction(r.id, act)}
                    className={`rounded-xl px-3.5 py-1.5 text-xs font-bold capitalize ${
                      act === "accept" || act === "deliver" || act === "complete"
                        ? "bg-[#008285] text-white hover:bg-[#006B6E]"
                        : act === "decline" || act === "cancel"
                          ? "border border-[#F9C6C2] bg-white text-[#B42318]"
                          : "bg-[#4E2A84] text-white"
                    } disabled:opacity-50`}
                  >
                    {act === "complete" ? "Confirm Service Completed" : act}
                  </button>
                ))}
                {role === "buyer" && r.status === "completed" && !r.hasReview ? (
                  <button
                    type="button"
                    onClick={() => setReviewTarget(r)}
                    className="inline-flex items-center gap-1 rounded-xl border border-[#4E2A84] px-3.5 py-1.5 text-xs font-bold text-[#4E2A84]"
                  >
                    <Star className="h-3.5 w-3.5" />
                    <span>Write Verified Review</span>
                  </button>
                ) : null}
              </div>
            </div>
          );
        })
      )}

      {reviewTarget ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form onSubmit={handleReview} className="w-full max-w-md space-y-4 rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="text-sm font-extrabold text-[#14121A]">
              Review Service: {reviewTarget.serviceTitle}
            </h3>
            <div className="space-y-1">
              <label className="text-xs font-bold text-[#4A4656]">Rating (1–5 stars)</label>
              <select
                value={rating}
                onChange={(e) => setRating(Number(e.target.value))}
                className="w-full rounded-xl border border-[#DFDCE8] px-3 py-2 text-xs"
              >
                {[5, 4, 3, 2, 1].map((n) => (
                  <option key={n} value={n}>{n} Stars</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-bold text-[#4A4656]">Your Feedback</label>
              <textarea
                required
                minLength={5}
                maxLength={1000}
                rows={3}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                className="w-full rounded-xl border border-[#DFDCE8] px-3 py-2 text-xs"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setReviewTarget(null)}
                className="rounded-xl border border-[#E6E3EE] px-4 py-2 text-xs font-bold text-[#4A4656]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busyId !== null}
                className="rounded-xl bg-[#4E2A84] px-4 py-2 text-xs font-bold text-white"
              >
                Submit Review
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
