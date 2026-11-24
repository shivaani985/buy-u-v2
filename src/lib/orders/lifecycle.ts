export type SellerOrderFilterKey =
  | "all"
  | "awaiting_payment"
  | "awaiting_handover"
  | "awaiting_receipt"
  | "completed"
  | "disputed_refunded";

export interface OrderStatusBadge {
  label: string;
  toneClass: string;
}

export interface OrderTimelineStep {
  key: "placed" | "paid" | "handed_over" | "completed";
  label: string;
  done: boolean;
  active: boolean;
  timestamp: string | null;
}

export const SELLER_ORDER_FILTER_TABS: Array<{
  key: SellerOrderFilterKey;
  label: string;
}> = [
  { key: "all", label: "All Orders" },
  { key: "awaiting_payment", label: "Awaiting Payment" },
  { key: "awaiting_handover", label: "Awaiting Handover" },
  { key: "awaiting_receipt", label: "Awaiting Receipt Confirmation" },
  { key: "completed", label: "Completed" },
  { key: "disputed_refunded", label: "Disputed / Refunded" },
];

export function normalizePickupPinInput(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, 6);
}

export function isValidPickupPinFormat(pin: string): boolean {
  return /^\d{6}$/.test(pin.trim());
}

export function getOrderStatusBadge(
  status: string,
  paymentStatus?: string | null
): OrderStatusBadge {
  if (paymentStatus === "late_payment_review") {
    return {
      label: "Late Payment · Refund Review",
      toneClass: "bg-[#FEF3E6] text-[#B54708] border-[#F6D6B0]",
    };
  }
  switch (status.toLowerCase()) {
    case "completed":
      return {
        label: "Completed",
        toneClass: "bg-[#E6F6F6] text-[#006A6D] border-[#B8E3E4]",
      };
    case "handed_over":
      return {
        label: "Awaiting Receipt Confirmation",
        toneClass: "bg-[#F3EEFA] text-[#4E2A84] border-[#DCD0F0]",
      };
    case "paid":
      return {
        label: "Paid — Awaiting Handover",
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

export function getOrderTimelineSteps(input: {
  status: string;
  createdAt: string;
  paidAt: string | null;
  handedOverAt: string | null;
  completedAt: string | null;
}): OrderTimelineStep[] {
  const s = input.status.toLowerCase();
  const isCompleted = s === "completed";
  const isHandedOver = isCompleted || s === "handed_over";
  const isPaid =
    isHandedOver ||
    s === "paid" ||
    s === "disputed" ||
    Boolean(input.paidAt);

  return [
    {
      key: "placed",
      label: "Placed",
      done: true,
      active: s === "pending_payment",
      timestamp: input.createdAt,
    },
    {
      key: "paid",
      label: "Paid",
      done: isPaid,
      active: s === "paid",
      timestamp: input.paidAt,
    },
    {
      key: "handed_over",
      label: "Handed Over",
      done: isHandedOver,
      active: s === "handed_over",
      timestamp: input.handedOverAt,
    },
    {
      key: "completed",
      label: "Completed",
      done: isCompleted,
      active: isCompleted,
      timestamp: input.completedAt,
    },
  ];
}

export function matchesSellerOrderFilter(
  status: string,
  filter: SellerOrderFilterKey
): boolean {
  const s = status.toLowerCase();
  switch (filter) {
    case "all":
      return true;
    case "awaiting_payment":
      return s === "pending_payment";
    case "awaiting_handover":
      return s === "paid";
    case "awaiting_receipt":
      return s === "handed_over";
    case "completed":
      return s === "completed";
    case "disputed_refunded":
      return s === "disputed" || s === "refunded";
  }
}

export function matchesSellerOrderSearch(
  order: {
    orderCode: string;
    buyerName: string;
    collectionAreaName: string;
    items: Array<{ title: string }>;
  },
  rawQuery: string
): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return true;
  if (order.orderCode.toLowerCase().includes(q)) return true;
  if (order.buyerName.toLowerCase().includes(q)) return true;
  if (order.collectionAreaName.toLowerCase().includes(q)) return true;
  return order.items.some((item) => item.title.toLowerCase().includes(q));
}

export function getSellerEarningsLedgerState(
  status: string,
  hasActiveDispute = false
): {
  state: "pending_settlement" | "available_for_payout" | "frozen" | "none";
  label: string;
} {
  const s = status.toLowerCase();
  if (s === "disputed" || hasActiveDispute) {
    return { state: "frozen", label: "Frozen (Dispute)" };
  }
  if (s === "completed") {
    return { state: "available_for_payout", label: "Available for Payout" };
  }
  if (s === "paid" || s === "handed_over") {
    return { state: "pending_settlement", label: "Pending Settlement" };
  }
  return { state: "none", label: "Not Settled" };
}
