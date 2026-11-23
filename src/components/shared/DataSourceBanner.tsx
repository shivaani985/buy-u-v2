import Link from "next/link";
import { AlertTriangle, Database, Info } from "lucide-react";
import type { CatalogDataSource } from "@/types/marketplace";

interface DataSourceBannerProps {
  source: CatalogDataSource;
  notice?: string;
  errorCode?: string;
  demoHref?: string;
  liveHref?: string;
}

export function DataSourceBanner({
  source,
  notice,
  errorCode,
  demoHref = "?demo=1",
  liveHref = "?",
}: DataSourceBannerProps) {
  if (source === "supabase") {
    return (
      <div
        role="status"
        className="flex flex-wrap items-center justify-between gap-2 border border-[#00A3A6] bg-[#F2FAFA] px-4 py-2.5 text-sm text-[#14121A]"
      >
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 shrink-0 text-[#007D80]" aria-hidden="true" />
          <span className="font-semibold text-[#007D80]">Live Read-Only Mode:</span>
          <span>Connected to Buy-U Supabase catalog (duwwlcpdidrxkixvflag).</span>
        </div>
      </div>
    );
  }

  if (source === "error") {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-3 border-2 border-[#4E2A84] bg-[#F8F4FC] px-4 py-3 text-sm text-[#14121A]"
      >
        <div className="flex items-start gap-2.5">
          <AlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0 text-[#4E2A84]"
            aria-hidden="true"
          />
          <div>
            <span className="font-bold text-[#4E2A84]">
              Live Catalog Restricted{errorCode ? ` (${errorCode})` : ""}:{" "}
            </span>
            <span>
              {notice ??
                "Unable to load live records from Supabase with the public anon key."}
            </span>
          </div>
        </div>

        <Link
          href={demoHref}
          className="shrink-0 border border-[#4E2A84] bg-white px-3 py-1 text-xs font-bold text-[#4E2A84] hover:bg-[#4E2A84] hover:text-white"
        >
          Preview Demo Mode
        </Link>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-3 border border-[#1D70B8] bg-[#F3F8FC] px-4 py-2.5 text-sm text-[#14121A]"
    >
      <div className="flex items-center gap-2">
        <Info className="h-4 w-4 shrink-0 text-[#1D70B8]" aria-hidden="true" />
        <span className="font-semibold text-[#14538A]">Explicit Demo Mode:</span>
        <span>
          {notice ??
            "Showing explicitly labeled sample listings for offline UI preview."}
        </span>
      </div>

      <Link
        href={liveHref}
        className="shrink-0 border border-[#1D70B8] bg-white px-3 py-1 text-xs font-bold text-[#14538A] hover:bg-[#1D70B8] hover:text-white"
      >
        Return to Live Mode
      </Link>
    </div>
  );
}
