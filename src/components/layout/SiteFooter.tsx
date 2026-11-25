import Image from "next/image";
import Link from "next/link";
import { Clock, GraduationCap, KeyRound, ShieldCheck } from "lucide-react";

interface SiteFooterProps {
  dataSource: "supabase" | "unconfigured";
}

export function SiteFooter({}: SiteFooterProps) {
  return (
    <footer className="mt-10 border-t border-[#2E2A3B] bg-[#14121A] text-white">
      <div
        className="h-1 w-full bg-gradient-to-r from-[#4E2A84] via-[#00A3A6] to-[#4E2A84]"
        aria-hidden="true"
      />

      <div className="bori-container py-8 sm:py-10">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-12">
          {/* Column 1 — Brand */}
          <div className="lg:col-span-4">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white p-1.5 shadow-sm">
                <Image
                  src="/images/logo/buyu-logo.png"
                  alt="Buy-U Logo"
                  width={40}
                  height={45}
                  className="h-8 w-auto object-contain select-none"
                />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-lg font-extrabold tracking-tight text-white">
                    Buy-U
                  </span>
                  <span className="rounded-full bg-[#00A3A6]/15 px-2 py-0.5 text-[11px] font-bold tracking-wide text-[#00A3A6]">
                    UMSKAL
                  </span>
                </div>
                <p className="text-xs text-[#A9A3B8]">
                  Your Campus Marketplace
                </p>
              </div>
            </div>

            <p className="mt-3.5 max-w-sm text-sm leading-relaxed text-[#D4D0E0]">
              Connecting the UMSKAL community through campus commerce, student
              entrepreneurship and sustainable sharing.
            </p>
          </div>

          {/* Column 2 — Explore Buy-U */}
          <nav aria-label="Explore Buy-U" className="lg:col-span-2">
            <h2 className="text-xs font-bold uppercase tracking-wider text-[#00A3A6]">
              Explore Buy-U
            </h2>
            <ul className="mt-3 space-y-2 text-sm text-[#D4D0E0]">
              <li>
                <Link
                  href="/marketplace"
                  className="transition-colors hover:text-white"
                >
                  Marketplace
                </Link>
              </li>
              <li>
                <Link
                  href="/services"
                  className="transition-colors hover:text-white"
                >
                  Campus Services
                </Link>
              </li>
              <li>
                <Link
                  href="/free-items"
                  className="transition-colors hover:text-white"
                >
                  Free Items
                </Link>
              </li>
              <li>
                <Link
                  href="/messages"
                  className="transition-colors hover:text-white"
                >
                  Messages &amp; Offers
                </Link>
              </li>
            </ul>
          </nav>

          {/* Column 3 — My Buy-U */}
          <nav aria-label="My Buy-U" className="lg:col-span-3">
            <h2 className="text-xs font-bold uppercase tracking-wider text-[#00A3A6]">
              My Buy-U
            </h2>
            <ul className="mt-3 space-y-2 text-sm text-[#D4D0E0]">
              <li>
                <Link
                  href="/orders"
                  className="transition-colors hover:text-white"
                >
                  My Orders
                </Link>
              </li>
              <li>
                <Link
                  href="/seller"
                  className="transition-colors hover:text-white"
                >
                  Seller Hub
                </Link>
              </li>
              <li>
                <Link
                  href="/account"
                  className="transition-colors hover:text-white"
                >
                  Account Settings
                </Link>
              </li>
            </ul>
          </nav>

          {/* Column 4 — Trust & Safety */}
          <div className="lg:col-span-3">
            <h2 className="text-xs font-bold uppercase tracking-wider text-[#00A3A6]">
              Trust &amp; Safety
            </h2>
            <ul className="mt-3 space-y-2.5 text-sm text-[#D4D0E0]">
              <li className="flex items-center gap-2.5">
                <GraduationCap
                  className="h-4 w-4 shrink-0 text-[#00A3A6]"
                  aria-hidden="true"
                />
                <span>Verified university community</span>
              </li>
              <li className="flex items-center gap-2.5">
                <KeyRound
                  className="h-4 w-4 shrink-0 text-[#00A3A6]"
                  aria-hidden="true"
                />
                <span>Pickup PIN verification</span>
              </li>
              <li className="flex items-center gap-2.5">
                <Clock
                  className="h-4 w-4 shrink-0 text-[#00A3A6]"
                  aria-hidden="true"
                />
                <span>72-hour buyer protection</span>
              </li>
              <li className="flex items-center gap-2.5">
                <ShieldCheck
                  className="h-4 w-4 shrink-0 text-[#00A3A6]"
                  aria-hidden="true"
                />
                <span>Community moderation and dispute resolution</span>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-8 flex flex-col gap-2 border-t border-[#2E2A3B] pt-5 text-xs text-[#A9A3B8] sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} Buy-U. All rights reserved.</p>
          <p>Built for the UMSKAL community.</p>
        </div>
      </div>
    </footer>
  );
}
