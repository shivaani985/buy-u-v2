"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import type { Category, ListingType } from "@/types/marketplace";

interface MarketplaceFilterBarProps {
  categories: Category[];
  initialQuery: string;
  initialCategory: string;
  initialType: ListingType | "all";
  useDemo?: boolean;
}

const LISTING_TYPES: Array<{ value: ListingType | "all"; label: string }> = [
  { value: "all", label: "All Types" },
  { value: "preloved", label: "Pre-Loved" },
  { value: "business", label: "Student Business" },
  { value: "food", label: "Campus Food" },
  { value: "service", label: "Student Services" },
  { value: "free", label: "Free Items" },
];

export function MarketplaceFilterBar({
  categories,
  initialQuery,
  initialCategory,
  initialType,
  useDemo = false,
}: MarketplaceFilterBarProps) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);
  const [category, setCategory] = useState(initialCategory);
  const [type, setType] = useState<ListingType | "all">(initialType);

  function pushFilters(next: {
    q: string;
    category: string;
    type: ListingType | "all";
  }) {
    const params = new URLSearchParams();
    if (useDemo) params.set("demo", "1");
    if (next.q.trim()) params.set("q", next.q.trim());
    if (next.category) params.set("category", next.category);
    if (next.type !== "all") params.set("type", next.type);
    const qs = params.toString();
    router.push(qs ? `/marketplace?${qs}` : "/marketplace");
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    pushFilters({ q: query, category, type });
  }

  function handleReset() {
    setQuery("");
    setCategory("");
    setType("all");
    router.push(useDemo ? "/marketplace?demo=1" : "/marketplace");
  }

  const hasActiveFilters = Boolean(query.trim() || category || type !== "all");

  return (
    <form
      onSubmit={handleSubmit}
      className="border-2 border-[#14121A] bg-[#F7F7F5] p-4 sm:p-5"
      aria-label="Filter marketplace listings"
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
        {/* Search Input */}
        <div className="md:col-span-5">
          <label
            htmlFor="marketplace-q"
            className="block text-xs font-bold uppercase tracking-wider text-[#14121A]"
          >
            Search
          </label>
          <div className="mt-1 flex border border-[#14121A] bg-white focus-within:border-[#4E2A84]">
            <input
              id="marketplace-q"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Keywords, textbooks, hostel area..."
              className="w-full bg-transparent px-3 py-2 text-sm text-[#14121A] placeholder:text-[#5B5668] focus:outline-none"
            />
          </div>
        </div>

        {/* Category Select */}
        <div className="md:col-span-3">
          <label
            htmlFor="marketplace-category"
            className="block text-xs font-bold uppercase tracking-wider text-[#14121A]"
          >
            Category
          </label>
          <select
            id="marketplace-category"
            value={category}
            onChange={(e) => {
              const nextCat = e.target.value;
              setCategory(nextCat);
              pushFilters({ q: query, category: nextCat, type });
            }}
            className="mt-1 w-full border border-[#14121A] bg-white px-3 py-2 text-sm text-[#14121A] focus:border-[#4E2A84]"
          >
            <option value="">All Categories</option>
            {categories.map((cat) => (
              <option key={cat.id} value={cat.slug}>
                {cat.name}
              </option>
            ))}
          </select>
        </div>

        {/* Listing Type Select */}
        <div className="md:col-span-2">
          <label
            htmlFor="marketplace-type"
            className="block text-xs font-bold uppercase tracking-wider text-[#14121A]"
          >
            Listing Type
          </label>
          <select
            id="marketplace-type"
            value={type}
            onChange={(e) => {
              const nextType = e.target.value as ListingType | "all";
              setType(nextType);
              pushFilters({ q: query, category, type: nextType });
            }}
            className="mt-1 w-full border border-[#14121A] bg-white px-3 py-2 text-sm text-[#14121A] focus:border-[#4E2A84]"
          >
            {LISTING_TYPES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>

        {/* Submit / Reset */}
        <div className="flex items-end gap-2 md:col-span-2">
          <button
            type="submit"
            className="inline-flex flex-1 items-center justify-center gap-1.5 bg-[#4E2A84] px-4 py-2 text-sm font-bold text-white hover:bg-[#381C63] press-feedback"
          >
            <Search className="h-4 w-4" aria-hidden="true" />
            <span>Filter</span>
          </button>

          {hasActiveFilters ? (
            <button
              type="button"
              onClick={handleReset}
              aria-label="Clear all filters"
              className="flex h-[38px] w-[38px] shrink-0 items-center justify-center border border-[#14121A] bg-white text-[#14121A] hover:bg-[#EFEFF2]"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
    </form>
  );
}
