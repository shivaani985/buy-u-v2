import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import {
  buildPrivateDisputeEvidenceUrl,
  DISPUTE_EVIDENCE_BUCKET,
  isDisputeEvidencePathAuthorized,
  isValidUuid,
  validateDisputeEvidenceFileMeta,
} from "@/lib/disputes/validation";
import { getSessionSummary } from "@/lib/supabase/server";
import { getServerServiceClient } from "@/lib/supabase/service";

/**
 * Participant-only private dispute evidence upload (`POST`) and
 * participant/admin-only signed-URL download (`GET`).
 * Never exposes public evidence URLs.
 */
export async function POST(request: NextRequest) {
  const session = await getSessionSummary();
  const userId = session.profile?.id;
  if (
    !session.isAuthenticated ||
    !userId ||
    !session.isEmailVerified ||
    session.profile?.status?.toLowerCase() !== "active"
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await request.formData().catch(() => null);
  if (!formData) {
    return NextResponse.json({ error: "Invalid form payload" }, { status: 400 });
  }

  const orderId = String(formData.get("orderId") ?? "").trim();
  const file = formData.get("file");
  if (!isValidUuid(orderId) || !(file instanceof File)) {
    return NextResponse.json(
      { error: "Valid orderId and image file are required." },
      { status: 400 }
    );
  }

  const check = validateDisputeEvidenceFileMeta({
    type: file.type,
    size: file.size,
  });
  if (!check.ok || !check.ext) {
    return NextResponse.json(
      { error: check.error || "Invalid image file." },
      { status: 400 }
    );
  }

  const service = getServerServiceClient();
  if (!service) {
    return NextResponse.json({ error: "Storage unavailable." }, { status: 503 });
  }

  // Verify the uploader is either the buyer or seller of this order
  const { data: orderRow } = await service
    .from("orders")
    .select("id,buyer_id,seller_id")
    .eq("id", orderId)
    .maybeSingle();

  const order = orderRow as {
    id: string;
    buyer_id: string;
    seller_id: string;
  } | null;

  if (!order || (order.buyer_id !== userId && order.seller_id !== userId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const fileName = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${check.ext}`;
  const storagePath = `${userId}/${orderId}/${fileName}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  const { error: uploadErr } = await service.storage
    .from(DISPUTE_EVIDENCE_BUCKET)
    .upload(storagePath, buffer, {
      contentType: file.type,
      upsert: false,
    });

  if (uploadErr) {
    return NextResponse.json(
      { error: "Could not upload evidence image right now." },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    path: storagePath,
    previewUrl: buildPrivateDisputeEvidenceUrl(orderId, storagePath),
  });
}

export async function GET(request: NextRequest) {
  const session = await getSessionSummary();
  const userId = session.profile?.id;
  if (!session.isAuthenticated || !userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const orderId = request.nextUrl.searchParams.get("orderId") ?? "";
  const path = request.nextUrl.searchParams.get("path") ?? "";

  if (!isValidUuid(orderId) || !path.trim()) {
    return NextResponse.json(
      { error: "Invalid evidence request." },
      { status: 400 }
    );
  }

  const service = getServerServiceClient();
  if (!service) {
    return NextResponse.json({ error: "Service unavailable." }, { status: 503 });
  }

  const { data: orderRow } = await service
    .from("orders")
    .select("id,buyer_id,seller_id")
    .eq("id", orderId)
    .maybeSingle();

  const order = orderRow as {
    id: string;
    buyer_id: string;
    seller_id: string;
  } | null;

  if (!order) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const isParticipant =
    order.buyer_id === userId || order.seller_id === userId;
  if (!isParticipant && !session.isActiveAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (
    !isDisputeEvidencePathAuthorized(path, orderId, [
      order.buyer_id,
      order.seller_id,
    ])
  ) {
    return NextResponse.json(
      { error: "Invalid or unauthorized evidence path." },
      { status: 400 }
    );
  }

  const { data: signedData, error: signErr } = await service.storage
    .from(DISPUTE_EVIDENCE_BUCKET)
    .createSignedUrl(path, 300);

  if (signErr || !signedData?.signedUrl) {
    return NextResponse.json(
      { error: "Evidence image could not be accessed." },
      { status: 404 }
    );
  }

  const response = NextResponse.redirect(signedData.signedUrl, { status: 302 });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
