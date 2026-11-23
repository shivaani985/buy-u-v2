import Link from "next/link";
import { ArrowUpRight, MapPin } from "lucide-react";
import { formatListingType, formatRm } from "@/lib/format";
import type { Listing } from "@/types/marketplace";

interface ListingCardProps {
  listing: Listing;
}

const TYPE_STYLES: Record<
  Listing["listingType"],
  { bg: string; text: string; panelBg: string }
> = {
  preloved: {
    bg: "bg-[#4E2A84]",
    text: "text-white",
    panelBg: "bg-[#F3EEF9]",
  },
  student_business: {
    bg: "bg-[#1D70B8]",
    text: "text-white",
    panelBg: "bg-[#EEF5FB]",
  },
  food: {
    bg: "bg-[#00A3A6]",
    text: "text-[#14121A]",
    panelBg: "bg-[#EBF8F8]",
  },
  service: {
    bg: "bg-[#007D80]",
    text: "text-white",
    panelBg: "bg-[#EBF8F8]",
  },
  free: {
    bg: "bg-[#14121A]",
    text: "text-white",
    panelBg: "bg-[#F2F2F0]",
  },
};

export function ListingCard({ listing }: ListingCardProps) {
  const style = TYPE_STYLES[listing.listingType];

  return (
    <article className="group flex flex-col border border-[#14121A] bg-white transition-colors hover:border-[#4E2A84]">
      <Link
        href={`/listings/${encodeURIComponent(listing.slug)}`}
        className="flex flex-1 flex-col focus-visible:outline-offset-[-2px]"
      >
        {/* Media Frame */}
        <div
          className={`relative aspect-[4/3] w-full overflow-hidden border-b border-[#14121A] ${style.panelBg}`}
        >
          {listing.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={listing.imageUrl}
              alt={listing.imageAlt}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full flex-col justify-between p-4">
              <div className="flex items-start justify-between gap-2">
                <span
                  className={`inline-block px-2.5 py-1 text-xs font-bold uppercase tracking-wide ${style.bg} ${style.text}`}
                >
                  {formatListingType(listing.listingType)}
                </span>
                {listing.isDemo ? (
                  <span className="border border-[#14121A] bg-white px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-[#14121A]">
                    Demo
                  </span>
                ) : null}
              </div>

              <div className="flex items-end justify-between gap-2">
                <span className="font-editorial text-xl font-bold italic text-[#14121A]">
                  {listing.categoryName}
                </span>
                <span className="h-8 w-8 bg-[#14121A] text-white flex items-center justify-center group-hover:bg-[#4E2A84] transition-colors">
                  <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                </span>
              </div>
            </div>
          )}

          {listing.imageUrl ? (
            <div className="absolute top-3 left-3 flex flex-wrap gap-1.5">
              <span
                className={`px-2.5 py-1 text-xs font-bold uppercase tracking-wide ${style.bg} ${style.text}`}
              >
                {formatListingType(listing.listingType)}
              </span>
              {listing.isDemo ? (
                <span className="border border-[#14121A] bg-white px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-[#14121A]">
                  Demo
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Content */}
        <div className="flex flex-1 flex-col justify-between p-4 sm:p-5">
          <div>
            <h3 className="text-base font-bold leading-snug text-[#14121A] group-hover:text-[#4E2A84] line-clamp-2">
              {listing.title}
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-[#4A4656] line-clamp-2">
              {listing.description}
            </p>
          </div>

          <div className="mt-4 border-t border-[#E2E0E8] pt-3">
            <div className="flex items-baseline justify-between gap-2">
              <span
                className={`tabular-price text-xl font-extrabold tracking-tight ${
                  listing.priceRm <= 0 ? "text-[#007D80]" : "text-[#4E2A84]"
                }`}
              >
                {formatRm(listing.priceRm)}
              </span>
              {listing.condition ? (
                <span className="text-xs font-semibold text-[#4A4656]">
                  {listing.condition}
                </span>
              ) : null}
            </div>

            <div className="mt-2 flex items-center justify-between gap-2 text-xs text-[#4A4656]">
              <span className="inline-flex items-center gap-1 truncate">
                <MapPin className="h-3.5 w-3.5 shrink-0 text-[#1D70B8]" aria-hidden="true" />
                <span className="truncate">{listing.campusArea}</span>
              </span>
              <span className="shrink-0 font-semibold text-[#14121A]">
                {listing.sellerBadge}
              </span>
            </div>
          </div>
        </div>
      </Link>
    </article>
  );
}
