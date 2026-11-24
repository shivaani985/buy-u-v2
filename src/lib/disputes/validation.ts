export type DisputeReasonCode =
  | "not_received"
  | "not_as_described"
  | "damaged"
  | "wrong_item"
  | "missing_item"
  | "other";

export type DisputeStatus = "open" | "under_review" | "resolved";

export type DisputeResolutionType =
  | "release_to_seller"
  | "full_refund"
  | "partial_refund";

export type RefundExecutionStatus =
  | "not_applicable"
  | "pending_execution"
  | "executed"
  | "failed";

export const DISPUTE_EVIDENCE_BUCKET = "dispute-evidence";
export const MAX_DISPUTE_EVIDENCE_FILES = 5;
export const MAX_DISPUTE_EVIDENCE_BYTES = 5 * 1024 * 1024;
export const COMPLETED_ORDER_DISPUTE_WINDOW_DAYS = 7;

export const ALLOWED_DISPUTE_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export const DISPUTE_REASONS: Array<{
  code: DisputeReasonCode;
  label: string;
}> = [
  { code: "not_received", label: "Item not received / seller no-show" },
  { code: "not_as_described", label: "Item not as described" },
  { code: "damaged", label: "Damaged or defective item" },
  { code: "wrong_item", label: "Wrong item received" },
  { code: "missing_item", label: "Missing item or quantity" },
  { code: "other", label: "Other order issue" },
];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: string): boolean {
  return UUID_RE.test((value ?? "").trim());
}

export function isValidDisputeReasonCode(
  code: string
): code is DisputeReasonCode {
  return DISPUTE_REASONS.some((r) => r.code === code);
}

export function validateDisputeEvidenceFileMeta(meta: {
  type: string;
  size: number;
}): { ok: boolean; error?: string; ext?: string } {
  const mime = (meta.type ?? "").toLowerCase();
  if (!ALLOWED_DISPUTE_IMAGE_MIMES.has(mime)) {
    return {
      ok: false,
      error: "Only JPG, PNG, and WebP images are supported as dispute evidence.",
    };
  }
  if (!Number.isFinite(meta.size) || meta.size <= 0) {
    return { ok: false, error: "Image file is empty." };
  }
  if (meta.size > MAX_DISPUTE_EVIDENCE_BYTES) {
    return {
      ok: false,
      error: "Each evidence image must be 5 MB or smaller.",
    };
  }
  const ext =
    mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  return { ok: true, ext };
}

export function isDisputeEvidencePathOwned(
  path: string,
  ownerUid: string,
  orderId: string
): boolean {
  const clean = (path ?? "").trim();
  if (!clean || clean.includes("..") || !isValidUuid(ownerUid) || !isValidUuid(orderId)) {
    return false;
  }
  const re = new RegExp(`^${ownerUid}/${orderId}/[A-Za-z0-9._-]+$`);
  return re.test(clean);
}

export function isDisputeEvidencePathAuthorized(
  path: string,
  orderId: string,
  participantIds: string[]
): boolean {
  return participantIds.some((uid) =>
    isDisputeEvidencePathOwned(path, uid, orderId)
  );
}

export function buildPrivateDisputeEvidenceUrl(
  orderId: string,
  path: string
): string {
  return `/api/disputes/evidence?orderId=${encodeURIComponent(
    orderId
  )}&path=${encodeURIComponent(path)}`;
}

export function evaluateBuyerDisputeEligibility(input: {
  status: string;
  paidAt: string | null;
  completedAt: string | null;
  hasActiveDispute: boolean;
  hasPendingRefundExecution?: boolean;
  nowMs?: number;
}): { eligible: boolean; reason?: string } {
  const s = (input.status ?? "").toLowerCase();
  if (input.hasActiveDispute || s === "disputed") {
    return { eligible: false, reason: "An active dispute is already open." };
  }
  if (input.hasPendingRefundExecution) {
    return {
      eligible: false,
      reason: "A refund decision is already pending execution for this order.",
    };
  }
  if (!input.paidAt) {
    return {
      eligible: false,
      reason: "Only verified paid orders can be disputed.",
    };
  }
  if (s === "paid" || s === "handed_over") {
    return { eligible: true };
  }
  if (s === "completed") {
    if (!input.completedAt) {
      return {
        eligible: false,
        reason: "Completed timestamp missing for protection window check.",
      };
    }
    const nowMs = input.nowMs ?? Date.now();
    const completedMs = Date.parse(input.completedAt);
    const windowMs = COMPLETED_ORDER_DISPUTE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    if (Number.isNaN(completedMs) || nowMs > completedMs + windowMs) {
      return {
        eligible: false,
        reason: `The ${COMPLETED_ORDER_DISPUTE_WINDOW_DAYS}-day post-completion buyer protection window has ended.`,
      };
    }
    return { eligible: true };
  }
  return {
    eligible: false,
    reason: "This order status is not eligible for a dispute.",
  };
}

export function getDisputeStatusBadge(status: string): {
  label: string;
  toneClass: string;
} {
  switch ((status ?? "").toLowerCase()) {
    case "open":
      return {
        label: "Open",
        toneClass: "bg-[#FEF2F2] text-[#B42318] border-[#F9C6C2]",
      };
    case "under_review":
      return {
        label: "Under Review",
        toneClass: "bg-[#F3EEFA] text-[#4E2A84] border-[#DCD0F0]",
      };
    case "resolved":
      return {
        label: "Resolved",
        toneClass: "bg-[#E6F6F6] text-[#006A6D] border-[#B8E3E4]",
      };
    default:
      return {
        label: status,
        toneClass: "bg-[#F6F5F9] text-[#6B6779] border-[#E6E3EE]",
      };
  }
}

export function getDisputeResolutionSummary(input: {
  resolutionType: string | null;
  refundAmountSen: number | null;
  refundExecutionStatus: string | null;
}): string | null {
  const rt = (input.resolutionType ?? "").toLowerCase();
  if (!rt) return null;
  const rm = `RM ${(Math.max(0, input.refundAmountSen ?? 0) / 100).toFixed(2)}`;
  const pendingSuffix =
    input.refundExecutionStatus === "pending_execution"
      ? " — Pending Refund Execution (Phase 6D.2)"
      : input.refundExecutionStatus === "executed"
        ? " — Refund Executed"
        : "";

  if (rt === "release_to_seller") {
    return "Released to Seller (order restored to pre-dispute stage)";
  }
  if (rt === "full_refund") {
    return `Full Refund Proposed (${rm})${pendingSuffix}`;
  }
  if (rt === "partial_refund") {
    return `Partial Refund Proposed (${rm})${pendingSuffix}`;
  }
  return rt;
}
