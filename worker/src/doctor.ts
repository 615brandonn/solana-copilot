import "dotenv/config";
import { Connection, Keypair, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import bs58 from "bs58";
import { env } from "./env.js";
import { db, type BotConfigRow } from "./db.js";
import { decryptPrivateKey } from "./crypto.js";
import { decodeParsedTransaction } from "./poller.js";
import { fetch } from "undici";
import { parseJupiterPrice } from "./price-parser.js";
import { redactedIdentifier, safeDiagnostic } from "./diagnostics.js";
import { evaluateEntryClaimGate, evaluateSellClaimGate } from "./doctor-claims.js";
import { STABLECOIN_MINTS } from "./swap-attribution.js";
import { hasVerifiedSwapSignal } from "./swap-signal.js";
import {
  createRpcFollowerTokenBalanceReader,
  createSupabaseFollowerBalanceStore,
  inspectFollowerBalances,
} from "./follower-balance-reconciler.js";

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OFFICIAL_JITO_TIP_ACCOUNTS = new Set([
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
]);
const rpc = new Connection(env.RPC_URL, { commitment: "confirmed" });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type TransactionMeta = NonNullable<ParsedTransactionWithMeta["meta"]>;
type TokenBalance = NonNullable<TransactionMeta["preTokenBalances"]>[number];
let failureCount = 0;
let warningCount = 0;

function line(label: string, value: unknown) {
  console.log(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

function fail(label: string, value: unknown) {
  failureCount += 1;
  console.log(`❌ ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

function pass(label: string, value: unknown) {
  console.log(`✅ ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

function warn(label: string, value: unknown) {
  warningCount += 1;
  console.log(`⚠️ ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

async function checkJupiterApi() {
  if (!env.JUPITER_API_KEY) {
    fail("Jupiter API key", "missing — add the paid key to worker/.env");
    return;
  }
  const headers = { "x-api-key": env.JUPITER_API_KEY };
  const priceUrl = new URL(env.PRICE_API_URL);
  priceUrl.searchParams.set("ids", WSOL);
  const priceResponse = await fetch(priceUrl, { headers, signal: AbortSignal.timeout(5_000) });
  const pricePayload = priceResponse.ok ? await priceResponse.json() : null;
  const solUsd = parseJupiterPrice(pricePayload, WSOL);
  if (!priceResponse.ok || solUsd === undefined) {
    fail("Jupiter Price API v3", {
      httpStatus: priceResponse.status,
      parsedSolUsd: solUsd ?? null,
    });
  } else {
    pass("Jupiter Price API v3", { httpStatus: priceResponse.status, solUsd });
  }

  const quoteUrl = new URL("https://api.jup.ag/swap/v2/order");
  quoteUrl.searchParams.set("inputMint", WSOL);
  quoteUrl.searchParams.set("outputMint", USDC);
  quoteUrl.searchParams.set("amount", "1000000");
  const quoteResponse = await fetch(quoteUrl, { headers, signal: AbortSignal.timeout(5_000) });
  const quotePayload = quoteResponse.ok
    ? ((await quoteResponse.json()) as { outAmount?: string })
    : null;
  if (!quoteResponse.ok || !quotePayload?.outAmount) {
    fail("Jupiter Swap V2 quote", { httpStatus: quoteResponse.status, hasQuote: false });
  } else {
    pass("Jupiter Swap V2 quote", { httpStatus: quoteResponse.status, hasQuote: true });
  }
}

async function checkStrategyLabSchema(userId: string) {
  const columns = await db
    .from("strategy_observations")
    .select(
      "user_id,event_key,source,event_at,relationship,event_kind,side,actor_wallet,token_mint,bot_decision,reaction_ms,execution_ms,metadata",
    )
    .eq("user_id", userId)
    .limit(1);
  if (columns.error) {
    fail("Strategy Lab table", safeDiagnostic(columns.error.message));
    return;
  }

  const insights = await db.rpc("strategy_insights", {
    p_user_id: userId,
    p_since: new Date().toISOString(),
  });
  if (insights.error) {
    fail("Strategy Lab insights RPC", safeDiagnostic(insights.error.message));
    return;
  }

  try {
    const apiUrl = new URL("/rest/v1/", env.BOT_SUPABASE_URL);
    const headers: Record<string, string> = {
      apikey: env.BOT_SUPABASE_SERVICE_ROLE_KEY,
    };
    if (!env.BOT_SUPABASE_SERVICE_ROLE_KEY.startsWith("sb_")) {
      headers.Authorization = `Bearer ${env.BOT_SUPABASE_SERVICE_ROLE_KEY}`;
    }
    const response = await fetch(apiUrl, {
      headers,
      signal: AbortSignal.timeout(5_000),
    });
    const payload = response.ok
      ? ((await response.json()) as { paths?: Record<string, unknown> })
      : undefined;
    if (!response.ok || !payload?.paths?.["/rpc/record_strategy_observations"]) {
      fail("Strategy Lab recorder RPC", {
        httpStatus: response.status,
        functionPresent: false,
      });
      return;
    }
    if (!payload.paths["/rpc/record_follower_transfer_batch"]) {
      fail("Sell-coverage transfer RPC", {
        httpStatus: response.status,
        functionPresent: false,
      });
      return;
    }
    if (
      !payload.paths["/rpc/record_root_follower_transfer"] ||
      !payload.paths["/rpc/record_follower_sell_event"]
    ) {
      fail("Sell-coverage accounting RPCs", {
        httpStatus: response.status,
        rootTransferFunctionPresent: Boolean(payload.paths["/rpc/record_root_follower_transfer"]),
        followerSellFunctionPresent: Boolean(payload.paths["/rpc/record_follower_sell_event"]),
      });
      return;
    }
  } catch (err) {
    fail("Strategy Lab recorder RPC", safeDiagnostic(err));
    return;
  }

  pass("Strategy Lab schema", "table, read-only insights, and recorder function are available");
}

async function checkConvictionModeSchema(cfg: BotConfigRow, targetCount: number): Promise<boolean> {
  const requiredConfigFields: Array<keyof BotConfigRow> = [
    "conviction_mode_enabled",
    "conviction_trading_mode",
    "conviction_rapid_follow_enabled",
    "conviction_primary_window_minutes",
    "conviction_score_threshold",
    "conviction_top_n",
    "conviction_min_commitment_usd",
    "conviction_min_recent_net_inflow_usd",
    "conviction_min_velocity_usd_per_minute",
    "conviction_min_acceleration_ratio",
    "conviction_min_converged_wallets",
    "conviction_two_wallet_window_seconds",
    "conviction_three_wallet_window_seconds",
    "conviction_min_individual_buy_usd",
    "conviction_market_cap_filter_enabled",
    "conviction_market_cap_min_usd",
    "conviction_market_cap_max_usd",
    "conviction_liquidity_filter_enabled",
    "conviction_liquidity_min_usd",
    "conviction_liquidity_max_usd",
    "conviction_token_age_filter_enabled",
    "conviction_token_age_min_minutes",
    "conviction_token_age_max_minutes",
    "conviction_max_position_per_token_usd",
    "conviction_distribution_sell_ratio",
    "conviction_distribution_min_sells_usd",
    "conviction_distribution_wallet_count",
    "conviction_inactivity_minutes",
    "conviction_rank_loss_grace_seconds",
    "conviction_weight_net_commitment",
    "conviction_weight_velocity",
    "conviction_weight_acceleration",
    "conviction_weight_convergence",
    "conviction_weight_persistence",
    "conviction_tier_commitment_thresholds_usd",
    "conviction_tier_buy_amounts_usd",
  ];
  const missing = requiredConfigFields.filter(
    (field) => cfg[field] === undefined || cfg[field] === null,
  );
  if (missing.length > 0) {
    fail(
      "Conviction Mode migration",
      `missing ${missing.length} config field(s) — run supabase/conviction-mode-migration.sql before deploying this worker`,
    );
    return false;
  }

  const weights = [
    cfg.conviction_weight_net_commitment,
    cfg.conviction_weight_velocity,
    cfg.conviction_weight_acceleration,
    cfg.conviction_weight_convergence,
    cfg.conviction_weight_persistence,
  ].map(Number);
  const thresholds = (cfg.conviction_tier_commitment_thresholds_usd ?? []).map(Number);
  const tierBuys = (cfg.conviction_tier_buy_amounts_usd ?? []).map(Number);
  const validWindow = new Set([5, 30, 60]).has(Number(cfg.conviction_primary_window_minutes));
  const numberInRange = (value: unknown, minimum: number, maximum = Number.POSITIVE_INFINITY) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= minimum && number <= maximum;
  };
  const integerInRange = (value: unknown, minimum: number, maximum: number) => {
    const number = Number(value);
    return Number.isInteger(number) && number >= minimum && number <= maximum;
  };
  const validWeights =
    weights.every((value) => Number.isFinite(value) && value >= 0 && value <= 100) &&
    Math.abs(weights.reduce((sum, value) => sum + value, 0) - 100) < 0.000_001;
  const validTiers =
    thresholds.length === 4 &&
    tierBuys.length === 4 &&
    thresholds.every(
      (value, index) =>
        Number.isFinite(value) && value > 0 && (index === 0 || value > thresholds[index - 1]),
    ) &&
    tierBuys.every((value) => Number.isFinite(value) && value > 0) &&
    tierBuys.reduce((sum, value) => sum + value, 0) <=
      Number(cfg.conviction_max_position_per_token_usd);
  const validConvergence =
    integerInRange(cfg.conviction_min_converged_wallets, 1, 3) &&
    integerInRange(cfg.conviction_two_wallet_window_seconds, 1, 21_600) &&
    integerInRange(cfg.conviction_three_wallet_window_seconds, 1, 21_600) &&
    Number(cfg.conviction_three_wallet_window_seconds) >=
      Number(cfg.conviction_two_wallet_window_seconds);
  const validFilters =
    numberInRange(cfg.conviction_market_cap_min_usd, 0) &&
    numberInRange(cfg.conviction_market_cap_max_usd, Number(cfg.conviction_market_cap_min_usd)) &&
    numberInRange(cfg.conviction_liquidity_min_usd, 0) &&
    numberInRange(cfg.conviction_liquidity_max_usd, Number(cfg.conviction_liquidity_min_usd)) &&
    numberInRange(cfg.conviction_token_age_min_minutes, 0) &&
    numberInRange(
      cfg.conviction_token_age_max_minutes,
      Number(cfg.conviction_token_age_min_minutes),
    );
  const validEntryGates =
    numberInRange(cfg.conviction_score_threshold, 0, 100) &&
    integerInRange(cfg.conviction_top_n, 1, 10) &&
    numberInRange(cfg.conviction_min_commitment_usd, 0) &&
    numberInRange(cfg.conviction_min_recent_net_inflow_usd, 0) &&
    numberInRange(cfg.conviction_min_velocity_usd_per_minute, 0) &&
    numberInRange(cfg.conviction_min_acceleration_ratio, 0) &&
    numberInRange(cfg.conviction_min_individual_buy_usd, 0) &&
    numberInRange(cfg.conviction_max_position_per_token_usd, Number.MIN_VALUE) &&
    numberInRange(cfg.conviction_distribution_sell_ratio, 0, 1) &&
    numberInRange(cfg.conviction_distribution_min_sells_usd, 0) &&
    integerInRange(cfg.conviction_distribution_wallet_count, 1, 3) &&
    numberInRange(cfg.conviction_inactivity_minutes, Number.MIN_VALUE) &&
    integerInRange(cfg.conviction_rank_loss_grace_seconds, 0, 86_400);
  if (
    !["shadow", "live"].includes(String(cfg.conviction_trading_mode)) ||
    !validWindow ||
    !validWeights ||
    !validTiers ||
    !validConvergence ||
    !validFilters ||
    !validEntryGates
  ) {
    fail(
      "Conviction Mode config",
      "trading mode, leaderboard, entry gates, filters, convergence, weights, or tier values are invalid",
    );
    return false;
  }
  if (cfg.conviction_mode_enabled && targetCount !== 3) {
    fail(
      "Conviction Mode wallet cluster",
      `exactly 3 unique market-maker wallets are required; ${targetCount} configured`,
    );
    return false;
  }

  const checks = await Promise.all([
    db
      .from("conviction_events")
      .select(
        "id,user_id,event_key,tx_sig,slot,source,event_at,recorded_at,wallet,from_wallet,to_wallet,token_mint,classification,classification_reliable,amount_tokens,amount_usd,market_cap_usd,liquidity_usd,metadata",
      )
      .limit(1),
    db
      .from("conviction_token_state")
      .select(
        "user_id,token_mint,symbol,first_seen_at,last_activity_at,gross_cluster_buys_usd,gross_cluster_sells_usd,net_cluster_investment_usd,wallet_net_usd,buy_count,sell_count,largest_buy_usd,last_buy_usd,average_buy_usd,median_buy_usd,wallets_that_bought,wallets_currently_accumulating,wallet_convergence_count,market_cap_usd,market_cap_at_first_cluster_buy_usd,liquidity_usd,our_current_position_usd,net_flow_1m_usd,net_flow_5m_usd,net_flow_30m_usd,net_flow_60m_usd,capital_velocity_usd_per_minute,capital_acceleration_ratio,buy_size_acceleration_ratio,rolling_metrics,conviction_score,conviction_state,score_reasons,current_rank,previous_rank,rank_direction,time_in_top_10_seconds,time_in_top_3_seconds,time_at_rank_one_seconds,rapid_follow_status,data_reliable,last_ranked_at,updated_at",
      )
      .limit(1),
    db
      .from("conviction_rank_history")
      .select(
        "id,user_id,token_mint,window_minutes,rank,previous_rank,rank_direction,conviction_score,net_cluster_investment_usd,net_flow_usd,capital_velocity_usd_per_minute,capital_acceleration_ratio,buy_size_acceleration_ratio,wallet_convergence_count,continuing_accumulation,distribution_penalty,ranking_at,metadata",
      )
      .limit(1),
    db
      .from("conviction_transitions")
      .select(
        "id,user_id,transition_key,token_mint,event_type,previous_state,new_state,previous_score,new_score,net_cluster_investment_usd,capital_velocity_usd_per_minute,wallet_convergence_count,market_cap_usd,liquidity_usd,reasons,metadata,occurred_at,recorded_at",
      )
      .limit(1),
    db
      .from("conviction_tiers")
      .select(
        "user_id,token_mint,tier_number,trading_mode,status,planned_position_id,position_id,source_event_key,commitment_threshold_usd,buy_usd,score,received_tokens,bot_tx_sig,reason,error_code,claimed_at,submission_started_at,landed_at,persisted_at,created_at,updated_at,metadata",
      )
      .limit(1),
  ]);
  const schemaError = checks.find((result) => result.error)?.error;
  if (schemaError) {
    fail(
      "Conviction Mode schema",
      `${safeDiagnostic(schemaError.message)} — run supabase/conviction-mode-migration.sql before deploying this worker`,
    );
    return false;
  }

  const tierIdentity = await db.rpc("conviction_tier_identity_health");
  if (tierIdentity.error) {
    fail(
      "Conviction tier identity",
      `${safeDiagnostic(tierIdentity.error.message)} — rerun supabase/conviction-mode-migration.sql`,
    );
    return false;
  }
  const tierIdentityRow = Array.isArray(tierIdentity.data)
    ? tierIdentity.data[0]
    : tierIdentity.data;
  if (tierIdentityRow?.mode_scoped_unique !== true) {
    fail(
      "Conviction tier identity",
      "mode-scoped uniqueness is missing — SHADOW could block a later LIVE tier",
    );
    return false;
  }
  pass(
    "Conviction tier identity",
    tierIdentityRow?.legacy_unscoped_unique === true
      ? "mode-scoped uniqueness ready; legacy compatibility constraint detected"
      : "SHADOW and LIVE tier identities are independently protected",
  );

  const unresolved = await db
    .from("conviction_tiers")
    .select("status,planned_position_id,bot_tx_sig")
    .eq("user_id", cfg.user_id)
    .in("status", ["claimed", "submitted", "landed", "uncertain"]);
  if (unresolved.error) {
    fail("Conviction tier claims", safeDiagnostic(unresolved.error.message));
    return false;
  }
  const claimed = (unresolved.data ?? []).filter((row) => row.status === "claimed");
  const unsafe = (unresolved.data ?? []).filter(
    (row) => row.status === "submitted" || row.status === "uncertain",
  );
  const landed = (unresolved.data ?? []).filter((row) => row.status === "landed");
  let landedWithExactEvidence = 0;
  let landedWithoutEvidence = 0;
  for (const row of landed) {
    if (!row.bot_tx_sig) {
      landedWithoutEvidence += 1;
      continue;
    }
    const [{ data: trade, error: tradeError }, { data: position, error: positionError }] =
      await Promise.all([
        db
          .from("trades")
          .select("position_id")
          .eq("user_id", cfg.user_id)
          .eq("tx_sig", row.bot_tx_sig)
          .eq("side", "buy")
          .maybeSingle(),
        row.planned_position_id
          ? db
              .from("positions")
              .select("entry_tx_sig")
              .eq("user_id", cfg.user_id)
              .eq("id", row.planned_position_id)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ]);
    if (tradeError || positionError) {
      fail(
        "Conviction tier claims",
        `exact landed-claim evidence could not be checked: ${safeDiagnostic(tradeError ?? positionError)}`,
      );
      return false;
    }
    if (trade?.position_id || position?.entry_tx_sig === row.bot_tx_sig) {
      landedWithExactEvidence += 1;
    } else {
      landedWithoutEvidence += 1;
    }
  }
  if (unsafe.length > 0 || landedWithoutEvidence > 0) {
    fail(
      "Conviction tier claims",
      `${unsafe.length + landedWithoutEvidence} unsafe tier claim(s) require manual chain/position reconciliation before restart`,
    );
    return false;
  }
  if (claimed.length > 0 || landedWithExactEvidence > 0) {
    warn(
      "Conviction tier claims",
      `${claimed.length} pre-submit claim(s) will be released and ${landedWithExactEvidence} landed claim(s) have exact persistence evidence for safe startup reconciliation`,
    );
  } else {
    pass("Conviction tier claims", "no unfinished live Conviction tier claim is recorded");
  }

  pass(
    "Conviction Mode schema",
    "configuration, state, rankings, transitions, and tiers are ready",
  );
  pass(
    "Conviction Mode safety",
    cfg.conviction_mode_enabled
      ? `${String(cfg.conviction_trading_mode).toUpperCase()} selected; Conviction is the exclusive automatic entry strategy`
      : "OFF — legacy entry behavior remains authoritative",
  );
  return true;
}

async function checkCustodyJourneySchema(cfg: BotConfigRow): Promise<boolean> {
  if (typeof cfg.custody_journey_enabled !== "boolean") {
    fail(
      "Custody Journey migration",
      "missing custody_journey_enabled — run supabase/custody-journey-migration.sql before deploying the custody observer",
    );
    return false;
  }

  const checks = await Promise.all([
    db
      .from("custody_journeys")
      .select(
        "id,user_id,token_mint,status,started_at,last_activity_at,flat_at,flat_reason,total_verified_target_buy_tokens,total_verified_custody_sell_tokens,total_unresolved_outflow_tokens,current_attributed_tokens,source_target_wallets,first_event_key,last_event_key,created_at,updated_at",
      )
      .limit(1),
    db
      .from("custody_journey_wallets")
      .select(
        "id,journey_id,user_id,token_mint,wallet,hop_depth,parent_wallet,source_target_wallets,watch_status,current_attributed_tokens,last_observed_balance_tokens,attributed_share,balance_evidence_reliable,total_received_tokens,total_transferred_tokens,total_verified_sold_tokens,total_unresolved_outflow_tokens,first_seen_at,last_activity_at,last_balance_observed_at,released_at,release_reason,last_event_key,last_tx_sig,watch_anchor_slot,last_slot,created_at,updated_at",
      )
      .limit(1),
    db
      .from("custody_journey_events")
      .select(
        "id,journey_id,user_id,event_key,event_type,request_fingerprint,tx_sig,slot,event_at,source_wallet,destination_wallet,requested_amount_tokens,applied_amount_tokens,reconciled_amount_tokens,source_pre_amount_tokens,source_post_amount_tokens,evidence_reliable,recipients,result_reason,result_journey_status,result_watched_wallets,result_released_wallets,journey_released,metadata,recorded_at",
      )
      .limit(1),
    db
      .from("custody_wallet_profiles")
      .select(
        "user_id,wallet,inferred_type,inferred_label,inference_confidence,inference_source,manual_type,manual_label,first_seen_at,last_seen_at,created_at,updated_at",
      )
      .limit(1),
    db
      .from("custody_rpc_wallet_cursors")
      .select(
        "user_id,wallet,start_slot,last_processed_signature,last_processed_slot,last_block_time,backlog_detected,last_success_at,last_error,created_at,updated_at",
      )
      .limit(1),
    db
      .from("custody_worker_heartbeat")
      .select(
        "user_id,started_at,updated_at,enabled,geyser_connected,last_geyser_message_at,decoded_event_count,rpc_last_poll_at,rpc_last_success_at,rpc_backlog_wallet_count,watched_wallet_count,active_journey_count,last_event_at,degraded,last_error",
      )
      .limit(1),
    db
      .from("custody_pending_events")
      .select(
        "id,user_id,event_key,event_type,request_fingerprint,token_mint,tx_sig,slot,event_at,source_wallet,requested_amount_tokens,payload,status,retry_count,next_retry_at,last_retry_at,last_error_code,journey_id,event_id,result,expires_at,created_at,updated_at",
      )
      .limit(1),
  ]);
  const schemaError = checks.find((result) => result.error)?.error;
  if (schemaError) {
    fail(
      "Custody Journey schema",
      `${safeDiagnostic(schemaError.message)} — run supabase/custody-journey-migration.sql`,
    );
    return false;
  }

  try {
    const apiUrl = new URL("/rest/v1/", env.BOT_SUPABASE_URL);
    const headers: Record<string, string> = { apikey: env.BOT_SUPABASE_SERVICE_ROLE_KEY };
    if (!env.BOT_SUPABASE_SERVICE_ROLE_KEY.startsWith("sb_")) {
      headers.Authorization = `Bearer ${env.BOT_SUPABASE_SERVICE_ROLE_KEY}`;
    }
    const response = await fetch(apiUrl, {
      headers,
      signal: AbortSignal.timeout(5_000),
    });
    const payload = response.ok
      ? ((await response.json()) as { paths?: Record<string, unknown> })
      : undefined;
    const paths = payload?.paths ?? {};
    const missingRpc = [
      "/rpc/record_custody_target_buy",
      "/rpc/record_custody_transfer",
      "/rpc/record_verified_custody_sell",
      "/rpc/record_custody_unresolved_outflow",
      "/rpc/replay_custody_pending_events",
    ].filter((path) => !paths[path]);
    if (!response.ok || missingRpc.length > 0) {
      fail("Custody Journey RPCs", {
        httpStatus: response.status,
        missingFunctionCount: missingRpc.length,
      });
      return false;
    }
  } catch (error) {
    fail("Custody Journey RPCs", safeDiagnostic(error));
    return false;
  }

  pass(
    "Custody Journey schema",
    cfg.custody_journey_enabled
      ? "observer enabled; isolated ledger, cursors, heartbeat, and replay-safe RPCs are ready"
      : "OFF — observation ledger is installed but no custody monitoring is enabled",
  );
  return true;
}

async function checkRevivalTrackerSchema(cfg: BotConfigRow): Promise<boolean> {
  const minMarketCap = Number(cfg.revival_market_cap_min_usd);
  const maxMarketCap = Number(cfg.revival_market_cap_max_usd);
  if (
    typeof cfg.revival_tracker_enabled !== "boolean" ||
    !Number.isFinite(minMarketCap) ||
    !Number.isFinite(maxMarketCap) ||
    minMarketCap < 0 ||
    maxMarketCap < minMarketCap
  ) {
    fail(
      "Revival Campaign migration",
      "missing or invalid Revival tracker settings — run supabase/revival-campaign-migration.sql",
    );
    return false;
  }

  const checks = await Promise.all([
    db
      .from("revival_strategy_versions")
      .select(
        "id,user_id,version_number,strategy_key,role,algorithm_version,config_hash,config,created_at,activated_at,retired_at",
      )
      .limit(1),
    db
      .from("revival_campaigns")
      .select(
        "id,user_id,strategy_version_id,campaign_key,campaign_number,token_mint,symbol,state,state_version,eligibility_status,eligibility_reason,seed_event_key,seed_tx_sig,seed_slot,seed_tx_index,seeded_at,seed_available_at,eligibility_deadline_at,last_event_key,last_event_at,last_available_at,closed_at,close_reason,seed_market_cap_usd,latest_market_cap_usd,seed_price_usd,latest_price_usd,peak_price_usd,trough_price_usd,historical_peak_price_usd,historical_peak_market_cap_usd,drawdown_pct,baseline_volume_h1_usd,latest_volume_h1_usd,baseline_buy_count_h1,latest_buy_count_h1,seed_active_boosts,latest_active_boosts,last_market_observed_at,target_gross_buys_usd,target_gross_sells_usd,target_net_commitment_usd,target_buy_count,target_sell_count,target_wallets,unique_target_wallet_count,accumulation_score,ignition_score,distribution_score,ignition_streak,market_data_reliable,target_attribution_reliable,custody_evidence_reliable,coverage_status,entry_ready_at,ignited_at,distribution_risk_at,mfe_pct,mae_pct,config_snapshot,engine_version,created_at,updated_at",
      )
      .limit(1),
    db
      .from("revival_events")
      .select(
        "id,user_id,strategy_version_id,campaign_id,event_key,request_fingerprint,event_type,source,tx_sig,slot,tx_index,event_at,available_at,actor_wallet,token_mint,amount_tokens,amount_usd,price_usd,market_cap_usd,liquidity_usd,classification_reliable,market_data_reliable,historical,metadata,conflict_count,last_conflict_at,created_at",
      )
      .limit(1),
    db
      .from("revival_transitions")
      .select(
        "id,user_id,strategy_version_id,campaign_id,transition_key,trigger_kind,trigger_key,from_state,to_state,from_state_version,to_state_version,reasons,metrics,occurred_at,available_at,recorded_at",
      )
      .limit(1),
    db
      .from("revival_market_snapshots")
      .select(
        "id,user_id,strategy_version_id,campaign_id,snapshot_key,request_fingerprint,provider,pair_address,dex_id,market_at,available_at,price_usd,market_cap_usd,fdv_usd,valuation_kind,liquidity_usd,volume_m5_usd,volume_h1_usd,volume_h6_usd,volume_h24_usd,buys_m5,sells_m5,buys_h1,sells_h1,buys_h24,sells_h24,active_boosts,reliable,metadata,conflict_count,last_conflict_at,created_at",
      )
      .limit(1),
    db
      .from("revival_shadow_actions")
      .select(
        "id,user_id,strategy_version_id,campaign_id,action_key,variant_key,mode,state,state_version,action_type,decision_at,available_at,source_event_key,executable,reason,metadata,created_at",
      )
      .limit(1),
    db
      .from("revival_outcomes")
      .select(
        "id,user_id,campaign_id,strategy_version_id,variant_key,outcome_key,status,resolution_reason,entry_at,ignition_at,distribution_at,closed_at,entry_price_usd,close_price_usd,gross_entry_usd,gross_proceeds_usd,fees_usd,net_pnl_usd,pnl_pct,mfe_pct,mae_pct,holding_seconds,winner,coverage_status,market_data_reliable,target_attribution_reliable,metadata,resolved_at",
      )
      .limit(1),
    db
      .from("revival_rpc_wallet_cursors")
      .select(
        "user_id,wallet,start_slot,last_processed_signature,last_processed_slot,last_block_time,backlog_detected,last_success_at,last_error,created_at,updated_at",
      )
      .limit(1),
    db
      .from("revival_worker_heartbeat")
      .select(
        "user_id,started_at,updated_at,enabled,target_wallet_count,initialized,event_count,active_campaign_count,pending_market_data_count,last_event_at,last_market_snapshot_at,rpc_last_poll_at,rpc_last_success_at,rpc_backlog_wallet_count,degraded,last_error_code",
      )
      .limit(1),
  ]);
  const schemaError = checks.find((result) => result.error)?.error;
  if (schemaError) {
    fail(
      "Revival Campaign schema",
      `${safeDiagnostic(schemaError.message)} — run supabase/revival-campaign-migration.sql`,
    );
    return false;
  }

  const heartbeat = await db
    .from("revival_worker_heartbeat")
    .select("updated_at,enabled,degraded,rpc_backlog_wallet_count,last_error_code")
    .eq("user_id", cfg.user_id)
    .maybeSingle();
  if (heartbeat.error) {
    warn("Revival Campaign observer health", {
      available: false,
      hasError: true,
    });
  } else if (cfg.revival_tracker_enabled) {
    const updatedAt = Date.parse(String(heartbeat.data?.updated_at ?? ""));
    const stale = !Number.isFinite(updatedAt) || Date.now() - updatedAt > 60_000;
    const backlog = Number(heartbeat.data?.rpc_backlog_wallet_count ?? 0);
    if (!heartbeat.data || heartbeat.data.enabled !== true || stale || heartbeat.data.degraded) {
      warn("Revival Campaign observer health", {
        heartbeatPresent: Boolean(heartbeat.data),
        enabled: heartbeat.data?.enabled === true,
        stale,
        degraded: heartbeat.data?.degraded === true,
        rpcBacklogWalletCount: Number.isFinite(backlog) ? backlog : 0,
        hasLastError: Boolean(heartbeat.data?.last_error_code),
      });
    } else {
      pass("Revival Campaign observer health", {
        heartbeatFresh: true,
        rpcBacklogWalletCount: backlog,
      });
    }
  }

  pass(
    "Revival Campaign schema",
    cfg.revival_tracker_enabled
      ? `SHADOW schema ready; inclusive seed MC $${minMarketCap}-$${maxMarketCap}; no transaction capability`
      : `OFF; storage ready with seed MC $${minMarketCap}-$${maxMarketCap}`,
  );
  return true;
}

async function checkSellCoverageSchema(cfg: BotConfigRow): Promise<boolean> {
  const requiredConfigFields: Array<keyof BotConfigRow> = [
    "direct_target_sell_exit_mode",
    "direct_target_sell_exit_pct",
    "terminal_outflow_exit_enabled",
    "terminal_outflow_exit_pct",
    "target_terminal_outflow_exit_enabled",
    "target_terminal_outflow_exit_pct",
  ];
  const missingConfigFields = requiredConfigFields.filter(
    (field) => cfg[field] === undefined || cfg[field] === null,
  );
  if (missingConfigFields.length > 0) {
    fail(
      "Sell-coverage migration",
      `missing config fields (${missingConfigFields.join(", ")}) — run supabase/sell-coverage-migration.sql before deploying this worker`,
    );
    return false;
  }

  const validTargetSellModes = new Set(["off", "proportional", "fixed_pct", "full"]);
  const targetSellPct = Number(cfg.direct_target_sell_exit_pct);
  const terminalOutflowPct = Number(cfg.terminal_outflow_exit_pct);
  const targetTerminalOutflowPct = Number(cfg.target_terminal_outflow_exit_pct);
  if (
    !validTargetSellModes.has(cfg.direct_target_sell_exit_mode) ||
    !Number.isFinite(targetSellPct) ||
    targetSellPct <= 0 ||
    targetSellPct > 100 ||
    typeof cfg.terminal_outflow_exit_enabled !== "boolean" ||
    !Number.isFinite(terminalOutflowPct) ||
    terminalOutflowPct <= 0 ||
    terminalOutflowPct > 100 ||
    typeof cfg.target_terminal_outflow_exit_enabled !== "boolean" ||
    !Number.isFinite(targetTerminalOutflowPct) ||
    targetTerminalOutflowPct <= 0 ||
    targetTerminalOutflowPct > 100
  ) {
    fail("Sell-coverage config", "one or more safety settings contain an invalid value");
    return false;
  }

  const checks = await Promise.all([
    db
      .from("follower_wallets")
      .select("trigger_eligible,unexplained_outflow_amount,released_at,first_fresh_sell_at")
      .limit(1),
    db
      .from("rpc_wallet_cursors")
      .select(
        "user_id,wallet,start_slot,last_processed_signature,last_processed_slot,last_block_time,backlog_detected,last_success_at,last_error,created_at,updated_at",
      )
      .limit(1),
    db
      .from("position_target_wallets")
      .select("user_id,position_id,wallet,link_reason,linked_at,last_buy_at")
      .limit(1),
    db
      .from("sell_signal_claims")
      .select(
        "user_id,position_id,source_tx_sig,source_wallet,trigger_kind,status,requested_sell_pct,requested_sell_amount,bot_tx_sig,error_code,submission_started_at,landed_at,created_at,updated_at",
      )
      .limit(1),
    db
      .from("entry_signal_claims")
      .select(
        "user_id,source_tx_sig,source_wallet,token_mint,planned_position_id,entry_mode,amount_lamports,status,bot_tx_sig,error_code,submission_started_at,landed_at,persisted_at,created_at,updated_at",
      )
      .limit(1),
    db
      .from("follower_accounting_events")
      .select(
        "user_id,position_id,event_kind,token_mint,source_wallet,follower_wallet,tx_sig,slot,requested_amount,applied_amount,fresh_for_action,trigger_eligible,first_sell_by_wallet,sold_fraction,distinct_seller_count,result_initial_amount,result_current_amount,result_reason,applied_at",
      )
      .limit(1),
    db
      .from("target_outflow_observations")
      .select(
        "user_id,position_id,source_wallet,destination_wallet,token_mint,amount_tokens,destination_class,source_linked,tx_sig,slot,observed_at",
      )
      .limit(1),
    db
      .from("follower_outflow_observations")
      .select(
        "user_id,position_id,source_wallet,destination_wallet,token_mint,amount_tokens,hop_depth,destination_class,trigger_eligible,tx_sig,slot,observed_at",
      )
      .limit(1),
    db
      .from("follower_transfer_batches")
      .select(
        "id,user_id,position_id,source_wallet,token_mint,tx_sig,slot,requested_amount,moved_amount,tracked_amount,terminal_amount,hop_depth,source_trigger_eligible,recipient_count,tracked_wallets,terminal_wallets,applied_at",
      )
      .limit(1),
    db
      .from("follower_balance_alerts")
      .select(
        "user_id,wallet,token_mint,expected_amount,observed_amount,shortfall_amount,active_position_count,occurrence_count,first_detected_at,last_detected_at,confirmed_at,resolved_at,resolution_reason,resolution_observed_amount",
      )
      .limit(1),
    db
      .from("worker_heartbeat")
      .select(
        "rpc_last_success_at,rpc_backlog_wallet_count,monitoring_degraded,follower_balance_last_checked_at,follower_balance_candidate_count,follower_balance_mismatch_count,follower_balance_reconciliation_degraded,follower_balance_last_error",
      )
      .limit(1),
  ]);
  const schemaError = checks.find((result) => result.error)?.error;
  if (schemaError) {
    fail(
      "Sell-coverage schema",
      `${safeDiagnostic(schemaError.message)} — run supabase/sell-coverage-migration.sql before deploying this worker`,
    );
    return false;
  }

  const backlog = await db
    .from("rpc_wallet_cursors")
    .select("wallet", { count: "exact", head: true })
    .eq("user_id", cfg.user_id)
    .eq("backlog_detected", true);
  if (backlog.error) {
    fail("RPC cursor health", safeDiagnostic(backlog.error.message));
    return false;
  }
  const backlogCount = Number(backlog.count ?? 0);
  if (backlogCount > 0) {
    fail("RPC cursor health", `${backlogCount} monitored wallet(s) still have an RPC backlog`);
    return false;
  }

  const balanceAlerts = await db
    .from("follower_balance_alerts")
    .select("id", { count: "exact", head: true })
    .eq("user_id", cfg.user_id)
    .is("resolved_at", null)
    .not("confirmed_at", "is", null);
  if (balanceAlerts.error) {
    fail("Follower balance alerts", safeDiagnostic(balanceAlerts.error.message));
    return false;
  }
  const balanceAlertCount = Number(balanceAlerts.count ?? 0);
  if (balanceAlertCount > 0) {
    fail(
      "Follower balance alerts",
      `${balanceAlertCount} unresolved balance mismatch(es) block new entries; they are observations only and never trigger a sale`,
    );
    return false;
  }
  const balanceCandidates = await db
    .from("follower_balance_alerts")
    .select("id", { count: "exact", head: true })
    .eq("user_id", cfg.user_id)
    .is("resolved_at", null)
    .is("confirmed_at", null);
  if (balanceCandidates.error) {
    fail("Follower balance candidates", safeDiagnostic(balanceCandidates.error.message));
    return false;
  }
  const balanceCandidateCount = Number(balanceCandidates.count ?? 0);
  if (balanceCandidateCount > 0) {
    warn(
      "Follower balance candidates",
      `${balanceCandidateCount} first-snapshot difference(s) await confirmation; they do not block entries or trigger exits`,
    );
  }

  const unresolvedClaims = await db
    .from("sell_signal_claims")
    .select("status,updated_at")
    .eq("user_id", cfg.user_id)
    .in("status", ["claimed", "submitted", "uncertain"]);
  if (unresolvedClaims.error) {
    fail("Durable sell claims", safeDiagnostic(unresolvedClaims.error.message));
    return false;
  }
  const claimGate = evaluateSellClaimGate(unresolvedClaims.data ?? []);
  if (claimGate.blocked) {
    fail("Durable sell claims", {
      total: claimGate.total,
      uncertain: claimGate.uncertain,
      submitted: claimGate.submitted,
      claimed: claimGate.claimed,
      staleSubmitted: claimGate.staleSubmitted,
      staleClaimed: claimGate.staleClaimed,
      invalidTimestamp: claimGate.invalidTimestamp,
      action:
        "do not restart; reconcile every in-flight or uncertain sell against chain and wallet balance, then rerun doctor",
    });
    return false;
  }

  const unresolvedEntryClaims = await db
    .from("entry_signal_claims")
    .select("status")
    .eq("user_id", cfg.user_id)
    .in("status", ["claimed", "submitted", "landed", "uncertain"]);
  if (unresolvedEntryClaims.error) {
    fail("Durable entry claims", safeDiagnostic(unresolvedEntryClaims.error.message));
    return false;
  }
  const entryClaimGate = evaluateEntryClaimGate(unresolvedEntryClaims.data ?? []);
  if (entryClaimGate.blocked) {
    fail("Durable entry claims", {
      total: entryClaimGate.total,
      uncertain: entryClaimGate.uncertain,
      landed: entryClaimGate.landed,
      submitted: entryClaimGate.submitted,
      claimed: entryClaimGate.claimed,
      action:
        "do not restart; reconcile every unfinished buy against its exact planned position and chain signature, then rerun doctor",
    });
    return false;
  }

  pass(
    "Sell-coverage schema",
    "persistent RPC cursors, target links, durable entry/sell claims, outflow observations, and archive fields are available",
  );
  pass("RPC cursor health", "no monitored wallet backlog is recorded");
  pass("Follower balance alerts", "no unresolved follower-wallet balance mismatch is recorded");
  pass("Durable sell claims", "no claimed, submitted, or uncertain exit is recorded");
  pass("Durable entry claims", "no claimed, submitted, landed, or uncertain entry is recorded");
  line("Sell-coverage settings", {
    direct_target_sell_exit_mode: cfg.direct_target_sell_exit_mode,
    direct_target_sell_exit_pct: targetSellPct,
    terminal_outflow_exit_enabled: cfg.terminal_outflow_exit_enabled,
    terminal_outflow_exit_pct: terminalOutflowPct,
    target_terminal_outflow_exit_enabled: cfg.target_terminal_outflow_exit_enabled,
    target_terminal_outflow_exit_pct: targetTerminalOutflowPct,
  });
  if (cfg.terminal_outflow_exit_enabled) {
    warn(
      "Defensive custody-outflow exit",
      "ON — an untrackable deposit can trigger an exit even though a deposit is not proof of a sale",
    );
  }
  if (cfg.target_terminal_outflow_exit_enabled) {
    warn(
      "High-risk target custody-outflow exit",
      "ON — a linked target deposit can trigger an exit even though a CEX/vault deposit is not proof of a sale",
    );
  }
  return true;
}

async function checkFollowerBalanceIntegrity(userId: string): Promise<boolean> {
  try {
    const store = createSupabaseFollowerBalanceStore(db);
    const balances = await store.loadActiveBalances(userId);
    const inspection = await inspectFollowerBalances(
      balances,
      createRpcFollowerTokenBalanceReader(rpc),
      6,
    );
    if (inspection.failedReadCount > 0) {
      fail("Follower balance reconciliation", {
        checkedBalanceCount: inspection.checkedBalanceCount,
        failedReadCount: inspection.failedReadCount,
        safety: "failed lookups are never classified as sales",
      });
      return false;
    }
    const mismatchCount = inspection.observations.filter(
      (observation) => observation.shortfallAmount > 0,
    ).length;
    if (mismatchCount > 0) {
      warn("Follower balance reconciliation", {
        checkedBalanceCount: inspection.checkedBalanceCount,
        candidateMismatchCount: mismatchCount,
        safety:
          "one snapshot is only a candidate; the worker requires a second stable snapshot before blocking entries and never triggers an exit",
      });
      return true;
    }
    pass("Follower balance reconciliation", {
      checkedBalanceCount: inspection.checkedBalanceCount,
      mismatchCount: 0,
    });
    return true;
  } catch (err) {
    fail(
      "Follower balance reconciliation",
      `read-only database or RPC check failed (${safeDiagnostic(err).length > 0 ? "see sanitized local worker diagnostics" : "unknown error"})`,
    );
    return false;
  }
}

function checkJitoTipAccounts() {
  const configured = (env.JITO_TIP_ACCOUNTS ?? "")
    .split(",")
    .map((row) => row.trim())
    .filter(Boolean);
  const unique = new Set(configured);
  const invalid = configured.filter((wallet) => !OFFICIAL_JITO_TIP_ACCOUNTS.has(wallet));
  if (configured.length !== 8 || unique.size !== 8 || invalid.length > 0) {
    fail("Jito tip accounts", {
      configured: configured.length,
      unique: unique.size,
      invalidCount: invalid.length,
    });
  } else {
    pass("Jito tip accounts", "all 8 configured accounts match Jito's official list");
  }
}

async function loadConfig(): Promise<BotConfigRow | null> {
  let lastError = "unknown database error";
  const attempts = 2;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const byUser = await db
        .from("bot_config")
        .select("*")
        .eq("user_id", env.HELIX_USER_ID)
        .maybeSingle();
      if (!byUser.error) {
        if (byUser.data) return byUser.data as BotConfigRow;
        const any = await db
          .from("bot_config")
          .select("*")
          .not("target_wallet", "is", null)
          .neq("target_wallet", "")
          .order("updated_at", { ascending: false })
          .limit(1);
        if (!any.error) {
          const row = any.data?.[0] as BotConfigRow | undefined;
          if (row) {
            throw new Error(
              "HELIX_USER_ID mismatch: worker identity does not match the configured dashboard row",
            );
          }
          return null;
        }
        lastError = safeDiagnostic(any.error.message);
      } else {
        lastError = safeDiagnostic(byUser.error.message);
      }
    } catch (err) {
      const message = safeDiagnostic(err);
      if (message.startsWith("HELIX_USER_ID mismatch")) throw err;
      lastError = message;
    }
    if (attempt < attempts) {
      line("Database retry", `attempt ${attempt}/${attempts} failed; retrying in ${attempt}s`);
      await delay(attempt * 1000);
    }
  }
  throw new Error(`bot_config query failed after ${attempts} attempts: ${lastError}`);
}

async function loadFundingKey(userId: string) {
  const { data, error } = await db
    .from("funding_keys")
    .select("ciphertext")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`funding_keys query failed: ${safeDiagnostic(error.message)}`);
  if (!data) return null;
  return decryptPrivateKey(data.ciphertext);
}

function validatePubkey(label: string, value: string | null | undefined): PublicKey | null {
  if (!value) {
    fail(label, "missing");
    return null;
  }
  try {
    const key = new PublicKey(value);
    pass(label, redactedIdentifier(key.toBase58()));
    return key;
  } catch {
    fail(label, "invalid public key");
    return null;
  }
}

function amountFromTokenBalance(balance: TokenBalance) {
  return Number(balance?.uiTokenAmount?.uiAmountString ?? balance?.uiTokenAmount?.uiAmount ?? 0);
}

function analyzeTargetTx(tx: ParsedTransactionWithMeta, target: string) {
  const meta = tx?.meta;
  const accountKeys = (tx?.transaction?.message?.accountKeys ?? []).map(
    (key) => key?.pubkey?.toBase58?.() ?? String(key?.pubkey ?? key),
  );
  const targetIndex = accountKeys.indexOf(target);
  const preLamports = targetIndex >= 0 ? Number(meta?.preBalances?.[targetIndex] ?? 0) : 0;
  const postLamports = targetIndex >= 0 ? Number(meta?.postBalances?.[targetIndex] ?? 0) : 0;
  const nativeSolDelta = (postLamports - preLamports) / 1e9;
  const swapSignal = hasVerifiedSwapSignal(meta?.logMessages ?? []);

  const rows = new Map<string, { mint: string; pre: number; post: number; decimals: number }>();
  const ingest = (balances: readonly TokenBalance[], field: "pre" | "post") => {
    for (const b of balances ?? []) {
      if (b?.owner !== target || b?.mint === WSOL) continue;
      const row = rows.get(b.mint) ?? {
        mint: b.mint,
        pre: 0,
        post: 0,
        decimals: Number(b?.uiTokenAmount?.decimals ?? 0),
      };
      row[field] += amountFromTokenBalance(b);
      rows.set(b.mint, row);
    }
  };
  ingest(meta?.preTokenBalances ?? [], "pre");
  ingest(meta?.postTokenBalances ?? [], "post");

  const deltas = Array.from(rows.values())
    .map((row) => ({
      mint: redactedIdentifier(row.mint),
      delta: Number((row.post - row.pre).toFixed(12)),
      decimals: row.decimals,
    }))
    .filter((row) => Math.abs(row.delta) > 1e-12);

  const decodedEvents = decodeParsedTransaction(target, tx);
  const decodedTargetBuys = decodedEvents.filter(
    (event) => event.kind === "swap" && event.wallet === target && event.side === "buy",
  );
  const decodedTargetTransfers = decodedEvents.filter(
    (event) => event.kind === "transfer" && event.from === target,
  );
  const entryCandidates = decodedTargetBuys.filter(
    (event) => event.tokenMint !== WSOL && !STABLECOIN_MINTS.has(event.tokenMint),
  );

  return {
    signature: redactedIdentifier(tx?.transaction?.signatures?.[0]),
    nativeSolDelta,
    swapSignal,
    targetTokenDeltas: deltas,
    liveDecoderEvents: decodedEvents.map((event) => ({
      kind: event.kind,
      side: event.kind === "swap" ? event.side : undefined,
      tokenMint: redactedIdentifier(event.tokenMint),
      source: event.source ?? "unknown",
      delivery: event.delivery ?? "unknown",
    })),
    decodedTargetBuyCandidateCount: entryCandidates.length,
    decodedTargetTransferCount: decodedTargetTransfers.length,
    liveWorkerEntryCandidate: entryCandidates.length > 0,
    liveWorkerFeedEvent: decodedEvents.length > 0,
  };
}

async function main() {
  console.log("\nHelix Doctor — copy-trading pipeline check\n");
  line("HELIX_USER_ID", redactedIdentifier(env.HELIX_USER_ID));
  line("RPC_URL host", new URL(env.RPC_URL).host);
  line("YELLOWSTONE_GRPC_URL host", new URL(env.YELLOWSTONE_GRPC_URL).host);
  line("YELLOWSTONE_TOKEN set", env.YELLOWSTONE_TOKEN ? "yes" : "no");
  line("JUPITER_API_KEY set", env.JUPITER_API_KEY ? "yes" : "no");
  await checkJupiterApi();

  const cfg = await loadConfig();
  if (!cfg) {
    fail("Config", "no bot_config row found in Supabase");
    return;
  }

  const targets = Array.from(
    new Set(
      [cfg.target_wallet ?? "", ...(cfg.additional_target_wallets ?? [])]
        .map((wallet) => wallet.trim())
        .filter(Boolean),
    ),
  );
  pass("Config row", {
    user_id: redactedIdentifier(cfg.user_id),
    target_wallet_count: targets.length,
    entries_enabled: cfg.enabled,
  });
  // Keep the fallback route deployment-ready too. A future route switch must
  // not expose a latent incomplete or non-official Jito account list.
  checkJitoTipAccounts();
  if (!cfg.enabled)
    pass("Entries switch", "OFF — deployment-safe; exits remain active, but buys are paused");
  else
    fail("Entries switch", "ON — turn Entries OFF before migration, deployment, or worker restart");

  if (cfg.coordinated_mode_enabled === undefined) {
    fail(
      "Coordinated-mode migration",
      "missing — run supabase/coordinated-mode-migration.sql before deploying this worker",
    );
    return;
  }

  if (!(await checkConvictionModeSchema(cfg, targets.length))) return;
  if (!(await checkCustodyJourneySchema(cfg))) return;
  if (env.REVIVAL_ONLY_MODE) {
    fail(
      "Legacy REVIVAL_ONLY_MODE",
      "ON — this is a separate money-moving entry route; turn it OFF for shadow-only Revival collection",
    );
  } else {
    pass("Legacy REVIVAL_ONLY_MODE", "OFF — Revival Campaign collection remains observation-only");
  }
  if (!(await checkRevivalTrackerSchema(cfg))) return;

  if (
    cfg.follower_seller_exit_enabled === undefined ||
    cfg.follower_seller_exit_count === undefined ||
    cfg.follower_seller_exit_pct === undefined ||
    cfg.target_inactivity_exit_enabled === undefined ||
    cfg.target_inactivity_hours === undefined
  ) {
    fail(
      "Main-mode exit migration",
      "missing — run supabase/main-mode-exits-migration.sql before deploying this worker",
    );
    return;
  }

  if (!(await checkSellCoverageSchema(cfg))) return;
  if (!(await checkFollowerBalanceIntegrity(cfg.user_id))) return;

  const schemaChecks = await Promise.all([
    db
      .from("positions")
      .select("entry_mode,coordinated_exit_triggered,follower_seller_exit_triggered")
      .limit(1),
    db.from("follower_wallets").select("first_sell_at,last_seen_signature,last_seen_slot").limit(1),
  ]);
  if (schemaChecks[0].error || schemaChecks[1].error) {
    fail(
      "Coordinated-mode schema",
      safeDiagnostic(schemaChecks[0].error?.message ?? schemaChecks[1].error?.message),
    );
    return;
  }
  pass("Coordinated-mode schema", "required config, position, and follower columns are present");
  await checkStrategyLabSchema(cfg.user_id);

  line("Buy/filter settings", {
    fixed_buy_usd: cfg.fixed_buy_usd,
    min_target_buy_usd: cfg.min_target_buy_usd,
    mc_min_usd: cfg.mc_min_usd,
    mc_max_usd: cfg.mc_max_usd,
    liq_min_usd: cfg.liq_min_usd,
    liq_max_usd: cfg.liq_max_usd,
    token_age_filter_enabled: cfg.token_age_filter_enabled,
    token_age_min_minutes: cfg.token_age_min_minutes,
    token_age_max_minutes: cfg.token_age_max_minutes,
    pump_fun_only: cfg.pump_fun_only,
    require_socials: cfg.require_socials,
    only_first_buy_ever: cfg.only_first_buy_ever,
    only_once_per_token: cfg.only_once_per_token,
    execution_route: cfg.execution_route,
    follower_seller_exit_enabled: cfg.follower_seller_exit_enabled,
    follower_seller_exit_count: cfg.follower_seller_exit_count,
    follower_seller_exit_pct: cfg.follower_seller_exit_pct,
    target_inactivity_exit_enabled: cfg.target_inactivity_exit_enabled,
    target_inactivity_hours: cfg.target_inactivity_hours,
  });

  line("Custody Journey settings", {
    custody_journey_enabled: cfg.custody_journey_enabled,
    observation_only: true,
    max_hops: 8,
    max_active_wallets_per_journey: 250,
  });

  line("Revival Campaign tracker", {
    revival_tracker_enabled: cfg.revival_tracker_enabled,
    mode: "shadow_only",
    legacy_revival_only_mode_live_entry_enabled: env.REVIVAL_ONLY_MODE,
    seed_market_cap_min_usd: cfg.revival_market_cap_min_usd,
    seed_market_cap_max_usd: cfg.revival_market_cap_max_usd,
    first_target_buy_can_trade: false,
  });

  line("Conviction Mode settings", {
    conviction_mode_enabled: cfg.conviction_mode_enabled,
    conviction_trading_mode: cfg.conviction_trading_mode,
    conviction_rapid_follow_enabled: cfg.conviction_rapid_follow_enabled,
    conviction_primary_window_minutes: cfg.conviction_primary_window_minutes,
    conviction_score_threshold: cfg.conviction_score_threshold,
    conviction_top_n: cfg.conviction_top_n,
    conviction_min_commitment_usd: cfg.conviction_min_commitment_usd,
    conviction_min_recent_net_inflow_usd: cfg.conviction_min_recent_net_inflow_usd,
    conviction_min_velocity_usd_per_minute: cfg.conviction_min_velocity_usd_per_minute,
    conviction_min_acceleration_ratio: cfg.conviction_min_acceleration_ratio,
    conviction_min_converged_wallets: cfg.conviction_min_converged_wallets,
    conviction_min_individual_buy_usd: cfg.conviction_min_individual_buy_usd,
    conviction_market_cap_filter_enabled: cfg.conviction_market_cap_filter_enabled,
    conviction_liquidity_filter_enabled: cfg.conviction_liquidity_filter_enabled,
    conviction_token_age_filter_enabled: cfg.conviction_token_age_filter_enabled,
    conviction_max_position_per_token_usd: cfg.conviction_max_position_per_token_usd,
    conviction_distribution_sell_ratio: cfg.conviction_distribution_sell_ratio,
    conviction_distribution_min_sells_usd: cfg.conviction_distribution_min_sells_usd,
    conviction_distribution_wallet_count: cfg.conviction_distribution_wallet_count,
    conviction_inactivity_minutes: cfg.conviction_inactivity_minutes,
    conviction_rank_loss_grace_seconds: cfg.conviction_rank_loss_grace_seconds,
    conviction_weight_total:
      Number(cfg.conviction_weight_net_commitment) +
      Number(cfg.conviction_weight_velocity) +
      Number(cfg.conviction_weight_acceleration) +
      Number(cfg.conviction_weight_convergence) +
      Number(cfg.conviction_weight_persistence),
    configured_tier_count: cfg.conviction_tier_buy_amounts_usd?.length ?? 0,
    configured_tier_exposure_usd: cfg.conviction_tier_buy_amounts_usd
      ?.map(Number)
      .reduce((sum, amount) => sum + amount, 0),
  });

  line("Coordinated-wallet settings", {
    coordinated_mode_enabled: cfg.coordinated_mode_enabled,
    coordinated_fixed_buy_usd: cfg.coordinated_fixed_buy_usd,
    coordinated_target_wallet_count: cfg.coordinated_target_wallet_count,
    coordinated_window_seconds: cfg.coordinated_window_seconds,
    coordinated_mc_range_usd: [cfg.coordinated_mc_min_usd, cfg.coordinated_mc_max_usd],
    coordinated_coin_age_range_minutes: [
      cfg.coordinated_coin_age_min_minutes,
      cfg.coordinated_coin_age_max_minutes,
    ],
    coordinated_target_buy_range_usd: [
      cfg.coordinated_target_buy_min_usd,
      cfg.coordinated_target_buy_max_usd,
    ],
    coordinated_first_buy_only: cfg.coordinated_first_buy_only,
    coordinated_once_per_token: cfg.coordinated_once_per_token,
    coordinated_follower_sell_count: cfg.coordinated_follower_sell_count,
    coordinated_follower_sell_pct: cfg.coordinated_follower_sell_pct,
    coordinated_inactivity_hours: cfg.coordinated_inactivity_hours,
  });

  if (
    cfg.coordinated_mode_enabled &&
    targets.length < Number(cfg.coordinated_target_wallet_count)
  ) {
    fail(
      "Coordinated target count",
      `needs ${cfg.coordinated_target_wallet_count}; only ${targets.length} configured`,
    );
    return;
  }
  for (const [index, wallet] of targets.entries()) {
    if (!validatePubkey(`Target wallet ${index + 1}`, wallet)) return;
  }

  const target = validatePubkey("Target wallet", cfg.target_wallet);
  if (!target) return;

  let secret: string | null = null;
  let fundingKeyErrored = false;
  try {
    secret = await loadFundingKey(cfg.user_id);
  } catch (err) {
    fundingKeyErrored = true;
    fail("Funding key", safeDiagnostic(err));
    fail(
      "Next step",
      "On the VPS run: npm --prefix worker run save-key — paste the Phantom private key there, then rerun doctor",
    );
  }
  if (!secret) {
    if (!fundingKeyErrored) {
      fail("Funding key", `missing for config user ${redactedIdentifier(cfg.user_id)}`);
      fail(
        "Next step",
        "On the VPS run: npm --prefix worker run save-key — paste the Phantom private key there, then rerun doctor",
      );
    }
  } else {
    try {
      const decoded = bs58.decode(secret.trim());
      if (decoded.length !== 64)
        fail("Funding key", `decoded to ${decoded.length} bytes, expected 64`);
      else {
        const signer = Keypair.fromSecretKey(decoded);
        const sol = (await rpc.getBalance(signer.publicKey, "confirmed")) / 1e9;
        pass("Funding key", {
          wallet: redactedIdentifier(signer.publicKey.toBase58()),
          solBalance: sol,
        });
        if (sol < 0.02) fail("Funding wallet balance", "very low SOL balance; buys may fail");
      }
    } catch (err) {
      fail("Funding key decrypt/parse", safeDiagnostic(err));
    }
  }

  const { data: heartbeat, error: heartbeatError } = await db
    .from("worker_heartbeat")
    .select(
      "updated_at,geyser_connected,last_geyser_message_at,decoded_event_count,rpc_last_poll_at,rpc_last_success_at,rpc_backlog_wallet_count,monitoring_degraded,follower_balance_last_checked_at,follower_balance_candidate_count,follower_balance_mismatch_count,follower_balance_reconciliation_degraded,follower_balance_last_error,funding_key_ready,funding_key_checked_at,last_error,wallet_holdings,observed_follower_holdings",
    )
    .eq("user_id", cfg.user_id)
    .maybeSingle();
  if (heartbeatError) {
    fail("Worker heartbeat table", safeDiagnostic(heartbeatError.message));
  } else if (!heartbeat) {
    fail("Worker heartbeat", `missing for config user ${redactedIdentifier(cfg.user_id)}`);
  } else {
    const ageSeconds = Math.max(
      0,
      Math.round((Date.now() - Date.parse(heartbeat.updated_at)) / 1000),
    );
    const rpcLastSuccessAt = heartbeat.rpc_last_success_at
      ? Date.parse(heartbeat.rpc_last_success_at)
      : Number.NaN;
    const rpcSuccessAgeSeconds = Number.isFinite(rpcLastSuccessAt)
      ? Math.max(0, Math.round((Date.now() - rpcLastSuccessAt) / 1000))
      : null;
    const rpcBacklogWalletCount = Number(heartbeat.rpc_backlog_wallet_count ?? 0);
    const monitoringDegraded = heartbeat.monitoring_degraded === true;
    const followerBalanceMismatchCount = Number(heartbeat.follower_balance_mismatch_count ?? 0);
    const followerBalanceCandidateCount = Number(heartbeat.follower_balance_candidate_count ?? 0);
    const followerBalanceReconciliationDegraded =
      heartbeat.follower_balance_reconciliation_degraded === true;
    const heartbeatDetails = {
      ageSeconds,
      geyserConnected: heartbeat.geyser_connected,
      lastGeyserMessageAt: heartbeat.last_geyser_message_at,
      decodedEventCount: Number(heartbeat.decoded_event_count),
      rpcLastPollAt: heartbeat.rpc_last_poll_at,
      rpcLastSuccessAt: heartbeat.rpc_last_success_at,
      rpcSuccessAgeSeconds,
      rpcBacklogWalletCount,
      monitoringDegraded,
      followerBalanceLastCheckedAt: heartbeat.follower_balance_last_checked_at,
      followerBalanceCandidateCount,
      followerBalanceMismatchCount,
      followerBalanceReconciliationDegraded,
      followerBalanceLastError: heartbeat.follower_balance_last_error
        ? safeDiagnostic(heartbeat.follower_balance_last_error)
        : null,
      fundingKeyReady: heartbeat.funding_key_ready,
      fundingKeyCheckedAt: heartbeat.funding_key_checked_at,
      lastError: heartbeat.last_error ? safeDiagnostic(heartbeat.last_error) : null,
      walletHoldingCount: Array.isArray(heartbeat.wallet_holdings)
        ? heartbeat.wallet_holdings.length
        : 0,
      observedFollowerHoldingCount: Array.isArray(heartbeat.observed_follower_holdings)
        ? heartbeat.observed_follower_holdings.length
        : 0,
    };
    if (ageSeconds > 45) fail("Worker heartbeat", heartbeatDetails);
    else if (followerBalanceMismatchCount > 0)
      fail("Worker monitoring", {
        ...heartbeatDetails,
        reason: "follower balance mismatch blocks new entries but does not trigger an exit",
      });
    else if (heartbeat.follower_balance_last_checked_at && followerBalanceReconciliationDegraded)
      fail("Worker monitoring", {
        ...heartbeatDetails,
        reason: "follower balance reconciliation is degraded",
      });
    else if (rpcBacklogWalletCount > 0)
      fail("Worker monitoring", {
        ...heartbeatDetails,
        reason: "RPC catch-up has not drained for every monitored wallet",
      });
    else if (monitoringDegraded)
      fail("Worker monitoring", {
        ...heartbeatDetails,
        reason: "an entry-safety monitoring gate is degraded",
      });
    else pass("Worker heartbeat", heartbeatDetails);
  }

  try {
    const version = await rpc.getVersion();
    pass("RPC connection", version);
  } catch (err) {
    fail("RPC connection", safeDiagnostic(err));
    return;
  }

  const targetSol = (await rpc.getBalance(target, "confirmed")) / 1e9;
  pass("Target wallet RPC lookup", { solBalance: targetSol });

  const signatures = await rpc.getSignaturesForAddress(target, { limit: 10 }, "confirmed");
  if (signatures.length === 0) {
    warn("Recent target activity", "RPC sees no recent transactions for this target wallet");
    return;
  }

  pass(
    "Recent target activity",
    signatures.map((sig) => ({
      signature: redactedIdentifier(sig.signature),
      time: sig.blockTime ? new Date(sig.blockTime * 1000).toISOString() : null,
      failed: sig.err !== null,
    })),
  );

  const txs = await rpc.getParsedTransactions(
    signatures.slice(0, 5).map((sig) => sig.signature),
    {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    },
  );
  const analyses = txs
    .filter((tx): tx is ParsedTransactionWithMeta => tx !== null)
    .map((tx) => analyzeTargetTx(tx, target.toBase58()));
  line("Last 5 tx decoder check", analyses);

  const entryCandidate = analyses.find((row) => row.liveWorkerEntryCandidate);
  const feedEvent = analyses.find((row) => row.liveWorkerFeedEvent);
  if (entryCandidate)
    pass(
      "Decoder verdict",
      "At least one recent tx decoded as a target token-buy candidate. Entry settings and market-data filters still decide whether it is copied.",
    );
  else if (feedEvent)
    pass(
      "Decoder verdict",
      "Recent target activity reached the worker decoder, but the last five transactions contained no safe token-buy candidate. Transfers, sells, and stablecoin receipts do not trigger entries.",
    );
  else
    warn(
      "Decoder verdict",
      "Recent target txs do not look like target buys/transfers to this decoder. The target may be buying from another wallet/signing account, or the tx format needs a new parser.",
    );

  console.log(
    '\nNext command if this passes but bot is silent:\npm2 logs helix-worker-v3 --lines 200 --nostream | grep -E "stream heartbeat|database heartbeat|feed event|target buy candidate|filtered|submitting copy buy|copy buy|Pump.fun|funding wallet"\n',
  );
}

main()
  .then(() => {
    if (failureCount > 0) {
      console.log(`\n❌ Doctor summary: ${failureCount} failure(s), ${warningCount} warning(s)\n`);
      process.exitCode = 1;
    } else {
      console.log(`\n✅ Doctor summary: PASS (${warningCount} warning(s))\n`);
    }
  })
  .catch((err) => {
    fail("Doctor crashed", safeDiagnostic(err));
    console.log(`\n❌ Doctor summary: ${failureCount} failure(s), ${warningCount} warning(s)\n`);
    process.exit(1);
  });
