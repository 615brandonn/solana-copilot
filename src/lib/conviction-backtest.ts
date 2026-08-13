import {
  ConvictionEngine,
  type ConvictionConfig,
  type ConvictionEvent,
} from "../../worker/src/conviction-engine";

import type {
  ConvictionBacktestLifecycleMetric,
  ConvictionBacktestResult,
  ConvictionBacktestSettings,
  ConvictionBacktestThresholdMetric,
  ConvictionLifecycleSegment,
} from "./conviction-lab";

export type ConvictionHistoricalObservation = {
  eventKey: string;
  eventAt: string;
  detectedAt: string;
  side: "buy" | "sell";
  actorWallet: string;
  tokenMint: string;
  amountUsd: number;
  amountTokens: number;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  tokenCreatedAtMs: number | null;
  valuationSource: string;
  valuationProceedsMint: string | null;
  valuationObservedAtMs: number | null;
  marketDataObservedAtMs: number | null;
  /** True only when stored evidence meets the worker's production classification standard. */
  classificationReliable: boolean;
};

export type ConvictionBacktestSourceStats = {
  requestedSince: string;
  observationsLoaded: number;
  observationsWithUsd: number;
  observationsProductionEquivalent: number;
  observationsExcludedUnverified: number;
  observationsExcludedUnvalued: number;
  observationsExcludedDelayedValuation: number;
  observationsWithMarketCap: number;
  observationsWithLiquidity: number;
  marketCapSnapshotsExcludedForTiming: number;
  liquiditySnapshotsExcludedForTiming: number;
  capped: boolean;
  cap: number;
};

/**
 * Price-derived historical values are safe only when the quote was observed
 * close to the blockchain event. This matches the worker's 15-second live
 * action window and prevents a catch-up row from borrowing a later price.
 */
export const MAX_HISTORICAL_PRICE_LAG_MS = 15_000;

const HISTORICAL_STABLECOIN_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCo24RDUuUuJZq8bn6T", // USDT
]);

export function historicalValuationIsCausal(input: {
  eventAt: string;
  detectedAt: string;
  valuationSource: string;
  valuationProceedsMint: string | null;
  valuationObservedAtMs: number | null;
}): boolean {
  const eventAtMs = new Date(input.eventAt).getTime();
  if (!Number.isFinite(eventAtMs)) return false;

  const exactStablecoinValue =
    input.valuationSource === "stablecoin" ||
    input.valuationSource === "stablecoin-proceeds" ||
    (input.valuationSource === "verified-proceeds" &&
      input.valuationProceedsMint !== null &&
      HISTORICAL_STABLECOIN_MINTS.has(input.valuationProceedsMint));
  if (exactStablecoinValue) return true;

  // `detectedAt` is deliberately not a fallback here. The recorder keeps the
  // earliest duplicate's detection time while a later duplicate may enrich
  // valuation metadata. Only the timestamp attached to the valuation itself
  // can establish causality for a price-derived amount.
  const valuationObservedAtMs = input.valuationObservedAtMs;
  if (valuationObservedAtMs === null || !Number.isFinite(valuationObservedAtMs)) return false;
  const lagMs = valuationObservedAtMs - eventAtMs;
  return lagMs >= 0 && lagMs <= MAX_HISTORICAL_PRICE_LAG_MS;
}

export function historicalMarketDataIsCausal(input: {
  eventAt: string;
  marketDataObservedAtMs: number | null;
}): boolean {
  const eventAtMs = new Date(input.eventAt).getTime();
  const marketDataObservedAtMs = input.marketDataObservedAtMs;
  if (
    !Number.isFinite(eventAtMs) ||
    marketDataObservedAtMs === null ||
    !Number.isFinite(marketDataObservedAtMs)
  ) {
    return false;
  }
  const lagMs = marketDataObservedAtMs - eventAtMs;
  return lagMs >= 0 && lagMs <= MAX_HISTORICAL_PRICE_LAG_MS;
}

const LABEL_THRESHOLDS = [5_000, 10_000, 25_000, 50_000, 100_000] as const;
const LIFECYCLE_SEGMENTS: ConvictionLifecycleSegment[] = [
  "NEW",
  "ACTIVE",
  "REVIVAL",
  "UNCLASSIFIED",
];

function finite(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function percent(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function convictionBacktestEngineConfig(
  settings: ConvictionBacktestSettings,
  clusterWallets: string[],
): Partial<ConvictionConfig> {
  const normalizedClusterWallets = Array.from(
    new Set(clusterWallets.map((wallet) => wallet.trim()).filter(Boolean)),
  );
  return {
    enabled: normalizedClusterWallets.length === 3,
    tradingMode: "shadow",
    rapidFollowEnabled: settings.rapidFollowEnabled,
    clusterWallets: normalizedClusterWallets.slice(0, 3),
    requiredClusterWalletCount: 3,
    primaryLeaderboardWindowMinutes: settings.leaderboardWindowMinutes,
    entryTopN: settings.topN,
    minScore: settings.scoreThreshold,
    minNetCommitmentUsd: settings.minNetCommitmentUsd,
    minRecentNetInflowUsd: settings.minRecentNetInflowUsd,
    minCapitalVelocityUsdPerMinute: settings.minCapitalVelocityUsdPerMinute,
    minCapitalAcceleration: Math.max(0, settings.minCapitalAccelerationRatio),
    minConvergedWallets: settings.minConvergedWallets,
    minIndividualBuyUsd: settings.minIndividualBuyUsd,
    marketCapMinUsd: settings.marketCapFilterEnabled ? settings.marketCapMinUsd : null,
    marketCapMaxUsd: settings.marketCapFilterEnabled ? settings.marketCapMaxUsd : null,
    liquidityMinUsd: settings.liquidityFilterEnabled ? settings.liquidityMinUsd : null,
    liquidityMaxUsd: settings.liquidityFilterEnabled ? settings.liquidityMaxUsd : null,
    tokenAgeMinMinutes: settings.tokenAgeFilterEnabled ? settings.tokenAgeMinMinutes : null,
    tokenAgeMaxMinutes: settings.tokenAgeFilterEnabled ? settings.tokenAgeMaxMinutes : null,
    maxPositionPerTokenUsd: settings.maxPositionPerTokenUsd,
    dataFreshnessMs: settings.dataFreshnessSeconds * 1_000,
    rankLossGraceMs: settings.rankLossGraceSeconds * 1_000,
    convergenceTwoWalletWindowMs: settings.twoWalletWindowSeconds * 1_000,
    convergenceThreeWalletWindowMs: settings.threeWalletWindowSeconds * 1_000,
    distributionSellRatio: settings.distributionSellRatio,
    distributionMinSellsUsd: settings.distributionMinSellsUsd,
    distributionWalletCount: settings.distributionWalletCount,
    weights: {
      netCommitment: settings.weightNetCommitment,
      capitalVelocity: settings.weightVelocity,
      capitalAcceleration: settings.weightAcceleration,
      walletConvergence: settings.weightConvergence,
      rankPersistence: settings.weightPersistence,
    },
    tiers: [
      {
        id: "tier_1",
        buyUsd: settings.tier1BuyUsd,
        minScore: settings.scoreThreshold,
        minNetCommitmentUsd: settings.tier1MinCommitmentUsd,
        minVelocityUsdPerMinute: settings.minCapitalVelocityUsdPerMinute,
        minCommitmentIncreaseRatio: 0,
      },
      {
        id: "tier_2",
        buyUsd: settings.tier2BuyUsd,
        minScore: settings.scoreThreshold,
        minNetCommitmentUsd: settings.tier2MinCommitmentUsd,
        minVelocityUsdPerMinute: settings.minCapitalVelocityUsdPerMinute,
        minCommitmentIncreaseRatio: 0,
      },
      {
        id: "tier_3",
        buyUsd: settings.tier3BuyUsd,
        minScore: settings.scoreThreshold,
        minNetCommitmentUsd: settings.tier3MinCommitmentUsd,
        minVelocityUsdPerMinute: settings.minCapitalVelocityUsdPerMinute,
        minCommitmentIncreaseRatio: 0,
      },
      {
        id: "tier_4",
        buyUsd: settings.tier4BuyUsd,
        minScore: settings.scoreThreshold,
        minNetCommitmentUsd: settings.tier4MinCommitmentUsd,
        minVelocityUsdPerMinute: settings.minCapitalVelocityUsdPerMinute,
        minCommitmentIncreaseRatio: 0,
      },
    ],
    scoreNetCommitmentFullUsd: Math.max(
      1,
      settings.minNetCommitmentUsd,
      settings.tier1MinCommitmentUsd,
      settings.tier2MinCommitmentUsd,
      settings.tier3MinCommitmentUsd,
      settings.tier4MinCommitmentUsd,
    ),
    scoreVelocityFullUsdPerMinute: Math.max(1, settings.minCapitalVelocityUsdPerMinute * 4),
    scoreAccelerationFullRatio: Math.max(1.01, settings.minCapitalAccelerationRatio * 2),
  };
}

/**
 * Replays target swaps in timestamp order through the exact worker signal engine.
 * Future/peak commitment labels are calculated only after the replay completes,
 * so no later observation can influence an earlier signal.
 */
export function runConvictionHistoricalBacktest(
  observations: ConvictionHistoricalObservation[],
  settings: ConvictionBacktestSettings,
  clusterWallets: string[],
  source: ConvictionBacktestSourceStats,
): ConvictionBacktestResult {
  const chronological = observations
    .filter(
      (row) =>
        row.classificationReliable === true &&
        Number.isFinite(row.amountUsd) &&
        row.amountUsd > 0 &&
        Boolean(row.eventKey) &&
        Boolean(row.actorWallet) &&
        Boolean(row.tokenMint) &&
        Number.isFinite(new Date(row.eventAt).getTime()) &&
        Number.isFinite(new Date(row.detectedAt).getTime()) &&
        historicalValuationIsCausal(row),
    )
    .sort(
      (left, right) =>
        new Date(left.eventAt).getTime() - new Date(right.eventAt).getTime() ||
        left.eventKey.localeCompare(right.eventKey),
    );
  const engine = new ConvictionEngine(convictionBacktestEngineConfig(settings, clusterWallets));
  const peakCommitment = new Map<string, number>();
  const firstSignalCommitment = new Map<string, number>();
  const firstSignalLifecycle = new Map<string, ConvictionLifecycleSegment>();
  const lastObservationAt = new Map<string, number>();
  const lifecycleObservationCounts = new Map<ConvictionLifecycleSegment, number>();
  const lifecycleTokens = new Map(
    LIFECYCLE_SEGMENTS.map((segment) => [segment, new Set<string>()] as const),
  );
  const newWindowMs = settings.lifecycleNewMinutes * 60_000;
  const revivalWindowMs = settings.lifecycleRevivalInactivityMinutes * 60_000;
  let signalCount = 0;
  let hypotheticalTierCount = 0;
  let hypotheticalExposureUsd = 0;

  for (const row of chronological) {
    const timestampMs = new Date(row.eventAt).getTime();
    const marketDataCausal = historicalMarketDataIsCausal(row);
    const previousObservationAt = lastObservationAt.get(row.tokenMint);
    const createdAtMs = row.tokenCreatedAtMs ?? Number.NaN;
    const lifecycle: ConvictionLifecycleSegment =
      Number.isFinite(createdAtMs) &&
      timestampMs >= createdAtMs &&
      timestampMs - createdAtMs <= newWindowMs
        ? "NEW"
        : previousObservationAt !== undefined &&
            timestampMs - previousObservationAt >= revivalWindowMs
          ? "REVIVAL"
          : previousObservationAt !== undefined
            ? "ACTIVE"
            : "UNCLASSIFIED";
    lastObservationAt.set(row.tokenMint, timestampMs);
    lifecycleObservationCounts.set(lifecycle, (lifecycleObservationCounts.get(lifecycle) ?? 0) + 1);
    lifecycleTokens.get(lifecycle)?.add(row.tokenMint);
    const event: ConvictionEvent = {
      eventId: row.eventKey,
      timestampMs,
      wallet: row.actorWallet,
      tokenMint: row.tokenMint,
      type: row.side === "buy" ? "DEX_BUY" : "DEX_SELL",
      amountUsd: Math.max(0, finite(row.amountUsd)),
      amountTokens: Math.max(0, finite(row.amountTokens)),
      marketCapUsd: marketDataCausal ? (row.marketCapUsd ?? undefined) : undefined,
      liquidityUsd: marketDataCausal ? (row.liquidityUsd ?? undefined) : undefined,
      tokenCreatedAtMs: row.tokenCreatedAtMs ?? undefined,
      classificationReliable: true,
      metadata: { source: "strategy_observations" },
    };
    const update = engine.process(event);
    peakCommitment.set(
      row.tokenMint,
      Math.max(peakCommitment.get(row.tokenMint) ?? 0, update.snapshot.netClusterInvestmentUsd),
    );
    // A production Conviction action is a qualifying tier, not merely a token
    // that passes the shared absolute gates. Recording the hypothetical fill
    // here advances the exact same once-per-tier state machine used by the
    // worker and makes the exposure cap part of every later decision.
    // Production only allows a newly verified target DEX buy to originate an
    // entry or scale-in. Sells still update commitment/distribution labels but
    // can never become a synthetic trigger in historical replay.
    if (row.side === "buy" && update.nextTier.eligible && update.nextTier.tier) {
      signalCount += 1;
      const execution = engine.recordTierExecution(row.tokenMint, update.nextTier.tier.id, {
        executedAtMs: timestampMs,
        amountUsd: update.nextTier.amountUsd,
        mode: "shadow",
        reference: `backtest:${row.eventKey}`,
      });
      hypotheticalTierCount += 1;
      hypotheticalExposureUsd += execution.amountUsd;
      if (!firstSignalCommitment.has(row.tokenMint)) {
        firstSignalCommitment.set(row.tokenMint, update.snapshot.netClusterInvestmentUsd);
        firstSignalLifecycle.set(row.tokenMint, lifecycle);
      }
    }
  }

  const tokenMints = [...peakCommitment.keys()];
  const thresholds: ConvictionBacktestThresholdMetric[] = LABEL_THRESHOLDS.map((thresholdUsd) => {
    const eventual = tokenMints.filter((mint) => (peakCommitment.get(mint) ?? 0) >= thresholdUsd);
    const detected = eventual.filter((mint) => firstSignalCommitment.has(mint));
    return {
      thresholdUsd,
      eventualTokenCount: eventual.length,
      detectedTokenCount: detected.length,
      detectionRatePct: percent(detected.length, eventual.length),
    };
  });
  const eventualAtLeast = (threshold: number) =>
    tokenMints.filter((mint) => (peakCommitment.get(mint) ?? 0) >= threshold);
  const detectedBeforeFiveThousand = (mint: string) =>
    (firstSignalCommitment.get(mint) ?? Number.POSITIVE_INFINITY) < 5_000;
  const eventual25 = eventualAtLeast(25_000);
  const eventual50 = eventualAtLeast(50_000);
  const eventual100 = eventualAtLeast(100_000);
  const signaled = [...firstSignalCommitment.keys()];
  const falsePositives = signaled.filter((mint) => (peakCommitment.get(mint) ?? 0) < 5_000);
  const probes = tokenMints.filter((mint) => (peakCommitment.get(mint) ?? 0) < 5_000);
  const rejectedProbes = probes.filter((mint) => !firstSignalCommitment.has(mint));
  const lifecycleSegments: ConvictionBacktestLifecycleMetric[] = LIFECYCLE_SEGMENTS.map(
    (segment) => {
      const uniqueTokenCount = lifecycleTokens.get(segment)?.size ?? 0;
      const firstSignalTokenCount = [...firstSignalLifecycle.values()].filter(
        (value) => value === segment,
      ).length;
      return {
        segment,
        observationCount: lifecycleObservationCounts.get(segment) ?? 0,
        uniqueTokenCount,
        firstSignalTokenCount,
        firstSignalRatePct: percent(firstSignalTokenCount, uniqueTokenCount),
      };
    },
  );
  const limitations = [
    "Historical labels use the highest observed net cluster commitment inside the selected period; they do not use token price performance.",
    "Signals use only observations already seen at each timestamp. Peak labels are applied after replay solely to measure detection quality.",
    "Only production-equivalent target swaps with a transaction signature, reliable classification evidence, and a historical USD value are replayed.",
    `Lifecycle labels use only information available at each event: NEW means token age ≤ ${settings.lifecycleNewMinutes.toLocaleString()} minutes; REVIVAL requires a prior replayed event followed by ≥ ${settings.lifecycleRevivalInactivityMinutes.toLocaleString()} minutes of inactivity. The first older-token event in the selected range remains unclassified because earlier history is unknown.`,
  ];
  if (source.observationsExcludedUnverified > 0) {
    limitations.push(
      `${source.observationsExcludedUnverified.toLocaleString()} valued target swap(s) lacked enough stored verification or replay-identity evidence and were excluded rather than assumed reliable.`,
    );
  }
  if (source.observationsExcludedUnvalued > 0) {
    limitations.push(
      `${source.observationsExcludedUnvalued.toLocaleString()} target swap(s) had no reliable historical USD value and were excluded rather than priced with future data.`,
    );
  }
  if (source.observationsExcludedDelayedValuation > 0) {
    limitations.push(
      `${source.observationsExcludedDelayedValuation.toLocaleString()} verified, valued swap(s) lacked an explicit causal valuation timestamp within ${MAX_HISTORICAL_PRICE_LAG_MS / 1_000} seconds of the event and were excluded to prevent lookahead. The row's earliest detected_at is not trusted because a later duplicate can enrich it. Exact stablecoin spend/proceeds values are not subject to this lag cutoff.`,
    );
  }
  if (
    source.marketCapSnapshotsExcludedForTiming > 0 ||
    source.liquiditySnapshotsExcludedForTiming > 0
  ) {
    limitations.push(
      `${source.marketCapSnapshotsExcludedForTiming.toLocaleString()} market-cap and ${source.liquiditySnapshotsExcludedForTiming.toLocaleString()} liquidity snapshot(s) lacked an explicit causal market-data timestamp within ${MAX_HISTORICAL_PRICE_LAG_MS / 1_000} seconds and were cleared before replay. Enabled market filters fail closed on those rows.`,
    );
  }
  if (source.capped)
    limitations.push(
      `The query filled its ${source.cap.toLocaleString()}-row safety cap; later rows, if any, were not replayed, so peak labels may be incomplete.`,
    );
  if (source.observationsWithMarketCap < source.observationsProductionEquivalent)
    limitations.push(
      "Market-cap history is incomplete; enabling its filter will conservatively reject rows with missing data.",
    );
  if (source.observationsWithLiquidity < source.observationsProductionEquivalent)
    limitations.push(
      "Liquidity history is incomplete; enabling its filter will conservatively reject rows with missing data.",
    );
  if (new Set(clusterWallets.filter(Boolean)).size !== 3)
    limitations.push(
      `Exactly 3 unique target wallets are required; the current selection does not meet that production safety gate, so signals are blocked.`,
    );
  limitations.push(
    "The replay uses only wallets in the current authoritative target-wallet configuration; historical configuration changes are not reconstructed.",
    "Historical observations do not provide a complete executable price-and-exit path. Hypothetical tiers measure signal timing and capped exposure only; this lab does not fabricate token P&L, slippage, fees, or exit returns.",
  );

  return {
    generatedAt: new Date().toISOString(),
    requestedSince: source.requestedSince,
    observedFrom: chronological[0]?.eventAt ?? null,
    observedThrough: chronological.at(-1)?.eventAt ?? null,
    observationsLoaded: source.observationsLoaded,
    observationsReplayed: chronological.length,
    observationsWithUsd: source.observationsWithUsd,
    observationsProductionEquivalent: source.observationsProductionEquivalent,
    observationsExcludedUnverified: source.observationsExcludedUnverified,
    observationsExcludedUnvalued: source.observationsExcludedUnvalued,
    observationsExcludedDelayedValuation: source.observationsExcludedDelayedValuation,
    observationsWithMarketCap: source.observationsWithMarketCap,
    observationsWithLiquidity: source.observationsWithLiquidity,
    marketCapSnapshotsExcludedForTiming: source.marketCapSnapshotsExcludedForTiming,
    liquiditySnapshotsExcludedForTiming: source.liquiditySnapshotsExcludedForTiming,
    uniqueTokens: tokenMints.length,
    signalCount,
    signaledTokenCount: firstSignalCommitment.size,
    hypotheticalTierCount,
    hypotheticalExposureUsd: Math.round(hypotheticalExposureUsd * 100) / 100,
    capped: source.capped,
    cap: source.cap,
    thresholds,
    lifecycleSegments,
    eventual25kDetectedPct: percent(
      eventual25.filter((mint) => firstSignalCommitment.has(mint)).length,
      eventual25.length,
    ),
    eventual50kDetectedBefore5kPct: percent(
      eventual50.filter(detectedBeforeFiveThousand).length,
      eventual50.length,
    ),
    eventual100kDetectedBefore5kPct: percent(
      eventual100.filter(detectedBeforeFiveThousand).length,
      eventual100.length,
    ),
    medianCommitmentAtFirstSignalUsd: median([...firstSignalCommitment.values()]),
    falsePositiveRatePct: percent(falsePositives.length, signaled.length),
    probeRejectionRatePct: percent(rejectedProbes.length, probes.length),
    limitations,
    settings,
  };
}
