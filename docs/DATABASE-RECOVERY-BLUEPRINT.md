# Buy-U v2 — Database Recovery Blueprint (Phase 1.5)

**Project Reference:** `duwwlcpdidrxkixvflag`  
**Host:** `https://duwwlcpdidrxkixvflag.supabase.co`  
**Inspection Date:** 2026-11-23  
**Mode:** Strictly read-only (zero schema changes, zero migrations, zero data writes)

---

## 1. Connection & Environment Verification

- `.env.local` exists in `C:\FYP VAANI\Buy-U-v2` and is excluded by `.gitignore`.
- `NEXT_PUBLIC_SUPABASE_URL` matches `duwwlcpdidrxkixvflag`.
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` uses Supabase's publishable key format (`sb_publishable_...`).
- Server-only secrets (`SUPABASE_SERVICE_ROLE_KEY`, `TOYYIBPAY_SANDBOX_SECRET_KEY`, `TOYYIBPAY_SANDBOX_CATEGORY_CODE`) are kept strictly out of browser code and client bundles.

---

## 2. Verified Database Schema (29 Definitions: 28 Tables + 1 View)

Verified via read-only PostgREST OpenAPI inspection:

`admin_audit_logs`, `admin_users`, `cart_items`, `categories`, `collection_areas`, `conversations`, `donation_spots`, `favourites`, `free_notices`, `listing_variants`, `listing_views`, `listings`, `member_blocks`, `messages`, `notifications`, `offers`, `order_disputes`, `order_items`, `orders`, `payments`, `payout_requests`, `profiles`, `public_profiles` *(view)*, `reports`, `reviews`, `seller_payout_accounts`, `service_requests`, `storefronts`, `user_category_interests`.

### Core Verified Columns & Foreign Keys

| Table / View | Verified Columns | Verified FKs / Notes |
|---|---|---|
| `categories` | `id`, `name`, `kind`, `icon`, `sort_order`, `active` | 11 active rows (`product` & `service`) |
| `listings` | `id`, `seller_id`, `kind`, `title`, `description`, `category_id`, `condition`, `limitations`, `price_sen`, `quantity`, `reserved_quantity`, `collection_area_id`, `allow_offers`, `has_variants`, `option_groups`, `is_food`, `availability_mode`, `preorder_close_at`, `pickup_window_start`, `pickup_window_end`, `pickup_note`, `food_notes`, `service_mode`, `accepting_requests`, `service_details`, `image_paths`, `rules_acknowledged`, `status`, `published_at`, `created_at`, `updated_at` | FKs: `seller_id -> profiles.id`, `category_id -> categories.id`, `collection_area_id -> collection_areas.id`. Money stored in integer `price_sen`. 1 published row (`IOT Box`, `1500` sen = RM 15.00). |
| `listing_variants` | `id`, `listing_id`, `option_values`, `price_sen`, `quantity`, `reserved_quantity`, `active` | FK: `listing_id -> listings.id` (0 rows currently) |
| `collection_areas` | `id`, `name`, `active` | 4 active rows (`Cafe UMSKAL`, `Kolej Kediaman Alpha`, `Kolej Kediaman Beta`, `Menara UMSKAL`) |
| `donation_spots` | `id`, `name`, `active` | 2 active rows (`Blok Alpha`, `Blok Beta`) |
| `free_notices` | `id`, `contributor_id`, `title`, `description`, `condition`, `quantity_note`, `spot_id`, `image_paths`, `already_placed`, `status`, `published_at`, `renewed_at`, `expires_at`, `created_at`, `updated_at` | FKs: `contributor_id -> profiles.id`, `spot_id -> donation_spots.id` (0 rows currently) |
| `storefronts` | `seller_id`, `shop_name`, `description`, `logo_path`, `created_at`, `updated_at` | PK/FK: `seller_id -> profiles.id` (1 row) |
| `public_profiles` *(view)* | `id`, `display_name`, `university_role`, `status`, `faculty`, `bio`, `avatar_url`, `masked_matric`, `created_at` | Public-safe view (4 rows). Excludes `email`, `phone`, `full_name`, `matric_number`, `restriction_reason`. |
| `profiles` | `id`, `email`, `university_role`, `status`, `restriction_reason`, `full_name`, `matric_number`, `display_name`, `phone`, `faculty`, `bio`, `avatar_url`, `created_at`, `updated_at` | Uses `status` (confirmed, NOT `account_status`). Private — never queried on public pages. |

---

## 3. Verified RPC Functions (6 Exposed)

- `update_listing_atomic(p_listing_id uuid, p_expected_updated_at timestamptz, p_payload jsonb, p_variants jsonb)` — verified signature via OpenAPI.
- `is_active_admin()` — callable by `anon`, returns `false`.
- `is_active_member()` — callable by `anon`, returns `false`.
- `is_active_student()` — callable by `anon`, returns `false`.
- `mask_matric(...)` — present in schema (parameter name not exposed to anon without exact arg signature).
- `rls_auto_enable()` — present in schema.

*Unverified:* Full SQL bodies and `SECURITY DEFINER` / `EXECUTE` grants on `pg_proc` and `pg_policies` cannot be inspected over PostgREST without SQL/DB-admin introspection; marked unverified rather than assumed.

---

## 4. Storage Buckets (6 Verified)

- **Public buckets (`public: true`):**
  - `listings` — stores listing photographs (`listings.image_paths`). Verified live object `d3b398d8-9103-4bc2-84d3-6e0101b7659a/763516c0-903e-41d1-b250-803908914f81.png` returns HTTP 200 `image/png`. Invalid paths return HTTP 400 and fall back cleanly in UI.
  - `free-items` — stores free notice photographs (`free_notices.image_paths`).
- **Private buckets (`public: false`):**
  - `chat-media`, `service-files`, `dispute-evidence`, `chat-attachments` — all 4 verified to reject public URL access (HTTP 400).

---

## 5. Critical RLS / Permission Finding (`anon` Role)

- **Observed Behavior:** All `SELECT` queries executed with `NEXT_PUBLIC_SUPABASE_ANON_KEY` (`anon` role) return PostgreSQL **`42501 permission denied`** on `categories`, `listings`, `listing_variants`, `collection_areas`, `donation_spots`, `storefronts`, `free_notices`, `public_profiles`, AND all private tables (`profiles`, `admin_users`, `orders`, `payments`, `messages`, `conversations`, `payout_requests`, `seller_payout_accounts`, `reports`, `member_blocks`, `admin_audit_logs`).
- **Security Impact:**
  - Private member data is strongly protected from unauthenticated access.
  - However, unauthenticated visitors also cannot read the public catalog (`categories`, `listings`, `collection_areas`, `public_profiles`) via the publishable key until either:
    1. Phase 2 UMS Authentication signs users in as `authenticated`, **OR**
    2. Owner explicitly approves read-only `GRANT SELECT` + `status = 'published'` RLS policies for `anon` on public catalog tables only.
- **App Handling:** Buy-U v2 strictly uses the publishable/anon key for catalog queries (never bypassing RLS with `SUPABASE_SERVICE_ROLE_KEY`), displays an honest `42501` status banner when blocked, never silently substitutes fake listings, and keeps Demo Mode strictly opt-in via `?demo=1`.
