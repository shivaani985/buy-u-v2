/**
 * Single authoritative Phase 6D financial & 3-day (72-hour) buyer protection policy.
 * All financial calculations use exact integer sen.
 */
export const BUYER_PROTECTION_HOURS = 72;
export const BUYER_PROTECTION_MS = BUYER_PROTECTION_HOURS * 60 * 60 * 1000;
export const MIN_WITHDRAWAL_SEN = 200; // RM 2.00
export const WITHDRAWAL_FEE_SEN = 0; // RM 0.00 simulated withdrawal fee
export const COMMISSION_RATE = 0.02; // 2% of eligible product subtotal

export function getProtectionExpiresAt(
  completedAt: string | null | undefined
): string | null {
  if (!completedAt) return null;
  const ms = Date.parse(completedAt);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + BUYER_PROTECTION_MS).toISOString();
}

/**
 * Exact boundary: buyer post-completion dispute is eligible strictly when
 * `nowMs < completed_at + 72 hours`.
 */
export function isWithinBuyerProtectionWindow(
  completedAt: string | null | undefined,
  nowMs: number = Date.now()
): boolean {
  if (!completedAt) return false;
  const ms = Date.parse(completedAt);
  if (Number.isNaN(ms)) return false;
  return nowMs < ms + BUYER_PROTECTION_MS;
}

/**
 * Exact boundary: undisputed completed earnings become withdrawable at
 * `nowMs >= completed_at + 72 hours`.
 */
export function isEligibleForWithdrawalRelease(
  completedAt: string | null | undefined,
  nowMs: number = Date.now()
): boolean {
  if (!completedAt) return false;
  const ms = Date.parse(completedAt);
  if (Number.isNaN(ms)) return false;
  return nowMs >= ms + BUYER_PROTECTION_MS;
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
