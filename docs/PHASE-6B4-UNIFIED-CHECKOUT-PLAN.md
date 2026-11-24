# Buy-U Phase 6B.4 — Unified Multi-Seller Checkout Architecture & Gate 1 Plan

**Status:** FIRST GATE — Architecture, Database Design, Migration Strategy, Security Analysis & Acceptance Plan (NO code edits, NO hosted SQL changes, NO external ToyyibPay calls).

---

## 1. Current Architecture Audit (Phase 6B.3 Baseline)

- **Hosted DB state (read-only audit, 2026-11-24):**
  - Preserved paid legacy orders:
    - `BU-2611-0DB3` (`completed`, `bill_code=u4jq05z9`, `TP2611233721702887`, `1600 sen`)
    - `BU-2611-3CB12A` (`paid`, `bill_code=91bbcj6m`, `TP2611241359322034`, `1600 sen`) — **preserved untouched for Phase 6C handover QA**.
  - Historical expired QA orders: `BU-2611-1E3303` (`kijv65iu`), `BU-2611-FD6D1B` (`8u2sxqk2`).
  - Unpaid multi-bill QA orders from prior session: `BU-2611-D89742` (`ovuxdy57`, `2100 sen`) and `BU-2611-9488CD` (`asbh6d4g`, `1600 sen`) — both have `payment_deadline = 2026-11-24T05:37:42Z` (13:37 MYT) and will naturally expire via `pg_cron` Job 2 (`release_expired_cart_orders`), releasing their 1-unit holds while preserving their gateway `bill_code` records untouched.
- **Limitation of Phase 6B.3 model:** `payments` enforces `UNIQUE(order_id)` and `create_cart_orders_atomic` charges `fpx_fee_sen = 100` on every seller order, forcing `N` sellers → `N` ToyyibPay bills and `N × RM 1.00` FPX fees.

---

## 2. Target Unified Checkout Architecture

**One Checkout = One `checkout_sessions` Row = One ToyyibPay Bill = One RM 1.00 FPX Fee = `N` Independent Seller `orders`.**

### Worked Financial Example (2 Sellers)
| Entity | Subtotal | FPX Fee | Buyer Pays | 2% Commission | Seller Net |
|---|---:|---:|---:|---:|---:|
| Child Order A (Seller A) | RM 15.00 (`1500`) | RM 0.00 (`0`) | — | RM 0.30 (`30`) | RM 14.70 (`1470`) |
| Child Order B (Seller B) | RM 20.00 (`2000`) | RM 0.00 (`0`) | — | RM 0.40 (`40`) | RM 19.60 (`1960`) |
| **Parent Checkout (`CHK-...`)** | **RM 35.00 (`3500`)** | **RM 1.00 (`100`)** | **RM 36.00 (`3600`)** | **RM 0.70 (`70`)** | **Internal allocation** |

- **Accepted-Offer Checkout:** Separate purchase → creates 1 parent `checkout_sessions` (`source='offer'`, `fpx_fee_sen=100`, `payment_deadline=offer.reservation_expires_at`, 30m hold) + 1 child `orders` row (`fpx_fee_sen=0`, `subtotal_sen=offer_price_sen`). Reuses existing Phase 5B hold without double-reservation.
- **Seller Earnings:** Internal ledger allocations on each seller's `orders` row (`seller_net_sen`); zero external seller payouts/transfers at checkout.

---

## 3. Database Changes (Proposed Migration `docs/sql/phase-6b4-unified-checkout.sql`)

### 3.1 New Table: `public.checkout_sessions`
```sql
CREATE TABLE public.checkout_sessions (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_code               text NOT NULL UNIQUE, -- e.g. 'CHK-2611-A1B2C3' (ToyyibPay billExternalReferenceNo)
  buyer_id                    uuid NOT NULL REFERENCES public.profiles(id),
  source                      text NOT NULL CHECK (source IN ('cart', 'offer')),
  idempotency_key             text NOT NULL,
  combined_subtotal_sen       integer NOT NULL CHECK (combined_subtotal_sen >= 200),
  fpx_fee_sen                 integer NOT NULL DEFAULT 100 CHECK (fpx_fee_sen = 100),
  total_paid_sen              integer NOT NULL CHECK (total_paid_sen = combined_subtotal_sen + fpx_fee_sen),
  status                      text NOT NULL DEFAULT 'pending_payment'
                                CHECK (status IN ('pending_payment', 'paid', 'expired', 'cancelled')),
  payment_deadline            timestamptz NOT NULL,
  paid_at                     timestamptz,
  provider                    text NOT NULL DEFAULT 'toyyibpay',
  bill_code                   text UNIQUE,
  bill_url                    text,
  bill_creation_state         text NOT NULL DEFAULT 'not_started'
                                CHECK (bill_creation_state IN ('not_started', 'creating', 'ready', 'ambiguous', 'failed')),
  bill_creation_started_at    timestamptz,
  bill_creation_attempt_token uuid,
  payment_status              text NOT NULL DEFAULT 'pending'
                                CHECK (payment_status IN ('pending', 'paid', 'failed', 'expired', 'late_payment_review')),
  transaction_ref             text,
  verified_at                 timestamptz,
  raw_callback                jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (buyer_id, source, idempotency_key)
);
```
- **Indexes:**
  - `CREATE UNIQUE INDEX idx_checkout_sessions_unique_tx_ref ON public.checkout_sessions (transaction_ref) WHERE transaction_ref IS NOT NULL;`
  - `CREATE INDEX idx_checkout_sessions_pending_deadline ON public.checkout_sessions (payment_deadline) WHERE status = 'pending_payment' AND paid_at IS NULL;`

### 3.2 Additive Link on `public.orders` (Legacy-Safe)
- `ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS checkout_session_id uuid REFERENCES public.checkout_sessions(id);`
- `CREATE INDEX IF NOT EXISTS idx_orders_checkout_session_id ON public.orders (checkout_session_id) WHERE checkout_session_id IS NOT NULL;`
- Existing legacy orders (`BU-2611-0DB3`, `BU-2611-3CB12A`, `BU-2611-D89742`, `BU-2611-9488CD`, etc.) keep `checkout_session_id IS NULL` and remain 100% untouched.
- Existing `public.payments` table, constraints (`UNIQUE(order_id)`), and rows remain 100% untouched (no risky schema relaxation on `payments`).

### 3.3 Atomic RPC Suite (All `SECURITY DEFINER`, `SET search_path = public, pg_temp`)
1. **`create_cart_checkout_atomic(p_idempotency_key text)`** (`authenticated`):
   - Per-buyer `pg_advisory_xact_lock`, idempotency lookup on `checkout_sessions(buyer_id, 'cart', key)`, sweeps expired offer & checkout holds, snapshots exact `v_cart_item_ids uuid[]`, pre-locks `listings (ORDER BY id)` → `listing_variants (ORDER BY id)`, validates active sellers/blocks/stock, reserves stock, inserts 1 parent `checkout_sessions` (`fpx_fee_sen=100`, `total_paid_sen=combined_subtotal+100`, `payment_deadline=now()+15m`), inserts `N` child `orders` (`checkout_session_id`, `fpx_fee_sen=0`, `total_paid_sen=seller_subtotal`, `commission_sen=ROUND(subtotal*0.02)`, `seller_net_sen=subtotal-commission`) + `order_items`, deletes ONLY `v_cart_item_ids`.
2. **`create_offer_checkout_atomic(p_offer_id uuid, p_idempotency_key text)`** (`authenticated`):
   - Locks `offers` → validates active buyer/seller/hold/no double-reserve → creates 1 parent `checkout_sessions` (`source='offer'`, `fpx_fee_sen=100`, `payment_deadline=offer.reservation_expires_at`) + 1 child `orders` (`checkout_session_id`, `fpx_fee_sen=0`, `total_paid_sen=offer_price_sen`) + links `offers.order_id`.
3. **`claim_checkout_bill_slot(p_checkout_session_id uuid)`** & **`finalize_checkout_bill_slot(p_checkout_session_id uuid, p_attempt_token uuid, p_outcome text, p_bill_code text, p_bill_url text)`** (`service_role`):
   - Exact same battle-tested Phase 6B.3 attempt-token & bill-reuse state machine (`reuse_bill`, `in_progress`, `ambiguous_hold`, `stale_attempt`, `recovered_ready`), now scoped to ONE bill per `checkout_sessions` row.
4. **`confirm_checkout_payment_atomic(p_checkout_session_id uuid, p_bill_code text, p_transaction_ref text, p_amount_sen integer, p_raw_callback jsonb)`** (`service_role`):
   - Lock order (deadlock-free with Phase 5B & cart sweepers): `offers (if source='offer') -> checkout_sessions -> child orders (ORDER BY id) -> listings (ORDER BY id) -> listing_variants (ORDER BY id)`.
   - Validates exact `p_amount_sen = checkout_sessions.total_paid_sen`, `bill_code`, duplicate `transaction_ref` (`already_paid` vs `TRANSACTION_REF_CONFLICT`).
   - Late payment after expiry/released hold → sets `checkout_sessions.payment_status = 'late_payment_review'`, returns `'late_payment_reconciliation'`, deducts ZERO stock.
   - On-time verified payment → verifies exact reservations on ALL child orders before mutating ANY row (all-or-nothing; zero partial confirmation!), deducts stock & variants across all child orders, marks `checkout_sessions.status = 'paid'`, marks ALL child `orders.status = 'paid'` with a **distinct random 6-digit `pickup_pin` per seller order** in ONE atomic transaction!
5. **`mark_checkout_payment_failed_atomic(p_checkout_session_id uuid, p_bill_code text, p_raw_callback jsonb)`** (`service_role`):
   - Locks `checkout_sessions`; returns `ignored_terminal` if `status='paid'` or `payment_status IN ('paid','late_payment_review')`; otherwise sets `payment_status='failed'` while preserving `bill_creation_state='ready'`, `bill_code`, and `bill_url`.
6. **`release_expired_cart_orders()`** (updated cleanly, same `pg_cron` Job 2 schedule):
   - Releases BOTH legacy standalone expired cart orders (`checkout_session_id IS NULL`) AND expired unified `checkout_sessions` (`status='pending_payment'`, `payment_deadline <= now()`) atomically as a whole checkout (expiring the parent session + all child orders + releasing all reservations with exact subtraction, no `GREATEST(0, ...)`).

---

## 4. Migration & Legacy Reconciliation Strategy

1. **Pre-flight check:** Verify `orders` table CHECK constraints allow `fpx_fee_sen = 0` and `total_paid_sen = subtotal_sen` for child orders (adjust constraint cleanly if needed, keeping `>= 0`).
2. **Zero backfill / zero conversion of historical records:**
   - Legacy orders (`BU-2611-0DB3`, `BU-2611-3CB12A`, `BU-2611-1E3303`, `BU-2611-FD6D1B`) stay untouched (`checkout_session_id IS NULL`).
   - Unpaid multi-bill QA orders (`BU-2611-D89742` / `ovuxdy57`, `BU-2611-9488CD` / `asbh6d4g`) expire naturally via `pg_cron` Job 2 without converting or deleting their `payments` / `bill_code` history.
3. **Dual-read server compatibility:**
   - `/api/payments/toyyibpay/callback`, `/api/payments/toyyibpay/verify`, and `/orders/return` resolve `bill_code` against `checkout_sessions` FIRST, falling back to legacy `payments` for historical bills.
   - `/orders` groups unpaid unified `checkout_sessions` cleanly with ONE **Pay Now** button, while displaying paid orders as individual seller order cards with independent Pickup PINs and handover status.
   - Seller dashboard (`src/lib/seller/data.ts`) reads `orders` (`subtotal_sen`, `commission_sen`, `seller_net_sen`) and remains 100% compatible.
4. **Full Rollback Plan:** Drop new `checkout_sessions` RPCs, drop `orders.checkout_session_id` column/index, drop `checkout_sessions` table, restore `release_expired_cart_orders()` to Phase 6B.1 body.

---

## 5. Security Analysis

- **Buyer-Only Pickup PIN Privacy:** Preserves `REVOKE SELECT (pickup_pin)` on `orders` and `get_buyer_order_pickup_pins(uuid[])`. Each child seller order gets its own independent 6-digit `pickup_pin` at atomic confirmation; sellers still get `42501` on direct `SELECT` and `0` rows from the RPC.
- **`raw_callback` Privacy & RLS on `checkout_sessions`:**
  - Enable RLS on `public.checkout_sessions` with buyer-only SELECT policy (`auth.uid() = buyer_id`).
  - Column-level `REVOKE SELECT ON public.checkout_sessions FROM authenticated, anon;` + `GRANT SELECT (all columns EXCEPT raw_callback, bill_creation_attempt_token) TO authenticated;`.
  - Keep `public.checkout_sessions` OUT of `supabase_realtime` publication.
- **No Partial Confirmation / Oversell:** `confirm_checkout_payment_atomic` validates combined `total_paid_sen` AND every child order's stock/variant reservation in one transaction before mutating any row.
- **Per-Seller Refund Allocation (Phase 6D Ready):**
  - Each child order's refundable merchandise cap is `order.subtotal_sen`; commission reversal is `order.commission_sen`; seller net adjustment is `order.seller_net_sen`.
  - The single `checkout_sessions.fpx_fee_sen = 100` is NEVER duplicated across sellers or over-refunded on partial single-seller refunds.

---

## 6. UI/UX Plan (Campus Pop Editorial — `#FAF9FC`, `#4E2A84`, `#008285`, `#E6E3EE`)

- **`/checkout` (`CheckoutClient.tsx`):**
  - Keep clear per-seller item & collection breakdown cards so buyers see each campus seller's pickup area.
  - Display **`ToyyibPay FPX Fee: RM 1.00 (once per checkout)`** (NOT `N bills`) and **`Total Payable: combinedSubtotal + RM 1.00`**.
  - **One primary `Pay RM XX.XX with ToyyibPay FPX` button** — remove the multi-bill `Pay Seller Bill` queue completely.
- **`/orders/return`:**
  - Display one consolidated **Payment Confirmed (`#CHK-...`, RM XX.XX incl. RM 1.00 FPX)** summary header, followed by **individual seller order cards** (`#BU-...`), each with its own campus collection area and buyer-only 6-digit Pickup PIN.
- **`/orders` (`OrdersClient.tsx`):**
  - Unpaid unified checkout: grouped card showing all included seller orders, countdown deadline, single **Pay / Retry ToyyibPay FPX** button, and **Check Status** button.
  - Paid / Completed / Expired orders: individual seller order cards with independent Pickup PIN, collection status, and handover lifecycle (Phase 6C).

---

## 7. Acceptance Scenarios (Gate 2 Verification Plan)

1. **One seller, one item:** RM 15.00 + RM 1.00 FPX = **RM 16.00** (1 checkout, 1 order, 1 bill, comm RM 0.30, net RM 14.70).
2. **One seller, multiple product types:** 2 distinct items (RM 10 + RM 15) + RM 1.00 FPX = **RM 26.00** (1 checkout, 1 seller order, 1 bill, comm RM 0.50).
3. **Multiple quantities of one product:** Qty 3 × RM 10 + RM 1.00 FPX = **RM 31.00** (1 checkout, 1 order, 3 units reserved/deducted).
4. **Multiple sellers & multiple items:** Seller A (RM 15) + Seller B (RM 20) + **ONE RM 1.00 FPX** = **RM 36.00** (1 checkout, 1 Sandbox bill displaying `RM 36.00`, 2 internal seller orders with `fpx_fee_sen=0`, Seller A net RM 14.70 / comm RM 0.30, Seller B net RM 19.60 / comm RM 0.40, 2 distinct buyer-only Pickup PINs).
5. **Failed payment & same-bill retry:** Fail consolidated bill → `payment_status='failed'` preserving `bill_code`; retry reopens exact same `bill_code`; subsequent approval marks ALL child orders `paid` atomically.
6. **Concurrent checkout, whole-checkout expiry & duplicate callbacks:** Parallel identical checkouts return same `checkout_session`; expiry expires parent + all child orders + releases all holds atomically; duplicate callback returns `already_paid`; late payment routes to `late_payment_review` with zero stock deduction.
7. **Independent seller handovers & Phase 6D refund allocation:** Verify Seller A & Seller B orders have separate PINs, statuses, and non-duplicated refund caps (`1500` and `2000`, never duplicating `100` FPX fee).
8. **Legacy compatibility:** Verify `BU-2611-0DB3` (`completed`), `BU-2611-3CB12A` (`paid`, preserved for Phase 6C), and expired legacy multi-bill QA orders remain readable and intact with zero data loss.
