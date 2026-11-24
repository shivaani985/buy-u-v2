import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getPublicSupabaseEnv } from "./env";

let cachedServiceClient: SupabaseClient | null = null;

/**
 * Strictly server-only privileged client for narrow, pre-authorized backend
 * operations that RLS intentionally restricts from direct browser writes
 * (e.g., creating a recipient's `notifications` row after a verified message
 * send, or signing a private chat attachment for a verified participant).
 *
 * NEVER import this module from any client component.
 */
function getServerServiceClient(): SupabaseClient | null {
  if (typeof window !== "undefined") {
    throw new Error("Server service client cannot be used in the browser.");
  }

  const env = getPublicSupabaseEnv();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!env || !serviceRoleKey) {
    return null;
  }

  if (!cachedServiceClient) {
    cachedServiceClient = createClient(env.url, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  return cachedServiceClient;
}

/**
 * Creates an unread `new_message` notification for the verified recipient of a
 * persisted message. Caller MUST already have verified sender auth,
 * conversation participation, and non-blocked status.
 */
export async function createRecipientMessageNotification(input: {
  recipientUserId: string;
  conversationId: string;
  senderDisplayName: string;
  previewText: string;
}): Promise<{ ok: boolean; error?: string }> {
  const service = getServerServiceClient();
  if (!service) {
    return { ok: false, error: "Server notification service not configured." };
  }

  const { error } = await service.from("notifications").insert({
    user_id: input.recipientUserId,
    kind: "new_message",
    title: `New message from ${input.senderDisplayName}`,
    body: input.previewText.slice(0, 140),
    href: `/messages?c=${encodeURIComponent(input.conversationId)}`,
  });

  if (error) {
    return { ok: false, error: error.message };
  }

  return { ok: true };
}

/**
 * Generates a short-lived signed URL for a private chat attachment AFTER the
 * caller has verified authenticated participant ownership and authorized path.
 */
export async function createParticipantSignedAttachmentUrl(
  bucket: "chat-attachments" | "chat-media",
  path: string,
  expiresInSeconds = 300
): Promise<string | null> {
  const service = getServerServiceClient();
  if (!service) return null;

  const { data, error } = await service.storage
    .from(bucket)
    .createSignedUrl(path, expiresInSeconds);

  if (error || !data?.signedUrl) {
    return null;
  }
  return data.signedUrl;
}

let lastOfferReconcileMs = 0;
const RECONCILE_THROTTLE_MS = 60_000;

/**
 * Opportunistic, throttled server-side trigger for
 * `release_expired_offer_reservations()` so expired 30-minute offer holds are
 * automatically released even on Supabase tiers without `pg_cron`.
 * Fail-safe no-op before the Phase 5B SQL migration is applied.
 */
export async function reconcileExpiredOfferReservations(): Promise<void> {
  const now = Date.now();
  if (now - lastOfferReconcileMs < RECONCILE_THROTTLE_MS) return;
  lastOfferReconcileMs = now;

  const service = getServerServiceClient();
  if (!service) return;

  try {
    await service.rpc("release_expired_offer_reservations");
  } catch {
    // Migration not yet applied or transient error — never block page loads.
  }
}
