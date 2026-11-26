"use server";

import { mapRawOffer, type RawOfferRow } from "@/lib/messages/data";
import {
  getOfferProposerId,
  parseOfferPriceRmToSen,
  resolveEffectiveOfferStatus,
  validateCreateOffer,
  validateOfferTransition,
  type OfferCardItem,
} from "@/lib/messages/offers";
import {
  evaluateMessagingEligibility,
  isValidUuid,
} from "@/lib/messages/validation";
import { formatSenToRm } from "@/lib/format";
import {
  createSupabaseServerClient,
  getSessionSummary,
} from "@/lib/supabase/server";
import { createRecipientMessageNotification } from "@/lib/supabase/service";

export interface OfferActionResult {
  ok: boolean;
  offer?: OfferCardItem;
  supersededOfferId?: string;
  error?: string;
  migrationRequired?: boolean;
}

const OFFER_SELECT_COLUMNS = "*";

async function checkMemberBlocked(
  supabase: NonNullable<Awaited<ReturnType<typeof createSupabaseServerClient>>>,
  userA: string,
  userB: string
): Promise<boolean> {
  // Prefer narrow SECURITY DEFINER RPC so seller -> buyer blocks are detected
  // without weakening member_blocks RLS.
  const { data: rpcBlocked, error: rpcErr } = await supabase.rpc(
    "is_member_blocked_between",
    { p_user_a: userA, p_user_b: userB }
  );
  if (!rpcErr && typeof rpcBlocked === "boolean") {
    return rpcBlocked;
  }

  // Fallback pre-migration (sees blocker_id = auth.uid() rows)
  const { data } = await supabase
    .from("member_blocks")
    .select("blocker_id,blocked_id")
    .or(
      `and(blocker_id.eq.${userA},blocked_id.eq.${userB}),and(blocker_id.eq.${userB},blocked_id.eq.${userA})`
    )
    .limit(1);
  return Array.isArray(data) && data.length > 0;
}

/**
 * Creates a new pending offer on an eligible Pre-Loved listing.
 * Supports UNLIMITED proposals — never enforces a lifetime proposal cap.
 */
export async function createOfferAction(input: {
  conversationId: string;
  listingId: string;
  variantId?: string | null;
  amountRm: string;
}): Promise<OfferActionResult> {
  const session = await getSessionSummary();
  const eligibility = evaluateMessagingEligibility(session);

  if (!eligibility.eligible || !eligibility.userId) {
    return {
      ok: false,
      error:
        eligibility.reason ||
        "Sign in with your UMS account to make an offer.",
    };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, error: "Bargaining service unavailable." };
  }

  const userId = eligibility.userId;
  const conversationId = (input.conversationId ?? "").trim();
  const listingId = (input.listingId ?? "").trim();
  const variantId = (input.variantId ?? "").trim() || null;

  if (!isValidUuid(conversationId) || !isValidUuid(listingId)) {
    return { ok: false, error: "Invalid conversation or listing reference." };
  }

  const [convRes, listingRes, pendingRes] = await Promise.all([
    supabase
      .from("conversations")
      .select("id,member_a,member_b")
      .eq("id", conversationId)
      .maybeSingle(),
    supabase
      .from("listings")
      .select(
        "id,seller_id,title,kind,is_food,availability_mode,has_variants,status,allow_offers,price_sen,quantity,reserved_quantity"
      )
      .eq("id", listingId)
      .maybeSingle(),
    supabase
      .from("offers")
      .select(OFFER_SELECT_COLUMNS)
      .eq("conversation_id", conversationId)
      .eq("listing_id", listingId)
      .eq("buyer_id", userId)
      .eq("status", "pending"),
  ]);

  const conv = convRes.data as {
    id: string;
    member_a: string;
    member_b: string;
  } | null;
  const listing = listingRes.data as {
    id: string;
    seller_id: string;
    title: string;
    kind: string;
    is_food: boolean | null;
    availability_mode: string | null;
    has_variants: boolean | null;
    status: string;
    allow_offers: boolean | null;
    price_sen: number | null;
    quantity: number | null;
    reserved_quantity: number | null;
  } | null;

  if (!conv) {
    return { ok: false, error: "Conversation not found or access denied." };
  }
  if (!listing) {
    return { ok: false, error: "Listing not found." };
  }

  const isParticipant = conv.member_a === userId || conv.member_b === userId;
  const isBlocked = isParticipant
    ? await checkMemberBlocked(supabase, userId, listing.seller_id)
    : false;

  const nowMs = Date.now();
  const hasActivePendingOffer = ((pendingRes.data ?? []) as RawOfferRow[]).some(
    (row) => resolveEffectiveOfferStatus(mapRawOffer(row), nowMs) === "pending"
  );

  const hasVariants = Boolean(listing.has_variants);
  let effectivePriceSen = Number(listing.price_sen ?? 0);
  let availableStock = Math.max(
    0,
    Number(listing.quantity ?? 0) -
      Math.max(0, Number(listing.reserved_quantity ?? 0))
  );
  let variantActive = true;
  let variantLabel: string | null = null;

  if (hasVariants && variantId && isValidUuid(variantId)) {
    const { data: vRow } = await supabase
      .from("listing_variants")
      .select("id,option_values,price_sen,quantity,reserved_quantity,active")
      .eq("id", variantId)
      .eq("listing_id", listing.id)
      .maybeSingle();

    const variant = vRow as {
      id: string;
      option_values: Record<string, string> | null;
      price_sen: number;
      quantity: number;
      reserved_quantity: number;
      active: boolean | null;
    } | null;

    if (!variant) {
      variantActive = false;
      availableStock = 0;
    } else {
      variantActive = variant.active !== false;
      effectivePriceSen = Number(variant.price_sen ?? 0);
      availableStock = Math.max(
        0,
        Number(variant.quantity ?? 0) -
          Math.max(0, Number(variant.reserved_quantity ?? 0))
      );
      variantLabel =
        variant.option_values && typeof variant.option_values === "object"
          ? Object.values(variant.option_values).filter(Boolean).join(" / ") ||
            null
          : null;
    }
  }

  const offerPriceSen = parseOfferPriceRmToSen(input.amountRm ?? "");
  const validation = validateCreateOffer({
    eligibility,
    conversationId,
    listingId,
    sellerId: listing.seller_id,
    listingKind: listing.kind,
    listingIsFood: Boolean(listing.is_food),
    listingAvailabilityMode: listing.availability_mode ?? null,
    hasVariants,
    variantId,
    variantActive,
    listingStatus: listing.status,
    allowOffers: Boolean(listing.allow_offers),
    listingPriceSen: effectivePriceSen,
    availableStock,
    offerPriceSen,
    isParticipant,
    isBlocked,
    hasActivePendingOffer,
  });

  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }

  const insertPayload: Record<string, unknown> = {
    conversation_id: conversationId,
    listing_id: listingId,
    buyer_id: userId,
    seller_id: listing.seller_id,
    offer_price_sen: validation.offerPriceSen,
    status: "pending",
  };
  if (hasVariants && variantId) {
    insertPayload.variant_id = variantId;
  }

  const { data: inserted, error: insertErr } = await supabase
    .from("offers")
    .insert(insertPayload)
    .select(OFFER_SELECT_COLUMNS)
    .single();

  if (insertErr || !inserted) {
    const errMsg = insertErr?.message ?? "";
    if (/variant_id/i.test(errMsg)) {
      return {
        ok: false,
        migrationRequired: true,
        error:
          "Variant bargaining requires applying docs/sql/phase-10-bargaining-eligibility.sql on Supabase first.",
      };
    }
    return {
      ok: false,
      error: errMsg
        ? `Could not submit offer: ${errMsg}`
        : "Could not submit offer right now. Please retry.",
    };
  }

  const mapped = mapRawOffer(inserted as RawOfferRow, variantLabel);
  const senderDisplayName =
    session.profile?.display_name?.trim() ||
    session.profile?.full_name?.trim() ||
    "UMS Buyer";

  await Promise.allSettled([
    supabase
      .from("conversations")
      .update({ last_message_at: mapped.createdAt })
      .eq("id", conversationId),
    createRecipientMessageNotification({
      recipientUserId: listing.seller_id,
      conversationId,
      senderDisplayName,
      previewText: `Offered ${formatSenToRm(mapped.offerPriceSen)} for ${listing.title}`,
    }),
  ]);

  return { ok: true, offer: mapped };
}

/**
 * Buyer cancels their own unexpired pending offer.
 */
export async function cancelOfferAction(
  offerId: string
): Promise<OfferActionResult> {
  const session = await getSessionSummary();
  const eligibility = evaluateMessagingEligibility(session);

  if (!eligibility.eligible || !eligibility.userId || !isValidUuid(offerId)) {
    return { ok: false, error: "Unable to cancel this offer." };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, error: "Bargaining service unavailable." };
  }

  const { data: rawOffer, error: fetchErr } = await supabase
    .from("offers")
    .select(OFFER_SELECT_COLUMNS)
    .eq("id", offerId)
    .maybeSingle();

  if (fetchErr || !rawOffer) {
    return { ok: false, error: "Offer not found." };
  }

  const offer = mapRawOffer(rawOffer as RawOfferRow);
  const check = validateOfferTransition({
    action: "cancel",
    eligibility,
    offer,
    isBlocked: false,
    nowMs: Date.now(),
  });

  if (!check.ok) {
    return { ok: false, error: check.error };
  }

  const { data: updated, error: updateErr } = await supabase
    .from("offers")
    .update({
      status: "cancelled",
      responded_at: new Date().toISOString(),
    })
    .eq("id", offer.id)
    .or(`buyer_id.eq.${eligibility.userId},seller_id.eq.${eligibility.userId}`)
    .eq("status", "pending")
    .select(OFFER_SELECT_COLUMNS)
    .maybeSingle();

  if (updateErr || !updated) {
    return {
      ok: false,
      error: "Offer could not be cancelled (it may have already been answered).",
    };
  }

  return { ok: true, offer: mapRawOffer(updated as RawOfferRow) };
}

/**
 * Receiving party declines an unexpired pending offer or counter offer.
 */
export async function declineOfferAction(
  offerId: string
): Promise<OfferActionResult> {
  const session = await getSessionSummary();
  const eligibility = evaluateMessagingEligibility(session);

  if (!eligibility.eligible || !eligibility.userId || !isValidUuid(offerId)) {
    return { ok: false, error: "Unable to decline this offer." };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, error: "Bargaining service unavailable." };
  }

  const { data: rawOffer, error: fetchErr } = await supabase
    .from("offers")
    .select(OFFER_SELECT_COLUMNS)
    .eq("id", offerId)
    .maybeSingle();

  if (fetchErr || !rawOffer) {
    return { ok: false, error: "Offer not found." };
  }

  const offer = mapRawOffer(rawOffer as RawOfferRow);
  const check = validateOfferTransition({
    action: "decline",
    eligibility,
    offer,
    isBlocked: false,
    nowMs: Date.now(),
  });

  if (!check.ok) {
    return { ok: false, error: check.error };
  }

  const { data: updated, error: updateErr } = await supabase
    .from("offers")
    .update({
      status: "declined",
      responded_at: new Date().toISOString(),
    })
    .eq("id", offer.id)
    .or(`buyer_id.eq.${eligibility.userId},seller_id.eq.${eligibility.userId}`)
    .eq("status", "pending")
    .select(OFFER_SELECT_COLUMNS)
    .maybeSingle();

  if (updateErr || !updated) {
    return {
      ok: false,
      error: "Offer could not be declined (it may have already been updated).",
    };
  }

  const mapped = mapRawOffer(updated as RawOfferRow);
  const recipientUserId = getOfferProposerId(mapped);
  const actorDisplayName =
    session.profile?.display_name?.trim() ||
    session.profile?.full_name?.trim() ||
    "UMS Member";

  await Promise.allSettled([
    createRecipientMessageNotification({
      recipientUserId,
      conversationId: mapped.conversationId,
      senderDisplayName: actorDisplayName,
      previewText: `Declined your ${formatSenToRm(mapped.offerPriceSen)} ${mapped.parentOfferId ? "counter offer" : "offer"}`,
    }),
  ]);

  return { ok: true, offer: mapped };
}

interface OfferListingContext {
  isBlocked: boolean;
  listingStatus: string;
  listingKind: string;
  listingIsFood: boolean;
  listingAvailabilityMode: string | null;
  allowOffers: boolean;
  effectivePriceSen: number;
  availableStock: number;
  listingTitle: string;
}

async function loadOfferListingContext(
  supabase: NonNullable<Awaited<ReturnType<typeof createSupabaseServerClient>>>,
  offer: OfferCardItem
): Promise<OfferListingContext> {
  const [isBlocked, listingRes] = await Promise.all([
    checkMemberBlocked(supabase, offer.buyerId, offer.sellerId),
    supabase
      .from("listings")
      .select(
        "title,status,kind,is_food,availability_mode,has_variants,allow_offers,price_sen,quantity,reserved_quantity"
      )
      .eq("id", offer.listingId)
      .maybeSingle(),
  ]);

  const listing = listingRes.data as {
    title?: string | null;
    status: string;
    kind: string;
    is_food: boolean | null;
    availability_mode: string | null;
    has_variants: boolean | null;
    allow_offers: boolean | null;
    price_sen: number | null;
    quantity: number | null;
    reserved_quantity: number | null;
  } | null;

  let effectivePriceSen = Number(listing?.price_sen ?? 0);
  let availableStock = listing
    ? Math.max(
        0,
        Number(listing.quantity ?? 0) -
          Math.max(0, Number(listing.reserved_quantity ?? 0))
      )
    : 0;

  if (listing?.has_variants && offer.variantId && isValidUuid(offer.variantId)) {
    const { data: vRow } = await supabase
      .from("listing_variants")
      .select("price_sen,quantity,reserved_quantity,active")
      .eq("id", offer.variantId)
      .eq("listing_id", offer.listingId)
      .maybeSingle();
    const v = vRow as {
      price_sen: number;
      quantity: number;
      reserved_quantity: number;
      active: boolean | null;
    } | null;
    if (v) {
      effectivePriceSen = Number(v.price_sen ?? effectivePriceSen);
    }
    availableStock =
      v && v.active !== false
        ? Math.max(
            0,
            Number(v.quantity ?? 0) - Math.max(0, Number(v.reserved_quantity ?? 0))
          )
        : 0;
  }

  return {
    isBlocked,
    listingStatus: listing?.status ?? "unavailable",
    listingKind: listing?.kind ?? "unknown",
    listingIsFood: Boolean(listing?.is_food),
    listingAvailabilityMode: listing?.availability_mode ?? null,
    allowOffers: Boolean(listing?.allow_offers),
    effectivePriceSen,
    availableStock,
    listingTitle: listing?.title?.trim() || "listing",
  };
}

/**
 * Receiving party accepts a pending offer via `accept_offer_atomic`
 * (reserves exactly 1 unit for 30 minutes).
 */
export async function acceptOfferAction(
  offerId: string
): Promise<OfferActionResult> {
  const session = await getSessionSummary();
  const eligibility = evaluateMessagingEligibility(session);

  if (!eligibility.eligible || !eligibility.userId || !isValidUuid(offerId)) {
    return { ok: false, error: "Unable to accept this offer." };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, error: "Bargaining service unavailable." };
  }

  const { data: rawOffer, error: fetchErr } = await supabase
    .from("offers")
    .select(OFFER_SELECT_COLUMNS)
    .eq("id", offerId)
    .maybeSingle();

  if (fetchErr || !rawOffer) {
    return { ok: false, error: "Offer not found." };
  }

  const offer = mapRawOffer(rawOffer as RawOfferRow);
  const ctx = await loadOfferListingContext(supabase, offer);

  const check = validateOfferTransition({
    action: "accept",
    eligibility,
    offer,
    isBlocked: ctx.isBlocked,
    listingStatus: ctx.listingStatus,
    listingKind: ctx.listingKind,
    listingIsFood: ctx.listingIsFood,
    listingAvailabilityMode: ctx.listingAvailabilityMode,
    allowOffers: ctx.allowOffers,
    availableStock: ctx.availableStock,
    nowMs: Date.now(),
  });

  if (!check.ok) {
    return { ok: false, error: check.error };
  }

  // Strictly invoke atomic RPC — never fake reservation with separate updates
  const { data: rpcRow, error: rpcErr } = await supabase.rpc(
    "accept_offer_atomic",
    { p_offer_id: offer.id }
  );

  if (rpcErr) {
    const code = rpcErr.code ?? "";
    const msg = rpcErr.message ?? "";

    if (
      code === "PGRST202" ||
      code === "42883" ||
      /accept_offer_atomic/i.test(msg)
    ) {
      return {
        ok: false,
        migrationRequired: true,
        error:
          "Two-way atomic offer acceptance requires the Phase 10 bargaining SQL migration to be approved and applied first.",
      };
    }
    if (msg.includes("FORBIDDEN_SELLER_ONLY")) {
      return {
        ok: false,
        migrationRequired: true,
        error:
          "Accepting seller counter-offers requires applying docs/sql/phase-10-two-way-bargaining.sql first.",
      };
    }
    if (msg.includes("FORBIDDEN_RECEIVER_ONLY")) {
      return {
        ok: false,
        error: "Only the receiving party can accept this proposal.",
      };
    }
    if (msg.includes("OFFER_EXPIRED")) {
      return {
        ok: false,
        error: "This offer expired after 24 hours and can no longer be accepted.",
      };
    }
    if (msg.includes("OUT_OF_STOCK")) {
      return {
        ok: false,
        error: "Item is out of stock — unable to reserve a unit.",
      };
    }
    if (msg.includes("OFFER_NOT_PENDING")) {
      return {
        ok: false,
        error: "This offer was already accepted, countered, declined, or cancelled.",
      };
    }
    if (msg.includes("MEMBER_BLOCKED")) {
      return {
        ok: false,
        error: "Cannot accept an offer from a blocked member.",
      };
    }

    return {
      ok: false,
      error: "Could not accept offer right now. Please retry.",
    };
  }

  const mapped = mapRawOffer(rpcRow as RawOfferRow);
  const recipientUserId = getOfferProposerId(mapped);
  const actorDisplayName =
    session.profile?.display_name?.trim() ||
    session.profile?.full_name?.trim() ||
    "UMS Member";
  const isCounter = Boolean(mapped.parentOfferId);

  await Promise.allSettled([
    createRecipientMessageNotification({
      recipientUserId,
      conversationId: mapped.conversationId,
      senderDisplayName: actorDisplayName,
      previewText: isCounter
        ? `Accepted your ${formatSenToRm(mapped.offerPriceSen)} counter offer (30 min hold)`
        : `Accepted your ${formatSenToRm(mapped.offerPriceSen)} offer (reserved for 30 min)`,
    }),
  ]);

  return { ok: true, offer: mapped };
}

/**
 * Receiving party counters a pending offer or counter offer atomically via
 * `counter_offer_atomic`, superseding the prior proposal and preserving
 * listing, variation, snapshot, and image.
 */
export async function counterOfferAction(input: {
  offerId: string;
  amountRm: string;
}): Promise<OfferActionResult> {
  const session = await getSessionSummary();
  const eligibility = evaluateMessagingEligibility(session);
  const offerId = (input.offerId ?? "").trim();

  if (!eligibility.eligible || !eligibility.userId || !isValidUuid(offerId)) {
    return { ok: false, error: "Unable to send counter offer." };
  }

  const counterPriceSen = parseOfferPriceRmToSen(input.amountRm ?? "");
  if (counterPriceSen === null) {
    return {
      ok: false,
      error: "Enter a valid counter price (e.g. 18 or 18.50).",
    };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, error: "Bargaining service unavailable." };
  }

  const { data: rawOffer, error: fetchErr } = await supabase
    .from("offers")
    .select(OFFER_SELECT_COLUMNS)
    .eq("id", offerId)
    .maybeSingle();

  if (fetchErr || !rawOffer) {
    return { ok: false, error: "Offer not found." };
  }

  const offer = mapRawOffer(rawOffer as RawOfferRow);
  const ctx = await loadOfferListingContext(supabase, offer);

  const check = validateOfferTransition({
    action: "counter",
    eligibility,
    offer,
    isBlocked: ctx.isBlocked,
    listingStatus: ctx.listingStatus,
    listingKind: ctx.listingKind,
    listingIsFood: ctx.listingIsFood,
    listingAvailabilityMode: ctx.listingAvailabilityMode,
    allowOffers: ctx.allowOffers,
    listingPriceSen: ctx.effectivePriceSen,
    counterPriceSen,
    availableStock: ctx.availableStock,
    nowMs: Date.now(),
  });

  if (!check.ok) {
    return { ok: false, error: check.error };
  }

  const { data: rpcRow, error: rpcErr } = await supabase.rpc(
    "counter_offer_atomic",
    {
      p_offer_id: offer.id,
      p_counter_price_sen: counterPriceSen,
    }
  );

  if (rpcErr || !rpcRow) {
    const code = rpcErr?.code ?? "";
    const msg = rpcErr?.message ?? "";

    if (
      code === "PGRST202" ||
      code === "42883" ||
      /counter_offer_atomic/i.test(msg)
    ) {
      return {
        ok: false,
        migrationRequired: true,
        error:
          "Two-way counter offers require applying docs/sql/phase-10-two-way-bargaining.sql on Supabase first.",
      };
    }
    if (msg.includes("FORBIDDEN_RECEIVER_ONLY")) {
      return {
        ok: false,
        error: "Wait for the other party to respond before countering again.",
      };
    }
    if (msg.includes("OFFER_EXPIRED")) {
      return {
        ok: false,
        error: "This offer expired after 24 hours and can no longer be countered.",
      };
    }
    if (msg.includes("OFFER_NOT_PENDING")) {
      return {
        ok: false,
        error: "This offer is no longer pending.",
      };
    }
    if (msg.includes("OUT_OF_STOCK") || msg.includes("VARIANT_UNAVAILABLE")) {
      return {
        ok: false,
        error: "This item or variation is no longer in stock.",
      };
    }
    if (msg.includes("INVALID_OFFER_PRICE")) {
      return {
        ok: false,
        error: "Counter price must be between RM 2.00 and the listing price.",
      };
    }
    if (msg.includes("MEMBER_BLOCKED")) {
      return {
        ok: false,
        error: "Cannot counter an offer from a blocked member.",
      };
    }

    return {
      ok: false,
      error: "Could not send counter offer right now. Please retry.",
    };
  }

  const mapped = mapRawOffer(rpcRow as RawOfferRow, offer.variantLabel, offer.variantImageUrl);
  const recipientUserId =
    getOfferProposerId(mapped).toLowerCase() === mapped.buyerId.toLowerCase()
      ? mapped.sellerId
      : mapped.buyerId;
  const actorDisplayName =
    session.profile?.display_name?.trim() ||
    session.profile?.full_name?.trim() ||
    "UMS Member";

  await Promise.allSettled([
    createRecipientMessageNotification({
      recipientUserId,
      conversationId: mapped.conversationId,
      senderDisplayName: actorDisplayName,
      previewText: `Counter-offered ${formatSenToRm(mapped.offerPriceSen)} for ${ctx.listingTitle}`,
    }),
  ]);

  return {
    ok: true,
    offer: mapped,
    supersededOfferId: offer.id,
  };
}
