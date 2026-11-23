import Link from "next/link";
import { ArrowRight, PlusSquare, ShieldCheck, Store, Users } from "lucide-react";

const HERO_PANELS = [
  {
    id: "student-1",
    bg: "bg-[#4E2A84]",
    text: "text-white",
    subtext: "text-[#E6DCF5]",
    tag: "Pre-Loved & Textbooks",
    caption: "Student Cutout Slot 01",
    assetPath: "/images/home/student-1.png",
    icon: Store,
  },
  {
    id: "student-2",
    bg: "bg-[#00A3A6]",
    text: "text-[#14121A]",
    subtext: "text-[#0E2F30]",
    tag: "Campus Services",
    caption: "Student Cutout Slot 02",
    assetPath: "/images/home/student-2.png",
    icon: Users,
  },
  {
    id: "student-3",
    bg: "bg-[#1D70B8]",
    text: "text-white",
    subtext: "text-[#D9ECFA]",
    tag: "Student Ventures",
    caption: "Student Cutout Slot 03",
    assetPath: "/images/home/student-3.png",
    icon: ShieldCheck,
  },
];

export function EditorialHero() {
  return (
    <section
      aria-labelledby="hero-heading"
      className="border-b-2 border-[#14121A] bg-[#F7F7F5]"
    >
      <div className="mx-auto grid w-full max-w-[1680px] gap-8 px-4 py-10 sm:px-6 sm:py-14 lg:grid-cols-12 lg:items-stretch lg:gap-10 lg:px-10 xl:px-14">
        {/* Left Editorial Column */}
        <div className="flex flex-col justify-between lg:col-span-6">
          <div>
            <h1
              id="hero-heading"
              className="text-4xl font-extrabold leading-[1.05] tracking-[-0.03em] text-[#14121A] sm:text-5xl xl:text-6xl text-balance"
            >
              Built for{" "}
              <span className="font-editorial italic font-bold text-[#4E2A84]">
                UMSKAL
              </span>{" "}
              students who trade, make, and{" "}
              <span className="font-editorial italic font-bold text-[#007D80]">
                share.
              </span>
            </h1>

            <p className="mt-5 max-w-[60ch] text-base leading-relaxed text-[#4A4656] sm:text-lg">
              Buy-U connects verified Universiti Malaysia Sabah (Labuan) students
              and staff in one campus marketplace — from pre-loved textbooks and
              hostel gear to student ventures, fixed services, and free share
              items.
            </p>

            {/* Primary & Secondary CTAs */}
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href="/marketplace"
                className="inline-flex items-center gap-2 bg-[#4E2A84] px-6 py-3.5 text-sm font-bold text-white hover:bg-[#381C63] press-feedback editorial-cut-tr"
              >
                <span>Browse Marketplace</span>
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>

              <Link
                href="/account#sell-roadmap"
                className="inline-flex items-center gap-2 border-2 border-[#14121A] bg-white px-6 py-3 text-sm font-bold text-[#14121A] hover:border-[#00A3A6] hover:bg-[#EBF8F8] press-feedback"
              >
                <PlusSquare className="h-4 w-4 text-[#007D80]" aria-hidden="true" />
                <span>Sell an Item (Phase 2)</span>
              </Link>
            </div>
          </div>

          {/* Grounded Campus Context Strip */}
          <dl className="mt-10 grid grid-cols-1 gap-4 border-t border-[#14121A] pt-6 sm:grid-cols-3">
            <div>
              <dt className="text-xs font-bold uppercase tracking-wider text-[#4E2A84]">
                Campus Focus
              </dt>
              <dd className="mt-1 text-sm font-semibold text-[#14121A]">
                UMSKAL, Labuan
              </dd>
            </div>
            <div>
              <dt className="text-xs font-bold uppercase tracking-wider text-[#007D80]">
                Community Scope
              </dt>
              <dd className="mt-1 text-sm font-semibold text-[#14121A]">
                UMS Students &amp; Staff
              </dd>
            </div>
            <div>
              <dt className="text-xs font-bold uppercase tracking-wider text-[#1D70B8]">
                Local Pickup
              </dt>
              <dd className="mt-1 text-sm font-semibold text-[#14121A]">
                Kolej Kediaman &amp; Main Block
              </dd>
            </div>
          </dl>
        </div>

        {/* Right Editorial Cutout Composition (3 Flat Angular Brand Panels) */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:col-span-6">
          {HERO_PANELS.map((panel, index) => {
            const Icon = panel.icon;
            return (
              <div
                key={panel.id}
                className={`flex min-h-[210px] flex-col justify-between border-2 border-[#14121A] p-5 sm:min-h-[340px] ${panel.bg} ${panel.text} ${
                  index === 0
                    ? "editorial-cut-tr"
                    : index === 2
                      ? "editorial-cut-bl"
                      : ""
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-extrabold uppercase tracking-wider">
                    {panel.tag}
                  </span>
                  <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                </div>

                <div className="my-6 border border-current/30 px-3 py-4 text-center">
                  <p className="font-editorial text-lg font-bold italic">
                    {panel.caption}
                  </p>
                  <p className={`mt-1 text-xs ${panel.subtext}`}>
                    Drop approved PNG at{" "}
                    <code className="font-mono text-[11px]">
                      public{panel.assetPath}
                    </code>
                  </p>
                </div>

                <p className={`text-xs font-semibold ${panel.subtext}`}>
                  Campus Pop Editorial Frame
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
