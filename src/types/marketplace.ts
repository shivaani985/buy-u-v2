export type ListingType =
  | "preloved"
  | "business"
  | "food"
  | "service"
  | "free";

export type CatalogDataSource = "supabase" | "demo" | "error";

export interface Category {
  id: string;
  slug: string;
  name: string;
  kind: "product" | "service" | "free";
  description: string;
  icon: string;
  sortOrder: number;
  accent: "purple" | "teal" | "blue";
}

export interface Listing {
  id: string;
  slug: string;
  title: string;
  description: string;
  /** Always stored in integer sen (e.g. 1500 = RM 15.00). 0 for free items. */
  priceSen: number;
  listingType: ListingType;
  categoryId: string;
  categoryName: string;
  campusArea: string;
  condition: string | null;
  availableStock: number | null;
  imageUrl: string | null;
  imageUrls: string[];
  imageAlt: string;
  sellerDisplayName: string;
  sellerBadge: string;
  sellerFaculty: string | null;
  createdAt: string;
  isDemo: boolean;
}

export interface MarketplaceFilters {
  q?: string;
  category?: string;
  type?: ListingType | "all";
  useDemo?: boolean;
}

export interface CatalogResult<T> {
  data: T;
  source: CatalogDataSource;
  notice?: string;
  errorCode?: string;
}

export interface AuthSessionSummary {
  isAuthenticated: boolean;
  email: string | null;
  source: "supabase" | "unconfigured";
}
