import { evaluateBuyerEligibility, type BuyerEligibilityResult } from "@/lib/buyer/validation";
import { resolvePublicStorageUrl } from "@/lib/format";
import { getPublicSupabaseEnv } from "@/lib/supabase/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getServerServiceClient } from "@/lib/supabase/service";
import type { AuthSessionSummary } from "@/types/marketplace";

export interface BuyerOrderItemView {
  id: string;
  listingId: string | null;
  title: string;
  unitSen: number;
  quantity: number;
  imageUrl: string | null;
}

export interface BuyerOrderPaymentView {
  billCode: string;
  billUrl: string | null;
  status: string;
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
  /** Strictly buyer-only pickup PIN (never queried or exposed on seller routes). */
  pickupPin: string | null;
  latestPayment: BuyerOrderPaymentView | null;
  items: BuyerOrderItemView[];
}

export interface BuyerPendingCheckoutView {
  id: string;
  checkoutCode: string;
  source: string;
  status: string;
  paymentStatus: string;
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
}

export async function getBuyerOrdersData(
  session: AuthSessionSummary
): Promise<BuyerOrdersPageData> {
  const eligibility = evaluateBuyerEligibility(session);
  if (!eligibility.eligible || !eligibility.userId) {
    return { eligibility, pendingCheckouts: [], orders: [] };
  }

  const env = getPublicSupabaseEnv();
  const supabase = await createSupabaseServerClient();
  if (!env || !supabase) {
    return {
      eligibility,
      pendingCheckouts: [],
      orders: [],
      error: "Supabase client is not configured.",
    };
  }

  const { data: rawOrders, error: ordersErr } = await supabase
    .from("orders")
    .select(
      "id,order_code,source,checkout_session_id,seller_id,status,subtotal_sen,fpx_fee_sen,total_paid_sen,collection_area_name,payment_deadline,paid_at,handed_over_at,completed_at,created_at"
    )
    .eq("buyer_id", eligibility.userId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (ordersErr) {
    return {
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
    created_at: string;
  }>;

  if (orderRows.length === 0) {
    return { eligibility, pendingCheckouts: [], orders: [] };
  }

  const orderIds = orderRows.map((o) => o.id);
  const checkoutSessionIds = Array.from(
    new Set(
      orderRows
        .map((o) => o.checkout_session_id)
        .filter((id): id is string => Boolean(id))
    )
  );
  const paidOrderIds = orderRows
    .filter((o) => o.status === "paid")
    .map((o) => o.id);
  const sellerIds = Array.from(new Set(orderRows.map((o) => o.seller_id)));
  const service = getServerServiceClient();

  const [itemsRes, profilesRes, storefrontsRes, paymentsRes, pinsRes, sessionsRes] =
    await Promise.all([
      supabase
        .from("order_items")
        .select("id,order_id,listing_id,title_snapshot,unit_sen,quantity,image_path")
        .in("order_id", orderIds),
      supabase
        .from("public_profiles")
        .select("id,display_name")
        .in("id", sellerIds),
      supabase
        .from("storefronts")
        .select("seller_id,shop_name")
        .in("seller_id", sellerIds),
      service
        ? service
            .from("payments")
            .select("order_id,bill_code,bill_url,status,created_at")
            .in("order_id", orderIds)
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [] }),
      paidOrderIds.length > 0
        ? supabase.rpc("get_buyer_order_pickup_pins", {
            p_order_ids: paidOrderIds,
          })
        : Promise.resolve({ data: [] }),
      checkoutSessionIds.length > 0
        ? supabase
            .from("checkout_sessions")
            .select(
              "id,checkout_code,source,status,payment_status,combined_subtotal_sen,fpx_fee_sen,total_paid_sen,payment_deadline,bill_code,bill_url,created_at"
            )
            .in("id", checkoutSessionIds)
            .eq("buyer_id", eligibility.userId)
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [] }),
    ]);

  const pinByOrder = new Map<string, string>();
  for (const row of (pinsRes.data ?? []) as Array<{
    order_id: string;
    pickup_pin: string | null;
  }>) {
    if (row.pickup_pin) pinByOrder.set(row.order_id, row.pickup_pin);
  }

  const latestPaymentByOrder = new Map<string, BuyerOrderPaymentView>();
  for (const p of (paymentsRes.data ?? []) as Array<{
    order_id: string;
    bill_code: string;
    bill_url: string | null;
    status: string;
  }>) {
    if (
      !latestPaymentByOrder.has(p.order_id) &&
      p.bill_code &&
      !p.bill_code.startsWith("creating:")
    ) {
      latestPaymentByOrder.set(p.order_id, {
        billCode: p.bill_code,
        billUrl: p.bill_url,
        status: p.status,
      });
    }
  }

  const itemsByOrder = new Map<string, BuyerOrderItemView[]>();
  for (const row of (itemsRes.data ?? []) as Array<{
    id: string;
    order_id: string;
    listing_id: string | null;
    title_snapshot: string;
    unit_sen: number;
    quantity: number;
    image_path: string | null;
  }>) {
    const list = itemsByOrder.get(row.order_id) ?? [];
    list.push({
      id: row.id,
      listingId: row.listing_id,
      title: row.title_snapshot,
      unitSen: Number(row.unit_sen ?? 0),
      quantity: Number(row.quantity ?? 1),
      imageUrl: resolvePublicStorageUrl("listings", row.image_path, env.url),
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

  const allOrders: BuyerOrderView[] = orderRows.map((o) => ({
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
    pickupPin: pinByOrder.get(o.id) ?? null,
    latestPayment: latestPaymentByOrder.get(o.id) ?? null,
    items: itemsByOrder.get(o.id) ?? [],
  }));

  const pendingCheckouts: BuyerPendingCheckoutView[] = [];
  const groupedPendingSessionIds = new Set<string>();

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
  }>) {
    if (
      s.status === "pending_payment" ||
      s.payment_status === "late_payment_review"
    ) {
      const childOrders = allOrders.filter((o) => o.checkoutSessionId === s.id);
      if (childOrders.length > 0) {
        groupedPendingSessionIds.add(s.id);
        pendingCheckouts.push({
          id: s.id,
          checkoutCode: s.checkout_code,
          source: s.source,
          status: s.status,
          paymentStatus: s.payment_status,
          combinedSubtotalSen: Number(s.combined_subtotal_sen ?? 0),
          fpxFeeSen: Number(s.fpx_fee_sen ?? 100),
          totalPaidSen: Number(s.total_paid_sen ?? 0),
          paymentDeadline: s.payment_deadline,
          billCode:
            s.bill_code && !s.bill_code.startsWith("creating:")
              ? s.bill_code
              : null,
          billUrl: s.bill_url,
          createdAt: s.created_at,
          orders: childOrders,
        });
      }
    }
  }

  // Show individual seller orders for paid/completed/expired checkouts and legacy standalone orders
  const orders = allOrders.filter(
    (o) => !o.checkoutSessionId || !groupedPendingSessionIds.has(o.checkoutSessionId)
  );

  return { eligibility, pendingCheckouts, orders };
}
