import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeRevivalConfig,
  replayRevivalEvents,
  revivalEventFingerprint,
} from "./revival-engine.js";
import {
  DEFAULT_REVIVAL_TRACKER_CONFIG,
  REVIVAL_ENGINE_VERSION,
  type RevivalEvent,
  type RevivalEventType,
  type RevivalMarketSnapshot,
  type RevivalTrackerConfig,
} from "./revival-types.js";

const START = 1_800_000_000_000;
const MINT = "revival-test-mint";

function market(marketCapUsd: number, overrides: Partial<RevivalMarketSnapshot> = {}) {
  return {
    provider: "dexscreener" as const,
    observedAtMs: START,
    marketCapUsd,
    priceUsd: 0.001,
    volumeH1Usd: 100,
    buysH1: 2,
    activeBoosts: 0,
    reliable: true,
    ...overrides,
  } satisfies RevivalMarketSnapshot;
}

function event(
  eventType: RevivalEventType,
  eventKey: string,
  offsetMs: number,
  overrides: Partial<RevivalEvent> = {},
): RevivalEvent {
  return {
    eventKey,
    eventType,
    tokenMint: MINT,
    eventAtMs: START + offsetMs,
    availableAtMs: START + offsetMs,
    source:
      eventType === "MARKET_SNAPSHOT" ? "market" : eventType === "CLOCK_TICK" ? "clock" : "rpc",
    verified: false,
    historical: false,
    ...overrides,
  };
}

function seed(
  marketCapUsd: number | undefined,
  overrides: Partial<RevivalEvent> = {},
): RevivalEvent {
  return event("TARGET_BUY", "seed", 0, {
    verified: true,
    targetWallet: "target-a",
    amountUsd: 400,
    ...(marketCapUsd === undefined ? {} : { market: market(marketCapUsd) }),
    ...overrides,
  });
}

test("seed market-cap admission is inclusive at $2,000 and $15,000", () => {
  const cases = [
    { marketCapUsd: 1_999.99, state: "INVALIDATED", reason: "market_cap_below_min" },
    { marketCapUsd: 2_000, state: "SEEDED", reason: "seed_market_cap_in_range" },
    { marketCapUsd: 15_000, state: "SEEDED", reason: "seed_market_cap_in_range" },
    { marketCapUsd: 15_000.01, state: "INVALIDATED", reason: "market_cap_above_max" },
  ] as const;

  for (const expected of cases) {
    const result = replayRevivalEvents([
      seed(expected.marketCapUsd, { eventKey: `seed:${expected.marketCapUsd}` }),
    ]);
    assert.equal(result.campaigns.length, 1);
    assert.equal(result.campaigns[0]?.state, expected.state, String(expected.marketCapUsd));
    assert.equal(result.campaigns[0]?.eligibilityReason, expected.reason);
  }
});

test("a first verified buy starts observation but never emits a shadow trade action", () => {
  const result = replayRevivalEvents([seed(8_000)]);

  assert.equal(result.campaigns[0]?.state, "SEEDED");
  assert.equal(result.campaigns[0]?.targetBuyCount, 1);
  assert.equal(result.campaigns[0]?.targetGrossBuysUsd, 400);
  assert.deepEqual(result.actions, []);
});

test("missing seed market cap creates a coverage gap and a reliable snapshot resolves it", () => {
  const result = replayRevivalEvents([
    seed(undefined),
    event("MARKET_SNAPSHOT", "market:resolved", 10_000, {
      market: market(7_500, { observedAtMs: START + 10_000 }),
    }),
  ]);

  const campaign = result.campaigns[0];
  assert.equal(campaign?.state, "SEEDED");
  assert.equal(campaign?.eligibilityStatus, "eligible");
  assert.equal(campaign?.eligibilityReason, "seed_market_cap_resolved_in_range");
  assert.equal(campaign?.seedMarketCapUsd, 7_500);
  assert.equal(campaign?.coverageStatus, "COMPLETE");
  assert.deepEqual(
    result.transitions.map((transition) => transition.toState),
    ["COVERAGE_GAP", "SEEDED"],
  );
  assert.deepEqual(result.actions, []);
});

test("an admitted campaign keeps tracking after market cap rises above $15,000", () => {
  const result = replayRevivalEvents([
    seed(10_000),
    event("MARKET_SNAPSHOT", "market:above-band", 30_000, {
      market: market(25_000, {
        observedAtMs: START + 30_000,
        priceUsd: 0.001,
        volumeH1Usd: 100,
        buysH1: 2,
      }),
    }),
  ]);

  const campaign = result.campaigns[0];
  assert.equal(campaign?.state, "SEEDED");
  assert.equal(campaign?.eligibilityStatus, "eligible");
  assert.equal(campaign?.latestMarketCapUsd, 25_000);
  assert.equal(campaign?.closedAtMs, undefined);
});

test("only verified buys accumulate and only a verified sell triggers distribution", () => {
  const events = [
    seed(8_000),
    event("TARGET_BUY", "buy:verified", 10_000, {
      targetWallet: "target-b",
      amountUsd: 600,
      verified: true,
    }),
    event("TARGET_BUY", "buy:unverified", 20_000, {
      targetWallet: "unverified-wallet",
      amountUsd: 5_000,
      verified: false,
    }),
    event("TARGET_SELL", "sell:unverified", 30_000, {
      targetWallet: "target-a",
      amountUsd: 900,
      verified: false,
    }),
  ];
  const beforeVerifiedSell = replayRevivalEvents(events);
  const entryReady = beforeVerifiedSell.campaigns[0];

  assert.equal(entryReady?.state, "ENTRY_READY");
  assert.equal(entryReady?.targetBuyCount, 2);
  assert.equal(entryReady?.targetGrossBuysUsd, 1_000);
  assert.equal(entryReady?.targetSellCount, 0);
  assert.equal(entryReady?.targetGrossSellsUsd, 0);
  assert.equal(entryReady?.targetAttributionReliable, false);
  assert.equal(entryReady?.coverageStatus, "PARTIAL");
  assert.deepEqual(entryReady?.targetWallets, ["target-a", "target-b"]);
  assert.deepEqual(
    beforeVerifiedSell.actions.map((action) => action.actionType),
    ["STARTER_ELIGIBLE"],
  );
  assert.ok(beforeVerifiedSell.actions.every((action) => action.executable === false));

  const afterVerifiedSell = replayRevivalEvents([
    ...events,
    event("TARGET_SELL", "sell:verified", 40_000, {
      targetWallet: "target-a",
      amountUsd: 250,
      verified: true,
    }),
  ]);
  const distribution = afterVerifiedSell.campaigns[0];
  assert.equal(distribution?.state, "DISTRIBUTION_RISK");
  assert.equal(distribution?.targetSellCount, 1);
  assert.equal(distribution?.targetGrossSellsUsd, 250);
  assert.equal(distribution?.targetNetCommitmentUsd, 750);
  assert.equal(afterVerifiedSell.actions.at(-1)?.actionType, "EXIT");
  assert.equal(afterVerifiedSell.actions.at(-1)?.executable, false);
});

test("campaign rules are frozen from the seed event and ignore later config changes", () => {
  const seedConfig: RevivalTrackerConfig = {
    ...DEFAULT_REVIVAL_TRACKER_CONFIG,
    enabled: true,
    marketCapMinUsd: 3_000,
    marketCapMaxUsd: 10_000,
    minTargetBuys: 4,
    minNetCommitmentUsd: 3_000,
  };
  const relaxedLaterConfig: RevivalTrackerConfig = {
    ...DEFAULT_REVIVAL_TRACKER_CONFIG,
    enabled: true,
    marketCapMinUsd: 0,
    marketCapMaxUsd: 1_000_000,
    minTargetBuys: 2,
    minNetCommitmentUsd: 1,
  };
  const result = replayRevivalEvents([
    seed(5_000, { seedConfig, amountUsd: 1_000 }),
    event("TARGET_BUY", "buy:later-1", 10_000, {
      verified: true,
      targetWallet: "target-b",
      amountUsd: 1_000,
      seedConfig: relaxedLaterConfig,
    }),
    event("TARGET_BUY", "buy:later-2", 20_000, {
      verified: true,
      targetWallet: "target-c",
      amountUsd: 1_000,
      seedConfig: relaxedLaterConfig,
    }),
  ]);

  const campaign = result.campaigns[0];
  assert.deepEqual(campaign?.config, normalizeRevivalConfig(seedConfig));
  assert.notEqual(campaign?.config, seedConfig);
  assert.equal(campaign?.targetBuyCount, 3);
  assert.equal(campaign?.targetNetCommitmentUsd, 3_000);
  assert.equal(campaign?.state, "SEEDED");
  assert.deepEqual(result.actions, []);
});

test("ignition requires entry-ready state plus consecutive reliable snapshots", () => {
  const readyEvents = [
    seed(10_000),
    event("TARGET_BUY", "buy:ready", 10_000, {
      verified: true,
      targetWallet: "target-b",
      amountUsd: 600,
    }),
  ];
  const unreliable = event("MARKET_SNAPSHOT", "market:unreliable", 20_000, {
    verified: false,
    market: market(25_000, {
      observedAtMs: START + 20_000,
      priceUsd: 0.002,
      volumeH1Usd: 1_000,
      buysH1: 20,
      reliable: false,
    }),
  });
  const firstReliable = event("MARKET_SNAPSHOT", "market:reliable-1", 30_000, {
    verified: true,
    market: market(25_000, {
      observedAtMs: START + 30_000,
      priceUsd: 0.002,
      volumeH1Usd: 1_000,
      buysH1: 20,
    }),
  });
  const secondReliable = event("MARKET_SNAPSHOT", "market:reliable-2", 40_000, {
    verified: true,
    market: market(26_000, {
      observedAtMs: START + 40_000,
      priceUsd: 0.0021,
      volumeH1Usd: 1_100,
      buysH1: 22,
    }),
  });

  const beforeConfirmation = replayRevivalEvents([...readyEvents, unreliable, firstReliable]);
  assert.equal(beforeConfirmation.campaigns[0]?.state, "ENTRY_READY");
  assert.equal(beforeConfirmation.campaigns[0]?.ignitionStreak, 1);

  const confirmed = replayRevivalEvents([
    ...readyEvents,
    unreliable,
    firstReliable,
    secondReliable,
  ]);
  assert.equal(confirmed.campaigns[0]?.state, "RETAIL_IGNITION");
  assert.deepEqual(
    confirmed.actions.map((row) => row.actionType),
    ["STARTER_ELIGIBLE", "STOP_ADDING", "TAKE_PROFIT"],
  );
  assert.equal(confirmed.campaigns[0]?.latestMarketCapUsd, 26_000);
});

test("later buys add evidence without regressing an ignited campaign or repeating starter", () => {
  const result = replayRevivalEvents([
    seed(10_000),
    event("TARGET_BUY", "buy:ready", 10_000, {
      verified: true,
      targetWallet: "target-b",
      amountUsd: 600,
    }),
    event("MARKET_SNAPSHOT", "market:ignite-1", 20_000, {
      verified: true,
      market: market(20_000, {
        observedAtMs: START + 20_000,
        priceUsd: 0.002,
        volumeH1Usd: 1_000,
        buysH1: 20,
      }),
    }),
    event("MARKET_SNAPSHOT", "market:ignite-2", 30_000, {
      verified: true,
      market: market(21_000, {
        observedAtMs: START + 30_000,
        priceUsd: 0.0021,
        volumeH1Usd: 1_100,
        buysH1: 22,
      }),
    }),
    event("TARGET_BUY", "buy:after-ignition", 40_000, {
      verified: true,
      targetWallet: "target-c",
      amountUsd: 200,
    }),
  ]);

  assert.equal(result.campaigns[0]?.state, "RETAIL_IGNITION");
  assert.equal(result.campaigns[0]?.targetBuyCount, 3);
  assert.equal(result.actions.filter((row) => row.actionType === "STARTER_ELIGIBLE").length, 1);
});

test("catch-up delivery uses chain time and cannot fabricate a fresh paper action", () => {
  const result = replayRevivalEvents([
    seed(8_000, {
      availableAtMs: START + 10 * 60 * 60_000,
      historical: true,
    }),
    event("TARGET_BUY", "buy:hours-later", 2 * 60 * 60_000, {
      availableAtMs: START + 10 * 60 * 60_000 + 1_000,
      historical: true,
      verified: true,
      targetWallet: "target-b",
      amountUsd: 600,
    }),
  ]);

  assert.equal(result.campaigns[0]?.state, "SEEDED");
  assert.equal(result.campaigns[0]?.targetBuyCount, 2);
  assert.deepEqual(result.actions, []);
});

test("a current quote cannot retroactively become seed market cap for an old recovered buy", () => {
  const result = replayRevivalEvents([
    seed(undefined, {
      availableAtMs: START + 6 * 60 * 60_000,
      historical: true,
    }),
    event("MARKET_SNAPSHOT", "market:too-late-for-seed", 6 * 60 * 60_000, {
      availableAtMs: START + 6 * 60 * 60_000 + 1_000,
      verified: true,
      market: market(8_000, { observedAtMs: START + 6 * 60 * 60_000 }),
    }),
  ]);

  assert.equal(result.campaigns[0]?.state, "COVERAGE_GAP");
  assert.equal(result.campaigns[0]?.eligibilityStatus, "pending_market_data");
  assert.equal(result.campaigns[0]?.eligibilityReason, "seed_market_cap_not_causal");
  assert.equal(result.campaigns[0]?.seedMarketCapUsd, undefined);
  assert.deepEqual(result.actions, []);
});

test("verified buys during a temporary seed-market gap are retained and become eligible once resolved", () => {
  const result = replayRevivalEvents([
    seed(undefined),
    event("TARGET_BUY", "buy:during-gap", 5_000, {
      verified: true,
      targetWallet: "target-b",
      amountUsd: 600,
    }),
    event("MARKET_SNAPSHOT", "market:gap-resolved", 10_000, {
      verified: true,
      market: market(8_000, { observedAtMs: START + 10_000 }),
    }),
  ]);

  assert.equal(result.campaigns[0]?.targetBuyCount, 2);
  assert.equal(result.campaigns[0]?.targetNetCommitmentUsd, 1_000);
  assert.equal(result.campaigns[0]?.state, "ENTRY_READY");
  assert.deepEqual(
    result.actions.map((row) => row.actionType),
    ["STARTER_ELIGIBLE"],
  );
});

test("a verified sell during a market gap is processed before eligibility and blocks starter", () => {
  const result = replayRevivalEvents([
    seed(undefined),
    event("TARGET_BUY", "buy:during-gap", 4_000, {
      verified: true,
      targetWallet: "target-b",
      amountUsd: 700,
    }),
    event("TARGET_SELL", "sell:during-gap", 6_000, {
      verified: true,
      targetWallet: "target-a",
      amountUsd: 50,
    }),
    event("MARKET_SNAPSHOT", "market:resolved-after-sell", 10_000, {
      verified: true,
      market: market(8_000, { observedAtMs: START + 10_000 }),
    }),
  ]);

  const campaign = result.campaigns[0];
  assert.equal(campaign?.eligibilityStatus, "eligible");
  assert.equal(campaign?.state, "DISTRIBUTION_RISK");
  assert.equal(campaign?.targetBuyCount, 2);
  assert.equal(campaign?.targetSellCount, 1);
  assert.equal(campaign?.targetNetCommitmentUsd, 1_050);
  assert.equal(campaign?.entryReadyAtMs, undefined);
  assert.deepEqual(result.actions, [], "no starter or downstream exit exists without exposure");
  assert.deepEqual(
    result.transitions.map((transition) => transition.toState),
    ["COVERAGE_GAP", "SEEDED", "DISTRIBUTION_RISK"],
  );
});

test("ignition and distribution record state but emit no downstream action without a starter", () => {
  const result = replayRevivalEvents([
    seed(10_000),
    event("TARGET_BUY", "buy:historical-ready", 10_000, {
      availableAtMs: START + 40_000,
      historical: true,
      verified: true,
      targetWallet: "target-b",
      amountUsd: 600,
    }),
    event("MARKET_SNAPSHOT", "market:no-exposure-ignite-1", 50_000, {
      verified: true,
      market: market(20_000, {
        observedAtMs: START + 50_000,
        priceUsd: 0.002,
        volumeH1Usd: 1_000,
        buysH1: 20,
      }),
    }),
    event("MARKET_SNAPSHOT", "market:no-exposure-ignite-2", 60_000, {
      verified: true,
      market: market(21_000, {
        observedAtMs: START + 60_000,
        priceUsd: 0.0021,
        volumeH1Usd: 1_100,
        buysH1: 22,
      }),
    }),
    event("TARGET_SELL", "sell:no-exposure", 70_000, {
      verified: true,
      targetWallet: "target-a",
      amountUsd: 100,
    }),
  ]);

  assert.equal(result.campaigns[0]?.state, "DISTRIBUTION_RISK");
  assert.equal(result.campaigns[0]?.ignitedAtMs, START + 60_000);
  assert.deepEqual(result.actions, []);
  assert.ok(result.transitions.some((transition) => transition.toState === "RETAIL_IGNITION"));
});

test("a missed provider interval keeps path coverage partial after the provider recovers", () => {
  const degraded = replayRevivalEvents([
    seed(8_000),
    event("MARKET_SNAPSHOT", "market:provider-down", 5_000, {
      verified: false,
      market: {
        provider: "dexscreener",
        observedAtMs: START + 5_000,
        reliable: false,
        reason: "provider_unavailable",
      },
    }),
  ]);
  assert.equal(degraded.campaigns[0]?.marketDataReliable, false);
  assert.equal(degraded.campaigns[0]?.coverageStatus, "PARTIAL");

  const recovered = replayRevivalEvents([
    ...[
      seed(8_000),
      event("MARKET_SNAPSHOT", "market:provider-down", 5_000, {
        verified: false,
        market: {
          provider: "dexscreener",
          observedAtMs: START + 5_000,
          reliable: false,
        },
      }),
    ],
    event("MARKET_SNAPSHOT", "market:provider-back", 6_000, {
      verified: true,
      market: market(8_100, { observedAtMs: START + 6_000 }),
    }),
  ]);
  assert.equal(recovered.campaigns[0]?.marketDataReliable, true);
  assert.equal(recovered.campaigns[0]?.coverageStatus, "PARTIAL");
});

test("a silent market-sampling gap permanently weakens path coverage", () => {
  const result = replayRevivalEvents([
    seed(8_000),
    event("MARKET_SNAPSHOT", "market:after-six-hour-gap", 6 * 60 * 60_000, {
      verified: true,
      metadata: { sampleIntervalMs: 30_000 },
      market: market(12_000, { observedAtMs: START + 6 * 60 * 60_000 }),
    }),
  ]);

  assert.equal(result.campaigns[0]?.marketDataReliable, true);
  assert.equal(result.campaigns[0]?.coverageStatus, "PARTIAL");
});

test("a post-outage TTL close is marked partial before the outcome becomes terminal", () => {
  const clockClose = replayRevivalEvents([
    seed(8_000),
    event("CLOCK_TICK", "clock:after-ttl-outage", 24 * 60 * 60_000 + 1, {
      metadata: { sampleIntervalMs: 30_000 },
    }),
  ]);
  assert.equal(clockClose.campaigns[0]?.state, "CLOSED");
  assert.equal(clockClose.campaigns[0]?.coverageStatus, "PARTIAL");

  const buyRollover = replayRevivalEvents([
    seed(8_000),
    event("TARGET_BUY", "buy:after-ttl-outage", 24 * 60 * 60_000 + 1, {
      verified: true,
      targetWallet: "target-b",
      amountUsd: 400,
      market: market(8_500, { observedAtMs: START + 24 * 60 * 60_000 + 1 }),
    }),
  ]);
  assert.equal(buyRollover.campaigns.length, 2);
  assert.equal(buyRollover.campaigns[0]?.state, "CLOSED");
  assert.equal(buyRollover.campaigns[0]?.coverageStatus, "PARTIAL");
});

test("an older-slot target fact sharing the seed block time cannot contaminate its campaign", () => {
  const result = replayRevivalEvents([
    seed(8_000, {
      eventKey: "seed:fresh",
      slot: 200,
      txIndex: 2,
      availableAtMs: START + 1_000,
    }),
    event("TARGET_BUY", "buy:older-slot", 0, {
      slot: 199,
      availableAtMs: START + 2_000,
      verified: true,
      targetWallet: "target-old",
      amountUsd: 600,
    }),
    event("TARGET_SELL", "sell:older-slot", 0, {
      slot: 198,
      availableAtMs: START + 2_500,
      verified: true,
      targetWallet: "target-old",
      amountUsd: 500,
    }),
    event("TARGET_BUY", "buy:fresh-second", 1_000, {
      slot: 201,
      availableAtMs: START + 3_000,
      verified: true,
      targetWallet: "target-b",
      amountUsd: 1,
    }),
  ]);

  const campaign = result.campaigns[0];
  assert.equal(campaign?.targetBuyCount, 2);
  assert.equal(campaign?.targetSellCount, 0);
  assert.equal(campaign?.targetGrossBuysUsd, 401);
  assert.equal(campaign?.state, "ACCUMULATING");
  assert.deepEqual(result.actions, []);
});

test("same-slot target evidence without transaction indexes fails closed", () => {
  const result = replayRevivalEvents([
    seed(8_000, { slot: 200 }),
    event("TARGET_BUY", "buy:same-slot-unknown-order", 0, {
      slot: 200,
      availableAtMs: START + 1_000,
      verified: true,
      targetWallet: "target-b",
      amountUsd: 600,
    }),
  ]);

  const campaign = result.campaigns[0];
  assert.equal(campaign?.targetBuyCount, 1);
  assert.equal(campaign?.targetAttributionReliable, false);
  assert.equal(campaign?.coverageStatus, "PARTIAL");
  assert.equal(campaign?.state, "SEEDED");
  assert.deepEqual(result.actions, []);
});

test("unverified target evidence before entry blocks a new starter and weakens coverage", () => {
  const result = replayRevivalEvents([
    seed(8_000),
    event("TARGET_SELL", "sell:unverified-before-entry", 5_000, {
      verified: false,
      targetWallet: "target-a",
      amountUsd: 50,
    }),
    event("TARGET_BUY", "buy:otherwise-ready", 10_000, {
      verified: true,
      targetWallet: "target-b",
      amountUsd: 600,
    }),
  ]);

  const campaign = result.campaigns[0];
  assert.equal(campaign?.targetAttributionReliable, false);
  assert.equal(campaign?.coverageStatus, "PARTIAL");
  assert.equal(campaign?.state, "SEEDED");
  assert.deepEqual(result.actions, []);
});

test("market resolution cannot erase partial target attribution from the seed gap", () => {
  const result = replayRevivalEvents([
    seed(undefined),
    event("TARGET_SELL", "sell:unverified-during-gap", 5_000, {
      verified: false,
      targetWallet: "target-a",
      amountUsd: 50,
    }),
    event("MARKET_SNAPSHOT", "market:resolved-with-partial-target-evidence", 10_000, {
      verified: true,
      market: market(8_000, { observedAtMs: START + 10_000 }),
    }),
  ]);

  assert.equal(result.campaigns[0]?.eligibilityStatus, "eligible");
  assert.equal(result.campaigns[0]?.targetAttributionReliable, false);
  assert.equal(result.campaigns[0]?.coverageStatus, "PARTIAL");
  assert.deepEqual(result.actions, []);
});

test("missing verified target valuation is partial until durable enrichment rebuilds it", () => {
  const incomplete = replayRevivalEvents([seed(8_000, { amountUsd: undefined })]);
  assert.equal(incomplete.campaigns[0]?.targetAttributionReliable, false);
  assert.equal(incomplete.campaigns[0]?.coverageStatus, "PARTIAL");

  const enriched = replayRevivalEvents([seed(8_000, { amountUsd: 400 })]);
  assert.equal(enriched.campaigns[0]?.targetAttributionReliable, true);
  assert.equal(enriched.campaigns[0]?.coverageStatus, "COMPLETE");
});

test("campaign-derived durable keys are isolated by engine and configuration version", () => {
  const first = replayRevivalEvents([
    seed(8_000, {
      seedConfig: {
        ...DEFAULT_REVIVAL_TRACKER_CONFIG,
        enabled: true,
        minNetCommitmentUsd: 1_000,
      },
    }),
  ]);
  const second = replayRevivalEvents([
    seed(8_000, {
      seedConfig: {
        ...DEFAULT_REVIVAL_TRACKER_CONFIG,
        enabled: true,
        minNetCommitmentUsd: 2_000,
      },
    }),
  ]);

  assert.match(first.campaigns[0]!.campaignKey, new RegExp(`^${REVIVAL_ENGINE_VERSION}:`));
  assert.notEqual(first.campaigns[0]?.campaignKey, second.campaigns[0]?.campaignKey);
  assert.notEqual(first.transitions[0]?.transitionKey, second.transitions[0]?.transitionKey);
});

test("canonical target fingerprint ignores a retry-time USD quote", () => {
  const base = seed(8_000, { amountUsd: undefined });
  assert.equal(
    revivalEventFingerprint(base),
    revivalEventFingerprint({ ...base, amountUsd: 412.34 }),
  );
});
