"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  AlertCircle,
  ArrowLeft,
  Ban,
  Check,
  ExternalLink,
  FileText,
  Info,
  Loader2,
  MapPin,
  MessageCircle,
  Paperclip,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Store,
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
  createOfferAction,
  declineOfferAction,
} from "@/app/messages/offer-actions";
import { startOfferToyyibPayCheckoutAction } from "@/app/checkout/actions";
import { OfferCard } from "@/components/messages/OfferCard";
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
  resolveEffectiveOfferStatus,
  type OfferCardItem,
  type OfferStatus,
} from "@/lib/messages/offers";
import {
  buildChatAttachmentPath,
  CHAT_ATTACHMENTS_BUCKET,
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
  initialOffers: OfferCardItem[];
  initialHasOlder: boolean;
  activeListing: LinkedListingContext | null;
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
  listingId: string | null;
  status: "sending" | "failed";
  error?: string;
  createdAt: string;
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

function createOptimisticClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `opt-${crypto.randomUUID()}`;
  }
  return `opt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function MessagesClient({
  currentUserId,
  initialConversations,
  initialActiveConversationId,
  initialMessages,
  initialOffers,
  initialHasOlder,
  activeListing,
  hasExplicitConversationParam,
  initialOpenOffer = false,
  initialVariantId = null,
}: MessagesClientProps) {
  const [conversations, setConversations] =
    useState<ConversationListItem[]>(initialConversations);
  const [messages, setMessages] = useState<ChatMessageItem[]>(initialMessages);
  const [offers, setOffers] = useState<OfferCardItem[]>(initialOffers);
  const [nowMs, setNowMs] = useState<number>(() => getCurrentTimestampMs());
  const [offerPanelOpen, setOfferPanelOpen] = useState(
    Boolean(initialOpenOffer)
  );
  const defaultOfferVariant =
    activeListing?.hasVariants && activeListing.variants.length > 0
      ? activeListing.variants.find(
          (v) => v.id === initialVariantId && v.active
        ) ??
        activeListing.variants.find((v) => v.active && v.availableStock > 0) ??
        activeListing.variants[0]
      : null;
  const [selectedOfferVariantId, setSelectedOfferVariantId] = useState<
    string | null
  >(defaultOfferVariant?.id ?? null);
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
  const [showMobileDetails, setShowMobileDetails] = useState(false);
  const [mobileShowChat, setMobileShowChat] = useState<boolean>(
    hasExplicitConversationParam && Boolean(initialActiveConversationId)
  );
  const [isLoadingOlder, startLoadOlderTransition] = useTransition();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const activeConversation =
    conversations.find((c) => c.id === initialActiveConversationId) ?? null;

  // Refresh countdown timers every 30 seconds while offers exist
  useEffect(() => {
    if (offers.length === 0) return;
    const timer = window.setInterval(() => {
      setNowMs(getCurrentTimestampMs());
    }, 30000);
    return () => window.clearInterval(timer);
  }, [offers.length]);

  // Auto-scroll smoothly when messages, offers, or optimistic bubbles change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [
    messages.length,
    offers.length,
    optimisticMessages.length,
    initialActiveConversationId,
  ]);

  // Mark active conversation unread notifications as read on open and sync navbar
  useEffect(() => {
    if (!initialActiveConversationId) return;
    let cancelled = false;
    void markConversationReadAction(initialActiveConversationId).then((res) => {
      if (cancelled || !res.ok) return;
      setConversations((prev) =>
        prev.map((c) =>
          c.id === initialActiveConversationId ? { ...c, unreadCount: 0 } : c
        )
      );
      if (typeof res.remainingUnread === "number") {
        emitUnreadUpdate({ count: res.remainingUnread });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [initialActiveConversationId]);

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
        msgChannel = supabase
          .channel(`chat-messages-${initialActiveConversationId}`)
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

              setMessages((prev) => mergeOrderedMessages(prev, [incoming]));
              setConversations((prev) => {
                const updated = prev.map((c) =>
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
                );
                return updated.sort(
                  (a, b) =>
                    new Date(b.lastMessageAt).getTime() -
                    new Date(a.lastMessageAt).getTime()
                );
              });

              if (incoming.senderId !== currentUserId) {
                void markConversationReadAction(incoming.conversationId).then(
                  (res) => {
                    if (res.ok && typeof res.remainingUnread === "number") {
                      emitUnreadUpdate({ count: res.remainingUnread });
                    }
                  }
                );
              }
            }
          )
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

            if (
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

              const status = (
                [
                  "pending",
                  "accepted",
                  "declined",
                  "cancelled",
                  "expired",
                ].includes(raw.status ?? "")
                  ? raw.status
                  : "pending"
              ) as OfferStatus;

              const mapped: OfferCardItem = {
                id: raw.id,
                conversationId: raw.conversation_id,
                listingId: raw.listing_id ?? "",
                variantId: (raw as { variant_id?: string | null }).variant_id ?? null,
                variantLabel: (() => {
                  const vId = (raw as { variant_id?: string | null }).variant_id;
                  const match = vId
                    ? activeListing?.variants.find((v) => v.id === vId)
                    : null;
                  if (match) return match.label;
                  const snap = (raw as { variant_snapshot?: Record<string, string> | null }).variant_snapshot;
                  return snap && typeof snap === "object"
                    ? Object.values(snap).filter(Boolean).join(" · ") || null
                    : null;
                })(),
                variantImageUrl: (() => {
                  const vId = (raw as { variant_id?: string | null }).variant_id;
                  const match = vId
                    ? activeListing?.variants.find((v) => v.id === vId)
                    : null;
                  return match?.imageUrl ?? activeListing?.imageUrl ?? null;
                })(),
                buyerId: raw.buyer_id ?? "",
                sellerId: raw.seller_id ?? "",
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
  }, [initialActiveConversationId, currentUserId]);

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
        conversationId: opt.conversationId,
        body: opt.body,
        attachmentPaths: uploadedPaths,
        listingId: opt.listingId,
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
      revokePreviews(opt);
      setOptimisticMessages((prev) =>
        prev.filter((m) => m.clientId !== opt.clientId)
      );
      setMessages((prev) => mergeOrderedMessages(prev, [persisted]));
      setConversations((prev) => {
        const updated = prev.map((c) =>
          c.id === persisted.conversationId
            ? {
                ...c,
                lastMessageAt: persisted.createdAt,
                lastMessagePreview:
                  persisted.body ||
                  (persisted.imagePaths.length > 0
                    ? "Sent an attachment"
                    : "New message"),
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

  function handleSend(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!activeConversation || activeConversation.isBlocked) return;
    setComposerError(null);

    const trimmed = draftBody.trim();
    if (trimmed.length === 0 && selectedFiles.length === 0) {
      setComposerError("Write a message or attach a file before sending.");
      return;
    }

    const filesToSend = [...selectedFiles];
    const attachments: OptimisticAttachment[] = filesToSend.map((f) => ({
      name: f.name,
      isImage: f.type.startsWith("image/"),
      previewUrl: f.type.startsWith("image/") ? URL.createObjectURL(f) : null,
    }));

    const optimistic: OptimisticMessage = {
      clientId: createOptimisticClientId(),
      conversationId: activeConversation.id,
      body: trimmed,
      files: filesToSend,
      uploadedPaths: [],
      attachments,
      listingId: activeListing?.id ?? null,
      status: "sending",
      createdAt: new Date().toISOString(),
    };

    // Immediate smooth UI update
    setOptimisticMessages((prev) => [...prev, optimistic]);
    setDraftBody("");
    setSelectedFiles([]);

    void deliverOptimisticMessage(optimistic);
  }

  function handleRetryOptimistic(clientId: string) {
    const target = optimisticMessages.find((m) => m.clientId === clientId);
    if (!target) return;
    const retrying: OptimisticMessage = {
      ...target,
      status: "sending",
      error: undefined,
    };
    setOptimisticMessages((prev) =>
      prev.map((m) => (m.clientId === clientId ? retrying : m))
    );
    void deliverOptimisticMessage(retrying);
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
              {(activeOfferVariant?.imageUrl || activeListing.imageUrl) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={activeOfferVariant?.imageUrl || activeListing.imageUrl || ""}
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

      {/* CENTER PANE: Active Chat + Optimistic Bubbles + Compact Composer */}
      <section
        aria-label="Active conversation"
        className={`flex min-h-[520px] flex-col lg:col-span-6 lg:min-h-0 lg:border-r lg:border-[#ECEAF3] ${
          mobileShowChat ? "flex" : "hidden lg:flex"
        }`}
      >
        {activeConversation ? (
          <>
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

            {showMobileDetails ? (
              <div className="border-b border-[#ECEAF3] bg-[#FAF9FC] p-3.5 lg:hidden">
                {listingDetailsPanel}
              </div>
            ) : null}

            {/* Scrollable Messages + Optimistic Pending/Failed Bubbles */}
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
                  {optimisticMessages.map((opt) => (
                    <div key={opt.clientId} className="flex flex-col items-end">
                      <div
                        className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed sm:max-w-[78%] ${
                          opt.status === "failed"
                            ? "border border-[#B42318]/40 bg-[#4E2A84]/85 text-white"
                            : "bg-[#4E2A84]/80 text-white"
                        }`}
                      >
                        {opt.body ? (
                          <p className="whitespace-pre-wrap break-words">
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
                            type="button"
                            onClick={() => handleRetryOptimistic(opt.clientId)}
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
              <div className="border-t border-[#ECEAF3] bg-[#FAF9FC] px-3.5 py-2.5">
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
                        You already have a pending offer on this listing. Cancel
                        it or wait for a response before sending another.
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
                      disabled={selectedFiles.length >= MAX_MESSAGE_ATTACHMENTS}
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
                      className="h-9 min-w-0 flex-1 rounded-xl border border-[#DCD9E6] bg-[#FAF9FC] px-3 text-sm text-[#14121A] placeholder:text-[#6B6779] focus:border-[#4E2A84] focus:bg-white focus:outline-none"
                    />

                    <button
                      type="submit"
                      disabled={
                        draftBody.trim().length === 0 &&
                        selectedFiles.length === 0
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
