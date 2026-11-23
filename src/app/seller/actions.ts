"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupabaseServerClient, getSessionSummary } from "@/lib/supabase/server";
import {
  isValidUuid,
  mapAtomicUpdateError,
  validateListingEditInput,
  type EditableListingStatus,
  type ExistingVariantRecord,
  type VariantDraftInput,
} from "@/lib/seller/listing-edit";
import {
  evaluateSellerEligibility,
  validateImageFileMeta,
  validateListingInput,
  validateStorefrontInput,
  type SellListingKind,
  type SellListingStatus,
} from "@/lib/seller/validation";

export interface SellerActionState {
  status: "idle" | "success" | "error";
  message?: string;
  createdId?: string;
}

async function requireEligibleStudent() {
  const session = await getSessionSummary();
  const eligibility = evaluateSellerEligibility(session);
  const userId = session.profile?.id;
  if (!eligibility.eligible || !userId) {
    return {
      ok: false as const,
      error: eligibility.eligible ? "Unauthorized" : eligibility.message,
    };
  }
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false as const, error: "Supabase connection is unavailable." };
  }
  return { ok: true as const, session, supabase, userId };
}

/**
 * Ensures an eligible student has exactly ONE storefront row (idempotent; never creates duplicates).
 */
async function ensureStorefrontInitialized(
  supabase: NonNullable<Awaited<ReturnType<typeof createSupabaseServerClient>>>,
  userId: string,
  fallbackShopName: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: existing, error: fetchErr } = await supabase
    .from("storefronts")
    .select("seller_id")
    .eq("seller_id", userId)
    .maybeSingle();

  if (fetchErr) {
    return { ok: false, error: `Unable to check storefront: ${fetchErr.message}` };
  }
  if (existing) {
    return { ok: true };
  }

  const { error: insertErr } = await supabase.from("storefronts").upsert(
    {
      seller_id: userId,
      shop_name: fallbackShopName.slice(0, 60) || "Campus Storefront",
      description: "",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "seller_id", ignoreDuplicates: true }
  );

  if (insertErr) {
    return {
      ok: false,
      error: `Unable to initialize storefront: ${insertErr.message}`,
    };
  }
  return { ok: true };
}

export async function initializeStorefrontAction(): Promise<void> {
  const auth = await requireEligibleStudent();
  if (!auth.ok) {
    redirect("/seller");
  }

  const defaultName =
    auth.session.profile?.display_name ||
    auth.session.profile?.full_name ||
    auth.session.email?.split("@")[0] ||
    "Campus Storefront";

  await ensureStorefrontInitialized(auth.supabase, auth.userId, defaultName);
  revalidatePath("/seller");
  revalidatePath("/seller/storefront");
  redirect("/seller/storefront?initialized=1");
}

export async function saveStorefrontAction(
  _prevState: SellerActionState,
  formData: FormData
): Promise<SellerActionState> {
  const auth = await requireEligibleStudent();
  if (!auth.ok) {
    return { status: "error", message: auth.error };
  }

  const validated = validateStorefrontInput({
    shopName: String(formData.get("shopName") ?? ""),
    description: String(formData.get("description") ?? ""),
  });

  if (!validated.ok) {
    return { status: "error", message: validated.error };
  }

  const removeLogo = formData.get("removeLogo") === "on";
  const logoFile = formData.get("logo");
  let nextLogoPath: string | null | undefined = undefined;

  if (removeLogo) {
    nextLogoPath = null;
  } else if (logoFile instanceof File && logoFile.size > 0) {
    const fileCheck = validateImageFileMeta({
      name: logoFile.name,
      type: logoFile.type,
      size: logoFile.size,
    });
    if (!fileCheck.ok) {
      return { status: "error", message: fileCheck.error };
    }

    const storagePath = `storefronts/${auth.userId}/logo-${Date.now()}.${fileCheck.ext}`;
    const bytes = new Uint8Array(await logoFile.arrayBuffer());
    const { error: uploadErr } = await auth.supabase.storage
      .from("listings")
      .upload(storagePath, bytes, {
        contentType: logoFile.type,
        upsert: true,
      });

    if (uploadErr) {
      return {
        status: "error",
        message: `Logo upload failed: ${uploadErr.message}`,
      };
    }
    nextLogoPath = storagePath;
  }

  const payload: {
    seller_id: string;
    shop_name: string;
    description: string;
    updated_at: string;
    logo_path?: string | null;
  } = {
    seller_id: auth.userId,
    shop_name: validated.shopName,
    description: validated.description,
    updated_at: new Date().toISOString(),
  };

  if (nextLogoPath !== undefined) {
    payload.logo_path = nextLogoPath;
  }

  const { error } = await auth.supabase
    .from("storefronts")
    .upsert(payload, { onConflict: "seller_id" });

  if (error) {
    return {
      status: "error",
      message: `Unable to save storefront: ${error.message}`,
    };
  }

  revalidatePath("/seller");
  revalidatePath("/seller/storefront");
  return {
    status: "success",
    message: "Storefront details saved.",
  };
}

export async function createListingAction(
  _prevState: SellerActionState,
  formData: FormData
): Promise<SellerActionState> {
  const auth = await requireEligibleStudent();
  if (!auth.ok) {
    return { status: "error", message: auth.error };
  }

  const intent = String(formData.get("intent") ?? "draft") as SellListingStatus;
  const listingType = String(
    formData.get("listingType") ?? "preloved"
  ) as SellListingKind;

  const validated = validateListingInput({
    title: String(formData.get("title") ?? ""),
    description: String(formData.get("description") ?? ""),
    listingType,
    categoryId: String(formData.get("categoryId") ?? ""),
    priceRm: String(formData.get("priceRm") ?? ""),
    quantity: String(formData.get("quantity") ?? "1"),
    collectionAreaId: String(formData.get("collectionAreaId") ?? ""),
    condition: String(formData.get("condition") ?? ""),
    status: intent === "published" ? "published" : "draft",
    rulesAcknowledged: formData.get("rulesAcknowledged") === "on",
    allowOffers: formData.get("allowOffers") === "on",
  });

  if (!validated.ok) {
    return { status: "error", message: validated.error };
  }

  // Automatically initialize storefront on first listing (idempotent, no duplicates)
  const fallbackName =
    auth.session.profile?.display_name ||
    auth.session.email?.split("@")[0] ||
    "Campus Storefront";
  const sfInit = await ensureStorefrontInitialized(
    auth.supabase,
    auth.userId,
    fallbackName
  );
  if (!sfInit.ok) {
    return { status: "error", message: sfInit.error };
  }

  // Validate & upload up to 4 photos into public listings bucket scoped to seller_id
  const rawFiles = formData.getAll("photos").filter(
    (entry): entry is File => entry instanceof File && entry.size > 0
  );
  if (rawFiles.length > 4) {
    return { status: "error", message: "Upload at most 4 listing photos." };
  }

  const uploadedPaths: string[] = [];
  for (let i = 0; i < rawFiles.length; i++) {
    const file = rawFiles[i];
    if (!file) continue;
    const metaCheck = validateImageFileMeta({
      name: file.name,
      type: file.type,
      size: file.size,
    });
    if (!metaCheck.ok) {
      return { status: "error", message: metaCheck.error };
    }

    const storagePath = `${auth.userId}/${Date.now()}-${i}.${metaCheck.ext}`;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { error: uploadErr } = await auth.supabase.storage
      .from("listings")
      .upload(storagePath, bytes, {
        contentType: file.type,
        upsert: false,
      });

    if (uploadErr) {
      return {
        status: "error",
        message: `Photo upload failed: ${uploadErr.message}`,
      };
    }
    uploadedPaths.push(storagePath);
  }

  const now = new Date().toISOString();
  const { data: inserted, error: insertErr } = await auth.supabase
    .from("listings")
    .insert({
      seller_id: auth.userId,
      kind: validated.data.dbKind,
      is_food: validated.data.isFood,
      title: validated.data.title,
      description: validated.data.description,
      category_id: validated.data.categoryId,
      condition: validated.data.condition,
      limitations: "",
      price_sen: validated.data.priceSen,
      quantity: validated.data.quantity,
      reserved_quantity: 0,
      collection_area_id: validated.data.collectionAreaId,
      allow_offers: validated.data.allowOffers,
      has_variants: false,
      option_groups: [],
      availability_mode: "ready",
      pickup_note: "",
      food_notes: "",
      accepting_requests: validated.data.dbKind === "service",
      image_paths: uploadedPaths,
      rules_acknowledged: validated.data.rulesAcknowledged,
      status: validated.data.status,
      published_at: validated.data.status === "published" ? now : null,
      updated_at: now,
    })
    .select("id")
    .single();

  if (insertErr) {
    return {
      status: "error",
      message: `Unable to save listing: ${insertErr.message}`,
    };
  }

  revalidatePath("/seller");
  revalidatePath("/marketplace");
  revalidatePath("/");

  return {
    status: "success",
    createdId: inserted?.id,
    message:
      validated.data.status === "published"
        ? "Listing published to the UMS campus marketplace."
        : "Listing saved as a draft in your Seller Hub.",
  };
}

function safeParseJson<T>(raw: FormDataEntryValue | null, fallback: T): T {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function updateListingAction(
  _prevState: SellerActionState,
  formData: FormData
): Promise<SellerActionState> {
  const auth = await requireEligibleStudent();
  if (!auth.ok) {
    return { status: "error", message: auth.error };
  }

  const listingId = String(formData.get("listingId") ?? "").trim();
  const expectedUpdatedAt = String(
    formData.get("expectedUpdatedAt") ?? ""
  ).trim();
  if (!isValidUuid(listingId) || !expectedUpdatedAt) {
    return { status: "error", message: "Invalid listing reference." };
  }

  // Verify ownership and load authoritative server state (never trust client reserved_quantity)
  const [existingRes, existingVariantsRes] = await Promise.all([
    auth.supabase
      .from("listings")
      .select("id, seller_id, status, reserved_quantity, published_at, image_paths")
      .eq("id", listingId)
      .maybeSingle(),
    auth.supabase
      .from("listing_variants")
      .select("id, option_values, price_sen, quantity, reserved_quantity, active")
      .eq("listing_id", listingId),
  ]);

  if (existingRes.error || !existingRes.data) {
    return { status: "error", message: "Listing not found." };
  }

  const existing = existingRes.data as {
    id: string;
    seller_id: string;
    status: string;
    reserved_quantity: number;
    published_at: string | null;
    image_paths: string[] | null;
  };

  if (existing.seller_id !== auth.userId) {
    return {
      status: "error",
      message: "You do not have permission to edit another seller's listing.",
    };
  }

  const existingVariants: ExistingVariantRecord[] = (
    (existingVariantsRes.data ?? []) as Array<{
      id: string;
      option_values: Record<string, string> | null;
      price_sen: number;
      quantity: number;
      reserved_quantity: number;
      active: boolean;
    }>
  ).map((v) => ({
    id: v.id,
    optionValues: v.option_values ?? {},
    priceSen: v.price_sen ?? 0,
    quantity: v.quantity ?? 0,
    reservedQuantity: v.reserved_quantity ?? 0,
    active: Boolean(v.active),
  }));

  const referencedVariantIds = new Set<string>();
  const existingVarIds = existingVariants.map((v) => v.id);
  if (existingVarIds.length > 0) {
    const oiRes = await auth.supabase
      .from("order_items")
      .select("variant_id")
      .in("variant_id", existingVarIds);
    if (!oiRes.error && oiRes.data) {
      for (const row of oiRes.data as Array<{ variant_id: string | null }>) {
        if (row.variant_id) referencedVariantIds.add(row.variant_id);
      }
    }
  }

  // Only allow keeping photo paths that already belong to this listing
  const allowedExistingPaths = new Set(existing.image_paths ?? []);
  const keptPhotoPaths = safeParseJson<string[]>(
    formData.get("keptPhotoPaths"),
    []
  ).filter((p) => typeof p === "string" && allowedExistingPaths.has(p));

  const rawFiles = formData
    .getAll("photos")
    .filter((entry): entry is File => entry instanceof File && entry.size > 0);

  const hasVariants = formData.get("hasVariants") === "on";
  const optionGroups = safeParseJson<string[]>(
    formData.get("optionGroupsJson"),
    []
  );
  const variantsInput = safeParseJson<VariantDraftInput[]>(
    formData.get("variantsJson"),
    []
  );

  const intent = String(
    formData.get("intent") ?? existing.status
  ) as EditableListingStatus;
  const listingType = String(
    formData.get("listingType") ?? "preloved"
  ) as SellListingKind;

  const validated = validateListingEditInput({
    currentStatus: existing.status,
    currentReservedQuantity: existing.reserved_quantity ?? 0,
    title: String(formData.get("title") ?? ""),
    description: String(formData.get("description") ?? ""),
    listingType,
    categoryId: String(formData.get("categoryId") ?? ""),
    priceRm: String(formData.get("priceRm") ?? ""),
    quantity: String(formData.get("quantity") ?? "0"),
    collectionAreaId: String(formData.get("collectionAreaId") ?? ""),
    condition: String(formData.get("condition") ?? ""),
    targetStatus: intent,
    rulesAcknowledged: formData.get("rulesAcknowledged") === "on",
    allowOffers: formData.get("allowOffers") === "on",
    keptPhotoPaths,
    newPhotoCount: rawFiles.length,
    hasVariants,
    optionGroups,
    variants: variantsInput,
    existingVariants,
    referencedVariantIds,
  });

  if (!validated.ok) {
    return { status: "error", message: validated.error };
  }

  // Upload any newly added photos (track separately for safe rollback cleanup)
  const newlyUploadedPaths: string[] = [];
  for (let i = 0; i < rawFiles.length; i++) {
    const file = rawFiles[i];
    if (!file) continue;
    const metaCheck = validateImageFileMeta({
      name: file.name,
      type: file.type,
      size: file.size,
    });
    if (!metaCheck.ok) {
      if (newlyUploadedPaths.length > 0) {
        await auth.supabase.storage.from("listings").remove(newlyUploadedPaths);
      }
      return { status: "error", message: metaCheck.error };
    }

    const storagePath = `${auth.userId}/${Date.now()}-${i}.${metaCheck.ext}`;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { error: uploadErr } = await auth.supabase.storage
      .from("listings")
      .upload(storagePath, bytes, {
        contentType: file.type,
        upsert: false,
      });

    if (uploadErr) {
      if (newlyUploadedPaths.length > 0) {
        await auth.supabase.storage.from("listings").remove(newlyUploadedPaths);
      }
      return {
        status: "error",
        message: `Photo upload failed: ${uploadErr.message}`,
      };
    }
    newlyUploadedPaths.push(storagePath);
  }

  const finalPhotoPaths = [...keptPhotoPaths, ...newlyUploadedPaths];
  const now = new Date().toISOString();

  const pPayload = {
    title: validated.data.title,
    description: validated.data.description,
    kind: validated.data.dbKind,
    is_food: validated.data.isFood,
    category_id: validated.data.categoryId,
    condition: validated.data.condition,
    price_sen: validated.data.priceSen,
    quantity: validated.data.quantity,
    collection_area_id: validated.data.collectionAreaId,
    allow_offers: validated.data.allowOffers,
    has_variants: validated.data.hasVariants,
    option_groups: validated.data.optionGroups,
    image_paths: finalPhotoPaths,
    rules_acknowledged: validated.data.rulesAcknowledged,
    status: validated.data.status,
    published_at:
      validated.data.status === "published"
        ? existing.published_at ?? now
        : existing.published_at,
  };

  // Atomic update with optimistic concurrency check via existing DB RPC
  const { error: rpcError } = await auth.supabase.rpc("update_listing_atomic", {
    p_listing_id: listingId,
    p_expected_updated_at: expectedUpdatedAt,
    p_payload: pPayload,
    p_variants: validated.data.variants,
  });

  if (rpcError) {
    // Roll back any newly uploaded orphan images without touching existing order-referenced files
    if (newlyUploadedPaths.length > 0) {
      await auth.supabase.storage.from("listings").remove(newlyUploadedPaths);
    }
    return {
      status: "error",
      message: mapAtomicUpdateError(rpcError.message),
    };
  }

  revalidatePath("/seller");
  revalidatePath(`/sell/${listingId}`);
  revalidatePath(`/listings/${listingId}`);
  revalidatePath("/marketplace");
  revalidatePath("/");

  const successLabel =
    validated.data.status === "published"
      ? "Listing updated and published."
      : validated.data.status === "archived"
        ? "Listing archived and hidden from the public marketplace."
        : "Listing changes saved as draft.";

  return {
    status: "success",
    createdId: listingId,
    message: successLabel,
  };
}
