# Buy-U Phase 6D.1 — Hosted PostgreSQL & Private Storage Acceptance

- **Date:** 2026-11-24
- **Target Project:** `duwwlcpdidrxkixvflag` (Hosted Supabase PostgreSQL + Private `dispute-evidence` Bucket)
- **Migration Applied by Owner:** `docs/sql/phase-6d1-disputes-buyer-protection.sql` (commit `ca5d830`)
- **External Gateway / Payout / Refund Calls:** `0`
- **Overall Result:** **21/21 PASS — HOSTED ACCEPTANCE CLOSED**

---

## Hosted Verification Matrix (21/21 PASS)

| # | Requirement | Status | Live Hosted Evidence |
|---|---|---|---|
| 1 | All 4 dispute RPCs installed & permissions | **PASS** | `anon` denied (`42501` × 4); regular members denied (`42501` × 2) on `admin_mark_dispute_under_review_atomic` & `admin_resolve_order_dispute_atomic` |
| 2 | All 6 dispute reasons work | **PASS** | Opened & verified all 6 codes (`not_received`, `not_as_described`, `damaged`, `wrong_item`, `missing_item`, `other` -> `"Other order issue"`) |
| 3 | Buyer ownership & verified payment enforcement | **PASS** | Seller opening dispute denied (`42501`); unverified legacy order rejected (`PAYMENT_UNVERIFIED`); expired order rejected (`ORDER_NOT_DISPUTABLE`) |
| 4 | 7-day completed-order protection window | **PASS** | Completed order 8 days old rejected (`DISPUTE_WINDOW_EXPIRED`); 1-day-old completed order accepted |
| 5 | Insufficient undisbursed balance rejection | **PASS** | With synthetic pending `payout_requests` consuming balance, completed-order dispute rejected (`FUNDS_ALREADY_DISBURSED`) |
| 6 | Concurrent duplicate dispute prevention | **PASS** | Concurrent `Promise.all` opens -> 1 succeeded, 1 rejected (`P0001` / `DISPUTE_ALREADY_ACTIVE`) |
| 7 | New eligible dispute after `release_to_seller` | **PASS** | Legacy `order_disputes_order_id_key` dropped; 6 sequential open → `release_to_seller` cycles succeeded on the same order |
| 8 | Private evidence upload, existence, MIME, size & count limits | **PASS** | `dispute-evidence` bucket `public=false`; missing storage object rejected (`EVIDENCE_OBJECT_NOT_FOUND`); >5 files rejected (`TOO_MANY_EVIDENCE_FILES`); invalid MIME & >5 MB rejected; real JPEG uploaded & accepted |
| 9 | Unauthorized evidence access & signed URL denied | **PASS** | Public URL returned HTTP `400`; non-participant (`sellerBClient`) `createSignedUrl` denied; authorized server signed URL returned HTTP `200` |
| 10 | Seller response ownership & buyer evidence protection | **PASS** | Wrong seller (`sellerBClient`) denied (`42501`); Seller A response + uploaded photo recorded while buyer `description` & `evidence_paths` remained intact |
| 11 | Admin-only review & resolution | **PASS** | Active admin (`buyu.platform@gmail.com`) moved dispute to `under_review` and resolved; members denied (`42501`) |
| 12 | Admin-only columns inaccessible to members | **PASS** | Member `SELECT` on `admin_notes`, `under_review_by`, `resolved_by` denied (`42501`, `42501`, `42501`) |
| 13 | Independent unified seller order freezing | **PASS** | Disputing Seller A child froze only Child A (`disputed`); Seller B sibling stayed `paid` |
| 14 | Concurrent dispute vs handover/completion | **PASS** | `Promise.all([open_order_dispute_atomic, verify_order_pickup_pin_atomic])` serialized cleanly (`previous_order_status='paid'`, handover returned `order_disputed`) |
| 15 | Correct restoration of `paid`, `handed_over`, `completed` | **PASS** | `release_to_seller` restored `paid` -> `paid`, `handed_over` -> `handed_over` (did not skip buyer confirmation), `completed` -> `completed` |
| 16 | Full & partial refund proposals stay `pending_execution` | **PASS** | `partial_refund` (`500` sen) and `full_refund` (`1500` sen) both set `refund_execution_status='pending_execution'`, `orders.status='disputed'`, `refund_ref=NULL` |
| 17 | Repeated refund prevention | **PASS** | Re-opening dispute or confirming receipt on a `pending_execution` order blocked (`DISPUTE_ALREADY_ACTIVE`, `order_disputed`) |
| 18 | Accurate frozen earnings calculations | **PASS** | `computeSellerFinancials`: `frozenDisputeSen=[1470, 1960]`, `availableForPayoutSen=[0, 0]` while pending execution |
| 19 | Direct dispute & payout writes denied | **PASS** | Member `INSERT` on `order_disputes` (`42501`) and `payout_requests` (`42501`) denied |
| 20 | Phase 6B/6C regression checks | **PASS** | `release_expired_cart_orders()` & `release_expired_offer_reservations()` healthy; `orders.pickup_pin` denied (`42501`) |
| 21 | Exact QA DB & storage cleanup | **PASS** | `0` diffs across all 13 tables; `0` leftover objects in `dispute-evidence`; all preserved orders untouched |

---

## Baseline vs After Row Counts (Exact 0-Diff Cleanup)

| Table | Baseline | After QA | Diff |
|---|---:|---:|---:|
| `listings` | 4 | 4 | 0 |
| `listing_variants` | 0 | 0 | 0 |
| `cart_items` | 1 | 1 | 0 |
| `conversations` | 2 | 2 | 0 |
| `offers` | 0 | 0 | 0 |
| `checkout_sessions` | 1 | 1 | 0 |
| `orders` | 8 | 8 | 0 |
| `order_items` | 8 | 8 | 0 |
| `payments` | 6 | 6 | 0 |
| `payment_transaction_registry` | 3 | 3 | 0 |
| `order_disputes` | 0 | 0 | 0 |
| `payout_requests` | 0 | 0 | 0 |
| `notifications` | 27 | 27 | 0 |
| `storage: dispute-evidence` | 0 | 0 | 0 |

---

## Short Buyer / Seller / Admin Manual UI Test Instructions

Start local server: `cd "C:\FYP VAANI\Buy-U-v2"` → `node node_modules/next/dist/bin/next start -p 3000`.

1. **Buyer (`/orders`) — `examiner.staff@ums.edu.my`:**
   - Click **Report a Problem** on an eligible order → choose a reason, enter 20+ char description, upload 1–2 photos, tick confirmation, click **Submit Dispute**.
   - Verify `DSP-...` badge, 3-step timeline (`Opened`), private photo link opens, and order status becomes **Disputed**.
2. **Seller (`/seller/disputes` & `/seller`) — Seller account for that order:**
   - Verify `/seller` shows the disputed order's net amount under **Frozen (Disputes)** (not in Available for Payout).
   - Open `/seller/disputes` → review buyer complaint & photo → submit seller explanation + photo → verify buyer complaint/photo cannot be altered and no resolve button exists.
3. **Admin (`/admin`) — Sign in at `/admin/login` as `buyu.platform@gmail.com`:**
   - Find the `DSP-...` case via filter/search → view buyer & seller private photos → add internal admin notes → click **Mark Under Review**.
   - Test **Record Resolution** (`Release to Seller` restores pre-dispute stage; `Full Refund` / `Partial Refund` displays `Pending Refund Execution (Phase 6D.2)` and keeps earnings frozen).
   - Verify internal admin notes are NOT visible on Buyer `/orders` or Seller `/seller/disputes`.
