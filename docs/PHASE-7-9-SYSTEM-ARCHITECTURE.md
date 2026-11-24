# Buy-U Phases 7–9 — System Architecture, Migration Guide & Backlogs

## 1. Architectural Decisions
- **Services Marketplace (Phase 8A):** Uses existing `public.service_requests` with off-platform campus agreement lifecycle (`requested → accepted → in_progress → delivered → completed` / `declined` / `cancelled`). Excluded from paid sales and 2% commission; eligible for verified service reviews only after buyer confirms completion.
- **Free Items & Community Donations (Phase 8B):** Reuses existing `public.free_notices`, `public.donation_spots` (`Blok Alpha`, `Blok Beta`), and `messages.free_notice_id`, adding `public.free_notice_claims` for atomic quantity reservation (`FOR UPDATE` on `free_notices` before `free_notice_claims`), exact-once reservation release on decline/cancel, and completed-only (`collected`) community impact tracking. Active Students and Staff can claim; Students-only publish.
- **Public Storefront (Phase 8C):** `/store/[sellerId]` aggregates public storefront metadata, verified student badge, published products/services/free items, real non-hidden reviews, and Report/Block actions without exposing emails, student IDs, or bank details.
- **Analytics & Entrepreneurship (Phases 8E/8F/9A):** Single shared calculation module (`src/lib/analytics/metrics.ts`) powers `/seller/analytics`, `/admin` Platform Analytics, Student Entrepreneurship Insights, and sanitized CSV export routes (`/api/seller/analytics/export`, `/api/admin/analytics/export`) with zero-dependency SVG/CSS charts (`src/components/analytics/SimpleCharts.tsx`).
- **Trust, Safety, Blocking & Admin Portal (Phases 9B–9F):** Backend-enforced `is_blocked_between` prevents new interactions while preserving existing orders and disputes; centralized `admin_audit_logs` records every moderation and catalog action without deleting financial history.

## 2. Migration Installation & Recovery Notes
1. Apply `docs/sql/phase-7-9-marketplace-completion.sql` in Supabase SQL Editor on `duwwlcpdidrxkixvflag` (single atomic additive transaction; includes explicit `GRANT ALL ... TO service_role` on all touched/new tables).
2. Preserves ALL Phase 1–6 tables, orders (`BU-2611-0DB3`, `BU-2611-B1C075`, `BU-2611-C3CC55`, `BU-2611-3CB12A`), disputes, refunds (`RFD-2611-872723`, `RFD-2611-19B70A`), bank accounts, and audit history.
3. **Rollback:** Never delete historical `orders`, `order_refunds`, `reviews`, or `admin_audit_logs`. New RPCs can be dropped/replaced safely without touching existing Phase 6 tables.

## 3. Remaining Phase 10 (UI/UX Refinement) & Phase 11 (Deployment & Operations) Backlogs
- **Phase 10 Backlog:** App-wide visual hierarchy & micro-interaction polish, unified card/spacing density pass, mobile drawer navigation refinement, storefront banner image uploader UI polish, and inline review submission modal on `/orders` cards.
- **Phase 11 Backlog:** Vercel production deployment, scheduled cron activation for `scripts/phase6d-recovery-worker.mjs`, public HTTPS ToyyibPay Sandbox callback verification, same-bill payment retry E2E verification, and final operational readiness runbook.
