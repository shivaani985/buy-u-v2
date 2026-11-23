export type ListingType =
  | "preloved"
  | "student_business"
  | "food"
  | "service"
  | "free";

export type CatalogDataSource = "supabase" | "demo";

export interface Category {
  id: string;
  slug: string;
  name: string;
  description: string;
  icon:
    | "book"
    | "laptop"
    | "utensils"
    | "shirt"
    | "wrench"
    | "gift"
    | "sparkles"
    | "home";
  accent: "purple" | "teal" | "blue";
  listingCount?: number;
}

export interface Listing {
  id: string;
  slug: string;
  title: string;
  description: string;
  priceRm: number;
  listingType: ListingType;
  categorySlug: string;
  categoryName: string;
  campusArea: string;
  condition?: string;
  imageUrl: string | null;
  imageAlt: string;
  sellerDisplayName: string;
  sellerBadge: "Verified Student" | "UMS Staff" | "Student Venture";
  createdAt: string;
  isDemo: boolean;
}

export interface MarketplaceFilters {
  q?: string;
  category?: string;
  type?: ListingType | "all";
}

export interface CatalogResult<T> {
  data: T;
  source: CatalogDataSource;
  notice?: string;
}

export interface AuthSessionSummary {
  isAuthenticated: boolean;
  email: string | null;
  source: CatalogDataSource;
}
