# Buy-U Phase 6B.4 — Hosted PostgreSQL Database Acceptance

- **Date:** 2026-11-24
- **Target Project:** `duwwlcpdidrxkixvflag` (Hosted Supabase PostgreSQL)
- **Migration Tested:** `docs/sql/phase-6b4-unified-checkout.sql` (applied from commit `16a5a08`)
- **External Gateway Calls:** `0` (strictly synthetic hosted DB QA; zero ToyyibPay API calls)
- **Overall Result:** **BLOCKED — 13/14 PASS, 1 REAL HOSTED SQL BLOCKER (Check 5a)**

---

## Real Hosted SQL Blocker Found

- **Blocker:** `public.release_expired_offer_reservations()` (installed by `phase-6b4-unified-checkout.sql`) updates `updated_at = v_now` on `public.offers` in two places, but `public.offers` has no `updated_at` column.
- **Observed Hosted PostgreSQL Error:** `42703: column "updated_at" of relation "offers" does not exist`
- **Impact:**
  1. `pg_cron` Job 1 (`public.release_expired_offer_reservations()`) fails with `42703`.
  2. `public.accept_offer_atomic(p_offer_id)` calls `release_expired_offer_reservations()` at entry and therefore fails with `42703` when accepting any offer.
- **Proposed Fix (NOT applied):** `docs/sql/phase-6b4-offer-expiry-hotfix.sql` (removes the two `updated_at = v_now` assignments on `public.offers` while preserving lock order, exact release, and `service_role`-only grants).

---

## Verification Matrix (14 Checks)

| # | Check | Status | Hosted PostgreSQL Evidence |
|---|---|---|---|
| 1 | Single seller, single item (`RM 15 + RM 1 = RM 16`) & safe RPC columns | **PASS** | `CHK-2611-107822`, `total_paid_sen=1600`, `child.fpx_fee_sen=0`, `commission=30`, `seller_net=1470`, no `raw_callback` or `bill_creation_attempt_token` returned |
| 2 | Same seller, multiple product types (`RM 15 + RM 10 + RM 1 = RM 26`) | **PASS** | `CHK-2611-57E171`, `combined_subtotal_sen=2500`, `fpx_fee_sen=100`, `total_paid_sen=2600`, 1 child order (`comm=50`, `net=2450`) |
| 3 | Multiple quantities (`3 × RM 10 + RM 1 = RM 31`) | **PASS** | `CHK-2611-8F05FF`, `total_paid_sen=3100`, `commission=60`, `seller_net=2940` |
| 4 | Multiple sellers (`RM 15 + RM 20 + RM 1 = RM 36`) | **PASS** | `CHK-2611-0C3D23`, 1 checkout session + 2 child orders: `BU-2611-971792` (`fpx=0`, `comm=30`, `net=1470`) & `BU-2611-6A955A` (`fpx=0`, `comm=40`, `net=1960`), total commission `RM 0.70` |
| 5a | Offer acceptance (`accept_offer_atomic`) & `pg_cron` Job 1 | **FAIL (BLOCKER)** | Both failed with `42703: column "updated_at" of relation "offers" does not exist` |
| 5b | Accepted-offer unified checkout (`create_offer_checkout_atomic`) | **PASS** | `CHK-2611-447C6A`, `total_paid_sen=1600`, `reserved_quantity=1` (no double reservation), `child.fpx_fee_sen=0` |
| 6 | Concurrent checkout, idempotency, variant stock & retired legacy RPCs | **PASS** | Concurrent `Promise.all` returned same session ID (`sameId=true`), variant `reserved_quantity=1`, oversell rejected (`INSUFFICIENT_VARIANT_STOCK`), legacy `create_cart_orders_atomic` & `create_offer_order_atomic` denied (`42501`, `42501`) |
| 7 | Concurrent bill claims, token privacy, recovery, reuse & legacy child block | **PASS** | Concurrent claims `["create_new","in_progress"]`, placeholder `bill_code` excludes `attempt_token`, stale token rejected (`stale_attempt`), ambiguous hold recovered (`recovered_ready`), failed payment reused (`reuse_bill`), legacy `claim_order_bill_slot` blocked unified child (`use_checkout_session`) |
| 8 | Atomic 2-seller payment confirmation & stock deduction (synthetic QA ref) | **PASS** | `confirmed_paid`, Seller A stock `10 -> 9`, Seller B stock `5 -> 4`, both child orders `paid`, terminal failed-mark ignored (`ignored_terminal`) |
| 9 | Cross-table `transaction_ref` replay protection | **PASS** | Replaying historical `TP2611241359322034` (from `BU-2611-3CB12A`) rejected with PostgreSQL `23505` (`payment_transaction_registry`) |
| 10 | Duplicate callback, invalid amount, blank `bill_code`, late payment & conflict | **PASS** | Duplicate `already_paid`, invalid amount `AMOUNT_MISMATCH`, blank bill `MISSING_BILL_CODE`, conflicting paid ref `TRANSACTION_REF_CONFLICT`, late payment `late_payment_reconciliation`, conflicting late ref `LATE_PAYMENT_TRANSACTION_REF_CONFLICT` |
| 11 | Live `pg_cron` Job 2 unified expiry & exact stock release | **PASS** | Live `pg_cron` expired `CHK-2611-8F05FF` (`cronExpired=true`), released exact reservation `4 -> 1`, second sweep idempotent (`0`) |
| 12 | Distinct buyer-only PINs, RLS/column privacy & legacy compatibility | **PASS** | Buyer received `2` distinct 6-digit PINs; Seller A & B received `0` rows; `checkout_sessions.raw_callback`, `checkout_sessions.bill_creation_attempt_token`, and `payment_transaction_registry` denied (`42501`, `42501`, `42501`); legacy orders `BU-2611-0DB3` & `BU-2611-3CB12A` preserved |
| 13 | Seller earnings calculation (`computeSellerFinancials`) on unified orders | **PASS** | Seller A: `sales=1500`, `pending=1470`; Seller B: `sales=2000`, `pending=1960` |
| 14 | Exact 0-diff cleanup across all 11 tables | **PASS** | `0` diffs across all 11 tables (see counts below); `BU-2611-3CB12A` and all historical/QA listings preserved |

---

## Baseline vs After Row Counts (Exact 0-Diff Cleanup)

| Table | Baseline | After QA | Diff |
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

## Next Step

1. Owner reviews and applies `docs/sql/phase-6b4-offer-expiry-hotfix.sql` on `duwwlcpdidrxkixvflag`.
2. Re-run Check 5 (`accept_offer_atomic` + live `release_expired_offer_reservations` + `create_offer_checkout_atomic`) to confirm **14/14 PASS** before authorizing ToyyibPay Sandbox testing.
