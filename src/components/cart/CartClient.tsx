"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowRight,
  Check,
  Loader2,
  MapPin,
  Minus,
  Plus,
  RefreshCw,
  ShieldCheck,
  ShoppingBag,
  ShoppingCart,
  Store,
  Trash2,
} from "lucide-react";
import {
  removeCartItemAction,
  updateCartItemQuantityAction,
} from "@/app/cart/actions";
import type { CartItemView, CartSummary } from "@/lib/buyer/cart";
import { formatSenToRm } from "@/lib/format";

interface CartClientProps {
  summary: CartSummary;
}

interface RowFeedback {
  type: "error" | "info" | "success";
  message: string;
  retryQuantity?: number;
}

function getInitials(name: string): string {
  const [first, second] = name.trim().split(/\s+/).filter(Boolean);
  if (!first) return "BU";
  if (!second) return first.slice(0, 2).toUpperCase();
  return `${first.charAt(0)}${second.charAt(0)}`.toUpperCase();
}

export function CartClient({ summary }: CartClientProps) {
  const router = useRouter();
  const [isNavigating, startNavTransition] = useTransition();
  const [busyIds, setBusyIds] = useState<Record<string, boolean>>({});
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [draftQuantities, setDraftQuantities] = useState<Record<string, string>>(
    {}
  );
  const [rowFeedback, setRowFeedback] = useState<Record<string, RowFeedback>>(
    {}
  );

  function setBusy(id: string, busy: boolean) {
    setBusyIds((prev) => ({ ...prev, [id]: busy }));
  }

  function clearDraft(id: string) {
    setDraftQuantities((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  async function handleQuantityChange(
    item: CartItemView,
    nextQuantity: number
  ) {
    if (busyIds[item.id]) return;

    if (!Number.isInteger(nextQuantity) || nextQuantity < 1) {
      setRowFeedback((prev) => ({
        ...prev,
        [item.id]: {
          type: "error",
          message: "Enter a whole number of at least 1.",
        },
      }));
      clearDraft(item.id);
      return;
    }

    if (nextQuantity === item.quantity && item.isValid) {
      clearDraft(item.id);
      return;
    }

    setBusy(item.id, true);
    setConfirmRemoveId(null);
    setRowFeedback((prev) => {
      const next = { ...prev };
      delete next[item.id];
      return next;
    });

    try {
      const result = await updateCartItemQuantityAction({
        cartItemId: item.id,
        quantity: nextQuantity,
        expectedUnitPriceSen: item.unitPriceSen,
      });

      clearDraft(item.id);

      if (!result.ok) {
        setRowFeedback((prev) => ({
          ...prev,
          [item.id]: {
            type: "error",
            message: result.error || "Could not update quantity.",
            retryQuantity: nextQuantity,
          },
        }));
      } else {
        setRowFeedback((prev) => ({
          ...prev,
          [item.id]: {
            type: result.priceChanged ? "info" : "success",
            message: result.message || `Updated quantity to ${nextQuantity}.`,
          },
        }));
      }

      startNavTransition(() => {
        router.refresh();
      });
    } catch {
      setRowFeedback((prev) => ({
        ...prev,
        [item.id]: {
          type: "error",
          message: "Network error while updating quantity. Please retry.",
          retryQuantity: nextQuantity,
        },
      }));
    } finally {
      setBusy(item.id, false);
    }
  }

  async function handleRemove(item: CartItemView) {
    if (busyIds[item.id]) return;

    setBusy(item.id, true);
    setRowFeedback((prev) => {
      const next = { ...prev };
      delete next[item.id];
      return next;
    });

    try {
      const result = await removeCartItemAction(item.id);
      if (!result.ok) {
        setRowFeedback((prev) => ({
          ...prev,
          [item.id]: {
            type: "error",
            message: result.error || "Could not remove this item.",
          },
        }));
      } else {
        setConfirmRemoveId(null);
      }

      startNavTransition(() => {
        router.refresh();
      });
    } catch {
      setRowFeedback((prev) => ({
        ...prev,
        [item.id]: {
          type: "error",
          message: "Network error while removing item. Please retry.",
        },
      }));
    } finally {
      setBusy(item.id, false);
    }
  }

  function commitDirectInput(item: CartItemView) {
    const raw = draftQuantities[item.id];
    if (raw === undefined) return;
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) {
      setRowFeedback((prev) => ({
        ...prev,
        [item.id]: {
          type: "error",
          message: "Enter a valid whole number quantity.",
        },
      }));
      clearDraft(item.id);
      return;
    }
    const parsed = Number.parseInt(trimmed, 10);
    void handleQuantityChange(item, parsed);
  }

  // Empty cart state
  if (summary.totalRowCount === 0) {
    return (
      <section className="rounded-2xl border border-[#E6E3EE] bg-white px-6 py-12 text-center sm:py-16">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-[#E6E3EE] bg-[#FAF9FC] text-[#4E2A84]">
          <ShoppingCart className="h-6 w-6" aria-hidden="true" />
        </div>
        <h2 className="mt-4 text-lg font-bold text-[#14121A]">
          Your shopping cart is empty
        </h2>
        <p className="mx-auto mt-1.5 max-w-md text-sm text-[#6B6779]">
          Browse pre-loved items, student business goods, and campus food from
          verified UMSKAL student sellers.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/marketplace"
            className="inline-flex items-center gap-2 rounded-xl bg-[#4E2A84] px-5 py-2.5 text-sm font-bold text-white transition hover:bg-[#3F216B] active:scale-[0.98]"
          >
            <ShoppingBag className="h-4 w-4" aria-hidden="true" />
            <span>Browse Marketplace</span>
          </Link>
        </div>
      </section>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:items-start lg:gap-8">
      {/* Left column: Seller-grouped cart items */}
      <div className="space-y-5 lg:col-span-8">
        {summary.hasIssues ? (
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-2xl border border-[#E6E3EE] bg-white px-5 py-4 text-sm text-[#3E3A4A]"
          >
            <AlertCircle
              className="mt-0.5 h-4 w-4 shrink-0 text-[#B42318]"
              aria-hidden="true"
            />
            <p>
              <strong className="font-bold text-[#B42318]">
                {summary.invalidRowCount}{" "}
                {summary.invalidRowCount === 1 ? "item needs" : "items need"}{" "}
                attention.
              </strong>{" "}
              Unavailable or over-stock items are excluded from subtotals until
              adjusted or removed.
            </p>
          </div>
        ) : null}

        {summary.groups.map((group) => (
          <section
            key={group.sellerId}
            aria-label={`Items from ${group.sellerName}`}
            className="overflow-hidden rounded-2xl border border-[#E6E3EE] bg-white"
          >
            {/* Seller Group Header */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#ECEAF3] px-5 py-4">
              <div className="flex min-w-0 items-center gap-3">
                {group.sellerLogoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={group.sellerLogoUrl}
                    alt={group.sellerName}
                    className="h-9 w-9 shrink-0 rounded-xl border border-[#E6E3EE] object-cover"
                  />
                ) : (
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#4E2A84] text-xs font-bold text-white">
                    {getInitials(group.sellerName)}
                  </div>
                )}

                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <Store
                      className="h-3.5 w-3.5 shrink-0 text-[#4E2A84]"
                      aria-hidden="true"
                    />
                    <h2 className="truncate text-sm font-bold text-[#14121A]">
                      {group.sellerName}
                    </h2>
                  </div>
                  <p className="flex flex-wrap items-center gap-1.5 text-xs text-[#6B6779]">
                    <ShieldCheck
                      className="h-3 w-3 shrink-0 text-[#00A3A6]"
                      aria-hidden="true"
                    />
                    <span>{group.sellerBadge}</span>
                    {group.sellerSubtext ? (
                      <>
                        <span aria-hidden="true">&middot;</span>
                        <span className="truncate">{group.sellerSubtext}</span>
                      </>
                    ) : null}
                  </p>
                </div>
              </div>

              <div className="text-right">
                <p className="text-xs font-medium text-[#6B6779]">
                  Seller Subtotal ({group.validQuantity}{" "}
                  {group.validQuantity === 1 ? "item" : "items"})
                </p>
                <p className="text-base font-extrabold text-[#4E2A84]">
                  {group.subtotalSen > 0
                    ? formatSenToRm(group.subtotalSen)
                    : "RM 0.00"}
                </p>
              </div>
            </div>

            {/* Compact Product Rows */}
            <ul className="divide-y divide-[#ECEAF3]">
              {group.items.map((item) => {
                const isBusy = Boolean(busyIds[item.id]);
                const feedback = rowFeedback[item.id];
                const isConfirmingRemove = confirmRemoveId === item.id;
                const inputValue =
                  draftQuantities[item.id] ?? String(item.quantity);
                const canDecrease =
                  item.isValid && !isBusy && item.quantity > 1;
                const canIncrease =
                  item.isValid && !isBusy && item.quantity < item.availableStock;

                return (
                  <li
                    key={item.id}
                    className={`p-4 sm:p-5 ${
                      !item.isValid ? "bg-[#FCFBFD]" : "bg-white"
                    }`}
                  >
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                      {/* Compact Product Photo */}
                      <div className="flex items-start gap-3.5 sm:flex-1 sm:min-w-0">
                        <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl border border-[#E6E3EE] bg-[#F7F6FA]">
                          {item.imageUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={item.imageUrl}
                              alt={item.title}
                              className={`h-full w-full object-cover ${
                                !item.isValid ? "opacity-60" : ""
                              }`}
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-xs font-semibold text-[#6B6779]">
                              No Photo
                            </div>
                          )}
                        </div>

                        {/* Product Info */}
                        <div className="min-w-0 flex-1">
                          {item.issueCode !== "deleted" ? (
                            <Link
                              href={`/listings/${item.listingId}`}
                              className="line-clamp-2 text-sm font-bold text-[#14121A] transition hover:text-[#4E2A84]"
                            >
                              {item.title}
                            </Link>
                          ) : (
                            <p className="text-sm font-bold text-[#6B6779]">
                              {item.title}
                            </p>
                          )}

                          {item.variantLabel ? (
                            <p className="mt-0.5 text-xs font-medium text-[#4A4656]">
                              Option: {item.variantLabel}
                            </p>
                          ) : null}

                          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-[#6B6779]">
                            {item.campusArea ? (
                              <span className="inline-flex items-center gap-1">
                                <MapPin
                                  className="h-3 w-3 shrink-0"
                                  aria-hidden="true"
                                />
                                <span>{item.campusArea}</span>
                              </span>
                            ) : null}
                            {item.condition ? (
                              <span>&middot; {item.condition}</span>
                            ) : null}
                          </div>

                          <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                            {item.unitPriceSen > 0 ? (
                              <span className="text-sm font-bold text-[#14121A]">
                                {formatSenToRm(item.unitPriceSen)}{" "}
                                <span className="text-xs font-normal text-[#6B6779]">
                                  each
                                </span>
                              </span>
                            ) : null}

                            {item.isValid ? (
                              <span className="text-xs font-semibold text-[#008285]">
                                {item.availableStock} available
                              </span>
                            ) : (
                              <span className="text-xs font-semibold text-[#B42318]">
                                {item.issueMessage}
                              </span>
                            )}
                          </div>

                          {item.canAdjustToMax && item.availableStock > 0 ? (
                            <div className="mt-2">
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() =>
                                  void handleQuantityChange(
                                    item,
                                    item.availableStock
                                  )
                                }
                                className="text-xs font-bold text-[#4E2A84] underline underline-offset-2 transition hover:text-[#3F216B] disabled:opacity-50"
                              >
                                Adjust quantity to {item.availableStock}
                              </button>
                            </div>
                          ) : null}
                        </div>
                      </div>

                      {/* Right side of row: Quantity + Line Subtotal + Remove */}
                      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#F1EFF6] pt-3 sm:w-auto sm:flex-col sm:items-end sm:border-t-0 sm:pt-0">
                        <div className="flex items-center gap-3">
                          {/* Quantity Stepper + Direct Input */}
                          <div className="inline-flex items-center rounded-xl border border-[#E6E3EE] bg-white">
                            <button
                              type="button"
                              disabled={!canDecrease}
                              onClick={() =>
                                void handleQuantityChange(
                                  item,
                                  item.quantity - 1
                                )
                              }
                              aria-label={`Decrease quantity for ${item.title}`}
                              className="flex h-9 w-9 items-center justify-center text-[#14121A] transition hover:text-[#4E2A84] disabled:cursor-not-allowed disabled:opacity-35"
                            >
                              <Minus className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>

                            <input
                              type="text"
                              inputMode="numeric"
                              pattern="[0-9]*"
                              aria-label={`Quantity for ${item.title}`}
                              disabled={!item.isValid || isBusy}
                              value={inputValue}
                              onChange={(e) =>
                                setDraftQuantities((prev) => ({
                                  ...prev,
                                  [item.id]: e.target.value,
                                }))
                              }
                              onBlur={() => commitDirectInput(item)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  commitDirectInput(item);
                                } else if (e.key === "Escape") {
                                  clearDraft(item.id);
                                }
                              }}
                              className="h-9 w-11 border-x border-[#ECEAF3] bg-transparent text-center text-sm font-bold text-[#14121A] focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[#4E2A84] disabled:cursor-not-allowed disabled:text-[#6B6779]"
                            />

                            <button
                              type="button"
                              disabled={!canIncrease}
                              onClick={() =>
                                void handleQuantityChange(
                                  item,
                                  item.quantity + 1
                                )
                              }
                              aria-label={`Increase quantity for ${item.title}`}
                              className="flex h-9 w-9 items-center justify-center text-[#14121A] transition hover:text-[#4E2A84] disabled:cursor-not-allowed disabled:opacity-35"
                            >
                              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          </div>

                          {/* Line Subtotal */}
                          <div className="min-w-[5.25rem] text-right">
                            <p
                              className={`text-sm font-extrabold ${
                                item.isValid
                                  ? "text-[#14121A]"
                                  : "text-[#9A95A8] line-through"
                              }`}
                            >
                              {item.isValid
                                ? formatSenToRm(item.lineSubtotalSen)
                                : item.unitPriceSen > 0
                                  ? formatSenToRm(
                                      item.unitPriceSen * item.quantity
                                    )
                                  : "—"}
                            </p>
                          </div>
                        </div>

                        {/* Remove with inline confirmation */}
                        <div className="flex items-center gap-2 text-xs">
                          {isBusy ? (
                            <span className="inline-flex items-center gap-1 font-medium text-[#6B6779]">
                              <Loader2
                                className="h-3.5 w-3.5 animate-spin"
                                aria-hidden="true"
                              />
                              <span>Saving...</span>
                            </span>
                          ) : isConfirmingRemove ? (
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-[#6B6779]">
                                Remove item?
                              </span>
                              <button
                                type="button"
                                onClick={() => void handleRemove(item)}
                                className="font-bold text-[#B42318] underline underline-offset-2 hover:text-[#8E1B12]"
                              >
                                Confirm
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmRemoveId(null)}
                                className="font-semibold text-[#6B6779] hover:text-[#14121A]"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmRemoveId(item.id)}
                              className="inline-flex items-center gap-1 font-semibold text-[#6B6779] transition hover:text-[#B42318]"
                            >
                              <Trash2
                                className="h-3.5 w-3.5"
                                aria-hidden="true"
                              />
                              <span>Remove</span>
                            </button>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Row-level feedback (errors, retry, price update notice) */}
                    {feedback ? (
                      <div
                        role={feedback.type === "error" ? "alert" : "status"}
                        className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#F1EFF6] pt-2.5 text-xs"
                      >
                        <p
                          className={`flex items-center gap-1.5 font-semibold ${
                            feedback.type === "error"
                              ? "text-[#B42318]"
                              : feedback.type === "info"
                                ? "text-[#1D70B8]"
                                : "text-[#008285]"
                          }`}
                        >
                          {feedback.type === "error" ? (
                            <AlertCircle
                              className="h-3.5 w-3.5 shrink-0"
                              aria-hidden="true"
                            />
                          ) : (
                            <Check
                              className="h-3.5 w-3.5 shrink-0"
                              aria-hidden="true"
                            />
                          )}
                          <span>{feedback.message}</span>
                        </p>

                        {feedback.type === "error" &&
                        typeof feedback.retryQuantity === "number" ? (
                          <button
                            type="button"
                            onClick={() =>
                              void handleQuantityChange(
                                item,
                                feedback.retryQuantity!
                              )
                            }
                            className="inline-flex items-center gap-1 font-bold text-[#4E2A84] underline underline-offset-2 hover:text-[#3F216B]"
                          >
                            <RefreshCw
                              className="h-3 w-3"
                              aria-hidden="true"
                            />
                            <span>Retry</span>
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>

      {/* Right column: Order Summary Panel */}
      <aside
        aria-label="Order summary"
        className="rounded-2xl border border-[#E6E3EE] bg-white p-6 lg:sticky lg:top-20 lg:col-span-4"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-bold text-[#14121A]">Order Summary</h2>
          {isNavigating ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-[#6B6779]">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              <span>Syncing</span>
            </span>
          ) : null}
        </div>

        <dl className="mt-4 space-y-2.5 border-y border-[#ECEAF3] py-4 text-sm">
          <div className="flex items-center justify-between gap-2">
            <dt className="text-[#6B6779]">Sellers in Cart</dt>
            <dd className="font-semibold text-[#14121A]">
              {summary.sellerCount}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-[#6B6779]">Ready Items</dt>
            <dd className="font-semibold text-[#14121A]">
              {summary.validQuantity}
            </dd>
          </div>
          {summary.invalidRowCount > 0 ? (
            <div className="flex items-center justify-between gap-2">
              <dt className="text-[#B42318]">Unavailable / Needs Fix</dt>
              <dd className="font-bold text-[#B42318]">
                {summary.invalidRowCount}
              </dd>
            </div>
          ) : null}
          <div className="flex items-baseline justify-between gap-2 pt-2 border-t border-[#F1EFF6]">
            <dt className="text-sm font-bold text-[#14121A]">Subtotal</dt>
            <dd className="text-2xl font-extrabold tracking-tight text-[#4E2A84]">
              {summary.combinedSubtotalSen > 0
                ? formatSenToRm(summary.combinedSubtotalSen)
                : "RM 0.00"}
            </dd>
          </div>
        </dl>

        <div className="mt-5 space-y-3">
          <button
            type="button"
            disabled
            aria-disabled="true"
            className="flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-xl bg-[#C9C4D6] px-5 py-3 text-sm font-bold text-white"
          >
            <span>Checkout Not Yet Available</span>
          </button>

          <p className="text-xs leading-relaxed text-[#6B6779]">
            Checkout and payment will open in the next release. No delivery or
            platform fees are calculated at this stage.
          </p>

          <p className="text-xs leading-relaxed text-[#6B6779]">
            Keeping items in your cart does not reserve stock. Availability is
            checked live from each seller&apos;s listing.
          </p>

          <Link
            href="/marketplace"
            className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-[#E6E3EE] bg-white px-4 py-2.5 text-sm font-semibold text-[#14121A] transition hover:border-[#4E2A84] hover:text-[#4E2A84]"
          >
            <span>Continue Shopping</span>
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </aside>
    </div>
  );
}
