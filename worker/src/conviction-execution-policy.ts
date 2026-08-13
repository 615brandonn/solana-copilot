import type { AutomaticEntryStrategy } from "./entry-strategy-router.js";

export type ConvictionLiveExecutionGateInput = {
  strategy: AutomaticEntryStrategy;
  tradingMode: "shadow" | "live";
  entriesEnabled: boolean;
  monitoringBlocked: boolean;
  fresh: boolean;
  uncertainEntry: boolean;
  existingExposureUsd: number;
  requestedBuyUsd: number;
  maxExposureUsd: number;
};

export type ConvictionLiveExecutionGate = { allowed: true } | { allowed: false; reason: string };

/**
 * Pure final-boundary policy for a live Conviction transaction. Runtime code
 * still rechecks this immediately before calling the shared executor.
 */
export function evaluateConvictionLiveExecutionGate(
  input: ConvictionLiveExecutionGateInput,
): ConvictionLiveExecutionGate {
  if (input.strategy !== "conviction") {
    return { allowed: false, reason: "Conviction Mode is not the active entry strategy" };
  }
  if (input.tradingMode !== "live") {
    return { allowed: false, reason: "Conviction trading mode is not live" };
  }
  if (!input.entriesEnabled) {
    return { allowed: false, reason: "global Entries switch is off" };
  }
  if (input.monitoringBlocked) {
    return { allowed: false, reason: "entry monitoring circuit breaker is active" };
  }
  if (!input.fresh) {
    return { allowed: false, reason: "Conviction source event is stale" };
  }
  if (input.uncertainEntry) {
    return { allowed: false, reason: "an earlier entry outcome is uncertain" };
  }
  const exposure = Number(input.existingExposureUsd);
  const buy = Number(input.requestedBuyUsd);
  const cap = Number(input.maxExposureUsd);
  if (
    !Number.isFinite(exposure) ||
    !Number.isFinite(buy) ||
    !Number.isFinite(cap) ||
    exposure < 0 ||
    buy <= 0 ||
    cap <= 0
  ) {
    return { allowed: false, reason: "Conviction exposure values are invalid" };
  }
  if (exposure + buy > cap + 1e-9) {
    return { allowed: false, reason: "max position per token would be exceeded" };
  }
  return { allowed: true };
}
