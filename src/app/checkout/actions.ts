"use server";

import { revalidatePath } from "next/cache";
import { getCartPageData } from "@/lib/buyer/cart-data";
import {
  buildCheckoutPreparation,
  type CheckoutPreparationSummary,
} from "@/lib/buyer/checkout";
import { evaluateBuyerEligibility } from "@/lib/buyer/validation";
import {
  ensureSandboxBillForCheckoutSession,
  ensureSandboxBillForOrder,
  resolveAppOrigin,
  type EnsureBillOrderInput,
  type EnsureCheckoutSessionInput,
} from "@/lib/payments/toyyibpay-server";
import {
  createSupabaseServerClient,
  getSessionSummary,
} from "@/lib/supabase/server";

export interface RevalidateCheckoutResult {
  ok: boolean;
  preparation?: CheckoutPreparationSummary;
  checkedAtIso?: string;
  error?: string;
}

export interface UnifiedCheckoutActionResult {
  ok: boolean;
  checkoutSessionId?: string;
  checkoutCode?: string;
  totalPaidSen?: number;
  billCode?: string | null;
  billUrl?: string | null;
  paymentDeadline?: string | null;
  error?: string;
}

export interface SingleBillActionResult {
  ok: boolean;
  orderId?: string;
  orderCode?: string;
  billCode?: string | null;
  billUrl?: string | null;
  paymentDeadline?: string | null;
  error?: string;
}

function mapCheckoutRpcError(rawMessage: string): string {
  if (rawMessage.includes("CART_EMPTY")) {
    return "Your cart is empty. Add items before checking out.";
  }
  if (
    rawMessage.includes("INSUFFICIENT_VARIANT_STOCK") ||
    rawMessage.includes("INSUFFICIENT_LISTING_STOCK")
  ) {
    return "One or more items no longer have enough available stock. Refresh checkout to review.";
  }
  if (
    rawMessage.includes("LISTING_UNAVAILABLE") ||
    rawMessage.includes("VARIANT_UNAVAILABLE")
  ) {
    return "An item in your cart is no longer available. Return to your cart to update it.";
  }
  if (rawMessage.includes("SELLER_NOT_ACTIVE")) {
    return "A seller in your cart is currently inactive and cannot accept orders.";
  }
  if (rawMessage.includes("MEMBER_BLOCKED")) {
    return "Checkout is unavailable with a blocked member.";
  }
  if (rawMessage.includes("SELF_PURCHASE_FORBIDDEN")) {
    return "You cannot purchase your own listing.";
  }
  if (
    rawMessage.includes("OFFER_HOLD_EXPIRED") ||
    rawMessage.includes("OFFER_ORDER_ALREADY_TERMINAL")
  ) {
    return "This offer's 30-minute reservation hold has expired or is already closed.";
  }
  if (rawMessage.includes("FOOD_PREORDER_NOT_ENABLED")) {
    return "Food pre-orders are not enabled for online checkout yet.";
  }
  return "Could not create your checkout right now. Please refresh and try again.";
}

export async function revalidateCheckoutAction(
  priceSnapshots: Record<string, number>
): Promise<RevalidateCheckoutResult> {
  const session = await getSessionSummary();
  const { eligibility, summary, error } = await getCartPageData(session);

  if (!eligibility.eligible) {
    return {
      ok: false,
      error:
        eligibility.reason ||
        "Your session is not eligible for checkout. Please sign in again.",
    };
  }

  if (error) {
    return { ok: false, error };
  }

  const preparation = buildCheckoutPreparation(summary, priceSnapshots);
  return {
    ok: true,
    preparation,
    checkedAtIso: new Date().toISOString(),
  };
}

/**
 * Phase 6B.4 Unified Checkout: creates ONE `checkout_sessions` row + separate
 * internal seller `orders` via `create_cart_checkout_atomic`, and generates ONE
 * consolidated ToyyibPay Sandbox FPX bill (ONE RM 1.00 FPX fee per checkout).
 */
export async function startCartToyyibPayCheckoutAction(input: {
  idempotencyKey: string;
  priceSnapshots: Record<string, number>;
}): Promise<UnifiedCheckoutActionResult> {
  const session = await getSessionSummary();
  const { eligibility, summary, error } = await getCartPageData(session);

  if (!eligibility.eligible || !eligibility.userId) {
    return {
      ok: false,
      error: eligibility.reason || "Sign in with an active UMS account to pay.",
    };
  }

  if (error) {
    return { ok: false, error };
  }

  const key = (input.idempotencyKey ?? "").trim();
  if (key.length < 8 || key.length > 128) {
    return {
      ok: false,
      error: "Invalid checkout session key. Please refresh and retry.",
    };
  }

  const preparation = buildCheckoutPreparation(summary, input.priceSnapshots);
  if (preparation.totalRowCount > 0 && !preparation.canProceedToPayment) {
    return {
      ok: false,
      error:
        preparation.blockingReasons[0] ||
        "Resolve highlighted cart or price changes before paying.",
    };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, error: "Database connection is not configured." };
  }

  const { data: checkoutRow, error: rpcErr } = await supabase.rpc(
    "create_cart_checkout_atomic",
    { p_idempotency_key: key }
  );

  const firstSession = (
    Array.isArray(checkoutRow) ? checkoutRow[0] : checkoutRow
  ) as EnsureCheckoutSessionInput | undefined;

  if (rpcErr || !firstSession?.id) {
    return {
      ok: false,
      error: mapCheckoutRpcError(rpcErr?.message ?? "CART_EMPTY"),
    };
  }

  const typedSession = firstSession;

  const { data: childOrders } = await supabase
    .from("orders")
    .select("id")
    .eq("checkout_session_id", typedSession.id);
  const childIds = ((childOrders ?? []) as Array<{ id: string }>).map(
    (o) => o.id
  );
  let totalItemCount = Math.max(1, preparation.validQuantity);
  if (childIds.length > 0) {
    const { data: itemsRaw } = await supabase
      .from("order_items")
      .select("quantity")
      .in("order_id", childIds);
    const counted = ((itemsRaw ?? []) as Array<{ quantity: number }>).reduce(
      (sum, r) => sum + Number(r.quantity ?? 1),
      0
    );
    if (counted > 0) totalItemCount = counted;
  }

  const buyerName =
    session.profile?.display_name?.trim() ||
    session.profile?.full_name?.trim() ||
    session.email?.split("@")[0] ||
    "UMS Member";
  const buyerEmail = session.email || session.profile?.email || "";
  const origin = await resolveAppOrigin();

  const billRes = await ensureSandboxBillForCheckoutSession({
    session: typedSession,
    itemCount: totalItemCount,
    buyerName,
    buyerEmail,
    origin,
  });

  revalidatePath("/cart");
  revalidatePath("/checkout");
  revalidatePath("/orders");

  return {
    ok: billRes.ok,
    checkoutSessionId: typedSession.id,
    checkoutCode: typedSession.checkout_code,
    totalPaidSen: Number(typedSession.total_paid_sen),
    billCode: billRes.billCode,
    billUrl: billRes.billUrl,
    paymentDeadline: typedSession.payment_deadline,
    error: billRes.error,
  };
}

/**
 * Safely retries or resumes the single ToyyibPay Sandbox bill for an existing
 * buyer-owned unified `checkout_sessions` record (reuses valid existing bill).
 */
export async function retryCheckoutSandboxBillAction(
  checkoutSessionId: string
): Promise<UnifiedCheckoutActionResult> {
  const session = await getSessionSummary();
  const eligibility = evaluateBuyerEligibility(session);
  if (!eligibility.eligible || !eligibility.userId) {
    return { ok: false, error: eligibility.reason || "Sign in to continue." };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, error: "Database connection is not configured." };
  }

  const { data: checkoutRow, error: csErr } = await supabase
    .from("checkout_sessions")
    .select(
      "id, checkout_code, combined_subtotal_sen, fpx_fee_sen, total_paid_sen, status, payment_deadline"
    )
    .eq("id", checkoutSessionId)
    .eq("buyer_id", eligibility.userId)
    .maybeSingle();

  if (csErr || !checkoutRow) {
    return { ok: false, error: "Checkout session not found." };
  }

  const { data: childOrders } = await supabase
    .from("orders")
    .select("id")
    .eq("checkout_session_id", checkoutRow.id);
  const childIds = ((childOrders ?? []) as Array<{ id: string }>).map(
    (o) => o.id
  );
  let itemCount = 1;
  if (childIds.length > 0) {
    const { data: itemsRaw } = await supabase
      .from("order_items")
      .select("quantity")
      .in("order_id", childIds);
    itemCount = Math.max(
      1,
      ((itemsRaw ?? []) as Array<{ quantity: number }>).reduce(
        (sum, r) => sum + Number(r.quantity ?? 1),
        0
      )
    );
  }

  const buyerName =
    session.profile?.display_name?.trim() ||
    session.profile?.full_name?.trim() ||
    session.email?.split("@")[0] ||
    "UMS Member";
  const buyerEmail = session.email || session.profile?.email || "";
  const origin = await resolveAppOrigin();

  const billRes = await ensureSandboxBillForCheckoutSession({
    session: checkoutRow as EnsureCheckoutSessionInput,
    itemCount,
    buyerName,
    buyerEmail,
    origin,
  });

  revalidatePath("/orders");
  return {
    ok: billRes.ok,
    checkoutSessionId: checkoutRow.id,
    checkoutCode: checkoutRow.checkout_code,
    totalPaidSen: Number(checkoutRow.total_paid_sen),
    billCode: billRes.billCode,
    billUrl: billRes.billUrl,
    paymentDeadline: checkoutRow.payment_deadline,
    error: billRes.error,
  };
}

/**
 * Legacy fallback for pre-6B.4 standalone `pending_payment` orders (`checkout_session_id IS NULL`).
 */
export async function retryOrderSandboxBillAction(
  orderId: string
): Promise<SingleBillActionResult> {
  const session = await getSessionSummary();
  const eligibility = evaluateBuyerEligibility(session);
  if (!eligibility.eligible || !eligibility.userId) {
    return { ok: false, error: eligibility.reason || "Sign in to continue." };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, error: "Database connection is not configured." };
  }

  const { data: orderRow, error: ordErr } = await supabase
    .from("orders")
    .select(
      "id, order_code, checkout_session_id, subtotal_sen, fpx_fee_sen, total_paid_sen, status, payment_deadline"
    )
    .eq("id", orderId)
    .eq("buyer_id", eligibility.userId)
    .maybeSingle();

  if (ordErr || !orderRow) {
    return { ok: false, error: "Order not found." };
  }

  if (orderRow.checkout_session_id) {
    const unified = await retryCheckoutSandboxBillAction(
      orderRow.checkout_session_id
    );
    return {
      ok: unified.ok,
      orderId: orderRow.id,
      orderCode: unified.checkoutCode ?? orderRow.order_code,
      billCode: unified.billCode,
      billUrl: unified.billUrl,
      paymentDeadline: unified.paymentDeadline,
      error: unified.error,
    };
  }

  const { data: itemsRaw } = await supabase
    .from("order_items")
    .select("quantity")
    .eq("order_id", orderRow.id);
  const itemCount = ((itemsRaw ?? []) as Array<{ quantity: number }>).reduce(
    (sum, r) => sum + Number(r.quantity ?? 1),
    0
  );

  const buyerName =
    session.profile?.display_name?.trim() ||
    session.profile?.full_name?.trim() ||
    session.email?.split("@")[0] ||
    "UMS Member";
  const buyerEmail = session.email || session.profile?.email || "";
  const origin = await resolveAppOrigin();

  const billRes = await ensureSandboxBillForOrder({
    order: orderRow as EnsureBillOrderInput,
    itemCount: Math.max(1, itemCount),
    buyerName,
    buyerEmail,
    origin,
  });

  revalidatePath("/orders");
  return {
    ok: billRes.ok,
    orderId: billRes.orderId,
    orderCode: billRes.orderCode,
    billCode: billRes.billCode,
    billUrl: billRes.billUrl,
    paymentDeadline: orderRow.payment_deadline,
    error: billRes.error,
  };
}

/**
 * Converts an accepted bargaining offer into a unified `checkout_sessions` +
 * child `orders` record (reusing the existing 30m hold without double-reservation)
 * and creates/reuses its single ToyyibPay Sandbox FPX bill (RM 1.00 FPX fee).
 */
export async function startOfferToyyibPayCheckoutAction(
  offerId: string
): Promise<UnifiedCheckoutActionResult> {
  const session = await getSessionSummary();
  const eligibility = evaluateBuyerEligibility(session);
  if (!eligibility.eligible || !eligibility.userId) {
    return { ok: false, error: eligibility.reason || "Sign in to pay." };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, error: "Database connection is not configured." };
  }

  const { data: checkoutRow, error: rpcErr } = await supabase.rpc(
    "create_offer_checkout_atomic",
    {
      p_offer_id: offerId,
      p_idempotency_key: `offer-${offerId}`,
    }
  );

  const firstSession = (
    Array.isArray(checkoutRow) ? checkoutRow[0] : checkoutRow
  ) as EnsureCheckoutSessionInput | undefined;

  if (rpcErr || !firstSession?.id) {
    return {
      ok: false,
      error: mapCheckoutRpcError(rpcErr?.message ?? "OFFER_HOLD_EXPIRED"),
    };
  }

  const typedSession = firstSession;
  const buyerName =
    session.profile?.display_name?.trim() ||
    session.profile?.full_name?.trim() ||
    session.email?.split("@")[0] ||
    "UMS Member";
  const buyerEmail = session.email || session.profile?.email || "";
  const origin = await resolveAppOrigin();

  const billRes = await ensureSandboxBillForCheckoutSession({
    session: typedSession,
    itemCount: 1,
    buyerName,
    buyerEmail,
    origin,
  });

  revalidatePath("/messages");
  revalidatePath("/orders");
  return {
    ok: billRes.ok,
    checkoutSessionId: typedSession.id,
    checkoutCode: typedSession.checkout_code,
    totalPaidSen: Number(typedSession.total_paid_sen),
    billCode: billRes.billCode,
    billUrl: billRes.billUrl,
    paymentDeadline: typedSession.payment_deadline,
    error: billRes.error,
  };
}
