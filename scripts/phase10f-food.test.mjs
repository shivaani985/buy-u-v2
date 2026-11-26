import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { foodAvailability, readFoodForm } from "../src/lib/food.ts";
import { parseToyyibPayPaidAt } from "../src/lib/payments/toyyibpay.ts";

function readyForm(values) {
  const form = new FormData();
  Object.entries(values).forEach(([key, value]) => form.set(key, value));
  return form;
}

const now = Date.parse("2026-11-26T00:00:00Z");
const preorder = {
  availabilityMode: "pre_order",
  preorderCloseAt: "2026-11-27T02:00:00Z",
  pickupWindowStart: "2026-11-27T04:00:00Z",
  pickupWindowEnd: "2026-11-27T06:00:00Z",
};

test("Packaged Food requires acknowledgment on publish and clears unused terms", () => {
  const form = readyForm({ availabilityMode: "ready", preorderCloseAt: "2026-11-27T10:00" });
  assert.ok(readFoodForm(form, true, true, now).error);
  assert.equal(readFoodForm(form, true, false, now).error, null);
  form.set("packagedFoodAcknowledged", "on");
  const { payload, error } = readFoodForm(form, true, true, now);
  assert.equal(error, null);
  assert.equal(payload.packaged_food_acknowledged, true);
  assert.equal(payload.preorder_close_at, null);
});

test("Pre-order schedules validate against MYT and reject impossible dates and past cutoff", () => {
  const form = readyForm({
    availabilityMode: "pre_order", preorderCloseAt: "2026-11-27T10:00",
    collectionDate: "2026-11-27", collectionStart: "12:00", collectionEnd: "14:00",
  });
  const { payload, error } = readFoodForm(form, true, true, now);
  assert.equal(error, null);
  assert.equal(payload.preorder_close_at, "2026-11-27T02:00:00.000Z");
  assert.equal(payload.pickup_window_end, "2026-11-27T06:00:00.000Z");
  assert.ok(readFoodForm(form, true, true, Date.parse(preorder.preorderCloseAt)).error);
  form.set("collectionDate", "2026-11-31");
  assert.ok(readFoodForm(form, true, true, now).error);
});

test("Pending reservations differ from paid exhaustion and release cannot reopen a closed event", () => {
  assert.equal(foodAvailability(preorder, 30, 30, now), "Temporarily Unavailable");
  assert.equal(foodAvailability(preorder, 30, 29, now), "Pre-order Open");
  assert.equal(foodAvailability({ ...preorder, closedAt: "2026-11-26T00:00:00Z" }, 30, 0, now), "Pre-order Closed");
  assert.equal(foodAvailability(preorder, 0, 0, now), "Sold Out");
  assert.equal(foodAvailability(preorder, 30, 0, Date.parse(preorder.preorderCloseAt)), "Pre-order Closed");
});

test("only a valid, explicitly formatted provider transaction time becomes payment evidence", () => {
  assert.equal(parseToyyibPayPaidAt("27-11-2026 10:00:00"), "2026-11-27T02:00:00.000Z");
  assert.equal(parseToyyibPayPaidAt("31-11-2026 10:00:00"), null);
  assert.equal(parseToyyibPayPaidAt("2026-11-27"), null);
});

test("SQL rollback embeds the standalone migration exactly and forces deferred constraints", () => {
  const read = (suffix) => readFileSync(new URL(`../docs/sql/phase-10f-food-listings${suffix}.sql`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const migration = read("");
  const verifier = read(".verify");
  assert.equal(migration.match(/^BEGIN;\n([\s\S]*?)^COMMIT;$/m)?.[1],
    verifier.match(/^-- BEGIN EMBEDDED MIGRATION BODY\n([\s\S]*?)^-- END EMBEDDED MIGRATION BODY$/m)?.[1]);
  assert.match(verifier, /SET CONSTRAINTS ALL IMMEDIATE;\s*ROLLBACK;\s*$/);
  assert.match(migration, /verified_tx[^\n]+paidAt/);
  assert.match(migration, /FOOD_EVENT_SCHEDULE_LOCKED/);
});
