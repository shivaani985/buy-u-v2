import type { AuthSessionSummary } from "@/types/marketplace";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: string | null | undefined): boolean {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

export type BuyerBlockCode =
  | "unauthenticated"
  | "unverified"
  | "restricted";

export interface BuyerEligibilityResult {
  eligible: boolean;
  userId: string | null;
  code?: BuyerBlockCode;
  reason?: string;
}

/**
 * Active, email-verified UMS Students, Staff, and Admins can favourite items
 * and add eligible physical products to cart.
 */
export function evaluateBuyerEligibility(
  session: Pick<
    AuthSessionSummary,
    "isAuthenticated" | "isEmailVerified" | "isActiveMember" | "profile"
  >
): BuyerEligibilityResult {
  const userId = session.profile?.id ?? null;

  if (!session.isAuthenticated || !userId) {
    return {
      eligible: false,
      userId: null,
      code: "unauthenticated",
      reason: "Sign in with your UMS account to save items or add to cart.",
    };
  }

  if (!session.isEmailVerified) {
    return {
      eligible: false,
      userId,
      code: "unverified",
      reason: "Verify your UMS email address before shopping on Buy-U.",
    };
  }

  if (!session.isActiveMember || session.profile?.status !== "active") {
    return {
      eligible: false,
      userId,
      code: "restricted",
      reason:
        session.profile?.restriction_reason?.trim() ||
        "Your account is currently restricted from shopping.",
    };
  }

  const role = (session.profile?.university_role ?? "").toLowerCase();
  if (role !== "student" && role !== "staff") {
    return {
      eligible: false,
      userId,
      code: "restricted",
      reason: "Only active UMS Students and Staff can shop on Buy-U.",
    };
  }

  return {
    eligible: true,
    userId,
  };
}

export function computeAvailableStock(
  quantity: number,
  reservedQuantity: number
): number {
  const safeQty = Number.isFinite(quantity) ? Math.floor(quantity) : 0;
  const safeReserved = Number.isFinite(reservedQuantity)
    ? Math.max(0, Math.floor(reservedQuantity))
    : 0;
  return Math.max(0, safeQty - safeReserved);
}

export interface FavouriteToggleInput {
  eligibility: BuyerEligibilityResult;
  listingId: string;
  isDemo?: boolean;
  isFreeNotice?: boolean;
  status: string;
  currentlyFavourited: boolean;
}

export interface FavouriteToggleValidation {
  ok: boolean;
  error?: string;
}

export function validateFavouriteToggle(
  input: FavouriteToggleInput
): FavouriteToggleValidation {
  if (input.isDemo) {
    return {
      ok: false,
      error: "Demo listings cannot be saved to Favourites.",
    };
  }

  if (input.isFreeNotice) {
    return {
      ok: false,
      error: "Free campus notices cannot be saved to Favourites.",
    };
  }

  if (!isValidUuid(input.listingId)) {
    return {
      ok: false,
      error: "Invalid listing identifier.",
    };
  }

  if (!input.eligibility.eligible || !input.eligibility.userId) {
    return {
      ok: false,
      error: input.eligibility.reason || "Sign in to manage Favourites.",
    };
  }

  // Always allow removing an existing favourite even if the listing was later archived.
  if (!input.currentlyFavourited && input.status !== "published") {
    return {
      ok: false,
      error: "This listing is no longer available to save.",
    };
  }

  return { ok: true };
}

export interface CartVariantSnapshot {
  id: string;
  listingId: string;
  active: boolean;
  quantity: number;
  reservedQuantity: number;
  priceSen: number;
}

export interface AddToCartInput {
  eligibility: BuyerEligibilityResult;
  listingId: string;
  sellerId: string;
  kind: string;
  status: string;
  hasVariants: boolean;
  listingQuantity: number;
  listingReservedQuantity: number;
  variantId: string | null;
  selectedVariant: CartVariantSnapshot | null;
  requestedQuantity: number;
  existingCartQuantity: number;
  acceptingRequests?: boolean | null;
  isDemo?: boolean;
}

export type AddToCartValidationResult =
  | {
      ok: true;
      normalizedVariantId: string | null;
      nextQuantity: number;
      addedQuantity: number;
      availableStock: number;
      merged: boolean;
    }
  | {
      ok: false;
      error: string;
    };

const CART_ELIGIBLE_KINDS = new Set(["pre_loved", "business", "service"]);

export function validateAddToCartRequest(
  input: AddToCartInput
): AddToCartValidationResult {
  if (input.isDemo) {
    return {
      ok: false,
      error: "Demo listings cannot be added to your cart.",
    };
  }

  if (!isValidUuid(input.listingId)) {
    return {
      ok: false,
      error: "Invalid listing identifier.",
    };
  }

  if (!input.eligibility.eligible || !input.eligibility.userId) {
    return {
      ok: false,
      error: input.eligibility.reason || "Sign in to add items to your cart.",
    };
  }

  if (input.eligibility.userId === input.sellerId) {
    return {
      ok: false,
      error: "You cannot add your own listing to the cart.",
    };
  }

  if (input.status !== "published") {
    return {
      ok: false,
      error: "This listing is currently unavailable.",
    };
  }

  if (!CART_ELIGIBLE_KINDS.has(input.kind)) {
    return {
      ok: false,
      error: "This listing cannot be added to the shopping cart.",
    };
  }

  if (input.kind === "service" && input.acceptingRequests === false) {
    return {
      ok: false,
      error: "This service is currently paused and cannot be purchased.",
    };
  }

  if (
    !Number.isInteger(input.requestedQuantity) ||
    input.requestedQuantity < 1
  ) {
    return {
      ok: false,
      error: "Choose a valid quantity of at least 1.",
    };
  }

  if (input.kind === "service") {
    const existing = Math.max(0, Math.floor(input.existingCartQuantity));
    const nextQuantity = existing + input.requestedQuantity;
    if (nextQuantity > 99) {
      return {
        ok: false,
        error: "You can add up to 99 units of a service per order.",
      };
    }
    return {
      ok: true,
      normalizedVariantId: null,
      nextQuantity,
      addedQuantity: input.requestedQuantity,
      availableStock: 99,
      merged: existing > 0,
    };
  }

  let availableStock = 0;
  let normalizedVariantId: string | null = null;

  if (input.hasVariants) {
    if (!input.variantId || !isValidUuid(input.variantId)) {
      return {
        ok: false,
        error: "Select a valid product option before adding to cart.",
      };
    }

    if (
      !input.selectedVariant ||
      input.selectedVariant.id !== input.variantId ||
      input.selectedVariant.listingId !== input.listingId
    ) {
      return {
        ok: false,
        error: "Selected option is invalid for this listing.",
      };
    }

    if (!input.selectedVariant.active) {
      return {
        ok: false,
        error: "Selected option is no longer available.",
      };
    }

    normalizedVariantId = input.selectedVariant.id;
    availableStock = computeAvailableStock(
      input.selectedVariant.quantity,
      input.selectedVariant.reservedQuantity
    );
  } else {
    if (input.variantId !== null && input.variantId !== "") {
      return {
        ok: false,
        error: "This listing does not support product options.",
      };
    }

    availableStock = computeAvailableStock(
      input.listingQuantity,
      input.listingReservedQuantity
    );
  }

  if (availableStock <= 0) {
    return {
      ok: false,
      error: "This item is currently out of stock.",
    };
  }

  const safeExisting = Number.isFinite(input.existingCartQuantity)
    ? Math.max(0, Math.floor(input.existingCartQuantity))
    : 0;
  const nextQuantity = safeExisting + input.requestedQuantity;

  if (nextQuantity > availableStock) {
    const remaining = Math.max(0, availableStock - safeExisting);
    if (remaining === 0) {
      return {
        ok: false,
        error: `You already have all available stock (${availableStock}) in your cart.`,
      };
    }
    return {
      ok: false,
      error: `Only ${remaining} more available (${safeExisting} already in your cart).`,
    };
  }

  return {
    ok: true,
    normalizedVariantId,
    nextQuantity,
    addedQuantity: input.requestedQuantity,
    availableStock,
    merged: safeExisting > 0,
  };
}
