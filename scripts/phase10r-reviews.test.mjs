import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  detectReviewMediaMagicMime,
  getReviewStarLabel,
  isValidStagedReviewMediaPath,
  isValidValidatedReviewImagePath,
  isValidValidatedReviewVideoPath,
  maskAnonymousReviewerName,
  validateReviewImageMeta,
  validateReviewSubmissionInput,
  validateReviewVideoDurationBuffer,
  validateReviewVideoMeta,
} from "../src/lib/reviews/validation.ts";
import {
  computeListingRatingAndSoldMap,
  evaluateRepurchaseAvailability,
  sanitizePublicReviewRow,
} from "../src/lib/reviews/presentation.ts";
import {
  matchLegacyVariantImagePath,
  resolvePurchasedItemImagePath,
  resolvePurchasedItemImageUrl,
} from "../src/lib/orders/item-images.ts";

const BUYER_UUID = "11111111-1111-4111-8111-111111111111";
const OTHER_UUID = "22222222-2222-4222-8222-222222222222";
const LISTING_UUID = "33333333-3333-4333-8333-333333333333";
const VARIANT_UUID = "44444444-4444-4444-8444-444444444444";

function buildMinimalMp4Buffer(timescale, durationUnits) {
  // ftyp (20 bytes) + moov (8 + mvhd 108 bytes = 116 bytes)
  const ftyp = Buffer.alloc(20);
  ftyp.writeUInt32BE(20, 0);
  ftyp.write("ftypisom", 4, "ascii");
  ftyp.writeUInt32BE(512, 12);
  ftyp.write("mp42", 16, "ascii");

  const mvhd = Buffer.alloc(108);
  mvhd.writeUInt32BE(108, 0);
  mvhd.write("mvhd", 4, "ascii");
  mvhd.writeUInt8(0, 8); // version 0
  mvhd.writeUInt32BE(timescale, 8 + 12);
  mvhd.writeUInt32BE(durationUnits, 8 + 16);

  const moovHdr = Buffer.alloc(8);
  moovHdr.writeUInt32BE(8 + mvhd.length, 0);
  moovHdr.write("moov", 4, "ascii");

  return Buffer.concat([ftyp, moovHdr, mvhd]);
}

function buildMinimalWebmBuffer(durationMs) {
  const ebml = Buffer.from([
    0x1a, 0x45, 0xdf, 0xa3, 0x89, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d,
    0x00, 0x00,
  ]);

  // TimecodeScale (0x2AD7B1) = 1_000_000 (0x0F4240), Duration (0x4489) = float64
  const tcScale = Buffer.from([0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]);
  const durEl = Buffer.alloc(11);
  durEl.set([0x44, 0x89, 0x88], 0);
  durEl.writeDoubleBE(durationMs, 3);

  const infoBody = Buffer.concat([tcScale, durEl]);
  const info = Buffer.concat([
    Buffer.from([0x15, 0x49, 0xa9, 0x66, 0x80 | infoBody.length]),
    infoBody,
  ]);
  const segment = Buffer.concat([
    Buffer.from([0x18, 0x53, 0x80, 0x67, 0x80 | info.length]),
    info,
  ]);
  return Buffer.concat([ebml, segment]);
}

test("R02: star rating labels & review comment/media submission validation", () => {
  assert.equal(getReviewStarLabel(1), "Very Poor");
  assert.equal(getReviewStarLabel(2), "Poor");
  assert.equal(getReviewStarLabel(3), "Average");
  assert.equal(getReviewStarLabel(4), "Good");
  assert.equal(getReviewStarLabel(5), "Excellent");

  assert.equal(validateReviewSubmissionInput({ rating: 0, comment: "Nice product!" }).ok, false);
  assert.equal(validateReviewSubmissionInput({ rating: 5, comment: "ok" }).ok, false);

  const imgs = Array.from({ length: 6 }, (_, i) => `${BUYER_UUID}/validated/img-${i}.jpg`);
  assert.equal(
    validateReviewSubmissionInput({
      rating: 5,
      comment: "Great packaging and condition.",
      imagePaths: imgs,
      ownerUserId: BUYER_UUID,
    }).ok,
    false
  );

  // Reject another user's validated path
  assert.equal(
    validateReviewSubmissionInput({
      rating: 5,
      comment: "Great packaging and condition.",
      imagePaths: [`${OTHER_UUID}/validated/stolen.jpg`],
      ownerUserId: BUYER_UUID,
    }).ok,
    false
  );

  assert.equal(
    validateReviewSubmissionInput({
      rating: 5,
      comment: "Great packaging and condition.",
      imagePaths: [`${BUYER_UUID}/validated/ok.jpg`, `${BUYER_UUID}/validated/ok2.webp`],
      videoPath: `${BUYER_UUID}/validated/demo.mp4`,
      ownerUserId: BUYER_UUID,
    }).ok,
    true
  );
});

test("R04/R05: anonymous masking handles short, spaced, and Unicode names without identity leaks", () => {
  assert.equal(maskAnonymousReviewerName(""), "Anonymous Buyer");
  assert.equal(maskAnonymousReviewerName("A"), "A***");
  assert.equal(maskAnonymousReviewerName("Al"), "A***l");
  assert.equal(maskAnonymousReviewerName("Shazim"), "S****m");
  assert.equal(maskAnonymousReviewerName("Siti Nurhaliza"), "S********a");
  assert.equal(maskAnonymousReviewerName("Āmina 😀"), "Ā*****😀");

  const anonymousProjected = sanitizePublicReviewRow({
    review: {
      id: "rev-anon",
      listing_id: LISTING_UUID,
      order_id: "ord-1",
      buyer_id: BUYER_UUID,
      rating: 5,
      comment: "Very smooth meetup near cafe.",
      is_anonymous: true,
      image_paths: [`${BUYER_UUID}/validated/photo.jpg`],
      video_path: `${BUYER_UUID}/validated/clip.mp4`,
      edited_at: "2026-11-26T04:00:00Z",
      created_at: "2026-11-25T04:00:00Z",
    },
    profile: {
      display_name: "Shazim Secret",
      avatar_url: "https://cdn.example.com/secret-avatar.jpg",
    },
    purchasedVariantLabel: "Hawas Fire",
    viewerUserId: OTHER_UUID,
    storageBaseUrl: "https://example.supabase.co",
  });

  assert.ok(anonymousProjected);
  assert.equal(anonymousProjected.isAnonymous, true);
  assert.equal(anonymousProjected.reviewerDisplayName, "S********t");
  assert.equal(anonymousProjected.reviewerAvatarUrl, null);
  assert.equal(anonymousProjected.isEdited, true);
  assert.equal(anonymousProjected.canEdit, false);

  const serialized = JSON.stringify(anonymousProjected);
  assert.equal(serialized.includes(BUYER_UUID), false, "Must never expose buyer_id");
  assert.equal(serialized.includes("Shazim"), false, "Must never expose real name");
  assert.equal(serialized.includes("secret-avatar"), false, "Must never expose real avatar");
  assert.deepEqual(anonymousProjected.media, [
    { kind: "image", url: "/api/reviews/media?reviewId=rev-anon&kind=image&index=0" },
    { kind: "video", url: "/api/reviews/media?reviewId=rev-anon&kind=video" },
  ]);

  const namedProjected = sanitizePublicReviewRow({
    review: {
      id: "rev-named",
      listing_id: LISTING_UUID,
      service_request_id: "sr-1",
      buyer_id: BUYER_UUID,
      rating: 4,
      comment: "Helpful notes.",
      is_anonymous: false,
      created_at: "2026-11-25T04:00:00Z",
    },
    profile: {
      display_name: "Aina",
      avatar_url: "https://cdn.example.com/aina.jpg",
    },
    viewerUserId: BUYER_UUID,
  });

  assert.ok(namedProjected);
  assert.equal(namedProjected.reviewerDisplayName, "Aina");
  assert.equal(namedProjected.reviewerAvatarUrl, "https://cdn.example.com/aina.jpg");
  assert.equal(namedProjected.isVerifiedService, true);
  assert.equal(namedProjected.canEdit, true);
});

test("R03: review media magic bytes, size limits, path rules, and MP4/WebM <= 30s verification", () => {
  assert.equal(validateReviewImageMeta({ type: "image/jpeg", size: 5 * 1024 * 1024 }).ok, true);
  assert.equal(validateReviewImageMeta({ type: "image/jpeg", size: 5 * 1024 * 1024 + 1 }).ok, false);
  assert.equal(validateReviewImageMeta({ type: "image/gif", size: 1000 }).ok, false);

  assert.equal(validateReviewVideoMeta({ type: "video/mp4", size: 20 * 1024 * 1024, durationSeconds: 30 }).ok, true);
  assert.equal(validateReviewVideoMeta({ type: "video/mp4", size: 20 * 1024 * 1024 + 1, durationSeconds: 10 }).ok, false);
  assert.equal(validateReviewVideoMeta({ type: "video/webm", size: 1024, durationSeconds: 30.2 }).ok, false);

  assert.equal(isValidStagedReviewMediaPath(`${BUYER_UUID}/staged/123.mp4`, BUYER_UUID), true);
  assert.equal(isValidStagedReviewMediaPath(`${BUYER_UUID}/validated/123.mp4`, BUYER_UUID), false);
  assert.equal(isValidValidatedReviewImagePath(`${BUYER_UUID}/validated/abc.webp`, BUYER_UUID), true);
  assert.equal(isValidValidatedReviewVideoPath(`${BUYER_UUID}/validated/abc.mp4`, BUYER_UUID), true);

  const mp4Ok = buildMinimalMp4Buffer(1000, 29500);
  assert.equal(detectReviewMediaMagicMime(mp4Ok), "video/mp4");
  const mp4ResOk = validateReviewVideoDurationBuffer(mp4Ok, "video/mp4");
  assert.equal(mp4ResOk.ok, true);
  assert.equal(mp4ResOk.durationSeconds, 29.5);

  const mp4TooLong = buildMinimalMp4Buffer(1000, 31000);
  assert.equal(validateReviewVideoDurationBuffer(mp4TooLong, "video/mp4").ok, false);

  const webmOk = buildMinimalWebmBuffer(12500);
  assert.equal(detectReviewMediaMagicMime(webmOk), "video/webm");
  const webmResOk = validateReviewVideoDurationBuffer(webmOk, "video/webm");
  assert.equal(webmResOk.ok, true);
  assert.ok(Math.abs((webmResOk.durationSeconds ?? 0) - 12.5) < 0.01);

  const webmTooLong = buildMinimalWebmBuffer(31500);
  assert.equal(validateReviewVideoDurationBuffer(webmTooLong, "video/webm").ok, false);
});

test("R06: listing rating vs weighted shop rating fallback and strict completed-unit sold count", () => {
  const verifiedSessions = new Set(["cs-verified"]);
  const fullRefunds = new Set(["ord-full-refund"]);

  const metrics = computeListingRatingAndSoldMap({
    entries: [
      { listingId: "l-reviewed", sellerId: "s-1" },
      { listingId: "l-no-rev", sellerId: "s-1" },
      { listingId: "l-new-seller", sellerId: "s-2" },
    ],
    reviews: [
      // l-reviewed: avg = (5 + 4)/2 = 4.5
      { listing_id: "l-reviewed", seller_id: "s-1", rating: 5, hidden: false },
      { listing_id: "l-reviewed", seller_id: "s-1", rating: 4, hidden: false },
      // other item from s-1 with 2 reviews of 2 stars -> shop weighted avg = (5+4+2+2)/4 = 3.25
      { listing_id: "l-other", seller_id: "s-1", rating: 2, hidden: false },
      { listing_id: "l-other", seller_id: "s-1", rating: 2, hidden: false },
      // hidden review ignored
      { listing_id: "l-no-rev", seller_id: "s-1", rating: 1, hidden: true },
    ],
    completedOrderItems: [
      // Counted: completed + verified + quantity 3
      { listing_id: "l-reviewed", order_id: "o-1", quantity: 3, order_status: "completed", paid_at: "2026-11-20T00:00:00Z", checkout_session_id: "cs-verified" },
      // Counted: another variation of l-reviewed completed quantity 2 -> total 5
      { listing_id: "l-reviewed", order_id: "o-2", quantity: 2, order_status: "completed", paid_at: "2026-11-21T00:00:00Z", checkout_session_id: "cs-verified" },
      // Excluded: paid awaiting collection
      { listing_id: "l-reviewed", order_id: "o-paid", quantity: 4, order_status: "paid", paid_at: "2026-11-22T00:00:00Z", checkout_session_id: "cs-verified" },
      // Excluded: handed_over not completed
      { listing_id: "l-reviewed", order_id: "o-hand", quantity: 2, order_status: "handed_over", paid_at: "2026-11-22T00:00:00Z", checkout_session_id: "cs-verified" },
      // Excluded: fully refunded completed order
      { listing_id: "l-reviewed", order_id: "ord-full-refund", quantity: 10, order_status: "completed", paid_at: "2026-11-19T00:00:00Z", checkout_session_id: "cs-verified" },
      // Excluded: unverified payment
      { listing_id: "l-no-rev", order_id: "o-unverified", quantity: 5, order_status: "completed", paid_at: null, checkout_session_id: "cs-missing" },
    ],
    verifiedSessionIds: verifiedSessions,
    fullRefundOrderIds: fullRefunds,
  });

  const mA = metrics.get("l-reviewed");
  assert.equal(mA?.ratingSource, "listing");
  assert.equal(mA?.effectiveRating, 4.5);
  assert.equal(mA?.effectiveReviewCount, 2);
  assert.equal(mA?.totalSold, 5);

  const mB = metrics.get("l-no-rev");
  assert.equal(mB?.ratingSource, "shop");
  assert.equal(mB?.effectiveRating, 3.25);
  assert.equal(mB?.effectiveReviewCount, 4);
  assert.equal(mB?.totalSold, 0);

  const mC = metrics.get("l-new-seller");
  assert.equal(mC?.ratingSource, "none");
  assert.equal(mC?.effectiveRating, null);
  assert.equal(mC?.effectiveReviewCount, 0);
  assert.equal(mC?.totalSold, 0);
});

test("R08: purchased variation image resolution honors snapshot priority without cover corruption", () => {
  // 1. Order item snapshot always wins (even if seller later edited variant to another image)
  assert.equal(
    resolvePurchasedItemImagePath({
      orderItemImagePath: "seller/hawas-fire-purchased.jpg",
      offerVariantImagePath: "seller/offer-other.jpg",
      variantImagePath: "seller/edited-later.jpg",
      listingCoverPath: "seller/group-cover.jpg",
    }),
    "seller/hawas-fire-purchased.jpg"
  );

  // 2. Offer snapshot used when order item snapshot is empty
  assert.equal(
    resolvePurchasedItemImagePath({
      orderItemImagePath: "",
      offerVariantImagePath: "seller/offer-fire.jpg",
      variantImagePath: "seller/variant-new.jpg",
      listingCoverPath: "seller/group-cover.jpg",
    }),
    "seller/offer-fire.jpg"
  );

  // 3. Legacy matched variant image used when no order/offer snapshot exists
  const byId = new Map([
    [VARIANT_UUID, { id: VARIANT_UUID, listing_id: LISTING_UUID, option_values: { Fragrance: "Hawas Fire" }, image_path: "seller/legacy-fire.jpg" }],
  ]);
  const byListing = new Map([[LISTING_UUID, Array.from(byId.values())]]);
  const matched = matchLegacyVariantImagePath({
    listingId: LISTING_UUID,
    variantId: null,
    variantSnapshot: { fragrance: "hawas fire" },
    variantsById: byId,
    variantsByListing: byListing,
  });
  assert.equal(matched, "seller/legacy-fire.jpg");
  assert.equal(
    resolvePurchasedItemImageUrl({
      orderItemImagePath: null,
      variantImagePath: matched,
      listingCoverPath: "seller/group-cover.jpg",
      storageBaseUrl: "https://example.supabase.co",
    }),
    "https://example.supabase.co/storage/v1/object/public/listings/seller/legacy-fire.jpg"
  );
});

test("R01: Buy Again / Book Again / Unavailable live evaluation never substitutes wrong variations", () => {
  const baseListing = {
    id: LISTING_UUID,
    seller_id: OTHER_UUID,
    kind: "business",
    status: "published",
    has_variants: true,
    quantity: 10,
    reserved_quantity: 0,
    accepting_requests: null,
  };

  // Exact purchased variant still active & in stock
  const exactOk = evaluateRepurchaseAvailability({
    buyerUserId: BUYER_UUID,
    item: { listingId: LISTING_UUID, variantId: VARIANT_UUID, variantLabel: "Hawas Fire", isService: false },
    listing: baseListing,
    variants: [
      { id: VARIANT_UUID, listing_id: LISTING_UUID, active: true, quantity: 3, reserved_quantity: 1 },
      { id: "v-other", listing_id: LISTING_UUID, active: true, quantity: 5, reserved_quantity: 0 },
    ],
  });
  assert.equal(exactOk.status, "available");
  assert.equal(exactOk.buttonLabel, "Buy Again");
  assert.equal(exactOk.href, `/listings/${LISTING_UUID}?variant=${VARIANT_UUID}`);

  // Purchased variant sold out, other variant still available -> DO NOT substitute another variant ID!
  const prevVarDead = evaluateRepurchaseAvailability({
    buyerUserId: BUYER_UUID,
    item: { listingId: LISTING_UUID, variantId: VARIANT_UUID, variantLabel: "Hawas Fire", isService: false },
    listing: baseListing,
    variants: [
      { id: VARIANT_UUID, listing_id: LISTING_UUID, active: true, quantity: 1, reserved_quantity: 1 },
      { id: "v-other", listing_id: LISTING_UUID, active: true, quantity: 5, reserved_quantity: 0 },
    ],
  });
  assert.equal(prevVarDead.status, "variant_unavailable");
  assert.equal(prevVarDead.buttonLabel, "Buy Again");
  assert.ok(prevVarDead.href?.includes("prevVariant=Hawas%20Fire"));
  assert.equal(prevVarDead.href?.includes("variant="), false);

  // All variants sold out or listing archived -> Product Unavailable
  const productDead = evaluateRepurchaseAvailability({
    buyerUserId: BUYER_UUID,
    item: { listingId: LISTING_UUID, variantId: VARIANT_UUID, variantLabel: "Hawas Fire", isService: false },
    listing: { ...baseListing, status: "archived" },
    variants: [],
  });
  assert.equal(productDead.status, "listing_unavailable");
  assert.equal(productDead.buttonLabel, "Product Unavailable");
  assert.equal(productDead.href, null);

  // Service paused -> Service Unavailable; active -> Book Again
  const servicePaused = evaluateRepurchaseAvailability({
    buyerUserId: BUYER_UUID,
    item: { listingId: LISTING_UUID, variantId: null, variantLabel: null, isService: true },
    listing: { ...baseListing, kind: "service", has_variants: false, accepting_requests: false },
    variants: [],
  });
  assert.equal(servicePaused.buttonLabel, "Service Unavailable");
  assert.equal(servicePaused.href, null);

  const serviceActive = evaluateRepurchaseAvailability({
    buyerUserId: BUYER_UUID,
    item: { listingId: LISTING_UUID, variantId: null, variantLabel: null, isService: true },
    listing: { ...baseListing, kind: "service", has_variants: false, accepting_requests: true },
    variants: [],
  });
  assert.equal(serviceActive.buttonLabel, "Book Again");
  assert.equal(serviceActive.href, `/listings/${LISTING_UUID}`);
});

test("R07: Phase 10R SQL removes artificial 7-day edit cap and revokes buyer_id SELECT", () => {
  const sql = fs.readFileSync(
    path.join(process.cwd(), "docs", "sql", "phase-10r-review-enhancements.sql"),
    "utf8"
  );
  assert.doesNotMatch(sql, /REVIEW_EDIT_WINDOW_EXPIRED/);
  assert.match(sql, /REVIEW_MODERATED/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.reviews FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(
    sql,
    /GRANT SELECT\s*\([^)]*\bbuyer_id\b[^)]*\)\s*ON TABLE public\.reviews TO authenticated/i
  );
});
