# BUY-U V2 — PHASE 3A ACCEPTANCE REPORT
**Seller Foundation: Seller Hub, Storefront & Listing Creation**

- **Project:** `C:\FYP VAANI\Buy-U-v2`
- **Supabase Project:** `duwwlcpdidrxkixvflag` (Existing schema & RLS reused; zero migrations or schema changes)
- **Status:** **PASS — Implementation, Automated Tests & Read-Only Live Browser QA Complete**

---

## 1. Delivered Scope

| Route / Module | Summary |
|---|---|
| **`/seller`** ([page.tsx](file:///C:/FYP%20VAANI/Buy-U-v2/src/app/seller/page.tsx)) | Seller Hub displaying real listing counts (`Total`, `Published Live`, `Saved Drafts`, `Out of Stock`), live seller listings with status badges & detail links, Storefront summary (with idempotent one-click storefront initialization for first-time student sellers), masked Payout Setup status (`seller_payout_accounts`), and shared seller navigation. |
| **`/seller/storefront`** ([page.tsx](file:///C:/FYP%20VAANI/Buy-U-v2/src/app/seller/storefront/page.tsx)) | Create/edit storefront name (`2–60` chars), bio (`<=500` chars), optional logo upload (JPG/PNG/WebP `<=5 MB` to public `listings` bucket under `storefronts/<seller_id>/`), and live Public Storefront Preview card. |
| **`/sell`** ([page.tsx](file:///C:/FYP%20VAANI/Buy-U-v2/src/app/sell/page.tsx)) | Listing creation foundation supporting 4 listing types (`Pre-Loved Item`, `Student Business`, `Campus Food`, `Student Service`), live Supabase `categories` and `collection_areas`, exact string-parsed RM-to-sen conversion, quantity, condition, up to 4 photo uploads with live previews, campus rules acknowledgement, and explicit `Save as Draft` vs `Publish Listing` flows. Automatically initializes a student storefront if none exists (`onConflict: "seller_id"`, no duplicates). |
| **Permissions & Validation** ([validation.ts](file:///C:/FYP%20VAANI/Buy-U-v2/src/lib/seller/validation.ts), [actions.ts](file:///C:/FYP%20VAANI/Buy-U-v2/src/app/seller/actions.ts)) | Server-side enforcement: ONLY active, email-verified UMS Students (`university_role === "student"`, `status === "active"`) can sell. Staff and non-student Admin accounts are denied via `SellerGate` without destroying their session. All database writes scope `seller_id` strictly from the verified server session. Raw payout account numbers and DuitNow IDs are masked (`•••• 9123`) before leaving the server. |
| **Navigation Integration** ([SiteHeader.tsx](file:///C:/FYP%20VAANI/Buy-U-v2/src/components/layout/SiteHeader.tsx), [EditorialHero.tsx](file:///C:/FYP%20VAANI/Buy-U-v2/src/components/home/EditorialHero.tsx)) | Eligible Students route `Sell` → `/seller`, hero `Sell an Item` → `/sell`, and see `Seller Hub` inside the compact account dropdown. Staff never see `Sell` or `Seller Hub`. |

---

## 2. Automated Verification

- **TypeScript (`npx tsc --noEmit`):** PASS (0 errors)
- **ESLint (`npm run lint`):** PASS (0 errors, 0 warnings)
- **Unit & Regression Tests (`node --test scripts/auth-regression.test.mjs scripts/seller-foundation.test.mjs`):** PASS (16/16)
  - Verified Student vs Staff vs Admin vs Unverified vs Inactive vs Guest eligibility
  - Verified exact RM-to-sen conversion (including `19.99` → `1999`, rejecting negatives, >2 decimals, and >RM 50,000)
  - Verified storefront validation, draft vs publish restrictions, food/service kind mapping, payout masking, and image MIME/size validation
- **Production Build (`npm run build`):** PASS (Next.js 16.4.6 Turbopack)
- **Route Smoke Checks (`node scripts/smoke-check.mjs http://localhost:3000`):** PASS (14/14, including guest gate protection on `/seller`, `/seller/storefront`, `/sell`)

---

## 3. Live Browser QA & Screenshot Evidence

All screenshots captured from the live running app (`http://localhost:3000`) with **0 console errors**, **0px horizontal overflow**, and **zero hosted write mutations**:

| Screenshot | Viewport | Verified Behavior |
|---|---|---|
| `docs/uiux-redesign/phase-3a/screenshots/seller-hub-1440.png` | 1440×900 | Student Seller (`HazIq Hazim`) Hub: real counts (`1`/`1`/`0`/`1`), `IOT Box` listing row, `Active` storefront card, masked payout card (`Maybank`, `•••• 9123`, `Linked (Private)`). |
| `docs/uiux-redesign/phase-3a/screenshots/seller-storefront-1440.png` | 1440×900 | Storefront editor + live Public Storefront Preview matching Buy-U Campus Pop Editorial theme. |
| `docs/uiux-redesign/phase-3a/screenshots/sell-form-1440.png` | 1440×900 | 4 listing types, live Supabase categories & collection areas, RM price validation preview, photo upload, Draft & Publish controls. |
| `docs/uiux-redesign/phase-3a/screenshots/seller-hub-390.png` | 390×844 | Mobile Seller Hub layout (0px overflow). |
| `docs/uiux-redesign/phase-3a/screenshots/sell-form-320.png` | 320×568 | Small-mobile Create Listing layout (0px overflow). |
| `docs/uiux-redesign/phase-3a/screenshots/staff-blocked-1440.png` | 1440×900 | UMS Staff (`examiner.staff@ums.edu.my`): `Sell` hidden from navbar, direct `/seller` visit blocked with `Student-Only Selling Policy` gate while preserving Staff session. |

---

## 4. Live Write Acceptance Steps (Pending Owner Approval)

Per Phase 3A safety rules, no write mutations were executed against hosted Supabase during verification. When the owner approves live write testing:
1. Sign in as `examiner.buyer@iluv.ums.edu.my` (student without a storefront) and click **Initialize My Storefront** on `/seller` to verify automatic single-storefront creation in `public.storefronts`.
2. Update bio/logo on `/seller/storefront` and confirm Storage upload (`listings/storefronts/<uid>/...`) and reload persistence.
3. Submit a **Draft** listing on `/sell` and verify it appears under `Saved Drafts` on `/seller` (not on public `/marketplace`).
4. Submit a **Published** listing on `/sell` (with rules checked) and confirm it renders on `/marketplace` and `/listings/<id>`.
