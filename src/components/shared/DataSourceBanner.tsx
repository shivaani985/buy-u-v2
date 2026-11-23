import Link from "next/link";
import { AlertTriangle, Database, Info, Lock, LogIn, UserPlus } from "lucide-react";
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
          <span className="font-semibold text-[#007D80]">Live UMS Catalog:</span>
          <span>Connected as verified member (read-only).</span>
        </div>
      </div>
    );
  }

  if (source === "auth_required") {
    return (
      <div
        role="region"
        aria-label="UMS member access"
        className="flex flex-wrap items-center justify-between gap-4 border-2 border-[#4E2A84] bg-[#F8F4FC] px-5 py-4 text-sm text-[#14121A]"
      >
        <div className="flex items-start gap-3">
          <Lock
            className="mt-0.5 h-5 w-5 shrink-0 text-[#4E2A84]"
            aria-hidden="true"
          />
          <div>
            <p className="font-extrabold text-[#14121A]">
              UMS Member Sign-In Required for Live Campus Listings
            </p>
            <p className="mt-0.5 text-[#4A4656]">
              {notice ??
                "Buy-U is a verified Universiti Malaysia Sabah community. Sign in with your @iluv.ums.edu.my or @ums.edu.my account to browse live items."}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/login"
            className="inline-flex items-center gap-1.5 bg-[#4E2A84] px-4 py-2 text-xs font-bold text-white hover:bg-[#381C63] press-feedback"
          >
            <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Sign In</span>
          </Link>
          <Link
            href="/register"
            className="inline-flex items-center gap-1.5 border border-[#14121A] bg-white px-4 py-2 text-xs font-bold text-[#14121A] hover:bg-[#F7F7F5]"
          >
            <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Register</span>
          </Link>
          <Link
            href={demoHref}
            className="border border-[#1D70B8] bg-white px-3 py-2 text-xs font-bold text-[#14538A] hover:bg-[#F3F8FC]"
          >
            Demo Preview
          </Link>
        </div>
      </div>
    );
  }

  if (source === "restricted") {
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
            <span className="font-bold text-[#4E2A84]">Account Verification Needed: </span>
            <span>{notice}</span>
          </div>
        </div>
        <Link
          href="/account"
          className="shrink-0 border border-[#4E2A84] bg-white px-3 py-1 text-xs font-bold text-[#4E2A84] hover:bg-[#4E2A84] hover:text-white"
        >
          View Account Status
        </Link>
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
              Catalog Error{errorCode ? ` (${errorCode})` : ""}:{" "}
            </span>
            <span>{notice ?? "Unable to load records from Supabase."}</span>
          </div>
        </div>

        <Link
          href={demoHref}
          className="shrink-0 border border-[#4E2A84] bg-white px-3 py-1 text-xs font-bold text-[#4E2A84] hover:bg-[#4E2A84] hover:text-white"
        >
          Demo Preview
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
