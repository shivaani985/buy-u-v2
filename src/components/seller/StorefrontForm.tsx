"use client";

import { useActionState, useState } from "react";
import Image from "next/image";
import { CheckCircle2, ImagePlus, Save, ShieldCheck, Store } from "lucide-react";
import {
  saveStorefrontAction,
  type SellerActionState,
} from "@/app/seller/actions";

interface StorefrontFormProps {
  initialShopName: string;
  initialDescription: string;
  initialLogoUrl: string | null;
  initialBannerUrl?: string | null;
  initialBusinessInfo?: string;
  initialIsOpen?: boolean;
  faculty: string | null;
  publishedCount: number;
  isNewStorefront: boolean;
}

const INITIAL_STATE: SellerActionState = { status: "idle" };

export function StorefrontForm({
  initialShopName,
  initialDescription,
  initialLogoUrl,
  initialBannerUrl = null,
  initialBusinessInfo = "",
  initialIsOpen = true,
  faculty,
  publishedCount,
  isNewStorefront,
}: StorefrontFormProps) {
  const [state, formAction, pending] = useActionState(
    saveStorefrontAction,
    INITIAL_STATE
  );
  const [shopName, setShopName] = useState(initialShopName);
  const [description, setDescription] = useState(initialDescription);
  const [businessInfo, setBusinessInfo] = useState(initialBusinessInfo);
  const [isOpen, setIsOpen] = useState(initialIsOpen);
  const [previewUrl, setPreviewUrl] = useState<string | null>(initialLogoUrl);
  const [removeLogo, setRemoveLogo] = useState(false);
  const [bannerPreviewUrl, setBannerPreviewUrl] = useState<string | null>(initialBannerUrl);
  const [removeBanner, setRemoveBanner] = useState(false);

  const initials = (shopName.trim() || "BU")
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setRemoveLogo(false);
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setPreviewUrl(reader.result);
      }
    };
    reader.readAsDataURL(file);
  }

  function handleBannerChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setRemoveBanner(false);
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setBannerPreviewUrl(reader.result);
      }
    };
    reader.readAsDataURL(file);
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      {/* LEFT: Editor Form */}
      <form
        action={formAction}
        className="rounded-2xl border border-[#E6E3EE] bg-white p-5 shadow-[0_2px_8px_rgba(20,18,26,0.04)] sm:p-6 lg:col-span-7"
      >
        <h2 className="text-lg font-extrabold text-[#14121A]">
          {isNewStorefront ? "Initialize & Customize Storefront" : "Edit Storefront"}
        </h2>
        <p className="mt-1 text-xs text-[#555062] sm:text-sm">
          Your storefront identity appears alongside your published listings for
          verified UMS students and staff.
        </p>

        {state.status === "error" && state.message ? (
          <div
            role="alert"
            className="mt-4 rounded-xl border border-[#BA1A1A]/30 bg-[#FDF2F2] px-4 py-3 text-sm font-medium text-[#BA1A1A]"
          >
            {state.message}
          </div>
        ) : null}

        {state.status === "success" && state.message ? (
          <div
            role="status"
            className="mt-4 flex items-center gap-2 rounded-xl border border-[#00A3A6]/40 bg-[#EDFAF9] px-4 py-3 text-sm font-semibold text-[#007D80]"
          >
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{state.message}</span>
          </div>
        ) : null}

        <div className="mt-5 space-y-5">
          {/* Storefront Name */}
          <div>
            <label
              htmlFor="shopName"
              className="block text-sm font-bold text-[#14121A]"
            >
              Storefront Name <span className="text-[#BA1A1A]">*</span>
            </label>
            <input
              id="shopName"
              name="shopName"
              type="text"
              required
              minLength={2}
              maxLength={60}
              value={shopName}
              onChange={(e) => setShopName(e.target.value)}
              placeholder="e.g. Aina's Study Corner"
              className="mt-1.5 w-full rounded-xl border border-[#CFCBD9] bg-white px-3.5 py-2.5 text-sm text-[#14121A] placeholder:text-[#858094] focus:border-[#4E2A84] focus:outline-none"
            />
            <p className="mt-1 text-xs text-[#6E6A7C]">
              {shopName.trim().length}/60 characters
            </p>
          </div>

          {/* Storefront Description */}
          <div>
            <label
              htmlFor="description"
              className="block text-sm font-bold text-[#14121A]"
            >
              Storefront Bio / Description
            </label>
            <textarea
              id="description"
              name="description"
              rows={4}
              maxLength={500}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Tell campus buyers what you offer, preferred meetup spots (e.g. Cafe UMSKAL or Kolej Kediaman Alpha), and response hours."
              className="mt-1.5 w-full rounded-xl border border-[#CFCBD9] bg-white px-3.5 py-2.5 text-sm text-[#14121A] placeholder:text-[#858094] focus:border-[#4E2A84] focus:outline-none"
            />
            <p className="mt-1 text-xs text-[#6E6A7C]">
              {description.trim().length}/500 characters
            </p>
          </div>

          {/* Logo Upload */}
          <div>
            <label
              htmlFor="logo"
              className="block text-sm font-bold text-[#14121A]"
            >
              Storefront Logo (optional)
            </label>
            <div className="mt-1.5 flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-[#CFCBD9] bg-[#FAF9FC] p-3.5">
              <ImagePlus
                className="h-5 w-5 shrink-0 text-[#4E2A84]"
                aria-hidden="true"
              />
              <input
                id="logo"
                name="logo"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={handleLogoChange}
                className="min-w-0 flex-1 text-xs text-[#4A4656] file:mr-3 file:rounded-lg file:border-0 file:bg-[#4E2A84] file:px-3 file:py-1.5 file:text-xs file:font-bold file:text-white hover:file:bg-[#3A1E66]"
              />
            </div>
            <p className="mt-1 text-xs text-[#6E6A7C]">
              JPG, PNG, or WebP up to 5 MB. Square image recommended.
            </p>

            {previewUrl ? (
              <label className="mt-2.5 inline-flex items-center gap-2 text-xs font-semibold text-[#555062]">
                <input
                  type="checkbox"
                  name="removeLogo"
                  checked={removeLogo}
                  onChange={(e) => setRemoveLogo(e.target.checked)}
                  className="h-4 w-4 rounded border-[#CFCBD9] accent-[#4E2A84]"
                />
                <span>Remove current logo and use initials badge</span>
              </label>
            ) : null}
          </div>

          {/* Storefront Banner Upload */}
          <div>
            <label
              htmlFor="banner"
              className="block text-sm font-bold text-[#14121A]"
            >
              Storefront Banner Image (optional)
            </label>
            <div className="mt-1.5 flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-[#CFCBD9] bg-[#FAF9FC] p-3.5">
              <ImagePlus
                className="h-5 w-5 shrink-0 text-[#008285]"
                aria-hidden="true"
              />
              <input
                id="banner"
                name="banner"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={handleBannerChange}
                className="min-w-0 flex-1 text-xs text-[#4A4656] file:mr-3 file:rounded-lg file:border-0 file:bg-[#008285] file:px-3 file:py-1.5 file:text-xs file:font-bold file:text-white hover:file:bg-[#006A6D]"
              />
            </div>
            <p className="mt-1 text-xs text-[#6E6A7C]">
              Wide landscape image (e.g. 1200&times;320), JPG/PNG/WebP up to 5 MB.
            </p>
            {bannerPreviewUrl ? (
              <label className="mt-2.5 inline-flex items-center gap-2 text-xs font-semibold text-[#555062]">
                <input
                  type="checkbox"
                  name="removeBanner"
                  checked={removeBanner}
                  onChange={(e) => setRemoveBanner(e.target.checked)}
                  className="h-4 w-4 rounded border-[#CFCBD9] accent-[#4E2A84]"
                />
                <span>Remove storefront banner image</span>
              </label>
            ) : null}
          </div>

          {/* Business Info / Operating Hours */}
          <div>
            <label
              htmlFor="businessInfo"
              className="block text-sm font-bold text-[#14121A]"
            >
              Campus Pickup Hours &amp; Business Info (optional)
            </label>
            <textarea
              id="businessInfo"
              name="businessInfo"
              rows={2}
              maxLength={400}
              value={businessInfo}
              onChange={(e) => setBusinessInfo(e.target.value)}
              placeholder="e.g. Open Mon–Fri 12 PM – 7 PM MYT · Pickup at Kolej Kediaman Alpha lobby"
              className="mt-1.5 w-full rounded-xl border border-[#CFCBD9] bg-white px-3.5 py-2.5 text-sm text-[#14121A] placeholder:text-[#858094] focus:border-[#4E2A84] focus:outline-none"
            />
          </div>

          {/* Storefront Availability Toggle */}
          <label className="flex items-center gap-2.5 rounded-xl border border-[#ECEAF3] bg-[#FAF9FC] px-3.5 py-2.5 text-xs font-semibold text-[#14121A]">
            <input
              type="checkbox"
              name="isOpen"
              checked={isOpen}
              onChange={(e) => setIsOpen(e.target.checked)}
              className="h-4 w-4 rounded border-[#CFCBD9] accent-[#008285]"
            />
            <span>Storefront Open for Campus Orders &amp; Inquiries</span>
          </label>

          <div className="pt-1">
            <button
              type="submit"
              disabled={pending}
              className="inline-flex items-center gap-2 rounded-xl bg-[#4E2A84] px-5 py-2.5 text-sm font-bold text-white shadow-[0_2px_8px_rgba(78,42,132,0.22)] hover:bg-[#3A1E66] disabled:opacity-60 press-feedback"
            >
              <Save className="h-4 w-4" aria-hidden="true" />
              <span>{pending ? "Saving Storefront..." : "Save Storefront"}</span>
            </button>
          </div>
        </div>
      </form>

      {/* RIGHT: Live Public Storefront Preview */}
      <aside className="lg:col-span-5">
        <div className="rounded-2xl border border-[#E6E3EE] bg-[#FAF9FC] p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-extrabold uppercase tracking-wider text-[#4E2A84]">
              Public Storefront Preview
            </span>
            <span className="rounded-md bg-white px-2 py-0.5 text-[10.5px] font-bold text-[#008386] border border-[#DDF2F2]">
              Live Preview
            </span>
          </div>

          <div className="mt-3.5 overflow-hidden rounded-2xl border border-[#E6E3EE] bg-white shadow-[0_2px_8px_rgba(20,18,26,0.05)]">
            {bannerPreviewUrl && !removeBanner ? (
              <div className="relative h-24 w-full bg-[#F3EEFA]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={bannerPreviewUrl}
                  alt="Storefront banner preview"
                  className="h-full w-full object-cover"
                />
              </div>
            ) : (
              <div className="h-2 w-full bg-[#4E2A84]" aria-hidden="true" />
            )}
            <div className="p-5">
              <div className="flex items-center gap-3.5">
                {previewUrl && !removeLogo ? (
                  <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-2xl border border-[#E6E3EE] bg-[#F8F6FD]">
                    <Image
                      src={previewUrl}
                      alt={shopName || "Storefront preview"}
                      fill
                      unoptimized
                      sizes="56px"
                      className="object-cover"
                    />
                  </div>
                ) : (
                  <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-[#4E2A84] text-base font-extrabold text-white">
                    {initials}
                  </span>
                )}

                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-lg font-extrabold text-[#14121A]">
                    {shopName.trim() || "Your Campus Storefront"}
                  </h3>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-[#555062]">
                    <span className="inline-flex items-center gap-1 rounded-md bg-[#F4F1FA] px-2 py-0.5 text-[10.5px] font-bold text-[#4E2A84]">
                      <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                      Verified Student
                    </span>
                    {faculty ? (
                      <span className="text-xs text-[#6E6A7C]">· {faculty}</span>
                    ) : null}
                  </div>
                </div>
              </div>

              <p className="mt-4 text-sm leading-relaxed text-[#4A4656]">
                {description.trim() ||
                  "No storefront bio added yet. Write a short description so UMS students know what you offer."}
              </p>

              <div className="mt-4 flex items-center justify-between border-t border-[#F0EDF5] pt-3 text-xs text-[#6E6A7C]">
                <span className="inline-flex items-center gap-1.5 font-semibold text-[#14121A]">
                  <Store className="h-3.5 w-3.5 text-[#008386]" aria-hidden="true" />
                  {publishedCount}{" "}
                  {publishedCount === 1 ? "published listing" : "published listings"}
                </span>
                <span>UMSKAL Campus</span>
              </div>
            </div>
          </div>

          <p className="mt-3 text-xs leading-relaxed text-[#6E6A7C]">
            Private student information (email, matric number, phone, and payout
            bank account) is never shown on your public storefront.
          </p>
        </div>
      </aside>
    </div>
  );
}
