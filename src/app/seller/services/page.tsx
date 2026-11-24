import type { Metadata } from "next";
import { SellerGate } from "@/components/seller/SellerGate";
import { SellerNav } from "@/components/seller/SellerNav";
import {
  ServiceRequestsClient,
  type ServiceRequestRow,
} from "@/components/services/ServiceRequestsClient";
import { evaluateSellerEligibility } from "@/lib/seller/validation";
import { getSessionSummary } from "@/lib/supabase/server";
import { getServerServiceClient } from "@/lib/supabase/service";

export const metadata: Metadata = {
  title: "Seller Service Requests",
  description: "Review, accept, deliver, and manage incoming campus service requests.",
};

export const dynamic = "force-dynamic";

export default async function SellerServicesPage() {
  const session = await getSessionSummary();
  const elig = evaluateSellerEligibility(session);

  if (!elig.eligible) {
    return <SellerGate eligibility={elig} nextPath="/seller/services" />;
  }
  const sellerId = session.profile?.id;
  if (!sellerId) {
    return null;
  }

  const service = getServerServiceClient();
  let rows: ServiceRequestRow[] = [];

  if (service) {
    const { data: rawReqs } = await service
      .from("service_requests")
      .select("id,request_code,listing_id,buyer_id,mode,requirements,preferred_date,proposed_arrangement,cancellation_reason,status,created_at")
      .eq("seller_id", sellerId)
      .order("created_at", { ascending: false })
      .limit(50);

    const list = (rawReqs ?? []) as Array<{
      id: string;
      request_code: string | null;
      listing_id: string;
      buyer_id: string;
      mode: string;
      requirements: string;
      preferred_date: string | null;
      proposed_arrangement: string | null;
      cancellation_reason: string | null;
      status: string;
      created_at: string;
    }>;

    const listingIds = Array.from(new Set(list.map((r) => r.listing_id)));
    const buyerIds = Array.from(new Set(list.map((r) => r.buyer_id)));

    const [lRes, pRes] = await Promise.all([
      listingIds.length ? service.from("listings").select("id,title").in("id", listingIds) : Promise.resolve({ data: [] }),
      buyerIds.length ? service.from("profiles").select("id,display_name,full_name").in("id", buyerIds) : Promise.resolve({ data: [] }),
    ]);

    const titleMap = new Map(((lRes.data ?? []) as Array<{ id: string; title: string }>).map((l) => [l.id, l.title]));
    const buyerMap = new Map(((pRes.data ?? []) as Array<{ id: string; display_name: string | null; full_name: string | null }>).map((p) => [p.id, p.display_name || p.full_name || "UMS Member"]));

    rows = list.map((r) => ({
      id: r.id,
      requestCode: r.request_code || `SVC-${r.id.slice(0, 6).toUpperCase()}`,
      listingId: r.listing_id,
      serviceTitle: titleMap.get(r.listing_id) ?? "Campus Service",
      counterpartyName: buyerMap.get(r.buyer_id) ?? "UMS Member",
      mode: r.mode,
      requirements: r.requirements,
      preferredDate: r.preferred_date,
      proposedArrangement: r.proposed_arrangement,
      cancellationReason: r.cancellation_reason,
      status: r.status,
      hasReview: false,
      createdAt: r.created_at,
    }));
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-6 px-4 py-6 sm:px-6 lg:px-10">
      <SellerNav />
      <div>
        <h1 className="text-2xl font-extrabold tracking-[-0.02em] text-[#14121A] sm:text-3xl">
          Incoming Service Requests
        </h1>
        <p className="mt-1 text-sm text-[#6B6779]">
          Accept or decline student/staff service requests and mark services delivered for buyer confirmation.
        </p>
      </div>
      <ServiceRequestsClient requests={rows} role="seller" />
    </div>
  );
}
