import Image from "next/image";
import Link from "next/link";

interface SiteFooterProps {
  dataSource: "supabase" | "unconfigured";
}

export function SiteFooter({ dataSource }: SiteFooterProps) {
  return (
    <footer className="mt-8 border-t border-[#2E2A3B] bg-[#14121A] text-white">
      <div className="bori-container py-10">
        <div className="grid gap-10 md:grid-cols-3">
          <div>
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white p-1 shadow-sm">
                <Image
                  src="/images/logo/buyu-logo.png"
                  alt="Buy-U Logo"
                  width={40}
                  height={45}
                  className="h-9 w-auto object-contain"
                />
              </div>
              <span className="text-lg font-extrabold tracking-tight text-white">
                Buy-U <span className="text-xs font-semibold text-[#00A3A6]">v2</span>
              </span>
            </div>
            <p className="mt-3 max-w-sm text-sm leading-relaxed text-[#D9D6E2]">
              A community-based university marketplace for Universiti Malaysia
              Sabah (UMSKAL, Labuan) students and staff to trade pre-loved
              items, student ventures, campus services, and free giveaways.
            </p>
          </div>

          <div>
            <h2 className="text-sm font-bold uppercase tracking-wider text-[#00A3A6]">
              Explore Campus
            </h2>
            <ul className="mt-3 space-y-2 text-sm text-[#D9D6E2]">
              <li>
                <Link href="/marketplace" className="hover:text-white underline-offset-4 hover:underline">
                  All Marketplace Listings
                </Link>
              </li>
              <li>
                <Link
                  href="/marketplace?type=service"
                  className="hover:text-white underline-offset-4 hover:underline"
                >
                  Student Services
                </Link>
              </li>
              <li>
                <Link
                  href="/marketplace?type=free"
                  className="hover:text-white underline-offset-4 hover:underline"
                >
                  Free Items & Share Spots
                </Link>
              </li>
              <li>
                <Link href="/account" className="hover:text-white underline-offset-4 hover:underline">
                  Account & UMS Verification Roadmap
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <h2 className="text-sm font-bold uppercase tracking-wider text-[#00A3A6]">
              Phase 1 Status
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-[#D9D6E2]">
              Read-only foundation build. Purchasing, chat, offers, and seller
              dashboards are scheduled for subsequent phases.
            </p>
            <div className="mt-4 inline-flex items-center gap-2 border border-[#4E2A84] bg-[#24173B] px-3 py-1.5 text-xs font-semibold text-white">
              <span
                className={`h-2 w-2 ${
                  dataSource === "supabase" ? "bg-[#00A3A6]" : "bg-[#1D70B8]"
                }`}
                aria-hidden="true"
              />
              <span>
                Catalog Source:{" "}
                {dataSource === "supabase"
                  ? "Supabase (Read-Only)"
                  : "Demo Data (Offline Safe)"}
              </span>
            </div>
          </div>
        </div>

        <div className="mt-10 flex flex-col gap-2 border-t border-[#2E2A3B] pt-6 text-xs text-[#B5B0C4] sm:flex-row sm:items-center sm:justify-between">
          <p>
            Buy-U Final Year Project — Universiti Malaysia Sabah, Kampus
            Antarabangsa Labuan (UMSKAL).
          </p>
          <p>Student-led academic project. Not an official UMS commercial portal.</p>
        </div>
      </div>
    </footer>
  );
}
