import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Lock, LogOut, ShieldCheck } from "lucide-react";
import { signOutAction } from "@/app/auth/actions";
import { AdminDisputesClient } from "@/components/admin/AdminDisputesClient";
import { getAdminDisputesData } from "@/lib/disputes/data";
import { getSessionSummary } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Admin Console",
  description: "Protected Buy-U administrator workspace.",
};

export default async function AdminPage() {
  const session = await getSessionSummary();

  if (!session.isAuthenticated) {
    redirect("/admin/login");
  }

  // Regular signed-in UMS student/staff: deny admin access WITHOUT signing them out.
  if (!session.isActiveAdmin) {
    return (
      <div className="mx-auto w-full max-w-xl px-4 py-12 sm:px-6">
        <div className="border-2 border-[#14121A] bg-white p-6 sm:p-8">
          <div className="flex items-center gap-2.5 text-[#4E2A84]">
            <Lock className="h-5 w-5" aria-hidden="true" />
            <h1 className="text-2xl font-extrabold tracking-tight text-[#14121A]">
              Administrator Access Required
            </h1>
          </div>
          <p className="mt-3 text-sm leading-relaxed text-[#4A4656]">
            Your UMS member session (<code className="font-mono">{session.email}</code>)
            is still active, but this account does not hold active Buy-U
            administrator privileges verified by{" "}
            <code className="font-mono">is_active_admin()</code>.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link
              href="/marketplace"
              className="bg-[#4E2A84] px-5 py-2.5 text-sm font-bold text-white hover:bg-[#381C63] press-feedback"
            >
              Return to Marketplace
            </Link>
            <Link
              href="/account"
              className="border-2 border-[#14121A] bg-white px-5 py-2.5 text-sm font-bold text-[#14121A] hover:bg-[#F7F7F5]"
            >
              View Account
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const { disputes, error: disputesError } = await getAdminDisputesData(session);

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-10 sm:px-6 lg:px-10">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b-2 border-[#14121A] pb-4">
        <div className="flex items-center gap-3.5">
          <Link href="/" className="press-feedback shrink-0" aria-label="Buy-U Home">
            <Image
              src="/images/logo/buyu-logo.png"
              alt="Buy-U"
              width={48}
              height={54}
              className="h-11 w-auto object-contain select-none"
            />
          </Link>
          <div>
            <h1 className="text-3xl font-extrabold tracking-[-0.03em] text-[#14121A]">
              Buy-U{" "}
              <span className="font-editorial italic font-bold text-[#4E2A84]">
                Admin Console
              </span>
            </h1>
            <p className="mt-1 text-sm text-[#4A4656]">
              Verified via backend <code className="font-mono">is_active_admin()</code>{" "}
              ({session.email}).
            </p>
          </div>
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

      <div className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-3">
        {[
          {
            title: "User & Role Moderation",
            desc: "Review member status, restrictions, and UMS role integrity (Phase 6).",
          },
          {
            title: "Listings & Reports Queue",
            desc: "Moderate published listings, free notices, and community reports (Phase 6).",
          },
          {
            title: "Payouts, Disputes & Audit Logs",
            desc: "Process seller payout requests, disputes, and immutable audit logs (Phase 6).",
          },
        ].map((item) => (
          <section
            key={item.title}
            className="border-2 border-[#14121A] bg-[#F7F7F5] p-6"
          >
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-[#4E2A84]" aria-hidden="true" />
              <h2 className="text-base font-extrabold text-[#14121A]">
                {item.title}
              </h2>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-[#4A4656]">
              {item.desc}
            </p>
          </section>
        ))}
      </div>
      {/* Phase 6D.1 Admin Dispute Management Queue */}
      <section className="mt-8 space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-xl font-extrabold tracking-tight text-[#14121A]">
              Order Disputes &amp; Buyer Protection
            </h2>
            <p className="mt-0.5 text-xs text-[#6B6779]">
              Review buyer/seller evidence, record internal notes, and propose
              resolutions. Refund proposals remain pending execution until Phase
              6D.2.
            </p>
          </div>
          <span className="text-xs font-bold text-[#4E2A84]">
            {disputes.length} {disputes.length === 1 ? "case" : "cases"}
          </span>
        </div>

        {disputesError ? (
          <p role="alert" className="rounded-xl border border-[#F9C6C2] bg-[#FEF2F2] p-4 text-xs font-semibold text-[#B42318]">
            {disputesError}
          </p>
        ) : (
          <AdminDisputesClient disputes={disputes} />
        )}
      </section>
    </div>
  );
}
