# BUY-U V2 — PHASE 3B.1 HOSTED ACCEPTANCE REPORT
**Isolated Student Listing Lifecycle & `update_listing_atomic` Verification**

- **Project:** `C:\FYP VAANI\Buy-U-v2`
- **Supabase Project:** `duwwlcpdidrxkixvflag`
- **Test Account:** `examiner.seller@iluv.ums.edu.my` (`d3b398d8-9103-4bc2-84d3-6e0101b7659a`) — authenticated via publishable anon key (full RLS enforcement)
- **Execution Status:** **PASS — All 7 Hosted Lifecycle & Cleanup Steps Verified**

---

## 1. Real DB Constraint Findings Discovered & Aligned

Running against hosted PostgreSQL caught 4 real constraints that are now aligned in local validation & UI:
1. **`listings_kind_check`:** Allowed values are `'pre_loved'`, `'business'`, and `'service'` (mapped `'preloved'` → `'pre_loved'` in `validation.ts` and `listing-edit.ts`).
2. **`listings_price_sen_check`:** Minimum listing/variant price is `200` sen (`RM 2.00`), aligned across `validation.ts` and `listing-edit.ts`.
3. **`listings_description_check`:** Description must be at least 10 characters even for drafts.
4. **Variant scoping:** `update_listing_atomic` enables `has_variants = true` on `kind = 'business'` listings (`Student Business` / `Campus Food`); `EditListingForm.tsx` now scopes the variant panel accordingly.

---

## 2. Hosted Acceptance Evidence (All PASS)

| Step | Result | Observed Hosted Evidence |
|---|---|---|
| **1. Create `[QA-3B1]` Draft + Photo 1** | **PASS** | Created `id=0ee99f4c-5068-4bcc-a307-3c6a46c6ba81` (`status=draft`, `price_sen=2500`, 1 PNG uploaded to `listings/<seller_id>/...`). |
| **2. Edit, Reorder Cover Photo & Publish** | **PASS** | `update_listing_atomic` persisted `title="[QA-3B1] Updated Test Calculator"`, `price_sen=2850`, `qty=4`, `status=published`, and cover photo reordered (`[photo2, photo1]`). |
| **3. Stock Changes (Out of Stock & Restore)** | **PASS** | `quantity=0` persisted while `status=published`, then restored to `quantity=3`. |
| **4. Variants Add & Deactivation** | **PASS** | Created 2 active variants (`Standard` RM 25 / qty 2, `Pro` RM 35 / qty 3). Omitting `Pro` from `p_variants` deactivated `Pro` (`active=false` in `listing_variants`), kept `Standard` (`active=true`), and updated total `quantity=2`. |
| **5. Stale-Edit Rejection (Concurrency)** | **PASS** | Stale `p_expected_updated_at` rejected by RPC (`CONFLICT: This listing changed while you were editing. Please refresh and try again.`) and mapped cleanly via `mapAtomicUpdateError`. Listing title remained unchanged. |
| **6. Archive, Restore & Persistence** | **PASS** | `published` → `archived` → `draft` persisted cleanly on fresh authenticated read. |
| **7. Cleanup & Snapshot Integrity** | **PASS** | Verified `0` references in `order_items`, `cart_items`, `offers`. Deleted test `listing_variants`, test `listings` row, and both test PNGs from Storage. Confirmed `0` remaining `[QA-3B1]` rows. Before/after snapshots of `IOT Box` (`2990db4c-11d6-4ec9-b4dd-5209a80ed74f`), `storefronts`, and `seller_payout_accounts` matched 100% identically (`sellerListingCount: 1`). |

---

## 3. Regressions After Constraint Alignment

- `npx tsc --noEmit`: **PASS (0 errors)**
- `npm run lint`: **PASS (0 errors, 0 warnings)**
- `node --test scripts/auth-regression.test.mjs scripts/seller-foundation.test.mjs scripts/listing-edit.test.mjs`: **PASS (23/23)**
- `npm run build`: **PASS (2.7s)**
