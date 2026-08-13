-- Helix copy trading bot — Supabase schema
-- Run this in the SQL editor of your own Supabase project.

create extension if not exists "pgcrypto";

-- Bot configuration (single row per user; scale to multi-tenant by adding user_id + RLS)
create table if not exists public.bot_config (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  enabled boolean not null default false,
  target_wallet text,
  execution_route text not null default 'jito' check (execution_route in ('jito','rpc')),
  jito_tip_sol numeric not null default 0.001,
  fixed_buy_usd numeric not null default 25,
  coordinated_mode_enabled boolean not null default false,
  coordinated_fixed_buy_usd numeric not null default 25,
  coordinated_target_wallet_count integer not null default 2,
  coordinated_window_seconds integer not null default 30,
  coordinated_mc_min_usd numeric not null default 0,
  coordinated_mc_max_usd numeric not null default 15000,
  coordinated_coin_age_min_minutes numeric not null default 0,
  coordinated_coin_age_max_minutes numeric not null default 60,
  coordinated_target_buy_min_usd numeric not null default 0,
  coordinated_target_buy_max_usd numeric not null default 1000000,
  coordinated_first_buy_only boolean not null default false,
  coordinated_once_per_token boolean not null default true,
  coordinated_follower_sell_count integer not null default 1,
  coordinated_follower_sell_pct numeric not null default 100,
  coordinated_inactivity_hours numeric not null default 6,
  min_target_buy_usd numeric not null default 100,
  mc_min_usd numeric not null default 20000,
  mc_max_usd numeric not null default 5000000,
  liq_min_usd numeric not null default 10000,
  liq_max_usd numeric not null default 2000000,
  token_age_filter_enabled boolean not null default false,
  token_age_min_minutes numeric not null default 0,
  token_age_max_minutes numeric not null default 60,
  pump_fun_only boolean not null default false,
  require_socials boolean not null default true,
  only_first_buy_ever boolean not null default false,
  only_once_per_token boolean not null default true,
  take_profit_enabled boolean not null default true,
  take_profit_pct numeric not null default 100,
  take_profit_sell_pct numeric not null default 50,
  stop_loss_enabled boolean not null default true,
  stop_loss_pct numeric not null default 30,
  proportional_follower_sells boolean not null default true,
  follower_seller_exit_enabled boolean not null default false,
  follower_seller_exit_count integer not null default 1,
  follower_seller_exit_pct numeric not null default 100,
  target_inactivity_exit_enabled boolean not null default false,
  target_inactivity_hours numeric not null default 6,
  direct_target_sell_exit_mode text not null default 'off',
  direct_target_sell_exit_pct numeric not null default 100,
  terminal_outflow_exit_enabled boolean not null default false,
  terminal_outflow_exit_pct numeric not null default 100,
  target_terminal_outflow_exit_enabled boolean not null default false,
  target_terminal_outflow_exit_pct numeric not null default 100,
  updated_at timestamptz not null default now(),
  unique (user_id)
);

-- Idempotent migration for existing deployments.
alter table public.bot_config
  add column if not exists token_age_filter_enabled boolean not null default false;
alter table public.bot_config
  add column if not exists token_age_min_minutes numeric not null default 0;
alter table public.bot_config
  add column if not exists token_age_max_minutes numeric not null default 60;
alter table public.bot_config
  add column if not exists additional_target_wallets text[] not null default '{}';
alter table public.bot_config
  add column if not exists network_scaling_enabled boolean not null default false;
alter table public.bot_config
  add column if not exists starter_position_pct numeric not null default 5;
alter table public.bot_config
  add column if not exists max_position_pct numeric not null default 15;
alter table public.bot_config
  add column if not exists new_entry_reserve_pct numeric not null default 50;
alter table public.bot_config
  add column if not exists target_copy_ratio_pct numeric not null default 1;
alter table public.bot_config
  add column if not exists min_scale_buy_usd numeric not null default 1;
alter table public.bot_config
  add column if not exists require_24h_uptrend boolean not null default false;
alter table public.bot_config
  add column if not exists large_buy_scanner_enabled boolean not null default false;
alter table public.bot_config
  add column if not exists large_buy_scanner_max_mc_usd numeric not null default 10000;
alter table public.bot_config
  add column if not exists large_buy_scanner_min_buy_usd numeric not null default 500;
alter table public.bot_config
  add column if not exists large_buy_scanner_multiplier numeric not null default 2;
alter table public.bot_config
  add column if not exists large_buy_scanner_history_window integer not null default 20;
alter table public.bot_config
  add column if not exists coordinated_mode_enabled boolean not null default false;
alter table public.bot_config
  add column if not exists follower_seller_exit_enabled boolean not null default false;
alter table public.bot_config
  add column if not exists follower_seller_exit_count integer not null default 1;
alter table public.bot_config
  add column if not exists follower_seller_exit_pct numeric not null default 100;
alter table public.bot_config
  add column if not exists target_inactivity_exit_enabled boolean not null default false;
alter table public.bot_config
  add column if not exists target_inactivity_hours numeric not null default 6;
alter table public.bot_config
  add column if not exists direct_target_sell_exit_mode text not null default 'off';
alter table public.bot_config
  add column if not exists direct_target_sell_exit_pct numeric not null default 100;
alter table public.bot_config
  add column if not exists terminal_outflow_exit_enabled boolean not null default false;
alter table public.bot_config
  add column if not exists terminal_outflow_exit_pct numeric not null default 100;
alter table public.bot_config
  add column if not exists target_terminal_outflow_exit_enabled boolean not null default false;
alter table public.bot_config
  add column if not exists target_terminal_outflow_exit_pct numeric not null default 100;
alter table public.bot_config
  add column if not exists coordinated_fixed_buy_usd numeric not null default 25;
alter table public.bot_config
  add column if not exists coordinated_target_wallet_count integer not null default 2;
alter table public.bot_config
  add column if not exists coordinated_window_seconds integer not null default 30;
alter table public.bot_config
  add column if not exists coordinated_mc_min_usd numeric not null default 0;
alter table public.bot_config
  add column if not exists coordinated_mc_max_usd numeric not null default 15000;
alter table public.bot_config
  add column if not exists coordinated_coin_age_min_minutes numeric not null default 0;
alter table public.bot_config
  add column if not exists coordinated_coin_age_max_minutes numeric not null default 60;
alter table public.bot_config
  add column if not exists coordinated_target_buy_min_usd numeric not null default 0;
alter table public.bot_config
  add column if not exists coordinated_target_buy_max_usd numeric not null default 1000000;
alter table public.bot_config
  add column if not exists coordinated_first_buy_only boolean not null default false;
alter table public.bot_config
  add column if not exists coordinated_once_per_token boolean not null default true;
alter table public.bot_config
  add column if not exists coordinated_follower_sell_count integer not null default 1;
alter table public.bot_config
  add column if not exists coordinated_follower_sell_pct numeric not null default 100;
alter table public.bot_config
  add column if not exists coordinated_inactivity_hours numeric not null default 6;

-- Encrypted funding wallet private keys (AES-256-GCM ciphertext blobs)
create table if not exists public.funding_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique,
  wallet_pubkey text not null,
  ciphertext text not null,          -- base64: iv | tag | ct
  created_at timestamptz not null default now()
);

-- Worker health. This deliberately has no auth.users foreign key because the
-- single-user deployment may use the all-zero service identity.
create table if not exists public.worker_heartbeat (
  user_id uuid primary key,
  target_wallet text,
  started_at timestamptz not null,
  updated_at timestamptz not null,
  geyser_connected boolean not null default false,
  last_geyser_message_at timestamptz,
  decoded_event_count bigint not null default 0,
  rpc_last_poll_at timestamptz,
  funding_key_ready boolean not null default false,
  funding_key_checked_at timestamptz,
  funding_wallet_pubkey text,
  last_error text
);
alter table public.worker_heartbeat
  add column if not exists funding_key_ready boolean not null default false;
alter table public.worker_heartbeat
  add column if not exists funding_key_checked_at timestamptz;
alter table public.worker_heartbeat
  add column if not exists funding_wallet_pubkey text;
alter table public.worker_heartbeat
  add column if not exists last_error text;
alter table public.worker_heartbeat
  drop constraint if exists worker_heartbeat_user_id_fkey;

-- Open positions the bot holds
create table if not exists public.positions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  token_mint text not null,
  entry_price_usd numeric not null,
  amount_tokens numeric not null,
  amount_remaining numeric not null,
  entry_tx_sig text not null,
  entry_slot bigint,
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);
alter table public.positions add column if not exists decimals int not null default 0;
alter table public.positions add column if not exists mirrored_sold_fraction numeric not null default 0;
alter table public.positions add column if not exists tp_taken boolean not null default false;
alter table public.positions add column if not exists network_target_spend_usd numeric not null default 0;
alter table public.positions add column if not exists bot_cost_basis_usd numeric not null default 0;
alter table public.positions add column if not exists campaign_bankroll_usd numeric not null default 0;
alter table public.positions add column if not exists root_buy_count integer not null default 0;
alter table public.positions add column if not exists last_root_buy_at timestamptz;
alter table public.positions add column if not exists last_root_buy_wallet text;
alter table public.positions add column if not exists entry_mode text not null default 'regular';
alter table public.positions add column if not exists coordinated_exit_triggered boolean not null default false;
alter table public.positions add column if not exists follower_seller_exit_triggered boolean not null default false;
alter table public.positions alter column entry_price_usd drop not null;
create index if not exists positions_user_open_idx on public.positions (user_id) where closed_at is null;
create index if not exists positions_open_by_mint_idx on public.positions (token_mint) where closed_at is null;

-- Follower wallets we monitor for a given token/position
create table if not exists public.follower_wallets (
  id uuid primary key default gen_random_uuid(),
  position_id uuid not null references public.positions(id) on delete cascade,
  wallet text not null,
  initial_amount numeric not null,
  current_amount numeric not null,
  last_updated timestamptz not null default now(),
  unique (position_id, wallet)
);
create index if not exists follower_wallets_pos_idx on public.follower_wallets (position_id);
alter table public.follower_wallets add column if not exists hop_depth integer not null default 1;
alter table public.follower_wallets add column if not exists parent_wallet text;
alter table public.follower_wallets add column if not exists last_seen_slot bigint;
alter table public.follower_wallets add column if not exists last_seen_signature text;
alter table public.follower_wallets add column if not exists first_sell_at timestamptz;

-- Trade log
create table if not exists public.trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  position_id uuid references public.positions(id) on delete set null,
  side text not null check (side in ('buy','sell')),
  token_mint text not null,
  amount_tokens numeric not null,
  amount_usd numeric,
  price_usd numeric,
  pnl_pct numeric,
  tx_sig text not null,
  reason text,
  latency_ms integer,
  route text check (route in ('jito','rpc')),
  created_at timestamptz not null default now()
);
create index if not exists trades_user_time_idx on public.trades (user_id, created_at desc);
alter table public.trades add column if not exists valuation_source text;

-- Global "tokens the bot has ever traded" for once-per-token filter
create table if not exists public.traded_tokens (
  user_id uuid not null,
  token_mint text not null,
  first_traded_at timestamptz not null default now(),
  primary key (user_id, token_mint)
);

-- Tokens the target wallet has bought (for "only first buy ever" filter)
create table if not exists public.target_traded_tokens (
  target_wallet text not null,
  token_mint text not null,
  first_seen_at timestamptz not null default now(),
  primary key (target_wallet, token_mint)
);

-- Grants (Supabase Data API needs explicit grants on public schema)
grant select, insert, update, delete on public.bot_config to authenticated;
grant select, insert, update, delete on public.positions to authenticated;
grant select, insert, update, delete on public.follower_wallets to authenticated;
grant select, insert, update, delete on public.trades to authenticated;
grant select, insert, update, delete on public.traded_tokens to authenticated;
grant select, insert, update, delete on public.target_traded_tokens to authenticated;
grant select on public.worker_heartbeat to authenticated;
grant all on public.bot_config, public.funding_keys, public.positions,
              public.follower_wallets, public.trades, public.traded_tokens,
              public.target_traded_tokens, public.worker_heartbeat to service_role;

-- RLS: user isolation
alter table public.bot_config enable row level security;
alter table public.funding_keys enable row level security;
alter table public.positions enable row level security;
alter table public.follower_wallets enable row level security;
alter table public.trades enable row level security;
alter table public.traded_tokens enable row level security;
alter table public.target_traded_tokens enable row level security;
alter table public.worker_heartbeat enable row level security;

drop policy if exists "own config" on public.bot_config;
create policy "own config" on public.bot_config
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- funding_keys never accessible to authenticated role (service_role only)
drop policy if exists "own positions" on public.positions;
create policy "own positions" on public.positions
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own trades" on public.trades;
create policy "own trades" on public.trades
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own traded tokens" on public.traded_tokens;
create policy "own traded tokens" on public.traded_tokens
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own target traded tokens" on public.target_traded_tokens;
create policy "own target traded tokens" on public.target_traded_tokens
  for all to authenticated using (target_wallet = (select target_wallet from public.bot_config where user_id = auth.uid()))
  with check (target_wallet = (select target_wallet from public.bot_config where user_id = auth.uid()));

drop policy if exists "own follower rows" on public.follower_wallets;
create policy "own follower rows" on public.follower_wallets
  for all to authenticated
  using (exists (select 1 from public.positions p where p.id = position_id and p.user_id = auth.uid()))
  with check (exists (select 1 from public.positions p where p.id = position_id and p.user_id = auth.uid()));

drop policy if exists "read own worker heartbeat" on public.worker_heartbeat;
create policy "read own worker heartbeat" on public.worker_heartbeat
  for select to authenticated using (user_id = auth.uid());

-- Conviction Mode schema (kept in sync with conviction-mode-migration.sql).
-- Conviction Mode: additive configuration, replay-safe cluster state, ranking, and tier claims.
-- Safe to run more than once. Installation preserves all existing strategy settings and data.

alter table public.bot_config
  add column if not exists conviction_mode_enabled boolean not null default false,
  add column if not exists conviction_trading_mode text not null default 'shadow'
    check (conviction_trading_mode in ('shadow', 'live')),
  add column if not exists conviction_rapid_follow_enabled boolean not null default false,
  add column if not exists conviction_primary_window_minutes integer not null default 30
    check (conviction_primary_window_minutes in (5, 30, 60)),
  add column if not exists conviction_score_threshold numeric not null default 70,
  add column if not exists conviction_top_n integer not null default 3,
  add column if not exists conviction_min_commitment_usd numeric not null default 1000,
  add column if not exists conviction_min_recent_net_inflow_usd numeric not null default 0.01,
  add column if not exists conviction_min_velocity_usd_per_minute numeric not null default 250,
  add column if not exists conviction_min_acceleration_ratio numeric not null default 1.25,
  add column if not exists conviction_min_converged_wallets integer not null default 1,
  add column if not exists conviction_two_wallet_window_seconds integer not null default 120,
  add column if not exists conviction_three_wallet_window_seconds integer not null default 300,
  add column if not exists conviction_min_individual_buy_usd numeric not null default 0,
  add column if not exists conviction_market_cap_filter_enabled boolean not null default false,
  add column if not exists conviction_market_cap_min_usd numeric not null default 0,
  add column if not exists conviction_market_cap_max_usd numeric not null default 1000000000,
  add column if not exists conviction_liquidity_filter_enabled boolean not null default false,
  add column if not exists conviction_liquidity_min_usd numeric not null default 0,
  add column if not exists conviction_liquidity_max_usd numeric not null default 1000000000,
  add column if not exists conviction_token_age_filter_enabled boolean not null default false,
  add column if not exists conviction_token_age_min_minutes numeric not null default 0,
  add column if not exists conviction_token_age_max_minutes numeric not null default 525600,
  add column if not exists conviction_max_position_per_token_usd numeric not null default 25,
  add column if not exists conviction_distribution_sell_ratio numeric not null default 0.2,
  add column if not exists conviction_distribution_min_sells_usd numeric not null default 100,
  add column if not exists conviction_distribution_wallet_count integer not null default 2,
  add column if not exists conviction_inactivity_minutes numeric not null default 15,
  add column if not exists conviction_rank_loss_grace_seconds integer not null default 120,
  add column if not exists conviction_weight_net_commitment numeric not null default 30,
  add column if not exists conviction_weight_velocity numeric not null default 25,
  add column if not exists conviction_weight_acceleration numeric not null default 20,
  add column if not exists conviction_weight_convergence numeric not null default 15,
  add column if not exists conviction_weight_persistence numeric not null default 10,
  add column if not exists conviction_tier_commitment_thresholds_usd numeric[] not null
    default array[1000, 2500, 5000, 10000]::numeric[],
  add column if not exists conviction_tier_buy_amounts_usd numeric[] not null
    default array[5, 5, 5, 10]::numeric[];

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bot_config'::regclass
      and conname = 'bot_config_conviction_modes_check'
  ) then
    alter table public.bot_config add constraint bot_config_conviction_modes_check check (
      conviction_trading_mode in ('shadow', 'live')
      and conviction_primary_window_minutes in (5, 30, 60)
    );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bot_config'::regclass
      and conname = 'bot_config_conviction_thresholds_check'
  ) then
    alter table public.bot_config add constraint bot_config_conviction_thresholds_check check (
      conviction_score_threshold between 0 and 100
      and conviction_top_n between 1 and 10
      and conviction_min_commitment_usd >= 0
      and conviction_min_recent_net_inflow_usd >= 0
      and conviction_min_velocity_usd_per_minute >= 0
      and conviction_min_acceleration_ratio >= 0
      and conviction_min_converged_wallets between 1 and 3
      and conviction_min_individual_buy_usd >= 0
      and conviction_two_wallet_window_seconds between 1 and 21600
      and conviction_three_wallet_window_seconds between conviction_two_wallet_window_seconds and 21600
      and conviction_max_position_per_token_usd > 0
      and conviction_distribution_sell_ratio between 0 and 1
      and conviction_distribution_min_sells_usd >= 0
      and conviction_distribution_wallet_count between 1 and 3
      and conviction_inactivity_minutes > 0
      and conviction_rank_loss_grace_seconds between 0 and 86400
    );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bot_config'::regclass
      and conname = 'bot_config_conviction_recent_net_inflow_check'
  ) then
    alter table public.bot_config
      add constraint bot_config_conviction_recent_net_inflow_check
      check (conviction_min_recent_net_inflow_usd >= 0);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bot_config'::regclass
      and conname = 'bot_config_conviction_ranges_check'
  ) then
    alter table public.bot_config add constraint bot_config_conviction_ranges_check check (
      conviction_market_cap_min_usd >= 0
      and conviction_market_cap_max_usd >= conviction_market_cap_min_usd
      and conviction_liquidity_min_usd >= 0
      and conviction_liquidity_max_usd >= conviction_liquidity_min_usd
      and conviction_token_age_min_minutes >= 0
      and conviction_token_age_max_minutes >= conviction_token_age_min_minutes
    );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bot_config'::regclass
      and conname = 'bot_config_conviction_weights_check'
  ) then
    alter table public.bot_config add constraint bot_config_conviction_weights_check check (
      conviction_weight_net_commitment between 0 and 100
      and conviction_weight_velocity between 0 and 100
      and conviction_weight_acceleration between 0 and 100
      and conviction_weight_convergence between 0 and 100
      and conviction_weight_persistence between 0 and 100
      and conviction_weight_net_commitment + conviction_weight_velocity
        + conviction_weight_acceleration + conviction_weight_convergence
        + conviction_weight_persistence = 100
    );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bot_config'::regclass
      and conname = 'bot_config_conviction_tiers_check'
  ) then
    alter table public.bot_config add constraint bot_config_conviction_tiers_check check (
      cardinality(conviction_tier_commitment_thresholds_usd) = 4
      and cardinality(conviction_tier_buy_amounts_usd) = 4
      and 0 < all (conviction_tier_commitment_thresholds_usd)
      and 0 < all (conviction_tier_buy_amounts_usd)
      and conviction_tier_commitment_thresholds_usd[1]
        < conviction_tier_commitment_thresholds_usd[2]
      and conviction_tier_commitment_thresholds_usd[2]
        < conviction_tier_commitment_thresholds_usd[3]
      and conviction_tier_commitment_thresholds_usd[3]
        < conviction_tier_commitment_thresholds_usd[4]
      and conviction_tier_buy_amounts_usd[1] + conviction_tier_buy_amounts_usd[2]
        + conviction_tier_buy_amounts_usd[3] + conviction_tier_buy_amounts_usd[4]
        <= conviction_max_position_per_token_usd
    );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bot_config'::regclass
      and conname = 'bot_config_conviction_wallets_check'
  ) then
    alter table public.bot_config add constraint bot_config_conviction_wallets_check check (
      not conviction_mode_enabled
      or (
        target_wallet is not null
        and target_wallet <> ''
        and cardinality(additional_target_wallets) >= 2
        and additional_target_wallets[1] is not null
        and additional_target_wallets[2] is not null
        and additional_target_wallets[1] <> additional_target_wallets[2]
        and target_wallet <> additional_target_wallets[1]
        and target_wallet <> additional_target_wallets[2]
      )
    );
  end if;
  -- Keep the original constraint name for installations that already ran an
  -- early draft, then add a NULL-safe guard under a new name. PostgreSQL CHECK
  -- constraints accept NULL expressions, so COALESCE is required here to make
  -- the three-wallet prerequisite authoritative at the database boundary.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bot_config'::regclass
      and conname = 'bot_config_conviction_wallets_v2_check'
  ) then
    alter table public.bot_config add constraint bot_config_conviction_wallets_v2_check check (
      not conviction_mode_enabled
      or (
        coalesce(nullif(btrim(target_wallet), ''), '') <> ''
        and coalesce(cardinality(additional_target_wallets), 0) >= 2
        and coalesce(nullif(btrim(additional_target_wallets[1]), ''), '') <> ''
        and coalesce(nullif(btrim(additional_target_wallets[2]), ''), '') <> ''
        and additional_target_wallets[1] <> additional_target_wallets[2]
        and target_wallet <> additional_target_wallets[1]
        and target_wallet <> additional_target_wallets[2]
      )
    );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bot_config'::regclass
      and conname = 'bot_config_conviction_wallets_v3_check'
  ) then
    alter table public.bot_config add constraint bot_config_conviction_wallets_v3_check check (
      not conviction_mode_enabled
      or (
        coalesce(nullif(btrim(target_wallet), ''), '') <> ''
        and coalesce(cardinality(additional_target_wallets), 0) = 2
        and coalesce(nullif(btrim(additional_target_wallets[1]), ''), '') <> ''
        and coalesce(nullif(btrim(additional_target_wallets[2]), ''), '') <> ''
        and btrim(additional_target_wallets[1]) <> btrim(additional_target_wallets[2])
        and btrim(target_wallet) <> btrim(additional_target_wallets[1])
        and btrim(target_wallet) <> btrim(additional_target_wallets[2])
      )
    );
  end if;
end $$;

create table if not exists public.conviction_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  event_key text not null,
  tx_sig text not null default '',
  slot bigint,
  source text not null default 'unknown' check (source in ('geyser', 'rpc', 'unknown')),
  event_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  wallet text not null,
  from_wallet text,
  to_wallet text,
  token_mint text not null,
  classification text not null check (classification in (
    'DEX_BUY', 'DEX_SELL', 'INTERNAL_CLUSTER_TRANSFER',
    'EXTERNAL_TRANSFER_IN', 'EXTERNAL_TRANSFER_OUT', 'UNKNOWN'
  )),
  classification_reliable boolean not null default false,
  amount_tokens numeric not null default 0 check (amount_tokens >= 0),
  amount_usd numeric check (amount_usd is null or amount_usd >= 0),
  market_cap_usd numeric,
  liquidity_usd numeric,
  metadata jsonb not null default '{}'::jsonb,
  unique (user_id, event_key)
);

create index if not exists conviction_events_user_time_idx
  on public.conviction_events (user_id, event_at desc);
create index if not exists conviction_events_mint_time_idx
  on public.conviction_events (user_id, token_mint, event_at desc);
create index if not exists conviction_events_wallet_time_idx
  on public.conviction_events (user_id, wallet, event_at desc);

create table if not exists public.conviction_token_state (
  user_id uuid not null,
  token_mint text not null,
  symbol text,
  first_seen_at timestamptz not null,
  last_activity_at timestamptz not null,
  gross_cluster_buys_usd numeric not null default 0 check (gross_cluster_buys_usd >= 0),
  gross_cluster_sells_usd numeric not null default 0 check (gross_cluster_sells_usd >= 0),
  net_cluster_investment_usd numeric not null default 0,
  wallet_net_usd jsonb not null default '{}'::jsonb,
  buy_count integer not null default 0 check (buy_count >= 0),
  sell_count integer not null default 0 check (sell_count >= 0),
  largest_buy_usd numeric not null default 0 check (largest_buy_usd >= 0),
  last_buy_usd numeric not null default 0 check (last_buy_usd >= 0),
  average_buy_usd numeric not null default 0 check (average_buy_usd >= 0),
  median_buy_usd numeric not null default 0 check (median_buy_usd >= 0),
  wallets_that_bought text[] not null default '{}',
  wallets_currently_accumulating text[] not null default '{}',
  wallet_convergence_count integer not null default 0 check (wallet_convergence_count between 0 and 3),
  market_cap_usd numeric,
  market_cap_at_first_cluster_buy_usd numeric,
  liquidity_usd numeric,
  our_current_position_usd numeric not null default 0 check (our_current_position_usd >= 0),
  net_flow_1m_usd numeric not null default 0,
  net_flow_5m_usd numeric not null default 0,
  net_flow_30m_usd numeric not null default 0,
  net_flow_60m_usd numeric not null default 0,
  capital_velocity_usd_per_minute numeric not null default 0,
  capital_acceleration_ratio numeric not null default 0,
  buy_size_acceleration_ratio numeric not null default 0,
  conviction_score numeric not null default 0 check (conviction_score between 0 and 100),
  conviction_state text not null default 'TESTING' check (conviction_state in (
    'TESTING', 'WATCHING', 'ACCUMULATING', 'BETTING', 'HIGH_CONVICTION', 'DISTRIBUTING'
  )),
  score_reasons jsonb not null default '[]'::jsonb,
  current_rank integer check (current_rank is null or current_rank > 0),
  previous_rank integer check (previous_rank is null or previous_rank > 0),
  rank_direction text not null default 'unranked'
    check (rank_direction in ('up', 'down', 'flat', 'new', 'unranked')),
  time_in_top_10_seconds bigint not null default 0 check (time_in_top_10_seconds >= 0),
  time_in_top_3_seconds bigint not null default 0 check (time_in_top_3_seconds >= 0),
  time_at_rank_one_seconds bigint not null default 0 check (time_at_rank_one_seconds >= 0),
  rapid_follow_status text not null default 'inactive'
    check (rapid_follow_status in ('inactive', 'active', 'stopped')),
  data_reliable boolean not null default false,
  rolling_metrics jsonb not null default '{}'::jsonb,
  last_ranked_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, token_mint)
);

create index if not exists conviction_token_state_leaderboard_idx
  on public.conviction_token_state (user_id, current_rank, conviction_score desc);
create index if not exists conviction_token_state_activity_idx
  on public.conviction_token_state (user_id, last_activity_at desc);
create index if not exists conviction_token_state_rapid_idx
  on public.conviction_token_state (user_id, updated_at desc)
  where rapid_follow_status = 'active';

create table if not exists public.conviction_rank_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  token_mint text not null,
  window_minutes integer not null check (window_minutes in (5, 30, 60)),
  rank integer not null check (rank > 0),
  previous_rank integer check (previous_rank is null or previous_rank > 0),
  rank_direction text not null check (rank_direction in ('up', 'down', 'flat', 'new')),
  conviction_score numeric not null check (conviction_score between 0 and 100),
  net_cluster_investment_usd numeric not null default 0,
  net_flow_usd numeric not null default 0,
  capital_velocity_usd_per_minute numeric not null default 0,
  capital_acceleration_ratio numeric not null default 0,
  buy_size_acceleration_ratio numeric not null default 0,
  wallet_convergence_count integer not null default 0 check (wallet_convergence_count between 0 and 3),
  continuing_accumulation boolean not null default false,
  distribution_penalty numeric not null default 0,
  ranking_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  unique (user_id, token_mint, window_minutes, ranking_at)
);

create index if not exists conviction_rank_history_window_idx
  on public.conviction_rank_history (user_id, window_minutes, ranking_at desc, rank);
create index if not exists conviction_rank_history_mint_idx
  on public.conviction_rank_history (user_id, token_mint, ranking_at desc);

create table if not exists public.conviction_transitions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  transition_key text not null,
  token_mint text,
  event_type text not null check (event_type in (
    'CONVICTION_MODE_ENABLED', 'CONVICTION_MODE_DISABLED',
    'CONVICTION_STATE_CHANGE', 'CONVICTION_BREAKOUT', 'WALLET_CONVERGENCE',
    'TOP_10_ENTRY', 'TOP_3_ENTRY', 'RAPID_FOLLOW_STARTED',
    'RAPID_FOLLOW_SCALE_IN', 'RAPID_FOLLOW_STOPPED', 'DISTRIBUTION_DETECTED',
    'CONVICTION_TRADE_EXECUTED', 'CONVICTION_TRADE_SKIPPED'
  )),
  previous_state text,
  new_state text,
  previous_score numeric check (previous_score is null or previous_score between 0 and 100),
  new_score numeric check (new_score is null or new_score between 0 and 100),
  net_cluster_investment_usd numeric,
  capital_velocity_usd_per_minute numeric,
  wallet_convergence_count integer check (
    wallet_convergence_count is null or wallet_convergence_count between 0 and 3
  ),
  market_cap_usd numeric,
  liquidity_usd numeric,
  reasons jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  unique (user_id, transition_key),
  check (previous_state is null or previous_state in (
    'TESTING', 'WATCHING', 'ACCUMULATING', 'BETTING', 'HIGH_CONVICTION', 'DISTRIBUTING'
  )),
  check (new_state is null or new_state in (
    'TESTING', 'WATCHING', 'ACCUMULATING', 'BETTING', 'HIGH_CONVICTION', 'DISTRIBUTING'
  ))
);

create index if not exists conviction_transitions_user_time_idx
  on public.conviction_transitions (user_id, occurred_at desc);
create index if not exists conviction_transitions_mint_time_idx
  on public.conviction_transitions (user_id, token_mint, occurred_at desc)
  where token_mint is not null;

create table if not exists public.conviction_tiers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  token_mint text not null,
  tier_number integer not null check (tier_number between 1 and 4),
  trading_mode text not null check (trading_mode in ('shadow', 'live')),
  status text not null check (status in (
    'eligible', 'shadowed', 'claimed', 'submitted', 'landed', 'persisted',
    'failed_pre_submit', 'uncertain', 'skipped'
  )),
  planned_position_id uuid,
  position_id uuid references public.positions(id),
  source_event_key text not null,
  commitment_threshold_usd numeric not null check (commitment_threshold_usd > 0),
  buy_usd numeric not null check (buy_usd > 0),
  score numeric not null check (score between 0 and 100),
  received_tokens numeric check (received_tokens is null or received_tokens >= 0),
  bot_tx_sig text,
  reason text,
  error_code text,
  claimed_at timestamptz,
  submission_started_at timestamptz,
  landed_at timestamptz,
  persisted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists conviction_tiers_user_status_idx
  on public.conviction_tiers (user_id, status, updated_at desc);
create index if not exists conviction_tiers_mint_idx
  on public.conviction_tiers (user_id, token_mint, tier_number);
-- Trading mode is part of tier identity: a SHADOW observation must never
-- consume the corresponding LIVE tier. On databases that ran an early draft,
-- the old three-column unique constraint may still exist; changing it in place
-- would be destructive. The runtime detects that compatibility case and safely
-- promotes the shadow row when LIVE is explicitly authorized.
create unique index if not exists conviction_tiers_user_mint_tier_mode_idx
  on public.conviction_tiers (user_id, token_mint, tier_number, trading_mode);
create unique index if not exists conviction_tiers_planned_position_idx
  on public.conviction_tiers (user_id, planned_position_id)
  where planned_position_id is not null;
create unique index if not exists conviction_tiers_bot_tx_idx
  on public.conviction_tiers (user_id, bot_tx_sig)
  where bot_tx_sig is not null;

grant select on public.conviction_events, public.conviction_token_state,
  public.conviction_rank_history, public.conviction_transitions, public.conviction_tiers
  to authenticated;
grant select, insert, update on public.conviction_events, public.conviction_token_state,
  public.conviction_rank_history, public.conviction_transitions, public.conviction_tiers
  to service_role;

alter table public.conviction_events enable row level security;
alter table public.conviction_token_state enable row level security;
alter table public.conviction_rank_history enable row level security;
alter table public.conviction_transitions enable row level security;
alter table public.conviction_tiers enable row level security;

-- Read-only doctor probe. It reports whether mode-scoped identity is installed
-- and whether a legacy unscoped unique index is still present. It never changes
-- schema or data, and lets one worker build support both fresh and upgraded
-- installations without guessing from a unique-violation error.
create or replace function public.conviction_tier_identity_health()
returns table(mode_scoped_unique boolean, legacy_unscoped_unique boolean)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  with unique_indexes as (
    select array_agg(attribute.attname order by key_column.ordinality)::text[] as indexed_columns
    from pg_index as index_definition
    cross join lateral unnest(index_definition.indkey)
      with ordinality as key_column(attnum, ordinality)
    join pg_attribute as attribute
      on attribute.attrelid = index_definition.indrelid
     and attribute.attnum = key_column.attnum
    where index_definition.indrelid = 'public.conviction_tiers'::regclass
      and index_definition.indisunique
    group by index_definition.indexrelid
  )
  select
    coalesce(bool_or(indexed_columns = array[
      'user_id', 'token_mint', 'tier_number', 'trading_mode'
    ]::text[]), false) as mode_scoped_unique,
    coalesce(bool_or(indexed_columns = array[
      'user_id', 'token_mint', 'tier_number'
    ]::text[]), false) as legacy_unscoped_unique
  from unique_indexes;
$$;

revoke all on function public.conviction_tier_identity_health() from public, anon, authenticated;
grant execute on function public.conviction_tier_identity_health() to service_role;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public'
      and tablename = 'conviction_events' and policyname = 'read own conviction events'
  ) then
    create policy "read own conviction events" on public.conviction_events
      for select to authenticated using (user_id = auth.uid());
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'public'
      and tablename = 'conviction_token_state' and policyname = 'read own conviction state'
  ) then
    create policy "read own conviction state" on public.conviction_token_state
      for select to authenticated using (user_id = auth.uid());
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'public'
      and tablename = 'conviction_rank_history' and policyname = 'read own conviction ranks'
  ) then
    create policy "read own conviction ranks" on public.conviction_rank_history
      for select to authenticated using (user_id = auth.uid());
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'public'
      and tablename = 'conviction_transitions' and policyname = 'read own conviction transitions'
  ) then
    create policy "read own conviction transitions" on public.conviction_transitions
      for select to authenticated using (user_id = auth.uid());
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'public'
      and tablename = 'conviction_tiers' and policyname = 'read own conviction tiers'
  ) then
    create policy "read own conviction tiers" on public.conviction_tiers
      for select to authenticated using (user_id = auth.uid());
  end if;
end $$;

-- Strategy Lab schema (kept in sync with strategy-lab-migration.sql).
create table if not exists public.strategy_observations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  target_wallet text not null,
  event_key text not null,
  tx_sig text not null default '',
  slot bigint,
  source text not null default 'unknown' check (source in ('geyser','rpc','unknown')),
  event_at timestamptz not null,
  detected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  relationship text not null check (relationship in ('target','follower','observed')),
  event_kind text not null check (event_kind in ('swap','transfer')),
  side text check (side in ('buy','sell')),
  actor_wallet text not null,
  from_wallet text,
  to_wallet text,
  token_mint text not null,
  amount_tokens numeric not null default 0,
  decimals int not null default 0,
  sol_delta numeric,
  amount_usd numeric,
  is_pump_fun boolean,
  position_id uuid references public.positions(id) on delete set null,
  market_cap_usd numeric,
  liquidity_usd numeric,
  has_socials boolean,
  bot_decision text check (
    bot_decision in (
      'filtered','skipped','copy_submitted','copied',
      'mirror_submitted','mirrored','tracked','failed'
    )
  ),
  bot_reason text,
  bot_tx_sig text,
  reaction_ms integer,
  execution_ms integer,
  metadata jsonb not null default '{}'::jsonb,
  unique (user_id, event_key)
);

create index if not exists strategy_observations_user_time_idx
  on public.strategy_observations (user_id, event_at desc);
create index if not exists strategy_observations_target_time_idx
  on public.strategy_observations (target_wallet, event_at desc);
create index if not exists strategy_observations_mint_time_idx
  on public.strategy_observations (token_mint, event_at desc);
create index if not exists strategy_observations_decision_time_idx
  on public.strategy_observations (user_id, bot_decision, event_at desc);
create index if not exists strategy_observations_transfer_lookup_idx
  on public.strategy_observations (user_id, token_mint, from_wallet, event_at desc)
  where relationship = 'target' and event_kind = 'transfer';

-- Merge a worker batch without allowing a late feed replay to erase a richer
-- source, an execution outcome, or previously recorded timing.
create or replace function public.record_strategy_observations(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer := 0;
begin
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array';
  end if;

  insert into public.strategy_observations as existing (
    user_id, target_wallet, event_key, tx_sig, slot, source, event_at,
    detected_at, relationship, event_kind, side, actor_wallet, from_wallet,
    to_wallet, token_mint, amount_tokens, decimals, sol_delta, amount_usd,
    is_pump_fun, position_id, market_cap_usd, liquidity_usd, has_socials,
    bot_decision, bot_reason, bot_tx_sig, reaction_ms, execution_ms, metadata
  )
  select
    (item->>'user_id')::uuid,
    item->>'target_wallet',
    item->>'event_key',
    coalesce(item->>'tx_sig', ''),
    nullif(item->>'slot', '')::bigint,
    coalesce(nullif(item->>'source', ''), 'unknown'),
    (item->>'event_at')::timestamptz,
    coalesce(nullif(item->>'detected_at', '')::timestamptz, now()),
    item->>'relationship',
    item->>'event_kind',
    nullif(item->>'side', ''),
    item->>'actor_wallet',
    nullif(item->>'from_wallet', ''),
    nullif(item->>'to_wallet', ''),
    item->>'token_mint',
    coalesce(nullif(item->>'amount_tokens', '')::numeric, 0),
    coalesce(nullif(item->>'decimals', '')::int, 0),
    nullif(item->>'sol_delta', '')::numeric,
    nullif(item->>'amount_usd', '')::numeric,
    nullif(item->>'is_pump_fun', '')::boolean,
    nullif(item->>'position_id', '')::uuid,
    nullif(item->>'market_cap_usd', '')::numeric,
    nullif(item->>'liquidity_usd', '')::numeric,
    nullif(item->>'has_socials', '')::boolean,
    nullif(item->>'bot_decision', ''),
    nullif(item->>'bot_reason', ''),
    nullif(item->>'bot_tx_sig', ''),
    nullif(item->>'reaction_ms', '')::integer,
    nullif(item->>'execution_ms', '')::integer,
    coalesce(item->'metadata', '{}'::jsonb)
  from jsonb_array_elements(p_rows) as rows(item)
  where item ? 'user_id'
    and item ? 'target_wallet'
    and item ? 'event_key'
    and item ? 'event_at'
    and item ? 'relationship'
    and item ? 'event_kind'
    and item ? 'actor_wallet'
    and item ? 'token_mint'
  on conflict (user_id, event_key) do update
    set target_wallet = excluded.target_wallet,
        tx_sig = case when excluded.tx_sig <> '' then excluded.tx_sig else existing.tx_sig end,
        slot = coalesce(excluded.slot, existing.slot),
        source = case
          when existing.source = 'geyser' or excluded.source = 'geyser' then 'geyser'
          when existing.source = 'rpc' or excluded.source = 'rpc' then 'rpc'
          else 'unknown'
        end,
        event_at = least(existing.event_at, excluded.event_at),
        detected_at = least(existing.detected_at, excluded.detected_at),
        updated_at = now(),
        relationship = case
          when existing.relationship = 'target' or excluded.relationship = 'target' then 'target'
          when existing.relationship = 'follower' or excluded.relationship = 'follower' then 'follower'
          else 'observed'
        end,
        position_id = coalesce(excluded.position_id, existing.position_id),
        amount_usd = coalesce(excluded.amount_usd, existing.amount_usd),
        market_cap_usd = coalesce(excluded.market_cap_usd, existing.market_cap_usd),
        liquidity_usd = coalesce(excluded.liquidity_usd, existing.liquidity_usd),
        has_socials = coalesce(excluded.has_socials, existing.has_socials),
        bot_decision = case
          when existing.bot_decision in ('copied','mirrored')
            and coalesce(excluded.bot_decision, '') not in ('copied','mirrored')
            then existing.bot_decision
          when existing.bot_decision = 'failed'
            and coalesce(excluded.bot_decision, '') not in ('copied','mirrored')
            then existing.bot_decision
          when existing.bot_decision in ('copy_submitted','mirror_submitted')
            and coalesce(excluded.bot_decision, '') in ('','tracked','skipped','filtered')
            then existing.bot_decision
          else coalesce(excluded.bot_decision, existing.bot_decision)
        end,
        bot_reason = case
          when existing.bot_decision in ('copied','mirrored')
            and coalesce(excluded.bot_decision, '') not in ('copied','mirrored')
            then existing.bot_reason
          when existing.bot_decision = 'failed'
            and coalesce(excluded.bot_decision, '') not in ('copied','mirrored')
            then existing.bot_reason
          when existing.bot_decision in ('copy_submitted','mirror_submitted')
            and coalesce(excluded.bot_decision, '') in ('','tracked','skipped','filtered')
            then existing.bot_reason
          else coalesce(excluded.bot_reason, existing.bot_reason)
        end,
        bot_tx_sig = case
          when existing.bot_decision in ('copied','mirrored')
            and coalesce(excluded.bot_decision, '') not in ('copied','mirrored')
            then existing.bot_tx_sig
          when existing.bot_decision = 'failed'
            and coalesce(excluded.bot_decision, '') not in ('copied','mirrored')
            then existing.bot_tx_sig
          when existing.bot_decision in ('copy_submitted','mirror_submitted')
            and coalesce(excluded.bot_decision, '') in ('','tracked','skipped','filtered')
            then existing.bot_tx_sig
          else coalesce(excluded.bot_tx_sig, existing.bot_tx_sig)
        end,
        reaction_ms = case
          when existing.bot_decision in ('copied','mirrored')
            and coalesce(excluded.bot_decision, '') not in ('copied','mirrored')
            then existing.reaction_ms
          when existing.bot_decision = 'failed'
            and coalesce(excluded.bot_decision, '') not in ('copied','mirrored')
            then existing.reaction_ms
          when existing.bot_decision in ('copy_submitted','mirror_submitted')
            and coalesce(excluded.bot_decision, '') in ('','tracked','skipped','filtered')
            then existing.reaction_ms
          else coalesce(excluded.reaction_ms, existing.reaction_ms)
        end,
        execution_ms = case
          when existing.bot_decision in ('copied','mirrored')
            and coalesce(excluded.bot_decision, '') not in ('copied','mirrored')
            then existing.execution_ms
          when existing.bot_decision = 'failed'
            and coalesce(excluded.bot_decision, '') not in ('copied','mirrored')
            then existing.execution_ms
          when existing.bot_decision in ('copy_submitted','mirror_submitted')
            and coalesce(excluded.bot_decision, '') in ('','tracked','skipped','filtered')
            then existing.execution_ms
          else coalesce(excluded.execution_ms, existing.execution_ms)
        end,
        metadata = existing.metadata || excluded.metadata;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

-- Sell coverage schema (kept in sync with sell-coverage-migration.sql).
alter table public.bot_config
  add column if not exists direct_target_sell_exit_mode text not null default 'off',
  add column if not exists direct_target_sell_exit_pct numeric not null default 100,
  add column if not exists terminal_outflow_exit_enabled boolean not null default false,
  add column if not exists terminal_outflow_exit_pct numeric not null default 100,
  add column if not exists target_terminal_outflow_exit_enabled boolean not null default false,
  add column if not exists target_terminal_outflow_exit_pct numeric not null default 100;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bot_config'::regclass
      and conname = 'bot_config_direct_target_sell_exit_mode_check'
  ) then
    alter table public.bot_config
      add constraint bot_config_direct_target_sell_exit_mode_check
      check (direct_target_sell_exit_mode in ('off', 'proportional', 'fixed_pct', 'full'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bot_config'::regclass
      and conname = 'bot_config_direct_target_sell_exit_pct_check'
  ) then
    alter table public.bot_config
      add constraint bot_config_direct_target_sell_exit_pct_check
      check (direct_target_sell_exit_pct > 0 and direct_target_sell_exit_pct <= 100);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bot_config'::regclass
      and conname = 'bot_config_terminal_outflow_exit_pct_check'
  ) then
    alter table public.bot_config
      add constraint bot_config_terminal_outflow_exit_pct_check
      check (terminal_outflow_exit_pct > 0 and terminal_outflow_exit_pct <= 100);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bot_config'::regclass
      and conname = 'bot_config_target_terminal_outflow_exit_pct_check'
  ) then
    alter table public.bot_config
      add constraint bot_config_target_terminal_outflow_exit_pct_check
      check (target_terminal_outflow_exit_pct > 0 and target_terminal_outflow_exit_pct <= 100);
  end if;
end $$;

alter table public.follower_wallets
  add column if not exists trigger_eligible boolean not null default true,
  add column if not exists unexplained_outflow_amount numeric not null default 0,
  add column if not exists released_at timestamptz,
  add column if not exists first_fresh_sell_at timestamptz;

create index if not exists follower_wallets_active_wallet_idx
  on public.follower_wallets (wallet, position_id)
  where released_at is null and current_amount > 0;

create index if not exists follower_wallets_fresh_sellers_idx
  on public.follower_wallets (position_id, first_fresh_sell_at)
  where released_at is null and trigger_eligible = true and first_fresh_sell_at is not null;

create table if not exists public.rpc_wallet_cursors (
  user_id uuid not null,
  wallet text not null,
  start_slot bigint not null default 0,
  last_processed_signature text,
  last_processed_slot bigint,
  last_block_time bigint,
  backlog_detected boolean not null default false,
  last_success_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, wallet)
);

create index if not exists rpc_wallet_cursors_health_idx
  on public.rpc_wallet_cursors (user_id, backlog_detected, last_success_at);

create table if not exists public.position_target_wallets (
  user_id uuid not null,
  position_id uuid not null references public.positions(id) on delete cascade,
  wallet text not null,
  link_reason text not null default 'entry',
  linked_at timestamptz not null default now(),
  last_buy_at timestamptz,
  primary key (position_id, wallet)
);

create index if not exists position_target_wallets_user_wallet_idx
  on public.position_target_wallets (user_id, wallet, position_id);

create table if not exists public.sell_signal_claims (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  position_id uuid not null references public.positions(id) on delete cascade,
  source_tx_sig text not null,
  source_wallet text not null,
  trigger_kind text not null check (trigger_kind in (
    'direct_target_sell', 'terminal_outflow', 'target_terminal_outflow',
    'take_profit', 'stop_loss', 'target_inactivity',
    'distinct_follower', 'proportional_follower'
  )),
  status text not null default 'claimed'
    check (status in ('claimed', 'submitted', 'landed', 'failed_pre_submit', 'uncertain')),
  requested_sell_pct numeric not null check (requested_sell_pct > 0 and requested_sell_pct <= 100),
  requested_sell_amount numeric,
  bot_tx_sig text,
  error_code text,
  submission_started_at timestamptz,
  landed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (position_id, source_tx_sig, source_wallet, trigger_kind)
);

alter table public.sell_signal_claims
  add column if not exists requested_sell_amount numeric,
  add column if not exists submission_started_at timestamptz,
  add column if not exists landed_at timestamptz;

create index if not exists sell_signal_claims_user_time_idx
  on public.sell_signal_claims (user_id, created_at desc);

-- A position may have many historical sell signals, but at most one signal may
-- own submission authority at a time. This database invariant protects across
-- concurrent Geyser/RPC handlers and across multiple worker processes.
create unique index if not exists sell_signal_claims_active_position_idx
  on public.sell_signal_claims (position_id)
  where status in ('claimed', 'submitted', 'uncertain');

-- A buy is claimed durably before transaction submission. The planned UUID and
-- bot signature allow startup recovery to recognize only the exact Helix
-- position; a wallet balance by itself is never adopted as a copied position.
create table if not exists public.entry_signal_claims (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  source_tx_sig text not null,
  source_wallet text not null,
  token_mint text not null,
  planned_position_id uuid not null unique,
  entry_mode text not null check (entry_mode in ('regular', 'coordinated')),
  amount_lamports bigint not null check (amount_lamports > 0),
  status text not null default 'claimed'
    check (status in (
      'claimed', 'submitted', 'landed', 'persisted', 'failed_pre_submit', 'uncertain'
    )),
  bot_tx_sig text,
  error_code text,
  submission_started_at timestamptz,
  landed_at timestamptz,
  persisted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, source_tx_sig, source_wallet, token_mint)
);

create index if not exists entry_signal_claims_user_time_idx
  on public.entry_signal_claims (user_id, created_at desc);

create unique index if not exists entry_signal_claims_active_mint_idx
  on public.entry_signal_claims (user_id, token_mint)
  where status in ('claimed', 'submitted', 'landed', 'uncertain');

-- Immutable accounting claims make target-to-follower credits and follower
-- sells safe across duplicate Geyser/RPC delivery, out-of-order replay, process
-- restarts, and concurrent workers. The stored sell snapshot lets downstream
-- execution resume without applying the wallet debit twice.
create table if not exists public.follower_accounting_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  position_id uuid not null references public.positions(id) on delete cascade,
  event_kind text not null check (event_kind in ('root_transfer', 'follower_sell')),
  token_mint text not null,
  source_wallet text not null,
  follower_wallet text not null,
  tx_sig text not null,
  slot bigint,
  requested_amount numeric not null check (requested_amount > 0),
  applied_amount numeric not null default 0 check (applied_amount >= 0),
  fresh_for_action boolean not null default false,
  trigger_eligible boolean not null default false,
  first_sell_by_wallet boolean not null default false,
  sold_fraction numeric check (sold_fraction is null or sold_fraction between 0 and 1),
  distinct_seller_count integer check (
    distinct_seller_count is null or distinct_seller_count >= 0
  ),
  result_initial_amount numeric,
  result_current_amount numeric,
  result_reason text,
  applied_at timestamptz not null default now(),
  unique (position_id, event_kind, tx_sig, source_wallet, follower_wallet, token_mint)
);

create index if not exists follower_accounting_events_user_time_idx
  on public.follower_accounting_events (user_id, applied_at desc);

create index if not exists follower_accounting_events_position_time_idx
  on public.follower_accounting_events (position_id, applied_at desc);

create table if not exists public.follower_outflow_observations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  position_id uuid not null references public.positions(id) on delete cascade,
  source_wallet text not null,
  destination_wallet text not null,
  token_mint text not null,
  amount_tokens numeric not null,
  hop_depth integer,
  destination_class text not null default 'unclassified',
  trigger_eligible boolean not null default false,
  tx_sig text not null,
  slot bigint,
  observed_at timestamptz not null default now(),
  unique (position_id, tx_sig, source_wallet, destination_wallet, token_mint)
);

create index if not exists follower_outflow_user_time_idx
  on public.follower_outflow_observations (user_id, observed_at desc);

-- A custody transfer is not proof of a sale. These rows retain the exact
-- observation separately so the optional high-risk response can remain OFF.
create table if not exists public.target_outflow_observations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  position_id uuid not null references public.positions(id) on delete cascade,
  source_wallet text not null,
  destination_wallet text not null,
  token_mint text not null,
  amount_tokens numeric not null,
  destination_class text not null default 'unclassified',
  source_linked boolean not null default false,
  tx_sig text not null,
  slot bigint,
  observed_at timestamptz not null default now(),
  unique (position_id, tx_sig, source_wallet, destination_wallet, token_mint)
);

create index if not exists target_outflow_user_time_idx
  on public.target_outflow_observations (user_id, observed_at desc);

-- Periodic on-chain balance comparisons are diagnostic only. A mismatch is
-- persisted here, but it never changes follower accounting and never claims a
-- sell. confirmed_at requires two stable shortfall snapshots before the alert
-- becomes an entry circuit-breaker.
create table if not exists public.follower_balance_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  wallet text not null,
  token_mint text not null,
  expected_amount numeric not null,
  observed_amount numeric not null,
  shortfall_amount numeric not null,
  active_position_count integer not null default 1,
  occurrence_count integer not null default 1,
  first_detected_at timestamptz not null default now(),
  last_detected_at timestamptz not null default now(),
  confirmed_at timestamptz,
  resolved_at timestamptz,
  resolution_reason text,
  resolution_observed_amount numeric
);

alter table public.follower_balance_alerts
  add column if not exists confirmed_at timestamptz;

create unique index if not exists follower_balance_alerts_open_key_idx
  on public.follower_balance_alerts (user_id, wallet, token_mint)
  where resolved_at is null;

create index if not exists follower_balance_alerts_user_time_idx
  on public.follower_balance_alerts (user_id, last_detected_at desc);

-- One durable claim per sender/mint/transaction makes a split transfer a
-- single accounting operation. The RPC below locks the source cohort,
-- debits it once, and credits every recipient in the same database transaction.
create table if not exists public.follower_transfer_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  position_id uuid not null references public.positions(id) on delete cascade,
  source_wallet text not null,
  token_mint text not null,
  tx_sig text not null,
  slot bigint,
  requested_amount numeric not null default 0,
  moved_amount numeric not null default 0,
  tracked_amount numeric not null default 0,
  terminal_amount numeric not null default 0,
  hop_depth integer,
  source_trigger_eligible boolean not null default false,
  recipient_count integer not null default 0,
  tracked_wallets jsonb not null default '[]'::jsonb,
  terminal_wallets jsonb not null default '[]'::jsonb,
  applied_at timestamptz not null default now(),
  unique (position_id, tx_sig, source_wallet, token_mint)
);

alter table public.follower_transfer_batches
  add column if not exists tracked_wallets jsonb not null default '[]'::jsonb,
  add column if not exists terminal_wallets jsonb not null default '[]'::jsonb,
  add column if not exists hop_depth integer,
  add column if not exists source_trigger_eligible boolean not null default false;

create index if not exists follower_transfer_batches_user_time_idx
  on public.follower_transfer_batches (user_id, applied_at desc);

create or replace function public.record_follower_transfer_batch(
  p_position_id uuid,
  p_source_wallet text,
  p_token_mint text,
  p_tx_sig text,
  p_slot bigint,
  p_recipients jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid;
  v_parent public.follower_wallets%rowtype;
  v_existing public.follower_transfer_batches%rowtype;
  v_claim_id uuid;
  v_item jsonb;
  v_wallet text;
  v_requested numeric;
  v_total_requested numeric := 0;
  v_scale numeric := 0;
  v_moved numeric;
  v_total_moved numeric := 0;
  v_tracked_amount numeric := 0;
  v_actionable_tracked_amount numeric := 0;
  v_terminal_amount numeric := 0;
  v_unresolved_amount numeric := 0;
  v_recipient_count integer := 0;
  v_next_hop integer;
  v_should_track boolean;
  v_trigger_eligible boolean;
  v_destination_class text;
  v_tracked_wallets jsonb := '[]'::jsonb;
  v_terminal_wallets jsonb := '[]'::jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if coalesce(trim(p_source_wallet), '') = ''
     or coalesce(trim(p_token_mint), '') = ''
     or coalesce(trim(p_tx_sig), '') = ''
     or jsonb_typeof(p_recipients) <> 'array' then
    raise exception 'invalid follower transfer batch';
  end if;

  select user_id into v_user_id
  from public.positions
  where id = p_position_id
    and token_mint = p_token_mint
    and closed_at is null
  for update;
  if not found then
    return jsonb_build_object('applied', false, 'reason', 'no_active_position');
  end if;

  select * into v_existing
  from public.follower_transfer_batches
  where position_id = p_position_id
    and tx_sig = p_tx_sig
    and source_wallet = p_source_wallet
    and token_mint = p_token_mint;
  if found then
    return jsonb_build_object(
      'applied', false,
      'duplicate', true,
      'movedAmount', v_existing.moved_amount,
      'trackedAmount', v_existing.tracked_amount,
      'terminalAmount', v_existing.terminal_amount,
      'hopDepth', v_existing.hop_depth,
      'sourceTriggerEligible', v_existing.source_trigger_eligible,
      'trackedWallets', v_existing.tracked_wallets,
      'terminalWallets', v_existing.terminal_wallets
    );
  end if;

  select * into v_parent
  from public.follower_wallets
  where position_id = p_position_id
    and wallet = p_source_wallet
    and released_at is null
  for update;
  if not found then
    return jsonb_build_object('applied', false, 'reason', 'source_not_retained');
  end if;

  for v_item in select value from jsonb_array_elements(p_recipients)
  loop
    v_wallet := trim(coalesce(v_item->>'wallet', ''));
    v_requested := greatest(0, coalesce((v_item->>'amountTokens')::numeric, 0));
    if v_wallet <> '' and v_wallet <> p_source_wallet and v_requested > 0 then
      v_total_requested := v_total_requested + v_requested;
      v_recipient_count := v_recipient_count + 1;
    end if;
  end loop;
  if v_total_requested <= 0 then
    return jsonb_build_object('applied', false, 'reason', 'no_recipients');
  end if;

  insert into public.follower_transfer_batches (
    user_id, position_id, source_wallet, token_mint, tx_sig, slot,
    requested_amount, recipient_count
  ) values (
    v_user_id, p_position_id, p_source_wallet, p_token_mint, p_tx_sig, p_slot,
    v_total_requested, v_recipient_count
  )
  on conflict (position_id, tx_sig, source_wallet, token_mint) do nothing
  returning id into v_claim_id;
  if v_claim_id is null then
    select * into v_existing
    from public.follower_transfer_batches
    where position_id = p_position_id
      and tx_sig = p_tx_sig
      and source_wallet = p_source_wallet
      and token_mint = p_token_mint;
    return jsonb_build_object(
      'applied', false,
      'duplicate', true,
      'movedAmount', coalesce(v_existing.moved_amount, 0),
      'trackedAmount', coalesce(v_existing.tracked_amount, 0),
      'terminalAmount', coalesce(v_existing.terminal_amount, 0),
      'hopDepth', v_existing.hop_depth,
      'sourceTriggerEligible', coalesce(v_existing.source_trigger_eligible, false),
      'trackedWallets', coalesce(v_existing.tracked_wallets, '[]'::jsonb),
      'terminalWallets', coalesce(v_existing.terminal_wallets, '[]'::jsonb)
    );
  end if;

  v_scale := least(1, greatest(0, v_parent.current_amount) / v_total_requested);
  v_next_hop := greatest(1, coalesce(v_parent.hop_depth, 1)) + 1;

  for v_item in select value from jsonb_array_elements(p_recipients)
  loop
    v_wallet := trim(coalesce(v_item->>'wallet', ''));
    v_requested := greatest(0, coalesce((v_item->>'amountTokens')::numeric, 0));
    if v_wallet = '' or v_wallet = p_source_wallet or v_requested <= 0 then
      continue;
    end if;
    v_moved := v_requested * v_scale;
    if v_moved <= 0 then
      continue;
    end if;
    v_should_track := coalesce((v_item->>'track')::boolean, true) and v_next_hop <= 5;
    v_trigger_eligible :=
      v_should_track
      and coalesce(v_parent.trigger_eligible, true)
      and v_next_hop <= 3
      and coalesce((v_item->>'triggerEligible')::boolean, true);

    if v_should_track then
      insert into public.follower_wallets (
        position_id, wallet, initial_amount, current_amount, hop_depth,
        parent_wallet, trigger_eligible, unexplained_outflow_amount, released_at,
        last_seen_signature, last_seen_slot, last_updated
      ) values (
        p_position_id, v_wallet, v_moved, v_moved, v_next_hop,
        p_source_wallet, v_trigger_eligible, 0, null,
        p_tx_sig, p_slot, now()
      )
      on conflict (position_id, wallet) do update set
        initial_amount = follower_wallets.initial_amount + excluded.initial_amount,
        current_amount = follower_wallets.current_amount + excluded.current_amount,
        hop_depth = least(follower_wallets.hop_depth, excluded.hop_depth),
        parent_wallet = excluded.parent_wallet,
        -- Once a wallet is observation-only (pre-funded, ambiguous, or beyond
        -- the actionable hop limit), never promote its mixed balance later.
        trigger_eligible = follower_wallets.trigger_eligible and excluded.trigger_eligible,
        released_at = null,
        last_seen_signature = excluded.last_seen_signature,
        last_seen_slot = excluded.last_seen_slot,
        last_updated = excluded.last_updated;
      v_tracked_amount := v_tracked_amount + v_moved;
      if v_trigger_eligible then
        v_actionable_tracked_amount := v_actionable_tracked_amount + v_moved;
      else
        -- Keep observation-only movement in the actionable source's
        -- effective-unsold balance so its denominator cannot shrink.
        v_unresolved_amount := v_unresolved_amount + v_moved;
      end if;
      v_tracked_wallets := v_tracked_wallets || jsonb_build_array(v_wallet);
    else
      v_destination_class := case
        when v_next_hop > 5 then 'hop_limit'
        else left(coalesce(nullif(v_item->>'destinationClass', ''), 'unclassified'), 80)
      end;
      insert into public.follower_outflow_observations (
        user_id, position_id, source_wallet, destination_wallet, token_mint,
        amount_tokens, hop_depth, destination_class, trigger_eligible, tx_sig, slot
      ) values (
        v_user_id, p_position_id, p_source_wallet, v_wallet, p_token_mint,
        v_moved, least(v_next_hop, 5), v_destination_class,
        coalesce(v_parent.trigger_eligible, true), p_tx_sig, p_slot
      )
      on conflict (position_id, tx_sig, source_wallet, destination_wallet, token_mint)
      do update set
        amount_tokens = excluded.amount_tokens,
        hop_depth = excluded.hop_depth,
        destination_class = excluded.destination_class,
        trigger_eligible = excluded.trigger_eligible,
        slot = excluded.slot;
      v_terminal_amount := v_terminal_amount + v_moved;
      v_unresolved_amount := v_unresolved_amount + v_moved;
      v_terminal_wallets := v_terminal_wallets || jsonb_build_array(v_wallet);
    end if;
    v_total_moved := v_total_moved + v_moved;
  end loop;

  update public.follower_wallets set
    initial_amount = greatest(0, v_parent.initial_amount - v_actionable_tracked_amount),
    current_amount = greatest(0, v_parent.current_amount - v_total_moved),
    unexplained_outflow_amount =
      greatest(0, coalesce(v_parent.unexplained_outflow_amount, 0)) + v_unresolved_amount,
    last_seen_signature = p_tx_sig,
    last_seen_slot = p_slot,
    last_updated = now()
  where id = v_parent.id;

  update public.follower_transfer_batches set
    moved_amount = v_total_moved,
    tracked_amount = v_tracked_amount,
    terminal_amount = v_terminal_amount,
    hop_depth = v_next_hop,
    source_trigger_eligible = coalesce(v_parent.trigger_eligible, true),
    tracked_wallets = v_tracked_wallets,
    terminal_wallets = v_terminal_wallets
  where id = v_claim_id;

  return jsonb_build_object(
    'applied', true,
    'duplicate', false,
    'movedAmount', v_total_moved,
    'trackedAmount', v_tracked_amount,
    'terminalAmount', v_terminal_amount,
    'hopDepth', v_next_hop,
    'sourceTriggerEligible', coalesce(v_parent.trigger_eligible, true),
    'trackedWallets', v_tracked_wallets,
    'terminalWallets', v_terminal_wallets
  );
end;
$$;

create or replace function public.record_root_follower_transfer(
  p_position_id uuid,
  p_source_wallet text,
  p_follower_wallet text,
  p_token_mint text,
  p_tx_sig text,
  p_slot bigint,
  p_amount numeric,
  p_trigger_eligible boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid;
  v_event_id uuid;
  v_existing public.follower_accounting_events%rowtype;
  v_follower public.follower_wallets%rowtype;
  v_mismatch boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if coalesce(trim(p_source_wallet), '') = ''
     or coalesce(trim(p_follower_wallet), '') = ''
     or p_source_wallet = p_follower_wallet
     or coalesce(trim(p_token_mint), '') = ''
     or coalesce(trim(p_tx_sig), '') = ''
     or p_amount is null
     or p_amount <= 0 then
    raise exception 'invalid root follower transfer';
  end if;

  select user_id into v_user_id
  from public.positions
  where id = p_position_id
    and token_mint = p_token_mint
    and closed_at is null
  for update;
  if not found then
    return jsonb_build_object('applied', false, 'duplicate', false, 'reason', 'no_active_position');
  end if;

  insert into public.follower_accounting_events (
    user_id, position_id, event_kind, token_mint, source_wallet,
    follower_wallet, tx_sig, slot, requested_amount, fresh_for_action
  ) values (
    v_user_id, p_position_id, 'root_transfer', p_token_mint, p_source_wallet,
    p_follower_wallet, p_tx_sig, p_slot, p_amount, false
  )
  on conflict (position_id, event_kind, tx_sig, source_wallet, follower_wallet, token_mint)
    do nothing
  returning id into v_event_id;

  if v_event_id is null then
    select * into v_existing
    from public.follower_accounting_events
    where position_id = p_position_id
      and event_kind = 'root_transfer'
      and tx_sig = p_tx_sig
      and source_wallet = p_source_wallet
      and follower_wallet = p_follower_wallet
      and token_mint = p_token_mint;
    v_mismatch := abs(v_existing.requested_amount - p_amount)
      > greatest(0.000000001, abs(v_existing.requested_amount) * 0.000000001);
    return jsonb_build_object(
      'applied', false,
      'duplicate', true,
      'reason', v_existing.result_reason,
      'eventId', v_existing.id,
      'wallet', v_existing.follower_wallet,
      'appliedAmount', v_existing.applied_amount,
      'triggerEligible', v_existing.trigger_eligible,
      'payloadMismatch', v_mismatch
    );
  end if;

  insert into public.follower_wallets as existing_follower (
    position_id, wallet, initial_amount, current_amount, hop_depth,
    parent_wallet, trigger_eligible, unexplained_outflow_amount, released_at,
    last_seen_signature, last_seen_slot, last_updated
  ) values (
    p_position_id, p_follower_wallet, p_amount, p_amount, 1,
    p_source_wallet, coalesce(p_trigger_eligible, false), 0, null,
    p_tx_sig, p_slot, now()
  )
  on conflict (position_id, wallet) do update set
    initial_amount = existing_follower.initial_amount + excluded.initial_amount,
    current_amount = existing_follower.current_amount + excluded.current_amount,
    hop_depth = least(existing_follower.hop_depth, excluded.hop_depth),
    parent_wallet = excluded.parent_wallet,
    -- A mixed/pre-funded or observation-only wallet can never be promoted by a
    -- later top-up whose balance cannot be separated from the earlier tokens.
    trigger_eligible = existing_follower.trigger_eligible and excluded.trigger_eligible,
    released_at = null,
    last_seen_signature = case
      when excluded.last_seen_slot is null
        or existing_follower.last_seen_slot is null
        or excluded.last_seen_slot >= existing_follower.last_seen_slot
      then excluded.last_seen_signature
      else existing_follower.last_seen_signature
    end,
    last_seen_slot = greatest(
      coalesce(existing_follower.last_seen_slot, excluded.last_seen_slot),
      coalesce(excluded.last_seen_slot, existing_follower.last_seen_slot)
    ),
    last_updated = now();

  select * into v_follower
  from public.follower_wallets
  where position_id = p_position_id and wallet = p_follower_wallet;

  update public.follower_accounting_events set
    applied_amount = p_amount,
    trigger_eligible = coalesce(v_follower.trigger_eligible, false),
    result_initial_amount = v_follower.initial_amount,
    result_current_amount = v_follower.current_amount,
    result_reason = null
  where id = v_event_id;

  return jsonb_build_object(
    'applied', true,
    'duplicate', false,
    'reason', null,
    'eventId', v_event_id,
    'wallet', p_follower_wallet,
    'appliedAmount', p_amount,
    'triggerEligible', coalesce(v_follower.trigger_eligible, false),
    'payloadMismatch', false
  );
end;
$$;

create or replace function public.record_follower_sell_event(
  p_position_id uuid,
  p_follower_wallet text,
  p_token_mint text,
  p_tx_sig text,
  p_slot bigint,
  p_sold_amount numeric,
  p_count_as_distinct_seller boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid;
  v_event_id uuid;
  v_existing public.follower_accounting_events%rowtype;
  v_follower public.follower_wallets%rowtype;
  v_applied numeric := 0;
  v_initial_total numeric := 0;
  v_effective_remaining numeric := 0;
  v_sold_fraction numeric := 0;
  v_distinct_count integer := 0;
  v_first_fresh boolean := false;
  v_mismatch boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if coalesce(trim(p_follower_wallet), '') = ''
     or coalesce(trim(p_token_mint), '') = ''
     or coalesce(trim(p_tx_sig), '') = ''
     or p_sold_amount is null
     or p_sold_amount <= 0 then
    raise exception 'invalid follower sell';
  end if;

  select user_id into v_user_id
  from public.positions
  where id = p_position_id
    and token_mint = p_token_mint
    and closed_at is null
  for update;
  if not found then
    return jsonb_build_object('applied', false, 'duplicate', false, 'reason', 'no_active_position');
  end if;

  insert into public.follower_accounting_events (
    user_id, position_id, event_kind, token_mint, source_wallet,
    follower_wallet, tx_sig, slot, requested_amount, fresh_for_action
  ) values (
    v_user_id, p_position_id, 'follower_sell', p_token_mint, p_follower_wallet,
    p_follower_wallet, p_tx_sig, p_slot, p_sold_amount,
    coalesce(p_count_as_distinct_seller, false)
  )
  on conflict (position_id, event_kind, tx_sig, source_wallet, follower_wallet, token_mint)
    do nothing
  returning id into v_event_id;

  if v_event_id is null then
    select * into v_existing
    from public.follower_accounting_events
    where position_id = p_position_id
      and event_kind = 'follower_sell'
      and tx_sig = p_tx_sig
      and source_wallet = p_follower_wallet
      and follower_wallet = p_follower_wallet
      and token_mint = p_token_mint;
    v_mismatch := abs(v_existing.requested_amount - p_sold_amount)
      > greatest(0.000000001, abs(v_existing.requested_amount) * 0.000000001);
    return jsonb_build_object(
      'applied', false,
      'duplicate', true,
      'reason', v_existing.result_reason,
      'eventId', v_existing.id,
      'appliedAmount', v_existing.applied_amount,
      'soldFraction', coalesce(v_existing.sold_fraction, 0),
      'distinctSellerCount', coalesce(v_existing.distinct_seller_count, 0),
      'firstSellByWallet', v_existing.first_sell_by_wallet,
      'triggerEligible', v_existing.trigger_eligible,
      'freshForAction', v_existing.fresh_for_action,
      'payloadMismatch', v_mismatch
    );
  end if;

  select * into v_follower
  from public.follower_wallets
  where position_id = p_position_id
    and wallet = p_follower_wallet
    and released_at is null
  for update;
  if not found then
    update public.follower_accounting_events set result_reason = 'follower_not_retained'
    where id = v_event_id;
    return jsonb_build_object(
      'applied', false,
      'duplicate', false,
      'reason', 'follower_not_retained',
      'eventId', v_event_id,
      'appliedAmount', 0,
      'soldFraction', 0,
      'distinctSellerCount', 0,
      'firstSellByWallet', false,
      'triggerEligible', false,
      'freshForAction', false,
      'payloadMismatch', false
    );
  end if;

  v_applied := least(greatest(v_follower.current_amount, 0), p_sold_amount);
  v_first_fresh := coalesce(p_count_as_distinct_seller, false)
    and v_follower.first_fresh_sell_at is null;

  update public.follower_wallets set
    current_amount = greatest(0, current_amount - v_applied),
    first_sell_at = coalesce(first_sell_at, now()),
    first_fresh_sell_at = case
      when coalesce(p_count_as_distinct_seller, false)
      then coalesce(first_fresh_sell_at, now())
      else first_fresh_sell_at
    end,
    last_seen_signature = case
      when p_slot is null or last_seen_slot is null or p_slot >= last_seen_slot
      then p_tx_sig else last_seen_signature
    end,
    last_seen_slot = greatest(
      coalesce(last_seen_slot, p_slot),
      coalesce(p_slot, last_seen_slot)
    ),
    last_updated = now()
  where id = v_follower.id
  returning * into v_follower;

  select
    coalesce(sum(initial_amount), 0),
    coalesce(sum(current_amount + unexplained_outflow_amount), 0),
    count(*) filter (where first_fresh_sell_at is not null)
  into v_initial_total, v_effective_remaining, v_distinct_count
  from public.follower_wallets
  where position_id = p_position_id
    and trigger_eligible = true
    and released_at is null;
  if v_initial_total > 0 then
    v_sold_fraction := least(
      1,
      greatest(0, 1 - (v_effective_remaining / v_initial_total))
    );
  end if;

  update public.follower_accounting_events set
    applied_amount = v_applied,
    trigger_eligible = coalesce(v_follower.trigger_eligible, false),
    first_sell_by_wallet = v_first_fresh,
    sold_fraction = v_sold_fraction,
    distinct_seller_count = v_distinct_count,
    result_initial_amount = v_follower.initial_amount,
    result_current_amount = v_follower.current_amount,
    result_reason = case when v_applied > 0 then null else 'no_retained_balance' end
  where id = v_event_id;

  return jsonb_build_object(
    'applied', v_applied > 0,
    'duplicate', false,
    'reason', case when v_applied > 0 then null else 'no_retained_balance' end,
    'eventId', v_event_id,
    'appliedAmount', v_applied,
    'soldFraction', v_sold_fraction,
    'distinctSellerCount', v_distinct_count,
    'firstSellByWallet', v_first_fresh,
    'triggerEligible', coalesce(v_follower.trigger_eligible, false),
    'freshForAction', coalesce(p_count_as_distinct_seller, false),
    'payloadMismatch', false
  );
end;
$$;

alter table public.worker_heartbeat
  add column if not exists rpc_last_success_at timestamptz,
  add column if not exists rpc_backlog_wallet_count integer not null default 0,
  add column if not exists monitoring_degraded boolean not null default false,
  add column if not exists follower_balance_last_checked_at timestamptz,
  add column if not exists follower_balance_candidate_count integer not null default 0,
  add column if not exists follower_balance_mismatch_count integer not null default 0,
  add column if not exists follower_balance_reconciliation_degraded boolean not null default true,
  add column if not exists follower_balance_last_error text;

grant select on public.rpc_wallet_cursors, public.position_target_wallets,
  public.sell_signal_claims, public.entry_signal_claims, public.follower_accounting_events,
  public.follower_outflow_observations,
  public.target_outflow_observations, public.follower_transfer_batches,
  public.follower_balance_alerts to authenticated;
grant all on public.rpc_wallet_cursors, public.position_target_wallets,
  public.sell_signal_claims, public.entry_signal_claims, public.follower_accounting_events,
  public.follower_outflow_observations,
  public.target_outflow_observations, public.follower_transfer_batches,
  public.follower_balance_alerts to service_role;
revoke all on function public.record_follower_transfer_batch(uuid, text, text, text, bigint, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_follower_transfer_batch(uuid, text, text, text, bigint, jsonb)
  to service_role;
revoke all on function public.record_root_follower_transfer(
  uuid, text, text, text, text, bigint, numeric, boolean
) from public, anon, authenticated;
grant execute on function public.record_root_follower_transfer(
  uuid, text, text, text, text, bigint, numeric, boolean
) to service_role;
revoke all on function public.record_follower_sell_event(
  uuid, text, text, text, bigint, numeric, boolean
) from public, anon, authenticated;
grant execute on function public.record_follower_sell_event(
  uuid, text, text, text, bigint, numeric, boolean
) to service_role;

alter table public.rpc_wallet_cursors enable row level security;
alter table public.position_target_wallets enable row level security;
alter table public.sell_signal_claims enable row level security;
alter table public.entry_signal_claims enable row level security;
alter table public.follower_accounting_events enable row level security;
alter table public.follower_outflow_observations enable row level security;
alter table public.target_outflow_observations enable row level security;
alter table public.follower_transfer_batches enable row level security;
alter table public.follower_balance_alerts enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'rpc_wallet_cursors'
      and policyname = 'read own rpc wallet cursors'
  ) then
    create policy "read own rpc wallet cursors" on public.rpc_wallet_cursors
      for select to authenticated using (user_id = auth.uid());
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'position_target_wallets'
      and policyname = 'read own position target wallets'
  ) then
    create policy "read own position target wallets" on public.position_target_wallets
      for select to authenticated using (user_id = auth.uid());
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'sell_signal_claims'
      and policyname = 'read own sell signal claims'
  ) then
    create policy "read own sell signal claims" on public.sell_signal_claims
      for select to authenticated using (user_id = auth.uid());
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'entry_signal_claims'
      and policyname = 'read own entry signal claims'
  ) then
    create policy "read own entry signal claims" on public.entry_signal_claims
      for select to authenticated using (user_id = auth.uid());
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'follower_accounting_events'
      and policyname = 'read own follower accounting events'
  ) then
    create policy "read own follower accounting events" on public.follower_accounting_events
      for select to authenticated using (user_id = auth.uid());
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'follower_outflow_observations'
      and policyname = 'read own follower outflows'
  ) then
    create policy "read own follower outflows" on public.follower_outflow_observations
      for select to authenticated using (user_id = auth.uid());
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'target_outflow_observations'
      and policyname = 'read own target outflows'
  ) then
    create policy "read own target outflows" on public.target_outflow_observations
      for select to authenticated using (user_id = auth.uid());
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'follower_transfer_batches'
      and policyname = 'read own follower transfer batches'
  ) then
    create policy "read own follower transfer batches" on public.follower_transfer_batches
      for select to authenticated using (user_id = auth.uid());
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'follower_balance_alerts'
      and policyname = 'read own follower balance alerts'
  ) then
    create policy "read own follower balance alerts" on public.follower_balance_alerts
      for select to authenticated using (user_id = auth.uid());
  end if;
end $$;

revoke all on function public.record_strategy_observations(jsonb)
  from public, anon, authenticated;
grant execute on function public.record_strategy_observations(jsonb) to service_role;

create or replace function public.strategy_insights(
  p_user_id uuid,
  p_since timestamptz default now() - interval '24 hours'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if auth.role() <> 'service_role' and auth.uid() is distinct from p_user_id then
    raise exception 'not authorized';
  end if;

  with scope as (
    select event_key, tx_sig, event_at, relationship, event_kind, side,
           actor_wallet, from_wallet, to_wallet, token_mint, amount_tokens,
           amount_usd, market_cap_usd, liquidity_usd, bot_decision,
           bot_reason, source, reaction_ms, execution_ms
      from public.strategy_observations
     where user_id = p_user_id
       and event_at >= p_since
  ),
  target_buys as (
    select *
      from scope
     where relationship = 'target'
       and event_kind = 'swap'
       and side = 'buy'
  ),
  split_counts as (
    select tx_sig, token_mint, count(distinct to_wallet)::numeric as recipients
      from scope
     where relationship = 'target'
       and event_kind = 'transfer'
       and to_wallet is not null
     group by tx_sig, token_mint
  ),
  active_hour as (
    select extract(hour from event_at at time zone 'UTC')::int as hour_utc
      from scope
     where relationship = 'target'
     group by 1
     order by count(*) desc, 1
     limit 1
  ),
  recent as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'event_key', event_key,
          'tx_sig', tx_sig,
          'event_at', event_at,
          'relationship', relationship,
          'event_kind', event_kind,
          'side', side,
          'actor_wallet', actor_wallet,
          'from_wallet', from_wallet,
          'to_wallet', to_wallet,
          'token_mint', token_mint,
          'amount_tokens', amount_tokens,
          'amount_usd', amount_usd,
          'market_cap_usd', market_cap_usd,
          'liquidity_usd', liquidity_usd,
          'bot_decision', bot_decision,
          'bot_reason', bot_reason,
          'source', source
        )
        order by event_at desc
      ),
      '[]'::jsonb
    ) as rows
    from (
      select *
        from scope
       order by event_at desc
       limit 20
    ) latest
  )
  select jsonb_build_object(
    'since', p_since,
    'generated_at', now(),
    'total_observations', (select count(*) from scope),
    'target_buys', (select count(*) from target_buys),
    'target_sells', (
      select count(*) from scope
       where relationship = 'target' and event_kind = 'swap' and side = 'sell'
    ),
    'target_transfers', (
      select count(*) from scope
       where relationship = 'target' and event_kind = 'transfer'
    ),
    'follower_sells', (
      select count(*) from scope
       where relationship = 'follower' and event_kind = 'swap' and side = 'sell'
    ),
    'unique_mints', (select count(distinct token_mint) from scope),
    'copied_buys', (select count(*) from target_buys where bot_decision = 'copied'),
    'filtered_buys', (select count(*) from target_buys where bot_decision = 'filtered'),
    'failed_actions', (select count(*) from scope where bot_decision = 'failed'),
    'median_buy_reaction_ms', (
      select percentile_cont(0.5) within group (order by reaction_ms)
        from target_buys
       where bot_decision = 'copied' and reaction_ms is not null
    ),
    'median_buy_execution_ms', (
      select percentile_cont(0.5) within group (order by execution_ms)
        from target_buys
       where bot_decision = 'copied' and execution_ms is not null
    ),
    'median_sell_reaction_ms', (
      select percentile_cont(0.5) within group (order by reaction_ms)
        from scope
       where relationship = 'follower'
         and event_kind = 'swap'
         and side = 'sell'
         and bot_decision = 'mirrored'
         and reaction_ms is not null
    ),
    'median_sell_execution_ms', (
      select percentile_cont(0.5) within group (order by execution_ms)
        from scope
       where relationship = 'follower'
         and event_kind = 'swap'
         and side = 'sell'
         and bot_decision = 'mirrored'
         and execution_ms is not null
    ),
    'learning_confidence_pct', least(
      100::numeric,
      round(((select count(*) from target_buys)::numeric / 50::numeric) * 100, 0)
    ),
    'top_filter_reasons', (
      select coalesce(
        jsonb_agg(
          jsonb_build_object('reason', reason, 'count', occurrences)
          order by occurrences desc, reason
        ),
        '[]'::jsonb
      )
      from (
        select coalesce(nullif(bot_reason, ''), 'unspecified') as reason,
               count(*)::int as occurrences
          from target_buys
         where bot_decision in ('filtered', 'skipped', 'failed')
         group by 1
         order by 2 desc, 1
         limit 5
      ) ranked_reasons
    ),
    'median_target_buy_usd', (
      select percentile_cont(0.5) within group (order by amount_usd)
        from target_buys where amount_usd is not null
    ),
    'median_entry_market_cap_usd', (
      select percentile_cont(0.5) within group (order by market_cap_usd)
        from target_buys where market_cap_usd is not null
    ),
    'median_entry_liquidity_usd', (
      select percentile_cont(0.5) within group (order by liquidity_usd)
        from target_buys where liquidity_usd is not null
    ),
    'average_transfer_recipients', (select avg(recipients) from split_counts),
    'most_active_hour_utc', (select hour_utc from active_hour),
    'recent', (select rows from recent)
  )
  into result;

  return result;
end;
$$;

revoke all on function public.strategy_insights(uuid, timestamptz) from public, anon;
grant execute on function public.strategy_insights(uuid, timestamptz)
  to authenticated, service_role;

grant select on public.strategy_observations to authenticated;
grant all on public.strategy_observations to service_role;
alter table public.strategy_observations enable row level security;

do $$
begin
  if not exists (
    select 1
      from pg_policies
     where schemaname = 'public'
       and tablename = 'strategy_observations'
       and policyname = 'own strategy observations'
  ) then
    create policy "own strategy observations" on public.strategy_observations
      for select to authenticated using (user_id = auth.uid());
  end if;
end;
$$;
