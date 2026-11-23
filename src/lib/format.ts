import type { ListingType } from "@/types/marketplace";

export function formatRm(priceRm: number): string {
  if (priceRm <= 0) return "FREE";
  return `RM ${priceRm.toFixed(2)}`;
}

export function formatListingType(type: ListingType): string {
  switch (type) {
    case "preloved":
      return "Pre-Loved";
    case "student_business":
      return "Student Business";
    case "food":
      return "Campus Food";
    case "service":
      return "Service";
    case "free":
      return "Free Item";
  }
}

export function formatShortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Recently posted";
  return new Intl.DateTimeFormat("en-MY", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}
