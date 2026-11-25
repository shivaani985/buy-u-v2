import {
  computePlatformFinancialReconciliation,
  type PlatformFinancialOverview,
  type ReconCheckoutSession,
  type ReconDispute,
  type ReconOrder,
  type ReconPayment,
  type ReconPayout,
  type ReconRefund,
} from "@/lib/financials/reconciliation";
import { getServerServiceClient } from "@/lib/supabase/service";
import type { AuthSessionSummary } from "@/types/marketplace";

export interface AdminRefundRow {
  id: string;
  refundCode: string;
  disputeId: string;
  orderId: string;
  orderCode: string;
  isServiceOrder: boolean;
  refundType: string;
  refundAmountSen: number;
  commissionReversalSen: number;
  sellerDeductionSen: number;
  status: string;
  refundRef: string | null;
  returnRequired: boolean;
  returnStatus: string;
  returnInstructions: string | null;
  itemCondition: string;
  restockStatus: string;
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface AdminWithdrawalRow {
  id: string;
  withdrawalCode: string;
  sellerId: string;
  sellerName: string;
  amountSen: number;
  maskedBankSummary: string;
  status: string;
  transferRef: string | null;
  failureReason: string | null;
  reconciliationReason: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface AdminFinancialDashboardData {
  overview: PlatformFinancialOverview;
  refunds: AdminRefundRow[];
  withdrawals: AdminWithdrawalRow[];
  checkouts: ReconCheckoutSession[];
  error?: string;
}

export async function getAdminFinancialsData(
  session: AuthSessionSummary
): Promise<AdminFinancialDashboardData | null> {
  if (!session.isAuthenticated || !session.isActiveAdmin) {
    return null;
  }

  const service = getServerServiceClient();
  if (!service) return null;

  const [csRes, payRes, ordRes, dispRes, refRes, wdrRes] = await Promise.all([
    service
      .from("checkout_sessions")
      .select(
        "id,checkout_code,combined_subtotal_sen,fpx_fee_sen,total_paid_sen,status,payment_status,transaction_ref,paid_at"
      )
      .order("created_at", { ascending: false })
      .limit(200),
    service
      .from("payments")
      .select("id,order_id,amount_sen,status,transaction_ref,verified_at")
      .limit(200),
    service
      .from("orders")
      .select(
        "id,order_code,checkout_session_id,seller_id,subtotal_sen,fpx_fee_sen,commission_sen,seller_net_sen,status,paid_at,completed_at"
      )
      .limit(500),
    service
      .from("order_disputes")
      .select("order_id,status,refund_execution_status")
      .limit(200),
    service
      .from("order_refunds")
      .select(
        "id,refund_code,dispute_id,order_id,refund_type,refund_amount_sen,commission_reversal_sen,seller_deduction_sen,status,refund_ref,return_required,return_status,return_instructions,item_condition,restock_status,failure_reason,created_at,completed_at"
      )
      .order("created_at", { ascending: false })
      .limit(200),
    service
      .from("payout_requests")
      .select(
        "id,withdrawal_code,seller_id,amount_sen,masked_bank_summary,status,transfer_ref,failure_reason,reconciliation_reason,processing_started_at,created_at,completed_at"
      )
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  const checkouts = (csRes.data ?? []) as ReconCheckoutSession[];
  const legacyPayments = (payRes.data ?? []) as ReconPayment[];
  const orders = (ordRes.data ?? []) as ReconOrder[];
  const disputes = (dispRes.data ?? []) as ReconDispute[];
  const rawRefunds = (refRes.error ? [] : (refRes.data ?? [])) as Array<{
    id: string;
    refund_code: string;
    dispute_id: string;
    order_id: string;
    refund_type: string;
    refund_amount_sen: number;
    commission_reversal_sen: number;
    seller_deduction_sen: number;
    status: string;
    refund_ref: string | null;
    return_required: boolean;
    return_status: string;
    return_instructions: string | null;
    item_condition: string;
    restock_status: string;
    failure_reason: string | null;
    created_at: string;
    completed_at: string | null;
  }>;
  const rawPayouts = (wdrRes.error ? [] : (wdrRes.data ?? [])) as Array<{
    id: string;
    withdrawal_code: string | null;
    seller_id: string;
    amount_sen: number;
    masked_bank_summary: string | null;
    status: string;
    transfer_ref: string | null;
    failure_reason: string | null;
    reconciliation_reason: string | null;
    processing_started_at: string | null;
    created_at: string;
    completed_at: string | null;
  }>;

  const orderCodeMap = new Map(orders.map((o) => [o.id, o.order_code]));
  const refundOrderIds = Array.from(new Set(rawRefunds.map((r) => r.order_id)));
  const { data: serviceRefundItems } = refundOrderIds.length
    ? await service
        .from("order_items")
        .select("order_id")
        .in("order_id", refundOrderIds)
        .eq("is_service", true)
    : { data: [] };
  const serviceOrderIds = new Set(
    ((serviceRefundItems ?? []) as Array<{ order_id: string }>).map(
      (r) => r.order_id
    )
  );
  const sellerIds = Array.from(new Set(rawPayouts.map((w) => w.seller_id)));
  const { data: sellerProfiles } = sellerIds.length
    ? await service
        .from("profiles")
        .select("id,display_name,full_name")
        .in("id", sellerIds)
    : { data: [] };
  const sellerNameMap = new Map<string, string>();
  for (const p of (sellerProfiles ?? []) as Array<{
    id: string;
    display_name: string | null;
    full_name: string | null;
  }>) {
    sellerNameMap.set(
      p.id,
      p.display_name?.trim() || p.full_name?.trim() || "UMSKAL Seller"
    );
  }

  const overview = computePlatformFinancialReconciliation({
    checkoutSessions: checkouts,
    legacyPayments,
    orders,
    disputes,
    refunds: rawRefunds as ReconRefund[],
    payouts: rawPayouts as ReconPayout[],
  });

  const refunds: AdminRefundRow[] = rawRefunds.map((r) => ({
    id: r.id,
    refundCode: r.refund_code,
    disputeId: r.dispute_id,
    orderId: r.order_id,
    orderCode: orderCodeMap.get(r.order_id) ?? r.order_id.slice(0, 8),
    isServiceOrder: serviceOrderIds.has(r.order_id),
    refundType: r.refund_type,
    refundAmountSen: r.refund_amount_sen,
    commissionReversalSen: r.commission_reversal_sen,
    sellerDeductionSen: r.seller_deduction_sen,
    status: r.status,
    refundRef: r.refund_ref,
    returnRequired: r.return_required,
    returnStatus: r.return_status,
    returnInstructions: r.return_instructions,
    itemCondition: r.item_condition,
    restockStatus: r.restock_status,
    failureReason: r.failure_reason,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  }));

  const withdrawals: AdminWithdrawalRow[] = rawPayouts.map((w) => ({
    id: w.id,
    withdrawalCode: w.withdrawal_code || `WDR-${w.id.slice(0, 6).toUpperCase()}`,
    sellerId: w.seller_id,
    sellerName: sellerNameMap.get(w.seller_id) ?? "UMSKAL Seller",
    amountSen: w.amount_sen,
    maskedBankSummary: w.masked_bank_summary || "Masked Bank Account",
    status: w.status,
    transferRef: w.transfer_ref,
    failureReason: w.failure_reason,
    reconciliationReason: w.reconciliation_reason,
    createdAt: w.created_at,
    completedAt: w.completed_at,
  }));

  return { overview, refunds, withdrawals, checkouts };
}
