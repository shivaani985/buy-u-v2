import { isValidUuid } from "@/lib/buyer/validation";
import { freeNoticePhotoHref } from "@/lib/marketplace/free-noticeboard";
import { readOrderPages } from "@/lib/orders/read";
import { DEMO_CATEGORIES, DEMO_LISTINGS } from "./demo-data";
import { resolvePublicStorageUrl } from "./format";
import { loadListingRatingAndSoldMap } from "./reviews/presentation";
import { getPublicSupabaseEnv } from "./supabase/env";
import {
  createSupabaseServerClient,
  getSessionSummary,
} from "./supabase/server";
import { getServerServiceClient } from "./supabase/service";
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
  availability_mode: "ready" | "pre_order";
  preorder_close_at: string | null;
  pickup_window_start: string | null;
  pickup_window_end: string | null;
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
  pickup_location: string;
  image_paths: string[] | null;
  status: string;
  published_at: string | null;
  renewed_at: string | null;
  expires_at: string;
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
  const condition = filters.condition?.trim().toLowerCase() ?? "";
  const minSen =
    typeof filters.minPrice === "number" && Number.isFinite(filters.minPrice) && filters.minPrice >= 0
      ? Math.round(filters.minPrice * 100)
      : null;
  const maxSen =
    typeof filters.maxPrice === "number" && Number.isFinite(filters.maxPrice) && filters.maxPrice >= 0
      ? Math.round(filters.maxPrice * 100)
      : null;

  const filtered = listings.filter((item) => {
    if (category && item.categoryId.toLowerCase() !== category) {
      return false;
    }
    if (type && item.listingType !== type) {
      return false;
    }
    if (minSen !== null && item.priceSen < minSen) {
      return false;
    }
    if (maxSen !== null && item.priceSen > maxSen) {
      return false;
    }
    if (condition) {
      const itemCond = (item.condition ?? "").toLowerCase();
      if (!itemCond.includes(condition)) {
        return false;
      }
    }
    if (filters.inStock && item.availableStock === 0) {
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

  const sort = filters.sort ?? "latest";
  return [...filtered].sort((a, b) => {
    if (sort === "price_asc") {
      return a.priceSen - b.priceSen;
    }
    if (sort === "price_desc") {
      return b.priceSen - a.priceSen;
    }
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

/**
 * Checks whether the current visitor is allowed to query the live UMS catalog.
 * Never bypasses RLS or grants anonymous database access.
 */
async function checkMemberCatalogAccess(): Promise<
  | { allowed: true }
  | { allowed: false; source: "auth_required" | "restricted"; notice: string }
> {
  const session = await getSessionSummary();

  if (!session.isAuthenticated) {
    return {
      allowed: false,
      source: "auth_required",
      notice:
        "Sign in with your verified UMS student (@iluv.ums.edu.my) or staff (@ums.edu.my) account to browse live UMSKAL listings.",
    };
  }

  if (!session.isEmailVerified) {
    return {
      allowed: false,
      source: "restricted",
      notice:
        "Verify your UMS email address via the link sent to your inbox before accessing the live campus catalog.",
    };
  }

  if (!session.isActiveMember && !session.isActiveAdmin) {
    const status = session.profile?.status ?? "inactive";
    return {
      allowed: false,
      source: "restricted",
      notice: `Your account status is "${status}". Only active verified UMS members can browse live listings.`,
    };
  }

  return { allowed: true };
}

/**
 * Read-only category fetch strictly via authenticated member session + publishable key.
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
      notice: "Explicit Demo Mode (?demo=1). Sample categories shown.",
    };
  }

  if (!env) {
    return {
      data: DEMO_CATEGORIES,
      source: "demo",
      notice: "Supabase environment not configured. Showing demo categories.",
    };
  }

  const gate = await checkMemberCatalogAccess();
  if (!gate.allowed) {
    return { data: [], source: gate.source, notice: gate.notice };
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
        notice: `Authenticated category query failed (${error.code}): ${error.message}`,
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
 * Read-only published listings + free_notices fetch via authenticated member session.
 */
export async function getListings(
  filters: MarketplaceFilters = {},
  freeNoticeId?: string,
): Promise<CatalogResult<Listing[]>> {
  const env = getPublicSupabaseEnv();

  if (filters.useDemo) {
    return {
      data: filterListings(DEMO_LISTINGS, filters),
      source: "demo",
      notice: "Explicit Demo Mode (?demo=1). Sample listings shown.",
    };
  }

  if (!env) {
    return {
      data: filterListings(DEMO_LISTINGS, filters),
      source: "demo",
      notice: "Supabase environment not configured. Showing demo listings.",
    };
  }

  const gate = await checkMemberCatalogAccess();
  if (!gate.allowed) {
    return { data: [], source: gate.source, notice: gate.notice };
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
    const freeSnapshotAt = Date.now();
    let freeQuery = supabase.from("free_notices")
      .select("id,contributor_id,title,description,condition,pickup_location,image_paths,status,created_at,published_at,renewed_at,expires_at")
      .eq("status", "active").gt("expires_at", new Date(freeSnapshotAt).toISOString()).not("pickup_location", "is", null)
      .order("id");
    if (freeNoticeId && isValidUuid(freeNoticeId)) freeQuery = freeQuery.eq("id", freeNoticeId);
    const [listingsRes, categoriesRes, areasRes, freeRes] =
      await Promise.all([
        supabase
          .from("listings")
          .select(
            "id, seller_id, kind, title, description, category_id, condition, price_sen, quantity, reserved_quantity, collection_area_id, is_food, availability_mode, preorder_close_at, pickup_window_start, pickup_window_end, image_paths, status, published_at, created_at"
          )
          .eq("status", "published")
          .or(`is_food.eq.false,and(is_food.eq.true,availability_mode.eq.ready,packaged_food_acknowledged.eq.true),and(is_food.eq.true,availability_mode.eq.pre_order,food_event_closed_at.is.null,preorder_close_at.gt.${new Date().toISOString()},pickup_window_start.not.is.null,pickup_window_end.not.is.null)`)
          .order("published_at", { ascending: false, nullsFirst: false })
          .limit(50),
        supabase.from("categories").select("id, name").eq("active", true),
        supabase.from("collection_areas").select("id, name").eq("active", true),
        readOrderPages((start, end) => freeQuery.range(start, end)),
      ]);

    if (listingsRes.error) {
      return {
        data: [],
        source: "error",
        errorCode: listingsRes.error.code,
        notice: `Authenticated listings query failed (${listingsRes.error.code}): ${listingsRes.error.message}`,
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

    const listingRows = (listingsRes.data ?? []) as RawListingRow[];
    const freeRows = freeRes.error
      ? []
      : ((freeRes.data ?? []) as RawFreeNoticeRow[]);

    const memberIds = Array.from(
      new Set([
        ...listingRows.map((r) => r.seller_id),
        ...freeRows.map((r) => r.contributor_id),
      ])
    ).filter(Boolean);

    const profileMap = new Map<string, RawPublicProfileRow>();
    const serviceClient = getServerServiceClient();

    const [profilesRes, metricsMap] = await Promise.all([
      memberIds.length > 0
        ? supabase
            .from("public_profiles")
            .select("id, display_name, university_role, faculty")
            .in("id", memberIds)
        : Promise.resolve({ data: [], error: null }),
      serviceClient && listingRows.length > 0
        ? loadListingRatingAndSoldMap(
            serviceClient,
            listingRows.map((r) => ({ listingId: r.id, sellerId: r.seller_id }))
          )
        : Promise.resolve(new Map()),
    ]);

    if (!profilesRes.error && profilesRes.data) {
      for (const p of profilesRes.data as RawPublicProfileRow[]) {
        profileMap.set(p.id, p);
      }
    }

    const mappedListings: Listing[] = listingRows.map((row) => {
      const listingType = mapListingType(row);
      const seller = profileMap.get(row.seller_id);
      const metrics = metricsMap.get(row.id);
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
        ...(row.is_food ? { foodSchedule: { mode: row.availability_mode, cutoff: row.preorder_close_at,
          start: row.pickup_window_start, end: row.pickup_window_end } } : {}),
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
        rating: metrics?.effectiveRating ?? null,
        reviewCount: metrics?.effectiveReviewCount ?? 0,
        ratingSource: metrics?.ratingSource ?? "none",
        salesCount: metrics?.totalSold ?? 0,
        createdAt: row.published_at ?? row.created_at,
        isDemo: false,
      };
    });

    const mappedFree: Listing[] = freeRows.map((row) => {
      const contributor = profileMap.get(row.contributor_id);
      const resolvedUrls = (row.image_paths ?? [])
        .map((_, index) => freeNoticePhotoHref(row.id, index));

      return {
        id: row.id,
        slug: row.id,
        title: row.title,
        description: row.description ?? "",
        priceSen: 0,
        listingType: "free",
        categoryId: "free-items",
        categoryName: "Free Items",
        campusArea: row.pickup_location,
        condition: row.condition ?? "Free Giveaway",
        availableStock: null,
        imageUrl: resolvedUrls[0] ?? null,
        imageUrls: resolvedUrls,
        imageAlt: row.title,
        sellerDisplayName: contributor?.display_name || "UMS Campus Member",
        sellerBadge: formatRoleBadge(contributor?.university_role),
        sellerFaculty: contributor?.faculty ?? null,
        createdAt: row.renewed_at ?? row.published_at ?? row.created_at,
        freeVisibility: { expiresAt: row.expires_at, snapshotAt: freeSnapshotAt },
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
  const result = await getListings({ useDemo: options?.useDemo }, idOrSlug);
  if (
    result.source === "error" ||
    result.source === "auth_required" ||
    result.source === "restricted"
  ) {
    return {
      data: null,
      source: result.source,
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
