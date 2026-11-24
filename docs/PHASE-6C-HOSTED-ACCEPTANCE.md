# Buy-U Phase 6C — Hosted PostgreSQL Database Acceptance

- **Date:** 2026-11-24
- **Target Project:** `duwwlcpdidrxkixvflag` (Hosted Supabase PostgreSQL)
- **Migration Applied by Owner:** `docs/sql/phase-6c-handover-completion.sql` (commit `7414eaf`)
- **External Gateway / Payout Calls:** `0` (strictly isolated synthetic hosted DB QA)
- **Overall Result:** **10/10 PASS — HOSTED DB ACCEPTANCE CLOSED**

---

## Hosted PostgreSQL Verification Matrix (10/10 PASS)

| # | Check | Status | Hosted PostgreSQL Evidence |
|---|---|---|---|
| 1 | SQL functions installed & strict permissions | **PASS** | `anon` denied (`42501`, `42501`) on both RPCs; `authenticated` denied (`42501`) on `generate_secure_pickup_pin()`; seller `SELECT pickup_pin` denied (`42501`); direct client `INSERT` on `order_disputes` denied (`42501`) |
| 2 | Secure 6-digit PIN generation & buyer-only retrieval | **PASS** | Unified 2-seller checkout confirmed (`confirmed_paid`), two 6-digit CSPRNG PINs generated; buyer `get_buyer_order_pickup_pins` returned both; Seller A & B returned `0` rows |
| 3 | Unauthorized seller/buyer attempts & premature receipt | **PASS** | Buyer calling `verify_order_pickup_pin_atomic` (`42501`), Seller B on Seller A's order (`42501`), Seller A calling `confirm_buyer_order_receipt_atomic` (`42501`), buyer premature receipt before handover (`invalid_status`) |
| 4 | Persistent 5 failed attempts & 15-minute lockout | **PASS** | Wrong PIN sequence persisted across separate requests: `invalid_pin:1/4 -> 2/3 -> 3/2 -> 4/1 -> locked:5/0`; DB `pin_failed_attempts=5`, `pin_locked_until=+15.0m`; even valid PIN rejected (`locked`) while locked |
| 5 | Lockout expiry recovery, concurrent verify, PIN consumption & child independence | **PASS** | After lockout expiry, concurrent `Promise.all` verify returned `["already_handed_over", "handed_over"]`; `status='handed_over'`, `handed_over_at` recorded, `pickup_pin=NULL`, `pin_failed_attempts=0`, buyer PIN query `0` rows; Child B stayed `paid` with valid PIN intact |
| 6 | Buyer-only receipt confirmation, concurrent protection & earnings transitions | **PASS** | Concurrent `Promise.all` confirm returned `["already_completed", "completed"]`; `completed_at` recorded, `completed_method='pickup_pin'`; `computeSellerFinancials`: Seller A `pendingSettlementSen 1470 -> 0`, `availableForPayoutSen 0 -> 1470` |
| 7 | Open/under_review disputes blocked; resolved dispute compatible | **PASS** | `open` -> `order_disputed`, `under_review` -> `order_disputed`; once `resolved`, Child B completed cleanly (`handed_over -> completed`) |
| 8 | Unpaid & expired orders blocked + Phase 6B.4 expiry regressions | **PASS** | Unpaid (`invalid_status`), expired (`invalid_status`); `release_expired_cart_orders()` (`1`) and `release_expired_offer_reservations()` (`0`) executed cleanly |
| 9 | Legacy payment compatibility (`checkout_session_id IS NULL`) | **PASS** | Legacy order without verified `payments` row blocked (`payment_unverified`); with verified `payments` row transitioned `paid -> handed_over -> completed` |
| 10 | Exact 0-diff cleanup & preserved QA orders untouched | **PASS** | `0` diffs across all 12 tables; `BU-2611-0DB3 (completed)`, `BU-2611-3CB12A (paid)`, `BU-2611-B1C075 (paid)`, `BU-2611-C3CC55 (paid)` preserved |

---

## Baseline vs After Row Counts (Exact 0-Diff Cleanup)

| Table | Baseline | After QA | Diff |
|---|---:|---:|---:|
| `listings` | 4 | 4 | 0 |
| `listing_variants` | 0 | 0 | 0 |
| `cart_items` | 1 | 1 | 0 |
| `conversations` | 1 | 1 | 0 |
| `offers` | 0 | 0 | 0 |
| `checkout_sessions` | 1 | 1 | 0 |
| `orders` | 8 | 8 | 0 |
| `order_items` | 8 | 8 | 0 |
| `payments` | 6 | 6 | 0 |
| `payment_transaction_registry` | 3 | 3 | 0 |
| `order_disputes` | 0 | 0 | 0 |
| `notifications` | 27 | 27 | 0 |

---

## Owner Manual UI Testing Instructions (Using Preserved QA Orders)

Start local server (`node node_modules/next/dist/bin/next start -p 3000` in `C:\FYP VAANI\Buy-U-v2`) and test on desktop & mobile viewports:

1. **Buyer View (`/orders`) — Sign in as `examiner.staff@ums.edu.my` (unified checkout `CHK-2611-053C84`):**
   - Verify `BU-2611-B1C075` (Seller A, RM 15) and `BU-2611-C3CC55` (Seller B, RM 20) each show:
     - Separate private 6-digit pickup PINs, 4-step progress timeline (`Placed -> Paid`), **Contact Seller / Arrange Collection**, and **Report a Problem (Not Yet Available)**.
     - Confirm **Confirm Receipt** is NOT shown yet.
   - Note Seller A's 6-digit PIN for `BU-2611-B1C075`.
2. **Seller A View (`/seller/orders`) — Sign in as `examiner.seller@iluv.ums.edu.my`:**
   - Verify 6 filter tabs + search work, buyer's PIN is NEVER shown, and transaction label on `/seller` reads **Paid — Awaiting Handover** with `RM 14.70` in **Pending Settlement**.
   - Test 1 wrong PIN on `BU-2611-B1C075` -> verify `"Incorrect PIN. 4 attempts remaining..."`.
   - Enter Buyer's valid 6-digit PIN -> click **Verify Handover** -> status moves to **Awaiting Receipt Confirmation**, PIN form disappears, `RM 14.70` remains in **Pending Settlement**.
3. **Buyer Receipt Confirmation (`/orders`) — Sign in as `examiner.staff@ums.edu.my`:**
   - Verify `BU-2611-B1C075` no longer shows its PIN, shows **Confirm Receipt** button, and `BU-2611-C3CC55` is still **Paid — Awaiting Handover** with its own PIN intact (independent lifecycle!).
   - Click **Confirm Receipt** -> confirm dialog -> `BU-2611-B1C075` becomes **Completed**.
4. **Seller A Earnings (`/seller` & `/seller/orders`):**
   - Verify `BU-2611-B1C075` is **Completed**, and `RM 14.70` moved from **Pending Settlement** to **Available for Payout**.
5. **Independent Seller B & Legacy Verification:**
   - Repeat steps 2–4 for Seller B (`examiner.buyer@iluv.ums.edu.my`, `BU-2611-C3CC55`, `RM 19.60`) and/or legacy order `BU-2611-3CB12A` (Seller A, `RM 14.70`).
