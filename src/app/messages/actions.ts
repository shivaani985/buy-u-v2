"use server";

import { revalidatePath } from "next/cache";
import { CHAT_MESSAGE_FIELDS, mapRawMessage, type ChatMessageItem } from "@/lib/messages/data";
import { contextArgs, loadChatReferences, parseChatTarget, type ChatTarget } from "@/lib/messages/context";
import {
  evaluateMessagingEligibility,
  isValidUuid,
  MESSAGE_PAGE_SIZE,
  validateMessageInput,
  validateStartConversation,
} from "@/lib/messages/validation";
import {
  createSupabaseServerClient,
  getSessionSummary,
} from "@/lib/supabase/server";

export interface StartConversationResult {
  ok: boolean;
  conversationId?: string;
  href?: string;
  error?: string;
}

export interface SendMessageResult {
  ok: boolean;
  message?: ChatMessageItem;
  error?: string;
}

export interface LoadOlderMessagesResult {
  ok: boolean;
  messages?: ChatMessageItem[];
  hasOlder?: boolean;
  error?: string;
}

async function checkBlockedBidirectional(
  supabase: NonNullable<Awaited<ReturnType<typeof createSupabaseServerClient>>>,
  userA: string,
  userB: string
): Promise<boolean> {
  const { data: rpcBlocked, error: rpcErr } = await supabase.rpc(
    "is_member_blocked_between",
    { p_user_a: userA, p_user_b: userB }
  );
  if (!rpcErr && typeof rpcBlocked === "boolean") {
    return rpcBlocked;
  }
  const { data } = await supabase
    .from("member_blocks")
    .select("blocker_id,blocked_id")
    .or(
      `and(blocker_id.eq.${userA},blocked_id.eq.${userB}),and(blocker_id.eq.${userB},blocked_id.eq.${userA})`
    )
    .limit(1);
  return Array.isArray(data) && data.length > 0;
}

export async function startConversationAction(input: {
  sellerId: string;
  listingId?: string | null;
  variantId?: string | null;
  orderId?: string | null;
  freeNoticeId?: string | null;
  orderItemId?: string | null;
  openBargain?: boolean;
}): Promise<StartConversationResult> {
  const session = await getSessionSummary();
  const eligibility = evaluateMessagingEligibility(session);

  if (!eligibility.eligible || !eligibility.userId) {
    return {
      ok: false,
      error: eligibility.reason || "Sign in with your UMS account to chat.",
    };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, error: "Messaging service unavailable." };
  }

  const userId = eligibility.userId;
  const freeNoticeId = input.freeNoticeId?.trim() || null;
  const rawOrderId = freeNoticeId ? "" : (input.orderId ?? "").trim();
  let validOrderId: string | null = null;
  let peerId = (input.sellerId ?? "").trim();

  if (freeNoticeId) {
    if (!isValidUuid(freeNoticeId)) return { ok: false, error: "Invalid free item reference." };
    const { data: notice } = await supabase.from("free_notices").select("contributor_id")
      .eq("id", freeNoticeId).eq("status", "active").not("pickup_location", "is", null)
      .gt("expires_at", new Date().toISOString()).maybeSingle();
    if (!notice) return { ok: false, error: "This free item post is no longer available." };
    peerId = notice.contributor_id;
  }

  // When an orderId is supplied, authorize participant membership and derive counterparty from the actual order
  if (rawOrderId.length > 0) {
    if (!isValidUuid(rawOrderId)) {
      return { ok: false, error: "Invalid order reference." };
    }
    const { data: orderRow, error: orderErr } = await supabase
      .from("orders")
      .select("id,buyer_id,seller_id")
      .eq("id", rawOrderId)
      .maybeSingle();

    const typedOrder = orderRow as {
      id: string;
      buyer_id: string;
      seller_id: string;
    } | null;

    if (
      orderErr ||
      !typedOrder ||
      (typedOrder.buyer_id !== userId && typedOrder.seller_id !== userId)
    ) {
      return {
        ok: false,
        error: "You are not authorized to open chat for this order.",
      };
    }

    validOrderId = typedOrder.id;
    peerId =
      typedOrder.buyer_id === userId
        ? typedOrder.seller_id
        : typedOrder.buyer_id;
  }

  const listingId = input.listingId?.trim() || null;
  const variantId = input.variantId?.trim() || null;
  const orderItemId = input.orderItemId?.trim() || null;
  let target: ChatTarget | null = null;
  if (validOrderId) {
    if (orderItemId) {
      if (!isValidUuid(orderItemId)) return { ok: false, error: "Invalid purchased item." };
      const { data } = await supabase.from("order_items").select("id")
        .eq("order_id", validOrderId).eq("id", orderItemId).maybeSingle();
      if (!data) return { ok: false, error: "Purchased item unavailable." };
    }
    target = { kind: "order", targetId: validOrderId, itemId: orderItemId };
  } else if (freeNoticeId) {
    target = { kind: "free", targetId: freeNoticeId };
  } else if (listingId) {
    if (!isValidUuid(listingId) || (variantId && !isValidUuid(variantId))) {
      return { ok: false, error: "Invalid listing or selected variation." };
    }
    const { data: listing } = await supabase.from("listings").select("kind,has_variants")
      .eq("id", listingId).eq("seller_id", peerId).eq("status", "published").maybeSingle();
    if (!listing) return { ok: false, error: "This listing is no longer available." };
    if (variantId) {
      const { data } = await supabase.from("listing_variants").select("id")
        .eq("id", variantId).eq("listing_id", listingId).eq("active", true).maybeSingle();
      if (!listing.has_variants || !data) return { ok: false, error: "This variation is no longer available." };
    }
    target = { kind: listing.kind === "service" ? "service" : "product", targetId: listingId, variantId };
  }

  const isBlocked = !validOrderId && isValidUuid(peerId)
    ? await checkBlockedBidirectional(supabase, userId, peerId)
    : false;
  const check = validateStartConversation({ eligibility, peerUserId: peerId, isBlocked });
  if (!check.ok) return { ok: false, error: check.error };

  const { data: conversationId, error } = await supabase.rpc("open_contextual_conversation", {
    p_peer: peerId,
    p_order: validOrderId,
  });
  if (error || typeof conversationId !== "string") {
    return { ok: false, error: error?.message.includes("INTERACTION_BLOCKED")
      ? "You cannot open this blocked conversation." : "Could not open this conversation." };
  }
  revalidatePath("/messages");
  const params = new URLSearchParams({ c: conversationId });
  if (target && input.openBargain) {
    params.set("listing", target.targetId);
    if (target.variantId) params.set("variant", target.variantId);
    params.set("bargain", "1");
  } else if (target) {
    params.set("ref", target.kind);
    params.set("target", target.targetId);
    if (target.variantId) params.set("variant", target.variantId);
    if (target.itemId) params.set("item", target.itemId);
    params.set("draft", crypto.randomUUID());
  }
  return { ok: true, conversationId, href: `/messages?${params}` };
}

export async function sendMessageAction(input: {
  messageId: string;
  conversationId: string;
  body: string;
  attachmentPaths?: string[];
  reference?: ChatTarget | null;
}): Promise<SendMessageResult> {
  const session = await getSessionSummary();
  const eligibility = evaluateMessagingEligibility(session);
  const reference = input.reference ? parseChatTarget(input.reference) : null;
  if (!isValidUuid(input.messageId) || (input.reference && !reference)) {
    return { ok: false, error: "Invalid message reference." };
  }

  const validation = validateMessageInput({
    eligibility,
    conversationId: input.conversationId,
    isParticipant: true, // The atomic RPC verifies actual membership.
    isBlocked: false, // The database also enforces the existing paid-order exception.
    body: input.body,
    attachmentPaths: input.attachmentPaths,
    hasReference: Boolean(reference),
  });
  if (!validation.ok) return { ok: false, error: validation.error };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, error: "Messaging service unavailable." };

  const { data: messageId, error } = await supabase.rpc("send_contextual_message", {
    p_message: input.messageId,
    p_conversation: input.conversationId,
    p_body: validation.trimmedBody,
    p_paths: validation.imagePaths,
    ...(reference ? contextArgs(reference) : {}),
  });
  if (error || typeof messageId !== "string") {
    const unavailable = /INVALID_CHAT_|CHAT_REFERENCE_UNAVAILABLE/.test(error?.message ?? "");
    const blocked = error?.message.includes("INTERACTION_BLOCKED");
    return { ok: false, error: unavailable ? "This reference or attachment is no longer available."
      : blocked ? "You cannot send messages in this blocked conversation." : "Could not send message. Try again." };
  }
  const [row, references] = await Promise.all([
    supabase.from("messages").select(CHAT_MESSAGE_FIELDS).eq("id", messageId).single(),
    loadChatReferences(supabase, [messageId]),
  ]);
  const savedReference = references.get(messageId);
  if (!row.data || (reference && !savedReference)) {
    return { ok: false, error: "Could not confirm delivery. Retry to check." };
  }
  return { ok: true, message: mapRawMessage(row.data, savedReference) };
}

export async function loadOlderMessagesAction(input: {
  conversationId: string;
  beforeCreatedAt: string;
}): Promise<LoadOlderMessagesResult> {
  const session = await getSessionSummary();
  const eligibility = evaluateMessagingEligibility(session);

  if (!eligibility.eligible || !eligibility.userId) {
    return { ok: false, error: "Sign in to view message history." };
  }

  if (!isValidUuid(input.conversationId) || !input.beforeCreatedAt) {
    return { ok: false, error: "Invalid pagination parameters." };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, error: "Messaging service unavailable." };
  }

  const { data: rows, error } = await supabase
    .from("messages")
    .select(CHAT_MESSAGE_FIELDS)
    .eq("conversation_id", input.conversationId)
    .lt("created_at", input.beforeCreatedAt)
    .order("created_at", { ascending: false })
    .limit(MESSAGE_PAGE_SIZE + 1);

  if (error) {
    return { ok: false, error: "Could not load older messages." };
  }

  const rawRows = (rows ?? []) as Parameters<typeof mapRawMessage>[0][];
  const hasOlder = rawRows.length > MESSAGE_PAGE_SIZE;
  const rowsToMap = (hasOlder ? rawRows.slice(0, MESSAGE_PAGE_SIZE) : rawRows).reverse();
  const references = await loadChatReferences(supabase, rowsToMap.map((row) => row.id));
  const page = rowsToMap.map((row) => mapRawMessage(row, references.get(row.id)));

  return { ok: true, messages: page, hasOlder };
}

export async function markConversationReadAction(
  conversationId: string
): Promise<{ ok: boolean; remainingUnread?: number }> {
  const session = await getSessionSummary();
  const eligibility = evaluateMessagingEligibility(session);

  if (
    !eligibility.eligible ||
    !eligibility.userId ||
    !isValidUuid(conversationId)
  ) {
    return { ok: false };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false };

  // P0.18: Prefer authorized RPC (notifications direct UPDATE revoked in Phase 7-9)
  const { data: rpcRemaining, error: rpcErr } = await supabase.rpc(
    "mark_conversation_notifications_read_atomic",
    { p_conversation_id: conversationId }
  );
  if (!rpcErr && typeof rpcRemaining === "number") {
    return { ok: true, remainingUnread: Math.max(0, rpcRemaining) };
  }

  // Pre-migration fallback
  const { error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", eligibility.userId)
    .is("read_at", null)
    .in("kind", ["new_message", "message"])
    .ilike("href", `%${conversationId}%`);

  if (error) {
    return { ok: false };
  }

  const { count } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", eligibility.userId)
    .is("read_at", null)
    .in("kind", ["new_message", "message"]);

  return {
    ok: true,
    remainingUnread: typeof count === "number" ? Math.max(0, count) : 0,
  };
}
