import { resolvePublicStorageUrl } from "@/lib/format";
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
  unitSen: number;
  quantity: number;
  imageUrl: string | null;
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
  createdAt: string;
  pinFailedAttempts: number;
  pinLockedUntil: string | null;
  hasActiveDispute: boolean;
  items: SellerOrderItemView[];
}

export interface SellerOrdersPageData {
  eligibility: SellerEligibilityResult;
  orders: SellerOrderView[];
  error?: string;
}

const ACTIVE_DISPUTE_STATUSES = new Set(["open", "under_review"]);

/**
 * Fetches seller-owned orders strictly WITHOUT `pickup_pin` or `raw_callback`.
 */
export async function getSellerOrdersData(
  session: AuthSessionSummary
): Promise<SellerOrdersPageData> {
  const eligibility = evaluateSellerEligibility(session);
  const sellerId = session.profile?.id;
  if (!eligibility.eligible || !sellerId) {
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
      "id,order_code,source,checkout_session_id,buyer_id,status,subtotal_sen,commission_sen,seller_net_sen,collection_area_name,payment_deadline,paid_at,handed_over_at,completed_at,created_at,pin_failed_attempts,pin_locked_until"
    )
    .eq("seller_id", sellerId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (ordersErr) {
    return {
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
    created_at: string;
    pin_failed_attempts: number | null;
    pin_locked_until: string | null;
  }>;

  if (rows.length === 0) {
    return { eligibility, orders: [] };
  }

  const orderIds = rows.map((r) => r.id);
  const buyerIds = Array.from(new Set(rows.map((r) => r.buyer_id)));

  const [itemsRes, buyersRes, disputesRes] = await Promise.all([
    supabase
      .from("order_items")
      .select("id,order_id,listing_id,title_snapshot,unit_sen,quantity,image_path")
      .in("order_id", orderIds),
    supabase
      .from("public_profiles")
      .select("id,display_name")
      .in("id", buyerIds),
    supabase
      .from("order_disputes")
      .select("order_id,status,refund_execution_status")
      .in("order_id", orderIds),
  ]);

  const itemsByOrder = new Map<string, SellerOrderItemView[]>();
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
    if (ACTIVE_DISPUTE_STATUSES.has(ds) || exec === "pending_execution") {
      activeDisputeOrders.add(d.order_id);
    }
  }

  const orders: SellerOrderView[] = rows.map((o) => ({
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
    createdAt: o.created_at,
    pinFailedAttempts: Number(o.pin_failed_attempts ?? 0),
    pinLockedUntil: o.pin_locked_until,
    hasActiveDispute:
      o.status.toLowerCase() === "disputed" || activeDisputeOrders.has(o.id),
    items: itemsByOrder.get(o.id) ?? [],
  }));

  return { eligibility, orders };
}
