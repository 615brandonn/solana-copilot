import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "./supabase-types";
import { DEFAULT_CONVICTION_CONFIG, type BotConfig } from "./bot-config";
import { normalizeSupabaseUrl } from "./supabase-url";
import { decodeBase58, encodeBase58 } from "./base58";

export type SaveFundingKeyResult =
  | { ok: true }
  | { ok: false; code: "missing_backend_key" | "save_failed"; error: string };

const SINGLE_USER_ID = "00000000-0000-0000-0000-000000000000";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function currentUserId() {
  const userId = process.env.HELIX_USER_ID?.trim();
  // Lovable preview does not always expose optional project variables. This
  // project is intentionally single-user, and its existing Supabase row and
  // VPS worker both use the zero UUID, so a missing value safely resolves to
  // that same row. A nonempty malformed value is still rejected.
  if (!userId) return SINGLE_USER_ID;
  if (!UUID_PATTERN.test(userId)) {
    throw new Error("HELIX_USER_ID must be set to a valid UUID");
  }
  return userId;
}

function serviceRoleKey(): string {
  const key = process.env.SERVER_SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (key.startsWith("sb_publishable_")) {
    throw new Error(
      "SERVER_SUPABASE_SERVICE_ROLE_KEY is the publishable (anon) key. In Supabase, copy the Secret key (service role) instead.",
    );
  }
  if (key.split(".").length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8")) as {
        role?: string;
      };
      if (payload.role && payload.role !== "service_role") {
        throw new Error(
          `SERVER_SUPABASE_SERVICE_ROLE_KEY has JWT role ${payload.role}; expected service_role`,
        );
      }
    } catch (error) {
      if (error instanceof Error && /expected service_role/.test(error.message)) throw error;
    }
  }
  return key;
}

export function adminClient() {
  const serverKey = serviceRoleKey();
  const url = normalizeSupabaseUrl(process.env.SERVER_SUPABASE_URL ?? "");
  if (!url) throw new Error("SERVER_SUPABASE_URL is missing");
  if (!serverKey) throw new Error("SERVER_SUPABASE_SERVICE_ROLE_KEY is missing");
  return createClient<Database>(url, serverKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("apikey", serverKey);
        if (serverKey.startsWith("sb_") && headers.get("Authorization") === `Bearer ${serverKey}`) {
          headers.delete("Authorization");
        }
        return fetch(input, { ...init, headers });
      },
    },
  });
}

export function rowToConfig(row: Database["public"]["Tables"]["bot_config"]["Row"]): BotConfig {
  return {
    enabled: row.enabled,
    targetWallet: row.target_wallet ?? "",
    additionalTargetWallets: row.additional_target_wallets ?? [],
    fundingPrivateKey: "",
    executionRoute: row.execution_route as "jito" | "rpc",
    jitoTipSol: row.jito_tip_sol,
    fixedBuyUsd: row.fixed_buy_usd,
    supplyAccumulationModeEnabled: row.supply_accumulation_mode_enabled ?? false,
    supplyAccumulationThresholdPct: Number(row.supply_accumulation_threshold_pct ?? 10),
    supplyAccumulationBuyUsd: Number(row.supply_accumulation_buy_usd ?? 20),
    supplyAccumulationMinMarketCapUsd: Number(row.supply_accumulation_min_market_cap_usd ?? 2_000),
    supplyAccumulationMaxMarketCapUsd: Number(row.supply_accumulation_max_market_cap_usd ?? 15_000),
    supplyAccumulationWindowSeconds: Number(row.supply_accumulation_window_seconds ?? 600),
    supplyAccumulationScale2Enabled: row.supply_accumulation_scale_2_enabled ?? false,
    supplyAccumulationScale2ThresholdPct: Number(
      row.supply_accumulation_scale_2_threshold_pct ?? 12,
    ),
    supplyAccumulationScale2BuyUsd: Number(row.supply_accumulation_scale_2_buy_usd ?? 10),
    supplyAccumulationScale3Enabled: row.supply_accumulation_scale_3_enabled ?? false,
    supplyAccumulationScale3ThresholdPct: Number(
      row.supply_accumulation_scale_3_threshold_pct ?? 15,
    ),
    supplyAccumulationScale3BuyUsd: Number(row.supply_accumulation_scale_3_buy_usd ?? 10),
    supplyAccumulationScale4Enabled: row.supply_accumulation_scale_4_enabled ?? false,
    supplyAccumulationScale4ThresholdPct: Number(
      row.supply_accumulation_scale_4_threshold_pct ?? 18,
    ),
    supplyAccumulationScale4BuyUsd: Number(row.supply_accumulation_scale_4_buy_usd ?? 10),
    custodyJourneyEnabled: row.custody_journey_enabled ?? false,
    revivalTrackerEnabled: row.revival_tracker_enabled ?? false,
    revivalMarketCapMinUsd: Number(row.revival_market_cap_min_usd ?? 2_000),
    revivalMarketCapMaxUsd: Number(row.revival_market_cap_max_usd ?? 15_000),
    crewExitEnabled: row.crew_exit_enabled ?? false,
    crewExitPct: Number(row.crew_exit_pct ?? 100),
    crewExitMinMints: Number(row.crew_exit_min_mints ?? 4),
    convictionModeEnabled:
      row.conviction_mode_enabled ?? DEFAULT_CONVICTION_CONFIG.convictionModeEnabled,
    convictionTradingMode:
      row.conviction_trading_mode === "live"
        ? "live"
        : DEFAULT_CONVICTION_CONFIG.convictionTradingMode,
    convictionRapidFollowEnabled:
      row.conviction_rapid_follow_enabled ?? DEFAULT_CONVICTION_CONFIG.convictionRapidFollowEnabled,
    convictionPrimaryWindowMinutes:
      row.conviction_primary_window_minutes === 5 || row.conviction_primary_window_minutes === 60
        ? row.conviction_primary_window_minutes
        : DEFAULT_CONVICTION_CONFIG.convictionPrimaryWindowMinutes,
    convictionScoreThreshold:
      row.conviction_score_threshold ?? DEFAULT_CONVICTION_CONFIG.convictionScoreThreshold,
    convictionTopN: row.conviction_top_n ?? DEFAULT_CONVICTION_CONFIG.convictionTopN,
    convictionMinCommitmentUsd:
      row.conviction_min_commitment_usd ?? DEFAULT_CONVICTION_CONFIG.convictionMinCommitmentUsd,
    convictionMinRecentNetInflowUsd:
      row.conviction_min_recent_net_inflow_usd ??
      DEFAULT_CONVICTION_CONFIG.convictionMinRecentNetInflowUsd,
    convictionMinVelocityUsdPerMinute:
      row.conviction_min_velocity_usd_per_minute ??
      DEFAULT_CONVICTION_CONFIG.convictionMinVelocityUsdPerMinute,
    convictionMinAccelerationRatio:
      row.conviction_min_acceleration_ratio ??
      DEFAULT_CONVICTION_CONFIG.convictionMinAccelerationRatio,
    convictionMinConvergedWallets:
      row.conviction_min_converged_wallets ??
      DEFAULT_CONVICTION_CONFIG.convictionMinConvergedWallets,
    convictionTwoWalletWindowSeconds:
      row.conviction_two_wallet_window_seconds ??
      DEFAULT_CONVICTION_CONFIG.convictionTwoWalletWindowSeconds,
    convictionThreeWalletWindowSeconds:
      row.conviction_three_wallet_window_seconds ??
      DEFAULT_CONVICTION_CONFIG.convictionThreeWalletWindowSeconds,
    convictionMinIndividualBuyUsd:
      row.conviction_min_individual_buy_usd ??
      DEFAULT_CONVICTION_CONFIG.convictionMinIndividualBuyUsd,
    convictionMarketCapFilterEnabled:
      row.conviction_market_cap_filter_enabled ??
      DEFAULT_CONVICTION_CONFIG.convictionMarketCapFilterEnabled,
    convictionMarketCapMinUsd:
      row.conviction_market_cap_min_usd ?? DEFAULT_CONVICTION_CONFIG.convictionMarketCapMinUsd,
    convictionMarketCapMaxUsd:
      row.conviction_market_cap_max_usd ?? DEFAULT_CONVICTION_CONFIG.convictionMarketCapMaxUsd,
    convictionLiquidityFilterEnabled:
      row.conviction_liquidity_filter_enabled ??
      DEFAULT_CONVICTION_CONFIG.convictionLiquidityFilterEnabled,
    convictionLiquidityMinUsd:
      row.conviction_liquidity_min_usd ?? DEFAULT_CONVICTION_CONFIG.convictionLiquidityMinUsd,
    convictionLiquidityMaxUsd:
      row.conviction_liquidity_max_usd ?? DEFAULT_CONVICTION_CONFIG.convictionLiquidityMaxUsd,
    convictionTokenAgeFilterEnabled:
      row.conviction_token_age_filter_enabled ??
      DEFAULT_CONVICTION_CONFIG.convictionTokenAgeFilterEnabled,
    convictionTokenAgeMinMinutes:
      row.conviction_token_age_min_minutes ??
      DEFAULT_CONVICTION_CONFIG.convictionTokenAgeMinMinutes,
    convictionTokenAgeMaxMinutes:
      row.conviction_token_age_max_minutes ??
      DEFAULT_CONVICTION_CONFIG.convictionTokenAgeMaxMinutes,
    convictionMaxPositionPerTokenUsd:
      row.conviction_max_position_per_token_usd ??
      DEFAULT_CONVICTION_CONFIG.convictionMaxPositionPerTokenUsd,
    convictionDistributionSellRatio:
      row.conviction_distribution_sell_ratio ??
      DEFAULT_CONVICTION_CONFIG.convictionDistributionSellRatio,
    convictionDistributionMinSellsUsd:
      row.conviction_distribution_min_sells_usd ??
      DEFAULT_CONVICTION_CONFIG.convictionDistributionMinSellsUsd,
    convictionDistributionWalletCount:
      row.conviction_distribution_wallet_count ??
      DEFAULT_CONVICTION_CONFIG.convictionDistributionWalletCount,
    convictionInactivityMinutes:
      row.conviction_inactivity_minutes ?? DEFAULT_CONVICTION_CONFIG.convictionInactivityMinutes,
    convictionRankLossGraceSeconds:
      row.conviction_rank_loss_grace_seconds ??
      DEFAULT_CONVICTION_CONFIG.convictionRankLossGraceSeconds,
    convictionWeightNetCommitment:
      row.conviction_weight_net_commitment ??
      DEFAULT_CONVICTION_CONFIG.convictionWeightNetCommitment,
    convictionWeightVelocity:
      row.conviction_weight_velocity ?? DEFAULT_CONVICTION_CONFIG.convictionWeightVelocity,
    convictionWeightAcceleration:
      row.conviction_weight_acceleration ?? DEFAULT_CONVICTION_CONFIG.convictionWeightAcceleration,
    convictionWeightConvergence:
      row.conviction_weight_convergence ?? DEFAULT_CONVICTION_CONFIG.convictionWeightConvergence,
    convictionWeightPersistence:
      row.conviction_weight_persistence ?? DEFAULT_CONVICTION_CONFIG.convictionWeightPersistence,
    convictionTierCommitmentThresholdsUsd: row.conviction_tier_commitment_thresholds_usd?.map(
      Number,
    ) ?? [...DEFAULT_CONVICTION_CONFIG.convictionTierCommitmentThresholdsUsd],
    convictionTierBuyAmountsUsd: row.conviction_tier_buy_amounts_usd?.map(Number) ?? [
      ...DEFAULT_CONVICTION_CONFIG.convictionTierBuyAmountsUsd,
    ],
    coordinatedModeEnabled: row.coordinated_mode_enabled ?? false,
    coordinatedFixedBuyUsd: row.coordinated_fixed_buy_usd ?? 25,
    coordinatedThreeWalletBuyUsd: Number(row.coordinated_three_wallet_buy_usd ?? 0),
    coordinatedTargetWalletCount: row.coordinated_target_wallet_count ?? 2,
    coordinatedWindowSeconds: row.coordinated_window_seconds ?? 30,
    coordinatedMcMinUsd: row.coordinated_mc_min_usd ?? 0,
    coordinatedMcMaxUsd: row.coordinated_mc_max_usd ?? 15_000,
    coordinatedCoinAgeMinMinutes: row.coordinated_coin_age_min_minutes ?? 0,
    coordinatedCoinAgeMaxMinutes: row.coordinated_coin_age_max_minutes ?? 60,
    coordinatedTargetBuyMinUsd: row.coordinated_target_buy_min_usd ?? 0,
    coordinatedTargetBuyMaxUsd: row.coordinated_target_buy_max_usd ?? 1_000_000,
    coordinatedFirstBuyOnly: row.coordinated_first_buy_only ?? false,
    coordinatedOncePerToken: row.coordinated_once_per_token ?? true,
    coordinatedFollowerSellCount: row.coordinated_follower_sell_count ?? 1,
    coordinatedFollowerSellPct: row.coordinated_follower_sell_pct ?? 100,
    coordinatedInactivityHours: row.coordinated_inactivity_hours ?? 6,
    networkScalingEnabled: row.network_scaling_enabled ?? true,
    starterPositionPct: row.starter_position_pct ?? 5,
    maxPositionPct: row.max_position_pct ?? 15,
    newEntryReservePct: row.new_entry_reserve_pct ?? 50,
    targetCopyRatioPct: row.target_copy_ratio_pct ?? 1,
    minScaleBuyUsd: row.min_scale_buy_usd ?? 1,
    minTargetBuyUsd: row.min_target_buy_usd,
    mcMinUsd: row.mc_min_usd,
    mcMaxUsd: row.mc_max_usd,
    liqMinUsd: row.liq_min_usd,
    liqMaxUsd: row.liq_max_usd,
    tokenAgeFilterEnabled: row.token_age_filter_enabled ?? false,
    tokenAgeMinMinutes: row.token_age_min_minutes ?? 0,
    tokenAgeMaxMinutes: row.token_age_max_minutes ?? 60,
    pumpFunOnly: row.pump_fun_only,
    requireSocials: row.require_socials,
    require24hUptrend: row.require_24h_uptrend ?? false,
    largeBuyScannerEnabled: row.large_buy_scanner_enabled ?? false,
    largeBuyScannerMaxMcUsd: row.large_buy_scanner_max_mc_usd ?? 10_000,
    largeBuyScannerMinBuyUsd: row.large_buy_scanner_min_buy_usd ?? 500,
    largeBuyScannerMultiplier: row.large_buy_scanner_multiplier ?? 2,
    largeBuyScannerHistoryWindow: row.large_buy_scanner_history_window ?? 20,
    onlyFirstBuyEver: row.only_first_buy_ever,
    onlyOncePerToken: row.only_once_per_token,
    takeProfitEnabled: row.take_profit_enabled,
    takeProfitPct: row.take_profit_pct,
    takeProfitSellPct: row.take_profit_sell_pct,
    stopLossEnabled: row.stop_loss_enabled,
    stopLossPct: row.stop_loss_pct,
    trailingStopEnabled: row.trailing_stop_enabled ?? false,
    trailingStopPct: Number(row.trailing_stop_pct ?? 35),
    trailingActivationPct: Number(row.trailing_activation_pct ?? 50),
    proportionalFollowerSells: row.proportional_follower_sells,
    followerSellerExitEnabled: row.follower_seller_exit_enabled ?? false,
    followerSellerExitCount: row.follower_seller_exit_count ?? 1,
    followerSellerExitPct: row.follower_seller_exit_pct ?? 100,
    targetInactivityExitEnabled: row.target_inactivity_exit_enabled ?? false,
    targetInactivityHours: row.target_inactivity_hours ?? 6,
    directTargetSellExitMode: row.direct_target_sell_exit_mode ?? "off",
    directTargetSellExitPct: row.direct_target_sell_exit_pct ?? 100,
    terminalOutflowExitEnabled: row.terminal_outflow_exit_enabled ?? false,
    terminalOutflowExitPct: row.terminal_outflow_exit_pct ?? 100,
    targetTerminalOutflowExitEnabled: row.target_terminal_outflow_exit_enabled ?? false,
    targetTerminalOutflowExitPct: row.target_terminal_outflow_exit_pct ?? 100,
  };
}

export function configToRow(
  cfg: BotConfig,
): Omit<Database["public"]["Tables"]["bot_config"]["Row"], "id"> {
  return {
    user_id: currentUserId(),
    enabled: cfg.enabled,
    target_wallet: cfg.targetWallet.trim() || null,
    additional_target_wallets: Array.from(
      new Set(
        cfg.additionalTargetWallets
          .map((wallet) => wallet.trim())
          .filter((wallet) => wallet && wallet !== cfg.targetWallet.trim()),
      ),
    ),
    execution_route: cfg.executionRoute,
    jito_tip_sol: cfg.jitoTipSol,
    fixed_buy_usd: cfg.fixedBuyUsd,
    supply_accumulation_mode_enabled: cfg.supplyAccumulationModeEnabled,
    supply_accumulation_threshold_pct: cfg.supplyAccumulationThresholdPct,
    supply_accumulation_buy_usd: cfg.supplyAccumulationBuyUsd,
    supply_accumulation_min_market_cap_usd: cfg.supplyAccumulationMinMarketCapUsd,
    supply_accumulation_max_market_cap_usd: cfg.supplyAccumulationMaxMarketCapUsd,
    supply_accumulation_window_seconds: cfg.supplyAccumulationWindowSeconds,
    supply_accumulation_scale_2_enabled: cfg.supplyAccumulationScale2Enabled,
    supply_accumulation_scale_2_threshold_pct: cfg.supplyAccumulationScale2ThresholdPct,
    supply_accumulation_scale_2_buy_usd: cfg.supplyAccumulationScale2BuyUsd,
    supply_accumulation_scale_3_enabled: cfg.supplyAccumulationScale3Enabled,
    supply_accumulation_scale_3_threshold_pct: cfg.supplyAccumulationScale3ThresholdPct,
    supply_accumulation_scale_3_buy_usd: cfg.supplyAccumulationScale3BuyUsd,
    supply_accumulation_scale_4_enabled: cfg.supplyAccumulationScale4Enabled,
    supply_accumulation_scale_4_threshold_pct: cfg.supplyAccumulationScale4ThresholdPct,
    supply_accumulation_scale_4_buy_usd: cfg.supplyAccumulationScale4BuyUsd,
    custody_journey_enabled: cfg.custodyJourneyEnabled,
    revival_tracker_enabled: cfg.revivalTrackerEnabled,
    revival_market_cap_min_usd: cfg.revivalMarketCapMinUsd,
    revival_market_cap_max_usd: cfg.revivalMarketCapMaxUsd,
    crew_exit_enabled: cfg.crewExitEnabled,
    crew_exit_pct: cfg.crewExitPct,
    crew_exit_min_mints: cfg.crewExitMinMints,
    conviction_mode_enabled: cfg.convictionModeEnabled,
    conviction_trading_mode: cfg.convictionTradingMode,
    conviction_rapid_follow_enabled: cfg.convictionRapidFollowEnabled,
    conviction_primary_window_minutes: cfg.convictionPrimaryWindowMinutes,
    conviction_score_threshold: cfg.convictionScoreThreshold,
    conviction_top_n: cfg.convictionTopN,
    conviction_min_commitment_usd: cfg.convictionMinCommitmentUsd,
    conviction_min_recent_net_inflow_usd: cfg.convictionMinRecentNetInflowUsd,
    conviction_min_velocity_usd_per_minute: cfg.convictionMinVelocityUsdPerMinute,
    conviction_min_acceleration_ratio: cfg.convictionMinAccelerationRatio,
    conviction_min_converged_wallets: cfg.convictionMinConvergedWallets,
    conviction_two_wallet_window_seconds: cfg.convictionTwoWalletWindowSeconds,
    conviction_three_wallet_window_seconds: cfg.convictionThreeWalletWindowSeconds,
    conviction_min_individual_buy_usd: cfg.convictionMinIndividualBuyUsd,
    conviction_market_cap_filter_enabled: cfg.convictionMarketCapFilterEnabled,
    conviction_market_cap_min_usd: cfg.convictionMarketCapMinUsd,
    conviction_market_cap_max_usd: cfg.convictionMarketCapMaxUsd,
    conviction_liquidity_filter_enabled: cfg.convictionLiquidityFilterEnabled,
    conviction_liquidity_min_usd: cfg.convictionLiquidityMinUsd,
    conviction_liquidity_max_usd: cfg.convictionLiquidityMaxUsd,
    conviction_token_age_filter_enabled: cfg.convictionTokenAgeFilterEnabled,
    conviction_token_age_min_minutes: cfg.convictionTokenAgeMinMinutes,
    conviction_token_age_max_minutes: cfg.convictionTokenAgeMaxMinutes,
    conviction_max_position_per_token_usd: cfg.convictionMaxPositionPerTokenUsd,
    conviction_distribution_sell_ratio: cfg.convictionDistributionSellRatio,
    conviction_distribution_min_sells_usd: cfg.convictionDistributionMinSellsUsd,
    conviction_distribution_wallet_count: cfg.convictionDistributionWalletCount,
    conviction_inactivity_minutes: cfg.convictionInactivityMinutes,
    conviction_rank_loss_grace_seconds: cfg.convictionRankLossGraceSeconds,
    conviction_weight_net_commitment: cfg.convictionWeightNetCommitment,
    conviction_weight_velocity: cfg.convictionWeightVelocity,
    conviction_weight_acceleration: cfg.convictionWeightAcceleration,
    conviction_weight_convergence: cfg.convictionWeightConvergence,
    conviction_weight_persistence: cfg.convictionWeightPersistence,
    conviction_tier_commitment_thresholds_usd: cfg.convictionTierCommitmentThresholdsUsd,
    conviction_tier_buy_amounts_usd: cfg.convictionTierBuyAmountsUsd,
    coordinated_mode_enabled: cfg.coordinatedModeEnabled,
    coordinated_fixed_buy_usd: cfg.coordinatedFixedBuyUsd,
    coordinated_three_wallet_buy_usd: cfg.coordinatedThreeWalletBuyUsd,
    coordinated_target_wallet_count: cfg.coordinatedTargetWalletCount,
    coordinated_window_seconds: cfg.coordinatedWindowSeconds,
    coordinated_mc_min_usd: cfg.coordinatedMcMinUsd,
    coordinated_mc_max_usd: cfg.coordinatedMcMaxUsd,
    coordinated_coin_age_min_minutes: cfg.coordinatedCoinAgeMinMinutes,
    coordinated_coin_age_max_minutes: cfg.coordinatedCoinAgeMaxMinutes,
    coordinated_target_buy_min_usd: cfg.coordinatedTargetBuyMinUsd,
    coordinated_target_buy_max_usd: cfg.coordinatedTargetBuyMaxUsd,
    coordinated_first_buy_only: cfg.coordinatedFirstBuyOnly,
    coordinated_once_per_token: cfg.coordinatedOncePerToken,
    coordinated_follower_sell_count: cfg.coordinatedFollowerSellCount,
    coordinated_follower_sell_pct: cfg.coordinatedFollowerSellPct,
    coordinated_inactivity_hours: cfg.coordinatedInactivityHours,
    network_scaling_enabled: cfg.networkScalingEnabled,
    starter_position_pct: cfg.starterPositionPct,
    max_position_pct: cfg.maxPositionPct,
    new_entry_reserve_pct: cfg.newEntryReservePct,
    target_copy_ratio_pct: cfg.targetCopyRatioPct,
    min_scale_buy_usd: cfg.minScaleBuyUsd,
    min_target_buy_usd: cfg.minTargetBuyUsd,
    mc_min_usd: cfg.mcMinUsd,
    mc_max_usd: cfg.mcMaxUsd,
    liq_min_usd: cfg.liqMinUsd,
    liq_max_usd: cfg.liqMaxUsd,
    token_age_filter_enabled: cfg.tokenAgeFilterEnabled,
    token_age_min_minutes: cfg.tokenAgeMinMinutes,
    token_age_max_minutes: cfg.tokenAgeMaxMinutes,
    pump_fun_only: cfg.pumpFunOnly,
    require_socials: cfg.requireSocials,
    require_24h_uptrend: cfg.require24hUptrend,
    large_buy_scanner_enabled: cfg.largeBuyScannerEnabled,
    large_buy_scanner_max_mc_usd: cfg.largeBuyScannerMaxMcUsd,
    large_buy_scanner_min_buy_usd: cfg.largeBuyScannerMinBuyUsd,
    large_buy_scanner_multiplier: cfg.largeBuyScannerMultiplier,
    large_buy_scanner_history_window: cfg.largeBuyScannerHistoryWindow,
    only_first_buy_ever: cfg.onlyFirstBuyEver,
    only_once_per_token: cfg.onlyOncePerToken,
    take_profit_enabled: cfg.takeProfitEnabled,
    take_profit_pct: cfg.takeProfitPct,
    take_profit_sell_pct: cfg.takeProfitSellPct,
    stop_loss_enabled: cfg.stopLossEnabled,
    stop_loss_pct: cfg.stopLossPct,
    trailing_stop_enabled: cfg.trailingStopEnabled,
    trailing_stop_pct: cfg.trailingStopPct,
    trailing_activation_pct: cfg.trailingActivationPct,
    proportional_follower_sells: cfg.proportionalFollowerSells,
    follower_seller_exit_enabled: cfg.followerSellerExitEnabled,
    follower_seller_exit_count: cfg.followerSellerExitCount,
    follower_seller_exit_pct: cfg.followerSellerExitPct,
    target_inactivity_exit_enabled: cfg.targetInactivityExitEnabled,
    target_inactivity_hours: cfg.targetInactivityHours,
    direct_target_sell_exit_mode: cfg.directTargetSellExitMode,
    direct_target_sell_exit_pct: cfg.directTargetSellExitPct,
    terminal_outflow_exit_enabled: cfg.terminalOutflowExitEnabled,
    terminal_outflow_exit_pct: cfg.terminalOutflowExitPct,
    target_terminal_outflow_exit_enabled: cfg.targetTerminalOutflowExitEnabled,
    target_terminal_outflow_exit_pct: cfg.targetTerminalOutflowExitPct,
    updated_at: new Date().toISOString(),
  };
}

function configuredEncryptionKey(): Buffer | null {
  const raw = process.env.KEY_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("KEY_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return key;
}

export async function saveFundingKeyRecord(privateKey: string): Promise<SaveFundingKeyResult> {
  const serverKey = serviceRoleKey();
  if (!serverKey) {
    return {
      ok: false,
      code: "missing_backend_key",
      error:
        "The backend service key is missing. Add SERVER_SUPABASE_SERVICE_ROLE_KEY first, then save your wallet key again.",
    };
  }
  const secretBytes = decodeBase58(privateKey);
  if (secretBytes.length !== 64) {
    return {
      ok: false,
      code: "save_failed",
      error: `Private key decoded to ${secretBytes.length} bytes; expected 64.`,
    };
  }
  const explicitKey = configuredEncryptionKey();
  const key = explicitKey ?? createHash("sha256").update(serverKey).digest();

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(privateKey, "utf8"), cipher.final()]);
  const prefix = explicitKey ? "key:" : "svc:";
  const ciphertext = `${prefix}${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64")}`;

  const db = adminClient();
  const row = {
    user_id: currentUserId(),
    wallet_pubkey: encodeBase58(secretBytes.slice(32)),
    ciphertext,
  };
  const fundingKeys = db.from("funding_keys") as unknown as {
    upsert: (
      value: Database["public"]["Tables"]["funding_keys"]["Insert"],
      options: { onConflict: string },
    ) => PromiseLike<{ error: { message: string } | null }>;
  };
  const { error } = await fundingKeys.upsert(row, { onConflict: "user_id" });
  if (error) {
    return { ok: false, code: "save_failed", error: error.message };
  }
  return { ok: true };
}
