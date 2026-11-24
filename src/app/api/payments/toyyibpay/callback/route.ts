import { NextResponse } from "next/server";
import { parseToyyibPayWebhookEnvelope } from "@/lib/payments/toyyibpay";
import { verifyAndReconcileBillPayment } from "@/lib/payments/toyyibpay-server";

export const dynamic = "force-dynamic";

async function parseIncomingCallbackBody(
  request: Request
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const json = await request.json().catch(() => null);
    return json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  }

  // ToyyibPay sends webhooks as application/x-www-form-urlencoded or multipart/form-data
  const text = await request.text().catch(() => "");
  const params = new URLSearchParams(text);
  const out: Record<string, unknown> = {};
  for (const [k, v] of params.entries()) {
    out[k] = v;
  }
  return out;
}

/**
 * ToyyibPay Sandbox server-to-server callback endpoint.
 * NEVER marks an order Paid from raw webhook POST fields alone — always performs
 * authoritative server-to-server `getBillTransactions` verification before calling
 * `confirm_order_payment_atomic`.
 */
export async function POST(request: Request) {
  const raw = await parseIncomingCallbackBody(request);
  const envelope = parseToyyibPayWebhookEnvelope(raw);
  if (!envelope) {
    return NextResponse.json(
      { ok: false, error: "Invalid callback payload." },
      { status: 400 }
    );
  }

  const result = await verifyAndReconcileBillPayment({
    billCode: envelope.billCode,
    expectedOrderCode: envelope.orderCode,
    rawCallback: raw,
  });

  if (result.outcome === "rejected") {
    return NextResponse.json(
      { ok: false, outcome: result.outcome },
      { status: 400 }
    );
  }

  return NextResponse.json({
    ok: true,
    outcome: result.outcome,
    orderCode: result.orderCode ?? null,
  });
}
