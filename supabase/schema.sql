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

-- CUSTODY_JOURNEY_CANONICAL_MIRROR_BEGIN
-- Custody Journey observation ledger.
-- Additive and repeatable. Installation leaves observation disabled and never
-- changes Entries, positions, trading claims, or trading-worker health.

alter table public.bot_config
  add column if not exists custody_journey_enabled boolean not null default false;

create table if not exists public.custody_journeys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  token_mint text not null,
  status text not null default 'active' check (status in ('active', 'flat')),
  started_at timestamptz not null,
  last_activity_at timestamptz not null,
  flat_at timestamptz,
  flat_reason text,
  total_verified_target_buy_tokens numeric not null default 0
    check (total_verified_target_buy_tokens >= 0),
  total_verified_custody_sell_tokens numeric not null default 0
    check (total_verified_custody_sell_tokens >= 0),
  total_unresolved_outflow_tokens numeric not null default 0
    check (total_unresolved_outflow_tokens >= 0),
  current_attributed_tokens numeric not null default 0
    check (current_attributed_tokens >= 0),
  source_target_wallets text[] not null default '{}',
  first_event_key text not null,
  last_event_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.custody_journeys
  add column if not exists total_unresolved_outflow_tokens numeric not null default 0;

create unique index if not exists custody_journeys_one_active_mint_idx
  on public.custody_journeys (user_id, token_mint)
  where status = 'active';
create index if not exists custody_journeys_status_activity_idx
  on public.custody_journeys (user_id, status, last_activity_at desc);
create index if not exists custody_journeys_token_history_idx
  on public.custody_journeys (user_id, token_mint, started_at desc);
create index if not exists custody_journeys_exposure_idx
  on public.custody_journeys (
    user_id,
    current_attributed_tokens desc,
    last_activity_at desc
  ) where status = 'active';

create table if not exists public.custody_wallet_profiles (
  user_id uuid not null,
  wallet text not null,
  inferred_type text not null default 'unknown' check (inferred_type in (
    'unknown', 'target', 'custody', 'exchange', 'dex_pool', 'router', 'bridge',
    'vault', 'escrow', 'program', 'burn', 'other', 'cold_storage_candidate',
    'hot_wallet_candidate', 'exchange_candidate', 'routing_wallet'
  )),
  inferred_label text,
  inference_confidence numeric not null default 0
    check (inference_confidence between 0 and 1),
  inference_source text,
  manual_type text check (manual_type is null or manual_type in (
    'unknown', 'target', 'custody', 'exchange', 'dex_pool', 'router', 'bridge',
    'vault', 'escrow', 'program', 'burn', 'other', 'cold_storage_candidate',
    'hot_wallet_candidate', 'exchange_candidate', 'routing_wallet'
  )),
  manual_label text,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, wallet)
);

create index if not exists custody_wallet_profiles_type_activity_idx
  on public.custody_wallet_profiles (
    user_id,
    (coalesce(manual_type, inferred_type)),
    last_seen_at desc
  );
create index if not exists custody_wallet_profiles_label_idx
  on public.custody_wallet_profiles (
    user_id,
    (coalesce(manual_label, inferred_label))
  );

create table if not exists public.custody_journey_wallets (
  id uuid primary key default gen_random_uuid(),
  journey_id uuid not null references public.custody_journeys(id),
  user_id uuid not null,
  token_mint text not null,
  wallet text not null,
  -- Conservative maximum path depth. Keeping the maximum prevents cycles from
  -- resetting a cohort back to a shallower hop when paths merge.
  hop_depth integer not null check (hop_depth >= 0),
  parent_wallet text,
  source_target_wallets text[] not null default '{}',
  watch_status text not null default 'active'
    check (watch_status in ('active', 'released', 'unwatchable')),
  current_attributed_tokens numeric not null default 0
    check (current_attributed_tokens >= 0),
  last_observed_balance_tokens numeric
    check (last_observed_balance_tokens is null or last_observed_balance_tokens >= 0),
  attributed_share numeric
    check (attributed_share is null or attributed_share between 0 and 1),
  balance_evidence_reliable boolean not null default false,
  total_received_tokens numeric not null default 0 check (total_received_tokens >= 0),
  total_transferred_tokens numeric not null default 0 check (total_transferred_tokens >= 0),
  total_verified_sold_tokens numeric not null default 0
    check (total_verified_sold_tokens >= 0),
  total_unresolved_outflow_tokens numeric not null default 0
    check (total_unresolved_outflow_tokens >= 0),
  first_seen_at timestamptz not null,
  last_activity_at timestamptz not null,
  last_balance_observed_at timestamptz,
  released_at timestamptz,
  release_reason text,
  last_event_key text not null,
  last_tx_sig text not null,
  -- Earliest slot from which this wallet may carry the journey cohort. Unlike
  -- last_slot, this never moves forward and survives a crash before the new
  -- wallet receives its first RPC poll.
  watch_anchor_slot bigint,
  last_slot bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (journey_id, wallet)
);

alter table public.custody_journey_wallets
  add column if not exists last_observed_balance_tokens numeric,
  add column if not exists attributed_share numeric,
  add column if not exists balance_evidence_reliable boolean not null default false,
  add column if not exists total_unresolved_outflow_tokens numeric not null default 0,
  add column if not exists last_balance_observed_at timestamptz,
  add column if not exists watch_anchor_slot bigint;

create index if not exists custody_journey_wallets_watch_idx
  on public.custody_journey_wallets (user_id, watch_status, last_activity_at desc);
create index if not exists custody_journey_wallets_balance_idx
  on public.custody_journey_wallets (journey_id, current_attributed_tokens desc);
create index if not exists custody_journey_wallets_wallet_idx
  on public.custody_journey_wallets (user_id, wallet, last_activity_at desc);
create index if not exists custody_journey_wallets_hop_idx
  on public.custody_journey_wallets (journey_id, hop_depth, watch_status);

create table if not exists public.custody_journey_events (
  id uuid primary key default gen_random_uuid(),
  journey_id uuid not null references public.custody_journeys(id),
  user_id uuid not null,
  event_key text not null,
  event_type text not null check (event_type in (
    'VERIFIED_TARGET_BUY', 'CUSTODY_TRANSFER', 'VERIFIED_CUSTODY_SELL'
  )),
  request_fingerprint text not null,
  tx_sig text not null,
  slot bigint,
  event_at timestamptz not null,
  source_wallet text not null,
  destination_wallet text,
  requested_amount_tokens numeric not null check (requested_amount_tokens >= 0),
  applied_amount_tokens numeric not null default 0 check (applied_amount_tokens >= 0),
  reconciled_amount_tokens numeric not null default 0
    check (reconciled_amount_tokens >= 0),
  source_pre_amount_tokens numeric
    check (source_pre_amount_tokens is null or source_pre_amount_tokens >= 0),
  source_post_amount_tokens numeric
    check (source_post_amount_tokens is null or source_post_amount_tokens >= 0),
  evidence_reliable boolean not null default false,
  -- Transfer recipients retain exact pre/post and raw evidence plus the
  -- database's applied attribution and boundary decision for replay/audit.
  recipients jsonb not null default '[]'::jsonb,
  result_reason text,
  result_journey_status text not null default 'active'
    check (result_journey_status in ('active', 'flat')),
  result_watched_wallets text[] not null default '{}',
  result_released_wallets text[] not null default '{}',
  journey_released boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default now(),
  unique (user_id, event_key)
);

alter table public.custody_journey_events
  add column if not exists reconciled_amount_tokens numeric not null default 0,
  add column if not exists source_pre_amount_tokens numeric,
  add column if not exists source_post_amount_tokens numeric,
  add column if not exists evidence_reliable boolean not null default false;

create index if not exists custody_journey_events_user_time_idx
  on public.custody_journey_events (user_id, event_at desc);
create index if not exists custody_journey_events_journey_time_idx
  on public.custody_journey_events (journey_id, event_at desc);
create index if not exists custody_journey_events_type_time_idx
  on public.custody_journey_events (user_id, event_type, event_at desc);
create index if not exists custody_journey_events_wallet_time_idx
  on public.custody_journey_events (user_id, source_wallet, event_at desc);
create index if not exists custody_journey_events_recipients_gin_idx
  on public.custody_journey_events using gin (recipients jsonb_path_ops);

-- Custody recovery cursors are intentionally independent of trading cursors.
create table if not exists public.custody_rpc_wallet_cursors (
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

create index if not exists custody_rpc_wallet_cursors_health_idx
  on public.custody_rpc_wallet_cursors (user_id, backlog_detected, last_success_at);

-- Custody health is separate from worker_heartbeat. A degraded observer must
-- never stop, restart, enable, disable, or gate the trading worker.
create table if not exists public.custody_worker_heartbeat (
  user_id uuid primary key,
  started_at timestamptz not null,
  updated_at timestamptz not null default now(),
  enabled boolean not null default false,
  geyser_connected boolean not null default false,
  last_geyser_message_at timestamptz,
  decoded_event_count bigint not null default 0 check (decoded_event_count >= 0),
  rpc_last_poll_at timestamptz,
  rpc_last_success_at timestamptz,
  rpc_backlog_wallet_count integer not null default 0
    check (rpc_backlog_wallet_count >= 0),
  watched_wallet_count integer not null default 0 check (watched_wallet_count >= 0),
  active_journey_count integer not null default 0 check (active_journey_count >= 0),
  last_event_at timestamptz,
  degraded boolean not null default false,
  last_error text
);

create index if not exists custody_worker_heartbeat_health_idx
  on public.custody_worker_heartbeat (enabled, degraded, updated_at);

-- Durable out-of-order inbox. Rows are retained after resolution for audit;
-- replay changes status and never deletes evidence.
create table if not exists public.custody_pending_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  event_key text not null,
  event_type text not null check (event_type in (
    'CUSTODY_TRANSFER', 'VERIFIED_CUSTODY_SELL'
  )),
  request_fingerprint text not null,
  token_mint text not null,
  tx_sig text not null,
  slot bigint,
  event_at timestamptz not null,
  source_wallet text not null,
  requested_amount_tokens numeric not null check (requested_amount_tokens > 0),
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'applied', 'expired', 'terminal')),
  retry_count integer not null default 0 check (retry_count >= 0),
  next_retry_at timestamptz not null default now(),
  last_retry_at timestamptz,
  last_error_code text,
  journey_id uuid references public.custody_journeys(id),
  event_id uuid references public.custody_journey_events(id),
  result jsonb,
  expires_at timestamptz not null default (now() + interval '24 hours'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, event_key)
);

create index if not exists custody_pending_events_replay_idx
  on public.custody_pending_events (user_id, status, event_at, created_at)
  where status = 'pending';
create index if not exists custody_pending_events_wallet_idx
  on public.custody_pending_events (user_id, token_mint, source_wallet, status);

-- Record one verified target-wallet buy. Multiple verified buys for the same
-- user and mint add to one active campaign. Exact replay returns the original
-- watch/release work without changing balances twice.
create or replace function public.record_custody_target_buy(
  p_user_id uuid,
  p_target_wallet text,
  p_token_mint text,
  p_event_key text,
  p_tx_sig text,
  p_slot bigint,
  p_event_at timestamptz,
  p_amount_tokens numeric,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_enabled boolean;
  v_fingerprint text;
  v_existing_event public.custody_journey_events%rowtype;
  v_journey public.custody_journeys%rowtype;
  v_existing_wallet public.custody_journey_wallets%rowtype;
  v_event_id uuid;
  v_amount numeric := p_amount_tokens;
  v_amount_raw_text text;
  v_amount_raw numeric(78, 0);
  v_target text := btrim(coalesce(p_target_wallet, ''));
  v_mint text := btrim(coalesce(p_token_mint, ''));
  v_event_key text := btrim(coalesce(p_event_key, ''));
  v_tx_sig text := btrim(coalesce(p_tx_sig, ''));
  v_active_wallet_count integer := 0;
  v_wallet_exists boolean := false;
  v_should_watch boolean := false;
  v_watched text[] := '{}';
  v_chronology_reason text;
  v_balance_pre_text text;
  v_balance_post_text text;
  v_balance_decimals_text text;
  v_balance_pre numeric;
  v_balance_post numeric;
  v_balance_pre_raw numeric(78, 0);
  v_balance_post_raw numeric(78, 0);
  v_balance_decimals integer;
  v_balance_scale numeric;
  v_balance_reliable boolean := false;
  v_prior_share numeric := 0;
  v_unresolved numeric := 0;
  v_result_reason text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_user_id is null
     or v_target = ''
     or v_mint = ''
     or v_event_key = ''
     or v_tx_sig = ''
     or p_event_at is null
     or p_amount_tokens is null
     or p_amount_tokens < 0
     or (p_slot is not null and p_slot < 0)
     or jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object'
     or coalesce((p_metadata->>'verifiedSwap')::boolean, false) is not true then
    raise exception 'invalid or unverified custody target buy';
  end if;

  v_amount_raw_text := btrim(coalesce(
    p_metadata->>'grossAmountRaw',
    p_metadata->>'amountRaw',
    ''
  ));
  if v_amount_raw_text <> '' then
    v_balance_decimals_text := btrim(coalesce(p_metadata->>'decimals', ''));
    if v_amount_raw_text !~ '^[0-9]+$'
       or v_balance_decimals_text !~ '^[0-9]{1,3}$'
       or v_balance_decimals_text::integer > 255 then
      raise exception 'custody target buy raw amount is invalid';
    end if;
    v_amount_raw := v_amount_raw_text::numeric(78, 0);
    if v_amount_raw <= 0 then
      raise exception 'custody target buy raw amount is not positive';
    end if;
    v_balance_decimals := v_balance_decimals_text::integer;
    v_balance_scale := power(10::numeric, v_balance_decimals);
    v_amount := v_amount_raw / v_balance_scale;
  elsif v_amount <= 0 then
    raise exception 'custody target buy requires a positive amount';
  end if;

  -- Seed a confirmed wallet-wide balance boundary when the decoder supplied
  -- it. Raw balances are authoritative; UI balances are only a legacy fallback.
  if p_metadata ? 'tokenBalanceBeforeRaw'
     or p_metadata ? 'tokenBalanceAfterRaw' then
    v_balance_decimals_text := btrim(coalesce(p_metadata->>'decimals', ''));
    if btrim(coalesce(p_metadata->>'tokenBalanceBeforeRaw', '')) !~ '^[0-9]+$'
       or btrim(coalesce(p_metadata->>'tokenBalanceAfterRaw', '')) !~ '^[0-9]+$'
       or v_balance_decimals_text !~ '^[0-9]{1,3}$' then
      raise exception 'custody target buy raw balance evidence is incomplete';
    end if;
    v_balance_pre_raw := (p_metadata->>'tokenBalanceBeforeRaw')::numeric(78, 0);
    v_balance_post_raw := (p_metadata->>'tokenBalanceAfterRaw')::numeric(78, 0);
    v_balance_decimals := v_balance_decimals_text::integer;
    if v_balance_decimals > 255 or v_balance_post_raw < v_balance_pre_raw then
      raise exception 'custody target buy raw balance evidence is invalid';
    end if;
    v_balance_scale := power(10::numeric, v_balance_decimals);
    v_balance_pre := v_balance_pre_raw / v_balance_scale;
    v_balance_post := v_balance_post_raw / v_balance_scale;
    v_balance_reliable := true;
  elsif p_metadata ? 'tokenBalanceBefore'
        or p_metadata ? 'tokenBalanceAfter' then
    v_balance_pre_text := btrim(coalesce(p_metadata->>'tokenBalanceBefore', ''));
    v_balance_post_text := btrim(coalesce(p_metadata->>'tokenBalanceAfter', ''));
    if v_balance_pre_text !~ '^[+]?[0-9]+([.][0-9]+)?$'
       or v_balance_post_text !~ '^[+]?[0-9]+([.][0-9]+)?$' then
      raise exception 'custody target buy balance evidence is incomplete';
    end if;
    v_balance_pre := v_balance_pre_text::numeric;
    v_balance_post := v_balance_post_text::numeric;
    if v_balance_post < v_balance_pre then
      raise exception 'custody target buy balance evidence is invalid';
    end if;
    v_balance_reliable := true;
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(v_mint));
  -- Replay identity intentionally excludes delivery timestamps and metadata.
  -- Geyser and RPC may enrich those fields differently for the same chain buy.
  v_fingerprint := md5(jsonb_build_object(
    'eventType', 'VERIFIED_TARGET_BUY',
    'targetWallet', v_target,
    'tokenMint', v_mint,
    'txSig', v_tx_sig,
    'slot', p_slot,
    'amountRaw', case when v_amount_raw is not null then v_amount_raw else null end,
    'decimals', case when v_amount_raw is not null then v_balance_decimals else null end,
    'amountTokens', case when v_amount_raw is null then v_amount else null end
  )::text);

  select * into v_existing_event
  from public.custody_journey_events
  where user_id = p_user_id and event_key = v_event_key;
  if found then
    if v_existing_event.request_fingerprint = v_fingerprint then
      update public.custody_journey_events set
        metadata = metadata || coalesce(p_metadata, '{}'::jsonb)
      where id = v_existing_event.id;
    else
      update public.custody_journey_events set
        result_reason = 'payload_mismatch',
        metadata = metadata || jsonb_build_object(
          'payloadConflictObserved', true,
          'payloadConflictObservedAt', now()
        )
      where id = v_existing_event.id;
    end if;
    return jsonb_build_object(
      'applied', false,
      'duplicate', true,
      'payloadMismatch', v_existing_event.request_fingerprint <> v_fingerprint,
      'reason', case
        when v_existing_event.request_fingerprint <> v_fingerprint then 'payload_mismatch'
        else v_existing_event.result_reason
      end,
      'journeyId', v_existing_event.journey_id,
      'eventId', v_existing_event.id,
      'journeyStatus', v_existing_event.result_journey_status,
      'appliedAmountTokens', v_existing_event.applied_amount_tokens,
      'watchedWallets', v_existing_event.result_watched_wallets,
      'releasedWallets', v_existing_event.result_released_wallets,
      'journeyReleased', v_existing_event.journey_released
    );
  end if;

  select custody_journey_enabled into v_enabled
  from public.bot_config
  where user_id = p_user_id;
  if not found then
    return jsonb_build_object(
      'applied', false, 'duplicate', false, 'payloadMismatch', false,
      'reason', 'config_not_found', 'journeyId', null, 'eventId', null,
      'journeyStatus', null, 'appliedAmountTokens', 0,
      'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
      'journeyReleased', false
    );
  end if;
  if v_enabled is not true then
    return jsonb_build_object(
      'applied', false, 'duplicate', false, 'payloadMismatch', false,
      'reason', 'custody_journey_disabled', 'journeyId', null, 'eventId', null,
      'journeyStatus', null, 'appliedAmountTokens', 0,
      'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
      'journeyReleased', false
    );
  end if;

  select * into v_journey
  from public.custody_journeys
  where user_id = p_user_id and token_mint = v_mint and status = 'active'
  for update;
  if not found then
    insert into public.custody_journeys (
      user_id, token_mint, status, started_at, last_activity_at,
      source_target_wallets, first_event_key, last_event_key
    ) values (
      p_user_id, v_mint, 'active', p_event_at, p_event_at,
      array[v_target], v_event_key, v_event_key
    )
    returning * into v_journey;
  end if;

  select * into v_existing_wallet
  from public.custody_journey_wallets
  where journey_id = v_journey.id and wallet = v_target
  for update;
  v_wallet_exists := found;
  if v_wallet_exists
     and p_slot is not null
     and v_existing_wallet.last_slot is not null
     and (
       p_slot < v_existing_wallet.last_slot
       or (
         p_slot = v_existing_wallet.last_slot
         and v_tx_sig <> v_existing_wallet.last_tx_sig
       )
     ) then
    v_chronology_reason := case
      when p_slot < v_existing_wallet.last_slot then 'partial_stale_target_buy'
      else 'partial_same_slot_target_buy_order_unknown'
    end;
    insert into public.custody_journey_events (
      journey_id, user_id, event_key, event_type, request_fingerprint,
      tx_sig, slot, event_at, source_wallet, requested_amount_tokens,
      applied_amount_tokens, reconciled_amount_tokens, evidence_reliable,
      result_reason, result_journey_status, metadata
    ) values (
      v_journey.id, p_user_id, v_event_key, 'VERIFIED_TARGET_BUY', v_fingerprint,
      v_tx_sig, p_slot, p_event_at, v_target, v_amount,
      0, 0, false, v_chronology_reason, 'active',
      coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
        'chronologyGuard', v_chronology_reason,
        'coveragePartial', true
      )
    )
    returning id into v_event_id;
    return jsonb_build_object(
      'applied', false, 'duplicate', false, 'payloadMismatch', false,
      'reason', v_chronology_reason,
      'journeyId', v_journey.id, 'eventId', v_event_id,
      'journeyStatus', 'active', 'appliedAmountTokens', 0,
      'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
      'journeyReleased', false
    );
  end if;

  -- A later buy is also a confirmed balance boundary. Reconcile a gap before
  -- adding the new acquisition so missed intervening outflows cannot survive as
  -- phantom attribution.
  if v_wallet_exists
     and v_balance_reliable
     and v_existing_wallet.balance_evidence_reliable
     and v_existing_wallet.last_observed_balance_tokens is not null
     and v_existing_wallet.last_observed_balance_tokens > 0
     and v_balance_pre < v_existing_wallet.last_observed_balance_tokens then
    v_prior_share := least(
      1,
      v_existing_wallet.current_attributed_tokens
        / v_existing_wallet.last_observed_balance_tokens
    );
    v_unresolved := least(
      v_existing_wallet.current_attributed_tokens,
      (v_existing_wallet.last_observed_balance_tokens - v_balance_pre) * v_prior_share
    );
    if v_unresolved > 0 then
      update public.custody_journey_wallets set
        current_attributed_tokens = greatest(0, current_attributed_tokens - v_unresolved),
        total_unresolved_outflow_tokens = total_unresolved_outflow_tokens + v_unresolved,
        updated_at = now()
      where id = v_existing_wallet.id;
      update public.custody_journeys set
        current_attributed_tokens = greatest(0, current_attributed_tokens - v_unresolved),
        total_unresolved_outflow_tokens = total_unresolved_outflow_tokens + v_unresolved,
        updated_at = now()
      where id = v_journey.id;
      v_existing_wallet.current_attributed_tokens := greatest(
        0,
        v_existing_wallet.current_attributed_tokens - v_unresolved
      );
      v_result_reason := 'partial_unobserved_outflow';
    end if;
  end if;
  select count(*) into v_active_wallet_count
  from public.custody_journey_wallets
  where journey_id = v_journey.id and watch_status = 'active';
  v_should_watch := (
    (v_wallet_exists and v_existing_wallet.watch_status = 'active')
    or v_active_wallet_count < 250
  );

  insert into public.custody_journey_events (
    journey_id, user_id, event_key, event_type, request_fingerprint,
    tx_sig, slot, event_at, source_wallet, requested_amount_tokens,
    applied_amount_tokens, source_pre_amount_tokens, source_post_amount_tokens,
    evidence_reliable, result_reason,
    result_journey_status, metadata
  ) values (
    v_journey.id, p_user_id, v_event_key, 'VERIFIED_TARGET_BUY', v_fingerprint,
    v_tx_sig, p_slot, p_event_at, v_target, v_amount,
    v_amount, v_balance_pre, v_balance_post, v_balance_reliable,
    coalesce(v_result_reason, case when v_should_watch then null else 'wallet_limit' end),
    'active', coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
      'balanceSnapshotReliable', v_balance_reliable,
      'unresolvedPriorOutflowTokens', v_unresolved,
      'coveragePartial', v_unresolved > 0
    )
  )
  returning id into v_event_id;

  insert into public.custody_wallet_profiles as existing_profile (
    user_id, wallet, inferred_type, inferred_label, inference_confidence,
    inference_source, first_seen_at, last_seen_at
  ) values (
    p_user_id, v_target, 'target', 'configured target wallet', 1,
    'verified_target_buy', p_event_at, p_event_at
  )
  on conflict (user_id, wallet) do update set
    inferred_type = 'target',
    inferred_label = excluded.inferred_label,
    inference_confidence = 1,
    inference_source = 'verified_target_buy',
    last_seen_at = greatest(existing_profile.last_seen_at, excluded.last_seen_at),
    updated_at = now();

  insert into public.custody_journey_wallets as existing_wallet (
    journey_id, user_id, token_mint, wallet, hop_depth, parent_wallet,
    source_target_wallets, watch_status, current_attributed_tokens,
    last_observed_balance_tokens, attributed_share, balance_evidence_reliable,
    total_received_tokens, first_seen_at, last_activity_at,
    last_balance_observed_at, released_at, release_reason,
    last_event_key, last_tx_sig, watch_anchor_slot, last_slot
  ) values (
    v_journey.id, p_user_id, v_mint, v_target, 0, null,
    array[v_target], case when v_should_watch then 'active' else 'unwatchable' end,
    v_amount, v_balance_post,
    case
      when v_balance_reliable and v_balance_post > 0
      then least(1, v_amount / v_balance_post)
      else null
    end,
    v_balance_reliable, v_amount, p_event_at, p_event_at,
    case when v_balance_reliable then p_event_at else null end, null,
    case when v_should_watch then null else 'wallet_limit' end,
    v_event_key, v_tx_sig, p_slot, p_slot
  )
  on conflict (journey_id, wallet) do update set
    -- Configured roots remain depth zero; non-target custody paths keep their
    -- conservative maximum so cycles cannot reset hop depth.
    hop_depth = 0,
    source_target_wallets = array(
      select distinct source_wallet
      from unnest(existing_wallet.source_target_wallets || excluded.source_target_wallets)
        as source_wallet
      order by source_wallet
    ),
    watch_status = case
      when existing_wallet.watch_status = 'active' or excluded.watch_status = 'active'
      then 'active' else 'unwatchable'
    end,
    current_attributed_tokens =
      existing_wallet.current_attributed_tokens + excluded.current_attributed_tokens,
    last_observed_balance_tokens = case
      when excluded.balance_evidence_reliable then excluded.last_observed_balance_tokens
      else existing_wallet.last_observed_balance_tokens
    end,
    attributed_share = case
      when excluded.balance_evidence_reliable
        and excluded.last_observed_balance_tokens > 0
      then least(
        1,
        (existing_wallet.current_attributed_tokens + excluded.current_attributed_tokens)
          / excluded.last_observed_balance_tokens
      )
      else existing_wallet.attributed_share
    end,
    balance_evidence_reliable =
      existing_wallet.balance_evidence_reliable or excluded.balance_evidence_reliable,
    total_received_tokens = existing_wallet.total_received_tokens + excluded.total_received_tokens,
    last_activity_at = greatest(existing_wallet.last_activity_at, excluded.last_activity_at),
    last_balance_observed_at = case
      when excluded.balance_evidence_reliable then excluded.last_balance_observed_at
      else existing_wallet.last_balance_observed_at
    end,
    released_at = null,
    release_reason = case
      when existing_wallet.watch_status = 'active' or excluded.watch_status = 'active'
      then null else 'wallet_limit'
    end,
    last_event_key = excluded.last_event_key,
    last_tx_sig = excluded.last_tx_sig,
    watch_anchor_slot = case
      when existing_wallet.watch_anchor_slot is null then excluded.watch_anchor_slot
      when excluded.watch_anchor_slot is null then existing_wallet.watch_anchor_slot
      else least(existing_wallet.watch_anchor_slot, excluded.watch_anchor_slot)
    end,
    last_slot = excluded.last_slot,
    updated_at = now();

  update public.custody_journeys set
    last_activity_at = greatest(last_activity_at, p_event_at),
    total_verified_target_buy_tokens = total_verified_target_buy_tokens + v_amount,
    current_attributed_tokens = current_attributed_tokens + v_amount,
    source_target_wallets = array(
      select distinct source_wallet
      from unnest(source_target_wallets || array[v_target]) as source_wallet
      order by source_wallet
    ),
    last_event_key = v_event_key,
    updated_at = now()
  where id = v_journey.id;

  if v_should_watch then
    v_watched := array[v_target];
  end if;
  update public.custody_journey_events set
    result_reason = coalesce(v_result_reason, result_reason),
    result_watched_wallets = v_watched,
    result_released_wallets = '{}'
  where id = v_event_id;

  -- A target transfer/sell may reach an RPC worker before this upstream buy.
  -- Target-only observations are terminal by default to avoid inbox floods,
  -- but a later verified buy reactivates only same/later-slot evidence for this
  -- exact target and mint.
  update public.custody_pending_events set
    status = 'pending',
    next_retry_at = now(),
    last_error_code = 'pending_upstream',
    journey_id = v_journey.id,
    expires_at = now() + interval '24 hours',
    updated_at = now()
  where user_id = p_user_id
    and token_mint = v_mint
    and source_wallet = v_target
    and status = 'terminal'
    and last_error_code = 'no_verified_target_buy'
    and (p_slot is null or slot is null or slot >= p_slot);

  -- Conflicting dormant evidence remains terminal, but once this exact chain
  -- exists it must be attached so coverage reports cannot hide the quarantine.
  update public.custody_pending_events set
    journey_id = v_journey.id,
    result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
      'journeyId', v_journey.id,
      'reason', 'payload_mismatch',
      'payloadMismatch', true
    ),
    updated_at = now()
  where user_id = p_user_id
    and token_mint = v_mint
    and source_wallet = v_target
    and journey_id is null
    and status = 'terminal'
    and last_error_code = 'payload_mismatch'
    and (p_slot is null or slot is null or slot >= p_slot);

  -- Wallet-wide RPC ordering may surface a target transfer/sell before its
  -- verified buy establishes this mint campaign. Dormant unscoped evidence is
  -- health-neutral until this exact target+mint becomes attributable.
  update public.custody_pending_events set
    status = 'pending',
    next_retry_at = now(),
    last_error_code = 'pending_upstream',
    journey_id = v_journey.id,
    expires_at = now() + interval '24 hours',
    updated_at = now()
  where user_id = p_user_id
    and token_mint = v_mint
    and source_wallet = v_target
    and journey_id is null
    and (
      (status = 'pending' and last_error_code = 'unscoped')
      or status = 'expired'
    )
    and (p_slot is null or slot is null or slot >= p_slot);

  return jsonb_build_object(
    'applied', true, 'duplicate', false, 'payloadMismatch', false,
    'reason', coalesce(v_result_reason, case when v_should_watch then null else 'wallet_limit' end),
    'journeyId', v_journey.id, 'eventId', v_event_id,
    'journeyStatus', 'active', 'appliedAmountTokens', v_amount,
    'watchedWallets', v_watched, 'releasedWallets', array[]::text[],
    'journeyReleased', false
  );
end;
$$;


-- Apply one verified custody sale to the pro-rata journey share in a mixed
-- wallet. Exact sell attribution and token pre/post balances are mandatory;
-- ambiguous sales fail closed without mutating the ledger.
create or replace function public.record_verified_custody_sell(
  p_user_id uuid,
  p_token_mint text,
  p_event_key text,
  p_tx_sig text,
  p_slot bigint,
  p_event_at timestamptz,
  p_seller_wallet text,
  p_sold_amount_tokens numeric,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_enabled boolean;
  v_mint text := btrim(coalesce(p_token_mint, ''));
  v_event_key text := btrim(coalesce(p_event_key, ''));
  v_tx_sig text := btrim(coalesce(p_tx_sig, ''));
  v_seller text := btrim(coalesce(p_seller_wallet, ''));
  v_pre_text text;
  v_post_text text;
  v_decimals_text text;
  v_pre numeric;
  v_post numeric;
  v_outflow numeric;
  v_sold_amount numeric;
  v_pre_raw numeric(78, 0);
  v_post_raw numeric(78, 0);
  v_sold_raw numeric(78, 0);
  v_decimals integer;
  v_raw_scale numeric;
  v_raw_evidence_used boolean := false;
  v_tolerance numeric;
  v_fingerprint text;
  v_existing_event public.custody_journey_events%rowtype;
  v_journey public.custody_journeys%rowtype;
  v_seller_state public.custody_journey_wallets%rowtype;
  v_event_id uuid;
  v_applied numeric;
  v_remaining numeric;
  v_seller_released boolean;
  v_source_is_target boolean := false;
  v_released text[] := '{}';
  v_pending public.custody_pending_events%rowtype;
  v_pending_payload jsonb;
  v_terminal_result jsonb;
  v_terminal_reason text;
  v_prior_share numeric := 0;
  v_unresolved numeric := 0;
  v_result_reason text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_user_id is null
     or v_mint = ''
     or v_event_key = ''
     or v_tx_sig = ''
     or v_seller = ''
     or p_event_at is null
     or p_sold_amount_tokens is null
     or p_sold_amount_tokens < 0
     or (p_slot is not null and p_slot < 0)
     or jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object'
     or coalesce((p_metadata->>'verifiedSwap')::boolean, false) is not true
     or coalesce((p_metadata->>'sellAttributionVerified')::boolean, false) is not true then
    raise exception 'invalid or unverified custody sell';
  end if;
  v_raw_evidence_used :=
    p_metadata ? 'tokenBalanceBeforeRaw'
    or p_metadata ? 'tokenBalanceAfterRaw'
    or p_metadata ? 'soldAmountRaw'
    or p_metadata ? 'amountRaw';
  if v_raw_evidence_used then
    v_decimals_text := btrim(coalesce(p_metadata->>'decimals', ''));
    if btrim(coalesce(p_metadata->>'tokenBalanceBeforeRaw', '')) !~ '^[0-9]+$'
       or btrim(coalesce(p_metadata->>'tokenBalanceAfterRaw', '')) !~ '^[0-9]+$'
       or btrim(coalesce(p_metadata->>'soldAmountRaw', '')) !~ '^[0-9]+$'
       or (
         p_metadata ? 'amountRaw'
         and btrim(coalesce(p_metadata->>'amountRaw', '')) !~ '^[0-9]+$'
       )
       or v_decimals_text !~ '^[0-9]{1,3}$' then
      raise exception 'verified custody sell raw evidence is incomplete';
    end if;
    v_pre_raw := (p_metadata->>'tokenBalanceBeforeRaw')::numeric(78, 0);
    v_post_raw := (p_metadata->>'tokenBalanceAfterRaw')::numeric(78, 0);
    v_sold_raw := (p_metadata->>'soldAmountRaw')::numeric(78, 0);
    v_decimals := v_decimals_text::integer;
    if v_decimals > 255
       or v_pre_raw <= 0
       or v_sold_raw <= 0
       or v_post_raw > v_pre_raw
       or v_pre_raw - v_post_raw <> v_sold_raw
       or (
         p_metadata ? 'amountRaw'
         and (p_metadata->>'amountRaw')::numeric(78, 0) <> v_sold_raw
       ) then
      raise exception 'verified custody sell raw evidence does not reconcile';
    end if;
    v_raw_scale := power(10::numeric, v_decimals);
    v_pre := v_pre_raw / v_raw_scale;
    v_post := v_post_raw / v_raw_scale;
    v_outflow := v_sold_raw / v_raw_scale;
    v_sold_amount := v_outflow;
  else
    if p_sold_amount_tokens <= 0 then
      raise exception 'verified custody sell requires a positive UI amount';
    end if;
    v_pre_text := btrim(coalesce(p_metadata->>'tokenBalanceBefore', ''));
    v_post_text := btrim(coalesce(p_metadata->>'tokenBalanceAfter', ''));
    if v_pre_text !~ '^[+]?[0-9]+([.][0-9]+)?$'
       or v_post_text !~ '^[+]?[0-9]+([.][0-9]+)?$' then
      raise exception 'verified custody sell requires exact pre/post balances';
    end if;
    v_pre := v_pre_text::numeric;
    v_post := v_post_text::numeric;
    if v_pre <= 0 or v_post > v_pre then
      raise exception 'invalid verified custody sell balances';
    end if;
    v_outflow := v_pre - v_post;
    v_tolerance := greatest(
      0.000000001,
      greatest(v_outflow, p_sold_amount_tokens) * 0.000000001
    );
    if abs(v_outflow - p_sold_amount_tokens) > v_tolerance then
      raise exception 'verified custody sell payload does not reconcile to balances';
    end if;
    v_sold_amount := p_sold_amount_tokens;
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(v_mint));
  v_fingerprint := md5(jsonb_build_object(
    'eventType', 'VERIFIED_CUSTODY_SELL',
    'sellerWallet', v_seller,
    'tokenMint', v_mint,
    'txSig', v_tx_sig,
    'slot', p_slot,
    'rawEvidenceUsed', v_raw_evidence_used,
    'soldAmountRaw', case when v_raw_evidence_used then v_sold_raw else null end,
    'tokenBalanceBeforeRaw', case when v_raw_evidence_used then v_pre_raw else null end,
    'tokenBalanceAfterRaw', case when v_raw_evidence_used then v_post_raw else null end,
    'decimals', case when v_raw_evidence_used then v_decimals else null end,
    'soldAmountTokens', case when v_raw_evidence_used then null else v_sold_amount end,
    'tokenBalanceBefore', case when v_raw_evidence_used then null else v_pre end,
    'tokenBalanceAfter', case when v_raw_evidence_used then null else v_post end
  )::text);

  select * into v_existing_event
  from public.custody_journey_events
  where user_id = p_user_id and event_key = v_event_key;
  if found then
    if v_existing_event.request_fingerprint = v_fingerprint then
      update public.custody_journey_events set
        metadata = metadata || coalesce(p_metadata, '{}'::jsonb)
      where id = v_existing_event.id;
    else
      update public.custody_journey_events set
        result_reason = 'payload_mismatch',
        metadata = metadata || jsonb_build_object(
          'payloadConflictObserved', true,
          'payloadConflictObservedAt', now()
        )
      where id = v_existing_event.id;
    end if;
    return jsonb_build_object(
      'applied', false,
      'duplicate', true,
      'payloadMismatch', v_existing_event.request_fingerprint <> v_fingerprint,
      'reason', case
        when v_existing_event.request_fingerprint <> v_fingerprint then 'payload_mismatch'
        else v_existing_event.result_reason
      end,
      'journeyId', v_existing_event.journey_id,
      'eventId', v_existing_event.id,
      'journeyStatus', v_existing_event.result_journey_status,
      'appliedAmountTokens', v_existing_event.applied_amount_tokens,
      'watchedWallets', v_existing_event.result_watched_wallets,
      'releasedWallets', v_existing_event.result_released_wallets,
      'journeyReleased', v_existing_event.journey_released
    );
  end if;

  -- A conflicting duplicate is a durable quarantine, not a replay candidate.
  -- Check it before any journey/wallet mutation so a later direct delivery
  -- cannot bypass a conflict first observed while the event was staged.
  select * into v_pending
  from public.custody_pending_events
  where user_id = p_user_id and event_key = v_event_key
  for update;
  if found and (
    v_pending.request_fingerprint <> v_fingerprint
    or (
      v_pending.status = 'terminal'
      and v_pending.last_error_code = 'payload_mismatch'
    )
  ) then
    update public.custody_pending_events set
      status = 'terminal', last_retry_at = now(), next_retry_at = now(),
      last_error_code = 'payload_mismatch',
      journey_id = coalesce(
        journey_id,
        (
          select active_journey.id
          from public.custody_journeys active_journey
          where active_journey.user_id = p_user_id
            and active_journey.token_mint = v_mint
            and active_journey.status = 'active'
          limit 1
        )
      ),
      result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
        'reason', 'payload_mismatch', 'payloadMismatch', true
      ),
      updated_at = now()
    where id = v_pending.id
    returning * into v_pending;
    return jsonb_build_object(
      'applied', false, 'duplicate', true, 'payloadMismatch', true,
      'reason', 'payload_mismatch', 'journeyId', v_pending.journey_id,
      'eventId', v_pending.event_id, 'journeyStatus', null,
      'appliedAmountTokens', 0, 'watchedWallets', array[]::text[],
      'releasedWallets', array[]::text[], 'journeyReleased', false
    );
  end if;

  select custody_journey_enabled into v_enabled
  from public.bot_config
  where user_id = p_user_id;
  if not found then
    return jsonb_build_object(
      'applied', false, 'duplicate', false, 'payloadMismatch', false,
      'reason', 'config_not_found', 'journeyId', null, 'eventId', null,
      'journeyStatus', null, 'appliedAmountTokens', 0,
      'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
      'journeyReleased', false
    );
  end if;
  if v_enabled is not true then
    return jsonb_build_object(
      'applied', false, 'duplicate', false, 'payloadMismatch', false,
      'reason', 'custody_journey_disabled', 'journeyId', null, 'eventId', null,
      'journeyStatus', null, 'appliedAmountTokens', 0,
      'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
      'journeyReleased', false
    );
  end if;

  select * into v_journey
  from public.custody_journeys
  where user_id = p_user_id and token_mint = v_mint and status = 'active'
  for update;
  if not found then
    select exists (
      select 1 from public.bot_config
      where user_id = p_user_id
        and (
          target_wallet = v_seller
          or v_seller = any(coalesce(additional_target_wallets, '{}'))
        )
    ) into v_source_is_target;
    v_pending_payload := jsonb_build_object(
      'p_user_id', p_user_id,
      'p_token_mint', v_mint,
      'p_event_key', v_event_key,
      'p_tx_sig', v_tx_sig,
      'p_slot', p_slot,
      'p_event_at', p_event_at,
      'p_seller_wallet', v_seller,
      'p_sold_amount_tokens', v_sold_amount,
      'p_metadata', coalesce(p_metadata, '{}'::jsonb)
    );
    insert into public.custody_pending_events as existing_pending (
      user_id, event_key, event_type, request_fingerprint, token_mint,
      tx_sig, slot, event_at, source_wallet, requested_amount_tokens,
      payload, status, last_error_code, next_retry_at, expires_at
    ) values (
      p_user_id, v_event_key, 'VERIFIED_CUSTODY_SELL', v_fingerprint, v_mint,
      v_tx_sig, p_slot, p_event_at, v_seller, v_sold_amount,
      v_pending_payload, 'pending', 'unscoped',
      'infinity'::timestamptz, 'infinity'::timestamptz
    )
    on conflict (user_id, event_key) do update set
      updated_at = now()
    returning * into v_pending;
    if v_pending.request_fingerprint <> v_fingerprint then
      update public.custody_pending_events set
        status = 'terminal',
        last_retry_at = now(),
        next_retry_at = now(),
        last_error_code = 'payload_mismatch',
        journey_id = coalesce(journey_id, v_journey.id),
        result = jsonb_build_object(
          'applied', false, 'duplicate', true, 'payloadMismatch', true,
          'reason', 'payload_mismatch',
          'journeyId', coalesce(journey_id, v_journey.id), 'eventId', event_id,
          'journeyStatus', null, 'appliedAmountTokens', 0,
          'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
          'journeyReleased', false
        ),
        updated_at = now()
      where id = v_pending.id;
      return jsonb_build_object(
        'applied', false, 'duplicate', true, 'payloadMismatch', true,
        'reason', 'payload_mismatch', 'journeyId', null, 'eventId', null,
        'journeyStatus', null, 'appliedAmountTokens', 0,
        'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
        'journeyReleased', false
      );
    end if;
    return jsonb_build_object(
      'applied', false, 'duplicate', false, 'payloadMismatch', false,
      'reason', 'staged_unscoped',
      'journeyId', null, 'eventId', null,
      'journeyStatus', null, 'appliedAmountTokens', 0,
      'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
      'journeyReleased', false
    );
  end if;

  select * into v_seller_state
  from public.custody_journey_wallets
  where journey_id = v_journey.id and wallet = v_seller
  for update;
  if not found or v_seller_state.current_attributed_tokens <= 0 then
    v_pending_payload := jsonb_build_object(
      'p_user_id', p_user_id,
      'p_token_mint', v_mint,
      'p_event_key', v_event_key,
      'p_tx_sig', v_tx_sig,
      'p_slot', p_slot,
      'p_event_at', p_event_at,
      'p_seller_wallet', v_seller,
      'p_sold_amount_tokens', v_sold_amount,
      'p_metadata', coalesce(p_metadata, '{}'::jsonb)
    );
    insert into public.custody_pending_events as existing_pending (
      user_id, event_key, event_type, request_fingerprint, token_mint,
      tx_sig, slot, event_at, source_wallet, requested_amount_tokens,
      payload, status, last_error_code, journey_id
    ) values (
      p_user_id, v_event_key, 'VERIFIED_CUSTODY_SELL', v_fingerprint, v_mint,
      v_tx_sig, p_slot, p_event_at, v_seller, v_sold_amount,
      v_pending_payload, 'pending', 'seller_not_attributed', v_journey.id
    )
    on conflict (user_id, event_key) do update set
      status = case
        when existing_pending.request_fingerprint = excluded.request_fingerprint
          and existing_pending.status = 'pending'
          and excluded.status = 'terminal'
        then 'terminal' else existing_pending.status
      end,
      last_error_code = case
        when existing_pending.request_fingerprint = excluded.request_fingerprint
          and existing_pending.status = 'pending'
          and excluded.status = 'terminal'
        then excluded.last_error_code else existing_pending.last_error_code
      end,
      updated_at = now()
    returning * into v_pending;
    if v_pending.request_fingerprint <> v_fingerprint then
      update public.custody_pending_events set
        status = 'terminal',
        last_retry_at = now(),
        next_retry_at = now(),
        last_error_code = 'payload_mismatch',
        journey_id = coalesce(journey_id, v_journey.id),
        result = jsonb_build_object(
          'applied', false, 'duplicate', true, 'payloadMismatch', true,
          'reason', 'payload_mismatch',
          'journeyId', coalesce(journey_id, v_journey.id), 'eventId', event_id,
          'journeyStatus', 'active', 'appliedAmountTokens', 0,
          'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
          'journeyReleased', false
        ),
        updated_at = now()
      where id = v_pending.id;
      return jsonb_build_object(
        'applied', false, 'duplicate', true, 'payloadMismatch', true,
        'reason', 'payload_mismatch', 'journeyId', v_journey.id, 'eventId', null,
        'journeyStatus', 'active', 'appliedAmountTokens', 0,
        'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
        'journeyReleased', false
      );
    end if;
    return jsonb_build_object(
      'applied', false, 'duplicate', false, 'payloadMismatch', false,
      'reason', 'pending_upstream', 'journeyId', v_journey.id, 'eventId', null,
      'journeyStatus', 'active', 'appliedAmountTokens', 0,
      'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
      'journeyReleased', false
    );
  end if;

  -- A recovery cursor can surface an older observation after this wallet's
  -- attributed cohort has already advanced. Never apply that stale event to
  -- the newer state; retain a terminal audit row so cursor progress is safe.
  if p_slot is not null
     and v_seller_state.last_slot is not null
     and (
       p_slot < v_seller_state.last_slot
       or (
         p_slot = v_seller_state.last_slot
         and v_tx_sig <> v_seller_state.last_tx_sig
       )
     ) then
    v_terminal_reason := case
      when p_slot < v_seller_state.last_slot then 'predates_attribution_state'
      else 'same_slot_order_unknown'
    end;
    v_pending_payload := jsonb_build_object(
      'p_user_id', p_user_id,
      'p_token_mint', v_mint,
      'p_event_key', v_event_key,
      'p_tx_sig', v_tx_sig,
      'p_slot', p_slot,
      'p_event_at', p_event_at,
      'p_seller_wallet', v_seller,
      'p_sold_amount_tokens', v_sold_amount,
      'p_metadata', coalesce(p_metadata, '{}'::jsonb)
    );
    v_terminal_result := jsonb_build_object(
      'applied', false, 'duplicate', false, 'payloadMismatch', false,
      'reason', v_terminal_reason,
      'journeyId', v_journey.id, 'eventId', null,
      'journeyStatus', 'active', 'appliedAmountTokens', 0,
      'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
      'journeyReleased', false
    );
    insert into public.custody_pending_events as existing_pending (
      user_id, event_key, event_type, request_fingerprint, token_mint,
      tx_sig, slot, event_at, source_wallet, requested_amount_tokens,
      payload, status, last_error_code, journey_id, result
    ) values (
      p_user_id, v_event_key, 'VERIFIED_CUSTODY_SELL', v_fingerprint, v_mint,
      v_tx_sig, p_slot, p_event_at, v_seller, v_sold_amount,
      v_pending_payload, 'terminal', v_terminal_reason,
      v_journey.id, v_terminal_result
    )
    on conflict (user_id, event_key) do update set
      status = case
        when existing_pending.request_fingerprint = excluded.request_fingerprint
        then 'terminal' else existing_pending.status
      end,
      last_error_code = case
        when existing_pending.request_fingerprint = excluded.request_fingerprint
        then excluded.last_error_code else existing_pending.last_error_code
      end,
      journey_id = case
        when existing_pending.request_fingerprint = excluded.request_fingerprint
        then excluded.journey_id else existing_pending.journey_id
      end,
      result = case
        when existing_pending.request_fingerprint = excluded.request_fingerprint
        then excluded.result else existing_pending.result
      end,
      updated_at = now()
    returning * into v_pending;
    if v_pending.request_fingerprint <> v_fingerprint then
      update public.custody_pending_events set
        status = 'terminal',
        last_retry_at = now(),
        next_retry_at = now(),
        last_error_code = 'payload_mismatch',
        journey_id = coalesce(journey_id, v_journey.id),
        result = jsonb_build_object(
          'applied', false, 'duplicate', true, 'payloadMismatch', true,
          'reason', 'payload_mismatch',
          'journeyId', coalesce(journey_id, v_journey.id), 'eventId', event_id,
          'journeyStatus', 'active', 'appliedAmountTokens', 0,
          'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
          'journeyReleased', false
        ),
        updated_at = now()
      where id = v_pending.id;
      return jsonb_build_object(
        'applied', false, 'duplicate', true, 'payloadMismatch', true,
        'reason', 'payload_mismatch', 'journeyId', v_journey.id, 'eventId', null,
        'journeyStatus', 'active', 'appliedAmountTokens', 0,
        'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
        'journeyReleased', false
      );
    end if;
    return v_terminal_result;
  end if;

  -- Balance continuity is independent of decoder coverage. If the prior
  -- confirmed post-balance is larger than this event's confirmed pre-balance,
  -- some token left the wallet between observations. Remove only the journey's
  -- pro-rata share of that missing balance and preserve it as unresolved—not as
  -- a sale. This prevents a later valid sell from leaving phantom attribution.
  if v_seller_state.balance_evidence_reliable
     and v_seller_state.last_observed_balance_tokens is not null
     and v_seller_state.last_observed_balance_tokens > 0
     and v_pre < v_seller_state.last_observed_balance_tokens then
    v_prior_share := least(
      1,
      v_seller_state.current_attributed_tokens
        / v_seller_state.last_observed_balance_tokens
    );
    v_unresolved := least(
      v_seller_state.current_attributed_tokens,
      (v_seller_state.last_observed_balance_tokens - v_pre) * v_prior_share
    );
    if v_unresolved > 0 then
      update public.custody_journey_wallets set
        current_attributed_tokens = greatest(0, current_attributed_tokens - v_unresolved),
        total_unresolved_outflow_tokens = total_unresolved_outflow_tokens + v_unresolved,
        updated_at = now()
      where id = v_seller_state.id;
      update public.custody_journeys set
        current_attributed_tokens = greatest(0, current_attributed_tokens - v_unresolved),
        total_unresolved_outflow_tokens = total_unresolved_outflow_tokens + v_unresolved,
        updated_at = now()
      where id = v_journey.id;
      v_seller_state.current_attributed_tokens := greatest(
        0,
        v_seller_state.current_attributed_tokens - v_unresolved
      );
      v_result_reason := 'partial_unobserved_outflow';
    end if;
  end if;

  v_applied := least(
    v_seller_state.current_attributed_tokens,
    v_sold_amount * least(1, v_seller_state.current_attributed_tokens / v_pre)
  );
  if v_applied <= 0 and v_unresolved <= 0 then
    return jsonb_build_object(
      'applied', false, 'duplicate', false, 'payloadMismatch', false,
      'reason', 'no_attributed_balance', 'journeyId', v_journey.id, 'eventId', null,
      'journeyStatus', 'active', 'appliedAmountTokens', 0,
      'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
      'journeyReleased', false
    );
  end if;
  v_seller_released := v_seller_state.current_attributed_tokens - v_applied <= 0;

  insert into public.custody_journey_events (
    journey_id, user_id, event_key, event_type, request_fingerprint,
    tx_sig, slot, event_at, source_wallet, requested_amount_tokens,
    applied_amount_tokens, reconciled_amount_tokens,
    source_pre_amount_tokens, source_post_amount_tokens, evidence_reliable,
    result_reason, result_journey_status, metadata
  ) values (
    v_journey.id, p_user_id, v_event_key, 'VERIFIED_CUSTODY_SELL', v_fingerprint,
    v_tx_sig, p_slot, p_event_at, v_seller, v_sold_amount,
    v_applied, v_outflow, v_pre, v_post, true, v_result_reason, 'active',
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
      'rawEvidenceUsed', v_raw_evidence_used,
      'unresolvedPriorOutflowTokens', v_unresolved,
      'coveragePartial', v_unresolved > 0
    )
  )
  returning id into v_event_id;

  update public.custody_journey_wallets set
    current_attributed_tokens = greatest(0, current_attributed_tokens - v_applied),
    last_observed_balance_tokens = v_post,
    attributed_share = case
      when v_post > 0 then least(
        1,
        greatest(0, v_seller_state.current_attributed_tokens - v_applied) / v_post
      ) else 0
    end,
    balance_evidence_reliable = true,
    total_verified_sold_tokens = total_verified_sold_tokens + v_applied,
    watch_status = case when v_seller_released then 'released' else watch_status end,
    released_at = case when v_seller_released then p_event_at else released_at end,
    release_reason = case
      when v_seller_released then 'verified_custody_sell'
      else release_reason
    end,
    last_activity_at = greatest(last_activity_at, p_event_at),
    last_balance_observed_at = p_event_at,
    last_event_key = v_event_key,
    last_tx_sig = v_tx_sig,
    last_slot = p_slot,
    updated_at = now()
  where id = v_seller_state.id;
  if v_seller_released and v_seller_state.watch_status = 'active' then
    v_released := array[v_seller];
  end if;

  update public.custody_wallet_profiles set
    last_seen_at = greatest(last_seen_at, p_event_at),
    updated_at = now()
  where user_id = p_user_id and wallet = v_seller;
  update public.custody_journeys set
    last_activity_at = greatest(last_activity_at, p_event_at),
    total_verified_custody_sell_tokens = total_verified_custody_sell_tokens + v_applied,
    current_attributed_tokens = greatest(0, current_attributed_tokens - v_applied),
    last_event_key = v_event_key,
    updated_at = now()
  where id = v_journey.id
  returning current_attributed_tokens into v_remaining;

  if v_remaining <= 0 then
    select array_cat(
      v_released,
      coalesce(array_agg(wallet order by wallet), '{}')
    ) into v_released
    from public.custody_journey_wallets
    where journey_id = v_journey.id and watch_status = 'active';
    update public.custody_journey_wallets set
      watch_status = 'released',
      released_at = coalesce(released_at, p_event_at),
      release_reason = coalesce(release_reason, 'journey_flat'),
      updated_at = now()
    where journey_id = v_journey.id and watch_status <> 'released';
    update public.custody_journeys set
      status = 'flat',
      flat_at = p_event_at,
      flat_reason = case
        when v_unresolved > 0 then 'custody_coverage_lost'
        else 'all_attributed_tokens_sold'
      end,
      updated_at = now()
    where id = v_journey.id;
  end if;

  select coalesce(array_agg(wallet order by wallet), '{}') into v_released
  from (select distinct unnest(v_released) as wallet) as unique_released;
  update public.custody_journey_events set
    result_journey_status = case when v_remaining <= 0 then 'flat' else 'active' end,
    result_watched_wallets = '{}',
    result_released_wallets = v_released,
    journey_released = v_remaining <= 0
  where id = v_event_id;

  update public.custody_pending_events set
    status = 'applied',
    last_retry_at = now(),
    last_error_code = null,
    journey_id = v_journey.id,
    event_id = v_event_id,
    result = jsonb_build_object(
      'applied', true, 'duplicate', false, 'payloadMismatch', false,
      'reason', v_result_reason, 'journeyId', v_journey.id, 'eventId', v_event_id,
      'journeyStatus', case when v_remaining <= 0 then 'flat' else 'active' end,
      'appliedAmountTokens', v_applied,
      'watchedWallets', array[]::text[], 'releasedWallets', v_released,
      'journeyReleased', v_remaining <= 0
    ),
    updated_at = now()
  where user_id = p_user_id and event_key = v_event_key
    and status = 'pending';

  return jsonb_build_object(
    'applied', true, 'duplicate', false, 'payloadMismatch', false,
    'reason', v_result_reason, 'journeyId', v_journey.id, 'eventId', v_event_id,
    'journeyStatus', case when v_remaining <= 0 then 'flat' else 'active' end,
    'appliedAmountTokens', v_applied,
    'watchedWallets', array[]::text[], 'releasedWallets', v_released,
    'journeyReleased', v_remaining <= 0
  );
end;
$$;

-- Move one attributable cohort across a split transfer. Source attribution is
-- scaled pro rata against the source wallet's exact pre-balance, so unrelated
-- tokens in a mixed wallet cannot be promoted into the journey. Every
-- recipient is persisted, including observation boundaries.
create or replace function public.record_custody_transfer(
  p_user_id uuid,
  p_token_mint text,
  p_event_key text,
  p_tx_sig text,
  p_slot bigint,
  p_event_at timestamptz,
  p_source_wallet text,
  p_recipients jsonb,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_enabled boolean;
  v_mint text := btrim(coalesce(p_token_mint, ''));
  v_event_key text := btrim(coalesce(p_event_key, ''));
  v_tx_sig text := btrim(coalesce(p_tx_sig, ''));
  v_source_wallet text := btrim(coalesce(p_source_wallet, ''));
  v_item jsonb;
  v_wallet text;
  v_amount_text text;
  v_pre_text text;
  v_post_text text;
  v_confidence_text text;
  v_inferred_type text;
  v_normalized jsonb;
  v_result_recipients jsonb := '[]'::jsonb;
  v_fingerprint text;
  v_existing_event public.custody_journey_events%rowtype;
  v_journey public.custody_journeys%rowtype;
  v_source public.custody_journey_wallets%rowtype;
  v_destination public.custody_journey_wallets%rowtype;
  v_pending public.custody_pending_events%rowtype;
  v_pending_payload jsonb;
  v_terminal_result jsonb;
  v_terminal_reason text;
  v_event_id uuid;
  v_requested_total numeric := 0;
  v_applied_total numeric := 0;
  v_remaining numeric := 0;
  v_scale numeric := 0;
  v_requested numeric;
  v_applied numeric;
  v_source_pre numeric;
  v_source_post numeric;
  v_source_outflow numeric;
  v_same_tx_buy_amount numeric := 0;
  v_same_tx_buy_raw numeric(78, 0) := 0;
  v_same_tx_buy_count integer := 0;
  v_same_tx_buy_raw_count integer := 0;
  v_same_tx_requested boolean := false;
  v_same_tx_verified_acquisition boolean := false;
  v_source_pre_raw numeric(78, 0);
  v_source_post_raw numeric(78, 0);
  v_source_outflow_raw numeric(78, 0);
  v_decimals_text text;
  v_decimals integer;
  v_raw_scale numeric;
  v_requested_raw_total numeric(78, 0);
  v_recipient_amount_raw numeric(78, 0);
  v_recipient_pre_raw numeric(78, 0);
  v_recipient_post_raw numeric(78, 0);
  v_raw_evidence_used boolean := false;
  v_chain_source_pre numeric;
  v_chain_source_post numeric;
  v_chain_source_pre_raw numeric(78, 0);
  v_chain_source_post_raw numeric(78, 0);
  v_tolerance numeric;
  v_recipient_pre numeric;
  v_recipient_post numeric;
  v_next_hop integer;
  v_input_watchable boolean;
  v_should_watch boolean;
  v_destination_exists boolean;
  v_destination_active boolean;
  v_source_will_release boolean;
  v_synthetic_target_delivery boolean := false;
  v_source_is_target boolean := false;
  v_boundary_reason text;
  v_destination_chronology_reason text;
  v_destination_chronology_wallet text;
  v_active_wallet_count integer := 0;
  v_destination_wallet text;
  v_watched text[] := '{}';
  v_released text[] := '{}';
  v_prior_share numeric := 0;
  v_unresolved numeric := 0;
  v_destination_unresolved numeric := 0;
  v_destination_unresolved_total numeric := 0;
  v_effective_hop integer;
  v_result_reason text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_user_id is null
     or v_mint = ''
     or v_event_key = ''
     or v_tx_sig = ''
     or v_source_wallet = ''
     or p_event_at is null
     or (p_slot is not null and p_slot < 0)
     or jsonb_typeof(p_recipients) <> 'array'
     or jsonb_array_length(p_recipients) = 0
     or jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object' then
    raise exception 'invalid custody transfer';
  end if;

  if p_metadata ? 'sameTransactionAcquisition'
     and jsonb_typeof(p_metadata->'sameTransactionAcquisition') <> 'boolean' then
    raise exception 'invalid same-transaction acquisition marker';
  end if;
  v_same_tx_requested := coalesce(
    (p_metadata->>'sameTransactionAcquisition')::boolean,
    false
  );

  v_pre_text := btrim(coalesce(p_metadata->>'senderPreAmount', ''));
  v_post_text := btrim(coalesce(p_metadata->>'senderPostAmount', ''));
  if v_pre_text !~ '^[+]?[0-9]+([.][0-9]+)?$'
     or v_post_text !~ '^[+]?[0-9]+([.][0-9]+)?$' then
    raise exception 'custody transfer requires exact sender pre/post balances';
  end if;
  v_source_pre := v_pre_text::numeric;
  v_source_post := v_post_text::numeric;
  if v_source_post > v_source_pre then
    raise exception 'custody transfer sender balance increased';
  end if;
  if nullif(btrim(p_metadata->>'senderPreRaw'), '') is not null
     or nullif(btrim(p_metadata->>'senderPostRaw'), '') is not null then
    if btrim(coalesce(p_metadata->>'senderPreRaw', '')) !~ '^[0-9]+$'
       or btrim(coalesce(p_metadata->>'senderPostRaw', '')) !~ '^[0-9]+$' then
      raise exception 'invalid custody transfer sender raw balance';
    end if;
    v_source_pre_raw := (p_metadata->>'senderPreRaw')::numeric(78, 0);
    v_source_post_raw := (p_metadata->>'senderPostRaw')::numeric(78, 0);
    v_decimals_text := btrim(coalesce(p_metadata->>'decimals', ''));
    if v_decimals_text !~ '^[0-9]{1,3}$' or v_decimals_text::integer > 255 then
      raise exception 'custody transfer raw evidence requires valid decimals';
    end if;
    v_decimals := v_decimals_text::integer;
    v_raw_scale := power(10::numeric, v_decimals);
    if v_source_post_raw > v_source_pre_raw then
      raise exception 'custody transfer sender raw balance increased';
    end if;
    -- Raw integer balances are authoritative. Never let independently rounded
    -- UI values inflate or shrink custody attribution.
    v_source_pre := v_source_pre_raw / v_raw_scale;
    v_source_post := v_source_post_raw / v_raw_scale;
    v_raw_evidence_used := true;
  end if;
  if v_same_tx_requested then
    v_pre_text := btrim(coalesce(p_metadata->>'chainSenderPreAmount', ''));
    v_post_text := btrim(coalesce(p_metadata->>'chainSenderPostAmount', ''));
    if v_pre_text !~ '^[+]?[0-9]+([.][0-9]+)?$'
       or v_post_text !~ '^[+]?[0-9]+([.][0-9]+)?$' then
      raise exception 'same-transaction acquisition requires chain pre/post balances';
    end if;
    v_chain_source_pre := v_pre_text::numeric;
    v_chain_source_post := v_post_text::numeric;
    if v_chain_source_post < v_chain_source_pre then
      raise exception 'same-transaction acquisition chain balance decreased';
    end if;
    if v_raw_evidence_used
       or nullif(btrim(p_metadata->>'chainSenderPreRaw'), '') is not null
       or nullif(btrim(p_metadata->>'chainSenderPostRaw'), '') is not null then
      if not v_raw_evidence_used
         or btrim(coalesce(p_metadata->>'chainSenderPreRaw', '')) !~ '^[0-9]+$'
         or btrim(coalesce(p_metadata->>'chainSenderPostRaw', '')) !~ '^[0-9]+$' then
        raise exception 'same-transaction acquisition raw evidence is incomplete';
      end if;
      v_chain_source_pre_raw :=
        (p_metadata->>'chainSenderPreRaw')::numeric(78, 0);
      v_chain_source_post_raw :=
        (p_metadata->>'chainSenderPostRaw')::numeric(78, 0);
      if v_chain_source_post_raw < v_chain_source_pre_raw then
        raise exception 'same-transaction acquisition chain raw balance decreased';
      end if;
      v_chain_source_pre := v_chain_source_pre_raw / v_raw_scale;
      v_chain_source_post := v_chain_source_post_raw / v_raw_scale;
    end if;
  end if;

  for v_item in select value from jsonb_array_elements(p_recipients)
  loop
    v_wallet := btrim(coalesce(v_item->>'wallet', ''));
    v_amount_text := btrim(coalesce(v_item->>'amountTokens', ''));
    v_pre_text := btrim(coalesce(v_item->>'recipientPreAmount', ''));
    v_post_text := btrim(coalesce(v_item->>'recipientPostAmount', ''));
    v_confidence_text := btrim(coalesce(v_item->>'inferenceConfidence', '0'));
    v_inferred_type := coalesce(nullif(btrim(v_item->>'inferredType'), ''), 'unknown');
    if jsonb_typeof(v_item) <> 'object'
       or v_wallet = ''
       or v_wallet = v_source_wallet
       or v_amount_text !~ '^[+]?[0-9]+([.][0-9]+)?$'
       or (not v_raw_evidence_used and v_amount_text::numeric <= 0)
       or v_pre_text !~ '^[+]?[0-9]+([.][0-9]+)?$'
       or v_post_text !~ '^[+]?[0-9]+([.][0-9]+)?$'
       or (
         not v_raw_evidence_used
         and v_post_text::numeric < v_pre_text::numeric
       )
       or (
         v_item->>'amountRaw' is not null
         and btrim(v_item->>'amountRaw') !~ '^[0-9]+$'
       )
       or (
         v_item->>'recipientPreRaw' is not null
         and btrim(v_item->>'recipientPreRaw') !~ '^[0-9]+$'
       )
       or (
         v_item->>'recipientPostRaw' is not null
         and btrim(v_item->>'recipientPostRaw') !~ '^[0-9]+$'
       )
       or not (v_item ? 'watchable')
       or jsonb_typeof(v_item->'watchable') <> 'boolean'
       or v_confidence_text !~ '^[+]?[0-9]+([.][0-9]+)?$'
       or v_confidence_text::numeric < 0
       or v_confidence_text::numeric > 1
       or v_inferred_type not in (
         'unknown', 'target', 'custody', 'exchange', 'dex_pool', 'router', 'bridge',
         'vault', 'escrow', 'program', 'burn', 'other', 'cold_storage_candidate',
         'hot_wallet_candidate', 'exchange_candidate', 'routing_wallet'
       ) then
      raise exception 'invalid custody transfer recipient';
    end if;
  end loop;

  if (
    select count(*) <> count(distinct btrim(value->>'wallet'))
    from jsonb_array_elements(p_recipients)
  ) then
    raise exception 'duplicate custody transfer recipient';
  end if;
  if not v_raw_evidence_used and exists (
    select 1 from jsonb_array_elements(p_recipients)
    where value->>'amountRaw' is not null
       or value->>'recipientPreRaw' is not null
       or value->>'recipientPostRaw' is not null
  ) then
    raise exception 'custody transfer raw evidence is incomplete';
  end if;
  if v_raw_evidence_used and exists (
    select 1 from jsonb_array_elements(p_recipients)
    where value->>'amountRaw' is null
      or value->>'recipientPreRaw' is null
      or value->>'recipientPostRaw' is null
  ) then
    raise exception 'custody transfer raw evidence is incomplete';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'wallet', btrim(value->>'wallet'),
    'requestedAmountTokens', case
      when v_raw_evidence_used then (value->>'amountRaw')::numeric(78, 0) / v_raw_scale
      else (value->>'amountTokens')::numeric
    end,
    'amountRaw', value->'amountRaw',
    'recipientPreRaw', value->'recipientPreRaw',
    'recipientPostRaw', value->'recipientPostRaw',
    'recipientPreAmount', case
      when v_raw_evidence_used then (value->>'recipientPreRaw')::numeric(78, 0) / v_raw_scale
      else (value->>'recipientPreAmount')::numeric
    end,
    'recipientPostAmount', case
      when v_raw_evidence_used then (value->>'recipientPostRaw')::numeric(78, 0) / v_raw_scale
      else (value->>'recipientPostAmount')::numeric
    end,
    'watchable', (value->>'watchable')::boolean,
    'inferredType', coalesce(nullif(btrim(value->>'inferredType'), ''), 'unknown'),
    'inferredLabel', nullif(left(btrim(value->>'inferredLabel'), 160), ''),
    'inferenceConfidence', coalesce(nullif(btrim(value->>'inferenceConfidence'), '')::numeric, 0),
    'inferenceSource', coalesce(nullif(left(btrim(value->>'inferenceSource'), 120), ''), 'runtime'),
    'evidence', nullif(left(btrim(value->>'evidence'), 500), '')
  ) order by btrim(value->>'wallet')), '[]'::jsonb)
  into v_normalized
  from jsonb_array_elements(p_recipients);

  select coalesce(sum((value->>'requestedAmountTokens')::numeric), 0)
  into v_requested_total
  from jsonb_array_elements(v_normalized);
  if v_requested_total <= 0 then
    raise exception 'invalid custody transfer total';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(v_mint));
  -- Classification and delivery metadata are snapshots, not replay identity.
  v_fingerprint := md5(jsonb_build_object(
    'eventType', 'CUSTODY_TRANSFER',
    'sourceWallet', v_source_wallet,
    'tokenMint', v_mint,
    'txSig', v_tx_sig,
    'slot', p_slot,
    'sourcePreAmount', v_source_pre,
    'sourcePostAmount', v_source_post,
    'recipients', (
      select jsonb_agg(jsonb_build_object(
        'wallet', value->>'wallet',
        'requestedAmountTokens', (value->>'requestedAmountTokens')::numeric,
        'amountRaw', value->'amountRaw',
        'recipientPreRaw', value->'recipientPreRaw',
        'recipientPostRaw', value->'recipientPostRaw',
        'recipientPreAmount', (value->>'recipientPreAmount')::numeric,
        'recipientPostAmount', (value->>'recipientPostAmount')::numeric
      ) order by value->>'wallet')
      from jsonb_array_elements(v_normalized)
    )
  )::text);

  -- Check staged identity before any journey/wallet mutation. Placing this
  -- before the active-journey SELECT also keeps PL/pgSQL FOUND scoped to the
  -- journey lookup used by the no-journey branch below.
  select * into v_pending
  from public.custody_pending_events
  where user_id = p_user_id and event_key = v_event_key
  for update;
  if found and (
    v_pending.request_fingerprint <> v_fingerprint
    or (
      v_pending.status = 'terminal'
      and v_pending.last_error_code = 'payload_mismatch'
    )
  ) then
    update public.custody_pending_events set
      status = 'terminal', last_retry_at = now(), next_retry_at = now(),
      last_error_code = 'payload_mismatch',
      journey_id = coalesce(
        journey_id,
        (
          select active_journey.id
          from public.custody_journeys active_journey
          where active_journey.user_id = p_user_id
            and active_journey.token_mint = v_mint
            and active_journey.status = 'active'
          limit 1
        )
      ),
      result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
        'reason', 'payload_mismatch', 'payloadMismatch', true
      ),
      updated_at = now()
    where id = v_pending.id
    returning * into v_pending;
    return jsonb_build_object(
      'applied', false, 'duplicate', true, 'payloadMismatch', true,
      'reason', 'payload_mismatch', 'journeyId', v_pending.journey_id,
      'eventId', v_pending.event_id, 'journeyStatus', null,
      'appliedAmountTokens', 0, 'watchedWallets', array[]::text[],
      'releasedWallets', array[]::text[], 'journeyReleased', false
    );
  end if;

  select * into v_existing_event
  from public.custody_journey_events
  where user_id = p_user_id and event_key = v_event_key;
  if found then
    if v_existing_event.request_fingerprint = v_fingerprint then
      update public.custody_journey_events set
        metadata = metadata || coalesce(p_metadata, '{}'::jsonb)
      where id = v_existing_event.id;
    else
      update public.custody_journey_events set
        result_reason = 'payload_mismatch',
        metadata = metadata || jsonb_build_object(
          'payloadConflictObserved', true,
          'payloadConflictObservedAt', now()
        )
      where id = v_existing_event.id;
    end if;
    return jsonb_build_object(
      'applied', false,
      'duplicate', true,
      'payloadMismatch', v_existing_event.request_fingerprint <> v_fingerprint,
      'reason', case
        when v_existing_event.request_fingerprint <> v_fingerprint then 'payload_mismatch'
        else v_existing_event.result_reason
      end,
      'journeyId', v_existing_event.journey_id,
      'eventId', v_existing_event.id,
      'journeyStatus', v_existing_event.result_journey_status,
      'appliedAmountTokens', v_existing_event.applied_amount_tokens,
      'watchedWallets', v_existing_event.result_watched_wallets,
      'releasedWallets', v_existing_event.result_released_wallets,
      'journeyReleased', v_existing_event.journey_released
    );
  end if;

  select custody_journey_enabled into v_enabled
  from public.bot_config
  where user_id = p_user_id;
  if not found then
    return jsonb_build_object(
      'applied', false, 'duplicate', false, 'payloadMismatch', false,
      'reason', 'config_not_found', 'journeyId', null, 'eventId', null,
      'journeyStatus', null, 'appliedAmountTokens', 0,
      'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
      'journeyReleased', false
    );
  end if;
  if v_enabled is not true then
    return jsonb_build_object(
      'applied', false, 'duplicate', false, 'payloadMismatch', false,
      'reason', 'custody_journey_disabled', 'journeyId', null, 'eventId', null,
      'journeyStatus', null, 'appliedAmountTokens', 0,
      'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
      'journeyReleased', false
    );
  end if;

  select * into v_journey
  from public.custody_journeys
  where user_id = p_user_id and token_mint = v_mint and status = 'active'
  for update;
  if not found then
    select exists (
      select 1 from public.bot_config
      where user_id = p_user_id
        and (
          target_wallet = v_source_wallet
          or v_source_wallet = any(coalesce(additional_target_wallets, '{}'))
        )
    ) into v_source_is_target;
    v_pending_payload := jsonb_build_object(
      'p_user_id', p_user_id,
      'p_token_mint', v_mint,
      'p_event_key', v_event_key,
      'p_tx_sig', v_tx_sig,
      'p_slot', p_slot,
      'p_event_at', p_event_at,
      'p_source_wallet', v_source_wallet,
      'p_recipients', p_recipients,
      'p_metadata', coalesce(p_metadata, '{}'::jsonb)
    );
    insert into public.custody_pending_events as existing_pending (
      user_id, event_key, event_type, request_fingerprint, token_mint,
      tx_sig, slot, event_at, source_wallet, requested_amount_tokens,
      payload, status, last_error_code, next_retry_at, expires_at
    ) values (
      p_user_id, v_event_key, 'CUSTODY_TRANSFER', v_fingerprint, v_mint,
      v_tx_sig, p_slot, p_event_at, v_source_wallet, v_requested_total,
      v_pending_payload, 'pending', 'unscoped',
      'infinity'::timestamptz, 'infinity'::timestamptz
    )
    on conflict (user_id, event_key) do update set
      updated_at = now()
    returning * into v_pending;
    if v_pending.request_fingerprint <> v_fingerprint then
      update public.custody_pending_events set
        status = 'terminal',
        last_retry_at = now(),
        next_retry_at = now(),
        last_error_code = 'payload_mismatch',
        journey_id = coalesce(journey_id, v_journey.id),
        result = jsonb_build_object(
          'applied', false, 'duplicate', true, 'payloadMismatch', true,
          'reason', 'payload_mismatch',
          'journeyId', coalesce(journey_id, v_journey.id), 'eventId', event_id,
          'journeyStatus', null, 'appliedAmountTokens', 0,
          'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
          'journeyReleased', false
        ),
        updated_at = now()
      where id = v_pending.id;
      return jsonb_build_object(
        'applied', false, 'duplicate', true, 'payloadMismatch', true,
        'reason', 'payload_mismatch', 'journeyId', null, 'eventId', null,
        'journeyStatus', null, 'appliedAmountTokens', 0,
        'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
        'journeyReleased', false
      );
    end if;
    return jsonb_build_object(
      'applied', false, 'duplicate', false, 'payloadMismatch', false,
      'reason', 'staged_unscoped',
      'journeyId', null, 'eventId', null,
      'journeyStatus', null, 'appliedAmountTokens', 0,
      'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
      'journeyReleased', false
    );
  end if;

  select * into v_source
  from public.custody_journey_wallets
  where journey_id = v_journey.id and wallet = v_source_wallet
  for update;
  if not found or v_source.current_attributed_tokens <= 0 then
    v_pending_payload := jsonb_build_object(
      'p_user_id', p_user_id,
      'p_token_mint', v_mint,
      'p_event_key', v_event_key,
      'p_tx_sig', v_tx_sig,
      'p_slot', p_slot,
      'p_event_at', p_event_at,
      'p_source_wallet', v_source_wallet,
      'p_recipients', p_recipients,
      'p_metadata', coalesce(p_metadata, '{}'::jsonb)
    );
    insert into public.custody_pending_events as existing_pending (
      user_id, event_key, event_type, request_fingerprint, token_mint,
      tx_sig, slot, event_at, source_wallet, requested_amount_tokens,
      payload, status, last_error_code, journey_id
    ) values (
      p_user_id, v_event_key, 'CUSTODY_TRANSFER', v_fingerprint, v_mint,
      v_tx_sig, p_slot, p_event_at, v_source_wallet, v_requested_total,
      v_pending_payload, 'pending', 'source_not_attributed', v_journey.id
    )
    on conflict (user_id, event_key) do update set
      status = case
        when existing_pending.request_fingerprint = excluded.request_fingerprint
          and existing_pending.status = 'pending'
          and excluded.status = 'terminal'
        then 'terminal' else existing_pending.status
      end,
      last_error_code = case
        when existing_pending.request_fingerprint = excluded.request_fingerprint
          and existing_pending.status = 'pending'
          and excluded.status = 'terminal'
        then excluded.last_error_code else existing_pending.last_error_code
      end,
      updated_at = now()
    returning * into v_pending;
    if v_pending.request_fingerprint <> v_fingerprint then
      update public.custody_pending_events set
        status = 'terminal',
        last_retry_at = now(),
        next_retry_at = now(),
        last_error_code = 'payload_mismatch',
        journey_id = coalesce(journey_id, v_journey.id),
        result = jsonb_build_object(
          'applied', false, 'duplicate', true, 'payloadMismatch', true,
          'reason', 'payload_mismatch',
          'journeyId', coalesce(journey_id, v_journey.id), 'eventId', event_id,
          'journeyStatus', 'active', 'appliedAmountTokens', 0,
          'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
          'journeyReleased', false
        ),
        updated_at = now()
      where id = v_pending.id;
      return jsonb_build_object(
        'applied', false, 'duplicate', true, 'payloadMismatch', true,
        'reason', 'payload_mismatch', 'journeyId', v_journey.id, 'eventId', null,
        'journeyStatus', 'active', 'appliedAmountTokens', 0,
        'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
        'journeyReleased', false
      );
    end if;
    return jsonb_build_object(
      'applied', false, 'duplicate', false, 'payloadMismatch', false,
      'reason', 'pending_upstream', 'journeyId', v_journey.id, 'eventId', null,
      'journeyStatus', 'active', 'appliedAmountTokens', 0,
      'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
      'journeyReleased', false
    );
  end if;

  -- Fail closed when a recovered event predates the currently attributed
  -- source cohort. Applying it would debit a later acquisition or mutation.
  if p_slot is not null
     and v_source.last_slot is not null
     and (
       p_slot < v_source.last_slot
       or (
         p_slot = v_source.last_slot
         and v_tx_sig <> v_source.last_tx_sig
       )
     ) then
    v_terminal_reason := case
      when p_slot < v_source.last_slot then 'predates_attribution_state'
      else 'same_slot_order_unknown'
    end;
    v_pending_payload := jsonb_build_object(
      'p_user_id', p_user_id,
      'p_token_mint', v_mint,
      'p_event_key', v_event_key,
      'p_tx_sig', v_tx_sig,
      'p_slot', p_slot,
      'p_event_at', p_event_at,
      'p_source_wallet', v_source_wallet,
      'p_recipients', p_recipients,
      'p_metadata', coalesce(p_metadata, '{}'::jsonb)
    );
    v_terminal_result := jsonb_build_object(
      'applied', false, 'duplicate', false, 'payloadMismatch', false,
      'reason', v_terminal_reason,
      'journeyId', v_journey.id, 'eventId', null,
      'journeyStatus', 'active', 'appliedAmountTokens', 0,
      'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
      'journeyReleased', false
    );
    insert into public.custody_pending_events as existing_pending (
      user_id, event_key, event_type, request_fingerprint, token_mint,
      tx_sig, slot, event_at, source_wallet, requested_amount_tokens,
      payload, status, last_error_code, journey_id, result
    ) values (
      p_user_id, v_event_key, 'CUSTODY_TRANSFER', v_fingerprint, v_mint,
      v_tx_sig, p_slot, p_event_at, v_source_wallet, v_requested_total,
      v_pending_payload, 'terminal', v_terminal_reason,
      v_journey.id, v_terminal_result
    )
    on conflict (user_id, event_key) do update set
      status = case
        when existing_pending.request_fingerprint = excluded.request_fingerprint
        then 'terminal' else existing_pending.status
      end,
      last_error_code = case
        when existing_pending.request_fingerprint = excluded.request_fingerprint
        then excluded.last_error_code else existing_pending.last_error_code
      end,
      journey_id = case
        when existing_pending.request_fingerprint = excluded.request_fingerprint
        then excluded.journey_id else existing_pending.journey_id
      end,
      result = case
        when existing_pending.request_fingerprint = excluded.request_fingerprint
        then excluded.result else existing_pending.result
      end,
      updated_at = now()
    returning * into v_pending;
    if v_pending.request_fingerprint <> v_fingerprint then
      update public.custody_pending_events set
        status = 'terminal',
        last_retry_at = now(),
        next_retry_at = now(),
        last_error_code = 'payload_mismatch',
        journey_id = coalesce(journey_id, v_journey.id),
        result = jsonb_build_object(
          'applied', false, 'duplicate', true, 'payloadMismatch', true,
          'reason', 'payload_mismatch',
          'journeyId', coalesce(journey_id, v_journey.id), 'eventId', event_id,
          'journeyStatus', 'active', 'appliedAmountTokens', 0,
          'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
          'journeyReleased', false
        ),
        updated_at = now()
      where id = v_pending.id;
      return jsonb_build_object(
        'applied', false, 'duplicate', true, 'payloadMismatch', true,
        'reason', 'payload_mismatch', 'journeyId', v_journey.id, 'eventId', null,
        'journeyStatus', 'active', 'appliedAmountTokens', 0,
        'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
        'journeyReleased', false
      );
    end if;
    return v_terminal_result;
  end if;

  v_source_outflow := v_source_pre - v_source_post;
  v_tolerance := greatest(0.000000001, greatest(v_requested_total, v_source_outflow) * 0.000000001);
  if v_raw_evidence_used then
    if exists (
      select 1 from jsonb_array_elements(v_normalized)
      where value->>'amountRaw' is null
        or value->>'recipientPreRaw' is null
        or value->>'recipientPostRaw' is null
    ) then
      raise exception 'custody transfer raw evidence is incomplete';
    end if;
    select coalesce(sum((value->>'amountRaw')::numeric(78, 0)), 0)
    into v_requested_raw_total
    from jsonb_array_elements(v_normalized);
    v_source_outflow_raw := v_source_pre_raw - v_source_post_raw;
  end if;
  select exists (
    select 1 from public.bot_config
    where user_id = p_user_id
      and (
        target_wallet = v_source_wallet
        or v_source_wallet = any(coalesce(additional_target_wallets, '{}'))
      )
  ) into v_source_is_target;
  if v_same_tx_requested and not v_source_is_target then
    raise exception 'same-transaction acquisition source is not a configured target';
  end if;
  if v_same_tx_requested or (v_source_outflow = 0 and v_source_is_target) then
    select
      count(*),
      coalesce(sum(applied_amount_tokens), 0),
      count(*) filter (
        where coalesce(metadata->>'grossAmountRaw', metadata->>'amountRaw')
          ~ '^[0-9]+$'
      ),
      coalesce(sum(case
        when coalesce(metadata->>'grossAmountRaw', metadata->>'amountRaw')
          ~ '^[0-9]+$'
        then coalesce(metadata->>'grossAmountRaw', metadata->>'amountRaw')::numeric(78, 0)
        else 0
      end), 0)
    into
      v_same_tx_buy_count,
      v_same_tx_buy_amount,
      v_same_tx_buy_raw_count,
      v_same_tx_buy_raw
    from public.custody_journey_events
    where journey_id = v_journey.id
      and event_type = 'VERIFIED_TARGET_BUY'
      and tx_sig = v_tx_sig
      and slot is not distinct from p_slot
      and source_wallet = v_source_wallet;
  end if;
  if v_same_tx_requested then
    v_tolerance := greatest(
      v_tolerance,
      greatest(v_same_tx_buy_amount, v_source_pre, v_source_post) * 0.000000001
    );
    if v_same_tx_buy_count <= 0
       or abs(v_same_tx_buy_amount - v_source_pre) > v_tolerance
       or abs(v_same_tx_buy_amount - (v_source_post + v_requested_total)) > v_tolerance
       or abs(
         (v_chain_source_post - v_chain_source_pre) - v_source_post
       ) > v_tolerance
       or v_source.current_attributed_tokens + v_tolerance < v_same_tx_buy_amount then
      raise exception 'same-transaction acquisition does not reconcile to verified buy';
    end if;
    if v_raw_evidence_used and (
      v_same_tx_buy_raw_count <> v_same_tx_buy_count
      or v_same_tx_buy_raw <> v_source_pre_raw
      or v_same_tx_buy_raw <> v_source_post_raw + v_requested_raw_total
      or v_chain_source_post_raw - v_chain_source_pre_raw <> v_source_post_raw
    ) then
      raise exception 'same-transaction acquisition raw evidence does not reconcile';
    end if;
    v_same_tx_verified_acquisition := true;
  elsif v_source_outflow = 0 and v_source_is_target then
    v_synthetic_target_delivery :=
      v_same_tx_buy_count > 0
      and v_same_tx_buy_amount > 0
      and abs(v_same_tx_buy_amount - v_requested_total) <= v_tolerance
      and v_source.current_attributed_tokens + v_tolerance >= v_same_tx_buy_amount;
    v_same_tx_verified_acquisition := v_synthetic_target_delivery;
  end if;
  if not v_synthetic_target_delivery
     and (
       (v_raw_evidence_used and v_requested_raw_total <> v_source_outflow_raw)
       or (
         not v_raw_evidence_used
         and abs(v_requested_total - v_source_outflow) > v_tolerance
       )
     ) then
    raise exception 'custody transfer payload does not reconcile to sender balances';
  end if;

  for v_item in select value from jsonb_array_elements(v_normalized)
  loop
    v_requested := (v_item->>'requestedAmountTokens')::numeric;
    v_recipient_pre := (v_item->>'recipientPreAmount')::numeric;
    v_recipient_post := (v_item->>'recipientPostAmount')::numeric;
    if v_raw_evidence_used then
      v_recipient_amount_raw := (v_item->>'amountRaw')::numeric(78, 0);
      v_recipient_pre_raw := (v_item->>'recipientPreRaw')::numeric(78, 0);
      v_recipient_post_raw := (v_item->>'recipientPostRaw')::numeric(78, 0);
      if v_recipient_post_raw - v_recipient_pre_raw <> v_recipient_amount_raw then
        raise exception 'custody transfer recipient raw balance does not reconcile';
      end if;
    elsif v_recipient_post - v_recipient_pre + v_tolerance < v_requested then
      raise exception 'custody transfer recipient balance does not reconcile';
    end if;
  end loop;

  if v_synthetic_target_delivery then
    v_scale := least(1, v_source.current_attributed_tokens / v_requested_total);
  else
    if v_source_pre <= 0 then
      raise exception 'custody transfer has no sender pre-balance';
    end if;
    v_scale := least(1, v_source.current_attributed_tokens / v_source_pre);
  end if;
  v_applied_total := least(
    v_source.current_attributed_tokens,
    v_requested_total * v_scale
  );
  if v_applied_total <= 0 then
    return jsonb_build_object(
      'applied', false, 'duplicate', false, 'payloadMismatch', false,
      'reason', 'no_attributed_balance', 'journeyId', v_journey.id, 'eventId', null,
      'journeyStatus', 'active', 'appliedAmountTokens', 0,
      'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
      'journeyReleased', false
    );
  end if;

  v_next_hop := v_source.hop_depth + 1;
  v_source_will_release := v_source.current_attributed_tokens - v_applied_total <= 0;
  select count(*) into v_active_wallet_count
  from public.custody_journey_wallets
  where journey_id = v_journey.id and watch_status = 'active';
  if v_source_will_release and v_source.watch_status = 'active' then
    v_active_wallet_count := greatest(0, v_active_wallet_count - 1);
  end if;
  if jsonb_array_length(v_normalized) = 1 then
    v_destination_wallet := v_normalized->0->>'wallet';
  end if;

  -- Preflight the whole split before inserting or mutating any receipt. RPC
  -- recovery has no transaction index within a slot, so an older destination
  -- snapshot—or a different transaction in the same slot—cannot safely be
  -- applied incrementally to a newer destination cohort.
  for v_item in select value from jsonb_array_elements(v_normalized)
  loop
    v_wallet := v_item->>'wallet';
    select * into v_destination
    from public.custody_journey_wallets
    where journey_id = v_journey.id and wallet = v_wallet
    for update;
    if found
       and p_slot is not null
       and v_destination.last_slot is not null
       and (
         p_slot < v_destination.last_slot
         or (
           p_slot = v_destination.last_slot
           and v_tx_sig <> v_destination.last_tx_sig
         )
       )
       and v_destination_chronology_reason is null then
      v_destination_chronology_reason := case
        when p_slot < v_destination.last_slot then 'partial_predates_destination_state'
        else 'partial_same_slot_destination_order_unknown'
      end;
      v_destination_chronology_wallet := v_wallet;
    end if;
  end loop;

  if v_destination_chronology_reason is not null then
    v_result_recipients := '[]'::jsonb;
    for v_item in select value from jsonb_array_elements(v_normalized)
    loop
      v_wallet := v_item->>'wallet';
      v_result_recipients := v_result_recipients || jsonb_build_array(
        jsonb_build_object(
          'wallet', v_wallet,
          'requestedAmountTokens', (v_item->>'requestedAmountTokens')::numeric,
          'appliedAmountTokens', 0,
          'movedAmount', 0,
          'amountRaw', v_item->'amountRaw',
          'recipientPreRaw', v_item->'recipientPreRaw',
          'recipientPostRaw', v_item->'recipientPostRaw',
          'recipientPreAmount', (v_item->>'recipientPreAmount')::numeric,
          'recipientPostAmount', (v_item->>'recipientPostAmount')::numeric,
          'inputWatchable', (v_item->>'watchable')::boolean,
          'watchable', false,
          'watchStatus', 'unchanged',
          'inferredType', v_item->>'inferredType',
          'inferredLabel', v_item->'inferredLabel',
          'inferenceConfidence', (v_item->>'inferenceConfidence')::numeric,
          'inferenceSource', v_item->>'inferenceSource',
          'evidence', v_item->'evidence',
          'hopDepth', v_next_hop,
          'boundaryReason', v_destination_chronology_reason,
          'chronologyConflict', v_wallet = v_destination_chronology_wallet
        )
      );
    end loop;
    insert into public.custody_journey_events (
      journey_id, user_id, event_key, event_type, request_fingerprint,
      tx_sig, slot, event_at, source_wallet, destination_wallet,
      requested_amount_tokens, applied_amount_tokens, reconciled_amount_tokens,
      source_pre_amount_tokens, source_post_amount_tokens, evidence_reliable,
      recipients, result_reason, result_journey_status, metadata
    ) values (
      v_journey.id, p_user_id, v_event_key, 'CUSTODY_TRANSFER', v_fingerprint,
      v_tx_sig, p_slot, p_event_at, v_source_wallet, v_destination_wallet,
      v_requested_total, 0, 0, v_source_pre, v_source_post, false,
      v_result_recipients, v_destination_chronology_reason, 'active',
      coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
        'chronologyGuard', v_destination_chronology_reason,
        'chronologyConflictWallet', v_destination_chronology_wallet,
        'coveragePartial', true
      )
    )
    returning id into v_event_id;
    v_terminal_result := jsonb_build_object(
      'applied', false, 'duplicate', false, 'payloadMismatch', false,
      'reason', v_destination_chronology_reason,
      'journeyId', v_journey.id, 'eventId', v_event_id,
      'journeyStatus', 'active', 'appliedAmountTokens', 0,
      'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
      'journeyReleased', false
    );
    update public.custody_pending_events set
      status = 'terminal',
      last_retry_at = now(),
      last_error_code = v_destination_chronology_reason,
      journey_id = v_journey.id,
      event_id = v_event_id,
      result = v_terminal_result,
      updated_at = now()
    where user_id = p_user_id and event_key = v_event_key
      and status = 'pending';
    return v_terminal_result;
  end if;

  -- Same-transaction acquisition rows use a modeled gross lot and therefore
  -- do not represent a comparable wallet-wide balance snapshot. For ordinary
  -- transfers, compare consecutive confirmed balance boundaries only after all
  -- destination chronology checks pass, so a failed split preflight cannot
  -- leave a half-applied source mutation.
  if not v_same_tx_verified_acquisition
     and not v_synthetic_target_delivery
     and v_source.balance_evidence_reliable
     and v_source.last_observed_balance_tokens is not null
     and v_source.last_observed_balance_tokens > 0
     and v_source_pre < v_source.last_observed_balance_tokens then
    v_prior_share := least(
      1,
      v_source.current_attributed_tokens / v_source.last_observed_balance_tokens
    );
    v_unresolved := least(
      v_source.current_attributed_tokens,
      (v_source.last_observed_balance_tokens - v_source_pre) * v_prior_share
    );
    if v_unresolved > 0 then
      update public.custody_journey_wallets set
        current_attributed_tokens = greatest(0, current_attributed_tokens - v_unresolved),
        total_unresolved_outflow_tokens = total_unresolved_outflow_tokens + v_unresolved,
        updated_at = now()
      where id = v_source.id;
      update public.custody_journeys set
        current_attributed_tokens = greatest(0, current_attributed_tokens - v_unresolved),
        total_unresolved_outflow_tokens = total_unresolved_outflow_tokens + v_unresolved,
        updated_at = now()
      where id = v_journey.id;
      v_source.current_attributed_tokens := greatest(
        0,
        v_source.current_attributed_tokens - v_unresolved
      );
      v_result_reason := 'partial_unobserved_outflow';
    end if;
  end if;

  -- Recompute allocation after the continuity adjustment. The earlier value
  -- was used only for fail-closed destination preflight planning.
  if v_synthetic_target_delivery then
    v_scale := least(1, v_source.current_attributed_tokens / v_requested_total);
  else
    v_scale := least(1, v_source.current_attributed_tokens / v_source_pre);
  end if;
  v_applied_total := least(
    v_source.current_attributed_tokens,
    v_requested_total * v_scale
  );
  v_source_will_release := v_source.current_attributed_tokens - v_applied_total <= 0;

  if v_applied_total <= 0 and v_unresolved > 0 then
    v_result_recipients := '[]'::jsonb;
    for v_item in select value from jsonb_array_elements(v_normalized)
    loop
      v_result_recipients := v_result_recipients || jsonb_build_array(
        jsonb_build_object(
          'wallet', v_item->>'wallet',
          'requestedAmountTokens', (v_item->>'requestedAmountTokens')::numeric,
          'appliedAmountTokens', 0,
          'movedAmount', 0,
          'amountRaw', v_item->'amountRaw',
          'recipientPreRaw', v_item->'recipientPreRaw',
          'recipientPostRaw', v_item->'recipientPostRaw',
          'recipientPreAmount', (v_item->>'recipientPreAmount')::numeric,
          'recipientPostAmount', (v_item->>'recipientPostAmount')::numeric,
          'inputWatchable', (v_item->>'watchable')::boolean,
          'watchable', false,
          'watchStatus', 'unchanged',
          'inferredType', v_item->>'inferredType',
          'inferredLabel', v_item->'inferredLabel',
          'inferenceConfidence', (v_item->>'inferenceConfidence')::numeric,
          'inferenceSource', v_item->>'inferenceSource',
          'evidence', v_item->'evidence',
          'hopDepth', v_next_hop,
          'boundaryReason', 'unresolved_prior_outflow'
        )
      );
    end loop;
    insert into public.custody_journey_events (
      journey_id, user_id, event_key, event_type, request_fingerprint,
      tx_sig, slot, event_at, source_wallet, destination_wallet,
      requested_amount_tokens, applied_amount_tokens, reconciled_amount_tokens,
      source_pre_amount_tokens, source_post_amount_tokens, evidence_reliable,
      recipients, result_reason, result_journey_status, metadata
    ) values (
      v_journey.id, p_user_id, v_event_key, 'CUSTODY_TRANSFER', v_fingerprint,
      v_tx_sig, p_slot, p_event_at, v_source_wallet, v_destination_wallet,
      v_requested_total, 0, v_source_outflow, v_source_pre, v_source_post, true,
      v_result_recipients, 'partial_unobserved_outflow', 'active',
      coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
        'unresolvedPriorOutflowTokens', v_unresolved,
        'coveragePartial', true
      )
    ) returning id into v_event_id;
    update public.custody_journey_wallets set
      current_attributed_tokens = 0,
      last_observed_balance_tokens = v_source_post,
      attributed_share = 0,
      balance_evidence_reliable = true,
      watch_status = 'released',
      released_at = p_event_at,
      release_reason = 'unresolved_outflow',
      last_activity_at = greatest(last_activity_at, p_event_at),
      last_balance_observed_at = p_event_at,
      last_event_key = v_event_key,
      last_tx_sig = v_tx_sig,
      last_slot = p_slot,
      updated_at = now()
    where id = v_source.id;
    if v_source.watch_status = 'active' then
      v_released := array[v_source_wallet];
    end if;
    select current_attributed_tokens into v_remaining
    from public.custody_journeys where id = v_journey.id;
    if v_remaining <= 0 then
      select array_cat(
        v_released,
        coalesce(array_agg(wallet order by wallet), '{}')
      ) into v_released
      from public.custody_journey_wallets
      where journey_id = v_journey.id and watch_status = 'active';
      update public.custody_journey_wallets set
        watch_status = 'released',
        released_at = coalesce(released_at, p_event_at),
        release_reason = coalesce(release_reason, 'journey_flat'),
        updated_at = now()
      where journey_id = v_journey.id and watch_status <> 'released';
      update public.custody_journeys set
        status = 'flat', flat_at = p_event_at,
        flat_reason = 'custody_coverage_lost',
        last_activity_at = greatest(last_activity_at, p_event_at),
        last_event_key = v_event_key, updated_at = now()
      where id = v_journey.id;
    end if;
    select coalesce(array_agg(wallet order by wallet), '{}') into v_released
    from (select distinct unnest(v_released) as wallet) unique_released;
    update public.custody_journey_events set
      result_journey_status = case when v_remaining <= 0 then 'flat' else 'active' end,
      result_released_wallets = v_released,
      journey_released = v_remaining <= 0
    where id = v_event_id;
    update public.custody_pending_events set
      status = 'applied', last_retry_at = now(), last_error_code = null,
      journey_id = v_journey.id, event_id = v_event_id,
      result = jsonb_build_object(
        'applied', true, 'duplicate', false, 'payloadMismatch', false,
        'reason', 'partial_unobserved_outflow',
        'journeyId', v_journey.id, 'eventId', v_event_id,
        'journeyStatus', case when v_remaining <= 0 then 'flat' else 'active' end,
        'appliedAmountTokens', 0, 'watchedWallets', array[]::text[],
        'releasedWallets', v_released, 'journeyReleased', v_remaining <= 0
      ), updated_at = now()
    where user_id = p_user_id and event_key = v_event_key and status = 'pending';
    return jsonb_build_object(
      'applied', true, 'duplicate', false, 'payloadMismatch', false,
      'reason', 'partial_unobserved_outflow',
      'journeyId', v_journey.id, 'eventId', v_event_id,
      'journeyStatus', case when v_remaining <= 0 then 'flat' else 'active' end,
      'appliedAmountTokens', 0, 'watchedWallets', array[]::text[],
      'releasedWallets', v_released, 'journeyReleased', v_remaining <= 0
    );
  end if;

  insert into public.custody_journey_events (
    journey_id, user_id, event_key, event_type, request_fingerprint,
    tx_sig, slot, event_at, source_wallet, destination_wallet,
    requested_amount_tokens, applied_amount_tokens, reconciled_amount_tokens,
    source_pre_amount_tokens, source_post_amount_tokens, evidence_reliable,
    recipients, result_journey_status, metadata
  ) values (
    v_journey.id, p_user_id, v_event_key, 'CUSTODY_TRANSFER', v_fingerprint,
    v_tx_sig, p_slot, p_event_at, v_source_wallet, v_destination_wallet,
    v_requested_total, v_applied_total,
    case when v_synthetic_target_delivery then v_same_tx_buy_amount else v_source_outflow end,
    v_source_pre, v_source_post, true,
    '[]'::jsonb, 'active', coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
      'attributionMethod', case
        when v_same_tx_verified_acquisition then 'same_tx_verified_acquisition'
        else 'pro_rata_sender_pre_balance'
      end,
      'classificationReliable', true,
      'rawEvidenceUsed', v_raw_evidence_used,
      'unresolvedPriorOutflowTokens', v_unresolved,
      'coveragePartial', v_unresolved > 0
    )
  )
  returning id into v_event_id;

  for v_item in select value from jsonb_array_elements(v_normalized)
  loop
    v_wallet := v_item->>'wallet';
    v_requested := (v_item->>'requestedAmountTokens')::numeric;
    v_applied := least(v_source.current_attributed_tokens, v_requested * v_scale);
    v_recipient_pre := (v_item->>'recipientPreAmount')::numeric;
    v_recipient_post := (v_item->>'recipientPostAmount')::numeric;
    v_input_watchable := (v_item->>'watchable')::boolean;

    select * into v_destination
    from public.custody_journey_wallets
    where journey_id = v_journey.id and wallet = v_wallet
    for update;
    v_destination_exists := found;
    v_destination_active := v_destination_exists and v_destination.watch_status = 'active';
    v_effective_hop := case
      when v_wallet = any(v_journey.source_target_wallets) then 0
      when v_destination_exists then greatest(v_next_hop, v_destination.hop_depth)
      else v_next_hop
    end;
    v_destination_unresolved := 0;
    if v_destination_exists
       and v_destination.balance_evidence_reliable
       and v_destination.last_observed_balance_tokens is not null
       and v_destination.last_observed_balance_tokens > 0
       and v_recipient_pre < v_destination.last_observed_balance_tokens then
      v_prior_share := least(
        1,
        v_destination.current_attributed_tokens
          / v_destination.last_observed_balance_tokens
      );
      v_destination_unresolved := least(
        v_destination.current_attributed_tokens,
        (v_destination.last_observed_balance_tokens - v_recipient_pre) * v_prior_share
      );
      if v_destination_unresolved > 0 then
        update public.custody_journey_wallets set
          current_attributed_tokens = greatest(
            0,
            current_attributed_tokens - v_destination_unresolved
          ),
          total_unresolved_outflow_tokens =
            total_unresolved_outflow_tokens + v_destination_unresolved,
          updated_at = now()
        where id = v_destination.id;
        update public.custody_journeys set
          current_attributed_tokens = greatest(
            0,
            current_attributed_tokens - v_destination_unresolved
          ),
          total_unresolved_outflow_tokens =
            total_unresolved_outflow_tokens + v_destination_unresolved,
          updated_at = now()
        where id = v_journey.id;
        v_destination.current_attributed_tokens := greatest(
          0,
          v_destination.current_attributed_tokens - v_destination_unresolved
        );
        v_destination_unresolved_total :=
          v_destination_unresolved_total + v_destination_unresolved;
        v_result_reason := 'partial_unobserved_outflow';
      end if;
    end if;
    v_boundary_reason := null;
    if v_effective_hop > 8 then
      v_boundary_reason := 'hop_limit';
    elsif not v_input_watchable then
      v_boundary_reason := 'classified_unwatchable';
    elsif not v_destination_active and v_active_wallet_count >= 250 then
      v_boundary_reason := 'wallet_limit';
    end if;
    -- A boundary is conservative for the whole mixed wallet. This prevents a
    -- cycle into an already-watched address from bypassing hop or wallet caps.
    v_should_watch := v_boundary_reason is null;
    if v_should_watch and not v_destination_active then
      v_active_wallet_count := v_active_wallet_count + 1;
    elsif not v_should_watch and v_destination_active then
      v_active_wallet_count := greatest(0, v_active_wallet_count - 1);
      if not (v_wallet = any(v_released)) then
        v_released := array_append(v_released, v_wallet);
      end if;
    end if;

    insert into public.custody_wallet_profiles as existing_profile (
      user_id, wallet, inferred_type, inferred_label, inference_confidence,
      inference_source, first_seen_at, last_seen_at
    ) values (
      p_user_id, v_wallet, v_item->>'inferredType',
      nullif(v_item->>'inferredLabel', ''),
      (v_item->>'inferenceConfidence')::numeric,
      v_item->>'inferenceSource', p_event_at, p_event_at
    )
    on conflict (user_id, wallet) do update set
      inferred_type = case
        when excluded.inference_confidence >= existing_profile.inference_confidence
        then excluded.inferred_type else existing_profile.inferred_type
      end,
      inferred_label = case
        when excluded.inference_confidence >= existing_profile.inference_confidence
        then coalesce(excluded.inferred_label, existing_profile.inferred_label)
        else existing_profile.inferred_label
      end,
      inference_confidence = greatest(
        existing_profile.inference_confidence,
        excluded.inference_confidence
      ),
      inference_source = case
        when excluded.inference_confidence >= existing_profile.inference_confidence
        then excluded.inference_source else existing_profile.inference_source
      end,
      last_seen_at = greatest(existing_profile.last_seen_at, excluded.last_seen_at),
      updated_at = now();

    insert into public.custody_journey_wallets as existing_wallet (
      journey_id, user_id, token_mint, wallet, hop_depth, parent_wallet,
      source_target_wallets, watch_status, current_attributed_tokens,
      last_observed_balance_tokens, attributed_share, balance_evidence_reliable,
      total_received_tokens, first_seen_at, last_activity_at,
      last_balance_observed_at, released_at, release_reason,
      last_event_key, last_tx_sig, watch_anchor_slot, last_slot
    ) values (
      v_journey.id, p_user_id, v_mint, v_wallet, v_effective_hop, v_source_wallet,
      v_source.source_target_wallets,
      case when v_should_watch then 'active' else 'unwatchable' end,
      v_applied, v_recipient_post,
      case when v_recipient_post > 0 then least(1, v_applied / v_recipient_post) else 0 end,
      true, v_applied, p_event_at, p_event_at, p_event_at, null,
      case when v_should_watch then null else v_boundary_reason end,
      v_event_key, v_tx_sig, p_slot, p_slot
    )
    on conflict (journey_id, wallet) do update set
      hop_depth = case
        when v_wallet = any(v_journey.source_target_wallets) then 0
        else greatest(existing_wallet.hop_depth, excluded.hop_depth)
      end,
      parent_wallet = case
        when existing_wallet.hop_depth = 0 then existing_wallet.parent_wallet
        else coalesce(existing_wallet.parent_wallet, excluded.parent_wallet)
      end,
      source_target_wallets = array(
        select distinct source_wallet
        from unnest(existing_wallet.source_target_wallets || excluded.source_target_wallets)
          as source_wallet
        order by source_wallet
      ),
      watch_status = excluded.watch_status,
      current_attributed_tokens =
        existing_wallet.current_attributed_tokens + excluded.current_attributed_tokens,
      last_observed_balance_tokens = excluded.last_observed_balance_tokens,
      attributed_share = case
        when excluded.last_observed_balance_tokens > 0 then least(
          1,
          (existing_wallet.current_attributed_tokens + excluded.current_attributed_tokens)
            / excluded.last_observed_balance_tokens
        ) else 0
      end,
      balance_evidence_reliable = true,
      total_received_tokens = existing_wallet.total_received_tokens + excluded.total_received_tokens,
      last_activity_at = greatest(existing_wallet.last_activity_at, excluded.last_activity_at),
      last_balance_observed_at = excluded.last_balance_observed_at,
      released_at = case
        when excluded.watch_status = 'active' then null else p_event_at
      end,
      release_reason = excluded.release_reason,
      last_event_key = excluded.last_event_key,
      last_tx_sig = excluded.last_tx_sig,
      watch_anchor_slot = case
        when existing_wallet.watch_anchor_slot is null then excluded.watch_anchor_slot
        when excluded.watch_anchor_slot is null then existing_wallet.watch_anchor_slot
        else least(existing_wallet.watch_anchor_slot, excluded.watch_anchor_slot)
      end,
      last_slot = excluded.last_slot,
      updated_at = now()
    returning * into v_destination;

    if v_boundary_reason is null
       and v_destination.watch_status = 'active'
       and not (v_wallet = any(v_watched)) then
      v_watched := array_append(v_watched, v_wallet);
    end if;
    v_result_recipients := v_result_recipients || jsonb_build_array(jsonb_build_object(
      'wallet', v_wallet,
      'requestedAmountTokens', v_requested,
      'appliedAmountTokens', v_applied,
      'movedAmount', v_applied,
      'amountRaw', v_item->'amountRaw',
      'recipientPreRaw', v_item->'recipientPreRaw',
      'recipientPostRaw', v_item->'recipientPostRaw',
      'recipientPreAmount', v_recipient_pre,
      'recipientPostAmount', v_recipient_post,
      'inputWatchable', v_input_watchable,
      'watchable', v_boundary_reason is null,
      'watchStatus', case
        when v_boundary_reason is not null then 'unwatchable'
        else v_destination.watch_status
      end,
      'inferredType', v_item->>'inferredType',
      'inferredLabel', v_item->'inferredLabel',
      'inferenceConfidence', (v_item->>'inferenceConfidence')::numeric,
      'inferenceSource', v_item->>'inferenceSource',
      'evidence', v_item->'evidence',
      'hopDepth', v_effective_hop,
      'unresolvedPriorOutflowTokens', v_destination_unresolved,
      'boundaryReason', v_boundary_reason
    ));
  end loop;

  -- A destination can already have a wallet-wide cursor because it carries a
  -- different tracked mint. Wake only dormant events for recipients that this
  -- transfer has now made active for this exact journey+mint.
  update public.custody_pending_events set
    status = 'pending',
    next_retry_at = now(),
    last_error_code = 'pending_upstream',
    journey_id = v_journey.id,
    expires_at = now() + interval '24 hours',
    updated_at = now()
  where user_id = p_user_id
    and token_mint = v_mint
    and journey_id is null
    and (
      (status = 'pending' and last_error_code = 'unscoped')
      or status = 'expired'
    )
    and (p_slot is null or slot is null or slot >= p_slot)
    and source_wallet in (
      select result_row->>'wallet'
      from jsonb_array_elements(v_result_recipients) result_row
      where coalesce((result_row->>'watchable')::boolean, false)
        and coalesce((result_row->>'appliedAmountTokens')::numeric, 0) > 0
    );

  -- A conflict must stay quarantined, but link it to the journey as soon as
  -- this transfer proves that the recipient carried attributable custody.
  update public.custody_pending_events set
    journey_id = v_journey.id,
    result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
      'journeyId', v_journey.id,
      'reason', 'payload_mismatch',
      'payloadMismatch', true
    ),
    updated_at = now()
  where user_id = p_user_id
    and token_mint = v_mint
    and journey_id is null
    and status = 'terminal'
    and last_error_code = 'payload_mismatch'
    and (p_slot is null or slot is null or slot >= p_slot)
    and source_wallet in (
      select result_row->>'wallet'
      from jsonb_array_elements(v_result_recipients) result_row
      where coalesce((result_row->>'appliedAmountTokens')::numeric, 0) > 0
    );

  update public.custody_journey_wallets set
    current_attributed_tokens = greatest(0, v_source.current_attributed_tokens - v_applied_total),
    last_observed_balance_tokens = v_source_post,
    attributed_share = case
      when v_source_post > 0 then least(
        1,
        greatest(0, v_source.current_attributed_tokens - v_applied_total) / v_source_post
      ) else 0
    end,
    balance_evidence_reliable = true,
    total_transferred_tokens = total_transferred_tokens + v_applied_total,
    watch_status = case when v_source_will_release then 'released' else watch_status end,
    released_at = case when v_source_will_release then p_event_at else released_at end,
    release_reason = case
      when v_source_will_release then 'attributed_balance_transferred'
      else release_reason
    end,
    last_activity_at = greatest(last_activity_at, p_event_at),
    last_balance_observed_at = p_event_at,
    last_event_key = v_event_key,
    last_tx_sig = v_tx_sig,
    last_slot = p_slot,
    updated_at = now()
  where id = v_source.id;
  if v_source_will_release and v_source.watch_status = 'active' then
    if not (v_source_wallet = any(v_released)) then
      v_released := array_append(v_released, v_source_wallet);
    end if;
  end if;

  update public.custody_wallet_profiles set
    last_seen_at = greatest(last_seen_at, p_event_at),
    updated_at = now()
  where user_id = p_user_id and wallet = v_source_wallet;
  update public.custody_journeys set
    last_activity_at = greatest(last_activity_at, p_event_at),
    last_event_key = v_event_key,
    updated_at = now()
  where id = v_journey.id;

  select coalesce(array_agg(wallet order by wallet), '{}') into v_watched
  from (select distinct unnest(v_watched) as wallet) as unique_watched;
  select coalesce(array_agg(wallet order by wallet), '{}') into v_released
  from (select distinct unnest(v_released) as wallet) as unique_released;
  update public.custody_journey_events set
    recipients = v_result_recipients,
    result_reason = case
      when v_result_reason is not null then v_result_reason
      when exists (
        select 1 from jsonb_array_elements(v_result_recipients) result
        where result->>'boundaryReason' is not null
      ) then 'partial_observation_boundary'
      else null
    end,
    result_watched_wallets = v_watched,
    result_released_wallets = v_released,
    metadata = metadata || jsonb_build_object(
      'unresolvedPriorOutflowTokens', v_unresolved,
      'unresolvedRecipientOutflowTokens', v_destination_unresolved_total,
      'coveragePartial',
        v_unresolved + v_destination_unresolved_total > 0
        or exists (
          select 1 from jsonb_array_elements(v_result_recipients) result_row
          where result_row->>'boundaryReason' is not null
        )
    )
  where id = v_event_id;

  update public.custody_pending_events set
    status = 'applied',
    last_retry_at = now(),
    last_error_code = null,
    journey_id = v_journey.id,
    event_id = v_event_id,
    result = jsonb_build_object(
      'applied', true, 'duplicate', false, 'payloadMismatch', false,
      'reason', case
        when v_result_reason is not null then v_result_reason
        when exists (
          select 1 from jsonb_array_elements(v_result_recipients) result_row
          where result_row->>'boundaryReason' is not null
        ) then 'partial_observation_boundary'
        else null
      end,
      'journeyId', v_journey.id, 'eventId', v_event_id,
      'journeyStatus', 'active', 'appliedAmountTokens', v_applied_total,
      'watchedWallets', v_watched, 'releasedWallets', v_released,
      'journeyReleased', false
    ),
    updated_at = now()
  where user_id = p_user_id and event_key = v_event_key
    and status = 'pending';

  return jsonb_build_object(
    'applied', true, 'duplicate', false, 'payloadMismatch', false,
    'reason', case
      when v_result_reason is not null then v_result_reason
      when exists (
        select 1 from jsonb_array_elements(v_result_recipients) result
        where result->>'boundaryReason' is not null
      ) then 'partial_observation_boundary'
      else null
    end,
    'journeyId', v_journey.id, 'eventId', v_event_id,
    'journeyStatus', 'active', 'appliedAmountTokens', v_applied_total,
    'watchedWallets', v_watched, 'releasedWallets', v_released,
    'journeyReleased', false
  );
end;
$$;


-- Persist a confirmed negative token delta that could not be safely classified
-- as a verified sale or a conserving custody transfer. It reduces attribution
-- pro rata, marks coverage partial, and never claims that a sale occurred.
create or replace function public.record_custody_unresolved_outflow(
  p_user_id uuid,
  p_token_mint text,
  p_event_key text,
  p_tx_sig text,
  p_slot bigint,
  p_event_at timestamptz,
  p_wallet text,
  p_pre_amount_tokens numeric,
  p_post_amount_tokens numeric,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_enabled boolean;
  v_mint text := btrim(coalesce(p_token_mint, ''));
  v_event_key text := btrim(coalesce(p_event_key, ''));
  v_tx_sig text := btrim(coalesce(p_tx_sig, ''));
  v_wallet text := btrim(coalesce(p_wallet, ''));
  v_pre numeric := p_pre_amount_tokens;
  v_post numeric := p_post_amount_tokens;
  v_outflow numeric;
  v_pre_raw numeric(78, 0);
  v_post_raw numeric(78, 0);
  v_amount_raw numeric(78, 0);
  v_decimals_text text;
  v_decimals integer;
  v_raw_scale numeric;
  v_raw_evidence_used boolean := false;
  v_fingerprint text;
  v_existing_event public.custody_journey_events%rowtype;
  v_journey public.custody_journeys%rowtype;
  v_wallet_state public.custody_journey_wallets%rowtype;
  v_pending public.custody_pending_events%rowtype;
  v_pending_payload jsonb;
  v_event_id uuid;
  v_prior_share numeric := 0;
  v_prior_unresolved numeric := 0;
  v_applied numeric := 0;
  v_total_unresolved numeric := 0;
  v_wallet_remaining numeric := 0;
  v_journey_remaining numeric := 0;
  v_wallet_released boolean := false;
  v_released text[] := '{}';
  v_chronology_reason text;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  v_raw_evidence_used :=
    coalesce(p_metadata, '{}'::jsonb) ? 'preRaw'
    or coalesce(p_metadata, '{}'::jsonb) ? 'postRaw'
    or coalesce(p_metadata, '{}'::jsonb) ? 'amountRaw';
  if p_user_id is null
     or v_mint = ''
     or v_event_key = ''
     or v_tx_sig = ''
     or v_wallet = ''
     or p_event_at is null
     or v_pre is null
     or v_post is null
     or (
       not v_raw_evidence_used
       and (v_pre <= 0 or v_post < 0 or v_post >= v_pre)
     )
     or (p_slot is not null and p_slot < 0)
     or jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object' then
    raise exception 'invalid custody unresolved outflow';
  end if;

  if v_raw_evidence_used then
    v_decimals_text := btrim(coalesce(p_metadata->>'decimals', ''));
    if btrim(coalesce(p_metadata->>'preRaw', '')) !~ '^[0-9]+$'
       or btrim(coalesce(p_metadata->>'postRaw', '')) !~ '^[0-9]+$'
       or btrim(coalesce(p_metadata->>'amountRaw', '')) !~ '^[0-9]+$'
       or v_decimals_text !~ '^[0-9]{1,3}$' then
      raise exception 'custody unresolved outflow raw evidence is incomplete';
    end if;
    v_pre_raw := (p_metadata->>'preRaw')::numeric(78, 0);
    v_post_raw := (p_metadata->>'postRaw')::numeric(78, 0);
    v_amount_raw := (p_metadata->>'amountRaw')::numeric(78, 0);
    v_decimals := v_decimals_text::integer;
    if v_decimals > 255
       or v_pre_raw <= 0
       or v_post_raw >= v_pre_raw
       or v_pre_raw - v_post_raw <> v_amount_raw
       or v_amount_raw <= 0 then
      raise exception 'custody unresolved outflow raw evidence does not reconcile';
    end if;
    v_raw_scale := power(10::numeric, v_decimals);
    v_pre := v_pre_raw / v_raw_scale;
    v_post := v_post_raw / v_raw_scale;
    v_outflow := v_amount_raw / v_raw_scale;
  else
    v_outflow := v_pre - v_post;
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(v_mint));
  v_fingerprint := md5(jsonb_build_object(
    'eventType', 'CUSTODY_UNRESOLVED_OUTFLOW',
    'wallet', v_wallet,
    'tokenMint', v_mint,
    'txSig', v_tx_sig,
    'slot', p_slot,
    'rawEvidenceUsed', v_raw_evidence_used,
    'preRaw', case when v_raw_evidence_used then v_pre_raw else null end,
    'postRaw', case when v_raw_evidence_used then v_post_raw else null end,
    'amountRaw', case when v_raw_evidence_used then v_amount_raw else null end,
    'decimals', case when v_raw_evidence_used then v_decimals else null end,
    'preAmountTokens', case when v_raw_evidence_used then null else v_pre end,
    'postAmountTokens', case when v_raw_evidence_used then null else v_post end
  )::text);

  select * into v_existing_event
  from public.custody_journey_events
  where user_id = p_user_id and event_key = v_event_key;
  if found then
    if v_existing_event.request_fingerprint = v_fingerprint then
      update public.custody_journey_events set
        metadata = metadata || coalesce(p_metadata, '{}'::jsonb)
      where id = v_existing_event.id;
    else
      update public.custody_journey_events set
        result_reason = 'payload_mismatch',
        metadata = metadata || jsonb_build_object(
          'payloadConflictObserved', true,
          'payloadConflictObservedAt', now()
        )
      where id = v_existing_event.id;
    end if;
    return jsonb_build_object(
      'applied', false, 'duplicate', true,
      'payloadMismatch', v_existing_event.request_fingerprint <> v_fingerprint,
      'reason', case
        when v_existing_event.request_fingerprint <> v_fingerprint then 'payload_mismatch'
        else v_existing_event.result_reason
      end,
      'journeyId', v_existing_event.journey_id,
      'eventId', v_existing_event.id,
      'journeyStatus', v_existing_event.result_journey_status,
      'appliedAmountTokens', v_existing_event.applied_amount_tokens,
      'watchedWallets', v_existing_event.result_watched_wallets,
      'releasedWallets', v_existing_event.result_released_wallets,
      'journeyReleased', v_existing_event.journey_released
    );
  end if;

  select * into v_pending
  from public.custody_pending_events
  where user_id = p_user_id and event_key = v_event_key
  for update;
  if found and (
    v_pending.request_fingerprint <> v_fingerprint
    or (
      v_pending.status = 'terminal'
      and v_pending.last_error_code = 'payload_mismatch'
    )
  ) then
    update public.custody_pending_events set
      status = 'terminal', last_retry_at = now(), next_retry_at = now(),
      last_error_code = 'payload_mismatch',
      journey_id = coalesce(
        journey_id,
        (
          select active_journey.id
          from public.custody_journeys active_journey
          where active_journey.user_id = p_user_id
            and active_journey.token_mint = v_mint
            and active_journey.status = 'active'
          limit 1
        )
      ),
      result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
        'reason', 'payload_mismatch', 'payloadMismatch', true
      ),
      updated_at = now()
    where id = v_pending.id
    returning * into v_pending;
    return jsonb_build_object(
      'applied', false, 'duplicate', true, 'payloadMismatch', true,
      'reason', 'payload_mismatch', 'journeyId', v_pending.journey_id,
      'eventId', v_pending.event_id, 'journeyStatus', null,
      'appliedAmountTokens', 0, 'watchedWallets', array[]::text[],
      'releasedWallets', array[]::text[], 'journeyReleased', false
    );
  end if;

  select custody_journey_enabled into v_enabled
  from public.bot_config
  where user_id = p_user_id;
  if not found then
    return jsonb_build_object(
      'applied', false, 'duplicate', false, 'payloadMismatch', false,
      'reason', 'config_not_found', 'journeyId', null, 'eventId', null,
      'journeyStatus', null, 'appliedAmountTokens', 0,
      'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
      'journeyReleased', false
    );
  end if;
  if v_enabled is not true then
    return jsonb_build_object(
      'applied', false, 'duplicate', false, 'payloadMismatch', false,
      'reason', 'custody_journey_disabled', 'journeyId', null, 'eventId', null,
      'journeyStatus', null, 'appliedAmountTokens', 0,
      'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
      'journeyReleased', false
    );
  end if;

  v_pending_payload := jsonb_build_object(
    'p_user_id', p_user_id,
    'p_token_mint', v_mint,
    'p_event_key', v_event_key,
    'p_tx_sig', v_tx_sig,
    'p_slot', p_slot,
    'p_event_at', p_event_at,
    'p_wallet', v_wallet,
    'p_pre_amount_tokens', v_pre,
    'p_post_amount_tokens', v_post,
    'p_metadata', coalesce(p_metadata, '{}'::jsonb),
    'p_unresolved_outflow', true
  );

  select * into v_journey
  from public.custody_journeys
  where user_id = p_user_id and token_mint = v_mint and status = 'active'
  for update;
  if not found then
    insert into public.custody_pending_events as existing_pending (
      user_id, event_key, event_type, request_fingerprint, token_mint,
      tx_sig, slot, event_at, source_wallet, requested_amount_tokens,
      payload, status, last_error_code, next_retry_at, expires_at
    ) values (
      p_user_id, v_event_key, 'CUSTODY_TRANSFER', v_fingerprint, v_mint,
      v_tx_sig, p_slot, p_event_at, v_wallet, v_outflow,
      v_pending_payload, 'pending', 'unscoped',
      'infinity'::timestamptz, 'infinity'::timestamptz
    )
    on conflict (user_id, event_key) do update set updated_at = now()
    returning * into v_pending;
    if v_pending.request_fingerprint <> v_fingerprint then
      update public.custody_pending_events set
        status = 'terminal', last_retry_at = now(), next_retry_at = now(),
        last_error_code = 'payload_mismatch',
        result = jsonb_build_object(
          'applied', false, 'duplicate', true, 'payloadMismatch', true,
          'reason', 'payload_mismatch', 'journeyId', null, 'eventId', null,
          'journeyStatus', null, 'appliedAmountTokens', 0,
          'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
          'journeyReleased', false
        ),
        updated_at = now()
      where id = v_pending.id;
      return jsonb_build_object(
        'applied', false, 'duplicate', true, 'payloadMismatch', true,
        'reason', 'payload_mismatch', 'journeyId', null, 'eventId', null,
        'journeyStatus', null, 'appliedAmountTokens', 0,
        'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
        'journeyReleased', false
      );
    end if;
    return jsonb_build_object(
      'applied', false, 'duplicate', false, 'payloadMismatch', false,
      'reason', 'staged_unscoped', 'journeyId', null, 'eventId', null,
      'journeyStatus', null, 'appliedAmountTokens', 0,
      'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
      'journeyReleased', false
    );
  end if;

  select * into v_wallet_state
  from public.custody_journey_wallets
  where journey_id = v_journey.id and wallet = v_wallet
  for update;
  if not found or v_wallet_state.current_attributed_tokens <= 0 then
    insert into public.custody_pending_events as existing_pending (
      user_id, event_key, event_type, request_fingerprint, token_mint,
      tx_sig, slot, event_at, source_wallet, requested_amount_tokens,
      payload, status, last_error_code, journey_id
    ) values (
      p_user_id, v_event_key, 'CUSTODY_TRANSFER', v_fingerprint, v_mint,
      v_tx_sig, p_slot, p_event_at, v_wallet, v_outflow,
      v_pending_payload, 'pending', 'source_not_attributed', v_journey.id
    )
    on conflict (user_id, event_key) do update set updated_at = now()
    returning * into v_pending;
    if v_pending.request_fingerprint <> v_fingerprint then
      update public.custody_pending_events set
        status = 'terminal', last_retry_at = now(), next_retry_at = now(),
        last_error_code = 'payload_mismatch', journey_id = v_journey.id,
        result = jsonb_build_object(
          'applied', false, 'duplicate', true, 'payloadMismatch', true,
          'reason', 'payload_mismatch', 'journeyId', v_journey.id,
          'eventId', null, 'journeyStatus', 'active', 'appliedAmountTokens', 0,
          'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
          'journeyReleased', false
        ),
        updated_at = now()
      where id = v_pending.id;
      return jsonb_build_object(
        'applied', false, 'duplicate', true, 'payloadMismatch', true,
        'reason', 'payload_mismatch', 'journeyId', v_journey.id,
        'eventId', null, 'journeyStatus', 'active', 'appliedAmountTokens', 0,
        'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
        'journeyReleased', false
      );
    end if;
    return jsonb_build_object(
      'applied', false, 'duplicate', false, 'payloadMismatch', false,
      'reason', 'pending_upstream', 'journeyId', v_journey.id, 'eventId', null,
      'journeyStatus', 'active', 'appliedAmountTokens', 0,
      'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
      'journeyReleased', false
    );
  end if;

  if p_slot is not null
     and v_wallet_state.last_slot is not null
     and (
       p_slot < v_wallet_state.last_slot
       or (p_slot = v_wallet_state.last_slot and v_tx_sig <> v_wallet_state.last_tx_sig)
     ) then
    v_chronology_reason := case
      when p_slot < v_wallet_state.last_slot then 'predates_attribution_state'
      else 'same_slot_order_unknown'
    end;
    insert into public.custody_journey_events (
      journey_id, user_id, event_key, event_type, request_fingerprint,
      tx_sig, slot, event_at, source_wallet, requested_amount_tokens,
      applied_amount_tokens, reconciled_amount_tokens,
      source_pre_amount_tokens, source_post_amount_tokens, evidence_reliable,
      result_reason, result_journey_status, metadata
    ) values (
      v_journey.id, p_user_id, v_event_key, 'CUSTODY_TRANSFER', v_fingerprint,
      v_tx_sig, p_slot, p_event_at, v_wallet, v_outflow,
      0, 0, v_pre, v_post, false, v_chronology_reason, 'active',
      coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
        'observationKind', 'CUSTODY_UNRESOLVED_OUTFLOW',
        'chronologyGuard', v_chronology_reason,
        'coveragePartial', true
      )
    ) returning id into v_event_id;
    v_result := jsonb_build_object(
      'applied', false, 'duplicate', false, 'payloadMismatch', false,
      'reason', v_chronology_reason, 'journeyId', v_journey.id,
      'eventId', v_event_id, 'journeyStatus', 'active', 'appliedAmountTokens', 0,
      'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
      'journeyReleased', false
    );
    update public.custody_pending_events set
      status = 'terminal', last_retry_at = now(), next_retry_at = now(),
      last_error_code = v_chronology_reason, journey_id = v_journey.id,
      event_id = v_event_id, result = v_result, updated_at = now()
    where user_id = p_user_id and event_key = v_event_key and status = 'pending';
    return v_result;
  end if;

  if v_wallet_state.balance_evidence_reliable
     and v_wallet_state.last_observed_balance_tokens is not null
     and v_wallet_state.last_observed_balance_tokens > 0
     and v_pre < v_wallet_state.last_observed_balance_tokens then
    v_prior_share := least(
      1,
      v_wallet_state.current_attributed_tokens
        / v_wallet_state.last_observed_balance_tokens
    );
    v_prior_unresolved := least(
      v_wallet_state.current_attributed_tokens,
      (v_wallet_state.last_observed_balance_tokens - v_pre) * v_prior_share
    );
  end if;
  v_wallet_remaining := greatest(
    0,
    v_wallet_state.current_attributed_tokens - v_prior_unresolved
  );
  v_applied := least(v_wallet_remaining, v_outflow * least(1, v_wallet_remaining / v_pre));
  v_total_unresolved := v_prior_unresolved + v_applied;
  v_wallet_remaining := greatest(0, v_wallet_remaining - v_applied);
  v_wallet_released := v_wallet_remaining <= 0;

  insert into public.custody_journey_events (
    journey_id, user_id, event_key, event_type, request_fingerprint,
    tx_sig, slot, event_at, source_wallet, requested_amount_tokens,
    applied_amount_tokens, reconciled_amount_tokens,
    source_pre_amount_tokens, source_post_amount_tokens, evidence_reliable,
    result_reason, result_journey_status, metadata
  ) values (
    v_journey.id, p_user_id, v_event_key, 'CUSTODY_TRANSFER', v_fingerprint,
    v_tx_sig, p_slot, p_event_at, v_wallet, v_outflow,
    v_applied, v_outflow, v_pre, v_post, true,
    'partial_unresolved_outflow', 'active',
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
      'observationKind', 'CUSTODY_UNRESOLVED_OUTFLOW',
      'rawEvidenceUsed', v_raw_evidence_used,
      'unresolvedPriorOutflowTokens', v_prior_unresolved,
      'unresolvedCurrentOutflowTokens', v_applied,
      'coveragePartial', true
    )
  ) returning id into v_event_id;

  update public.custody_journey_wallets set
    current_attributed_tokens = v_wallet_remaining,
    last_observed_balance_tokens = v_post,
    attributed_share = case
      when v_post > 0 then least(1, v_wallet_remaining / v_post)
      else 0
    end,
    balance_evidence_reliable = true,
    total_unresolved_outflow_tokens =
      total_unresolved_outflow_tokens + v_total_unresolved,
    watch_status = case when v_wallet_released then 'released' else watch_status end,
    released_at = case when v_wallet_released then p_event_at else released_at end,
    release_reason = case
      when v_wallet_released then 'unresolved_outflow'
      else release_reason
    end,
    last_activity_at = greatest(last_activity_at, p_event_at),
    last_balance_observed_at = p_event_at,
    last_event_key = v_event_key,
    last_tx_sig = v_tx_sig,
    last_slot = p_slot,
    updated_at = now()
  where id = v_wallet_state.id;
  if v_wallet_released and v_wallet_state.watch_status = 'active' then
    v_released := array[v_wallet];
  end if;

  update public.custody_journeys set
    current_attributed_tokens = greatest(0, current_attributed_tokens - v_total_unresolved),
    total_unresolved_outflow_tokens =
      total_unresolved_outflow_tokens + v_total_unresolved,
    last_activity_at = greatest(last_activity_at, p_event_at),
    last_event_key = v_event_key,
    updated_at = now()
  where id = v_journey.id
  returning current_attributed_tokens into v_journey_remaining;

  if v_journey_remaining <= 0 then
    select array_cat(
      v_released,
      coalesce(array_agg(wallet order by wallet), '{}')
    ) into v_released
    from public.custody_journey_wallets
    where journey_id = v_journey.id and watch_status = 'active';
    update public.custody_journey_wallets set
      watch_status = 'released',
      released_at = coalesce(released_at, p_event_at),
      release_reason = coalesce(release_reason, 'journey_flat'),
      updated_at = now()
    where journey_id = v_journey.id and watch_status <> 'released';
    update public.custody_journeys set
      status = 'flat', flat_at = p_event_at,
      flat_reason = 'custody_coverage_lost', updated_at = now()
    where id = v_journey.id;
  end if;
  select coalesce(array_agg(wallet order by wallet), '{}') into v_released
  from (select distinct unnest(v_released) as wallet) unique_released;

  update public.custody_journey_events set
    result_journey_status = case when v_journey_remaining <= 0 then 'flat' else 'active' end,
    result_released_wallets = v_released,
    journey_released = v_journey_remaining <= 0
  where id = v_event_id;
  v_result := jsonb_build_object(
    'applied', true, 'duplicate', false, 'payloadMismatch', false,
    'reason', 'partial_unresolved_outflow', 'journeyId', v_journey.id,
    'eventId', v_event_id,
    'journeyStatus', case when v_journey_remaining <= 0 then 'flat' else 'active' end,
    'appliedAmountTokens', v_applied,
    'watchedWallets', array[]::text[], 'releasedWallets', v_released,
    'journeyReleased', v_journey_remaining <= 0
  );
  update public.custody_pending_events set
    status = 'applied', last_retry_at = now(), last_error_code = null,
    journey_id = v_journey.id, event_id = v_event_id,
    result = v_result, updated_at = now()
  where user_id = p_user_id and event_key = v_event_key and status = 'pending';
  return v_result;
end;
$$;


-- Retry durable out-of-order observations after upstream attribution lands.
-- Each result retains its journey owner so a shared wallet can be subscribed
-- or released with correct reference counting.
create or replace function public.replay_custody_pending_events(
  p_user_id uuid,
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_pending public.custody_pending_events%rowtype;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_watched text[] := '{}';
  v_released text[] := '{}';
  v_status text;
  v_reason text;
  v_processed integer := 0;
  v_applied integer := 0;
  v_still_pending integer := 0;
  v_expired integer := 0;
  v_terminal integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_user_id is null or p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'invalid custody pending replay request';
  end if;

  for v_pending in
    select *
    from public.custody_pending_events
    where user_id = p_user_id and status = 'pending' and next_retry_at <= now()
    order by event_at, coalesce(slot, 0), created_at, id
    limit p_limit
    for update skip locked
  loop
    v_processed := v_processed + 1;
    v_result := null;
    v_reason := null;

    if v_pending.expires_at <= now() then
      v_status := 'expired';
      v_reason := 'pending_expired';
      v_expired := v_expired + 1;
      update public.custody_pending_events set
        status = v_status,
        last_retry_at = now(),
        last_error_code = v_reason,
        updated_at = now()
      where id = v_pending.id;
    else
      begin
        if v_pending.event_type = 'CUSTODY_TRANSFER'
           and coalesce((v_pending.payload->>'p_unresolved_outflow')::boolean, false) then
          v_result := public.record_custody_unresolved_outflow(
            (v_pending.payload->>'p_user_id')::uuid,
            v_pending.payload->>'p_token_mint',
            v_pending.payload->>'p_event_key',
            v_pending.payload->>'p_tx_sig',
            (v_pending.payload->>'p_slot')::bigint,
            (v_pending.payload->>'p_event_at')::timestamptz,
            v_pending.payload->>'p_wallet',
            (v_pending.payload->>'p_pre_amount_tokens')::numeric,
            (v_pending.payload->>'p_post_amount_tokens')::numeric,
            v_pending.payload->'p_metadata'
          );
        elsif v_pending.event_type = 'CUSTODY_TRANSFER' then
          v_result := public.record_custody_transfer(
            (v_pending.payload->>'p_user_id')::uuid,
            v_pending.payload->>'p_token_mint',
            v_pending.payload->>'p_event_key',
            v_pending.payload->>'p_tx_sig',
            (v_pending.payload->>'p_slot')::bigint,
            (v_pending.payload->>'p_event_at')::timestamptz,
            v_pending.payload->>'p_source_wallet',
            v_pending.payload->'p_recipients',
            v_pending.payload->'p_metadata'
          );
        elsif v_pending.event_type = 'VERIFIED_CUSTODY_SELL' then
          v_result := public.record_verified_custody_sell(
            (v_pending.payload->>'p_user_id')::uuid,
            v_pending.payload->>'p_token_mint',
            v_pending.payload->>'p_event_key',
            v_pending.payload->>'p_tx_sig',
            (v_pending.payload->>'p_slot')::bigint,
            (v_pending.payload->>'p_event_at')::timestamptz,
            v_pending.payload->>'p_seller_wallet',
            (v_pending.payload->>'p_sold_amount_tokens')::numeric,
            v_pending.payload->'p_metadata'
          );
        else
          v_result := jsonb_build_object(
            'applied', false, 'duplicate', false, 'payloadMismatch', false,
            'reason', 'unsupported_pending_event', 'journeyId', null,
            'eventId', null, 'journeyStatus', null, 'appliedAmountTokens', 0,
            'watchedWallets', array[]::text[],
            'releasedWallets', array[]::text[], 'journeyReleased', false
          );
        end if;

        if coalesce((v_result->>'payloadMismatch')::boolean, false) then
          v_status := 'terminal';
          v_reason := 'payload_mismatch';
          v_terminal := v_terminal + 1;
        elsif (
          coalesce((v_result->>'applied')::boolean, false)
          or (
            coalesce((v_result->>'duplicate')::boolean, false)
            and v_result->>'eventId' is not null
          )
        ) then
          v_status := 'applied';
          v_reason := null;
          v_applied := v_applied + 1;
          select array_cat(
            v_watched,
            coalesce(array_agg(value), '{}')
          ) into v_watched
          from jsonb_array_elements_text(
            coalesce(v_result->'watchedWallets', '[]'::jsonb)
          );
          select array_cat(
            v_released,
            coalesce(array_agg(value), '{}')
          ) into v_released
          from jsonb_array_elements_text(
            coalesce(v_result->'releasedWallets', '[]'::jsonb)
          );
        elsif v_pending.expires_at <= now() then
          v_status := 'expired';
          v_reason := 'pending_expired';
          v_expired := v_expired + 1;
        elsif v_result->>'reason' in (
          'unsupported_pending_event', 'payload_mismatch',
          'predates_attribution_state', 'same_slot_order_unknown',
          'partial_predates_destination_state',
          'partial_same_slot_destination_order_unknown'
        ) then
          v_status := 'terminal';
          v_reason := v_result->>'reason';
          v_terminal := v_terminal + 1;
        else
          v_status := 'pending';
          v_reason := coalesce(v_result->>'reason', 'pending_upstream');
          v_still_pending := v_still_pending + 1;
        end if;

        update public.custody_pending_events set
          status = v_status,
          retry_count = retry_count + 1,
          last_retry_at = now(),
          next_retry_at = now() + make_interval(
            secs => least(300, 2 ^ least(8, retry_count + 1))::double precision
          ),
          last_error_code = v_reason,
          journey_id = case
            when v_result->>'journeyId' is null then journey_id
            else (v_result->>'journeyId')::uuid
          end,
          event_id = case
            when v_result->>'eventId' is null then event_id
            else (v_result->>'eventId')::uuid
          end,
          result = v_result,
          updated_at = now()
        where id = v_pending.id;
      exception when others then
        v_status := case
          when v_pending.expires_at <= now()
          then 'expired' else 'pending'
        end;
        v_reason := 'replay_exception';
        if v_status = 'expired' then
          v_expired := v_expired + 1;
        else
          v_still_pending := v_still_pending + 1;
        end if;
        update public.custody_pending_events set
          status = v_status,
          retry_count = retry_count + 1,
          last_retry_at = now(),
          next_retry_at = now() + interval '5 minutes',
          last_error_code = v_reason,
          updated_at = now()
        where id = v_pending.id;
        v_result := jsonb_build_object(
          'applied', false, 'duplicate', false, 'payloadMismatch', false,
          'reason', v_reason, 'journeyId', v_pending.journey_id,
          'eventId', v_pending.event_id, 'journeyStatus', null,
          'appliedAmountTokens', 0, 'watchedWallets', array[]::text[],
          'releasedWallets', array[]::text[], 'journeyReleased', false
        );
      end;
    end if;

    v_result := coalesce(v_result, jsonb_build_object(
      'applied', false, 'duplicate', false, 'payloadMismatch', false,
      'reason', v_reason, 'journeyId', v_pending.journey_id,
      'eventId', v_pending.event_id, 'journeyStatus', null,
      'appliedAmountTokens', 0, 'watchedWallets', array[]::text[],
      'releasedWallets', array[]::text[], 'journeyReleased', false
    ));
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'pendingId', v_pending.id,
      'eventKey', v_pending.event_key,
      'slot', v_pending.slot,
      'status', v_status,
      'reason', coalesce(v_reason, v_result->>'reason'),
      'journeyId', v_result->'journeyId',
      'eventId', v_result->'eventId',
      'journeyStatus', v_result->'journeyStatus',
      'applied', coalesce((v_result->>'applied')::boolean, false),
      'duplicate', coalesce((v_result->>'duplicate')::boolean, false),
      'payloadMismatch', coalesce((v_result->>'payloadMismatch')::boolean, false),
      'appliedAmountTokens', coalesce((v_result->>'appliedAmountTokens')::numeric, 0),
      'watchedWallets', coalesce(v_result->'watchedWallets', '[]'::jsonb),
      'releasedWallets', coalesce(v_result->'releasedWallets', '[]'::jsonb),
      'journeyReleased', coalesce((v_result->>'journeyReleased')::boolean, false)
    ));
  end loop;

  select coalesce(array_agg(wallet order by wallet), '{}') into v_watched
  from (select distinct unnest(v_watched) as wallet) unique_watched;
  select coalesce(array_agg(wallet order by wallet), '{}') into v_released
  from (select distinct unnest(v_released) as wallet) unique_released;
  return jsonb_build_object(
    'processedCount', v_processed,
    'appliedCount', v_applied,
    'pendingCount', v_still_pending,
    'expiredCount', v_expired,
    'terminalCount', v_terminal,
    'watchedWallets', v_watched,
    'releasedWallets', v_released,
    'results', v_results
  );
end;
$$;

revoke all on function public.record_custody_target_buy(
  uuid, text, text, text, text, bigint, timestamptz, numeric, jsonb
) from public, anon, authenticated;
grant execute on function public.record_custody_target_buy(
  uuid, text, text, text, text, bigint, timestamptz, numeric, jsonb
) to service_role;
revoke all on function public.record_custody_transfer(
  uuid, text, text, text, bigint, timestamptz, text, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.record_custody_transfer(
  uuid, text, text, text, bigint, timestamptz, text, jsonb, jsonb
) to service_role;
revoke all on function public.record_verified_custody_sell(
  uuid, text, text, text, bigint, timestamptz, text, numeric, jsonb
) from public, anon, authenticated;
grant execute on function public.record_verified_custody_sell(
  uuid, text, text, text, bigint, timestamptz, text, numeric, jsonb
) to service_role;
revoke all on function public.record_custody_unresolved_outflow(
  uuid, text, text, text, bigint, timestamptz, text, numeric, numeric, jsonb
) from public, anon, authenticated;
grant execute on function public.record_custody_unresolved_outflow(
  uuid, text, text, text, bigint, timestamptz, text, numeric, numeric, jsonb
) to service_role;
revoke all on function public.replay_custody_pending_events(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.replay_custody_pending_events(uuid, integer)
  to service_role;

grant select on public.custody_journeys, public.custody_journey_wallets,
  public.custody_journey_events, public.custody_wallet_profiles,
  public.custody_rpc_wallet_cursors, public.custody_worker_heartbeat,
  public.custody_pending_events
  to authenticated;
grant select, insert, update on public.custody_journeys,
  public.custody_journey_wallets, public.custody_journey_events,
  public.custody_wallet_profiles, public.custody_rpc_wallet_cursors,
  public.custody_worker_heartbeat, public.custody_pending_events to service_role;

alter table public.custody_journeys enable row level security;
alter table public.custody_journey_wallets enable row level security;
alter table public.custody_journey_events enable row level security;
alter table public.custody_wallet_profiles enable row level security;
alter table public.custody_rpc_wallet_cursors enable row level security;
alter table public.custody_worker_heartbeat enable row level security;
alter table public.custody_pending_events enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'custody_journeys'
      and policyname = 'read own custody journeys'
  ) then
    create policy "read own custody journeys" on public.custody_journeys
      for select to authenticated using (user_id = auth.uid());
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'custody_journey_wallets'
      and policyname = 'read own custody journey wallets'
  ) then
    create policy "read own custody journey wallets" on public.custody_journey_wallets
      for select to authenticated using (user_id = auth.uid());
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'custody_journey_events'
      and policyname = 'read own custody journey events'
  ) then
    create policy "read own custody journey events" on public.custody_journey_events
      for select to authenticated using (user_id = auth.uid());
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'custody_wallet_profiles'
      and policyname = 'read own custody wallet profiles'
  ) then
    create policy "read own custody wallet profiles" on public.custody_wallet_profiles
      for select to authenticated using (user_id = auth.uid());
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'custody_rpc_wallet_cursors'
      and policyname = 'read own custody rpc wallet cursors'
  ) then
    create policy "read own custody rpc wallet cursors"
      on public.custody_rpc_wallet_cursors
      for select to authenticated using (user_id = auth.uid());
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'custody_worker_heartbeat'
      and policyname = 'read own custody worker heartbeat'
  ) then
    create policy "read own custody worker heartbeat"
      on public.custody_worker_heartbeat
      for select to authenticated using (user_id = auth.uid());
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'custody_pending_events'
      and policyname = 'read own custody pending events'
  ) then
    create policy "read own custody pending events"
      on public.custody_pending_events
      for select to authenticated using (user_id = auth.uid());
  end if;
end $$;

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


-- REVIVAL_CAMPAIGN_CANONICAL_MIRROR_BEGIN
-- Revival Campaign tracker — observation-only, shadow-only.
-- The market-cap band is evaluated only when admitting a new seed. An admitted
-- campaign remains tracked after its market cap leaves the configured band.

alter table public.bot_config
  add column if not exists revival_tracker_enabled boolean not null default false,
  add column if not exists revival_market_cap_min_usd numeric not null default 2000,
  add column if not exists revival_market_cap_max_usd numeric not null default 15000;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bot_config'::regclass
      and conname = 'bot_config_revival_market_cap_range_check'
  ) then
    alter table public.bot_config
      add constraint bot_config_revival_market_cap_range_check
      check (
        revival_market_cap_min_usd >= 0
        and revival_market_cap_max_usd >= revival_market_cap_min_usd
      );
  end if;
end $$;

create table if not exists public.revival_strategy_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  version_number integer not null check (version_number > 0),
  strategy_key text not null default 'revival_campaign'
    check (strategy_key = 'revival_campaign'),
  role text not null default 'challenger'
    check (role in ('challenger', 'champion', 'retired')),
  algorithm_version text not null,
  config_hash text not null check (char_length(config_hash) = 64),
  config jsonb not null check (jsonb_typeof(config) = 'object'),
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  retired_at timestamptz,
  unique (user_id, version_number),
  unique (user_id, config_hash)
);

create unique index if not exists revival_strategy_versions_one_champion_idx
  on public.revival_strategy_versions (user_id)
  where role = 'champion' and retired_at is null;

create table if not exists public.revival_campaigns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  strategy_version_id uuid not null references public.revival_strategy_versions(id),
  campaign_key text not null,
  campaign_number integer not null check (campaign_number > 0),
  token_mint text not null,
  symbol text,
  state text not null check (state in (
    'DORMANT_CANDIDATE', 'SEEDED', 'ACCUMULATING', 'ENTRY_READY', 'EXPOSED',
    'RETAIL_IGNITION', 'DISTRIBUTION_RISK', 'CLOSED', 'INVALIDATED', 'COVERAGE_GAP'
  )),
  state_version bigint not null default 1 check (state_version > 0),
  eligibility_status text not null check (
    eligibility_status in ('pending_market_data', 'eligible', 'ineligible')
  ),
  eligibility_reason text not null,
  seed_event_key text not null,
  seed_tx_sig text,
  seed_slot bigint,
  seed_tx_index integer,
  seeded_at timestamptz not null,
  seed_available_at timestamptz not null,
  eligibility_deadline_at timestamptz,
  last_event_key text not null,
  last_event_at timestamptz not null,
  last_available_at timestamptz not null,
  last_market_observed_at timestamptz,
  closed_at timestamptz,
  close_reason text,
  seed_market_cap_usd numeric,
  latest_market_cap_usd numeric,
  seed_price_usd numeric,
  latest_price_usd numeric,
  peak_price_usd numeric,
  trough_price_usd numeric,
  historical_peak_price_usd numeric,
  historical_peak_market_cap_usd numeric,
  drawdown_pct numeric,
  baseline_volume_h1_usd numeric,
  latest_volume_h1_usd numeric,
  baseline_buy_count_h1 integer,
  latest_buy_count_h1 integer,
  seed_active_boosts integer,
  latest_active_boosts integer,
  target_gross_buys_usd numeric not null default 0 check (target_gross_buys_usd >= 0),
  target_gross_sells_usd numeric not null default 0 check (target_gross_sells_usd >= 0),
  target_net_commitment_usd numeric not null default 0 check (target_net_commitment_usd >= 0),
  target_buy_count integer not null default 0 check (target_buy_count >= 0),
  target_sell_count integer not null default 0 check (target_sell_count >= 0),
  target_wallets text[] not null default '{}',
  unique_target_wallet_count integer not null default 0 check (unique_target_wallet_count >= 0),
  accumulation_score numeric not null default 0 check (accumulation_score between 0 and 100),
  ignition_score numeric not null default 0 check (ignition_score between 0 and 100),
  distribution_score numeric not null default 0 check (distribution_score between 0 and 100),
  ignition_streak integer not null default 0 check (ignition_streak >= 0),
  market_data_reliable boolean not null default false,
  target_attribution_reliable boolean not null default false,
  custody_evidence_reliable boolean not null default false,
  coverage_status text not null default 'MISSING'
    check (coverage_status in ('COMPLETE', 'PARTIAL', 'MISSING')),
  entry_ready_at timestamptz,
  ignited_at timestamptz,
  distribution_risk_at timestamptz,
  mfe_pct numeric,
  mae_pct numeric,
  config_snapshot jsonb not null check (jsonb_typeof(config_snapshot) = 'object'),
  engine_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, campaign_key),
  constraint revival_campaigns_user_engine_mint_campaign_number_key
    unique (user_id, engine_version, token_mint, campaign_number)
);

-- Repeatable column guards keep partially applied development installations
-- compatible without rewriting or deleting any campaign evidence.
alter table public.revival_campaigns
  add column if not exists seed_tx_index integer,
  add column if not exists last_market_observed_at timestamptz;

create unique index if not exists revival_campaigns_one_open_mint_engine_idx
  on public.revival_campaigns (user_id, engine_version, token_mint)
  where closed_at is null;
create index if not exists revival_campaigns_dashboard_idx
  on public.revival_campaigns (user_id, last_available_at desc);
create index if not exists revival_campaigns_pending_market_idx
  on public.revival_campaigns (user_id, eligibility_deadline_at)
  where eligibility_status = 'pending_market_data' and closed_at is null;

create table if not exists public.revival_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  strategy_version_id uuid not null references public.revival_strategy_versions(id),
  campaign_id uuid references public.revival_campaigns(id),
  event_key text not null,
  request_fingerprint text not null check (char_length(request_fingerprint) = 64),
  event_type text not null
    check (event_type in ('TARGET_BUY', 'TARGET_SELL', 'MARKET_SNAPSHOT', 'CLOCK_TICK')),
  source text not null check (source in ('rpc', 'market', 'clock')),
  tx_sig text,
  slot bigint,
  tx_index integer,
  event_at timestamptz not null,
  available_at timestamptz not null,
  actor_wallet text,
  token_mint text not null,
  amount_tokens numeric,
  amount_usd numeric,
  price_usd numeric,
  market_cap_usd numeric,
  liquidity_usd numeric,
  classification_reliable boolean not null default false,
  market_data_reliable boolean not null default false,
  historical boolean not null default false,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  conflict_count integer not null default 0 check (conflict_count >= 0),
  last_conflict_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, event_key)
);

create index if not exists revival_events_mint_causal_idx
  on public.revival_events (user_id, token_mint, available_at, event_at, event_key);
create index if not exists revival_events_campaign_time_idx
  on public.revival_events (campaign_id, available_at, event_at);

create table if not exists public.revival_transitions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  strategy_version_id uuid not null references public.revival_strategy_versions(id),
  campaign_id uuid not null references public.revival_campaigns(id),
  transition_key text not null,
  trigger_kind text not null default 'event'
    check (trigger_kind in ('event', 'snapshot', 'timeout')),
  trigger_key text not null,
  from_state text,
  to_state text not null,
  from_state_version bigint not null check (from_state_version >= 0),
  to_state_version bigint not null check (to_state_version > from_state_version),
  reasons text[] not null default '{}',
  metrics jsonb not null default '{}'::jsonb check (jsonb_typeof(metrics) = 'object'),
  occurred_at timestamptz not null,
  available_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  unique (user_id, transition_key),
  unique (campaign_id, to_state_version)
);

create index if not exists revival_transitions_campaign_time_idx
  on public.revival_transitions (campaign_id, available_at, to_state_version);

create table if not exists public.revival_market_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  strategy_version_id uuid not null references public.revival_strategy_versions(id),
  campaign_id uuid references public.revival_campaigns(id),
  snapshot_key text not null,
  request_fingerprint text not null check (char_length(request_fingerprint) = 64),
  provider text not null,
  pair_address text,
  dex_id text,
  market_at timestamptz not null,
  available_at timestamptz not null,
  price_usd numeric,
  market_cap_usd numeric,
  fdv_usd numeric,
  valuation_kind text not null default 'unknown'
    check (valuation_kind in ('market_cap', 'fdv', 'unknown')),
  liquidity_usd numeric,
  volume_m5_usd numeric,
  volume_h1_usd numeric,
  volume_h6_usd numeric,
  volume_h24_usd numeric,
  buys_m5 integer,
  sells_m5 integer,
  buys_h1 integer,
  sells_h1 integer,
  buys_h24 integer,
  sells_h24 integer,
  active_boosts integer,
  reliable boolean not null default false,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  conflict_count integer not null default 0 check (conflict_count >= 0),
  last_conflict_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, snapshot_key)
);

create index if not exists revival_market_snapshots_campaign_time_idx
  on public.revival_market_snapshots (campaign_id, available_at desc);

create table if not exists public.revival_shadow_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  strategy_version_id uuid not null references public.revival_strategy_versions(id),
  campaign_id uuid not null references public.revival_campaigns(id),
  action_key text not null,
  variant_key text not null default 'shadow_v1',
  mode text not null default 'shadow' check (mode = 'shadow'),
  state text not null,
  state_version bigint not null check (state_version > 0),
  action_type text not null check (action_type in (
    'STARTER_ELIGIBLE', 'SCALE_ELIGIBLE', 'STOP_ADDING', 'TAKE_PROFIT', 'EXIT', 'SKIP'
  )),
  decision_at timestamptz not null,
  available_at timestamptz not null,
  source_event_key text not null,
  executable boolean not null default false check (executable = false),
  reason text not null,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  unique (user_id, action_key)
);

create index if not exists revival_shadow_actions_campaign_time_idx
  on public.revival_shadow_actions (campaign_id, decision_at);

create table if not exists public.revival_outcomes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  campaign_id uuid not null references public.revival_campaigns(id),
  strategy_version_id uuid not null references public.revival_strategy_versions(id),
  variant_key text not null,
  outcome_key text not null,
  status text not null check (status in ('resolved', 'invalidated', 'unscorable')),
  resolution_reason text not null,
  entry_at timestamptz,
  ignition_at timestamptz,
  distribution_at timestamptz,
  closed_at timestamptz not null,
  entry_price_usd numeric,
  close_price_usd numeric,
  gross_entry_usd numeric,
  gross_proceeds_usd numeric,
  fees_usd numeric,
  net_pnl_usd numeric,
  pnl_pct numeric,
  mfe_pct numeric,
  mae_pct numeric,
  holding_seconds bigint,
  winner boolean,
  coverage_status text not null check (coverage_status in ('COMPLETE', 'PARTIAL', 'MISSING')),
  market_data_reliable boolean not null default false,
  target_attribution_reliable boolean not null default false,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  resolved_at timestamptz not null default now(),
  unique (user_id, outcome_key),
  unique (campaign_id, strategy_version_id, variant_key)
);

create table if not exists public.revival_rpc_wallet_cursors (
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

create index if not exists revival_rpc_wallet_cursors_health_idx
  on public.revival_rpc_wallet_cursors (user_id, backlog_detected, last_success_at);

create table if not exists public.revival_worker_heartbeat (
  user_id uuid primary key,
  started_at timestamptz not null,
  updated_at timestamptz not null default now(),
  enabled boolean not null default false,
  target_wallet_count integer not null default 0,
  initialized boolean not null default false,
  event_count bigint not null default 0,
  active_campaign_count integer not null default 0,
  pending_market_data_count integer not null default 0,
  last_event_at timestamptz,
  last_market_snapshot_at timestamptz,
  rpc_last_poll_at timestamptz,
  rpc_last_success_at timestamptz,
  rpc_backlog_wallet_count integer not null default 0,
  degraded boolean not null default false,
  last_error_code text
);

alter table public.revival_strategy_versions enable row level security;
alter table public.revival_campaigns enable row level security;
alter table public.revival_events enable row level security;
alter table public.revival_transitions enable row level security;
alter table public.revival_market_snapshots enable row level security;
alter table public.revival_shadow_actions enable row level security;
alter table public.revival_outcomes enable row level security;
alter table public.revival_rpc_wallet_cursors enable row level security;
alter table public.revival_worker_heartbeat enable row level security;

do $$
declare
  table_name text;
  policy_name text;
begin
  foreach table_name in array array[
    'revival_strategy_versions', 'revival_campaigns', 'revival_events',
    'revival_transitions', 'revival_market_snapshots', 'revival_shadow_actions',
    'revival_outcomes', 'revival_rpc_wallet_cursors', 'revival_worker_heartbeat'
  ] loop
    policy_name := 'read own ' || table_name;
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = table_name and policyname = policy_name
    ) then
      execute format(
        'create policy %I on public.%I for select to authenticated using (user_id = auth.uid())',
        policy_name,
        table_name
      );
    end if;
  end loop;
end $$;

revoke all on table
  public.revival_strategy_versions,
  public.revival_campaigns,
  public.revival_events,
  public.revival_transitions,
  public.revival_market_snapshots,
  public.revival_shadow_actions,
  public.revival_outcomes,
  public.revival_rpc_wallet_cursors,
  public.revival_worker_heartbeat
from public, anon, authenticated;

grant select on table
  public.revival_strategy_versions,
  public.revival_campaigns,
  public.revival_events,
  public.revival_transitions,
  public.revival_market_snapshots,
  public.revival_shadow_actions,
  public.revival_outcomes,
  public.revival_rpc_wallet_cursors,
  public.revival_worker_heartbeat
to authenticated;

grant select, insert, update on table
  public.revival_strategy_versions,
  public.revival_campaigns,
  public.revival_events,
  public.revival_transitions,
  public.revival_market_snapshots,
  public.revival_shadow_actions,
  public.revival_outcomes,
  public.revival_rpc_wallet_cursors,
  public.revival_worker_heartbeat
to service_role;

-- No Revival table has a DELETE grant and no row can authorize a transaction.
-- The only persisted action mode is the CHECK-constrained value 'shadow'.
-- REVIVAL_CAMPAIGN_CANONICAL_MIRROR_END
