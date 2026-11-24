# Phase 5B — Unlimited Bargaining Acceptance

## Hosted Schema & RPC Audit (Read-Only)

- **`public.offers` columns (verified live):** `id`, `conversation_id`, `listing_id`, `buyer_id`, `seller_id`, `offer_price_sen`, `status`, `order_id`, `created_at`, `responded_at`.
  - Confirmed: no `expires_at`, `reservation_expires_at`, or `reservation_released_at` column yet.
- **Hosted RPCs (verified live):** `rls_auto_enable`, `is_active_student`, `is_active_member`, `is_active_admin`, `mask_matric`, `update_listing_atomic`.
  - Confirmed: no `accept_offer_atomic` or `release_expired_offer_reservations` RPC exists yet.
- **Migration Proposal Prepared (NOT applied):** `docs/sql/phase-5b-atomic-bargaining.sql`
  - Adds `expires_at` (`created_at + 24h`), `reservation_expires_at` (`+30m`), `reservation_released_at` (exactly-once guard), and partial index.
  - Adds `public.offers` to `supabase_realtime` publication.
  - Adds `accept_offer_atomic(p_offer_id uuid)` (locks `offers` + `listings` `FOR UPDATE`, enforces 24h expiry, member blocks, stock `>= 1`, atomically increments `reserved_quantity + 1` and sets `reservation_expires_at = now() + 30m`).
  - Adds `release_expired_offer_reservations()` (uses `FOR UPDATE SKIP LOCKED` to release unpaid expired 30m holds safely and exactly once).

## Scope Implemented (Safe UI, Validation, Realtime & Server Actions)

1. **Unlimited Bargaining Validation (`src/lib/messages/offers.ts`)**
   - Strictly removes ALL legacy 5-proposal limits (6th, 20th, Nth proposals pass).
   - Enforces Pre-Loved (`kind = 'pre_loved'`) + `allow_offers = true` + `status = 'published'` + `availableStock >= 1`.
   - Enforces active verified Student/Staff buyer role, no self-offers, member block check, `RM 2.00` minimum (`200` sen), `<= listingPriceSen`, and no duplicate simultaneous pending offer for the same listing.
   - Authoritative 24h pending expiry (`created_at + 24h`) and 30m accepted reservation expiry (`responded_at + 30m`) checked server-side even with stale browser timers.

2. **Server Actions (`src/app/messages/offer-actions.ts`)**
   - `createOfferAction`, `cancelOfferAction`, `declineOfferAction`, and `acceptOfferAction`.
   - `acceptOfferAction` calls `supabase.rpc("accept_offer_atomic", { p_offer_id })` and **never fakes atomic reservation** with separate non-atomic updates — returns a clear message if the migration has not yet been applied.
   - No ToyyibPay bills, no fake payment states, no functional "Pay Now" button (Phase 6 boundary preserved).

3. **In-Chat Integration (`src/components/messages/OfferCard.tsx`, `src/components/messages/MessagesClient.tsx`, `src/lib/messages/data.ts`)**
   - Compact collapsible `"Make an Offer"` panel above the composer (shown only for eligible in-stock Pre-Loved `allow_offers=true` listings to non-owner buyers).
   - Listing-linked `OfferCard` interleaved chronologically with messages via `mergeChatTimeline` (deduplicated by `id`).
   - Plain colored TEXT statuses only (`Pending Offer`, `Accepted · 30m Hold`, `Declined`, `Cancelled`, `Expired`) — zero colored pills, gradients, or emojis.
   - Subscribes to Realtime `postgres_changes` on `public.offers` (`conversation_id=eq.<id>`) alongside `messages` and `notifications`.

## Automated & Read-Only Verification Results

- **TypeScript (`npx tsc --noEmit`):** PASS (0 errors)
- **ESLint (`npm run lint`):** PASS (0 errors, 0 warnings)
- **Unit Tests (`node --test`):** PASS (48/48 across all 8 suites, including `scripts/offers.test.mjs` covering 6th & 20th proposals, RM 2.00 min, self-offer/block/role checks, 24h expiry boundary, simultaneous double-accept, stock=0 & stock=1 concurrency, exactly-once 30m hold release, and timeline deduplication)
- **Production Build (`npm run build`):** PASS
- **Smoke Check (`node scripts/smoke-check.mjs http://localhost:3000`):** PASS (15/15)
- **Read-Only Browser QA (`1440px`, `390px`, `320px`, 0 hosted writes):**
  - Seller (`examiner.seller`) & Buyer (`examiner.buyer`) on `/messages`: PASS (`Live` Realtime, 3-pane layout, historical messages preserved, `"Make an Offer"` correctly hidden for self-listing and ineligible `IOT Box`, `0px` overflow, `0` console errors).

## Pending Owner Approval

1. Review and approve applying `docs/sql/phase-5b-atomic-bargaining.sql` to hosted Supabase (`duwwlcpdidrxkixvflag`) so `accept_offer_atomic`, `release_expired_offer_reservations`, and Realtime `offers` publication are live.
2. Live two-account bargaining acceptance (submitting, cancelling, declining, accepting, 30m reservation hold, and Realtime offer sync on a Pre-Loved `allow_offers=true` listing) after migration approval.

---

## Phase 5B.2 — Final Migration Safety Review

### Verified Hosted Findings Incorporated
- `offers.status` already permits `'expired'` and `'cancelled'`.
- `trg_guard_offer_updates` exists; updated `guard_offer_updates()` in `docs/sql/phase-5b-atomic-bargaining.sql` to **block direct seller `UPDATE` to `status = 'accepted'`** (must call `accept_offer_atomic`), protect `expires_at` / `reservation_expires_at` / `reservation_released_at`, and enforce 24h expiry while preserving direct buyer cancel/withdraw and seller decline/reject.
- Removed redundant `idx_offers_unique_order_id` (`UNIQUE` on `offers.order_id` already exists on hosted DB).
- `pg_cron` is available but NOT installed; moved `CREATE EXTENSION pg_cron` + `cron.schedule('*/2 * * * *', ...)` into an explicit owner-approval scheduler section (with external cron Option B documented). Page-visit opportunistic reconciliation is documented as best-effort fallback only, not the sole expiry mechanism.
- Added `isOfferHoldPayable` (`src/lib/messages/offers.ts`) so 30-minute hold expiry and order status are enforced server-side regardless of sweep timing.
- Documented Phase 6 late ToyyibPay payment reconciliation contract: if a payment webhook confirms after an order expired and stock was released, Phase 6 must NOT oversell or re-deduct stock — it logs the payment for refund/admin reconciliation and notifies buyer & admin.
