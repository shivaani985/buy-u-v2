# Buy-U Phase 6B.3 — Gate 2A Sandbox Acceptance Report

- **Date:** 2026-11-24
- **Target Supabase Project:** `duwwlcpdidrxkixvflag`
- **Gateway:** ToyyibPay Sandbox ONLY (`https://dev.toyyibpay.com`)
- **Local App:** `http://localhost:3000` (production build `5a3b581`)
- **Result:** **13/13 PASS, 0 FAIL** (6/6 Hosted Security Precheck + 6/6 Gate 2A Sandbox + 0-diff Cleanup)

## 1. Hosted Security Precheck (6/6 PASS — Executed Before Any ToyyibPay Call)

| Check | Result | Concrete Hosted Evidence |
|---|---|---|
| P1. Obsolete 4-arg RPC removed & strict grants/revokes | **PASS** | Obsolete 4-arg `finalize_order_bill_slot` → `PGRST202`; `buyer` denied (`42501`) on `claim_order_bill_slot`, `finalize_order_bill_slot`, `mark_order_payment_failed_atomic`; `anon` denied (`42501`) on `get_buyer_order_pickup_pins`; seller direct `SELECT pickup_pin` & `raw_callback` → `42501`. |
| P2. Concurrent bill claims (`Promise.all`) | **PASS** | Serialized cleanly into `[create_new, in_progress]` with unique UUID `attempt_token`. |
| P3. Failed bill creation retry & stale token rejection | **PASS** | `finalize('failed')` → new claim got new UUID token; stale attempt token rejected with `stale_attempt`. |
| P4. Ambiguous timeout hold & late recovery | **PASS** | `finalize('ambiguous')` → duplicate claim returned `ambiguous_hold`; late verified response with matching token returned `recovered_ready`. |
| P5. Failed payment attempt preserves & reuses valid bill | **PASS** | `mark_order_payment_failed_atomic` → `marked_failed` while preserving `bill_creation_state='ready'` and `bill_code`; subsequent claim returned `reuse_bill` with exact same `bill_code`. |
| P6. Terminal-state protection & buyer-only PIN | **PASS** | Paid order confirmed (`confirmed_paid`), delayed failed callback returned `ignored_terminal`; buyer `get_buyer_order_pickup_pins` returned 6-digit PIN `589736`, seller received `0` rows. |

## 2. Gate 2A Live ToyyibPay Sandbox Verification (6/6 PASS)

| Check | Result | Concrete Evidence |
|---|---|---|
| S1. Live Sandbox single-seller bill & fee verification | **PASS** | `BU-2611-DB8C5F` → `billCode=nh66q78f` (`https://dev.toyyibpay.com/nh66q78f`, HTTP 200). Live page displays **`16.00` (`RM 16.00`)** and **NOT `17.00`** (`shows16.00=true, shows17.00=false`), confirming `billChargeToCustomer=""` + `billPaymentChannel=0` prevents RM 1.00 double-charge. Order financials: `subtotal=1500`, `fpx=100`, `total=1600`, `commission=30` (RM 0.30), `seller_net=1470` (RM 14.70). |
| S2. Duplicate request & failed-payment retry on live bill | **PASS** | Duplicate claim and retry after `mark_order_payment_failed_atomic` both returned `reuse_bill` with exact `billCode=nh66q78f` (zero duplicate Sandbox bills). |
| S3. Localhost `/orders/return`, `/verify` & `/callback` forged-Paid defense | **PASS** | Unauthenticated `/orders/return?status_id=1` rendered sign-in guard (HTTP 200) without marking Paid; unauthenticated `POST /api/payments/toyyibpay/verify` returned `401`; forged `POST /api/payments/toyyibpay/callback` (`status=1`, `refno=FORGED-REF-999`) verified against live ToyyibPay `getBillTransactions` → returned `outcome="pending"`, order stayed `pending_payment`. |
| S4. Multi-seller checkout (2 sellers → 2 bills) | **PASS** | Created 2 separate orders & 2 distinct Sandbox bills: `BU-2611-A7A170` (`billCode=2mr373wt`, total `2100`, comm `40`) and `BU-2611-1FBB93` (`billCode=j53orzjw`, total `1600`, comm `30`). |
| S5. Accepted-offer Sandbox bill (no double-reserve) | **PASS** | `BU-2611-C5CC3E` (`billCode=92bzuz7b`, total `1600`), `reserved_quantity` remained `1`. |
| S6. Verified payment + stock deduction + PIN + late-payment reconciliation | **PASS** | `confirm_order_payment_atomic` → `confirmed_paid`, stock decremented (`4 -> 3`), buyer-only PIN `682783` (seller `0` rows); expired order late payment → `late_payment_reconciliation` without stock deduction, and delayed failed callback returned `ignored_terminal`. |

## 3. Recorded ToyyibPay Sandbox Bill IDs

| Scenario | Order Code | ToyyibPay Sandbox `billCode` | Sandbox URL |
|---|---|---|---|
| Single-Seller RM 15 + RM 1 FPX | `BU-2611-DB8C5F` | `nh66q78f` | `https://dev.toyyibpay.com/nh66q78f` |
| Multi-Seller (RM 20 + RM 1 FPX) | `BU-2611-A7A170` | `2mr373wt` | `https://dev.toyyibpay.com/2mr373wt` |
| Multi-Seller (RM 15 + RM 1 FPX) | `BU-2611-1FBB93` | `j53orzjw` | `https://dev.toyyibpay.com/j53orzjw` |
| Accepted Offer (RM 15 + RM 1 FPX) | `BU-2611-C5CC3E` | `92bzuz7b` | `https://dev.toyyibpay.com/92bzuz7b` |

## 4. Cleanup (0-Diff Verified)
- Released all synthetic reservations and deleted ONLY QA-created rows.
- Exact 0-diff across all 9 hosted tables: `listings: 2`, `listing_variants: 0`, `cart_items: 1`, `conversations: 1`, `offers: 0`, `orders: 1`, `order_items: 1`, `payments: 1`, `notifications: 27`.

## 5. Manual Browser Testing Instructions (Interactive FPX Bank Approval)
1. Open `http://localhost:3000/login` and sign in as an active UMS buyer (e.g., `examiner.staff@ums.edu.my` or `examiner.buyer@iluv.ums.edu.my`).
2. Add an item to Cart → open `http://localhost:3000/checkout` → click **Pay with ToyyibPay FPX**.
3. On ToyyibPay Sandbox (`https://dev.toyyibpay.com/<billCode>`), confirm the exact payable amount equals `subtotal + RM 1.00`, select **FPX**, choose **SBI Bank A** (Sandbox test bank), and click **Proceed** → **Approve** (or **Decline** to test failed payment retry).
4. After redirect back to `http://localhost:3000/orders/return`:
   - On **Approve**: verify status is **Payment Confirmed** and your private 6-digit **Campus Pickup PIN** is displayed. Open `http://localhost:3000/orders` to confirm it appears there too; sign in as seller to confirm the PIN is never visible.
   - On **Decline**: verify status is **Payment Failed or Cancelled**, open `http://localhost:3000/orders`, click **Retry ToyyibPay FPX**, and confirm it reopens the same Sandbox bill before the 15m deadline.
5. **Gate 2B (Separate):** To test async server-to-server ToyyibPay webhook delivery without returning to `/orders/return`, set `NEXT_PUBLIC_SITE_URL=https://<public-https-domain>` pointing to `localhost:3000` (or staging) and repeat Step 3 closing the browser tab before redirect.

## 6. Owner Manual Sandbox Acceptance Results (2026-11-24 — PASS)
- **Live Gateway-Confirmed Order (Preserved for Phase 6C Handover QA):**
  - Order Code: **`BU-2611-3CB12A`** (`id: 3faaeecf-cd0d-45ef-b4b5-ea0910203103`)
  - ToyyibPay Sandbox Bill: **`91bbcj6m`** (`https://dev.toyyibpay.com/91bbcj6m`)
  - Verified Transaction Reference: **`TP2611241359322034`**
  - Verified Paid Amount: **`RM 16.00`** (`1600 sen` = `RM 15.00` subtotal + `RM 1.00` FPX; `commission = RM 0.30`, `seller_net = RM 14.70`)
  - Timestamps: `paid_at = verified_at = 2026-11-24T05:10:50.280913+00:00`
  - Stock Deduction: QA listing `3436ee88-db3c-4f35-9e0e-91d4b40f73c4` decremented **`5 → 4`**, `reserved_quantity = 0`.
  - Pickup PIN Privacy: 6-digit PIN generated and visible ONLY to buyer; seller dashboard showed `RM 30.00` total sales, `RM 14.70` pending settlement, and **zero PIN exposure**.
  - Failed Payment & Automatic Expiry: Verified failed payment handling and automatic expiry/stock release.
- **Preservation Note:** Paid QA order `BU-2611-3CB12A` and QA listing `3436ee88-db3c-4f35-9e0e-91d4b40f73c4` are intentionally preserved for **Phase 6C (Pickup PIN & Campus Handover)** testing.

## 7. Observations & Follow-Up Items
1. **ToyyibPay 10-Minute Retry Cooldown:** ToyyibPay Sandbox enforced an observed ~10-minute cooldown after a failed FPX attempt. Successful same-bill retry after cooldown and whether the cooldown is scoped per-bill vs across different bills remain unverified.
2. **Phase 6C Seller UI Polish:** Seller dashboard transaction labels (`Pending`, `Cancelled`) should be clarified in Phase 6C to distinguish `Awaiting Payment`, `Paid · Awaiting Handover`, `Expired`, and `Cancelled`.

## 8. Minimal Targeted Test — Retry & Multi-Bill Cooldown Scope
*(Run on `http://localhost:3000` with 2-seller cart checkout when ready — no code/SQL changes required):*
1. **Multi-Bill Cooldown Scope (Immediate Check, <2 min):**
   - Add 1 item from Seller A and 1 item from Seller B → Checkout → creates `Bill A` and `Bill B` (15m hold).
   - Open `Bill A` → **Decline** on SBI Bank A → return to `/orders` (note `Bill A` enters ToyyibPay's 10m cooldown).
   - **Immediately** open `Bill B` and attempt **Approve** on SBI Bank A:
     - If `Bill B` succeeds immediately → ToyyibPay cooldown is **per-bill** (multi-seller sibling bills unaffected).
     - If `Bill B` is also blocked for 10m → ToyyibPay cooldown is **per-payer/merchant** (document UX guidance on `/orders`).
2. **Same-Bill Retry After Cooldown (~10–11 min mark, before 15m deadline):**
   - Wait until `t + 10m 30s` (still ~4.5m before `Bill A`'s 15m expiry) → click **Retry ToyyibPay FPX** on `Bill A` (reuses exact `Bill A` `bill_code`) → **Approve** on SBI Bank A → confirm `/orders/return` transitions `Bill A` to `paid`, deducts stock, and generates a buyer-only PIN.

