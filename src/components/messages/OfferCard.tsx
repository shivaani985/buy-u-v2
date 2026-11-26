"use client";

import { useState } from "react";
import { AlertCircle, Clock, ExternalLink, Loader2, Tag, X } from "lucide-react";
import {
  formatRemainingDuration,
  getOfferProposerId,
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
  onCounter?: (
    offerId: string,
    amountRm: string
  ) => Promise<{ ok: boolean; error?: string }>;
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
  onCounter,
  onPay,
}: OfferCardProps) {
  const [counterOpen, setCounterOpen] = useState(false);
  const [counterAmountRm, setCounterAmountRm] = useState("");
  const [counterLocalError, setCounterLocalError] = useState<string | null>(null);

  const actor = currentUserId.toLowerCase();
  const isBuyer = offer.buyerId.toLowerCase() === actor;
  const isSeller = offer.sellerId.toLowerCase() === actor;
  const isProposer = getOfferProposerId(offer).toLowerCase() === actor;
  const isReceiver = (isBuyer || isSeller) && !isProposer;
  const effectiveStatus = resolveEffectiveOfferStatus(offer, nowMs);

  const remainingText =
    effectiveStatus === "pending"
      ? formatRemainingDuration(offer.expiresAt, nowMs)
      : effectiveStatus === "accepted" && !offer.orderId
        ? formatRemainingDuration(offer.reservationExpiresAt, nowMs)
        : null;

  let statusLabel = offer.parentOfferId ? "Counter Offer" : "Pending Offer";
  let statusColor = "text-[#1D70B8]";
  if (effectiveStatus === "accepted") {
    statusLabel = "Accepted · 30m Hold";
    statusColor = "text-[#008285]";
  } else if (effectiveStatus === "superseded") {
    statusLabel = "Superseded";
    statusColor = "text-[#6B6779]";
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

  const actionVerb = offer.parentOfferId ? "countered" : "offered";
  const displayError = error || counterLocalError;

  async function handleSubmitCounter(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!onCounter || isBusy) return;
    setCounterLocalError(null);
    const res = await onCounter(offer.id, counterAmountRm);
    if (res.ok) {
      setCounterAmountRm("");
      setCounterOpen(false);
    } else if (res.error) {
      setCounterLocalError(res.error);
    }
  }

  return (
    <div
      className={`flex flex-col ${isProposer ? "items-end" : "items-start"}`}
      data-offer-id={offer.id}
    >
      <div
        className={`w-full max-w-[330px] rounded-2xl border border-[#E6E3EE] bg-white p-3.5 sm:p-4 ${
          effectiveStatus === "superseded" ? "opacity-75" : ""
        }`}
      >
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="inline-flex items-center gap-1 font-semibold text-[#6B6779]">
            <Tag className="h-3.5 w-3.5 text-[#4E2A84]" aria-hidden="true" />
            <span>
              {isProposer ? `You ${actionVerb}` : `${peerName} ${actionVerb}`}
            </span>
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

        {/* Receiving party actions on unexpired pending proposal */}
        {effectiveStatus === "pending" && isReceiver ? (
          <div className="mt-3 space-y-2 border-t border-[#ECEAF3] pt-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                disabled={isBusy}
                onClick={() => onAccept(offer.id)}
                className="inline-flex min-w-[76px] flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#4E2A84] px-2.5 py-2 text-xs font-bold text-white transition hover:bg-[#3F216B] disabled:opacity-50"
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
                className="inline-flex min-w-[76px] flex-1 items-center justify-center rounded-xl border border-[#DCD9E6] bg-white px-2.5 py-2 text-xs font-semibold text-[#14121A] transition hover:border-[#B42318] hover:text-[#B42318] disabled:opacity-50"
              >
                Decline
              </button>
              {onCounter ? (
                <button
                  type="button"
                  disabled={isBusy}
                  aria-expanded={counterOpen}
                  onClick={() => {
                    setCounterLocalError(null);
                    setCounterOpen((v) => !v);
                  }}
                  className={`inline-flex min-w-[100px] flex-1 items-center justify-center whitespace-nowrap rounded-xl border px-2.5 py-2 text-xs font-semibold transition disabled:opacity-50 ${
                    counterOpen
                      ? "border-[#4E2A84] bg-[#4E2A84]/10 text-[#4E2A84]"
                      : "border-[#4E2A84]/35 bg-[#F4F1FA] text-[#4E2A84] hover:bg-[#4E2A84] hover:text-white"
                  }`}
                >
                  Counter Offer
                </button>
              ) : null}
            </div>

            {counterOpen && onCounter ? (
              <form
                onSubmit={handleSubmitCounter}
                className="flex items-center gap-1.5 rounded-xl border border-[#E6E3EE] bg-[#FAF9FC] p-1.5"
              >
                <label htmlFor={`counter-input-${offer.id}`} className="sr-only">
                  Counter offer amount in RM
                </label>
                <span className="pl-1.5 text-xs font-bold text-[#4E2A84]">
                  RM
                </span>
                <input
                  id={`counter-input-${offer.id}`}
                  type="text"
                  inputMode="decimal"
                  value={counterAmountRm}
                  onChange={(e) => setCounterAmountRm(e.target.value)}
                  disabled={isBusy}
                  placeholder="0.00"
                  aria-label="Counter offer price in RM"
                  className="h-8 min-w-0 flex-1 bg-white rounded-lg border border-[#DCD9E6] px-2 text-xs font-semibold text-[#14121A] placeholder:text-[#9893A6] focus:border-[#4E2A84] focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={isBusy || !counterAmountRm.trim()}
                  className="inline-flex h-8 shrink-0 items-center justify-center rounded-lg bg-[#4E2A84] px-2.5 text-xs font-bold text-white transition hover:bg-[#3F216B] disabled:opacity-50"
                >
                  {isBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    "Send"
                  )}
                </button>
                <button
                  type="button"
                  disabled={isBusy}
                  aria-label="Close counter offer input"
                  onClick={() => {
                    setCounterOpen(false);
                    setCounterLocalError(null);
                  }}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[#6B6779] transition hover:bg-[#ECEAF3] hover:text-[#14121A]"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </form>
            ) : null}
          </div>
        ) : null}

        {/* Proposer action on their own unexpired pending proposal */}
        {effectiveStatus === "pending" && isProposer ? (
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
              <span>{offer.parentOfferId ? "Cancel Counter Offer" : "Cancel Offer"}</span>
            </button>
          </div>
        ) : null}

        {displayError ? (
          <p
            role="alert"
            className="mt-2.5 flex items-start gap-1.5 border-t border-[#F1EFF6] pt-2 text-[11px] font-semibold text-[#B42318]"
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{displayError}</span>
          </p>
        ) : null}
      </div>

      <span className="mt-1 px-1 text-[11px] text-[#6B6779]">
        {formatOfferTime(offer.createdAt)}
      </span>
    </div>
  );
}
