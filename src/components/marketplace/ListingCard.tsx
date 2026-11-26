import { FreeNoticeVisibility } from "@/components/free-items/FreeNoticeVisibility";
import Link from "next/link";
import { MapPin, Star } from "lucide-react";
import { FavouriteButton } from "@/components/shared/FavouriteButton";
import { ListingImage } from "@/components/shared/ListingImage";
import {
  formatListingType,
  formatRelativeTime,
  formatSenToRm,
} from "@/lib/format";
import type { Listing } from "@/types/marketplace";

interface ListingCardProps {
  listing: Listing;
  isFavourited?: boolean;
  canFavourite?: boolean;
}

const BADGE_STYLES: Record<Listing["listingType"], string> = {
  preloved: "bg-[#F4F1FA] text-[#4E2A84]",
  business: "bg-[#EDF5FC] text-[#1D70B8]",
  food: "bg-[#EDFAF9] text-[#008386]",
  service: "bg-[#EDFAF9] text-[#008386]",
  free: "bg-[#F3F2F6] text-[#14121A]",
};

export function ListingCard({
  listing,
  isFavourited = false,
  canFavourite = false,
}: ListingCardProps) {
  const detailHref = listing.isDemo
    ? `/listings/${encodeURIComponent(listing.slug)}?demo=1`
    : listing.listingType === "free"
      ? `/free-items?post=${listing.id}#post-${listing.id}`
      : `/listings/${encodeURIComponent(listing.slug)}`;

  const sellerName = listing.sellerDisplayName || listing.sellerBadge || "UMS Member";
  const sellerInitials = sellerName
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const fallback = (
    <div className="flex h-full w-full flex-col justify-between bg-[#F4F1FA] p-3">
      <span className="self-start rounded-md bg-[#4E2A84] px-2 py-0.5 text-[10.5px] font-bold text-white">
        {formatListingType(listing.listingType)}
      </span>
      <span className="text-xs font-bold italic text-[#4E2A84]">
        {listing.categoryName}
      </span>
    </div>
  );

  const card = (
    <article className="group flex flex-col overflow-hidden rounded-2xl border border-[#E6E3EE] bg-white shadow-[0_2px_8px_rgba(20,18,26,0.04)] transition-all duration-200 hover:-translate-y-0.5 hover:border-[#4E2A84]/40 hover:shadow-[0_8px_20px_rgba(78,42,132,0.09)]">
      {/* Image with translucent RM price, type/condition badges & interactive favourite heart */}
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-[#F5F4F8]">
        <Link href={detailHref} className="block h-full w-full">
          <ListingImage
            src={listing.imageUrl}
            alt={listing.imageAlt}
            fallback={fallback}
          />

          {/* Demo badge if demo */}
          {listing.isDemo ? (
            <span className="absolute top-2 left-2 rounded-md border border-[#1D70B8]/30 bg-white/95 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-[#14538A]">
              Demo
            </span>
          ) : null}

          {/* Top-right Stock or Condition Pill */}
          {listing.availableStock === 0 ? (
            <span className="absolute top-2 right-2 rounded-md bg-[#BA1A1A] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white shadow-xs">
              Out of stock
            </span>
          ) : listing.condition ? (
            <span className="absolute top-2 right-2 rounded-md bg-white/95 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-[#4E2A84] shadow-xs">
              {listing.condition}
            </span>
          ) : null}

          {/* Bottom-left Translucent RM Price Pill */}
          <div className="absolute bottom-2 left-2 rounded-lg border border-white/15 bg-[#14121A]/60 px-2.5 py-0.5 shadow-sm backdrop-blur-md">
            <span className="tabular-price text-[14px] font-extrabold tracking-tight text-white sm:text-[15px]">
              {formatSenToRm(listing.priceSen)}
            </span>
          </div>
        </Link>

        {/* Bottom-right Interactive Favourite Heart */}
        {listing.listingType !== "free" && (
          <FavouriteButton
            listingId={listing.id}
            initialFavourited={isFavourited}
            canFavourite={canFavourite}
            isDemo={listing.isDemo}
            className="absolute bottom-2 right-2 z-10"
          />
        )}
      </div>

      {/* Card Body */}
      <Link
        href={detailHref}
        className="flex flex-1 flex-col justify-between p-3.5 focus-visible:outline-offset-[-2px]"
      >
        <div>
          <h3 className="line-clamp-2 text-[15.5px] font-extrabold leading-snug tracking-[-0.01em] text-[#14121A] transition-colors group-hover:text-[#4E2A84]">
            {listing.title}
          </h3>

          <div className="mt-1.5 flex items-center gap-1 text-[12px] text-[#6E6A7C]">
            <MapPin
              className="h-3.5 w-3.5 shrink-0 text-[#8E899E]"
              aria-hidden="true"
            />
            <span className="truncate">{listing.campusArea}</span>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span
              className={`inline-block rounded-md px-2 py-0.5 text-[11px] font-bold ${BADGE_STYLES[listing.listingType]}`}
            >
              {listing.categoryName}
            </span>
            <span className="inline-block rounded-md bg-[#F4F3F7] px-2 py-0.5 text-[10.5px] font-semibold text-[#5B5668]">
              {formatListingType(listing.listingType)}
            </span>
          </div>

          {listing.listingType !== "free" ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] font-semibold text-[#5B5668]">
              <Star
                className="h-3.5 w-3.5 shrink-0"
                style={
                  listing.rating != null
                    ? { color: "#F4B400", fill: "#F4B400" }
                    : { color: "#C5C1D0" }
                }
                aria-hidden="true"
              />
              <span>
                {listing.rating != null
                  ? listing.ratingSource === "shop"
                    ? listing.rating.toFixed(1)
                    : `${listing.rating.toFixed(1)} (${listing.reviewCount ?? 0})`
                  : "Not rated yet"}
              </span>
              {listing.rating != null && listing.ratingSource === "shop" ? (
                <span className="rounded bg-[#F4F1FA] px-1.5 py-0.5 text-[9.5px] font-bold text-[#4E2A84]">
                  Shop Rating
                </span>
              ) : null}
              {(listing.salesCount ?? 0) > 0 ? (
                <span className="text-[#8E899E]">
                  &middot; {listing.salesCount}{" "}
                  {listing.listingType === "service" ? "completed" : "sold"}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="mt-3 flex items-center justify-between border-t border-[#F0EDF5] pt-2 text-[11px] text-[#6E6A7C]">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#EFEAF8] text-[9px] font-extrabold text-[#4E2A84]">
              {sellerInitials}
            </span>
            <span className="truncate font-semibold text-[#3E3B4B]">
              {sellerName}
            </span>
          </div>

          <span className="shrink-0 text-[10.5px] text-[#858094]">
            {formatRelativeTime(listing.createdAt)}
          </span>
        </div>
      </Link>
    </article>
  );
  const visibility = listing.freeVisibility;
  return visibility ? <FreeNoticeVisibility key={visibility.expiresAt} {...visibility}>{card}</FreeNoticeVisibility> : card;
}
