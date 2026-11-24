"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Gift, MapPin, CheckCircle2, AlertCircle, Search } from "lucide-react";
import {
  createFreeClaimAction,
  saveOrPublishFreeNoticeAction,
  updateFreeClaimAction,
} from "@/app/marketplace-actions";
import {
  computeFreeAvailableQuantity,
  getAllowedFreeClaimActions,
  type CommunityImpactSummary,
} from "@/lib/marketplace/phase8";

export interface FreeNoticeCard {
  id: string;
  title: string;
  description: string;
  condition: string;
  quantity: number;
  reservedQuantity: number;
  spotId: string;
  spotName: string;
  categoryId: string | null;
  collectionInstructions: string | null;
  status: string;
  contributorId: string;
  donorName: string;
}

export interface FreeClaimView {
  id: string;
  claimCode: string;
  noticeTitle: string;
  donorId: string;
  recipientId: string;
  counterpartyName: string;
  quantity: number;
  note: string | null;
  status: string;
}

export function FreeItemsClient({
  notices,
  drafts,
  claims,
  spots,
  categories,
  impact,
  canPublish,
  canClaim,
  currentUserId,
}: {
  notices: FreeNoticeCard[];
  drafts: FreeNoticeCard[];
  claims: FreeClaimView[];
  spots: Array<{ id: string; name: string; description: string | null; operatingInfo: string | null; safetyNote: string | null }>;
  categories: Array<{ id: string; name: string }>;
  impact: CommunityImpactSummary;
  canPublish: boolean;
  canClaim: boolean;
  currentUserId: string | null;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<"browse" | "publish" | "claims" | "spots">("browse");
  const [query, setQuery] = useState("");
  const [spotFilter, setSpotFilter] = useState("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  // Publish / Draft form state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [condition, setCondition] = useState("Good / Usable");
  const [quantity, setQuantity] = useState(1);
  const [spotId, setSpotId] = useState(spots[0]?.id ?? "blok-alpha");
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? "");
  const [instructions, setInstructions] = useState("");

  const filtered = notices.filter((n) => {
    if (spotFilter !== "all" && n.spotId !== spotFilter) return false;
    if (query.trim()) {
      const q = query.toLowerCase();
      return n.title.toLowerCase().includes(q) || n.description.toLowerCase().includes(q);
    }
    return true;
  });

  function loadDraft(d: FreeNoticeCard) {
    setEditingId(d.id);
    setTitle(d.title);
    setDescription(d.description);
    setCondition(d.condition || "Good / Usable");
    setQuantity(Math.max(1, d.quantity));
    setSpotId(d.spotId || spots[0]?.id || "blok-alpha");
    setCategoryId(d.categoryId || "");
    setInstructions(d.collectionInstructions || "");
    setTab("publish");
  }

  async function submitNotice(mode: "draft" | "published") {
    setBusy(`notice:${mode}`);
    setFeedback(null);
    const res = await saveOrPublishFreeNoticeAction({
      id: editingId,
      title,
      description,
      condition,
      quantity,
      spotId,
      categoryId: categoryId || null,
      collectionInstructions: instructions,
      mode,
    });
    setBusy(null);
    setFeedback({ ok: res.ok, text: res.message });
    if (res.ok) {
      setEditingId(null);
      setTitle("");
      setDescription("");
      setInstructions("");
      setQuantity(1);
      if (mode === "published") setTab("browse");
      router.refresh();
    }
  }

  async function handleClaim(noticeId: string) {
    setBusy(`claim:${noticeId}`);
    setFeedback(null);
    const res = await createFreeClaimAction({ noticeId, quantity: 1 });
    setBusy(null);
    setFeedback({ ok: res.ok, text: res.message });
    if (res.ok) router.refresh();
  }

  async function handleClaimUpdate(
    claimId: string,
    action: "accept" | "decline" | "handover" | "collect" | "cancel"
  ) {
    setBusy(`upd:${claimId}:${action}`);
    setFeedback(null);
    const res = await updateFreeClaimAction({ claimId, action });
    setBusy(null);
    setFeedback({ ok: res.ok, text: res.message });
    if (res.ok) router.refresh();
  }

  return (
    <div className="space-y-5">
      {/* Community Impact Strip (Actual completed donations only) */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[
          { label: "Published Free Items", val: impact.publishedFreeItems },
          { label: "Completed Donations", val: impact.completedDonations },
          { label: "Units Donated", val: impact.totalUnitsDonated },
          { label: "Active Donors", val: impact.activeDonors },
          { label: "Unique Recipients", val: impact.uniqueRecipients },
        ].map((m) => (
          <div key={m.label} className="rounded-2xl border border-[#E6E3EE] bg-white px-4 py-3">
            <p className="text-[11px] font-bold text-[#6B6779]">{m.label}</p>
            <p className="mt-1 text-lg font-extrabold text-[#4E2A84]">{m.val}</p>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2">
        {[
          { k: "browse" as const, l: `Browse Free Items (${notices.length})` },
          ...(canPublish ? [{ k: "publish" as const, l: `Donate / Drafts (${drafts.length})` }] : []),
          ...(currentUserId ? [{ k: "claims" as const, l: `My Claims & Donations (${claims.length})` }] : []),
          { k: "spots" as const, l: `Donation Spots (${spots.length})` },
        ].map((t) => (
          <button
            key={t.k}
            type="button"
            onClick={() => setTab(t.k)}
            className={`rounded-xl px-3.5 py-2 text-xs font-bold ${
              tab === t.k
                ? "bg-[#4E2A84] text-white"
                : "border border-[#E6E3EE] bg-white text-[#4A4656] hover:border-[#4E2A84]"
            }`}
          >
            {t.l}
          </button>
        ))}
      </div>

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

      {/* TAB: BROWSE */}
      {tab === "browse" ? (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-3 rounded-2xl border border-[#E6E3EE] bg-white p-4">
            <div className="relative min-w-[200px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-[#8B869B]" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search textbooks, stationery, room items..."
                className="w-full rounded-xl border border-[#DFDCE8] bg-[#FAF9FC] py-2 pl-9 pr-3 text-xs"
              />
            </div>
            <select
              value={spotFilter}
              onChange={(e) => setSpotFilter(e.target.value)}
              className="rounded-xl border border-[#DFDCE8] bg-[#FAF9FC] px-3 py-2 text-xs font-semibold"
            >
              <option value="all">All Donation Spots</option>
              {spots.map((sp) => (
                <option key={sp.id} value={sp.id}>{sp.name}</option>
              ))}
            </select>
          </div>

          {filtered.length === 0 ? (
            <div className="rounded-2xl border border-[#E6E3EE] bg-white p-10 text-center">
              <Gift className="mx-auto h-8 w-8 text-[#8B869B]" />
              <p className="mt-2 text-sm font-bold text-[#14121A]">No free items available right now.</p>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((n) => {
                const avail = computeFreeAvailableQuantity(n.quantity, n.reservedQuantity);
                return (
                  <div key={n.id} className="flex flex-col justify-between rounded-2xl border border-[#E6E3EE] bg-white p-4">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="rounded-full bg-[#E6F6F6] px-2.5 py-0.5 text-[10.5px] font-extrabold text-[#006A6D]">
                          FREE · RM 0
                        </span>
                        <span className="text-[11px] font-semibold text-[#6B6779]">
                          {avail} available
                        </span>
                      </div>
                      <h3 className="text-sm font-extrabold text-[#14121A]">{n.title}</h3>
                      <p className="line-clamp-3 text-xs text-[#6B6779]">{n.description}</p>
                      <p className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#4E2A84]">
                        <MapPin className="h-3.5 w-3.5" />
                        <span>{n.spotName} · {n.condition}</span>
                      </p>
                      <p className="text-[11px] text-[#6B6779]">Donor: {n.donorName}</p>
                    </div>
                    <div className="mt-4 border-t border-[#F1EFF6] pt-3">
                      {currentUserId === n.contributorId ? (
                        <span className="text-xs font-bold text-[#6B6779]">Your donation listing</span>
                      ) : (
                        <button
                          type="button"
                          disabled={!canClaim || avail <= 0 || busy !== null}
                          onClick={() => handleClaim(n.id)}
                          className="w-full rounded-xl bg-[#008285] px-3.5 py-2 text-xs font-bold text-white hover:bg-[#006B6E] disabled:opacity-50"
                        >
                          {avail <= 0 ? "Fully Reserved" : canClaim ? "Claim Free Item" : "Sign In to Claim"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}

      {/* TAB: PUBLISH & DRAFT RECOVERY (Student-only) */}
      {tab === "publish" && canPublish ? (
        <div className="grid gap-5 lg:grid-cols-3">
          <div className="space-y-3 rounded-2xl border border-[#E6E3EE] bg-white p-5 lg:col-span-2">
            <h2 className="text-sm font-extrabold text-[#14121A]">
              {editingId ? "Resume Saved Draft" : "Publish Free Item (Community Donation)"}
            </h2>
            <p className="text-xs text-[#6B6779]">
              No payment, FPX fee, or commission applies to community donations.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1 sm:col-span-2">
                <label className="text-xs font-bold text-[#4A4656]">Item Title</label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Calculus 2 Textbook + Lab Manual"
                  className="w-full rounded-xl border border-[#DFDCE8] px-3 py-2 text-xs"
                />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <label className="text-xs font-bold text-[#4A4656]">Description</label>
                <textarea
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Describe condition, included items, and pickup notes..."
                  className="w-full rounded-xl border border-[#DFDCE8] px-3 py-2 text-xs"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold text-[#4A4656]">Condition</label>
                <select
                  value={condition}
                  onChange={(e) => setCondition(e.target.value)}
                  className="w-full rounded-xl border border-[#DFDCE8] px-3 py-2 text-xs"
                >
                  <option value="Like New">Like New</option>
                  <option value="Good / Usable">Good / Usable</option>
                  <option value="Well Used">Well Used</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold text-[#4A4656]">Quantity Available</label>
                <input
                  type="number"
                  min={1}
                  max={99}
                  value={quantity}
                  onChange={(e) => setQuantity(Number(e.target.value))}
                  className="w-full rounded-xl border border-[#DFDCE8] px-3 py-2 text-xs"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold text-[#4A4656]">Approved Donation Spot</label>
                <select
                  value={spotId}
                  onChange={(e) => setSpotId(e.target.value)}
                  className="w-full rounded-xl border border-[#DFDCE8] px-3 py-2 text-xs"
                >
                  {spots.map((sp) => (
                    <option key={sp.id} value={sp.id}>{sp.name}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold text-[#4A4656]">Category</label>
                <select
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                  className="w-full rounded-xl border border-[#DFDCE8] px-3 py-2 text-xs"
                >
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1 sm:col-span-2">
                <label className="text-xs font-bold text-[#4A4656]">Collection Instructions</label>
                <input
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder="e.g. Meet at Blok Alpha lobby 5–6 PM"
                  className="w-full rounded-xl border border-[#DFDCE8] px-3 py-2 text-xs"
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2 pt-2">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => submitNotice("draft")}
                className="rounded-xl border border-[#4E2A84] px-4 py-2 text-xs font-bold text-[#4E2A84]"
              >
                Save Draft
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => submitNotice("published")}
                className="rounded-xl bg-[#4E2A84] px-4 py-2 text-xs font-bold text-white"
              >
                Publish Free Item
              </button>
            </div>
          </div>

          {/* Saved Drafts Panel (Genuine Persistent Draft Recovery) */}
          <div className="space-y-3 rounded-2xl border border-[#E6E3EE] bg-white p-5">
            <h3 className="text-sm font-extrabold text-[#14121A]">Saved Drafts ({drafts.length})</h3>
            {drafts.length === 0 ? (
              <p className="text-xs text-[#6B6779]">No saved drafts yet.</p>
            ) : (
              drafts.map((d) => (
                <div key={d.id} className="rounded-xl border border-[#ECEAF3] bg-[#FAF9FC] p-3 text-xs">
                  <p className="font-bold text-[#14121A]">{d.title}</p>
                  <p className="mt-0.5 text-[11px] text-[#6B6779]">{d.spotName} · Qty {d.quantity}</p>
                  <button
                    type="button"
                    onClick={() => loadDraft(d)}
                    className="mt-2 rounded-lg bg-[#008285] px-3 py-1 text-[11px] font-bold text-white"
                  >
                    Resume Draft
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}

      {/* TAB: CLAIMS & DONATION WORKFLOW */}
      {tab === "claims" ? (
        <div className="space-y-3">
          {claims.length === 0 ? (
            <p className="rounded-2xl border border-[#E6E3EE] bg-white p-8 text-center text-xs text-[#6B6779]">
              No active or historical free-item claims yet.
            </p>
          ) : (
            claims.map((c) => {
              const role = c.donorId === currentUserId ? "donor" : "recipient";
              const actions = getAllowedFreeClaimActions(c.status, role);
              return (
                <div key={c.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#E6E3EE] bg-white p-4 text-xs">
                  <div>
                    <p className="font-mono font-extrabold text-[#14121A]">
                      {c.claimCode} · <span className="font-sans text-[#4E2A84]">{c.noticeTitle}</span>
                    </p>
                    <p className="mt-0.5 text-[11px] text-[#6B6779]">
                      Role: <strong className="capitalize">{role}</strong> · {role === "donor" ? "Recipient" : "Donor"}: {c.counterpartyName} · Qty {c.quantity}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-[#F3EEFA] px-2.5 py-0.5 text-[11px] font-bold capitalize text-[#4E2A84]">
                      {c.status.replace("_", " ")}
                    </span>
                    {actions.map((act) => (
                      <button
                        key={act}
                        type="button"
                        disabled={busy !== null}
                        onClick={() => handleClaimUpdate(c.id, act)}
                        className={`rounded-xl px-3 py-1.5 text-xs font-bold capitalize ${
                          act === "accept" || act === "handover" || act === "collect"
                            ? "bg-[#008285] text-white"
                            : "border border-[#F9C6C2] text-[#B42318]"
                        }`}
                      >
                        {act === "collect" ? "Confirm Collected" : act}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>
      ) : null}

      {/* TAB: DONATION SPOTS */}
      {tab === "spots" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {spots.map((sp) => (
            <div key={sp.id} className="rounded-2xl border border-[#E6E3EE] bg-white p-5 text-xs">
              <h3 className="inline-flex items-center gap-1.5 text-sm font-extrabold text-[#4E2A84]">
                <MapPin className="h-4 w-4 text-[#008285]" />
                <span>{sp.name}</span>
              </h3>
              <p className="mt-2 text-[#4A4656]">
                {sp.description || "Approved UMSKAL campus community donation handover spot."}
              </p>
              <p className="mt-2 text-[11px] text-[#6B6779]">
                <strong>Operating Info:</strong> {sp.operatingInfo || "Daylight campus hours (8:00 AM – 6:00 PM MYT)."}
              </p>
              <p className="mt-1 text-[11px] text-[#6B6779]">
                <strong>Safety Reminder:</strong> {sp.safetyNote || "Meet in open public campus areas and confirm collection in-app."}
              </p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
