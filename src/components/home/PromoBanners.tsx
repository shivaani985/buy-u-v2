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
      aria-label="Campus services and free items"
      className="bori-container pt-1.5 pb-4 lg:pt-2 lg:pb-5"
    >
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* Left Banner: Student Services */}
        <article className="relative flex min-h-[136px] items-stretch overflow-hidden rounded-2xl border border-[#E4E1EE] bg-white shadow-[0_2px_10px_rgba(20,18,26,0.05)]">
          {/* Flat Blue Angled Art Panel */}
          <div className="relative w-[132px] shrink-0 sm:w-[190px] xl:w-[218px]">
            <div
              className="promo-panel-left absolute inset-0 bg-[#1D70B8]"
              aria-hidden="true"
            />
            <div className="relative z-10 flex h-full w-full items-end justify-center px-2 pt-1.5">
              <div className="relative h-[122px] w-[122px] sm:h-[132px] sm:w-[158px]">
                <Image
                  src="/images/bori/bori-services.png"
                  alt="Bori working on a Buy-U laptop for student services"
                  fill
                  sizes="(max-width: 640px) 122px, 158px"
                  className="object-contain object-bottom select-none"
                />
              </div>
            </div>
          </div>

          {/* Copy & CTA */}
          <div className="relative z-10 flex flex-1 flex-col justify-center py-3.5 pl-3 pr-7 sm:py-4 sm:pl-4 sm:pr-10">
            <h2 className="text-[21px] font-extrabold italic leading-tight tracking-[-0.02em] text-[#111018] sm:text-[25px]">
              Student Services
            </h2>
            <p className="mt-1 max-w-[38ch] text-[13px] leading-snug text-[#454252] sm:text-[13.5px]">
              Get help from fellow students — from notes and printing to event
              design and more.
            </p>
            <div className="mt-3">
              <Link
                href={`/marketplace?type=service${demoParam}`}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#1D70B8] px-4 py-1.5 text-[13px] font-bold text-white hover:bg-[#155894] press-feedback"
              >
                <span>Find a Service</span>
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </div>
          </div>

          {/* Right Angled Blue Edge Accent */}
          <div
            className="promo-edge-stripe pointer-events-none absolute top-0 right-0 bottom-0 w-7 bg-[#1D70B8] sm:w-9"
            aria-hidden="true"
          />
        </article>

        {/* Right Banner: Free Items */}
        <article className="relative flex min-h-[136px] items-stretch overflow-hidden rounded-2xl border border-[#E4E1EE] bg-white shadow-[0_2px_10px_rgba(20,18,26,0.05)]">
          {/* Flat Teal Angled Art Panel */}
          <div className="relative w-[132px] shrink-0 sm:w-[190px] xl:w-[218px]">
            <div
              className="promo-panel-left absolute inset-0 bg-[#00A3A6]"
              aria-hidden="true"
            />
            <div className="relative z-10 flex h-full w-full items-end justify-center px-2 pt-1.5">
              <div className="relative h-[122px] w-[122px] sm:h-[132px] sm:w-[158px]">
                <Image
                  src="/images/bori/bori-free-items.png"
                  alt="Bori smiling while holding a box of reusable campus free items"
                  fill
                  sizes="(max-width: 640px) 122px, 158px"
                  className="object-contain object-bottom select-none"
                />
              </div>
            </div>
          </div>

          {/* Copy & CTA */}
          <div className="relative z-10 flex flex-1 flex-col justify-center py-3.5 pl-3 pr-7 sm:py-4 sm:pl-4 sm:pr-10">
            <h2 className="text-[21px] font-extrabold italic leading-tight tracking-[-0.02em] text-[#111018] sm:text-[25px]">
              Free Items
            </h2>
            <p className="mt-1 max-w-[38ch] text-[13px] leading-snug text-[#454252] sm:text-[13.5px]">
              Give or pick up items for free and keep them in use on campus.
            </p>
            <div className="mt-3">
              <Link
                href={`/marketplace?type=free${demoParam}`}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#008386] px-4 py-1.5 text-[13px] font-bold text-white hover:bg-[#00696B] press-feedback"
              >
                <span>See Free Items</span>
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </div>
          </div>

          {/* Right Angled Teal Edge Accent */}
          <div
            className="promo-edge-stripe pointer-events-none absolute top-0 right-0 bottom-0 w-7 bg-[#00A3A6] sm:w-9"
            aria-hidden="true"
          />
        </article>
      </div>
    </section>
  );
}
