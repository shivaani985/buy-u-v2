# Buy-U Phase 6B.2 — Hosted Database Acceptance Report

- **Target Supabase Project:** `duwwlcpdidrxkixvflag`
- **Date:** 2026-11-24
- **Scope:** Isolated hosted DB acceptance of Phase 6A/6B.1 RPCs, constraints, grants, indexes, `pg_cron` Job 2, and reserved-stock protection. Zero ToyyibPay API calls, zero real payments, zero schema changes, zero production data edits.
- **Overall Result:** **14/15 PASS, 1 FAIL (CONFIRMED BLOCKER)**

## Hosted Evidence

| # | Check | Result | Concrete Hosted Evidence |
|---|---|---|---|
| 1a | RPC existence & strict grants (`anon` & `authenticated`) | **PASS** | All 6 unauthorized calls (`anon` on all 4 RPCs, `authenticated` on `release_expired_cart_orders` & `confirm_order_payment_atomic`) rejected with `42501`. |
| 1b | `payments_status_check` constraint | **PASS** | Bogus status rejected with `23514`; `'late_payment_review'` accepted in check 6c. |
| 2 | Multi-seller cart checkout (RM 1.00 FPX/order, 2% commission) | **PASS** | Created 2 separate orders (`BU-2611-22D2FB`, `BU-2611-F0D0C7`), each `subtotal=3000`, `fpx=100`, `total=3100`, `commission=60`, `seller_net=2940`; `resA=2`, `resVM=2`, `resB=1`. |
| 3a | Duplicate `idempotency_key` submission | **PASS** | Returned exact original 2 orders; zero double-reservation. |
| 3b | Simultaneous identical checkout (`Promise.all`) | **PASS** | Both parallel calls returned same `orderId=4377c546-94e4-48fd-8e53-e1faf362cca6`; `resA=4`, `resVL=2` (no double-reserve). |
| 3c | Variant oversell boundary | **PASS** | Rejected with `INSUFFICIENT_VARIANT_STOCK`. |
| 3d | Concurrent cart addition during checkout | **PASS** | Conservation verified across runs (`inOrder=false, preservedInCart=true` and `inOrder=true, preservedInCart=false`); zero lost or duplicated items. |
| 4 | Accepted-offer checkout without double-reservation | **PASS** | `BU-2611-9BE97B` (`sub=3500`, `total=3600`, `comm=70`, `net=3430`), `reserved_quantity` remained `1` (no double-reserve), idempotent retry returned same order, seller call rejected with `FORBIDDEN_BUYER_ONLY`. |
| 5 | Live `pg_cron` Job 2 automatic expiry, stock release & idempotency | **PASS** | Job 2 expired synthetic cart order automatically (`cronExpired=true`), released exact 2 units (`resA: 5 -> 3`, `resVL: 2 -> 0`, live sibling hold `resVM=3` untouched); second sweep returned `0`. |
| 6a | Payment confirmation rejects amount mismatch | **PASS** | Rejected with `AMOUNT_MISMATCH`. |
| 6b | Payment confirm, stock deduction, duplicate callback, conflict & replay | **PASS** | `confirmed_paid`, 6-digit `pickup_pin=097128`, `qtyA=8`, `qtyVM=4`; duplicate callback → `already_paid`; conflicting ref → `TRANSACTION_REF_CONFLICT`; cross-order ref replay → `23505` (`idx_payments_unique_transaction_ref`). |
| 6c | Late payment after expiry (expiry race) | **PASS** | Returned `late_payment_reconciliation` (idempotent on retry), `payments.status='late_payment_review'`, order remained `'expired'`, zero stock oversell. |
| 6d | Accepted-offer payment confirmation | **PASS** | `confirmed_paid`, deducted 1 unit & cleared hold (`qty=0`, `res=0`). |
| 7 | Protect `reserved_quantity` from direct seller UPDATE | **FAIL (BLOCKER)** | Direct seller `UPDATE listings SET quantity = 0` was blocked by `listings_check`, **but direct seller `UPDATE listings SET reserved_quantity = 0` SUCCEEDED (`before: {quantity:5, reserved_quantity:2}` → `after: {quantity:5, reserved_quantity:0}`)**. |
| 8 | 0-diff cleanup & existing data preservation | **PASS** | Exact 0-diff across all 9 tables (`listings: 2`, `listing_variants: 0`, `cart_items: 1`, `conversations: 1`, `offers: 0`, `orders: 1`, `order_items: 1`, `payments: 1`, `notifications: 27`). |

## Blocker & Recommended Next Fix (Awaiting Owner Approval)
- **Blocker:** Authenticated sellers can directly mutate `listings.reserved_quantity` (and should also be verified/guarded on `listing_variants.reserved_quantity`), allowing them to wipe active buyer holds and subsequently reduce `quantity` below held stock.
- **Recommended Minimal Fix (SQL hotfix, not yet applied):** Add a `BEFORE UPDATE` trigger on `public.listings` and `public.listing_variants` blocking `NEW.reserved_quantity IS DISTINCT FROM OLD.reserved_quantity` when invoked directly by `authenticated` (allowing mutations only via `SECURITY DEFINER` RPCs / `service_role`, e.g., using a `pg_trigger_depth()` / session-context or `current_user` guard).
