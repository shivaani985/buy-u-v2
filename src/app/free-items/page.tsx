import type { Metadata } from "next";
import Link from "next/link";
import { FreeItemsClient } from "@/components/free-items/FreeItemsClient";
import { isValidUuid } from "@/lib/buyer/validation";
import { getFreeNoticeboardData } from "@/lib/marketplace/free-noticeboard-data";
import { getSessionSummary } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Free Items",
  description: "Find campus giveaways and share useful items with the UMS community.",
};

export const dynamic = "force-dynamic";

export default async function FreeItemsPage({ searchParams }: {
  searchParams: Promise<{ post?: string | string[] }>;
}) {
  const [session, params] = await Promise.all([getSessionSummary(), searchParams]);
  const data = await getFreeNoticeboardData(session);
  const focusedId = typeof params.post === "string" && isValidUuid(params.post) ? params.post : undefined;
  const next = focusedId ? `/free-items?post=${focusedId}` : "/free-items";

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-7 sm:px-6 lg:px-10">
      {data.buyer.eligible && data.buyer.userId && !data.error ? (
        <FreeItemsClient posts={data.posts} identity={data.identity} donorEligible={data.seller.eligible}
          userId={data.buyer.userId} serverNow={data.serverNow} focusedId={focusedId} />
      ) : (
        <section className="max-w-xl space-y-3">
          <h1 className="font-display text-4xl font-bold tracking-tight sm:text-5xl">Free Items</h1>
          <p className="text-sm text-ink-secondary">Give what you don’t need. Take what you can use.</p>
          <p className="text-sm" role={data.error ? "alert" : undefined}>{data.error || (session.isAuthenticated
            ? data.buyer.reason || "Eligible UMS membership is required to browse."
            : "Sign in with your UMS account to browse campus giveaways and view pickup locations.")}</p>
          {!session.isAuthenticated && <Link href={`/login?next=${encodeURIComponent(next)}`}
            className="inline-flex min-h-11 items-center rounded-xl bg-brand-purple px-4 text-sm font-bold text-white hover:bg-brand-purple-dark">
            Sign In with UMS Email
          </Link>}
        </section>
      )}
    </div>
  );
}
