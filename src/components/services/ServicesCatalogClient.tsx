"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Briefcase, CheckCircle2, AlertCircle, Search, Star } from "lucide-react";
import { createServiceRequestAction } from "@/app/marketplace-actions";
import { formatSenToRm } from "@/lib/format";

export interface ServiceCatalogCard {
  id: string;
  title: string;
  description: string;
  categoryId: string;
  categoryName: string;
  priceSen: number;
  serviceMode: string;
  acceptingRequests: boolean;
  limitations: string;
  sellerId: string;
  sellerName: string;
  averageRating: number | null;
  reviewCount: number;
  imageUrl: string | null;
}

export function ServicesCatalogClient({
  services,
  categories,
  canRequest,
  currentUserId,
}: {
  services: ServiceCatalogCard[];
  categories: Array<{ id: string; name: string }>;
  canRequest: boolean;
  currentUserId: string | null;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [modeFilter, setModeFilter] = useState("all");
  const [selected, setSelected] = useState<ServiceCatalogCard | null>(null);
  const [reqMode, setReqMode] = useState<"in_person" | "remote">("in_person");
  const [requirements, setRequirements] = useState("");
  const [preferredDate, setPreferredDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const filtered = services.filter((s) => {
    if (category !== "all" && s.categoryId !== category) return false;
    if (modeFilter !== "all" && s.serviceMode !== modeFilter) return false;
    if (query.trim()) {
      const q = query.toLowerCase();
      return (
        s.title.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.sellerName.toLowerCase().includes(q)
      );
    }
    return true;
  });

  async function submitRequest(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setBusy(true);
    setFeedback(null);
    const res = await createServiceRequestAction({
      listingId: selected.id,
      mode: reqMode,
      requirements,
      preferredDate,
    });
    setBusy(false);
    setFeedback({ ok: res.ok, text: res.message });
    if (res.ok) {
      setSelected(null);
      setRequirements("");
      setPreferredDate("");
      router.refresh();
    }
  }

  return (
    <div className="space-y-5">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-[#E6E3EE] bg-white p-4">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-[#8B869B]" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tutoring, design, printing, tech repair..."
            className="w-full rounded-xl border border-[#DFDCE8] bg-[#FAF9FC] py-2 pl-9 pr-3 text-xs text-[#14121A] outline-none focus:border-[#4E2A84]"
          />
        </div>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          aria-label="Filter by service category"
          className="rounded-xl border border-[#DFDCE8] bg-[#FAF9FC] px-3 py-2 text-xs font-semibold text-[#14121A]"
        >
          <option value="all">All Service Categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          value={modeFilter}
          onChange={(e) => setModeFilter(e.target.value)}
          aria-label="Filter by delivery mode"
          className="rounded-xl border border-[#DFDCE8] bg-[#FAF9FC] px-3 py-2 text-xs font-semibold text-[#14121A]"
        >
          <option value="all">Any Mode</option>
          <option value="in_person">In-Person (Campus)</option>
          <option value="remote">Remote / Online</option>
          <option value="both">Remote &amp; In-Person</option>
        </select>
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

      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-[#E6E3EE] bg-white p-10 text-center">
          <Briefcase className="mx-auto h-8 w-8 text-[#8B869B]" />
          <p className="mt-2 text-sm font-bold text-[#14121A]">No student services match your filter yet.</p>
          <p className="mt-1 text-xs text-[#6B6779]">
            Verified UMS students can publish campus services via Sell &amp; Publish.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((s) => (
            <div key={s.id} className="flex flex-col justify-between rounded-2xl border border-[#E6E3EE] bg-white p-4">
              <div className="space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="rounded-full bg-[#F3EEFA] px-2.5 py-0.5 text-[10.5px] font-bold text-[#4E2A84]">
                    {s.categoryName}
                  </span>
                  <span className="rounded-full bg-[#E6F6F6] px-2.5 py-0.5 text-[10.5px] font-bold capitalize text-[#006A6D]">
                    {s.serviceMode.replace("_", " ")}
                  </span>
                </div>
                <Link href={`/listing/${s.id}`} className="block text-sm font-extrabold text-[#14121A] hover:text-[#4E2A84]">
                  {s.title}
                </Link>
                <p className="line-clamp-3 text-xs text-[#6B6779]">{s.description}</p>
                <div className="flex items-center justify-between text-xs">
                  <Link href={`/store/${s.sellerId}`} className="font-semibold text-[#4E2A84] hover:underline">
                    {s.sellerName}
                  </Link>
                  <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[#4A4656]">
                    <Star className="h-3.5 w-3.5 text-amber-500" />
                    {s.averageRating !== null ? `${s.averageRating.toFixed(1)} (${s.reviewCount})` : "No reviews yet"}
                  </span>
                </div>
              </div>

              <div className="mt-4 flex items-center justify-between border-t border-[#F1EFF6] pt-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase text-[#8B869B]">Starting Rate</p>
                  <p className="text-sm font-extrabold text-[#14121A]">{formatSenToRm(s.priceSen)}</p>
                </div>
                {currentUserId === s.sellerId ? (
                  <Link
                    href="/seller/services"
                    className="rounded-xl border border-[#E6E3EE] px-3 py-1.5 text-xs font-bold text-[#4A4656]"
                  >
                    Manage Requests
                  </Link>
                ) : (
                  <button
                    type="button"
                    disabled={!canRequest || !s.acceptingRequests}
                    onClick={() => {
                      setSelected(s);
                      setReqMode(s.serviceMode === "remote" ? "remote" : "in_person");
                    }}
                    className="rounded-xl bg-[#4E2A84] px-3.5 py-2 text-xs font-bold text-white hover:bg-[#3F216C] disabled:opacity-50"
                  >
                    {!s.acceptingRequests ? "Paused" : canRequest ? "Request Service" : "Sign In to Request"}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Request Service Modal */}
      {selected ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form
            onSubmit={submitRequest}
            className="w-full max-w-lg space-y-4 rounded-2xl border border-[#E6E3EE] bg-white p-5 shadow-xl"
          >
            <div>
              <h2 className="text-base font-extrabold text-[#14121A]">Request Service: {selected.title}</h2>
              <p className="mt-0.5 text-xs text-[#6B6779]">
                Off-platform campus agreement with {selected.sellerName}. No automatic online charge is made.
              </p>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-bold text-[#4A4656]">Delivery Mode</label>
              <select
                value={reqMode}
                onChange={(e) => setReqMode(e.target.value as "in_person" | "remote")}
                className="w-full rounded-xl border border-[#DFDCE8] px-3 py-2 text-xs"
              >
                {selected.serviceMode !== "remote" ? (
                  <option value="in_person">In-Person (Campus)</option>
                ) : null}
                {selected.serviceMode !== "in_person" ? (
                  <option value="remote">Remote / Online</option>
                ) : null}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-bold text-[#4A4656]">
                Preferred Date &amp; Time (optional, MYT)
              </label>
              <input
                type="datetime-local"
                value={preferredDate}
                onChange={(e) => setPreferredDate(e.target.value)}
                className="w-full rounded-xl border border-[#DFDCE8] px-3 py-2 text-xs"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-bold text-[#4A4656]">Service Requirements (15–1,500 chars)</label>
              <textarea
                required
                minLength={15}
                maxLength={1500}
                rows={4}
                value={requirements}
                onChange={(e) => setRequirements(e.target.value)}
                placeholder="Describe scope, deadlines, format, or campus meetup preference..."
                className="w-full rounded-xl border border-[#DFDCE8] px-3 py-2 text-xs"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="rounded-xl border border-[#E6E3EE] px-4 py-2 text-xs font-bold text-[#4A4656]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="rounded-xl bg-[#008285] px-4 py-2 text-xs font-bold text-white hover:bg-[#006B6E] disabled:opacity-50"
              >
                {busy ? "Submitting..." : "Submit Service Request"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
