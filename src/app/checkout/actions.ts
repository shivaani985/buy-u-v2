"use server";

import { getCartPageData } from "@/lib/buyer/cart-data";
import {
  buildCheckoutPreparation,
  type CheckoutPreparationSummary,
} from "@/lib/buyer/checkout";
import { getSessionSummary } from "@/lib/supabase/server";

export interface RevalidateCheckoutResult {
  ok: boolean;
  preparation?: CheckoutPreparationSummary;
  checkedAtIso?: string;
  error?: string;
}

/**
 * Strictly read-only server-side revalidation of authentication, buyer role,
 * listing availability, active variants, live stock, and current prices.
 * Creates NO orders, payments, or stock reservations.
 */
export async function revalidateCheckoutAction(
  priceSnapshots: Record<string, number>
): Promise<RevalidateCheckoutResult> {
  const session = await getSessionSummary();
  const { eligibility, summary, error } = await getCartPageData(session);

  if (!eligibility.eligible) {
    return {
      ok: false,
      error:
        eligibility.reason ||
        "Your session is not eligible for checkout. Please sign in again.",
    };
  }

  if (error) {
    return {
      ok: false,
      error,
    };
  }

  const preparation = buildCheckoutPreparation(summary, priceSnapshots);

  return {
    ok: true,
    preparation,
    checkedAtIso: new Date().toISOString(),
  };
}
