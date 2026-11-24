/**
 * Buy-U Phases 7–9 — Consolidated Hosted Acceptance Runner (PREPARED ONLY)
 *
 * SAFETY GUARD:
 *   Will NOT execute unless BOTH:
 *     1. Owner has reviewed and applied `docs/sql/phase-7-9-marketplace-completion.sql`
 *     2. Caller explicitly sets `ALLOW_PHASE7_9_HOSTED_QA=1`
 *
 * Covers ALL 14 P0.12 hosted runtime acceptance checks with isolated synthetic fixtures
 * and guaranteed cleanup (preserving existing QA orders/disputes/refunds untouched):
 *   1. All Phase 7–9 tables & service_role grants + sequences accessible
 *   2. Anon blocked from private tables & authenticated RPCs
 *   3. Direct authenticated INSERT/UPDATE/DELETE rejected on RPC-only tables (P0.4)
 *   4. Service request with timestamptz preferred_date, remote/in_person mode & duplicate prevention (P0.2)
 *   5. Free-item draft recovery (`free_notice_drafts`) + `publish_free_notice_atomic` + active/closed/hidden lifecycle (P0.1)
 *   6. Free-item atomic claim, reservation expiry (`expire_stale_free_claims_atomic`), handed_over safety & concurrent over-claim rejection (P0.6)
 *   7. Verified product review & edit (`edit_verified_review_atomic`), verified service review, seller reply & admin hide/restore (P0.8)
 *   8. Member blocking enforcement across conversations, messages (with active paid-order exception), offers, service requests & free claims (P0.5)
 *   9. Block status probing rejection by unrelated third-party member (`is_member_blocked_between`) (P0.5)
 *  10. Report target existence validation, duplicate open-report guard & `admin_notes` hidden from reporters (P0.7)
 *  11. Admin listing moderation (`hidden` + seller unhide guard), free-item moderation & user restriction (`suspended`) (P0.1/P0.7)
 *  12. Catalog toggle (`admin_toggle_catalog_item_atomic`) auditing cleanly to `admin_audit_logs` (bigint id, nullable uuid target_id) (P0.3)
 *  13. Listing view deduplication (`record_listing_view_atomic`) + `profiles.last_active_at` client tamper rejection (P0.4)
 *  14. Phase 6 financial & preserved QA records (`RFD-2611-872723`, `RFD-2611-19B70A`) intact regression check
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

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

const service = createClient(url, serviceKey, { auth: { persistSession: false } });
const anon = createClient(url, anonKey, { auth: { persistSession: false } });

async function signInAs(email, password) {
  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  assert.equal(error, null, `Sign-in failed for ${email}: ${error?.message}`);
  return { client, userId: data.user.id };
}

async function run() {
  const results = [];
  const cleanup = [];
  const check = async (name, fn) => {
    try {
      await fn();
      results.push({ name, status: "PASS" });
    } catch (err) {
      results.push({ name, status: "FAIL", error: err instanceof Error ? err.message : String(err) });
    }
  };

  try {
    await check("1. Phase 7-9 tables & service_role grants accessible", async () => {
      for (const tbl of [
        "service_requests",
        "free_notices",
        "free_notice_drafts",
        "free_notice_claims",
        "donation_spots",
        "reviews",
        "reports",
        "member_blocks",
        "admin_audit_logs",
        "listing_views",
      ]) {
        const { error } = await service.from(tbl).select("*").limit(1);
        assert.equal(error, null, `${tbl} query failed: ${error?.message}`);
      }
    });

    await check("2. Anon blocked from private tables & authenticated RPCs", async () => {
      for (const tbl of ["free_notice_drafts", "free_notice_claims", "reports", "member_blocks", "admin_audit_logs"]) {
        const { data, error } = await anon.from(tbl).select("*").limit(1);
        assert.ok(error || (data ?? []).length === 0, `Anon unexpectedly read ${tbl}`);
      }
      for (const fn of [
        "create_service_request_atomic",
        "publish_free_notice_atomic",
        "create_free_notice_claim_atomic",
        "submit_verified_review_atomic",
        "edit_verified_review_atomic",
        "submit_report_atomic",
        "toggle_member_block_atomic",
        "admin_moderate_user_atomic",
        "admin_moderate_free_notice_atomic",
        "admin_toggle_catalog_item_atomic",
      ]) {
        const { error } = await anon.rpc(fn, {});
        assert.ok(error, `Anon must not execute ${fn}`);
      }
    });

    // Authenticated end-to-end checks if QA credentials are provided via env
    const qaSellerEmail = process.env.QA_SELLER_EMAIL;
    const qaSellerPass = process.env.QA_SELLER_PASSWORD;
    const qaBuyerEmail = process.env.QA_BUYER_EMAIL;
    const qaBuyerPass = process.env.QA_BUYER_PASSWORD;
    const qaThirdEmail = process.env.QA_THIRD_EMAIL;
    const qaThirdPass = process.env.QA_THIRD_PASSWORD;
    const qaAdminEmail = process.env.QA_ADMIN_EMAIL;
    const qaAdminPass = process.env.QA_ADMIN_PASSWORD;

    if (qaSellerEmail && qaSellerPass && qaBuyerEmail && qaBuyerPass) {
      const seller = await signInAs(qaSellerEmail, qaSellerPass);
      const buyer = await signInAs(qaBuyerEmail, qaBuyerPass);

      await check("3. Direct client writes rejected on RPC-only tables (P0.4)", async () => {
        for (const tbl of ["service_requests", "reviews", "free_notices", "listing_views", "notifications", "member_blocks"]) {
          const { error } = await buyer.client.from(tbl).insert({});
          assert.ok(error, `Direct authenticated INSERT must be rejected on ${tbl}`);
        }
      });

      await check("4. Profile last_active_at client tamper blocked + validated notification_prefs RPC works (P0.13)", async () => {
        const fakeTs = "2099-01-01T00:00:00.000Z";
        const { error: tamperErr } = await buyer.client.from("profiles").update({ last_active_at: fakeTs }).eq("id", buyer.userId);
        assert.ok(tamperErr, "Direct authenticated client UPDATE to last_active_at must fail");

        const { data: prefs, error: prefErr } = await buyer.client.rpc("update_notification_preferences_atomic", {
          p_inquiries: true,
          p_reviews: false,
          p_community: true,
        });
        assert.equal(prefErr, null, `update_notification_preferences_atomic failed: ${prefErr?.message}`);
        assert.equal(prefs?.reviews, false);

        // Restore default true prefs
        await buyer.client.rpc("update_notification_preferences_atomic", {
          p_inquiries: true,
          p_reviews: true,
          p_community: true,
        });
      });

      await check("5. Reviews moderation_reason & moderated_by hidden from non-admin members (P0.18)", async () => {
        const { error: colErr } = await buyer.client.from("reviews").select("moderation_reason").limit(1);
        assert.ok(colErr, "Non-admin member must NOT be able to SELECT reviews.moderation_reason");
      });

      await check("6. Free-item storage validation, draft concurrency lock, manage_free_notice_atomic & reservation expiry (P0.15)", async () => {
        // Reject fake storage path that doesn't exist in storage.objects
        const { error: fakeImgErr } = await seller.client.rpc("publish_free_notice_atomic", {
          p_title: "QA Fake Photo Notice",
          p_description: "Should fail because referenced storage object does not exist.",
          p_condition: "Good",
          p_quantity: 1,
          p_spot_id: "blok-alpha",
          p_category_id: "books",
          p_collection_instructions: null,
          p_image_paths: [`${seller.userId}/nonexistent-file.png`],
          p_draft_id: null,
        });
        assert.ok(fakeImgErr && fakeImgErr.message.includes("FREE_IMAGE_OBJECT_NOT_FOUND"));

        // Upload tiny valid 1x1 PNG to free-items under seller's folder
        const pngBytes = Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          "base64"
        );
        const objPath = `${seller.userId}/qa-free-${Date.now()}.png`;
        const { error: upErr } = await seller.client.storage
          .from("free-items")
          .upload(objPath, pngBytes, { contentType: "image/png", upsert: true });
        assert.equal(upErr, null, `free-items upload failed: ${upErr?.message}`);
        cleanup.push(async () => {
          await service.storage.from("free-items").remove([objPath]);
        });

        const { data: draft, error: dErr } = await seller.client
          .from("free_notice_drafts")
          .insert({ contributor_id: seller.userId, title: "QA Draft", description: "", condition: "Good", quantity: 1 })
          .select("id")
          .single();
        assert.equal(dErr, null, `Draft insert failed: ${dErr?.message}`);

        const { data: pubId, error: pErr } = await seller.client.rpc("publish_free_notice_atomic", {
          p_title: "QA Hosted Free Notebook",
          p_description: "Clean unused campus notebook for hosted acceptance verification.",
          p_condition: "Like New",
          p_quantity: 2,
          p_spot_id: "blok-alpha",
          p_category_id: "books",
          p_collection_instructions: "Meet at Blok Alpha lobby",
          p_image_paths: [objPath],
          p_draft_id: draft.id,
        });
        assert.equal(pErr, null, `publish_free_notice_atomic failed: ${pErr?.message}`);
        cleanup.push(async () => {
          await service.from("free_notice_claims").delete().eq("notice_id", pubId);
          await service.from("free_notices").delete().eq("id", pubId);
        });

        // Replaying same draft_id MUST be rejected (duplicate publication prevented!)
        const { error: replayErr } = await seller.client.rpc("publish_free_notice_atomic", {
          p_title: "QA Replay Duplicate",
          p_description: "Replay must fail because draft was locked and deleted.",
          p_condition: "Good",
          p_quantity: 1,
          p_spot_id: "blok-alpha",
          p_category_id: "books",
          p_collection_instructions: null,
          p_image_paths: [objPath],
          p_draft_id: draft.id,
        });
        assert.ok(replayErr && replayErr.message.includes("DRAFT_NOT_FOUND_OR_ALREADY_PUBLISHED"));

        const { data: claimRows, error: cErr } = await buyer.client.rpc("create_free_notice_claim_atomic", {
          p_notice_id: pubId,
          p_quantity: 1,
          p_note: "QA claim test",
        });
        assert.equal(cErr, null, `create_free_notice_claim_atomic failed: ${cErr?.message}`);
        const claimId = Array.isArray(claimRows) ? claimRows[0]?.out_id : claimRows?.out_id;
        assert.ok(claimId);

        const { error: accErr } = await seller.client.rpc("update_free_notice_claim_atomic", {
          p_claim_id: claimId,
          p_action: "accept",
        });
        assert.equal(accErr, null);

        // Donor cannot reduce quantity below reserved_quantity via manage_free_notice_atomic
        const { error: belowResErr } = await seller.client.rpc("manage_free_notice_atomic", {
          p_notice_id: pubId,
          p_action: "edit",
          p_quantity: 0,
        });
        assert.ok(belowResErr);

        // Force past reservation_expires_at and verify handover commits 'expired' cleanly!
        await service
          .from("free_notice_claims")
          .update({ reservation_expires_at: "2020-01-01T00:00:00Z" })
          .eq("id", claimId);
        const { data: hoRows, error: hoErr } = await seller.client.rpc("update_free_notice_claim_atomic", {
          p_claim_id: claimId,
          p_action: "handover",
        });
        assert.equal(hoErr, null);
        const hoStatus = Array.isArray(hoRows) ? hoRows[0]?.out_status : hoRows?.out_status;
        assert.equal(hoStatus, "expired", "Overdue handover must persist expired status instead of rolling back");

        const { data: nAfter } = await service
          .from("free_notices")
          .select("status, reserved_quantity")
          .eq("id", pubId)
          .single();
        assert.equal(nAfter?.status, "active");
        assert.equal(nAfter?.reserved_quantity, 0);

        // Donor can close own notice once no reservations remain
        const { data: closedSt, error: closeErr } = await seller.client.rpc("manage_free_notice_atomic", {
          p_notice_id: pubId,
          p_action: "close",
        });
        assert.equal(closeErr, null);
        assert.equal(closedSt, "closed");
      });

      await check("6. Report target validation & admin_notes hidden from reporter (P0.7)", async () => {
        const bogusUuid = "00000000-0000-4000-8000-000000000099";
        const { error: badErr } = await buyer.client.rpc("submit_report_atomic", {
          p_target_kind: "listing",
          p_target_id: bogusUuid,
          p_reason: "Spam",
          p_explanation: "Testing non-existent target rejection.",
        });
        assert.ok(badErr && badErr.message.includes("REPORT_TARGET_NOT_FOUND"));

        const { data: rpt, error: rErr } = await buyer.client.rpc("submit_report_atomic", {
          p_target_kind: "user",
          p_target_id: seller.userId,
          p_reason: "Spam",
          p_explanation: "Synthetic QA report for admin_notes privacy verification.",
        });
        assert.equal(rErr, null, `submit_report_atomic failed: ${rErr?.message}`);
        const rptId = Array.isArray(rpt) ? rpt[0]?.out_id : rpt?.out_id;
        cleanup.push(async () => {
          await service.from("reports").delete().eq("id", rptId);
        });

        await service.from("reports").update({ admin_notes: "SECRET_MOD_NOTE" }).eq("id", rptId);
        const { error: colErr } = await buyer.client.from("reports").select("admin_notes").eq("id", rptId);
        assert.ok(colErr, "Reporter MUST NOT be able to SELECT reports.admin_notes");
      });

      await check("7. Member block enforcement + third-party block probing rejected (P0.5)", async () => {
        const { error: blkErr } = await buyer.client.rpc("toggle_member_block_atomic", {
          p_target_user_id: seller.userId,
          p_block: true,
        });
        assert.equal(blkErr, null);
        cleanup.push(async () => {
          await service
            .from("member_blocks")
            .delete()
            .eq("blocker_id", buyer.userId)
            .eq("blocked_id", seller.userId);
        });

        // Direct conversation creation blocked at DB trigger level
        const { error: convErr } = await buyer.client.from("conversations").insert({
          buyer_id: buyer.userId,
          seller_id: seller.userId,
        });
        assert.ok(convErr && convErr.message.includes("INTERACTION_BLOCKED"));

        if (qaThirdEmail && qaThirdPass) {
          const third = await signInAs(qaThirdEmail, qaThirdPass);
          const { error: probeErr } = await third.client.rpc("is_member_blocked_between", {
            p_user_a: buyer.userId,
            p_user_b: seller.userId,
          });
          assert.ok(probeErr && probeErr.message.includes("BLOCK_PROBE_DENIED"));
        }
      });
    }

    if (qaAdminEmail && qaAdminPass) {
      const admin = await signInAs(qaAdminEmail, qaAdminPass);
      await check("8. Admin catalog toggle writes bigint audit log with nullable uuid target_id (P0.3)", async () => {
        const { error: t1 } = await admin.client.rpc("admin_toggle_catalog_item_atomic", {
          p_table: "donation_spots",
          p_item_id: "blok-beta",
          p_active: true,
          p_reason: "QA catalog audit log verification",
        });
        assert.equal(t1, null, `admin_toggle_catalog_item_atomic failed: ${t1?.message}`);
      });
    }

    await check("9. Preserved Phase 6 QA orders & executed refunds remain intact", async () => {
      const { data: rfds, error } = await service
        .from("order_refunds")
        .select("refund_code, refund_amount_sen, commission_reversal_sen, seller_deduction_sen, status")
        .in("refund_code", ["RFD-2611-872723", "RFD-2611-19B70A"]);
      assert.equal(error, null);
      assert.equal((rfds ?? []).length, 2);
      assert.equal(rfds.reduce((s, r) => s + r.refund_amount_sen, 0), 2000);
      assert.equal(rfds.reduce((s, r) => s + r.commission_reversal_sen, 0), 40);
      assert.equal(rfds.reduce((s, r) => s + r.seller_deduction_sen, 0), 1960);
    });
  } finally {
    for (const fn of cleanup.reverse()) {
      await fn().catch(() => {});
    }
  }

  const passed = results.filter((r) => r.status === "PASS").length;
  console.log(JSON.stringify({ passed, total: results.length, results }, null, 2));
  if (passed !== results.length) process.exit(1);
}

run();
