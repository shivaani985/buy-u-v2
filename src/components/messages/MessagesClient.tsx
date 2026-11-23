"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowLeft,
  Ban,
  ExternalLink,
  FileText,
  Info,
  Loader2,
  MapPin,
  MessageCircle,
  Paperclip,
  Search,
  Send,
  ShieldCheck,
  Store,
  X,
} from "lucide-react";
import {
  loadOlderMessagesAction,
  markConversationReadAction,
  sendMessageAction,
} from "@/app/messages/actions";
import type {
  ChatMessageItem,
  ConversationListItem,
  LinkedListingContext,
} from "@/lib/messages/data";
import {
  MAX_MESSAGE_ATTACHMENTS,
  mergeOrderedMessages,
  validateAttachmentFileMeta,
} from "@/lib/messages/validation";
import { formatRelativeTime, formatSenToRm } from "@/lib/format";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

interface MessagesClientProps {
  currentUserId: string;
  initialConversations: ConversationListItem[];
  initialActiveConversationId: string | null;
  initialMessages: ChatMessageItem[];
  initialHasOlder: boolean;
  activeListing: LinkedListingContext | null;
  hasExplicitConversationParam: boolean;
}

function getInitials(name: string): string {
  const [first, second] = name.trim().split(/\s+/).filter(Boolean);
  if (!first) return "BU";
  if (!second) return first.slice(0, 2).toUpperCase();
  return `${first.charAt(0)}${second.charAt(0)}`.toUpperCase();
}

function formatMessageTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-MY", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|webp|gif)$/i.test(path);
}

function getAttachmentName(path: string): string {
  const segment = path.split("/").pop() ?? "attachment";
  return segment.replace(/^\d+-\d+-/, "");
}

function attachmentProxyUrl(conversationId: string, path: string): string {
  return `/api/messages/attachment?conversationId=${encodeURIComponent(conversationId)}&path=${encodeURIComponent(path)}`;
}

export function MessagesClient({
  currentUserId,
  initialConversations,
  initialActiveConversationId,
  initialMessages,
  initialHasOlder,
  activeListing,
  hasExplicitConversationParam,
}: MessagesClientProps) {
  const router = useRouter();
  const [conversations, setConversations] =
    useState<ConversationListItem[]>(initialConversations);
  const [messages, setMessages] = useState<ChatMessageItem[]>(initialMessages);
  const [hasOlder, setHasOlder] = useState<boolean>(initialHasOlder);
  const [searchQuery, setSearchQuery] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [realtimeStatus, setRealtimeStatus] = useState<
    "connecting" | "live" | "offline"
  >("connecting");
  const [showMobileDetails, setShowMobileDetails] = useState(false);
  const [mobileShowChat, setMobileShowChat] = useState<boolean>(
    hasExplicitConversationParam && Boolean(initialActiveConversationId)
  );
  const [isSending, startSendTransition] = useTransition();
  const [isLoadingOlder, startLoadOlderTransition] = useTransition();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const activeConversation =
    conversations.find((c) => c.id === initialActiveConversationId) ?? null;

  // Auto-scroll to latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, initialActiveConversationId]);

  // Mark active conversation unread notifications as read when opened
  useEffect(() => {
    if (!activeConversation || activeConversation.unreadCount <= 0) return;
    let cancelled = false;
    void markConversationReadAction(activeConversation.id).then((res) => {
      if (cancelled || !res.ok) return;
      setConversations((prev) =>
        prev.map((c) =>
          c.id === activeConversation.id ? { ...c, unreadCount: 0 } : c
        )
      );
      router.refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [activeConversation, router]);

  // Real Supabase Realtime subscription for the active conversation
  useEffect(() => {
    if (!initialActiveConversationId) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    const channel = supabase
      .channel(`messages:${initialActiveConversationId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${initialActiveConversationId}`,
        },
        (payload) => {
          const raw = payload.new as {
            id: string;
            conversation_id: string;
            sender_id: string;
            body: string | null;
            image_paths: string[] | null;
            listing_id: string | null;
            order_id: string | null;
            free_notice_id: string | null;
            service_request_id: string | null;
            edited_at: string | null;
            created_at: string;
          };
          if (!raw?.id) return;

          const incoming: ChatMessageItem = {
            id: raw.id,
            conversationId: raw.conversation_id,
            senderId: raw.sender_id,
            body: raw.body ?? "",
            imagePaths: Array.isArray(raw.image_paths) ? raw.image_paths : [],
            listingId: raw.listing_id,
            orderId: raw.order_id,
            freeNoticeId: raw.free_notice_id,
            serviceRequestId: raw.service_request_id,
            editedAt: raw.edited_at,
            createdAt: raw.created_at,
          };

          setMessages((prev) => mergeOrderedMessages(prev, [incoming]));
          setConversations((prev) =>
            prev.map((c) =>
              c.id === incoming.conversationId
                ? {
                    ...c,
                    lastMessageAt: incoming.createdAt,
                    lastMessagePreview:
                      incoming.body ||
                      (incoming.imagePaths.length > 0
                        ? "Sent an attachment"
                        : "New message"),
                    lastMessageSenderId: incoming.senderId,
                  }
                : c
            )
          );

          if (incoming.senderId !== currentUserId) {
            void markConversationReadAction(incoming.conversationId).then(() => {
              router.refresh();
            });
          }
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          setRealtimeStatus("live");
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setRealtimeStatus("offline");
        }
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [initialActiveConversationId, currentUserId, router]);

  const filteredConversations = conversations.filter((c) => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    return (
      c.peer.displayName.toLowerCase().includes(q) ||
      (c.peer.shopName?.toLowerCase().includes(q) ?? false) ||
      (c.linkedListingTitle?.toLowerCase().includes(q) ?? false) ||
      c.lastMessagePreview.toLowerCase().includes(q)
    );
  });

  function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    setComposerError(null);
    const picked = Array.from(e.target.files ?? []);
    if (picked.length === 0) return;

    const combined = [...selectedFiles, ...picked].slice(
      0,
      MAX_MESSAGE_ATTACHMENTS
    );
    for (const f of combined) {
      const check = validateAttachmentFileMeta({
        name: f.name,
        type: f.type,
        size: f.size,
      });
      if (!check.ok) {
        setComposerError(check.error);
        e.target.value = "";
        return;
      }
    }
    setSelectedFiles(combined);
    e.target.value = "";
  }

  function handleSend(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!activeConversation || activeConversation.isBlocked || isSending) return;
    setComposerError(null);

    const trimmed = draftBody.trim();
    if (trimmed.length === 0 && selectedFiles.length === 0) {
      setComposerError("Write a message or attach a file before sending.");
      return;
    }

    const formData = new FormData();
    formData.set("conversationId", activeConversation.id);
    formData.set("body", trimmed);
    if (activeListing?.id) {
      formData.set("listingId", activeListing.id);
    }
    for (const file of selectedFiles) {
      formData.append("attachments", file);
    }

    startSendTransition(async () => {
      try {
        const res = await sendMessageAction(formData);
        if (!res.ok || !res.message) {
          setComposerError(res.error || "Could not send message. Please retry.");
          return;
        }

        const sent = res.message;
        setMessages((prev) => mergeOrderedMessages(prev, [sent]));
        setConversations((prev) => {
          const updated = prev.map((c) =>
            c.id === sent.conversationId
              ? {
                  ...c,
                  lastMessageAt: sent.createdAt,
                  lastMessagePreview:
                    sent.body ||
                    (sent.imagePaths.length > 0
                      ? "Sent an attachment"
                      : "New message"),
                  lastMessageSenderId: sent.senderId,
                }
              : c
          );
          return updated.sort(
            (a, b) =>
              new Date(b.lastMessageAt).getTime() -
              new Date(a.lastMessageAt).getTime()
          );
        });
        setDraftBody("");
        setSelectedFiles([]);
      } catch {
        setComposerError("Network error while sending message. Please retry.");
      }
    });
  }

  function handleLoadOlder() {
    if (!activeConversation || !hasOlder || isLoadingOlder) return;
    const oldest = messages[0];
    if (!oldest) return;

    startLoadOlderTransition(async () => {
      const res = await loadOlderMessagesAction({
        conversationId: activeConversation.id,
        beforeCreatedAt: oldest.createdAt,
      });
      if (res.ok && res.messages) {
        setMessages((prev) => mergeOrderedMessages(res.messages!, prev));
        setHasOlder(Boolean(res.hasOlder));
      } else if (res.error) {
        setComposerError(res.error);
      }
    });
  }

  // Empty inbox state
  if (conversations.length === 0) {
    return (
      <section className="rounded-2xl border border-[#E6E3EE] bg-white px-6 py-14 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-[#E6E3EE] bg-[#FAF9FC] text-[#4E2A84]">
          <MessageCircle className="h-6 w-6" aria-hidden="true" />
        </div>
        <h2 className="mt-4 text-lg font-bold text-[#14121A]">
          No conversations yet
        </h2>
        <p className="mx-auto mt-1.5 max-w-md text-sm text-[#6B6779]">
          Start a chat directly from any product or student service listing to
          ask questions and coordinate campus pickup.
        </p>
        <div className="mt-6">
          <Link
            href="/marketplace"
            className="inline-flex items-center rounded-xl bg-[#4E2A84] px-5 py-2.5 text-sm font-bold text-white transition hover:bg-[#3F216B]"
          >
            Browse Marketplace
          </Link>
        </div>
      </section>
    );
  }

  const listingStatusText = !activeListing
    ? null
    : activeListing.status !== "published"
      ? activeListing.status === "archived"
        ? "Archived"
        : "Unavailable"
      : activeListing.kind === "service"
        ? "Student Service"
        : activeListing.availableStock !== null &&
            activeListing.availableStock <= 0
          ? "Out of Stock"
          : `${activeListing.availableStock} available`;

  const listingStatusColor =
    activeListing &&
    (activeListing.status !== "published" ||
      (activeListing.availableStock !== null &&
        activeListing.availableStock <= 0))
      ? "text-[#B42318]"
      : "text-[#008285]";

  const listingDetailsPanel = activeConversation ? (
    <div className="space-y-4">
      {activeListing ? (
        <div className="rounded-xl border border-[#ECEAF3] bg-white p-4">
          <p className="text-[11px] font-bold uppercase tracking-wider text-[#6B6779]">
            Linked Listing
          </p>

          <div className="mt-3 overflow-hidden rounded-xl border border-[#E6E3EE] bg-[#F7F6FA]">
            <div className="aspect-[4/3] w-full">
              {activeListing.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={activeListing.imageUrl}
                  alt={activeListing.title}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-xs font-semibold text-[#6B6779]">
                  No Photo
                </div>
              )}
            </div>
          </div>

          <Link
            href={`/listings/${activeListing.id}`}
            className="mt-3 block text-sm font-bold text-[#14121A] transition hover:text-[#4E2A84]"
          >
            {activeListing.title}
          </Link>

          <div className="mt-1.5 flex items-baseline justify-between gap-2">
            <span className="text-base font-extrabold text-[#4E2A84]">
              {formatSenToRm(activeListing.priceSen)}
            </span>
            {listingStatusText ? (
              <span className={`text-xs font-bold ${listingStatusColor}`}>
                {listingStatusText}
              </span>
            ) : null}
          </div>

          {activeListing.campusArea ? (
            <p className="mt-2 flex items-center gap-1 text-xs text-[#6B6779]">
              <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{activeListing.campusArea}</span>
            </p>
          ) : null}

          <Link
            href={`/listings/${activeListing.id}`}
            className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-[#E6E3EE] bg-white px-3 py-2 text-xs font-semibold text-[#14121A] transition hover:border-[#4E2A84] hover:text-[#4E2A84]"
          >
            <span>View Listing</span>
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </div>
      ) : null}

      {/* Seller / Member Context */}
      <div className="rounded-xl border border-[#ECEAF3] bg-white p-4">
        <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-[#6B6779]">
          <Store className="h-3.5 w-3.5 text-[#4E2A84]" aria-hidden="true" />
          <span>Campus Member</span>
        </p>

        <div className="mt-3 flex items-center gap-3">
          {activeConversation.peer.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={activeConversation.peer.logoUrl}
              alt={activeConversation.peer.displayName}
              className="h-10 w-10 shrink-0 rounded-xl border border-[#E6E3EE] object-cover"
            />
          ) : (
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#4E2A84] text-xs font-bold text-white">
              {getInitials(
                activeConversation.peer.shopName ||
                  activeConversation.peer.displayName
              )}
            </div>
          )}

          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-[#14121A]">
              {activeConversation.peer.shopName ||
                activeConversation.peer.displayName}
            </p>
            <p className="flex items-center gap-1 text-xs text-[#6B6779]">
              <ShieldCheck
                className="h-3.5 w-3.5 shrink-0 text-[#00A3A6]"
                aria-hidden="true"
              />
              <span className="truncate">{activeConversation.peer.badge}</span>
            </p>
            {activeConversation.peer.faculty ? (
              <p className="text-xs text-[#6B6779]">
                {activeConversation.peer.faculty}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div className="grid grid-cols-1 overflow-hidden rounded-2xl border border-[#E6E3EE] bg-white lg:h-[680px] lg:grid-cols-12">
      {/* LEFT PANE: Searchable Conversation List */}
      <aside
        aria-label="Conversations"
        className={`flex flex-col border-b border-[#ECEAF3] lg:col-span-3 lg:border-r lg:border-b-0 ${
          mobileShowChat ? "hidden lg:flex" : "flex"
        }`}
      >
        <div className="border-b border-[#ECEAF3] p-3.5">
          <label htmlFor="messages-search" className="sr-only">
            Search conversations
          </label>
          <div className="flex items-center rounded-xl border border-[#DCD9E6] bg-[#FAF9FC] px-3 py-2 focus-within:border-[#4E2A84] focus-within:bg-white">
            <Search
              className="mr-2 h-4 w-4 shrink-0 text-[#6B6779]"
              aria-hidden="true"
            />
            <input
              id="messages-search"
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search chats..."
              className="w-full bg-transparent text-xs text-[#14121A] placeholder:text-[#6B6779] focus:outline-none"
            />
          </div>
        </div>

        <ul className="flex-1 divide-y divide-[#F1EFF6] overflow-y-auto">
          {filteredConversations.length === 0 ? (
            <li className="p-5 text-center text-xs text-[#6B6779]">
              No matching conversations.
            </li>
          ) : (
            filteredConversations.map((conv) => {
              const isSelected = conv.id === activeConversation?.id;
              const name = conv.peer.shopName || conv.peer.displayName;
              return (
                <li key={conv.id}>
                  <Link
                    href={`/messages?c=${encodeURIComponent(conv.id)}`}
                    onClick={() => setMobileShowChat(true)}
                    className={`flex items-start gap-3 px-3.5 py-3 transition ${
                      isSelected
                        ? "bg-[#F6F3FB]"
                        : "bg-white hover:bg-[#FAF9FC]"
                    }`}
                  >
                    {conv.peer.logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={conv.peer.logoUrl}
                        alt={name}
                        className="h-9 w-9 shrink-0 rounded-xl border border-[#E6E3EE] object-cover"
                      />
                    ) : (
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#4E2A84] text-xs font-bold text-white">
                        {getInitials(name)}
                      </div>
                    )}

                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="truncate text-sm font-bold text-[#14121A]">
                          {name}
                        </p>
                        <span className="shrink-0 text-[11px] text-[#6B6779]">
                          {formatRelativeTime(conv.lastMessageAt)}
                        </span>
                      </div>

                      {conv.linkedListingTitle ? (
                        <p className="truncate text-[11px] font-semibold text-[#4E2A84]">
                          {conv.linkedListingTitle}
                        </p>
                      ) : null}

                      <div className="mt-0.5 flex items-center justify-between gap-2">
                        <p className="truncate text-xs text-[#6B6779]">
                          {conv.lastMessageSenderId === currentUserId
                            ? `You: ${conv.lastMessagePreview}`
                            : conv.lastMessagePreview}
                        </p>
                        {conv.unreadCount > 0 ? (
                          <span className="shrink-0 text-[11px] font-bold text-[#4E2A84]">
                            {conv.unreadCount} unread
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </Link>
                </li>
              );
            })
          )}
        </ul>
      </aside>

      {/* CENTER PANE: Active Chat + Compact Composer */}
      <section
        aria-label="Active conversation"
        className={`flex min-h-[520px] flex-col lg:col-span-6 lg:min-h-0 lg:border-r lg:border-[#ECEAF3] ${
          mobileShowChat ? "flex" : "hidden lg:flex"
        }`}
      >
        {activeConversation ? (
          <>
            {/* Chat Header */}
            <header className="flex items-center justify-between gap-2 border-b border-[#ECEAF3] px-4 py-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => setMobileShowChat(false)}
                  aria-label="Back to conversations"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#E6E3EE] text-[#14121A] lg:hidden"
                >
                  <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                </button>

                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-[#14121A]">
                    {activeConversation.peer.shopName ||
                      activeConversation.peer.displayName}
                  </p>
                  <p className="flex items-center gap-2 text-[11px] text-[#6B6779]">
                    <span>{activeConversation.peer.badge}</span>
                    <span aria-hidden="true">&middot;</span>
                    <span
                      className={
                        realtimeStatus === "live"
                          ? "font-semibold text-[#008285]"
                          : "text-[#6B6779]"
                      }
                    >
                      {realtimeStatus === "live"
                        ? "Live"
                        : realtimeStatus === "connecting"
                          ? "Connecting..."
                          : "Reconnecting..."}
                    </span>
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setShowMobileDetails((v) => !v)}
                aria-expanded={showMobileDetails}
                className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-[#E6E3EE] px-2.5 py-1.5 text-xs font-semibold text-[#14121A] lg:hidden"
              >
                <Info className="h-3.5 w-3.5 text-[#4E2A84]" aria-hidden="true" />
                <span>{showMobileDetails ? "Hide Info" : "Details"}</span>
              </button>
            </header>

            {/* Mobile collapsible listing details */}
            {showMobileDetails ? (
              <div className="border-b border-[#ECEAF3] bg-[#FAF9FC] p-3.5 lg:hidden">
                {listingDetailsPanel}
              </div>
            ) : null}

            {/* Scrollable Messages */}
            <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
              {hasOlder ? (
                <div className="text-center">
                  <button
                    type="button"
                    disabled={isLoadingOlder}
                    onClick={handleLoadOlder}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-[#E6E3EE] bg-white px-3.5 py-1.5 text-xs font-semibold text-[#4E2A84] transition hover:border-[#4E2A84] disabled:opacity-50"
                  >
                    {isLoadingOlder ? (
                      <Loader2
                        className="h-3.5 w-3.5 animate-spin"
                        aria-hidden="true"
                      />
                    ) : null}
                    <span>Load older messages</span>
                  </button>
                </div>
              ) : null}

              {messages.length === 0 ? (
                <p className="py-10 text-center text-xs text-[#6B6779]">
                  No messages yet. Say hello to start the conversation.
                </p>
              ) : (
                messages.map((msg) => {
                  const isOwn = msg.senderId === currentUserId;
                  return (
                    <div
                      key={msg.id}
                      className={`flex flex-col ${
                        isOwn ? "items-end" : "items-start"
                      }`}
                    >
                      <div
                        className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed sm:max-w-[78%] ${
                          isOwn
                            ? "bg-[#4E2A84] text-white"
                            : "border border-[#E6E3EE] bg-[#FAF9FC] text-[#14121A]"
                        }`}
                      >
                        {msg.body ? (
                          <p className="whitespace-pre-wrap break-words">
                            {msg.body}
                          </p>
                        ) : null}

                        {msg.imagePaths.length > 0 ? (
                          <div className="mt-2 space-y-2">
                            {msg.imagePaths.map((path) => {
                              const href = attachmentProxyUrl(
                                msg.conversationId,
                                path
                              );
                              if (isImagePath(path)) {
                                return (
                                  <a
                                    key={path}
                                    href={href}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="block overflow-hidden rounded-xl border border-white/20"
                                  >
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img
                                      src={href}
                                      alt={getAttachmentName(path)}
                                      className="max-h-56 w-auto rounded-xl object-cover"
                                    />
                                  </a>
                                );
                              }
                              return (
                                <a
                                  key={path}
                                  href={href}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold underline underline-offset-2 ${
                                    isOwn
                                      ? "border-white/30 text-white"
                                      : "border-[#DCD9E6] bg-white text-[#4E2A84]"
                                  }`}
                                >
                                  <FileText
                                    className="h-3.5 w-3.5 shrink-0"
                                    aria-hidden="true"
                                  />
                                  <span className="truncate max-w-[180px]">
                                    {getAttachmentName(path)}
                                  </span>
                                </a>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>

                      <span className="mt-1 px-1 text-[11px] text-[#6B6779]">
                        {formatMessageTime(msg.createdAt)}
                      </span>
                    </div>
                  );
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Compact Composer */}
            <div className="border-t border-[#ECEAF3] bg-white px-3.5 py-3">
              {activeConversation.isBlocked ? (
                <p className="flex items-center gap-2 text-xs font-semibold text-[#B42318]">
                  <Ban className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>
                    Messaging is disabled because one participant has blocked
                    the other.
                  </span>
                </p>
              ) : (
                <form onSubmit={handleSend} className="space-y-2">
                  {selectedFiles.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {selectedFiles.map((file, idx) => (
                        <span
                          key={`${file.name}-${idx}`}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-[#E6E3EE] bg-[#FAF9FC] px-2.5 py-1 text-xs font-medium text-[#14121A]"
                        >
                          <span className="max-w-[140px] truncate">
                            {file.name}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              setSelectedFiles((prev) =>
                                prev.filter((_, i) => i !== idx)
                              )
                            }
                            aria-label={`Remove ${file.name}`}
                            className="text-[#6B6779] hover:text-[#B42318]"
                          >
                            <X className="h-3 w-3" aria-hidden="true" />
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : null}

                  {composerError ? (
                    <p
                      role="alert"
                      className="flex items-center gap-1.5 text-xs font-semibold text-[#B42318]"
                    >
                      <AlertCircle
                        className="h-3.5 w-3.5 shrink-0"
                        aria-hidden="true"
                      />
                      <span>{composerError}</span>
                    </p>
                  ) : null}

                  <div className="flex items-center gap-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
                      multiple
                      onChange={handleFilePick}
                      className="sr-only"
                      aria-label="Attach image or PDF"
                    />
                    <button
                      type="button"
                      disabled={
                        isSending ||
                        selectedFiles.length >= MAX_MESSAGE_ATTACHMENTS
                      }
                      onClick={() => fileInputRef.current?.click()}
                      aria-label="Attach image or file"
                      title="Attach image or PDF (max 5 MB)"
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#DCD9E6] bg-white text-[#4A4656] transition hover:border-[#4E2A84] hover:text-[#4E2A84] disabled:opacity-40"
                    >
                      <Paperclip className="h-4 w-4" aria-hidden="true" />
                    </button>

                    <label htmlFor="chat-composer-input" className="sr-only">
                      Write a message
                    </label>
                    <input
                      id="chat-composer-input"
                      type="text"
                      value={draftBody}
                      onChange={(e) => setDraftBody(e.target.value)}
                      maxLength={2000}
                      placeholder="Write a message..."
                      disabled={isSending}
                      className="h-9 min-w-0 flex-1 rounded-xl border border-[#DCD9E6] bg-[#FAF9FC] px-3 text-sm text-[#14121A] placeholder:text-[#6B6779] focus:border-[#4E2A84] focus:bg-white focus:outline-none"
                    />

                    <button
                      type="submit"
                      disabled={
                        isSending ||
                        (draftBody.trim().length === 0 &&
                          selectedFiles.length === 0)
                      }
                      aria-label="Send message"
                      className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-[#4E2A84] px-3.5 text-xs font-bold text-white transition hover:bg-[#3F216B] disabled:cursor-not-allowed disabled:bg-[#C9C4D6]"
                    >
                      {isSending ? (
                        <Loader2
                          className="h-3.5 w-3.5 animate-spin"
                          aria-hidden="true"
                        />
                      ) : (
                        <Send className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                      <span className="hidden sm:inline">Send</span>
                    </button>
                  </div>
                </form>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-[#6B6779]">
            Select a conversation to view messages.
          </div>
        )}
      </section>

      {/* RIGHT PANE: Linked Listing & Seller Details (Desktop) */}
      <aside
        aria-label="Listing and seller details"
        className="hidden overflow-y-auto bg-[#FAF9FC] p-4 lg:col-span-3 lg:block"
      >
        {listingDetailsPanel}
      </aside>
    </div>
  );
}
