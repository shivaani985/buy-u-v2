"use client";

import { ExternalLink, FileText, Paperclip } from "lucide-react";
import {
  extractAttachmentDisplayName,
  formatServiceModeLabel,
  serviceAttachmentProxyUrl,
} from "@/lib/orders/service-attachments";

export interface ServiceOrderDetailItem {
  id: string;
  title: string;
  isService?: boolean;
  serviceMode?: string | null;
  serviceRequirements?: string | null;
  serviceAttachmentPaths?: string[];
}

interface ServiceOrderDetailsBlockProps {
  orderId: string;
  items: ServiceOrderDetailItem[];
  compact?: boolean;
}

export function ServiceOrderDetailsBlock({
  orderId,
  items,
  compact = false,
}: ServiceOrderDetailsBlockProps) {
  const serviceItems = items.filter((it) => it.isService);
  if (serviceItems.length === 0) return null;

  const hasAnyDetails = serviceItems.some(
    (it) =>
      Boolean(it.serviceMode) ||
      Boolean(it.serviceRequirements?.trim()) ||
      (it.serviceAttachmentPaths?.length ?? 0) > 0
  );
  if (!hasAnyDetails) return null;

  return (
    <div
      className={`border-t border-[#ECEAF3] bg-[#FAF8FD] ${
        compact ? "px-4 py-3" : "px-5 py-3.5"
      }`}
    >
      <p className="text-[11px] font-extrabold uppercase tracking-wide text-[#4E2A84]">
        Service Brief &amp; Reference Files
      </p>
      <div className="mt-2 space-y-2.5">
        {serviceItems.map((item) => {
          const req = item.serviceRequirements?.trim() ?? "";
          const attachments = item.serviceAttachmentPaths ?? [];
          if (!item.serviceMode && !req && attachments.length === 0) return null;

          return (
            <div
              key={item.id}
              className="rounded-xl border border-[#E6E3EE] bg-white p-3 text-xs"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-bold text-[#14121A]">{item.title}</span>
                {item.serviceMode ? (
                  <span className="inline-flex items-center rounded-full bg-[#F3ECFC] px-2 py-0.5 text-[10.5px] font-bold text-[#4E2A84]">
                    {formatServiceModeLabel(item.serviceMode)}
                  </span>
                ) : null}
              </div>

              {req ? (
                <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-[#3E3A4A]">
                  {req}
                </p>
              ) : null}

              {attachments.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {attachments.map((path, idx) => {
                    const label = extractAttachmentDisplayName(path);
                    const href = serviceAttachmentProxyUrl(
                      orderId,
                      item.id,
                      path
                    );
                    const isPdf = label.toLowerCase().endsWith(".pdf");
                    return (
                      <a
                        key={`${path}-${idx}`}
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-[#D9D4E6] bg-[#FAF9FC] px-2.5 py-1.5 text-[11px] font-semibold text-[#4E2A84] transition hover:border-[#4E2A84] hover:bg-[#F3ECFC]"
                      >
                        {isPdf ? (
                          <FileText
                            className="h-3.5 w-3.5 shrink-0"
                            aria-hidden="true"
                          />
                        ) : (
                          <Paperclip
                            className="h-3.5 w-3.5 shrink-0"
                            aria-hidden="true"
                          />
                        )}
                        <span className="max-w-[180px] truncate">{label}</span>
                        <ExternalLink
                          className="h-3 w-3 shrink-0 opacity-70"
                          aria-hidden="true"
                        />
                      </a>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
