import type { CartItemView, CartSellerGroup, CartSummary } from "./cart";

export function filterCartSummaryByIds(
  summary: CartSummary,
  selectedCartItemIds: string[] | null | undefined
): CartSummary {
  if (!selectedCartItemIds || selectedCartItemIds.length === 0) {
    return summary;
  }
  const allow = new Set(selectedCartItemIds);
  const groups: CartSellerGroup[] = [];
  let totalRowCount = 0;
  let invalidRowCount = 0;
  let totalQuantity = 0;
  let validQuantity = 0;
  let combinedSubtotalSen = 0;

  for (const g of summary.groups) {
    const items = g.items.filter((it) => allow.has(it.id));
    if (items.length === 0) continue;
    let groupValidQty = 0;
    let groupInvalid = 0;
    let groupSubtotal = 0;
    for (const it of items) {
      totalRowCount += 1;
      totalQuantity += it.quantity;
      if (it.isValid) {
        validQuantity += it.quantity;
        groupValidQty += it.quantity;
        groupSubtotal += it.lineSubtotalSen;
      } else {
        invalidRowCount += 1;
        groupInvalid += 1;
      }
    }
    combinedSubtotalSen += groupSubtotal;
    groups.push({
      ...g,
      items,
      validQuantity: groupValidQty,
      invalidRowCount: groupInvalid,
      subtotalSen: groupSubtotal,
    });
  }

  return {
    groups,
    sellerCount: groups.length,
    totalRowCount,
    invalidRowCount,
    totalQuantity,
    validQuantity,
    combinedSubtotalSen,
    hasIssues: invalidRowCount > 0,
  };
}

export interface CheckoutLineItem {
  cartItem: CartItemView;
  priceChanged: boolean;
  previousPriceSen: number | null;
  checkoutBlockedReason: string | null;
  isCheckoutEligible: boolean;
  lineSubtotalSen: number;
}

export interface CheckoutSellerOrder {
  orderIndex: number;
  sellerId: string;
  sellerName: string;
  sellerSubtext: string | null;
  sellerLogoUrl: string | null;
  sellerBadge: string;
  collectionAreas: string[];
  hasFoodItems: boolean;
  hasPreorderItems: boolean;
  items: CheckoutLineItem[];
  validQuantity: number;
  invalidRowCount: number;
  subtotalSen: number;
  readyForPayment: boolean;
}

export interface CheckoutPreparationSummary {
  sellerOrders: CheckoutSellerOrder[];
  sellerOrderCount: number;
  totalRowCount: number;
  validQuantity: number;
  invalidRowCount: number;
  priceChangedCount: number;
  itemsSubtotalSen: number;
  /** Gateway fee is explicitly pending until ToyyibPay integration; never invented. */
  gatewayFeeStatus: "pending";
  canProceedToPayment: boolean;
  blockingReasons: string[];
}

/**
 * Prepares separate per-seller order breakdowns from the live validated cart.
 * Does NOT create orders, reservations, or payment records.
 */
export function buildCheckoutPreparation(
  cartSummary: CartSummary,
  priceSnapshots?: Record<string, number>
): CheckoutPreparationSummary {
  const sellerOrders: CheckoutSellerOrder[] = [];
  let validQuantity = 0;
  let invalidRowCount = 0;
  let priceChangedCount = 0;
  let itemsSubtotalSen = 0;
  let hasPreorderBlock = false;
  let hasCartIssue = false;

  cartSummary.groups.forEach((group, idx) => {
    const areasSet = new Set<string>();
    let hasFoodItems = false;
    let hasPreorderItems = false;
    let groupValidQty = 0;
    let groupInvalidRows = 0;
    let groupSubtotalSen = 0;
    let groupHasPriceChange = false;

    const items: CheckoutLineItem[] = group.items.map((item) => {
      if (item.campusArea) {
        areasSet.add(item.campusArea);
      }

      const isFood = Boolean(item.isFood);
      const isPreorder = isFood && item.availabilityMode === "pre_order";
      if (isFood) hasFoodItems = true;
      if (isPreorder) hasPreorderItems = true;

      const snapshotPrice =
        priceSnapshots && Object.prototype.hasOwnProperty.call(priceSnapshots, item.id)
          ? priceSnapshots[item.id]
          : undefined;
      const priceChanged =
        typeof snapshotPrice === "number" &&
        Number.isFinite(snapshotPrice) &&
        Math.floor(snapshotPrice) !== item.unitPriceSen;
      const previousPriceSen = priceChanged ? Math.floor(snapshotPrice!) : null;

      if (priceChanged) {
        priceChangedCount += 1;
        groupHasPriceChange = true;
      }

      let checkoutBlockedReason: string | null = null;
      if (!item.isValid) {
        checkoutBlockedReason =
          item.issueMessage || "This item cannot proceed to checkout.";
        hasCartIssue = true;
      } else if (isPreorder) {
        checkoutBlockedReason =
          "Food pre-orders are not yet open for checkout. Remove this item from your cart to continue.";
        hasPreorderBlock = true;
      }

      const isCheckoutEligible = checkoutBlockedReason === null;
      const lineSubtotalSen = isCheckoutEligible
        ? item.unitPriceSen * item.quantity
        : 0;

      if (isCheckoutEligible) {
        groupValidQty += item.quantity;
        groupSubtotalSen += lineSubtotalSen;
      } else {
        groupInvalidRows += 1;
      }

      return {
        cartItem: item,
        priceChanged,
        previousPriceSen,
        checkoutBlockedReason,
        isCheckoutEligible,
        lineSubtotalSen,
      };
    });

    validQuantity += groupValidQty;
    invalidRowCount += groupInvalidRows;
    itemsSubtotalSen += groupSubtotalSen;

    sellerOrders.push({
      orderIndex: idx + 1,
      sellerId: group.sellerId,
      sellerName: group.sellerName,
      sellerSubtext: group.sellerSubtext,
      sellerLogoUrl: group.sellerLogoUrl,
      sellerBadge: group.sellerBadge,
      collectionAreas: Array.from(areasSet),
      hasFoodItems,
      hasPreorderItems,
      items,
      validQuantity: groupValidQty,
      invalidRowCount: groupInvalidRows,
      subtotalSen: groupSubtotalSen,
      readyForPayment:
        groupInvalidRows === 0 && groupValidQty > 0 && !groupHasPriceChange,
    });
  });

  const blockingReasons: string[] = [];
  if (cartSummary.totalRowCount === 0) {
    blockingReasons.push("Your shopping cart is empty.");
  }
  if (hasCartIssue) {
    blockingReasons.push(
      "One or more items are unavailable or exceed remaining stock. Return to your cart to adjust or remove them."
    );
  }
  if (hasPreorderBlock) {
    blockingReasons.push(
      "Food pre-orders are not yet enabled for checkout. Remove pre-order items in your cart to continue."
    );
  }
  if (priceChangedCount > 0) {
    blockingReasons.push(
      `${priceChangedCount} ${priceChangedCount === 1 ? "item price" : "item prices"} updated since you opened checkout. Review the latest prices before continuing.`
    );
  }

  const canProceedToPayment =
    cartSummary.totalRowCount > 0 &&
    invalidRowCount === 0 &&
    priceChangedCount === 0 &&
    validQuantity > 0;

  return {
    sellerOrders,
    sellerOrderCount: sellerOrders.length,
    totalRowCount: cartSummary.totalRowCount,
    validQuantity,
    invalidRowCount,
    priceChangedCount,
    itemsSubtotalSen,
    gatewayFeeStatus: "pending",
    canProceedToPayment,
    blockingReasons,
  };
}

/**
 * Extracts a map of cartItemId -> live unitPriceSen for subsequent price-change detection.
 */
export function extractPriceSnapshots(
  preparation: CheckoutPreparationSummary
): Record<string, number> {
  const snapshots: Record<string, number> = {};
  for (const order of preparation.sellerOrders) {
    for (const line of order.items) {
      snapshots[line.cartItem.id] = line.cartItem.unitPriceSen;
    }
  }
  return snapshots;
}
