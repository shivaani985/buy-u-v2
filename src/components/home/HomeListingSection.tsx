import Link from "next/link";
import {
  ArrowRight,
  Lock,
  LogIn,
  MapPin,
  Package,
  Star,
  UserPlus,
} from "lucide-react";
import { ListingImage } from "@/components/shared/ListingImage";
import { FavouriteButton } from "@/components/shared/FavouriteButton";
import {
  formatListingType,
  formatRelativeTime,
  formatSenToRm,
} from "@/lib/format";
import type { CatalogDataSource, Listing } from "@/types/marketplace";

interface HomeListingSectionProps {
  listings: Listing[];
  source: CatalogDataSource;
  notice?: string;
  useDemo?: boolean;
  favouriteIds?: string[];
  canFavourite?: boolean;
}

const BADGE_STYLES: Record<Listing["listingType"], string> = {
  preloved: "bg-[#F4F1FA] text-[#4E2A84]",
  business: "bg-[#EDF5FC] text-[#1D70B8]",
  food: "bg-[#EDFAF9] text-[#008386]",
  service: "bg-[#EDFAF9] text-[#008386]",
  free: "bg-[#F3F2F6] text-[#14121A]",
};

function HomeListingCard({
  listing,
  isFavourited = false,
  canFavourite = false,
}: {
  listing: Listing;
  isFavourited?: boolean;
  canFavourite?: boolean;
}) {
  const detailHref = listing.isDemo
    ? `/listings/${encodeURIComponent(listing.slug)}?demo=1`
    : `/listings/${encodeURIComponent(listing.slug)}`;

  const sellerInitials = (listing.sellerDisplayName || "UM")
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

  return (
    <article className="group flex flex-col overflow-hidden rounded-2xl border border-[#E6E3EE] bg-white shadow-[0_2px_8px_rgba(20,18,26,0.04)] transition-all hover:-translate-y-0.5 hover:border-[#4E2A84]/40 hover:shadow-[0_6px_16px_rgba(78,42,132,0.09)]">
      {/* 1. Image with translucent RM price, stock/condition & favourite heart */}
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-[#F5F4F8]">
        <Link href={detailHref} className="block h-full w-full">
          <ListingImage
            src={listing.imageUrl}
            alt={listing.imageAlt}
            fallback={fallback}
          />

          {/* Translucent RM Price Overlay */}
          <div className="absolute bottom-2 left-2 rounded-lg border border-white/15 bg-[#14121A]/60 px-2.5 py-0.5 shadow-sm backdrop-blur-md">
            <span className="tabular-price text-[14px] font-extrabold tracking-tight text-white sm:text-[15px]">
              {formatSenToRm(listing.priceSen)}
            </span>
          </div>

          {/* Demo badge if demo */}
          {listing.isDemo ? (
            <span className="absolute top-2 left-2 rounded-md border border-[#1D70B8]/30 bg-white/95 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-[#14538A]">
              Demo
            </span>
          ) : null}

          {/* Stock or Condition badge (mutually exclusive at top-right so they never overlap) */}
          {listing.availableStock === 0 ? (
            <span className="absolute top-2 right-2 rounded-md bg-[#BA1A1A] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white shadow-xs">
              Out of stock
            </span>
          ) : listing.condition ? (
            <span className="absolute top-2 right-2 rounded-md bg-white/95 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-[#4E2A84] shadow-xs">
              {listing.condition}
            </span>
          ) : null}
        </Link>

        {/* Bottom-Right Interactive Favourite Heart */}
        <FavouriteButton
          listingId={listing.id}
          initialFavourited={isFavourited}
          canFavourite={canFavourite}
          isDemo={listing.isDemo}
          className="absolute bottom-2 right-2 z-10"
        />
      </div>

      {/* Card Body: Strict Hierarchy */}
      <Link href={detailHref} className="flex flex-1 flex-col justify-between p-3">
          <div>
            {/* 2. Product Name — larger, bold */}
            <h3 className="line-clamp-2 text-[15.5px] font-extrabold leading-snug tracking-[-0.01em] text-[#14121A] group-hover:text-[#4E2A84]">
              {listing.title}
            </h3>

            {/* 3. Location — muted gray text + gray pin icon */}
            <div className="mt-1.5 flex items-center gap-1 text-[12px] text-[#6E6A7C]">
              <MapPin
                className="h-3.5 w-3.5 shrink-0 text-[#8E899E]"
                aria-hidden="true"
              />
              <span className="truncate">{listing.campusArea}</span>
            </div>

            {/* 4. Category — subtle badge */}
            <div className="mt-2">
              <span
                className={`inline-block rounded-md px-2 py-0.5 text-[11px] font-bold ${BADGE_STYLES[listing.listingType]}`}
              >
                {listing.categoryName}
              </span>
            </div>

            {listing.listingType !== "free" ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] font-semibold text-[#5B5668]">
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

          {/* 5. Seller information — secondary footer */}
          {listing.sellerDisplayName ? (
            <div className="mt-3 flex items-center justify-between border-t border-[#F0EDF5] pt-2 text-[11px] text-[#6E6A7C]">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#EFEAF8] text-[9px] font-extrabold text-[#4E2A84]">
                  {sellerInitials}
                </span>
                <span className="truncate font-semibold text-[#3E3B4B]">
                  {listing.sellerDisplayName}
                </span>
              </div>

              <span className="shrink-0 text-[10.5px] text-[#858094]">
                {formatRelativeTime(listing.createdAt)}
              </span>
            </div>
          ) : null}
      </Link>
    </article>
  );
}

export function HomeListingSection({
  listings,
  source,
  notice,
  useDemo = false,
  favouriteIds = [],
  canFavourite = false,
}: HomeListingSectionProps) {
  const viewAllHref = useDemo ? "/marketplace?demo=1" : "/marketplace";

  // Filter products for Latest on Campus (exclude service and free which have dedicated columns)
  const productListings = listings.filter(
    (item) => item.listingType !== "service" && item.listingType !== "free"
  );
  const featured = productListings.slice(0, 10);

  return (
    <section
      aria-labelledby="latest-heading"
      className="bori-container py-3 lg:py-4"
    >
      {/* Top Row: Left Heading + Subheading, Right View All */}
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[#E6E3EE] pb-2.5">
        <div>
          <div className="flex items-center gap-2.5">
            <h2
              id="latest-heading"
              className="text-[22px] font-extrabold italic tracking-[-0.02em] text-[#111018] sm:text-[24px]"
            >
              Latest on Campus
            </h2>
            <span
              className="h-2 w-2 rounded-full bg-[#00A3A6]"
              aria-hidden="true"
            />
          </div>
          <p className="mt-0.5 text-[13.5px] text-[#5B5668]">
            Fresh student listings from the UMS community.
          </p>
        </div>

        <Link
          href={viewAllHref}
          className="group inline-flex items-center gap-1.5 text-[13.5px] font-bold text-[#4E2A84] hover:text-[#381C63] press-feedback"
        >
          <span>View All</span>
          <ArrowRight
            className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
            aria-hidden="true"
          />
        </Link>
      </div>

      {/* Product Content Area */}
      <div className="mt-4">
        {source === "auth_required" ? (
          <div className="flex flex-col justify-between rounded-2xl border border-[#E6E3EE] bg-[#FAF9FC] p-5 sm:flex-row sm:items-center sm:gap-6">
            <div className="flex items-start gap-3.5">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#4E2A84] text-white">
                <Lock className="h-5 w-5" aria-hidden="true" />
              </span>
              <div>
                <h3 className="text-base font-extrabold text-[#14121A]">
                  Sign in with your UMS email to see live campus listings
                </h3>
                <p className="mt-1 max-w-[54ch] text-xs leading-relaxed text-[#5B5668] sm:text-sm">
                  Buy-U protects student and staff listings inside the verified
                  Universiti Malaysia Sabah community (
                  <code className="font-mono text-[#4E2A84]">
                    @iluv.ums.edu.my
                  </code>{" "}
                  &amp;{" "}
                  <code className="font-mono text-[#008386]">@ums.edu.my</code>
                  ).
                </p>
              </div>
            </div>

            <div className="mt-4 flex shrink-0 flex-wrap items-center gap-2.5 sm:mt-0">
              <Link
                href="/login?next=%2F"
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#4E2A84] px-4 py-2 text-sm font-bold text-white hover:bg-[#3A1E66] press-feedback"
              >
                <LogIn className="h-4 w-4" aria-hidden="true" />
                <span>Sign In</span>
              </Link>
              <Link
                href="/register"
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#CFCBD9] bg-white px-4 py-2 text-sm font-bold text-[#14121A] hover:border-[#4E2A84]"
              >
                <UserPlus className="h-4 w-4" aria-hidden="true" />
                <span>Register</span>
              </Link>
              <Link
                href="/?demo=1"
                className="rounded-lg border border-[#1D70B8]/40 bg-white px-3.5 py-2 text-sm font-bold text-[#1D70B8] hover:bg-[#EEF6FC]"
              >
                Demo Preview
              </Link>
            </div>
          </div>
        ) : source === "restricted" || source === "error" ? (
          <div
            role="alert"
            className="rounded-2xl border border-[#4E2A84]/30 bg-[#FAF7FD] p-5 text-center"
          >
            <h3 className="text-base font-extrabold text-[#4E2A84]">
              {source === "restricted"
                ? "Account verification required"
                : "Unable to load live listings"}
            </h3>
            <p className="mt-1 text-sm text-[#4A4656]">{notice}</p>
          </div>
        ) : featured.length === 0 ? (
          <div className="flex items-center gap-3 rounded-2xl border border-[#E6E3EE] bg-[#FAF9FC] px-5 py-4">
            <Package
              className="h-5 w-5 shrink-0 text-[#716C7D]"
              aria-hidden="true"
            />
            <p className="text-sm text-[#5B5668]">
              <span className="font-bold text-[#14121A]">
                No listings posted yet.
              </span>{" "}
              Check back soon for fresh student items on campus.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {featured.map((listing) => (
              <HomeListingCard
                key={listing.id}
                listing={listing}
                isFavourited={favouriteIds.includes(listing.id)}
                canFavourite={canFavourite}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
