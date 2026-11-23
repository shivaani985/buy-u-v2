# BUY-U V2 — PHASE 3B ACCEPTANCE REPORT
**Complete Listing Management: Edit, Variants, Inventory, Photos & Atomic Updates**

- **Project:** `C:\FYP VAANI\Buy-U-v2`
- **Supabase Project:** `duwwlcpdidrxkixvflag` (Existing `listings`, `listing_variants`, Storage `listings`, and `update_listing_atomic(...)` RPC reused; zero migrations or RLS changes)
- **Status:** **PASS — Implementation, 23 Unit Tests, 15 Smoke Checks & Read-Only Live Browser QA Complete**

---

## 1. Delivered Scope

| Area | Implementation |
|---|---|
| **Listing Edit Route (`/sell/[id]`)** | [src/app/sell/[id]/page.tsx](file:///C:/FYP%20VAANI/Buy-U-v2/src/app/sell/%5Bid%5D/page.tsx) + [EditListingForm.tsx](file:///C:/FYP%20VAANI/Buy-U-v2/src/components/seller/EditListingForm.tsx). Loads pre-filled listing details, live stock strip (`Status`, `Available Stock`, `Reserved Units`, `View Live`), type-specific fields (`Pre-Loved`, `Student Business`, `Campus Food`, `Student Service`), and connected `Edit` links from Seller Hub (`/seller`). |
| **Atomic Updates & Concurrency** | [updateListingAction](file:///C:/FYP%20VAANI/Buy-U-v2/src/app/seller/actions.ts) calls `supabase.rpc("update_listing_atomic", { p_listing_id, p_expected_updated_at, p_payload, p_variants })` with optimistic concurrency locking (`updated_at`) and safe user-facing conflict messaging ([mapAtomicUpdateError](file:///C:/FYP%20VAANI/Buy-U-v2/src/lib/seller/listing-edit.ts)). |
| **Inventory & Variants** | Full product variant manager for physical goods (`listing_variants`): 1–2 option groups, per-variant RM price & quantity, duplicate combination prevention, active/inactive toggle, aggregate total stock & minimum display price calculation. Server-side protection prevents reducing stock below `reserved_quantity`, prevents negative stock, and locks deletion of variants referenced by `order_items` or active reservations. |
| **Photo Management** | View existing photos, make cover (index 0), reorder left/right, remove from listing (without deleting Storage files potentially referenced by past orders), add up to 4 total photos (JPG/PNG/WebP `<= 5 MB`) with client previews, and automatic Storage cleanup of newly uploaded orphan files if the atomic RPC fails/rolls back. |
| **Status & Permissions** | Supports `Save as Draft`, `Save & Publish`, `Archive Listing`, and `Restore to Draft`; blocks editing moderation-removed listings. Strictly enforces verified active Student eligibility AND listing ownership (`seller_id === session.profile.id`) on both loader and server action. |
| **UI/UX Consistency** | Matches Phase 3A.2 Seller Hub dashboard (`#4E2A84`, `#00A3A6`, `#1D70B8`, white neutral cards, left purple accent strips, plain colored status text only — zero colored pills, zero gradients/emojis). |

---

## 2. Verification Results

- **TypeScript (`tsc --noEmit`):** PASS (0 errors)
- **ESLint (`npm run lint`):** PASS (0 errors, 0 warnings)
- **Unit & Regression Tests (`auth-regression` + `seller-foundation` + `listing-edit`):** PASS (**23/23**)
  - Covered UUID validation, status transitions, reserved-stock protection, variant uniqueness/locking/totals, 4-photo cap, archiving rules, and concurrency/permission error mapping.
- **Production Build (`npm run build`):** PASS (`/sell/[id]` registered cleanly)
- **Smoke Checks (`smoke-check.mjs`):** PASS (**15/15**, including guest protection on `/sell/2990db4c-11d6-4ec9-b4dd-5209a80ed74f`)
- **Live Read-Only Browser QA (`http://localhost:3000`, zero writes to `IOT Box`):**
  - Owner (`examiner.seller@iluv.ums.edu.my`): `Edit` link on `/seller` opens `/sell/2990db4c-11d6-4ec9-b4dd-5209a80ed74f` with pre-filled `IOT Box` fields, stock strip (`Out of Stock`, `0`, `0`), Cover photo controls, local variant toggle, **0px horizontal overflow** at `1440px`, `390px`, `320px`, and **0 console errors**.
  - Non-owner (`examiner.buyer@iluv.ums.edu.my`): direct access to `/sell/2990db4c-11d6-4ec9-b4dd-5209a80ed74f` blocked with `"Ownership Required"` / `"Cannot Edit This Listing"` (zero `IOT Box` data leaked).

---

## 3. Live Write Acceptance Steps (Pending Owner Approval)

Per safety rules, no hosted listings were modified during automated testing. Once the owner approves live write testing:
1. Create a test draft listing on `/sell` and edit it on `/sell/[id]` (title, RM price, quantity, photos, variants).
2. Verify `update_listing_atomic` persists edits and blocks a stale-tab concurrent save with the reload warning.
3. Verify `Archive Listing` hides the test listing from `/marketplace` and `Restore to Draft` restores it cleanly.
