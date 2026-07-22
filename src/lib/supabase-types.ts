// Placeholder types for your own Supabase project.
// Replace with generated types from `supabase gen types typescript` when you have them.

export type BotConfigRow = {
  id: string;
  user_id: string;
  enabled: boolean;
  target_wallet: string | null;
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
  created_at: string;
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
    };
  };
};
