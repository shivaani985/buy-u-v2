"use server";

import { revalidatePath } from "next/cache";
import { mapRawMessage, type ChatMessageItem } from "@/lib/messages/data";
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
import { createRecipientMessageNotification } from "@/lib/supabase/service";

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
  initialMessage?: string | null;
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

  const isBlocked =
    !validOrderId && isValidUuid(peerId)
      ? await checkBlockedBidirectional(supabase, userId, peerId)
      : false;

  const check = validateStartConversation({
    eligibility,
    peerUserId: peerId,
    listingId: freeNoticeId ? null : input.listingId ?? null,
    isBlocked,
  });

  if (!check.ok) {
    return { ok: false, error: check.error };
  }

  const { data: existing, error: fetchErr } = await supabase
    .from("conversations")
    .select("id")
    .eq("member_a", check.memberA)
    .eq("member_b", check.memberB)
    .maybeSingle();

  if (fetchErr) {
    return { ok: false, error: "Could not open conversation right now." };
  }

  let conversationId = (existing as { id?: string } | null)?.id ?? null;

  if (!conversationId) {
    const nowIso = new Date().toISOString();
    const { data: created, error: insertErr } = await supabase
      .from("conversations")
      .insert({
        member_a: check.memberA,
        member_b: check.memberB,
        last_message_at: nowIso,
      })
      .select("id")
      .single();

    if (insertErr) {
      if (insertErr.code === "23505") {
        const { data: raced } = await supabase
          .from("conversations")
          .select("id")
          .eq("member_a", check.memberA)
          .eq("member_b", check.memberB)
          .maybeSingle();
        conversationId = (raced as { id?: string } | null)?.id ?? null;
      } else {
        return { ok: false, error: "Could not start this conversation." };
      }
    } else {
      conversationId = (created as { id?: string } | null)?.id ?? null;
    }
  }

  if (!conversationId) {
    return { ok: false, error: "Conversation could not be initialized." };
  }

  const trimmedInitial = freeNoticeId ? "" : (input.initialMessage ?? "").trim();
  if (trimmedInitial.length > 0) {
    // Prevent duplicate automatic greetings when reopening an existing conversation for this order/listing
    let msgQuery = supabase
      .from("messages")
      .select("id")
      .eq("conversation_id", conversationId)
      .limit(1);
    if (validOrderId) {
      msgQuery = msgQuery.eq("order_id", validOrderId);
    } else if (input.listingId && isValidUuid(input.listingId)) {
      msgQuery = msgQuery.eq("listing_id", input.listingId.trim());
    }
    const { data: existingMsgs } = await msgQuery;
    if (!existingMsgs || existingMsgs.length === 0) {
      await sendMessageAction({
        conversationId,
        body: trimmedInitial,
        listingId: input.listingId ?? null,
        orderId: validOrderId,
      });
    }
  }

  revalidatePath("/messages");

  const listingParam =
    input.listingId && isValidUuid(input.listingId)
      ? `&listing=${encodeURIComponent(input.listingId.trim())}`
      : "";
  const variantParam =
    input.variantId && isValidUuid(input.variantId)
      ? `&variant=${encodeURIComponent(input.variantId.trim())}`
      : "";
  const bargainParam = input.openBargain ? "&bargain=1" : "";

  if (freeNoticeId) {
    return { ok: true, conversationId, href: `/messages?c=${encodeURIComponent(conversationId)}&freeItem=${encodeURIComponent(freeNoticeId)}` };
  }

  return {
    ok: true,
    conversationId,
    href: `/messages?c=${encodeURIComponent(conversationId)}${listingParam}${variantParam}${bargainParam}`,
  };
}

/**
 * Persists a validated message (with optional pre-uploaded private attachment
 * paths under `senderUid/conversationId/...`) and creates the recipient's
 * unread notification through the authorized server-only helper.
 */
export async function sendMessageAction(input: {
  conversationId: string;
  body: string;
  attachmentPaths?: string[];
  listingId?: string | null;
  orderId?: string | null;
}): Promise<SendMessageResult> {
  const session = await getSessionSummary();
  const eligibility = evaluateMessagingEligibility(session);

  if (!eligibility.eligible || !eligibility.userId) {
    return {
      ok: false,
      error:
        eligibility.reason || "Sign in with your UMS account to send messages.",
    };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, error: "Messaging service unavailable." };
  }

  const userId = eligibility.userId;
  const conversationId = (input.conversationId ?? "").trim();

  if (!isValidUuid(conversationId)) {
    return { ok: false, error: "Invalid conversation identifier." };
  }

  const { data: convRow, error: convErr } = await supabase
    .from("conversations")
    .select("id,member_a,member_b")
    .eq("id", conversationId)
    .maybeSingle();

  if (convErr || !convRow) {
    return { ok: false, error: "Conversation not found or access denied." };
  }

  const conv = convRow as { id: string; member_a: string; member_b: string };
  const isParticipant = conv.member_a === userId || conv.member_b === userId;
  const peerId = conv.member_a === userId ? conv.member_b : conv.member_a;

  const isBlocked = isParticipant
    ? await checkBlockedBidirectional(supabase, userId, peerId)
    : false;

  const cleanOrderId =
    input.orderId && isValidUuid(input.orderId.trim())
      ? input.orderId.trim()
      : null;

  // If blocked, ordinary messages are denied; only verified active paid/disputed order messages proceed to DB trigger verification
  const validation = validateMessageInput({
    eligibility,
    conversationId,
    isParticipant,
    isBlocked: isBlocked && !cleanOrderId,
    body: input.body ?? "",
    attachmentPaths: input.attachmentPaths ?? [],
    listingId: input.listingId ?? null,
  });

  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }

  const { data: inserted, error: insertErr } = await supabase
    .from("messages")
    .insert({
      conversation_id: conversationId,
      sender_id: userId,
      body: validation.trimmedBody,
      image_paths: validation.imagePaths,
      listing_id: validation.listingId,
      ...(cleanOrderId ? { order_id: cleanOrderId } : {}),
    })
    .select(
      "id,conversation_id,sender_id,body,image_paths,listing_id,order_id,free_notice_id,service_request_id,edited_at,created_at"
    )
    .single();

  if (insertErr || !inserted) {
    return {
      ok: false,
      error: insertErr?.message
        ? `Could not send message: ${insertErr.message}`
        : "Could not send message right now. Please retry.",
    };
  }

  const mapped = mapRawMessage(
    inserted as Parameters<typeof mapRawMessage>[0]
  );

  const senderDisplayName =
    session.profile?.display_name?.trim() ||
    session.profile?.full_name?.trim() ||
    "UMS Member";
  const previewText =
    validation.trimmedBody ||
    (validation.imagePaths.length === 1
      ? "Sent an attachment"
      : `Sent ${validation.imagePaths.length} attachments`);

  // Update conversation timestamp + create recipient unread notification server-side.
  await Promise.allSettled([
    supabase
      .from("conversations")
      .update({ last_message_at: mapped.createdAt })
      .eq("id", conversationId),
    createRecipientMessageNotification({
      recipientUserId: peerId,
      conversationId,
      senderDisplayName,
      previewText,
    }),
  ]);

  return { ok: true, message: mapped };
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
    .select(
      "id,conversation_id,sender_id,body,image_paths,listing_id,order_id,free_notice_id,service_request_id,edited_at,created_at"
    )
    .eq("conversation_id", input.conversationId)
    .lt("created_at", input.beforeCreatedAt)
    .order("created_at", { ascending: false })
    .limit(MESSAGE_PAGE_SIZE + 1);

  if (error) {
    return { ok: false, error: "Could not load older messages." };
  }

  const rawRows = (rows ?? []) as Parameters<typeof mapRawMessage>[0][];
  const hasOlder = rawRows.length > MESSAGE_PAGE_SIZE;
  const page = (hasOlder ? rawRows.slice(0, MESSAGE_PAGE_SIZE) : rawRows)
    .reverse()
    .map(mapRawMessage);

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
