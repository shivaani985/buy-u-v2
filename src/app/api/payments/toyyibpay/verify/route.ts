import { NextResponse } from "next/server";
import { evaluateBuyerEligibility } from "@/lib/buyer/validation";
import { verifyAndReconcileBillPayment } from "@/lib/payments/toyyibpay-server";
import {
  createSupabaseServerClient,
  getSessionSummary,
} from "@/lib/supabase/server";
import { getServerServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/**
 * Authenticated buyer-only endpoint to re-check a pending ToyyibPay Sandbox bill
 * via authoritative server-to-server `getBillTransactions`.
 */
export async function POST(request: Request) {
  const session = await getSessionSummary();
  const eligibility = evaluateBuyerEligibility(session);
  if (!eligibility.eligible || !eligibility.userId) {
    return NextResponse.json(
      { ok: false, error: "Sign in to verify payment status." },
      { status: 401 }
    );
  }

  const body = (await request.json().catch(() => null)) as
    | { orderId?: unknown; billCode?: unknown }
    | null;
  const orderId = typeof body?.orderId === "string" ? body.orderId.trim() : "";
  const billCodeInput =
    typeof body?.billCode === "string" ? body.billCode.trim() : "";

  if (!orderId && !billCodeInput) {
    return NextResponse.json(
      { ok: false, error: "Missing orderId or billCode." },
      { status: 400 }
    );
  }

  const supabase = await createSupabaseServerClient();
  const service = getServerServiceClient();
  if (!supabase || !service) {
    return NextResponse.json(
      { ok: false, error: "Payment verification service is not configured." },
      { status: 503 }
    );
  }

  let resolvedOrderId = orderId;
  let resolvedBillCode = billCodeInput;
  let expectedOrderCode: string | null = null;

  if (resolvedOrderId) {
    const { data: orderRow } = await supabase
      .from("orders")
      .select("id, order_code")
      .eq("id", resolvedOrderId)
      .eq("buyer_id", eligibility.userId)
      .maybeSingle();

    if (!orderRow) {
      return NextResponse.json(
        { ok: false, error: "Order not found." },
        { status: 404 }
      );
    }
    expectedOrderCode = orderRow.order_code;

    if (!resolvedBillCode) {
      const { data: payRows } = await service
        .from("payments")
        .select("bill_code")
        .eq("order_id", orderRow.id)
        .order("created_at", { ascending: false })
        .limit(1);
      resolvedBillCode = payRows?.[0]?.bill_code ?? "";
    }
  } else if (resolvedBillCode) {
    const { data: payRow } = await service
      .from("payments")
      .select("order_id")
      .eq("bill_code", resolvedBillCode)
      .maybeSingle();
    if (!payRow) {
      return NextResponse.json(
        { ok: false, error: "Payment bill not found." },
        { status: 404 }
      );
    }
    const { data: orderRow } = await supabase
      .from("orders")
      .select("id, order_code")
      .eq("id", payRow.order_id)
      .eq("buyer_id", eligibility.userId)
      .maybeSingle();
    if (!orderRow) {
      return NextResponse.json(
        { ok: false, error: "Forbidden." },
        { status: 403 }
      );
    }
    resolvedOrderId = orderRow.id;
    expectedOrderCode = orderRow.order_code;
  }

  if (!resolvedBillCode) {
    return NextResponse.json(
      { ok: false, error: "No ToyyibPay bill exists for this order yet." },
      { status: 404 }
    );
  }

  const result = await verifyAndReconcileBillPayment({
    billCode: resolvedBillCode,
    expectedOrderCode,
  });

  return NextResponse.json({
    ok: result.ok,
    outcome: result.outcome,
    orderId: resolvedOrderId,
    orderCode: result.orderCode ?? expectedOrderCode,
    message: result.message,
  });
}
