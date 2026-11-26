# Phase 10R Reviews, Ratings & Repurchase Acceptance

## Database and rollout

1. In the hosted Supabase SQL editor (`duwwlcpdidrxkixvflag`), run [phase-10r-review-enhancements.verify.sql](sql/phase-10r-review-enhancements.verify.sql) as database owner first. Confirm `PHASE_10R_VERIFY_PASSED` and clean transaction `ROLLBACK` (zero test rows persist).
2. Review and apply [phase-10r-review-enhancements.sql](sql/phase-10r-review-enhancements.sql) alongside deploying the Phase 10R application code.
   - Reuses `public.reviews` (no new application tables) with additive `is_anonymous`, `image_paths`, `video_path`, `edited_at`, and `updated_at` columns.
   - General authenticated queries have no access to review buyer IDs, order IDs, service-request IDs, or Storage paths. Verify the rollback's buyer, seller, and outsider role assertions.
   - Anonymous cards show **Anonymous Buyer** and a generic avatar. Review text or media can still identify its author. Seller order details show only named, visible reviews. Review media URLs use the review ID and attachment index, with Storage locations kept server-side.
   - The owner RPC keeps the review ID, creation time, and omitted attachments. An explicit empty array removes photos and an empty video path removes the clip. Open or under-review disputes, fully refunded orders, and moderated reviews block edits.
   - The migration leaves historical snapshots intact. The order UI uses a saved photo first, then an exact linked offer or variation for missing values, then the listing cover. Older checkout code could save the cover directly. Phase 10V writes the variation/offer image when it exists at checkout.

## Review media

- The browser sends the bytes directly to the private `review-media` bucket under the member's staged path. The app receives only a JSON reference and downloads the staged bytes for size, file signature, and duration validation. Only its service client writes validated files. Review media is streamed through the app, including video range requests.
- Duration validation checks container headers and independently measures the audio/video packet timeline with Mediabunny. Invalid timelines, fragmented MP4, and WebM without supported finite duration metadata (including some live recordings) are rejected. Validation checks file structure and timing without decoding every frame.
- Successful and failed validations remove staged objects on a best-effort basis. A storage maintainer should periodically clean up aged staged objects and validated files left by removed attachments or abandoned drafts. During a review/upload maintenance window, pause submissions, edits and validation, allow in-flight requests to finish, and list private bucket objects older than 24 hours. Compare validated keys against every `reviews.image_paths` and `reviews.video_path` reference, including hidden reviews. Delete only aged staged objects and unreferenced validated objects via the Storage API. This cleanup is manual.

## Ratings and sold counts

Total sold sums units from completed, payment-verified orders and includes completed legacy service requests. Fully refunded orders are excluded and partially refunded completed orders remain counted.

## Owner checks

| Check | What to verify |
| --- | --- |
| R01 / Repurchase | On completed orders, click **Buy Again** (product) and **Book Again** (service). Confirm no auto-cart add/checkout occurs, live price/stock are used, valid variations preselect on `?variant=`, unavailable variations warn without silent substitution, and deleted/archived/sold-out/paused items show muted **Product Unavailable** / **Service Unavailable**. For multi-item completed orders, confirm per-item actions appear in Order Details. |
| R02 / Review form | Open **Rate & Review Purchase** from completed My Orders or Product Detail. Select 1–5 `#F4B400` stars and confirm hover/keyboard states & labels (`Very Poor` through `Excellent`), character validation (`5–1,000`), and duplicate prevention. |
| R03 / Review media | Upload up to 5 photos (<= 5 MB JPG/PNG/WebP) and 1 video (<= 20 MB, <= 30s MP4/WebM); verify progress bar, error/retry, removal, thumbnail lightbox navigation, click-to-play video (no autoplay), and that hiding a review in Admin blocks its media URLs. |
| R04 / Anonymous reviews | Submit with **Review anonymously** checked. Verify the fixed **Anonymous Buyer** label and generic avatar as a seller and unrelated member. Inspect HTML/network payloads for private IDs, names, profile photos, and Storage prefixes. |
| R05 / Named reviewer | Submit with anonymous unchecked and verify reviewer's profile photo (or initials fallback) and display name appear without exposing private matric/email data. |
| R06 / Rating & sold | Verify Scenario A (item rating), Scenario B (`Shop Rating` weighted seller fallback), and Scenario C (`Not rated yet`), and confirm **Total sold** ignores paid-not-completed / cancelled / fully refunded orders and sums multi-unit quantities. |
| R07 / Editing | Edit both recent and 45-day-old non-moderated reviews (`rating`, comment, media, anonymous toggle). Verify `Edited` badge appears, `created_at` & `id` stay intact, aggregates update cleanly without inflating count, and moderated (`hidden`) reviews cannot be edited. |
| R08 / Purchased images | Open completed/in-progress orders with distinct variation photos (e.g. Hawas Fire) on My Orders, Order Details, Seller Orders, and Disputes and confirm saved snapshots survive listing edits, including a saved cover. For missing snapshots, check that a different item or variation cannot supply the fallback. |
