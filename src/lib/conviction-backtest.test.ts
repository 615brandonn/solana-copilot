import assert from "node:assert/strict";
import test from "node:test";

import { convictionConfigFromBotConfig } from "../../worker/src/conviction-config.js";
import {
  convictionBacktestEngineConfig,
  historicalMarketDataIsCausal,
  historicalValuationIsCausal,
  MAX_HISTORICAL_PRICE_LAG_MS,
  runConvictionHistoricalBacktest,
} from "./conviction-backtest.js";
import {
  DEFAULT_CONVICTION_BACKTEST_SETTINGS,
  type ConvictionBacktestSettings,
} from "./conviction-lab.js";

const START = Date.UTC(2026, 7, 1, 12, 0, 0);
const wallets = ["mm-1", "mm-2", "mm-3"];

function observation(id: string, seconds: number, wallet: string, mint: string, amountUsd: number) {
  return {
    eventKey: id,
    eventAt: new Date(START + seconds * 1_000).toISOString(),
    detectedAt: new Date(START + seconds * 1_000 + 1_000).toISOString(),
    side: "buy" as const,
    actorWallet: wallet,
    tokenMint: mint,
    amountUsd,
    amountTokens: amountUsd * 10,
    marketCapUsd: 50_000,
    liquidityUsd: 25_000,
    tokenCreatedAtMs: START - 3_600_000,
    valuationSource: "stablecoin",
    valuationProceedsMint: null,
    valuationObservedAtMs: START + seconds * 1_000 + 1_000,
    marketDataObservedAtMs: START + seconds * 1_000 + 1_000,
    classificationReliable: true,
  };
}

function sourceStats(rows: unknown[]) {
  return {
    requestedSince: new Date(START - 1_000).toISOString(),
    observationsLoaded: rows.length,
    observationsWithUsd: rows.length,
    observationsProductionEquivalent: rows.length,
    observationsExcludedUnverified: 0,
    observationsExcludedUnvalued: 0,
    observationsExcludedDelayedValuation: 0,
    observationsWithMarketCap: rows.length,
    observationsWithLiquidity: rows.length,
    marketCapSnapshotsExcludedForTiming: 0,
    liquiditySnapshotsExcludedForTiming: 0,
    capped: false,
    cap: 25_000,
  };
}

const permissive: ConvictionBacktestSettings = {
  ...DEFAULT_CONVICTION_BACKTEST_SETTINGS,
  rapidFollowEnabled: true,
  scoreThreshold: 0,
  minNetCommitmentUsd: 100,
  minCapitalVelocityUsdPerMinute: 0,
  minCapitalAccelerationRatio: 0,
  minConvergedWallets: 1,
  tier1MinCommitmentUsd: 100,
  tier2MinCommitmentUsd: 200,
  tier3MinCommitmentUsd: 300,
  tier4MinCommitmentUsd: 400,
  dataFreshnessSeconds: 3_600,
};

test("local backtest settings map to the same worker engine thresholds and score normalization", () => {
  const settings: ConvictionBacktestSettings = {
    ...permissive,
    leaderboardWindowMinutes: 60,
    scoreThreshold: 63,
    topN: 4,
    minNetCommitmentUsd: 1_234,
    minRecentNetInflowUsd: 12.5,
    minCapitalVelocityUsdPerMinute: 321,
    minCapitalAccelerationRatio: 1.6,
    minConvergedWallets: 2,
    minIndividualBuyUsd: 42,
    marketCapFilterEnabled: true,
    marketCapMinUsd: 10_000,
    marketCapMaxUsd: 900_000,
    liquidityFilterEnabled: true,
    liquidityMinUsd: 5_000,
    liquidityMaxUsd: 500_000,
    tokenAgeFilterEnabled: true,
    tokenAgeMinMinutes: 10,
    tokenAgeMaxMinutes: 10_000,
    maxPositionPerTokenUsd: 40,
    rankLossGraceSeconds: 90,
    twoWalletWindowSeconds: 100,
    threeWalletWindowSeconds: 240,
    distributionSellRatio: 0.3,
    distributionMinSellsUsd: 150,
    distributionWalletCount: 3,
    tier1BuyUsd: 5,
    tier1MinCommitmentUsd: 1_500,
    tier2BuyUsd: 5,
    tier2MinCommitmentUsd: 3_000,
    tier3BuyUsd: 10,
    tier3MinCommitmentUsd: 6_000,
    tier4BuyUsd: 20,
    tier4MinCommitmentUsd: 12_000,
    weightNetCommitment: 28,
    weightVelocity: 24,
    weightAcceleration: 22,
    weightConvergence: 16,
    weightPersistence: 10,
  };
  const backtest = convictionBacktestEngineConfig(settings, wallets);
  const production = convictionConfigFromBotConfig({
    target_wallet: wallets[0],
    additional_target_wallets: wallets.slice(1),
    conviction_mode_enabled: true,
    conviction_trading_mode: "shadow",
    conviction_rapid_follow_enabled: settings.rapidFollowEnabled,
    conviction_primary_window_minutes: settings.leaderboardWindowMinutes,
    conviction_score_threshold: settings.scoreThreshold,
    conviction_top_n: settings.topN,
    conviction_min_commitment_usd: settings.minNetCommitmentUsd,
    conviction_min_recent_net_inflow_usd: settings.minRecentNetInflowUsd,
    conviction_min_velocity_usd_per_minute: settings.minCapitalVelocityUsdPerMinute,
    conviction_min_acceleration_ratio: settings.minCapitalAccelerationRatio,
    conviction_min_converged_wallets: settings.minConvergedWallets,
    conviction_two_wallet_window_seconds: settings.twoWalletWindowSeconds,
    conviction_three_wallet_window_seconds: settings.threeWalletWindowSeconds,
    conviction_min_individual_buy_usd: settings.minIndividualBuyUsd,
    conviction_market_cap_filter_enabled: settings.marketCapFilterEnabled,
    conviction_market_cap_min_usd: settings.marketCapMinUsd,
    conviction_market_cap_max_usd: settings.marketCapMaxUsd,
    conviction_liquidity_filter_enabled: settings.liquidityFilterEnabled,
    conviction_liquidity_min_usd: settings.liquidityMinUsd,
    conviction_liquidity_max_usd: settings.liquidityMaxUsd,
    conviction_token_age_filter_enabled: settings.tokenAgeFilterEnabled,
    conviction_token_age_min_minutes: settings.tokenAgeMinMinutes,
    conviction_token_age_max_minutes: settings.tokenAgeMaxMinutes,
    conviction_max_position_per_token_usd: settings.maxPositionPerTokenUsd,
    conviction_distribution_sell_ratio: settings.distributionSellRatio,
    conviction_distribution_min_sells_usd: settings.distributionMinSellsUsd,
    conviction_distribution_wallet_count: settings.distributionWalletCount,
    conviction_inactivity_minutes: settings.dataFreshnessSeconds / 60,
    conviction_rank_loss_grace_seconds: settings.rankLossGraceSeconds,
    conviction_weight_net_commitment: settings.weightNetCommitment,
    conviction_weight_velocity: settings.weightVelocity,
    conviction_weight_acceleration: settings.weightAcceleration,
    conviction_weight_convergence: settings.weightConvergence,
    conviction_weight_persistence: settings.weightPersistence,
    conviction_tier_commitment_thresholds_usd: [
      settings.tier1MinCommitmentUsd,
      settings.tier2MinCommitmentUsd,
      settings.tier3MinCommitmentUsd,
      settings.tier4MinCommitmentUsd,
    ],
    conviction_tier_buy_amounts_usd: [
      settings.tier1BuyUsd,
      settings.tier2BuyUsd,
      settings.tier3BuyUsd,
      settings.tier4BuyUsd,
    ],
  } as Parameters<typeof convictionConfigFromBotConfig>[0]);
  const sharedKeys = [
    "enabled",
    "tradingMode",
    "rapidFollowEnabled",
    "clusterWallets",
    "requiredClusterWalletCount",
    "primaryLeaderboardWindowMinutes",
    "entryTopN",
    "minScore",
    "minNetCommitmentUsd",
    "minRecentNetInflowUsd",
    "minCapitalVelocityUsdPerMinute",
    "minCapitalAcceleration",
    "minConvergedWallets",
    "minIndividualBuyUsd",
    "marketCapMinUsd",
    "marketCapMaxUsd",
    "liquidityMinUsd",
    "liquidityMaxUsd",
    "tokenAgeMinMinutes",
    "tokenAgeMaxMinutes",
    "maxPositionPerTokenUsd",
    "dataFreshnessMs",
    "rankLossGraceMs",
    "convergenceTwoWalletWindowMs",
    "convergenceThreeWalletWindowMs",
    "distributionSellRatio",
    "distributionMinSellsUsd",
    "distributionWalletCount",
    "weights",
    "tiers",
    "scoreNetCommitmentFullUsd",
    "scoreVelocityFullUsdPerMinute",
    "scoreAccelerationFullRatio",
  ] as const;

  assert.deepEqual(
    Object.fromEntries(sharedKeys.map((key) => [key, backtest[key]])),
    Object.fromEntries(sharedKeys.map((key) => [key, production[key]])),
  );
});

test("historical labels are applied after chronological replay without lookahead", () => {
  const rows = [
    observation("late", 10, "mm-2", "winner", 30_000),
    observation("first", 0, "mm-1", "winner", 500),
    observation("probe", 5, "mm-1", "probe", 100),
  ];
  const result = runConvictionHistoricalBacktest(rows, permissive, wallets, sourceStats(rows));

  assert.equal(result.uniqueTokens, 2);
  assert.equal(result.thresholds.find((row) => row.thresholdUsd === 25_000)?.eventualTokenCount, 1);
  assert.equal(result.eventual25kDetectedPct, 100);
  // Both tokens qualify under intentionally permissive settings: winner at
  // $500 and probe at $100, so the median is $300. The winner was not allowed
  // to borrow its later $30K commitment for the earlier signal.
  assert.equal(result.medianCommitmentAtFirstSignalUsd, 300);
  assert.equal(result.probeRejectionRatePct, 0);
  assert.equal(result.hypotheticalTierCount, 3);
  assert.equal(result.hypotheticalExposureUsd, 15);
});

test("strict thresholds reject probes and never fabricate unavailable metrics", () => {
  const rows = [observation("probe", 0, "mm-1", "probe", 100)];
  const settings = { ...permissive, minNetCommitmentUsd: 1_000, tier1MinCommitmentUsd: 1_000 };
  const result = runConvictionHistoricalBacktest(rows, settings, wallets, {
    requestedSince: new Date(START - 1_000).toISOString(),
    observationsLoaded: 2,
    observationsWithUsd: 1,
    observationsProductionEquivalent: 1,
    observationsExcludedUnverified: 0,
    observationsExcludedUnvalued: 1,
    observationsExcludedDelayedValuation: 0,
    observationsWithMarketCap: 0,
    observationsWithLiquidity: 0,
    marketCapSnapshotsExcludedForTiming: 0,
    liquiditySnapshotsExcludedForTiming: 0,
    capped: false,
    cap: 25_000,
  });

  assert.equal(result.signaledTokenCount, 0);
  assert.equal(result.probeRejectionRatePct, 100);
  assert.equal(result.eventual25kDetectedPct, null);
  assert.equal(result.medianCommitmentAtFirstSignalUsd, null);
  assert.equal(result.hypotheticalTierCount, 0);
  assert.equal(result.hypotheticalExposureUsd, 0);
  assert.match(result.limitations.join(" "), /Market-cap history is incomplete/);
});

test("Rapid Follow off permits the initial tier but no automatic scale-ins", () => {
  const rows = [
    observation("buy-1", 0, "mm-1", "winner", 500),
    observation("buy-2", 10, "mm-2", "winner", 5_000),
    observation("buy-3", 20, "mm-3", "winner", 20_000),
  ];
  const result = runConvictionHistoricalBacktest(
    rows,
    { ...permissive, rapidFollowEnabled: false },
    wallets,
    sourceStats(rows),
  );

  assert.equal(result.signaledTokenCount, 1);
  assert.equal(result.hypotheticalTierCount, 1);
  assert.equal(result.hypotheticalExposureUsd, permissive.tier1BuyUsd);
});

test("a target sell updates history but can never originate a hypothetical tier", () => {
  const rows = [
    observation("buy", 0, "mm-1", "winner", 500),
    { ...observation("sell", 1, "mm-1", "winner", 1), side: "sell" as const },
  ];
  const result = runConvictionHistoricalBacktest(rows, permissive, wallets, sourceStats(rows));

  assert.equal(result.hypotheticalTierCount, 1);
  assert.equal(result.hypotheticalExposureUsd, permissive.tier1BuyUsd);
});

test("the local recent net-inflow threshold uses the same absolute gate as production", () => {
  const rows = [observation("buy", 0, "mm-1", "candidate", 500)];
  const result = runConvictionHistoricalBacktest(
    rows,
    { ...permissive, minRecentNetInflowUsd: 1_000 },
    wallets,
    sourceStats(rows),
  );

  assert.equal(result.signaledTokenCount, 0);
  assert.equal(result.hypotheticalTierCount, 0);
});

test("lifecycle segments use only token age and activity already known at each timestamp", () => {
  const oldCreatedAt = START - 2 * 86_400_000;
  const rows = [
    { ...observation("old-first", 0, "mm-1", "old", 500), tokenCreatedAtMs: oldCreatedAt },
    { ...observation("new", 1, "mm-1", "new", 500), tokenCreatedAtMs: START },
    { ...observation("old-active", 60, "mm-2", "old", 500), tokenCreatedAtMs: oldCreatedAt },
    {
      ...observation("old-revival", 7_261, "mm-3", "old", 500),
      tokenCreatedAtMs: oldCreatedAt,
    },
  ];
  const result = runConvictionHistoricalBacktest(
    rows,
    {
      ...permissive,
      lifecycleNewMinutes: 60,
      lifecycleRevivalInactivityMinutes: 120,
      dataFreshnessSeconds: 10_000,
    },
    wallets,
    sourceStats(rows),
  );
  const segment = (name: string) =>
    result.lifecycleSegments.find((metric) => metric.segment === name);

  assert.equal(segment("UNCLASSIFIED")?.observationCount, 1);
  assert.equal(segment("NEW")?.observationCount, 1);
  assert.equal(segment("ACTIVE")?.observationCount, 1);
  assert.equal(segment("REVIVAL")?.observationCount, 1);
  assert.match(result.limitations.join(" "), /first older-token event/i);
});

test("unverified historical rows fail closed and cannot improve backtest results", () => {
  const verified = observation("verified", 0, "mm-1", "winner", 500);
  const unverified = {
    ...observation("unverified", 1, "mm-2", "winner", 100_000),
    classificationReliable: false,
  };
  const rows = [verified, unverified];
  const result = runConvictionHistoricalBacktest(rows, permissive, wallets, {
    ...sourceStats(rows),
    observationsProductionEquivalent: 1,
    observationsExcludedUnverified: 1,
    observationsWithMarketCap: 1,
    observationsWithLiquidity: 1,
  });

  assert.equal(result.observationsReplayed, 1);
  assert.equal(
    result.thresholds.find((row) => row.thresholdUsd === 100_000)?.eventualTokenCount,
    0,
  );
  assert.match(result.limitations.join(" "), /lacked enough stored verification/);
});

test("time-sensitive historical prices are bounded to event time without rejecting exact stablecoins", () => {
  const eventAt = new Date(START).toISOString();
  const causal = (input: {
    detectedLagMs?: number;
    valuationLagMs: number | null;
    valuationSource: string;
    valuationProceedsMint?: string | null;
  }) =>
    historicalValuationIsCausal({
      eventAt,
      detectedAt: new Date(START + (input.detectedLagMs ?? 1_000)).toISOString(),
      valuationSource: input.valuationSource,
      valuationProceedsMint: input.valuationProceedsMint ?? null,
      valuationObservedAtMs: input.valuationLagMs === null ? null : START + input.valuationLagMs,
    });

  assert.equal(
    causal({ valuationLagMs: null, valuationSource: "stablecoin" }),
    true,
    "an on-chain stablecoin spend is exact even when indexed later",
  );
  assert.equal(
    causal({
      valuationLagMs: null,
      valuationSource: "verified-proceeds",
      valuationProceedsMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    }),
    true,
    "verified USDC proceeds are exact even when indexed later",
  );
  assert.equal(
    causal({ valuationLagMs: MAX_HISTORICAL_PRICE_LAG_MS, valuationSource: "sol" }),
    true,
  );
  assert.equal(
    causal({ valuationLagMs: MAX_HISTORICAL_PRICE_LAG_MS + 1, valuationSource: "sol" }),
    false,
  );
  assert.equal(causal({ valuationLagMs: 60_000, valuationSource: "input-token-quote" }), false);
  assert.equal(causal({ valuationLagMs: 60_000, valuationSource: "sold-token-price" }), false);
  assert.equal(
    causal({
      valuationLagMs: 60_000,
      valuationSource: "verified-proceeds",
      valuationProceedsMint: "non-stable-token",
    }),
    false,
  );
  assert.equal(
    causal({ valuationLagMs: null, valuationSource: "sol" }),
    false,
    "earliest detected_at cannot stand in for a missing valuation timestamp",
  );
  assert.equal(
    causal({
      detectedLagMs: 1_000,
      valuationLagMs: 60_000,
      valuationSource: "input-token-quote",
    }),
    false,
    "a later enriched duplicate cannot borrow the first duplicate's early detected_at",
  );
});

test("defense-in-depth replay excludes a delayed price-derived observation", () => {
  const delayed = {
    ...observation("delayed", 0, "mm-1", "winner", 100_000),
    detectedAt: new Date(START + 1_000).toISOString(),
    valuationSource: "sol",
    valuationObservedAtMs: START + MAX_HISTORICAL_PRICE_LAG_MS + 1,
  };
  const result = runConvictionHistoricalBacktest([delayed], permissive, wallets, {
    ...sourceStats([delayed]),
    observationsProductionEquivalent: 0,
    observationsExcludedDelayedValuation: 1,
    observationsWithMarketCap: 0,
    observationsWithLiquidity: 0,
  });

  assert.equal(result.observationsReplayed, 0);
  assert.equal(result.signaledTokenCount, 0);
  assert.match(result.limitations.join(" "), /excluded to prevent lookahead/i);
});

test("exact stablecoin value cannot borrow delayed market-cap or liquidity snapshots", () => {
  const stablecoin = {
    ...observation("stablecoin", 0, "mm-1", "winner", 500),
    marketDataObservedAtMs: null,
  };
  assert.equal(
    historicalMarketDataIsCausal({
      eventAt: stablecoin.eventAt,
      marketDataObservedAtMs: stablecoin.marketDataObservedAtMs,
    }),
    false,
  );
  const result = runConvictionHistoricalBacktest(
    [stablecoin],
    {
      ...permissive,
      marketCapFilterEnabled: true,
      marketCapMinUsd: 1,
      marketCapMaxUsd: 1_000_000,
      liquidityFilterEnabled: true,
      liquidityMinUsd: 1,
      liquidityMaxUsd: 1_000_000,
    },
    wallets,
    {
      ...sourceStats([stablecoin]),
      observationsWithMarketCap: 0,
      observationsWithLiquidity: 0,
      marketCapSnapshotsExcludedForTiming: 1,
      liquiditySnapshotsExcludedForTiming: 1,
    },
  );

  assert.equal(result.observationsReplayed, 1, "the exact stablecoin amount remains causal");
  assert.equal(result.signaledTokenCount, 0, "enabled market gates fail closed on cleared fields");
  assert.match(result.limitations.join(" "), /were cleared before replay/i);
});
