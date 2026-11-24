# Buy-U Phase 6B.4 — Hosted PostgreSQL Database Acceptance

- **Date:** 2026-11-24
- **Target Project:** `duwwlcpdidrxkixvflag` (Hosted Supabase PostgreSQL)
- **Migrations Applied by Owner:**
  1. `docs/sql/phase-6b4-unified-checkout.sql` (commit `16a5a08`)
  2. `docs/sql/phase-6b4-offer-expiry-hotfix.sql` (commit `bf7c13e` — removed erroneous `updated_at = v_now` on `public.offers` in `release_expired_offer_reservations()`)
- **External Gateway Calls:** `0` (strictly synthetic hosted DB QA; zero ToyyibPay API calls)
- **Overall Result:** **14/14 PASS — CLOSED**

---

## Verification Matrix (14/14 PASS)

| # | Check | Status | Hosted PostgreSQL Evidence |
|---|---|---|---|
| 1 | Single seller, single item (`RM 15 + RM 1 = RM 16`) & safe RPC columns | **PASS** | `CHK-2611-107822`, `total_paid_sen=1600`, `child.fpx_fee_sen=0`, `commission=30`, `seller_net=1470`, no `raw_callback` or `bill_creation_attempt_token` returned |
| 2 | Same seller, multiple product types (`RM 15 + RM 10 + RM 1 = RM 26`) | **PASS** | `CHK-2611-57E171`, `combined_subtotal_sen=2500`, `fpx_fee_sen=100`, `total_paid_sen=2600`, 1 child order (`comm=50`, `net=2450`) |
| 3 | Multiple quantities (`3 × RM 10 + RM 1 = RM 31`) | **PASS** | `CHK-2611-8F05FF`, `total_paid_sen=3100`, `commission=60`, `seller_net=2940` |
| 4 | Multiple sellers (`RM 15 + RM 20 + RM 1 = RM 36`) | **PASS** | `CHK-2611-0C3D23`, 1 checkout session + 2 child orders: `BU-2611-971792` (`fpx=0`, `comm=30`, `net=1470`) & `BU-2611-6A955A` (`fpx=0`, `comm=40`, `net=1960`), total commission `RM 0.70` |
| 5 | Actual seller `accept_offer_atomic`, 30-min hold, unified offer checkout (no double reservation), live `pg_cron` Job 1 release & payment-vs-expiry races | **PASS** | Retest after hotfix (7/7 PASS): `accept_offer_atomic` -> `status=accepted`, `holdMin=30.00`, `reserved=1`; `create_offer_checkout_atomic` -> `CHK-2611-E77558`, `total=1600`, `childFpx=0`, `comm=30`, `net=1470`, `reserved=1`; live `pg_cron` Job 1 expired offer/checkout/order & released `res=0` (`sweep2=0`); Paid-wins race (`confirmed_paid`, `sweep=0`, `qty=0`, `res=0`); Expired concurrent race (`late_payment_reconciliation`, `job1=1`, `qty=1`, `res=0`, `payStatus=late_payment_review`) |
| 6 | Concurrent checkout, idempotency, variant stock & retired legacy RPCs | **PASS** | Concurrent `Promise.all` returned same session ID (`sameId=true`), variant `reserved_quantity=1`, oversell rejected (`INSUFFICIENT_VARIANT_STOCK`), legacy `create_cart_orders_atomic` & `create_offer_order_atomic` denied (`42501`, `42501`) |
| 7 | Concurrent bill claims, token privacy, recovery, reuse & legacy child block | **PASS** | Concurrent claims `["create_new","in_progress"]`, placeholder `bill_code` excludes `attempt_token`, stale token rejected (`stale_attempt`), ambiguous hold recovered (`recovered_ready`), failed payment reused (`reuse_bill`), legacy `claim_order_bill_slot` blocked unified child (`use_checkout_session`) |
| 8 | Atomic 2-seller payment confirmation & stock deduction (synthetic QA ref) | **PASS** | `confirmed_paid`, Seller A stock `10 -> 9`, Seller B stock `5 -> 4`, both child orders `paid`, terminal failed-mark ignored (`ignored_terminal`) |
| 9 | Cross-table `transaction_ref` replay protection | **PASS** | Replaying historical `TP2611241359322034` (from `BU-2611-3CB12A`) rejected with PostgreSQL `23505` (`payment_transaction_registry`) |
| 10 | Duplicate callback, invalid amount, blank `bill_code`, late payment & conflict | **PASS** | Duplicate `already_paid`, invalid amount `AMOUNT_MISMATCH`, blank bill `MISSING_BILL_CODE`, conflicting paid ref `TRANSACTION_REF_CONFLICT`, late payment `late_payment_reconciliation`, conflicting late ref `LATE_PAYMENT_TRANSACTION_REF_CONFLICT` |
| 11 | Live `pg_cron` Job 2 unified cart expiry & exact stock release | **PASS** | Live `pg_cron` expired `CHK-2611-8F05FF` (`cronExpired=true`), released exact reservation `4 -> 1`, second sweep `0`; re-verified `release_expired_cart_orders()` post-hotfix (`released=1`, `qty=1`, `res=0`, `cs=expired`) |
| 12 | Distinct buyer-only PINs, RLS/column privacy & legacy compatibility | **PASS** | Buyer received `2` distinct 6-digit PINs; Seller A & B received `0` rows; `checkout_sessions.raw_callback`, `checkout_sessions.bill_creation_attempt_token`, and `payment_transaction_registry` denied (`42501`, `42501`, `42501`); legacy orders `BU-2611-0DB3` & `BU-2611-3CB12A` preserved |
| 13 | Seller earnings calculation (`computeSellerFinancials`) on unified orders | **PASS** | Seller A: `sales=1500`, `pending=1470`; Seller B: `sales=2000`, `pending=1960` |
| 14 | Exact 0-diff cleanup across all 11 tables | **PASS** | `0` diffs across all 11 tables on both initial run and post-hotfix retest; `BU-2611-3CB12A` & `BU-2611-0DB3` preserved |

---

## Baseline vs After Row Counts (Exact 0-Diff Cleanup)

| Table | Baseline | After Final Retest | Diff |
|---|---:|---:|---:|
| `listings` | 4 | 4 | 0 |
| `listing_variants` | 0 | 0 | 0 |
| `cart_items` | 1 | 1 | 0 |
| `conversations` | 1 | 1 | 0 |
| `offers` | 0 | 0 | 0 |
| `checkout_sessions` | 0 | 0 | 0 |
| `orders` | 6 | 6 | 0 |
| `order_items` | 6 | 6 | 0 |
| `payments` | 6 | 6 | 0 |
| `payment_transaction_registry` | 2 | 2 | 0 |
| `notifications` | 27 | 27 | 0 |

---

## Unified ToyyibPay Sandbox Manual Testing Instructions (Ready When Owner Authorizes)

### Prerequisites
- Start local Buy-U server (`npm run start` on `http://localhost:3000` in `C:\FYP VAANI\Buy-U-v2`) after owner authorizes Sandbox testing.
- Preserved records (do not touch): `BU-2611-3CB12A` (Phase 6C handover QA) and `BU-2611-0DB3`.

### Existing Isolated QA Accounts & Listings
- **Buyer (clean cart):** `examiner.staff@ums.edu.my`
- **Seller A:** `examiner.seller@iluv.ums.edu.my` — Listing `RM 15.00`: `http://localhost:3000/product/3436ee88-db3c-4f35-9e0e-91d4b40f73c4`
- **Seller B:** `examiner.buyer@iluv.ums.edu.my` — Listing `RM 20.00`: `http://localhost:3000/product/1c3ccc6b-e540-4d99-af65-9330d88c9727`

### Test Flow (One Consolidated RM 36.00 FPX Bill)
1. Sign in as `examiner.staff@ums.edu.my`.
2. Add Seller A (`RM 15.00`) and Seller B (`RM 20.00`) to cart.
3. Open `/checkout` and verify UI breakdown:
   - Seller A subtotal: `RM 15.00`
   - Seller B subtotal: `RM 20.00`
   - Combined subtotal: `RM 35.00`
   - FPX fee (charged ONCE): `RM 1.00`
   - **Total payable: `RM 36.00`**
4. Click **Pay RM 36.00 with FPX** -> confirm redirect to **ONE** ToyyibPay Sandbox bill (`dev.toyyibpay.com/<billCode>`) for **`RM 36.00`**.
5. Approve payment using **CIMB Clicks Sandbox simulator** (not SBI Bank A).
6. Return to `/orders/return` -> `/orders` and verify:
   - **1** `checkout_sessions` row (`status = 'paid'`, `total_paid_sen = 3600`, `fpx_fee_sen = 100`, gateway-verified `transaction_ref` recorded in `payment_transaction_registry`).
   - **2** independent child `orders` rows (`status = 'paid'`, `fpx_fee_sen = 0`):
     - Seller A child order: `subtotal = RM 15.00`, `commission = RM 0.30`, `seller_net = RM 14.70`.
     - Seller B child order: `subtotal = RM 20.00`, `commission = RM 0.40`, `seller_net = RM 19.60`.
   - Buyer sees **two distinct 6-digit pickup PINs** (one per seller order).
   - Stock deducted by `1` on each listing; `reserved_quantity = 0`.
7. Sign in as Seller A (`examiner.seller@iluv.ums.edu.my`) and Seller B (`examiner.buyer@iluv.ums.edu.my`) separately:
   - Each sees only their own paid order (`RM 14.70` / `RM 19.60` pending settlement) and **zero PIN exposure**.
