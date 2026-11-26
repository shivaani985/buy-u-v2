import type { SupabaseLikeClient } from "@/lib/reviews/presentation";
import {
  evaluateRepurchaseAvailability,
  type ItemRepurchaseState,
  type RepurchaseListingRecord,
  type RepurchaseVariantRecord,
} from "@/lib/reviews/presentation";
import {
  matchLegacyVariantImagePath,
  normalizeVariantSnapshotRecord,
  resolvePurchasedItemImageUrl,
  type VariantMatchCandidate,
} from "./item-images";

export interface RawOrderItemForMedia {
  id: string;
  order_id: string;
  listing_id: string | null;
  variant_id?: string | null;
  variant_snapshot?: Record<string, unknown> | null;
  image_path: string | null;
  is_service?: boolean | null;
}

export interface OrderItemMediaContext {
  offerImageByOrder: Map<string, string>;
  listingCoverById: Map<string, string>;
  variantsById: Map<string, VariantMatchCandidate>;
  variantsByListing: Map<string, VariantMatchCandidate[]>;
}

/**
 * Loads batch lookup maps needed to enforce the exact 5-tier historical
 * purchased item image resolution across buyer orders, seller orders, and disputes.
 */
export async function loadOrderItemMediaContext(
  client: SupabaseLikeClient,
  items: RawOrderItemForMedia[]
): Promise<OrderItemMediaContext> {
  const orderIds = Array.from(new Set(items.map((it) => it.order_id).filter(Boolean)));
  const listingIds = Array.from(
    new Set(items.map((it) => it.listing_id).filter((id): id is string => Boolean(id)))
  );

  // Only query extra relations when an order item is missing its own snapshot
  // or references a physical item where offer/variant fallback may apply.
  const needsContext = items.some((it) => !it.image_path || !it.image_path.trim());
  if (!needsContext || orderIds.length === 0) {
    return {
      offerImageByOrder: new Map(),
      listingCoverById: new Map(),
      variantsById: new Map(),
      variantsByListing: new Map(),
    };
  }

  const [offersRes, listingsRes, variantsRes] = await Promise.all([
    client
      .from("offers")
      .select("order_id,variant_image_path")
      .in("order_id", orderIds)
      .then((res: { data?: unknown; error?: unknown }) =>
        res.error ? { data: [] } : res
      ),
    listingIds.length > 0
      ? client.from("listings").select("id,image_paths").in("id", listingIds)
      : Promise.resolve({ data: [] }),
    listingIds.length > 0
      ? client
          .from("listing_variants")
          .select("id,listing_id,option_values,image_path")
          .in("listing_id", listingIds)
          .then((res: { data?: unknown; error?: unknown }) =>
            res.error ? { data: [] } : res
          )
      : Promise.resolve({ data: [] }),
  ]);

  const offerImageByOrder = new Map<string, string>();
  for (const row of ((offersRes.data ?? []) as Array<{
    order_id: string | null;
    variant_image_path?: string | null;
  }>)) {
    if (row.order_id && row.variant_image_path?.trim()) {
      offerImageByOrder.set(row.order_id, row.variant_image_path.trim());
    }
  }

  const listingCoverById = new Map<string, string>();
  for (const row of ((listingsRes.data ?? []) as Array<{
    id: string;
    image_paths: string[] | null;
  }>)) {
    const first = Array.isArray(row.image_paths) ? row.image_paths[0]?.trim() : "";
    if (first) listingCoverById.set(row.id, first);
  }

  const variantsById = new Map<string, VariantMatchCandidate>();
  const variantsByListing = new Map<string, VariantMatchCandidate[]>();
  for (const v of ((variantsRes.data ?? []) as VariantMatchCandidate[])) {
    variantsById.set(v.id, v);
    const arr = variantsByListing.get(v.listing_id) ?? [];
    arr.push(v);
    variantsByListing.set(v.listing_id, arr);
  }

  return {
    offerImageByOrder,
    listingCoverById,
    variantsById,
    variantsByListing,
  };
}

export function resolveOrderItemImageWithContext(
  item: RawOrderItemForMedia,
  ctx: OrderItemMediaContext,
  storageBaseUrl: string | null | undefined
): string | null {
  const normSnap = normalizeVariantSnapshotRecord(item.variant_snapshot);
  const matchedVariantImage =
    !item.image_path?.trim() && !item.is_service
      ? matchLegacyVariantImagePath({
          listingId: item.listing_id,
          variantId: item.variant_id,
          variantSnapshot: normSnap,
          variantsById: ctx.variantsById,
          variantsByListing: ctx.variantsByListing,
        })
      : null;

  return resolvePurchasedItemImageUrl({
    orderItemImagePath: item.image_path,
    offerVariantImagePath: !item.image_path?.trim()
      ? ctx.offerImageByOrder.get(item.order_id) ?? null
      : null,
    variantImagePath: matchedVariantImage,
    listingCoverPath: item.listing_id
      ? ctx.listingCoverById.get(item.listing_id) ?? null
      : null,
    storageBaseUrl,
  });
}

/**
 * Queries live listing and variation inventory to evaluate Buy Again / Book Again
 * eligibility on completed orders.
 */
export async function resolveCompletedOrdersRepurchaseMap(
  client: SupabaseLikeClient,
  buyerUserId: string | null,
  items: Array<{
    id: string;
    listingId: string | null;
    variantId: string | null;
    variantLabel: string | null;
    isService: boolean;
  }>
): Promise<Map<string, ItemRepurchaseState>> {
  const listingIds = Array.from(
    new Set(items.map((it) => it.listingId).filter((id): id is string => Boolean(id)))
  );

  const [listingsRes, variantsRes] = await Promise.all([
    listingIds.length > 0
      ? client
          .from("listings")
          .select("id,seller_id,kind,status,has_variants,quantity,reserved_quantity,accepting_requests")
          .in("id", listingIds)
      : Promise.resolve({ data: [] }),
    listingIds.length > 0
      ? client
          .from("listing_variants")
          .select("id,listing_id,active,quantity,reserved_quantity")
          .in("listing_id", listingIds)
      : Promise.resolve({ data: [] }),
  ]);

  const listingMap = new Map<string, RepurchaseListingRecord>();
  for (const row of (listingsRes.data ?? []) as RepurchaseListingRecord[]) {
    listingMap.set(row.id, row);
  }

  const variantsByListing = new Map<string, RepurchaseVariantRecord[]>();
  for (const v of (variantsRes.data ?? []) as RepurchaseVariantRecord[]) {
    const arr = variantsByListing.get(v.listing_id) ?? [];
    arr.push(v);
    variantsByListing.set(v.listing_id, arr);
  }

  const result = new Map<string, ItemRepurchaseState>();
  for (const item of items) {
    result.set(
      item.id,
      evaluateRepurchaseAvailability({
        buyerUserId,
        item,
        listing: item.listingId ? listingMap.get(item.listingId) ?? null : null,
        variants: item.listingId ? variantsByListing.get(item.listingId) ?? [] : [],
      })
    );
  }
  return result;
}
