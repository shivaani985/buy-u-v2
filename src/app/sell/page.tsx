import type { Metadata } from "next";
import { SellerGate } from "@/components/seller/SellerGate";
import { SellerNav } from "@/components/seller/SellerNav";
import { SellListingForm } from "@/components/seller/SellListingForm";
import { getSellFormOptions, getSellerNewOrderCount } from "@/lib/seller/data";
import {
  evaluateSellerEligibility,
  type SellListingKind,
} from "@/lib/seller/validation";
import { getSessionSummary } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Create Listing",
  description:
    "Create and publish a campus listing or student service on Buy-U UMSKAL.",
};

const VALID_SELL_TYPES = new Set<SellListingKind>([
  "preloved",
  "business",
  "food",
  "service",
]);

export default async function SellPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const [params, session] = await Promise.all([
    searchParams,
    getSessionSummary(),
  ]);
  const eligibility = evaluateSellerEligibility(session);

  if (!eligibility.eligible) {
    return <SellerGate eligibility={eligibility} nextPath="/sell" />;
  }

  const rawType = (params.type ?? "").trim().toLowerCase() as SellListingKind;
  const initialListingType: SellListingKind = VALID_SELL_TYPES.has(rawType)
    ? rawType
    : "preloved";

  const [{ categories, collectionAreas, storefront }, newOrderCount] =
    await Promise.all([
      getSellFormOptions(session),
      getSellerNewOrderCount(session),
    ]);

  const sellerDisplayName =
    session.profile?.display_name ||
    session.profile?.full_name ||
    session.email?.split("@")[0] ||
    "UMS Student";

  return (
    <div className="bg-white">
      <div className="bori-container py-6 lg:py-8">
        <div>
          <h1 className="text-3xl font-extrabold italic tracking-[-0.02em] text-[#111018] sm:text-[36px]">
            Create{" "}
            <span className="inline-block bg-[#4E2A84] px-3 py-0.5 text-white hero-marketplace-slab">
              Listing
            </span>
          </h1>
          <p className="mt-1.5 text-sm text-[#555062]">
            Post an item, student business product, campus food, or student
            service to the UMS community.
          </p>
        </div>

        <div className="mt-5">
          <SellerNav newOrderCount={newOrderCount} />
        </div>

        <div className="mt-6">
          <SellListingForm
            categories={categories}
            collectionAreas={collectionAreas}
            storefrontName={storefront?.shopName ?? null}
            sellerDisplayName={sellerDisplayName}
            initialListingType={initialListingType}
          />
        </div>
      </div>
    </div>
  );
}
