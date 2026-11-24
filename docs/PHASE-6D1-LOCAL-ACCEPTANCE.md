# Buy-U Phase 6D.1 — Disputes & Buyer Protection Local Acceptance Report

- **Date:** 2026-11-24
- **Scope:** Local implementation + incremental SQL migration proposal (`docs/sql/phase-6d1-disputes-buyer-protection.sql`)
- **Hosted DB Writes / ToyyibPay / Payouts / Push:** `0` (strictly local; awaiting owner SQL review)

---

## 1. Completed-Order Buyer Protection Window Policy
- **Paid (`paid`) & Handed Over (`handed_over`) orders:** Eligible for buyer dispute at any time (verified payment required; funds are in Pending Settlement).
- **Completed (`completed`) orders:** Eligible within **7 days of `completed_at`**, **ONLY IF** the seller's un-disbursed completed net balance (`SUM(completed seller_net_sen) - SUM(payout_requests WHERE status IN ('pending', 'paid'))`) covers `order.seller_net_sen`. If funds were already disbursed, `open_order_dispute_atomic` rejects with `FUNDS_ALREADY_DISBURSED`.
- **Phase 6D.4 Coordination Requirement (Documented):** When Phase 6D.4 introduces atomic seller withdrawal RPCs, withdrawals and disputes MUST coordinate using a shared seller-level lock (`SELECT ... FROM public.profiles WHERE id = seller_id FOR UPDATE`) and reserve sufficient funds for the 7-day completed-order buyer protection window. Direct client writes to `public.payout_requests` are temporarily revoked in Phase 6D.1 until Phase 6D.4 ships.
- **Blocked statuses:** `pending_payment`, `expired`, `cancelled`, `refunded`, already `disputed`, or orders with a `pending_execution` refund.

## 2. Implemented Components & Security Boundaries
- **SQL Migration Proposal:** `docs/sql/phase-6d1-disputes-buyer-protection.sql` (`STATUS: PROPOSAL ONLY`):
  - Reuses `public.order_disputes` and statuses (`open`, `under_review`, `resolved`), adds `dispute_code`, `reason_code`, `description`, `previous_order_status`, `seller_response`, `seller_evidence_paths`, `seller_responded_at`, `under_review_at`, `under_review_by`, `refund_execution_status`.
  - Partial unique index `idx_order_disputes_one_active_per_order` prevents concurrent duplicate active disputes.
  - Preserves direct client `INSERT`/`UPDATE`/`DELETE` REVOKE on `order_disputes` and revokes `SELECT` on admin-only columns (`admin_notes`, `under_review_by`, `resolved_by`) from `authenticated`/`anon`.
  - Four `SECURITY DEFINER` RPCs locking `orders` before `order_disputes`: `open_order_dispute_atomic`, `submit_seller_dispute_response_atomic`, `admin_mark_dispute_under_review_atomic`, `admin_resolve_order_dispute_atomic`.
  - `release_to_seller` restores `previous_order_status` without bypassing receipt confirmation; `full_refund`/`partial_refund` sets `refund_execution_status = 'pending_execution'` and keeps `orders.status = 'disputed'` (frozen) until Phase 6D.2 executes the refund.
  - Updates Phase 6C `verify_order_pickup_pin_atomic` and `confirm_buyer_order_receipt_atomic` to also block `pending_execution` refunds.
- **Private Evidence Storage:** `src/app/api/disputes/evidence/route.ts` (`POST` participant-only upload + `GET` participant/admin-only 300s signed URL on private `dispute-evidence` bucket; MIME/5 MB/5-file/path-ownership validation; zero public URLs).
- **Buyer Dispute UI (`/orders`):** Activated **Report a Problem** modal (6 reasons, 20–2,000 char description, up to 5 private photos, order summary, confirmation checkbox) + inline `DisputeDetailCard` (reference `DSP-...`, 3-step timeline, seller response, admin resolution).
- **Seller Dispute Hub (`/seller/disputes`):** Added `Disputes` tab to `SellerNav`, status filters, order summary, buyer complaint/evidence, and seller explanation + up-to-5-photo response form (cannot edit buyer evidence, resolve, or unfreeze).
- **Admin Dispute Management (`/admin`):** Integrated into the separate `is_active_admin()`-gated Admin Console with status filters, search, buyer/seller details, private evidence links, internal admin notes, **Mark Under Review**, and **Resolution Proposal** (`Release to Seller`, `Full Refund`, `Partial Refund`).
- **Financial Integrity (`src/lib/seller/financials.ts`):** Added `frozenDisputeSen` separately from `pendingSettlementSen` and `availableForPayoutSen`; pending-execution refunds remain frozen and are never falsely marked executed.

## 3. Local Verification Results
- `node --test scripts/*.test.mjs`: **73/73 PASS** (including 5 new Phase 6D.1 suites + all Phase 6B & 6C regressions)
- `tsc --noEmit`: **PASS** (0 errors)
- `npm.cmd run lint`: **PASS** (0 errors, 0 warnings)
- `next build`: **PASS** (`/orders`, `/seller/disputes`, `/admin`, `/api/disputes/evidence` built cleanly)
