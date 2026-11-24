import type { Metadata } from "next";
import Link from "next/link";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  KeyRound,
  Lock,
  MapPin,
  RefreshCw,
  ShieldAlert,
  Store,
  XCircle,
} from "lucide-react";
import { evaluateBuyerEligibility } from "@/lib/buyer/validation";
import { formatSenToRm } from "@/lib/format";
import { verifyAndReconcileBillPayment } from "@/lib/payments/toyyibpay-server";
import {
  createSupabaseServerClient,
  getSessionSummary,
} from "@/lib/supabase/server";
import { getServerServiceClient } from "@/lib/supabase/service";

export const metadata: Metadata = {
  title: "Payment Status",
  description:
    "Server-verified ToyyibPay Sandbox FPX payment status for your Buy-U checkout.",
};

export const dynamic = "force-dynamic";

interface ReturnPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return (value[0] ?? "").trim();
  return (value ?? "").trim();
}

function formatDeadlineMyt(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-MY", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kuala_Lumpur",
  }).format(d);
}

interface ReturnSellerOrderCard {
  id: string;
  orderCode: string;
  sellerName: string;
  subtotalSen: number;
  collectionAreaName: string;
  pickupPin: string | null;
}

export default async function OrderPaymentReturnPage({
  searchParams,
}: ReturnPageProps) {
  const params = await searchParams;
  const billCode = firstParam(params.billcode);
  const orderCodeParam = firstParam(params.order_id);

  const session = await getSessionSummary();
  const eligibility = evaluateBuyerEligibility(session);

  if (!eligibility.eligible || !eligibility.userId) {
    const nextUrl = `/orders/return${billCode ? `?billcode=${encodeURIComponent(billCode)}${orderCodeParam ? `&order_id=${encodeURIComponent(orderCodeParam)}` : ""}` : ""}`;
    return (
      <div className="mx-auto w-full max-w-[720px] px-4 py-10 sm:px-6">
        <section className="rounded-2xl border border-[#E6E3EE] bg-white p-6 sm:p-8">
          <div className="flex items-start gap-3">
            <Lock
              className="mt-0.5 h-5 w-5 shrink-0 text-[#4E2A84]"
              aria-hidden="true"
            />
            <div>
              <h1 className="text-lg font-extrabold text-[#14121A]">
                Sign in to verify your payment
              </h1>
              <p className="mt-1 text-sm text-[#6B6779]">
                For your security, Buy-U verifies payment status server-side
                against your authenticated UMS account.
              </p>
              <Link
                href={`/login?next=${encodeURIComponent(nextUrl)}`}
                className="mt-4 inline-flex items-center rounded-xl bg-[#4E2A84] px-5 py-2.5 text-sm font-bold text-white transition hover:bg-[#3F216B]"
              >
                Sign In with UMS Email
              </Link>
            </div>
          </div>
        </section>
      </div>
    );
  }

  const supabase = await createSupabaseServerClient();
  const service = getServerServiceClient();

  if (!billCode || !supabase || !service) {
    return (
      <div className="mx-auto w-full max-w-[720px] px-4 py-10 sm:px-6">
        <section className="rounded-2xl border border-[#E6E3EE] bg-white p-6 sm:p-8">
          <div className="flex items-start gap-3">
            <AlertCircle
              className="mt-0.5 h-5 w-5 shrink-0 text-[#B42318]"
              aria-hidden="true"
            />
            <div>
              <h1 className="text-lg font-extrabold text-[#14121A]">
                Missing payment reference
              </h1>
              <p className="mt-1 text-sm text-[#6B6779]">
                Return to your Orders page to view your payment status or resume
                any pending ToyyibPay FPX bill.
              </p>
              <Link
                href="/orders"
                className="mt-4 inline-flex items-center rounded-xl bg-[#4E2A84] px-5 py-2.5 text-sm font-bold text-white transition hover:bg-[#3F216B]"
              >
                Go to My Orders
              </Link>
            </div>
          </div>
        </section>
      </div>
    );
  }

  // Resolve buyer ownership: Phase 6B.4 unified `checkout_sessions` FIRST, else legacy `payments`
  const { data: unifiedSession } = await service
    .from("checkout_sessions")
    .select("id, buyer_id, checkout_code")
    .eq("bill_code", billCode)
    .maybeSingle();

  let ownedCheckoutId: string | null = null;
  let ownedLegacyOrderId: string | null = null;
  let expectedRefCode = "";

  if (unifiedSession) {
    if (unifiedSession.buyer_id === eligibility.userId) {
      ownedCheckoutId = unifiedSession.id;
      expectedRefCode = unifiedSession.checkout_code;
    }
  } else {
    const { data: payRow } = await service
      .from("payments")
      .select("order_id")
      .eq("bill_code", billCode)
      .maybeSingle();

    if (payRow) {
      const { data: legacyOrder } = await supabase
        .from("orders")
        .select("id, order_code")
        .eq("id", payRow.order_id)
        .eq("buyer_id", eligibility.userId)
        .maybeSingle();
      if (legacyOrder) {
        ownedLegacyOrderId = legacyOrder.id;
        expectedRefCode = legacyOrder.order_code;
      }
    }
  }

  if (!ownedCheckoutId && !ownedLegacyOrderId) {
    return (
      <div className="mx-auto w-full max-w-[720px] px-4 py-10 sm:px-6">
        <section className="rounded-2xl border border-[#E6E3EE] bg-white p-6 sm:p-8">
          <div className="flex items-start gap-3">
            <AlertCircle
              className="mt-0.5 h-5 w-5 shrink-0 text-[#B42318]"
              aria-hidden="true"
            />
            <div>
              <h1 className="text-lg font-extrabold text-[#14121A]">
                Payment bill not found for your account
              </h1>
              <p className="mt-1 text-sm text-[#6B6779]">
                We could not match this ToyyibPay reference to a checkout or
                order on your account.
              </p>
              <Link
                href="/orders"
                className="mt-4 inline-flex items-center rounded-xl bg-[#4E2A84] px-5 py-2.5 text-sm font-bold text-white transition hover:bg-[#3F216B]"
              >
                View My Orders
              </Link>
            </div>
          </div>
        </section>
      </div>
    );
  }

  // NEVER trust redirect query params (`status_id`); always verify server-to-server!
  const verification = await verifyAndReconcileBillPayment({
    billCode,
    expectedOrderCode: orderCodeParam || expectedRefCode,
  });

  // Load consolidated summary + individual seller order cards + buyer-only PINs
  let referenceCode = expectedRefCode;
  let totalPaidSen = 0;
  let fpxFeeSen = 100;
  let paymentDeadline: string | null = null;
  let isPaid =
    verification.outcome === "confirmed_paid" ||
    verification.outcome === "already_paid";
  let isExpired = verification.outcome === "expired";
  const isLateReview = verification.outcome === "late_payment_reconciliation";
  const isFailed = verification.outcome === "failed";

  let sellerOrderRows: Array<{
    id: string;
    order_code: string;
    seller_id: string;
    status: string;
    subtotal_sen: number;
    collection_area_name: string | null;
  }> = [];

  if (ownedCheckoutId) {
    const [{ data: freshSession }, { data: childOrders }] = await Promise.all([
      supabase
        .from("checkout_sessions")
        .select(
          "checkout_code, status, combined_subtotal_sen, fpx_fee_sen, total_paid_sen, payment_deadline"
        )
        .eq("id", ownedCheckoutId)
        .eq("buyer_id", eligibility.userId)
        .single(),
      supabase
        .from("orders")
        .select(
          "id, order_code, seller_id, status, subtotal_sen, collection_area_name"
        )
        .eq("checkout_session_id", ownedCheckoutId)
        .eq("buyer_id", eligibility.userId)
        .order("created_at", { ascending: true }),
    ]);

    if (freshSession) {
      referenceCode = freshSession.checkout_code;
      totalPaidSen = Number(freshSession.total_paid_sen ?? 0);
      fpxFeeSen = Number(freshSession.fpx_fee_sen ?? 100);
      paymentDeadline = freshSession.payment_deadline;
      if (freshSession.status === "paid") isPaid = true;
      if (freshSession.status === "expired") isExpired = true;
    }
    sellerOrderRows = (childOrders ?? []) as typeof sellerOrderRows;
  } else if (ownedLegacyOrderId) {
    const { data: legacyOrder } = await supabase
      .from("orders")
      .select(
        "id, order_code, seller_id, status, subtotal_sen, fpx_fee_sen, total_paid_sen, collection_area_name, payment_deadline"
      )
      .eq("id", ownedLegacyOrderId)
      .eq("buyer_id", eligibility.userId)
      .single();

    if (legacyOrder) {
      referenceCode = legacyOrder.order_code;
      totalPaidSen = Number(legacyOrder.total_paid_sen ?? 0);
      fpxFeeSen = Number(legacyOrder.fpx_fee_sen ?? 100);
      paymentDeadline = legacyOrder.payment_deadline;
      if (
        ["paid", "ready_for_pickup", "completed"].includes(legacyOrder.status)
      ) {
        isPaid = true;
      }
      if (legacyOrder.status === "expired") isExpired = true;
      sellerOrderRows = [legacyOrder];
    }
  }

  const sellerIds = Array.from(new Set(sellerOrderRows.map((o) => o.seller_id)));
  const orderIds = sellerOrderRows.map((o) => o.id);

  const [profilesRes, storefrontsRes, pinsRes] = await Promise.all([
    sellerIds.length > 0
      ? supabase
          .from("public_profiles")
          .select("id,display_name")
          .in("id", sellerIds)
      : Promise.resolve({ data: [] }),
    sellerIds.length > 0
      ? supabase
          .from("storefronts")
          .select("seller_id,shop_name")
          .in("seller_id", sellerIds)
      : Promise.resolve({ data: [] }),
    isPaid && orderIds.length > 0
      ? supabase.rpc("get_buyer_order_pickup_pins", { p_order_ids: orderIds })
      : Promise.resolve({ data: [] }),
  ]);

  const sellerNameMap = new Map<string, string>();
  for (const p of (profilesRes.data ?? []) as Array<{
    id: string;
    display_name: string | null;
  }>) {
    if (p.display_name?.trim()) sellerNameMap.set(p.id, p.display_name.trim());
  }
  for (const s of (storefrontsRes.data ?? []) as Array<{
    seller_id: string;
    shop_name: string | null;
  }>) {
    if (s.shop_name?.trim()) sellerNameMap.set(s.seller_id, s.shop_name.trim());
  }

  const pinByOrder = new Map<string, string>();
  for (const row of (pinsRes.data ?? []) as Array<{
    order_id: string;
    pickup_pin: string | null;
  }>) {
    if (row.pickup_pin) pinByOrder.set(row.order_id, row.pickup_pin);
  }

  const orderCards: ReturnSellerOrderCard[] = sellerOrderRows.map((o) => ({
    id: o.id,
    orderCode: o.order_code,
    sellerName: sellerNameMap.get(o.seller_id) ?? "UMSKAL Seller",
    subtotalSen: Number(o.subtotal_sen ?? 0),
    collectionAreaName: o.collection_area_name?.trim() || "UMSKAL Campus",
    pickupPin: pinByOrder.get(o.id) ?? null,
  }));

  const deadlineLabel = formatDeadlineMyt(paymentDeadline);

  return (
    <div className="mx-auto w-full max-w-[820px] px-4 py-8 sm:px-6 lg:py-12">
      <section className="overflow-hidden rounded-2xl border border-[#E6E3EE] bg-white">
        <div className="border-b border-[#ECEAF3] px-6 py-6 sm:px-8">
          <div className="flex items-start gap-3.5">
            {isPaid ? (
              <CheckCircle2
                className="mt-0.5 h-6 w-6 shrink-0 text-[#008285]"
                aria-hidden="true"
              />
            ) : isLateReview ? (
              <ShieldAlert
                className="mt-0.5 h-6 w-6 shrink-0 text-[#B54708]"
                aria-hidden="true"
              />
            ) : isFailed || isExpired ? (
              <XCircle
                className="mt-0.5 h-6 w-6 shrink-0 text-[#B42318]"
                aria-hidden="true"
              />
            ) : (
              <Clock
                className="mt-0.5 h-6 w-6 shrink-0 text-[#4E2A84]"
                aria-hidden="true"
              />
            )}

            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold uppercase tracking-wider text-[#6B6779]">
                ToyyibPay Sandbox FPX · Server-Verified
              </p>
              <h1 className="mt-1 text-xl font-extrabold tracking-[-0.02em] text-[#14121A] sm:text-2xl">
                {isPaid
                  ? "Payment Confirmed"
                  : isLateReview
                    ? "Late Payment Under Refund Review"
                    : isFailed
                      ? "Payment Failed or Cancelled"
                      : isExpired
                        ? "Payment Window Expired"
                        : "Verifying Payment with Bank"}
              </h1>
              <p className="mt-1.5 text-sm leading-relaxed text-[#4A4656]">
                {verification.message}
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-5 px-6 py-6 sm:px-8">
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium text-[#6B6779]">
                {ownedCheckoutId ? "Checkout Reference" : "Order Code"}
              </dt>
              <dd className="mt-0.5 font-bold text-[#14121A]">
                #{referenceCode}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-[#6B6779]">
                Total Paid (Once)
              </dt>
              <dd className="mt-0.5 font-extrabold text-[#4E2A84]">
                {formatSenToRm(totalPaidSen)}
                <span className="ml-1.5 text-xs font-medium text-[#6B6779]">
                  (incl. {formatSenToRm(fpxFeeSen)} FPX)
                </span>
              </dd>
            </div>
          </dl>

          {isFailed && !isExpired ? (
            <div className="rounded-xl border border-[#F6E4C6] bg-[#FFFBF2] p-4 text-xs text-[#93370D]">
              <p className="font-bold">Retry note (ToyyibPay FPX cooldown)</p>
              <p className="mt-1 leading-relaxed">
                ToyyibPay may enforce a short (~10 minute) cooldown after a
                declined FPX attempt on the same bill.
                {deadlineLabel
                  ? ` Your stock reservation stays held until ${deadlineLabel} MYT.`
                  : ""}{" "}
                You can retry from My Orders before expiry.
              </p>
            </div>
          ) : null}

          {/* Individual Seller Orders & Independent Private Pickup PINs */}
          {orderCards.length > 0 ? (
            <div className="space-y-3">
              <h2 className="text-xs font-bold uppercase tracking-wider text-[#6B6779]">
                {orderCards.length === 1
                  ? "Seller Order & Campus Pickup"
                  : `Individual Seller Orders (${orderCards.length} separate pickups)`}
              </h2>

              {orderCards.map((card) => (
                <div
                  key={card.id}
                  className="rounded-xl border border-[#E6E3EE] bg-[#FAF9FC] p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <div className="flex items-center gap-2">
                      <Store
                        className="h-4 w-4 text-[#4E2A84]"
                        aria-hidden="true"
                      />
                      <span className="font-bold text-[#14121A]">
                        {card.sellerName}
                      </span>
                      <span className="text-xs font-semibold text-[#6B6779]">
                        #{card.orderCode}
                      </span>
                    </div>
                    <span className="font-extrabold text-[#4E2A84]">
                      {formatSenToRm(card.subtotalSen)}
                    </span>
                  </div>

                  <p className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-[#4A4656]">
                    <MapPin
                      className="h-3.5 w-3.5 text-[#4E2A84]"
                      aria-hidden="true"
                    />
                    <span>Collection: {card.collectionAreaName}</span>
                  </p>

                  {isPaid && card.pickupPin ? (
                    <div className="mt-3 rounded-lg border border-[#D8EAEB] bg-[#F4FAFA] px-3.5 py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1.5 text-xs font-bold text-[#008285]">
                          <KeyRound
                            className="h-3.5 w-3.5"
                            aria-hidden="true"
                          />
                          <span>Private Pickup PIN (buyer-only)</span>
                        </span>
                        <span className="font-mono text-lg font-extrabold tracking-[0.25em] text-[#14121A]">
                          {card.pickupPin}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-[#4A4656]">
                        Show this PIN only in person to {card.sellerName} at{" "}
                        {card.collectionAreaName}. Sellers cannot see your PIN.
                      </p>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3 border-t border-[#ECEAF3] pt-5">
            <Link
              href="/orders"
              className="inline-flex items-center rounded-xl bg-[#4E2A84] px-5 py-2.5 text-sm font-bold text-white transition hover:bg-[#3F216B]"
            >
              View My Orders
            </Link>
            {!isPaid && !isExpired && !isLateReview ? (
              <Link
                href={`/orders/return?billcode=${encodeURIComponent(billCode)}&order_id=${encodeURIComponent(referenceCode)}`}
                className="inline-flex items-center gap-1.5 rounded-xl border border-[#E6E3EE] bg-white px-4 py-2.5 text-sm font-semibold text-[#14121A] transition hover:border-[#4E2A84] hover:text-[#4E2A84]"
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                <span>Re-check Status</span>
              </Link>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
