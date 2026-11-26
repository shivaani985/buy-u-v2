"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EyeOff, Loader2, Package, Star, X } from "lucide-react";
import { ReviewMediaUploader } from "@/components/reviews/ReviewMediaUploader";
import {
  getReviewStarLabel,
  maskAnonymousReviewerName,
  MAX_REVIEW_COMMENT_LEN,
  MIN_REVIEW_COMMENT_LEN,
  REVIEW_STAR_COLOR,
} from "@/lib/reviews/validation";

export interface ReviewDialogItemOption {
  id: string;
  listingId: string | null;
  title: string;
  variantLabel: string | null;
  imageUrl: string | null;
  isService?: boolean;
}

export interface ReviewDialogInitialReview {
  id: string;
  listingId: string | null;
  rating: number;
  comment: string;
  isAnonymous?: boolean;
  imagePaths?: string[];
  videoPath?: string | null;
}

interface ReviewDialogProps {
  open: boolean;
  orderCode?: string | null;
  buyerDisplayName: string;
  items: ReviewDialogItemOption[];
  initialReview?: ReviewDialogInitialReview | null;
  submitting: boolean;
  errorMessage: string | null;
  onClose: () => void;
  onSubmit: (payload: {
    listingId: string | null;
    rating: number;
    comment: string;
    isAnonymous: boolean;
    imagePaths: string[];
    videoPath: string | null;
  }) => Promise<void> | void;
}

export function ReviewDialog({
  open,
  orderCode,
  buyerDisplayName,
  items,
  initialReview = null,
  submitting,
  errorMessage,
  onClose,
  onSubmit,
}: ReviewDialogProps) {
  const isEditing = Boolean(initialReview);
  const [selectedListingId, setSelectedListingId] = useState<string>(
    () => initialReview?.listingId ?? items[0]?.listingId ?? ""
  );
  const [rating, setRating] = useState<number>(() => initialReview?.rating ?? 5);
  const [hoverRating, setHoverRating] = useState<number | null>(null);
  const [comment, setComment] = useState<string>(() => initialReview?.comment ?? "");
  const [isAnonymous, setIsAnonymous] = useState<boolean>(
    () => Boolean(initialReview?.isAnonymous)
  );
  const [imagePaths, setImagePaths] = useState<string[]>(
    () => initialReview?.imagePaths ?? []
  );
  const [videoPath, setVideoPath] = useState<string | null>(
    () => initialReview?.videoPath ?? null
  );
  const [isMediaUploading, setIsMediaUploading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const returnFocusRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) {
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", handleKeyDown);
      returnFocusRef.current?.focus();
    };
  }, [open, submitting, onClose]);

  if (!open || typeof document === "undefined") return null;

  const activeItem =
    items.find((it) => it.listingId === selectedListingId) ?? items[0] ?? null;
  const displayedStar = hoverRating ?? rating;
  const trimmedLen = comment.trim().length;
  const maskedPreview = maskAnonymousReviewerName(buyerDisplayName);

  function handleFormSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);
    if (isMediaUploading) {
      setLocalError("Please wait for your uploaded photos or video to finish checking.");
      return;
    }
    if (rating < 1 || rating > 5) {
      setLocalError("Please choose a star rating from 1 to 5.");
      return;
    }
    if (trimmedLen < MIN_REVIEW_COMMENT_LEN || trimmedLen > MAX_REVIEW_COMMENT_LEN) {
      setLocalError(
        `Review comment must be between ${MIN_REVIEW_COMMENT_LEN} and ${MAX_REVIEW_COMMENT_LEN.toLocaleString()} characters.`
      );
      return;
    }
    void onSubmit({
      listingId: selectedListingId || activeItem?.listingId || null,
      rating,
      comment: comment.trim(),
      isAnonymous,
      imagePaths,
      videoPath,
    });
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="review-dialog-title"
      onClick={() => {
        if (!submitting) onClose();
      }}
      className="anim-backdrop-in fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-0 backdrop-blur-[2px] sm:items-center sm:p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="anim-modal-sheet flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-3xl border border-[#E6E3EE] bg-white shadow-2xl sm:max-w-[540px] sm:rounded-2xl"
      >
        {/* Header */}
        <header className="flex items-start justify-between gap-3 border-b border-[#ECEAF2] px-5 py-4">
          <div>
            <h2
              id="review-dialog-title"
              className="text-base font-extrabold text-[#14121A] sm:text-lg"
            >
              {isEditing ? "Edit Review" : "Rate & Review Purchase"}
            </h2>
            {orderCode ? (
              <p className="mt-0.5 text-xs font-medium text-[#6B6779]">
                Order #{orderCode}
              </p>
            ) : null}
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            disabled={submitting}
            onClick={onClose}
            aria-label="Close review dialog"
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-[#6B6779] transition-colors hover:bg-[#FAF9FC] hover:text-[#14121A] disabled:opacity-50"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <form onSubmit={handleFormSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
            {/* Multi-item picker when reviewing from an order with 2+ items */}
            {!isEditing && items.length > 1 ? (
              <div>
                <label
                  htmlFor="review-item-select"
                  className="block text-xs font-bold text-[#14121A]"
                >
                  Select Purchased Item
                </label>
                <select
                  id="review-item-select"
                  value={selectedListingId}
                  onChange={(e) => setSelectedListingId(e.target.value)}
                  className="mt-1.5 w-full rounded-xl border border-[#CFCBD9] bg-white px-3 py-2 text-xs font-semibold text-[#14121A] focus:border-[#4E2A84] focus:outline-none"
                >
                  {items.map((it) => (
                    <option key={it.id} value={it.listingId ?? ""}>
                      {it.title}
                      {it.variantLabel ? ` (${it.variantLabel})` : ""}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {/* Purchased Item Snapshot */}
            {activeItem ? (
              <div className="flex items-center gap-3 rounded-xl border border-[#ECEAF2] bg-[#FAF9FC] p-3">
                <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-[#E6E3EE] bg-white">
                  {activeItem.imageUrl ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={activeItem.imageUrl}
                      alt={activeItem.title}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <span className="grid h-full w-full place-items-center text-[#858094]">
                      <Package className="h-4 w-4" aria-hidden="true" />
                    </span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-extrabold text-[#14121A]">
                    {activeItem.title}
                  </p>
                  {activeItem.variantLabel ? (
                    <span className="mt-1 inline-block rounded-md bg-[#F4F1FA] px-2 py-0.5 text-[11px] font-bold text-[#4E2A84]">
                      {activeItem.variantLabel}
                    </span>
                  ) : activeItem.isService ? (
                    <span className="mt-1 inline-block rounded-md bg-[#EDFAF9] px-2 py-0.5 text-[11px] font-bold text-[#008386]">
                      Campus Service
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}

            {/* Interactive 5-Star Selector */}
            <div>
              <div className="flex items-center justify-between gap-2">
                <span id="review-star-label" className="text-xs font-bold text-[#14121A]">
                  Your Rating
                </span>
                <span
                  aria-live="polite"
                  className="text-xs font-extrabold text-[#4E2A84]"
                >
                  {getReviewStarLabel(displayedStar)} ({displayedStar}/5)
                </span>
              </div>

              <div
                role="radiogroup"
                aria-labelledby="review-star-label"
                className="mt-2 flex items-center gap-2"
              >
                {[1, 2, 3, 4, 5].map((star) => {
                  const active = star <= displayedStar;
                  return (
                    <button
                      key={star}
                      type="button"
                      role="radio"
                      aria-checked={rating === star}
                      aria-label={`${star} star${star === 1 ? "" : "s"} - ${getReviewStarLabel(star)}`}
                      onMouseEnter={() => setHoverRating(star)}
                      onMouseLeave={() => setHoverRating(null)}
                      onClick={() => setRating(star)}
                      onKeyDown={(e) => {
                        if (e.key === "ArrowRight" || e.key === "ArrowUp") {
                          e.preventDefault();
                          setRating(Math.min(5, rating + 1));
                        } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
                          e.preventDefault();
                          setRating(Math.max(1, rating - 1));
                        }
                      }}
                      className="press-feedback flex h-11 w-11 cursor-pointer items-center justify-center rounded-xl border border-[#ECEAF2] bg-[#FAF9FC] transition-colors hover:border-[#F4B400]/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4E2A84]"
                    >
                      <Star
                        className="h-6 w-6 transition-transform duration-150"
                        style={
                          active
                            ? { color: REVIEW_STAR_COLOR, fill: REVIEW_STAR_COLOR }
                            : { color: "#D5D0E0" }
                        }
                        aria-hidden="true"
                      />
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Comment Box */}
            <div>
              <div className="flex items-center justify-between gap-2">
                <label
                  htmlFor="review-comment-input"
                  className="text-xs font-bold text-[#14121A]"
                >
                  Your Honest Review
                </label>
                <span
                  className={`text-[11px] font-semibold ${
                    trimmedLen > MAX_REVIEW_COMMENT_LEN
                      ? "text-[#B42318]"
                      : trimmedLen >= MIN_REVIEW_COMMENT_LEN
                        ? "text-[#006A6D]"
                        : "text-[#6B6779]"
                  }`}
                >
                  {trimmedLen} / {MAX_REVIEW_COMMENT_LEN}
                </span>
              </div>
              <textarea
                id="review-comment-input"
                rows={4}
                maxLength={MAX_REVIEW_COMMENT_LEN}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Share quality, condition accuracy, and campus handover experience..."
                className="mt-1.5 w-full rounded-xl border border-[#CFCBD9] bg-white px-3.5 py-2.5 text-sm text-[#14121A] placeholder:text-[#8E899E] focus:border-[#4E2A84] focus:outline-none"
              />
            </div>

            {/* Optional Media Attachments */}
            <ReviewMediaUploader
              reviewId={initialReview?.id}
              initialImagePaths={initialReview?.imagePaths}
              initialVideoPath={initialReview?.videoPath}
              disabled={submitting}
              onMediaChange={({ imagePaths: nextImgs, videoPath: nextVid, isUploading }) => {
                setImagePaths(nextImgs);
                setVideoPath(nextVid);
                setIsMediaUploading(isUploading);
              }}
            />

            {/* Anonymous Toggle */}
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-[#ECEAF2] bg-[#FAF9FC] p-3">
              <input
                type="checkbox"
                checked={isAnonymous}
                onChange={(e) => setIsAnonymous(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-[#CFCBD9] accent-[#4E2A84]"
              />
              <span className="min-w-0 flex-1 text-xs">
                <span className="flex items-center gap-1.5 font-bold text-[#14121A]">
                  <EyeOff className="h-3.5 w-3.5 text-[#4E2A84]" aria-hidden="true" />
                  <span>Review anonymously</span>
                </span>
                <span className="mt-0.5 block text-[11px] text-[#6B6779]">
                  {isAnonymous
                    ? `Your review will appear publicly as "${maskedPreview}" with an anonymous avatar.`
                    : "Your display name and profile picture will appear alongside your review."}
                </span>
              </span>
            </label>

            {localError || errorMessage ? (
              <p role="alert" className="rounded-xl bg-[#FEF2F2] px-3 py-2 text-xs font-semibold text-[#B42318]">
                {localError || errorMessage}
              </p>
            ) : null}
          </div>

          {/* Sticky Footer */}
          <footer className="flex items-center justify-end gap-2.5 border-t border-[#ECEAF2] bg-white px-5 py-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))]">
            <button
              type="button"
              disabled={submitting}
              onClick={onClose}
              className="min-h-10 cursor-pointer rounded-xl border border-[#CFCBD9] bg-white px-4 py-2 text-xs font-bold text-[#14121A] hover:border-[#4E2A84] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || isMediaUploading}
              className="press-feedback inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-xl bg-[#4E2A84] px-5 py-2 text-xs font-bold text-white shadow-[0_2px_6px_rgba(78,42,132,0.2)] hover:bg-[#3A1E66] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Star className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>
                {isMediaUploading
                  ? "Checking media..."
                  : isEditing
                    ? "Save Changes"
                    : "Publish Review"}
              </span>
            </button>
          </footer>
        </form>
      </div>
    </div>,
    document.body
  );
}
