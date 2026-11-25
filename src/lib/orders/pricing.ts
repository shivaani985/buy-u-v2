import type { CheckoutPreparationSummary } from "../buyer/checkout";
import type { BuyerEligibilityResult } from "../buyer/validation";
import type { OfferCardItem } from "../messages/offers";

function isOfferCheckoutListingEligible(
  kind: string,
  isFood?: boolean | null,
  availabilityMode?: string | null
): boolean {
  const k = kind.trim().toLowerCase();
  if (k !== "pre_loved" && k !== "business") return false;
  if (Boolean(isFood)) return false;
  if ((availabilityMode ?? "").trim().toLowerCase() === "pre_order") {
    return false;
  }
  return true;
}

const MIN_OFFER_SEN = 200;
const OFFER_RESERVATION_TTL_MS = 30 * 60 * 1000;

/** Verified from hosted `orders`: 2% platform commission on item subtotal. */
export const PLATFORM_COMMISSION_RATE = 0.02;

/** Verified from hosted `orders.fpx_fee_sen` default & ToyyibPay `transactionCharge`. */
export const TOYYIBPAY_FPX_FEE_SEN = 100; // RM 1.00 per ToyyibPay FPX bill

/** Verified from hosted `orders` sample (`19:38:25` -> `19:53:25`): 15m cart payment window. */
export const CART_PAYMENT_DEADLINE_MS = 15 * 60 * 1000;

export interface OrderFinancialBreakdown {
  subtotalSen: number;
  fpxFeeSen: number;
  totalPaidSen: number;
  commissionSen: number;
  sellerNetSen: number;
}

/**
 * Exact integer-sen order financials:
 * - commissionSen = Math.round(subtotalSen * 0.02) (2%)
 * - sellerNetSen  = subtotalSen - commissionSen
 * - totalPaidSen  = subtotalSen + fpxFeeSen
 */
export function calculateOrderFinancials(
  subtotalSen: number,
  fpxFeeSen = TOYYIBPAY_FPX_FEE_SEN
): OrderFinancialBreakdown {
  const safeSubtotal =
    Number.isFinite(subtotalSen) && subtotalSen > 0
      ? Math.floor(subtotalSen)
      : 0;
  const safeFpx =
    safeSubtotal > 0 && Number.isFinite(fpxFeeSen) && fpxFeeSen >= 0
      ? Math.floor(fpxFeeSen)
      : 0;
  const commissionSen = Math.round(safeSubtotal * PLATFORM_COMMISSION_RATE);
  const sellerNetSen = Math.max(0, safeSubtotal - commissionSen);
  const totalPaidSen = safeSubtotal + safeFpx;

  return {
    subtotalSen: safeSubtotal,
    fpxFeeSen: safeFpx,
    totalPaidSen,
    commissionSen,
    sellerNetSen,
  };
}

export interface PreparedSellerOrderPlan {
  source: "cart" | "offer";
  sellerId: string;
  sellerName: string;
  collectionAreaName: string;
  itemCount: number;
  financials: OrderFinancialBreakdown;
  paymentWindowLabel: string;
  paymentDeadlineIso: string | null;
}

export interface CartOrderPreparationResult {
  ok: boolean;
  orders: PreparedSellerOrderPlan[];
  combinedSubtotalSen: number;
  combinedFpxFeeSen: number;
  combinedTotalPayableSen: number;
  blockingReasons: string[];
}

/**
 * Prepares per-seller order plans from a validated Phase 4C cart checkout summary.
 * Phase 6B.4 Unified Checkout: ONE RM 1.00 FPX fee per checkout (regardless of seller
 * count); each seller receives an independent internal order with 2% commission and
 * `fpxFeeSen = 0` so per-seller refunds never duplicate the checkout FPX fee.
 */
export function prepareCartOrderPlans(
  eligibility: BuyerEligibilityResult,
  checkout: CheckoutPreparationSummary
): CartOrderPreparationResult {
  if (!eligibility.eligible || !eligibility.userId) {
    return {
      ok: false,
      orders: [],
      combinedSubtotalSen: 0,
      combinedFpxFeeSen: 0,
      combinedTotalPayableSen: 0,
      blockingReasons: [
        eligibility.reason || "Sign in with a verified UMS account to checkout.",
      ],
    };
  }

  if (!checkout.canProceedToPayment || checkout.sellerOrders.length === 0) {
    return {
      ok: false,
      orders: [],
      combinedSubtotalSen: checkout.itemsSubtotalSen,
      combinedFpxFeeSen: 0,
      combinedTotalPayableSen: checkout.itemsSubtotalSen,
      blockingReasons:
        checkout.blockingReasons.length > 0
          ? checkout.blockingReasons
          : ["Cart is not ready for order creation."],
    };
  }

  const orders: PreparedSellerOrderPlan[] = checkout.sellerOrders.map((so) => {
    const financials = calculateOrderFinancials(so.subtotalSen, 0);
    return {
      source: "cart",
      sellerId: so.sellerId,
      sellerName: so.sellerName,
      collectionAreaName: so.collectionAreas.join(", ") || "UMSKAL Campus",
      itemCount: so.validQuantity,
      financials,
      paymentWindowLabel: "15 minutes after checkout creation",
      paymentDeadlineIso: null,
    };
  });

  const combinedSubtotalSen = orders.reduce(
    (sum, o) => sum + o.financials.subtotalSen,
    0
  );
  const combinedFpxFeeSen =
    combinedSubtotalSen > 0 ? TOYYIBPAY_FPX_FEE_SEN : 0;

  return {
    ok: true,
    orders,
    combinedSubtotalSen,
    combinedFpxFeeSen,
    combinedTotalPayableSen: combinedSubtotalSen + combinedFpxFeeSen,
    blockingReasons: [],
  };
}

export interface OfferCheckoutValidationInput {
  eligibility: BuyerEligibilityResult;
  offer: OfferCardItem;
  listingSellerId: string;
  listingStatus: string;
  listingKind: string;
  listingIsFood?: boolean | null;
  listingAvailabilityMode?: string | null;
  listingTitle: string;
  listingPriceSen: number;
  collectionAreaName: string;
  sellerName: string;
  isBlocked: boolean;
  linkedOrderStatus?: string | null;
  linkedOrderPaymentDeadline?: string | null;
  nowMs?: number;
}

export type OfferCheckoutPlanResult =
  | {
      ok: true;
      orderPlan: PreparedSellerOrderPlan;
      lockedOfferPriceSen: number;
      reservationExpiresAt: string;
    }
  | {
      ok: false;
      error: string;
    };

/**
 * Validates and prepares checkout for an accepted bargaining offer:
 * - Strictly enforces buyer ownership, non-self-purchase, active listing,
 *   locked negotiated price (RM 2.00..listingPrice), and strict 30m hold deadline.
 */
export function prepareOfferOrderPlan(
  input: OfferCheckoutValidationInput
): OfferCheckoutPlanResult {
  const nowMs = input.nowMs ?? Date.now();

  if (!input.eligibility.eligible || !input.eligibility.userId) {
    return {
      ok: false,
      error:
        input.eligibility.reason ||
        "Sign in with your UMS account to review this offer.",
    };
  }

  const buyerId = input.eligibility.userId.toLowerCase();
  if (input.offer.buyerId.toLowerCase() !== buyerId) {
    return {
      ok: false,
      error: "Only the buyer who submitted this offer can check out.",
    };
  }

  if (input.offer.sellerId.toLowerCase() === buyerId) {
    return { ok: false, error: "You cannot purchase your own listing." };
  }

  if (
    input.listingSellerId.toLowerCase() !== input.offer.sellerId.toLowerCase()
  ) {
    return {
      ok: false,
      error: "Listing owner does not match this offer.",
    };
  }

  if (input.isBlocked) {
    return {
      ok: false,
      error: "Checkout is unavailable because one participant has blocked the other.",
    };
  }

  if (
    input.listingStatus !== "published" ||
    !isOfferCheckoutListingEligible(
      input.listingKind,
      input.listingIsFood,
      input.listingAvailabilityMode
    )
  ) {
    return {
      ok: false,
      error: "This listing is no longer eligible for offer checkout.",
    };
  }

  if (
    input.offer.offerPriceSen < MIN_OFFER_SEN ||
    input.offer.offerPriceSen > input.listingPriceSen
  ) {
    return {
      ok: false,
      error: "Negotiated offer price is out of valid range.",
    };
  }

  if (input.offer.status !== "accepted") {
    return { ok: false, error: "Offer is not in an accepted state." };
  }

  if (input.offer.reservationReleasedAt) {
    return {
      ok: false,
      error: "This offer's 30-minute reservation has already been released.",
    };
  }

  const reservationExpiresAt =
    input.offer.reservationExpiresAt &&
    !Number.isNaN(new Date(input.offer.reservationExpiresAt).getTime())
      ? input.offer.reservationExpiresAt
      : input.offer.respondedAt &&
          !Number.isNaN(new Date(input.offer.respondedAt).getTime())
        ? new Date(
            new Date(input.offer.respondedAt).getTime() +
              OFFER_RESERVATION_TTL_MS
          ).toISOString()
        : null;

  if (!reservationExpiresAt || nowMs >= new Date(reservationExpiresAt).getTime()) {
    return {
      ok: false,
      error: "This offer's 30-minute reservation hold has expired.",
    };
  }

  if (input.linkedOrderStatus && input.linkedOrderStatus !== "pending_payment") {
    return {
      ok: false,
      error: `Linked order is ${input.linkedOrderStatus} and cannot be paid.`,
    };
  }

  if (input.linkedOrderPaymentDeadline) {
    const deadlineMs = new Date(input.linkedOrderPaymentDeadline).getTime();
    if (!Number.isNaN(deadlineMs) && nowMs >= deadlineMs) {
      return {
        ok: false,
        error: "Linked order payment deadline has expired.",
      };
    }
  }

  const financials = calculateOrderFinancials(input.offer.offerPriceSen);

  return {
    ok: true,
    lockedOfferPriceSen: input.offer.offerPriceSen,
    reservationExpiresAt,
    orderPlan: {
      source: "offer",
      sellerId: input.offer.sellerId,
      sellerName: input.sellerName,
      collectionAreaName: input.collectionAreaName || "UMSKAL Campus",
      itemCount: 1,
      financials,
      paymentWindowLabel: "Locked 30-minute offer hold",
      paymentDeadlineIso: reservationExpiresAt,
    },
  };
}
