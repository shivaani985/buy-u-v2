import type { Metadata } from "next";
import Link from "next/link";
import { AlertCircle, Lock, RefreshCw } from "lucide-react";
import { MessagesClient } from "@/components/messages/MessagesClient";
import { getMessagesPageData } from "@/lib/messages/data";
import { contextArgs, parseChatTarget, type ChatReference } from "@/lib/messages/context";
import { createSupabaseServerClient, getSessionSummary } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Messages",
  description: "Chat with verified UMSKAL campus buyers and sellers.",
};

interface MessagesPageProps {
  searchParams: Promise<{
    c?: string;
    listing?: string;
    ref?: string;
    target?: string;
    item?: string;
    draft?: string;
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
    sp.bargain === "1" && typeof sp.listing === "string" ? sp.listing.trim() : null;

  const data = await getMessagesPageData(session, {
    requestedConversationId: requestedConvId,
    requestedListingId,
  });

  let draft: { key: string; reference: ChatReference } | null = null;
  let draftError: string | null = null;
  if (requestedConvId && requestedConvId === data.activeConversationId && sp.ref && sp.draft) {
    const target = parseChatTarget({ kind: sp.ref, targetId: sp.target, variantId: sp.variant, itemId: sp.item });
    if (target) {
      const supabase = await createSupabaseServerClient();
      const response = await supabase?.rpc("preview_chat_context", {
        p_conversation: requestedConvId,
        ...contextArgs(target),
      });
      if (response?.data) draft = { key: sp.draft, reference: response.data as ChatReference };
    }
    if (!draft) draftError = "This item is no longer available to reference.";
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
          initialDraft={draft}
          initialDraftError={draftError}
          renderedAt={data.serverNow}
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
