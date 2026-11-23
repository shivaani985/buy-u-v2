import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { AuthSessionSummary } from "@/types/marketplace";
import { getPublicSupabaseEnv } from "./env";

/**
 * Read-only server Supabase client for Phase 1.
 * Cookie writes are intentionally omitted in Server Components.
 */
export async function createSupabaseServerClient(): Promise<SupabaseClient | null> {
  const env = getPublicSupabaseEnv();
  if (!env) return null;

  const cookieStore = await cookies();

  return createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll() {
        // Read-only in Phase 1 Server Components.
      },
    },
  });
}

/**
 * Returns minimal session state without trusting editable user_metadata for roles.
 */
export async function getSessionSummary(): Promise<AuthSessionSummary> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { isAuthenticated: false, email: null, source: "demo" };
  }

  try {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    if (error || !user) {
      return { isAuthenticated: false, email: null, source: "supabase" };
    }

    return {
      isAuthenticated: true,
      email: user.email ?? null,
      source: "supabase",
    };
  } catch {
    return { isAuthenticated: false, email: null, source: "demo" };
  }
}
