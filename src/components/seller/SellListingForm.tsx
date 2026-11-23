"use client";

import { useActionState, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  Briefcase,
  CheckCircle2,
  FileText,
  ImagePlus,
  Send,
  Tag,
  Utensils,
  Wrench,
} from "lucide-react";
import {
  createListingAction,
  type SellerActionState,
} from "@/app/seller/actions";
import type { CollectionAreaOption } from "@/lib/seller/data";
import { parseRmToSen, type SellListingKind } from "@/lib/seller/validation";
import type { Category } from "@/types/marketplace";

interface SellListingFormProps {
  categories: Category[];
  collectionAreas: CollectionAreaOption[];
  storefrontName: string | null;
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
    desc: "Textbooks, tech, dorm gear",
    icon: Tag,
    accent: "border-[#4E2A84] bg-[#F8F6FD] text-[#4E2A84]",
  },
  {
    id: "business",
    label: "Student Business",
    desc: "Handmade goods, merch, crafts",
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
}: SellListingFormProps) {
  const [state, formAction, pending] = useActionState(
    createListingAction,
    INITIAL_STATE
  );
  const [listingType, setListingType] = useState<SellListingKind>("preloved");
  const [priceRm, setPriceRm] = useState("");
  const [photoPreviews, setPhotoPreviews] = useState<string[]>([]);

  const isService = listingType === "service";

  // Filter categories by kind (product vs service), falling back to all if needed
  const filteredCategories = categories.filter((c) =>
    isService ? c.kind === "service" : c.kind !== "service"
  );
  const selectableCategories =
    filteredCategories.length > 0 ? filteredCategories : categories;

  const parsedPrice = priceRm.trim() ? parseRmToSen(priceRm) : null;

  function handlePhotosChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).slice(0, 4);
    if (files.length === 0) {
      setPhotoPreviews([]);
      return;
    }
    const urls: string[] = [];
    let loaded = 0;
    files.forEach((file, idx) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          urls[idx] = reader.result;
        }
        loaded += 1;
        if (loaded === files.length) {
          setPhotoPreviews(urls.filter(Boolean));
        }
      };
      reader.readAsDataURL(file);
    });
  }

  return (
    <form
      action={formAction}
      className="rounded-2xl border border-[#E6E3EE] bg-white p-5 shadow-[0_2px_10px_rgba(20,18,26,0.04)] sm:p-7"
    >
      {!storefrontName ? (
        <div className="mb-5 rounded-xl border border-[#00A3A6]/35 bg-[#F2FAFA] px-4 py-3 text-xs text-[#007D80] sm:text-sm">
          Your campus storefront will be initialized automatically when you save
          or publish your first listing.
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

      {state.status === "success" && state.message ? (
        <div
          role="status"
          className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#00A3A6]/40 bg-[#EDFAF9] px-4 py-3 text-sm font-semibold text-[#007D80]"
        >
          <span className="inline-flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            {state.message}
          </span>
          <Link
            href="/seller"
            className="inline-flex items-center gap-1 rounded-lg bg-[#008386] px-3 py-1 text-xs font-bold text-white hover:bg-[#00696B]"
          >
            <span>View in Seller Hub</span>
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
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
                onClick={() => setListingType(type.id)}
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
            defaultValue={selectableCategories[0]?.id ?? ""}
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
                defaultValue={1}
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
            {!isService ? <span className="text-[#BA1A1A]">*</span> : "(optional)"}
          </label>
          <select
            id="collectionAreaId"
            name="collectionAreaId"
            required={!isService}
            defaultValue={collectionAreas[0]?.id ?? ""}
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
              defaultValue="Like New"
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
            maxLength={2000}
            placeholder="Describe item details, specs, any wear or defects, or service scope and turnaround notes."
            className="mt-1.5 w-full rounded-xl border border-[#CFCBD9] bg-white px-3.5 py-2.5 text-sm text-[#14121A] placeholder:text-[#858094] focus:border-[#4E2A84] focus:outline-none"
          />
          <p className="mt-1 text-xs text-[#6E6A7C]">
            At least 10 characters required to publish. Drafts can be saved
            earlier and completed later.
          </p>
        </div>

        {/* Photos */}
        <div className="lg:col-span-2">
          <label
            htmlFor="photos"
            className="block text-sm font-bold text-[#14121A]"
          >
            Listing Photos (up to 4)
          </label>
          <div className="mt-1.5 flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-[#CFCBD9] bg-[#FAF9FC] p-4">
            <ImagePlus
              className="h-5 w-5 shrink-0 text-[#4E2A84]"
              aria-hidden="true"
            />
            <input
              id="photos"
              name="photos"
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp"
              onChange={handlePhotosChange}
              className="min-w-0 flex-1 text-xs text-[#4A4656] file:mr-3 file:rounded-lg file:border-0 file:bg-[#4E2A84] file:px-3 py-1.5 file:text-xs file:font-bold file:text-white hover:file:bg-[#3A1E66]"
            />
          </div>
          <p className="mt-1 text-xs text-[#6E6A7C]">
            JPG, PNG, or WebP · Max 5 MB per photo · Stored in the public campus
            listings gallery.
          </p>

          {photoPreviews.length > 0 ? (
            <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {photoPreviews.map((src, i) => (
                <div
                  key={i}
                  className="relative aspect-[4/3] overflow-hidden rounded-xl border border-[#E6E3EE] bg-[#F5F4F8]"
                >
                  <Image
                    src={src}
                    alt={`Selected photo preview ${i + 1}`}
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
      </div>

      {/* Options & Campus Rules */}
      <div className="mt-6 space-y-3 border-t border-[#F0EDF5] pt-5">
        <label className="flex items-start gap-2.5 text-sm text-[#14121A]">
          <input
            type="checkbox"
            name="allowOffers"
            className="mt-0.5 h-4 w-4 rounded border-[#CFCBD9] accent-[#4E2A84]"
          />
          <span>
            <span className="font-bold">Allow buyer price offers</span>{" "}
            <span className="text-xs text-[#6E6A7C]">
              (optional — lets campus buyers negotiate)
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2.5 text-sm text-[#14121A]">
          <input
            type="checkbox"
            name="rulesAcknowledged"
            className="mt-0.5 h-4 w-4 rounded border-[#CFCBD9] accent-[#008386]"
          />
          <span>
            <span className="font-bold">
              I confirm this listing follows UMS campus marketplace rules
            </span>{" "}
            <span className="text-xs text-[#6E6A7C]">
              (required to publish — accurate description, no prohibited items)
            </span>
          </span>
        </label>
      </div>

      {/* Draft vs Publish Actions */}
      <div className="mt-6 flex flex-wrap items-center justify-end gap-3 border-t border-[#F0EDF5] pt-5">
        <button
          type="submit"
          name="intent"
          value="draft"
          disabled={pending}
          className="inline-flex items-center gap-2 rounded-xl border border-[#CFCBD9] bg-white px-5 py-2.5 text-sm font-bold text-[#14121A] hover:border-[#4E2A84] hover:text-[#4E2A84] disabled:opacity-60 press-feedback"
        >
          <FileText className="h-4 w-4" aria-hidden="true" />
          <span>{pending ? "Saving..." : "Save as Draft"}</span>
        </button>

        <button
          type="submit"
          name="intent"
          value="published"
          disabled={pending}
          className="inline-flex items-center gap-2 rounded-xl bg-[#4E2A84] px-5 py-2.5 text-sm font-bold text-white shadow-[0_2px_8px_rgba(78,42,132,0.22)] hover:bg-[#3A1E66] disabled:opacity-60 press-feedback"
        >
          <Send className="h-4 w-4" aria-hidden="true" />
          <span>{pending ? "Publishing..." : "Publish Listing"}</span>
        </button>
      </div>
    </form>
  );
}
