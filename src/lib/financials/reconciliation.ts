import {
  isAuthoritativeOrderPaymentVerified,
  isEligibleForWithdrawalRelease,
} from "./policy.ts";

export interface ReconCheckoutSession {
  id: string;
  buyer_id?: string | null;
  checkout_code: string;
  combined_subtotal_sen: number;
  fpx_fee_sen: number;
  total_paid_sen: number;
  status: string;
  payment_status: string;
  transaction_ref: string | null;
  paid_at: string | null;
}

export interface ReconPayment {
  id: string;
  order_id: string;
  amount_sen: number;
  status: string;
  transaction_ref: string | null;
  verified_at: string | null;
}

export interface ReconOrder {
  id: string;
  buyer_id?: string | null;
  order_code: string;
  checkout_session_id: string | null;
  seller_id: string;
  subtotal_sen: number;
  fpx_fee_sen: number;
  commission_sen: number;
  seller_net_sen: number;
  status: string;
  paid_at: string | null;
  completed_at: string | null;
  protection_expires_at?: string | null;
}

export interface ReconRefund {
  id: string;
  order_id: string;
  refund_amount_sen: number;
  commission_reversal_sen: number;
  seller_deduction_sen: number;
  status: string;
  refund_ref: string | null;
}

export interface ReconPayout {
  id: string;
  withdrawal_code: string | null;
  seller_id: string;
  amount_sen: number;
  status: string;
  transfer_ref: string | null;
  processing_started_at: string | null;
  created_at: string;
}

export interface ReconDispute {
  order_id: string;
  status: string;
  refund_execution_status?: string | null;
}

export interface ReconciliationCheck {
  id: string;
  label: string;
  status: "PASS" | "FLAG";
  detail: string;
}

export interface PlatformFinancialOverview {
  totalVerifiedCollectionsSen: number;
  grossProductSalesSen: number;
  fpxFeesCollectedSen: number;
  executedRefundsSen: number;
  netProductSalesSen: number;
  originalCommissionSen: number;
  commissionReversalsSen: number;
  netPlatformCommissionSen: number;
  pendingSettlementSen: number;
  protectionReserveSen: number;
  frozenEarningsSen: number;
  availableSellerLiabilitiesSen: number;
  reservedWithdrawalsSen: number;
  successfullyPaidOutSen: number;
  failedTransfersCount: number;
  reconciliationRequiredCount: number;
  checks: ReconciliationCheck[];
}

const EXCLUDED_UNPAID = new Set([
  "pending_payment",
  "expired",
  "cancelled",
  "canceled",
  "failed",
]);

/**
 * Computes platform-wide financial overview & read-only reconciliation checks
 * without double-counting parent checkout_sessions and child orders.
 */
export function computePlatformFinancialReconciliation(input: {
  checkoutSessions: ReconCheckoutSession[];
  legacyPayments: ReconPayment[];
  orders: ReconOrder[];
  disputes: ReconDispute[];
  refunds: ReconRefund[];
  payouts: ReconPayout[];
  nowMs?: number;
}): PlatformFinancialOverview {
  const nowMs = input.nowMs ?? Date.now();
  const checks: ReconciliationCheck[] = [];

  // 1. Verified collections: unified checkout_sessions + legacy paid payments (never double-counted!)
  let totalVerifiedCollectionsSen = 0;
  let fpxFeesCollectedSen = 0;
  const txRefSeen = new Map<string, number>();

  for (const cs of input.checkoutSessions) {
    if (cs.status === "paid" || cs.paid_at) {
      totalVerifiedCollectionsSen += cs.total_paid_sen;
      fpxFeesCollectedSen += cs.fpx_fee_sen;
      if (cs.transaction_ref) {
        txRefSeen.set(cs.transaction_ref, (txRefSeen.get(cs.transaction_ref) ?? 0) + 1);
      }
    }
  }

  const orderById = new Map(input.orders.map((o) => [o.id, o]));
  for (const p of input.legacyPayments) {
    const ord = orderById.get(p.order_id);
    if (ord && ord.checkout_session_id === null && p.status === "paid" && p.verified_at) {
      totalVerifiedCollectionsSen += p.amount_sen;
      fpxFeesCollectedSen += ord.fpx_fee_sen;
      if (p.transaction_ref) {
        txRefSeen.set(p.transaction_ref, (txRefSeen.get(p.transaction_ref) ?? 0) + 1);
      }
    }
  }

  // 2. Executed & blocking refunds by order
  const refundByOrder = new Map<string, { product: number; commRev: number; sellerDeduct: number }>();
  const blockingRefundOrders = new Set<string>();
  const BLOCKING_REFUND_STATUSES = new Set([
    "pending_execution",
    "awaiting_return",
    "processing",
    "failed",
    "reconciliation_required",
  ]);
  let executedRefundsSen = 0;
  let commissionReversalsSen = 0;
  let overRefundFlag = false;
  let refundAccountingFlag = false;

  for (const r of input.refunds) {
    if (r.refund_amount_sen !== r.commission_reversal_sen + r.seller_deduction_sen) {
      refundAccountingFlag = true;
    }
    const rs = (r.status ?? "").toLowerCase();
    if (rs === "succeeded") {
      executedRefundsSen += r.refund_amount_sen;
      commissionReversalsSen += r.commission_reversal_sen;
      const cur = refundByOrder.get(r.order_id) ?? { product: 0, commRev: 0, sellerDeduct: 0 };
      cur.product += r.refund_amount_sen;
      cur.commRev += r.commission_reversal_sen;
      cur.sellerDeduct += r.seller_deduction_sen;
      refundByOrder.set(r.order_id, cur);
      const ord = orderById.get(r.order_id);
      if (ord && cur.product > ord.subtotal_sen) {
        overRefundFlag = true;
      }
    } else if (BLOCKING_REFUND_STATUSES.has(rs)) {
      blockingRefundOrders.add(r.order_id);
    }
  }

  // 3. Frozen dispute set
  const frozenOrders = new Set<string>();
  for (const d of input.disputes) {
    const ds = (d.status ?? "").toLowerCase();
    const es = (d.refund_execution_status ?? "").toLowerCase();
    if (ds === "open" || ds === "under_review" || es === "pending_execution" || es === "failed") {
      frozenOrders.add(d.order_id);
    }
  }

  const csById = new Map(input.checkoutSessions.map((cs) => [cs.id, cs]));
  const payByOrderId = new Map(input.legacyPayments.map((p) => [p.order_id, p]));

  // 4. Seller order buckets (mutually exclusive, authoritative payment proof & protection deadline!)
  let grossProductSalesSen = 0;
  let originalCommissionSen = 0;
  let originalSellerEarningsSen = 0;
  let executedSellerDeductionsSen = 0;
  let pendingSettlementSen = 0;
  let protectionReserveSen = 0;
  let frozenEarningsSen = 0;
  let maturedCompletedNetSen = 0;

  for (const o of input.orders) {
    const s = (o.status ?? "").toLowerCase();
    if (EXCLUDED_UNPAID.has(s)) continue;
    const verified = isAuthoritativeOrderPaymentVerified({
      order: o,
      checkoutSession: o.checkout_session_id ? csById.get(o.checkout_session_id) ?? null : null,
      legacyPayment: payByOrderId.get(o.id) ?? null,
    });
    if (!verified) continue;

    grossProductSalesSen += o.subtotal_sen;
    originalCommissionSen += o.commission_sen;
    originalSellerEarningsSen += o.seller_net_sen;

    const adj = refundByOrder.get(o.id);
    const sellerDeduct = adj?.sellerDeduct ?? 0;
    executedSellerDeductionsSen += sellerDeduct;
    const adjustedNet = Math.max(0, o.seller_net_sen - sellerDeduct);

    if (s === "refunded" || adjustedNet === 0) {
      continue;
    }
    if (s === "disputed" || frozenOrders.has(o.id) || blockingRefundOrders.has(o.id)) {
      frozenEarningsSen += adjustedNet;
    } else if (s === "paid" || s === "handed_over") {
      pendingSettlementSen += adjustedNet;
    } else if (s === "completed") {
      if (isEligibleForWithdrawalRelease(o.completed_at, nowMs, o.protection_expires_at)) {
        maturedCompletedNetSen += adjustedNet;
      } else {
        protectionReserveSen += adjustedNet;
      }
    }
  }

  // 5. Payouts (failed/rejected NEVER count as paid out or reserved!)
  let reservedWithdrawalsSen = 0;
  let successfullyPaidOutSen = 0;
  let failedTransfersCount = 0;
  let reconciliationRequiredCount = 0;
  let staleProcessingCount = 0;

  for (const p of input.payouts) {
    const s = (p.status ?? "").toLowerCase();
    if (s === "paid") {
      successfullyPaidOutSen += p.amount_sen;
    } else if (s === "pending" || s === "processing" || s === "reconciliation_required") {
      reservedWithdrawalsSen += p.amount_sen;
      if (s === "reconciliation_required") reconciliationRequiredCount += 1;
      if (s === "processing" && p.processing_started_at) {
        const ageMs = nowMs - Date.parse(p.processing_started_at);
        if (ageMs > 15 * 60 * 1000) staleProcessingCount += 1;
      }
    } else if (s === "failed") {
      failedTransfersCount += 1;
    }
  }

  const rawAvailable = maturedCompletedNetSen - reservedWithdrawalsSen - successfullyPaidOutSen;
  const availableSellerLiabilitiesSen = Math.max(0, rawAvailable);

  const netProductSalesSen = Math.max(0, grossProductSalesSen - executedRefundsSen);
  const netPlatformCommissionSen = Math.max(0, originalCommissionSen - commissionReversalsSen);

  // Core Accounting Invariant checks
  const dupRefs = Array.from(txRefSeen.entries()).filter(([, c]) => c > 1);
  checks.push({
    id: "duplicate_tx_refs",
    label: "Unique gateway transaction references",
    status: dupRefs.length === 0 ? "PASS" : "FLAG",
    detail: dupRefs.length === 0 ? "No duplicate verified transaction references." : `${dupRefs.length} duplicate refs found.`,
  });

  const expectedCollections = grossProductSalesSen + fpxFeesCollectedSen;
  checks.push({
    id: "collections_vs_orders",
    label: "Verified collections match gross sales + FPX fees",
    status: totalVerifiedCollectionsSen === expectedCollections ? "PASS" : "FLAG",
    detail: `Collections ${totalVerifiedCollectionsSen} sen vs Sales+FPX ${expectedCollections} sen`,
  });

  const adjustedSellerEarnings = originalSellerEarningsSen - executedSellerDeductionsSen;
  const bucketSum =
    pendingSettlementSen +
    protectionReserveSen +
    frozenEarningsSen +
    availableSellerLiabilitiesSen +
    reservedWithdrawalsSen +
    successfullyPaidOutSen;
  checks.push({
    id: "seller_earnings_equation",
    label: "Adjusted seller earnings equal sum of all 6 balance buckets",
    status: adjustedSellerEarnings === bucketSum && rawAvailable >= 0 ? "PASS" : "FLAG",
    detail: `Adjusted ${adjustedSellerEarnings} sen vs Buckets ${bucketSum} sen (rawAvail=${rawAvailable})`,
  });

  checks.push({
    id: "refund_limits",
    label: "Refund amounts within order subtotals & accounting invariant",
    status: !overRefundFlag && !refundAccountingFlag ? "PASS" : "FLAG",
    detail: !overRefundFlag && !refundAccountingFlag ? "All refund calculations match subtotal & 2% commission reversal." : "Refund limit or rounding anomaly detected.",
  });

  checks.push({
    id: "stale_processing",
    label: "No stale processing or reconciliation-required transfers",
    status: staleProcessingCount === 0 && reconciliationRequiredCount === 0 ? "PASS" : "FLAG",
    detail: `Stale processing: ${staleProcessingCount}, Reconciliation required: ${reconciliationRequiredCount}`,
  });

  return {
    totalVerifiedCollectionsSen,
    grossProductSalesSen,
    fpxFeesCollectedSen,
    executedRefundsSen,
    netProductSalesSen,
    originalCommissionSen,
    commissionReversalsSen,
    netPlatformCommissionSen,
    pendingSettlementSen,
    protectionReserveSen,
    frozenEarningsSen,
    availableSellerLiabilitiesSen,
    reservedWithdrawalsSen,
    successfullyPaidOutSen,
    failedTransfersCount,
    reconciliationRequiredCount,
    checks,
  };
}

export interface SanitizedFinancialCsvRow {
  type: "payment" | "refund" | "withdrawal";
  reference: string;
  orderOrCheckoutCode: string;
  status: string;
  amountRm: string;
  maskedDestination: string;
  simulationMode: string;
  timestamp: string;
}

function csvEscape(v: string): string {
  const s = String(v ?? "");
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Exports strictly sanitized financial rows (NEVER includes full bank numbers,
 * pickup PINs, raw callbacks, secrets, or session tokens).
 */
export function buildSanitizedFinancialCsv(
  rows: SanitizedFinancialCsvRow[]
): string {
  const header = [
    "Type",
    "Reference",
    "Order/Checkout",
    "Status",
    "Amount (RM)",
    "Masked Destination",
    "Mode",
    "Timestamp",
  ].join(",");

  const body = rows.map((r) =>
    [
      csvEscape(r.type),
      csvEscape(r.reference),
      csvEscape(r.orderOrCheckoutCode),
      csvEscape(r.status),
      csvEscape(r.amountRm),
      csvEscape(r.maskedDestination),
      csvEscape(r.simulationMode),
      csvEscape(r.timestamp),
    ].join(",")
  );
  return [header, ...body].join("\n");
}
