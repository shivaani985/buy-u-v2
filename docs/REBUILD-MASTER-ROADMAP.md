# Buy-U v2 — Rebuild Master Roadmap

**Project:** Buy-U: A Community-Based University Marketplace for Student Commerce and Entrepreneurship  
**Institution:** Universiti Malaysia Sabah (UMS) — Kampus Antarabangsa Labuan (UMSKAL)  
**Target Supabase Ref (Existing):** `duwwlcpdidrxkixvflag`

---

## 1. Confirmed Architecture

- **Frontend:** Next.js 16 (App Router, Turbopack), React 19, TypeScript (strict), Tailwind CSS v4, Lucide icons.
- **Visual Direction:** Campus Pop Editorial — Purple `#4E2A84`, Teal `#00A3A6`, Blue `#1D70B8`, white & restrained neutral surfaces, Fraunces italic display + Plus Jakarta Sans body, flat angular geometry, no gradients/emojis/blobs.
- **Backend:** Next.js Server Components / Server Actions / Route Handlers + Supabase (PostgreSQL, Auth, Storage, Realtime).
- **Payments (Future):** ToyyibPay FPX Sandbox only (2% platform commission, RM1 FPX buyer fee). No live payments during development.
- **Hosting (Later):** Vercel (only after owner approval).

---

## 2. Database Integration Status

- **Current Status:** Not connected yet (no `.env.local` or live Supabase credentials configured on this laptop).
- **Safety Rule:** Existing Supabase project `duwwlcpdidrxkixvflag` (28 tables, Migrations 001–006) has NOT been modified, reset, or written to.
- **Fallback Behavior:** All public catalog routes run in explicitly labeled **Demo Data Mode** until read-only schema inspection confirms exact columns, RLS policies, functions, and storage buckets.

---

## 3. Implemented Modules (Phase 1)

- Project foundation (`C:\FYP VAANI\Buy-U-v2`), TypeScript strict config, ESLint, Tailwind v4, safe `.env.example`, `.gitignore`.
- Shared shell (`SiteHeader`, `SiteFooter`, loading, error, not-found, skip-to-content, reduced-motion CSS).
- Campus Pop Editorial homepage (`/`) with 7 required sections and 3 dedicated hero cutout asset slots (`public/images/home/student-1..3.png`).
- Read-only public marketplace (`/marketplace`) with URL-driven search, category, and listing type filters + empty state.
- Public listing detail page (`/listings/[slug]`) with RM pricing and honestly disabled Phase 4/5 actions.
- Supabase browser/server client utilities (`src/lib/supabase/*`) + read-only `/account` foundation status page.
- Automated route smoke check (`scripts/smoke-check.mjs`).

---

## 4. Development Phases & Missing Modules

| Phase | Scope | Key Dependencies |
|---|---|---|
| **Phase 1 (Done)** | Project foundation, Campus Pop Editorial homepage, read-only marketplace, Supabase client utilities | None |
| **Phase 2** | Live Supabase read-only schema audit (`duwwlcpdidrxkixvflag`), UMS email auth, Student/Staff role separation, profile setup, password recovery | Owner supplies `.env.local` (URL + anon key) & approves schema audit |
| **Phase 3** | Seller storefront, create/edit listings, variants, food ready-now/pre-orders, stock management, Supabase Storage uploads, favourites | Phase 2 Auth & verified `listings` / `storefronts` schema |
| **Phase 4** | Multi-seller cart, ToyyibPay FPX Sandbox, 2% commission + RM1 fee, atomic stock reservation, 6-digit pickup PIN, orders, payouts, disputes | Phase 3 + ToyyibPay Sandbox keys |
| **Phase 5** | Realtime private chat, attachments, Make Offer bargaining, service requests, block/unblock, notifications | Phase 2–3 + Supabase Realtime |
| **Phase 6** | Dedicated Admin portal (`admin_users`), moderation queues, reports, reviews, taxonomy management, audit logs, end-to-end QA | Phases 2–5 |

---

## 5. Testing & Security Requirements

- Every phase must pass `npx tsc --noEmit`, `npm run lint`, `npm run build`, route smoke tests, responsive checks (1792px, 1440px, 390px, 320px), keyboard/a11y checks, and console error inspection.
- Never expose `SUPABASE_SERVICE_ROLE_KEY` or payment secrets in `NEXT_PUBLIC_*` or browser code.
- Never derive student, staff, or admin privileges from editable client `user_metadata`.
- Never reset tables or rerun Migrations 001–006 against `duwwlcpdidrxkixvflag` without explicit approval.

## 6. Future Admin Payment Reconciliation

The orders experience detects and displays late ToyyibPay payments as **Payment under review**. Dedicated admin resolution, checkout activation and automatic refunds remain deferred.

- Add a Payment Reconciliation queue within Admin Financials.
- Re-verify the gateway transaction and validate the checkout and current inventory eligibility.
- Define safe activation of eligible late-paid checkouts and checkout-level refund resolution.
- Define multi-seller reconciliation and exceptional FPX fee refund policies.
- Notify affected buyers and sellers when a case is resolved and record admin actions in the audit log.

## 7. Phase 10G Free Items

Free Items is a campus giveaway noticeboard. Eligible students post photos and an exact pickup location. Eligible UMS students and staff can browse, collect directly on a first-come, first-served basis, and optionally open a donor conversation. Signed-out visitors see the landing page and a sign-in prompt.

Posts expire after 72 hours. Owners can edit or remove posts, or renew an expired post for another 72 hours after confirming availability. The Phase 8 donation and claim flow is historical. Its tables remain available for compatibility while the current app measures posts and contributors.

See [Phase 10G acceptance](PHASE-10G-ACCEPTANCE.md) for the migration and owner verification steps.

## 8. Phase 10R Reviews, Ratings & Repurchase

Phase 10R upgrades post-purchase trust, ratings accuracy, repurchase flows, and historical variation image fidelity without adding new database tables:

- Completed orders offer live-checked **Buy Again** (products, preselecting exact valid variation via `?variant=`) and **Book Again** (services), or muted **Product Unavailable** / **Service Unavailable** when deleted, archived, paused, or sold out.
- Verified review composer uses an accessible responsive modal/sheet with interactive 5-star `#F4B400` rating labels, optional photo/video attachments in private `review-media` storage, **Review anonymously** toggle (server-masked names + strict zero-PII/zero-`buyer_id` projection), and unrestricted editing on non-moderated reviews (`Edited` badge).
- Listing/service cards and detail pages distinguish item ratings from weighted **Shop Rating** fallback and **Not rated yet**, and compute **Total sold** strictly from completed, verified, non-fully-refunded unit quantities across variations.

See [Phase 10R acceptance](PHASE-10R-ACCEPTANCE.md) for SQL rollout, verification, and manual test steps.

## 9. Phase 10M Contextual Messaging

Chat uses one continuous conversation per member pair. Product, service, order, and Free Item references start as unsent composer drafts and stay with the specific messages they are sent on. The desktop layout uses an inbox and conversation pane. The mobile conversation keeps its composer within the visible viewport.

The migration adds one private JSONB column to existing messages and excludes it from Realtime publication. Bargaining retains unlimited proposals, 24-hour offer expiry, a 30-minute accepted reservation, and negotiation history. Run the rollback verifier and manual checks listed in [Phase 10M acceptance](PHASE-10M-ACCEPTANCE.md) before marking owner acceptance complete.

## 10. Phase 10F Campus Food

Campus Food supports acknowledged shelf-stable Packaged Food and single-event Pre-order Food. Food availability is checked at reservation time. Pre-order orders are grouped by seller, collection area, and identical collection window with an independent PIN per child order under one checkout.

**B09 owner acceptance is pending.** See [FOD01–FOD10 and rollback verification](PHASE-10F-ACCEPTANCE.md).
