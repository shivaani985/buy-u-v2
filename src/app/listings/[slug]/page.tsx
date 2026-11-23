import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  Calendar,
  MapPin,
  MessageSquare,
  ShieldCheck,
  ShoppingBag,
  Tag,
} from "lucide-react";
import { DataSourceBanner } from "@/components/shared/DataSourceBanner";
import { getListingById } from "@/lib/catalog";
import { formatListingType, formatRm, formatShortDate } from "@/lib/format";

interface ListingDetailPageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({
  params,
}: ListingDetailPageProps): Promise<Metadata> {
  const { slug } = await params;
  const result = await getListingById(slug);
  if (!result.data) {
    return { title: "Listing Not Found" };
  }
  return {
    title: result.data.title,
    description: result.data.description,
  };
}

export default async function ListingDetailPage({
  params,
}: ListingDetailPageProps) {
  const { slug } = await params;
  const result = await getListingById(slug);

  if (!result.data) {
    notFound();
  }

  const listing = result.data;

  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-8 sm:px-6 lg:px-10 xl:px-14">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/marketplace"
          className="inline-flex items-center gap-2 text-sm font-bold text-[#14121A] hover:text-[#4E2A84]"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          <span>Back to Marketplace</span>
        </Link>

        {listing.isDemo ? (
          <span className="border border-[#1D70B8] bg-[#F3F8FC] px-3 py-1 text-xs font-bold uppercase tracking-wider text-[#14538A]">
            Explicitly Labeled Demo Listing
          </span>
        ) : null}
      </div>

      <div className="mb-6">
        <DataSourceBanner source={result.source} notice={result.notice} />
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
        {/* Visual Frame */}
        <div className="lg:col-span-7">
          <div className="aspect-[4/3] w-full border-2 border-[#14121A] bg-[#F3EEF9] flex flex-col justify-between p-6">
            {listing.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={listing.imageUrl}
                alt={listing.imageAlt}
                className="h-full w-full object-cover"
              />
            ) : (
              <>
                <div className="flex items-center justify-between gap-2">
                  <span className="bg-[#4E2A84] px-3 py-1 text-xs font-bold uppercase tracking-wider text-white">
                    {formatListingType(listing.listingType)}
                  </span>
                  <span className="border border-[#14121A] bg-white px-2.5 py-1 text-xs font-bold text-[#14121A]">
                    {listing.categoryName}
                  </span>
                </div>
                <div>
                  <p className="font-editorial text-3xl font-bold italic text-[#14121A] sm:text-4xl">
                    {listing.title}
                  </p>
                  <p className="mt-2 text-xs font-semibold uppercase tracking-wider text-[#4A4656]">
                    Image placeholder — real photos load from Supabase Storage
                    when connected
                  </p>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Details & Phase 1 Safe Controls */}
        <div className="flex flex-col justify-between border-2 border-[#14121A] bg-white p-6 sm:p-8 lg:col-span-5">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="bg-[#00A3A6] px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-[#14121A]">
                {formatListingType(listing.listingType)}
              </span>
              {listing.condition ? (
                <span className="border border-[#D9D6E2] bg-[#F7F7F5] px-2.5 py-1 text-xs font-semibold text-[#14121A]">
                  {listing.condition}
                </span>
              ) : null}
            </div>

            <h1 className="mt-4 text-2xl font-extrabold tracking-[-0.02em] text-[#14121A] sm:text-3xl">
              {listing.title}
            </h1>

            <p
              className={`tabular-price mt-3 text-3xl font-extrabold ${
                listing.priceRm <= 0 ? "text-[#007D80]" : "text-[#4E2A84]"
              }`}
            >
              {formatRm(listing.priceRm)}
            </p>

            <p className="mt-5 text-sm leading-relaxed text-[#4A4656]">
              {listing.description}
            </p>

            <dl className="mt-6 space-y-3 border-t border-[#E2E0E8] pt-5 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="inline-flex items-center gap-2 text-[#4A4656]">
                  <MapPin className="h-4 w-4 text-[#1D70B8]" aria-hidden="true" />
                  <span>Pickup Area</span>
                </dt>
                <dd className="font-semibold text-[#14121A]">
                  {listing.campusArea}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="inline-flex items-center gap-2 text-[#4A4656]">
                  <ShieldCheck
                    className="h-4 w-4 text-[#007D80]"
                    aria-hidden="true"
                  />
                  <span>Member</span>
                </dt>
                <dd className="font-semibold text-[#14121A]">
                  {listing.sellerDisplayName} ({listing.sellerBadge})
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="inline-flex items-center gap-2 text-[#4A4656]">
                  <Tag className="h-4 w-4 text-[#4E2A84]" aria-hidden="true" />
                  <span>Category</span>
                </dt>
                <dd className="font-semibold text-[#14121A]">
                  {listing.categoryName}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="inline-flex items-center gap-2 text-[#4A4656]">
                  <Calendar
                    className="h-4 w-4 text-[#4A4656]"
                    aria-hidden="true"
                  />
                  <span>Posted</span>
                </dt>
                <dd className="font-semibold text-[#14121A]">
                  {formatShortDate(listing.createdAt)}
                </dd>
              </div>
            </dl>
          </div>

          {/* Honest Disabled Commerce Actions (Phase 1 Read-Only) */}
          <div className="mt-8 border-t-2 border-[#14121A] pt-5">
            <p className="mb-3 text-xs font-semibold text-[#4A4656]">
              Phase 1 is read-only. Cart checkout (ToyyibPay FPX Sandbox),
              offers, and private chat unlock in upcoming phases.
            </p>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <button
                type="button"
                disabled
                aria-disabled="true"
                className="inline-flex items-center justify-center gap-2 whitespace-nowrap border border-[#D9D6E2] bg-[#F7F7F5] px-3 py-3 text-sm font-bold text-[#5B5668] cursor-not-allowed"
              >
                <ShoppingBag className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>Add to Cart (Phase 4)</span>
              </button>

              <button
                type="button"
                disabled
                aria-disabled="true"
                className="inline-flex items-center justify-center gap-2 whitespace-nowrap border border-[#D9D6E2] bg-[#F7F7F5] px-3 py-3 text-sm font-bold text-[#5B5668] cursor-not-allowed"
              >
                <MessageSquare className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>Message / Offer (P5)</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
