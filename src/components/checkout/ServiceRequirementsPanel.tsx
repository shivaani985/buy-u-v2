"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  FileText,
  Loader2,
  Paperclip,
  RotateCcw,
  Trash2,
} from "lucide-react";
import {
  MAX_SERVICE_ATTACHMENTS,
  MAX_SERVICE_REQUIREMENTS_LEN,
  SERVICE_ATTACHMENTS_BUCKET,
  buildStagedServiceAttachmentPath,
  buildUniqueServiceFileName,
  validateClientServiceFileSelection,
} from "@/lib/orders/service-attachments";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export interface ServiceItemCheckoutState {
  requirements: string;
  validatedPaths: string[];
  isBusy: boolean;
  hasFailedUpload: boolean;
}

interface AttachmentUploadEntry {
  localId: string;
  file: File;
  fileName: string;
  sizeBytes: number;
  mimeType: string;
  previewUrl: string | null;
  stagedPath: string | null;
  validatedPath: string | null;
  status: "uploading" | "validating" | "ready" | "error";
  errorMessage: string | null;
}

interface ServiceRequirementsPanelProps {
  buyerId: string;
  cartItemId: string;
  serviceTitle: string;
  disabled?: boolean;
  onChange: (state: ServiceItemCheckoutState) => void;
}

export function ServiceRequirementsPanel({
  buyerId,
  cartItemId,
  serviceTitle,
  disabled = false,
  onChange,
}: ServiceRequirementsPanelProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [requirements, setRequirements] = useState("");
  const [entries, setEntries] = useState<AttachmentUploadEntry[]>([]);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const entriesRef = useRef<AttachmentUploadEntry[]>(entries);
  entriesRef.current = entries;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    onChangeRef.current({
      requirements,
      validatedPaths: entries
        .filter((e) => e.status === "ready" && Boolean(e.validatedPath))
        .map((e) => e.validatedPath as string),
      isBusy: entries.some(
        (e) => e.status === "uploading" || e.status === "validating"
      ),
      hasFailedUpload: entries.some((e) => e.status === "error"),
    });
  }, [requirements, entries]);

  useEffect(() => {
    return () => {
      for (const entry of entriesRef.current) {
        if (entry.previewUrl) {
          URL.revokeObjectURL(entry.previewUrl);
        }
      }
    };
  }, []);

  async function runUploadAndValidate(entry: AttachmentUploadEntry) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setEntries((prev) =>
        prev.map((item) =>
          item.localId === entry.localId
            ? {
                ...item,
                status: "error",
                errorMessage: "Storage client is not configured.",
              }
            : item
        )
      );
      return;
    }

    const extMatch = entry.fileName.match(/\.(jpg|jpeg|png|webp|pdf)$/i);
    const safeExt = extMatch?.[1]?.toLowerCase() ?? "pdf";
    const nonce =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID().replace(/-/g, "").slice(0, 8)
        : Math.random().toString(36).slice(2, 10);
    const uniqueName = buildUniqueServiceFileName(entry.fileName, safeExt, nonce);
    const stagedPath = buildStagedServiceAttachmentPath(
      buyerId,
      cartItemId,
      uniqueName
    );

    setEntries((prev) =>
      prev.map((item) =>
        item.localId === entry.localId
          ? {
              ...item,
              stagedPath,
              status: "uploading",
              errorMessage: null,
            }
          : item
      )
    );

    const { error: uploadErr } = await supabase.storage
      .from(SERVICE_ATTACHMENTS_BUCKET)
      .upload(stagedPath, entry.file, {
        upsert: false,
        contentType: entry.file.type || undefined,
      });

    if (uploadErr) {
      setEntries((prev) =>
        prev.map((item) =>
          item.localId === entry.localId
            ? {
                ...item,
                status: "error",
                errorMessage:
                  uploadErr.message ||
                  "Upload failed. Check your connection and retry.",
              }
            : item
        )
      );
      return;
    }

    setEntries((prev) =>
      prev.map((item) =>
        item.localId === entry.localId
          ? { ...item, status: "validating", errorMessage: null }
          : item
      )
    );

    try {
      const res = await fetch("/api/orders/service-attachment/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cartItemId,
          stagedPath,
          fileName: entry.fileName,
        }),
      });

      const payload = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        validatedPath?: string;
        mimeType?: string;
        error?: string;
      };

      if (!res.ok || !payload.ok || !payload.validatedPath) {
        setEntries((prev) =>
          prev.map((item) =>
            item.localId === entry.localId
              ? {
                  ...item,
                  status: "error",
                  errorMessage:
                    payload.error ||
                    "File validation failed. Upload a valid JPG, PNG, WebP, or PDF under 5 MB.",
                }
              : item
          )
        );
        return;
      }

      setEntries((prev) =>
        prev.map((item) =>
          item.localId === entry.localId
            ? {
                ...item,
                validatedPath: payload.validatedPath!,
                mimeType: payload.mimeType ?? item.mimeType,
                status: "ready",
                errorMessage: null,
              }
            : item
        )
      );
    } catch {
      setEntries((prev) =>
        prev.map((item) =>
          item.localId === entry.localId
            ? {
                ...item,
                status: "error",
                errorMessage: "Network error while validating attachment. Retry.",
              }
            : item
        )
      );
    }
  }

  function handleFilePick(files: FileList | null) {
    if (!files || files.length === 0) return;
    setPickerError(null);

    const selected = Array.from(files);
    const remainingSlots = MAX_SERVICE_ATTACHMENTS - entries.length;

    if (remainingSlots <= 0) {
      setPickerError(
        `Maximum ${MAX_SERVICE_ATTACHMENTS} files allowed per service.`
      );
      return;
    }

    const toProcess = selected.slice(0, remainingSlots);
    if (selected.length > remainingSlots) {
      setPickerError(
        `Only ${remainingSlots} more file${remainingSlots === 1 ? "" : "s"} can be added (max ${MAX_SERVICE_ATTACHMENTS}).`
      );
    }

    const newEntries: AttachmentUploadEntry[] = [];
    for (const file of toProcess) {
      const check = validateClientServiceFileSelection({
        name: file.name,
        size: file.size,
        type: file.type,
      });
      if (!check.ok) {
        setPickerError(check.error);
        continue;
      }

      const isImage = file.type.startsWith("image/");
      const localId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      newEntries.push({
        localId,
        file,
        fileName: file.name,
        sizeBytes: file.size,
        mimeType: file.type || "application/octet-stream",
        previewUrl: isImage ? URL.createObjectURL(file) : null,
        stagedPath: null,
        validatedPath: null,
        status: "uploading",
        errorMessage: null,
      });
    }

    if (newEntries.length > 0) {
      setEntries((prev) => [...prev, ...newEntries]);
      for (const entry of newEntries) {
        void runUploadAndValidate(entry);
      }
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  async function handleRemove(entry: AttachmentUploadEntry) {
    if (entry.previewUrl) {
      URL.revokeObjectURL(entry.previewUrl);
    }
    setEntries((prev) => prev.filter((item) => item.localId !== entry.localId));

    // Only delete unvalidated staged uploads; validated files stay immutable (deferred cleanup)
    if (!entry.validatedPath && entry.stagedPath) {
      void fetch("/api/orders/service-attachment/validate", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: entry.stagedPath }),
      }).catch(() => undefined);
    }
  }

  const hasNotes = requirements.trim().length > 0;
  const readyCount = entries.filter((e) => e.status === "ready").length;
  const busyCount = entries.filter(
    (e) => e.status === "uploading" || e.status === "validating"
  ).length;
  const errorCount = entries.filter((e) => e.status === "error").length;

  return (
    <div className="mt-3 rounded-xl border border-[#E6E3EE] bg-[#FAF9FC]">
      <button
        type="button"
        aria-expanded={isExpanded}
        aria-controls={`service-req-panel-${cartItemId}`}
        onClick={() => setIsExpanded((prev) => !prev)}
        className="flex w-full cursor-pointer items-center justify-between gap-2 px-3.5 py-2.5 text-left transition-colors hover:bg-[#F4F1FA]/70 rounded-xl"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-bold text-[#14121A]">
            Service Requirements{" "}
            <span className="font-normal text-[#6B6779]">(Optional)</span>
          </span>
          {!isExpanded && (hasNotes || entries.length > 0) ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold">
              {hasNotes ? (
                <span className="rounded-full bg-[#F3ECFC] px-2 py-0.5 text-[#4E2A84]">
                  Notes added
                </span>
              ) : null}
              {readyCount > 0 ? (
                <span className="rounded-full bg-[#EDFAF9] px-2 py-0.5 text-[#008285]">
                  {readyCount} {readyCount === 1 ? "file" : "files"}
                </span>
              ) : null}
              {busyCount > 0 ? (
                <span className="rounded-full bg-[#EDF5FC] px-2 py-0.5 text-[#1D70B8]">
                  Uploading...
                </span>
              ) : null}
              {errorCount > 0 ? (
                <span className="rounded-full bg-[#FEF2F2] px-2 py-0.5 text-[#B42318]">
                  {errorCount} failed
                </span>
              ) : null}
            </span>
          ) : null}
        </div>

        <ChevronDown
          className={`h-4 w-4 shrink-0 text-[#6B6779] transition-transform duration-200 ${
            isExpanded ? "rotate-180" : ""
          }`}
          aria-hidden="true"
        />
      </button>

      {isExpanded ? (
        <div
          id={`service-req-panel-${cartItemId}`}
          className="border-t border-[#ECEAF3] px-3.5 pb-3.5 pt-2.5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label
              htmlFor={`service-req-${cartItemId}`}
              className="text-xs font-semibold text-[#4A4656]"
            >
              Instructions or notes for seller
            </label>
            <span className="text-[11px] font-medium text-[#6B6779]">
              {requirements.length}/{MAX_SERVICE_REQUIREMENTS_LEN}
            </span>
          </div>

          <textarea
            id={`service-req-${cartItemId}`}
            rows={3}
            maxLength={MAX_SERVICE_REQUIREMENTS_LEN}
            disabled={disabled}
            value={requirements}
            onChange={(e) => setRequirements(e.target.value)}
            placeholder={`Share brief instructions, preferred timing, or details for "${serviceTitle}"...`}
            className="mt-1.5 w-full resize-y rounded-xl border border-[#D9D4E6] bg-white px-3 py-2 text-xs text-[#14121A] placeholder:text-[#9A95A8] focus:border-[#4E2A84] focus:outline-none disabled:bg-[#F4F2F8]"
          />

      {/* Attachments Header & Picker */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold text-[#14121A]">
            Reference Files ({entries.length}/{MAX_SERVICE_ATTACHMENTS})
          </p>
          <p className="text-[11px] text-[#6B6779]">
            JPG, PNG, WebP, or PDF &middot; max 5 MB each
          </p>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf"
          disabled={
            disabled || entries.length >= MAX_SERVICE_ATTACHMENTS
          }
          onChange={(e) => handleFilePick(e.target.files)}
          className="hidden"
          id={`service-files-${cartItemId}`}
        />

        <label
          htmlFor={`service-files-${cartItemId}`}
          className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-bold transition ${
            disabled || entries.length >= MAX_SERVICE_ATTACHMENTS
              ? "cursor-not-allowed border-[#E6E3EE] bg-[#F4F2F8] text-[#9A95A8]"
              : "border-[#4E2A84]/35 bg-white text-[#4E2A84] hover:bg-[#F5F0FC]"
          }`}
        >
          <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Attach Files</span>
        </label>
      </div>

      {pickerError ? (
        <p
          role="alert"
          className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-[#B42318]"
        >
          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{pickerError}</span>
        </p>
      ) : null}

      {entries.length > 0 ? (
        <ul className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {entries.map((entry) => {
            const isPdf =
              entry.mimeType === "application/pdf" ||
              entry.fileName.toLowerCase().endsWith(".pdf");

            return (
              <li
                key={entry.localId}
                className={`flex items-start gap-2.5 rounded-xl border bg-white p-2.5 ${
                  entry.status === "error"
                    ? "border-[#F5C2C0] bg-[#FFF8F8]"
                    : "border-[#E6E3EE]"
                }`}
              >
                {entry.previewUrl && !isPdf ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={entry.previewUrl}
                    alt={entry.fileName}
                    className="h-11 w-11 shrink-0 rounded-lg border border-[#E6E3EE] object-cover"
                  />
                ) : (
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-[#E6E3EE] bg-[#F4F1FA] text-[#4E2A84]">
                    <FileText className="h-5 w-5" aria-hidden="true" />
                  </div>
                )}

                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-semibold text-[#14121A]">
                    {entry.fileName}
                  </p>
                  <p className="text-[11px] text-[#6B6779]">
                    {formatAttachmentSize(entry.sizeBytes)}
                  </p>

                  {entry.status === "uploading" ? (
                    <p className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-[#4E2A84]">
                      <Loader2
                        className="h-3 w-3 animate-spin"
                        aria-hidden="true"
                      />
                      <span>Uploading...</span>
                    </p>
                  ) : entry.status === "validating" ? (
                    <p className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-[#1D70B8]">
                      <Loader2
                        className="h-3 w-3 animate-spin"
                        aria-hidden="true"
                      />
                      <span>Verifying file...</span>
                    </p>
                  ) : entry.status === "ready" ? (
                    <p className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-[#008285]">
                      <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                      <span>Ready</span>
                    </p>
                  ) : (
                    <div className="mt-1 space-y-1">
                      <p className="text-[11px] font-semibold text-[#B42318]">
                        {entry.errorMessage ?? "Upload failed."}
                      </p>
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => void runUploadAndValidate(entry)}
                        className="inline-flex items-center gap-1 text-[11px] font-bold text-[#4E2A84] hover:underline disabled:opacity-50"
                      >
                        <RotateCcw className="h-3 w-3" aria-hidden="true" />
                        <span>Retry</span>
                      </button>
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void handleRemove(entry)}
                  aria-label={`Remove ${entry.fileName}`}
                  className="rounded-lg p-1 text-[#6B6779] transition hover:bg-[#FEF2F2] hover:text-[#B42318] disabled:opacity-40"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
        </div>
      ) : null}
    </div>
  );
}
