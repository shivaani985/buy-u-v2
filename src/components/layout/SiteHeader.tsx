"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Bell,
  LogOut,
  Menu,
  MessageCircle,
  Search,
  ShieldCheck,
  ShoppingCart,
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
  const [mobileOpenPath, setMobileOpenPath] = useState<string | null>(null);
  const [accountMenuPath, setAccountMenuPath] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const mobileOpen = mobileOpenPath === pathname;
  const accountMenuOpen = accountMenuPath === pathname;
  const setMobileOpen = (next: boolean | ((prev: boolean) => boolean)) => {
    setMobileOpenPath((prev) => {
      const curr = prev === pathname;
      const val = typeof next === "function" ? next(curr) : next;
      return val ? pathname : null;
    });
  };
  const setAccountMenuOpen = (next: boolean | ((prev: boolean) => boolean)) => {
    setAccountMenuPath((prev) => {
      const curr = prev === pathname;
      const val = typeof next === "function" ? next(curr) : next;
      return val ? pathname : null;
    });
  };

  const role = (session.profile?.university_role ?? "").toLowerCase();
  const isStaff = session.isAuthenticated && role === "staff";
  const displayName =
    session.profile?.display_name ||
    session.email?.split("@")[0] ||
    "Account";
  const initials = displayName.slice(0, 2).toUpperCase();

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

  // Close menus on outside click or Escape key (auto-closes on route change via pathname match)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setAccountMenuPath(null);
        setMobileOpenPath(null);
      }
    }
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setAccountMenuPath(null);
      }
    }
    if (accountMenuOpen) {
      window.addEventListener("keydown", handleKeyDown);
      document.addEventListener("mousedown", handleClickOutside);
      return () => {
        window.removeEventListener("keydown", handleKeyDown);
        document.removeEventListener("mousedown", handleClickOutside);
      };
    }
  }, [accountMenuOpen]);

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
            className="hidden h-7 w-[1.5px] bg-[#C9C5D6] xl:block"
            aria-hidden="true"
          />
          <span className="hidden flex-col leading-[1.15] xl:flex">
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
          className="hidden items-center gap-0.5 lg:flex xl:gap-1.5"
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
                className={`rounded-lg px-2.5 py-1.5 text-[13px] font-semibold transition-colors whitespace-nowrap xl:px-3.5 xl:py-2 xl:text-[14px] ${
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
              className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[13px] font-bold text-[#4E2A84] hover:bg-[#F4F2FA] whitespace-nowrap xl:px-3 xl:py-2 xl:text-[14px]"
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
          className="hidden min-w-[110px] flex-1 max-w-[170px] items-center rounded-full border border-[#CFCBD9] bg-[#FAFAFC] px-3 py-1.5 transition-colors focus-within:border-[#4E2A84] focus-within:bg-white md:flex xl:max-w-[300px]"
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
            className="w-full bg-transparent text-[13px] text-[#14121A] placeholder:text-[#656173] focus:outline-none"
          />
        </form>

        {/* Desktop Utility Group: Cart | Messages | Notifications | Account Hamburger */}
        <div className="hidden items-center gap-1.5 lg:flex xl:gap-2">
          {/* Shopping Cart (Task 4: Honest coming-soon / disabled state) */}
          <button
            type="button"
            disabled
            aria-disabled="true"
            title="Shopping Cart — coming in Phase 3"
            aria-label="Shopping Cart (Coming in Phase 3)"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-[#E6E4EE] text-[#555062] opacity-80 cursor-not-allowed hover:border-[#4E2A84]"
          >
            <ShoppingCart className="h-[18px] w-[18px]" aria-hidden="true" />
          </button>

          {/* Messages (Shown on xl screens to maintain breathing room on tablet) */}
          <button
            type="button"
            disabled
            aria-disabled="true"
            title="Messages — coming in Phase 5"
            aria-label="Messages (coming in Phase 5)"
            className="hidden h-9 w-9 items-center justify-center rounded-full text-[#706C7E] opacity-70 cursor-not-allowed xl:flex"
          >
            <MessageCircle className="h-[19px] w-[19px]" aria-hidden="true" />
          </button>

          {/* Notifications (Shown on xl screens to maintain breathing room on tablet) */}
          <button
            type="button"
            disabled
            aria-disabled="true"
            title="Notifications — coming in Phase 5"
            aria-label="Notifications (coming in Phase 5)"
            className="hidden h-9 w-9 items-center justify-center rounded-full text-[#706C7E] opacity-70 cursor-not-allowed xl:flex"
          >
            <Bell className="h-[19px] w-[19px]" aria-hidden="true" />
          </button>

          <span className="hidden h-5 w-px bg-[#DCD9E6] xl:block" aria-hidden="true" />

          {/* Task 5: Compact Animated Account Hamburger Menu */}
          {session.isAuthenticated ? (
            <div className="relative" ref={menuRef}>
              <button
                type="button"
                onClick={() => setAccountMenuOpen((prev) => !prev)}
                aria-expanded={accountMenuOpen}
                aria-haspopup="menu"
                aria-controls="account-dropdown-menu"
                aria-label={`Account menu for ${displayName}`}
                className="flex items-center gap-2 rounded-full border border-[#DCD9E6] bg-white p-1 pl-2.5 text-[#14121A] transition-all hover:border-[#4E2A84] hover:bg-[#F8F6FD] press-feedback focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4E2A84]"
              >
                <Menu className="h-4 w-4 text-[#3E3B4B]" aria-hidden="true" />
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#4E2A84] text-xs font-bold text-white shadow-xs">
                  {initials}
                </span>
              </button>

              {/* Animated Floating Dropdown */}
              {accountMenuOpen ? (
                <div
                  id="account-dropdown-menu"
                  role="menu"
                  aria-orientation="vertical"
                  className="absolute right-0 top-full mt-2 w-64 origin-top-right rounded-2xl border border-[#E6E3EE] bg-white p-3 shadow-[0_12px_32px_rgba(20,18,26,0.12)] transition-all animate-in fade-in-50 zoom-in-95 duration-150 z-50"
                >
                  {/* Account Header */}
                  <div className="flex items-center gap-3 border-b border-[#F0EDF5] pb-3 px-1">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#4E2A84] text-sm font-bold text-white">
                      {initials}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-[#14121A]">
                        {displayName}
                      </p>
                      <p className="truncate text-xs text-[#716C7D]">
                        {session.email}
                      </p>
                      <span className="mt-1 inline-block rounded-md bg-[#F4F1FA] px-1.5 py-0.5 text-[10px] font-bold text-[#4E2A84]">
                        {role === "student"
                          ? "Verified Student"
                          : role === "staff"
                            ? "UMS Staff"
                            : "Campus Member"}
                      </span>
                    </div>
                  </div>

                  {/* Menu Items */}
                  <div className="py-2 space-y-1">
                    <Link
                      href="/account"
                      role="menuitem"
                      onClick={() => setAccountMenuOpen(false)}
                      className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-semibold text-[#14121A] hover:bg-[#F8F6FD] hover:text-[#4E2A84] transition-colors"
                    >
                      <User className="h-4 w-4 text-[#716C7D]" aria-hidden="true" />
                      <span>My Profile &amp; Overview</span>
                    </Link>

                    {session.isActiveAdmin ? (
                      <Link
                        href="/admin"
                        role="menuitem"
                        onClick={() => setAccountMenuOpen(false)}
                        className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-bold text-[#4E2A84] hover:bg-[#F4F1FA] transition-colors"
                      >
                        <ShieldCheck className="h-4 w-4 text-[#4E2A84]" aria-hidden="true" />
                        <span>Admin Console</span>
                      </Link>
                    ) : null}
                  </div>

                  {/* Sign Out Item */}
                  <div className="border-t border-[#F0EDF5] pt-2">
                    <form action={signOutAction}>
                      <button
                        type="submit"
                        role="menuitem"
                        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-semibold text-[#BA1A1A] hover:bg-[#FDF2F2] transition-colors"
                      >
                        <LogOut className="h-4 w-4" aria-hidden="true" />
                        <span>Sign Out</span>
                      </button>
                    </form>
                  </div>
                </div>
              ) : null}
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
            aria-label={
              mobileOpen ? "Close navigation menu" : "Open navigation menu"
            }
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
          className="border-t border-[#E6E4EE] bg-white p-4 lg:hidden"
        >
          <form
            onSubmit={handleSearchSubmit}
            role="search"
            aria-label="Mobile search campus marketplace"
            className="mb-3 flex items-center rounded-full border border-[#CFCBD9] bg-[#FAFAFC] px-3.5 py-2"
          >
            <Search className="mr-2 h-4 w-4 text-[#3E3B4B]" aria-hidden="true" />
            <input
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
                      className="w-full rounded-lg border border-[#DCD9E6] bg-white px-3 py-2.5 text-left text-sm font-semibold text-[#BA1A1A] hover:bg-[#FDF2F2]"
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
