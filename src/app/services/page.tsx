import type { Metadata } from "next";
import Link from "next/link";
import {
  ServicesCatalogClient,
  type ServiceCatalogCard,
} from "@/components/services/ServicesCatalogClient";
import { resolvePublicStorageUrl } from "@/lib/format";
import { loadListingRatingAndSoldMap } from "@/lib/reviews/presentation";
import { getPublicSupabaseEnv } from "@/lib/supabase/env";
import { getSessionSummary } from "@/lib/supabase/server";
import { getServerServiceClient } from "@/lib/supabase/service";

export const metadata: Metadata = {
  title: "Campus Services",
  description: "Discover student-offered tutoring, design, printing, and tech services at UMSKAL.",
};

export const dynamic = "force-dynamic";

export default async function ServicesPage() {
  const [session, service, env] = await Promise.all([
    getSessionSummary(),
    Promise.resolve(getServerServiceClient()),
    Promise.resolve(getPublicSupabaseEnv()),
  ]);

  const userId = session.profile?.id ?? null;
  const canFavourite = Boolean(
    session.isAuthenticated && session.isEmailVerified && userId
  );
  let cards: ServiceCatalogCard[] = [];
  let categories: Array<{ id: string; name: string }> = [];
  let favouritedIds: string[] = [];

  if (service) {
    const [catRes, listRes, areaRes, favRes] = await Promise.all([
      service.from("categories").select("id,name").eq("kind", "service").eq("active", true).order("sort_order"),
      service
        .from("listings")
        .select("id,title,description,category_id,collection_area_id,price_sen,service_mode,seller_id,image_paths,published_at,created_at")
        .eq("kind", "service")
        .eq("status", "published")
        .order("created_at", { ascending: false })
        .limit(60),
      service.from("collection_areas").select("id,name").eq("active", true),
      userId
        ? service.from("favourites").select("listing_id").eq("user_id", userId)
        : Promise.resolve({ data: [] }),
    ]);

    categories = (catRes.data ?? []) as Array<{ id: string; name: string }>;
    const catMap = new Map(categories.map((c) => [c.id, c.name]));
    const areaMap = new Map(
      ((areaRes.data ?? []) as Array<{ id: string; name: string }>).map((a) => [a.id, a.name])
    );
    favouritedIds = ((favRes.data ?? []) as Array<{ listing_id: string }>).map(
      (f) => f.listing_id
    );

    const rows = (listRes.data ?? []) as Array<{
      id: string;
      title: string;
      description: string;
      category_id: string;
      collection_area_id: string | null;
      price_sen: number;
      service_mode: string | null;
      seller_id: string;
      image_paths: string[] | null;
      published_at: string | null;
      created_at: string;
    }>;

    const sellerIds = Array.from(new Set(rows.map((r) => r.seller_id)));
    const [{ data: profs }, metricsMap] = await Promise.all([
      sellerIds.length
        ? service.from("profiles").select("id,display_name,full_name,faculty").in("id", sellerIds)
        : Promise.resolve({ data: [] }),
      rows.length > 0
        ? loadListingRatingAndSoldMap(
            service,
            rows.map((r) => ({ listingId: r.id, sellerId: r.seller_id }))
          )
        : Promise.resolve(new Map()),
    ]);

    const sellerMap = new Map(
      ((profs ?? []) as Array<{
        id: string;
        display_name: string | null;
        full_name: string | null;
        faculty: string | null;
      }>).map((p) => [
        p.id,
        {
          name: p.display_name || p.full_name || "UMS Student Provider",
          faculty: p.faculty ?? null,
        },
      ])
    );

    cards = rows.map((r) => {
      const metrics = metricsMap.get(r.id);
      const seller = sellerMap.get(r.seller_id);
      const imageUrls = (r.image_paths ?? [])
        .map((p) => resolvePublicStorageUrl("listings", p, env?.url))
        .filter((u): u is string => u !== null);
      return {
        id: r.id,
        slug: r.id,
        title: r.title,
        description: r.description ?? "",
        priceSen: r.price_sen ?? 0,
        listingType: "service",
        categoryId: r.category_id,
        categoryName: catMap.get(r.category_id) ?? "Campus Service",
        campusArea:
          (r.collection_area_id && areaMap.get(r.collection_area_id)) ||
          "UMSKAL, Labuan",
        condition: null,
        availableStock: null,
        imageUrl: imageUrls[0] ?? null,
        imageUrls,
        imageAlt: r.title,
        sellerDisplayName: seller?.name ?? "UMS Student Provider",
        sellerBadge: "Student",
        sellerFaculty: seller?.faculty ?? null,
        rating: metrics?.effectiveRating ?? null,
        reviewCount: metrics?.effectiveReviewCount ?? 0,
        ratingSource: metrics?.ratingSource ?? "none",
        salesCount: metrics?.totalSold ?? 0,
        createdAt: r.published_at ?? r.created_at,
        isDemo: false,
        serviceMode: r.service_mode || "in_person",
        sellerId: r.seller_id,
      };
    });
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-6 px-4 py-6 sm:px-6 lg:px-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-[-0.02em] text-[#14121A] sm:text-3xl">
            Campus Services
          </h1>
          <p className="mt-1 text-sm text-[#6B6779]">
            Book tutoring, design, printing, and peer services directly from verified UMSKAL students.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/sell?type=service"
            className="rounded-xl bg-[#4E2A84] px-3.5 py-2 text-xs font-bold text-white hover:bg-[#3F216C]"
          >
            Offer a Service
          </Link>
        </div>
      </div>

      <ServicesCatalogClient
        services={cards}
        categories={categories}
        favouritedIds={favouritedIds}
        canFavourite={canFavourite}
      />
    </div>
  );
}
