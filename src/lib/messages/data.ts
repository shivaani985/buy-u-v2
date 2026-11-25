import { resolvePublicStorageUrl } from "@/lib/format";
import { formatVariationOptionLabel } from "@/lib/seller/variations";
import { getPublicSupabaseEnv } from "@/lib/supabase/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { reconcileExpiredOfferReservations } from "@/lib/supabase/service";
import type { AuthSessionSummary } from "@/types/marketplace";
import {
  computeOfferExpiresAt,
  computeReservationExpiresAt,
  type OfferCardItem,
  type OfferStatus,
} from "./offers";
import {
  countUnreadByConversation,
  evaluateMessagingEligibility,
  isValidUuid,
  MESSAGE_PAGE_SIZE,
  type MessagingEligibilityResult,
  type UnreadNotificationRow,
} from "./validation";

export interface MessagePeerInfo {
  id: string;
  displayName: string;
  shopName: string | null;
  logoUrl: string | null;
  faculty: string | null;
  badge: string;
}

export interface LinkedListingVariant {
  id: string;
  label: string;
  priceSen: number;
  availableStock: number;
  active: boolean;
  imageUrl?: string | null;
}

export interface LinkedListingContext {
  id: string;
  title: string;
  kind: string;
  isFood: boolean;
  availabilityMode: string | null;
  hasVariants: boolean;
  variants: LinkedListingVariant[];
  status: string;
  priceSen: number;
  availableStock: number | null;
  imageUrl: string | null;
  campusArea: string | null;
  sellerId: string;
  allowOffers: boolean;
}

export interface ConversationListItem {
  id: string;
  peer: MessagePeerInfo;
  lastMessageAt: string;
  lastMessagePreview: string;
  lastMessageSenderId: string | null;
  unreadCount: number;
  linkedListingId: string | null;
  linkedListingTitle: string | null;
  isBlocked: boolean;
}

export interface ChatMessageItem {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  imagePaths: string[];
  listingId: string | null;
  orderId: string | null;
  freeNoticeId: string | null;
  serviceRequestId: string | null;
  editedAt: string | null;
  createdAt: string;
}

export interface MessagesPageData {
  eligibility: MessagingEligibilityResult;
  conversations: ConversationListItem[];
  activeConversationId: string | null;
  activeMessages: ChatMessageItem[];
  activeOffers: OfferCardItem[];
  hasOlderMessages: boolean;
  activeListing: LinkedListingContext | null;
  totalUnread: number;
  error?: string;
}

interface RawConversationRow {
  id: string;
  member_a: string;
  member_b: string;
  last_message_at: string;
  created_at: string;
}

interface RawMessageRow {
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
}

export interface RawOfferRow {
  id: string;
  conversation_id: string;
  listing_id: string;
  variant_id?: string | null;
  variant_snapshot?: Record<string, string> | null;
  variant_image_path?: string | null;
  buyer_id: string;
  seller_id: string;
  offer_price_sen: number;
  status: string;
  order_id: string | null;
  created_at: string;
  responded_at: string | null;
  expires_at?: string | null;
  reservation_expires_at?: string | null;
  reservation_released_at?: string | null;
}

export function mapRawOffer(
  row: RawOfferRow,
  variantLabel?: string | null,
  variantImageUrl?: string | null
): OfferCardItem {
  const status = (
    ["pending", "accepted", "declined", "cancelled", "expired"].includes(
      row.status
    )
      ? row.status
      : "pending"
  ) as OfferStatus;

  const fallbackSnapshotLabel =
    !variantLabel &&
    row.variant_snapshot &&
    typeof row.variant_snapshot === "object"
      ? Object.keys(row.variant_snapshot).length > 0
        ? formatVariationOptionLabel(row.variant_snapshot)
        : null
      : null;

  return {
    id: row.id,
    conversationId: row.conversation_id,
    listingId: row.listing_id,
    variantId: row.variant_id ?? null,
    variantLabel: variantLabel ?? fallbackSnapshotLabel,
    variantImageUrl: variantImageUrl ?? null,
    buyerId: row.buyer_id,
    sellerId: row.seller_id,
    offerPriceSen: Number(row.offer_price_sen ?? 0),
    status,
    orderId: row.order_id ?? null,
    createdAt: row.created_at,
    respondedAt: row.responded_at ?? null,
    expiresAt: computeOfferExpiresAt(row.created_at, row.expires_at),
    reservationExpiresAt:
      status === "accepted"
        ? computeReservationExpiresAt(
            row.responded_at,
            row.reservation_expires_at
          )
        : row.reservation_expires_at ?? null,
    reservationReleasedAt: row.reservation_released_at ?? null,
  };
}

export function mapRawMessage(row: RawMessageRow): ChatMessageItem {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    body: row.body ?? "",
    imagePaths: Array.isArray(row.image_paths) ? row.image_paths : [],
    listingId: row.listing_id,
    orderId: row.order_id,
    freeNoticeId: row.free_notice_id,
    serviceRequestId: row.service_request_id,
    editedAt: row.edited_at,
    createdAt: row.created_at,
  };
}

export async function getMessagesPageData(
  session: AuthSessionSummary,
  options: { requestedConversationId?: string | null; requestedListingId?: string | null } = {}
): Promise<MessagesPageData> {
  const eligibility = evaluateMessagingEligibility(session);

  if (!eligibility.eligible || !eligibility.userId) {
    return {
      eligibility,
      conversations: [],
      activeConversationId: null,
      activeMessages: [],
      activeOffers: [],
      hasOlderMessages: false,
      activeListing: null,
      totalUnread: 0,
    };
  }

  const env = getPublicSupabaseEnv();
  const supabase = await createSupabaseServerClient();
  if (!env || !supabase) {
    return {
      eligibility,
      conversations: [],
      activeConversationId: null,
      activeMessages: [],
      activeOffers: [],
      hasOlderMessages: false,
      activeListing: null,
      totalUnread: 0,
      error: "Supabase client is not configured.",
    };
  }

  const userId = eligibility.userId;

  // Automatically release any expired 30m offer holds (throttled, fail-safe no-op pre-migration)
  await reconcileExpiredOfferReservations();

  const [convRes, notifRes, blocksRes] = await Promise.all([
    supabase
      .from("conversations")
      .select("id,member_a,member_b,last_message_at,created_at")
      .or(`member_a.eq.${userId},member_b.eq.${userId}`)
      .order("last_message_at", { ascending: false })
      .limit(50),
    supabase
      .from("notifications")
      .select("id,kind,href,read_at")
      .eq("user_id", userId)
      .is("read_at", null)
      .in("kind", ["new_message", "message"]),
    supabase
      .from("member_blocks")
      .select("blocker_id,blocked_id")
      .or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`),
  ]);

  if (convRes.error) {
    return {
      eligibility,
      conversations: [],
      activeConversationId: null,
      activeMessages: [],
      activeOffers: [],
      hasOlderMessages: false,
      activeListing: null,
      totalUnread: 0,
      error: "Could not load your conversations right now.",
    };
  }

  const convRows = (convRes.data ?? []) as RawConversationRow[];
  const { byConversation, totalUnread } = countUnreadByConversation(
    (notifRes.data ?? []) as UnreadNotificationRow[]
  );

  const blockedPeers = new Set<string>();
  for (const b of (blocksRes.data ?? []) as Array<{
    blocker_id: string;
    blocked_id: string;
  }>) {
    if (b.blocker_id === userId) blockedPeers.add(b.blocked_id);
    if (b.blocked_id === userId) blockedPeers.add(b.blocker_id);
  }

  if (convRows.length === 0) {
    return {
      eligibility,
      conversations: [],
      activeConversationId: null,
      activeMessages: [],
      activeOffers: [],
      hasOlderMessages: false,
      activeListing: null,
      totalUnread,
    };
  }

  const convIds = convRows.map((c) => c.id);
  const peerIds = Array.from(
    new Set(
      convRows.map((c) => (c.member_a === userId ? c.member_b : c.member_a))
    )
  );

  // Determine active conversation before querying messages
  const requestedId = options.requestedConversationId?.trim() ?? null;
  const activeConv =
    (requestedId && isValidUuid(requestedId)
      ? convRows.find((c) => c.id === requestedId)
      : null) ?? convRows[0];
  const activeConversationId = activeConv?.id ?? null;

  const [profilesRes, storefrontsRes, recentMsgsRes, activeMsgsRes, activeOffersRes] =
    await Promise.all([
      supabase
        .from("public_profiles")
        .select("id,display_name,faculty,university_role")
        .in("id", peerIds),
      supabase
        .from("storefronts")
        .select("seller_id,shop_name,logo_path")
        .in("seller_id", peerIds),
      supabase
        .from("messages")
        .select("id,conversation_id,sender_id,body,image_paths,listing_id,created_at")
        .in("conversation_id", convIds)
        .order("created_at", { ascending: false })
        .limit(200),
      activeConversationId
        ? supabase
            .from("messages")
            .select(
              "id,conversation_id,sender_id,body,image_paths,listing_id,order_id,free_notice_id,service_request_id,edited_at,created_at"
            )
            .eq("conversation_id", activeConversationId)
            .order("created_at", { ascending: false })
            .limit(MESSAGE_PAGE_SIZE + 1)
        : Promise.resolve({ data: [], error: null }),
      activeConversationId
        ? supabase
            .from("offers")
            .select("*")
            .eq("conversation_id", activeConversationId)
            .order("created_at", { ascending: true })
            .limit(100)
        : Promise.resolve({ data: [], error: null }),
    ]);

  const profilesMap = new Map<
    string,
    {
      display_name: string | null;
      faculty: string | null;
      university_role: string | null;
    }
  >();
  for (const p of (profilesRes.data ?? []) as Array<{
    id: string;
    display_name: string | null;
    faculty: string | null;
    university_role: string | null;
  }>) {
    profilesMap.set(p.id, p);
  }

  const storefrontsMap = new Map<
    string,
    { shop_name: string | null; logo_path: string | null }
  >();
  for (const s of (storefrontsRes.data ?? []) as Array<{
    seller_id: string;
    shop_name: string | null;
    logo_path: string | null;
  }>) {
    storefrontsMap.set(s.seller_id, s);
  }

  // Latest message and latest listing_id per conversation
  const latestMsgByConv = new Map<
    string,
    { body: string; hasFiles: boolean; senderId: string; createdAt: string }
  >();
  const latestListingByConv = new Map<string, string>();

  for (const m of (recentMsgsRes.data ?? []) as Array<{
    conversation_id: string;
    sender_id: string;
    body: string | null;
    image_paths: string[] | null;
    listing_id: string | null;
    created_at: string;
  }>) {
    if (!latestMsgByConv.has(m.conversation_id)) {
      latestMsgByConv.set(m.conversation_id, {
        body: (m.body ?? "").trim(),
        hasFiles: Array.isArray(m.image_paths) && m.image_paths.length > 0,
        senderId: m.sender_id,
        createdAt: m.created_at,
      });
    }
    if (m.listing_id && !latestListingByConv.has(m.conversation_id)) {
      latestListingByConv.set(m.conversation_id, m.listing_id);
    }
  }

  const rawActiveMessages = (activeMsgsRes.data ?? []) as RawMessageRow[];
  const hasOlderMessages = rawActiveMessages.length > MESSAGE_PAGE_SIZE;
  const trimmedActiveDesc = hasOlderMessages
    ? rawActiveMessages.slice(0, MESSAGE_PAGE_SIZE)
    : rawActiveMessages;
  const activeMessages = trimmedActiveDesc.reverse().map(mapRawMessage);
  const rawOfferRows = (activeOffersRes.data ?? []) as RawOfferRow[];
  const activeOffers = rawOfferRows.map((row) =>
    mapRawOffer(
      row,
      undefined,
      resolvePublicStorageUrl(
        "listings",
        row.variant_image_path ?? null,
        env.url
      )
    )
  );

  // Collect listing IDs to resolve titles + active listing right-pane details
  const listingIdsToFetch = new Set<string>(latestListingByConv.values());
  if (
    options.requestedListingId &&
    isValidUuid(options.requestedListingId)
  ) {
    listingIdsToFetch.add(options.requestedListingId);
  }

  const activeListingId =
    (options.requestedListingId && isValidUuid(options.requestedListingId)
      ? options.requestedListingId
      : null) ??
    (activeConversationId
      ? latestListingByConv.get(activeConversationId) ?? null
      : null);

  let listingsMap = new Map<
    string,
    {
      id: string;
      title: string;
      kind: string;
      is_food: boolean | null;
      availability_mode: string | null;
      has_variants: boolean | null;
      status: string;
      price_sen: number | null;
      quantity: number | null;
      reserved_quantity: number | null;
      image_paths: string[] | null;
      collection_area_id: string | null;
      seller_id: string;
      allow_offers: boolean | null;
    }
  >();

  let activeAreaName: string | null = null;
  let activeVariants: LinkedListingVariant[] = [];
  const variantLabelMap = new Map<string, string>();
  const variantImageMap = new Map<string, string | null>();

  if (listingIdsToFetch.size > 0) {
    const { data: lRows } = await supabase
      .from("listings")
      .select(
        "id,title,kind,is_food,availability_mode,has_variants,status,price_sen,quantity,reserved_quantity,image_paths,collection_area_id,seller_id,allow_offers"
      )
      .in("id", Array.from(listingIdsToFetch));

    listingsMap = new Map(
      (
        (lRows ?? []) as Array<{
          id: string;
          title: string;
          kind: string;
          is_food: boolean | null;
          availability_mode: string | null;
          has_variants: boolean | null;
          status: string;
          price_sen: number | null;
          quantity: number | null;
          reserved_quantity: number | null;
          image_paths: string[] | null;
          collection_area_id: string | null;
          seller_id: string;
          allow_offers: boolean | null;
        }>
      ).map((l) => [l.id, l])
    );

    const activeRow = activeListingId ? listingsMap.get(activeListingId) : null;
    if (activeRow?.has_variants) {
      let vRes = await supabase
        .from("listing_variants")
        .select("id,option_values,price_sen,quantity,reserved_quantity,active,image_path")
        .eq("listing_id", activeRow.id);
      if (
        vRes.error &&
        (vRes.error.code === "42703" ||
          /image_path/i.test(vRes.error.message ?? ""))
      ) {
        vRes = (await supabase
          .from("listing_variants")
          .select("id,option_values,price_sen,quantity,reserved_quantity,active")
          .eq("listing_id", activeRow.id)) as unknown as typeof vRes;
      }
      const vRows = vRes.data;
      activeVariants = (
        (vRows ?? []) as Array<{
          id: string;
          option_values: Record<string, string> | null;
          price_sen: number;
          quantity: number;
          reserved_quantity: number;
          active: boolean | null;
          image_path?: string | null;
        }>
      ).map((v) => {
        const label =
          v.option_values && typeof v.option_values === "object"
            ? formatVariationOptionLabel(v.option_values)
            : "Option";
        const imageUrl = resolvePublicStorageUrl(
          "listings",
          v.image_path ?? null,
          env.url
        );
        variantLabelMap.set(v.id, label);
        variantImageMap.set(v.id, imageUrl);
        return {
          id: v.id,
          label,
          priceSen: Number(v.price_sen ?? 0),
          availableStock: Math.max(
            0,
            Number(v.quantity ?? 0) - Math.max(0, Number(v.reserved_quantity ?? 0))
          ),
          active: v.active !== false,
          imageUrl,
        };
      });
    }
    if (activeRow?.collection_area_id) {
      const { data: areaRow } = await supabase
        .from("collection_areas")
        .select("name")
        .eq("id", activeRow.collection_area_id)
        .maybeSingle();
      activeAreaName = (areaRow as { name?: string } | null)?.name ?? null;
    }
  }

  const conversations: ConversationListItem[] = convRows.map((c) => {
    const peerId = c.member_a === userId ? c.member_b : c.member_a;
    const p = profilesMap.get(peerId);
    const s = storefrontsMap.get(peerId);
    const latest = latestMsgByConv.get(c.id);
    const linkedId = latestListingByConv.get(c.id) ?? null;
    const linkedTitle = linkedId ? listingsMap.get(linkedId)?.title ?? null : null;

    const preview = latest
      ? latest.body || (latest.hasFiles ? "Sent an attachment" : "New message")
      : "No messages yet";

    return {
      id: c.id,
      peer: {
        id: peerId,
        displayName:
          p?.display_name?.trim() || s?.shop_name?.trim() || "UMS Member",
        shopName: s?.shop_name?.trim() || null,
        logoUrl: resolvePublicStorageUrl(
          "listings",
          s?.logo_path ?? null,
          env.url
        ),
        faculty: p?.faculty?.trim() || null,
        badge:
          p?.university_role === "staff"
            ? "Verified UMS Staff"
            : "Verified UMS Student",
      },
      lastMessageAt: latest?.createdAt ?? c.last_message_at ?? c.created_at,
      lastMessagePreview: preview,
      lastMessageSenderId: latest?.senderId ?? null,
      unreadCount: byConversation[c.id.toLowerCase()] ?? 0,
      linkedListingId: linkedId,
      linkedListingTitle: linkedTitle,
      isBlocked: blockedPeers.has(peerId),
    };
  });

  const activeListingRow = activeListingId
    ? listingsMap.get(activeListingId) ?? null
    : null;
  const activeListing: LinkedListingContext | null = activeListingRow
    ? {
        id: activeListingRow.id,
        title: activeListingRow.title,
        kind: activeListingRow.kind,
        isFood: Boolean(activeListingRow.is_food),
        availabilityMode: activeListingRow.availability_mode ?? null,
        hasVariants: Boolean(activeListingRow.has_variants),
        variants: activeVariants,
        status: activeListingRow.status,
        priceSen: Number(activeListingRow.price_sen ?? 0),
        availableStock:
          activeListingRow.kind === "service"
            ? null
            : Math.max(
                0,
                Number(activeListingRow.quantity ?? 0) -
                  Math.max(0, Number(activeListingRow.reserved_quantity ?? 0))
              ),
        imageUrl: resolvePublicStorageUrl(
          "listings",
          activeListingRow.image_paths?.[0] ?? null,
          env.url
        ),
        campusArea: activeAreaName,
        sellerId: activeListingRow.seller_id,
        allowOffers: Boolean(activeListingRow.allow_offers),
      }
    : null;

  const enrichedOffers = activeOffers.map((offer) => {
    const nextLabel =
      offer.variantId && variantLabelMap.has(offer.variantId)
        ? variantLabelMap.get(offer.variantId) ?? offer.variantLabel ?? null
        : offer.variantLabel ?? null;
    const nextImageUrl =
      offer.variantImageUrl ??
      (offer.variantId && variantImageMap.has(offer.variantId)
        ? variantImageMap.get(offer.variantId) ?? null
        : activeListing && activeListing.id === offer.listingId
          ? activeListing.imageUrl
          : null);
    return {
      ...offer,
      variantLabel: nextLabel,
      variantImageUrl: nextImageUrl,
    };
  });

  return {
    eligibility,
    conversations,
    activeConversationId,
    activeMessages,
    activeOffers: enrichedOffers,
    hasOlderMessages,
    activeListing,
    totalUnread,
  };
}
