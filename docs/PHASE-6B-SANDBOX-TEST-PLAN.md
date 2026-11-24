# Phase 6B.3 — Isolated ToyyibPay Sandbox Acceptance Plan (Gate 2)

**Status:** Gate 1 Complete (code, routes, UI, and local tests verified). **STOPPED FOR OWNER APPROVAL** before any external ToyyibPay Sandbox API call or bill creation.
**Prerequisites Verified (Phase 6B.2 Closed — 15/15 PASS, 9/9 Security Retests):**
- `docs/sql/phase-6a-order-payment-foundation.sql` deployed; `pg_cron` Jobs 1 & 2 active.
- `docs/sql/phase-6b2-reserved-stock-guard.sql` deployed (`a7bda62`).
- Server env ready: `TOYYIBPAY_SANDBOX_SECRET_KEY` (set), `TOYYIBPAY_SANDBOX_CATEGORY_CODE` (set), hard-pinned to `https://dev.toyyibpay.com`.
- Note on local webhook callback: ToyyibPay's server-to-server `callbackUrl` requires a publicly reachable HTTPS URL to hit `POST /api/payments/toyyibpay/callback`; on `localhost:3000`, `/orders/return` and `/api/payments/toyyibpay/verify` still perform authoritative server-to-server `getBillTransactions` verification cleanly.

## 0. Gate 2 Isolated Sandbox Acceptance Scenarios (Run Only After Owner Approval)
1. **Fee-Contract Visual Check (First Bill):** Create 1 isolated synthetic QA cart order (`subtotal = RM 15.00`, `fpx_fee = RM 1.00`, `total_paid_sen = 1600`) → open `https://dev.toyyibpay.com/<billCode>` and visually confirm **exact `RM 16.00`** (NOT `RM 17.00`), proving `billChargeToCustomer: ""` prevents RM 1.00 double-charging.
2. **Duplicate-Bill Prevention:** Retry/double-submit the same order → confirm existing pending `bill_code` is reused (zero duplicate Sandbox bills).
3. **Single-Seller Cart Payment + Server Verification:** Complete FPX Sandbox approval → land on `/orders/return` → confirm server-to-server `getBillTransactions` triggers `confirm_order_payment_atomic`, order becomes `paid`, stock decrements, 6-digit `pickup_pin` appears ONLY to buyer (never seller), and duplicate callback returns `already_paid`.
4. **Multi-Seller Cart Checkout + Partial Retry:** Checkout 2 synthetic sellers → confirm 2 separate orders & 2 separate Sandbox bills (`RM 1.00` FPX each, `2%` seller commission each), and confirm retrying a single seller bill works without affecting sibling bills.
5. **Accepted-Offer Checkout:** Accept synthetic Pre-Loved offer → buyer clicks **Pay with ToyyibPay FPX** on `OfferCard` → confirm `create_offer_order_atomic` reuses existing 30m hold (`reserved_quantity` stays `1`, no double-reserve) and creates Sandbox bill at locked offer price + RM 1.00 FPX.
6. **Failed / Cancelled Payment & Retry:** Cancel/fail on Sandbox bank screen → confirm `payments.status = 'failed'`, order stays `pending_payment` before deadline, and **Retry ToyyibPay FPX** on `/orders` creates a fresh bill.
7. **Expired Order + Late Payment Reconciliation:** Confirm expired order releases stock via `pg_cron` Job 2 and any late verified payment routes to `late_payment_review` with zero stock deduction.
8. **0-Diff Cleanup:** Release any remaining QA holds, delete ONLY QA-created rows, and confirm exact 0-diff across all 9 hosted tables.

## 1. Pre-Flight SQL Deployment (Completed in Phase 6B.2)

1. Run `docs/sql/phase-6a-order-payment-foundation.sql` (`BEGIN; ... COMMIT;`) on `duwwlcpdidrxkixvflag`:
   - Extends `payments_status_check` to `('pending','paid','failed','expired','late_payment_review')`.
   - Adds `orders.idempotency_key` + `idx_orders_cart_idempotency`, `idx_payments_unique_transaction_ref`, `idx_orders_pending_payment_deadline`.
   - Deploys `create_offer_order_atomic`, `create_cart_orders_atomic`, `release_expired_cart_orders`, and `confirm_order_payment_atomic`.
2. Schedule `release_expired_cart_orders()` via `pg_cron` (Job ID 2, every 2 minutes):
   ```sql
   SELECT cron.schedule(
     'buyu_release_expired_cart_orders',
     '*/2 * * * *',
     $$SELECT public.release_expired_cart_orders();$$
   );
   ```

## 2. Isolated ToyyibPay Sandbox Test Cases (Post-Approval)

All tests use temporary `[QA-6B]` listings under `examiner.seller` and `examiner.buyer`, with BEFORE/AFTER snapshots protecting `IOT Box` and `#BU-2611-0DB3`.

1. **Fee & No Double-Charge Verification (First Sandbox Bill):**
   - Create a RM 15.00 order (`subtotal_sen=1500`, `fpx_fee_sen=100`, `total_paid_sen=1600`, `commission_sen=30`, `seller_net_sen=1470`).
   - Call ToyyibPay Sandbox `createBill` with `billAmount=1600`, `billPaymentChannel=0`, `billChargeToCustomer=""`.
   - Verify on `https://dev.toyyibpay.com/<billCode>` that buyer payable amount is **EXACTLY RM 16.00** (NOT RM 17.00!).
2. **Multi-Seller Cart Separation & Idempotency:**
   - Cart with 2 sellers (including 1 variant listing) → `create_cart_orders_atomic(key)` creates 2 separate `pending_payment` orders (`15m` deadline), reserves exact stock, clears `cart_items`.
   - Calling `create_cart_orders_atomic(same_key)` again returns the exact same 2 orders with zero extra reservations.
3. **Accepted Offer Checkout (No Double-Reserve):**
   - Accept offer (`reserved_quantity` = 1, 30m hold) → `create_offer_order_atomic(offerId)` creates 1 `source='offer'` order with `payment_deadline = offers.reservation_expires_at` and `reserved_quantity` stays `1`.
4. **Verified Callback vs. Browser Redirect & Replay Protection:**
   - Browser redirect alone leaves order `pending_payment` (`await_verification`).
   - Verified `getBillTransactions` (`billpaymentStatus="1"`, exact `billCode`, `order_code`, `amountSen=1600`) → `confirm_order_payment_atomic` marks `orders.status='paid'`, generates 6-digit `pickup_pin`, deducts `quantity` & `reserved_quantity`.
   - Repeat callback with same `transaction_ref` → `'already_paid'`; conflicting `transaction_ref` → `TRANSACTION_REF_CONFLICT`.
5. **Expired Order & Late Payment Reconciliation:**
   - Expire an unpaid cart order via `release_expired_cart_orders()` (`reserved_quantity` restored to 0, `orders.status='expired'`).
   - Simulate late verified callback → `confirm_order_payment_atomic` marks `payments.status='late_payment_review'` and returns `'late_payment_reconciliation'` WITHOUT deducting stock.
6. **Partial Multi-Seller Bill Failure Recovery:**
   - Simulate 1 bill created + 1 bill failed → ready bill remains usable, failed seller order stays `pending_payment` for retry or clean 15m auto-expiry.
7. **Cleanup & 0-Diff Snapshot:**
   - Delete only `[QA-6B]` orders, order_items, payments, offers, and listings; verify `IOT Box` and `#BU-2611-0DB3` are 100% untouched.
