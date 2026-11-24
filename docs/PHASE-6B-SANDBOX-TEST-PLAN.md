# Phase 6B.3 — Isolated ToyyibPay Sandbox Acceptance Plan (Gate 2)

**Status:** Gate 1 Complete (code, routes, UI, and local tests verified). **STOPPED FOR OWNER APPROVAL** before any external ToyyibPay Sandbox API call or bill creation.
**Prerequisites:**
- Phase 6B.2 closed (15/15 PASS, 9/9 security retests): `phase-6a-order-payment-foundation.sql`, `pg_cron` Jobs 1 & 2, and `phase-6b2-reserved-stock-guard.sql` deployed.
- **Required before Gate 2:** Owner applies `docs/sql/phase-6b3-payment-security-hardening.sql` (DB-level `pickup_pin` & `raw_callback` privacy, Realtime table removal, persistent DB bill-creation coordination, and atomic failed-payment guard).
- Server env ready: `TOYYIBPAY_SANDBOX_SECRET_KEY` (set), `TOYYIBPAY_SANDBOX_CATEGORY_CODE` (set), hard-pinned to `https://dev.toyyibpay.com`.

## 0A. Track A — Localhost (`http://localhost:3000`) Verification Tests (No Public Tunnel Needed)
1. **DB-Level Security Verification:** Confirm seller `SELECT pickup_pin FROM orders` and `SELECT * FROM orders` fail with `42501`; seller `SELECT raw_callback FROM payments` fails with `42501`; seller calling `get_buyer_order_pickup_pins` gets 0 rows; buyer gets own paid PIN only.
2. **Fee-Contract Visual Check (First Sandbox Bill):** Create 1 isolated synthetic QA cart order (`subtotal = RM 15.00`, `fpx_fee = RM 1.00`, `total_paid_sen = 1600`) → open `https://dev.toyyibpay.com/<billCode>` and visually confirm **exact `RM 16.00`** (NOT `RM 17.00`).
3. **DB-Backed Duplicate-Bill & Ambiguous-Timeout Coordination:** Concurrent/repeated `claim_order_bill_slot` returns `in_progress` / `reuse_bill` (zero duplicate bills); simulated timeout marks `bill_creation_state = 'ambiguous'` and blocks blind duplicate recreation.
4. **Return-URL + Server-to-Server Verification:** Complete FPX Sandbox approval → `/orders/return` (and `/api/payments/toyyibpay/verify`) verifies via `getBillTransactions` → `confirm_order_payment_atomic` marks `paid`, deducts stock, generates 6-digit PIN visible ONLY to buyer via `get_buyer_order_pickup_pins`.
5. **Multi-Seller Cart & Accepted-Offer Checkout:** 2 sellers → 2 separate orders & 2 Sandbox bills (`RM 1.00` FPX each, `2%` commission each); accepted offer reuses 30m hold (`reserved_quantity = 1`, no double-reserve).
6. **Failed Payment & Concurrent Terminal-State Protection:** Bank failure calls `mark_order_payment_failed_atomic` (`status = 'failed'`, retryable before deadline); delayed failed callback against a `paid` or `late_payment_review` order returns `ignored_terminal` without overwriting.
7. **0-Diff Cleanup:** Release any remaining QA holds, remove ONLY QA-created rows, confirm exact 0-diff across all 9 tables.

## 0B. Track B — Public HTTPS Webhook Acceptance (Requires Public HTTPS Callback URL)
- **Required Configuration:** Set `NEXT_PUBLIC_SITE_URL=https://<public-https-domain>` (e.g., staging HTTPS deployment or verified HTTPS tunnel forwarding to `localhost:3000`) so `billCallbackUrl` resolves to `https://<public-https-domain>/api/payments/toyyibpay/callback`.
- **Verification:**
  1. Complete Sandbox FPX payment WITHOUT returning to `/orders/return` (close browser tab on ToyyibPay confirmation).
  2. Confirm ToyyibPay's async `POST /api/payments/toyyibpay/callback` triggers server-to-server `getBillTransactions` → `confirm_order_payment_atomic` and transitions the order to `paid` automatically.
  3. Replay the exact callback POST → confirm idempotent `already_paid` (no double stock deduction).
  4. Send a tampered/forged callback POST (`status=1`, bogus `refno`) → confirm server-to-server `getBillTransactions` rejects or ignores it.

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
