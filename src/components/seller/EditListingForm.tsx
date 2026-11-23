"use client";

import { useActionState, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Briefcase,
  CheckCircle2,
  ExternalLink,
  FileText,
  ImagePlus,
  Lock,
  Plus,
  RotateCcw,
  Send,
  Star,
  Tag,
  Trash2,
  Utensils,
  Wrench,
} from "lucide-react";
import {
  updateListingAction,
  type SellerActionState,
} from "@/app/seller/actions";
import type {
  CollectionAreaOption,
  EditablePhotoItem,
  SellerListingDetail,
} from "@/lib/seller/data";
import type { VariantDraftInput } from "@/lib/seller/listing-edit";
import { MAX_LISTING_PHOTOS, parseRmToSen, type SellListingKind } from "@/lib/seller/validation";
import type { Category } from "@/types/marketplace";

interface EditListingFormProps {
  listing: SellerListingDetail;
  categories: Category[];
  collectionAreas: CollectionAreaOption[];
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
}: EditListingFormProps) {
  const [state, formAction, pending] = useActionState(
    updateListingAction,
    INITIAL_STATE
  );

  const [listingType, setListingType] = useState<SellListingKind>(
    listing.listingType
  );
  const [priceRm, setPriceRm] = useState((listing.priceSen / 100).toFixed(2));
  const [quantity, setQuantity] = useState(String(listing.quantity));
  const [keptPhotos, setKeptPhotos] = useState<EditablePhotoItem[]>(
    listing.photos
  );
  const [newPhotoPreviews, setNewPhotoPreviews] = useState<string[]>([]);

  // Variant state
  const [hasVariants, setHasVariants] = useState(listing.hasVariants);
  const [optionGroups, setOptionGroups] = useState<string[]>(
    listing.optionGroups.length > 0 ? listing.optionGroups : ["Option"]
  );
  const [variants, setVariants] = useState<VariantDraftInput[]>(
    listing.variants.length > 0
      ? listing.variants.map((v) => ({
          id: v.id,
          optionValues: v.optionValues,
          priceRm: (v.priceSen / 100).toFixed(2),
          quantity: String(v.quantity),
          active: v.active,
        }))
      : []
  );

  const lockedSet = new Set(listing.lockedVariantIds);
  const reservedByVariant = new Map(
    listing.variants.map((v) => [v.id, v.reservedQuantity])
  );

  const isService = listingType === "service";
  const filteredCategories = categories.filter((c) =>
    isService ? c.kind === "service" : c.kind !== "service"
  );
  const selectableCategories =
    filteredCategories.length > 0 ? filteredCategories : categories;

  const parsedPrice = priceRm.trim() ? parseRmToSen(priceRm) : null;
  const maxNewPhotos = Math.max(0, MAX_LISTING_PHOTOS - keptPhotos.length);
  const st = statusDisplayText(
    listing.status,
    listing.availableStock,
    isService
  );

  // Aggregate variant stock preview
  const activeVariantTotal = variants
    .filter((v) => v.active)
    .reduce((sum, v) => sum + Math.max(0, Number.parseInt(String(v.quantity || "0"), 10) || 0), 0);

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

  function removePhoto(index: number) {
    setKeptPhotos((prev) => prev.filter((_, i) => i !== index));
  }

  function handleNewPhotosChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).slice(0, maxNewPhotos);
    if (files.length === 0) {
      setNewPhotoPreviews([]);
      return;
    }
    const urls: string[] = [];
    let loaded = 0;
    files.forEach((file, idx) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") urls[idx] = reader.result;
        loaded += 1;
        if (loaded === files.length) setNewPhotoPreviews(urls.filter(Boolean));
      };
      reader.readAsDataURL(file);
    });
  }

  function addVariantRow() {
    const blankValues: Record<string, string> = {};
    for (const g of optionGroups) blankValues[g] = "";
    setVariants((prev) => [
      ...prev,
      {
        optionValues: blankValues,
        priceRm: priceRm || "15.00",
        quantity: "1",
        active: true,
      },
    ]);
  }

  function updateVariantField(
    idx: number,
    patch: Partial<VariantDraftInput>
  ) {
    setVariants((prev) =>
      prev.map((row, i) => (i === idx ? { ...row, ...patch } : row))
    );
  }

  function updateVariantOptionValue(idx: number, group: string, value: string) {
    setVariants((prev) =>
      prev.map((row, i) =>
        i === idx
          ? { ...row, optionValues: { ...row.optionValues, [group]: value } }
          : row
      )
    );
  }

  function removeVariantRow(idx: number) {
    const row = variants[idx];
    if (row?.id && lockedSet.has(row.id)) return;
    setVariants((prev) => prev.filter((_, i) => i !== idx));
  }

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="listingId" value={listing.id} />
      <input type="hidden" name="expectedUpdatedAt" value={listing.updatedAt} />
      <input
        type="hidden"
        name="keptPhotoPaths"
        value={JSON.stringify(keptPhotos.map((p) => p.path))}
      />
      <input
        type="hidden"
        name="optionGroupsJson"
        value={JSON.stringify(optionGroups)}
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
                  onClick={() => setListingType(type.id)}
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
              defaultValue={listing.title}
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
              defaultValue={
                selectableCategories.some((c) => c.id === listing.categoryId)
                  ? listing.categoryId
                  : (selectableCategories[0]?.id ?? "")
              }
              key={listingType}
              className="mt-1.5 w-full rounded-xl border border-[#CFCBD9] bg-white px-3.5 py-2.5 text-sm text-[#14121A] focus:border-[#4E2A84] focus:outline-none"
            >
              {selectableCategories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}
                </option>
              ))}
            </select>
          </div>

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
                  required={!hasVariants}
                  disabled={hasVariants && !isService}
                  value={priceRm}
                  onChange={(e) => setPriceRm(e.target.value)}
                  className="w-full rounded-xl border border-[#CFCBD9] bg-white py-2.5 pr-3 pl-9 text-sm font-bold text-[#14121A] disabled:bg-[#FAFAFC] disabled:text-[#6E6A7C] focus:border-[#4E2A84] focus:outline-none"
                />
              </div>
              {hasVariants && !isService ? (
                <p className="mt-1 text-[11px] text-[#6E6A7C]">
                  Auto-set from lowest active variant
                </p>
              ) : parsedPrice ? (
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
                  disabled={hasVariants}
                  value={hasVariants ? String(activeVariantTotal) : quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  className="mt-1.5 w-full rounded-xl border border-[#CFCBD9] bg-white px-3.5 py-2.5 text-sm font-bold text-[#14121A] disabled:bg-[#FAFAFC] disabled:text-[#6E6A7C] focus:border-[#4E2A84] focus:outline-none"
                />
                <p className="mt-1 text-[11px] text-[#6E6A7C]">
                  {hasVariants
                    ? "Sum of active variants"
                    : listing.reservedQuantity > 0
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
              defaultValue={listing.collectionAreaId}
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

          {!isService ? (
            <div>
              <label htmlFor="condition" className="block text-sm font-bold text-[#14121A]">
                Item Condition <span className="text-[#B42318]">*</span>
              </label>
              <select
                id="condition"
                name="condition"
                required
                defaultValue={listing.condition || "Like New"}
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

          <div className="lg:col-span-2">
            <label htmlFor="description" className="block text-sm font-bold text-[#14121A]">
              Description <span className="text-[#B42318]">*</span>
            </label>
            <textarea
              id="description"
              name="description"
              rows={4}
              maxLength={2000}
              defaultValue={listing.description}
              className="mt-1.5 w-full rounded-xl border border-[#CFCBD9] bg-white px-3.5 py-2.5 text-sm text-[#14121A] focus:border-[#4E2A84] focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* Product Variants Section (Physical Goods Only) */}
      {!isService ? (
        <div className="rounded-2xl border border-[#E6E3EE] bg-white p-5 shadow-[0_1px_4px_rgba(20,18,26,0.03)] sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-extrabold italic text-[#14121A]">
                Product Variants &amp; Inventory
              </h2>
              <p className="mt-0.5 text-xs text-[#6E6A7C]">
                Add sizes, colors, or editions with individual RM prices and
                stock counts.
              </p>
            </div>
            <label className="inline-flex items-center gap-2 text-xs font-bold text-[#14121A]">
              <input
                type="checkbox"
                name="hasVariants"
                checked={hasVariants}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setHasVariants(checked);
                  if (checked && variants.length === 0) {
                    addVariantRow();
                  }
                }}
                className="h-4 w-4 rounded border-[#CFCBD9] accent-[#4E2A84]"
              />
              <span>Enable Variants</span>
            </label>
          </div>

          {hasVariants ? (
            <div className="mt-4 space-y-4 border-t border-[#F0EDF5] pt-4">
              {/* Option Group Name */}
              <div className="flex flex-wrap items-end gap-3">
                {optionGroups.map((group, gIdx) => (
                  <div key={gIdx} className="w-44">
                    <label className="block text-xs font-bold text-[#555062]">
                      Option Group #{gIdx + 1}
                    </label>
                    <input
                      type="text"
                      value={group}
                      onChange={(e) => {
                        const oldName = optionGroups[gIdx] ?? "";
                        const newName = e.target.value;
                        setOptionGroups((prev) =>
                          prev.map((g, idx) => (idx === gIdx ? newName : g))
                        );
                        setVariants((prev) =>
                          prev.map((v) => {
                            const nextVals = { ...v.optionValues };
                            if (oldName in nextVals && oldName !== newName) {
                              nextVals[newName] = nextVals[oldName] ?? "";
                              delete nextVals[oldName];
                            }
                            return { ...v, optionValues: nextVals };
                          })
                        );
                      }}
                      placeholder="e.g. Size"
                      className="mt-1 w-full rounded-lg border border-[#CFCBD9] px-3 py-1.5 text-xs font-semibold text-[#14121A] focus:border-[#4E2A84] focus:outline-none"
                    />
                  </div>
                ))}
                {optionGroups.length < 2 ? (
                  <button
                    type="button"
                    onClick={() => setOptionGroups((prev) => [...prev, "Color"])}
                    className="rounded-lg border border-[#D5D1E3] px-3 py-1.5 text-xs font-bold text-[#4E2A84] hover:border-[#4E2A84]"
                  >
                    + Add 2nd Option
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setOptionGroups((prev) => prev.slice(0, 1))}
                    className="rounded-lg border border-[#E6E3EE] px-3 py-1.5 text-xs font-semibold text-[#6E6A7C] hover:text-[#B42318]"
                  >
                    Remove 2nd Option
                  </button>
                )}
              </div>

              {/* Variant Rows */}
              <div className="space-y-2.5">
                {variants.map((variant, idx) => {
                  const isLocked = Boolean(
                    variant.id && lockedSet.has(variant.id)
                  );
                  const reserved =
                    (variant.id && reservedByVariant.get(variant.id)) || 0;
                  return (
                    <div
                      key={variant.id ?? `new-${idx}`}
                      className="grid grid-cols-1 gap-2.5 rounded-xl border border-[#ECEAF2] bg-[#FAFAFC] p-3 sm:grid-cols-12 sm:items-end"
                    >
                      {optionGroups.map((group) => (
                        <div
                          key={group}
                          className={
                            optionGroups.length === 1
                              ? "sm:col-span-4"
                              : "sm:col-span-2"
                          }
                        >
                          <label className="block text-[11px] font-bold text-[#555062]">
                            {group || "Option"}
                          </label>
                          <input
                            type="text"
                            value={variant.optionValues[group] ?? ""}
                            onChange={(e) =>
                              updateVariantOptionValue(idx, group, e.target.value)
                            }
                            placeholder={`e.g. Medium`}
                            className="mt-1 w-full rounded-lg border border-[#CFCBD9] bg-white px-2.5 py-1.5 text-xs text-[#14121A] focus:border-[#4E2A84] focus:outline-none"
                          />
                        </div>
                      ))}

                      <div className="sm:col-span-3">
                        <label className="block text-[11px] font-bold text-[#555062]">
                          Price (RM)
                        </label>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={variant.priceRm}
                          onChange={(e) =>
                            updateVariantField(idx, { priceRm: e.target.value })
                          }
                          className="mt-1 w-full rounded-lg border border-[#CFCBD9] bg-white px-2.5 py-1.5 text-xs font-bold text-[#14121A] focus:border-[#4E2A84] focus:outline-none"
                        />
                      </div>

                      <div className="sm:col-span-2">
                        <label className="block text-[11px] font-bold text-[#555062]">
                          Qty {reserved > 0 ? `(min ${reserved})` : ""}
                        </label>
                        <input
                          type="number"
                          min={reserved}
                          max={999}
                          value={variant.quantity}
                          onChange={(e) =>
                            updateVariantField(idx, { quantity: e.target.value })
                          }
                          className="mt-1 w-full rounded-lg border border-[#CFCBD9] bg-white px-2.5 py-1.5 text-xs font-bold text-[#14121A] focus:border-[#4E2A84] focus:outline-none"
                        />
                      </div>

                      <div className="flex items-center justify-between gap-2 sm:col-span-3 sm:justify-end">
                        <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#14121A]">
                          <input
                            type="checkbox"
                            checked={variant.active}
                            onChange={(e) =>
                              updateVariantField(idx, {
                                active: e.target.checked,
                              })
                            }
                            className="h-3.5 w-3.5 accent-[#0F766E]"
                          />
                          <span
                            className={
                              variant.active
                                ? "text-[#0F766E]"
                                : "text-[#6E6A7C]"
                            }
                          >
                            {variant.active ? "Active" : "Inactive"}
                          </span>
                        </label>

                        {isLocked ? (
                          <span
                            title="Referenced by an active order or reservation — deactivate instead of removing"
                            className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#6E6A7C]"
                          >
                            <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                            <span>Locked</span>
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => removeVariantRow(idx)}
                            aria-label={`Remove variant ${idx + 1}`}
                            className="rounded-lg p-1.5 text-[#6E6A7C] hover:text-[#B42318]"
                          >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={addVariantRow}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#4E2A84] bg-white px-3.5 py-1.5 text-xs font-bold text-[#4E2A84] hover:bg-[#4E2A84] hover:text-white press-feedback"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Add Variant</span>
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Listing Photos Manager */}
      <div className="rounded-2xl border border-[#E6E3EE] bg-white p-5 shadow-[0_1px_4px_rgba(20,18,26,0.03)] sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-extrabold italic text-[#14121A]">
              Listing Photos ({keptPhotos.length + newPhotoPreviews.length}/
              {MAX_LISTING_PHOTOS})
            </h2>
            <p className="mt-0.5 text-xs text-[#6E6A7C]">
              The first photo is your cover image. Reorder, replace cover, or
              add up to {MAX_LISTING_PHOTOS} photos total.
            </p>
          </div>
        </div>

        {keptPhotos.length > 0 ? (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {keptPhotos.map((photo, idx) => (
              <div
                key={photo.path}
                className="overflow-hidden rounded-xl border border-[#E6E3EE] bg-[#FAFAFC]"
              >
                <div className="relative aspect-[4/3] w-full bg-[#F5F4F8]">
                  <Image
                    src={photo.url}
                    alt={`Listing photo ${idx + 1}`}
                    fill
                    unoptimized
                    sizes="220px"
                    className="object-cover"
                  />
                  {idx === 0 ? (
                    <span className="absolute top-2 left-2 rounded-md bg-white/95 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-[#4E2A84]">
                      Cover
                    </span>
                  ) : null}
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
            {newPhotoPreviews.length > 0 ? (
              <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                {newPhotoPreviews.map((src, i) => (
                  <div
                    key={i}
                    className="relative aspect-[4/3] overflow-hidden rounded-xl border border-[#E6E3EE] bg-[#F5F4F8]"
                  >
                    <Image
                      src={src}
                      alt={`New photo preview ${i + 1}`}
                      fill
                      unoptimized
                      sizes="160px"
                      className="object-cover"
                    />
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
          <label className="flex items-start gap-2.5 text-sm text-[#14121A]">
            <input
              type="checkbox"
              name="allowOffers"
              defaultChecked={listing.allowOffers}
              className="mt-0.5 h-4 w-4 rounded border-[#CFCBD9] accent-[#4E2A84]"
            />
            <span>
              <span className="font-bold">Allow buyer price offers</span>{" "}
              <span className="text-xs text-[#6E6A7C]">(optional)</span>
            </span>
          </label>

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
  );
}
