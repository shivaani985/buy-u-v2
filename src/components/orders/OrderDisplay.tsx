import Link from "next/link";
import { ArrowLeft, Package } from "lucide-react";
import type { ReactNode } from "react";
import { formatSenToRm } from "@/lib/format";
import { formatMytDateTime } from "@/lib/financials/policy";
import type { OrderStatusBadge } from "@/lib/orders/lifecycle";
import { ListingImage } from "@/components/shared/ListingImage";

export const orderButton =
  "inline-flex min-h-10 cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-[#CFCBD9] bg-white px-3.5 py-2 text-xs font-bold text-[#14121A] transition-colors hover:border-[#4E2A84] hover:text-[#4E2A84] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4E2A84] disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm press-feedback";
export const orderPrimary =
  "inline-flex min-h-10 cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-[#4E2A84] px-4 py-2 text-xs font-bold text-white shadow-[0_2px_6px_rgba(78,42,132,0.2)] transition-colors hover:bg-[#3A1E66] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4E2A84] disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm press-feedback";
export const orderPanel =
  "min-w-0 overflow-hidden rounded-2xl border border-[#E6E3EE] bg-white shadow-[0_1px_4px_rgba(20,18,26,0.03)]";

export interface OrderDisplayItem {
  id: string;
  title: string;
  variantLabel: string | null;
  quantity: number;
  unitSen: number;
  imageUrl: string | null;
  isService: boolean;
}

export function OrderBadge({ badge }: { badge: OrderStatusBadge }) {
  return (
    <span
      className={`inline-flex items-center rounded-lg border px-2.5 py-1 text-xs font-bold ${badge.toneClass}`}
    >
      {badge.label}
    </span>
  );
}

export function OrderItems({ items, compact = false }: { items: OrderDisplayItem[]; compact?: boolean }) {
  const visible = compact ? items.slice(0, 1) : items;
  return (
    <ul className="divide-y divide-[#F0EDF5]">
      {visible.map((item) => (
        <li key={item.id} className="flex min-w-0 items-center gap-3.5 py-3.5">
          <div
            className={`shrink-0 overflow-hidden rounded-xl border border-[#ECEAF2] bg-[#F5F4F8] ${
              compact ? "size-14 sm:size-16" : "size-16"
            }`}
          >
            <ListingImage
              src={item.imageUrl}
              alt={item.title}
              fallback={
                <span className="grid size-full place-items-center text-[#6E6A7C]">
                  <Package className="size-5" aria-hidden="true" />
                </span>
              }
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <p className="break-words text-sm font-extrabold text-[#14121A]">
                {item.title}
              </p>
              {item.isService ? (
                <span className="inline-block rounded-md bg-[#EDFAF9] px-1.5 py-0.5 text-[10.5px] font-bold text-[#008386]">
                  Service
                </span>
              ) : null}
            </div>
            {item.variantLabel && (
              <span className="mt-1 inline-block break-words rounded-md bg-[#F4F1FA] px-2 py-0.5 text-[11px] font-bold text-[#4E2A84]">
                {item.variantLabel}
              </span>
            )}
            <p className="tabular-nums mt-1 text-xs font-medium text-[#6E6A7C]">
              {item.quantity} &times; {formatSenToRm(item.unitSen)}
            </p>
          </div>
          <span
            className={`tabular-price shrink-0 text-sm font-extrabold text-[#14121A] ${
              compact ? "hidden sm:block" : "block"
            }`}
          >
            {formatSenToRm(item.quantity * item.unitSen)}
          </span>
        </li>
      ))}
      {compact && items.length > visible.length && (
        <li className="py-2.5 text-xs font-semibold text-[#6E6A7C]">
          +{items.length - visible.length} more{" "}
          {items.length - visible.length === 1 ? "item" : "items"} in this order
        </li>
      )}
    </ul>
  );
}

export function OrderDetailsLayout({
  back,
  backLabel,
  code,
  name,
  date,
  badge,
  actions,
  children,
  aside,
}: {
  back: string;
  backLabel: string;
  code: string;
  name: string;
  date: string;
  badge: OrderStatusBadge;
  actions?: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="bg-[#FAFAFC]">
      <div className="bori-container py-6 lg:py-8">
        <Link
          href={back}
          className="inline-flex items-center gap-1.5 text-xs font-bold text-[#4E2A84] hover:underline sm:text-sm"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          <span>{backLabel}</span>
        </Link>
        <header className="mt-2 mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-[#E6E3EE] pb-4">
          <div className="min-w-0">
            <h1 className="break-words text-2xl font-extrabold italic tracking-[-0.02em] text-[#111018] sm:text-3xl">
              Order{" "}
              <span className="inline-block bg-[#4E2A84] px-3 py-0.5 font-mono text-white hero-marketplace-slab">
                #{code}
              </span>
            </h1>
            <p className="mt-1.5 break-words text-sm text-[#555062]">
              {name} &middot; {formatMytDateTime(date)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <OrderBadge badge={badge} />
            {actions}
          </div>
        </header>
        <div
          className={
            aside ? "grid gap-5 lg:grid-cols-[minmax(0,13fr)_minmax(0,7fr)]" : "max-w-3xl"
          }
        >
          <div className="min-w-0 space-y-4">{children}</div>
          {aside && <aside className="min-w-0 space-y-4">{aside}</aside>}
        </div>
      </div>
    </div>
  );
}

export function OrderSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={`${orderPanel} px-4 py-4 sm:px-5`}>
      <h2 className="mb-2.5 text-base font-extrabold italic tracking-[-0.01em] text-[#111018]">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function OrderAmounts({
  subtotal,
  fpxFee,
  total,
  totalLabel = "Order amount",
}: {
  subtotal: number;
  fpxFee: number;
  total: number;
  totalLabel?: string;
}) {
  return (
    <dl className="space-y-2 text-sm text-[#3E3B4B]">
      <div className="flex justify-between gap-3">
        <dt>Item subtotal</dt>
        <dd className="tabular-price font-semibold">{formatSenToRm(subtotal)}</dd>
      </div>
      {fpxFee > 0 && (
        <div className="flex justify-between gap-3">
          <dt>FPX fee</dt>
          <dd className="tabular-price font-semibold">{formatSenToRm(fpxFee)}</dd>
        </div>
      )}
      <div className="flex justify-between gap-3 border-t border-[#ECEAF2] pt-2.5 font-extrabold text-[#14121A]">
        <dt>{totalLabel}</dt>
        <dd className="tabular-price text-base text-[#4E2A84]">{formatSenToRm(total)}</dd>
      </div>
    </dl>
  );
}
