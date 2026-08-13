/**
 * Pure, deterministic Conviction Mode signal engine.
 *
 * This module deliberately performs no I/O and never submits a transaction.
 * Runtime code supplies already-decoded cluster events, persists snapshots/events,
 * and treats `entry.authorizedToSubmit` as only one input to its final safety gate.
 */

export const CONVICTION_WINDOW_SECONDS = [30, 60, 180, 300, 900, 1_800, 3_600] as const;
export type ConvictionWindowSeconds = (typeof CONVICTION_WINDOW_SECONDS)[number];
export type ConvictionLeaderboardWindowMinutes = 5 | 30 | 60;

export type ConvictionEventType =
  | "DEX_BUY"
  | "DEX_SELL"
  | "INTERNAL_CLUSTER_TRANSFER"
  | "EXTERNAL_TRANSFER_IN"
  | "EXTERNAL_TRANSFER_OUT"
  | "UNKNOWN";

export type ConvictionState =
  | "TESTING"
  | "WATCHING"
  | "ACCUMULATING"
  | "BETTING"
  | "HIGH_CONVICTION"
  | "DISTRIBUTING";

export type ConvictionTradingMode = "shadow" | "live";
export type RankDirection = "new" | "up" | "down" | "flat" | "out";
export type RapidFollowStatus = "inactive" | "active" | "stopped";

export type ConvictionEvent = {
  /** Stable transaction/event identity. Feed source must not be part of this value. */
  eventId: string;
  timestampMs: number;
  wallet: string;
  tokenMint: string;
  type: ConvictionEventType;
  amountUsd: number;
  amountTokens?: number;
  symbol?: string;
  fromWallet?: string;
  toWallet?: string;
  marketCapUsd?: number;
  liquidityUsd?: number;
  tokenCreatedAtMs?: number;
  /** False when attribution or valuation is too ambiguous for automatic action. */
  classificationReliable?: boolean;
  metadata?: Record<string, unknown>;
};

export type ConvictionEventClassificationInput = {
  side?: "buy" | "sell";
  verifiedSwap?: boolean;
  fromWallet?: string;
  toWallet?: string;
  clusterWallets: Iterable<string>;
};

/** Conservative classification: uncertainty is UNKNOWN, never a synthetic buy. */
export function classifyConvictionEvent(
  input: ConvictionEventClassificationInput,
): ConvictionEventType {
  const cluster = new Set(Array.from(input.clusterWallets).filter(Boolean));
  if (input.verifiedSwap === true && input.side === "buy") return "DEX_BUY";
  if (input.verifiedSwap === true && input.side === "sell") return "DEX_SELL";
  const fromCluster = !!input.fromWallet && cluster.has(input.fromWallet);
  const toCluster = !!input.toWallet && cluster.has(input.toWallet);
  if (fromCluster && toCluster) return "INTERNAL_CLUSTER_TRANSFER";
  if (!fromCluster && toCluster) return "EXTERNAL_TRANSFER_IN";
  if (fromCluster && !toCluster && !!input.toWallet) return "EXTERNAL_TRANSFER_OUT";
  return "UNKNOWN";
}

export type ConvictionWeights = {
  netCommitment: number;
  capitalVelocity: number;
  capitalAcceleration: number;
  walletConvergence: number;
  rankPersistence: number;
};

export type ConvictionTierConfig = {
  id: string;
  buyUsd: number;
  minScore: number;
  minNetCommitmentUsd: number;
  minVelocityUsdPerMinute: number;
  /** Required increase over the net commitment recorded at the prior tier. */
  minCommitmentIncreaseRatio: number;
};

export type ConvictionConfig = {
  enabled: boolean;
  tradingMode: ConvictionTradingMode;
  rapidFollowEnabled: boolean;
  clusterWallets: string[];
  requiredClusterWalletCount: number;
  primaryLeaderboardWindowMinutes: ConvictionLeaderboardWindowMinutes;
  entryTopN: number;
  minScore: number;
  minNetCommitmentUsd: number;
  minRecentNetInflowUsd: number;
  minCapitalVelocityUsdPerMinute: number;
  minCapitalAcceleration: number;
  minConvergedWallets: number;
  minIndividualBuyUsd: number;
  marketCapMinUsd: number | null;
  marketCapMaxUsd: number | null;
  liquidityMinUsd: number | null;
  liquidityMaxUsd: number | null;
  tokenAgeMinMinutes: number | null;
  tokenAgeMaxMinutes: number | null;
  maxPositionPerTokenUsd: number;
  dataFreshnessMs: number;
  /** A scale-in may survive a temporary Top-N drop for this long. Initial entries never use grace. */
  rankLossGraceMs: number;
  convergenceTwoWalletWindowMs: number;
  convergenceThreeWalletWindowMs: number;
  distributionWindowSeconds: ConvictionWindowSeconds;
  distributionSellRatio: number;
  distributionMinSellsUsd: number;
  distributionWalletCount: number;
  weights: ConvictionWeights;
  scoreNetCommitmentFullUsd: number;
  scoreVelocityFullUsdPerMinute: number;
  scoreAccelerationFullRatio: number;
  scoreRankPersistenceFullMs: number;
  testingMaxScore: number;
  watchingMaxScore: number;
  accumulatingMaxScore: number;
  bettingMaxScore: number;
  breakoutMinScore: number;
  leaderboardActiveMs: number;
  tiers: ConvictionTierConfig[];
};

export const DEFAULT_CONVICTION_CONFIG: Readonly<ConvictionConfig> = Object.freeze({
  enabled: false,
  tradingMode: "shadow",
  rapidFollowEnabled: false,
  clusterWallets: [],
  requiredClusterWalletCount: 3,
  primaryLeaderboardWindowMinutes: 30,
  entryTopN: 3,
  minScore: 70,
  minNetCommitmentUsd: 1_000,
  minRecentNetInflowUsd: 0.01,
  minCapitalVelocityUsdPerMinute: 250,
  minCapitalAcceleration: 1.25,
  minConvergedWallets: 1,
  minIndividualBuyUsd: 0,
  marketCapMinUsd: null,
  marketCapMaxUsd: null,
  liquidityMinUsd: null,
  liquidityMaxUsd: null,
  tokenAgeMinMinutes: null,
  tokenAgeMaxMinutes: null,
  maxPositionPerTokenUsd: 25,
  dataFreshnessMs: 15 * 60_000,
  rankLossGraceMs: 120_000,
  convergenceTwoWalletWindowMs: 120_000,
  convergenceThreeWalletWindowMs: 300_000,
  distributionWindowSeconds: 300,
  distributionSellRatio: 0.2,
  distributionMinSellsUsd: 100,
  distributionWalletCount: 2,
  weights: {
    netCommitment: 30,
    capitalVelocity: 25,
    capitalAcceleration: 20,
    walletConvergence: 15,
    rankPersistence: 10,
  },
  scoreNetCommitmentFullUsd: 10_000,
  scoreVelocityFullUsdPerMinute: 1_000,
  scoreAccelerationFullRatio: 2,
  scoreRankPersistenceFullMs: 10 * 60_000,
  testingMaxScore: 25,
  watchingMaxScore: 45,
  accumulatingMaxScore: 65,
  bettingMaxScore: 85,
  breakoutMinScore: 65,
  leaderboardActiveMs: 60 * 60_000,
  tiers: [
    {
      id: "tier_1",
      buyUsd: 5,
      minScore: 70,
      minNetCommitmentUsd: 1_000,
      minVelocityUsdPerMinute: 250,
      minCommitmentIncreaseRatio: 0,
    },
    {
      id: "tier_2",
      buyUsd: 5,
      minScore: 76,
      minNetCommitmentUsd: 2_500,
      minVelocityUsdPerMinute: 250,
      minCommitmentIncreaseRatio: 0.5,
    },
    {
      id: "tier_3",
      buyUsd: 5,
      minScore: 83,
      minNetCommitmentUsd: 5_000,
      minVelocityUsdPerMinute: 250,
      minCommitmentIncreaseRatio: 0.5,
    },
    {
      id: "tier_4",
      buyUsd: 10,
      minScore: 90,
      minNetCommitmentUsd: 10_000,
      minVelocityUsdPerMinute: 250,
      minCommitmentIncreaseRatio: 0.5,
    },
  ],
});

export type ConvictionWalletStats = {
  wallet: string;
  grossBuysUsd: number;
  grossSellsUsd: number;
  netInvestmentUsd: number;
  buyCount: number;
  sellCount: number;
  lastBuyAtMs?: number;
  lastSellAtMs?: number;
};

export type ConvictionRollingMetrics = {
  windowSeconds: ConvictionWindowSeconds;
  grossBuysUsd: number;
  grossSellsUsd: number;
  netFlowUsd: number;
  buyCount: number;
  sellCount: number;
  uniqueWalletsBuying: number;
  uniqueWalletsSelling: number;
  largestBuyUsd: number;
  averageBuyUsd: number;
  medianBuyUsd: number;
  capitalVelocityUsdPerMinute: number;
  previousGrossBuysUsd: number;
  previousGrossSellsUsd: number;
  previousNetFlowUsd: number;
  previousCapitalVelocityUsdPerMinute: number;
  /** Flow-only current-window versus prior-window ratio. */
  capitalAcceleration: number;
  buySizeAcceleration: number;
  cumulativeCommitmentAcceleration: number;
  /** Latest reliable buy versus the mean of preceding reliable buys. */
  latestBuyAcceleration: number;
  /** Transparent composite used by both scoring and the entry gate. */
  accelerationSignal: number;
};

export type ConvictionScoreComponent = {
  key: keyof ConvictionWeights | "distributionPenalty";
  raw: number;
  normalized: number;
  points: number;
  reason: string;
};

export type ConvictionRankSnapshot = {
  currentRank?: number;
  previousRank?: number;
  direction: RankDirection;
  timeInTop10Ms: number;
  timeInTop3Ms: number;
  timeAtOneMs: number;
  lastRankedAtMs?: number;
};

export type ConvictionWindowScore = {
  score: number;
  state: ConvictionState;
  components: ConvictionScoreComponent[];
  reasons: string[];
};

export type ConvictionTierExecution = {
  tierId: string;
  executedAtMs: number;
  mode: ConvictionTradingMode;
  amountUsd: number;
  netCommitmentUsd: number;
  reference?: string;
};

export type ConvictionTokenSnapshot = {
  mint: string;
  symbol?: string;
  firstSeenAtMs: number;
  lastActivityAtMs: number;
  lastClusterBuyAtMs?: number;
  grossClusterBuysUsd: number;
  grossClusterSellsUsd: number;
  netClusterInvestmentUsd: number;
  buyCount: number;
  sellCount: number;
  largestBuyUsd: number;
  lastBuyUsd: number;
  averageBuyUsd: number;
  medianBuyUsd: number;
  walletsThatBought: string[];
  walletsCurrentlyAccumulating: string[];
  walletStats: Record<string, ConvictionWalletStats>;
  marketCapUsd?: number;
  marketCapAtFirstClusterBuyUsd?: number;
  liquidityUsd?: number;
  tokenCreatedAtMs?: number;
  ourCurrentPositionUsd: number;
  convictionScore: number;
  convictionState: ConvictionState;
  scoreComponents: ConvictionScoreComponent[];
  scoreReasons: string[];
  rolling: Record<string, ConvictionRollingMetrics>;
  convergedWalletCount: number;
  convergenceWallets: string[];
  distributionDetected: boolean;
  classificationReliable: boolean;
  classificationUpdatedAtMs?: number;
  ranks: Record<string, ConvictionRankSnapshot>;
  /** Window-specific scores backing the independent 5m/30m/60m leaderboards. */
  windowScores: Record<string, ConvictionWindowScore>;
  /** Set when the token most recently falls below the configured primary Top-N. */
  rankLostAtMs?: number;
  rapidFollowStatus: RapidFollowStatus;
  executedTiers: ConvictionTierExecution[];
  /** Events required for rolling-window reconstruction after restart. */
  recentEvents: ConvictionEvent[];
  /** Durable dedupe identities already incorporated into cumulative totals. */
  processedEventKeys: string[];
  /** Cumulative values retained to reconstruct an exact median. */
  cumulativeBuySizesUsd: number[];
};

export type ConvictionTransition = {
  mint: string;
  timestampMs: number;
  previousState: ConvictionState;
  newState: ConvictionState;
  previousScore: number;
  newScore: number;
  reasons: string[];
};

export type ConvictionBreakout = {
  kind: "CONVICTION_BREAKOUT";
  mint: string;
  timestampMs: number;
  previousScore: number;
  newScore: number;
  netClusterInvestmentUsd: number;
  capitalVelocityUsdPerMinute: number;
  walletConvergence: number;
  marketCapUsd?: number;
  liquidityUsd?: number;
  reasons: string[];
};

export type ConvictionLeaderboardRow = {
  rank: number;
  previousRank?: number;
  rankDirection: RankDirection;
  windowMinutes: ConvictionLeaderboardWindowMinutes;
  mint: string;
  symbol?: string;
  score: number;
  state: ConvictionState;
  netClusterInvestmentUsd: number;
  netFlowUsd: number;
  capitalVelocityUsdPerMinute: number;
  capitalAcceleration: number;
  buySizeAcceleration: number;
  convergedWalletCount: number;
  largestBuyUsd: number;
  marketCapUsd?: number;
  liquidityUsd?: number;
  ourCurrentPositionUsd: number;
  timeInTop10Ms: number;
  timeInTop3Ms: number;
  timeAtOneMs: number;
  scoreReasons: string[];
};

export type ConvictionEntryContext = {
  nowMs?: number;
  rank?: number;
  globalEntriesEnabled?: boolean;
  requestedBuyUsd?: number;
};

export type ConvictionEntryDecision = {
  eligible: boolean;
  hypothetical: boolean;
  authorizedToSubmit: boolean;
  mode: ConvictionTradingMode;
  reasons: string[];
  failedGates: string[];
};

export type ConvictionTierDecision = {
  eligible: boolean;
  tier?: ConvictionTierConfig;
  amountUsd: number;
  remainingExposureUsd: number;
  authorizedToSubmit: boolean;
  reason: string;
};

export type ConvictionEngineUpdate = {
  duplicate: boolean;
  countedTowardCapital: boolean;
  eventKey: string;
  timestampMs: number;
  snapshot: ConvictionTokenSnapshot;
  transitions: ConvictionTransition[];
  breakouts: ConvictionBreakout[];
  entry: ConvictionEntryDecision;
  nextTier: ConvictionTierDecision;
};

type MutableToken = ConvictionTokenSnapshot;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function finiteNonNegative(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round((Number.isFinite(value) ? value : 0) * factor) / factor;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

function mergeConfig(patch: Partial<ConvictionConfig> = {}): ConvictionConfig {
  const config: ConvictionConfig = {
    ...clone(DEFAULT_CONVICTION_CONFIG),
    ...patch,
    weights: { ...DEFAULT_CONVICTION_CONFIG.weights, ...(patch.weights ?? {}) },
    tiers: clone(patch.tiers ?? DEFAULT_CONVICTION_CONFIG.tiers),
    clusterWallets: Array.from(
      new Set((patch.clusterWallets ?? []).map((wallet) => wallet.trim()).filter(Boolean)),
    ),
  };
  if (!CONVICTION_WINDOW_SECONDS.includes(config.distributionWindowSeconds)) {
    throw new Error("distributionWindowSeconds must be a supported rolling window");
  }
  if (![5, 30, 60].includes(config.primaryLeaderboardWindowMinutes)) {
    throw new Error("primaryLeaderboardWindowMinutes must be 5, 30, or 60");
  }
  const weightTotal = Object.values(config.weights).reduce(
    (sum, value) => sum + finiteNonNegative(value),
    0,
  );
  if (weightTotal <= 0) throw new Error("at least one conviction score weight must be positive");
  if (config.maxPositionPerTokenUsd <= 0)
    throw new Error("maxPositionPerTokenUsd must be positive");
  if (!Number.isFinite(config.rankLossGraceMs) || config.rankLossGraceMs < 0) {
    throw new Error("rankLossGraceMs must be non-negative");
  }
  if (
    config.liquidityMinUsd !== null &&
    config.liquidityMaxUsd !== null &&
    config.liquidityMaxUsd < config.liquidityMinUsd
  ) {
    throw new Error("liquidityMaxUsd must be greater than or equal to liquidityMinUsd");
  }
  if (new Set(config.tiers.map((tier) => tier.id)).size !== config.tiers.length) {
    throw new Error("conviction tier ids must be unique");
  }
  return config;
}

function blankRank(): ConvictionRankSnapshot {
  return { direction: "new", timeInTop10Ms: 0, timeInTop3Ms: 0, timeAtOneMs: 0 };
}

function blankRolling(windowSeconds: ConvictionWindowSeconds): ConvictionRollingMetrics {
  return {
    windowSeconds,
    grossBuysUsd: 0,
    grossSellsUsd: 0,
    netFlowUsd: 0,
    buyCount: 0,
    sellCount: 0,
    uniqueWalletsBuying: 0,
    uniqueWalletsSelling: 0,
    largestBuyUsd: 0,
    averageBuyUsd: 0,
    medianBuyUsd: 0,
    capitalVelocityUsdPerMinute: 0,
    previousGrossBuysUsd: 0,
    previousGrossSellsUsd: 0,
    previousNetFlowUsd: 0,
    previousCapitalVelocityUsdPerMinute: 0,
    capitalAcceleration: 0,
    buySizeAcceleration: 0,
    cumulativeCommitmentAcceleration: 0,
    latestBuyAcceleration: 0,
    accelerationSignal: 0,
  };
}

function blankSnapshot(event: ConvictionEvent): MutableToken {
  return {
    mint: event.tokenMint,
    symbol: event.symbol,
    firstSeenAtMs: event.timestampMs,
    lastActivityAtMs: event.timestampMs,
    grossClusterBuysUsd: 0,
    grossClusterSellsUsd: 0,
    netClusterInvestmentUsd: 0,
    buyCount: 0,
    sellCount: 0,
    largestBuyUsd: 0,
    lastBuyUsd: 0,
    averageBuyUsd: 0,
    medianBuyUsd: 0,
    walletsThatBought: [],
    walletsCurrentlyAccumulating: [],
    walletStats: {},
    marketCapUsd: event.marketCapUsd,
    liquidityUsd: event.liquidityUsd,
    tokenCreatedAtMs: event.tokenCreatedAtMs,
    ourCurrentPositionUsd: 0,
    convictionScore: 0,
    convictionState: "TESTING",
    scoreComponents: [],
    scoreReasons: [],
    rolling: Object.fromEntries(
      CONVICTION_WINDOW_SECONDS.map((window) => [String(window), blankRolling(window)]),
    ),
    convergedWalletCount: 0,
    convergenceWallets: [],
    distributionDetected: false,
    classificationReliable:
      isCountedCapitalType(event.type) && event.classificationReliable === true,
    classificationUpdatedAtMs:
      event.type === "UNKNOWN" || isCountedCapitalType(event.type) ? event.timestampMs : undefined,
    ranks: { "5": blankRank(), "30": blankRank(), "60": blankRank() },
    windowScores: {},
    rapidFollowStatus: "inactive",
    executedTiers: [],
    recentEvents: [],
    processedEventKeys: [],
    cumulativeBuySizesUsd: [],
  };
}

export function convictionEventKey(event: ConvictionEvent): string {
  // This must exactly match the database's durable unique identity. In
  // particular, classification is evidence that may improve from UNKNOWN to a
  // verified swap; it is not a second economic event.
  return event.eventId;
}

function summarizeWindow(
  events: ConvictionEvent[],
  windowSeconds: ConvictionWindowSeconds,
  nowMs: number,
  cumulativeNetInvestmentUsd: number,
): ConvictionRollingMetrics {
  const windowMs = windowSeconds * 1_000;
  const currentStart = nowMs - windowMs;
  const previousStart = nowMs - windowMs * 2;
  const current = events.filter(
    (event) => event.timestampMs > currentStart && event.timestampMs <= nowMs,
  );
  const previous = events.filter(
    (event) => event.timestampMs > previousStart && event.timestampMs <= currentStart,
  );
  const summarize = (rows: ConvictionEvent[]) => {
    // Unverified attribution is retained in the audit trail, but it must never
    // manufacture velocity, convergence, commitment, or distribution capital.
    const buys = rows.filter(
      (event) => event.type === "DEX_BUY" && event.classificationReliable === true,
    );
    const sells = rows.filter(
      (event) => event.type === "DEX_SELL" && event.classificationReliable === true,
    );
    const grossBuysUsd = buys.reduce((sum, event) => sum + finiteNonNegative(event.amountUsd), 0);
    const grossSellsUsd = sells.reduce((sum, event) => sum + finiteNonNegative(event.amountUsd), 0);
    const buySizes = buys.map((event) => finiteNonNegative(event.amountUsd));
    return {
      grossBuysUsd,
      grossSellsUsd,
      netFlowUsd: grossBuysUsd - grossSellsUsd,
      buyCount: buys.length,
      sellCount: sells.length,
      uniqueWalletsBuying: new Set(buys.map((event) => event.wallet)).size,
      uniqueWalletsSelling: new Set(sells.map((event) => event.wallet)).size,
      largestBuyUsd: Math.max(0, ...buySizes),
      averageBuyUsd: buys.length > 0 ? grossBuysUsd / buys.length : 0,
      medianBuyUsd: median(buySizes),
    };
  };
  const cur = summarize(current);
  const prior = summarize(previous);
  const minutes = windowSeconds / 60;
  const velocity = cur.netFlowUsd / minutes;
  const previousVelocity = prior.netFlowUsd / minutes;
  // Ratios are intentionally neutral (1.0x) when there is no prior-period
  // baseline. This prevents a single probe buy from looking infinitely fast.
  const acceleration =
    Math.abs(previousVelocity) >= 1 ? velocity / Math.abs(previousVelocity) : velocity > 0 ? 1 : 0;
  const buySizeAcceleration =
    prior.averageBuyUsd >= 1
      ? cur.averageBuyUsd / prior.averageBuyUsd
      : cur.averageBuyUsd > 0
        ? 1
        : 0;
  const commitmentAtWindowStart = cumulativeNetInvestmentUsd - cur.netFlowUsd;
  const cumulativeCommitmentAcceleration =
    Math.abs(commitmentAtWindowStart) >= 1
      ? cumulativeNetInvestmentUsd / Math.abs(commitmentAtWindowStart)
      : cumulativeNetInvestmentUsd > 0
        ? 1
        : 0;
  const orderedBuys = [...previous, ...current]
    .filter((event) => event.type === "DEX_BUY" && event.classificationReliable === true)
    .sort(
      (left, right) =>
        left.timestampMs - right.timestampMs || left.eventId.localeCompare(right.eventId),
    );
  const latestBuy = orderedBuys.at(-1);
  const precedingBuySizes = orderedBuys
    .slice(0, -1)
    .map((event) => finiteNonNegative(event.amountUsd));
  const precedingAverage =
    precedingBuySizes.length > 0
      ? precedingBuySizes.reduce((sum, value) => sum + value, 0) / precedingBuySizes.length
      : 0;
  // One probe is deliberately neutral. A genuinely increasing sequence becomes
  // measurable before an entire prior leaderboard window exists.
  const latestBuyAcceleration = latestBuy
    ? precedingAverage >= 1
      ? finiteNonNegative(latestBuy.amountUsd) / precedingAverage
      : 1
    : 0;
  const compositeAcceleration = Math.max(
    acceleration,
    buySizeAcceleration,
    cumulativeCommitmentAcceleration,
    latestBuyAcceleration,
  );
  return {
    windowSeconds,
    ...cur,
    capitalVelocityUsdPerMinute: round(velocity),
    previousGrossBuysUsd: round(prior.grossBuysUsd),
    previousGrossSellsUsd: round(prior.grossSellsUsd),
    previousNetFlowUsd: round(prior.netFlowUsd),
    previousCapitalVelocityUsdPerMinute: round(previousVelocity),
    capitalAcceleration: round(acceleration),
    buySizeAcceleration: round(buySizeAcceleration),
    cumulativeCommitmentAcceleration: round(cumulativeCommitmentAcceleration),
    latestBuyAcceleration: round(latestBuyAcceleration),
    accelerationSignal: round(compositeAcceleration),
  };
}

function stateForScore(
  score: number,
  distributing: boolean,
  config: ConvictionConfig,
): ConvictionState {
  if (distributing) return "DISTRIBUTING";
  if (score < config.testingMaxScore) return "TESTING";
  if (score < config.watchingMaxScore) return "WATCHING";
  if (score < config.accumulatingMaxScore) return "ACCUMULATING";
  if (score < config.bettingMaxScore) return "BETTING";
  return "HIGH_CONVICTION";
}

function leaderboardWindowSeconds(
  minutes: ConvictionLeaderboardWindowMinutes,
): ConvictionWindowSeconds {
  return (minutes * 60) as ConvictionWindowSeconds;
}

function normalizedComponent(raw: number, full: number): number {
  return clamp(raw / Math.max(full, 1e-9));
}

function accelerationSignal(metrics: ConvictionRollingMetrics): number {
  return Math.max(
    0,
    metrics.accelerationSignal,
    metrics.capitalAcceleration,
    metrics.buySizeAcceleration,
    metrics.cumulativeCommitmentAcceleration,
    metrics.latestBuyAcceleration,
  );
}

function scoreTokenForWindow(
  token: MutableToken,
  config: ConvictionConfig,
  window: ConvictionLeaderboardWindowMinutes,
  relativeMax: { net: number; velocity: number; acceleration: number },
): ConvictionWindowScore {
  const metrics = token.rolling[String(leaderboardWindowSeconds(window))]!;
  const rank = token.ranks[String(window)] ?? blankRank();
  const weightTotal = Object.values(config.weights).reduce(
    (sum, value) => sum + finiteNonNegative(value),
    0,
  );
  const component = (
    key: keyof ConvictionWeights,
    raw: number,
    full: number,
    reason: string,
  ): ConvictionScoreComponent => {
    const normalized = normalizedComponent(Math.max(0, raw), full);
    return {
      key,
      raw: round(raw),
      normalized: round(normalized),
      points: round((normalized * config.weights[key] * 100) / weightTotal),
      reason,
    };
  };
  const persistenceRaw = rank.timeInTop3Ms + rank.timeAtOneMs + rank.timeInTop10Ms * 0.25;
  const accelerationRaw = accelerationSignal(metrics);
  const accelerationFull = Math.max(
    config.scoreAccelerationFullRatio,
    relativeMax.acceleration,
    1.000001,
  );
  const accelerationNormalized = clamp((accelerationRaw - 1) / (accelerationFull - 1));
  const components: ConvictionScoreComponent[] = [
    component(
      "netCommitment",
      token.netClusterInvestmentUsd,
      Math.max(config.scoreNetCommitmentFullUsd, relativeMax.net),
      `$${round(token.netClusterInvestmentUsd, 2)} cumulative cluster net commitment`,
    ),
    component(
      "capitalVelocity",
      metrics.capitalVelocityUsdPerMinute,
      Math.max(config.scoreVelocityFullUsdPerMinute, relativeMax.velocity),
      `$${round(metrics.capitalVelocityUsdPerMinute, 2)}/min capital velocity`,
    ),
    {
      key: "capitalAcceleration",
      raw: round(accelerationRaw),
      normalized: round(accelerationNormalized),
      points: round(
        (accelerationNormalized * config.weights.capitalAcceleration * 100) / weightTotal,
      ),
      reason:
        `${round(metrics.capitalAcceleration, 2)}x flow, ` +
        `${round(metrics.buySizeAcceleration, 2)}x window buy size, ` +
        `${round(metrics.cumulativeCommitmentAcceleration, 2)}x cumulative commitment, and ` +
        `${round(metrics.latestBuyAcceleration, 2)}x latest-buy progression`,
    },
    component(
      "walletConvergence",
      token.convergedWalletCount,
      Math.max(1, config.requiredClusterWalletCount),
      `${token.convergedWalletCount}/${Math.max(config.requiredClusterWalletCount, 1)} cluster wallets converged`,
    ),
    component(
      "rankPersistence",
      persistenceRaw,
      config.scoreRankPersistenceFullMs,
      `${Math.round(rank.timeInTop3Ms / 1_000)}s Top 3 persistence`,
    ),
  ];
  const sellRatio =
    metrics.grossSellsUsd / Math.max(metrics.grossBuysUsd, metrics.grossSellsUsd, 1);
  const distributionNormalized = clamp(sellRatio / Math.max(config.distributionSellRatio, 0.01));
  const distributionPenalty: ConvictionScoreComponent = {
    key: "distributionPenalty",
    raw: round(sellRatio),
    normalized: round(distributionNormalized),
    points: round(-20 * distributionNormalized),
    reason: `${round(sellRatio * 100, 1)}% recent sell pressure`,
  };
  components.push(distributionPenalty);
  const score = round(
    clamp(
      components.reduce((sum, row) => sum + row.points, 0),
      0,
      100,
    ),
    2,
  );
  const reasons = components
    .filter((row) => Math.abs(row.points) >= 0.5)
    .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
    .map((row) => `${row.points >= 0 ? "+" : "-"}${Math.abs(round(row.points, 1))}: ${row.reason}`);
  const distributing =
    metrics.grossSellsUsd >= config.distributionMinSellsUsd &&
    (sellRatio >= config.distributionSellRatio ||
      metrics.uniqueWalletsSelling >= config.distributionWalletCount ||
      metrics.netFlowUsd < 0);
  return {
    score,
    state: stateForScore(score, distributing, config),
    components,
    reasons,
  };
}

function updateRankDuration(
  token: MutableToken,
  window: ConvictionLeaderboardWindowMinutes,
  nowMs: number,
  config: ConvictionConfig,
) {
  const rank = token.ranks[String(window)] ?? blankRank();
  if (rank.lastRankedAtMs !== undefined && nowMs > rank.lastRankedAtMs) {
    const activeUntil = Math.min(nowMs, token.lastActivityAtMs + config.dataFreshnessMs);
    const elapsed = Math.max(0, activeUntil - rank.lastRankedAtMs);
    if (rank.currentRank !== undefined && rank.currentRank <= 10) rank.timeInTop10Ms += elapsed;
    if (rank.currentRank !== undefined && rank.currentRank <= 3) rank.timeInTop3Ms += elapsed;
    if (rank.currentRank === 1) rank.timeAtOneMs += elapsed;
  }
  rank.lastRankedAtMs = nowMs;
  token.ranks[String(window)] = rank;
}

function isClusterEvent(event: ConvictionEvent, config: ConvictionConfig): boolean {
  return config.clusterWallets.length === 0 || config.clusterWallets.includes(event.wallet);
}

function isCountedCapitalType(type: ConvictionEventType): boolean {
  return type === "DEX_BUY" || type === "DEX_SELL";
}

function validateEvent(event: ConvictionEvent): void {
  if (!event.eventId.trim()) throw new Error("conviction eventId is required");
  if (!event.wallet.trim()) throw new Error("conviction event wallet is required");
  if (!event.tokenMint.trim()) throw new Error("conviction event tokenMint is required");
  if (!Number.isFinite(event.timestampMs) || event.timestampMs <= 0) {
    throw new Error("conviction event timestampMs must be positive and finite");
  }
  if (!Number.isFinite(event.amountUsd) || event.amountUsd < 0) {
    throw new Error("conviction event amountUsd must be non-negative and finite");
  }
}

export function evaluateConvictionEntry(
  snapshot: ConvictionTokenSnapshot,
  configInput: ConvictionConfig | Partial<ConvictionConfig> = DEFAULT_CONVICTION_CONFIG,
  context: ConvictionEntryContext = {},
): ConvictionEntryDecision {
  const config = mergeConfig(configInput);
  const nowMs = context.nowMs ?? snapshot.lastActivityAtMs;
  const rank =
    context.rank ?? snapshot.ranks[String(config.primaryLeaderboardWindowMinutes)]?.currentRank;
  const rolling =
    snapshot.rolling[String(leaderboardWindowSeconds(config.primaryLeaderboardWindowMinutes))] ??
    blankRolling(leaderboardWindowSeconds(config.primaryLeaderboardWindowMinutes));
  const failed: string[] = [];
  if (!config.enabled) failed.push("Conviction Mode is disabled");
  if (config.clusterWallets.length < config.requiredClusterWalletCount) {
    failed.push(
      `only ${config.clusterWallets.length}/${config.requiredClusterWalletCount} cluster wallets configured`,
    );
  }
  const inTopN = rank !== undefined && rank <= Math.max(1, config.entryTopN);
  const rankGraceActive =
    snapshot.executedTiers.length > 0 &&
    snapshot.rankLostAtMs !== undefined &&
    nowMs >= snapshot.rankLostAtMs &&
    nowMs - snapshot.rankLostAtMs <= config.rankLossGraceMs;
  if (!inTopN && !rankGraceActive) failed.push(`not in Top ${config.entryTopN}`);
  if (snapshot.netClusterInvestmentUsd < config.minNetCommitmentUsd) {
    failed.push(`net commitment below $${config.minNetCommitmentUsd}`);
  }
  if (rolling.netFlowUsd < config.minRecentNetInflowUsd)
    failed.push("recent net inflow is insufficient");
  if (rolling.capitalVelocityUsdPerMinute < config.minCapitalVelocityUsdPerMinute) {
    failed.push("capital velocity is below threshold");
  }
  if (accelerationSignal(rolling) < config.minCapitalAcceleration) {
    failed.push("capital acceleration is below threshold");
  }
  if (snapshot.convictionScore < config.minScore) failed.push(`score below ${config.minScore}`);
  if (snapshot.distributionDetected || snapshot.convictionState === "DISTRIBUTING") {
    failed.push("meaningful distribution detected");
  }
  if (snapshot.convergedWalletCount < config.minConvergedWallets) {
    failed.push("wallet convergence is below threshold");
  }
  if (snapshot.largestBuyUsd < config.minIndividualBuyUsd)
    failed.push("largest MM buy is below threshold");
  if (nowMs - snapshot.lastActivityAtMs > config.dataFreshnessMs)
    failed.push("conviction data is stale");
  if (
    snapshot.lastClusterBuyAtMs === undefined ||
    nowMs - snapshot.lastClusterBuyAtMs > config.dataFreshnessMs
  ) {
    failed.push("target-wallet buying is inactive");
  }
  if (!snapshot.classificationReliable) failed.push("transaction classification is unreliable");
  if (config.marketCapMinUsd !== null && (snapshot.marketCapUsd ?? -1) < config.marketCapMinUsd) {
    failed.push("market cap is below configured minimum or unavailable");
  }
  if (
    config.marketCapMaxUsd !== null &&
    (snapshot.marketCapUsd ?? Number.POSITIVE_INFINITY) > config.marketCapMaxUsd
  ) {
    failed.push("market cap is above configured maximum or unavailable");
  }
  if (config.liquidityMinUsd !== null && (snapshot.liquidityUsd ?? -1) < config.liquidityMinUsd) {
    failed.push("liquidity is below configured minimum or unavailable");
  }
  if (
    config.liquidityMaxUsd !== null &&
    (snapshot.liquidityUsd ?? Number.POSITIVE_INFINITY) > config.liquidityMaxUsd
  ) {
    failed.push("liquidity is above configured maximum or unavailable");
  }
  const tokenAgeMinutes =
    snapshot.tokenCreatedAtMs === undefined
      ? undefined
      : Math.max(0, (nowMs - snapshot.tokenCreatedAtMs) / 60_000);
  if (config.tokenAgeMinMinutes !== null && (tokenAgeMinutes ?? -1) < config.tokenAgeMinMinutes) {
    failed.push("token age is below configured minimum or unavailable");
  }
  if (
    config.tokenAgeMaxMinutes !== null &&
    (tokenAgeMinutes ?? Number.POSITIVE_INFINITY) > config.tokenAgeMaxMinutes
  ) {
    failed.push("token age is above configured maximum or unavailable");
  }
  const requested = finiteNonNegative(context.requestedBuyUsd);
  if (snapshot.ourCurrentPositionUsd + requested > config.maxPositionPerTokenUsd + 1e-9) {
    failed.push("max position per token would be exceeded");
  }
  const eligible = failed.length === 0;
  return {
    eligible,
    hypothetical: eligible && config.tradingMode === "shadow",
    // Eligibility intentionally remains observable in shadow mode while the
    // global Entries switch is off. A live submission, however, requires an
    // explicit true value; undefined is never treated as authorization.
    authorizedToSubmit:
      eligible &&
      config.enabled &&
      config.tradingMode === "live" &&
      context.globalEntriesEnabled === true,
    mode: config.tradingMode,
    reasons: eligible ? snapshot.scoreReasons : [],
    failedGates: failed,
  };
}

export function nextConvictionTier(
  snapshot: ConvictionTokenSnapshot,
  configInput: ConvictionConfig | Partial<ConvictionConfig> = DEFAULT_CONVICTION_CONFIG,
  context: ConvictionEntryContext = {},
): ConvictionTierDecision {
  const config = mergeConfig(configInput);
  const executed = new Map(snapshot.executedTiers.map((tier) => [tier.tierId, tier]));
  const remaining = Math.max(0, config.maxPositionPerTokenUsd - snapshot.ourCurrentPositionUsd);
  const ordered = config.tiers;
  const next = ordered.find((tier) => !executed.has(tier.id));
  if (!next) {
    return {
      eligible: false,
      amountUsd: 0,
      remainingExposureUsd: remaining,
      authorizedToSubmit: false,
      reason: "all tiers already executed",
    };
  }
  const priorIndex = ordered.findIndex((tier) => tier.id === next.id) - 1;
  const priorExecution = priorIndex >= 0 ? executed.get(ordered[priorIndex]!.id) : undefined;
  if (priorIndex >= 0 && !priorExecution) {
    return {
      eligible: false,
      tier: next,
      amountUsd: 0,
      remainingExposureUsd: remaining,
      authorizedToSubmit: false,
      reason: "prior tier has not executed",
    };
  }
  const primary =
    snapshot.rolling[String(leaderboardWindowSeconds(config.primaryLeaderboardWindowMinutes))]!;
  const commitmentBase = priorExecution?.netCommitmentUsd ?? 0;
  const requiredCommitment = Math.max(
    next.minNetCommitmentUsd,
    commitmentBase * (1 + Math.max(0, next.minCommitmentIncreaseRatio)),
  );
  const amountUsd = Math.min(finiteNonNegative(next.buyUsd), remaining);
  let reason = "tier qualifies";
  if (!config.rapidFollowEnabled && priorIndex >= 0) reason = "Rapid Follow is disabled";
  else if (snapshot.convictionScore < next.minScore) reason = "tier score threshold not met";
  else if (snapshot.netClusterInvestmentUsd < requiredCommitment)
    reason = "tier commitment threshold not met";
  else if (primary.capitalVelocityUsdPerMinute < next.minVelocityUsdPerMinute)
    reason = "tier velocity threshold not met";
  else if (amountUsd <= 0) reason = "max exposure reached";
  const baseEntry = evaluateConvictionEntry(snapshot, config, {
    ...context,
    requestedBuyUsd: amountUsd,
  });
  const eligible = reason === "tier qualifies" && baseEntry.eligible;
  if (!eligible && reason === "tier qualifies")
    reason = baseEntry.failedGates[0] ?? "entry gate failed";
  return {
    eligible,
    tier: next,
    amountUsd: eligible ? amountUsd : 0,
    remainingExposureUsd: remaining,
    authorizedToSubmit: eligible && baseEntry.authorizedToSubmit,
    reason,
  };
}

export class ConvictionEngine {
  readonly config: ConvictionConfig;
  private readonly tokens = new Map<string, MutableToken>();
  private readonly eventOwners = new Map<string, string>();
  private clockMs = 0;

  constructor(
    config: Partial<ConvictionConfig> = {},
    snapshots: ConvictionTokenSnapshot[] = [],
    events: ConvictionEvent[] = [],
  ) {
    this.config = mergeConfig(config);
    this.hydrate({ snapshots, events });
  }

  process(eventInput: ConvictionEvent): ConvictionEngineUpdate {
    const event = clone(eventInput);
    validateEvent(event);
    const eventKey = convictionEventKey(event);
    const priorOwner = this.eventOwners.get(eventKey);
    if (priorOwner) {
      this.recomputeAll(Math.max(this.clockMs, event.timestampMs));
      const snapshot = this.snapshot(priorOwner);
      if (!snapshot) throw new Error(`conviction event owner disappeared: ${priorOwner}`);
      const rank = snapshot.ranks[String(this.config.primaryLeaderboardWindowMinutes)]?.currentRank;
      const entry = evaluateConvictionEntry(snapshot, this.config, { nowMs: this.clockMs, rank });
      return {
        duplicate: true,
        countedTowardCapital: false,
        eventKey,
        timestampMs: this.clockMs,
        snapshot,
        transitions: [],
        breakouts: [],
        entry,
        nextTier: nextConvictionTier(snapshot, this.config, { nowMs: this.clockMs, rank }),
      };
    }
    let token = this.tokens.get(event.tokenMint);
    if (!token) {
      token = blankSnapshot(event);
      this.tokens.set(event.tokenMint, token);
    }
    if (token.processedEventKeys.includes(eventKey)) {
      this.eventOwners.set(eventKey, token.mint);
      this.recomputeAll(Math.max(this.clockMs, event.timestampMs));
      const snapshot = this.snapshot(event.tokenMint)!;
      const rank = snapshot.ranks[String(this.config.primaryLeaderboardWindowMinutes)]?.currentRank;
      const entry = evaluateConvictionEntry(snapshot, this.config, { nowMs: this.clockMs, rank });
      return {
        duplicate: true,
        countedTowardCapital: false,
        eventKey,
        timestampMs: this.clockMs,
        snapshot,
        transitions: [],
        breakouts: [],
        entry,
        nextTier: nextConvictionTier(snapshot, this.config, { nowMs: this.clockMs, rank }),
      };
    }

    const priorStates = new Map(
      Array.from(this.tokens.entries()).map(([mint, value]) => [
        mint,
        { state: value.convictionState, score: value.convictionScore },
      ]),
    );
    const clusterRelevant = isClusterEvent(event, this.config);
    token.processedEventKeys.push(eventKey);
    this.eventOwners.set(eventKey, token.mint);
    token.firstSeenAtMs = Math.min(token.firstSeenAtMs, event.timestampMs);
    if (clusterRelevant) {
      token.lastActivityAtMs = Math.max(token.lastActivityAtMs, event.timestampMs);
    }
    token.symbol = event.symbol ?? token.symbol;
    token.marketCapUsd = event.marketCapUsd ?? token.marketCapUsd;
    token.liquidityUsd = event.liquidityUsd ?? token.liquidityUsd;
    token.tokenCreatedAtMs = event.tokenCreatedAtMs ?? token.tokenCreatedAtMs;
    // An ambiguous observation blocks automatic action until the next verified
    // swap, but it does not poison the token forever. Non-capital transfers do
    // not change the reliability of the latest actionable classification.
    if (
      (event.type === "UNKNOWN" || isCountedCapitalType(event.type)) &&
      clusterRelevant &&
      event.timestampMs >= (token.classificationUpdatedAtMs ?? 0)
    ) {
      token.classificationReliable =
        isCountedCapitalType(event.type) && event.classificationReliable === true;
      token.classificationUpdatedAtMs = event.timestampMs;
    }
    if (clusterRelevant) token.recentEvents.push(event);

    const countsCapital =
      clusterRelevant && isCountedCapitalType(event.type) && event.classificationReliable === true;
    if (countsCapital) {
      const amountUsd = finiteNonNegative(event.amountUsd);
      const wallet = token.walletStats[event.wallet] ?? {
        wallet: event.wallet,
        grossBuysUsd: 0,
        grossSellsUsd: 0,
        netInvestmentUsd: 0,
        buyCount: 0,
        sellCount: 0,
      };
      if (event.type === "DEX_BUY") {
        token.lastClusterBuyAtMs = Math.max(token.lastClusterBuyAtMs ?? 0, event.timestampMs);
        token.grossClusterBuysUsd += amountUsd;
        token.buyCount += 1;
        token.lastBuyUsd = amountUsd;
        token.largestBuyUsd = Math.max(token.largestBuyUsd, amountUsd);
        token.cumulativeBuySizesUsd.push(amountUsd);
        if (token.marketCapAtFirstClusterBuyUsd === undefined) {
          token.marketCapAtFirstClusterBuyUsd = event.marketCapUsd;
        }
        wallet.grossBuysUsd += amountUsd;
        wallet.buyCount += 1;
        wallet.lastBuyAtMs = Math.max(wallet.lastBuyAtMs ?? 0, event.timestampMs);
      } else {
        token.grossClusterSellsUsd += amountUsd;
        token.sellCount += 1;
        wallet.grossSellsUsd += amountUsd;
        wallet.sellCount += 1;
        wallet.lastSellAtMs = Math.max(wallet.lastSellAtMs ?? 0, event.timestampMs);
      }
      wallet.netInvestmentUsd = wallet.grossBuysUsd - wallet.grossSellsUsd;
      token.walletStats[event.wallet] = wallet;
    }
    token.grossClusterBuysUsd = round(token.grossClusterBuysUsd);
    token.grossClusterSellsUsd = round(token.grossClusterSellsUsd);
    token.netClusterInvestmentUsd = round(token.grossClusterBuysUsd - token.grossClusterSellsUsd);
    token.averageBuyUsd =
      token.buyCount > 0 ? round(token.grossClusterBuysUsd / token.buyCount) : 0;
    token.medianBuyUsd = round(median(token.cumulativeBuySizesUsd));
    token.walletsThatBought = Object.values(token.walletStats)
      .filter((wallet) => wallet.buyCount > 0)
      .map((wallet) => wallet.wallet)
      .sort();

    this.recomputeAll(Math.max(this.clockMs, event.timestampMs));
    const transitions: ConvictionTransition[] = [];
    const breakouts: ConvictionBreakout[] = [];
    for (const [mint, value] of this.tokens) {
      const prior = priorStates.get(mint) ?? { state: "TESTING" as ConvictionState, score: 0 };
      if (prior.state !== value.convictionState) {
        const transition: ConvictionTransition = {
          mint,
          timestampMs: this.clockMs,
          previousState: prior.state,
          newState: value.convictionState,
          previousScore: prior.score,
          newScore: value.convictionScore,
          reasons: [...value.scoreReasons],
        };
        transitions.push(transition);
        if (
          (prior.state === "TESTING" || prior.state === "WATCHING") &&
          ["ACCUMULATING", "BETTING", "HIGH_CONVICTION"].includes(value.convictionState) &&
          value.convictionScore >= this.config.breakoutMinScore
        ) {
          const primary =
            value.rolling[
              String(leaderboardWindowSeconds(this.config.primaryLeaderboardWindowMinutes))
            ]!;
          breakouts.push({
            kind: "CONVICTION_BREAKOUT",
            mint,
            timestampMs: this.clockMs,
            previousScore: prior.score,
            newScore: value.convictionScore,
            netClusterInvestmentUsd: value.netClusterInvestmentUsd,
            capitalVelocityUsdPerMinute: primary.capitalVelocityUsdPerMinute,
            walletConvergence: value.convergedWalletCount,
            marketCapUsd: value.marketCapUsd,
            liquidityUsd: value.liquidityUsd,
            reasons: [...value.scoreReasons],
          });
        }
      }
    }
    const snapshot = this.snapshot(event.tokenMint)!;
    const rank = snapshot.ranks[String(this.config.primaryLeaderboardWindowMinutes)]?.currentRank;
    const nextTier = nextConvictionTier(snapshot, this.config, { nowMs: this.clockMs, rank });
    const entry = evaluateConvictionEntry(snapshot, this.config, {
      nowMs: this.clockMs,
      rank,
      requestedBuyUsd: nextTier.amountUsd,
    });
    return {
      duplicate: false,
      countedTowardCapital: countsCapital,
      eventKey,
      timestampMs: this.clockMs,
      snapshot,
      transitions,
      breakouts,
      entry,
      nextTier,
    };
  }

  leaderboard(
    windowMinutes: ConvictionLeaderboardWindowMinutes,
    nowMs = this.clockMs || Date.now(),
  ): ConvictionLeaderboardRow[] {
    // `process` has already assigned ranks at the engine clock. Recomputing at
    // the same timestamp would overwrite previousRank/direction before the
    // runtime can persist the transition.
    if (nowMs > this.clockMs) this.recomputeAll(nowMs);
    const seconds = leaderboardWindowSeconds(windowMinutes);
    return Array.from(this.tokens.values())
      .filter((token) => token.ranks[String(windowMinutes)]?.currentRank !== undefined)
      .sort(
        (left, right) =>
          (left.ranks[String(windowMinutes)]?.currentRank ?? Number.MAX_SAFE_INTEGER) -
          (right.ranks[String(windowMinutes)]?.currentRank ?? Number.MAX_SAFE_INTEGER),
      )
      .map((token) => {
        const metrics = token.rolling[String(seconds)]!;
        const rank = token.ranks[String(windowMinutes)]!;
        const windowScore = token.windowScores[String(windowMinutes)] ?? {
          score: token.convictionScore,
          state: token.convictionState,
          components: token.scoreComponents,
          reasons: token.scoreReasons,
        };
        return {
          rank: rank.currentRank!,
          previousRank: rank.previousRank,
          rankDirection: rank.direction,
          windowMinutes,
          mint: token.mint,
          symbol: token.symbol,
          score: windowScore.score,
          state: windowScore.state,
          netClusterInvestmentUsd: token.netClusterInvestmentUsd,
          netFlowUsd: metrics.netFlowUsd,
          capitalVelocityUsdPerMinute: metrics.capitalVelocityUsdPerMinute,
          capitalAcceleration: accelerationSignal(metrics),
          buySizeAcceleration: metrics.buySizeAcceleration,
          convergedWalletCount: token.convergedWalletCount,
          largestBuyUsd: token.largestBuyUsd,
          marketCapUsd: token.marketCapUsd,
          liquidityUsd: token.liquidityUsd,
          ourCurrentPositionUsd: token.ourCurrentPositionUsd,
          timeInTop10Ms: rank.timeInTop10Ms,
          timeInTop3Ms: rank.timeInTop3Ms,
          timeAtOneMs: rank.timeAtOneMs,
          scoreReasons: [...windowScore.reasons],
        };
      });
  }

  snapshot(mint: string): ConvictionTokenSnapshot | undefined {
    const token = this.tokens.get(mint);
    return token ? clone(token) : undefined;
  }

  snapshots(): ConvictionTokenSnapshot[] {
    return Array.from(this.tokens.values())
      .sort((left, right) => left.mint.localeCompare(right.mint))
      .map((token) => clone(token));
  }

  hydrate(
    input:
      | { snapshots?: ConvictionTokenSnapshot[]; events?: ConvictionEvent[] }
      | ConvictionEvent[]
      | ConvictionTokenSnapshot[],
  ): void {
    const arrayInput = Array.isArray(input) ? input : undefined;
    const looksLikeEvents = arrayInput?.every((row) => "eventId" in row) ?? false;
    const snapshots = arrayInput
      ? looksLikeEvents
        ? []
        : (arrayInput as ConvictionTokenSnapshot[])
      : ((input as { snapshots?: ConvictionTokenSnapshot[] }).snapshots ?? []);
    const events = arrayInput
      ? looksLikeEvents
        ? (arrayInput as ConvictionEvent[])
        : []
      : ((input as { events?: ConvictionEvent[] }).events ?? []);
    for (const snapshot of snapshots) {
      const restored = clone(snapshot);
      restored.ranks = {
        "5": { ...blankRank(), ...(restored.ranks?.["5"] ?? {}) },
        "30": { ...blankRank(), ...(restored.ranks?.["30"] ?? {}) },
        "60": { ...blankRank(), ...(restored.ranks?.["60"] ?? {}) },
      };
      restored.windowScores ??= {};
      restored.executedTiers ??= [];
      restored.rapidFollowStatus ??= "inactive";
      restored.recentEvents ??= [];
      restored.processedEventKeys ??= restored.recentEvents.map(convictionEventKey);
      restored.cumulativeBuySizesUsd ??= [];
      restored.classificationUpdatedAtMs ??= restored.lastActivityAtMs;
      restored.lastClusterBuyAtMs ??=
        Math.max(
          0,
          ...Object.values(restored.walletStats ?? {}).map((wallet) => wallet.lastBuyAtMs ?? 0),
        ) || undefined;
      this.tokens.set(restored.mint, restored);
      for (const eventKey of restored.processedEventKeys) {
        this.eventOwners.set(eventKey, restored.mint);
      }
      this.clockMs = Math.max(this.clockMs, restored.lastActivityAtMs);
    }
    for (const event of [...events].sort(
      (left, right) =>
        left.timestampMs - right.timestampMs ||
        convictionEventKey(left).localeCompare(convictionEventKey(right)),
    )) {
      this.process(event);
    }
    if (this.clockMs > 0) this.recomputeAll(this.clockMs);
  }

  setPositionUsd(mint: string, amountUsd: number): void {
    const token = this.tokens.get(mint);
    if (!token) throw new Error(`unknown conviction token: ${mint}`);
    token.ourCurrentPositionUsd = finiteNonNegative(amountUsd);
  }

  recordTierExecution(
    mint: string,
    tierId: string,
    options: {
      executedAtMs?: number;
      amountUsd?: number;
      mode?: ConvictionTradingMode;
      reference?: string;
      netCommitmentUsd?: number;
      /** Existing durable executions may exceed a newly lowered cap. */
      historical?: boolean;
    } = {},
  ): ConvictionTierExecution {
    const token = this.tokens.get(mint);
    if (!token) throw new Error(`unknown conviction token: ${mint}`);
    const tier = this.config.tiers.find((candidate) => candidate.id === tierId);
    if (!tier) throw new Error(`unknown conviction tier: ${tierId}`);
    const existing = token.executedTiers.find((candidate) => candidate.tierId === tierId);
    if (existing) return clone(existing);
    const remaining = Math.max(0, this.config.maxPositionPerTokenUsd - token.ourCurrentPositionUsd);
    const requestedAmountUsd = finiteNonNegative(options.amountUsd ?? tier.buyUsd);
    const amountUsd = options.historical
      ? requestedAmountUsd
      : Math.min(requestedAmountUsd, remaining);
    if (amountUsd <= 0) throw new Error("conviction tier would exceed max position exposure");
    const execution: ConvictionTierExecution = {
      tierId,
      executedAtMs: options.executedAtMs ?? this.clockMs,
      mode: options.mode ?? this.config.tradingMode,
      amountUsd,
      netCommitmentUsd: finiteNonNegative(options.netCommitmentUsd, token.netClusterInvestmentUsd),
      reference: options.reference,
    };
    token.executedTiers.push(execution);
    token.ourCurrentPositionUsd = round(token.ourCurrentPositionUsd + amountUsd);
    token.rapidFollowStatus = !this.config.rapidFollowEnabled
      ? "inactive"
      : token.ourCurrentPositionUsd >= this.config.maxPositionPerTokenUsd - 1e-9
        ? "stopped"
        : "active";
    return clone(execution);
  }

  /** Release a claim only when execution definitely failed before submission. */
  releaseTierExecution(mint: string, tierId: string): boolean {
    const token = this.tokens.get(mint);
    if (!token) throw new Error(`unknown conviction token: ${mint}`);
    const index = token.executedTiers.findIndex((candidate) => candidate.tierId === tierId);
    if (index < 0) return false;
    const [execution] = token.executedTiers.splice(index, 1);
    token.ourCurrentPositionUsd = round(
      Math.max(0, token.ourCurrentPositionUsd - (execution?.amountUsd ?? 0)),
    );
    if (token.executedTiers.length === 0) token.rapidFollowStatus = "inactive";
    return true;
  }

  private recomputeAll(nowMs: number): void {
    this.clockMs = Math.max(this.clockMs, nowMs);
    const retentionMs = Math.max(...CONVICTION_WINDOW_SECONDS) * 2 * 1_000;
    for (const token of this.tokens.values()) {
      token.recentEvents = token.recentEvents.filter(
        (event) => this.clockMs - event.timestampMs <= retentionMs,
      );
      for (const window of CONVICTION_WINDOW_SECONDS) {
        token.rolling[String(window)] = summarizeWindow(
          token.recentEvents,
          window,
          this.clockMs,
          token.netClusterInvestmentUsd,
        );
      }
      const fiveMinute = token.rolling["300"]!;
      token.walletsCurrentlyAccumulating = Object.values(token.walletStats)
        .filter((wallet) => {
          const events = token.recentEvents.filter(
            (event) =>
              event.wallet === wallet.wallet && this.clockMs - event.timestampMs <= 300_000,
          );
          const buys = events
            .filter((event) => event.type === "DEX_BUY" && event.classificationReliable === true)
            .reduce((sum, event) => sum + event.amountUsd, 0);
          const sells = events
            .filter((event) => event.type === "DEX_SELL" && event.classificationReliable === true)
            .reduce((sum, event) => sum + event.amountUsd, 0);
          return buys > sells;
        })
        .map((wallet) => wallet.wallet)
        .sort();
      const latestBuyAt = Object.values(token.walletStats)
        .filter((wallet) => wallet.lastBuyAtMs !== undefined)
        .map((wallet) => ({ wallet: wallet.wallet, timestampMs: wallet.lastBuyAtMs! }));
      const withinThree = latestBuyAt.filter(
        (row) => this.clockMs - row.timestampMs <= this.config.convergenceThreeWalletWindowMs,
      );
      const withinTwo = latestBuyAt.filter(
        (row) => this.clockMs - row.timestampMs <= this.config.convergenceTwoWalletWindowMs,
      );
      const convergence =
        withinThree.length >= 3
          ? withinThree
          : withinTwo.length >= 2
            ? withinTwo
            : latestBuyAt
                .filter(
                  (row) =>
                    this.clockMs - row.timestampMs <= this.config.convergenceTwoWalletWindowMs,
                )
                .slice(-1);
      token.convergenceWallets = convergence.map((row) => row.wallet).sort();
      token.convergedWalletCount = token.convergenceWallets.length;
      const distribution = token.rolling[String(this.config.distributionWindowSeconds)]!;
      const sellRatio =
        distribution.grossSellsUsd /
        Math.max(distribution.grossBuysUsd, distribution.grossSellsUsd, 1);
      token.distributionDetected =
        distribution.grossSellsUsd >= this.config.distributionMinSellsUsd &&
        (sellRatio >= this.config.distributionSellRatio ||
          distribution.uniqueWalletsSelling >= this.config.distributionWalletCount ||
          distribution.netFlowUsd < 0);
      // Keep this reference live for callers inspecting the common 5m signal.
      void fiveMinute;
      for (const window of [5, 30, 60] as const)
        updateRankDuration(token, window, this.clockMs, this.config);
    }

    const active = Array.from(this.tokens.values()).filter(
      (token) => this.clockMs - token.lastActivityAtMs <= this.config.leaderboardActiveMs,
    );
    for (const window of [5, 30, 60] as const) {
      const seconds = leaderboardWindowSeconds(window);
      const relativeMax = active.reduce(
        (max, token) => {
          const metrics = token.rolling[String(seconds)]!;
          return {
            net: Math.max(max.net, token.netClusterInvestmentUsd),
            velocity: Math.max(max.velocity, metrics.capitalVelocityUsdPerMinute),
            acceleration: Math.max(max.acceleration, accelerationSignal(metrics)),
          };
        },
        { net: 0, velocity: 0, acceleration: 0 },
      );
      for (const token of this.tokens.values()) {
        token.windowScores[String(window)] = scoreTokenForWindow(
          token,
          this.config,
          window,
          relativeMax,
        );
      }
      const ranked = active
        .filter((token) => {
          const metrics = token.rolling[String(seconds)]!;
          return metrics.buyCount + metrics.sellCount > 0;
        })
        .sort((left, right) => {
          const score =
            (right.windowScores[String(window)]?.score ?? 0) -
            (left.windowScores[String(window)]?.score ?? 0);
          if (score !== 0) return score;
          const flow =
            right.rolling[String(seconds)]!.netFlowUsd - left.rolling[String(seconds)]!.netFlowUsd;
          if (flow !== 0) return flow;
          return left.mint.localeCompare(right.mint);
        });
      const ranks = new Map(ranked.map((token, index) => [token.mint, index + 1]));
      for (const token of this.tokens.values()) {
        const rank = token.ranks[String(window)] ?? blankRank();
        const prior = rank.currentRank;
        const current = ranks.get(token.mint);
        if (window === this.config.primaryLeaderboardWindowMinutes) {
          const wasTopN = prior !== undefined && prior <= this.config.entryTopN;
          const isTopN = current !== undefined && current <= this.config.entryTopN;
          if (isTopN) token.rankLostAtMs = undefined;
          else if (wasTopN && token.rankLostAtMs === undefined) token.rankLostAtMs = this.clockMs;
        }
        rank.previousRank = prior;
        rank.currentRank = current;
        rank.direction =
          current === undefined
            ? "out"
            : prior === undefined
              ? "new"
              : current < prior
                ? "up"
                : current > prior
                  ? "down"
                  : "flat";
        rank.lastRankedAtMs = this.clockMs;
        token.ranks[String(window)] = rank;
      }
    }

    for (const token of this.tokens.values()) {
      const primary = token.windowScores[String(this.config.primaryLeaderboardWindowMinutes)];
      if (!primary) continue;
      token.convictionScore = primary.score;
      token.convictionState = primary.state;
      token.scoreComponents = clone(primary.components);
      token.scoreReasons = [...primary.reasons];
    }

    for (const token of this.tokens.values()) {
      if (!this.config.rapidFollowEnabled || token.executedTiers.length === 0) {
        token.rapidFollowStatus = "inactive";
        continue;
      }
      const primary =
        token.rolling[
          String(leaderboardWindowSeconds(this.config.primaryLeaderboardWindowMinutes))
        ]!;
      const rank = token.ranks[String(this.config.primaryLeaderboardWindowMinutes)]?.currentRank;
      const rankGraceActive =
        token.rankLostAtMs !== undefined &&
        this.clockMs - token.rankLostAtMs <= this.config.rankLossGraceMs;
      const rankLost = !(rank !== undefined && rank <= this.config.entryTopN) && !rankGraceActive;
      const liquidityInvalid =
        (this.config.liquidityMinUsd !== null &&
          (token.liquidityUsd ?? -1) < this.config.liquidityMinUsd) ||
        (this.config.liquidityMaxUsd !== null &&
          (token.liquidityUsd ?? Number.POSITIVE_INFINITY) > this.config.liquidityMaxUsd);
      const stop =
        token.distributionDetected ||
        primary.capitalVelocityUsdPerMinute < this.config.minCapitalVelocityUsdPerMinute ||
        token.convictionScore < this.config.minScore ||
        this.clockMs - token.lastActivityAtMs > this.config.dataFreshnessMs ||
        token.lastClusterBuyAtMs === undefined ||
        this.clockMs - token.lastClusterBuyAtMs > this.config.dataFreshnessMs ||
        token.ourCurrentPositionUsd >= this.config.maxPositionPerTokenUsd - 1e-9 ||
        !token.classificationReliable ||
        liquidityInvalid ||
        rankLost;
      token.rapidFollowStatus = stop ? "stopped" : "active";
    }
  }
}

export function replayConvictionEvents(
  events: ConvictionEvent[],
  config: Partial<ConvictionConfig> = {},
  snapshots: ConvictionTokenSnapshot[] = [],
): { engine: ConvictionEngine; updates: ConvictionEngineUpdate[] } {
  const engine = new ConvictionEngine(config, snapshots);
  const updates = [...events]
    .sort(
      (left, right) =>
        left.timestampMs - right.timestampMs ||
        convictionEventKey(left).localeCompare(convictionEventKey(right)),
    )
    .map((event) => engine.process(event));
  return { engine, updates };
}
