/**
 * ToyyibPay Sandbox Integration Contracts (Phase 6A — NO LIVE HTTP CALLS).
 *
 * Security invariants:
 * 1. NEVER mark an order Paid based solely on a browser redirect (`returnUrl`).
 * 2. ALWAYS verify payment server-side via ToyyibPay `getBillTransactions`
 *    comparing exact `billCode`, `billExternalReferenceNo === order_code`,
 *    `billpaymentStatus === "1"`, and exact integer-sen `amountSen === totalPaidSen`.
 * 3. If a verified payment arrives AFTER an order expired and stock was released,
 *    NEVER oversell or deduct stock — route to `late_payment_review` for refund.
 */

export const TOYYIBPAY_SANDBOX_BASE_URL = "https://dev.toyyibpay.com";

export interface ToyyibPayCreateBillRequest {
  userSecretKey: string;
  categoryCode: string;
  billName: string;
  billDescription: string;
  billPriceSetting: 1;
  billPayorInfo: 1;
  /** Integer sen (e.g., 1600 = RM 16.00). */
  billAmount: number;
  billReturnUrl: string;
  billCallbackUrl: string;
  /** Must match `orders.order_code` (e.g. "BU-2611-0DB3"). */
  billExternalReferenceNo: string;
  billTo: string;
  billEmail: string;
  billPhone: string;
  /**
   * Official ToyyibPay API:
   * - 0 = charge FPX fee to customer ON TOP of billAmount (WOULD DOUBLE-CHARGE!)
   * - 1 = charge FPX fee to bill owner ("chargeOn": "Amount"), matching hosted
   *       #BU-2611-0DB3 where billAmount = total_paid_sen (subtotal + RM 1.00)
   *       and buyer pays exactly total_paid_sen once.
   */
  billChargeToCustomer: 1;
  /** ToyyibPay format: "DD-MM-YYYY HH:mm:ss" (MYT / UTC+8). */
  billExpiryDate: string;
}

export function formatToyyibPayExpiryMyt(deadlineIso: string): string {
  const date = new Date(deadlineIso);
  if (Number.isNaN(date.getTime())) return "";
  // Shift to Asia/Kuala_Lumpur (UTC+8) deterministically without locale drift
  const myt = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const dd = String(myt.getUTCDate()).padStart(2, "0");
  const mm = String(myt.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = String(myt.getUTCFullYear());
  const hh = String(myt.getUTCHours()).padStart(2, "0");
  const min = String(myt.getUTCMinutes()).padStart(2, "0");
  const sec = String(myt.getUTCSeconds()).padStart(2, "0");
  return `${dd}-${mm}-${yyyy} ${hh}:${min}:${sec}`;
}

export function buildToyyibPayCreateBillPayload(input: {
  secretKey: string;
  categoryCode: string;
  orderCode: string;
  itemCount: number;
  subtotalSen: number;
  fpxFeeSen: number;
  totalPaidSen: number;
  buyerName: string;
  buyerEmail: string;
  buyerPhone?: string | null;
  returnUrl: string;
  callbackUrl: string;
  paymentDeadlineIso: string;
}): ToyyibPayCreateBillRequest {
  const expectedTotal = Math.floor(input.subtotalSen) + Math.floor(input.fpxFeeSen);
  if (Math.floor(input.totalPaidSen) !== expectedTotal) {
    throw new Error(
      `Total payable (${input.totalPaidSen}) must equal subtotal (${input.subtotalSen}) + FPX fee (${input.fpxFeeSen}).`
    );
  }

  const safeName = `Buy-U ${input.orderCode}`.slice(0, 30);
  const safeDesc =
    `Buy-U Order ${input.orderCode} (${input.itemCount} ${input.itemCount === 1 ? "item" : "items"})`.slice(
      0,
      100
    );

  return {
    userSecretKey: input.secretKey,
    categoryCode: input.categoryCode,
    billName: safeName,
    billDescription: safeDesc,
    billPriceSetting: 1,
    billPayorInfo: 1,
    billAmount: Math.max(0, Math.floor(input.totalPaidSen)),
    billReturnUrl: input.returnUrl,
    billCallbackUrl: input.callbackUrl,
    billExternalReferenceNo: input.orderCode,
    billTo: input.buyerName.trim().slice(0, 80) || "UMS Member",
    billEmail: input.buyerEmail.trim(),
    billPhone: (input.buyerPhone ?? "").trim() || "0100000000",
    // Charge FPX to bill owner ("Amount") since billAmount already includes fpxFeeSen.
    billChargeToCustomer: 1,
    billExpiryDate: formatToyyibPayExpiryMyt(input.paymentDeadlineIso),
  };
}

export interface ToyyibPayWebhookEnvelope {
  billCode: string;
  orderCode: string;
  status: string;
  refNo: string;
}

/**
 * Validates incoming unauthenticated ToyyibPay webhook POST fields before
 * performing an authoritative server-to-server `getBillTransactions` lookup.
 * Raw webhook fields are NEVER trusted to mark an order Paid directly.
 */
export function parseToyyibPayWebhookEnvelope(
  raw: Record<string, unknown>
): ToyyibPayWebhookEnvelope | null {
  const billCode = String(raw.billcode ?? "").trim();
  const orderCode = String(raw.order_id ?? "").trim();
  const status = String(raw.status ?? "").trim();
  const refNo = String(raw.refno ?? "").trim();
  if (!billCode || !orderCode || !status) return null;
  return { billCode, orderCode, status, refNo };
}

export interface ToyyibPayTransactionRecord {
  billCode: string;
  billExternalReferenceNo: string;
  /** "1" = Paid, "2" = Pending, "3" = Failed. */
  billpaymentStatus: string;
  /** Decimal MYR string from ToyyibPay, e.g. "16.00". */
  billpaymentAmount: string;
  billpaymentInvoiceNo: string;
}

export function parseToyyibPayAmountToSen(rawAmount: string): number | null {
  const trimmed = (rawAmount ?? "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [wholeStr, fracStr = ""] = trimmed.split(".");
  const whole = Number.parseInt(wholeStr ?? "0", 10);
  const frac = Number.parseInt(fracStr.padEnd(2, "0"), 10);
  if (!Number.isSafeInteger(whole) || !Number.isSafeInteger(frac)) return null;
  return whole * 100 + frac;
}

export type PaymentVerificationDecision =
  | { action: "await_verification"; reason: string }
  | { action: "confirm_paid"; transactionRef: string; amountSen: number }
  | { action: "idempotent_already_paid"; transactionRef: string }
  | { action: "mark_failed"; reason: string }
  | { action: "late_payment_reconciliation"; transactionRef: string; amountSen: number; reason: string }
  | { action: "reject"; reason: string };

/**
 * Pure server-side payment verification decision matrix.
 * Strictly blocks trusting browser redirects, enforces exact amount/order/bill
 * matching, handles idempotent retries, and routes expired-order late payments
 * to manual refund reconciliation without overselling.
 */
export function evaluateToyyibPayVerification(input: {
  source:
    | "browser_redirect"
    | "raw_webhook"
    | "verified_server_transaction";
  order: {
    orderCode: string;
    status: string;
    totalPaidSen: number;
    paymentDeadlineIso: string | null;
    paidAt: string | null;
    existingTransactionRef?: string | null;
  };
  expectedBillCode: string;
  transaction?: ToyyibPayTransactionRecord | null;
  nowMs?: number;
}): PaymentVerificationDecision {
  // Rule 1: NEVER mark Paid from browser redirect or unverified raw webhook POST
  if (
    input.source === "browser_redirect" ||
    input.source === "raw_webhook"
  ) {
    return {
      action: "await_verification",
      reason:
        "Unverified redirect or raw webhook cannot confirm payment. Must verify via server-to-server ToyyibPay getBillTransactions.",
    };
  }

  const tx = input.transaction;
  if (!tx) {
    return { action: "reject", reason: "Missing verified ToyyibPay transaction." };
  }

  if (
    tx.billCode.trim() !== input.expectedBillCode.trim() ||
    tx.billExternalReferenceNo.trim() !== input.order.orderCode.trim()
  ) {
    return {
      action: "reject",
      reason: "Bill code or order reference does not match.",
    };
  }

  // Status "2" = still pending at bank
  if (tx.billpaymentStatus === "2") {
    return {
      action: "await_verification",
      reason: "FPX transaction is still pending bank confirmation.",
    };
  }

  // Status "3" = failed
  if (tx.billpaymentStatus === "3") {
    return {
      action: "mark_failed",
      reason: "FPX payment failed or was cancelled at the bank.",
    };
  }

  if (tx.billpaymentStatus !== "1") {
    return {
      action: "reject",
      reason: `Unsupported ToyyibPay status "${tx.billpaymentStatus}".`,
    };
  }

  const paidSen = parseToyyibPayAmountToSen(tx.billpaymentAmount);
  if (paidSen === null || paidSen !== input.order.totalPaidSen) {
    return {
      action: "reject",
      reason: `Paid amount mismatch (expected ${input.order.totalPaidSen} sen, got ${paidSen ?? "invalid"}).`,
    };
  }

  const txRef = tx.billpaymentInvoiceNo.trim();
  if (!txRef) {
    return { action: "reject", reason: "Missing ToyyibPay transaction reference." };
  }

  // Idempotent repeat callback on already-paid order (must match original transaction_ref)
  if (
    input.order.paidAt !== null ||
    ["paid", "ready_for_pickup", "handed_over", "completed"].includes(
      input.order.status
    )
  ) {
    if (
      input.order.existingTransactionRef &&
      input.order.existingTransactionRef.trim() !== txRef
    ) {
      return {
        action: "reject",
        reason: `Transaction reference conflict on already-paid order (existing ${input.order.existingTransactionRef}, got ${txRef}).`,
      };
    }
    return { action: "idempotent_already_paid", transactionRef: txRef };
  }

  // Late-payment reconciliation: order already expired/cancelled and stock released
  const nowMs = input.nowMs ?? Date.now();
  const deadlineMs = input.order.paymentDeadlineIso
    ? new Date(input.order.paymentDeadlineIso).getTime()
    : null;
  const pastDeadline =
    deadlineMs !== null && !Number.isNaN(deadlineMs) && nowMs >= deadlineMs;

  if (
    input.order.status === "expired" ||
    input.order.status === "cancelled" ||
    pastDeadline
  ) {
    return {
      action: "late_payment_reconciliation",
      transactionRef: txRef,
      amountSen: paidSen,
      reason:
        "Verified payment arrived after order expiry/stock release. Logged for admin refund reconciliation; stock not oversold.",
    };
  }

  if (input.order.status !== "pending_payment") {
    return {
      action: "reject",
      reason: `Order in status "${input.order.status}" cannot be marked paid.`,
    };
  }

  return {
    action: "confirm_paid",
    transactionRef: txRef,
    amountSen: paidSen,
  };
}
