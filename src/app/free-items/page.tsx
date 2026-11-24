import type { Metadata } from "next";
import {
  FreeItemsClient,
  type FreeClaimView,
  type FreeNoticeCard,
} from "@/components/free-items/FreeItemsClient";
import { evaluateBuyerEligibility } from "@/lib/buyer/validation";
import { resolvePublicStorageUrl } from "@/lib/format";
import { computeCommunityImpact } from "@/lib/marketplace/phase8";
import { evaluateSellerEligibility } from "@/lib/seller/validation";
import { getPublicSupabaseEnv } from "@/lib/supabase/env";
import { getSessionSummary } from "@/lib/supabase/server";
import { getServerServiceClient } from "@/lib/supabase/service";

export const metadata: Metadata = {
  title: "Free Items & Community Donations",
  description: "Share and claim free campus essentials across UMSKAL donation spots.",
};

export const dynamic = "force-dynamic";

function isNoticeUnexpired(expiresAt?: string | null): boolean {
  if (!expiresAt) return true;
  const ms = Date.parse(expiresAt);
  if (Number.isNaN(ms)) return true;
  return ms > Date.now();
}

export default async function FreeItemsPage() {
  const session = await getSessionSummary();
  const buyerElig = evaluateBuyerEligibility(session);
  const sellerElig = evaluateSellerEligibility(session);
  const uid = session.profile?.id ?? null;
  const service = getServerServiceClient();
  const env = getPublicSupabaseEnv();
  const storageBase = env?.url ?? "";

  let notices: FreeNoticeCard[] = [];
  let drafts: FreeNoticeCard[] = [];
  let claims: FreeClaimView[] = [];
  let spots: Array<{
    id: string;
    name: string;
    description: string | null;
    operatingInfo: string | null;
    safetyNote: string | null;
  }> = [];
  let categories: Array<{ id: string; name: string }> = [];
  let impact = computeCommunityImpact({ notices: [], claims: [] });

  if (service) {
    const [spotRes, catRes, allNoticeRes, allClaimRes, draftsRes] = await Promise.all([
      service
        .from("donation_spots")
        .select("id,name,description,operating_info,safety_note,active")
        .eq("active", true)
        .then(async (res) => {
          if (!res.error) return res;
          return service.from("donation_spots").select("id,name,active").eq("active", true);
        }),
      service
        .from("categories")
        .select("id,name")
        .eq("kind", "product")
        .eq("active", true)
        .order("sort_order"),
      service
        .from("free_notices")
        .select(
          "id,contributor_id,title,description,condition,spot_id,quantity,reserved_quantity,category_id,collection_instructions,image_paths,status,expires_at,created_at"
        )
        .order("created_at", { ascending: false })
        .limit(100)
        .then(async (res) => {
          if (!res.error) return res;
          return service
            .from("free_notices")
            .select(
              "id,contributor_id,title,description,condition,spot_id,image_paths,status,expires_at,created_at"
            )
            .order("created_at", { ascending: false })
            .limit(100);
        }),
      service
        .from("free_notice_claims")
        .select("id,claim_code,notice_id,donor_id,recipient_id,quantity,note,status")
        .order("created_at", { ascending: false })
        .limit(100),
      uid
        ? service
            .from("free_notice_drafts")
            .select(
              "id,contributor_id,title,description,condition,quantity,spot_id,category_id,collection_instructions,image_paths,updated_at"
            )
            .eq("contributor_id", uid)
            .order("updated_at", { ascending: false })
            .limit(20)
        : Promise.resolve({ data: [], error: null }),
    ]);

    spots = (
      (spotRes.data ?? []) as Array<{
        id: string;
        name: string;
        description?: string | null;
        operating_info?: string | null;
        safety_note?: string | null;
      }>
    ).map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description ?? null,
      operatingInfo: s.operating_info ?? null,
      safetyNote: s.safety_note ?? null,
    }));
    const spotMap = new Map(spots.map((s) => [s.id, s.name]));
    categories = (catRes.data ?? []) as Array<{ id: string; name: string }>;

    const rawNotices = (allNoticeRes.data ?? []) as Array<{
      id: string;
      contributor_id: string;
      title: string;
      description: string;
      condition: string;
      spot_id: string;
      quantity?: number | null;
      reserved_quantity?: number | null;
      category_id?: string | null;
      collection_instructions?: string | null;
      image_paths?: string[] | null;
      status: string;
      expires_at?: string | null;
    }>;

    const rawClaims = (allClaimRes.error ? [] : (allClaimRes.data ?? [])) as Array<{
      id: string;
      claim_code: string;
      notice_id: string;
      donor_id: string;
      recipient_id: string;
      quantity: number;
      note: string | null;
      status: string;
    }>;

    impact = computeCommunityImpact({
      notices: rawNotices.map((n) => ({ id: n.id, status: n.status, spot_id: n.spot_id })),
      claims: rawClaims,
    });

    const userIds = Array.from(
      new Set([
        ...rawNotices.map((n) => n.contributor_id),
        ...rawClaims.flatMap((c) => [c.donor_id, c.recipient_id]),
      ])
    );
    const { data: profs } = userIds.length
      ? await service.from("profiles").select("id,display_name,full_name").in("id", userIds)
      : { data: [] };
    const nameMap = new Map(
      ((profs ?? []) as Array<{ id: string; display_name: string | null; full_name: string | null }>).map((p) => [
        p.id,
        p.display_name || p.full_name || "UMS Member",
      ])
    );
    const noticeTitleMap = new Map(rawNotices.map((n) => [n.id, n.title]));

    notices = rawNotices
      .filter((n) => n.status === "active" && isNoticeUnexpired(n.expires_at))
      .map((n) => {
        const imgs = Array.isArray(n.image_paths) ? n.image_paths.filter(Boolean) : [];
        return {
          id: n.id,
          title: n.title,
          description: n.description,
          condition: n.condition || "Good",
          quantity: Number(n.quantity ?? 1),
          reservedQuantity: Number(n.reserved_quantity ?? 0),
          spotId: n.spot_id,
          spotName: spotMap.get(n.spot_id) ?? n.spot_id,
          categoryId: n.category_id ?? null,
          collectionInstructions: n.collection_instructions ?? null,
          imagePaths: imgs,
          imageUrl:
            imgs[0] && storageBase
              ? resolvePublicStorageUrl("free-items", imgs[0], storageBase)
              : null,
          status: n.status,
          contributorId: n.contributor_id,
          donorName: nameMap.get(n.contributor_id) ?? "UMS Student",
        };
      });

    const rawDrafts = (draftsRes.error ? [] : (draftsRes.data ?? [])) as Array<{
      id: string;
      contributor_id: string;
      title: string;
      description: string;
      condition: string;
      quantity: number;
      spot_id: string | null;
      category_id: string | null;
      collection_instructions: string | null;
      image_paths: string[] | null;
    }>;

    drafts = rawDrafts.map((d) => {
      const imgs = Array.isArray(d.image_paths) ? d.image_paths.filter(Boolean) : [];
      return {
        id: d.id,
        title: d.title || "Untitled Draft",
        description: d.description || "",
        condition: d.condition || "Good",
        quantity: Number(d.quantity ?? 1),
        reservedQuantity: 0,
        spotId: d.spot_id ?? spots[0]?.id ?? "blok-alpha",
        spotName: d.spot_id ? (spotMap.get(d.spot_id) ?? d.spot_id) : "Unassigned Spot",
        categoryId: d.category_id ?? null,
        collectionInstructions: d.collection_instructions ?? null,
        imagePaths: imgs,
        imageUrl:
          imgs[0] && storageBase
            ? resolvePublicStorageUrl("free-items", imgs[0], storageBase)
            : null,
        status: "draft",
        contributorId: d.contributor_id,
        donorName: "You",
      };
    });

    claims = uid
      ? rawClaims
          .filter((c) => c.donor_id === uid || c.recipient_id === uid)
          .map((c) => ({
            id: c.id,
            claimCode: c.claim_code,
            noticeTitle: noticeTitleMap.get(c.notice_id) ?? "Free Item",
            donorId: c.donor_id,
            recipientId: c.recipient_id,
            counterpartyName:
              nameMap.get(c.donor_id === uid ? c.recipient_id : c.donor_id) ?? "UMS Member",
            quantity: c.quantity,
            note: c.note,
            status: c.status,
          }))
      : [];
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-6 px-4 py-6 sm:px-6 lg:px-10">
      <div>
        <h1 className="text-2xl font-extrabold tracking-[-0.02em] text-[#14121A] sm:text-3xl">
          Free Items &amp; Community Donations
        </h1>
        <p className="mt-1 text-sm text-[#6B6779]">
          Give away useful study and hostel items to fellow UMSKAL members — zero fees, structured campus handover.
        </p>
      </div>
      <FreeItemsClient
        notices={notices}
        drafts={drafts}
        claims={claims}
        spots={spots}
        categories={categories}
        impact={impact}
        canPublish={sellerElig.eligible}
        canClaim={buyerElig.eligible}
        currentUserId={uid}
        supabaseUrl={storageBase}
      />
    </div>
  );
}
