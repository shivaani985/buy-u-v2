import type { Metadata } from "next";
import Link from "next/link";
import { Database, Lock, ShieldCheck, Store } from "lucide-react";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { getSessionSummary } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Account & Auth Foundation",
  description:
    "Buy-U v2 authentication foundation, Supabase connection status, and role separation roadmap.",
};

export default async function AccountPage() {
  const configured = isSupabaseConfigured();
  const session = await getSessionSummary();

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-10 sm:px-6 lg:px-10">
      <div className="border-b-2 border-[#14121A] pb-4">
        <h1 className="text-3xl font-extrabold tracking-[-0.03em] text-[#14121A] sm:text-4xl">
          Account &amp;{" "}
          <span className="font-editorial italic font-bold text-[#4E2A84]">
            Auth Foundation
          </span>
        </h1>
        <p className="mt-2 max-w-[65ch] text-sm leading-relaxed text-[#4A4656]">
          Phase 1 prepares the read-only Supabase session layer without enabling
          account mutations or unverified role elevation.
        </p>
      </div>

      <div className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-2">
        <section className="border-2 border-[#14121A] bg-white p-6">
          <div className="flex items-center gap-2.5">
            <Database className="h-5 w-5 text-[#1D70B8]" aria-hidden="true" />
            <h2 className="text-lg font-extrabold text-[#14121A]">
              Supabase Connection Status
            </h2>
          </div>

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
                {configured ? "Yes (Public Anon Key)" : "Not configured yet"}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-[#4A4656]">Active Session</dt>
              <dd className="font-semibold text-[#14121A]">
                {session.isAuthenticated
                  ? session.email ?? "Signed in"
                  : "Guest (Read-only)"}
              </dd>
            </div>
          </dl>

          <p className="mt-4 text-xs leading-relaxed text-[#4A4656]">
            To connect the existing Supabase project safely, copy{" "}
            <code className="font-mono">.env.example</code> to{" "}
            <code className="font-mono">.env.local</code> with your public URL
            and anon key only. Never expose service-role keys in the browser.
          </p>
        </section>

        <section className="border-2 border-[#14121A] bg-[#F7F7F5] p-6">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="h-5 w-5 text-[#007D80]" aria-hidden="true" />
            <h2 className="text-lg font-extrabold text-[#14121A]">
              UMS Role Separation (Phase 2)
            </h2>
          </div>

          <ul className="mt-4 space-y-2.5 text-sm text-[#4A4656]">
            <li className="flex items-start gap-2">
              <Lock className="mt-0.5 h-4 w-4 shrink-0 text-[#4E2A84]" aria-hidden="true" />
              <span>
                <strong className="text-[#14121A]">Verified UMS Students:</strong>{" "}
                University email verification and profile check against{" "}
                <code className="font-mono">profiles</code>.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <Lock className="mt-0.5 h-4 w-4 shrink-0 text-[#007D80]" aria-hidden="true" />
              <span>
                <strong className="text-[#14121A]">UMS Staff:</strong> Separate
                staff role verified server-side, never via editable client
                metadata.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <Lock className="mt-0.5 h-4 w-4 shrink-0 text-[#1D70B8]" aria-hidden="true" />
              <span>
                <strong className="text-[#14121A]">Buy-U Admins:</strong>{" "}
                Dedicated admin portal backed by{" "}
                <code className="font-mono">admin_users</code> and RLS checks.
              </span>
            </li>
          </ul>
        </section>
      </div>

      <section
        id="sell-roadmap"
        className="mt-8 border-2 border-[#4E2A84] bg-white p-6"
      >
        <div className="flex items-center gap-2.5">
          <Store className="h-5 w-5 text-[#4E2A84]" aria-hidden="true" />
          <h2 className="text-lg font-extrabold text-[#14121A]">
            Selling on Buy-U (Upcoming Phase)
          </h2>
        </div>
        <p className="mt-2 max-w-[70ch] text-sm leading-relaxed text-[#4A4656]">
          Seller listing creation, stock management, storefronts, and image
          uploads will be enabled after the existing Supabase schema and UMS
          authentication flow are verified in Phase 2.
        </p>
        <div className="mt-4">
          <Link
            href="/marketplace"
            className="inline-block bg-[#4E2A84] px-5 py-2.5 text-sm font-bold text-white hover:bg-[#381C63] press-feedback"
          >
            Return to Marketplace
          </Link>
        </div>
      </section>
    </div>
  );
}
