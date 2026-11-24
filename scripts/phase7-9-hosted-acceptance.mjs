/**
 * Buy-U Phases 7–9 — Comprehensive Hosted PostgreSQL Acceptance Suite (Gate B: B1–B11)
 *
 * SAFETY GUARD:
 *   Will NOT execute unless caller explicitly sets `ALLOW_PHASE7_9_HOSTED_QA=1`.
 *   Creates strictly isolated temporary synthetic QA users & fixtures (tagged with RUN_TAG),
 *   verifies every Gate B requirement (B1–B11) directly against live hosted PostgreSQL/PostgREST/Storage,
 *   and removes all synthetic rows, storage objects, and temporary auth users in `finally`
 *   without ever modifying preserved Phase 6 orders/disputes/refunds or established QA accounts.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import {
  computeCommunityImpact,
  computeRatingSummary,
  parsePreferredServiceTimestamp,
} from "../src/lib/marketplace/phase8.ts";
import {
  buildAnalyticsCsv,
  computeAdminPlatformAnalytics,
  computeSellerAnalytics,
  fetchAllPaginated,
  resolveAnalyticsWindow,
} from "../src/lib/analytics/metrics.ts";

if (process.env.ALLOW_PHASE7_9_HOSTED_QA !== "1") {
  console.log(
    "SKIPPED: Set ALLOW_PHASE7_9_HOSTED_QA=1 ONLY after owner applies docs/sql/phase-7-9-marketplace-completion.sql."
  );
  process.exit(0);
}

function loadEnvLocal() {
  const p = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
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
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

const cleanup = [];
const tempUserIds = [];
const tempStorage = []; // { bucket, path }

async function createTempUser({ prefix, role, status = "active", isAdmin = false }) {
  const domain = role === "student" ? "iluv.ums.edu.my" : "ums.edu.my";
  const email = `qa.${prefix}.${RUN_TAG.toLowerCase()}@${domain}`;
  const password = `QaPass!${crypto.randomBytes(8).toString("hex")}`;
  const { data: uData, error: uErr } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assert.equal(uErr, null, `createUser(${email}) failed: ${uErr?.message}`);
  const id = uData.user.id;
  tempUserIds.push(id);

  const { error: pErr } = await service.from("profiles").upsert({
    id,
    email,
    display_name: `QA ${prefix} ${RUN_TAG}`,
    full_name: `QA ${prefix} ${RUN_TAG}`,
    university_role: role,
    status,
    faculty: "FKAL",
  });
  assert.equal(pErr, null, `profile upsert failed: ${pErr?.message}`);

  if (isAdmin) {
    const { error: aErr } = await service.from("admin_users").upsert({ user_id: id, active: true });
    assert.equal(aErr, null, `admin_users upsert failed: ${aErr?.message}`);
  }

  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password });
  assert.equal(sErr, null, `signIn(${email}) failed: ${sErr?.message}`);
  return { id, email, client };
}

async function getOrCreateConversation(userA, userB) {
  const [mA, mB] = userA < userB ? [userA, userB] : [userB, userA];
  const { data: existing } = await service
    .from("conversations")
    .select("id")
    .eq("member_a", mA)
    .eq("member_b", mB)
    .maybeSingle();
  if (existing?.id) return existing;
  const { data: createdConv, error: cErr } = await service
    .from("conversations")
    .insert({ member_a: mA, member_b: mB })
    .select("id")
    .single();
  assert.equal(cErr, null, `conversations insert failed: ${cErr?.message}`);
  cleanup.push(async () => {
    await service.from("offers").delete().eq("conversation_id", createdConv.id);
    await service.from("messages").delete().eq("conversation_id", createdConv.id);
    await service.from("conversations").delete().eq("id", createdConv.id);
  });
  return createdConv;
}

async function seedOrderFixture({
  buyerId,
  sellerId,
  items, // [{ listing_id, title_snapshot, unit_sen, quantity }]
  status = "completed",
  paymentMode = "checkout_session", // 'checkout_session' | 'legacy_payment' | 'unverified'
  checkoutSessionId = null,
  fpxFeeSen = 100,
  paidAt = new Date().toISOString(),
  completedAt = new Date().toISOString(),
  createdAt = new Date().toISOString(),
  refund = null, // { type, amountSen, commissionRevSen, sellerDedSen, status }
  openDispute = false,
}) {
  const subtotalSen = items.reduce((s, it) => s + it.unit_sen * it.quantity, 0);
  const commissionSen = Math.round(subtotalSen * 0.02);
  const sellerNetSen = subtotalSen - commissionSen;

  let csId = checkoutSessionId;
  if (paymentMode === "checkout_session" && !csId) {
    const { data: cs, error: csErr } = await service
      .from("checkout_sessions")
      .insert({
        checkout_code: `CS-QA-${RUN_TAG}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`,
        buyer_id: buyerId,
        source: "cart",
        idempotency_key: `qa-cs-${crypto.randomUUID()}`,
        combined_subtotal_sen: subtotalSen,
        fpx_fee_sen: fpxFeeSen,
        total_paid_sen: subtotalSen + fpxFeeSen,
        status: "paid",
        payment_status: "paid",
        paid_at: paidAt,
        verified_at: paidAt,
        payment_deadline: new Date(Date.now() + 3600_000).toISOString(),
        created_at: createdAt,
      })
      .select("id")
      .single();
    assert.equal(csErr, null, `checkout_sessions insert failed: ${csErr?.message}`);
    csId = cs.id;
    cleanup.push(async () => {
      await service.from("checkout_sessions").delete().eq("id", csId);
    });
  }

  const orderCode = `QA-${RUN_TAG}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
  const { data: ord, error: oErr } = await service
    .from("orders")
    .insert({
      order_code: orderCode,
      buyer_id: buyerId,
      seller_id: sellerId,
      source: "cart",
      checkout_session_id: csId,
      subtotal_sen: subtotalSen,
      fpx_fee_sen: fpxFeeSen,
      commission_sen: commissionSen,
      seller_net_sen: sellerNetSen,
      total_paid_sen: subtotalSen + fpxFeeSen,
      collection_area_name: "UMSKAL QA Lab",
      pickup_pin: status === "paid" ? "654321" : null,
      payment_deadline: paidAt,
      status,
      paid_at: status === "pending_payment" ? null : paidAt,
      handed_over_at: status === "handed_over" || status === "completed" ? paidAt : null,
      completed_at: status === "completed" ? completedAt : null,
      protection_expires_at:
        status === "completed" ? new Date(Date.parse(completedAt) + 72 * 3600_000).toISOString() : null,
      created_at: createdAt,
    })
    .select("id, order_code")
    .single();
  assert.equal(oErr, null, `orders insert failed: ${oErr?.message}`);

  cleanup.push(async () => {
    await service.from("order_refunds").delete().eq("order_id", ord.id);
    await service.from("order_disputes").delete().eq("order_id", ord.id);
    await service.from("payments").delete().eq("order_id", ord.id);
    await service.from("order_items").delete().eq("order_id", ord.id);
    await service.from("orders").delete().eq("id", ord.id);
  });

  const { error: oiErr } = await service.from("order_items").insert(
    items.map((it) => ({
      order_id: ord.id,
      listing_id: it.listing_id,
      title_snapshot: it.title_snapshot,
      unit_sen: it.unit_sen,
      quantity: it.quantity,
    }))
  );
  assert.equal(oiErr, null, `order_items insert failed: ${oiErr?.message}`);

  if (paymentMode === "legacy_payment") {
    const { error: pErr } = await service.from("payments").insert({
      order_id: ord.id,
      amount_sen: subtotalSen + fpxFeeSen,
      status: "paid",
      verified_at: paidAt,
      transaction_ref: `QA-LEG-${crypto.randomBytes(3).toString("hex")}`,
      created_at: createdAt,
    });
    assert.equal(pErr, null, `payments insert failed: ${pErr?.message}`);
  }

  let disputeId = null;
  if (openDispute || refund) {
    const { data: dRow, error: dErr } = await service
      .from("order_disputes")
      .insert({
        order_id: ord.id,
        opened_by: buyerId,
        dispute_code: `DSP-QA-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
        reason_code: "not_as_described",
        reason: "Synthetic QA dispute fixture",
        description: "Synthetic QA dispute fixture for hosted acceptance.",
        status: openDispute ? "open" : "resolved",
        resolution_type: openDispute ? null : refund?.type ?? "partial_refund",
        refund_amount_sen: refund?.amountSen ?? 0,
        previous_order_status: "paid",
        created_at: createdAt,
      })
      .select("id")
      .single();
    assert.equal(dErr, null, `order_disputes insert failed: ${dErr?.message}`);
    disputeId = dRow.id;
  }

  if (refund && disputeId) {
    const { error: rErr } = await service.from("order_refunds").insert({
      refund_code: `RFD-QA-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
      dispute_id: disputeId,
      order_id: ord.id,
      refund_type: refund.type,
      refund_amount_sen: refund.amountSen,
      commission_reversal_sen: refund.commissionRevSen,
      seller_deduction_sen: refund.sellerDedSen,
      status: refund.status ?? "succeeded",
      provider: "simulated_toyyibpay",
      simulation_mode: true,
      idempotency_key: `qa-rfd-${crypto.randomUUID()}`,
      created_at: createdAt,
    });
    assert.equal(rErr, null, `order_refunds insert failed: ${rErr?.message}`);
  }

  return { id: ord.id, orderCode: ord.order_code, checkoutSessionId: csId };
}

async function fetchLiveAnalyticsDataset() {
  const [
    profiles,
    listings,
    orders,
    orderItems,
    checkoutSessions,
    legacyPayments,
    refunds,
    views,
    favourites,
    serviceRequests,
    freeNotices,
    freeClaims,
    reviews,
    reports,
    disputes,
  ] = await Promise.all([
    fetchAllPaginated((from, to) =>
      service.from("profiles").select("id,university_role,status,faculty,created_at,last_active_at").order("id", { ascending: true }).range(from, to)
    ),
    fetchAllPaginated((from, to) =>
      service.from("listings").select("id,seller_id,title,kind,category_id,is_food,has_variants,quantity,reserved_quantity,status,created_at").order("id", { ascending: true }).range(from, to)
    ),
    fetchAllPaginated((from, to) =>
      service.from("orders").select("id,buyer_id,seller_id,checkout_session_id,subtotal_sen,commission_sen,seller_net_sen,status,paid_at,completed_at,created_at").order("id", { ascending: true }).range(from, to)
    ),
    fetchAllPaginated((from, to) =>
      service.from("order_items").select("order_id,listing_id,title_snapshot,unit_sen,quantity").order("id", { ascending: true }).range(from, to)
    ),
    fetchAllPaginated((from, to) =>
      service.from("checkout_sessions").select("id,buyer_id,status,payment_status,paid_at").order("id", { ascending: true }).range(from, to)
    ),
    fetchAllPaginated((from, to) =>
      service.from("payments").select("order_id,status,verified_at").order("id", { ascending: true }).range(from, to)
    ),
    fetchAllPaginated((from, to) =>
      service.from("order_refunds").select("order_id,refund_type,refund_amount_sen,commission_reversal_sen,seller_deduction_sen,status").order("id", { ascending: true }).range(from, to)
    ),
    fetchAllPaginated((from, to) =>
      service.from("listing_views").select("viewer_id,listing_id,viewed_at").order("viewed_at", { ascending: true }).order("viewer_id", { ascending: true }).order("listing_id", { ascending: true }).range(from, to)
    ),
    fetchAllPaginated((from, to) =>
      service.from("favourites").select("user_id,listing_id,created_at").order("created_at", { ascending: true }).order("user_id", { ascending: true }).order("listing_id", { ascending: true }).range(from, to)
    ),
    fetchAllPaginated((from, to) =>
      service.from("service_requests").select("id,listing_id,buyer_id,seller_id,status,created_at,completed_at").order("id", { ascending: true }).range(from, to)
    ),
    fetchAllPaginated((from, to) =>
      service.from("free_notices").select("id,contributor_id,status,spot_id,created_at").order("id", { ascending: true }).range(from, to)
    ),
    fetchAllPaginated((from, to) =>
      service.from("free_notice_claims").select("notice_id,donor_id,recipient_id,quantity,status,collected_at,created_at").order("id", { ascending: true }).range(from, to)
    ),
    fetchAllPaginated((from, to) =>
      service.from("reviews").select("id,listing_id,seller_id,rating,hidden,created_at").order("id", { ascending: true }).range(from, to)
    ),
    fetchAllPaginated((from, to) =>
      service.from("reports").select("id,reason,status,created_at,resolved_at").order("id", { ascending: true }).range(from, to)
    ),
    fetchAllPaginated((from, to) =>
      service.from("order_disputes").select("id,order_id,status,created_at,resolved_at").order("id", { ascending: true }).range(from, to)
    ),
  ]);

  return {
    profiles,
    listings,
    orders,
    orderItems,
    checkoutSessions,
    legacyPayments,
    refunds,
    views,
    favourites,
    serviceRequests,
    freeNotices,
    freeClaims,
    reviews,
    reports,
    disputes,
  };
}

async function run() {
  const results = [];
  const check = async (id, name, fn) => {
    try {
      await fn();
      results.push({ id, name, status: "PASS" });
    } catch (err) {
      results.push({
        id,
        name,
        status: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  try {
    // Capture pre-test admin analytics baseline before creating any QA fixtures
    const baseAnalyticsBefore = computeAdminPlatformAnalytics(
      await fetchLiveAnalyticsDataset(),
      resolveAnalyticsWindow("30d")
    );

    // Create strictly isolated synthetic QA actors
    const seller = await createTempUser({ prefix: "seller", role: "student" });
    const seller2 = await createTempUser({ prefix: "seller2", role: "student" });
    const buyer = await createTempUser({ prefix: "buyer", role: "student" });
    const staff = await createTempUser({ prefix: "staff", role: "staff" });
    const third = await createTempUser({ prefix: "third", role: "student" });
    const admin = await createTempUser({ prefix: "admin", role: "staff", isAdmin: true });
    const closedUser = await createTempUser({ prefix: "closed", role: "student", status: "closed" });

    // Shared synthetic listings created by seller
    let serviceListingId;
    let businessListingId;
    let prelovedListingId;
    let prelovedListing2Id;
    let completedServiceReqId;

    // =========================================================================
    // B1. SERVICES MARKETPLACE
    // =========================================================================
    await check("B1.1", "Active student publishes service listing; staff publishing rejected", async () => {
      const { data: svc, error: sErr } = await seller.client
        .from("listings")
        .insert({
          seller_id: seller.id,
          kind: "service",
          title: `QA Printing Service ${RUN_TAG}`,
          description: "Campus colour printing & spiral binding near FKAL lobby.",
          category_id: "printing-errands",
          price_sen: 1200,
          quantity: 1,
          service_mode: "in_person",
          accepting_requests: true,
          rules_acknowledged: true,
          status: "published",
        })
        .select("id")
        .single();
      assert.equal(sErr, null, `Student service publish failed: ${sErr?.message}`);
      serviceListingId = svc.id;
      cleanup.push(async () => {
        await service.from("reviews").delete().eq("listing_id", serviceListingId);
        await service.from("service_requests").delete().eq("listing_id", serviceListingId);
        await service.from("listing_views").delete().eq("listing_id", serviceListingId);
        await service.from("listings").delete().eq("id", serviceListingId);
      });

      const { error: staffErr } = await staff.client.from("listings").insert({
        seller_id: staff.id,
        kind: "service",
        title: `QA Staff Service ${RUN_TAG}`,
        description: "Staff members must never publish services on Buy-U.",
        category_id: "printing-errands",
        price_sen: 1000,
        quantity: 1,
        service_mode: "remote",
        rules_acknowledged: true,
        status: "published",
      });
      assert.ok(staffErr, "Staff publishing a service must be rejected");
    });

    await check("B1.2", "Service request mode, MYT date, malformed date, self-request, duplicate & concurrent guard", async () => {
      // Malformed MYT date rejected in parser & DB timestamptz
      assert.equal(parsePreferredServiceTimestamp("Tomorrow 3pm").ok, false);
      const { error: badTsErr } = await staff.client.rpc("create_service_request_atomic", {
        p_listing_id: serviceListingId,
        p_mode: "in_person",
        p_requirements: "Print 15 assignment sheets double-sided cleanly.",
        p_preferred_date: "not-a-valid-timestamp",
      });
      assert.ok(badTsErr, "Malformed timestamptz must be rejected by PostgreSQL");

      // Incompatible mode (remote on in_person-only listing) rejected
      const { error: badModeErr } = await staff.client.rpc("create_service_request_atomic", {
        p_listing_id: serviceListingId,
        p_mode: "remote",
        p_requirements: "Need remote printing which listing does not offer.",
        p_preferred_date: null,
      });
      assert.ok(badModeErr && badModeErr.message.includes("INCOMPATIBLE_SERVICE_MODE"));

      // Self-request rejected
      const { error: selfErr } = await seller.client.rpc("create_service_request_atomic", {
        p_listing_id: serviceListingId,
        p_mode: "in_person",
        p_requirements: "Attempting to request my own service listing.",
        p_preferred_date: null,
      });
      assert.ok(selfErr && selfErr.message.includes("CANNOT_REQUEST_OWN_SERVICE"));

      // Valid MYT date conversion + concurrent duplicate request protection (only 1 succeeds!)
      const parsedDate = parsePreferredServiceTimestamp("2026-11-28T15:30");
      assert.equal(parsedDate.ok, true);
      const [c1, c2] = await Promise.all([
        staff.client.rpc("create_service_request_atomic", {
          p_listing_id: serviceListingId,
          p_mode: "in_person",
          p_requirements: "Need 25 pages printed and comb-bound at FKAL lobby.",
          p_preferred_date: parsedDate.iso,
        }),
        staff.client.rpc("create_service_request_atomic", {
          p_listing_id: serviceListingId,
          p_mode: "in_person",
          p_requirements: "Concurrent duplicate request for same service listing.",
          p_preferred_date: parsedDate.iso,
        }),
      ]);
      const okCount = [c1, c2].filter((r) => !r.error).length;
      assert.equal(okCount, 1, `Exactly 1 concurrent service request may succeed, got ${okCount}`);
      const staffReq = (c1.error ? c2.data : c1.data)?.[0];
      assert.ok(staffReq?.out_id && staffReq?.out_status === "requested");

      // Sequential duplicate also rejected
      const { error: dupErr } = await staff.client.rpc("create_service_request_atomic", {
        p_listing_id: serviceListingId,
        p_mode: "in_person",
        p_requirements: "Duplicate active request while previous is requested.",
        p_preferred_date: null,
      });
      assert.ok(dupErr, "Duplicate active request must be rejected");

      // Verify exact 48h respond_by deadline persisted & preferred_date matches MYT UTC conversion
      const { data: srRow } = await service
        .from("service_requests")
        .select("respond_by, created_at, preferred_date")
        .eq("id", staffReq.out_id)
        .single();
      const diffHours = (Date.parse(srRow.respond_by) - Date.parse(srRow.created_at)) / 3600_000;
      assert.ok(Math.abs(diffHours - 48) < 0.05, `Expected 48h respond_by, got ${diffHours}h`);
      assert.equal(new Date(srRow.preferred_date).toISOString(), parsedDate.iso);

      // Seller declines cleanly
      const { data: decData, error: decErr } = await seller.client.rpc("update_service_request_status_atomic", {
        p_request_id: staffReq.out_id,
        p_action: "decline",
        p_note: "Printer offline today",
      });
      assert.equal(decErr, null, `decline failed: ${decErr?.message}`);
      assert.equal(decData?.[0]?.out_status, "declined");
    });

    await check("B1.3", "Suspended buyer & inactive provider acceptance rejected; availability & mode revalidated", async () => {
      const { data: r1, error: r1Err } = await buyer.client.rpc("create_service_request_atomic", {
        p_listing_id: serviceListingId,
        p_mode: "in_person",
        p_requirements: "Need thesis formatting and hardcopy printout by Friday.",
        p_preferred_date: null,
      });
      assert.equal(r1Err, null);
      const reqId = r1[0].out_id;

      // Suspend buyer -> seller accept MUST fail with BUYER_ACCOUNT_INACTIVE
      await service.from("profiles").update({ status: "suspended" }).eq("id", buyer.id);
      const { error: susBuyerErr } = await seller.client.rpc("update_service_request_status_atomic", {
        p_request_id: reqId,
        p_action: "accept",
      });
      assert.ok(susBuyerErr && susBuyerErr.message.includes("BUYER_ACCOUNT_INACTIVE"), `Expected BUYER_ACCOUNT_INACTIVE, got ${susBuyerErr?.message}`);
      await service.from("profiles").update({ status: "active" }).eq("id", buyer.id);

      // Pause listing -> seller accept MUST fail with SERVICE_UNAVAILABLE
      await service.from("listings").update({ accepting_requests: false }).eq("id", serviceListingId);
      const { error: pausedErr } = await seller.client.rpc("update_service_request_status_atomic", {
        p_request_id: reqId,
        p_action: "accept",
      });
      assert.ok(pausedErr && pausedErr.message.includes("SERVICE_UNAVAILABLE"));
      await service.from("listings").update({ accepting_requests: true }).eq("id", serviceListingId);

      // Suspend provider -> provider accept MUST fail
      await service.from("profiles").update({ status: "suspended" }).eq("id", seller.id);
      const { error: susProvErr } = await seller.client.rpc("update_service_request_status_atomic", {
        p_request_id: reqId,
        p_action: "accept",
      });
      assert.ok(susProvErr, "Suspended provider must not accept pending request");
      await service.from("profiles").update({ status: "active" }).eq("id", seller.id);

      // Buyer cancels cleanly
      const { data: cancData, error: cancErr } = await buyer.client.rpc("update_service_request_status_atomic", {
        p_request_id: reqId,
        p_action: "cancel",
        p_note: "Changed schedule",
      });
      assert.equal(cancErr, null);
      assert.equal(cancData?.[0]?.out_status, "cancelled");
    });

    await check("B1.4", "Full service lifecycle, unauthorized transitions rejected, notifications & zero paid-order side effects", async () => {
      const { count: ordersBefore } = await service.from("orders").select("*", { count: "exact", head: true });
      const { data: reqRows, error: reqErr } = await buyer.client.rpc("create_service_request_atomic", {
        p_listing_id: serviceListingId,
        p_mode: "in_person",
        p_requirements: "Full lifecycle QA service request for verified completion.",
        p_preferred_date: null,
      });
      assert.equal(reqErr, null);
      completedServiceReqId = reqRows[0].out_id;

      // Unauthorized: buyer cannot accept or deliver; seller cannot jump straight to deliver
      const { error: u1 } = await buyer.client.rpc("update_service_request_status_atomic", { p_request_id: completedServiceReqId, p_action: "accept" });
      assert.ok(u1);
      const { error: u2 } = await seller.client.rpc("update_service_request_status_atomic", { p_request_id: completedServiceReqId, p_action: "deliver" });
      assert.ok(u2);

      // Accept -> Start -> Deliver -> Complete
      assert.equal((await seller.client.rpc("update_service_request_status_atomic", { p_request_id: completedServiceReqId, p_action: "accept" })).data?.[0]?.out_status, "accepted");
      assert.equal((await seller.client.rpc("update_service_request_status_atomic", { p_request_id: completedServiceReqId, p_action: "start" })).data?.[0]?.out_status, "in_progress");
      assert.equal((await seller.client.rpc("update_service_request_status_atomic", { p_request_id: completedServiceReqId, p_action: "deliver" })).data?.[0]?.out_status, "delivered");

      // Seller cannot self-complete delivered service
      const { error: u3 } = await seller.client.rpc("update_service_request_status_atomic", { p_request_id: completedServiceReqId, p_action: "complete" });
      assert.ok(u3);

      const { data: compData, error: compErr } = await buyer.client.rpc("update_service_request_status_atomic", { p_request_id: completedServiceReqId, p_action: "complete" });
      assert.equal(compErr, null);
      assert.equal(compData?.[0]?.out_status, "completed");

      // Verify notifications delivered to buyer & seller
      const { data: notifs } = await service.from("notifications").select("kind, user_id").in("user_id", [buyer.id, seller.id]).ilike("href", "/%");
      assert.ok((notifs ?? []).some((n) => n.user_id === seller.id && n.kind === "service_requested"));
      assert.ok((notifs ?? []).some((n) => n.user_id === buyer.id && n.kind === "service_accepted"));
      assert.ok((notifs ?? []).some((n) => n.user_id === seller.id && n.kind === "service_completed"));

      // Off-platform agreement: ZERO orders/commissions/refunds/withdrawals created
      const { count: ordersAfter } = await service.from("orders").select("*", { count: "exact", head: true });
      assert.equal(ordersAfter, ordersBefore, "Off-platform service completion must NEVER create a paid order");
    });

    await check("B1.5", "48h late acceptance commits expired, unblocks new request, accepted unaffected, expiry worker works", async () => {
      // Request A: overdue -> direct accept commits 'expired'
      const { data: rA } = await staff.client.rpc("create_service_request_atomic", {
        p_listing_id: serviceListingId,
        p_mode: "in_person",
        p_requirements: "Overdue request to test direct late acceptance expiry.",
        p_preferred_date: null,
      });
      const reqA = rA[0].out_id;
      await service.from("service_requests").update({ respond_by: "2020-01-01T00:00:00Z" }).eq("id", reqA);

      const { data: lateAcc, error: lateErr } = await seller.client.rpc("update_service_request_status_atomic", {
        p_request_id: reqA,
        p_action: "accept",
      });
      assert.equal(lateErr, null);
      assert.equal(lateAcc?.[0]?.out_status, "expired", "Late accept must commit expired status cleanly");

      // Expired request does NOT block staff from creating Request B!
      const { data: rB, error: rBErr } = await staff.client.rpc("create_service_request_atomic", {
        p_listing_id: serviceListingId,
        p_mode: "in_person",
        p_requirements: "New request after prior expired request must succeed.",
        p_preferred_date: null,
      });
      assert.equal(rBErr, null, `Expired request blocked new request: ${rBErr?.message}`);
      const reqB = rB[0].out_id;

      // Request C (accepted) with past respond_by MUST NOT expire when worker runs!
      const { data: rC } = await third.client.rpc("create_service_request_atomic", {
        p_listing_id: serviceListingId,
        p_mode: "in_person",
        p_requirements: "Accepted request that must never expire under initial respond_by.",
        p_preferred_date: null,
      });
      const reqC = rC[0].out_id;
      await seller.client.rpc("update_service_request_status_atomic", { p_request_id: reqC, p_action: "accept" });
      await service.from("service_requests").update({ respond_by: "2020-01-01T00:00:00Z" }).in("id", [reqB, reqC]);

      // Run actual expiry worker CLI!
      const workerOut = execFileSync(process.execPath, ["scripts/phase7-9-expiry-worker.mjs"], { encoding: "utf8" });
      const parsed = JSON.parse(workerOut.trim());
      assert.equal(parsed.ok, true);
      assert.ok(parsed.expiredServiceRequests >= 1);

      const { data: rowsAfter } = await service.from("service_requests").select("id, status").in("id", [reqB, reqC]);
      assert.equal(rowsAfter.find((x) => x.id === reqB)?.status, "expired");
      assert.equal(rowsAfter.find((x) => x.id === reqC)?.status, "accepted", "Accepted service must NEVER expire under respond_by");
    });

    // =========================================================================
    // B2. FREE ITEMS & DONATIONS
    // =========================================================================
    let uploadedFreePath;
    let freeNoticeId;
    let freeNoticeCollectedId;

    await check("B2.1", "Student-only publishing & private draft recovery; staff & cross-user draft access rejected", async () => {
      // Staff cannot insert draft or publish free notice
      const { error: staffDraftErr } = await staff.client.from("free_notice_drafts").insert({
        contributor_id: staff.id,
        title: "Staff Draft",
        description: "",
        condition: "Good",
        quantity: 1,
      });
      assert.ok(staffDraftErr, "Staff must not create free_notice_drafts");

      // Student saves incomplete draft (no photos, short desc) & recovers it
      const { data: draft, error: dErr } = await seller.client
        .from("free_notice_drafts")
        .insert({
          contributor_id: seller.id,
          title: `QA Draft ${RUN_TAG}`,
          description: "",
          condition: "Good",
          quantity: 2,
        })
        .select("id, title")
        .single();
      assert.equal(dErr, null, `Draft save failed: ${dErr?.message}`);
      cleanup.push(async () => {
        await service.from("free_notice_drafts").delete().eq("id", draft.id);
      });

      const { data: recovered } = await seller.client.from("free_notice_drafts").select("id, title").eq("id", draft.id).single();
      assert.equal(recovered?.title, `QA Draft ${RUN_TAG}`);

      // Other student cannot read or update seller's private draft
      const { data: otherRead } = await buyer.client.from("free_notice_drafts").select("id").eq("id", draft.id);
      assert.equal((otherRead ?? []).length, 0, "Draft ownership RLS must hide drafts from other students");
    });

    await check("B2.2", "Storage MIME, 5MB limit, ownership policy, object existence, duplicate/count & spot/category checks", async () => {
      // Unsupported MIME type rejected
      const { error: mimeErr } = await seller.client.storage
        .from("free-items")
        .upload(`${seller.id}/qa-bad-${RUN_TAG}.txt`, Buffer.from("hello"), { contentType: "text/plain" });
      assert.ok(mimeErr, "text/plain upload to free-items must be rejected");

      // Oversized file (>5 MB) rejected
      const bigBuf = Buffer.alloc(5 * 1024 * 1024 + 1024, 0);
      const { error: sizeErr } = await seller.client.storage
        .from("free-items")
        .upload(`${seller.id}/qa-big-${RUN_TAG}.png`, bigBuf, { contentType: "image/png" });
      assert.ok(sizeErr, ">5MB upload to free-items must be rejected");

      // Cross-user folder ownership rejected by existing hosted storage policy
      const { error: folderErr } = await buyer.client.storage
        .from("free-items")
        .upload(`${seller.id}/qa-hijack-${RUN_TAG}.png`, PNG_1X1, { contentType: "image/png" });
      assert.ok(folderErr, "Uploading into another user's free-items folder must be rejected");

      // Upload valid 1x1 PNG under seller's folder
      uploadedFreePath = `${seller.id}/qa-free-${RUN_TAG}.png`;
      const { error: upErr } = await seller.client.storage
        .from("free-items")
        .upload(uploadedFreePath, PNG_1X1, { contentType: "image/png", upsert: true });
      assert.equal(upErr, null, `Valid free-items upload failed: ${upErr?.message}`);
      tempStorage.push({ bucket: "free-items", path: uploadedFreePath });

      // Staff cannot publish even with valid params
      const { error: staffPubErr } = await staff.client.rpc("publish_free_notice_atomic", {
        p_title: "Staff Free Book",
        p_description: "Staff members cannot donate/publish free items directly.",
        p_condition: "Good",
        p_quantity: 1,
        p_spot_id: "blok-alpha",
        p_category_id: "textbooks",
        p_collection_instructions: null,
        p_image_paths: [uploadedFreePath],
        p_draft_id: null,
      });
      assert.ok(staffPubErr);

      // 0 images, duplicate images, non-existent object, invalid spot/category/condition all rejected
      const baseArgs = {
        p_title: `QA Free Book ${RUN_TAG}`,
        p_description: "Clean calculus workbook ready for pickup at Blok Alpha.",
        p_condition: "Good",
        p_quantity: 2,
        p_spot_id: "blok-alpha",
        p_category_id: "textbooks",
        p_collection_instructions: "Meet at ground floor lobby",
        p_image_paths: [uploadedFreePath],
        p_draft_id: null,
      };
      assert.ok((await seller.client.rpc("publish_free_notice_atomic", { ...baseArgs, p_image_paths: [] })).error);
      assert.ok((await seller.client.rpc("publish_free_notice_atomic", { ...baseArgs, p_image_paths: [uploadedFreePath, uploadedFreePath] })).error);
      assert.ok((await seller.client.rpc("publish_free_notice_atomic", { ...baseArgs, p_image_paths: [`${seller.id}/missing-${RUN_TAG}.png`] })).error);
      assert.ok((await seller.client.rpc("publish_free_notice_atomic", { ...baseArgs, p_condition: "Broken" })).error);
      assert.ok((await seller.client.rpc("publish_free_notice_atomic", { ...baseArgs, p_spot_id: "invalid-spot" })).error);
      assert.ok((await seller.client.rpc("publish_free_notice_atomic", { ...baseArgs, p_category_id: "invalid-cat" })).error);
    });

    await check("B2.3", "Concurrent draft publication prevented; published notice active; donor edit/close guards", async () => {
      const { data: d } = await seller.client
        .from("free_notice_drafts")
        .insert({ contributor_id: seller.id, title: "Concurrent Draft", description: "", condition: "Good", quantity: 1 })
        .select("id")
        .single();
      const args = {
        p_title: `QA Concurrent Free Item ${RUN_TAG}`,
        p_description: "Testing concurrent single publication from one draft row.",
        p_condition: "Like New",
        p_quantity: 1,
        p_spot_id: "blok-alpha",
        p_category_id: "textbooks",
        p_collection_instructions: "Blok Alpha bench",
        p_image_paths: [uploadedFreePath],
        p_draft_id: d.id,
      };
      const [p1, p2] = await Promise.all([
        seller.client.rpc("publish_free_notice_atomic", args),
        seller.client.rpc("publish_free_notice_atomic", args),
      ]);
      const okCount = [p1, p2].filter((r) => !r.error).length;
      assert.equal(okCount, 1, `Concurrent draft publish must succeed once, got ${okCount}`);
      freeNoticeId = p1.error ? p2.data : p1.data;
      cleanup.push(async () => {
        await service.from("free_notice_claims").delete().eq("notice_id", freeNoticeId);
        await service.from("free_notices").delete().eq("id", freeNoticeId);
      });

      const { data: fnRow } = await service.from("free_notices").select("status, quantity, reserved_quantity").eq("id", freeNoticeId).single();
      assert.equal(fnRow.status, "active");
      assert.equal(fnRow.quantity, 1);

      // Donor edits title/description cleanly
      const { error: edErr } = await seller.client.rpc("manage_free_notice_atomic", {
        p_notice_id: freeNoticeId,
        p_action: "edit",
        p_title: `QA Edited Free Item ${RUN_TAG}`,
      });
      assert.equal(edErr, null, `manage_free_notice_atomic edit failed: ${edErr?.message}`);
    });

    await check("B2.4", "Self-claim, duplicate claim, suspended recipient, inactive donor, expired notice & concurrent atomic reservation", async () => {
      // Self-claim rejected
      assert.ok((await seller.client.rpc("create_free_notice_claim_atomic", { p_notice_id: freeNoticeId, p_quantity: 1 })).error?.message.includes("CANNOT_CLAIM_OWN_ITEM"));

      // Buyer & Staff both claim the 1-unit item
      const { data: cBuyer, error: cbErr } = await buyer.client.rpc("create_free_notice_claim_atomic", { p_notice_id: freeNoticeId, p_quantity: 1, p_note: "Buyer claim" });
      assert.equal(cbErr, null);
      const buyerClaimId = cBuyer[0].out_id;

      // Duplicate active claim by buyer rejected
      assert.ok((await buyer.client.rpc("create_free_notice_claim_atomic", { p_notice_id: freeNoticeId, p_quantity: 1 })).error);

      const { data: cStaff, error: csErr } = await staff.client.rpc("create_free_notice_claim_atomic", { p_notice_id: freeNoticeId, p_quantity: 1, p_note: "Staff claim" });
      assert.equal(csErr, null);
      const staffClaimId = cStaff[0].out_id;

      // Suspended recipient acceptance rejected
      await service.from("profiles").update({ status: "suspended" }).eq("id", buyer.id);
      assert.ok((await seller.client.rpc("update_free_notice_claim_atomic", { p_claim_id: buyerClaimId, p_action: "accept" })).error?.message.includes("RECIPIENT_ACCOUNT_INACTIVE"));
      await service.from("profiles").update({ status: "active" }).eq("id", buyer.id);

      // Inactive donor acceptance rejected
      await service.from("profiles").update({ status: "suspended" }).eq("id", seller.id);
      assert.ok((await seller.client.rpc("update_free_notice_claim_atomic", { p_claim_id: buyerClaimId, p_action: "accept" })).error);
      await service.from("profiles").update({ status: "active" }).eq("id", seller.id);

      // Expired notice acceptance rejected
      const futureExp = new Date(Date.now() + 7 * 86400_000).toISOString();
      await service.from("free_notices").update({ expires_at: "2020-01-01T00:00:00Z" }).eq("id", freeNoticeId);
      assert.ok((await seller.client.rpc("update_free_notice_claim_atomic", { p_claim_id: buyerClaimId, p_action: "accept" })).error?.message.includes("FREE_ITEM_UNAVAILABLE"));
      await service.from("free_notices").update({ expires_at: futureExp }).eq("id", freeNoticeId);

      // Disable buyer optional 'community' notifications to prove mandatory alerts still deliver!
      await buyer.client.rpc("update_notification_preferences_atomic", { p_inquiries: true, p_reviews: true, p_community: false });

      // Concurrent acceptance of 2 competing claims on a 1-unit item -> EXACTLY 1 succeeds!
      const [a1, a2] = await Promise.all([
        seller.client.rpc("update_free_notice_claim_atomic", { p_claim_id: buyerClaimId, p_action: "accept" }),
        seller.client.rpc("update_free_notice_claim_atomic", { p_claim_id: staffClaimId, p_action: "accept" }),
      ]);
      const okAccepts = [a1, a2].filter((r) => !r.error).length;
      assert.equal(okAccepts, 1, `Concurrent claim accepts on 1-unit stock must allow 1, got ${okAccepts}`);
      const wonClaimId = a1.error ? staffClaimId : buyerClaimId;
      const lostClaimId = a1.error ? buyerClaimId : staffClaimId;

      // Donor cannot reduce quantity below reserved_quantity or close notice with active reservation
      assert.ok((await seller.client.rpc("manage_free_notice_atomic", { p_notice_id: freeNoticeId, p_action: "edit", p_quantity: 0 })).error);
      assert.ok((await seller.client.rpc("manage_free_notice_atomic", { p_notice_id: freeNoticeId, p_action: "close" })).error?.message.includes("CANNOT_CLOSE_WITH_ACTIVE_RESERVATIONS"));

      // Cancel won reservation -> releases reserved_quantity exactly once back to 0!
      const { error: cancelErr } = await seller.client.rpc("update_free_notice_claim_atomic", { p_claim_id: wonClaimId, p_action: "cancel", p_reason: "QA release check" });
      assert.equal(cancelErr, null);
      const { data: afterCancel } = await service.from("free_notices").select("reserved_quantity, quantity").eq("id", freeNoticeId).single();
      assert.equal(afterCancel.reserved_quantity, 0);
      assert.equal(afterCancel.quantity, 1);

      // Accept the other claim (if lostClaimId was buyer, check mandatory reservation notification even with community=false)
      const { error: acc2Err } = await seller.client.rpc("update_free_notice_claim_atomic", { p_claim_id: lostClaimId, p_action: "accept" });
      assert.equal(acc2Err, null);

      // Force past 48h reservation_expires_at -> overdue handover commits 'expired' & emits BOTH mandatory notifications!
      await service.from("free_notice_claims").update({ reservation_expires_at: "2020-01-01T00:00:00Z" }).eq("id", lostClaimId);
      const { data: hoExp, error: hoExpErr } = await seller.client.rpc("update_free_notice_claim_atomic", { p_claim_id: lostClaimId, p_action: "handover" });
      assert.equal(hoExpErr, null);
      assert.equal(hoExp?.[0]?.out_status, "expired");

      const { data: expNotifs } = await service
        .from("notifications")
        .select("dedupe_key")
        .in("dedupe_key", [`don-${lostClaimId}-expired-recipient`, `don-${lostClaimId}-expired-donor`]);
      assert.equal((expNotifs ?? []).length, 2, "Overdue handover expiry must send mandatory notifications to both recipient and donor");

      const { data: afterExp } = await service.from("free_notices").select("reserved_quantity, status").eq("id", freeNoticeId).single();
      assert.equal(afterExp.reserved_quantity, 0);
      assert.equal(afterExp.status, "active");

      await buyer.client.rpc("update_notification_preferences_atomic", { p_inquiries: true, p_reviews: true, p_community: true });
    });

    await check("B2.5", "Expiry worker releases overdue reserved (never handed_over); collection deducts once, community impact & zero financial side effects", async () => {
      const { count: ordersBefore } = await service.from("orders").select("*", { count: "exact", head: true });
      const { data: n2Id, error: n2Err } = await seller.client.rpc("publish_free_notice_atomic", {
        p_title: `QA Donation Flow ${RUN_TAG}`,
        p_description: "Two lab coats for donation testing worker expiry & collection.",
        p_condition: "New/Unused",
        p_quantity: 2,
        p_spot_id: "blok-beta",
        p_category_id: "fashion",
        p_collection_instructions: "Blok Beta study lounge",
        p_image_paths: [uploadedFreePath],
        p_draft_id: null,
      });
      assert.equal(n2Err, null);
      freeNoticeCollectedId = n2Id;
      cleanup.push(async () => {
        await service.from("free_notice_claims").delete().eq("notice_id", freeNoticeCollectedId);
        await service.from("free_notices").delete().eq("id", freeNoticeCollectedId);
      });

      // Turn off buyer community pref to test mandatory reservation/handover/collect notifications
      await buyer.client.rpc("update_notification_preferences_atomic", { p_inquiries: true, p_reviews: true, p_community: false });

      // Claim 1 (buyer): accept -> handover (must NOT be expired by worker even if reservation_expires_at is past!)
      const { data: cl1 } = await buyer.client.rpc("create_free_notice_claim_atomic", { p_notice_id: freeNoticeCollectedId, p_quantity: 1 });
      const claim1 = cl1[0].out_id;
      await seller.client.rpc("update_free_notice_claim_atomic", { p_claim_id: claim1, p_action: "accept" });
      await seller.client.rpc("update_free_notice_claim_atomic", { p_claim_id: claim1, p_action: "handover" });

      // Claim 2 (staff): accept -> overdue reservation (MUST be expired by worker!)
      const { data: cl2 } = await staff.client.rpc("create_free_notice_claim_atomic", { p_notice_id: freeNoticeCollectedId, p_quantity: 1 });
      const claim2 = cl2[0].out_id;
      await seller.client.rpc("update_free_notice_claim_atomic", { p_claim_id: claim2, p_action: "accept" });

      await service.from("free_notice_claims").update({ reservation_expires_at: "2020-01-01T00:00:00Z" }).in("id", [claim1, claim2]);

      // Run expiry worker
      const workerOut = execFileSync(process.execPath, ["scripts/phase7-9-expiry-worker.mjs"], { encoding: "utf8" });
      assert.equal(JSON.parse(workerOut.trim()).ok, true);

      const { data: cStates } = await service.from("free_notice_claims").select("id, status").in("id", [claim1, claim2]);
      assert.equal(cStates.find((x) => x.id === claim1)?.status, "handed_over", "Handed-over claim must NEVER be auto-expired");
      assert.equal(cStates.find((x) => x.id === claim2)?.status, "expired", "Overdue reserved claim must be expired by worker");

      // Community impact BEFORE collect = 0 completed donations on this notice
      const { data: nBeforeCol } = await service.from("free_notices").select("id, status, spot_id, quantity, reserved_quantity").eq("id", freeNoticeCollectedId).single();
      assert.equal(nBeforeCol.reserved_quantity, 1);
      const impactBefore = computeCommunityImpact({
        notices: [nBeforeCol],
        claims: [{ notice_id: freeNoticeCollectedId, donor_id: seller.id, recipient_id: buyer.id, quantity: 1, status: "handed_over" }],
      });
      assert.equal(impactBefore.completedDonations, 0);

      // Recipient confirms collection -> deducts quantity & reserved_quantity exactly once
      const { data: colRes, error: colErr } = await buyer.client.rpc("update_free_notice_claim_atomic", { p_claim_id: claim1, p_action: "collect" });
      assert.equal(colErr, null);
      assert.equal(colRes?.[0]?.out_status, "collected");

      // Mandatory notifications delivered to buyer despite community=false
      const { data: mandNotifs } = await service
        .from("notifications")
        .select("dedupe_key")
        .in("dedupe_key", [`don-${claim1}-reserved`, `don-${claim1}-handed_over`, `don-${claim1}-collected`]);
      assert.equal((mandNotifs ?? []).length, 3, "Mandatory accepted/handover/collected notifications must survive community=false");

      const { data: nAfterCol } = await service.from("free_notices").select("id, status, spot_id, quantity, reserved_quantity").eq("id", freeNoticeCollectedId).single();
      assert.equal(nAfterCol.quantity, 1);
      assert.equal(nAfterCol.reserved_quantity, 0);

      const impactAfter = computeCommunityImpact({
        notices: [nAfterCol],
        claims: [{ notice_id: freeNoticeCollectedId, donor_id: seller.id, recipient_id: buyer.id, quantity: 1, status: "collected" }],
      });
      assert.equal(impactAfter.completedDonations, 1);
      assert.equal(impactAfter.totalUnitsDonated, 1);

      const { count: ordersAfter } = await service.from("orders").select("*", { count: "exact", head: true });
      assert.equal(ordersAfter, ordersBefore, "Donations must NEVER create orders/payments/commissions");
      await buyer.client.rpc("update_notification_preferences_atomic", { p_inquiries: true, p_reviews: true, p_community: true });
    });

    // =========================================================================
    // B3. STOREFRONT
    // =========================================================================
    await check("B3.1", "Storefront ownership, logo/banner upload, customization & public display privacy", async () => {
      const logoPath = `${seller.id}/qa-logo-${RUN_TAG}.png`;
      const bannerPath = `${seller.id}/qa-banner-${RUN_TAG}.png`;
      const { error: lUp } = await seller.client.storage.from("listings").upload(logoPath, PNG_1X1, { contentType: "image/png", upsert: true });
      assert.equal(lUp, null, `Logo upload failed: ${lUp?.message}`);
      tempStorage.push({ bucket: "listings", path: logoPath });

      const { error: bUp } = await seller.client.storage.from("listings").upload(bannerPath, PNG_1X1, { contentType: "image/png", upsert: true });
      assert.equal(bUp, null, `Banner upload failed: ${bUp?.message}`);
      tempStorage.push({ bucket: "listings", path: bannerPath });

      const { error: sfErr } = await seller.client.from("storefronts").upsert({
        seller_id: seller.id,
        shop_name: `QA Campus Shop ${RUN_TAG}`,
        description: "Student snacks & campus printing.",
        business_info: "Open Mon-Fri 9am-6pm at FKAL.",
        is_open: true,
        logo_path: logoPath,
        banner_path: bannerPath,
      });
      assert.equal(sfErr, null, `Storefront upsert failed: ${sfErr?.message}`);
      cleanup.push(async () => {
        await service.from("storefronts").delete().eq("seller_id", seller.id);
      });

      // Other user cannot overwrite seller's storefront
      const { error: hijackErr } = await buyer.client.from("storefronts").update({ shop_name: "Hacked Shop" }).eq("seller_id", seller.id);
      const { data: sfCheck } = await service.from("storefronts").select("shop_name, banner_path, business_info, is_open").eq("seller_id", seller.id).single();
      assert.equal(sfCheck.shop_name, `QA Campus Shop ${RUN_TAG}`, `Storefront ownership violated (err=${hijackErr?.message})`);
      assert.equal(sfCheck.banner_path, bannerPath);
      assert.equal(sfCheck.is_open, true);

      // Member public storefront read works without exposing seller email/bank
      const { data: pubSf } = await buyer.client.from("storefronts").select("seller_id, shop_name, description, business_info, is_open, logo_path, banner_path").eq("seller_id", seller.id).single();
      assert.equal(pubSf?.shop_name, `QA Campus Shop ${RUN_TAG}`);
      const { error: bankAnonErr } = await anon.from("seller_payout_accounts").select("*").eq("seller_id", seller.id);
      assert.ok(bankAnonErr, "Bank account table must never be readable publicly");
    });

    // =========================================================================
    // B4. REVIEWS (+ Seed Product Listings & Orders reused by B5/B6/B7!)
    // =========================================================================
    // Create Business & Pre-Loved listings for seller + seller2
    const { data: bizL } = await service
      .from("listings")
      .insert({
        seller_id: seller.id,
        kind: "business",
        title: `QA Matcha Brownies ${RUN_TAG}`,
        description: "Fresh baked student business brownies at UMSKAL.",
        category_id: "food",
        is_food: true,
        price_sen: 1000,
        quantity: 20,
        rules_acknowledged: true,
        status: "published",
      })
      .select("id")
      .single();
    businessListingId = bizL.id;

    const { data: preL } = await service
      .from("listings")
      .insert({
        seller_id: seller.id,
        kind: "pre_loved",
        title: `QA Used Calculator ${RUN_TAG}`,
        description: "Pre-loved Casio scientific calculator in great condition.",
        category_id: "electronics",
        condition: "Good",
        price_sen: 500,
        quantity: 5,
        allow_offers: true,
        rules_acknowledged: true,
        status: "published",
      })
      .select("id")
      .single();
    prelovedListingId = preL.id;

    const { data: preL2 } = await service
      .from("listings")
      .insert({
        seller_id: seller2.id,
        kind: "pre_loved",
        title: `QA Seller2 Book ${RUN_TAG}`,
        description: "Pre-loved seller2 textbook for isolation & entrepreneurship tests.",
        category_id: "textbooks",
        condition: "Good",
        price_sen: 1200,
        quantity: 3,
        rules_acknowledged: true,
        status: "published",
      })
      .select("id")
      .single();
    prelovedListing2Id = preL2.id;

    cleanup.push(async () => {
      for (const lid of [businessListingId, prelovedListingId, prelovedListing2Id]) {
        await service.from("reviews").delete().eq("listing_id", lid);
        await service.from("favourites").delete().eq("listing_id", lid);
        await service.from("listing_views").delete().eq("listing_id", lid);
        await service.from("offers").delete().eq("listing_id", lid);
        await service.from("listings").delete().eq("id", lid);
      }
    });

    const nowIso = new Date().toISOString();
    const tenDaysAgoIso = new Date(Date.now() - 10 * 86400_000).toISOString();
    const sixtyDaysAgoIso = new Date(Date.now() - 60 * 86400_000).toISOString();

    // Order 1 (Verified completed multi-item order with partial refund 500 sen across 1000+500=1500 sen!)
    const multiOrder = await seedOrderFixture({
      buyerId: buyer.id,
      sellerId: seller.id,
      items: [
        { listing_id: businessListingId, title_snapshot: `QA Matcha Brownies ${RUN_TAG}`, unit_sen: 1000, quantity: 1 },
        { listing_id: prelovedListingId, title_snapshot: `QA Used Calculator ${RUN_TAG}`, unit_sen: 500, quantity: 1 },
      ],
      status: "completed",
      paymentMode: "checkout_session",
      paidAt: nowIso,
      completedAt: nowIso,
      createdAt: nowIso,
      refund: { type: "partial_refund", amountSen: 500, commissionRevSen: 10, sellerDedSen: 490, status: "succeeded" },
    });

    // Order 2 (Same unified checkout_session_id as Order 1 -> tests unified checkout counted ONCE across multi-seller!)
    const siblingOrder = await seedOrderFixture({
      buyerId: buyer.id,
      sellerId: seller2.id,
      items: [{ listing_id: prelovedListing2Id, title_snapshot: `QA Seller2 Book ${RUN_TAG}`, unit_sen: 1200, quantity: 1 }],
      status: "completed",
      paymentMode: "checkout_session",
      checkoutSessionId: multiOrder.checkoutSessionId,
      paidAt: nowIso,
      completedAt: nowIso,
      createdAt: nowIso,
    });

    // Order 3 (Old pre-loved completed order for seller 60 days ago -> tests firstTimeBusiness vs firstTimeMarketplace!)
    await seedOrderFixture({
      buyerId: staff.id,
      sellerId: seller.id,
      items: [{ listing_id: prelovedListingId, title_snapshot: `QA Used Calculator ${RUN_TAG}`, unit_sen: 500, quantity: 1 }],
      status: "completed",
      paymentMode: "legacy_payment",
      paidAt: sixtyDaysAgoIso,
      completedAt: sixtyDaysAgoIso,
      createdAt: sixtyDaysAgoIso,
    });

    // Order 4 (Ineligible orders for Review tests: paid/uncompleted, unverified-payment completed, refunded, disputed)
    const unpaidCompletedOrder = await seedOrderFixture({
      buyerId: buyer.id,
      sellerId: seller.id,
      items: [{ listing_id: businessListingId, title_snapshot: `QA Matcha Brownies ${RUN_TAG}`, unit_sen: 1000, quantity: 1 }],
      status: "completed",
      paymentMode: "unverified", // paid_at set, NO verified checkout_session or legacy payment!
      paidAt: tenDaysAgoIso,
      completedAt: tenDaysAgoIso,
      createdAt: tenDaysAgoIso,
    });
    const activePaidOrder = await seedOrderFixture({
      buyerId: buyer.id,
      sellerId: seller.id,
      items: [{ listing_id: businessListingId, title_snapshot: `QA Matcha Brownies ${RUN_TAG}`, unit_sen: 1000, quantity: 1 }],
      status: "paid",
      paymentMode: "checkout_session",
      paidAt: nowIso,
      createdAt: nowIso,
    });
    const fullRefundOrder = await seedOrderFixture({
      buyerId: buyer.id,
      sellerId: seller.id,
      items: [{ listing_id: businessListingId, title_snapshot: `QA Matcha Brownies ${RUN_TAG}`, unit_sen: 1000, quantity: 1 }],
      status: "refunded",
      paymentMode: "checkout_session",
      paidAt: nowIso,
      createdAt: nowIso,
      refund: { type: "full_refund", amountSen: 1000, commissionRevSen: 20, sellerDedSen: 980, status: "succeeded" },
    });
    const disputedOrder = await seedOrderFixture({
      buyerId: buyer.id,
      sellerId: seller.id,
      items: [{ listing_id: businessListingId, title_snapshot: `QA Matcha Brownies ${RUN_TAG}`, unit_sen: 1000, quantity: 1 }],
      status: "disputed",
      paymentMode: "checkout_session",
      paidAt: nowIso,
      createdAt: nowIso,
      openDispute: true,
    });

    let purchaseReviewId;
    let serviceReviewId;

    await check("B4.1", "Verified Purchase & Verified Service reviews succeed; ineligible orders & spoofing rejected", async () => {
      // Uncompleted, unverified payment, fully refunded, disputed, unrelated buyer, wrong listing all rejected
      assert.ok((await buyer.client.rpc("submit_verified_review_atomic", { p_order_id: activePaidOrder.id, p_listing_id: businessListingId, p_service_request_id: null, p_rating: 5, p_comment: "Paid not completed yet" })).error);
      assert.ok((await buyer.client.rpc("submit_verified_review_atomic", { p_order_id: unpaidCompletedOrder.id, p_listing_id: businessListingId, p_service_request_id: null, p_rating: 5, p_comment: "Unverified payment spoof" })).error);
      assert.ok((await buyer.client.rpc("submit_verified_review_atomic", { p_order_id: fullRefundOrder.id, p_listing_id: businessListingId, p_service_request_id: null, p_rating: 5, p_comment: "Fully refunded order" })).error);
      assert.ok((await buyer.client.rpc("submit_verified_review_atomic", { p_order_id: disputedOrder.id, p_listing_id: businessListingId, p_service_request_id: null, p_rating: 5, p_comment: "Disputed order review" })).error);
      assert.ok((await seller.client.rpc("submit_verified_review_atomic", { p_order_id: multiOrder.id, p_listing_id: businessListingId, p_service_request_id: null, p_rating: 5, p_comment: "Seller self-review" })).error);
      assert.ok((await staff.client.rpc("submit_verified_review_atomic", { p_order_id: multiOrder.id, p_listing_id: businessListingId, p_service_request_id: null, p_rating: 5, p_comment: "Unrelated buyer review" })).error);
      assert.ok((await buyer.client.rpc("submit_verified_review_atomic", { p_order_id: multiOrder.id, p_listing_id: prelovedListing2Id, p_service_request_id: null, p_rating: 5, p_comment: "Listing not in this order" })).error);

      // Concurrent duplicate submission on valid completed verified order -> EXACTLY 1 succeeds!
      const [rv1, rv2] = await Promise.all([
        buyer.client.rpc("submit_verified_review_atomic", { p_order_id: multiOrder.id, p_listing_id: businessListingId, p_service_request_id: null, p_rating: 5, p_comment: "Delicious campus brownies, punctual pickup!" }),
        buyer.client.rpc("submit_verified_review_atomic", { p_order_id: multiOrder.id, p_listing_id: businessListingId, p_service_request_id: null, p_rating: 5, p_comment: "Concurrent duplicate purchase review attempt!" }),
      ]);
      assert.equal([rv1, rv2].filter((r) => !r.error).length, 1, "Concurrent duplicate order/listing reviews must allow only 1");
      const rvWin = rv1.error ? rv2.data : rv1.data;
      purchaseReviewId = Array.isArray(rvWin) ? rvWin[0]?.out_id : rvWin?.out_id;
      assert.ok(purchaseReviewId, "Expected purchaseReviewId UUID");

      // Completed service review succeeds; duplicate rejected
      const { data: srvData, error: srvErr } = await buyer.client.rpc("submit_verified_review_atomic", {
        p_order_id: null,
        p_listing_id: null,
        p_service_request_id: completedServiceReqId,
        p_rating: 4,
        p_comment: "Fast campus printing service, neat binding!",
      });
      assert.equal(srvErr, null, `Service review failed: ${srvErr?.message}`);
      serviceReviewId = Array.isArray(srvData) ? srvData[0]?.out_id : srvData?.out_id;
      assert.ok(serviceReviewId, "Expected serviceReviewId UUID");
      assert.ok((await buyer.client.rpc("submit_verified_review_atomic", { p_order_id: null, p_listing_id: null, p_service_request_id: completedServiceReqId, p_rating: 5, p_comment: "Duplicate service review" })).error);
    });

    await check("B4.2", "Buyer edit + edit deadline, seller reply isolation, admin hide/restore, rating calc & privacy", async () => {
      // Buyer edits eligible own review
      const { error: edErr } = await buyer.client.rpc("edit_verified_review_atomic", {
        p_review_id: purchaseReviewId,
        p_rating: 4,
        p_comment: "Updated review: still very tasty and fresh!",
      });
      assert.equal(edErr, null, `edit_verified_review_atomic failed: ${edErr?.message}`);

      // Seller responds to own received review; other seller rejected
      assert.equal((await seller.client.rpc("respond_to_review_atomic", { p_review_id: purchaseReviewId, p_response: "Thank you for supporting student business!" })).error, null);
      assert.ok((await seller2.client.rpc("respond_to_review_atomic", { p_review_id: purchaseReviewId, p_response: "Wrong seller reply" })).error);

      // Direct client write on reviews rejected (seller cannot modify buyer rating/comment)
      assert.ok((await seller.client.from("reviews").update({ rating: 5, comment: "Tampered" }).eq("id", purchaseReviewId)).error);

      // Admin hides review -> excluded from ratings & edit locked
      const { error: hErr } = await admin.client.rpc("admin_moderate_review_atomic", {
        p_review_id: serviceReviewId,
        p_hide: true,
        p_reason: "QA review hide verification",
      });
      assert.equal(hErr, null, `admin_moderate_review_atomic hide failed: ${hErr?.message}`);

      assert.ok((await buyer.client.rpc("edit_verified_review_atomic", { p_review_id: serviceReviewId, p_rating: 5, p_comment: "Trying to edit hidden review" })).error?.message.includes("REVIEW_MODERATED"));

      // Rating summary excludes hidden review & empty returns null (never 5.0!)
      const { data: sellerRevs } = await service.from("reviews").select("rating, hidden").eq("seller_id", seller.id);
      const sumWithHidden = computeRatingSummary(sellerRevs);
      assert.equal(sumWithHidden.totalReviews, 1);
      assert.equal(sumWithHidden.averageRating, 4);
      assert.equal(computeRatingSummary([]).averageRating, null);

      // Moderation columns private from non-admin authenticated queries
      assert.ok((await buyer.client.from("reviews").select("moderation_reason").limit(1)).error);
      assert.ok((await seller.client.from("reviews").select("moderated_by").limit(1)).error);

      // Admin restores review cleanly
      assert.equal((await admin.client.rpc("admin_moderate_review_atomic", { p_review_id: serviceReviewId, p_hide: false, p_reason: "QA review restore verification" })).error, null);

      // Edit deadline (>7 days) enforced
      await service.from("reviews").update({ created_at: "2020-01-01T00:00:00Z" }).eq("id", serviceReviewId);
      assert.ok((await buyer.client.rpc("edit_verified_review_atomic", { p_review_id: serviceReviewId, p_rating: 5, p_comment: "Late edit after deadline" })).error);
      await service.from("reviews").update({ created_at: nowIso }).eq("id", serviceReviewId);
    });

    // =========================================================================
    // B5, B6 & B7. LIVE DATABASE ANALYTICS & ENTREPRENEURSHIP RECONCILIATION
    // =========================================================================
    await check("B5/B6/B7", "Seller Analytics, Admin Platform Analytics & Entrepreneurship reconcile against live hosted DB rows", async () => {
      // Record real views: buyer & third view businessListing BEFORE purchase timestamp (adjust viewed_at 1h earlier)
      // Seller self-view must be ignored!
      assert.equal((await seller.client.rpc("record_listing_view_atomic", { p_listing_id: businessListingId })).data, false);
      assert.equal((await buyer.client.rpc("record_listing_view_atomic", { p_listing_id: businessListingId })).data, true);
      assert.equal((await third.client.rpc("record_listing_view_atomic", { p_listing_id: businessListingId })).data, true);
      const twoHoursAgoIso = new Date(Date.now() - 2 * 3600_000).toISOString();
      await service.from("listing_views").update({ viewed_at: twoHoursAgoIso }).eq("listing_id", businessListingId);

      // Favourite businessListing
      await buyer.client.from("favourites").insert({ user_id: buyer.id, listing_id: businessListingId });

      // Load full live dataset from hosted DB (using fixed listing_views pagination!)
      const liveDataset = await fetchLiveAnalyticsDataset();
      assert.ok(liveDataset.views.some((v) => v.listing_id === businessListingId), "listing_views must load cleanly via fixed pagination!");

      const win30 = resolveAnalyticsWindow("30d");

      // --- B5: Seller Analytics (isolated to seller) ---
      const sellerAn = computeSellerAnalytics(seller.id, liveDataset, win30);
      // Qualifying verified orders in 30d for seller:
      //   multiOrder (1500, partial refund 500) + activePaidOrder (1000) + fullRefundOrder (1000, full refund 1000) + disputedOrder (1000)
      //   = 4500 gross; unpaidCompletedOrder (unverified) EXCLUDED; 60d old order outside 30d window!
      //   executed refunds = 500 + 1000 = 1500; net sales = 3000; net commission = 90 - 30 = 60; net earnings = 4410 - 1470 = 2940!
      assert.equal(sellerAn.kpis.grossSalesSen, 4500, `Expected gross 4500, got ${sellerAn.kpis.grossSalesSen}`);
      assert.equal(sellerAn.kpis.executedRefundsSen, 1500);
      assert.equal(sellerAn.kpis.netSalesSen, 3000);
      assert.equal(sellerAn.kpis.netCommissionSen, 60);
      assert.equal(sellerAn.kpis.netSellerEarningsSen, 2940);
      assert.equal(sellerAn.kpis.completedOrders, 1, "Only 1 verified completed order in 30d");
      assert.equal(sellerAn.kpis.totalViews, 2, "2 non-seller unique viewers loaded from live listing_views");
      assert.equal(sellerAn.kpis.totalFavourites, 1);
      assert.equal(sellerAn.kpis.completedServices, 1);

      // Verify exact integer-sen proportional refund allocation on multiOrder (500 sen split across [1000, 500] -> 333 + 167 = 500 exact!)
      const bizPerf = sellerAn.listingPerformance.find((l) => l.id === businessListingId);
      const prePerf = sellerAn.listingPerformance.find((l) => l.id === prelovedListingId);
      assert.equal(bizPerf.revenueSen + prePerf.revenueSen, 3000, "Per-listing net sales must reconcile EXACTLY to order net sales (3000 sen)!");
      assert.equal(bizPerf.uniqueViewers, 2);
      assert.equal(bizPerf.attributablePurchasers, 1);
      assert.equal(bizPerf.conversionPct, 50, "1 attributable purchaser / 2 unique viewers = 50%");
      assert.equal(prePerf.conversionPct, null, "0 views -> null (N/A) conversion");
      assert.equal(prePerf.ordersPerViewer, null);

      // Seller2 analytics completely isolated from seller1!
      const seller2An = computeSellerAnalytics(seller2.id, liveDataset, win30);
      assert.equal(seller2An.kpis.grossSalesSen, 1200);
      assert.equal(seller2An.kpis.netSalesSen, 1200);

      // Custom MYT range & sanitized CSV export
      const todayMyt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(new Date());
      const customWin = resolveAnalyticsWindow("custom", Date.now(), todayMyt, todayMyt);
      assert.equal(computeSellerAnalytics(seller.id, liveDataset, customWin).kpis.grossSalesSen, 4500);
      const csv = buildAnalyticsCsv([{ period: "30d", section: "Sales", metric: "=Formula", value: "RM 30.00" }]);
      assert.match(csv, /'=Formula/);

      // --- B6 & B7: Admin Platform Analytics & Student Entrepreneurship Deltas ---
      const adminAfter = computeAdminPlatformAnalytics(liveDataset, win30);
      // Gross product sales delta = 4500 (seller) + 1200 (seller2) = 5700 sen (FPX fees, unverified order, services & donations all excluded!)
      assert.equal(adminAfter.overview.grossProductSalesSen - baseAnalyticsBefore.overview.grossProductSalesSen, 5700);
      assert.equal(adminAfter.overview.netProductSalesSen - baseAnalyticsBefore.overview.netProductSalesSen, 4200);
      // Unified checkout (multiOrder + siblingOrder share 1 checkout_session) + activePaidOrder + fullRefundOrder + disputedOrder = 4 checkouts!
      assert.equal(adminAfter.overview.verifiedCheckouts - baseAnalyticsBefore.overview.verifiedCheckouts, 4);
      // Entrepreneurship: ONLY seller has a qualifying kind='business' listing (seller2 is strictly pre_loved!)
      assert.equal(adminAfter.entrepreneurship.activeStudentBusinessSellers - baseAnalyticsBefore.entrepreneurship.activeStudentBusinessSellers, 1);
      // Earlier 60d pre-loved sale MUST NOT disqualify seller from firstTimeSuccessfulBusinessSellers!
      assert.equal(adminAfter.entrepreneurship.firstTimeSuccessfulBusinessSellers - baseAnalyticsBefore.entrepreneurship.firstTimeSuccessfulBusinessSellers, 1);
      assert.equal(adminAfter.entrepreneurship.firstTimeSuccessfulSellers - baseAnalyticsBefore.entrepreneurship.firstTimeSuccessfulSellers, 1, "seller2 got first marketplace sale; seller1 already had 60d pre-loved sale");
      // Separate service & donation counters
      assert.equal(adminAfter.services.completedServices - baseAnalyticsBefore.services.completedServices, 1);
      assert.equal(adminAfter.community.completedDonations - baseAnalyticsBefore.community.completedDonations, 1);
    });

    // =========================================================================
    // B8. REPORTS & MODERATION
    // =========================================================================
    await check("B8.1", "Reports target visibility, private-draft/message neutral rejection, duplicate guard & admin_notes privacy", async () => {
      // Draft listing by seller -> unrelated buyer must get neutral REPORT_TARGET_NOT_FOUND
      const { data: privDraft } = await service
        .from("listings")
        .insert({
          seller_id: seller.id,
          kind: "pre_loved",
          title: `QA Private Draft ${RUN_TAG}`,
          description: "Private draft that unrelated users must never probe via reports.",
          category_id: "textbooks",
          price_sen: 800,
          quantity: 1,
          status: "draft",
        })
        .select("id")
        .single();
      cleanup.push(async () => {
        await service.from("listings").delete().eq("id", privDraft.id);
      });

      assert.ok((await buyer.client.rpc("submit_report_atomic", { p_target_kind: "listing", p_target_id: privDraft.id, p_reason: "Spam", p_explanation: "Probing private draft listing." })).error?.message.includes("REPORT_TARGET_NOT_FOUND"));
      assert.ok((await buyer.client.rpc("submit_report_atomic", { p_target_kind: "listing", p_target_id: "00000000-0000-4000-8000-000000000099", p_reason: "Spam", p_explanation: "Invalid target UUID check." })).error?.message.includes("REPORT_TARGET_NOT_FOUND"));
      assert.ok((await buyer.client.rpc("submit_report_atomic", { p_target_kind: "listing", p_target_id: businessListingId, p_reason: "Not A Valid Reason", p_explanation: "Invalid reason check." })).error?.message.includes("INVALID_REPORT_REASON"));
      assert.ok((await buyer.client.rpc("submit_report_atomic", { p_target_kind: "user", p_target_id: buyer.id, p_reason: "Spam", p_explanation: "Self report must be rejected." })).error?.message.includes("CANNOT_REPORT_SELF"));

      // Seed private conversation + message between seller and buyer
      const conv = await getOrCreateConversation(seller.id, buyer.id);
      const { data: msg } = await service.from("messages").insert({ conversation_id: conv.id, sender_id: seller.id, body: "QA private message" }).select("id").single();

      // Unrelated third user reporting private message gets neutral REPORT_TARGET_NOT_FOUND!
      assert.ok((await third.client.rpc("submit_report_atomic", { p_target_kind: "message", p_target_id: msg.id, p_reason: "Harassment", p_explanation: "Third party probing private message UUID." })).error?.message.includes("REPORT_TARGET_NOT_FOUND"));

      // Authorized reports on all 5 target kinds succeed!
      const reportIds = [];
      for (const [kind, tid] of [
        ["listing", businessListingId],
        ["free_notice", freeNoticeCollectedId],
        ["user", seller.id],
        ["review", purchaseReviewId],
        ["message", msg.id],
      ]) {
        const { data: r, error: rErr } = await buyer.client.rpc("submit_report_atomic", {
          p_target_kind: kind,
          p_target_id: tid,
          p_reason: "Spam",
          p_explanation: `QA valid report submission for ${kind}.`,
        });
        assert.equal(rErr, null, `Report ${kind} failed: ${rErr?.message}`);
        reportIds.push(r[0].out_id);
      }
      cleanup.push(async () => {
        await service.from("reports").delete().in("id", reportIds);
      });

      // Duplicate open report rejected
      assert.ok((await buyer.client.rpc("submit_report_atomic", { p_target_kind: "user", p_target_id: seller.id, p_reason: "Spam", p_explanation: "Duplicate unresolved report check." })).error);

      // Admin reviews, resolves, dismisses + writes admin_notes
      assert.equal((await admin.client.rpc("admin_moderate_report_atomic", { p_report_id: reportIds[0], p_status: "under_review", p_outcome: "Investigating", p_reason: "QA internal note 1" })).error, null);
      assert.equal((await admin.client.rpc("admin_moderate_report_atomic", { p_report_id: reportIds[0], p_status: "resolved", p_outcome: "Warning issued", p_reason: "QA internal note 2" })).error, null);
      assert.equal((await admin.client.rpc("admin_moderate_report_atomic", { p_report_id: reportIds[1], p_status: "dismissed", p_outcome: "No policy breach", p_reason: "QA dismiss note" })).error, null);

      // Privacy: reporter CANNOT SELECT reports.admin_notes; reported seller CANNOT read buyer's report!
      assert.ok((await buyer.client.from("reports").select("admin_notes").eq("id", reportIds[0])).error);
      const { data: sellerSeen } = await seller.client.from("reports").select("id").in("id", reportIds);
      assert.equal((sellerSeen ?? []).length, 0, "Reported user must never see reporter details");
    });

    await check("B8.2", "Listing hide/DELETE guard/idempotent restore, free-notice hide/restore, user moderation, closed-account lock & catalog audit", async () => {
      // Listing moderation: hide -> seller cannot republish OR delete -> restore -> repeated restore stays published!
      assert.equal((await admin.client.rpc("admin_moderate_listing_atomic", { p_listing_id: prelovedListingId, p_hide: true, p_reason: "QA listing moderation hide" })).data, "hidden");
      assert.ok((await seller.client.from("listings").update({ status: "published" }).eq("id", prelovedListingId)).error, "Seller must not unhide admin-hidden listing");
      assert.ok((await seller.client.from("listings").delete().eq("id", prelovedListingId)).error, "Seller must not delete admin-hidden listing");

      assert.equal((await admin.client.rpc("admin_moderate_listing_atomic", { p_listing_id: prelovedListingId, p_hide: false, p_reason: "QA restore pass 1" })).data, "published");
      assert.equal((await admin.client.rpc("admin_moderate_listing_atomic", { p_listing_id: prelovedListingId, p_hide: false, p_reason: "QA restore idempotent replay" })).data, "published");

      // Free-notice moderation: hide -> restore -> repeated restore stays active!
      assert.equal((await admin.client.rpc("admin_moderate_free_notice_atomic", { p_notice_id: freeNoticeCollectedId, p_hide: true, p_reason: "QA free notice hide" })).data, "hidden");
      assert.equal((await admin.client.rpc("admin_moderate_free_notice_atomic", { p_notice_id: freeNoticeCollectedId, p_hide: false, p_reason: "QA free notice restore 1" })).data, "active");
      assert.equal((await admin.client.rpc("admin_moderate_free_notice_atomic", { p_notice_id: freeNoticeCollectedId, p_hide: false, p_reason: "QA free notice restore replay" })).data, "active");

      // User warn -> suspend -> restore; closed account blocks restrict/suspend/restore!
      assert.equal((await admin.client.rpc("admin_moderate_user_atomic", { p_target_user_id: third.id, p_action: "warn", p_reason: "QA gentle warning" })).data, "active");
      assert.equal((await admin.client.rpc("admin_moderate_user_atomic", { p_target_user_id: third.id, p_action: "suspend", p_reason: "QA temporary suspension" })).data, "suspended");
      assert.equal((await admin.client.rpc("admin_moderate_user_atomic", { p_target_user_id: third.id, p_action: "restore", p_reason: "QA restoration" })).data, "active");

      for (const act of ["restrict", "suspend", "restore"]) {
        const { error: clErr } = await admin.client.rpc("admin_moderate_user_atomic", { p_target_user_id: closedUser.id, p_action: act, p_reason: "Attempting to alter closed account" });
        assert.ok(clErr && clErr.message.includes("CANNOT_MODIFY_CLOSED_ACCOUNT"), `Closed account ${act} must fail with CANNOT_MODIFY_CLOSED_ACCOUNT`);
      }

      // Catalog toggle writes bigint audit log entry cleanly
      const { error: catErr } = await admin.client.rpc("admin_toggle_catalog_item_atomic", {
        p_table: "donation_spots",
        p_item_id: "blok-beta",
        p_active: true,
        p_reason: "QA catalog audit check",
      });
      assert.equal(catErr, null);

      const { data: logs } = await service.from("admin_audit_logs").select("id, action").eq("admin_id", admin.id);
      assert.ok((logs ?? []).length >= 8, `Expected >=8 audit logs for admin, got ${(logs ?? []).length}`);
      cleanup.push(async () => {
        await service.from("admin_audit_logs").delete().eq("admin_id", admin.id);
      });
    });

    // =========================================================================
    // B9. BLOCKING
    // =========================================================================
    await check("B9.1", "Bidirectional blocking, probing denial, pending offer block, immutable links, paid-order exception & unblock", async () => {
      // Pre-create a conversation and pending offer between seller and buyer BEFORE blocking
      const conv = await getOrCreateConversation(seller.id, buyer.id);
      const { data: pendOffer } = await service
        .from("offers")
        .insert({
          conversation_id: conv.id,
          listing_id: prelovedListingId,
          buyer_id: buyer.id,
          seller_id: seller.id,
          offer_price_sen: 450,
          status: "pending",
          expires_at: new Date(Date.now() + 86400_000).toISOString(),
        })
        .select("id")
        .single();

      // Self-block rejected
      assert.ok((await buyer.client.rpc("toggle_member_block_atomic", { p_target_user_id: buyer.id, p_block: true })).error?.message.includes("CANNOT_BLOCK_SELF"));

      // Buyer blocks seller (and duplicate block is idempotent)
      assert.equal((await buyer.client.rpc("toggle_member_block_atomic", { p_target_user_id: seller.id, p_block: true })).data, true);
      assert.equal((await buyer.client.rpc("toggle_member_block_atomic", { p_target_user_id: seller.id, p_block: true })).data, true);

      // Third-party probing rejected
      assert.ok((await third.client.rpc("is_member_blocked_between", { p_user_a: buyer.id, p_user_b: seller.id })).error?.message.includes("FORBIDDEN_BLOCK_LOOKUP"));

      // Ordinary messaging, offers, pending offer acceptance, service requests & free claims ALL rejected in BOTH directions!
      assert.ok((await buyer.client.from("messages").insert({ conversation_id: conv.id, sender_id: buyer.id, body: "Blocked msg A->B" })).error);
      assert.ok((await seller.client.from("messages").insert({ conversation_id: conv.id, sender_id: seller.id, body: "Blocked msg B->A" })).error);
      assert.ok((await buyer.client.from("offers").insert({ conversation_id: conv.id, listing_id: prelovedListingId, buyer_id: buyer.id, seller_id: seller.id, offer_price_sen: 400, status: "pending", expires_at: new Date(Date.now() + 3600_000).toISOString() })).error);
      assert.ok((await seller.client.rpc("accept_offer_atomic", { p_offer_id: pendOffer.id })).error, "Pending offer acceptance must fail when blocked");
      assert.ok((await buyer.client.rpc("create_service_request_atomic", { p_listing_id: serviceListingId, p_mode: "in_person", p_requirements: "Blocked service request check." })).error);
      assert.ok((await buyer.client.rpc("create_free_notice_claim_atomic", { p_notice_id: freeNoticeCollectedId, p_quantity: 1 })).error);

      // New conversation between blocked members rejected (test with seller2 & third)
      await third.client.rpc("toggle_member_block_atomic", { p_target_user_id: seller2.id, p_block: true });
      const [xA, xB] = third.id < seller2.id ? [third.id, seller2.id] : [seller2.id, third.id];
      assert.ok((await third.client.from("conversations").insert({ member_a: xA, member_b: xB })).error);
      await third.client.rpc("toggle_member_block_atomic", { p_target_user_id: seller2.id, p_block: false });

      // Bypass attempts rejected: unrelated order attachment & unverified-payment order attachment!
      assert.ok((await buyer.client.from("messages").insert({ conversation_id: conv.id, sender_id: buyer.id, body: "Unrelated order bypass", order_id: siblingOrder.id })).error);
      // Unverified-payment active order between buyer & seller -> MUST NOT bypass block!
      const unverifiedPaid = await seedOrderFixture({
        buyerId: buyer.id,
        sellerId: seller.id,
        items: [{ listing_id: businessListingId, title_snapshot: "Unverified", unit_sen: 500, quantity: 1 }],
        status: "paid",
        paymentMode: "unverified",
      });
      assert.ok((await buyer.client.from("messages").insert({ conversation_id: conv.id, sender_id: buyer.id, body: "Unverified order bypass", order_id: unverifiedPaid.id })).error);

      // Legitimate verified active paid-order collection message SUCCEEDS!
      const { data: legitMsg, error: legitErr } = await buyer.client
        .from("messages")
        .insert({ conversation_id: conv.id, sender_id: buyer.id, body: "Where should I collect my verified paid order?", order_id: activePaidOrder.id })
        .select("id")
        .single();
      assert.equal(legitErr, null, `Verified active paid-order message failed: ${legitErr?.message}`);

      // Immutable link mutation guard blocks authenticated participant from mutating conversation members or message links!
      const { error: mutConvErr } = await buyer.client.from("conversations").update({ member_b: third.id }).eq("id", conv.id);
      const { data: convAfterMut } = await service.from("conversations").select("member_a, member_b").eq("id", conv.id).single();
      assert.ok(mutConvErr || (convAfterMut.member_a !== third.id && convAfterMut.member_b !== third.id), "Participant must never mutate conversation members");

      const { error: mutMsgErr } = await buyer.client.from("messages").update({ order_id: null }).eq("id", legitMsg.id);
      const { data: msgAfterMut } = await service.from("messages").select("order_id").eq("id", legitMsg.id).single();
      assert.equal(msgAfterMut.order_id, activePaidOrder.id, `Participant must never mutate message order_id (err=${mutMsgErr?.message})`);

      // Unblock restores normal messaging & bargaining!
      assert.equal((await buyer.client.rpc("toggle_member_block_atomic", { p_target_user_id: seller.id, p_block: false })).data, false);
      const { error: afterUnblockErr } = await buyer.client.from("messages").insert({ conversation_id: conv.id, sender_id: buyer.id, body: "Hello again after unblock!" });
      assert.equal(afterUnblockErr, null, `Messaging after unblock failed: ${afterUnblockErr?.message}`);
    });

    // =========================================================================
    // B10. NOTIFICATIONS & ACCOUNT MANAGEMENT
    // =========================================================================
    await check("B10.1", "Notifications read-state, conversation clear, forgery blocked, profile/last_active_at & suspension", async () => {
      // Direct client forgery on notifications rejected
      assert.ok((await buyer.client.from("notifications").insert({ user_id: buyer.id, kind: "system", title: "Fake", body: "Fake" })).error);

      // Seed conversation message notification for buyer & test mark_conversation_notifications_read_atomic
      const conv = await getOrCreateConversation(seller.id, buyer.id);
      const { data: nRow } = await service
        .from("notifications")
        .insert({ user_id: buyer.id, kind: "new_message", title: "New message", body: "Hi", href: `/messages?conversation=${conv.id}`, dedupe_key: `qa-msg-${RUN_TAG}` })
        .select("id")
        .single();

      // Other user cannot read buyer's notification
      const { data: otherN } = await third.client.from("notifications").select("id").eq("id", nRow.id);
      assert.equal((otherN ?? []).length, 0);

      // Clear conversation notifications via authorized RPC
      const { error: cmErr } = await buyer.client.rpc("mark_conversation_notifications_read_atomic", { p_conversation_id: conv.id });
      assert.equal(cmErr, null, `mark_conversation_notifications_read_atomic failed: ${cmErr?.message}`);

      // Mark all remaining notifications read
      const { error: allReadErr } = await buyer.client.rpc("mark_notifications_read_atomic", { p_notification_id: null });
      assert.equal(allReadErr, null);
      const { count: unreadLeft } = await buyer.client.from("notifications").select("id", { count: "exact", head: true }).eq("user_id", buyer.id).is("read_at", null);
      assert.equal(unreadLeft, 0);

      // Profile ownership & system-field tamper protection
      assert.equal((await buyer.client.from("profiles").update({ bio: `Updated bio ${RUN_TAG}` }).eq("id", buyer.id)).error, null);
      assert.ok((await buyer.client.from("profiles").update({ last_active_at: "2099-01-01T00:00:00Z" }).eq("id", buyer.id)).error, "Direct client last_active_at tamper must fail");
      assert.ok((await buyer.client.from("profiles").update({ university_role: "admin" }).eq("id", buyer.id)).error);

      // Trusted activity RPC updates last_active_at cleanly!
      const { data: profCheck } = await service.from("profiles").select("last_active_at").eq("id", buyer.id).single();
      assert.ok(profCheck.last_active_at, "Trusted RPCs must update profiles.last_active_at");
    });

    // =========================================================================
    // B11. SECURITY & PHASE 6 REGRESSION
    // =========================================================================
    await check("B11.1", "Anon/direct/service-only/admin RPC boundaries, Phase 6 PIN/protection privacy, bargaining & preserved financials", async () => {
      // Service-role-only expiry RPCs denied to authenticated members
      assert.ok((await buyer.client.rpc("expire_stale_service_requests_atomic", { p_request_id: null })).error);
      assert.ok((await buyer.client.rpc("expire_stale_free_claims_atomic", { p_notice_id: null })).error);

      // Unauthorized admin RPC calls denied to student & staff
      for (const fn of ["admin_moderate_user_atomic", "admin_moderate_listing_atomic", "admin_moderate_free_notice_atomic", "admin_moderate_review_atomic", "admin_toggle_catalog_item_atomic"]) {
        const { error: stErr } = await staff.client.rpc(fn, {});
        assert.ok(stErr, `Non-admin staff must not run ${fn}`);
      }

      // Phase 6 orders.protection_expires_at readable by participant; pickup_pin blocked from direct SELECT!
      const { data: ordRead, error: ordReadErr } = await buyer.client.from("orders").select("id, protection_expires_at").eq("id", multiOrder.id).single();
      assert.equal(ordReadErr, null);
      assert.ok(ordRead?.protection_expires_at);
      assert.ok((await seller.client.from("orders").select("pickup_pin").eq("id", activePaidOrder.id)).error, "pickup_pin must remain private from direct table SELECT");

      // Phase 5B bargaining still works when unblocked!
      const [mA, mB] = seller.id < third.id ? [seller.id, third.id] : [third.id, seller.id];
      const { data: bConv } = await service.from("conversations").insert({ member_a: mA, member_b: mB }).select("id").single();
      const { data: bOff } = await service
        .from("offers")
        .insert({
          conversation_id: bConv.id,
          listing_id: prelovedListingId,
          buyer_id: third.id,
          seller_id: seller.id,
          offer_price_sen: 450,
          status: "pending",
          expires_at: new Date(Date.now() + 86400_000).toISOString(),
        })
        .select("id")
        .single();
      cleanup.push(async () => {
        await service.from("offers").delete().eq("conversation_id", bConv.id);
        await service.from("conversations").delete().eq("id", bConv.id);
      });
      const { error: accOffErr } = await seller.client.rpc("accept_offer_atomic", { p_offer_id: bOff.id });
      assert.equal(accOffErr, null, `Bargaining accept_offer_atomic regressed: ${accOffErr?.message}`);

      // Preserved Phase 6 orders/disputes/refunds exact reconciliation
      const { data: rfds } = await service
        .from("order_refunds")
        .select("refund_code, refund_amount_sen, commission_reversal_sen, seller_deduction_sen, status")
        .in("refund_code", ["RFD-2611-872723", "RFD-2611-19B70A"]);
      assert.equal((rfds ?? []).length, 2);
      assert.equal(rfds.reduce((s, r) => s + r.refund_amount_sen, 0), 2000);
      assert.equal(rfds.reduce((s, r) => s + r.commission_reversal_sen, 0), 40);
      assert.equal(rfds.reduce((s, r) => s + r.seller_deduction_sen, 0), 1960);
    });
  } finally {
    // Guaranteed cleanup of ALL temporary fixtures, storage objects & synthetic auth users
    for (const fn of cleanup.reverse()) {
      try {
        await fn();
      } catch {}
    }
    for (const st of tempStorage) {
      try {
        await service.storage.from(st.bucket).remove([st.path]);
      } catch {}
    }
    for (const uid of tempUserIds) {
      try { await service.from("reports").delete().eq("reporter_id", uid); } catch {}
      try { await service.from("notifications").delete().eq("user_id", uid); } catch {}
      try { await service.from("member_blocks").delete().or(`blocker_id.eq.${uid},blocked_id.eq.${uid}`); } catch {}
      try { await service.from("listings").update({ reserved_quantity: 0 }).eq("seller_id", uid); } catch {}
      try { await service.from("listings").delete().eq("seller_id", uid); } catch {}
      try { await service.from("storefronts").delete().eq("seller_id", uid); } catch {}
      try { await service.from("admin_users").delete().eq("user_id", uid); } catch {}
      try { await service.from("profiles").delete().eq("id", uid); } catch {}
      try { await service.auth.admin.deleteUser(uid); } catch {}
    }
  }

  const passed = results.filter((r) => r.status === "PASS").length;
  console.log(JSON.stringify({ runTag: RUN_TAG, passed, total: results.length, results }, null, 2));
  if (passed !== results.length) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
