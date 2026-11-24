"use client";

import { useState } from "react";
import { ImagePlus, Loader2, X } from "lucide-react";
import {
  MAX_DISPUTE_EVIDENCE_FILES,
  validateDisputeEvidenceFileMeta,
} from "@/lib/disputes/validation";

export interface UploadedEvidenceItem {
  path: string;
  previewUrl: string;
}

interface DisputeEvidenceUploaderProps {
  orderId: string;
  items: UploadedEvidenceItem[];
  onChange: (next: UploadedEvidenceItem[]) => void;
  disabled?: boolean;
}

export function DisputeEvidenceUploader({
  orderId,
  items,
  onChange,
  disabled = false,
}: DisputeEvidenceUploaderProps) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setError(null);

    const remaining = MAX_DISPUTE_EVIDENCE_FILES - items.length;
    if (remaining <= 0) {
      setError(`Maximum ${MAX_DISPUTE_EVIDENCE_FILES} supporting images allowed.`);
      return;
    }

    const files = Array.from(fileList).slice(0, remaining);
    setUploading(true);
    const next = [...items];

    try {
      for (const file of files) {
        const metaCheck = validateDisputeEvidenceFileMeta({
          type: file.type,
          size: file.size,
        });
        if (!metaCheck.ok) {
          setError(metaCheck.error || "Invalid image file.");
          continue;
        }

        const fd = new FormData();
        fd.append("orderId", orderId);
        fd.append("file", file);

        const res = await fetch("/api/disputes/evidence", {
          method: "POST",
          body: fd,
        });
        const json = (await res.json().catch(() => null)) as {
          ok?: boolean;
          path?: string;
          previewUrl?: string;
          error?: string;
        } | null;

        if (!res.ok || !json?.ok || !json.path || !json.previewUrl) {
          setError(json?.error || "Could not upload image.");
          continue;
        }

        next.push({ path: json.path, previewUrl: json.previewUrl });
      }
      onChange(next);
    } catch {
      setError("Network error while uploading evidence image.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-bold text-[#14121A]">
          Supporting Photos ({items.length}/{MAX_DISPUTE_EVIDENCE_FILES})
        </span>
        <span className="text-[11px] text-[#6B6779]">
          Private · JPG/PNG/WebP · Max 5 MB each
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        {items.map((item) => (
          <div
            key={item.path}
            className="relative h-16 w-16 overflow-hidden rounded-xl border border-[#E6E3EE] bg-[#FAF9FC]"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={item.previewUrl}
              alt="Dispute evidence"
              className="h-full w-full object-cover"
            />
            {!disabled ? (
              <button
                type="button"
                aria-label="Remove evidence image"
                onClick={() =>
                  onChange(items.filter((i) => i.path !== item.path))
                }
                className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-white hover:bg-black"
              >
                <X className="h-3 w-3" />
              </button>
            ) : null}
          </div>
        ))}

        {items.length < MAX_DISPUTE_EVIDENCE_FILES && !disabled ? (
          <label className="flex h-16 w-16 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-[#C7C0DB] bg-[#FAF9FC] text-[#4E2A84] transition hover:border-[#4E2A84] hover:bg-[#F3EEFA]">
            {uploading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <ImagePlus className="h-4 w-4" aria-hidden="true" />
                <span className="mt-0.5 text-[10px] font-bold">Add</span>
              </>
            )}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              disabled={uploading || disabled}
              onChange={(e) => {
                void handleFiles(e.target.files);
                e.target.value = "";
              }}
              className="sr-only"
            />
          </label>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-xs font-semibold text-[#B42318]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
