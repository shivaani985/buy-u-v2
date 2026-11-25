import type { Metadata } from "next";
import Link from "next/link";
import { PackageSearch } from "lucide-react";
import { ListingCard } from "@/components/marketplace/ListingCard";
import { MarketplaceFilterBar } from "@/components/marketplace/MarketplaceFilterBar";
import { DataSourceBanner } from "@/components/shared/DataSourceBanner";
import { getCategories, getListings } from "@/lib/catalog";
import {
  createSupabaseServerClient,
  getSessionSummary,
} from "@/lib/supabase/server";
import type { ListingType, MarketplaceSort } from "@/types/marketplace";

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

const VALID_SORTS = new Set<MarketplaceSort>([
  "latest",
  "price_asc",
  "price_desc",
]);

interface MarketplacePageProps {
  searchParams: Promise<{
    q?: string;
    category?: string;
    type?: string;
    minPrice?: string;
    maxPrice?: string;
    condition?: string;
    inStock?: string;
    sort?: string;
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
  const minPriceStr = typeof params.minPrice === "string" ? params.minPrice : "";
  const maxPriceStr = typeof params.maxPrice === "string" ? params.maxPrice : "";
  const minPriceNum =
    minPriceStr.trim() !== "" && Number.isFinite(Number(minPriceStr))
      ? Number(minPriceStr)
      : undefined;
  const maxPriceNum =
    maxPriceStr.trim() !== "" && Number.isFinite(Number(maxPriceStr))
      ? Number(maxPriceStr)
      : undefined;
  const condition = typeof params.condition === "string" ? params.condition : "";
  const inStock = params.inStock === "1";
  const rawSort = typeof params.sort === "string" ? params.sort : "latest";
  const sort: MarketplaceSort = VALID_SORTS.has(rawSort as MarketplaceSort)
    ? (rawSort as MarketplaceSort)
    : "latest";
  const useDemo = params.demo === "1";

  const [session, categoriesResult, listingsResult] = await Promise.all([
    getSessionSummary(),
    getCategories({ useDemo }),
    getListings({
      q,
      category,
      type,
      minPrice: minPriceNum,
      maxPrice: maxPriceNum,
      condition,
      inStock,
      sort,
      useDemo,
    }),
  ]);

  let favouriteIds: string[] = [];
  if (!useDemo && session.isActiveMember && session.profile?.id) {
    const supabase = await createSupabaseServerClient();
    if (supabase) {
      const { data: favRows } = await supabase
        .from("favourites")
        .select("listing_id")
        .eq("user_id", session.profile.id);
      if (favRows) {
        favouriteIds = (favRows as { listing_id: string }[]).map(
          (r) => r.listing_id
        );
      }
    }
  }

  return (
    <div className="bg-white">
      <div className="bori-container py-6 sm:py-8">
        {/* Page Header */}
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3 border-b border-[#E6E3EE] pb-3.5">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-[26px] font-extrabold tracking-[-0.02em] text-[#14121A] sm:text-[32px]">
                Campus{" "}
                <span className="font-editorial italic font-bold text-[#4E2A84]">
                  Marketplace
                </span>
              </h1>
              <span
                className="h-2.5 w-2.5 rounded-full bg-[#00A3A6]"
                aria-hidden="true"
              />
            </div>
            <p className="mt-1 text-sm text-[#5B5668]">
              Browse verified UMSKAL student &amp; staff listings, campus
              services, and free share items.
            </p>
          </div>

          <span className="tabular-price inline-flex items-center rounded-full bg-[#F4F1FA] px-3.5 py-1.5 text-xs font-bold text-[#4E2A84]">
            {listingsResult.data.length}{" "}
            {listingsResult.data.length === 1 ? "listing" : "listings"} found
          </span>
        </div>

        {/* Show status banner only when auth/restricted/error/demo notice is active */}
        {listingsResult.source !== "supabase" ? (
          <div className="mb-5">
            <DataSourceBanner
              source={listingsResult.source}
              notice={listingsResult.notice}
              errorCode={listingsResult.errorCode}
              demoHref="/marketplace?demo=1"
              liveHref="/marketplace"
            />
          </div>
        ) : null}

        {/* Filter Bar */}
        <MarketplaceFilterBar
          categories={categoriesResult.data}
          initialQuery={q}
          initialCategory={category}
          initialType={type}
          initialMinPrice={minPriceStr}
          initialMaxPrice={maxPriceStr}
          initialCondition={condition}
          initialInStock={inStock}
          initialSort={sort}
          useDemo={useDemo}
        />

        {/* Listings Grid or Empty State */}
        {listingsResult.data.length > 0 ? (
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {listingsResult.data.map((listing) => (
              <ListingCard
                key={listing.id}
                listing={listing}
                isFavourited={favouriteIds.includes(listing.id)}
                canFavourite={session.isActiveMember}
              />
            ))}
          </div>
        ) : (
          <div className="mt-8 rounded-2xl border border-[#E6E3EE] bg-[#FAF9FC] p-8 text-center sm:p-10">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-[#F4F1FA] text-[#4E2A84]">
              <PackageSearch className="h-6 w-6" aria-hidden="true" />
            </div>
            <h2 className="mt-3 text-xl font-extrabold tracking-tight text-[#14121A] sm:text-2xl">
              {listingsResult.source === "auth_required"
                ? "Sign in with your UMS account to browse live listings"
                : listingsResult.source === "restricted"
                  ? "Active UMS member account required"
                  : listingsResult.source === "error"
                    ? "Unable to load live marketplace listings"
                    : "No matching campus listings"}
            </h2>
            <p className="mx-auto mt-2 max-w-lg text-sm text-[#5B5668]">
              {listingsResult.source === "auth_required"
                ? "Buy-U protects student and staff listings inside the verified UMS community. Sign in with @iluv.ums.edu.my or @ums.edu.my, or inspect the layout in Demo Mode."
                : listingsResult.source === "restricted"
                  ? listingsResult.notice
                  : listingsResult.source === "error"
                    ? listingsResult.notice
                    : "Try broadening your keywords, switching category, or clearing the listing type filter."}
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-3">
              {listingsResult.source === "auth_required" ? (
                <>
                  <Link
                    href="/login?next=/marketplace"
                    className="press-feedback inline-flex items-center rounded-xl bg-[#4E2A84] px-5 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-[#381C63]"
                  >
                    Sign In with UMS Email
                  </Link>
                  <Link
                    href="/marketplace?demo=1"
                    className="press-feedback inline-flex items-center rounded-xl border border-[#D5D0E0] bg-white px-5 py-2.5 text-sm font-bold text-[#14121A] hover:border-[#4E2A84]/40 hover:bg-[#F4F1FA]"
                  >
                    Open Demo Preview
                  </Link>
                </>
              ) : (
                <Link
                  href={useDemo ? "/marketplace?demo=1" : "/marketplace"}
                  className="press-feedback inline-flex items-center rounded-xl bg-[#4E2A84] px-5 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-[#381C63]"
                >
                  Reset all filters
                </Link>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
