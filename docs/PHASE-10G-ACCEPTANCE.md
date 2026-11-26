# Phase 10G Free Items acceptance

## Database and rollout

1. In the hosted SQL editor, run [phase-10g-free-items-noticeboard.verify.sql](sql/phase-10g-free-items-noticeboard.verify.sql) as the database owner. Confirm the pass notice and rollback. The script uses synthetic members, posts, storage metadata and one legacy claim.
2. Review and apply [phase-10g-free-items-noticeboard.sql](sql/phase-10g-free-items-noticeboard.sql) separately. Switch the app to the Phase 10G code as part of the same release. The old publication RPCs are retired and the existing photo bucket becomes private.
3. Check the installed capability and grants with the read-only query below. Then complete G01–G04 using test accounts.

```sql
SELECT
  to_regprocedure('public.write_free_noticeboard_post(uuid,text,text,text,text,text[],boolean)') IS NOT NULL AS noticeboard_installed,
  NOT (SELECT b.public FROM storage.buckets b WHERE b.id = 'free-items') AS free_photos_private,
  NOT has_table_privilege('anon','public.free_notices','SELECT') AS guests_cannot_select_posts,
  NOT has_function_privilege('authenticated','public.create_free_notice_claim_atomic(uuid,integer,text)','EXECUTE') AS claims_retired,
  (SELECT count(*) FROM pg_tables WHERE schemaname = 'public') AS public_table_count;
```

Expected public table count at the inspected baseline is 37 before and after. The noticeboard uses `free_notices`, `profiles`, existing messaging and reporting, and the existing `free-items` storage bucket. `pickup_location` is explicit so older meeting instructions and spot references stay intact. Historical posts with unconfirmed locations stay undiscoverable until an owner supplies an exact location. Original publication and creation times remain intact on renewal.

`free_notice_claims`, `donation_spots` and `free_notice_drafts` remain for compatibility. They are candidates for a separate cleanup review after dependencies are retired. Phase 10G omits saved drafts from the live publishing form. At hosted inspection there were zero notices, claims or drafts and two donation spots.

## Owner checks

| Test | What to check |
| --- | --- |
| G01 / Catalogue | Sign out and open Free Items, home, marketplace search and a direct post link. The Free Items landing prompts sign-in and no post, photo or exact location appears. Sign in as eligible staff or student. Check case-insensitive title, description and location search, newest-first ordering, photo gallery, donor display name, FREE label, expiry, first-come-first-served notice, and mobile and desktop layouts. Inspect the guest and member responses for private matric data. |
| G02 / Publish and manage | As an eligible student, verify autofilled name and matric, optional description, custom location, and 1–5 JPG, PNG or WebP images at up to 5 MB each. Test upload progress, photo removal and rejecting an invalid file. Verify repeated submission creates one post. Edit it and confirm expiry stays fixed. Remove it and check that discovery stops while My Posts shows Removed. Staff and second-student attempts must fail where unauthorized. |
| G03 / Chat | Open Chat with Donor twice from the same post and check that one conversation is reused, with free item context and no automatically sent message. Confirm self-chat and blocked interactions fail. Remove or expire a post and confirm the existing conversation remains available. Collecting in person requires no app interaction. |
| G04 / Expiry and renewal | Use rollback verification or a local fixture to reach expiry without waiting. Check an expired card disappears on an open page, home and marketplace. Confirm the owner can see it, acknowledge availability, and renew the same post, photos and original creation time for exactly 72 hours. Confirm active, removed, moderated and non-owner renewals fail and repeated clicks do not extend twice. Check the existing conversation still opens. |

Admin moderation remains available. Free Items analytics report posts and contributors, with current active/expired counts and the number of posts renewed at least once. Physical pickup is outside the platform’s measurements.

Owner G01–G04 checks are pending.
