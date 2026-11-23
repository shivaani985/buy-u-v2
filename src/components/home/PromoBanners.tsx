import Image from "next/image";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

interface PromoBannersProps {
  useDemo?: boolean;
}

export function PromoBanners({ useDemo = false }: PromoBannersProps) {
  const demoParam = useDemo ? "&demo=1" : "";

  return (
    <section
      aria-label="Campus services and free items highlights"
      className="bori-container py-2 lg:py-2.5"
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Left Banner: Student Services (Compact: ~25% lower vertical height) */}
        <article className="relative flex min-h-[112px] items-stretch overflow-hidden rounded-2xl border border-[#E4E1EE] bg-white shadow-[0_2px_8px_rgba(20,18,26,0.04)] sm:min-h-[120px]">
          {/* Flat Blue Angled Art Panel */}
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

          {/* Copy & CTA */}
          <div className="relative z-10 flex flex-1 flex-col justify-center py-2.5 pl-2.5 pr-6 sm:py-3 sm:pl-3.5 sm:pr-8">
            <h2 className="text-[18px] font-extrabold italic leading-tight tracking-[-0.02em] text-[#111018] sm:text-[21px]">
              Student Services
            </h2>
            <p className="mt-0.5 max-w-[36ch] text-[12.5px] leading-snug text-[#454252] sm:text-[13px]">
              Get help from fellow students — from notes and printing to event design.
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

          {/* Right Angled Blue Edge Accent */}
          <div
            className="promo-edge-stripe pointer-events-none absolute top-0 right-0 bottom-0 w-6 bg-[#1D70B8] sm:w-7"
            aria-hidden="true"
          />
        </article>

        {/* Right Banner: Free Items (Compact: ~25% lower vertical height) */}
        <article className="relative flex min-h-[112px] items-stretch overflow-hidden rounded-2xl border border-[#E4E1EE] bg-white shadow-[0_2px_8px_rgba(20,18,26,0.04)] sm:min-h-[120px]">
          {/* Flat Teal Angled Art Panel */}
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

          {/* Copy & CTA */}
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

          {/* Right Angled Teal Edge Accent */}
          <div
            className="promo-edge-stripe pointer-events-none absolute top-0 right-0 bottom-0 w-6 bg-[#00A3A6] sm:w-7"
            aria-hidden="true"
          />
        </article>
      </div>
    </section>
  );
}
