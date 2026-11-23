# Buy-U v2 — Phase 1.5 Acceptance Record

**Date:** 2026-11-23  
**Project Path:** `C:\FYP VAANI\Buy-U-v2`  
**Supabase Ref:** `duwwlcpdidrxkixvflag`

---

## Verification Summary

| Check | Result | Details |
|---|---|---|
| `.env.local` verification | PASS | Exists, matches `duwwlcpdidrxkixvflag`, publishable key present, excluded from Git, no secrets logged |
| Schema & column verification | PASS | 29 definitions verified (`profiles.status`, `listings.price_sen`, `listings.image_paths`, `listings.kind`, `listings.status`, `categories.*`, `listing_variants.option_values`, `public_profiles`, `update_listing_atomic`) |
| Storage verification | PASS | 2 public buckets (`listings`, `free-items`) + 4 private buckets (`chat-media`, `service-files`, `dispute-evidence`, `chat-attachments`). Live listing PNG returned HTTP 200; private buckets returned HTTP 400 |
| Live unauthenticated catalog read (`anon`) | BLOCKED (RLS/Grant) | Supabase returned `42501 permission denied` for `anon` on `categories`, `listings`, `public_profiles`, etc. App displays honest status banner without silent demo fallback |
| Private table protection (`anon`) | PASS | All 11 tested private tables returned `42501 permission denied` for `anon`; `is_active_*` RPCs returned `false` |
| `npx tsc --noEmit` | PASS | 0 errors |
| `npm run lint` | PASS | 0 errors/warnings |
| `npm run build` | PASS | Production build succeeded on Next.js 16.4.6 |
| Route smoke tests (`scripts/smoke-check.mjs`) | PASS | 9/9 routes returned HTTP 200 (both live error state and explicit `?demo=1` preview), zero secret leakage |
| Browser verification | PASS | Verified live 42501 banner (no fake fallback) and explicit `?demo=1` catalog + filters + detail view with 0 console errors |
| Database safety | PASS | Zero mutations, zero schema/RLS changes, zero auth user creation |
