import type { Metadata } from "next";
import Link from "next/link";
import { AlertCircle, Lock, RefreshCw } from "lucide-react";
import { MessagesClient } from "@/components/messages/MessagesClient";
import { getMessagesPageData } from "@/lib/messages/data";
import { isValidUuid } from "@/lib/buyer/validation";
import { createSupabaseServerClient, getSessionSummary } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Messages",
  description: "Chat with verified UMSKAL campus buyers and sellers.",
};

interface MessagesPageProps {
  searchParams: Promise<{
    c?: string;
    listing?: string;
    freeItem?: string;
    variant?: string;
    bargain?: string;
  }>;
}

export default async function MessagesPage({
  searchParams,
}: MessagesPageProps) {
  const [sp, session] = await Promise.all([searchParams, getSessionSummary()]);
  const requestedConvId = typeof sp.c === "string" ? sp.c.trim() : null;
  const requestedListingId =
    typeof sp.listing === "string" ? sp.listing.trim() : null;

  const data = await getMessagesPageData(session, {
    requestedConversationId: requestedConvId,
    requestedListingId,
  });

  let freeItem: { id: string; title: string } | null = null;
  const active = data.conversations.find((conversation) => conversation.id === requestedConvId);
  if (active && data.eligibility.eligible && sp.freeItem && isValidUuid(sp.freeItem)) {
    const supabase = await createSupabaseServerClient();
    const result = await supabase?.from("free_notices").select("id,title")
      .eq("id", sp.freeItem).eq("contributor_id", active.peer.id).eq("status", "active")
      .not("pickup_location", "is", null).gt("expires_at", new Date().toISOString()).maybeSingle();
    freeItem = result?.data ?? null;
  }

  return (
    <div className="mx-auto w-full max-w-[1380px] px-4 py-6 sm:px-6 lg:px-10">
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-extrabold tracking-[-0.02em] text-[#14121A] sm:text-3xl">
            Messages
          </h1>
          <p className="mt-1 text-sm text-[#6B6779]">
            Direct campus messaging with verified UMSKAL students and staff.
          </p>
        </div>
        {data.eligibility.eligible && data.totalUnread > 0 ? (
          <p className="text-xs font-bold text-[#4E2A84]">
            {data.totalUnread} unread{" "}
            {data.totalUnread === 1 ? "message" : "messages"}
          </p>
        ) : null}
      </div>

      {freeItem && <div className="mb-4 rounded-xl border border-border-crisp px-4 py-3 text-sm">
        Free item · <Link className="font-bold text-brand-purple hover:underline"
          href={`/free-items?post=${freeItem.id}#post-${freeItem.id}`}>{freeItem.title}</Link>
      </div>}

      {!data.eligibility.eligible ? (
        <section className="rounded-2xl border border-[#E6E3EE] bg-white p-6 sm:p-8">
          <div className="flex items-start gap-3">
            <Lock
              className="mt-0.5 h-5 w-5 shrink-0 text-[#4E2A84]"
              aria-hidden="true"
            />
            <div>
              <h2 className="text-base font-bold text-[#14121A]">
                {data.eligibility.code === "unauthenticated"
                  ? "Sign in to view your messages"
                  : "Messaging access required"}
              </h2>
              <p className="mt-1 text-sm text-[#6B6779]">
                {data.eligibility.reason}
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                {data.eligibility.code === "unauthenticated" ? (
                  <Link
                    href="/login?next=%2Fmessages"
                    className="inline-flex items-center rounded-xl bg-[#4E2A84] px-5 py-2.5 text-sm font-bold text-white transition hover:bg-[#3F216B]"
                  >
                    Sign In with UMS Email
                  </Link>
                ) : null}
                <Link
                  href="/marketplace"
                  className="inline-flex items-center rounded-xl border border-[#E6E3EE] bg-white px-4 py-2.5 text-sm font-semibold text-[#14121A] transition hover:border-[#4E2A84] hover:text-[#4E2A84]"
                >
                  Browse Marketplace
                </Link>
              </div>
            </div>
          </div>
        </section>
      ) : data.error ? (
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
                Could not load messages
              </h2>
              <p className="mt-1 text-sm text-[#6B6779]">{data.error}</p>
              <div className="mt-4">
                <Link
                  href="/messages"
                  className="inline-flex items-center gap-2 rounded-xl bg-[#4E2A84] px-4 py-2 text-sm font-bold text-white transition hover:bg-[#3F216B]"
                >
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                  <span>Try Again</span>
                </Link>
              </div>
            </div>
          </div>
        </section>
      ) : (
        <MessagesClient
          key={data.activeConversationId ?? "empty"}
          currentUserId={data.eligibility.userId!}
          initialConversations={data.conversations}
          initialActiveConversationId={data.activeConversationId}
          initialMessages={data.activeMessages}
          initialOffers={data.activeOffers}
          initialHasOlder={data.hasOlderMessages}
          activeListing={data.activeListing}
          hasExplicitConversationParam={Boolean(requestedConvId)}
          initialOpenOffer={sp.bargain === "1"}
          initialVariantId={
            typeof sp.variant === "string" ? sp.variant.trim() : null
          }
        />
      )}
    </div>
  );
}
