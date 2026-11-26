"use client";

import { EyeOff, Pencil, ShieldCheck, Star } from "lucide-react";
import { ReviewGallery } from "@/components/reviews/ReviewGallery";
import type { PublicReviewItem } from "@/lib/reviews/presentation";
import { REVIEW_STAR_COLOR } from "@/lib/reviews/validation";

function formatMytReviewDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return `${new Intl.DateTimeFormat("en-MY", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kuala_Lumpur",
  }).format(parsed)} MYT`;
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "BU";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]!.charAt(0)}${parts[1]!.charAt(0)}`.toUpperCase();
}

interface ReviewCardProps {
  review: PublicReviewItem;
  onEdit?: (review: PublicReviewItem) => void;
}

export function ReviewCard({ review, onEdit }: ReviewCardProps) {
  return (
    <article className="rounded-2xl border border-[#ECEAF2] bg-white p-4 shadow-[0_1px_3px_rgba(20,18,26,0.03)]">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {review.isAnonymous ? (
            <div
              aria-hidden="true"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[#E6E3EE] bg-[#F4F1FA] text-[#4E2A84]"
            >
              <EyeOff className="h-4 w-4" />
            </div>
          ) : review.reviewerAvatarUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={review.reviewerAvatarUrl}
              alt={review.reviewerDisplayName}
              className="h-10 w-10 shrink-0 rounded-full border border-[#E6E3EE] object-cover"
            />
          ) : (
            <div
              aria-hidden="true"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#EFEAF8] text-xs font-extrabold text-[#4E2A84]"
            >
              {getInitials(review.reviewerDisplayName)}
            </div>
          )}

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <p className="truncate text-sm font-extrabold text-[#14121A]">
                {review.reviewerDisplayName}
              </p>
              <span className="inline-flex items-center gap-1 rounded-md bg-[#F4F1FA] px-2 py-0.5 text-[10px] font-bold text-[#4E2A84]">
                <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                {review.isVerifiedService ? "Verified Service" : "Verified Purchase"}
              </span>
              {review.isEdited ? (
                <span className="rounded-md bg-[#F4F3F7] px-1.5 py-0.5 text-[10px] font-semibold text-[#555062]">
                  Edited
                </span>
              ) : null}
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-2">
              <div
                className="flex items-center gap-0.5"
                aria-label={`${review.rating} out of 5 stars`}
              >
                {[1, 2, 3, 4, 5].map((star) => (
                  <Star
                    key={star}
                    className="h-3.5 w-3.5"
                    style={
                      star <= review.rating
                        ? { color: REVIEW_STAR_COLOR, fill: REVIEW_STAR_COLOR }
                        : { color: "#D5D0E0" }
                    }
                    aria-hidden="true"
                  />
                ))}
              </div>
              <span className="text-[11px] font-medium text-[#6B6779]">
                {formatMytReviewDate(review.editedAt ?? review.createdAt)}
              </span>
            </div>
          </div>
        </div>

        {review.canEdit && onEdit ? (
          <button
            type="button"
            onClick={() => onEdit(review)}
            className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-lg border border-[#E6E3EE] bg-[#FAF9FC] px-2.5 py-1 text-[11px] font-bold text-[#4E2A84] transition-colors hover:border-[#4E2A84] hover:bg-white"
          >
            <Pencil className="h-3 w-3" aria-hidden="true" />
            <span>Edit Review</span>
          </button>
        ) : null}
      </div>

      {review.purchasedVariantLabel ? (
        <div className="mt-2.5">
          <span className="inline-block rounded-md bg-[#F5F4F8] px-2 py-0.5 text-[11px] font-semibold text-[#555062]">
            Variation: {review.purchasedVariantLabel}
          </span>
        </div>
      ) : null}

      {review.comment ? (
        <p className="mt-2.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-[#14121A]">
          {review.comment}
        </p>
      ) : null}

      <ReviewGallery media={review.media} />

      {review.sellerResponse ? (
        <div className="mt-3 rounded-xl border border-[#D8ECEC] bg-[#F4FBFB] px-3.5 py-2.5 text-xs text-[#2E4849]">
          <p className="font-extrabold text-[#006A6D]">Seller Response</p>
          <p className="mt-1 whitespace-pre-wrap break-words">{review.sellerResponse}</p>
        </div>
      ) : null}
    </article>
  );
}
