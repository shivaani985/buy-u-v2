# Buy-U Phase 6D — Consolidated Local Acceptance Report & Browser Acceptance Plan

- **Date:** 2026-11-24
- **Scope:** Integrated local implementation of 3-Day (72-Hour) Buyer Protection + Phase 6D.2 (Refunds & Returns) + Phase 6D.3 (Seller Bank Accounts) + Phase 6D.4 (Automated Withdrawals) + Phase 6D.5 (Admin Financial Management & Reconciliation)
- **Consolidated SQL Proposal:** `docs/sql/phase-6d-financial-ecosystem.sql` (**NOT APPLIED** — awaiting owner review)
- **Hosted DB Writes / ToyyibPay / Real Refunds / Real Payouts / Push:** `0`

---

## 1. Local Verification Summary
- **Unit & Integration Tests (`node --test scripts/*.test.mjs`):** **79/79 PASS** (0 fail, 0 skipped).
  - *Executed Unit Tests:* 72-hour protection boundary (24h/48h/71h/71:59:59 vs 72:00:00), refund accounting (`BU-2611-C3CC55` RM 5 partial & `BU-2611-3CB12A` RM 15 full), Malaysian bank validation + AES-256-GCM encryption, simulated refund/payout providers (success/fail/reconciliation + production fail-closed), 6-bucket seller ledger, platform reconciliation PASS/FLAG detection, sanitized CSV export.
  - *Static SQL Assertions:* Verified consolidated `docs/sql/phase-6d-financial-ecosystem.sql` structure, zero `interval '7 days'` remnants, shared seller lock `profiles FOR UPDATE`, column-level revokes, and non-Realtime tables.
  - *Hosted DB Tests:* **NOT RUN** (prepared in `scripts/phase6d-hosted-acceptance.mjs`, awaiting owner SQL approval).
  - *Browser E2E Acceptance:* **NOT RUN** (prepared plan below, awaiting owner SQL approval).
- **TypeScript (`tsc --noEmit`):** Verified cleanly.
- **ESLint (`npm.cmd run lint`):** Verified cleanly.
- **Production Build (`next build`):** Verified all new routes (`/seller/bank`, `/seller/withdrawals`, `/api/admin/financials/export`, `/admin`, `/orders`).

---

## 2. Prepared Automated Browser Acceptance Plan (Scenarios A–I — Run After Owner SQL Approval)
- **Target:** `http://localhost:3000` connected to `duwwlcpdidrxkixvflag` using existing QA accounts (`examiner.staff@ums.edu.my`, `examiner.seller@iluv.ums.edu.my`, `examiner.buyer@iluv.ums.edu.my`, `buyu.platform@gmail.com`) via separate authenticated browser sessions (zero printed credentials/PINs/tokens/bank numbers).
- **Scenario A (Preserved Partial Refund `DSP-2611-218ADE` / `BU-2611-C3CC55`):** Admin executes RM 5.00 simulated partial refund → verify buyer sees `RFD-...` + `SIM-RFD-...`, adjusted commission RM 0.30, adjusted seller net RM 14.70, order restored to `paid` (Pending Settlement), normal handover & receipt confirmation still required.
- **Scenario B (Preserved Full Refund `DSP-2611-21DDF7` / `BU-2611-3CB12A`):** Admin executes RM 15.00 simulated full refund + explicit restock decision → verify order `refunded`, zero remaining earnings, frozen cleared, commission reversal RM 0.30, PIN cleared, no duplicate restock.
- **Scenario C (Return-Required Refund on isolated fixture):** Admin enables Return Required → refund blocked → buyer clicks **Mark Item Returned** → seller/admin confirms resellable return → refund executes + stock restored.
- **Scenario D (Seller Bank Account `/seller/bank`):** Register synthetic Malaysian bank account with confirmation → masked `****1234` + `Account Details Validated` → replace account → verify staff/cross-user denied.
- **Scenario E (3-Day Protection Reserve):** Synthetic newly completed order appears in `Buyer Protection Reserve (72h)` (withdrawal blocked); aged (> 72h) synthetic completed order appears in `Available for Withdrawal`; active dispute stays frozen past 72h.
- **Scenario F & G (Automatic Withdrawals — Success & Failure):** Seller withdraws eligible balance on `/seller/withdrawals` → automatic `SIM-TRF-...` without admin approval; QA failure releases reserved balance exactly once with retry eligibility.
- **Scenario H (Admin Financial Reconciliation `/admin`):** Verify Overview KPIs, PASS/FLAG reconciliation checks, payment/refund/withdrawal monitoring (no arbitrary Mark Paid), and sanitized CSV download.
- **Scenario I (Security & Responsive UI):** Desktop `1440×900` & Mobile `390×844` zero horizontal overflow, zero console errors, zero broken images, zero sensitive data in member DOM.
