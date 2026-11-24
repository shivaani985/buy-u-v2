import type { AnalyticsDatasetInput } from "@/lib/analytics/metrics";
import { getServerServiceClient } from "@/lib/supabase/service";

/**
 * Loads genuine database records for Seller or Admin analytics (server-only).
 * Gracefully tolerates pre-migration absent columns/tables so local builds & views never crash.
 */
export async function loadAnalyticsDataset(): Promise<AnalyticsDatasetInput | null> {
  const service = getServerServiceClient();
  if (!service) return null;

  const [
    profRes,
    listRes,
    ordRes,
    oiRes,
    csRes,
    payRes,
    rfdRes,
    viewRes,
    favRes,
    srRes,
    fnRes,
    fcRes,
    revRes,
    rptRes,
    dspRes,
  ] = await Promise.all([
    service.from("profiles").select("id,university_role,status,faculty,created_at").limit(1000),
    service
      .from("listings")
      .select("id,seller_id,title,kind,category_id,is_food,has_variants,quantity,reserved_quantity,status,created_at")
      .limit(1000),
    service
      .from("orders")
      .select("id,buyer_id,seller_id,checkout_session_id,subtotal_sen,commission_sen,seller_net_sen,status,paid_at,completed_at,created_at")
      .limit(1000),
    service.from("order_items").select("order_id,listing_id,title_snapshot,unit_sen,quantity").limit(2000),
    service.from("checkout_sessions").select("id,buyer_id,status,payment_status,paid_at").limit(500),
    service.from("payments").select("order_id,status,verified_at").limit(500),
    service
      .from("order_refunds")
      .select("order_id,refund_type,refund_amount_sen,commission_reversal_sen,seller_deduction_sen,status")
      .limit(500),
    service.from("listing_views").select("viewer_id,listing_id,viewed_at").limit(5000),
    service.from("favourites").select("user_id,listing_id,created_at").limit(2000),
    service.from("service_requests").select("id,listing_id,buyer_id,seller_id,status,created_at").limit(500),
    service.from("free_notices").select("id,contributor_id,status,spot_id,created_at").limit(500),
    service.from("free_notice_claims").select("notice_id,donor_id,recipient_id,quantity,status,collected_at,created_at").limit(500),
    service.from("reviews").select("id,listing_id,seller_id,rating,hidden,created_at").limit(500),
    service.from("reports").select("id,reason,status,created_at,resolved_at").limit(500),
    service.from("order_disputes").select("id,order_id,status,created_at,resolved_at").limit(500),
  ]);

  return {
    profiles: (profRes.data ?? []) as AnalyticsDatasetInput["profiles"],
    listings: (listRes.data ?? []) as AnalyticsDatasetInput["listings"],
    orders: (ordRes.data ?? []) as AnalyticsDatasetInput["orders"],
    orderItems: (oiRes.data ?? []) as AnalyticsDatasetInput["orderItems"],
    checkoutSessions: (csRes.data ?? []) as AnalyticsDatasetInput["checkoutSessions"],
    legacyPayments: (payRes.data ?? []) as AnalyticsDatasetInput["legacyPayments"],
    refunds: (rfdRes.error ? [] : (rfdRes.data ?? [])) as AnalyticsDatasetInput["refunds"],
    views: (viewRes.error ? [] : (viewRes.data ?? [])) as AnalyticsDatasetInput["views"],
    favourites: (favRes.error ? [] : (favRes.data ?? [])) as AnalyticsDatasetInput["favourites"],
    serviceRequests: (srRes.error ? [] : (srRes.data ?? [])) as AnalyticsDatasetInput["serviceRequests"],
    freeNotices: (fnRes.error ? [] : (fnRes.data ?? [])) as AnalyticsDatasetInput["freeNotices"],
    freeClaims: (fcRes.error ? [] : (fcRes.data ?? [])) as AnalyticsDatasetInput["freeClaims"],
    reviews: (revRes.error ? [] : (revRes.data ?? [])) as AnalyticsDatasetInput["reviews"],
    reports: (rptRes.error ? [] : (rptRes.data ?? [])) as AnalyticsDatasetInput["reports"],
    disputes: (dspRes.error ? [] : (dspRes.data ?? [])) as AnalyticsDatasetInput["disputes"],
  };
}
