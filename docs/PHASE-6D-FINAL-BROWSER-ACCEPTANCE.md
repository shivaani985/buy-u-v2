# Buy-U Phase 6D — Final Automated Browser Acceptance Report (Gate C)

- **Date:** 2026-11-24
- **Target:** Production build running on `http://localhost:3000` connected to hosted `duwwlcpdidrxkixvflag`
- **Browser Passes:** 3 sequential authenticated sessions (Admin `buyu.platform@gmail.com`, Seller `examiner.seller@iluv.ums.edu.my`, Buyer `examiner.staff@ums.edu.my`)
- **Result:** **9/9 Scenarios Verified PASS** (7 live browser UI scenarios + 2 Gate B live PostgreSQL RPC scenarios C & G)
- **Console Errors:** `0` · **Broken Images:** `0` · **Horizontal Overflow (Desktop `1440×900` & Mobile `390×844`):** `0`

---

## Scenario Results
| Scenario | Scope | Verification Method | Result | Evidence |
| --- | --- | --- | --- | --- |
| **A** | Partial Refund (`DSP-2611-218ADE` / `BU-2611-C3CC55`, RM 5.00) | Live Browser (Admin + Buyer `/orders`) | **PASS** | `RFD-2611-872723` → `SIM-RFD-2611-872723-6108ED9C`; order restored to `paid`; persisted after reload |
| **B** | Full Refund + Restock (`DSP-2611-21DDF7` / `BU-2611-3CB12A`, RM 15.00) | Live Browser (Admin `/admin`) | **PASS** | `RFD-2611-19B70A` → `approved pending refund` → `SIM-RFD-2611-19B70A-974D0C79`, `approved restocked`, `pickup_pin` cleared |
| **C** | Return-Required Workflow & Food/Variant Restock Guards | Live Hosted PostgreSQL RPCs (Gate B Test 4) | **PASS** | Return gate blocks until seller confirms; food & duplicate items rejected; variant stock incremented once on success |
| **D** | Seller Bank Account (`/seller/bank`) | Live Browser (Seller `1440×900`) | **PASS** | Registered `CIMB Bank · ****7890` (`Account Details Validated`); persisted after reload; full account number never in DOM |
| **E** | Protection Reserve vs Matured Earnings (`/seller/withdrawals`) | Live Browser (Seller `1440×900`) | **PASS** | `Buyer Protection Reserve (72h)` = `RM 29.40`; aged synthetic fixture `Available for Withdrawal` = `RM 14.70` |
| **F** | Automatic Simulated Withdrawal (`/seller/withdrawals`) | Live Browser (Seller `1440×900`) | **PASS** | RM 10.00 partial withdrawal → `WDR-2611-10D997` / `SIM-TRF-2611-10D997-EA073762` without admin approval; Available `RM 4.70`; Paid Out `RM 10.00`; synthetic fixture cleaned up in Gate D |
| **G** | Failed Withdrawal & Exact Balance Restoration | Live Hosted PostgreSQL RPCs (Gate B Test 5) | **PASS** | Definitive failure restored reserved allocations once; retry Withdraw All succeeded |
| **H** | Admin Financial Overview, Reconciliation, Payments, Withdrawals & CSV | Live Browser (Admin `1440×900`) | **PASS** | All 12 KPIs rendered (`Executed Refunds` `RM 20.00`); 5/5 Reconciliation `PASS`; `/api/admin/financials/export` link present; `0` Mark Paid buttons |
| **I** | Visual, Responsive (`1440×900` & `390×844`) & Role Separation | Live Browser (Admin, Seller, Buyer) | **PASS** | Zero overflow on desktop & mobile; zero broken images; zero console errors; staff blocked on `/seller/bank` and `/admin`; zero sensitive data in DOM |

## Redacted Screenshots
- [01-admin-financials-refunds.png](screenshots/phase-6d/01-admin-financials-refunds.png) — Admin Financial Management (`/admin`, `1440×900`)
- [02-seller-withdrawals-mobile.png](screenshots/phase-6d/02-seller-withdrawals-mobile.png) — Seller Earnings & Withdrawals (`/seller/withdrawals`, `390×844`)
- [03-buyer-orders-refund.png](screenshots/phase-6d/03-buyer-orders-refund.png) — Buyer Orders Refund Visibility & Role Separation (`/orders`, `1440×900`)
