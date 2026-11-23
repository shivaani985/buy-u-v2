import type { Metadata } from "next";
import Link from "next/link";
import {
  Lock,
  LogIn,
  LogOut,
  ShieldCheck,
  ShoppingBag,
  Store,
  UserCheck,
  UserPlus,
  Wrench,
} from "lucide-react";
import { signOutAction } from "@/app/auth/actions";
import { formatShortDate } from "@/lib/format";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { getSessionSummary } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Account",
  description:
    "Your verified UMS Buy-U account overview, university role, and marketplace status.",
};

export default async function AccountPage() {
  const [configured, session] = await Promise.all([
    Promise.resolve(isSupabaseConfigured()),
    getSessionSummary(),
  ]);

  if (!session.isAuthenticated) {
    return (
      <div className="mx-auto w-full max-w-[1100px] px-4 py-10 sm:px-6 lg:px-10">
        <div className="border-b-2 border-[#14121A] pb-4">
          <h1 className="text-3xl font-extrabold tracking-[-0.03em] text-[#14121A] sm:text-4xl">
            UMS{" "}
            <span className="font-editorial italic font-bold text-[#4E2A84]">
              Account
            </span>
          </h1>
          <p className="mt-2 max-w-[65ch] text-sm leading-relaxed text-[#4A4656]">
            Sign in with your verified Universiti Malaysia Sabah account to
            browse live campus listings and view your profile.
          </p>
        </div>

        <div className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-2">
          <section className="border-2 border-[#14121A] bg-white p-6">
            <h2 className="text-xl font-extrabold text-[#14121A]">
              Sign in or create a UMS account
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-[#4A4656]">
              Students use <code className="font-mono text-[#4E2A84]">@iluv.ums.edu.my</code>{" "}
              and staff use <code className="font-mono text-[#007D80]">@ums.edu.my</code>.
              University roles are assigned strictly by the backend.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                href="/login"
                className="inline-flex items-center gap-2 bg-[#4E2A84] px-5 py-2.5 text-sm font-bold text-white hover:bg-[#381C63] press-feedback editorial-cut-tr"
              >
                <LogIn className="h-4 w-4" aria-hidden="true" />
                <span>Sign In</span>
              </Link>
              <Link
                href="/register"
                className="inline-flex items-center gap-2 border-2 border-[#14121A] bg-white px-5 py-2.5 text-sm font-bold text-[#14121A] hover:bg-[#F7F7F5]"
              >
                <UserPlus className="h-4 w-4" aria-hidden="true" />
                <span>Register</span>
              </Link>
            </div>
          </section>

          <section className="border-2 border-[#14121A] bg-[#F7F7F5] p-6">
            <h2 className="text-lg font-extrabold text-[#14121A]">
              Environment &amp; Role Separation
            </h2>
            <dl className="mt-4 space-y-2.5 text-sm">
              <div className="flex items-center justify-between border-b border-[#E2E0E8] pb-2">
                <dt className="text-[#4A4656]">Target Project Ref</dt>
                <dd className="font-mono font-semibold text-[#14121A]">
                  duwwlcpdidrxkixvflag
                </dd>
              </div>
              <div className="flex items-center justify-between border-b border-[#E2E0E8] pb-2">
                <dt className="text-[#4A4656]">Environment Configured</dt>
                <dd className="font-bold text-[#14121A]">
                  {configured ? "Yes (Public Anon Key)" : "Not configured"}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-[#4A4656]">Active Session</dt>
                <dd className="font-semibold text-[#14121A]">Guest</dd>
              </div>
            </dl>
          </section>
        </div>

        <section
          id="sell-roadmap"
          className="mt-8 border-2 border-[#4E2A84] bg-white p-6"
        >
          <div className="flex items-center gap-2.5">
            <Store className="h-5 w-5 text-[#4E2A84]" aria-hidden="true" />
            <h2 className="text-lg font-extrabold text-[#14121A]">
              Selling on Buy-U (Phase 3)
            </h2>
          </div>
          <p className="mt-2 max-w-[70ch] text-sm leading-relaxed text-[#4A4656]">
            Verified UMS students (@iluv.ums.edu.my) will be able to open a
            storefront and publish listings in Phase 3. UMS staff accounts can
            browse, purchase, and request services, but cannot sell.
          </p>
        </section>
      </div>
    );
  }

  const profile = session.profile;
  const role = (profile?.university_role ?? "member").toLowerCase();
  const isStudent = role === "student";
  const isStaff = role === "staff";
  const status = (profile?.status ?? "unknown").toLowerCase();
  const displayName =
    profile?.display_name ||
    profile?.full_name ||
    session.email?.split("@")[0] ||
    "UMS Member";
  const initials = displayName.slice(0, 2).toUpperCase();

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-10 sm:px-6 lg:px-10">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b-2 border-[#14121A] pb-4">
        <div>
          <h1 className="text-3xl font-extrabold tracking-[-0.03em] text-[#14121A] sm:text-4xl">
            Member{" "}
            <span className="font-editorial italic font-bold text-[#4E2A84]">
              Account
            </span>
          </h1>
          <p className="mt-1 text-sm text-[#4A4656]">
            Authoritative profile loaded from Supabase via your authenticated
            session.
          </p>
        </div>

        <form action={signOutAction}>
          <button
            type="submit"
            className="inline-flex items-center gap-2 border-2 border-[#14121A] bg-white px-4 py-2 text-sm font-bold text-[#14121A] hover:bg-[#14121A] hover:text-white press-feedback"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
            <span>Sign out</span>
          </button>
        </form>
      </div>

      {/* Security Lock Notice: Profile Editing Intentionally Read-Only */}
      <div
        role="status"
        className="mt-6 flex items-start gap-3 border-2 border-[#1D70B8] bg-[#F3F8FC] p-4 text-sm text-[#14121A]"
      >
        <Lock
          className="mt-0.5 h-4 w-4 shrink-0 text-[#1D70B8]"
          aria-hidden="true"
        />
        <div>
          <span className="font-bold text-[#14538A]">
            Profile Editing Temporarily Read-Only:{" "}
          </span>
          <span>
            Profile updates are intentionally disabled until the database
            column-level privilege remediation for{" "}
            <code className="font-mono">profiles_update_own</code> is reviewed
            and approved.
          </span>
        </div>
      </div>

      {/* Profile Overview */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-12">
        <section className="border-2 border-[#14121A] bg-white p-6 lg:col-span-7">
          <div className="flex items-center gap-4">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden border-2 border-[#14121A] bg-[#4E2A84] text-xl font-extrabold text-white editorial-cut-tr">
              {profile?.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={profile.avatar_url}
                  alt={displayName}
                  className="h-full w-full object-cover"
                />
              ) : (
                initials
              )}
            </div>

            <div>
              <h2 className="text-2xl font-extrabold text-[#14121A]">
                {displayName}
              </h2>
              <div className="mt-1.5 flex flex-wrap gap-2">
                <span className="bg-[#4E2A84] px-2.5 py-0.5 text-xs font-bold uppercase tracking-wider text-white">
                  {isStudent ? "UMS Student" : isStaff ? "UMS Staff" : role}
                </span>
                <span
                  className={`px-2.5 py-0.5 text-xs font-bold uppercase tracking-wider ${
                    status === "active"
                      ? "bg-[#00A3A6] text-[#14121A]"
                      : "bg-[#14121A] text-white"
                  }`}
                >
                  Status: {status}
                </span>
                {session.isEmailVerified ? (
                  <span className="inline-flex items-center gap-1 border border-[#00A3A6] bg-[#F2FAFA] px-2 py-0.5 text-xs font-semibold text-[#007D80]">
                    <UserCheck className="h-3.5 w-3.5" aria-hidden="true" />
                    Email Verified
                  </span>
                ) : null}
              </div>
            </div>
          </div>

          <dl className="mt-6 space-y-3 border-t border-[#E2E0E8] pt-5 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-[#4A4656]">University Email</dt>
              <dd className="font-mono font-semibold text-[#14121A]">
                {session.email}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-[#4A4656]">Faculty</dt>
              <dd className="font-semibold text-[#14121A]">
                {profile?.faculty || "Not set yet"}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-[#4A4656]">Member Since</dt>
              <dd className="font-semibold text-[#14121A]">
                {profile?.created_at
                  ? formatShortDate(profile.created_at)
                  : "Verified member"}
              </dd>
            </div>
          </dl>
        </section>

        {/* Role-Specific Capabilities */}
        <section className="border-2 border-[#14121A] bg-[#F7F7F5] p-6 lg:col-span-5">
          <h2 className="text-lg font-extrabold text-[#14121A]">
            Your Campus Access
          </h2>

          <div className="mt-4 space-y-3">
            <Link
              href="/marketplace"
              className="flex items-start gap-3 border border-[#14121A] bg-white p-4 hover:border-[#4E2A84]"
            >
              <ShoppingBag
                className="mt-0.5 h-5 w-5 shrink-0 text-[#4E2A84]"
                aria-hidden="true"
              />
              <div>
                <p className="text-sm font-bold text-[#14121A]">
                  Browse Live Marketplace
                </p>
                <p className="text-xs text-[#4A4656]">
                  Explore published UMSKAL listings, services, and free items.
                </p>
              </div>
            </Link>

            {isStudent ? (
              <div
                id="sell-roadmap"
                className="flex items-start gap-3 border border-[#D9D6E2] bg-white p-4"
              >
                <Store
                  className="mt-0.5 h-5 w-5 shrink-0 text-[#007D80]"
                  aria-hidden="true"
                />
                <div>
                  <p className="text-sm font-bold text-[#14121A]">
                    Student Seller Storefront (Phase 3)
                  </p>
                  <p className="text-xs text-[#4A4656]">
                    Your verified student role is eligible to list products,
                    campus food, and services in Phase 3.
                  </p>
                </div>
              </div>
            ) : null}

            {isStaff ? (
              <div className="flex items-start gap-3 border border-[#D9D6E2] bg-white p-4">
                <Wrench
                  className="mt-0.5 h-5 w-5 shrink-0 text-[#1D70B8]"
                  aria-hidden="true"
                />
                <div>
                  <p className="text-sm font-bold text-[#14121A]">
                    UMS Staff Buyer &amp; Service Access
                  </p>
                  <p className="text-xs text-[#4A4656]">
                    Staff accounts can browse, purchase, contact sellers, and
                    submit service requests. Selling is reserved for UMS
                    students.
                  </p>
                </div>
              </div>
            ) : null}

            {session.isActiveAdmin ? (
              <Link
                href="/admin"
                className="flex items-start gap-3 border-2 border-[#4E2A84] bg-[#F8F4FC] p-4 hover:bg-[#4E2A84] hover:text-white group"
              >
                <ShieldCheck
                  className="mt-0.5 h-5 w-5 shrink-0 text-[#4E2A84] group-hover:text-white"
                  aria-hidden="true"
                />
                <div>
                  <p className="text-sm font-bold">Open Admin Console</p>
                  <p className="text-xs opacity-80">
                    Verified active Buy-U administrator access.
                  </p>
                </div>
              </Link>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
