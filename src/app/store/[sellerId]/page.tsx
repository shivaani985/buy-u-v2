import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BadgeCheck, Star, Store } from "lucide-react";
import { ReviewCard } from "@/components/reviews/ReviewCard";
import { PublicStorefrontActions } from "@/components/storefront/PublicStorefrontActions";
import { isValidUuid } from "@/lib/disputes/validation";
import { formatSenToRm, resolvePublicStorageUrl } from "@/lib/format";
import { computeRatingSummary } from "@/lib/marketplace/phase8";
import {
  sanitizePublicReviewRow,
  type PublicReviewItem,
} from "@/lib/reviews/presentation";
import { REVIEW_STAR_COLOR } from "@/lib/reviews/validation";
import { formatVariationOptionLabel } from "@/lib/seller/variations";
import { getPublicSupabaseEnv } from "@/lib/supabase/env";
import { getSessionSummary } from "@/lib/supabase/server";
import { getServerServiceClient } from "@/lib/supabase/service";

export const metadata: Metadata = {
  title: "Student Storefront",
  description: "Verified UMSKAL student storefront on Buy-U.",
};

export const dynamic = "force-dynamic";

export default async function PublicStorefrontPage({
  params,
}: {
  params: Promise<{ sellerId: string }>;
}) {
  const { sellerId } = await params;
  if (!isValidUuid(sellerId)) notFound();

  const [session, service] = await Promise.all([
    getSessionSummary(),
    Promise.resolve(getServerServiceClient()),
  ]);
  if (!service) notFound();

  const env = getPublicSupabaseEnv();
  const storageBase = env?.url ?? "";

  const [profRes, sfRes, listRes, freeRes, revRes, ordCountRes] = await Promise.all([
    service
      .from("profiles")
      .select("id,display_name,full_name,university_role,faculty,bio,status")
      .eq("id", sellerId)
      .maybeSingle(),
    service
      .from("storefronts")
      .select("seller_id,shop_name,description,logo_path,banner_path,business_info,is_open")
      .eq("seller_id", sellerId)
      .maybeSingle()
      .then(async (res) => {
        if (!res.error) return res;
        return service
          .from("storefronts")
          .select("seller_id,shop_name,description,logo_path")
          .eq("seller_id", sellerId)
          .maybeSingle();
      }),
    service
      .from("listings")
      .select("id,title,kind,price_sen,quantity,reserved_quantity,status")
      .eq("seller_id", sellerId)
      .eq("status", "published")
      .order("created_at", { ascending: false })
      .limit(40),
    service
      .from("free_notices")
      .select("id,title,condition,spot_id,status")
      .eq("contributor_id", sellerId)
      .eq("status", "active")
      .limit(20),
    service
      .from("reviews")
      .select(
        "id,buyer_id,listing_id,rating,comment,seller_response,order_id,service_request_id,hidden,is_anonymous,image_paths,video_path,edited_at,created_at"
      )
      .eq("seller_id", sellerId)
      .eq("hidden", false)
      .order("created_at", { ascending: false })
      .limit(50)
      .then(async (res) => {
        if (!res.error) return res;
        return service
          .from("reviews")
          .select("id,buyer_id,listing_id,rating,comment,seller_response,order_id,service_request_id,hidden,created_at")
          .eq("seller_id", sellerId)
          .eq("hidden", false)
          .order("created_at", { ascending: false })
          .limit(50);
      }),
    service
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("seller_id", sellerId)
      .eq("status", "completed")
      .not("paid_at", "is", null),
  ]);

  if (!profRes.data) notFound();

  const prof = profRes.data as {
    id: string;
    display_name: string | null;
    full_name: string | null;
    university_role: string;
    faculty: string | null;
    bio: string | null;
    status: string;
  };
  const sf = sfRes.data as {
    shop_name: string | null;
    description: string | null;
    logo_path?: string | null;
    banner_path?: string | null;
    business_info?: string | null;
    is_open?: boolean | null;
  } | null;
  const storeName = sf?.shop_name?.trim() || prof.display_name || prof.full_name || "UMS Student Store";
  const bannerUrl =
    sf?.banner_path && storageBase
      ? resolvePublicStorageUrl("listings", sf.banner_path, storageBase)
      : null;
  const logoUrl =
    sf?.logo_path && storageBase
      ? resolvePublicStorageUrl("listings", sf.logo_path, storageBase)
      : null;
  const listings = (listRes.data ?? []) as Array<{
    id: string;
    title: string;
    kind: string;
    price_sen: number;
    quantity: number;
    reserved_quantity: number;
  }>;
  const products = listings.filter((l) => l.kind !== "service");
  const services = listings.filter((l) => l.kind === "service");
  const freeItems = (freeRes.data ?? []) as Array<{ id: string; title: string; condition: string }>;
  const rawReviews = (revRes.data ?? []) as Array<{
    id: string;
    buyer_id: string;
    listing_id?: string | null;
    rating: number;
    comment: string | null;
    seller_response?: string | null;
    order_id?: string | null;
    service_request_id?: string | null;
    hidden: boolean;
    is_anonymous?: boolean | null;
    image_paths?: string[] | null;
    video_path?: string | null;
    edited_at?: string | null;
    created_at: string;
  }>;
  const ratingSummary = computeRatingSummary(rawReviews);

  const reviewerIds = Array.from(
    new Set(rawReviews.filter((r) => !r.is_anonymous && r.buyer_id).map((r) => r.buyer_id))
  );
  const reviewOrderIds = Array.from(
    new Set(rawReviews.map((r) => r.order_id).filter((id): id is string => Boolean(id)))
  );

  const [revProfilesRes, revOrderItemsRes] = await Promise.all([
    reviewerIds.length > 0
      ? service.from("profiles").select("id,display_name,full_name,avatar_url").in("id", reviewerIds)
      : Promise.resolve({ data: [] }),
    reviewOrderIds.length > 0
      ? service
          .from("order_items")
          .select("order_id,listing_id,variant_snapshot")
          .in("order_id", reviewOrderIds)
      : Promise.resolve({ data: [] }),
  ]);

  const revProfileMap = new Map<
    string,
    { display_name: string | null; full_name: string | null; avatar_url: string | null }
  >();
  for (const p of (revProfilesRes.data ?? []) as Array<{
    id: string;
    display_name: string | null;
    full_name: string | null;
    avatar_url: string | null;
  }>) {
    revProfileMap.set(p.id, p);
  }

  const revVariantMap = new Map<string, string>();
  for (const oi of (revOrderItemsRes.data ?? []) as Array<{
    order_id: string;
    listing_id: string | null;
    variant_snapshot?: Record<string, string> | null;
  }>) {
    if (
      oi.variant_snapshot &&
      typeof oi.variant_snapshot === "object" &&
      Object.keys(oi.variant_snapshot).length > 0
    ) {
      revVariantMap.set(`${oi.order_id}:${oi.listing_id ?? ""}`, formatVariationOptionLabel(oi.variant_snapshot));
    }
  }

  const reviews: PublicReviewItem[] = rawReviews
    .map((r) =>
      sanitizePublicReviewRow({
        review: {
          ...r,
          listing_id: r.listing_id ?? null,
        },
        profile: !r.is_anonymous ? revProfileMap.get(r.buyer_id) ?? null : null,
        purchasedVariantLabel: r.order_id
          ? revVariantMap.get(`${r.order_id}:${r.listing_id ?? ""}`) ?? null
          : null,
        viewerUserId: session.profile?.id ?? null,
        storageBaseUrl: storageBase,
      })
    )
    .filter((r): r is PublicReviewItem => r !== null);

  let isBlocked = false;
  if (session.profile?.id && session.profile.id !== sellerId) {
    const { data: bRow } = await service
      .from("member_blocks")
      .select("blocked_id")
      .eq("blocker_id", session.profile.id)
      .eq("blocked_id", sellerId)
      .maybeSingle();
    isBlocked = Boolean(bRow);
  }

  return (
    <div className="mx-auto w-full max-w-[1160px] space-y-6 px-4 py-6 sm:px-6 lg:px-10">
      {/* Header Banner */}
      <div className="overflow-hidden rounded-3xl border border-[#E6E3EE] bg-white">
        {bannerUrl ? (
          <div className="h-36 w-full bg-[#F3EEFA] sm:h-44">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={bannerUrl} alt={`${storeName} banner`} className="h-full w-full object-cover" />
          </div>
        ) : (
          <div className="h-2.5 w-full bg-[#4E2A84]" aria-hidden="true" />
        )}
        <div className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            {logoUrl ? (
              <div className="h-14 w-14 shrink-0 overflow-hidden rounded-2xl border border-[#E6E3EE] bg-[#FAF9FC]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={logoUrl} alt={`${storeName} logo`} className="h-full w-full object-cover" />
              </div>
            ) : null}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Store className="h-5 w-5 text-[#4E2A84]" />
              <h1 className="text-2xl font-extrabold text-[#14121A]">{storeName}</h1>
              {prof.university_role === "student" ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-[#E6F6F6] px-2.5 py-0.5 text-[11px] font-bold text-[#006A6D]">
                  <BadgeCheck className="h-3.5 w-3.5" />
                  Verified UMS Student
                </span>
              ) : null}
              {sf?.is_open === false ? (
                <span className="rounded-full bg-[#FEF2F2] px-2.5 py-0.5 text-[11px] font-bold text-[#B42318]">
                  Temporarily Closed
                </span>
              ) : null}
            </div>
            <p className="max-w-2xl text-xs text-[#4A4656]">
              {sf?.description || prof.bio || "Campus student seller at Universiti Malaysia Sabah (UMSKAL)."}
            </p>
            {sf?.business_info ? (
              <p className="max-w-2xl text-xs font-semibold text-[#4E2A84]">
                {sf.business_info}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-4 pt-1 text-xs font-semibold text-[#6B6779]">
              <span className="inline-flex items-center gap-1 text-[#14121A]">
                <Star
                  className="h-3.5 w-3.5"
                  style={
                    ratingSummary.averageRating !== null
                      ? { color: REVIEW_STAR_COLOR, fill: REVIEW_STAR_COLOR }
                      : { color: "#C5C1D0" }
                  }
                />
                {ratingSummary.averageRating !== null
                  ? `${ratingSummary.averageRating.toFixed(1)} (${ratingSummary.totalReviews} verified reviews)`
                  : "Not rated yet"}
              </span>
              <span>Completed Orders: {ordCountRes.count ?? 0}</span>
              {prof.faculty ? <span>Faculty: {prof.faculty}</span> : null}
            </div>
          </div>
          </div>

          <PublicStorefrontActions
            sellerId={sellerId}
            sellerName={storeName}
            initialBlocked={isBlocked}
            canInteract={Boolean(session.isAuthenticated && session.profile?.id && session.profile.id !== sellerId)}
          />
        </div>
        </div>
      </div>

      {/* Products */}
      <section className="space-y-3">
        <h2 className="text-base font-extrabold text-[#14121A]">Products ({products.length})</h2>
        {products.length === 0 ? (
          <p className="rounded-2xl border border-[#E6E3EE] bg-white p-6 text-xs text-[#6B6779]">No published products.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {products.map((p) => (
              <Link
                key={p.id}
                href={`/listing/${p.id}`}
                className="rounded-2xl border border-[#E6E3EE] bg-white p-4 hover:border-[#4E2A84]"
              >
                <p className="truncate text-sm font-bold text-[#14121A]">{p.title}</p>
                <p className="mt-1 text-sm font-extrabold text-[#4E2A84]">{formatSenToRm(p.price_sen)}</p>
                <p className="mt-1 text-[11px] text-[#6B6779]">
                  {Math.max(0, p.quantity - p.reserved_quantity)} in stock
                </p>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Services & Free Items */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-3">
          <h2 className="text-base font-extrabold text-[#14121A]">Services ({services.length})</h2>
          {services.length === 0 ? (
            <p className="rounded-2xl border border-[#E6E3EE] bg-white p-5 text-xs text-[#6B6779]">No active services.</p>
          ) : (
            services.map((s) => (
              <Link key={s.id} href={`/services`} className="block rounded-2xl border border-[#E6E3EE] bg-white p-4 text-xs hover:border-[#4E2A84]">
                <p className="font-bold text-[#14121A]">{s.title}</p>
                <p className="mt-0.5 font-extrabold text-[#008285]">{formatSenToRm(s.price_sen)}</p>
              </Link>
            ))
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-extrabold text-[#14121A]">Community Free Items ({freeItems.length})</h2>
          {freeItems.length === 0 ? (
            <p className="rounded-2xl border border-[#E6E3EE] bg-white p-5 text-xs text-[#6B6779]">No active free donations.</p>
          ) : (
            freeItems.map((f) => (
              <Link key={f.id} href="/free-items" className="block rounded-2xl border border-[#E6E3EE] bg-white p-4 text-xs hover:border-[#008285]">
                <p className="font-bold text-[#14121A]">{f.title}</p>
                <p className="mt-0.5 text-[#006A6D]">FREE · {f.condition}</p>
              </Link>
            ))
          )}
        </section>
      </div>

      {/* Verified Reviews */}
      <section className="space-y-3">
        <h2 className="text-base font-extrabold text-[#14121A]">
          Verified Reviews ({ratingSummary.totalReviews})
        </h2>
        {reviews.length === 0 ? (
          <p className="rounded-2xl border border-[#E6E3EE] bg-white p-6 text-xs text-[#6B6779]">
            No verified purchase or service reviews yet.
          </p>
        ) : (
          <div className="space-y-3">
            {reviews.map((r) => (
              <ReviewCard key={r.id} review={r} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
