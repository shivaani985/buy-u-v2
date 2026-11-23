import assert from "node:assert/strict";
import test from "node:test";
import {
  isValidUuid,
  mapAtomicUpdateError,
  validateListingEditInput,
  validateStatusTransition,
  validateStockUpdate,
  validateVariantsInput,
} from "../src/lib/seller/listing-edit.ts";

test("isValidUuid validates UUIDs strictly", () => {
  assert.equal(isValidUuid("2990db4c-11d6-4ec9-b4dd-5209a80ed74f"), true);
  assert.equal(isValidUuid("not-a-uuid"), false);
  assert.equal(isValidUuid("../etc/passwd"), false);
});

test("validateStatusTransition allows draft/published/archived and blocks removed", () => {
  assert.deepEqual(validateStatusTransition("draft", "published"), {
    ok: true,
    status: "published",
  });
  assert.deepEqual(validateStatusTransition("published", "archived"), {
    ok: true,
    status: "archived",
  });
  assert.deepEqual(validateStatusTransition("archived", "draft"), {
    ok: true,
    status: "draft",
  });
  assert.equal(validateStatusTransition("removed", "published").ok, false);
  assert.equal(validateStatusTransition("draft", "deleted").ok, false);
});

test("validateStockUpdate protects reserved_quantity and allows 0 for Out of Stock", () => {
  assert.deepEqual(validateStockUpdate(0, 0, false), {
    ok: true,
    quantity: 0,
    availableStock: 0,
  });
  assert.deepEqual(validateStockUpdate(5, 2, false), {
    ok: true,
    quantity: 5,
    availableStock: 3,
  });
  // Cannot drop below reserved units
  assert.equal(validateStockUpdate(1, 2, false).ok, false);
  // Cannot be negative
  assert.equal(validateStockUpdate(-1, 0, false).ok, false);
});

test("validateVariantsInput enforces unique options, reserved stock, locked deletions and computes totals", () => {
  const existing = [
    {
      id: "v1",
      optionValues: { Size: "M" },
      priceSen: 2500,
      quantity: 5,
      reservedQuantity: 2,
      active: true,
    },
    {
      id: "v2",
      optionValues: { Size: "L" },
      priceSen: 3000,
      quantity: 4,
      reservedQuantity: 0,
      active: true,
    },
  ];
  const referenced = new Set(["v1"]);

  // Valid update: v1 active (qty >= 2), v2 active, XL inactive (omitted from p_variants so RPC sets active=false)
  const ok = validateVariantsInput({
    hasVariants: true,
    isService: false,
    targetStatus: "published",
    optionGroups: ["Size"],
    variants: [
      { id: "v1", optionValues: { Size: "M" }, priceRm: "25.00", quantity: 3, active: true },
      { id: "v2", optionValues: { Size: "L" }, priceRm: "28.50", quantity: 4, active: true },
      { optionValues: { Size: "XL" }, priceRm: "30.00", quantity: 2, active: false },
    ],
    existingVariants: existing,
    referencedVariantIds: referenced,
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.totalQuantity, 7); // active only: 3 + 4
    assert.equal(ok.minPriceSen, 2500);
    assert.equal(ok.variants?.length, 2); // inactive XL omitted from p_variants!
    assert.equal(ok.variants?.some((v) => v.option_values.Size === "XL"), false);
  }

  // Deactivating existing v2 (reservedQuantity=0) omits v2 from p_variants so RPC marks it active=false
  const deactivateV2 = validateVariantsInput({
    hasVariants: true,
    isService: false,
    targetStatus: "published",
    optionGroups: ["Size"],
    variants: [
      { id: "v1", optionValues: { Size: "M" }, priceRm: "25.00", quantity: 3, active: true },
      { id: "v2", optionValues: { Size: "L" }, priceRm: "28.50", quantity: 4, active: false },
    ],
    existingVariants: existing,
    referencedVariantIds: referenced,
  });
  assert.equal(deactivateV2.ok, true);
  if (deactivateV2.ok) {
    assert.equal(deactivateV2.variants?.length, 1);
    assert.equal(deactivateV2.variants?.[0]?.id, "v1");
  }

  // Blocks deactivating or omitting variant v1 which has reservedQuantity=2
  const delReserved = validateVariantsInput({
    hasVariants: true,
    isService: false,
    targetStatus: "published",
    optionGroups: ["Size"],
    variants: [
      { id: "v1", optionValues: { Size: "M" }, priceRm: "25.00", quantity: 3, active: false },
      { id: "v2", optionValues: { Size: "L" }, priceRm: "28.50", quantity: 4, active: true },
    ],
    existingVariants: existing,
    referencedVariantIds: referenced,
  });
  assert.equal(delReserved.ok, false);

  // Blocks reducing v1 quantity below its reservedQuantity (2)
  const lowQty = validateVariantsInput({
    hasVariants: true,
    isService: false,
    targetStatus: "published",
    optionGroups: ["Size"],
    variants: [
      { id: "v1", optionValues: { Size: "M" }, priceRm: "25.00", quantity: 1, active: true },
    ],
    existingVariants: existing,
    referencedVariantIds: referenced,
  });
  assert.equal(lowQty.ok, false);

  // Blocks duplicate option combinations
  const dup = validateVariantsInput({
    hasVariants: true,
    isService: false,
    targetStatus: "draft",
    optionGroups: ["Size"],
    variants: [
      { id: "v1", optionValues: { Size: "M" }, priceRm: "25.00", quantity: 2, active: true },
      { optionValues: { Size: "m" }, priceRm: "26.00", quantity: 2, active: true },
    ],
    existingVariants: existing,
    referencedVariantIds: referenced,
  });
  assert.equal(dup.ok, false);
});

test("validateListingEditInput enforces 5-photo cap, archiving, and out-of-stock edits", () => {
  // 5 total photos allowed (matches hosted RPC limit)
  const fivePhotosOk = validateListingEditInput({
    currentStatus: "published",
    currentReservedQuantity: 0,
    title: "IOT Box",
    description: "Student robotics kit in great condition.",
    listingType: "business",
    categoryId: "electronics",
    priceRm: "15.00",
    quantity: 1,
    collectionAreaId: "cafe-umskal",
    condition: "New/Unused",
    targetStatus: "published",
    rulesAcknowledged: true,
    allowOffers: false,
    keptPhotoPaths: ["a.png", "b.png", "c.png"],
    newPhotoCount: 2,
    hasVariants: false,
    optionGroups: [],
    variants: [],
    existingVariants: [],
    referencedVariantIds: new Set(),
  });
  assert.equal(fivePhotosOk.ok, true);

  // Exceeding 5 total photos is blocked
  const tooManyPhotos = validateListingEditInput({
    currentStatus: "published",
    currentReservedQuantity: 0,
    title: "IOT Box",
    description: "Student robotics kit in great condition.",
    listingType: "business",
    categoryId: "electronics",
    priceRm: "15.00",
    quantity: 0,
    collectionAreaId: "cafe-umskal",
    condition: "New/Unused",
    targetStatus: "published",
    rulesAcknowledged: true,
    allowOffers: false,
    keptPhotoPaths: ["a.png", "b.png", "c.png", "d.png"],
    newPhotoCount: 2,
    hasVariants: false,
    optionGroups: [],
    variants: [],
    existingVariants: [],
    referencedVariantIds: new Set(),
  });
  assert.equal(tooManyPhotos.ok, false);

  // Valid Out-of-Stock (qty=0) edit on published listing
  const outOfStock = validateListingEditInput({
    currentStatus: "published",
    currentReservedQuantity: 0,
    title: "IOT Box",
    description: "Student robotics kit in great condition.",
    listingType: "business",
    categoryId: "electronics",
    priceRm: "15.00",
    quantity: 0,
    collectionAreaId: "cafe-umskal",
    condition: "New/Unused",
    targetStatus: "published",
    rulesAcknowledged: true,
    allowOffers: false,
    keptPhotoPaths: ["a.png"],
    newPhotoCount: 0,
    hasVariants: false,
    optionGroups: [],
    variants: [],
    existingVariants: [],
    referencedVariantIds: new Set(),
  });
  assert.equal(outOfStock.ok, true);
  if (outOfStock.ok) {
    assert.equal(outOfStock.data.quantity, 0);
    assert.equal(outOfStock.data.status, "published");
  }

  // Archiving relaxes publish-only rules (keeps valid DB description >= 10 chars)
  const archived = validateListingEditInput({
    currentStatus: "draft",
    currentReservedQuantity: 0,
    title: "Old Draft",
    description: "Archived draft listing description.",
    listingType: "preloved",
    categoryId: "books",
    priceRm: "10.00",
    quantity: 1,
    collectionAreaId: "",
    condition: "",
    targetStatus: "archived",
    rulesAcknowledged: false,
    allowOffers: false,
    keptPhotoPaths: [],
    newPhotoCount: 0,
    hasVariants: false,
    optionGroups: [],
    variants: [],
    existingVariants: [],
    referencedVariantIds: new Set(),
  });
  assert.equal(archived.ok, true);
  if (archived.ok) {
    assert.equal(archived.data.status, "archived");
    assert.equal(archived.data.dbKind, "pre_loved");
  }
});

test("mapAtomicUpdateError maps concurrency conflicts and permission errors safely", () => {
  assert.match(
    mapAtomicUpdateError("concurrent modification: expected updated_at mismatch"),
    /Reload the page/i
  );
  assert.match(
    mapAtomicUpdateError("quantity cannot be less than reserved_quantity"),
    /reserved/i
  );
  assert.match(
    mapAtomicUpdateError("permission denied: not owner"),
    /permission/i
  );
});

test("description length boundaries enforce 20-3000 trimmed characters on create and edit", async () => {
  const { validateListingInput } = await import("../src/lib/seller/validation.ts");

  const baseCreate = {
    title: "Casio FX-570EX",
    listingType: "preloved",
    categoryId: "electronics",
    priceRm: "45.00",
    quantity: 1,
    collectionAreaId: "cafe-umskal",
    condition: "Like New",
    status: "draft",
    rulesAcknowledged: false,
  };

  const baseEdit = {
    currentStatus: "draft",
    currentReservedQuantity: 0,
    title: "Casio FX-570EX",
    listingType: "preloved",
    categoryId: "electronics",
    priceRm: "45.00",
    quantity: 1,
    collectionAreaId: "cafe-umskal",
    condition: "Like New",
    targetStatus: "draft",
    rulesAcknowledged: false,
    allowOffers: false,
    keptPhotoPaths: [],
    newPhotoCount: 0,
    hasVariants: false,
    optionGroups: [],
    variants: [],
    existingVariants: [],
    referencedVariantIds: new Set(),
  };

  // 19 trimmed chars (even with padding spaces) -> rejected
  assert.equal(validateListingInput({ ...baseCreate, description: `   ${"a".repeat(19)}   ` }).ok, false);
  assert.equal(validateListingEditInput({ ...baseEdit, description: `   ${"a".repeat(19)}   ` }).ok, false);

  // 20 trimmed chars -> accepted
  assert.equal(validateListingInput({ ...baseCreate, description: "a".repeat(20) }).ok, true);
  assert.equal(validateListingEditInput({ ...baseEdit, description: "a".repeat(20) }).ok, true);

  // 3000 trimmed chars -> accepted
  assert.equal(validateListingInput({ ...baseCreate, description: "a".repeat(3000) }).ok, true);
  assert.equal(validateListingEditInput({ ...baseEdit, description: "a".repeat(3000) }).ok, true);

  // 3001 trimmed chars -> rejected
  assert.equal(validateListingInput({ ...baseCreate, description: "a".repeat(3001) }).ok, false);
  assert.equal(validateListingEditInput({ ...baseEdit, description: "a".repeat(3001) }).ok, false);
});
