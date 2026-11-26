"use server";

import { readFoodForm } from "@/lib/food";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupabaseServerClient, getSessionSummary } from "@/lib/supabase/server";
import {
  isValidUuid,
  mapAtomicUpdateError,
  validateListingEditInput,
  validateVariantsInput,
  type EditableListingStatus,
  type ExistingVariantRecord,
  type VariantDraftInput,
} from "@/lib/seller/listing-edit";
import {
  evaluateSellerEligibility,
  MAX_LISTING_PHOTOS,
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

/**
 * Cleans up ONLY newly created, unpersisted uploads from a failed request,
 * never touching any pre-existing or historical storage paths.
 */
async function cleanupNewlyUploadedListingFiles(
  supabase: NonNullable<Awaited<ReturnType<typeof createSupabaseServerClient>>>,
  newlyUploadedPaths: string[],
  protectedPaths: Iterable<string> = []
): Promise<void> {
  if (newlyUploadedPaths.length === 0) return;
  const protectedSet = new Set(protectedPaths);
  const safeTargets = newlyUploadedPaths.filter(
    (p) => typeof p === "string" && p.length > 0 && !protectedSet.has(p)
  );
  if (safeTargets.length > 0) {
    await supabase.storage.from("listings").remove(safeTargets);
  }
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

    const storagePath = `${auth.userId}/storefront-logo-${Date.now()}.${fileCheck.ext}`;
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

  const removeBanner = formData.get("removeBanner") === "on";
  const bannerFile = formData.get("banner");
  let nextBannerPath: string | null | undefined = undefined;

  if (removeBanner) {
    nextBannerPath = null;
  } else if (bannerFile instanceof File && bannerFile.size > 0) {
    const fileCheck = validateImageFileMeta({
      name: bannerFile.name,
      type: bannerFile.type,
      size: bannerFile.size,
    });
    if (!fileCheck.ok) {
      return { status: "error", message: fileCheck.error };
    }

    const storagePath = `${auth.userId}/storefront-banner-${Date.now()}.${fileCheck.ext}`;
    const bytes = new Uint8Array(await bannerFile.arrayBuffer());
    const { error: uploadErr } = await auth.supabase.storage
      .from("listings")
      .upload(storagePath, bytes, {
        contentType: bannerFile.type,
        upsert: true,
      });

    if (uploadErr) {
      return {
        status: "error",
        message: `Banner upload failed: ${uploadErr.message}`,
      };
    }
    nextBannerPath = storagePath;
  }

  const businessInfo = String(formData.get("businessInfo") ?? "").trim().slice(0, 400);
  const isOpen = formData.get("isOpen") === "on";

  const payload: {
    seller_id: string;
    shop_name: string;
    description: string;
    business_info: string | null;
    is_open: boolean;
    updated_at: string;
    logo_path?: string | null;
    banner_path?: string | null;
  } = {
    seller_id: auth.userId,
    shop_name: validated.shopName,
    description: validated.description,
    business_info: businessInfo || null,
    is_open: isOpen,
    updated_at: new Date().toISOString(),
  };

  if (nextLogoPath !== undefined) {
    payload.logo_path = nextLogoPath;
  }
  if (nextBannerPath !== undefined) {
    payload.banner_path = nextBannerPath;
  }

  let { error } = await auth.supabase
    .from("storefronts")
    .upsert(payload, { onConflict: "seller_id" });

  // Graceful fallback if optional Phase 8C columns have not yet been migrated
  if (error && /banner_path|business_info|is_open/i.test(error.message)) {
    const legacyPayload: {
      seller_id: string;
      shop_name: string;
      description: string;
      updated_at: string;
      logo_path?: string | null;
    } = {
      seller_id: auth.userId,
      shop_name: validated.shopName,
      description: validated.description,
      updated_at: payload.updated_at,
    };
    if (nextLogoPath !== undefined) legacyPayload.logo_path = nextLogoPath;
    const retry = await auth.supabase
      .from("storefronts")
      .upsert(legacyPayload, { onConflict: "seller_id" });
    error = retry.error;
  }

  if (error) {
    return {
      status: "error",
      message: `Unable to save storefront: ${error.message}`,
    };
  }

  revalidatePath("/seller");
  revalidatePath("/seller/storefront");
  revalidatePath(`/store/${auth.userId}`);
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
  const hasVariantsRequested =
    formData.get("hasVariants") === "on" &&
    (listingType === "business" || listingType === "food");
  const optionGroups = safeParseJson<string[]>(
    formData.get("optionGroupsJson"),
    []
  );
  const variantsInput = safeParseJson<VariantDraftInput[]>(
    formData.get("variantsJson"),
    []
  );

  const variantsCheck = validateVariantsInput({
    hasVariants: hasVariantsRequested,
    isService: listingType === "service",
    targetStatus: intent === "published" ? "published" : "draft",
    optionGroups,
    variants: variantsInput,
    existingVariants: [],
    referencedVariantIds: new Set<string>(),
  });
  if (!variantsCheck.ok) {
    return { status: "error", message: variantsCheck.error };
  }

  const effectivePriceRm =
    variantsCheck.hasVariants && variantsCheck.minPriceSen !== null
      ? (variantsCheck.minPriceSen / 100).toFixed(2)
      : String(formData.get("priceRm") ?? "");
  const effectiveQuantity =
    variantsCheck.hasVariants && variantsCheck.totalQuantity !== null
      ? String(variantsCheck.totalQuantity)
      : String(formData.get("quantity") ?? "1");

  const validated = validateListingInput({
    title: String(formData.get("title") ?? ""),
    description: String(formData.get("description") ?? ""),
    listingType,
    categoryId: String(formData.get("categoryId") ?? ""),
    priceRm: effectivePriceRm,
    quantity: effectiveQuantity,
    collectionAreaId: String(formData.get("collectionAreaId") ?? ""),
    condition: String(formData.get("condition") ?? ""),
    status: intent === "published" ? "published" : "draft",
    rulesAcknowledged: formData.get("rulesAcknowledged") === "on",
    allowOffers: formData.get("allowOffers") === "on",
    hasVariants: variantsCheck.hasVariants,
  });

  if (!validated.ok) {
    return { status: "error", message: validated.error };
  }

  const foodForm = readFoodForm(formData, validated.data.isFood, validated.data.status === "published");
  if (foodForm.error) return { status: "error", message: foodForm.error };

  const rawVariationPhotoGroup = String(
    formData.get("variationPhotoGroup") ?? ""
  ).trim();
  const matchedPhotoGroup =
    variantsCheck.hasVariants && rawVariationPhotoGroup
      ? variantsCheck.optionGroups.find(
          (g) => g.toLowerCase() === rawVariationPhotoGroup.toLowerCase()
        ) ?? null
      : null;

  if (variantsCheck.hasVariants && rawVariationPhotoGroup && !matchedPhotoGroup) {
    return {
      status: "error",
      message: "Selected photo variation group does not match any option group.",
    };
  }
  const variationPhotoGroup = matchedPhotoGroup;
  const photoKeys = safeParseJson<string[]>(formData.get("photoKeysJson"), []);

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

  // Validate & upload up to MAX_LISTING_PHOTOS into public listings bucket scoped to seller_id
  const rawFiles = formData.getAll("photos").filter(
    (entry): entry is File => entry instanceof File && entry.size > 0
  );
  if (rawFiles.length > MAX_LISTING_PHOTOS) {
    return {
      status: "error",
      message: `Upload at most ${MAX_LISTING_PHOTOS} listing photos.`,
    };
  }

  const uploadedPaths: string[] = [];
  const photoKeyToPath = new Map<string, string>();
  for (let i = 0; i < rawFiles.length; i++) {
    const file = rawFiles[i];
    if (!file) continue;
    const metaCheck = validateImageFileMeta({
      name: file.name,
      type: file.type,
      size: file.size,
    });
    if (!metaCheck.ok) {
      await cleanupNewlyUploadedListingFiles(auth.supabase, uploadedPaths);
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
      await cleanupNewlyUploadedListingFiles(auth.supabase, uploadedPaths);
      return {
        status: "error",
        message: `Photo upload failed: ${uploadErr.message}`,
      };
    }
    uploadedPaths.push(storagePath);
    const key = photoKeys[i];
    if (typeof key === "string" && key.trim()) {
      photoKeyToPath.set(key.trim(), storagePath);
    }
  }
  const allowedUploadedSet = new Set(uploadedPaths);

  const resolvedVariantRows: Array<{
    option_values: Record<string, string>;
    price_sen: number;
    quantity: number;
    reserved_quantity: number;
    active: boolean;
    image_path: string | null;
  }> = [];

  if (variantsCheck.hasVariants && variantsCheck.variants && variantsCheck.variants.length > 0) {
    for (const v of variantsCheck.variants) {
      const rawRef = v.image_path;
      let mappedPath: string | null = null;
      if (rawRef) {
        if (!variationPhotoGroup) {
          await cleanupNewlyUploadedListingFiles(auth.supabase, uploadedPaths);
          return {
            status: "error",
            message: "Choose which variation controls photos before assigning variation images.",
          };
        }
        mappedPath =
          photoKeyToPath.get(rawRef) ??
          (allowedUploadedSet.has(rawRef) ? rawRef : null);
        if (!mappedPath) {
          await cleanupNewlyUploadedListingFiles(auth.supabase, uploadedPaths);
          return {
            status: "error",
            message: "One or more assigned variation photos are missing from uploaded listing photos.",
          };
        }
      }
      resolvedVariantRows.push({
        option_values: v.option_values,
        price_sen: v.price_sen,
        quantity: v.quantity,
        reserved_quantity: 0,
        active: v.active,
        image_path: mappedPath,
      });
    }
  }

  const hasRequestedVariationPhotos =
    Boolean(variationPhotoGroup) ||
    resolvedVariantRows.some((v) => v.image_path !== null);

  const now = new Date().toISOString();
  const rawServiceMode = String(formData.get("serviceMode") ?? "").trim();
  const serviceMode =
    validated.data.dbKind === "service"
      ? rawServiceMode || "in_person"
      : null;
  const pickupNote = String(formData.get("pickupNote") ?? "").trim();
  const foodNotes = String(formData.get("foodNotes") ?? "").trim();
  const rawServiceDetails = formData.get("serviceDetails");
  const parsedServiceDetails =
    typeof rawServiceDetails === "string" && rawServiceDetails.trim().length > 0
      ? (() => {
          try {
            return JSON.parse(rawServiceDetails);
          } catch {
            return rawServiceDetails.trim();
          }
        })()
      : undefined;

  const baseListingPayload: Record<string, unknown> = {
    kind: validated.data.dbKind,
    is_food: validated.data.isFood,
    title: validated.data.title,
    description: validated.data.description,
    category_id: validated.data.categoryId,
    condition: validated.data.condition,
    limitations: "",
    price_sen: validated.data.priceSen,
    quantity: validated.data.quantity,
    collection_area_id: validated.data.collectionAreaId,
    allow_offers: validated.data.allowOffers,
    has_variants: variantsCheck.hasVariants,
    option_groups: variantsCheck.optionGroups,
    variation_photo_group: variationPhotoGroup,
    ...foodForm.payload,
    pickup_note: pickupNote,
    food_notes: foodNotes,
    service_mode: serviceMode,
    accepting_requests: validated.data.dbKind === "service",
    image_paths: uploadedPaths,
    rules_acknowledged: validated.data.rulesAcknowledged,
    status: validated.data.status,
  };
  if (parsedServiceDetails !== undefined) {
    baseListingPayload.service_details = parsedServiceDetails;
  }

  let createdListingId: string | null = null;

  // Primary path: single-transaction atomic listing + variation creation
  const atomicCreateRes = await auth.supabase.rpc(
    "create_listing_with_variations_atomic",
    {
      p_listing: baseListingPayload,
      p_variants: resolvedVariantRows,
    }
  );

  if (!atomicCreateRes.error && typeof atomicCreateRes.data === "string") {
    createdListingId = atomicCreateRes.data;
  } else if (
    atomicCreateRes.error &&
    !/Could not find the function.*create_listing_with_variations_atomic/i.test(
      atomicCreateRes.error.message
    )
  ) {
    await cleanupNewlyUploadedListingFiles(auth.supabase, uploadedPaths);
    return {
      status: "error",
      message: `Unable to save listing: ${atomicCreateRes.error.message}`,
    };
  } else {
    // Pre-migration fallback: never discard requested variation photos
    if (hasRequestedVariationPhotos) {
      await cleanupNewlyUploadedListingFiles(auth.supabase, uploadedPaths);
      return {
        status: "error",
        message:
          "Variation photo assignments require applying the Phase 10V database migration first.",
      };
    }

    // Draft-first safe recovery: insert as draft BEFORE adding variants, then promote only after variants succeed
    const draftPayload: Record<string, unknown> = {
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
      has_variants: variantsCheck.hasVariants,
      option_groups: variantsCheck.optionGroups,
      ...foodForm.payload,
      pickup_note: pickupNote,
      food_notes: foodNotes,
      service_mode: serviceMode,
      accepting_requests: validated.data.dbKind === "service",
      image_paths: uploadedPaths,
      rules_acknowledged: validated.data.rulesAcknowledged,
      status: "draft",
      published_at: null,
      updated_at: now,
    };
    if (parsedServiceDetails !== undefined) {
      draftPayload.service_details = parsedServiceDetails;
    }

    const { data: insertedDraft, error: insertErr } = await auth.supabase
      .from("listings")
      .insert(draftPayload)
      .select("id")
      .single();

    if (insertErr || !insertedDraft?.id) {
      await cleanupNewlyUploadedListingFiles(auth.supabase, uploadedPaths);
      return {
        status: "error",
        message: `Unable to save listing: ${insertErr?.message ?? "Unknown error"}`,
      };
    }

    createdListingId = insertedDraft.id;

    if (resolvedVariantRows.length > 0) {
      const legacyVarRows = resolvedVariantRows
        .filter((v) => v.active)
        .map(({ image_path: _omitImg, ...rest }) => {
          void _omitImg;
          return { ...rest, listing_id: createdListingId };
        });

      const { error: varErr } = await auth.supabase
        .from("listing_variants")
        .insert(legacyVarRows);

      if (varErr) {
        await auth.supabase
          .from("listings")
          .delete()
          .eq("id", createdListingId);
        await cleanupNewlyUploadedListingFiles(auth.supabase, uploadedPaths);
        return {
          status: "error",
          message: `Unable to save listing variants: ${varErr.message}`,
        };
      }
    }

    if (validated.data.status === "published") {
      const { error: pubErr } = await auth.supabase
        .from("listings")
        .update({
          status: "published",
          published_at: now,
          updated_at: new Date().toISOString(),
        })
        .eq("id", createdListingId)
        .eq("seller_id", auth.userId);

      if (pubErr) {
        await auth.supabase
          .from("listings")
          .delete()
          .eq("id", createdListingId);
        await cleanupNewlyUploadedListingFiles(auth.supabase, uploadedPaths);
        return {
          status: "error",
          message: `Unable to publish listing: ${pubErr.message}`,
        };
      }
    }
  }

  if (!createdListingId) {
    await cleanupNewlyUploadedListingFiles(auth.supabase, uploadedPaths);
    return { status: "error", message: "Unable to save listing." };
  }

  revalidatePath("/seller");
  revalidatePath("/marketplace");
  revalidatePath("/services");
  revalidatePath("/");

  return {
    status: "success",
    createdId: createdListingId,
    message:
      validated.data.status === "published"
        ? "Listing published to the UMS campus marketplace."
        : "Listing saved as a draft in your Seller Hub.",
  };
}

export async function deleteListingAction(
  listingId: string
): Promise<{ ok: boolean; message: string }> {
  const auth = await requireEligibleStudent();
  if (!auth.ok) {
    return { ok: false, message: auth.error };
  }

  const { data: existing, error: fetchErr } = await auth.supabase
    .from("listings")
    .select("id,seller_id,reserved_quantity,image_paths")
    .eq("id", listingId)
    .maybeSingle();

  if (fetchErr || !existing) {
    return { ok: false, message: "Listing not found." };
  }
  if (existing.seller_id !== auth.userId) {
    return { ok: false, message: "You can only delete your own listings." };
  }
  if ((existing.reserved_quantity ?? 0) > 0) {
    return {
      ok: false,
      message:
        "Cannot delete this listing while buyers have active reserved stock.",
    };
  }

  const { error: delErr } = await auth.supabase
    .from("listings")
    .delete()
    .eq("id", listingId)
    .eq("seller_id", auth.userId);

  if (delErr) {
    if (delErr.code === "23503") {
      return {
        ok: false,
        message:
          "This listing has order or offer history and cannot be permanently deleted. Use Archive Listing instead.",
      };
    }
    return { ok: false, message: `Unable to delete listing: ${delErr.message}` };
  }

  revalidatePath("/seller");
  revalidatePath("/marketplace");
  revalidatePath("/services");
  revalidatePath("/");

  return { ok: true, message: "Listing deleted permanently." };
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

  const foodForm = readFoodForm(formData, validated.data.isFood,
    validated.data.status === "published", Date.now(), Boolean(existing.published_at));
  if (foodForm.error) return { status: "error", message: foodForm.error };

  const newPhotoKeys = safeParseJson<string[]>(
    formData.get("newPhotoKeysJson"),
    []
  );
  const rawVariationPhotoGroup = String(
    formData.get("variationPhotoGroup") ?? ""
  ).trim();
  const variationPhotoGroup =
    validated.data.hasVariants && rawVariationPhotoGroup
      ? validated.data.optionGroups.find(
          (g) => g.toLowerCase() === rawVariationPhotoGroup.toLowerCase()
        ) ?? null
      : null;

  if (
    validated.data.hasVariants &&
    rawVariationPhotoGroup &&
    !variationPhotoGroup
  ) {
    return {
      status: "error",
      message: "Selected photo variation group does not match any active option group.",
    };
  }

  // Upload any newly added photos (upsert: false, unique keys; rollback removes ONLY newly uploaded files)
  const existingProtectedPaths = existing.image_paths ?? [];
  const newlyUploadedPaths: string[] = [];
  const newPhotoKeyToPath = new Map<string, string>();
  for (let i = 0; i < rawFiles.length; i++) {
    const file = rawFiles[i];
    if (!file) continue;
    const metaCheck = validateImageFileMeta({
      name: file.name,
      type: file.type,
      size: file.size,
    });
    if (!metaCheck.ok) {
      await cleanupNewlyUploadedListingFiles(
        auth.supabase,
        newlyUploadedPaths,
        existingProtectedPaths
      );
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
      await cleanupNewlyUploadedListingFiles(
        auth.supabase,
        newlyUploadedPaths,
        existingProtectedPaths
      );
      return {
        status: "error",
        message: `Photo upload failed: ${uploadErr.message}`,
      };
    }
    newlyUploadedPaths.push(storagePath);
    const key = newPhotoKeys[i];
    if (typeof key === "string" && key.trim()) {
      newPhotoKeyToPath.set(key.trim(), storagePath);
    }
  }

  const finalPhotoPaths = [...keptPhotoPaths, ...newlyUploadedPaths];
  const allowedFinalPhotoSet = new Set(finalPhotoPaths);

  const variantImageMappings: Array<{
    variant_id: string | null;
    option_values: Record<string, string>;
    image_path: string | null;
    active: boolean;
  }> = [];

  for (const v of validated.data.variants ?? []) {
    const rawRef = v.image_path;
    let resolvedPath: string | null = null;
    if (rawRef) {
      if (!variationPhotoGroup) {
        await cleanupNewlyUploadedListingFiles(
          auth.supabase,
          newlyUploadedPaths,
          existingProtectedPaths
        );
        return {
          status: "error",
          message:
            "Choose which variation controls photos before assigning variation images.",
        };
      }
      resolvedPath =
        newPhotoKeyToPath.get(rawRef) ??
        (allowedFinalPhotoSet.has(rawRef) ? rawRef : null);
      if (!resolvedPath) {
        await cleanupNewlyUploadedListingFiles(
          auth.supabase,
          newlyUploadedPaths,
          existingProtectedPaths
        );
        return {
          status: "error",
          message:
            "One or more assigned variation photos are missing from the listing gallery.",
        };
      }
    }
    variantImageMappings.push({
      variant_id: v.id ?? null,
      option_values: v.option_values,
      image_path: resolvedPath,
      active: v.active,
    });
  }

  const hasRequestedVariationPhotos =
    Boolean(variationPhotoGroup) ||
    variantImageMappings.some((m) => m.image_path !== null);

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
    ...(validated.data.isFood ? foodForm.payload : {}),
    rules_acknowledged: validated.data.rulesAcknowledged,
    status: validated.data.status,
    published_at:
      validated.data.status === "published"
        ? existing.published_at ?? now
        : existing.published_at,
  };

  // Strip `image_path` & `active` before passing to `update_listing_atomic`;
  // `save_listing_edit_atomic` persists both edits + `active` + variation photos in ONE transaction.
  const rpcVariants = (validated.data.variants ?? []).map(
    ({ image_path: _img, active: _act, ...rest }) => {
      void _img;
      void _act;
      return rest;
    }
  );

  let { error: saveErr } = await auth.supabase.rpc("save_listing_edit_atomic", {
    p_listing_id: listingId,
    p_expected_updated_at: expectedUpdatedAt,
    p_payload: pPayload,
    p_variants: rpcVariants,
    p_variation_photo_group: variationPhotoGroup,
    p_variant_images: variantImageMappings,
  });

  if (
    saveErr &&
    /Could not find the function.*save_listing_edit_atomic/i.test(saveErr.message)
  ) {
    if (hasRequestedVariationPhotos) {
      await cleanupNewlyUploadedListingFiles(
        auth.supabase,
        newlyUploadedPaths,
        existingProtectedPaths
      );
      return {
        status: "error",
        message:
          "Variation photo assignments require applying the Phase 10V database migration first.",
      };
    }

    // Legacy pre-migration path omits inactive rows so `update_listing_atomic` deactivates them safely
    const legacyActiveVariants = (validated.data.variants ?? [])
      .filter((v) => v.active)
      .map(({ image_path: _img, active: _act, ...rest }) => {
        void _img;
        void _act;
        return rest;
      });
    const legacyRes = await auth.supabase.rpc("update_listing_atomic", {
      p_listing_id: listingId,
      p_expected_updated_at: expectedUpdatedAt,
      p_payload: pPayload,
      p_variants: legacyActiveVariants,
    });
    saveErr = legacyRes.error;
  }

  if (saveErr) {
    // Roll back ONLY newly uploaded orphan files; never delete removed historical paths
    await cleanupNewlyUploadedListingFiles(
      auth.supabase,
      newlyUploadedPaths,
      existingProtectedPaths
    );
    return {
      status: "error",
      message: mapAtomicUpdateError(saveErr.message),
    };
  }

  // Historical storage files removed from `image_paths` are intentionally retained in
  // the `listings` bucket so historical `order_items.image_path` and `offers.variant_image_path`
  // snapshots remain intact cleanly.

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

export async function closeFoodPreorderAction(form: FormData): Promise<void> {
  const auth = await requireEligibleStudent();
  if (!auth.ok) return;
  const listingId = String(form.get("listingId") ?? "");
  if (!isValidUuid(listingId)) return;
  const { error } = await auth.supabase.rpc("close_food_preorder", { p_listing_id: listingId });
  if (error) throw new Error("Could not close this pre-order.");
  revalidatePath("/seller");
  revalidatePath("/marketplace");
  revalidatePath(`/listings/${listingId}`);
}
