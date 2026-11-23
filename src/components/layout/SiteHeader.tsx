"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Bell,
  ChevronDown,
  LogOut,
  Menu,
  MessageCircle,
  Search,
  ShieldCheck,
  User,
  X,
} from "lucide-react";
import { signOutAction } from "@/app/auth/actions";
import type { AuthSessionSummary } from "@/types/marketplace";

interface SiteHeaderProps {
  session: AuthSessionSummary;
}

export function SiteHeader({ session }: SiteHeaderProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");
  const [mobileOpen, setMobileOpen] = useState(false);

  const role = (session.profile?.university_role ?? "").toLowerCase();
  const isStaff = session.isAuthenticated && role === "staff";
  const displayName =
    session.profile?.display_name ||
    session.email?.split("@")[0] ||
    "Account";

  // Role-aware Sell link: Staff never see a misleading Sell entry
  const sellHref = session.isAuthenticated
    ? "/account#sell-roadmap"
    : "/login?next=%2Faccount%23sell-roadmap";

  const navLinks = [
    { href: "/", label: "Home" },
    { href: "/marketplace", label: "Marketplace" },
    { href: "/marketplace?type=service", label: "Services" },
    { href: "/marketplace?type=free", label: "Free Items" },
    ...(!isStaff
      ? [
          {
            href: sellHref,
            label: "Sell",
            title: session.isAuthenticated
              ? "Seller onboarding — Coming Soon in Phase 3"
              : "Sign in with UMS email for seller onboarding roadmap",
          },
        ]
      : []),
  ];

  function handleSearchSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = searchQuery.trim();
    const target = trimmed
      ? `/marketplace?q=${encodeURIComponent(trimmed)}`
      : "/marketplace";
    setMobileOpen(false);
    router.push(target);
  }

  return (
    <header className="sticky top-0 z-40 border-b border-[#E6E4EE] bg-white">
      <div className="bori-container flex h-[62px] items-center justify-between gap-3 lg:gap-5">
        {/* Brand Logo Image + Descriptor */}
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2.5 rounded-md py-1 pr-1 press-feedback focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4E2A84]"
          aria-label="Buy-U — UMS Student Marketplace Home"
        >
          <Image
            src="/images/logo/buyu-logo.png"
            alt="Buy-U Logo"
            width={44}
            height={50}
            className="h-10 w-auto object-contain select-none"
            priority
          />
          <span
            className="hidden h-7 w-[1.5px] bg-[#C9C5D6] sm:block"
            aria-hidden="true"
          />
          <span className="hidden flex-col leading-[1.15] sm:flex">
            <span className="text-[11px] font-bold tracking-tight text-[#14121A]">
              UMS
            </span>
            <span className="text-[11px] font-medium tracking-tight text-[#3E3B4B]">
              Student Marketplace
            </span>
          </span>
        </Link>

        {/* Primary Navigation (Desktop) */}
        <nav
          aria-label="Primary"
          className="hidden items-center gap-1 lg:flex xl:gap-1.5"
        >
          {navLinks.map((link) => {
            const isHomeActive = link.href === "/" && pathname === "/";
            const isMarketActive =
              link.href === "/marketplace" && pathname === "/marketplace";
            const isActive = isHomeActive || isMarketActive;
            return (
              <Link
                key={link.label}
                href={link.href}
                title={link.title}
                className={`rounded-lg px-3.5 py-2 text-[14px] font-semibold transition-colors whitespace-nowrap ${
                  isActive
                    ? "bg-[#4E2A84] text-white"
                    : "text-[#14121A] hover:bg-[#F4F2FA] hover:text-[#4E2A84]"
                }`}
              >
                {link.label}
              </Link>
            );
          })}

          {/* Admin link shown ONLY to backend-verified active admins */}
          {session.isActiveAdmin ? (
            <Link
              href="/admin"
              className="inline-flex items-center gap-1 rounded-lg px-3 py-2 text-[14px] font-bold text-[#4E2A84] hover:bg-[#F4F2FA] whitespace-nowrap"
            >
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              <span>Admin</span>
            </Link>
          ) : null}
        </nav>

        {/* Prominent Pill Search Bar (Desktop & Tablet) */}
        <form
          onSubmit={handleSearchSubmit}
          role="search"
          aria-label="Search campus marketplace"
          className="hidden min-w-[160px] flex-1 max-w-[340px] items-center rounded-full border border-[#CFCBD9] bg-[#FAFAFC] px-3.5 py-1.5 transition-colors focus-within:border-[#4E2A84] focus-within:bg-white md:flex"
        >
          <button
            type="submit"
            aria-label="Submit search"
            className="mr-2 flex shrink-0 items-center justify-center text-[#3E3B4B] hover:text-[#4E2A84]"
          >
            <Search className="h-4 w-4" aria-hidden="true" />
          </button>
          <label htmlFor="header-search" className="sr-only">
            Search items or services
          </label>
          <input
            id="header-search"
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search items, services..."
            className="w-full bg-transparent text-[13.5px] text-[#14121A] placeholder:text-[#656173] focus:outline-none"
          />
        </form>

        {/* Utility Icons + Profile (Desktop) */}
        <div className="hidden items-center gap-2 lg:flex">
          <button
            type="button"
            disabled
            aria-disabled="true"
            title="Messages — coming in Phase 5"
            aria-label="Messages (coming in Phase 5)"
            className="flex h-9 w-9 items-center justify-center rounded-full text-[#706C7E] opacity-70 cursor-not-allowed"
          >
            <MessageCircle className="h-[19px] w-[19px]" aria-hidden="true" />
          </button>

          <button
            type="button"
            disabled
            aria-disabled="true"
            title="Notifications — coming in Phase 5"
            aria-label="Notifications (coming in Phase 5)"
            className="flex h-9 w-9 items-center justify-center rounded-full text-[#706C7E] opacity-70 cursor-not-allowed"
          >
            <Bell className="h-[19px] w-[19px]" aria-hidden="true" />
          </button>

          <span className="h-5 w-px bg-[#DCD9E6]" aria-hidden="true" />

          {session.isAuthenticated ? (
            <div className="flex items-center gap-1.5">
              <Link
                href="/account"
                title={`Signed in as ${displayName}`}
                className="inline-flex items-center gap-1.5 rounded-full border border-[#4E2A84]/30 bg-[#F6F3FB] py-1 pl-1.5 pr-2.5 text-xs font-bold text-[#4E2A84] hover:border-[#4E2A84] hover:bg-[#EFE9F9] press-feedback"
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#4E2A84] text-white">
                  <User className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
                <span className="hidden max-w-[100px] truncate xl:inline">
                  {displayName}
                </span>
                <ChevronDown className="h-3.5 w-3.5 text-[#4E2A84]" aria-hidden="true" />
              </Link>

              <form action={signOutAction}>
                <button
                  type="submit"
                  aria-label="Sign out"
                  title="Sign out"
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-[#DCD9E6] bg-white text-[#3E3B4B] hover:border-[#14121A] hover:text-[#14121A] press-feedback"
                >
                  <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </form>
            </div>
          ) : (
            <Link
              href="/login"
              className="inline-flex items-center gap-1.5 rounded-full border border-[#4E2A84] bg-white px-3.5 py-1.5 text-[13px] font-bold text-[#4E2A84] hover:bg-[#4E2A84] hover:text-white press-feedback"
            >
              <User className="h-4 w-4" aria-hidden="true" />
              <span>Sign In</span>
            </Link>
          )}
        </div>

        {/* Mobile Compact Actions */}
        <div className="flex items-center gap-2 lg:hidden">
          <Link
            href={session.isAuthenticated ? "/account" : "/login"}
            aria-label={session.isAuthenticated ? "Account" : "Sign In"}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-[#4E2A84]/40 bg-[#F6F3FB] text-[#4E2A84]"
          >
            <User className="h-4 w-4" aria-hidden="true" />
          </Link>
          <button
            type="button"
            onClick={() => setMobileOpen((prev) => !prev)}
            aria-expanded={mobileOpen}
            aria-controls="mobile-nav-drawer"
            aria-label={mobileOpen ? "Close navigation menu" : "Open navigation menu"}
            className="flex h-10 w-10 items-center justify-center rounded-lg border border-[#DCD9E6] bg-white text-[#14121A] hover:bg-[#F7F7F9]"
          >
            {mobileOpen ? (
              <X className="h-5 w-5" aria-hidden="true" />
            ) : (
              <Menu className="h-5 w-5" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {/* Mobile Drawer */}
      {mobileOpen ? (
        <div
          id="mobile-nav-drawer"
          className="border-t border-[#E6E4EE] bg-white px-4 py-4 sm:px-6 lg:hidden"
        >
          <form
            onSubmit={handleSearchSubmit}
            role="search"
            aria-label="Mobile marketplace search"
            className="mb-4 flex items-center rounded-full border border-[#CFCBD9] bg-[#FAFAFC] px-3.5 py-2 focus-within:border-[#4E2A84] focus-within:bg-white"
          >
            <Search className="mr-2 h-4 w-4 shrink-0 text-[#4A4656]" aria-hidden="true" />
            <label htmlFor="mobile-search" className="sr-only">
              Search listings
            </label>
            <input
              id="mobile-search"
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search items, services..."
              className="w-full bg-transparent text-sm text-[#14121A] placeholder:text-[#656173] focus:outline-none"
            />
            <button
              type="submit"
              className="ml-2 rounded-full bg-[#4E2A84] px-3 py-1 text-xs font-bold text-white"
            >
              Go
            </button>
          </form>

          <nav aria-label="Mobile primary" className="flex flex-col gap-1">
            {navLinks.map((link) => (
              <Link
                key={link.label}
                href={link.href}
                onClick={() => setMobileOpen(false)}
                className="rounded-lg px-3 py-2.5 text-sm font-semibold text-[#14121A] hover:bg-[#F4F2FA] hover:text-[#4E2A84]"
              >
                {link.label}
              </Link>
            ))}

            {session.isActiveAdmin ? (
              <Link
                href="/admin"
                onClick={() => setMobileOpen(false)}
                className="rounded-lg bg-[#F4F2FA] px-3 py-2.5 text-sm font-bold text-[#4E2A84]"
              >
                Admin Console
              </Link>
            ) : null}

            <div className="mt-2 border-t border-[#E6E4EE] pt-3">
              {session.isAuthenticated ? (
                <div className="flex flex-col gap-2">
                  <Link
                    href="/account"
                    onClick={() => setMobileOpen(false)}
                    className="rounded-lg border border-[#4E2A84] px-3 py-2.5 text-sm font-bold text-[#4E2A84]"
                  >
                    Account ({displayName})
                  </Link>
                  <form action={signOutAction}>
                    <button
                      type="submit"
                      className="w-full rounded-lg border border-[#DCD9E6] bg-white px-3 py-2.5 text-left text-sm font-semibold text-[#14121A] hover:bg-[#F7F7F9]"
                    >
                      Sign Out
                    </button>
                  </form>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <Link
                    href="/login"
                    onClick={() => setMobileOpen(false)}
                    className="rounded-lg bg-[#4E2A84] px-3 py-2.5 text-center text-sm font-bold text-white"
                  >
                    Sign In
                  </Link>
                  <Link
                    href="/register"
                    onClick={() => setMobileOpen(false)}
                    className="rounded-lg border border-[#CFCBD9] px-3 py-2.5 text-center text-sm font-bold text-[#14121A]"
                  >
                    Register
                  </Link>
                </div>
              )}
            </div>
          </nav>
        </div>
      ) : null}
    </header>
  );
}
