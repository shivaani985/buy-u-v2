# BUY-U V2 — PHASE 3B.1 HOSTED ACCEPTANCE PLAN
**Isolated Student Listing Lifecycle & `update_listing_atomic` Verification**

- **Project:** `C:\FYP VAANI\Buy-U-v2`
- **Supabase Project:** `duwwlcpdidrxkixvflag`
- **Execution Status:** **PREPARED — STOPPED BEFORE HOSTED WRITES (Awaiting Owner Approval)**

---

## 1. Local Payload vs Hosted `update_listing_atomic` Reconciliation

| Field / Rule | Hosted RPC Behavior | Local Implementation (Post-3B.1 Fix) | Status |
|---|---|---|---|
| **RPC Signature** | `update_listing_atomic(p_listing_id uuid, p_expected_updated_at timestamptz, p_payload jsonb, p_variants jsonb)` | Exact 4-parameter match in `src/app/seller/actions.ts` | **MATCH** |
| **Listing Payload (`p_payload`)** | `title`, `description`, `kind`, `is_food`, `category_id`, `condition`, `price_sen`, `quantity`, `collection_area_id`, `allow_offers`, `has_variants`, `option_groups`, `image_paths`, `rules_acknowledged`, `status`, `published_at` | Exact column-name match, integer `price_sen`, server-verified `seller_id` | **MATCH** |
| **Variant Deactivation (`p_variants`)** | Hosted RPC marks every submitted item in `p_variants` as `active = true` and deactivates omitted existing variants (`active = false`) | **FIXED:** `validateVariantsInput` now omits inactive (`active: false`) variants from `p_variants` (and sends `[]` when disabling variants), while blocking deactivation of any variant with `reserved_quantity > 0`. | **MATCH** |
| **Photo Limit** | Hosted RPC allows up to **5** photos (`array_length(image_paths, 1) <= 5`) | **FIXED:** Shared `MAX_LISTING_PHOTOS = 5` applied across `validation.ts`, `listing-edit.ts`, `actions.ts`, `SellListingForm.tsx`, and `EditListingForm.tsx`. | **MATCH** |

---

## 2. Isolated Student Hosted Test Plan (Zero Impact on `IOT Box`)

- **Test Account:** `examiner.buyer@iluv.ums.edu.my` (UID `17d414ce-8349-4dc2-bccd-94d9bd0ebc52`, isolated student account with 0 existing listings and 0 orders).
- **Protected Production Record:** `IOT Box` (`2990db4c-11d6-4ec9-b4dd-5209a80ed74f`, owned by `examiner.seller@iluv.ums.edu.my`) — **NEVER read for mutation, NEVER updated, NEVER deleted**; snapshot its `updated_at`, `quantity`, `status`, and `image_paths` before and after to prove 0 diff.

### Planned Mutations (In Order)
1. **Create Draft (`/sell`):** Insert 1 isolated test draft listing (`[QA-3B1] Test Calculator`, `status = 'draft'`, `price_sen = 2500`, `quantity = 2`, 1 uploaded PNG in `listings/<buyer_uid>/...`) + auto-initialize `storefronts` row for `examiner.buyer`.
2. **Edit & Publish (`/sell/[id]` → `update_listing_atomic`):** Update title, description, price (`RM 28.50` = `2850`), upload 2nd PNG + reorder cover photo, acknowledge rules, transition `draft` → `published`.
3. **Stock & Out-of-Stock (`/sell/[id]`):** Update `quantity` to `0`, confirm `status = 'published'` with `Out of Stock` display, then restore `quantity = 3`.
4. **Variants & Deactivation (`/sell/[id]`):** Enable variants (`Option Group: Edition`), create 2 active variants (`Standard` RM 25.00 qty 2, `Pro` RM 35.00 qty 3) → verify `has_variants = true`, `quantity = 5`, `price_sen = 2500`. Then uncheck `Pro` (`active = false`) → verify `Pro` is omitted from `p_variants`, persisted as `active = false` in `listing_variants`, and total stock updates to `2`.
5. **Concurrency Conflict (`update_listing_atomic`):** Submit an update with a stale `p_expected_updated_at` timestamp → verify RPC rejects cleanly and UI surfaces `"This listing was modified in another tab..."` without overwriting newer data.
6. **Refresh Persistence:** Hard-reload `/sell/[id]` and `/seller` → confirm all persisted values match DB state.
7. **Archive & Restore:** Transition `published` → `archived` (verify hidden from `/marketplace`), then `archived` → `draft`.

### Rollback & Cleanup (Deterministic)
After verification passes (or immediately on any failure):
1. Delete the created test PNG files from Storage bucket `listings` under `${buyer_uid}/...`.
2. Delete the test `listing_variants` rows for the created test `listing_id`.
3. Delete the single created test `listings` row (`id = testListingId`).
4. Delete the auto-initialized `storefronts` row for `examiner.buyer@iluv.ums.edu.my` (restoring its exact pre-test state: 0 listings, 0 storefronts).
5. Re-verify `IOT Box` (`2990db4c-11d6-4ec9-b4dd-5209a80ed74f`) snapshot is 100% identical before and after.
