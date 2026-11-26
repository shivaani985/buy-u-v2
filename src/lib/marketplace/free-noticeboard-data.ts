import { evaluateBuyerEligibility } from "@/lib/buyer/validation";
import { evaluateSellerEligibility } from "@/lib/seller/validation";
import { readOrderPages } from "@/lib/orders/read";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { AuthSessionSummary } from "@/types/marketplace";

export const FREE_NOTICE_SELECT =
  "id,contributor_id,title,description,pickup_location,image_paths,status,published_at,renewed_at,expires_at";

export interface FreeNoticePost {
  id: string;
  contributorId: string;
  donor: string;
  title: string;
  description: string;
  pickupLocation: string | null;
  imagePaths: string[];
  status: string;
  publishedAt: string;
  renewedAt: string | null;
  expiresAt: string;
}

export async function getFreeNoticeboardData(session: AuthSessionSummary) {
  const buyer = evaluateBuyerEligibility(session);
  const seller = evaluateSellerEligibility(session);
  const identity = {
    name: session.profile?.display_name?.trim() || session.profile?.full_name?.trim() || "",
    matric: "",
  };
  const empty = { buyer, seller, identity, posts: [] as FreeNoticePost[], error: "", serverNow: Date.now() };
  if (!buyer.eligible || !buyer.userId) return empty;

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ...empty, error: "The noticeboard is temporarily unavailable." };

  const now = new Date().toISOString();
  const current = supabase.from("free_notices").select(FREE_NOTICE_SELECT)
    .eq("status", "active").gt("expires_at", now).not("pickup_location", "is", null).order("published_at", { ascending: false }).order("id");
  const owned = seller.eligible
    ? supabase.from("free_notices").select(FREE_NOTICE_SELECT).eq("contributor_id", buyer.userId).order("published_at", { ascending: false }).order("id")
    : null;
  const [catalogue, mine, profile] = await Promise.all([
    readOrderPages((from, to) => current.range(from, to)),
    owned ? readOrderPages((from, to) => owned.range(from, to)) : null,
    seller.eligible
      ? supabase.from("profiles").select("matric_number").eq("id", buyer.userId).maybeSingle()
      : null,
  ]);
  if (catalogue.error || mine?.error) {
    return { ...empty, error: "The Free Items noticeboard could not be loaded." };
  }

  const rows = new Map((catalogue.data ?? []).map((row) => [row.id, row]));
  for (const row of mine?.data ?? []) rows.set(row.id, row);
  const names = new Map<string, string>();
  const ids = [...new Set([...rows.values()].map((row) => row.contributor_id))];
  for (let start = 0; start < ids.length; start += 60) {
    const { data } = await supabase.from("public_profiles").select("id,display_name").in("id", ids.slice(start, start + 60));
    for (const member of data ?? []) {
      if (member.display_name?.trim()) names.set(member.id, member.display_name.trim());
    }
  }

  return {
    ...empty,
    identity: { ...identity, matric: profile?.data?.matric_number?.trim() ?? "" },
    serverNow: Date.now(),
    posts: [...rows.values()].map((row): FreeNoticePost => ({
      id: row.id, contributorId: row.contributor_id,
      donor: names.get(row.contributor_id) ?? ((row.contributor_id === buyer.userId ? identity.name : "") || "Campus student"),
      title: row.title, description: row.description,
      pickupLocation: row.pickup_location, imagePaths: row.image_paths,
      status: row.status, publishedAt: row.published_at,
      renewedAt: row.renewed_at, expiresAt: row.expires_at,
    })),
  };
}
