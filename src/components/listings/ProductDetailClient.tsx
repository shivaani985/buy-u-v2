"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowRight,
  Calendar,
  Check,
  ChevronLeft,
  ChevronRight,
  Flag,
  Heart,
  MapPin,
  MessageCircle,
  Minus,
  Package,
  Pencil,
  Plus,
  Share2,
  ShieldCheck,
  ShoppingCart,
  Star,
  Tag,
  Utensils,
  X,
  ZoomIn,
} from "lucide-react";
import {
  addToCartAction,
  toggleFavouriteAction,
  type AddToCartActionState,
} from "@/app/listings/actions";
import { startConversationAction } from "@/app/messages/actions";
import {
  editVerifiedReviewAction,
  submitReportAction,
  submitVerifiedReviewAction,
} from "@/app/marketplace-actions";
import { ReviewCard } from "@/components/reviews/ReviewCard";
import { ReviewDialog } from "@/components/reviews/ReviewDialog";
import { ListingImage } from "@/components/shared/ListingImage";
import type { ProductDetail } from "@/lib/buyer/data";
import type { BuyerEligibilityResult } from "@/lib/buyer/validation";
import {
  formatListingType,
  formatSenToRm,
  formatShortDate,
} from "@/lib/format";
import {
  REPORT_REASONS,
} from "@/lib/marketplace/phase8";
import { isBargainingEligibleListing } from "@/lib/messages/offers";
import { formatServiceModeLabel } from "@/lib/orders/service-attachments";
import type {
  ListingRatingAndSoldMetrics,
  PublicReviewItem,
} from "@/lib/reviews/presentation";
import { REVIEW_STAR_COLOR } from "@/lib/reviews/validation";
import {
  formatVariationOptionLabel,
  resolveBuyerVariationState,
} from "@/lib/seller/variations";

export interface WriteReviewOrderContext {
  orderId: string;
  orderCode: string;
  listingId: string;
  itemTitle: string;
  variantLabel: string | null;
  imageUrl: string | null;
  isService: boolean;
}

interface ProductDetailClientProps {
  product: ProductDetail;
  buyerEligibility: BuyerEligibilityResult;
  ratingMetrics: ListingRatingAndSoldMetrics;
  listingReviews: PublicReviewItem[];
  preselectedVariantId?: string | null;
  prevVariantLabel?: string | null;
  writeReviewOrder?: WriteReviewOrderContext | null;
}

type DetailTab = "overview" | "reviews";

const INITIAL_CART_STATE: AddToCartActionState = { status: "idle" };

function formatDateTime(iso: string | null): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat("en-MY", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function formatAvailabilityMode(mode: string | null): string | null {
  if (!mode) return null;
  if (mode === "ready_now") return "Ready Now";
  if (mode === "pre_order") return "Pre-Order";
  return mode.replace(/_/g, " ");
}

function getInitials(name: string): string {
  const [first, second] = name.trim().split(/\s+/).filter(Boolean);
  if (!first) return "BU";
  if (!second) return first.slice(0, 2).toUpperCase();
  return `${first.charAt(0)}${second.charAt(0)}`.toUpperCase();
}

export function ProductDetailClient({
  product,
  buyerEligibility,
  ratingMetrics,
  listingReviews,
  preselectedVariantId = null,
  prevVariantLabel = null,
  writeReviewOrder = null,
}: ProductDetailClientProps) {
  const router = useRouter();
  const initialPreselectedVariant =
    preselectedVariantId && product.hasVariants
      ? product.variants.find(
          (v) => v.id === preselectedVariantId && v.active && v.availableStock > 0
        ) ?? null
      : null;

  const [activePhotoIndex, setActivePhotoIndex] = useState<number>(() => {
    if (initialPreselectedVariant?.imageUrl) {
      const photosInit = [...product.imageUrls];
      for (const v of product.variants) {
        if (v.imageUrl && !photosInit.includes(v.imageUrl)) photosInit.push(v.imageUrl);
      }
      const idx = photosInit.indexOf(initialPreselectedVariant.imageUrl);
      if (idx >= 0) return idx;
    }
    return 0;
  });
  const [zoomOpen, setZoomOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<DetailTab>("overview");
  const [copiedShare, setCopiedShare] = useState(false);
  const [reviewModalMode, setReviewModalMode] = useState<
    { type: "create" } | { type: "edit"; review: PublicReviewItem } | null
  >(null);
  const [reviewActionBusy, setReviewActionBusy] = useState(false);
  const [reviewActionError, setReviewActionError] = useState<string | null>(null);
  const [reviewSuccessNotice, setReviewSuccessNotice] = useState<string | null>(null);

  const [selectedOptions, setSelectedOptions] = useState<
    Record<string, string | null>
  >(() =>
    initialPreselectedVariant ? { ...initialPreselectedVariant.optionValues } : {}
  );
  const showUnavailablePrevVariantBanner = Boolean(
    (preselectedVariantId && !initialPreselectedVariant && product.hasVariants) ||
      (prevVariantLabel && product.hasVariants)
  );
  const [quantity, setQuantity] = useState(1);

  const [isFavourited, setIsFavourited] = useState(product.isFavourited);
  const [favBurstKey, setFavBurstKey] = useState(0);
  const [favFeedback, setFavFeedback] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [isFavPending, startFavTransition] = useTransition();
  const [chatError, setChatError] = useState<string | null>(null);
  const [isChatPending, startChatTransition] = useTransition();
  const [isBargainPending, startBargainTransition] = useTransition();
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState<string>(REPORT_REASONS[0]);
  const [reportDetails, setReportDetails] = useState("");
  const [reportResult, setReportResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [isReportPending, startReportTransition] = useTransition();

  const [cartState, cartFormAction, isCartPending] = useActionState(
    addToCartAction,
    INITIAL_CART_STATE
  );

  useEffect(() => {
    if (cartState.status === "success") {
      router.refresh();
    }
  }, [cartState, router]);

  const variationState =
    product.hasVariants && product.variants.length > 0
      ? resolveBuyerVariationState({
          optionGroups: product.optionGroups,
          variants: product.variants,
          selectedOptions,
          variationPhotoGroup: product.variationPhotoGroup,
          fallbackPriceSen: product.priceSen,
        })
      : null;

  const activeVariant = product.hasVariants
    ? variationState?.resolvedVariant
      ? product.variants.find((v) => v.id === variationState.resolvedVariant!.id) ??
        null
      : null
    : null;

  const activePriceSen = activeVariant
    ? activeVariant.priceSen
    : variationState
      ? variationState.priceDisplay.minSen
      : product.priceSen;

  const isPhysicalProduct =
    product.kind === "pre_loved" || product.kind === "business";
  const isService = product.kind === "service";
  const isServicePaused = isService && product.acceptingRequests === false;
  const isPurchasable = isPhysicalProduct || isService;
  const isPublished = product.status === "published";

  const activeAvailableStock = isService
    ? isServicePaused
      ? 0
      : 99
    : !isPhysicalProduct
      ? null
      : product.hasVariants
        ? activeVariant
          ? activeVariant.availableStock
          : product.availableStock ?? 0
        : Math.max(0, product.quantity - Math.max(0, product.reservedQuantity));

  const activeCartKey = product.hasVariants
    ? activeVariant?.id ?? "none"
    : "default";
  const inCartForSelection =
    cartState.status === "success" &&
    cartState.variantKey === activeCartKey &&
    typeof cartState.nextQuantity === "number"
      ? Math.max(
          product.cartQuantities[activeCartKey] ?? 0,
          cartState.nextQuantity
        )
      : product.cartQuantities[activeCartKey] ?? 0;

  const maxAddable =
    activeAvailableStock === null
      ? 0
      : product.hasVariants && !activeVariant
        ? 0
        : Math.max(0, activeAvailableStock - inCartForSelection);

  const clampedQuantity =
    maxAddable > 0 ? Math.min(Math.max(1, quantity), maxAddable) : 1;

  const canFavourite =
    !product.isDemo &&
    !product.isFreeNotice &&
    buyerEligibility.eligible &&
    (isPublished || isFavourited);

  const canAddToCart =
    !product.isDemo &&
    !product.isFreeNotice &&
    isPurchasable &&
    !isServicePaused &&
    isPublished &&
    !product.isOwner &&
    buyerEligibility.eligible &&
    (!product.hasVariants || Boolean(activeVariant && activeVariant.active)) &&
    maxAddable > 0;

  // Merge cover/gallery photos with any unique variant photos for smooth switching
  const photos = [...product.imageUrls];
  for (const v of product.variants) {
    if (v.imageUrl && !photos.includes(v.imageUrl)) {
      photos.push(v.imageUrl);
    }
  }
  const safePhotoIndex =
    photos.length > 0 ? Math.min(activePhotoIndex, photos.length - 1) : 0;
  const activePhotoUrl = photos[safePhotoIndex] ?? null;

  function syncPhotoWithVariationSelection(nextOptions: Record<string, string | null>) {
    if (!product.hasVariants || product.variants.length === 0) return;
    const nextState = resolveBuyerVariationState({
      optionGroups: product.optionGroups,
      variants: product.variants,
      selectedOptions: nextOptions,
      variationPhotoGroup: product.variationPhotoGroup,
      fallbackPriceSen: product.priceSen,
    });
    if (nextState.activeImageUrl) {
      const idx = photos.indexOf(nextState.activeImageUrl);
      if (idx >= 0) setActivePhotoIndex(idx);
    } else {
      setActivePhotoIndex(0);
    }
  }

  function handleSelectOption(groupName: string, optionValue: string) {
    const current = selectedOptions[groupName] ?? null;
    const isSame =
      current !== null &&
      current.toLowerCase() === optionValue.trim().toLowerCase();
    const nextOptions: Record<string, string | null> = {
      ...selectedOptions,
      [groupName]: isSame ? null : optionValue,
    };
    setSelectedOptions(nextOptions);
    setQuantity(1);
    syncPhotoWithVariationSelection(nextOptions);
  }

  function handleClearVariations() {
    setSelectedOptions({});
    setQuantity(1);
    setActivePhotoIndex(0);
  }

  function handleToggleFavourite() {
    if (!canFavourite || isFavPending) return;
    setFavFeedback(null);
    const nextFav = !isFavourited;
    if (nextFav) {
      setFavBurstKey((k) => k + 1);
    }
    startFavTransition(async () => {
      const result = await toggleFavouriteAction(product.id);
      if (result.ok && typeof result.isFavourited === "boolean") {
        setIsFavourited(result.isFavourited);
        setFavFeedback({
          type: "success",
          text:
            result.message ??
            (result.isFavourited
              ? "Saved to Favourites."
              : "Removed from Favourites."),
        });
      } else {
        setFavFeedback({
          type: "error",
          text: result.error ?? "Could not update Favourites.",
        });
      }
    });
  }

  async function handleShare() {
    const shareUrl = typeof window !== "undefined" ? window.location.href : "";
    if (!shareUrl) return;
    try {
      if (navigator.share) {
        await navigator.share({
          title: product.title,
          text: `Check out ${product.title} on Buy-U UMSKAL`,
          url: shareUrl,
        });
        return;
      }
      await navigator.clipboard.writeText(shareUrl);
      setCopiedShare(true);
      setTimeout(() => setCopiedShare(false), 2000);
    } catch {
      // Fallback if share cancelled or clipboard unavailable
    }
  }

  let stockStatusText = "Available";
  let stockPillClasses = "bg-[#EDFAF9] text-[#008285]";
  if (!isPublished) {
    stockStatusText =
      product.status === "archived"
        ? "Archived"
        : product.status === "draft"
          ? "Draft"
          : "Unavailable";
    stockPillClasses = "bg-[#FEF2F2] text-[#B42318]";
  } else if (product.listingType === "service") {
    stockStatusText =
      product.acceptingRequests === false
        ? "Paused"
        : "Available for Purchase";
    stockPillClasses =
      product.acceptingRequests === false
        ? "bg-[#FEF2F2] text-[#B42318]"
        : "bg-[#EDFAF9] text-[#008285]";
  } else if (product.listingType === "free") {
    stockStatusText = "Free Campus Giveaway";
    stockPillClasses = "bg-[#EDF5FC] text-[#1D70B8]";
  } else if (activeAvailableStock !== null && activeAvailableStock <= 0) {
    stockStatusText = "Out of Stock";
    stockPillClasses = "bg-[#FEF2F2] text-[#B42318]";
  } else if (activeAvailableStock !== null) {
    stockStatusText = `${activeAvailableStock} available`;
    stockPillClasses = "bg-[#EDFAF9] text-[#008285]";
  }

  const fallbackFrame = (
    <div className="flex h-full w-full flex-col justify-between bg-[#F4F1FA] p-6">
      <div className="flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wider">
        <span className="text-[#4E2A84]">
          {formatListingType(product.listingType)}
        </span>
        <span className="text-[#6B6779]">{product.categoryName}</span>
      </div>
      <div>
        <p className="font-editorial text-2xl font-bold italic text-[#14121A] sm:text-3xl">
          {product.title}
        </p>
        <p className="mt-2 text-xs font-medium text-[#6B6779]">
          No photo uploaded for this listing yet
        </p>
      </div>
    </div>
  );

  const storefrontTitle = product.seller.shopName || product.seller.displayName;
  const marketplaceHref = product.isDemo
    ? "/marketplace?demo=1"
    : "/marketplace";

  return (
    <div className="pb-16 md:pb-4">
      {/* 1. Breadcrumb + Share Row */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <nav
          aria-label="Breadcrumb"
          className="flex min-w-0 items-center gap-1.5 text-xs sm:text-sm text-[#6B6779]"
        >
          <Link
            href={marketplaceHref}
            className="font-semibold text-[#555062] transition-colors hover:text-[#4E2A84]"
          >
            Marketplace
          </Link>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#A59FB5]" aria-hidden="true" />
          <span className="shrink-0 font-medium text-[#555062]">
            {product.categoryName}
          </span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#A59FB5]" aria-hidden="true" />
          <span className="truncate font-semibold text-[#14121A]">
            {product.title}
          </span>
        </nav>

        <div className="flex items-center gap-2">
          {product.isDemo ? (
            <span className="rounded-full bg-[#EDF5FC] px-2.5 py-1 text-[11px] font-bold text-[#1D70B8]">
              Demo Preview
            </span>
          ) : null}
          <button
            type="button"
            onClick={handleShare}
            className="press-feedback inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-[#E6E3EE] bg-white px-3 py-1.5 text-xs font-semibold text-[#14121A] shadow-2xs transition-colors hover:border-[#4E2A84]/40 hover:bg-[#FAF8FD]"
          >
            {copiedShare ? (
              <>
                <Check className="h-3.5 w-3.5 text-[#008285]" aria-hidden="true" />
                <span className="text-[#008285]">Copied!</span>
              </>
            ) : (
              <>
                <Share2 className="h-3.5 w-3.5 text-[#4E2A84]" aria-hidden="true" />
                <span>Share</span>
              </>
            )}
          </button>

          {!product.isOwner && !product.isDemo ? (
            <button
              type="button"
              onClick={() => {
                if (!buyerEligibility.eligible) {
                  router.push("/login");
                  return;
                }
                setReportResult(null);
                setReportOpen(true);
              }}
              className="press-feedback inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-[#E6E3EE] bg-white px-3 py-1.5 text-xs font-semibold text-[#6B6779] shadow-2xs transition-colors hover:border-[#BA1A1A]/40 hover:bg-[#FEF2F2] hover:text-[#BA1A1A]"
            >
              <Flag className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Report</span>
            </button>
          ) : null}
        </div>
      </div>

      {/* 2. Unified Hero Card (5/7 Split — Zero Empty Gaps) */}
      <section className="rounded-[24px] border border-[#E6E3EE] bg-[#FAF9FC] p-4 shadow-[0_4px_24px_rgba(20,18,26,0.04)] sm:p-6">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:items-start lg:gap-7">
          {/* Left 5 cols: Photo Carousel & Thumbnails */}
          <div className="lg:col-span-5">
            <div className="group relative aspect-[4/3] w-full overflow-hidden rounded-2xl border border-[#ECEAF3] bg-white shadow-xs">
              <ListingImage
                src={activePhotoUrl}
                alt={`${product.imageAlt}${photos.length > 1 ? ` — photo ${safePhotoIndex + 1} of ${photos.length}` : ""}`}
                fallback={fallbackFrame}
              />

              {/* Top-left Condition / Out of Stock / Paused Pill */}
              {isServicePaused ? (
                <span className="absolute left-3 top-3 rounded-lg bg-[#BA1A1A] px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-white shadow-xs">
                  Paused
                </span>
              ) : !isService && activeAvailableStock !== null && activeAvailableStock <= 0 ? (
                <span className="absolute left-3 top-3 rounded-lg bg-[#BA1A1A] px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-white shadow-xs">
                  Out of stock
                </span>
              ) : product.condition ? (
                <span className="absolute left-3 top-3 rounded-lg border border-white/40 bg-white/90 px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-wide text-[#4E2A84] shadow-xs backdrop-blur-xs">
                  {product.condition}
                </span>
              ) : null}

              {/* Click-to-zoom button */}
              {activePhotoUrl ? (
                <button
                  type="button"
                  onClick={() => setZoomOpen(true)}
                  aria-label="Zoom product photo"
                  className="press-feedback absolute right-3 top-3 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border border-white/40 bg-white/85 text-[#14121A] opacity-90 shadow-xs backdrop-blur-xs transition hover:bg-white hover:text-[#4E2A84] group-hover:opacity-100"
                >
                  <ZoomIn className="h-4 w-4" aria-hidden="true" />
                </button>
              ) : null}

              {photos.length > 1 ? (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      setActivePhotoIndex((i) =>
                        i === 0 ? photos.length - 1 : i - 1
                      )
                    }
                    aria-label="Previous photo"
                    className="absolute left-3 top-1/2 flex h-9 w-9 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-[#E6E3EE] bg-white/95 text-[#14121A] shadow-sm transition hover:border-[#4E2A84] hover:text-[#4E2A84] active:scale-95"
                  >
                    <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setActivePhotoIndex((i) =>
                        i === photos.length - 1 ? 0 : i + 1
                      )
                    }
                    aria-label="Next photo"
                    className="absolute right-3 top-1/2 flex h-9 w-9 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-[#E6E3EE] bg-white/95 text-[#14121A] shadow-sm transition hover:border-[#4E2A84] hover:text-[#4E2A84] active:scale-95"
                  >
                    <ChevronRight className="h-4 w-4" aria-hidden="true" />
                  </button>
                </>
              ) : null}
            </div>

            {/* Thumbnail Strip */}
            {photos.length > 1 ? (
              <div className="mt-3 flex justify-center gap-2.5 overflow-x-auto py-1">
                {photos.map((url, idx) => {
                  const isSelected = idx === safePhotoIndex;
                  return (
                    <button
                      key={`${url}-${idx}`}
                      type="button"
                      onClick={() => setActivePhotoIndex(idx)}
                      aria-label={`View photo ${idx + 1}`}
                      aria-current={isSelected ? "true" : undefined}
                      className={`relative h-14 w-14 shrink-0 cursor-pointer overflow-hidden rounded-xl border-2 transition-all duration-150 hover:scale-105 ${
                        isSelected
                          ? "border-[#4E2A84] shadow-sm"
                          : "border-[#E6E3EE] opacity-75 hover:opacity-100"
                      }`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={url}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>

          {/* Right 7 cols: Purchase Box + Seller Quick-Bar */}
          <div className="flex flex-col space-y-4 lg:col-span-7">
            <div>
              {/* Top Row: Type/Category Pill + Circular Heart Favourite Button */}
              <div className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center rounded-full bg-[#F4F1FA] px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-[#4E2A84]">
                  {formatListingType(product.listingType)} · {product.categoryName}
                </span>

                {!product.isFreeNotice ? (
                  <button
                    type="button"
                    onClick={handleToggleFavourite}
                    disabled={!canFavourite || isFavPending}
                    aria-label={
                      isFavourited
                        ? "Remove from favourites"
                        : "Add to favourites"
                    }
                    aria-pressed={isFavourited}
                    className="relative flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full border border-[#E6E3EE] bg-white shadow-2xs transition-all duration-150 hover:scale-105 hover:border-[#4E2A84]/40 active:scale-90 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {favBurstKey > 0 && isFavourited ? (
                      <span
                        key={`ring-${favBurstKey}`}
                        className="anim-fav-ring pointer-events-none absolute inset-0 rounded-full border-2 border-[#E11D48]"
                        aria-hidden="true"
                      />
                    ) : null}
                    <Heart
                      key={
                        favBurstKey > 0 && isFavourited
                          ? `heart-${favBurstKey}`
                          : "heart-idle"
                      }
                      className={`h-5 w-5 transition-colors ${
                        isFavourited
                          ? "anim-fav-pop fill-[#E11D48] text-[#E11D48]"
                          : "text-[#4A4656] hover:text-[#E11D48]"
                      }`}
                      aria-hidden="true"
                    />
                  </button>
                ) : null}
              </div>

              {/* Title */}
              <h1 className="mt-3 text-2xl font-extrabold leading-tight tracking-tight text-[#14121A] sm:text-[28px]">
                {product.title}
              </h1>

              {/* Price & Availability Row */}
              <div className="mt-2.5 flex flex-wrap items-center justify-between gap-3">
                <p className="tabular-price text-2xl font-extrabold tracking-tight text-[#4E2A84] sm:text-3xl">
                  {variationState && !variationState.priceDisplay.isExact
                    ? `${formatSenToRm(variationState.priceDisplay.minSen)} – ${formatSenToRm(variationState.priceDisplay.maxSen)}`
                    : formatSenToRm(activePriceSen)}
                </p>
                <span
                  className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-bold ${stockPillClasses}`}
                >
                  {stockStatusText}
                </span>
              </div>

              {/* Phase 10R: Listing Rating / Shop Rating Fallback + Total Sold */}
              {!product.isFreeNotice ? (
                <div className="mt-2.5 flex flex-wrap items-center gap-2 text-xs font-semibold text-[#555062]">
                  <button
                    type="button"
                    onClick={() => {
                      setActiveTab("reviews");
                      document.getElementById("listing-reviews-panel")?.scrollIntoView({ behavior: "smooth" });
                    }}
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#ECEAF2] bg-[#FAF9FC] px-2.5 py-1 transition-colors hover:border-[#4E2A84]/40"
                  >
                    <Star
                      className="h-3.5 w-3.5 shrink-0"
                      style={
                        ratingMetrics.effectiveRating !== null
                          ? { color: REVIEW_STAR_COLOR, fill: REVIEW_STAR_COLOR }
                          : { color: "#C5C1D0" }
                      }
                      aria-hidden="true"
                    />
                    {ratingMetrics.effectiveRating !== null ? (
                      <>
                        <span className="font-extrabold text-[#14121A]">
                          {ratingMetrics.effectiveRating.toFixed(1)}
                        </span>
                        {ratingMetrics.ratingSource === "shop" ? (
                          <span className="rounded bg-[#F4F1FA] px-1.5 py-0.5 text-[10px] font-bold text-[#4E2A84]">
                            Shop Rating
                          </span>
                        ) : (
                          <span className="text-[#6B6779]">
                            ({ratingMetrics.effectiveReviewCount}{" "}
                            {ratingMetrics.effectiveReviewCount === 1 ? "review" : "reviews"})
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-[#6B6779]">Not rated yet</span>
                    )}
                  </button>

                  <span className="inline-flex items-center rounded-lg border border-[#ECEAF2] bg-white px-2.5 py-1 font-bold text-[#14121A]">
                    {ratingMetrics.totalSold}{" "}
                    {isService ? "completed" : "sold"}
                  </span>
                </div>
              ) : null}

              {/* Quick Handover & Spec Chips */}
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[#4A4656]">
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-[#E6E3EE] bg-white px-2.5 py-1 font-medium">
                  <MapPin className="h-3.5 w-3.5 text-[#008285]" aria-hidden="true" />
                  <span>{product.campusArea}</span>
                </span>
                {isService && product.serviceMode ? (
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-[#D8CEEE] bg-[#F6F2FC] px-2.5 py-1 font-semibold text-[#4E2A84]">
                    <span>{formatServiceModeLabel(product.serviceMode)}</span>
                  </span>
                ) : null}
                {product.condition ? (
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-[#E6E3EE] bg-white px-2.5 py-1 font-medium">
                    <Tag className="h-3.5 w-3.5 text-[#4E2A84]" aria-hidden="true" />
                    <span>{product.condition}</span>
                  </span>
                ) : null}
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-[#E6E3EE] bg-white px-2.5 py-1 font-medium">
                  <Calendar className="h-3.5 w-3.5 text-[#008285]" aria-hidden="true" />
                  <span>Posted {formatShortDate(product.createdAt)}</span>
                </span>
              </div>

              {/* Variations Selector */}
              {showUnavailablePrevVariantBanner ? (
                <div
                  role="status"
                  className="mt-4 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-xs font-semibold text-amber-950"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
                  <span>
                    Your previously purchased variation
                    {prevVariantLabel && prevVariantLabel !== "unavailable"
                      ? ` (${prevVariantLabel})`
                      : ""}{" "}
                    is currently unavailable. Select an available option below.
                  </span>
                </div>
              ) : null}
              {variationState && variationState.groups.length > 0 ? (
                <div className="mt-4 space-y-3 rounded-2xl border border-[#ECEAF2] bg-[#FAF9FC] p-3.5 sm:p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-extrabold uppercase tracking-wide text-[#4E2A84]">
                      Choose Variation
                    </span>
                    {Object.values(selectedOptions).some(Boolean) ? (
                      <button
                        type="button"
                        onClick={handleClearVariations}
                        className="cursor-pointer text-[11px] font-bold text-[#6B6779] underline-offset-2 transition-colors hover:text-[#4E2A84] hover:underline"
                      >
                        Clear selection
                      </button>
                    ) : null}
                  </div>

                  {variationState.groups.map((group) => {
                    const selectedVal = group.options.find(
                      (o) => o.selected
                    )?.value;
                    return (
                      <div key={group.groupName} className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="font-bold text-[#14121A]">
                            {group.groupName}
                          </span>
                          <span className="font-semibold text-[#6B6779]">
                            {selectedVal ?? "Select"}
                          </span>
                        </div>

                        {group.hasThumbnails ? (
                          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                            {group.options.map((opt) => {
                              const isSingleSoldOut =
                                variationState.groups.length === 1 &&
                                opt.availableStock <= 0;
                              return (
                                <button
                                  key={opt.value}
                                  type="button"
                                  disabled={!opt.enabled}
                                  onClick={() =>
                                    handleSelectOption(
                                      group.groupName,
                                      opt.value
                                    )
                                  }
                                  aria-pressed={opt.selected}
                                  className={`press-feedback flex items-center gap-2 rounded-xl border px-2.5 py-2 text-left transition-all duration-150 motion-reduce:transition-none ${
                                    opt.selected
                                      ? "border-[#4E2A84] bg-white shadow-xs ring-2 ring-[#4E2A84]/15"
                                      : opt.enabled
                                        ? "cursor-pointer border-[#E6E3EE] bg-white hover:border-[#9E97B0]"
                                        : "cursor-not-allowed border-dashed border-[#E6E3EE] bg-[#F4F3F8] opacity-45"
                                  } ${isSingleSoldOut && !opt.selected ? "opacity-65" : ""}`}
                                >
                                  {opt.imageUrl ? (
                                    /* eslint-disable-next-line @next/next/no-img-element */
                                    <img
                                      src={opt.imageUrl}
                                      alt=""
                                      className="h-9 w-9 shrink-0 rounded-lg border border-[#E6E3EE] object-cover"
                                    />
                                  ) : (
                                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#E6E3EE] bg-[#F5F4F8] text-[10px] font-bold text-[#858094]">
                                      {opt.value.slice(0, 2).toUpperCase()}
                                    </span>
                                  )}
                                  <span className="min-w-0 flex-1">
                                    <span
                                      className={`block truncate text-xs font-bold ${
                                        opt.selected
                                          ? "text-[#4E2A84]"
                                          : "text-[#14121A]"
                                      }`}
                                    >
                                      {opt.value}
                                    </span>
                                    <span
                                      className={`block text-[10px] font-semibold ${
                                        opt.availableStock <= 0
                                          ? "text-[#B42318]"
                                          : "text-[#6B6779]"
                                      }`}
                                    >
                                      {opt.availableStock <= 0
                                        ? "Sold Out"
                                        : `${opt.availableStock} left`}
                                    </span>
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            {group.options.map((opt) => {
                              const isSingleSoldOut =
                                variationState.groups.length === 1 &&
                                opt.availableStock <= 0;
                              return (
                                <button
                                  key={opt.value}
                                  type="button"
                                  disabled={!opt.enabled}
                                  onClick={() =>
                                    handleSelectOption(
                                      group.groupName,
                                      opt.value
                                    )
                                  }
                                  aria-pressed={opt.selected}
                                  className={`press-feedback inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-bold transition-all duration-150 motion-reduce:transition-none sm:text-[13px] ${
                                    opt.selected
                                      ? "border-[#4E2A84] bg-[#4E2A84] text-white shadow-xs"
                                      : opt.enabled
                                        ? "cursor-pointer border-[#D9D4E3] bg-white text-[#14121A] hover:border-[#4E2A84] hover:text-[#4E2A84]"
                                        : "cursor-not-allowed border-dashed border-[#E2DFEC] bg-[#F4F3F8] text-[#858094] line-through opacity-50"
                                  } ${isSingleSoldOut && !opt.selected ? "opacity-65" : ""}`}
                                >
                                  <span>{opt.value}</span>
                                  {variationState.groups.length === 1 &&
                                  isSingleSoldOut ? (
                                    <span className="text-[10px] font-semibold opacity-80">
                                      (Sold Out)
                                    </span>
                                  ) : null}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {!variationState.isComplete &&
                  variationState.selectionPrompt ? (
                    <p className="rounded-lg border border-[#D8CEEE] bg-[#F4F1FA] px-3 py-1.5 text-xs font-semibold text-[#4E2A84]">
                      {variationState.selectionPrompt}
                    </p>
                  ) : activeVariant ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#E6E3EE] bg-white px-3 py-1.5 text-xs">
                      <span className="font-bold text-[#14121A]">
                        {formatVariationOptionLabel(activeVariant.optionValues)}
                      </span>
                      <span
                        className={`font-semibold ${
                          activeVariant.availableStock > 0
                            ? "text-[#008285]"
                            : "text-[#B42318]"
                        }`}
                      >
                        {activeVariant.availableStock > 0
                          ? `${activeVariant.availableStock} left · ${formatSenToRm(activeVariant.priceSen)}`
                          : "Sold Out"}
                      </span>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {/* Action Controls */}
              <div className="mt-5 space-y-2.5">
                {product.isOwner ? (
                  <div className="rounded-2xl border border-[#E6E3EE] bg-white p-4">
                    <p className="text-sm font-bold text-[#14121A]">
                      This is your listing
                    </p>
                    <p className="mt-1 text-xs text-[#6B6779]">
                      Manage stock, variants, or pricing from Seller Hub.
                    </p>
                    <Link
                      href={`/sell/${product.id}`}
                      className="press-feedback mt-3 inline-flex items-center gap-2 rounded-xl bg-[#4E2A84] px-4 py-2 text-xs font-bold text-white hover:bg-[#381C63]"
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Edit Listing</span>
                    </Link>
                  </div>
                ) : !isPublished ? (
                  <div className="flex items-start gap-2.5 rounded-2xl border border-[#E6E3EE] bg-white p-4 text-sm text-[#4A4656]">
                    <AlertCircle
                      className="mt-0.5 h-4 w-4 shrink-0 text-[#B42318]"
                      aria-hidden="true"
                    />
                    <p>
                      This listing is currently{" "}
                      <strong className="font-semibold text-[#14121A]">
                        {stockStatusText.toLowerCase()}
                      </strong>{" "}
                      and cannot be added to your cart.
                    </p>
                  </div>
                ) : !isPurchasable ? (
                  <div className="rounded-2xl border border-[#E6E3EE] bg-white p-4 text-xs sm:text-sm text-[#4A4656]">
                    Free campus items can be collected directly on a first-come, first-served basis.
                  </div>
                ) : isServicePaused ? (
                  <div className="flex items-start gap-2.5 rounded-2xl border border-[#F5C2C0] bg-[#FEF2F2] p-4 text-xs sm:text-sm text-[#991B1B]">
                    <AlertCircle
                      className="mt-0.5 h-4 w-4 shrink-0 text-[#B42318]"
                      aria-hidden="true"
                    />
                    <p>
                      This service is currently paused by the seller and cannot be added to your cart.
                    </p>
                  </div>
                ) : (
                  <form action={cartFormAction} className="space-y-2.5">
                    <input type="hidden" name="listingId" value={product.id} />
                    <input
                      type="hidden"
                      name="variantId"
                      value={activeVariant?.id ?? ""}
                    />
                    <input
                      type="hidden"
                      name="quantity"
                      value={String(clampedQuantity)}
                    />

                    <div className="flex items-center gap-2.5">
                      {/* Quantity Stepper */}
                      <div className="inline-flex h-11 items-center rounded-xl border border-[#D5D0E0] bg-white">
                        <button
                          type="button"
                          onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                          disabled={!canAddToCart || clampedQuantity <= 1}
                          aria-label="Decrease quantity"
                          className="flex h-10 w-10 cursor-pointer items-center justify-center text-[#14121A] transition hover:text-[#4E2A84] disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Minus className="h-4 w-4" aria-hidden="true" />
                        </button>
                        <span
                          className="min-w-[2rem] text-center text-sm font-bold text-[#14121A]"
                          aria-live="polite"
                        >
                          {clampedQuantity}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setQuantity((q) => Math.min(maxAddable, q + 1))
                          }
                          disabled={
                            !canAddToCart || clampedQuantity >= maxAddable
                          }
                          aria-label="Increase quantity"
                          className="flex h-10 w-10 cursor-pointer items-center justify-center text-[#14121A] transition hover:text-[#4E2A84] disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Plus className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </div>

                      {/* Primary Add to Cart CTA */}
                      <button
                        type="submit"
                        disabled={!canAddToCart || isCartPending}
                        className="press-feedback inline-flex h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl bg-[#4E2A84] px-4 text-sm font-bold text-white shadow-sm hover:bg-[#381C63] disabled:cursor-not-allowed disabled:bg-[#C9C4D6]"
                      >
                        <ShoppingCart className="h-4 w-4" aria-hidden="true" />
                        <span className="truncate">
                          {isCartPending
                            ? "Adding..."
                            : product.isDemo
                              ? "Add to Cart (Demo)"
                              : !buyerEligibility.eligible
                                ? "Sign In to Buy"
                                : product.hasVariants && !activeVariant
                                  ? "Select Variation"
                                  : !isService &&
                                      activeAvailableStock !== null &&
                                      activeAvailableStock <= 0
                                    ? "Out of Stock"
                                    : maxAddable <= 0
                                      ? "Max in Cart"
                                      : `Add to Cart · ${formatSenToRm(activePriceSen * clampedQuantity)}`}
                        </span>
                      </button>
                    </div>

                    {inCartForSelection > 0 ? (
                      <p className="text-xs font-medium text-[#1D70B8]">
                        {inCartForSelection} already in your cart
                      </p>
                    ) : null}

                    {cartState.status === "success" && cartState.message ? (
                      <p
                        role="status"
                        className="flex items-center gap-1.5 text-xs font-semibold text-[#008285]"
                      >
                        <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
                        <span>{cartState.message}</span>
                      </p>
                    ) : null}

                    {cartState.status === "error" && cartState.message ? (
                      <p
                        role="alert"
                        className="flex items-center gap-1.5 text-xs font-semibold text-[#B42318]"
                      >
                        <AlertCircle
                          className="h-4 w-4 shrink-0"
                          aria-hidden="true"
                        />
                        <span>{cartState.message}</span>
                      </p>
                    ) : null}
                  </form>
                )}

                {/* Chat with Seller & Bargain Buttons */}
                {!product.isOwner &&
                !product.isDemo &&
                !product.isFreeNotice &&
                isPublished &&
                Boolean(product.seller.sellerId) ? (
                  <div>
                    {(() => {
                      const canBargain =
                        isBargainingEligibleListing({
                          kind: product.kind,
                          isFood: product.isFood,
                          availabilityMode:
                            product.food?.availabilityMode ?? null,
                          isFreeNotice: product.isFreeNotice,
                        }) &&
                        product.allowOffers &&
                        (!product.hasVariants ||
                          Boolean(activeVariant && activeVariant.active)) &&
                        (activeAvailableStock ?? 0) >= 1;
                      const autoGreeting = `Hi! I'm interested in "${product.title}"${activeVariant ? ` (${formatVariationOptionLabel(activeVariant.optionValues)})` : ""} listed at ${formatSenToRm(activePriceSen)}. Is this still available?`;

                      return (
                        <div
                          className={`grid gap-2.5 ${
                            canBargain ? "grid-cols-2" : "grid-cols-1"
                          }`}
                        >
                          <button
                            type="button"
                            disabled={
                              !buyerEligibility.eligible ||
                              isChatPending ||
                              isBargainPending
                            }
                            onClick={() => {
                              if (
                                !buyerEligibility.eligible ||
                                isChatPending ||
                                isBargainPending
                              ) {
                                return;
                              }
                              setChatError(null);
                              startChatTransition(async () => {
                                const res = await startConversationAction({
                                  sellerId: product.seller.sellerId,
                                  listingId: product.id,
                                  initialMessage: autoGreeting,
                                });
                                if (res.ok && res.href) {
                                  router.push(res.href);
                                } else {
                                  setChatError(
                                    res.error || "Could not open chat right now."
                                  );
                                }
                              });
                            }}
                            className="press-feedback flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-[#4E2A84]/30 bg-white px-4 text-sm font-semibold text-[#4E2A84] transition-colors hover:border-[#4E2A84] hover:bg-[#F4F1FA] disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <MessageCircle
                              className="h-4 w-4 shrink-0"
                              aria-hidden="true"
                            />
                            <span className="truncate">
                              {isChatPending ? "Sending..." : "Chat with Seller"}
                            </span>
                          </button>

                          {canBargain ? (
                            <button
                              type="button"
                              disabled={
                                !buyerEligibility.eligible ||
                                isChatPending ||
                                isBargainPending
                              }
                              onClick={() => {
                                if (
                                  !buyerEligibility.eligible ||
                                  isChatPending ||
                                  isBargainPending
                                ) {
                                  return;
                                }
                                setChatError(null);
                                startBargainTransition(async () => {
                                  const res = await startConversationAction({
                                    sellerId: product.seller.sellerId,
                                    listingId: product.id,
                                    variantId: activeVariant?.id ?? null,
                                    openBargain: true,
                                  });
                                  if (res.ok && res.href) {
                                    router.push(res.href);
                                  } else {
                                    setChatError(
                                      res.error ||
                                        "Could not open bargain chat right now."
                                    );
                                  }
                                });
                              }}
                              className="press-feedback flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-[#008285] bg-[#EDFAF9] px-4 text-sm font-bold text-[#006B6D] transition-colors hover:bg-[#008285] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <Tag
                                className="h-4 w-4 shrink-0"
                                aria-hidden="true"
                              />
                              <span className="truncate">
                                {isBargainPending ? "Opening..." : "Bargain"}
                              </span>
                            </button>
                          ) : null}
                        </div>
                      );
                    })()}
                    {chatError ? (
                      <p
                        role="alert"
                        className="mt-1.5 text-xs font-semibold text-[#B42318]"
                      >
                        {chatError}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {favFeedback ? (
                  <p
                    role={favFeedback.type === "error" ? "alert" : "status"}
                    className={`text-xs font-semibold ${
                      favFeedback.type === "error"
                        ? "text-[#B42318]"
                        : "text-[#008285]"
                    }`}
                  >
                    {favFeedback.text}
                  </p>
                ) : null}

                {!buyerEligibility.eligible && !product.isDemo ? (
                  <p className="text-xs text-[#6B6779]">
                    {buyerEligibility.reason}{" "}
                    {buyerEligibility.code === "unauthenticated" ? (
                      <Link
                        href="/login"
                        className="font-semibold text-[#4E2A84] underline underline-offset-2"
                      >
                        Sign in
                      </Link>
                    ) : null}
                  </p>
                ) : null}
              </div>
            </div>

            {/* Inline Campus Seller Quick-Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#E6E3EE] bg-white px-4 py-3">
              <div className="flex min-w-0 items-center gap-3">
                {product.seller.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={product.seller.logoUrl}
                    alt={storefrontTitle}
                    className="h-10 w-10 shrink-0 rounded-full border border-[#E6E3EE] object-cover"
                  />
                ) : (
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#4E2A84] text-xs font-bold text-white">
                    {getInitials(storefrontTitle)}
                  </div>
                )}

                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-[#14121A]">
                    {storefrontTitle}
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-[#6B6779]">
                    <ShieldCheck
                      className="h-3.5 w-3.5 shrink-0 text-[#00A3A6]"
                      aria-hidden="true"
                    />
                    <span>{product.seller.badge}</span>
                    {ratingMetrics.shopRatingSummary.averageRating !== null ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="inline-flex items-center gap-0.5 font-semibold text-[#14121A]">
                          <Star
                            className="h-3 w-3"
                            style={{ color: REVIEW_STAR_COLOR, fill: REVIEW_STAR_COLOR }}
                            aria-hidden="true"
                          />
                          {ratingMetrics.shopRatingSummary.averageRating.toFixed(1)} Shop Rating
                        </span>
                      </>
                    ) : null}
                  </div>
                </div>
              </div>

              {product.seller.sellerId && !product.isDemo ? (
                <Link
                  href={`/store/${encodeURIComponent(product.seller.sellerId)}`}
                  className="press-feedback inline-flex shrink-0 items-center gap-1 rounded-xl border border-[#E6E3EE] bg-[#FAF9FC] px-3 py-1.5 text-xs font-bold text-[#4E2A84] transition-colors hover:border-[#4E2A84]/40 hover:bg-[#F4F1FA]"
                >
                  <span>View Storefront</span>
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      {/* 3. Segmented Tab Bar */}
      <div className="mt-6">
        <div
          role="tablist"
          aria-label="Listing details sections"
          className="flex gap-1 overflow-x-auto border-b border-[#E6E3EE] sm:gap-2"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "overview"}
            onClick={() => setActiveTab("overview")}
            className={`cursor-pointer whitespace-nowrap border-b-2 px-4 py-3 text-sm font-bold transition-colors ${
              activeTab === "overview"
                ? "border-[#4E2A84] text-[#4E2A84]"
                : "border-transparent text-[#6B6779] hover:text-[#14121A]"
            }`}
          >
            Overview &amp; Specs
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "reviews"}
            onClick={() => setActiveTab("reviews")}
            className={`inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap border-b-2 px-4 py-3 text-sm font-bold transition-colors ${
              activeTab === "reviews"
                ? "border-[#4E2A84] text-[#4E2A84]"
                : "border-transparent text-[#6B6779] hover:text-[#14121A]"
            }`}
          >
            <span>Reviews</span>
            {ratingMetrics.listingRatingSummary.totalReviews > 0 ? (
              <span className="rounded-full bg-[#F4F1FA] px-2 py-0.5 text-[11px] font-bold text-[#4E2A84]">
                {ratingMetrics.listingRatingSummary.totalReviews}
              </span>
            ) : null}
          </button>
        </div>

        {/* Tab Panel 1: Overview & Specs */}
        {activeTab === "overview" ? (
          <div
            role="tabpanel"
            className="mt-4 rounded-2xl border border-[#E6E3EE] bg-white p-5 sm:p-6"
          >
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
              <div className="lg:col-span-6">
                <h2 className="text-base font-extrabold text-[#14121A]">
                  About this listing
                </h2>
                <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-[#4A4656]">
                  {product.description}
                </p>

                {product.isFood && product.food ? (
                  <div className="mt-4 rounded-xl border border-[#00A3A6]/30 bg-[#EDFAF9] p-4">
                    <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#008285]">
                      <Utensils className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Campus Food Details</span>
                    </div>
                    <dl className="mt-2.5 grid grid-cols-1 gap-2.5 text-xs sm:grid-cols-3">
                      {product.food.availabilityMode ? (
                        <div>
                          <dt className="text-[#555062]">Availability</dt>
                          <dd className="font-bold text-[#14121A]">
                            {formatAvailabilityMode(
                              product.food.availabilityMode
                            )}
                          </dd>
                        </div>
                      ) : null}
                      {product.food.preorderCloseAt ? (
                        <div>
                          <dt className="text-[#555062]">Pre-Order Closes</dt>
                          <dd className="font-bold text-[#14121A]">
                            {formatDateTime(product.food.preorderCloseAt)}
                          </dd>
                        </div>
                      ) : null}
                      {product.food.pickupWindowStart ? (
                        <div>
                          <dt className="text-[#555062]">Pickup Window</dt>
                          <dd className="font-bold text-[#14121A]">
                            {formatDateTime(product.food.pickupWindowStart)}
                            {product.food.pickupWindowEnd
                              ? ` – ${formatDateTime(product.food.pickupWindowEnd)}`
                              : ""}
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                    {product.food.pickupNote ? (
                      <p className="mt-2 text-xs text-[#4A4656]">
                        Note: {product.food.pickupNote}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>

              {/* 2x2 Handover & Spec Tiles */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:col-span-6">
                <div className="flex items-start gap-3 rounded-xl border border-[#ECEAF3] bg-[#FAF9FC] p-3.5">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#EDFAF9] text-[#008285]">
                    <MapPin className="h-4 w-4" aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold text-[#6B6779]">
                      Collection Area
                    </p>
                    <p className="truncate text-sm font-bold text-[#14121A]">
                      {product.campusArea}
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3 rounded-xl border border-[#ECEAF3] bg-[#FAF9FC] p-3.5">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#F4F1FA] text-[#4E2A84]">
                    <Tag className="h-4 w-4" aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold text-[#6B6779]">
                      Condition
                    </p>
                    <p className="truncate text-sm font-bold text-[#14121A]">
                      {product.condition || "Standard"}
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3 rounded-xl border border-[#ECEAF3] bg-[#FAF9FC] p-3.5">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#F4F1FA] text-[#4E2A84]">
                    <Package className="h-4 w-4" aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold text-[#6B6779]">
                      Category
                    </p>
                    <p className="truncate text-sm font-bold text-[#14121A]">
                      {product.categoryName} ·{" "}
                      {formatListingType(product.listingType)}
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3 rounded-xl border border-[#ECEAF3] bg-[#FAF9FC] p-3.5">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#EDFAF9] text-[#008285]">
                    <Calendar className="h-4 w-4" aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold text-[#6B6779]">
                      Posted
                    </p>
                    <p className="truncate text-sm font-bold text-[#14121A]">
                      {formatShortDate(product.createdAt)}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {/* Tab Panel 2: Verified Reviews */}
        {activeTab === "reviews" ? (
          <div
            id="listing-reviews-panel"
            role="tabpanel"
            className="mt-4 space-y-5 rounded-2xl border border-[#E6E3EE] bg-white p-5 sm:p-6"
          >
            {reviewSuccessNotice ? (
              <p
                role="status"
                className="rounded-xl border border-[#00A3A6]/35 bg-[#EDFAF9] px-3.5 py-2.5 text-xs font-semibold text-[#006A6D]"
              >
                {reviewSuccessNotice}
              </p>
            ) : null}

            {/* Summary Header */}
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[#ECEAF2] bg-[#FAF9FC] p-4">
              <div className="flex items-center gap-4">
                <div className="text-center">
                  <p className="text-3xl font-extrabold tracking-tight text-[#14121A]">
                    {ratingMetrics.effectiveRating !== null
                      ? ratingMetrics.effectiveRating.toFixed(1)
                      : "—"}
                  </p>
                  <div className="mt-1 flex items-center justify-center gap-0.5">
                    {[1, 2, 3, 4, 5].map((star) => (
                      <Star
                        key={star}
                        className="h-3.5 w-3.5"
                        style={
                          ratingMetrics.effectiveRating !== null &&
                          star <= Math.round(ratingMetrics.effectiveRating)
                            ? { color: REVIEW_STAR_COLOR, fill: REVIEW_STAR_COLOR }
                            : { color: "#D5D0E0" }
                        }
                        aria-hidden="true"
                      />
                    ))}
                  </div>
                </div>

                <div className="space-y-1 text-xs">
                  {ratingMetrics.ratingSource === "listing" ? (
                    <p className="font-bold text-[#14121A]">
                      {isService ? "Service Rating" : "Product Rating"} &middot;{" "}
                      {ratingMetrics.listingRatingSummary.totalReviews}{" "}
                      {ratingMetrics.listingRatingSummary.totalReviews === 1
                        ? "verified review"
                        : "verified reviews"}
                    </p>
                  ) : ratingMetrics.ratingSource === "shop" ? (
                    <div className="space-y-0.5">
                      <p className="font-bold text-[#14121A]">
                        Shop Rating
                      </p>
                      <p className="text-[11px] text-[#6B6779]">
                        This {isService ? "service" : "listing"} has no item reviews yet.
                        Showing {product.seller.displayName}&apos;s overall Shop Rating.
                      </p>
                    </div>
                  ) : (
                    <p className="font-bold text-[#6B6779]">Not rated yet</p>
                  )}
                  <p className="text-[11px] font-semibold text-[#555062]">
                    {ratingMetrics.totalSold}{" "}
                    {isService ? "completed bookings" : "units sold"}
                  </p>
                </div>
              </div>

              {writeReviewOrder ? (
                <button
                  type="button"
                  onClick={() => {
                    setReviewActionError(null);
                    setReviewModalMode({ type: "create" });
                  }}
                  className="press-feedback inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-xl bg-[#4E2A84] px-4 py-2 text-xs font-bold text-white hover:bg-[#3A1E66]"
                >
                  <Star className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Write Review</span>
                </button>
              ) : null}
            </div>

            {listingReviews.length > 0 ? (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {listingReviews.map((review) => (
                  <ReviewCard
                    key={review.id}
                    review={review}
                    onEdit={
                      review.canEdit
                        ? (rv) => {
                            setReviewActionError(null);
                            setReviewModalMode({ type: "edit", review: rv });
                          }
                        : undefined
                    }
                  />
                ))}
              </div>
            ) : (
              <p className="rounded-xl border border-dashed border-[#E6E3EE] bg-[#FAF9FC] px-4 py-6 text-center text-xs text-[#6B6779]">
                No verified buyer reviews for this {isService ? "service" : "product"} yet.
              </p>
            )}
          </div>
        ) : null}
      </div>

      {/* 4. Photo Lightbox Zoom Modal */}
      {zoomOpen && activePhotoUrl ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Zoomed product image"
          onClick={() => setZoomOpen(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-xs"
        >
          <button
            type="button"
            onClick={() => setZoomOpen(false)}
            aria-label="Close zoomed image"
            className="absolute right-4 top-4 flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-white/90 text-[#14121A] shadow-md hover:bg-white"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={activePhotoUrl}
            alt={product.imageAlt}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[85vh] max-w-[92vw] rounded-2xl object-contain shadow-2xl"
          />
        </div>
      ) : null}

      {/* 4b. Report Listing Modal */}
      {reportOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="report-listing-title"
          onClick={() => setReportOpen(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-2xl border border-[#E6E3EE] bg-white p-5 shadow-2xl sm:p-6"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Flag className="h-4 w-4 text-[#BA1A1A]" aria-hidden="true" />
                <h2
                  id="report-listing-title"
                  className="text-base font-extrabold text-[#14121A]"
                >
                  Report Listing
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setReportOpen(false)}
                aria-label="Close report modal"
                className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-[#6B6779] hover:bg-[#F4F1FA] hover:text-[#14121A]"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <p className="mt-1.5 text-xs text-[#555062]">
              Reports are reviewed privately by Buy-U campus moderators.
            </p>

            {reportResult ? (
              <div
                role={reportResult.ok ? "status" : "alert"}
                className={`mt-4 rounded-xl border p-3.5 text-xs font-semibold ${
                  reportResult.ok
                    ? "border-[#A7F3D0] bg-[#ECFDF5] text-[#065F46]"
                    : "border-[#F3B3B3] bg-[#FEF2F2] text-[#991B1B]"
                }`}
              >
                {reportResult.message}
              </div>
            ) : null}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (isReportPending) return;
                setReportResult(null);
                startReportTransition(async () => {
                  const res = await submitReportAction({
                    targetKind: product.isFreeNotice
                      ? "free_notice"
                      : "listing",
                    targetId: product.id,
                    reason: reportReason,
                    explanation: reportDetails.trim(),
                  });
                  setReportResult({ ok: res.ok, message: res.message });
                  if (res.ok) {
                    setReportDetails("");
                  }
                });
              }}
              className="mt-4 space-y-3.5"
            >
              <div>
                <label
                  htmlFor="report-reason"
                  className="mb-1 block text-xs font-semibold text-[#2E2A36]"
                >
                  Reason
                </label>
                <select
                  id="report-reason"
                  value={reportReason}
                  onChange={(e) => setReportReason(e.target.value)}
                  className="h-10 w-full cursor-pointer rounded-xl border border-[#D5D0E0] bg-[#FAF9FD] px-3 text-sm text-[#14121A] outline-none focus:border-[#4E2A84] focus:bg-white focus:ring-2 focus:ring-[#4E2A84]/20"
                >
                  {REPORT_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {r
                        .replace(/_/g, " ")
                        .replace(/\b\w/g, (ch) => ch.toUpperCase())}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="report-details"
                  className="mb-1 block text-xs font-semibold text-[#2E2A36]"
                >
                  Additional Details (optional)
                </label>
                <textarea
                  id="report-details"
                  rows={3}
                  maxLength={500}
                  value={reportDetails}
                  onChange={(e) => setReportDetails(e.target.value)}
                  placeholder="Describe why this listing violates campus rules..."
                  className="w-full rounded-xl border border-[#D5D0E0] bg-[#FAF9FD] p-3 text-sm text-[#14121A] placeholder:text-[#8E889B] outline-none focus:border-[#4E2A84] focus:bg-white focus:ring-2 focus:ring-[#4E2A84]/20"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setReportOpen(false)}
                  className="press-feedback h-10 cursor-pointer rounded-xl border border-[#D5D0E0] bg-white px-4 text-xs font-semibold text-[#4A4656] hover:bg-[#FAF9FC]"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={isReportPending || Boolean(reportResult?.ok)}
                  className="press-feedback h-10 cursor-pointer rounded-xl bg-[#BA1A1A] px-4 text-xs font-bold text-white hover:bg-[#991B1B] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isReportPending ? "Submitting..." : "Submit Report"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* 5. Mobile Sticky Bottom Action Bar */}
      {canAddToCart ? (
        <div className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-between gap-3 border-t border-[#E6E3EE] bg-white/95 px-4 py-3 shadow-[0_-4px_20px_rgba(0,0,0,0.06)] backdrop-blur-md md:hidden">
          <div>
            <p className="text-[11px] font-medium text-[#6B6779]">Total</p>
            <p className="tabular-price text-lg font-extrabold text-[#4E2A84]">
              {formatSenToRm(activePriceSen * clampedQuantity)}
            </p>
          </div>
          <form action={cartFormAction}>
            <input type="hidden" name="listingId" value={product.id} />
            <input
              type="hidden"
              name="variantId"
              value={activeVariant?.id ?? ""}
            />
            <input
              type="hidden"
              name="quantity"
              value={String(clampedQuantity)}
            />
            <button
              type="submit"
              disabled={!canAddToCart || isCartPending}
              className="press-feedback inline-flex h-11 cursor-pointer items-center gap-2 rounded-xl bg-[#4E2A84] px-5 text-sm font-bold text-white shadow-sm hover:bg-[#381C63] disabled:opacity-60"
            >
              <ShoppingCart className="h-4 w-4" aria-hidden="true" />
              <span>{isCartPending ? "Adding..." : "Add to Cart"}</span>
            </button>
          </form>
        </div>
      ) : null}
      {/* Phase 10R: Review Write/Edit Dialog triggered from Product/Service Detail */}
      {reviewModalMode ? (
        <ReviewDialog
          key={
            reviewModalMode.type === "edit"
              ? `pdp-edit-${reviewModalMode.review.id}`
              : `pdp-new-${writeReviewOrder?.orderId ?? product.id}`
          }
          open
          orderCode={writeReviewOrder?.orderCode ?? null}
          items={[
            {
              id: product.id,
              listingId: product.id,
              title: writeReviewOrder?.itemTitle ?? product.title,
              variantLabel:
                reviewModalMode.type === "edit"
                  ? reviewModalMode.review.purchasedVariantLabel
                  : writeReviewOrder?.variantLabel ?? null,
              imageUrl: writeReviewOrder?.imageUrl ?? product.imageUrls[0] ?? null,
              isService,
            },
          ]}
          initialReview={
            reviewModalMode.type === "edit"
              ? {
                  id: reviewModalMode.review.id,
                  listingId: product.id,
                  rating: reviewModalMode.review.rating,
                  comment: reviewModalMode.review.comment,
                  isAnonymous:
                    reviewModalMode.review.ownEditableDraft?.isAnonymous ??
                    reviewModalMode.review.isAnonymous,
                  imagePaths:
                    reviewModalMode.review.ownEditableDraft?.imagePaths ?? [],
                  videoPath:
                    reviewModalMode.review.ownEditableDraft?.videoPath ?? null,
                }
              : null
          }
          submitting={reviewActionBusy}
          errorMessage={reviewActionError}
          onClose={() => {
            if (!reviewActionBusy) setReviewModalMode(null);
          }}
          onSubmit={async (payload) => {
            setReviewActionBusy(true);
            setReviewActionError(null);
            try {
              const res =
                reviewModalMode.type === "edit"
                  ? await editVerifiedReviewAction({
                      reviewId: reviewModalMode.review.id,
                      rating: payload.rating,
                      comment: payload.comment,
                      isAnonymous: payload.isAnonymous,
                      imagePaths: payload.imagePaths,
                      videoPath: payload.videoPath,
                    })
                  : writeReviewOrder
                    ? await submitVerifiedReviewAction({
                        orderId: writeReviewOrder.orderId,
                        listingId: product.id,
                        rating: payload.rating,
                        comment: payload.comment,
                        isAnonymous: payload.isAnonymous,
                        imagePaths: payload.imagePaths,
                        videoPath: payload.videoPath,
                      })
                    : { ok: false, message: "Eligible completed order not found." };

              if (!res.ok) {
                setReviewActionError(res.message);
                return;
              }
              setReviewModalMode(null);
              setReviewSuccessNotice(res.message);
              router.refresh();
            } catch {
              setReviewActionError("Network error while saving review. Please try again.");
            } finally {
              setReviewActionBusy(false);
            }
          }}
        />
      ) : null}
    </div>
  );
}
