import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Tag, Wrench } from "lucide-react";
import type { AuthSessionSummary } from "@/types/marketplace";

interface EditorialHeroProps {
  session: AuthSessionSummary;
}

export function EditorialHero({ session }: EditorialHeroProps) {
  const role = (session.profile?.university_role ?? "").toLowerCase();
  const isStaff = session.isAuthenticated && role === "staff";

  // Role-aware secondary CTA (Decision #4):
  // - Guest: login flow -> honest seller roadmap page
  // - Student: visible "Sell an Item" -> honest /account#sell-roadmap ("Coming Soon")
  // - Staff: replaced with available browsing action (no misleading Sell button)
  const secondaryCta = isStaff
    ? {
        href: "/marketplace?type=service",
        label: "Explore Services",
        title: "Browse student services on campus",
        icon: "services" as const,
      }
    : {
        href: session.isAuthenticated
          ? "/account#sell-roadmap"
          : "/login?next=%2Faccount%23sell-roadmap",
        label: "Sell an Item",
        title: session.isAuthenticated
          ? "Seller onboarding — Coming Soon in Phase 3"
          : "Sign in with your UMS email to view upcoming seller onboarding",
        icon: "sell" as const,
      };

  return (
    <section
      aria-labelledby="hero-heading"
      className="bg-white pt-3 pb-1.5 lg:pt-3.5 lg:pb-2"
    >
      <div className="bori-container">
        <div className="grid grid-cols-1 items-center gap-4 lg:grid-cols-12 lg:gap-6">
          {/* Left Editorial Headline & CTAs */}
          <div className="anim-hero-copy lg:col-span-5 xl:col-span-5">
            <h1
              id="hero-heading"
              className="text-[38px] font-extrabold italic leading-[1.03] tracking-[-0.03em] text-[#111018] sm:text-[44px] lg:text-[48px] xl:text-[55px]"
            >
              <span className="block">The Campus</span>
              <span className="mt-0.5 inline-block bg-[#4E2A84] px-4 py-0.5 text-white hero-marketplace-slab sm:px-5">
                Marketplace
              </span>
              <span className="mt-0.5 block">
                <span className="inline-block">
                  for UMS Students
                  <span
                    className="anim-teal-bar mt-1.5 block h-[5.5px] w-full bg-[#00A3A6]"
                    aria-hidden="true"
                  />
                </span>
              </span>
            </h1>

            <p className="mt-3 max-w-[42ch] text-[14.5px] leading-[1.42] text-[#3E3B4B] sm:text-[15px]">
              Buy, sell, book student services, or share free items within the
              UMS community.
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-2.5">
              <Link
                href="/marketplace"
                className="inline-flex items-center gap-2 rounded-lg bg-[#4E2A84] px-5 py-2.5 text-[14px] font-bold text-white shadow-[0_2px_6px_rgba(78,42,132,0.22)] hover:bg-[#3A1E66] press-feedback"
              >
                <span>Browse Marketplace</span>
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>

              <Link
                href={secondaryCta.href}
                title={secondaryCta.title}
                className="inline-flex items-center gap-2 rounded-lg border-[1.5px] border-[#00A3A6] bg-white px-5 py-2.5 text-[14px] font-bold text-[#008386] hover:bg-[#EDF9F9] press-feedback"
              >
                {secondaryCta.icon === "services" ? (
                  <Wrench className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Tag className="h-4 w-4" aria-hidden="true" />
                )}
                <span>{secondaryCta.label}</span>
              </Link>
            </div>
          </div>

          {/* Right Bori Stage: Balanced Hero Stage (+15% height from UI-1.2) */}
          <div className="relative lg:col-span-7 xl:col-span-7">
            <div className="relative mx-auto flex h-[230px] w-full max-w-[545px] items-end justify-center overflow-visible sm:h-[270px] lg:h-[290px] xl:h-[312px]">
              {/* Back-left flat teal angular panel */}
              <div
                className="hero-panel-teal pointer-events-none absolute inset-x-0 top-6 bottom-0 bg-[#00A3A6] sm:top-7"
                aria-hidden="true"
              />

              {/* Back-right flat blue angular panel */}
              <div
                className="hero-panel-blue pointer-events-none absolute inset-x-0 top-7 bottom-0 bg-[#1D70B8] sm:top-8"
                aria-hidden="true"
              />

              {/* Complete 3D Bori mascot stage with campus props (plant, books, laptop, headphones, water bottle, and 3D speech bubbles) */}
              <div className="anim-hero-mascot relative z-10 flex h-full w-full items-end justify-center">
                <div className="relative h-full w-full">
                  <Image
                    src="/images/bori/bori-hero-scene.png"
                    alt="Bori, the friendly Buy-U campus mascot, surrounded by study essentials, laptop, headphones, and marketplace speech bubbles"
                    fill
                    priority
                    sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 545px"
                    className="object-contain object-bottom select-none"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
