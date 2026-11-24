# Buy-U Phase 6D — Financial Architecture, 3-Day Protection Policy & Migration Guide

## 1. Authoritative Financial Equations (Integer Sen)
All calculations execute in exact integer sen (`src/lib/financials/policy.ts`, `src/lib/seller/financials.ts`, `src/lib/financials/reconciliation.ts`):

- **Net Product Sales** = `Gross Verified Product Sales − Executed Product Refunds`
- **Net Platform Commission (2%)** = `Original Commission − Commission Reversals`
  - ToyyibPay RM 1.00 FPX fee is tracked separately and is NEVER counted as platform commission or profit.
- **Refund Accounting Invariant:** `Refund Amount = Commission Reversal + Seller Earnings Deduction`
  - Preserved partial refund example (`BU-2611-C3CC55`, RM 20 → RM 5 refund): Retained `1500` sen → Adjusted commission `30` sen → Commission reversal `10` sen + Seller deduction `490` sen = `500` sen; Adjusted seller net = `1470` sen.
  - Preserved full refund example (`BU-2611-3CB12A`, RM 15 → RM 15 refund): Retained `0` → Commission reversal `30` sen + Seller deduction `1470` sen = `1500` sen; Adjusted seller net = `0`.
- **Seller 6-Bucket Mutually Exclusive Balance Invariant:**
  `Adjusted Seller Earnings = Pending Settlement + Buyer Protection Reserve (72h) + Frozen Dispute/Refund Earnings + Available for Withdrawal + Reserved/Processing Withdrawals + Total Successfully Paid Out`
  - Failed/rejected withdrawals never count as paid out or reserved.

## 2. Three-Day (72-Hour) Buyer Protection Policy
- **Single Authoritative Constant:** `BUYER_PROTECTION_HOURS = 72` (`interval '72 hours'` in PostgreSQL). All previous 7-day references have been removed.
- **Exact Boundary (Server Authoritative Clock):**
  - Post-completion dispute eligible strictly when `clock_timestamp() < completed_at + interval '72 hours'`.
  - Undisputed completed earnings become withdrawable at `clock_timestamp() >= completed_at + interval '72 hours'`.
  - Automatic release is derived directly from `completed_at + 72h` — no browser session or manual admin approval required.
- **Disputes During Protection:** Opening a dispute freezes ONLY the affected seller order (`orders.status = 'disputed'`). Expiry of the 72-hour clock NEVER releases an actively disputed or `pending_execution` refund order.
- **Resolution Outcomes:**
  - `release_to_seller`: Restores exact `previous_order_status` (`paid`, `handed_over`, or `completed`) without restarting `completed_at` or skipping receipt confirmation.
  - `full_refund` (succeeded): Sets `orders.status = 'refunded'`, clears `pickup_pin`, zeros seller earnings.
  - `partial_refund` (succeeded): Restores exact `previous_order_status`, preserves `completed_at` and any unconsumed valid `pickup_pin`, applies remaining original 72-hour reserve if completed.
- **Historical Transition Behaviour:** Existing disputes legitimately opened before this migration remain valid and are never retroactively invalidated. Historical completed orders use their actual `completed_at + 72 hours` to compute reserve vs withdrawable eligibility without mutating historical timestamps.

## 3. Concurrency & Shared Seller-Level Lock Order
Every balance-changing RPC acquires locks in ONE strict global order:
1. `public.profiles (seller_id FOR UPDATE)` — serializes withdrawals, disputes, and refund finalizations per seller.
2. `public.orders (ORDER BY id FOR UPDATE)`
3. `public.order_disputes` → `public.order_refunds` → `public.payout_requests` → `public.payout_allocations`
4. `public.listings (ORDER BY id)` → `public.listing_variants (ORDER BY id)`

Order-level `public.payout_allocations` ensures an order can NEVER be both newly allocated to a withdrawal and newly disputed concurrently.

## 4. FYP Simulation & Security Boundaries
- **Simulated Providers (`src/lib/financials/providers.ts`):** `SimulatedRefundProvider` (`SIM-RFD-...`) and `SimulatedBankPayoutProvider` (`SIM-TRF-...`) implement replaceable server-only interfaces and fail closed when `BUYU_PAYMENT_ENV=production`.
- **Bank Account Protection (`src/lib/financials/bank.ts`):** Full Malaysian bank account numbers are validated internally (format only — `"Account Details Validated"`), encrypted server-side with AES-256-GCM (`BUYU_BANK_ENCRYPTION_KEY`), and masked (`****1234`) in all client queries, withdrawal snapshots, and CSV exports.
- **No Routine Admin Approval for Withdrawals:** Valid withdrawals ≥ RM 2.00 reserve funds atomically and disburse automatically via the simulated bank provider. Admin handles only `reconciliation_required` / stale `processing` exceptions via `admin_release_failed_withdrawal_atomic` (no arbitrary Mark Paid button).

## 5. Installation & Safe Recovery Instructions
1. Review and execute `docs/sql/phase-6d-financial-ecosystem.sql` in Supabase SQL Editor on `duwwlcpdidrxkixvflag` (single atomic transaction; automatically backfills preserved pending disputes `DSP-2611-218ADE` and `DSP-2611-21DDF7` into `public.order_refunds`).
2. Set `BUYU_BANK_ENCRYPTION_KEY` (32+ char random secret) in server environment variables before live use.
3. **Rollback / Recovery:** Never delete succeeded `order_refunds`, `financial_adjustments`, `order_restock_logs`, or `paid` `payout_requests`. Use `admin_release_failed_withdrawal_atomic` for confirmed non-disbursed `reconciliation_required` withdrawals.
