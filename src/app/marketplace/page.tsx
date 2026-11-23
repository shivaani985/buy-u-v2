import type { Metadata } from "next";
import Link from "next/link";
import { ListingCard } from "@/components/marketplace/ListingCard";
import { MarketplaceFilterBar } from "@/components/marketplace/MarketplaceFilterBar";
import { DataSourceBanner } from "@/components/shared/DataSourceBanner";
import { getCategories, getListings } from "@/lib/catalog";
import type { ListingType } from "@/types/marketplace";

export const metadata: Metadata = {
  title: "Marketplace",
  description:
    "Browse published UMSKAL campus listings, student services, and free share items.",
};

const VALID_TYPES = new Set<ListingType>([
  "preloved",
  "business",
  "food",
  "service",
  "free",
]);

interface MarketplacePageProps {
  searchParams: Promise<{
    q?: string;
    category?: string;
    type?: string;
    demo?: string;
  }>;
}

export default async function MarketplacePage({
  searchParams,
}: MarketplacePageProps) {
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q : "";
  const category = typeof params.category === "string" ? params.category : "";
  const rawType = typeof params.type === "string" ? params.type : "all";
  const type: ListingType | "all" = VALID_TYPES.has(rawType as ListingType)
    ? (rawType as ListingType)
    : "all";
  const useDemo = params.demo === "1";

  const [categoriesResult, listingsResult] = await Promise.all([
    getCategories({ useDemo }),
    getListings({ q, category, type, useDemo }),
  ]);

  return (
    <div className="mx-auto w-full max-w-[1680px] px-4 py-10 sm:px-6 lg:px-10 xl:px-14">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b-2 border-[#14121A] pb-4">
        <div>
          <h1 className="text-3xl font-extrabold tracking-[-0.03em] text-[#14121A] sm:text-4xl">
            Campus{" "}
            <span className="font-editorial italic font-bold text-[#4E2A84]">
              Marketplace
            </span>
          </h1>
          <p className="mt-1.5 text-sm text-[#4A4656]">
            Read-only public catalog for UMSKAL, Labuan. Prices converted from
            sen to RM.
          </p>
        </div>

        <p className="tabular-price text-sm font-bold text-[#14121A]">
          {listingsResult.data.length}{" "}
          {listingsResult.data.length === 1 ? "listing" : "listings"} found
        </p>
      </div>

      <div className="mb-6">
        <DataSourceBanner
          source={listingsResult.source}
          notice={listingsResult.notice}
          errorCode={listingsResult.errorCode}
          demoHref="/marketplace?demo=1"
          liveHref="/marketplace"
        />
      </div>

      <MarketplaceFilterBar
        categories={categoriesResult.data}
        initialQuery={q}
        initialCategory={category}
        initialType={type}
        useDemo={useDemo}
      />

      {listingsResult.data.length > 0 ? (
        <div className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {listingsResult.data.map((listing) => (
            <ListingCard key={listing.id} listing={listing} />
          ))}
        </div>
      ) : (
        <div className="mt-10 border-2 border-[#14121A] bg-[#F7F7F5] p-8 text-center">
          <h2 className="font-editorial text-2xl font-bold text-[#14121A]">
            {listingsResult.source === "error"
              ? "Live catalog access is restricted for anonymous visitors"
              : "No matching campus listings"}
          </h2>
          <p className="mx-auto mt-2 max-w-lg text-sm text-[#4A4656]">
            {listingsResult.source === "error"
              ? "Supabase rejected anonymous SELECT queries with PostgreSQL 42501. No fictional demo listings are silently substituted. You can inspect the UI using Explicit Demo Mode or enable public SELECT policies / Phase 2 Auth."
              : "Try broadening your keywords, switching category, or clearing the listing type filter."}
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-3">
            {listingsResult.source === "error" ? (
              <Link
                href="/marketplace?demo=1"
                className="bg-[#4E2A84] px-5 py-2.5 text-sm font-bold text-white hover:bg-[#381C63] press-feedback"
              >
                Open Explicit Demo Mode
              </Link>
            ) : (
              <Link
                href={useDemo ? "/marketplace?demo=1" : "/marketplace"}
                className="bg-[#4E2A84] px-5 py-2.5 text-sm font-bold text-white hover:bg-[#381C63] press-feedback"
              >
                Reset all filters
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
