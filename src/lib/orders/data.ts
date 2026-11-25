import { readOrderPages, readOrderRelations } from "@/lib/orders/read";
import { evaluateBuyerEligibility, type BuyerEligibilityResult } from "@/lib/buyer/validation";
import {
  getLatestDisputesByOrderIds,
  type OrderDisputeSummaryView,
} from "@/lib/disputes/data";
import { resolvePublicStorageUrl } from "@/lib/format";
import { formatVariationOptionLabel } from "@/lib/seller/variations";
import { getPublicSupabaseEnv } from "@/lib/supabase/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getServerServiceClient } from "@/lib/supabase/service";
import type { AuthSessionSummary } from "@/types/marketplace";

export interface BuyerOrderItemView {
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

export interface BuyerOrderPaymentView {
  billCode: string;
  billUrl: string | null;
  status: string;
  transactionRef: string | null;
  verifiedAt: string | null;
}

export interface BuyerOrderRefundView {
  id: string;
  refundCode: string;
  refundType: string;
  refundAmountSen: number;
  status: string;
  refundRef: string | null;
  returnRequired: boolean;
  returnStatus: string;
  returnInstructions: string | null;
  completedAt: string | null;
}

export interface BuyerOrderReviewView {
  id: string;
  orderId: string;
  listingId: string | null;
  rating: number;
  comment: string;
  sellerResponse: string | null;
  hidden: boolean;
  createdAt: string;
}

export interface BuyerOrderView {
  id: string;
  orderCode: string;
  source: string;
  checkoutSessionId: string | null;
  sellerId: string;
  sellerName: string;
  status: string;
  subtotalSen: number;
  fpxFeeSen: number;
  totalPaidSen: number;
  collectionAreaName: string;
  paymentDeadline: string | null;
  paidAt: string | null;
  handedOverAt: string | null;
  completedAt: string | null;
  createdAt: string;
  protectionExpiresAt: string | null;
  paymentVerified: boolean;
  checkout: Omit<BuyerPendingCheckoutView, "orders"> | null;
  latestPayment: BuyerOrderPaymentView | null;
  dispute: OrderDisputeSummaryView | null;
  refund: BuyerOrderRefundView | null;
  reviews: BuyerOrderReviewView[];
  items: BuyerOrderItemView[];
  isServiceOrder: boolean;
}

export interface BuyerPendingCheckoutView {
  id: string;
  checkoutCode: string;
  source: string;
  status: string;
  paymentStatus: string;
  transactionRef: string | null;
  paidAt: string | null;
  combinedSubtotalSen: number;
  fpxFeeSen: number;
  totalPaidSen: number;
  paymentDeadline: string;
  billCode: string | null;
  billUrl: string | null;
  createdAt: string;
  orders: BuyerOrderView[];
}

export interface BuyerOrdersPageData {
  eligibility: BuyerEligibilityResult;
  pendingCheckouts: BuyerPendingCheckoutView[];
  orders: BuyerOrderView[];
  error?: string;
  serverNow: number;
}

export async function getBuyerOrdersData(
  session: AuthSessionSummary,
  target?: { orderId: string } | { checkoutId: string }
): Promise<BuyerOrdersPageData> {
  const serverNow = Date.now();
  const eligibility = evaluateBuyerEligibility(session);
  if (!eligibility.eligible || !eligibility.userId) {
    return { serverNow, eligibility, pendingCheckouts: [], orders: [] };
  }

  const env = getPublicSupabaseEnv();
  const supabase = await createSupabaseServerClient();
  if (!env || !supabase) {
    return {
      serverNow,
      eligibility,
      pendingCheckouts: [],
      orders: [],
      error: "Supabase client is not configured.",
    };
  }

  let query = supabase
    .from("orders")
    .select(
      "id,order_code,source,checkout_session_id,seller_id,status,subtotal_sen,fpx_fee_sen,total_paid_sen,collection_area_name,payment_deadline,paid_at,handed_over_at,completed_at,protection_expires_at,created_at"
    )
    .eq("buyer_id", eligibility.userId)
    .order("created_at", { ascending: false }).order("id", { ascending: false });
  if (target) query = "orderId" in target ? query.eq("id", target.orderId) : query.eq("checkout_session_id", target.checkoutId);
  const { data: rawOrders, error: ordersErr } = await readOrderPages((start, end) => query.range(start, end));

  if (ordersErr) {
    return {
      serverNow,
      eligibility,
      pendingCheckouts: [],
      orders: [],
      error: "Could not load your orders right now.",
    };
  }

  const orderRows = (rawOrders ?? []) as Array<{
    id: string;
    order_code: string;
    source: string;
    checkout_session_id: string | null;
    seller_id: string;
    status: string;
    subtotal_sen: number;
    fpx_fee_sen: number;
    total_paid_sen: number;
    collection_area_name: string | null;
    payment_deadline: string | null;
    paid_at: string | null;
    handed_over_at: string | null;
    completed_at: string | null;
    protection_expires_at: string | null;
    created_at: string;
  }>;

  if (orderRows.length === 0) {
    return { serverNow, eligibility, pendingCheckouts: [], orders: [] };
  }

  const orderIds = orderRows.map((o) => o.id);
  const checkoutSessionIds = Array.from(
    new Set(
      orderRows
        .map((o) => o.checkout_session_id)
        .filter((id): id is string => Boolean(id))
    )
  );
  const sellerIds = Array.from(new Set(orderRows.map((o) => o.seller_id)));
  const service = getServerServiceClient();

  const [itemsRes, profilesRes, storefrontsRes, paymentsRes, sessionsRes, disputesByOrder, refundsRes, reviewsRes] =
    await Promise.all([
      readOrderRelations(orderIds, (batch, start, end) => supabase.from("order_items")
        .select("id,order_id,listing_id,title_snapshot,variant_snapshot,unit_sen,quantity,image_path,is_service,service_mode,service_requirements,service_attachment_paths,pickup_note,pickup_window_start")
        .in("order_id", batch).order("id").range(start, end)),
      readOrderRelations(sellerIds, (batch, start, end) => supabase.from("public_profiles")
        .select("id,display_name").in("id", batch).order("id").range(start, end)),
      readOrderRelations(sellerIds, (batch, start, end) => supabase.from("storefronts")
        .select("seller_id,shop_name").in("seller_id", batch).order("seller_id").range(start, end)),
      service
        ? readOrderRelations(orderRows.filter((row) => !row.checkout_session_id).map((row) => row.id),
            (batch, start, end) => service.from("payments")
              .select("order_id,bill_code,bill_url,status,transaction_ref,verified_at,created_at")
              .in("order_id", batch).order("created_at", { ascending: false }).order("id").range(start, end))
        : Promise.resolve({ data: [] }),
      readOrderRelations(checkoutSessionIds, (batch, start, end) => supabase.from("checkout_sessions")
        .select("id,checkout_code,source,status,payment_status,combined_subtotal_sen,fpx_fee_sen,total_paid_sen,payment_deadline,bill_code,bill_url,transaction_ref,paid_at,created_at")
        .in("id", batch).eq("buyer_id", eligibility.userId).order("id").range(start, end)),
      getLatestDisputesByOrderIds(orderIds),
      readOrderRelations(orderIds, (batch, start, end) => supabase.from("order_refunds")
        .select("id,order_id,refund_code,refund_type,refund_amount_sen,status,refund_ref,return_required,return_status,return_instructions,completed_at")
        .in("order_id", batch).order("created_at", { ascending: false }).order("id").range(start, end)),
      readOrderRelations(orderIds, async (batch, start, end) => {
        const reviews = await supabase.from("reviews")
          .select("id,order_id,listing_id,rating,comment,seller_response,hidden,created_at")
          .eq("buyer_id", eligibility.userId).in("order_id", batch).order("created_at", { ascending: false }).order("id").range(start, end);
        if (!reviews.error) return reviews;
        const fallback = await supabase.from("reviews")
          .select("id,order_id,listing_id,rating,comment,hidden,created_at")
          .eq("buyer_id", eligibility.userId).in("order_id", batch).order("created_at", { ascending: false }).order("id").range(start, end);
        return { ...fallback, data: fallback.data?.map((review) => ({ ...review, seller_response: null })) ?? null };
      }),
    ]);

  if (itemsRes.error || sessionsRes.error) {
    return { serverNow, eligibility, pendingCheckouts: [], orders: [], error: "Could not load your order items or payments right now." };
  }

  const reviewsByOrder = new Map<string, BuyerOrderReviewView[]>();
  if (!reviewsRes.error && reviewsRes.data) {
    for (const rv of reviewsRes.data as Array<{
      id: string;
      order_id: string | null;
      listing_id: string | null;
      rating: number;
      comment: string;
      seller_response?: string | null;
      hidden?: boolean | null;
      created_at: string;
    }>) {
      if (!rv.order_id) continue;
      const arr = reviewsByOrder.get(rv.order_id) ?? [];
      arr.push({
        id: rv.id,
        orderId: rv.order_id,
        listingId: rv.listing_id,
        rating: Number(rv.rating ?? 5),
        comment: rv.comment,
        sellerResponse: rv.seller_response ?? null,
        hidden: Boolean(rv.hidden),
        createdAt: rv.created_at,
      });
      reviewsByOrder.set(rv.order_id, arr);
    }
  }

  const refundByOrder = new Map<string, BuyerOrderRefundView>();
  if (!refundsRes.error && refundsRes.data) {
    for (const r of refundsRes.data as Array<{
      id: string;
      order_id: string;
      refund_code: string;
      refund_type: string;
      refund_amount_sen: number;
      status: string;
      refund_ref: string | null;
      return_required: boolean;
      return_status: string;
      return_instructions: string | null;
      completed_at: string | null;
    }>) {
      if (!refundByOrder.has(r.order_id)) {
        refundByOrder.set(r.order_id, {
          id: r.id,
          refundCode: r.refund_code,
          refundType: r.refund_type,
          refundAmountSen: r.refund_amount_sen,
          status: r.status,
          refundRef: r.refund_ref,
          returnRequired: r.return_required,
          returnStatus: r.return_status,
          returnInstructions: r.return_instructions,
          completedAt: r.completed_at,
        });
      }
    }
  }

  const latestPaymentByOrder = new Map<string, BuyerOrderPaymentView>();
  const verifiedLegacyOrders = new Set<string>();
  for (const p of (paymentsRes.data ?? []) as Array<{
    order_id: string;
    bill_code: string;
    bill_url: string | null;
    status: string;
    transaction_ref: string | null;
    verified_at: string | null;
  }>) {
    const verified = p.status === "paid" && Boolean(p.verified_at);
    if (verified) verifiedLegacyOrders.add(p.order_id);
    const current = latestPaymentByOrder.get(p.order_id);
    if (p.bill_code && !p.bill_code.startsWith("creating:") &&
        (!current || (current.status !== "paid" && (verified ||
          (p.status === "late_payment_review" && current.status !== "late_payment_review"))))) {
      latestPaymentByOrder.set(p.order_id, {
        billCode: p.bill_code,
        billUrl: p.bill_url,
        status: p.status,
        transactionRef: p.transaction_ref,
        verifiedAt: p.verified_at,
      });
    }
  }

  const itemsByOrder = new Map<string, BuyerOrderItemView[]>();
  for (const row of (itemsRes.data ?? []) as Array<{
    id: string;
    order_id: string;
    listing_id: string | null;
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
  }>) {
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
      imageUrl: resolvePublicStorageUrl("listings", row.image_path, env.url),
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

  const sellerNameMap = new Map<string, string>();
  for (const p of (profilesRes.data ?? []) as Array<{
    id: string;
    display_name: string | null;
  }>) {
    if (p.display_name?.trim()) sellerNameMap.set(p.id, p.display_name.trim());
  }
  for (const s of (storefrontsRes.data ?? []) as Array<{
    seller_id: string;
    shop_name: string | null;
  }>) {
    if (s.shop_name?.trim()) sellerNameMap.set(s.seller_id, s.shop_name.trim());
  }

  const checkouts = new Map<string, Omit<BuyerPendingCheckoutView, "orders">>();
  for (const s of (sessionsRes.data ?? []) as Array<{
    id: string;
    checkout_code: string;
    source: string;
    status: string;
    payment_status: string;
    combined_subtotal_sen: number;
    fpx_fee_sen: number;
    total_paid_sen: number;
    payment_deadline: string;
    bill_code: string | null;
    bill_url: string | null;
    created_at: string;
    transaction_ref: string | null;
    paid_at: string | null;
  }>) {
    checkouts.set(s.id, {
      id: s.id,
      checkoutCode: s.checkout_code,
      source: s.source,
      status: s.status,
      paymentStatus: s.payment_status,
      transactionRef: s.transaction_ref,
      paidAt: s.paid_at,
      combinedSubtotalSen: Number(s.combined_subtotal_sen),
      fpxFeeSen: Number(s.fpx_fee_sen),
      totalPaidSen: Number(s.total_paid_sen),
      paymentDeadline: s.payment_deadline,
      billCode: s.bill_code && !s.bill_code.startsWith("creating:") ? s.bill_code : null,
      billUrl: s.bill_url,
      createdAt: s.created_at,
    });
  }

  const allOrders: BuyerOrderView[] = orderRows.map((o) => {
    const items = itemsByOrder.get(o.id) ?? [];
    const checkout = o.checkout_session_id ? checkouts.get(o.checkout_session_id) ?? null : null;
    const latestPayment = latestPaymentByOrder.get(o.id) ?? null;
    return {
      id: o.id,
      orderCode: o.order_code,
      source: o.source,
      checkoutSessionId: o.checkout_session_id,
      sellerId: o.seller_id,
      sellerName: sellerNameMap.get(o.seller_id) ?? "UMSKAL Seller",
      status: o.status,
      subtotalSen: Number(o.subtotal_sen ?? 0),
      fpxFeeSen: Number(o.fpx_fee_sen ?? 0),
      totalPaidSen: Number(o.total_paid_sen ?? 0),
      collectionAreaName: o.collection_area_name?.trim() || "UMSKAL Campus",
      paymentDeadline: o.payment_deadline,
      paidAt: o.paid_at,
      handedOverAt: o.handed_over_at,
      completedAt: o.completed_at,
      createdAt: o.created_at,
      protectionExpiresAt: o.protection_expires_at,
      checkout,
      paymentVerified: Boolean(o.paid_at && (o.checkout_session_id
        ? checkout?.status === "paid" && checkout.paymentStatus === "paid" && checkout.paidAt
        : verifiedLegacyOrders.has(o.id))),
      latestPayment,
      dispute: disputesByOrder.get(o.id) ?? null,
      refund: refundByOrder.get(o.id) ?? null,
      reviews: reviewsByOrder.get(o.id) ?? [],
      items,
      isServiceOrder: items.some((it) => it.isService),
    };
  });

  if (target && "orderId" in target) {
    return { serverNow: Date.now(), eligibility, pendingCheckouts: [], orders: allOrders };
  }

  const pendingCheckouts: BuyerPendingCheckoutView[] = [];
  const groupedCheckoutIds = new Set<string>();
  for (const checkout of checkouts.values()) {
    if (checkout.status === "paid" && checkout.paymentStatus !== "late_payment_review") continue;
    const children = allOrders.filter((order) => order.checkoutSessionId === checkout.id);
    if (children.length === 0) continue;
    groupedCheckoutIds.add(checkout.id);
    pendingCheckouts.push({ ...checkout, orders: children });
  }
  const orders = allOrders.filter((order) =>
    !order.checkoutSessionId || !groupedCheckoutIds.has(order.checkoutSessionId)
  );
  return { serverNow: Date.now(), eligibility, pendingCheckouts, orders };
}
