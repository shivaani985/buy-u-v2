import type { Metadata } from "next";
import { SellerAnalyticsClient } from "@/components/analytics/SellerAnalyticsClient";
import { SellerGate } from "@/components/seller/SellerGate";
import { SellerNav } from "@/components/seller/SellerNav";
import { loadAnalyticsDataset } from "@/lib/analytics/data";
import {
  computeSellerAnalytics,
  resolveAnalyticsWindow,
  type AnalyticsRangeKey,
} from "@/lib/analytics/metrics";
import { evaluateSellerEligibility } from "@/lib/seller/validation";
import { getSessionSummary } from "@/lib/supabase/server";
import { getServerServiceClient } from "@/lib/supabase/service";

export const metadata: Metadata = {
  title: "Seller Business Analytics",
  description: "Track verified sales, product performance, views, services, and reviews.",
};

export const dynamic = "force-dynamic";

export default async function SellerAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; start?: string; end?: string }>;
}) {
  const [session, sp] = await Promise.all([getSessionSummary(), searchParams]);
  const elig = evaluateSellerEligibility(session);

  if (!elig.eligible) {
    return <SellerGate eligibility={elig} nextPath="/seller/analytics" />;
  }
  const sellerId = session.profile?.id;
  if (!sellerId) {
    return null;
  }

  const rawRange = sp.range;
  const customStart = sp.start?.trim() || null;
  const customEnd = sp.end?.trim() || null;
  const range: AnalyticsRangeKey =
    rawRange === "7d" ||
    rawRange === "30d" ||
    rawRange === "90d" ||
    rawRange === "this_month" ||
    rawRange === "all" ||
    (rawRange === "custom" && customStart && customEnd)
      ? rawRange
      : "30d";

  const [dataset, service] = await Promise.all([
    loadAnalyticsDataset(),
    Promise.resolve(getServerServiceClient()),
  ]);

  const win = resolveAnalyticsWindow(range, undefined, customStart, customEnd);
  const analytics = computeSellerAnalytics(
    sellerId,
    dataset ?? {
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
    win
  );

  let recentReviews: Array<{
    id: string;
    rating: number;
    comment: string;
    sellerResponse: string | null;
    createdAt: string;
  }> = [];

  if (service) {
    const revRes = await service
      .from("reviews")
      .select("id,rating,comment,seller_response,created_at")
      .eq("seller_id", sellerId)
      .eq("hidden", false)
      .order("created_at", { ascending: false })
      .limit(20)
      .then(async (res) => {
        if (!res.error) return res;
        return service
          .from("reviews")
          .select("id,rating,comment,created_at")
          .eq("seller_id", sellerId)
          .eq("hidden", false)
          .order("created_at", { ascending: false })
          .limit(20);
      });

    recentReviews = ((revRes.data ?? []) as Array<{ id: string; rating: number; comment: string; seller_response?: string | null; created_at: string }>).map((r) => ({
      id: r.id,
      rating: r.rating,
      comment: r.comment,
      sellerResponse: r.seller_response ?? null,
      createdAt: r.created_at,
    }));
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-6 px-4 py-6 sm:px-6 lg:px-10">
      <SellerNav />
      <div>
        <h1 className="text-2xl font-extrabold tracking-[-0.02em] text-[#14121A] sm:text-3xl">
          Seller Business Analytics
        </h1>
        <p className="mt-1 text-sm text-[#6B6779]">
          Verified sales trends, listing conversion, service requests, and customer ratings (MYT).
        </p>
      </div>
      <SellerAnalyticsClient
        range={range}
        customStart={customStart}
        customEnd={customEnd}
        analytics={analytics}
        recentReviews={recentReviews}
      />
    </div>
  );
}
