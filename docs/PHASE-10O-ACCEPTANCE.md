# Phase 10O manual acceptance

Use the ToyyibPay sandbox only. These checks are pending owner acceptance.

## Before applying the migration

- Open a paid order. The buyer sees the acknowledgement-gated PIN with wording about legacy receipt confirmation. The seller sees **Verify PIN**. Existing `handed_over` orders can still be completed by their buyer.
- In a hosted SQL editor session, run [the rollback-only verification](sql/phase-10o-unified-order-completion.verify.sql). Confirm that it reaches the pass notice and rolls back, with no synthetic fixtures retained.
- Review and apply [the standalone migration](sql/phase-10o-unified-order-completion.sql) separately. Confirm the application detects the new hosted capability before attempting F03–F05. Do not rerun historical migrations.

| Test | Owner steps and expected result |
| --- | --- |
| F01 / Buyer My Orders | Create a shared checkout with more than one seller and both a product and a service. Confirm it appears once in To Pay and in each matching type or seller/item search, with one RM1 fee, one Pay Now button and the full checkout total. Check the item snapshots and filter counts. Open Details and return with status, type, search and sort preserved. |
| F02 / Seller Orders | Check compact cards, applicable tabs, counts, Contact Customer and the owning seller's detail route. Open **Complete Order** and check keyboard focus, Escape, validation and lockout feedback. Trying another seller's order URL must fail. |
| F03 / Physical completion | Verify sandbox payment, then confirm the product child appears separately as Awaiting Collection. On buyer details, verify the PIN starts masked. Try Reveal before acknowledgement, then reveal, hide and copy after acknowledging. Untick the checkbox and verify the PIN clears. As the seller, submit an incorrect value then the correct one. The order goes directly to Completed. |
| F04 / Service completion | Verify the service child appears separately as Awaiting Service. Check service mode, requirements and private files. Confirm a different account cannot use the attachment proxy. Complete the service through the same PIN flow. |
| F05 / Unified and legacy | Confirm repeat PIN submission leaves the completion timestamp and deadline unchanged. Confirm a legitimate pre-migration `handed_over` order completes through buyer confirmation without a second PIN. Try receipt confirmation on a new paid order and verify it fails. Check PIN absence on both lists, payment return and seller details. |
| F06 / Protection and earnings | Compare the stored expiry against the buyer and seller pages. A new completion gets 72 hours and historical seven-day deadlines are retained. Before expiry, verify eligible dispute reporting and unavailable withdrawal. After expiry, check the adjusted and unallocated seller balance. |
| F07 / Reviews | Submit a verified purchase review after completion. Check the existing review, edit path and seller reply. Try a duplicate review and an ineligible order. |
| F08 / Refunds and disputes | Report a problem before and after completion where policy permits. Verify private evidence, seller response and financial holds. Check full and partial sandbox refunds, conditional returns and product restocking. Service refunds cannot require physical returns or restock. A partial refund restores the prior state without changing the completion time or protection deadline. |

## Payment and layout checks

- Observe the five-minute countdown warning and expiry. Confirm expired checkouts move to Cancelled, the action disappears, and a stale payment resume fails on the server. A valid resume reuses the existing bill.
- For a sandbox late-payment case, verify the checkout appears under Refund & Dispute as **Payment under review**, with no Pay Now or fulfilment actions. A duplicate callback must neither create a second payment nor deduct stock twice.
- Confirm the successful payment return shows the total, reference, number of paid orders and shopping/order links. Arrange fulfilment through the order-linked conversation.
- Check the buyer and seller views at desktop and mobile widths, including the stock item previews, filter overflow, details layout, dialog buttons, focus order and reduced motion.

## Scope

Late payment detection and buyer-facing display are supported. Dedicated admin resolution remains deferred. The existing database jobs still release reservations on schedule. A reusable bill is checked with the gateway before the buyer is sent back to FPX. The scheduled database jobs do not make network calls and still release inventory when a gateway result is unavailable. A late or uncertain payment follows the existing reconciliation path.
