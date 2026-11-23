import type { AuthSessionSummary } from "../../types/marketplace.ts";

export type SellerIneligibleReason =
  | "auth_required"
  | "unverified_email"
  | "inactive_account"
  | "staff_restricted"
  | "non_student_restricted";

export type SellerEligibilityResult =
  | { eligible: true }
  | {
      eligible: false;
      reason: SellerIneligibleReason;
      title: string;
      message: string;
    };

/**
 * Enforces Buy-U selling policy: ONLY active, email-verified UMS Students can sell.
 * Staff cannot sell. Administrator privileges do NOT grant automatic selling access.
 */
export function evaluateSellerEligibility(
  session: AuthSessionSummary
): SellerEligibilityResult {
  if (!session.isAuthenticated || !session.profile?.id) {
    return {
      eligible: false,
      reason: "auth_required",
      title: "Student Sign-In Required",
      message:
        "Sign in with your verified UMS student email (@iluv.ums.edu.my) to open a storefront or create listings.",
    };
  }

  if (!session.isEmailVerified) {
    return {
      eligible: false,
      reason: "unverified_email",
      title: "Verify Your UMS Email",
      message:
        "Please confirm your university email address via the verification link sent to your inbox before selling on Buy-U.",
    };
  }

  const role = (session.profile?.university_role ?? "").toLowerCase();
  const status = (session.profile?.status ?? "").toLowerCase();

  if (role === "staff") {
    return {
      eligible: false,
      reason: "staff_restricted",
      title: "Student-Only Selling Policy",
      message:
        "UMS Staff accounts can browse, purchase items, request student services, and pick up free items, but selling is reserved exclusively for verified UMS students.",
    };
  }

  if (role !== "student") {
    return {
      eligible: false,
      reason: "non_student_restricted",
      title: "Verified Student Account Required",
      message:
        "Only verified UMS student accounts can sell on Buy-U. Administrator or non-student accounts do not automatically grant selling access.",
    };
  }

  if (status !== "active") {
    return {
      eligible: false,
      reason: "inactive_account",
      title: "Active Student Status Required",
      message: `Your account status is currently "${status || "inactive"}". Only active student accounts can create or manage listings.`,
    };
  }

  return { eligible: true };
}

/**
 * Converts an RM string or number (e.g. "15.50") to exact integer sen (1550)
 * using string arithmetic to avoid floating-point drift.
 */
export function parseRmToSen(
  raw: string | number
): { ok: true; sen: number } | { ok: false; error: string } {
  const str = String(raw ?? "").trim().replace(/^RM\s*/i, "");
  if (!str) {
    return { ok: false, error: "Enter a price in RM (e.g. 15.00)." };
  }
  if (!/^\d+(\.\d{1,2})?$/.test(str)) {
    return {
      ok: false,
      error: "Price must be a valid non-negative RM amount with up to 2 decimals.",
    };
  }

  const [wholePart = "0", decPart = ""] = str.split(".");
  const whole = Number.parseInt(wholePart, 10);
  const cents = Number.parseInt(decPart.padEnd(2, "0"), 10);
  const sen = whole * 100 + cents;

  if (!Number.isSafeInteger(sen) || sen < 0) {
    return { ok: false, error: "Price must be a valid RM amount." };
  }
  if (sen > 5_000_000) {
    return {
      ok: false,
      error: "Price cannot exceed RM 50,000.00 on the campus marketplace.",
    };
  }

  return { ok: true, sen };
}

export interface StorefrontInput {
  shopName: string;
  description: string;
}

export function validateStorefrontInput(
  input: StorefrontInput
):
  | { ok: true; shopName: string; description: string }
  | { ok: false; error: string } {
  const shopName = input.shopName.trim();
  const description = input.description.trim();

  if (shopName.length < 2 || shopName.length > 60) {
    return {
      ok: false,
      error: "Storefront name must be between 2 and 60 characters.",
    };
  }
  if (description.length > 500) {
    return {
      ok: false,
      error: "Storefront description must be 500 characters or fewer.",
    };
  }

  return { ok: true, shopName, description };
}

export type SellListingKind = "preloved" | "business" | "food" | "service";
export type SellListingStatus = "draft" | "published";

export interface CreateListingInput {
  title: string;
  description: string;
  listingType: SellListingKind;
  categoryId: string;
  priceRm: string;
  quantity: string | number;
  collectionAreaId: string;
  condition: string;
  status: SellListingStatus;
  rulesAcknowledged: boolean;
  allowOffers?: boolean;
}

export interface ValidatedListingPayload {
  title: string;
  description: string;
  dbKind: "preloved" | "business" | "service";
  isFood: boolean;
  categoryId: string;
  priceSen: number;
  quantity: number;
  collectionAreaId: string | null;
  condition: string | null;
  status: SellListingStatus;
  rulesAcknowledged: boolean;
  allowOffers: boolean;
}

const VALID_KINDS = new Set<SellListingKind>([
  "preloved",
  "business",
  "food",
  "service",
]);

export function validateListingInput(
  input: CreateListingInput
): { ok: true; data: ValidatedListingPayload } | { ok: false; error: string } {
  const title = input.title.trim();
  const description = input.description.trim();
  const categoryId = input.categoryId.trim();
  const collectionAreaId = input.collectionAreaId.trim();
  const condition = input.condition.trim();
  const status: SellListingStatus =
    input.status === "published" ? "published" : "draft";

  if (!VALID_KINDS.has(input.listingType)) {
    return { ok: false, error: "Select a valid listing type." };
  }

  if (title.length < 3 || title.length > 120) {
    return {
      ok: false,
      error: "Listing title must be between 3 and 120 characters.",
    };
  }

  if (status === "published" && description.length < 10) {
    return {
      ok: false,
      error: "Add at least 10 characters of description before publishing.",
    };
  }
  if (description.length > 2000) {
    return {
      ok: false,
      error: "Description cannot exceed 2,000 characters.",
    };
  }

  if (!categoryId) {
    return { ok: false, error: "Select a campus category." };
  }

  const priceResult = parseRmToSen(input.priceRm);
  if (!priceResult.ok) {
    return { ok: false, error: priceResult.error };
  }
  if (status === "published" && priceResult.sen < 100) {
    return {
      ok: false,
      error:
        "Published listings must be at least RM 1.00. Use Free Items for giveaways.",
    };
  }

  const isService = input.listingType === "service";
  const parsedQty = Number.parseInt(String(input.quantity ?? "1"), 10);
  const quantity = isService ? 1 : parsedQty;
  if (!isService && (!Number.isInteger(quantity) || quantity < 1 || quantity > 999)) {
    return {
      ok: false,
      error: "Quantity must be a whole number between 1 and 999.",
    };
  }

  if (!isService && status === "published" && !collectionAreaId) {
    return {
      ok: false,
      error: "Select a campus collection area before publishing.",
    };
  }

  if (!isService && status === "published" && !condition) {
    return {
      ok: false,
      error: "Select an item condition before publishing.",
    };
  }

  if (status === "published" && !input.rulesAcknowledged) {
    return {
      ok: false,
      error:
        "Confirm the UMS campus marketplace listing rules before publishing.",
    };
  }

  const isFood = input.listingType === "food";
  const dbKind: "preloved" | "business" | "service" =
    input.listingType === "food" ? "business" : input.listingType;

  return {
    ok: true,
    data: {
      title,
      description,
      dbKind,
      isFood,
      categoryId,
      priceSen: priceResult.sen,
      quantity,
      collectionAreaId: collectionAreaId || null,
      condition: isService ? null : condition || null,
      status,
      rulesAcknowledged: Boolean(input.rulesAcknowledged),
      allowOffers: Boolean(input.allowOffers),
    },
  };
}

export interface MaskedPayoutStatus {
  configured: boolean;
  bankName: string | null;
  accountHolderName: string | null;
  maskedAccountNumber: string | null;
  hasDuitNow: boolean;
  updatedAt: string | null;
}

/**
 * Masks sensitive payout fields so raw bank account numbers and DuitNow IDs
 * are never exposed to the client or logs.
 */
export function maskPayoutAccount(
  raw: {
    bank_name?: string | null;
    account_number?: string | null;
    account_holder_name?: string | null;
    duitnow_id?: string | null;
    updated_at?: string | null;
  } | null
): MaskedPayoutStatus {
  if (!raw || (!raw.bank_name && !raw.account_number)) {
    return {
      configured: false,
      bankName: null,
      accountHolderName: null,
      maskedAccountNumber: null,
      hasDuitNow: false,
      updatedAt: null,
    };
  }

  const digits = (raw.account_number ?? "").replace(/\s+/g, "");
  const maskedAccountNumber =
    digits.length >= 4 ? `•••• ${digits.slice(-4)}` : digits ? "••••" : null;

  return {
    configured: Boolean(raw.bank_name && digits),
    bankName: raw.bank_name?.trim() || null,
    accountHolderName: raw.account_holder_name?.trim() || null,
    maskedAccountNumber,
    hasDuitNow: Boolean(raw.duitnow_id && raw.duitnow_id.trim().length > 0),
    updatedAt: raw.updated_at ?? null,
  };
}

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_LISTING_PHOTOS = 5;

export function validateImageFileMeta(file: {
  name: string;
  type: string;
  size: number;
}): { ok: true; ext: string } | { ok: false; error: string } {
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    return {
      ok: false,
      error: `"${file.name}" must be a JPG, PNG, or WebP image.`,
    };
  }
  if (file.size <= 0 || file.size > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      error: `"${file.name}" must be smaller than 5 MB.`,
    };
  }

  const ext =
    file.type === "image/png"
      ? "png"
      : file.type === "image/webp"
        ? "webp"
        : "jpg";
  return { ok: true, ext };
}
