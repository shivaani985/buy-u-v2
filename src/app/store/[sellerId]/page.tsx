import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BadgeCheck, Star, Store } from "lucide-react";
import { PublicStorefrontActions } from "@/components/storefront/PublicStorefrontActions";
import { isValidUuid } from "@/lib/disputes/validation";
import { formatSenToRm, formatShortDate } from "@/lib/format";
import { computeRatingSummary } from "@/lib/marketplace/phase8";
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

  const [profRes, sfRes, listRes, freeRes, revRes, ordCountRes] = await Promise.all([
    service
      .from("profiles")
      .select("id,display_name,full_name,university_role,faculty,bio,status")
      .eq("id", sellerId)
      .maybeSingle(),
    service
      .from("storefronts")
      .select("seller_id,shop_name,description,logo_path")
      .eq("seller_id", sellerId)
      .maybeSingle(),
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
      .eq("status", "published")
      .limit(20),
    service
      .from("reviews")
      .select("id,buyer_id,rating,comment,hidden,created_at")
      .eq("seller_id", sellerId)
      .eq("hidden", false)
      .order("created_at", { ascending: false })
      .limit(30),
    service
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("seller_id", sellerId)
      .eq("status", "completed"),
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
  const sf = sfRes.data as { shop_name: string | null; description: string | null } | null;
  const storeName = sf?.shop_name?.trim() || prof.display_name || prof.full_name || "UMS Student Store";
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
  const reviews = (revRes.data ?? []) as Array<{
    id: string;
    rating: number;
    comment: string;
    hidden: boolean;
    created_at: string;
  }>;
  const ratingSummary = computeRatingSummary(reviews);

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
      <div className="rounded-3xl border border-[#E6E3EE] bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
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
            </div>
            <p className="max-w-2xl text-xs text-[#4A4656]">
              {sf?.description || prof.bio || "Campus student seller at Universiti Malaysia Sabah (UMSKAL)."}
            </p>
            <div className="flex flex-wrap gap-4 pt-1 text-xs font-semibold text-[#6B6779]">
              <span className="inline-flex items-center gap-1 text-[#14121A]">
                <Star className="h-3.5 w-3.5 text-amber-500" />
                {ratingSummary.averageRating !== null
                  ? `${ratingSummary.averageRating.toFixed(1)} (${ratingSummary.totalReviews} verified reviews)`
                  : "No verified reviews yet"}
              </span>
              <span>Completed Orders: {ordCountRes.count ?? 0}</span>
              {prof.faculty ? <span>Faculty: {prof.faculty}</span> : null}
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
              <div key={r.id} className="rounded-2xl border border-[#E6E3EE] bg-white p-4 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-extrabold text-amber-600">{"★".repeat(r.rating)} ({r.rating}/5)</span>
                  <span className="text-[11px] text-[#8B869B]">{formatShortDate(r.created_at)}</span>
                </div>
                <p className="mt-2 text-[#14121A]">{r.comment}</p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
