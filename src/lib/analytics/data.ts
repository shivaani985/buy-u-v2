import {
  fetchAllPaginated,
  type AnalyticsDatasetInput,
  type PaginatedResult,
} from "@/lib/analytics/metrics";
import { getServerServiceClient } from "@/lib/supabase/service";

/**
 * Loads genuine database records for Seller or Admin analytics (server-only)
 * with full pagination across all tables and graceful pre-migration column fallback.
 */
export async function loadAnalyticsDataset(): Promise<AnalyticsDatasetInput | null> {
  const service = getServerServiceClient();
  if (!service) return null;

  const [
    profiles,
    listings,
    orders,
    orderItems,
    checkoutSessions,
    legacyPayments,
    refunds,
    views,
    favourites,
    serviceRequests,
    freeNotices,
    freeClaims,
    reviews,
    reports,
    disputes,
  ] = await Promise.all([
    fetchAllPaginated<AnalyticsDatasetInput["profiles"][number]>(async (from, to) => {
      const res = await service
        .from("profiles")
        .select("id,university_role,status,faculty,created_at,last_active_at")
        .order("id", { ascending: true })
        .range(from, to);
      if (!res.error) return res as PaginatedResult<AnalyticsDatasetInput["profiles"][number]>;
      const fallback = await service
        .from("profiles")
        .select("id,university_role,status,faculty,created_at")
        .order("id", { ascending: true })
        .range(from, to);
      return fallback as PaginatedResult<AnalyticsDatasetInput["profiles"][number]>;
    }),
    fetchAllPaginated<AnalyticsDatasetInput["listings"][number]>((from, to) =>
      service
        .from("listings")
        .select("id,seller_id,title,kind,category_id,is_food,has_variants,quantity,reserved_quantity,status,created_at")
        .order("id", { ascending: true })
        .range(from, to)
    ),
    fetchAllPaginated<AnalyticsDatasetInput["orders"][number]>((from, to) =>
      service
        .from("orders")
        .select(
          "id,buyer_id,seller_id,checkout_session_id,subtotal_sen,commission_sen,seller_net_sen,status,paid_at,completed_at,created_at"
        )
        .order("id", { ascending: true })
        .range(from, to)
    ),
    fetchAllPaginated<AnalyticsDatasetInput["orderItems"][number]>((from, to) =>
      service
        .from("order_items")
        .select("order_id,listing_id,title_snapshot,unit_sen,quantity")
        .order("id", { ascending: true })
        .range(from, to)
    ),
    fetchAllPaginated<AnalyticsDatasetInput["checkoutSessions"][number]>((from, to) =>
      service
        .from("checkout_sessions")
        .select("id,buyer_id,status,payment_status,paid_at")
        .order("id", { ascending: true })
        .range(from, to)
    ),
    fetchAllPaginated<AnalyticsDatasetInput["legacyPayments"][number]>((from, to) =>
      service
        .from("payments")
        .select("order_id,status,verified_at")
        .order("id", { ascending: true })
        .range(from, to)
    ),
    fetchAllPaginated<AnalyticsDatasetInput["refunds"][number]>((from, to) =>
      service
        .from("order_refunds")
        .select("order_id,refund_type,refund_amount_sen,commission_reversal_sen,seller_deduction_sen,status")
        .order("id", { ascending: true })
        .range(from, to)
    ),
    fetchAllPaginated<AnalyticsDatasetInput["views"][number]>((from, to) =>
      service
        .from("listing_views")
        .select("viewer_id,listing_id,viewed_at")
        .order("id", { ascending: true })
        .range(from, to)
    ),
    fetchAllPaginated<AnalyticsDatasetInput["favourites"][number]>((from, to) =>
      service
        .from("favourites")
        .select("user_id,listing_id,created_at")
        .order("created_at", { ascending: true })
        .range(from, to)
    ),
    fetchAllPaginated<AnalyticsDatasetInput["serviceRequests"][number]>(async (from, to) => {
      const res = await service
        .from("service_requests")
        .select("id,listing_id,buyer_id,seller_id,status,created_at,completed_at")
        .order("id", { ascending: true })
        .range(from, to);
      if (!res.error) return res as PaginatedResult<AnalyticsDatasetInput["serviceRequests"][number]>;
      const fallback = await service
        .from("service_requests")
        .select("id,listing_id,buyer_id,seller_id,status,created_at")
        .order("id", { ascending: true })
        .range(from, to);
      return fallback as PaginatedResult<AnalyticsDatasetInput["serviceRequests"][number]>;
    }),
    fetchAllPaginated<AnalyticsDatasetInput["freeNotices"][number]>((from, to) =>
      service
        .from("free_notices")
        .select("id,contributor_id,status,spot_id,created_at")
        .order("id", { ascending: true })
        .range(from, to)
    ),
    fetchAllPaginated<AnalyticsDatasetInput["freeClaims"][number]>((from, to) =>
      service
        .from("free_notice_claims")
        .select("notice_id,donor_id,recipient_id,quantity,status,collected_at,created_at")
        .order("id", { ascending: true })
        .range(from, to)
    ),
    fetchAllPaginated<AnalyticsDatasetInput["reviews"][number]>((from, to) =>
      service
        .from("reviews")
        .select("id,listing_id,seller_id,rating,hidden,created_at")
        .order("id", { ascending: true })
        .range(from, to)
    ),
    fetchAllPaginated<AnalyticsDatasetInput["reports"][number]>((from, to) =>
      service
        .from("reports")
        .select("id,reason,status,created_at,resolved_at")
        .order("id", { ascending: true })
        .range(from, to)
    ),
    fetchAllPaginated<AnalyticsDatasetInput["disputes"][number]>((from, to) =>
      service
        .from("order_disputes")
        .select("id,order_id,status,created_at,resolved_at")
        .order("id", { ascending: true })
        .range(from, to)
    ),
  ]);

  return {
    profiles,
    listings,
    orders,
    orderItems,
    checkoutSessions,
    legacyPayments,
    refunds,
    views,
    favourites,
    serviceRequests,
    freeNotices,
    freeClaims,
    reviews,
    reports,
    disputes,
  };
}
