import type { SupabaseClient } from "@supabase/supabase-js";
import { resolvePublicStorageUrl } from "../format.ts";
import { computeRatingSummary, type RatingSummary } from "../marketplace/phase8.ts";
import { ANONYMOUS_REVIEWER_NAME } from "./validation.ts";

export type ListingRatingSource = "listing" | "shop" | "none";

export interface ListingRatingAndSoldMetrics {
  listingRatingSummary: RatingSummary;
  shopRatingSummary: RatingSummary;
  effectiveRating: number | null;
  effectiveReviewCount: number;
  ratingSource: ListingRatingSource;
  totalSold: number;
}

export interface ReviewMediaAttachment {
  kind: "image" | "video";
  url: string;
}

export interface PublicReviewItem {
  id: string;
  listingId: string | null;
  rating: number;
  comment: string;
  isAnonymous: boolean;
  reviewerDisplayName: string;
  reviewerAvatarUrl: string | null;
  purchasedVariantLabel: string | null;
  isVerifiedPurchase: boolean;
  isVerifiedService: boolean;
  isEdited: boolean;
  media: ReviewMediaAttachment[];
  sellerResponse: string | null;
  createdAt: string;
  editedAt: string | null;
  isOwnReview: boolean;
  canEdit: boolean;
  /** Raw paths ONLY populated for the logged-in owner when editing their own review; never emitted for other viewers. */
  ownEditableDraft?: {
    imagePaths: string[];
    videoPath: string | null;
    isAnonymous: boolean;
  };
}

export function buildReviewMediaProxyUrl(input: {
  reviewId: string;
  kind: "image" | "video";
  index?: number;
}): string {
  const params = new URLSearchParams({
    reviewId: input.reviewId,
    kind: input.kind,
  });
  if (input.kind === "image") {
    params.set("index", String(input.index ?? 0));
  }
  return `/api/reviews/media?${params.toString()}`;
}

export function buildReviewMediaPreviewUrl(path: string): string {
  const params = new URLSearchParams({ previewPath: path });
  return `/api/reviews/media?${params.toString()}`;
}

export function resolveMemberAvatarUrl(
  rawAvatar: string | null | undefined,
  storageBaseUrl: string | null | undefined
): string | null {
  const clean = typeof rawAvatar === "string" ? rawAvatar.trim() : "";
  if (!clean || clean.includes("..")) return null;
  if (/^https?:\/\//i.test(clean)) return clean;
  return resolvePublicStorageUrl("listings", clean, storageBaseUrl);
}

/**
 * Projects a raw database review + profile record into a public-safe view.
 * Guarantees ZERO leakage of `buyer_id`, real display name, or avatar URL
 * whenever `is_anonymous` is true.
 */
export function sanitizePublicReviewRow(input: {
  review: {
    id: string;
    listing_id: string | null;
    order_id?: string | null;
    service_request_id?: string | null;
    buyer_id: string;
    rating: number;
    comment: string | null;
    seller_response?: string | null;
    hidden?: boolean | null;
    is_anonymous?: boolean | null;
    image_paths?: string[] | null;
    video_path?: string | null;
    edited_at?: string | null;
    created_at: string;
  };
  profile?: {
    display_name: string | null;
    full_name?: string | null;
    avatar_url?: string | null;
  } | null;
  purchasedVariantLabel?: string | null;
  viewerUserId?: string | null;
  storageBaseUrl?: string | null;
}): PublicReviewItem | null {
  const { review } = input;
  if (review.hidden) return null;

  const isAnonymous = Boolean(review.is_anonymous);
  const isOwnReview = Boolean(input.viewerUserId && input.viewerUserId === review.buyer_id);

  const realDisplayName =
    input.profile?.display_name?.trim() ||
    input.profile?.full_name?.trim() ||
    "UMS Buyer";

  const reviewerDisplayName = isAnonymous
    ? ANONYMOUS_REVIEWER_NAME
    : realDisplayName;

  const reviewerAvatarUrl = isAnonymous
    ? null
    : resolveMemberAvatarUrl(input.profile?.avatar_url, input.storageBaseUrl);

  const rawImages = Array.isArray(review.image_paths)
    ? review.image_paths.filter((p) => typeof p === "string" && p.trim().length > 0)
    : [];
  const hasVideo = typeof review.video_path === "string" && review.video_path.trim().length > 0;

  const media: ReviewMediaAttachment[] = [
    ...rawImages.map((_, index) => ({
      kind: "image" as const,
      url: buildReviewMediaProxyUrl({ reviewId: review.id, kind: "image", index }),
    })),
    ...(hasVideo
      ? [
          {
            kind: "video" as const,
            url: buildReviewMediaProxyUrl({ reviewId: review.id, kind: "video" }),
          },
        ]
      : []),
  ];

  const editedAt = review.edited_at ?? null;

  return {
    id: review.id,
    listingId: review.listing_id,
    rating: Number(review.rating ?? 5),
    comment: review.comment ?? "",
    isAnonymous,
    reviewerDisplayName,
    reviewerAvatarUrl,
    purchasedVariantLabel: isAnonymous ? null : input.purchasedVariantLabel ?? null,
    isVerifiedPurchase: Boolean(review.order_id),
    isVerifiedService: Boolean(review.service_request_id),
    isEdited: Boolean(editedAt),
    media,
    sellerResponse: review.seller_response ?? null,
    createdAt: review.created_at,
    editedAt,
    isOwnReview,
    canEdit: isOwnReview,
    ...(isOwnReview
      ? {
          ownEditableDraft: {
            imagePaths: rawImages,
            videoPath: hasVideo ? review.video_path!.trim() : null,
            isAnonymous,
          },
        }
      : {}),
  };
}

/**
 * Pure rating + total sold computation enforcing:
 * - Scenario A: listing has eligible reviews -> listing rating & listing review count
 * - Scenario B: listing has 0 reviews & seller has reviews -> weighted shop rating fallback
 * - Scenario C: neither has reviews -> null ("Not rated yet")
 * - Total sold: strictly completed, verified orders (excluding unpaid, in-progress, cancelled,
 *   expired, and fully refunded orders; summing purchased unit quantities across variations).
 */
export function computeListingRatingAndSoldMap(input: {
  entries: Array<{ listingId: string; sellerId: string }>;
  reviews: Array<{
    listing_id: string | null;
    seller_id: string;
    rating: number;
    hidden?: boolean | null;
  }>;
  completedOrderItems: Array<{
    listing_id: string | null;
    order_id: string;
    quantity: number | null;
    order_status: string;
    paid_at: string | null;
    checkout_session_id?: string | null;
  }>;
  verifiedSessionIds?: Set<string>;
  verifiedLegacyOrderIds?: Set<string>;
  fullRefundOrderIds?: Set<string>;
  completedServiceRequests?: Array<{ listing_id: string | null; status: string }>;
}): Map<string, ListingRatingAndSoldMetrics> {
  const listingRevs = new Map<string, Array<{ rating: number; hidden?: boolean | null }>>();
  const sellerRevs = new Map<string, Array<{ rating: number; hidden?: boolean | null }>>();

  for (const r of input.reviews) {
    if (r.hidden) continue;
    if (r.listing_id) {
      const arr = listingRevs.get(r.listing_id) ?? [];
      arr.push(r);
      listingRevs.set(r.listing_id, arr);
    }
    if (r.seller_id) {
      const sArr = sellerRevs.get(r.seller_id) ?? [];
      sArr.push(r);
      sellerRevs.set(r.seller_id, sArr);
    }
  }

  const totalSoldByListing = new Map<string, number>();
  for (const row of input.completedOrderItems) {
    if (!row.listing_id) continue;
    if (row.order_status !== "completed") continue;
    if (input.fullRefundOrderIds?.has(row.order_id)) continue;

    // Require verified payment when verification sets are supplied
    if (input.verifiedSessionIds || input.verifiedLegacyOrderIds) {
      const hasPaidAt = Boolean(row.paid_at);
      const sessionVerified = row.checkout_session_id
        ? Boolean(input.verifiedSessionIds?.has(row.checkout_session_id))
        : false;
      const legacyVerified = !row.checkout_session_id
        ? Boolean(input.verifiedLegacyOrderIds?.has(row.order_id))
        : false;
      if (!hasPaidAt || (!sessionVerified && !legacyVerified)) continue;
    }

    const qty = Math.max(1, Number(row.quantity ?? 1));
    totalSoldByListing.set(
      row.listing_id,
      (totalSoldByListing.get(row.listing_id) ?? 0) + qty
    );
  }

  for (const sr of input.completedServiceRequests ?? []) {
    if (!sr.listing_id || sr.status !== "completed") continue;
    totalSoldByListing.set(
      sr.listing_id,
      (totalSoldByListing.get(sr.listing_id) ?? 0) + 1
    );
  }

  const result = new Map<string, ListingRatingAndSoldMetrics>();
  for (const entry of input.entries) {
    const listingSummary = computeRatingSummary(listingRevs.get(entry.listingId) ?? []);
    const shopSummary = computeRatingSummary(sellerRevs.get(entry.sellerId) ?? []);

    let effectiveRating: number | null = null;
    let effectiveReviewCount = 0;
    let ratingSource: ListingRatingSource = "none";

    if (listingSummary.totalReviews > 0 && listingSummary.averageRating !== null) {
      effectiveRating = listingSummary.averageRating;
      effectiveReviewCount = listingSummary.totalReviews;
      ratingSource = "listing";
    } else if (shopSummary.totalReviews > 0 && shopSummary.averageRating !== null) {
      effectiveRating = shopSummary.averageRating;
      effectiveReviewCount = shopSummary.totalReviews;
      ratingSource = "shop";
    }

    result.set(entry.listingId, {
      listingRatingSummary: listingSummary,
      shopRatingSummary: shopSummary,
      effectiveRating,
      effectiveReviewCount,
      ratingSource,
      totalSold: totalSoldByListing.get(entry.listingId) ?? 0,
    });
  }

  return result;
}

export type SupabaseLikeClient = SupabaseClient;

/**
 * Loads accurate listing ratings, weighted shop fallback ratings, and verified completed
 * unit counts for batches of listings across Homepage, Marketplace, Search, Services,
 * Favourites, and Listing Detail.
 */
export async function loadListingRatingAndSoldMap(
  service: SupabaseLikeClient,
  entries: Array<{ listingId: string; sellerId: string }>
): Promise<Map<string, ListingRatingAndSoldMetrics>> {
  const listingIds = Array.from(new Set(entries.map((e) => e.listingId).filter(Boolean)));
  const sellerIds = Array.from(new Set(entries.map((e) => e.sellerId).filter(Boolean)));

  if (listingIds.length === 0) return new Map();

  const [revRes, itemsRes, legacySrRes] = await Promise.all([
    sellerIds.length > 0
      ? service
          .from("reviews")
          .select("listing_id,seller_id,rating,hidden")
          .in("seller_id", sellerIds)
          .eq("hidden", false)
      : Promise.resolve({ data: [], error: null }),
    service
      .from("order_items")
      .select("listing_id,order_id,quantity,orders!inner(id,status,paid_at,checkout_session_id)")
      .in("listing_id", listingIds)
      .eq("orders.status", "completed"),
    service
      .from("service_requests")
      .select("listing_id,status")
      .in("listing_id", listingIds)
      .eq("status", "completed"),
  ]);

  const rawItems = (itemsRes.data ?? []) as Array<{
    listing_id: string | null;
    order_id: string;
    quantity: number | null;
    orders:
      | { id: string; status: string; paid_at: string | null; checkout_session_id: string | null }
      | Array<{ id: string; status: string; paid_at: string | null; checkout_session_id: string | null }>;
  }>;

  const orderIds = Array.from(new Set(rawItems.map((it) => it.order_id)));
  const sessionIds = Array.from(
    new Set(
      rawItems
        .map((it) => {
          const ord = Array.isArray(it.orders) ? it.orders[0] : it.orders;
          return ord?.checkout_session_id ?? null;
        })
        .filter((id): id is string => Boolean(id))
    )
  );
  const legacyOrderIds = Array.from(
    new Set(
      rawItems
        .filter((it) => {
          const ord = Array.isArray(it.orders) ? it.orders[0] : it.orders;
          return Boolean(ord && !ord.checkout_session_id);
        })
        .map((it) => it.order_id)
    )
  );

  const [refundsRes, sessionsRes, paymentsRes] = await Promise.all([
    orderIds.length > 0
      ? service
          .from("order_refunds")
          .select("order_id,refund_type,status")
          .in("order_id", orderIds)
          .eq("refund_type", "full_refund")
          .eq("status", "succeeded")
      : Promise.resolve({ data: [] }),
    sessionIds.length > 0
      ? service
          .from("checkout_sessions")
          .select("id,status,payment_status,paid_at")
          .in("id", sessionIds)
      : Promise.resolve({ data: [] }),
    legacyOrderIds.length > 0
      ? service
          .from("payments")
          .select("order_id,status,verified_at")
          .in("order_id", legacyOrderIds)
          .eq("status", "paid")
      : Promise.resolve({ data: [] }),
  ]);

  const fullRefundOrderIds = new Set(
    ((refundsRes.data ?? []) as Array<{ order_id: string }>).map((r) => r.order_id)
  );
  const verifiedSessionIds = new Set(
    ((sessionsRes.data ?? []) as Array<{
      id: string;
      status: string;
      payment_status: string;
      paid_at: string | null;
    }>)
      .filter((cs) => cs.status === "paid" && cs.payment_status === "paid" && Boolean(cs.paid_at))
      .map((cs) => cs.id)
  );
  const verifiedLegacyOrderIds = new Set(
    ((paymentsRes.data ?? []) as Array<{ order_id: string; verified_at: string | null }>)
      .filter((p) => Boolean(p.verified_at))
      .map((p) => p.order_id)
  );

  const completedOrderItems = rawItems
    .map((it) => {
      const ord = Array.isArray(it.orders) ? it.orders[0] : it.orders;
      if (!ord) return null;
      return {
        listing_id: it.listing_id,
        order_id: it.order_id,
        quantity: it.quantity,
        order_status: ord.status,
        paid_at: ord.paid_at,
        checkout_session_id: ord.checkout_session_id,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return computeListingRatingAndSoldMap({
    entries,
    reviews: ((revRes.data ?? []) as Array<{
      listing_id: string | null;
      seller_id: string;
      rating: number;
      hidden?: boolean | null;
    }>),
    completedOrderItems,
    verifiedSessionIds,
    verifiedLegacyOrderIds,
    fullRefundOrderIds,
    completedServiceRequests: (legacySrRes.data ?? []) as Array<{
      listing_id: string | null;
      status: string;
    }>,
  });
}

export interface ItemRepurchaseState {
  status: "available" | "variant_unavailable" | "listing_unavailable";
  buttonLabel: "Buy Again" | "Book Again" | "Product Unavailable" | "Service Unavailable";
  href: string | null;
  reason?: string;
}

export interface RepurchaseListingRecord {
  id: string;
  seller_id: string;
  kind: string;
  status: string;
  has_variants: boolean | null;
  quantity: number | null;
  reserved_quantity: number | null;
  accepting_requests: boolean | null;
}

export interface RepurchaseVariantRecord {
  id: string;
  listing_id: string;
  active: boolean;
  quantity: number;
  reserved_quantity: number;
}

/**
 * Pure evaluator for live Buy Again / Book Again availability.
 * Never silently substitutes another variation.
 */
export function evaluateRepurchaseAvailability(input: {
  buyerUserId: string | null;
  item: {
    listingId: string | null;
    variantId: string | null;
    variantLabel: string | null;
    isService: boolean;
  };
  listing: RepurchaseListingRecord | null;
  variants: RepurchaseVariantRecord[];
}): ItemRepurchaseState {
  const { item, listing, variants } = input;
  const unavailableLabel = item.isService ? "Service Unavailable" : "Product Unavailable";
  const activeLabel = item.isService ? "Book Again" : "Buy Again";

  if (!item.listingId || !listing || listing.status !== "published") {
    return {
      status: "listing_unavailable",
      buttonLabel: unavailableLabel,
      href: null,
      reason: item.isService
        ? "This service is no longer published or has been removed."
        : "This product is no longer published or has been removed.",
    };
  }

  if (input.buyerUserId && listing.seller_id === input.buyerUserId) {
    return {
      status: "listing_unavailable",
      buttonLabel: unavailableLabel,
      href: null,
      reason: "Sellers cannot repurchase their own listing.",
    };
  }

  const listingIsService = listing.kind === "service";
  if (listingIsService) {
    if (listing.accepting_requests === false) {
      return {
        status: "listing_unavailable",
        buttonLabel: "Service Unavailable",
        href: null,
        reason: "The provider has paused new requests for this service.",
      };
    }
    return {
      status: "available",
      buttonLabel: "Book Again",
      href: `/listings/${encodeURIComponent(listing.id)}`,
    };
  }

  if (listing.has_variants) {
    const activeInStockVariants = variants.filter(
      (v) => v.active && v.quantity - Math.max(0, v.reserved_quantity) > 0
    );
    if (activeInStockVariants.length === 0) {
      return {
        status: "listing_unavailable",
        buttonLabel: "Product Unavailable",
        href: null,
        reason: "All variations are currently sold out.",
      };
    }
    if (item.variantId) {
      const exact = activeInStockVariants.find((v) => v.id === item.variantId);
      if (exact) {
        return {
          status: "available",
          buttonLabel: "Buy Again",
          href: `/listings/${encodeURIComponent(listing.id)}?variant=${encodeURIComponent(exact.id)}`,
        };
      }
      const prevParams = item.variantLabel
        ? `?prevVariant=${encodeURIComponent(item.variantLabel)}`
        : "?prevVariant=unavailable";
      return {
        status: "variant_unavailable",
        buttonLabel: "Buy Again",
        href: `/listings/${encodeURIComponent(listing.id)}${prevParams}`,
        reason: item.variantLabel
          ? `Your previous variation (${item.variantLabel}) is unavailable. Choose another option.`
          : "Your previous variation is unavailable. Choose another option.",
      };
    }
    return {
      status: "available",
      buttonLabel: activeLabel,
      href: `/listings/${encodeURIComponent(listing.id)}`,
    };
  }

  const availableStock = Math.max(
    0,
    Number(listing.quantity ?? 0) - Math.max(0, Number(listing.reserved_quantity ?? 0))
  );
  if (availableStock <= 0) {
    return {
      status: "listing_unavailable",
      buttonLabel: "Product Unavailable",
      href: null,
      reason: "Currently out of stock.",
    };
  }

  return {
    status: "available",
    buttonLabel: activeLabel,
    href: `/listings/${encodeURIComponent(listing.id)}`,
  };
}
