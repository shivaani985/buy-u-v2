# Phase 10R Reviews, Ratings & Repurchase Acceptance

## Database and rollout

1. In the hosted Supabase SQL editor (`duwwlcpdidrxkixvflag`), run [phase-10r-review-enhancements.verify.sql](sql/phase-10r-review-enhancements.verify.sql) as database owner first. Confirm `PHASE_10R_VERIFY_PASSED` and clean transaction `ROLLBACK` (zero test rows persist).
2. Review and apply [phase-10r-review-enhancements.sql](sql/phase-10r-review-enhancements.sql) alongside deploying the Phase 10R application code.
   - Reuses `public.reviews` (no new application tables) with additive `is_anonymous`, `image_paths`, `video_path`, `edited_at`, and `updated_at` columns.
   - Creates private `review-media` bucket (`public = false`, 20 MB ceiling) and authenticated-staged RLS policies so moderated (`hidden = true`) media cannot bypass moderation via static URLs and anonymous `buyer_id` prefixes never appear publicly.
   - Revokes `SELECT` on `reviews.buyer_id` from `authenticated` and routes buyer order review lookups via `public.get_my_reviews_for_orders(uuid[])` / server projection.
   - Removes the legacy 7-day lock in `edit_verified_review_atomic` while preserving `id`, `order_id`, `listing_id`, `created_at`, `seller_response`, and `REVIEW_MODERATED` protections.
   - Backfills historical physical `order_items.image_path` ONLY where missing or previously defaulted to the listing cover while an offer/variant image exists.

## Behavioral notes & documented boundaries

- **Partial refunds in Total sold:** Total sold counts only completed (`status = 'completed'`), payment-verified transactions and sums purchased unit quantities (`order_items.quantity`) across all variations (plus completed legacy `service_requests`). Unpaid, pending, in-progress (`paid`, `ready_for_pickup`, `handed_over`), cancelled, expired, and fully refunded orders are excluded. Partially refunded completed orders remain counted because the transaction completed and no full return/cancellation occurred.
- **Server-side video duration inspection:** `/api/reviews/media` inspects staged upload magic bytes and parses MP4 (`moov/mvhd` timescale/duration) and WebM (EBML `Segment.Info.TimecodeScale` + `Duration`) headers purely in Node without requiring a native `ffprobe` binary. If an uploaded video lacks finite container duration metadata (for example some live browser `MediaRecorder` WebM streams), the server rejects it clearly rather than trusting client-side duration checks alone.

## Owner checks

| Check | What to verify |
| --- | --- |
| R01 / Repurchase | On completed orders, click **Buy Again** (product) and **Book Again** (service). Confirm no auto-cart add/checkout occurs, live price/stock are used, valid variations preselect on `?variant=`, unavailable variations warn without silent substitution, and deleted/archived/sold-out/paused items show muted **Product Unavailable** / **Service Unavailable**. For multi-item completed orders, confirm per-item actions appear in Order Details. |
| R02 / Review form | Open **Rate & Review Purchase** from completed My Orders or Product Detail. Select 1–5 `#F4B400` stars and confirm hover/keyboard states & labels (`Very Poor` through `Excellent`), character validation (`5–1,000`), and duplicate prevention. |
| R03 / Review media | Upload up to 5 photos (<= 5 MB JPG/PNG/WebP) and 1 video (<= 20 MB, <= 30s MP4/WebM); verify progress bar, error/retry, removal, thumbnail lightbox navigation, click-to-play video (no autoplay), and that hiding a review in Admin blocks its media URLs. |
| R04 / Anonymous reviews | Submit with **Review anonymously** checked. Verify public UI shows masked name (e.g. `S****m`) and generic anonymous avatar, and inspect HTML/network payload to confirm zero `buyer_id`, real display name, or real avatar URL exposure. |
| R05 / Named reviewer | Submit with anonymous unchecked and verify reviewer's profile photo (or initials fallback) and display name appear without exposing private matric/email data. |
| R06 / Rating & sold | Verify Scenario A (item rating), Scenario B (`Shop Rating` weighted seller fallback), and Scenario C (`Not rated yet`), and confirm **Total sold** ignores paid-not-completed / cancelled / fully refunded orders and sums multi-unit quantities. |
| R07 / Editing | Edit both recent and >7-day-old non-moderated reviews (`rating`, comment, media, anonymous toggle). Verify `Edited` badge appears, `created_at` & `id` stay intact, aggregates update cleanly without inflating count, and moderated (`hidden`) reviews cannot be edited. |
| R08 / Purchased images | Open completed/in-progress orders with distinct variation photos (e.g. Hawas Fire) on My Orders, Order Details, Seller Orders, and Disputes and confirm the purchased variation photo shows even after the listing is later edited. |
