/**
 * Buy-U Phase 6D — Executable Durable Financial Recovery Worker (P0.5 / P0.14)
 *
 * Recovers interrupted `payout_requests` and `order_refunds` in `processing` or
 * `reconciliation_required`:
 *   - Persisted definitive success/failure -> idempotently finalizes via `recover_financial_execution_atomic`.
 *   - Stale `started` simulated attempts (crash after claim or before outcome persistence) ->
 *     re-executes deterministic simulated provider by `logical_tx_id`, persists via
 *     `record_provider_attempt_outcome_atomic`, then finalizes via `recover_financial_execution_atomic`.
 *   - Active in-flight attempts (< 60s) -> skipped cleanly (`active_in_flight`).
 *   - Truly uncertain outcomes (`reconciliation_required`) -> held safely (`held_uncertain`).
 *
 * Local commands (after owner applies docs/sql/phase-6d-financial-ecosystem.sql):
 *   Single sweep:  node scripts/phase6d-recovery-worker.mjs
 *   Watch mode:    node scripts/phase6d-recovery-worker.mjs --watch --interval-ms=30000
 */
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  getBankPayoutProvider,
  getRefundExecutionProvider,
} from "../src/lib/financials/providers.ts";
import { runDurableRecoverySweep } from "../src/lib/financials/recovery.ts";

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

async function runSweepOnce(service) {
  const store = {
    async listPendingEntities() {
      const [wdrRes, rfdRes] = await Promise.all([
        service
          .from("payout_requests")
          .select(
            "id, withdrawal_code, seller_id, amount_sen, masked_bank_summary, status, idempotency_key, attempt_token"
          )
          .in("status", ["processing", "reconciliation_required"])
          .limit(100),
        service
          .from("order_refunds")
          .select(
            "id, refund_code, order_id, refund_amount_sen, status, idempotency_key, attempt_token"
          )
          .in("status", ["processing", "reconciliation_required"])
          .limit(100),
      ]);

      if (wdrRes.error || rfdRes.error) {
        throw new Error(wdrRes.error?.message || rfdRes.error?.message);
      }

      const tokens = [
        ...(wdrRes.data ?? []).map((w) => w.attempt_token).filter(Boolean),
        ...(rfdRes.data ?? []).map((r) => r.attempt_token).filter(Boolean),
      ];

      const attemptByToken = new Map();
      if (tokens.length > 0) {
        const { data: attempts, error: attErr } = await service
          .from("financial_execution_attempts")
          .select(
            "entity_type, entity_id, logical_tx_id, attempt_token, attempt_number, simulation_mode, status, provider_outcome, simulation_ref, failure_or_uncertainty_reason, started_at, provider_recorded_at, finalized_at"
          )
          .in("attempt_token", tokens);
        if (attErr) throw new Error(attErr.message);
        for (const a of attempts ?? []) {
          attemptByToken.set(a.attempt_token, {
            entityType: a.entity_type,
            entityId: a.entity_id,
            logicalTxId: a.logical_tx_id,
            attemptToken: a.attempt_token,
            attemptNumber: a.attempt_number,
            simulationMode: Boolean(a.simulation_mode),
            status: a.status,
            providerOutcome: a.provider_outcome,
            simulationRef: a.simulation_ref,
            failureOrUncertaintyReason: a.failure_or_uncertainty_reason,
            startedAt: a.started_at,
            providerRecordedAt: a.provider_recorded_at,
            finalizedAt: a.finalized_at,
          });
        }
      }

      const items = [];
      for (const w of wdrRes.data ?? []) {
        items.push({
          entityType: "withdrawal",
          entityId: w.id,
          code: w.withdrawal_code,
          logicalTxId: w.idempotency_key,
          status: w.status,
          attemptToken: w.attempt_token,
          amountSen: w.amount_sen,
          sellerId: w.seller_id,
          maskedBankSummary: w.masked_bank_summary,
          latestAttempt: w.attempt_token
            ? attemptByToken.get(w.attempt_token) ?? null
            : null,
        });
      }
      for (const r of rfdRes.data ?? []) {
        items.push({
          entityType: "refund",
          entityId: r.id,
          code: r.refund_code,
          logicalTxId: r.idempotency_key,
          status: r.status,
          attemptToken: r.attempt_token,
          amountSen: r.refund_amount_sen,
          orderId: r.order_id,
          latestAttempt: r.attempt_token
            ? attemptByToken.get(r.attempt_token) ?? null
            : null,
        });
      }
      return items;
    },

    async executeAndRecordSimulatedProvider(entity) {
      if (entity.entityType === "withdrawal") {
        const provider = getBankPayoutProvider();
        const bankSummary = entity.maskedBankSummary || "Malaysian Bank · ****0000";
        const res = await provider.executeDisbursement({
          withdrawalCode: entity.code,
          sellerId: entity.sellerId || "",
          amountSen: entity.amountSen,
          idempotencyKey: entity.logicalTxId,
          bankName: bankSummary.split("·")[0]?.trim() || "Malaysian Bank",
          accountLast4: bankSummary.match(/\*{4}(\d{4})/)?.[1] ?? "0000",
        });
        await service.rpc("record_provider_attempt_outcome_atomic", {
          p_attempt_token: entity.attemptToken,
          p_provider_outcome: res.outcome,
          p_simulation_ref: res.transferRef ?? null,
          p_reason: res.failureReason ?? null,
        });
        return {
          outcome: res.outcome,
          simulationRef: res.transferRef ?? null,
          reason: res.failureReason ?? null,
        };
      }

      const provider = getRefundExecutionProvider();
      const res = await provider.executeRefund({
        refundCode: entity.code,
        orderId: entity.orderId || "",
        amountSen: entity.amountSen,
        idempotencyKey: entity.logicalTxId,
      });
      await service.rpc("record_provider_attempt_outcome_atomic", {
        p_attempt_token: entity.attemptToken,
        p_provider_outcome: res.outcome,
        p_simulation_ref: res.refundRef ?? null,
        p_reason: res.failureReason ?? null,
      });
      return {
        outcome: res.outcome,
        simulationRef: res.refundRef ?? null,
        reason: res.failureReason ?? null,
      };
    },

    async finalizeFromPersistedEvidence(entityType, entityId) {
      const { data, error } = await service.rpc(
        "recover_financial_execution_atomic",
        {
          p_entity_type: entityType,
          p_entity_id: entityId,
          p_admin_id: null,
        }
      );
      if (error) throw new Error(error.message);
      return data;
    },
  };

  return runDurableRecoverySweep(store);
}

async function main() {
  loadEnvLocal();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error("RECOVERY_WORKER_ERROR: Supabase service credentials missing.");
    process.exit(1);
  }

  const service = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const watch = process.argv.includes("--watch");
  const intervalArg = process.argv.find((a) => a.startsWith("--interval-ms="));
  const intervalMs = intervalArg
    ? Math.max(5000, Number(intervalArg.split("=")[1]) || 30000)
    : 30000;

  const first = await runSweepOnce(service);
  console.log(JSON.stringify({ mode: watch ? "watch" : "once", count: first.length, results: first }));

  if (watch) {
    setInterval(async () => {
      try {
        const res = await runSweepOnce(service);
        if (res.length > 0) {
          console.log(JSON.stringify({ tick: new Date().toISOString(), count: res.length, results: res }));
        }
      } catch (err) {
        console.error("RECOVERY_TICK_ERROR:", err instanceof Error ? err.message : String(err));
      }
    }, intervalMs);
  }
}

main().catch((err) => {
  console.error("RECOVERY_WORKER_FATAL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
