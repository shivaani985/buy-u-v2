# Phase 10F Campus Food acceptance

Run the [rollback verifier](sql/phase-10f-food-listings.verify.sql) as database owner against the accepted pre-10F schema. Confirm `PHASE_10F_VERIFY_PASSED`, the deferred constraints check, and rollback. Apply the [standalone migration](sql/phase-10f-food-listings.sql) before rolling out the matching application.

Packaged Food uses standard stock and requires an explicit seller acknowledgment. A legacy listing without either a valid pre-order schedule or that acknowledgment remains visible where existing visibility rules permit and stays unavailable for purchase until corrected. Acknowledgment records seller classification.

A Pre-order is one event. An active reservation or paid order locks the cutoff, area, and collection window. Manual closure stops new reservations and keeps existing payment deadlines. Paid units consume capacity permanently. A confirmed late-delivered payment can settle only while the original reservation survives and the server-verified ToyyibPay transaction is earlier than the checkout deadline. Other late payments use the existing review path. [ToyyibPay transaction API](https://toyyibpay.com/apireference/)

| Check | Owner verification |
|---|---|
| FOD01 Packaged | Publish acknowledged packaged food and exercise normal stock, checkout, and restock. Reject publishing without acknowledgment. |
| FOD02 Schedule | Publish a fresh food event with a future MYT cutoff and a later collection window. Check invalid and missing values and draft handling. |
| FOD03 Closure | Check time cutoff, permanent manual closure, temporary reservation exhaustion and reopening of available capacity before cutoff after unpaid release, and permanent paid exhaustion. Try editing or reopening closed events. |
| FOD04 Variations | Sell out one variation with another in stock. Check exact selection, price, and image. Test edits while reserved and after all paid capacity is exhausted. |
| FOD05 Discovery | Check home, marketplace, favourites, and direct listing URLs after cutoff or closure. Closed food remains visible in history. |
| FOD06 Cart | Edit an uncommitted event schedule and confirm the new terms in a stale cart. Combine valid and invalid lines, test partial checkout, and race buyers for remaining stock. |
| FOD07 Payment | In Sandbox, combine packaged food, physical products, services and two different pre-order windows. Check child orders, independent PINs, one bill and fee, immutable collection details, and late-payment review with missing evidence or released reservations. |
| FOD08 Security | Exercise ownership, direct API denial, concurrent inventory operations, no food offers, no restock of paid pre-order units, and ordinary packaged restock. |
| FOD09 Chat | Open Chat Seller with a selected variation. Verify an unsent reference, send it, and confirm its schedule remains historical while current availability changes. |
| FOD10 Layout | Check seller inputs and errors on desktop and mobile, including open and closed listing states. |

Owner acceptance is pending.
