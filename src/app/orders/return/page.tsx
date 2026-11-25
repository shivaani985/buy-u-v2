import { LATE_PAYMENT_GUIDANCE } from "@/lib/orders/lifecycle";
import type { Metadata } from "next";
import Link from "next/link";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Lock,
  RefreshCw,
  ShieldAlert,
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

  // Load the owned checkout summary after server verification
  let referenceCode = expectedRefCode;
  let totalPaidSen = 0;
  let fpxFeeSen = 100;
  let paymentDeadline: string | null = null;
  let isPaid =
    verification.outcome === "confirmed_paid" ||
    verification.outcome === "already_paid";
  let isExpired = verification.outcome === "expired";
  let isLateReview = verification.outcome === "late_payment_reconciliation";
  const isFailed = verification.outcome === "failed";

  let paidOrderCount = 0;
  if (ownedCheckoutId) {
    const [{ data: checkout }, { count }] = await Promise.all([
      supabase.from("checkout_sessions")
        .select("checkout_code,status,payment_status,paid_at,fpx_fee_sen,total_paid_sen,payment_deadline")
        .eq("id", ownedCheckoutId).eq("buyer_id", eligibility.userId).single(),
      supabase.from("orders").select("id", { count: "exact", head: true })
        .eq("checkout_session_id", ownedCheckoutId).eq("buyer_id", eligibility.userId).not("paid_at", "is", null),
    ]);
    if (checkout) {
      referenceCode = checkout.checkout_code;
      totalPaidSen = Number(checkout.total_paid_sen);
      fpxFeeSen = Number(checkout.fpx_fee_sen);
      paymentDeadline = checkout.payment_deadline;
      isPaid = checkout.status === "paid" && checkout.payment_status === "paid" && Boolean(checkout.paid_at);
      isLateReview = isLateReview || checkout.payment_status === "late_payment_review";
      isExpired = isExpired || checkout.status === "expired";
      paidOrderCount = count ?? 0;
    }
  } else if (ownedLegacyOrderId) {
    const { data: order } = await supabase.from("orders")
      .select("order_code,status,paid_at,fpx_fee_sen,total_paid_sen,payment_deadline")
      .eq("id", ownedLegacyOrderId).eq("buyer_id", eligibility.userId).single();
    if (order) {
      referenceCode = order.order_code;
      totalPaidSen = Number(order.total_paid_sen);
      fpxFeeSen = Number(order.fpx_fee_sen);
      paymentDeadline = order.payment_deadline;
      isExpired = isExpired || order.status === "expired";
      paidOrderCount = isPaid ? 1 : 0;
    }
  }

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
                  ? "Payment Successful"
                  : isLateReview
                    ? "Payment under review"
                    : isFailed
                      ? "Payment Failed or Cancelled"
                      : isExpired
                        ? "Payment Expired"
                        : "Verifying Payment with Bank"}
              </h1>
              <p className="mt-1.5 text-sm leading-relaxed text-[#4A4656]">
                {isLateReview ? LATE_PAYMENT_GUIDANCE : isPaid ? "Verified orders are now in progress. Contact your sellers to arrange collection or service delivery." : verification.message}
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
                {isPaid ? "Total paid" : "Checkout amount"}
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

          {isPaid && <p className="text-sm font-semibold text-ink-secondary">
            {paidOrderCount} {paidOrderCount === 1 ? "order" : "orders"} paid
          </p>}

          <div className="flex flex-wrap items-center gap-3 border-t border-[#ECEAF3] pt-5">
            <Link
              href="/orders"
              className="inline-flex items-center rounded-xl bg-[#4E2A84] px-5 py-2.5 text-sm font-bold text-white transition hover:bg-[#3F216B]"
            >
              View My Orders
            </Link>
            {isPaid && <Link href="/marketplace" className="rounded-xl border border-border-crisp px-4 py-2.5 text-sm font-semibold hover:text-brand-purple">
              Continue Shopping
            </Link>}
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
