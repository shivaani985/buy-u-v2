import { DEMO_CATEGORIES, DEMO_LISTINGS } from "./demo-data";
import { resolvePublicStorageUrl } from "./format";
import { getPublicSupabaseEnv } from "./supabase/env";
import { createSupabaseServerClient } from "./supabase/server";
import type {
  CatalogResult,
  Category,
  Listing,
  ListingType,
  MarketplaceFilters,
} from "@/types/marketplace";

const CATEGORY_ACCENTS: Category["accent"][] = ["purple", "blue", "teal"];

interface RawCategoryRow {
  id: string;
  name: string;
  kind: string | null;
  icon: string | null;
  sort_order: number | null;
  active: boolean | null;
}

interface RawListingRow {
  id: string;
  seller_id: string;
  kind: string | null;
  title: string;
  description: string | null;
  category_id: string | null;
  condition: string | null;
  price_sen: number | null;
  quantity: number | null;
  reserved_quantity: number | null;
  collection_area_id: string | null;
  is_food: boolean | null;
  image_paths: string[] | null;
  status: string;
  published_at: string | null;
  created_at: string;
}

interface RawFreeNoticeRow {
  id: string;
  contributor_id: string;
  title: string;
  description: string | null;
  condition: string | null;
  spot_id: string | null;
  image_paths: string[] | null;
  status: string;
  published_at: string | null;
  created_at: string;
}

interface RawPublicProfileRow {
  id: string;
  display_name: string | null;
  university_role: string | null;
  faculty: string | null;
}

function mapListingType(row: RawListingRow): ListingType {
  if (row.is_food) return "food";
  const kind = (row.kind ?? "").toLowerCase();
  if (kind === "service") return "service";
  if (kind === "business") return "business";
  return "preloved";
}

function formatRoleBadge(role: string | null | undefined): string {
  const lower = (role ?? "").toLowerCase();
  if (lower === "staff") return "UMS Staff";
  if (lower === "student") return "Verified Student";
  return "Campus Member";
}

function filterListings(
  listings: Listing[],
  filters: MarketplaceFilters = {}
): Listing[] {
  const query = filters.q?.trim().toLowerCase() ?? "";
  const category = filters.category?.trim().toLowerCase() ?? "";
  const type = filters.type && filters.type !== "all" ? filters.type : null;

  return listings.filter((item) => {
    if (category && item.categoryId.toLowerCase() !== category) {
      return false;
    }
    if (type && item.listingType !== type) {
      return false;
    }
    if (query) {
      const haystack = [
        item.title,
        item.description,
        item.categoryName,
        item.campusArea,
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

function describeSupabaseError(code: string | undefined, message: string): string {
  if (code === "42501") {
    return "Connected to Supabase (duwwlcpdidrxkixvflag), but the public anon role is denied SELECT access (PostgreSQL 42501). Sign-in or explicit anon SELECT policies are required to display live catalog records.";
  }
  return `Supabase read-only query failed (${code ?? "unknown"}): ${message}`;
}

/**
 * Read-only category fetch strictly via publishable/anon key (respects RLS).
 * Never silently falls back to demo data on a real database error.
 */
export async function getCategories(options?: {
  useDemo?: boolean;
}): Promise<CatalogResult<Category[]>> {
  const useDemo = Boolean(options?.useDemo);
  const env = getPublicSupabaseEnv();

  if (useDemo) {
    return {
      data: DEMO_CATEGORIES,
      source: "demo",
      notice: "Explicit Demo Mode enabled (?demo=1). Sample categories shown.",
    };
  }

  if (!env) {
    return {
      data: DEMO_CATEGORIES,
      source: "demo",
      notice: "Supabase environment not configured. Showing demo categories.",
    };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return {
      data: [],
      source: "error",
      notice: "Unable to initialize Supabase server client.",
    };
  }

  try {
    const { data, error } = await supabase
      .from("categories")
      .select("id, name, kind, icon, sort_order, active")
      .eq("active", true)
      .order("sort_order", { ascending: true });

    if (error) {
      return {
        data: [],
        source: "error",
        errorCode: error.code,
        notice: describeSupabaseError(error.code, error.message),
      };
    }

    const rows = (data ?? []) as RawCategoryRow[];
    const mapped: Category[] = rows.map((row, idx) => ({
      id: row.id,
      slug: row.id,
      name: row.name,
      kind: row.kind === "service" ? "service" : "product",
      description:
        row.kind === "service"
          ? "Campus service category at UMSKAL."
          : "Campus product category at UMSKAL.",
      icon: row.icon ?? "package",
      sortOrder: row.sort_order ?? idx + 1,
      accent: CATEGORY_ACCENTS[idx % CATEGORY_ACCENTS.length] ?? "purple",
    }));

    return { data: mapped, source: "supabase" };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Network error";
    return {
      data: [],
      source: "error",
      notice: `Supabase connection error: ${message}`,
    };
  }
}

/**
 * Read-only published listings + free_notices fetch via publishable/anon key.
 * Strictly respects RLS and never selects private member fields.
 */
export async function getListings(
  filters: MarketplaceFilters = {}
): Promise<CatalogResult<Listing[]>> {
  const env = getPublicSupabaseEnv();

  if (filters.useDemo) {
    return {
      data: filterListings(DEMO_LISTINGS, filters),
      source: "demo",
      notice: "Explicit Demo Mode enabled (?demo=1). Sample listings shown.",
    };
  }

  if (!env) {
    return {
      data: filterListings(DEMO_LISTINGS, filters),
      source: "demo",
      notice: "Supabase environment not configured. Showing demo listings.",
    };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return {
      data: [],
      source: "error",
      notice: "Unable to initialize Supabase server client.",
    };
  }

  try {
    const [listingsRes, categoriesRes, areasRes, freeRes, spotsRes] =
      await Promise.all([
        supabase
          .from("listings")
          .select(
            "id, seller_id, kind, title, description, category_id, condition, price_sen, quantity, reserved_quantity, collection_area_id, is_food, image_paths, status, published_at, created_at"
          )
          .eq("status", "published")
          .order("published_at", { ascending: false, nullsFirst: false })
          .limit(50),
        supabase
          .from("categories")
          .select("id, name")
          .eq("active", true),
        supabase
          .from("collection_areas")
          .select("id, name")
          .eq("active", true),
        supabase
          .from("free_notices")
          .select(
            "id, contributor_id, title, description, condition, spot_id, image_paths, status, published_at, created_at"
          )
          .eq("status", "published")
          .order("published_at", { ascending: false, nullsFirst: false })
          .limit(20),
        supabase
          .from("donation_spots")
          .select("id, name")
          .eq("active", true),
      ]);

    if (listingsRes.error) {
      return {
        data: [],
        source: "error",
        errorCode: listingsRes.error.code,
        notice: describeSupabaseError(
          listingsRes.error.code,
          listingsRes.error.message
        ),
      };
    }

    const categoryMap = new Map<string, string>();
    for (const c of (categoriesRes.data ?? []) as Array<{
      id: string;
      name: string;
    }>) {
      categoryMap.set(c.id, c.name);
    }

    const areaMap = new Map<string, string>();
    for (const a of (areasRes.data ?? []) as Array<{
      id: string;
      name: string;
    }>) {
      areaMap.set(a.id, a.name);
    }

    const spotMap = new Map<string, string>();
    for (const s of (spotsRes.data ?? []) as Array<{
      id: string;
      name: string;
    }>) {
      spotMap.set(s.id, s.name);
    }

    const listingRows = (listingsRes.data ?? []) as RawListingRow[];
    const freeRows = freeRes.error
      ? []
      : ((freeRes.data ?? []) as RawFreeNoticeRow[]);

    // Fetch public-safe seller profiles via public_profiles view only (never private profiles table)
    const memberIds = Array.from(
      new Set([
        ...listingRows.map((r) => r.seller_id),
        ...freeRows.map((r) => r.contributor_id),
      ])
    ).filter(Boolean);

    const profileMap = new Map<string, RawPublicProfileRow>();
    if (memberIds.length > 0) {
      const profilesRes = await supabase
        .from("public_profiles")
        .select("id, display_name, university_role, faculty")
        .in("id", memberIds);

      if (!profilesRes.error && profilesRes.data) {
        for (const p of profilesRes.data as RawPublicProfileRow[]) {
          profileMap.set(p.id, p);
        }
      }
    }

    const mappedListings: Listing[] = listingRows.map((row) => {
      const listingType = mapListingType(row);
      const seller = profileMap.get(row.seller_id);
      const resolvedUrls = (row.image_paths ?? [])
        .map((p) => resolvePublicStorageUrl("listings", p, env.url))
        .filter((u): u is string => u !== null);

      const qty = typeof row.quantity === "number" ? row.quantity : null;
      const reserved =
        typeof row.reserved_quantity === "number" ? row.reserved_quantity : 0;
      const availableStock =
        listingType === "service" || qty === null
          ? null
          : Math.max(0, qty - reserved);

      return {
        id: row.id,
        slug: row.id,
        title: row.title,
        description: row.description ?? "",
        priceSen: typeof row.price_sen === "number" ? row.price_sen : 0,
        listingType,
        categoryId: row.category_id ?? "other-goods",
        categoryName:
          (row.category_id && categoryMap.get(row.category_id)) ||
          "Campus Marketplace",
        campusArea:
          (row.collection_area_id && areaMap.get(row.collection_area_id)) ||
          "UMSKAL, Labuan",
        condition: row.condition,
        availableStock,
        imageUrl: resolvedUrls[0] ?? null,
        imageUrls: resolvedUrls,
        imageAlt: row.title,
        sellerDisplayName: seller?.display_name || "UMS Campus Member",
        sellerBadge: formatRoleBadge(seller?.university_role),
        sellerFaculty: seller?.faculty ?? null,
        createdAt: row.published_at ?? row.created_at,
        isDemo: false,
      };
    });

    const mappedFree: Listing[] = freeRows.map((row) => {
      const contributor = profileMap.get(row.contributor_id);
      const resolvedUrls = (row.image_paths ?? [])
        .map((p) => resolvePublicStorageUrl("free-items", p, env.url))
        .filter((u): u is string => u !== null);

      return {
        id: row.id,
        slug: row.id,
        title: row.title,
        description: row.description ?? "",
        priceSen: 0,
        listingType: "free",
        categoryId: "free-items",
        categoryName: "Free Items",
        campusArea:
          (row.spot_id && spotMap.get(row.spot_id)) || "UMSKAL Donation Spot",
        condition: row.condition ?? "Free Giveaway",
        availableStock: null,
        imageUrl: resolvedUrls[0] ?? null,
        imageUrls: resolvedUrls,
        imageAlt: row.title,
        sellerDisplayName: contributor?.display_name || "UMS Campus Member",
        sellerBadge: formatRoleBadge(contributor?.university_role),
        sellerFaculty: contributor?.faculty ?? null,
        createdAt: row.published_at ?? row.created_at,
        isDemo: false,
      };
    });

    const combined = [...mappedListings, ...mappedFree];
    return {
      data: filterListings(combined, filters),
      source: "supabase",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Network error";
    return {
      data: [],
      source: "error",
      notice: `Supabase connection error: ${message}`,
    };
  }
}

export async function getListingById(
  idOrSlug: string,
  options?: { useDemo?: boolean }
): Promise<CatalogResult<Listing | null>> {
  const result = await getListings({ useDemo: options?.useDemo });
  if (result.source === "error") {
    return {
      data: null,
      source: "error",
      errorCode: result.errorCode,
      notice: result.notice,
    };
  }

  const found =
    result.data.find(
      (item) => item.id === idOrSlug || item.slug === idOrSlug
    ) ?? null;

  return {
    data: found,
    source: result.source,
    notice: result.notice,
  };
}
