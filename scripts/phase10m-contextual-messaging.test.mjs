import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chatPreview, contextArgs, parseChatTarget } from "../src/lib/messages/context.ts";
import { mergeOrderedMessages, validateMessageInput } from "../src/lib/messages/validation.ts";

const listing = "11111111-1111-4111-8111-111111111111";
const variant = "22222222-2222-4222-8222-222222222222";
const item = "33333333-3333-4333-8333-333333333333";
const buyer = "44444444-4444-4444-8444-444444444444";
const conversation = "55555555-5555-4555-8555-555555555555";
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");

test("references accept only an authorized lookup shape and preserve explicit variation IDs", () => {
  assert.deepEqual(contextArgs(parseChatTarget({
    kind: "product", targetId: listing, variantId: variant, title: "Forged title", priceMinSen: 1,
  })), { p_kind: "product", p_target: listing, p_variant: variant, p_item: null });
  assert.deepEqual(contextArgs(parseChatTarget({ kind: "order", targetId: listing, itemId: item })),
    { p_kind: "order", p_target: listing, p_variant: null, p_item: item });
  assert.equal(parseChatTarget({ kind: "free", targetId: listing, variantId: variant }), null);
  assert.equal(parseChatTarget({ kind: "order", targetId: listing, itemId: "invalid" }), null);
  assert.equal(parseChatTarget({ kind: "__proto__", targetId: listing }), null);
});

test("reference-only, attachment-only and plain text messages remain valid", () => {
  const input = { eligibility: { eligible: true, userId: buyer }, conversationId: conversation, isParticipant: true, isBlocked: false };
  assert.equal(validateMessageInput({ ...input, body: "" }).ok, false);
  assert.equal(validateMessageInput({ ...input, body: "", hasReference: true }).ok, true);
  assert.equal(validateMessageInput({ ...input, body: "  Still available?   " }).trimmedBody, "Still available?");
  assert.equal(validateMessageInput({ ...input, body: "", attachmentPaths: [`${buyer}/${conversation}/file.pdf`] }).ok, true);
  assert.equal(validateMessageInput({ ...input, body: "", attachmentPaths: [`${variant}/${conversation}/file.pdf`] }).ok, false);
  assert.equal(chatPreview("", 0, { kind: "product" }), "Product shared");
  assert.equal(chatPreview("", 1, { kind: "service" }), "Service shared");
  assert.equal(chatPreview("", 0, { kind: "order" }), "Order shared");
  assert.equal(chatPreview("", 0, { kind: "free" }), "Free Item shared");
  assert.equal(chatPreview("Visible text", 0, { kind: "order" }), "Visible text");
});

test("authoritative IDs deduplicate Realtime and submission acknowledgement without replacing other snapshots", () => {
  const first = { id: listing, createdAt: "2026-11-26T02:00:00Z", reference: { kind: "product", title: "Hawas Fire" } };
  const next = { id: variant, createdAt: "2026-11-26T02:01:00Z", reference: { kind: "free", title: "Textbooks" } };
  const edit = { ...first, body: "Edited text" };
  assert.deepEqual(mergeOrderedMessages([first, next], [next, edit]), [edit, next]);
});

test("entry points prepare drafts while only an explicit listing controls the bargain form", () => {
  const actions = read("src/app/messages/actions.ts");
  const open = actions.slice(actions.indexOf("export async function startConversationAction"), actions.indexOf("export async function sendMessageAction"));
  assert.doesNotMatch(open, /sendMessageAction|initialMessage|\.from\("messages"\)/);
  assert.match(open, /orderItemId/);
  assert.match(open, /params\.set\("draft",/);
  for (const file of ["BuyerOrderDetails.tsx", "SellerOrderDetails.tsx"]) {
    const detail = read(`src/components/orders/${file}`);
    assert.match(detail, /itemAction=.*orderItemId=\{item\.id\}/);
    assert.doesNotMatch(detail, /OrderContact[^>]+items\[0\]/);
  }
  const data = read("src/lib/messages/data.ts");
  assert.match(data, /activeListingId = requestedId === activeConversationId/);
  assert.match(data, /activeListingRow\?\.seller_id === activePeer/);
  assert.doesNotMatch(read("src/components/messages/MessagesClient.tsx"), /listingDetailsPanel|aria-label="Listing and seller details"/);
});

test("rollback embeds the exact migration with participant, privacy, retry and history assertions", () => {
  const sql = read("docs/sql/phase-10m-contextual-messaging.sql");
  const verify = read("docs/sql/phase-10m-contextual-messaging.verify.sql");
  const body = sql.match(/^BEGIN;\n([\s\S]*?)^COMMIT;$/m)?.[1];
  const embedded = verify.match(/^-- BEGIN EMBEDDED MIGRATION BODY\n([\s\S]*?)^-- END EMBEDDED MIGRATION BODY$/m)?.[1];
  assert.ok(body);
  assert.equal(embedded, body);
  assert.equal(verify.match(/^BEGIN;$/gm)?.length, 1);
  assert.match(verify, /ROLLBACK;\s*$/);
  assert.match(sql, /REVOKE SELECT \(context_ref\)/);
  const published = sql.match(/ALTER PUBLICATION supabase_realtime ADD TABLE public\.messages \(([^)]+)\)/)?.[1];
  assert.deepEqual(published?.split(",").map((column) => column.trim()), [
    "id", "conversation_id", "sender_id", "body", "image_paths", "listing_id", "order_id",
    "free_notice_id", "service_request_id", "edited_at", "created_at",
  ]);
  assert.doesNotMatch(sql, /CREATE POLICY[\s\S]*?FOR UPDATE/i);
  assert.match(verify, /Authenticated sender bypassed hosted UPDATE policy/);
  assert.match(verify, /Privileged writer bypassed snapshot immutability/);
  assert.match(read("src/components/messages/MessagesClient.tsx"), /loadChatReferences\(supabase, \[raw.id\]\)/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(verify, /PHASE_10M_VERIFY_PASSED/);
});
