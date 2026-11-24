"use server";

import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { evaluateBuyerEligibility } from "@/lib/buyer/validation";
import { isValidUuid } from "@/lib/disputes/validation";
import {
  encryptBankAccountNumber,
  validateBankAccountInput,
  type BankAccountFormInput,
} from "@/lib/financials/bank";
import { MIN_WITHDRAWAL_SEN } from "@/lib/financials/policy";
import {
  getBankPayoutProvider,
  getRefundExecutionProvider,
} from "@/lib/financials/providers";
import { evaluateSellerEligibility } from "@/lib/seller/validation";
import {
  createSupabaseServerClient,
  getSessionSummary,
} from "@/lib/supabase/server";
import { getServerServiceClient } from "@/lib/supabase/service";

export interface ActionFeedback {
  ok: boolean;
  message: string;
  reference?: string;
}

// -----------------------------------------------------------------------------
// Phase 6D.3: Seller Bank Account Management (Student-only, AES-256-GCM at rest)
// -----------------------------------------------------------------------------
export async function saveSellerBankAccountAction(
  input: BankAccountFormInput
): Promise<ActionFeedback> {
  const session = await getSessionSummary();
  const eligibility = evaluateSellerEligibility(session);
  const sellerId = session.profile?.id;
  if (!eligibility.eligible) {
    return {
      ok: false,
      message: eligibility.message || "Only active verified students can register bank details.",
    };
  }
  if (!sellerId) {
    return { ok: false, message: "Seller account not found." };
  }

  const check = validateBankAccountInput(input);
  if (!check.ok) {
    return { ok: false, message: check.error };
  }

  const service = getServerServiceClient();
  if (!service) {
    return { ok: false, message: "Database service unavailable." };
  }

  let encrypted: string;
  try {
    encrypted = encryptBankAccountNumber(check.accountNumber);
  } catch {
    return {
      ok: false,
      message: "Bank encryption service is not configured on the server.",
    };
  }

  const { error } = await service.rpc("upsert_seller_bank_account_secure", {
    p_seller_id: sellerId,
    p_bank_name: check.bankName,
    p_account_holder_name: check.accountHolderName,
    p_account_number_encrypted: encrypted,
    p_account_number_last4: check.last4,
    p_account_number_masked: check.masked,
  });

  if (error) {
    return {
      ok: false,
      message: "Could not save bank account details right now.",
    };
  }

  revalidatePath("/seller/bank");
  revalidatePath("/seller/withdrawals");
  revalidatePath("/seller");
  return {
    ok: true,
    message: `Bank account saved (${check.bankName} · ${check.masked}). Status: Account Details Validated.`,
  };
}

export async function deactivateSellerBankAccountAction(): Promise<ActionFeedback> {
  const session = await getSessionSummary();
  const eligibility = evaluateSellerEligibility(session);
  const sellerId = session.profile?.id;
  if (!eligibility.eligible || !sellerId) {
    return { ok: false, message: "Seller verification required." };
  }

  const service = getServerServiceClient();
  if (!service) {
    return { ok: false, message: "Database service unavailable." };
  }

  const { error } = await service.rpc("deactivate_seller_bank_account_secure", {
    p_seller_id: sellerId,
  });

  if (error) {
    if (error.message.includes("ACTIVE_WITHDRAWAL_IN_PROGRESS")) {
      return {
        ok: false,
        message: "Cannot deactivate bank account while a withdrawal is still processing.",
      };
    }
    return { ok: false, message: "Could not deactivate bank account." };
  }

  revalidatePath("/seller/bank");
  revalidatePath("/seller/withdrawals");
  return { ok: true, message: "Payout bank account deactivated." };
}

// -----------------------------------------------------------------------------
// Phase 6D.4: Automated Seller Withdrawals (NO manual admin approval!)
// -----------------------------------------------------------------------------
export async function requestSellerWithdrawalAction(input: {
  amountSen: number;
  idempotencyKey?: string;
}): Promise<ActionFeedback> {
  const session = await getSessionSummary();
  const eligibility = evaluateSellerEligibility(session);
  const sellerId = session.profile?.id;
  if (!eligibility.eligible) {
    return {
      ok: false,
      message: eligibility.message || "Only active verified students can withdraw earnings.",
    };
  }
  if (!sellerId) {
    return { ok: false, message: "Seller account not found." };
  }

  const amountSen = Math.round(Number(input.amountSen ?? 0));
  if (!Number.isSafeInteger(amountSen) || amountSen < MIN_WITHDRAWAL_SEN) {
    return {
      ok: false,
      message: `Minimum withdrawal is RM ${(MIN_WITHDRAWAL_SEN / 100).toFixed(2)}.`,
    };
  }

  const service = getServerServiceClient();
  if (!service) {
    return { ok: false, message: "Database service unavailable." };
  }

  const idempotencyKey =
    input.idempotencyKey?.trim() && input.idempotencyKey.trim().length >= 8
      ? input.idempotencyKey.trim()
      : `wdr-${sellerId}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

  const { data: claimRows, error: claimErr } = await service.rpc(
    "create_seller_withdrawal_atomic",
    {
      p_seller_id: sellerId,
      p_amount_sen: amountSen,
      p_idempotency_key: idempotencyKey,
    }
  );

  if (claimErr) {
    const msg = claimErr.message;
    if (msg.includes("NO_ACTIVE_BANK_ACCOUNT")) {
      return {
        ok: false,
        message: "Register a valid Malaysian payout bank account before withdrawing.",
      };
    }
    if (msg.includes("INSUFFICIENT_AVAILABLE_BALANCE")) {
      return {
        ok: false,
        message:
          "Requested amount exceeds your available balance (completed orders must pass the 72-hour buyer protection period).",
      };
    }
    if (msg.includes("BELOW_MINIMUM_WITHDRAWAL")) {
      return { ok: false, message: "Minimum withdrawal is RM 2.00." };
    }
    return {
      ok: false,
      message: "Could not reserve withdrawal balance right now.",
    };
  }

  const row = (Array.isArray(claimRows) ? claimRows[0] : claimRows) as
    | {
        action: string;
        withdrawal_id: string;
        withdrawal_code: string;
        amount_sen: number;
        attempt_token: string | null;
        masked_bank_summary: string;
      }
    | undefined;

  if (!row) {
    return { ok: false, message: "Unexpected withdrawal reservation response." };
  }

  if (row.action === "existing" || !row.attempt_token) {
    revalidatePath("/seller/withdrawals");
    revalidatePath("/seller");
    return {
      ok: true,
      reference: row.withdrawal_code,
      message: `Withdrawal ${row.withdrawal_code} already recorded.`,
    };
  }

  // Automatically process via replaceable server-only simulated bank provider
  let outcome: "paid" | "failed" | "reconciliation_required" = "failed";
  let transferRef: string | null = null;
  let failureReason: string | null = null;

  try {
    const provider = getBankPayoutProvider();
    const res = await provider.executeDisbursement({
      withdrawalCode: row.withdrawal_code,
      sellerId,
      amountSen: row.amount_sen,
      idempotencyKey,
      bankName: row.masked_bank_summary.split("·")[0]?.trim() || "Malaysian Bank",
      accountLast4: row.masked_bank_summary.match(/\*{4}(\d{4})/)?.[1] ?? "0000",
    });
    outcome = res.outcome;
    transferRef = res.transferRef ?? null;
    failureReason = res.failureReason ?? null;
  } catch (err) {
    outcome = "reconciliation_required";
    failureReason =
      err instanceof Error ? err.message : "Simulated bank provider error";
  }

  // Persist authoritative provider outcome BEFORE finalization so crashes/restarts recover safely (P0.5)
  await service.rpc("record_provider_attempt_outcome_atomic", {
    p_attempt_token: row.attempt_token,
    p_provider_outcome: outcome,
    p_simulation_ref: transferRef,
    p_reason: failureReason,
  });

  await service.rpc("finalize_seller_withdrawal_atomic", {
    p_withdrawal_id: row.withdrawal_id,
    p_attempt_token: row.attempt_token,
    p_outcome: outcome,
    p_transfer_ref: transferRef,
    p_failure_reason: failureReason,
  });

  revalidatePath("/seller/withdrawals");
  revalidatePath("/seller");
  revalidatePath("/admin");

  if (outcome === "paid") {
    return {
      ok: true,
      reference: transferRef ?? row.withdrawal_code,
      message: `Simulated bank transfer completed (${row.withdrawal_code} · Ref ${transferRef}). No real bank transfer occurred (FYP simulation).`,
    };
  }
  if (outcome === "reconciliation_required") {
    return {
      ok: false,
      reference: row.withdrawal_code,
      message: `Withdrawal ${row.withdrawal_code} is held for reconciliation due to an uncertain provider response.`,
    };
  }
  return {
    ok: false,
    reference: row.withdrawal_code,
    message: `Withdrawal ${row.withdrawal_code} failed (${failureReason}). Your reserved balance has been restored.`,
  };
}

// -----------------------------------------------------------------------------
// Phase 6D.2: Return & Refund Execution Actions
// -----------------------------------------------------------------------------
export async function buyerReportReturnAction(
  refundId: string
): Promise<ActionFeedback> {
  if (!isValidUuid(refundId)) {
    return { ok: false, message: "Invalid refund reference." };
  }
  const session = await getSessionSummary();
  const elig = evaluateBuyerEligibility(session);
  if (!elig.eligible) {
    return { ok: false, message: elig.reason || "Sign in required." };
  }
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, message: "Database unavailable." };

  const { error } = await supabase.rpc("buyer_report_return_atomic", {
    p_refund_id: refundId,
  });
  if (error) {
    return { ok: false, message: "Could not mark item returned right now." };
  }
  revalidatePath("/orders");
  revalidatePath("/seller/disputes");
  revalidatePath("/admin");
  return {
    ok: true,
    message: "Return reported. Waiting for seller or admin to confirm physical receipt.",
  };
}

export async function confirmReturnReceiptAction(input: {
  refundId: string;
  itemCondition: "resellable" | "damaged" | "missing";
  isAdminException?: boolean;
  exceptionReason?: string;
}): Promise<ActionFeedback> {
  if (!isValidUuid(input.refundId)) {
    return { ok: false, message: "Invalid refund reference." };
  }
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, message: "Database unavailable." };

  const { error } = await supabase.rpc("confirm_return_receipt_atomic", {
    p_refund_id: input.refundId,
    p_item_condition: input.itemCondition,
    p_is_admin_exception: Boolean(input.isAdminException),
    p_exception_reason: input.exceptionReason?.trim() || null,
  });
  if (error) {
    if (error.message.includes("ADMIN_EXCEPTION_REASON_REQUIRED")) {
      return {
        ok: false,
        message: "Admin return exceptions require a written justification (min 10 characters).",
      };
    }
    if (error.message.includes("MISSING_ITEM_REQUIRES_ADMIN_EXCEPTION")) {
      return {
        ok: false,
        message: "Missing items cannot be marked returned; record an admin return exception instead.",
      };
    }
    return { ok: false, message: "Could not confirm return receipt." };
  }
  revalidatePath("/orders");
  revalidatePath("/seller/disputes");
  revalidatePath("/admin");
  return {
    ok: true,
    message: input.isAdminException
      ? "Admin return exception recorded. Refund is now eligible for review."
      : "Physical return confirmed. Refund is now eligible for execution.",
  };
}

export async function adminConfigureRefundReturnAction(input: {
  refundId: string;
  returnRequired: boolean;
  returnInstructions?: string;
}): Promise<ActionFeedback> {
  if (!isValidUuid(input.refundId)) {
    return { ok: false, message: "Invalid refund reference." };
  }
  const session = await getSessionSummary();
  if (!session.isAuthenticated || !session.isActiveAdmin) {
    return { ok: false, message: "Active administrator access required." };
  }
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, message: "Database unavailable." };

  const { error } = await supabase.rpc("admin_configure_refund_return_atomic", {
    p_refund_id: input.refundId,
    p_return_required: input.returnRequired,
    p_return_instructions: input.returnInstructions?.trim() || null,
  });
  if (error) {
    return { ok: false, message: "Could not update return requirement." };
  }
  revalidatePath("/admin");
  revalidatePath("/orders");
  revalidatePath("/seller/disputes");
  return {
    ok: true,
    message: input.returnRequired
      ? "Return required enabled. Refund execution is paused until return is confirmed."
      : "Return requirement cleared. Refund is ready for execution.",
  };
}

export async function adminApproveRefundRestockAction(input: {
  refundId: string;
  approve: boolean;
  items?: Array<{ order_item_id: string; quantity: number }>;
}): Promise<ActionFeedback> {
  if (!isValidUuid(input.refundId)) {
    return { ok: false, message: "Invalid refund reference." };
  }
  const session = await getSessionSummary();
  if (!session.isAuthenticated || !session.isActiveAdmin) {
    return { ok: false, message: "Active administrator access required." };
  }
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, message: "Database unavailable." };

  const { data, error } = await supabase.rpc(
    "admin_approve_refund_restock_atomic",
    {
      p_refund_id: input.refundId,
      p_approve: input.approve,
      p_items: input.items ?? null,
    }
  );
  if (error) {
    if (error.message.includes("RESTOCK_REQUIRES_RESELLABLE_RETURN")) {
      return {
        ok: false,
        message:
          "Handed-over items require confirmed physical return in resellable condition before restocking.",
      };
    }
    if (error.message.includes("FOOD_OR_SERVICE_NOT_RESTOCKABLE")) {
      return {
        ok: false,
        message: "Food and service listings cannot be restocked.",
      };
    }
    if (error.message.includes("RESTOCK_UNSUITABLE_CONDITION")) {
      return {
        ok: false,
        message: "Damaged or missing items cannot be restocked.",
      };
    }
    return { ok: false, message: "Could not process restock decision." };
  }
  revalidatePath("/admin");
  return {
    ok: true,
    message:
      data === "approved_restocked"
        ? "Stock restored safely (logged immutably)."
        : data === "approved_pending_refund"
          ? "Restock plan approved; inventory will update atomically when refund succeeds."
          : data === "inventory_exception"
            ? "Inventory exception logged (listing/variant ineligible or missing)."
            : "Restock declined.",
  };
}

export async function adminExecuteRefundAction(
  refundId: string
): Promise<ActionFeedback> {
  if (!isValidUuid(refundId)) {
    return { ok: false, message: "Invalid refund reference." };
  }
  const session = await getSessionSummary();
  const adminId = session.profile?.id;
  if (!session.isAuthenticated || !session.isActiveAdmin || !adminId) {
    return { ok: false, message: "Active administrator access required." };
  }
  const service = getServerServiceClient();
  if (!service) return { ok: false, message: "Database service unavailable." };

  const { data: claimRows, error: claimErr } = await service.rpc(
    "claim_order_refund_execution_atomic",
    { p_refund_id: refundId, p_admin_id: adminId }
  );

  if (claimErr) {
    if (claimErr.message.includes("RETURN_CONFIRMATION_REQUIRED")) {
      return {
        ok: false,
        message: "Physical return must be confirmed before executing this refund.",
      };
    }
    if (claimErr.message.includes("ORDER_ALREADY_REFUNDED")) {
      return { ok: false, message: "This order already has a completed refund." };
    }
    return { ok: false, message: "Could not claim refund execution." };
  }

  const row = (Array.isArray(claimRows) ? claimRows[0] : claimRows) as
    | {
        action: string;
        attempt_token: string | null;
        logical_tx_id: string;
        refund_code: string;
        refund_amount: number;
        refund_type: string;
        order_id: string;
      }
    | undefined;

  if (!row) return { ok: false, message: "Unexpected refund claim response." };
  if (row.action === "already_succeeded") {
    return { ok: true, message: `Refund ${row.refund_code} was already finalized.` };
  }
  if (row.action !== "claimed" || !row.attempt_token) {
    return {
      ok: false,
      message: `Refund ${row.refund_code} cannot be executed right now (${row.action}).`,
    };
  }

  let outcome: "succeeded" | "failed" | "reconciliation_required" = "failed";
  let refundRef: string | null = null;
  let failureReason: string | null = null;

  try {
    const provider = getRefundExecutionProvider();
    const res = await provider.executeRefund({
      refundCode: row.refund_code,
      orderId: row.order_id,
      amountSen: row.refund_amount,
      idempotencyKey: row.logical_tx_id || `rfd-${refundId}`,
    });
    outcome = res.outcome;
    refundRef = res.refundRef ?? null;
    failureReason = res.failureReason ?? null;
  } catch (err) {
    outcome = "reconciliation_required";
    failureReason = err instanceof Error ? err.message : "Provider error";
  }

  // Persist authoritative provider outcome BEFORE finalization (P0.5)
  await service.rpc("record_provider_attempt_outcome_atomic", {
    p_attempt_token: row.attempt_token,
    p_provider_outcome: outcome,
    p_simulation_ref: refundRef,
    p_reason: failureReason,
  });

  await service.rpc("finalize_order_refund_atomic", {
    p_refund_id: refundId,
    p_attempt_token: row.attempt_token,
    p_outcome: outcome,
    p_refund_ref: refundRef,
    p_failure_reason: failureReason,
  });

  revalidatePath("/admin");
  revalidatePath("/orders");
  revalidatePath("/seller/disputes");
  revalidatePath("/seller/orders");
  revalidatePath("/seller");

  if (outcome === "succeeded") {
    return {
      ok: true,
      reference: refundRef ?? row.refund_code,
      message: `Simulated refund finalized (${row.refund_code} · Ref ${refundRef}). Financial ledger and order status updated atomically.`,
    };
  }
  return {
    ok: false,
    message: `Refund execution did not succeed (${outcome}: ${failureReason}). Order earnings remain frozen.`,
  };
}

/**
 * Evidence-based durable recovery check (P0.4 / P0.5).
 * NEVER releases reserved/frozen funds on admin note or elapsed time alone;
 * only finalizes from trusted persisted provider evidence.
 */
export async function adminRunSafeRecoveryAction(input: {
  entityType: "withdrawal" | "refund";
  entityId: string;
}): Promise<ActionFeedback> {
  if (!isValidUuid(input.entityId)) {
    return { ok: false, message: "Invalid financial reference." };
  }
  const session = await getSessionSummary();
  const adminId = session.profile?.id;
  if (!session.isAuthenticated || !session.isActiveAdmin || !adminId) {
    return { ok: false, message: "Active administrator access required." };
  }
  const service = getServerServiceClient();
  if (!service) return { ok: false, message: "Database service unavailable." };

  const { data, error } = await service.rpc("recover_financial_execution_atomic", {
    p_entity_type: input.entityType,
    p_entity_id: input.entityId,
    p_admin_id: adminId,
  });

  if (error) {
    return {
      ok: false,
      message: "Could not run safe recovery check right now.",
    };
  }

  revalidatePath("/admin");
  revalidatePath("/seller/withdrawals");
  revalidatePath("/seller");
  revalidatePath("/orders");

  if (data === "paid" || data === "succeeded") {
    return {
      ok: true,
      message: `Recovered from persisted provider evidence: finalized as ${data}.`,
    };
  }
  if (data === "failed") {
    return {
      ok: true,
      message:
        "Recovered from verified provider failure: marked failed and released reserved allocations once.",
    };
  }
  if (data === "held_uncertain") {
    return {
      ok: false,
      message:
        "Provider outcome remains uncertain (no definitive persisted failure or success). Funds remain safely reserved.",
    };
  }
  return {
    ok: true,
    message: `Recovery check result: ${String(data)}.`,
  };
}
