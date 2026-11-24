import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Lock, LogOut } from "lucide-react";
import { signOutAction } from "@/app/auth/actions";
import { AdminDisputesClient } from "@/components/admin/AdminDisputesClient";
import { AdminFinancialsClient } from "@/components/admin/AdminFinancialsClient";
import { AdminPlatformPortalClient } from "@/components/admin/AdminPlatformPortalClient";
import { loadAnalyticsDataset } from "@/lib/analytics/data";
import {
  computeAdminPlatformAnalytics,
  resolveAnalyticsWindow,
  type AnalyticsRangeKey,
} from "@/lib/analytics/metrics";
import { getAdminDisputesData } from "@/lib/disputes/data";
import { getAdminFinancialsData } from "@/lib/financials/admin-data";
import { getSessionSummary } from "@/lib/supabase/server";
import { getServerServiceClient } from "@/lib/supabase/service";

export const metadata: Metadata = {
  title: "Admin Console",
  description: "Protected Buy-U administrator workspace.",
};

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const [session, sp] = await Promise.all([getSessionSummary(), searchParams]);

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

  const rawRange = sp.range;
  const range: AnalyticsRangeKey =
    rawRange === "7d" || rawRange === "30d" || rawRange === "90d" || rawRange === "this_month" || rawRange === "all"
      ? rawRange
      : "30d";

  const service = getServerServiceClient();
  const [
    { disputes, error: disputesError },
    financialsData,
    analyticsDataset,
    usersRes,
    listingsRes,
    reportsRes,
    reviewsRes,
    catsRes,
    areasRes,
    spotsRes,
    auditRes,
  ] = await Promise.all([
    getAdminDisputesData(session),
    getAdminFinancialsData(session),
    loadAnalyticsDataset(),
    service
      ? service.from("profiles").select("id,display_name,full_name,email,university_role,status,faculty,created_at").order("created_at", { ascending: false }).limit(100)
      : Promise.resolve({ data: [] }),
    service
      ? service.from("listings").select("id,title,kind,status,seller_id,price_sen").order("created_at", { ascending: false }).limit(100)
      : Promise.resolve({ data: [] }),
    service
      ? service.from("reports").select("id,target_kind,target_id,reason,explanation,status,created_at").order("created_at", { ascending: false }).limit(100)
      : Promise.resolve({ data: [] }),
    service
      ? service.from("reviews").select("id,rating,comment,hidden,created_at").order("created_at", { ascending: false }).limit(100)
      : Promise.resolve({ data: [] }),
    service ? service.from("categories").select("id,name,kind,active").order("sort_order") : Promise.resolve({ data: [] }),
    service ? service.from("collection_areas").select("id,name,active").order("name") : Promise.resolve({ data: [] }),
    service ? service.from("donation_spots").select("id,name,active").order("name") : Promise.resolve({ data: [] }),
    service
      ? service.from("admin_audit_logs").select("id,action,target_kind,target_id,reason,created_at").order("created_at", { ascending: false }).limit(80)
      : Promise.resolve({ data: [] }),
  ]);

  const adminStats = computeAdminPlatformAnalytics(
    analyticsDataset ?? {
      profiles: [],
      listings: [],
      orders: [],
      orderItems: [],
      checkoutSessions: [],
      legacyPayments: [],
      refunds: [],
      views: [],
      favourites: [],
      serviceRequests: [],
      freeNotices: [],
      freeClaims: [],
      reviews: [],
      reports: [],
      disputes: [],
    },
    resolveAnalyticsWindow(range)
  );

  const userRows = ((usersRes.data ?? []) as Array<{
    id: string;
    display_name: string | null;
    full_name: string | null;
    email: string;
    university_role: string;
    status: string;
    faculty: string | null;
    created_at: string;
  }>).map((u) => ({
    id: u.id,
    displayName: u.display_name || u.full_name || "UMS Member",
    email: u.email,
    role: u.university_role,
    status: u.status,
    faculty: u.faculty,
    createdAt: u.created_at,
  }));
  const userNameMap = new Map(userRows.map((u) => [u.id, u.displayName]));

  const listingRows = ((listingsRes.data ?? []) as Array<{
    id: string;
    title: string;
    kind: string;
    status: string;
    seller_id: string;
    price_sen: number;
  }>).map((l) => ({
    id: l.id,
    title: l.title,
    kind: l.kind,
    status: l.status,
    sellerName: userNameMap.get(l.seller_id) ?? "UMS Seller",
    priceSen: l.price_sen,
  }));

  const reportRows = ((reportsRes.data ?? []) as Array<{
    id: string;
    report_code?: string | null;
    target_kind: string;
    target_id: string;
    reason: string;
    explanation: string;
    status: string;
    priority?: string | null;
    created_at: string;
  }>).map((r) => ({
    id: r.id,
    reportCode: r.report_code || `RPT-${r.id.slice(0, 6).toUpperCase()}`,
    targetKind: r.target_kind,
    targetId: r.target_id,
    reason: r.reason,
    explanation: r.explanation,
    status: r.status,
    priority: r.priority || "normal",
    createdAt: r.created_at,
  }));

  const reviewRows = ((reviewsRes.data ?? []) as Array<{
    id: string;
    rating: number;
    comment: string;
    hidden: boolean;
    created_at: string;
  }>).map((r) => ({
    id: r.id,
    rating: r.rating,
    comment: r.comment,
    hidden: Boolean(r.hidden),
    createdAt: r.created_at,
  }));

  const auditRows = ((auditRes.data ?? []) as Array<{
    id: string;
    action: string;
    target_kind: string;
    target_id: string;
    reason: string;
    created_at: string;
  }>).map((a) => ({
    id: a.id,
    action: a.action,
    targetKind: a.target_kind,
    targetId: a.target_id,
    reason: a.reason,
    createdAt: a.created_at,
  }));

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

      {/* Phase 9A & 9F: Platform Analytics, Student Entrepreneurship Insights, Moderation & Audit Logs */}
      <section className="mt-8 space-y-4">
        <div>
          <h2 className="text-xl font-extrabold tracking-tight text-[#14121A]">
            Platform Analytics, Entrepreneurship &amp; Moderation Portal
          </h2>
          <p className="mt-0.5 text-xs text-[#6B6779]">
            Database-derived marketplace KPIs, student entrepreneurship insights, member/listing/review moderation, catalog spots, and centralized audit logs.
          </p>
        </div>
        <AdminPlatformPortalClient
          range={range}
          stats={adminStats}
          users={userRows}
          listings={listingRows}
          reports={reportRows}
          reviews={reviewRows}
          catalog={{
            categories: (catsRes.data ?? []) as Array<{ id: string; name: string; kind: string; active: boolean }>,
            collectionAreas: (areasRes.data ?? []) as Array<{ id: string; name: string; active: boolean }>,
            donationSpots: (spotsRes.data ?? []) as Array<{ id: string; name: string; active: boolean }>,
          }}
          auditLogs={auditRows}
        />
      </section>
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

      {/* Phase 6D.2 & 6D.5 Admin Financial Management, Refunds & Reconciliation */}
      {financialsData ? (
        <section className="mt-10 space-y-4 border-t border-[#E6E3EE] pt-8">
          <div>
            <h2 className="text-xl font-extrabold tracking-tight text-[#14121A]">
              Financial Management, Refunds &amp; Reconciliation
            </h2>
            <p className="mt-0.5 text-xs text-[#6B6779]">
              Monitor verified collections, execute approved simulated refunds,
              audit automated withdrawals, and run internal ledger
              reconciliation.
            </p>
          </div>
          <AdminFinancialsClient data={financialsData} />
        </section>
      ) : null}
    </div>
  );
}
