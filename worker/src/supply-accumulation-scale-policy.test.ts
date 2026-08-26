import assert from "node:assert/strict";
import test from "node:test";
import { BoundedBackgroundQueue } from "./bounded-background-queue.js";
import {
  SUPPLY_SCALE_ACTION_DEADLINE_MS,
  evaluateSupplyScaleAction,
  reachesSupplyScaleThreshold,
  supplyScaleThresholdPctToBps,
  validateSupplyScalePolicyConfig,
  type SupplyScaleEvaluationInput,
  type SupplyScalePolicyConfig,
  type SupplyScaleProgress,
} from "./supply-accumulation-scale-policy.js";

const config: SupplyScalePolicyConfig = {
  baseThresholdPct: 10,
  stages: [
    { stage: 2, enabled: true, thresholdPct: 12, buyUsd: 10 },
    { stage: 3, enabled: true, thresholdPct: 15, buyUsd: 10 },
    { stage: 4, enabled: true, thresholdPct: 18, buyUsd: 10 },
  ],
  minMarketCapUsd: 2_000,
  maxMarketCapUsd: 20_000,
  maxExposureUsd: 50,
};

const progress: SupplyScaleProgress = {
  initialEntryPersisted: true,
  initialSourceEventKey: "entry-event",
  lastAdvancedSlot: 100n,
  persistedStages: [],
  usedSourceEventKeys: [],
};

const safe: SupplyScaleEvaluationInput = {
  config,
  progress,
  source: { eventKey: "stage-2-event", slot: 101n, eventAtMs: 1_000_000 },
  nowMs: 1_001_000,
  entriesEnabled: true,
  supplyModeEnabled: true,
  automaticEntryStrategy: "supply_accumulation",
  monitoringBlocked: false,
  custodySafe: true,
  dataReliable: true,
  configurationCurrent: true,
  positionOpen: true,
  positionUntouched: true,
  lifetimeSellSeen: false,
  netAcquiredRaw: 120n,
  totalSupplyRaw: 1_000n,
  currentMarketCapUsd: 2_000,
  projectedMarketCapUsd: 2_100,
  existingExposureUsd: 20,
};

function reason(input: SupplyScaleEvaluationInput): string | undefined {
  const decision = evaluateSupplyScaleAction(input);
  return decision.action === "claim" ? undefined : decision.reason;
}

test("configuration requires an exact contiguous 2/3/4 chain with strictly increasing thresholds", () => {
  const valid = validateSupplyScalePolicyConfig(config);
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.deepEqual(
      valid.config.stages.map((stage) => stage.thresholdBps),
      [1_200, 1_500, 1_800],
    );
  }
  assert.equal(supplyScaleThresholdPctToBps(12.1), 1_210);
  assert.equal(supplyScaleThresholdPctToBps(12.345), null);

  const baseAboveStage2 = validateSupplyScalePolicyConfig({ ...config, baseThresholdPct: 12 });
  assert.equal(baseAboveStage2.ok, false);
  assert.ok(
    !baseAboveStage2.ok &&
      baseAboveStage2.reasons.some((value) => value.includes("strictly above")),
  );

  const dormantScales = validateSupplyScalePolicyConfig({
    ...config,
    baseThresholdPct: 20,
    stages: config.stages.map((stage) => ({ ...stage, enabled: false })),
  });
  assert.equal(
    dormantScales.ok,
    true,
    "disabled tier defaults must not block an unrelated initial-threshold change",
  );

  const gap = validateSupplyScalePolicyConfig({
    ...config,
    stages: [{ ...config.stages[0], enabled: false }, config.stages[1], config.stages[2]],
  });
  assert.equal(gap.ok, false);
  assert.ok(
    !gap.ok && gap.reasons.includes("enabled scale stages must be contiguous from stage 2"),
  );

  assert.equal(validateSupplyScalePolicyConfig({ ...config, maxMarketCapUsd: 20_001 }).ok, false);
  assert.equal(validateSupplyScalePolicyConfig({ ...config, minMarketCapUsd: 20_000 }).ok, false);
});

test("raw threshold boundaries use exact BigInt cross multiplication", () => {
  assert.equal(reachesSupplyScaleThreshold(120n, 1_000n, 1_200), true);
  assert.equal(reachesSupplyScaleThreshold(119n, 1_000n, 1_200), false);
  assert.equal(reachesSupplyScaleThreshold(40n, 333n, 1_200), true);
  assert.equal(reachesSupplyScaleThreshold(39n, 333n, 1_200), false);
  assert.equal(reachesSupplyScaleThreshold(1_001n, 1_000n, 1_200), false);
});

test("distinct later events advance contiguous stages 2, 3, and 4 exactly once", () => {
  const stage2 = evaluateSupplyScaleAction(safe);
  assert.deepEqual(stage2, {
    action: "claim",
    stage: 2,
    thresholdBps: 1_200,
    buyUsd: 10,
    eventAgeMs: 1_000,
    projectedExposureUsd: 30,
  });

  const afterStage2: SupplyScaleProgress = {
    ...progress,
    lastAdvancedSlot: 101n,
    persistedStages: [2],
    usedSourceEventKeys: ["stage-2-event"],
  };
  assert.equal(
    reason({ ...safe, progress: afterStage2, netAcquiredRaw: 180n }),
    "source_event_not_distinct",
    "one event cannot claim both stage 2 and stage 3 even after a large threshold jump",
  );

  const stage3 = evaluateSupplyScaleAction({
    ...safe,
    progress: afterStage2,
    source: { eventKey: "stage-3-event", slot: 102n, eventAtMs: 1_002_000 },
    nowMs: 1_003_000,
    netAcquiredRaw: 150n,
    existingExposureUsd: 30,
  });
  assert.equal(stage3.action, "claim");
  assert.equal(stage3.action === "claim" && stage3.stage, 3);

  const stage4 = evaluateSupplyScaleAction({
    ...safe,
    progress: {
      ...afterStage2,
      lastAdvancedSlot: 102n,
      persistedStages: [2, 3],
      usedSourceEventKeys: ["stage-2-event", "stage-3-event"],
    },
    source: { eventKey: "stage-4-event", slot: 103n, eventAtMs: 1_004_000 },
    nowMs: 1_005_000,
    netAcquiredRaw: 180n,
    existingExposureUsd: 40,
  });
  assert.equal(stage4.action, "claim");
  assert.equal(stage4.action === "claim" && stage4.stage, 4);

  assert.equal(
    reason({
      ...safe,
      progress: {
        ...progress,
        lastAdvancedSlot: 103n,
        persistedStages: [2, 3, 4],
        usedSourceEventKeys: ["stage-2-event", "stage-3-event", "stage-4-event"],
      },
      source: { eventKey: "fifth-event", slot: 104n, eventAtMs: 1_006_000 },
      nowMs: 1_007_000,
      netAcquiredRaw: 200n,
    }),
    "scale_complete",
  );
});

test("stage progress must be persisted, contiguous, and free of an unresolved owner", () => {
  assert.equal(
    reason({ ...safe, progress: { ...progress, initialEntryPersisted: false } }),
    "initial_entry_not_persisted",
  );
  assert.equal(
    reason({ ...safe, progress: { ...progress, unresolvedStage: 2 } }),
    "stage_claim_in_flight",
  );
  assert.equal(
    reason({ ...safe, progress: { ...progress, persistedStages: [3] } }),
    "invalid_stage_progress",
  );
  assert.equal(
    reason({ ...safe, source: { ...safe.source, slot: progress.lastAdvancedSlot } }),
    "source_event_not_later",
  );
  assert.equal(
    reason({ ...safe, source: { ...safe.source, eventKey: progress.initialSourceEventKey } }),
    "source_event_not_distinct",
  );
});

test("every runtime, custody, position, and lifetime-sell gate fails closed", () => {
  const cases: Array<[Partial<SupplyScaleEvaluationInput>, string]> = [
    [{ entriesEnabled: false }, "entries_disabled"],
    [{ supplyModeEnabled: false }, "supply_mode_disabled"],
    [{ automaticEntryStrategy: "coordinated" }, "wrong_entry_strategy"],
    [{ monitoringBlocked: true }, "monitoring_blocked"],
    [{ custodySafe: false }, "custody_unsafe"],
    [{ dataReliable: false }, "data_unreliable"],
    [{ configurationCurrent: false }, "configuration_changed"],
    [{ positionOpen: false }, "position_not_open"],
    [{ positionUntouched: false }, "position_not_untouched"],
    [{ lifetimeSellSeen: true }, "lifetime_sell_seen"],
  ];
  for (const [patch, expected] of cases) {
    assert.equal(reason({ ...safe, ...patch }), expected);
  }
});

test("market-cap floor is inclusive while current and projected ceilings are strict", () => {
  assert.equal(evaluateSupplyScaleAction(safe).action, "claim", "$2,000 is admitted");
  assert.equal(
    reason({ ...safe, currentMarketCapUsd: 1_999.99, projectedMarketCapUsd: 2_050 }),
    "market_cap_below_minimum",
  );
  assert.equal(
    reason({ ...safe, currentMarketCapUsd: 20_000, projectedMarketCapUsd: 20_000 }),
    "market_cap_at_or_above_maximum",
  );
  assert.equal(
    reason({ ...safe, currentMarketCapUsd: 19_900, projectedMarketCapUsd: 20_000 }),
    "projected_market_cap_at_or_above_maximum",
  );
  assert.equal(
    evaluateSupplyScaleAction({
      ...safe,
      currentMarketCapUsd: 19_900,
      projectedMarketCapUsd: 19_999.99,
    }).action,
    "claim",
  );
});

test("the configured exposure cap admits equality and rejects any excess", () => {
  assert.equal(evaluateSupplyScaleAction({ ...safe, existingExposureUsd: 40 }).action, "claim");
  assert.equal(reason({ ...safe, existingExposureUsd: 40.01 }), "exposure_limit_exceeded");
  assert.equal(reason({ ...safe, existingExposureUsd: Number.NaN }), "exposure_invalid");
});

test("the 55-second deadline is inclusive and over-deadline work is observation-only", () => {
  assert.equal(
    evaluateSupplyScaleAction({
      ...safe,
      nowMs: safe.source.eventAtMs + SUPPLY_SCALE_ACTION_DEADLINE_MS,
    }).action,
    "claim",
  );
  assert.deepEqual(
    evaluateSupplyScaleAction({
      ...safe,
      nowMs: safe.source.eventAtMs + SUPPLY_SCALE_ACTION_DEADLINE_MS + 1,
    }),
    {
      action: "observe",
      reason: "action_deadline_exceeded",
      eventAgeMs: SUPPLY_SCALE_ACTION_DEADLINE_MS + 1,
    },
  );
  assert.equal(reason({ ...safe, nowMs: safe.source.eventAtMs - 5_001 }), "invalid_event_time");
});

test("queued work that starts after its deadline cannot become a transaction", async () => {
  const queue = new BoundedBackgroundQueue(1, 2);
  let releaseBlocker!: () => void;
  const blocker = new Promise<void>((resolve) => {
    releaseBlocker = resolve;
  });
  let nowMs = safe.source.eventAtMs;
  let decision: ReturnType<typeof evaluateSupplyScaleAction> | undefined;

  assert.equal(
    queue.schedule("blocker", () => blocker),
    "scheduled",
  );
  assert.equal(
    queue.schedule("scale-event", async () => {
      decision = evaluateSupplyScaleAction({ ...safe, nowMs });
    }),
    "scheduled",
  );

  nowMs = safe.source.eventAtMs + SUPPLY_SCALE_ACTION_DEADLINE_MS + 1;
  releaseBlocker();
  for (let attempt = 0; attempt < 50 && !decision; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(decision, {
    action: "observe",
    reason: "action_deadline_exceeded",
    eventAgeMs: SUPPLY_SCALE_ACTION_DEADLINE_MS + 1,
  });
});
