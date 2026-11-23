"use client";

import Link from "next/link";

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function Error({ error, reset }: ErrorProps) {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-16 sm:px-6">
      <div className="border-2 border-[#14121A] bg-white p-8">
        <h1 className="font-editorial text-3xl font-bold text-[#14121A]">
          Something interrupted this page
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-[#4A4656]">
          {error.message || "An unexpected error occurred while loading Buy-U."}
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={reset}
            className="bg-[#4E2A84] px-5 py-2.5 text-sm font-bold text-white hover:bg-[#381C63] press-feedback"
          >
            Try again
          </button>
          <Link
            href="/"
            className="border-2 border-[#14121A] bg-white px-5 py-2.5 text-sm font-bold text-[#14121A] hover:bg-[#F7F7F5]"
          >
            Return home
          </Link>
        </div>
      </div>
    </div>
  );
}
