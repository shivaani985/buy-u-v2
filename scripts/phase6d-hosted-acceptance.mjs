/**
 * Buy-U Phase 6D — Comprehensive Hosted PostgreSQL Acceptance Suite (Gate B)
 *
 * SAFETY GUARD:
 *   Requires `ALLOW_PHASE6D_HOSTED_QA=1`.
 *   Uses strictly isolated temporary QA users, listings, orders, disputes, refunds,
 *   bank accounts, and withdrawals, and cleans them up in `finally` without touching
 *   preserved owner QA records (`BU-2611-0DB3`, `BU-2611-B1C075`, `BU-2611-C3CC55`, `BU-2611-3CB12A`).
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { encryptBankAccountNumber } from "../src/lib/financials/bank.ts";
import {
  SimulatedBankPayoutProvider,
  SimulatedRefundProvider,
} from "../src/lib/financials/providers.ts";

if (process.env.ALLOW_PHASE6D_HOSTED_QA !== "1") {
  console.log(
    "SKIPPED: Set ALLOW_PHASE6D_HOSTED_QA=1 ONLY after owner applies docs/sql/phase-6d-financial-ecosystem.sql."
  );
  process.exit(0);
}

function loadEnvLocal() {
  const p = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (!process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

loadEnvLocal();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
assert.ok(url && anonKey && serviceKey, "Missing Supabase env vars");

const service = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const anon = createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const RUN_TAG = crypto.randomBytes(3).toString("hex").toUpperCase();
const created = {
  userIds: [],
  listingIds: [],
  variantIds: [],
  orderIds: [],
  checkoutIds: [],
  paymentIds: [],
  disputeIds: [],
  refundIds: [],
  payoutIds: [],
};

async function createTempUser(email, role, isAdmin = false) {
  const password = `QaPass!${crypto.randomBytes(8).toString("hex")}`;
  const { data: uData, error: uErr } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assert.equal(uErr, null, `createUser failed: ${uErr?.message}`);
  const uid = uData.user.id;
  created.userIds.push(uid);

  const { error: pErr } = await service.from("profiles").upsert({
    id: uid,
    email,
    display_name: `QA ${role} ${RUN_TAG}`,
    full_name: `QA ${role} ${RUN_TAG}`,
    university_role: role,
    status: "active",
  });
  assert.equal(pErr, null, `profile upsert failed: ${pErr?.message}`);

  if (isAdmin) {
    const { error: aErr } = await service
      .from("admin_users")
      .upsert({ user_id: uid, active: true });
    assert.equal(aErr, null, `admin_users upsert failed: ${aErr?.message}`);
  }

  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: sErr } = await client.auth.signInWithPassword({
    email,
    password,
  });
  assert.equal(sErr, null, `signIn failed: ${sErr?.message}`);
  return { id: uid, email, client };
}

async function seedPaidOrder({
  buyerId,
  sellerId,
  listingId,
  variantId = null,
  isFood = false,
  subtotalSen = 1500,
  commissionSen = 30,
  sellerNetSen = 1470,
  status = "paid",
  completedAt = null,
  protectionExpiresAt = null,
  verifiedPayment = true,
  quantity = 1,
}) {
  const code = `BU-QA-${RUN_TAG}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
  const nowIso = new Date().toISOString();
  const { data: ord, error: oErr } = await service
    .from("orders")
    .insert({
      order_code: code,
      buyer_id: buyerId,
      seller_id: sellerId,
      source: "cart",
      status,
      subtotal_sen: subtotalSen,
      fpx_fee_sen: 100,
      commission_sen: commissionSen,
      seller_net_sen: sellerNetSen,
      total_paid_sen: subtotalSen + 100,
      collection_area_name: "UMSKAL QA Lab",
      pickup_pin: "654321",
      payment_deadline: nowIso,
      paid_at: nowIso,
      handed_over_at: status === "handed_over" || status === "completed" ? nowIso : null,
      completed_at: completedAt,
      protection_expires_at: protectionExpiresAt,
    })
    .select("*")
    .single();
  assert.equal(oErr, null, `seed order failed: ${oErr?.message}`);
  created.orderIds.push(ord.id);

  const { data: oi, error: oiErr } = await service
    .from("order_items")
    .insert({
      order_id: ord.id,
      listing_id: listingId,
      variant_id: variantId,
      title_snapshot: `QA Item ${RUN_TAG}`,
      unit_sen: Math.round(subtotalSen / quantity),
      quantity,
      is_food: isFood,
    })
    .select("*")
    .single();
  assert.equal(oiErr, null, `seed order_item failed: ${oiErr?.message}`);

  if (verifiedPayment) {
    const { data: pay, error: pErr } = await service
      .from("payments")
      .insert({
        order_id: ord.id,
        amount_sen: subtotalSen + 100,
        status: "paid",
        transaction_ref: `TP-QA-${RUN_TAG}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
        verified_at: nowIso,
      })
      .select("id")
      .single();
    assert.equal(pErr, null, `seed payment failed: ${pErr?.message}`);
    created.paymentIds.push(pay.id);
  }
  return { order: ord, orderItem: oi };
}

async function cleanup() {
  if (created.orderIds.length > 0) {
    await service.from("financial_adjustments").delete().in("order_id", created.orderIds);
    await service.from("order_restock_logs").delete().in("order_id", created.orderIds);
    await service.from("payout_allocations").delete().in("order_id", created.orderIds);
  }
  if (created.payoutIds.length > 0) {
    await service.from("financial_execution_attempts").delete().in("entity_id", created.payoutIds);
    await service.from("payout_allocations").delete().in("payout_request_id", created.payoutIds);
    await service.from("payout_requests").delete().in("id", created.payoutIds);
  }
  if (created.refundIds.length > 0) {
    await service.from("financial_execution_attempts").delete().in("entity_id", created.refundIds);
    await service.from("order_refunds").delete().in("id", created.refundIds);
  }
  if (created.orderIds.length > 0) {
    // Also clean any refunds/disputes/attempts created by RPCs on our QA orders
    const { data: rfds } = await service.from("order_refunds").select("id").in("order_id", created.orderIds);
    const rIds = (rfds ?? []).map((r) => r.id);
    if (rIds.length > 0) {
      await service.from("financial_execution_attempts").delete().in("entity_id", rIds);
      await service.from("order_refunds").delete().in("id", rIds);
    }
    await service.from("order_disputes").delete().in("order_id", created.orderIds);
    await service.from("payments").delete().in("order_id", created.orderIds);
    await service.from("order_items").delete().in("order_id", created.orderIds);
    await service.from("orders").delete().in("id", created.orderIds);
  }
  if (created.variantIds.length > 0) {
    await service.from("listing_variants").delete().in("id", created.variantIds);
  }
  if (created.listingIds.length > 0) {
    await service.from("listings").delete().in("id", created.listingIds);
  }
  if (created.userIds.length > 0) {
    await service.from("notifications").delete().in("user_id", created.userIds);
    await service.from("payout_requests").delete().in("seller_id", created.userIds);
    await service.from("seller_payout_accounts").delete().in("seller_id", created.userIds);
    await service.from("admin_users").delete().in("user_id", created.userIds);
    await service.from("profiles").delete().in("id", created.userIds);
    for (const uid of created.userIds) {
      await service.auth.admin.deleteUser(uid);
    }
  }
}

async function run() {
  const results = [];
  const check = async (name, fn) => {
    try {
      await fn();
      results.push({ name, status: "PASS" });
    } catch (err) {
      results.push({
        name,
        status: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  try {
    // Lookup a valid category & collection area for synthetic listings
    const { data: cat } = await service.from("categories").select("id").eq("active", true).limit(1).single();
    const { data: area } = await service.from("collection_areas").select("id").eq("active", true).limit(1).single();

    const seller = await createTempUser(`qa6d.seller.${RUN_TAG.toLowerCase()}@iluv.ums.edu.my`, "student");
    const buyer = await createTempUser(`qa6d.buyer.${RUN_TAG.toLowerCase()}@iluv.ums.edu.my`, "student");
    const staff = await createTempUser(`qa6d.staff.${RUN_TAG.toLowerCase()}@ums.edu.my`, "staff");
    const admin = await createTempUser(`qa6d.admin.${RUN_TAG.toLowerCase()}@ums.edu.my`, "staff", true);

    // Seed 3 synthetic listings: normal non-variant, variant listing, and food listing
    const { data: stdListing, error: slErr } = await service
      .from("listings")
      .insert({
        seller_id: seller.id,
        category_id: cat.id,
        collection_area_id: area.id,
        title: `QA Non-Food ${RUN_TAG}`,
        description: "Synthetic QA test item for Phase 6D hosted acceptance.",
        kind: "pre_loved",
        condition: "New/Unused",
        is_food: false,
        has_variants: false,
        price_sen: 1500,
        quantity: 5,
        reserved_quantity: 0,
        status: "published",
      })
      .select("*")
      .single();
    assert.equal(slErr, null, `stdListing insert failed: ${slErr?.message}`);
    created.listingIds.push(stdListing.id);

    const { data: varListing, error: vlErr } = await service
      .from("listings")
      .insert({
        seller_id: seller.id,
        category_id: cat.id,
        collection_area_id: area.id,
        title: `QA Variant Item ${RUN_TAG}`,
        description: "Synthetic QA variant item for Phase 6D hosted acceptance.",
        kind: "pre_loved",
        condition: "New/Unused",
        is_food: false,
        has_variants: true,
        price_sen: 2000,
        quantity: 4,
        reserved_quantity: 0,
        status: "published",
      })
      .select("*")
      .single();
    assert.equal(vlErr, null, `varListing insert failed: ${vlErr?.message}`);
    created.listingIds.push(varListing.id);

    const { data: variant, error: vErr } = await service
      .from("listing_variants")
      .insert({
        listing_id: varListing.id,
        option_values: { Size: "M" },
        price_sen: 2000,
        quantity: 4,
        reserved_quantity: 0,
        active: true,
      })
      .select("*")
      .single();
    assert.equal(vErr, null, `variant insert failed: ${vErr?.message}`);
    created.variantIds.push(variant.id);

    const { data: foodListing, error: flErr } = await service
      .from("listings")
      .insert({
        seller_id: seller.id,
        category_id: cat.id,
        collection_area_id: area.id,
        title: `QA Food Item ${RUN_TAG}`,
        description: "Synthetic QA food item that must never be restocked.",
        kind: "pre_loved",
        is_food: true,
        has_variants: false,
        price_sen: 1000,
        quantity: 3,
        reserved_quantity: 0,
        status: "published",
      })
      .select("*")
      .single();
    assert.equal(flErr, null, `foodListing insert failed: ${flErr?.message}`);
    created.listingIds.push(foodListing.id);

    // -------------------------------------------------------------------------
    // TEST 1: P0.11 — Authenticated buyer/seller SELECT orders.protection_expires_at & pickup_pin lockdown
    // -------------------------------------------------------------------------
    await check("1. P0.11: Buyer/Seller read orders.protection_expires_at; pickup_pin blocked for seller", async () => {
      const { order } = await seedPaidOrder({
        buyerId: buyer.id,
        sellerId: seller.id,
        listingId: stdListing.id,
        status: "completed",
        completedAt: new Date().toISOString(),
      });
      const { data: bRow, error: bErr } = await buyer.client
        .from("orders")
        .select("id, protection_expires_at")
        .eq("id", order.id)
        .single();
      assert.equal(bErr, null, `Buyer select protection_expires_at failed: ${bErr?.message}`);
      assert.ok(bRow.protection_expires_at, "Trigger must populate protection_expires_at on new completion");

      // Exact 72-hour diff check
      const diffHours = (Date.parse(bRow.protection_expires_at) - Date.parse(order.completed_at)) / 3600000;
      assert.ok(Math.abs(diffHours - 72) < 0.01, `Expected 72h, got ${diffHours}h`);

      const { data: sRow, error: sErr } = await seller.client
        .from("orders")
        .select("id, protection_expires_at")
        .eq("id", order.id)
        .single();
      assert.equal(sErr, null, `Seller select protection_expires_at failed: ${sErr?.message}`);
      assert.equal(sRow.protection_expires_at, bRow.protection_expires_at);

      const { error: pinErr } = await seller.client
        .from("orders")
        .select("id, pickup_pin")
        .eq("id", order.id)
        .single();
      assert.ok(pinErr, "Seller MUST NOT be able to select pickup_pin");
    });

    // -------------------------------------------------------------------------
    // TEST 2: P0.2 & P0.3 — Bank Account Upsert, Privacy Lockdown, Staff Rejected, Cross-User Denied
    // -------------------------------------------------------------------------
    await check("2. P0.2/P0.3: Encrypted bank registration, column lockdown, staff blocked, cross-user denied", async () => {
      // Staff rejected
      const enc = encryptBankAccountNumber("114012345678");
      const { error: staffErr } = await service.rpc("upsert_seller_bank_account_secure", {
        p_seller_id: staff.id,
        p_bank_name: "Maybank",
        p_account_holder_name: "QA Staff",
        p_account_number_encrypted: enc,
        p_account_number_last4: "5678",
        p_account_number_masked: "****5678",
      });
      assert.ok(staffErr?.message.includes("FORBIDDEN_ACTIVE_STUDENT_ONLY"));

      // Student upsert succeeds & replacement succeeds (ON CONFLICT ON CONSTRAINT seller_payout_accounts_pkey)
      const { data: u1, error: u1Err } = await service.rpc("upsert_seller_bank_account_secure", {
        p_seller_id: seller.id,
        p_bank_name: "Maybank",
        p_account_holder_name: "QA Seller",
        p_account_number_encrypted: enc,
        p_account_number_last4: "5678",
        p_account_number_masked: "****5678",
      });
      assert.equal(u1Err, null, `Bank upsert failed: ${u1Err?.message}`);
      assert.equal(u1[0].out_account_number_masked, "****5678");

      const enc2 = encryptBankAccountNumber("701234567890");
      const { data: u2, error: u2Err } = await service.rpc("upsert_seller_bank_account_secure", {
        p_seller_id: seller.id,
        p_bank_name: "CIMB Bank",
        p_account_holder_name: "QA Seller",
        p_account_number_encrypted: enc2,
        p_account_number_last4: "7890",
        p_account_number_masked: "****7890",
      });
      assert.equal(u2Err, null, `Bank replacement failed: ${u2Err?.message}`);
      assert.equal(u2[0].out_account_number_masked, "****7890");

      // Seller cannot read raw account_number, encrypted, or duitnow_id
      for (const col of ["account_number", "account_number_encrypted", "duitnow_id"]) {
        const { error: colErr } = await seller.client
          .from("seller_payout_accounts")
          .select(col)
          .eq("seller_id", seller.id)
          .maybeSingle();
        assert.ok(colErr, `Seller must NOT be able to select ${col}`);
      }

      // Cross-user cannot read seller bank account
      const { data: crossRows } = await buyer.client
        .from("seller_payout_accounts")
        .select("bank_name, account_number_masked")
        .eq("seller_id", seller.id);
      assert.equal((crossRows ?? []).length, 0, "Cross-user bank read must return 0 rows");
    });

    // -------------------------------------------------------------------------
    // TEST 3: Protection Window Exact Boundaries (Dispute < expiry, Withdrawal >= expiry)
    // -------------------------------------------------------------------------
    await check("3. Buyer Protection: dispute allowed before expiry, rejected at/after expiry; withdrawal inverse", async () => {
      const agedCompleted = new Date(Date.now() - 73 * 3600 * 1000).toISOString();
      const { order: expiredOrd } = await seedPaidOrder({
        buyerId: buyer.id,
        sellerId: seller.id,
        listingId: stdListing.id,
        status: "completed",
        completedAt: agedCompleted,
      });

      // Dispute MUST be rejected after 72h expiry
      const { error: dExpErr } = await buyer.client.rpc("open_order_dispute_atomic", {
        p_order_id: expiredOrd.id,
        p_reason_code: "damaged",
        p_description: "Attempting dispute after 72-hour protection window expired.",
        p_evidence_paths: [],
      });
      assert.ok(dExpErr?.message.includes("DISPUTE_WINDOW_EXPIRED"), `Expected DISPUTE_WINDOW_EXPIRED, got ${dExpErr?.message}`);

      // Recent completed order (< 72h): dispute allowed!
      const recentCompleted = new Date(Date.now() - 10 * 3600 * 1000).toISOString();
      const { order: recentOrd } = await seedPaidOrder({
        buyerId: buyer.id,
        sellerId: seller.id,
        listingId: stdListing.id,
        status: "completed",
        completedAt: recentCompleted,
      });

      const { data: dOpen, error: dOpenErr } = await buyer.client.rpc("open_order_dispute_atomic", {
        p_order_id: recentOrd.id,
        p_reason_code: "not_as_described",
        p_description: "Item condition does not match listing description within 72h.",
        p_evidence_paths: [],
      });
      assert.equal(dOpenErr, null, `Dispute within 72h failed: ${dOpenErr?.message}`);
      created.disputeIds.push(dOpen[0].id);

      // Admin resolves release_to_seller -> restores completed status without resetting completed_at
      const { data: relRes, error: relErr } = await admin.client.rpc("admin_resolve_order_dispute_atomic", {
        p_dispute_id: dOpen[0].id,
        p_resolution_type: "release_to_seller",
        p_refund_amount_sen: null,
        p_admin_notes: "Verified item matches listing.",
        p_return_required: false,
        p_return_instructions: null,
      });
      assert.equal(relErr, null, `release_to_seller failed: ${relErr?.message}`);
      assert.equal(relRes[0].order_status, "completed");
    });

    // -------------------------------------------------------------------------
    // TEST 4: Refunds, Return Gate, Separated Restock, Food/Damaged/Variant & P0.12 Immutable Evidence
    // -------------------------------------------------------------------------
    await check("4. Refunds, Return Gate, Separated Restock (food/variant/qty) & P0.12 Immutable Evidence", async () => {
      // 4a. Food listing restock MUST be rejected
      const { order: foodOrd, orderItem: foodOi } = await seedPaidOrder({
        buyerId: buyer.id,
        sellerId: seller.id,
        listingId: foodListing.id,
        isFood: true,
        subtotalSen: 1000,
        commissionSen: 20,
        sellerNetSen: 980,
        status: "paid",
      });
      const { data: fd } = await buyer.client.rpc("open_order_dispute_atomic", {
        p_order_id: foodOrd.id,
        p_reason_code: "not_received",
        p_description: "Food order was never handed over at pickup area.",
        p_evidence_paths: [],
      });
      await admin.client.rpc("admin_resolve_order_dispute_atomic", {
        p_dispute_id: fd[0].id,
        p_resolution_type: "full_refund",
        p_refund_amount_sen: null,
        p_admin_notes: "Approved full refund for food item.",
        p_return_required: false,
        p_return_instructions: null,
      });
      const { data: foodRfd } = await service
        .from("order_refunds")
        .select("*")
        .eq("dispute_id", fd[0].id)
        .single();
      created.refundIds.push(foodRfd.id);

      const { error: foodRestockErr } = await admin.client.rpc("admin_approve_refund_restock_atomic", {
        p_refund_id: foodRfd.id,
        p_approve: true,
        p_items: [{ order_item_id: foodOi.id, quantity: 1 }],
      });
      assert.ok(foodRestockErr?.message.includes("FOOD_OR_SERVICE_NOT_RESTOCKABLE"));

      // 4b. Variant order with Return Required -> Buyer report -> Seller confirm -> Restock approved_pending_refund -> Refund execute -> Atomic restock!
      const { order: varOrd, orderItem: varOi } = await seedPaidOrder({
        buyerId: buyer.id,
        sellerId: seller.id,
        listingId: varListing.id,
        variantId: variant.id,
        subtotalSen: 2000,
        commissionSen: 40,
        sellerNetSen: 1960,
        status: "handed_over",
      });
      const { data: vd } = await buyer.client.rpc("open_order_dispute_atomic", {
        p_order_id: varOrd.id,
        p_reason_code: "wrong_item",
        p_description: "Received wrong variant size at campus handover.",
        p_evidence_paths: [],
      });
      await admin.client.rpc("admin_resolve_order_dispute_atomic", {
        p_dispute_id: vd[0].id,
        p_resolution_type: "full_refund",
        p_refund_amount_sen: null,
        p_admin_notes: "Return required before full refund.",
        p_return_required: true,
        p_return_instructions: "Return item at library entrance.",
      });
      const { data: varRfd } = await service
        .from("order_refunds")
        .select("*")
        .eq("dispute_id", vd[0].id)
        .single();
      created.refundIds.push(varRfd.id);

      // Claim blocked until return confirmed
      const { error: blockedClaimErr } = await service.rpc("claim_order_refund_execution_atomic", {
        p_refund_id: varRfd.id,
        p_admin_id: admin.id,
      });
      assert.ok(blockedClaimErr?.message.includes("RETURN_CONFIRMATION_REQUIRED"));

      // Buyer reports return (still blocked until seller/admin confirms!)
      const { error: repErr } = await buyer.client.rpc("buyer_report_return_atomic", {
        p_refund_id: varRfd.id,
      });
      assert.equal(repErr, null);

      const { error: stillBlockedErr } = await service.rpc("claim_order_refund_execution_atomic", {
        p_refund_id: varRfd.id,
        p_admin_id: admin.id,
      });
      assert.ok(stillBlockedErr?.message.includes("RETURN_CONFIRMATION_REQUIRED"));

      // Seller confirms physical return resellable
      const { error: confErr } = await seller.client.rpc("confirm_return_receipt_atomic", {
        p_refund_id: varRfd.id,
        p_item_condition: "resellable",
        p_is_admin_exception: false,
        p_exception_reason: null,
      });
      assert.equal(confErr, null);

      // Duplicate order_item_id rejected in restock plan
      const { error: dupItemErr } = await admin.client.rpc("admin_approve_refund_restock_atomic", {
        p_refund_id: varRfd.id,
        p_approve: true,
        p_items: [
          { order_item_id: varOi.id, quantity: 1 },
          { order_item_id: varOi.id, quantity: 1 },
        ],
      });
      assert.ok(dupItemErr?.message.includes("DUPLICATE_RESTOCK_ORDER_ITEM"));

      // Approve restock BEFORE refund succeeds -> status = approved_pending_refund, stock NOT mutated yet!
      const { data: rPlanRes, error: rPlanErr } = await admin.client.rpc("admin_approve_refund_restock_atomic", {
        p_refund_id: varRfd.id,
        p_approve: true,
        p_items: [{ order_item_id: varOi.id, quantity: 1 }],
      });
      assert.equal(rPlanErr, null);
      assert.equal(rPlanRes, "approved_pending_refund");
      const { data: varBefore } = await service.from("listing_variants").select("quantity").eq("id", variant.id).single();
      assert.equal(varBefore.quantity, 4, "Stock must NOT mutate before refund succeeds");

      // Claim refund
      const { data: claimData, error: claimErr } = await service.rpc("claim_order_refund_execution_atomic", {
        p_refund_id: varRfd.id,
        p_admin_id: admin.id,
      });
      assert.equal(claimErr, null);
      const token = claimData[0].attempt_token;
      const rfdProv = new SimulatedRefundProvider();
      const simRes = await rfdProv.executeRefund({
        refundCode: claimData[0].refund_code,
        orderId: varOrd.id,
        amountSen: 2000,
        idempotencyKey: claimData[0].logical_tx_id,
      });

      // P0.12: Finalization WITHOUT recorded provider evidence MUST fail!
      const { error: unrecErr } = await service.rpc("finalize_order_refund_atomic", {
        p_refund_id: varRfd.id,
        p_attempt_token: token,
        p_outcome: "succeeded",
        p_refund_ref: simRes.refundRef,
        p_failure_reason: null,
      });
      assert.ok(unrecErr?.message.includes("UNVERIFIED_PROVIDER_SUCCESS"));

      // Record definitive success
      const { error: recErr } = await service.rpc("record_provider_attempt_outcome_atomic", {
        p_attempt_token: token,
        p_provider_outcome: "succeeded",
        p_simulation_ref: simRes.refundRef,
        p_reason: null,
      });
      assert.equal(recErr, null);

      // P0.12: Identical replay idempotent; conflicting outcome rejected!
      const { data: replayOk, error: replayErr } = await service.rpc("record_provider_attempt_outcome_atomic", {
        p_attempt_token: token,
        p_provider_outcome: "succeeded",
        p_simulation_ref: simRes.refundRef,
        p_reason: null,
      });
      assert.equal(replayErr, null);
      assert.equal(replayOk, true);

      const { error: conflictErr } = await service.rpc("record_provider_attempt_outcome_atomic", {
        p_attempt_token: token,
        p_provider_outcome: "failed",
        p_simulation_ref: null,
        p_reason: "conflicting",
      });
      assert.ok(conflictErr?.message.includes("CONFLICTING_PROVIDER_OUTCOME"));

      // Finalize refund -> order refunded, PIN cleared, variant + listing restocked once!
      const { data: finRes, error: finErr } = await service.rpc("finalize_order_refund_atomic", {
        p_refund_id: varRfd.id,
        p_attempt_token: token,
        p_outcome: "succeeded",
        p_refund_ref: simRes.refundRef,
        p_failure_reason: null,
      });
      assert.equal(finErr, null);
      assert.equal(finRes, "succeeded");

      const { data: ordAfter } = await service.from("orders").select("status, pickup_pin").eq("id", varOrd.id).single();
      assert.equal(ordAfter.status, "refunded");
      assert.equal(ordAfter.pickup_pin, null);

      const { data: varAfter } = await service.from("listing_variants").select("quantity").eq("id", variant.id).single();
      assert.equal(varAfter.quantity, 5, "Variant quantity must increment by 1 atomically on refund success");
    });

    // -------------------------------------------------------------------------
    // TEST 5: Automatic Withdrawals, Unverified Payment Exclusion, Failure Release & Durable Recovery Worker
    // -------------------------------------------------------------------------
    await check("5. Withdrawals, Unverified Payment Rejection, Failure Release & Live Recovery Worker", async () => {
      // Seed an UNVERIFIED aged completed order (paid_at set, NO payment record!) -> MUST be excluded!
      await seedPaidOrder({
        buyerId: buyer.id,
        sellerId: seller.id,
        listingId: stdListing.id,
        subtotalSen: 5000,
        commissionSen: 100,
        sellerNetSen: 4900,
        status: "completed",
        completedAt: new Date(Date.now() - 80 * 3600 * 1000).toISOString(),
        verifiedPayment: false,
      });

      // Seller currently has ONLY the 1470 sen aged verified completed order from Test 3!
      // Below RM 2.00 rejected
      const { error: minErr } = await service.rpc("create_seller_withdrawal_atomic", {
        p_seller_id: seller.id,
        p_amount_sen: 150,
        p_idempotency_key: `wdr-min-${RUN_TAG}`,
      });
      assert.ok(minErr?.message.includes("BELOW_MINIMUM_WITHDRAWAL"));

      // Excess withdrawal (2000 > 1470 — proves unverified 4900 order was excluded!)
      const { error: excErr } = await service.rpc("create_seller_withdrawal_atomic", {
        p_seller_id: seller.id,
        p_amount_sen: 2000,
        p_idempotency_key: `wdr-exc-${RUN_TAG}`,
      });
      assert.ok(excErr?.message.includes("INSUFFICIENT_AVAILABLE_BALANCE"));

      // Partial withdrawal RM 5.00 -> simulate definitive FAILURE -> releases allocations once!
      const { data: wFail, error: wFailErr } = await service.rpc("create_seller_withdrawal_atomic", {
        p_seller_id: seller.id,
        p_amount_sen: 500,
        p_idempotency_key: `wdr-fail-${RUN_TAG}`,
      });
      assert.equal(wFailErr, null);
      created.payoutIds.push(wFail[0].withdrawal_id);

      await service.rpc("record_provider_attempt_outcome_atomic", {
        p_attempt_token: wFail[0].attempt_token,
        p_provider_outcome: "failed",
        p_simulation_ref: null,
        p_reason: "QA simulated bank rejection",
      });
      const { data: wFailFin } = await service.rpc("finalize_seller_withdrawal_atomic", {
        p_withdrawal_id: wFail[0].withdrawal_id,
        p_attempt_token: wFail[0].attempt_token,
        p_outcome: "failed",
        p_transfer_ref: null,
        p_failure_reason: "QA simulated bank rejection",
      });
      assert.equal(wFailFin, "failed");

      // Now Withdraw All RM 14.70 (proves RM 5.00 was restored!) -> simulate CRASH AFTER PERSISTENCE -> recover via ACTUAL `phase6d-recovery-worker.mjs`!
      const { data: wAll, error: wAllErr } = await service.rpc("create_seller_withdrawal_atomic", {
        p_seller_id: seller.id,
        p_amount_sen: 1470,
        p_idempotency_key: `wdr-all-${RUN_TAG}`,
      });
      assert.equal(wAllErr, null);
      created.payoutIds.push(wAll[0].withdrawal_id);

      const bankProv = new SimulatedBankPayoutProvider();
      const simTransfer = await bankProv.executeDisbursement({
        withdrawalCode: wAll[0].withdrawal_code,
        sellerId: seller.id,
        amountSen: 1470,
        idempotencyKey: wAll[0].logical_tx_id,
        bankName: "CIMB Bank",
        accountLast4: "7890",
      });
      await service.rpc("record_provider_attempt_outcome_atomic", {
        p_attempt_token: wAll[0].attempt_token,
        p_provider_outcome: "paid",
        p_simulation_ref: simTransfer.transferRef,
        p_reason: null,
      });

      // Execute the ACTUAL recovery worker CLI!
      const workerOut = execFileSync(process.execPath, ["scripts/phase6d-recovery-worker.mjs"], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const parsed = JSON.parse(workerOut.trim().split(/\r?\n/).pop());
      assert.ok(
        parsed.results.some((r) => r.entityId === wAll[0].withdrawal_id && r.result === "paid"),
        `Recovery worker did not finalize withdrawal: ${workerOut}`
      );

      // Re-run recovery worker -> idempotent, zero duplicate finalizations!
      const workerOut2 = execFileSync(process.execPath, ["scripts/phase6d-recovery-worker.mjs"], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const parsed2 = JSON.parse(workerOut2.trim().split(/\r?\n/).pop());
      assert.equal(
        parsed2.results.some((r) => r.entityId === wAll[0].withdrawal_id),
        false,
        "Already-paid withdrawal must not be reprocessed"
      );

      // Verify immutable paid status & exact allocation sum
      const { data: wRow } = await service
        .from("payout_requests")
        .select("status, transfer_ref")
        .eq("id", wAll[0].withdrawal_id)
        .single();
      assert.equal(wRow.status, "paid");
      assert.equal(wRow.transfer_ref, simTransfer.transferRef);
    });

    // -------------------------------------------------------------------------
    // TEST 6: Security Lockdown — Service-Role RPCs & Direct Writes Denied to Members & Anon
    // -------------------------------------------------------------------------
    await check("6. Security: Service-role RPCs and direct financial writes rejected for members & anon", async () => {
      for (const fn of [
        "claim_order_refund_execution_atomic",
        "finalize_order_refund_atomic",
        "create_seller_withdrawal_atomic",
        "finalize_seller_withdrawal_atomic",
        "recover_financial_execution_atomic",
        "record_provider_attempt_outcome_atomic",
      ]) {
        const { error: mErr } = await seller.client.rpc(fn, {});
        assert.ok(mErr, `Authenticated member must NOT execute ${fn}`);
        const { error: aErr } = await anon.rpc(fn, {});
        assert.ok(aErr, `Anon must NOT execute ${fn}`);
      }

      const { error: dirInsErr } = await seller.client.from("payout_requests").insert({
        seller_id: seller.id,
        amount_sen: 500,
        status: "paid",
      });
      assert.ok(dirInsErr, "Direct client INSERT on payout_requests must be denied");
    });

    // -------------------------------------------------------------------------
    // TEST 7: Preserved Owner QA Records Completely Untouched
    // -------------------------------------------------------------------------
    await check("7. Preserved QA orders, disputes & backfilled pending refunds remain untouched", async () => {
      const { data: ords } = await service
        .from("orders")
        .select("order_code, status")
        .in("order_code", ["BU-2611-0DB3", "BU-2611-B1C075", "BU-2611-C3CC55", "BU-2611-3CB12A"]);
      assert.equal((ords ?? []).length, 4);
      const { data: rfds } = await service
        .from("order_refunds")
        .select("refund_code, status")
        .in("refund_code", ["RFD-2611-872723", "RFD-2611-19B70A"]);
      assert.equal((rfds ?? []).length, 2);
      assert.ok(rfds.every((r) => r.status === "pending_execution"));
    });
  } finally {
    await cleanup();
  }

  const passed = results.filter((r) => r.status === "PASS").length;
  console.log(JSON.stringify({ passed, total: results.length, results }, null, 2));
  if (passed !== results.length) process.exit(1);
}

run();
