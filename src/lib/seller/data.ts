import { resolvePublicStorageUrl } from "@/lib/format";
import { getPublicSupabaseEnv } from "@/lib/supabase/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { AuthSessionSummary, Category } from "@/types/marketplace";
import {
  evaluateSellerEligibility,
  maskPayoutAccount,
  type MaskedPayoutStatus,
} from "./validation";

export interface SellerStorefront {
  sellerId: string;
  shopName: string;
  description: string;
  logoPath: string | null;
  logoUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SellerListingSummary {
  id: string;
  title: string;
  kind: string;
  isFood: boolean;
  categoryId: string;
  categoryName: string;
  collectionAreaName: string;
  priceSen: number;
  quantity: number;
  reservedQuantity: number;
  availableStock: number;
  status: string;
  condition: string | null;
  imageUrl: string | null;
  publishedAt: string | null;
  updatedAt: string;
}

export interface CollectionAreaOption {
  id: string;
  name: string;
}

export interface SellerHubData {
  storefront: SellerStorefront | null;
  listings: SellerListingSummary[];
  counts: {
    total: number;
    published: number;
    draft: number;
    soldOut: number;
    other: number;
  };
  payout: MaskedPayoutStatus;
  error?: string;
}

export async function getSellerHubData(
  session: AuthSessionSummary
): Promise<SellerHubData> {
  const empty: SellerHubData = {
    storefront: null,
    listings: [],
    counts: { total: 0, published: 0, draft: 0, soldOut: 0, other: 0 },
    payout: maskPayoutAccount(null),
  };

  const eligibility = evaluateSellerEligibility(session);
  const userId = session.profile?.id;
  if (!eligibility.eligible || !userId) {
    return empty;
  }

  const env = getPublicSupabaseEnv();
  const supabase = await createSupabaseServerClient();
  if (!supabase || !env) {
    return { ...empty, error: "Supabase client is not configured." };
  }

  const [storefrontRes, listingsRes, payoutRes, categoriesRes, areasRes] =
    await Promise.all([
      supabase
        .from("storefronts")
        .select("seller_id, shop_name, description, logo_path, created_at, updated_at")
        .eq("seller_id", userId)
        .maybeSingle(),
      supabase
        .from("listings")
        .select(
          "id, title, kind, is_food, category_id, collection_area_id, price_sen, quantity, reserved_quantity, status, condition, image_paths, published_at, updated_at"
        )
        .eq("seller_id", userId)
        .order("updated_at", { ascending: false })
        .limit(50),
      supabase
        .from("seller_payout_accounts")
        .select("bank_name, account_number, account_holder_name, duitnow_id, updated_at")
        .eq("seller_id", userId)
        .maybeSingle(),
      supabase.from("categories").select("id, name").eq("active", true),
      supabase.from("collection_areas").select("id, name").eq("active", true),
    ]);

  const categoryMap = new Map<string, string>();
  for (const c of (categoriesRes.data ?? []) as Array<{ id: string; name: string }>) {
    categoryMap.set(c.id, c.name);
  }

  const areaMap = new Map<string, string>();
  for (const a of (areasRes.data ?? []) as Array<{ id: string; name: string }>) {
    areaMap.set(a.id, a.name);
  }

  const sfRow = storefrontRes.data as {
    seller_id: string;
    shop_name: string | null;
    description: string;
    logo_path: string | null;
    created_at: string;
    updated_at: string;
  } | null;

  const storefront: SellerStorefront | null = sfRow
    ? {
        sellerId: sfRow.seller_id,
        shopName:
          sfRow.shop_name?.trim() ||
          session.profile?.display_name ||
          "My Campus Storefront",
        description: sfRow.description ?? "",
        logoPath: sfRow.logo_path,
        logoUrl: resolvePublicStorageUrl("listings", sfRow.logo_path, env.url),
        createdAt: sfRow.created_at,
        updatedAt: sfRow.updated_at,
      }
    : null;

  const rawListings = (listingsRes.data ?? []) as Array<{
    id: string;
    title: string;
    kind: string;
    is_food: boolean;
    category_id: string;
    collection_area_id: string | null;
    price_sen: number;
    quantity: number;
    reserved_quantity: number;
    status: string;
    condition: string | null;
    image_paths: string[] | null;
    published_at: string | null;
    updated_at: string;
  }>;

  const listings: SellerListingSummary[] = rawListings.map((row) => {
    const qty = typeof row.quantity === "number" ? row.quantity : 1;
    const reserved =
      typeof row.reserved_quantity === "number" ? row.reserved_quantity : 0;
    const availableStock = Math.max(0, qty - reserved);
    const firstPath = row.image_paths?.[0] ?? null;
    return {
      id: row.id,
      title: row.title,
      kind: row.kind,
      isFood: Boolean(row.is_food),
      categoryId: row.category_id,
      categoryName: categoryMap.get(row.category_id) ?? "Campus Marketplace",
      collectionAreaName:
        (row.collection_area_id && areaMap.get(row.collection_area_id)) ||
        "UMSKAL, Labuan",
      priceSen: row.price_sen ?? 0,
      quantity: qty,
      reservedQuantity: reserved,
      availableStock,
      status: row.status,
      condition: row.condition,
      imageUrl: resolvePublicStorageUrl("listings", firstPath, env.url),
      publishedAt: row.published_at,
      updatedAt: row.updated_at,
    };
  });

  const counts = {
    total: listings.length,
    published: listings.filter((l) => l.status === "published").length,
    draft: listings.filter((l) => l.status === "draft").length,
    soldOut: listings.filter(
      (l) => l.status === "published" && l.kind !== "service" && l.availableStock === 0
    ).length,
    other: listings.filter(
      (l) => l.status !== "published" && l.status !== "draft"
    ).length,
  };

  const payout = maskPayoutAccount(
    payoutRes.error
      ? null
      : (payoutRes.data as {
          bank_name?: string | null;
          account_number?: string | null;
          account_holder_name?: string | null;
          duitnow_id?: string | null;
          updated_at?: string | null;
        } | null)
  );

  const error = storefrontRes.error?.message || listingsRes.error?.message;

  return {
    storefront,
    listings,
    counts,
    payout,
    error,
  };
}

export async function getSellFormOptions(session: AuthSessionSummary): Promise<{
  categories: Category[];
  collectionAreas: CollectionAreaOption[];
  storefront: SellerStorefront | null;
}> {
  const eligibility = evaluateSellerEligibility(session);
  const userId = session.profile?.id;
  if (!eligibility.eligible || !userId) {
    return { categories: [], collectionAreas: [], storefront: null };
  }

  const env = getPublicSupabaseEnv();
  const supabase = await createSupabaseServerClient();
  if (!supabase || !env) {
    return { categories: [], collectionAreas: [], storefront: null };
  }

  const [categoriesRes, areasRes, sfRes] = await Promise.all([
    supabase
      .from("categories")
      .select("id, name, kind, icon, sort_order, active")
      .eq("active", true)
      .order("sort_order", { ascending: true }),
    supabase
      .from("collection_areas")
      .select("id, name")
      .eq("active", true)
      .order("name", { ascending: true }),
    supabase
      .from("storefronts")
      .select("seller_id, shop_name, description, logo_path, created_at, updated_at")
      .eq("seller_id", userId)
      .maybeSingle(),
  ]);

  const accents: Category["accent"][] = ["purple", "blue", "teal"];
  const categories: Category[] = (
    (categoriesRes.data ?? []) as Array<{
      id: string;
      name: string;
      kind: string | null;
      icon: string | null;
      sort_order: number | null;
    }>
  ).map((row, idx) => ({
    id: row.id,
    slug: row.id,
    name: row.name,
    kind: row.kind === "service" ? "service" : "product",
    description: "",
    icon: row.icon ?? "package",
    sortOrder: row.sort_order ?? idx + 1,
    accent: accents[idx % accents.length] ?? "purple",
  }));

  const collectionAreas = (areasRes.data ?? []) as CollectionAreaOption[];

  const sfRow = sfRes.data as {
    seller_id: string;
    shop_name: string | null;
    description: string;
    logo_path: string | null;
    created_at: string;
    updated_at: string;
  } | null;

  const storefront: SellerStorefront | null = sfRow
    ? {
        sellerId: sfRow.seller_id,
        shopName:
          sfRow.shop_name?.trim() ||
          session.profile?.display_name ||
          "My Campus Storefront",
        description: sfRow.description ?? "",
        logoPath: sfRow.logo_path,
        logoUrl: resolvePublicStorageUrl("listings", sfRow.logo_path, env.url),
        createdAt: sfRow.created_at,
        updatedAt: sfRow.updated_at,
      }
    : null;

  return { categories, collectionAreas, storefront };
}
