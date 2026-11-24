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
  description: "Server-verified ToyyibPay Sandbox FPX payment status for your Buy-U order.",
};

export const dynamic = "force-dynamic";

interface ReturnPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return (value[0] ?? "").trim();
  return (value ?? "").trim();
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
            <Lock className="mt-0.5 h-5 w-5 shrink-0 text-[#4E2A84]" aria-hidden="true" />
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
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-[#B42318]" aria-hidden="true" />
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

  // Verify the authenticated buyer actually owns the order tied to this billCode
  const { data: payRow } = await service
    .from("payments")
    .select("order_id, bill_url")
    .eq("bill_code", billCode)
    .maybeSingle();

  const { data: ownedOrder } = payRow
    ? await supabase
        .from("orders")
        .select("id, order_code")
        .eq("id", payRow.order_id)
        .eq("buyer_id", eligibility.userId)
        .maybeSingle()
    : { data: null };

  if (!ownedOrder) {
    return (
      <div className="mx-auto w-full max-w-[720px] px-4 py-10 sm:px-6">
        <section className="rounded-2xl border border-[#E6E3EE] bg-white p-6 sm:p-8">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-[#B42318]" aria-hidden="true" />
            <div>
              <h1 className="text-lg font-extrabold text-[#14121A]">
                Payment bill not found for your account
              </h1>
              <p className="mt-1 text-sm text-[#6B6779]">
                We could not match this ToyyibPay reference to an order on your
                account.
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
    expectedOrderCode: orderCodeParam || ownedOrder.order_code,
  });

  // Load fresh buyer-only order state (pickup_pin retrieved strictly via buyer-only RPC)
  const { data: freshOrder } = await supabase
    .from("orders")
    .select(
      "id, order_code, status, subtotal_sen, fpx_fee_sen, total_paid_sen, collection_area_name, payment_deadline, paid_at"
    )
    .eq("id", ownedOrder.id)
    .eq("buyer_id", eligibility.userId)
    .single();

  const isPaid =
    verification.outcome === "confirmed_paid" ||
    verification.outcome === "already_paid" ||
    freshOrder?.status === "paid" ||
    freshOrder?.status === "ready_for_pickup" ||
    freshOrder?.status === "completed";

  let buyerPickupPin: string | null = null;
  if (isPaid && freshOrder) {
    const { data: pinRows } = await supabase.rpc("get_buyer_order_pickup_pins", {
      p_order_ids: [freshOrder.id],
    });
    const firstPin = (pinRows as Array<{ pickup_pin?: string | null }> | null)?.[0];
    buyerPickupPin = firstPin?.pickup_pin ?? null;
  }
  const isLateReview = verification.outcome === "late_payment_reconciliation";
  const isFailed = verification.outcome === "failed";
  const isExpired =
    verification.outcome === "expired" || freshOrder?.status === "expired";

  return (
    <div className="mx-auto w-full max-w-[760px] px-4 py-8 sm:px-6 lg:py-12">
      <section className="overflow-hidden rounded-2xl border border-[#E6E3EE] bg-white">
        <div className="border-b border-[#ECEAF3] px-6 py-6 sm:px-8">
          <div className="flex items-start gap-3.5">
            {isPaid ? (
              <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-[#008285]" aria-hidden="true" />
            ) : isLateReview ? (
              <ShieldAlert className="mt-0.5 h-6 w-6 shrink-0 text-[#B54708]" aria-hidden="true" />
            ) : isFailed || isExpired ? (
              <XCircle className="mt-0.5 h-6 w-6 shrink-0 text-[#B42318]" aria-hidden="true" />
            ) : (
              <Clock className="mt-0.5 h-6 w-6 shrink-0 text-[#4E2A84]" aria-hidden="true" />
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

        {freshOrder ? (
          <div className="space-y-5 px-6 py-6 sm:px-8">
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium text-[#6B6779]">Order Code</dt>
                <dd className="mt-0.5 font-bold text-[#14121A]">
                  #{freshOrder.order_code}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[#6B6779]">Total Payable</dt>
                <dd className="mt-0.5 font-extrabold text-[#4E2A84]">
                  {formatSenToRm(Number(freshOrder.total_paid_sen))}
                  <span className="ml-1.5 text-xs font-medium text-[#6B6779]">
                    (incl. {formatSenToRm(Number(freshOrder.fpx_fee_sen))} FPX)
                  </span>
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs font-medium text-[#6B6779]">
                  Campus Collection Area
                </dt>
                <dd className="mt-0.5 inline-flex items-center gap-1.5 font-semibold text-[#14121A]">
                  <MapPin className="h-3.5 w-3.5 text-[#4E2A84]" aria-hidden="true" />
                  <span>{freshOrder.collection_area_name || "UMSKAL Campus"}</span>
                </dd>
              </div>
            </dl>

            {isPaid && buyerPickupPin ? (
              <div className="rounded-xl border border-[#D8EAEB] bg-[#F4FAFA] p-4">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#008285]">
                  <KeyRound className="h-4 w-4" aria-hidden="true" />
                  <span>Your Private Campus Pickup PIN</span>
                </div>
                <p className="mt-2 font-mono text-2xl font-extrabold tracking-[0.25em] text-[#14121A]">
                  {buyerPickupPin}
                </p>
                <p className="mt-1.5 text-xs text-[#4A4656]">
                  Keep this PIN private until you meet the seller in person at{" "}
                  <strong>{freshOrder.collection_area_name || "UMSKAL Campus"}</strong>.
                  Sellers cannot see your PIN.
                </p>
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
                  href={`/orders/return?billcode=${encodeURIComponent(billCode)}&order_id=${encodeURIComponent(freshOrder.order_code)}`}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-[#E6E3EE] bg-white px-4 py-2.5 text-sm font-semibold text-[#14121A] transition hover:border-[#4E2A84] hover:text-[#4E2A84]"
                >
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                  <span>Re-check Status</span>
                </Link>
              ) : null}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
