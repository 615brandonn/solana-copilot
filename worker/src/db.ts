import { createClient } from "@supabase/supabase-js";
import { fetch, WebSocket } from "undici";
import { env } from "./env.js";

function normalizeSupabaseUrl(url: string): string {
  let trimmed = url.trim();
  while (trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1);
  if (trimmed.toLowerCase().endsWith("/rest/v1")) trimmed = trimmed.slice(0, -"/rest/v1".length);
  while (trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1);
  return trimmed;
}

export const db = createClient(
  normalizeSupabaseUrl(env.BOT_SUPABASE_URL),
  env.BOT_SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: WebSocket as unknown as typeof globalThis.WebSocket },
    global: {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("apikey", env.BOT_SUPABASE_SERVICE_ROLE_KEY);
        const timeoutSignal = AbortSignal.timeout(5_000);
        const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;

        // New-format sb_secret_* keys are opaque, not JWTs. PostgREST accepts
        // them as apikey, but not as an Authorization bearer token.
        if (
          env.BOT_SUPABASE_SERVICE_ROLE_KEY.startsWith("sb_") &&
          headers.get("Authorization") === `Bearer ${env.BOT_SUPABASE_SERVICE_ROLE_KEY}`
        ) {
          headers.delete("Authorization");
        }

        return fetch(
          input as Parameters<typeof fetch>[0],
          { ...init, headers, signal } as Parameters<typeof fetch>[1],
        ) as unknown as Promise<Response>;
      },
    },
  },
);

export type BotConfigRow = {
  id: string;
  user_id: string;
  enabled: boolean;
  target_wallet: string | null;
  execution_route: "jito" | "rpc";
  jito_tip_sol: number;
  fixed_buy_usd: number;
  conviction_mode_enabled?: boolean;
  conviction_trading_mode?: "shadow" | "live";
  conviction_rapid_follow_enabled?: boolean;
  conviction_primary_window_minutes?: 5 | 30 | 60;
  conviction_score_threshold?: number;
  conviction_top_n?: number;
  conviction_min_commitment_usd?: number;
  conviction_min_recent_net_inflow_usd?: number;
  conviction_min_velocity_usd_per_minute?: number;
  conviction_min_acceleration_ratio?: number;
  conviction_min_converged_wallets?: number;
  conviction_two_wallet_window_seconds?: number;
  conviction_three_wallet_window_seconds?: number;
  conviction_min_individual_buy_usd?: number;
  conviction_market_cap_filter_enabled?: boolean;
  conviction_market_cap_min_usd?: number;
  conviction_market_cap_max_usd?: number;
  conviction_liquidity_filter_enabled?: boolean;
  conviction_liquidity_min_usd?: number;
  conviction_liquidity_max_usd?: number;
  conviction_token_age_filter_enabled?: boolean;
  conviction_token_age_min_minutes?: number;
  conviction_token_age_max_minutes?: number;
  conviction_max_position_per_token_usd?: number;
  conviction_distribution_sell_ratio?: number;
  conviction_distribution_min_sells_usd?: number;
  conviction_distribution_wallet_count?: number;
  conviction_inactivity_minutes?: number;
  conviction_rank_loss_grace_seconds?: number;
  conviction_weight_net_commitment?: number;
  conviction_weight_velocity?: number;
  conviction_weight_acceleration?: number;
  conviction_weight_convergence?: number;
  conviction_weight_persistence?: number;
  conviction_tier_commitment_thresholds_usd?: number[];
  conviction_tier_buy_amounts_usd?: number[];
  coordinated_mode_enabled: boolean;
  coordinated_fixed_buy_usd: number;
  coordinated_target_wallet_count: number;
  coordinated_window_seconds: number;
  coordinated_mc_min_usd: number;
  coordinated_mc_max_usd: number;
  coordinated_coin_age_min_minutes: number;
  coordinated_coin_age_max_minutes: number;
  coordinated_target_buy_min_usd: number;
  coordinated_target_buy_max_usd: number;
  coordinated_first_buy_only: boolean;
  coordinated_once_per_token: boolean;
  coordinated_follower_sell_count: number;
  coordinated_follower_sell_pct: number;
  coordinated_inactivity_hours: number;
  min_target_buy_usd: number;
  mc_min_usd: number;
  mc_max_usd: number;
  liq_min_usd: number;
  liq_max_usd: number;
  token_age_filter_enabled: boolean;
  token_age_min_minutes: number;
  token_age_max_minutes: number;
  pump_fun_only: boolean;
  require_socials: boolean;
  only_first_buy_ever: boolean;
  only_once_per_token: boolean;
  take_profit_enabled: boolean;
  take_profit_pct: number;
  take_profit_sell_pct: number;
  stop_loss_enabled: boolean;
  stop_loss_pct: number;
  proportional_follower_sells: boolean;
  follower_seller_exit_enabled: boolean;
  follower_seller_exit_count: number;
  follower_seller_exit_pct: number;
  target_inactivity_exit_enabled: boolean;
  target_inactivity_hours: number;
  direct_target_sell_exit_mode: "off" | "proportional" | "fixed_pct" | "full";
  direct_target_sell_exit_pct: number;
  terminal_outflow_exit_enabled: boolean;
  terminal_outflow_exit_pct: number;
  target_terminal_outflow_exit_enabled: boolean;
  target_terminal_outflow_exit_pct: number;
  additional_target_wallets?: string[];
  network_scaling_enabled?: boolean;
  starter_position_pct?: number;
  max_position_pct?: number;
  new_entry_reserve_pct?: number;
  target_copy_ratio_pct?: number;
  min_scale_buy_usd?: number;
  require_24h_uptrend?: boolean;
  large_buy_scanner_enabled?: boolean;
  large_buy_scanner_max_mc_usd?: number;
  large_buy_scanner_min_buy_usd?: number;
  large_buy_scanner_multiplier?: number;
  large_buy_scanner_history_window?: number;
};
