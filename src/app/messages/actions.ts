"use server";

import { revalidatePath } from "next/cache";
import { mapRawMessage, type ChatMessageItem } from "@/lib/messages/data";
import {
  CHAT_ATTACHMENTS_BUCKET,
  evaluateMessagingEligibility,
  isValidUuid,
  MAX_MESSAGE_ATTACHMENTS,
  MESSAGE_PAGE_SIZE,
  validateAttachmentFileMeta,
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

function sanitizeFileName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_{2,}/g, "_")
    .slice(0, 64);
  return cleaned || "attachment";
}

export async function startConversationAction(input: {
  sellerId: string;
  listingId?: string | null;
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
  const peerId = (input.sellerId ?? "").trim();

  const { data: blockRows } = isValidUuid(peerId)
    ? await supabase
        .from("member_blocks")
        .select("blocker_id,blocked_id")
        .or(
          `and(blocker_id.eq.${userId},blocked_id.eq.${peerId}),and(blocker_id.eq.${peerId},blocked_id.eq.${userId})`
        )
        .limit(1)
    : { data: [] };

  const check = validateStartConversation({
    eligibility,
    peerUserId: peerId,
    listingId: input.listingId ?? null,
    isBlocked: Array.isArray(blockRows) && blockRows.length > 0,
  });

  if (!check.ok) {
    return { ok: false, error: check.error };
  }

  // Reuse existing canonical conversation if present
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
      // Handle concurrent creation race cleanly
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

  revalidatePath("/messages");

  const listingParam =
    input.listingId && isValidUuid(input.listingId)
      ? `&listing=${encodeURIComponent(input.listingId.trim())}`
      : "";

  return {
    ok: true,
    conversationId,
    href: `/messages?c=${encodeURIComponent(conversationId)}${listingParam}`,
  };
}

export async function sendMessageAction(
  formData: FormData
): Promise<SendMessageResult> {
  const session = await getSessionSummary();
  const eligibility = evaluateMessagingEligibility(session);

  if (!eligibility.eligible || !eligibility.userId) {
    return {
      ok: false,
      error: eligibility.reason || "Sign in with your UMS account to send messages.",
    };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, error: "Messaging service unavailable." };
  }

  const userId = eligibility.userId;
  const conversationId = String(formData.get("conversationId") ?? "").trim();
  const body = String(formData.get("body") ?? "");
  const rawListingId = String(formData.get("listingId") ?? "").trim();
  const listingId = rawListingId.length > 0 ? rawListingId : null;

  if (!isValidUuid(conversationId)) {
    return { ok: false, error: "Invalid conversation identifier." };
  }

  // Verify participant ownership
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

  const { data: blockRows } = isParticipant
    ? await supabase
        .from("member_blocks")
        .select("blocker_id,blocked_id")
        .or(
          `and(blocker_id.eq.${userId},blocked_id.eq.${peerId}),and(blocker_id.eq.${peerId},blocked_id.eq.${userId})`
        )
        .limit(1)
    : { data: [] };
  const isBlocked = Array.isArray(blockRows) && blockRows.length > 0;

  // Validate and upload optional private attachments
  const uploadedFiles = formData
    .getAll("attachments")
    .filter((entry): entry is File => entry instanceof File && entry.size > 0);

  if (uploadedFiles.length > MAX_MESSAGE_ATTACHMENTS) {
    return {
      ok: false,
      error: `You can attach up to ${MAX_MESSAGE_ATTACHMENTS} files per message.`,
    };
  }

  for (const file of uploadedFiles) {
    const fileCheck = validateAttachmentFileMeta({
      name: file.name,
      type: file.type,
      size: file.size,
    });
    if (!fileCheck.ok) {
      return { ok: false, error: fileCheck.error };
    }
  }

  const uploadedPaths: string[] = [];
  if (isParticipant && !isBlocked && uploadedFiles.length > 0) {
    for (let i = 0; i < uploadedFiles.length; i += 1) {
      const file = uploadedFiles[i]!;
      const safeName = sanitizeFileName(file.name);
      const storagePath = `${conversationId}/${userId}/${Date.now()}-${i}-${safeName}`;
      const { error: uploadErr } = await supabase.storage
        .from(CHAT_ATTACHMENTS_BUCKET)
        .upload(storagePath, file, {
          contentType: file.type,
          upsert: false,
        });

      if (uploadErr) {
        return {
          ok: false,
          error: "Could not upload attachment. Please check file size and try again.",
        };
      }
      uploadedPaths.push(storagePath);
    }
  }

  const validation = validateMessageInput({
    eligibility,
    conversationId,
    isParticipant,
    isBlocked,
    body,
    attachmentPaths: uploadedPaths,
    listingId,
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
    })
    .select(
      "id,conversation_id,sender_id,body,image_paths,listing_id,order_id,free_notice_id,service_request_id,edited_at,created_at"
    )
    .single();

  if (insertErr || !inserted) {
    return {
      ok: false,
      error: "Could not send message right now. Please retry.",
    };
  }

  const mapped = mapRawMessage(
    inserted as Parameters<typeof mapRawMessage>[0]
  );

  // Update conversation timestamp and best-effort unread notification for peer
  await Promise.allSettled([
    supabase
      .from("conversations")
      .update({ last_message_at: mapped.createdAt })
      .eq("id", conversationId),
    supabase.from("notifications").insert({
      user_id: peerId,
      kind: "new_message",
      title: `New message from ${session.profile?.display_name || "UMS Member"}`,
      body:
        validation.trimmedBody.slice(0, 120) ||
        "Sent a private attachment",
      href: `/messages?c=${conversationId}`,
    }),
  ]);

  revalidatePath("/");
  revalidatePath("/messages");

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
): Promise<{ ok: boolean }> {
  const session = await getSessionSummary();
  const eligibility = evaluateMessagingEligibility(session);

  if (!eligibility.eligible || !eligibility.userId || !isValidUuid(conversationId)) {
    return { ok: false };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false };

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

  revalidatePath("/");
  revalidatePath("/messages");
  return { ok: true };
}
