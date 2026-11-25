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

function TealHeadlineSwoosh() {
  return (
    <svg
      viewBox="0 0 220 14"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="h-2.5 w-36 sm:w-48 text-[#008285] select-none"
      aria-hidden="true"
    >
      <path
        d="M3 11C55 3 160 3 217 11C160 6 60 6 3 11Z"
        fill="currentColor"
      />
    </svg>
  );
}

function TopRightWaves() {
  return (
    <svg
      viewBox="0 0 360 220"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="pointer-events-none absolute right-0 top-0 z-0 h-auto w-32 sm:w-52 lg:w-[290px] xl:w-[340px] select-none"
      aria-hidden="true"
    >
      <path d="M70 0C155 30 245 85 360 220V0H70Z" fill="#008285" />
      <path d="M165 0C225 36 290 80 360 160V0H165Z" fill="#4E2A84" />
    </svg>
  );
}

function BottomLeftWaves() {
  return (
    <svg
      viewBox="0 0 640 130"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="pointer-events-none absolute bottom-0 left-0 z-10 hidden h-auto w-[46vw] max-w-[640px] select-none lg:block"
      aria-hidden="true"
    >
      {/* Teal upper wave with subtle white separation */}
      <path
        d="M0 32C125 22 255 68 415 102C495 118 570 124 640 126V130H0V32Z"
        fill="#008285"
        stroke="#FFFFFF"
        strokeWidth="3"
      />
      {/* Deep purple lower wave with subtle white separation */}
      <path
        d="M0 62C115 48 235 84 385 112C460 125 525 128 585 130H0V62Z"
        fill="#4E2A84"
        stroke="#FFFFFF"
        strokeWidth="3"
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
      className="pointer-events-none absolute bottom-0 right-0 z-0 hidden h-auto w-28 sm:block sm:w-36 lg:w-44 xl:w-48 select-none opacity-90"
      aria-hidden="true"
    >
      <path d="M115 175C100 160 85 170 65 185C80 195 100 193 115 175Z" fill="#008285" />
      <path d="M155 190C140 195 125 210 105 215C125 220 145 213 155 190Z" fill="#008285" />
      <path d="M75 185C60 175 45 190 30 205C50 210 65 200 75 185Z" fill="#00A3A6" />
      <g transform="translate(150, 152)">
        <path d="M0 0 C-30 -30 -66 -24 -72 5 C-76 30 -40 45 0 0Z" fill="#8056A8" />
        <path d="M0 0 C-15 -45 21 -70 45 -50 C70 -30 45 10 0 0Z" fill="#744B9E" />
        <path d="M0 0 C30 -20 70 -5 70 25 C70 54 25 40 0 0Z" fill="#6C4296" />
        <path d="M0 0 C20 30 10 70 -20 70 C-50 70 -36 25 0 0Z" fill="#7E53A7" />
        <path d="M0 0 C-36 10 -66 20 -61 50 C-55 70 -15 45 0 0Z" fill="#70479A" />
        <path d="M0 0 C-20 -15 -42 -12 -56 0" stroke="#FFFFFF" strokeWidth="1.5" strokeOpacity="0.45" strokeLinecap="round" />
        <path d="M0 0 C-5 -25 10 -42 26 -36" stroke="#FFFFFF" strokeWidth="1.5" strokeOpacity="0.45" strokeLinecap="round" />
        <path d="M0 0 C20 -5 45 5 50 20" stroke="#FFFFFF" strokeWidth="1.5" strokeOpacity="0.45" strokeLinecap="round" />
        <path d="M0 0 C10 20 5 45 -10 50" stroke="#FFFFFF" strokeWidth="1.5" strokeOpacity="0.45" strokeLinecap="round" />
        <path d="M0 0 C-5 -15 -8 -36 -11 -49" stroke="#FFD54F" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="-11" cy="-49" r="2.5" fill="#FFC107" />
        <circle cx="-15" cy="-45" r="2" fill="#FFC107" />
        <circle cx="-7" cy="-46" r="2" fill="#FFC107" />
        <circle cx="0" cy="0" r="4.5" fill="#4E2A84" />
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
    <div className="relative min-h-dvh w-full overflow-x-hidden bg-[#FAF9FC] text-[#14121A] flex flex-col lg:block selection:bg-[#4E2A84] selection:text-white">
      {/* Desktop Edge-to-Edge Integrated Campus Background Layer */}
      <div
        className="pointer-events-none absolute inset-y-0 left-0 z-0 hidden w-[62%] overflow-hidden select-none lg:block"
        aria-hidden="true"
      >
        <Image
          src="/images/auth/umskal-campus.jpg"
          alt="UMSKAL Campus Landmark and Administrative Tower"
          fill
          priority
          sizes="62vw"
          className="object-cover object-[35%_bottom]"
        />
        {/* Subtle upper-left sky contrast veil */}
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(250,249,252,0.88)_0%,rgba(250,249,252,0.52)_22%,rgba(250,249,252,0)_48%)]" />
        {/* Smooth horizontal fade into right canvas */}
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(250,249,252,0)_58%,rgba(250,249,252,0.78)_84%,#FAF9FC_100%)]" />
      </div>

      {/* Desktop Fixed-Position Brand Logo & Promotional Headline Layered Above Sky */}
      <div className="pointer-events-none absolute inset-y-0 left-0 z-20 hidden w-[53%] lg:block">
        <div className="pointer-events-auto absolute left-[9%] top-[4.5%] flex items-center gap-3.5">
          <Link
            href="/"
            className="press-feedback inline-flex items-center rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4E2A84]"
            aria-label="Buy-U Home"
          >
            <Image
              src="/images/logo/buyu-logo-horizontal.png"
              alt="Buy-U"
              width={140}
              height={46}
              className="h-9 w-auto object-contain select-none"
              priority
            />
          </Link>
          <div className="h-7 w-px bg-[#C9C2D6]" aria-hidden="true" />
          <div className="text-left">
            <p className="text-xs font-semibold leading-tight tracking-tight text-[#14121A]">
              Universiti Malaysia Sabah
            </p>
            <p className="text-[11px] font-medium leading-tight text-[#555062]">
              Campus Marketplace
            </p>
          </div>
        </div>

        <div className="absolute left-[9%] top-[16.5%]">
          <h2 className="text-[clamp(1.9rem,3vw,2.9rem)] font-extrabold leading-[1.08] tracking-tight text-[#4E2A84]">
            Buy · Sell · Share
          </h2>
          <div className="mt-0.5 inline-flex flex-col items-start">
            <span className="text-[clamp(1.9rem,3vw,2.9rem)] font-extrabold italic leading-[1.08] tracking-tight text-[#008285]">
              at UMSKAL
            </span>
            <div className="mt-1">
              <TealHeadlineSwoosh />
            </div>
          </div>
        </div>
      </div>

      {/* Mobile & Tablet Compact Campus Header */}
      <div className="relative z-10 w-full overflow-hidden lg:hidden">
        <div className="relative h-52 w-full sm:h-64">
          <Image
            src="/images/auth/umskal-campus.jpg"
            alt="UMSKAL Campus Landmark and Administrative Tower"
            fill
            priority
            sizes="100vw"
            className="object-cover object-[40%_bottom] select-none"
          />
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(250,249,252,0.92)_0%,rgba(250,249,252,0.55)_42%,rgba(250,249,252,0.1)_80%,#FAF9FC_100%)]" />
          <div className="relative z-10 flex flex-col justify-start px-5 pt-5">
            <div className="flex items-center gap-2.5">
              <Link href="/" aria-label="Buy-U Home" className="press-feedback inline-flex items-center">
                <Image
                  src="/images/logo/buyu-logo-horizontal.png"
                  alt="Buy-U"
                  width={120}
                  height={40}
                  className="h-8 w-auto object-contain select-none"
                  priority
                />
              </Link>
              <div className="h-5 w-px bg-[#C9C2D6]" aria-hidden="true" />
              <div>
                <p className="text-[11px] font-semibold leading-tight text-[#14121A]">
                  Universiti Malaysia Sabah
                </p>
                <p className="text-[10px] font-medium leading-tight text-[#555062]">
                  Campus Marketplace
                </p>
              </div>
            </div>
            <div className="mt-3">
              <p className="text-2xl font-extrabold leading-tight tracking-tight text-[#4E2A84] sm:text-3xl">
                Buy · Sell · Share
              </p>
              <p className="text-2xl font-extrabold italic leading-tight tracking-tight text-[#008285] sm:text-3xl">
                at UMSKAL
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Decorative Viewport-Anchored Vectors */}
      <TopRightWaves />
      <BottomLeftWaves />
      <BottomRightHibiscus />

      {/* Right Authentication Area */}
      <main className="relative z-30 flex flex-1 flex-col items-center justify-center px-4 pb-8 pt-2 sm:px-6 lg:ml-[52%] lg:min-h-dvh lg:w-[48%] lg:py-4 lg:pl-4 lg:pr-[5%]">
        <div className="w-full max-w-[440px] rounded-[24px] border border-[#ECE7F2] bg-white/95 px-6 py-6 shadow-[0_16px_45px_rgba(78,42,132,0.08)] backdrop-blur-sm transition-opacity duration-200 sm:px-8 sm:py-7">
          {/* Card Centered Logo */}
          <div className="flex justify-center">
            <Link
              href="/"
              className="press-feedback inline-block rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4E2A84]"
              aria-label="Return to Buy-U Home"
            >
              <Image
                src="/images/logo/buyu-logo-horizontal.png"
                alt="Buy-U"
                width={124}
                height={42}
                className="h-8 w-auto object-contain select-none sm:h-9"
                priority
              />
            </Link>
          </div>

          {/* Card Title & Concise Subtitle */}
          <div className="mt-3 text-center">
            <h1 className="text-xl font-extrabold tracking-tight text-[#14121A] sm:text-2xl">
              {title}{" "}
              {accentWord ? (
                <span className="text-[#008285] italic">{accentWord}</span>
              ) : null}
            </h1>
            <p className="mx-auto mt-1.5 max-w-[340px] text-xs leading-snug text-[#555062] sm:text-[13px]">
              {subtitle}
            </p>
          </div>

          {/* Form Body */}
          <div className="mt-4 sm:mt-5">{children}</div>

          {/* Inside-Card Footer */}
          {footer ? (
            <div className="mt-4 border-t border-[#F0EDF5] pt-3.5 text-center text-xs text-[#555062] sm:text-[13px]">
              {footer}
            </div>
          ) : null}
        </div>

        {/* Outside-Card Link: Return to Buy-U Home */}
        <div className="mt-3 text-center">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold text-[#4E2A84] transition-colors hover:text-[#008285] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4E2A84]"
          >
            <Home className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Return to Buy-U Home</span>
          </Link>
        </div>
      </main>
    </div>
  );
}
