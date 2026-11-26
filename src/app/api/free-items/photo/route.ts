import { evaluateBuyerEligibility, isValidUuid } from "@/lib/buyer/validation";
import { createSupabaseServerClient, getSessionSummary } from "@/lib/supabase/server";
import { detectServiceAttachmentMagicMime } from "@/lib/orders/service-attachments";

const missing = () => new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const id = params.get("post") ?? "";
  const rawIndex = params.get("index") ?? "";
  if (!isValidUuid(id) || !/^[0-4]$/.test(rawIndex)) return missing();

  const session = await getSessionSummary();
  if (!evaluateBuyerEligibility(session).eligible && !session.isActiveAdmin) return missing();
  const supabase = await createSupabaseServerClient();
  if (!supabase) return missing();

  // Table and storage RLS both check membership and post visibility.
  const { data: post } = await supabase.from("free_notices").select("image_paths").eq("id", id).maybeSingle();
  const path: string | undefined = post?.image_paths?.[Number(rawIndex)];
  if (!path) return missing();
  const { data: photo } = await supabase.storage.from("free-items").download(path);
  if (!photo) return missing();

  const mime = detectServiceAttachmentMagicMime(new Uint8Array(await photo.slice(0, 16).arrayBuffer()));
  if (!mime?.startsWith("image/")) return missing();
  return new Response(photo, { headers: {
    "Content-Type": mime,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  } });
}
