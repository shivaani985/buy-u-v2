"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowLeft,
  Ban,
  Check,
  FileText,
  Loader2,
  MessageCircle,
  Paperclip,
  RefreshCw,
  Search,
  Send,
  Tag,
  X,
} from "lucide-react";
import {
  loadOlderMessagesAction,
  markConversationReadAction,
  sendMessageAction,
} from "@/app/messages/actions";
import {
  acceptOfferAction,
  cancelOfferAction,
  counterOfferAction,
  createOfferAction,
  declineOfferAction,
} from "@/app/messages/offer-actions";
import { startOfferToyyibPayCheckoutAction } from "@/app/checkout/actions";
import { OfferCard } from "@/components/messages/OfferCard";
import { ChatReferenceCard } from "@/components/messages/ChatReferenceCard";
import { chatPreview, loadChatReferences, type ChatReference } from "@/lib/messages/context";
import type {
  ChatMessageItem,
  ConversationListItem,
  LinkedListingContext,
} from "@/lib/messages/data";
import {
  computeOfferExpiresAt,
  computeReservationExpiresAt,
  isBargainingEligibleListing,
  mergeChatTimeline,
  normalizeOfferStatus,
  resolveEffectiveOfferStatus,
  type OfferCardItem,
} from "@/lib/messages/offers";
import {
  buildChatAttachmentPath,
  CHAT_ATTACHMENTS_BUCKET,
  MAX_MESSAGE_ATTACHMENTS,
  mergeOrderedMessages,
  validateAttachmentFileMeta,
} from "@/lib/messages/validation";
import { formatSenToRm, resolvePublicStorageUrl } from "@/lib/format";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { getPublicSupabaseEnv } from "@/lib/supabase/env";

interface MessagesClientProps {
  currentUserId: string;
  initialConversations: ConversationListItem[];
  initialActiveConversationId: string | null;
  initialMessages: ChatMessageItem[];
  initialOffers: OfferCardItem[];
  initialHasOlder: boolean;
  activeListing: LinkedListingContext | null;
  initialDraft: { key: string; reference: ChatReference } | null;
  initialDraftError: string | null;
  renderedAt: number;
  hasExplicitConversationParam: boolean;
  initialOpenOffer?: boolean;
  initialVariantId?: string | null;
}

interface OptimisticAttachment {
  name: string;
  isImage: boolean;
  previewUrl: string | null;
}

interface OptimisticMessage {
  clientId: string;
  conversationId: string;
  body: string;
  files: File[];
  uploadedPaths: string[];
  attachments: OptimisticAttachment[];
  reference: ChatReference | null;
  draftKey?: string;
  status: "sending" | "failed";
  error?: string;
}

const CONV_ID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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
    timeZone: "Asia/Kuala_Lumpur",
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

function emitUnreadUpdate(detail: { count?: number; delta?: number }) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("buyu:unread-messages", { detail }));
}

function getCurrentTimestampMs(): number {
  return Date.now();
}

export function MessagesClient({
  currentUserId,
  initialConversations,
  initialActiveConversationId,
  initialMessages,
  initialOffers,
  initialHasOlder,
  activeListing,
  initialDraft,
  initialDraftError,
  renderedAt,
  hasExplicitConversationParam,
  initialOpenOffer = false,
  initialVariantId = null,
}: MessagesClientProps) {
  const router = useRouter();
  const [conversationSeed, setConversationSeed] = useState(initialConversations);
  const [conversations, setConversations] =
    useState<ConversationListItem[]>(initialConversations);
  if (conversationSeed !== initialConversations) {
    setConversationSeed(initialConversations);
    setConversations(initialConversations);
  }
  const knownConversationIds = useRef(new Set(initialConversations.map((conversation) => conversation.id)));
  const [messages, setMessages] = useState<ChatMessageItem[]>(initialMessages);
  const [offers, setOffers] = useState<OfferCardItem[]>(initialOffers);
  const [nowMs, setNowMs] = useState<number>(renderedAt);
  const [offerPanelOpen, setOfferPanelOpen] = useState(
    Boolean(initialOpenOffer)
  );
  const defaultOfferVariant =
    activeListing?.hasVariants && activeListing.variants.length > 0
      ? activeListing.variants.find(
          (v) => v.id === initialVariantId && v.active
        ) ?? (initialVariantId ? null :
          activeListing.variants.find((v) => v.active && v.availableStock > 0) ?? null)
      : null;
  const [selectedOfferVariantId, setSelectedOfferVariantId] = useState<
    string | null
  >(defaultOfferVariant?.id ?? null);
  const offerEntry = activeListing ? `${activeListing.id}:${initialVariantId ?? ""}` : "";
  const [previousOfferEntry, setPreviousOfferEntry] = useState(offerEntry);
  if (offerEntry !== previousOfferEntry) {
    setPreviousOfferEntry(offerEntry);
    setOfferPanelOpen(initialOpenOffer);
    setSelectedOfferVariantId(defaultOfferVariant?.id ?? null);
  }
  const [offerAmountRm, setOfferAmountRm] = useState("");
  const [offerFormError, setOfferFormError] = useState<string | null>(null);
  const [isSubmittingOffer, setIsSubmittingOffer] = useState(false);
  const [busyOfferIds, setBusyOfferIds] = useState<Record<string, boolean>>({});
  const [offerRowErrors, setOfferRowErrors] = useState<
    Record<string, string | null>
  >({});
  const [optimisticMessages, setOptimisticMessages] = useState<
    OptimisticMessage[]
  >([]);
  const [hasOlder, setHasOlder] = useState<boolean>(initialHasOlder);
  const [searchQuery, setSearchQuery] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [realtimeStatus, setRealtimeStatus] = useState<
    "connecting" | "live" | "reconnecting"
  >("connecting");
  const [dismissedDraft, setDismissedDraft] = useState<string>();
  const draft = initialDraft && initialDraft.key !== dismissedDraft ? initialDraft : null;
  const sending = optimisticMessages.some((message) => message.status === "sending");
  const sendLock = useRef(false);
  const isChatVisible = useRef(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const referenceIds = messages.filter((message) => message.reference || !message.body).map((message) => message.id).join(",");

  useEffect(() => {
    knownConversationIds.current = new Set(initialConversations.map((conversation) => conversation.id));
  }, [initialConversations]);
  const [mobileShowChat, setMobileShowChat] = useState<boolean>(
    hasExplicitConversationParam && Boolean(initialActiveConversationId)
  );
  const [isLoadingOlder, startLoadOlderTransition] = useTransition();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const chat = chatRef.current;
    if (!mobileShowChat || !chat) return;
    const viewport = window.visualViewport;
    const resize = () => {
      chat.style.setProperty("--chat-height", `${viewport?.height ?? window.innerHeight}px`);
      chat.style.setProperty("--chat-top", `${viewport?.offsetTop ?? 0}px`);
    };
    resize();
    viewport?.addEventListener("resize", resize);
    viewport?.addEventListener("scroll", resize);
    window.addEventListener("resize", resize);
    return () => {
      viewport?.removeEventListener("resize", resize);
      viewport?.removeEventListener("scroll", resize);
      window.removeEventListener("resize", resize);
    };
  }, [mobileShowChat]);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!referenceIds || !supabase) return;
    let live = true;
    async function refreshReferences() {
      if (!supabase) return;
      const refreshed = await loadChatReferences(supabase, referenceIds.split(","));
      if (!live || !refreshed.size) return;
      setMessages((current) => {
        let changed = false;
        const next = current.map((message) => {
          const reference = refreshed.get(message.id);
          if (!reference || JSON.stringify(reference) === JSON.stringify(message.reference)) return message;
          changed = true;
          return { ...message, reference };
        });
        return changed ? next : current;
      });
    }
    const timer = window.setInterval(refreshReferences, 30_000);
    window.addEventListener("focus", refreshReferences);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshReferences);
    };
  }, [referenceIds]);

  function clearPreparedReference(key: string) {
    setDismissedDraft(key);
    const url = new URL(window.location.href);
    if (url.searchParams.get("draft") === key) {
      for (const param of ["ref", "target", "item", "draft"]) url.searchParams.delete(param);
      if (url.searchParams.get("bargain") !== "1") url.searchParams.delete("variant");
      window.history.replaceState(null, "", url);
    }
  }

  const activeConversation =
    conversations.find((c) => c.id === initialActiveConversationId) ?? null;

  // Refresh offer countdowns and the expiry of displayed Free Items.
  const hasTimedCards = offers.length > 0 || Boolean(referenceIds) || Boolean(draft?.reference.expiresAt);
  useEffect(() => {
    if (!hasTimedCards) return;
    const timer = window.setInterval(() => {
      setNowMs(getCurrentTimestampMs());
    }, 30000);
    return () => window.clearInterval(timer);
  }, [hasTimedCards]);

  // Auto-scroll smoothly when messages, offers, or optimistic bubbles change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [
    messages.length,
    offers.length,
    optimisticMessages.length,
    initialActiveConversationId,
  ]);

  // The default inbox selection is only visible on desktop.
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1024px)");
    let cancelled = false;
    function syncVisibility() {
      isChatVisible.current = desktop.matches || mobileShowChat;
      if (!initialActiveConversationId || !isChatVisible.current) return;
      void markConversationReadAction(initialActiveConversationId).then((res) => {
        if (cancelled || !isChatVisible.current || !res.ok) return;
        setConversations((prev) => prev.map((conv) =>
          conv.id === initialActiveConversationId ? { ...conv, unreadCount: 0 } : conv));
        if (typeof res.remainingUnread === "number") emitUnreadUpdate({ count: res.remainingUnread });
      });
    }
    syncVisibility();
    desktop.addEventListener("change", syncVisibility);
    return () => {
      cancelled = true;
      desktop.removeEventListener("change", syncVisibility);
    };
  }, [initialActiveConversationId, mobileShowChat]);

  // Authenticated Supabase Realtime subscription (messages + unread notifications)
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    let disposed = false;
    let msgChannel: ReturnType<typeof supabase.channel> | null = null;
    let notifChannel: ReturnType<typeof supabase.channel> | null = null;
    let offersChannel: ReturnType<typeof supabase.channel> | null = null;

    const {
      data: { subscription: authSub },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.access_token) {
        supabase.realtime.setAuth(session.access_token);
      }
    });

    async function setupRealtime() {
      if (!supabase) return;
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (disposed) return;

      if (session?.access_token) {
        supabase.realtime.setAuth(session.access_token);
      }

      if (initialActiveConversationId) {
        const receiveMessage = async (payload: { eventType: "INSERT" | "UPDATE"; new: unknown }) => {
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

          const references = await loadChatReferences(supabase, [raw.id]);
          if (disposed) return;
          const incoming: ChatMessageItem = {
            id: raw.id,
            reference: references.get(raw.id),
            conversationId: raw.conversation_id,
            senderId: raw.sender_id,
            body: raw.body ?? "",
            imagePaths: Array.isArray(raw.image_paths)
              ? raw.image_paths
              : [],
            listingId: raw.listing_id,
            orderId: raw.order_id,
            freeNoticeId: raw.free_notice_id,
            serviceRequestId: raw.service_request_id,
            editedAt: raw.edited_at,
            createdAt: raw.created_at,
          };

          setMessages((prev) => {
            const previous = prev.find((message) => message.id === incoming.id);
            return mergeOrderedMessages(prev, [{ ...incoming, reference: incoming.reference ?? previous?.reference }]);
          });
          setConversations((prev) => {
            const updated = prev.map((c) =>
              c.id === incoming.conversationId && incoming.createdAt >= c.lastMessageAt
                ? {
                    ...c,
                    lastMessageAt: incoming.createdAt,
                    lastMessagePreview: chatPreview(incoming.body, incoming.imagePaths.length, incoming.reference),
                    lastMessageSenderId: incoming.senderId,
                  }
                : c
            );
            return updated.sort(
              (a, b) =>
                new Date(b.lastMessageAt).getTime() -
                new Date(a.lastMessageAt).getTime()
            );
          });

          if (payload.eventType === "INSERT" && isChatVisible.current && incoming.senderId !== currentUserId) {
            void markConversationReadAction(incoming.conversationId).then(
              (res) => {
                if (res.ok && typeof res.remainingUnread === "number") {
                  emitUnreadUpdate({ count: res.remainingUnread });
                }
              }
            );
          }
        };
        const messageFilter = {
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${initialActiveConversationId}`,
        };
        msgChannel = supabase
          .channel(`chat-messages-${initialActiveConversationId}`)
          .on("postgres_changes", { ...messageFilter, event: "INSERT" }, receiveMessage)
          .on("postgres_changes", { ...messageFilter, event: "UPDATE" }, receiveMessage)
          .subscribe((status) => {
            if (disposed) return;
            if (status === "SUBSCRIBED") {
              setRealtimeStatus("live");
            } else if (
              status === "CHANNEL_ERROR" ||
              status === "TIMED_OUT" ||
              status === "CLOSED"
            ) {
              setRealtimeStatus("reconnecting");
            }
          });
      }

      // Live unread notification sync across conversation list & navbar
      notifChannel = supabase
        .channel(`chat-notifications-${currentUserId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "notifications",
            filter: `user_id=eq.${currentUserId}`,
          },
          (payload) => {
            const row = payload.new as {
              kind?: string;
              href?: string | null;
              body?: string | null;
              read_at?: string | null;
              created_at?: string;
            };
            const kind = (row?.kind ?? "").toLowerCase();
            if (kind !== "new_message" && kind !== "message") return;
            if (row.read_at !== null && row.read_at !== undefined) return;

            const cidMatch = row.href?.match(CONV_ID_RE);
            const targetConvId = cidMatch ? cidMatch[0].toLowerCase() : null;

            if (targetConvId && !knownConversationIds.current.has(targetConvId)) {
              router.refresh();
              return;
            }

            if (
              isChatVisible.current &&
              targetConvId &&
              initialActiveConversationId &&
              targetConvId === initialActiveConversationId.toLowerCase()
            ) {
              // Currently viewing this conversation — mark read immediately
              void markConversationReadAction(initialActiveConversationId).then(
                (res) => {
                  if (res.ok && typeof res.remainingUnread === "number") {
                    emitUnreadUpdate({ count: res.remainingUnread });
                  }
                }
              );
              return;
            }

            if (targetConvId) {
              setConversations((prev) => {
                const updated = prev.map((c) =>
                  c.id.toLowerCase() === targetConvId
                    ? {
                        ...c,
                        unreadCount: c.unreadCount + 1,
                        lastMessagePreview:
                          row.body?.trim() || c.lastMessagePreview,
                        lastMessageAt: row.created_at || c.lastMessageAt,
                      }
                    : c
                );
                return updated.sort(
                  (a, b) =>
                    new Date(b.lastMessageAt).getTime() -
                    new Date(a.lastMessageAt).getTime()
                );
              });
            }
          }
        )
        .subscribe();

      // Realtime offer card updates (INSERT / UPDATE) for the active conversation
      if (initialActiveConversationId) {
        offersChannel = supabase
          .channel(`chat-offers-${initialActiveConversationId}`)
          .on(
            "postgres_changes",
            {
              event: "*",
              schema: "public",
              table: "offers",
              filter: `conversation_id=eq.${initialActiveConversationId}`,
            },
            (payload) => {
              const raw = payload.new as {
                id?: string;
                conversation_id?: string;
                listing_id?: string;
                buyer_id?: string;
                seller_id?: string;
                proposed_by?: string | null;
                parent_offer_id?: string | null;
                offer_price_sen?: number;
                status?: string;
                order_id?: string | null;
                created_at?: string;
                responded_at?: string | null;
                expires_at?: string | null;
                reservation_expires_at?: string | null;
                reservation_released_at?: string | null;
              };
              if (!raw?.id || !raw.conversation_id || !raw.created_at) return;

              const status = normalizeOfferStatus(raw.status);

              const mapped: OfferCardItem = {
                id: raw.id,
                conversationId: raw.conversation_id,
                listingId: raw.listing_id ?? "",
                variantId: (raw as { variant_id?: string | null }).variant_id ?? null,
                variantLabel: (() => {
                  const snap = (raw as { variant_snapshot?: Record<string, string> | null }).variant_snapshot;
                  if (snap) return Object.values(snap).filter(Boolean).join(" · ") || null;
                  const vId = (raw as { variant_id?: string | null }).variant_id;
                  return activeListing?.variants.find((v) => v.id === vId)?.label ?? null;
                })(),
                variantImageUrl: (() => {
                  const path = (raw as { variant_image_path?: string | null }).variant_image_path;
                  const storedImage = resolvePublicStorageUrl("listings", path, getPublicSupabaseEnv()?.url);
                  if (storedImage || raw.listing_id !== activeListing?.id) return storedImage;
                  const vId = (raw as { variant_id?: string | null }).variant_id;
                  const match = vId
                    ? activeListing?.variants.find((v) => v.id === vId)
                    : null;
                  return match?.imageUrl ?? activeListing?.imageUrl ?? null;
                })(),
                buyerId: raw.buyer_id ?? "",
                sellerId: raw.seller_id ?? "",
                proposedBy: raw.proposed_by ?? raw.buyer_id ?? "",
                parentOfferId: raw.parent_offer_id ?? null,
                offerPriceSen: Number(raw.offer_price_sen ?? 0),
                status,
                orderId: raw.order_id ?? null,
                createdAt: raw.created_at,
                respondedAt: raw.responded_at ?? null,
                expiresAt: computeOfferExpiresAt(
                  raw.created_at,
                  raw.expires_at
                ),
                reservationExpiresAt:
                  status === "accepted"
                    ? computeReservationExpiresAt(
                        raw.responded_at ?? null,
                        raw.reservation_expires_at
                      )
                    : raw.reservation_expires_at ?? null,
                reservationReleasedAt: raw.reservation_released_at ?? null,
              };

              setOffers((prev) => {
                const exists = prev.some((o) => o.id === mapped.id);
                if (exists) {
                  return prev.map((o) => (o.id === mapped.id ? mapped : o));
                }
                return [...prev, mapped];
              });
            }
          )
          .subscribe();
      }
    }

    void setupRealtime();

    return () => {
      disposed = true;
      authSub.unsubscribe();
      if (msgChannel) void supabase.removeChannel(msgChannel);
      if (notifChannel) void supabase.removeChannel(notifChannel);
      if (offersChannel) void supabase.removeChannel(offersChannel);
    };
  }, [initialActiveConversationId, currentUserId, activeListing?.id, activeListing?.imageUrl, activeListing?.variants, router]);

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

  function revokePreviews(item: OptimisticMessage) {
    for (const att of item.attachments) {
      if (att.previewUrl) {
        URL.revokeObjectURL(att.previewUrl);
      }
    }
  }

  async function deliverOptimisticMessage(opt: OptimisticMessage) {
    const supabase = getSupabaseBrowserClient();
    const uploadedPaths = [...opt.uploadedPaths];

    // 1. Upload any remaining attachments directly to private `chat-attachments`
    //    matching Storage RLS (`senderUid/conversationId/...`).
    if (opt.files.length > uploadedPaths.length) {
      if (!supabase) {
        setOptimisticMessages((prev) =>
          prev.map((m) =>
            m.clientId === opt.clientId
              ? {
                  ...m,
                  status: "failed",
                  error: "Storage client is unavailable. Please refresh.",
                }
              : m
          )
        );
        return;
      }

      const timestamp = getCurrentTimestampMs();
      for (let i = uploadedPaths.length; i < opt.files.length; i += 1) {
        const file = opt.files[i]!;
        const storagePath = buildChatAttachmentPath(
          currentUserId,
          opt.conversationId,
          file.name,
          i,
          timestamp
        );

        const { error: uploadErr } = await supabase.storage
          .from(CHAT_ATTACHMENTS_BUCKET)
          .upload(storagePath, file, {
            contentType: file.type,
            upsert: false,
          });

        if (uploadErr) {
          setOptimisticMessages((prev) =>
            prev.map((m) =>
              m.clientId === opt.clientId
                ? {
                    ...m,
                    uploadedPaths,
                    status: "failed",
                    error: `Upload failed for "${file.name}": ${uploadErr.message}`,
                  }
                : m
            )
          );
          return;
        }

        uploadedPaths.push(storagePath);
      }
    }

    // 2. Persist message row & create recipient notification server-side
    try {
      const res = await sendMessageAction({
        messageId: opt.clientId,
        conversationId: opt.conversationId,
        body: opt.body,
        attachmentPaths: uploadedPaths,
        reference: opt.reference,
      });

      if (!res.ok || !res.message) {
        setOptimisticMessages((prev) =>
          prev.map((m) =>
            m.clientId === opt.clientId
              ? {
                  ...m,
                  uploadedPaths,
                  status: "failed",
                  error: res.error || "Could not send message. Please retry.",
                }
              : m
          )
        );
        return;
      }

      const persisted = res.message;
      if (opt.draftKey) clearPreparedReference(opt.draftKey);
      setDraftBody("");
      setSelectedFiles([]);
      setComposerError(null);
      revokePreviews(opt);
      setOptimisticMessages((prev) =>
        prev.filter((m) => m.clientId !== opt.clientId)
      );
      setMessages((prev) => mergeOrderedMessages(prev, [persisted]));
      setConversations((prev) => {
        const updated = prev.map((c) =>
          c.id === persisted.conversationId && persisted.createdAt >= c.lastMessageAt
            ? {
                ...c,
                lastMessageAt: persisted.createdAt,
                lastMessagePreview: chatPreview(persisted.body, persisted.imagePaths.length, persisted.reference),
                lastMessageSenderId: persisted.senderId,
              }
            : c
        );
        return updated.sort(
          (a, b) =>
            new Date(b.lastMessageAt).getTime() -
            new Date(a.lastMessageAt).getTime()
        );
      });
    } catch {
      setOptimisticMessages((prev) =>
        prev.map((m) =>
          m.clientId === opt.clientId
            ? {
                ...m,
                uploadedPaths,
                status: "failed",
                error: "Connection error while sending. Tap Retry to resend.",
              }
            : m
        )
      );
    }
  }

  function beginDelivery(message: OptimisticMessage) {
    if (sendLock.current) return;
    sendLock.current = true;
    const existing = optimisticMessages.find((item) => item.clientId !== message.clientId);
    if (existing) revokePreviews(existing);
    setOptimisticMessages([{ ...message, status: "sending", error: undefined }]);
    void deliverOptimisticMessage(message).catch(() => {
      setOptimisticMessages((current) => current.map((item) => item.clientId === message.clientId
        ? { ...item, status: "failed", error: "Connection error. Try sending again." } : item));
    }).finally(() => { sendLock.current = false; });
  }

  function handleSend(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!activeConversation || sendLock.current || (activeConversation.isBlocked && draft?.reference.kind !== "order")) return;
    setComposerError(null);

    const trimmed = draftBody.trim();
    if (!trimmed && selectedFiles.length === 0 && !draft) {
      setComposerError("Write a message or add a reference or file before sending.");
      return;
    }
    const failed = optimisticMessages.find((message) => message.status === "failed");
    if (failed && failed.body === trimmed && failed.draftKey === draft?.key &&
        failed.files.length === selectedFiles.length && failed.files.every((file, i) => file === selectedFiles[i])) {
      beginDelivery(failed);
      return;
    }

    beginDelivery({
      clientId: crypto.randomUUID(),
      conversationId: activeConversation.id,
      body: trimmed,
      files: [...selectedFiles],
      uploadedPaths: [],
      attachments: selectedFiles.map((file) => ({
        name: file.name,
        isImage: file.type.startsWith("image/"),
        previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
      })),
      reference: draft?.reference ?? null,
      draftKey: draft?.key,
      status: "sending",
    });
  }

  function handleDismissOptimistic(clientId: string) {
    const target = optimisticMessages.find((m) => m.clientId === clientId);
    if (target) revokePreviews(target);
    setOptimisticMessages((prev) =>
      prev.filter((m) => m.clientId !== clientId)
    );
  }

  function upsertOffer(nextOffer: OfferCardItem) {
    setOffers((prev) => {
      const exists = prev.some((o) => o.id === nextOffer.id);
      return exists
        ? prev.map((o) => (o.id === nextOffer.id ? nextOffer : o))
        : [...prev, nextOffer];
    });
  }

  async function handleCreateOffer(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!activeConversation || !activeListing || isSubmittingOffer) return;
    setOfferFormError(null);
    setIsSubmittingOffer(true);

    try {
      const res = await createOfferAction({
        conversationId: activeConversation.id,
        listingId: activeListing.id,
        variantId: activeListing.hasVariants ? selectedOfferVariantId : null,
        amountRm: offerAmountRm,
      });

      if (!res.ok || !res.offer) {
        setOfferFormError(res.error || "Could not submit offer. Please retry.");
        return;
      }

      upsertOffer(res.offer);
      setOfferAmountRm("");
      setOfferPanelOpen(false);
    } catch {
      setOfferFormError("Network error while submitting offer. Please retry.");
    } finally {
      setIsSubmittingOffer(false);
    }
  }

  async function runOfferAction(
    offerId: string,
    fn: (id: string) => Promise<{
      ok: boolean;
      offer?: OfferCardItem;
      error?: string;
    }>
  ) {
    if (busyOfferIds[offerId]) return;
    setBusyOfferIds((prev) => ({ ...prev, [offerId]: true }));
    setOfferRowErrors((prev) => ({ ...prev, [offerId]: null }));

    try {
      const res = await fn(offerId);
      if (!res.ok) {
        setOfferRowErrors((prev) => ({
          ...prev,
          [offerId]: res.error || "Action failed. Please try again.",
        }));
      } else if (res.offer) {
        upsertOffer(res.offer);
      }
    } catch {
      setOfferRowErrors((prev) => ({
        ...prev,
        [offerId]: "Network error. Please try again.",
      }));
    } finally {
      setBusyOfferIds((prev) => ({ ...prev, [offerId]: false }));
    }
  }

  async function handleCounterOffer(
    offerId: string,
    amountRm: string
  ): Promise<{ ok: boolean; error?: string }> {
    if (busyOfferIds[offerId]) {
      return { ok: false, error: "Counter offer already in progress." };
    }
    setBusyOfferIds((prev) => ({ ...prev, [offerId]: true }));
    setOfferRowErrors((prev) => ({ ...prev, [offerId]: null }));

    try {
      const res = await counterOfferAction({ offerId, amountRm });
      if (!res.ok || !res.offer) {
        const msg = res.error || "Could not send counter offer. Please try again.";
        setOfferRowErrors((prev) => ({ ...prev, [offerId]: msg }));
        return { ok: false, error: msg };
      }

      const nextOffer = res.offer;
      const supersededId = res.supersededOfferId ?? offerId;
      setOffers((prev) => {
        const updated = prev.map((o) =>
          o.id === supersededId
            ? { ...o, status: "superseded" as const, respondedAt: nextOffer.createdAt }
            : o
        );
        const exists = updated.some((o) => o.id === nextOffer.id);
        return exists
          ? updated.map((o) => (o.id === nextOffer.id ? nextOffer : o))
          : [...updated, nextOffer];
      });
      return { ok: true };
    } catch {
      const msg = "Network error while sending counter offer. Please try again.";
      setOfferRowErrors((prev) => ({ ...prev, [offerId]: msg }));
      return { ok: false, error: msg };
    } finally {
      setBusyOfferIds((prev) => ({ ...prev, [offerId]: false }));
    }
  }

  const activeOfferVariant =
    activeListing?.hasVariants && activeListing.variants.length > 0
      ? activeListing.variants.find((v) => v.id === selectedOfferVariantId) ??
        null
      : null;

  const activeOfferListedPriceSen = activeOfferVariant
    ? activeOfferVariant.priceSen
    : activeListing?.priceSen ?? 0;

  const activeOfferStock = activeListing?.hasVariants
    ? activeOfferVariant?.active
      ? activeOfferVariant.availableStock
      : 0
    : activeListing?.availableStock ?? 0;

  const canMakeOffer = Boolean(
    activeConversation &&
      !activeConversation.isBlocked &&
      activeListing &&
      activeListing.status === "published" &&
      isBargainingEligibleListing({
        kind: activeListing.kind,
        isFood: activeListing.isFood,
        availabilityMode: activeListing.availabilityMode,
      }) &&
      activeListing.allowOffers &&
      activeListing.sellerId.toLowerCase() !== currentUserId.toLowerCase() &&
      (activeListing.hasVariants
        ? activeListing.variants.some((v) => v.active && v.availableStock >= 1)
        : (activeListing.availableStock ?? 0) >= 1)
  );

  const hasActivePendingOffer = Boolean(
    activeListing &&
      offers.some(
        (o) =>
          o.listingId === activeListing.id &&
          o.buyerId.toLowerCase() === currentUserId.toLowerCase() &&
          resolveEffectiveOfferStatus(o, nowMs) === "pending"
      )
  );

  const timelineEntries = mergeChatTimeline(messages, offers);

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

  return (
    <div ref={chatRef} className={`grid min-w-0 grid-cols-1 overflow-hidden border border-[#E6E3EE] bg-white
      lg:static lg:h-[min(72dvh,760px)] lg:min-h-[530px] lg:grid-cols-[minmax(240px,3fr)_minmax(0,7fr)] lg:rounded-2xl
      ${mobileShowChat ? "max-lg:fixed max-lg:inset-x-0 max-lg:top-[var(--chat-top,0px)] max-lg:z-[80] max-lg:h-[var(--chat-height,100dvh)]"
        : "rounded-2xl"}`}>
      {/* LEFT PANE: Searchable Conversation List */}
      <aside
        aria-label="Conversations"
        className={`min-h-0 min-w-0 flex-col border-b border-[#ECEAF3] lg:border-r lg:border-b-0 ${
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
                          {formatMessageTime(conv.lastMessageAt)}
                        </span>
                      </div>

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

      {/* CENTER PANE: Active Chat + Optimistic Bubbles + Compact Composer */}
      <section
        aria-label="Active conversation"
        className={`min-h-0 min-w-0 flex-col ${
          mobileShowChat ? "flex" : "hidden lg:flex"
        }`}
      >
        {activeConversation ? (
          <>
            <header className="flex shrink-0 items-center justify-between gap-2 border-b border-[#ECEAF3] px-4 py-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    if (draft) clearPreparedReference(draft.key);
                    setMobileShowChat(false);
                  }}
                  aria-label="Back to conversations"
                  className="grid size-11 shrink-0 place-items-center rounded-lg border border-[#E6E3EE] text-[#14121A] lg:hidden"
                >
                  <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                </button>

                {activeConversation.peer.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={activeConversation.peer.logoUrl} alt="" className="size-9 shrink-0 rounded-lg object-cover" />
                ) : <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-lg bg-[#4E2A84] text-xs font-bold text-white">
                  {getInitials(activeConversation.peer.shopName || activeConversation.peer.displayName)}
                </span>}
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

            </header>

            {/* Scrollable Messages + Optimistic Pending/Failed Bubbles */}
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-3 py-4 sm:px-4">
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

              {timelineEntries.length === 0 &&
              optimisticMessages.length === 0 ? (
                <p className="py-10 text-center text-xs text-[#6B6779]">
                  No messages yet. Say hello to start the conversation.
                </p>
              ) : (
                <>
                  {timelineEntries.map((entry) => {
                    if (entry.kind === "offer") {
                      const offer = entry.offer;
                      return (
                        <OfferCard
                          key={`offer-${offer.id}`}
                          offer={offer}
                          currentUserId={currentUserId}
                          peerName={
                            activeConversation.peer.shopName ||
                            activeConversation.peer.displayName
                          }
                          listingTitle={
                            activeListing && activeListing.id === offer.listingId
                              ? activeListing.title
                              : null
                          }
                          nowMs={nowMs}
                          isBusy={Boolean(busyOfferIds[offer.id])}
                          error={offerRowErrors[offer.id] ?? null}
                          onAccept={(id) =>
                            void runOfferAction(id, acceptOfferAction)
                          }
                          onDecline={(id) =>
                            void runOfferAction(id, declineOfferAction)
                          }
                          onCancel={(id) =>
                            void runOfferAction(id, cancelOfferAction)
                          }
                          onCounter={handleCounterOffer}
                          onPay={async (id) => {
                            setBusyOfferIds((prev) => ({ ...prev, [id]: true }));
                            setOfferRowErrors((prev) => {
                              const next = { ...prev };
                              delete next[id];
                              return next;
                            });
                            try {
                              const res = await startOfferToyyibPayCheckoutAction(id);
                              if (!res.ok || !res.billUrl) {
                                setOfferRowErrors((prev) => ({
                                  ...prev,
                                  [id]:
                                    res.error ||
                                    "Could not open ToyyibPay bill right now.",
                                }));
                                return;
                              }
                              window.location.assign(res.billUrl);
                            } catch {
                              setOfferRowErrors((prev) => ({
                                ...prev,
                                [id]: "Network error while starting payment.",
                              }));
                            } finally {
                              setBusyOfferIds((prev) => {
                                const next = { ...prev };
                                delete next[id];
                                return next;
                              });
                            }
                          }}
                        />
                      );
                    }

                    const msg = entry.message;
                    const isOwn = msg.senderId === currentUserId;
                    return (
                      <div
                        key={msg.id}
                        className={`flex flex-col ${
                          isOwn ? "items-end" : "items-start"
                        }`}
                      >
                        <div
                          className={`min-w-0 max-w-[88%] rounded-2xl px-3 py-2 text-sm leading-relaxed sm:max-w-[min(75%,38rem)] ${
                            isOwn
                              ? "bg-[#4E2A84] text-white"
                              : "border border-[#E6E3EE] bg-[#FAF9FC] text-[#14121A]"
                          }`}
                        >
                          {msg.reference && <ChatReferenceCard reference={msg.reference} conversationId={msg.conversationId} now={nowMs} />}
                          {msg.body ? (
                            <p className={`whitespace-pre-wrap [overflow-wrap:anywhere] ${msg.reference ? "mt-2" : ""}`}>
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
                                    <span className="max-w-[180px] truncate">
                                      {getAttachmentName(path)}
                                    </span>
                                  </a>
                                );
                              })}
                            </div>
                          ) : null}
                        </div>

                        <span className="mt-1 flex items-center gap-1 px-1 text-[11px] text-[#6B6779]">
                          <span>{formatMessageTime(msg.createdAt)}</span>
                          {isOwn ? (
                            <Check
                              className="h-3 w-3 text-[#008285]"
                              aria-label="Sent"
                            />
                          ) : null}
                        </span>
                      </div>
                    );
                  })}

                  {/* Optimistic Pending / Failed Bubbles */}
                  {optimisticMessages.filter((opt) => !messages.some((msg) => msg.id === opt.clientId)).map((opt) => (
                    <div key={opt.clientId} className="flex flex-col items-end">
                      <div
                        className={`min-w-0 max-w-[88%] rounded-2xl px-3 py-2 text-sm leading-relaxed sm:max-w-[min(75%,38rem)] ${
                          opt.status === "failed"
                            ? "border border-[#B42318]/40 bg-[#4E2A84]/85 text-white"
                            : "bg-[#4E2A84]/80 text-white"
                        }`}
                      >
                        {opt.reference && <ChatReferenceCard reference={opt.reference} conversationId={opt.conversationId} now={nowMs} disabled />}
                        {opt.body ? (
                          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                            {opt.body}
                          </p>
                        ) : null}

                        {opt.attachments.length > 0 ? (
                          <div className="mt-2 space-y-2">
                            {opt.attachments.map((att, idx) =>
                              att.isImage && att.previewUrl ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  key={`${att.name}-${idx}`}
                                  src={att.previewUrl}
                                  alt={att.name}
                                  className="max-h-48 w-auto rounded-xl object-cover opacity-85"
                                />
                              ) : (
                                <span
                                  key={`${att.name}-${idx}`}
                                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/30 px-2.5 py-1 text-xs font-semibold text-white"
                                >
                                  <FileText
                                    className="h-3.5 w-3.5 shrink-0"
                                    aria-hidden="true"
                                  />
                                  <span className="max-w-[180px] truncate">
                                    {att.name}
                                  </span>
                                </span>
                              )
                            )}
                          </div>
                        ) : null}
                      </div>

                      {opt.status === "sending" ? (
                        <span className="mt-1 flex items-center gap-1 px-1 text-[11px] text-[#6B6779]">
                          <Loader2
                            className="h-3 w-3 animate-spin"
                            aria-hidden="true"
                          />
                          <span>Sending...</span>
                        </span>
                      ) : (
                        <div className="mt-1 flex flex-wrap items-center justify-end gap-2 px-1 text-[11px]">
                          <span className="font-semibold text-[#B42318]">
                            {opt.error || "Failed to send"}
                          </span>
                          <button
                            type="submit"
                            form="chat-composer"
                            className="inline-flex items-center gap-1 font-bold text-[#4E2A84] underline underline-offset-2"
                          >
                            <RefreshCw className="h-3 w-3" aria-hidden="true" />
                            <span>Retry</span>
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              handleDismissOptimistic(opt.clientId)
                            }
                            className="font-semibold text-[#6B6779] hover:text-[#14121A]"
                          >
                            Dismiss
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Compact Collapsible Bargain / Offer Panel (Pre-Loved & non-food Student Business) */}
            {canMakeOffer && activeListing ? (
              <div className="max-h-[40%] shrink-0 overflow-y-auto border-t border-[#ECEAF3] bg-[#FAF9FC] px-3.5 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setOfferFormError(null);
                      setOfferPanelOpen((v) => !v);
                    }}
                    aria-expanded={offerPanelOpen}
                    className="press-feedback inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#4E2A84]/25 bg-[#F4F1FA] px-3 py-1 text-xs font-bold text-[#4E2A84] transition-colors hover:bg-[#4E2A84] hover:text-white"
                  >
                    <Tag className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>
                      {offerPanelOpen ? "Hide Bargain Form" : "Bargain / Make an Offer"}
                    </span>
                  </button>
                  <Link href={`/listings/${activeListing.id}`} className="min-w-0 truncate text-xs font-bold text-brand-purple hover:underline">
                    {activeListing.title}
                  </Link>
                  <span className="text-[11px] text-[#6B6779]">
                    Listed at {formatSenToRm(activeOfferListedPriceSen)} · Min RM
                    2.00
                  </span>
                </div>

                {offerPanelOpen ? (
                  <form
                    onSubmit={handleCreateOffer}
                    className="mt-2.5 space-y-2"
                  >
                    {hasActivePendingOffer ? (
                      <p className="text-xs font-semibold text-[#1D70B8]">
                        There is already a pending offer in this chat. Respond
                        to, cancel, or counter it in the conversation above.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {activeListing.hasVariants &&
                        activeListing.variants.length > 0 ? (
                          <div>
                            <label
                              htmlFor="offer-variant-select"
                              className="mb-1 block text-[11px] font-semibold text-[#555062]"
                            >
                              Select Variant
                            </label>
                            <select
                              id="offer-variant-select"
                              value={selectedOfferVariantId ?? ""}
                              onChange={(e) =>
                                setSelectedOfferVariantId(e.target.value)
                              }
                              disabled={isSubmittingOffer}
                              className="h-9 w-full cursor-pointer rounded-xl border border-[#DCD9E6] bg-white px-3 text-xs font-semibold text-[#14121A] outline-none focus:border-[#4E2A84]"
                            >
                              {activeListing.variants.map((v) => (
                                <option
                                  key={v.id}
                                  value={v.id}
                                  disabled={!v.active || v.availableStock < 1}
                                >
                                  {v.label} — {formatSenToRm(v.priceSen)} (
                                  {!v.active || v.availableStock < 1
                                    ? "Out of stock"
                                    : `${v.availableStock} left`}
                                  )
                                </option>
                              ))}
                            </select>
                          </div>
                        ) : null}

                        <div className="flex flex-wrap items-center gap-2">
                          <label htmlFor="offer-amount-rm" className="sr-only">
                            Offer amount in RM
                          </label>
                          <div className="flex min-w-[140px] flex-1 items-center rounded-xl border border-[#DCD9E6] bg-white px-3 py-1.5 focus-within:border-[#4E2A84]">
                            <span className="mr-1.5 text-xs font-bold text-[#6B6779]">
                              RM
                            </span>
                            <input
                              id="offer-amount-rm"
                              type="text"
                              inputMode="decimal"
                              autoFocus={Boolean(initialOpenOffer)}
                              value={offerAmountRm}
                              onChange={(e) => setOfferAmountRm(e.target.value)}
                              placeholder="e.g. 12.00"
                              disabled={
                                isSubmittingOffer || activeOfferStock < 1
                              }
                              className="w-full bg-transparent text-sm font-semibold text-[#14121A] placeholder:text-[#7A7588] focus:outline-none"
                            />
                          </div>
                        <button
                          type="submit"
                          disabled={
                            isSubmittingOffer ||
                            activeOfferStock < 1 ||
                            offerAmountRm.trim().length === 0
                          }
                          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-[#4E2A84] px-4 text-xs font-bold text-white transition hover:bg-[#3F216B] disabled:cursor-not-allowed disabled:bg-[#C9C4D6]"
                        >
                          {isSubmittingOffer ? (
                            <Loader2
                              className="h-3.5 w-3.5 animate-spin"
                              aria-hidden="true"
                            />
                          ) : null}
                          <span>Send Offer</span>
                        </button>
                        </div>
                      </div>
                    )}

                    {offerFormError ? (
                      <p
                        role="alert"
                        className="flex items-center gap-1.5 text-xs font-semibold text-[#B42318]"
                      >
                        <AlertCircle
                          className="h-3.5 w-3.5 shrink-0"
                          aria-hidden="true"
                        />
                        <span>{offerFormError}</span>
                      </p>
                    ) : null}

                    <p className="text-[11px] text-[#6B6779]">
                      Offers expire in 24 hours. Accepted offers hold 1 unit for
                      30 minutes.
                    </p>
                  </form>
                ) : null}
              </div>
            ) : null}

            {/* Compact Composer */}
            <div className="shrink-0 border-t border-[#ECEAF3] bg-white px-3.5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              {activeConversation.isBlocked && draft?.reference.kind !== "order" ? (
                <p className="flex items-center gap-2 text-xs font-semibold text-[#B42318]">
                  <Ban className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>
                    Messaging is disabled because one participant has blocked
                    the other.
                  </span>
                </p>
              ) : (
                <form id="chat-composer" onSubmit={handleSend} className="space-y-2">
                  {draft && <ChatReferenceCard reference={draft.reference} conversationId={activeConversation.id}
                    draftKey={draft.key} disabled={sending} now={nowMs}
                    onRemove={() => clearPreparedReference(draft.key)} />}
                  {initialDraftError && <p role="status" className="text-xs text-[#B42318]">{initialDraftError}</p>}
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
                            disabled={sending}
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
                      disabled={sending}
                      onChange={handleFilePick}
                      className="sr-only"
                      aria-label="Attach image or PDF"
                    />
                    <button
                      type="button"
                      disabled={sending || selectedFiles.length >= MAX_MESSAGE_ATTACHMENTS}
                      onClick={() => fileInputRef.current?.click()}
                      aria-label="Attach image or file"
                      title="Attach image or PDF (max 5 MB)"
                      className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-[#DCD9E6] bg-white text-[#4A4656] transition hover:border-[#4E2A84] hover:text-[#4E2A84] disabled:opacity-40"
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
                      readOnly={sending}
                      onChange={(e) => setDraftBody(e.target.value)}
                      maxLength={2000}
                      placeholder="Write a message..."
                      className="h-11 min-w-0 flex-1 rounded-xl border border-[#DCD9E6] bg-[#FAF9FC] px-3 text-base sm:text-sm text-[#14121A] placeholder:text-[#6B6779] focus:border-[#4E2A84] focus:bg-white focus:outline-none"
                    />

                    <button
                      type="submit"
                      disabled={
                        sending || (!draft && !draftBody.trim() && selectedFiles.length === 0)
                      }
                      aria-label="Send message"
                      className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-[#4E2A84] px-3.5 text-xs font-bold text-white transition hover:bg-[#3F216B] disabled:cursor-not-allowed disabled:bg-[#C9C4D6]"
                    >
                      <Send className="h-3.5 w-3.5" aria-hidden="true" />
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

    </div>
  );
}
