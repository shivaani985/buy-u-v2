import { formatFoodDate } from "@/lib/food";
import Link from "next/link";
import { ArrowUpRight, Package, X } from "lucide-react";
import { formatSenToRm, resolvePublicStorageUrl } from "@/lib/format";
import { chatContextLabels, type ChatReference } from "@/lib/messages/context";
import { formatVariationOptionLabel } from "@/lib/seller/variations";
import { getPublicSupabaseEnv } from "@/lib/supabase/env";

export function ChatReferenceCard({ reference, conversationId, onRemove, now, disabled, draftKey }: {
  reference: ChatReference;
  conversationId: string;
  onRemove?: () => void;
  now?: number;
  disabled?: boolean;
  draftKey?: string;
}) {
  const labels = chatContextLabels[reference.kind];
  const expired = Boolean(reference.expiresAt && now && Date.parse(reference.expiresAt) <= now);
  const unavailable = expired ? "Free Item Expired" : reference.unavailable;
  const image = unavailable ? null : reference.imageUrl ??
    resolvePublicStorageUrl("listings", reference.imagePath, getPublicSupabaseEnv()?.url);
  const price = reference.kind === "free" ? "FREE" : typeof reference.priceMinSen === "number"
    ? reference.priceMaxSen != null && reference.priceMaxSen > reference.priceMinSen
      ? `${formatSenToRm(reference.priceMinSen)} – ${formatSenToRm(reference.priceMaxSen)}`
      : formatSenToRm(reference.priceMinSen)
    : null;
  const variation = reference.variation ? formatVariationOptionLabel(reference.variation) : null;
  const quantity = reference.quantity == null ? null : reference.itemId
    ? `Qty ${reference.quantity}` : `${reference.quantity} ${reference.quantity === 1 ? "item" : "items"}`;
  const status = reference.availability?.replaceAll("_", " ");
  const offerHref = !disabled && reference.canBargain && `/messages?${new URLSearchParams({
    c: conversationId, listing: reference.targetId, bargain: "1",
    ...(reference.variantId ? { variant: reference.variantId } : {}),
    ...(draftKey ? { ref: reference.kind, target: reference.targetId, draft: draftKey } : {}),
  })}`;
  const viewHref = !disabled && !onRemove && reference.href;

  return (
    <div className="flex min-w-0 items-start gap-2.5 rounded-xl border border-[#E6E3EE] bg-white p-2.5 text-[#1D1D1F]">
      <div className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-lg bg-[#F4F1FA] text-[#4E2A84]">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt="" loading="lazy" className="size-full object-cover" />
        ) : <Package aria-hidden="true" className="size-5" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-bold leading-4 text-[#4E2A84]">{labels.inquiry}</p>
        {reference.title && <p className="break-words text-sm font-bold leading-5">{reference.title}</p>}
        {unavailable ? <p className="text-xs font-semibold text-[#6B6779]">{unavailable}</p> : (
          <>
            <p className="break-words text-xs leading-5 text-[#6B6779]">
              {[reference.itemId && reference.code, variation, quantity, price].filter(Boolean).join(" · ")}
            </p>
            {reference.pickup && <p className="break-words text-xs text-[#6B6779]">{reference.pickup}</p>}
            {reference.foodCutoff && <p className="text-xs text-ink-secondary">Order by {formatFoodDate(reference.foodCutoff)}</p>}
            {reference.foodPickupStart && reference.foodPickupEnd && <p className="text-xs text-ink-secondary">
              Collect {formatFoodDate(reference.foodPickupStart)} – {formatFoodDate(reference.foodPickupEnd)}
            </p>}
            {status && <p className="text-xs capitalize text-[#6B6779]">{status}</p>}
            {(viewHref || offerHref) && <div className="mt-1 flex flex-wrap items-center gap-x-3">
              {viewHref && <Link href={viewHref} className="inline-flex min-h-8 items-center gap-1 text-xs font-bold text-[#4E2A84] hover:underline">
                {labels.view}<ArrowUpRight aria-hidden="true" className="size-3" />
              </Link>}
              {offerHref && <Link href={offerHref} className="inline-flex min-h-8 items-center text-xs font-bold text-[#4E2A84] hover:underline">
                Make an offer
              </Link>}
            </div>}
          </>
        )}
      </div>
      {onRemove && <button type="button" onClick={onRemove} disabled={disabled} aria-label="Remove reference"
        className="grid size-9 shrink-0 place-items-center rounded-lg text-[#6B6779] hover:bg-[#F4F1FA] disabled:opacity-50">
        <X aria-hidden="true" className="size-4" />
      </button>}
    </div>
  );
}
