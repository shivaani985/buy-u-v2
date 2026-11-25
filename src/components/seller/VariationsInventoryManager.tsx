"use client";

import { useCallback, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ImagePlus,
  Layers,
  Lock,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { VariationPhotoPickerDialog } from "@/components/seller/VariationPhotoPickerDialog";
import type { VariantDraftInput } from "@/lib/seller/listing-edit";
import {
  MAX_VARIATION_COMBINATIONS,
  SUGGESTED_VARIATION_TYPES,
  generateVariationCombinations,
  getOptionValueForGroup,
  normalizeOptionKey,
  resolveVariationPhotoGroupDefault,
  type SharedListingPhotoRef,
  type VariationGroupConfig,
} from "@/lib/seller/variations";

interface VariationsInventoryManagerProps {
  enabled: boolean;
  onToggleEnabled: (next: boolean) => void;
  groups: VariationGroupConfig[];
  variants: VariantDraftInput[];
  photoGroupName: string | null;
  optionPhotoMap: Record<string, string | null>;
  sharedPhotos: SharedListingPhotoRef[];
  defaultPriceRm: string;
  canEditToggle?: boolean;
  onChangeState: (next: {
    groups: VariationGroupConfig[];
    variants: VariantDraftInput[];
    photoGroupName: string | null;
    optionPhotoMap: Record<string, string | null>;
  }) => void;
  onUploadSharedPhoto: (file: File) => Promise<SharedListingPhotoRef | null>;
}

export function VariationsInventoryManager({
  enabled,
  onToggleEnabled,
  groups,
  variants,
  photoGroupName,
  optionPhotoMap,
  sharedPhotos,
  defaultPriceRm,
  canEditToggle = true,
  onChangeState,
  onUploadSharedPhoto,
}: VariationsInventoryManagerProps) {
  const [optionInputs, setOptionInputs] = useState<string[]>(["", ""]);
  const [configError, setConfigError] = useState<string | null>(null);
  const [activePickerOptionValue, setActivePickerOptionValue] = useState<
    string | null
  >(null);
  const [bulkPriceRm, setBulkPriceRm] = useState(defaultPriceRm || "");
  const [bulkQty, setBulkQty] = useState("");
  const [bulkGroupTarget, setBulkGroupTarget] = useState<string>("__all__");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const handleClosePicker = useCallback(() => setActivePickerOptionValue(null), []);

  const sharedPhotoByKey = new Map<string, SharedListingPhotoRef>();
  for (const p of sharedPhotos) {
    sharedPhotoByKey.set(p.key, p);
    if (p.storagePath) sharedPhotoByKey.set(p.storagePath, p);
  }

  const hasReservedVariants = variants.some((v) => (v.reservedQuantity ?? 0) > 0);

  function rebuildAndCommit(
    nextGroups: VariationGroupConfig[],
    nextPhotoGroup: string | null,
    nextPhotoMap: Record<string, string | null>,
    currentRows: VariantDraftInput[] = variants
  ) {
    const gen = generateVariationCombinations({
      groups: nextGroups,
      existingRows: currentRows,
      optionPhotoMap: nextPhotoMap,
      photoGroupName: nextPhotoGroup,
      defaultPriceRm,
    });
    if (gen.droppedProtectedRows.length > 0) {
      setConfigError(
        "Cannot remove combinations that have active reservations or order history."
      );
      return false;
    }
    if (gen.capped) {
      setConfigError(
        `Maximum ${MAX_VARIATION_COMBINATIONS} combinations allowed per listing.`
      );
      return false;
    }
    setConfigError(null);
    onChangeState({
      groups: nextGroups,
      variants: gen.combinations,
      photoGroupName: nextPhotoGroup,
      optionPhotoMap: nextPhotoMap,
    });
    return true;
  }

  function handleGroupNameChange(groupIdx: number, rawName: string) {
    const nextName = rawName;
    const prevName = groups[groupIdx]?.name ?? "";
    const otherName = groups[groupIdx === 0 ? 1 : 0]?.name ?? "";

    if (
      nextName.trim() &&
      otherName.trim() &&
      normalizeOptionKey(nextName) === normalizeOptionKey(otherName)
    ) {
      setConfigError("Variation type names must be unique.");
      return;
    }

    const nextGroups = groups.map((g, i) =>
      i === groupIdx ? { ...g, name: nextName } : g
    );

    // Remap optionValues keys when renaming a group so existing rows retain IDs/price/stock
    const remappedRows = variants.map((row) => {
      if (!prevName.trim() || prevName === nextName) return row;
      const nextVals: Record<string, string> = {};
      for (const [k, v] of Object.entries(row.optionValues)) {
        if (normalizeOptionKey(k) === normalizeOptionKey(prevName)) {
          if (nextName.trim()) nextVals[nextName.trim()] = v;
        } else {
          nextVals[k] = v;
        }
      }
      return { ...row, optionValues: nextVals };
    });

    const nextPhotoGroup =
      photoGroupName &&
      normalizeOptionKey(photoGroupName) === normalizeOptionKey(prevName)
        ? nextName.trim() || null
        : photoGroupName;

    setConfigError(null);
    const hasBothReady = nextGroups.every(
      (g) => g.name.trim().length > 0 && g.options.length > 0
    );
    if (hasBothReady) {
      rebuildAndCommit(nextGroups, nextPhotoGroup, optionPhotoMap, remappedRows);
    } else {
      onChangeState({
        groups: nextGroups,
        variants: remappedRows,
        photoGroupName: nextPhotoGroup,
        optionPhotoMap,
      });
    }
  }

  function handleAddOption(groupIdx: number) {
    const group = groups[groupIdx];
    if (!group) return;
    const rawVal = (optionInputs[groupIdx] ?? "").trim();
    if (!group.name.trim()) {
      setConfigError(
        `Enter a Variation ${groupIdx + 1} type name before adding options.`
      );
      return;
    }
    if (!rawVal) {
      setConfigError("Enter an option name before adding.");
      return;
    }
    if (
      group.options.some(
        (o) => normalizeOptionKey(o) === normalizeOptionKey(rawVal)
      )
    ) {
      setConfigError(`"${rawVal}" is already listed under ${group.name}.`);
      return;
    }

    const nextGroups = groups.map((g, i) =>
      i === groupIdx ? { ...g, options: [...g.options, rawVal] } : g
    );
    const otherGroup = nextGroups[groupIdx === 0 ? 1 : 0];
    const estimatedCount = otherGroup
      ? nextGroups[groupIdx]!.options.length * Math.max(1, otherGroup.options.length)
      : nextGroups[groupIdx]!.options.length;
    if (estimatedCount > MAX_VARIATION_COMBINATIONS) {
      setConfigError(
        `Adding "${rawVal}" would exceed the maximum ${MAX_VARIATION_COMBINATIONS} combinations.`
      );
      return;
    }

    const nextPhotoGroup =
      photoGroupName ?? resolveVariationPhotoGroupDefault(nextGroups.map((g) => g.name));

    const ok = rebuildAndCommit(nextGroups, nextPhotoGroup, optionPhotoMap);
    if (ok) {
      setOptionInputs((prev) => prev.map((v, i) => (i === groupIdx ? "" : v)));
    }
  }

  function handleRemoveOption(groupIdx: number, optVal: string) {
    const group = groups[groupIdx];
    if (!group) return;
    const isProtected = variants.some(
      (v) =>
        normalizeOptionKey(getOptionValueForGroup(v.optionValues, group.name)) ===
          normalizeOptionKey(optVal) &&
        ((v.reservedQuantity ?? 0) > 0 || v.isLocked)
    );
    if (isProtected) {
      setConfigError(
        `"${optVal}" is linked to active reservations or past orders. Set its active status off or stock to 0 instead of removing.`
      );
      return;
    }

    const nextGroups = groups.map((g, i) =>
      i === groupIdx
        ? {
            ...g,
            options: g.options.filter(
              (o) => normalizeOptionKey(o) !== normalizeOptionKey(optVal)
            ),
          }
        : g
    );
    const nextPhotoMap = { ...optionPhotoMap };
    if (
      photoGroupName &&
      normalizeOptionKey(photoGroupName) === normalizeOptionKey(group.name)
    ) {
      delete nextPhotoMap[normalizeOptionKey(optVal)];
    }
    rebuildAndCommit(nextGroups, photoGroupName, nextPhotoMap);
  }

  function handleAddSecondGroup() {
    if (groups.length >= 2) return;
    const firstName = groups[0]?.name.trim() ?? "";
    const suggestedSecond =
      normalizeOptionKey(firstName) === "size" ? "Colour" : "Size";
    const nextGroups: VariationGroupConfig[] = [
      ...(groups.length > 0 ? groups : [{ name: "Colour", options: [] }]),
      { name: suggestedSecond, options: [] },
    ];
    onChangeState({
      groups: nextGroups,
      variants,
      photoGroupName:
        photoGroupName ??
        resolveVariationPhotoGroupDefault(nextGroups.map((g) => g.name)),
      optionPhotoMap,
    });
  }

  function handleRemoveSecondGroup() {
    if (groups.length < 2) return;
    const hasProtected = variants.some(
      (v) => (v.reservedQuantity ?? 0) > 0 || v.isLocked
    );
    if (hasProtected) {
      setConfigError(
        "Cannot remove the second variation type while existing combinations have reserved stock or order history."
      );
      return;
    }
    const g1 = groups[0]!;
    const nextGroups = [g1];
    const nextPhotoGroup = g1.name.trim() || null;
    rebuildAndCommit(nextGroups, nextPhotoGroup, optionPhotoMap, []);
  }

  function handlePhotoGroupSelection(targetGroup: string | null) {
    const nextMap: Record<string, string | null> = {};
    const nextVariants = variants.map((v) => {
      if (!targetGroup) {
        return { ...v, imagePath: null };
      }
      const optVal = getOptionValueForGroup(v.optionValues, targetGroup);
      const optKey = normalizeOptionKey(optVal);
      const existingMapped = optionPhotoMap[optKey] ?? v.imagePath ?? null;
      if (optKey && existingMapped) nextMap[optKey] = existingMapped;
      return { ...v, imagePath: existingMapped };
    });
    onChangeState({
      groups,
      variants: nextVariants,
      photoGroupName: targetGroup,
      optionPhotoMap: nextMap,
    });
  }

  function assignPhotoToOption(optionValue: string, photoKey: string | null) {
    if (!photoGroupName) return;
    const optKey = normalizeOptionKey(optionValue);
    const nextPhotoMap = { ...optionPhotoMap, [optKey]: photoKey };
    const nextVariants = variants.map((v) =>
      normalizeOptionKey(getOptionValueForGroup(v.optionValues, photoGroupName)) ===
      optKey
        ? { ...v, imagePath: photoKey }
        : v
    );
    setActivePickerOptionValue(null);
    onChangeState({
      groups,
      variants: nextVariants,
      photoGroupName,
      optionPhotoMap: nextPhotoMap,
    });
  }

  function updateCombinationRow(
    comboIndex: number,
    patch: Partial<VariantDraftInput>
  ) {
    const nextVariants = variants.map((row, idx) =>
      idx === comboIndex ? { ...row, ...patch } : row
    );
    onChangeState({
      groups,
      variants: nextVariants,
      photoGroupName,
      optionPhotoMap,
    });
  }

  function handleApplyBulk() {
    const priceTrim = bulkPriceRm.trim();
    const qtyTrim = bulkQty.trim();
    if (!priceTrim && !qtyTrim) return;

    let parsedQty: number | null = null;
    if (qtyTrim) {
      const n = Number.parseInt(qtyTrim, 10);
      if (!Number.isInteger(n) || n < 0 || n > 999) {
        setConfigError("Bulk stock must be between 0 and 999.");
        return;
      }
      parsedQty = n;
    }

    const g1Name = groups[0]?.name ?? "";
    let clampedForReserved = false;

    const nextVariants = variants.map((row) => {
      if (
        bulkGroupTarget !== "__all__" &&
        g1Name &&
        normalizeOptionKey(getOptionValueForGroup(row.optionValues, g1Name)) !==
          normalizeOptionKey(bulkGroupTarget)
      ) {
        return row;
      }

      let nextQty = row.quantity;
      if (parsedQty !== null) {
        const minRes = row.reservedQuantity ?? 0;
        if (parsedQty < minRes) {
          nextQty = String(minRes);
          clampedForReserved = true;
        } else {
          nextQty = String(parsedQty);
        }
      }

      return {
        ...row,
        ...(priceTrim ? { priceRm: priceTrim } : {}),
        quantity: nextQty,
      };
    });

    setConfigError(
      clampedForReserved
        ? "Some combinations kept higher stock because buyers have active reservations."
        : null
    );
    onChangeState({
      groups,
      variants: nextVariants,
      photoGroupName,
      optionPhotoMap,
    });
  }

  const activeVariants = variants.filter((v) => v.active);
  const totalCombos = variants.length;
  const totalReserved = activeVariants.reduce(
    (sum, v) => sum + (v.reservedQuantity ?? 0),
    0
  );
  const totalAvailable = activeVariants.reduce((sum, v) => {
    const q = Math.max(0, Number.parseInt(String(v.quantity || "0"), 10) || 0);
    return sum + Math.max(0, q - (v.reservedQuantity ?? 0));
  }, 0);
  const soldOutCombos = activeVariants.filter((v) => {
    const q = Math.max(0, Number.parseInt(String(v.quantity || "0"), 10) || 0);
    return Math.max(0, q - (v.reservedQuantity ?? 0)) <= 0;
  }).length;

  const isTwoGroups = groups.length >= 2 && groups[1]!.name.trim().length > 0;
  const group1 = groups[0] ?? { name: "", options: [] };
  const group2 = groups[1] ?? null;

  const photoControlledGroup =
    photoGroupName &&
    groups.find(
      (g) => normalizeOptionKey(g.name) === normalizeOptionKey(photoGroupName)
    );

  function renderOptionPhotoControl(optValue: string, compact = false) {
    const optKey = normalizeOptionKey(optValue);
    const assignedKey = optionPhotoMap[optKey] ?? null;
    const assignedPhoto = assignedKey ? sharedPhotoByKey.get(assignedKey) ?? null : null;

    return (
      <button
        type="button"
        onClick={() => setActivePickerOptionValue(optValue)}
        aria-label={
          assignedPhoto
            ? `Change photo for ${optValue}`
            : `Assign photo for ${optValue}`
        }
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#DCD8E6] bg-white px-2 py-1 text-[11px] font-bold text-[#4E2A84] transition hover:border-[#4E2A84] hover:bg-[#F7F4FC] press-feedback"
      >
        {assignedPhoto ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={assignedPhoto.url}
            alt={optValue}
            className="h-5 w-5 rounded object-cover"
          />
        ) : (
          <ImagePlus className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        <span>
          {assignedPhoto
            ? compact
              ? "Change"
              : "Change Photo"
            : compact
              ? "Photo"
              : "Assign Photo"}
        </span>
      </button>
    );
  }

  return (
    <section className="rounded-xl border border-[#E6E3EE] bg-[#FAFAFC] p-4 sm:p-5">

      {/* Section Header + Enable Toggle */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className="inline-flex items-center gap-1.5 text-sm font-extrabold text-[#14121A]">
            <Layers className="h-4 w-4 text-[#4E2A84]" aria-hidden="true" />
            <span>Variations &amp; Inventory</span>
          </span>
          <p className="mt-0.5 text-xs text-[#6E6A7C]">
            Offer choices like Colour, Size, Fragrance, or Flavour with individual pricing, stock, and photos.
          </p>
        </div>

        <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-[#D8D3E6] bg-white px-3 py-1.5 text-xs font-bold text-[#14121A]">
          <input
            type="checkbox"
            name="hasVariants"
            checked={enabled}
            disabled={!canEditToggle || (enabled && hasReservedVariants)}
            onChange={(e) => {
              setConfigError(null);
              onToggleEnabled(e.target.checked);
            }}
            className="h-4 w-4 accent-[#4E2A84]"
          />
          <span>Enable Variations</span>
        </label>
      </div>

      {!enabled ? null : (
        <div className="mt-4 space-y-5 border-t border-[#ECEAF3] pt-4">
          {configError ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-xl border border-[#F5C2C0] bg-[#FDF2F2] px-3.5 py-2.5 text-xs font-semibold text-[#B42318]"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{configError}</span>
            </div>
          ) : null}

          {/* Stage A — Variation Configuration */}
          <div className="space-y-3">
            <p className="text-xs font-extrabold uppercase tracking-wider text-[#4E2A84]">
              Stage A &mdash; Variation Setup
            </p>

            {groups.map((grp, gIdx) => (
              <div
                key={gIdx}
                className="rounded-xl border border-[#E6E3EE] bg-white p-3.5 sm:p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-extrabold text-[#14121A]">
                    Variation {gIdx + 1}
                  </span>
                  {gIdx === 1 ? (
                    <button
                      type="button"
                      onClick={handleRemoveSecondGroup}
                      className="inline-flex cursor-pointer items-center gap-1 text-[11px] font-bold text-[#B42318] hover:underline"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Remove Variation 2</span>
                    </button>
                  ) : null}
                </div>

                {/* Type Input + Suggested Types */}
                <div className="mt-2.5 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="block text-[11px] font-bold text-[#4A4656]">
                      Variation Type
                    </label>
                    <input
                      type="text"
                      maxLength={32}
                      value={grp.name}
                      onChange={(e) => handleGroupNameChange(gIdx, e.target.value)}
                      placeholder={gIdx === 0 ? "e.g. Colour or Fragrance" : "e.g. Size"}
                      className="mt-1 w-full rounded-lg border border-[#CFCBD9] bg-white px-3 py-1.5 text-xs font-semibold text-[#14121A] focus:border-[#4E2A84] focus:outline-none"
                    />
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {SUGGESTED_VARIATION_TYPES.map((sug) => {
                        const isPicked =
                          normalizeOptionKey(grp.name) === normalizeOptionKey(sug);
                        return (
                          <button
                            key={sug}
                            type="button"
                            onClick={() => handleGroupNameChange(gIdx, sug)}
                            className={`cursor-pointer rounded-md border px-2 py-0.5 text-[10.5px] font-semibold transition ${
                              isPicked
                                ? "border-[#4E2A84] bg-[#F4F1FA] text-[#4E2A84]"
                                : "border-[#E6E3EE] bg-[#FAFAFC] text-[#555062] hover:border-[#4E2A84]/50"
                            }`}
                          >
                            {sug}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Available Options Input + Add */}
                  <div>
                    <label className="block text-[11px] font-bold text-[#4A4656]">
                      Available Options
                    </label>
                    <div className="mt-1 flex gap-1.5">
                      <input
                        type="text"
                        maxLength={40}
                        value={optionInputs[gIdx] ?? ""}
                        onChange={(e) =>
                          setOptionInputs((prev) =>
                            prev.map((val, i) => (i === gIdx ? e.target.value : val))
                          )
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            handleAddOption(gIdx);
                          }
                        }}
                        placeholder={
                          gIdx === 0
                            ? "Type an option (e.g. Black) & press Enter"
                            : "Type an option (e.g. M) & press Enter"
                        }
                        className="min-w-0 flex-1 rounded-lg border border-[#CFCBD9] bg-white px-3 py-1.5 text-xs text-[#14121A] focus:border-[#4E2A84] focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => handleAddOption(gIdx)}
                        className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-[#4E2A84] px-3 py-1.5 text-xs font-bold text-white hover:bg-[#3A1E66]"
                      >
                        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Add</span>
                      </button>
                    </div>

                    {grp.options.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {grp.options.map((opt) => (
                          <span
                            key={opt}
                            className="inline-flex items-center gap-1 rounded-lg border border-[#D8D3E6] bg-[#F8F6FD] px-2.5 py-1 text-xs font-semibold text-[#14121A]"
                          >
                            <span>{opt}</span>
                            <button
                              type="button"
                              onClick={() => handleRemoveOption(gIdx, opt)}
                              aria-label={`Remove ${opt}`}
                              className="cursor-pointer rounded p-0.5 text-[#6E6A7C] hover:bg-[#FDF2F2] hover:text-[#B42318]"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-1.5 text-[11px] text-[#858094]">
                        Add at least one option to generate combinations automatically.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ))}

            {groups.length < 2 ? (
              <div className="rounded-xl border border-dashed border-[#D5D0E2] bg-white/70 px-3.5 py-2.5">
                <button
                  type="button"
                  onClick={handleAddSecondGroup}
                  className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-extrabold text-[#4E2A84] hover:underline"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Add Another Variation Type</span>
                </button>
                <p className="mt-0.5 text-[11px] text-[#6E6A7C]">
                  Optional. Use another variation type for products with combinations such as colour and size.
                </p>
              </div>
            ) : null}
          </div>

          {/* Photo Assignment Control */}
          {groups.some((g) => g.name.trim() && g.options.length > 0) ? (
            <div className="rounded-xl border border-[#E6E3EE] bg-white p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-extrabold text-[#14121A]">
                    Variation Photos
                  </p>
                  <p className="text-[11px] text-[#6E6A7C]">
                    Reuse your shared Product Photos or upload a new photo once per option.
                  </p>
                </div>

                {isTwoGroups ? (
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-bold text-[#4A4656]">
                      Assign photos by:
                    </span>
                    <select
                      value={photoGroupName ?? "__none__"}
                      onChange={(e) =>
                        handlePhotoGroupSelection(
                          e.target.value === "__none__" ? null : e.target.value
                        )
                      }
                      aria-label="Assign photos by variation type"
                      className="rounded-lg border border-[#CFCBD9] bg-white px-2.5 py-1 text-xs font-bold text-[#14121A] focus:border-[#4E2A84] focus:outline-none"
                    >
                      <option value={group1.name}>{group1.name}</option>
                      {group2 ? (
                        <option value={group2.name}>{group2.name}</option>
                      ) : null}
                      <option value="__none__">No individual variation photos</option>
                    </select>
                  </div>
                ) : null}
              </div>

              {isTwoGroups && photoControlledGroup && photoControlledGroup.options.length > 0 ? (
                <div className="mt-2.5 flex flex-wrap gap-2 border-t border-[#F0EDF5] pt-2.5">
                  {photoControlledGroup.options.map((optVal) => (
                    <div
                      key={optVal}
                      className="flex items-center gap-2 rounded-lg border border-[#E6E3EE] bg-[#FAFAFC] px-2.5 py-1.5 text-xs"
                    >
                      <span className="font-bold text-[#14121A]">{optVal}</span>
                      {renderOptionPhotoControl(optVal, true)}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Stage B — Generated Combinations, Bulk Edit & Inventory */}
          {variants.length > 0 ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-extrabold uppercase tracking-wider text-[#4E2A84]">
                  Stage B &mdash; Inventory &amp; Pricing ({totalCombos})
                </p>
                <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold">
                  <span className="rounded-full bg-[#F4F1FA] px-2.5 py-0.5 text-[#4E2A84]">
                    {totalCombos} combinations
                  </span>
                  <span className="rounded-full bg-[#EDFAF9] px-2.5 py-0.5 text-[#008386]">
                    {totalAvailable} available
                  </span>
                  {totalReserved > 0 ? (
                    <span className="rounded-full bg-[#EDF5FC] px-2.5 py-0.5 text-[#1D70B8]">
                      {totalReserved} reserved
                    </span>
                  ) : null}
                  {soldOutCombos > 0 ? (
                    <span className="rounded-full bg-[#FDF2F2] px-2.5 py-0.5 text-[#B42318]">
                      {soldOutCombos} sold out
                    </span>
                  ) : null}
                </div>
              </div>

              {/* Bulk Inventory Editor */}
              <div className="flex flex-wrap items-end gap-2 rounded-xl border border-[#E6E3EE] bg-white p-3 text-xs">
                {isTwoGroups && group1.options.length > 0 ? (
                  <div>
                    <label className="block text-[10.5px] font-bold text-[#6E6A7C]">
                      Apply To
                    </label>
                    <select
                      value={bulkGroupTarget}
                      onChange={(e) => setBulkGroupTarget(e.target.value)}
                      className="mt-1 rounded-lg border border-[#CFCBD9] bg-white px-2.5 py-1.5 text-xs font-semibold text-[#14121A]"
                    >
                      <option value="__all__">All combinations</option>
                      {group1.options.map((o) => (
                        <option key={o} value={o}>
                          {group1.name}: {o}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}

                <div>
                  <label className="block text-[10.5px] font-bold text-[#6E6A7C]">
                    Bulk Price (RM)
                  </label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={bulkPriceRm}
                    onChange={(e) => setBulkPriceRm(e.target.value)}
                    placeholder="e.g. 25.00"
                    className="mt-1 w-24 rounded-lg border border-[#CFCBD9] px-2.5 py-1.5 text-xs font-semibold text-[#14121A]"
                  />
                </div>

                <div>
                  <label className="block text-[10.5px] font-bold text-[#6E6A7C]">
                    Bulk Stock
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={999}
                    value={bulkQty}
                    onChange={(e) => setBulkQty(e.target.value)}
                    placeholder="e.g. 5"
                    className="mt-1 w-20 rounded-lg border border-[#CFCBD9] px-2.5 py-1.5 text-xs font-semibold text-[#14121A]"
                  />
                </div>

                <button
                  type="button"
                  onClick={handleApplyBulk}
                  className="cursor-pointer rounded-lg border border-[#4E2A84] bg-white px-3 py-1.5 text-xs font-bold text-[#4E2A84] transition hover:bg-[#F4F1FA]"
                >
                  Apply Bulk
                </button>
              </div>

              {/* Inventory Table: Single Group vs Two-Group Grouped */}
              {!isTwoGroups ? (
                <div className="overflow-x-auto rounded-xl border border-[#E6E3EE] bg-white">
                  <table className="w-full min-w-[540px] border-collapse text-left text-xs">
                    <thead>
                      <tr className="border-b border-[#ECEAF3] bg-[#FAF9FC] text-[10.5px] font-extrabold uppercase tracking-wider text-[#6E6A7C]">
                        <th className="px-3 py-2">Photo</th>
                        <th className="px-3 py-2">{group1.name || "Variation"}</th>
                        <th className="px-3 py-2">Price (RM)</th>
                        <th className="px-3 py-2">Stock</th>
                        <th className="px-3 py-2">Active</th>
                        <th className="px-3 py-2 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#F0EDF5]">
                      {variants.map((row, idx) => {
                        const optVal = getOptionValueForGroup(
                          row.optionValues,
                          group1.name
                        );
                        const qtyNum = Math.max(
                          0,
                          Number.parseInt(String(row.quantity || "0"), 10) || 0
                        );
                        const reserved = row.reservedQuantity ?? 0;
                        const avail = Math.max(0, qtyNum - reserved);
                        const locked = reserved > 0 || Boolean(row.isLocked);

                        return (
                          <tr key={row.id ?? optVal ?? idx} className="bg-white">
                            <td className="px-3 py-2.5">
                              {photoGroupName ? renderOptionPhotoControl(optVal, true) : "—"}
                            </td>
                            <td className="px-3 py-2.5 font-bold text-[#14121A]">
                              <div className="flex items-center gap-1.5">
                                <span>{optVal}</span>
                                {row.active && avail === 0 ? (
                                  <span className="rounded bg-[#FDF2F2] px-1.5 py-0.5 text-[10px] font-bold text-[#B42318]">
                                    Sold Out
                                  </span>
                                ) : null}
                              </div>
                            </td>
                            <td className="px-3 py-2.5">
                              <input
                                type="text"
                                inputMode="decimal"
                                value={row.priceRm}
                                onChange={(e) =>
                                  updateCombinationRow(idx, { priceRm: e.target.value })
                                }
                                className="w-24 rounded-lg border border-[#CFCBD9] px-2.5 py-1 text-xs font-bold text-[#14121A]"
                              />
                            </td>
                            <td className="px-3 py-2.5">
                              <div className="flex items-center gap-1.5">
                                <input
                                  type="number"
                                  min={reserved}
                                  max={999}
                                  value={row.quantity}
                                  onChange={(e) =>
                                    updateCombinationRow(idx, { quantity: e.target.value })
                                  }
                                  className="w-20 rounded-lg border border-[#CFCBD9] px-2.5 py-1 text-xs font-bold text-[#14121A]"
                                />
                                {reserved > 0 ? (
                                  <span className="text-[10.5px] font-semibold text-[#1D70B8]">
                                    ({avail} free / {reserved} res)
                                  </span>
                                ) : null}
                              </div>
                            </td>
                            <td className="px-3 py-2.5">
                              <input
                                type="checkbox"
                                checked={row.active}
                                disabled={reserved > 0}
                                onChange={(e) =>
                                  updateCombinationRow(idx, { active: e.target.checked })
                                }
                                aria-label={`Active status for ${optVal}`}
                                className="h-4 w-4 accent-[#4E2A84] disabled:opacity-50"
                              />
                            </td>
                            <td className="px-3 py-2.5 text-right">
                              {locked ? (
                                <span
                                  title="Referenced by existing order or reservation"
                                  className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-[#6E6A7C]"
                                >
                                  <Lock className="h-3 w-3" aria-hidden="true" />
                                  <span>Locked</span>
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => handleRemoveOption(0, optVal)}
                                  aria-label={`Remove ${optVal}`}
                                  className="cursor-pointer rounded p-1 text-[#6E6A7C] hover:bg-[#FDF2F2] hover:text-[#B42318]"
                                >
                                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {group1.options.map((g1Opt) => {
                    const groupRows = variants
                      .map((row, idx) => ({ row, idx }))
                      .filter(
                        ({ row }) =>
                          normalizeOptionKey(
                            getOptionValueForGroup(row.optionValues, group1.name)
                          ) === normalizeOptionKey(g1Opt)
                      );
                    if (groupRows.length === 0) return null;

                    const grpAvail = groupRows.reduce((sum, { row }) => {
                      if (!row.active) return sum;
                      const q = Math.max(
                        0,
                        Number.parseInt(String(row.quantity || "0"), 10) || 0
                      );
                      return sum + Math.max(0, q - (row.reservedQuantity ?? 0));
                    }, 0);

                    const gPhotoKey =
                      photoGroupName &&
                      normalizeOptionKey(photoGroupName) === normalizeOptionKey(group1.name)
                        ? optionPhotoMap[normalizeOptionKey(g1Opt)] ?? null
                        : null;
                    const gPhoto = gPhotoKey ? sharedPhotoByKey.get(gPhotoKey) ?? null : null;
                    const isCollapsed = Boolean(collapsedGroups[normalizeOptionKey(g1Opt)]);

                    return (
                      <div
                        key={g1Opt}
                        className="overflow-hidden rounded-xl border border-[#E6E3EE] bg-white"
                      >
                        <button
                          type="button"
                          onClick={() =>
                            setCollapsedGroups((prev) => ({
                              ...prev,
                              [normalizeOptionKey(g1Opt)]: !isCollapsed,
                            }))
                          }
                          aria-expanded={!isCollapsed}
                          className="flex w-full cursor-pointer items-center justify-between gap-3 bg-[#FAF9FC] px-4 py-2.5 text-left transition hover:bg-[#F4F1FA]/60"
                        >
                          <div className="flex items-center gap-2.5">
                            {gPhoto ? (
                              /* eslint-disable-next-line @next/next/no-img-element */
                              <img
                                src={gPhoto.url}
                                alt={g1Opt}
                                className="h-8 w-8 rounded-lg border border-[#E6E3EE] object-cover"
                              />
                            ) : null}
                            <div>
                              <p className="text-xs font-extrabold text-[#14121A]">
                                {g1Opt}
                              </p>
                              <p className="text-[11px] text-[#6E6A7C]">
                                {groupRows.length}{" "}
                                {groupRows.length === 1 ? "combination" : "combinations"}{" "}
                                &middot; {grpAvail} available
                              </p>
                            </div>
                          </div>
                          <ChevronDown
                            className={`h-4 w-4 text-[#6E6A7C] transition-transform ${
                              isCollapsed ? "" : "rotate-180"
                            }`}
                            aria-hidden="true"
                          />
                        </button>

                        {!isCollapsed ? (
                          <div className="overflow-x-auto border-t border-[#ECEAF3]">
                            <table className="w-full min-w-[440px] border-collapse text-left text-xs">
                              <thead>
                                <tr className="border-b border-[#F0EDF5] text-[10.5px] font-bold uppercase tracking-wider text-[#6E6A7C]">
                                  <th className="px-4 py-1.5">
                                    {group2?.name || "Option"}
                                  </th>
                                  <th className="px-3 py-1.5">Price (RM)</th>
                                  <th className="px-3 py-1.5">Stock</th>
                                  <th className="px-3 py-1.5 text-right">Active</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-[#F5F4F8]">
                                {groupRows.map(({ row, idx }) => {
                                  const g2Val = group2
                                    ? getOptionValueForGroup(row.optionValues, group2.name)
                                    : "";
                                  const qtyNum = Math.max(
                                    0,
                                    Number.parseInt(String(row.quantity || "0"), 10) || 0
                                  );
                                  const reserved = row.reservedQuantity ?? 0;
                                  const avail = Math.max(0, qtyNum - reserved);

                                  return (
                                    <tr key={row.id ?? `${g1Opt}-${g2Val}`}>
                                      <td className="px-4 py-2 font-semibold text-[#14121A]">
                                        <div className="flex items-center gap-1.5">
                                          <span>{g2Val}</span>
                                          {row.active && avail === 0 ? (
                                            <span className="rounded bg-[#FDF2F2] px-1.5 py-0.5 text-[10px] font-bold text-[#B42318]">
                                              Sold Out
                                            </span>
                                          ) : null}
                                        </div>
                                      </td>
                                      <td className="px-3 py-2">
                                        <input
                                          type="text"
                                          inputMode="decimal"
                                          value={row.priceRm}
                                          onChange={(e) =>
                                            updateCombinationRow(idx, {
                                              priceRm: e.target.value,
                                            })
                                          }
                                          className="w-24 rounded-lg border border-[#CFCBD9] px-2.5 py-1 text-xs font-bold text-[#14121A]"
                                        />
                                      </td>
                                      <td className="px-3 py-2">
                                        <div className="flex items-center gap-1.5">
                                          <input
                                            type="number"
                                            min={reserved}
                                            max={999}
                                            value={row.quantity}
                                            onChange={(e) =>
                                              updateCombinationRow(idx, {
                                                quantity: e.target.value,
                                              })
                                            }
                                            className="w-20 rounded-lg border border-[#CFCBD9] px-2.5 py-1 text-xs font-bold text-[#14121A]"
                                          />
                                          {reserved > 0 ? (
                                            <span className="text-[10.5px] font-semibold text-[#1D70B8]">
                                              ({reserved} res)
                                            </span>
                                          ) : null}
                                        </div>
                                      </td>
                                      <td className="px-3 py-2 text-right">
                                        <input
                                          type="checkbox"
                                          checked={row.active}
                                          disabled={reserved > 0}
                                          onChange={(e) =>
                                            updateCombinationRow(idx, {
                                              active: e.target.checked,
                                            })
                                          }
                                          aria-label={`Active for ${g1Opt} ${g2Val}`}
                                          className="h-4 w-4 accent-[#4E2A84] disabled:opacity-50"
                                        />
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}

      <VariationPhotoPickerDialog
        open={enabled && activePickerOptionValue !== null}
        optionValue={activePickerOptionValue ?? ""}
        groupName={photoGroupName}
        initialPhotoKey={
          activePickerOptionValue
            ? optionPhotoMap[normalizeOptionKey(activePickerOptionValue)] ?? null
            : null
        }
        sharedPhotos={sharedPhotos}
        onUploadSharedPhoto={onUploadSharedPhoto}
        onApply={(photoKey) => {
          if (activePickerOptionValue) {
            assignPhotoToOption(activePickerOptionValue, photoKey);
          } else {
            handleClosePicker();
          }
        }}
        onClose={handleClosePicker}
      />
    </section>
  );
}
