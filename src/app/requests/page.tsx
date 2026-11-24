import type { Metadata } from "next";
import Link from "next/link";
import {
  ServiceRequestsClient,
  type ServiceRequestRow,
} from "@/components/services/ServiceRequestsClient";
import { evaluateBuyerEligibility } from "@/lib/buyer/validation";
import { getSessionSummary } from "@/lib/supabase/server";
import { getServerServiceClient } from "@/lib/supabase/service";

export const metadata: Metadata = {
  title: "My Service Requests",
  description: "Track your requested campus services and confirm completed deliveries.",
};

export const dynamic = "force-dynamic";

export default async function BuyerRequestsPage() {
  const session = await getSessionSummary();
  const elig = evaluateBuyerEligibility(session);

  if (!elig.eligible || !elig.userId) {
    return (
      <div className="mx-auto max-w-xl px-4 py-12 text-center">
        <h1 className="text-xl font-extrabold text-[#14121A]">Sign in required</h1>
        <p className="mt-1 text-xs text-[#6B6779]">{elig.reason || "Sign in with your UMS account to view your service requests."}</p>
        <Link href="/login?next=/requests" className="mt-4 inline-block rounded-xl bg-[#4E2A84] px-4 py-2 text-xs font-bold text-white">
          Sign In
        </Link>
      </div>
    );
  }

  const service = getServerServiceClient();
  let rows: ServiceRequestRow[] = [];

  if (service) {
    const { data: rawReqs } = await service
      .from("service_requests")
      .select("id,request_code,listing_id,seller_id,mode,requirements,preferred_date,proposed_arrangement,cancellation_reason,status,created_at")
      .eq("buyer_id", elig.userId)
      .order("created_at", { ascending: false })
      .limit(50);

    const list = (rawReqs ?? []) as Array<{
      id: string;
      request_code: string | null;
      listing_id: string;
      seller_id: string;
      mode: string;
      requirements: string;
      preferred_date: string | null;
      proposed_arrangement: string | null;
      cancellation_reason: string | null;
      status: string;
      created_at: string;
    }>;

    const listingIds = Array.from(new Set(list.map((r) => r.listing_id)));
    const sellerIds = Array.from(new Set(list.map((r) => r.seller_id)));
    const reqIds = list.map((r) => r.id);

    const [lRes, pRes, rRes] = await Promise.all([
      listingIds.length ? service.from("listings").select("id,title").in("id", listingIds) : Promise.resolve({ data: [] }),
      sellerIds.length ? service.from("profiles").select("id,display_name,full_name").in("id", sellerIds) : Promise.resolve({ data: [] }),
      reqIds.length ? service.from("reviews").select("service_request_id").in("service_request_id", reqIds) : Promise.resolve({ data: [] }),
    ]);

    const titleMap = new Map(((lRes.data ?? []) as Array<{ id: string; title: string }>).map((l) => [l.id, l.title]));
    const sellerMap = new Map(((pRes.data ?? []) as Array<{ id: string; display_name: string | null; full_name: string | null }>).map((p) => [p.id, p.display_name || p.full_name || "UMS Provider"]));
    const reviewedSet = new Set(((rRes.data ?? []) as Array<{ service_request_id: string | null }>).map((r) => r.service_request_id).filter(Boolean));

    rows = list.map((r) => ({
      id: r.id,
      requestCode: r.request_code || `SVC-${r.id.slice(0, 6).toUpperCase()}`,
      listingId: r.listing_id,
      serviceTitle: titleMap.get(r.listing_id) ?? "Campus Service",
      counterpartyName: sellerMap.get(r.seller_id) ?? "UMS Provider",
      mode: r.mode,
      requirements: r.requirements,
      preferredDate: r.preferred_date,
      proposedArrangement: r.proposed_arrangement,
      cancellationReason: r.cancellation_reason,
      status: r.status,
      hasReview: reviewedSet.has(r.id),
      createdAt: r.created_at,
    }));
  }

  return (
    <div className="mx-auto w-full max-w-[1000px] space-y-6 px-4 py-6 sm:px-6 lg:px-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-[#14121A]">My Service Requests</h1>
          <p className="mt-1 text-sm text-[#6B6779]">
            Track requests submitted to student providers, confirm completion, and leave verified reviews.
          </p>
        </div>
        <Link href="/services" className="rounded-xl bg-[#4E2A84] px-3.5 py-2 text-xs font-bold text-white">
          Browse Services
        </Link>
      </div>
      <ServiceRequestsClient requests={rows} role="buyer" />
    </div>
  );
}
