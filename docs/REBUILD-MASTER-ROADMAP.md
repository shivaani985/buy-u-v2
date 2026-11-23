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
