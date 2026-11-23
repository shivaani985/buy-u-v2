# Phase 4A — Product Details, Favourites & Add to Cart Acceptance

## Scope Implemented

1. **Product Detail Page (`/listings/[slug]` + `/listing/[id]` redirect)**
   - Interactive multi-photo gallery (prev/next controls, thumbnail selector, photo counter, clean neutral fallback).
   - Dynamic RM pricing (`formatSenToRm`), plain-text stock and listing status (`Available`, `Out of Stock`, `Archived`, `Draft`, `Accepting Requests`, `Free Campus Giveaway`) with zero colored pills or gradients.
   - Description, notes/limitations, condition, collection area, category, posted date, and Campus Food details (`availability_mode`, `preorder_close_at`, `pickup_window_start`/`end`, `pickup_note`, `food_notes`) when `is_food = true`.
   - Campus Seller / Storefront card (`shop_name`, `description`, `logo_path`, verified badge, faculty).
   - Compatibility redirect from `/listing/[id]` to `/listings/[id]`.

2. **Persistent Favourites (`public.favourites`)**
   - Server action `toggleFavouriteAction(listingId)` in `src/app/listings/actions.ts`.
   - Enforces authenticated, email-verified, active Student/Staff/Admin ownership (`user_id = session.profile.id`) via RLS.
   - Blocks demo listings, free notices (`free_notices` has no FK in `favourites`), and adding new favourites on non-published listings; still allows removing an already-saved favourite if a listing is later archived.

3. **Add to Cart (`public.cart_items`)**
   - Server action `addToCartAction` in `src/app/listings/actions.ts`.
   - Enforces server-side authorization and authoritative DB checks on `listings`, `listing_variants`, and existing `cart_items`:
     - Allows active verified Students, Staff, and Admins; blocks guests, unverified, and restricted accounts.
     - Blocks self-purchase (`buyerUserId === listing.seller_id`) and shows owner notice + `Edit Listing` link to `/sell/[id]`.
     - Blocks non-published (`draft`, `archived`, `removed`), non-physical (`service`, `free`), out-of-stock, and reserved-stock overflow (`quantity - reserved_quantity`).
     - Validates active variant membership when `has_variants = true` and rejects stray/invalid/inactive variant IDs.
     - Merges duplicate `(user_id, listing_id, variant_id)` rows in `cart_items` while enforcing `existingCartQty + requestedQty <= availableStock`.
     - Revalidates `/`, `/marketplace`, and `/listings/[id]` + refreshes router so the global navbar Cart badge (`src/lib/header-counts.ts`) updates immediately.

## Automated & Read-Only Verification Results

- **TypeScript (`npx tsc --noEmit`):** PASS (0 errors)
- **ESLint (`npm run lint`):** PASS (0 errors, 0 warnings)
- **Unit Tests (`node --test`):** PASS (29/29 passing across `auth-regression`, `seller-foundation`, `listing-edit`, and `buyer-shopping`)
- **Production Build (`npm run build`):** PASS
- **Read-Only Browser QA (`http://localhost:3000`, 0 hosted writes):**
  - Demo listing (`/listings/demo-101?demo=1`): PASS — 0px overflow at `1440px`, `390px`, `320px`; 0 console errors; demo Add to Cart & Favourite disabled.
  - Owner view + redirect (`/listing/2990db4c-11d6-4ec9-b4dd-5209a80ed74f` → `/listings/2990db4c-11d6-4ec9-b4dd-5209a80ed74f`, `examiner.seller@iluv.ums.edu.my`): PASS — "This is your listing" + `Edit Listing` link, no Add to Cart button, 0px overflow, 0 console errors.
  - Staff buyer view (`examiner.staff@ums.edu.my` on `IOT Box`): PASS — `RM 15.00`, plain-text `Out of Stock`, Add to Cart disabled, `Add to Favourites` enabled (not clicked), plain-text metadata with no colored pills, 0px overflow at `1440px`, `390px`, `320px`, 0 console errors.

## Live Hosted Write Acceptance (Pending Owner Approval)

No live Supabase writes were performed during Phase 4A. Once approved by the owner, isolated live write verification will test:
1. `examiner.buyer@iluv.ums.edu.my` and `examiner.staff@ums.edu.my` toggling Favourite on a temporary in-stock QA listing (or `IOT Box`) with refresh persistence and cleanup.
2. `examiner.buyer@iluv.ums.edu.my` adding a temporary in-stock physical listing (and variant) to `cart_items`, verifying duplicate-item merging, stock cap enforcement, navbar Cart badge increment, and full cleanup of test `cart_items`, `favourites`, and temporary QA listing.
