import type { BuyerEligibilityResult } from "./validation";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CART_ELIGIBLE_KINDS = new Set(["pre_loved", "business"]);

export type CartIssueCode =
  | "deleted"
  | "archived"
  | "unavailable"
  | "self_purchase"
  | "non_physical"
  | "variant_unavailable"
  | "out_of_stock"
  | "exceeds_stock";

export interface CartItemView {
  id: string;
  listingId: string;
  variantId: string | null;
  variantLabel: string | null;
  title: string;
  imageUrl: string | null;
  campusArea: string | null;
  condition: string | null;
  sellerId: string;
  sellerDisplayName: string;
  storefrontName: string | null;
  sellerLogoUrl: string | null;
  sellerBadge: string;
  /** Authoritative live unit price in integer sen. */
  unitPriceSen: number;
  quantity: number;
  availableStock: number;
  reservedQuantity: number;
  /** Integer sen subtotal for this line (0 if invalid/blocked). */
  lineSubtotalSen: number;
  isValid: boolean;
  issueCode: CartIssueCode | null;
  issueMessage: string | null;
  canAdjustToMax: boolean;
  isFood?: boolean;
  availabilityMode?: string | null;
  pickupWindowStart?: string | null;
  pickupWindowEnd?: string | null;
  pickupNote?: string | null;
  foodNotes?: string | null;
}

export interface CartSellerGroup {
  sellerId: string;
  sellerName: string;
  sellerSubtext: string | null;
  sellerLogoUrl: string | null;
  sellerBadge: string;
  items: CartItemView[];
  validQuantity: number;
  invalidRowCount: number;
  subtotalSen: number;
}

export interface CartSummary {
  groups: CartSellerGroup[];
  totalRowCount: number;
  totalQuantity: number;
  validQuantity: number;
  invalidRowCount: number;
  sellerCount: number;
  combinedSubtotalSen: number;
  hasIssues: boolean;
}

export interface CartLineListingSnapshot {
  id: string;
  sellerId: string;
  kind: string;
  status: string;
  hasVariants: boolean;
  priceSen: number;
  quantity: number;
  reservedQuantity: number;
}

export interface CartLineVariantSnapshot {
  id: string;
  listingId: string;
  active: boolean;
  priceSen: number;
  quantity: number;
  reservedQuantity: number;
}

export interface CartLineStateResult {
  isValid: boolean;
  issueCode: CartIssueCode | null;
  issueMessage: string | null;
  unitPriceSen: number;
  availableStock: number;
  reservedQuantity: number;
  lineSubtotalSen: number;
  canAdjustToMax: boolean;
}

function safeAvailableStock(quantity: number, reservedQuantity: number): number {
  const safeQty = Number.isFinite(quantity) ? Math.floor(quantity) : 0;
  const safeReserved = Number.isFinite(reservedQuantity)
    ? Math.max(0, Math.floor(reservedQuantity))
    : 0;
  return Math.max(0, safeQty - safeReserved);
}

/**
 * Evaluates a persisted cart_items row against live listing & variant state.
 */
export function evaluateCartLineState(input: {
  buyerUserId: string;
  cartQuantity: number;
  variantId: string | null;
  listing: CartLineListingSnapshot | null;
  variant: CartLineVariantSnapshot | null;
}): CartLineStateResult {
  const qty = Math.max(0, Math.floor(input.cartQuantity));

  if (!input.listing) {
    return {
      isValid: false,
      issueCode: "deleted",
      issueMessage: "This listing has been removed by the seller.",
      unitPriceSen: 0,
      availableStock: 0,
      reservedQuantity: 0,
      lineSubtotalSen: 0,
      canAdjustToMax: false,
    };
  }

  const { listing, variant } = input;
  const hasMatchingVariant = Boolean(
    listing.hasVariants &&
      input.variantId &&
      variant &&
      variant.id === input.variantId &&
      variant.listingId === listing.id
  );

  const unitPriceSen = hasMatchingVariant
    ? Math.max(0, Math.floor(variant!.priceSen))
    : Math.max(0, Math.floor(listing.priceSen));

  const availableStock = listing.hasVariants
    ? hasMatchingVariant && variant!.active
      ? safeAvailableStock(variant!.quantity, variant!.reservedQuantity)
      : 0
    : safeAvailableStock(listing.quantity, listing.reservedQuantity);

  const reservedQuantity = listing.hasVariants
    ? hasMatchingVariant
      ? Math.max(0, Math.floor(variant!.reservedQuantity))
      : 0
    : Math.max(0, Math.floor(listing.reservedQuantity));

  if (listing.sellerId === input.buyerUserId) {
    return {
      isValid: false,
      issueCode: "self_purchase",
      issueMessage: "You cannot purchase your own listing. Remove it from your cart.",
      unitPriceSen,
      availableStock,
      reservedQuantity,
      lineSubtotalSen: 0,
      canAdjustToMax: false,
    };
  }

  if (listing.status === "archived") {
    return {
      isValid: false,
      issueCode: "archived",
      issueMessage: "This listing has been archived and is no longer for sale.",
      unitPriceSen,
      availableStock,
      reservedQuantity,
      lineSubtotalSen: 0,
      canAdjustToMax: false,
    };
  }

  if (listing.status !== "published") {
    return {
      isValid: false,
      issueCode: "unavailable",
      issueMessage: "This listing is currently unavailable.",
      unitPriceSen,
      availableStock,
      reservedQuantity,
      lineSubtotalSen: 0,
      canAdjustToMax: false,
    };
  }

  if (!CART_ELIGIBLE_KINDS.has(listing.kind)) {
    return {
      isValid: false,
      issueCode: "non_physical",
      issueMessage: "Only physical products can be kept in the shopping cart.",
      unitPriceSen,
      availableStock,
      reservedQuantity,
      lineSubtotalSen: 0,
      canAdjustToMax: false,
    };
  }

  if (listing.hasVariants) {
    if (!hasMatchingVariant || !variant?.active) {
      return {
        isValid: false,
        issueCode: "variant_unavailable",
        issueMessage: "Selected option is no longer available.",
        unitPriceSen,
        availableStock: 0,
        reservedQuantity,
        lineSubtotalSen: 0,
        canAdjustToMax: false,
      };
    }
  } else if (input.variantId !== null) {
    return {
      isValid: false,
      issueCode: "variant_unavailable",
      issueMessage: "This listing no longer uses product options.",
      unitPriceSen,
      availableStock,
      reservedQuantity,
      lineSubtotalSen: 0,
      canAdjustToMax: false,
    };
  }

  if (availableStock <= 0) {
    return {
      isValid: false,
      issueCode: "out_of_stock",
      issueMessage: "This item is currently out of stock.",
      unitPriceSen,
      availableStock: 0,
      reservedQuantity,
      lineSubtotalSen: 0,
      canAdjustToMax: false,
    };
  }

  if (qty < 1 || qty > availableStock) {
    return {
      isValid: false,
      issueCode: "exceeds_stock",
      issueMessage: `Only ${availableStock} left in stock. Adjust quantity to continue.`,
      unitPriceSen,
      availableStock,
      reservedQuantity,
      lineSubtotalSen: 0,
      canAdjustToMax: true,
    };
  }

  return {
    isValid: true,
    issueCode: null,
    issueMessage: null,
    unitPriceSen,
    availableStock,
    reservedQuantity,
    lineSubtotalSen: unitPriceSen * qty,
    canAdjustToMax: false,
  };
}

export type CartQuantityUpdateValidation =
  | {
      ok: true;
      nextQuantity: number;
      availableStock: number;
      unitPriceSen: number;
      priceChanged: boolean;
      previousPriceSen: number | null;
    }
  | {
      ok: false;
      error: string;
    };

/**
 * Authoritative server-side check when updating an existing cart item's quantity.
 */
export function validateCartQuantityUpdate(input: {
  eligibility: BuyerEligibilityResult;
  cartItemId: string;
  rowUserId: string;
  requestedQuantity: number;
  variantId: string | null;
  listing: CartLineListingSnapshot | null;
  variant: CartLineVariantSnapshot | null;
  expectedUnitPriceSen?: number | null;
}): CartQuantityUpdateValidation {
  if (!UUID_RE.test(input.cartItemId)) {
    return { ok: false, error: "Invalid cart item identifier." };
  }

  if (!input.eligibility.eligible || !input.eligibility.userId) {
    return {
      ok: false,
      error: input.eligibility.reason || "Sign in to manage your cart.",
    };
  }

  if (input.rowUserId !== input.eligibility.userId) {
    return {
      ok: false,
      error: "You do not have permission to modify this cart item.",
    };
  }

  if (
    !Number.isInteger(input.requestedQuantity) ||
    input.requestedQuantity < 1
  ) {
    return {
      ok: false,
      error: "Quantity must be a whole number of at least 1.",
    };
  }

  const lineState = evaluateCartLineState({
    buyerUserId: input.eligibility.userId,
    cartQuantity: input.requestedQuantity,
    variantId: input.variantId,
    listing: input.listing,
    variant: input.variant,
  });

  if (!lineState.isValid) {
    if (lineState.issueCode === "exceeds_stock") {
      return {
        ok: false,
        error: `Only ${lineState.availableStock} available in stock.`,
      };
    }
    return {
      ok: false,
      error: lineState.issueMessage || "This cart item cannot be updated.",
    };
  }

  const hasExpectedPrice =
    typeof input.expectedUnitPriceSen === "number" &&
    Number.isFinite(input.expectedUnitPriceSen) &&
    input.expectedUnitPriceSen >= 0;
  const priceChanged =
    hasExpectedPrice &&
    Math.floor(input.expectedUnitPriceSen!) !== lineState.unitPriceSen;

  return {
    ok: true,
    nextQuantity: input.requestedQuantity,
    availableStock: lineState.availableStock,
    unitPriceSen: lineState.unitPriceSen,
    priceChanged,
    previousPriceSen: priceChanged
      ? Math.floor(input.expectedUnitPriceSen!)
      : null,
  };
}

/**
 * Groups cart items by seller and computes exact integer-sen subtotals and totals.
 */
export function buildCartSummary(items: CartItemView[]): CartSummary {
  const groupMap = new Map<string, CartSellerGroup>();

  for (const item of items) {
    let group = groupMap.get(item.sellerId);
    if (!group) {
      const sellerName = item.storefrontName || item.sellerDisplayName;
      const sellerSubtext =
        item.storefrontName && item.storefrontName !== item.sellerDisplayName
          ? `Managed by ${item.sellerDisplayName}`
          : null;
      group = {
        sellerId: item.sellerId,
        sellerName,
        sellerSubtext,
        sellerLogoUrl: item.sellerLogoUrl,
        sellerBadge: item.sellerBadge,
        items: [],
        validQuantity: 0,
        invalidRowCount: 0,
        subtotalSen: 0,
      };
      groupMap.set(item.sellerId, group);
    }

    group.items.push(item);
    if (item.isValid) {
      group.validQuantity += item.quantity;
      group.subtotalSen += item.lineSubtotalSen;
    } else {
      group.invalidRowCount += 1;
    }
  }

  const groups = Array.from(groupMap.values());
  let totalQuantity = 0;
  let validQuantity = 0;
  let invalidRowCount = 0;
  let combinedSubtotalSen = 0;

  for (const item of items) {
    totalQuantity += item.quantity;
    if (item.isValid) {
      validQuantity += item.quantity;
      combinedSubtotalSen += item.lineSubtotalSen;
    } else {
      invalidRowCount += 1;
    }
  }

  return {
    groups,
    totalRowCount: items.length,
    totalQuantity,
    validQuantity,
    invalidRowCount,
    sellerCount: groups.length,
    combinedSubtotalSen,
    hasIssues: invalidRowCount > 0,
  };
}
