import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluateBuyerDisputeEligibility } from "../src/lib/disputes/validation.ts";
import { isEligibleForWithdrawalRelease } from "../src/lib/financials/policy.ts";
import { readOrderPages, readOrderRelations } from "../src/lib/orders/read.ts";
import { withOrderListQuery } from "../src/lib/orders/navigation.ts";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");

test("Phase 10O verification embeds the exact standalone migration body in one rollback transaction", () => {
  const migration = read("docs/sql/phase-10o-unified-order-completion.sql");
  const verification = read("docs/sql/phase-10o-unified-order-completion.verify.sql");
  const standalone = migration.match(/^BEGIN;\n\n([\s\S]+)\n\nCOMMIT;\n?$/)?.[1];
  const embedded = verification.match(/-- BEGIN EXACT STANDALONE MIGRATION BODY\n([\s\S]+)\n-- END EXACT STANDALONE MIGRATION BODY/)?.[1];
  assert.ok(standalone && embedded);
  assert.equal(embedded, standalone);
  assert.equal((verification.match(/^BEGIN;$/gm) ?? []).length, 1);
  assert.doesNotMatch(verification, /^COMMIT;/m);
  assert.match(verification, /\nROLLBACK;\n?$/);
});

test("stored seven-day deadlines remain authoritative for disputes and withdrawals", () => {
  const completedAt = "2026-11-08T03:00:00Z";
  const protectionExpiresAt = "2026-11-15T03:00:00Z";
  const before = Date.parse(protectionExpiresAt) - 1;
  const at = Date.parse(protectionExpiresAt);
  const order = { status: "completed", paidAt: completedAt, completedAt, protectionExpiresAt, hasActiveDispute: false };
  assert.equal(evaluateBuyerDisputeEligibility({ ...order, nowMs: before }).eligible, true);
  assert.equal(evaluateBuyerDisputeEligibility({ ...order, nowMs: at }).eligible, false);
  assert.equal(isEligibleForWithdrawalRelease(completedAt, before, protectionExpiresAt), false);
  assert.equal(isEligibleForWithdrawalRelease(completedAt, at, protectionExpiresAt), true);
});

test("order detail navigation preserves only supported list controls", () => {
  assert.equal(withOrderListQuery("/orders", {
    status: "to-pay", type: "services", q: "A & B", sort: "oldest", review: "1", url: "https://example.test",
  }), "/orders?status=to-pay&type=services&q=A+%26+B&sort=oldest");
  assert.equal(withOrderListQuery("/orders", { status: ["completed", "cancelled"] }), "/orders");
});

test("plain PINs are fetched only through the acknowledged buyer operation", () => {
  const actions = read("src/app/orders/actions.ts");
  for (const file of ["src/lib/orders/data.ts", "src/lib/orders/seller-data.ts", "src/app/orders/return/page.tsx"]) {
    assert.doesNotMatch(read(file).replace(/^\s*\*.*$/gm, ""), /get_buyer_order_pickup_pins|reveal_order_completion_pin|\bpickup_pin\b|\bpickupPin\b/);
  }
  assert.match(actions, /acknowledged !== true/);
  assert.match(actions, /rpc\("reveal_order_completion_pin"/);
  assert.match(actions, /p_acknowledged: true/);
});

test("payment resumes verify reusable bills and temporary gateway failures receive a retryable callback response", () => {
  const library = read("src/lib/payments/toyyibpay-server.ts");
  const checkout = read("src/components/checkout/CheckoutClient.tsx");
  const callback = read("src/app/api/payments/toyyibpay/callback/route.ts");
  assert.equal((library.match(/await getBillResumeError\(claim\.bill_code/g) ?? []).length, 2);
  assert.match(library, /result\.outcome === "late_payment_reconciliation"/);
  assert.doesNotMatch(checkout, /href=\{readyCheckout\.billUrl\}/);
  assert.match(callback, /status: 503/);
});

test("order data reads preserve every page and bound relation filter size", async () => {
  const orders = Array.from({ length: 501 }, (_, index) => index);
  const pages = await readOrderPages(async (first, last) => ({ data: orders.slice(first, last + 1), error: null }));
  assert.deepEqual(pages.data, orders);

  const ids = Array.from({ length: 121 }, (_, index) => String(index));
  const batchSizes = [];
  const related = await readOrderRelations(ids, async (batch) => {
    batchSizes.push(batch.length);
    return { data: batch, error: null };
  });
  assert.deepEqual(batchSizes, [60, 60, 1]);
  assert.deepEqual(related.data, ids);
});
