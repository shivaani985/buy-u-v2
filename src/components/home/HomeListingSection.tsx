import Link from "next/link";
import {
  ArrowRight,
  Lock,
  LogIn,
  MapPin,
  Package,
  UserPlus,
} from "lucide-react";
import { ListingImage } from "@/components/shared/ListingImage";
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
}

const BADGE_STYLES: Record<Listing["listingType"], string> = {
  preloved: "bg-[#F4F1FA] text-[#4E2A84]",
  business: "bg-[#EDF5FC] text-[#1D70B8]",
  food: "bg-[#EDFAF9] text-[#008386]",
  service: "bg-[#EDFAF9] text-[#008386]",
  free: "bg-[#F3F2F6] text-[#14121A]",
};

function HomeListingCard({ listing }: { listing: Listing }) {
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
    <div className="flex h-full w-full flex-col justify-between bg-[#F4F1FA] p-3.5">
      <span className="self-start rounded-md bg-[#4E2A84] px-2 py-0.5 text-[11px] font-bold text-white">
        {formatListingType(listing.listingType)}
      </span>
      <span className="text-sm font-bold italic text-[#4E2A84]">
        {listing.categoryName}
      </span>
    </div>
  );

  return (
    <article className="group flex flex-col overflow-hidden rounded-2xl border border-[#E6E3EE] bg-white shadow-[0_2px_8px_rgba(20,18,26,0.04)] transition-all hover:-translate-y-1 hover:border-[#4E2A84]/40 hover:shadow-[0_8px_20px_rgba(78,42,132,0.1)]">
      <Link href={detailHref} className="flex flex-1 flex-col">
        {/* Product Photograph + Overlay Badges */}
        <div className="relative aspect-[4/3] w-full overflow-hidden bg-[#F5F4F8]">
          <ListingImage
            src={listing.imageUrl}
            alt={listing.imageAlt}
            fallback={fallback}
          />

          {/* Prominent RM Price Badge (High-contrast accessible pill on image) */}
          <div className="absolute bottom-2.5 left-2.5 rounded-lg bg-[#14121A]/90 px-2.5 py-1 shadow-sm backdrop-blur-xs">
            <span className="tabular-price text-[15px] font-extrabold tracking-tight text-white sm:text-[16px]">
              {formatSenToRm(listing.priceSen)}
            </span>
          </div>

          {/* Condition Badge (ONLY when real data exists) */}
          {listing.condition ? (
            <span className="absolute top-2.5 right-2.5 rounded-md bg-white/95 px-2 py-0.5 text-[10.5px] font-extrabold uppercase tracking-wide text-[#4E2A84] shadow-xs">
              {listing.condition}
            </span>
          ) : null}

          {/* Demo badge if demo */}
          {listing.isDemo ? (
            <span className="absolute top-2.5 left-2.5 rounded-md border border-[#1D70B8]/30 bg-white/95 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-[#14538A]">
              Demo
            </span>
          ) : null}

          {/* Stock status */}
          {listing.availableStock === 0 ? (
            <span className="absolute top-2.5 right-2.5 rounded-md bg-[#BA1A1A] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
              Out of stock
            </span>
          ) : null}
        </div>

        {/* Card Body */}
        <div className="flex flex-1 flex-col justify-between p-3.5">
          <div>
            {/* Category Pill */}
            <div className="flex items-center gap-2">
              <span
                className={`inline-block rounded-md px-2 py-0.5 text-[11px] font-bold ${BADGE_STYLES[listing.listingType]}`}
              >
                {listing.categoryName}
              </span>
            </div>

            {/* Title */}
            <h3 className="mt-2 line-clamp-2 text-[14.5px] font-bold leading-snug text-[#14121A] group-hover:text-[#4E2A84]">
              {listing.title}
            </h3>

            {/* Collection Location */}
            <div className="mt-2 flex items-center gap-1.5 text-[12px] text-[#555062]">
              <MapPin
                className="h-3.5 w-3.5 shrink-0 text-[#008386]"
                aria-hidden="true"
              />
              <span className="truncate">{listing.campusArea}</span>
            </div>
          </div>

          {/* Card Footer: Seller Avatar + Name + Relative Time */}
          <div className="mt-3.5 flex items-center justify-between border-t border-[#F0EDF5] pt-2.5 text-[11.5px] text-[#555062]">
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#EFEAF8] text-[9.5px] font-extrabold text-[#4E2A84]">
                {sellerInitials}
              </span>
              <span className="truncate font-semibold text-[#14121A]">
                {listing.sellerDisplayName}
              </span>
            </div>

            <span className="shrink-0 text-[11px] text-[#716C7D]">
              {formatRelativeTime(listing.createdAt)}
            </span>
          </div>
        </div>
      </Link>
    </article>
  );
}

export function HomeListingSection({
  listings,
  source,
  notice,
  useDemo = false,
}: HomeListingSectionProps) {
  const viewAllHref = useDemo ? "/marketplace?demo=1" : "/marketplace";

  // Filter products for Latest on Campus (exclude service and free which have dedicated preview sections)
  const productListings = listings.filter(
    (item) => item.listingType !== "service" && item.listingType !== "free"
  );
  const featured = productListings.slice(0, 8);

  return (
    <section
      aria-labelledby="latest-heading"
      className="bori-container py-3 lg:py-4"
    >
      {/* Top Row: Left Heading + Subheading, Right View All */}
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[#E6E3EE] pb-3">
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
          <div className="flex flex-col justify-between rounded-2xl border border-[#E6E3EE] bg-[#FAF9FC] p-6 sm:flex-row sm:items-center sm:gap-6">
            <div className="flex items-start gap-3.5">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#4E2A84] text-white">
                <Lock className="h-5 w-5" aria-hidden="true" />
              </span>
              <div>
                <h3 className="text-base font-extrabold text-[#14121A] sm:text-lg">
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
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#4E2A84] px-4 py-2.5 text-sm font-bold text-white hover:bg-[#3A1E66] press-feedback"
              >
                <LogIn className="h-4 w-4" aria-hidden="true" />
                <span>Sign In</span>
              </Link>
              <Link
                href="/register"
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#CFCBD9] bg-white px-4 py-2.5 text-sm font-bold text-[#14121A] hover:border-[#4E2A84]"
              >
                <UserPlus className="h-4 w-4" aria-hidden="true" />
                <span>Register</span>
              </Link>
              <Link
                href="/?demo=1"
                className="rounded-lg border border-[#1D70B8]/40 bg-white px-3.5 py-2.5 text-sm font-bold text-[#1D70B8] hover:bg-[#EEF6FC]"
              >
                Demo Preview
              </Link>
            </div>
          </div>
        ) : source === "restricted" || source === "error" ? (
          <div
            role="alert"
            className="rounded-2xl border border-[#4E2A84]/30 bg-[#FAF7FD] p-6 text-center"
          >
            <h3 className="text-base font-extrabold text-[#4E2A84]">
              {source === "restricted"
                ? "Account verification required"
                : "Unable to load live listings"}
            </h3>
            <p className="mt-1 text-sm text-[#4A4656]">{notice}</p>
          </div>
        ) : featured.length === 0 ? (
          <div className="rounded-2xl border border-[#E6E3EE] bg-[#FAF9FC] p-8 text-center">
            <Package
              className="mx-auto h-8 w-8 text-[#716C7D]"
              aria-hidden="true"
            />
            <h3 className="mt-2 text-base font-bold text-[#14121A]">
              No listings posted yet
            </h3>
            <p className="mt-1 text-sm text-[#5B5668]">
              Be the first student to list pre-loved books, tech, or dorm items.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 sm:gap-5">
            {featured.map((listing) => (
              <HomeListingCard key={listing.id} listing={listing} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
