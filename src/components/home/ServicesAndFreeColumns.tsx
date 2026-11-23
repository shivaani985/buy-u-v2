import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Gift, Lock, LogIn, MapPin, Wrench } from "lucide-react";
import { ListingImage } from "@/components/shared/ListingImage";
import { formatRelativeTime, formatSenToRm } from "@/lib/format";
import type { CatalogDataSource, Listing } from "@/types/marketplace";

interface ServicesAndFreeColumnsProps {
  services: Listing[];
  freeItems: Listing[];
  source: CatalogDataSource;
  useDemo?: boolean;
}

function CompactPreviewCard({
  item,
  variant,
}: {
  item: Listing;
  variant: "service" | "free";
}) {
  const detailHref = item.isDemo
    ? `/listings/${encodeURIComponent(item.slug)}?demo=1`
    : `/listings/${encodeURIComponent(item.slug)}`;

  const initials = (item.sellerDisplayName || "UM")
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const isService = variant === "service";
  const accentText = isService ? "text-[#1D70B8]" : "text-[#008386]";
  const accentBg = isService ? "bg-[#EDF5FC]" : "bg-[#EDFAF9]";
  const hoverBorder = isService
    ? "hover:border-[#1D70B8]/40"
    : "hover:border-[#008386]/40";

  const fallback = (
    <div
      className={`flex h-full w-full flex-col justify-between p-3 ${
        isService ? "bg-[#F0F5FA]" : "bg-[#F0FAF9]"
      }`}
    >
      <span
        className={`self-start rounded-md px-2 py-0.5 text-[10px] font-bold text-white ${
          isService ? "bg-[#1D70B8]" : "bg-[#008386]"
        }`}
      >
        {isService ? "Service" : "Free Item"}
      </span>
      <span className={`text-xs font-bold italic ${accentText}`}>
        {item.categoryName}
      </span>
    </div>
  );

  return (
    <article
      className={`group flex flex-col overflow-hidden rounded-xl border border-[#E6E3EE] bg-white shadow-[0_2px_6px_rgba(20,18,26,0.04)] transition-all hover:-translate-y-0.5 ${hoverBorder}`}
    >
      <Link href={detailHref} className="flex flex-1 flex-col">
        <div className="relative aspect-[16/10] w-full overflow-hidden bg-[#F5F4F8]">
          <ListingImage
            src={item.imageUrl}
            alt={item.imageAlt}
            fallback={fallback}
          />
          <div
            className={`absolute bottom-2 left-2 rounded-md px-2 py-0.5 shadow-sm ${
              isService ? "bg-[#14121A]/90" : "bg-[#008386]"
            }`}
          >
            <span className="tabular-price text-[12.5px] font-extrabold tracking-tight text-white">
              {isService
                ? item.priceSen > 0
                  ? `From ${formatSenToRm(item.priceSen)}`
                  : "Free"
                : "FREE"}
            </span>
          </div>
        </div>

        <div className="flex flex-1 flex-col justify-between p-3">
          <div>
            <h3
              className={`line-clamp-1 text-[14px] font-extrabold leading-snug text-[#14121A] ${
                isService
                  ? "group-hover:text-[#1D70B8]"
                  : "group-hover:text-[#008386]"
              }`}
            >
              {item.title}
            </h3>

            <div className="mt-1 flex items-center gap-1 text-[11.5px] text-[#6E6A7C]">
              <MapPin
                className="h-3 w-3 shrink-0 text-[#8E899E]"
                aria-hidden="true"
              />
              <span className="truncate">{item.campusArea}</span>
            </div>

            <div className="mt-1.5">
              <span
                className={`inline-block rounded-md px-2 py-0.5 text-[10.5px] font-bold ${accentBg} ${accentText}`}
              >
                {item.categoryName}
              </span>
            </div>
          </div>

          {item.sellerDisplayName ? (
            <div className="mt-2.5 flex items-center justify-between border-t border-[#F0EDF5] pt-2 text-[10.5px] text-[#6E6A7C]">
              <div className="flex min-w-0 items-center gap-1.5">
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[8.5px] font-extrabold ${accentBg} ${accentText}`}
                >
                  {initials}
                </span>
                <span className="truncate font-semibold text-[#3E3B4B]">
                  {item.sellerDisplayName}
                </span>
              </div>
              <span className="shrink-0 text-[#858094]">
                {formatRelativeTime(item.createdAt)}
              </span>
            </div>
          ) : null}
        </div>
      </Link>
    </article>
  );
}

export function ServicesAndFreeColumns({
  services,
  freeItems,
  source,
  useDemo = false,
}: ServicesAndFreeColumnsProps) {
  const demoParam = useDemo ? "&demo=1" : "";
  const featuredServices = services.slice(0, 2);
  const featuredFree = freeItems.slice(0, 2);

  return (
    <section
      aria-label="Student Services and Free Items"
      className="bori-container pt-2 pb-6 lg:pt-3 lg:pb-8"
    >
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:gap-5">
        {/* LEFT COLUMN: Student Services Banner + Previews */}
        <div className="flex flex-col gap-3">
          {/* Student Services Bori Banner */}
          <article className="relative flex min-h-[112px] items-stretch overflow-hidden rounded-2xl border border-[#E4E1EE] bg-white shadow-[0_2px_8px_rgba(20,18,26,0.04)] sm:min-h-[120px]">
            <div className="relative w-[116px] shrink-0 sm:w-[155px] xl:w-[175px]">
              <div
                className="promo-panel-left absolute inset-0 bg-[#1D70B8]"
                aria-hidden="true"
              />
              <div className="relative z-10 flex h-full w-full items-end justify-center px-2 pt-1">
                <div className="relative h-[98px] w-[98px] sm:h-[108px] sm:w-[128px]">
                  <Image
                    src="/images/bori/bori-services.png"
                    alt="Bori working on a Buy-U laptop for student services"
                    fill
                    sizes="(max-width: 640px) 98px, 128px"
                    className="object-contain object-bottom select-none"
                  />
                </div>
              </div>
            </div>

            <div className="relative z-10 flex flex-1 flex-col justify-center py-2.5 pl-2.5 pr-6 sm:py-3 sm:pl-3.5 sm:pr-8">
              <h2 className="text-[18px] font-extrabold italic leading-tight tracking-[-0.02em] text-[#111018] sm:text-[21px]">
                Student Services
              </h2>
              <p className="mt-0.5 max-w-[36ch] text-[12.5px] leading-snug text-[#454252] sm:text-[13px]">
                Get help from fellow students — from notes and printing to event
                design.
              </p>
              <div className="mt-2.5">
                <Link
                  href={`/marketplace?type=service${demoParam}`}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#1D70B8] px-3.5 py-1 text-[12.5px] font-bold text-white hover:bg-[#155894] press-feedback"
                >
                  <span>Find a Service</span>
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              </div>
            </div>

            <div
              className="promo-edge-stripe pointer-events-none absolute top-0 right-0 bottom-0 w-6 bg-[#1D70B8] sm:w-7"
              aria-hidden="true"
            />
          </article>

          {/* Student Services Preview Area */}
          {source === "auth_required" ? (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-[#E6E3EE] bg-[#FAF9FC] px-4 py-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <Lock
                  className="h-4 w-4 shrink-0 text-[#1D70B8]"
                  aria-hidden="true"
                />
                <p className="text-xs font-medium text-[#555062] sm:text-[13px]">
                  Sign in with your UMS email to view student services.
                </p>
              </div>
              <Link
                href="/login?next=%2Fmarketplace%3Ftype%3Dservice"
                className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-[#1D70B8] px-3 py-1.5 text-xs font-bold text-white hover:bg-[#155894]"
              >
                <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Sign In</span>
              </Link>
            </div>
          ) : featuredServices.length === 0 ? (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-[#E6E3EE] bg-[#FAF9FC] px-4 py-3.5">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#EDF5FC] text-[#1D70B8]">
                  <Wrench className="h-4 w-4" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <p className="text-[13.5px] font-bold text-[#14121A]">
                    No student services posted yet
                  </p>
                  <p className="text-xs text-[#6E6A7C]">
                    Check back soon for tutoring, printing, design, and campus
                    help.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {featuredServices.map((service) => (
                <CompactPreviewCard
                  key={service.id}
                  item={service}
                  variant="service"
                />
              ))}
            </div>
          )}
        </div>

        {/* RIGHT COLUMN: Free Items Banner + Previews */}
        <div className="flex flex-col gap-3">
          {/* Free Items Bori Banner */}
          <article className="relative flex min-h-[112px] items-stretch overflow-hidden rounded-2xl border border-[#E4E1EE] bg-white shadow-[0_2px_8px_rgba(20,18,26,0.04)] sm:min-h-[120px]">
            <div className="relative w-[116px] shrink-0 sm:w-[155px] xl:w-[175px]">
              <div
                className="promo-panel-left absolute inset-0 bg-[#00A3A6]"
                aria-hidden="true"
              />
              <div className="relative z-10 flex h-full w-full items-end justify-center px-2 pt-1">
                <div className="relative h-[98px] w-[98px] sm:h-[108px] sm:w-[128px]">
                  <Image
                    src="/images/bori/bori-free-items.png"
                    alt="Bori smiling while holding a box of reusable campus free items"
                    fill
                    sizes="(max-width: 640px) 98px, 128px"
                    className="object-contain object-bottom select-none"
                  />
                </div>
              </div>
            </div>

            <div className="relative z-10 flex flex-1 flex-col justify-center py-2.5 pl-2.5 pr-6 sm:py-3 sm:pl-3.5 sm:pr-8">
              <h2 className="text-[18px] font-extrabold italic leading-tight tracking-[-0.02em] text-[#111018] sm:text-[21px]">
                Free Items
              </h2>
              <p className="mt-0.5 max-w-[36ch] text-[12.5px] leading-snug text-[#454252] sm:text-[13px]">
                Give or pick up items for free and keep them in use on campus.
              </p>
              <div className="mt-2.5">
                <Link
                  href={`/marketplace?type=free${demoParam}`}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#008386] px-3.5 py-1 text-[12.5px] font-bold text-white hover:bg-[#00696B] press-feedback"
                >
                  <span>See Free Items</span>
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              </div>
            </div>

            <div
              className="promo-edge-stripe pointer-events-none absolute top-0 right-0 bottom-0 w-6 bg-[#00A3A6] sm:w-7"
              aria-hidden="true"
            />
          </article>

          {/* Free Items Preview Area */}
          {source === "auth_required" ? (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-[#E6E3EE] bg-[#FAF9FC] px-4 py-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <Lock
                  className="h-4 w-4 shrink-0 text-[#008386]"
                  aria-hidden="true"
                />
                <p className="text-xs font-medium text-[#555062] sm:text-[13px]">
                  Sign in with your UMS email to view campus free items.
                </p>
              </div>
              <Link
                href="/login?next=%2Fmarketplace%3Ftype%3Dfree"
                className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-[#008386] px-3 py-1.5 text-xs font-bold text-white hover:bg-[#00696B]"
              >
                <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Sign In</span>
              </Link>
            </div>
          ) : featuredFree.length === 0 ? (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-[#E6E3EE] bg-[#FAF9FC] px-4 py-3.5">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#EDFAF9] text-[#008386]">
                  <Gift className="h-4 w-4" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <p className="text-[13.5px] font-bold text-[#14121A]">
                    No free items shared right now
                  </p>
                  <p className="text-xs text-[#6E6A7C]">
                    Check back soon for campus giveaways and donation-spot
                    drops.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {featuredFree.map((item) => (
                <CompactPreviewCard
                  key={item.id}
                  item={item}
                  variant="free"
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
