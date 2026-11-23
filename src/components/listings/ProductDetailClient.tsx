"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  Calendar,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Heart,
  MapPin,
  Minus,
  Package,
  Pencil,
  Plus,
  ShieldCheck,
  ShoppingCart,
  Store,
  Tag,
  Utensils,
} from "lucide-react";
import {
  addToCartAction,
  toggleFavouriteAction,
  type AddToCartActionState,
} from "@/app/listings/actions";
import { ListingImage } from "@/components/shared/ListingImage";
import type { ProductDetail } from "@/lib/buyer/data";
import type { BuyerEligibilityResult } from "@/lib/buyer/validation";
import {
  formatListingType,
  formatSenToRm,
  formatShortDate,
} from "@/lib/format";

interface ProductDetailClientProps {
  product: ProductDetail;
  buyerEligibility: BuyerEligibilityResult;
}

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
}: ProductDetailClientProps) {
  const router = useRouter();
  const [activePhotoIndex, setActivePhotoIndex] = useState(0);

  const defaultVariant =
    product.hasVariants && product.variants.length > 0
      ? product.variants.find((v) => v.availableStock > 0) ?? product.variants[0]
      : null;

  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(
    defaultVariant?.id ?? null
  );
  const [quantity, setQuantity] = useState(1);

  const [isFavourited, setIsFavourited] = useState(product.isFavourited);
  const [favFeedback, setFavFeedback] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [isFavPending, startFavTransition] = useTransition();

  const [cartState, cartFormAction, isCartPending] = useActionState(
    addToCartAction,
    INITIAL_CART_STATE
  );

  // Trigger navbar Cart badge and server cart counts refresh after successful add-to-cart.
  useEffect(() => {
    if (cartState.status === "success") {
      router.refresh();
    }
  }, [cartState, router]);

  const activeVariant = product.hasVariants
    ? product.variants.find((v) => v.id === selectedVariantId) ?? null
    : null;

  const activePriceSen = activeVariant
    ? activeVariant.priceSen
    : product.priceSen;

  const isPhysicalProduct =
    product.kind === "pre_loved" || product.kind === "business";
  const isPublished = product.status === "published";

  const activeAvailableStock = !isPhysicalProduct
    ? null
    : product.hasVariants
      ? activeVariant?.availableStock ?? 0
      : Math.max(0, product.quantity - Math.max(0, product.reservedQuantity));

  const activeReservedStock = !isPhysicalProduct
    ? 0
    : product.hasVariants
      ? activeVariant?.reservedQuantity ?? 0
      : Math.max(0, product.reservedQuantity);

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
    isPhysicalProduct &&
    isPublished &&
    !product.isOwner &&
    buyerEligibility.eligible &&
    (!product.hasVariants || Boolean(activeVariant && activeVariant.active)) &&
    maxAddable > 0;

  const photos = product.imageUrls;
  const safePhotoIndex =
    photos.length > 0 ? Math.min(activePhotoIndex, photos.length - 1) : 0;
  const activePhotoUrl = photos[safePhotoIndex] ?? null;

  function handleSelectVariant(variantId: string) {
    setSelectedVariantId(variantId);
    setQuantity(1);
  }

  function handleToggleFavourite() {
    if (!canFavourite || isFavPending) return;
    setFavFeedback(null);
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

  let stockStatusText = "Available";
  let stockStatusColor = "text-[#008285]";
  if (!isPublished) {
    stockStatusText =
      product.status === "archived"
        ? "Archived"
        : product.status === "draft"
          ? "Draft"
          : "Unavailable";
    stockStatusColor = "text-[#B42318]";
  } else if (product.listingType === "service") {
    stockStatusText =
      product.acceptingRequests === false
        ? "Not Accepting Requests"
        : "Accepting Requests";
    stockStatusColor =
      product.acceptingRequests === false
        ? "text-[#B42318]"
        : "text-[#008285]";
  } else if (product.listingType === "free") {
    stockStatusText = "Free Campus Giveaway";
    stockStatusColor = "text-[#1D70B8]";
  } else if (activeAvailableStock !== null && activeAvailableStock <= 0) {
    stockStatusText = "Out of Stock";
    stockStatusColor = "text-[#B42318]";
  } else if (activeAvailableStock !== null) {
    stockStatusText = `${activeAvailableStock} available`;
    stockStatusColor = "text-[#008285]";
  }

  const fallbackFrame = (
    <div className="flex h-full w-full flex-col justify-between bg-[#F7F6FA] p-6">
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

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:gap-8">
      {/* Left column: Photo gallery + Description + Food details */}
      <div className="space-y-6 lg:col-span-7">
        <section
          aria-label="Product photos"
          className="overflow-hidden rounded-2xl border border-[#E6E3EE] bg-white"
        >
          <div className="relative aspect-[4/3] w-full bg-[#F7F6FA]">
            <ListingImage
              src={activePhotoUrl}
              alt={`${product.imageAlt}${photos.length > 1 ? ` — photo ${safePhotoIndex + 1} of ${photos.length}` : ""}`}
              fallback={fallbackFrame}
            />

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
                  className="absolute left-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-[#E6E3EE] bg-white/95 text-[#14121A] transition hover:border-[#4E2A84] hover:text-[#4E2A84] active:scale-95"
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
                  className="absolute right-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-[#E6E3EE] bg-white/95 text-[#14121A] transition hover:border-[#4E2A84] hover:text-[#4E2A84] active:scale-95"
                >
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </button>
                <span className="absolute bottom-3 right-3 rounded-lg border border-[#E6E3EE] bg-white/95 px-2.5 py-1 text-xs font-semibold text-[#14121A]">
                  {safePhotoIndex + 1} / {photos.length}
                </span>
              </>
            ) : null}
          </div>

          {photos.length > 1 ? (
            <div className="flex gap-2.5 overflow-x-auto border-t border-[#ECEAF3] p-3">
              {photos.map((url, idx) => {
                const isSelected = idx === safePhotoIndex;
                return (
                  <button
                    key={`${url}-${idx}`}
                    type="button"
                    onClick={() => setActivePhotoIndex(idx)}
                    aria-label={`View photo ${idx + 1}`}
                    aria-current={isSelected ? "true" : undefined}
                    className={`relative h-16 w-16 shrink-0 overflow-hidden rounded-xl border transition ${
                      isSelected
                        ? "border-[#4E2A84] ring-2 ring-[#4E2A84]/20"
                        : "border-[#E6E3EE] hover:border-[#9E97B0]"
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={url}
                      alt={`${product.title} thumbnail ${idx + 1}`}
                      className="h-full w-full object-cover"
                    />
                  </button>
                );
              })}
            </div>
          ) : null}
        </section>

        {/* Description & Product Details */}
        <section className="rounded-2xl border border-[#E6E3EE] bg-white p-6">
          <h2 className="text-base font-bold text-[#14121A]">
            About this listing
          </h2>
          <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-[#3E3A4A]">
            {product.description || "No additional description provided."}
          </p>

          {product.limitations ? (
            <div className="mt-5 border-t border-[#ECEAF3] pt-4">
              <h3 className="text-xs font-bold uppercase tracking-wider text-[#6B6779]">
                Notes &amp; Limitations
              </h3>
              <p className="mt-1.5 whitespace-pre-line text-sm text-[#3E3A4A]">
                {product.limitations}
              </p>
            </div>
          ) : null}

          <dl className="mt-5 grid grid-cols-1 gap-3 border-t border-[#ECEAF3] pt-4 text-sm sm:grid-cols-2">
            <div className="flex items-start gap-2.5">
              <MapPin
                className="mt-0.5 h-4 w-4 shrink-0 text-[#6B6779]"
                aria-hidden="true"
              />
              <div>
                <dt className="text-xs font-medium text-[#6B6779]">
                  Collection Area
                </dt>
                <dd className="font-semibold text-[#14121A]">
                  {product.campusArea}
                </dd>
              </div>
            </div>

            <div className="flex items-start gap-2.5">
              <Tag
                className="mt-0.5 h-4 w-4 shrink-0 text-[#6B6779]"
                aria-hidden="true"
              />
              <div>
                <dt className="text-xs font-medium text-[#6B6779]">Category</dt>
                <dd className="font-semibold text-[#14121A]">
                  {product.categoryName}
                </dd>
              </div>
            </div>

            {product.condition ? (
              <div className="flex items-start gap-2.5">
                <Package
                  className="mt-0.5 h-4 w-4 shrink-0 text-[#6B6779]"
                  aria-hidden="true"
                />
                <div>
                  <dt className="text-xs font-medium text-[#6B6779]">
                    Condition
                  </dt>
                  <dd className="font-semibold text-[#14121A]">
                    {product.condition}
                  </dd>
                </div>
              </div>
            ) : null}

            <div className="flex items-start gap-2.5">
              <Calendar
                className="mt-0.5 h-4 w-4 shrink-0 text-[#6B6779]"
                aria-hidden="true"
              />
              <div>
                <dt className="text-xs font-medium text-[#6B6779]">Posted</dt>
                <dd className="font-semibold text-[#14121A]">
                  {formatShortDate(product.publishedAt || product.createdAt)}
                </dd>
              </div>
            </div>
          </dl>
        </section>

        {/* Campus Food Details (shown only when listing is food) */}
        {product.isFood && product.food ? (
          <section className="rounded-2xl border border-[#E6E3EE] bg-white p-6">
            <div className="flex items-center gap-2">
              <Utensils
                className="h-4 w-4 text-[#4E2A84]"
                aria-hidden="true"
              />
              <h2 className="text-base font-bold text-[#14121A]">
                Campus Food Details
              </h2>
            </div>

            <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              {product.food.availabilityMode ? (
                <div>
                  <dt className="text-xs font-medium text-[#6B6779]">
                    Availability Mode
                  </dt>
                  <dd className="mt-0.5 font-semibold text-[#14121A]">
                    {formatAvailabilityMode(product.food.availabilityMode)}
                  </dd>
                </div>
              ) : null}

              {formatDateTime(product.food.preorderCloseAt) ? (
                <div>
                  <dt className="text-xs font-medium text-[#6B6779]">
                    Pre-Order Cutoff
                  </dt>
                  <dd className="mt-0.5 font-semibold text-[#14121A]">
                    {formatDateTime(product.food.preorderCloseAt)}
                  </dd>
                </div>
              ) : null}

              {formatDateTime(product.food.pickupWindowStart) ? (
                <div className="sm:col-span-2">
                  <dt className="flex items-center gap-1.5 text-xs font-medium text-[#6B6779]">
                    <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Pickup Window</span>
                  </dt>
                  <dd className="mt-0.5 font-semibold text-[#14121A]">
                    {formatDateTime(product.food.pickupWindowStart)}
                    {formatDateTime(product.food.pickupWindowEnd)
                      ? ` – ${formatDateTime(product.food.pickupWindowEnd)}`
                      : ""}
                  </dd>
                </div>
              ) : null}

              {product.food.pickupNote ? (
                <div className="sm:col-span-2">
                  <dt className="text-xs font-medium text-[#6B6779]">
                    Pickup Note
                  </dt>
                  <dd className="mt-0.5 text-[#3E3A4A]">
                    {product.food.pickupNote}
                  </dd>
                </div>
              ) : null}

              {product.food.foodNotes ? (
                <div className="sm:col-span-2">
                  <dt className="text-xs font-medium text-[#6B6779]">
                    Ingredients / Food Notes
                  </dt>
                  <dd className="mt-0.5 whitespace-pre-line text-[#3E3A4A]">
                    {product.food.foodNotes}
                  </dd>
                </div>
              ) : null}
            </dl>
          </section>
        ) : null}
      </div>

      {/* Right column: Purchase card + Seller storefront card */}
      <div className="space-y-6 lg:col-span-5">
        <section className="rounded-2xl border border-[#E6E3EE] bg-white p-6">
          {/* Plain-text metadata row (strictly no colored pill backgrounds) */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-semibold">
            <span className="uppercase tracking-wider text-[#4E2A84]">
              {formatListingType(product.listingType)}
            </span>
            <span className="text-[#C7C3D4]" aria-hidden="true">
              &middot;
            </span>
            <span className="text-[#6B6779]">{product.categoryName}</span>
            {product.condition ? (
              <>
                <span className="text-[#C7C3D4]" aria-hidden="true">
                  &middot;
                </span>
                <span className="text-[#6B6779]">{product.condition}</span>
              </>
            ) : null}
          </div>

          <h1 className="mt-3 text-2xl font-extrabold tracking-[-0.02em] text-[#14121A] sm:text-[28px]">
            {product.title}
          </h1>

          <div className="mt-4 flex flex-wrap items-baseline justify-between gap-2 border-y border-[#ECEAF3] py-4">
            <p className="text-3xl font-extrabold tracking-tight text-[#4E2A84]">
              {formatSenToRm(activePriceSen)}
            </p>
            <div className="text-right">
              <p className={`text-sm font-bold ${stockStatusColor}`}>
                {stockStatusText}
              </p>
              {activeReservedStock > 0 && isPhysicalProduct ? (
                <p className="text-xs text-[#6B6779]">
                  {activeReservedStock} reserved in active orders
                </p>
              ) : null}
            </div>
          </div>

          {/* Variant Selector */}
          {product.hasVariants && product.variants.length > 0 ? (
            <div className="mt-5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-bold uppercase tracking-wider text-[#6B6779]">
                  Select Option
                </p>
                {activeVariant ? (
                  <span className="text-xs font-semibold text-[#14121A]">
                    {activeVariant.label}
                  </span>
                ) : null}
              </div>

              <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {product.variants.map((variant) => {
                  const isSelected = variant.id === activeVariant?.id;
                  const soldOut = variant.availableStock <= 0;
                  return (
                    <button
                      key={variant.id}
                      type="button"
                      onClick={() => handleSelectVariant(variant.id)}
                      aria-pressed={isSelected}
                      className={`flex flex-col items-start rounded-xl border px-3.5 py-2.5 text-left transition ${
                        isSelected
                          ? "border-[#4E2A84] bg-[#FAF8FD]"
                          : "border-[#E6E3EE] bg-white hover:border-[#9E97B0]"
                      } ${soldOut ? "opacity-60" : ""}`}
                    >
                      <span className="text-sm font-semibold text-[#14121A]">
                        {variant.label}
                      </span>
                      <span className="mt-0.5 flex w-full items-center justify-between text-xs">
                        <span className="font-bold text-[#4E2A84]">
                          {formatSenToRm(variant.priceSen)}
                        </span>
                        <span
                          className={
                            soldOut
                              ? "font-semibold text-[#B42318]"
                              : "text-[#6B6779]"
                          }
                        >
                          {soldOut
                            ? "Out of Stock"
                            : `${variant.availableStock} left`}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* Owner self-purchase block OR Buyer Cart + Favourite controls */}
          <div className="mt-6 space-y-3">
            {product.isOwner ? (
              <div className="rounded-xl border border-[#E6E3EE] bg-[#FAF9FC] p-4">
                <p className="text-sm font-semibold text-[#14121A]">
                  This is your listing
                </p>
                <p className="mt-1 text-xs text-[#6B6779]">
                  You cannot add your own item to your cart. Manage stock,
                  variants, or pricing from Seller Hub.
                </p>
                <Link
                  href={`/sell/${product.id}`}
                  className="mt-3 inline-flex items-center gap-2 rounded-xl bg-[#4E2A84] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#3F216B] active:scale-[0.98]"
                >
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                  <span>Edit Listing</span>
                </Link>
              </div>
            ) : !isPublished ? (
              <div className="flex items-start gap-2.5 rounded-xl border border-[#E6E3EE] bg-[#FAF9FC] p-4 text-sm text-[#4A4656]">
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
            ) : !isPhysicalProduct ? (
              <div className="rounded-xl border border-[#E6E3EE] bg-[#FAF9FC] p-4 text-sm text-[#4A4656]">
                {product.listingType === "service"
                  ? "Student services are booked via service requests rather than the shopping cart."
                  : "Free campus items are claimed directly with the poster and do not use the shopping cart."}
              </div>
            ) : (
              <form action={cartFormAction} className="space-y-3">
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

                {/* Quantity Stepper */}
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wider text-[#6B6779]">
                      Quantity
                    </p>
                    {inCartForSelection > 0 ? (
                      <p className="mt-0.5 text-xs font-medium text-[#1D70B8]">
                        {inCartForSelection} already in your cart
                      </p>
                    ) : null}
                  </div>

                  <div className="inline-flex items-center rounded-xl border border-[#E6E3EE] bg-white">
                    <button
                      type="button"
                      onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                      disabled={!canAddToCart || clampedQuantity <= 1}
                      aria-label="Decrease quantity"
                      className="flex h-10 w-10 items-center justify-center text-[#14121A] transition hover:text-[#4E2A84] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Minus className="h-4 w-4" aria-hidden="true" />
                    </button>
                    <span
                      className="min-w-[2.5rem] text-center text-sm font-bold text-[#14121A]"
                      aria-live="polite"
                    >
                      {clampedQuantity}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setQuantity((q) => Math.min(maxAddable, q + 1))
                      }
                      disabled={!canAddToCart || clampedQuantity >= maxAddable}
                      aria-label="Increase quantity"
                      className="flex h-10 w-10 items-center justify-center text-[#14121A] transition hover:text-[#4E2A84] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Plus className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                </div>

                {/* Primary Add to Cart CTA */}
                <button
                  type="submit"
                  disabled={!canAddToCart || isCartPending}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#4E2A84] px-5 py-3 text-sm font-bold text-white transition hover:bg-[#3F216B] active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-[#C9C4D6] disabled:text-white"
                >
                  <ShoppingCart className="h-4 w-4" aria-hidden="true" />
                  <span>
                    {isCartPending
                      ? "Adding to Cart..."
                      : product.isDemo
                        ? "Add to Cart (Demo Only)"
                        : !buyerEligibility.eligible
                          ? "Sign In to Add to Cart"
                          : activeAvailableStock !== null &&
                              activeAvailableStock <= 0
                            ? "Out of Stock"
                            : maxAddable <= 0
                              ? "Maximum Available in Cart"
                              : `Add to Cart · ${formatSenToRm(activePriceSen * clampedQuantity)}`}
                  </span>
                </button>

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

            {/* Persistent Favourite Toggle */}
            {!product.isFreeNotice ? (
              <div className="space-y-1.5">
                <button
                  type="button"
                  onClick={handleToggleFavourite}
                  disabled={!canFavourite || isFavPending}
                  aria-pressed={isFavourited}
                  className={`flex w-full items-center justify-center gap-2 rounded-xl border px-5 py-2.5 text-sm font-semibold transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 ${
                    isFavourited
                      ? "border-[#4E2A84] bg-[#FAF8FD] text-[#4E2A84]"
                      : "border-[#E6E3EE] bg-white text-[#14121A] hover:border-[#4E2A84] hover:text-[#4E2A84]"
                  }`}
                >
                  <Heart
                    className={`h-4 w-4 ${isFavourited ? "fill-[#4E2A84] text-[#4E2A84]" : ""}`}
                    aria-hidden="true"
                  />
                  <span>
                    {isFavPending
                      ? "Updating..."
                      : isFavourited
                        ? "Saved in Favourites"
                        : "Add to Favourites"}
                  </span>
                </button>

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
              </div>
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
        </section>

        {/* Seller / Storefront Card */}
        <section className="rounded-2xl border border-[#E6E3EE] bg-white p-6">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#6B6779]">
            <Store className="h-3.5 w-3.5 text-[#4E2A84]" aria-hidden="true" />
            <span>Campus Seller</span>
          </div>

          <div className="mt-4 flex items-start gap-3.5">
            {product.seller.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={product.seller.logoUrl}
                alt={storefrontTitle}
                className="h-12 w-12 shrink-0 rounded-xl border border-[#E6E3EE] object-cover"
              />
            ) : (
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[#4E2A84] text-sm font-bold text-white">
                {getInitials(storefrontTitle)}
              </div>
            )}

            <div className="min-w-0 flex-1">
              <p className="truncate text-base font-bold text-[#14121A]">
                {storefrontTitle}
              </p>
              {product.seller.shopName &&
              product.seller.shopName !== product.seller.displayName ? (
                <p className="truncate text-xs font-medium text-[#6B6779]">
                  Managed by {product.seller.displayName}
                </p>
              ) : null}
              <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-[#6B6779]">
                <ShieldCheck
                  className="h-3.5 w-3.5 shrink-0 text-[#00A3A6]"
                  aria-hidden="true"
                />
                <span>{product.seller.badge}</span>
                {product.seller.faculty ? (
                  <>
                    <span aria-hidden="true">&middot;</span>
                    <span>{product.seller.faculty}</span>
                  </>
                ) : null}
              </p>
            </div>
          </div>

          {product.seller.shopDescription ? (
            <p className="mt-3 border-t border-[#ECEAF3] pt-3 text-xs leading-relaxed text-[#4A4656]">
              {product.seller.shopDescription}
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
