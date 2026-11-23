import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ShieldAlert } from "lucide-react";
import { EditListingForm } from "@/components/seller/EditListingForm";
import { SellerGate } from "@/components/seller/SellerGate";
import { SellerNav } from "@/components/seller/SellerNav";
import { getSellerListingForEdit } from "@/lib/seller/data";
import { evaluateSellerEligibility } from "@/lib/seller/validation";
import { getSessionSummary } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Edit Listing",
  description:
    "Edit your Buy-U campus listing, manage variants, inventory, photos, and publication status.",
};

interface EditListingPageProps {
  params: Promise<{ id: string }>;
}

export default async function EditListingPage({ params }: EditListingPageProps) {
  const { id } = await params;
  const session = await getSessionSummary();
  const eligibility = evaluateSellerEligibility(session);

  if (!eligibility.eligible) {
    return <SellerGate eligibility={eligibility} nextPath={`/sell/${id}`} />;
  }

  const loaded = await getSellerListingForEdit(session, id);

  if (loaded.status !== "ok") {
    return (
      <div className="bg-[#FAFAFC]">
        <div className="bori-container py-8 lg:py-12">
          <div className="mx-auto max-w-xl rounded-2xl border border-[#E6E3EE] bg-white p-6 shadow-[0_1px_4px_rgba(20,18,26,0.04)] sm:p-8">
            <div className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-wider text-[#B42318]">
              <ShieldAlert className="h-4 w-4" aria-hidden="true" />
              <span>
                {loaded.status === "forbidden"
                  ? "Ownership Required"
                  : "Listing Unavailable"}
              </span>
            </div>
            <h1 className="mt-2 text-2xl font-extrabold italic text-[#111018]">
              {loaded.status === "forbidden"
                ? "Cannot Edit This Listing"
                : "Listing Not Found"}
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-[#555062]">
              {loaded.message}
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                href="/seller"
                className="inline-flex items-center gap-2 rounded-xl bg-[#4E2A84] px-4 py-2.5 text-sm font-bold text-white hover:bg-[#3A1E66] press-feedback"
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                <span>Back to Seller Hub</span>
              </Link>
              <Link
                href="/sell"
                className="inline-flex items-center gap-2 rounded-xl border border-[#D5D1E3] bg-white px-4 py-2.5 text-sm font-bold text-[#14121A] hover:border-[#4E2A84] hover:text-[#4E2A84]"
              >
                <span>Create New Listing</span>
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-[#FAFAFC]">
      <div className="bori-container py-6 lg:py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <Link
              href="/seller"
              className="inline-flex items-center gap-1 text-xs font-bold text-[#4E2A84] hover:underline"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Back to Seller Hub</span>
            </Link>
            <h1 className="mt-1.5 text-3xl font-extrabold italic tracking-[-0.02em] text-[#111018] sm:text-[34px]">
              Edit{" "}
              <span className="inline-block bg-[#4E2A84] px-3 py-0.5 text-white hero-marketplace-slab">
                Listing
              </span>
            </h1>
            <p className="mt-1 text-sm text-[#555062]">
              Update details, stock, variants, photos, or publication status.
            </p>
          </div>
        </div>

        <div className="mt-4">
          <SellerNav />
        </div>

        <div className="mt-6 max-w-4xl">
          <EditListingForm
            listing={loaded.listing}
            categories={loaded.categories}
            collectionAreas={loaded.collectionAreas}
          />
        </div>
      </div>
    </div>
  );
}
