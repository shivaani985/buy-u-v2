import type { Metadata } from "next";
import { SellerGate } from "@/components/seller/SellerGate";
import { SellerNav } from "@/components/seller/SellerNav";
import { SellListingForm } from "@/components/seller/SellListingForm";
import { getSellFormOptions } from "@/lib/seller/data";
import { evaluateSellerEligibility } from "@/lib/seller/validation";
import { getSessionSummary } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Create Listing",
  description:
    "Create and publish a campus listing or student service on Buy-U UMSKAL.",
};

export default async function SellPage() {
  const session = await getSessionSummary();
  const eligibility = evaluateSellerEligibility(session);

  if (!eligibility.eligible) {
    return <SellerGate eligibility={eligibility} nextPath="/sell" />;
  }

  const { categories, collectionAreas, storefront } =
    await getSellFormOptions(session);

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
          <SellerNav />
        </div>

        <div className="mt-6 max-w-4xl">
          <SellListingForm
            categories={categories}
            collectionAreas={collectionAreas}
            storefrontName={storefront?.shopName ?? null}
          />
        </div>
      </div>
    </div>
  );
}
