"use client";

import { FoodAvailabilityFields } from "./FoodAvailabilityFields";

import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Briefcase,
  CheckCircle2,
  FileText,
  GripVertical,
  ImagePlus,
  Plus,
  Send,
  Star,
  Tag,
  Trash2,
  Utensils,
  Wrench,
  X,
} from "lucide-react";
import {
  createListingAction,
  type SellerActionState,
} from "@/app/seller/actions";
import { ListingCardPreview } from "@/components/seller/ListingCardPreview";
import { VariationsInventoryManager } from "@/components/seller/VariationsInventoryManager";
import type { CollectionAreaOption } from "@/lib/seller/data";
import type { VariantDraftInput } from "@/lib/seller/listing-edit";
import {
  MAX_LISTING_PHOTOS,
  parseRmToSen,
  validateImageFileMeta,
  type SellListingKind,
} from "@/lib/seller/validation";
import type {
  SharedListingPhotoRef,
  VariationGroupConfig,
} from "@/lib/seller/variations";
import type { Category } from "@/types/marketplace";

interface SellListingFormProps {
  categories: Category[];
  collectionAreas: CollectionAreaOption[];
  storefrontName: string | null;
  sellerDisplayName?: string;
  initialListingType?: SellListingKind;
}

interface PendingPhotoItem {
  id: string;
  file: File;
  previewUrl: string;
}

const INITIAL_STATE: SellerActionState = { status: "idle" };

const LISTING_TYPES: Array<{
  id: SellListingKind;
  label: string;
  desc: string;
  icon: typeof Tag;
  accent: string;
}> = [
  {
    id: "preloved",
    label: "Pre-Loved Item",
    desc: "Used books, gadgets, room items",
    icon: Tag,
    accent: "border-[#4E2A84] bg-[#F7F4FC] text-[#4E2A84]",
  },
  {
    id: "business",
    label: "Student Business",
    desc: "Merch, crafts, curated stock",
    icon: Briefcase,
    accent: "border-[#1D70B8] bg-[#F2F7FC] text-[#1D70B8]",
  },
  {
    id: "food",
    label: "Campus Food",
    desc: "Snacks, desserts, drinks",
    icon: Utensils,
    accent: "border-[#008386] bg-[#F2FAFA] text-[#008386]",
  },
  {
    id: "service",
    label: "Student Service",
    desc: "Tutoring, design, printing",
    icon: Wrench,
    accent: "border-[#1D70B8] bg-[#F2F7FC] text-[#1D70B8]",
  },
];

const CONDITIONS = ["New/Unused", "Like New", "Good", "Fair"];

export function SellListingForm({
  categories,
  collectionAreas,
  storefrontName,
  sellerDisplayName = "UMS Student",
  initialListingType = "preloved",
}: SellListingFormProps) {
  const [state, formAction, actionPending] = useActionState(
    createListingAction,
    INITIAL_STATE
  );
  const [isPreparing, setIsPreparing] = useState(false);
  const isSubmittingRef = useRef(false);
  const pending = actionPending || isPreparing;

  useEffect(() => {
    if (!pending) {
      isSubmittingRef.current = false;
    }
  }, [pending]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewBoxRef = useRef<HTMLDivElement | null>(null);
  const [dragPhotoIdx, setDragPhotoIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  // Live preview cover framing state (panX/panY in [-1, 1], zoom in [1, 2.5])
  const [coverZoom, setCoverZoom] = useState(1);
  const [coverPan, setCoverPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [coverNatural, setCoverNatural] = useState<{ w: number; h: number } | null>(null);
  const [previewBoxSize, setPreviewBoxSize] = useState<{ w: number; h: number }>({ w: 276, h: 207 });
  const [isDraggingCover, setIsDraggingCover] = useState(false);
  const coverDragRef = useRef<{
    startX: number;
    startY: number;
    panX: number;
    panY: number;
  } | null>(null);

  // Persistent controlled fields so switching listing type never resets user input
  const [listingType, setListingType] =
    useState<SellListingKind>(initialListingType);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [priceRm, setPriceRm] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [collectionAreaId, setCollectionAreaId] = useState(
    collectionAreas[0]?.id ?? ""
  );
  const [condition, setCondition] = useState("Like New");
  const [allowOffers, setAllowOffers] = useState(false);
  const [rulesAcknowledged, setRulesAcknowledged] = useState(false);

  // Photo state (orderable cover + reorder + remove, matching Edit Listing)
  const [photos, setPhotos] = useState<PendingPhotoItem[]>([]);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [pendingPhotoRemovalIdx, setPendingPhotoRemovalIdx] = useState<
    number | null
  >(null);

  // Variant state (supported on Student Business & Campus Food)
  const [hasVariants, setHasVariants] = useState(false);
  const [variationGroups, setVariationGroups] = useState<
    VariationGroupConfig[]
  >([{ name: "", options: [] }]);
  const [photoGroupName, setPhotoGroupName] = useState<string | null>(null);
  const [optionPhotoMap, setOptionPhotoMap] = useState<
    Record<string, string | null>
  >({});
  const [variants, setVariants] = useState<VariantDraftInput[]>([]);

  // Success popup dismissal (resets automatically per new submission)
  const [dismissedSuccessId, setDismissedSuccessId] = useState<string | null>(
    null
  );

  const isService = listingType === "service";
  const isFood = listingType === "food";
  const supportsVariants = listingType === "business" || listingType === "food";
  const supportsBargaining =
    listingType === "preloved" || listingType === "business";

  // Filter categories by listing type (service vs food vs general product)
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

  // Variant preview totals
  const activeVariants = variants.filter((v) => v.active);
  const activeVariantTotal = activeVariants.reduce(
    (sum, v) =>
      sum + Math.max(0, Number.parseInt(String(v.quantity || "0"), 10) || 0),
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

  const showSuccessModal =
    state.status === "success" &&
    Boolean(state.message) &&
    dismissedSuccessId !== (state.createdId ?? state.message ?? "done");

  function handleAddPhotos(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;

    const remaining = MAX_LISTING_PHOTOS - photos.length;
    if (remaining <= 0) {
      setPhotoError(`Maximum ${MAX_LISTING_PHOTOS} photos allowed.`);
      return;
    }

    const slice = files.slice(0, remaining);
    if (files.length > remaining) {
      setPhotoError(
        `Only ${remaining} more photo(s) added (max ${MAX_LISTING_PHOTOS}).`
      );
    } else {
      setPhotoError(null);
    }

    slice.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          setPhotos((prev) => {
            if (prev.length >= MAX_LISTING_PHOTOS) return prev;
            return [
              ...prev,
              {
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                file,
                previewUrl: reader.result as string,
              },
            ];
          });
        }
      };
      reader.readAsDataURL(file);
    });
  }

  const coverPhotoId = photos[0]?.id ?? null;

  useEffect(() => {
    setCoverZoom(1);
    setCoverPan({ x: 0, y: 0 });
    setCoverNatural(null);
  }, [coverPhotoId]);

  useEffect(() => {
    const el = previewBoxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setPreviewBoxSize({ w: rect.width, h: rect.height });
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const coverFrameMetrics = (() => {
    if (!coverNatural || coverNatural.w <= 0 || coverNatural.h <= 0) return null;
    const { w: cw, h: ch } = previewBoxSize;
    const baseScale = Math.max(cw / coverNatural.w, ch / coverNatural.h);
    const drawnW = coverNatural.w * baseScale * coverZoom;
    const drawnH = coverNatural.h * baseScale * coverZoom;
    const maxDx = Math.max(0, (drawnW - cw) / 2);
    const maxDy = Math.max(0, (drawnH - ch) / 2);
    return {
      drawnW,
      drawnH,
      maxDx,
      maxDy,
      dx: coverPan.x * maxDx,
      dy: coverPan.y * maxDy,
    };
  })();

  const isCoverAdjusted =
    coverZoom !== 1 ||
    Math.abs(coverPan.x) > 0.001 ||
    Math.abs(coverPan.y) > 0.001;

  function reorderPhoto(fromIndex: number, toIndex: number) {
    if (
      fromIndex === toIndex ||
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= photos.length ||
      toIndex >= photos.length
    ) {
      return;
    }
    setPhotos((prev) => {
      const copy = [...prev];
      const [moved] = copy.splice(fromIndex, 1);
      if (moved) copy.splice(toIndex, 0, moved);
      return copy;
    });
  }

  function handleCoverPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!photos[0] || !coverFrameMetrics) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsDraggingCover(true);
    coverDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      panX: coverPan.x,
      panY: coverPan.y,
    };
  }

  function handleCoverPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!coverDragRef.current || !coverFrameMetrics) return;
    const dx = e.clientX - coverDragRef.current.startX;
    const dy = e.clientY - coverDragRef.current.startY;
    const nextX =
      coverFrameMetrics.maxDx > 0
        ? Math.max(-1, Math.min(1, coverDragRef.current.panX + dx / coverFrameMetrics.maxDx))
        : 0;
    const nextY =
      coverFrameMetrics.maxDy > 0
        ? Math.max(-1, Math.min(1, coverDragRef.current.panY + dy / coverFrameMetrics.maxDy))
        : 0;
    setCoverPan({ x: nextX, y: nextY });
  }

  function handleCoverPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (coverDragRef.current) {
      coverDragRef.current = null;
      setIsDraggingCover(false);
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    }
  }

  async function bakeFramedCoverFile(cover: PendingPhotoItem): Promise<File> {
    if (!isCoverAdjusted) return cover.file;
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new window.Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("Image load failed"));
        el.src = cover.previewUrl;
      });
      const outW = 1200;
      const outH = 900;
      const canvas = document.createElement("canvas");
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext("2d");
      if (!ctx) return cover.file;

      const nw = img.naturalWidth || img.width;
      const nh = img.naturalHeight || img.height;
      if (nw <= 0 || nh <= 0) return cover.file;

      const baseScale = Math.max(outW / nw, outH / nh);
      const drawnW = nw * baseScale * coverZoom;
      const drawnH = nh * baseScale * coverZoom;
      const maxDx = Math.max(0, (drawnW - outW) / 2);
      const maxDy = Math.max(0, (drawnH - outH) / 2);
      const drawX = (outW - drawnW) / 2 + coverPan.x * maxDx;
      const drawY = (outH - drawnH) / 2 + coverPan.y * maxDy;

      ctx.fillStyle = "#F5F4F8";
      ctx.fillRect(0, 0, outW, outH);
      ctx.drawImage(img, drawX, drawY, drawnW, drawnH);

      const mime =
        cover.file.type === "image/png" || cover.file.type === "image/webp"
          ? cover.file.type
          : "image/jpeg";
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), mime, 0.9)
      );
      if (!blob) return cover.file;
      return new File([blob], cover.file.name, {
        type: mime,
        lastModified: Date.now(),
      });
    } catch {
      return cover.file;
    }
  }

  function movePhoto(index: number, delta: number) {
    const nextIdx = index + delta;
    if (nextIdx < 0 || nextIdx >= photos.length) return;
    setPhotos((prev) => {
      const copy = [...prev];
      const [moved] = copy.splice(index, 1);
      if (moved) copy.splice(nextIdx, 0, moved);
      return copy;
    });
  }

  function makeCoverPhoto(index: number) {
    if (index <= 0 || index >= photos.length) return;
    setPhotos((prev) => {
      const copy = [...prev];
      const [chosen] = copy.splice(index, 1);
      if (chosen) copy.unshift(chosen);
      return copy;
    });
  }

  function getAssignedPhotoOptions(photoKey: string): string[] {
    return Object.entries(optionPhotoMap)
      .filter(([, mappedKey]) => mappedKey === photoKey)
      .map(([option]) => option);
  }

  function removePhotoConfirmed(index: number) {
    const target = photos[index];
    setPhotoError(null);
    setPendingPhotoRemovalIdx(null);
    setPhotos((prev) => prev.filter((_, i) => i !== index));
    if (target) {
      setOptionPhotoMap((prev) => {
        let changed = false;
        const next: Record<string, string | null> = {};
        for (const [k, v] of Object.entries(prev)) {
          if (v === target.id) {
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
          row.imagePath === target.id ? { ...row, imagePath: null } : row
        )
      );
    }
  }

  function removePhoto(index: number) {
    const target = photos[index];
    if (!target) return;
    if (hasVariants && supportsVariants) {
      const assigned = getAssignedPhotoOptions(target.id);
      if (assigned.length > 0) {
        setPendingPhotoRemovalIdx(index);
        return;
      }
    }
    removePhotoConfirmed(index);
  }

  async function handleUploadSharedPhoto(
    file: File
  ): Promise<SharedListingPhotoRef | null> {
    const metaCheck = validateImageFileMeta(file);
    if (!metaCheck.ok) {
      setPhotoError(metaCheck.error);
      return null;
    }
    if (photos.length >= MAX_LISTING_PHOTOS) {
      setPhotoError(`Maximum ${MAX_LISTING_PHOTOS} photos reached.`);
      return null;
    }
    const previewUrl = await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () =>
        resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
    if (!previewUrl) {
      setPhotoError("Failed to read uploaded photo.");
      return null;
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setPhotoError(null);
    setPhotos((prev) => {
      if (prev.length >= MAX_LISTING_PHOTOS) return prev;
      return [...prev, { id, file, previewUrl }];
    });
    return {
      key: id,
      url: previewUrl,
      storagePath: null,
    };
  }

  const sharedPhotos: SharedListingPhotoRef[] = photos.map((p) => ({
    key: p.id,
    url: p.previewUrl,
    storagePath: null,
  }));

  const serializedOptionGroups = variationGroups
    .map((g) => g.name.trim())
    .filter((name) => name.length > 0);

  async function handleFormAction(formData: FormData) {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setIsPreparing(true);
    try {
      // Replace file input entries with the exact reordered photos state (baking any cover framing)
      formData.delete("photos");
      for (let i = 0; i < photos.length; i += 1) {
        const p = photos[i]!;
        const fileToUpload = i === 0 ? await bakeFramedCoverFile(p) : p.file;
        formData.append("photos", fileToUpload);
      }
      formData.set("photoKeysJson", JSON.stringify(photos.map((p) => p.id)));
      formData.set("hasVariants", hasVariants && supportsVariants ? "on" : "");
      formData.set("variationPhotoGroup", photoGroupName ?? "");
      formData.set("optionGroupsJson", JSON.stringify(serializedOptionGroups));
      formData.set("variantsJson", JSON.stringify(variants));
      formData.set("categoryId", effectiveCategoryId);
      setDismissedSuccessId(null);
      // Dispatch inside startTransition because async cover framing runs across await boundaries
      startTransition(() => {
        formAction(formData);
      });
    } finally {
      setIsPreparing(false);
    }
  }

  function resetFormForAnother() {
    setTitle("");
    setDescription("");
    setPriceRm("");
    setQuantity("1");
    setAllowOffers(false);
    setRulesAcknowledged(false);
    setPhotos([]);
    setPhotoError(null);
    setPendingPhotoRemovalIdx(null);
    setHasVariants(false);
    setVariationGroups([{ name: "", options: [] }]);
    setPhotoGroupName(null);
    setOptionPhotoMap({});
    setVariants([]);
    setDismissedSuccessId(state.createdId ?? state.message ?? "done");
  }

  return (
    <>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_310px] lg:items-start">
        <form
          action={handleFormAction}
          className="rounded-2xl border border-[#E6E3EE] bg-white p-5 shadow-[0_2px_10px_rgba(20,18,26,0.04)] sm:p-7"
        >
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
          <input
            type="hidden"
            name="variationPhotoGroup"
            value={photoGroupName ?? ""}
          />
          <input
            type="hidden"
            name="photoKeysJson"
            value={JSON.stringify(photos.map((p) => p.id))}
          />

          {!storefrontName ? (
            <div className="mb-5 rounded-xl border border-[#00A3A6]/35 bg-[#F2FAFA] px-4 py-3 text-xs text-[#007D80] sm:text-sm">
              Your campus storefront will be initialized automatically when you
              save or publish your first listing.
            </div>
          ) : null}

          {state.status === "error" && state.message ? (
            <div
              role="alert"
              className="mb-5 rounded-xl border border-[#BA1A1A]/30 bg-[#FDF2F2] px-4 py-3 text-sm font-medium text-[#BA1A1A]"
            >
              {state.message}
            </div>
          ) : null}

          {/* Step 1: Listing Type */}
          <fieldset>
            <legend className="text-sm font-extrabold text-[#14121A]">
              1. What are you listing? <span className="text-[#BA1A1A]">*</span>
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
                      if (type.id !== "business" && type.id !== "food") {
                        setHasVariants(false);
                      }
                    }}
                    aria-pressed={active}
                    className={`flex items-start gap-3 rounded-xl border p-3.5 text-left transition-all press-feedback ${
                      active
                        ? `${type.accent} shadow-xs`
                        : "border-[#E6E3EE] bg-white text-[#14121A] hover:border-[#CFCBD9] hover:bg-[#FAF9FC]"
                    }`}
                  >
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white shadow-xs">
                      <Icon className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[13.5px] font-extrabold leading-tight">
                        {type.label}
                      </span>
                      <span className="mt-0.5 block text-[11.5px] text-[#6E6A7C]">
                        {type.desc}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          {/* Step 2: Core Details */}
          <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-2">
            <div className="lg:col-span-2">
              <label
                htmlFor="title"
                className="block text-sm font-bold text-[#14121A]"
              >
                Listing Title <span className="text-[#BA1A1A]">*</span>
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
                placeholder={
                  isService
                    ? "e.g. Canva Poster & Presentation Design for UMS Clubs"
                    : "e.g. Casio FX-570EX Scientific Calculator"
                }
                className="mt-1.5 w-full rounded-xl border border-[#CFCBD9] bg-white px-3.5 py-2.5 text-sm text-[#14121A] placeholder:text-[#858094] focus:border-[#4E2A84] focus:outline-none"
              />
            </div>

            <div>
              <label
                htmlFor="categoryId"
                className="block text-sm font-bold text-[#14121A]"
              >
                Category <span className="text-[#BA1A1A]">*</span>
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
                    <label
                      htmlFor="collectionAreaId"
                      className="block text-sm font-bold text-[#14121A]"
                    >
                      Campus Collection Area{" "}
                      <span className="text-[#BA1A1A]">*</span>
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
                      <label
                        htmlFor="condition"
                        className="block text-sm font-bold text-[#14121A]"
                      >
                        Item Condition <span className="text-[#BA1A1A]">*</span>
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
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="priceRm"
                      className="block text-sm font-bold text-[#14121A]"
                    >
                      Price (RM) <span className="text-[#BA1A1A]">*</span>
                    </label>
                    <div className="relative mt-1.5">
                      <span className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-xs font-extrabold text-[#6E6A7C]">
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
                        placeholder="15.00"
                        className="w-full rounded-xl border border-[#CFCBD9] bg-white py-2.5 pr-3.5 pl-10 text-sm font-bold text-[#14121A] placeholder:font-normal placeholder:text-[#858094] focus:border-[#4E2A84] focus:outline-none"
                      />
                    </div>
                    {parsedPrice ? (
                      <p
                        className={`mt-1 text-[11px] font-semibold ${
                          parsedPrice.ok ? "text-[#008386]" : "text-[#BA1A1A]"
                        }`}
                      >
                        {parsedPrice.ok
                          ? `Stored as RM ${(parsedPrice.sen / 100).toFixed(2)}`
                          : parsedPrice.error}
                      </p>
                    ) : null}
                  </div>

                  {!isService ? (
                    <div>
                      <label
                        htmlFor="quantity"
                        className="block text-sm font-bold text-[#14121A]"
                      >
                        Quantity <span className="text-[#BA1A1A]">*</span>
                      </label>
                      <input
                        id="quantity"
                        name="quantity"
                        type="number"
                        min={1}
                        max={999}
                        value={quantity}
                        onChange={(e) => setQuantity(e.target.value)}
                        required
                        className="mt-1.5 w-full rounded-xl border border-[#CFCBD9] bg-white px-3.5 py-2.5 text-sm font-bold text-[#14121A] focus:border-[#4E2A84] focus:outline-none"
                      />
                    </div>
                  ) : (
                    <input type="hidden" name="quantity" value="1" />
                  )}
                </div>

                {/* Collection Area & Condition */}
                <div>
                  <label
                    htmlFor="collectionAreaId"
                    className="block text-sm font-bold text-[#14121A]"
                  >
                    Campus Collection Area{" "}
                    {!isService ? (
                      <span className="text-[#BA1A1A]">*</span>
                    ) : (
                      "(optional)"
                    )}
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
                    <label
                      htmlFor="condition"
                      className="block text-sm font-bold text-[#14121A]"
                    >
                      Item Condition <span className="text-[#BA1A1A]">*</span>
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

            {isFood && <FoodAvailabilityFields />}

            {/* Description */}
            <div className="lg:col-span-2">
              <label
                htmlFor="description"
                className="block text-sm font-bold text-[#14121A]"
              >
                Description <span className="text-[#BA1A1A]">*</span>
              </label>
              <textarea
                id="description"
                name="description"
                rows={4}
                minLength={20}
                maxLength={3000}
                required
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe item details, specs, any wear or defects, or service scope and turnaround notes."
                className="mt-1.5 w-full rounded-xl border border-[#CFCBD9] bg-white px-3.5 py-2.5 text-sm text-[#14121A] placeholder:text-[#858094] focus:border-[#4E2A84] focus:outline-none"
              />
              <p className="mt-1 text-xs text-[#6E6A7C]">
                Between 20 and 3,000 characters required for drafts and
                published listings.
              </p>
            </div>

            {/* Variations & Inventory (Student Business & Campus Food) */}
            {supportsVariants ? (
              <div className="lg:col-span-2">
                <VariationsInventoryManager
                  enabled={hasVariants}
                  onToggleEnabled={setHasVariants}
                  groups={variationGroups}
                  variants={variants}
                  photoGroupName={photoGroupName}
                  optionPhotoMap={optionPhotoMap}
                  sharedPhotos={sharedPhotos}
                  defaultPriceRm={priceRm || "15.00"}
                  onChangeState={(next) => {
                    setVariationGroups(next.groups);
                    setVariants(next.variants);
                    setPhotoGroupName(next.photoGroupName);
                    setOptionPhotoMap(next.optionPhotoMap);
                  }}
                  onUploadSharedPhoto={handleUploadSharedPhoto}
                />
              </div>
            ) : null}

            {/* Photos (matches Edit Listing layout with COVER badge, reorder & delete) */}
            <div className="lg:col-span-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <label className="block text-sm font-bold text-[#14121A]">
                    Listing Photos ({photos.length}/{MAX_LISTING_PHOTOS})
                  </label>
                  <p className="mt-0.5 text-xs text-[#6E6A7C]">
                    The first photo is your cover image. Reorder, set cover, or
                    add up to {MAX_LISTING_PHOTOS} photos total.
                  </p>
                </div>
                {photos.length < MAX_LISTING_PHOTOS ? (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-[#4E2A84]/40 bg-[#FAF9FC] px-3.5 py-2 text-xs font-bold text-[#4E2A84] hover:bg-[#F3EEFA] press-feedback"
                  >
                    <ImagePlus className="h-4 w-4" aria-hidden="true" />
                    <span>Add Photos</span>
                  </button>
                ) : null}
              </div>

              <input
                ref={fileInputRef}
                id="photos"
                name="photos"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                onChange={handleAddPhotos}
                className="sr-only"
              />

              {photoError ? (
                <p className="mt-2 text-xs font-semibold text-[#BA1A1A]">
                  {photoError}
                </p>
              ) : null}

              {pendingPhotoRemovalIdx !== null &&
              photos[pendingPhotoRemovalIdx] ? (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900">
                  <div className="flex items-start gap-2">
                    <AlertTriangle
                      className="mt-0.5 h-4 w-4 shrink-0 text-amber-700"
                      aria-hidden="true"
                    />
                    <span>
                      Photo #{pendingPhotoRemovalIdx + 1} is currently assigned
                      to variation option{" "}
                      <strong>
                        {getAssignedPhotoOptions(
                          photos[pendingPhotoRemovalIdx]!.id
                        ).join(", ")}
                      </strong>
                      . Removing it will clear those variation photos.
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setPendingPhotoRemovalIdx(null)}
                      className="rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-bold text-amber-900 hover:bg-amber-100"
                    >
                      Keep Photo
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        removePhotoConfirmed(pendingPhotoRemovalIdx)
                      }
                      className="rounded-lg bg-[#B42318] px-2.5 py-1 text-[11px] font-bold text-white hover:bg-[#991B1B]"
                    >
                      Remove Photo
                    </button>
                  </div>
                </div>
              ) : null}

              {photos.length > 0 ? (
                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {photos.map((photo, idx) => (
                    <div
                      key={photo.id}
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
                      className={`cursor-grab overflow-hidden rounded-xl border bg-white shadow-xs transition active:cursor-grabbing ${
                        dragOverIdx === idx && dragPhotoIdx !== idx
                          ? "border-[#4E2A84] ring-2 ring-[#4E2A84]/30"
                          : "border-[#E6E3EE]"
                      } ${dragPhotoIdx === idx ? "opacity-55" : ""}`}
                    >
                      <div className="relative aspect-[4/3] w-full bg-[#F5F4F8]">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={photo.previewUrl}
                          alt={`Listing photo ${idx + 1}`}
                          draggable={false}
                          className="h-full w-full object-cover select-none"
                        />
                        {idx === 0 ? (
                          <span className="absolute top-2 left-2 rounded-md bg-white/95 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-[#4E2A84] shadow-xs">
                            COVER
                          </span>
                        ) : null}
                        <span
                          title="Drag to reorder"
                          className="absolute top-2 right-2 flex h-6 w-6 items-center justify-center rounded-md bg-white/85 text-[#555062] shadow-xs backdrop-blur-xs"
                        >
                          <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
                        </span>
                      </div>
                      <div className="flex items-center justify-between border-t border-[#F0EDF5] px-2.5 py-1.5 text-xs">
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => movePhoto(idx, -1)}
                            disabled={idx === 0}
                            aria-label="Move photo left"
                            className="rounded p-1 text-[#555062] hover:bg-[#F4F1FA] disabled:opacity-30"
                          >
                            <ArrowLeft className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => movePhoto(idx, 1)}
                            disabled={idx === photos.length - 1}
                            aria-label="Move photo right"
                            className="rounded p-1 text-[#555062] hover:bg-[#F4F1FA] disabled:opacity-30"
                          >
                            <ArrowRight className="h-3.5 w-3.5" />
                          </button>
                          {idx > 0 ? (
                            <button
                              type="button"
                              onClick={() => makeCoverPhoto(idx)}
                              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-bold text-[#4E2A84] hover:bg-[#F4F1FA]"
                            >
                              <Star className="h-3 w-3" />
                              <span>Cover</span>
                            </button>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          onClick={() => removePhoto(idx)}
                          aria-label="Remove photo"
                          className="rounded p-1 text-[#6E6A7C] hover:bg-[#FDF2F2] hover:text-[#B42318]"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="mt-3 flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[#CFCBD9] bg-[#FAFAFC] px-4 py-7 text-center transition-colors hover:border-[#4E2A84]/60 hover:bg-[#F7F4FC]"
                >
                  <ImagePlus
                    className="h-7 w-7 text-[#4E2A84]"
                    aria-hidden="true"
                  />
                  <span className="text-xs font-bold text-[#14121A]">
                    Click to upload up to {MAX_LISTING_PHOTOS} JPG, PNG, or WEBP
                    photos (max 5 MB each)
                  </span>
                </button>
              )}
            </div>
          </div>

          {/* Rules & Bargaining Toggles */}
          <div className="mt-6 space-y-3 border-t border-[#F0EDF5] pt-5">
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
                checked={rulesAcknowledged}
                onChange={(e) => setRulesAcknowledged(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-[#CFCBD9] accent-[#008386]"
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

          {/* Actions */}
          <div className="mt-6 flex flex-wrap items-center justify-end gap-3 border-t border-[#F0EDF5] pt-5">
            <button
              type="submit"
              name="intent"
              value="draft"
              disabled={pending}
              className="inline-flex items-center gap-2 rounded-xl border border-[#CFCBD9] bg-white px-4 py-2.5 text-sm font-bold text-[#14121A] transition-colors hover:border-[#4E2A84] hover:text-[#4E2A84] disabled:opacity-60 press-feedback"
            >
              <FileText className="h-4 w-4" aria-hidden="true" />
              <span>{pending ? "Saving..." : "Save as Draft"}</span>
            </button>

            <button
              type="submit"
              name="intent"
              value="published"
              disabled={pending}
              className="inline-flex items-center gap-2 rounded-xl bg-[#4E2A84] px-5 py-2.5 text-sm font-bold text-white shadow-[0_2px_8px_rgba(78,42,132,0.28)] transition-colors hover:bg-[#3A1E66] disabled:opacity-60 press-feedback"
            >
              <Send className="h-4 w-4" aria-hidden="true" />
              <span>{pending ? "Publishing..." : "Publish Listing"}</span>
            </button>
          </div>
        </form>

        {/* Live Listing Card Preview (Right Column) */}
        <ListingCardPreview
          coverUrl={photos[0]?.previewUrl ?? null}
          title={title}
          listingType={listingType}
          categoryName={previewCategoryName}
          areaName={previewAreaName}
          condition={condition}
          priceSen={previewPriceSen}
          sellerDisplayName={sellerDisplayName}
          coverFraming={{
            previewBoxRef,
            isDraggingCover,
            coverZoom,
            isCoverAdjusted,
            coverFrameMetrics,
            onPointerDown: handleCoverPointerDown,
            onPointerMove: handleCoverPointerMove,
            onPointerUp: handleCoverPointerUp,
            onImageLoad: (w, h) => setCoverNatural({ w, h }),
            onZoomChange: setCoverZoom,
            onReset: () => {
              setCoverZoom(1);
              setCoverPan({ x: 0, y: 0 });
            },
          }}
        />
      </div>

      {/* Create Listing Success Confirmation Modal */}
      {showSuccessModal ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-success-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
        >
          <div className="w-full max-w-md rounded-2xl border border-[#E6E3EE] bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#EDFAF9] text-[#008386]">
                  <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
                </span>
                <div>
                  <h2
                    id="create-success-title"
                    className="text-base font-extrabold text-[#14121A]"
                  >
                    Listing Saved!
                  </h2>
                  <p className="mt-0.5 text-xs text-[#6E6A7C]">
                    {state.message}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() =>
                  setDismissedSuccessId(
                    state.createdId ?? state.message ?? "done"
                  )
                }
                aria-label="Close confirmation"
                className="rounded-lg p-1 text-[#6E6A7C] hover:bg-[#F5F4F8]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-5 flex flex-wrap justify-end gap-2.5">
              <button
                type="button"
                onClick={resetFormForAnother}
                className="rounded-xl border border-[#E6E3EE] bg-white px-3.5 py-2 text-xs font-bold text-[#14121A] hover:border-[#4E2A84] hover:text-[#4E2A84]"
              >
                Create Another
              </button>
              {state.createdId ? (
                <Link
                  href={`/sell/${encodeURIComponent(state.createdId)}`}
                  className="rounded-xl border border-[#4E2A84] bg-white px-3.5 py-2 text-xs font-bold text-[#4E2A84] hover:bg-[#F7F4FC]"
                >
                  Edit Listing
                </Link>
              ) : null}
              <Link
                href="/seller"
                className="inline-flex items-center gap-1.5 rounded-xl bg-[#4E2A84] px-4 py-2 text-xs font-bold text-white hover:bg-[#3A1E66]"
              >
                <span>Seller Hub</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
