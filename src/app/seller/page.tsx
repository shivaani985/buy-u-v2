import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  Clock,
  ExternalLink,
  Landmark,
  MapPin,
  Package,
  PlusCircle,
  ShieldCheck,
  Store,
} from "lucide-react";
import { initializeStorefrontAction } from "@/app/seller/actions";
import { SellerGate } from "@/components/seller/SellerGate";
import { SellerNav } from "@/components/seller/SellerNav";
import { ListingImage } from "@/components/shared/ListingImage";
import { formatRelativeTime, formatSenToRm } from "@/lib/format";
import { getSellerHubData } from "@/lib/seller/data";
import { evaluateSellerEligibility } from "@/lib/seller/validation";
import { getSessionSummary } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Seller Hub",
  description:
    "Manage your UMS campus storefront, listings, drafts, and payout setup status on Buy-U.",
};

function statusBadgeStyle(status: string, availableStock: number, kind: string) {
  if (status === "published" && kind !== "service" && availableStock === 0) {
    return { label: "Out of stock", cls: "bg-[#FDF2F2] text-[#BA1A1A] border-[#F8D4D4]" };
  }
  if (status === "published") {
    return { label: "Published", cls: "bg-[#EDFAF9] text-[#008386] border-[#CBECEB]" };
  }
  if (status === "draft") {
    return { label: "Draft", cls: "bg-[#F4F1FA] text-[#4E2A84] border-[#E4DCF4]" };
  }
  return { label: status, cls: "bg-[#F3F2F6] text-[#555062] border-[#E4E1EE]" };
}

export default async function SellerHubPage() {
  const session = await getSessionSummary();
  const eligibility = evaluateSellerEligibility(session);

  if (!eligibility.eligible) {
    return <SellerGate eligibility={eligibility} nextPath="/seller" />;
  }

  const hub = await getSellerHubData(session);
  const displayName =
    session.profile?.display_name ||
    session.profile?.full_name ||
    session.email?.split("@")[0] ||
    "UMS Student";
  const shopInitials = (hub.storefront?.shopName || displayName)
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const stats = [
    {
      label: "Total Listings",
      value: hub.counts.total,
      accent: "bg-[#F8F6FD] border-[#ECE7F6] text-[#4E2A84]",
    },
    {
      label: "Published Live",
      value: hub.counts.published,
      accent: "bg-[#F2FAFA] border-[#DDF2F2] text-[#008386]",
    },
    {
      label: "Saved Drafts",
      value: hub.counts.draft,
      accent: "bg-[#F2F7FC] border-[#DEECF8] text-[#1D70B8]",
    },
    {
      label: "Out of Stock",
      value: hub.counts.soldOut,
      accent: "bg-[#FAF9FC] border-[#E6E3EE] text-[#14121A]",
    },
  ];

  return (
    <div className="bg-white">
      <div className="bori-container py-6 lg:py-8">
        {/* Top Editorial Header */}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-3xl font-extrabold italic tracking-[-0.02em] text-[#111018] sm:text-[36px]">
                Seller{" "}
                <span className="inline-block bg-[#4E2A84] px-3 py-0.5 text-white hero-marketplace-slab">
                  Hub
                </span>
              </h1>
            </div>
            <p className="mt-1.5 text-sm text-[#555062]">
              Signed in as{" "}
              <span className="font-bold text-[#14121A]">{displayName}</span> ·
              Verified UMS Student Seller
            </p>
          </div>

          <Link
            href="/sell"
            className="inline-flex items-center gap-2 rounded-xl bg-[#4E2A84] px-5 py-2.5 text-sm font-bold text-white shadow-[0_2px_8px_rgba(78,42,132,0.22)] hover:bg-[#3A1E66] press-feedback"
          >
            <PlusCircle className="h-4 w-4" aria-hidden="true" />
            <span>Create Listing</span>
          </Link>
        </div>

        {/* Shared Seller Navigation */}
        <div className="mt-5">
          <SellerNav />
        </div>

        {hub.error ? (
          <div
            role="alert"
            className="mt-5 rounded-xl border border-[#BA1A1A]/30 bg-[#FDF2F2] px-4 py-3 text-sm text-[#BA1A1A]"
          >
            {hub.error}
          </div>
        ) : null}

        {/* Real Listing Count Metrics */}
        <section
          aria-label="Listing statistics"
          className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4"
        >
          {stats.map((stat) => (
            <div
              key={stat.label}
              className={`rounded-2xl border p-4 ${stat.accent}`}
            >
              <p className="text-xs font-bold uppercase tracking-wider opacity-80">
                {stat.label}
              </p>
              <p className="mt-1.5 text-3xl font-extrabold tracking-tight">
                {stat.value}
              </p>
            </div>
          ))}
        </section>

        {/* Main 2-Column Workspace */}
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* LEFT: Listings Overview */}
          <section
            aria-labelledby="seller-listings-heading"
            className="lg:col-span-8"
          >
            <div className="flex items-center justify-between border-b border-[#E6E3EE] pb-2.5">
              <h2
                id="seller-listings-heading"
                className="text-lg font-extrabold italic tracking-[-0.02em] text-[#111018] sm:text-xl"
              >
                Your Campus Listings
              </h2>
              <Link
                href="/sell"
                className="inline-flex items-center gap-1 text-xs font-bold text-[#4E2A84] hover:underline sm:text-sm"
              >
                <span>New Listing</span>
                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </div>

            {hub.listings.length === 0 ? (
              <div className="mt-4 flex flex-col items-center gap-4 rounded-2xl border border-[#E6E3EE] bg-[#FAF9FC] p-6 text-center sm:flex-row sm:text-left">
                <div className="relative h-24 w-24 shrink-0">
                  <Image
                    src="/images/bori/bori-free-items.png"
                    alt="Bori holding a campus box"
                    fill
                    sizes="96px"
                    className="object-contain select-none"
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-base font-extrabold text-[#14121A]">
                    No listings yet
                  </h3>
                  <p className="mt-1 text-sm text-[#555062]">
                    List pre-loved textbooks, electronics, student business
                    products, campus food, or student services for fellow UMS
                    members.
                  </p>
                  <div className="mt-3.5 flex flex-wrap justify-center gap-2.5 sm:justify-start">
                    <Link
                      href="/sell"
                      className="inline-flex items-center gap-1.5 rounded-lg bg-[#4E2A84] px-4 py-2 text-xs font-bold text-white hover:bg-[#3A1E66] press-feedback sm:text-sm"
                    >
                      <PlusCircle className="h-4 w-4" aria-hidden="true" />
                      <span>Create Your First Listing</span>
                    </Link>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                {hub.listings.map((item) => {
                  const badge = statusBadgeStyle(
                    item.status,
                    item.availableStock,
                    item.kind
                  );
                  const fallback = (
                    <div className="flex h-full w-full items-center justify-center bg-[#F4F1FA] text-[#4E2A84]">
                      <Package className="h-5 w-5" aria-hidden="true" />
                    </div>
                  );
                  return (
                    <article
                      key={item.id}
                      className="flex flex-col gap-3 rounded-2xl border border-[#E6E3EE] bg-white p-3.5 shadow-[0_1px_4px_rgba(20,18,26,0.04)] transition-colors hover:border-[#4E2A84]/40 sm:flex-row sm:items-center"
                    >
                      <div className="relative h-20 w-full shrink-0 overflow-hidden rounded-xl bg-[#F5F4F8] sm:w-24">
                        <ListingImage
                          src={item.imageUrl}
                          alt={item.title}
                          fallback={fallback}
                        />
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`inline-block rounded-md border px-2 py-0.5 text-[10.5px] font-extrabold uppercase tracking-wide ${badge.cls}`}
                          >
                            {badge.label}
                          </span>
                          <span className="rounded-md bg-[#F4F1FA] px-2 py-0.5 text-[10.5px] font-bold text-[#4E2A84]">
                            {item.categoryName}
                          </span>
                        </div>

                        <h3 className="mt-1.5 truncate text-[15px] font-extrabold text-[#14121A]">
                          {item.title}
                        </h3>

                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#6E6A7C]">
                          <span className="font-extrabold text-[#14121A]">
                            {formatSenToRm(item.priceSen)}
                          </span>
                          {item.kind !== "service" ? (
                            <span>
                              Stock: {item.availableStock}/{item.quantity}
                            </span>
                          ) : null}
                          <span className="inline-flex items-center gap-1">
                            <MapPin className="h-3 w-3 text-[#8E899E]" aria-hidden="true" />
                            {item.collectionAreaName}
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <Clock className="h-3 w-3 text-[#8E899E]" aria-hidden="true" />
                            {formatRelativeTime(item.updatedAt)}
                          </span>
                        </div>
                      </div>

                      {item.status === "published" ? (
                        <Link
                          href={`/listings/${encodeURIComponent(item.id)}`}
                          className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-[#D5D1E3] bg-white px-3 py-1.5 text-xs font-bold text-[#14121A] hover:border-[#4E2A84] hover:text-[#4E2A84]"
                        >
                          <span>View Live</span>
                          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                        </Link>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          {/* RIGHT: Storefront Summary & Payout Setup Status */}
          <aside className="space-y-5 lg:col-span-4">
            {/* Storefront Summary Card */}
            <section
              aria-labelledby="storefront-summary-heading"
              className="rounded-2xl border border-[#E6E3EE] bg-white p-5 shadow-[0_2px_8px_rgba(20,18,26,0.04)]"
            >
              <div className="flex items-center justify-between">
                <h2
                  id="storefront-summary-heading"
                  className="flex items-center gap-2 text-base font-extrabold text-[#14121A]"
                >
                  <Store className="h-4 w-4 text-[#4E2A84]" aria-hidden="true" />
                  <span>Storefront</span>
                </h2>
                {hub.storefront ? (
                  <span className="rounded-md bg-[#EDFAF9] px-2 py-0.5 text-[10.5px] font-bold text-[#008386]">
                    Active
                  </span>
                ) : (
                  <span className="rounded-md bg-[#F4F1FA] px-2 py-0.5 text-[10.5px] font-bold text-[#4E2A84]">
                    Not Initialized
                  </span>
                )}
              </div>

              {hub.storefront ? (
                <div className="mt-4">
                  <div className="flex items-center gap-3">
                    {hub.storefront.logoUrl ? (
                      <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-xl border border-[#E6E3EE] bg-[#FAF9FC]">
                        <Image
                          src={hub.storefront.logoUrl}
                          alt={hub.storefront.shopName}
                          fill
                          sizes="48px"
                          className="object-cover"
                        />
                      </div>
                    ) : (
                      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[#4E2A84] text-sm font-extrabold text-white">
                        {shopInitials}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-extrabold text-[#14121A]">
                        {hub.storefront.shopName}
                      </p>
                      <p className="text-xs text-[#6E6A7C]">
                        {session.profile?.faculty || "UMSKAL Student Seller"}
                      </p>
                    </div>
                  </div>

                  <p className="mt-3 line-clamp-3 text-xs leading-relaxed text-[#555062]">
                    {hub.storefront.description ||
                      "Add a short storefront bio so campus buyers know what you sell and where you meet."}
                  </p>

                  <Link
                    href="/seller/storefront"
                    className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-[#4E2A84] bg-white px-4 py-2 text-xs font-bold text-[#4E2A84] hover:bg-[#4E2A84] hover:text-white press-feedback"
                  >
                    <span>Edit Storefront &amp; Preview</span>
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </Link>
                </div>
              ) : (
                <div className="mt-3">
                  <p className="text-xs leading-relaxed text-[#555062]">
                    Your student storefront will be initialized automatically
                    when you click below or create your first listing. One
                    storefront per verified student account.
                  </p>
                  <form action={initializeStorefrontAction} className="mt-4">
                    <button
                      type="submit"
                      className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-[#4E2A84] px-4 py-2.5 text-xs font-bold text-white hover:bg-[#3A1E66] press-feedback"
                    >
                      <Store className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Initialize My Storefront</span>
                    </button>
                  </form>
                </div>
              )}
            </section>

            {/* Payout Setup Status Card (Private / Masked Only) */}
            <section
              aria-labelledby="payout-status-heading"
              className="rounded-2xl border border-[#E6E3EE] bg-white p-5 shadow-[0_2px_8px_rgba(20,18,26,0.04)]"
            >
              <div className="flex items-center justify-between">
                <h2
                  id="payout-status-heading"
                  className="flex items-center gap-2 text-base font-extrabold text-[#14121A]"
                >
                  <Landmark
                    className="h-4 w-4 text-[#008386]"
                    aria-hidden="true"
                  />
                  <span>Payout Setup</span>
                </h2>
                {hub.payout.configured ? (
                  <span className="inline-flex items-center gap-1 rounded-md bg-[#EDFAF9] px-2 py-0.5 text-[10.5px] font-bold text-[#008386]">
                    <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                    <span>Configured</span>
                  </span>
                ) : (
                  <span className="rounded-md bg-[#F3F2F6] px-2 py-0.5 text-[10.5px] font-bold text-[#555062]">
                    Not Set Up
                  </span>
                )}
              </div>

              {hub.payout.configured ? (
                <dl className="mt-3.5 space-y-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-[#6E6A7C]">Bank</dt>
                    <dd className="font-bold text-[#14121A]">
                      {hub.payout.bankName}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-[#6E6A7C]">Account</dt>
                    <dd className="font-mono font-bold text-[#14121A]">
                      {hub.payout.maskedAccountNumber}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-[#6E6A7C]">DuitNow</dt>
                    <dd className="font-semibold text-[#008386]">
                      {hub.payout.hasDuitNow ? "Linked (Private)" : "Not linked"}
                    </dd>
                  </div>
                </dl>
              ) : (
                <p className="mt-3 text-xs leading-relaxed text-[#555062]">
                  No payout bank account is linked yet. You can still draft and
                  publish campus listings now; payout details remain private and
                  will be managed in the upcoming payments workflow.
                </p>
              )}

              <div className="mt-4 flex items-start gap-2 rounded-xl bg-[#FAF9FC] p-2.5 text-[11px] text-[#6E6A7C]">
                <ShieldCheck
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#4E2A84]"
                  aria-hidden="true"
                />
                <span>
                  Sensitive bank details are masked and protected by row-level
                  security. Never shared publicly.
                </span>
              </div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
