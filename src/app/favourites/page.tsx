import type { Metadata } from "next";
import Link from "next/link";
import { Heart, Lock, ShoppingBag, Wrench } from "lucide-react";
import { ListingCard } from "@/components/marketplace/ListingCard";
import { resolvePublicStorageUrl } from "@/lib/format";
import { computeRatingSummary } from "@/lib/marketplace/phase8";
import { getPublicSupabaseEnv } from "@/lib/supabase/env";
import { getSessionSummary } from "@/lib/supabase/server";
import { getServerServiceClient } from "@/lib/supabase/service";
import type { Listing, ListingType } from "@/types/marketplace";

export const metadata: Metadata = {
  title: "Favourites",
  description: "Your saved UMSKAL marketplace items, food, and student services.",
};

export const dynamic = "force-dynamic";

function mapDbKindToListingType(kind: string, isFood: boolean): ListingType {
  if (isFood) return "food";
  if (kind === "business") return "business";
  if (kind === "service") return "service";
  if (kind === "free") return "free";
  return "preloved";
}

export default async function FavouritesPage() {
  const session = await getSessionSummary();
  const userId = session.profile?.id ?? null;

  if (!session.isAuthenticated || !userId) {
    return (
      <div className="mx-auto w-full max-w-[1200px] px-4 py-8 sm:px-6 lg:px-10">
        <section className="rounded-2xl border border-[#E6E3EE] bg-white p-6 sm:p-8">
          <div className="flex items-start gap-3">
            <Lock className="mt-0.5 h-5 w-5 shrink-0 text-[#4E2A84]" aria-hidden="true" />
            <div>
              <h1 className="text-lg font-extrabold text-[#14121A]">
                Sign in to view your Favourites
              </h1>
              <p className="mt-1 text-sm text-[#6B6779]">
                Save campus items, food, and student services to find them quickly later.
              </p>
              <Link
                href="/login?next=%2Ffavourites"
                className="mt-4 inline-flex items-center rounded-xl bg-[#4E2A84] px-5 py-2.5 text-sm font-bold text-white transition hover:bg-[#3F216B]"
              >
                Sign In with UMS Email
              </Link>
            </div>
          </div>
        </section>
      </div>
    );
  }

  const service = getServerServiceClient();
  const env = getPublicSupabaseEnv();
  const listings: Listing[] = [];

  if (service) {
    const { data: favRows } = await service
      .from("favourites")
      .select("listing_id,created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(100);

    const favIds = ((favRows ?? []) as Array<{ listing_id: string }>).map(
      (f) => f.listing_id
    );

    if (favIds.length > 0) {
      const [listRes, catRes, areaRes] = await Promise.all([
        service
          .from("listings")
          .select(
            "id,title,description,kind,is_food,category_id,collection_area_id,condition,price_sen,seller_id,image_paths,published_at,created_at,status"
          )
          .in("id", favIds)
          .eq("status", "published"),
        service.from("categories").select("id,name"),
        service.from("collection_areas").select("id,name"),
      ]);

      const rawListings = (listRes.data ?? []) as Array<{
        id: string;
        title: string;
        description: string | null;
        kind: string;
        is_food: boolean | null;
        category_id: string;
        collection_area_id: string | null;
        condition: string | null;
        price_sen: number | null;
        seller_id: string;
        image_paths: string[] | null;
        published_at: string | null;
        created_at: string;
      }>;

      const listingIds = rawListings.map((r) => r.id);
      const sellerIds = Array.from(new Set(rawListings.map((r) => r.seller_id)));

      const [profRes, revRes, salesRes] = await Promise.all([
        sellerIds.length > 0
          ? service
              .from("profiles")
              .select("id,display_name,full_name,faculty")
              .in("id", sellerIds)
          : Promise.resolve({ data: [] }),
        sellerIds.length > 0
          ? service
              .from("reviews")
              .select("listing_id,seller_id,rating,hidden")
              .in("seller_id", sellerIds)
              .eq("hidden", false)
          : Promise.resolve({ data: [] }),
        listingIds.length > 0
          ? service
              .from("order_items")
              .select("listing_id,quantity,orders!inner(status)")
              .in("listing_id", listingIds)
              .in("orders.status", [
                "paid",
                "ready_for_pickup",
                "handed_over",
                "completed",
              ])
          : Promise.resolve({ data: [] }),
      ]);

      const catMap = new Map(
        ((catRes.data ?? []) as Array<{ id: string; name: string }>).map((c) => [
          c.id,
          c.name,
        ])
      );
      const areaMap = new Map(
        ((areaRes.data ?? []) as Array<{ id: string; name: string }>).map((a) => [
          a.id,
          a.name,
        ])
      );
      const sellerMap = new Map(
        (
          (profRes.data ?? []) as Array<{
            id: string;
            display_name: string | null;
            full_name: string | null;
            faculty: string | null;
          }>
        ).map((p) => [
          p.id,
          {
            name: p.display_name || p.full_name || "UMS Student",
            faculty: p.faculty ?? null,
          },
        ])
      );

      const salesCountMap = new Map<string, number>();
      for (const s of (salesRes.data ?? []) as Array<{
        listing_id: string;
        quantity: number | null;
      }>) {
        salesCountMap.set(
          s.listing_id,
          (salesCountMap.get(s.listing_id) ?? 0) +
            Math.max(1, Number(s.quantity ?? 1))
        );
      }

      const itemRevs = new Map<string, Array<{ rating: number; hidden: boolean }>>();
      const sellerRevs = new Map<string, Array<{ rating: number; hidden: boolean }>>();
      for (const rv of (revRes.data ?? []) as Array<{
        listing_id: string | null;
        seller_id: string;
        rating: number;
        hidden: boolean;
      }>) {
        if (rv.listing_id) {
          const arr = itemRevs.get(rv.listing_id) ?? [];
          arr.push(rv);
          itemRevs.set(rv.listing_id, arr);
        }
        const sArr = sellerRevs.get(rv.seller_id) ?? [];
        sArr.push(rv);
        sellerRevs.set(rv.seller_id, sArr);
      }

      const listingById = new Map(rawListings.map((r) => [r.id, r]));
      for (const id of favIds) {
        const r = listingById.get(id);
        if (!r) continue;
        const seller = sellerMap.get(r.seller_id);
        const firstImg =
          Array.isArray(r.image_paths) && r.image_paths.length > 0
            ? r.image_paths[0]
            : null;
        const salesCount = salesCountMap.get(r.id) ?? 0;
        const itemSummary = computeRatingSummary(itemRevs.get(r.id) ?? []);
        const shopSummary = computeRatingSummary(sellerRevs.get(r.seller_id) ?? []);
        const useShopRating = salesCount === 0 || itemSummary.totalReviews === 0;
        const activeSummary = useShopRating ? shopSummary : itemSummary;

        const imageUrl = env
          ? resolvePublicStorageUrl("listings", firstImg, env.url)
          : null;
        const imageUrls = env && Array.isArray(r.image_paths)
          ? r.image_paths
              .map((p) => resolvePublicStorageUrl("listings", p, env.url))
              .filter((u): u is string => Boolean(u))
          : [];

        listings.push({
          id: r.id,
          slug: r.id,
          title: r.title,
          description: r.description ?? "",
          priceSen: r.price_sen ?? 0,
          categoryId: r.category_id,
          categoryName: catMap.get(r.category_id) ?? "Campus",
          listingType: mapDbKindToListingType(r.kind, Boolean(r.is_food)),
          condition: r.condition ?? null,
          availableStock: null,
          campusArea:
            (r.collection_area_id && areaMap.get(r.collection_area_id)) ||
            "UMSKAL, Labuan",
          sellerDisplayName: seller?.name ?? "UMS Student",
          sellerBadge: seller?.faculty || "Verified Student",
          sellerFaculty: seller?.faculty ?? null,
          imageUrl,
          imageUrls,
          imageAlt: r.title,
          createdAt: r.published_at || r.created_at,
          isDemo: false,
          salesCount,
          rating: activeSummary.averageRating,
          reviewCount: activeSummary.totalReviews,
        });
      }
    }
  }

  const canFavourite = Boolean(session.isAuthenticated && session.isEmailVerified);

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-6 px-4 py-6 sm:px-6 lg:px-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-[-0.02em] text-[#14121A] sm:text-3xl">
            <Heart className="h-6 w-6 fill-[#E11D48] text-[#E11D48]" aria-hidden="true" />
            <span>My Favourites</span>
          </h1>
          <p className="mt-1 text-sm text-[#6B6779]">
            {listings.length > 0
              ? `${listings.length} saved ${listings.length === 1 ? "listing" : "listings"} across UMSKAL Marketplace.`
              : "Items, food, and student services you heart will appear here."}
          </p>
        </div>
      </div>

      {listings.length === 0 ? (
        <section className="rounded-2xl border border-[#E6E3EE] bg-white px-6 py-14 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-[#E6E3EE] bg-[#FAF9FC] text-[#E11D48]">
            <Heart className="h-6 w-6" aria-hidden="true" />
          </div>
          <h2 className="mt-4 text-lg font-bold text-[#14121A]">
            No favourites yet
          </h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-[#6B6779]">
            Tap the heart icon on any listing to save it here for quick access later.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/marketplace"
              className="inline-flex items-center gap-2 rounded-xl bg-[#4E2A84] px-5 py-2.5 text-sm font-bold text-white transition hover:bg-[#3F216B]"
            >
              <ShoppingBag className="h-4 w-4" aria-hidden="true" />
              <span>Browse Marketplace</span>
            </Link>
            <Link
              href="/services"
              className="inline-flex items-center gap-2 rounded-xl border border-[#E6E3EE] bg-white px-5 py-2.5 text-sm font-bold text-[#14121A] transition hover:border-[#4E2A84] hover:text-[#4E2A84]"
            >
              <Wrench className="h-4 w-4" aria-hidden="true" />
              <span>Campus Services</span>
            </Link>
          </div>
        </section>
      ) : (
        <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
          {listings.map((listing) => (
            <ListingCard
              key={listing.id}
              listing={listing}
              isFavourited
              canFavourite={canFavourite}
            />
          ))}
        </div>
      )}
    </div>
  );
}
