# Buy-U Phase 6D — Final Hosted PostgreSQL Acceptance & Financial Reconciliation Report

- **Date:** 2026-11-24
- **Target Hosted Project:** `duwwlcpdidrxkixvflag`
- **Applied Migrations:** `docs/sql/phase-6d-financial-ecosystem.sql` (commit `189c08d`) + `docs/sql/phase-6d-service-role-grants.sql` (commit `a96fb79`)
- **Result:** **Gate A PASS · Gate B 7/7 PASS · Independent Reconciliation 5/5 PASS**
- **Real Money / ToyyibPay Calls / Production Deployment / GitHub Push:** `0`

---

## 1. Gate A — Migration Verification & Pre-Test Baseline
- All 5 new tables (`order_refunds`, `order_restock_logs`, `financial_adjustments`, `payout_allocations`, `financial_execution_attempts`) installed with `service_role` grants and strict `anon`/`authenticated` lockdown.
- Legacy 4-parameter `admin_resolve_order_dispute_atomic` and unsafe `admin_release_failed_withdrawal_atomic` confirmed removed.
- Legacy `seller_payout_accounts` row safely masked (`****`), `duitnow_id` cleared, `is_active = false`, `validation_status = 're_registration_required'`.
- Historical completed orders preserved 7-day `protection_expires_at` (`BU-2611-0DB3` → `2026-11-29T19:41:31Z`; `BU-2611-B1C075` → `2026-12-01T07:41:30Z`).
- Two preserved Phase 6D.1 pending refunds backfilled cleanly: `RFD-2611-872723` (`partial_refund`, 500 sen) and `RFD-2611-19B70A` (`full_refund`, 1500 sen).

---

## 2. Gate B — Live Hosted PostgreSQL Acceptance (`scripts/phase6d-hosted-acceptance.mjs`) — 7/7 PASS
All checks ran against isolated temporary QA fixtures with exact cleanup verified in `finally`:
1. **P0.11 Protection Deadline & PIN Privacy — PASS:** Buyer and seller PostgREST queries read `orders.protection_expires_at` (trigger stamped exact 72 hours on new completion); seller `SELECT pickup_pin` denied.
2. **P0.2/P0.3 Bank Account Security & Upsert — PASS:** Staff registration rejected; student AES-256-GCM upsert & replacement (`ON CONFLICT ON CONSTRAINT seller_payout_accounts_pkey`) succeeded; raw `account_number`, `account_number_encrypted`, and `duitnow_id` denied to authenticated members; cross-user reads returned 0 rows.
3. **Buyer Protection Boundaries — PASS:** Dispute rejected at/after expiry (`DISPUTE_WINDOW_EXPIRED`), permitted before expiry, and `release_to_seller` restored `completed` without resetting `completed_at`.
4. **Refunds, Return Gate, Separated Restock & P0.12 Immutable Evidence — PASS:** Food listing restock rejected (`FOOD_OR_SERVICE_NOT_RESTOCKABLE`); return-required refund blocked until active seller confirmation (buyer reporting alone blocked); duplicate `order_item_id` rejected; restock held as `approved_pending_refund` until refund success; unrecorded finalization rejected (`UNVERIFIED_PROVIDER_SUCCESS`); identical outcome replay idempotent; conflicting outcome rejected (`CONFLICTING_PROVIDER_OUTCOME`); refund success cleared `pickup_pin` and incremented variant stock once atomically.
5. **Automatic Withdrawals, Unverified Payment Rejection & Live Recovery Worker — PASS:** Unverified aged completed order (`paid_at` without payment proof) excluded; below RM 2.00 and excess withdrawals rejected; definitive failure released reserved allocations once; live `node scripts/phase6d-recovery-worker.mjs` recovered interrupted persisted withdrawal (`paid`, exact allocation sum) and second worker run was idempotent.
6. **Security Lockdown — PASS:** All `service_role`-only RPCs and direct client inserts on `payout_requests` denied for both authenticated members and `anon`.
7. **Preserved QA Records & Cleanup — PASS:** All temporary QA fixtures deleted cleanly; preserved QA orders and disputes untouched.

---

## 3. Gate D — Final Independent Hosted Financial Reconciliation (5/5 PASS)
- **Designated QA Executed Refunds (2 records):**
  - `RFD-2611-872723` (`BU-2611-C3CC55`, partial): `500` sen refund · `10` sen commission reversal · `490` sen seller deduction · `SIM-RFD-2611-872723-6108ED9C` · order restored to `paid`.
  - `RFD-2611-19B70A` (`BU-2611-3CB12A`, full): `1500` sen refund · `30` sen commission reversal · `1470` sen seller deduction · `SIM-RFD-2611-19B70A-974D0C79` · order `refunded`, `pickup_pin = null`, `restock_status = approved_restocked`.
  - **Combined Totals:** **RM 20.00** (`2000` sen) refunds · **RM 0.40** (`40` sen) commission reversal · **RM 19.60** (`1960` sen) seller deduction (**EXACT MATCH**).
- **Platform Ledger Totals:**
  - Verified Collections: `6800` sen = Gross Sales (`6500`) + FPX Fees (`300`).
  - Net Product Sales: `4500` sen · Net Platform Commission (2%): `90` sen.
  - Adjusted Seller Earnings: `4410` sen = Pending Settlement (`1470`) + Protection Reserve (`2940`) + Frozen (`0`) + Available (`0`) + Reserved (`0`) + Paid Out (`0`).
  - Immutable ledgers: `6` `financial_adjustments` rows, `1` `order_restock_logs` row.
  - Reconciliation checks: **5/5 PASS** (`duplicate_tx_refs`, `collections_vs_orders`, `seller_earnings_equation`, `refund_limits`, `stale_processing`).

## 4. Recovery Worker Operations Note
- Local worker verified via `node scripts/phase6d-recovery-worker.mjs` (continuous watch: `node scripts/phase6d-recovery-worker.mjs --watch --interval-ms=30000`).
- **No permanent hosted cron/scheduler is installed yet**; activate per Section 5 of `docs/PHASE-6D-FINANCIAL-ARCHITECTURE.md` during production deployment.
