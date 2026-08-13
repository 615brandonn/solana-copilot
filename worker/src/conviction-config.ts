import type { BotConfigRow } from "./db.js";
import type { ConvictionConfig, ConvictionTierConfig } from "./conviction-engine.js";

function targets(cfg: BotConfigRow): string[] {
  return Array.from(
    new Set(
      [cfg.target_wallet ?? "", ...(cfg.additional_target_wallets ?? [])]
        .map((wallet) => wallet.trim())
        .filter(Boolean),
    ),
  );
}

function finite(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function convictionConfigFromBotConfig(cfg: BotConfigRow): Partial<ConvictionConfig> {
  const clusterWallets = targets(cfg);
  const commitments = (cfg.conviction_tier_commitment_thresholds_usd ?? []).map(Number);
  const buys = (cfg.conviction_tier_buy_amounts_usd ?? []).map(Number);
  const globalScore = finite(cfg.conviction_score_threshold, 70);
  const globalVelocity = finite(cfg.conviction_min_velocity_usd_per_minute, 250);
  const tiers: ConvictionTierConfig[] = commitments.slice(0, 4).map((commitment, index) => ({
    id: `tier_${index + 1}`,
    buyUsd: Math.max(0, finite(buys[index], 0)),
    minScore: globalScore,
    minNetCommitmentUsd: Math.max(0, finite(commitment, 0)),
    minVelocityUsdPerMinute: globalVelocity,
    minCommitmentIncreaseRatio: 0,
  }));
  const marketCapEnabled = cfg.conviction_market_cap_filter_enabled === true;
  const liquidityEnabled = cfg.conviction_liquidity_filter_enabled === true;
  const ageEnabled = cfg.conviction_token_age_filter_enabled === true;
  const lastCommitment = Math.max(
    finite(cfg.conviction_min_commitment_usd, 1_000),
    ...commitments.map((value) => finite(value, 0)),
  );

  return {
    // Conviction is explicitly a three-wallet cluster. A malformed external
    // config fails closed instead of allowing an oversized cluster to exceed
    // the persisted 0..3 convergence contract.
    enabled: cfg.conviction_mode_enabled === true && clusterWallets.length === 3,
    tradingMode: cfg.conviction_trading_mode === "live" ? "live" : "shadow",
    rapidFollowEnabled: cfg.conviction_rapid_follow_enabled === true,
    clusterWallets: clusterWallets.slice(0, 3),
    requiredClusterWalletCount: 3,
    primaryLeaderboardWindowMinutes:
      cfg.conviction_primary_window_minutes === 5 || cfg.conviction_primary_window_minutes === 60
        ? cfg.conviction_primary_window_minutes
        : 30,
    entryTopN: Math.max(1, Math.min(10, Math.round(finite(cfg.conviction_top_n, 3)))),
    minScore: globalScore,
    minNetCommitmentUsd: Math.max(0, finite(cfg.conviction_min_commitment_usd, 1_000)),
    minRecentNetInflowUsd: Math.max(0, finite(cfg.conviction_min_recent_net_inflow_usd, 0.01)),
    minCapitalVelocityUsdPerMinute: Math.max(0, globalVelocity),
    minCapitalAcceleration: Math.max(0, finite(cfg.conviction_min_acceleration_ratio, 1.25)),
    minConvergedWallets: Math.max(
      1,
      Math.min(3, Math.round(finite(cfg.conviction_min_converged_wallets, 1))),
    ),
    minIndividualBuyUsd: Math.max(0, finite(cfg.conviction_min_individual_buy_usd, 0)),
    marketCapMinUsd: marketCapEnabled
      ? Math.max(0, finite(cfg.conviction_market_cap_min_usd, 0))
      : null,
    marketCapMaxUsd: marketCapEnabled
      ? Math.max(0, finite(cfg.conviction_market_cap_max_usd, 1_000_000_000))
      : null,
    liquidityMinUsd: liquidityEnabled
      ? Math.max(0, finite(cfg.conviction_liquidity_min_usd, 0))
      : null,
    liquidityMaxUsd: liquidityEnabled
      ? Math.max(0, finite(cfg.conviction_liquidity_max_usd, 1_000_000_000))
      : null,
    tokenAgeMinMinutes: ageEnabled
      ? Math.max(0, finite(cfg.conviction_token_age_min_minutes, 0))
      : null,
    tokenAgeMaxMinutes: ageEnabled
      ? Math.max(0, finite(cfg.conviction_token_age_max_minutes, 525_600))
      : null,
    maxPositionPerTokenUsd: Math.max(0.01, finite(cfg.conviction_max_position_per_token_usd, 25)),
    rankLossGraceMs: Math.max(0, finite(cfg.conviction_rank_loss_grace_seconds, 120)) * 1_000,
    dataFreshnessMs: Math.max(1, finite(cfg.conviction_inactivity_minutes, 15)) * 60_000,
    convergenceTwoWalletWindowMs:
      Math.max(1, finite(cfg.conviction_two_wallet_window_seconds, 120)) * 1_000,
    convergenceThreeWalletWindowMs:
      Math.max(1, finite(cfg.conviction_three_wallet_window_seconds, 300)) * 1_000,
    distributionWindowSeconds: 300,
    distributionSellRatio: Math.max(
      0,
      Math.min(1, finite(cfg.conviction_distribution_sell_ratio, 0.2)),
    ),
    distributionMinSellsUsd: Math.max(0, finite(cfg.conviction_distribution_min_sells_usd, 100)),
    distributionWalletCount: Math.max(
      1,
      Math.min(3, Math.round(finite(cfg.conviction_distribution_wallet_count, 2))),
    ),
    weights: {
      netCommitment: finite(cfg.conviction_weight_net_commitment, 30),
      capitalVelocity: finite(cfg.conviction_weight_velocity, 25),
      capitalAcceleration: finite(cfg.conviction_weight_acceleration, 20),
      walletConvergence: finite(cfg.conviction_weight_convergence, 15),
      rankPersistence: finite(cfg.conviction_weight_persistence, 10),
    },
    scoreNetCommitmentFullUsd: Math.max(1, lastCommitment),
    scoreVelocityFullUsdPerMinute: Math.max(1, globalVelocity * 4),
    scoreAccelerationFullRatio: Math.max(
      1.01,
      finite(cfg.conviction_min_acceleration_ratio, 1.25) * 2,
    ),
    tiers,
  };
}
