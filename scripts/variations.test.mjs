import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_VARIATION_COMBINATIONS,
  extractVariationSetupFromVariants,
  formatVariationOptionLabel,
  generateVariationCombinations,
  resolveBuyerVariationState,
} from "../src/lib/seller/variations.ts";

test("generateVariationCombinations preserves existing variant state and defaults new combos to stock 0", () => {
  const existing = [
    {
      id: "v-black-m",
      optionValues: { Colour: "Black", Size: "M" },
      priceRm: "29.90",
      quantity: "8",
      reservedQuantity: 2,
      active: true,
      imagePath: "photo-black",
    },
    {
      id: "v-locked-white-m",
      optionValues: { Colour: "White", Size: "M" },
      priceRm: "29.90",
      quantity: "3",
      reservedQuantity: 1,
      isLocked: true,
      active: true,
      imagePath: "photo-white",
    },
  ];

  // Add Size "L" and remove "White" (which is reserved/locked)
  const result = generateVariationCombinations({
    groups: [
      { name: "Colour", options: ["Black", "Cream"] },
      { name: "Size", options: ["M", "L"] },
    ],
    existingRows: existing,
    optionPhotoMap: {
      black: "photo-black-updated",
      cream: "photo-cream",
    },
    photoGroupName: "Colour",
    defaultPriceRm: "25.00",
  });

  assert.equal(result.capped, false);
  assert.equal(result.combinations.length, 4);
  assert.equal(result.droppedProtectedRows.length, 1);
  assert.equal(result.droppedProtectedRows[0]?.id, "v-locked-white-m");

  const keptBlackM = result.combinations.find(
    (c) => c.optionValues.Colour === "Black" && c.optionValues.Size === "M"
  );
  assert.equal(keptBlackM?.id, "v-black-m");
  assert.equal(keptBlackM?.priceRm, "29.90");
  assert.equal(keptBlackM?.quantity, "8");
  assert.equal(keptBlackM?.reservedQuantity, 2);
  assert.equal(keptBlackM?.imagePath, "photo-black-updated");

  const brandNewCreamL = result.combinations.find(
    (c) => c.optionValues.Colour === "Cream" && c.optionValues.Size === "L"
  );
  assert.equal(brandNewCreamL?.id, undefined);
  assert.equal(brandNewCreamL?.priceRm, "25.00");
  assert.equal(brandNewCreamL?.quantity, "0");
  assert.equal(brandNewCreamL?.imagePath, "photo-cream");
});

test("generateVariationCombinations caps combinations at MAX_VARIATION_COMBINATIONS (50)", () => {
  const result = generateVariationCombinations({
    groups: [
      { name: "Colour", options: ["C1", "C2", "C3", "C4", "C5", "C6"] },
      { name: "Size", options: ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10"] },
    ],
    existingRows: [],
    optionPhotoMap: {},
    photoGroupName: "Colour",
    defaultPriceRm: "10.00",
  });

  assert.equal(result.capped, true);
  assert.equal(result.combinations.length, MAX_VARIATION_COMBINATIONS);
});

test("extractVariationSetupFromVariants reconstructs groups and option photos accurately", () => {
  const setup = extractVariationSetupFromVariants({
    optionGroups: ["Colour", "Size"],
    variationPhotoGroup: "Colour",
    variants: [
      {
        id: "1",
        optionValues: { Colour: "Black", Size: "M" },
        priceRm: "18.00",
        quantity: "4",
        active: true,
        imagePath: "listings/seller/black.jpg",
      },
      {
        id: "2",
        optionValues: { Colour: "Black", Size: "L" },
        priceRm: "18.00",
        quantity: "2",
        active: true,
        imagePath: "listings/seller/black.jpg",
      },
      {
        id: "3",
        optionValues: { Colour: "Teal", Size: "M" },
        priceRm: "20.00",
        quantity: "0",
        active: true,
        imagePath: "listings/seller/teal.jpg",
      },
    ],
  });

  assert.equal(setup.photoGroupName, "Colour");
  assert.deepEqual(setup.groups, [
    { name: "Colour", options: ["Black", "Teal"] },
    { name: "Size", options: ["M", "L"] },
  ]);
  assert.deepEqual(setup.optionPhotoMap, {
    black: "listings/seller/black.jpg",
    teal: "listings/seller/teal.jpg",
  });
});

test("resolveBuyerVariationState handles 1-variation sold-out preview and photo switching", () => {
  const variants = [
    {
      id: "v1",
      label: "Vanilla",
      optionValues: { Fragrance: "Vanilla" },
      priceSen: 1500,
      quantity: 3,
      reservedQuantity: 0,
      availableStock: 3,
      active: true,
      imageUrl: "https://cdn.example/vanilla.jpg",
    },
    {
      id: "v2",
      label: "Rose",
      optionValues: { Fragrance: "Rose" },
      priceSen: 2000,
      quantity: 1,
      reservedQuantity: 1,
      availableStock: 0,
      active: true,
      imageUrl: "https://cdn.example/rose.jpg",
    },
    {
      id: "v3",
      label: "Lavender",
      optionValues: { Fragrance: "Lavender" },
      priceSen: 2500,
      quantity: 2,
      reservedQuantity: 0,
      availableStock: 2,
      active: true,
      imageUrl: "https://cdn.example/lavender.jpg",
    },
  ];

  // Unselected start: shows purchasable range RM 15.00 - RM 25.00 (excludes 0-stock option)
  const initial = resolveBuyerVariationState({
    optionGroups: ["Fragrance"],
    variants,
    selectedOptions: {},
    variationPhotoGroup: "Fragrance",
    fallbackPriceSen: 1500,
  });
  assert.equal(initial.isComplete, false);
  assert.equal(initial.resolvedVariant, null);
  assert.equal(initial.activeImageUrl, null);
  assert.deepEqual(initial.priceDisplay, {
    isExact: false,
    minSen: 1500,
    maxSen: 2500,
  });

  // Sold-out 1-var option stays enabled for photo + price preview
  const roseOption = initial.groups[0]?.options.find((o) => o.value === "Rose");
  assert.equal(roseOption?.enabled, true);
  assert.equal(roseOption?.availableStock, 0);

  const selectedSoldOut = resolveBuyerVariationState({
    optionGroups: ["Fragrance"],
    variants,
    selectedOptions: { Fragrance: "Rose" },
    variationPhotoGroup: "Fragrance",
    fallbackPriceSen: 1500,
  });
  assert.equal(selectedSoldOut.isComplete, true);
  assert.equal(selectedSoldOut.resolvedVariant?.id, "v2");
  assert.equal(selectedSoldOut.resolvedVariant?.availableStock, 0);
  assert.equal(selectedSoldOut.activeImageUrl, "https://cdn.example/rose.jpg");
  assert.deepEqual(selectedSoldOut.priceDisplay, {
    isExact: true,
    minSen: 2000,
    maxSen: 2000,
  });
});

test("resolveBuyerVariationState performs 2-variation bidirectional filtering and immediate photo sync", () => {
  const variants = [
    {
      id: "bm",
      label: "Black · M",
      optionValues: { Colour: "Black", Size: "M" },
      priceSen: 2500,
      quantity: 4,
      reservedQuantity: 0,
      availableStock: 4,
      active: true,
      imageUrl: "https://cdn.example/black.jpg",
    },
    {
      id: "bl",
      label: "Black · L",
      optionValues: { Colour: "Black", Size: "L" },
      priceSen: 2500,
      quantity: 0,
      reservedQuantity: 0,
      availableStock: 0,
      active: true,
      imageUrl: "https://cdn.example/black.jpg",
    },
    {
      id: "tl",
      label: "Teal · L",
      optionValues: { Colour: "Teal", Size: "L" },
      priceSen: 2800,
      quantity: 2,
      reservedQuantity: 0,
      availableStock: 2,
      active: true,
      imageUrl: "https://cdn.example/teal.jpg",
    },
  ];

  // Pick Colour = Black -> image syncs immediately before picking Size, Size L disabled (0 stock), Size M enabled
  const step1 = resolveBuyerVariationState({
    optionGroups: ["Colour", "Size"],
    variants,
    selectedOptions: { Colour: "Black" },
    variationPhotoGroup: "Colour",
    fallbackPriceSen: 2500,
  });
  assert.equal(step1.isComplete, false);
  assert.equal(step1.activeImageUrl, "https://cdn.example/black.jpg");
  assert.equal(step1.selectionPrompt, "Select Size to see exact stock & add to cart");

  const sizeGroupAfterBlack = step1.groups.find((g) => g.groupName === "Size");
  assert.equal(
    sizeGroupAfterBlack?.options.find((o) => o.value === "M")?.enabled,
    true
  );
  assert.equal(
    sizeGroupAfterBlack?.options.find((o) => o.value === "L")?.enabled,
    false
  );

  // Reverse direction: pick Size = L -> Black disabled (0 stock), Teal enabled
  const reverse = resolveBuyerVariationState({
    optionGroups: ["Colour", "Size"],
    variants,
    selectedOptions: { Size: "L" },
    variationPhotoGroup: "Colour",
    fallbackPriceSen: 2500,
  });
  const colourGroupAfterL = reverse.groups.find((g) => g.groupName === "Colour");
  assert.equal(
    colourGroupAfterL?.options.find((o) => o.value === "Black")?.enabled,
    false
  );
  assert.equal(
    colourGroupAfterL?.options.find((o) => o.value === "Teal")?.enabled,
    true
  );

  // Complete Teal + L -> exact price & image
  const complete = resolveBuyerVariationState({
    optionGroups: ["Colour", "Size"],
    variants,
    selectedOptions: { Colour: "Teal", Size: "L" },
    variationPhotoGroup: "Colour",
    fallbackPriceSen: 2500,
  });
  assert.equal(complete.isComplete, true);
  assert.equal(complete.resolvedVariant?.id, "tl");
  assert.equal(complete.activeImageUrl, "https://cdn.example/teal.jpg");
  assert.deepEqual(complete.priceDisplay, {
    isExact: true,
    minSen: 2800,
    maxSen: 2800,
  });
});

test("formatVariationOptionLabel formats concise option labels without listing prefix", () => {
  assert.equal(
    formatVariationOptionLabel({ Colour: "Black", Size: "XL" }),
    "Black · XL"
  );
  assert.equal(formatVariationOptionLabel({ Edition: "Hardcover" }), "Hardcover");
  assert.equal(formatVariationOptionLabel(null), "Standard");
});
