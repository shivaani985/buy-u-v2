"use client";

import { useState } from "react";
import type { FoodTerms } from "@/lib/food";

function malaysiaInput(value?: string | null) {
  if (!value) return "";
  return new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 16);
}

export function FoodAvailabilityFields({ initial, locked = false, typeLocked = false }: { initial?: FoodTerms; locked?: boolean; typeLocked?: boolean }) {
  const [mode, setMode] = useState(initial?.availabilityMode === "pre_order" ? "pre_order" : "ready");
  const start = malaysiaInput(initial?.pickupWindowStart);
  const end = malaysiaInput(initial?.pickupWindowEnd);
  const input = "mt-1 min-h-11 w-full rounded-xl border border-border-crisp bg-white px-3 text-sm";
  return (
    <fieldset className="space-y-3 rounded-xl border border-border-crisp bg-[#F7F6FA] p-4 lg:col-span-2">
      <legend className="px-1 text-sm font-bold text-ink">Food Availability</legend>
      <input type="hidden" name="availabilityMode" value={mode} />
      <div className="grid gap-2 sm:grid-cols-2">
        {([{ value: "ready", label: "Packaged Food", detail: "Shelf-stable packaged food available for immediate purchase." },
           { value: "pre_order", label: "Pre-order Food", detail: "Freshly prepared food for scheduled collection." }] as const).map((option) => (
          <label key={option.value} className={`flex gap-2 rounded-xl border bg-white p-3 ${mode === option.value ? "border-[#4E2A84]" : "border-border-crisp"}`}>
            <input type="radio" name="foodAvailabilityChoice" checked={mode === option.value}
              disabled={locked || typeLocked} onChange={() => setMode(option.value)} className="mt-1 accent-[#4E2A84]" />
            <span><span className="block text-sm font-bold">{option.label}</span><span className="text-xs text-ink-secondary">{option.detail}</span></span>
          </label>
        ))}
      </div>
      {mode === "ready" ? (
        <div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="packagedFoodAcknowledged" defaultChecked={initial?.packagedAcknowledged}
              className="mt-1 accent-[#4E2A84]" />
            I confirm this product is commercially packaged, shelf-stable and within its labelled expiry or best-before date.
          </label>
          <p className="mt-1 text-xs text-ink-secondary">Freshly prepared and perishable food must use Pre-order Food.</p>
        </div>
      ) : (
        <div className="grid gap-3 text-sm font-semibold sm:grid-cols-2 lg:grid-cols-4">
          <label>Order cutoff (MYT)<input name="preorderCloseAt" type="datetime-local" readOnly={locked}
            defaultValue={malaysiaInput(initial?.preorderCloseAt)} className={input} /></label>
          <label>Collection date<input name="collectionDate" type="date" readOnly={locked} defaultValue={start.slice(0, 10)} className={input} /></label>
          <label>Collection start<input name="collectionStart" type="time" readOnly={locked} defaultValue={start.slice(11)} className={input} /></label>
          <label>Collection end<input name="collectionEnd" type="time" readOnly={locked} defaultValue={end.slice(11)} className={input} /></label>
        </div>
      )}
      {mode === "pre_order" && <p className="text-xs text-ink-secondary">
        {locked ? "This schedule is locked." : "Quantity is the number of portions you can prepare."} Create a new listing for another event.
      </p>}
    </fieldset>
  );
}
