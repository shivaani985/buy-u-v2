import { headers } from "next/headers";
import {
  buildToyyibPayCreateBillPayload,
  evaluateToyyibPayVerification,
  TOYYIBPAY_SANDBOX_BASE_URL,
  type ToyyibPayTransactionRecord,
} from "@/lib/payments/toyyibpay";
import { getServerServiceClient } from "@/lib/supabase/service";

export interface ToyyibPaySandboxConfig {
  configured: boolean;
  baseUrl: string;
  secretKey: string;
  categoryCode: string;
  missing: string[];
}

/**
 * Reads server-only ToyyibPay Sandbox credentials.
 * Strictly pinned to ToyyibPay Sandbox (`https://dev.toyyibpay.com`).
 * NEVER import this module from any client component.
 */
export function getToyyibPaySandboxConfig(): ToyyibPaySandboxConfig {
  if (typeof window !== "undefined") {
    throw new Error("ToyyibPay server module cannot be used in the browser.");
  }

  const secretKey = process.env.TOYYIBPAY_SANDBOX_SECRET_KEY?.trim() ?? "";
  const categoryCode = process.env.TOYYIBPAY_SANDBOX_CATEGORY_CODE?.trim() ?? "";
  const missing: string[] = [];
  if (!secretKey) missing.push("TOYYIBPAY_SANDBOX_SECRET_KEY");
  if (!categoryCode) missing.push("TOYYIBPAY_SANDBOX_CATEGORY_CODE");

  return {
    configured: missing.length === 0,
    baseUrl: TOYYIBPAY_SANDBOX_BASE_URL,
    secretKey,
    categoryCode,
    missing,
  };
}

export async function resolveAppOrigin(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured && /^https?:\/\//i.test(configured)) {
    return configured.replace(/\/+$/, "");
  }

  try {
    const hdrs = await headers();
    const host = hdrs.get("x-forwarded-host") || hdrs.get("host");
    const proto = hdrs.get("x-forwarded-proto") || (host?.includes("localhost") ? "http" : "https");
    if (host) {
      return `${proto}://${host}`.replace(/\/+$/, "");
    }
  } catch {
    // Outside request context
  }

  return "http://localhost:3000";
}

function toFormBody(record: Record<string, string | number>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(record)) {
    params.set(k, String(v));
  }
  return params;
}

async function postToyyibPayForm(
  endpointPath: string,
  formFields: Record<string, string | number>
): Promise<unknown> {
  const config = getToyyibPaySandboxConfig();
  if (!config.configured) {
    throw new Error(`ToyyibPay Sandbox is not configured (${config.missing.join(", ")}).`);
  }
  if (!config.baseUrl.startsWith("https://dev.toyyibpay.com")) {
    throw new Error("Refusing non-sandbox ToyyibPay base URL.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${config.baseUrl}${endpointPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: toFormBody(formFields).toString(),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`ToyyibPay Sandbox HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function createToyyibPaySandboxBill(
  payload: ReturnType<typeof buildToyyibPayCreateBillPayload>
): Promise<{ billCode: string; billUrl: string }> {
  const raw = await postToyyibPayForm(
    "/index.php/api/createBill",
    payload as unknown as Record<string, string | number>
  );

  const first = Array.isArray(raw) ? raw[0] : raw;
  const billCode =
    first && typeof first === "object" && "BillCode" in first
      ? String((first as { BillCode?: unknown }).BillCode ?? "").trim()
      : "";

  if (!billCode || !/^[A-Za-z0-9_-]{4,64}$/.test(billCode)) {
    throw new Error("ToyyibPay Sandbox did not return a valid BillCode.");
  }

  return {
    billCode,
    billUrl: `${TOYYIBPAY_SANDBOX_BASE_URL}/${encodeURIComponent(billCode)}`,
  };
}

export async function fetchToyyibPayBillTransactions(
  billCode: string
): Promise<ToyyibPayTransactionRecord[]> {
  const config = getToyyibPaySandboxConfig();
  const raw = await postToyyibPayForm("/index.php/api/getBillTransactions", {
    userSecretKey: config.secretKey,
    billCode: billCode.trim(),
  });

  if (!Array.isArray(raw)) return [];

  return raw
    .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object"))
    .map((row) => ({
      billCode: String(row.billCode ?? billCode).trim(),
      billExternalReferenceNo: String(row.billExternalReferenceNo ?? "").trim(),
      billpaymentStatus: String(row.billpaymentStatus ?? "").trim(),
      billpaymentAmount: String(row.billpaymentAmount ?? "").trim(),
      billpaymentInvoiceNo: String(row.billpaymentInvoiceNo ?? "").trim(),
    }));
}

export interface EnsureBillOrderInput {
  id: string;
  order_code: string;
  subtotal_sen: number;
  fpx_fee_sen: number;
  total_paid_sen: number;
  status: string;
  payment_deadline: string | null;
}

export interface EnsureBillResult {
  ok: boolean;
  orderId: string;
  orderCode: string;
  billCode: string | null;
  billUrl: string | null;
  reused?: boolean;
  error?: string;
}

// Per-order single-flight lock prevents concurrent retries from creating duplicate ToyyibPay bills.
// shortcut: in-process map; upgrade to a DB advisory lock or unique partial index on pending payments if scaling to multi-instance serverless.
const inFlightBillCreations = new Map<string, Promise<EnsureBillResult>>();

export async function ensureSandboxBillForOrder(input: {
  order: EnsureBillOrderInput;
  itemCount: number;
  buyerName: string;
  buyerEmail: string;
  origin: string;
}): Promise<EnsureBillResult> {
  const existingPromise = inFlightBillCreations.get(input.order.id);
  if (existingPromise) {
    return existingPromise;
  }

  const run = (async (): Promise<EnsureBillResult> => {
    const { order } = input;
    if (order.status !== "pending_payment") {
      return {
        ok: false,
        orderId: order.id,
        orderCode: order.order_code,
        billCode: null,
        billUrl: null,
        error: `Order is already ${order.status.replace(/_/g, " ")}.`,
      };
    }

    if (order.payment_deadline && Date.now() >= new Date(order.payment_deadline).getTime()) {
      return {
        ok: false,
        orderId: order.id,
        orderCode: order.order_code,
        billCode: null,
        billUrl: null,
        error: "Payment window has expired. Reserved stock will be released.",
      };
    }

    const service = getServerServiceClient();
    if (!service) {
      return {
        ok: false,
        orderId: order.id,
        orderCode: order.order_code,
        billCode: null,
        billUrl: null,
        error: "Payment service is not configured.",
      };
    }

    // Reuse an existing pending bill for this order to prevent duplicate gateway bills
    const { data: existingPayments } = await service
      .from("payments")
      .select("id, bill_code, bill_url, status")
      .eq("order_id", order.id)
      .in("status", ["pending", "paid", "late_payment_review"])
      .order("created_at", { ascending: false })
      .limit(1);

    const livePayment = existingPayments?.[0] as
      | { id: string; bill_code: string | null; bill_url: string | null; status: string }
      | undefined;

    if (livePayment?.status === "paid") {
      return {
        ok: false,
        orderId: order.id,
        orderCode: order.order_code,
        billCode: livePayment.bill_code,
        billUrl: livePayment.bill_url,
        error: "This order has already been paid.",
      };
    }

    if (livePayment?.status === "pending" && livePayment.bill_code && livePayment.bill_url) {
      return {
        ok: true,
        orderId: order.id,
        orderCode: order.order_code,
        billCode: livePayment.bill_code,
        billUrl: livePayment.bill_url,
        reused: true,
      };
    }

    const config = getToyyibPaySandboxConfig();
    if (!config.configured) {
      return {
        ok: false,
        orderId: order.id,
        orderCode: order.order_code,
        billCode: null,
        billUrl: null,
        error: "ToyyibPay Sandbox credentials are missing on the server.",
      };
    }

    const deadlineIso =
      order.payment_deadline || new Date(Date.now() + 15 * 60_000).toISOString();

    try {
      const payload = buildToyyibPayCreateBillPayload({
        secretKey: config.secretKey,
        categoryCode: config.categoryCode,
        orderCode: order.order_code,
        itemCount: Math.max(1, input.itemCount),
        subtotalSen: order.subtotal_sen,
        fpxFeeSen: order.fpx_fee_sen,
        totalPaidSen: order.total_paid_sen,
        buyerName: input.buyerName,
        buyerEmail: input.buyerEmail,
        returnUrl: `${input.origin}/orders/return`,
        callbackUrl: `${input.origin}/api/payments/toyyibpay/callback`,
        paymentDeadlineIso: deadlineIso,
      });

      const createdBill = await createToyyibPaySandboxBill(payload);

      const { error: insertErr } = await service.from("payments").insert({
        order_id: order.id,
        provider: "toyyibpay",
        bill_code: createdBill.billCode,
        bill_url: createdBill.billUrl,
        amount_sen: order.total_paid_sen,
        status: "pending",
      });

      if (insertErr) {
        return {
          ok: false,
          orderId: order.id,
          orderCode: order.order_code,
          billCode: null,
          billUrl: null,
          error: "Could not record payment bill on server. Please retry.",
        };
      }

      return {
        ok: true,
        orderId: order.id,
        orderCode: order.order_code,
        billCode: createdBill.billCode,
        billUrl: createdBill.billUrl,
        reused: false,
      };
    } catch (err) {
      return {
        ok: false,
        orderId: order.id,
        orderCode: order.order_code,
        billCode: null,
        billUrl: null,
        error:
          err instanceof Error
            ? err.message
            : "ToyyibPay Sandbox bill creation failed. Please retry.",
      };
    }
  })();

  inFlightBillCreations.set(input.order.id, run);
  try {
    return await run;
  } finally {
    inFlightBillCreations.delete(input.order.id);
  }
}

export interface ReconcileBillOutcome {
  ok: boolean;
  outcome:
    | "confirmed_paid"
    | "already_paid"
    | "late_payment_reconciliation"
    | "failed"
    | "pending"
    | "expired"
    | "rejected";
  orderId?: string;
  orderCode?: string;
  message: string;
}

/**
 * Authoritative server-to-server ToyyibPay payment verification & reconciliation.
 * ALWAYS calls ToyyibPay `getBillTransactions` before mutating payment/order state.
 */
export async function verifyAndReconcileBillPayment(input: {
  billCode: string;
  expectedOrderCode?: string | null;
  rawCallback?: Record<string, unknown> | null;
}): Promise<ReconcileBillOutcome> {
  const billCode = input.billCode.trim();
  if (!billCode) {
    return { ok: false, outcome: "rejected", message: "Missing bill code." };
  }

  const service = getServerServiceClient();
  if (!service) {
    return { ok: false, outcome: "rejected", message: "Payment service not configured." };
  }

  const { data: paymentRow, error: payErr } = await service
    .from("payments")
    .select("id, order_id, bill_code, amount_sen, status, transaction_ref")
    .eq("bill_code", billCode)
    .maybeSingle();

  if (payErr || !paymentRow) {
    return { ok: false, outcome: "rejected", message: "Payment bill record not found." };
  }

  const { data: orderRow, error: ordErr } = await service
    .from("orders")
    .select("id, order_code, status, total_paid_sen, payment_deadline, paid_at")
    .eq("id", paymentRow.order_id)
    .maybeSingle();

  if (ordErr || !orderRow) {
    return { ok: false, outcome: "rejected", message: "Linked order not found." };
  }

  if (
    input.expectedOrderCode &&
    input.expectedOrderCode.trim() !== orderRow.order_code
  ) {
    return {
      ok: false,
      outcome: "rejected",
      orderId: orderRow.id,
      orderCode: orderRow.order_code,
      message: "Order reference mismatch.",
    };
  }

  let transactions: ToyyibPayTransactionRecord[];
  try {
    transactions = await fetchToyyibPayBillTransactions(billCode);
  } catch (err) {
    return {
      ok: false,
      outcome: "pending",
      orderId: orderRow.id,
      orderCode: orderRow.order_code,
      message:
        err instanceof Error
          ? `Verification pending: ${err.message}`
          : "Could not verify transaction with ToyyibPay right now.",
    };
  }

  // Pick the most authoritative transaction matching this bill & order_code
  const matching = transactions.filter(
    (t) =>
      t.billCode === billCode &&
      t.billExternalReferenceNo === orderRow.order_code
  );
  const chosenTx =
    matching.find((t) => t.billpaymentStatus === "1") ??
    matching.find((t) => t.billpaymentStatus === "3") ??
    matching.find((t) => t.billpaymentStatus === "2") ??
    null;

  if (!chosenTx) {
    if (
      orderRow.status === "expired" ||
      (orderRow.payment_deadline &&
        Date.now() >= new Date(orderRow.payment_deadline).getTime())
    ) {
      return {
        ok: true,
        outcome: "expired",
        orderId: orderRow.id,
        orderCode: orderRow.order_code,
        message: "Payment window expired without a completed transaction.",
      };
    }
    return {
      ok: true,
      outcome: "pending",
      orderId: orderRow.id,
      orderCode: orderRow.order_code,
      message: "Waiting for ToyyibPay FPX confirmation.",
    };
  }

  const decision = evaluateToyyibPayVerification({
    source: "verified_server_transaction",
    order: {
      orderCode: orderRow.order_code,
      status: orderRow.status,
      totalPaidSen: Number(orderRow.total_paid_sen),
      paymentDeadlineIso: orderRow.payment_deadline,
      paidAt: orderRow.paid_at,
      existingTransactionRef: paymentRow.transaction_ref,
    },
    expectedBillCode: billCode,
    transaction: chosenTx,
  });

  if (decision.action === "await_verification") {
    return {
      ok: true,
      outcome: "pending",
      orderId: orderRow.id,
      orderCode: orderRow.order_code,
      message: decision.reason,
    };
  }

  if (decision.action === "idempotent_already_paid") {
    return {
      ok: true,
      outcome: "already_paid",
      orderId: orderRow.id,
      orderCode: orderRow.order_code,
      message: "Payment already confirmed.",
    };
  }

  if (decision.action === "mark_failed") {
    if (paymentRow.status === "pending") {
      await service
        .from("payments")
        .update({
          status: "failed",
          raw_callback: input.rawCallback ?? (chosenTx as unknown as Record<string, unknown>),
          updated_at: new Date().toISOString(),
        })
        .eq("id", paymentRow.id)
        .eq("status", "pending");
    }
    return {
      ok: true,
      outcome: "failed",
      orderId: orderRow.id,
      orderCode: orderRow.order_code,
      message: decision.reason,
    };
  }

  if (decision.action === "reject") {
    return {
      ok: false,
      outcome: "rejected",
      orderId: orderRow.id,
      orderCode: orderRow.order_code,
      message: decision.reason,
    };
  }

  // Both "confirm_paid" and "late_payment_reconciliation" execute atomically via hosted RPC
  const { data: rpcOutcome, error: rpcErr } = await service.rpc(
    "confirm_order_payment_atomic",
    {
      p_order_id: orderRow.id,
      p_bill_code: billCode,
      p_transaction_ref: decision.transactionRef,
      p_amount_sen: decision.amountSen,
      p_raw_callback: {
        verified_tx: chosenTx,
        webhook: input.rawCallback ?? null,
      },
    }
  );

  if (rpcErr) {
    return {
      ok: false,
      outcome: "rejected",
      orderId: orderRow.id,
      orderCode: orderRow.order_code,
      message: rpcErr.message,
    };
  }

  const normalized = String(rpcOutcome ?? "");
  if (normalized === "confirmed_paid") {
    return {
      ok: true,
      outcome: "confirmed_paid",
      orderId: orderRow.id,
      orderCode: orderRow.order_code,
      message: "Payment verified and order confirmed.",
    };
  }
  if (normalized === "already_paid") {
    return {
      ok: true,
      outcome: "already_paid",
      orderId: orderRow.id,
      orderCode: orderRow.order_code,
      message: "Payment already confirmed.",
    };
  }
  if (normalized === "late_payment_reconciliation") {
    return {
      ok: true,
      outcome: "late_payment_reconciliation",
      orderId: orderRow.id,
      orderCode: orderRow.order_code,
      message:
        "Payment arrived after order expiry. Logged for admin refund reconciliation without deducting stock.",
    };
  }

  return {
    ok: false,
    outcome: "rejected",
    orderId: orderRow.id,
    orderCode: orderRow.order_code,
    message: `Unexpected confirmation outcome: ${normalized}`,
  };
}
