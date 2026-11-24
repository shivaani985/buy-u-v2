# Buy-U v2 — Phase 7 Feature Audit, Requirement Traceability Matrix & Phase 10/11 Backlogs

- **Final Closure Date:** 2026-11-24
- **Hosted Supabase Project Verified:** `duwwlcpdidrxkixvflag`
- **Consolidated Migration Applied:** `docs/sql/phase-7-9-marketplace-completion.sql` (`SHA-256: 14FB991D3402A40A5544A128E31BEAF66E44E0D1E61CDFF895E5B83421D824CB`)
- **Acceptance Status:** **PHASES 7–9 CLOSED — ALL COMPULSORY GATES PASSED** (Gate A Migration **PASS**, Gate B Hosted PostgreSQL **19/19 PASS**, Gate C Automated Browser **21/21 PASS [A–U]**, Gate D Regression **94/94 PASS**, TypeScript/ESLint/Build **PASS** across 40 compiled routes).

---

## 1. Final Requirement Traceability & Acceptance Matrix

| Req ID | Module / Feature | Role(s) | Route / Component | Backend / DB Dependency | Pre-Audit Status | Final Acceptance Status | Evidence Ref |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **AUTH-01** | Registration & UMS Email Verification | Student, Staff | `/register`, `/login`, `/auth/callback`, `/forgot-password`, `/reset-password` | `auth.users`, `profiles`, `trg_profiles_guard_system_fields` | COMPLETE | **PASS** | Phase 1 + Gate B10.1 |
| **AUTH-02** | Separate Admin Portal Auth | Admin | `/admin/login`, `/admin` | `admin_users`, `is_active_admin()` | COMPLETE | **PASS** | Phase 6D + Gate C Pass 2/4 |
| **DISC-01** | Homepage & Marketplace Discovery | All | `/`, `/marketplace`, `/services`, `/free-items` | `listings`, `categories`, `free_notices` (`active`) | COMPLETE | **PASS** | Gate C Passes 1–5 |
| **DISC-02** | Product Details, Variants, Food & View Tracking | All | `/listing/[id]`, `/listings/[slug]` | `listings`, `listing_variants`, `favourites`, `listing_views` (`record_listing_view_atomic`) | COMPLETE | **PASS** | Gate B5 + Gate C Pass 1 |
| **CART-01** | Cart, Bargaining & Unified ToyyibPay Checkout | Buyer | `/cart`, `/checkout`, `/messages`, `/api/payments/toyyibpay/*` | `cart_items`, `offers`, `checkout_sessions`, `orders`, `payments` | COMPLETE | **PASS** | Phase 6B4 + Gate B9/B11 |
| **ORD-01** | Orders, Pickup PIN & 72h Buyer Protection | Buyer, Seller | `/orders`, `/seller/orders` | `orders` (`protection_expires_at` grant, `pickup_pin` private), `order_items`, `reviews` | COMPLETE | **PASS** | Gate B11 + Gate C Pass 2/6 |
| **FIN-01** | Disputes, Refunds, Returns, Bank, Withdrawals, Recon | Buyer, Seller, Admin | `/orders`, `/seller/disputes`, `/seller/bank`, `/seller/withdrawals`, `/admin` | `order_disputes`, `order_refunds`, `seller_payout_accounts`, `payout_requests`, `financial_execution_attempts` | COMPLETE | **PASS** | Phase 6D + Gate C Scenarios S & T |
| **SVC-01** | Services Marketplace & Off-Platform Workflow | Buyer, Seller | `/services`, `/requests`, `/seller/services` | `service_requests` (RPC-only, 48h `respond_by`, `expire_stale_service_requests_atomic`) | PARTIAL | **PASS** | Gate B1 (5/5) + Gate C A–C |
| **FREE-01** | Free Items & Community Donations | Student, Staff | `/free-items`, `/store/[sellerId]` | `free_notices` (`active`/`closed`/`hidden`), `free_notice_drafts`, `free_notice_claims`, `donation_spots`, `free-items` bucket | MISSING | **PASS** | Gate B2 (5/5) + Gate C D–F |
| **STOR-01** | Public Storefront & Logo/Banner Customization | Student, All | `/store/[sellerId]`, `/seller/storefront` | `storefronts` (`banner_path`, `business_info`, `is_open`), `listings` bucket (UID-first) | PARTIAL | **PASS** | Gate B3 + Gate C I |
| **REV-01** | Verified Purchase/Service Reviews, Edits & Replies | Buyer, Seller, Admin | `/orders`, `/requests`, `/seller/analytics`, `/store/[sellerId]`, `/admin` | `reviews` (RPC-only, column-level moderation privacy) | MISSING | **PASS** | Gate B4 (2/2) + Gate C G–H |
| **ANL-01** | Seller Business Analytics & CSV Export | Student Seller | `/seller/analytics`, `/api/seller/analytics/export` | Full paginated dataset (`listing_views` composite order, exact sen allocation) | PARTIAL | **PASS** | Gate B5 + Gate C J |
| **ANL-02** | Admin Platform Analytics & Student Entrepreneurship | Admin | `/admin`, `/api/admin/analytics/export` | Full paginated dataset (`verifiedCheckouts`, strict `kind='business'`, first-time business cohort) | MISSING | **PASS** | Gate B6/B7 + Gate C K–L |
| **MOD-01** | Reporting & Content Moderation | Member, Admin | `/admin`, `/store/[sellerId]` | `reports` (`admin_notes` hidden), `trg_listings_guard_admin_hidden` (`INSERT`/`UPDATE`/`DELETE`), idempotent restores | MISSING | **PASS** | Gate B8 (2/2) + Gate C M–N |
| **BLK-01** | Bidirectional Member Blocking | Member | `/store/[sellerId]`, `/account`, `/messages`, `/services`, `/free-items` | `member_blocks`, DB triggers + `is_order_payment_verified` active-order exception | MISSING | **PASS** | Gate B9 + Gate C O |
| **NTF-01** | Notification Bell, Unread Count, Inbox & Prefs | Member | `SiteHeader`, `/notifications`, `/account` | `notifications` (RPC-only), `update_notification_preferences_atomic`, mandatory donation alerts | PARTIAL | **PASS** | Gate B10 + Gate C P |
| **ACC-01** | Account Management & Suspension Enforcement | Member, Admin | `/account`, `/admin` | `profiles` (column-level UPDATE, `CANNOT_MODIFY_CLOSED_ACCOUNT`), trusted `last_active_at` | PARTIAL | **PASS** | Gate B8.2/B10 + Gate C Q |
| **ADM-01** | Administration Portal, Catalog Spots & Audit Logs | Admin | `/admin` | `admin_audit_logs` (`bigint` id, nullable `uuid`), `admin_toggle_catalog_item_atomic` | PARTIAL | **PASS** | Gate B8.2 + Gate C R |
| **POL-01** | App-Wide Visual Polish & Micro-Interactions | All | All routes | UI/UX polish only (zero missing functional features) | DEFERRED | **PHASE 10** | See Section 2 below |
| **OPS-01** | Deployment, Scheduled Workers & Public Webhook | Ops | Workers & Vercel/DNS | Hosted cron + HTTPS ToyyibPay webhook | DEFERRED | **PHASE 11** | See Section 3 below |
| **OOS-01** | Travel Ticket Commerce | N/A | None | Explicitly outside approved FYP scope | EXCLUDED | **OUT OF SCOPE** | N/A |

---

## 2. Final Phase 10 UI/UX Refinement Backlog (Polish Only — No Core Logic Missing)
Items surfaced directly from live Gate C browser walkthroughs (Passes 1–6) to polish in Phase 10:
1. **`/services` Request Modal Error Placement:** Render blocked/validation error banners inside the open service request modal rather than behind the backdrop (spotted in Pass 2 Scenario O).
2. **`/sell` Student Service Mode Selector:** Expose explicit `In Person` / `Remote` / `Both` selector and `Accepting Requests` toggle during initial service creation on `/sell` (currently defaults cleanly to `In Person` on create).
3. **`/free-items` Claim Quantity & Note Dialog:** Open a lightweight modal before submitting `Claim Free Item` when quantity > 1 so members can pick desired units and add a campus pickup note (currently submits qty 1 directly for fast 1-click UX).
4. **`/admin` Inline Moderation Reason Inputs & Dispute Return Toggle:** Allow admins to enter custom moderation reasons directly in the Reports/Users action rows (replacing default presets) and optionally pre-select `Require Physical Return` inside the Dispute resolution form in addition to the Refunds & Returns tab.
5. **App-Wide Visual Polish & Micro-Interactions:** Unified skeleton loaders, subtle transitions/hover polish, empty-state illustrations, and final Campus Pop typographic spacing consistency across desktop and mobile.

---

## 3. Final Phase 11 Operational & Deployment Backlog
Items intentionally carried forward from Phases 6–9 to Phase 11 production/FYP deployment:
1. **Scheduled Expiry & Financial Recovery Workers:** Schedule `node scripts/phase7-9-expiry-worker.mjs` (service request 48h & free-item reservation 48h expiry) and `node scripts/phase6d-recovery-worker.mjs` (interrupted simulated refund/withdrawal recovery) on a recurring cron (e.g., every 10–15 minutes via GitHub Actions, Supabase pg_cron + Edge Function, or Vercel Cron).
2. **Public HTTPS ToyyibPay Callback Verification:** Configure production/staging domain URL (`NEXT_PUBLIC_SITE_URL`), verify live public HTTPS webhook delivery to `/api/payments/toyyibpay/callback`, and confirm idempotent replay under public internet routing.
3. **Production Environment & Secret Hardening:** Provision `BUYU_BANK_ENCRYPTION_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `TOYYIBPAY_*`, and `BUYU_PAYMENT_ENV` cleanly in deployment host environment variables; confirm fail-closed guard prevents simulated financial execution if `BUYU_PAYMENT_ENV=production`.
4. **Release Readiness & Monitoring:** Final Vercel deployment smoke test, backup/restore verification, and FYP examiner demo runbook.
