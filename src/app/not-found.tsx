import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-16 sm:px-6">
      <div className="border-2 border-[#14121A] bg-white p-8">
        <h1 className="font-editorial text-3xl font-bold text-[#14121A]">
          Listing or page not found
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-[#4A4656]">
          The item or route you requested is not available in this Buy-U catalog.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/marketplace"
            className="bg-[#4E2A84] px-5 py-2.5 text-sm font-bold text-white hover:bg-[#381C63] press-feedback"
          >
            Browse Marketplace
          </Link>
          <Link
            href="/"
            className="border-2 border-[#14121A] bg-white px-5 py-2.5 text-sm font-bold text-[#14121A] hover:bg-[#F7F7F5]"
          >
            Back to Home
          </Link>
        </div>
      </div>
    </div>
  );
}
