"use server";

import { revalidatePath } from "next/cache";
import { evaluateBuyerEligibility } from "@/lib/buyer/validation";
import { isValidPickupPinFormat } from "@/lib/orders/lifecycle";
import { evaluateSellerEligibility } from "@/lib/seller/validation";
import {
  createSupabaseServerClient,
  getSessionSummary,
} from "@/lib/supabase/server";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface VerifyPickupPinResult {
  ok: boolean;
  outcome:
    | "handed_over"
    | "already_handed_over"
    | "already_completed"
    | "invalid_pin"
    | "invalid_pin_format"
    | "locked"
    | "invalid_status"
    | "order_disputed"
    | "payment_unverified"
    | "pin_unavailable"
    | "error";
  message: string;
  handedOverAt?: string | null;
  failedAttempts?: number;
  attemptsRemaining?: number;
  lockedUntil?: string | null;
}

export interface ConfirmReceiptResult {
  ok: boolean;
  outcome:
    | "completed"
    | "already_completed"
    | "invalid_status"
    | "order_disputed"
    | "payment_unverified"
    | "error";
  message: string;
  completedAt?: string | null;
}

function formatLockTimeMyt(iso: string | null | undefined): string {
  if (!iso) return "15 minutes";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "15 minutes";
  return new Intl.DateTimeFormat("en-MY", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kuala_Lumpur",
  }).format(d);
}

/**
 * Seller-only atomic Pickup PIN verification (`paid` -> `handed_over`).
 * Never logs or returns the buyer's PIN.
 */
export async function verifySellerPickupPinAction(
  orderId: string,
  pin: string
): Promise<VerifyPickupPinResult> {
  if (!UUID_RE.test(orderId)) {
    return { ok: false, outcome: "error", message: "Invalid order reference." };
  }

  const cleanPin = (pin ?? "").trim();
  if (!isValidPickupPinFormat(cleanPin)) {
    return {
      ok: false,
      outcome: "invalid_pin_format",
      message: "Enter the buyer's exact 6-digit numeric pickup PIN.",
    };
  }

  const session = await getSessionSummary();
  const eligibility = evaluateSellerEligibility(session);
  if (!eligibility.eligible) {
    return {
      ok: false,
      outcome: "error",
      message: eligibility.reason || "Seller verification required.",
    };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return {
      ok: false,
      outcome: "error",
      message: "Database connection unavailable right now.",
    };
  }

  const { data, error } = await supabase.rpc("verify_order_pickup_pin_atomic", {
    p_order_id: orderId,
    p_pin: cleanPin,
  });

  if (error) {
    if (error.code === "42501" || error.message.includes("FORBIDDEN")) {
      return {
        ok: false,
        outcome: "error",
        message: "Only the seller of this order can verify handover.",
      };
    }
    if (error.message.includes("ORDER_NOT_FOUND")) {
      return { ok: false, outcome: "error", message: "Order not found." };
    }
    return {
      ok: false,
      outcome: "error",
      message: "Could not verify pickup PIN right now. Please try again.",
    };
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        outcome: VerifyPickupPinResult["outcome"];
        handed_over_at: string | null;
        failed_attempts: number;
        attempts_remaining: number;
        locked_until: string | null;
      }
    | undefined;

  if (!row) {
    return {
      ok: false,
      outcome: "error",
      message: "Unexpected response while verifying PIN.",
    };
  }

  revalidatePath("/seller/orders");
  revalidatePath("/seller");
  revalidatePath("/orders");

  switch (row.outcome) {
    case "handed_over":
      return {
        ok: true,
        outcome: "handed_over",
        handedOverAt: row.handed_over_at,
        failedAttempts: 0,
        attemptsRemaining: 5,
        lockedUntil: null,
        message:
          "Handover verified! Waiting for the buyer to confirm receipt.",
      };
    case "already_handed_over":
      return {
        ok: true,
        outcome: "already_handed_over",
        handedOverAt: row.handed_over_at,
        message: "This order was already handed over.",
      };
    case "already_completed":
      return {
        ok: true,
        outcome: "already_completed",
        handedOverAt: row.handed_over_at,
        message: "This order is already completed.",
      };
    case "invalid_pin":
      return {
        ok: false,
        outcome: "invalid_pin",
        failedAttempts: row.failed_attempts,
        attemptsRemaining: row.attempts_remaining,
        lockedUntil: null,
        message: `Incorrect PIN. ${row.attempts_remaining} ${
          row.attempts_remaining === 1 ? "attempt" : "attempts"
        } remaining before a 15-minute lockout.`,
      };
    case "locked":
      return {
        ok: false,
        outcome: "locked",
        failedAttempts: row.failed_attempts,
        attemptsRemaining: 0,
        lockedUntil: row.locked_until,
        message: `Too many incorrect PIN attempts. Try again after ${formatLockTimeMyt(
          row.locked_until
        )} MYT.`,
      };
    case "order_disputed":
      return {
        ok: false,
        outcome: "order_disputed",
        message: "This order has an active dispute and cannot be handed over.",
      };
    case "payment_unverified":
      return {
        ok: false,
        outcome: "payment_unverified",
        message: "Payment for this order is not verified yet.",
      };
    case "invalid_status":
      return {
        ok: false,
        outcome: "invalid_status",
        message: "This order is not awaiting handover.",
      };
    case "pin_unavailable":
      return {
        ok: false,
        outcome: "pin_unavailable",
        message: "No active pickup PIN is available for this order.",
      };
    default:
      return {
        ok: false,
        outcome: "error",
        message: "Enter the buyer's exact 6-digit numeric pickup PIN.",
      };
  }
}

/**
 * Buyer-only atomic receipt confirmation (`handed_over` -> `completed`).
 */
export async function confirmOrderReceiptAction(
  orderId: string
): Promise<ConfirmReceiptResult> {
  if (!UUID_RE.test(orderId)) {
    return { ok: false, outcome: "error", message: "Invalid order reference." };
  }

  const session = await getSessionSummary();
  const eligibility = evaluateBuyerEligibility(session);
  if (!eligibility.eligible) {
    return {
      ok: false,
      outcome: "error",
      message: eligibility.reason || "Sign in with your UMS account first.",
    };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return {
      ok: false,
      outcome: "error",
      message: "Database connection unavailable right now.",
    };
  }

  const { data, error } = await supabase.rpc(
    "confirm_buyer_order_receipt_atomic",
    { p_order_id: orderId }
  );

  if (error) {
    if (error.code === "42501" || error.message.includes("FORBIDDEN")) {
      return {
        ok: false,
        outcome: "error",
        message: "Only the buyer of this order can confirm receipt.",
      };
    }
    if (error.message.includes("ORDER_NOT_FOUND")) {
      return { ok: false, outcome: "error", message: "Order not found." };
    }
    return {
      ok: false,
      outcome: "error",
      message: "Could not confirm receipt right now. Please try again.",
    };
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        outcome: ConfirmReceiptResult["outcome"];
        completed_at: string | null;
      }
    | undefined;

  if (!row) {
    return {
      ok: false,
      outcome: "error",
      message: "Unexpected response while confirming receipt.",
    };
  }

  revalidatePath("/orders");
  revalidatePath("/seller/orders");
  revalidatePath("/seller");

  switch (row.outcome) {
    case "completed":
      return {
        ok: true,
        outcome: "completed",
        completedAt: row.completed_at,
        message:
          "Receipt confirmed! Your order is now complete and the seller's earnings are available for payout.",
      };
    case "already_completed":
      return {
        ok: true,
        outcome: "already_completed",
        completedAt: row.completed_at,
        message: "This order was already confirmed as completed.",
      };
    case "order_disputed":
      return {
        ok: false,
        outcome: "order_disputed",
        message: "This order has an active dispute and cannot be completed.",
      };
    case "payment_unverified":
      return {
        ok: false,
        outcome: "payment_unverified",
        message: "Payment for this order could not be verified.",
      };
    case "invalid_status":
      return {
        ok: false,
        outcome: "invalid_status",
        message:
          "Receipt can only be confirmed after the seller verifies your pickup PIN.",
      };
    default:
      return {
        ok: false,
        outcome: "error",
        message: "Could not confirm receipt for this order.",
      };
  }
}
