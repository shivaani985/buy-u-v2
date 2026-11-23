import { DEMO_CATEGORIES, DEMO_LISTINGS } from "./demo-data";
import { createSupabaseServerClient } from "./supabase/server";
import type {
  CatalogResult,
  Category,
  Listing,
  ListingType,
  MarketplaceFilters,
} from "@/types/marketplace";

const CATEGORY_ICONS: Category["icon"][] = [
  "book",
  "laptop",
  "utensils",
  "shirt",
  "home",
  "wrench",
  "gift",
  "sparkles",
];

const CATEGORY_ACCENTS: Category["accent"][] = ["purple", "teal", "blue"];

function normalizeListingType(raw: unknown, priceRm: number): ListingType {
  if (priceRm <= 0) return "free";
  const value = String(raw ?? "").toLowerCase();
  if (value.includes("service")) return "service";
  if (value.includes("food")) return "food";
  if (value.includes("free")) return "free";
  if (value.includes("business") || value.includes("venture")) {
    return "student_business";
  }
  return "preloved";
}

function filterDemoListings(
  listings: Listing[],
  filters: MarketplaceFilters = {}
): Listing[] {
  const query = filters.q?.trim().toLowerCase() ?? "";
  const category = filters.category?.trim().toLowerCase() ?? "";
  const type = filters.type && filters.type !== "all" ? filters.type : null;

  return listings.filter((item) => {
    if (category && item.categorySlug.toLowerCase() !== category) {
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

/**
 * Read-only category fetch. Falls back cleanly to explicitly labeled demo data
 * when Supabase is not configured or the existing table is not yet reachable.
 */
export async function getCategories(): Promise<CatalogResult<Category[]>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return {
      data: DEMO_CATEGORIES,
      source: "demo",
      notice: "Demo catalog active (Supabase environment not connected yet).",
    };
  }

  try {
    const { data, error } = await supabase
      .from("categories")
      .select("id, slug, name, description")
      .order("name", { ascending: true })
      .limit(12);

    if (error || !data || data.length === 0) {
      return {
        data: DEMO_CATEGORIES,
        source: "demo",
        notice: "Demo categories shown while Supabase schema is unverified.",
      };
    }

    const mapped: Category[] = data.map((row, idx) => ({
      id: String(row.id),
      slug: String(row.slug ?? row.id),
      name: String(row.name ?? "Category"),
      description: String(row.description ?? "Campus marketplace category."),
      icon: CATEGORY_ICONS[idx % CATEGORY_ICONS.length] ?? "sparkles",
      accent: CATEGORY_ACCENTS[idx % CATEGORY_ACCENTS.length] ?? "purple",
    }));

    return { data: mapped, source: "supabase" };
  } catch {
    return {
      data: DEMO_CATEGORIES,
      source: "demo",
      notice: "Demo categories shown (read-only fallback).",
    };
  }
}

/**
 * Read-only published listings fetch. Never exposes private user fields.
 */
export async function getListings(
  filters: MarketplaceFilters = {}
): Promise<CatalogResult<Listing[]>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return {
      data: filterDemoListings(DEMO_LISTINGS, filters),
      source: "demo",
      notice: "Demo listings shown — configure .env.local to connect Supabase.",
    };
  }

  try {
    // Select only public-safe columns from listings; never select private PII.
    const { data, error } = await supabase
      .from("listings")
      .select("id, title, description, price, listing_type, status, created_at")
      .eq("status", "published")
      .order("created_at", { ascending: false })
      .limit(40);

    if (error || !data) {
      return {
        data: filterDemoListings(DEMO_LISTINGS, filters),
        source: "demo",
        notice: "Demo listings shown while Supabase listings schema is verified.",
      };
    }

    const mapped: Listing[] = data.map((row) => {
      const priceRm = Number(row.price ?? 0);
      const listingType = normalizeListingType(row.listing_type, priceRm);
      return {
        id: String(row.id),
        slug: String(row.id),
        title: String(row.title ?? "Untitled Campus Listing"),
        description: String(row.description ?? ""),
        priceRm: Number.isFinite(priceRm) ? priceRm : 0,
        listingType,
        categorySlug: listingType === "service" ? "student-services" : listingType === "free" ? "free-items" : "general",
        categoryName:
          listingType === "service"
            ? "Student Services"
            : listingType === "free"
              ? "Free Items"
              : "Marketplace",
        campusArea: "UMSKAL, Labuan",
        imageUrl: null,
        imageAlt: String(row.title ?? "Campus listing"),
        sellerDisplayName: "Verified Campus Member",
        sellerBadge: "Verified Student",
        createdAt: String(row.created_at ?? new Date().toISOString()),
        isDemo: false,
      };
    });

    return {
      data: filterDemoListings(mapped, filters),
      source: "supabase",
    };
  } catch {
    return {
      data: filterDemoListings(DEMO_LISTINGS, filters),
      source: "demo",
      notice: "Demo listings shown (read-only fallback).",
    };
  }
}

export async function getListingById(
  idOrSlug: string
): Promise<CatalogResult<Listing | null>> {
  const result = await getListings();
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
