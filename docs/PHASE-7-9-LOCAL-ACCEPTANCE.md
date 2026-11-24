# Buy-U Phases 7–9 — Local Acceptance Report & Prepared Browser Acceptance Plan

- **Date:** 2026-11-24
- **Consolidated SQL Proposal:** `docs/sql/phase-7-9-marketplace-completion.sql` (**NOT APPLIED** — awaiting owner approval)
- **Hosted DB Mutations / External Payments / ToyyibPay Calls / Push:** `0`

---

## 1. Local Verification Breakdown (P0.1–P0.18 Hardened)
- **Unit & Integration Tests (`node --test scripts/*.test.mjs`):** Preserves all 85 Phase 1–6 baseline tests + expanded Phase 7–9 test suite (`scripts/phase7-9-marketplace.test.mjs`) verifying:
  - Currency formatting (`formatCurrencySen(0) === "RM 0.00"` vs `formatSenToRm(0) === "FREE"`).
  - P0.2/P0.14 service request `remote`/`in_person`-only mode, MYT-to-UTC `timestamptz` parsing, malformed date rejection, `expired` status, committed expiry return, and `expire_stale_service_requests_atomic` worker integration.
  - P0.1/P0.6/P0.15 hosted `free_notices` statuses (`active`/`closed`/`hidden`), exact condition vocabulary (`New/Unused`, `Like New`, `Good`, `Fair`), 1–5 distinct student-owned storage objects verified in `storage.objects`, `free-items` bucket MIME/size policies, `FOR UPDATE` draft concurrency lock, donor `manage_free_notice_atomic` edit/close, committed handover expiry, and completed-only community impact.
  - P0.8/P0.18 rating aggregation excluding hidden reviews, never defaulting empty ratings to `5.0`, and column-level `reviews` SELECT hiding `moderation_reason` & `moderated_by` + `mark_conversation_notifications_read_atomic` preserving Phase 5 messaging badge clearing.
  - P0.9/P0.17 unclamped pre-purchase viewer-cohort conversion (`N/A` when unattributable + separate `ordersPerViewer`), exact largest-remainder integer-sen proportional refund allocation (`allocateProportionalSen`), strict `kind='business'` entrepreneurship classification, distinct `firstTimeSuccessfulBusinessSellers` vs `firstTimeSuccessfulSellers`, custom MYT date ranges, hosted `submitted` open reports, dated active user trends, deterministic pagination (`fetchAllPaginated`), and CSV formula sanitization.
  - P0.13/P0.16 `SECURITY INVOKER` profile & listing moderation guards, `update_notification_preferences_atomic` + JSONB CHECK constraint, immutable conversation/message/offer link guards, verified paid-order message block exception, `pending -> accepted` offer block guard, and closed-account restore rejection.
- **TypeScript (`tsc --noEmit`), ESLint (`npm run lint`), Production Build (`next build`):** Verified cleanly (see final turn summary).
- **Hosted PostgreSQL Acceptance:** **NOT RUN** (prepared in `scripts/phase7-9-hosted-acceptance.mjs`, guarded by `ALLOW_PHASE7_9_HOSTED_QA=1`, covering all P0.12 hosted checks, awaiting owner SQL approval).
- **Hosted Automated Browser Acceptance:** **NOT RUN** (prepared Scenarios A–U below, awaiting owner SQL approval).

---

## 2. Prepared Automated Browser Acceptance Plan (Scenarios A–U — Run After Owner SQL Approval)
- **Target:** Latest localhost production build (`http://localhost:3000`) connected to hosted `duwwlcpdidrxkixvflag` using authorized QA accounts (`examiner.staff@ums.edu.my`, `examiner.seller@iluv.ums.edu.my`, `examiner.buyer@iluv.ums.edu.my`, `buyu.platform@gmail.com`) in sequential isolated browser contexts.
- **A–C (Services):** Student publishes service listing → Staff submits service request on `/services` (selecting `remote`/`in_person` + MYT datetime-local) → Seller accepts & marks delivered on `/seller/services` → Buyer confirms completion on `/requests`.
- **D–F (Free Items & Donations):** Student saves incomplete draft on `/free-items` (`free_notice_drafts`), reloads to verify draft recovery, uploads 1–5 photos and publishes (`publish_free_notice_atomic` -> `active`) → Staff claims free item → Donor accepts (atomic reservation + 48h `reservation_expires_at`) & records handover → Recipient confirms collected → Community Impact increments by 1 donation.
- **G–H (Verified Purchase & Verified Service Reviews):**
  - Buyer submits & edits **Verified Purchase** review directly on `/orders` for a completed order (blocked on fully refunded/disputed orders).
  - Buyer submits **Verified Service** review on `/requests` for a completed service.
  - Seller replies publicly on `/seller/analytics`; `/store/[sellerId]` reflects verified rating, badges, and reply.
- **I (Storefront Customization & Public Display):** Student uploads logo & banner, updates `business_info` & `is_open` on `/seller/storefront`, and verifies `/store/[sellerId]` renders them without private identifiers.
- **J–L (Seller & Admin Analytics + Entrepreneurship + View Tracking):** Opening `/listings/[slug]` records a deduplicated view via `ListingViewTracker`; verify `/seller/analytics`, `/admin` Platform Analytics, Student Entrepreneurship Insights (`firstTimeSuccessfulSellers`), custom MYT date range filters, SVG charts, and sanitized CSV exports.
- **M–N (Reporting & Moderation):** Member reports synthetic listing/free item/user → verify `admin_notes` hidden from reporter → Admin marks `under_review` / `resolved` in `/admin` Reports tab, hides & restores listing (`hidden` + seller unhide blocked) and free item with audited entries.
- **O (User Blocking):** Member blocks another QA member → verify new conversations, messages (outside active paid order), offers, service requests, and free claims are blocked at DB/RPC level while existing orders remain intact; third-party probing rejected → unblock in `/account`.
- **P–R (Notifications Bell, Account Restriction & Audit Logs):** Verify live unread count badge on header Bell & `/notifications`, mark read/all read; Admin suspends (`suspended`) & restores synthetic test account; toggle catalog spot via `admin_toggle_catalog_item_atomic` and verify `/admin` Audit Logs entries.
- **S–T (Remaining Phase 6 Browser UI Acceptance):** Isolated synthetic fixture UI walkthrough for Return-Required Refund execution and Failed Simulated Withdrawal restoration on `/admin` and `/seller/withdrawals`.
- **U (Visual, Responsive & Security):** Desktop `1440×900` and Mobile `390×844` zero horizontal overflow, zero broken images, zero console errors, zero sensitive data exposure, strict role separation.
