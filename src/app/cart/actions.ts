"use server";

import { revalidatePath } from "next/cache";
import {
  validateCartQuantityUpdate,
  type CartLineListingSnapshot,
  type CartLineVariantSnapshot,
} from "@/lib/buyer/cart";
import {
  evaluateBuyerEligibility,
  isValidUuid,
} from "@/lib/buyer/validation";
import { formatSenToRm } from "@/lib/format";
import {
  createSupabaseServerClient,
  getSessionSummary,
} from "@/lib/supabase/server";

export interface CartMutationResult {
  ok: boolean;
  message?: string;
  error?: string;
  nextQuantity?: number;
  unitPriceSen?: number;
  priceChanged?: boolean;
  previousPriceSen?: number | null;
}

export async function updateCartItemQuantityAction(input: {
  cartItemId: string;
  quantity: number;
  expectedUnitPriceSen?: number | null;
}): Promise<CartMutationResult> {
  const session = await getSessionSummary();
  const eligibility = evaluateBuyerEligibility(session);

  if (!isValidUuid(input.cartItemId)) {
    return { ok: false, error: "Invalid cart item identifier." };
  }

  if (!eligibility.eligible || !eligibility.userId) {
    return {
      ok: false,
      error: eligibility.reason || "Sign in with your UMS account to update your cart.",
    };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, error: "Service unavailable. Please try again." };
  }

  const userId = eligibility.userId;

  const { data: rawCartRow, error: cartErr } = await supabase
    .from("cart_items")
    .select("id,user_id,listing_id,variant_id,quantity")
    .eq("id", input.cartItemId)
    .eq("user_id", userId)
    .maybeSingle();

  if (cartErr) {
    return { ok: false, error: "Could not load this cart item. Please retry." };
  }

  if (!rawCartRow) {
    revalidatePath("/cart");
    revalidatePath("/");
    return { ok: false, error: "This item is no longer in your cart." };
  }

  const cartRow = rawCartRow as {
    id: string;
    user_id: string;
    listing_id: string;
    variant_id: string | null;
    quantity: number;
  };

  const [listingRes, variantRes] = await Promise.all([
    supabase
      .from("listings")
      .select(
        "id,seller_id,kind,status,has_variants,price_sen,quantity,reserved_quantity,accepting_requests"
      )
      .eq("id", cartRow.listing_id)
      .maybeSingle(),
    cartRow.variant_id
      ? supabase
          .from("listing_variants")
          .select("id,listing_id,active,price_sen,quantity,reserved_quantity")
          .eq("id", cartRow.variant_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (listingRes.error) {
    return {
      ok: false,
      error: "Could not verify current stock availability. Please retry.",
    };
  }

  const rawListing = listingRes.data as {
    id: string;
    seller_id: string;
    kind: string;
    status: string;
    has_variants: boolean | null;
    price_sen: number | null;
    quantity: number | null;
    reserved_quantity: number | null;
    accepting_requests: boolean | null;
  } | null;

  const rawVariant = variantRes.data as {
    id: string;
    listing_id: string;
    active: boolean;
    price_sen: number;
    quantity: number;
    reserved_quantity: number;
  } | null;

  const listingSnapshot: CartLineListingSnapshot | null = rawListing
    ? {
        id: rawListing.id,
        sellerId: rawListing.seller_id,
        kind: rawListing.kind,
        status: rawListing.status,
        hasVariants: Boolean(rawListing.has_variants),
        priceSen: Number(rawListing.price_sen ?? 0),
        quantity: Number(rawListing.quantity ?? 0),
        reservedQuantity: Number(rawListing.reserved_quantity ?? 0),
        acceptingRequests: rawListing.accepting_requests,
      }
    : null;

  const variantSnapshot: CartLineVariantSnapshot | null = rawVariant
    ? {
        id: rawVariant.id,
        listingId: rawVariant.listing_id,
        active: Boolean(rawVariant.active),
        priceSen: Number(rawVariant.price_sen ?? 0),
        quantity: Number(rawVariant.quantity ?? 0),
        reservedQuantity: Number(rawVariant.reserved_quantity ?? 0),
      }
    : null;

  const check = validateCartQuantityUpdate({
    eligibility,
    cartItemId: cartRow.id,
    rowUserId: cartRow.user_id,
    requestedQuantity: input.quantity,
    variantId: cartRow.variant_id,
    listing: listingSnapshot,
    variant: variantSnapshot,
    expectedUnitPriceSen: input.expectedUnitPriceSen,
  });

  if (!check.ok) {
    revalidatePath("/cart");
    return { ok: false, error: check.error };
  }

  const { error: updateErr } = await supabase
    .from("cart_items")
    .update({
      quantity: check.nextQuantity,
      updated_at: new Date().toISOString(),
    })
    .eq("id", cartRow.id)
    .eq("user_id", userId);

  if (updateErr) {
    return {
      ok: false,
      error: "Could not save quantity change. Please try again.",
    };
  }

  revalidatePath("/");
  revalidatePath("/cart");
  revalidatePath("/marketplace");
  revalidatePath(`/listings/${cartRow.listing_id}`);

  const message =
    check.priceChanged && check.previousPriceSen !== null
      ? `Quantity updated to ${check.nextQuantity}. Price changed from ${formatSenToRm(check.previousPriceSen)} to ${formatSenToRm(check.unitPriceSen)}.`
      : `Quantity updated to ${check.nextQuantity}.`;

  return {
    ok: true,
    message,
    nextQuantity: check.nextQuantity,
    unitPriceSen: check.unitPriceSen,
    priceChanged: check.priceChanged,
    previousPriceSen: check.previousPriceSen,
  };
}

export async function removeCartItemAction(
  cartItemId: string
): Promise<CartMutationResult> {
  const session = await getSessionSummary();
  const eligibility = evaluateBuyerEligibility(session);

  if (!isValidUuid(cartItemId)) {
    return { ok: false, error: "Invalid cart item identifier." };
  }

  if (!eligibility.eligible || !eligibility.userId) {
    return {
      ok: false,
      error: eligibility.reason || "Sign in with your UMS account to manage your cart.",
    };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, error: "Service unavailable. Please try again." };
  }

  const userId = eligibility.userId;

  const { data: deletedRows, error: deleteErr } = await supabase
    .from("cart_items")
    .delete()
    .eq("id", cartItemId)
    .eq("user_id", userId)
    .select("listing_id");

  if (deleteErr) {
    return {
      ok: false,
      error: "Could not remove this item from your cart. Please retry.",
    };
  }

  const removedListingId = (
    deletedRows as Array<{ listing_id: string }> | null
  )?.[0]?.listing_id;

  revalidatePath("/");
  revalidatePath("/cart");
  revalidatePath("/marketplace");
  if (removedListingId) {
    revalidatePath(`/listings/${removedListingId}`);
  }

  return {
    ok: true,
    message: "Item removed from your cart.",
  };
}
