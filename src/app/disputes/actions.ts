"use server";

import { revalidatePath } from "next/cache";
import { evaluateBuyerEligibility } from "@/lib/buyer/validation";
import {
  isDisputeEvidencePathOwned,
  isValidDisputeReasonCode,
  isValidUuid,
  MAX_DISPUTE_EVIDENCE_FILES,
  type DisputeResolutionType,
} from "@/lib/disputes/validation";
import { evaluateSellerEligibility } from "@/lib/seller/validation";
import {
  createSupabaseServerClient,
  getSessionSummary,
} from "@/lib/supabase/server";

export interface OpenDisputeResult {
  ok: boolean;
  disputeCode?: string;
  message: string;
}

export interface SellerDisputeResponseResult {
  ok: boolean;
  message: string;
}

export interface AdminDisputeActionResult {
  ok: boolean;
  message: string;
}

function mapDisputeRpcError(message: string): string {
  if (message.includes("FORBIDDEN_BUYER_ONLY")) {
    return "Only the buyer of this order can open a dispute.";
  }
  if (message.includes("FORBIDDEN_SELLER_ONLY")) {
    return "Only the seller of this order can respond to this dispute.";
  }
  if (message.includes("FORBIDDEN_ADMIN_ONLY")) {
    return "Active administrator privileges are required.";
  }
  if (message.includes("DISPUTE_ALREADY_ACTIVE")) {
    return "An active dispute or pending refund is already open for this order.";
  }
  if (message.includes("ORDER_NOT_DISPUTABLE")) {
    return "This order is not eligible for a dispute.";
  }
  if (message.includes("PAYMENT_UNVERIFIED")) {
    return "Only verified paid orders can be disputed.";
  }
  if (message.includes("DISPUTE_WINDOW_EXPIRED")) {
    return "The 7-day post-completion buyer protection window has ended.";
  }
  if (message.includes("FUNDS_ALREADY_DISBURSED")) {
    return "Funds for this completed order have already been disbursed and cannot be automatically frozen.";
  }
  if (message.includes("INVALID_DISPUTE_DESCRIPTION")) {
    return "Please provide a detailed description (20 to 2,000 characters).";
  }
  if (message.includes("INVALID_SELLER_RESPONSE")) {
    return "Please provide a clear explanation (10 to 2,000 characters).";
  }
  if (message.includes("TOO_MANY_EVIDENCE_FILES")) {
    return "You can attach up to 5 supporting images.";
  }
  if (message.includes("EVIDENCE_OBJECT_NOT_FOUND")) {
    return "One or more evidence images were not found in private storage. Please re-upload.";
  }
  if (message.includes("ORDER_NOT_DISPUTED")) {
    return "This order is not currently in a disputed state.";
  }
  if (message.includes("ORDER_ALREADY_REFUNDED")) {
    return "No refundable balance remains on this order.";
  }
  if (message.includes("INVALID_EVIDENCE_PATH")) {
    return "One or more evidence files are invalid or unauthorized.";
  }
  if (message.includes("DISPUTE_ALREADY_RESOLVED")) {
    return "This dispute has already been resolved.";
  }
  if (message.includes("INVALID_PARTIAL_REFUND_AMOUNT")) {
    return "Partial refund must be greater than RM 0.00 and less than the order subtotal.";
  }
  return "Could not process this dispute action right now. Please try again.";
}

export async function openOrderDisputeAction(input: {
  orderId: string;
  reasonCode: string;
  description: string;
  evidencePaths: string[];
}): Promise<OpenDisputeResult> {
  if (!isValidUuid(input.orderId)) {
    return { ok: false, message: "Invalid order reference." };
  }
  if (!isValidDisputeReasonCode(input.reasonCode)) {
    return { ok: false, message: "Select a valid dispute reason." };
  }
  const desc = (input.description ?? "").trim();
  if (desc.length < 20 || desc.length > 2000) {
    return {
      ok: false,
      message: "Please describe the problem in 20 to 2,000 characters.",
    };
  }
  const paths = (input.evidencePaths ?? []).slice(0, MAX_DISPUTE_EVIDENCE_FILES);

  const session = await getSessionSummary();
  const eligibility = evaluateBuyerEligibility(session);
  if (!eligibility.eligible || !eligibility.userId) {
    return {
      ok: false,
      message: eligibility.reason || "Sign in with your UMS account first.",
    };
  }

  for (const p of paths) {
    if (!isDisputeEvidencePathOwned(p, eligibility.userId, input.orderId)) {
      return {
        ok: false,
        message: "One or more uploaded evidence paths are invalid.",
      };
    }
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Database connection unavailable." };
  }

  const { data, error } = await supabase.rpc("open_order_dispute_atomic", {
    p_order_id: input.orderId,
    p_reason_code: input.reasonCode,
    p_description: desc,
    p_evidence_paths: paths,
  });

  if (error) {
    return { ok: false, message: mapDisputeRpcError(error.message) };
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { dispute_code?: string }
    | undefined;

  revalidatePath("/orders");
  revalidatePath("/seller/orders");
  revalidatePath("/seller/disputes");
  revalidatePath("/seller");
  revalidatePath("/admin");

  return {
    ok: true,
    disputeCode: row?.dispute_code,
    message: `Dispute ${row?.dispute_code ?? ""} opened. Earnings for this order are frozen while Buy-U reviews your case.`,
  };
}

export async function submitSellerDisputeResponseAction(input: {
  disputeId: string;
  orderId: string;
  response: string;
  evidencePaths: string[];
}): Promise<SellerDisputeResponseResult> {
  if (!isValidUuid(input.disputeId) || !isValidUuid(input.orderId)) {
    return { ok: false, message: "Invalid dispute reference." };
  }
  const resp = (input.response ?? "").trim();
  if (resp.length < 10 || resp.length > 2000) {
    return {
      ok: false,
      message: "Please write an explanation between 10 and 2,000 characters.",
    };
  }
  const paths = (input.evidencePaths ?? []).slice(0, MAX_DISPUTE_EVIDENCE_FILES);

  const session = await getSessionSummary();
  const eligibility = evaluateSellerEligibility(session);
  const sellerId = session.profile?.id;
  if (!eligibility.eligible) {
    return {
      ok: false,
      message: eligibility.reason || "Seller verification required.",
    };
  }
  if (!sellerId) {
    return { ok: false, message: "Seller account not found." };
  }

  for (const p of paths) {
    if (!isDisputeEvidencePathOwned(p, sellerId, input.orderId)) {
      return {
        ok: false,
        message: "One or more uploaded evidence paths are invalid.",
      };
    }
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Database connection unavailable." };
  }

  const { error } = await supabase.rpc(
    "submit_seller_dispute_response_atomic",
    {
      p_dispute_id: input.disputeId,
      p_response: resp,
      p_evidence_paths: paths,
    }
  );

  if (error) {
    return { ok: false, message: mapDisputeRpcError(error.message) };
  }

  revalidatePath("/seller/disputes");
  revalidatePath("/orders");
  revalidatePath("/admin");

  return {
    ok: true,
    message: "Your explanation and supporting evidence have been submitted.",
  };
}

export async function adminMarkDisputeUnderReviewAction(input: {
  disputeId: string;
  adminNotes?: string;
}): Promise<AdminDisputeActionResult> {
  if (!isValidUuid(input.disputeId)) {
    return { ok: false, message: "Invalid dispute reference." };
  }
  const session = await getSessionSummary();
  if (!session.isAuthenticated || !session.isActiveAdmin) {
    return { ok: false, message: "Active administrator access required." };
  }
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Database connection unavailable." };
  }

  const { error } = await supabase.rpc(
    "admin_mark_dispute_under_review_atomic",
    {
      p_dispute_id: input.disputeId,
      p_admin_notes: input.adminNotes?.trim() ? input.adminNotes.trim() : null,
    }
  );

  if (error) {
    return { ok: false, message: mapDisputeRpcError(error.message) };
  }

  revalidatePath("/admin");
  revalidatePath("/orders");
  revalidatePath("/seller/disputes");

  return { ok: true, message: "Dispute moved to Under Review." };
}

export async function adminResolveDisputeAction(input: {
  disputeId: string;
  resolutionType: DisputeResolutionType;
  refundAmountSen?: number | null;
  adminNotes?: string;
}): Promise<AdminDisputeActionResult> {
  if (!isValidUuid(input.disputeId)) {
    return { ok: false, message: "Invalid dispute reference." };
  }
  const session = await getSessionSummary();
  if (!session.isAuthenticated || !session.isActiveAdmin) {
    return { ok: false, message: "Active administrator access required." };
  }
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Database connection unavailable." };
  }

  const { error } = await supabase.rpc("admin_resolve_order_dispute_atomic", {
    p_dispute_id: input.disputeId,
    p_resolution_type: input.resolutionType,
    p_refund_amount_sen:
      input.resolutionType === "partial_refund"
        ? (input.refundAmountSen ?? null)
        : null,
    p_admin_notes: input.adminNotes?.trim() ? input.adminNotes.trim() : null,
  });

  if (error) {
    return { ok: false, message: mapDisputeRpcError(error.message) };
  }

  revalidatePath("/admin");
  revalidatePath("/orders");
  revalidatePath("/seller/disputes");
  revalidatePath("/seller/orders");
  revalidatePath("/seller");

  const msg =
    input.resolutionType === "release_to_seller"
      ? "Resolved: Released to seller and order restored to its pre-dispute stage."
      : "Refund proposal recorded (Pending Execution in Phase 6D.2). Order earnings remain frozen.";

  return { ok: true, message: msg };
}
