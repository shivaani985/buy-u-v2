import { getListingById } from "@/lib/catalog";
import { resolvePublicStorageUrl } from "@/lib/format";
import { getPublicSupabaseEnv } from "@/lib/supabase/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { reconcileExpiredOfferReservations } from "@/lib/supabase/service";
import type {
  AuthSessionSummary,
  CatalogDataSource,
  ListingType,
} from "@/types/marketplace";
import {
  computeAvailableStock,
  evaluateBuyerEligibility,
  isValidUuid,
  type BuyerEligibilityResult,
} from "./validation";

export interface ProductVariantItem {
  id: string;
  label: string;
  optionValues: Record<string, string>;
  priceSen: number;
  quantity: number;
  reservedQuantity: number;
  availableStock: number;
  active: boolean;
}

export interface ProductStorefrontInfo {
  sellerId: string;
  displayName: string;
  shopName: string | null;
  shopDescription: string | null;
  logoUrl: string | null;
  faculty: string | null;
  badge: string;
}

export interface ProductFoodInfo {
  availabilityMode: string | null;
  preorderCloseAt: string | null;
  pickupWindowStart: string | null;
  pickupWindowEnd: string | null;
  pickupNote: string | null;
  foodNotes: string | null;
}

export interface ProductDetail {
  id: string;
  slug: string;
  title: string;
  description: string;
  kind: string;
  listingType: ListingType;
  isFood: boolean;
  isFreeNotice: boolean;
  isDemo: boolean;
  status: string;
  priceSen: number;
  quantity: number;
  reservedQuantity: number;
  availableStock: number | null;
  hasVariants: boolean;
  variants: ProductVariantItem[];
  categoryId: string;
  categoryName: string;
  campusArea: string;
  condition: string | null;
  limitations: string | null;
  allowOffers: boolean;
  serviceMode: string | null;
  acceptingRequests: boolean | null;
  food: ProductFoodInfo | null;
  imageUrls: string[];
  imageAlt: string;
  seller: ProductStorefrontInfo;
  createdAt: string;
  publishedAt: string | null;
  isOwner: boolean;
  isFavourited: boolean;
  /** Existing cart quantity keyed by variantId or "default". */
  cartQuantities: Record<string, number>;
}

export interface ProductDetailResult {
  data: ProductDetail | null;
  source: CatalogDataSource;
  notice?: string;
  errorCode?: string;
  buyerEligibility: BuyerEligibilityResult;
}

interface RawListingRow {
  id: string;
  seller_id: string;
  kind: string;
  is_food: boolean | null;
  title: string;
  description: string | null;
  category_id: string | null;
  condition: string | null;
  limitations: string | null;
  price_sen: number | null;
  quantity: number | null;
  reserved_quantity: number | null;
  collection_area_id: string | null;
  allow_offers: boolean | null;
  has_variants: boolean | null;
  availability_mode: string | null;
  preorder_close_at: string | null;
  pickup_window_start: string | null;
  pickup_window_end: string | null;
  pickup_note: string | null;
  food_notes: string | null;
  service_mode: string | null;
  accepting_requests: boolean | null;
  image_paths: string[] | null;
  status: string;
  published_at: string | null;
  created_at: string;
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

function mapKindToListingType(kind: string, isFood: boolean): ListingType {
  if (isFood) return "food";
  if (kind === "service") return "service";
  if (kind === "business") return "business";
  return "preloved";
}

function formatVariantLabel(optionValues: Record<string, string>): string {
  const entries = Object.entries(optionValues);
  if (entries.length === 0) return "Standard";
  return entries.map(([key, val]) => `${key}: ${val}`).join(" / ");
}

function normalizeOptionValues(
  raw: Record<string, unknown> | null
): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v !== null && v !== undefined && String(v).trim().length > 0) {
      result[k] = String(v).trim();
    }
  }
  return result;
}

export async function getProductDetailData(
  idOrSlug: string,
  session: AuthSessionSummary,
  options: { useDemo?: boolean } = {}
): Promise<ProductDetailResult> {
  const buyerEligibility = evaluateBuyerEligibility(session);
  const useDemo = options.useDemo === true;

  // Demo mode or non-UUID slug falls back cleanly to catalog helper.
  if (useDemo || !isValidUuid(idOrSlug)) {
    const fallback = await getListingById(idOrSlug, { useDemo });
    if (!fallback.data) {
      return {
        data: null,
        source: fallback.source,
        notice: fallback.notice,
        errorCode: fallback.errorCode,
        buyerEligibility,
      };
    }

    const item = fallback.data;
    const isFreeNotice = item.listingType === "free";
    return {
      data: {
        id: item.id,
        slug: item.slug,
        title: item.title,
        description: item.description,
        kind:
          item.listingType === "preloved"
            ? "pre_loved"
            : item.listingType === "food"
              ? "business"
              : item.listingType,
        listingType: item.listingType,
        isFood: item.listingType === "food",
        isFreeNotice,
        isDemo: item.isDemo,
        status: "published",
        priceSen: item.priceSen,
        quantity: item.availableStock ?? 0,
        reservedQuantity: 0,
        availableStock: item.availableStock,
        hasVariants: false,
        variants: [],
        categoryId: item.categoryId,
        categoryName: item.categoryName,
        campusArea: item.campusArea,
        condition: item.condition,
        limitations: null,
        allowOffers: false,
        serviceMode: null,
        acceptingRequests: null,
        food: null,
        imageUrls: item.imageUrls,
        imageAlt: item.imageAlt,
        seller: {
          sellerId: "",
          displayName: item.sellerDisplayName,
          shopName: null,
          shopDescription: null,
          logoUrl: null,
          faculty: item.sellerFaculty,
          badge: item.sellerBadge,
        },
        createdAt: item.createdAt,
        publishedAt: item.createdAt,
        isOwner: false,
        isFavourited: false,
        cartQuantities: {},
      },
      source: fallback.source,
      notice: fallback.notice,
      errorCode: fallback.errorCode,
      buyerEligibility,
    };
  }

  const env = getPublicSupabaseEnv();
  const supabase = await createSupabaseServerClient();
  if (!env || !supabase) {
    return {
      data: null,
      source: "error",
      notice: "Supabase client is not configured.",
      errorCode: "SUPABASE_UNCONFIGURED",
      buyerEligibility,
    };
  }

  if (!session.isAuthenticated) {
    return {
      data: null,
      source: "auth_required",
      notice: "Sign in with your UMS email to view live campus listings.",
      buyerEligibility,
    };
  }

  if (!session.isEmailVerified || !session.isActiveMember) {
    return {
      data: null,
      source: "restricted",
      notice:
        buyerEligibility.reason ||
        "Your account must be active and verified to view live listings.",
      buyerEligibility,
    };
  }

  // Release any expired 30m offer holds before reading live stock (throttled, no-op pre-migration)
  await reconcileExpiredOfferReservations();

  const { data: rawListing, error: listingErr } = await supabase
    .from("listings")
    .select(
      "id,seller_id,kind,is_food,title,description,category_id,condition,limitations,price_sen,quantity,reserved_quantity,collection_area_id,allow_offers,has_variants,availability_mode,preorder_close_at,pickup_window_start,pickup_window_end,pickup_note,food_notes,service_mode,accepting_requests,image_paths,status,published_at,created_at"
    )
    .eq("id", idOrSlug)
    .maybeSingle();

  if (listingErr) {
    return {
      data: null,
      source: "error",
      notice: "Unable to load listing details right now.",
      errorCode: listingErr.code,
      buyerEligibility,
    };
  }

  // If not found in `listings`, check if it is a `free_notices` UUID via catalog helper.
  if (!rawListing) {
    const fallback = await getListingById(idOrSlug, { useDemo: false });
    if (fallback.data) {
      const item = fallback.data;
      return {
        data: {
          id: item.id,
          slug: item.slug,
          title: item.title,
          description: item.description,
          kind: "free",
          listingType: "free",
          isFood: false,
          isFreeNotice: true,
          isDemo: false,
          status: "published",
          priceSen: 0,
          quantity: 1,
          reservedQuantity: 0,
          availableStock: 1,
          hasVariants: false,
          variants: [],
          categoryId: item.categoryId,
          categoryName: item.categoryName,
          campusArea: item.campusArea,
          condition: item.condition,
          limitations: null,
          allowOffers: false,
          serviceMode: null,
          acceptingRequests: null,
          food: null,
          imageUrls: item.imageUrls,
          imageAlt: item.imageAlt,
          seller: {
            sellerId: "",
            displayName: item.sellerDisplayName,
            shopName: null,
            shopDescription: null,
            logoUrl: null,
            faculty: item.sellerFaculty,
            badge: item.sellerBadge,
          },
          createdAt: item.createdAt,
          publishedAt: item.createdAt,
          isOwner: false,
          isFavourited: false,
          cartQuantities: {},
        },
        source: "supabase",
        buyerEligibility,
      };
    }

    return {
      data: null,
      source: "supabase",
      buyerEligibility,
    };
  }

  const row = rawListing as RawListingRow;
  const currentUserId = session.profile?.id ?? null;
  const isOwner = Boolean(currentUserId && currentUserId === row.seller_id);

  // Fetch related metadata, variants, storefront, favourite status, and existing cart rows in parallel.
  const [
    variantsRes,
    categoryRes,
    areaRes,
    profileRes,
    storefrontRes,
    favRes,
    cartRes,
  ] = await Promise.all([
    row.has_variants
      ? supabase
          .from("listing_variants")
          .select(
            "id,listing_id,option_values,price_sen,quantity,reserved_quantity,active"
          )
          .eq("listing_id", row.id)
          .eq("active", true)
          .order("price_sen", { ascending: true })
      : Promise.resolve({ data: [], error: null }),
    row.category_id
      ? supabase
          .from("categories")
          .select("id,name")
          .eq("id", row.category_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    row.collection_area_id
      ? supabase
          .from("collection_areas")
          .select("id,name")
          .eq("id", row.collection_area_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabase
      .from("public_profiles")
      .select("id,display_name,faculty,university_role")
      .eq("id", row.seller_id)
      .maybeSingle(),
    supabase
      .from("storefronts")
      .select("seller_id,shop_name,description,logo_path")
      .eq("seller_id", row.seller_id)
      .maybeSingle(),
    currentUserId
      ? supabase
          .from("favourites")
          .select("listing_id")
          .eq("user_id", currentUserId)
          .eq("listing_id", row.id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    currentUserId
      ? supabase
          .from("cart_items")
          .select("variant_id,quantity")
          .eq("user_id", currentUserId)
          .eq("listing_id", row.id)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const variants: ProductVariantItem[] = (
    (variantsRes.data ?? []) as RawVariantRow[]
  ).map((v) => {
    const optionValues = normalizeOptionValues(v.option_values);
    return {
      id: v.id,
      label: formatVariantLabel(optionValues),
      optionValues,
      priceSen: Number(v.price_sen ?? 0),
      quantity: Number(v.quantity ?? 0),
      reservedQuantity: Number(v.reserved_quantity ?? 0),
      availableStock: computeAvailableStock(
        Number(v.quantity ?? 0),
        Number(v.reserved_quantity ?? 0)
      ),
      active: Boolean(v.active),
    };
  });

  const isFood = Boolean(row.is_food);
  const listingType = mapKindToListingType(row.kind, isFood);
  const imageUrls = (row.image_paths ?? [])
    .map((p) => resolvePublicStorageUrl("listings", p, env.url))
    .filter((u): u is string => Boolean(u));

  const categoryName =
    (categoryRes.data as { name?: string } | null)?.name ?? "Campus Marketplace";
  const campusArea =
    (areaRes.data as { name?: string } | null)?.name ?? "UMSKAL Campus";

  const sellerProfile = profileRes.data as {
    display_name?: string | null;
    faculty?: string | null;
    university_role?: string | null;
  } | null;
  const storefront = storefrontRes.data as {
    shop_name?: string | null;
    description?: string | null;
    logo_path?: string | null;
  } | null;

  const sellerDisplayName =
    sellerProfile?.display_name?.trim() ||
    storefront?.shop_name?.trim() ||
    "UMSKAL Student";
  const sellerBadge =
    sellerProfile?.university_role === "staff"
      ? "Verified UMS Staff"
      : "Verified UMS Student";
  const logoUrl = resolvePublicStorageUrl(
    "listings",
    storefront?.logo_path ?? null,
    env.url
  );

  const quantity = Number(row.quantity ?? 0);
  const reservedQuantity = Number(row.reserved_quantity ?? 0);
  const availableStock =
    row.kind === "service"
      ? null
      : row.has_variants
        ? variants.reduce((sum, v) => sum + v.availableStock, 0)
        : computeAvailableStock(quantity, reservedQuantity);

  const cartQuantities: Record<string, number> = {};
  for (const c of (cartRes.data ?? []) as Array<{
    variant_id: string | null;
    quantity: number | null;
  }>) {
    const key = c.variant_id ?? "default";
    cartQuantities[key] =
      (cartQuantities[key] ?? 0) + Math.max(0, Number(c.quantity ?? 0));
  }

  const food: ProductFoodInfo | null = isFood
    ? {
        availabilityMode: row.availability_mode,
        preorderCloseAt: row.preorder_close_at,
        pickupWindowStart: row.pickup_window_start,
        pickupWindowEnd: row.pickup_window_end,
        pickupNote: row.pickup_note,
        foodNotes: row.food_notes,
      }
    : null;

  return {
    data: {
      id: row.id,
      slug: row.id,
      title: row.title,
      description: row.description ?? "",
      kind: row.kind,
      listingType,
      isFood,
      isFreeNotice: false,
      isDemo: false,
      status: row.status,
      priceSen: Number(row.price_sen ?? 0),
      quantity,
      reservedQuantity,
      availableStock,
      hasVariants: Boolean(row.has_variants),
      variants,
      categoryId: row.category_id ?? "",
      categoryName,
      campusArea,
      condition: row.condition,
      limitations: row.limitations,
      allowOffers: Boolean(row.allow_offers),
      serviceMode: row.service_mode,
      acceptingRequests: row.accepting_requests,
      food,
      imageUrls,
      imageAlt: row.title,
      seller: {
        sellerId: row.seller_id,
        displayName: sellerDisplayName,
        shopName: storefront?.shop_name?.trim() || null,
        shopDescription: storefront?.description?.trim() || null,
        logoUrl,
        faculty: sellerProfile?.faculty?.trim() || null,
        badge: sellerBadge,
      },
      createdAt: row.created_at,
      publishedAt: row.published_at,
      isOwner,
      isFavourited: Boolean(favRes.data),
      cartQuantities,
    },
    source: "supabase",
    buyerEligibility,
  };
}
