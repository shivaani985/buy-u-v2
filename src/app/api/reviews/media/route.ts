import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { evaluateBuyerEligibility, isValidUuid } from "@/lib/buyer/validation";
import {
  detectReviewMediaMagicMime,
  extensionForReviewMediaMime,
  isValidStagedReviewMediaPath,
  isValidValidatedReviewImagePath,
  isValidValidatedReviewVideoPath,
  MAX_REVIEW_PHOTO_BYTES,
  MAX_REVIEW_VIDEO_BYTES,
  REVIEW_MEDIA_BUCKET,
  validateReviewVideoDurationBuffer,
} from "@/lib/reviews/validation";
import { getSessionSummary } from "@/lib/supabase/server";
import { getServerServiceClient } from "@/lib/supabase/service";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

function sanitizeStem(rawName: string): string {
  const stem = rawName
    .replace(/\.[^.]+$/, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 36);
  return stem || "review-media";
}

/**
 * Serves verified review media (`reviewId` + `kind` + `index`) without leaking
 * buyer storage prefixes/IDs in public URLs, enforcing moderation visibility (`hidden`).
 * Also serves owner-only preview for newly uploaded validated files via `previewPath`.
 */
export async function GET(request: NextRequest) {
  const session = await getSessionSummary();
  const userId = session.profile?.id ?? null;

  if (
    !session.isAuthenticated ||
    !session.isEmailVerified ||
    !userId ||
    session.profile?.status?.toLowerCase() !== "active"
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE_HEADERS });
  }

  const service = getServerServiceClient();
  if (!service) {
    return NextResponse.json({ error: "Storage unavailable" }, { status: 503, headers: NO_STORE_HEADERS });
  }

  const previewPath = request.nextUrl.searchParams.get("previewPath")?.trim() ?? "";
  let storagePath: string | null = null;

  if (previewPath) {
    if (
      !isValidValidatedReviewImagePath(previewPath, userId) &&
      !isValidValidatedReviewVideoPath(previewPath, userId)
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE_HEADERS });
    }
    storagePath = previewPath;
  } else {
    const reviewId = request.nextUrl.searchParams.get("reviewId")?.trim() ?? "";
    const kind = request.nextUrl.searchParams.get("kind")?.trim() ?? "";
    const rawIdx = request.nextUrl.searchParams.get("index")?.trim() ?? "0";

    if (!isValidUuid(reviewId) || (kind !== "image" && kind !== "video")) {
      return NextResponse.json({ error: "Invalid media reference" }, { status: 400, headers: NO_STORE_HEADERS });
    }

    const { data: revRow } = await service
      .from("reviews")
      .select("id,buyer_id,hidden,image_paths,video_path")
      .eq("id", reviewId)
      .maybeSingle();

    const rev = revRow as {
      id: string;
      buyer_id: string;
      hidden: boolean;
      image_paths?: string[] | null;
      video_path?: string | null;
    } | null;

    if (!rev) {
      return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE_HEADERS });
    }

    if (rev.hidden && rev.buyer_id !== userId && !session.isActiveAdmin) {
      return NextResponse.json({ error: "Media unavailable" }, { status: 404, headers: NO_STORE_HEADERS });
    }

    if (kind === "video") {
      storagePath = rev.video_path?.trim() || null;
    } else {
      const idx = Number(rawIdx);
      const imgs = Array.isArray(rev.image_paths) ? rev.image_paths : [];
      if (!Number.isInteger(idx) || idx < 0 || idx >= imgs.length) {
        return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE_HEADERS });
      }
      storagePath = imgs[idx]?.trim() || null;
    }
  }

  if (!storagePath || storagePath.includes("..")) {
    return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE_HEADERS });
  }

  const { data: blob, error: dlErr } = await service.storage
    .from(REVIEW_MEDIA_BUCKET)
    .download(storagePath);

  if (dlErr || !blob) {
    return NextResponse.json({ error: "Media not found" }, { status: 404, headers: NO_STORE_HEADERS });
  }

  const buf = new Uint8Array(await blob.arrayBuffer());
  const mime = detectReviewMediaMagicMime(buf);
  if (!mime) {
    return NextResponse.json({ error: "Unsupported media" }, { status: 415, headers: NO_STORE_HEADERS });
  }

  const rangeHeader = request.headers.get("range");
  if (rangeHeader && mime.startsWith("video/")) {
    const match = /^bytes=(\d+)-(\d*)$/i.exec(rangeHeader.trim());
    if (match) {
      const start = Number(match[1]);
      const end = match[2] ? Math.min(Number(match[2]), buf.byteLength - 1) : buf.byteLength - 1;
      if (start >= 0 && start <= end && start < buf.byteLength) {
        const chunk = buf.subarray(start, end + 1);
        return new Response(chunk, {
          status: 206,
          headers: {
            ...NO_STORE_HEADERS,
            "Content-Type": mime,
            "Accept-Ranges": "bytes",
            "Content-Range": `bytes ${start}-${end}/${buf.byteLength}`,
            "Content-Length": String(chunk.byteLength),
          },
        });
      }
    }
  }

  return new Response(buf, {
    status: 200,
    headers: {
      ...NO_STORE_HEADERS,
      "Content-Type": mime,
      "Accept-Ranges": mime.startsWith("video/") ? "bytes" : "none",
      "Content-Length": String(buf.byteLength),
    },
  });
}

/**
 * Validates a staged review upload (`<uid>/staged/...`) by inspecting actual
 * magic bytes, byte limits (5 MB images / 20 MB videos), and MP4/WebM container
 * duration (<= 30s), then moves the exact bytes to `<uid>/validated/...`.
 */
export async function POST(request: NextRequest) {
  const session = await getSessionSummary();
  const eligibility = evaluateBuyerEligibility(session);

  if (!eligibility.eligible || !eligibility.userId) {
    return NextResponse.json(
      { ok: false, error: eligibility.reason || "Unauthorized." },
      { status: 401 }
    );
  }

  let body: { stagedPath?: string; fileName?: string };
  try {
    body = (await request.json()) as { stagedPath?: string; fileName?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request payload." }, { status: 400 });
  }

  const buyerId = eligibility.userId;
  const stagedPath = String(body.stagedPath ?? "").trim();
  const fileName = String(body.fileName ?? "").trim() || "review-media";

  if (!isValidStagedReviewMediaPath(stagedPath, buyerId)) {
    return NextResponse.json(
      { ok: false, error: "Invalid or unauthorized staged upload path." },
      { status: 400 }
    );
  }

  const service = getServerServiceClient();
  if (!service) {
    return NextResponse.json({ ok: false, error: "Storage unavailable." }, { status: 503 });
  }

  const { data: blob, error: dlErr } = await service.storage
    .from(REVIEW_MEDIA_BUCKET)
    .download(stagedPath);

  if (dlErr || !blob) {
    return NextResponse.json(
      { ok: false, error: "Staged media file could not be read. Please retry." },
      { status: 404 }
    );
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const removeStaged = () =>
    service.storage.from(REVIEW_MEDIA_BUCKET).remove([stagedPath]).catch(() => {});

  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_REVIEW_VIDEO_BYTES) {
    await removeStaged();
    return NextResponse.json(
      { ok: false, error: "File is empty or exceeds the 20 MB maximum size." },
      { status: 400 }
    );
  }

  const detectedMime = detectReviewMediaMagicMime(bytes);
  if (!detectedMime) {
    await removeStaged();
    return NextResponse.json(
      {
        ok: false,
        error: "Unsupported or corrupted file. Upload JPG, PNG, WebP photos or MP4/WebM video.",
      },
      { status: 400 }
    );
  }

  const isVideo = detectedMime === "video/mp4" || detectedMime === "video/webm";
  let durationSeconds: number | null = null;

  if (!isVideo && bytes.byteLength > MAX_REVIEW_PHOTO_BYTES) {
    await removeStaged();
    return NextResponse.json(
      { ok: false, error: "Review photos must be 5 MB or smaller." },
      { status: 400 }
    );
  }

  if (isVideo) {
    const durCheck = validateReviewVideoDurationBuffer(bytes, detectedMime);
    if (!durCheck.ok) {
      await removeStaged();
      return NextResponse.json(
        {
          ok: false,
          error:
            durCheck.error ||
            "Video must be 30 seconds or shorter with valid MP4/WebM duration metadata.",
        },
        { status: 400 }
      );
    }
    durationSeconds = durCheck.durationSeconds ?? null;
  }

  const ext = extensionForReviewMediaMime(detectedMime);
  const nonce = crypto.randomBytes(6).toString("hex");
  const validatedPath = `${buyerId}/validated/${Date.now()}-${nonce}-${sanitizeStem(fileName)}.${ext}`;

  const { error: upErr } = await service.storage
    .from(REVIEW_MEDIA_BUCKET)
    .upload(validatedPath, bytes, {
      contentType: detectedMime,
      upsert: false,
    });

  await removeStaged();

  if (upErr) {
    return NextResponse.json(
      { ok: false, error: "Could not finalize review media upload. Please retry." },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    validatedPath,
    kind: isVideo ? "video" : "image",
    mimeType: detectedMime,
    size: bytes.byteLength,
    durationSeconds,
  });
}

/**
 * Deletes an unattached temporary staged or owner-validated upload.
 * Refuses to delete files already persisted on a review row.
 */
export async function DELETE(request: NextRequest) {
  const session = await getSessionSummary();
  const eligibility = evaluateBuyerEligibility(session);

  if (!eligibility.eligible || !eligibility.userId) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  let body: { path?: string };
  try {
    body = (await request.json()) as { path?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid payload." }, { status: 400 });
  }

  const buyerId = eligibility.userId;
  const targetPath = String(body.path ?? "").trim();

  const isStaged = isValidStagedReviewMediaPath(targetPath, buyerId);
  const isValidated =
    isValidValidatedReviewImagePath(targetPath, buyerId) ||
    isValidValidatedReviewVideoPath(targetPath, buyerId);

  if (!isStaged && !isValidated) {
    return NextResponse.json({ ok: false, error: "Invalid media path." }, { status: 400 });
  }

  const service = getServerServiceClient();
  if (!service) {
    return NextResponse.json({ ok: false, error: "Storage unavailable." }, { status: 503 });
  }

  if (isValidated) {
    const { data: attached } = await service
      .from("reviews")
      .select("id")
      .or(`video_path.eq.${targetPath},image_paths.cs.{"${targetPath}"}`)
      .limit(1);

    if (attached && attached.length > 0) {
      return NextResponse.json({ ok: true, preserved: true });
    }
  }

  await service.storage.from(REVIEW_MEDIA_BUCKET).remove([targetPath]).catch(() => {});
  return NextResponse.json({ ok: true });
}
