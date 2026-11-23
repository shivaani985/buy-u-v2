"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Bell,
  Menu,
  MessageSquare,
  PlusSquare,
  Search,
  ShoppingBag,
  User,
  X,
} from "lucide-react";
import type { AuthSessionSummary } from "@/types/marketplace";

interface SiteHeaderProps {
  session: AuthSessionSummary;
}

const NAV_LINKS = [
  { href: "/", label: "Home" },
  { href: "/marketplace", label: "Marketplace" },
  { href: "/marketplace?type=service", label: "Services" },
  { href: "/marketplace?type=free", label: "Free Items" },
];

export function SiteHeader({ session }: SiteHeaderProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");
  const [mobileOpen, setMobileOpen] = useState(false);

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
    <header className="sticky top-0 z-40 border-b-2 border-[#14121A] bg-white">
      <div className="mx-auto flex w-full max-w-[1680px] items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-10 xl:px-14">
        {/* Brand */}
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2.5 p-1 -m-1 press-feedback focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4E2A84]"
          aria-label="Buy-U Home"
        >
          <span className="flex h-9 w-9 items-center justify-center bg-[#4E2A84] text-base font-extrabold tracking-tight text-white editorial-cut-tr">
            BU
          </span>
          <span className="flex flex-col leading-none">
            <span className="text-lg font-extrabold tracking-tight text-[#14121A]">
              Buy-U
            </span>
            <span className="text-[11px] font-semibold tracking-wide text-[#4E2A84] uppercase">
              UMSKAL
            </span>
          </span>
        </Link>

        {/* Primary Navigation (Desktop) */}
        <nav
          aria-label="Primary"
          className="hidden items-center gap-1 lg:flex"
        >
          {NAV_LINKS.map((link) => {
            const isActive =
              link.href === "/"
                ? pathname === "/"
                : pathname === "/marketplace" && link.href === "/marketplace";
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`px-3 py-2 text-sm font-semibold transition-colors ${
                  isActive
                    ? "bg-[#4E2A84] text-white"
                    : "text-[#14121A] hover:bg-[#F7F7F5] hover:text-[#4E2A84]"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        {/* Search Form (Desktop & Tablet) */}
        <form
          onSubmit={handleSearchSubmit}
          role="search"
          aria-label="Search campus marketplace"
          className="hidden flex-1 max-w-md items-center border border-[#14121A] bg-[#F7F7F5] focus-within:border-[#4E2A84] focus-within:bg-white md:flex"
        >
          <label htmlFor="header-search" className="sr-only">
            Search listings
          </label>
          <input
            id="header-search"
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search textbooks, snacks, services..."
            className="w-full bg-transparent px-3 py-2 text-sm text-[#14121A] placeholder:text-[#5B5668] focus:outline-none"
          />
          <button
            type="submit"
            aria-label="Submit search"
            className="flex h-9 w-10 shrink-0 items-center justify-center bg-[#14121A] text-white hover:bg-[#4E2A84] press-feedback"
          >
            <Search className="h-4 w-4" aria-hidden="true" />
          </button>
        </form>

        {/* Utility Actions (Desktop) */}
        <div className="hidden items-center gap-1.5 xl:flex">
          <button
            type="button"
            disabled
            aria-disabled="true"
            title="Seller listing creation opens in Phase 2"
            className="inline-flex items-center gap-1.5 border border-[#D9D6E2] bg-[#F7F7F5] px-3 py-2 text-xs font-bold uppercase tracking-wide text-[#5B5668] cursor-not-allowed"
          >
            <PlusSquare className="h-4 w-4" aria-hidden="true" />
            Sell
          </button>

          <button
            type="button"
            disabled
            aria-disabled="true"
            title="Multi-seller cart opens in Commerce phase"
            aria-label="Cart (available in Commerce phase)"
            className="flex h-9 w-9 items-center justify-center border border-[#D9D6E2] bg-[#F7F7F5] text-[#5B5668] cursor-not-allowed"
          >
            <ShoppingBag className="h-4 w-4" aria-hidden="true" />
          </button>

          <button
            type="button"
            disabled
            aria-disabled="true"
            title="Campus chat opens in Communication phase"
            aria-label="Messages (available in Communication phase)"
            className="flex h-9 w-9 items-center justify-center border border-[#D9D6E2] bg-[#F7F7F5] text-[#5B5668] cursor-not-allowed"
          >
            <MessageSquare className="h-4 w-4" aria-hidden="true" />
          </button>

          <button
            type="button"
            disabled
            aria-disabled="true"
            title="Notifications open in Communication phase"
            aria-label="Notifications (available in Communication phase)"
            className="flex h-9 w-9 items-center justify-center border border-[#D9D6E2] bg-[#F7F7F5] text-[#5B5668] cursor-not-allowed"
          >
            <Bell className="h-4 w-4" aria-hidden="true" />
          </button>

          <Link
            href="/account"
            className="inline-flex items-center gap-1.5 border-2 border-[#4E2A84] bg-white px-3 py-1.5 text-sm font-bold text-[#4E2A84] hover:bg-[#4E2A84] hover:text-white press-feedback"
          >
            <User className="h-4 w-4" aria-hidden="true" />
            <span>{session.isAuthenticated ? "Account" : "Sign In"}</span>
          </Link>
        </div>

        {/* Compact Account + Menu Toggle (Mobile / Tablet) */}
        <div className="flex items-center gap-2 xl:hidden">
          <Link
            href="/account"
            aria-label={session.isAuthenticated ? "Account" : "Sign In"}
            className="flex h-9 w-9 items-center justify-center border-2 border-[#4E2A84] text-[#4E2A84] hover:bg-[#4E2A84] hover:text-white"
          >
            <User className="h-4 w-4" aria-hidden="true" />
          </Link>
          <button
            type="button"
            onClick={() => setMobileOpen((prev) => !prev)}
            aria-expanded={mobileOpen}
            aria-controls="mobile-nav-drawer"
            aria-label={mobileOpen ? "Close navigation menu" : "Open navigation menu"}
            className="flex h-9 w-9 items-center justify-center border border-[#14121A] bg-white text-[#14121A] hover:bg-[#F7F7F5]"
          >
            {mobileOpen ? (
              <X className="h-5 w-5" aria-hidden="true" />
            ) : (
              <Menu className="h-5 w-5" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {/* Mobile Navigation Drawer */}
      {mobileOpen ? (
        <div
          id="mobile-nav-drawer"
          className="border-t border-[#D9D6E2] bg-white px-4 py-4 sm:px-6 xl:hidden"
        >
          <form
            onSubmit={handleSearchSubmit}
            role="search"
            aria-label="Mobile marketplace search"
            className="mb-4 flex items-center border border-[#14121A] bg-[#F7F7F5]"
          >
            <label htmlFor="mobile-search" className="sr-only">
              Search listings
            </label>
            <input
              id="mobile-search"
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search campus listings..."
              className="w-full bg-transparent px-3 py-2 text-sm text-[#14121A] placeholder:text-[#5B5668] focus:outline-none"
            />
            <button
              type="submit"
              aria-label="Submit mobile search"
              className="flex h-9 w-10 shrink-0 items-center justify-center bg-[#14121A] text-white"
            >
              <Search className="h-4 w-4" aria-hidden="true" />
            </button>
          </form>

          <nav aria-label="Mobile primary" className="flex flex-col gap-1">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMobileOpen(false)}
                className="border border-transparent px-3 py-2.5 text-sm font-semibold text-[#14121A] hover:border-[#D9D6E2] hover:bg-[#F7F7F5]"
              >
                {link.label}
              </Link>
            ))}
            <Link
              href="/account"
              onClick={() => setMobileOpen(false)}
              className="border border-[#4E2A84] px-3 py-2.5 text-sm font-bold text-[#4E2A84]"
            >
              {session.isAuthenticated ? "Account & Session" : "Account / Sign In Foundation"}
            </Link>
          </nav>

          <div className="mt-4 border-t border-[#D9D6E2] pt-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#4A4656]">
              Upcoming Phases (Disabled in Phase 1)
            </p>
            <div className="grid grid-cols-2 gap-2">
              {["Sell", "Cart", "Messages", "Notifications"].map((item) => (
                <button
                  key={item}
                  type="button"
                  disabled
                  aria-disabled="true"
                  className="border border-[#D9D6E2] bg-[#F7F7F5] px-3 py-2 text-left text-xs font-semibold text-[#5B5668] cursor-not-allowed"
                >
                  {item}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </header>
  );
}
