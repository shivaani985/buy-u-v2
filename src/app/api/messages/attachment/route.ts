import { NextResponse, type NextRequest } from "next/server";
import {
  CHAT_ATTACHMENTS_BUCKET,
  evaluateMessagingEligibility,
  isAttachmentPathAuthorized,
  isValidUuid,
} from "@/lib/messages/validation";
import {
  createSupabaseServerClient,
  getSessionSummary,
} from "@/lib/supabase/server";

/**
 * Participant-authorized signed URL redirect for private chat attachments.
 * Never exposes private storage objects publicly.
 */
export async function GET(request: NextRequest) {
  const session = await getSessionSummary();
  const eligibility = evaluateMessagingEligibility(session);

  if (!eligibility.eligible || !eligibility.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const conversationId = request.nextUrl.searchParams.get("conversationId") ?? "";
  const path = request.nextUrl.searchParams.get("path") ?? "";

  if (!isValidUuid(conversationId) || !isAttachmentPathAuthorized(conversationId, path)) {
    return NextResponse.json({ error: "Invalid attachment path" }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  }

  // Verify the authenticated member is a participant in this conversation
  const { data: conv } = await supabase
    .from("conversations")
    .select("id,member_a,member_b")
    .eq("id", conversationId)
    .maybeSingle();

  const row = conv as { id: string; member_a: string; member_b: string } | null;
  if (
    !row ||
    (row.member_a !== eligibility.userId && row.member_b !== eligibility.userId)
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Generate a short-lived 5-minute signed URL from the private bucket
  let signed = await supabase.storage
    .from(CHAT_ATTACHMENTS_BUCKET)
    .createSignedUrl(path, 300);

  if (signed.error || !signed.data?.signedUrl) {
    signed = await supabase.storage
      .from("chat-media")
      .createSignedUrl(path, 300);
  }

  if (signed.error || !signed.data?.signedUrl) {
    return NextResponse.json(
      { error: "Attachment could not be accessed" },
      { status: 404 }
    );
  }

  const response = NextResponse.redirect(signed.data.signedUrl, { status: 302 });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
