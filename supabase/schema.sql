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
  min_target_buy_usd numeric not null default 100,
  mc_min_usd numeric not null default 20000,
  mc_max_usd numeric not null default 5000000,
  liq_min_usd numeric not null default 10000,
  liq_max_usd numeric not null default 2000000,
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

-- Encrypted funding wallet private keys (AES-256-GCM ciphertext blobs)
create table if not exists public.funding_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique,
  wallet_pubkey text not null,
  ciphertext text not null,          -- base64: iv | tag | ct
  created_at timestamptz not null default now()
);

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
create index if not exists positions_user_open_idx on public.positions (user_id) where closed_at is null;

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

-- Global "tokens the bot has ever traded" for once-per-token filter
create table if not exists public.traded_tokens (
  user_id uuid not null,
  token_mint text not null,
  first_traded_at timestamptz not null default now(),
  primary key (user_id, token_mint)
);

-- Grants (Supabase Data API needs explicit grants on public schema)
grant select, insert, update, delete on public.bot_config to authenticated;
grant select, insert, update, delete on public.positions to authenticated;
grant select, insert, update, delete on public.follower_wallets to authenticated;
grant select, insert, update, delete on public.trades to authenticated;
grant select, insert, update, delete on public.traded_tokens to authenticated;
grant all on public.bot_config, public.funding_keys, public.positions,
              public.follower_wallets, public.trades, public.traded_tokens to service_role;

-- RLS: user isolation
alter table public.bot_config enable row level security;
alter table public.funding_keys enable row level security;
alter table public.positions enable row level security;
alter table public.follower_wallets enable row level security;
alter table public.trades enable row level security;
alter table public.traded_tokens enable row level security;

create policy "own config" on public.bot_config
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- funding_keys never accessible to authenticated role (service_role only)
create policy "own positions" on public.positions
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own trades" on public.trades
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own traded tokens" on public.traded_tokens
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own follower rows" on public.follower_wallets
  for all to authenticated
  using (exists (select 1 from public.positions p where p.id = position_id and p.user_id = auth.uid()))
  with check (exists (select 1 from public.positions p where p.id = position_id and p.user_id = auth.uid()));
