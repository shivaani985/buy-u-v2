import Image from "next/image";
import Link from "next/link";
import { Home } from "lucide-react";

interface AuthLayoutProps {
  title: string;
  accentWord?: string;
  subtitle: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

function TealUnderlineSwoosh() {
  return (
    <svg
      viewBox="0 0 240 18"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="h-3.5 w-44 sm:w-56 text-[#008285] select-none"
      aria-hidden="true"
    >
      <path
        d="M4 14C60 4 175 4 236 14C175 7 65 7 4 14Z"
        fill="currentColor"
      />
    </svg>
  );
}

function TopRightWaves() {
  return (
    <svg
      viewBox="0 0 380 240"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="pointer-events-none absolute right-0 top-0 h-auto w-32 sm:w-64 md:w-80 lg:w-[380px] z-0 select-none opacity-80 sm:opacity-100"
      aria-hidden="true"
    >
      {/* Outer teal wave curve */}
      <path
        d="M80 0C160 35 250 85 380 240V0H80Z"
        fill="#008285"
      />
      {/* Inner purple wave curve */}
      <path
        d="M170 0C230 40 300 85 380 170V0H170Z"
        fill="#4E2A84"
      />
    </svg>
  );
}

function BottomLeftWaves() {
  return (
    <svg
      viewBox="0 0 540 180"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="pointer-events-none absolute bottom-0 left-0 h-auto w-64 sm:w-80 md:w-96 lg:w-[520px] z-0 select-none"
      aria-hidden="true"
    >
      {/* Teal flowing wave */}
      <path
        d="M0 80C100 45 200 70 330 120C410 150 480 165 540 170L540 180H0V80Z"
        fill="#008285"
      />
      {/* Deep purple grounding wave */}
      <path
        d="M0 110C90 85 190 105 320 145C390 165 460 175 510 180H0V110Z"
        fill="#4E2A84"
      />
    </svg>
  );
}

function BottomRightHibiscus() {
  return (
    <svg
      viewBox="0 0 220 220"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="pointer-events-none absolute -bottom-4 -right-4 h-auto w-36 sm:w-48 md:w-56 lg:w-64 z-0 select-none opacity-95"
      aria-hidden="true"
    >
      {/* Botanical Teal Leaves */}
      <path
        d="M110 170C95 155 80 165 60 180C75 190 95 188 110 170Z"
        fill="#008285"
      />
      <path
        d="M150 185C135 190 120 205 100 210C120 215 140 208 150 185Z"
        fill="#008285"
      />
      <path
        d="M70 180C55 170 40 185 25 200C45 205 60 195 70 180Z"
        fill="#00A3A6"
      />

      {/* Hibiscus (Bunga Raya) Blossom */}
      <g transform="translate(145, 145)">
        {/* Petal 1 - Top Left */}
        <path
          d="M0 0 C-32 -32 -70 -26 -76 5 C-80 32 -42 48 0 0Z"
          fill="#8056A8"
        />
        {/* Petal 2 - Top Right */}
        <path
          d="M0 0 C-16 -48 22 -75 48 -54 C75 -32 48 11 0 0Z"
          fill="#744B9E"
        />
        {/* Petal 3 - Right */}
        <path
          d="M0 0 C32 -21 75 -5 75 27 C75 58 27 42 0 0Z"
          fill="#6C4296"
        />
        {/* Petal 4 - Bottom */}
        <path
          d="M0 0 C21 32 11 75 -21 75 C-54 75 -38 27 0 0Z"
          fill="#7E53A7"
        />
        {/* Petal 5 - Left */}
        <path
          d="M0 0 C-38 11 -70 21 -65 54 C-58 75 -16 48 0 0Z"
          fill="#70479A"
        />

        {/* Delicate white petal vein contours */}
        <path
          d="M0 0 C-22 -16 -44 -13 -60 0"
          stroke="#FFFFFF"
          strokeWidth="1.5"
          strokeOpacity="0.45"
          strokeLinecap="round"
        />
        <path
          d="M0 0 C-5 -27 11 -44 28 -38"
          stroke="#FFFFFF"
          strokeWidth="1.5"
          strokeOpacity="0.45"
          strokeLinecap="round"
        />
        <path
          d="M0 0 C22 -5 48 5 54 22"
          stroke="#FFFFFF"
          strokeWidth="1.5"
          strokeOpacity="0.45"
          strokeLinecap="round"
        />
        <path
          d="M0 0 C11 22 5 48 -11 54"
          stroke="#FFFFFF"
          strokeWidth="1.5"
          strokeOpacity="0.45"
          strokeLinecap="round"
        />

        {/* Golden pistil/stamen column */}
        <path
          d="M0 0 C-5 -16 -9 -38 -12 -52"
          stroke="#FFD54F"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        {/* Pollen anthers */}
        <circle cx="-12" cy="-52" r="2.5" fill="#FFC107" />
        <circle cx="-16" cy="-48" r="2" fill="#FFC107" />
        <circle cx="-8" cy="-49" r="2" fill="#FFC107" />
        <circle cx="-13" cy="-43" r="1.8" fill="#FFC107" />
        {/* Center deep purple core */}
        <circle cx="0" cy="0" r="5" fill="#4E2A84" />
      </g>
    </svg>
  );
}

export function AuthLayout({
  title,
  accentWord = "Buy-U",
  subtitle,
  children,
  footer,
}: AuthLayoutProps) {
  return (
    <div className="relative min-h-screen w-full overflow-x-hidden bg-[#FAF9FC] text-[#14121A] flex flex-col justify-between selection:bg-[#4E2A84] selection:text-white">
      {/* Decorative Brand Vectors */}
      <TopRightWaves />
      <BottomLeftWaves />
      <BottomRightHibiscus />

      {/* Main Responsive Grid Container */}
      <main className="relative z-10 mx-auto flex w-full max-w-[1440px] flex-1 items-center px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-6">
        <div className="flex w-full flex-col items-center gap-8 lg:flex-row lg:items-center lg:justify-between lg:gap-10 xl:gap-16">
          
          {/* Left Column: Brand & Campus Landmark Composition (52-55% width on desktop) */}
          <div className="flex w-full flex-col items-center text-center lg:w-[54%] lg:items-start lg:text-left">
            
            {/* Top Brand Tag */}
            <div className="flex items-center gap-3.5">
              <Link
                href="/"
                className="press-feedback inline-flex items-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4E2A84] rounded-lg"
                aria-label="Buy-U Home"
              >
                <Image
                  src="/images/logo/buyu-logo-horizontal.png"
                  alt="Buy-U"
                  width={140}
                  height={46}
                  className="h-9 sm:h-10 w-auto object-contain select-none"
                  priority
                />
              </Link>
              <div className="h-7 w-px bg-[#D6D0E0]" aria-hidden="true" />
              <div className="text-left">
                <p className="text-xs font-semibold text-[#14121A] leading-tight tracking-tight">
                  Universiti Malaysia Sabah
                </p>
                <p className="text-[11px] font-medium text-[#6B6578] leading-tight">
                  Campus Marketplace
                </p>
              </div>
            </div>

            {/* Headline with Teal Arc Underline */}
            <div className="mt-5 sm:mt-6">
              <h2 className="text-3xl font-extrabold tracking-tight text-[#4E2A84] sm:text-4xl lg:text-[42px] xl:text-5xl">
                Buy · Sell · Share
              </h2>
              <div className="mt-1 inline-flex flex-col items-center lg:items-start">
                <span className="text-3xl font-extrabold tracking-tight italic text-[#008285] sm:text-4xl lg:text-[42px] xl:text-5xl">
                  at UMSKAL
                </span>
                <div className="mt-1">
                  <TealUnderlineSwoosh />
                </div>
              </div>
            </div>

            {/* Actual UMSKAL Campus Photograph Frame */}
            <div className="relative mt-5 sm:mt-6 w-full max-w-[560px] overflow-hidden rounded-[24px] border border-[#ECE7F2] bg-white shadow-[0_12px_36px_rgba(78,42,132,0.08)] aspect-[16/9.5]">
              <Image
                src="/images/auth/umskal-campus.jpg"
                alt="UMSKAL Campus Landmark and Administrative Tower"
                fill
                priority
                sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 560px"
                className="object-cover object-center select-none"
              />
            </div>
          </div>

          {/* Right Column: Elevated Modern Form Card (45-48% width on desktop) */}
          <div className="flex w-full flex-col items-center lg:w-[46%] lg:max-w-[480px]">
            <div className="w-full rounded-[28px] border border-[#ECE7F2] bg-white p-6 sm:p-8 md:p-9 shadow-[0_16px_45px_rgba(78,42,132,0.07)]">
              
              {/* Card Centered Logo */}
              <div className="flex justify-center">
                <Link
                  href="/"
                  className="press-feedback inline-block focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4E2A84] rounded-lg"
                  aria-label="Return to Buy-U Home"
                >
                  <Image
                    src="/images/logo/buyu-logo-horizontal.png"
                    alt="Buy-U"
                    width={130}
                    height={44}
                    className="h-9 sm:h-10 w-auto object-contain select-none"
                    priority
                  />
                </Link>
              </div>

              {/* Card Title & Contextual Subtitle */}
              <div className="mt-4 text-center">
                <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-[#14121A]">
                  {title}{" "}
                  {accentWord ? (
                    <span className="relative inline-block text-[#4E2A84]">
                      {accentWord}
                      <span
                        className="absolute -bottom-1 left-0 right-0 h-1 rounded-full bg-[#008285]"
                        aria-hidden="true"
                      />
                    </span>
                  ) : null}
                </h1>
                <p className="mt-2.5 text-xs sm:text-sm text-[#555062] leading-relaxed max-w-sm mx-auto">
                  {subtitle}
                </p>
              </div>

              {/* Form Body */}
              <div className="mt-6 sm:mt-7">{children}</div>

              {/* Inside-Card Footer */}
              {footer ? (
                <div className="mt-6 border-t border-[#F0EDF5] pt-5 text-center text-xs sm:text-sm text-[#555062]">
                  {footer}
                </div>
              ) : null}
            </div>

            {/* Outside-Card Link: Return to Buy-U Home */}
            <div className="mt-5 text-center">
              <Link
                href="/"
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#008285] hover:text-[#4E2A84] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4E2A84] rounded-md px-2 py-1"
              >
                <Home className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Return to Buy-U Home</span>
              </Link>
            </div>
          </div>

        </div>
      </main>

      {/* Subtle bottom spacing padding */}
      <div className="h-4 sm:h-6" aria-hidden="true" />
    </div>
  );
}
