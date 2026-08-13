export type ConvictionWindowMinutes = 5 | 30 | 60;
export type ConvictionLifecycleSegment = "NEW" | "ACTIVE" | "REVIVAL" | "UNCLASSIFIED";

export type SerializableJson =
  | string
  | number
  | boolean
  | null
  | SerializableJson[]
  | { [key: string]: SerializableJson };

export type ConvictionState =
  | "TESTING"
  | "WATCHING"
  | "ACCUMULATING"
  | "BETTING"
  | "HIGH_CONVICTION"
  | "DISTRIBUTING";

export type ConvictionTokenStateRow = {
  token_mint: string;
  symbol: string | null;
  first_seen_at: string;
  last_activity_at: string;
  gross_cluster_buys_usd: number;
  gross_cluster_sells_usd: number;
  net_cluster_investment_usd: number;
  wallet_net_usd: Record<string, number>;
  buy_count: number;
  sell_count: number;
  largest_buy_usd: number;
  last_buy_usd: number;
  average_buy_usd: number;
  median_buy_usd: number;
  wallets_that_bought: string[];
  wallets_currently_accumulating: string[];
  market_cap_usd: number | null;
  market_cap_at_first_cluster_buy_usd: number | null;
  liquidity_usd: number | null;
  our_current_position_usd: number;
  net_flow_1m_usd: number;
  net_flow_5m_usd: number;
  net_flow_30m_usd: number;
  net_flow_60m_usd: number;
  capital_velocity_usd_per_min: number;
  capital_acceleration_ratio: number;
  buy_size_acceleration_ratio: number;
  wallet_convergence_count: number;
  conviction_score: number;
  conviction_state: ConvictionState;
  score_reasons: string[];
  current_rank: number | null;
  previous_rank: number | null;
  rank_direction: "up" | "down" | "flat" | "new" | "unranked";
  time_in_top_10_seconds: number;
  time_in_top_3_seconds: number;
  time_at_rank_one_seconds: number;
  rapid_follow_status: string;
  data_reliable: boolean;
  last_ranked_at: string | null;
  updated_at: string;
  rolling_metrics: { [key: string]: SerializableJson };
};

export type ConvictionRankRow = {
  token_mint: string;
  window_minutes: ConvictionWindowMinutes;
  rank: number;
  previous_rank: number | null;
  conviction_score: number;
  net_flow_usd: number;
  capital_velocity_usd_per_min: number;
  recorded_at: string;
};

export type ConvictionEventRow = {
  event_key: string;
  tx_sig: string;
  event_at: string;
  actor_wallet: string;
  token_mint: string;
  classification: string;
  side: "buy" | "sell" | null;
  amount_tokens: number;
  amount_usd: number | null;
  market_cap_usd: number | null;
  liquidity_usd: number | null;
  data_reliable: boolean;
  metadata: { [key: string]: SerializableJson };
};

export type ConvictionTransitionRow = {
  token_mint: string;
  event_type: string;
  previous_state: ConvictionState | null;
  new_state: ConvictionState | null;
  previous_score: number | null;
  new_score: number | null;
  reasons: string[];
  occurred_at: string;
  metadata: { [key: string]: SerializableJson };
};

export type ConvictionTierRow = {
  token_mint: string;
  tier_number: number;
  status: string;
  trading_mode: "shadow" | "live";
  amount_usd: number;
  commitment_usd: number;
  source_event_key: string | null;
  bot_tx_sig: string | null;
  executed_at: string | null;
  updated_at: string;
  metadata: { [key: string]: SerializableJson };
};

export type ConvictionDashboardData = {
  windowMinutes: ConvictionWindowMinutes;
  generatedAt: string;
  states: ConvictionTokenStateRow[];
};

export type ConvictionTokenDetailData = {
  state: ConvictionTokenStateRow | null;
  buys: ConvictionEventRow[];
  ranks: ConvictionRankRow[];
  transitions: ConvictionTransitionRow[];
  tiers: ConvictionTierRow[];
};

export type ConvictionBacktestSettings = {
  sinceDays: number;
  rapidFollowEnabled: boolean;
  leaderboardWindowMinutes: ConvictionWindowMinutes;
  scoreThreshold: number;
  topN: number;
  minNetCommitmentUsd: number;
  minRecentNetInflowUsd: number;
  minCapitalVelocityUsdPerMinute: number;
  minCapitalAccelerationRatio: number;
  minConvergedWallets: number;
  twoWalletWindowSeconds: number;
  threeWalletWindowSeconds: number;
  minIndividualBuyUsd: number;
  marketCapFilterEnabled: boolean;
  marketCapMinUsd: number;
  marketCapMaxUsd: number;
  liquidityFilterEnabled: boolean;
  liquidityMinUsd: number;
  liquidityMaxUsd: number;
  tokenAgeFilterEnabled: boolean;
  tokenAgeMinMinutes: number;
  tokenAgeMaxMinutes: number;
  maxPositionPerTokenUsd: number;
  dataFreshnessSeconds: number;
  rankLossGraceSeconds: number;
  lifecycleNewMinutes: number;
  lifecycleRevivalInactivityMinutes: number;
  distributionSellRatio: number;
  distributionMinSellsUsd: number;
  distributionWalletCount: number;
  tier1BuyUsd: number;
  tier1MinCommitmentUsd: number;
  tier2BuyUsd: number;
  tier2MinCommitmentUsd: number;
  tier3BuyUsd: number;
  tier3MinCommitmentUsd: number;
  tier4BuyUsd: number;
  tier4MinCommitmentUsd: number;
  weightNetCommitment: number;
  weightVelocity: number;
  weightAcceleration: number;
  weightConvergence: number;
  weightPersistence: number;
};

export const DEFAULT_CONVICTION_BACKTEST_SETTINGS: ConvictionBacktestSettings = {
  sinceDays: 30,
  rapidFollowEnabled: false,
  leaderboardWindowMinutes: 30,
  scoreThreshold: 70,
  topN: 3,
  minNetCommitmentUsd: 1_000,
  minRecentNetInflowUsd: 0.01,
  minCapitalVelocityUsdPerMinute: 250,
  minCapitalAccelerationRatio: 1.25,
  minConvergedWallets: 1,
  twoWalletWindowSeconds: 120,
  threeWalletWindowSeconds: 300,
  minIndividualBuyUsd: 0,
  marketCapFilterEnabled: false,
  marketCapMinUsd: 0,
  marketCapMaxUsd: 1_000_000_000,
  liquidityFilterEnabled: false,
  liquidityMinUsd: 0,
  liquidityMaxUsd: 1_000_000_000,
  tokenAgeFilterEnabled: false,
  tokenAgeMinMinutes: 0,
  tokenAgeMaxMinutes: 525_600,
  maxPositionPerTokenUsd: 25,
  dataFreshnessSeconds: 900,
  rankLossGraceSeconds: 120,
  lifecycleNewMinutes: 1_440,
  lifecycleRevivalInactivityMinutes: 1_440,
  distributionSellRatio: 0.2,
  distributionMinSellsUsd: 100,
  distributionWalletCount: 2,
  tier1BuyUsd: 5,
  tier1MinCommitmentUsd: 1_000,
  tier2BuyUsd: 5,
  tier2MinCommitmentUsd: 2_500,
  tier3BuyUsd: 5,
  tier3MinCommitmentUsd: 5_000,
  tier4BuyUsd: 10,
  tier4MinCommitmentUsd: 10_000,
  weightNetCommitment: 30,
  weightVelocity: 25,
  weightAcceleration: 20,
  weightConvergence: 15,
  weightPersistence: 10,
};

export type ConvictionBacktestThresholdMetric = {
  thresholdUsd: 5_000 | 10_000 | 25_000 | 50_000 | 100_000;
  eventualTokenCount: number;
  detectedTokenCount: number;
  detectionRatePct: number | null;
};

export type ConvictionBacktestLifecycleMetric = {
  segment: ConvictionLifecycleSegment;
  observationCount: number;
  uniqueTokenCount: number;
  firstSignalTokenCount: number;
  firstSignalRatePct: number | null;
};

export type ConvictionBacktestResult = {
  generatedAt: string;
  requestedSince: string;
  observedFrom: string | null;
  observedThrough: string | null;
  observationsLoaded: number;
  observationsReplayed: number;
  observationsWithUsd: number;
  observationsProductionEquivalent: number;
  observationsExcludedUnverified: number;
  observationsExcludedUnvalued: number;
  observationsExcludedDelayedValuation: number;
  observationsWithMarketCap: number;
  observationsWithLiquidity: number;
  marketCapSnapshotsExcludedForTiming: number;
  liquiditySnapshotsExcludedForTiming: number;
  uniqueTokens: number;
  signalCount: number;
  signaledTokenCount: number;
  hypotheticalTierCount: number;
  hypotheticalExposureUsd: number;
  capped: boolean;
  cap: number;
  thresholds: ConvictionBacktestThresholdMetric[];
  lifecycleSegments: ConvictionBacktestLifecycleMetric[];
  eventual25kDetectedPct: number | null;
  eventual50kDetectedBefore5kPct: number | null;
  eventual100kDetectedBefore5kPct: number | null;
  medianCommitmentAtFirstSignalUsd: number | null;
  falsePositiveRatePct: number | null;
  probeRejectionRatePct: number | null;
  limitations: string[];
  settings: ConvictionBacktestSettings;
};
