import Link from "next/link";
import { ArrowRight, Lock, LogIn, User, Wrench } from "lucide-react";
import { ListingImage } from "@/components/shared/ListingImage";
import { formatRelativeTime, formatSenToRm } from "@/lib/format";
import type { CatalogDataSource, Listing } from "@/types/marketplace";

interface StudentServicesSectionProps {
  services: Listing[];
  source: CatalogDataSource;
  useDemo?: boolean;
}

function ServiceCard({ service }: { service: Listing }) {
  const detailHref = service.isDemo
    ? `/listings/${encodeURIComponent(service.slug)}?demo=1`
    : `/listings/${encodeURIComponent(service.slug)}`;

  const sellerInitials = (service.sellerDisplayName || "SV")
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const fallback = (
    <div className="flex h-full w-full flex-col justify-between bg-[#F0F5FA] p-3.5">
      <span className="self-start rounded-md bg-[#1D70B8] px-2 py-0.5 text-[11px] font-bold text-white">
        Student Service
      </span>
      <span className="text-sm font-bold italic text-[#1D70B8]">
        {service.categoryName}
      </span>
    </div>
  );

  return (
    <article className="group flex flex-col overflow-hidden rounded-2xl border border-[#E6E3EE] bg-white shadow-[0_2px_8px_rgba(20,18,26,0.04)] transition-all hover:-translate-y-1 hover:border-[#1D70B8]/40 hover:shadow-[0_8px_20px_rgba(29,112,184,0.1)]">
      <Link href={detailHref} className="flex flex-1 flex-col">
        {/* Service Image */}
        <div className="relative aspect-[16/10] w-full overflow-hidden bg-[#F5F4F8]">
          <ListingImage
            src={service.imageUrl}
            alt={service.imageAlt}
            fallback={fallback}
          />

          {/* Pricing Pill */}
          <div className="absolute bottom-2.5 left-2.5 rounded-lg bg-[#14121A]/90 px-2.5 py-1 shadow-sm backdrop-blur-xs">
            <span className="tabular-price text-[14.5px] font-extrabold tracking-tight text-white">
              {service.priceSen > 0
                ? `From ${formatSenToRm(service.priceSen)}`
                : "Free Consultation"}
            </span>
          </div>

          <span className="absolute top-2.5 right-2.5 rounded-md bg-[#EDF5FC] px-2 py-0.5 text-[10.5px] font-extrabold text-[#1D70B8] shadow-xs">
            Service
          </span>
        </div>

        {/* Card Body */}
        <div className="flex flex-1 flex-col justify-between p-3.5">
          <div>
            <span className="inline-block rounded-md bg-[#EDF5FC] px-2 py-0.5 text-[11px] font-bold text-[#1D70B8]">
              {service.categoryName}
            </span>

            <h3 className="mt-2 line-clamp-2 text-[14.5px] font-bold leading-snug text-[#14121A] group-hover:text-[#1D70B8]">
              {service.title}
            </h3>

            {service.description ? (
              <p className="mt-1 line-clamp-2 text-[12px] text-[#555062]">
                {service.description}
              </p>
            ) : null}
          </div>

          {/* Footer: Provider + Time */}
          <div className="mt-3.5 flex items-center justify-between border-t border-[#F0EDF5] pt-2.5 text-[11.5px] text-[#555062]">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#E5F0FA] text-[9.5px] font-extrabold text-[#1D70B8]">
                {sellerInitials}
              </span>
              <span className="truncate font-semibold text-[#14121A]">
                {service.sellerDisplayName}
              </span>
            </div>

            <span className="shrink-0 text-[11px] text-[#716C7D]">
              {formatRelativeTime(service.createdAt)}
            </span>
          </div>
        </div>
      </Link>
    </article>
  );
}

export function StudentServicesSection({
  services,
  source,
  useDemo = false,
}: StudentServicesSectionProps) {
  const viewAllHref = useDemo
    ? "/marketplace?type=service&demo=1"
    : "/marketplace?type=service";

  const featured = services.slice(0, 4);

  return (
    <section
      aria-labelledby="services-preview-heading"
      className="bori-container py-3 lg:py-4"
    >
      {/* Top Row: Heading + Subheading + View All */}
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[#E6E3EE] pb-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h2
              id="services-preview-heading"
              className="text-[22px] font-extrabold italic tracking-[-0.02em] text-[#111018] sm:text-[24px]"
            >
              Student Services
            </h2>
            <span
              className="h-2 w-2 rounded-full bg-[#1D70B8]"
              aria-hidden="true"
            />
          </div>
          <p className="mt-0.5 text-[13.5px] text-[#5B5668]">
            Explore services offered by fellow UMS students.
          </p>
        </div>

        <Link
          href={viewAllHref}
          className="group inline-flex items-center gap-1.5 text-[13.5px] font-bold text-[#1D70B8] hover:text-[#155894] press-feedback"
        >
          <span>View All Services</span>
          <ArrowRight
            className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
            aria-hidden="true"
          />
        </Link>
      </div>

      {/* Services Content Grid */}
      <div className="mt-4">
        {source === "auth_required" ? (
          <div className="rounded-2xl border border-[#E6E3EE] bg-[#FAF9FC] p-6 text-center">
            <Lock className="mx-auto h-6 w-6 text-[#1D70B8]" aria-hidden="true" />
            <h3 className="mt-2 text-base font-bold text-[#14121A]">
              Sign in to browse live student services
            </h3>
            <p className="mt-1 text-sm text-[#5B5668]">
              Campus services are visible exclusively to verified UMS students and staff.
            </p>
            <Link
              href="/login?next=%2Fmarketplace%3Ftype%3Dservice"
              className="mt-3.5 inline-flex items-center gap-1.5 rounded-lg bg-[#1D70B8] px-4 py-2 text-sm font-bold text-white hover:bg-[#155894]"
            >
              <LogIn className="h-4 w-4" aria-hidden="true" />
              <span>Sign In with UMS Email</span>
            </Link>
          </div>
        ) : featured.length === 0 ? (
          <div className="rounded-2xl border border-[#E6E3EE] bg-[#FAF9FC] p-7 text-center">
            <Wrench className="mx-auto h-7 w-7 text-[#716C7D]" aria-hidden="true" />
            <h3 className="mt-2 text-base font-bold text-[#14121A]">
              No student services listed yet
            </h3>
            <p className="mt-1 text-sm text-[#5B5668]">
              Have a skill to share? Graphic design, tutoring, typing, or moving help will be available for student listing in Phase 3.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 sm:gap-5">
            {featured.map((service) => (
              <ServiceCard key={service.id} service={service} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
