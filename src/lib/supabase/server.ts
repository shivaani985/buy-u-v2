import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { AuthSessionSummary, MemberProfile } from "@/types/marketplace";
import { getPublicSupabaseEnv } from "./env";

/**
 * Cookie-backed server Supabase client using ONLY the publishable/anon key.
 * Strictly respects RLS; never uses SUPABASE_SERVICE_ROLE_KEY.
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
      setAll(
        cookiesToSet: Array<{
          name: string;
          value: string;
          options: CookieOptions;
        }>
      ) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // Called from a Server Component where mutating cookies is not allowed;
          // src/proxy.ts handles session refresh on requests.
        }
      },
    },
  });
}

/**
 * Authoritative server-side identity, profile, and role lookup.
 * - Verifies identity with supabase.auth.getUser() (not getSession()).
 * - Reads university_role & status from public.profiles (never user_metadata).
 * - Verifies admin privileges via backend RPC is_active_admin().
 */
export async function getSessionSummary(): Promise<AuthSessionSummary> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return {
      isAuthenticated: false,
      isEmailVerified: false,
      isActiveMember: false,
      isActiveAdmin: false,
      email: null,
      profile: null,
      source: "unconfigured",
    };
  }

  try {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    if (error || !user) {
      return {
        isAuthenticated: false,
        isEmailVerified: false,
        isActiveMember: false,
        isActiveAdmin: false,
        email: null,
        profile: null,
        source: "supabase",
      };
    }

    const isEmailVerified = Boolean(user.email_confirmed_at);

    const [profileRes, adminRes] = await Promise.all([
      supabase
        .from("profiles")
        .select(
          "id, email, university_role, status, restriction_reason, full_name, display_name, faculty, bio, avatar_url, created_at"
        )
        .eq("id", user.id)
        .maybeSingle(),
      supabase.rpc("is_active_admin"),
    ]);

    const rawProfile = profileRes.data as MemberProfile | null;
    const isActiveAdmin = !adminRes.error && adminRes.data === true;
    const isActiveMember =
      isEmailVerified &&
      Boolean(rawProfile) &&
      (rawProfile?.status ?? "").toLowerCase() === "active";

    return {
      isAuthenticated: true,
      isEmailVerified,
      isActiveMember,
      isActiveAdmin,
      email: user.email ?? rawProfile?.email ?? null,
      profile: rawProfile,
      source: "supabase",
    };
  } catch {
    return {
      isAuthenticated: false,
      isEmailVerified: false,
      isActiveMember: false,
      isActiveAdmin: false,
      email: null,
      profile: null,
      source: "supabase",
    };
  }
}
