export type SalesRange = "7d" | "30d" | "all";

export interface RawSellerOrder {
  id: string;
  order_code: string;
  subtotal_sen: number;
  commission_sen: number;
  seller_net_sen: number;
  total_paid_sen: number;
  status: string;
  paid_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface RawOrderItem {
  order_id: string;
  title_snapshot: string;
  quantity: number;
}

export interface RawPayment {
  order_id: string;
  status: string;
  verified_at: string | null;
}

export interface RawPayoutRequest {
  id: string;
  amount_sen: number;
  status: string;
  processed_at: string | null;
  created_at: string;
}

export interface RawOrderDispute {
  order_id: string;
  status: string;
  refund_amount_sen: number | null;
  refund_execution_status?: string | null;
}

export interface SellerTransactionItem {
  id: string;
  orderCode: string;
  itemTitle: string;
  amountSen: number;
  statusLabel: string;
  statusTone: "live" | "pending" | "paid_out" | "muted" | "danger";
  timestamp: string;
}

export interface SalesChartPoint {
  label: string;
  isoDate: string;
  amountSen: number;
}

export interface SellerFinancialSummary {
  available: boolean;
  unavailableReason?: string;
  range: SalesRange;
  totalSalesSen: number;
  pendingSettlementSen: number;
  frozenDisputeSen: number;
  availableForPayoutSen: number;
  totalPaidOutSen: number;
  commissionTotalSen: number;
  verifiedOrderCount: number;
  transactions: SellerTransactionItem[];
  chartPoints: SalesChartPoint[];
}

const IN_PROGRESS_SETTLEMENT_STATUSES = new Set([
  "paid",
  "handed_over",
  "disputed",
]);

const COMPLETED_STATUSES = new Set(["completed"]);

const EXCLUDED_CANCELLED_STATUSES = new Set([
  "cancelled",
  "canceled",
  "refunded",
  "expired",
  "failed",
  "pending_payment",
]);

// Actual hosted payout_requests statuses: pending, paid, rejected
const ACTIVE_PAYOUT_DEDUCTION_STATUSES = new Set(["pending", "paid"]);

const PAID_OUT_STATUSES = new Set(["paid"]);

export function parseSalesRange(raw: string | undefined): SalesRange {
  if (raw === "30d" || raw === "all") return raw;
  return "7d";
}

function getCutoffMs(range: SalesRange, nowMs: number): number | null {
  if (range === "all") return null;
  const days = range === "30d" ? 30 : 7;
  return nowMs - days * 24 * 60 * 60 * 1000;
}

function mapTransactionStatus(
  orderStatus: string,
  paymentVerified: boolean
): { label: string; tone: SellerTransactionItem["statusTone"] } {
  const s = orderStatus.toLowerCase();
  if (COMPLETED_STATUSES.has(s)) {
    return { label: "Completed", tone: "live" };
  }
  if (s === "handed_over") {
    return { label: "Awaiting Receipt Confirmation", tone: "pending" };
  }
  if (s === "paid") {
    return { label: "Paid — Awaiting Handover", tone: "pending" };
  }
  if (s === "disputed") {
    return { label: "Disputed", tone: "danger" };
  }
  if (s === "refunded") {
    return { label: "Refunded", tone: "muted" };
  }
  if (s === "expired") {
    return { label: "Payment Expired", tone: "muted" };
  }
  if (s === "cancelled" || s === "canceled") {
    return { label: "Cancelled", tone: "muted" };
  }
  if (s === "pending_payment" && !paymentVerified) {
    return { label: "Awaiting Payment", tone: "muted" };
  }
  return { label: orderStatus, tone: "muted" };
}

function toDayKey(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Computes verified seller financial KPIs, chart points, and transaction rows
 * strictly from real database records. Never treats unpaid/pending_payment orders
 * as money held by Buy-U.
 */
export function computeSellerFinancials(input: {
  orders: RawSellerOrder[];
  orderItems: RawOrderItem[];
  payments: RawPayment[];
  payoutRequests: RawPayoutRequest[];
  disputes: RawOrderDispute[];
  range: SalesRange;
  now?: Date;
}): SellerFinancialSummary {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const cutoffMs = getCutoffMs(input.range, nowMs);

  const paymentByOrder = new Map<string, RawPayment>();
  for (const p of input.payments) {
    paymentByOrder.set(p.order_id, p);
  }

  const itemTitleByOrder = new Map<string, string>();
  for (const item of input.orderItems) {
    if (!itemTitleByOrder.has(item.order_id)) {
      itemTitleByOrder.set(
        item.order_id,
        item.quantity > 1
          ? `${item.title_snapshot} (×${item.quantity})`
          : item.title_snapshot
      );
    }
  }

  const refundByOrder = new Map<string, number>();
  const frozenDisputeOrders = new Set<string>();
  const ACTIVE_DISPUTE_STATUSES = new Set(["open", "under_review"]);
  for (const d of input.disputes) {
    const ds = (d.status ?? "").toLowerCase();
    const execStatus = (d.refund_execution_status ?? "").toLowerCase();
    if (execStatus === "pending_execution" || ACTIVE_DISPUTE_STATUSES.has(ds)) {
      // Active disputes AND pending-execution refund proposals stay frozen
      frozenDisputeOrders.add(d.order_id);
    } else if (
      ds === "resolved" &&
      (d.refund_amount_sen ?? 0) > 0 &&
      (execStatus === "" || execStatus === "executed")
    ) {
      refundByOrder.set(
        d.order_id,
        (refundByOrder.get(d.order_id) ?? 0) + (d.refund_amount_sen ?? 0)
      );
    }
  }

  let totalSalesSen = 0;
  let commissionTotalSen = 0;
  let pendingSettlementSen = 0;
  let frozenDisputeSen = 0;
  let completedNetSen = 0;
  let verifiedOrderCount = 0;

  // Prepare 7-day buckets ending at `now` (used for Weekly Sales chart)
  const dayBuckets = new Map<string, SalesChartPoint>();
  const chartDays = 7;
  for (let offset = chartDays - 1; offset >= 0; offset--) {
    const d = new Date(nowMs - offset * 24 * 60 * 60 * 1000);
    const key = toDayKey(d);
    dayBuckets.set(key, {
      isoDate: key,
      label: WEEKDAY_LABELS[d.getUTCDay()] ?? key.slice(5),
      amountSen: 0,
    });
  }

  const transactions: SellerTransactionItem[] = [];
  const seenOrderIds = new Set<string>();

  for (const order of input.orders) {
    // Prevent duplicated earnings if an order ever appears twice in input
    if (seenOrderIds.has(order.id)) continue;
    seenOrderIds.add(order.id);

    const statusLower = (order.status ?? "").toLowerCase();
    const payment = paymentByOrder.get(order.id);
    const paymentVerified = Boolean(
      order.paid_at ||
        (payment &&
          payment.status.toLowerCase() === "paid" &&
          payment.verified_at)
    );

    const refundedSen = refundByOrder.get(order.id) ?? 0;
    const grossSen = Math.max(0, (order.subtotal_sen ?? 0) - refundedSen);
    const netSen = Math.max(0, (order.seller_net_sen ?? 0) - refundedSen);
    const effectiveTs = order.paid_at ?? order.created_at;
    const effectiveMs = Date.parse(effectiveTs);

    const isVerifiedSale =
      paymentVerified && !EXCLUDED_CANCELLED_STATUSES.has(statusLower);
    const isFrozenDispute =
      statusLower === "disputed" || frozenDisputeOrders.has(order.id);

    if (isVerifiedSale) {
      // Range-scoped Total Sales
      if (cutoffMs === null || (!Number.isNaN(effectiveMs) && effectiveMs >= cutoffMs)) {
        totalSalesSen += grossSen;
        commissionTotalSen += order.commission_sen ?? 0;
        verifiedOrderCount += 1;
      }

      // All-time live settlement, frozen dispute, and payout balances
      if (isFrozenDispute) {
        frozenDisputeSen += netSen;
      } else if (IN_PROGRESS_SETTLEMENT_STATUSES.has(statusLower)) {
        pendingSettlementSen += netSen;
      } else if (COMPLETED_STATUSES.has(statusLower)) {
        completedNetSen += netSen;
      }

      // Weekly Sales Chart bucket
      if (!Number.isNaN(effectiveMs)) {
        const key = toDayKey(new Date(effectiveMs));
        const bucket = dayBuckets.get(key);
        if (bucket) {
          bucket.amountSen += grossSen;
        }
      }
    }

    const mapped = mapTransactionStatus(statusLower, paymentVerified);
    transactions.push({
      id: order.id,
      orderCode: order.order_code,
      itemTitle: itemTitleByOrder.get(order.id) ?? "Campus Order",
      amountSen: order.subtotal_sen ?? 0,
      statusLabel: mapped.label,
      statusTone: mapped.tone,
      timestamp: effectiveTs,
    });
  }

  let totalPaidOutSen = 0;
  let reservedOrPaidPayoutSen = 0;
  for (const pr of input.payoutRequests) {
    const s = (pr.status ?? "").toLowerCase();
    if (PAID_OUT_STATUSES.has(s)) {
      totalPaidOutSen += pr.amount_sen ?? 0;
    }
    if (ACTIVE_PAYOUT_DEDUCTION_STATUSES.has(s)) {
      reservedOrPaidPayoutSen += pr.amount_sen ?? 0;
    }
  }

  const availableForPayoutSen = Math.max(
    0,
    completedNetSen - reservedOrPaidPayoutSen
  );

  return {
    available: true,
    range: input.range,
    totalSalesSen,
    pendingSettlementSen,
    frozenDisputeSen,
    availableForPayoutSen,
    totalPaidOutSen,
    commissionTotalSen,
    verifiedOrderCount,
    transactions: transactions.slice(0, 6),
    chartPoints: Array.from(dayBuckets.values()),
  };
}
