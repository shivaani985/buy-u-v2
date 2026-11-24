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

class ToyyibPayDefiniteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToyyibPayDefiniteError";
  }
}

async function postToyyibPayForm(
  endpointPath: string,
  formFields: Record<string, string | number>
): Promise<unknown> {
  const config = getToyyibPaySandboxConfig();
  if (!config.configured) {
    throw new ToyyibPayDefiniteError(
      `ToyyibPay Sandbox is not configured (${config.missing.join(", ")}).`
    );
  }
  if (!config.baseUrl.startsWith("https://dev.toyyibpay.com")) {
    throw new ToyyibPayDefiniteError("Refusing non-sandbox ToyyibPay base URL.");
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
    if (res.status >= 400 && res.status < 500) {
      throw new ToyyibPayDefiniteError(`ToyyibPay Sandbox rejected request (HTTP ${res.status}).`);
    }
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

/**
 * Persistent DB-backed bill-creation coordination (`claim_order_bill_slot` /
 * `finalize_order_bill_slot`) using existing `UNIQUE(payments.order_id)`.
 * Safe across concurrent requests, multi-instance deployments, server restarts,
 * and ambiguous gateway timeouts (NEVER blindly recreates a bill after uncertain outcome).
 */
export async function ensureSandboxBillForOrder(input: {
  order: EnsureBillOrderInput;
  itemCount: number;
  buyerName: string;
  buyerEmail: string;
  origin: string;
}): Promise<EnsureBillResult> {
  const { order } = input;
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

  // 1. Atomically claim or reuse the persistent DB bill slot for this order
  const { data: claimRows, error: claimErr } = await service.rpc(
    "claim_order_bill_slot",
    { p_order_id: order.id }
  );

  if (claimErr) {
    return {
      ok: false,
      orderId: order.id,
      orderCode: order.order_code,
      billCode: null,
      billUrl: null,
      error: "Could not coordinate payment bill slot on server. Please retry.",
    };
  }

  const claim = (Array.isArray(claimRows) ? claimRows[0] : claimRows) as
    | {
        action?: string;
        bill_code?: string | null;
        bill_url?: string | null;
        attempt_token?: string | null;
      }
    | undefined;
  const action = claim?.action ?? "";
  const attemptToken = claim?.attempt_token ?? null;

  if (action === "reuse_bill" && claim?.bill_code && claim?.bill_url) {
    return {
      ok: true,
      orderId: order.id,
      orderCode: order.order_code,
      billCode: claim.bill_code,
      billUrl: claim.bill_url,
      reused: true,
    };
  }

  if (action === "in_progress") {
    return {
      ok: false,
      orderId: order.id,
      orderCode: order.order_code,
      billCode: null,
      billUrl: null,
      error: "Your ToyyibPay bill is being prepared. Please wait a few seconds and refresh.",
    };
  }

  if (action === "ambiguous_hold") {
    return {
      ok: false,
      orderId: order.id,
      orderCode: order.order_code,
      billCode: null,
      billUrl: null,
      error:
        "A previous payment bill request timed out with uncertain status. To prevent duplicate billing, please check My Orders or wait for the hold to reset.",
    };
  }

  if (action === "already_paid" || action === "already_terminal") {
    return {
      ok: false,
      orderId: order.id,
      orderCode: order.order_code,
      billCode: claim?.bill_code ?? null,
      billUrl: claim?.bill_url ?? null,
      error: "This order already has a completed or under-review payment.",
    };
  }

  if (action === "order_expired" || action === "order_not_found") {
    return {
      ok: false,
      orderId: order.id,
      orderCode: order.order_code,
      billCode: null,
      billUrl: null,
      error: "Payment window has expired. Reserved stock will be released.",
    };
  }

  if (action !== "create_new" || !attemptToken) {
    return {
      ok: false,
      orderId: order.id,
      orderCode: order.order_code,
      billCode: null,
      billUrl: null,
      error: "Could not reserve payment bill slot. Please refresh and try again.",
    };
  }

  const deadlineIso =
    order.payment_deadline || new Date(Date.now() + 15 * 60_000).toISOString();

  // 2. Call ToyyibPay Sandbox createBill and finalize slot with matching attempt_token
  let payload: ReturnType<typeof buildToyyibPayCreateBillPayload>;
  try {
    payload = buildToyyibPayCreateBillPayload({
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
  } catch (err) {
    await service.rpc("finalize_order_bill_slot", {
      p_order_id: order.id,
      p_attempt_token: attemptToken,
      p_outcome: "failed",
    });
    return {
      ok: false,
      orderId: order.id,
      orderCode: order.order_code,
      billCode: null,
      billUrl: null,
      error: err instanceof Error ? err.message : "Invalid bill payload.",
    };
  }

  try {
    const createdBill = await createToyyibPaySandboxBill(payload);

    const { data: finalizeRes } = await service.rpc("finalize_order_bill_slot", {
      p_order_id: order.id,
      p_attempt_token: attemptToken,
      p_outcome: "ready",
      p_bill_code: createdBill.billCode,
      p_bill_url: createdBill.billUrl,
    });

    if (finalizeRes !== "ready" && finalizeRes !== "recovered_ready") {
      return {
        ok: false,
        orderId: order.id,
        orderCode: order.order_code,
        billCode: null,
        billUrl: null,
        error: "Bill finalization was superseded. Check My Orders for the active bill.",
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
    // Definite HTTP 4xx rejection -> safe to mark failed for clean retry.
    // Timeout / abort / HTTP 5xx / network drop -> mark ambiguous while retaining attemptToken for safe late recovery.
    const outcome = err instanceof ToyyibPayDefiniteError ? "failed" : "ambiguous";
    await service.rpc("finalize_order_bill_slot", {
      p_order_id: order.id,
      p_attempt_token: attemptToken,
      p_outcome: outcome,
    });
    return {
      ok: false,
      orderId: order.id,
      orderCode: order.order_code,
      billCode: null,
      billUrl: null,
      error:
        outcome === "ambiguous"
          ? "Gateway response timed out with uncertain status. Check My Orders before retrying to avoid duplicate bills."
          : err instanceof Error
            ? err.message
            : "ToyyibPay Sandbox bill creation failed. Please retry.",
    };
  }
}

export interface EnsureCheckoutSessionInput {
  id: string;
  checkout_code: string;
  combined_subtotal_sen: number;
  fpx_fee_sen: number;
  total_paid_sen: number;
  status: string;
  payment_deadline: string;
}

export interface EnsureCheckoutBillResult {
  ok: boolean;
  checkoutSessionId: string;
  checkoutCode: string;
  billCode: string | null;
  billUrl: string | null;
  reused?: boolean;
  error?: string;
}

/**
 * Phase 6B.4 Unified Checkout: persistent DB-backed bill coordination on
 * `public.checkout_sessions` (`claim_checkout_bill_slot` / `finalize_checkout_bill_slot`).
 * Creates or reuses ONE ToyyibPay Sandbox FPX bill per checkout (ONE RM 1.00 FPX fee).
 */
export async function ensureSandboxBillForCheckoutSession(input: {
  session: EnsureCheckoutSessionInput;
  itemCount: number;
  buyerName: string;
  buyerEmail: string;
  origin: string;
}): Promise<EnsureCheckoutBillResult> {
  const { session } = input;
  const service = getServerServiceClient();
  if (!service) {
    return {
      ok: false,
      checkoutSessionId: session.id,
      checkoutCode: session.checkout_code,
      billCode: null,
      billUrl: null,
      error: "Payment service is not configured.",
    };
  }

  const config = getToyyibPaySandboxConfig();
  if (!config.configured) {
    return {
      ok: false,
      checkoutSessionId: session.id,
      checkoutCode: session.checkout_code,
      billCode: null,
      billUrl: null,
      error: "ToyyibPay Sandbox credentials are missing on the server.",
    };
  }

  const { data: claimRows, error: claimErr } = await service.rpc(
    "claim_checkout_bill_slot",
    { p_checkout_session_id: session.id }
  );

  if (claimErr) {
    return {
      ok: false,
      checkoutSessionId: session.id,
      checkoutCode: session.checkout_code,
      billCode: null,
      billUrl: null,
      error: "Could not coordinate checkout payment bill on server. Please retry.",
    };
  }

  const claim = (Array.isArray(claimRows) ? claimRows[0] : claimRows) as
    | {
        action?: string;
        bill_code?: string | null;
        bill_url?: string | null;
        attempt_token?: string | null;
      }
    | undefined;
  const action = claim?.action ?? "";
  const attemptToken = claim?.attempt_token ?? null;

  if (action === "reuse_bill" && claim?.bill_code && claim?.bill_url) {
    return {
      ok: true,
      checkoutSessionId: session.id,
      checkoutCode: session.checkout_code,
      billCode: claim.bill_code,
      billUrl: claim.bill_url,
      reused: true,
    };
  }

  if (action === "in_progress") {
    return {
      ok: false,
      checkoutSessionId: session.id,
      checkoutCode: session.checkout_code,
      billCode: null,
      billUrl: null,
      error: "Your ToyyibPay bill is being prepared. Please wait a few seconds and refresh.",
    };
  }

  if (action === "ambiguous_hold") {
    return {
      ok: false,
      checkoutSessionId: session.id,
      checkoutCode: session.checkout_code,
      billCode: null,
      billUrl: null,
      error:
        "A previous payment bill request timed out with uncertain status. Check My Orders before retrying to prevent duplicate billing.",
    };
  }

  if (action === "already_paid" || action === "already_terminal") {
    return {
      ok: false,
      checkoutSessionId: session.id,
      checkoutCode: session.checkout_code,
      billCode: claim?.bill_code ?? null,
      billUrl: claim?.bill_url ?? null,
      error: "This checkout already has a completed or under-review payment.",
    };
  }

  if (action === "checkout_expired" || action === "checkout_not_found") {
    return {
      ok: false,
      checkoutSessionId: session.id,
      checkoutCode: session.checkout_code,
      billCode: null,
      billUrl: null,
      error: "Payment window has expired. Reserved stock will be released.",
    };
  }

  if (action !== "create_new" || !attemptToken) {
    return {
      ok: false,
      checkoutSessionId: session.id,
      checkoutCode: session.checkout_code,
      billCode: null,
      billUrl: null,
      error: "Could not reserve checkout payment bill slot. Please refresh and try again.",
    };
  }

  let payload: ReturnType<typeof buildToyyibPayCreateBillPayload>;
  try {
    payload = buildToyyibPayCreateBillPayload({
      secretKey: config.secretKey,
      categoryCode: config.categoryCode,
      orderCode: session.checkout_code,
      itemCount: Math.max(1, input.itemCount),
      subtotalSen: session.combined_subtotal_sen,
      fpxFeeSen: session.fpx_fee_sen,
      totalPaidSen: session.total_paid_sen,
      buyerName: input.buyerName,
      buyerEmail: input.buyerEmail,
      returnUrl: `${input.origin}/orders/return`,
      callbackUrl: `${input.origin}/api/payments/toyyibpay/callback`,
      paymentDeadlineIso: session.payment_deadline,
    });
  } catch (err) {
    await service.rpc("finalize_checkout_bill_slot", {
      p_checkout_session_id: session.id,
      p_attempt_token: attemptToken,
      p_outcome: "failed",
    });
    return {
      ok: false,
      checkoutSessionId: session.id,
      checkoutCode: session.checkout_code,
      billCode: null,
      billUrl: null,
      error: err instanceof Error ? err.message : "Invalid bill payload.",
    };
  }

  try {
    const createdBill = await createToyyibPaySandboxBill(payload);

    const { data: finalizeRes } = await service.rpc("finalize_checkout_bill_slot", {
      p_checkout_session_id: session.id,
      p_attempt_token: attemptToken,
      p_outcome: "ready",
      p_bill_code: createdBill.billCode,
      p_bill_url: createdBill.billUrl,
    });

    if (finalizeRes !== "ready" && finalizeRes !== "recovered_ready") {
      return {
        ok: false,
        checkoutSessionId: session.id,
        checkoutCode: session.checkout_code,
        billCode: null,
        billUrl: null,
        error: "Bill finalization was superseded. Check My Orders for the active bill.",
      };
    }

    return {
      ok: true,
      checkoutSessionId: session.id,
      checkoutCode: session.checkout_code,
      billCode: createdBill.billCode,
      billUrl: createdBill.billUrl,
      reused: false,
    };
  } catch (err) {
    const outcome = err instanceof ToyyibPayDefiniteError ? "failed" : "ambiguous";
    await service.rpc("finalize_checkout_bill_slot", {
      p_checkout_session_id: session.id,
      p_attempt_token: attemptToken,
      p_outcome: outcome,
    });
    return {
      ok: false,
      checkoutSessionId: session.id,
      checkoutCode: session.checkout_code,
      billCode: null,
      billUrl: null,
      error:
        outcome === "ambiguous"
          ? "Gateway response timed out with uncertain status. Check My Orders before retrying to avoid duplicate bills."
          : err instanceof Error
            ? err.message
            : "ToyyibPay Sandbox bill creation failed. Please retry.",
    };
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
  checkoutSessionId?: string;
  checkoutCode?: string;
  orderId?: string;
  orderCode?: string;
  message: string;
}

/**
 * Authoritative server-to-server ToyyibPay payment verification & reconciliation.
 * Supports BOTH Phase 6B.4 unified `checkout_sessions` (checked first) and
 * legacy single-order `payments`. ALWAYS calls ToyyibPay `getBillTransactions`
 * before mutating payment/order state.
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

  // 1. Check Phase 6B.4 unified `checkout_sessions` FIRST
  const { data: sessionRow } = await service
    .from("checkout_sessions")
    .select(
      "id, checkout_code, status, total_paid_sen, payment_deadline, paid_at, payment_status, transaction_ref"
    )
    .eq("bill_code", billCode)
    .maybeSingle();

  if (sessionRow) {
    if (
      input.expectedOrderCode &&
      input.expectedOrderCode.trim() !== sessionRow.checkout_code
    ) {
      return {
        ok: false,
        outcome: "rejected",
        checkoutSessionId: sessionRow.id,
        checkoutCode: sessionRow.checkout_code,
        orderCode: sessionRow.checkout_code,
        message: "Checkout reference mismatch.",
      };
    }

    let transactions: ToyyibPayTransactionRecord[];
    try {
      transactions = await fetchToyyibPayBillTransactions(billCode);
    } catch (err) {
      return {
        ok: false,
        outcome: "pending",
        checkoutSessionId: sessionRow.id,
        checkoutCode: sessionRow.checkout_code,
        orderCode: sessionRow.checkout_code,
        message:
          err instanceof Error
            ? `Verification pending: ${err.message}`
            : "Could not verify transaction with ToyyibPay right now.",
      };
    }

    const matching = transactions.filter(
      (t) =>
        t.billCode === billCode &&
        t.billExternalReferenceNo === sessionRow.checkout_code
    );
    const chosenTx =
      matching.find((t) => t.billpaymentStatus === "1") ??
      matching.find((t) => t.billpaymentStatus === "3") ??
      matching.find((t) => t.billpaymentStatus === "2") ??
      null;

    if (!chosenTx) {
      if (
        sessionRow.status === "expired" ||
        (sessionRow.payment_deadline &&
          Date.now() >= new Date(sessionRow.payment_deadline).getTime())
      ) {
        return {
          ok: true,
          outcome: "expired",
          checkoutSessionId: sessionRow.id,
          checkoutCode: sessionRow.checkout_code,
          orderCode: sessionRow.checkout_code,
          message: "Payment window expired without a completed transaction.",
        };
      }
      return {
        ok: true,
        outcome: "pending",
        checkoutSessionId: sessionRow.id,
        checkoutCode: sessionRow.checkout_code,
        orderCode: sessionRow.checkout_code,
        message: "Waiting for ToyyibPay FPX confirmation.",
      };
    }

    const decision = evaluateToyyibPayVerification({
      source: "verified_server_transaction",
      order: {
        orderCode: sessionRow.checkout_code,
        status: sessionRow.status,
        totalPaidSen: Number(sessionRow.total_paid_sen),
        paymentDeadlineIso: sessionRow.payment_deadline,
        paidAt: sessionRow.paid_at,
        existingTransactionRef: sessionRow.transaction_ref,
      },
      expectedBillCode: billCode,
      transaction: chosenTx,
    });

    if (decision.action === "await_verification") {
      return {
        ok: true,
        outcome: "pending",
        checkoutSessionId: sessionRow.id,
        checkoutCode: sessionRow.checkout_code,
        orderCode: sessionRow.checkout_code,
        message: decision.reason,
      };
    }

    if (decision.action === "idempotent_already_paid") {
      return {
        ok: true,
        outcome: "already_paid",
        checkoutSessionId: sessionRow.id,
        checkoutCode: sessionRow.checkout_code,
        orderCode: sessionRow.checkout_code,
        message: "Payment already confirmed.",
      };
    }

    if (decision.action === "mark_failed") {
      const { data: failOutcome } = await service.rpc(
        "mark_checkout_payment_failed_atomic",
        {
          p_checkout_session_id: sessionRow.id,
          p_bill_code: billCode,
          p_raw_callback:
            input.rawCallback ?? (chosenTx as unknown as Record<string, unknown>),
        }
      );
      if (String(failOutcome ?? "") === "ignored_terminal") {
        return {
          ok: true,
          outcome: "already_paid",
          checkoutSessionId: sessionRow.id,
          checkoutCode: sessionRow.checkout_code,
          orderCode: sessionRow.checkout_code,
          message: "Checkout already reached a terminal paid or reconciliation state.",
        };
      }
      return {
        ok: true,
        outcome: "failed",
        checkoutSessionId: sessionRow.id,
        checkoutCode: sessionRow.checkout_code,
        orderCode: sessionRow.checkout_code,
        message: decision.reason,
      };
    }

    if (decision.action === "reject") {
      return {
        ok: false,
        outcome: "rejected",
        checkoutSessionId: sessionRow.id,
        checkoutCode: sessionRow.checkout_code,
        orderCode: sessionRow.checkout_code,
        message: decision.reason,
      };
    }

    const { data: rpcOutcome, error: rpcErr } = await service.rpc(
      "confirm_checkout_payment_atomic",
      {
        p_checkout_session_id: sessionRow.id,
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
        checkoutSessionId: sessionRow.id,
        checkoutCode: sessionRow.checkout_code,
        orderCode: sessionRow.checkout_code,
        message: rpcErr.message,
      };
    }

    const normalized = String(rpcOutcome ?? "");
    if (normalized === "confirmed_paid") {
      return {
        ok: true,
        outcome: "confirmed_paid",
        checkoutSessionId: sessionRow.id,
        checkoutCode: sessionRow.checkout_code,
        orderCode: sessionRow.checkout_code,
        message: "Payment verified and all seller orders confirmed.",
      };
    }
    if (normalized === "already_paid") {
      return {
        ok: true,
        outcome: "already_paid",
        checkoutSessionId: sessionRow.id,
        checkoutCode: sessionRow.checkout_code,
        orderCode: sessionRow.checkout_code,
        message: "Payment already confirmed.",
      };
    }
    if (normalized === "late_payment_reconciliation") {
      return {
        ok: true,
        outcome: "late_payment_reconciliation",
        checkoutSessionId: sessionRow.id,
        checkoutCode: sessionRow.checkout_code,
        orderCode: sessionRow.checkout_code,
        message:
          "Payment arrived after checkout expiry. Logged for admin refund reconciliation without deducting stock.",
      };
    }

    return {
      ok: false,
      outcome: "rejected",
      checkoutSessionId: sessionRow.id,
      checkoutCode: sessionRow.checkout_code,
      orderCode: sessionRow.checkout_code,
      message: `Unexpected confirmation outcome: ${normalized}`,
    };
  }

  // 2. Legacy single-order `payments` fallback (preserves historical & pre-6B.4 orders)

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
    const { data: failOutcome } = await service.rpc(
      "mark_order_payment_failed_atomic",
      {
        p_order_id: orderRow.id,
        p_bill_code: billCode,
        p_raw_callback:
          input.rawCallback ?? (chosenTx as unknown as Record<string, unknown>),
      }
    );
    if (String(failOutcome ?? "") === "ignored_terminal") {
      return {
        ok: true,
        outcome: "already_paid",
        orderId: orderRow.id,
        orderCode: orderRow.order_code,
        message: "Order already reached a terminal paid or reconciliation state.",
      };
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
