import crypto from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import {
  evaluateBuyerEligibility,
  isValidUuid,
} from "@/lib/buyer/validation";
import {
  buildUniqueServiceFileName,
  buildValidatedServiceAttachmentPath,
  detectServiceAttachmentMagicMime,
  extensionForMime,
  isBuyerOwnedStagedServicePath,
  isValidStagedServicePath,
  MAX_SERVICE_ATTACHMENT_BYTES,
  SERVICE_ATTACHMENTS_BUCKET,
} from "@/lib/orders/service-attachments";
import {
  createSupabaseServerClient,
  getSessionSummary,
} from "@/lib/supabase/server";
import { getServerServiceClient } from "@/lib/supabase/service";

/**
 * Trusted server-side content validation for staged service attachments.
 * Downloads staged bytes ONCE, verifies actual magic bytes & size (<= 5 MB),
 * writes those EXACT same bytes to the server-only `validated/` prefix with
 * `upsert: false`, and cleans up the staged file via Storage API.
 */
export async function POST(request: NextRequest) {
  const session = await getSessionSummary();
  const eligibility = evaluateBuyerEligibility(session);

  if (!eligibility.eligible || !eligibility.userId) {
    return NextResponse.json(
      { ok: false, error: eligibility.reason || "Unauthorized." },
      { status: 401 }
    );
  }

  let body: { cartItemId?: string; stagedPath?: string; fileName?: string };
  try {
    body = (await request.json()) as {
      cartItemId?: string;
      stagedPath?: string;
      fileName?: string;
    };
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid request payload." },
      { status: 400 }
    );
  }

  const buyerId = eligibility.userId;
  const cartItemId = String(body.cartItemId ?? "").trim();
  const stagedPath = String(body.stagedPath ?? "").trim();
  const fileName = String(body.fileName ?? "").trim() || "attachment";

  if (!isValidUuid(cartItemId)) {
    return NextResponse.json(
      { ok: false, error: "Invalid cart item reference." },
      { status: 400 }
    );
  }

  if (!isValidStagedServicePath(stagedPath, buyerId, cartItemId)) {
    return NextResponse.json(
      { ok: false, error: "Invalid or unauthorized staged attachment path." },
      { status: 400 }
    );
  }

  const supabase = await createSupabaseServerClient();
  const service = getServerServiceClient();
  if (!supabase || !service) {
    return NextResponse.json(
      { ok: false, error: "Attachment service unavailable." },
      { status: 503 }
    );
  }

  // Verify cart item belongs to buyer and references an active, unpaused service listing
  const { data: cartRow } = await supabase
    .from("cart_items")
    .select("id,user_id,listing_id")
    .eq("id", cartItemId)
    .eq("user_id", buyerId)
    .maybeSingle();

  if (!cartRow) {
    return NextResponse.json(
      { ok: false, error: "Cart item not found." },
      { status: 404 }
    );
  }

  const { data: listing } = await supabase
    .from("listings")
    .select("id,kind,status,accepting_requests,seller_id")
    .eq("id", (cartRow as { listing_id: string }).listing_id)
    .maybeSingle();

  const typedListing = listing as {
    id: string;
    kind: string;
    status: string;
    accepting_requests: boolean | null;
    seller_id: string;
  } | null;

  if (
    !typedListing ||
    typedListing.kind !== "service" ||
    typedListing.status !== "published" ||
    typedListing.accepting_requests === false ||
    typedListing.seller_id === buyerId
  ) {
    await service.storage
      .from(SERVICE_ATTACHMENTS_BUCKET)
      .remove([stagedPath])
      .catch(() => {});
    return NextResponse.json(
      { ok: false, error: "This service is unavailable for purchase." },
      { status: 400 }
    );
  }

  // Download staged bytes ONCE
  const { data: blob, error: dlErr } = await service.storage
    .from(SERVICE_ATTACHMENTS_BUCKET)
    .download(stagedPath);

  if (dlErr || !blob) {
    return NextResponse.json(
      { ok: false, error: "Staged upload could not be read. Please retry." },
      { status: 404 }
    );
  }

  const arrayBuf = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuf);

  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_SERVICE_ATTACHMENT_BYTES) {
    await service.storage
      .from(SERVICE_ATTACHMENTS_BUCKET)
      .remove([stagedPath])
      .catch(() => {});
    return NextResponse.json(
      { ok: false, error: "File exceeds the 5 MB limit or is empty." },
      { status: 400 }
    );
  }

  // Validate actual file signature bytes (never trust client MIME alone)
  const detectedMime = detectServiceAttachmentMagicMime(bytes);
  if (!detectedMime) {
    await service.storage
      .from(SERVICE_ATTACHMENTS_BUCKET)
      .remove([stagedPath])
      .catch(() => {});
    return NextResponse.json(
      {
        ok: false,
        error:
          "Unsupported or corrupted file content. Upload a valid JPG, PNG, WebP, or PDF.",
      },
      { status: 400 }
    );
  }

  const ext = extensionForMime(detectedMime);
  const nonce = crypto.randomBytes(6).toString("hex");
  const uniqueName = buildUniqueServiceFileName(fileName, ext, nonce);
  const validatedPath = buildValidatedServiceAttachmentPath(
    buyerId,
    cartItemId,
    uniqueName
  );

  // Upload the EXACT validated bytes into the server-only `validated/` prefix (no overwrite)
  const { error: uploadErr } = await service.storage
    .from(SERVICE_ATTACHMENTS_BUCKET)
    .upload(validatedPath, bytes, {
      contentType: detectedMime,
      upsert: false,
    });

  // Always clean up staged file via Storage API
  await service.storage
    .from(SERVICE_ATTACHMENTS_BUCKET)
    .remove([stagedPath])
    .catch(() => {});

  if (uploadErr) {
    return NextResponse.json(
      { ok: false, error: "Could not finalize attachment validation. Please retry." },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    validatedPath,
    fileName,
    mimeType: detectedMime,
    size: bytes.byteLength,
  });
}

/**
 * Deletes ONLY unvalidated `staged/` uploads owned by the active buyer via Storage API.
 * Validated attachments are strictly immutable to eliminate concurrent-checkout TOCTOU races;
 * removing a validated file in UI drops it from checkout selection with deferred server cleanup.
 */
export async function DELETE(request: NextRequest) {
  const session = await getSessionSummary();
  const eligibility = evaluateBuyerEligibility(session);

  if (!eligibility.eligible || !eligibility.userId) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  let body: { path?: string };
  try {
    body = (await request.json()) as { path?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid payload." }, { status: 400 });
  }

  const buyerId = eligibility.userId;
  const targetPath = String(body.path ?? "").trim();

  if (targetPath.startsWith(`${buyerId}/validated/`)) {
    return NextResponse.json(
      {
        ok: false,
        error: "Validated attachments are immutable and cannot be deleted directly.",
      },
      { status: 403 }
    );
  }

  if (!isBuyerOwnedStagedServicePath(targetPath, buyerId)) {
    return NextResponse.json(
      { ok: false, error: "Invalid staged attachment path." },
      { status: 400 }
    );
  }

  const service = getServerServiceClient();
  if (!service) {
    return NextResponse.json({ ok: false, error: "Service unavailable." }, { status: 503 });
  }

  const { error: rmErr } = await service.storage
    .from(SERVICE_ATTACHMENTS_BUCKET)
    .remove([targetPath]);

  if (rmErr) {
    return NextResponse.json(
      { ok: false, error: "Could not remove staged file." },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
