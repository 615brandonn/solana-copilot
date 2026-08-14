// Placeholder types for your own Supabase project.
// Replace with generated types from `supabase gen types typescript` when you have them.

import type {
  CustodyJourneyEventRow,
  CustodyJourneyRow,
  CustodyJourneyWalletRow,
  CustodyPendingEventRow,
  CustodyWorkerHeartbeatRow,
  CustodyWalletProfileRow,
} from "./custody";

export type BotConfigRow = {
  id: string;
  user_id: string;
  enabled: boolean;
  target_wallet: string | null;
  additional_target_wallets: string[];
  execution_route: string;
  jito_tip_sol: number;
  fixed_buy_usd: number;
  custody_journey_enabled: boolean;
  crew_exit_enabled?: boolean;
  crew_exit_pct?: number;
  crew_exit_min_mints?: number;
  conviction_mode_enabled: boolean;
  conviction_trading_mode: "shadow" | "live";
  conviction_rapid_follow_enabled: boolean;
  conviction_primary_window_minutes: 5 | 30 | 60;
  conviction_score_threshold: number;
  conviction_top_n: number;
  conviction_min_commitment_usd: number;
  conviction_min_recent_net_inflow_usd: number;
  conviction_min_velocity_usd_per_minute: number;
  conviction_min_acceleration_ratio: number;
  conviction_min_converged_wallets: number;
  conviction_two_wallet_window_seconds: number;
  conviction_three_wallet_window_seconds: number;
  conviction_min_individual_buy_usd: number;
  conviction_market_cap_filter_enabled: boolean;
  conviction_market_cap_min_usd: number;
  conviction_market_cap_max_usd: number;
  conviction_liquidity_filter_enabled: boolean;
  conviction_liquidity_min_usd: number;
  conviction_liquidity_max_usd: number;
  conviction_token_age_filter_enabled: boolean;
  conviction_token_age_min_minutes: number;
  conviction_token_age_max_minutes: number;
  conviction_max_position_per_token_usd: number;
  conviction_distribution_sell_ratio: number;
  conviction_distribution_min_sells_usd: number;
  conviction_distribution_wallet_count: number;
  conviction_inactivity_minutes: number;
  conviction_rank_loss_grace_seconds: number;
  conviction_weight_net_commitment: number;
  conviction_weight_velocity: number;
  conviction_weight_acceleration: number;
  conviction_weight_convergence: number;
  conviction_weight_persistence: number;
  conviction_tier_commitment_thresholds_usd: number[];
  conviction_tier_buy_amounts_usd: number[];
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
  network_scaling_enabled: boolean;
  starter_position_pct: number;
  max_position_pct: number;
  new_entry_reserve_pct: number;
  target_copy_ratio_pct: number;
  min_scale_buy_usd: number;
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
  require_24h_uptrend: boolean;
  large_buy_scanner_enabled: boolean;
  large_buy_scanner_max_mc_usd: number;
  large_buy_scanner_min_buy_usd: number;
  large_buy_scanner_multiplier: number;
  large_buy_scanner_history_window: number;
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
  updated_at: string;
};

export type PositionRow = {
  id: string;
  user_id: string;
  token_mint: string;
  entry_price_usd: number;
  amount_tokens: number;
  amount_remaining: number;
  entry_tx_sig: string;
  entry_slot: number | null;
  opened_at: string;
  closed_at: string | null;
  network_target_spend_usd: number;
  bot_cost_basis_usd: number;
  campaign_bankroll_usd: number;
  root_buy_count: number;
  last_root_buy_at: string | null;
  last_root_buy_wallet: string | null;
  entry_mode: "regular" | "coordinated";
  coordinated_exit_triggered: boolean;
  follower_seller_exit_triggered: boolean;
};

export type TradeRow = {
  id: string;
  user_id: string;
  position_id: string | null;
  side: "buy" | "sell";
  token_mint: string;
  amount_tokens: number;
  amount_usd: number | null;
  price_usd: number | null;
  pnl_pct: number | null;
  tx_sig: string;
  reason: string | null;
  latency_ms: number | null;
  route: string | null;
  valuation_source: string | null;
  created_at: string;
};

export type FundingKeyRow = {
  id: string;
  user_id: string;
  wallet_pubkey: string;
  ciphertext: string;
  created_at: string;
};

export type WorkerHeartbeatRow = {
  user_id: string;
  target_wallet: string | null;
  started_at: string;
  updated_at: string;
  geyser_connected: boolean;
  last_geyser_message_at: string | null;
  decoded_event_count: number;
  rpc_last_poll_at: string | null;
  rpc_last_success_at: string | null;
  rpc_backlog_wallet_count: number;
  monitoring_degraded: boolean;
  follower_balance_last_checked_at: string | null;
  follower_balance_candidate_count: number;
  follower_balance_mismatch_count: number;
  follower_balance_reconciliation_degraded: boolean;
  follower_balance_last_error: string | null;
  funding_key_ready: boolean;
  funding_key_checked_at: string | null;
  funding_wallet_pubkey: string | null;
  last_error: string | null;
  wallet_holdings: Array<{ token_mint: string; amount: number; decimals: number }>;
  observed_follower_holdings: Array<{
    token_mint: string;
    wallet: string;
    amount: number;
    decimals: number;
    source_target_count: number;
    last_updated: string;
  }>;
};

export type FollowerBalanceAlertRow = {
  id: string;
  user_id: string;
  wallet: string;
  token_mint: string;
  expected_amount: number;
  observed_amount: number;
  shortfall_amount: number;
  active_position_count: number;
  occurrence_count: number;
  first_detected_at: string;
  last_detected_at: string;
  confirmed_at: string | null;
  resolved_at: string | null;
  resolution_reason: "balance_recovered" | "no_longer_active" | null;
  resolution_observed_amount: number | null;
};

export type StrategyObservationRow = {
  id: string;
  user_id: string;
  target_wallet: string;
  event_key: string;
  tx_sig: string;
  slot: number | null;
  source: "geyser" | "rpc" | "unknown";
  event_at: string;
  detected_at: string;
  updated_at: string;
  relationship: "target" | "follower" | "observed";
  event_kind: "swap" | "transfer";
  side: "buy" | "sell" | null;
  actor_wallet: string;
  from_wallet: string | null;
  to_wallet: string | null;
  token_mint: string;
  amount_tokens: number;
  decimals: number;
  sol_delta: number | null;
  amount_usd: number | null;
  is_pump_fun: boolean | null;
  position_id: string | null;
  market_cap_usd: number | null;
  liquidity_usd: number | null;
  has_socials: boolean | null;
  bot_decision:
    | "filtered"
    | "skipped"
    | "copy_submitted"
    | "copied"
    | "mirror_submitted"
    | "mirrored"
    | "tracked"
    | "failed"
    | null;
  bot_reason: string | null;
  bot_tx_sig: string | null;
  reaction_ms: number | null;
  execution_ms: number | null;
  metadata: Record<string, unknown>;
};

export type StrategyRecentObservation = Pick<
  StrategyObservationRow,
  | "event_key"
  | "tx_sig"
  | "event_at"
  | "relationship"
  | "event_kind"
  | "side"
  | "actor_wallet"
  | "from_wallet"
  | "to_wallet"
  | "token_mint"
  | "amount_tokens"
  | "amount_usd"
  | "market_cap_usd"
  | "liquidity_usd"
  | "bot_decision"
  | "bot_reason"
  | "source"
>;

export type StrategyReasonCount = {
  reason: string;
  count: number;
};

export type StrategyInsights = {
  since: string;
  generated_at: string;
  total_observations: number;
  target_buys: number;
  target_sells: number;
  target_transfers: number;
  follower_sells: number;
  unique_mints: number;
  copied_buys: number;
  filtered_buys: number;
  failed_actions: number;
  median_buy_reaction_ms: number | null;
  median_buy_execution_ms: number | null;
  median_sell_reaction_ms: number | null;
  median_sell_execution_ms: number | null;
  learning_confidence_pct: number;
  top_filter_reasons: StrategyReasonCount[];
  median_target_buy_usd: number | null;
  median_entry_market_cap_usd: number | null;
  median_entry_liquidity_usd: number | null;
  average_transfer_recipients: number | null;
  most_active_hour_utc: number | null;
  recent: StrategyRecentObservation[];
};

export type ConvictionEventRow = {
  id: string;
  user_id: string;
  event_key: string;
  tx_sig: string;
  slot: number | null;
  source: "geyser" | "rpc" | "unknown";
  event_at: string;
  recorded_at: string;
  wallet: string;
  from_wallet: string | null;
  to_wallet: string | null;
  token_mint: string;
  classification:
    | "DEX_BUY"
    | "DEX_SELL"
    | "INTERNAL_CLUSTER_TRANSFER"
    | "EXTERNAL_TRANSFER_IN"
    | "EXTERNAL_TRANSFER_OUT"
    | "UNKNOWN";
  classification_reliable: boolean;
  amount_tokens: number;
  amount_usd: number | null;
  market_cap_usd: number | null;
  liquidity_usd: number | null;
  metadata: Record<string, unknown>;
};

export type ConvictionTokenStateRow = {
  user_id: string;
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
  wallet_convergence_count: number;
  market_cap_usd: number | null;
  market_cap_at_first_cluster_buy_usd: number | null;
  liquidity_usd: number | null;
  our_current_position_usd: number;
  net_flow_1m_usd: number;
  net_flow_5m_usd: number;
  net_flow_30m_usd: number;
  net_flow_60m_usd: number;
  capital_velocity_usd_per_minute: number;
  capital_acceleration_ratio: number;
  buy_size_acceleration_ratio: number;
  conviction_score: number;
  conviction_state:
    | "TESTING"
    | "WATCHING"
    | "ACCUMULATING"
    | "BETTING"
    | "HIGH_CONVICTION"
    | "DISTRIBUTING";
  score_reasons: unknown[];
  current_rank: number | null;
  previous_rank: number | null;
  rank_direction: "up" | "down" | "flat" | "new" | "unranked";
  time_in_top_10_seconds: number;
  time_in_top_3_seconds: number;
  time_at_rank_one_seconds: number;
  rapid_follow_status: "inactive" | "active" | "stopped";
  data_reliable: boolean;
  rolling_metrics: Record<string, unknown>;
  last_ranked_at: string | null;
  updated_at: string;
};

export type ConvictionRankHistoryRow = {
  id: string;
  user_id: string;
  token_mint: string;
  window_minutes: 5 | 30 | 60;
  rank: number;
  previous_rank: number | null;
  rank_direction: "up" | "down" | "flat" | "new";
  conviction_score: number;
  net_cluster_investment_usd: number;
  net_flow_usd: number;
  capital_velocity_usd_per_minute: number;
  capital_acceleration_ratio: number;
  buy_size_acceleration_ratio: number;
  wallet_convergence_count: number;
  continuing_accumulation: boolean;
  distribution_penalty: number;
  ranking_at: string;
  metadata: Record<string, unknown>;
};

export type ConvictionTransitionRow = {
  id: string;
  user_id: string;
  transition_key: string;
  token_mint: string | null;
  event_type: string;
  previous_state: ConvictionTokenStateRow["conviction_state"] | null;
  new_state: ConvictionTokenStateRow["conviction_state"] | null;
  previous_score: number | null;
  new_score: number | null;
  net_cluster_investment_usd: number | null;
  capital_velocity_usd_per_minute: number | null;
  wallet_convergence_count: number | null;
  market_cap_usd: number | null;
  liquidity_usd: number | null;
  reasons: unknown[];
  metadata: Record<string, unknown>;
  occurred_at: string;
  recorded_at: string;
};

export type ConvictionTierRow = {
  id: string;
  user_id: string;
  token_mint: string;
  tier_number: number;
  trading_mode: "shadow" | "live";
  status:
    | "eligible"
    | "shadowed"
    | "claimed"
    | "submitted"
    | "landed"
    | "persisted"
    | "failed_pre_submit"
    | "uncertain"
    | "skipped";
  planned_position_id: string | null;
  position_id: string | null;
  source_event_key: string;
  commitment_threshold_usd: number;
  buy_usd: number;
  score: number;
  received_tokens: number | null;
  bot_tx_sig: string | null;
  reason: string | null;
  error_code: string | null;
  claimed_at: string | null;
  submission_started_at: string | null;
  landed_at: string | null;
  persisted_at: string | null;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
};

// Minimal Database shape for createClient<Database>
export type Database = {
  public: {
    Tables: {
      bot_config: {
        Row: BotConfigRow;
        Insert: Omit<BotConfigRow, "id" | "updated_at">;
        Update: Partial<BotConfigRow>;
        Relationships: [];
      };
      funding_keys: {
        Row: FundingKeyRow;
        Insert: Omit<FundingKeyRow, "id" | "created_at">;
        Update: Partial<FundingKeyRow>;
        Relationships: [];
      };
      positions: {
        Row: PositionRow;
        Insert: Omit<PositionRow, "id" | "opened_at">;
        Update: Partial<PositionRow>;
        Relationships: [];
      };
      trades: {
        Row: TradeRow;
        Insert: Omit<TradeRow, "id" | "created_at">;
        Update: Partial<TradeRow>;
        Relationships: [];
      };
      worker_heartbeat: {
        Row: WorkerHeartbeatRow;
        Insert: WorkerHeartbeatRow;
        Update: Partial<WorkerHeartbeatRow>;
        Relationships: [];
      };
      follower_balance_alerts: {
        Row: FollowerBalanceAlertRow;
        Insert: Omit<FollowerBalanceAlertRow, "id" | "first_detected_at" | "last_detected_at">;
        Update: Partial<FollowerBalanceAlertRow>;
        Relationships: [];
      };
      strategy_observations: {
        Row: StrategyObservationRow;
        Insert: Omit<StrategyObservationRow, "id" | "updated_at">;
        Update: Partial<StrategyObservationRow>;
        Relationships: [];
      };
      custody_journeys: {
        Row: CustodyJourneyRow;
        Insert: Partial<CustodyJourneyRow>;
        Update: Partial<CustodyJourneyRow>;
        Relationships: [];
      };
      custody_journey_wallets: {
        Row: CustodyJourneyWalletRow;
        Insert: Partial<CustodyJourneyWalletRow>;
        Update: Partial<CustodyJourneyWalletRow>;
        Relationships: [];
      };
      custody_journey_events: {
        Row: CustodyJourneyEventRow;
        Insert: Partial<CustodyJourneyEventRow>;
        Update: Partial<CustodyJourneyEventRow>;
        Relationships: [];
      };
      custody_wallet_profiles: {
        Row: CustodyWalletProfileRow;
        Insert: Omit<CustodyWalletProfileRow, "created_at" | "updated_at">;
        Update: Partial<CustodyWalletProfileRow>;
        Relationships: [];
      };
      custody_worker_heartbeat: {
        Row: CustodyWorkerHeartbeatRow;
        Insert: CustodyWorkerHeartbeatRow;
        Update: Partial<CustodyWorkerHeartbeatRow>;
        Relationships: [];
      };
      custody_pending_events: {
        Row: CustodyPendingEventRow;
        Insert: CustodyPendingEventRow;
        Update: Partial<CustodyPendingEventRow>;
        Relationships: [];
      };
      conviction_events: {
        Row: ConvictionEventRow;
        Insert: Omit<ConvictionEventRow, "id" | "recorded_at">;
        Update: Partial<ConvictionEventRow>;
        Relationships: [];
      };
      conviction_token_state: {
        Row: ConvictionTokenStateRow;
        Insert: Omit<ConvictionTokenStateRow, "updated_at">;
        Update: Partial<ConvictionTokenStateRow>;
        Relationships: [];
      };
      conviction_rank_history: {
        Row: ConvictionRankHistoryRow;
        Insert: Omit<ConvictionRankHistoryRow, "id">;
        Update: Partial<ConvictionRankHistoryRow>;
        Relationships: [];
      };
      conviction_transitions: {
        Row: ConvictionTransitionRow;
        Insert: Omit<ConvictionTransitionRow, "id" | "recorded_at">;
        Update: Partial<ConvictionTransitionRow>;
        Relationships: [];
      };
      conviction_tiers: {
        Row: ConvictionTierRow;
        Insert: Omit<ConvictionTierRow, "id" | "created_at" | "updated_at">;
        Update: Partial<ConvictionTierRow>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
};
