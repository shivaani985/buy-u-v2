export const SERVICE_ATTACHMENTS_BUCKET = "service-order-attachments";
export const MAX_SERVICE_ATTACHMENTS = 5;
export const MAX_SERVICE_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_SERVICE_REQUIREMENTS_LEN = 1500;

export type AllowedServiceAttachmentMime =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "application/pdf";

export const ALLOWED_SERVICE_ATTACHMENT_MIMES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

const MIME_TO_EXT: Record<AllowedServiceAttachmentMime, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

const SAFE_EXT_RE = /\.(jpg|jpeg|png|webp|pdf)$/i;
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp|pdf)$/;

/**
 * Inspects actual file header magic bytes to determine the authoritative format.
 * Never trusts client-provided MIME type or filename extension alone.
 */
export function detectServiceAttachmentMagicMime(
  bytes: Uint8Array
): AllowedServiceAttachmentMime | null {
  if (!bytes || bytes.byteLength < 12) return null;

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  // WebP: RIFF....WEBP
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  // PDF: %PDF-
  if (
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return "application/pdf";
  }

  return null;
}

export function extensionForMime(mime: AllowedServiceAttachmentMime): string {
  return MIME_TO_EXT[mime];
}

export function sanitizeServiceBaseName(rawName: string): string {
  const withoutExt = rawName.replace(/\.[^.]+$/, "");
  const cleaned = withoutExt
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return cleaned || "attachment";
}

export function buildUniqueServiceFileName(
  rawName: string,
  ext: string,
  nonce: string
): string {
  const base = sanitizeServiceBaseName(rawName);
  const safeExt = ext.toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${Date.now()}-${nonce}-${base}.${safeExt}`;
}

export function buildStagedServiceAttachmentPath(
  buyerId: string,
  cartItemId: string,
  uniqueFileName: string
): string {
  return `${buyerId}/staged/${cartItemId}/${uniqueFileName}`;
}

export function buildValidatedServiceAttachmentPath(
  buyerId: string,
  cartItemId: string,
  uniqueFileName: string
): string {
  return `${buyerId}/validated/${cartItemId}/${uniqueFileName}`;
}

export function isValidStagedServicePath(
  path: string,
  buyerId: string,
  cartItemId: string
): boolean {
  if (!path || path.includes("..")) return false;
  const prefix = `${buyerId}/staged/${cartItemId}/`;
  if (!path.startsWith(prefix)) return false;
  const fileSegment = path.slice(prefix.length);
  return SAFE_SEGMENT_RE.test(fileSegment);
}

export function isValidValidatedServicePath(
  path: string,
  buyerId: string,
  cartItemId: string
): boolean {
  if (!path || path.includes("..")) return false;
  const prefix = `${buyerId}/validated/${cartItemId}/`;
  if (!path.startsWith(prefix)) return false;
  const fileSegment = path.slice(prefix.length);
  return SAFE_SEGMENT_RE.test(fileSegment);
}

export function isBuyerOwnedStagedServicePath(
  path: string,
  buyerId: string
): boolean {
  if (!path || path.includes("..")) return false;
  const parts = path.split("/");
  if (parts.length !== 4) return false;
  const [owner, stage, cartItemId, fileSegment] = parts;
  if (owner !== buyerId || stage !== "staged" || !cartItemId) return false;
  return Boolean(fileSegment && SAFE_SEGMENT_RE.test(fileSegment));
}

export function isBuyerOwnedServicePath(path: string, buyerId: string): boolean {
  if (!path || path.includes("..")) return false;
  const parts = path.split("/");
  if (parts.length !== 4) return false;
  const [owner, stage, , fileSegment] = parts;
  if (owner !== buyerId) return false;
  if (stage !== "staged" && stage !== "validated") return false;
  return Boolean(fileSegment && SAFE_SEGMENT_RE.test(fileSegment));
}

export function formatServiceModeLabel(mode?: string | null): string {
  const m = (mode ?? "").trim().toLowerCase();
  if (m === "remote") return "Remote";
  if (m === "both") return "In Person & Remote";
  return "In Person";
}

export function isImageAttachmentPath(path: string): boolean {
  return /\.(jpg|jpeg|png|webp)$/i.test(path);
}

export function extractAttachmentDisplayName(path: string): string {
  const seg = path.split("/").pop() ?? "attachment";
  // Strip leading `<timestamp>-<nonce>-` prefix if present
  return seg.replace(/^\d{10,}-[a-z0-9]{4,}-/i, "");
}

export function serviceAttachmentProxyUrl(
  orderId: string,
  itemId: string,
  path: string,
  download = false
): string {
  const base = `/api/orders/service-attachment?orderId=${encodeURIComponent(
    orderId
  )}&itemId=${encodeURIComponent(itemId)}&path=${encodeURIComponent(path)}`;
  return download ? `${base}&download=1` : base;
}

export function validateClientServiceFileSelection(file: {
  name: string;
  type: string;
  size: number;
}): { ok: true; ext: string } | { ok: false; error: string } {
  if (!file || file.size <= 0) {
    return { ok: false, error: "Selected file is empty." };
  }
  if (file.size > MAX_SERVICE_ATTACHMENT_BYTES) {
    return { ok: false, error: "Each attachment must be 5 MB or smaller." };
  }
  if (
    file.type &&
    !ALLOWED_SERVICE_ATTACHMENT_MIMES.has(file.type.toLowerCase())
  ) {
    return {
      ok: false,
      error: "Only JPG, PNG, WebP, and PDF files are allowed.",
    };
  }
  const match = file.name.match(SAFE_EXT_RE);
  if (!match) {
    return {
      ok: false,
      error: "File extension must be .jpg, .jpeg, .png, .webp, or .pdf.",
    };
  }
  return { ok: true, ext: match[1]!.toLowerCase() };
}
