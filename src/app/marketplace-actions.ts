"use server";

import { revalidatePath } from "next/cache";
import { evaluateBuyerEligibility } from "@/lib/buyer/validation";
import { isValidUuid } from "@/lib/disputes/validation";
import {
  REPORT_REASONS,
  validateFreeNoticeInput,
  validateReviewInput,
  validateServiceRequestInput,
} from "@/lib/marketplace/phase8";
import { evaluateSellerEligibility } from "@/lib/seller/validation";
import {
  createSupabaseServerClient,
  getSessionSummary,
} from "@/lib/supabase/server";
import { getServerServiceClient } from "@/lib/supabase/service";

export interface MarketplaceActionResult {
  ok: boolean;
  message: string;
  reference?: string;
}

// -----------------------------------------------------------------------------
// Phase 8F: Listing View Tracking (Server-Validated, Deduplicated Daily)
// -----------------------------------------------------------------------------
export async function recordListingViewAction(listingId: string): Promise<void> {
  if (!isValidUuid(listingId)) return;
  const supabase = await createSupabaseServerClient();
  if (!supabase) return;
  await supabase.rpc("record_listing_view_atomic", { p_listing_id: listingId });
}

// -----------------------------------------------------------------------------
// Phase 8A: Services Marketplace (Off-Platform Campus Agreement)
// -----------------------------------------------------------------------------
export async function createServiceRequestAction(input: {
  listingId: string;
  mode: string;
  requirements: string;
  preferredDate?: string;
}): Promise<MarketplaceActionResult> {
  if (!isValidUuid(input.listingId)) {
    return { ok: false, message: "Invalid service listing reference." };
  }
  const session = await getSessionSummary();
  const elig = evaluateBuyerEligibility(session);
  if (!elig.eligible) {
    return { ok: false, message: elig.reason || "Sign in with an active UMS account." };
  }
  const check = validateServiceRequestInput(input);
  if (!check.ok) return { ok: false, message: check.error };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, message: "Database unavailable." };

  const { data, error } = await supabase.rpc("create_service_request_atomic", {
    p_listing_id: input.listingId,
    p_mode: check.mode,
    p_requirements: check.requirements,
    p_preferred_date: check.preferredDate,
  });

  if (error) {
    if (error.message.includes("INTERACTION_BLOCKED")) {
      return { ok: false, message: "You cannot submit a request to this member." };
    }
    if (error.message.includes("DUPLICATE_ACTIVE_SERVICE_REQUEST")) {
      return { ok: false, message: "You already have an active request for this service." };
    }
    if (error.message.includes("CANNOT_REQUEST_OWN_SERVICE")) {
      return { ok: false, message: "You cannot request your own service." };
    }
    if (error.message.includes("SERVICE_PAUSED")) {
      return { ok: false, message: "This provider has paused new requests." };
    }
    return { ok: false, message: "Could not submit service request right now." };
  }

  const row = (Array.isArray(data) ? data[0] : data) as { out_request_code?: string } | undefined;
  revalidatePath("/services");
  revalidatePath("/requests");
  revalidatePath("/seller/services");
  return {
    ok: true,
    reference: row?.out_request_code,
    message: `Service request ${row?.out_request_code ?? ""} submitted. Track progress in My Requests.`,
  };
}

export async function updateServiceRequestAction(input: {
  requestId: string;
  action: "accept" | "decline" | "start" | "deliver" | "complete" | "cancel";
  note?: string;
}): Promise<MarketplaceActionResult> {
  if (!isValidUuid(input.requestId)) {
    return { ok: false, message: "Invalid service request reference." };
  }
  const session = await getSessionSummary();
  const elig = evaluateBuyerEligibility(session);
  if (!elig.eligible) {
    return { ok: false, message: elig.reason || "Active member access required." };
  }
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, message: "Database unavailable." };

  const { error } = await supabase.rpc("update_service_request_status_atomic", {
    p_request_id: input.requestId,
    p_action: input.action,
    p_note: input.note?.trim() || null,
  });

  if (error) {
    return { ok: false, message: "Could not update service request status." };
  }

  revalidatePath("/requests");
  revalidatePath("/seller/services");
  revalidatePath("/seller/analytics");
  return { ok: true, message: `Service request updated (${input.action}).` };
}

// -----------------------------------------------------------------------------
// Phase 8B: Free Items & Community Donations (free_notices + free_notice_claims)
// -----------------------------------------------------------------------------
export async function saveOrPublishFreeNoticeAction(input: {
  id?: string | null;
  title: string;
  description: string;
  condition: string;
  quantity: number;
  spotId: string;
  categoryId?: string | null;
  collectionInstructions?: string | null;
  imagePaths?: string[];
  mode: "draft" | "published";
}): Promise<MarketplaceActionResult> {
  const session = await getSessionSummary();
  const elig = evaluateSellerEligibility(session);
  const uid = session.profile?.id;
  if (!elig.eligible) {
    return {
      ok: false,
      message: elig.message || "Only active verified UMS students can publish free items.",
    };
  }
  if (!uid) {
    return { ok: false, message: "Account not found." };
  }

  const check = validateFreeNoticeInput({
    title: input.title,
    description: input.description,
    condition: input.condition,
    quantity: Number(input.quantity),
    spotId: input.spotId,
    categoryId: input.categoryId,
    collectionInstructions: input.collectionInstructions,
    imagePaths: input.imagePaths ?? [],
  });
  if (!check.ok) return { ok: false, message: check.error };

  const service = getServerServiceClient();
  if (!service) return { ok: false, message: "Database unavailable." };

  const nowIso = new Date().toISOString();
  const payload = {
    contributor_id: uid,
    title: input.title.trim(),
    description: input.description.trim(),
    condition: input.condition.trim(),
    quantity: Number(input.quantity),
    quantity_note: `${Number(input.quantity)} available`,
    spot_id: input.spotId,
    category_id: input.categoryId || null,
    collection_instructions: input.collectionInstructions?.trim() || null,
    image_paths: input.imagePaths ?? [],
    status: input.mode,
    published_at: input.mode === "published" ? nowIso : null,
    updated_at: nowIso,
  };

  if (input.id && isValidUuid(input.id)) {
    const { error } = await service
      .from("free_notices")
      .update(payload)
      .eq("id", input.id)
      .eq("contributor_id", uid);
    if (error) return { ok: false, message: "Could not update free item." };
  } else {
    const { error } = await service.from("free_notices").insert(payload);
    if (error) return { ok: false, message: "Could not save free item." };
  }

  revalidatePath("/free-items");
  return {
    ok: true,
    message:
      input.mode === "draft"
        ? "Free item draft saved persistently. You can resume it anytime."
        : "Free item published to the community board.",
  };
}

export async function createFreeClaimAction(input: {
  noticeId: string;
  quantity: number;
  note?: string;
}): Promise<MarketplaceActionResult> {
  if (!isValidUuid(input.noticeId)) {
    return { ok: false, message: "Invalid free item reference." };
  }
  const session = await getSessionSummary();
  const elig = evaluateBuyerEligibility(session);
  if (!elig.eligible) {
    return { ok: false, message: elig.reason || "Sign in with an active UMS account." };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, message: "Database unavailable." };

  const { data, error } = await supabase.rpc("create_free_notice_claim_atomic", {
    p_notice_id: input.noticeId,
    p_quantity: Math.max(1, Math.round(Number(input.quantity) || 1)),
    p_note: input.note?.trim() || null,
  });

  if (error) {
    if (error.message.includes("CANNOT_CLAIM_OWN_ITEM")) {
      return { ok: false, message: "You cannot claim your own donated item." };
    }
    if (error.message.includes("DUPLICATE_ACTIVE_CLAIM")) {
      return { ok: false, message: "You already have an active claim on this item." };
    }
    if (error.message.includes("INSUFFICIENT_FREE_QUANTITY")) {
      return { ok: false, message: "Requested quantity exceeds available units." };
    }
    if (error.message.includes("INTERACTION_BLOCKED")) {
      return { ok: false, message: "You cannot claim items from this member." };
    }
    return { ok: false, message: "Could not submit claim right now." };
  }

  const row = (Array.isArray(data) ? data[0] : data) as { out_claim_code?: string } | undefined;
  revalidatePath("/free-items");
  return {
    ok: true,
    reference: row?.out_claim_code,
    message: `Claim ${row?.out_claim_code ?? ""} submitted. Waiting for donor confirmation.`,
  };
}

export async function updateFreeClaimAction(input: {
  claimId: string;
  action: "accept" | "decline" | "handover" | "collect" | "cancel";
  reason?: string;
}): Promise<MarketplaceActionResult> {
  if (!isValidUuid(input.claimId)) {
    return { ok: false, message: "Invalid claim reference." };
  }
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, message: "Database unavailable." };

  const { error } = await supabase.rpc("update_free_notice_claim_atomic", {
    p_claim_id: input.claimId,
    p_action: input.action,
    p_reason: input.reason?.trim() || null,
  });

  if (error) {
    if (error.message.includes("INSUFFICIENT_FREE_QUANTITY")) {
      return { ok: false, message: "Not enough unreserved units left to accept this claim." };
    }
    return { ok: false, message: "Could not update free item claim." };
  }

  revalidatePath("/free-items");
  return { ok: true, message: `Claim updated (${input.action}).` };
}

// -----------------------------------------------------------------------------
// Phase 8D: Verified Reviews & Seller Responses
// -----------------------------------------------------------------------------
export async function submitVerifiedReviewAction(input: {
  orderId?: string | null;
  listingId?: string | null;
  serviceRequestId?: string | null;
  rating: number;
  comment: string;
}): Promise<MarketplaceActionResult> {
  const session = await getSessionSummary();
  const elig = evaluateBuyerEligibility(session);
  if (!elig.eligible) {
    return { ok: false, message: elig.reason || "Active member access required." };
  }
  const check = validateReviewInput({ rating: input.rating, comment: input.comment });
  if (!check.ok) return { ok: false, message: check.error };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, message: "Database unavailable." };

  const { error } = await supabase.rpc("submit_verified_review_atomic", {
    p_order_id: input.orderId && isValidUuid(input.orderId) ? input.orderId : null,
    p_listing_id: input.listingId && isValidUuid(input.listingId) ? input.listingId : null,
    p_service_request_id:
      input.serviceRequestId && isValidUuid(input.serviceRequestId)
        ? input.serviceRequestId
        : null,
    p_rating: check.rating,
    p_comment: check.comment,
  });

  if (error) {
    if (error.message.includes("duplicate key") || error.message.includes("unique")) {
      return { ok: false, message: "You have already submitted a verified review for this transaction." };
    }
    if (error.message.includes("NOT_ELIGIBLE")) {
      return { ok: false, message: "Only completed verified transactions can be reviewed." };
    }
    return { ok: false, message: "Could not submit review right now." };
  }

  revalidatePath("/orders");
  revalidatePath("/requests");
  revalidatePath("/seller/analytics");
  return { ok: true, message: "Verified review published. Thank you for helping the UMS community." };
}

export async function respondToReviewAction(input: {
  reviewId: string;
  response: string;
}): Promise<MarketplaceActionResult> {
  if (!isValidUuid(input.reviewId)) return { ok: false, message: "Invalid review reference." };
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, message: "Database unavailable." };

  const { error } = await supabase.rpc("respond_to_review_atomic", {
    p_review_id: input.reviewId,
    p_response: input.response.trim(),
  });
  if (error) return { ok: false, message: "Could not save response right now." };
  revalidatePath("/seller/analytics");
  return { ok: true, message: "Public seller response saved." };
}

// -----------------------------------------------------------------------------
// Phase 9B & 9C: Reports & User Blocking
// -----------------------------------------------------------------------------
export async function submitReportAction(input: {
  targetKind: "listing" | "user" | "review" | "message" | "free_notice";
  targetId: string;
  reason: string;
  explanation: string;
}): Promise<MarketplaceActionResult> {
  if (!isValidUuid(input.targetId)) return { ok: false, message: "Invalid report target." };
  if (!(REPORT_REASONS as readonly string[]).includes(input.reason)) {
    return { ok: false, message: "Select a valid report reason." };
  }
  const session = await getSessionSummary();
  const elig = evaluateBuyerEligibility(session);
  if (!elig.eligible) return { ok: false, message: elig.reason || "Sign in required." };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, message: "Database unavailable." };

  const { data, error } = await supabase.rpc("submit_report_atomic", {
    p_target_kind: input.targetKind,
    p_target_id: input.targetId,
    p_reason: input.reason,
    p_explanation: input.explanation.trim(),
  });

  if (error) {
    if (error.message.includes("duplicate") || error.message.includes("unique")) {
      return { ok: false, message: "You already have an open report for this item." };
    }
    return { ok: false, message: "Could not submit report right now." };
  }

  const row = (Array.isArray(data) ? data[0] : data) as { out_report_code?: string } | undefined;
  revalidatePath("/admin");
  return {
    ok: true,
    reference: row?.out_report_code,
    message: `Report ${row?.out_report_code ?? ""} received. Moderators will review privately.`,
  };
}

export async function toggleMemberBlockAction(input: {
  targetUserId: string;
  block: boolean;
}): Promise<MarketplaceActionResult> {
  if (!isValidUuid(input.targetUserId)) return { ok: false, message: "Invalid user reference." };
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, message: "Database unavailable." };

  const { error } = await supabase.rpc("toggle_member_block_atomic", {
    p_target_user_id: input.targetUserId,
    p_block: input.block,
  });
  if (error) {
    if (error.message.includes("CANNOT_BLOCK_SELF")) {
      return { ok: false, message: "You cannot block yourself." };
    }
    return { ok: false, message: "Could not update block status." };
  }
  revalidatePath("/account");
  return {
    ok: true,
    message: input.block
      ? "Member blocked. New messages, offers, and requests between you are prevented while existing orders remain intact."
      : "Member unblocked.",
  };
}

// -----------------------------------------------------------------------------
// Phase 9D & 9E: Notifications & Account Profile Settings
// -----------------------------------------------------------------------------
export async function markNotificationsReadAction(
  notificationId?: string | null
): Promise<MarketplaceActionResult> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, message: "Database unavailable." };

  const { error } = await supabase.rpc("mark_notifications_read_atomic", {
    p_notification_id:
      notificationId && isValidUuid(notificationId) ? notificationId : null,
  });
  if (error) return { ok: false, message: "Could not update notifications." };
  revalidatePath("/notifications");
  return { ok: true, message: "Notifications updated." };
}

export async function updateAccountProfileAction(input: {
  displayName: string;
  bio: string;
  faculty: string;
  phone: string;
  notificationPrefs: { inquiries: boolean; reviews: boolean; community: boolean };
}): Promise<MarketplaceActionResult> {
  const session = await getSessionSummary();
  const uid = session.profile?.id;
  if (!session.isAuthenticated || !uid) {
    return { ok: false, message: "Sign in required." };
  }

  const displayName = input.displayName.trim();
  if (displayName.length < 2 || displayName.length > 60) {
    return { ok: false, message: "Display name must be 2 to 60 characters." };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, message: "Database unavailable." };

  // Strictly update safe user-editable fields ONLY (never university_role, status, email, or admin flags!)
  const { error } = await supabase
    .from("profiles")
    .update({
      display_name: displayName,
      bio: input.bio.trim().slice(0, 400),
      faculty: input.faculty.trim().slice(0, 120) || null,
      phone: input.phone.trim().slice(0, 30) || null,
      notification_prefs: input.notificationPrefs,
      updated_at: new Date().toISOString(),
    })
    .eq("id", uid);

  if (error) return { ok: false, message: "Could not update profile settings." };
  revalidatePath("/account");
  return { ok: true, message: "Account settings saved." };
}

// -----------------------------------------------------------------------------
// Phase 9F: Admin Moderation & Catalog Management
// -----------------------------------------------------------------------------
export async function adminModerateReportAction(input: {
  reportId: string;
  status: "under_review" | "resolved" | "dismissed";
  outcome: string;
  reason: string;
}): Promise<MarketplaceActionResult> {
  if (!isValidUuid(input.reportId)) return { ok: false, message: "Invalid report reference." };
  const session = await getSessionSummary();
  if (!session.isAuthenticated || !session.isActiveAdmin) {
    return { ok: false, message: "Active administrator access required." };
  }
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, message: "Database unavailable." };

  const { error } = await supabase.rpc("admin_moderate_report_atomic", {
    p_report_id: input.reportId,
    p_status: input.status,
    p_outcome: input.outcome.trim(),
    p_reason: input.reason.trim(),
  });
  if (error) return { ok: false, message: "Could not update report." };
  revalidatePath("/admin");
  return { ok: true, message: `Report marked ${input.status.replace("_", " ")} and logged.` };
}

export async function adminModerateUserAction(input: {
  userId: string;
  action: "warn" | "restrict" | "suspend" | "restore";
  reason: string;
}): Promise<MarketplaceActionResult> {
  if (!isValidUuid(input.userId)) return { ok: false, message: "Invalid user reference." };
  const session = await getSessionSummary();
  if (!session.isAuthenticated || !session.isActiveAdmin) {
    return { ok: false, message: "Active administrator access required." };
  }
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, message: "Database unavailable." };

  const { error } = await supabase.rpc("admin_moderate_user_atomic", {
    p_target_user_id: input.userId,
    p_action: input.action,
    p_reason: input.reason.trim(),
  });
  if (error) {
    if (error.message.includes("MODERATION_REASON_REQUIRED")) {
      return { ok: false, message: "Enter a moderation reason (min 5 characters)." };
    }
    return { ok: false, message: "Could not apply user moderation action." };
  }
  revalidatePath("/admin");
  return { ok: true, message: `User moderation (${input.action}) applied and audited.` };
}

export async function adminModerateListingAction(input: {
  listingId: string;
  hide: boolean;
  reason: string;
}): Promise<MarketplaceActionResult> {
  if (!isValidUuid(input.listingId)) return { ok: false, message: "Invalid listing reference." };
  const session = await getSessionSummary();
  if (!session.isAuthenticated || !session.isActiveAdmin) {
    return { ok: false, message: "Active administrator access required." };
  }
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, message: "Database unavailable." };

  const { error } = await supabase.rpc("admin_moderate_listing_atomic", {
    p_listing_id: input.listingId,
    p_hide: input.hide,
    p_reason: input.reason.trim(),
  });
  if (error) return { ok: false, message: "Could not moderate listing." };
  revalidatePath("/admin");
  revalidatePath("/marketplace");
  revalidatePath("/services");
  return { ok: true, message: input.hide ? "Listing hidden and audited." : "Listing restored and audited." };
}

export async function adminModerateReviewAction(input: {
  reviewId: string;
  hide: boolean;
  reason: string;
}): Promise<MarketplaceActionResult> {
  if (!isValidUuid(input.reviewId)) return { ok: false, message: "Invalid review reference." };
  const session = await getSessionSummary();
  if (!session.isAuthenticated || !session.isActiveAdmin) {
    return { ok: false, message: "Active administrator access required." };
  }
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, message: "Database unavailable." };

  const { error } = await supabase.rpc("admin_moderate_review_atomic", {
    p_review_id: input.reviewId,
    p_hide: input.hide,
    p_reason: input.reason.trim(),
  });
  if (error) return { ok: false, message: "Could not moderate review." };
  revalidatePath("/admin");
  return { ok: true, message: input.hide ? "Review hidden and audited." : "Review restored and audited." };
}

export async function adminToggleSpotOrCategoryAction(input: {
  table: "categories" | "collection_areas" | "donation_spots";
  id: string;
  active: boolean;
}): Promise<MarketplaceActionResult> {
  const session = await getSessionSummary();
  const adminId = session.profile?.id;
  if (!session.isAuthenticated || !session.isActiveAdmin || !adminId) {
    return { ok: false, message: "Active administrator access required." };
  }
  const service = getServerServiceClient();
  if (!service) return { ok: false, message: "Database unavailable." };

  const { error } = await service
    .from(input.table)
    .update({ active: input.active })
    .eq("id", input.id);
  if (error) return { ok: false, message: "Could not update catalog visibility." };

  await service.from("admin_audit_logs").insert({
    admin_id: adminId,
    action: `${input.table}_${input.active ? "activated" : "deactivated"}`,
    target_kind: input.table,
    target_id: input.id,
    reason: "Admin catalog visibility toggle",
    details: { active: input.active },
  });

  revalidatePath("/admin");
  revalidatePath("/free-items");
  revalidatePath("/marketplace");
  return { ok: true, message: `${input.id} ${input.active ? "activated" : "deactivated"}.` };
}
