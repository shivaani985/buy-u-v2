# Phase 5A — Realtime Messaging (`/messages`) Acceptance

## Scope Implemented

1. **Three-Pane Messaging Interface (`/messages`)**
   - Added `src/app/messages/page.tsx`, `src/components/messages/MessagesClient.tsx`, `src/lib/messages/data.ts`, `src/lib/messages/validation.ts`, and `src/app/messages/actions.ts`.
   - Desktop (`1440px`): Left searchable conversation list (last message preview, relative timestamp, linked listing title, plain-text unread count), Center active chat (chronological history, pagination `"Load older messages"`, timestamps, message bubbles, compact composer, Realtime status `Live` / `Connecting...` / `Reconnecting...`), Right linked listing panel (photo, title, RM price, plain-text stock/status, campus area, seller/member card).
   - Mobile (`390px`, `320px`): Conversation list → active chat with back button and collapsible `"Details"` panel for linked listing context; `0px` horizontal overflow.

2. **Real Supabase Realtime & Persistence**
   - Subscribes via `getSupabaseBrowserClient()` to `postgres_changes` (`INSERT` on `public.messages` filtered by `conversation_id`).
   - Deduplicates incoming Realtime echoes and paginated batches using `mergeOrderedMessages` (`id`-deduped, `createdAt ASC, id ASC`).
   - Preserves existing historical messages and `messages.listing_id`, `order_id`, `free_notice_id`, `service_request_id` columns for Phase 5B extensibility (unlimited bargaining proposals, 24h offer expiry, 30m checkout reservation).

3. **Chat with Seller & Duplicate-Thread Prevention**
   - Added `"Chat with Seller"` button on eligible non-owner product/service detail pages (`src/components/listings/ProductDetailClient.tsx`).
   - Uses canonical `(member_a, member_b)` ordering (`member_a < member_b`) to reuse existing conversations and prevent duplicate threads or self-messaging.
   - Checks `public.member_blocks` in both directions before creating conversations or sending messages.

4. **Private Attachments (`chat-attachments` bucket)**
   - Uploads private images/PDFs (`JPG/PNG/WebP/GIF/PDF`, `<= 5 MB`, max `4` per message) under `${conversationId}/${userId}/...` in private bucket `chat-attachments`.
   - Serves attachments exclusively through participant-authorized signed URL endpoint `GET /api/messages/attachment` (`src/app/api/messages/attachment/route.ts`, `Cache-Control: private, no-store`, 300s signed URL). Never exposes private files publicly.

5. **Unread Counters & Header Sync**
   - Wired desktop, account dropdown, and mobile drawer Messages links in `src/components/layout/SiteHeader.tsx` to `/messages`.
   - Derives unread counts strictly from real unread `public.notifications` (`kind IN ('new_message', 'message')`, `read_at IS NULL`) — no nonexistent `messages.read_at` column invented.
   - Marks conversation notifications read via `markConversationReadAction` on open / incoming peer message and refreshes navbar badge.

## Automated & Read-Only Verification Results

- **TypeScript (`npx tsc --noEmit`):** PASS (0 errors)
- **ESLint (`npm run lint`):** PASS (0 errors, 0 warnings)
- **Unit Tests (`node --test`):** PASS (42/42 across `auth-regression`, `seller-foundation`, `listing-edit`, `buyer-shopping`, `cart`, `checkout`, and `messages`)
- **Production Build (`npm run build`):** PASS
- **Smoke Check (`node scripts/smoke-check.mjs http://localhost:3000`):** PASS (15/15)
- **Unauthorized Attachment Endpoint (`GET /api/messages/attachment` as guest):** PASS (`401 Unauthorized`)
- **Read-Only Browser QA (`http://localhost:3000`, 0 hosted writes):**
  - Guest `/messages`: PASS (`Sign in to view your messages`, `0px` overflow at `1440px`/`390px`/`320px`, `0` console errors).
  - Seller (`examiner.seller@iluv.ums.edu.my`) on `/messages`: PASS — 3-pane layout verified, Realtime transitioned `Connecting...` → `Live`, historical messages & `IOT Box` right pane rendered, search filter verified, mobile list ↔ chat ↔ Details verified, `0px` overflow at `1440px`/`390px`/`320px`, `0` console errors.
  - Staff (`examiner.staff@ums.edu.my`): PASS — `"Chat with Seller"` visible & enabled on `IOT Box`, `/messages` accessible with empty state, `0px` overflow, `0` console errors.

## Live Two-Account Write & Realtime E2E (Pending Owner Approval)

Zero hosted writes were performed during Phase 5A. Live two-account E2E verification (sending messages, uploading/opening private attachments, verifying live cross-browser Realtime delivery and unread badge increment/decrement) requires owner approval or manual testing.
