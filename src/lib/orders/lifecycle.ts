export interface OrderStatusBadge {
  label: string;
  toneClass: string;
}

export interface OrderTimelineStep {
  key: "placed" | "paid" | "in_progress" | "completed";
  label: string;
  done: boolean;
  active: boolean;
  timestamp: string | null;
}

export const ORDER_STATUS_TABS = [
  { key: "all", label: "All" },
  { key: "to-pay", label: "To Pay" },
  { key: "in-progress", label: "In Progress" },
  { key: "completed", label: "Completed" },
  { key: "refund-dispute", label: "Refund & Dispute" },
  { key: "cancelled", label: "Cancelled" },
] as const;

export type OrderTab = (typeof ORDER_STATUS_TABS)[number]["key"];
export type OrderTypeFilter = "all" | "products" | "services";

export const LATE_PAYMENT_GUIDANCE =
  "Your payment requires further verification. Please do not make another payment while your transaction is under review.";

export function getOrderPresentation(input: {
  status: string;
  paymentStatus?: string | null;
  paymentDeadline?: string | null;
  hasFinancialIssue?: boolean;
  refundStatus?: string | null;
  isService?: boolean;
}, now: number) {
  const { paymentStatus, paymentDeadline, hasFinancialIssue, refundStatus, isService } = input;
  let status = input.status;
  if (status === "pending_payment" && paymentDeadline && Date.parse(paymentDeadline) <= now) {
    status = "expired";
  }
  const tab: Exclude<OrderTab, "all"> =
    paymentStatus === "late_payment_review" || hasFinancialIssue || isBlockingRefundStatus(refundStatus) || status === "disputed" || status === "refunded"
      ? "refund-dispute"
      : status === "pending_payment" ? "to-pay"
      : status === "paid" || status === "handed_over" ? "in-progress"
      : status === "completed" ? "completed"
      : "cancelled";
  const badge = getOrderStatusBadge(status, paymentStatus, isService);
  if (paymentStatus !== "late_payment_review" && status !== "refunded" && tab === "refund-dispute") {
    if (isBlockingRefundStatus(refundStatus)) {
      badge.label = refundStatus === "awaiting_return" ? "Refund awaiting return"
        : refundStatus === "failed" || refundStatus === "reconciliation_required" ? "Refund under review"
        : "Refund pending";
      badge.toneClass = "bg-amber-50 text-amber-900 border-amber-200";
    } else if (hasFinancialIssue) {
      badge.label = "Disputed";
    }
  }
  return { status, tab, badge };
}

export function isBlockingRefundStatus(status?: string | null) {
  return ["pending_execution", "awaiting_return", "processing", "failed", "reconciliation_required"].includes(status ?? "");
}

export function normalizePickupPinInput(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, 6);
}

export function isValidPickupPinFormat(pin: string): boolean {
  return /^\d{6}$/.test(pin.trim());
}

export function getOrderStatusBadge(
  status: string,
  paymentStatus?: string | null,
  isService = false
): OrderStatusBadge {
  if (paymentStatus === "late_payment_review") {
    return {
      label: "Payment under review",
      toneClass: "bg-[#FEF3E6] text-[#B54708] border-[#F6D6B0]",
    };
  }
  switch (status.toLowerCase()) {
    case "completed":
      return {
        label: "Completed",
        toneClass: "bg-[#ECFDF3] text-[#027A48] border-[#ABEFC6]",
      };
    case "handed_over":
      return {
        label: "Awaiting Receipt Confirmation",
        toneClass: "bg-[#F3EEFA] text-[#4E2A84] border-[#DCD0F0]",
      };
    case "paid":
      return {
        label: isService ? "Awaiting Service" : "Awaiting Collection",
        toneClass: "bg-[#E6F6F6] text-[#008285] border-[#B8E3E4]",
      };
    case "pending_payment":
      return {
        label: "Awaiting Payment",
        toneClass: "bg-[#F3EEFA] text-[#4E2A84] border-[#DCD0F0]",
      };
    case "expired":
      return {
        label: "Payment Expired",
        toneClass: "bg-[#F6F5F9] text-[#6B6779] border-[#E6E3EE]",
      };
    case "disputed":
      return {
        label: "Disputed",
        toneClass: "bg-[#FEF2F2] text-[#B42318] border-[#F9C6C2]",
      };
    case "refunded":
      return {
        label: "Refunded",
        toneClass: "bg-[#F6F5F9] text-[#6B6779] border-[#E6E3EE]",
      };
    case "cancelled":
    case "canceled":
      return {
        label: "Cancelled",
        toneClass: "bg-[#F6F5F9] text-[#6B6779] border-[#E6E3EE]",
      };
    default:
      return {
        label: status.replace(/_/g, " "),
        toneClass: "bg-[#F6F5F9] text-[#6B6779] border-[#E6E3EE]",
      };
  }
}

export interface OrderTimelineSnapshot {
  status: string;
  createdAt: string;
  paidAt: string | null;
  completedAt: string | null;
  paymentDeadline: string | null;
}

export function getOrderTimelineSteps(
  snapshot: OrderTimelineSnapshot,
  snapshotAt: number,
  paymentStatus?: string | null,
): OrderTimelineStep[] {
  const { status, createdAt, paidAt, completedAt, paymentDeadline } = snapshot;
  const reviewing = paymentStatus === "late_payment_review";
  const awaitingPayment = status === "pending_payment"
    && (!paymentDeadline || Date.parse(paymentDeadline) > snapshotAt);
  const paid = Boolean(paidAt);
  const completed = Boolean(completedAt);
  return [
    { key: "placed", label: "Placed", done: true, active: !reviewing && awaitingPayment, timestamp: createdAt },
    { key: "paid", label: "Paid", done: paid, active: false, timestamp: paidAt },
    { key: "in_progress", label: "In Progress", done: paid, active: !reviewing && (status === "paid" || status === "handed_over"), timestamp: paidAt },
    { key: "completed", label: "Completed", done: completed, active: !reviewing && status === "completed", timestamp: completedAt },
  ];
}
