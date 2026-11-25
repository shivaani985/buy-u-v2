"use client";

import type { PointerEventHandler, RefObject } from "react";
import { Heart, MapPin, Move, RotateCcw, Star, ZoomIn } from "lucide-react";
import type { SellListingKind } from "@/lib/seller/validation";

const PREVIEW_TYPE_LABEL: Record<SellListingKind, string> = {
  preloved: "Pre-Loved",
  business: "Student Business",
  food: "Campus Food",
  service: "Service",
};

const PREVIEW_BADGE_STYLES: Record<SellListingKind, string> = {
  preloved: "bg-[#F4F1FA] text-[#4E2A84]",
  business: "bg-[#EDF5FC] text-[#1D70B8]",
  food: "bg-[#EDFAF9] text-[#008386]",
  service: "bg-[#EDFAF9] text-[#008386]",
};

export interface CoverFramingControls {
  previewBoxRef: RefObject<HTMLDivElement | null>;
  isDraggingCover: boolean;
  coverZoom: number;
  isCoverAdjusted: boolean;
  coverFrameMetrics: {
    drawnW: number;
    drawnH: number;
    dx: number;
    dy: number;
  } | null;
  onPointerDown: PointerEventHandler<HTMLDivElement>;
  onPointerMove: PointerEventHandler<HTMLDivElement>;
  onPointerUp: PointerEventHandler<HTMLDivElement>;
  onImageLoad: (naturalWidth: number, naturalHeight: number) => void;
  onZoomChange: (zoom: number) => void;
  onReset: () => void;
}

interface ListingCardPreviewProps {
  coverUrl: string | null;
  title: string;
  listingType: SellListingKind;
  categoryName: string;
  areaName: string;
  condition: string;
  priceSen: number;
  sellerDisplayName: string;
  timestampLabel?: string;
  coverFraming?: CoverFramingControls;
}

export function ListingCardPreview({
  coverUrl,
  title,
  listingType,
  categoryName,
  areaName,
  condition,
  priceSen,
  sellerDisplayName,
  timestampLabel = "Just now",
  coverFraming,
}: ListingCardPreviewProps) {
  const isService = listingType === "service";
  const isFood = listingType === "food";
  const sellerInitials = sellerDisplayName
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "US";

  return (
    <aside className="lg:sticky lg:top-24">
      <div className="rounded-2xl border border-[#E6E3EE] bg-[#FAFAFC] p-4">
        <p className="text-[11px] font-extrabold uppercase tracking-wider text-[#6E6A7C]">
          Live Card Preview
        </p>
        <p className="mt-0.5 text-xs text-[#858094]">
          How your listing appears to UMS buyers
        </p>

        <article className="mt-3 flex flex-col overflow-hidden rounded-2xl border border-[#E6E3EE] bg-white shadow-[0_2px_8px_rgba(20,18,26,0.04)]">
          <div
            ref={coverFraming?.previewBoxRef}
            onPointerDown={coverFraming?.onPointerDown}
            onPointerMove={coverFraming?.onPointerMove}
            onPointerUp={coverFraming?.onPointerUp}
            onPointerCancel={coverFraming?.onPointerUp}
            className={`relative aspect-[4/3] w-full overflow-hidden bg-[#F5F4F8] select-none ${
              coverUrl && coverFraming
                ? coverFraming.isDraggingCover
                  ? "cursor-grabbing touch-none"
                  : "cursor-grab touch-none"
                : ""
            }`}
          >
            {coverUrl ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={coverUrl}
                alt={title || "Listing preview"}
                draggable={false}
                onLoad={(e) => {
                  const el = e.currentTarget;
                  if (coverFraming && el.naturalWidth > 0 && el.naturalHeight > 0) {
                    coverFraming.onImageLoad(el.naturalWidth, el.naturalHeight);
                  }
                }}
                style={
                  coverFraming?.coverFrameMetrics
                    ? {
                        position: "absolute",
                        left: "50%",
                        top: "50%",
                        width: `${coverFraming.coverFrameMetrics.drawnW}px`,
                        height: `${coverFraming.coverFrameMetrics.drawnH}px`,
                        maxWidth: "none",
                        transform: `translate(calc(-50% + ${coverFraming.coverFrameMetrics.dx}px), calc(-50% + ${coverFraming.coverFrameMetrics.dy}px))`,
                      }
                    : undefined
                }
                className={
                  coverFraming?.coverFrameMetrics
                    ? "pointer-events-none select-none"
                    : "h-full w-full object-cover pointer-events-none select-none"
                }
              />
            ) : (
              <div className="flex h-full w-full flex-col justify-between bg-[#F4F1FA] p-3">
                <span className="self-start rounded-md bg-[#4E2A84] px-2 py-0.5 text-[10.5px] font-bold text-white">
                  {PREVIEW_TYPE_LABEL[listingType]}
                </span>
                <span className="text-xs font-bold italic text-[#4E2A84]">
                  {categoryName}
                </span>
              </div>
            )}

            {coverUrl && coverFraming ? (
              <span className="pointer-events-none absolute top-2 left-2 inline-flex items-center gap-1 rounded-md bg-[#14121A]/60 px-2 py-0.5 text-[10px] font-bold text-white backdrop-blur-xs">
                <Move className="h-3 w-3" aria-hidden="true" />
                <span>Drag to frame</span>
              </span>
            ) : null}

            {!isService && !isFood && condition ? (
              <span className="absolute top-2 right-2 rounded-md bg-white/95 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-[#4E2A84] shadow-xs">
                {condition}
              </span>
            ) : null}

            <div className="absolute bottom-2 left-2 rounded-lg border border-white/15 bg-[#14121A]/60 px-2.5 py-0.5 shadow-sm backdrop-blur-md">
              <span className="tabular-price text-[14px] font-extrabold tracking-tight text-white">
                RM {(priceSen / 100).toFixed(2)}
              </span>
            </div>

            <span
              aria-hidden="true"
              className="absolute bottom-2 right-2 flex h-7 w-7 items-center justify-center rounded-full text-white/90 drop-shadow"
            >
              <Heart className="h-4 w-4" />
            </span>
          </div>

          <div className="flex flex-1 flex-col justify-between p-3.5">
            <div>
              <h3 className="line-clamp-2 text-[15.5px] font-extrabold leading-snug tracking-[-0.01em] text-[#14121A]">
                {title.trim() || "Your listing title will appear here"}
              </h3>

              <div className="mt-1.5 flex items-center gap-1 text-[12px] text-[#6E6A7C]">
                <MapPin
                  className="h-3.5 w-3.5 shrink-0 text-[#8E899E]"
                  aria-hidden="true"
                />
                <span className="truncate">{areaName}</span>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span
                  className={`inline-block rounded-md px-2 py-0.5 text-[11px] font-bold ${PREVIEW_BADGE_STYLES[listingType]}`}
                >
                  {categoryName}
                </span>
                <span className="inline-block rounded-md bg-[#F4F3F7] px-2 py-0.5 text-[10.5px] font-semibold text-[#5B5668]">
                  {PREVIEW_TYPE_LABEL[listingType]}
                </span>
              </div>

              <div className="mt-2 flex items-center gap-1.5 text-[11px] font-semibold text-[#5B5668]">
                <Star
                  className="h-3.5 w-3.5 shrink-0 text-[#C5C1D0]"
                  aria-hidden="true"
                />
                <span>No shop rating yet</span>
              </div>
            </div>

            <div className="mt-3 flex items-center justify-between border-t border-[#F0EDF5] pt-2 text-[11px] text-[#6E6A7C]">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#EFEAF8] text-[9px] font-extrabold text-[#4E2A84]">
                  {sellerInitials}
                </span>
                <span className="truncate font-semibold text-[#3E3B4B]">
                  {sellerDisplayName}
                </span>
              </div>
              <span className="shrink-0 text-[10.5px] text-[#858094]">
                {timestampLabel}
              </span>
            </div>
          </div>
        </article>

        {coverUrl && coverFraming ? (
          <div className="mt-3 rounded-xl border border-[#E6E3EE] bg-white p-3">
            <div className="flex items-center justify-between gap-2 text-[11px] font-bold text-[#14121A]">
              <span className="inline-flex items-center gap-1 text-[#4E2A84]">
                <ZoomIn className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Cover Zoom ({coverFraming.coverZoom.toFixed(1)}&times;)</span>
              </span>
              {coverFraming.isCoverAdjusted ? (
                <button
                  type="button"
                  onClick={coverFraming.onReset}
                  className="inline-flex cursor-pointer items-center gap-1 text-[11px] font-bold text-[#6E6A7C] hover:text-[#4E2A84]"
                >
                  <RotateCcw className="h-3 w-3" aria-hidden="true" />
                  <span>Reset</span>
                </button>
              ) : null}
            </div>
            <input
              type="range"
              min={1}
              max={2.5}
              step={0.05}
              value={coverFraming.coverZoom}
              aria-label="Cover photo zoom"
              onChange={(e) => coverFraming.onZoomChange(Number(e.target.value))}
              className="mt-1.5 w-full accent-[#4E2A84]"
            />
            <p className="mt-1 text-[10.5px] text-[#6E6A7C]">
              Drag the preview photo or zoom to frame your exact cover image.
            </p>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
