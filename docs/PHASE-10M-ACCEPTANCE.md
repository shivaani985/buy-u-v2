# Phase 10M Contextual Messaging Acceptance

Run the [rollback verifier](sql/phase-10m-contextual-messaging.verify.sql) as database owner on the target schema after the preceding accepted phases. Confirm `PHASE_10M_VERIFY_PASSED` and `ROLLBACK`. The verifier includes the exact [standalone migration](sql/phase-10m-contextual-messaging.sql) body. Run it before applying the standalone migration. Apply the standalone migration before rolling out the application changes.

Phase 10M keeps conversations, messages, notifications, offers, and attachments in their existing tables. It adds `messages.context_ref` and uses the existing message UUID for retry deduplication. Existing checkout-generated messages and historical messages keep their original contents. The chat reads snapshots through an authenticated participant RPC. Private Free Item photos are checked again through the existing private Storage policies when served.

Hosted Realtime previously published every message column. The migration explicitly publishes the existing message fields and keeps `context_ref` exclusively in the participant-authorized projection. Conversation, offer, and notification publication membership stays intact.

The hosted schema has no member UPDATE policy or message-edit RPC, and chat has no edit action. There is no member editing window to exercise in this baseline. The verifier checks that direct edits fail and that even a privileged writer cannot alter a sent reference.

Bargaining keeps unlimited proposals, 24-hour offer expiry, the 30-minute accepted reservation, and the full negotiation history. The hosted eligibility helper and chat allow Pre-loved and non-food Student Business listings with offers enabled. Seller create and edit forms enable offers only for Pre-loved listings. This discrepancy stays open for an owner decision on eligibility.

| Check | Owner acceptance |
|---|---|
| M01 Layout | Check the desktop inbox and chat at 1024px and wide desktop. On a phone, open a chat, back out, and return. Open the keyboard and send or attach a file. Check the header avatar, scroll, and horizontal overflow at narrow widths. |
| M02 Product and service | Open Chat Seller for a business product, pre-loved listing, food listing, or service. Reuse the same peer conversation. Check selected variant price/image and the general price range when no variant is selected. Confirm no greeting is sent on open. Try reference only, text plus reference, removing the reference, and text only. Older cards must stay unchanged. |
| M03 Orders | From buyer and seller order lists and details, open overall order summaries. From both details pages, open one exact purchased item. For a multi-item order, check the overall quantity and subtotal, and compare an individual card's title, image, historical price, and variation with the purchased item. Check buyer and seller links and verify that an unrelated account cannot open the order. |
| M04 Free Items | Use Chat with Donor, send the reference, and verify the private thumbnail and pickup location while active. Expire, remove, and hide synthetic posts. Revisit the chat and check the unavailable status and absence of restricted images and pickup details. |
| M05 Realtime and security | Use separate buyer, seller, and unrelated member sessions. Confirm one message and one recipient notification after rapid clicks or retry, preview wording, unread counts, refresh persistence, earlier history, and participant isolation. Inspect Realtime payloads for the safe message fields and confirm that references arrive through the participant projection. Interrupt a send and check that the draft reference, text, and files stay available. |
| M06 Bargaining and compatibility | Launch Make an Offer from a listing and an eligible draft or shared product card. Check the exact listing and variation, negotiation cards, counter/accept/reject, unlimited sequential proposals, 24-hour offer expiry, and the 30-minute checkout reservation. Exercise attachments, reporting and blocking. Confirm the established checkout notifications and greetings remain present. |

Previously seen pickup information cannot be recalled from a recipient. Open chat cards refresh their visibility on focus and periodically. The photo endpoint checks visibility on each request.
