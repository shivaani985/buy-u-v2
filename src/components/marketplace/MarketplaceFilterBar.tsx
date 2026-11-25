"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowUpDown,
  Check,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import type {
  Category,
  ListingType,
  MarketplaceSort,
} from "@/types/marketplace";

interface MarketplaceFilterBarProps {
  categories: Category[];
  initialQuery: string;
  initialCategory: string;
  initialType: ListingType | "all";
  initialMinPrice: string;
  initialMaxPrice: string;
  initialCondition: string;
  initialInStock: boolean;
  initialSort: MarketplaceSort;
  useDemo?: boolean;
}

const LISTING_TYPES: Array<{ value: ListingType | "all"; label: string }> = [
  { value: "all", label: "All Types" },
  { value: "preloved", label: "Pre-Loved" },
  { value: "business", label: "Student Business" },
  { value: "food", label: "Campus Food" },
  { value: "service", label: "Services" },
  { value: "free", label: "Free" },
];

const CONDITIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "All Conditions" },
  { value: "new", label: "New / Unused" },
  { value: "like new", label: "Like New" },
  { value: "good", label: "Good" },
  { value: "fair", label: "Fair" },
];

const SORT_OPTIONS: Array<{ value: MarketplaceSort; label: string }> = [
  { value: "latest", label: "Latest Listings" },
  { value: "price_asc", label: "Price: Lowest to Highest" },
  { value: "price_desc", label: "Price: Highest to Lowest" },
];

const PRICE_PRESETS: Array<{ label: string; min: string; max: string }> = [
  { label: "Free", min: "0", max: "0" },
  { label: "Under RM 15", min: "", max: "15" },
  { label: "RM 15 – 50", min: "15", max: "50" },
  { label: "RM 50+", min: "50", max: "" },
];

interface FilterState {
  q: string;
  category: string;
  type: ListingType | "all";
  minPrice: string;
  maxPrice: string;
  condition: string;
  inStock: boolean;
  sort: MarketplaceSort;
}

export function MarketplaceFilterBar({
  categories,
  initialQuery,
  initialCategory,
  initialType,
  initialMinPrice,
  initialMaxPrice,
  initialCondition,
  initialInStock,
  initialSort,
  useDemo = false,
}: MarketplaceFilterBarProps) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);
  const [category, setCategory] = useState(initialCategory);
  const [type, setType] = useState<ListingType | "all">(initialType);
  const [minPrice, setMinPrice] = useState(initialMinPrice);
  const [maxPrice, setMaxPrice] = useState(initialMaxPrice);
  const [condition, setCondition] = useState(initialCondition);
  const [inStock, setInStock] = useState(initialInStock);
  const [sort, setSort] = useState<MarketplaceSort>(initialSort);

  const hasAdvancedFilter = Boolean(
    initialCategory ||
      initialType !== "all" ||
      initialMinPrice ||
      initialMaxPrice ||
      initialCondition ||
      initialInStock
  );
  const [panelOpen, setPanelOpen] = useState(hasAdvancedFilter);

  function pushFilters(next: FilterState) {
    const params = new URLSearchParams();
    if (useDemo) params.set("demo", "1");
    if (next.q.trim()) params.set("q", next.q.trim());
    if (next.category) params.set("category", next.category);
    if (next.type !== "all") params.set("type", next.type);
    if (next.minPrice.trim()) params.set("minPrice", next.minPrice.trim());
    if (next.maxPrice.trim()) params.set("maxPrice", next.maxPrice.trim());
    if (next.condition) params.set("condition", next.condition);
    if (next.inStock) params.set("inStock", "1");
    if (next.sort !== "latest") params.set("sort", next.sort);
    const qs = params.toString();
    router.push(qs ? `/marketplace?${qs}` : "/marketplace");
  }

  function currentState(overrides: Partial<FilterState> = {}): FilterState {
    return {
      q: query,
      category,
      type,
      minPrice,
      maxPrice,
      condition,
      inStock,
      sort,
      ...overrides,
    };
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    pushFilters(currentState());
  }

  function handleResetAll() {
    setQuery("");
    setCategory("");
    setType("all");
    setMinPrice("");
    setMaxPrice("");
    setCondition("");
    setInStock(false);
    setSort("latest");
    router.push(useDemo ? "/marketplace?demo=1" : "/marketplace");
  }

  const activeChips: Array<{ key: string; label: string; onRemove: () => void }> =
    [];

  if (query.trim()) {
    activeChips.push({
      key: "q",
      label: `Search: "${query.trim()}"`,
      onRemove: () => {
        setQuery("");
        pushFilters(currentState({ q: "" }));
      },
    });
  }
  if (category) {
    const catName =
      categories.find((c) => c.slug === category)?.name ?? category;
    activeChips.push({
      key: "category",
      label: `Category: ${catName}`,
      onRemove: () => {
        setCategory("");
        pushFilters(currentState({ category: "" }));
      },
    });
  }
  if (type !== "all") {
    const typeLabel =
      LISTING_TYPES.find((t) => t.value === type)?.label ?? type;
    activeChips.push({
      key: "type",
      label: `Type: ${typeLabel}`,
      onRemove: () => {
        setType("all");
        pushFilters(currentState({ type: "all" }));
      },
    });
  }
  if (minPrice.trim() || maxPrice.trim()) {
    const priceLabel =
      minPrice === "0" && maxPrice === "0"
        ? "Price: Free"
        : minPrice && maxPrice
          ? `RM ${minPrice} – RM ${maxPrice}`
          : minPrice
            ? `From RM ${minPrice}`
            : `Up to RM ${maxPrice}`;
    activeChips.push({
      key: "price",
      label: priceLabel,
      onRemove: () => {
        setMinPrice("");
        setMaxPrice("");
        pushFilters(currentState({ minPrice: "", maxPrice: "" }));
      },
    });
  }
  if (condition) {
    const condLabel =
      CONDITIONS.find((c) => c.value === condition)?.label ?? condition;
    activeChips.push({
      key: "condition",
      label: `Condition: ${condLabel}`,
      onRemove: () => {
        setCondition("");
        pushFilters(currentState({ condition: "" }));
      },
    });
  }
  if (inStock) {
    activeChips.push({
      key: "inStock",
      label: "In Stock Only",
      onRemove: () => {
        setInStock(false);
        pushFilters(currentState({ inStock: false }));
      },
    });
  }
  if (sort !== "latest") {
    const sortLabel =
      SORT_OPTIONS.find((s) => s.value === sort)?.label ?? sort;
    activeChips.push({
      key: "sort",
      label: sortLabel,
      onRemove: () => {
        setSort("latest");
        pushFilters(currentState({ sort: "latest" }));
      },
    });
  }

  const advancedCount = [
    category,
    type !== "all" ? type : "",
    minPrice || maxPrice ? "price" : "",
    condition,
    inStock ? "stock" : "",
  ].filter(Boolean).length;

  return (
    <div className="space-y-3">
      <form
        onSubmit={handleSubmit}
        className="rounded-2xl border border-[#E6E3EE] bg-[#FAF9FC] p-3.5 shadow-[0_2px_10px_rgba(20,18,26,0.03)] sm:p-4"
        aria-label="Filter and sort marketplace listings"
      >
        {/* Top Toolbar Row: Search + Filters Toggle + Sort Dropdown */}
        <div className="flex flex-col gap-2.5 md:flex-row md:items-center">
          {/* Search Input */}
          <div className="relative flex flex-1 items-center overflow-hidden rounded-xl border border-[#D5D0E0] bg-white transition-all duration-150 focus-within:border-[#4E2A84] focus-within:ring-2 focus-within:ring-[#4E2A84]/20">
            <Search
              className="pointer-events-none ml-3.5 h-4 w-4 shrink-0 text-[#716C7D]"
              aria-hidden="true"
            />
            <input
              id="marketplace-q"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search keywords, textbooks, hostel area..."
              aria-label="Search marketplace listings"
              className="h-10 w-full bg-transparent px-3 text-sm text-[#14121A] placeholder:text-[#8E889B] outline-none"
            />
            <button
              type="submit"
              className="press-feedback mr-1.5 shrink-0 cursor-pointer rounded-lg bg-[#4E2A84] px-3.5 py-1.5 text-xs font-bold text-white hover:bg-[#381C63]"
            >
              Search
            </button>
          </div>

          <div className="flex items-center gap-2.5">
            {/* Filters Expand Toggle */}
            <button
              type="button"
              onClick={() => setPanelOpen((prev) => !prev)}
              aria-expanded={panelOpen}
              aria-controls="marketplace-filter-panel"
              className={`press-feedback inline-flex h-10 flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl border px-3.5 text-sm font-semibold transition-colors md:flex-none ${
                panelOpen || advancedCount > 0
                  ? "border-[#4E2A84] bg-[#F4F1FA] text-[#4E2A84]"
                  : "border-[#D5D0E0] bg-white text-[#14121A] hover:border-[#4E2A84]/40 hover:bg-[#F4F1FA]/50"
              }`}
            >
              <SlidersHorizontal className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>Filters</span>
              {advancedCount > 0 ? (
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[#4E2A84] px-1.5 text-[11px] font-bold text-white">
                  {advancedCount}
                </span>
              ) : null}
            </button>

            {/* Sorting Dropdown */}
            <div className="relative flex flex-1 items-center md:flex-none">
              <ArrowUpDown
                className="pointer-events-none absolute left-3 h-3.5 w-3.5 text-[#4E2A84]"
                aria-hidden="true"
              />
              <select
                id="marketplace-sort"
                aria-label="Sort listings"
                value={sort}
                onChange={(e) => {
                  const nextSort = e.target.value as MarketplaceSort;
                  setSort(nextSort);
                  pushFilters(currentState({ sort: nextSort }));
                }}
                className="h-10 w-full cursor-pointer rounded-xl border border-[#D5D0E0] bg-white pl-8 pr-3 text-sm font-semibold text-[#14121A] outline-none transition-all duration-150 focus:border-[#4E2A84] focus:ring-2 focus:ring-[#4E2A84]/20 md:w-[215px]"
              >
                {SORT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Expandable Filter Panel */}
        {panelOpen ? (
          <div
            id="marketplace-filter-panel"
            className="mt-3.5 border-t border-[#E6E3EE] pt-3.5 transition-opacity duration-150"
          >
            <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
              {/* Group 1: Category & Listing Type */}
              <div className="space-y-2.5 md:col-span-5">
                <div>
                  <label
                    htmlFor="marketplace-category"
                    className="mb-1 block text-xs font-semibold text-[#3E3B4B]"
                  >
                    Category
                  </label>
                  <select
                    id="marketplace-category"
                    value={category}
                    onChange={(e) => {
                      const nextCat = e.target.value;
                      setCategory(nextCat);
                      pushFilters(currentState({ category: nextCat }));
                    }}
                    className="h-9 w-full cursor-pointer rounded-xl border border-[#D5D0E0] bg-white px-3 text-sm text-[#14121A] outline-none transition-all duration-150 focus:border-[#4E2A84] focus:ring-2 focus:ring-[#4E2A84]/20"
                  >
                    <option value="">All Categories</option>
                    {categories.map((cat) => (
                      <option key={cat.id} value={cat.slug}>
                        {cat.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <span className="mb-1.5 block text-xs font-semibold text-[#3E3B4B]">
                    Listing Type
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {LISTING_TYPES.map((item) => {
                      const active = type === item.value;
                      return (
                        <button
                          key={item.value}
                          type="button"
                          onClick={() => {
                            setType(item.value);
                            pushFilters(currentState({ type: item.value }));
                          }}
                          className={`press-feedback cursor-pointer rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors ${
                            active
                              ? "bg-[#4E2A84] text-white shadow-xs"
                              : "border border-[#D5D0E0] bg-white text-[#3E3B4B] hover:border-[#4E2A84]/40 hover:bg-[#F4F1FA]"
                          }`}
                        >
                          {item.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Group 2: Price Range Controls */}
              <div className="space-y-2.5 md:col-span-4">
                <div>
                  <span className="mb-1 block text-xs font-semibold text-[#3E3B4B]">
                    Price Range (RM)
                  </span>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="0"
                      step="1"
                      inputMode="numeric"
                      value={minPrice}
                      onChange={(e) => setMinPrice(e.target.value)}
                      placeholder="Min"
                      aria-label="Minimum price in RM"
                      className="h-9 w-full rounded-xl border border-[#D5D0E0] bg-white px-3 text-sm text-[#14121A] placeholder:text-[#8E889B] outline-none focus:border-[#4E2A84] focus:ring-2 focus:ring-[#4E2A84]/20"
                    />
                    <span className="text-xs font-semibold text-[#716C7D]">
                      to
                    </span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      inputMode="numeric"
                      value={maxPrice}
                      onChange={(e) => setMaxPrice(e.target.value)}
                      placeholder="Max"
                      aria-label="Maximum price in RM"
                      className="h-9 w-full rounded-xl border border-[#D5D0E0] bg-white px-3 text-sm text-[#14121A] placeholder:text-[#8E889B] outline-none focus:border-[#4E2A84] focus:ring-2 focus:ring-[#4E2A84]/20"
                    />
                    <button
                      type="submit"
                      className="press-feedback h-9 shrink-0 cursor-pointer rounded-xl bg-[#008285] px-3 text-xs font-bold text-white hover:bg-[#006B6D]"
                    >
                      Apply
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {PRICE_PRESETS.map((preset) => {
                    const active =
                      minPrice === preset.min && maxPrice === preset.max;
                    return (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => {
                          setMinPrice(preset.min);
                          setMaxPrice(preset.max);
                          pushFilters(
                            currentState({
                              minPrice: preset.min,
                              maxPrice: preset.max,
                            })
                          );
                        }}
                        className={`press-feedback cursor-pointer rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors ${
                          active
                            ? "bg-[#008285] text-white shadow-xs"
                            : "border border-[#D5D0E0] bg-white text-[#3E3B4B] hover:border-[#008285]/50 hover:bg-[#EDFAF9]"
                        }`}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Group 3: Condition & Availability */}
              <div className="space-y-2.5 md:col-span-3">
                <div>
                  <label
                    htmlFor="marketplace-condition"
                    className="mb-1 block text-xs font-semibold text-[#3E3B4B]"
                  >
                    Condition
                  </label>
                  <select
                    id="marketplace-condition"
                    value={condition}
                    onChange={(e) => {
                      const nextCond = e.target.value;
                      setCondition(nextCond);
                      pushFilters(currentState({ condition: nextCond }));
                    }}
                    className="h-9 w-full cursor-pointer rounded-xl border border-[#D5D0E0] bg-white px-3 text-sm text-[#14121A] outline-none transition-all duration-150 focus:border-[#4E2A84] focus:ring-2 focus:ring-[#4E2A84]/20"
                  >
                    {CONDITIONS.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <span className="mb-1.5 block text-xs font-semibold text-[#3E3B4B]">
                    Availability
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={inStock}
                    onClick={() => {
                      const nextStock = !inStock;
                      setInStock(nextStock);
                      pushFilters(currentState({ inStock: nextStock }));
                    }}
                    className={`press-feedback flex h-9 w-full cursor-pointer items-center justify-between rounded-xl border px-3 text-xs font-semibold transition-colors ${
                      inStock
                        ? "border-[#008285] bg-[#EDFAF9] text-[#006B6D]"
                        : "border-[#D5D0E0] bg-white text-[#3E3B4B] hover:border-[#4E2A84]/40"
                    }`}
                  >
                    <span>In Stock Only</span>
                    <span
                      className={`flex h-4 w-4 items-center justify-center rounded-md transition-colors ${
                        inStock
                          ? "bg-[#008285] text-white"
                          : "border border-[#C9C2D6] bg-white"
                      }`}
                    >
                      {inStock ? <Check className="h-3 w-3" aria-hidden="true" /> : null}
                    </span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </form>

      {/* Selected Filter Indicators & Clear All Filters */}
      {activeChips.length > 0 ? (
        <div
          className="flex flex-wrap items-center justify-between gap-2 px-1"
          aria-label="Active filters"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs font-semibold text-[#6E6A7C]">
              Active:
            </span>
            {activeChips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={chip.onRemove}
                className="press-feedback inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-[#4E2A84]/20 bg-[#F4F1FA] px-3 py-1 text-xs font-semibold text-[#4E2A84] transition-colors hover:bg-[#EAE3F6]"
              >
                <span>{chip.label}</span>
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={handleResetAll}
            className="press-feedback cursor-pointer rounded-full px-3 py-1 text-xs font-bold text-[#BA1A1A] transition-colors hover:bg-[#FEF2F2]"
          >
            Clear All Filters
          </button>
        </div>
      ) : null}
    </div>
  );
}
