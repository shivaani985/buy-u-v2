# Buy-U Phase 6D — Financial Architecture, 3-Day Protection Policy & Migration Guide

## 1. Authoritative Financial Equations (Integer Sen)
All calculations execute in exact integer sen (`src/lib/financials/policy.ts`, `src/lib/seller/financials.ts`, `src/lib/financials/reconciliation.ts`):

- **Total Verified Collections** = `Gross Verified Product Sales + FPX Fees` (parent `checkout_sessions` + legacy `payments`, never double-counted with child orders)
- **Net Product Sales** = `Gross Verified Product Sales − Executed Product Refunds`
- **Net Platform Commission (2%)** = `Original Commission − Commission Reversals`
  - ToyyibPay RM 1.00 FPX fee is tracked separately and is NEVER counted as platform commission or profit.
- **Refund Accounting Invariant:** `Refund Amount = Commission Reversal + Seller Earnings Deduction`
  - Preserved partial refund (`BU-2611-C3CC55`, RM 20 → RM 5 refund): Retained `1500` sen → Adjusted commission `30` sen → Commission reversal `10` sen + Seller deduction `490` sen = `500` sen; Adjusted seller net = `1470` sen.
  - Preserved full refund (`BU-2611-3CB12A`, RM 15 → RM 15 refund): Retained `0` → Commission reversal `30` sen + Seller deduction `1470` sen = `1500` sen; Adjusted seller net = `0`.
- **Seller 6-Bucket Mutually Exclusive Balance Invariant:**
  `Adjusted Seller Earnings = Pending Settlement + Buyer Protection Reserve + Frozen Dispute/Refund Earnings + Available for Withdrawal + Reserved/Processing Withdrawals + Total Successfully Paid Out`
  - Failed/rejected withdrawals never count as paid out or reserved.
  - Non-succeeded refunds (`pending_execution`, `awaiting_return`, `processing`, `failed`, `reconciliation_required`) remain frozen.
- **Authoritative Payment Proof (`is_order_payment_verified` / `isAuthoritativeOrderPaymentVerified`):**
  - Requires `orders.paid_at IS NOT NULL` AND either verified parent `checkout_sessions` (`status = 'paid'`, `payment_status = 'paid'`, `paid_at IS NOT NULL`, matching `buyer_id`) OR verified legacy `payments` (`status = 'paid'`, `verified_at IS NOT NULL`). Never relies on `orders.paid_at` alone.

## 2. Three-Day (72-Hour) Buyer Protection & Historical Transition Policy (P0.7)
- **Single Authoritative Deadline (`orders.protection_expires_at`):** Used identically for dispute eligibility, withdrawal allocation, and frontend display.
- **Historical Transition:**
  - Orders completed **before** Phase 6D activation keep their already-promised 7-day deadline (`protection_expires_at = completed_at + interval '7 days'`).
  - All **new** completions after Phase 6D activation receive exactly **72 hours** (`protection_expires_at = completed_at + interval '72 hours'`) via trigger `trg_orders_set_protection_deadline`.
  - `completed_at` is NEVER reset; existing disputes remain frozen indefinitely until resolved.
- **Exact Boundary (Server Authoritative Clock):**
  - Dispute eligible strictly when `clock_timestamp() < protection_expires_at`.
  - Undisputed completed earnings become withdrawable at `clock_timestamp() >= protection_expires_at`.

## 3. Legacy Bank Account Security & Migration Approach (P0.2 / P0.3)
- **Chosen Approach:** Safe Deactivation + Masked Historical Preservation + Mandatory Encrypted Re-Registration.
- On migration, any pre-existing `seller_payout_accounts` row without `v1:` AES-256-GCM ciphertext:
  1. Preserves `account_number_last4` and `account_number_masked` (`****1234`).
  2. Overwrites plaintext `account_number` with the safe masked placeholder (preserving `NOT NULL` while removing all plaintext digits).
  3. Clears `duitnow_id = NULL`.
  4. Sets `is_active = false`, `validation_status = 're_registration_required'`.
- Table constraint `seller_payout_accounts_active_encrypted_check` and `create_seller_withdrawal_atomic` strictly require `is_active = true`, `validation_status = 'validated'`, and `account_number_encrypted LIKE 'v1:%'`.
- Upsert uses explicit `ON CONFLICT ON CONSTRAINT seller_payout_accounts_pkey` and acquires the shared seller lock (`profiles FOR UPDATE`) to serialize cleanly with withdrawals.

## 4. Concurrency, Restock Integrity & Durable Recovery (P0.4 / P0.5 / P0.8 / P0.9)
- **Strict Shared Lock Order (deadlock-free across Phase 6B/6C/6D):**
  `profiles (seller_id FOR UPDATE)` → `orders (ORDER BY id FOR UPDATE)` → `order_disputes` → `order_refunds` → `payout_requests` → `payout_allocations` → `listings (ORDER BY id FOR UPDATE)` → `listing_variants (ORDER BY id FOR UPDATE)`.
- **Single Authoritative Dispute Resolution RPC (P0.1):** Legacy 4-parameter `admin_resolve_order_dispute_atomic(uuid, text, integer, text)` is dropped; only the 6-parameter RPC exists.
- **Separated Restock Workflow (P0.8):**
  - `admin_approve_refund_restock_atomic` validates explicit `order_item_id` + `quantity` against purchased quantities, rejects food/service listings and damaged/missing items, requires confirmed resellable return if already handed over, and records `approved_pending_refund` without mutating stock until refund succeeds.
  - `finalize_order_refund_atomic` executes `execute_approved_refund_restock_internal` atomically on refund success, preserving `reserved_quantity <= quantity` and logging missing/incompatible inventory as `inventory_exception` without blocking refund completion.
- **Durable Provider Processing & Evidence-Based Recovery (P0.4 / P0.5):**
  - `public.financial_execution_attempts` persists every claim (`started`), provider outcome (`record_provider_attempt_outcome_atomic` with deterministic `SIM-RFD-...` / `SIM-TRF-...` ref derived from `logical_tx_id`), and finalization timestamp.
  - Unsafe `admin_release_failed_withdrawal_atomic` is removed. Recovery (`recover_financial_execution_atomic`, `scripts/phase6d-recovery-worker.mjs`, and `/admin` Safe Recovery Check) finalizes confirmed successes (validating exact `SUM(allocated_sen) = amount_sen`) or definitive failures once, and **holds uncertain outcomes reserved** (`held_uncertain`). Never releases funds on elapsed time or admin notes.
  - All notification writes use `safe_insert_notification` so notification failures cannot abort financial transactions.

## 5. Installation & Hosted Activation Instructions
1. Review and execute `docs/sql/phase-6d-financial-ecosystem.sql` in Supabase SQL Editor on `duwwlcpdidrxkixvflag`.
2. Ensure `BUYU_BANK_ENCRYPTION_KEY` (32-byte hex key) is set in server environment variables (`.env.local` locally; host secrets in deployment).
3. Schedule the durable recovery worker (`node scripts/phase6d-recovery-worker.mjs`) every 5 minutes via cron / host scheduler / GitHub Actions, or trigger manually via `/admin` Safe Recovery Check.
4. **Rollback / Recovery:** Never delete succeeded `order_refunds`, `financial_adjustments`, `order_restock_logs`, `financial_execution_attempts`, or paid `payout_requests`.
