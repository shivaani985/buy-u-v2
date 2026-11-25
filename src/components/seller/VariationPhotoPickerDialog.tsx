"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ImagePlus, RotateCcw, X } from "lucide-react";
import { MAX_LISTING_PHOTOS, validateImageFileMeta } from "@/lib/seller/validation";
import type { SharedListingPhotoRef } from "@/lib/seller/variations";

interface VariationPhotoPickerDialogProps {
  open: boolean;
  optionValue: string;
  groupName: string | null;
  initialPhotoKey: string | null;
  sharedPhotos: SharedListingPhotoRef[];
  onUploadSharedPhoto: (file: File) => Promise<SharedListingPhotoRef | null>;
  onApply: (photoKey: string | null) => void;
  onClose: () => void;
}

function findMatchedPhotoKey(
  candidate: string | null,
  photos: SharedListingPhotoRef[]
): string | null {
  if (!candidate) return null;
  const hit = photos.find(
    (p) => p.key === candidate || (p.storagePath && p.storagePath === candidate)
  );
  return hit ? hit.key : null;
}

export function VariationPhotoPickerDialog({
  open,
  optionValue,
  groupName,
  initialPhotoKey,
  sharedPhotos,
  onUploadSharedPhoto,
  onApply,
  onClose,
}: VariationPhotoPickerDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const normalizedInitialKey = findMatchedPhotoKey(initialPhotoKey, sharedPhotos);
  const [draftPhotoKey, setDraftPhotoKey] = useState<string | null>(
    normalizedInitialKey
  );
  const [uploading, setUploading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // Reset local selection when opened for a different option or initial value
  useEffect(() => {
    if (!open) return;
    setDraftPhotoKey(findMatchedPhotoKey(initialPhotoKey, sharedPhotos));
    setLocalError(null);
  }, [open, optionValue, initialPhotoKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lock background scroll without losing window/table scroll position, trap focus, restore focus on close
  useEffect(() => {
    if (!open || typeof document === "undefined") return;

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const html = document.documentElement;
    const body = document.body;
    const prevHtmlOverflow = html.style.overflow;
    const prevBodyOverflow = body.style.overflow;
    const prevBodyPaddingRight = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - html.clientWidth;

    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      body.style.paddingRight = `${scrollbarWidth}px`;
    }

    const rafId = window.requestAnimationFrame(() => {
      closeBtnRef.current?.focus({ preventScroll: true });
    });

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (uploading) return;
        e.preventDefault();
        onClose();
        return;
      }

      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusables = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
        )
      );
      if (focusables.length === 0) return;

      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;

      if (e.shiftKey) {
        if (active === first || !dialogRef.current.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !dialogRef.current.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(rafId);
      document.removeEventListener("keydown", handleKeyDown);
      html.style.overflow = prevHtmlOverflow;
      body.style.overflow = prevBodyOverflow;
      body.style.paddingRight = prevBodyPaddingRight;

      const prevEl = previousFocusRef.current;
      if (prevEl && prevEl.isConnected) {
        window.requestAnimationFrame(() => {
          prevEl.focus({ preventScroll: true });
        });
      }
    };
  }, [open, uploading, onClose]);

  if (!open || typeof document === "undefined") {
    return null;
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    if (sharedPhotos.length >= MAX_LISTING_PHOTOS) {
      setLocalError(`Maximum ${MAX_LISTING_PHOTOS} product photos reached.`);
      return;
    }

    const metaCheck = validateImageFileMeta(file);
    if (!metaCheck.ok) {
      setLocalError(metaCheck.error);
      return;
    }

    setLocalError(null);
    setUploading(true);
    try {
      const uploaded = await onUploadSharedPhoto(file);
      if (uploaded) {
        setDraftPhotoKey(uploaded.key);
      } else {
        setLocalError("Could not add this photo to your listing gallery.");
      }
    } finally {
      setUploading(false);
    }
  }

  const canApply = draftPhotoKey !== null || normalizedInitialKey !== null;
  const galleryFull = sharedPhotos.length >= MAX_LISTING_PHOTOS;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4"
      role="presentation"
    >
      {/* Dimmed Backdrop */}
      <div
        aria-hidden="true"
        onClick={() => {
          if (!uploading) onClose();
        }}
        className="anim-backdrop-in fixed inset-0 bg-[#14121A]/45 backdrop-blur-[2px]"
      />

      {/* Responsive Modal (Desktop) / Bottom Sheet (Mobile) */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="anim-modal-sheet relative z-10 flex max-h-[88dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-[#E6E3EE] bg-white shadow-2xl sm:max-h-[85vh] sm:max-w-[520px] sm:rounded-2xl"
      >
        <input
          ref={uploadInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={handleFileChange}
          className="sr-only"
        />

        {/* Sticky Header */}
        <div className="shrink-0 border-b border-[#ECEAF3] px-4 pt-2.5 pb-3 sm:px-5 sm:pt-4">
          <div
            aria-hidden="true"
            className="mx-auto mb-2.5 h-1 w-10 rounded-full bg-[#D8D3E6] sm:hidden"
          />
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2
                id={titleId}
                className="text-base font-extrabold tracking-tight text-[#14121A]"
              >
                Variation Photo
              </h2>
              <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-[#6E6A7C]">
                <span>Selected variation:</span>
                <span className="inline-flex max-w-full items-center truncate rounded-md bg-[#F4F1FA] px-2 py-0.5 text-[11.5px] font-bold text-[#4E2A84]">
                  {groupName ? `${groupName}: ${optionValue}` : optionValue}
                </span>
              </p>
            </div>
            <button
              ref={closeBtnRef}
              type="button"
              disabled={uploading}
              onClick={onClose}
              aria-label="Close variation photo dialog"
              className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-[#6E6A7C] transition hover:bg-[#F5F4F8] hover:text-[#14121A] disabled:opacity-50 press-feedback"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Scrollable Body */}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
          {localError ? (
            <p
              role="alert"
              className="rounded-xl border border-[#F5C2C0] bg-[#FDF2F2] px-3 py-2 text-xs font-semibold text-[#B42318]"
            >
              {localError}
            </p>
          ) : null}

          <div>
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-extrabold uppercase tracking-wider text-[#6E6A7C]">
                Product Photos ({sharedPhotos.length}/{MAX_LISTING_PHOTOS})
              </p>
              {normalizedInitialKey !== null && draftPhotoKey === null ? (
                <span className="text-[11px] font-semibold text-[#B42318]">
                  Photo will be removed on Apply
                </span>
              ) : null}
            </div>

            {sharedPhotos.length > 0 ? (
              <div className="mt-2.5 grid grid-cols-3 gap-2.5 sm:grid-cols-4">
                {sharedPhotos.map((sp, i) => {
                  const isSelected = Boolean(
                    draftPhotoKey &&
                      (draftPhotoKey === sp.key ||
                        (sp.storagePath && draftPhotoKey === sp.storagePath))
                  );
                  return (
                    <button
                      key={sp.key}
                      type="button"
                      onClick={() => {
                        setLocalError(null);
                        setDraftPhotoKey(sp.key);
                      }}
                      aria-pressed={isSelected}
                      aria-label={`Select product photo ${i + 1}${isSelected ? " (selected)" : ""}`}
                      className={`group relative aspect-square cursor-pointer overflow-hidden rounded-xl border-2 bg-[#F5F4F8] transition press-feedback ${
                        isSelected
                          ? "border-[#4E2A84] ring-2 ring-[#4E2A84]/25"
                          : "border-[#E6E3EE] hover:border-[#4E2A84]/55"
                      }`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={sp.url}
                        alt={`Product photo ${i + 1}`}
                        className="h-full w-full object-cover"
                      />
                      {isSelected ? (
                        <span
                          aria-hidden="true"
                          className="absolute top-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-[#4E2A84] text-white shadow-sm"
                        >
                          <Check className="h-3.5 w-3.5 stroke-[3]" />
                        </span>
                      ) : null}
                      {i === 0 ? (
                        <span className="absolute bottom-1.5 left-1.5 rounded bg-white/95 px-1.5 py-0.5 text-[9.5px] font-extrabold uppercase tracking-wide text-[#4E2A84] shadow-xs">
                          Cover
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="mt-2.5 rounded-xl border border-dashed border-[#D8D3E6] bg-[#FAFAFC] px-4 py-6 text-center">
                <p className="text-xs font-semibold text-[#4A4656]">
                  No product photos uploaded yet.
                </p>
                <p className="mt-1 text-[11px] text-[#6E6A7C]">
                  Upload a photo below to add it to your shared gallery and assign it to {optionValue}.
                </p>
              </div>
            )}
          </div>

          {/* Upload New + Remove Photo Controls */}
          <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-[#ECEAF3] bg-[#FAFAFC] p-3">
            {!galleryFull ? (
              <button
                type="button"
                disabled={uploading}
                onClick={() => uploadInputRef.current?.click()}
                className="inline-flex min-h-[40px] cursor-pointer items-center gap-1.5 rounded-xl border border-[#4E2A84]/40 bg-white px-3.5 py-2 text-xs font-bold text-[#4E2A84] transition hover:border-[#4E2A84] hover:bg-[#F7F4FC] disabled:opacity-50 press-feedback"
              >
                <ImagePlus className="h-4 w-4" aria-hidden="true" />
                <span>{uploading ? "Uploading..." : "Upload New Photo"}</span>
              </button>
            ) : (
              <span className="text-xs font-semibold text-[#6E6A7C]">
                Gallery full ({MAX_LISTING_PHOTOS}/{MAX_LISTING_PHOTOS} photos)
              </span>
            )}

            {draftPhotoKey !== null ? (
              <button
                type="button"
                disabled={uploading}
                onClick={() => {
                  setLocalError(null);
                  setDraftPhotoKey(null);
                }}
                className="inline-flex min-h-[40px] cursor-pointer items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold text-[#B42318] transition hover:bg-[#FDF2F2] disabled:opacity-50 press-feedback"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Remove Photo</span>
              </button>
            ) : null}
          </div>
        </div>

        {/* Sticky Footer Actions */}
        <div className="flex shrink-0 items-center justify-end gap-2.5 border-t border-[#ECEAF3] bg-white px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5 sm:py-3.5">
          <button
            type="button"
            disabled={uploading}
            onClick={onClose}
            className="min-h-[42px] cursor-pointer rounded-xl border border-[#CFCBD9] bg-white px-4 py-2 text-xs font-bold text-[#14121A] transition hover:border-[#4E2A84] hover:text-[#4E2A84] disabled:opacity-50 press-feedback"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={uploading || !canApply}
            onClick={() => onApply(draftPhotoKey)}
            className="min-h-[42px] cursor-pointer rounded-xl bg-[#4E2A84] px-4 py-2 text-xs font-bold text-white shadow-[0_2px_8px_rgba(78,42,132,0.24)] transition hover:bg-[#3A1E66] disabled:cursor-not-allowed disabled:opacity-50 press-feedback"
          >
            Apply Photo
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
