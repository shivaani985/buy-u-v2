"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  Clock,
  ExternalLink,
  Landmark,
  Loader2,
  MapPin,
  RefreshCw,
  ShieldCheck,
  Store,
  User,
  Utensils,
} from "lucide-react";
import {
  revalidateCheckoutAction,
  startCartToyyibPayCheckoutAction,
  type ServiceCheckoutDetailInput,
  type UnifiedCheckoutActionResult,
} from "@/app/checkout/actions";
import {
  ServiceRequirementsPanel,
  type ServiceItemCheckoutState,
} from "@/components/checkout/ServiceRequirementsPanel";
import {
  extractPriceSnapshots,
  type CheckoutPreparationSummary,
} from "@/lib/buyer/checkout";
import { TOYYIBPAY_FPX_FEE_SEN } from "@/lib/orders/pricing";
import { formatServiceModeLabel } from "@/lib/orders/service-attachments";
import { formatSenToRm } from "@/lib/format";

export interface CheckoutBuyerInfo {
  userId: string;
  displayName: string;
  email: string;
  roleLabel: string;
  faculty: string | null;
}

interface CheckoutClientProps {
  initialPreparation: CheckoutPreparationSummary;
  selectedCartItemIds?: string[] | null;
  buyer: CheckoutBuyerInfo;
}

function getInitials(name: string): string {
  const [first, second] = name.trim().split(/\s+/).filter(Boolean);
  if (!first) return "BU";
  if (!second) return first.slice(0, 2).toUpperCase();
  return `${first.charAt(0)}${second.charAt(0)}`.toUpperCase();
}

function formatDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-MY", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

export function CheckoutClient({
  initialPreparation,
  selectedCartItemIds = null,
  buyer,
}: CheckoutClientProps) {
  const [preparation, setPreparation] =
    useState<CheckoutPreparationSummary>(initialPreparation);
  const [priceSnapshots, setPriceSnapshots] = useState<Record<string, number>>(
    () => extractPriceSnapshots(initialPreparation)
  );
  const [collectionNotes, setCollectionNotes] = useState<
    Record<string, string>
  >({});
  const [refreshMessage, setRefreshMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [isRefreshing, startRefreshTransition] = useTransition();
  const reviewedCartItemIds = Array.from(
    new Set(
      preparation.sellerOrders.flatMap((order) =>
        order.items.map((line) => line.cartItem.id)
      )
    )
  ).sort();
  const submittedCartItemIds =
    selectedCartItemIds && selectedCartItemIds.length > 0
      ? [...selectedCartItemIds].sort()
      : reviewedCartItemIds;
  const selectionSignature = submittedCartItemIds.join(",");

  // Reuse original key on retries of the same selection; generate a new key if selection changes
  const keyBySelectionRef = useRef<Record<string, string>>({});

  const [isPaying, setIsPaying] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [readyCheckout, setReadyCheckout] =
    useState<UnifiedCheckoutActionResult | null>(null);
  const [serviceStates, setServiceStates] = useState<
    Record<string, ServiceItemCheckoutState>
  >({});

  const handleServiceStateChange = useCallback(
    (cartItemId: string, next: ServiceItemCheckoutState) => {
      setServiceStates((prev) => {
        const cur = prev[cartItemId];
        if (
          cur &&
          cur.requirements === next.requirements &&
          cur.isBusy === next.isBusy &&
          cur.hasFailedUpload === next.hasFailedUpload &&
          cur.validatedPaths.length === next.validatedPaths.length &&
          cur.validatedPaths.every((p, idx) => p === next.validatedPaths[idx])
        ) {
          return prev;
        }
        return { ...prev, [cartItemId]: next };
      });
    },
    []
  );

  const anyAttachmentBusy = Object.values(serviceStates).some((s) => s.isBusy);
  const anyAttachmentFailed = Object.values(serviceStates).some(
    (s) => s.hasFailedUpload
  );

  async function handleStartToyyibPayCheckout() {
    if (
      !preparation.canProceedToPayment ||
      isPaying ||
      isRefreshing ||
      anyAttachmentBusy ||
      anyAttachmentFailed
    ) {
      return;
    }
    setPaymentError(null);
    setIsPaying(true);
    try {
      if (!keyBySelectionRef.current[selectionSignature]) {
        keyBySelectionRef.current[selectionSignature] =
          typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? `cart-${crypto.randomUUID()}`
            : `cart-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      }
      const idempotencyKey = keyBySelectionRef.current[selectionSignature]!;
      const reviewedSet = new Set(submittedCartItemIds);
      const serviceDetails: Record<string, ServiceCheckoutDetailInput> = {};
      for (const [cartItemId, st] of Object.entries(serviceStates)) {
        if (!reviewedSet.has(cartItemId)) continue;
        const trimmed = st.requirements.trim();
        if (trimmed.length > 0 || st.validatedPaths.length > 0) {
          serviceDetails[cartItemId] = {
            requirements: trimmed.length > 0 ? trimmed : null,
            attachment_paths: st.validatedPaths,
          };
        }
      }

      const res = await startCartToyyibPayCheckoutAction({
        idempotencyKey,
        priceSnapshots,
        serviceDetails,
        selectedCartItemIds: submittedCartItemIds,
      });

      if (!res.ok || !res.billUrl) {
        setPaymentError(
          res.error || "Could not start ToyyibPay FPX checkout. Please try again."
        );
        return;
      }

      setReadyCheckout(res);
      window.location.assign(res.billUrl);
    } catch {
      setPaymentError(
        "Network error while creating payment bill. Please try again."
      );
    } finally {
      setIsPaying(false);
    }
  }

  function handleRevalidate() {
    setRefreshMessage(null);
    startRefreshTransition(async () => {
      try {
        const res = await revalidateCheckoutAction(
          priceSnapshots,
          selectedCartItemIds
        );
        if (!res.ok || !res.preparation) {
          setRefreshMessage({
            type: "error",
            text:
              res.error ||
              "Could not revalidate stock and prices right now. Please try again.",
          });
          return;
        }
        setPreparation(res.preparation);
        if (res.preparation.priceChangedCount > 0) {
          setRefreshMessage({
            type: "error",
            text: "One or more item prices changed. Review the updated amounts below.",
          });
        } else if (res.preparation.invalidRowCount > 0) {
          setRefreshMessage({
            type: "error",
            text: "Stock or listing availability changed. Return to your cart to resolve issues.",
          });
        } else {
          setRefreshMessage({
            type: "success",
            text: "All items, stock levels, and prices are up to date.",
          });
        }
      } catch {
        setRefreshMessage({
          type: "error",
          text: "Network error while checking live stock. Please try again.",
        });
      }
    });
  }

  function handleAcknowledgePriceUpdates() {
    const nextSnapshots = extractPriceSnapshots(preparation);
    setPriceSnapshots(nextSnapshots);
    setRefreshMessage(null);
    startRefreshTransition(async () => {
      const res = await revalidateCheckoutAction(
        nextSnapshots,
        selectedCartItemIds
      );
      if (res.ok && res.preparation) {
        setPreparation(res.preparation);
        setRefreshMessage({
          type: "success",
          text: "Updated prices acknowledged.",
        });
      }
    });
  }

  if (preparation.totalRowCount === 0) {
    return (
      <section className="rounded-2xl border border-[#E6E3EE] bg-white px-6 py-12 text-center sm:py-16">
        <h2 className="text-lg font-bold text-[#14121A]">
          No items ready for checkout
        </h2>
        <p className="mx-auto mt-1.5 max-w-md text-sm text-[#6B6779]">
          Your shopping cart is empty. Add eligible campus products before
          reviewing checkout.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/marketplace"
            className="inline-flex items-center rounded-xl bg-[#4E2A84] px-5 py-2.5 text-sm font-bold text-white transition hover:bg-[#3F216B]"
          >
            Browse Marketplace
          </Link>
          <Link
            href="/cart"
            className="inline-flex items-center rounded-xl border border-[#E6E3EE] bg-white px-4 py-2.5 text-sm font-semibold text-[#14121A] transition hover:border-[#4E2A84] hover:text-[#4E2A84]"
          >
            Return to Cart
          </Link>
        </div>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      {/* Compact Plain-Text Checkout Step Indicator */}
      <nav
        aria-label="Checkout progress"
        className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-2xl border border-[#E6E3EE] bg-white px-5 py-3.5 text-xs font-semibold"
      >
        <Link
          href="/cart"
          className="text-[#008285] transition hover:underline"
        >
          1. Shopping Cart
        </Link>
        <span className="text-[#C7C3D4]" aria-hidden="true">
          /
        </span>
        <span className="font-bold text-[#4E2A84]" aria-current="step">
          2. Review &amp; Campus Collection
        </span>
        <span className="text-[#C7C3D4]" aria-hidden="true">
          /
        </span>
        <span className="text-[#4E2A84] font-semibold">
          3. ToyyibPay Sandbox FPX
        </span>
      </nav>

      {/* Single Consolidated Bill Redirect Banner (fallback if browser pauses redirect) */}
      {readyCheckout?.checkoutSessionId ? (
        <section
          aria-label="ToyyibPay FPX payment bill ready"
          className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[#4E2A84]/25 bg-white p-5 sm:p-6"
        >
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-[#4E2A84]">
              Checkout #{readyCheckout.checkoutCode}
            </p>
            <h2 className="mt-0.5 text-base font-extrabold text-[#14121A]">
              Redirecting to ToyyibPay Sandbox FPX (
              {readyCheckout.totalPaidSen
                ? formatSenToRm(readyCheckout.totalPaidSen)
                : "RM 0.00"}
              )...
            </h2>
            <p className="mt-1 text-xs text-[#6B6779]">
              One consolidated FPX payment covers all seller orders in this
              checkout with a single RM 1.00 FPX fee.
            </p>
          </div>
          <Link
            href={`/orders/checkout/${readyCheckout.checkoutSessionId}`}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-[#4E2A84] px-4 py-2.5 text-xs font-bold text-white transition hover:bg-[#3F216B]"
          >
            View Payment Details
          </Link>
        </section>
      ) : null}

      {/* Blocking Issues Alert */}
      {preparation.blockingReasons.length > 0 ? (
        <section
          role="alert"
          className="rounded-2xl border border-[#E6E3EE] bg-white p-5"
        >
          <div className="flex items-start gap-3">
            <AlertCircle
              className="mt-0.5 h-5 w-5 shrink-0 text-[#B42318]"
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-bold text-[#B42318]">
                Checkout blocked until issues are resolved
              </h2>
              <ul className="mt-1.5 list-disc space-y-1 pl-4 text-sm text-[#3E3A4A]">
                {preparation.blockingReasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Link
                  href="/cart"
                  className="inline-flex items-center gap-1.5 rounded-xl bg-[#4E2A84] px-4 py-2 text-xs font-bold text-white transition hover:bg-[#3F216B]"
                >
                  <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Return to Cart to Fix</span>
                </Link>
                {preparation.priceChangedCount > 0 &&
                preparation.invalidRowCount === 0 ? (
                  <button
                    type="button"
                    disabled={isRefreshing}
                    onClick={handleAcknowledgePriceUpdates}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-[#4E2A84] bg-white px-4 py-2 text-xs font-bold text-[#4E2A84] transition hover:bg-[#FAF8FD] disabled:opacity-50"
                  >
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Accept Updated Prices</span>
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </section>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:items-start lg:gap-8">
        {/* Main Left Column */}
        <div className="space-y-6 lg:col-span-8">
          {/* Buyer Verification & Campus Collection Overview */}
          <section className="rounded-2xl border border-[#E6E3EE] bg-white p-5 sm:p-6">
            <div className="flex items-center gap-2">
              <User
                className="h-4 w-4 text-[#4E2A84]"
                aria-hidden="true"
              />
              <h2 className="text-base font-bold text-[#14121A]">
                Buyer &amp; Campus Collection
              </h2>
            </div>

            <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium text-[#6B6779]">
                  Verified Buyer
                </dt>
                <dd className="mt-0.5 font-semibold text-[#14121A]">
                  {buyer.displayName}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[#6B6779]">
                  UMS Account
                </dt>
                <dd className="mt-0.5 break-all font-semibold text-[#14121A]">
                  {buyer.email}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[#6B6779]">
                  Campus Role
                </dt>
                <dd className="mt-0.5 font-semibold text-[#008285]">
                  {buyer.roleLabel}
                  {buyer.faculty ? ` · ${buyer.faculty}` : ""}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[#6B6779]">
                  Fulfilment Method
                </dt>
                <dd className="mt-0.5 font-semibold text-[#14121A]">
                  On-Campus Collection (UMSKAL)
                </dd>
              </div>
            </dl>

            <p className="mt-4 border-t border-[#ECEAF3] pt-3 text-xs leading-relaxed text-[#6B6779]">
              Buy-U uses campus-based pickup at each seller&apos;s listed UMSKAL
              collection area. No courier shipping address or extra personal
              details are required.
            </p>
          </section>

          {/* Per-Seller Order Breakdowns */}
          <div className="space-y-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-bold text-[#14121A]">
                Seller Order Breakdown ({preparation.sellerOrderCount}{" "}
                {preparation.sellerOrderCount === 1
                  ? "seller order"
                  : "separate seller orders"}
                )
              </h2>
              {preparation.sellerOrderCount > 1 ? (
                <p className="text-xs font-medium text-[#6B6779]">
                  Each seller fulfils and hands over their order separately.
                </p>
              ) : null}
            </div>

            {preparation.sellerOrders.map((order) => (
              <section
                key={order.sellerId}
                aria-label={`Seller order ${order.orderIndex}: ${order.sellerName}`}
                className="overflow-hidden rounded-2xl border border-[#E6E3EE] bg-white"
              >
                {/* Seller Order Header */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#ECEAF3] px-5 py-4">
                  <div className="flex min-w-0 items-center gap-3">
                    {order.sellerLogoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={order.sellerLogoUrl}
                        alt={order.sellerName}
                        className="h-9 w-9 shrink-0 rounded-xl border border-[#E6E3EE] object-cover"
                      />
                    ) : (
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#4E2A84] text-xs font-bold text-white">
                        {getInitials(order.sellerName)}
                      </div>
                    )}

                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="text-xs font-bold uppercase tracking-wider text-[#4E2A84]">
                          Order {order.orderIndex} of{" "}
                          {preparation.sellerOrderCount}
                        </span>
                        <span className="text-[#C7C3D4]" aria-hidden="true">
                          &middot;
                        </span>
                        <Store
                          className="h-3.5 w-3.5 shrink-0 text-[#4E2A84]"
                          aria-hidden="true"
                        />
                        <h3 className="truncate text-sm font-bold text-[#14121A]">
                          {order.sellerName}
                        </h3>
                      </div>
                      <p className="flex flex-wrap items-center gap-1.5 text-xs text-[#6B6779]">
                        <ShieldCheck
                          className="h-3 w-3 shrink-0 text-[#00A3A6]"
                          aria-hidden="true"
                        />
                        <span>{order.sellerBadge}</span>
                        {order.sellerSubtext ? (
                          <>
                            <span aria-hidden="true">&middot;</span>
                            <span className="truncate">
                              {order.sellerSubtext}
                            </span>
                          </>
                        ) : null}
                      </p>
                    </div>
                  </div>

                  <div className="text-right">
                    <p
                      className={`text-xs font-bold ${
                        order.readyForPayment
                          ? "text-[#008285]"
                          : "text-[#B42318]"
                      }`}
                    >
                      {order.readyForPayment ? "Ready" : "Action Needed"}
                    </p>
                    <p className="text-base font-extrabold text-[#4E2A84]">
                      {order.subtotalSen > 0
                        ? formatSenToRm(order.subtotalSen)
                        : "RM 0.00"}
                    </p>
                  </div>
                </div>

                {/* Campus Collection Areas Strip */}
                {order.collectionAreas.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-[#F1EFF6] bg-[#FAF9FC] px-5 py-2.5 text-xs text-[#3E3A4A]">
                    <MapPin
                      className="h-3.5 w-3.5 shrink-0 text-[#4E2A84]"
                      aria-hidden="true"
                    />
                    <span className="font-semibold text-[#14121A]">
                      Campus Collection:
                    </span>
                    <span>{order.collectionAreas.join(", ")}</span>
                  </div>
                ) : null}

                {/* Item Rows */}
                <ul className="divide-y divide-[#ECEAF3]">
                  {order.items.map((line) => {
                    const item = line.cartItem;
                    const pickupStart = formatDateTime(item.pickupWindowStart);
                    const pickupEnd = formatDateTime(item.pickupWindowEnd);

                    return (
                      <li
                        key={item.id}
                        className={`p-4 sm:px-5 ${
                          !line.isCheckoutEligible ? "bg-[#FCFBFD]" : "bg-white"
                        }`}
                      >
                        <div className="flex items-start gap-3.5">
                          <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-xl border border-[#E6E3EE] bg-[#F7F6FA]">
                            {item.imageUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={item.imageUrl}
                                alt={item.title}
                                className={`h-full w-full object-cover ${
                                  !line.isCheckoutEligible ? "opacity-60" : ""
                                }`}
                              />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center text-[11px] font-semibold text-[#6B6779]">
                                No Photo
                              </div>
                            )}
                          </div>

                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <p className="text-sm font-bold text-[#14121A]">
                                    {item.title}
                                  </p>
                                  {item.isService ? (
                                    <span className="inline-flex items-center rounded-full bg-[#F3ECFC] px-2 py-0.5 text-[11px] font-bold text-[#4E2A84]">
                                      Service
                                    </span>
                                  ) : null}
                                </div>
                                {item.variantLabel ? (
                                  <p className="mt-0.5 text-xs font-medium text-[#4A4656]">
                                    Option: {item.variantLabel}
                                  </p>
                                ) : null}
                                <p className="mt-1 text-xs text-[#6B6779]">
                                  Qty {item.quantity} &times;{" "}
                                  {item.unitPriceSen > 0
                                    ? formatSenToRm(item.unitPriceSen)
                                    : "—"}
                                  {item.isService && item.serviceMode
                                    ? ` · ${formatServiceModeLabel(item.serviceMode)}`
                                    : ""}
                                  {item.campusArea
                                    ? ` · ${item.campusArea}`
                                    : ""}
                                </p>
                              </div>

                              <p
                                className={`shrink-0 text-sm font-extrabold ${
                                  line.isCheckoutEligible
                                    ? "text-[#14121A]"
                                    : "text-[#9A95A8] line-through"
                                }`}
                              >
                                {line.isCheckoutEligible
                                  ? formatSenToRm(line.lineSubtotalSen)
                                  : item.unitPriceSen > 0
                                    ? formatSenToRm(
                                        item.unitPriceSen * item.quantity
                                      )
                                    : "—"}
                              </p>
                            </div>

                            {/* Price Change Notice */}
                            {line.priceChanged &&
                            line.previousPriceSen !== null ? (
                              <p className="mt-1.5 text-xs font-semibold text-[#1D70B8]">
                                Price updated from{" "}
                                {formatSenToRm(line.previousPriceSen)} to{" "}
                                {formatSenToRm(item.unitPriceSen)}.
                              </p>
                            ) : null}

                            {/* Blocking Reason */}
                            {line.checkoutBlockedReason ? (
                              <p className="mt-1.5 text-xs font-semibold text-[#B42318]">
                                {line.checkoutBlockedReason}
                              </p>
                            ) : (
                              <p className="mt-1 text-xs font-semibold text-[#008285]">
                                {item.isService
                                  ? "Service available for purchase"
                                  : `In stock (${item.availableStock} available)`}
                              </p>
                            )}

                            {item.isService &&
                            line.isCheckoutEligible &&
                            buyer.userId ? (
                              <ServiceRequirementsPanel
                                buyerId={buyer.userId}
                                cartItemId={item.id}
                                serviceTitle={item.title}
                                disabled={isPaying}
                                onChange={(next) =>
                                  handleServiceStateChange(item.id, next)
                                }
                              />
                            ) : null}

                            {/* Food / Pickup Instructions (only when present) */}
                            {item.isFood &&
                            (pickupStart || item.pickupNote || item.foodNotes) ? (
                              <div className="mt-2.5 space-y-1 border-t border-[#F1EFF6] pt-2 text-xs text-[#4A4656]">
                                {pickupStart ? (
                                  <p className="flex items-center gap-1.5">
                                    <Clock
                                      className="h-3.5 w-3.5 shrink-0 text-[#4E2A84]"
                                      aria-hidden="true"
                                    />
                                    <span>
                                      <strong className="font-semibold text-[#14121A]">
                                        Pickup Window:
                                      </strong>{" "}
                                      {pickupStart}
                                      {pickupEnd ? ` – ${pickupEnd}` : ""}
                                    </span>
                                  </p>
                                ) : null}
                                {item.pickupNote ? (
                                  <p>
                                    <strong className="font-semibold text-[#14121A]">
                                      Pickup Instructions:
                                    </strong>{" "}
                                    {item.pickupNote}
                                  </p>
                                ) : null}
                                {item.foodNotes ? (
                                  <p className="flex items-start gap-1.5">
                                    <Utensils
                                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#4E2A84]"
                                      aria-hidden="true"
                                    />
                                    <span>
                                      <strong className="font-semibold text-[#14121A]">
                                        Food Notes:
                                      </strong>{" "}
                                      {item.foodNotes}
                                    </span>
                                  </p>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>

                {/* Optional Per-Seller Collection Note (Preview Only — No DB Write) */}
                <div className="border-t border-[#ECEAF3] px-5 py-4">
                  <label
                    htmlFor={`collection-note-${order.sellerId}`}
                    className="block text-xs font-semibold text-[#14121A]"
                  >
                    Optional Collection Note for {order.sellerName}
                  </label>
                  <textarea
                    id={`collection-note-${order.sellerId}`}
                    rows={2}
                    maxLength={240}
                    value={collectionNotes[order.sellerId] ?? ""}
                    onChange={(e) =>
                      setCollectionNotes((prev) => ({
                        ...prev,
                        [order.sellerId]: e.target.value,
                      }))
                    }
                    placeholder="Optional preferred campus pickup time or landmark note (e.g., after 2 PM class at Cafe UMSKAL)"
                    className="mt-1.5 w-full rounded-xl border border-[#DCD9E6] bg-white px-3 py-2 text-xs text-[#14121A] placeholder:text-[#7A7588] focus:border-[#4E2A84] focus:outline-none"
                  />
                  <p className="mt-1 text-[11px] text-[#6B6779]">
                    Draft note only — submitted when payment integration opens.
                  </p>
                </div>
              </section>
            ))}
          </div>

          {/* ToyyibPay Sandbox FPX Payment Section */}
          <section className="rounded-2xl border border-[#E6E3EE] bg-white p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Landmark
                  className="h-4 w-4 text-[#4E2A84]"
                  aria-hidden="true"
                />
                <h2 className="text-base font-bold text-[#14121A]">
                  Payment Method — ToyyibPay FPX (Sandbox)
                </h2>
              </div>
              <span className="text-xs font-bold text-[#008285]">
                Server-Verified FPX Online Banking
              </span>
            </div>

            <p className="mt-3 text-sm leading-relaxed text-[#4A4656]">
              Pay once via Malaysian FPX online banking on ToyyibPay Sandbox for
              all sellers in this checkout. Clicking Pay Now reserves your items
              for 15 minutes with a single RM 1.00 FPX fee.
            </p>

            <p className="mt-2 text-xs text-[#6B6779]">
              Payment confirmation is verified server-to-server with ToyyibPay
              before all seller orders are marked Paid and each seller order
              receives its own private campus pickup PIN.
            </p>

            {paymentError ? (
              <p
                role="alert"
                className="mt-3 flex items-start gap-1.5 text-xs font-semibold text-[#B42318]"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{paymentError}</span>
              </p>
            ) : null}

            <div className="mt-4">
              <button
                type="button"
                disabled={!preparation.canProceedToPayment || isPaying || isRefreshing}
                onClick={handleStartToyyibPayCheckout}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#4E2A84] px-5 py-3 text-sm font-bold text-white transition hover:bg-[#3F216B] disabled:cursor-not-allowed disabled:bg-[#C9C4D6] sm:w-auto"
              >
                {isPaying ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <ExternalLink className="h-4 w-4" aria-hidden="true" />
                )}
                <span>
                  {isPaying
                    ? "Creating ToyyibPay Bill..."
                    : "Pay with ToyyibPay FPX"}
                </span>
              </button>
            </div>
          </section>
        </div>

        {/* Sticky Right Column: Overall Order Summary */}
        <aside
          aria-label="Checkout order summary"
          className="rounded-2xl border border-[#E6E3EE] bg-white p-6 lg:sticky lg:top-20 lg:col-span-4"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-bold text-[#14121A]">
              Order Summary
            </h2>
            <button
              type="button"
              disabled={isRefreshing}
              onClick={handleRevalidate}
              className="inline-flex items-center gap-1 text-xs font-semibold text-[#4E2A84] transition hover:underline disabled:opacity-50"
            >
              {isRefreshing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>Refresh</span>
            </button>
          </div>

          {refreshMessage ? (
            <p
              role={refreshMessage.type === "error" ? "alert" : "status"}
              className={`mt-2 text-xs font-semibold ${
                refreshMessage.type === "error"
                  ? "text-[#B42318]"
                  : "text-[#008285]"
              }`}
            >
              {refreshMessage.text}
            </p>
          ) : null}

          <dl className="mt-4 space-y-2.5 border-y border-[#ECEAF3] py-4 text-sm">
            <div className="flex items-center justify-between gap-2">
              <dt className="text-[#6B6779]">Seller Orders</dt>
              <dd className="font-semibold text-[#14121A]">
                {preparation.sellerOrderCount}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-[#6B6779]">Eligible Items</dt>
              <dd className="font-semibold text-[#14121A]">
                {preparation.validQuantity}
              </dd>
            </div>
            {preparation.invalidRowCount > 0 ? (
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[#B42318]">Blocked Items</dt>
                <dd className="font-bold text-[#B42318]">
                  {preparation.invalidRowCount}
                </dd>
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-2">
              <dt className="text-[#6B6779]">Items Subtotal</dt>
              <dd className="font-semibold text-[#14121A]">
                {preparation.itemsSubtotalSen > 0
                  ? formatSenToRm(preparation.itemsSubtotalSen)
                  : "RM 0.00"}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-[#6B6779]">
                ToyyibPay FPX Fee (once per checkout)
              </dt>
              <dd className="font-semibold text-[#14121A]">
                {preparation.itemsSubtotalSen > 0
                  ? formatSenToRm(TOYYIBPAY_FPX_FEE_SEN)
                  : "RM 0.00"}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-2 border-t border-[#F1EFF6] pt-2.5">
              <dt className="text-sm font-bold text-[#14121A]">
                Total Payable
              </dt>
              <dd className="text-2xl font-extrabold tracking-tight text-[#4E2A84]">
                {preparation.itemsSubtotalSen > 0
                  ? formatSenToRm(
                      preparation.itemsSubtotalSen + TOYYIBPAY_FPX_FEE_SEN
                    )
                  : "RM 0.00"}
              </dd>
            </div>
          </dl>

          <div className="mt-5 space-y-3">
            <button
              type="button"
              disabled={
                !preparation.canProceedToPayment ||
                isPaying ||
                isRefreshing ||
                anyAttachmentBusy ||
                anyAttachmentFailed
              }
              onClick={handleStartToyyibPayCheckout}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#4E2A84] px-5 py-3 text-sm font-bold text-white transition hover:bg-[#3F216B] disabled:cursor-not-allowed disabled:bg-[#C9C4D6]"
            >
              {isPaying || anyAttachmentBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : null}
              <span>
                {isPaying
                  ? "Opening ToyyibPay FPX..."
                  : anyAttachmentBusy
                    ? "Validating Attachments..."
                    : anyAttachmentFailed
                      ? "Fix or Remove Failed Uploads"
                      : preparation.canProceedToPayment
                        ? `Pay Now · ${formatSenToRm(preparation.itemsSubtotalSen + TOYYIBPAY_FPX_FEE_SEN)}`
                        : "Resolve Issues Before Payment"}
              </span>
            </button>

            <p className="text-xs leading-relaxed text-[#6B6779]">
              RM 1.00 ToyyibPay FPX fee is charged once per checkout regardless
              of seller count. Buy-U&apos;s 2% platform commission is deducted
              from each seller&apos;s subtotal at no extra cost to buyers.
            </p>

            <Link
              href="/cart"
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-[#E6E3EE] bg-white px-4 py-2.5 text-sm font-semibold text-[#14121A] transition hover:border-[#4E2A84] hover:text-[#4E2A84]"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              <span>Return to Cart</span>
            </Link>
          </div>
        </aside>
      </div>
    </div>
  );
}
