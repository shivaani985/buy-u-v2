# Buy-U v2 — Phase 1 Acceptance Record

**Date:** 2026-11-23  
**Project Path:** `C:\FYP VAANI\Buy-U-v2`  
**Mode:** Read-Only Foundation (Demo Data Mode — Supabase not yet connected)

---

## Verification Results

| Check | Result | Evidence |
|---|---|---|
| `npx tsc --noEmit` | PASS | 0 TypeScript errors |
| `npm run lint` | PASS | 0 ESLint errors or warnings |
| `npm run build` | PASS | Next.js 16.4.6 (Turbopack) compiled & generated all routes (`/`, `/marketplace`, `/listings/[slug]`, `/account`, `/_not-found`) |
| Route Smoke Tests (`scripts/smoke-check.mjs`) | PASS | 7/7 routes returned HTTP 200 with expected content and zero secret key exposure |
| Browser Visual & Console Inspection | PASS | Homepage, `/marketplace`, and `/listings/casio-fx-570ex-scientific-calculator` rendered cleanly with Campus Pop Editorial palette (`#4E2A84`, `#00A3A6`, `#1D70B8`) and 0 console errors |
| Responsive Overflow (1792px, 1440px, 390px, 320px) | PASS | 0 overflowing elements and no horizontal scroll at all 4 widths |
| Keyboard Navigation | PASS | Skip-to-content and header links focus cleanly; brand logo focus ring tightened after QA review |
| Reduced Motion (`prefers-reduced-motion`) | PASS | Verified compiled CSS media query disables transitions/animations cleanly |
| Search & Filter Behavior | PASS | Verified `?q=calculator`, `?category=textbooks-notes`, `?type=service`, `?type=free` |
| Database Safety | PASS | Zero cloud writes; no credentials exposed; existing Supabase project `duwwlcpdidrxkixvflag` untouched |

---

## Known Phase 1 Limitations (Honest Scope)

- **Supabase not connected yet:** `.env.local` has not been provided; catalog runs in explicitly labeled Demo Data Mode.
- **Hero student cutouts:** 3 flat editorial placeholder frames await the owner's approved PNGs in `public/images/home/student-1.png` through `student-3.png`.
- **Disabled future controls:** Sell, Cart, Messages, Notifications, Add to Cart, and Make Offer controls are intentionally disabled until Phases 2–5.
