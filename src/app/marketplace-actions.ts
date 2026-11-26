"use server";

import { revalidatePath } from "next/cache";
import { evaluateBuyerEligibility } from "@/lib/buyer/validation";
import { isValidUuid } from "@/lib/disputes/validation";
import {
  REPORT_REASONS,
} from "@/lib/marketplace/phase8";
import {
  validateReviewSubmissionInput,
} from "@/lib/reviews/validation";
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
// Phase 8A (RETIRED in Phase 10S): Services are purchased directly via Cart & Checkout
// -----------------------------------------------------------------------------
export async function createServiceRequestAction(_input: {
  listingId: string;
  mode: string;
  requirements: string;
  preferredDate?: string;
}): Promise<MarketplaceActionResult> {
  void _input;
  return {
    ok: false,
    message:
      "Service requests have been retired. Add the service to your cart and complete checkout directly.",
  };
}

export async function updateServiceRequestAction(_input: {
  requestId: string;
  action: "accept" | "decline" | "start" | "deliver" | "complete" | "cancel";
  note?: string;
}): Promise<MarketplaceActionResult> {
  void _input;
  return {
    ok: false,
    message:
      "Legacy service requests are retired. Manage service orders in My Orders or Seller Orders.",
  };
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
  isAnonymous?: boolean;
  imagePaths?: string[] | null;
  videoPath?: string | null;
}): Promise<MarketplaceActionResult> {
  const session = await getSessionSummary();
  const elig = evaluateBuyerEligibility(session);
  if (!elig.eligible || !elig.userId) {
    return { ok: false, message: elig.reason || "Active member access required." };
  }
  const check = validateReviewSubmissionInput({
    rating: input.rating,
    comment: input.comment,
    imagePaths: input.imagePaths,
    videoPath: input.videoPath,
    ownerUserId: elig.userId,
  });
  if (!check.ok) return { ok: false, message: check.error };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, message: "Database unavailable." };

  const listingUuid = input.listingId && isValidUuid(input.listingId) ? input.listingId : null;
  const { error } = await supabase.rpc("submit_verified_review_atomic", {
    p_order_id: input.orderId && isValidUuid(input.orderId) ? input.orderId : null,
    p_listing_id: listingUuid,
    p_service_request_id:
      input.serviceRequestId && isValidUuid(input.serviceRequestId)
        ? input.serviceRequestId
        : null,
    p_rating: check.rating,
    p_comment: check.comment,
    p_is_anonymous: Boolean(input.isAnonymous),
    p_image_paths: check.imagePaths,
    p_video_path: check.videoPath,
  });

  if (error) {
    if (error.message.includes("duplicate key") || error.message.includes("unique")) {
      return { ok: false, message: "You have already submitted a verified review for this transaction." };
    }
    if (error.message.includes("NOT_ELIGIBLE")) {
      return { ok: false, message: "Only completed verified transactions can be reviewed." };
    }
    if (error.message.includes("REVIEW_MEDIA") || error.message.includes("TOO_MANY_REVIEW")) {
      return { ok: false, message: "One or more uploaded photos or videos could not be verified. Please re-upload." };
    }
    return { ok: false, message: "Could not submit review right now." };
  }

  revalidatePath("/");
  revalidatePath("/marketplace");
  revalidatePath("/services");
  revalidatePath("/favourites");
  if (listingUuid) revalidatePath(`/listings/${listingUuid}`);
  revalidatePath("/store/[sellerId]", "page");
  revalidatePath("/orders");
  revalidatePath("/orders/[orderId]", "page");
  revalidatePath("/seller/orders/[orderId]", "page");
  revalidatePath("/requests");
  revalidatePath("/seller/analytics");
  return { ok: true, message: "Verified review published. Thank you for helping the UMS community." };
}

export async function editVerifiedReviewAction(input: {
  reviewId: string;
  rating: number;
  comment: string;
  isAnonymous?: boolean;
  imagePaths?: string[] | null;
  videoPath?: string | null;
}): Promise<MarketplaceActionResult> {
  if (!isValidUuid(input.reviewId)) {
    return { ok: false, message: "Invalid review reference." };
  }
  const session = await getSessionSummary();
  const elig = evaluateBuyerEligibility(session);
  if (!elig.eligible || !elig.userId) {
    return { ok: false, message: elig.reason || "Active member access required." };
  }
  const check = validateReviewSubmissionInput({
    rating: input.rating,
    comment: input.comment,
    imagePaths: input.imagePaths,
    videoPath: input.videoPath,
    ownerUserId: elig.userId,
  });
  if (!check.ok) return { ok: false, message: check.error };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, message: "Database unavailable." };

  const service = getServerServiceClient();
  let listingIdForRevalidate: string | null = null;
  if (service) {
    const { data: prevRow } = await service
      .from("reviews")
      .select("listing_id")
      .eq("id", input.reviewId)
      .eq("buyer_id", elig.userId)
      .maybeSingle();
    listingIdForRevalidate = prevRow?.listing_id ?? null;
  }

  const { error } = await supabase.rpc("edit_verified_review_atomic", {
    p_review_id: input.reviewId,
    p_rating: check.rating,
    p_comment: check.comment,
    p_is_anonymous: input.isAnonymous,
    p_image_paths: input.imagePaths === undefined ? undefined : check.imagePaths,
    p_video_path: input.videoPath === undefined ? undefined : check.videoPath ?? "",
  });

  if (error) {
    if (error.message.includes("ORDER_NOT_ELIGIBLE_FOR_REVIEW") || error.message.includes("SERVICE_NOT_ELIGIBLE_FOR_REVIEW")) {
      return { ok: false, message: "This purchase is currently ineligible for review edits." };
    }
    if (error.message.includes("REVIEW_MODERATED") || error.message.includes("REVIEW_HIDDEN_LOCKED")) {
      return { ok: false, message: "Moderated reviews cannot be edited." };
    }
    if (error.message.includes("REVIEW_MEDIA") || error.message.includes("TOO_MANY_REVIEW")) {
      return { ok: false, message: "One or more attached photos or videos could not be verified." };
    }
    return { ok: false, message: "Could not update review right now." };
  }

  revalidatePath("/");
  revalidatePath("/marketplace");
  revalidatePath("/services");
  revalidatePath("/favourites");
  if (listingIdForRevalidate) revalidatePath(`/listings/${listingIdForRevalidate}`);
  revalidatePath("/store/[sellerId]", "page");
  revalidatePath("/orders");
  revalidatePath("/orders/[orderId]", "page");
  revalidatePath("/seller/orders/[orderId]", "page");
  revalidatePath("/requests");
  revalidatePath("/seller/analytics");
  return { ok: true, message: "Verified review updated." };
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
  revalidatePath("/orders/[orderId]", "page");
  revalidatePath("/seller/orders/[orderId]", "page");
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

/** Fill a missing matric number once, without making the profile ID editable. */
export async function completeMatricNumberAction(raw: string): Promise<MarketplaceActionResult> {
  const session = await getSessionSummary();
  const profile = session.profile;
  if (!evaluateSellerEligibility(session).eligible || !profile) {
    return { ok: false, message: "Verified student access is required." };
  }
  const matric = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (!/^[A-Z0-9-]{4,20}$/.test(matric)) {
    return { ok: false, message: "Enter a valid matric number (4–20 letters, numbers, or hyphens)." };
  }
  const service = getServerServiceClient();
  if (!service) return { ok: false, message: "Profile update is temporarily unavailable." };
  const { data, error } = await service.from("profiles").update({ matric_number: matric })
    .eq("id", profile.id).eq("status", "active").eq("university_role", "student")
    .is("matric_number", null).select("id").maybeSingle();
  if (error || !data) return { ok: false, message: "The matric number could not be added. Refresh your profile and try again." };
  revalidatePath("/account");
  revalidatePath("/free-items");
  return { ok: true, message: "Student profile saved." };
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

  // P0.13: Strictly update hosted column-level editable profile fields ONLY,
  // and persist notification_prefs through the dedicated validated RPC!
  const { error } = await supabase
    .from("profiles")
    .update({
      display_name: displayName,
      bio: input.bio.trim().slice(0, 400),
      faculty: input.faculty.trim().slice(0, 120) || null,
      phone: input.phone.trim().slice(0, 30) || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", uid);

  if (error) return { ok: false, message: "Could not update profile settings." };

  const { error: prefErr } = await supabase.rpc("update_notification_preferences_atomic", {
    p_inquiries: Boolean(input.notificationPrefs.inquiries),
    p_reviews: Boolean(input.notificationPrefs.reviews),
    p_community: Boolean(input.notificationPrefs.community),
  });
  if (prefErr && !/PGRST202|42883|update_notification_preferences_atomic/i.test(prefErr.message)) {
    return { ok: false, message: "Profile saved, but notification preferences could not be updated." };
  }

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
    if (error.message.includes("CANNOT_MODIFY_CLOSED_ACCOUNT")) {
      return { ok: false, message: "Permanently closed accounts cannot be suspended, restricted, or restored." };
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

export async function adminModerateFreeNoticeAction(input: {
  noticeId: string;
  hide: boolean;
  reason: string;
}): Promise<MarketplaceActionResult> {
  if (!isValidUuid(input.noticeId)) return { ok: false, message: "Invalid free item reference." };
  const session = await getSessionSummary();
  if (!session.isAuthenticated || !session.isActiveAdmin) {
    return { ok: false, message: "Active administrator access required." };
  }
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, message: "Database unavailable." };

  const { error } = await supabase.rpc("admin_moderate_free_notice_atomic", {
    p_notice_id: input.noticeId,
    p_hide: input.hide,
    p_reason: input.reason.trim(),
  });
  if (error) return { ok: false, message: "Could not moderate free item." };
  revalidatePath("/admin");
  revalidatePath("/free-items");
  revalidatePath("/");
  revalidatePath("/marketplace");
  return {
    ok: true,
    message: input.hide ? "Free item hidden and audited." : "Free item restored and audited.",
  };
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
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, message: "Database unavailable." };

  const { error } = await supabase.rpc("admin_toggle_catalog_item_atomic", {
    p_table: input.table,
    p_item_id: input.id,
    p_active: input.active,
    p_reason: `Admin ${input.active ? "activated" : "deactivated"} ${input.table} item ${input.id}`,
  });
  if (error) return { ok: false, message: "Could not update catalog visibility." };

  revalidatePath("/admin");
  revalidatePath("/free-items");
  revalidatePath("/marketplace");
  return { ok: true, message: `${input.id} ${input.active ? "activated" : "deactivated"}.` };
}
