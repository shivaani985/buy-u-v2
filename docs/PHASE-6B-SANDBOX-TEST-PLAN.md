# Phase 6B — Isolated ToyyibPay Sandbox & Atomic Order Test Plan

**Status:** Proposal / Ready for Owner Authorization (ZERO live calls or migrations executed yet).

## 1. Pre-Flight SQL Deployment (Requires Owner Approval)

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
