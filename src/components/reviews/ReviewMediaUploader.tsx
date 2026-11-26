"use client";

import { useRef, useState } from "react";
import { Film, ImagePlus, Loader2, RefreshCw, X } from "lucide-react";
import {
  buildReviewMediaPreviewUrl,
} from "@/lib/reviews/presentation";
import {
  MAX_REVIEW_PHOTOS,
  MAX_REVIEW_VIDEO_SECONDS,
  REVIEW_MEDIA_BUCKET,
  validateReviewImageMeta,
  validateReviewVideoMeta,
} from "@/lib/reviews/validation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

interface UploadEntry {
  localId: string;
  kind: "image" | "video";
  file?: File;
  fileName: string;
  previewUrl: string;
  validatedPath: string | null;
  status: "uploading" | "validating" | "ready" | "error";
  progress: number;
  errorMessage: string | null;
  durationSeconds?: number | null;
}

interface ReviewMediaUploaderProps {
  reviewId?: string | null;
  initialImagePaths?: string[];
  initialVideoPath?: string | null;
  onMediaChange: (next: {
    imagePaths: string[];
    videoPath: string | null;
    isUploading: boolean;
  }) => void;
  disabled?: boolean;
}

async function readVideoMetadataDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    const cleanup = () => {
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    };
    video.onloadedmetadata = () => {
      const dur = Number.isFinite(video.duration) ? video.duration : null;
      cleanup();
      resolve(dur);
    };
    video.onerror = () => {
      cleanup();
      resolve(null);
    };
    video.src = url;
  });
}

function createUploadId(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 10)
      : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}-${Date.now()}-${rand}`;
}

function createStagedPath(userId: string, ext: string): string {
  const nonce =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 10)
      : Math.random().toString(36).slice(2, 12);
  return `${userId}/staged/${Date.now()}-${nonce}.${ext}`;
}

function uploadFileWithXhr(
  signedUrl: string,
  file: File,
  onProgress: (pct: number) => void
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", signedUrl, true);
    if (file.type) xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && ev.total > 0) {
        onProgress(Math.min(95, Math.round((ev.loaded / ev.total) * 95)));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve({ ok: true });
      } else {
        resolve({ ok: false, error: `Upload failed (${xhr.status}).` });
      }
    };
    xhr.onerror = () => resolve({ ok: false, error: "Network error during upload." });
    xhr.send(file);
  });
}

export function ReviewMediaUploader({
  reviewId,
  initialImagePaths = [],
  initialVideoPath = null,
  onMediaChange,
  disabled = false,
}: ReviewMediaUploaderProps) {
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);

  const [entries, setEntries] = useState<UploadEntry[]>(() => {
    const initial: UploadEntry[] = initialImagePaths.map((path, index) => ({
      localId: `init-img-${index}-${path}`,
      kind: "image",
      fileName: `Photo ${index + 1}`,
      previewUrl: reviewId
        ? `/api/reviews/media?reviewId=${encodeURIComponent(reviewId)}&kind=image&index=${index}`
        : buildReviewMediaPreviewUrl(path),
      validatedPath: path,
      status: "ready",
      progress: 100,
      errorMessage: null,
    }));
    if (initialVideoPath) {
      initial.push({
        localId: `init-vid-${initialVideoPath}`,
        kind: "video",
        fileName: "Review video",
        previewUrl: reviewId
          ? `/api/reviews/media?reviewId=${encodeURIComponent(reviewId)}&kind=video`
          : buildReviewMediaPreviewUrl(initialVideoPath),
        validatedPath: initialVideoPath,
        status: "ready",
        progress: 100,
        errorMessage: null,
      });
    }
    return initial;
  });

  const [globalError, setGlobalError] = useState<string | null>(null);

  function notifyParent(nextEntries: UploadEntry[]) {
    const imagePaths = nextEntries
      .filter((e) => e.kind === "image" && e.status === "ready" && e.validatedPath)
      .map((e) => e.validatedPath!);
    const videoEntry = nextEntries.find(
      (e) => e.kind === "video" && e.status === "ready" && e.validatedPath
    );
    const isUploading = nextEntries.some(
      (e) => e.status === "uploading" || e.status === "validating"
    );
    onMediaChange({
      imagePaths,
      videoPath: videoEntry?.validatedPath ?? null,
      isUploading,
    });
  }

  function updateEntries(updater: (prev: UploadEntry[]) => UploadEntry[]) {
    setEntries((prev) => {
      const next = updater(prev);
      queueMicrotask(() => notifyParent(next));
      return next;
    });
  }

  async function processUpload(entry: UploadEntry) {
    if (!entry.file) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      updateEntries((prev) =>
        prev.map((item) =>
          item.localId === entry.localId
            ? { ...item, status: "error", errorMessage: "Storage client unavailable." }
            : item
        )
      );
      return;
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user?.id) {
      updateEntries((prev) =>
        prev.map((item) =>
          item.localId === entry.localId
            ? { ...item, status: "error", errorMessage: "Sign in again to upload media." }
            : item
        )
      );
      return;
    }

    const rawExt = entry.fileName.match(/\.(jpg|jpeg|png|webp|mp4|webm)$/i)?.[1]?.toLowerCase()
      ?? (entry.kind === "video" ? "mp4" : "jpg");
    const ext = rawExt === "jpeg" ? "jpg" : rawExt;
    const stagedPath = createStagedPath(user.id, ext);

    updateEntries((prev) =>
      prev.map((item) =>
        item.localId === entry.localId
          ? { ...item, status: "uploading", progress: 5, errorMessage: null }
          : item
      )
    );

    let uploadedOk = false;
    let uploadErrMessage = "Upload failed. Check your connection and retry.";

    const signed = await supabase.storage
      .from(REVIEW_MEDIA_BUCKET)
      .createSignedUploadUrl(stagedPath);

    if (!signed.error && signed.data?.signedUrl) {
      const xhrRes = await uploadFileWithXhr(signed.data.signedUrl, entry.file, (pct) => {
        updateEntries((prev) =>
          prev.map((item) =>
            item.localId === entry.localId ? { ...item, progress: pct } : item
          )
        );
      });
      uploadedOk = xhrRes.ok;
      if (xhrRes.error) uploadErrMessage = xhrRes.error;
    } else {
      const { error: directErr } = await supabase.storage
        .from(REVIEW_MEDIA_BUCKET)
        .upload(stagedPath, entry.file, {
          upsert: false,
          contentType: entry.file.type || undefined,
        });
      uploadedOk = !directErr;
      if (directErr?.message) uploadErrMessage = directErr.message;
    }

    if (!uploadedOk) {
      updateEntries((prev) =>
        prev.map((item) =>
          item.localId === entry.localId
            ? { ...item, status: "error", errorMessage: uploadErrMessage }
            : item
        )
      );
      return;
    }

    updateEntries((prev) =>
      prev.map((item) =>
        item.localId === entry.localId
          ? { ...item, status: "validating", progress: 100 }
          : item
      )
    );

    try {
      const res = await fetch("/api/reviews/media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stagedPath, fileName: entry.fileName }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        validatedPath?: string;
        durationSeconds?: number | null;
        error?: string;
      };
      if (!res.ok || !json.ok || !json.validatedPath) {
        updateEntries((prev) =>
          prev.map((item) =>
            item.localId === entry.localId
              ? {
                  ...item,
                  status: "error",
                  errorMessage: json.error || "Media validation failed.",
                }
              : item
          )
        );
        return;
      }

      updateEntries((prev) =>
        prev.map((item) =>
          item.localId === entry.localId
            ? {
                ...item,
                status: "ready",
                validatedPath: json.validatedPath!,
                previewUrl: buildReviewMediaPreviewUrl(json.validatedPath!),
                durationSeconds: json.durationSeconds ?? item.durationSeconds,
                errorMessage: null,
              }
            : item
        )
      );
    } catch {
      updateEntries((prev) =>
        prev.map((item) =>
          item.localId === entry.localId
            ? {
                ...item,
                status: "error",
                errorMessage: "Network error while verifying upload.",
              }
            : item
        )
      );
    }
  }

  async function handleSelectPhotos(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setGlobalError(null);
    const currentPhotos = entries.filter((e) => e.kind === "image").length;
    const remaining = MAX_REVIEW_PHOTOS - currentPhotos;
    if (remaining <= 0) {
      setGlobalError(`You can attach up to ${MAX_REVIEW_PHOTOS} photos per review.`);
      return;
    }

    const picked = Array.from(fileList).slice(0, remaining);
    if (fileList.length > remaining) {
      setGlobalError(`Only ${remaining} more photo${remaining === 1 ? "" : "s"} could be added (max ${MAX_REVIEW_PHOTOS}).`);
    }

    const added: UploadEntry[] = [];
    for (const file of picked) {
      const check = validateReviewImageMeta({ type: file.type, size: file.size });
      if (!check.ok) {
        setGlobalError(check.error || "Invalid photo selected.");
        continue;
      }
      const localId = createUploadId("img");
      const entry: UploadEntry = {
        localId,
        kind: "image",
        file,
        fileName: file.name,
        previewUrl: URL.createObjectURL(file),
        validatedPath: null,
        status: "uploading",
        progress: 0,
        errorMessage: null,
      };
      added.push(entry);
    }

    if (added.length === 0) return;
    updateEntries((prev) => [...prev, ...added]);
    for (const entry of added) {
      void processUpload(entry);
    }
  }

  async function handleSelectVideo(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setGlobalError(null);
    const hasVideo = entries.some((e) => e.kind === "video");
    if (hasVideo) {
      setGlobalError("Only 1 video can be attached per review. Remove the existing video first.");
      return;
    }

    const file = fileList[0]!;
    const duration = await readVideoMetadataDuration(file);
    const check = validateReviewVideoMeta({
      type: file.type,
      size: file.size,
      durationSeconds: duration,
    });
    if (!check.ok) {
      setGlobalError(check.error || "Invalid review video.");
      return;
    }

    const entry: UploadEntry = {
      localId: createUploadId("vid"),
      kind: "video",
      file,
      fileName: file.name,
      previewUrl: URL.createObjectURL(file),
      validatedPath: null,
      status: "uploading",
      progress: 0,
      errorMessage: null,
      durationSeconds: duration,
    };

    updateEntries((prev) => [...prev, entry]);
    void processUpload(entry);
  }

  function handleRemove(entry: UploadEntry) {
    setGlobalError(null);
    if (entry.previewUrl.startsWith("blob:")) {
      URL.revokeObjectURL(entry.previewUrl);
    }
    if (entry.validatedPath) {
      void fetch("/api/reviews/media", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: entry.validatedPath }),
      }).catch(() => {});
    }
    updateEntries((prev) => prev.filter((item) => item.localId !== entry.localId));
  }

  const photoEntries = entries.filter((e) => e.kind === "image");
  const videoEntry = entries.find((e) => e.kind === "video") ?? null;

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-bold text-[#14121A]">
          Photos &amp; Video <span className="font-normal text-[#6B6779]">(optional)</span>
        </span>
        <span className="text-[11px] text-[#6B6779]">
          Up to {MAX_REVIEW_PHOTOS} photos (&le; 5 MB) &middot; 1 video (&le; 20 MB, &le; {MAX_REVIEW_VIDEO_SECONDS}s)
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        {photoEntries.map((item) => (
          <div
            key={item.localId}
            className="relative h-16 w-16 overflow-hidden rounded-xl border border-[#E6E3EE] bg-[#F5F4F8]"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={item.previewUrl}
              alt={item.fileName}
              className="h-full w-full object-cover"
            />
            {(item.status === "uploading" || item.status === "validating") && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/55 text-[10px] font-bold text-white">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span>{item.status === "validating" ? "Checking" : `${item.progress}%`}</span>
              </div>
            )}
            {item.status === "error" && (
              <button
                type="button"
                onClick={() => processUpload(item)}
                title={item.errorMessage || "Retry upload"}
                aria-label={`Retry uploading ${item.fileName}`}
                className="absolute inset-0 flex flex-col items-center justify-center bg-[#B42318]/80 text-[10px] font-bold text-white"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Retry</span>
              </button>
            )}
            <button
              type="button"
              disabled={disabled}
              onClick={() => handleRemove(item)}
              aria-label={`Remove ${item.fileName}`}
              className="absolute right-1 top-1 flex h-5 w-5 cursor-pointer items-center justify-center rounded-full bg-black/75 text-white hover:bg-black disabled:opacity-50"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </div>
        ))}

        {videoEntry ? (
          <div className="relative flex h-16 w-28 items-center justify-center overflow-hidden rounded-xl border border-[#E6E3EE] bg-[#14121A] px-2 text-white">
            <div className="flex flex-col items-center gap-0.5 text-center">
              <Film className="h-4 w-4 text-[#00A3A6]" aria-hidden="true" />
              <span className="max-w-[90px] truncate text-[10px] font-bold">
                {videoEntry.fileName}
              </span>
              {videoEntry.status === "uploading" || videoEntry.status === "validating" ? (
                <span className="text-[9px] text-white/80">
                  {videoEntry.status === "validating"
                    ? "Checking..."
                    : `${videoEntry.progress}%`}
                </span>
              ) : videoEntry.status === "error" ? (
                <button
                  type="button"
                  onClick={() => processUpload(videoEntry)}
                  className="text-[10px] font-bold text-amber-300 underline"
                >
                  Retry
                </button>
              ) : (
                <span className="text-[9px] text-[#5CE1E4]">Ready</span>
              )}
            </div>
            <button
              type="button"
              disabled={disabled}
              onClick={() => handleRemove(videoEntry)}
              aria-label="Remove video"
              className="absolute right-1 top-1 flex h-5 w-5 cursor-pointer items-center justify-center rounded-full bg-white/20 text-white hover:bg-white/35 disabled:opacity-50"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </div>
        ) : null}

        {photoEntries.length < MAX_REVIEW_PHOTOS && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => imageInputRef.current?.click()}
            className="flex h-16 cursor-pointer items-center gap-1.5 rounded-xl border border-dashed border-[#CFCBD9] bg-[#FAF9FC] px-3 text-xs font-bold text-[#4E2A84] transition-colors hover:border-[#4E2A84] hover:bg-[#F4F1FA] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ImagePlus className="h-4 w-4" aria-hidden="true" />
            <span>Add Photos ({photoEntries.length}/{MAX_REVIEW_PHOTOS})</span>
          </button>
        )}

        {!videoEntry && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => videoInputRef.current?.click()}
            className="flex h-16 cursor-pointer items-center gap-1.5 rounded-xl border border-dashed border-[#CFCBD9] bg-[#FAF9FC] px-3 text-xs font-bold text-[#006A6D] transition-colors hover:border-[#00A3A6] hover:bg-[#EDFAF9] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Film className="h-4 w-4" aria-hidden="true" />
            <span>Add Video</span>
          </button>
        )}
      </div>

      <input
        ref={imageInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        className="sr-only"
        onChange={(e) => {
          void handleSelectPhotos(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={videoInputRef}
        type="file"
        accept="video/mp4,video/webm"
        className="sr-only"
        onChange={(e) => {
          void handleSelectVideo(e.target.files);
          e.target.value = "";
        }}
      />

      {entries
        .filter((e) => e.status === "error" && e.errorMessage)
        .map((e) => (
          <p key={`err-${e.localId}`} role="alert" className="text-[11px] font-semibold text-[#B42318]">
            {e.fileName}: {e.errorMessage}
          </p>
        ))}

      {globalError ? (
        <p role="alert" className="text-[11px] font-semibold text-[#B42318]">
          {globalError}
        </p>
      ) : null}
    </div>
  );
}
