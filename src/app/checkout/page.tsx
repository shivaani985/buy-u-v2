import type { Metadata } from "next";
import Link from "next/link";
import { AlertCircle, ArrowLeft, Lock, RefreshCw } from "lucide-react";
import { CheckoutClient } from "@/components/checkout/CheckoutClient";
import { getCartPageData } from "@/lib/buyer/cart-data";
import {
  buildCheckoutPreparation,
  filterCartSummaryByIds,
} from "@/lib/buyer/checkout";
import { isValidUuid } from "@/lib/buyer/validation";
import { getSessionSummary } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Checkout",
  description:
    "Review your UMSKAL campus seller orders and collection details before payment.",
};

export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<{ items?: string }>;
}) {
  const [session, sp] = await Promise.all([getSessionSummary(), searchParams]);
  const hasExplicitItemsParam = typeof sp.items === "string";
  const rawTokens = hasExplicitItemsParam
    ? sp.items!
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [];

  let selectionError: string | null = null;
  let selectedCartItemIds: string[] | null = null;

  if (hasExplicitItemsParam) {
    const uniqueTokens = Array.from(new Set(rawTokens));
    if (
      rawTokens.length === 0 ||
      uniqueTokens.length !== rawTokens.length ||
      uniqueTokens.some((id) => !isValidUuid(id))
    ) {
      selectionError =
        "Your checkout item selection is invalid. Return to your cart and select the items you want to purchase.";
    } else {
      selectedCartItemIds = [...uniqueTokens].sort();
    }
  }

  const { eligibility, summary, error } = await getCartPageData(session);
  if (!selectionError && selectedCartItemIds) {
    const liveIds = new Set(
      summary.groups.flatMap((g) => g.items.map((it) => it.id))
    );
    if (selectedCartItemIds.some((id) => !liveIds.has(id))) {
      selectionError =
        "One or more selected cart items are no longer in your cart. Return to your cart to review your selection.";
    }
  }

  // Always submit exact reviewed cart item IDs even if user navigated directly to /checkout
  const effectiveSelectedIds =
    selectionError !== null
      ? null
      : selectedCartItemIds ??
        summary.groups
          .flatMap((g) => g.items.map((it) => it.id))
          .sort();

  const filteredSummary = filterCartSummaryByIds(summary, effectiveSelectedIds);
  const preparation = buildCheckoutPreparation(filteredSummary);
  const pageError = error || selectionError;

  const profile = session.profile;
  const roleLabel =
    (profile?.university_role ?? "").toLowerCase() === "staff"
      ? "Verified UMS Staff"
      : "Verified UMS Student";

  return (
    <div className="mx-auto w-full max-w-[1320px] px-4 py-6 sm:px-6 lg:px-10">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link
            href="/cart"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#6B6779] transition hover:text-[#4E2A84]"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Back to Cart</span>
          </Link>
          <h1 className="mt-2 text-2xl font-extrabold tracking-[-0.02em] text-[#14121A] sm:text-3xl">
            Checkout Review
          </h1>
          <p className="mt-1 text-sm text-[#6B6779]">
            Review each campus seller&apos;s order, collection area, and live
            stock before payment opens.
          </p>
        </div>
      </div>

      {!eligibility.eligible ? (
        <section className="rounded-2xl border border-[#E6E3EE] bg-white p-6 sm:p-8">
          <div className="flex items-start gap-3">
            <Lock
              className="mt-0.5 h-5 w-5 shrink-0 text-[#4E2A84]"
              aria-hidden="true"
            />
            <div>
              <h2 className="text-base font-bold text-[#14121A]">
                {eligibility.code === "unauthenticated"
                  ? "Sign in to access checkout"
                  : "Shopping access required"}
              </h2>
              <p className="mt-1 text-sm text-[#6B6779]">
                {eligibility.reason}
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                {eligibility.code === "unauthenticated" ? (
                  <Link
                    href="/login?next=%2Fcheckout"
                    className="inline-flex items-center rounded-xl bg-[#4E2A84] px-5 py-2.5 text-sm font-bold text-white transition hover:bg-[#3F216B]"
                  >
                    Sign In with UMS Email
                  </Link>
                ) : null}
                <Link
                  href="/cart"
                  className="inline-flex items-center rounded-xl border border-[#E6E3EE] bg-white px-4 py-2.5 text-sm font-semibold text-[#14121A] transition hover:border-[#4E2A84] hover:text-[#4E2A84]"
                >
                  Return to Cart
                </Link>
              </div>
            </div>
          </div>
        </section>
      ) : pageError ? (
        <section
          role="alert"
          className="rounded-2xl border border-[#E6E3EE] bg-white p-6 sm:p-8"
        >
          <div className="flex items-start gap-3">
            <AlertCircle
              className="mt-0.5 h-5 w-5 shrink-0 text-[#B42318]"
              aria-hidden="true"
            />
            <div>
              <h2 className="text-base font-bold text-[#14121A]">
                Could not prepare checkout
              </h2>
              <p className="mt-1 text-sm text-[#6B6779]">{pageError}</p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Link
                  href="/checkout"
                  className="inline-flex items-center gap-2 rounded-xl bg-[#4E2A84] px-4 py-2 text-sm font-bold text-white transition hover:bg-[#3F216B]"
                >
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                  <span>Try Again</span>
                </Link>
                <Link
                  href="/cart"
                  className="inline-flex items-center rounded-xl border border-[#E6E3EE] bg-white px-4 py-2 text-sm font-semibold text-[#14121A] transition hover:border-[#4E2A84] hover:text-[#4E2A84]"
                >
                  Return to Cart
                </Link>
              </div>
            </div>
          </div>
        </section>
      ) : (
        <CheckoutClient
          initialPreparation={preparation}
          selectedCartItemIds={effectiveSelectedIds}
          buyer={{
            userId: eligibility.userId ?? "",
            displayName:
              profile?.display_name?.trim() ||
              profile?.full_name?.trim() ||
              session.email?.split("@")[0] ||
              "UMS Member",
            email: session.email || profile?.email || "",
            roleLabel,
            faculty: profile?.faculty?.trim() || null,
          }}
        />
      )}
    </div>
  );
}
