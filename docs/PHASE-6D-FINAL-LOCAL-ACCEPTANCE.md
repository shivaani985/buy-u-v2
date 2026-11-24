# Buy-U Phase 6D — Consolidated Local Acceptance Report & Browser Acceptance Plan

- **Date:** 2026-11-24
- **Scope:** Integrated local implementation + P0.1–P0.10 financial integrity hardening for 3-Day (72-Hour) Buyer Protection, Phase 6D.2 (Refunds & Returns), Phase 6D.3 (Seller Bank Accounts), Phase 6D.4 (Automated Withdrawals), Phase 6D.5 (Admin Financial Management & Reconciliation), and Durable Recovery Worker.
- **Consolidated SQL Proposal:** `docs/sql/phase-6d-financial-ecosystem.sql` (**NOT APPLIED** — awaiting owner review)
- **Hosted DB Writes / ToyyibPay / Real Refunds / Real Payouts / Push:** `0`

---

## 1. Local Verification Summary
- **Unit & Integration Tests (`node --test scripts/*.test.mjs`):** Executed across Phase 6B, 6C, 6D.1, and P0.1–P0.10 Phase 6D suites (see final turn summary for exact pass count).
  - *Executable Coverage Added (P0.10):*
    - Legacy 4-param `admin_resolve_order_dispute_atomic` removal & unambiguous 6-param caller alignment (P0.1).
    - Legacy plaintext bank account deactivation (`re_registration_required`), masked placeholder, `duitnow_id` wipe, `v1:` ciphertext eligibility, AES-256-GCM round-trip (P0.2).
    - Explicit `ON CONFLICT ON CONSTRAINT seller_payout_accounts_pkey` & shared seller lock serialization with withdrawals (P0.3).
    - Removal of unsafe admin release, durable `financial_execution_attempts`, deterministic provider refs, production fail-closed guard, and executable crash/restart recovery test proving idempotent success/failure finalization + uncertain hold (P0.4 / P0.5).
    - Authoritative payment proof rejecting spoofed `paid_at` completed-order fixtures in both seller balance and platform reconciliation (P0.6).
    - Historical 7-day preserved `protection_expires_at` vs new 72-hour exact boundary (`71:59:59` vs `72:00:00`) (P0.7).
    - Separated restock (`approved_pending_refund` → atomic execution on refund success), explicit item/quantity validation, food/damaged/missing guards, active-seller/admin return confirmation, exception justification, and participant-safe RPC returns (P0.8 / P0.9).
    - Full multi-order fixture accounting equations (`Collections = Gross + FPX`, `Net Sales`, `Net Commission`, `6-bucket seller balance`, blocking failed refunds stay frozen, zero negative balances, sanitized CSV) (P0.10).
  - *Hosted DB Tests:* **NOT RUN** (prepared in `scripts/phase6d-hosted-acceptance.mjs`, guarded by `ALLOW_PHASE6D_HOSTED_QA=1`, awaiting owner SQL approval).
  - *Browser E2E Acceptance:* **NOT RUN** (prepared plan below, awaiting owner SQL approval).
- **TypeScript (`tsc --noEmit`):** Verified cleanly.
- **ESLint (`npm.cmd run lint`):** Verified cleanly.
- **Production Build (`next build`):** Verified cleanly.
- **`BUYU_BANK_ENCRYPTION_KEY`:** Configured in `.env.local` (32-byte hex key via `crypto.randomBytes(32)`), verified excluded from Git (`.gitignore` + `.git/index`), never printed or committed.

---

## 2. Prepared Automated Browser Acceptance Plan (Scenarios A–I — Run After Owner SQL Approval)
- **Target:** `http://localhost:3000` connected to `duwwlcpdidrxkixvflag` using existing QA accounts (`examiner.staff@ums.edu.my`, `examiner.seller@iluv.ums.edu.my`, `examiner.buyer@iluv.ums.edu.my`, `buyu.platform@gmail.com`) via separate authenticated browser sessions (zero printed credentials/PINs/tokens/bank numbers).
- **Scenario A (Preserved Partial Refund `DSP-2611-218ADE` / `BU-2611-C3CC55`):** Admin executes RM 5.00 simulated partial refund → verify buyer sees `RFD-...` + `SIM-RFD-...`, adjusted commission RM 0.30, adjusted seller net RM 14.70, order restored to `paid`, normal handover & receipt confirmation still required.
- **Scenario B (Preserved Full Refund `DSP-2611-21DDF7` / `BU-2611-3CB12A`):** Admin approves restock plan (`approved_pending_refund`) → executes RM 15.00 simulated full refund → verify order `refunded`, zero remaining earnings, frozen cleared, commission reversal RM 0.30, PIN cleared, restock applied once atomically on success.
- **Scenario C (Return-Required Refund & Food/Damaged Guard on isolated fixture):** Admin enables Return Required → refund blocked → buyer clicks **Mark Item Returned** → seller/admin confirms resellable return → refund executes + stock restored; verify damaged/food restock blocked.
- **Scenario D (Legacy Bank Transition & Re-Registration `/seller/bank`):** Verify legacy migrated account shows `re_registration_required` (ineligible for withdrawal) → seller re-registers Malaysian bank account → masked `****1234` + `Account Details Validated` → verify staff/cross-user denied.
- **Scenario E (Historical 7-Day vs New 72-Hour Protection Reserve):** Verify pre-6D completed orders retain 7-day `protection_expires_at`; newly completed synthetic order uses exact 72-hour reserve; aged synthetic order moves to `Available for Withdrawal`; active dispute stays frozen past expiry.
- **Scenario F & G (Automatic Withdrawals & Safe Recovery):** Seller withdraws eligible balance on `/seller/withdrawals` → automatic `SIM-TRF-...` without admin approval; QA failure releases reserved balance once; uncertain outcome remains reserved even if admin runs Safe Recovery Check.
- **Scenario H (Admin Financial Reconciliation `/admin`):** Verify Overview KPIs, PASS/FLAG reconciliation checks, payment/refund/withdrawal monitoring (no arbitrary Mark Paid, no unsafe blind release), and sanitized CSV download.
- **Scenario I (Security & Responsive UI):** Desktop `1440×900` & Mobile `390×844` zero horizontal overflow, zero console errors, zero broken images, zero sensitive data (`account_number`, `duitnow_id`, `attempt_token`) in member DOM.
