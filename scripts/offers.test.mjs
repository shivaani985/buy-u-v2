import assert from "node:assert/strict";
import test from "node:test";
import {
  computeOfferExpiresAt,
  isOfferHoldPayable,
  mergeChatTimeline,
  normalizeOfferStatus,
  OFFER_PENDING_TTL_MS,
  OFFER_RESERVATION_TTL_MS,
  parseOfferPriceRmToSen,
  resolveEffectiveOfferStatus,
  simulateAtomicCounterOffer,
  simulateAtomicOfferAccept,
  simulateOfferInsertGuard,
  simulateReleaseExpiredReservation,
  validateCreateOffer,
  validateOfferTransition,
} from "../src/lib/messages/offers.ts";
import { evaluateMessagingEligibility } from "../src/lib/messages/validation.ts";

const BUYER_ID = "17d414ce-8349-4dc2-bccd-94d9bd0ebc52";
const SELLER_ID = "d3b398d8-9103-4bc2-84d3-6e0101b7659a";
const CONV_ID = "53c1fcba-804e-4743-a429-7c4c57ca8d29";
const LISTING_ID = "2990db4c-11d6-4ec9-b4dd-5209a80ed74f";

function makeEligibility(role = "student", userId = BUYER_ID) {
  return evaluateMessagingEligibility({
    isAuthenticated: true,
    isEmailVerified: true,
    isActiveMember: true,
    profile: {
      id: userId,
      email: "member@iluv.ums.edu.my",
      university_role: role,
      status: "active",
      restriction_reason: null,
      full_name: "Member",
      display_name: "Member",
      faculty: "FKI",
      bio: null,
      avatar_url: null,
      created_at: "2026-01-01T00:00:00Z",
    },
  });
}

function makeOffer(overrides = {}) {
  const createdAt = "2026-11-24T00:00:00.000Z";
  return {
    id: "offer-1",
    conversationId: CONV_ID,
    listingId: LISTING_ID,
    buyerId: BUYER_ID,
    sellerId: SELLER_ID,
    offerPriceSen: 1200,
    status: "pending",
    orderId: null,
    createdAt,
    respondedAt: null,
    expiresAt: computeOfferExpiresAt(createdAt),
    reservationExpiresAt: null,
    reservationReleasedAt: null,
    ...overrides,
  };
}

test("unlimited proposals: 6th and 20th proposals pass validation with zero lifetime cap", () => {
  const buyer = makeEligibility("student", BUYER_ID);
  const base = {
    eligibility: buyer,
    conversationId: CONV_ID,
    listingId: LISTING_ID,
    sellerId: SELLER_ID,
    listingKind: "pre_loved",
    listingStatus: "published",
    allowOffers: true,
    listingPriceSen: 2000,
    availableStock: 1,
    offerPriceSen: 1500,
    isParticipant: true,
    isBlocked: false,
    hasActivePendingOffer: false,
  };

  // 6th proposal (priorOfferCount = 5)
  assert.equal(validateCreateOffer({ ...base, priorOfferCount: 5 }).ok, true);
  // 20th proposal (priorOfferCount = 19)
  assert.equal(validateCreateOffer({ ...base, priorOfferCount: 19 }).ok, true);
  // Staff buyer also eligible
  assert.equal(
    validateCreateOffer({
      ...base,
      eligibility: makeEligibility("staff", BUYER_ID),
      priorOfferCount: 25,
    }).ok,
    true
  );

  // Duplicate simultaneous pending offer still blocked
  assert.equal(
    validateCreateOffer({ ...base, hasActivePendingOffer: true }).ok,
    false
  );
});

test("validateCreateOffer enforces RM 2.00 min, Pre-Loved allow_offers, no self-offers, and member blocks", () => {
  const buyer = makeEligibility("student", BUYER_ID);
  const seller = makeEligibility("student", SELLER_ID);
  const base = {
    eligibility: buyer,
    conversationId: CONV_ID,
    listingId: LISTING_ID,
    sellerId: SELLER_ID,
    listingKind: "pre_loved",
    listingStatus: "published",
    allowOffers: true,
    listingPriceSen: 1500,
    availableStock: 1,
    offerPriceSen: 200,
    isParticipant: true,
    isBlocked: false,
    hasActivePendingOffer: false,
  };

  assert.equal(parseOfferPriceRmToSen("2.00"), 200);
  assert.equal(parseOfferPriceRmToSen("12.5"), 1250);
  assert.equal(parseOfferPriceRmToSen("1.99"), 199);
  assert.equal(parseOfferPriceRmToSen("-5"), null);
  assert.equal(parseOfferPriceRmToSen("abc"), null);

  // Exact RM 2.00 accepted; RM 1.99 rejected; above listing price rejected
  assert.equal(validateCreateOffer({ ...base, offerPriceSen: 200 }).ok, true);
  assert.equal(validateCreateOffer({ ...base, offerPriceSen: 199 }).ok, false);
  assert.equal(validateCreateOffer({ ...base, offerPriceSen: 1600 }).ok, false);

  // Expanded bargaining policy: Pre-Loved & non-food Student Business allowed; food/pre-order/service/allow_offers=false rejected
  assert.equal(
    validateCreateOffer({ ...base, listingKind: "business", listingIsFood: false }).ok,
    true
  );
  assert.equal(
    validateCreateOffer({ ...base, listingKind: "business", listingIsFood: true }).ok,
    false
  );
  assert.equal(
    validateCreateOffer({
      ...base,
      listingKind: "business",
      listingIsFood: false,
      listingAvailabilityMode: "pre_order",
    }).ok,
    false
  );
  assert.equal(
    validateCreateOffer({ ...base, listingKind: "service" }).ok,
    false
  );
  assert.equal(
    validateCreateOffer({ ...base, allowOffers: false }).ok,
    false
  );

  // Variant-based product bargaining requires valid active variantId
  const VARIANT_ID = "77777777-7777-4777-8777-777777777777";
  assert.equal(
    validateCreateOffer({ ...base, listingKind: "business", hasVariants: true, variantId: null }).ok,
    false
  );
  assert.equal(
    validateCreateOffer({
      ...base,
      listingKind: "business",
      hasVariants: true,
      variantId: VARIANT_ID,
      variantActive: true,
    }).ok,
    true
  );
  assert.equal(
    validateCreateOffer({
      ...base,
      listingKind: "business",
      hasVariants: true,
      variantId: VARIANT_ID,
      variantActive: false,
    }).ok,
    false
  );

  // Self-offer, blocked member, and stock=0 rejected
  assert.equal(
    validateCreateOffer({ ...base, eligibility: seller }).ok,
    false
  );
  assert.equal(validateCreateOffer({ ...base, isBlocked: true }).ok, false);
  assert.equal(validateCreateOffer({ ...base, availableStock: 0 }).ok, false);
});

test("24-hour offer expiry boundary rejects acceptance after 24h even with stale client timer", () => {
  const seller = makeEligibility("student", SELLER_ID);
  const buyer = makeEligibility("student", BUYER_ID);
  const offer = makeOffer({ createdAt: "2026-11-24T00:00:00.000Z" });
  const createdMs = new Date(offer.createdAt).getTime();

  // 1ms before 24h: still pending & acceptable
  assert.equal(
    resolveEffectiveOfferStatus(offer, createdMs + OFFER_PENDING_TTL_MS - 1),
    "pending"
  );
  assert.equal(
    validateOfferTransition({
      action: "accept",
      eligibility: seller,
      offer,
      isBlocked: false,
      availableStock: 1,
      nowMs: createdMs + OFFER_PENDING_TTL_MS - 1,
    }).ok,
    true
  );

  // At exact 24h: expired & accept/decline/cancel all rejected
  assert.equal(
    resolveEffectiveOfferStatus(offer, createdMs + OFFER_PENDING_TTL_MS),
    "expired"
  );
  assert.equal(
    validateOfferTransition({
      action: "accept",
      eligibility: seller,
      offer,
      isBlocked: false,
      availableStock: 1,
      nowMs: createdMs + OFFER_PENDING_TTL_MS,
    }).ok,
    false
  );
  assert.equal(
    validateOfferTransition({
      action: "cancel",
      eligibility: buyer,
      offer,
      isBlocked: false,
      nowMs: createdMs + OFFER_PENDING_TTL_MS,
    }).ok,
    false
  );

  // Role enforcement: buyer cannot accept, seller cannot cancel
  assert.equal(
    validateOfferTransition({
      action: "accept",
      eligibility: buyer,
      offer,
      isBlocked: false,
      availableStock: 1,
      nowMs: createdMs + 1000,
    }).ok,
    false
  );
  assert.equal(
    validateOfferTransition({
      action: "cancel",
      eligibility: seller,
      offer,
      isBlocked: false,
      nowMs: createdMs + 1000,
    }).ok,
    false
  );
});

test("atomic accept prevents double acceptance, stock=0, and stock=1 concurrency oversell", () => {
  const seller = makeEligibility("student", SELLER_ID);
  const t0 = new Date("2026-11-24T01:00:00.000Z").getTime();

  // Stock = 0 rejected
  const zeroStock = simulateAtomicOfferAccept(
    {
      listingQuantity: 0,
      listingReservedQuantity: 0,
      offer: makeOffer(),
    },
    seller,
    t0
  );
  assert.equal(zeroStock.ok, false);

  // Stock = 1: first accept succeeds and reserves 1 unit for 30m
  const first = simulateAtomicOfferAccept(
    {
      listingQuantity: 1,
      listingReservedQuantity: 0,
      offer: makeOffer(),
    },
    seller,
    t0
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.nextState.listingReservedQuantity, 1);
  assert.equal(first.nextState.offer.status, "accepted");
  assert.equal(
    first.nextState.offer.reservationExpiresAt,
    new Date(t0 + OFFER_RESERVATION_TTL_MS).toISOString()
  );

  // Second simultaneous accept on SAME offer fails (no double-reserve)
  const doubleAccept = simulateAtomicOfferAccept(first.nextState, seller, t0 + 10);
  assert.equal(doubleAccept.ok, false);
  assert.equal(first.nextState.listingReservedQuantity, 1);

  // Second concurrent offer on SAME stock=1 listing also fails (0 available left)
  const secondOffer = simulateAtomicOfferAccept(
    {
      listingQuantity: first.nextState.listingQuantity,
      listingReservedQuantity: first.nextState.listingReservedQuantity,
      offer: makeOffer({ id: "offer-2" }),
    },
    seller,
    t0 + 20
  );
  assert.equal(secondOffer.ok, false);
});

test("30-minute hold release restores stock safely and exactly once", () => {
  const seller = makeEligibility("student", SELLER_ID);
  const tAccept = new Date("2026-11-24T01:00:00.000Z").getTime();

  const accepted = simulateAtomicOfferAccept(
    {
      listingQuantity: 1,
      listingReservedQuantity: 0,
      offer: makeOffer(),
    },
    seller,
    tAccept
  );
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;

  // Before 30 minutes: hold NOT released
  const beforeExpiry = simulateReleaseExpiredReservation(
    accepted.nextState,
    tAccept + OFFER_RESERVATION_TTL_MS - 1000
  );
  assert.equal(beforeExpiry.released, false);
  assert.equal(beforeExpiry.nextState.listingReservedQuantity, 1);

  // At 30 minutes: hold released cleanly, stock restored to 0 reserved
  const atExpiry = simulateReleaseExpiredReservation(
    accepted.nextState,
    tAccept + OFFER_RESERVATION_TTL_MS
  );
  assert.equal(atExpiry.released, true);
  assert.equal(atExpiry.nextState.listingReservedQuantity, 0);
  assert.equal(atExpiry.nextState.offer.status, "expired");
  assert.ok(atExpiry.nextState.offer.reservationReleasedAt);

  // Calling release a second time is a safe no-op (exactly-once guarantee)
  const repeatRelease = simulateReleaseExpiredReservation(
    atExpiry.nextState,
    tAccept + OFFER_RESERVATION_TTL_MS + 60000
  );
  assert.equal(repeatRelease.released, false);
  assert.equal(repeatRelease.nextState.listingReservedQuantity, 0);
});

test("mergeChatTimeline interleaves messages and offers chronologically without duplicates", () => {
  const timeline = mergeChatTimeline(
    [
      { id: "m1", createdAt: "2026-11-24T01:00:00.000Z" },
      { id: "m2", createdAt: "2026-11-24T01:05:00.000Z" },
      { id: "m2", createdAt: "2026-11-24T01:05:00.000Z" }, // duplicate
    ],
    [
      { id: "o1", createdAt: "2026-11-24T01:02:00.000Z" },
      { id: "o1", createdAt: "2026-11-24T01:02:00.000Z" }, // duplicate
    ]
  );

  assert.deepEqual(
    timeline.map((e) => `${e.kind}:${e.id}`),
    ["message:m1", "offer:o1", "message:m2"]
  );
});

test("isOfferHoldPayable enforces 30-minute hold expiry and order status regardless of sweep timing", () => {
  const tAccept = new Date("2026-11-24T01:00:00.000Z").getTime();
  const acceptedOffer = makeOffer({
    status: "accepted",
    respondedAt: new Date(tAccept).toISOString(),
    reservationExpiresAt: new Date(tAccept + OFFER_RESERVATION_TTL_MS).toISOString(),
    reservationReleasedAt: null,
  });

  // 1 second before 30m: payable
  assert.equal(
    isOfferHoldPayable(acceptedOffer, {
      nowMs: tAccept + OFFER_RESERVATION_TTL_MS - 1000,
    }).payable,
    true
  );

  // At exact 30m: NOT payable even though DB status is still 'accepted' (unswept)
  assert.equal(
    isOfferHoldPayable(acceptedOffer, {
      nowMs: tAccept + OFFER_RESERVATION_TTL_MS,
    }).payable,
    false
  );

  // Released hold: NOT payable
  assert.equal(
    isOfferHoldPayable(
      {
        ...acceptedOffer,
        reservationReleasedAt: new Date(tAccept + OFFER_RESERVATION_TTL_MS).toISOString(),
      },
      { nowMs: tAccept + 1000 }
    ).payable,
    false
  );

  // Expired linked order: NOT payable
  assert.equal(
    isOfferHoldPayable(acceptedOffer, {
      nowMs: tAccept + 1000,
      linkedOrderStatus: "expired",
    }).payable,
    false
  );
});

test("atomic accept enforces listing ownership, conversation participant match, and RM2..listingPrice bounds", () => {
  const seller = makeEligibility("student", SELLER_ID);
  const t0 = new Date("2026-11-24T01:00:00.000Z").getTime();
  const otherUid = "99999999-9103-4bc2-84d3-6e0101b7659a";

  // Listing owned by a different seller rejected
  assert.equal(
    simulateAtomicOfferAccept(
      {
        listingQuantity: 1,
        listingReservedQuantity: 0,
        listingSellerId: otherUid,
        listingPriceSen: 1500,
        conversationMembers: [BUYER_ID, SELLER_ID],
        offer: makeOffer({ offerPriceSen: 1200 }),
      },
      seller,
      t0
    ).ok,
    false
  );

  // Conversation participant mismatch rejected
  assert.equal(
    simulateAtomicOfferAccept(
      {
        listingQuantity: 1,
        listingReservedQuantity: 0,
        listingSellerId: SELLER_ID,
        listingPriceSen: 1500,
        conversationMembers: [otherUid, SELLER_ID],
        offer: makeOffer({ offerPriceSen: 1200 }),
      },
      seller,
      t0
    ).ok,
    false
  );

  // Offer price > listing price or < RM 2.00 rejected
  assert.equal(
    simulateAtomicOfferAccept(
      {
        listingQuantity: 1,
        listingReservedQuantity: 0,
        listingSellerId: SELLER_ID,
        listingPriceSen: 1000,
        conversationMembers: [BUYER_ID, SELLER_ID],
        offer: makeOffer({ offerPriceSen: 1200 }),
      },
      seller,
      t0
    ).ok,
    false
  );
  assert.equal(
    simulateAtomicOfferAccept(
      {
        listingQuantity: 1,
        listingReservedQuantity: 0,
        listingSellerId: SELLER_ID,
        listingPriceSen: 1000,
        conversationMembers: [BUYER_ID, SELLER_ID],
        offer: makeOffer({ offerPriceSen: 199 }),
      },
      seller,
      t0
    ).ok,
    false
  );
});

test("30m hold expiry releases stock and expires linked unpaid order even when order payment_deadline is later", () => {
  const tAccept = new Date("2026-11-24T01:00:00.000Z").getTime();
  const stateWithLaterOrderDeadline = {
    listingQuantity: 1,
    listingReservedQuantity: 1,
    linkedOrderStatus: "pending_payment",
    linkedOrderPaidAt: null,
    // Order deadline is 60m later, but offer hold is strictly 30m
    linkedOrderPaymentDeadline: new Date(
      tAccept + 60 * 60 * 1000
    ).toISOString(),
    offer: makeOffer({
      status: "accepted",
      orderId: "order-unpaid-1",
      respondedAt: new Date(tAccept).toISOString(),
      reservationExpiresAt: new Date(
        tAccept + OFFER_RESERVATION_TTL_MS
      ).toISOString(),
      reservationReleasedAt: null,
    }),
  };

  // At 30m: hold released AND linked unpaid order expired atomically
  const released = simulateReleaseExpiredReservation(
    stateWithLaterOrderDeadline,
    tAccept + OFFER_RESERVATION_TTL_MS
  );
  assert.equal(released.released, true);
  assert.equal(released.nextState.listingReservedQuantity, 0);
  assert.equal(released.nextState.linkedOrderStatus, "expired");
  assert.equal(released.nextState.offer.status, "expired");

  // Paid order is NEVER released or expired
  const paidState = {
    ...stateWithLaterOrderDeadline,
    linkedOrderStatus: "paid",
    linkedOrderPaidAt: new Date(tAccept + 5 * 60 * 1000).toISOString(),
  };
  const paidResult = simulateReleaseExpiredReservation(
    paidState,
    tAccept + OFFER_RESERVATION_TTL_MS + 60000
  );
  assert.equal(paidResult.released, false);
  assert.equal(paidResult.nextState.listingReservedQuantity, 1);
  assert.equal(paidResult.nextState.linkedOrderStatus, "paid");
});

test("offer INSERT guard blocks forged status/server fields, overrides future timestamps, and validates seller/listing/price", () => {
  const serverNowMs = new Date("2026-11-24T08:00:00.000Z").getTime();
  const otherUid = "99999999-9103-4bc2-84d3-6e0101b7659a";
  const base = {
    actorUserId: BUYER_ID,
    isActiveMember: true,
    buyerId: BUYER_ID,
    sellerId: SELLER_ID,
    status: "pending",
    conversationMembers: [BUYER_ID, SELLER_ID],
    listingSellerId: SELLER_ID,
    listingStatus: "published",
    listingKind: "pre_loved",
    allowOffers: true,
    listingPriceSen: 1500,
    availableStock: 1,
    offerPriceSen: 1200,
    serverNowMs,
  };

  // Forged status = 'accepted' rejected
  assert.equal(
    simulateOfferInsertGuard({ ...base, status: "accepted" }).ok,
    false
  );
  // Forged order_id, responded_at, reservation_expires_at rejected
  assert.equal(
    simulateOfferInsertGuard({ ...base, orderId: "order-1" }).ok,
    false
  );
  assert.equal(
    simulateOfferInsertGuard({
      ...base,
      reservationExpiresAt: "2099-01-01T00:00:00.000Z",
    }).ok,
    false
  );

  // Forged future client timestamps overridden authoritatively to serverNow + 24h
  const forgedTs = simulateOfferInsertGuard({
    ...base,
    clientCreatedAt: "2099-01-01T00:00:00.000Z",
    clientExpiresAt: "2099-12-31T00:00:00.000Z",
  });
  assert.equal(forgedTs.ok, true);
  if (forgedTs.ok) {
    assert.equal(forgedTs.status, "pending");
    assert.equal(forgedTs.createdAt, new Date(serverNowMs).toISOString());
    assert.equal(
      forgedTs.expiresAt,
      new Date(serverNowMs + OFFER_PENDING_TTL_MS).toISOString()
    );
  }

  // Wrong seller, wrong conversation, non-pre_loved, allow_offers=false, and invalid price rejected
  assert.equal(
    simulateOfferInsertGuard({ ...base, listingSellerId: otherUid }).ok,
    false
  );
  assert.equal(
    simulateOfferInsertGuard({
      ...base,
      conversationMembers: [otherUid, SELLER_ID],
    }).ok,
    false
  );
  // Expanded eligibility: non-food business allowed; food/service/allow_offers=false/invalid price rejected
  assert.equal(
    simulateOfferInsertGuard({ ...base, listingKind: "business", listingIsFood: false }).ok,
    true
  );
  assert.equal(
    simulateOfferInsertGuard({ ...base, listingKind: "business", listingIsFood: true }).ok,
    false
  );
  assert.equal(
    simulateOfferInsertGuard({ ...base, listingKind: "service" }).ok,
    false
  );
  assert.equal(
    simulateOfferInsertGuard({ ...base, allowOffers: false }).ok,
    false
  );
  assert.equal(
    simulateOfferInsertGuard({ ...base, offerPriceSen: 199 }).ok,
    false
  );
  assert.equal(
    simulateOfferInsertGuard({ ...base, offerPriceSen: 1600 }).ok,
    false
  );

  // Bidirectional block check: both buyer->seller and seller->buyer block offer INSERT
  const blocksBuyerToSeller = [{ blockerId: BUYER_ID, blockedId: SELLER_ID }];
  const blocksSellerToBuyer = [{ blockerId: SELLER_ID, blockedId: BUYER_ID }];
  const hasBlock = (blocks, a, b) =>
    blocks.some(
      (r) =>
        (r.blockerId === a && r.blockedId === b) ||
        (r.blockerId === b && r.blockedId === a)
    );

  assert.equal(
    simulateOfferInsertGuard({
      ...base,
      isBlocked: hasBlock(blocksBuyerToSeller, BUYER_ID, SELLER_ID),
    }).ok,
    false
  );
  assert.equal(
    simulateOfferInsertGuard({
      ...base,
      isBlocked: hasBlock(blocksSellerToBuyer, BUYER_ID, SELLER_ID),
    }).ok,
    false
  );
});

test("two-way bargaining: unlimited counter rounds, receiver-only transitions, superseded parent, preserved variation/image, and buyer accept checkout", () => {
  const buyer = makeEligibility("student", BUYER_ID);
  const seller = makeEligibility("student", SELLER_ID);
  const outsider = makeEligibility("student", "aaaaaaaa-1111-4111-8111-111111111111");
  const t0 = Date.parse("2026-11-26T04:00:00.000Z");

  const initialOffer = makeOffer({
    id: "offer-round-1",
    proposedBy: BUYER_ID,
    parentOfferId: null,
    variantId: "var-black",
    variantLabel: "Black",
    variantImageUrl: "https://example.supabase.co/storage/v1/object/public/listings/black.jpg",
    offerPriceSen: 1500,
    createdAt: new Date(t0).toISOString(),
    expiresAt: new Date(t0 + OFFER_PENDING_TTL_MS).toISOString(),
  });

  const baseState = {
    listingQuantity: 2,
    listingReservedQuantity: 0,
    listingSellerId: SELLER_ID,
    listingPriceSen: 3000,
    conversationMembers: [BUYER_ID, SELLER_ID],
    offer: initialOffer,
  };

  // Buyer (proposer) cannot accept, decline, or counter their own proposal; seller cannot cancel it
  assert.equal(simulateAtomicOfferAccept(baseState, buyer, t0 + 1000).ok, false);
  assert.equal(simulateAtomicCounterOffer(baseState, buyer, 1700, t0 + 1000).ok, false);
  assert.equal(
    validateOfferTransition({ action: "decline", eligibility: buyer, offer: initialOffer, isBlocked: false, nowMs: t0 + 1000 }).ok,
    false
  );
  assert.equal(
    validateOfferTransition({ action: "cancel", eligibility: seller, offer: initialOffer, isBlocked: false, nowMs: t0 + 1000 }).ok,
    false
  );
  assert.equal(simulateAtomicCounterOffer(baseState, outsider, 1700, t0 + 1000).ok, false);

  // Round 1: Seller counters RM 15 -> RM 22
  const r1 = simulateAtomicCounterOffer(baseState, seller, 2200, t0 + 10_000);
  assert.equal(r1.ok, true);
  assert.equal(r1.supersededOffer.status, "superseded");
  assert.equal(r1.counterOffer.proposedBy, SELLER_ID);
  assert.equal(r1.counterOffer.parentOfferId, "offer-round-1");
  assert.equal(r1.counterOffer.variantId, "var-black");
  assert.equal(r1.counterOffer.variantLabel, "Black");
  assert.equal(r1.counterOffer.variantImageUrl, initialOffer.variantImageUrl);
  assert.equal(normalizeOfferStatus(r1.supersededOffer.status), "superseded");

  // Superseded parent becomes non-actionable
  assert.equal(
    validateOfferTransition({
      action: "accept",
      eligibility: seller,
      offer: r1.supersededOffer,
      isBlocked: false,
      nowMs: t0 + 11_000,
    }).ok,
    false
  );

  // Seller (proposer of counter) cannot accept or counter their own counter; seller can cancel it
  assert.equal(simulateAtomicOfferAccept(r1.nextState, seller, t0 + 20_000).ok, false);
  assert.equal(simulateAtomicCounterOffer(r1.nextState, seller, 2100, t0 + 20_000).ok, false);
  assert.equal(
    validateOfferTransition({
      action: "cancel",
      eligibility: seller,
      offer: r1.counterOffer,
      isBlocked: false,
      nowMs: t0 + 20_000,
    }).ok,
    true
  );

  // Unlimited counter rounds: Buyer counters RM 18 -> Seller counters RM 19 -> Buyer accepts RM 19
  const r2 = simulateAtomicCounterOffer(r1.nextState, buyer, 1800, t0 + 30_000);
  assert.equal(r2.ok, true);
  assert.equal(r2.counterOffer.proposedBy, BUYER_ID);

  // Out-of-bounds counter rejected (< RM 2.00 or > RM 30.00)
  assert.equal(simulateAtomicCounterOffer(r2.nextState, seller, 199, t0 + 35_000).ok, false);
  assert.equal(simulateAtomicCounterOffer(r2.nextState, seller, 3001, t0 + 35_000).ok, false);

  const r3 = simulateAtomicCounterOffer(r2.nextState, seller, 1900, t0 + 40_000);
  assert.equal(r3.ok, true);
  assert.equal(r3.counterOffer.proposedBy, SELLER_ID);

  // Expired counter cannot be accepted or countered
  assert.equal(
    simulateAtomicOfferAccept(r3.nextState, buyer, t0 + 40_000 + OFFER_PENDING_TTL_MS).ok,
    false
  );
  assert.equal(
    simulateAtomicCounterOffer(r3.nextState, buyer, 1850, t0 + 40_000 + OFFER_PENDING_TTL_MS).ok,
    false
  );

  // Buyer accepts seller's counter-offer -> atomically reserves 1 unit for 30m & allows buyer checkout
  const acceptedRes = simulateAtomicOfferAccept(r3.nextState, buyer, t0 + 50_000);
  assert.equal(acceptedRes.ok, true);
  assert.equal(acceptedRes.nextState.listingReservedQuantity, 1);
  assert.equal(acceptedRes.nextState.offer.offerPriceSen, 1900);
  assert.equal(acceptedRes.nextState.offer.variantId, "var-black");
  assert.equal(
    isOfferHoldPayable(acceptedRes.nextState.offer, { nowMs: t0 + 60_000 }).payable,
    true
  );

  // Duplicate acceptance is prevented
  assert.equal(
    simulateAtomicOfferAccept(acceptedRes.nextState, buyer, t0 + 55_000).ok,
    false
  );

  // Accepted counter-offer reservation releases cleanly at 30 minutes
  const relRes = simulateReleaseExpiredReservation(
    acceptedRes.nextState,
    t0 + 50_000 + OFFER_RESERVATION_TTL_MS
  );
  assert.equal(relRes.released, true);
  assert.equal(relRes.nextState.listingReservedQuantity, 0);
  assert.equal(relRes.nextState.offer.status, "expired");
});

test("two-way bargaining: >5 proposals chain, receiver-only decline/cancel, and expired pending reset", () => {
  const buyer = makeEligibility("student", BUYER_ID);
  const seller = makeEligibility("student", SELLER_ID);
  const t0 = Date.parse("2026-11-26T05:00:00.000Z");

  let state = {
    listingQuantity: 3,
    listingReservedQuantity: 0,
    listingSellerId: SELLER_ID,
    listingPriceSen: 4000,
    conversationMembers: [BUYER_ID, SELLER_ID],
    offer: makeOffer({
      id: "chain-0",
      proposedBy: BUYER_ID,
      offerPriceSen: 1500,
      createdAt: new Date(t0).toISOString(),
      expiresAt: new Date(t0 + OFFER_PENDING_TTL_MS).toISOString(),
    }),
  };

  // Run 6 counter rounds (7 proposals total > 5)
  for (let round = 1; round <= 6; round++) {
    const actor = round % 2 === 1 ? seller : buyer;
    const price = 1500 + round * 150;
    const step = simulateAtomicCounterOffer(state, actor, price, t0 + round * 1000);
    assert.equal(step.ok, true);
    assert.equal(step.supersededOffer.status, "superseded");
    state = step.nextState;
  }
  assert.equal(state.offer.proposedBy, BUYER_ID);

  // Receiver (seller) declines buyer's counter; proposer (buyer) cannot decline own proposal
  assert.equal(
    validateOfferTransition({ action: "decline", eligibility: buyer, offer: state.offer, isBlocked: false, nowMs: t0 + 7000 }).ok,
    false
  );
  assert.equal(
    validateOfferTransition({ action: "decline", eligibility: seller, offer: state.offer, isBlocked: false, nowMs: t0 + 7000 }).ok,
    true
  );

  // Expired pending offer resolves as expired so fresh negotiation is unblocked
  assert.equal(
    resolveEffectiveOfferStatus(state.offer, t0 + 6000 + OFFER_PENDING_TTL_MS),
    "expired"
  );
});
