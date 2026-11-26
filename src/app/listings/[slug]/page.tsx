import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { ListingViewTracker } from "@/components/listings/ListingViewTracker";
import {
  ProductDetailClient,
  type WriteReviewOrderContext,
} from "@/components/listings/ProductDetailClient";
import { DataSourceBanner } from "@/components/shared/DataSourceBanner";
import { getProductDetailData } from "@/lib/buyer/data";
import { isValidUuid } from "@/lib/buyer/validation";
import { isBlockingRefundStatus } from "@/lib/orders/lifecycle";
import {
  loadListingRatingAndSoldMap,
  sanitizePublicReviewRow,
  type ListingRatingAndSoldMetrics,
  type PublicReviewItem,
} from "@/lib/reviews/presentation";
import { formatVariationOptionLabel } from "@/lib/seller/variations";
import { getPublicSupabaseEnv } from "@/lib/supabase/env";
import {
  createSupabaseServerClient,
  getSessionSummary,
} from "@/lib/supabase/server";
import { getServerServiceClient } from "@/lib/supabase/service";

interface ListingDetailPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ demo?: string; variant?: string; prevVariant?: string }>;
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
  if (product.isFreeNotice && !product.isDemo) {
    redirect(`/free-items?post=${product.id}#post-${product.id}`);
  }

  const viewerUserId = session.profile?.id ?? null;
  let listingReviews: PublicReviewItem[] = [];
  let ratingMetrics: ListingRatingAndSoldMetrics = {
    listingRatingSummary: {
      averageRating: null,
      totalReviews: 0,
      distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    },
    shopRatingSummary: {
      averageRating: null,
      totalReviews: 0,
      distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    },
    effectiveRating: null,
    effectiveReviewCount: 0,
    ratingSource: "none",
    totalSold: 0,
  };
  let writeReviewOrder: WriteReviewOrderContext | null = null;

  if (!product.isDemo && product.seller.sellerId) {
    const service = getServerServiceClient();
    const supabase = await createSupabaseServerClient();
    const db = service ?? supabase;
    const env = getPublicSupabaseEnv();

    if (db) {
      const [metricsMap, rawRevRes] = await Promise.all([
        service
          ? loadListingRatingAndSoldMap(service, [
              { listingId: product.id, sellerId: product.seller.sellerId },
            ])
          : Promise.resolve(new Map<string, ListingRatingAndSoldMetrics>()),
        (service
          ? service
              .from("reviews")
              .select(
                "id,order_id,listing_id,service_request_id,buyer_id,rating,comment,seller_response,hidden,is_anonymous,image_paths,video_path,edited_at,created_at"
              )
              .eq("listing_id", product.id)
              .eq("hidden", false)
              .order("created_at", { ascending: false })
              .limit(50)
          : Promise.resolve({ data: null, error: true })
        ).then(async (res) => {
          if (!res.error) return res;
          return db
            .from("reviews")
            .select("id,listing_id,rating,comment,seller_response,hidden,is_anonymous,created_at")
            .eq("listing_id", product.id)
            .eq("hidden", false)
            .order("created_at", { ascending: false })
            .limit(50);
        }),
      ]);

      const resolvedMetrics = metricsMap.get(product.id);
      if (resolvedMetrics) {
        ratingMetrics = resolvedMetrics;
      }

      const rawReviews = (rawRevRes.data ?? []) as Array<{
        id: string;
        order_id?: string | null;
        listing_id: string | null;
        service_request_id?: string | null;
        buyer_id?: string | null;
        rating: number;
        comment: string | null;
        seller_response?: string | null;
        hidden?: boolean | null;
        is_anonymous?: boolean | null;
        image_paths?: string[] | null;
        video_path?: string | null;
        edited_at?: string | null;
        created_at: string;
      }>;

      const buyerIds = Array.from(
        new Set(
          rawReviews
            .filter((r) => !r.is_anonymous && r.buyer_id)
            .map((r) => r.buyer_id!)
        )
      );
      const reviewOrderIds = Array.from(
        new Set(rawReviews.flatMap((r) => !r.is_anonymous && r.order_id ? [r.order_id] : []))
      );

      const [profilesRes, orderItemsRes, viewerOrdersRes] = await Promise.all([
        service && buyerIds.length > 0
          ? service
              .from("profiles")
              .select("id,display_name,full_name,avatar_url")
              .in("id", buyerIds)
          : Promise.resolve({ data: [] }),
        reviewOrderIds.length > 0
          ? db
              .from("order_items")
              .select("order_id,listing_id,variant_snapshot")
              .in("order_id", reviewOrderIds)
              .eq("listing_id", product.id)
          : Promise.resolve({ data: [] }),
        service &&
        viewerUserId &&
        result.buyerEligibility.eligible &&
        viewerUserId !== product.seller.sellerId
          ? service
              .from("order_items")
              .select(
                "id,order_id,listing_id,title_snapshot,variant_snapshot,image_path,is_service,orders!inner(id,order_code,buyer_id,status,paid_at,completed_at)"
              )
              .eq("listing_id", product.id)
              .eq("orders.buyer_id", viewerUserId)
              .eq("orders.status", "completed")
              .limit(10)
          : Promise.resolve({ data: [] }),
      ]);

      const profileMap = new Map<
        string,
        { display_name: string | null; full_name: string | null; avatar_url: string | null }
      >();
      for (const p of (profilesRes.data ?? []) as Array<{
        id: string;
        display_name: string | null;
        full_name: string | null;
        avatar_url: string | null;
      }>) {
        profileMap.set(p.id, p);
      }

      const variantByOrder = new Map<string, string>();
      for (const oi of (orderItemsRes.data ?? []) as Array<{
        order_id: string;
        variant_snapshot?: Record<string, string> | null;
      }>) {
        if (
          oi.variant_snapshot &&
          typeof oi.variant_snapshot === "object" &&
          Object.keys(oi.variant_snapshot).length > 0
        ) {
          variantByOrder.set(oi.order_id, formatVariationOptionLabel(oi.variant_snapshot));
        }
      }

      listingReviews = rawReviews
        .map((r) =>
          sanitizePublicReviewRow({
            review: {
              ...r,
              buyer_id: r.buyer_id ?? "",
            },
            profile:
              !r.is_anonymous && r.buyer_id ? profileMap.get(r.buyer_id) ?? null : null,
            purchasedVariantLabel: r.order_id ? variantByOrder.get(r.order_id) ?? null : null,
            viewerUserId,
            storageBaseUrl: env?.url,
          })
        )
        .filter((r): r is PublicReviewItem => r !== null);

      // Check whether the current buyer has a completed verified order for this listing with no review yet
      const candidateItems = (viewerOrdersRes.data ?? []) as Array<{
        id: string;
        order_id: string;
        listing_id: string | null;
        title_snapshot: string;
        variant_snapshot?: Record<string, string> | null;
        is_service?: boolean | null;
        orders: { id: string; order_code: string; paid_at: string | null } | Array<{ id: string; order_code: string; paid_at: string | null }>;
      }>;

      if (service && candidateItems.length > 0) {
        const candOrderIds = Array.from(new Set(candidateItems.map((c) => c.order_id)));
        const [existingRevs, refundsRes, disputesRes] = await Promise.all([
          service
            .from("reviews")
            .select("order_id,listing_id")
            .eq("buyer_id", viewerUserId!)
            .eq("listing_id", product.id)
            .in("order_id", candOrderIds),
          service
            .from("order_refunds")
            .select("order_id,refund_type,status")
            .in("order_id", candOrderIds),
          service
            .from("order_disputes")
            .select("order_id,status,refund_execution_status")
            .in("order_id", candOrderIds),
        ]);

        const reviewedOrders = new Set(
          ((existingRevs.data ?? []) as Array<{ order_id: string | null }>)
            .map((r) => r.order_id)
            .filter((id): id is string => Boolean(id))
        );
        const blockedOrders = new Set<string>();
        for (const rf of (refundsRes.data ?? []) as Array<{
          order_id: string;
          refund_type: string;
          status: string;
        }>) {
          if (
            (rf.refund_type === "full_refund" && rf.status === "succeeded") ||
            isBlockingRefundStatus(rf.status)
          ) {
            blockedOrders.add(rf.order_id);
          }
        }
        for (const dp of (disputesRes.data ?? []) as Array<{
          order_id: string;
          status: string;
          refund_execution_status?: string | null;
        }>) {
          if (
            ["open", "under_review"].includes(dp.status) ||
            ["pending_execution", "failed"].includes(dp.refund_execution_status ?? "")
          ) {
            blockedOrders.add(dp.order_id);
          }
        }

        const eligibleCandidate = candidateItems.find((c) => {
          const ord = Array.isArray(c.orders) ? c.orders[0] : c.orders;
          return Boolean(ord?.paid_at) && !reviewedOrders.has(c.order_id) && !blockedOrders.has(c.order_id);
        });

        if (eligibleCandidate) {
          const ord = Array.isArray(eligibleCandidate.orders)
            ? eligibleCandidate.orders[0]
            : eligibleCandidate.orders;
          const vLabel =
            eligibleCandidate.variant_snapshot &&
            typeof eligibleCandidate.variant_snapshot === "object" &&
            Object.keys(eligibleCandidate.variant_snapshot).length > 0
              ? formatVariationOptionLabel(eligibleCandidate.variant_snapshot)
              : null;
          writeReviewOrder = {
            orderId: eligibleCandidate.order_id,
            orderCode: ord?.order_code ?? "",
            listingId: product.id,
            itemTitle: eligibleCandidate.title_snapshot || product.title,
            variantLabel: vLabel,
            imageUrl: product.imageUrls[0] ?? null,
            isService: Boolean(eligibleCandidate.is_service),
          };
        }
      }
    }
  }

  const preselectedVariantId =
    sp.variant && isValidUuid(sp.variant) ? sp.variant : null;
  const prevVariantLabel =
    typeof sp.prevVariant === "string" && sp.prevVariant.trim()
      ? sp.prevVariant.trim().slice(0, 80)
      : null;

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
          ratingMetrics={ratingMetrics}
          listingReviews={listingReviews}
          preselectedVariantId={preselectedVariantId}
          prevVariantLabel={prevVariantLabel}
          writeReviewOrder={writeReviewOrder}
        />
      </div>
    </div>
  );
}
