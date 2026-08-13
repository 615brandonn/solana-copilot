import assert from "node:assert/strict";
import test from "node:test";
import type { BotConfigRow } from "./db.js";
import { convictionConfigFromBotConfig } from "./conviction-config.js";

const config = {
  target_wallet: "a",
  additional_target_wallets: ["b", "c"],
  conviction_mode_enabled: false,
  conviction_trading_mode: "shadow",
  conviction_rapid_follow_enabled: false,
  conviction_primary_window_minutes: 30,
  conviction_score_threshold: 70,
  conviction_top_n: 3,
  conviction_min_commitment_usd: 1_000,
  conviction_min_recent_net_inflow_usd: 0.01,
  conviction_min_velocity_usd_per_minute: 250,
  conviction_min_acceleration_ratio: 1.25,
  conviction_min_converged_wallets: 2,
  conviction_two_wallet_window_seconds: 120,
  conviction_three_wallet_window_seconds: 300,
  conviction_min_individual_buy_usd: 0,
  conviction_market_cap_filter_enabled: false,
  conviction_market_cap_min_usd: 10,
  conviction_market_cap_max_usd: 20,
  conviction_liquidity_filter_enabled: false,
  conviction_liquidity_min_usd: 10,
  conviction_liquidity_max_usd: 20,
  conviction_token_age_filter_enabled: false,
  conviction_token_age_min_minutes: 10,
  conviction_token_age_max_minutes: 20,
  conviction_max_position_per_token_usd: 25,
  conviction_distribution_sell_ratio: 0.2,
  conviction_distribution_min_sells_usd: 100,
  conviction_distribution_wallet_count: 2,
  conviction_inactivity_minutes: 15,
  conviction_rank_loss_grace_seconds: 120,
  conviction_weight_net_commitment: 30,
  conviction_weight_velocity: 25,
  conviction_weight_acceleration: 20,
  conviction_weight_convergence: 15,
  conviction_weight_persistence: 10,
  conviction_tier_commitment_thresholds_usd: [1_000, 2_500, 5_000, 10_000],
  conviction_tier_buy_amounts_usd: [5, 5, 5, 10],
} as BotConfigRow;

test("maps safe installation defaults and all three cluster wallets", () => {
  const mapped = convictionConfigFromBotConfig(config);
  assert.equal(mapped.enabled, false);
  assert.equal(mapped.tradingMode, "shadow");
  assert.deepEqual(mapped.clusterWallets, ["a", "b", "c"]);
  assert.equal(mapped.marketCapMinUsd, null);
  assert.equal(mapped.liquidityMaxUsd, null);
  assert.equal(mapped.tokenAgeMaxMinutes, null);
  assert.equal(mapped.distributionMinSellsUsd, 100);
  assert.equal(mapped.distributionWalletCount, 2);
  assert.equal(mapped.minRecentNetInflowUsd, 0.01);
});

test("maps the centralized minimum recent net inflow gate", () => {
  assert.equal(
    convictionConfigFromBotConfig({
      ...config,
      conviction_min_recent_net_inflow_usd: undefined,
    }).minRecentNetInflowUsd,
    0.01,
  );
  assert.equal(
    convictionConfigFromBotConfig({
      ...config,
      conviction_min_recent_net_inflow_usd: 12.5,
    }).minRecentNetInflowUsd,
    12.5,
  );
  assert.equal(
    convictionConfigFromBotConfig({
      ...config,
      conviction_min_recent_net_inflow_usd: -1,
    }).minRecentNetInflowUsd,
    0,
  );
});

test("Tier 1 is the initial entry and all tiers fit the configured exposure cap", () => {
  const mapped = convictionConfigFromBotConfig(config);
  assert.deepEqual(
    mapped.tiers?.map((tier) => tier.buyUsd),
    [5, 5, 5, 10],
  );
  assert.deepEqual(
    mapped.tiers?.map((tier) => tier.minNetCommitmentUsd),
    [1_000, 2_500, 5_000, 10_000],
  );
  assert.equal(mapped.maxPositionPerTokenUsd, 25);
});

test("live authorization remains an explicit two-setting choice", () => {
  const off = convictionConfigFromBotConfig({ ...config, conviction_trading_mode: "live" });
  assert.equal(off.enabled, false);
  assert.equal(off.tradingMode, "live");
  const on = convictionConfigFromBotConfig({
    ...config,
    conviction_mode_enabled: true,
    conviction_trading_mode: "live",
  });
  assert.equal(on.enabled, true);
  assert.equal(on.tradingMode, "live");
});

test("Conviction fails closed unless exactly three unique cluster wallets are configured", () => {
  const tooFew = convictionConfigFromBotConfig({
    ...config,
    conviction_mode_enabled: true,
    additional_target_wallets: ["b"],
  });
  assert.equal(tooFew.enabled, false);
  assert.deepEqual(tooFew.clusterWallets, ["a", "b"]);

  const duplicate = convictionConfigFromBotConfig({
    ...config,
    conviction_mode_enabled: true,
    additional_target_wallets: ["b", "b"],
  });
  assert.equal(duplicate.enabled, false);
  assert.deepEqual(duplicate.clusterWallets, ["a", "b"]);

  const tooMany = convictionConfigFromBotConfig({
    ...config,
    conviction_mode_enabled: true,
    additional_target_wallets: ["b", "c", "d"],
  });
  assert.equal(tooMany.enabled, false);
  assert.deepEqual(tooMany.clusterWallets, ["a", "b", "c"]);

  const exact = convictionConfigFromBotConfig({
    ...config,
    conviction_mode_enabled: true,
  });
  assert.equal(exact.enabled, true);
  assert.deepEqual(exact.clusterWallets, ["a", "b", "c"]);
});

test("optional token bounds are disabled by null and mapped exactly when enabled", () => {
  const disabled = convictionConfigFromBotConfig(config);
  assert.equal(disabled.marketCapMinUsd, null);
  assert.equal(disabled.marketCapMaxUsd, null);
  assert.equal(disabled.liquidityMinUsd, null);
  assert.equal(disabled.tokenAgeMinMinutes, null);

  const enabled = convictionConfigFromBotConfig({
    ...config,
    conviction_market_cap_filter_enabled: true,
    conviction_liquidity_filter_enabled: true,
    conviction_token_age_filter_enabled: true,
  });
  assert.equal(enabled.marketCapMinUsd, 10);
  assert.equal(enabled.marketCapMaxUsd, 20);
  assert.equal(enabled.liquidityMinUsd, 10);
  assert.equal(enabled.liquidityMaxUsd, 20);
  assert.equal(enabled.tokenAgeMinMinutes, 10);
  assert.equal(enabled.tokenAgeMaxMinutes, 20);
  assert.equal(enabled.rankLossGraceMs, 120_000);
});
