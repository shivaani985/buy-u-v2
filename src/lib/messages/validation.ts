import type { AuthSessionSummary } from "@/types/marketplace";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CHAT_ATTACHMENTS_BUCKET = "chat-attachments";
export const MAX_MESSAGE_BODY_LENGTH = 2000;
export const MAX_MESSAGE_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5 MB
export const MESSAGE_PAGE_SIZE = 30;

export const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
]);

export function isValidUuid(value: string | null | undefined): boolean {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

export interface MessagingEligibilityResult {
  eligible: boolean;
  userId: string | null;
  code?: "unauthenticated" | "unverified" | "restricted";
  reason?: string;
}

/**
 * Active, email-verified UMS Students and Staff can use campus messaging.
 * Dedicated admin accounts without a student/staff role do not automatically
 * receive ordinary member messaging access.
 */
export function evaluateMessagingEligibility(
  session: Pick<
    AuthSessionSummary,
    "isAuthenticated" | "isEmailVerified" | "isActiveMember" | "profile"
  >
): MessagingEligibilityResult {
  const userId = session.profile?.id ?? null;

  if (!session.isAuthenticated || !userId) {
    return {
      eligible: false,
      userId: null,
      code: "unauthenticated",
      reason: "Sign in with your UMS account to view and send messages.",
    };
  }

  if (!session.isEmailVerified) {
    return {
      eligible: false,
      userId,
      code: "unverified",
      reason: "Verify your UMS email address before messaging on Buy-U.",
    };
  }

  if (!session.isActiveMember || session.profile?.status !== "active") {
    return {
      eligible: false,
      userId,
      code: "restricted",
      reason:
        session.profile?.restriction_reason?.trim() ||
        "Your account is currently restricted from messaging.",
    };
  }

  const role = (session.profile?.university_role ?? "").toLowerCase();
  if (role !== "student" && role !== "staff") {
    return {
      eligible: false,
      userId,
      code: "restricted",
      reason: "Only active UMS Students and Staff can use campus messaging.",
    };
  }

  return { eligible: true, userId };
}

/**
 * Canonical (member_a, member_b) ordering prevents duplicate conversations
 * between the same two members and rejects self-messaging.
 */
export function canonicalConversationPair(
  userA: string,
  userB: string
): { memberA: string; memberB: string } | null {
  if (!isValidUuid(userA) || !isValidUuid(userB)) return null;
  const a = userA.trim().toLowerCase();
  const b = userB.trim().toLowerCase();
  if (a === b) return null;
  return a < b ? { memberA: a, memberB: b } : { memberA: b, memberB: a };
}

export function validateStartConversation(input: {
  eligibility: MessagingEligibilityResult;
  peerUserId: string;
  listingId?: string | null;
  isBlocked: boolean;
}): { ok: true; memberA: string; memberB: string } | { ok: false; error: string } {
  if (!input.eligibility.eligible || !input.eligibility.userId) {
    return {
      ok: false,
      error: input.eligibility.reason || "Sign in to chat with sellers.",
    };
  }

  if (!isValidUuid(input.peerUserId)) {
    return { ok: false, error: "Invalid seller account identifier." };
  }

  if (input.eligibility.userId.toLowerCase() === input.peerUserId.trim().toLowerCase()) {
    return { ok: false, error: "You cannot message yourself." };
  }

  if (input.listingId && !isValidUuid(input.listingId)) {
    return { ok: false, error: "Invalid listing reference." };
  }

  if (input.isBlocked) {
    return {
      ok: false,
      error: "Messaging is unavailable because one of you has blocked the other.",
    };
  }

  const pair = canonicalConversationPair(
    input.eligibility.userId,
    input.peerUserId
  );
  if (!pair) {
    return { ok: false, error: "Unable to start this conversation." };
  }

  return { ok: true, ...pair };
}

export function isAttachmentPathAuthorized(
  conversationId: string,
  rawPath: string
): boolean {
  if (!isValidUuid(conversationId) || typeof rawPath !== "string") return false;
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("..") || trimmed.includes("\\")) {
    return false;
  }
  const prefix = `${conversationId.trim().toLowerCase()}/`;
  if (!trimmed.toLowerCase().startsWith(prefix)) return false;
  const rest = trimmed.slice(prefix.length);
  return rest.length > 0 && !rest.endsWith("/");
}

export function validateAttachmentFileMeta(input: {
  name: string;
  type: string;
  size: number;
}): { ok: true } | { ok: false; error: string } {
  if (!ALLOWED_ATTACHMENT_MIME_TYPES.has(input.type.toLowerCase())) {
    return {
      ok: false,
      error: "Only JPG, PNG, WebP, GIF images and PDF files are supported.",
    };
  }
  if (!Number.isFinite(input.size) || input.size <= 0) {
    return { ok: false, error: "Attachment file is empty." };
  }
  if (input.size > MAX_ATTACHMENT_BYTES) {
    return { ok: false, error: "Attachment exceeds the 5 MB limit." };
  }
  return { ok: true };
}

export function validateMessageInput(input: {
  eligibility: MessagingEligibilityResult;
  conversationId: string;
  isParticipant: boolean;
  isBlocked: boolean;
  body: string;
  attachmentPaths?: string[];
  listingId?: string | null;
}):
  | { ok: true; trimmedBody: string; imagePaths: string[]; listingId: string | null }
  | { ok: false; error: string } {
  if (!input.eligibility.eligible || !input.eligibility.userId) {
    return {
      ok: false,
      error: input.eligibility.reason || "Sign in to send messages.",
    };
  }

  if (!isValidUuid(input.conversationId)) {
    return { ok: false, error: "Invalid conversation identifier." };
  }

  if (!input.isParticipant) {
    return {
      ok: false,
      error: "You do not have access to this conversation.",
    };
  }

  if (input.isBlocked) {
    return {
      ok: false,
      error: "You cannot send messages in a blocked conversation.",
    };
  }

  const trimmedBody = (input.body ?? "").trim();
  if (trimmedBody.length > MAX_MESSAGE_BODY_LENGTH) {
    return {
      ok: false,
      error: `Message must be ${MAX_MESSAGE_BODY_LENGTH} characters or fewer.`,
    };
  }

  const rawPaths = input.attachmentPaths ?? [];
  if (rawPaths.length > MAX_MESSAGE_ATTACHMENTS) {
    return {
      ok: false,
      error: `You can attach up to ${MAX_MESSAGE_ATTACHMENTS} files per message.`,
    };
  }

  const imagePaths: string[] = [];
  for (const p of rawPaths) {
    if (!isAttachmentPathAuthorized(input.conversationId, p)) {
      return { ok: false, error: "Invalid or unauthorized attachment path." };
    }
    imagePaths.push(p.trim());
  }

  if (trimmedBody.length === 0 && imagePaths.length === 0) {
    return {
      ok: false,
      error: "Write a message or attach a file before sending.",
    };
  }

  const normalizedListingId =
    input.listingId && isValidUuid(input.listingId)
      ? input.listingId.trim()
      : null;

  return {
    ok: true,
    trimmedBody,
    imagePaths,
    listingId: normalizedListingId,
  };
}

export interface OrderableMessage {
  id: string;
  createdAt: string;
}

/**
 * Deduplicates by message ID and sorts chronologically (createdAt ASC, id ASC).
 */
export function mergeOrderedMessages<T extends OrderableMessage>(
  existing: T[],
  incoming: T[]
): T[] {
  const byId = new Map<string, T>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);

  return Array.from(byId.values()).sort((a, b) => {
    const timeDiff =
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    if (timeDiff !== 0) return timeDiff;
    return a.id.localeCompare(b.id);
  });
}

export interface UnreadNotificationRow {
  id: string;
  kind: string;
  href: string | null;
  read_at: string | null;
}

const MESSAGE_NOTIFICATION_KINDS = new Set(["new_message", "message"]);
const CONV_ID_IN_HREF_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Derives per-conversation and total unread message counts strictly from real
 * unread `notifications` rows (no fabricated counts, no nonexistent `messages.read_at`).
 */
export function countUnreadByConversation(rows: UnreadNotificationRow[]): {
  byConversation: Record<string, number>;
  totalUnread: number;
} {
  const byConversation: Record<string, number> = {};
  let totalUnread = 0;

  for (const row of rows) {
    if (row.read_at !== null) continue;
    if (!MESSAGE_NOTIFICATION_KINDS.has((row.kind ?? "").toLowerCase())) continue;

    totalUnread += 1;
    const match = row.href?.match(CONV_ID_IN_HREF_RE);
    if (match) {
      const cid = match[0].toLowerCase();
      byConversation[cid] = (byConversation[cid] ?? 0) + 1;
    }
  }

  return { byConversation, totalUnread };
}
