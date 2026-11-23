import type { SellListingKind } from "./validation";

function parseRmPriceToSen(
  raw: string | number
): { ok: true; sen: number } | { ok: false; error: string } {
  const str = String(raw ?? "").trim().replace(/^RM\s*/i, "");
  if (!str) return { ok: false, error: "Enter a price in RM (e.g. 15.00)." };
  if (!/^\d+(\.\d{1,2})?$/.test(str)) {
    return {
      ok: false,
      error: "Price must be a valid non-negative RM amount with up to 2 decimals.",
    };
  }
  const [wholePart = "0", decPart = ""] = str.split(".");
  const sen =
    Number.parseInt(wholePart, 10) * 100 +
    Number.parseInt(decPart.padEnd(2, "0"), 10);
  if (!Number.isSafeInteger(sen) || sen < 0) {
    return { ok: false, error: "Price must be a valid RM amount." };
  }
  if (sen > 5_000_000) {
    return {
      ok: false,
      error: "Price cannot exceed RM 50,000.00 on the campus marketplace.",
    };
  }
  return { ok: true, sen };
}

export type EditableListingStatus = "draft" | "published" | "archived";

export interface ExistingVariantRecord {
  id: string;
  optionValues: Record<string, string>;
  priceSen: number;
  quantity: number;
  reservedQuantity: number;
  active: boolean;
}

export interface VariantDraftInput {
  id?: string;
  optionValues: Record<string, string>;
  priceRm: string;
  quantity: string | number;
  active: boolean;
}

export interface ValidatedVariantPayload {
  id?: string;
  option_values: Record<string, string>;
  price_sen: number;
  quantity: number;
  active: boolean;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value.trim());
}

/**
 * Validates allowed listing status transitions.
 * Admin-removed listings cannot be edited or re-published by the seller.
 */
export function validateStatusTransition(
  currentStatus: string,
  targetStatus: string
): { ok: true; status: EditableListingStatus } | { ok: false; error: string } {
  const cur = currentStatus.toLowerCase();
  const next = targetStatus.toLowerCase();

  if (cur === "removed" || cur === "banned") {
    return {
      ok: false,
      error:
        "This listing was removed by campus moderation and cannot be modified.",
    };
  }

  if (next !== "draft" && next !== "published" && next !== "archived") {
    return { ok: false, error: `Unsupported target status "${targetStatus}".` };
  }

  return { ok: true, status: next };
}

/**
 * Enforces non-negative stock and guarantees quantity never drops below reserved_quantity.
 */
export function validateStockUpdate(
  requestedQuantity: number,
  reservedQuantity: number,
  isService: boolean
): { ok: true; quantity: number; availableStock: number } | { ok: false; error: string } {
  if (isService) {
    return { ok: true, quantity: 1, availableStock: 1 };
  }

  if (!Number.isInteger(requestedQuantity) || requestedQuantity < 0) {
    return { ok: false, error: "Quantity must be a non-negative whole number." };
  }
  if (requestedQuantity > 999) {
    return { ok: false, error: "Quantity cannot exceed 999." };
  }
  if (requestedQuantity < reservedQuantity) {
    return {
      ok: false,
      error: `Quantity (${requestedQuantity}) cannot be reduced below currently reserved stock (${reservedQuantity}).`,
    };
  }

  return {
    ok: true,
    quantity: requestedQuantity,
    availableStock: requestedQuantity - reservedQuantity,
  };
}

/**
 * Validates product variants, prevents deleting variants with active reservations
 * or transaction references, prevents duplicate option combinations, and computes
 * aggregate inventory and minimum display price.
 */
export function validateVariantsInput(input: {
  hasVariants: boolean;
  isService: boolean;
  targetStatus: EditableListingStatus;
  optionGroups: string[];
  variants: VariantDraftInput[];
  existingVariants: ExistingVariantRecord[];
  referencedVariantIds: Set<string>;
}):
  | {
      ok: true;
      hasVariants: boolean;
      optionGroups: string[];
      variants: ValidatedVariantPayload[] | null;
      totalQuantity: number | null;
      minPriceSen: number | null;
    }
  | { ok: false; error: string } {
  if (!input.hasVariants || input.isService) {
    // If disabling variants on a listing that had existing variants, ensure none are locked
    for (const ev of input.existingVariants) {
      if (ev.reservedQuantity > 0 || input.referencedVariantIds.has(ev.id)) {
        return {
          ok: false,
          error:
            "Cannot disable variants while an existing variant has reserved stock or active order references. Deactivate unused variants instead.",
        };
      }
    }
    return {
      ok: true,
      hasVariants: false,
      optionGroups: [],
      variants: null,
      totalQuantity: null,
      minPriceSen: null,
    };
  }

  const groups = input.optionGroups
    .map((g) => g.trim())
    .filter((g) => g.length > 0);
  if (groups.length === 0 || groups.length > 2) {
    return {
      ok: false,
      error: "Define 1 or 2 option group names (e.g. Size, Color) for variants.",
    };
  }
  if (new Set(groups.map((g) => g.toLowerCase())).size !== groups.length) {
    return { ok: false, error: "Option group names must be unique." };
  }

  if (input.variants.length === 0) {
    return {
      ok: false,
      error: "Add at least one variant when product variants are enabled.",
    };
  }

  const existingMap = new Map(input.existingVariants.map((v) => [v.id, v]));
  const submittedIds = new Set(
    input.variants.map((v) => v.id).filter((id): id is string => Boolean(id))
  );

  // Prevent removing any variant referenced by active orders/offers or with reserved stock
  for (const ev of input.existingVariants) {
    if (!submittedIds.has(ev.id)) {
      if (ev.reservedQuantity > 0 || input.referencedVariantIds.has(ev.id)) {
        return {
          ok: false,
          error:
            "A variant referenced by active orders or reservations cannot be deleted. Set it to inactive instead.",
        };
      }
    }
  }

  const seenKeys = new Set<string>();
  const validated: ValidatedVariantPayload[] = [];
  let totalQuantity = 0;
  let minPriceSen: number | null = null;
  let activeCount = 0;

  for (let i = 0; i < input.variants.length; i++) {
    const v = input.variants[i];
    if (!v) continue;

    const cleanValues: Record<string, string> = {};
    for (const group of groups) {
      const val = String(v.optionValues[group] ?? "").trim();
      if (!val) {
        return {
          ok: false,
          error: `Variant #${i + 1} is missing a value for "${group}".`,
        };
      }
      cleanValues[group] = val;
    }

    const comboKey = groups
      .map((g) => `${g.toLowerCase()}=${cleanValues[g]?.toLowerCase()}`)
      .join("|");
    if (seenKeys.has(comboKey)) {
      return {
        ok: false,
        error: `Duplicate variant combination detected on Variant #${i + 1}.`,
      };
    }
    seenKeys.add(comboKey);

    const priceRes = parseRmPriceToSen(v.priceRm);
    if (!priceRes.ok) {
      return { ok: false, error: `Variant #${i + 1}: ${priceRes.error}` };
    }
    if (input.targetStatus === "published" && v.active && priceRes.sen < 100) {
      return {
        ok: false,
        error: `Variant #${i + 1}: Published variant price must be at least RM 1.00.`,
      };
    }

    const existing = v.id ? existingMap.get(v.id) : undefined;
    const reserved = existing?.reservedQuantity ?? 0;
    const parsedQty = Number.parseInt(String(v.quantity ?? "0"), 10);
    const stockRes = validateStockUpdate(parsedQty, reserved, false);
    if (!stockRes.ok) {
      return { ok: false, error: `Variant #${i + 1}: ${stockRes.error}` };
    }

    if (v.active) {
      activeCount += 1;
      totalQuantity += stockRes.quantity;
      if (minPriceSen === null || priceRes.sen < minPriceSen) {
        minPriceSen = priceRes.sen;
      }
    }

    validated.push({
      ...(v.id ? { id: v.id } : {}),
      option_values: cleanValues,
      price_sen: priceRes.sen,
      quantity: stockRes.quantity,
      active: Boolean(v.active),
    });
  }

  if (input.targetStatus === "published" && activeCount === 0) {
    return {
      ok: false,
      error: "At least one variant must be active before publishing.",
    };
  }

  return {
    ok: true,
    hasVariants: true,
    optionGroups: groups,
    variants: validated,
    totalQuantity,
    minPriceSen,
  };
}

export interface ListingEditValidationInput {
  currentStatus: string;
  currentReservedQuantity: number;
  title: string;
  description: string;
  listingType: SellListingKind;
  categoryId: string;
  priceRm: string;
  quantity: string | number;
  collectionAreaId: string;
  condition: string;
  targetStatus: EditableListingStatus;
  rulesAcknowledged: boolean;
  allowOffers: boolean;
  keptPhotoPaths: string[];
  newPhotoCount: number;
  hasVariants: boolean;
  optionGroups: string[];
  variants: VariantDraftInput[];
  existingVariants: ExistingVariantRecord[];
  referencedVariantIds: Set<string>;
}

export function validateListingEditInput(input: ListingEditValidationInput) {
  const statusCheck = validateStatusTransition(
    input.currentStatus,
    input.targetStatus
  );
  if (!statusCheck.ok) {
    return statusCheck;
  }

  if (input.keptPhotoPaths.length + input.newPhotoCount > 4) {
    return {
      ok: false as const,
      error: "A listing can have at most 4 photos in total.",
    };
  }

  const isService = input.listingType === "service";

  const variantsCheck = validateVariantsInput({
    hasVariants: input.hasVariants,
    isService,
    targetStatus: statusCheck.status,
    optionGroups: input.optionGroups,
    variants: input.variants,
    existingVariants: input.existingVariants,
    referencedVariantIds: input.referencedVariantIds,
  });
  if (!variantsCheck.ok) {
    return variantsCheck;
  }

  // When archiving, relax publish-only requirements by validating as draft shape
  const validationStatus =
    statusCheck.status === "published" ? "published" : "draft";

  const effectivePriceRm =
    variantsCheck.hasVariants && variantsCheck.minPriceSen !== null
      ? (variantsCheck.minPriceSen / 100).toFixed(2)
      : input.priceRm;

  const effectiveQuantity =
    variantsCheck.hasVariants && variantsCheck.totalQuantity !== null
      ? variantsCheck.totalQuantity
      : Number.parseInt(String(input.quantity ?? "0"), 10);

  if (!variantsCheck.hasVariants) {
    const stockCheck = validateStockUpdate(
      effectiveQuantity,
      input.currentReservedQuantity,
      isService
    );
    if (!stockCheck.ok) {
      return stockCheck;
    }
  }

  const title = input.title.trim();
  const description = input.description.trim();
  const categoryId = input.categoryId.trim();
  const collectionAreaId = input.collectionAreaId.trim();
  const condition = input.condition.trim();

  if (title.length < 3 || title.length > 120) {
    return {
      ok: false as const,
      error: "Listing title must be between 3 and 120 characters.",
    };
  }
  if (validationStatus === "published" && description.length < 10) {
    return {
      ok: false as const,
      error: "Add at least 10 characters of description before publishing.",
    };
  }
  if (description.length > 2000) {
    return { ok: false as const, error: "Description cannot exceed 2,000 characters." };
  }
  if (!categoryId) {
    return { ok: false as const, error: "Select a campus category." };
  }

  const priceRes = parseRmPriceToSen(effectivePriceRm);
  if (!priceRes.ok) {
    return { ok: false as const, error: priceRes.error };
  }
  if (validationStatus === "published" && priceRes.sen < 100) {
    return {
      ok: false as const,
      error: "Published listings must be at least RM 1.00. Use Free Items for giveaways.",
    };
  }
  if (!isService && validationStatus === "published" && !collectionAreaId) {
    return {
      ok: false as const,
      error: "Select a campus collection area before publishing.",
    };
  }
  if (!isService && validationStatus === "published" && !condition) {
    return {
      ok: false as const,
      error: "Select an item condition before publishing.",
    };
  }
  if (validationStatus === "published" && !input.rulesAcknowledged) {
    return {
      ok: false as const,
      error: "Confirm the UMS campus marketplace listing rules before publishing.",
    };
  }

  const isFood = input.listingType === "food";
  const dbKind: "preloved" | "business" | "service" =
    input.listingType === "food" ? "business" : input.listingType;

  return {
    ok: true as const,
    data: {
      title,
      description,
      dbKind,
      isFood,
      categoryId,
      priceSen: priceRes.sen,
      quantity: isService ? 1 : effectiveQuantity,
      collectionAreaId: collectionAreaId || null,
      condition: isService ? null : condition || null,
      status: statusCheck.status,
      rulesAcknowledged: Boolean(input.rulesAcknowledged),
      allowOffers: Boolean(input.allowOffers),
      hasVariants: variantsCheck.hasVariants,
      optionGroups: variantsCheck.optionGroups,
      variants: variantsCheck.variants,
    },
  };
}

/**
 * Maps PostgreSQL RPC errors (including optimistic concurrency conflicts) to safe user messages.
 */
export function mapAtomicUpdateError(rawMessage: string): string {
  const lower = rawMessage.toLowerCase();
  if (
    lower.includes("conflict") ||
    lower.includes("stale") ||
    lower.includes("updated_at") ||
    lower.includes("concurrent") ||
    lower.includes("modified")
  ) {
    return "This listing was modified in another tab or by a recent order. Reload the page to get the latest stock and details before saving.";
  }
  if (lower.includes("reserved")) {
    return "Stock cannot be reduced below currently reserved units.";
  }
  if (lower.includes("permission") || lower.includes("not owner") || lower.includes("unauthorized")) {
    return "You do not have permission to edit this listing.";
  }
  return `Unable to update listing: ${rawMessage}`;
}
