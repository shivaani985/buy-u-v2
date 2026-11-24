# Buy-U Phases 7–9 — Final Automated Browser Acceptance Report (Gate C)

- **Date:** 2026-11-24
- **Target:** Latest production build running on `http://localhost:3000` connected to hosted `duwwlcpdidrxkixvflag`
- **Browser Passes:** 6 sequential isolated authenticated browser sessions using authorized QA identities (`examiner.seller@iluv.ums.edu.my`, `examiner.staff@ums.edu.my`, `buyu.platform@gmail.com`) via authorized Supabase Auth magiclink callbacks (no password resets, no auth bypass)
- **Result:** **21/21 Scenarios (A–U) PASS** (100% live browser execution; zero RPC-only substitutions)
- **Unexpected Console Errors:** `0` · **Broken Images:** `0` · **Horizontal Overflow (Desktop `1440×900` & Mobile `390×844`):** `0`

---

## 1. Scenario Results (A–U)

| Scenario | Scope | Pass / Role | Result | Live Browser Evidence |
| --- | --- | --- | --- | --- |
| **A** | Student publishes service listing (`/sell` -> `/services`) | Pass 1 (Seller) | **PASS** | Published `[QA Gate C] Campus Poster Design` (RM 15.00, `qa-test-photo.png`); appeared live on `/services` |
| **B** | Staff submits service request with mode & MYT date (`/services` -> `/requests`) | Pass 2 (Staff) | **PASS** | Submitted `SVC-2611-94044E` (In Person, `2026-11-28T15:00`); persisted as `Requested` on `/requests` |
| **C** | Seller accepts → starts → delivers; Buyer confirms completion | Pass 3 (Seller) + Pass 5 (Staff) | **PASS** | `SVC-2611-94044E` transitioned `Requested → Accepted → In Progress → Delivered → Completed`, persisted after reload; notifications verified |
| **D** | Free item incomplete draft save, reload recovery, photo upload & publish | Pass 1 (Seller) | **PASS** | Saved draft `[QA Gate C] Free Engineering Notes` (no photos), recovered in `Saved Drafts (1)` after reload, uploaded `qa-test-photo.png`, published active |
| **E** | Member claims free item; Donor accepts reservation | Pass 2 (Staff) + Pass 3 (Seller) | **PASS** | Staff claimed `DON-2611-C5DC79` (`Requested`); Donor accepted (`Reserved`) |
| **F** | Donor records handover; Recipient confirms collection & Community Impact | Pass 3 (Seller) + Pass 5 (Staff) | **PASS** | `Reserved → Handed Over → Collected`; Community Impact incremented `0 → 1` completed donation & `0 → 1` unit donated only after `Collected` |
| **G** | Verified Purchase review + edit on `/orders` & Verified Service review on `/requests` | Pass 2 + Pass 5 (Staff) | **PASS** | Submitted 5★ review on `#BU-QA-REV01`, reloaded (`Verified Purchase`), edited to 4★ and persisted; submitted 5★ Verified Service review on `SVC-2611-94044E` on `/requests` |
| **H** | Seller public response & public storefront rating display | Pass 3 (Seller) | **PASS** | Replied on `/seller/analytics`; `/store/d3b398d8-...` displayed `4.0 (1 verified reviews)`, Verified Purchase review, and seller response |
| **I** | Storefront logo, banner, bio, hours & open status customization + privacy | Pass 1 + Pass 3 (Seller) | **PASS** | Caught & fixed storage path RLS bug (`${auth.userId}/storefront-...`); Pass 3 uploaded `qa-logo.png` & `qa-banner.png`, persisted after reload, rendered cleanly on public `/store/...` with zero private email/bank exposed |
| **J** | Seller Analytics KPIs, date filters, SVG trend, rankings, conversion & CSV | Pass 1 (Seller) | **PASS** | `30d` & `7d` KPIs, SVG Net Sales Trend, rankings, and `/api/seller/analytics/export?range=7d` HTTP `200` `text/csv` verified |
| **K** | Admin Platform Analytics KPIs, charts, date filters & CSV | Pass 4 (Admin) | **PASS** | `30d`/`7d`/`All` KPIs (Unified Checkouts / Orders, Sales, Commission, Services, Donations, Reports, Disputes), SVG charts, `/api/admin/analytics/export` HTTP `200` `text/csv` matching dashboard totals |
| **L** | Student Entrepreneurship Insights | Pass 4 (Admin) | **PASS** | Distinct Student Business Sellers (`2`), First-Time Business Sellers (`1`), Business Net Sales (`RM 70.00`), Business Earnings (`RM 68.60`), separate Pre-Loved/Services/Donations |
| **M** | Member submits report via real UI | Pass 2 (Staff) | **PASS** | Reported seller on `/store/...` -> created `RPT-2611-2CAB2A` |
| **N** | Admin resolves report, hides & restores listing with audit trail | Pass 4 (Admin) | **PASS** | Marked `RPT-2611-2CAB2A` resolved; hid `[QA Gate C] Campus Study Lamp` (`hidden`, persisted after reload) and restored to `published`; audited |
| **O** | Member blocks & unblocks another member via real UI | Pass 2 (Staff) | **PASS** | Blocked on `/store/...`, verified new service request blocked (`You cannot submit a request to this member.`), verified existing orders intact on `/orders`, unblocked on `/account` |
| **P** | Notification bell, unread count, inbox, read state & destination links | Pass 2 + Pass 5 (Staff) | **PASS** | Live header bell badge updated, `/notifications` listed real workflow alerts with working `View` links, `Mark Read` cleared unread count & bell badge |
| **Q** | Admin suspends & restores isolated synthetic QA account | Pass 4 (Admin) | **PASS** | Restricted `QA Suspend Target` (`qa.suspend.browser@iluv.ums.edu.my`) -> persisted `Suspended` -> restored `active`; established QA accounts untouched |
| **R** | Admin catalog toggle & audit log interface | Pass 4 (Admin) | **PASS** | Toggled `Blok Beta` inactive -> persisted -> active; all 7 admin moderation/catalog entries visible in `Audit Logs` |
| **S** | Phase 6 Return-Required Simulated Refund (isolated `#BU-QA-RET01`) | Pass 4 (Admin) + Pass 5 (Staff) + Pass 6 (Admin) | **PASS** | Created `RFD-2611-C544B4` (RM 12.00), enabled `Require Physical Return` (`Execute Simulated Refund` disabled), buyer reported return (caught & fixed `/orders` return-status UI display, verified in Pass 6), Admin confirmed return (`Resellable`), approved restock (`approved pending refund`), executed simulated refund (`SIM-RFD-2611-C544B4-7FB21EBD`, `succeeded`, `approved restocked`), stock verified incremented `3 → 4` |
| **T** | Phase 6 Failed Simulated Withdrawal + Balance Restoration + Retry | Pass 1 (Seller) | **PASS** | Registered synthetic `****0009` account -> RM 10.00 withdrawal failed (`WDR-2611-EA6CFB`, `failed`, no false success) & Available balance restored once at `RM 14.70` (caught & fixed client refresh on failure); switched to `****7890` -> RM 5.00 retry succeeded (`WDR-2611-0AB5ED`, `SIM-TRF-2611-0AB5ED-85F0E5A6`, Available `RM 9.70`) |
| **U** | Desktop `1440×900` & Mobile `390×844` Responsive, Role Separation & Security | Passes 1–6 | **PASS** | Zero horizontal overflow, zero broken images, zero console errors across Seller, Staff (7 mobile routes), and Admin desktop & mobile; Staff blocked on `/sell` & `/admin`; zero private data exposed |

---

## 2. Representative Redacted Screenshots
All screenshots verified free of tokens, raw bank account numbers, pickup PINs, or private emails:
- [01-seller-analytics-desktop.png](screenshots/phase-7-9/01-seller-analytics-desktop.png) — Seller Analytics (`/seller/analytics`, `1440×900`)
- [02-buyer-orders-verified-review.png](screenshots/phase-7-9/02-buyer-orders-verified-review.png) — Buyer Orders with Edited Verified Purchase Review (`/orders`, `1440×900`)
- [03-public-storefront-ratings.png](screenshots/phase-7-9/03-public-storefront-ratings.png) — Public Storefront with Verified Badge, Logo/Banner & `4.0` Rating (`/store/...`, `1440×900`)
- [04-admin-analytics-entrepreneurship.png](screenshots/phase-7-9/04-admin-analytics-entrepreneurship.png) — Admin Student Entrepreneurship Insights (`/admin`, `1440×900`)
- [05-free-items-community-impact.png](screenshots/phase-7-9/05-free-items-community-impact.png) — Free Items & Community Impact (`0 → 1` after Collected, `/free-items`, `1440×900`)
- [06-requests-mobile-390x844.png](screenshots/phase-7-9/06-requests-mobile-390x844.png) — Completed Service Request Mobile View (`/requests`, `390×844`)
- [07-admin-return-refund-restock.png](screenshots/phase-7-9/07-admin-return-refund-restock.png) — Admin Return-Required Refund Executed & Restocked (`/admin`, `1440×900`)
- [08-admin-refunds-mobile-390x844.png](screenshots/phase-7-9/08-admin-refunds-mobile-390x844.png) — Admin Refunds & Returns Mobile View (`/admin`, `390×844`)
