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
import { createParticipantSignedAttachmentUrl } from "@/lib/supabase/service";

/**
 * Participant-authorized signed URL redirect for private chat attachments.
 * Supports canonical `<participantUid>/<conversationId>/<file>` and historical
 * `<conversationId>/<file>` paths. Never exposes private files publicly.
 */
export async function GET(request: NextRequest) {
  const session = await getSessionSummary();
  const eligibility = evaluateMessagingEligibility(session);

  if (!eligibility.eligible || !eligibility.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const conversationId =
    request.nextUrl.searchParams.get("conversationId") ?? "";
  const path = request.nextUrl.searchParams.get("path") ?? "";

  if (!isValidUuid(conversationId)) {
    return NextResponse.json(
      { error: "Invalid conversation identifier" },
      { status: 400 }
    );
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

  const row = conv as {
    id: string;
    member_a: string;
    member_b: string;
  } | null;

  if (
    !row ||
    (row.member_a !== eligibility.userId && row.member_b !== eligibility.userId)
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (
    !isAttachmentPathAuthorized(conversationId, path, [
      row.member_a,
      row.member_b,
    ])
  ) {
    return NextResponse.json(
      { error: "Invalid or unauthorized attachment path" },
      { status: 400 }
    );
  }

  // Try RLS-scoped signer first; fall back to authorized server signer so both
  // sender and recipient can view/download shared private conversation files.
  let signedUrl: string | null = null;
  const rlsPrimary = await supabase.storage
    .from(CHAT_ATTACHMENTS_BUCKET)
    .createSignedUrl(path, 300);
  if (!rlsPrimary.error && rlsPrimary.data?.signedUrl) {
    signedUrl = rlsPrimary.data.signedUrl;
  }

  if (!signedUrl) {
    signedUrl = await createParticipantSignedAttachmentUrl(
      CHAT_ATTACHMENTS_BUCKET,
      path,
      300
    );
  }

  if (!signedUrl) {
    signedUrl = await createParticipantSignedAttachmentUrl(
      "chat-media",
      path,
      300
    );
  }

  if (!signedUrl) {
    return NextResponse.json(
      { error: "Attachment could not be accessed" },
      { status: 404 }
    );
  }

  const response = NextResponse.redirect(signedUrl, { status: 302 });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
