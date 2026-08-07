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
