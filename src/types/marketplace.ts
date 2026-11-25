export type ListingType =
  | "preloved"
  | "business"
  | "food"
  | "service"
  | "free";

export type CatalogDataSource =
  | "supabase"
  | "demo"
  | "auth_required"
  | "restricted"
  | "error";

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
  rating?: number | null;
  reviewCount?: number;
  salesCount?: number;
  createdAt: string;
  isDemo: boolean;
}

export type MarketplaceSort = "latest" | "price_asc" | "price_desc";

export interface MarketplaceFilters {
  q?: string;
  category?: string;
  type?: ListingType | "all";
  minPrice?: number;
  maxPrice?: number;
  condition?: string;
  inStock?: boolean;
  sort?: MarketplaceSort;
  useDemo?: boolean;
}

export interface CatalogResult<T> {
  data: T;
  source: CatalogDataSource;
  notice?: string;
  errorCode?: string;
}

export interface MemberProfile {
  id: string;
  email: string;
  university_role: string;
  status: string;
  restriction_reason: string | null;
  full_name: string | null;
  display_name: string | null;
  faculty: string | null;
  bio: string | null;
  avatar_url: string | null;
  created_at: string;
}

export interface AuthSessionSummary {
  isAuthenticated: boolean;
  isEmailVerified: boolean;
  isActiveMember: boolean;
  isActiveAdmin: boolean;
  email: string | null;
  profile: MemberProfile | null;
  source: "supabase" | "unconfigured";
}
