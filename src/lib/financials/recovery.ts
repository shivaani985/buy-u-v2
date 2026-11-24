/**
 * Durable Provider Execution & Safe Recovery Engine (P0.4 / P0.5 / P0.12 / P0.14).
 *
 * Handles all 7 interrupted-processing scenarios safely:
 *   1. Crash after claim, before provider execution (stale `started` simulated attempt -> deterministic re-execution + record + finalize)
 *   2. Crash after simulated provider execution, before outcome persistence (identical deterministic ref from `logicalTxId` -> record + finalize, zero duplicates)
 *   3. Crash after outcome persistence, before finalization (immediate finalize from persisted evidence)
 *   4. Concurrent normal processing & recovery worker (grace window avoids racing in-flight requests; DB locks + immutable outcome recording serialize safely)
 *   5. Duplicate recovery execution (terminal entities skipped / idempotent)
 *   6. Definitive failure restores withdrawal allocations exactly once
 *   7. Truly uncertain outcome (`reconciliation_required`) retains reservation (`held_uncertain`)
 */

export type RecoverableEntityType = "withdrawal" | "refund";

export const DEFAULT_IN_FLIGHT_GRACE_MS = 60_000;

export interface PersistedAttemptRecord {
  entityType: RecoverableEntityType;
  entityId: string;
  logicalTxId: string;
  attemptToken: string;
  attemptNumber: number;
  simulationMode: boolean;
  status:
    | "started"
    | "provider_succeeded"
    | "provider_failed"
    | "provider_uncertain"
    | "finalized";
  providerOutcome: "succeeded" | "paid" | "failed" | "reconciliation_required" | null;
  simulationRef: string | null;
  failureOrUncertaintyReason: string | null;
  startedAt: string;
  providerRecordedAt: string | null;
  finalizedAt: string | null;
}

export interface RecoverableEntity {
  entityType: RecoverableEntityType;
  entityId: string;
  code: string;
  logicalTxId: string;
  status: string;
  attemptToken: string | null;
  amountSen: number;
  orderId?: string;
  sellerId?: string;
  maskedBankSummary?: string | null;
  latestAttempt: PersistedAttemptRecord | null;
}

export interface RecoveryActionResult {
  entityType: RecoverableEntityType;
  entityId: string;
  code: string;
  result:
    | "paid"
    | "succeeded"
    | "failed"
    | "held_uncertain"
    | "active_in_flight"
    | "already_paid"
    | "already_succeeded"
    | "already_failed"
    | "not_recoverable";
  simulationRef?: string | null;
}

export interface RecoveryStore {
  listPendingEntities(): Promise<RecoverableEntity[]>;
  executeAndRecordSimulatedProvider(entity: RecoverableEntity): Promise<{
    outcome: "paid" | "succeeded" | "failed" | "reconciliation_required";
    simulationRef: string | null;
    reason: string | null;
  }>;
  finalizeFromPersistedEvidence(
    entityType: RecoverableEntityType,
    entityId: string
  ): Promise<RecoveryActionResult["result"]>;
}

export type RecoveryDecision =
  | "finalize_success"
  | "finalize_failed"
  | "reexecute_simulated_provider"
  | "active_in_flight"
  | "hold_uncertain"
  | "skip";

/**
 * Classifies a pending financial entity strictly from persisted attempt state.
 * Never releases funds on elapsed time or admin notes.
 */
export function classifyPersistedRecoveryEvidence(
  entity: RecoverableEntity,
  nowMs: number = Date.now(),
  graceMs: number = DEFAULT_IN_FLIGHT_GRACE_MS
): RecoveryDecision {
  if (
    entity.status !== "processing" &&
    entity.status !== "reconciliation_required"
  ) {
    return "skip";
  }

  const att = entity.latestAttempt;
  if (!att || !entity.attemptToken || att.attemptToken !== entity.attemptToken) {
    return "hold_uncertain";
  }

  // Case 7: Truly uncertain outcome MUST retain reservation
  if (att.providerOutcome === "reconciliation_required") {
    return "hold_uncertain";
  }

  // Case 3: Persisted definitive success ready for idempotent finalization
  if (
    att.providerRecordedAt &&
    entity.entityType === "withdrawal" &&
    att.providerOutcome === "paid" &&
    att.simulationRef &&
    att.simulationRef.startsWith("SIM-TRF-")
  ) {
    return "finalize_success";
  }
  if (
    att.providerRecordedAt &&
    entity.entityType === "refund" &&
    att.providerOutcome === "succeeded" &&
    att.simulationRef &&
    att.simulationRef.startsWith("SIM-RFD-")
  ) {
    return "finalize_success";
  }

  // Case 6: Persisted definitive failure ready for exact-once release/finalization
  if (att.providerRecordedAt && att.providerOutcome === "failed") {
    return "finalize_failed";
  }

  // Cases 1, 2 & 4: Claimed (`started`) with no recorded outcome yet
  if (att.status === "started" && !att.providerRecordedAt) {
    const startedMs = Date.parse(att.startedAt);
    const ageMs = Number.isNaN(startedMs) ? 0 : nowMs - startedMs;
    if (ageMs < graceMs) {
      return "active_in_flight";
    }
    if (att.simulationMode) {
      return "reexecute_simulated_provider";
    }
    return "hold_uncertain";
  }

  return "hold_uncertain";
}

export async function runDurableRecoverySweep(
  store: RecoveryStore,
  options?: { nowMs?: number; graceMs?: number }
): Promise<RecoveryActionResult[]> {
  const nowMs = options?.nowMs ?? Date.now();
  const graceMs = options?.graceMs ?? DEFAULT_IN_FLIGHT_GRACE_MS;
  const pending = await store.listPendingEntities();
  const results: RecoveryActionResult[] = [];

  for (const item of pending) {
    const decision = classifyPersistedRecoveryEvidence(item, nowMs, graceMs);
    if (decision === "skip") {
      results.push({
        entityType: item.entityType,
        entityId: item.entityId,
        code: item.code,
        result: "not_recoverable",
      });
      continue;
    }
    if (decision === "active_in_flight") {
      results.push({
        entityType: item.entityType,
        entityId: item.entityId,
        code: item.code,
        result: "active_in_flight",
      });
      continue;
    }
    if (decision === "hold_uncertain") {
      results.push({
        entityType: item.entityType,
        entityId: item.entityId,
        code: item.code,
        result: "held_uncertain",
      });
      continue;
    }

    let simRef = item.latestAttempt?.simulationRef ?? null;
    if (decision === "reexecute_simulated_provider") {
      const rec = await store.executeAndRecordSimulatedProvider(item);
      simRef = rec.simulationRef;
      if (rec.outcome === "reconciliation_required") {
        results.push({
          entityType: item.entityType,
          entityId: item.entityId,
          code: item.code,
          result: "held_uncertain",
          simulationRef: null,
        });
        continue;
      }
    }

    const outcome = await store.finalizeFromPersistedEvidence(
      item.entityType,
      item.entityId
    );
    results.push({
      entityType: item.entityType,
      entityId: item.entityId,
      code: item.code,
      result: outcome,
      simulationRef: simRef,
    });
  }

  return results;
}
