"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Ban, Flag, CheckCircle2, AlertCircle } from "lucide-react";
import { submitReportAction, toggleMemberBlockAction } from "@/app/marketplace-actions";
import { REPORT_REASONS } from "@/lib/marketplace/phase8";

export function PublicStorefrontActions({
  sellerId,
  sellerName,
  initialBlocked,
  canInteract,
}: {
  sellerId: string;
  sellerName: string;
  initialBlocked: boolean;
  canInteract: boolean;
}) {
  const router = useRouter();
  const [blocked, setBlocked] = useState(initialBlocked);
  const [showReport, setShowReport] = useState(false);
  const [reason, setReason] = useState<string>(REPORT_REASONS[0]);
  const [explanation, setExplanation] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  if (!canInteract) return null;

  async function handleBlockToggle() {
    setBusy(true);
    setFeedback(null);
    const res = await toggleMemberBlockAction({ targetUserId: sellerId, block: !blocked });
    setBusy(false);
    setFeedback({ ok: res.ok, text: res.message });
    if (res.ok) {
      setBlocked(!blocked);
      router.refresh();
    }
  }

  async function handleReport(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFeedback(null);
    const res = await submitReportAction({
      targetKind: "user",
      targetId: sellerId,
      reason,
      explanation,
    });
    setBusy(false);
    setFeedback({ ok: res.ok, text: res.message });
    if (res.ok) {
      setShowReport(false);
      setExplanation("");
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setShowReport(true)}
          className="inline-flex items-center gap-1.5 rounded-xl border border-[#E6E3EE] bg-white px-3 py-1.5 text-xs font-bold text-[#4A4656] hover:border-[#B42318] hover:text-[#B42318]"
        >
          <Flag className="h-3.5 w-3.5" />
          <span>Report Seller</span>
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={handleBlockToggle}
          className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-bold ${
            blocked
              ? "border-[#008285] bg-[#F2FAFA] text-[#006A6D]"
              : "border-[#F9C6C2] bg-white text-[#B42318]"
          }`}
        >
          <Ban className="h-3.5 w-3.5" />
          <span>{blocked ? "Unblock Member" : "Block Seller"}</span>
        </button>
      </div>

      {feedback ? (
        <p
          role={feedback.ok ? "status" : "alert"}
          className={`flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold ${
            feedback.ok
              ? "border-[#B8E3E4] bg-[#F2FAFA] text-[#006A6D]"
              : "border-[#F9C6C2] bg-[#FEF2F2] text-[#B42318]"
          }`}
        >
          {feedback.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
          <span>{feedback.text}</span>
        </p>
      ) : null}

      {showReport ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form onSubmit={handleReport} className="w-full max-w-md space-y-3 rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="text-sm font-extrabold text-[#14121A]">Report {sellerName}</h3>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full rounded-xl border border-[#DFDCE8] px-3 py-2 text-xs"
            >
              {REPORT_REASONS.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
            <textarea
              required
              minLength={10}
              maxLength={1500}
              rows={3}
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
              placeholder="Explain the policy concern clearly (min 10 chars)..."
              className="w-full rounded-xl border border-[#DFDCE8] px-3 py-2 text-xs"
            />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowReport(false)} className="rounded-xl border border-[#E6E3EE] px-4 py-1.5 text-xs font-bold">
                Cancel
              </button>
              <button type="submit" disabled={busy} className="rounded-xl bg-[#B42318] px-4 py-1.5 text-xs font-bold text-white">
                Submit Report
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
