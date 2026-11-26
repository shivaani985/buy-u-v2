"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, AlertCircle, Ban } from "lucide-react";
import {
  completeMatricNumberAction,
  toggleMemberBlockAction,
  updateAccountProfileAction,
} from "@/app/marketplace-actions";

export function AccountSettingsClient({
  initial,
  blockedUsers,
  canSetMatric,
}: {
  initial: {
    displayName: string;
    bio: string;
    faculty: string;
    phone: string;
    prefs: { inquiries: boolean; reviews: boolean; community: boolean };
  };
  canSetMatric: boolean;
  blockedUsers: Array<{ id: string; displayName: string; createdAt: string }>;
}) {
  const router = useRouter();
  const [matric, setMatric] = useState("");
  const [displayName, setDisplayName] = useState(initial.displayName);
  const [bio, setBio] = useState(initial.bio);
  const [faculty, setFaculty] = useState(initial.faculty);
  const [phone, setPhone] = useState(initial.phone);
  const [prefs, setPrefs] = useState(initial.prefs);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFeedback(null);
    let res = await updateAccountProfileAction({
      displayName,
      bio,
      faculty,
      phone,
      notificationPrefs: prefs,
    });
    if (res.ok && canSetMatric && matric.trim()) res = await completeMatricNumberAction(matric);
    setBusy(false);
    setFeedback({ ok: res.ok, text: res.message });
    if (res.ok) router.refresh();
  }

  async function unblock(targetUserId: string) {
    setBusy(true);
    const res = await toggleMemberBlockAction({ targetUserId, block: false });
    setBusy(false);
    setFeedback({ ok: res.ok, text: res.message });
    if (res.ok) router.refresh();
  }

  return (
    <div className="mt-8 grid gap-6 lg:grid-cols-2">
      <form id="student-profile" onSubmit={saveProfile} className="space-y-4 rounded-2xl border border-[#E6E3EE] bg-white p-5">
        <h2 className="text-base font-extrabold text-[#14121A]">Profile &amp; Notification Settings</h2>
        <p className="text-xs text-[#6B6779]">
          Verified UMS email and university role are backend-managed and cannot be altered here.
        </p>
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

        <div className="space-y-1">
          <label className="text-xs font-bold text-[#4A4656]">Display Name</label>
          <input
            required
            minLength={2}
            maxLength={60}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="w-full rounded-xl border border-[#DFDCE8] px-3 py-2 text-xs"
          />
        </div>
        {canSetMatric && <label className="block space-y-1 text-xs font-bold text-[#4A4656]">
          <span>Matric Number</span>
          <input value={matric} onChange={(event) => setMatric(event.target.value)}
            minLength={4} maxLength={20} autoComplete="off"
            className="w-full rounded-xl border border-[#DFDCE8] px-3 py-2 text-xs" />
          <span className="block font-normal">Required to post Free Items. Only you and authorized administrators can access it.</span>
        </label>}
        <div className="space-y-1">
          <label className="text-xs font-bold text-[#4A4656]">Faculty / School (UMSKAL)</label>
          <input
            value={faculty}
            onChange={(e) => setFaculty(e.target.value)}
            placeholder="e.g. FCI, Labuan Faculty of International Finance"
            className="w-full rounded-xl border border-[#DFDCE8] px-3 py-2 text-xs"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-bold text-[#4A4656]">Campus Bio</label>
          <textarea
            rows={2}
            maxLength={400}
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            className="w-full rounded-xl border border-[#DFDCE8] px-3 py-2 text-xs"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-bold text-[#4A4656]">Optional Phone / WhatsApp Preference</label>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="w-full rounded-xl border border-[#DFDCE8] px-3 py-2 text-xs"
          />
        </div>

        <fieldset className="space-y-2 rounded-xl bg-[#FAF9FC] p-3 text-xs">
          <legend className="font-bold text-[#4A4656]">Non-Essential Notification Preferences</legend>
          <p className="text-[11px] text-[#6B6779]">
            Critical order, payment, dispute, refund, withdrawal, and moderation alerts always remain active.
          </p>
          {(
            [
              ["inquiries", "New messages & service inquiries"],
              ["reviews", "Verified reviews & seller replies"],
              ["community", "Community free-item & donation updates"],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="flex items-center gap-2 font-semibold text-[#14121A]">
              <input
                type="checkbox"
                checked={prefs[k]}
                onChange={(e) => setPrefs((p) => ({ ...p, [k]: e.target.checked }))}
              />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>

        <button
          type="submit"
          disabled={busy}
          className="rounded-xl bg-[#4E2A84] px-4 py-2 text-xs font-bold text-white hover:bg-[#3F216C] disabled:opacity-50"
        >
          {busy ? "Saving..." : "Save Account Settings"}
        </button>
      </form>

      {/* Blocked Members List */}
      <div className="space-y-3 rounded-2xl border border-[#E6E3EE] bg-white p-5">
        <h2 className="inline-flex items-center gap-1.5 text-base font-extrabold text-[#14121A]">
          <Ban className="h-4 w-4 text-[#B42318]" />
          <span>Blocked Members ({blockedUsers.length})</span>
        </h2>
        <p className="text-xs text-[#6B6779]">
          Your block list is private. Blocking prevents new messages, offers, service requests, and free-item claims while preserving existing orders and disputes.
        </p>
        {blockedUsers.length === 0 ? (
          <p className="rounded-xl bg-[#FAF9FC] p-4 text-xs text-[#6B6779]">You have not blocked any members.</p>
        ) : (
          blockedUsers.map((b) => (
            <div key={b.id} className="flex items-center justify-between rounded-xl border border-[#ECEAF3] p-3 text-xs">
              <span className="font-bold text-[#14121A]">{b.displayName}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => unblock(b.id)}
                className="rounded-lg border border-[#008285] px-3 py-1 text-xs font-bold text-[#008285]"
              >
                Unblock
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
