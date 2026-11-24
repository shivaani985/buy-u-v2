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
  sellerId: string;
  sellerName: string;
  status: string;
  subtotalSen: number;
  fpxFeeSen: number;
  totalPaidSen: number;
  collectionAreaName: string;
  paymentDeadline: string | null;
  paidAt: string | null;
  completedAt: string | null;
  createdAt: string;
  /** Strictly buyer-only pickup PIN (never queried or exposed on seller routes). */
  pickupPin: string | null;
  latestPayment: BuyerOrderPaymentView | null;
  items: BuyerOrderItemView[];
}

export interface BuyerOrdersPageData {
  eligibility: BuyerEligibilityResult;
  orders: BuyerOrderView[];
  error?: string;
}

export async function getBuyerOrdersData(
  session: AuthSessionSummary
): Promise<BuyerOrdersPageData> {
  const eligibility = evaluateBuyerEligibility(session);
  if (!eligibility.eligible || !eligibility.userId) {
    return { eligibility, orders: [] };
  }

  const env = getPublicSupabaseEnv();
  const supabase = await createSupabaseServerClient();
  if (!env || !supabase) {
    return {
      eligibility,
      orders: [],
      error: "Supabase client is not configured.",
    };
  }

  const { data: rawOrders, error: ordersErr } = await supabase
    .from("orders")
    .select(
      "id,order_code,source,seller_id,status,subtotal_sen,fpx_fee_sen,total_paid_sen,collection_area_name,payment_deadline,paid_at,completed_at,created_at"
    )
    .eq("buyer_id", eligibility.userId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (ordersErr) {
    return {
      eligibility,
      orders: [],
      error: "Could not load your orders right now.",
    };
  }

  const orderRows = (rawOrders ?? []) as Array<{
    id: string;
    order_code: string;
    source: string;
    seller_id: string;
    status: string;
    subtotal_sen: number;
    fpx_fee_sen: number;
    total_paid_sen: number;
    collection_area_name: string | null;
    payment_deadline: string | null;
    paid_at: string | null;
    completed_at: string | null;
    created_at: string;
  }>;

  if (orderRows.length === 0) {
    return { eligibility, orders: [] };
  }

  const orderIds = orderRows.map((o) => o.id);
  const paidOrderIds = orderRows
    .filter((o) => o.status === "paid" || o.status === "ready_for_pickup")
    .map((o) => o.id);
  const sellerIds = Array.from(new Set(orderRows.map((o) => o.seller_id)));
  const service = getServerServiceClient();

  const [itemsRes, profilesRes, storefrontsRes, paymentsRes, pinsRes] =
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

  const orders: BuyerOrderView[] = orderRows.map((o) => ({
    id: o.id,
    orderCode: o.order_code,
    source: o.source,
    sellerId: o.seller_id,
    sellerName: sellerNameMap.get(o.seller_id) ?? "UMSKAL Seller",
    status: o.status,
    subtotalSen: Number(o.subtotal_sen ?? 0),
    fpxFeeSen: Number(o.fpx_fee_sen ?? 100),
    totalPaidSen: Number(o.total_paid_sen ?? 0),
    collectionAreaName: o.collection_area_name?.trim() || "UMSKAL Campus",
    paymentDeadline: o.payment_deadline,
    paidAt: o.paid_at,
    completedAt: o.completed_at,
    createdAt: o.created_at,
    pickupPin: pinByOrder.get(o.id) ?? null,
    latestPayment: latestPaymentByOrder.get(o.id) ?? null,
    items: itemsByOrder.get(o.id) ?? [],
  }));

  return { eligibility, orders };
}
