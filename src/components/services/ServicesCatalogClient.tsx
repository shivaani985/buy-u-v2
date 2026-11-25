"use client";

import { useState } from "react";
import { Briefcase, Search } from "lucide-react";
import { ListingCard } from "@/components/marketplace/ListingCard";
import type { Listing } from "@/types/marketplace";

export interface ServiceCatalogCard extends Listing {
  serviceMode: string;
  sellerId: string;
}

export function ServicesCatalogClient({
  services,
  categories,
  favouritedIds = [],
  canFavourite = false,
}: {
  services: ServiceCatalogCard[];
  categories: Array<{ id: string; name: string }>;
  favouritedIds?: string[];
  canFavourite?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [modeFilter, setModeFilter] = useState("all");
  const favSet = new Set(favouritedIds);

  const filtered = services.filter((s) => {
    if (category !== "all" && s.categoryId !== category) return false;
    if (modeFilter !== "all" && s.serviceMode !== modeFilter) return false;
    if (query.trim()) {
      const q = query.toLowerCase();
      return (
        s.title.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.sellerDisplayName.toLowerCase().includes(q)
      );
    }
    return true;
  });

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

      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-[#E6E3EE] bg-white p-10 text-center">
          <Briefcase className="mx-auto h-8 w-8 text-[#8B869B]" />
          <p className="mt-2 text-sm font-bold text-[#14121A]">
            No student services match your filter yet.
          </p>
          <p className="mt-1 text-xs text-[#6B6779]">
            Verified UMS students can publish campus services via Sell &amp; Publish.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {filtered.map((s) => (
            <ListingCard
              key={s.id}
              listing={s}
              isFavourited={favSet.has(s.id)}
              canFavourite={canFavourite}
            />
          ))}
        </div>
      )}
    </div>
  );
}
