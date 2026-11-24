# Buy-U Phase 6D.1 — Automated Browser End-to-End Acceptance Report

- **Date:** 2026-11-24
- **Origin:** `http://localhost:3000` (production Next.js build against hosted Supabase `duwwlcpdidrxkixvflag`)
- **Authorization:** Owner-authorized live browser E2E acceptance on `BU-2611-B1C075`, `BU-2611-C3CC55`, and `BU-2611-3CB12A`
- **External Gateway / Actual Refunds / Payouts:** `0`
- **Overall Result:** **ALL SCENARIOS PASS — PHASE 6D.1 CLOSED**

---

## Scenario Results

### Scenario A — Release to Seller (`BU-2611-B1C075` → `DSP-2611-AE63F2`) — **PASS**
- **Baseline:** `BU-2611-B1C075` `completed`; Seller A (`examiner.seller@iluv.ums.edu.my`) `Available for Payout: RM 29.40`, `Pending Settlement: RM 14.70`, `Frozen (Disputes): RM 0.00`.
- **Buyer (`examiner.staff@ums.edu.my`):** Tested empty-description validation (`"Please describe the issue in at least 20 characters."`), selected `Damaged or defective item`, uploaded private PNG (`Supporting Photos (1/5)`), submitted → status `Disputed`, `DSP-2611-AE63F2`, 3-step timeline (`Opened`), `Photo 1` signed redirect HTTP `200`. Sibling `BU-2611-C3CC55` stayed `Paid — Awaiting Handover`.
- **Seller A:** `/seller` updated to `Available for Payout: RM 14.70` (RM 14.70 frozen); `/seller/disputes` showed read-only buyer complaint, zero admin resolve controls; submitted explanation + `qa-seller-evidence.png` (`Seller Photo 1`).
- **Admin (`buyu.platform@gmail.com`):** Verified both `Photo 1` & `Seller Photo 1` returned HTTP `200`, added internal admin note, clicked **Mark Under Review** (`Under Review`), then **Release to Seller** → `Resolved`.
- **Post-Resolution Verification:** `BU-2611-B1C075` restored to `Completed`; Seller A `Available for Payout` returned to **`RM 29.40`**; internal admin notes verified absent (`false` in `innerText`, `innerHTML`, `page.content()`) on both Buyer `/orders` and Seller `/seller/disputes`.

### Scenario B — Partial Refund RM 5.00 (`BU-2611-C3CC55` → `DSP-2611-218ADE`) — **PASS (Preserved for Phase 6D.2)**
- **Buyer (`examiner.staff@ums.edu.my`):** Opened dispute (`Missing item or quantity`, private evidence photo) → `DSP-2611-218ADE`, `Disputed`.
- **Seller B (`examiner.buyer@iluv.ums.edu.my`):** `/seller` showed `Pending Settlement: RM 0.00`, `Frozen (Disputes): RM 19.60`; `/seller/orders` hid PIN handover form (handover blocked); `/seller/disputes` submitted explanation + private evidence photo.
- **Admin:** Recorded `Partial Refund Proposal` (`RM 5.00` = `500` sen) → `Resolved`, displaying `"Partial Refund Proposed (RM 5.00) — Pending Refund Execution (Phase 6D.2)"`.
- **Hosted DB State:** `orders.status = 'disputed'`, `refund_execution_status = 'pending_execution'`, `refund_ref = NULL`, Seller B `frozenDisputeSen = 1960` (`RM 19.60`), `availableForPayoutSen = 0`.

### Scenario C — Full Refund RM 15.00 (`BU-2611-3CB12A` → `DSP-2611-21DDF7`) — **PASS (Preserved for Phase 6D.2)**
- **Buyer (`examiner.buyer@iluv.ums.edu.my`):** Opened dispute (`Item not received / seller no-show`, private evidence photo) → `DSP-2611-21DDF7`, `Disputed`.
- **Seller A:** `/seller` showed `Frozen (Disputes): RM 29.40` (while A & C were both active); submitted explanation + private evidence photo on `/seller/disputes`.
- **Admin:** Recorded `Full Refund Proposal` (`RM 15.00` = `1500` sen) → `Resolved`, displaying `"Full Refund Proposed (RM 15.00) — Pending Refund Execution (Phase 6D.2)"`.
- **Hosted DB State:** `orders.status = 'disputed'`, `refund_execution_status = 'pending_execution'`, `refund_ref = NULL`, Seller A `frozenDisputeSen = 1470` (`RM 14.70`), `availableForPayoutSen = 2940` (`RM 29.40`).

---

## Additional Browser & Security Checks

| Check | Result | Evidence |
|---|---|---|
| Desktop (`1440×900`) & Mobile (`390×844`) layout | **PASS** | `0` horizontal overflow on `/orders`, `/seller/disputes`, `/admin` (`375px <= 390px`) |
| Console errors & broken images | **PASS** | `0` console errors, `0` broken images across all buyer, seller, and admin pages |
| Unauthorized `/admin` access by member | **PASS** | `examiner.staff@ums.edu.my` saw `"Administrator Access Required"` without losing session |
| Admin notes privacy | **PASS** | `QA_INTERNAL_ADMIN_NOTE` absent from DOM/HTML for Buyer 1 and Seller A |
| Preserved Phase 6D.2 refund cases & evidence | **PASS** | `DSP-2611-218ADE` (partial RM 5.00) & `DSP-2611-21DDF7` (full RM 15.00) preserved with 1 buyer + 1 seller private photo each |

---

## Captured Screenshots (Redacted / Zero PINs or Secrets)
- `docs/screenshots/phase-6d1/buyer-orders-resolved-1440.png`
- `docs/screenshots/phase-6d1/seller-b-disputes-1440.png`
- `docs/screenshots/phase-6d1/seller-a-disputes-resolved-1440.png`
- `docs/screenshots/phase-6d1/admin-disputes-resolved-1440.png`
