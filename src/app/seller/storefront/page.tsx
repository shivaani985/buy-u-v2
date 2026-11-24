import type { Metadata } from "next";
import { CheckCircle2 } from "lucide-react";
import { SellerGate } from "@/components/seller/SellerGate";
import { SellerNav } from "@/components/seller/SellerNav";
import { StorefrontForm } from "@/components/seller/StorefrontForm";
import { getSellerHubData } from "@/lib/seller/data";
import { evaluateSellerEligibility } from "@/lib/seller/validation";
import { getSessionSummary } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Storefront Settings",
  description:
    "Create or edit your UMS campus storefront name, description, logo, and public preview.",
};

interface StorefrontPageProps {
  searchParams: Promise<{ initialized?: string }>;
}

export default async function SellerStorefrontPage({
  searchParams,
}: StorefrontPageProps) {
  const params = await searchParams;
  const session = await getSessionSummary();
  const eligibility = evaluateSellerEligibility(session);

  if (!eligibility.eligible) {
    return (
      <SellerGate eligibility={eligibility} nextPath="/seller/storefront" />
    );
  }

  const hub = await getSellerHubData(session);
  const fallbackName =
    session.profile?.display_name ||
    session.profile?.full_name ||
    session.email?.split("@")[0] ||
    "Campus Storefront";

  return (
    <div className="bg-white">
      <div className="bori-container py-6 lg:py-8">
        <div>
          <h1 className="text-3xl font-extrabold italic tracking-[-0.02em] text-[#111018] sm:text-[36px]">
            My{" "}
            <span className="inline-block bg-[#00A3A6] px-3 py-0.5 text-white hero-marketplace-slab">
              Storefront
            </span>
          </h1>
          <p className="mt-1.5 text-sm text-[#555062]">
            Customize how your campus shop appears to UMS buyers.
          </p>
        </div>

        <div className="mt-5">
          <SellerNav />
        </div>

        {params.initialized === "1" ? (
          <div
            role="status"
            className="mt-5 flex items-center gap-2 rounded-xl border border-[#00A3A6]/40 bg-[#EDFAF9] px-4 py-3 text-sm font-semibold text-[#007D80]"
          >
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              Your campus storefront has been initialized! Customize your name,
              bio, and logo below.
            </span>
          </div>
        ) : null}

        <div className="mt-6">
          <StorefrontForm
            initialShopName={hub.storefront?.shopName || fallbackName}
            initialDescription={hub.storefront?.description || ""}
            initialLogoUrl={hub.storefront?.logoUrl ?? null}
            initialBannerUrl={hub.storefront?.bannerUrl ?? null}
            initialBusinessInfo={hub.storefront?.businessInfo ?? ""}
            initialIsOpen={hub.storefront?.isOpen ?? true}
            faculty={session.profile?.faculty ?? null}
            publishedCount={hub.counts.published}
            isNewStorefront={!hub.storefront}
          />
        </div>
      </div>
    </div>
  );
}
