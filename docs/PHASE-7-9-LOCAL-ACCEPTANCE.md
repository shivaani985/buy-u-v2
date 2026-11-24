# Buy-U Phases 7–9 — Local Acceptance Report & Prepared Browser Acceptance Plan

- **Date:** 2026-11-24
- **Consolidated SQL Proposal:** `docs/sql/phase-7-9-marketplace-completion.sql` (**NOT APPLIED** — awaiting owner approval)
- **Hosted DB Mutations / External Payments / ToyyibPay Calls / Push:** `0`

---

## 1. Local Verification Breakdown
- **Unit & Integration Tests (`node --test scripts/*.test.mjs`):** Preserves all 85 Phase 1–6 baseline tests + adds executable Phase 7–9 tests (`scripts/phase7-9-marketplace.test.mjs`) covering currency formatting (`formatCurrencySen(0) === "RM 0.00"`), services lifecycle, free-item quantity/community impact, zero-review rating safety, fixture-verified seller/admin/entrepreneurship analytics, CSV formula-injection neutralization, and consolidated SQL invariants.
- **TypeScript (`tsc --noEmit`), ESLint (`npm run lint`), Production Build (`next build`):** Verified cleanly (see final turn summary for exact route count and results).
- **Hosted PostgreSQL Acceptance:** **NOT RUN** (prepared in `scripts/phase7-9-hosted-acceptance.mjs`, guarded by `ALLOW_PHASE7_9_HOSTED_QA=1`, awaiting owner SQL approval).
- **Hosted Automated Browser Acceptance:** **NOT RUN** (prepared Scenarios A–U below, awaiting owner SQL approval).

---

## 2. Prepared Automated Browser Acceptance Plan (Scenarios A–U — Run After Owner SQL Approval)
- **Target:** Latest localhost production build (`http://localhost:3000`) connected to hosted `duwwlcpdidrxkixvflag` using authorized QA accounts (`examiner.staff@ums.edu.my`, `examiner.seller@iluv.ums.edu.my`, `examiner.buyer@iluv.ums.edu.my`, `buyu.platform@gmail.com`) in sequential isolated browser contexts.
- **A–C (Services):** Student publishes service listing → Staff submits service request on `/services` → Seller accepts & marks delivered on `/seller/services` → Buyer confirms completion on `/requests`.
- **D–F (Free Items & Donations):** Student saves persistent draft on `/free-items`, reloads to verify genuine draft recovery, publishes → Staff claims free item → Donor accepts (atomic reservation) & records handover → Recipient confirms collected → Community Impact increments by 1 donation.
- **G–H (Reviews):** Completed service/order buyer submits verified review → Seller replies publicly on `/seller/analytics` → Storefront `/store/[sellerId]` reflects verified rating.
- **I (Storefront):** Student customizes storefront settings and verifies public `/store/[sellerId]` display without private identifiers.
- **J–L (Seller & Admin Analytics + Entrepreneurship):** Verify `/seller/analytics`, `/admin` Platform Analytics, Student Entrepreneurship Insights, date range filters, SVG charts, and sanitized CSV exports (`/api/seller/analytics/export`, `/api/admin/analytics/export`).
- **M–N (Reporting & Moderation):** Member reports synthetic listing/user → Admin reviews in `/admin` Reports tab and resolves with audited moderation action.
- **O (User Blocking):** Member blocks another QA member → verify new service request/claim/message rejected while existing orders remain intact → unblock in `/account`.
- **P–R (Notifications, Account Restriction & Audit Logs):** Verify `/notifications` unread count, mark read/all read; Admin restricts & restores synthetic test account; verify centralized `/admin` Audit Logs entries.
- **S–T (Remaining Phase 6 Browser UI Acceptance):** Isolated synthetic fixture UI walkthrough for Return-Required Refund execution and Failed Simulated Withdrawal restoration on `/admin` and `/seller/withdrawals`.
- **U (Visual, Responsive & Security):** Desktop `1440×900` and Mobile `390×844` zero horizontal overflow, zero broken images, zero console errors, zero sensitive data exposure, strict role separation.
