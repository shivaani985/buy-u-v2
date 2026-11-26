export const REVIEW_STAR_COLOR = "#F4B400";

export const REVIEW_STAR_LABELS: Record<number, string> = {
  1: "Very Poor",
  2: "Poor",
  3: "Average",
  4: "Good",
  5: "Excellent",
};

export const REVIEW_MEDIA_BUCKET = "review-media";
export const MAX_REVIEW_PHOTOS = 5;
export const MAX_REVIEW_PHOTO_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_REVIEW_VIDEO_BYTES = 20 * 1024 * 1024; // 20 MB
export const MAX_REVIEW_VIDEO_SECONDS = 30;
export const MIN_REVIEW_COMMENT_LEN = 5;
export const MAX_REVIEW_COMMENT_LEN = 1000;

export type AllowedReviewImageMime = "image/jpeg" | "image/png" | "image/webp";
export type AllowedReviewVideoMime = "video/mp4" | "video/webm";
export type AllowedReviewMediaMime =
  | AllowedReviewImageMime
  | AllowedReviewVideoMime;

export const ALLOWED_REVIEW_IMAGE_MIMES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export const ALLOWED_REVIEW_VIDEO_MIMES = new Set<string>([
  "video/mp4",
  "video/webm",
]);

const MIME_TO_EXT: Record<AllowedReviewMediaMime, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getReviewStarLabel(rating: number): string {
  const star = Math.round(Number(rating));
  return REVIEW_STAR_LABELS[star] ?? "Select a rating";
}

export const ANONYMOUS_REVIEWER_NAME = "Anonymous Buyer";

export function extensionForReviewMediaMime(mime: AllowedReviewMediaMime): string {
  return MIME_TO_EXT[mime];
}

export function detectReviewMediaMagicMime(
  bytes: Uint8Array
): AllowedReviewMediaMime | null {
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

  // ISO BMFF / MP4: [4-byte box size] ftyp
  if (
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
    // Reject QuickTime-only / unrelated ISO brands when clearly non-MP4 if needed, accept standard MP4/M4V/ISO brands
    if (brand !== "qt  ") {
      return "video/mp4";
    }
    return "video/mp4";
  }

  // WebM / EBML: 1A 45 DF A3 ... containing "webm" DocType within EBML header
  if (
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    const headerSlice = bytes.subarray(0, Math.min(bytes.byteLength, 96));
    const headerAscii = Array.from(headerSlice, (b) =>
      b >= 32 && b <= 126 ? String.fromCharCode(b) : "."
    ).join("");
    if (headerAscii.includes("webm")) {
      return "video/webm";
    }
  }

  return null;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

function readUint64BE(bytes: Uint8Array, offset: number): number {
  const hi = readUint32BE(bytes, offset);
  const lo = readUint32BE(bytes, offset + 4);
  return hi * 4294967296 + lo;
}

/**
 * Inspects MP4 `moov/mvhd` container header in memory to verify duration <= max seconds.
 */
export function inspectMp4DurationSeconds(bytes: Uint8Array): {
  ok: boolean;
  durationSeconds?: number;
  error?: string;
} {
  let pos = 0;
  const len = bytes.byteLength;
  let movieDuration: number | undefined;

  while (pos + 8 <= len) {
    let boxSize = readUint32BE(bytes, pos);
    const boxType = String.fromCharCode(
      bytes[pos + 4]!,
      bytes[pos + 5]!,
      bytes[pos + 6]!,
      bytes[pos + 7]!
    );
    let headerLen = 8;
    if (boxSize === 1) {
      if (pos + 16 > len) break;
      boxSize = readUint64BE(bytes, pos + 8);
      headerLen = 16;
    } else if (boxSize === 0) {
      boxSize = len - pos;
    }
    if (boxSize < headerLen || pos + boxSize > len) break;

    if (boxType === "moof") {
      return { ok: false, error: "Fragmented MP4 is unsupported." };
    }
    if (boxType === "moov") {
      let inner = pos + headerLen;
      const moovEnd = pos + boxSize;
      while (inner + 8 <= moovEnd) {
        let childSize = readUint32BE(bytes, inner);
        const childType = String.fromCharCode(
          bytes[inner + 4]!,
          bytes[inner + 5]!,
          bytes[inner + 6]!,
          bytes[inner + 7]!
        );
        let childHdr = 8;
        if (childSize === 1) {
          if (inner + 16 > moovEnd) break;
          childSize = readUint64BE(bytes, inner + 8);
          childHdr = 16;
        } else if (childSize === 0) {
          childSize = moovEnd - inner;
        }
        if (childSize < childHdr || inner + childSize > moovEnd) break;

        if (childType === "mvhd") {
          const payload = inner + childHdr;
          const childEnd = inner + childSize;
          if (payload + 4 > childEnd) {
            return { ok: false, error: "Invalid MP4 movie header." };
          }
          const version = bytes[payload]!;
          let timescale = 0;
          let duration = 0;
          if (version === 0) {
            if (payload + 20 > childEnd) {
              return { ok: false, error: "Truncated MP4 v0 header." };
            }
            timescale = readUint32BE(bytes, payload + 12);
            duration = readUint32BE(bytes, payload + 16);
          } else if (version === 1) {
            if (payload + 32 > childEnd) {
              return { ok: false, error: "Truncated MP4 v1 header." };
            }
            timescale = readUint32BE(bytes, payload + 20);
            duration = readUint64BE(bytes, payload + 24);
          } else {
            return { ok: false, error: "Unsupported MP4 header version." };
          }

          if (!Number.isFinite(timescale) || timescale <= 0) {
            return { ok: false, error: "Missing MP4 timescale." };
          }
          if (!Number.isFinite(duration) || duration <= 0) {
            return {
              ok: false,
              error:
                "MP4 container did not declare a finite duration (streaming/fragmented MP4 cannot be duration-verified without ffprobe).",
            };
          }
          if (movieDuration !== undefined) {
            return { ok: false, error: "Duplicate MP4 movie header." };
          }
          movieDuration = duration / timescale;
        }
        inner += childSize;
      }
      if (inner !== moovEnd) return { ok: false, error: "Malformed MP4 movie box." };
    }
    pos += boxSize;
  }

  return pos === len && movieDuration !== undefined
    ? { ok: true, durationSeconds: movieDuration }
    : { ok: false, error: "MP4 metadata container (moov) could not be read." };
}

function readEbmlVint(
  bytes: Uint8Array,
  offset: number,
  keepMarker: boolean
): { value: number; length: number; unknown?: boolean } | null {
  if (offset >= bytes.byteLength) return null;
  const first = bytes[offset]!;
  if (first === 0) return null;
  let mask = 0x80;
  let length = 1;
  while (length <= 8 && (first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > (keepMarker ? 4 : 8) || offset + length > bytes.byteLength) return null;

  let value = keepMarker ? first : first & ~mask;
  let allOnes = (first & ~mask) === (mask - 1);
  for (let i = 1; i < length; i++) {
    const b = bytes[offset + i]!;
    value = value * 256 + b;
    if (b !== 0xff) allOnes = false;
  }
  const unknown = !keepMarker && allOnes;
  return unknown || Number.isSafeInteger(value) ? { value, length, unknown } : null;
}

/**
 * Inspects WebM EBML `Segment -> Info -> TimecodeScale + Duration`.
 */
export function inspectWebmDurationSeconds(bytes: Uint8Array): {
  ok: boolean;
  durationSeconds?: number;
  error?: string;
} {
  let pos = 0;
  const len = bytes.byteLength;
  let durationSeconds: number | undefined;
  let sawSegment = false;
  const invalid = { ok: false, error: "Malformed WebM duration metadata." };

  while (pos < len) {
    const id = readEbmlVint(bytes, pos, true);
    if (!id) return invalid;
    const size = readEbmlVint(bytes, pos + id.length, false);
    if (!size) return invalid;
    const dataStart = pos + id.length + size.length;
    const elemEnd = size.unknown ? len : dataStart + size.value;
    if (elemEnd > len || dataStart > elemEnd) return invalid;

    // Segment ID = 0x18538067
    if (id.value === 0x18538067) {
      if (sawSegment) return invalid;
      sawSegment = true;
      let child = dataStart;
      while (child < elemEnd) {
        const cid = readEbmlVint(bytes, child, true);
        if (!cid) return invalid;
        const csize = readEbmlVint(bytes, child + cid.length, false);
        if (!csize || csize.unknown) return invalid;
        const cStart = child + cid.length + csize.length;
        const cEnd = cStart + csize.value;
        if (cEnd > elemEnd) return invalid;

        // Segment Info = 0x1549A966
        if (cid.value === 0x1549a966) {
          if (durationSeconds !== undefined) return invalid;
          let timecodeScaleNs: number | undefined;
          let rawDuration: number | null = null;
          let infoPos = cStart;
          while (infoPos < cEnd) {
            const fid = readEbmlVint(bytes, infoPos, true);
            if (!fid) return invalid;
            const fsize = readEbmlVint(bytes, infoPos + fid.length, false);
            if (!fsize || fsize.unknown) return invalid;
            const fStart = infoPos + fid.length + fsize.length;
            const fEnd = fStart + fsize.value;
            if (fEnd > cEnd) return invalid;

            // TimecodeScale = 0x2AD7B1
            if (fid.value === 0x2ad7b1) {
              if (timecodeScaleNs !== undefined || fsize.value < 1 || fsize.value > 8) return invalid;
              let val = 0;
              for (let i = fStart; i < fEnd; i++) val = val * 256 + bytes[i]!;
              if (!Number.isSafeInteger(val) || val <= 0) return invalid;
              timecodeScaleNs = val;
            }
            // Duration = 0x4489 (IEEE 754 float32 or float64)
            if (fid.value === 0x4489) {
              if (rawDuration !== null || (fsize.value !== 4 && fsize.value !== 8)) return invalid;
              const dv = new DataView(
                bytes.buffer,
                bytes.byteOffset + fStart,
                fEnd - fStart
              );
              if (fEnd - fStart === 4) {
                rawDuration = dv.getFloat32(0, false);
              } else if (fEnd - fStart === 8) {
                rawDuration = dv.getFloat64(0, false);
              }
            }
            infoPos = fEnd;
          }
          if (rawDuration === null || !Number.isFinite(rawDuration) || rawDuration <= 0) {
            return {
              ok: false,
              error:
                "WebM video did not declare a container duration (live MediaRecorder WebMs without Duration metadata require client/re-muxed MP4/WebM).",
            };
          }
          durationSeconds = (rawDuration * (timecodeScaleNs ?? 1_000_000)) / 1e9;
        }
        child = cEnd;
      }
    } else if (size.unknown) return invalid;
    pos = elemEnd;
  }

  return durationSeconds !== undefined
    ? { ok: true, durationSeconds }
    : { ok: false, error: "WebM container metadata could not be read." };
}

export function validateReviewVideoDurationBuffer(
  bytes: Uint8Array,
  mime: AllowedReviewVideoMime
): { ok: boolean; durationSeconds?: number; error?: string } {
  const inspected =
    mime === "video/mp4"
      ? inspectMp4DurationSeconds(bytes)
      : inspectWebmDurationSeconds(bytes);

  if (!inspected.ok || !inspected.durationSeconds || !Number.isFinite(inspected.durationSeconds)) {
    return {
      ok: false,
      error: inspected.error ?? "Unable to verify video duration.",
    };
  }
  if (inspected.durationSeconds > MAX_REVIEW_VIDEO_SECONDS) {
    return {
      ok: false,
      durationSeconds: inspected.durationSeconds,
      error: `Video duration (${Math.ceil(inspected.durationSeconds)}s) exceeds the ${MAX_REVIEW_VIDEO_SECONDS}-second maximum.`,
    };
  }
  return { ok: true, durationSeconds: inspected.durationSeconds };
}

export function validateReviewImageMeta(meta: {
  type: string;
  size: number;
}): { ok: boolean; error?: string } {
  const mime = (meta.type ?? "").toLowerCase();
  if (!ALLOWED_REVIEW_IMAGE_MIMES.has(mime)) {
    return {
      ok: false,
      error: "Only JPG, JPEG, PNG, and WebP review photos are supported.",
    };
  }
  if (!Number.isFinite(meta.size) || meta.size <= 0) {
    return { ok: false, error: "Selected image file is empty." };
  }
  if (meta.size > MAX_REVIEW_PHOTO_BYTES) {
    return { ok: false, error: "Each review photo must be 5 MB or smaller." };
  }
  return { ok: true };
}

export function validateReviewVideoMeta(meta: {
  type: string;
  size: number;
  durationSeconds?: number | null;
}): { ok: boolean; error?: string } {
  const mime = (meta.type ?? "").toLowerCase();
  if (!ALLOWED_REVIEW_VIDEO_MIMES.has(mime)) {
    return {
      ok: false,
      error: "Only MP4 and WebM review videos are supported.",
    };
  }
  if (!Number.isFinite(meta.size) || meta.size <= 0) {
    return { ok: false, error: "Selected video file is empty." };
  }
  if (meta.size > MAX_REVIEW_VIDEO_BYTES) {
    return { ok: false, error: "Review video must be 20 MB or smaller." };
  }
  if (
    typeof meta.durationSeconds === "number" &&
    (!Number.isFinite(meta.durationSeconds) ||
      meta.durationSeconds <= 0 ||
      meta.durationSeconds > MAX_REVIEW_VIDEO_SECONDS)
  ) {
    return {
      ok: false,
      error: `Review video must be ${MAX_REVIEW_VIDEO_SECONDS} seconds or shorter.`,
    };
  }
  return { ok: true };
}

export function isValidStagedReviewMediaPath(path: string, userId: string): boolean {
  const clean = (path ?? "").trim();
  if (!clean || clean.includes("..") || !UUID_RE.test((userId ?? "").trim())) {
    return false;
  }
  return new RegExp(
    `^${userId}/staged/[A-Za-z0-9._-]+\\.(jpg|jpeg|png|webp|mp4|webm)$`,
    "i"
  ).test(clean);
}

export function isValidValidatedReviewImagePath(path: string, userId: string): boolean {
  const clean = (path ?? "").trim();
  if (!clean || clean.includes("..") || !UUID_RE.test((userId ?? "").trim())) {
    return false;
  }
  return new RegExp(
    `^${userId}/validated/[A-Za-z0-9._-]+\\.(jpg|png|webp)$`,
    "i"
  ).test(clean);
}

export function isValidValidatedReviewVideoPath(path: string, userId: string): boolean {
  const clean = (path ?? "").trim();
  if (!clean || clean.includes("..") || !UUID_RE.test((userId ?? "").trim())) {
    return false;
  }
  return new RegExp(
    `^${userId}/validated/[A-Za-z0-9._-]+\\.(mp4|webm)$`,
    "i"
  ).test(clean);
}

export function validateReviewSubmissionInput(input: {
  rating: number;
  comment: string;
  imagePaths?: string[] | null;
  videoPath?: string | null;
  ownerUserId?: string;
}):
  | {
      ok: true;
      rating: number;
      comment: string;
      imagePaths: string[];
      videoPath: string | null;
    }
  | { ok: false; error: string } {
  const rating = Math.round(Number(input.rating));
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { ok: false, error: "Select a rating between 1 and 5 stars." };
  }
  const comment = (input.comment ?? "").trim();
  if (
    comment.length < MIN_REVIEW_COMMENT_LEN ||
    comment.length > MAX_REVIEW_COMMENT_LEN
  ) {
    return {
      ok: false,
      error: `Review comment must be ${MIN_REVIEW_COMMENT_LEN} to ${MAX_REVIEW_COMMENT_LEN.toLocaleString()} characters.`,
    };
  }
  const rawImages = Array.isArray(input.imagePaths) ? input.imagePaths : [];
  const imagePaths = Array.from(
    new Set(rawImages.map((p) => String(p ?? "").trim()).filter(Boolean))
  );
  if (imagePaths.length > MAX_REVIEW_PHOTOS) {
    return {
      ok: false,
      error: `Upload at most ${MAX_REVIEW_PHOTOS} review photos.`,
    };
  }
  const videoPath = input.videoPath ? String(input.videoPath).trim() || null : null;

  if (input.ownerUserId) {
    for (const imgPath of imagePaths) {
      if (!isValidValidatedReviewImagePath(imgPath, input.ownerUserId)) {
        return { ok: false, error: "Invalid review photo attachment reference." };
      }
    }
    if (videoPath && !isValidValidatedReviewVideoPath(videoPath, input.ownerUserId)) {
      return { ok: false, error: "Invalid review video attachment reference." };
    }
  }

  return { ok: true, rating, comment, imagePaths, videoPath };
}
