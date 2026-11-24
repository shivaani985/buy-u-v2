# Buy-U Phases 7–9 — Final Hosted PostgreSQL Acceptance Report (Gates A, B & D)

- **Date:** 2026-11-24
- **Hosted Supabase Project:** `duwwlcpdidrxkixvflag`
- **Applied Consolidated Migration:** `docs/sql/phase-7-9-marketplace-completion.sql`
- **Approved Migration SHA-256:** `14FB991D3402A40A5544A128E31BEAF66E44E0D1E61CDFF895E5B83421D824CB`
- **Hosted SQL Defects Found:** `0` (no unapproved schema changes applied)
- **Local Application Bugs Found & Fixed Autonomously During Acceptance:** `4`
  1. `src/lib/analytics/data.ts`: Fixed `listing_views` pagination to order by composite `(viewed_at, viewer_id, listing_id)` (hosted `listing_views` has composite PK and no `id` column).
  2. `src/lib/analytics/metrics.ts`, `src/components/admin/AdminPlatformPortalClient.tsx`, `src/app/api/admin/analytics/export/route.ts`: Added distinct `verifiedCheckouts` metric so unified multi-seller checkouts are counted once separately from child orders.
  3. `src/app/seller/actions.ts` & `src/components/seller/SellerWithdrawalsClient.tsx`: Fixed storefront logo/banner storage path to UID-first `${auth.userId}/storefront-...` (matching hosted `listings` storage ownership RLS) and refreshed `/seller/withdrawals` client state on simulated failure.
  4. `src/components/orders/OrdersClient.tsx` & `src/app/marketplace-actions.ts`: Displayed buyer `returnStatus` (`Return: buyer reported returned`) alongside refund status, fixed feedback banner key `[key]` on `Mark Item Returned`, and mapped `REVIEW_MODERATED` cleanly.

---

## 1. Gate A — Hosted Migration Verification & Baseline Capture: **PASS**
- **Tables & Columns Verified via Live PostgREST OpenAPI & `service_role` Queries:** `profiles` (`last_active_at`, `notification_prefs`, `restriction_reason`), `storefronts` (`banner_path`, `business_info`, `is_open`), `listings` (`moderated_prev_status`, `moderated_by`, `moderated_at`, `moderation_reason`), `service_requests`, `free_notices`, `free_notice_drafts`, `free_notice_claims`, `donation_spots`, `reviews`, `reports`, `member_blocks`, `admin_audit_logs`, `listing_views`, `notifications`, `orders` (`protection_expires_at`).
- **RPC Signatures & Overloads:** All 24 Phase 7–9 RPCs + preserved Phase 6 RPCs (`is_order_payment_verified`, 6-parameter `admin_resolve_order_dispute_atomic`, `create_seller_withdrawal_atomic`, etc.) verified exposed unambiguously to `service_role` and **0 exposed to `anon`**. Internal helpers (`internal_is_blocked_between`, `safe_insert_member_notification`, `log_admin_audit_internal`) hidden from `anon`/`authenticated`.
- **Storage Hardening:** `free-items` bucket verified `public: true`, `file_size_limit: 5242880`, `allowed_mime_types: ["image/jpeg", "image/png", "image/webp"]`; existing UID-folder storage ownership policies preserved and verified in Gate B (`B2.2`).
- **Anonymous Access Restrictions:** Verified `permission denied` on all 10 private/financial tables (`free_notice_drafts`, `free_notice_claims`, `reports`, `member_blocks`, `admin_audit_logs`, `service_requests`, `notifications`, `seller_payout_accounts`, `payout_requests`, `order_refunds`).

---

## 2. Gate B — Live Hosted PostgreSQL Acceptance (`ALLOW_PHASE7_9_HOSTED_QA=1`): **19/19 PASS**
Executed `scripts/phase7-9-hosted-acceptance.mjs` (`runTag: 8C6E66`) using strictly isolated temporary QA accounts and synthetic fixtures, including real CLI execution of `scripts/phase7-9-expiry-worker.mjs`.

| Test ID | Scope | Result | Verified Highlights |
| --- | --- | --- | --- |
| **B1.1** | Services: Student publish / Staff reject | **PASS** | Active student published `service`; staff insert rejected by RLS |
| **B1.2** | Services: Mode, MYT date, malformed date, self/dup/concurrent | **PASS** | Malformed timestamp & `remote` on `in_person` listing rejected; concurrent `Promise.all` allowed exactly 1; 48h `respond_by` verified; seller decline worked |
| **B1.3** | Services: Suspended buyer, inactive provider, paused listing | **PASS** | `BUYER_ACCOUNT_INACTIVE`, `SERVICE_UNAVAILABLE`, and suspended provider rejected; buyer cancel persisted |
| **B1.4** | Services: Lifecycle, unauthorized steps, notifications, off-platform | **PASS** | `requested → accepted → in_progress → delivered → completed`; invalid transitions blocked; notifications emitted; `0` paid orders created |
| **B1.5** | Services: 48h late accept commit, unblock new req, expiry worker | **PASS** | Late accept committed `expired`; new request succeeded; accepted request untouched by `phase7-9-expiry-worker.mjs`; overdue `requested` expired |
| **B2.1** | Free Items: Student-only publish & private draft RLS | **PASS** | Staff draft rejected; student draft persisted & recovered; cross-user draft read returned 0 rows |
| **B2.2** | Free Items: Bucket MIME/5MB, ownership, object existence, checks | **PASS** | `text/plain`, `>5 MB`, cross-user folder upload, missing object, 0/duplicate images, invalid condition/spot/category all rejected |
| **B2.3** | Free Items: Concurrent draft publish lock & donor management | **PASS** | Concurrent `Promise.all` on same `draft_id` allowed exactly 1; notice `active`; `manage_free_notice_atomic` edit worked |
| **B2.4** | Free Items: Self/dup claim, suspended/expired guards, atomic reserve | **PASS** | Concurrent 2-claim accept on 1 unit allowed exactly 1; edit `< reserved_quantity` & close with active reservation rejected; cancel released once; overdue handover committed `expired` + mandatory recipient & donor notifications despite `community=false` |
| **B2.5** | Free Items: Expiry worker, handed_over safety, collect & impact | **PASS** | Worker expired overdue `reserved`, left `handed_over` intact; `collect` deducted stock once, emitted mandatory notifications, incremented `computeCommunityImpact` only on `collected`, created `0` financial orders |
| **B3.1** | Storefront: Ownership, logo/banner storage & public privacy | **PASS** | Student updated `shop_name`/`business_info`/`is_open`/logo/banner; cross-user overwrite blocked; public bank table blocked |
| **B4.1** | Reviews: Verified Purchase & Service + spoofing/concurrent guards | **PASS** | Uncompleted, unverified-payment, refunded, disputed, self, unrelated-buyer, and wrong-listing reviews rejected; concurrent duplicates allowed exactly 1 |
| **B4.2** | Reviews: Buyer edit + 7d deadline, seller reply, moderation & privacy | **PASS** | Edit worked within 7d, blocked past 7d & when hidden (`REVIEW_MODERATED`); other seller reply blocked; direct write blocked; hidden excluded & empty rating=`null`; `moderation_reason`/`moderated_by` denied to non-admin SELECT |
| **B5/B6/B7** | Live DB Analytics & Student Entrepreneurship Reconciliation | **PASS** | Live paginated dataset (including fixed `listing_views`) matched exact hand-calculated sen figures: Seller gross `4500`, refunds `1500`, net `3000`, comm `60`, earnings `2940`, exact proportional split `333+167=500`, 50% attributable conversion, Seller2 isolated; Admin unified checkouts delta `+4` across 5 child orders, gross `+5700`, net `+4200`, strict `kind='business'` cohort, `firstTimeSuccessfulBusinessSellers` unaffected by 60d pre-loved sale, sanitized CSV |
| **B8.1** | Reports: Visibility, neutral private-target errors, dup & privacy | **PASS** | Unrelated private draft & unrelated private message both returned neutral `REPORT_TARGET_NOT_FOUND`; all 5 authorized target kinds accepted; duplicate open report rejected; `admin_notes` hidden from reporter; reported member saw 0 reporter rows |
| **B8.2** | Moderation: Listing DELETE guard, idempotent restore, closed lock, audit | **PASS** | Admin-hidden listing blocked seller republish AND `DELETE`; repeated listing/free-notice restores stayed idempotent; user warn/suspend/restore worked; closed account blocked `restrict`/`suspend`/`restore` (`CANNOT_MODIFY_CLOSED_ACCOUNT`); catalog toggle audited (`>= 8` `bigint` rows) |
| **B9.1** | Blocking: Bidirectional triggers, bypass guards, paid-order exception | **PASS** | Self-block & third-party `FORBIDDEN_BLOCK_LOOKUP` rejected; conversations/messages/offers/pending-offer-accept/services/free-claims blocked both ways; unrelated & unverified orders rejected; legitimate verified paid-order message succeeded; immutable links guarded; unblock restored messaging |
| **B10.1** | Notifications, Preferences, Profile Protection & `last_active_at` | **PASS** | Forgery rejected; cross-user read blocked; `mark_conversation_notifications_read_atomic` & `mark_notifications_read_atomic` worked; direct `last_active_at`/`university_role` tamper rejected; trusted RPCs updated `last_active_at` |
| **B11.1** | Security Boundaries & Phase 6 Regression | **PASS** | Service-only expiry & admin RPCs denied to members; `orders.protection_expires_at` readable while `orders.pickup_pin` denied; Phase 5B `accept_offer_atomic` intact; preserved Phase 6 refunds reconciled cleanly |

---

## 3. Gate D — Exact Baseline Cleanup, Regression & Financial Reconciliation: **PASS**
- **Post-Cleanup Row Counts (100% Match to Pre-Test Gate A Baseline):**
  - `profiles: 4` (all 4 established QA accounts `active`, `restriction_reason: null`), `storefronts: 1`, `listings: 4`, `service_requests: 0`, `free_notices: 0`, `free_notice_drafts: 0`, `free_notice_claims: 0`, `reviews: 0`, `reports: 0`, `member_blocks: 0`, `admin_audit_logs: 0`, `orders: 8`, `order_refunds: 2`, `payout_requests: 0`.
  - Zero temporary QA accounts, zero stray storage objects, zero residual suspensions or block relationships.
- **Preserved Phase 6 Financial Records (Untouched & Reconciled):**
  - **Orders:** `BU-2611-0DB3` (completed, RM 15.00), `BU-2611-B1C075` (completed, RM 15.00), `BU-2611-C3CC55` (paid, RM 20.00), `BU-2611-3CB12A` (refunded, RM 15.00).
  - **Disputes:** `DSP-2611-AE63F2` (resolved / release), `DSP-2611-218ADE` (resolved / RM 5.00 partial), `DSP-2611-21DDF7` (resolved / RM 15.00 full).
  - **Refunds:** `RFD-2611-872723` (succeeded, RM 5.00) + `RFD-2611-19B70A` (succeeded, RM 15.00).
  - **Designated Refund Sums:** Simulated refunds **RM 20.00** (`2000` sen), Commission reversal **RM 0.40** (`40` sen), Seller earnings deduction **RM 19.60** (`1960` sen).
- **Local Verification Suite:** `node --test scripts/*.test.mjs` **94/94 PASS**, `tsc --noEmit` **PASS**, `eslint` **PASS**, worker/QA script syntax checks **PASS**, `next build` **PASS (40 compiled routes)**.
