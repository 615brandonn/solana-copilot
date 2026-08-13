import assert from "node:assert/strict";
import test from "node:test";
import {
  ConvictionRuntime,
  type ConvictionRuntimeStore,
  type StoredConvictionTier,
} from "./conviction-runtime.js";
import type { ConvictionEvent } from "./conviction-engine.js";

class MemoryStore implements ConvictionRuntimeStore {
  events: ConvictionEvent[] = [];
  tiers: StoredConvictionTier[] = [];
  states = 0;
  savedStateMints: string[] = [];
  ranks = 0;
  transitions = 0;
  transitionEvents: string[] = [];
  eventLoads = 0;
  tierLoads = 0;
  tierUpdates = 0;
  failNextClaimAfterInsert = false;
  async loadEvents() {
    this.eventLoads += 1;
    return [...this.events];
  }
  async loadTiers() {
    this.tierLoads += 1;
    return [...this.tiers];
  }
  async insertEvent(event: ConvictionEvent) {
    const existingIndex = this.events.findIndex((row) => row.eventId === event.eventId);
    if (existingIndex >= 0) {
      const existing = this.events[existingIndex]!;
      if (
        existing.classificationReliable !== true &&
        event.classificationReliable === true &&
        (event.type === "DEX_BUY" || event.type === "DEX_SELL")
      ) {
        this.events[existingIndex] = event;
        return "upgraded" as const;
      }
      return "duplicate" as const;
    }
    this.events.push(event);
    return "inserted" as const;
  }
  async saveState(snapshot: Parameters<ConvictionRuntimeStore["saveState"]>[0]) {
    this.states += 1;
    this.savedStateMints.push(snapshot.mint);
  }
  async saveRanks(rows: unknown[]) {
    this.ranks += rows.length;
  }
  async saveTransitions(rows: Parameters<ConvictionRuntimeStore["saveTransitions"]>[0]) {
    this.transitions += rows.length;
    this.transitionEvents.push(...rows.map((row) => row.eventType));
  }
  async claimTier(input: Parameters<ConvictionRuntimeStore["claimTier"]>[0]) {
    const old = this.tiers.find(
      (row) =>
        row.tokenMint === input.tokenMint &&
        row.tierId === input.tierId &&
        row.tradingMode === input.tradingMode,
    );
    if (old?.status === "failed_pre_submit" && input.status === "claimed") {
      Object.assign(old, {
        status: "claimed" as const,
        tradingMode: input.tradingMode,
        amountUsd: input.amountUsd,
        commitmentUsd: input.commitmentUsd,
      });
      return { claimed: true, row: old };
    }
    if (old) return { claimed: false, row: old };
    const row: StoredConvictionTier = {
      id: `claim-${this.tiers.length + 1}`,
      tokenMint: input.tokenMint,
      tierId: input.tierId,
      status: input.status,
      tradingMode: input.tradingMode,
      amountUsd: input.amountUsd,
      commitmentUsd: input.commitmentUsd,
      sourceEventKey: input.sourceEventKey,
      tierNumber: input.tierNumber,
      executedAtMs: buy.timestampMs,
    };
    this.tiers.push(row);
    if (this.failNextClaimAfterInsert) {
      this.failNextClaimAfterInsert = false;
      throw new Error("simulated lost claim response");
    }
    return { claimed: true, row };
  }
  async updateTier(id: string, update: Parameters<ConvictionRuntimeStore["updateTier"]>[1]) {
    this.tierUpdates += 1;
    const row = this.tiers.find((candidate) => candidate.id === id);
    if (!row) throw new Error("missing tier");
    row.status = update.status;
    if (update.botTxSig !== undefined) {
      row.botTxSig = update.botTxSig ?? undefined;
      row.reference = update.botTxSig ?? row.id;
    }
    if (update.positionId !== undefined) row.positionId = update.positionId ?? undefined;
    return row;
  }
}

const config = {
  enabled: true,
  tradingMode: "shadow" as const,
  rapidFollowEnabled: true,
  clusterWallets: ["a", "b", "c"],
  requiredClusterWalletCount: 3,
  entryTopN: 3,
  minScore: 0,
  minNetCommitmentUsd: 1,
  minRecentNetInflowUsd: 0,
  minCapitalVelocityUsdPerMinute: 0,
  minCapitalAcceleration: -1,
  minConvergedWallets: 1,
  scoreNetCommitmentFullUsd: 1,
  scoreVelocityFullUsdPerMinute: 1,
  tiers: [
    {
      id: "tier_1",
      buyUsd: 5,
      minScore: 0,
      minNetCommitmentUsd: 1,
      minVelocityUsdPerMinute: 0,
      minCommitmentIncreaseRatio: 0,
    },
  ],
};

const buy: ConvictionEvent = {
  eventId: "sig:a:mint:buy",
  timestampMs: 1_800_000_000_000,
  wallet: "a",
  tokenMint: "mint",
  type: "DEX_BUY",
  amountUsd: 2_000,
  classificationReliable: true,
};

test("shadow mode persists a tier but never returns a live action", async () => {
  const store = new MemoryStore();
  const runtime = new ConvictionRuntime(config, store);
  const result = await runtime.observe(buy, { globalEntriesEnabled: true });
  assert.equal(result.action, undefined);
  assert.equal(store.tiers[0]?.status, "shadowed");
  assert.equal(store.states > 0, true);
});

test("concurrent initialization hydrates the durable store exactly once", async () => {
  const store = new MemoryStore();
  const runtime = new ConvictionRuntime(config, store);
  await Promise.all([runtime.initialize(), runtime.initialize(), runtime.initialize()]);
  assert.equal(store.eventLoads, 1);
  assert.equal(store.tierLoads, 1);
});

test("shadow mode still evaluates and records hypothetical tiers while Entries is off", async () => {
  const store = new MemoryStore();
  const runtime = new ConvictionRuntime(config, store);
  const result = await runtime.observe(buy, { globalEntriesEnabled: false });
  assert.equal(result.action, undefined);
  assert.equal(store.tiers[0]?.status, "shadowed");
});

test("authoritative existing exposure is applied before any tier claim", async () => {
  const store = new MemoryStore();
  const runtime = new ConvictionRuntime({ ...config, maxPositionPerTokenUsd: 5 }, store);
  const result = await runtime.observe(buy, {
    globalEntriesEnabled: false,
    currentPositionUsd: 5,
  });
  assert.equal(result.update.snapshot.ourCurrentPositionUsd, 5);
  assert.equal(result.update.nextTier.eligible, false);
  assert.equal(store.tiers.length, 0);
});

test("a duplicate feed event cannot count capital or claim a tier twice", async () => {
  const store = new MemoryStore();
  const runtime = new ConvictionRuntime(config, store);
  await runtime.observe(buy, { globalEntriesEnabled: true });
  const duplicate = await runtime.observe({ ...buy }, { globalEntriesEnabled: true });
  assert.equal(duplicate.duplicate, true);
  assert.equal(store.events.length, 1);
  assert.equal(store.tiers.length, 1);
});

test("a richer verified duplicate upgrades an earlier UNKNOWN observation durably", async () => {
  const store = new MemoryStore();
  const runtime = new ConvictionRuntime({ ...config, breakoutMinScore: 0 }, store);
  const unknown: ConvictionEvent = {
    ...buy,
    type: "UNKNOWN",
    amountUsd: 0,
    classificationReliable: false,
  };
  await runtime.observe(unknown, { globalEntriesEnabled: false });
  assert.equal(store.tiers.length, 0);
  store.transitionEvents = [];
  const upgraded = await runtime.observe(buy, { globalEntriesEnabled: false });
  assert.equal(upgraded.duplicate, false);
  assert.equal(upgraded.update.snapshot.netClusterInvestmentUsd, 2_000);
  assert.equal(store.tiers[0]?.status, "shadowed");
  assert.ok(store.transitionEvents.includes("CONVICTION_STATE_CHANGE"));
  assert.ok(store.transitionEvents.includes("CONVICTION_BREAKOUT"));

  const restarted = new ConvictionRuntime(config, store);
  await restarted.initialize();
  assert.equal(restarted.snapshot("mint")?.netClusterInvestmentUsd, 2_000);
  assert.equal(store.events.length, 1);
  assert.equal(store.events[0]?.type, "DEX_BUY");
});

test("a durable event survives a lost claim response and retries without double-counting", async () => {
  const store = new MemoryStore();
  store.failNextClaimAfterInsert = true;
  const runtime = new ConvictionRuntime({ ...config, tradingMode: "live" }, store);
  const recovered = await runtime.observe(buy, { globalEntriesEnabled: true });
  assert.ok(recovered.action);
  assert.equal(recovered.duplicate, false);
  assert.equal(recovered.action.claim.sourceEventKey, buy.eventId);
  assert.equal(runtime.snapshot("mint")?.netClusterInvestmentUsd, 2_000);
  assert.equal(store.events.length, 1);
  assert.equal(store.tiers.length, 1);
});

test("historical catch-up buys rebuild conviction state without creating a tier", async () => {
  const store = new MemoryStore();
  const runtime = new ConvictionRuntime(config, store);
  const result = await runtime.observe(buy, {
    globalEntriesEnabled: true,
    actionable: false,
  });
  assert.equal(result.update.countedTowardCapital, true);
  assert.equal(result.update.snapshot.netClusterInvestmentUsd, 2_000);
  assert.equal(store.tiers.length, 0);
});

test("sells update distribution state but can never originate an entry tier", async () => {
  const store = new MemoryStore();
  const runtime = new ConvictionRuntime(config, store);
  const sell = await runtime.observe(
    { ...buy, eventId: "sig:a:mint:sell", type: "DEX_SELL" },
    { globalEntriesEnabled: true },
  );
  assert.equal(sell.update.countedTowardCapital, true);
  assert.equal(store.tiers.length, 0);
  assert.equal(sell.action, undefined);
});

test("live requires mode enabled plus global Entries before returning an action", async () => {
  const offStore = new MemoryStore();
  const off = new ConvictionRuntime({ ...config, tradingMode: "live" }, offStore);
  assert.equal((await off.observe(buy, { globalEntriesEnabled: false })).action, undefined);
  assert.equal(offStore.tiers.length, 0);

  const liveStore = new MemoryStore();
  const live = new ConvictionRuntime({ ...config, tradingMode: "live" }, liveStore);
  const result = await live.observe(buy, { globalEntriesEnabled: true });
  assert.ok(result.action);
  assert.equal(liveStore.tiers[0]?.status, "claimed");
});

test("Tier 1 does not announce Rapid Follow when Rapid Follow is disabled", async () => {
  const store = new MemoryStore();
  const runtime = new ConvictionRuntime(
    { ...config, tradingMode: "live", rapidFollowEnabled: false },
    store,
  );
  const result = await runtime.observe(buy, { globalEntriesEnabled: true });
  assert.ok(result.action);
  assert.equal(store.transitionEvents.includes("RAPID_FOLLOW_STARTED"), false);
});

test("restart hydrates consumed tiers and does not execute them again", async () => {
  const store = new MemoryStore();
  const first = new ConvictionRuntime(config, store);
  await first.observe(buy, { globalEntriesEnabled: true });
  const restarted = new ConvictionRuntime(config, store);
  const replay = await restarted.observe({ ...buy }, { globalEntriesEnabled: true });
  assert.equal(replay.duplicate, true);
  assert.equal(store.tiers.length, 1);
});

test("paper tiers never consume live progression or real exposure after a mode switch", async () => {
  const store = new MemoryStore();
  const shadow = new ConvictionRuntime(config, store);
  await shadow.observe(buy, { globalEntriesEnabled: false });
  assert.equal(store.tiers[0]?.tradingMode, "shadow");

  const live = new ConvictionRuntime({ ...config, tradingMode: "live" }, store);
  await live.initialize();
  assert.equal(live.snapshot("mint")?.ourCurrentPositionUsd, 0);
  const result = await live.observe(
    { ...buy, eventId: "live-buy", timestampMs: buy.timestampMs + 1_000 },
    { globalEntriesEnabled: true },
  );
  assert.ok(result.action);
  assert.equal(result.action.claim.tierId, "tier_1");
  assert.equal(store.tiers.length, 2);
});

test("reconfigure reuses hydrated durable state without reloading event history", async () => {
  const store = new MemoryStore();
  const twoTierConfig = {
    ...config,
    tiers: [
      ...config.tiers,
      {
        id: "tier_2",
        buyUsd: 5,
        minScore: 0,
        minNetCommitmentUsd: 2,
        minVelocityUsdPerMinute: 0,
        minCommitmentIncreaseRatio: 0,
      },
    ],
  };
  const runtime = new ConvictionRuntime(twoTierConfig, store);
  await runtime.observe(buy, { globalEntriesEnabled: false });
  assert.equal(store.eventLoads, 1);
  assert.equal(store.tierLoads, 1);

  await runtime.reconfigure({ ...twoTierConfig, minScore: 1 });
  assert.equal(store.eventLoads, 1);
  assert.equal(store.tierLoads, 1);
  assert.equal(runtime.snapshot("mint")?.netClusterInvestmentUsd, 2_000);
  assert.equal(runtime.snapshot("mint")?.executedTiers[0]?.tierId, "tier_1");

  await runtime.observe(
    { ...buy, eventId: "after-config-edit", timestampMs: buy.timestampMs + 1_000 },
    { globalEntriesEnabled: false },
  );
  assert.deepEqual(
    store.tiers.map((tier) => tier.tierId),
    ["tier_1", "tier_2"],
  );
});

test("tick expires silent leaderboards without ever claiming another tier", async () => {
  const store = new MemoryStore();
  const runtime = new ConvictionRuntime(
    { ...config, leaderboardActiveMs: 60_000, dataFreshnessMs: 60_000 },
    store,
  );
  await runtime.observe(buy, { globalEntriesEnabled: false });
  const tierCount = store.tiers.length;
  assert.equal(runtime.snapshot("mint")?.ranks["5"]?.currentRank, 1);
  assert.equal(runtime.snapshot("mint")?.rapidFollowStatus, "active");
  store.transitionEvents = [];

  const tick = await runtime.tick(buy.timestampMs + 60_001);
  assert.equal(tick.refreshedTokenCount, 1);
  assert.equal(runtime.snapshot("mint")?.ranks["5"]?.currentRank, undefined);
  assert.equal(runtime.snapshot("mint")?.ranks["5"]?.direction, "out");
  assert.equal(runtime.snapshot("mint")?.rapidFollowStatus, "stopped");
  assert.ok(store.transitionEvents.includes("RAPID_FOLLOW_STOPPED"));
  assert.equal(store.tiers.length, tierCount);
});

test("tick state persistence stays bounded to the current leaderboard", async () => {
  const store = new MemoryStore();
  const runtime = new ConvictionRuntime({ ...config, leaderboardActiveMs: 3_600_000 }, store);
  for (let index = 0; index < 25; index += 1) {
    await runtime.observe(
      {
        ...buy,
        eventId: `rank-${index}`,
        tokenMint: `mint-${String(index).padStart(2, "0")}`,
        amountUsd: 2_000 - index,
        timestampMs: buy.timestampMs + index,
      },
      { globalEntriesEnabled: false, actionable: false },
    );
  }
  store.savedStateMints = [];
  await runtime.tick(buy.timestampMs + 30_000);
  assert.ok(new Set(store.savedStateMints).size <= 10);
});

test("an observe racing reconfigure is serialized and preserves cumulative state", async () => {
  const store = new MemoryStore();
  const runtime = new ConvictionRuntime(config, store);
  const observing = runtime.observe(buy, { globalEntriesEnabled: false });
  const reconfiguring = runtime.reconfigure({ ...config, minScore: 5 });
  await Promise.all([observing, reconfiguring]);
  assert.equal(runtime.snapshot("mint")?.netClusterInvestmentUsd, 2_000);
  assert.equal(store.eventLoads, 1);
  assert.equal(store.tierLoads, 1);
});

test("a definite pre-submit failure releases the live tier for a later safe retry", async () => {
  const store = new MemoryStore();
  const runtime = new ConvictionRuntime({ ...config, tradingMode: "live" }, store);
  const first = await runtime.observe(buy, { globalEntriesEnabled: true });
  assert.ok(first.action);
  await runtime.transitionAction(first.action.claim, {
    status: "failed_pre_submit",
    errorCode: "quote-unavailable",
  });
  assert.equal(runtime.snapshot("mint")?.executedTiers.length, 0);

  const retry = await runtime.observe(
    { ...buy, eventId: "sig:a:mint:buy-retry", timestampMs: buy.timestampMs + 1_000 },
    { globalEntriesEnabled: true },
  );
  assert.ok(retry.action);
  assert.equal(store.tiers.length, 1);
  assert.equal(store.tiers[0]?.status, "claimed");
});

test("an uncertain live outcome remains consumed and cannot be retried", async () => {
  const store = new MemoryStore();
  const runtime = new ConvictionRuntime({ ...config, tradingMode: "live" }, store);
  const first = await runtime.observe(buy, { globalEntriesEnabled: true });
  assert.ok(first.action);
  await runtime.transitionAction(first.action.claim, {
    status: "uncertain",
    botTxSig: "known-signature",
  });
  const retry = await runtime.observe(
    { ...buy, eventId: "sig:a:mint:buy-later", timestampMs: buy.timestampMs + 1_000 },
    { globalEntriesEnabled: true },
  );
  assert.equal(retry.action, undefined);
  assert.equal(runtime.snapshot("mint")?.executedTiers.length, 1);
});

test("a later live scale-in waits until the prior tier is durably persisted", async () => {
  const store = new MemoryStore();
  const runtime = new ConvictionRuntime(
    {
      ...config,
      tradingMode: "live",
      tiers: [
        ...config.tiers,
        {
          id: "tier_2",
          buyUsd: 5,
          minScore: 0,
          minNetCommitmentUsd: 2,
          minVelocityUsdPerMinute: 0,
          minCommitmentIncreaseRatio: 0,
        },
      ],
    },
    store,
  );
  const first = await runtime.observe(buy, { globalEntriesEnabled: true });
  assert.ok(first.action);

  const blocked = await runtime.observe(
    { ...buy, eventId: "second-buy", timestampMs: buy.timestampMs + 1_000 },
    { globalEntriesEnabled: true },
  );
  assert.equal(blocked.action, undefined);
  assert.equal(store.tiers.length, 1);

  await runtime.transitionAction(first.action.claim, {
    status: "persisted",
    positionId: "position-1",
  });
  const allowed = await runtime.observe(
    { ...buy, eventId: "third-buy", timestampMs: buy.timestampMs + 2_000 },
    { globalEntriesEnabled: true },
  );
  assert.ok(allowed.action);
  assert.equal(allowed.action.claim.tierId, "tier_2");
});

test("an unchanged claimed live tier passes final revalidation without writing or advancing tiers", async () => {
  const store = new MemoryStore();
  const runtime = new ConvictionRuntime({ ...config, tradingMode: "live" }, store);
  const observed = await runtime.observe(buy, { globalEntriesEnabled: true });
  assert.ok(observed.action);
  const tierCount = store.tiers.length;
  const stateWrites = store.states;
  const transitionWrites = store.transitions;

  const decision = await runtime.revalidateLiveClaim(observed.action.claim, {
    nowMs: buy.timestampMs,
    globalEntriesEnabled: true,
    currentPositionUsd: 0,
  });

  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.reasons, []);
  assert.equal(decision.snapshot?.ourCurrentPositionUsd, 0);
  assert.deepEqual(decision.snapshot?.executedTiers, []);
  assert.equal(store.tiers.length, tierCount);
  assert.equal(store.states, stateWrites);
  assert.equal(store.transitions, transitionWrites);
});

test("final revalidation blocks a claim after target-wallet distribution", async () => {
  const store = new MemoryStore();
  const runtime = new ConvictionRuntime(
    {
      ...config,
      tradingMode: "live",
      distributionMinSellsUsd: 1,
      distributionSellRatio: 0.1,
      distributionWalletCount: 1,
    },
    store,
  );
  const observed = await runtime.observe(buy, { globalEntriesEnabled: true });
  assert.ok(observed.action);
  await runtime.observe(
    {
      ...buy,
      eventId: "distribution-after-claim",
      timestampMs: buy.timestampMs + 1_000,
      type: "DEX_SELL",
      amountUsd: 1_000,
    },
    { globalEntriesEnabled: true },
  );

  const decision = await runtime.revalidateLiveClaim(observed.action.claim, {
    nowMs: buy.timestampMs + 1_000,
    globalEntriesEnabled: true,
    currentPositionUsd: 0,
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.includes("meaningful distribution detected"));
});

test("final revalidation refreshes current rank and blocks a displaced initial tier", async () => {
  const store = new MemoryStore();
  const runtime = new ConvictionRuntime(
    { ...config, tradingMode: "live", entryTopN: 1, rankLossGraceMs: 60_000 },
    store,
  );
  const observed = await runtime.observe(buy, { globalEntriesEnabled: true });
  assert.ok(observed.action);
  await runtime.observe(
    {
      ...buy,
      eventId: "higher-ranked-token",
      tokenMint: "higher-ranked-mint",
      timestampMs: buy.timestampMs + 1_000,
      amountUsd: 100_000,
    },
    { globalEntriesEnabled: true, actionable: false },
  );

  const decision = await runtime.revalidateLiveClaim(observed.action.claim, {
    nowMs: buy.timestampMs + 1_000,
    globalEntriesEnabled: true,
    currentPositionUsd: 0,
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.includes("not in Top 1"));
});

test("rank-loss grace applies only when a prior tier really executed", async () => {
  const store = new MemoryStore();
  const twoTierConfig = {
    ...config,
    tradingMode: "live" as const,
    entryTopN: 1,
    rankLossGraceMs: 10_000,
    maxPositionPerTokenUsd: 20,
    tiers: [
      ...config.tiers,
      {
        id: "tier_2",
        buyUsd: 5,
        minScore: 0,
        minNetCommitmentUsd: 2,
        minVelocityUsdPerMinute: 0,
        minCommitmentIncreaseRatio: 0,
      },
    ],
  };
  const runtime = new ConvictionRuntime(twoTierConfig, store);
  const first = await runtime.observe(buy, { globalEntriesEnabled: true });
  assert.ok(first.action);
  await runtime.transitionAction(first.action.claim, {
    status: "persisted",
    positionId: "position-1",
  });
  const second = await runtime.observe(
    { ...buy, eventId: "tier-two-source", timestampMs: buy.timestampMs + 1_000 },
    { globalEntriesEnabled: true, currentPositionUsd: 5 },
  );
  assert.ok(second.action);
  await runtime.observe(
    {
      ...buy,
      eventId: "rank-one-competitor",
      tokenMint: "competitor",
      timestampMs: buy.timestampMs + 2_000,
      amountUsd: 100_000,
    },
    { globalEntriesEnabled: true, actionable: false },
  );

  const withinGrace = await runtime.revalidateLiveClaim(second.action.claim, {
    nowMs: buy.timestampMs + 2_000,
    globalEntriesEnabled: true,
    currentPositionUsd: 5,
  });
  assert.equal(withinGrace.allowed, true);

  const afterGrace = await runtime.revalidateLiveClaim(second.action.claim, {
    nowMs: buy.timestampMs + 12_001,
    globalEntriesEnabled: true,
    currentPositionUsd: 5,
  });
  assert.equal(afterGrace.allowed, false);
  assert.ok(afterGrace.reasons.includes("not in Top 1"));
});

test("final revalidation blocks stale conviction data", async () => {
  const store = new MemoryStore();
  const runtime = new ConvictionRuntime(
    {
      ...config,
      tradingMode: "live",
      dataFreshnessMs: 1_000,
      leaderboardActiveMs: 60_000,
    },
    store,
  );
  const observed = await runtime.observe(buy, { globalEntriesEnabled: true });
  assert.ok(observed.action);
  const decision = await runtime.revalidateLiveClaim(observed.action.claim, {
    nowMs: buy.timestampMs + 1_001,
    globalEntriesEnabled: true,
    currentPositionUsd: 0,
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.includes("conviction data is stale"));
  assert.ok(decision.reasons.includes("target-wallet buying is inactive"));
});

test("final revalidation enforces the strict 15-second automatic-action freshness boundary", async () => {
  const store = new MemoryStore();
  const runtime = new ConvictionRuntime(
    {
      ...config,
      tradingMode: "live",
      dataFreshnessMs: 15 * 60_000,
      leaderboardActiveMs: 15 * 60_000,
    },
    store,
  );
  const observed = await runtime.observe(buy, { globalEntriesEnabled: true });
  assert.ok(observed.action);

  const decision = await runtime.revalidateLiveClaim(observed.action.claim, {
    nowMs: buy.timestampMs + 15_001,
    globalEntriesEnabled: true,
    currentPositionUsd: 0,
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.includes("claim source event is stale"));
  assert.equal(decision.reasons.includes("conviction data is stale"), false);
});

test("final revalidation fails closed for disabled mode, shadow mode, and Entries off", async () => {
  const store = new MemoryStore();
  const liveConfig = { ...config, tradingMode: "live" as const };
  const runtime = new ConvictionRuntime(liveConfig, store);
  const observed = await runtime.observe(buy, { globalEntriesEnabled: true });
  assert.ok(observed.action);

  const entriesOff = await runtime.revalidateLiveClaim(observed.action.claim, {
    nowMs: buy.timestampMs,
    globalEntriesEnabled: false,
    currentPositionUsd: 0,
  });
  assert.equal(entriesOff.allowed, false);
  assert.ok(entriesOff.reasons.includes("global Entries switch is off"));

  await runtime.reconfigure({ ...liveConfig, enabled: false });
  const disabled = await runtime.revalidateLiveClaim(observed.action.claim, {
    nowMs: buy.timestampMs,
    globalEntriesEnabled: true,
    currentPositionUsd: 0,
  });
  assert.equal(disabled.allowed, false);
  assert.ok(disabled.reasons.includes("Conviction Mode is disabled"));

  await runtime.reconfigure({ ...config, tradingMode: "shadow" });
  const shadow = await runtime.revalidateLiveClaim(observed.action.claim, {
    nowMs: buy.timestampMs,
    globalEntriesEnabled: true,
    currentPositionUsd: 0,
  });
  assert.equal(shadow.allowed, false);
  assert.ok(shadow.reasons.includes("Conviction Mode is not in live mode"));
});

test("final revalidation counts the claimed amount exactly once against current exposure", async () => {
  const store = new MemoryStore();
  const runtime = new ConvictionRuntime(
    { ...config, tradingMode: "live", maxPositionPerTokenUsd: 5 },
    store,
  );
  const observed = await runtime.observe(buy, { globalEntriesEnabled: true });
  assert.ok(observed.action);

  const atCap = await runtime.revalidateLiveClaim(observed.action.claim, {
    nowMs: buy.timestampMs,
    globalEntriesEnabled: true,
    currentPositionUsd: 0,
  });
  assert.equal(atCap.allowed, true);

  const overCap = await runtime.revalidateLiveClaim(observed.action.claim, {
    nowMs: buy.timestampMs,
    globalEntriesEnabled: true,
    currentPositionUsd: 1,
  });
  assert.equal(overCap.allowed, false);
  assert.ok(overCap.reasons.includes("max position per token would be exceeded"));
});

test("final revalidation applies current score, velocity, market, age, and convergence filters", async () => {
  const store = new MemoryStore();
  const liveConfig = { ...config, tradingMode: "live" as const };
  const runtime = new ConvictionRuntime(liveConfig, store);
  const observed = await runtime.observe(buy, { globalEntriesEnabled: true });
  assert.ok(observed.action);
  await runtime.reconfigure({
    ...liveConfig,
    minScore: 101,
    minCapitalVelocityUsdPerMinute: 1_000_000,
    minConvergedWallets: 2,
    marketCapMinUsd: 1,
    liquidityMinUsd: 1,
    tokenAgeMinMinutes: 1,
    tiers: [{ ...config.tiers[0]!, minScore: 101, minVelocityUsdPerMinute: 1_000_000 }],
  });

  const decision = await runtime.revalidateLiveClaim(observed.action.claim, {
    nowMs: buy.timestampMs,
    globalEntriesEnabled: true,
    currentPositionUsd: 0,
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.includes("claimed tier score threshold is no longer met"));
  assert.ok(decision.reasons.includes("claimed tier velocity threshold is no longer met"));
  assert.ok(decision.reasons.includes("wallet convergence is below threshold"));
  assert.ok(decision.reasons.includes("market cap is below configured minimum or unavailable"));
  assert.ok(decision.reasons.includes("liquidity is below configured minimum or unavailable"));
  assert.ok(decision.reasons.includes("token age is below configured minimum or unavailable"));
});

test("final revalidation rejects a claim whose durable lifecycle already advanced", async () => {
  const store = new MemoryStore();
  const runtime = new ConvictionRuntime({ ...config, tradingMode: "live" }, store);
  const observed = await runtime.observe(buy, { globalEntriesEnabled: true });
  assert.ok(observed.action);
  await runtime.transitionAction(observed.action.claim, { status: "submitted" });

  const decision = await runtime.revalidateLiveClaim(observed.action.claim, {
    nowMs: buy.timestampMs,
    globalEntriesEnabled: true,
    currentPositionUsd: 0,
  });
  assert.equal(decision.allowed, false);
  assert.ok(
    decision.reasons.includes("claim is no longer awaiting submission") ||
      decision.reasons.includes("durable claim is no longer awaiting submission"),
  );
});

test("submission authorization atomically advances an allowed claim exactly once", async () => {
  const store = new MemoryStore();
  const runtime = new ConvictionRuntime({ ...config, tradingMode: "live" }, store);
  const observed = await runtime.observe(buy, { globalEntriesEnabled: true });
  assert.ok(observed.action);

  const authorized = await runtime.authorizeLiveClaimForSubmission(observed.action.claim, {
    nowMs: buy.timestampMs,
    globalEntriesEnabled: true,
    currentPositionUsd: 0,
  });
  assert.equal(authorized.allowed, true);
  assert.equal(authorized.submittedClaim?.status, "submitted");
  assert.equal(store.tiers[0]?.status, "submitted");
  assert.equal(store.tierUpdates, 1);

  const repeated = await runtime.authorizeLiveClaimForSubmission(observed.action.claim, {
    nowMs: buy.timestampMs,
    globalEntriesEnabled: true,
    currentPositionUsd: 0,
  });
  assert.equal(repeated.allowed, true);
  assert.equal(repeated.submittedClaim?.status, "submitted");
  assert.equal(store.tierUpdates, 1);
  assert.equal(store.tiers[0]?.status, "submitted");
});

test("an idempotent submitted-route retry still rechecks current safety gates", async () => {
  const store = new MemoryStore();
  const runtime = new ConvictionRuntime({ ...config, tradingMode: "live" }, store);
  const observed = await runtime.observe(buy, { globalEntriesEnabled: true });
  assert.ok(observed.action);
  const first = await runtime.authorizeLiveClaimForSubmission(observed.action.claim, {
    nowMs: buy.timestampMs,
    globalEntriesEnabled: true,
    currentPositionUsd: 0,
  });
  assert.equal(first.allowed, true);

  const retryAfterEntriesOff = await runtime.authorizeLiveClaimForSubmission(
    first.submittedClaim!,
    {
      nowMs: buy.timestampMs,
      globalEntriesEnabled: false,
      currentPositionUsd: 0,
    },
  );
  assert.equal(retryAfterEntriesOff.allowed, false);
  assert.ok(retryAfterEntriesOff.reasons.includes("global Entries switch is off"));
  assert.equal(store.tierUpdates, 1);
  assert.equal(store.tiers[0]?.status, "submitted");
});

test("rejected submission authorization leaves the durable claim available for pre-submit failure", async () => {
  const store = new MemoryStore();
  const runtime = new ConvictionRuntime({ ...config, tradingMode: "live" }, store);
  const observed = await runtime.observe(buy, { globalEntriesEnabled: true });
  assert.ok(observed.action);

  const rejected = await runtime.authorizeLiveClaimForSubmission(observed.action.claim, {
    nowMs: buy.timestampMs,
    globalEntriesEnabled: false,
    currentPositionUsd: 0,
  });
  assert.equal(rejected.allowed, false);
  assert.ok(rejected.reasons.includes("global Entries switch is off"));
  assert.equal(rejected.submittedClaim, undefined);
  assert.equal(store.tiers[0]?.status, "claimed");
  assert.equal(store.tierUpdates, 0);

  await runtime.transitionAction(observed.action.claim, {
    status: "failed_pre_submit",
    errorCode: "final-gate-rejected",
  });
  assert.equal(store.tiers[0]?.status, "failed_pre_submit");
  assert.equal(runtime.snapshot("mint")?.executedTiers.length, 0);
});

test("submission authorization serializes behind a concurrent safety reconfiguration", async () => {
  const store = new MemoryStore();
  const liveConfig = { ...config, tradingMode: "live" as const };
  const runtime = new ConvictionRuntime(liveConfig, store);
  const observed = await runtime.observe(buy, { globalEntriesEnabled: true });
  assert.ok(observed.action);

  const disabling = runtime.reconfigure({ ...liveConfig, enabled: false });
  const authorizing = runtime.authorizeLiveClaimForSubmission(observed.action.claim, {
    nowMs: buy.timestampMs,
    globalEntriesEnabled: true,
    currentPositionUsd: 0,
  });
  const [, decision] = await Promise.all([disabling, authorizing]);

  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.includes("Conviction Mode is disabled"));
  assert.equal(store.tiers[0]?.status, "claimed");
  assert.equal(store.tierUpdates, 0);
});
