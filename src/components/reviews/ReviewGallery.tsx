"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Film, Play, X } from "lucide-react";
import type { ReviewMediaAttachment } from "@/lib/reviews/presentation";

interface ReviewGalleryProps {
  media: ReviewMediaAttachment[];
  compact?: boolean;
}

export function ReviewGallery({ media, compact = false }: ReviewGalleryProps) {
  const images = media.filter((m) => m.kind === "image");
  const video = media.find((m) => m.kind === "video") ?? null;

  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (lightboxIdx === null) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setLightboxIdx(null);
      } else if (e.key === "ArrowLeft" && images.length > 1) {
        setLightboxIdx((cur) =>
          cur === null ? 0 : (cur - 1 + images.length) % images.length
        );
      } else if (e.key === "ArrowRight" && images.length > 1) {
        setLightboxIdx((cur) => (cur === null ? 0 : (cur + 1) % images.length));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
      returnFocusRef.current?.focus();
    };
  }, [lightboxIdx, images.length]);

  if (images.length === 0 && !video) return null;

  const thumbSize = compact ? "h-14 w-14" : "h-16 w-16 sm:h-20 sm:w-20";
  const activeImage = lightboxIdx !== null ? images[lightboxIdx] ?? null : null;

  return (
    <div className="mt-2.5 space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {images.map((img, idx) => (
          <button
            key={`${img.url}-${idx}`}
            type="button"
            onClick={(e) => {
              returnFocusRef.current = e.currentTarget;
              setLightboxIdx(idx);
            }}
            aria-label={`View review photo ${idx + 1} of ${images.length}`}
            className={`group relative ${thumbSize} shrink-0 cursor-pointer overflow-hidden rounded-xl border border-[#E6E3EE] bg-[#F5F4F8] transition-all hover:border-[#4E2A84] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4E2A84] press-feedback`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={img.url}
              alt={`Review photo ${idx + 1}`}
              loading="lazy"
              className="h-full w-full object-cover transition-transform duration-150 group-hover:scale-105"
            />
          </button>
        ))}

        {video && !videoPlaying ? (
          <button
            type="button"
            onClick={() => setVideoPlaying(true)}
            aria-label="Play review video"
            className={`group relative flex ${thumbSize} shrink-0 cursor-pointer flex-col items-center justify-center gap-1 overflow-hidden rounded-xl border border-[#CFCBD9] bg-[#14121A] text-white transition-all hover:border-[#4E2A84] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4E2A84] press-feedback`}
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/90 text-[#4E2A84] shadow-sm transition-transform group-hover:scale-105">
              <Play className="ml-0.5 h-3.5 w-3.5 fill-current" aria-hidden="true" />
            </span>
            <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-white/90">
              <Film className="h-2.5 w-2.5" aria-hidden="true" />
              Video
            </span>
          </button>
        ) : null}
      </div>

      {video && videoPlaying ? (
        <div className="relative max-w-md overflow-hidden rounded-xl border border-[#E6E3EE] bg-black">
          <video
            src={video.url}
            controls
            autoPlay
            playsInline
            preload="metadata"
            className="max-h-72 w-full object-contain"
          />
          <button
            type="button"
            onClick={() => setVideoPlaying(false)}
            aria-label="Close video player"
            className="absolute right-2 top-2 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-black/70 text-white hover:bg-black"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {activeImage && typeof document !== "undefined"
        ? createPortal(
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Review photo viewer"
              onClick={() => setLightboxIdx(null)}
              className="anim-backdrop-in fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-4 backdrop-blur-xs"
            >
              <button
                type="button"
                onClick={() => setLightboxIdx(null)}
                aria-label="Close photo viewer"
                className="absolute right-4 top-4 flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-white/90 text-[#14121A] shadow-md hover:bg-white"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>

              {images.length > 1 ? (
                <>
                  <button
                    type="button"
                    aria-label="Previous review photo"
                    onClick={(e) => {
                      e.stopPropagation();
                      setLightboxIdx((cur) =>
                        cur === null ? 0 : (cur - 1 + images.length) % images.length
                      );
                    }}
                    className="absolute left-3 top-1/2 flex h-10 w-10 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-white/90 text-[#14121A] shadow-md hover:bg-white"
                  >
                    <ChevronLeft className="h-5 w-5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label="Next review photo"
                    onClick={(e) => {
                      e.stopPropagation();
                      setLightboxIdx((cur) =>
                        cur === null ? 0 : (cur + 1) % images.length
                      );
                    }}
                    className="absolute right-3 top-1/2 flex h-10 w-10 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-white/90 text-[#14121A] shadow-md hover:bg-white"
                  >
                    <ChevronRight className="h-5 w-5" aria-hidden="true" />
                  </button>
                </>
              ) : null}

              <div
                onClick={(e) => e.stopPropagation()}
                className="flex flex-col items-center gap-2"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={activeImage.url}
                  alt={`Review photo ${(lightboxIdx ?? 0) + 1}`}
                  className="max-h-[82vh] max-w-[90vw] rounded-2xl object-contain shadow-2xl"
                />
                {images.length > 1 ? (
                  <p className="rounded-full bg-black/65 px-3 py-1 text-xs font-bold text-white">
                    {(lightboxIdx ?? 0) + 1} / {images.length}
                  </p>
                ) : null}
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
