"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Bell,
  LogOut,
  Menu,
  MessageSquare,
  PlusSquare,
  Search,
  ShieldCheck,
  ShoppingBag,
  User,
  X,
} from "lucide-react";
import { signOutAction } from "@/app/auth/actions";
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

  const displayName =
    session.profile?.display_name ||
    session.email?.split("@")[0] ||
    "Account";

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
          {/* Admin link shown ONLY to backend-verified active admins */}
          {session.isActiveAdmin ? (
            <Link
              href="/admin"
              className="inline-flex items-center gap-1 px-3 py-2 text-sm font-bold text-[#4E2A84] hover:bg-[#F8F4FC]"
            >
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              <span>Admin</span>
            </Link>
          ) : null}
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
            title="Seller listing creation opens in Phase 3 (Students only)"
            className="inline-flex items-center gap-1.5 border border-[#D9D6E2] bg-[#F7F7F5] px-3 py-2 text-xs font-bold uppercase tracking-wide text-[#5B5668] cursor-not-allowed"
          >
            <PlusSquare className="h-4 w-4" aria-hidden="true" />
            Sell
          </button>

          <button
            type="button"
            disabled
            aria-disabled="true"
            title="Multi-seller cart opens in Phase 4"
            aria-label="Cart (available in Phase 4)"
            className="flex h-9 w-9 items-center justify-center border border-[#D9D6E2] bg-[#F7F7F5] text-[#5B5668] cursor-not-allowed"
          >
            <ShoppingBag className="h-4 w-4" aria-hidden="true" />
          </button>

          <button
            type="button"
            disabled
            aria-disabled="true"
            title="Campus chat opens in Phase 5"
            aria-label="Messages (available in Phase 5)"
            className="flex h-9 w-9 items-center justify-center border border-[#D9D6E2] bg-[#F7F7F5] text-[#5B5668] cursor-not-allowed"
          >
            <MessageSquare className="h-4 w-4" aria-hidden="true" />
          </button>

          <button
            type="button"
            disabled
            aria-disabled="true"
            title="Notifications open in Phase 5"
            aria-label="Notifications (available in Phase 5)"
            className="flex h-9 w-9 items-center justify-center border border-[#D9D6E2] bg-[#F7F7F5] text-[#5B5668] cursor-not-allowed"
          >
            <Bell className="h-4 w-4" aria-hidden="true" />
          </button>

          {session.isAuthenticated ? (
            <>
              <Link
                href="/account"
                className="inline-flex items-center gap-1.5 border-2 border-[#4E2A84] bg-white px-3 py-1.5 text-sm font-bold text-[#4E2A84] hover:bg-[#4E2A84] hover:text-white press-feedback"
              >
                <User className="h-4 w-4" aria-hidden="true" />
                <span className="max-w-[120px] truncate">{displayName}</span>
              </Link>
              <form action={signOutAction}>
                <button
                  type="submit"
                  aria-label="Sign out"
                  title="Sign out"
                  className="flex h-9 w-9 items-center justify-center border border-[#14121A] bg-white text-[#14121A] hover:bg-[#14121A] hover:text-white press-feedback"
                >
                  <LogOut className="h-4 w-4" aria-hidden="true" />
                </button>
              </form>
            </>
          ) : (
            <Link
              href="/login"
              className="inline-flex items-center gap-1.5 border-2 border-[#4E2A84] bg-[#4E2A84] px-3.5 py-1.5 text-sm font-bold text-white hover:bg-[#381C63] press-feedback"
            >
              <User className="h-4 w-4" aria-hidden="true" />
              <span>Sign In</span>
            </Link>
          )}
        </div>

        {/* Compact Account + Menu Toggle (Mobile / Tablet) */}
        <div className="flex items-center gap-2 xl:hidden">
          <Link
            href={session.isAuthenticated ? "/account" : "/login"}
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

            {session.isActiveAdmin ? (
              <Link
                href="/admin"
                onClick={() => setMobileOpen(false)}
                className="border border-[#4E2A84] bg-[#F8F4FC] px-3 py-2.5 text-sm font-bold text-[#4E2A84]"
              >
                Admin Console
              </Link>
            ) : null}

            {session.isAuthenticated ? (
              <>
                <Link
                  href="/account"
                  onClick={() => setMobileOpen(false)}
                  className="border border-[#4E2A84] px-3 py-2.5 text-sm font-bold text-[#4E2A84]"
                >
                  Account ({displayName})
                </Link>
                <form action={signOutAction} className="mt-1">
                  <button
                    type="submit"
                    className="w-full border border-[#14121A] bg-white px-3 py-2.5 text-left text-sm font-bold text-[#14121A] hover:bg-[#F7F7F5]"
                  >
                    Sign Out
                  </button>
                </form>
              </>
            ) : (
              <div className="mt-1 grid grid-cols-2 gap-2">
                <Link
                  href="/login"
                  onClick={() => setMobileOpen(false)}
                  className="bg-[#4E2A84] px-3 py-2.5 text-center text-sm font-bold text-white"
                >
                  Sign In
                </Link>
                <Link
                  href="/register"
                  onClick={() => setMobileOpen(false)}
                  className="border border-[#14121A] px-3 py-2.5 text-center text-sm font-bold text-[#14121A]"
                >
                  Register
                </Link>
              </div>
            )}
          </nav>
        </div>
      ) : null}
    </header>
  );
}
