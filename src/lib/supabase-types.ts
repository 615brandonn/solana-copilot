// Placeholder types for your own Supabase project.
// Replace with generated types from `supabase gen types typescript` when you have them.

export type BotConfigRow = {
  id: string;
  user_id: string;
  enabled: boolean;
  target_wallet: string | null;
  additional_target_wallets: string[];
  execution_route: string;
  jito_tip_sol: number;
  fixed_buy_usd: number;
  min_target_buy_usd: number;
  mc_min_usd: number;
  mc_max_usd: number;
  liq_min_usd: number;
  liq_max_usd: number;
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

// Minimal Database shape for createClient<Database>
export type Database = {
  public: {
    Tables: {
      bot_config: {
        Row: BotConfigRow;
        Insert: Omit<BotConfigRow, "id" | "updated_at">;
        Update: Partial<BotConfigRow>;
      };
      funding_keys: {
        Row: FundingKeyRow;
        Insert: Omit<FundingKeyRow, "id" | "created_at">;
        Update: Partial<FundingKeyRow>;
      };
      positions: {
        Row: PositionRow;
        Insert: Omit<PositionRow, "id" | "opened_at">;
        Update: Partial<PositionRow>;
      };
      trades: {
        Row: TradeRow;
        Insert: Omit<TradeRow, "id" | "created_at">;
        Update: Partial<TradeRow>;
      };
      worker_heartbeat: {
        Row: WorkerHeartbeatRow;
        Insert: WorkerHeartbeatRow;
        Update: Partial<WorkerHeartbeatRow>;
      };
      strategy_observations: {
        Row: StrategyObservationRow;
        Insert: Omit<StrategyObservationRow, "id" | "updated_at">;
        Update: Partial<StrategyObservationRow>;
      };
    };
  };
};
