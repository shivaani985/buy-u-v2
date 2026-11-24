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
 * (supports both Phase 6B.4 unified `checkoutSessionId` and legacy `orderId` / `billCode`)
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
    | { checkoutSessionId?: unknown; orderId?: unknown; billCode?: unknown }
    | null;
  const checkoutSessionId =
    typeof body?.checkoutSessionId === "string"
      ? body.checkoutSessionId.trim()
      : "";
  const orderId = typeof body?.orderId === "string" ? body.orderId.trim() : "";
  const billCodeInput =
    typeof body?.billCode === "string" ? body.billCode.trim() : "";

  if (!checkoutSessionId && !orderId && !billCodeInput) {
    return NextResponse.json(
      { ok: false, error: "Missing checkoutSessionId, orderId, or billCode." },
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

  let resolvedBillCode = billCodeInput;
  let expectedCode: string | null = null;
  let resolvedCheckoutId: string | undefined = checkoutSessionId || undefined;
  let resolvedOrderId: string | undefined = orderId || undefined;

  if (checkoutSessionId) {
    const { data: csRow } = await supabase
      .from("checkout_sessions")
      .select("id, checkout_code, bill_code")
      .eq("id", checkoutSessionId)
      .eq("buyer_id", eligibility.userId)
      .maybeSingle();

    if (!csRow) {
      return NextResponse.json(
        { ok: false, error: "Checkout session not found." },
        { status: 404 }
      );
    }
    expectedCode = csRow.checkout_code;
    resolvedBillCode = csRow.bill_code ?? "";
  } else if (orderId) {
    const { data: orderRow } = await supabase
      .from("orders")
      .select("id, order_code, checkout_session_id")
      .eq("id", orderId)
      .eq("buyer_id", eligibility.userId)
      .maybeSingle();

    if (!orderRow) {
      return NextResponse.json(
        { ok: false, error: "Order not found." },
        { status: 404 }
      );
    }

    if (orderRow.checkout_session_id) {
      const { data: csRow } = await supabase
        .from("checkout_sessions")
        .select("id, checkout_code, bill_code")
        .eq("id", orderRow.checkout_session_id)
        .eq("buyer_id", eligibility.userId)
        .maybeSingle();
      if (csRow) {
        resolvedCheckoutId = csRow.id;
        expectedCode = csRow.checkout_code;
        resolvedBillCode = csRow.bill_code ?? "";
      }
    } else {
      expectedCode = orderRow.order_code;
      if (!resolvedBillCode) {
        const { data: payRows } = await service
          .from("payments")
          .select("bill_code")
          .eq("order_id", orderRow.id)
          .order("created_at", { ascending: false })
          .limit(1);
        resolvedBillCode = payRows?.[0]?.bill_code ?? "";
      }
    }
  } else if (resolvedBillCode) {
    const { data: csRow } = await service
      .from("checkout_sessions")
      .select("id, buyer_id, checkout_code")
      .eq("bill_code", resolvedBillCode)
      .maybeSingle();

    if (csRow) {
      if (csRow.buyer_id !== eligibility.userId) {
        return NextResponse.json({ ok: false, error: "Forbidden." }, { status: 403 });
      }
      resolvedCheckoutId = csRow.id;
      expectedCode = csRow.checkout_code;
    } else {
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
        return NextResponse.json({ ok: false, error: "Forbidden." }, { status: 403 });
      }
      resolvedOrderId = orderRow.id;
      expectedCode = orderRow.order_code;
    }
  }

  if (!resolvedBillCode || resolvedBillCode.startsWith("creating:")) {
    return NextResponse.json(
      { ok: false, error: "No active ToyyibPay bill exists yet." },
      { status: 404 }
    );
  }

  const result = await verifyAndReconcileBillPayment({
    billCode: resolvedBillCode,
    expectedOrderCode: expectedCode,
  });

  return NextResponse.json({
    ok: result.ok,
    outcome: result.outcome,
    checkoutSessionId: result.checkoutSessionId ?? resolvedCheckoutId,
    checkoutCode: result.checkoutCode,
    orderId: resolvedOrderId,
    orderCode: result.orderCode ?? expectedCode,
    message: result.message,
  });
}
