# Phase 4C — Checkout UI & Order Preparation (`/checkout`) Acceptance

## Scope Implemented

1. **Checkout Review Page (`/checkout`)**
   - Added `src/app/checkout/page.tsx`, `src/components/checkout/CheckoutClient.tsx`, `src/lib/buyer/checkout.ts`, and read-only server revalidation action `src/app/checkout/actions.ts`.
   - Wired `/cart` Order Summary CTA in `src/components/cart/CartClient.tsx` to `"Proceed to Checkout"` (`/checkout`) when cart has eligible items and zero issues, and disabled (`"Resolve Cart Issues to Checkout"`) otherwise.
   - Displays clear 3-step plain-text checkout progress (`1. Shopping Cart / 2. Review & Campus Collection / 3. ToyyibPay FPX Payment (Coming Soon)`).
   - Preserves cart contents completely; includes `"Return to Cart"` links in both the header and Order Summary.

2. **Multi-Seller Order Preparation**
   - Reuses `getCartPageData` (`src/lib/buyer/cart-data.ts`) and groups cart rows into separate per-seller orders (`Order 1 of N`, `Order 2 of N`, ...) with storefront branding, verified badge text, plain-text readiness status (`Ready` / `Action Needed`), per-seller subtotals, and combined integer-sen subtotal.
   - Creates NO order rows, payment records, pickup PINs, or stock reservations.

3. **Campus Collection & Minimal Buyer Review**
   - Displays read-only verified buyer info from `session.profile` (display name, UMS email, Student/Staff role, faculty) and explicit `On-Campus Collection (UMSKAL)` fulfilment notice. No shipping/delivery options or unnecessary personal data requested.
   - Shows per-seller campus collection areas (`collection_areas`), plus food pickup windows, pickup notes, and food notes when present.
   - Provides an optional per-seller draft campus collection note (client-side preview only; no DB write).

4. **Server-Side Revalidation & Blocking Safeguards**
   - Revalidates authentication, Student/Staff buyer eligibility, cart ownership, `published` status, active variants, live stock (`quantity - reserved_quantity`), and current prices on page load and via read-only `"Refresh"` (`revalidateCheckoutAction`).
   - Detects price changes against initial checkout snapshots, unavailable/archived/sold-out/self-purchase items, and blocks untested food pre-orders (`availability_mode === "pre_order"`).
   - Displays ToyyibPay FPX payment section with `"ToyyibPay FPX Fee: Pending"` (no invented fees), `"Payment integration coming soon"`, and clearly disabled payment buttons.

## Automated & Read-Only Verification Results

- **TypeScript (`npx tsc --noEmit`):** PASS (0 errors)
- **ESLint (`npm run lint`):** PASS (0 errors, 0 warnings)
- **Unit Tests (`node --test`):** PASS (36/36 across `auth-regression`, `seller-foundation`, `listing-edit`, `buyer-shopping`, `cart`, and `checkout`)
- **Production Build (`npm run build`):** PASS
- **Smoke Check (`node scripts/smoke-check.mjs http://localhost:3000`):** PASS (15/15)
- **Read-Only Browser QA (`http://localhost:3000`, 0 hosted writes):**
  - Guest `/checkout`: PASS — sign-in gate (`/login?next=%2Fcheckout`), `0px` overflow at `1440px`, `390px`, `320px`, `0` console errors.
  - Student buyer (`examiner.buyer@iluv.ums.edu.my`): PASS — `/cart` → `"Proceed to Checkout"` → `/checkout`, verified step bar, Buyer & Campus Collection card (no shipping fields), Seller Order 1 of 1 (`HazIq Hazim`, `Cafe UMSKAL`, `Hirono`, `Qty 2 × RM 20.00`, `RM 40.00`, plain-text statuses), ToyyibPay FPX disabled preview, Order Summary (`ToyyibPay FPX Fee: Pending`, `Current Subtotal: RM 40.00`), read-only `"Refresh"` passed, `"Return to Cart"` preserved cart contents, `0px` overflow at `1440px`, `390px`, `320px`, `0` console errors.
  - Staff buyer (`examiner.staff@ums.edu.my`): PASS — empty `/checkout` state (`"No items ready for checkout"`), `0px` overflow at `1440px`, `390px`, `0` console errors.
