import assert from "node:assert/strict";
import test from "node:test";

import {
  ConvictionEngine,
  DEFAULT_CONVICTION_CONFIG,
  classifyConvictionEvent,
  evaluateConvictionEntry,
  replayConvictionEvents,
  type ConvictionEvent,
} from "./conviction-engine.js";

const START = Date.UTC(2026, 7, 12, 12, 0, 0);
const wallets = ["mm-1", "mm-2", "mm-3"];

function buy(
  id: string,
  timestampMs: number,
  wallet: string,
  amountUsd: number,
  tokenMint = "mint-a",
): ConvictionEvent {
  return {
    eventId: id,
    timestampMs,
    wallet,
    tokenMint,
    type: "DEX_BUY",
    amountUsd,
    amountTokens: amountUsd * 10,
    marketCapUsd: 50_000,
    liquidityUsd: 25_000,
    classificationReliable: true,
  };
}

const liveConfig = {
  enabled: true,
  tradingMode: "live" as const,
  rapidFollowEnabled: true,
  clusterWallets: wallets,
  minScore: 0,
  minNetCommitmentUsd: 100,
  minRecentNetInflowUsd: 1,
  minCapitalVelocityUsdPerMinute: 0,
  minCapitalAcceleration: -100,
  minConvergedWallets: 1,
  tiers: [
    {
      id: "tier_1",
      buyUsd: 25,
      minScore: 0,
      minNetCommitmentUsd: 100,
      minVelocityUsdPerMinute: 0,
      minCommitmentIncreaseRatio: 0,
    },
    {
      id: "tier_2",
      buyUsd: 25,
      minScore: 0,
      minNetCommitmentUsd: 200,
      minVelocityUsdPerMinute: 0,
      minCommitmentIncreaseRatio: 0.5,
    },
  ],
};

test("classifies internal cluster movement without manufacturing a buy", () => {
  assert.equal(
    classifyConvictionEvent({ fromWallet: "mm-1", toWallet: "mm-2", clusterWallets: wallets }),
    "INTERNAL_CLUSTER_TRANSFER",
  );
  assert.equal(
    classifyConvictionEvent({ side: "buy", verifiedSwap: false, clusterWallets: wallets }),
    "UNKNOWN",
  );
});

test("deduplicates feed replays and internal transfers do not change investment", () => {
  const engine = new ConvictionEngine(liveConfig);
  const event = buy("sig-1", START, "mm-1", 500);
  assert.equal(engine.process(event).duplicate, false);
  assert.equal(engine.process({ ...event }).duplicate, true);
  engine.process({
    eventId: "sig-transfer",
    timestampMs: START + 1_000,
    wallet: "mm-1",
    fromWallet: "mm-1",
    toWallet: "mm-2",
    tokenMint: "mint-a",
    type: "INTERNAL_CLUSTER_TRANSFER",
    amountUsd: 500,
  });
  const snapshot = engine.snapshot("mint-a")!;
  assert.equal(snapshot.grossClusterBuysUsd, 500);
  assert.equal(snapshot.netClusterInvestmentUsd, 500);
  assert.equal(snapshot.buyCount, 1);
});

test("unreliable swaps remain auditable but never create conviction capital", () => {
  const engine = new ConvictionEngine(liveConfig);
  const unreliable = engine.process({
    ...buy("ambiguous", START, "mm-1", 50_000),
    classificationReliable: false,
  });
  assert.equal(unreliable.countedTowardCapital, false);
  assert.equal(unreliable.snapshot.netClusterInvestmentUsd, 0);
  assert.equal(unreliable.snapshot.rolling["60"]?.grossBuysUsd, 0);
  assert.equal(unreliable.snapshot.classificationReliable, false);

  const verified = engine.process(buy("verified", START + 1_000, "mm-1", 500));
  assert.equal(verified.countedTowardCapital, true);
  assert.equal(verified.snapshot.netClusterInvestmentUsd, 500);
  assert.equal(verified.snapshot.classificationReliable, true);
});

test("a weaker duplicate cannot poison verified in-memory evidence", () => {
  const engine = new ConvictionEngine(liveConfig);
  const verified = buy("same-durable-event", START, "mm-1", 500);
  engine.process(verified);
  const weakReplay = engine.process({
    ...verified,
    type: "UNKNOWN",
    amountUsd: 0,
    classificationReliable: false,
  });
  assert.equal(weakReplay.duplicate, true);
  assert.equal(weakReplay.snapshot.classificationReliable, true);
  assert.equal(weakReplay.snapshot.netClusterInvestmentUsd, 500);
  assert.equal(weakReplay.snapshot.buyCount, 1);
});

test("events outside the configured cluster cannot affect rolling signal capital", () => {
  const engine = new ConvictionEngine(liveConfig);
  const outsider = engine.process(buy("outsider", START, "not-a-target", 50_000));
  assert.equal(outsider.countedTowardCapital, false);
  assert.equal(outsider.snapshot.netClusterInvestmentUsd, 0);
  assert.equal(outsider.snapshot.rolling["60"]?.grossBuysUsd, 0);
  assert.equal(engine.leaderboard(30, START).length, 0);
});

test("an older catch-up ambiguity cannot overwrite newer verified classification", () => {
  const engine = new ConvictionEngine(liveConfig);
  engine.process(buy("verified-newer", START + 1_000, "mm-1", 500));
  const catchUp = engine.process({
    ...buy("ambiguous-older", START, "mm-1", 5_000),
    type: "UNKNOWN",
    classificationReliable: false,
  });
  assert.equal(catchUp.snapshot.classificationReliable, true);
  assert.equal(catchUp.snapshot.netClusterInvestmentUsd, 500);
});

test("computes every rolling window and current-vs-prior acceleration", () => {
  const engine = new ConvictionEngine(liveConfig);
  engine.process(buy("old", START, "mm-1", 100));
  engine.process(buy("new-1", START + 61_000, "mm-1", 400));
  engine.process(buy("new-2", START + 80_000, "mm-2", 800));
  const snapshot = engine.snapshot("mint-a")!;
  assert.deepEqual(Object.keys(snapshot.rolling).map(Number), [30, 60, 180, 300, 900, 1800, 3600]);
  assert.equal(snapshot.rolling["60"]!.grossBuysUsd, 1_200);
  assert.equal(snapshot.rolling["60"]!.previousGrossBuysUsd, 100);
  assert.ok(snapshot.rolling["60"]!.capitalAcceleration > 0);
  assert.ok(snapshot.rolling["60"]!.buySizeAcceleration > 0);
});

test("a strong first-window buy sequence clears acceleration while one probe stays neutral", () => {
  const one = new ConvictionEngine({ ...liveConfig, minCapitalAcceleration: 1.25 });
  const probe = one.process(buy("probe", START, "mm-1", 10));
  assert.equal(probe.snapshot.rolling["1800"]?.accelerationSignal, 1);
  assert.match(probe.entry.failedGates.join(" "), /acceleration/);

  const sequence = new ConvictionEngine({
    ...liveConfig,
    minNetCommitmentUsd: 1,
    minCapitalAcceleration: 1.25,
  });
  sequence.process(buy("step-1", START, "mm-1", 10));
  sequence.process(buy("step-2", START + 1_000, "mm-2", 50));
  const strong = sequence.process(buy("step-3", START + 2_000, "mm-3", 250));
  assert.ok((strong.snapshot.rolling["1800"]?.latestBuyAcceleration ?? 0) > 1.25);
  assert.ok((strong.snapshot.rolling["1800"]?.accelerationSignal ?? 0) > 1.25);
  assert.doesNotMatch(strong.entry.failedGates.join(" "), /acceleration/);
});

test("5m, 30m, and 60m leaderboards use independent window scores and activity", () => {
  const engine = new ConvictionEngine(liveConfig);
  engine.process(buy("old-a", START, "mm-1", 5_000, "mint-a"));
  engine.process(buy("recent-b", START + 10 * 60_000, "mm-2", 500, "mint-b"));

  assert.equal(
    engine
      .leaderboard(5, START + 10 * 60_000)
      .map((row) => row.mint)
      .includes("mint-a"),
    false,
  );
  assert.equal(engine.leaderboard(30, START + 10 * 60_000)[0]?.mint, "mint-a");
  assert.equal(engine.leaderboard(60, START + 10 * 60_000)[0]?.mint, "mint-a");
  const token = engine.snapshot("mint-a")!;
  assert.notEqual(token.windowScores["5"]?.score, token.windowScores["30"]?.score);
  assert.equal(token.ranks["5"]?.direction, "out");
  assert.equal(token.ranks["30"]?.currentRank, 1);
});

test("wallet convergence, transparent score, states, and leaderboards are deterministic", () => {
  const events = [
    buy("a1", START, "mm-1", 500, "mint-a"),
    buy("b1", START + 1_000, "mm-1", 100, "mint-b"),
    buy("a2", START + 2_000, "mm-2", 800, "mint-a"),
    buy("a3", START + 3_000, "mm-3", 1_200, "mint-a"),
  ];
  const first = replayConvictionEvents(events, liveConfig).engine;
  const second = replayConvictionEvents([...events].reverse(), liveConfig).engine;
  assert.deepEqual(first.snapshots(), second.snapshots());
  const top = first.leaderboard(30, START + 3_000);
  assert.equal(top[0]?.mint, "mint-a");
  assert.equal(first.snapshot("mint-a")?.convergedWalletCount, 3);
  assert.equal(first.snapshot("mint-a")?.scoreComponents.length, 6);
  assert.ok((first.snapshot("mint-a")?.scoreReasons.length ?? 0) > 0);
});

test("sells reduce net commitment and meaningful multi-wallet selling distributes", () => {
  const engine = new ConvictionEngine({ ...liveConfig, distributionMinSellsUsd: 10 });
  engine.process(buy("buy", START, "mm-1", 1_000));
  engine.process({ ...buy("sell-1", START + 1_000, "mm-1", 300), type: "DEX_SELL" });
  const update = engine.process({ ...buy("sell-2", START + 2_000, "mm-2", 300), type: "DEX_SELL" });
  assert.equal(update.snapshot.netClusterInvestmentUsd, 400);
  assert.equal(update.snapshot.distributionDetected, true);
  assert.equal(update.snapshot.convictionState, "DISTRIBUTING");
  assert.equal(update.entry.authorizedToSubmit, false);
});

test("a stale large buy decays out of rolling velocity and the leaderboard", () => {
  const engine = new ConvictionEngine({ ...liveConfig, leaderboardActiveMs: 3_600_000 });
  engine.process(buy("large", START, "mm-1", 100_000));
  assert.equal(engine.leaderboard(60, START)[0]?.mint, "mint-a");
  assert.equal(engine.leaderboard(60, START + 3_600_001).length, 0);
  assert.equal(engine.snapshot("mint-a")?.rolling["3600"]?.netFlowUsd, 0);
});

test("Top 3 rank alone cannot bypass the absolute commitment gate", () => {
  const engine = new ConvictionEngine({ ...liveConfig, minNetCommitmentUsd: 10_000 });
  const update = engine.process(buy("small", START, "mm-1", 500));
  assert.equal(update.snapshot.ranks["30"]?.currentRank, 1);
  assert.equal(update.entry.eligible, false);
  assert.match(update.entry.failedGates.join(" "), /commitment/);
});

test("entry requires Top 3 and absolute gates; shadow can never submit", () => {
  const shadow = new ConvictionEngine({ ...liveConfig, tradingMode: "shadow" });
  const update = shadow.process(buy("sig", START, "mm-1", 1_000));
  assert.equal(update.entry.eligible, true);
  assert.equal(update.entry.hypothetical, true);
  assert.equal(update.entry.authorizedToSubmit, false);

  const snapshot = update.snapshot;
  const off = evaluateConvictionEntry(snapshot, { ...liveConfig, enabled: false }, { rank: 1 });
  assert.equal(off.authorizedToSubmit, false);
  assert.match(off.failedGates.join(" "), /disabled/);
  const notTop = evaluateConvictionEntry(snapshot, liveConfig, { rank: 4 });
  assert.equal(notTop.eligible, false);
});

test("Entries controls live authorization without hiding shadow eligibility", () => {
  const shadow = new ConvictionEngine({ ...liveConfig, tradingMode: "shadow" });
  const shadowSnapshot = shadow.process(buy("shadow-off", START, "mm-1", 1_000)).snapshot;
  const paperDecision = evaluateConvictionEntry(
    shadowSnapshot,
    { ...liveConfig, tradingMode: "shadow" },
    { rank: 1, globalEntriesEnabled: false },
  );
  assert.equal(paperDecision.eligible, true);
  assert.equal(paperDecision.hypothetical, true);
  assert.equal(paperDecision.authorizedToSubmit, false);

  const liveDecision = evaluateConvictionEntry(shadowSnapshot, liveConfig, {
    rank: 1,
    globalEntriesEnabled: false,
  });
  assert.equal(liveDecision.eligible, true);
  assert.equal(liveDecision.authorizedToSubmit, false);
});

test("tiers execute once, require progression, and respect the hard exposure cap", () => {
  const engine = new ConvictionEngine({ ...liveConfig, maxPositionPerTokenUsd: 40 });
  let update = engine.process(buy("first", START, "mm-1", 500));
  assert.equal(update.nextTier.tier?.id, "tier_1");
  assert.equal(update.nextTier.amountUsd, 25);
  const execution = engine.recordTierExecution("mint-a", "tier_1", { reference: "shadow-1" });
  assert.equal(execution.amountUsd, 25);
  assert.equal(engine.recordTierExecution("mint-a", "tier_1").reference, "shadow-1");
  update = engine.process(buy("second", START + 1_000, "mm-2", 500));
  assert.equal(update.nextTier.tier?.id, "tier_2");
  assert.equal(update.nextTier.amountUsd, 15);
  engine.recordTierExecution("mint-a", "tier_2", { amountUsd: 15 });
  assert.equal(engine.snapshot("mint-a")?.ourCurrentPositionUsd, 40);
  assert.equal(engine.process(buy("third", START + 2_000, "mm-3", 500)).nextTier.eligible, false);
});

test("Rapid Follow off permits Tier 1 only", () => {
  const engine = new ConvictionEngine({
    ...liveConfig,
    rapidFollowEnabled: false,
    maxPositionPerTokenUsd: 100,
  });
  engine.process(buy("first", START, "mm-1", 1_000));
  engine.recordTierExecution("mint-a", "tier_1");
  const update = engine.process(buy("second", START + 1_000, "mm-2", 1_000));
  assert.equal(update.nextTier.tier?.id, "tier_2");
  assert.equal(update.nextTier.eligible, false);
  assert.equal(update.nextTier.reason, "Rapid Follow is disabled");
  assert.equal(engine.snapshot("mint-a")?.rapidFollowStatus, "inactive");
});

test("Rapid Follow becomes active after Tier 1 and stops adding on distribution", () => {
  const engine = new ConvictionEngine({
    ...liveConfig,
    distributionMinSellsUsd: 10,
    distributionWalletCount: 1,
    maxPositionPerTokenUsd: 100,
  });
  engine.process(buy("buy", START, "mm-1", 1_000));
  engine.recordTierExecution("mint-a", "tier_1");
  assert.equal(engine.snapshot("mint-a")?.rapidFollowStatus, "active");
  engine.process({
    ...buy("sell", START + 1_000, "mm-1", 300),
    type: "DEX_SELL",
  });
  assert.equal(engine.snapshot("mint-a")?.rapidFollowStatus, "stopped");
});

test("a definitely failed pre-submit tier can be released without losing signal state", () => {
  const engine = new ConvictionEngine(liveConfig);
  engine.process(buy("signal", START, "mm-1", 500));
  engine.recordTierExecution("mint-a", "tier_1", { amountUsd: 25 });
  assert.equal(engine.releaseTierExecution("mint-a", "tier_1"), true);
  assert.equal(engine.snapshot("mint-a")?.ourCurrentPositionUsd, 0);
  assert.equal(engine.snapshot("mint-a")?.executedTiers.length, 0);
  assert.equal(engine.snapshot("mint-a")?.netClusterInvestmentUsd, 500);
});

test("snapshot hydration is restart-safe for event and tier dedupe", () => {
  const original = new ConvictionEngine(liveConfig);
  const event = buy("sig", START, "mm-1", 500);
  original.process(event);
  original.recordTierExecution("mint-a", "tier_1", { mode: "shadow", reference: "paper" });
  const restarted = new ConvictionEngine(liveConfig, original.snapshots());
  assert.equal(restarted.process(event).duplicate, true);
  assert.equal(restarted.snapshot("mint-a")?.executedTiers.length, 1);
  assert.equal(restarted.snapshot("mint-a")?.netClusterInvestmentUsd, 500);
});

test("defaults are installation-safe", () => {
  assert.equal(DEFAULT_CONVICTION_CONFIG.enabled, false);
  assert.equal(DEFAULT_CONVICTION_CONFIG.tradingMode, "shadow");
  const engine = new ConvictionEngine();
  const update = engine.process(buy("safe", START, "mm-1", 100_000));
  assert.equal(update.entry.authorizedToSubmit, false);
});

test("an enabled engine fails closed until all required cluster wallets are configured", () => {
  const engine = new ConvictionEngine({
    ...liveConfig,
    clusterWallets: [],
    requiredClusterWalletCount: 3,
  });
  const update = engine.process(buy("unsafe-missing-cluster", START, "mm-1", 100_000));
  assert.equal(update.entry.eligible, false);
  assert.match(update.entry.failedGates.join(" "), /0\/3 cluster wallets configured/);
});
