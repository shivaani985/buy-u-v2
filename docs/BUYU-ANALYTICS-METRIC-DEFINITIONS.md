# Buy-U Analytics Metric Definitions

All metrics use exact integer sen for monetary calculations, Malaysian timezone (`Asia/Kuala_Lumpur`, UTC+8) for date windows, and authoritative payment verification (`isAuthoritativeOrderPaymentVerified`). No historical events are fabricated prior to activation.

| Metric | Source Tables | Calculation | Inclusion / Exclusion | Denominator / Edge Case | Role Access |
| --- | --- | --- | --- | --- | --- |
| **Gross Verified Product Sales** | `orders`, `checkout_sessions`, `payments` | `SUM(orders.subtotal_sen)` | Verified paid orders only; excludes unpaid/expired/cancelled and RM 1.00 FPX fee; never double-counts parent checkout vs child orders | N/A | Seller (own), Admin (all) |
| **Net Product Sales** | `orders`, `order_refunds` | `Gross Verified Sales - SUM(succeeded refund_amount_sen)` | Deducts executed (`succeeded`) simulated refunds only | N/A | Seller (own), Admin (all) |
| **Net Platform Commission (2%)** | `orders`, `order_refunds` | `SUM(commission_sen) - SUM(succeeded commission_reversal_sen)` | Excludes ToyyibPay RM 1.00 FPX fee (not platform profit) | N/A | Seller (own), Admin (all) |
| **Net Seller Earnings (Pre-Expense)** | `orders`, `order_refunds` | `SUM(seller_net_sen) - SUM(succeeded seller_deduction_sen)` | Explicitly labeled pre-expense (never called "profit") | N/A | Seller (own), Admin (all) |
| **Period Growth %** | Selected window vs equal-length prior window | `((current - previous) / previous) * 100` | MYT window boundaries (`7d`, `30d`, `90d`, `this_month`, `custom`) | Returns `null` (`N/A`) when `previous === 0` or `range === 'all'` | Seller, Admin |
| **Measured Active Users** | `profiles.last_active_at`, `orders`, `listing_views`, `service_requests` | Distinct user IDs with genuine recorded activity in window | NEVER counts dormant accounts merely because `profiles.status = 'active'` | Tracking begins at Phase 8F activation | Admin only |
| **Listing Views & Conversion %** | `listing_views`, `orders`, `order_items` | Daily deduplicated `(viewer_id, listing_id, view_day)` excluding seller self-views; `orders / uniqueViewers * 100` | Published listings only | `N/A` when `uniqueViewers === 0` | Seller (own), Admin (all) |
| **Student Business Sellers** | `listings`, `orders` | Distinct `seller_id` with `kind = 'business'` OR `is_food = true` | Strictly separated from one-off `pre_loved` sellers, `service` providers, and `free_notices` donors | N/A | Admin only |
| **Completed Donations & Units** | `free_notices`, `free_notice_claims` | `COUNT` & `SUM(quantity)` where `claim.status = 'collected'` | Excludes merely posted, requested, reserved, or cancelled claims; zero fabricated CO2/environmental estimates | N/A | Public aggregate, Admin |
| **Verified Rating** | `reviews` | `AVG(rating)` where `hidden = false` | Completed verified orders or completed service requests only | `null` ("No reviews yet") when `count === 0` — NEVER `5.0` | Public |
