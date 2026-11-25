import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { ListingViewTracker } from "@/components/listings/ListingViewTracker";
import {
  ProductDetailClient,
  type SellerReviewItem,
} from "@/components/listings/ProductDetailClient";
import { DataSourceBanner } from "@/components/shared/DataSourceBanner";
import { getProductDetailData } from "@/lib/buyer/data";
import {
  computeRatingSummary,
  type RatingSummary,
} from "@/lib/marketplace/phase8";
import {
  createSupabaseServerClient,
  getSessionSummary,
} from "@/lib/supabase/server";

interface ListingDetailPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ demo?: string }>;
}

export async function generateMetadata({
  params,
  searchParams,
}: ListingDetailPageProps): Promise<Metadata> {
  const [{ slug }, sp, session] = await Promise.all([
    params,
    searchParams,
    getSessionSummary(),
  ]);
  const result = await getProductDetailData(slug, session, {
    useDemo: sp.demo === "1",
  });
  if (!result.data) {
    return { title: "Listing Details" };
  }
  return {
    title: result.data.title,
    description: result.data.description,
  };
}

export default async function ListingDetailPage({
  params,
  searchParams,
}: ListingDetailPageProps) {
  const [{ slug }, sp, session] = await Promise.all([
    params,
    searchParams,
    getSessionSummary(),
  ]);
  const useDemo = sp.demo === "1";
  const result = await getProductDetailData(slug, session, { useDemo });

  if (
    result.source === "error" ||
    result.source === "auth_required" ||
    result.source === "restricted"
  ) {
    return (
      <div className="bori-container py-8">
        <Link
          href="/marketplace"
          className="mb-6 inline-flex items-center gap-2 text-sm font-semibold text-[#14121A] transition hover:text-[#4E2A84]"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          <span>Back to Marketplace</span>
        </Link>
        <DataSourceBanner
          source={result.source}
          notice={result.notice}
          errorCode={result.errorCode}
          demoHref="/marketplace?demo=1"
          liveHref="/marketplace"
        />
      </div>
    );
  }

  if (!result.data) {
    notFound();
  }

  const product = result.data;
  let sellerReviews: SellerReviewItem[] = [];
  let ratingSummary: RatingSummary = {
    averageRating: null,
    totalReviews: 0,
    distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
  };

  if (!product.isDemo && product.seller.sellerId) {
    const supabase = await createSupabaseServerClient();
    if (supabase) {
      const { data: reviewRows } = await supabase
        .from("reviews")
        .select("id, rating, comment, seller_response, hidden, created_at")
        .eq("seller_id", product.seller.sellerId)
        .eq("hidden", false)
        .order("created_at", { ascending: false })
        .limit(20);

      if (reviewRows && reviewRows.length > 0) {
        const typedRows = reviewRows as Array<{
          id: string;
          rating: number;
          comment: string | null;
          seller_response?: string | null;
          hidden?: boolean | null;
          created_at: string;
        }>;
        ratingSummary = computeRatingSummary(typedRows);
        sellerReviews = typedRows.slice(0, 6).map((r) => ({
          id: r.id,
          rating: r.rating,
          comment: r.comment ?? "",
          sellerResponse: r.seller_response ?? null,
          createdAt: r.created_at,
        }));
      }
    }
  }

  return (
    <div className="bg-white">
      <div className="mx-auto w-full max-w-[1180px] px-4 py-5 sm:px-6 lg:px-8">
        {result.notice ? (
          <div className="mb-4">
            <DataSourceBanner
              source={result.source}
              notice={result.notice}
              demoHref={`/listings/${encodeURIComponent(slug)}?demo=1`}
              liveHref={`/listings/${encodeURIComponent(slug)}`}
            />
          </div>
        ) : null}

        {!product.isDemo && session.isAuthenticated ? (
          <ListingViewTracker listingId={product.id} />
        ) : null}

        <ProductDetailClient
          product={product}
          buyerEligibility={result.buyerEligibility}
          ratingSummary={ratingSummary}
          sellerReviews={sellerReviews}
        />
      </div>
    </div>
  );
}
