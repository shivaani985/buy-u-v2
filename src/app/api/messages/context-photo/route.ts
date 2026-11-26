import { isValidUuid } from "@/lib/buyer/validation";
import { detectServiceAttachmentMagicMime } from "@/lib/orders/service-attachments";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const missing = () => new Response(null, { status: 404, headers });

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("message") ?? "";
  if (!isValidUuid(id)) return missing();
  const supabase = await createSupabaseServerClient();
  if (!supabase) return missing();
  const { data: path } = await supabase.rpc("read_chat_free_photo", { p_message: id });
  if (typeof path !== "string") return missing();
  const { data: photo } = await supabase.storage.from("free-items").download(path);
  if (!photo) return missing();
  const mime = detectServiceAttachmentMagicMime(new Uint8Array(await photo.slice(0, 16).arrayBuffer()));
  if (!mime?.startsWith("image/")) return missing();
  return new Response(photo, { headers: { ...headers, "Content-Type": mime } });
}
