import Link from "next/link";
import { ArrowRight, Gift, Lock, LogIn, MapPin } from "lucide-react";
import { ListingImage } from "@/components/shared/ListingImage";
import { formatRelativeTime } from "@/lib/format";
import type { CatalogDataSource, Listing } from "@/types/marketplace";

interface FreeItemsSectionProps {
  freeItems: Listing[];
  source: CatalogDataSource;
  useDemo?: boolean;
}

function FreeItemCard({ item }: { item: Listing }) {
  const detailHref = item.isDemo
    ? `/listings/${encodeURIComponent(item.slug)}?demo=1`
    : `/listings/${encodeURIComponent(item.slug)}`;

  const contributorInitials = (item.sellerDisplayName || "UM")
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const fallback = (
    <div className="flex h-full w-full flex-col justify-between bg-[#F0FAF9] p-3.5">
      <span className="self-start rounded-md bg-[#008386] px-2 py-0.5 text-[11px] font-bold text-white">
        Free Giveaway
      </span>
      <span className="text-sm font-bold italic text-[#008386]">
        {item.categoryName}
      </span>
    </div>
  );

  return (
    <article className="group flex flex-col overflow-hidden rounded-2xl border border-[#E6E3EE] bg-white shadow-[0_2px_8px_rgba(20,18,26,0.04)] transition-all hover:-translate-y-1 hover:border-[#008386]/40 hover:shadow-[0_8px_20px_rgba(0,131,134,0.1)]">
      <Link href={detailHref} className="flex flex-1 flex-col">
        {/* Item Image */}
        <div className="relative aspect-[16/10] w-full overflow-hidden bg-[#F5F4F8]">
          <ListingImage
            src={item.imageUrl}
            alt={item.imageAlt}
            fallback={fallback}
          />

          {/* FREE Badge */}
          <div className="absolute bottom-2.5 left-2.5 rounded-lg bg-[#008386] px-2.5 py-1 shadow-sm">
            <span className="text-[13px] font-extrabold uppercase tracking-wide text-white">
              FREE
            </span>
          </div>

          {/* Condition tag if present */}
          {item.condition ? (
            <span className="absolute top-2.5 right-2.5 rounded-md bg-white/95 px-2 py-0.5 text-[10.5px] font-extrabold uppercase tracking-wide text-[#008386] shadow-xs">
              {item.condition}
            </span>
          ) : null}
        </div>

        {/* Card Body */}
        <div className="flex flex-1 flex-col justify-between p-3.5">
          <div>
            <span className="inline-block rounded-md bg-[#EDFAF9] px-2 py-0.5 text-[11px] font-bold text-[#008386]">
              Campus Giveaway
            </span>

            <h3 className="mt-2 line-clamp-2 text-[14.5px] font-bold leading-snug text-[#14121A] group-hover:text-[#008386]">
              {item.title}
            </h3>

            {/* Donation Spot */}
            <div className="mt-2 flex items-center gap-1.5 text-[12px] text-[#555062]">
              <MapPin
                className="h-3.5 w-3.5 shrink-0 text-[#008386]"
                aria-hidden="true"
              />
              <span className="truncate">{item.campusArea}</span>
            </div>
          </div>

          {/* Footer: Contributor + Time */}
          <div className="mt-3.5 flex items-center justify-between border-t border-[#F0EDF5] pt-2.5 text-[11.5px] text-[#555062]">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#E0F5F4] text-[9.5px] font-extrabold text-[#008386]">
                {contributorInitials}
              </span>
              <span className="truncate font-semibold text-[#14121A]">
                {item.sellerDisplayName}
              </span>
            </div>

            <span className="shrink-0 text-[11px] text-[#716C7D]">
              {formatRelativeTime(item.createdAt)}
            </span>
          </div>
        </div>
      </Link>
    </article>
  );
}

export function FreeItemsSection({
  freeItems,
  source,
  useDemo = false,
}: FreeItemsSectionProps) {
  const viewAllHref = useDemo
    ? "/marketplace?type=free&demo=1"
    : "/marketplace?type=free";

  const featured = freeItems.slice(0, 4);

  return (
    <section
      aria-labelledby="free-items-preview-heading"
      className="bori-container py-3 lg:py-4"
    >
      {/* Top Row: Heading + Subheading + View All */}
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[#E6E3EE] pb-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h2
              id="free-items-preview-heading"
              className="text-[22px] font-extrabold italic tracking-[-0.02em] text-[#111018] sm:text-[24px]"
            >
              Free Items
            </h2>
            <span
              className="h-2 w-2 rounded-full bg-[#008386]"
              aria-hidden="true"
            />
          </div>
          <p className="mt-0.5 text-[13.5px] text-[#5B5668]">
            Find useful items shared by the UMS community.
          </p>
        </div>

        <Link
          href={viewAllHref}
          className="group inline-flex items-center gap-1.5 text-[13.5px] font-bold text-[#008386] hover:text-[#005e61] press-feedback"
        >
          <span>View All Free Items</span>
          <ArrowRight
            className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
            aria-hidden="true"
          />
        </Link>
      </div>

      {/* Free Items Content Grid */}
      <div className="mt-4">
        {source === "auth_required" ? (
          <div className="rounded-2xl border border-[#E6E3EE] bg-[#FAF9FC] p-6 text-center">
            <Lock className="mx-auto h-6 w-6 text-[#008386]" aria-hidden="true" />
            <h3 className="mt-2 text-base font-bold text-[#14121A]">
              Sign in to browse live free items
            </h3>
            <p className="mt-1 text-sm text-[#5B5668]">
              Campus giveaways and donation spots are visible to verified UMS members.
            </p>
            <Link
              href="/login?next=%2Fmarketplace%3Ftype%3Dfree"
              className="mt-3.5 inline-flex items-center gap-1.5 rounded-lg bg-[#008386] px-4 py-2 text-sm font-bold text-white hover:bg-[#00696B]"
            >
              <LogIn className="h-4 w-4" aria-hidden="true" />
              <span>Sign In with UMS Email</span>
            </Link>
          </div>
        ) : featured.length === 0 ? (
          <div className="rounded-2xl border border-[#E6E3EE] bg-[#FAF9FC] p-7 text-center">
            <Gift className="mx-auto h-7 w-7 text-[#716C7D]" aria-hidden="true" />
            <h3 className="mt-2 text-base font-bold text-[#14121A]">
              No free items listed right now
            </h3>
            <p className="mt-1 text-sm text-[#5B5668]">
              Graduating or moving hostels? Share books, lab coats, stationery, or dorm essentials at campus donation spots.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 sm:gap-5">
            {featured.map((item) => (
              <FreeItemCard key={item.id} item={item} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
