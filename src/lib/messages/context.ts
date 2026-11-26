import type { SupabaseClient } from "@supabase/supabase-js";
import { isValidUuid } from "./validation.ts";

export const chatContextLabels = {
  product: { inquiry: "Product Inquiry", shared: "Product shared", view: "View Product" },
  service: { inquiry: "Service Inquiry", shared: "Service shared", view: "View Service" },
  order: { inquiry: "Order Inquiry", shared: "Order shared", view: "View Order" },
  free: { inquiry: "Free Item Inquiry", shared: "Free Item shared", view: "View Free Item" },
} as const;

export type ChatContextKind = keyof typeof chatContextLabels;

export interface ChatTarget {
  kind: ChatContextKind;
  targetId: string;
  variantId?: string | null;
  itemId?: string | null;
}

export interface ChatReference extends ChatTarget {
  title?: string;
  imagePath?: string;
  imageUrl?: string;
  priceMinSen?: number;
  priceMaxSen?: number;
  quantity?: number;
  variation?: Record<string, string>;
  code?: string;
  orderStatus?: string;
  availability?: string;
  unavailable?: string;
  pickup?: string;
  expiresAt?: string;
  href?: string;
  canBargain?: boolean;
  foodCutoff?: string;
  foodPickupStart?: string;
  foodPickupEnd?: string;
}

export function parseChatTarget(input: {
  kind?: unknown;
  targetId?: unknown;
  variantId?: unknown;
  itemId?: unknown;
}): ChatTarget | null {
  const { kind, targetId, variantId, itemId } = input;
  if (typeof kind !== "string" || !Object.hasOwn(chatContextLabels, kind) ||
      typeof targetId !== "string" || !isValidUuid(targetId)) return null;
  if (variantId != null && ((kind !== "product" && kind !== "service") ||
      typeof variantId !== "string" || !isValidUuid(variantId))) return null;
  if (itemId != null && (kind !== "order" || typeof itemId !== "string" || !isValidUuid(itemId))) return null;
  return { kind: kind as ChatContextKind, targetId: targetId.trim(), variantId: variantId?.trim(), itemId: itemId?.trim() };
}

export function contextArgs(target: ChatTarget) {
  return {
    p_kind: target.kind,
    p_target: target.targetId,
    p_variant: target.variantId ?? null,
    p_item: target.itemId ?? null,
  };
}

export async function loadChatReferences(client: SupabaseClient, ids: string[]) {
  const unique = [...new Set(ids)];
  const requests = [];
  for (let start = 0; start < unique.length; start += 300) {
    requests.push(client.rpc("read_chat_contexts", { p_messages: unique.slice(start, start + 300) }));
  }
  const results = await Promise.all(requests);
  return new Map<string, ChatReference>(results.flatMap(({ data }) =>
    ((data ?? []) as { message_id: string; reference: ChatReference }[]).map((row) => [row.message_id, row.reference])
  ));
}

export function chatPreview(body: string, attachmentCount: number, reference?: ChatReference | null) {
  return body || (reference ? chatContextLabels[reference.kind].shared
    : attachmentCount ? "Sent an attachment" : "New message");
}
