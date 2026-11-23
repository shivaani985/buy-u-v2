# Buy-U v2 — Phase 2 Authentication Acceptance Record

**Date:** 2026-11-23  
**Project Path:** `C:\FYP VAANI\Buy-U-v2`  
**Supabase Ref:** `duwwlcpdidrxkixvflag`  
**Database Mutations Performed:** None (`PROPOSED-REMEDIATIONS.sql` NOT executed)

---

## 1. Live Interactive Authentication & Catalog Verification

Tested against live local Next.js server (`http://localhost:3000`) connected to hosted Supabase project `duwwlcpdidrxkixvflag` via publishable/anon key + SSR cookies (zero RLS bypass, zero credentials logged).

| Flow / Check | Result | Observed Evidence |
|---|---|---|
| **Student Login** (`examiner.seller@iluv.ums.edu.my`) | **PASS** | Authenticated via `/login`, redirected to `/marketplace` with `"Live UMS Catalog: Connected as verified member (read-only)."` |
| **Live Supabase Catalog & Filters** | **PASS** | 11 real categories loaded; real published listing `"IOT Box"` (`RM 15.00`, `Cafe UMSKAL`, `Out of stock`) rendered with live Supabase Storage PNG (`HTTP 200`); search `"IOT"` + category `"Electronics & Gadgets"` matched; `"nonexistent-xyz"` showed accurate empty state |
| **Listing Detail & Public Privacy** | **PASS** | `/listings/2990db4c-11d6-4ec9-b4dd-5209a80ed74f` rendered `"IOT Box"`, `RM 15.00`, `Cafe UMSKAL`, `Out of stock`, public seller `"HazIq Hazim (Verified Student · FKI)"`, live image loaded; zero email/phone/matric leaked |
| **SSR Session Persistence & Account UI** | **PASS** | Session persisted across full page reload; `/account` displayed `UMS Student`, `Status: active`, `Email Verified`, read-only profile lock notice, and zero Admin links |
| **Admin Guard (Regular Student)** | **PASS** | Visiting `/admin` displayed `"Administrator Access Required"` without signing out the student; returning to `/marketplace` kept the active student session intact |
| **Student Sign Out** | **PASS** | Clicking Sign Out cleared SSR cookies; `/` returned to guest `"UMS Member Sign-In Required"` state |
| **Staff Login & Role Separation** (`examiner.staff@ums.edu.my`) | **PASS** | Authenticated via `/login`; `/account` displayed `Demo UMS Staff`, `UMS Staff`, `Status: active`, `Email Verified`, `"UMS Staff Buyer & Service Access"` (cannot sell), zero Admin links; Sign Out cleared session cleanly |
| **Admin Live Sign-In** (`admin@ums.edu.my`) | **BLOCKED** | Default password rejected (`"Invalid administrator credentials."`) — hosted project appears seeded with a custom `SEED_ADMIN_PASSWORD` not stored in `.env.local` |
| **Browser Console Errors** | **PASS** | 0 console errors across all flows |

---

## 2. Automated Verification Checks

| Check | Result | Evidence |
|---|---|---|
| `node --test scripts/auth-regression.test.mjs` | **PASS** | 7/7 unit tests passed (UMS domains, spoofed subdomains, open redirects, password rules, sen-to-RM, storage traversal) |
| `npx tsc --noEmit` | **PASS** | 0 TypeScript errors |
| `npm run lint` | **PASS** | 0 ESLint errors or warnings |
| `npm run build` | **PASS** | Next.js 16.4.6 production build succeeded (12 routes + `Proxy (Middleware)`) |
| `node scripts/smoke-check.mjs http://localhost:3000` | **PASS** | 11/11 route & redirect checks passed (`307 /admin -> /admin/login`, safe `/auth/callback`, 0 secret leaks) |

---

## 3. Remaining Blockers Before Phase 3

1. **Database Security Remediations (CRITICAL):** Owner must review and approve/execute [`docs/security/PROPOSED-REMEDIATIONS.sql`](./security/PROPOSED-REMEDIATIONS.sql) in Supabase SQL Editor (`profiles` column-level UPDATE & `offers` state transitions) before enabling profile editing or seller/offer mutations.
2. **Admin Live Sign-In:** Owner should verify `/admin/login` locally using the hosted `SEED_ADMIN_PASSWORD` for `admin@ums.edu.my`.
