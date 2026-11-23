import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { AuthSessionSummary } from "@/types/marketplace";

export interface HeaderCounters {
  cartCount: number;
  unreadMessageCount: number;
}

/**
 * Fetches authenticated, RLS-protected utility counters for the current member.
 * - cartCount: real sum of `cart_items.quantity` for `user_id`
 * - unreadMessageCount: real unread message notifications (`read_at IS NULL`, `kind` in message kinds)
 *   Note: `public.messages` currently has no `read_at` column, so unread counts rely strictly
 *   on unread message notifications and return 0 when unavailable (never fabricated).
 */
export async function getHeaderCounters(
  session: AuthSessionSummary
): Promise<HeaderCounters> {
  const userId = session.profile?.id;
  if (!session.isAuthenticated || !session.isEmailVerified || !userId) {
    return { cartCount: 0, unreadMessageCount: 0 };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { cartCount: 0, unreadMessageCount: 0 };
  }

  try {
    const [cartRes, msgNotifRes] = await Promise.all([
      supabase
        .from("cart_items")
        .select("quantity")
        .eq("user_id", userId),
      supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .is("read_at", null)
        .in("kind", ["new_message", "message"]),
    ]);

    const cartCount = cartRes.error
      ? 0
      : ((cartRes.data ?? []) as Array<{ quantity: number | null }>).reduce(
          (sum, row) => sum + Math.max(0, Number(row.quantity ?? 0)),
          0
        );

    const unreadMessageCount =
      msgNotifRes.error || typeof msgNotifRes.count !== "number"
        ? 0
        : Math.max(0, msgNotifRes.count);

    return { cartCount, unreadMessageCount };
  } catch {
    return { cartCount: 0, unreadMessageCount: 0 };
  }
}
