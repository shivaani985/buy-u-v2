"use server";

import { revalidatePath } from "next/cache";
import {
  evaluateBuyerEligibility,
  isValidUuid,
  validateAddToCartRequest,
  validateFavouriteToggle,
  type CartVariantSnapshot,
} from "@/lib/buyer/validation";
import {
  createSupabaseServerClient,
  getSessionSummary,
} from "@/lib/supabase/server";

export interface FavouriteActionResult {
  ok: boolean;
  isFavourited?: boolean;
  message?: string;
  error?: string;
}

export interface AddToCartActionState {
  status: "idle" | "success" | "error";
  message?: string;
  variantKey?: string;
  nextQuantity?: number;
}

export async function toggleFavouriteAction(
  listingId: string
): Promise<FavouriteActionResult> {
  const session = await getSessionSummary();
  const eligibility = evaluateBuyerEligibility(session);

  if (!isValidUuid(listingId)) {
    return { ok: false, error: "Invalid listing identifier." };
  }

  if (!eligibility.eligible || !eligibility.userId) {
    return {
      ok: false,
      error: eligibility.reason || "Sign in with your UMS account to save items.",
    };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, error: "Service unavailable. Please try again." };
  }

  const userId = eligibility.userId;

  const [existingFavRes, listingRes] = await Promise.all([
    supabase
      .from("favourites")
      .select("listing_id")
      .eq("user_id", userId)
      .eq("listing_id", listingId)
      .maybeSingle(),
    supabase
      .from("listings")
      .select("id,status")
      .eq("id", listingId)
      .maybeSingle(),
  ]);

  if (existingFavRes.error) {
    return { ok: false, error: "Could not check your saved items right now." };
  }

  const currentlyFavourited = Boolean(existingFavRes.data);
  const listingStatus =
    (listingRes.data as { status?: string } | null)?.status ?? "unavailable";

  const check = validateFavouriteToggle({
    eligibility,
    listingId,
    status: listingStatus,
    currentlyFavourited,
  });

  if (!check.ok) {
    return { ok: false, error: check.error };
  }

  if (currentlyFavourited) {
    const { error: deleteErr } = await supabase
      .from("favourites")
      .delete()
      .eq("user_id", userId)
      .eq("listing_id", listingId);

    if (deleteErr) {
      return {
        ok: false,
        error: "Could not remove this item from Favourites.",
      };
    }

    revalidatePath(`/listings/${listingId}`);
    revalidatePath("/marketplace");
    return {
      ok: true,
      isFavourited: false,
      message: "Removed from Favourites.",
    };
  }

  const { error: insertErr } = await supabase.from("favourites").insert({
    user_id: userId,
    listing_id: listingId,
  });

  if (insertErr) {
    // Handle idempotent race (already inserted by another tab)
    if (insertErr.code === "23505") {
      revalidatePath(`/listings/${listingId}`);
      return {
        ok: true,
        isFavourited: true,
        message: "Saved to Favourites.",
      };
    }
    return {
      ok: false,
      error: "Could not save this item to Favourites.",
    };
  }

  revalidatePath(`/listings/${listingId}`);
  revalidatePath("/marketplace");
  return {
    ok: true,
    isFavourited: true,
    message: "Saved to Favourites.",
  };
}

export async function addToCartAction(
  _prevState: AddToCartActionState,
  formData: FormData
): Promise<AddToCartActionState> {
  const session = await getSessionSummary();
  const eligibility = evaluateBuyerEligibility(session);

  const listingId = String(formData.get("listingId") ?? "").trim();
  const rawVariantId = String(formData.get("variantId") ?? "").trim();
  const variantId = rawVariantId.length > 0 ? rawVariantId : null;
  const rawQty = String(formData.get("quantity") ?? "").trim();
  const requestedQuantity = Number(rawQty);

  if (!isValidUuid(listingId)) {
    return { status: "error", message: "Invalid listing identifier." };
  }

  if (!eligibility.eligible || !eligibility.userId) {
    return {
      status: "error",
      message:
        eligibility.reason || "Sign in with your UMS account to add to cart.",
    };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { status: "error", message: "Service unavailable. Please try again." };
  }

  const userId = eligibility.userId;

  const { data: rawListing, error: listingErr } = await supabase
    .from("listings")
    .select("id,seller_id,kind,status,has_variants,quantity,reserved_quantity,accepting_requests")
    .eq("id", listingId)
    .maybeSingle();

  if (listingErr || !rawListing) {
    return {
      status: "error",
      message: "This listing is unavailable or could not be found.",
    };
  }

  const listing = rawListing as {
    id: string;
    seller_id: string;
    kind: string;
    status: string;
    has_variants: boolean | null;
    quantity: number | null;
    reserved_quantity: number | null;
    accepting_requests: boolean | null;
  };

  let selectedVariant: CartVariantSnapshot | null = null;
  if (listing.has_variants && variantId && isValidUuid(variantId)) {
    const { data: vRow, error: vErr } = await supabase
      .from("listing_variants")
      .select("id,listing_id,active,quantity,reserved_quantity,price_sen")
      .eq("id", variantId)
      .eq("listing_id", listing.id)
      .maybeSingle();

    if (!vErr && vRow) {
      const v = vRow as {
        id: string;
        listing_id: string;
        active: boolean;
        quantity: number;
        reserved_quantity: number;
        price_sen: number;
      };
      selectedVariant = {
        id: v.id,
        listingId: v.listing_id,
        active: Boolean(v.active),
        quantity: Number(v.quantity ?? 0),
        reservedQuantity: Number(v.reserved_quantity ?? 0),
        priceSen: Number(v.price_sen ?? 0),
      };
    }
  }

  // Look up existing cart line for duplicate-item merging.
  const existingCartQuery = supabase
    .from("cart_items")
    .select("id,quantity")
    .eq("user_id", userId)
    .eq("listing_id", listing.id);

  const { data: existingCartRows, error: cartFetchErr } =
    listing.has_variants && variantId
      ? await existingCartQuery.eq("variant_id", variantId)
      : await existingCartQuery.is("variant_id", null);

  if (cartFetchErr) {
    return {
      status: "error",
      message: "Could not read your cart right now. Please try again.",
    };
  }

  const existingRow = (existingCartRows ?? [])[0] as
    | { id: string; quantity: number }
    | undefined;
  const existingCartQuantity = existingRow ? Number(existingRow.quantity ?? 0) : 0;

  const validation = validateAddToCartRequest({
    eligibility,
    listingId: listing.id,
    sellerId: listing.seller_id,
    kind: listing.kind,
    status: listing.status,
    hasVariants: Boolean(listing.has_variants),
    listingQuantity: Number(listing.quantity ?? 0),
    listingReservedQuantity: Number(listing.reserved_quantity ?? 0),
    variantId,
    selectedVariant,
    requestedQuantity,
    existingCartQuantity,
    acceptingRequests: listing.accepting_requests,
  });

  if (!validation.ok) {
    return { status: "error", message: validation.error };
  }

  if (existingRow) {
    const { error: updateErr } = await supabase
      .from("cart_items")
      .update({
        quantity: validation.nextQuantity,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existingRow.id)
      .eq("user_id", userId);

    if (updateErr) {
      return {
        status: "error",
        message: "Could not update cart quantity. Please try again.",
      };
    }
  } else {
    const { error: insertErr } = await supabase.from("cart_items").insert({
      user_id: userId,
      listing_id: listing.id,
      variant_id: validation.normalizedVariantId,
      quantity: validation.nextQuantity,
    });

    if (insertErr) {
      return {
        status: "error",
        message: "Could not add item to cart. Please try again.",
      };
    }
  }

  revalidatePath("/");
  revalidatePath("/cart");
  revalidatePath("/marketplace");
  revalidatePath(`/listings/${listing.id}`);

  const variantKey = validation.normalizedVariantId ?? "default";
  return {
    status: "success",
    variantKey,
    nextQuantity: validation.nextQuantity,
    message: validation.merged
      ? `Updated cart (${validation.nextQuantity} in cart).`
      : `Added ${validation.addedQuantity} to your cart.`,
  };
}
