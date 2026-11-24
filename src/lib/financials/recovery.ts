/**
 * Durable Provider Execution & Safe Recovery Engine (P0.4 / P0.5).
 *
 * Guarantees:
 * - Every provider outcome is persisted by logical transaction identity BEFORE finalization.
 * - Interrupted processing / browser closure / server restart recovers idempotently.
 * - Funds are NEVER released without trusted persisted provider evidence of definitive failure.
 * - Uncertain outcomes remain reserved/frozen (`held_uncertain`).
 */

export type RecoverableEntityType = "withdrawal" | "refund";

export interface PersistedAttemptRecord {
  entityType: RecoverableEntityType;
  entityId: string;
  logicalTxId: string;
  attemptToken: string;
  attemptNumber: number;
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
    | "already_paid"
    | "already_succeeded"
    | "already_failed"
    | "not_recoverable";
  simulationRef?: string | null;
}

export interface RecoveryStore {
  listPendingEntities(): Promise<RecoverableEntity[]>;
  finalizeFromPersistedEvidence(
    entityType: RecoverableEntityType,
    entityId: string
  ): Promise<RecoveryActionResult["result"]>;
}

/**
 * Evaluates a single recoverable entity strictly from trusted persisted provider evidence.
 * Never uses elapsed time or admin notes to release funds!
 */
export function classifyPersistedRecoveryEvidence(
  entity: RecoverableEntity
): "finalize_success" | "finalize_failed" | "hold_uncertain" | "skip" {
  if (
    entity.status !== "processing" &&
    entity.status !== "reconciliation_required"
  ) {
    return "skip";
  }
  const att = entity.latestAttempt;
  if (
    !att ||
    !entity.attemptToken ||
    att.attemptToken !== entity.attemptToken ||
    !att.providerRecordedAt
  ) {
    return "hold_uncertain";
  }
  if (
    entity.entityType === "withdrawal" &&
    att.providerOutcome === "paid" &&
    att.simulationRef &&
    att.simulationRef.startsWith("SIM-TRF-")
  ) {
    return "finalize_success";
  }
  if (
    entity.entityType === "refund" &&
    att.providerOutcome === "succeeded" &&
    att.simulationRef &&
    att.simulationRef.startsWith("SIM-RFD-")
  ) {
    return "finalize_success";
  }
  if (att.providerOutcome === "failed") {
    return "finalize_failed";
  }
  return "hold_uncertain";
}

export async function runDurableRecoverySweep(
  store: RecoveryStore
): Promise<RecoveryActionResult[]> {
  const pending = await store.listPendingEntities();
  const results: RecoveryActionResult[] = [];

  for (const item of pending) {
    const decision = classifyPersistedRecoveryEvidence(item);
    if (decision === "skip") {
      results.push({
        entityType: item.entityType,
        entityId: item.entityId,
        code: item.code,
        result: "not_recoverable",
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
    const outcome = await store.finalizeFromPersistedEvidence(
      item.entityType,
      item.entityId
    );
    results.push({
      entityType: item.entityType,
      entityId: item.entityId,
      code: item.code,
      result: outcome,
      simulationRef: item.latestAttempt?.simulationRef ?? null,
    });
  }

  return results;
}
