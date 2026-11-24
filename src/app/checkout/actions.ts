"use server";

import { revalidatePath } from "next/cache";
import { getCartPageData } from "@/lib/buyer/cart-data";
import {
  buildCheckoutPreparation,
  type CheckoutPreparationSummary,
} from "@/lib/buyer/checkout";
import { evaluateBuyerEligibility } from "@/lib/buyer/validation";
import {
  summarizeMultiSellerBillBatch,
  type MultiSellerBillAttempt,
} from "@/lib/payments/toyyibpay";
import {
  ensureSandboxBillForOrder,
  resolveAppOrigin,
  type EnsureBillOrderInput,
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

export interface CreatedOrderBillView {
  orderId: string;
  orderCode: string;
  sellerId: string;
  sellerName: string;
  subtotalSen: number;
  fpxFeeSen: number;
  totalPaidSen: number;
  paymentDeadline: string | null;
  billCode: string | null;
  billUrl: string | null;
  error?: string;
}

export interface StartCartPaymentResult {
  ok: boolean;
  batchStatus?: "all_created" | "partial_failure" | "all_failed";
  orders?: CreatedOrderBillView[];
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
  if (rawMessage.includes("INSUFFICIENT_VARIANT_STOCK") || rawMessage.includes("INSUFFICIENT_LISTING_STOCK")) {
    return "One or more items no longer have enough available stock. Refresh checkout to review.";
  }
  if (rawMessage.includes("LISTING_UNAVAILABLE") || rawMessage.includes("VARIANT_UNAVAILABLE")) {
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
  if (rawMessage.includes("OFFER_HOLD_EXPIRED") || rawMessage.includes("OFFER_ORDER_ALREADY_TERMINAL")) {
    return "This offer's 30-minute reservation hold has expired or is already closed.";
  }
  if (rawMessage.includes("FOOD_PREORDER_NOT_ENABLED")) {
    return "Food pre-orders are not enabled for online checkout yet.";
  }
  return "Could not create your order right now. Please refresh and try again.";
}

/**
 * Strictly read-only server-side revalidation of authentication, buyer role,
 * listing availability, active variants, live stock, and current prices.
 */
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
 * Creates atomic per-seller cart orders via `create_cart_orders_atomic` and
 * generates a ToyyibPay Sandbox FPX bill for each seller order.
 * Safe against double-clicks and partial multi-seller bill failures.
 */
export async function startCartToyyibPayCheckoutAction(input: {
  idempotencyKey: string;
  priceSnapshots: Record<string, number>;
}): Promise<StartCartPaymentResult> {
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
    return { ok: false, error: "Invalid checkout session key. Please refresh and retry." };
  }

  // Verify live price snapshots before creating orders (unless idempotent retry after cart cleared)
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

  const { data: createdOrders, error: rpcErr } = await supabase.rpc(
    "create_cart_orders_atomic",
    { p_idempotency_key: key }
  );

  if (rpcErr || !Array.isArray(createdOrders) || createdOrders.length === 0) {
    return {
      ok: false,
      error: mapCheckoutRpcError(rpcErr?.message ?? "CART_EMPTY"),
    };
  }

  const typedOrders = createdOrders as Array<
    EnsureBillOrderInput & { seller_id: string }
  >;

  const sellerNameMap = new Map<string, string>();
  for (const group of preparation.sellerOrders) {
    sellerNameMap.set(group.sellerId, group.sellerName);
  }
  const missingSellerIds = typedOrders
    .map((o) => o.seller_id)
    .filter((id) => !sellerNameMap.has(id));
  if (missingSellerIds.length > 0) {
    const [profilesRes, storefrontsRes] = await Promise.all([
      supabase.from("public_profiles").select("id,display_name").in("id", missingSellerIds),
      supabase.from("storefronts").select("seller_id,shop_name").in("seller_id", missingSellerIds),
    ]);
    for (const p of (profilesRes.data ?? []) as Array<{ id: string; display_name: string | null }>) {
      if (p.display_name?.trim()) sellerNameMap.set(p.id, p.display_name.trim());
    }
    for (const s of (storefrontsRes.data ?? []) as Array<{ seller_id: string; shop_name: string | null }>) {
      if (s.shop_name?.trim()) sellerNameMap.set(s.seller_id, s.shop_name.trim());
    }
  }

  const { data: itemCountsRaw } = await supabase
    .from("order_items")
    .select("order_id, quantity")
    .in(
      "order_id",
      typedOrders.map((o) => o.id)
    );
  const itemCountByOrder = new Map<string, number>();
  for (const row of (itemCountsRaw ?? []) as Array<{ order_id: string; quantity: number }>) {
    itemCountByOrder.set(
      row.order_id,
      (itemCountByOrder.get(row.order_id) ?? 0) + Number(row.quantity ?? 1)
    );
  }

  const buyerName =
    session.profile?.display_name?.trim() ||
    session.profile?.full_name?.trim() ||
    session.email?.split("@")[0] ||
    "UMS Member";
  const buyerEmail = session.email || session.profile?.email || "";
  const origin = await resolveAppOrigin();

  const attempts: MultiSellerBillAttempt[] = [];
  const orderViews: CreatedOrderBillView[] = [];

  for (const order of typedOrders) {
    const billRes = await ensureSandboxBillForOrder({
      order,
      itemCount: itemCountByOrder.get(order.id) ?? 1,
      buyerName,
      buyerEmail,
      origin,
    });

    attempts.push({
      orderId: order.id,
      orderCode: order.order_code,
      billCode: billRes.billCode,
      billUrl: billRes.billUrl,
      error: billRes.error,
    });

    orderViews.push({
      orderId: order.id,
      orderCode: order.order_code,
      sellerId: order.seller_id,
      sellerName: sellerNameMap.get(order.seller_id) ?? "UMSKAL Seller",
      subtotalSen: Number(order.subtotal_sen),
      fpxFeeSen: Number(order.fpx_fee_sen),
      totalPaidSen: Number(order.total_paid_sen),
      paymentDeadline: order.payment_deadline,
      billCode: billRes.billCode,
      billUrl: billRes.billUrl,
      error: billRes.error,
    });
  }

  const summaryOutcome = summarizeMultiSellerBillBatch(attempts);
  revalidatePath("/cart");
  revalidatePath("/checkout");
  revalidatePath("/orders");

  return {
    ok: summaryOutcome.status !== "all_failed",
    batchStatus: summaryOutcome.status,
    orders: orderViews,
    error:
      summaryOutcome.status === "all_failed"
        ? orderViews[0]?.error || "Could not create ToyyibPay bill right now."
        : undefined,
  };
}

/**
 * Safely retries or resumes a ToyyibPay Sandbox bill for an existing buyer-owned
 * pending_payment order (reuses any live pending bill to prevent duplicates).
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
      "id, order_code, subtotal_sen, fpx_fee_sen, total_paid_sen, status, payment_deadline"
    )
    .eq("id", orderId)
    .eq("buyer_id", eligibility.userId)
    .maybeSingle();

  if (ordErr || !orderRow) {
    return { ok: false, error: "Order not found." };
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
 * Converts an accepted bargaining offer into an atomic order (reusing the
 * existing 30-minute hold without double-reservation) and creates/reuses its
 * ToyyibPay Sandbox FPX bill.
 */
export async function startOfferToyyibPayCheckoutAction(
  offerId: string
): Promise<SingleBillActionResult> {
  const session = await getSessionSummary();
  const eligibility = evaluateBuyerEligibility(session);
  if (!eligibility.eligible || !eligibility.userId) {
    return { ok: false, error: eligibility.reason || "Sign in to pay." };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, error: "Database connection is not configured." };
  }

  const { data: orderRow, error: rpcErr } = await supabase.rpc(
    "create_offer_order_atomic",
    {
      p_offer_id: offerId,
      p_idempotency_key: `offer-${offerId}`,
    }
  );

  if (rpcErr || !orderRow) {
    return {
      ok: false,
      error: mapCheckoutRpcError(rpcErr?.message ?? "OFFER_HOLD_EXPIRED"),
    };
  }

  const typedOrder = orderRow as EnsureBillOrderInput;
  const buyerName =
    session.profile?.display_name?.trim() ||
    session.profile?.full_name?.trim() ||
    session.email?.split("@")[0] ||
    "UMS Member";
  const buyerEmail = session.email || session.profile?.email || "";
  const origin = await resolveAppOrigin();

  const billRes = await ensureSandboxBillForOrder({
    order: typedOrder,
    itemCount: 1,
    buyerName,
    buyerEmail,
    origin,
  });

  revalidatePath("/messages");
  revalidatePath("/orders");
  return {
    ok: billRes.ok,
    orderId: billRes.orderId,
    orderCode: billRes.orderCode,
    billCode: billRes.billCode,
    billUrl: billRes.billUrl,
    paymentDeadline: typedOrder.payment_deadline,
    error: billRes.error,
  };
}
