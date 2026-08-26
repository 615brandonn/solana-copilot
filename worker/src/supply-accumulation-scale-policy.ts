import type { AutomaticEntryStrategy } from "./entry-strategy-router.js";

export const SUPPLY_SCALE_ACTION_DEADLINE_MS = 55_000;
export const SUPPLY_SCALE_MIN_THRESHOLD_BPS = 1_000;
export const SUPPLY_SCALE_MAX_THRESHOLD_BPS = 2_000;

const MAX_SUPPLY_SCALE_MARKET_CAP_USD = 20_000;
const FUTURE_EVENT_TOLERANCE_MS = 5_000;
const SCALE_STAGES = [2, 3, 4] as const;

export type SupplyScaleStage = (typeof SCALE_STAGES)[number];

export type SupplyScaleStageConfig = {
  stage: SupplyScaleStage;
  enabled: boolean;
  thresholdPct: number;
  buyUsd: number;
};

export type SupplyScalePolicyConfig = {
  /** Threshold that opened the original position. */
  baseThresholdPct: number;
  stages: readonly SupplyScaleStageConfig[];
  minMarketCapUsd: number;
  maxMarketCapUsd: number;
  maxExposureUsd: number;
};

export type NormalizedSupplyScaleStageConfig = SupplyScaleStageConfig & {
  thresholdBps: number;
};

export type NormalizedSupplyScalePolicyConfig = Omit<SupplyScalePolicyConfig, "stages"> & {
  baseThresholdBps: number;
  stages: readonly NormalizedSupplyScaleStageConfig[];
};

export type SupplyScaleConfigValidation =
  | { ok: true; config: NormalizedSupplyScalePolicyConfig }
  | { ok: false; reasons: readonly string[] };

export type SupplyScaleProgress = {
  initialEntryPersisted: boolean;
  initialSourceEventKey: string;
  /** Slot of the original entry or most recently persisted scale stage. */
  lastAdvancedSlot: bigint;
  persistedStages: readonly SupplyScaleStage[];
  /** Any claimed/submitted/landed/uncertain stage blocks a new owner. */
  unresolvedStage?: SupplyScaleStage;
  /** Includes every source event that already owns or persisted a scale claim. */
  usedSourceEventKeys: readonly string[];
};

export type SupplyScaleSourceEvent = {
  eventKey: string;
  slot: bigint;
  eventAtMs: number;
};

export type SupplyScaleEvaluationInput = {
  config: SupplyScalePolicyConfig;
  progress: SupplyScaleProgress;
  source: SupplyScaleSourceEvent;
  nowMs: number;
  entriesEnabled: boolean;
  supplyModeEnabled: boolean;
  automaticEntryStrategy: AutomaticEntryStrategy;
  monitoringBlocked: boolean;
  custodySafe: boolean;
  dataReliable: boolean;
  configurationCurrent: boolean;
  positionOpen: boolean;
  /** True while no exit-side or foreign mutation occurred; prior scale buys are allowed. */
  positionUntouched: boolean;
  /** Durable lifetime evidence; rolling-window state is not sufficient. */
  lifetimeSellSeen: boolean;
  netAcquiredRaw: bigint;
  totalSupplyRaw: bigint;
  currentMarketCapUsd: number;
  projectedMarketCapUsd: number;
  existingExposureUsd: number;
};

export type SupplyScaleSkipReason =
  | "invalid_config"
  | "invalid_event_time"
  | "entries_disabled"
  | "supply_mode_disabled"
  | "wrong_entry_strategy"
  | "monitoring_blocked"
  | "custody_unsafe"
  | "data_unreliable"
  | "configuration_changed"
  | "position_not_open"
  | "position_not_untouched"
  | "lifetime_sell_seen"
  | "initial_entry_not_persisted"
  | "stage_claim_in_flight"
  | "invalid_stage_progress"
  | "scale_complete"
  | "source_event_not_distinct"
  | "source_event_not_later"
  | "threshold_not_reached"
  | "market_cap_unavailable"
  | "market_cap_below_minimum"
  | "market_cap_at_or_above_maximum"
  | "projected_market_cap_at_or_above_maximum"
  | "exposure_invalid"
  | "exposure_limit_exceeded";

export type SupplyScaleDecision =
  | {
      action: "claim";
      stage: SupplyScaleStage;
      thresholdBps: number;
      buyUsd: number;
      eventAgeMs: number;
      projectedExposureUsd: number;
    }
  | {
      action: "observe";
      reason: "action_deadline_exceeded";
      eventAgeMs: number;
    }
  | {
      action: "skip";
      reason: SupplyScaleSkipReason;
      eventAgeMs?: number;
      details?: readonly string[];
    };

export type SupplyScaleStageSelection =
  | { ok: true; stage: NormalizedSupplyScaleStageConfig }
  | {
      ok: false;
      reason:
        | "initial_entry_not_persisted"
        | "stage_claim_in_flight"
        | "invalid_stage_progress"
        | "scale_complete"
        | "source_event_not_distinct"
        | "source_event_not_later";
    };

/** Converts a configured percentage to exact integer basis points. */
export function supplyScaleThresholdPctToBps(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const scaled = value * 100;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-7 || !Number.isSafeInteger(rounded)) return null;
  return rounded;
}

/**
 * Validates the complete tier chain before any signal can be considered.
 * Disabled stages must be a suffix so a later stage can never leap a gap.
 */
export function validateSupplyScalePolicyConfig(
  input: SupplyScalePolicyConfig,
): SupplyScaleConfigValidation {
  const reasons: string[] = [];
  const baseThresholdBps = supplyScaleThresholdPctToBps(input.baseThresholdPct);
  if (
    baseThresholdBps === null ||
    baseThresholdBps < SUPPLY_SCALE_MIN_THRESHOLD_BPS ||
    baseThresholdBps > SUPPLY_SCALE_MAX_THRESHOLD_BPS
  ) {
    reasons.push("base threshold must be an exact value from 10% through 20%");
  }

  if (input.stages.length !== SCALE_STAGES.length) {
    reasons.push("scale configuration must contain stages 2, 3, and 4 exactly once");
  }

  const normalizedStages: NormalizedSupplyScaleStageConfig[] = [];
  let priorThresholdBps = baseThresholdBps ?? SUPPLY_SCALE_MAX_THRESHOLD_BPS;
  let disabledStageSeen = false;
  for (let index = 0; index < SCALE_STAGES.length; index += 1) {
    const expectedStage = SCALE_STAGES[index];
    const stage = input.stages[index];
    if (!stage || stage.stage !== expectedStage) {
      reasons.push(`scale stage ${expectedStage} is missing or out of order`);
      continue;
    }
    const thresholdBps = supplyScaleThresholdPctToBps(stage.thresholdPct);
    if (
      thresholdBps === null ||
      thresholdBps < SUPPLY_SCALE_MIN_THRESHOLD_BPS ||
      thresholdBps > SUPPLY_SCALE_MAX_THRESHOLD_BPS
    ) {
      reasons.push(
        `scale stage ${stage.stage} threshold must be an exact value from 10% through 20%`,
      );
    } else if (stage.enabled && thresholdBps <= priorThresholdBps) {
      reasons.push(
        `scale stage ${stage.stage} threshold must be strictly above the prior threshold`,
      );
    }
    if (stage.enabled && thresholdBps !== null) priorThresholdBps = thresholdBps;

    const buyUsd = Number(stage.buyUsd);
    if (!Number.isFinite(buyUsd) || buyUsd <= 0) {
      reasons.push(`scale stage ${stage.stage} buy amount must be positive`);
    }
    if (!stage.enabled) disabledStageSeen = true;
    else if (disabledStageSeen) {
      reasons.push("enabled scale stages must be contiguous from stage 2");
    }
    if (thresholdBps !== null) normalizedStages.push({ ...stage, buyUsd, thresholdBps });
  }

  const minMarketCapUsd = Number(input.minMarketCapUsd);
  const maxMarketCapUsd = Number(input.maxMarketCapUsd);
  if (!Number.isFinite(minMarketCapUsd) || minMarketCapUsd < 0) {
    reasons.push("minimum market cap must be a non-negative finite value");
  }
  if (
    !Number.isFinite(maxMarketCapUsd) ||
    maxMarketCapUsd <= 0 ||
    maxMarketCapUsd > MAX_SUPPLY_SCALE_MARKET_CAP_USD
  ) {
    reasons.push("maximum market cap must be positive and no greater than $20,000");
  }
  if (
    Number.isFinite(minMarketCapUsd) &&
    Number.isFinite(maxMarketCapUsd) &&
    minMarketCapUsd >= maxMarketCapUsd
  ) {
    reasons.push("minimum market cap must be strictly below maximum market cap");
  }

  const maxExposureUsd = Number(input.maxExposureUsd);
  if (!Number.isFinite(maxExposureUsd) || maxExposureUsd <= 0) {
    reasons.push("maximum exposure must be a positive finite value");
  }

  if (reasons.length > 0 || baseThresholdBps === null || normalizedStages.length !== 3) {
    return { ok: false, reasons };
  }
  return {
    ok: true,
    config: {
      ...input,
      minMarketCapUsd,
      maxMarketCapUsd,
      maxExposureUsd,
      baseThresholdBps,
      stages: normalizedStages,
    },
  };
}

/** Exact raw-integer threshold comparison; no token/UI float participates. */
export function reachesSupplyScaleThreshold(
  netAcquiredRaw: bigint,
  totalSupplyRaw: bigint,
  thresholdBps: number,
): boolean {
  if (
    netAcquiredRaw < 0n ||
    totalSupplyRaw <= 0n ||
    netAcquiredRaw > totalSupplyRaw ||
    !Number.isSafeInteger(thresholdBps) ||
    thresholdBps < SUPPLY_SCALE_MIN_THRESHOLD_BPS ||
    thresholdBps > SUPPLY_SCALE_MAX_THRESHOLD_BPS
  ) {
    return false;
  }
  return netAcquiredRaw * 10_000n >= totalSupplyRaw * BigInt(thresholdBps);
}

/** Selects at most one next stage for one exact, later source event. */
export function selectNextSupplyScaleStage(
  config: NormalizedSupplyScalePolicyConfig,
  progress: SupplyScaleProgress,
  source: SupplyScaleSourceEvent,
): SupplyScaleStageSelection {
  if (!progress.initialEntryPersisted) {
    return { ok: false, reason: "initial_entry_not_persisted" };
  }
  if (progress.unresolvedStage !== undefined) {
    return { ok: false, reason: "stage_claim_in_flight" };
  }

  const enabledStages = config.stages.filter((stage) => stage.enabled);
  const persisted = new Set(progress.persistedStages);
  if (persisted.size !== progress.persistedStages.length) {
    return { ok: false, reason: "invalid_stage_progress" };
  }
  for (let index = 0; index < enabledStages.length; index += 1) {
    const stage = enabledStages[index];
    const isPersisted = persisted.has(stage.stage);
    const earlierPersisted = enabledStages
      .slice(0, index)
      .every((prior) => persisted.has(prior.stage));
    if (isPersisted && !earlierPersisted) {
      return { ok: false, reason: "invalid_stage_progress" };
    }
  }
  if (
    progress.persistedStages.some(
      (stage) => !enabledStages.some((configured) => configured.stage === stage),
    )
  ) {
    return { ok: false, reason: "invalid_stage_progress" };
  }

  const nextStage = enabledStages.find((stage) => !persisted.has(stage.stage));
  if (!nextStage) return { ok: false, reason: "scale_complete" };

  const eventKey = source.eventKey.trim();
  if (
    eventKey.length === 0 ||
    eventKey === progress.initialSourceEventKey.trim() ||
    progress.usedSourceEventKeys.some((used) => used.trim() === eventKey)
  ) {
    return { ok: false, reason: "source_event_not_distinct" };
  }
  if (source.slot <= progress.lastAdvancedSlot || source.slot <= 0n) {
    return { ok: false, reason: "source_event_not_later" };
  }
  return { ok: true, stage: nextStage };
}

function eventAge(
  sourceEventAtMs: number,
  nowMs: number,
): { ok: true; ageMs: number } | { ok: false } {
  if (!Number.isFinite(sourceEventAtMs) || sourceEventAtMs <= 0 || !Number.isFinite(nowMs)) {
    return { ok: false };
  }
  const ageMs = nowMs - sourceEventAtMs;
  if (ageMs < -FUTURE_EVENT_TOLERANCE_MS) return { ok: false };
  return { ok: true, ageMs: Math.max(0, Math.round(ageMs)) };
}

/**
 * Pure final-boundary policy for a Supply scale transaction. The caller must
 * run it again immediately before network submission with fresh DB/chain data.
 */
export function evaluateSupplyScaleAction(input: SupplyScaleEvaluationInput): SupplyScaleDecision {
  const validated = validateSupplyScalePolicyConfig(input.config);
  if (!validated.ok) {
    return { action: "skip", reason: "invalid_config", details: validated.reasons };
  }

  const age = eventAge(input.source.eventAtMs, input.nowMs);
  if (!age.ok) return { action: "skip", reason: "invalid_event_time" };
  if (age.ageMs > SUPPLY_SCALE_ACTION_DEADLINE_MS) {
    return { action: "observe", reason: "action_deadline_exceeded", eventAgeMs: age.ageMs };
  }

  const skip = (reason: SupplyScaleSkipReason): SupplyScaleDecision => ({
    action: "skip",
    reason,
    eventAgeMs: age.ageMs,
  });
  if (!input.entriesEnabled) return skip("entries_disabled");
  if (!input.supplyModeEnabled) return skip("supply_mode_disabled");
  if (input.automaticEntryStrategy !== "supply_accumulation") {
    return skip("wrong_entry_strategy");
  }
  if (input.monitoringBlocked) return skip("monitoring_blocked");
  if (!input.custodySafe) return skip("custody_unsafe");
  if (!input.dataReliable) return skip("data_unreliable");
  if (!input.configurationCurrent) return skip("configuration_changed");
  if (!input.positionOpen) return skip("position_not_open");
  if (!input.positionUntouched) return skip("position_not_untouched");
  if (input.lifetimeSellSeen) return skip("lifetime_sell_seen");

  const selection = selectNextSupplyScaleStage(validated.config, input.progress, input.source);
  if (!selection.ok) return skip(selection.reason);

  if (
    !reachesSupplyScaleThreshold(
      input.netAcquiredRaw,
      input.totalSupplyRaw,
      selection.stage.thresholdBps,
    )
  ) {
    return skip("threshold_not_reached");
  }

  const currentMarketCapUsd = Number(input.currentMarketCapUsd);
  const projectedMarketCapUsd = Number(input.projectedMarketCapUsd);
  if (
    !Number.isFinite(currentMarketCapUsd) ||
    !Number.isFinite(projectedMarketCapUsd) ||
    currentMarketCapUsd <= 0 ||
    projectedMarketCapUsd < currentMarketCapUsd
  ) {
    return skip("market_cap_unavailable");
  }
  if (currentMarketCapUsd < validated.config.minMarketCapUsd) {
    return skip("market_cap_below_minimum");
  }
  if (currentMarketCapUsd >= validated.config.maxMarketCapUsd) {
    return skip("market_cap_at_or_above_maximum");
  }
  if (projectedMarketCapUsd >= validated.config.maxMarketCapUsd) {
    return skip("projected_market_cap_at_or_above_maximum");
  }

  const existingExposureUsd = Number(input.existingExposureUsd);
  if (!Number.isFinite(existingExposureUsd) || existingExposureUsd < 0) {
    return skip("exposure_invalid");
  }
  const projectedExposureUsd = existingExposureUsd + selection.stage.buyUsd;
  if (projectedExposureUsd > validated.config.maxExposureUsd + 1e-9) {
    return skip("exposure_limit_exceeded");
  }

  return {
    action: "claim",
    stage: selection.stage.stage,
    thresholdBps: selection.stage.thresholdBps,
    buyUsd: selection.stage.buyUsd,
    eventAgeMs: age.ageMs,
    projectedExposureUsd,
  };
}
