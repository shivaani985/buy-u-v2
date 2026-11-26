import { resolvePublicStorageUrl } from "../format.ts";
import { buildVariantComboKey, normalizeOptionKey } from "../seller/variations.ts";

export interface PurchasedItemImageInput {
  orderItemImagePath: string | null | undefined;
  offerVariantImagePath?: string | null | undefined;
  variantImagePath?: string | null | undefined;
  listingCoverPath?: string | null | undefined;
  storageBaseUrl: string | null | undefined;
}

/**
 * Resolves the historical item image using the exact Phase 10R priority:
 * 1. Purchased item snapshot (`order_items.image_path`)
 * 2. Linked accepted offer snapshot (`offers.variant_image_path`)
 * 3. Exact matched `listing_variants.image_path` for legacy orders without a snapshot
 * 4. Listing cover image only when no variation-specific photo exists
 * 5. `null` so UI shows the neutral fallback tile.
 *
 * Intentionally never mutates historical snapshots on disk.
 */
export function resolvePurchasedItemImagePath(
  input: Omit<PurchasedItemImageInput, "storageBaseUrl">
): string | null {
  const candidates = [
    input.orderItemImagePath,
    input.offerVariantImagePath,
    input.variantImagePath,
    input.listingCoverPath,
  ];
  for (const candidate of candidates) {
    const clean = typeof candidate === "string" ? candidate.trim() : "";
    if (clean.length > 0) {
      return clean;
    }
  }
  return null;
}

export function resolvePurchasedItemImageUrl(
  input: PurchasedItemImageInput
): string | null {
  const resolvedPath = resolvePurchasedItemImagePath(input);
  return resolvePublicStorageUrl("listings", resolvedPath, input.storageBaseUrl);
}

export function normalizeVariantSnapshotRecord(
  raw: Record<string, unknown> | null | undefined
): Record<string, string> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const clean: Record<string, string> = {};
  for (const [key, val] of Object.entries(raw)) {
    const cleanKey = key.trim();
    const cleanVal = String(val ?? "").trim();
    if (cleanKey && cleanVal) {
      clean[cleanKey] = cleanVal;
    }
  }
  return Object.keys(clean).length > 0 ? clean : null;
}

export interface VariantMatchCandidate {
  id: string;
  listing_id: string;
  option_values: Record<string, unknown> | null;
  image_path?: string | null;
}

/**
 * Matches a variant photo for legacy orders lacking `order_items.image_path`
 * by exact `variant_id` first, then exact normalized option_values combo key.
 */
export function matchLegacyVariantImagePath(input: {
  listingId: string | null;
  variantId: string | null | undefined;
  variantSnapshot: Record<string, string> | null;
  variantsById: Map<string, VariantMatchCandidate>;
  variantsByListing: Map<string, VariantMatchCandidate[]>;
}): string | null {
  if (input.variantId) {
    const direct = input.variantsById.get(input.variantId);
    if (direct?.listing_id === input.listingId) {
      return direct.image_path?.trim() || null;
    }
  }
  if (!input.listingId || !input.variantSnapshot) return null;
  const candidates = input.variantsByListing.get(input.listingId) ?? [];
  const snapKeys = Object.keys(input.variantSnapshot).sort((a, b) =>
    normalizeOptionKey(a).localeCompare(normalizeOptionKey(b))
  );
  const snapCombo = buildVariantComboKey(snapKeys, input.variantSnapshot);
  for (const variant of candidates) {
    if (variant.listing_id !== input.listingId || !variant.image_path?.trim()) continue;
    const norm = normalizeVariantSnapshotRecord(variant.option_values);
    if (!norm) continue;
    const vKeys = Object.keys(norm).sort((a, b) =>
      normalizeOptionKey(a).localeCompare(normalizeOptionKey(b))
    );
    if (vKeys.length === snapKeys.length && buildVariantComboKey(vKeys, norm) === snapCombo) {
      return variant.image_path.trim();
    }
  }
  return null;
}
