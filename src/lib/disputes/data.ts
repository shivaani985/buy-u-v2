import { readOrderRelations } from "@/lib/orders/read";
import {
  buildPrivateDisputeEvidenceUrl,
  type DisputeStatus,
} from "@/lib/disputes/validation";
import { resolvePublicStorageUrl } from "@/lib/format";
import {
  evaluateSellerEligibility,
  type SellerEligibilityResult,
} from "@/lib/seller/validation";
import { getPublicSupabaseEnv } from "@/lib/supabase/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getServerServiceClient } from "@/lib/supabase/service";
import type { AuthSessionSummary } from "@/types/marketplace";

export interface DisputeEvidenceLink {
  path: string;
  url: string;
}

export interface OrderDisputeSummaryView {
  id: string;
  disputeCode: string;
  orderId: string;
  reason: string;
  reasonCode: string | null;
  description: string | null;
  buyerEvidence: DisputeEvidenceLink[];
  previousOrderStatus: string | null;
  sellerResponse: string | null;
  sellerEvidence: DisputeEvidenceLink[];
  sellerRespondedAt: string | null;
  status: DisputeStatus;
  underReviewAt: string | null;
  resolutionType: string | null;
  refundAmountSen: number | null;
  refundExecutionStatus: string;
  resolvedAt: string | null;
  createdAt: string;
}

export interface SellerDisputeItemView extends OrderDisputeSummaryView {
  orderCode: string;
  orderStatus: string;
  buyerName: string;
  subtotalSen: number;
  sellerNetSen: number;
  collectionAreaName: string;
  isServiceOrder: boolean;
  items: Array<{
    id: string;
    title: string;
    quantity: number;
    unitSen: number;
    imageUrl: string | null;
    isService: boolean;
    serviceMode: string | null;
    serviceRequirements: string | null;
    serviceAttachmentPaths: string[];
  }>;
}

export interface AdminDisputeItemView extends SellerDisputeItemView {
  sellerName: string;
  adminNotes: string | null;
}

const SAFE_DISPUTE_SELECT =
  "id,dispute_code,order_id,reason,reason_code,description,evidence_paths,previous_order_status,seller_response,seller_evidence_paths,seller_responded_at,status,under_review_at,resolution_type,refund_amount_sen,refund_execution_status,resolved_at,created_at";

interface RawDisputeRow {
  id: string;
  dispute_code: string | null;
  order_id: string;
  reason: string;
  reason_code: string | null;
  description: string | null;
  evidence_paths: string[] | null;
  previous_order_status: string | null;
  seller_response: string | null;
  seller_evidence_paths: string[] | null;
  seller_responded_at: string | null;
  status: string;
  under_review_at: string | null;
  resolution_type: string | null;
  refund_amount_sen: number | null;
  refund_execution_status: string | null;
  resolved_at: string | null;
  created_at: string;
  admin_notes?: string | null;
}

function mapDisputeRow(row: RawDisputeRow): OrderDisputeSummaryView {
  return {
    id: row.id,
    disputeCode:
      row.dispute_code || `DSP-${row.id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    orderId: row.order_id,
    reason: row.reason,
    reasonCode: row.reason_code,
    description: row.description,
    buyerEvidence: (row.evidence_paths ?? []).map((p) => ({
      path: p,
      url: buildPrivateDisputeEvidenceUrl(row.order_id, p),
    })),
    previousOrderStatus: row.previous_order_status,
    sellerResponse: row.seller_response,
    sellerEvidence: (row.seller_evidence_paths ?? []).map((p) => ({
      path: p,
      url: buildPrivateDisputeEvidenceUrl(row.order_id, p),
    })),
    sellerRespondedAt: row.seller_responded_at,
    status: (row.status as DisputeStatus) || "open",
    underReviewAt: row.under_review_at,
    resolutionType: row.resolution_type,
    refundAmountSen: row.refund_amount_sen,
    refundExecutionStatus: row.refund_execution_status || "not_applicable",
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}

export async function getLatestDisputesByOrderIds(
  orderIds: string[]
): Promise<Map<string, OrderDisputeSummaryView>> {
  const map = new Map<string, OrderDisputeSummaryView>();
  if (orderIds.length === 0) return map;

  const supabase = await createSupabaseServerClient();
  if (!supabase) return map;

  const { data } = await readOrderRelations(orderIds, (batch, start, end) => supabase
    .from("order_disputes")
    .select(SAFE_DISPUTE_SELECT)
    .in("order_id", batch)
    .order("created_at", { ascending: false }).order("id")
    .range(start, end));

  for (const row of (data ?? []) as RawDisputeRow[]) {
    if (!map.has(row.order_id)) {
      map.set(row.order_id, mapDisputeRow(row));
    }
  }
  return map;
}

export async function getSellerDisputesData(
  session: AuthSessionSummary
): Promise<{
  eligibility: SellerEligibilityResult;
  disputes: SellerDisputeItemView[];
  error?: string;
}> {
  const eligibility = evaluateSellerEligibility(session);
  const sellerId = session.profile?.id;
  if (!eligibility.eligible || !sellerId) {
    return { eligibility, disputes: [] };
  }

  const env = getPublicSupabaseEnv();
  const supabase = await createSupabaseServerClient();
  if (!env || !supabase) {
    return {
      eligibility,
      disputes: [],
      error: "Supabase client is not configured.",
    };
  }

  const { data: sellerOrders, error: ordErr } = await supabase
    .from("orders")
    .select(
      "id,order_code,buyer_id,status,subtotal_sen,seller_net_sen,collection_area_name"
    )
    .eq("seller_id", sellerId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (ordErr) {
    return {
      eligibility,
      disputes: [],
      error: "Could not load your orders for dispute review.",
    };
  }

  const orders = (sellerOrders ?? []) as Array<{
    id: string;
    order_code: string;
    buyer_id: string;
    status: string;
    subtotal_sen: number;
    seller_net_sen: number;
    collection_area_name: string | null;
  }>;
  if (orders.length === 0) {
    return { eligibility, disputes: [] };
  }

  const orderIds = orders.map((o) => o.id);
  const { data: rawDisputes, error: dispErr } = await supabase
    .from("order_disputes")
    .select(SAFE_DISPUTE_SELECT)
    .in("order_id", orderIds)
    .order("created_at", { ascending: false });

  if (dispErr) {
    return {
      eligibility,
      disputes: [],
      error: "Could not load disputes right now.",
    };
  }

  const disputeRows = (rawDisputes ?? []) as RawDisputeRow[];
  if (disputeRows.length === 0) {
    return { eligibility, disputes: [] };
  }

  const relevantOrderIds = Array.from(new Set(disputeRows.map((d) => d.order_id)));
  const orderMap = new Map(orders.map((o) => [o.id, o]));
  const buyerIds = Array.from(
    new Set(
      relevantOrderIds
        .map((id) => orderMap.get(id)?.buyer_id)
        .filter((id): id is string => Boolean(id))
    )
  );

  const [itemsRes, buyersRes] = await Promise.all([
    supabase
      .from("order_items")
      .select(
        "id,order_id,title_snapshot,quantity,unit_sen,image_path,is_service,service_mode,service_requirements,service_attachment_paths"
      )
      .in("order_id", relevantOrderIds),
    supabase.from("public_profiles").select("id,display_name").in("id", buyerIds),
  ]);

  const buyerNames = new Map<string, string>();
  for (const b of (buyersRes.data ?? []) as Array<{
    id: string;
    display_name: string | null;
  }>) {
    if (b.display_name?.trim()) buyerNames.set(b.id, b.display_name.trim());
  }

  const itemsByOrder = new Map<string, SellerDisputeItemView["items"]>();
  for (const it of (itemsRes.data ?? []) as Array<{
    id: string;
    order_id: string;
    title_snapshot: string;
    quantity: number;
    unit_sen: number;
    image_path: string | null;
    is_service?: boolean | null;
    service_mode?: string | null;
    service_requirements?: string | null;
    service_attachment_paths?: string[] | null;
  }>) {
    const list = itemsByOrder.get(it.order_id) ?? [];
    list.push({
      id: it.id,
      title: it.title_snapshot,
      quantity: Number(it.quantity ?? 1),
      unitSen: Number(it.unit_sen ?? 0),
      imageUrl: resolvePublicStorageUrl("listings", it.image_path, env.url),
      isService: Boolean(it.is_service),
      serviceMode: it.service_mode ?? null,
      serviceRequirements: it.service_requirements ?? null,
      serviceAttachmentPaths: Array.isArray(it.service_attachment_paths)
        ? it.service_attachment_paths
        : [],
    });
    itemsByOrder.set(it.order_id, list);
  }

  const disputes: SellerDisputeItemView[] = disputeRows
    .map((row) => {
      const ord = orderMap.get(row.order_id);
      if (!ord) return null;
      const items = itemsByOrder.get(ord.id) ?? [];
      return {
        ...mapDisputeRow(row),
        orderCode: ord.order_code,
        orderStatus: ord.status,
        buyerName: buyerNames.get(ord.buyer_id) ?? "UMSKAL Member",
        subtotalSen: Number(ord.subtotal_sen ?? 0),
        sellerNetSen: Number(ord.seller_net_sen ?? 0),
        collectionAreaName: ord.collection_area_name || "Campus Collection Point",
        isServiceOrder: items.some((it) => it.isService),
        items,
      };
    })
    .filter((d): d is SellerDisputeItemView => d !== null);

  return { eligibility, disputes };
}

export async function getAdminDisputesData(
  session: AuthSessionSummary
): Promise<{ disputes: AdminDisputeItemView[]; error?: string }> {
  if (!session.isAuthenticated || !session.isActiveAdmin) {
    return { disputes: [], error: "Administrator access required." };
  }

  const env = getPublicSupabaseEnv();
  const service = getServerServiceClient();
  if (!env || !service) {
    return { disputes: [], error: "Admin database client unavailable." };
  }

  const { data: rawDisputes, error: dispErr } = await service
    .from("order_disputes")
    .select(`${SAFE_DISPUTE_SELECT},admin_notes`)
    .order("created_at", { ascending: false })
    .limit(100);

  if (dispErr) {
    return { disputes: [], error: "Could not load disputes queue." };
  }

  const disputeRows = (rawDisputes ?? []) as RawDisputeRow[];
  if (disputeRows.length === 0) {
    return { disputes: [] };
  }

  const orderIds = Array.from(new Set(disputeRows.map((d) => d.order_id)));
  const [ordersRes, itemsRes] = await Promise.all([
    service
      .from("orders")
      .select(
        "id,order_code,buyer_id,seller_id,status,subtotal_sen,seller_net_sen,collection_area_name"
      )
      .in("id", orderIds),
    service
      .from("order_items")
      .select(
        "id,order_id,title_snapshot,quantity,unit_sen,image_path,is_service,service_mode,service_requirements,service_attachment_paths"
      )
      .in("order_id", orderIds),
  ]);

  const orders = (ordersRes.data ?? []) as Array<{
    id: string;
    order_code: string;
    buyer_id: string;
    seller_id: string;
    status: string;
    subtotal_sen: number;
    seller_net_sen: number;
    collection_area_name: string | null;
  }>;
  const orderMap = new Map(orders.map((o) => [o.id, o]));
  const profileIds = Array.from(
    new Set(orders.flatMap((o) => [o.buyer_id, o.seller_id]))
  );
  const { data: profiles } = await service
    .from("profiles")
    .select("id,display_name,full_name,email")
    .in("id", profileIds);

  const nameMap = new Map<string, string>();
  for (const p of (profiles ?? []) as Array<{
    id: string;
    display_name: string | null;
    full_name: string | null;
    email: string | null;
  }>) {
    nameMap.set(
      p.id,
      p.display_name?.trim() || p.full_name?.trim() || p.email || "UMSKAL Member"
    );
  }

  const itemsByOrder = new Map<string, SellerDisputeItemView["items"]>();
  for (const it of (itemsRes.data ?? []) as Array<{
    id: string;
    order_id: string;
    title_snapshot: string;
    quantity: number;
    unit_sen: number;
    image_path: string | null;
    is_service?: boolean | null;
    service_mode?: string | null;
    service_requirements?: string | null;
    service_attachment_paths?: string[] | null;
  }>) {
    const list = itemsByOrder.get(it.order_id) ?? [];
    list.push({
      id: it.id,
      title: it.title_snapshot,
      quantity: Number(it.quantity ?? 1),
      unitSen: Number(it.unit_sen ?? 0),
      imageUrl: resolvePublicStorageUrl("listings", it.image_path, env.url),
      isService: Boolean(it.is_service),
      serviceMode: it.service_mode ?? null,
      serviceRequirements: it.service_requirements ?? null,
      serviceAttachmentPaths: Array.isArray(it.service_attachment_paths)
        ? it.service_attachment_paths
        : [],
    });
    itemsByOrder.set(it.order_id, list);
  }

  const disputes: AdminDisputeItemView[] = disputeRows
    .map((row) => {
      const ord = orderMap.get(row.order_id);
      if (!ord) return null;
      const items = itemsByOrder.get(ord.id) ?? [];
      return {
        ...mapDisputeRow(row),
        orderCode: ord.order_code,
        orderStatus: ord.status,
        buyerName: nameMap.get(ord.buyer_id) ?? "UMSKAL Member",
        sellerName: nameMap.get(ord.seller_id) ?? "UMSKAL Seller",
        subtotalSen: Number(ord.subtotal_sen ?? 0),
        sellerNetSen: Number(ord.seller_net_sen ?? 0),
        collectionAreaName: ord.collection_area_name || "Campus Collection Point",
        isServiceOrder: items.some((it) => it.isService),
        items,
        adminNotes: row.admin_notes ?? null,
      };
    })
    .filter((d): d is AdminDisputeItemView => d !== null);

  return { disputes };
}
