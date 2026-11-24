import { evaluateBuyerEligibility, type BuyerEligibilityResult } from "@/lib/buyer/validation";
import { resolvePublicStorageUrl } from "@/lib/format";
import { getPublicSupabaseEnv } from "@/lib/supabase/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { AuthSessionSummary } from "@/types/marketplace";

export interface BuyerOrderItemView {
  id: string;
  listingId: string | null;
  title: string;
  unitSen: number;
  quantity: number;
  imageUrl: string | null;
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
  const sellerIds = Array.from(new Set(orderRows.map((o) => o.seller_id)));

  const [itemsRes, profilesRes, storefrontsRes] = await Promise.all([
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
  ]);

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
    items: itemsByOrder.get(o.id) ?? [],
  }));

  return { eligibility, orders };
}
