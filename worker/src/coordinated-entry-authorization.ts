import type { PumpFunCreationTimeProof } from "./pump-fun-creation-time.js";

const COORDINATED_FINALITY_RETRY_DELAYS_MS = [12_000, 15_000, 15_000] as const;

export type CoordinatedEntryAuthorization = {
  expiresAtMs: number;
  marketDataExpiresAtMs: number;
  targetScopeFingerprint: string;
  configFingerprint: string;
  sellRevision: number;
  createProof?: PumpFunCreationTimeProof;
  finalizedBuySignatures: string[];
};

export type CoordinatedEntryRuntimeFence = {
  nowMs: number;
  entriesEnabled: boolean;
  configTransitioning: boolean;
  entryStrategy: string;
  targetScopeFingerprint: string;
  configFingerprint: string;
  sellRevision: number;
};

/**
 * Process-local last-mile fence for a coordinated signal that has already
 * consumed its tracker reservation. Durable entry claims remain the global
 * idempotency boundary; this prevents a delayed signal from surviving a local
 * sell, settings/target change, stale market snapshot, or hard expiry.
 */
export function coordinatedEntryAuthorizationIsCurrent(
  authorization: CoordinatedEntryAuthorization,
  runtime: CoordinatedEntryRuntimeFence,
): boolean {
  return (
    Number.isSafeInteger(runtime.nowMs) &&
    runtime.nowMs > 0 &&
    runtime.nowMs < authorization.expiresAtMs &&
    runtime.nowMs < authorization.marketDataExpiresAtMs &&
    runtime.entriesEnabled &&
    !runtime.configTransitioning &&
    runtime.entryStrategy === "coordinated" &&
    runtime.targetScopeFingerprint === authorization.targetScopeFingerprint &&
    runtime.configFingerprint === authorization.configFingerprint &&
    runtime.sellRevision === authorization.sellRevision
  );
}

/**
 * A target sell at or after the first contributing buy invalidates the whole
 * cluster. Equality fails closed because this path has no durable same-slot
 * transaction-order witness.
 */
export function coordinatedClusterHasNoInterveningTargetSell(
  contributingSlots: readonly number[],
  highestObservedTargetSellSlot: number,
): boolean {
  if (
    contributingSlots.length === 0 ||
    contributingSlots.some((slot) => !Number.isSafeInteger(slot) || slot <= 0) ||
    !Number.isSafeInteger(highestObservedTargetSellSlot) ||
    highestObservedTargetSellSlot < 0
  ) {
    return false;
  }
  return (
    highestObservedTargetSellSlot === 0 ||
    highestObservedTargetSellSlot < Math.min(...contributingSlots)
  );
}

/**
 * Finality is expected to lag a processed/confirmed target-buy signal. These
 * codes mean the exact evidence is not ready yet, rather than contradictory.
 */
export function coordinatedCreationFinalityIsPending(failure: {
  code: string;
  retryable: boolean;
}): boolean {
  return (
    failure.retryable &&
    (failure.code === "finalized_head_unavailable" ||
      failure.code === "finalized_event_unavailable")
  );
}

/**
 * Bounded finality-aware schedule: checks occur initially, then at roughly
 * 12s, 27s, and 42s. The caller's five-minute signal deadline remains the
 * absolute upper bound.
 */
export function coordinatedFinalityRetryDelayMs(completedWaits: number): number | null {
  if (!Number.isSafeInteger(completedWaits) || completedWaits < 0) return null;
  return COORDINATED_FINALITY_RETRY_DELAYS_MS[completedWaits] ?? null;
}
