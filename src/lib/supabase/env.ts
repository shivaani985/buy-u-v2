const PLACEHOLDER_KEYS = new Set([
  "",
  "your-anon-key-here",
  "your-supabase-anon-key",
]);

export interface PublicSupabaseEnv {
  url: string;
  anonKey: string;
}

/**
 * Validates browser-safe Supabase env vars only.
 * Never reads or exposes SUPABASE_SERVICE_ROLE_KEY.
 */
export function getPublicSupabaseEnv(): PublicSupabaseEnv | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";

  if (!url || !anonKey || PLACEHOLDER_KEYS.has(anonKey)) {
    return null;
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
  } catch {
    return null;
  }

  return { url, anonKey };
}

export function isSupabaseConfigured(): boolean {
  return getPublicSupabaseEnv() !== null;
}
