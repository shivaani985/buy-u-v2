import { Database, Info } from "lucide-react";
import type { CatalogDataSource } from "@/types/marketplace";

interface DataSourceBannerProps {
  source: CatalogDataSource;
  notice?: string;
}

export function DataSourceBanner({ source, notice }: DataSourceBannerProps) {
  if (source === "supabase") {
    return (
      <div
        role="status"
        className="flex flex-wrap items-center gap-2 border border-[#00A3A6] bg-[#F2FAFA] px-4 py-2.5 text-sm text-[#14121A]"
      >
        <Database className="h-4 w-4 shrink-0 text-[#007D80]" aria-hidden="true" />
        <span className="font-semibold text-[#007D80]">Live Read-Only Mode:</span>
        <span>Connected to verified Buy-U Supabase catalog.</span>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 border border-[#1D70B8] bg-[#F3F8FC] px-4 py-2.5 text-sm text-[#14121A]"
    >
      <Info className="h-4 w-4 shrink-0 text-[#1D70B8]" aria-hidden="true" />
      <span className="font-semibold text-[#14538A]">Demo Data Mode:</span>
      <span>
        {notice ??
          "Showing clearly labeled sample listings until Supabase credentials are verified in .env.local."}
      </span>
    </div>
  );
}
