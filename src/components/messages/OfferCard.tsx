"use client";

import { AlertCircle, Clock, ExternalLink, Loader2, Tag } from "lucide-react";
import {
  formatRemainingDuration,
  resolveEffectiveOfferStatus,
  type OfferCardItem,
} from "@/lib/messages/offers";
import { formatSenToRm } from "@/lib/format";

interface OfferCardProps {
  offer: OfferCardItem;
  currentUserId: string;
  peerName: string;
  listingTitle?: string | null;
  nowMs: number;
  isBusy: boolean;
  error?: string | null;
  onAccept: (offerId: string) => void;
  onDecline: (offerId: string) => void;
  onCancel: (offerId: string) => void;
  onPay?: (offerId: string) => void;
}

function formatOfferTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-MY", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

export function OfferCard({
  offer,
  currentUserId,
  peerName,
  listingTitle,
  nowMs,
  isBusy,
  error,
  onAccept,
  onDecline,
  onCancel,
  onPay,
}: OfferCardProps) {
  const isBuyer = offer.buyerId.toLowerCase() === currentUserId.toLowerCase();
  const isSeller = offer.sellerId.toLowerCase() === currentUserId.toLowerCase();
  const effectiveStatus = resolveEffectiveOfferStatus(offer, nowMs);

  const remainingText =
    effectiveStatus === "pending"
      ? formatRemainingDuration(offer.expiresAt, nowMs)
      : effectiveStatus === "accepted" && !offer.orderId
        ? formatRemainingDuration(offer.reservationExpiresAt, nowMs)
        : null;

  let statusLabel = "Pending Offer";
  let statusColor = "text-[#1D70B8]";
  if (effectiveStatus === "accepted") {
    statusLabel = "Accepted · 30m Hold";
    statusColor = "text-[#008285]";
  } else if (effectiveStatus === "declined") {
    statusLabel = "Declined";
    statusColor = "text-[#B42318]";
  } else if (effectiveStatus === "cancelled") {
    statusLabel = "Cancelled";
    statusColor = "text-[#6B6779]";
  } else if (effectiveStatus === "expired") {
    statusLabel = "Expired";
    statusColor = "text-[#6B6779]";
  }

  return (
    <div
      className={`flex flex-col ${isBuyer ? "items-end" : "items-start"}`}
      data-offer-id={offer.id}
    >
      <div className="w-full max-w-[330px] rounded-2xl border border-[#E6E3EE] bg-white p-3.5 sm:p-4">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="inline-flex items-center gap-1 font-semibold text-[#6B6779]">
            <Tag className="h-3.5 w-3.5 text-[#4E2A84]" aria-hidden="true" />
            <span>{isBuyer ? "You offered" : `${peerName} offered`}</span>
          </span>
          <span className={`font-bold ${statusColor}`}>{statusLabel}</span>
        </div>

        <div className="mt-2 flex items-center gap-3">
          {offer.variantImageUrl ? (
            <div className="h-11 w-11 shrink-0 overflow-hidden rounded-xl border border-[#E6E3EE] bg-[#F7F6FA]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={offer.variantImageUrl}
                alt={offer.variantLabel || listingTitle || "Listing photo"}
                className="h-full w-full object-cover"
              />
            </div>
          ) : null}
          <div className="min-w-0 flex-1">
            <p className="text-xl font-extrabold tracking-tight text-[#4E2A84]">
              {formatSenToRm(offer.offerPriceSen)}
            </p>
            {listingTitle ? (
              <p className="mt-0.5 truncate text-xs text-[#4A4656]">
                {listingTitle}
              </p>
            ) : null}
            {offer.variantLabel ? (
              <p className="mt-1 inline-block rounded-md bg-[#F4F1FA] px-2 py-0.5 text-[11px] font-semibold text-[#4E2A84]">
                Variation: {offer.variantLabel}
              </p>
            ) : null}
          </div>
        </div>

        {remainingText ? (
          <p className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-[#6B6779]">
            <Clock className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span>
              {effectiveStatus === "pending"
                ? `Expires: ${remainingText}`
                : `Reservation hold: ${remainingText}`}
            </span>
          </p>
        ) : null}

        {effectiveStatus === "accepted" ? (
          <div className="mt-3 border-t border-[#ECEAF3] pt-2.5 text-xs text-[#4A4656]">
            <p className="font-semibold text-[#14121A]">
              {isBuyer
                ? "Offer accepted — complete FPX payment"
                : "Offer accepted — awaiting buyer payment"}
            </p>
            <p className="mt-0.5 text-[11px] text-[#6B6779]">
              1 unit held for 30 minutes at locked price (+ RM 1.00 FPX fee).
            </p>
            {isBuyer && onPay ? (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => onPay(offer.id)}
                className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-[#4E2A84] px-3 py-2 text-xs font-bold text-white transition hover:bg-[#3F216B] disabled:opacity-50"
              >
                {isBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                <span>
                  {isBusy ? "Opening ToyyibPay..." : "Pay with ToyyibPay FPX"}
                </span>
              </button>
            ) : null}
          </div>
        ) : null}

        {/* Seller actions on unexpired pending offer */}
        {effectiveStatus === "pending" && isSeller ? (
          <div className="mt-3 flex items-center gap-2 border-t border-[#ECEAF3] pt-3">
            <button
              type="button"
              disabled={isBusy}
              onClick={() => onAccept(offer.id)}
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#4E2A84] px-3 py-2 text-xs font-bold text-white transition hover:bg-[#3F216B] disabled:opacity-50"
            >
              {isBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : null}
              <span>Accept</span>
            </button>
            <button
              type="button"
              disabled={isBusy}
              onClick={() => onDecline(offer.id)}
              className="inline-flex flex-1 items-center justify-center rounded-xl border border-[#DCD9E6] bg-white px-3 py-2 text-xs font-semibold text-[#14121A] transition hover:border-[#B42318] hover:text-[#B42318] disabled:opacity-50"
            >
              Decline
            </button>
          </div>
        ) : null}

        {/* Buyer action on unexpired pending offer */}
        {effectiveStatus === "pending" && isBuyer ? (
          <div className="mt-3 border-t border-[#ECEAF3] pt-2.5">
            <button
              type="button"
              disabled={isBusy}
              onClick={() => onCancel(offer.id)}
              className="inline-flex items-center gap-1 text-xs font-semibold text-[#B42318] transition hover:underline disabled:opacity-50"
            >
              {isBusy ? (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              ) : null}
              <span>Cancel Offer</span>
            </button>
          </div>
        ) : null}

        {error ? (
          <p
            role="alert"
            className="mt-2.5 flex items-start gap-1.5 border-t border-[#F1EFF6] pt-2 text-[11px] font-semibold text-[#B42318]"
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </p>
        ) : null}
      </div>

      <span className="mt-1 px-1 text-[11px] text-[#6B6779]">
        {formatOfferTime(offer.createdAt)}
      </span>
    </div>
  );
}
