import { NextResponse, type NextRequest } from "next/server";
import { isValidUuid } from "@/lib/buyer/validation";
import {
  extractAttachmentDisplayName,
  SERVICE_ATTACHMENTS_BUCKET,
} from "@/lib/orders/service-attachments";
import { getSessionSummary } from "@/lib/supabase/server";
import { getServerServiceClient } from "@/lib/supabase/service";

/**
 * Authorized short-lived signed URL proxy for private service order attachments.
 * Accessible ONLY to:
 *   - Order buyer
 *   - Order seller
 *   - Active admin reviewing a disputed order
 */
export async function GET(request: NextRequest) {
  const session = await getSessionSummary();
  const userId = session.profile?.id ?? null;

  if (
    !session.isAuthenticated ||
    !session.isEmailVerified ||
    !userId ||
    session.profile?.status !== "active"
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const orderId = request.nextUrl.searchParams.get("orderId")?.trim() ?? "";
  const itemId = request.nextUrl.searchParams.get("itemId")?.trim() ?? "";
  const path = request.nextUrl.searchParams.get("path")?.trim() ?? "";
  const download = request.nextUrl.searchParams.get("download") === "1";

  if (!isValidUuid(orderId) || !isValidUuid(itemId) || !path || path.includes("..")) {
    return NextResponse.json({ error: "Invalid attachment reference" }, { status: 400 });
  }

  const service = getServerServiceClient();
  if (!service) {
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  }

  const [orderRes, itemRes] = await Promise.all([
    service
      .from("orders")
      .select("id,buyer_id,seller_id")
      .eq("id", orderId)
      .maybeSingle(),
    service
      .from("order_items")
      .select("id,order_id,is_service,service_attachment_paths")
      .eq("id", itemId)
      .eq("order_id", orderId)
      .maybeSingle(),
  ]);

  const order = orderRes.data as {
    id: string;
    buyer_id: string;
    seller_id: string;
  } | null;

  const item = itemRes.data as {
    id: string;
    order_id: string;
    is_service: boolean | null;
    service_attachment_paths: string[] | null;
  } | null;

  if (!order || !item || !item.is_service) {
    return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
  }

  const isParticipant = order.buyer_id === userId || order.seller_id === userId;
  let isAuthorizedAdmin = false;

  if (!isParticipant && session.isActiveAdmin) {
    const { data: dispute } = await service
      .from("order_disputes")
      .select("id")
      .eq("order_id", orderId)
      .limit(1);
    isAuthorizedAdmin = Boolean(dispute && dispute.length > 0);
  }

  if (!isParticipant && !isAuthorizedAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const paths = item.service_attachment_paths ?? [];
  if (!paths.includes(path) || !path.startsWith(`${order.buyer_id}/validated/`)) {
    return NextResponse.json({ error: "Attachment not linked to this item" }, { status: 404 });
  }

  const { data: signed, error: signErr } = await service.storage
    .from(SERVICE_ATTACHMENTS_BUCKET)
    .createSignedUrl(
      path,
      60,
      download ? { download: extractAttachmentDisplayName(path) } : undefined
    );

  if (signErr || !signed?.signedUrl) {
    return NextResponse.json(
      { error: "Unable to generate signed attachment URL" },
      { status: 500 }
    );
  }

  const res = NextResponse.redirect(signed.signedUrl, 302);
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}
