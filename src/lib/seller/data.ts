import { foodAvailability, type FoodTerms } from "@/lib/food";
import { resolvePublicStorageUrl } from "@/lib/format";
import { getPublicSupabaseEnv } from "@/lib/supabase/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getServerServiceClient } from "@/lib/supabase/service";
import type { AuthSessionSummary, Category } from "@/types/marketplace";
import {
  computeSellerFinancials,
  type RawCheckoutSession,
  type RawOrderDispute,
  type RawOrderItem,
  type RawOrderRefund,
  type RawPayment,
  type RawPayoutRequest,
  type RawSellerOrder,
  type SalesRange,
  type SellerFinancialSummary,
} from "./financials";
import {
  isValidUuid,
  type ExistingVariantRecord,
} from "./listing-edit";
import {
  evaluateSellerEligibility,
  maskPayoutAccount,
  type MaskedPayoutStatus,
  type SellListingKind,
} from "./validation";

export interface SellerStorefront {
  sellerId: string;
  shopName: string;
  description: string;
  logoPath: string | null;
  logoUrl: string | null;
  bannerPath: string | null;
  bannerUrl: string | null;
  businessInfo: string | null;
  isOpen: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SellerListingSummary {
  foodStatus?: string;
  foodCutoff?: string | null;
  canCloseFood?: boolean;
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
  financials: SellerFinancialSummary;
  newOrderCount: number;
  error?: string;
}

export async function getSellerHubData(
  session: AuthSessionSummary,
  range: SalesRange = "7d"
): Promise<SellerHubData> {
  const unavailableFinancials: SellerFinancialSummary = {
    available: false,
    unavailableReason: "Financial summary unavailable.",
    range,
    totalSalesSen: 0,
    executedRefundsSen: 0,
    netSalesSen: 0,
    pendingSettlementSen: 0,
    protectionReserveSen: 0,
    nextProtectionReleaseAt: null,
    frozenDisputeSen: 0,
    availableForPayoutSen: 0,
    reservedWithdrawalsSen: 0,
    totalPaidOutSen: 0,
    failedWithdrawalCount: 0,
    commissionTotalSen: 0,
    commissionReversalSen: 0,
    netCommissionSen: 0,
    verifiedOrderCount: 0,
    transactions: [],
    chartPoints: [],
  };

  const empty: SellerHubData = {
    storefront: null,
    listings: [],
    counts: { total: 0, published: 0, draft: 0, soldOut: 0, other: 0 },
    payout: maskPayoutAccount(null),
    financials: unavailableFinancials,
    newOrderCount: 0,
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

  const [
    storefrontRes,
    listingsRes,
    payoutRes,
    categoriesRes,
    areasRes,
    ordersRes,
    payoutReqRes,
  ] = await Promise.all([
    supabase
      .from("storefronts")
      .select("seller_id, shop_name, description, logo_path, banner_path, business_info, is_open, created_at, updated_at")
      .eq("seller_id", userId)
      .maybeSingle()
      .then(async (res) => {
        if (!res.error) return res;
        return supabase
          .from("storefronts")
          .select("seller_id, shop_name, description, logo_path, created_at, updated_at")
          .eq("seller_id", userId)
          .maybeSingle();
      }),
    supabase
      .from("listings")
      .select(
        "id, title, kind, is_food, availability_mode, packaged_food_acknowledged, food_event_closed_at, preorder_close_at, pickup_window_start, pickup_window_end, category_id, collection_area_id, price_sen, quantity, reserved_quantity, status, condition, image_paths, published_at, updated_at"
      )
      .eq("seller_id", userId)
      .order("updated_at", { ascending: false })
      .limit(50),
    supabase
      .from("seller_payout_accounts")
      .select(
        "bank_name, account_holder_name, account_number_last4, account_number_masked, validation_status, is_active, updated_at"
      )
      .eq("seller_id", userId)
      .maybeSingle(),
    supabase.from("categories").select("id, name").eq("active", true),
    supabase.from("collection_areas").select("id, name").eq("active", true),
    supabase
      .from("orders")
      .select(
        "id, order_code, buyer_id, checkout_session_id, subtotal_sen, commission_sen, seller_net_sen, total_paid_sen, status, paid_at, completed_at, protection_expires_at, created_at"
      )
      .eq("seller_id", userId)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("payout_requests")
      .select("id, amount_sen, status, processed_at, created_at")
      .eq("seller_id", userId)
      .order("created_at", { ascending: false })
      .limit(100),
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
    banner_path?: string | null;
    business_info?: string | null;
    is_open?: boolean | null;
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
        bannerPath: sfRow.banner_path ?? null,
        bannerUrl: resolvePublicStorageUrl("listings", sfRow.banner_path ?? null, env.url),
        businessInfo: sfRow.business_info ?? null,
        isOpen: sfRow.is_open !== false,
        createdAt: sfRow.created_at,
        updatedAt: sfRow.updated_at,
      }
    : null;

  const rawListings = (listingsRes.data ?? []) as Array<{
    id: string;
    title: string;
    kind: string;
    is_food: boolean;
    availability_mode: string;
    packaged_food_acknowledged: boolean;
    food_event_closed_at: string | null;
    preorder_close_at: string | null;
    pickup_window_start: string | null;
    pickup_window_end: string | null;
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
    const foodStatus = row.is_food ? foodAvailability({
      availabilityMode: row.availability_mode,
      packagedAcknowledged: row.packaged_food_acknowledged,
      closedAt: row.food_event_closed_at,
      preorderCloseAt: row.preorder_close_at,
      pickupWindowStart: row.pickup_window_start,
      pickupWindowEnd: row.pickup_window_end,
    }, qty, reserved, Date.now()) : undefined;
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
      foodStatus,
      foodCutoff: row.preorder_close_at,
      canCloseFood: row.is_food && row.availability_mode === "pre_order" && row.status === "published"
        && (foodStatus === "Pre-order Open" || foodStatus === "Temporarily Unavailable"),
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

  const rawBank = payoutRes.error
    ? null
    : (payoutRes.data as {
        bank_name?: string | null;
        account_holder_name?: string | null;
        account_number_last4?: string | null;
        account_number_masked?: string | null;
        validation_status?: string | null;
        is_active?: boolean | null;
        updated_at?: string | null;
      } | null);

  const payout = maskPayoutAccount(
    rawBank && rawBank.is_active && rawBank.validation_status === "validated"
      ? {
          bank_name: rawBank.bank_name,
          account_number: rawBank.account_number_masked ?? rawBank.account_number_last4,
          account_holder_name: rawBank.account_holder_name,
          updated_at: rawBank.updated_at,
        }
      : null
  );

  let financials: SellerFinancialSummary = unavailableFinancials;
  if (!ordersRes.error && !payoutReqRes.error) {
    const orders = (ordersRes.data ?? []) as RawSellerOrder[];
    const payoutRequests = (payoutReqRes.data ?? []) as RawPayoutRequest[];
    const orderIds = orders.map((o) => o.id);
    const checkoutSessionIds = Array.from(
      new Set(
        orders
          .map((o) => o.checkout_session_id)
          .filter((id): id is string => Boolean(id))
      )
    );

    let orderItems: RawOrderItem[] = [];
    let payments: RawPayment[] = [];
    let checkoutSessions: RawCheckoutSession[] = [];
    let disputes: RawOrderDispute[] = [];
    let refunds: RawOrderRefund[] = [];

    if (orderIds.length > 0) {
      const service = getServerServiceClient();
      const [itemsRes, paymentsRes, disputesRes, refundsRes, csRes] =
        await Promise.all([
          supabase
            .from("order_items")
            .select("order_id, title_snapshot, quantity")
            .in("order_id", orderIds),
          supabase
            .from("payments")
            .select("order_id, status, verified_at")
            .in("order_id", orderIds),
          supabase
            .from("order_disputes")
            .select("order_id, status, refund_amount_sen, refund_execution_status")
            .in("order_id", orderIds),
          supabase
            .from("order_refunds")
            .select(
              "order_id, refund_amount_sen, commission_reversal_sen, seller_deduction_sen, status"
            )
            .in("order_id", orderIds),
          checkoutSessionIds.length > 0 && service
            ? service
                .from("checkout_sessions")
                .select("id, buyer_id, status, payment_status, paid_at")
                .in("id", checkoutSessionIds)
            : Promise.resolve({ data: [], error: null }),
        ]);
      if (!itemsRes.error) orderItems = (itemsRes.data ?? []) as RawOrderItem[];
      if (!paymentsRes.error) payments = (paymentsRes.data ?? []) as RawPayment[];
      if (!disputesRes.error) disputes = (disputesRes.data ?? []) as RawOrderDispute[];
      if (!refundsRes.error) refunds = (refundsRes.data ?? []) as RawOrderRefund[];
      if (!csRes.error) {
        checkoutSessions = (csRes.data ?? []) as RawCheckoutSession[];
      }
    }

    financials = computeSellerFinancials({
      orders,
      orderItems,
      payments,
      checkoutSessions,
      payoutRequests,
      disputes,
      refunds,
      range,
    });
  } else {
    financials = {
      ...unavailableFinancials,
      unavailableReason:
        "Unable to load verified order or payout records right now.",
    };
  }

  const error = storefrontRes.error?.message || listingsRes.error?.message;
  const newOrderCount = !ordersRes.error
    ? ((ordersRes.data ?? []) as RawSellerOrder[]).filter(
        (o) => o.status === "paid" && Boolean(o.paid_at)
      ).length
    : 0;

  return {
    storefront,
    listings,
    counts,
    payout,
    financials,
    newOrderCount,
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
      .select("seller_id, shop_name, description, logo_path, banner_path, business_info, is_open, created_at, updated_at")
      .eq("seller_id", userId)
      .maybeSingle()
      .then(async (res) => {
        if (!res.error) return res;
        return supabase
          .from("storefronts")
          .select("seller_id, shop_name, description, logo_path, created_at, updated_at")
          .eq("seller_id", userId)
          .maybeSingle();
      }),
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
    banner_path?: string | null;
    business_info?: string | null;
    is_open?: boolean | null;
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
        bannerPath: sfRow.banner_path ?? null,
        bannerUrl: resolvePublicStorageUrl("listings", sfRow.banner_path ?? null, env.url),
        businessInfo: sfRow.business_info ?? null,
        isOpen: sfRow.is_open !== false,
        createdAt: sfRow.created_at,
        updatedAt: sfRow.updated_at,
      }
    : null;

  return { categories, collectionAreas, storefront };
}

export interface EditablePhotoItem {
  path: string;
  url: string;
}

export interface SellerListingDetail {
  food?: FoodTerms;
  foodScheduleLocked?: boolean;
  id: string;
  sellerId: string;
  title: string;
  description: string;
  listingType: SellListingKind;
  categoryId: string;
  priceSen: number;
  quantity: number;
  reservedQuantity: number;
  availableStock: number;
  collectionAreaId: string;
  condition: string;
  status: string;
  allowOffers: boolean;
  rulesAcknowledged: boolean;
  hasVariants: boolean;
  optionGroups: string[];
  variationPhotoGroup: string | null;
  photos: EditablePhotoItem[];
  variants: ExistingVariantRecord[];
  lockedVariantIds: string[];
  updatedAt: string;
  publishedAt: string | null;
}

export type SellerListingEditLoadResult =
  | {
      status: "ok";
      listing: SellerListingDetail;
      categories: Category[];
      collectionAreas: CollectionAreaOption[];
    }
  | { status: "not_found" | "forbidden" | "error"; message: string };

/**
 * Loads a listing strictly for its verified Student owner, including its
 * variants and which variants are referenced by active order_items.
 */
export async function getSellerListingForEdit(
  session: AuthSessionSummary,
  listingId: string
): Promise<SellerListingEditLoadResult> {
  const eligibility = evaluateSellerEligibility(session);
  const userId = session.profile?.id;
  if (!eligibility.eligible || !userId) {
    return { status: "forbidden", message: "Seller access required." };
  }
  if (!isValidUuid(listingId)) {
    return { status: "not_found", message: "Listing not found." };
  }

  const env = getPublicSupabaseEnv();
  const supabase = await createSupabaseServerClient();
  if (!supabase || !env) {
    return { status: "error", message: "Supabase client is not configured." };
  }

  const [listingRes, variantsRes, categoriesRes, areasRes] = await Promise.all([
    supabase
      .from("listings")
      .select(
        "id, seller_id, kind, is_food, availability_mode, packaged_food_acknowledged, food_event_closed_at, preorder_close_at, pickup_window_start, pickup_window_end, title, description, category_id, condition, price_sen, quantity, reserved_quantity, collection_area_id, allow_offers, has_variants, option_groups, variation_photo_group, image_paths, rules_acknowledged, status, published_at, updated_at"
      )
      .eq("id", listingId)
      .maybeSingle()
      .then(async (res) => {
        if (!res.error) return res;
        return supabase
          .from("listings")
          .select(
            "id, seller_id, kind, is_food, availability_mode, packaged_food_acknowledged, food_event_closed_at, preorder_close_at, pickup_window_start, pickup_window_end, title, description, category_id, condition, price_sen, quantity, reserved_quantity, collection_area_id, allow_offers, has_variants, option_groups, image_paths, rules_acknowledged, status, published_at, updated_at"
          )
          .eq("id", listingId)
          .maybeSingle();
      }),
    supabase
      .from("listing_variants")
      .select("id, option_values, price_sen, quantity, reserved_quantity, active, image_path")
      .eq("listing_id", listingId)
      .order("id", { ascending: true })
      .then(async (res) => {
        if (!res.error) return res;
        return supabase
          .from("listing_variants")
          .select("id, option_values, price_sen, quantity, reserved_quantity, active")
          .eq("listing_id", listingId)
          .order("id", { ascending: true });
      }),
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
  ]);

  if (listingRes.error) {
    return { status: "error", message: listingRes.error.message };
  }
  const row = listingRes.data as {
    id: string;
    seller_id: string;
    kind: string;
    is_food: boolean;
    availability_mode: string | null;
    packaged_food_acknowledged: boolean;
    food_event_closed_at: string | null;
    preorder_close_at: string | null;
    pickup_window_start: string | null;
    pickup_window_end: string | null;
    title: string;
    description: string;
    category_id: string;
    condition: string | null;
    price_sen: number;
    quantity: number;
    reserved_quantity: number;
    collection_area_id: string | null;
    allow_offers: boolean;
    has_variants: boolean;
    option_groups: string[] | null;
    variation_photo_group?: string | null;
    image_paths: string[] | null;
    rules_acknowledged: boolean;
    status: string;
    published_at: string | null;
    updated_at: string;
  } | null;

  if (!row) {
    return { status: "not_found", message: "Listing not found." };
  }
  if (row.seller_id !== userId) {
    return {
      status: "forbidden",
      message: "You can only edit listings that belong to your own storefront.",
    };
  }

  const rawVariants = (variantsRes.data ?? []) as Array<{
    id: string;
    option_values: Record<string, string> | null;
    price_sen: number;
    quantity: number;
    reserved_quantity: number;
    active: boolean;
    image_path?: string | null;
  }>;

  const variantIds = rawVariants.map((v) => v.id);
  const lockedSet = new Set<string>();
  for (const v of rawVariants) {
    if ((v.reserved_quantity ?? 0) > 0) lockedSet.add(v.id);
  }

  if (variantIds.length > 0) {
    const orderItemsRes = await supabase
      .from("order_items")
      .select("variant_id")
      .in("variant_id", variantIds);
    if (!orderItemsRes.error && orderItemsRes.data) {
      for (const oi of orderItemsRes.data as Array<{ variant_id: string | null }>) {
        if (oi.variant_id) lockedSet.add(oi.variant_id);
      }
    }
  }

  let foodScheduleLocked = false;
  if (row.is_food && row.availability_mode === "pre_order") {
    foodScheduleLocked = Boolean(row.food_event_closed_at || (row.preorder_close_at &&
      Date.parse(row.preorder_close_at) <= Date.now()) || row.reserved_quantity > 0);
    if (!foodScheduleLocked) {
      const committed = await supabase.from("order_items").select("id,orders!inner(paid_at)")
        .eq("listing_id", row.id).not("orders.paid_at", "is", null).limit(1);
      foodScheduleLocked = Boolean(committed.data?.length);
    }
  }

  const listingType: SellListingKind = row.is_food
    ? "food"
    : row.kind === "service"
      ? "service"
      : row.kind === "business"
        ? "business"
        : "preloved";

  const photos: EditablePhotoItem[] = (row.image_paths ?? [])
    .map((path) => {
      const url = resolvePublicStorageUrl("listings", path, env.url);
      return url ? { path, url } : null;
    })
    .filter((p): p is EditablePhotoItem => p !== null);

  const accents: Category["accent"][] = ["purple", "blue", "teal"];
  const categories: Category[] = (
    (categoriesRes.data ?? []) as Array<{
      id: string;
      name: string;
      kind: string | null;
      icon: string | null;
      sort_order: number | null;
    }>
  ).map((c, idx) => ({
    id: c.id,
    slug: c.id,
    name: c.name,
    kind: c.kind === "service" ? "service" : "product",
    description: "",
    icon: c.icon ?? "package",
    sortOrder: c.sort_order ?? idx + 1,
    accent: accents[idx % accents.length] ?? "purple",
  }));

  const collectionAreas = (areasRes.data ?? []) as CollectionAreaOption[];

  return {
    status: "ok",
    listing: {
      id: row.id,
      sellerId: row.seller_id,
      title: row.title,
      description: row.description ?? "",
      listingType,
      categoryId: row.category_id,
      priceSen: row.price_sen ?? 0,
      quantity: row.quantity ?? 0,
      reservedQuantity: row.reserved_quantity ?? 0,
      availableStock: Math.max(0, (row.quantity ?? 0) - (row.reserved_quantity ?? 0)),
      collectionAreaId: row.collection_area_id ?? "",
      foodScheduleLocked,
      food: row.is_food ? {
        availabilityMode: row.availability_mode,
        packagedAcknowledged: row.packaged_food_acknowledged,
        closedAt: row.food_event_closed_at,
        preorderCloseAt: row.preorder_close_at,
        pickupWindowStart: row.pickup_window_start,
        pickupWindowEnd: row.pickup_window_end,
      } : undefined,
      condition: row.condition ?? "",
      status: row.status,
      allowOffers: Boolean(row.allow_offers),
      rulesAcknowledged: Boolean(row.rules_acknowledged),
      hasVariants: Boolean(row.has_variants),
      optionGroups: row.option_groups ?? [],
      variationPhotoGroup: row.variation_photo_group ?? null,
      photos,
      variants: rawVariants.map((v) => ({
        id: v.id,
        optionValues: v.option_values ?? {},
        priceSen: v.price_sen ?? 0,
        quantity: v.quantity ?? 0,
        reservedQuantity: v.reserved_quantity ?? 0,
        active: Boolean(v.active),
        imagePath: v.image_path ?? null,
      })),
      lockedVariantIds: Array.from(lockedSet),
      updatedAt: row.updated_at,
      publishedAt: row.published_at,
    },
    categories,
    collectionAreas,
  };
}

/**
 * Counts paid seller orders awaiting completion.
 */
export async function getSellerNewOrderCount(
  session: AuthSessionSummary
): Promise<number> {
  const userId = session.profile?.id;
  if (!session.isAuthenticated || !userId) return 0;
  const supabase = await createSupabaseServerClient();
  if (!supabase) return 0;

  try {
    const { count, error } = await supabase
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("seller_id", userId)
      .eq("status", "paid")
      .not("paid_at", "is", null);

    if (error || typeof count !== "number") return 0;
    return Math.max(0, count);
  } catch {
    return 0;
  }
}
