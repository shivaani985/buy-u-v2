export interface FoodTerms {
  availabilityMode: string | null;
  packagedAcknowledged?: boolean;
  closedAt?: string | null;
  preorderCloseAt: string | null;
  pickupWindowStart: string | null;
  pickupWindowEnd: string | null;
}

export function foodAvailability(terms: FoodTerms, quantity: number, reserved: number, now: number) {
  if (terms.availabilityMode !== "pre_order") {
    return terms.packagedAcknowledged ? (quantity > reserved ? "Packaged Food" : "Sold Out") : "Food details required";
  }
  const cutoff = Date.parse(terms.preorderCloseAt ?? "");
  const start = Date.parse(terms.pickupWindowStart ?? "");
  const end = Date.parse(terms.pickupWindowEnd ?? "");
  if (!(cutoff < start && start < end)) return "Food details required";
  if (terms.closedAt || cutoff <= now) return quantity <= 0 ? "Sold Out" : "Pre-order Closed";
  if (quantity <= 0) return "Sold Out";
  return quantity > reserved ? "Pre-order Open" : "Temporarily Unavailable";
}

export function formatFoodDate(value: string) {
  return new Intl.DateTimeFormat("en-MY", {
    timeZone: "Asia/Kuala_Lumpur", day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
  }).format(new Date(value));
}

function parseFoodTime(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(value + ":00+08:00");
  if (!Number.isFinite(date.getTime()) || new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 16) !== value) return null;
  return date.toISOString();
}

export function readFoodForm(form: FormData, isFood: boolean, publishing: boolean, now = Date.now(), locked = false) {
  const preorder = isFood && form.get("availabilityMode") === "pre_order";
  const get = (name: string) => String(form.get(name) ?? "");
  const payload = {
    availability_mode: preorder ? "pre_order" : "ready",
    packaged_food_acknowledged: isFood && !preorder && form.get("packagedFoodAcknowledged") === "on",
    preorder_close_at: preorder ? parseFoodTime(get("preorderCloseAt")) : null,
    pickup_window_start: preorder ? parseFoodTime(get("collectionDate") + "T" + get("collectionStart")) : null,
    pickup_window_end: preorder ? parseFoodTime(get("collectionDate") + "T" + get("collectionEnd")) : null,
  };
  if (!isFood || !publishing) return { payload, error: null };
  if (!preorder) return { payload, error: payload.packaged_food_acknowledged ? null : "Confirm the packaged food acknowledgment." };
  const cutoff = Date.parse(payload.preorder_close_at ?? "");
  const start = Date.parse(payload.pickup_window_start ?? "");
  const end = Date.parse(payload.pickup_window_end ?? "");
  return { payload, error: (locked || cutoff > now) && cutoff < start && start < end ? null
    : "Use a future order cutoff, then a collection start and end in that order (MYT)." };
}
