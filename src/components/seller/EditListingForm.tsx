"use client";

import { useActionState, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  ArrowRight,
  Briefcase,
  CheckCircle2,
  ExternalLink,
  FileText,
  GripVertical,
  ImagePlus,
  RotateCcw,
  Send,
  Star,
  Tag,
  Trash2,
  Utensils,
  Wrench,
  X,
} from "lucide-react";
import {
  updateListingAction,
  type SellerActionState,
} from "@/app/seller/actions";
import { DeleteListingButton } from "@/components/seller/DeleteListingButton";
import { ListingCardPreview } from "@/components/seller/ListingCardPreview";
import { VariationsInventoryManager } from "@/components/seller/VariationsInventoryManager";
import type {
  CollectionAreaOption,
  EditablePhotoItem,
  SellerListingDetail,
} from "@/lib/seller/data";
import type { VariantDraftInput } from "@/lib/seller/listing-edit";
import {
  MAX_LISTING_PHOTOS,
  parseRmToSen,
  validateImageFileMeta,
  type SellListingKind,
} from "@/lib/seller/validation";
import {
  extractVariationSetupFromVariants,
  type SharedListingPhotoRef,
  type VariationGroupConfig,
} from "@/lib/seller/variations";
import type { Category } from "@/types/marketplace";

interface EditListingFormProps {
  listing: SellerListingDetail;
  categories: Category[];
  collectionAreas: CollectionAreaOption[];
  sellerDisplayName?: string;
}

const INITIAL_STATE: SellerActionState = { status: "idle" };

const LISTING_TYPES: Array<{
  id: SellListingKind;
  label: string;
  desc: string;
  icon: typeof Tag;
}> = [
  { id: "preloved", label: "Pre-Loved Item", desc: "Textbooks, tech, dorm gear", icon: Tag },
  { id: "business", label: "Student Business", desc: "Handmade goods, merch, crafts", icon: Briefcase },
  { id: "food", label: "Campus Food", desc: "Snacks, desserts, drinks", icon: Utensils },
  { id: "service", label: "Student Service", desc: "Tutoring, design, printing", icon: Wrench },
];

const CONDITIONS = ["New/Unused", "Like New", "Good", "Fair"];

function statusDisplayText(status: string, availableStock: number, isService: boolean) {
  if (status === "published" && !isService && availableStock === 0) {
    return { label: "Out of Stock", cls: "text-[#B42318]" };
  }
  if (status === "published") return { label: "Live", cls: "text-[#0F766E]" };
  if (status === "archived") return { label: "Archived", cls: "text-[#6E6A7C]" };
  return { label: "Draft", cls: "text-[#6E6A7C]" };
}

export function EditListingForm({
  listing,
  categories,
  collectionAreas,
  sellerDisplayName = "UMS Student",
}: EditListingFormProps) {
  const [state, formAction, pending] = useActionState(
    updateListingAction,
    INITIAL_STATE
  );
  const [submitCount, setSubmitCount] = useState(0);
  const [dismissedCount, setDismissedCount] = useState(0);

  const [listingType, setListingType] = useState<SellListingKind>(
    listing.listingType
  );
  const [title, setTitle] = useState(listing.title);
  const [categoryId, setCategoryId] = useState(listing.categoryId);
  const [collectionAreaId, setCollectionAreaId] = useState(
    listing.collectionAreaId
  );
  const [condition, setCondition] = useState(listing.condition || "Like New");
  const [allowOffers, setAllowOffers] = useState<boolean>(
    Boolean(
      listing.allowOffers &&
        (listing.listingType === "preloved" ||
          listing.listingType === "business")
    )
  );
  const [priceRm, setPriceRm] = useState((listing.priceSen / 100).toFixed(2));
  const [quantity, setQuantity] = useState(String(listing.quantity));
  const [keptPhotos, setKeptPhotos] = useState<EditablePhotoItem[]>(
    listing.photos
  );
  const [newPhotos, setNewPhotos] = useState<
    Array<{ id: string; file: File; previewUrl: string }>
  >([]);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [pendingKeptRemovalIdx, setPendingKeptRemovalIdx] = useState<
    number | null
  >(null);

  const lockedSet = new Set(listing.lockedVariantIds);

  const initialVariantRows: VariantDraftInput[] = listing.variants.map((v) => ({
    id: v.id,
    optionValues: v.optionValues,
    priceRm: (v.priceSen / 100).toFixed(2),
    quantity: String(v.quantity),
    active: v.active,
    imagePath: v.imagePath ?? null,
    reservedQuantity: v.reservedQuantity,
    isLocked: lockedSet.has(v.id),
  }));

  const initialVariationSetup = extractVariationSetupFromVariants({
    optionGroups: listing.optionGroups,
    variants: initialVariantRows,
    variationPhotoGroup: listing.variationPhotoGroup,
  });

  // Variant state
  const [hasVariants, setHasVariants] = useState(listing.hasVariants);
  const [variationGroups, setVariationGroups] = useState<
    VariationGroupConfig[]
  >(initialVariationSetup.groups);
  const [photoGroupName, setPhotoGroupName] = useState<string | null>(
    initialVariationSetup.photoGroupName
  );
  const [optionPhotoMap, setOptionPhotoMap] = useState<
    Record<string, string | null>
  >(initialVariationSetup.optionPhotoMap);
  const [variants, setVariants] = useState<VariantDraftInput[]>(
    initialVariantRows
  );

  const isService = listingType === "service";
  const isFood = listingType === "food";
  const supportsVariants = listingType === "business" || listingType === "food";
  const supportsBargaining =
    listingType === "preloved" || listingType === "business";
  const filteredCategories = categories.filter((c) => {
    if (isService) return c.kind === "service";
    if (isFood) {
      return (
        c.kind !== "service" &&
        (c.id === "food" || /food|snack|drink|beverage|meal/i.test(c.name))
      );
    }
    return c.kind !== "service";
  });
  const fallbackCategories = isService
    ? categories
    : categories.filter((c) => c.kind !== "service");
  const selectableCategories =
    filteredCategories.length > 0
      ? filteredCategories
      : fallbackCategories.length > 0
        ? fallbackCategories
        : categories;

  const effectiveCategoryId = selectableCategories.some(
    (c) => c.id === categoryId
  )
    ? categoryId
    : (selectableCategories[0]?.id ?? "");

  const parsedPrice = priceRm.trim() ? parseRmToSen(priceRm) : null;
  const maxNewPhotos = Math.max(
    0,
    MAX_LISTING_PHOTOS - keptPhotos.length - newPhotos.length
  );
  const st = statusDisplayText(
    listing.status,
    listing.availableStock,
    isService
  );

  // Aggregate active variant totals & minimum price for preview and form submission
  const activeVariants = variants.filter((v) => v.active);
  const activeVariantTotal = activeVariants.reduce(
    (sum, v) => sum + Math.max(0, Number.parseInt(String(v.quantity || "0"), 10) || 0),
    0
  );
  const minVariantSen = activeVariants.reduce<number | null>((min, v) => {
    const p = parseRmToSen(v.priceRm);
    if (!p.ok) return min;
    return min === null || p.sen < min ? p.sen : min;
  }, null);

  const previewPriceSen =
    hasVariants && supportsVariants && minVariantSen !== null
      ? minVariantSen
      : parsedPrice?.ok
        ? parsedPrice.sen
        : 0;
  const previewCategoryName =
    selectableCategories.find((c) => c.id === effectiveCategoryId)?.name ??
    "Category";
  const previewAreaName =
    collectionAreas.find((a) => a.id === collectionAreaId)?.name ??
    "UMSKAL, Labuan";
  const previewCoverUrl = keptPhotos[0]?.url ?? newPhotos[0]?.previewUrl ?? null;

  const [dragPhotoIdx, setDragPhotoIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  function reorderPhoto(fromIndex: number, toIndex: number) {
    if (
      fromIndex === toIndex ||
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= keptPhotos.length ||
      toIndex >= keptPhotos.length
    ) {
      return;
    }
    setKeptPhotos((prev) => {
      const copy = [...prev];
      const [moved] = copy.splice(fromIndex, 1);
      if (moved) copy.splice(toIndex, 0, moved);
      return copy;
    });
  }

  function movePhoto(index: number, delta: number) {
    const nextIdx = index + delta;
    if (nextIdx < 0 || nextIdx >= keptPhotos.length) return;
    setKeptPhotos((prev) => {
      const copy = [...prev];
      const [moved] = copy.splice(index, 1);
      if (moved) copy.splice(nextIdx, 0, moved);
      return copy;
    });
  }

  function makeCoverPhoto(index: number) {
    if (index <= 0 || index >= keptPhotos.length) return;
    setKeptPhotos((prev) => {
      const copy = [...prev];
      const [moved] = copy.splice(index, 1);
      if (moved) copy.unshift(moved);
      return copy;
    });
  }

  function getAssignedPhotoOptions(photoKey: string): string[] {
    return Object.entries(optionPhotoMap)
      .filter(([, mappedKey]) => mappedKey === photoKey)
      .map(([option]) => option);
  }

  function clearPhotoReference(photoKey: string) {
    setOptionPhotoMap((prev) => {
      let changed = false;
      const next: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (v === photoKey) {
          next[k] = null;
          changed = true;
        } else {
          next[k] = v;
        }
      }
      return changed ? next : prev;
    });
    setVariants((prev) =>
      prev.map((row) =>
        row.imagePath === photoKey ? { ...row, imagePath: null } : row
      )
    );
  }

  function removePhotoConfirmed(index: number) {
    const target = keptPhotos[index];
    setPendingKeptRemovalIdx(null);
    setKeptPhotos((prev) => prev.filter((_, i) => i !== index));
    if (target) clearPhotoReference(target.path);
  }

  function removePhoto(index: number) {
    const target = keptPhotos[index];
    if (!target) return;
    if (hasVariants && supportsVariants) {
      const assigned = getAssignedPhotoOptions(target.path);
      if (assigned.length > 0) {
        setPendingKeptRemovalIdx(index);
        return;
      }
    }
    removePhotoConfirmed(index);
  }

  function removeNewPhoto(id: string) {
    setNewPhotos((prev) => prev.filter((p) => p.id !== id));
    clearPhotoReference(id);
  }

  async function readFileDataUrl(file: File): Promise<string | null> {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () =>
        resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  async function handleUploadSharedPhoto(
    file: File
  ): Promise<SharedListingPhotoRef | null> {
    const metaCheck = validateImageFileMeta(file);
    if (!metaCheck.ok) {
      setPhotoError(metaCheck.error);
      return null;
    }
    if (keptPhotos.length + newPhotos.length >= MAX_LISTING_PHOTOS) {
      setPhotoError(`Maximum ${MAX_LISTING_PHOTOS} photos reached.`);
      return null;
    }
    const previewUrl = await readFileDataUrl(file);
    if (!previewUrl) {
      setPhotoError("Failed to read uploaded photo.");
      return null;
    }
    const id = `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setPhotoError(null);
    setNewPhotos((prev) => {
      if (keptPhotos.length + prev.length >= MAX_LISTING_PHOTOS) return prev;
      return [...prev, { id, file, previewUrl }];
    });
    return {
      key: id,
      url: previewUrl,
      storagePath: null,
    };
  }

  async function handleNewPhotosChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;

    const remaining = Math.max(
      0,
      MAX_LISTING_PHOTOS - keptPhotos.length - newPhotos.length
    );
    if (remaining <= 0) {
      setPhotoError(`Maximum ${MAX_LISTING_PHOTOS} photos allowed.`);
      return;
    }

    for (const file of files.slice(0, remaining)) {
      const check = validateImageFileMeta(file);
      if (!check.ok) {
        setPhotoError(check.error);
        return;
      }
    }

    setPhotoError(null);
    const added: Array<{ id: string; file: File; previewUrl: string }> = [];
    for (const file of files.slice(0, remaining)) {
      const previewUrl = await readFileDataUrl(file);
      if (previewUrl) {
        added.push({
          id: `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          file,
          previewUrl,
        });
      }
    }
    if (added.length > 0) {
      setNewPhotos((prev) => {
        const cap = Math.max(0, MAX_LISTING_PHOTOS - keptPhotos.length);
        return [...prev, ...added].slice(0, cap);
      });
    }
  }

  const sharedPhotos: SharedListingPhotoRef[] = [
    ...keptPhotos.map((p) => ({
      key: p.path,
      url: p.url,
      storagePath: p.path,
    })),
    ...newPhotos.map((p) => ({
      key: p.id,
      url: p.previewUrl,
      storagePath: null,
    })),
  ];

  const serializedOptionGroups = variationGroups
    .map((g) => g.name.trim())
    .filter((name) => name.length > 0);

  return (
    <>
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_310px] lg:items-start">
    <form
      action={(fd) => {
        fd.delete("photos");
        for (const p of newPhotos) {
          fd.append("photos", p.file);
        }
        fd.set("newPhotoKeysJson", JSON.stringify(newPhotos.map((p) => p.id)));
        fd.set("hasVariants", hasVariants && supportsVariants ? "on" : "");
        fd.set("variationPhotoGroup", photoGroupName ?? "");
        fd.set("optionGroupsJson", JSON.stringify(serializedOptionGroups));
        fd.set("variantsJson", JSON.stringify(variants));
        fd.set("categoryId", effectiveCategoryId);
        setSubmitCount((c) => c + 1);
        return formAction(fd);
      }}
      className="space-y-6"
    >
      <input type="hidden" name="listingId" value={listing.id} />
      <input type="hidden" name="expectedUpdatedAt" value={listing.updatedAt} />
      <input
        type="hidden"
        name="keptPhotoPaths"
        value={JSON.stringify(keptPhotos.map((p) => p.path))}
      />
      <input
        type="hidden"
        name="newPhotoKeysJson"
        value={JSON.stringify(newPhotos.map((p) => p.id))}
      />
      <input
        type="hidden"
        name="variationPhotoGroup"
        value={photoGroupName ?? ""}
      />
      <input
        type="hidden"
        name="optionGroupsJson"
        value={JSON.stringify(serializedOptionGroups)}
      />
      <input
        type="hidden"
        name="variantsJson"
        value={JSON.stringify(variants)}
      />

      {/* Status & Inventory Summary Bar (Uniform Neutral Card, Plain Colored Text Only) */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-2xl border border-[#E6E3EE] border-l-[3px] border-l-[#4E2A84] bg-white px-4 py-3">
          <p className="text-[10.5px] font-bold uppercase tracking-wider text-[#6E6A7C]">
            Current Status
          </p>
          <p className={`mt-1 text-base font-extrabold ${st.cls}`}>{st.label}</p>
        </div>
        <div className="rounded-2xl border border-[#E6E3EE] border-l-[3px] border-l-[#4E2A84] bg-white px-4 py-3">
          <p className="text-[10.5px] font-bold uppercase tracking-wider text-[#6E6A7C]">
            Available Stock
          </p>
          <p className="tabular-price mt-1 text-base font-extrabold text-[#4E2A84]">
            {isService ? "Service" : listing.availableStock}
          </p>
        </div>
        <div className="rounded-2xl border border-[#E6E3EE] border-l-[3px] border-l-[#4E2A84] bg-white px-4 py-3">
          <p className="text-[10.5px] font-bold uppercase tracking-wider text-[#6E6A7C]">
            Reserved Units
          </p>
          <p className="tabular-price mt-1 text-base font-extrabold text-[#14121A]">
            {isService ? "—" : listing.reservedQuantity}
          </p>
        </div>
        <div className="rounded-2xl border border-[#E6E3EE] border-l-[3px] border-l-[#4E2A84] bg-white px-4 py-3">
          <p className="text-[10.5px] font-bold uppercase tracking-wider text-[#6E6A7C]">
            Public Page
          </p>
          <div className="mt-1 text-sm font-bold">
            {listing.status === "published" ? (
              <Link
                href={`/listings/${encodeURIComponent(listing.id)}`}
                className="inline-flex items-center gap-1 text-[#4E2A84] hover:underline"
              >
                <span>View Live</span>
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            ) : (
              <span className="text-[#6E6A7C]">Not public</span>
            )}
          </div>
        </div>
      </div>

      {/* Feedback Banners */}
      {state.status === "error" && state.message ? (
        <div
          role="alert"
          className="rounded-xl border border-[#B42318]/30 bg-white px-4 py-3 text-sm font-semibold text-[#B42318]"
        >
          {state.message}
        </div>
      ) : null}

      {state.status === "success" && state.message ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#0F766E]/35 bg-white px-4 py-3 text-sm font-semibold text-[#0F766E]"
        >
          <span className="inline-flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            {state.message}
          </span>
          <Link
            href="/seller"
            className="text-xs font-bold text-[#4E2A84] hover:underline"
          >
            Back to Seller Hub →
          </Link>
        </div>
      ) : null}

      {/* Main Editor Card */}
      <div className="rounded-2xl border border-[#E6E3EE] bg-white p-5 shadow-[0_1px_4px_rgba(20,18,26,0.03)] sm:p-6">
        {/* Listing Type */}
        <fieldset>
          <legend className="text-sm font-extrabold text-[#14121A]">
            Listing Type
          </legend>
          <input type="hidden" name="listingType" value={listingType} />
          <div className="mt-2.5 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
            {LISTING_TYPES.map((type) => {
              const Icon = type.icon;
              const active = listingType === type.id;
              return (
                <button
                  key={type.id}
                  type="button"
                  onClick={() => {
                    setListingType(type.id);
                    if (type.id !== "preloved" && type.id !== "business") {
                      setAllowOffers(false);
                    }
                  }}
                  aria-pressed={active}
                  className={`flex items-start gap-2.5 rounded-xl border p-3 text-left transition-colors press-feedback ${
                    active
                      ? "border-[#4E2A84] bg-[#FAFAFC] text-[#4E2A84]"
                      : "border-[#E6E3EE] bg-white text-[#14121A] hover:border-[#CFCBD9]"
                  }`}
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block text-[13px] font-extrabold leading-tight">
                      {type.label}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-[#6E6A7C]">
                      {type.desc}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>

        {/* Core Details */}
        <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div className="lg:col-span-2">
            <label htmlFor="title" className="block text-sm font-bold text-[#14121A]">
              Listing Title <span className="text-[#B42318]">*</span>
            </label>
            <input
              id="title"
              name="title"
              type="text"
              required
              minLength={3}
              maxLength={120}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="mt-1.5 w-full rounded-xl border border-[#CFCBD9] bg-white px-3.5 py-2.5 text-sm text-[#14121A] focus:border-[#4E2A84] focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="categoryId" className="block text-sm font-bold text-[#14121A]">
              Category <span className="text-[#B42318]">*</span>
            </label>
            <select
              id="categoryId"
              name="categoryId"
              required
              value={effectiveCategoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className="mt-1.5 w-full rounded-xl border border-[#CFCBD9] bg-white px-3.5 py-2.5 text-sm text-[#14121A] focus:border-[#4E2A84] focus:outline-none"
            >
              {selectableCategories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}
                </option>
              ))}
            </select>
          </div>

          {hasVariants && supportsVariants ? (
            <>
              <div
                className={`grid gap-3 ${
                  !isService && !isFood ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"
                }`}
              >
                <div>
                  <label htmlFor="collectionAreaId" className="block text-sm font-bold text-[#14121A]">
                    Campus Collection Area <span className="text-[#B42318]">*</span>
                  </label>
                  <select
                    id="collectionAreaId"
                    name="collectionAreaId"
                    required
                    value={collectionAreaId}
                    onChange={(e) => setCollectionAreaId(e.target.value)}
                    className="mt-1.5 w-full rounded-xl border border-[#CFCBD9] bg-white px-3.5 py-2.5 text-sm text-[#14121A] focus:border-[#4E2A84] focus:outline-none"
                  >
                    <option value="">Select campus meetup area</option>
                    {collectionAreas.map((area) => (
                      <option key={area.id} value={area.id}>
                        {area.name}
                      </option>
                    ))}
                  </select>
                </div>

                {!isService && !isFood ? (
                  <div>
                    <label htmlFor="condition" className="block text-sm font-bold text-[#14121A]">
                      Item Condition <span className="text-[#B42318]">*</span>
                    </label>
                    <select
                      id="condition"
                      name="condition"
                      required
                      value={condition}
                      onChange={(e) => setCondition(e.target.value)}
                      className="mt-1.5 w-full rounded-xl border border-[#CFCBD9] bg-white px-3.5 py-2.5 text-sm text-[#14121A] focus:border-[#4E2A84] focus:outline-none"
                    >
                      {CONDITIONS.map((cond) => (
                        <option key={cond} value={cond}>
                          {cond}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <input type="hidden" name="condition" value="" />
                )}
              </div>

              <input
                type="hidden"
                name="priceRm"
                value={
                  minVariantSen !== null
                    ? (minVariantSen / 100).toFixed(2)
                    : priceRm
                }
              />
              <input
                type="hidden"
                name="quantity"
                value={String(activeVariantTotal)}
              />
            </>
          ) : (
            <>
              {/* Price & Quantity (when variants are NOT enabled) */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="priceRm" className="block text-sm font-bold text-[#14121A]">
                    Price (RM) <span className="text-[#B42318]">*</span>
                  </label>
                  <div className="relative mt-1.5">
                    <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-xs font-extrabold text-[#6E6A7C]">
                      RM
                    </span>
                    <input
                      id="priceRm"
                      name="priceRm"
                      type="text"
                      inputMode="decimal"
                      required
                      value={priceRm}
                      onChange={(e) => setPriceRm(e.target.value)}
                      className="w-full rounded-xl border border-[#CFCBD9] bg-white py-2.5 pr-3 pl-9 text-sm font-bold text-[#14121A] focus:border-[#4E2A84] focus:outline-none"
                    />
                  </div>
                  {parsedPrice ? (
                    <p
                      className={`mt-1 text-[11px] font-semibold ${
                        parsedPrice.ok ? "text-[#0F766E]" : "text-[#B42318]"
                      }`}
                    >
                      {parsedPrice.ok
                        ? `RM ${(parsedPrice.sen / 100).toFixed(2)}`
                        : parsedPrice.error}
                    </p>
                  ) : null}
                </div>

                {!isService ? (
                  <div>
                    <label htmlFor="quantity" className="block text-sm font-bold text-[#14121A]">
                      Total Quantity
                    </label>
                    <input
                      id="quantity"
                      name="quantity"
                      type="number"
                      min={listing.reservedQuantity}
                      max={999}
                      value={quantity}
                      onChange={(e) => setQuantity(e.target.value)}
                      className="mt-1.5 w-full rounded-xl border border-[#CFCBD9] bg-white px-3.5 py-2.5 text-sm font-bold text-[#14121A] focus:border-[#4E2A84] focus:outline-none"
                    />
                    <p className="mt-1 text-[11px] text-[#6E6A7C]">
                      {listing.reservedQuantity > 0
                        ? `Min ${listing.reservedQuantity} (reserved)`
                        : "Set 0 for Out of Stock"}
                    </p>
                  </div>
                ) : (
                  <input type="hidden" name="quantity" value="1" />
                )}
              </div>

              <div>
                <label htmlFor="collectionAreaId" className="block text-sm font-bold text-[#14121A]">
                  Campus Collection Area {!isService ? <span className="text-[#B42318]">*</span> : "(optional)"}
                </label>
                <select
                  id="collectionAreaId"
                  name="collectionAreaId"
                  required={!isService}
                  value={collectionAreaId}
                  onChange={(e) => setCollectionAreaId(e.target.value)}
                  className="mt-1.5 w-full rounded-xl border border-[#CFCBD9] bg-white px-3.5 py-2.5 text-sm text-[#14121A] focus:border-[#4E2A84] focus:outline-none"
                >
                  <option value="">Select campus meetup area</option>
                  {collectionAreas.map((area) => (
                    <option key={area.id} value={area.id}>
                      {area.name}
                    </option>
                  ))}
                </select>
              </div>

              {!isService && !isFood ? (
                <div>
                  <label htmlFor="condition" className="block text-sm font-bold text-[#14121A]">
                    Item Condition <span className="text-[#B42318]">*</span>
                  </label>
                  <select
                    id="condition"
                    name="condition"
                    required
                    value={condition}
                    onChange={(e) => setCondition(e.target.value)}
                    className="mt-1.5 w-full rounded-xl border border-[#CFCBD9] bg-white px-3.5 py-2.5 text-sm text-[#14121A] focus:border-[#4E2A84] focus:outline-none"
                  >
                    {CONDITIONS.map((cond) => (
                      <option key={cond} value={cond}>
                        {cond}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <input type="hidden" name="condition" value="" />
              )}
            </>
          )}

          <div className="lg:col-span-2">
            <label htmlFor="description" className="block text-sm font-bold text-[#14121A]">
              Description <span className="text-[#B42318]">*</span>
            </label>
            <textarea
              id="description"
              name="description"
              rows={4}
              minLength={20}
              maxLength={3000}
              required
              defaultValue={listing.description}
              className="mt-1.5 w-full rounded-xl border border-[#CFCBD9] bg-white px-3.5 py-2.5 text-sm text-[#14121A] focus:border-[#4E2A84] focus:outline-none"
            />
            <p className="mt-1 text-xs text-[#6E6A7C]">
              Between 20 and 3,000 characters required.
            </p>
          </div>
        </div>
      </div>

      {/* Product Variations & Inventory Section (Student Business & Campus Food Only) */}
      {supportsVariants ? (
        <VariationsInventoryManager
          enabled={hasVariants}
          onToggleEnabled={setHasVariants}
          groups={variationGroups}
          variants={variants}
          photoGroupName={photoGroupName}
          optionPhotoMap={optionPhotoMap}
          sharedPhotos={sharedPhotos}
          defaultPriceRm={priceRm || "15.00"}
          canEditToggle={listing.lockedVariantIds.length === 0}
          onChangeState={(next) => {
            setVariationGroups(next.groups);
            setVariants(next.variants);
            setPhotoGroupName(next.photoGroupName);
            setOptionPhotoMap(next.optionPhotoMap);
          }}
          onUploadSharedPhoto={handleUploadSharedPhoto}
        />
      ) : null}

      {/* Listing Photos Manager */}
      <div className="rounded-2xl border border-[#E6E3EE] bg-white p-5 shadow-[0_1px_4px_rgba(20,18,26,0.03)] sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-extrabold italic text-[#14121A]">
              Listing Photos ({keptPhotos.length + newPhotos.length}/
              {MAX_LISTING_PHOTOS})
            </h2>
            <p className="mt-0.5 text-xs text-[#6E6A7C]">
              The first photo is your cover image. Drag photos to reorder, replace cover, or
              add up to {MAX_LISTING_PHOTOS} photos total.
            </p>
          </div>
        </div>

        {photoError ? (
          <p className="mt-2 text-xs font-semibold text-[#BA1A1A]">
            {photoError}
          </p>
        ) : null}

        {pendingKeptRemovalIdx !== null && keptPhotos[pendingKeptRemovalIdx] ? (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900">
            <div className="flex items-start gap-2">
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0 text-amber-700"
                aria-hidden="true"
              />
              <span>
                Photo #{pendingKeptRemovalIdx + 1} is assigned to variation
                option{" "}
                <strong>
                  {getAssignedPhotoOptions(
                    keptPhotos[pendingKeptRemovalIdx]!.path
                  ).join(", ")}
                </strong>
                . Removing it will clear those variation photos.
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPendingKeptRemovalIdx(null)}
                className="rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-bold text-amber-900 hover:bg-amber-100"
              >
                Keep Photo
              </button>
              <button
                type="button"
                onClick={() => removePhotoConfirmed(pendingKeptRemovalIdx)}
                className="rounded-lg bg-[#B42318] px-2.5 py-1 text-[11px] font-bold text-white hover:bg-[#991B1B]"
              >
                Remove Photo
              </button>
            </div>
          </div>
        ) : null}

        {keptPhotos.length > 0 ? (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {keptPhotos.map((photo, idx) => (
              <div
                key={photo.path}
                draggable
                onDragStart={(e) => {
                  setDragPhotoIdx(idx);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (dragOverIdx !== idx) setDragOverIdx(idx);
                }}
                onDragLeave={() => {
                  if (dragOverIdx === idx) setDragOverIdx(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragPhotoIdx !== null) {
                    reorderPhoto(dragPhotoIdx, idx);
                  }
                  setDragPhotoIdx(null);
                  setDragOverIdx(null);
                }}
                onDragEnd={() => {
                  setDragPhotoIdx(null);
                  setDragOverIdx(null);
                }}
                className={`cursor-grab overflow-hidden rounded-xl border bg-[#FAFAFC] transition active:cursor-grabbing ${
                  dragOverIdx === idx && dragPhotoIdx !== idx
                    ? "border-[#4E2A84] ring-2 ring-[#4E2A84]/30"
                    : "border-[#E6E3EE]"
                } ${dragPhotoIdx === idx ? "opacity-55" : ""}`}
              >
                <div className="relative aspect-[4/3] w-full bg-[#F5F4F8]">
                  <Image
                    src={photo.url}
                    alt={`Listing photo ${idx + 1}`}
                    fill
                    unoptimized
                    draggable={false}
                    sizes="220px"
                    className="object-cover select-none"
                  />
                  {idx === 0 ? (
                    <span className="absolute top-2 left-2 rounded-md bg-white/95 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-[#4E2A84]">
                      Cover
                    </span>
                  ) : null}
                  <span
                    title="Drag to reorder"
                    className="absolute top-2 right-2 flex h-6 w-6 items-center justify-center rounded-md bg-white/85 text-[#555062] shadow-xs backdrop-blur-xs"
                  >
                    <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                </div>
                <div className="flex items-center justify-between gap-1 border-t border-[#ECEAF2] bg-white px-2 py-1.5 text-[11px]">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={idx === 0}
                      onClick={() => movePhoto(idx, -1)}
                      aria-label="Move photo left"
                      className="rounded p-1 text-[#555062] hover:text-[#4E2A84] disabled:opacity-30"
                    >
                      <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      disabled={idx === keptPhotos.length - 1}
                      onClick={() => movePhoto(idx, 1)}
                      aria-label="Move photo right"
                      className="rounded p-1 text-[#555062] hover:text-[#4E2A84] disabled:opacity-30"
                    >
                      <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    {idx > 0 ? (
                      <button
                        type="button"
                        onClick={() => makeCoverPhoto(idx)}
                        className="inline-flex items-center gap-0.5 px-1 font-bold text-[#4E2A84] hover:underline"
                      >
                        <Star className="h-3 w-3" aria-hidden="true" />
                        <span>Cover</span>
                      </button>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => removePhoto(idx)}
                    aria-label={`Remove photo ${idx + 1}`}
                    className="rounded p-1 text-[#6E6A7C] hover:text-[#B42318]"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {maxNewPhotos > 0 ? (
          <div className="mt-4">
            <label
              htmlFor="new-photos"
              className="block text-xs font-bold text-[#14121A]"
            >
              Add New Photos (up to {maxNewPhotos} more)
            </label>
            <div className="mt-1.5 flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-[#CFCBD9] bg-[#FAFAFC] p-3.5">
              <ImagePlus
                className="h-5 w-5 shrink-0 text-[#4E2A84]"
                aria-hidden="true"
              />
              <input
                id="new-photos"
                name="photos"
                type="file"
                multiple
                accept="image/jpeg,image/png,image/webp"
                onChange={handleNewPhotosChange}
                className="min-w-0 flex-1 text-xs text-[#4A4656] file:mr-3 file:rounded-lg file:border-0 file:bg-[#4E2A84] file:px-3 py-1.5 file:text-xs file:font-bold file:text-white hover:file:bg-[#3A1E66]"
              />
            </div>
            {newPhotos.length > 0 ? (
              <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                {newPhotos.map((np, i) => (
                  <div
                    key={np.id}
                    className="group relative aspect-[4/3] overflow-hidden rounded-xl border border-[#E6E3EE] bg-[#F5F4F8]"
                  >
                    <Image
                      src={np.previewUrl}
                      alt={`New photo preview ${i + 1}`}
                      fill
                      unoptimized
                      sizes="160px"
                      className="object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => removeNewPhoto(np.id)}
                      aria-label={`Remove new photo ${i + 1}`}
                      className="absolute top-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-md bg-white/90 text-[#6E6A7C] shadow-xs hover:text-[#B42318]"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <p className="mt-3 text-xs text-[#6E6A7C]">
            Maximum of {MAX_LISTING_PHOTOS} photos reached. Remove an existing
            photo to upload a replacement.
          </p>
        )}
      </div>

      {/* Rules & Save Actions */}
      <div className="rounded-2xl border border-[#E6E3EE] bg-white p-5 shadow-[0_1px_4px_rgba(20,18,26,0.03)] sm:p-6">
        <div className="space-y-3">
          {supportsBargaining ? (
            <label className="flex cursor-pointer items-start gap-2.5 text-sm text-[#14121A]">
              <input
                type="checkbox"
                name="allowOffers"
                checked={allowOffers}
                onChange={(e) => setAllowOffers(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-[#CFCBD9] accent-[#4E2A84]"
              />
              <span>
                <span className="font-bold">Allow price negotiation</span>{" "}
                <span className="block text-xs text-[#6E6A7C]">
                  Let buyers make offers and negotiate the final price through
                  chat.
                </span>
              </span>
            </label>
          ) : null}

          <label className="flex items-start gap-2.5 text-sm text-[#14121A]">
            <input
              type="checkbox"
              name="rulesAcknowledged"
              defaultChecked={listing.rulesAcknowledged}
              className="mt-0.5 h-4 w-4 rounded border-[#CFCBD9] accent-[#0F766E]"
            />
            <span>
              <span className="font-bold">
                I confirm this listing follows UMS campus marketplace rules
              </span>{" "}
              <span className="text-xs text-[#6E6A7C]">
                (required to publish)
              </span>
            </span>
          </label>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[#F0EDF5] pt-5">
          <div className="flex flex-wrap items-center gap-2.5">
            {listing.status === "archived" ? (
              <button
                type="submit"
                name="intent"
                value="draft"
                disabled={pending}
                className="inline-flex items-center gap-1.5 rounded-xl border border-[#D5D1E3] bg-white px-4 py-2 text-xs font-bold text-[#14121A] hover:border-[#4E2A84] hover:text-[#4E2A84] disabled:opacity-60 press-feedback"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Restore to Draft</span>
              </button>
            ) : (
              <button
                type="submit"
                name="intent"
                value="archived"
                disabled={pending}
                className="inline-flex items-center gap-1.5 rounded-xl border border-[#E6E3EE] bg-white px-4 py-2 text-xs font-bold text-[#6E6A7C] hover:border-[#B42318]/40 hover:text-[#B42318] disabled:opacity-60 press-feedback"
              >
                <Archive className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Archive Listing</span>
              </button>
            )}
            <DeleteListingButton
              listingId={listing.id}
              listingTitle={listing.title}
              variant="button"
              redirectTo="/seller"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="submit"
              name="intent"
              value="draft"
              disabled={pending}
              className="inline-flex items-center gap-2 rounded-xl border border-[#CFCBD9] bg-white px-4 py-2.5 text-sm font-bold text-[#14121A] hover:border-[#4E2A84] hover:text-[#4E2A84] disabled:opacity-60 press-feedback"
            >
              <FileText className="h-4 w-4" aria-hidden="true" />
              <span>{pending ? "Saving..." : "Save as Draft"}</span>
            </button>

            <button
              type="submit"
              name="intent"
              value="published"
              disabled={pending}
              className="inline-flex items-center gap-2 rounded-xl bg-[#4E2A84] px-5 py-2.5 text-sm font-bold text-white shadow-[0_2px_6px_rgba(78,42,132,0.2)] hover:bg-[#3A1E66] disabled:opacity-60 press-feedback"
            >
              <Send className="h-4 w-4" aria-hidden="true" />
              <span>{pending ? "Publishing..." : "Save & Publish"}</span>
            </button>
          </div>
        </div>
      </div>
    </form>

    {/* Live Listing Card Preview (Right Column) */}
    <ListingCardPreview
      coverUrl={previewCoverUrl}
      title={title}
      listingType={listingType}
      categoryName={previewCategoryName}
      areaName={previewAreaName}
      condition={condition}
      priceSen={previewPriceSen}
      sellerDisplayName={sellerDisplayName}
    />
    </div>

    {/* Edit Listing Success Confirmation Modal */}
    {state.status === "success" && state.message && submitCount > dismissedCount ? (
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-success-title"
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      >
        <div className="w-full max-w-md rounded-2xl border border-[#E6E3EE] bg-white p-6 shadow-xl">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#EDFAF9] text-[#0F766E]">
                <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
              </span>
              <div>
                <h2
                  id="edit-success-title"
                  className="text-base font-extrabold text-[#14121A]"
                >
                  Listing Updated!
                </h2>
                <p className="mt-0.5 text-xs text-[#6E6A7C]">{state.message}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setDismissedCount(submitCount)}
              aria-label="Close confirmation"
              className="rounded-lg p-1 text-[#6E6A7C] hover:bg-[#F5F4F8]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-5 flex flex-wrap justify-end gap-2.5">
            <button
              type="button"
              onClick={() => setDismissedCount(submitCount)}
              className="rounded-xl border border-[#E6E3EE] bg-white px-3.5 py-2 text-xs font-bold text-[#14121A] hover:border-[#4E2A84] hover:text-[#4E2A84]"
            >
              Continue Editing
            </button>
            <Link
              href="/seller"
              className="inline-flex items-center gap-1.5 rounded-xl bg-[#4E2A84] px-4 py-2 text-xs font-bold text-white hover:bg-[#3A1E66]"
            >
              <span>Back to Seller Hub</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      </div>
    ) : null}
    </>
  );
}
