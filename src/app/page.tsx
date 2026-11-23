import Link from "next/link";
import { Info } from "lucide-react";
import { CategoryGrid } from "@/components/home/CategoryGrid";
import { EditorialHero } from "@/components/home/EditorialHero";
import { HomeListingSection } from "@/components/home/HomeListingSection";
import { ServicesAndFreeColumns } from "@/components/home/ServicesAndFreeColumns";
import { getCategories, getListings } from "@/lib/catalog";
import { getSessionSummary } from "@/lib/supabase/server";

interface HomePageProps {
  searchParams: Promise<{ demo?: string }>;
}

export default async function HomePage({ searchParams }: HomePageProps) {
  const params = await searchParams;
  const useDemo = params.demo === "1";

  const [session, categoriesResult, listingsResult] = await Promise.all([
    getSessionSummary(),
    getCategories({ useDemo }),
    getListings({ useDemo }),
  ]);

  const serviceListings = listingsResult.data.filter(
    (item) => item.listingType === "service"
  );
  const freeListings = listingsResult.data.filter(
    (item) => item.listingType === "free"
  );

  return (
    <div className="bg-white">
      {/* Explicit Demo Mode notice shown ONLY when ?demo=1 is intentionally enabled */}
      {useDemo ? (
        <div className="bori-container pt-3">
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#1D70B8]/40 bg-[#F2F8FD] px-4 py-2 text-xs font-semibold text-[#14538A]"
          >
            <span className="inline-flex items-center gap-2">
              <Info className="h-4 w-4 shrink-0" aria-hidden="true" />
              Explicit Demo Preview (?demo=1) — sample catalog items shown, never
              mixed with live Supabase inventory.
            </span>
            <Link
              href="/"
              className="rounded-md border border-[#1D70B8] bg-white px-2.5 py-1 text-xs font-bold text-[#14538A] hover:bg-[#1D70B8] hover:text-white"
            >
              Return to Live Mode
            </Link>
          </div>
        </div>
      ) : null}

      {/* 1. Balanced Bori Hero */}
      <EditorialHero session={session} />

      {/* 2. Enlarged Rounded-Square Category Navigation */}
      <CategoryGrid
        categories={categoriesResult.data}
        source={categoriesResult.source}
        useDemo={useDemo}
      />

      {/* 3. Latest on Campus (Compact Product-First Grid) */}
      <HomeListingSection
        listings={listingsResult.data}
        source={listingsResult.source}
        notice={listingsResult.notice}
        useDemo={useDemo}
      />

      {/* 4. Side-by-Side Student Services & Free Items Columns (Banner + Previews) */}
      <ServicesAndFreeColumns
        services={serviceListings}
        freeItems={freeListings}
        source={listingsResult.source}
        useDemo={useDemo}
      />
    </div>
  );
}
