# Phase 6A — Order & Payment Foundation Acceptance

## Hosted Database Audit (Read-Only, `duwwlcpdidrxkixvflag`)

- **`public.orders`:** Verified 25 columns including `order_code`, `buyer_id`, `seller_id`, `source` (`'cart'` | `'offer'`), `subtotal_sen`, `fpx_fee_sen` (default `100` = RM 1.00), `total_paid_sen`, `commission_sen` (`2%`), `seller_net_sen`, `status` (default `'pending_payment'`), `pickup_pin`, `collection_area_name`, `payment_deadline` (`15m` for cart orders, `30m` hold for offer orders), `paid_at`, `completed_at`.
  - Verified against live order `#BU-2611-0DB3`: `subtotal_sen: 1500`, `fpx_fee_sen: 100`, `total_paid_sen: 1600`, `commission_sen: 30` (2%), `seller_net_sen: 1470`.
- **`public.order_items`:** Verified 13 columns (`order_id`, `listing_id`, `variant_id`, `title_snapshot`, `variant_snapshot`, `unit_sen`, `quantity`, `image_path`, `is_food`, `availability_mode`, `pickup_window_start`, `pickup_note`).
- **`public.payments`:** Verified 12 columns (`order_id`, `provider` default `'toyyibpay'`, `bill_code`, `bill_url`, `transaction_ref`, `amount_sen`, `status`, `verified_at`, `raw_callback`).
- **Existing RPCs:** No atomic order-creation (`create_offer_order_atomic`, `create_cart_orders_atomic`), expired-cart-order release (`release_expired_cart_orders`), or payment-confirmation (`confirm_order_payment_atomic`) RPCs exist yet.

## Scope Implemented (No Live Payments, No Hosted Writes)

1. **Order Pricing, Commission & Offer Checkout (`src/lib/orders/pricing.ts`)**
   - `calculateOrderFinancials`: exact integer-sen `2%` platform commission (`Math.round(subtotalSen * 0.02)`), `sellerNetSen`, `fpxFeeSen = 100` (RM 1.00), `totalPaidSen = subtotalSen + fpxFeeSen`.
   - `prepareCartOrderPlans`: splits multi-seller carts into separate per-seller order plans (1 FPX bill per seller order, 15m payment window).
   - `prepareOfferOrderPlan`: validates buyer-only ownership, non-self-purchase, member blocks, published Pre-Loved listing, locked negotiated `offer_price_sen`, and strict 30-minute hold deadline regardless of sweeper timing.

2. **ToyyibPay Sandbox Integration Contracts (`src/lib/payments/toyyibpay.ts`)**
   - `buildToyyibPayCreateBillPayload` & `formatToyyibPayExpiryMyt` (deterministic MYT `DD-MM-YYYY HH:mm:ss`, `billChargeToCustomer: 0`, `billExternalReferenceNo = order_code`).
   - `evaluateToyyibPayVerification`: strictly rejects browser redirects (`await_verification`), requires verified server `getBillTransactions` (`billpaymentStatus === "1"`, exact `billCode`, `orderCode`, and integer-sen `amountSen`), handles idempotent repeat callbacks (`idempotent_already_paid`), failed bank payments (`mark_failed`), and expired-order late payments (`late_payment_reconciliation` — never oversells).

3. **Read-Only `/orders` Page & `/checkout` Fee Transparency**
   - Added `src/lib/orders/data.ts`, `src/app/orders/page.tsx`, and `"My Orders"` link in `src/components/layout/SiteHeader.tsx`.
   - Updated `src/components/checkout/CheckoutClient.tsx` to display verified `RM 1.00` FPX fee per seller order, exact estimated total, and `2%` seller commission transparency note while keeping payment buttons disabled until Phase 6B.

4. **SQL Migration Proposal (`docs/sql/phase-6a-order-payment-foundation.sql`, NOT Applied)**
   - Adds `orders.idempotency_key` + unique cart idempotency index, unique `payments.bill_code` index, pending-payment deadline index, `create_offer_order_atomic`, `release_expired_cart_orders`, and `confirm_order_payment_atomic` (`service_role` only).

## Automated & Read-Only Verification

- `tsc --noEmit`: PASS (0 errors)
- `npm run lint`: PASS (0 errors, 0 warnings)
- `node --test`: PASS (56/56 across all 9 suites including `scripts/orders-payment.test.mjs`)
- `npm run build`: PASS
- `node scripts/smoke-check.mjs http://localhost:3000`: PASS (15/15)
- Read-only browser QA (`1440px`, `390px`, `320px`, 0 console errors, 0px overflow):
  - Guest `/orders`: PASS (sign-in gate `/login?next=%2Forders`).
  - Buyer `/orders` (`examiner.buyer`): PASS (`#BU-2611-0DB3`, `IOT Box`, `Subtotal RM 15.00 + FPX RM 1.00 = RM 16.00`, plain-text `Completed`, `Cafe UMSKAL`).
  - Buyer `/checkout` (`examiner.buyer`): PASS (`Items Subtotal RM 40.00 + ToyyibPay FPX Fee (1 bill) RM 1.00 = Estimated Total RM 41.00`, disabled payment button).
