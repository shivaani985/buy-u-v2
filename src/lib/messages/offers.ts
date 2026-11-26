import type { MessagingEligibilityResult } from "./validation";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Minimum offer price in integer sen (RM 2.00). */
export const MIN_OFFER_SEN = 200;

/** Pending offers expire strictly 24 hours after server `created_at`. */
export const OFFER_PENDING_TTL_MS = 24 * 60 * 60 * 1000;

/** Accepted offers reserve 1 unit for strictly 30 minutes. */
export const OFFER_RESERVATION_TTL_MS = 30 * 60 * 1000;

export type OfferStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "cancelled"
  | "expired"
  | "superseded";

export function normalizeOfferStatus(status: string | null | undefined): OfferStatus {
  if (status === "accepted" || status === "expired" || status === "superseded") {
    return status;
  }
  if (status === "declined" || status === "rejected") return "declined";
  if (status === "cancelled" || status === "withdrawn") return "cancelled";
  return "pending";
}

export interface OfferCardItem {
  id: string;
  conversationId: string;
  listingId: string;
  variantId?: string | null;
  variantLabel?: string | null;
  variantImageUrl?: string | null;
  buyerId: string;
  sellerId: string;
  proposedBy?: string;
  parentOfferId?: string | null;
  offerPriceSen: number;
  status: OfferStatus;
  orderId: string | null;
  createdAt: string;
  respondedAt: string | null;
  expiresAt: string;
  reservationExpiresAt: string | null;
  reservationReleasedAt: string | null;
}

export function getOfferProposerId(
  offer: Pick<OfferCardItem, "buyerId" | "proposedBy">
): string {
  return offer.proposedBy?.trim() || offer.buyerId;
}

/**
 * Authoritative bargaining eligibility rule (mirrored in SQL `is_listing_bargaining_eligible`):
 * - ALLOWED: Pre-Loved (`pre_loved`) and Student Business non-food (`business` + `isFood = false`).
 * - NOT ALLOWED: Food & beverages (`isFood = true`), food pre-orders (`availabilityMode = 'pre_order'`),
 *   services (`service`), and free items (`free`).
 */
export function isBargainingEligibleListing(input: {
  kind?: string | null;
  isFood?: boolean | null;
  availabilityMode?: string | null;
  isFreeNotice?: boolean | null;
}): boolean {
  if (input.isFreeNotice) return false;
  const kind = (input.kind ?? "").trim().toLowerCase();
  if (kind !== "pre_loved" && kind !== "business") return false;
  if (Boolean(input.isFood)) return false;
  if ((input.availabilityMode ?? "").trim().toLowerCase() === "pre_order") {
    return false;
  }
  return true;
}

function isUuid(val: string | null | undefined): boolean {
  return typeof val === "string" && UUID_RE.test(val.trim());
}

/**
 * Parses a Ringgit string (e.g. "12", "12.50") to exact integer sen without float drift.
 */
export function parseOfferPriceRmToSen(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [wholeStr, fracStr = ""] = trimmed.split(".");
  const whole = Number.parseInt(wholeStr ?? "0", 10);
  const frac = Number.parseInt(fracStr.padEnd(2, "0"), 10);
  if (!Number.isSafeInteger(whole) || !Number.isSafeInteger(frac)) return null;
  return whole * 100 + frac;
}

export function computeOfferExpiresAt(
  createdAtIso: string,
  explicitExpiresAt?: string | null
): string {
  if (explicitExpiresAt && !Number.isNaN(new Date(explicitExpiresAt).getTime())) {
    return explicitExpiresAt;
  }
  const createdMs = new Date(createdAtIso).getTime();
  if (Number.isNaN(createdMs)) return createdAtIso;
  return new Date(createdMs + OFFER_PENDING_TTL_MS).toISOString();
}

export function computeReservationExpiresAt(
  respondedAtIso: string | null,
  explicitReservationExpiresAt?: string | null
): string | null {
  if (
    explicitReservationExpiresAt &&
    !Number.isNaN(new Date(explicitReservationExpiresAt).getTime())
  ) {
    return explicitReservationExpiresAt;
  }
  if (!respondedAtIso) return null;
  const respondedMs = new Date(respondedAtIso).getTime();
  if (Number.isNaN(respondedMs)) return null;
  return new Date(respondedMs + OFFER_RESERVATION_TTL_MS).toISOString();
}

/**
 * Authoritative status resolution accounting for 24h pending expiry and
 * 30m unpaid reservation expiry, even when the DB status row hasn't been swept yet.
 */
export function resolveEffectiveOfferStatus(
  offer: Pick<
    OfferCardItem,
    | "status"
    | "createdAt"
    | "expiresAt"
    | "respondedAt"
    | "reservationExpiresAt"
    | "reservationReleasedAt"
    | "orderId"
  >,
  nowMs = Date.now()
): OfferStatus {
  if (offer.status === "pending") {
    const expMs = new Date(
      computeOfferExpiresAt(offer.createdAt, offer.expiresAt)
    ).getTime();
    if (!Number.isNaN(expMs) && nowMs >= expMs) {
      return "expired";
    }
    return "pending";
  }

  if (offer.status === "accepted") {
    if (offer.reservationReleasedAt) return "expired";
    const holdIso = computeReservationExpiresAt(
      offer.respondedAt,
      offer.reservationExpiresAt
    );
    if (!offer.orderId && holdIso) {
      const holdMs = new Date(holdIso).getTime();
      if (!Number.isNaN(holdMs) && nowMs >= holdMs) {
        return "expired";
      }
    }
    return "accepted";
  }

  return offer.status;
}

/**
 * Authoritative server-side payability check enforced REGARDLESS of whether
 * the background expiry sweeper has run yet.
 * Used by Phase 6 checkout/ToyyibPay bill creation to prevent paying expired
 * 30-minute holds or expired orders.
 */
export function isOfferHoldPayable(
  offer: Pick<
    OfferCardItem,
    | "status"
    | "respondedAt"
    | "reservationExpiresAt"
    | "reservationReleasedAt"
    | "orderId"
  >,
  options: {
    nowMs?: number;
    linkedOrderStatus?: string | null;
    linkedOrderPaymentDeadline?: string | null;
  } = {}
): { payable: boolean; reason?: string } {
  const nowMs = options.nowMs ?? Date.now();

  if (offer.status !== "accepted") {
    return { payable: false, reason: "Offer is not in an accepted state." };
  }

  if (offer.reservationReleasedAt) {
    return {
      payable: false,
      reason: "This offer's 30-minute reservation has already been released.",
    };
  }

  const holdIso = computeReservationExpiresAt(
    offer.respondedAt,
    offer.reservationExpiresAt
  );
  if (!holdIso || nowMs >= new Date(holdIso).getTime()) {
    return {
      payable: false,
      reason: "This offer's 30-minute reservation hold has expired.",
    };
  }

  if (options.linkedOrderStatus) {
    if (options.linkedOrderStatus !== "pending_payment") {
      return {
        payable: false,
        reason: `Linked order is ${options.linkedOrderStatus} and cannot be paid.`,
      };
    }
    if (options.linkedOrderPaymentDeadline) {
      const deadlineMs = new Date(options.linkedOrderPaymentDeadline).getTime();
      if (!Number.isNaN(deadlineMs) && nowMs >= deadlineMs) {
        return {
          payable: false,
          reason: "Linked order payment deadline has expired.",
        };
      }
    }
  }

  return { payable: true };
}

export function formatRemainingDuration(
  targetIso: string | null,
  nowMs = Date.now()
): string | null {
  if (!targetIso) return null;
  const targetMs = new Date(targetIso).getTime();
  if (Number.isNaN(targetMs)) return null;
  const diffMs = targetMs - nowMs;
  if (diffMs <= 0) return "Expired";
  const totalMinutes = Math.ceil(diffMs / 60000);
  if (totalMinutes < 60) {
    return `${totalMinutes}m left`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return mins > 0 ? `${hours}h ${mins}m left` : `${hours}h left`;
}

/**
 * Validates creating a new offer.
 * IMPORTANT: Supports UNLIMITED proposals (no 5-proposal cap).
 * Only prevents duplicate simultaneous active pending offers for the same listing.
 */
export function validateCreateOffer(input: {
  eligibility: MessagingEligibilityResult;
  conversationId: string;
  listingId: string;
  sellerId: string;
  listingKind: string;
  listingIsFood?: boolean | null;
  listingAvailabilityMode?: string | null;
  hasVariants?: boolean;
  variantId?: string | null;
  variantActive?: boolean;
  listingStatus: string;
  allowOffers: boolean;
  listingPriceSen: number;
  availableStock: number;
  offerPriceSen: number | null;
  isParticipant: boolean;
  isBlocked: boolean;
  hasActivePendingOffer: boolean;
  /** Informational only — explicitly never capped. */
  priorOfferCount?: number;
}): { ok: true; offerPriceSen: number } | { ok: false; error: string } {
  if (!input.eligibility.eligible || !input.eligibility.userId) {
    return {
      ok: false,
      error: input.eligibility.reason || "Sign in with your UMS account to make an offer.",
    };
  }

  if (!isUuid(input.conversationId) || !isUuid(input.listingId) || !isUuid(input.sellerId)) {
    return { ok: false, error: "Invalid conversation or listing reference." };
  }

  if (!input.isParticipant) {
    return { ok: false, error: "You do not have access to this conversation." };
  }

  if (input.eligibility.userId.toLowerCase() === input.sellerId.trim().toLowerCase()) {
    return { ok: false, error: "You cannot make an offer on your own listing." };
  }

  if (input.isBlocked) {
    return {
      ok: false,
      error: "Offers are unavailable because one participant has blocked the other.",
    };
  }

  if (input.listingStatus !== "published") {
    return { ok: false, error: "Offers are only allowed on published listings." };
  }

  if (
    !isBargainingEligibleListing({
      kind: input.listingKind,
      isFood: input.listingIsFood,
      availabilityMode: input.listingAvailabilityMode,
    })
  ) {
    return {
      ok: false,
      error:
        "Price negotiation is only available for Pre-Loved and non-food Student Business listings.",
    };
  }

  if (!input.allowOffers) {
    return {
      ok: false,
      error: "The seller has not enabled offers for this listing.",
    };
  }

  if (input.hasVariants) {
    if (!isUuid(input.variantId)) {
      return {
        ok: false,
        error: "Please select a valid product variant before making an offer.",
      };
    }
    if (input.variantActive === false) {
      return {
        ok: false,
        error: "Selected product variant is no longer available.",
      };
    }
  } else if (input.variantId) {
    return {
      ok: false,
      error: "Unexpected variant selected for a non-variant listing.",
    };
  }

  if (input.availableStock < 1) {
    return { ok: false, error: "This item is currently out of stock." };
  }

  if (input.hasActivePendingOffer) {
    return {
      ok: false,
      error:
        "You already have a pending offer on this listing. Wait for a response or cancel it first.",
    };
  }

  if (
    input.offerPriceSen === null ||
    !Number.isInteger(input.offerPriceSen) ||
    input.offerPriceSen < MIN_OFFER_SEN
  ) {
    return { ok: false, error: "Minimum offer amount is RM 2.00." };
  }

  if (
    Number.isInteger(input.listingPriceSen) &&
    input.listingPriceSen >= MIN_OFFER_SEN &&
    input.offerPriceSen > input.listingPriceSen
  ) {
    return {
      ok: false,
      error: "Offer amount cannot exceed the listing price.",
    };
  }

  return { ok: true, offerPriceSen: input.offerPriceSen };
}

export type OfferActionType = "accept" | "decline" | "cancel" | "counter";

export function validateOfferTransition(input: {
  action: OfferActionType;
  eligibility: MessagingEligibilityResult;
  offer: OfferCardItem;
  isBlocked: boolean;
  listingStatus?: string;
  listingKind?: string;
  listingIsFood?: boolean | null;
  listingAvailabilityMode?: string | null;
  allowOffers?: boolean;
  listingPriceSen?: number;
  counterPriceSen?: number | null;
  availableStock?: number;
  nowMs?: number;
}): { ok: true } | { ok: false; error: string } {
  if (!input.eligibility.eligible || !input.eligibility.userId) {
    return {
      ok: false,
      error: input.eligibility.reason || "Sign in to manage offers.",
    };
  }

  const actor = input.eligibility.userId.toLowerCase();
  const buyer = input.offer.buyerId.toLowerCase();
  const seller = input.offer.sellerId.toLowerCase();
  const proposer = getOfferProposerId(input.offer).toLowerCase();

  if (actor !== buyer && actor !== seller) {
    return { ok: false, error: "Only offer participants can manage this offer." };
  }

  if (input.action === "cancel" && actor !== proposer) {
    return {
      ok: false,
      error: "Only the member who sent this proposal can cancel it.",
    };
  }

  if (
    (input.action === "accept" ||
      input.action === "decline" ||
      input.action === "counter") &&
    actor === proposer
  ) {
    return {
      ok: false,
      error: "Only the receiving party can respond to this offer.",
    };
  }

  if (
    (input.action === "accept" || input.action === "counter") &&
    input.isBlocked
  ) {
    return {
      ok: false,
      error: "Cannot respond to an offer from a blocked member.",
    };
  }

  const effectiveStatus = resolveEffectiveOfferStatus(
    input.offer,
    input.nowMs ?? Date.now()
  );

  if (effectiveStatus === "expired") {
    return {
      ok: false,
      error: "This offer has expired after 24 hours and can no longer be changed.",
    };
  }

  if (effectiveStatus !== "pending") {
    return {
      ok: false,
      error: `This offer is already ${effectiveStatus}.`,
    };
  }

  if (input.action === "accept" || input.action === "counter") {
    if (
      input.listingStatus !== undefined &&
      input.listingStatus !== "published"
    ) {
      return { ok: false, error: "This listing is no longer published." };
    }
    if (
      input.listingKind !== undefined &&
      !isBargainingEligibleListing({
        kind: input.listingKind,
        isFood: input.listingIsFood,
        availabilityMode: input.listingAvailabilityMode,
      })
    ) {
      return {
        ok: false,
        error:
          "Only Pre-Loved and non-food Student Business listings support price negotiation.",
      };
    }
    if (input.allowOffers === false) {
      return { ok: false, error: "Offers are disabled on this listing." };
    }
    if (input.availableStock !== undefined && input.availableStock < 1) {
      return {
        ok: false,
        error: "Not enough available stock to reserve this item.",
      };
    }
  }

  if (input.action === "counter") {
    if (
      input.counterPriceSen === null ||
      input.counterPriceSen === undefined ||
      !Number.isInteger(input.counterPriceSen) ||
      input.counterPriceSen < MIN_OFFER_SEN
    ) {
      return { ok: false, error: "Minimum counter offer is RM 2.00." };
    }
    if (
      typeof input.listingPriceSen === "number" &&
      Number.isInteger(input.listingPriceSen) &&
      input.listingPriceSen >= MIN_OFFER_SEN &&
      input.counterPriceSen > input.listingPriceSen
    ) {
      return {
        ok: false,
        error: "Counter offer cannot exceed the listing price.",
      };
    }
  }

  return { ok: true };
}

export interface AtomicOfferSimulationState {
  listingQuantity: number;
  listingReservedQuantity: number;
  listingSellerId?: string;
  listingPriceSen?: number;
  conversationMembers?: [string, string];
  linkedOrderStatus?: "pending_payment" | "paid" | "expired" | null;
  linkedOrderPaidAt?: string | null;
  linkedOrderPaymentDeadline?: string | null;
  offer: OfferCardItem;
}

/**
 * Pure reference model of `accept_offer_atomic` for deterministic security,
 * concurrency, and boundary testing.
 */
export function simulateAtomicOfferAccept(
  state: AtomicOfferSimulationState,
  receiverEligibility: MessagingEligibilityResult,
  nowMs: number,
  isBlocked = false
):
  | { ok: true; nextState: AtomicOfferSimulationState }
  | { ok: false; error: string } {
  const listingSellerId = state.listingSellerId ?? state.offer.sellerId;
  if (listingSellerId.toLowerCase() !== state.offer.sellerId.toLowerCase()) {
    return { ok: false, error: "Listing owner does not match offer seller." };
  }

  if (state.conversationMembers) {
    const [a, b] = state.conversationMembers.map((x) => x.toLowerCase());
    const buyer = state.offer.buyerId.toLowerCase();
    const seller = state.offer.sellerId.toLowerCase();
    const matches =
      (a === buyer && b === seller) || (a === seller && b === buyer);
    if (!matches) {
      return {
        ok: false,
        error: "Offer participants do not match conversation participants.",
      };
    }
  }

  if (
    state.offer.offerPriceSen < MIN_OFFER_SEN ||
    (typeof state.listingPriceSen === "number" &&
      state.offer.offerPriceSen > state.listingPriceSen)
  ) {
    return {
      ok: false,
      error: "Offer price must be at least RM 2.00 and not exceed listing price.",
    };
  }

  const available = Math.max(
    0,
    state.listingQuantity - Math.max(0, state.listingReservedQuantity)
  );
  const check = validateOfferTransition({
    action: "accept",
    eligibility: receiverEligibility,
    offer: state.offer,
    isBlocked,
    listingStatus: "published",
    listingKind: "pre_loved",
    allowOffers: true,
    availableStock: available,
    nowMs,
  });
  if (!check.ok) return check;

  const nowIso = new Date(nowMs).toISOString();
  const holdUntilIso = new Date(nowMs + OFFER_RESERVATION_TTL_MS).toISOString();

  return {
    ok: true,
    nextState: {
      ...state,
      listingQuantity: state.listingQuantity,
      listingReservedQuantity: state.listingReservedQuantity + 1,
      offer: {
        ...state.offer,
        status: "accepted",
        respondedAt: nowIso,
        reservationExpiresAt: holdUntilIso,
      },
    },
  };
}

/**
 * Pure reference model of `counter_offer_atomic` for deterministic two-way
 * negotiation, superseding, variant/image preservation, and authorization tests.
 */
export function simulateAtomicCounterOffer(
  state: AtomicOfferSimulationState,
  receiverEligibility: MessagingEligibilityResult,
  counterPriceSen: number | null,
  nowMs: number,
  isBlocked = false
):
  | {
      ok: true;
      supersededOffer: OfferCardItem;
      counterOffer: OfferCardItem;
      nextState: AtomicOfferSimulationState;
    }
  | { ok: false; error: string } {
  const listingSellerId = state.listingSellerId ?? state.offer.sellerId;
  if (listingSellerId.toLowerCase() !== state.offer.sellerId.toLowerCase()) {
    return { ok: false, error: "Listing owner does not match offer seller." };
  }

  const available = Math.max(
    0,
    state.listingQuantity - Math.max(0, state.listingReservedQuantity)
  );
  const check = validateOfferTransition({
    action: "counter",
    eligibility: receiverEligibility,
    offer: state.offer,
    isBlocked,
    listingStatus: "published",
    listingKind: "pre_loved",
    allowOffers: true,
    listingPriceSen: state.listingPriceSen,
    counterPriceSen,
    availableStock: available,
    nowMs,
  });
  if (!check.ok) return check;

  const nowIso = new Date(nowMs).toISOString();
  const supersededOffer: OfferCardItem = {
    ...state.offer,
    status: "superseded",
    respondedAt: nowIso,
  };
  const counterOffer: OfferCardItem = {
    id: `${state.offer.id}-counter-${nowMs}`,
    conversationId: state.offer.conversationId,
    listingId: state.offer.listingId,
    variantId: state.offer.variantId ?? null,
    variantLabel: state.offer.variantLabel ?? null,
    variantImageUrl: state.offer.variantImageUrl ?? null,
    buyerId: state.offer.buyerId,
    sellerId: state.offer.sellerId,
    proposedBy: receiverEligibility.userId!,
    parentOfferId: state.offer.id,
    offerPriceSen: counterPriceSen!,
    status: "pending",
    orderId: null,
    createdAt: nowIso,
    respondedAt: null,
    expiresAt: new Date(nowMs + OFFER_PENDING_TTL_MS).toISOString(),
    reservationExpiresAt: null,
    reservationReleasedAt: null,
  };

  return {
    ok: true,
    supersededOffer,
    counterOffer,
    nextState: {
      ...state,
      offer: counterOffer,
    },
  };
}

/**
 * Pure reference model of `release_expired_offer_reservations` verifying
 * exactly-once stock release at 30 minutes even if a linked unpaid order has
 * a later payment_deadline, expiring that unpaid order atomically.
 */
export function simulateReleaseExpiredReservation(
  state: AtomicOfferSimulationState,
  nowMs: number
): { released: boolean; nextState: AtomicOfferSimulationState } {
  const { offer } = state;
  if (offer.status !== "accepted" || offer.reservationReleasedAt !== null) {
    return { released: false, nextState: state };
  }

  const hasLinkedOrder = offer.orderId !== null;
  if (hasLinkedOrder) {
    const isUnpaidPending =
      state.linkedOrderStatus === "pending_payment" &&
      !state.linkedOrderPaidAt;
    if (!isUnpaidPending) {
      return { released: false, nextState: state };
    }
  }

  const holdIso = computeReservationExpiresAt(
    offer.respondedAt,
    offer.reservationExpiresAt
  );
  if (!holdIso || nowMs < new Date(holdIso).getTime()) {
    return { released: false, nextState: state };
  }

  return {
    released: true,
    nextState: {
      ...state,
      listingQuantity: state.listingQuantity,
      listingReservedQuantity: Math.max(0, state.listingReservedQuantity - 1),
      linkedOrderStatus: hasLinkedOrder ? "expired" : state.linkedOrderStatus,
      offer: {
        ...offer,
        status: "expired",
        reservationReleasedAt: new Date(nowMs).toISOString(),
      },
    },
  };
}

/**
 * Pure reference model of `guard_offer_inserts()` BEFORE INSERT trigger.
 * Verifies forged status/server fields are rejected, forged client timestamps
 * are overridden server-side to `now` / `now + 24h`, and listing/conversation/
 * price boundaries are enforced with zero proposal-count cap.
 */
export function simulateOfferInsertGuard(input: {
  actorUserId: string;
  isActiveMember: boolean;
  buyerId: string;
  sellerId: string;
  status?: string;
  orderId?: string | null;
  respondedAt?: string | null;
  reservationExpiresAt?: string | null;
  reservationReleasedAt?: string | null;
  clientCreatedAt?: string | null;
  clientExpiresAt?: string | null;
  conversationMembers: [string, string];
  listingSellerId: string;
  listingStatus: string;
  listingKind: string;
  listingIsFood?: boolean | null;
  listingAvailabilityMode?: string | null;
  hasVariants?: boolean;
  variantId?: string | null;
  variantActive?: boolean;
  allowOffers: boolean;
  listingPriceSen: number;
  availableStock: number;
  offerPriceSen: number;
  isBlocked?: boolean;
  serverNowMs: number;
}):
  | { ok: true; createdAt: string; expiresAt: string; status: "pending" }
  | { ok: false; error: string } {
  if (!input.isActiveMember) {
    return { ok: false, error: "Only active verified members can create offers." };
  }
  if (input.buyerId.toLowerCase() !== input.actorUserId.toLowerCase()) {
    return { ok: false, error: "Offer buyer_id must match authenticated user." };
  }
  if (input.sellerId.toLowerCase() === input.actorUserId.toLowerCase()) {
    return { ok: false, error: "You cannot make an offer on your own listing." };
  }
  if ((input.status ?? "pending") !== "pending") {
    return { ok: false, error: "New offers must start with pending status." };
  }
  if (
    input.orderId ||
    input.respondedAt ||
    input.reservationExpiresAt ||
    input.reservationReleasedAt
  ) {
    return {
      ok: false,
      error: "Server-managed offer fields cannot be set on insert.",
    };
  }

  const [a, b] = input.conversationMembers.map((x) => x.toLowerCase());
  const buyer = input.buyerId.toLowerCase();
  const seller = input.sellerId.toLowerCase();
  if (!((a === buyer && b === seller) || (a === seller && b === buyer))) {
    return { ok: false, error: "Offer participants must match the conversation." };
  }

  if (input.isBlocked) {
    return { ok: false, error: "Offers are unavailable for blocked members." };
  }

  if (input.listingSellerId.toLowerCase() !== seller) {
    return { ok: false, error: "Offer seller does not match listing owner." };
  }

  if (
    input.listingStatus !== "published" ||
    !isBargainingEligibleListing({
      kind: input.listingKind,
      isFood: input.listingIsFood,
      availabilityMode: input.listingAvailabilityMode,
    }) ||
    !input.allowOffers
  ) {
    return {
      ok: false,
      error:
        "Offers are only allowed on published Pre-Loved or non-food Student Business listings with offers enabled.",
    };
  }

  if (input.hasVariants) {
    if (!isUuid(input.variantId)) {
      return { ok: false, error: "A valid product variant must be selected." };
    }
    if (input.variantActive === false) {
      return { ok: false, error: "Selected product variant is unavailable." };
    }
  } else if (input.variantId) {
    return { ok: false, error: "Unexpected variant on a non-variant listing." };
  }

  if (input.availableStock < 1) {
    return { ok: false, error: "This listing is currently out of stock." };
  }

  if (
    !Number.isInteger(input.offerPriceSen) ||
    input.offerPriceSen < MIN_OFFER_SEN ||
    input.offerPriceSen > input.listingPriceSen
  ) {
    return {
      ok: false,
      error: "Offer price must be between RM 2.00 and the listing price.",
    };
  }

  // Authoritatively override any forged client created_at / expires_at
  return {
    ok: true,
    status: "pending",
    createdAt: new Date(input.serverNowMs).toISOString(),
    expiresAt: new Date(input.serverNowMs + OFFER_PENDING_TTL_MS).toISOString(),
  };
}

export type ChatTimelineEntry<TMessage, TOffer> =
  | { kind: "message"; id: string; createdAt: string; message: TMessage }
  | { kind: "offer"; id: string; createdAt: string; offer: TOffer };

/**
 * Merges messages and listing-linked offer cards into one deduplicated,
 * chronologically ordered chat timeline.
 */
export function mergeChatTimeline<
  TMessage extends { id: string; createdAt: string },
  TOffer extends { id: string; createdAt: string },
>(
  messages: TMessage[],
  offers: TOffer[]
): ChatTimelineEntry<TMessage, TOffer>[] {
  const msgMap = new Map<string, TMessage>();
  for (const m of messages) msgMap.set(m.id, m);

  const offerMap = new Map<string, TOffer>();
  for (const o of offers) offerMap.set(o.id, o);

  const entries: ChatTimelineEntry<TMessage, TOffer>[] = [
    ...Array.from(msgMap.values()).map((m) => ({
      kind: "message" as const,
      id: m.id,
      createdAt: m.createdAt,
      message: m,
    })),
    ...Array.from(offerMap.values()).map((o) => ({
      kind: "offer" as const,
      id: o.id,
      createdAt: o.createdAt,
      offer: o,
    })),
  ];

  return entries.sort((a, b) => {
    const diff =
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    if (diff !== 0) return diff;
    return `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`);
  });
}
