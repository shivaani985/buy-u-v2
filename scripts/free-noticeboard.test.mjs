import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  freeNoticePhotoHref, getNoticeboardStatus, matchesNoticeboardSearch, validateNoticeboardPost,
} from "../src/lib/marketplace/free-noticeboard.ts";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");

test("Free Items input requires a title, actual typed location and 1–5 separate photos, with optional description", () => {
  const input = { title: "Free textbooks", description: "", pickupLocation: "Blok Alpha common room", imagePaths: ["owner/photo.jpg"] };
  assert.equal(validateNoticeboardPost(input), null);
  assert.match(validateNoticeboardPost({ ...input, title: "   " }), /Item name/);
  assert.match(validateNoticeboardPost({ ...input, pickupLocation: "  " }), /pickup location/);
  assert.match(validateNoticeboardPost({ ...input, imagePaths: [] }), /1 to 5/);
  assert.match(validateNoticeboardPost({ ...input, imagePaths: ["x", "x"] }), /duplicate/);
});

test("Free Items search matches each field case-insensitively", () => {
  const post = { title: "Textbooks", description: "With Stationery", pickupLocation: "Blok ALPHA" };
  for (const term of ["TEXT", " stationery ", "alpha"]) assert.equal(matchesNoticeboardSearch(post, term), true);
  assert.equal(matchesNoticeboardSearch(post, "hostel"), false);
});

test("Expiry starts at the exact cutoff while hidden and removed remain separate", () => {
  const expiresAt = "2026-11-29T04:00:00Z";
  const now = Date.parse(expiresAt);
  assert.equal(getNoticeboardStatus({ expiresAt, status: "active" }, now - 1), "Active");
  assert.equal(getNoticeboardStatus({ expiresAt, status: "active" }, now), "Expired");
  assert.equal(getNoticeboardStatus({ expiresAt, status: "hidden" }, now), "Moderated");
  assert.equal(getNoticeboardStatus({ expiresAt, status: "closed" }, now), "Removed");
});

test("Guest discovery and photo access fail closed before querying notices", () => {
  const data = read("src/lib/marketplace/free-noticeboard-data.ts");
  const proxy = read("src/app/api/free-items/photo/route.ts");
  const catalogue = read("src/lib/catalog.ts");
  assert.ok(data.indexOf("if (!buyer.eligible || !buyer.userId)") < data.indexOf('.from("free_notices")'));
  assert.ok(proxy.indexOf("evaluateBuyerEligibility(session).eligible") < proxy.indexOf('.from("free_notices")'));
  assert.match(proxy, /Cache-Control.*private, no-store/);
  assert.match(catalogue, /\.eq\("status", "active"\)\.gt\("expires_at"/);
  assert.equal(freeNoticePhotoHref("post-id", 2), "/api/free-items/photo?post=post-id&index=2");
});

test("Chat resolves the active donor, checks blocking, reuses the pair and skips automated messages", () => {
  const actions = read("src/app/messages/actions.ts");
  const open = actions.slice(actions.indexOf("export async function startConversationAction"), actions.indexOf("export async function sendMessageAction"));
  const migration = read("docs/sql/phase-10m-contextual-messaging.sql");
  assert.match(actions, /if \(freeNoticeId\)[\s\S]*?eq\("status", "active"\)[\s\S]*?peerId = notice\.contributor_id/);
  assert.match(actions, /checkBlockedBidirectional\(supabase, userId, peerId\)/);
  assert.match(open, /rpc\("open_contextual_conversation"/);
  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\('chat-pair:'/);
  assert.match(migration, /EXCEPTION WHEN unique_violation/);
  assert.doesNotMatch(open, /sendMessageAction|from\("messages"\)|create_free_notice_claim_atomic|create_cart_checkout_atomic/);
});

test("Free Items embeds the exact migration and retains the rollback and access controls", () => {
  const migration = read("docs/sql/phase-10g-free-items-noticeboard.sql");
  const verify = read("docs/sql/phase-10g-free-items-noticeboard.verify.sql");
  const body = migration.match(/^BEGIN;\n\n([\s\S]+)\n\nCOMMIT;\n?$/)?.[1];
  const embedded = verify.match(/-- BEGIN EXACT STANDALONE MIGRATION BODY\n([\s\S]+)\n-- END EXACT STANDALONE MIGRATION BODY/)?.[1];
  assert.ok(body && embedded);
  assert.equal(createHash("sha256").update(body).digest("hex"), createHash("sha256").update(embedded).digest("hex"));
  assert.equal(body, embedded);
  assert.equal((verify.match(/^BEGIN;$/gm) ?? []).length, 1);
  assert.match(verify, /^ROLLBACK;$/m);
  assert.doesNotMatch(verify, /^COMMIT;/m);
  assert.doesNotMatch(migration, /\b(?:CREATE|DROP) TABLE\b|\bDROP COLUMN\b/i);
  assert.match(body, /FOR UPDATE/);
  assert.match(body, /p_acknowledged IS DISTINCT FROM true/);
  assert.match(body, /v_post\.expires_at > v_now/);
  assert.match(body, /REVOKE EXECUTE ON FUNCTION public\.create_free_notice_claim_atomic/);
  assert.match(body, /UPDATE storage\.buckets SET public = false WHERE id = 'free-items'/);
});
