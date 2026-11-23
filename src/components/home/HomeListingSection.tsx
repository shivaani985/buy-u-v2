import Link from "next/link";
import {
  ArrowRight,
  Lock,
  LogIn,
  Package,
  UserPlus,
} from "lucide-react";
import { ListingImage } from "@/components/shared/ListingImage";
import { formatListingType, formatSenToRm } from "@/lib/format";
import type { CatalogDataSource, Listing } from "@/types/marketplace";

interface HomeListingSectionProps {
  listings: Listing[];
  source: CatalogDataSource;
  notice?: string;
  useDemo?: boolean;
}

const BADGE_STYLES: Record<Listing["listingType"], string> = {
  preloved: "bg-[#EFE9F9] text-[#4E2A84]",
  business: "bg-[#E9F3FC] text-[#1D70B8]",
  food: "bg-[#E6F7F7] text-[#007D80]",
  service: "bg-[#E6F7F7] text-[#007D80]",
  free: "bg-[#EFEFF2] text-[#14121A]",
};

function HomeListingCard({ listing }: { listing: Listing }) {
  const detailHref = listing.isDemo
    ? `/listings/${encodeURIComponent(listing.slug)}?demo=1`
    : `/listings/${encodeURIComponent(listing.slug)}`;

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
    <article className="group flex flex-col overflow-hidden rounded-xl border border-[#E4E1EE] bg-white shadow-[0_2px_10px_rgba(20,18,26,0.05)] transition-all hover:-translate-y-0.5 hover:border-[#4E2A84]/50 hover:shadow-[0_6px_18px_rgba(78,42,132,0.1)]">
      <Link href={detailHref} className="flex flex-1 flex-col">
        <div className="relative aspect-[16/10] w-full overflow-hidden bg-[#F5F4F8]">
          <ListingImage
            src={listing.imageUrl}
            alt={listing.imageAlt}
            fallback={fallback}
          />
          {listing.isDemo ? (
            <span className="absolute top-2.5 left-2.5 rounded-md border border-[#1D70B8]/30 bg-white/95 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-[#14538A]">
              Demo
            </span>
          ) : null}
          {listing.availableStock === 0 ? (
            <span className="absolute bottom-2 right-2 rounded-md bg-[#14121A]/85 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
              Out of stock
            </span>
          ) : null}
        </div>

        <div className="flex flex-1 flex-col justify-between p-3">
          <div>
            <h3 className="line-clamp-2 text-[14px] font-bold leading-snug text-[#14121A] group-hover:text-[#4E2A84]">
              {listing.title}
            </h3>
            <p className="mt-0.5 truncate text-[12px] text-[#5B5668]">
              {listing.campusArea}
            </p>
          </div>

          <div className="mt-2.5 flex items-center justify-between gap-2 pt-0.5">
            <span
              className={`tabular-price shrink-0 whitespace-nowrap text-[15.5px] font-extrabold tracking-tight ${
                listing.priceSen <= 0 ? "text-[#008386]" : "text-[#14121A]"
              }`}
            >
              {formatSenToRm(listing.priceSen)}
            </span>
            <span
              className={`min-w-0 truncate rounded-md px-2 py-0.5 text-[11px] font-bold ${BADGE_STYLES[listing.listingType]}`}
            >
              {listing.categoryName}
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
  const featured = listings.slice(0, 5);
  const isLowInventory = featured.length > 0 && featured.length <= 3;

  return (
    <section
      aria-labelledby="latest-heading"
      className="bori-container py-2 lg:py-2.5"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-stretch lg:gap-5">
        {/* Left Angular Purple Editorial Intro Panel */}
        <div className="latest-chevron-panel flex shrink-0 flex-col justify-between bg-[#4E2A84] p-5 text-white lg:w-[255px] lg:pr-9 xl:w-[280px] xl:pr-10">
          <div>
            <h2
              id="latest-heading"
              className="text-[26px] font-extrabold italic leading-[1.08] tracking-[-0.02em] xl:text-[30px]"
            >
              <span className="block">Latest on</span>
              <span className="block">Campus</span>
            </h2>
            <span
              className="mt-2 block h-[4px] w-12 bg-[#00A3A6]"
              aria-hidden="true"
            />
            <p className="mt-2.5 text-[13px] leading-relaxed text-[#E9E2F6]">
              Fresh finds from the UMS community.
            </p>
          </div>

          <div className="mt-4">
            <Link
              href={viewAllHref}
              className="inline-flex items-center gap-1.5 rounded-lg bg-white px-4 py-2 text-[13px] font-extrabold text-[#4E2A84] shadow-[0_2px_6px_rgba(0,0,0,0.12)] hover:bg-[#F4F0FA] press-feedback"
            >
              <span>View All Listings</span>
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </div>
        </div>

        {/* Right Listings Area */}
        <div className="min-w-0 flex-1">
          {source === "auth_required" ? (
            <div className="flex h-full flex-col justify-between rounded-2xl border border-[#E4E1EE] bg-[#FAF9FC] p-6 sm:flex-row sm:items-center sm:gap-6">
              <div className="flex items-start gap-3.5">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#4E2A84] text-white">
                  <Lock className="h-5 w-5" aria-hidden="true" />
                </span>
                <div>
                  <h3 className="text-lg font-extrabold text-[#14121A]">
                    Sign in with your UMS email to see live campus listings
                  </h3>
                  <p className="mt-1 max-w-[54ch] text-sm leading-relaxed text-[#4A4656]">
                    Buy-U protects student and staff listings inside the
                    verified Universiti Malaysia Sabah community
                    (<code className="font-mono text-[#4E2A84]">@iluv.ums.edu.my</code>{" "}
                    &amp;{" "}
                    <code className="font-mono text-[#008386]">@ums.edu.my</code>).
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
              className="flex h-full flex-col justify-center rounded-2xl border border-[#4E2A84]/30 bg-[#FAF7FD] p-6"
            >
              <h3 className="text-base font-extrabold text-[#4E2A84]">
                {source === "restricted"
                  ? "Account verification required"
                  : "Unable to load live listings"}
              </h3>
              <p className="mt-1 text-sm text-[#4A4656]">{notice}</p>
            </div>
          ) : featured.length === 0 ? (
            <div className="flex h-full flex-col justify-center rounded-2xl border border-[#E4E1EE] bg-[#FAF9FC] p-6">
              <div className="flex items-center gap-2.5">
                <Package className="h-5 w-5 text-[#4E2A84]" aria-hidden="true" />
                <h3 className="text-base font-extrabold text-[#14121A]">
                  No published listings on campus right now
                </h3>
              </div>
              <p className="mt-1.5 max-w-[54ch] text-sm text-[#4A4656]">
                Published student items, services, and free notices will appear
                here automatically as UMSKAL members post them.
              </p>
            </div>
          ) : isLowInventory ? (
            /* Deliberate low-inventory composition: normal-sized real card(s) + clean live-status companion */
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
              {featured.map((listing) => (
                <HomeListingCard key={listing.id} listing={listing} />
              ))}

              <div className="flex flex-col justify-between rounded-xl border border-[#E4E1EE] bg-[#FAF9FC] p-5 sm:col-span-1 lg:col-span-2 xl:col-span-3 2xl:col-span-4">
                <div>
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-[#E6F7F7] px-3 py-1 text-xs font-bold text-[#007D80]">
                    Live UMSKAL Inventory
                  </span>
                  <h3 className="mt-3 text-lg font-extrabold text-[#14121A]">
                    {featured.length === 1
                      ? "1 published listing currently live on campus"
                      : `${featured.length} published listings currently live on campus`}
                  </h3>
                  <p className="mt-1.5 max-w-[56ch] text-sm leading-relaxed text-[#4A4656]">
                    Buy-U displays only real published items from verified UMS
                    members — never fictional placeholder products. New campus
                    finds appear here automatically as sellers publish.
                  </p>
                </div>

                <div className="mt-4 flex flex-wrap gap-2.5">
                  <Link
                    href={viewAllHref}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[#4E2A84] px-4 py-2 text-xs font-bold text-white hover:bg-[#3A1E66] press-feedback"
                  >
                    <span>Open Full Marketplace</span>
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </Link>
                  <Link
                    href="/marketplace?type=service"
                    className="rounded-lg border border-[#D4D1DF] bg-white px-4 py-2 text-xs font-bold text-[#14121A] hover:border-[#1D70B8] hover:text-[#1D70B8]"
                  >
                    Browse Services
                  </Link>
                </div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
              {featured.map((listing) => (
                <HomeListingCard key={listing.id} listing={listing} />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
