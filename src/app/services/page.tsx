import type { Metadata } from "next";
import Link from "next/link";
import {
  ServicesCatalogClient,
  type ServiceCatalogCard,
} from "@/components/services/ServicesCatalogClient";
import { evaluateBuyerEligibility } from "@/lib/buyer/validation";
import { resolvePublicStorageUrl } from "@/lib/format";
import { computeRatingSummary } from "@/lib/marketplace/phase8";
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

  const eligibility = evaluateBuyerEligibility(session);
  let cards: ServiceCatalogCard[] = [];
  let categories: Array<{ id: string; name: string }> = [];

  if (service) {
    const [catRes, listRes, revRes] = await Promise.all([
      service.from("categories").select("id,name").eq("kind", "service").eq("active", true).order("sort_order"),
      service
        .from("listings")
        .select("id,title,description,category_id,price_sen,service_mode,accepting_requests,limitations,seller_id,image_paths")
        .eq("kind", "service")
        .eq("status", "published")
        .order("created_at", { ascending: false })
        .limit(60),
      service.from("reviews").select("seller_id,rating,hidden").eq("hidden", false),
    ]);

    categories = (catRes.data ?? []) as Array<{ id: string; name: string }>;
    const catMap = new Map(categories.map((c) => [c.id, c.name]));
    const rows = (listRes.data ?? []) as Array<{
      id: string;
      title: string;
      description: string;
      category_id: string;
      price_sen: number;
      service_mode: string | null;
      accepting_requests: boolean | null;
      limitations: string | null;
      seller_id: string;
      image_paths: string[] | null;
    }>;

    const sellerIds = Array.from(new Set(rows.map((r) => r.seller_id)));
    const { data: profs } = sellerIds.length
      ? await service.from("profiles").select("id,display_name,full_name").in("id", sellerIds)
      : { data: [] };
    const sellerMap = new Map(
      ((profs ?? []) as Array<{ id: string; display_name: string | null; full_name: string | null }>).map((p) => [
        p.id,
        p.display_name || p.full_name || "UMS Student Provider",
      ])
    );

    const revsBySeller = new Map<string, Array<{ rating: number; hidden: boolean }>>();
    for (const r of (revRes.data ?? []) as Array<{ seller_id: string; rating: number; hidden: boolean }>) {
      const arr = revsBySeller.get(r.seller_id) ?? [];
      arr.push(r);
      revsBySeller.set(r.seller_id, arr);
    }

    cards = rows.map((r) => {
      const rs = computeRatingSummary(revsBySeller.get(r.seller_id) ?? []);
      return {
        id: r.id,
        title: r.title,
        description: r.description,
        categoryId: r.category_id,
        categoryName: catMap.get(r.category_id) ?? "Campus Service",
        priceSen: r.price_sen ?? 0,
        serviceMode: r.service_mode || "in_person",
        acceptingRequests: r.accepting_requests !== false,
        limitations: r.limitations ?? "",
        sellerId: r.seller_id,
        sellerName: sellerMap.get(r.seller_id) ?? "UMS Student Provider",
        averageRating: rs.averageRating,
        reviewCount: rs.totalReviews,
        imageUrl: resolvePublicStorageUrl("listings", r.image_paths?.[0] ?? null, env?.url),
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
            Request tutoring, design, printing, and peer services directly from verified UMSKAL students.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/requests"
            className="rounded-xl border border-[#4E2A84] px-3.5 py-2 text-xs font-bold text-[#4E2A84] hover:bg-[#F3EEFA]"
          >
            My Service Requests
          </Link>
          <Link
            href="/sell"
            className="rounded-xl bg-[#4E2A84] px-3.5 py-2 text-xs font-bold text-white hover:bg-[#3F216C]"
          >
            Offer a Service
          </Link>
        </div>
      </div>

      <ServicesCatalogClient
        services={cards}
        categories={categories}
        canRequest={eligibility.eligible}
        currentUserId={session.profile?.id ?? null}
      />
    </div>
  );
}
