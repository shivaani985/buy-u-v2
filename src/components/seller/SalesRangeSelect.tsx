"use client";

import { useRouter } from "next/navigation";
import type { SalesRange } from "@/lib/seller/financials";

interface SalesRangeSelectProps {
  value: SalesRange;
}

export function SalesRangeSelect({ value }: SalesRangeSelectProps) {
  const router = useRouter();

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value as SalesRange;
    router.push(next === "7d" ? "/seller" : `/seller?range=${next}`, {
      scroll: false,
    });
  }

  return (
    <label className="inline-flex items-center gap-2 text-xs font-semibold text-[#555062]">
      <span className="sr-only">Select sales date range</span>
      <select
        aria-label="Sales date range"
        value={value}
        onChange={handleChange}
        className="rounded-lg border border-[#D5D1E3] bg-white px-3 py-1.5 text-xs font-semibold text-[#14121A] hover:border-[#4E2A84] focus:border-[#4E2A84] focus:outline-none"
      >
        <option value="7d">Last 7 Days</option>
        <option value="30d">Last 30 Days</option>
        <option value="all">All Time</option>
      </select>
    </label>
  );
}
