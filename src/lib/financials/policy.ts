/**
 * Single authoritative Phase 6D financial & 3-day (72-hour) buyer protection policy.
 * All financial calculations use exact integer sen.
 */
export const BUYER_PROTECTION_HOURS = 72;
export const BUYER_PROTECTION_MS = BUYER_PROTECTION_HOURS * 60 * 60 * 1000;
export const LEGACY_BUYER_PROTECTION_HOURS = 168; // 7 days (preserved for historical pre-6D completions)
export const MIN_WITHDRAWAL_SEN = 200; // RM 2.00
export const WITHDRAWAL_FEE_SEN = 0; // RM 0.00 simulated withdrawal fee
export const COMMISSION_RATE = 0.02; // 2% of eligible product subtotal

export function getProtectionExpiresAt(
  completedAt: string | null | undefined,
  explicitProtectionExpiresAt?: string | null
): string | null {
  if (explicitProtectionExpiresAt) {
    const expMs = Date.parse(explicitProtectionExpiresAt);
    if (!Number.isNaN(expMs)) return new Date(expMs).toISOString();
  }
  if (!completedAt) return null;
  const ms = Date.parse(completedAt);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + BUYER_PROTECTION_MS).toISOString();
}

/**
 * Exact boundary: buyer post-completion dispute is eligible strictly when
 * `nowMs < protection_expires_at` (falling back to `completed_at + 72 hours`).
 */
export function isWithinBuyerProtectionWindow(
  completedAt: string | null | undefined,
  nowMs: number = Date.now(),
  explicitProtectionExpiresAt?: string | null
): boolean {
  const expIso = getProtectionExpiresAt(completedAt, explicitProtectionExpiresAt);
  if (!expIso) return false;
  return nowMs < Date.parse(expIso);
}

/**
 * Exact boundary: undisputed completed earnings become withdrawable at
 * `nowMs >= protection_expires_at` (falling back to `completed_at + 72 hours`).
 */
export function isEligibleForWithdrawalRelease(
  completedAt: string | null | undefined,
  nowMs: number = Date.now(),
  explicitProtectionExpiresAt?: string | null
): boolean {
  const expIso = getProtectionExpiresAt(completedAt, explicitProtectionExpiresAt);
  if (!expIso) return false;
  return nowMs >= Date.parse(expIso);
}

/**
 * Authoritative payment proof helper (P0.6):
 * Requires BOTH `order.paid_at` AND either:
 *   - Unified parent `checkout_sessions` verified paid (`status='paid'`, `payment_status='paid'`, `paid_at`), OR
 *   - Legacy `payments` row verified paid (`status='paid'`, `verified_at`).
 * Never relies on `orders.paid_at` alone.
 */
export function isAuthoritativeOrderPaymentVerified(input: {
  order: {
    id: string;
    buyer_id?: string | null;
    checkout_session_id?: string | null;
    paid_at: string | null;
  };
  checkoutSession?: {
    id: string;
    buyer_id?: string | null;
    status: string;
    payment_status: string;
    paid_at: string | null;
  } | null;
  legacyPayment?: {
    order_id: string;
    status: string;
    verified_at: string | null;
  } | null;
}): boolean {
  if (!input.order.paid_at) return false;
  if (input.order.checkout_session_id) {
    const cs = input.checkoutSession;
    if (!cs || cs.id !== input.order.checkout_session_id) return false;
    if (
      input.order.buyer_id &&
      cs.buyer_id &&
      cs.buyer_id !== input.order.buyer_id
    ) {
      return false;
    }
    return (
      cs.status.toLowerCase() === "paid" &&
      cs.payment_status.toLowerCase() === "paid" &&
      Boolean(cs.paid_at)
    );
  }
  const p = input.legacyPayment;
  return Boolean(
    p &&
      p.order_id === input.order.id &&
      p.status.toLowerCase() === "paid" &&
      p.verified_at
  );
}

export interface RefundBreakdown {
  originalSubtotalSen: number;
  originalCommissionSen: number;
  originalSellerNetSen: number;
  refundAmountSen: number;
  retainedSubtotalSen: number;
  adjustedCommissionSen: number;
  adjustedSellerNetSen: number;
  commissionReversalSen: number;
  sellerDeductionSen: number;
}

/**
 * Computes exact integer-sen refund accounting preserving the invariant:
 *   refundAmountSen === commissionReversalSen + sellerDeductionSen
 * Original RM 1.00 FPX fee is excluded under FYP demo refund policy.
 */
export function calculateRefundBreakdown(input: {
  subtotalSen: number;
  originalCommissionSen: number;
  refundAmountSen: number;
}): RefundBreakdown {
  const originalSubtotalSen = Math.max(0, Math.round(input.subtotalSen));
  const originalCommissionSen = Math.max(
    0,
    Math.round(input.originalCommissionSen)
  );
  const originalSellerNetSen = Math.max(
    0,
    originalSubtotalSen - originalCommissionSen
  );
  const refundAmountSen = Math.max(
    0,
    Math.min(originalSubtotalSen, Math.round(input.refundAmountSen))
  );

  const retainedSubtotalSen = originalSubtotalSen - refundAmountSen;
  const adjustedCommissionSen = Math.round(
    retainedSubtotalSen * COMMISSION_RATE
  );
  const commissionReversalSen = Math.max(
    0,
    originalCommissionSen - adjustedCommissionSen
  );
  const sellerDeductionSen = refundAmountSen - commissionReversalSen;
  const adjustedSellerNetSen = Math.max(
    0,
    originalSellerNetSen - sellerDeductionSen
  );

  return {
    originalSubtotalSen,
    originalCommissionSen,
    originalSellerNetSen,
    refundAmountSen,
    retainedSubtotalSen,
    adjustedCommissionSen,
    adjustedSellerNetSen,
    commissionReversalSen,
    sellerDeductionSen,
  };
}

export function formatMytDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return (
    new Intl.DateTimeFormat("en-MY", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "Asia/Kuala_Lumpur",
    }).format(d) + " MYT"
  );
}
