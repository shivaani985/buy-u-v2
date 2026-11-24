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
  | "expired";

export interface OfferCardItem {
  id: string;
  conversationId: string;
  listingId: string;
  buyerId: string;
  sellerId: string;
  offerPriceSen: number;
  status: OfferStatus;
  orderId: string | null;
  createdAt: string;
  respondedAt: string | null;
  expiresAt: string;
  reservationExpiresAt: string | null;
  reservationReleasedAt: string | null;
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

  if (input.listingKind !== "pre_loved") {
    return {
      ok: false,
      error: "Offers are only available for Pre-Loved listings.",
    };
  }

  if (!input.allowOffers) {
    return {
      ok: false,
      error: "The seller has not enabled offers for this listing.",
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

export type OfferActionType = "accept" | "decline" | "cancel";

export function validateOfferTransition(input: {
  action: OfferActionType;
  eligibility: MessagingEligibilityResult;
  offer: OfferCardItem;
  isBlocked: boolean;
  listingStatus?: string;
  listingKind?: string;
  allowOffers?: boolean;
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

  if (input.action === "cancel" && actor !== buyer) {
    return { ok: false, error: "Only the buyer can cancel a pending offer." };
  }

  if ((input.action === "accept" || input.action === "decline") && actor !== seller) {
    return {
      ok: false,
      error: "Only the seller can accept or decline this offer.",
    };
  }

  if (input.action === "accept" && input.isBlocked) {
    return {
      ok: false,
      error: "Cannot accept an offer from a blocked member.",
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

  if (input.action === "accept") {
    if (
      input.listingStatus !== undefined &&
      input.listingStatus !== "published"
    ) {
      return { ok: false, error: "This listing is no longer published." };
    }
    if (input.listingKind !== undefined && input.listingKind !== "pre_loved") {
      return {
        ok: false,
        error: "Only Pre-Loved listings support offer acceptance.",
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

  return { ok: true };
}

export interface AtomicOfferSimulationState {
  listingQuantity: number;
  listingReservedQuantity: number;
  offer: OfferCardItem;
}

/**
 * Pure reference model of `accept_offer_atomic` for deterministic concurrency
 * and boundary testing (double-accept, stock=0, stock=1, 24h expiry).
 */
export function simulateAtomicOfferAccept(
  state: AtomicOfferSimulationState,
  sellerEligibility: MessagingEligibilityResult,
  nowMs: number,
  isBlocked = false
):
  | { ok: true; nextState: AtomicOfferSimulationState }
  | { ok: false; error: string } {
  const available = Math.max(
    0,
    state.listingQuantity - Math.max(0, state.listingReservedQuantity)
  );
  const check = validateOfferTransition({
    action: "accept",
    eligibility: sellerEligibility,
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
 * Pure reference model of `release_expired_offer_reservations` verifying
 * exactly-once stock release after the 30-minute unpaid reservation window.
 */
export function simulateReleaseExpiredReservation(
  state: AtomicOfferSimulationState,
  nowMs: number
): { released: boolean; nextState: AtomicOfferSimulationState } {
  const { offer } = state;
  if (
    offer.status !== "accepted" ||
    offer.reservationReleasedAt !== null ||
    offer.orderId !== null
  ) {
    return { released: false, nextState: state };
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
      listingQuantity: state.listingQuantity,
      listingReservedQuantity: Math.max(0, state.listingReservedQuantity - 1),
      offer: {
        ...offer,
        status: "expired",
        reservationReleasedAt: new Date(nowMs).toISOString(),
      },
    },
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
