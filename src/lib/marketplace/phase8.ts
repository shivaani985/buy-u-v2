/**
 * Shared validation, lifecycle rules & aggregations for Phase 8:
 *   - 8A Services Marketplace (off-platform campus agreement)
 *   - 8B Free Items & Community Donations
 *   - 8D Verified Reviews & Ratings
 *   - 9B Reporting Reasons
 */

export const SERVICE_MODES = ["in_person", "remote", "both"] as const;
export type ServiceMode = (typeof SERVICE_MODES)[number];

/** Hosted service_requests.mode check constraint strictly permits 'remote' or 'in_person'. */
export const SERVICE_REQUEST_MODES = ["in_person", "remote"] as const;
export type ServiceRequestMode = (typeof SERVICE_REQUEST_MODES)[number];

export const SERVICE_REQUEST_STATUSES = [
  "requested",
  "accepted",
  "declined",
  "in_progress",
  "delivered",
  "completed",
  "cancelled",
  "expired",
] as const;
export type ServiceRequestStatus = (typeof SERVICE_REQUEST_STATUSES)[number];

export const FREE_NOTICE_STATUSES = ["active", "closed", "hidden"] as const;
export type FreeNoticeStatus = (typeof FREE_NOTICE_STATUSES)[number];

/** Exact hosted free_notices_condition_check vocabulary. */
export const FREE_NOTICE_CONDITIONS = [
  "New/Unused",
  "Like New",
  "Good",
  "Fair",
] as const;
export type FreeNoticeCondition = (typeof FREE_NOTICE_CONDITIONS)[number];

export const FREE_CLAIM_STATUSES = [
  "requested",
  "reserved",
  "handed_over",
  "collected",
  "declined",
  "cancelled",
  "expired",
] as const;
export type FreeClaimStatus = (typeof FREE_CLAIM_STATUSES)[number];

export const REPORT_REASONS = [
  "Misleading listing",
  "Prohibited item",
  "Scam or suspicious activity",
  "Harassment",
  "Inappropriate content",
  "Spam",
  "Impersonation",
  "Other policy violation",
] as const;

/**
 * Normalizes a preferred date/time input into an ISO-8601 UTC string for hosted
 * `service_requests.preferred_date timestamptz`. Naive datetime-local strings
 * (`YYYY-MM-DDTHH:mm`) are interpreted in Malaysian Time (+08:00).
 */
export function parsePreferredServiceTimestamp(
  raw?: string | null
): { ok: true; iso: string | null } | { ok: false; error: string } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: true, iso: null };

  let candidate = trimmed;
  if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
    candidate = `${candidate}T09:00:00+08:00`;
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(candidate)) {
    candidate = `${candidate}+08:00`;
  }

  const parsed = Date.parse(candidate);
  if (Number.isNaN(parsed)) {
    return {
      ok: false,
      error: "Preferred date/time must be a valid date and time.",
    };
  }
  return { ok: true, iso: new Date(parsed).toISOString() };
}

export function validateServiceRequestInput(input: {
  mode: string;
  requirements: string;
  preferredDate?: string | null;
  listingServiceMode?: string | null;
}):
  | { ok: true; mode: ServiceRequestMode; requirements: string; preferredDate: string | null }
  | { ok: false; error: string } {
  const mode = (input.mode ?? "").trim().toLowerCase() as ServiceRequestMode;
  if (!SERVICE_REQUEST_MODES.includes(mode)) {
    return { ok: false, error: "Select either In-Person or Remote delivery mode." };
  }
  const listingMode = (input.listingServiceMode ?? "").trim().toLowerCase();
  if (
    listingMode &&
    listingMode !== "both" &&
    (listingMode === "remote" || listingMode === "in_person") &&
    listingMode !== mode
  ) {
    return {
      ok: false,
      error: `This service only supports ${listingMode.replace("_", " ")} delivery.`,
    };
  }
  const req = (input.requirements ?? "").trim();
  if (req.length < 15 || req.length > 1500) {
    return { ok: false, error: "Service requirements must be 15 to 1,500 characters." };
  }
  const ts = parsePreferredServiceTimestamp(input.preferredDate);
  if (!ts.ok) return ts;
  return { ok: true, mode, requirements: req, preferredDate: ts.iso };
}

export function getAllowedServiceActions(
  status: string,
  role: "buyer" | "seller"
): Array<"accept" | "decline" | "start" | "deliver" | "complete" | "cancel"> {
  if (role === "seller") {
    if (status === "requested") return ["accept", "decline"];
    if (status === "accepted") return ["start", "deliver", "cancel"];
    if (status === "in_progress") return ["deliver", "cancel"];
    return [];
  }
  if (status === "requested" || status === "accepted" || status === "in_progress") {
    return ["cancel"];
  }
  if (status === "delivered") return ["complete"];
  return [];
}

export function validateFreeNoticeInput(input: {
  title: string;
  description: string;
  condition: string;
  quantity: number;
  spotId: string;
  categoryId?: string | null;
  collectionInstructions?: string | null;
  imagePaths: string[];
  mode?: "draft" | "published";
}): { ok: true } | { ok: false; error: string } {
  const title = (input.title ?? "").trim();
  const desc = (input.description ?? "").trim();
  const images = (input.imagePaths ?? []).filter((p) => Boolean(p && p.trim()));
  const mode = input.mode ?? "published";

  if (mode === "draft") {
    if (!title && !desc) {
      return { ok: false, error: "Enter at least a title or description to save a draft." };
    }
    if (title.length > 100) {
      return { ok: false, error: "Title cannot exceed 100 characters." };
    }
    if (desc.length > 2000) {
      return { ok: false, error: "Description cannot exceed 2,000 characters." };
    }
    if (images.length > 5) {
      return { ok: false, error: "Maximum 5 images allowed." };
    }
    if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 99) {
      return { ok: false, error: "Available quantity must be between 1 and 99." };
    }
    return { ok: true };
  }

  // Hosted free_notices constraints: title 5–100, description 10–2000, exact condition vocabulary, 1–5 distinct safe images
  if (title.length < 5 || title.length > 100) {
    return { ok: false, error: "Title must be 5 to 100 characters." };
  }
  if (desc.length < 10 || desc.length > 2000) {
    return { ok: false, error: "Description must be 10 to 2,000 characters." };
  }
  if (!(FREE_NOTICE_CONDITIONS as readonly string[]).includes(input.condition?.trim() ?? "")) {
    return {
      ok: false,
      error: "Select a valid condition (New/Unused, Like New, Good, or Fair).",
    };
  }
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 99) {
    return { ok: false, error: "Available quantity must be between 1 and 99." };
  }
  if (!input.spotId?.trim()) {
    return { ok: false, error: "Select an approved campus donation spot." };
  }
  if (images.length < 1 || images.length > 5) {
    return { ok: false, error: "Upload 1 to 5 photos before publishing a free item." };
  }
  const normalizedImages = images.map((p) => p.trim());
  if (new Set(normalizedImages).size !== normalizedImages.length) {
    return { ok: false, error: "Duplicate image paths are not allowed." };
  }
  for (const img of normalizedImages) {
    if (img.includes("..") || img.includes("\\") || img.startsWith("/")) {
      return { ok: false, error: "Invalid image storage path." };
    }
  }
  return { ok: true };
}

export function computeFreeAvailableQuantity(
  quantity: number,
  reservedQuantity: number
): number {
  return Math.max(0, Math.floor(quantity) - Math.floor(reservedQuantity));
}

export function getAllowedFreeClaimActions(
  status: string,
  role: "donor" | "recipient"
): Array<"accept" | "decline" | "handover" | "collect" | "cancel"> {
  if (role === "donor") {
    if (status === "requested") return ["accept", "decline"];
    if (status === "reserved") return ["handover", "cancel"];
    return [];
  }
  if (status === "requested" || status === "reserved") return ["cancel"];
  if (status === "handed_over") return ["collect"];
  return [];
}

export interface CommunityImpactSummary {
  publishedFreeItems: number;
  completedDonations: number;
  totalUnitsDonated: number;
  activeDonors: number;
  uniqueRecipients: number;
  topSpots: Array<{ spotId: string; count: number }>;
}

/**
 * Counts ONLY actually completed (`collected`) donation claims — never merely posted or requested items!
 */
export function computeCommunityImpact(input: {
  notices: Array<{ id: string; status: string; spot_id: string | null }>;
  claims: Array<{
    notice_id: string;
    donor_id: string;
    recipient_id: string;
    quantity: number;
    status: string;
  }>;
}): CommunityImpactSummary {
  const noticeSpot = new Map(input.notices.map((n) => [n.id, n.spot_id ?? "other"]));
  const publishedFreeItems = input.notices.filter(
    (n) => n.status === "active" || n.status === "closed"
  ).length;
  const completed = input.claims.filter((c) => c.status === "collected");
  const donors = new Set<string>();
  const recipients = new Set<string>();
  const spotCounts = new Map<string, number>();
  let totalUnitsDonated = 0;

  for (const c of completed) {
    donors.add(c.donor_id);
    recipients.add(c.recipient_id);
    totalUnitsDonated += Math.max(0, c.quantity);
    const sp = noticeSpot.get(c.notice_id) ?? "other";
    spotCounts.set(sp, (spotCounts.get(sp) ?? 0) + 1);
  }

  const topSpots = Array.from(spotCounts.entries())
    .map(([spotId, count]) => ({ spotId, count }))
    .sort((a, b) => b.count - a.count);

  return {
    publishedFreeItems,
    completedDonations: completed.length,
    totalUnitsDonated,
    activeDonors: donors.size,
    uniqueRecipients: recipients.size,
    topSpots,
  };
}

export interface RatingSummary {
  averageRating: number | null;
  totalReviews: number;
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
}

/**
 * Computes verified rating summary from visible (non-hidden) reviews.
 * NEVER returns 5.0 when 0 reviews exist (`averageRating` is `null`).
 */
export function computeRatingSummary(
  reviews: Array<{ rating: number; hidden?: boolean | null }>
): RatingSummary {
  const distribution: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0;
  let count = 0;
  for (const r of reviews) {
    if (r.hidden) continue;
    const star = Math.round(r.rating);
    if (star >= 1 && star <= 5) {
      distribution[star as 1 | 2 | 3 | 4 | 5] += 1;
      sum += star;
      count += 1;
    }
  }
  return {
    averageRating: count > 0 ? Number((sum / count).toFixed(2)) : null,
    totalReviews: count,
    distribution,
  };
}

export function validateReviewInput(input: {
  rating: number;
  comment: string;
}): { ok: true; rating: number; comment: string } | { ok: false; error: string } {
  const rating = Math.round(Number(input.rating));
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { ok: false, error: "Select a rating between 1 and 5 stars." };
  }
  const comment = (input.comment ?? "").trim();
  if (comment.length < 5 || comment.length > 1000) {
    return { ok: false, error: "Review comment must be 5 to 1,000 characters." };
  }
  return { ok: true, rating, comment };
}
