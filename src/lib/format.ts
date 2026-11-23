import type { ListingType } from "@/types/marketplace";

/**
 * Converts integer sen (e.g., 1500) to Malaysian Ringgit display ("RM 15.00").
 */
export function formatSenToRm(priceSen: number): string {
  if (!Number.isFinite(priceSen) || priceSen <= 0) return "FREE";
  return `RM ${(priceSen / 100).toFixed(2)}`;
}

export function formatListingType(type: ListingType): string {
  switch (type) {
    case "preloved":
      return "Pre-Loved";
    case "business":
      return "Student Business";
    case "food":
      return "Campus Food";
    case "service":
      return "Service";
    case "free":
      return "Free Item";
  }
}

export function formatShortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Recently posted";
  return new Intl.DateTimeFormat("en-MY", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

const PUBLIC_BUCKETS = new Set(["listings", "free-items"]);

/**
 * Resolves a storage path inside a verified public Supabase bucket.
 * Rejects private buckets and unsafe traversal paths.
 */
export function resolvePublicStorageUrl(
  bucket: "listings" | "free-items",
  rawPath: string | null | undefined,
  supabaseUrl: string | null | undefined
): string | null {
  if (!PUBLIC_BUCKETS.has(bucket) || !rawPath || !supabaseUrl) return null;

  const trimmed = rawPath.trim().replace(/^\/+/, "");
  if (!trimmed || trimmed.includes("..")) return null;

  if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
    try {
      const parsed = new URL(trimmed);
      const expectedHost = new URL(supabaseUrl).host;
      return parsed.host === expectedHost ? trimmed : null;
    } catch {
      return null;
    }
  }

  const base = supabaseUrl.replace(/\/+$/, "");
  const encodedPath = trimmed
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return `${base}/storage/v1/object/public/${bucket}/${encodedPath}`;
}
