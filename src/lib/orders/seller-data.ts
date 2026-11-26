import { readOrderPages, readOrderRelations } from "@/lib/orders/read";
import { isAuthoritativeOrderPaymentVerified } from "@/lib/financials/policy";
import { isBlockingRefundStatus } from "@/lib/orders/lifecycle";
import { getServerServiceClient } from "@/lib/supabase/service";
import { getLatestDisputesByOrderIds, type OrderDisputeSummaryView } from "@/lib/disputes/data";
import {
  loadOrderItemMediaContext,
  resolveOrderItemImageWithContext,
} from "@/lib/orders/item-context";
import {
  buildReviewMediaProxyUrl,
  type ReviewMediaAttachment,
} from "@/lib/reviews/presentation";
import { formatVariationOptionLabel } from "@/lib/seller/variations";
import {
  evaluateSellerEligibility,
  type SellerEligibilityResult,
} from "@/lib/seller/validation";
import { getPublicSupabaseEnv } from "@/lib/supabase/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { AuthSessionSummary } from "@/types/marketplace";

export interface SellerOrderItemView {
  id: string;
  listingId: string | null;
  title: string;
  variantLabel: string | null;
  unitSen: number;
  quantity: number;
  imageUrl: string | null;
  isService: boolean;
  serviceMode: string | null;
  pickupNote: string | null;
  pickupWindowStart: string | null;
  serviceRequirements: string | null;
  serviceAttachmentPaths: string[];
}

export interface SellerOrderView {
  id: string;
  orderCode: string;
  source: string;
  checkoutSessionId: string | null;
  buyerId: string;
  buyerName: string;
  status: string;
  subtotalSen: number;
  commissionSen: number;
  sellerNetSen: number;
  collectionAreaName: string;
  paymentDeadline: string | null;
  paidAt: string | null;
  handedOverAt: string | null;
  completedAt: string | null;
  protectionExpiresAt: string | null;
  createdAt: string;
  pinFailedAttempts: number;
  pinLockedUntil: string | null;
  hasActiveDispute: boolean;
  paymentVerified: boolean;
  paymentStatus: string | null;
  transactionRef: string | null;
  adjustedNetSen: number | null;
  allocatedSen: number | null;
  dispute: OrderDisputeSummaryView | null;
  refund: { id: string; status: string; amountSen: number; returnStatus: string; returnRequired: boolean } | null;
  reviews: Array<{
    id: string;
    rating: number;
    comment: string;
    sellerResponse: string | null;
    isAnonymous?: boolean;
    editedAt?: string | null;
    media?: ReviewMediaAttachment[];
  }>;
  items: SellerOrderItemView[];
  isServiceOrder: boolean;
}

export interface SellerOrdersPageData {
  eligibility: SellerEligibilityResult;
  orders: SellerOrderView[];
  error?: string;
  serverNow: number;
}

const ACTIVE_DISPUTE_STATUSES = new Set(["open", "under_review"]);

/**
 * Fetches seller-owned orders strictly WITHOUT `pickup_pin` or `raw_callback`.
 */
export async function getSellerOrdersData(
  session: AuthSessionSummary,
  orderId?: string
): Promise<SellerOrdersPageData> {
  const serverNow = Date.now();
  const eligibility = evaluateSellerEligibility(session);
  const sellerId = session.profile?.id;
  if (!eligibility.eligible || !sellerId) {
    return { serverNow, eligibility, orders: [] };
  }

  const env = getPublicSupabaseEnv();
  const supabase = await createSupabaseServerClient();
  if (!env || !supabase) {
    return {
      serverNow,
      eligibility,
      orders: [],
      error: "Supabase client is not configured.",
    };
  }

  let orderQuery = supabase
    .from("orders")
    .select(
      "id,order_code,source,checkout_session_id,buyer_id,status,subtotal_sen,commission_sen,seller_net_sen,collection_area_name,payment_deadline,paid_at,handed_over_at,completed_at,protection_expires_at,created_at,pin_failed_attempts,pin_locked_until"
    )
    .eq("seller_id", sellerId)
    .order("created_at", { ascending: false }).order("id", { ascending: false });
  if (orderId) orderQuery = orderQuery.eq("id", orderId);
  const { data: rawOrders, error: ordersErr } = await readOrderPages((start, end) => orderQuery.range(start, end));

  if (ordersErr) {
    return {
      serverNow,
      eligibility,
      orders: [],
      error: "Could not load your seller orders right now.",
    };
  }

  const rows = (rawOrders ?? []) as Array<{
    id: string;
    order_code: string;
    source: string;
    checkout_session_id: string | null;
    buyer_id: string;
    status: string;
    subtotal_sen: number;
    commission_sen: number;
    seller_net_sen: number;
    collection_area_name: string | null;
    payment_deadline: string | null;
    paid_at: string | null;
    handed_over_at: string | null;
    completed_at: string | null;
    protection_expires_at: string | null;
    created_at: string;
    pin_failed_attempts: number | null;
    pin_locked_until: string | null;
  }>;

  if (rows.length === 0) {
    return { serverNow, eligibility, orders: [] };
  }

  const orderIds = rows.map((r) => r.id);
  const service = getServerServiceClient();
  const checkoutIds = [...new Set(rows.flatMap((row) => row.checkout_session_id ?? []))];
  const legacyIds = rows.filter((row) => !row.checkout_session_id).map((row) => row.id);
  const buyerIds = Array.from(new Set(rows.map((r) => r.buyer_id)));

  const [itemsRes, buyersRes, disputesRes, refundsRes, disputeDetails, reviewsRes, checkoutsRes, paymentsRes, adjustmentsRes, allocationsRes] = await Promise.all([
    readOrderRelations(orderIds, async (batch, start, end) => {
      const res = await supabase.from("order_items")
        .select("id,order_id,listing_id,variant_id,title_snapshot,variant_snapshot,unit_sen,quantity,image_path,is_service,service_mode,service_requirements,service_attachment_paths,pickup_note,pickup_window_start")
        .in("order_id", batch).order("id").range(start, end);
      if (!res.error) return res;
      return supabase.from("order_items")
        .select("id,order_id,listing_id,title_snapshot,variant_snapshot,unit_sen,quantity,image_path,is_service,service_mode,service_requirements,service_attachment_paths,pickup_note,pickup_window_start")
        .in("order_id", batch).order("id").range(start, end);
    }),
    readOrderRelations(buyerIds, (batch, start, end) => supabase.from("public_profiles")
      .select("id,display_name").in("id", batch).order("id").range(start, end)),
    readOrderRelations(orderIds, (batch, start, end) => supabase.from("order_disputes")
      .select("order_id,status,refund_execution_status").in("order_id", batch).order("id").range(start, end)),
    readOrderRelations(orderIds, (batch, start, end) => supabase.from("order_refunds")
      .select("id,order_id,status,refund_amount_sen,return_status,return_required").in("order_id", batch)
      .order("created_at", { ascending: false }).order("id").range(start, end)),
    orderId ? getLatestDisputesByOrderIds([orderId]) : Promise.resolve(null),
    orderId ? Promise.resolve().then(async () => {
      const rev10r = await supabase.from("reviews")
        .select("id,rating,comment,seller_response,is_anonymous,image_paths,video_path,edited_at")
        .eq("order_id", orderId).eq("hidden", false);
      if (!rev10r.error) return rev10r;
      return supabase.from("reviews").select("id,rating,comment,seller_response").eq("order_id", orderId).eq("hidden", false);
    }) : Promise.resolve({ data: [] }),
    service ? readOrderRelations(checkoutIds, (batch, start, end) => service.from("checkout_sessions")
      .select("id,buyer_id,status,payment_status,paid_at").in("id", batch).order("id").range(start, end))
      : Promise.resolve({ data: [] }),
    service ? readOrderRelations(legacyIds, (batch, start, end) => service.from("payments")
      .select("order_id,status,verified_at,transaction_ref").in("order_id", batch)
      .order("created_at", { ascending: false }).order("id").range(start, end))
      : Promise.resolve({ data: [] }),
    service && orderId
      ? service.from("financial_adjustments").select("amount_sen").eq("order_id", orderId).eq("kind", "seller_earnings_deduction")
      : Promise.resolve({ data: null }),
    service && orderId
      ? service.from("payout_allocations").select("allocated_sen").eq("order_id", orderId).in("status", ["reserved", "paid"])
      : Promise.resolve({ data: null }),
  ]);

  if (itemsRes.error || disputesRes.error || refundsRes.error) {
    return { serverNow, eligibility, orders: [], error: "Could not load your order items or financial status right now." };
  }

  const rawSellerItems = (itemsRes.data ?? []) as Array<{
    id: string;
    order_id: string;
    listing_id: string | null;
    variant_id?: string | null;
    title_snapshot: string;
    variant_snapshot?: Record<string, string> | null;
    unit_sen: number;
    quantity: number;
    image_path: string | null;
    is_service?: boolean | null;
    service_mode?: string | null;
    pickup_note?: string | null;
    pickup_window_start?: string | null;
    service_requirements?: string | null;
    service_attachment_paths?: string[] | null;
  }>;

  const mediaContext = await loadOrderItemMediaContext(service ?? supabase, rawSellerItems);

  const itemsByOrder = new Map<string, SellerOrderItemView[]>();
  for (const row of rawSellerItems) {
    const list = itemsByOrder.get(row.order_id) ?? [];
    const variantLabel =
      row.variant_snapshot &&
      typeof row.variant_snapshot === "object" &&
      Object.keys(row.variant_snapshot).length > 0
        ? formatVariationOptionLabel(row.variant_snapshot)
        : null;
    list.push({
      id: row.id,
      listingId: row.listing_id,
      title: row.title_snapshot,
      variantLabel,
      unitSen: Number(row.unit_sen ?? 0),
      quantity: Number(row.quantity ?? 1),
      imageUrl: resolveOrderItemImageWithContext(row, mediaContext, env.url),
      isService: Boolean(row.is_service),
      serviceMode: row.service_mode ?? null,
      pickupNote: row.pickup_note ?? null,
      pickupWindowStart: row.pickup_window_start ?? null,
      serviceRequirements: row.service_requirements ?? null,
      serviceAttachmentPaths: Array.isArray(row.service_attachment_paths)
        ? row.service_attachment_paths
        : [],
    });
    itemsByOrder.set(row.order_id, list);
  }

  const buyerNameMap = new Map<string, string>();
  for (const p of (buyersRes.data ?? []) as Array<{
    id: string;
    display_name: string | null;
  }>) {
    if (p.display_name?.trim()) buyerNameMap.set(p.id, p.display_name.trim());
  }

  const activeDisputeOrders = new Set<string>();
  for (const d of (disputesRes.data ?? []) as Array<{
    order_id: string;
    status: string | null;
    refund_execution_status?: string | null;
  }>) {
    const ds = (d.status ?? "").toLowerCase();
    const exec = (d.refund_execution_status ?? "").toLowerCase();
    if (ACTIVE_DISPUTE_STATUSES.has(ds) || exec === "pending_execution" || exec === "failed") {
      activeDisputeOrders.add(d.order_id);
    }
  }

  const orders: SellerOrderView[] = rows.map((o) => {
    const items = itemsByOrder.get(o.id) ?? [];
    const refund = refundsRes.data?.find((row) => row.order_id === o.id);
    const refundBlocked = refundsRes.data?.some((row) => row.order_id === o.id && isBlockingRefundStatus(row.status));
    const checkout = checkoutsRes.data?.find((row) => row.id === o.checkout_session_id && row.buyer_id === o.buyer_id);
    const payments = paymentsRes.data?.filter((row) => row.order_id === o.id) ?? [];
    const paidPayment = payments.find((row) => row.status === "paid" && row.verified_at);
    const latestPayment = paidPayment ?? payments.find((row) => row.status === "late_payment_review") ?? payments[0];
    return {
      id: o.id,
      orderCode: o.order_code,
      source: o.source,
      checkoutSessionId: o.checkout_session_id,
      buyerId: o.buyer_id,
      buyerName: buyerNameMap.get(o.buyer_id) ?? "UMSKAL Member",
      status: o.status,
      subtotalSen: Number(o.subtotal_sen ?? 0),
      commissionSen: Number(o.commission_sen ?? 0),
      sellerNetSen: Number(o.seller_net_sen ?? 0),
      collectionAreaName: o.collection_area_name || "Campus Collection Point",
      paymentDeadline: o.payment_deadline,
      paidAt: o.paid_at,
      handedOverAt: o.handed_over_at,
      completedAt: o.completed_at,
      protectionExpiresAt: o.protection_expires_at,
      createdAt: o.created_at,
      pinFailedAttempts: Number(o.pin_failed_attempts ?? 0),
      pinLockedUntil: o.pin_locked_until,
      hasActiveDispute:
        o.status.toLowerCase() === "disputed" || activeDisputeOrders.has(o.id) || Boolean(refundBlocked),
      paymentVerified: isAuthoritativeOrderPaymentVerified({ order: o, checkoutSession: checkout, legacyPayment: paidPayment }),
      paymentStatus: checkout?.payment_status ?? latestPayment?.status ?? null,
      transactionRef: o.checkout_session_id ? null : latestPayment?.transaction_ref ?? null,
      adjustedNetSen: adjustmentsRes.data ? Math.max(0, o.seller_net_sen - adjustmentsRes.data.reduce((sum, row) => sum + row.amount_sen, 0)) : null,
      allocatedSen: allocationsRes.data?.reduce((sum, row) => sum + row.allocated_sen, 0) ?? null,
      dispute: disputeDetails?.get(o.id) ?? null,
      refund: refund ? { id: refund.id, status: refund.status, amountSen: refund.refund_amount_sen,
        returnStatus: refund.return_status, returnRequired: refund.return_required } : null,
      reviews: (reviewsRes.data ?? []).map((row) => {
        const typed = row as {
          id: string;
          rating: number;
          comment: string;
          seller_response: string | null;
          is_anonymous?: boolean | null;
          image_paths?: string[] | null;
          video_path?: string | null;
          edited_at?: string | null;
        };
        const imgs = Array.isArray(typed.image_paths) ? typed.image_paths.filter(Boolean) : [];
        const hasVid = Boolean(typed.video_path && typed.video_path.trim());
        return {
          id: typed.id,
          rating: typed.rating,
          comment: typed.comment,
          sellerResponse: typed.seller_response,
          isAnonymous: Boolean(typed.is_anonymous),
          editedAt: typed.edited_at ?? null,
          media: [
            ...imgs.map((_, index) => ({
              kind: "image" as const,
              url: buildReviewMediaProxyUrl({ reviewId: typed.id, kind: "image", index }),
            })),
            ...(hasVid
              ? [{ kind: "video" as const, url: buildReviewMediaProxyUrl({ reviewId: typed.id, kind: "video" }) }]
              : []),
          ],
        };
      }),
      items,
      isServiceOrder: items.some((it) => it.isService),
    };
  });

  return { serverNow: Date.now(), eligibility, orders };
}
