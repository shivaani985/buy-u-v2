import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Lock, LogIn, ShieldAlert, Wrench } from "lucide-react";
import type { SellerEligibilityResult } from "@/lib/seller/validation";

interface SellerGateProps {
  eligibility: Extract<SellerEligibilityResult, { eligible: false }>;
  nextPath: string;
}

export function SellerGate({ eligibility, nextPath }: SellerGateProps) {
  const isGuest = eligibility.reason === "auth_required";
  const isStaff = eligibility.reason === "staff_restricted";

  return (
    <div className="bori-container py-8 lg:py-12">
      <div className="mx-auto max-w-2xl overflow-hidden rounded-2xl border border-[#E6E3EE] bg-white shadow-[0_2px_10px_rgba(20,18,26,0.05)]">
        <div
          className={`h-1.5 w-full ${
            isStaff ? "bg-[#1D70B8]" : "bg-[#4E2A84]"
          }`}
          aria-hidden="true"
        />

        <div className="p-6 sm:p-8">
          <div className="flex flex-col items-start gap-5 sm:flex-row sm:items-center">
            <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-2xl border border-[#ECE7F6] bg-[#F8F6FD] p-2">
              <Image
                src="/images/bori/bori-services.png"
                alt="Bori campus mascot"
                fill
                sizes="80px"
                className="object-contain p-1 select-none"
              />
            </div>

            <div className="min-w-0 flex-1">
              <span
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-wider ${
                  isStaff
                    ? "bg-[#EDF5FC] text-[#1D70B8]"
                    : "bg-[#F4F1FA] text-[#4E2A84]"
                }`}
              >
                {isGuest ? (
                  <Lock className="h-3 w-3" aria-hidden="true" />
                ) : (
                  <ShieldAlert className="h-3 w-3" aria-hidden="true" />
                )}
                <span>
                  {isStaff ? "UMS Staff Access" : "Seller Eligibility"}
                </span>
              </span>

              <h1 className="mt-2 text-2xl font-extrabold italic tracking-[-0.02em] text-[#111018] sm:text-3xl">
                {eligibility.title}
              </h1>
            </div>
          </div>

          <p className="mt-4 text-sm leading-relaxed text-[#4A4656] sm:text-[15px]">
            {eligibility.message}
          </p>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            {isGuest ? (
              <Link
                href={`/login?next=${encodeURIComponent(nextPath)}`}
                className="inline-flex items-center gap-2 rounded-lg bg-[#4E2A84] px-5 py-2.5 text-sm font-bold text-white hover:bg-[#3A1E66] press-feedback"
              >
                <LogIn className="h-4 w-4" aria-hidden="true" />
                <span>Sign In with Student Email</span>
              </Link>
            ) : isStaff ? (
              <Link
                href="/marketplace?type=service"
                className="inline-flex items-center gap-2 rounded-lg bg-[#1D70B8] px-5 py-2.5 text-sm font-bold text-white hover:bg-[#155894] press-feedback"
              >
                <Wrench className="h-4 w-4" aria-hidden="true" />
                <span>Explore Student Services</span>
              </Link>
            ) : (
              <Link
                href="/account"
                className="inline-flex items-center gap-2 rounded-lg bg-[#4E2A84] px-5 py-2.5 text-sm font-bold text-white hover:bg-[#3A1E66] press-feedback"
              >
                <span>View Account Status</span>
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            )}

            <Link
              href="/marketplace"
              className="inline-flex items-center gap-2 rounded-lg border border-[#D5D1E3] bg-white px-4 py-2.5 text-sm font-bold text-[#14121A] hover:border-[#4E2A84] hover:text-[#4E2A84] press-feedback"
            >
              <span>Browse Marketplace</span>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
