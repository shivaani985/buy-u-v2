import { resolvePublicStorageUrl } from "@/lib/format";
import { getPublicSupabaseEnv } from "@/lib/supabase/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { AuthSessionSummary } from "@/types/marketplace";
import {
  buildCartSummary,
  evaluateCartLineState,
  type CartItemView,
  type CartLineListingSnapshot,
  type CartLineVariantSnapshot,
  type CartSummary,
} from "./cart";
import {
  evaluateBuyerEligibility,
  type BuyerEligibilityResult,
} from "./validation";

export interface CartPageData {
  eligibility: BuyerEligibilityResult;
  summary: CartSummary;
  error?: string;
}

interface RawCartRow {
  id: string;
  user_id: string;
  listing_id: string;
  variant_id: string | null;
  quantity: number;
  created_at: string;
  updated_at: string;
}

interface RawListingRow {
  id: string;
  seller_id: string;
  kind: string;
  is_food: boolean | null;
  title: string;
  condition: string | null;
  price_sen: number | null;
  quantity: number | null;
  reserved_quantity: number | null;
  collection_area_id: string | null;
  has_variants: boolean | null;
  availability_mode: string | null;
  pickup_window_start: string | null;
  pickup_window_end: string | null;
  pickup_note: string | null;
  food_notes: string | null;
  image_paths: string[] | null;
  status: string;
}

interface RawVariantRow {
  id: string;
  listing_id: string;
  option_values: Record<string, unknown> | null;
  price_sen: number;
  quantity: number;
  reserved_quantity: number;
  active: boolean;
}

function formatVariantLabel(raw: Record<string, unknown> | null): string | null {
  if (!raw || typeof raw !== "object") return null;
  const parts = Object.entries(raw)
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim().length > 0)
    .map(([k, v]) => `${k}: ${String(v).trim()}`);
  return parts.length > 0 ? parts.join(" / ") : null;
}

const EMPTY_SUMMARY: CartSummary = {
  groups: [],
  totalRowCount: 0,
  totalQuantity: 0,
  validQuantity: 0,
  invalidRowCount: 0,
  sellerCount: 0,
  combinedSubtotalSen: 0,
  hasIssues: false,
};

export async function getCartPageData(
  session: AuthSessionSummary
): Promise<CartPageData> {
  const eligibility = evaluateBuyerEligibility(session);

  if (!eligibility.eligible || !eligibility.userId) {
    return {
      eligibility,
      summary: EMPTY_SUMMARY,
    };
  }

  const env = getPublicSupabaseEnv();
  const supabase = await createSupabaseServerClient();
  if (!env || !supabase) {
    return {
      eligibility,
      summary: EMPTY_SUMMARY,
      error: "Supabase client is not configured.",
    };
  }

  const userId = eligibility.userId;

  const { data: rawCartRows, error: cartErr } = await supabase
    .from("cart_items")
    .select("id,user_id,listing_id,variant_id,quantity,created_at,updated_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (cartErr) {
    return {
      eligibility,
      summary: EMPTY_SUMMARY,
      error: "Unable to load your shopping cart right now.",
    };
  }

  const cartRows = (rawCartRows ?? []) as RawCartRow[];
  if (cartRows.length === 0) {
    return {
      eligibility,
      summary: EMPTY_SUMMARY,
    };
  }

  const listingIds = Array.from(new Set(cartRows.map((r) => r.listing_id)));
  const variantIds = Array.from(
    new Set(
      cartRows
        .map((r) => r.variant_id)
        .filter((v): v is string => typeof v === "string" && v.length > 0)
    )
  );

  const [listingsRes, variantsRes] = await Promise.all([
    supabase
      .from("listings")
      .select(
        "id,seller_id,kind,is_food,title,condition,price_sen,quantity,reserved_quantity,collection_area_id,has_variants,availability_mode,pickup_window_start,pickup_window_end,pickup_note,food_notes,image_paths,status"
      )
      .in("id", listingIds),
    variantIds.length > 0
      ? supabase
          .from("listing_variants")
          .select(
            "id,listing_id,option_values,price_sen,quantity,reserved_quantity,active"
          )
          .in("id", variantIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (listingsRes.error) {
    return {
      eligibility,
      summary: EMPTY_SUMMARY,
      error: "Unable to verify current listing availability right now.",
    };
  }

  const listingsMap = new Map<string, RawListingRow>();
  for (const row of (listingsRes.data ?? []) as RawListingRow[]) {
    listingsMap.set(row.id, row);
  }

  const variantsMap = new Map<string, RawVariantRow>();
  for (const row of (variantsRes.data ?? []) as RawVariantRow[]) {
    variantsMap.set(row.id, row);
  }

  const sellerIds = Array.from(
    new Set(Array.from(listingsMap.values()).map((l) => l.seller_id))
  );
  const areaIds = Array.from(
    new Set(
      Array.from(listingsMap.values())
        .map((l) => l.collection_area_id)
        .filter((a): a is string => typeof a === "string" && a.length > 0)
    )
  );

  const [profilesRes, storefrontsRes, areasRes] = await Promise.all([
    sellerIds.length > 0
      ? supabase
          .from("public_profiles")
          .select("id,display_name,university_role")
          .in("id", sellerIds)
      : Promise.resolve({ data: [], error: null }),
    sellerIds.length > 0
      ? supabase
          .from("storefronts")
          .select("seller_id,shop_name,logo_path")
          .in("seller_id", sellerIds)
      : Promise.resolve({ data: [], error: null }),
    areaIds.length > 0
      ? supabase.from("collection_areas").select("id,name").in("id", areaIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const profilesMap = new Map<
    string,
    { display_name: string | null; university_role: string | null }
  >();
  for (const p of (profilesRes.data ?? []) as Array<{
    id: string;
    display_name: string | null;
    university_role: string | null;
  }>) {
    profilesMap.set(p.id, p);
  }

  const storefrontsMap = new Map<
    string,
    { shop_name: string | null; logo_path: string | null }
  >();
  for (const s of (storefrontsRes.data ?? []) as Array<{
    seller_id: string;
    shop_name: string | null;
    logo_path: string | null;
  }>) {
    storefrontsMap.set(s.seller_id, s);
  }

  const areasMap = new Map<string, string>();
  for (const a of (areasRes.data ?? []) as Array<{ id: string; name: string }>) {
    areasMap.set(a.id, a.name);
  }

  const items: CartItemView[] = cartRows.map((row) => {
    const rawListing = listingsMap.get(row.listing_id) ?? null;
    const rawVariant = row.variant_id
      ? variantsMap.get(row.variant_id) ?? null
      : null;

    const listingSnapshot: CartLineListingSnapshot | null = rawListing
      ? {
          id: rawListing.id,
          sellerId: rawListing.seller_id,
          kind: rawListing.kind,
          status: rawListing.status,
          hasVariants: Boolean(rawListing.has_variants),
          priceSen: Number(rawListing.price_sen ?? 0),
          quantity: Number(rawListing.quantity ?? 0),
          reservedQuantity: Number(rawListing.reserved_quantity ?? 0),
        }
      : null;

    const variantSnapshot: CartLineVariantSnapshot | null = rawVariant
      ? {
          id: rawVariant.id,
          listingId: rawVariant.listing_id,
          active: Boolean(rawVariant.active),
          priceSen: Number(rawVariant.price_sen ?? 0),
          quantity: Number(rawVariant.quantity ?? 0),
          reservedQuantity: Number(rawVariant.reserved_quantity ?? 0),
        }
      : null;

    const state = evaluateCartLineState({
      buyerUserId: userId,
      cartQuantity: Number(row.quantity ?? 0),
      variantId: row.variant_id,
      listing: listingSnapshot,
      variant: variantSnapshot,
    });

    const sellerId = rawListing?.seller_id ?? "unavailable-seller";
    const profile = rawListing ? profilesMap.get(rawListing.seller_id) : null;
    const storefront = rawListing
      ? storefrontsMap.get(rawListing.seller_id)
      : null;

    const storefrontName = storefront?.shop_name?.trim() || null;
    const sellerDisplayName =
      profile?.display_name?.trim() ||
      storefrontName ||
      (rawListing ? "UMSKAL Student" : "Unavailable Seller");
    const sellerBadge = !rawListing
      ? "Listing Removed"
      : profile?.university_role === "staff"
        ? "Verified UMS Staff"
        : "Verified UMS Student";
    const sellerLogoUrl = resolvePublicStorageUrl(
      "listings",
      storefront?.logo_path ?? null,
      env.url
    );

    const firstImagePath = rawListing?.image_paths?.[0] ?? null;
    const imageUrl = resolvePublicStorageUrl("listings", firstImagePath, env.url);

    return {
      id: row.id,
      listingId: row.listing_id,
      variantId: row.variant_id,
      variantLabel: rawVariant ? formatVariantLabel(rawVariant.option_values) : null,
      title: rawListing?.title ?? "Unavailable Listing",
      imageUrl,
      campusArea: rawListing?.collection_area_id
        ? areasMap.get(rawListing.collection_area_id) ?? "UMSKAL Campus"
        : null,
      condition: rawListing?.condition ?? null,
      sellerId,
      sellerDisplayName,
      storefrontName,
      sellerLogoUrl,
      sellerBadge,
      unitPriceSen: state.unitPriceSen,
      quantity: Math.max(0, Number(row.quantity ?? 0)),
      availableStock: state.availableStock,
      reservedQuantity: state.reservedQuantity,
      lineSubtotalSen: state.lineSubtotalSen,
      isValid: state.isValid,
      issueCode: state.issueCode,
      issueMessage: state.issueMessage,
      canAdjustToMax: state.canAdjustToMax,
      isFood: Boolean(rawListing?.is_food),
      availabilityMode: rawListing?.availability_mode ?? null,
      pickupWindowStart: rawListing?.pickup_window_start ?? null,
      pickupWindowEnd: rawListing?.pickup_window_end ?? null,
      pickupNote: rawListing?.pickup_note ?? null,
      foodNotes: rawListing?.food_notes ?? null,
    };
  });

  return {
    eligibility,
    summary: buildCartSummary(items),
  };
}
