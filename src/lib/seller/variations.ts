import type { VariantDraftInput } from "./listing-edit";

export const SUGGESTED_VARIATION_TYPES = [
  "Colour",
  "Size",
  "Fragrance",
  "Flavour",
  "Design",
  "Edition",
] as const;

export const MAX_VARIATION_TYPES = 2;
export const MAX_VARIATION_COMBINATIONS = 50;

export interface SharedListingPhotoRef {
  key: string;
  url: string;
  storagePath: string | null;
}

export interface VariationGroupConfig {
  name: string;
  options: string[];
}

export interface BuyerVariantRecord {
  id: string;
  label: string;
  optionValues: Record<string, string>;
  priceSen: number;
  quantity: number;
  reservedQuantity: number;
  availableStock: number;
  active: boolean;
  imageUrl?: string | null;
  imagePath?: string | null;
}

export function normalizeOptionKey(value: string): string {
  return value.trim().toLowerCase();
}

export function resolveVariationPhotoGroupDefault(
  groupNames: string[]
): string | null {
  const clean = groupNames.map((g) => g.trim()).filter(Boolean);
  if (clean.length === 0) return null;
  if (clean.length === 1) return clean[0]!;
  const preferred = clean.find((g) =>
    /\b(colou?r|fragrance|flavour|flavor|design|edition|scent|style|pattern)\b/i.test(
      g
    )
  );
  return preferred ?? clean[0]!;
}

/**
 * Builds deterministic case-insensitive combo key for 1 or 2 variation groups.
 */
export function buildVariantComboKey(
  groups: string[],
  optionValues: Record<string, string>
): string {
  return groups
    .map((g) => `${normalizeOptionKey(g)}=${normalizeOptionKey(optionValues[g] ?? "")}`)
    .join("|");
}

/**
 * Formats variation values cleanly without repeating the listing title, e.g. "Black · XL".
 */
export function formatVariationOptionLabel(
  optionValues: Record<string, unknown> | null | undefined
): string {
  if (!optionValues || typeof optionValues !== "object") return "Standard";
  const parts = Object.values(optionValues)
    .map((v) => String(v ?? "").trim())
    .filter((v) => v.length > 0);
  return parts.length > 0 ? parts.join(" · ") : "Standard";
}

/**
 * Resolves a variation option value even if a legacy record stored slightly different key casing.
 */
export function getOptionValueForGroup(
  optionValues: Record<string, string> | null | undefined,
  groupName: string
): string {
  if (!optionValues) return "";
  if (Object.prototype.hasOwnProperty.call(optionValues, groupName)) {
    return String(optionValues[groupName] ?? "").trim();
  }
  const target = normalizeOptionKey(groupName);
  for (const [k, v] of Object.entries(optionValues)) {
    if (normalizeOptionKey(k) === target) {
      return String(v ?? "").trim();
    }
  }
  return "";
}

/**
 * Generates automatic combinations from 1 or 2 VariationGroupConfig entries while
 * preserving existing variant IDs, prices, quantities, reserved counts, active flags,
 * and assigned photo references. Brand-new combinations default stock to "0".
 */
export function generateVariationCombinations(input: {
  groups: VariationGroupConfig[];
  existingRows: VariantDraftInput[];
  optionPhotoMap: Record<string, string | null>;
  photoGroupName: string | null;
  defaultPriceRm: string;
}): {
  combinations: VariantDraftInput[];
  droppedProtectedRows: VariantDraftInput[];
  capped: boolean;
} {
  const validGroups = input.groups
    .map((g) => ({
      name: g.name.trim(),
      options: Array.from(
        new Map(
          g.options
            .map((o) => o.trim())
            .filter(Boolean)
            .map((o) => [normalizeOptionKey(o), o])
        ).values()
      ),
    }))
    .filter((g) => g.name.length > 0 && g.options.length > 0)
    .slice(0, MAX_VARIATION_TYPES);

  if (validGroups.length === 0) {
    const protectedRows = input.existingRows.filter(
      (r) => (r.reservedQuantity ?? 0) > 0
    );
    return {
      combinations: [],
      droppedProtectedRows: protectedRows,
      capped: false,
    };
  }

  const groupNames = validGroups.map((g) => g.name);
  const existingByKey = new Map<string, VariantDraftInput>();
  for (const row of input.existingRows) {
    const key = buildVariantComboKey(groupNames, row.optionValues);
    if (!existingByKey.has(key)) {
      existingByKey.set(key, row);
    }
  }

  const rawCombos: Array<Record<string, string>> = [];
  if (validGroups.length === 1) {
    const g1 = validGroups[0]!;
    for (const opt1 of g1.options) {
      rawCombos.push({ [g1.name]: opt1 });
    }
  } else {
    const g1 = validGroups[0]!;
    const g2 = validGroups[1]!;
    for (const opt1 of g1.options) {
      for (const opt2 of g2.options) {
        rawCombos.push({ [g1.name]: opt1, [g2.name]: opt2 });
      }
    }
  }

  const capped = rawCombos.length > MAX_VARIATION_COMBINATIONS;
  const boundedCombos = rawCombos.slice(0, MAX_VARIATION_COMBINATIONS);
  const matchedKeys = new Set<string>();
  const cleanDefaultPrice =
    input.defaultPriceRm.trim() && Number(input.defaultPriceRm) >= 2
      ? input.defaultPriceRm.trim()
      : "15.00";

  const combinations: VariantDraftInput[] = boundedCombos.map((optionValues) => {
    const comboKey = buildVariantComboKey(groupNames, optionValues);
    matchedKeys.add(comboKey);
    const existing = existingByKey.get(comboKey);

    let mappedPhotoKey: string | null = existing?.imagePath ?? null;
    if (input.photoGroupName) {
      const photoOptVal = getOptionValueForGroup(optionValues, input.photoGroupName);
      if (photoOptVal) {
        const optKey = normalizeOptionKey(photoOptVal);
        if (Object.prototype.hasOwnProperty.call(input.optionPhotoMap, optKey)) {
          mappedPhotoKey = input.optionPhotoMap[optKey] ?? null;
        }
      }
    } else {
      mappedPhotoKey = null;
    }

    if (existing) {
      return {
        ...existing,
        optionValues,
        imagePath: mappedPhotoKey,
      };
    }

    return {
      optionValues,
      priceRm: cleanDefaultPrice,
      quantity: "0",
      reservedQuantity: 0,
      active: true,
      imagePath: mappedPhotoKey,
    };
  });

  const droppedProtectedRows = input.existingRows.filter((row) => {
    if ((row.reservedQuantity ?? 0) <= 0 && !row.isLocked) return false;
    const key = buildVariantComboKey(groupNames, row.optionValues);
    return !matchedKeys.has(key);
  });

  return { combinations, droppedProtectedRows, capped };
}

/**
 * Reconstructs seller VariationGroupConfig[] and option-to-photo mapping from persisted variants.
 */
export function extractVariationSetupFromVariants(input: {
  optionGroups: string[];
  variants: VariantDraftInput[];
  variationPhotoGroup?: string | null;
}): {
  groups: VariationGroupConfig[];
  photoGroupName: string | null;
  optionPhotoMap: Record<string, string | null>;
} {
  const cleanNames = input.optionGroups
    .map((g) => g.trim())
    .filter(Boolean)
    .slice(0, MAX_VARIATION_TYPES);

  if (cleanNames.length === 0) {
    return { groups: [], photoGroupName: null, optionPhotoMap: {} };
  }

  const groups: VariationGroupConfig[] = cleanNames.map((name) => {
    const seen = new Map<string, string>();
    for (const v of input.variants) {
      const val = getOptionValueForGroup(v.optionValues, name);
      if (val && !seen.has(normalizeOptionKey(val))) {
        seen.set(normalizeOptionKey(val), val);
      }
    }
    return { name, options: Array.from(seen.values()) };
  });

  const photoGroupName =
    input.variationPhotoGroup !== undefined
      ? input.variationPhotoGroup &&
        cleanNames.some(
          (g) => normalizeOptionKey(g) === normalizeOptionKey(input.variationPhotoGroup!)
        )
        ? cleanNames.find(
            (g) => normalizeOptionKey(g) === normalizeOptionKey(input.variationPhotoGroup!)
          ) ?? null
        : null
      : resolveVariationPhotoGroupDefault(cleanNames);

  const optionPhotoMap: Record<string, string | null> = {};
  if (photoGroupName) {
    for (const v of input.variants) {
      if (!v.imagePath) continue;
      const val = getOptionValueForGroup(v.optionValues, photoGroupName);
      if (val && !optionPhotoMap[normalizeOptionKey(val)]) {
        optionPhotoMap[normalizeOptionKey(val)] = v.imagePath;
      }
    }
  }

  return { groups, photoGroupName, optionPhotoMap };
}

export interface BuyerOptionPill {
  value: string;
  selected: boolean;
  enabled: boolean;
  availableStock: number;
  imageUrl: string | null;
}

export interface BuyerVariationGroupView {
  groupName: string;
  hasThumbnails: boolean;
  options: BuyerOptionPill[];
}

export interface BuyerVariationSelectionState {
  groups: BuyerVariationGroupView[];
  isComplete: boolean;
  resolvedVariant: BuyerVariantRecord | null;
  effectivePhotoGroup: string | null;
  activeImageUrl: string | null;
  priceDisplay: {
    isExact: boolean;
    minSen: number;
    maxSen: number;
  };
  selectionPrompt: string | null;
}

/**
 * Authoritative buyer-side variation resolver supporting 1-level & 2-level bidirectional
 * availability filtering, photo synchronization, and price/stock computation.
 */
export function resolveBuyerVariationState(input: {
  optionGroups: string[];
  variants: BuyerVariantRecord[];
  selectedOptions: Record<string, string | null>;
  variationPhotoGroup?: string | null;
  fallbackPriceSen: number;
}): BuyerVariationSelectionState {
  const activeVariants = input.variants.filter((v) => v.active);

  // Derive group names from listing.optionGroups or fallback from variant keys
  const groupNames =
    input.optionGroups.length > 0
      ? input.optionGroups.map((g) => g.trim()).filter(Boolean).slice(0, 2)
      : activeVariants[0]
        ? Object.keys(activeVariants[0].optionValues).slice(0, 2)
        : [];

  if (groupNames.length === 0 || activeVariants.length === 0) {
    return {
      groups: [],
      isComplete: false,
      resolvedVariant: null,
      effectivePhotoGroup: null,
      activeImageUrl: null,
      priceDisplay: {
        isExact: true,
        minSen: input.fallbackPriceSen,
        maxSen: input.fallbackPriceSen,
      },
      selectionPrompt: null,
    };
  }

  const effectivePhotoGroup =
    input.variationPhotoGroup !== undefined
      ? input.variationPhotoGroup &&
        groupNames.some(
          (g) => normalizeOptionKey(g) === normalizeOptionKey(input.variationPhotoGroup!)
        )
        ? groupNames.find(
            (g) => normalizeOptionKey(g) === normalizeOptionKey(input.variationPhotoGroup!)
          ) ?? null
        : null
      : resolveVariationPhotoGroupDefault(groupNames);

  // Build ordered unique options per group
  const optionsByGroup = new Map<string, string[]>();
  for (const gName of groupNames) {
    const seen = new Map<string, string>();
    for (const v of activeVariants) {
      const val = getOptionValueForGroup(v.optionValues, gName);
      if (val && !seen.has(normalizeOptionKey(val))) {
        seen.set(normalizeOptionKey(val), val);
      }
    }
    optionsByGroup.set(gName, Array.from(seen.values()));
  }

  const groups: BuyerVariationGroupView[] = groupNames.map((gName) => {
    const opts = optionsByGroup.get(gName) ?? [];
    const currentVal = input.selectedOptions[gName] ?? null;
    const isPhotoGroup =
      effectivePhotoGroup !== null &&
      normalizeOptionKey(gName) === normalizeOptionKey(effectivePhotoGroup);

    // Filter variants by all OTHER currently selected groups for bidirectional filtering
    const otherGroupMatches = activeVariants.filter((v) =>
      groupNames.every((otherName) => {
        if (otherName === gName) return true;
        const otherSel = input.selectedOptions[otherName];
        if (!otherSel) return true;
        return (
          normalizeOptionKey(getOptionValueForGroup(v.optionValues, otherName)) ===
          normalizeOptionKey(otherSel)
        );
      })
    );

    const pills: BuyerOptionPill[] = opts.map((optVal) => {
      const matching = otherGroupMatches.filter(
        (v) =>
          normalizeOptionKey(getOptionValueForGroup(v.optionValues, gName)) ===
          normalizeOptionKey(optVal)
      );
      const totalStock = matching.reduce(
        (sum, v) => sum + Math.max(0, v.availableStock),
        0
      );
      // Single-group: keep sold-out visible & selectable to preview photo/price;
      // Two-group: bidirectionally disable options with 0 stock or nonexistent combinations.
      const enabled =
        groupNames.length === 1
          ? matching.length > 0
          : matching.some((v) => v.availableStock > 0);

      // Find representative image for this option across ALL active variants
      const anyForOption = activeVariants.filter(
        (v) =>
          normalizeOptionKey(getOptionValueForGroup(v.optionValues, gName)) ===
          normalizeOptionKey(optVal)
      );
      const imageUrl = isPhotoGroup
        ? anyForOption.find((v) => Boolean(v.imageUrl))?.imageUrl ?? null
        : null;

      return {
        value: optVal,
        selected:
          Boolean(currentVal) &&
          normalizeOptionKey(currentVal!) === normalizeOptionKey(optVal),
        enabled,
        availableStock: totalStock,
        imageUrl,
      };
    });

    const hasThumbnails = isPhotoGroup && pills.some((p) => Boolean(p.imageUrl));

    return {
      groupName: gName,
      hasThumbnails,
      options: pills,
    };
  });

  const missingGroups = groupNames.filter(
    (g) => !(input.selectedOptions[g] ?? "").trim()
  );
  const isComplete = missingGroups.length === 0;

  const matchingVariants = activeVariants.filter((v) =>
    groupNames.every((gName) => {
      const sel = input.selectedOptions[gName];
      if (!sel) return true;
      return (
        normalizeOptionKey(getOptionValueForGroup(v.optionValues, gName)) ===
        normalizeOptionKey(sel)
      );
    })
  );

  const resolvedVariant =
    isComplete && matchingVariants.length === 1 ? matchingVariants[0]! : null;

  // Compute price or valid range from matching available combinations (or all active combinations)
  const pricePool = matchingVariants.filter((v) => v.availableStock > 0);
  const pool =
    resolvedVariant
      ? [resolvedVariant]
      : pricePool.length > 0
        ? pricePool
        : matchingVariants.length > 0
          ? matchingVariants
          : activeVariants;

  let minSen = pool[0]?.priceSen ?? input.fallbackPriceSen;
  let maxSen = pool[0]?.priceSen ?? input.fallbackPriceSen;
  for (const v of pool) {
    if (v.priceSen < minSen) minSen = v.priceSen;
    if (v.priceSen > maxSen) maxSen = v.priceSen;
  }

  // Image synchronization: photo-enabled option selection updates main image immediately,
  // even before the second variation type is chosen.
  let activeImageUrl: string | null = resolvedVariant?.imageUrl ?? null;
  if (!activeImageUrl && effectivePhotoGroup) {
    const photoSel = input.selectedOptions[effectivePhotoGroup];
    if (photoSel) {
      activeImageUrl =
        activeVariants.find(
          (v) =>
            normalizeOptionKey(
              getOptionValueForGroup(v.optionValues, effectivePhotoGroup)
            ) === normalizeOptionKey(photoSel) && Boolean(v.imageUrl)
        )?.imageUrl ?? null;
    }
  }

  const selectionPrompt =
    missingGroups.length > 0
      ? `Select ${missingGroups.join(" & ")} to see exact stock & add to cart`
      : null;

  return {
    groups,
    isComplete,
    resolvedVariant,
    effectivePhotoGroup,
    activeImageUrl,
    priceDisplay: {
      isExact: Boolean(resolvedVariant) || minSen === maxSen,
      minSen,
      maxSen,
    },
    selectionPrompt,
  };
}
