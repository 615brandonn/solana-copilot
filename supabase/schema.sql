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

-- CUSTODY_BACKLOG_V2_CANONICAL_MIRROR_BEGIN
-- Custody pending-inbox scheduler v2.
--
-- Additive and repeatable. This migration never deletes custody evidence and
-- never changes trading, position, entry, or exit state. It separates runnable
-- replay work from durable observations that are waiting for an exact upstream
-- attribution dependency.

alter table public.custody_pending_events
  add column if not exists queue_state text not null default 'ready',
  add column if not exists last_error_sqlstate text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.custody_pending_events'::regclass
      and conname = 'custody_pending_events_queue_state_check'
  ) then
    alter table public.custody_pending_events
      add constraint custody_pending_events_queue_state_check check (
        queue_state in (
          'ready', 'dormant_scope', 'waiting_dependency',
          'transient_retry', 'resolved'
        )
      );
  end if;
end $$;

-- One-time/repeatable scheduler classification. Evidence and payloads remain
-- untouched. Dependency waits are checked once at expiry unless an exact
-- attribution event wakes them first; unscoped evidence remains durable.
update public.custody_pending_events
set
  queue_state = case
    when status <> 'pending' then 'resolved'
    when last_error_code = 'unscoped' and journey_id is null then 'dormant_scope'
    when last_error_code in (
      'pending_upstream', 'source_not_attributed', 'seller_not_attributed',
      'no_attributed_balance'
    ) then 'waiting_dependency'
    when last_error_code = 'replay_exception' then 'transient_retry'
    when queue_state = 'dormant_scope' then 'dormant_scope'
    when queue_state = 'waiting_dependency' then 'waiting_dependency'
    when queue_state = 'transient_retry' then 'transient_retry'
    else 'ready'
  end,
  next_retry_at = case
    when status <> 'pending' then next_retry_at
    when last_error_code = 'unscoped' and journey_id is null
      then 'infinity'::timestamptz
    when last_error_code in (
      'pending_upstream', 'source_not_attributed', 'seller_not_attributed',
      'no_attributed_balance'
    ) then case
      when expires_at = 'infinity'::timestamptz
        then created_at + interval '24 hours'
      else expires_at
    end
    when queue_state = 'dormant_scope' then 'infinity'::timestamptz
    when queue_state = 'waiting_dependency' then case
      when expires_at = 'infinity'::timestamptz
        then created_at + interval '24 hours'
      else expires_at
    end
    else next_retry_at
  end,
  expires_at = case
    when status = 'pending'
      and last_error_code = 'unscoped'
      and journey_id is null
      then 'infinity'::timestamptz
    when status = 'pending' and last_error_code in (
      'pending_upstream', 'source_not_attributed', 'seller_not_attributed',
      'no_attributed_balance'
    ) and expires_at = 'infinity'::timestamptz
      then created_at + interval '24 hours'
    when status = 'pending' and queue_state = 'dormant_scope'
      then 'infinity'::timestamptz
    when status = 'pending'
      and queue_state = 'waiting_dependency'
      and expires_at = 'infinity'::timestamptz
      then created_at + interval '24 hours'
    else expires_at
  end,
  updated_at = now()
where queue_state is distinct from case
    when status <> 'pending' then 'resolved'
    when last_error_code = 'unscoped' and journey_id is null then 'dormant_scope'
    when last_error_code in (
      'pending_upstream', 'source_not_attributed', 'seller_not_attributed',
      'no_attributed_balance'
    ) then 'waiting_dependency'
    when last_error_code = 'replay_exception' then 'transient_retry'
    when queue_state = 'dormant_scope' then 'dormant_scope'
    when queue_state = 'waiting_dependency' then 'waiting_dependency'
    when queue_state = 'transient_retry' then 'transient_retry'
    else 'ready'
  end
  or (
    status = 'pending'
    and last_error_code = 'unscoped'
    and journey_id is null
    and (
      next_retry_at <> 'infinity'::timestamptz
      or expires_at <> 'infinity'::timestamptz
    )
  )
  or (
    status = 'pending'
    and (
      last_error_code in (
        'pending_upstream', 'source_not_attributed', 'seller_not_attributed',
        'no_attributed_balance'
      )
      or queue_state = 'waiting_dependency'
    )
    and next_retry_at is distinct from expires_at
  )
  or (
    status = 'pending'
    and queue_state = 'dormant_scope'
    and (
      next_retry_at <> 'infinity'::timestamptz
      or expires_at <> 'infinity'::timestamptz
    )
  )
  or (
    status = 'pending'
    and (
      last_error_code in (
        'pending_upstream', 'source_not_attributed', 'seller_not_attributed',
        'no_attributed_balance'
      )
      or queue_state = 'waiting_dependency'
    )
    and expires_at = 'infinity'::timestamptz
  );

-- Only finite, scheduled replay or expiry work belongs in the due index. The
-- large dormant evidence set is deliberately excluded.
create index if not exists custody_pending_events_due_v2_idx
  on public.custody_pending_events (
    user_id, next_retry_at, (slot is null), slot, event_at, created_at, id
  )
  where status = 'pending'
    and queue_state in ('ready', 'waiting_dependency', 'transient_retry')
    and next_retry_at < 'infinity'::timestamptz;

create index if not exists custody_pending_events_wake_v2_idx
  on public.custody_pending_events (
    user_id, token_mint, source_wallet, slot, id
  )
  where (
    status = 'expired'
    or (
      status = 'pending'
      and queue_state in ('dormant_scope', 'waiting_dependency')
    )
  );

create index if not exists custody_pending_events_expiry_v2_idx
  on public.custody_pending_events (user_id, expires_at, id)
  where status = 'pending'
    and queue_state = 'waiting_dependency'
    and expires_at < 'infinity'::timestamptz;

-- Normalize future writes from the v1 record RPCs without changing those RPC
-- signatures. Explicit v2 state transitions win; legacy dependency inserts are
-- parked, and legacy wake updates become immediately runnable.
create or replace function public.normalize_custody_pending_queue_v2()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.status <> 'pending' then
    new.queue_state := 'resolved';
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.last_error_code = 'unscoped' and new.journey_id is null then
      new.queue_state := 'dormant_scope';
    elsif new.last_error_code in (
      'pending_upstream', 'source_not_attributed', 'seller_not_attributed',
      'no_attributed_balance'
    ) then
      new.queue_state := 'waiting_dependency';
    elsif new.last_error_code = 'replay_exception' then
      new.queue_state := 'transient_retry';
    else
      new.queue_state := 'ready';
    end if;
  elsif old.status <> 'pending' and new.status = 'pending' then
    -- A legacy record RPC has reactivated retained evidence.
    new.queue_state := 'ready';
  elsif new.queue_state is not distinct from old.queue_state
        and old.queue_state in ('dormant_scope', 'waiting_dependency')
        and (
          new.next_retry_at < old.next_retry_at
          or (old.journey_id is null and new.journey_id is not null)
          or new.last_error_code = 'dependency_ready'
        ) then
    -- A legacy wake update does not know about queue_state.
    new.queue_state := 'ready';
  end if;

  if new.queue_state = 'dormant_scope' then
    new.next_retry_at := 'infinity'::timestamptz;
    new.expires_at := 'infinity'::timestamptz;
  elsif new.queue_state = 'waiting_dependency' then
    -- No polling loop: the row is woken by attribution or checked once at its
    -- bounded expiry.
    if new.expires_at = 'infinity'::timestamptz then
      new.expires_at := now() + interval '24 hours';
    end if;
    new.next_retry_at := new.expires_at;
  end if;
  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.custody_pending_events'::regclass
      and tgname = 'custody_pending_queue_v2_normalize'
      and not tgisinternal
  ) then
    create trigger custody_pending_queue_v2_normalize
      before insert or update on public.custody_pending_events
      for each row execute function public.normalize_custody_pending_queue_v2();
  end if;
end $$;

-- Wake only evidence whose exact source wallet has just gained positive,
-- watchable attribution for the same user, journey, mint, and chronology.
create or replace function public.wake_custody_pending_dependencies_v2()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_gained_attribution boolean := false;
  v_anchor_slot bigint;
begin
  if tg_op = 'INSERT' then
    v_gained_attribution := new.current_attributed_tokens > 0;
  else
    v_gained_attribution :=
      new.current_attributed_tokens > 0
      and (
        coalesce(old.current_attributed_tokens, 0) <= 0
        or new.current_attributed_tokens > old.current_attributed_tokens
        or new.last_slot is distinct from old.last_slot
        or new.watch_status is distinct from old.watch_status
      );
  end if;

  if not v_gained_attribution or new.watch_status <> 'active' then
    return new;
  end if;
  v_anchor_slot := coalesce(new.last_slot, new.watch_anchor_slot);

  update public.custody_pending_events pending
  set
    status = 'pending',
    queue_state = 'ready',
    next_retry_at = now(),
    last_error_code = 'dependency_ready',
    last_error_sqlstate = null,
    journey_id = new.journey_id,
    expires_at = case
      when pending.expires_at = 'infinity'::timestamptz
        or pending.expires_at <= now()
      then now() + interval '24 hours'
      else pending.expires_at
    end,
    updated_at = now()
  where pending.user_id = new.user_id
    and pending.token_mint = new.token_mint
    and pending.source_wallet = new.wallet
    and pending.status in ('pending', 'expired')
    and (
      pending.status = 'expired'
      or pending.queue_state in ('dormant_scope', 'waiting_dependency')
    )
    and (pending.journey_id is null or pending.journey_id = new.journey_id)
    and (v_anchor_slot is null or pending.slot is null or pending.slot >= v_anchor_slot);

  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.custody_journey_wallets'::regclass
      and tgname = 'custody_pending_queue_v2_wake'
      and not tgisinternal
  ) then
    create trigger custody_pending_queue_v2_wake
      after insert or update of current_attributed_tokens, last_slot, watch_status
      on public.custody_journey_wallets
      for each row execute function public.wake_custody_pending_dependencies_v2();
  end if;
end $$;

-- Replay runnable events only. Expected missing dependencies are parked until
-- an attribution trigger wakes them; only true SQL exceptions use timed retry.
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
  v_queue_state text;
  v_reason text;
  v_processed integer := 0;
  v_applied integer := 0;
  v_still_pending integer := 0;
  v_waiting integer := 0;
  v_retrying integer := 0;
  v_expired integer := 0;
  v_terminal integer := 0;
  v_error_sqlstate text;
  v_retry_seconds double precision;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_user_id is null or p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'invalid custody pending replay request';
  end if;

  -- One chronological replay owner per user prevents concurrent callers from
  -- advancing a later event for the same mint before its upstream dependency.
  if not pg_try_advisory_xact_lock(
    hashtext('custody_pending_replay_v2'),
    hashtext(p_user_id::text)
  ) then
    return jsonb_build_object(
      'schemaVersion', 2, 'busy', true,
      'processedCount', 0, 'appliedCount', 0, 'pendingCount', 0,
      'waitingCount', 0, 'retryingCount', 0,
      'expiredCount', 0, 'terminalCount', 0,
      'watchedWallets', array[]::text[], 'releasedWallets', array[]::text[],
      'results', '[]'::jsonb
    );
  end if;

  for v_pending in
    select *
    from public.custody_pending_events
    where user_id = p_user_id
      and status = 'pending'
      and queue_state in ('ready', 'waiting_dependency', 'transient_retry')
      and next_retry_at <= now()
    order by (slot is null), slot, event_at, created_at, id
    limit p_limit
    for update skip locked
  loop
    v_processed := v_processed + 1;
    v_result := null;
    v_reason := null;
    v_error_sqlstate := null;

    if v_pending.expires_at <= now()
       and v_pending.queue_state <> 'waiting_dependency' then
      v_status := 'expired';
      v_queue_state := 'resolved';
      v_reason := 'pending_expired';
      v_expired := v_expired + 1;
      update public.custody_pending_events set
        status = v_status,
        queue_state = v_queue_state,
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

        v_reason := v_result->>'reason';
        if v_reason = 'pending_upstream' then
          v_reason := case
            when v_pending.event_type = 'VERIFIED_CUSTODY_SELL'
              then 'seller_not_attributed'
            else 'source_not_attributed'
          end;
        end if;
        if coalesce((v_result->>'payloadMismatch')::boolean, false) then
          v_status := 'terminal';
          v_queue_state := 'resolved';
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
          v_queue_state := 'resolved';
          v_reason := null;
          v_applied := v_applied + 1;
          select array_cat(v_watched, coalesce(array_agg(value), '{}'))
          into v_watched
          from jsonb_array_elements_text(
            coalesce(v_result->'watchedWallets', '[]'::jsonb)
          );
          select array_cat(v_released, coalesce(array_agg(value), '{}'))
          into v_released
          from jsonb_array_elements_text(
            coalesce(v_result->'releasedWallets', '[]'::jsonb)
          );
        elsif v_reason in (
          'unsupported_pending_event', 'payload_mismatch', 'non_custody_asset',
          'predates_attribution_state', 'same_slot_order_unknown',
          'partial_predates_destination_state',
          'partial_same_slot_destination_order_unknown'
        ) then
          v_status := 'terminal';
          v_queue_state := 'resolved';
          v_terminal := v_terminal + 1;
        elsif v_pending.expires_at <= now() then
          -- A dependency wait gets one final evidence replay at its deadline.
          -- Only an unresolved result is expired, so evidence that became
          -- attributable despite a missed wake notification is never skipped.
          v_status := 'expired';
          v_queue_state := 'resolved';
          v_reason := 'pending_expired';
          v_expired := v_expired + 1;
        elsif v_reason = 'staged_unscoped' and v_pending.journey_id is null then
          v_status := 'pending';
          v_queue_state := 'dormant_scope';
          v_reason := 'unscoped';
          v_still_pending := v_still_pending + 1;
        else
          -- Missing attribution is not a timed failure. The exact wallet+mint
          -- trigger wakes it, while expires_at provides a bounded final check.
          v_status := 'pending';
          v_queue_state := 'waiting_dependency';
          v_reason := coalesce(v_reason, 'pending_upstream');
          v_still_pending := v_still_pending + 1;
          v_waiting := v_waiting + 1;
        end if;

        update public.custody_pending_events set
          status = v_status,
          queue_state = v_queue_state,
          last_retry_at = now(),
          next_retry_at = case
            when v_queue_state = 'dormant_scope' then 'infinity'::timestamptz
            when v_queue_state = 'waiting_dependency' then expires_at
            else next_retry_at
          end,
          expires_at = case
            when v_queue_state = 'dormant_scope' then 'infinity'::timestamptz
            else expires_at
          end,
          last_error_code = v_reason,
          last_error_sqlstate = null,
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
        get stacked diagnostics
          v_error_sqlstate = returned_sqlstate;
        if v_pending.expires_at <= now() then
          v_status := 'expired';
          v_queue_state := 'resolved';
          v_reason := 'pending_expired';
          v_expired := v_expired + 1;
        else
          v_status := 'pending';
          v_queue_state := 'transient_retry';
          v_reason := 'replay_exception';
          v_retry_seconds := least(
            3600::double precision,
            power(2::double precision, least(12, v_pending.retry_count + 1))
              * (0.8 + random() * 0.4)
          );
          v_still_pending := v_still_pending + 1;
          v_retrying := v_retrying + 1;
        end if;
        update public.custody_pending_events set
          status = v_status,
          queue_state = v_queue_state,
          retry_count = retry_count + 1,
          last_retry_at = now(),
          next_retry_at = case
            when v_queue_state = 'transient_retry'
            then least(
              expires_at,
              now() + make_interval(secs => v_retry_seconds)
            )
            else next_retry_at
          end,
          last_error_code = v_reason,
          last_error_sqlstate = left(v_error_sqlstate, 16),
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
      'queueState', v_queue_state,
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
    'schemaVersion', 2, 'busy', false,
    'processedCount', v_processed,
    'appliedCount', v_applied,
    'pendingCount', v_still_pending,
    'waitingCount', v_waiting,
    'retryingCount', v_retrying,
    'expiredCount', v_expired,
    'terminalCount', v_terminal,
    'watchedWallets', v_watched,
    'releasedWallets', v_released,
    'results', v_results
  );
end;
$$;

-- Cheap operational truth: runnable backlog is separate from dependency waits
-- and durable dormant evidence.
create or replace function public.custody_pending_queue_health(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_user_id is null then
    raise exception 'invalid custody pending queue health request';
  end if;

  select jsonb_build_object(
    'schemaVersion', 2,
    'indexesReady',
      to_regclass('public.custody_pending_events_due_v2_idx') is not null
      and to_regclass('public.custody_pending_events_wake_v2_idx') is not null
      and to_regclass('public.custody_pending_events_expiry_v2_idx') is not null,
    'replayDueCount', count(*) filter (
      where status = 'pending'
        and queue_state in ('ready', 'waiting_dependency', 'transient_retry')
        and next_retry_at <= now()
    ),
    'actionableDueCount', count(*) filter (
      where status = 'pending'
        and queue_state in ('ready', 'transient_retry')
        and next_retry_at <= now()
        and expires_at > now()
    ),
    'scheduledRetryCount', count(*) filter (
      where status = 'pending'
        and queue_state = 'transient_retry'
        and next_retry_at > now()
        and expires_at > now()
    ),
    'waitingDependencyCount', count(*) filter (
      where status = 'pending'
        and queue_state = 'waiting_dependency'
        and expires_at > now()
    ),
    'dormantScopeCount', count(*) filter (
      where status = 'pending' and queue_state = 'dormant_scope'
    ),
    'expiryDueCount', count(*) filter (
      where status = 'pending'
        and queue_state = 'waiting_dependency'
        and expires_at <= now()
    ),
    'appliedCount', count(*) filter (where status = 'applied'),
    'expiredCount', count(*) filter (where status = 'expired'),
    'terminalCount', count(*) filter (where status = 'terminal'),
    'oldestActionableEventAt', min(event_at) filter (
      where status = 'pending'
        and queue_state in ('ready', 'transient_retry')
        and next_retry_at <= now()
        and expires_at > now()
    ),
    'oldestWaitingEventAt', min(event_at) filter (
      where status = 'pending'
        and queue_state = 'waiting_dependency'
        and expires_at > now()
    ),
    'maxRetryCount', coalesce(max(retry_count) filter (where status = 'pending'), 0),
    'totalEvidenceCount', count(*),
    'generatedAt', now()
  ) into v_result
  from public.custody_pending_events
  where user_id = p_user_id;

  return v_result;
end;
$$;

revoke all on function public.replay_custody_pending_events(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.replay_custody_pending_events(uuid, integer)
  to service_role;
revoke all on function public.custody_pending_queue_health(uuid)
  from public, anon, authenticated;
grant execute on function public.custody_pending_queue_health(uuid)
  to service_role;
revoke all on function public.normalize_custody_pending_queue_v2()
  from public, anon, authenticated;
revoke all on function public.wake_custody_pending_dependencies_v2()
  from public, anon, authenticated;
-- CUSTODY_BACKLOG_V2_CANONICAL_MIRROR_END

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
-- SUPPLY_ACCUMULATION_CANONICAL_MIRROR_BEGIN
-- Supply Accumulation automatic entry strategy.
-- Additive and deployment-safe: the strategy defaults OFF. Run with global
-- Entries OFF, deploy the matching worker, run Doctor, then enable explicitly.

alter table public.bot_config
  add column if not exists supply_accumulation_mode_enabled boolean not null default false,
  add column if not exists supply_accumulation_threshold_pct numeric not null default 10,
  add column if not exists supply_accumulation_buy_usd numeric not null default 20,
  add column if not exists supply_accumulation_max_market_cap_usd numeric not null default 15000,
  add column if not exists supply_accumulation_window_seconds integer not null default 600;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bot_config'::regclass
      and conname = 'bot_config_supply_accumulation_values_check'
  ) then
    alter table public.bot_config
      add constraint bot_config_supply_accumulation_values_check check (
        supply_accumulation_threshold_pct between 10 and 20
        and supply_accumulation_buy_usd > 0
        and supply_accumulation_max_market_cap_usd > 0
        and supply_accumulation_max_market_cap_usd <= 15000
        and supply_accumulation_window_seconds between 30 and 3600
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bot_config'::regclass
      and conname = 'bot_config_supply_accumulation_target_check'
  ) then
    alter table public.bot_config
      add constraint bot_config_supply_accumulation_target_check check (
        not supply_accumulation_mode_enabled
        or nullif(btrim(target_wallet), '') is not null
        or coalesce(cardinality(additional_target_wallets), 0) > 0
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bot_config'::regclass
      and conname = 'bot_config_supply_accumulation_exclusive_check'
  ) then
    alter table public.bot_config
      add constraint bot_config_supply_accumulation_exclusive_check check (
        not supply_accumulation_mode_enabled
        or (not conviction_mode_enabled and not coordinated_mode_enabled)
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bot_config'::regclass
      and conname = 'bot_config_supply_accumulation_custody_check'
  ) then
    alter table public.bot_config
      add constraint bot_config_supply_accumulation_custody_check check (
        not supply_accumulation_mode_enabled or custody_journey_enabled
      );
  end if;
end $$;

-- Nullable recovery metadata is additive: existing durable entry claims remain
-- byte-for-byte untouched. Supply entries use entry_mode='regular' and identify
-- their recovery contract independently with entry_strategy='supply_accumulation'.
alter table public.entry_signal_claims
  add column if not exists entry_strategy text,
  add column if not exists source_slot bigint,
  add column if not exists token_decimals integer,
  add column if not exists contributing_wallets text[],
  add column if not exists planned_buy_usd numeric,
  add column if not exists last_valid_block_height bigint;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.entry_signal_claims'::regclass
      and conname = 'entry_signal_claims_entry_strategy_check'
  ) then
    alter table public.entry_signal_claims
      add constraint entry_signal_claims_entry_strategy_check check (
        entry_strategy is null
        or entry_strategy in ('supply_accumulation', 'regular', 'coordinated', 'conviction')
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.entry_signal_claims'::regclass
      and conname = 'entry_signal_claims_token_decimals_check'
  ) then
    alter table public.entry_signal_claims
      add constraint entry_signal_claims_token_decimals_check check (
        token_decimals is null or token_decimals between 0 and 18
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.entry_signal_claims'::regclass
      and conname = 'entry_signal_claims_planned_buy_usd_check'
  ) then
    alter table public.entry_signal_claims
      add constraint entry_signal_claims_planned_buy_usd_check check (
        planned_buy_usd is null or planned_buy_usd > 0
      );
  end if;
end $$;

-- Every existing exit must remain usable by a standard position opened by
-- this strategy. Preflight the current rows, then bring the durable-claim
-- constraint in sync with the worker's complete SellTriggerKind union.
do $$
begin
  if to_regclass('public.sell_signal_claims') is not null then
    if exists (
      select 1 from public.sell_signal_claims
      where trigger_kind not in (
        'direct_target_sell', 'terminal_outflow', 'target_terminal_outflow',
        'take_profit', 'stop_loss', 'target_inactivity',
        'distinct_follower', 'proportional_follower', 'crew_wallet',
        'trailing_stop', 'mirror_custody_sell'
      )
    ) then
      raise exception 'sell_signal_claims contains an unknown trigger kind';
    end if;

    alter table public.sell_signal_claims
      drop constraint if exists sell_signal_claims_trigger_kind_check;
    alter table public.sell_signal_claims
      add constraint sell_signal_claims_trigger_kind_check check (trigger_kind in (
        'direct_target_sell', 'terminal_outflow', 'target_terminal_outflow',
        'take_profit', 'stop_loss', 'target_inactivity',
        'distinct_follower', 'proportional_follower', 'crew_wallet',
        'trailing_stop', 'mirror_custody_sell'
      ));
  end if;
end $$;

-- Raw integer amounts are retained as numeric(78,0); JavaScript never needs to
-- round token supply or acquired amounts to decide whether a threshold crossed.
create table if not exists public.supply_accumulation_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  event_key text not null check (char_length(btrim(event_key)) > 0),
  request_fingerprint text not null check (char_length(request_fingerprint) = 64),
  tx_sig text not null check (char_length(btrim(tx_sig)) > 0),
  slot bigint not null check (slot >= 0),
  event_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  target_wallet text not null check (char_length(btrim(target_wallet)) > 0),
  token_mint text not null check (char_length(btrim(token_mint)) > 0),
  side text not null check (side in ('buy', 'sell')),
  amount_raw numeric(78, 0) not null check (amount_raw > 0),
  total_supply_raw numeric(78, 0) not null check (total_supply_raw > 0),
  decimals integer not null check (decimals between 0 and 18),
  market_cap_usd numeric check (market_cap_usd is null or market_cap_usd > 0),
  valuation_slot bigint check (valuation_slot is null or valuation_slot >= 0),
  market_data_reliable boolean not null default false,
  is_pump_fun boolean not null default false,
  classification_reliable boolean not null default false,
  quarantined boolean not null default false,
  conflict_count integer not null default 0 check (conflict_count >= 0),
  last_conflict_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  check (
    not market_data_reliable
    or (market_cap_usd is not null and valuation_slot is not null)
  ),
  unique (user_id, event_key)
);

create index if not exists supply_accumulation_events_window_idx
  on public.supply_accumulation_events (user_id, token_mint, event_at desc, slot desc);

create table if not exists public.supply_accumulation_state (
  user_id uuid not null,
  token_mint text not null,
  window_seconds integer not null check (window_seconds between 30 and 3600),
  as_of timestamptz not null,
  window_started_at timestamptz not null,
  total_supply_raw numeric(78, 0),
  decimals integer check (decimals is null or decimals between 0 and 18),
  gross_buy_raw numeric(78, 0) not null default 0 check (gross_buy_raw >= 0),
  gross_sell_raw numeric(78, 0) not null default 0 check (gross_sell_raw >= 0),
  net_acquired_raw numeric(78, 0) not null default 0 check (net_acquired_raw >= 0),
  net_supply_bps numeric not null default 0 check (net_supply_bps >= 0),
  buy_count integer not null default 0 check (buy_count >= 0),
  sell_count integer not null default 0 check (sell_count >= 0),
  root_wallets text[] not null default '{}',
  last_event_key text,
  last_event_at timestamptz,
  last_event_slot bigint,
  last_event_side text check (last_event_side is null or last_event_side in ('buy', 'sell')),
  latest_market_cap_usd numeric,
  valuation_slot bigint,
  market_data_reliable boolean not null default false,
  pump_fun_verified boolean not null default false,
  classification_reliable boolean not null default false,
  direct_settlement_seen boolean not null default false,
  payload_conflict boolean not null default false,
  data_reliable boolean not null default false,
  threshold_pct numeric not null check (threshold_pct between 10 and 20),
  threshold_reached boolean not null default false,
  max_market_cap_usd numeric not null check (
    max_market_cap_usd > 0 and max_market_cap_usd <= 15000
  ),
  under_market_cap boolean not null default false,
  entry_ready boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, token_mint)
);

alter table public.supply_accumulation_state
  add column if not exists direct_settlement_seen boolean not null default false;

create index if not exists supply_accumulation_state_ready_idx
  on public.supply_accumulation_state (user_id, entry_ready, updated_at desc);

create or replace function public.get_supply_accumulation_state(
  p_user_id uuid,
  p_token_mint text,
  p_as_of timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_mint text := btrim(coalesce(p_token_mint, ''));
  v_mode_enabled boolean := false;
  v_threshold_pct numeric := 10;
  v_max_market_cap_usd numeric := 15000;
  v_window_seconds integer := 600;
  v_window_started_at timestamptz;
  v_targets text[] := array[]::text[];
  v_relevant_count integer := 0;
  v_usable_count integer := 0;
  v_buy_count integer := 0;
  v_sell_count integer := 0;
  v_supply_count integer := 0;
  v_decimals_count integer := 0;
  v_total_supply_raw numeric(78, 0);
  v_decimals integer;
  v_gross_buy_raw numeric(78, 0) := 0;
  v_gross_sell_raw numeric(78, 0) := 0;
  v_net_acquired_raw numeric(78, 0) := 0;
  v_net_supply_bps numeric := 0;
  v_root_wallets text[] := array[]::text[];
  v_last_event_key text;
  v_last_event_at timestamptz;
  v_last_event_slot bigint;
  v_last_event_side text;
  v_max_slot_has_sell boolean := false;
  v_latest_market_cap_usd numeric;
  v_valuation_slot bigint;
  v_latest_market_reliable boolean := false;
  v_market_data_reliable boolean := false;
  v_pump_fun_verified boolean := false;
  v_classification_reliable boolean := false;
  v_direct_settlement_seen boolean := false;
  v_payload_conflict boolean := false;
  v_data_reliable boolean := false;
  v_threshold_reached boolean := false;
  v_under_market_cap boolean := false;
  v_entry_ready boolean := false;
  v_reason text := 'state_ready';
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'service_role is required for supply accumulation state';
  end if;

  if p_user_id is null or v_mint = '' or p_as_of is null then
    raise exception 'supply accumulation state requires user, mint, and as-of time';
  end if;

  select
    supply_accumulation_mode_enabled,
    supply_accumulation_threshold_pct,
    supply_accumulation_max_market_cap_usd,
    supply_accumulation_window_seconds,
    array(
      select distinct wallet
      from unnest(
        array_remove(
          array_prepend(nullif(btrim(target_wallet), ''), additional_target_wallets),
          null
        )
      ) as configured(wallet)
      where nullif(btrim(wallet), '') is not null
      order by wallet
    )
  into
    v_mode_enabled,
    v_threshold_pct,
    v_max_market_cap_usd,
    v_window_seconds,
    v_targets
  from public.bot_config
  where user_id = p_user_id;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'reason', 'config_not_found',
      'userId', p_user_id::text,
      'tokenMint', v_mint,
      'modeEnabled', false,
      'windowSeconds', 600,
      'asOf', p_as_of,
      'windowStartedAt', p_as_of - interval '600 seconds',
      'totalSupplyRaw', null,
      'decimals', null,
      'grossBuyRaw', '0',
      'grossSellRaw', '0',
      'netAcquiredRaw', '0',
      'netSupplyBps', 0,
      'netSupplyPct', 0,
      'buyCount', 0,
      'sellCount', 0,
      'rootWallets', to_jsonb(array[]::text[]),
      'lastEventKey', null,
      'lastEventAt', null,
      'lastEventSlot', null,
      'latestMarketCapUsd', null,
      'valuationSlot', null,
      'marketDataReliable', false,
      'pumpFunVerified', false,
      'classificationReliable', false,
      'directSettlementSeen', false,
      'payloadConflict', false,
      'dataReliable', false,
      'thresholdPct', 10,
      'thresholdReached', false,
      'maxMarketCapUsd', 15000,
      'underMarketCap', false,
      'entryReady', false
    );
  end if;

  if v_threshold_pct < 10 or v_threshold_pct > 20
     or v_max_market_cap_usd <= 0 or v_max_market_cap_usd > 15000
     or v_window_seconds < 30 or v_window_seconds > 3600 then
    raise exception 'supply accumulation config is outside its safety bounds';
  end if;

  v_window_started_at := p_as_of - make_interval(secs => v_window_seconds);

  with relevant as (
    select *
    from public.supply_accumulation_events e
    where e.user_id = p_user_id
      and e.token_mint = v_mint
      and e.target_wallet = any(v_targets)
      and e.event_at >= v_window_started_at
      and e.event_at <= p_as_of
  ), usable as (
    select * from relevant
    where not quarantined and classification_reliable and is_pump_fun
  )
  select
    (select count(*)::integer from relevant),
    (select count(*)::integer from usable),
    (select count(*)::integer from usable where side = 'buy'),
    (select count(*)::integer from usable where side = 'sell'),
    (select count(distinct total_supply_raw)::integer from usable),
    (select count(distinct decimals)::integer from usable),
    (select max(total_supply_raw) from usable),
    (select max(decimals) from usable),
    coalesce((select sum(amount_raw) from usable where side = 'buy'), 0),
    coalesce((select sum(amount_raw) from usable where side = 'sell'), 0),
    coalesce((select bool_and(is_pump_fun) from relevant where not quarantined), false),
    coalesce((select bool_and(classification_reliable) from relevant where not quarantined), false),
    exists(select 1 from usable where metadata @> '{"grossForwarded": true}'::jsonb),
    exists(select 1 from relevant where quarantined),
    coalesce((select array_agg(distinct target_wallet order by target_wallet) from usable), '{}')
  into
    v_relevant_count,
    v_usable_count,
    v_buy_count,
    v_sell_count,
    v_supply_count,
    v_decimals_count,
    v_total_supply_raw,
    v_decimals,
    v_gross_buy_raw,
    v_gross_sell_raw,
    v_pump_fun_verified,
    v_classification_reliable,
    v_direct_settlement_seen,
    v_payload_conflict,
    v_root_wallets;

  select max(slot)
  into v_last_event_slot
  from public.supply_accumulation_events e
  where e.user_id = p_user_id
    and e.token_mint = v_mint
    and e.target_wallet = any(v_targets)
    and e.event_at >= v_window_started_at
    and e.event_at <= p_as_of
    and not e.quarantined
    and e.classification_reliable
    and e.is_pump_fun;

  if v_last_event_slot is not null then
    select exists (
      select 1
      from public.supply_accumulation_events e
      where e.user_id = p_user_id
        and e.token_mint = v_mint
        and e.target_wallet = any(v_targets)
        and e.event_at >= v_window_started_at
        and e.event_at <= p_as_of
        and e.slot = v_last_event_slot
        and e.side = 'sell'
        and not e.quarantined
        and e.classification_reliable
        and e.is_pump_fun
    ) into v_max_slot_has_sell;
    v_last_event_side := case when v_max_slot_has_sell then 'sell' else 'buy' end;

    select event_key, event_at
    into v_last_event_key, v_last_event_at
    from public.supply_accumulation_events e
    where e.user_id = p_user_id
      and e.token_mint = v_mint
      and e.target_wallet = any(v_targets)
      and e.event_at >= v_window_started_at
      and e.event_at <= p_as_of
      and e.slot = v_last_event_slot
      and e.side = v_last_event_side
      and not e.quarantined
      and e.classification_reliable
      and e.is_pump_fun
    order by event_at desc, id desc
    limit 1;
  end if;

  select market_cap_usd, valuation_slot, market_data_reliable
  into v_latest_market_cap_usd, v_valuation_slot, v_latest_market_reliable
  from public.supply_accumulation_events e
  where e.user_id = p_user_id
    and e.token_mint = v_mint
    and e.target_wallet = any(v_targets)
    and e.event_at >= v_window_started_at
    and e.event_at <= p_as_of
    and e.side = 'buy'
    and not e.quarantined
    and e.classification_reliable
    and e.is_pump_fun
  order by valuation_slot desc nulls last, slot desc, event_at desc, id desc
  limit 1;

  v_net_acquired_raw := greatest(0, v_gross_buy_raw - v_gross_sell_raw);
  if v_total_supply_raw is not null and v_total_supply_raw > 0 then
    v_net_supply_bps := (v_net_acquired_raw * 10000) / v_total_supply_raw;
  end if;
  v_market_data_reliable := coalesce(v_latest_market_reliable, false)
    and v_latest_market_cap_usd is not null;
  v_data_reliable := v_relevant_count > 0
    and v_usable_count = v_relevant_count
    and v_supply_count = 1
    and v_decimals_count = 1
    and v_total_supply_raw is not null
    and v_total_supply_raw > 0
    and v_net_acquired_raw <= v_total_supply_raw
    and v_pump_fun_verified
    and v_classification_reliable
    and not v_payload_conflict;
  v_threshold_reached := v_data_reliable
    and (v_net_supply_bps / 100) >= v_threshold_pct;
  v_under_market_cap := v_market_data_reliable
    and v_latest_market_cap_usd < v_max_market_cap_usd;
  v_entry_ready := v_mode_enabled
    and v_data_reliable
    and v_threshold_reached
    and v_under_market_cap
    and v_last_event_side = 'buy';

  v_reason := case
    when not v_mode_enabled then 'mode_disabled'
    when v_payload_conflict then 'payload_conflict'
    when v_relevant_count = 0 then 'no_events_in_window'
    when not v_classification_reliable then 'classification_unreliable'
    when not v_pump_fun_verified then 'not_verified_pump_fun'
    when v_supply_count <> 1 or v_decimals_count <> 1 then 'supply_or_decimals_inconsistent'
    when v_net_acquired_raw > coalesce(v_total_supply_raw, 0) then 'net_supply_exceeds_total'
    when not v_market_data_reliable then 'market_data_unreliable'
    when not v_threshold_reached then 'threshold_not_reached'
    when not v_under_market_cap then 'market_cap_not_under_ceiling'
    when v_last_event_side <> 'buy' then 'latest_event_not_buy'
    else 'entry_ready'
  end;

  insert into public.supply_accumulation_state (
    user_id, token_mint, window_seconds, as_of, window_started_at,
    total_supply_raw, decimals, gross_buy_raw, gross_sell_raw, net_acquired_raw,
    net_supply_bps, buy_count, sell_count, root_wallets, last_event_key,
    last_event_at, last_event_slot, last_event_side, latest_market_cap_usd,
    valuation_slot, market_data_reliable, pump_fun_verified,
    classification_reliable, direct_settlement_seen, payload_conflict,
    data_reliable, threshold_pct,
    threshold_reached, max_market_cap_usd, under_market_cap, entry_ready, updated_at
  ) values (
    p_user_id, v_mint, v_window_seconds, p_as_of, v_window_started_at,
    v_total_supply_raw, v_decimals, v_gross_buy_raw, v_gross_sell_raw, v_net_acquired_raw,
    v_net_supply_bps, v_buy_count, v_sell_count, v_root_wallets, v_last_event_key,
    v_last_event_at, v_last_event_slot, v_last_event_side, v_latest_market_cap_usd,
    v_valuation_slot, v_market_data_reliable, v_pump_fun_verified,
    v_classification_reliable, v_direct_settlement_seen, v_payload_conflict,
    v_data_reliable, v_threshold_pct,
    v_threshold_reached, v_max_market_cap_usd, v_under_market_cap, v_entry_ready, now()
  )
  on conflict (user_id, token_mint) do update set
    window_seconds = excluded.window_seconds,
    as_of = excluded.as_of,
    window_started_at = excluded.window_started_at,
    total_supply_raw = excluded.total_supply_raw,
    decimals = excluded.decimals,
    gross_buy_raw = excluded.gross_buy_raw,
    gross_sell_raw = excluded.gross_sell_raw,
    net_acquired_raw = excluded.net_acquired_raw,
    net_supply_bps = excluded.net_supply_bps,
    buy_count = excluded.buy_count,
    sell_count = excluded.sell_count,
    root_wallets = excluded.root_wallets,
    last_event_key = excluded.last_event_key,
    last_event_at = excluded.last_event_at,
    last_event_slot = excluded.last_event_slot,
    last_event_side = excluded.last_event_side,
    latest_market_cap_usd = excluded.latest_market_cap_usd,
    valuation_slot = excluded.valuation_slot,
    market_data_reliable = excluded.market_data_reliable,
    pump_fun_verified = excluded.pump_fun_verified,
    classification_reliable = excluded.classification_reliable,
    direct_settlement_seen = excluded.direct_settlement_seen,
    payload_conflict = excluded.payload_conflict,
    data_reliable = excluded.data_reliable,
    threshold_pct = excluded.threshold_pct,
    threshold_reached = excluded.threshold_reached,
    max_market_cap_usd = excluded.max_market_cap_usd,
    under_market_cap = excluded.under_market_cap,
    entry_ready = excluded.entry_ready,
    updated_at = excluded.updated_at
  where excluded.as_of >= public.supply_accumulation_state.as_of;

  return jsonb_build_object(
    'ok', true,
    'reason', v_reason,
    'userId', p_user_id::text,
    'tokenMint', v_mint,
    'modeEnabled', v_mode_enabled,
    'windowSeconds', v_window_seconds,
    'asOf', p_as_of,
    'windowStartedAt', v_window_started_at,
    'totalSupplyRaw', case when v_total_supply_raw is null then null else v_total_supply_raw::text end,
    'decimals', v_decimals,
    'grossBuyRaw', v_gross_buy_raw::text,
    'grossSellRaw', v_gross_sell_raw::text,
    'netAcquiredRaw', v_net_acquired_raw::text,
    'netSupplyBps', v_net_supply_bps,
    'netSupplyPct', v_net_supply_bps / 100,
    'buyCount', v_buy_count,
    'sellCount', v_sell_count,
    'rootWallets', to_jsonb(v_root_wallets),
    'lastEventKey', v_last_event_key,
    'lastEventAt', v_last_event_at,
    'lastEventSlot', case when v_last_event_slot is null then null else v_last_event_slot::text end,
    'latestMarketCapUsd', v_latest_market_cap_usd,
    'valuationSlot', case when v_valuation_slot is null then null else v_valuation_slot::text end,
    'marketDataReliable', v_market_data_reliable,
    'pumpFunVerified', v_pump_fun_verified,
    'classificationReliable', v_classification_reliable,
    'directSettlementSeen', v_direct_settlement_seen,
    'payloadConflict', v_payload_conflict,
    'dataReliable', v_data_reliable,
    'thresholdPct', v_threshold_pct,
    'thresholdReached', v_threshold_reached,
    'maxMarketCapUsd', v_max_market_cap_usd,
    'underMarketCap', v_under_market_cap,
    'entryReady', v_entry_ready
  );
end;
$$;

create or replace function public.record_supply_accumulation_event(
  p_user_id uuid,
  p_event_key text,
  p_tx_sig text,
  p_slot bigint,
  p_event_at timestamptz,
  p_target_wallet text,
  p_token_mint text,
  p_side text,
  p_amount_raw text,
  p_total_supply_raw text,
  p_decimals integer,
  p_market_cap_usd numeric,
  p_valuation_slot bigint,
  p_market_data_reliable boolean,
  p_is_pump_fun boolean,
  p_classification_reliable boolean,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_event_key text := btrim(coalesce(p_event_key, ''));
  v_tx_sig text := btrim(coalesce(p_tx_sig, ''));
  v_target text := btrim(coalesce(p_target_wallet, ''));
  v_mint text := btrim(coalesce(p_token_mint, ''));
  v_side text := lower(btrim(coalesce(p_side, '')));
  v_amount_raw numeric(78, 0);
  v_total_supply_raw numeric(78, 0);
  v_fingerprint text;
  v_mode_enabled boolean;
  v_target_configured boolean := false;
  v_existing public.supply_accumulation_events%rowtype;
  v_event_id uuid;
  v_state jsonb;
  v_enriched boolean := false;
  v_supply_mismatch boolean := false;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'service_role is required to record supply accumulation events';
  end if;

  if p_user_id is null or v_event_key = '' or v_tx_sig = '' or v_target = '' or v_mint = '' then
    raise exception 'supply accumulation event identity is incomplete';
  end if;
  if p_slot is null or p_slot < 0 or p_event_at is null then
    raise exception 'supply accumulation event chain position is invalid';
  end if;
  if v_side not in ('buy', 'sell') then
    raise exception 'supply accumulation event side is invalid';
  end if;
  if coalesce(p_amount_raw, '') !~ '^[0-9]+$'
     or coalesce(p_total_supply_raw, '') !~ '^[0-9]+$' then
    raise exception 'supply accumulation raw values must be unsigned integer strings';
  end if;
  v_amount_raw := p_amount_raw::numeric(78, 0);
  v_total_supply_raw := p_total_supply_raw::numeric(78, 0);
  if v_amount_raw <= 0 or v_total_supply_raw <= 0 or v_amount_raw > v_total_supply_raw then
    raise exception 'supply accumulation raw values are outside supply bounds';
  end if;
  if p_decimals is null or p_decimals < 0 or p_decimals > 18 then
    raise exception 'supply accumulation decimals are invalid';
  end if;
  if p_market_cap_usd is not null and p_market_cap_usd <= 0 then
    raise exception 'supply accumulation market cap is invalid';
  end if;
  if p_market_data_reliable is true
     and (p_market_cap_usd is null or p_valuation_slot is null) then
    raise exception 'reliable market data requires market cap and valuation slot';
  end if;
  if p_valuation_slot is not null and p_valuation_slot < 0 then
    raise exception 'supply accumulation valuation slot is invalid';
  end if;
  if p_market_data_reliable is null or p_is_pump_fun is null
     or p_classification_reliable is null then
    raise exception 'supply accumulation evidence flags are required';
  end if;
  if p_metadata is null or jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'supply accumulation metadata must be an object';
  end if;

  select
    supply_accumulation_mode_enabled,
    v_target = any(
      array_remove(
        array_prepend(nullif(btrim(target_wallet), ''), additional_target_wallets),
        null
      )
    )
  into v_mode_enabled, v_target_configured
  from public.bot_config
  where user_id = p_user_id;

  if not found then
    v_state := public.get_supply_accumulation_state(p_user_id, v_mint, p_event_at);
    return jsonb_build_object(
      'applied', false, 'duplicate', false, 'payloadMismatch', false,
      'reason', 'config_not_found', 'eventId', null, 'state', v_state
    );
  end if;
  if not v_mode_enabled then
    v_state := public.get_supply_accumulation_state(p_user_id, v_mint, p_event_at);
    return jsonb_build_object(
      'applied', false, 'duplicate', false, 'payloadMismatch', false,
      'reason', 'mode_disabled', 'eventId', null, 'state', v_state
    );
  end if;
  if not v_target_configured then
    v_state := public.get_supply_accumulation_state(p_user_id, v_mint, p_event_at);
    return jsonb_build_object(
      'applied', false, 'duplicate', false, 'payloadMismatch', false,
      'reason', 'target_not_configured', 'eventId', null, 'state', v_state
    );
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(v_mint));
  v_fingerprint := encode(extensions.digest(jsonb_build_object(
    'txSig', v_tx_sig,
    'slot', p_slot,
    'targetWallet', v_target,
    'tokenMint', v_mint,
    'side', v_side,
    'amountRaw', v_amount_raw::text,
    'totalSupplyRaw', v_total_supply_raw::text,
    'decimals', p_decimals
  )::text, 'sha256'), 'hex');

  select * into v_existing
  from public.supply_accumulation_events
  where user_id = p_user_id and event_key = v_event_key
  for update;

  if found then
    if v_existing.request_fingerprint <> v_fingerprint then
      update public.supply_accumulation_events set
        quarantined = true,
        conflict_count = conflict_count + 1,
        last_conflict_at = now(),
        metadata = metadata || jsonb_build_object(
          'payloadConflictObserved', true,
          'payloadConflictObservedAt', now()
        )
      where id = v_existing.id;
      v_state := public.get_supply_accumulation_state(p_user_id, v_mint, p_event_at);
      return jsonb_build_object(
        'applied', false, 'duplicate', true, 'payloadMismatch', true,
        'reason', 'payload_mismatch', 'eventId', v_existing.id::text, 'state', v_state
      );
    end if;

    v_enriched := p_market_data_reliable
      and (not v_existing.market_data_reliable or v_existing.market_cap_usd is null);
    update public.supply_accumulation_events set
      market_cap_usd = case when v_enriched then p_market_cap_usd else market_cap_usd end,
      valuation_slot = case when v_enriched then p_valuation_slot else valuation_slot end,
      market_data_reliable = market_data_reliable or v_enriched,
      metadata = case
        when metadata @> '{"grossForwarded": true}'::jsonb
          or p_metadata @> '{"grossForwarded": true}'::jsonb
        then metadata || p_metadata || '{"grossForwarded": true}'::jsonb
        else metadata || p_metadata
      end
    where id = v_existing.id;
    v_state := public.get_supply_accumulation_state(p_user_id, v_mint, p_event_at);
    return jsonb_build_object(
      'applied', false, 'duplicate', true, 'payloadMismatch', false,
      'reason', case when v_enriched then 'duplicate_enriched' else 'duplicate' end,
      'eventId', v_existing.id::text, 'state', v_state
    );
  end if;

  select exists (
    select 1
    from public.supply_accumulation_events e
    where e.user_id = p_user_id
      and e.token_mint = v_mint
      and not e.quarantined
      and (
        e.total_supply_raw <> v_total_supply_raw
        or e.decimals <> p_decimals
      )
  ) into v_supply_mismatch;

  insert into public.supply_accumulation_events (
    user_id, event_key, request_fingerprint, tx_sig, slot, event_at,
    target_wallet, token_mint, side, amount_raw, total_supply_raw, decimals,
    market_cap_usd, valuation_slot, market_data_reliable, is_pump_fun,
    classification_reliable, quarantined, conflict_count, last_conflict_at, metadata
  ) values (
    p_user_id, v_event_key, v_fingerprint, v_tx_sig, p_slot, p_event_at,
    v_target, v_mint, v_side, v_amount_raw, v_total_supply_raw, p_decimals,
    p_market_cap_usd, p_valuation_slot, p_market_data_reliable, p_is_pump_fun,
    p_classification_reliable, v_supply_mismatch,
    case when v_supply_mismatch then 1 else 0 end,
    case when v_supply_mismatch then now() else null end,
    case when v_supply_mismatch then
      p_metadata || jsonb_build_object(
        'supplyEvidenceConflict', true,
        'supplyEvidenceConflictObservedAt', now()
      )
    else p_metadata end
  )
  returning id into v_event_id;

  v_state := public.get_supply_accumulation_state(p_user_id, v_mint, p_event_at);
  return jsonb_build_object(
    'applied', not v_supply_mismatch, 'duplicate', false, 'payloadMismatch', false,
    'reason', case
      when v_supply_mismatch then 'supply_or_decimals_mismatch'
      when p_classification_reliable and p_is_pump_fun then 'recorded'
      else 'unreliable_evidence_recorded'
    end,
    'eventId', v_event_id::text,
    'state', v_state
  );
end;
$$;

-- One database snapshot gates every Supply Accumulation entry against the
-- observer's live health and the complete same-window custody cohort. The
-- advisory lock matches custody writers for this user/mint, so a write cannot
-- interleave between the trigger proof and distribution checks.
create index if not exists custody_journey_events_supply_gate_idx
  on public.custody_journey_events (
    user_id, tx_sig, slot, source_wallet, journey_id
  ) where event_type = 'VERIFIED_TARGET_BUY';

create or replace function public.check_supply_accumulation_custody_gate(
  p_user_id uuid,
  p_token_mint text,
  p_window_started_at timestamptz,
  p_trigger_tx_sig text,
  p_trigger_slot bigint,
  p_target_wallet text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_mint text := btrim(coalesce(p_token_mint, ''));
  v_tx_sig text := btrim(coalesce(p_trigger_tx_sig, ''));
  v_target text := btrim(coalesce(p_target_wallet, ''));
  v_reason text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'service_role is required for the supply accumulation custody gate';
  end if;

  if p_user_id is null
     or v_mint = ''
     or p_window_started_at is null
     or p_window_started_at > now()
     or v_tx_sig = ''
     or p_trigger_slot is null
     or p_trigger_slot < 0
     or v_target = '' then
    return jsonb_build_object('safe', false, 'reason', 'invalid_request');
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(v_mint));

  with config as materialized (
    select custody_journey_enabled
    from public.bot_config
    where user_id = p_user_id
  ), heartbeat as materialized (
    select *
    from public.custody_worker_heartbeat
    where user_id = p_user_id
  ), window_journeys as materialized (
    select j.*
    from public.custody_journeys j
    where j.user_id = p_user_id
      and j.token_mint = v_mint
      and j.started_at <= now()
      and j.last_activity_at >= p_window_started_at
  ), facts as (
    select
      exists(select 1 from config) as config_exists,
      coalesce((select custody_journey_enabled from config), false) as config_enabled,
      exists(select 1 from heartbeat) as heartbeat_exists,
      coalesce((select enabled from heartbeat), false) as heartbeat_enabled,
      coalesce((select not degraded from heartbeat), false) as heartbeat_not_degraded,
      coalesce((
        select updated_at >= now() - interval '60 seconds' and updated_at <= now()
        from heartbeat
      ), false) as heartbeat_fresh,
      coalesce((
        select rpc_last_success_at is not null
          and rpc_last_success_at >= now() - interval '60 seconds'
          and rpc_last_success_at <= now()
        from heartbeat
      ), false) as rpc_fresh,
      coalesce((select rpc_backlog_wallet_count = 0 from heartbeat), false)
        and not exists (
          select 1
          from public.custody_rpc_wallet_cursors c
          where c.user_id = p_user_id and c.backlog_detected
        ) as backlog_clear,
      exists (
        select 1
        from public.custody_journey_events e
        join public.custody_journeys j on j.id = e.journey_id
        where e.user_id = p_user_id
          and e.event_type = 'VERIFIED_TARGET_BUY'
          and e.tx_sig = v_tx_sig
          and e.slot = p_trigger_slot
          and e.source_wallet = v_target
          and e.event_at >= p_window_started_at
          and e.event_at <= now()
          and e.evidence_reliable
          and e.applied_amount_tokens > 0
          and e.applied_amount_tokens = e.requested_amount_tokens
          and e.result_reason is null
          and e.result_journey_status = 'active'
          and not e.journey_released
          and j.user_id = p_user_id
          and j.token_mint = v_mint
          and j.status = 'active'
      ) as trigger_buy_verified,
      exists (
        select 1
        from public.custody_journey_events e
        join window_journeys j on j.id = e.journey_id
        where e.user_id = p_user_id
          and e.event_type = 'VERIFIED_CUSTODY_SELL'
          and e.evidence_reliable
          and e.applied_amount_tokens > 0
      ) as verified_sell_seen,
      exists (
        select 1 from window_journeys j
        where j.total_unresolved_outflow_tokens > 0
      ) or exists (
        select 1
        from public.custody_journey_wallets w
        join window_journeys j on j.id = w.journey_id
        where w.user_id = p_user_id
          and w.token_mint = v_mint
          and w.total_unresolved_outflow_tokens > 0
      ) or exists (
        select 1
        from public.custody_pending_events p
        where p.user_id = p_user_id
          and p.token_mint = v_mint
          and p.event_at >= p_window_started_at
          and p.status <> 'applied'
      ) as unresolved_outflow_seen,
      exists (
        select 1
        from public.custody_journey_wallets w
        join public.custody_journeys j on j.id = w.journey_id
        where j.user_id = p_user_id
          and j.token_mint = v_mint
          and j.status = 'active'
          and j.current_attributed_tokens > 0
          and w.user_id = p_user_id
          and w.token_mint = v_mint
          and w.watch_status = 'active'
          and w.current_attributed_tokens > 0
      ) as positive_attribution_seen
  ), decision as (
    select case
      when not config_exists then 'config_not_found'
      when not config_enabled then 'custody_journey_disabled'
      when not heartbeat_exists then 'custody_heartbeat_missing'
      when not heartbeat_enabled then 'custody_heartbeat_disabled'
      when not heartbeat_not_degraded then 'custody_heartbeat_degraded'
      when not heartbeat_fresh then 'custody_heartbeat_stale'
      when not rpc_fresh then 'custody_rpc_stale'
      when not backlog_clear then 'custody_backlog'
      when not trigger_buy_verified then 'trigger_buy_not_verified'
      when verified_sell_seen then 'verified_custody_sell_seen'
      when unresolved_outflow_seen then 'unresolved_custody_outflow'
      when not positive_attribution_seen then 'no_active_positive_attribution'
      else 'custody_safe'
    end as reason
    from facts
  )
  select reason into v_reason from decision;

  return jsonb_build_object(
    'safe', v_reason = 'custody_safe',
    'reason', v_reason
  );
end;
$$;

alter table public.supply_accumulation_events enable row level security;
alter table public.supply_accumulation_state enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'supply_accumulation_events'
      and policyname = 'read own supply accumulation events'
  ) then
    create policy "read own supply accumulation events"
      on public.supply_accumulation_events
      for select to authenticated
      using (user_id = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'supply_accumulation_state'
      and policyname = 'read own supply accumulation state'
  ) then
    create policy "read own supply accumulation state"
      on public.supply_accumulation_state
      for select to authenticated
      using (user_id = auth.uid());
  end if;
end $$;

revoke all on table public.supply_accumulation_events from public, anon, authenticated;
revoke all on table public.supply_accumulation_state from public, anon, authenticated;
grant select on table public.supply_accumulation_events to authenticated;
grant select on table public.supply_accumulation_state to authenticated;
grant select, insert, update on table public.supply_accumulation_events to service_role;
grant select, insert, update on table public.supply_accumulation_state to service_role;

revoke all on function public.record_supply_accumulation_event(
  uuid, text, text, bigint, timestamptz, text, text, text, text, text,
  integer, numeric, bigint, boolean, boolean, boolean, jsonb
) from public, anon, authenticated;
revoke all on function public.get_supply_accumulation_state(uuid, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.check_supply_accumulation_custody_gate(
  uuid, text, timestamptz, text, bigint, text
) from public, anon, authenticated;
grant execute on function public.record_supply_accumulation_event(
  uuid, text, text, bigint, timestamptz, text, text, text, text, text,
  integer, numeric, bigint, boolean, boolean, boolean, jsonb
) to service_role;
grant execute on function public.get_supply_accumulation_state(uuid, text, timestamptz)
  to service_role;
grant execute on function public.check_supply_accumulation_custody_gate(
  uuid, text, timestamptz, text, bigint, text
) to service_role;

-- This migration never changes position, trade, funding-key, entry-claim, or
-- sell-claim data. It only widens the sell-claim CHECK to match existing worker
-- exit kinds. Runtime entries use the existing regular-position contract.
-- SUPPLY_ACCUMULATION_CANONICAL_MIRROR_END

-- REVIVAL_HYDRATION_INDEX_CANONICAL_MIRROR_BEGIN
-- Revival Campaign tracker: bounded startup hydration index.
-- Additive and safe to rerun. This index supports the observer's per-version
-- UUID keyset scan without changing or deleting any evidence.

create index if not exists revival_events_hydration_idx
  on public.revival_events (user_id, strategy_version_id, id);

create index if not exists revival_events_projection_repair_idx
  on public.revival_events (user_id, strategy_version_id, id)
  where campaign_id is null;
-- REVIVAL_HYDRATION_INDEX_CANONICAL_MIRROR_END

-- SUPPLY_ACCUMULATION_SCALE_BUYS_CANONICAL_MIRROR_BEGIN
-- Supply Accumulation v2: adjustable market-cap floor plus optional durable
-- second, third, and fourth buys. This migration is additive. The original
-- Supply entry claim and every existing position/exit identity remain intact.

create extension if not exists pgcrypto;

alter table public.bot_config
  add column if not exists supply_accumulation_min_market_cap_usd numeric not null default 2000,
  add column if not exists supply_accumulation_scale_2_enabled boolean not null default false,
  add column if not exists supply_accumulation_scale_2_threshold_pct numeric not null default 12,
  add column if not exists supply_accumulation_scale_2_buy_usd numeric not null default 10,
  add column if not exists supply_accumulation_scale_3_enabled boolean not null default false,
  add column if not exists supply_accumulation_scale_3_threshold_pct numeric not null default 15,
  add column if not exists supply_accumulation_scale_3_buy_usd numeric not null default 10,
  add column if not exists supply_accumulation_scale_4_enabled boolean not null default false,
  add column if not exists supply_accumulation_scale_4_threshold_pct numeric not null default 18,
  add column if not exists supply_accumulation_scale_4_buy_usd numeric not null default 10;

-- The deployed ceiling was previously allowed below the new $2,000 default
-- floor. Do not silently rewrite a live entry configuration; stop and make the
-- operator choose a valid range instead.
do $$
begin
  if exists (
    select 1
    from public.bot_config
    where supply_accumulation_max_market_cap_usd <= supply_accumulation_min_market_cap_usd
  ) then
    raise exception using
      errcode = '23514',
      message = 'Supply Accumulation minimum market cap must be below its strict maximum before installing scale buys';
  end if;
end $$;

-- Extend the original rolling state without replacing its exact raw-supply
-- aggregation. The wrapper below delegates to the v1 state function, then
-- applies the new inclusive floor and strict ceiling to both its response and
-- the derived state row used by initial-entry and scale execution.
alter table public.supply_accumulation_state
  add column if not exists min_market_cap_usd numeric not null default 2000,
  add column if not exists above_market_cap_floor boolean not null default false,
  add column if not exists within_market_cap_range boolean not null default false;

update public.supply_accumulation_state s set
  min_market_cap_usd = c.supply_accumulation_min_market_cap_usd,
  max_market_cap_usd = c.supply_accumulation_max_market_cap_usd,
  above_market_cap_floor = coalesce(
    s.market_data_reliable
      and s.latest_market_cap_usd >= c.supply_accumulation_min_market_cap_usd,
    false
  ),
  under_market_cap = coalesce(
    s.market_data_reliable
      and s.latest_market_cap_usd < c.supply_accumulation_max_market_cap_usd,
    false
  ),
  within_market_cap_range = coalesce(
    s.market_data_reliable
      and s.latest_market_cap_usd >= c.supply_accumulation_min_market_cap_usd
      and s.latest_market_cap_usd < c.supply_accumulation_max_market_cap_usd,
    false
  ),
  entry_ready = coalesce(
    s.entry_ready
      and s.market_data_reliable
      and s.latest_market_cap_usd >= c.supply_accumulation_min_market_cap_usd
      and s.latest_market_cap_usd < c.supply_accumulation_max_market_cap_usd,
    false
  )
from public.bot_config c
where c.user_id = s.user_id;

update public.supply_accumulation_state s set
  above_market_cap_floor = false,
  within_market_cap_range = false,
  entry_ready = false
where not exists (
  select 1 from public.bot_config c where c.user_id = s.user_id
);

create or replace function public.materialize_supply_accumulation_market_cap_range()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_min_market_cap_usd numeric := 2000;
  v_max_market_cap_usd numeric := 15000;
begin
  select
    supply_accumulation_min_market_cap_usd,
    supply_accumulation_max_market_cap_usd
  into v_min_market_cap_usd, v_max_market_cap_usd
  from public.bot_config
  where user_id = new.user_id;
  if not found then
    v_min_market_cap_usd := 2000;
    v_max_market_cap_usd := 15000;
  end if;
  if v_min_market_cap_usd < 0
     or v_min_market_cap_usd >= v_max_market_cap_usd
     or v_max_market_cap_usd > 15000 then
    raise exception 'supply accumulation market-cap range is outside safety bounds';
  end if;

  new.min_market_cap_usd := v_min_market_cap_usd;
  new.max_market_cap_usd := v_max_market_cap_usd;
  new.above_market_cap_floor := coalesce(
    new.market_data_reliable
      and new.latest_market_cap_usd >= v_min_market_cap_usd,
    false
  );
  new.under_market_cap := coalesce(
    new.market_data_reliable
      and new.latest_market_cap_usd < v_max_market_cap_usd,
    false
  );
  new.within_market_cap_range := new.above_market_cap_floor and new.under_market_cap;
  new.entry_ready := new.entry_ready and new.within_market_cap_range;
  return new;
end $$;

drop trigger if exists materialize_supply_accumulation_market_cap_range_trigger
  on public.supply_accumulation_state;
create trigger materialize_supply_accumulation_market_cap_range_trigger
before insert or update of
  user_id, latest_market_cap_usd, market_data_reliable, under_market_cap,
  entry_ready, min_market_cap_usd, max_market_cap_usd
on public.supply_accumulation_state
for each row execute function public.materialize_supply_accumulation_market_cap_range();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.supply_accumulation_state'::regclass
      and conname = 'supply_accumulation_state_market_cap_range_check'
  ) then
    alter table public.supply_accumulation_state
      add constraint supply_accumulation_state_market_cap_range_check check (
        min_market_cap_usd >= 0
        and min_market_cap_usd < max_market_cap_usd
        and max_market_cap_usd <= 15000
        and within_market_cap_range = (above_market_cap_floor and under_market_cap)
        and (not entry_ready or within_market_cap_range)
      );
  end if;
end $$;

do $$
begin
  if to_regprocedure(
    'public.get_supply_accumulation_state_without_floor_v1(uuid,text,timestamp with time zone)'
  ) is null then
    if to_regprocedure(
      'public.get_supply_accumulation_state(uuid,text,timestamp with time zone)'
    ) is null then
      raise exception using
        errcode = '42883',
        message = 'run supply-accumulation-entry-migration.sql before the scale-buy migration';
    end if;
    alter function public.get_supply_accumulation_state(uuid, text, timestamptz)
      rename to get_supply_accumulation_state_without_floor_v1;
  end if;
end $$;

create or replace function public.get_supply_accumulation_state(
  p_user_id uuid,
  p_token_mint text,
  p_as_of timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_mint text := btrim(coalesce(p_token_mint, ''));
  v_base jsonb;
  v_min_market_cap_usd numeric := 2000;
  v_max_market_cap_usd numeric := 15000;
  v_latest_market_cap_usd numeric;
  v_market_data_reliable boolean := false;
  v_above_market_cap_floor boolean := false;
  v_under_market_cap boolean := false;
  v_within_market_cap_range boolean := false;
  v_entry_ready boolean := false;
  v_reason text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'service_role is required for supply accumulation state';
  end if;
  if p_user_id is null or v_mint = '' or p_as_of is null then
    raise exception 'supply accumulation state requires user, mint, and as-of time';
  end if;

  select
    supply_accumulation_min_market_cap_usd,
    supply_accumulation_max_market_cap_usd
  into v_min_market_cap_usd, v_max_market_cap_usd
  from public.bot_config
  where user_id = p_user_id;
  if not found then
    v_min_market_cap_usd := 2000;
    v_max_market_cap_usd := 15000;
  elsif v_min_market_cap_usd < 0
     or v_min_market_cap_usd >= v_max_market_cap_usd
     or v_max_market_cap_usd > 15000 then
    raise exception 'supply accumulation market-cap range is outside safety bounds';
  end if;

  v_base := public.get_supply_accumulation_state_without_floor_v1(
    p_user_id,
    v_mint,
    p_as_of
  );
  v_market_data_reliable := coalesce((v_base ->> 'marketDataReliable')::boolean, false);
  if v_base ->> 'latestMarketCapUsd' is not null then
    v_latest_market_cap_usd := (v_base ->> 'latestMarketCapUsd')::numeric;
  end if;
  v_above_market_cap_floor := v_market_data_reliable
    and v_latest_market_cap_usd is not null
    and v_latest_market_cap_usd >= v_min_market_cap_usd;
  v_under_market_cap := v_market_data_reliable
    and v_latest_market_cap_usd is not null
    and v_latest_market_cap_usd < v_max_market_cap_usd;
  v_within_market_cap_range := v_above_market_cap_floor and v_under_market_cap;
  v_entry_ready := coalesce((v_base ->> 'entryReady')::boolean, false)
    and v_within_market_cap_range;
  v_reason := case
    when v_market_data_reliable and not v_above_market_cap_floor
      then 'market_cap_below_floor'
    when v_market_data_reliable and not v_under_market_cap
      then 'market_cap_not_under_ceiling'
    else coalesce(v_base ->> 'reason', 'state_ready')
  end;

  update public.supply_accumulation_state set
    min_market_cap_usd = v_min_market_cap_usd,
    max_market_cap_usd = v_max_market_cap_usd,
    above_market_cap_floor = v_above_market_cap_floor,
    under_market_cap = v_under_market_cap,
    within_market_cap_range = v_within_market_cap_range,
    entry_ready = v_entry_ready,
    updated_at = now()
  where user_id = p_user_id
    and token_mint = v_mint
    and as_of = p_as_of;

  return v_base || jsonb_build_object(
    'reason', v_reason,
    'minMarketCapUsd', v_min_market_cap_usd,
    'maxMarketCapUsd', v_max_market_cap_usd,
    'aboveMarketCapFloor', v_above_market_cap_floor,
    'underMarketCap', v_under_market_cap,
    'withinMarketCapRange', v_within_market_cap_range,
    'entryReady', v_entry_ready
  );
end $$;

create table if not exists public.supply_accumulation_scale_claims (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  token_mint text not null check (btrim(token_mint) <> ''),
  position_id uuid not null references public.positions(id),
  tier_number integer not null check (tier_number between 2 and 4),
  status text not null default 'claimed' check (status in (
    'claimed', 'submitted', 'landed', 'persisted', 'failed_pre_submit', 'uncertain'
  )),
  source_event_key text not null check (btrim(source_event_key) <> ''),
  source_tx_sig text not null check (btrim(source_tx_sig) <> ''),
  source_wallet text not null check (btrim(source_wallet) <> ''),
  source_slot bigint not null check (source_slot > 0),
  token_decimals integer not null check (token_decimals between 0 and 18),
  threshold_pct numeric not null check (threshold_pct between 10 and 20),
  planned_buy_usd numeric not null check (planned_buy_usd > 0 and planned_buy_usd <= 1000000),
  amount_lamports bigint not null check (amount_lamports > 0),
  config_fingerprint text not null check (char_length(config_fingerprint) = 64),
  bot_tx_sig text check (bot_tx_sig is null or btrim(bot_tx_sig) <> ''),
  last_valid_block_height bigint check (
    last_valid_block_height is null or last_valid_block_height > 0
  ),
  -- Text is deliberate: direct PostgREST table reads must never turn an exact
  -- raw token receipt into a lossy JavaScript number before recovery sees it.
  received_amount_raw text check (
    received_amount_raw is null
    or (
      received_amount_raw ~ '^[1-9][0-9]*$'
      and char_length(received_amount_raw) <= 78
    )
  ),
  trade_id uuid references public.trades(id) on delete set null,
  error_code text,
  submission_started_at timestamptz,
  landed_at timestamptz,
  persisted_at timestamptz,
  applied_at timestamptz,
  -- Remains null until runtime has hydrated the position monitor and replayed
  -- every durable target sell that could have landed before this scale apply.
  post_apply_repaired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, token_mint, tier_number),
  foreign key (user_id, source_event_key)
    references public.supply_accumulation_events(user_id, event_key),
  check (
    status <> 'persisted'
    or (
      bot_tx_sig is not null
      and received_amount_raw is not null
      and trade_id is not null
      and persisted_at is not null
      and applied_at is not null
    )
  ),
  constraint supply_accumulation_scale_claims_lifecycle_check check (
    (
      status in ('claimed', 'failed_pre_submit')
      and bot_tx_sig is null
      and last_valid_block_height is null
      and submission_started_at is null
      and received_amount_raw is null
      and landed_at is null
      and trade_id is null
      and persisted_at is null
      and applied_at is null
    )
    or (
      status = 'submitted'
      and bot_tx_sig is not null
      and last_valid_block_height is not null
      and submission_started_at is not null
      and received_amount_raw is null
      and landed_at is null
      and trade_id is null
      and persisted_at is null
      and applied_at is null
    )
    or (
      status = 'landed'
      and bot_tx_sig is not null
      and last_valid_block_height is not null
      and submission_started_at is not null
      and received_amount_raw is not null
      and landed_at is not null
      and trade_id is null
      and persisted_at is null
      and applied_at is null
    )
    or (
      status = 'uncertain'
      and bot_tx_sig is not null
      and last_valid_block_height is not null
      and submission_started_at is not null
      and (received_amount_raw is null) = (landed_at is null)
      and trade_id is null
      and persisted_at is null
      and applied_at is null
    )
    or (
      status = 'persisted'
      and bot_tx_sig is not null
      and last_valid_block_height is not null
      and submission_started_at is not null
      and received_amount_raw is not null
      and landed_at is not null
      and trade_id is not null
      and persisted_at is not null
      and applied_at is not null
    )
  )
);

alter table public.supply_accumulation_scale_claims
  add column if not exists post_apply_repaired_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.supply_accumulation_scale_claims'::regclass
      and conname = 'supply_accumulation_scale_claims_post_apply_repair_check'
  ) then
    alter table public.supply_accumulation_scale_claims
      add constraint supply_accumulation_scale_claims_post_apply_repair_check check (
        post_apply_repaired_at is null
        or (
          status = 'persisted'
          and persisted_at is not null
          and applied_at is not null
        )
      );
  end if;
end $$;

create or replace function public.claim_supply_accumulation_scale_buy(
  p_user_id uuid,
  p_token_mint text,
  p_position_id uuid,
  p_source_event_key text,
  p_amount_lamports bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_plan jsonb;
  v_claim public.supply_accumulation_scale_claims%rowtype;
  v_tier integer;
  v_claimed boolean := false;
  v_replay boolean := false;
  v_reason text := 'not_claimed';
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'service_role is required to claim a Supply Accumulation scale buy';
  end if;
  if p_user_id is null or p_position_id is null or p_amount_lamports is null
     or p_amount_lamports <= 0 then
    return jsonb_build_object(
      'claimed', false,
      'replay', false,
      'reason', 'invalid_request',
      'claim', null
    );
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('helix-position-action:' || p_user_id::text || ':' || p_position_id::text, 0)
  );
  v_plan := public.get_supply_accumulation_scale_plan(
    p_user_id,
    p_token_mint,
    p_position_id,
    p_source_event_key,
    null
  );
  if coalesce((v_plan ->> 'eligible')::boolean, false) is not true then
    if v_plan ->> 'reason' = 'scale_tier_already_claimed'
       and v_plan ->> 'tierNumber' is not null then
      v_tier := (v_plan ->> 'tierNumber')::integer;
      select * into v_claim
      from public.supply_accumulation_scale_claims c
      where c.user_id = p_user_id
        and c.token_mint = btrim(p_token_mint)
        and c.position_id = p_position_id
        and c.tier_number = v_tier
        and c.source_event_key = btrim(p_source_event_key)
        and c.amount_lamports = p_amount_lamports
        and c.status <> 'failed_pre_submit'
      for update;
      if found then
        v_replay := true;
        v_reason := 'scale_tier_already_claimed';
      else
        return jsonb_build_object(
          'claimed', false,
          'replay', false,
          'reason', 'scale_claim_exists_for_different_request',
          'claim', null
        );
      end if;
    else
      return jsonb_build_object(
        'claimed', false,
        'replay', false,
        'reason', coalesce(v_plan ->> 'reason', 'scale_not_eligible'),
        'claim', null
      );
    end if;
  else
    v_tier := (v_plan ->> 'tierNumber')::integer;
  end if;

  if not v_replay then
    select * into v_claim
    from public.supply_accumulation_scale_claims c
    where c.user_id = p_user_id
      and c.token_mint = btrim(p_token_mint)
      and c.tier_number = v_tier
    for update;

    if found and v_claim.status = 'failed_pre_submit' then
      update public.supply_accumulation_scale_claims set
      position_id = p_position_id,
      status = 'claimed',
      source_event_key = btrim(p_source_event_key),
      source_tx_sig = v_plan ->> 'sourceTxSig',
      source_wallet = v_plan ->> 'sourceWallet',
      source_slot = (v_plan ->> 'sourceSlot')::bigint,
      token_decimals = (v_plan ->> 'tokenDecimals')::integer,
      threshold_pct = (v_plan ->> 'thresholdPct')::numeric,
      planned_buy_usd = (v_plan ->> 'buyUsd')::numeric,
      amount_lamports = p_amount_lamports,
      config_fingerprint = v_plan ->> 'configFingerprint',
      bot_tx_sig = null,
      last_valid_block_height = null,
      received_amount_raw = null,
      trade_id = null,
      error_code = null,
      submission_started_at = null,
      landed_at = null,
      persisted_at = null,
      applied_at = null,
      post_apply_repaired_at = null,
      updated_at = now()
      where id = v_claim.id
        and user_id = p_user_id
        and status = 'failed_pre_submit'
      returning * into v_claim;
      if not found then
        return jsonb_build_object(
          'claimed', false,
          'replay', false,
          'reason', 'scale_claim_changed_during_reclaim',
          'claim', null
        );
      end if;
      v_reason := 'failed_pre_submit_reclaimed';
    elsif found then
      if v_claim.position_id = p_position_id
         and v_claim.source_event_key = btrim(p_source_event_key)
         and v_claim.amount_lamports = p_amount_lamports then
        v_replay := true;
        v_reason := 'scale_tier_already_claimed';
      else
        return jsonb_build_object(
          'claimed', false,
          'replay', false,
          'reason', 'scale_claim_exists_for_different_request',
          'claim', null
        );
      end if;
    else
      insert into public.supply_accumulation_scale_claims (
      user_id, token_mint, position_id, tier_number, status,
      source_event_key, source_tx_sig, source_wallet, source_slot,
      token_decimals, threshold_pct, planned_buy_usd, amount_lamports,
      config_fingerprint
      ) values (
      p_user_id, btrim(p_token_mint), p_position_id, v_tier, 'claimed',
      btrim(p_source_event_key), v_plan ->> 'sourceTxSig', v_plan ->> 'sourceWallet',
      (v_plan ->> 'sourceSlot')::bigint,
      (v_plan ->> 'tokenDecimals')::integer,
      (v_plan ->> 'thresholdPct')::numeric,
      (v_plan ->> 'buyUsd')::numeric,
      p_amount_lamports,
      v_plan ->> 'configFingerprint'
      )
      on conflict do nothing
      returning * into v_claim;
      if found then
        v_reason := 'scale_claimed';
      else
        select * into v_claim
        from public.supply_accumulation_scale_claims c
        where c.user_id = p_user_id
          and c.token_mint = btrim(p_token_mint)
          and c.position_id = p_position_id
          and c.tier_number = v_tier
          and c.source_event_key = btrim(p_source_event_key)
          and c.amount_lamports = p_amount_lamports
          and c.status <> 'failed_pre_submit';
        if not found then
          return jsonb_build_object(
            'claimed', false,
            'replay', false,
            'reason', 'another_scale_claim_is_active',
            'claim', null
          );
        end if;
        v_replay := true;
        v_reason := 'scale_tier_already_claimed';
      end if;
    end if;
  end if;

  v_claimed := v_reason in ('scale_claimed', 'failed_pre_submit_reclaimed');

  return jsonb_build_object(
    'claimed', v_claimed,
    'replay', v_replay,
    'reason', v_reason,
    'claim', jsonb_build_object(
      'id', v_claim.id::text,
      'userId', v_claim.user_id::text,
      'tokenMint', v_claim.token_mint,
      'positionId', v_claim.position_id::text,
      'tierNumber', v_claim.tier_number,
      'status', v_claim.status,
      'sourceEventKey', v_claim.source_event_key,
      'sourceTxSig', v_claim.source_tx_sig,
      'sourceWallet', v_claim.source_wallet,
      'sourceSlot', v_claim.source_slot::text,
      'tokenDecimals', v_claim.token_decimals,
      'thresholdPct', v_claim.threshold_pct,
      'plannedBuyUsd', v_claim.planned_buy_usd,
      'amountLamports', v_claim.amount_lamports::text,
      'configFingerprint', v_claim.config_fingerprint,
      'botTxSig', v_claim.bot_tx_sig,
      'lastValidBlockHeight', case
        when v_claim.last_valid_block_height is null then null
        else v_claim.last_valid_block_height::text
      end,
      'receivedAmountRaw', case
        when v_claim.received_amount_raw is null then null
        else v_claim.received_amount_raw::text
      end,
      'tradeId', case when v_claim.trade_id is null then null else v_claim.trade_id::text end,
      'errorCode', v_claim.error_code,
      'submissionStartedAt', v_claim.submission_started_at,
      'landedAt', v_claim.landed_at,
      'persistedAt', v_claim.persisted_at,
      'appliedAt', v_claim.applied_at,
      'postApplyRepairedAt', v_claim.post_apply_repaired_at,
      'createdAt', v_claim.created_at,
      'updatedAt', v_claim.updated_at
    )
  );
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bot_config'::regclass
      and conname = 'bot_config_supply_accumulation_market_cap_range_check'
  ) then
    alter table public.bot_config
      add constraint bot_config_supply_accumulation_market_cap_range_check check (
        supply_accumulation_min_market_cap_usd >= 0
        and supply_accumulation_min_market_cap_usd < supply_accumulation_max_market_cap_usd
        and supply_accumulation_max_market_cap_usd <= 15000
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bot_config'::regclass
      and conname = 'bot_config_supply_accumulation_scale_values_check'
  ) then
    alter table public.bot_config
      add constraint bot_config_supply_accumulation_scale_values_check check (
        supply_accumulation_buy_usd > 0
        and supply_accumulation_buy_usd <= 1000000
        and supply_accumulation_scale_2_threshold_pct between 10 and 20
        and supply_accumulation_scale_3_threshold_pct between 10 and 20
        and supply_accumulation_scale_4_threshold_pct between 10 and 20
        and supply_accumulation_scale_2_buy_usd > 0
        and supply_accumulation_scale_2_buy_usd <= 1000000
        and supply_accumulation_scale_3_buy_usd > 0
        and supply_accumulation_scale_3_buy_usd <= 1000000
        and supply_accumulation_scale_4_buy_usd > 0
        and supply_accumulation_scale_4_buy_usd <= 1000000
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bot_config'::regclass
      and conname = 'bot_config_supply_accumulation_scale_order_check'
  ) then
    alter table public.bot_config
      add constraint bot_config_supply_accumulation_scale_order_check check (
        (not supply_accumulation_scale_3_enabled or supply_accumulation_scale_2_enabled)
        and (
          not supply_accumulation_scale_4_enabled
          or (supply_accumulation_scale_2_enabled and supply_accumulation_scale_3_enabled)
        )
        and (
          not supply_accumulation_scale_2_enabled
          or supply_accumulation_scale_2_threshold_pct > supply_accumulation_threshold_pct
        )
        and (
          not supply_accumulation_scale_3_enabled
          or supply_accumulation_scale_3_threshold_pct > supply_accumulation_scale_2_threshold_pct
        )
        and (
          not supply_accumulation_scale_4_enabled
          or supply_accumulation_scale_4_threshold_pct > supply_accumulation_scale_3_threshold_pct
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bot_config'::regclass
      and conname = 'bot_config_supply_accumulation_scale_exposure_check'
  ) then
    alter table public.bot_config
      add constraint bot_config_supply_accumulation_scale_exposure_check check (
        supply_accumulation_buy_usd
        + case when supply_accumulation_scale_2_enabled then supply_accumulation_scale_2_buy_usd else 0 end
        + case when supply_accumulation_scale_3_enabled then supply_accumulation_scale_3_buy_usd else 0 end
        + case when supply_accumulation_scale_4_enabled then supply_accumulation_scale_4_buy_usd else 0 end
        <= 1000000
      );
  end if;
end $$;

create index if not exists supply_accumulation_scale_claims_user_status_idx
  on public.supply_accumulation_scale_claims (user_id, status, updated_at desc);
create index if not exists supply_accumulation_scale_claims_position_idx
  on public.supply_accumulation_scale_claims (position_id, tier_number);
create index if not exists supply_accumulation_scale_claims_post_apply_repair_idx
  on public.supply_accumulation_scale_claims (user_id, applied_at, id)
  where status = 'persisted' and post_apply_repaired_at is null;
create unique index if not exists supply_accumulation_scale_claims_bot_tx_idx
  on public.supply_accumulation_scale_claims (user_id, bot_tx_sig)
  where bot_tx_sig is not null;
create index if not exists supply_accumulation_events_position_sell_v2_idx
  on public.supply_accumulation_events (user_id, token_mint, target_wallet, slot)
  where side = 'sell';
create index if not exists custody_journey_events_supply_lifetime_veto_idx
  on public.custody_journey_events (journey_id, slot, event_at)
  where event_type in ('VERIFIED_CUSTODY_SELL', 'CUSTODY_TRANSFER');
create index if not exists custody_pending_events_supply_lifetime_veto_idx
  on public.custody_pending_events (user_id, token_mint, journey_id, slot, event_at)
  where status <> 'applied';

do $$
begin
  if exists (
    select 1
    from public.supply_accumulation_scale_claims
    where status in ('claimed', 'submitted', 'landed', 'uncertain')
    group by user_id, token_mint
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'multiple active Supply Accumulation scale claims must be reconciled before installing the one-open-claim index';
  end if;
end $$;

create unique index if not exists supply_accumulation_scale_claims_active_mint_idx
  on public.supply_accumulation_scale_claims (user_id, token_mint)
  where status in ('claimed', 'submitted', 'landed', 'uncertain');

-- Cross-process position-action exclusion. Both directions take the exact same
-- advisory key before checking the opposite table. Any historical sell claim
-- permanently seals scaling, even when that sell failed before submission.
create or replace function public.guard_supply_scale_against_position_exit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.status in ('claimed', 'submitted', 'landed', 'uncertain') then
    perform pg_advisory_xact_lock(
      hashtextextended('helix-position-action:' || new.user_id::text || ':' || new.position_id::text, 0)
    );
    if exists (
      select 1
      from public.sell_signal_claims s
      where s.user_id = new.user_id
        and s.position_id = new.position_id
    ) then
      raise exception using
        errcode = '55000',
        message = 'Supply scale blocked because an exit claim already exists for this position';
    end if;
  end if;
  return new;
end $$;

create or replace function public.guard_position_exit_against_supply_scale()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.status in ('claimed', 'submitted', 'landed', 'uncertain') then
    perform pg_advisory_xact_lock(
      hashtextextended('helix-position-action:' || new.user_id::text || ':' || new.position_id::text, 0)
    );
    if exists (
      select 1
      from public.supply_accumulation_scale_claims c
      where c.user_id = new.user_id
        and c.position_id = new.position_id
        and c.status in ('claimed', 'submitted', 'landed', 'uncertain')
    ) then
      raise exception using
        errcode = '55000',
        message = 'Position exit claim blocked while a Supply scale transaction is unresolved';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists guard_supply_scale_against_position_exit_trigger
  on public.supply_accumulation_scale_claims;
create trigger guard_supply_scale_against_position_exit_trigger
before insert or update of status, position_id
on public.supply_accumulation_scale_claims
for each row execute function public.guard_supply_scale_against_position_exit();

drop trigger if exists guard_position_exit_against_supply_scale_trigger
  on public.sell_signal_claims;
create trigger guard_position_exit_against_supply_scale_trigger
before insert or update of status, position_id
on public.sell_signal_claims
for each row execute function public.guard_position_exit_against_supply_scale();

create or replace function public.get_supply_accumulation_scale_plan(
  p_user_id uuid,
  p_token_mint text,
  p_position_id uuid,
  p_source_event_key text,
  p_claim_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_mint text := btrim(coalesce(p_token_mint, ''));
  v_event_key text := btrim(coalesce(p_source_event_key, ''));
  v_config public.bot_config%rowtype;
  v_position public.positions%rowtype;
  v_event public.supply_accumulation_events%rowtype;
  v_state public.supply_accumulation_state%rowtype;
  v_claim public.supply_accumulation_scale_claims%rowtype;
  v_existing_claim public.supply_accumulation_scale_claims%rowtype;
  v_targets text[] := array[]::text[];
  v_config_fingerprint text;
  v_tier integer;
  v_threshold numeric;
  v_buy_usd numeric;
  v_prior_source_slot bigint;
  v_initial_source_slot bigint;
  v_initial_source_tx_sig text;
  v_initial_source_wallet text;
  v_initial_custody_journey_id uuid;
  v_initial_custody_event_at timestamptz;
  v_net_supply_pct numeric;
  v_custody jsonb;
  v_base jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'service_role is required for Supply Accumulation scale planning';
  end if;

  v_base := jsonb_build_object(
    'ok', false,
    'eligible', false,
    'reason', 'invalid_request',
    'userId', case when p_user_id is null then null else p_user_id::text end,
    'tokenMint', nullif(v_mint, ''),
    'positionId', case when p_position_id is null then null else p_position_id::text end,
    'sourceEventKey', nullif(v_event_key, ''),
    'claimId', case when p_claim_id is null then null else p_claim_id::text end,
    'tierNumber', null,
    'thresholdPct', null,
    'buyUsd', null,
    'configFingerprint', null,
    'sourceTxSig', null,
    'sourceWallet', null,
    'sourceSlot', null,
    'tokenDecimals', null,
    'netSupplyPct', null,
    'marketCapUsd', null,
    'minMarketCapUsd', null,
    'maxMarketCapUsd', null
  );

  if p_user_id is null or p_position_id is null or v_mint = '' or v_event_key = '' then
    return v_base;
  end if;

  -- This is the same user/mint lock used by the durable event recorder and the
  -- custody gate. Take it before every state/event read so an uncommitted target
  -- sell cannot appear only after the lifetime veto snapshot.
  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(v_mint));

  select * into v_config
  from public.bot_config
  where user_id = p_user_id;
  if not found then
    return v_base || jsonb_build_object('reason', 'config_not_found');
  end if;

  v_targets := array(
    select distinct btrim(wallet)
    from unnest(
      array_remove(
        array_prepend(nullif(btrim(v_config.target_wallet), ''), v_config.additional_target_wallets),
        null
      )
    ) configured(wallet)
    where nullif(btrim(wallet), '') is not null
    order by btrim(wallet)
  );
  v_config_fingerprint := encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          'modeEnabled', v_config.supply_accumulation_mode_enabled,
          'custodyEnabled', v_config.custody_journey_enabled,
          'thresholdPct', v_config.supply_accumulation_threshold_pct,
          'buyUsd', v_config.supply_accumulation_buy_usd,
          'minMarketCapUsd', v_config.supply_accumulation_min_market_cap_usd,
          'maxMarketCapUsd', v_config.supply_accumulation_max_market_cap_usd,
          'windowSeconds', v_config.supply_accumulation_window_seconds,
          'scale2Enabled', v_config.supply_accumulation_scale_2_enabled,
          'scale2ThresholdPct', v_config.supply_accumulation_scale_2_threshold_pct,
          'scale2BuyUsd', v_config.supply_accumulation_scale_2_buy_usd,
          'scale3Enabled', v_config.supply_accumulation_scale_3_enabled,
          'scale3ThresholdPct', v_config.supply_accumulation_scale_3_threshold_pct,
          'scale3BuyUsd', v_config.supply_accumulation_scale_3_buy_usd,
          'scale4Enabled', v_config.supply_accumulation_scale_4_enabled,
          'scale4ThresholdPct', v_config.supply_accumulation_scale_4_threshold_pct,
          'scale4BuyUsd', v_config.supply_accumulation_scale_4_buy_usd,
          'targets', to_jsonb(v_targets)
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  v_base := v_base || jsonb_build_object(
    'ok', true,
    'configFingerprint', v_config_fingerprint,
    'minMarketCapUsd', v_config.supply_accumulation_min_market_cap_usd,
    'maxMarketCapUsd', v_config.supply_accumulation_max_market_cap_usd
  );

  if v_config.enabled is not true then
    return v_base || jsonb_build_object('reason', 'entries_disabled');
  end if;
  if v_config.supply_accumulation_mode_enabled is not true then
    return v_base || jsonb_build_object('reason', 'supply_mode_disabled');
  end if;
  if v_config.custody_journey_enabled is not true then
    return v_base || jsonb_build_object('reason', 'custody_journey_disabled');
  end if;
  if v_config.conviction_mode_enabled or v_config.coordinated_mode_enabled then
    return v_base || jsonb_build_object('reason', 'exclusive_entry_strategy_changed');
  end if;
  if cardinality(v_targets) = 0 then
    return v_base || jsonb_build_object('reason', 'target_wallets_missing');
  end if;
  if v_config.supply_accumulation_min_market_cap_usd < 0
     or v_config.supply_accumulation_min_market_cap_usd
        >= v_config.supply_accumulation_max_market_cap_usd
     or v_config.supply_accumulation_max_market_cap_usd > 15000 then
    return v_base || jsonb_build_object('reason', 'market_cap_config_invalid');
  end if;

  select * into v_position
  from public.positions
  where id = p_position_id
    and user_id = p_user_id
    and token_mint = v_mint;
  if not found then
    return v_base || jsonb_build_object('reason', 'position_not_found');
  end if;
  -- A repository-wide partial unique index would change every entry strategy
  -- and could reject a pre-existing non-Supply deployment. Instead, this
  -- service-only plan fails closed unless this is the sole open position for
  -- the user/mint; the durable claim then owns every later scale transition.
  if (
    select count(*)
    from public.positions p
    where p.user_id = p_user_id
      and p.token_mint = v_mint
      and p.closed_at is null
  ) <> 1 then
    return v_base || jsonb_build_object('reason', 'open_position_identity_not_unique');
  end if;
  if v_position.closed_at is not null
     or v_position.amount_remaining is distinct from v_position.amount_tokens
     or coalesce(v_position.amount_remaining, 0) <= 0
     or coalesce(v_position.entry_price_usd, 0) <= 0
     or coalesce(v_position.tp_taken, false)
     or coalesce(v_position.mirrored_sold_fraction, 0) <> 0
     or coalesce(v_position.coordinated_exit_triggered, false)
     or coalesce(v_position.follower_seller_exit_triggered, false) then
    return v_base || jsonb_build_object('reason', 'position_not_untouched');
  end if;

  if not exists (
    select 1
    from public.position_target_wallets linked
    where linked.user_id = p_user_id
      and linked.position_id = p_position_id
  ) then
    return v_base || jsonb_build_object('reason', 'position_target_wallets_missing');
  end if;

  select c.source_slot, c.source_tx_sig, c.source_wallet
    into v_initial_source_slot, v_initial_source_tx_sig, v_initial_source_wallet
  from public.entry_signal_claims c
  where c.user_id = p_user_id
    and c.planned_position_id = p_position_id
    and c.token_mint = v_mint
    and c.entry_strategy = 'supply_accumulation'
    and c.status = 'persisted'
  order by c.persisted_at desc nulls last, c.created_at desc
  limit 1;
  if not found or v_initial_source_slot is null or v_initial_source_slot <= 0 then
    return v_base || jsonb_build_object('reason', 'initial_supply_entry_not_persisted');
  end if;

  -- The position's target links are durable campaign identity. Current config
  -- still admits the new buy below, but removing a wallet from config can never
  -- erase sell evidence already tied to this exact position. Any persisted sell
  -- row is a permanent veto, including quarantined or unreliable observations.
  if exists (
    select 1
    from public.supply_accumulation_events e
    where e.user_id = p_user_id
      and e.token_mint = v_mint
      and e.side = 'sell'
      and e.slot >= v_initial_source_slot
      and (
        e.target_wallet = any(v_targets)
        or exists (
          select 1
          from public.position_target_wallets linked
          where linked.user_id = p_user_id
            and linked.position_id = p_position_id
            and linked.wallet = e.target_wallet
        )
      )
  ) then
    return v_base || jsonb_build_object('reason', 'lifetime_target_sell_recorded');
  end if;

  -- Anchor custody history to the exact initial entry rather than today's
  -- configured wallets. Custody writers share the user/mint advisory lock held
  -- by this plan, so no sell or unresolved outflow can commit between this
  -- lifetime snapshot and claim eligibility.
  select anchor.journey_id, anchor.event_at
    into v_initial_custody_journey_id, v_initial_custody_event_at
  from public.custody_journey_events anchor
  join public.custody_journeys journey
    on journey.id = anchor.journey_id
   and journey.user_id = p_user_id
   and journey.token_mint = v_mint
  join public.position_target_wallets linked
    on linked.user_id = p_user_id
   and linked.position_id = p_position_id
   and linked.wallet = anchor.source_wallet
  where anchor.user_id = p_user_id
    and anchor.event_type = 'VERIFIED_TARGET_BUY'
    and anchor.tx_sig = v_initial_source_tx_sig
    and anchor.slot = v_initial_source_slot
    and anchor.source_wallet = v_initial_source_wallet
  order by anchor.event_at asc, anchor.id asc
  limit 1;
  if not found then
    return v_base || jsonb_build_object('reason', 'initial_custody_journey_not_found');
  end if;

  if exists (
    select 1
    from public.custody_journeys journey
    where journey.id = v_initial_custody_journey_id
      and journey.user_id = p_user_id
      and journey.token_mint = v_mint
      and (
        journey.total_verified_custody_sell_tokens > 0
        or journey.total_unresolved_outflow_tokens > 0
      )
  ) or exists (
    select 1
    from public.custody_journey_wallets wallet_state
    where wallet_state.journey_id = v_initial_custody_journey_id
      and wallet_state.user_id = p_user_id
      and wallet_state.token_mint = v_mint
      and (
        wallet_state.total_verified_sold_tokens > 0
        or wallet_state.total_unresolved_outflow_tokens > 0
      )
  ) or exists (
    select 1
    from public.custody_journey_events custody_event
    where custody_event.journey_id = v_initial_custody_journey_id
      and custody_event.user_id = p_user_id
      and (
        custody_event.slot >= v_initial_source_slot
        or (
          custody_event.slot is null
          and custody_event.event_at >= v_initial_custody_event_at
        )
      )
      and (
        custody_event.event_type = 'VERIFIED_CUSTODY_SELL'
        or (
          custody_event.event_type = 'CUSTODY_TRANSFER'
          and (
            custody_event.result_reason in (
              'partial_unobserved_outflow', 'partial_unresolved_outflow'
            )
            or coalesce(custody_event.metadata ->> 'observationKind', '')
              = 'CUSTODY_UNRESOLVED_OUTFLOW'
          )
        )
      )
  ) or exists (
    select 1
    from public.custody_pending_events pending
    where pending.user_id = p_user_id
      and pending.token_mint = v_mint
      and pending.status <> 'applied'
      and (
        pending.slot >= v_initial_source_slot
        or (
          pending.slot is null
          and pending.event_at >= v_initial_custody_event_at
        )
      )
      and (
        pending.journey_id = v_initial_custody_journey_id
        or exists (
          select 1
          from public.custody_journey_wallets descendant
          where descendant.journey_id = v_initial_custody_journey_id
            and descendant.user_id = p_user_id
            and descendant.token_mint = v_mint
            and descendant.wallet = pending.source_wallet
        )
      )
  ) then
    return v_base || jsonb_build_object(
      'reason', 'lifetime_custody_distribution_recorded'
    );
  end if;

  if exists (
    select 1
    from public.supply_accumulation_scale_claims repaired
    where repaired.user_id = p_user_id
      and repaired.position_id = p_position_id
      and repaired.status = 'persisted'
      and repaired.post_apply_repaired_at is null
  ) then
    return v_base || jsonb_build_object('reason', 'post_apply_repair_pending');
  end if;

  if exists (
    select 1 from public.sell_signal_claims s
    where s.user_id = p_user_id and s.position_id = p_position_id
  ) then
    return v_base || jsonb_build_object('reason', 'position_exit_claim_recorded');
  end if;
  if exists (
    select 1 from public.trades t
    where t.user_id = p_user_id and t.position_id = p_position_id and t.side = 'sell'
  ) then
    return v_base || jsonb_build_object('reason', 'position_sell_recorded');
  end if;

  select * into v_event
  from public.supply_accumulation_events e
  where e.user_id = p_user_id
    and e.event_key = v_event_key;
  if not found then
    return v_base || jsonb_build_object('reason', 'source_event_not_found');
  end if;
  v_base := v_base || jsonb_build_object(
    'sourceTxSig', v_event.tx_sig,
    'sourceWallet', v_event.target_wallet,
    'sourceSlot', v_event.slot::text,
    'tokenDecimals', v_event.decimals
  );
  if v_event.token_mint <> v_mint
     or v_event.side <> 'buy'
     or v_event.quarantined
     or not v_event.is_pump_fun
     or not v_event.classification_reliable
     or not (v_event.target_wallet = any(v_targets)) then
    return v_base || jsonb_build_object('reason', 'source_event_not_eligible');
  end if;
  if v_event.event_at < now() - interval '55 seconds'
     or v_event.event_at > now() + interval '5 seconds' then
    return v_base || jsonb_build_object('reason', 'source_event_stale');
  end if;

  select * into v_state
  from public.supply_accumulation_state s
  where s.user_id = p_user_id
    and s.token_mint = v_mint;
  if not found then
    return v_base || jsonb_build_object('reason', 'supply_state_not_found');
  end if;
  v_net_supply_pct := v_state.net_supply_bps / 100;
  v_base := v_base || jsonb_build_object(
    'netSupplyPct', v_net_supply_pct,
    'marketCapUsd', v_state.latest_market_cap_usd
  );
  if not v_state.data_reliable
     or v_state.payload_conflict
     or not v_state.market_data_reliable
     or v_state.min_market_cap_usd is distinct from v_config.supply_accumulation_min_market_cap_usd
     or v_state.max_market_cap_usd is distinct from v_config.supply_accumulation_max_market_cap_usd
     or not v_state.above_market_cap_floor
     or not v_state.under_market_cap
     or not v_state.within_market_cap_range
     or not v_state.pump_fun_verified
     or not v_state.classification_reliable
     or v_state.last_event_side <> 'buy'
     or v_state.last_event_key is distinct from v_event_key
     or v_state.last_event_slot is distinct from v_event.slot
     or v_state.as_of < now() - interval '55 seconds' then
    return v_base || jsonb_build_object('reason', 'supply_state_not_current');
  end if;
  if v_state.latest_market_cap_usd is null
     or v_state.latest_market_cap_usd < v_config.supply_accumulation_min_market_cap_usd
     or v_state.latest_market_cap_usd >= v_config.supply_accumulation_max_market_cap_usd then
    return v_base || jsonb_build_object('reason', 'market_cap_outside_configured_range');
  end if;

  v_custody := public.check_supply_accumulation_custody_gate(
    p_user_id,
    v_mint,
    v_state.window_started_at,
    v_event.tx_sig,
    v_event.slot,
    v_event.target_wallet
  );
  if coalesce((v_custody ->> 'safe')::boolean, false) is not true then
    return v_base || jsonb_build_object(
      'reason', 'custody_gate_blocked',
      'custodyReason', coalesce(v_custody ->> 'reason', 'unknown')
    );
  end if;

  if p_claim_id is not null then
    select * into v_claim
    from public.supply_accumulation_scale_claims c
    where c.id = p_claim_id
      and c.user_id = p_user_id;
    if not found then
      return v_base || jsonb_build_object('reason', 'scale_claim_not_found');
    end if;
    if v_claim.token_mint <> v_mint
       or v_claim.position_id <> p_position_id
       or v_claim.source_event_key <> v_event_key
       or v_claim.status <> 'submitted' then
      return v_base || jsonb_build_object('reason', 'scale_claim_identity_changed');
    end if;
    v_tier := v_claim.tier_number;
  else
    if v_config.supply_accumulation_scale_2_enabled
       and not exists (
         select 1 from public.supply_accumulation_scale_claims c
         where c.user_id = p_user_id and c.token_mint = v_mint
           and c.position_id = p_position_id
           and c.tier_number = 2 and c.status = 'persisted'
       ) then
      v_tier := 2;
    elsif v_config.supply_accumulation_scale_3_enabled
       and exists (
         select 1 from public.supply_accumulation_scale_claims c
         where c.user_id = p_user_id and c.token_mint = v_mint
           and c.position_id = p_position_id
           and c.tier_number = 2 and c.status = 'persisted'
           and c.post_apply_repaired_at is not null
       )
       and not exists (
         select 1 from public.supply_accumulation_scale_claims c
         where c.user_id = p_user_id and c.token_mint = v_mint
           and c.position_id = p_position_id
           and c.tier_number = 3 and c.status = 'persisted'
       ) then
      v_tier := 3;
    elsif v_config.supply_accumulation_scale_4_enabled
       and exists (
         select 1 from public.supply_accumulation_scale_claims c
         where c.user_id = p_user_id and c.token_mint = v_mint
           and c.position_id = p_position_id
           and c.tier_number = 3 and c.status = 'persisted'
           and c.post_apply_repaired_at is not null
       )
       and not exists (
         select 1 from public.supply_accumulation_scale_claims c
         where c.user_id = p_user_id and c.token_mint = v_mint
           and c.position_id = p_position_id
           and c.tier_number = 4 and c.status = 'persisted'
       ) then
      v_tier := 4;
    else
      return v_base || jsonb_build_object('reason', 'no_enabled_scale_tier_pending');
    end if;

    select * into v_existing_claim
    from public.supply_accumulation_scale_claims c
    where c.user_id = p_user_id
      and c.token_mint = v_mint
      and c.tier_number = v_tier;
    if found and v_existing_claim.status <> 'failed_pre_submit' then
      return v_base || jsonb_build_object(
        'reason', 'scale_tier_already_claimed',
        'tierNumber', v_tier
      );
    end if;
  end if;

  if v_tier = 2 then
    if not v_config.supply_accumulation_scale_2_enabled then
      return v_base || jsonb_build_object('reason', 'scale_tier_disabled');
    end if;
    v_threshold := v_config.supply_accumulation_scale_2_threshold_pct;
    v_buy_usd := v_config.supply_accumulation_scale_2_buy_usd;
    v_prior_source_slot := v_initial_source_slot;
  elsif v_tier = 3 then
    if not v_config.supply_accumulation_scale_2_enabled
       or not v_config.supply_accumulation_scale_3_enabled then
      return v_base || jsonb_build_object('reason', 'scale_tier_prerequisite_disabled');
    end if;
    v_threshold := v_config.supply_accumulation_scale_3_threshold_pct;
    v_buy_usd := v_config.supply_accumulation_scale_3_buy_usd;
    select c.source_slot into v_prior_source_slot
    from public.supply_accumulation_scale_claims c
    where c.user_id = p_user_id and c.token_mint = v_mint
      and c.position_id = p_position_id
      and c.tier_number = 2 and c.status = 'persisted'
      and c.post_apply_repaired_at is not null;
  elsif v_tier = 4 then
    if not v_config.supply_accumulation_scale_2_enabled
       or not v_config.supply_accumulation_scale_3_enabled
       or not v_config.supply_accumulation_scale_4_enabled then
      return v_base || jsonb_build_object('reason', 'scale_tier_prerequisite_disabled');
    end if;
    v_threshold := v_config.supply_accumulation_scale_4_threshold_pct;
    v_buy_usd := v_config.supply_accumulation_scale_4_buy_usd;
    select c.source_slot into v_prior_source_slot
    from public.supply_accumulation_scale_claims c
    where c.user_id = p_user_id and c.token_mint = v_mint
      and c.position_id = p_position_id
      and c.tier_number = 3 and c.status = 'persisted'
      and c.post_apply_repaired_at is not null;
  else
    return v_base || jsonb_build_object('reason', 'scale_tier_invalid');
  end if;

  v_base := v_base || jsonb_build_object(
    'tierNumber', v_tier,
    'thresholdPct', v_threshold,
    'buyUsd', v_buy_usd
  );
  if v_prior_source_slot is null or v_event.slot <= v_prior_source_slot then
    return v_base || jsonb_build_object('reason', 'scale_requires_later_buy_event');
  end if;
  if v_net_supply_pct < v_threshold then
    return v_base || jsonb_build_object('reason', 'scale_threshold_not_reached');
  end if;
  if p_claim_id is not null and (
    v_claim.config_fingerprint <> v_config_fingerprint
    or v_claim.threshold_pct <> v_threshold
    or v_claim.planned_buy_usd <> v_buy_usd
    or v_claim.source_tx_sig <> v_event.tx_sig
    or v_claim.source_wallet <> v_event.target_wallet
    or v_claim.source_slot <> v_event.slot
    or v_claim.token_decimals <> v_event.decimals
  ) then
    return v_base || jsonb_build_object('reason', 'scale_claim_config_or_source_changed');
  end if;

  return v_base || jsonb_build_object(
    'ok', true,
    'eligible', true,
    'reason', 'scale_ready'
  );
end $$;

create or replace function public.apply_supply_accumulation_scale_buy(
  p_user_id uuid,
  p_claim_id uuid,
  p_bot_tx_sig text,
  p_received_amount_raw text,
  p_token_decimals integer,
  p_route text,
  p_latency_ms integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_signature text := btrim(coalesce(p_bot_tx_sig, ''));
  v_claim public.supply_accumulation_scale_claims%rowtype;
  v_position public.positions%rowtype;
  v_existing_trade public.trades%rowtype;
  v_trade_id uuid;
  v_source_event_at timestamptz;
  v_received_raw numeric;
  v_received_tokens numeric;
  v_old_cost_basis numeric;
  v_new_cost_basis numeric;
  v_new_amount_tokens numeric;
  v_new_amount_remaining numeric;
  v_new_entry_price numeric;
  v_trade_price numeric;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'service_role is required to apply a Supply Accumulation scale buy';
  end if;
  if p_user_id is null or p_claim_id is null or v_signature = ''
     or p_received_amount_raw is null
     or p_received_amount_raw !~ '^[1-9][0-9]*$'
     or char_length(p_received_amount_raw) > 78
     or p_token_decimals is null or p_token_decimals < 0 or p_token_decimals > 18
     or p_route is null or p_route not in ('jito', 'rpc')
     or (p_latency_ms is not null and p_latency_ms < 0) then
    return jsonb_build_object(
      'applied', false,
      'replay', false,
      'reason', 'invalid_request',
      'claimId', case when p_claim_id is null then null else p_claim_id::text end,
      'positionId', null,
      'tierNumber', null,
      'tradeId', null,
      'amountTokens', null,
      'amountRemaining', null,
      'entryPriceUsd', null
    );
  end if;
  v_received_raw := p_received_amount_raw::numeric;

  select * into v_claim
  from public.supply_accumulation_scale_claims c
  where c.id = p_claim_id and c.user_id = p_user_id;
  if not found then
    return jsonb_build_object(
      'applied', false,
      'replay', false,
      'reason', 'scale_claim_not_found',
      'claimId', p_claim_id::text,
      'positionId', null,
      'tierNumber', null,
      'tradeId', null,
      'amountTokens', null,
      'amountRemaining', null,
      'entryPriceUsd', null
    );
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'helix-position-action:' || p_user_id::text || ':' || v_claim.position_id::text,
      0
    )
  );
  select * into v_claim
  from public.supply_accumulation_scale_claims c
  where c.id = p_claim_id and c.user_id = p_user_id
  for update;

  if v_claim.bot_tx_sig is distinct from v_signature then
    return jsonb_build_object(
      'applied', false, 'replay', false, 'reason', 'prepared_signature_mismatch',
      'claimId', v_claim.id::text, 'positionId', v_claim.position_id::text,
      'tierNumber', v_claim.tier_number, 'tradeId', null,
      'amountTokens', null, 'amountRemaining', null, 'entryPriceUsd', null
    );
  end if;
  if v_claim.token_decimals <> p_token_decimals then
    return jsonb_build_object(
      'applied', false, 'replay', false, 'reason', 'receipt_decimals_mismatch',
      'claimId', v_claim.id::text, 'positionId', v_claim.position_id::text,
      'tierNumber', v_claim.tier_number, 'tradeId', null,
      'amountTokens', null, 'amountRemaining', null, 'entryPriceUsd', null
    );
  end if;
  if v_claim.received_amount_raw is not null
     and v_claim.received_amount_raw is distinct from p_received_amount_raw then
    return jsonb_build_object(
      'applied', false, 'replay', false, 'reason', 'landed_receipt_mismatch',
      'claimId', v_claim.id::text, 'positionId', v_claim.position_id::text,
      'tierNumber', v_claim.tier_number, 'tradeId', null,
      'amountTokens', null, 'amountRemaining', null, 'entryPriceUsd', null
    );
  end if;

  select * into v_position
  from public.positions p
  where p.id = v_claim.position_id
    and p.user_id = p_user_id
    and p.token_mint = v_claim.token_mint
  for update;
  if not found then
    return jsonb_build_object(
      'applied', false, 'replay', false, 'reason', 'position_not_found',
      'claimId', v_claim.id::text, 'positionId', v_claim.position_id::text,
      'tierNumber', v_claim.tier_number, 'tradeId', null,
      'amountTokens', null, 'amountRemaining', null, 'entryPriceUsd', null
    );
  end if;

  if v_claim.status = 'persisted' and v_claim.applied_at is not null then
    if v_claim.received_amount_raw is distinct from p_received_amount_raw
       or v_claim.trade_id is null then
      return jsonb_build_object(
        'applied', false, 'replay', false, 'reason', 'persisted_receipt_mismatch',
        'claimId', v_claim.id::text, 'positionId', v_claim.position_id::text,
        'tierNumber', v_claim.tier_number,
        'tradeId', case when v_claim.trade_id is null then null else v_claim.trade_id::text end,
        'amountTokens', v_position.amount_tokens::text,
        'amountRemaining', v_position.amount_remaining::text,
        'entryPriceUsd', case
          when v_position.entry_price_usd is null then null else v_position.entry_price_usd::text
        end
      );
    end if;
    return jsonb_build_object(
      'applied', false,
      'replay', true,
      'reason', 'already_applied',
      'claimId', v_claim.id::text,
      'positionId', v_claim.position_id::text,
      'tierNumber', v_claim.tier_number,
      'tradeId', v_claim.trade_id::text,
      'amountTokens', v_position.amount_tokens::text,
      'amountRemaining', v_position.amount_remaining::text,
      'entryPriceUsd', case
        when v_position.entry_price_usd is null then null else v_position.entry_price_usd::text
      end
    );
  end if;
  if v_claim.status not in ('submitted', 'landed', 'uncertain') then
    return jsonb_build_object(
      'applied', false, 'replay', false, 'reason', 'scale_claim_not_landed',
      'claimId', v_claim.id::text, 'positionId', v_claim.position_id::text,
      'tierNumber', v_claim.tier_number, 'tradeId', null,
      'amountTokens', null, 'amountRemaining', null, 'entryPriceUsd', null
    );
  end if;

  if v_position.closed_at is not null
     or v_position.amount_remaining is distinct from v_position.amount_tokens
     or coalesce(v_position.amount_remaining, 0) <= 0
     or coalesce(v_position.entry_price_usd, 0) <= 0
     or coalesce(v_position.tp_taken, false)
     or coalesce(v_position.mirrored_sold_fraction, 0) <> 0
     or coalesce(v_position.coordinated_exit_triggered, false)
     or coalesce(v_position.follower_seller_exit_triggered, false)
     or exists (
       select 1 from public.sell_signal_claims s
       where s.user_id = p_user_id and s.position_id = v_position.id
     )
     or exists (
       select 1 from public.trades t
       where t.user_id = p_user_id and t.position_id = v_position.id and t.side = 'sell'
     ) then
    return jsonb_build_object(
      'applied', false, 'replay', false, 'reason', 'position_not_scale_safe',
      'claimId', v_claim.id::text, 'positionId', v_claim.position_id::text,
      'tierNumber', v_claim.tier_number, 'tradeId', null,
      'amountTokens', null, 'amountRemaining', null, 'entryPriceUsd', null
    );
  end if;
  if not exists (
    select 1 from public.entry_signal_claims c
    where c.user_id = p_user_id
      and c.planned_position_id = v_position.id
      and c.token_mint = v_position.token_mint
      and c.entry_strategy = 'supply_accumulation'
      and c.status = 'persisted'
  ) then
    return jsonb_build_object(
      'applied', false, 'replay', false, 'reason', 'initial_supply_entry_not_persisted',
      'claimId', v_claim.id::text, 'positionId', v_claim.position_id::text,
      'tierNumber', v_claim.tier_number, 'tradeId', null,
      'amountTokens', null, 'amountRemaining', null, 'entryPriceUsd', null
    );
  end if;

  select e.event_at into v_source_event_at
  from public.supply_accumulation_events e
  where e.user_id = p_user_id
    and e.event_key = v_claim.source_event_key
    and e.token_mint = v_claim.token_mint
    and e.tx_sig = v_claim.source_tx_sig
    and e.target_wallet = v_claim.source_wallet
    and e.slot = v_claim.source_slot
    and e.side = 'buy';
  if not found then
    return jsonb_build_object(
      'applied', false, 'replay', false, 'reason', 'source_event_identity_changed',
      'claimId', v_claim.id::text, 'positionId', v_claim.position_id::text,
      'tierNumber', v_claim.tier_number, 'tradeId', null,
      'amountTokens', null, 'amountRemaining', null, 'entryPriceUsd', null
    );
  end if;

  select * into v_existing_trade
  from public.trades t
  where t.user_id = p_user_id
    and t.tx_sig = v_signature
    and t.side = 'buy'
  order by t.created_at asc
  limit 1;
  if found then
    return jsonb_build_object(
      'applied', false, 'replay', false, 'reason', 'buy_signature_already_recorded',
      'claimId', v_claim.id::text, 'positionId', v_claim.position_id::text,
      'tierNumber', v_claim.tier_number, 'tradeId', v_existing_trade.id::text,
      'amountTokens', null, 'amountRemaining', null, 'entryPriceUsd', null
    );
  end if;

  v_received_tokens := v_received_raw / power(10::numeric, p_token_decimals);
  if v_received_tokens <= 0 then
    return jsonb_build_object(
      'applied', false, 'replay', false, 'reason', 'receipt_amount_invalid',
      'claimId', v_claim.id::text, 'positionId', v_claim.position_id::text,
      'tierNumber', v_claim.tier_number, 'tradeId', null,
      'amountTokens', null, 'amountRemaining', null, 'entryPriceUsd', null
    );
  end if;
  v_old_cost_basis := v_position.amount_remaining * v_position.entry_price_usd;
  v_new_cost_basis := v_old_cost_basis + v_claim.planned_buy_usd;
  v_new_amount_tokens := v_position.amount_tokens + v_received_tokens;
  v_new_amount_remaining := v_position.amount_remaining + v_received_tokens;
  v_new_entry_price := v_new_cost_basis / v_new_amount_remaining;
  v_trade_price := v_claim.planned_buy_usd / v_received_tokens;
  v_trade_id := gen_random_uuid();

  insert into public.trades (
    id, user_id, position_id, side, token_mint, amount_tokens,
    amount_usd, price_usd, tx_sig, reason, latency_ms, route
  ) values (
    v_trade_id, p_user_id, v_position.id, 'buy', v_position.token_mint, v_received_tokens,
    v_claim.planned_buy_usd, v_trade_price, v_signature,
    'Supply Accumulation durable scale ' || v_claim.tier_number::text,
    p_latency_ms, p_route
  );

  update public.positions set
    amount_tokens = v_new_amount_tokens,
    amount_remaining = v_new_amount_remaining,
    entry_price_usd = v_new_entry_price,
    -- Deployed v1 Supply positions may have the legacy zero/default basis.
    -- Rebuild the authoritative basis from the untouched position's amount
    -- and entry price, then add this exact scale cost.
    bot_cost_basis_usd = v_new_cost_basis
  where id = v_position.id
    and user_id = p_user_id;

  -- Contributor attribution is part of the same accounting transaction. A
  -- crash after this RPC therefore cannot persist the scale while losing the
  -- target wallet that every existing sell follower depends on.
  insert into public.position_target_wallets (
    user_id, position_id, wallet, link_reason, last_buy_at
  ) values (
    p_user_id, v_position.id, v_claim.source_wallet, 'additional_buy',
    coalesce(v_source_event_at, now())
  )
  on conflict (position_id, wallet) do update set
    last_buy_at = greatest(
      coalesce(public.position_target_wallets.last_buy_at, '-infinity'::timestamptz),
      excluded.last_buy_at
    )
  where public.position_target_wallets.user_id = excluded.user_id;
  if not found then
    raise exception using
      errcode = '23514',
      message = 'Supply scale target-wallet ownership does not match its position';
  end if;

  update public.supply_accumulation_scale_claims set
    status = 'persisted',
    received_amount_raw = p_received_amount_raw,
    trade_id = v_trade_id,
    error_code = null,
    landed_at = coalesce(landed_at, now()),
    persisted_at = now(),
    applied_at = now(),
    post_apply_repaired_at = null,
    updated_at = now()
  where id = v_claim.id
    and user_id = p_user_id
    and bot_tx_sig = v_signature
    and status in ('submitted', 'landed', 'uncertain');
  if not found then
    raise exception using
      errcode = '40001',
      message = 'Supply scale claim changed during atomic position application';
  end if;

  return jsonb_build_object(
    'applied', true,
    'replay', false,
    'reason', 'scale_applied',
    'claimId', v_claim.id::text,
    'positionId', v_position.id::text,
    'tierNumber', v_claim.tier_number,
    'tradeId', v_trade_id::text,
    'amountTokens', v_new_amount_tokens::text,
    'amountRemaining', v_new_amount_remaining::text,
    'entryPriceUsd', v_new_entry_price::text
  );
end $$;

alter table public.supply_accumulation_scale_claims enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'supply_accumulation_scale_claims'
      and policyname = 'read own supply accumulation scale claims'
  ) then
    create policy "read own supply accumulation scale claims"
      on public.supply_accumulation_scale_claims
      for select to authenticated
      using (user_id = auth.uid());
  end if;
end $$;

revoke all on table public.supply_accumulation_scale_claims from public, anon, authenticated;
grant select on table public.supply_accumulation_scale_claims to authenticated;
grant select, insert, update on table public.supply_accumulation_scale_claims to service_role;

revoke all on function public.guard_supply_scale_against_position_exit()
  from public, anon, authenticated;
revoke all on function public.guard_position_exit_against_supply_scale()
  from public, anon, authenticated;
revoke all on function public.materialize_supply_accumulation_market_cap_range()
  from public, anon, authenticated;
revoke all on function public.get_supply_accumulation_state_without_floor_v1(
  uuid, text, timestamptz
) from public, anon, authenticated;
revoke all on function public.get_supply_accumulation_state(uuid, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.get_supply_accumulation_scale_plan(uuid, text, uuid, text, uuid)
  from public, anon, authenticated;
revoke all on function public.claim_supply_accumulation_scale_buy(uuid, text, uuid, text, bigint)
  from public, anon, authenticated;
revoke all on function public.apply_supply_accumulation_scale_buy(
  uuid, uuid, text, text, integer, text, integer
) from public, anon, authenticated;

grant execute on function public.get_supply_accumulation_scale_plan(uuid, text, uuid, text, uuid)
  to service_role;
grant execute on function public.get_supply_accumulation_state_without_floor_v1(
  uuid, text, timestamptz
) to service_role;
grant execute on function public.get_supply_accumulation_state(uuid, text, timestamptz)
  to service_role;
grant execute on function public.claim_supply_accumulation_scale_buy(uuid, text, uuid, text, bigint)
  to service_role;
grant execute on function public.apply_supply_accumulation_scale_buy(
  uuid, uuid, text, text, integer, text, integer
) to service_role;
-- SUPPLY_ACCUMULATION_SCALE_BUYS_CANONICAL_MIRROR_END


-- SUPPLY_ACCUMULATION_20K_CAP_CANONICAL_MIRROR_BEGIN
-- Supply Accumulation v3: widen the configurable live ceiling from $15,000
-- to a strict $20,000. This migration upgrades databases that already ran both
-- Supply Accumulation migrations. It does not change the current configured
-- value, enable Entries, enable Supply Accumulation, or modify any position,
-- trade, entry-claim, scale-claim, sell-claim, custody, or exit data.
--
-- Rollout contract: keep Entries OFF, apply this migration while the saved
-- ceiling is still at or below $15,000, deploy the matching app and worker,
-- then explicitly save $20,000 and run Doctor before re-enabling Entries.

begin;

do $$
begin
  if to_regclass('public.bot_config') is null
     or to_regclass('public.supply_accumulation_state') is null
     or to_regprocedure(
       'public.get_supply_accumulation_state_without_floor_v1(uuid,text,timestamp with time zone)'
     ) is null
     or to_regprocedure(
       'public.get_supply_accumulation_state(uuid,text,timestamp with time zone)'
     ) is null
     or to_regprocedure(
       'public.record_supply_accumulation_event(uuid,text,text,bigint,timestamp with time zone,text,text,text,text,text,integer,numeric,bigint,boolean,boolean,boolean,jsonb)'
     ) is null
     or to_regprocedure(
       'public.materialize_supply_accumulation_market_cap_range()'
     ) is null
     or to_regprocedure(
       'public.get_supply_accumulation_scale_plan(uuid,text,uuid,text,uuid)'
     ) is null then
    raise exception using
      errcode = '42883',
      message = 'run both Supply Accumulation entry and scale-buy migrations before the 20k cap migration';
  end if;
end $$;

do $$
begin
  if to_regprocedure('extensions.digest(text,text)') is null
     or to_regprocedure('extensions.digest(bytea,text)') is null then
    raise exception using
      errcode = '42883',
      message = 'pgcrypto digest must be installed in the extensions schema before the 20k cap migration';
  end if;
end $$;

-- Defaults affect only future rows. Existing operators must explicitly choose
-- the wider ceiling after the matching app and worker have been deployed.
alter table public.bot_config
  alter column supply_accumulation_max_market_cap_usd set default 20000;

-- Replace both generations of config checks. Keeping their original names
-- makes the migration rerunnable and leaves schema diagnostics stable.
alter table public.bot_config
  drop constraint if exists bot_config_supply_accumulation_values_check,
  drop constraint if exists bot_config_supply_accumulation_market_cap_range_check;

alter table public.bot_config
  add constraint bot_config_supply_accumulation_values_check check (
    supply_accumulation_threshold_pct between 10 and 20
    and supply_accumulation_buy_usd > 0
    and supply_accumulation_max_market_cap_usd > 0
    and supply_accumulation_max_market_cap_usd <= 20000
    and supply_accumulation_window_seconds between 30 and 3600
  ),
  add constraint bot_config_supply_accumulation_market_cap_range_check check (
    supply_accumulation_min_market_cap_usd >= 0
    and supply_accumulation_min_market_cap_usd < supply_accumulation_max_market_cap_usd
    and supply_accumulation_max_market_cap_usd <= 20000
  );

-- The original inline check and the v2 materialized-range check both remain
-- active on deployed databases, so both must move together.
alter table public.supply_accumulation_state
  drop constraint if exists supply_accumulation_state_max_market_cap_usd_check,
  drop constraint if exists supply_accumulation_state_market_cap_range_check;

alter table public.supply_accumulation_state
  add constraint supply_accumulation_state_max_market_cap_usd_check check (
    max_market_cap_usd > 0 and max_market_cap_usd <= 20000
  ),
  add constraint supply_accumulation_state_market_cap_range_check check (
    min_market_cap_usd >= 0
    and min_market_cap_usd < max_market_cap_usd
    and max_market_cap_usd <= 20000
    and within_market_cap_range = (above_market_cap_floor and under_market_cap)
    and (not entry_ready or within_market_cap_range)
  );

-- The renamed v1 routine still performs the exact raw rolling aggregation.
-- Replacing it is required because its deployed body retained the old ceiling.

create or replace function public.get_supply_accumulation_state_without_floor_v1(
  p_user_id uuid,
  p_token_mint text,
  p_as_of timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_mint text := btrim(coalesce(p_token_mint, ''));
  v_mode_enabled boolean := false;
  v_threshold_pct numeric := 10;
  v_max_market_cap_usd numeric := 20000;
  v_window_seconds integer := 600;
  v_window_started_at timestamptz;
  v_targets text[] := array[]::text[];
  v_relevant_count integer := 0;
  v_usable_count integer := 0;
  v_buy_count integer := 0;
  v_sell_count integer := 0;
  v_supply_count integer := 0;
  v_decimals_count integer := 0;
  v_total_supply_raw numeric(78, 0);
  v_decimals integer;
  v_gross_buy_raw numeric(78, 0) := 0;
  v_gross_sell_raw numeric(78, 0) := 0;
  v_net_acquired_raw numeric(78, 0) := 0;
  v_net_supply_bps numeric := 0;
  v_root_wallets text[] := array[]::text[];
  v_last_event_key text;
  v_last_event_at timestamptz;
  v_last_event_slot bigint;
  v_last_event_side text;
  v_max_slot_has_sell boolean := false;
  v_latest_market_cap_usd numeric;
  v_valuation_slot bigint;
  v_latest_market_reliable boolean := false;
  v_market_data_reliable boolean := false;
  v_pump_fun_verified boolean := false;
  v_classification_reliable boolean := false;
  v_direct_settlement_seen boolean := false;
  v_payload_conflict boolean := false;
  v_data_reliable boolean := false;
  v_threshold_reached boolean := false;
  v_under_market_cap boolean := false;
  v_entry_ready boolean := false;
  v_reason text := 'state_ready';
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'service_role is required for supply accumulation state';
  end if;

  if p_user_id is null or v_mint = '' or p_as_of is null then
    raise exception 'supply accumulation state requires user, mint, and as-of time';
  end if;

  select
    supply_accumulation_mode_enabled,
    supply_accumulation_threshold_pct,
    supply_accumulation_max_market_cap_usd,
    supply_accumulation_window_seconds,
    array(
      select distinct wallet
      from unnest(
        array_remove(
          array_prepend(nullif(btrim(target_wallet), ''), additional_target_wallets),
          null
        )
      ) as configured(wallet)
      where nullif(btrim(wallet), '') is not null
      order by wallet
    )
  into
    v_mode_enabled,
    v_threshold_pct,
    v_max_market_cap_usd,
    v_window_seconds,
    v_targets
  from public.bot_config
  where user_id = p_user_id;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'reason', 'config_not_found',
      'userId', p_user_id::text,
      'tokenMint', v_mint,
      'modeEnabled', false,
      'windowSeconds', 600,
      'asOf', p_as_of,
      'windowStartedAt', p_as_of - interval '600 seconds',
      'totalSupplyRaw', null,
      'decimals', null,
      'grossBuyRaw', '0',
      'grossSellRaw', '0',
      'netAcquiredRaw', '0',
      'netSupplyBps', 0,
      'netSupplyPct', 0,
      'buyCount', 0,
      'sellCount', 0,
      'rootWallets', to_jsonb(array[]::text[]),
      'lastEventKey', null,
      'lastEventAt', null,
      'lastEventSlot', null,
      'latestMarketCapUsd', null,
      'valuationSlot', null,
      'marketDataReliable', false,
      'pumpFunVerified', false,
      'classificationReliable', false,
      'directSettlementSeen', false,
      'payloadConflict', false,
      'dataReliable', false,
      'thresholdPct', 10,
      'thresholdReached', false,
      'maxMarketCapUsd', 20000,
      'underMarketCap', false,
      'entryReady', false
    );
  end if;

  if v_threshold_pct < 10 or v_threshold_pct > 20
     or v_max_market_cap_usd <= 0 or v_max_market_cap_usd > 20000
     or v_window_seconds < 30 or v_window_seconds > 3600 then
    raise exception 'supply accumulation config is outside its safety bounds';
  end if;

  v_window_started_at := p_as_of - make_interval(secs => v_window_seconds);

  with relevant as (
    select *
    from public.supply_accumulation_events e
    where e.user_id = p_user_id
      and e.token_mint = v_mint
      and e.target_wallet = any(v_targets)
      and e.event_at >= v_window_started_at
      and e.event_at <= p_as_of
  ), usable as (
    select * from relevant
    where not quarantined and classification_reliable and is_pump_fun
  )
  select
    (select count(*)::integer from relevant),
    (select count(*)::integer from usable),
    (select count(*)::integer from usable where side = 'buy'),
    (select count(*)::integer from usable where side = 'sell'),
    (select count(distinct total_supply_raw)::integer from usable),
    (select count(distinct decimals)::integer from usable),
    (select max(total_supply_raw) from usable),
    (select max(decimals) from usable),
    coalesce((select sum(amount_raw) from usable where side = 'buy'), 0),
    coalesce((select sum(amount_raw) from usable where side = 'sell'), 0),
    coalesce((select bool_and(is_pump_fun) from relevant where not quarantined), false),
    coalesce((select bool_and(classification_reliable) from relevant where not quarantined), false),
    exists(select 1 from usable where metadata @> '{"grossForwarded": true}'::jsonb),
    exists(select 1 from relevant where quarantined),
    coalesce((select array_agg(distinct target_wallet order by target_wallet) from usable), '{}')
  into
    v_relevant_count,
    v_usable_count,
    v_buy_count,
    v_sell_count,
    v_supply_count,
    v_decimals_count,
    v_total_supply_raw,
    v_decimals,
    v_gross_buy_raw,
    v_gross_sell_raw,
    v_pump_fun_verified,
    v_classification_reliable,
    v_direct_settlement_seen,
    v_payload_conflict,
    v_root_wallets;

  select max(slot)
  into v_last_event_slot
  from public.supply_accumulation_events e
  where e.user_id = p_user_id
    and e.token_mint = v_mint
    and e.target_wallet = any(v_targets)
    and e.event_at >= v_window_started_at
    and e.event_at <= p_as_of
    and not e.quarantined
    and e.classification_reliable
    and e.is_pump_fun;

  if v_last_event_slot is not null then
    select exists (
      select 1
      from public.supply_accumulation_events e
      where e.user_id = p_user_id
        and e.token_mint = v_mint
        and e.target_wallet = any(v_targets)
        and e.event_at >= v_window_started_at
        and e.event_at <= p_as_of
        and e.slot = v_last_event_slot
        and e.side = 'sell'
        and not e.quarantined
        and e.classification_reliable
        and e.is_pump_fun
    ) into v_max_slot_has_sell;
    v_last_event_side := case when v_max_slot_has_sell then 'sell' else 'buy' end;

    select event_key, event_at
    into v_last_event_key, v_last_event_at
    from public.supply_accumulation_events e
    where e.user_id = p_user_id
      and e.token_mint = v_mint
      and e.target_wallet = any(v_targets)
      and e.event_at >= v_window_started_at
      and e.event_at <= p_as_of
      and e.slot = v_last_event_slot
      and e.side = v_last_event_side
      and not e.quarantined
      and e.classification_reliable
      and e.is_pump_fun
    order by event_at desc, id desc
    limit 1;
  end if;

  select market_cap_usd, valuation_slot, market_data_reliable
  into v_latest_market_cap_usd, v_valuation_slot, v_latest_market_reliable
  from public.supply_accumulation_events e
  where e.user_id = p_user_id
    and e.token_mint = v_mint
    and e.target_wallet = any(v_targets)
    and e.event_at >= v_window_started_at
    and e.event_at <= p_as_of
    and e.side = 'buy'
    and not e.quarantined
    and e.classification_reliable
    and e.is_pump_fun
  order by valuation_slot desc nulls last, slot desc, event_at desc, id desc
  limit 1;

  v_net_acquired_raw := greatest(0, v_gross_buy_raw - v_gross_sell_raw);
  if v_total_supply_raw is not null and v_total_supply_raw > 0 then
    v_net_supply_bps := (v_net_acquired_raw * 10000) / v_total_supply_raw;
  end if;
  v_market_data_reliable := coalesce(v_latest_market_reliable, false)
    and v_latest_market_cap_usd is not null;
  v_data_reliable := v_relevant_count > 0
    and v_usable_count = v_relevant_count
    and v_supply_count = 1
    and v_decimals_count = 1
    and v_total_supply_raw is not null
    and v_total_supply_raw > 0
    and v_net_acquired_raw <= v_total_supply_raw
    and v_pump_fun_verified
    and v_classification_reliable
    and not v_payload_conflict;
  v_threshold_reached := v_data_reliable
    and (v_net_supply_bps / 100) >= v_threshold_pct;
  v_under_market_cap := v_market_data_reliable
    and v_latest_market_cap_usd < v_max_market_cap_usd;
  v_entry_ready := v_mode_enabled
    and v_data_reliable
    and v_threshold_reached
    and v_under_market_cap
    and v_last_event_side = 'buy';

  v_reason := case
    when not v_mode_enabled then 'mode_disabled'
    when v_payload_conflict then 'payload_conflict'
    when v_relevant_count = 0 then 'no_events_in_window'
    when not v_classification_reliable then 'classification_unreliable'
    when not v_pump_fun_verified then 'not_verified_pump_fun'
    when v_supply_count <> 1 or v_decimals_count <> 1 then 'supply_or_decimals_inconsistent'
    when v_net_acquired_raw > coalesce(v_total_supply_raw, 0) then 'net_supply_exceeds_total'
    when not v_market_data_reliable then 'market_data_unreliable'
    when not v_threshold_reached then 'threshold_not_reached'
    when not v_under_market_cap then 'market_cap_not_under_ceiling'
    when v_last_event_side <> 'buy' then 'latest_event_not_buy'
    else 'entry_ready'
  end;

  insert into public.supply_accumulation_state (
    user_id, token_mint, window_seconds, as_of, window_started_at,
    total_supply_raw, decimals, gross_buy_raw, gross_sell_raw, net_acquired_raw,
    net_supply_bps, buy_count, sell_count, root_wallets, last_event_key,
    last_event_at, last_event_slot, last_event_side, latest_market_cap_usd,
    valuation_slot, market_data_reliable, pump_fun_verified,
    classification_reliable, direct_settlement_seen, payload_conflict,
    data_reliable, threshold_pct,
    threshold_reached, max_market_cap_usd, under_market_cap, entry_ready, updated_at
  ) values (
    p_user_id, v_mint, v_window_seconds, p_as_of, v_window_started_at,
    v_total_supply_raw, v_decimals, v_gross_buy_raw, v_gross_sell_raw, v_net_acquired_raw,
    v_net_supply_bps, v_buy_count, v_sell_count, v_root_wallets, v_last_event_key,
    v_last_event_at, v_last_event_slot, v_last_event_side, v_latest_market_cap_usd,
    v_valuation_slot, v_market_data_reliable, v_pump_fun_verified,
    v_classification_reliable, v_direct_settlement_seen, v_payload_conflict,
    v_data_reliable, v_threshold_pct,
    v_threshold_reached, v_max_market_cap_usd, v_under_market_cap, v_entry_ready, now()
  )
  on conflict (user_id, token_mint) do update set
    window_seconds = excluded.window_seconds,
    as_of = excluded.as_of,
    window_started_at = excluded.window_started_at,
    total_supply_raw = excluded.total_supply_raw,
    decimals = excluded.decimals,
    gross_buy_raw = excluded.gross_buy_raw,
    gross_sell_raw = excluded.gross_sell_raw,
    net_acquired_raw = excluded.net_acquired_raw,
    net_supply_bps = excluded.net_supply_bps,
    buy_count = excluded.buy_count,
    sell_count = excluded.sell_count,
    root_wallets = excluded.root_wallets,
    last_event_key = excluded.last_event_key,
    last_event_at = excluded.last_event_at,
    last_event_slot = excluded.last_event_slot,
    last_event_side = excluded.last_event_side,
    latest_market_cap_usd = excluded.latest_market_cap_usd,
    valuation_slot = excluded.valuation_slot,
    market_data_reliable = excluded.market_data_reliable,
    pump_fun_verified = excluded.pump_fun_verified,
    classification_reliable = excluded.classification_reliable,
    direct_settlement_seen = excluded.direct_settlement_seen,
    payload_conflict = excluded.payload_conflict,
    data_reliable = excluded.data_reliable,
    threshold_pct = excluded.threshold_pct,
    threshold_reached = excluded.threshold_reached,
    max_market_cap_usd = excluded.max_market_cap_usd,
    under_market_cap = excluded.under_market_cap,
    entry_ready = excluded.entry_ready,
    updated_at = excluded.updated_at
  where excluded.as_of >= public.supply_accumulation_state.as_of;

  return jsonb_build_object(
    'ok', true,
    'reason', v_reason,
    'userId', p_user_id::text,
    'tokenMint', v_mint,
    'modeEnabled', v_mode_enabled,
    'windowSeconds', v_window_seconds,
    'asOf', p_as_of,
    'windowStartedAt', v_window_started_at,
    'totalSupplyRaw', case when v_total_supply_raw is null then null else v_total_supply_raw::text end,
    'decimals', v_decimals,
    'grossBuyRaw', v_gross_buy_raw::text,
    'grossSellRaw', v_gross_sell_raw::text,
    'netAcquiredRaw', v_net_acquired_raw::text,
    'netSupplyBps', v_net_supply_bps,
    'netSupplyPct', v_net_supply_bps / 100,
    'buyCount', v_buy_count,
    'sellCount', v_sell_count,
    'rootWallets', to_jsonb(v_root_wallets),
    'lastEventKey', v_last_event_key,
    'lastEventAt', v_last_event_at,
    'lastEventSlot', case when v_last_event_slot is null then null else v_last_event_slot::text end,
    'latestMarketCapUsd', v_latest_market_cap_usd,
    'valuationSlot', case when v_valuation_slot is null then null else v_valuation_slot::text end,
    'marketDataReliable', v_market_data_reliable,
    'pumpFunVerified', v_pump_fun_verified,
    'classificationReliable', v_classification_reliable,
    'directSettlementSeen', v_direct_settlement_seen,
    'payloadConflict', v_payload_conflict,
    'dataReliable', v_data_reliable,
    'thresholdPct', v_threshold_pct,
    'thresholdReached', v_threshold_reached,
    'maxMarketCapUsd', v_max_market_cap_usd,
    'underMarketCap', v_under_market_cap,
    'entryReady', v_entry_ready
  );
end;
$$;

-- Keep the state trigger, v2 floor wrapper, and durable scale planner on the
-- same ceiling. Their existing strict comparisons remain unchanged.
create or replace function public.materialize_supply_accumulation_market_cap_range()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_min_market_cap_usd numeric := 2000;
  v_max_market_cap_usd numeric := 20000;
begin
  select
    supply_accumulation_min_market_cap_usd,
    supply_accumulation_max_market_cap_usd
  into v_min_market_cap_usd, v_max_market_cap_usd
  from public.bot_config
  where user_id = new.user_id;
  if not found then
    v_min_market_cap_usd := 2000;
    v_max_market_cap_usd := 20000;
  end if;
  if v_min_market_cap_usd < 0
     or v_min_market_cap_usd >= v_max_market_cap_usd
     or v_max_market_cap_usd > 20000 then
    raise exception 'supply accumulation market-cap range is outside safety bounds';
  end if;

  new.min_market_cap_usd := v_min_market_cap_usd;
  new.max_market_cap_usd := v_max_market_cap_usd;
  new.above_market_cap_floor := coalesce(
    new.market_data_reliable
      and new.latest_market_cap_usd >= v_min_market_cap_usd,
    false
  );
  new.under_market_cap := coalesce(
    new.market_data_reliable
      and new.latest_market_cap_usd < v_max_market_cap_usd,
    false
  );
  new.within_market_cap_range := new.above_market_cap_floor and new.under_market_cap;
  new.entry_ready := new.entry_ready and new.within_market_cap_range;
  return new;
end $$;

create or replace function public.get_supply_accumulation_state(
  p_user_id uuid,
  p_token_mint text,
  p_as_of timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_mint text := btrim(coalesce(p_token_mint, ''));
  v_base jsonb;
  v_min_market_cap_usd numeric := 2000;
  v_max_market_cap_usd numeric := 20000;
  v_latest_market_cap_usd numeric;
  v_market_data_reliable boolean := false;
  v_above_market_cap_floor boolean := false;
  v_under_market_cap boolean := false;
  v_within_market_cap_range boolean := false;
  v_entry_ready boolean := false;
  v_reason text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'service_role is required for supply accumulation state';
  end if;
  if p_user_id is null or v_mint = '' or p_as_of is null then
    raise exception 'supply accumulation state requires user, mint, and as-of time';
  end if;

  select
    supply_accumulation_min_market_cap_usd,
    supply_accumulation_max_market_cap_usd
  into v_min_market_cap_usd, v_max_market_cap_usd
  from public.bot_config
  where user_id = p_user_id;
  if not found then
    v_min_market_cap_usd := 2000;
    v_max_market_cap_usd := 20000;
  elsif v_min_market_cap_usd < 0
     or v_min_market_cap_usd >= v_max_market_cap_usd
     or v_max_market_cap_usd > 20000 then
    raise exception 'supply accumulation market-cap range is outside safety bounds';
  end if;

  v_base := public.get_supply_accumulation_state_without_floor_v1(
    p_user_id,
    v_mint,
    p_as_of
  );
  v_market_data_reliable := coalesce((v_base ->> 'marketDataReliable')::boolean, false);
  if v_base ->> 'latestMarketCapUsd' is not null then
    v_latest_market_cap_usd := (v_base ->> 'latestMarketCapUsd')::numeric;
  end if;
  v_above_market_cap_floor := v_market_data_reliable
    and v_latest_market_cap_usd is not null
    and v_latest_market_cap_usd >= v_min_market_cap_usd;
  v_under_market_cap := v_market_data_reliable
    and v_latest_market_cap_usd is not null
    and v_latest_market_cap_usd < v_max_market_cap_usd;
  v_within_market_cap_range := v_above_market_cap_floor and v_under_market_cap;
  v_entry_ready := coalesce((v_base ->> 'entryReady')::boolean, false)
    and v_within_market_cap_range;
  v_reason := case
    when v_market_data_reliable and not v_above_market_cap_floor
      then 'market_cap_below_floor'
    when v_market_data_reliable and not v_under_market_cap
      then 'market_cap_not_under_ceiling'
    else coalesce(v_base ->> 'reason', 'state_ready')
  end;

  update public.supply_accumulation_state set
    min_market_cap_usd = v_min_market_cap_usd,
    max_market_cap_usd = v_max_market_cap_usd,
    above_market_cap_floor = v_above_market_cap_floor,
    under_market_cap = v_under_market_cap,
    within_market_cap_range = v_within_market_cap_range,
    entry_ready = v_entry_ready,
    updated_at = now()
  where user_id = p_user_id
    and token_mint = v_mint
    and as_of = p_as_of;

  return v_base || jsonb_build_object(
    'reason', v_reason,
    'minMarketCapUsd', v_min_market_cap_usd,
    'maxMarketCapUsd', v_max_market_cap_usd,
    'aboveMarketCapFloor', v_above_market_cap_floor,
    'underMarketCap', v_under_market_cap,
    'withinMarketCapRange', v_within_market_cap_range,
    'entryReady', v_entry_ready
  );
end $$;

-- Repair the durable event recorder as part of this additive migration. The
-- deployed SECURITY DEFINER search path intentionally excludes extensions, so
-- pgcrypto must be schema-qualified instead of relying on ambient resolution.
create or replace function public.record_supply_accumulation_event(
  p_user_id uuid,
  p_event_key text,
  p_tx_sig text,
  p_slot bigint,
  p_event_at timestamptz,
  p_target_wallet text,
  p_token_mint text,
  p_side text,
  p_amount_raw text,
  p_total_supply_raw text,
  p_decimals integer,
  p_market_cap_usd numeric,
  p_valuation_slot bigint,
  p_market_data_reliable boolean,
  p_is_pump_fun boolean,
  p_classification_reliable boolean,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_event_key text := btrim(coalesce(p_event_key, ''));
  v_tx_sig text := btrim(coalesce(p_tx_sig, ''));
  v_target text := btrim(coalesce(p_target_wallet, ''));
  v_mint text := btrim(coalesce(p_token_mint, ''));
  v_side text := lower(btrim(coalesce(p_side, '')));
  v_amount_raw numeric(78, 0);
  v_total_supply_raw numeric(78, 0);
  v_fingerprint text;
  v_mode_enabled boolean;
  v_target_configured boolean := false;
  v_existing public.supply_accumulation_events%rowtype;
  v_event_id uuid;
  v_state jsonb;
  v_enriched boolean := false;
  v_supply_mismatch boolean := false;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'service_role is required to record supply accumulation events';
  end if;

  if p_user_id is null or v_event_key = '' or v_tx_sig = '' or v_target = '' or v_mint = '' then
    raise exception 'supply accumulation event identity is incomplete';
  end if;
  if p_slot is null or p_slot < 0 or p_event_at is null then
    raise exception 'supply accumulation event chain position is invalid';
  end if;
  if v_side not in ('buy', 'sell') then
    raise exception 'supply accumulation event side is invalid';
  end if;
  if coalesce(p_amount_raw, '') !~ '^[0-9]+$'
     or coalesce(p_total_supply_raw, '') !~ '^[0-9]+$' then
    raise exception 'supply accumulation raw values must be unsigned integer strings';
  end if;
  v_amount_raw := p_amount_raw::numeric(78, 0);
  v_total_supply_raw := p_total_supply_raw::numeric(78, 0);
  if v_amount_raw <= 0 or v_total_supply_raw <= 0 or v_amount_raw > v_total_supply_raw then
    raise exception 'supply accumulation raw values are outside supply bounds';
  end if;
  if p_decimals is null or p_decimals < 0 or p_decimals > 18 then
    raise exception 'supply accumulation decimals are invalid';
  end if;
  if p_market_cap_usd is not null and p_market_cap_usd <= 0 then
    raise exception 'supply accumulation market cap is invalid';
  end if;
  if p_market_data_reliable is true
     and (p_market_cap_usd is null or p_valuation_slot is null) then
    raise exception 'reliable market data requires market cap and valuation slot';
  end if;
  if p_valuation_slot is not null and p_valuation_slot < 0 then
    raise exception 'supply accumulation valuation slot is invalid';
  end if;
  if p_market_data_reliable is null or p_is_pump_fun is null
     or p_classification_reliable is null then
    raise exception 'supply accumulation evidence flags are required';
  end if;
  if p_metadata is null or jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'supply accumulation metadata must be an object';
  end if;

  select
    supply_accumulation_mode_enabled,
    v_target = any(
      array_remove(
        array_prepend(nullif(btrim(target_wallet), ''), additional_target_wallets),
        null
      )
    )
  into v_mode_enabled, v_target_configured
  from public.bot_config
  where user_id = p_user_id;

  if not found then
    v_state := public.get_supply_accumulation_state(p_user_id, v_mint, p_event_at);
    return jsonb_build_object(
      'applied', false, 'duplicate', false, 'payloadMismatch', false,
      'reason', 'config_not_found', 'eventId', null, 'state', v_state
    );
  end if;
  if not v_mode_enabled then
    v_state := public.get_supply_accumulation_state(p_user_id, v_mint, p_event_at);
    return jsonb_build_object(
      'applied', false, 'duplicate', false, 'payloadMismatch', false,
      'reason', 'mode_disabled', 'eventId', null, 'state', v_state
    );
  end if;
  if not v_target_configured then
    v_state := public.get_supply_accumulation_state(p_user_id, v_mint, p_event_at);
    return jsonb_build_object(
      'applied', false, 'duplicate', false, 'payloadMismatch', false,
      'reason', 'target_not_configured', 'eventId', null, 'state', v_state
    );
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(v_mint));
  v_fingerprint := encode(extensions.digest(jsonb_build_object(
    'txSig', v_tx_sig,
    'slot', p_slot,
    'targetWallet', v_target,
    'tokenMint', v_mint,
    'side', v_side,
    'amountRaw', v_amount_raw::text,
    'totalSupplyRaw', v_total_supply_raw::text,
    'decimals', p_decimals
  )::text, 'sha256'), 'hex');

  select * into v_existing
  from public.supply_accumulation_events
  where user_id = p_user_id and event_key = v_event_key
  for update;

  if found then
    if v_existing.request_fingerprint <> v_fingerprint then
      update public.supply_accumulation_events set
        quarantined = true,
        conflict_count = conflict_count + 1,
        last_conflict_at = now(),
        metadata = metadata || jsonb_build_object(
          'payloadConflictObserved', true,
          'payloadConflictObservedAt', now()
        )
      where id = v_existing.id;
      v_state := public.get_supply_accumulation_state(p_user_id, v_mint, p_event_at);
      return jsonb_build_object(
        'applied', false, 'duplicate', true, 'payloadMismatch', true,
        'reason', 'payload_mismatch', 'eventId', v_existing.id::text, 'state', v_state
      );
    end if;

    v_enriched := p_market_data_reliable
      and (not v_existing.market_data_reliable or v_existing.market_cap_usd is null);
    update public.supply_accumulation_events set
      market_cap_usd = case when v_enriched then p_market_cap_usd else market_cap_usd end,
      valuation_slot = case when v_enriched then p_valuation_slot else valuation_slot end,
      market_data_reliable = market_data_reliable or v_enriched,
      metadata = case
        when metadata @> '{"grossForwarded": true}'::jsonb
          or p_metadata @> '{"grossForwarded": true}'::jsonb
        then metadata || p_metadata || '{"grossForwarded": true}'::jsonb
        else metadata || p_metadata
      end
    where id = v_existing.id;
    v_state := public.get_supply_accumulation_state(p_user_id, v_mint, p_event_at);
    return jsonb_build_object(
      'applied', false, 'duplicate', true, 'payloadMismatch', false,
      'reason', case when v_enriched then 'duplicate_enriched' else 'duplicate' end,
      'eventId', v_existing.id::text, 'state', v_state
    );
  end if;

  select exists (
    select 1
    from public.supply_accumulation_events e
    where e.user_id = p_user_id
      and e.token_mint = v_mint
      and not e.quarantined
      and (
        e.total_supply_raw <> v_total_supply_raw
        or e.decimals <> p_decimals
      )
  ) into v_supply_mismatch;

  insert into public.supply_accumulation_events (
    user_id, event_key, request_fingerprint, tx_sig, slot, event_at,
    target_wallet, token_mint, side, amount_raw, total_supply_raw, decimals,
    market_cap_usd, valuation_slot, market_data_reliable, is_pump_fun,
    classification_reliable, quarantined, conflict_count, last_conflict_at, metadata
  ) values (
    p_user_id, v_event_key, v_fingerprint, v_tx_sig, p_slot, p_event_at,
    v_target, v_mint, v_side, v_amount_raw, v_total_supply_raw, p_decimals,
    p_market_cap_usd, p_valuation_slot, p_market_data_reliable, p_is_pump_fun,
    p_classification_reliable, v_supply_mismatch,
    case when v_supply_mismatch then 1 else 0 end,
    case when v_supply_mismatch then now() else null end,
    case when v_supply_mismatch then
      p_metadata || jsonb_build_object(
        'supplyEvidenceConflict', true,
        'supplyEvidenceConflictObservedAt', now()
      )
    else p_metadata end
  )
  returning id into v_event_id;

  v_state := public.get_supply_accumulation_state(p_user_id, v_mint, p_event_at);
  return jsonb_build_object(
    'applied', not v_supply_mismatch, 'duplicate', false, 'payloadMismatch', false,
    'reason', case
      when v_supply_mismatch then 'supply_or_decimals_mismatch'
      when p_classification_reliable and p_is_pump_fun then 'recorded'
      else 'unreliable_evidence_recorded'
    end,
    'eventId', v_event_id::text,
    'state', v_state
  );
end;
$$;

create or replace function public.get_supply_accumulation_scale_plan(
  p_user_id uuid,
  p_token_mint text,
  p_position_id uuid,
  p_source_event_key text,
  p_claim_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_mint text := btrim(coalesce(p_token_mint, ''));
  v_event_key text := btrim(coalesce(p_source_event_key, ''));
  v_config public.bot_config%rowtype;
  v_position public.positions%rowtype;
  v_event public.supply_accumulation_events%rowtype;
  v_state public.supply_accumulation_state%rowtype;
  v_claim public.supply_accumulation_scale_claims%rowtype;
  v_existing_claim public.supply_accumulation_scale_claims%rowtype;
  v_targets text[] := array[]::text[];
  v_config_fingerprint text;
  v_tier integer;
  v_threshold numeric;
  v_buy_usd numeric;
  v_prior_source_slot bigint;
  v_initial_source_slot bigint;
  v_initial_source_tx_sig text;
  v_initial_source_wallet text;
  v_initial_custody_journey_id uuid;
  v_initial_custody_event_at timestamptz;
  v_net_supply_pct numeric;
  v_custody jsonb;
  v_base jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'service_role is required for Supply Accumulation scale planning';
  end if;

  v_base := jsonb_build_object(
    'ok', false,
    'eligible', false,
    'reason', 'invalid_request',
    'userId', case when p_user_id is null then null else p_user_id::text end,
    'tokenMint', nullif(v_mint, ''),
    'positionId', case when p_position_id is null then null else p_position_id::text end,
    'sourceEventKey', nullif(v_event_key, ''),
    'claimId', case when p_claim_id is null then null else p_claim_id::text end,
    'tierNumber', null,
    'thresholdPct', null,
    'buyUsd', null,
    'configFingerprint', null,
    'sourceTxSig', null,
    'sourceWallet', null,
    'sourceSlot', null,
    'tokenDecimals', null,
    'netSupplyPct', null,
    'marketCapUsd', null,
    'minMarketCapUsd', null,
    'maxMarketCapUsd', null
  );

  if p_user_id is null or p_position_id is null or v_mint = '' or v_event_key = '' then
    return v_base;
  end if;

  -- This is the same user/mint lock used by the durable event recorder and the
  -- custody gate. Take it before every state/event read so an uncommitted target
  -- sell cannot appear only after the lifetime veto snapshot.
  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(v_mint));

  select * into v_config
  from public.bot_config
  where user_id = p_user_id;
  if not found then
    return v_base || jsonb_build_object('reason', 'config_not_found');
  end if;

  v_targets := array(
    select distinct btrim(wallet)
    from unnest(
      array_remove(
        array_prepend(nullif(btrim(v_config.target_wallet), ''), v_config.additional_target_wallets),
        null
      )
    ) configured(wallet)
    where nullif(btrim(wallet), '') is not null
    order by btrim(wallet)
  );
  v_config_fingerprint := encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          'modeEnabled', v_config.supply_accumulation_mode_enabled,
          'custodyEnabled', v_config.custody_journey_enabled,
          'thresholdPct', v_config.supply_accumulation_threshold_pct,
          'buyUsd', v_config.supply_accumulation_buy_usd,
          'minMarketCapUsd', v_config.supply_accumulation_min_market_cap_usd,
          'maxMarketCapUsd', v_config.supply_accumulation_max_market_cap_usd,
          'windowSeconds', v_config.supply_accumulation_window_seconds,
          'scale2Enabled', v_config.supply_accumulation_scale_2_enabled,
          'scale2ThresholdPct', v_config.supply_accumulation_scale_2_threshold_pct,
          'scale2BuyUsd', v_config.supply_accumulation_scale_2_buy_usd,
          'scale3Enabled', v_config.supply_accumulation_scale_3_enabled,
          'scale3ThresholdPct', v_config.supply_accumulation_scale_3_threshold_pct,
          'scale3BuyUsd', v_config.supply_accumulation_scale_3_buy_usd,
          'scale4Enabled', v_config.supply_accumulation_scale_4_enabled,
          'scale4ThresholdPct', v_config.supply_accumulation_scale_4_threshold_pct,
          'scale4BuyUsd', v_config.supply_accumulation_scale_4_buy_usd,
          'targets', to_jsonb(v_targets)
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  v_base := v_base || jsonb_build_object(
    'ok', true,
    'configFingerprint', v_config_fingerprint,
    'minMarketCapUsd', v_config.supply_accumulation_min_market_cap_usd,
    'maxMarketCapUsd', v_config.supply_accumulation_max_market_cap_usd
  );

  if v_config.enabled is not true then
    return v_base || jsonb_build_object('reason', 'entries_disabled');
  end if;
  if v_config.supply_accumulation_mode_enabled is not true then
    return v_base || jsonb_build_object('reason', 'supply_mode_disabled');
  end if;
  if v_config.custody_journey_enabled is not true then
    return v_base || jsonb_build_object('reason', 'custody_journey_disabled');
  end if;
  if v_config.conviction_mode_enabled or v_config.coordinated_mode_enabled then
    return v_base || jsonb_build_object('reason', 'exclusive_entry_strategy_changed');
  end if;
  if cardinality(v_targets) = 0 then
    return v_base || jsonb_build_object('reason', 'target_wallets_missing');
  end if;
  if v_config.supply_accumulation_min_market_cap_usd < 0
     or v_config.supply_accumulation_min_market_cap_usd
        >= v_config.supply_accumulation_max_market_cap_usd
     or v_config.supply_accumulation_max_market_cap_usd > 20000 then
    return v_base || jsonb_build_object('reason', 'market_cap_config_invalid');
  end if;

  select * into v_position
  from public.positions
  where id = p_position_id
    and user_id = p_user_id
    and token_mint = v_mint;
  if not found then
    return v_base || jsonb_build_object('reason', 'position_not_found');
  end if;
  -- A repository-wide partial unique index would change every entry strategy
  -- and could reject a pre-existing non-Supply deployment. Instead, this
  -- service-only plan fails closed unless this is the sole open position for
  -- the user/mint; the durable claim then owns every later scale transition.
  if (
    select count(*)
    from public.positions p
    where p.user_id = p_user_id
      and p.token_mint = v_mint
      and p.closed_at is null
  ) <> 1 then
    return v_base || jsonb_build_object('reason', 'open_position_identity_not_unique');
  end if;
  if v_position.closed_at is not null
     or v_position.amount_remaining is distinct from v_position.amount_tokens
     or coalesce(v_position.amount_remaining, 0) <= 0
     or coalesce(v_position.entry_price_usd, 0) <= 0
     or coalesce(v_position.tp_taken, false)
     or coalesce(v_position.mirrored_sold_fraction, 0) <> 0
     or coalesce(v_position.coordinated_exit_triggered, false)
     or coalesce(v_position.follower_seller_exit_triggered, false) then
    return v_base || jsonb_build_object('reason', 'position_not_untouched');
  end if;

  if not exists (
    select 1
    from public.position_target_wallets linked
    where linked.user_id = p_user_id
      and linked.position_id = p_position_id
  ) then
    return v_base || jsonb_build_object('reason', 'position_target_wallets_missing');
  end if;

  select c.source_slot, c.source_tx_sig, c.source_wallet
    into v_initial_source_slot, v_initial_source_tx_sig, v_initial_source_wallet
  from public.entry_signal_claims c
  where c.user_id = p_user_id
    and c.planned_position_id = p_position_id
    and c.token_mint = v_mint
    and c.entry_strategy = 'supply_accumulation'
    and c.status = 'persisted'
  order by c.persisted_at desc nulls last, c.created_at desc
  limit 1;
  if not found or v_initial_source_slot is null or v_initial_source_slot <= 0 then
    return v_base || jsonb_build_object('reason', 'initial_supply_entry_not_persisted');
  end if;

  -- The position's target links are durable campaign identity. Current config
  -- still admits the new buy below, but removing a wallet from config can never
  -- erase sell evidence already tied to this exact position. Any persisted sell
  -- row is a permanent veto, including quarantined or unreliable observations.
  if exists (
    select 1
    from public.supply_accumulation_events e
    where e.user_id = p_user_id
      and e.token_mint = v_mint
      and e.side = 'sell'
      and e.slot >= v_initial_source_slot
      and (
        e.target_wallet = any(v_targets)
        or exists (
          select 1
          from public.position_target_wallets linked
          where linked.user_id = p_user_id
            and linked.position_id = p_position_id
            and linked.wallet = e.target_wallet
        )
      )
  ) then
    return v_base || jsonb_build_object('reason', 'lifetime_target_sell_recorded');
  end if;

  -- Anchor custody history to the exact initial entry rather than today's
  -- configured wallets. Custody writers share the user/mint advisory lock held
  -- by this plan, so no sell or unresolved outflow can commit between this
  -- lifetime snapshot and claim eligibility.
  select anchor.journey_id, anchor.event_at
    into v_initial_custody_journey_id, v_initial_custody_event_at
  from public.custody_journey_events anchor
  join public.custody_journeys journey
    on journey.id = anchor.journey_id
   and journey.user_id = p_user_id
   and journey.token_mint = v_mint
  join public.position_target_wallets linked
    on linked.user_id = p_user_id
   and linked.position_id = p_position_id
   and linked.wallet = anchor.source_wallet
  where anchor.user_id = p_user_id
    and anchor.event_type = 'VERIFIED_TARGET_BUY'
    and anchor.tx_sig = v_initial_source_tx_sig
    and anchor.slot = v_initial_source_slot
    and anchor.source_wallet = v_initial_source_wallet
  order by anchor.event_at asc, anchor.id asc
  limit 1;
  if not found then
    return v_base || jsonb_build_object('reason', 'initial_custody_journey_not_found');
  end if;

  if exists (
    select 1
    from public.custody_journeys journey
    where journey.id = v_initial_custody_journey_id
      and journey.user_id = p_user_id
      and journey.token_mint = v_mint
      and (
        journey.total_verified_custody_sell_tokens > 0
        or journey.total_unresolved_outflow_tokens > 0
      )
  ) or exists (
    select 1
    from public.custody_journey_wallets wallet_state
    where wallet_state.journey_id = v_initial_custody_journey_id
      and wallet_state.user_id = p_user_id
      and wallet_state.token_mint = v_mint
      and (
        wallet_state.total_verified_sold_tokens > 0
        or wallet_state.total_unresolved_outflow_tokens > 0
      )
  ) or exists (
    select 1
    from public.custody_journey_events custody_event
    where custody_event.journey_id = v_initial_custody_journey_id
      and custody_event.user_id = p_user_id
      and (
        custody_event.slot >= v_initial_source_slot
        or (
          custody_event.slot is null
          and custody_event.event_at >= v_initial_custody_event_at
        )
      )
      and (
        custody_event.event_type = 'VERIFIED_CUSTODY_SELL'
        or (
          custody_event.event_type = 'CUSTODY_TRANSFER'
          and (
            custody_event.result_reason in (
              'partial_unobserved_outflow', 'partial_unresolved_outflow'
            )
            or coalesce(custody_event.metadata ->> 'observationKind', '')
              = 'CUSTODY_UNRESOLVED_OUTFLOW'
          )
        )
      )
  ) or exists (
    select 1
    from public.custody_pending_events pending
    where pending.user_id = p_user_id
      and pending.token_mint = v_mint
      and pending.status <> 'applied'
      and (
        pending.slot >= v_initial_source_slot
        or (
          pending.slot is null
          and pending.event_at >= v_initial_custody_event_at
        )
      )
      and (
        pending.journey_id = v_initial_custody_journey_id
        or exists (
          select 1
          from public.custody_journey_wallets descendant
          where descendant.journey_id = v_initial_custody_journey_id
            and descendant.user_id = p_user_id
            and descendant.token_mint = v_mint
            and descendant.wallet = pending.source_wallet
        )
      )
  ) then
    return v_base || jsonb_build_object(
      'reason', 'lifetime_custody_distribution_recorded'
    );
  end if;

  if exists (
    select 1
    from public.supply_accumulation_scale_claims repaired
    where repaired.user_id = p_user_id
      and repaired.position_id = p_position_id
      and repaired.status = 'persisted'
      and repaired.post_apply_repaired_at is null
  ) then
    return v_base || jsonb_build_object('reason', 'post_apply_repair_pending');
  end if;

  if exists (
    select 1 from public.sell_signal_claims s
    where s.user_id = p_user_id and s.position_id = p_position_id
  ) then
    return v_base || jsonb_build_object('reason', 'position_exit_claim_recorded');
  end if;
  if exists (
    select 1 from public.trades t
    where t.user_id = p_user_id and t.position_id = p_position_id and t.side = 'sell'
  ) then
    return v_base || jsonb_build_object('reason', 'position_sell_recorded');
  end if;

  select * into v_event
  from public.supply_accumulation_events e
  where e.user_id = p_user_id
    and e.event_key = v_event_key;
  if not found then
    return v_base || jsonb_build_object('reason', 'source_event_not_found');
  end if;
  v_base := v_base || jsonb_build_object(
    'sourceTxSig', v_event.tx_sig,
    'sourceWallet', v_event.target_wallet,
    'sourceSlot', v_event.slot::text,
    'tokenDecimals', v_event.decimals
  );
  if v_event.token_mint <> v_mint
     or v_event.side <> 'buy'
     or v_event.quarantined
     or not v_event.is_pump_fun
     or not v_event.classification_reliable
     or not (v_event.target_wallet = any(v_targets)) then
    return v_base || jsonb_build_object('reason', 'source_event_not_eligible');
  end if;
  if v_event.event_at < now() - interval '55 seconds'
     or v_event.event_at > now() + interval '5 seconds' then
    return v_base || jsonb_build_object('reason', 'source_event_stale');
  end if;

  select * into v_state
  from public.supply_accumulation_state s
  where s.user_id = p_user_id
    and s.token_mint = v_mint;
  if not found then
    return v_base || jsonb_build_object('reason', 'supply_state_not_found');
  end if;
  v_net_supply_pct := v_state.net_supply_bps / 100;
  v_base := v_base || jsonb_build_object(
    'netSupplyPct', v_net_supply_pct,
    'marketCapUsd', v_state.latest_market_cap_usd
  );
  if not v_state.data_reliable
     or v_state.payload_conflict
     or not v_state.market_data_reliable
     or v_state.min_market_cap_usd is distinct from v_config.supply_accumulation_min_market_cap_usd
     or v_state.max_market_cap_usd is distinct from v_config.supply_accumulation_max_market_cap_usd
     or not v_state.above_market_cap_floor
     or not v_state.under_market_cap
     or not v_state.within_market_cap_range
     or not v_state.pump_fun_verified
     or not v_state.classification_reliable
     or v_state.last_event_side <> 'buy'
     or v_state.last_event_key is distinct from v_event_key
     or v_state.last_event_slot is distinct from v_event.slot
     or v_state.as_of < now() - interval '55 seconds' then
    return v_base || jsonb_build_object('reason', 'supply_state_not_current');
  end if;
  if v_state.latest_market_cap_usd is null
     or v_state.latest_market_cap_usd < v_config.supply_accumulation_min_market_cap_usd
     or v_state.latest_market_cap_usd >= v_config.supply_accumulation_max_market_cap_usd then
    return v_base || jsonb_build_object('reason', 'market_cap_outside_configured_range');
  end if;

  v_custody := public.check_supply_accumulation_custody_gate(
    p_user_id,
    v_mint,
    v_state.window_started_at,
    v_event.tx_sig,
    v_event.slot,
    v_event.target_wallet
  );
  if coalesce((v_custody ->> 'safe')::boolean, false) is not true then
    return v_base || jsonb_build_object(
      'reason', 'custody_gate_blocked',
      'custodyReason', coalesce(v_custody ->> 'reason', 'unknown')
    );
  end if;

  if p_claim_id is not null then
    select * into v_claim
    from public.supply_accumulation_scale_claims c
    where c.id = p_claim_id
      and c.user_id = p_user_id;
    if not found then
      return v_base || jsonb_build_object('reason', 'scale_claim_not_found');
    end if;
    if v_claim.token_mint <> v_mint
       or v_claim.position_id <> p_position_id
       or v_claim.source_event_key <> v_event_key
       or v_claim.status <> 'submitted' then
      return v_base || jsonb_build_object('reason', 'scale_claim_identity_changed');
    end if;
    v_tier := v_claim.tier_number;
  else
    if v_config.supply_accumulation_scale_2_enabled
       and not exists (
         select 1 from public.supply_accumulation_scale_claims c
         where c.user_id = p_user_id and c.token_mint = v_mint
           and c.position_id = p_position_id
           and c.tier_number = 2 and c.status = 'persisted'
       ) then
      v_tier := 2;
    elsif v_config.supply_accumulation_scale_3_enabled
       and exists (
         select 1 from public.supply_accumulation_scale_claims c
         where c.user_id = p_user_id and c.token_mint = v_mint
           and c.position_id = p_position_id
           and c.tier_number = 2 and c.status = 'persisted'
           and c.post_apply_repaired_at is not null
       )
       and not exists (
         select 1 from public.supply_accumulation_scale_claims c
         where c.user_id = p_user_id and c.token_mint = v_mint
           and c.position_id = p_position_id
           and c.tier_number = 3 and c.status = 'persisted'
       ) then
      v_tier := 3;
    elsif v_config.supply_accumulation_scale_4_enabled
       and exists (
         select 1 from public.supply_accumulation_scale_claims c
         where c.user_id = p_user_id and c.token_mint = v_mint
           and c.position_id = p_position_id
           and c.tier_number = 3 and c.status = 'persisted'
           and c.post_apply_repaired_at is not null
       )
       and not exists (
         select 1 from public.supply_accumulation_scale_claims c
         where c.user_id = p_user_id and c.token_mint = v_mint
           and c.position_id = p_position_id
           and c.tier_number = 4 and c.status = 'persisted'
       ) then
      v_tier := 4;
    else
      return v_base || jsonb_build_object('reason', 'no_enabled_scale_tier_pending');
    end if;

    select * into v_existing_claim
    from public.supply_accumulation_scale_claims c
    where c.user_id = p_user_id
      and c.token_mint = v_mint
      and c.tier_number = v_tier;
    if found and v_existing_claim.status <> 'failed_pre_submit' then
      return v_base || jsonb_build_object(
        'reason', 'scale_tier_already_claimed',
        'tierNumber', v_tier
      );
    end if;
  end if;

  if v_tier = 2 then
    if not v_config.supply_accumulation_scale_2_enabled then
      return v_base || jsonb_build_object('reason', 'scale_tier_disabled');
    end if;
    v_threshold := v_config.supply_accumulation_scale_2_threshold_pct;
    v_buy_usd := v_config.supply_accumulation_scale_2_buy_usd;
    v_prior_source_slot := v_initial_source_slot;
  elsif v_tier = 3 then
    if not v_config.supply_accumulation_scale_2_enabled
       or not v_config.supply_accumulation_scale_3_enabled then
      return v_base || jsonb_build_object('reason', 'scale_tier_prerequisite_disabled');
    end if;
    v_threshold := v_config.supply_accumulation_scale_3_threshold_pct;
    v_buy_usd := v_config.supply_accumulation_scale_3_buy_usd;
    select c.source_slot into v_prior_source_slot
    from public.supply_accumulation_scale_claims c
    where c.user_id = p_user_id and c.token_mint = v_mint
      and c.position_id = p_position_id
      and c.tier_number = 2 and c.status = 'persisted'
      and c.post_apply_repaired_at is not null;
  elsif v_tier = 4 then
    if not v_config.supply_accumulation_scale_2_enabled
       or not v_config.supply_accumulation_scale_3_enabled
       or not v_config.supply_accumulation_scale_4_enabled then
      return v_base || jsonb_build_object('reason', 'scale_tier_prerequisite_disabled');
    end if;
    v_threshold := v_config.supply_accumulation_scale_4_threshold_pct;
    v_buy_usd := v_config.supply_accumulation_scale_4_buy_usd;
    select c.source_slot into v_prior_source_slot
    from public.supply_accumulation_scale_claims c
    where c.user_id = p_user_id and c.token_mint = v_mint
      and c.position_id = p_position_id
      and c.tier_number = 3 and c.status = 'persisted'
      and c.post_apply_repaired_at is not null;
  else
    return v_base || jsonb_build_object('reason', 'scale_tier_invalid');
  end if;

  v_base := v_base || jsonb_build_object(
    'tierNumber', v_tier,
    'thresholdPct', v_threshold,
    'buyUsd', v_buy_usd
  );
  if v_prior_source_slot is null or v_event.slot <= v_prior_source_slot then
    return v_base || jsonb_build_object('reason', 'scale_requires_later_buy_event');
  end if;
  if v_net_supply_pct < v_threshold then
    return v_base || jsonb_build_object('reason', 'scale_threshold_not_reached');
  end if;
  if p_claim_id is not null and (
    v_claim.config_fingerprint <> v_config_fingerprint
    or v_claim.threshold_pct <> v_threshold
    or v_claim.planned_buy_usd <> v_buy_usd
    or v_claim.source_tx_sig <> v_event.tx_sig
    or v_claim.source_wallet <> v_event.target_wallet
    or v_claim.source_slot <> v_event.slot
    or v_claim.token_decimals <> v_event.decimals
  ) then
    return v_base || jsonb_build_object('reason', 'scale_claim_config_or_source_changed');
  end if;

  return v_base || jsonb_build_object(
    'ok', true,
    'eligible', true,
    'reason', 'scale_ready'
  );
end $$;

-- CREATE OR REPLACE preserves ownership. Reassert the least-privilege contract
-- explicitly so the compatibility migration is safe on drifted deployments.
revoke all on function public.materialize_supply_accumulation_market_cap_range()
  from public, anon, authenticated;
revoke all on function public.get_supply_accumulation_state_without_floor_v1(
  uuid, text, timestamptz
) from public, anon, authenticated;
revoke all on function public.get_supply_accumulation_state(uuid, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.record_supply_accumulation_event(
  uuid, text, text, bigint, timestamptz, text, text, text, text, text,
  integer, numeric, bigint, boolean, boolean, boolean, jsonb
) from public, anon, authenticated;
revoke all on function public.get_supply_accumulation_scale_plan(uuid, text, uuid, text, uuid)
  from public, anon, authenticated;

grant execute on function public.get_supply_accumulation_state_without_floor_v1(
  uuid, text, timestamptz
) to service_role;
grant execute on function public.get_supply_accumulation_state(uuid, text, timestamptz)
  to service_role;
grant execute on function public.record_supply_accumulation_event(
  uuid, text, text, bigint, timestamptz, text, text, text, text, text,
  integer, numeric, bigint, boolean, boolean, boolean, jsonb
) to service_role;
grant execute on function public.get_supply_accumulation_scale_plan(uuid, text, uuid, text, uuid)
  to service_role;

-- Fail the transaction if any object did not finish on the same 20k contract.
do $$
begin
  if exists (
    select 1
    from pg_constraint c
    where c.contype = 'c'
      and c.conrelid in (
        'public.bot_config'::regclass,
        'public.supply_accumulation_state'::regclass
      )
      and position('15000' in pg_get_constraintdef(c.oid)) > 0
      and (
        pg_get_constraintdef(c.oid) like '%supply_accumulation_max_market_cap_usd%'
        or pg_get_constraintdef(c.oid) like '%max_market_cap_usd%'
      )
  ) then
    raise exception 'a legacy Supply Accumulation 15k constraint remains installed';
  end if;
  if exists (
    select 1
    from unnest(array[
      to_regprocedure(
        'public.get_supply_accumulation_state_without_floor_v1(uuid,text,timestamp with time zone)'
      ),
      to_regprocedure(
        'public.get_supply_accumulation_state(uuid,text,timestamp with time zone)'
      ),
      to_regprocedure(
        'public.materialize_supply_accumulation_market_cap_range()'
      ),
      to_regprocedure(
        'public.record_supply_accumulation_event(uuid,text,text,bigint,timestamp with time zone,text,text,text,text,text,integer,numeric,bigint,boolean,boolean,boolean,jsonb)'
      ),
      to_regprocedure(
        'public.get_supply_accumulation_scale_plan(uuid,text,uuid,text,uuid)'
      )
    ]) routine(oid)
    where position('15000' in pg_get_functiondef(routine.oid)) > 0
  ) then
    raise exception 'a legacy Supply Accumulation 15k routine remains installed';
  end if;
  if exists (
    select 1
    from unnest(array[
      to_regprocedure(
        'public.record_supply_accumulation_event(uuid,text,text,bigint,timestamp with time zone,text,text,text,text,text,integer,numeric,bigint,boolean,boolean,boolean,jsonb)'
      ),
      to_regprocedure(
        'public.get_supply_accumulation_scale_plan(uuid,text,uuid,text,uuid)'
      )
    ]) routine(oid)
    where position('extensions.digest(' in pg_get_functiondef(routine.oid)) = 0
  ) then
    raise exception 'a Supply Accumulation pgcrypto call is not schema-qualified';
  end if;
  if exists (
    select 1
    from public.bot_config
    where supply_accumulation_max_market_cap_usd > 20000
       or supply_accumulation_min_market_cap_usd < 0
       or supply_accumulation_min_market_cap_usd
          >= supply_accumulation_max_market_cap_usd
  ) then
    raise exception 'Supply Accumulation config exceeds the strict 20k safety contract';
  end if;
  if exists (
    select 1
    from public.supply_accumulation_state
    where max_market_cap_usd > 20000
       or min_market_cap_usd < 0
       or min_market_cap_usd >= max_market_cap_usd
       or within_market_cap_range is distinct from (
         above_market_cap_floor and under_market_cap
       )
       or (entry_ready and not within_market_cap_range)
  ) then
    raise exception 'Supply Accumulation state exceeds the strict 20k safety contract';
  end if;
end $$;

commit;
-- SUPPLY_ACCUMULATION_20K_CAP_CANONICAL_MIRROR_END

-- SUPPLY_ACCUMULATION_CUSTODY_GATE_HOTFIX_CANONICAL_MIRROR_BEGIN
-- Supply Accumulation custody gate recovery hotfix.
--
-- Scope only the persisted cursor backlog audit to wallets that can affect a
-- new or currently active custody journey: current configured targets and
-- active, positively attributed custody wallets. The live heartbeat remains a
-- separate global safety proof and must still be fresh, healthy, and report
-- rpc_backlog_wallet_count = 0.
--
-- This migration is additive and rerunnable. It never deletes, advances,
-- clears, or otherwise mutates custody/trading cursor history, strategy
-- toggles, positions, trades, claims, custody evidence, or exit state.

begin;

do $$
begin
  if to_regclass('public.bot_config') is null
     or to_regclass('public.custody_worker_heartbeat') is null
     or to_regclass('public.custody_rpc_wallet_cursors') is null
     or to_regclass('public.custody_journeys') is null
     or to_regclass('public.custody_journey_wallets') is null
     or to_regclass('public.custody_journey_events') is null
     or to_regclass('public.custody_pending_events') is null
     or to_regprocedure(
       'public.check_supply_accumulation_custody_gate(uuid,text,timestamp with time zone,text,bigint,text)'
     ) is null then
    raise exception using
      errcode = '42883',
      message = 'run the Custody Journey and Supply Accumulation entry migrations before the custody gate hotfix';
  end if;
end $$;

create or replace function public.check_supply_accumulation_custody_gate(
  p_user_id uuid,
  p_token_mint text,
  p_window_started_at timestamptz,
  p_trigger_tx_sig text,
  p_trigger_slot bigint,
  p_target_wallet text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_mint text := btrim(coalesce(p_token_mint, ''));
  v_tx_sig text := btrim(coalesce(p_trigger_tx_sig, ''));
  v_target text := btrim(coalesce(p_target_wallet, ''));
  v_reason text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'service_role is required for the supply accumulation custody gate';
  end if;

  if p_user_id is null
     or v_mint = ''
     or p_window_started_at is null
     or p_window_started_at > now()
     or v_tx_sig = ''
     or p_trigger_slot is null
     or p_trigger_slot < 0
     or v_target = '' then
    return jsonb_build_object('safe', false, 'reason', 'invalid_request');
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(v_mint));

  with config as materialized (
    select
      custody_journey_enabled,
      array(
        select distinct btrim(configured.wallet)
        from unnest(
          array_remove(
            array_prepend(
              nullif(btrim(target_wallet), ''),
              coalesce(additional_target_wallets, array[]::text[])
            ),
            null
          )
        ) configured(wallet)
        where nullif(btrim(configured.wallet), '') is not null
        order by btrim(configured.wallet)
      ) as configured_target_wallets
    from public.bot_config
    where user_id = p_user_id
  ), heartbeat as materialized (
    select *
    from public.custody_worker_heartbeat
    where user_id = p_user_id
  ), configured_targets as materialized (
    select configured.wallet
    from config
    cross join lateral unnest(config.configured_target_wallets) configured(wallet)
  ), active_positive_custody_wallets as materialized (
    select distinct btrim(w.wallet) as wallet
    from public.custody_journey_wallets w
    join public.custody_journeys j on j.id = w.journey_id
    where j.user_id = p_user_id
      and j.status = 'active'
      and j.current_attributed_tokens > 0
      and w.user_id = p_user_id
      and w.watch_status = 'active'
      and w.current_attributed_tokens > 0
      and nullif(btrim(w.wallet), '') is not null
  ), relevant_backlog_wallets as materialized (
    select wallet from configured_targets
    union
    select wallet from active_positive_custody_wallets
  ), window_journeys as materialized (
    select j.*
    from public.custody_journeys j
    where j.user_id = p_user_id
      and j.token_mint = v_mint
      and j.started_at <= now()
      and j.last_activity_at >= p_window_started_at
  ), facts as (
    select
      exists(select 1 from config) as config_exists,
      coalesce((select custody_journey_enabled from config), false) as config_enabled,
      exists(select 1 from heartbeat) as heartbeat_exists,
      coalesce((select enabled from heartbeat), false) as heartbeat_enabled,
      coalesce((select not degraded from heartbeat), false) as heartbeat_not_degraded,
      coalesce((
        select updated_at >= now() - interval '60 seconds' and updated_at <= now()
        from heartbeat
      ), false) as heartbeat_fresh,
      coalesce((
        select rpc_last_success_at is not null
          and rpc_last_success_at >= now() - interval '60 seconds'
          and rpc_last_success_at <= now()
        from heartbeat
      ), false) as rpc_fresh,
      coalesce((select rpc_backlog_wallet_count = 0 from heartbeat), false)
        and not exists (
          select 1
          from public.custody_rpc_wallet_cursors c
          join relevant_backlog_wallets relevant
            on relevant.wallet = btrim(c.wallet)
          where c.user_id = p_user_id
            and c.backlog_detected
        ) as backlog_clear,
      exists (
        select 1
        from public.custody_journey_events e
        join public.custody_journeys j on j.id = e.journey_id
        where e.user_id = p_user_id
          and e.event_type = 'VERIFIED_TARGET_BUY'
          and e.tx_sig = v_tx_sig
          and e.slot = p_trigger_slot
          and e.source_wallet = v_target
          and e.event_at >= p_window_started_at
          and e.event_at <= now()
          and e.evidence_reliable
          and e.applied_amount_tokens > 0
          and e.applied_amount_tokens = e.requested_amount_tokens
          and e.result_reason is null
          and e.result_journey_status = 'active'
          and not e.journey_released
          and j.user_id = p_user_id
          and j.token_mint = v_mint
          and j.status = 'active'
      ) as trigger_buy_verified,
      exists (
        select 1
        from public.custody_journey_events e
        join window_journeys j on j.id = e.journey_id
        where e.user_id = p_user_id
          and e.event_type = 'VERIFIED_CUSTODY_SELL'
          and e.evidence_reliable
          and e.applied_amount_tokens > 0
      ) as verified_sell_seen,
      exists (
        select 1 from window_journeys j
        where j.total_unresolved_outflow_tokens > 0
      ) or exists (
        select 1
        from public.custody_journey_wallets w
        join window_journeys j on j.id = w.journey_id
        where w.user_id = p_user_id
          and w.token_mint = v_mint
          and w.total_unresolved_outflow_tokens > 0
      ) or exists (
        select 1
        from public.custody_pending_events p
        where p.user_id = p_user_id
          and p.token_mint = v_mint
          and p.event_at >= p_window_started_at
          and p.status <> 'applied'
      ) as unresolved_outflow_seen,
      exists (
        select 1
        from public.custody_journey_wallets w
        join public.custody_journeys j on j.id = w.journey_id
        where j.user_id = p_user_id
          and j.token_mint = v_mint
          and j.status = 'active'
          and j.current_attributed_tokens > 0
          and w.user_id = p_user_id
          and w.token_mint = v_mint
          and w.watch_status = 'active'
          and w.current_attributed_tokens > 0
      ) as positive_attribution_seen
  ), decision as (
    select case
      when not config_exists then 'config_not_found'
      when not config_enabled then 'custody_journey_disabled'
      when not heartbeat_exists then 'custody_heartbeat_missing'
      when not heartbeat_enabled then 'custody_heartbeat_disabled'
      when not heartbeat_not_degraded then 'custody_heartbeat_degraded'
      when not heartbeat_fresh then 'custody_heartbeat_stale'
      when not rpc_fresh then 'custody_rpc_stale'
      when not backlog_clear then 'custody_backlog'
      when not trigger_buy_verified then 'trigger_buy_not_verified'
      when verified_sell_seen then 'verified_custody_sell_seen'
      when unresolved_outflow_seen then 'unresolved_custody_outflow'
      when not positive_attribution_seen then 'no_active_positive_attribution'
      else 'custody_safe'
    end as reason
    from facts
  )
  select reason into v_reason from decision;

  return jsonb_build_object(
    'safe', v_reason = 'custody_safe',
    'reason', v_reason
  );
end;
$$;

-- CREATE OR REPLACE preserves ownership. Reassert the reviewed service-only
-- execution boundary in case grants drifted on the deployed function.
revoke all on function public.check_supply_accumulation_custody_gate(
  uuid, text, timestamptz, text, bigint, text
) from public, anon, authenticated;
grant execute on function public.check_supply_accumulation_custody_gate(
  uuid, text, timestamptz, text, bigint, text
) to service_role;

-- Abort atomically unless the installed definition contains every recovery
-- scope and every original fail-closed safety proof.
do $$
declare
  v_definition text;
begin
  select pg_get_functiondef(
    to_regprocedure(
      'public.check_supply_accumulation_custody_gate(uuid,text,timestamp with time zone,text,bigint,text)'
    )
  ) into v_definition;

  if position('configured_targets as materialized' in v_definition) = 0
     or position('active_positive_custody_wallets as materialized' in v_definition) = 0
     or position('join relevant_backlog_wallets relevant' in v_definition) = 0
     or position('rpc_backlog_wallet_count = 0' in v_definition) = 0
     or position('updated_at >= now() - interval ''60 seconds''' in v_definition) = 0
     or position('rpc_last_success_at >= now() - interval ''60 seconds''' in v_definition) = 0
     or position('VERIFIED_TARGET_BUY' in v_definition) = 0
     or position('VERIFIED_CUSTODY_SELL' in v_definition) = 0
     or position('total_unresolved_outflow_tokens > 0' in v_definition) = 0
     or position('p.status <> ''applied''' in v_definition) = 0 then
    raise exception 'Supply Accumulation custody gate hotfix verification failed';
  end if;
end $$;

commit;
-- SUPPLY_ACCUMULATION_CUSTODY_GATE_HOTFIX_CANONICAL_MIRROR_END
-- SUPPLY_ACCUMULATION_FRESH_TAIL_CANONICAL_MIRROR_BEGIN

-- Supply Accumulation finalized fresh-tail custody proof.
--
-- This migration adds an isolated cursor namespace for new initial entries.
-- It never advances or resets a legacy cursor and never changes the existing
-- custody gate used by positions and scale buys.  The companion worker must
-- activate an epoch while Entries are OFF, then prove one common FINALIZED
-- head for all three roots and every mint-scoped descendant.

begin;

do $$
begin
  if to_regclass('public.bot_config') is null
     or to_regclass('public.entry_signal_claims') is null
     or to_regclass('public.positions') is null
     or to_regclass('public.custody_journeys') is null
     or to_regclass('public.custody_pending_events') is null
     or to_regprocedure(
       'public.check_supply_accumulation_custody_gate(uuid,text,timestamp with time zone,text,bigint,text)'
     ) is null
     or to_regprocedure('extensions.digest(text,text)') is null
     or to_regprocedure('extensions.digest(bytea,text)') is null
     or not exists (
       select 1
       from pg_attribute
       where attrelid = 'public.bot_config'::regclass
         and attname = 'supply_accumulation_min_market_cap_usd'
         and not attisdropped
     ) then
    raise exception using
      errcode = '42883',
      message = 'run the current Supply Accumulation, Custody Journey, and custody gate migrations first';
  end if;
end $$;

create table if not exists public.custody_fresh_tail_epochs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  status text not null default 'active'
    check (status in ('active', 'retired', 'invalidated')),
  activation_slot bigint not null check (activation_slot >= 0),
  activation_blockhash text not null check (char_length(btrim(activation_blockhash)) > 0),
  activation_block_time timestamptz not null,
  root_wallets text[] not null check (cardinality(root_wallets) = 3),
  root_fingerprint text not null check (char_length(root_fingerprint) = 64),
  scope_revision bigint not null default 0 check (scope_revision >= 0),
  lease_owner text,
  lease_token uuid,
  lease_generation bigint not null default 0 check (lease_generation >= 0),
  lease_expires_at timestamptz,
  invalid_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create unique index if not exists custody_fresh_tail_one_active_epoch_idx
  on public.custody_fresh_tail_epochs (user_id)
  where status = 'active';

create table if not exists public.custody_fresh_tail_roots (
  epoch_id uuid not null,
  user_id uuid not null,
  wallet text not null check (char_length(btrim(wallet)) > 0),
  ordinal integer not null check (ordinal between 1 and 3),
  floor_slot bigint not null check (floor_slot >= 0),
  boundary_kind text not null default 'exclusive_slot'
    check (boundary_kind = 'exclusive_slot'),
  created_at timestamptz not null default now(),
  primary key (epoch_id, wallet),
  unique (epoch_id, ordinal),
  foreign key (epoch_id, user_id)
    references public.custody_fresh_tail_epochs(id, user_id)
);

-- Exact finalized heads are sampled once by the leased observer.  Every event,
-- cursor certificate, creation proof, and request must reference one of these
-- immutable slot/hash/time observations.
create table if not exists public.custody_fresh_tail_finalized_heads (
  epoch_id uuid not null,
  user_id uuid not null,
  slot bigint not null check (slot >= 0),
  blockhash text not null check (char_length(btrim(blockhash)) > 0),
  block_time timestamptz not null,
  first_lease_generation bigint not null check (first_lease_generation >= 0),
  last_lease_generation bigint not null check (last_lease_generation >= 0),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (epoch_id, slot),
  foreign key (epoch_id, user_id)
    references public.custody_fresh_tail_epochs(id, user_id)
);

create table if not exists public.custody_fresh_tail_mints (
  epoch_id uuid not null,
  user_id uuid not null,
  token_mint text not null check (char_length(btrim(token_mint)) > 0),
  enrollment_event_key text not null
    check (char_length(btrim(enrollment_event_key)) > 0),
  enrollment_tx_sig text not null
    check (char_length(btrim(enrollment_tx_sig)) > 0),
  enrollment_slot bigint not null check (enrollment_slot >= 0),
  enrollment_blockhash text not null
    check (char_length(btrim(enrollment_blockhash)) > 0),
  enrollment_block_time timestamptz not null,
  enrollment_target_wallet text not null
    check (char_length(btrim(enrollment_target_wallet)) > 0),
  creation_tx_sig text not null check (char_length(btrim(creation_tx_sig)) > 0),
  creation_slot bigint not null check (creation_slot >= 0),
  creation_blockhash text not null check (char_length(btrim(creation_blockhash)) > 0),
  bonding_curve text not null check (char_length(btrim(bonding_curve)) > 0),
  creator text not null check (char_length(btrim(creator)) > 0),
  create_variant text not null
    check (create_variant in ('classic_v1', 'create_v2_token2022')),
  token_program text not null check (char_length(btrim(token_program)) > 0),
  mint_layout_fingerprint text not null
    check (mint_layout_fingerprint ~ '^[0-9a-f]{64}$'),
  parser_abi_fingerprint text not null
    check (
      parser_abi_fingerprint =
        'ebe9ae1c8f38c24c3c6d4da1a3c9b90ffce4bf27e36f562bc67b090e9b7c343f'
    ),
  total_supply_raw numeric(78, 0) not null
    check (total_supply_raw = 1000000000000000),
  decimals integer not null check (decimals = 6),
  attested_head_slot bigint not null check (attested_head_slot >= creation_slot),
  attested_head_blockhash text not null
    check (char_length(btrim(attested_head_blockhash)) > 0),
  status text not null default 'active'
    check (status in ('active', 'retired')),
  scope_revision bigint not null default 0 check (scope_revision >= 0),
  poisoned boolean not null default false,
  poison_reason text,
  retire_reason text,
  retired_at timestamptz,
  attested_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (epoch_id, token_mint),
  unique (epoch_id, user_id, token_mint),
  unique (epoch_id, enrollment_event_key),
  foreign key (epoch_id, user_id)
    references public.custody_fresh_tail_epochs(id, user_id),
  check (
    (status = 'active' and retire_reason is null and retired_at is null)
    or (status = 'retired' and retire_reason is not null and retired_at is not null)
  )
);

-- Definitive non-candidates are immutable tombstones rather than global cursor
-- blockers.  Transient RPC/history failures are not tombstoned.  A conflicting
-- replay permanently poisons the tombstone and cannot turn it into an entry.
create table if not exists public.custody_fresh_tail_mint_rejections (
  epoch_id uuid not null,
  user_id uuid not null,
  token_mint text not null check (char_length(btrim(token_mint)) > 0),
  source_tx_sig text not null check (char_length(btrim(source_tx_sig)) > 0),
  source_slot bigint not null check (source_slot >= 0),
  rejection_code text not null check (rejection_code in (
    'not_pump_fun', 'created_before_epoch', 'already_graduated',
    'unsupported_create', 'reviewed_abi_mismatch', 'create_not_found',
    'permanent_state_conflict', 'proof_unavailable_budget_exhausted'
  )),
  parser_abi_fingerprint text not null,
  proof_fingerprint text not null check (char_length(proof_fingerprint) = 64),
  finalized_head_slot bigint not null check (finalized_head_slot >= source_slot),
  finalized_head_blockhash text not null,
  quarantined boolean not null default false,
  conflict_count integer not null default 0 check (conflict_count >= 0),
  first_conflict_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (epoch_id, token_mint),
  foreign key (epoch_id, user_id)
    references public.custody_fresh_tail_epochs(id, user_id)
);

create index if not exists custody_fresh_tail_rejections_recovery_idx
  on public.custody_fresh_tail_mint_rejections (epoch_id, source_slot);

-- This is a fresh-owned finalized ledger.  Authorization never reads the
-- legacy supply_accumulation_events/state tables.
create table if not exists public.custody_fresh_tail_supply_events (
  id uuid primary key default gen_random_uuid(),
  epoch_id uuid not null,
  user_id uuid not null,
  event_key text not null check (char_length(btrim(event_key)) > 0),
  payload_fingerprint text not null check (char_length(payload_fingerprint) = 64),
  tx_sig text not null check (char_length(btrim(tx_sig)) > 0),
  slot bigint not null check (slot >= 0),
  block_time timestamptz not null,
  target_wallet text not null check (char_length(btrim(target_wallet)) > 0),
  token_mint text not null check (char_length(btrim(token_mint)) > 0),
  side text not null check (side in ('buy', 'sell')),
  amount_raw numeric(78, 0) not null check (amount_raw > 0),
  total_supply_raw numeric(78, 0) not null
    check (total_supply_raw = 1000000000000000),
  decimals integer not null check (decimals = 6),
  market_cap_usd numeric check (market_cap_usd is null or market_cap_usd > 0),
  valuation_slot bigint check (valuation_slot is null or valuation_slot >= 0),
  market_data_reliable boolean not null,
  pump_fun_verified boolean not null,
  classification_reliable boolean not null,
  parser_domain text not null,
  parser_abi_fingerprint text not null,
  finalized_head_slot bigint not null check (finalized_head_slot >= slot),
  finalized_head_blockhash text not null,
  quarantined boolean not null default false,
  conflict_count integer not null default 0 check (conflict_count >= 0),
  first_conflict_at timestamptz,
  recorded_at timestamptz not null default now(),
  unique (epoch_id, event_key),
  foreign key (epoch_id, user_id, token_mint)
    references public.custody_fresh_tail_mints(epoch_id, user_id, token_mint)
);

create index if not exists custody_fresh_tail_supply_window_idx
  on public.custody_fresh_tail_supply_events
    (epoch_id, token_mint, block_time, slot, target_wallet);

-- A transfer is one conserving, canonical recipient batch.  Partial recipient
-- writes are impossible: the whole JSON batch and its fingerprint are stored
-- in the same row/transaction.
create table if not exists public.custody_fresh_tail_custody_events (
  id uuid primary key default gen_random_uuid(),
  epoch_id uuid not null,
  user_id uuid not null,
  event_key text not null check (char_length(btrim(event_key)) > 0),
  payload_fingerprint text not null check (char_length(payload_fingerprint) = 64),
  tx_sig text not null check (char_length(btrim(tx_sig)) > 0),
  slot bigint not null check (slot >= 0),
  block_time timestamptz not null,
  source_wallet text not null check (char_length(btrim(source_wallet)) > 0),
  token_mint text not null check (char_length(btrim(token_mint)) > 0),
  event_kind text not null check (event_kind in (
    'TARGET_BUY', 'TRANSFER', 'SELL', 'UNRESOLVED_OUTFLOW', 'TERMINAL_OUTFLOW'
  )),
  amount_raw numeric(78, 0) not null check (amount_raw > 0),
  source_pre_raw numeric(78, 0) check (source_pre_raw is null or source_pre_raw >= 0),
  source_post_raw numeric(78, 0) check (source_post_raw is null or source_post_raw >= 0),
  decimals integer not null check (decimals = 6),
  recipients jsonb not null default '[]'::jsonb
    check (jsonb_typeof(recipients) = 'array'),
  classification text not null check (char_length(btrim(classification)) > 0),
  classification_reliable boolean not null,
  watchable boolean not null,
  parser_domain text not null,
  parser_abi_fingerprint text not null,
  finalized_head_slot bigint not null check (finalized_head_slot >= slot),
  finalized_head_blockhash text not null,
  classification_pending boolean not null default false,
  terminal_poison boolean not null default false,
  quarantined boolean not null default false,
  conflict_count integer not null default 0 check (conflict_count >= 0),
  first_conflict_at timestamptz,
  recorded_at timestamptz not null default now(),
  unique (epoch_id, event_key),
  foreign key (epoch_id, user_id, token_mint)
    references public.custody_fresh_tail_mints(epoch_id, user_id, token_mint)
);

create index if not exists custody_fresh_tail_custody_scope_idx
  on public.custody_fresh_tail_custody_events
    (epoch_id, token_mint, slot, source_wallet);

create table if not exists public.custody_fresh_tail_edges (
  epoch_id uuid not null,
  user_id uuid not null,
  token_mint text not null,
  custody_event_id uuid not null
    references public.custody_fresh_tail_custody_events(id),
  source_wallet text not null,
  destination_wallet text not null,
  discovery_slot bigint not null check (discovery_slot >= 0),
  amount_raw numeric(78, 0) not null check (amount_raw > 0),
  classification text not null,
  classification_reliable boolean not null,
  watchable boolean not null,
  applied_revision bigint check (applied_revision is null or applied_revision > 0),
  scope_applied_at timestamptz,
  recorded_at timestamptz not null default now(),
  primary key (epoch_id, custody_event_id, destination_wallet),
  foreign key (epoch_id, user_id, token_mint)
    references public.custody_fresh_tail_mints(epoch_id, user_id, token_mint)
);

create table if not exists public.custody_fresh_tail_wallets (
  epoch_id uuid not null,
  user_id uuid not null,
  token_mint text not null,
  wallet text not null check (char_length(btrim(wallet)) > 0),
  parent_wallet text not null check (char_length(btrim(parent_wallet)) > 0),
  discovery_event_id uuid not null
    references public.custody_fresh_tail_custody_events(id),
  discovery_event_key text not null,
  discovery_slot bigint not null check (discovery_slot >= 0),
  floor_slot bigint not null check (floor_slot = discovery_slot),
  boundary_kind text not null default 'inclusive_slot'
    check (boundary_kind = 'inclusive_slot'),
  watch_status text not null default 'active'
    check (watch_status in ('active', 'released', 'unwatchable')),
  classification text not null,
  classification_reliable boolean not null,
  added_revision bigint not null check (added_revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (epoch_id, token_mint, wallet),
  unique (epoch_id, user_id, token_mint, wallet),
  foreign key (epoch_id, user_id, token_mint)
    references public.custody_fresh_tail_mints(epoch_id, user_id, token_mint)
);

create table if not exists public.custody_fresh_tail_requests (
  id uuid primary key default gen_random_uuid(),
  epoch_id uuid not null,
  user_id uuid not null,
  token_mint text not null,
  status text not null default 'pending'
    check (status in ('pending', 'settled', 'expired', 'invalidated')),
  window_started_at timestamptz not null,
  trigger_supply_event_id uuid not null
    references public.custody_fresh_tail_supply_events(id),
  trigger_event_key text not null,
  trigger_tx_sig text not null,
  trigger_slot bigint not null check (trigger_slot >= 0),
  trigger_target_wallet text not null,
  trigger_block_time timestamptz not null,
  expires_at timestamptz not null,
  requested_head_slot bigint not null check (requested_head_slot >= trigger_slot),
  requested_head_blockhash text not null,
  requested_head_block_time timestamptz not null,
  head_snapshot_parser_abi_fingerprint text not null
    check (
      head_snapshot_parser_abi_fingerprint =
        '2f5de97b6527d4ec94082069d65abd2bf30523e45bf562aabe1e770e5eb4ad1d'
    ),
  head_curve_state_fingerprint text not null
    check (head_curve_state_fingerprint ~ '^[0-9a-f]{64}$'),
  head_curve_observed_slot bigint not null
    check (head_curve_observed_slot = requested_head_slot),
  head_curve_complete boolean not null check (not head_curve_complete),
  head_virtual_token_reserves_raw numeric(78, 0) not null
    check (head_virtual_token_reserves_raw > 0),
  head_virtual_sol_reserves_lamports numeric(78, 0) not null
    check (head_virtual_sol_reserves_lamports > 0),
  head_real_token_reserves_raw numeric(78, 0) not null
    check (head_real_token_reserves_raw > 0),
  head_real_sol_reserves_lamports numeric(78, 0) not null
    check (head_real_sol_reserves_lamports >= 0),
  head_curve_total_supply_raw numeric(78, 0) not null
    check (head_curve_total_supply_raw = 1000000000000000),
  head_mint_layout_fingerprint text not null
    check (head_mint_layout_fingerprint ~ '^[0-9a-f]{64}$'),
  head_token_program text not null,
  head_mint_supply_raw numeric(78, 0) not null
    check (head_mint_supply_raw = 1000000000000000),
  head_mint_decimals integer not null check (head_mint_decimals = 6),
  scope_revision bigint not null check (scope_revision >= 0),
  settled_revision bigint,
  settled_lease_generation bigint check (settled_lease_generation > 0),
  settled_at timestamptz,
  invalid_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at = trigger_block_time + interval '55 seconds'),
  check (
    (status = 'settled' and settled_revision is not null
      and settled_lease_generation is not null and settled_at is not null)
    or status <> 'settled'
  ),
  unique (id, user_id),
  unique (epoch_id, trigger_event_key),
  foreign key (epoch_id, user_id, token_mint)
    references public.custody_fresh_tail_mints(epoch_id, user_id, token_mint)
);

create unique index if not exists custody_fresh_tail_one_live_request_idx
  on public.custody_fresh_tail_requests (epoch_id, token_mint)
  where status in ('pending', 'settled');

-- scope_mint='*' is the three-root namespace.  A real mint is a descendant
-- namespace.  current_boundary_kind changes to exact_signature after progress;
-- it may never fall back to a slot boundary.
create table if not exists public.custody_fresh_tail_cursors (
  epoch_id uuid not null,
  user_id uuid not null,
  scope_mint text not null check (char_length(btrim(scope_mint)) > 0),
  wallet text not null check (char_length(btrim(wallet)) > 0),
  cursor_role text not null check (cursor_role in ('root', 'descendant')),
  floor_slot bigint not null check (floor_slot >= 0),
  initial_boundary_kind text not null
    check (initial_boundary_kind in ('exclusive_slot', 'inclusive_slot')),
  current_boundary_kind text not null
    check (current_boundary_kind in ('exclusive_slot', 'inclusive_slot', 'exact_signature')),
  last_processed_signature text,
  last_processed_slot bigint,
  last_block_time bigint,
  first_available_block bigint,
  history_floor_proven boolean not null default false,
  covered_through_slot bigint,
  covered_through_blockhash text,
  coverage_revision bigint not null default 0 check (coverage_revision >= 0),
  backlog_detected boolean not null default false,
  last_error text,
  last_success_at timestamptz,
  last_lease_generation bigint not null default 0 check (last_lease_generation >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (epoch_id, scope_mint, wallet),
  foreign key (epoch_id, user_id)
    references public.custody_fresh_tail_epochs(id, user_id),
  check (
    (cursor_role = 'root' and scope_mint = '*' and initial_boundary_kind = 'exclusive_slot')
    or
    (cursor_role = 'descendant' and scope_mint <> '*' and initial_boundary_kind = 'inclusive_slot')
  ),
  check (
    (last_processed_signature is null and last_processed_slot is null
      and current_boundary_kind = initial_boundary_kind)
    or
    (last_processed_signature is not null and last_processed_slot is not null
      and current_boundary_kind = 'exact_signature')
  ),
  check (
    (covered_through_slot is null and covered_through_blockhash is null)
    or
    (covered_through_slot is not null and covered_through_blockhash is not null)
  )
);

-- Retrograde discovery never rewinds a main cursor.  It creates an independent
-- inclusive exact-signature lane whose evidence remains auditable forever.
create table if not exists public.custody_fresh_tail_backscan_ranges (
  id uuid primary key default gen_random_uuid(),
  epoch_id uuid not null,
  user_id uuid not null,
  token_mint text not null,
  wallet text not null,
  source_edge_event_id uuid not null
    references public.custody_fresh_tail_custody_events(id),
  floor_slot bigint not null check (floor_slot >= 0),
  boundary_kind text not null default 'inclusive_slot'
    check (boundary_kind = 'inclusive_slot'),
  current_boundary_kind text not null default 'inclusive_slot'
    check (current_boundary_kind in ('inclusive_slot', 'exact_signature')),
  last_processed_signature text,
  last_processed_slot bigint,
  last_block_time bigint,
  first_available_block bigint,
  history_floor_proven boolean not null default false,
  covered_through_slot bigint,
  covered_through_blockhash text,
  coverage_revision bigint not null check (coverage_revision >= 0),
  backlog_detected boolean not null default true,
  last_error text,
  last_success_at timestamptz,
  last_lease_generation bigint not null default 0 check (last_lease_generation >= 0),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (epoch_id, token_mint, wallet, source_edge_event_id),
  foreign key (epoch_id, user_id, token_mint, wallet)
    references public.custody_fresh_tail_wallets(epoch_id, user_id, token_mint, wallet),
  check (
    (last_processed_signature is null and last_processed_slot is null
      and current_boundary_kind = 'inclusive_slot')
    or
    (last_processed_signature is not null and last_processed_slot is not null
      and current_boundary_kind = 'exact_signature')
  ),
  check (
    (covered_through_slot is null and covered_through_blockhash is null)
    or
    (covered_through_slot is not null and covered_through_blockhash is not null)
  )
);

create table if not exists public.custody_fresh_tail_coverage_attestations (
  id uuid primary key default gen_random_uuid(),
  epoch_id uuid not null,
  user_id uuid not null,
  lane_kind text not null check (lane_kind in ('main', 'backscan')),
  scope_mint text,
  wallet text,
  range_id uuid references public.custody_fresh_tail_backscan_ranges(id),
  covered_head_slot bigint not null check (covered_head_slot >= 0),
  covered_head_blockhash text not null,
  coverage_revision bigint not null check (coverage_revision >= 0),
  lease_generation bigint not null check (lease_generation > 0),
  attested_at timestamptz not null default now(),
  foreign key (epoch_id, user_id)
    references public.custody_fresh_tail_epochs(id, user_id),
  check (
    (lane_kind = 'main' and scope_mint is not null and wallet is not null
      and range_id is null)
    or
    (lane_kind = 'backscan' and range_id is not null
      and scope_mint is null and wallet is null)
  )
);

create unique index if not exists custody_fresh_tail_coverage_main_once_idx
  on public.custody_fresh_tail_coverage_attestations
    (epoch_id, scope_mint, wallet, covered_head_slot, coverage_revision,
      lease_generation)
  where lane_kind = 'main';

create unique index if not exists custody_fresh_tail_coverage_range_once_idx
  on public.custody_fresh_tail_coverage_attestations
    (range_id, covered_head_slot, coverage_revision, lease_generation)
  where lane_kind = 'backscan';

alter table public.entry_signal_claims
  add column if not exists fresh_tail_epoch_id uuid,
  add column if not exists fresh_tail_request_id uuid,
  add column if not exists fresh_tail_monitoring_armed_at timestamptz,
  add column if not exists received_amount_raw text,
  add column if not exists received_token_decimals integer;

create unique index if not exists entry_signal_claims_fresh_tail_request_once_idx
  on public.entry_signal_claims (fresh_tail_request_id)
  where fresh_tail_request_id is not null;

create index if not exists entry_signal_claims_fresh_tail_armed_idx
  on public.entry_signal_claims (fresh_tail_epoch_id, token_mint, created_at)
  where fresh_tail_monitoring_armed_at is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.entry_signal_claims'::regclass
      and conname = 'entry_signal_claims_fresh_tail_binding_check'
  ) then
    alter table public.entry_signal_claims
      add constraint entry_signal_claims_fresh_tail_binding_check check (
        (fresh_tail_epoch_id is null and fresh_tail_request_id is null
          and fresh_tail_monitoring_armed_at is null)
        or
        (fresh_tail_epoch_id is not null and fresh_tail_request_id is not null
          and fresh_tail_monitoring_armed_at is not null
          and entry_strategy = 'supply_accumulation')
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.entry_signal_claims'::regclass
      and conname = 'entry_signal_claims_fresh_receipt_pair_check'
  ) then
    alter table public.entry_signal_claims
      add constraint entry_signal_claims_fresh_receipt_pair_check check (
        (received_amount_raw is null and received_token_decimals is null)
        or
        (
          received_amount_raw ~ '^[1-9][0-9]*$'
          and char_length(received_amount_raw) <= 78
          and received_token_decimals between 0 and 18
        )
      );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.entry_signal_claims'::regclass
      and conname = 'entry_signal_claims_fresh_receipt_state_check'
  ) then
    -- Existing and future non-fresh claims are unaffected.  Once a claim is
    -- fresh-bound, only a confirmed exact receipt may advance it to landed.
    alter table public.entry_signal_claims
      add constraint entry_signal_claims_fresh_receipt_state_check check (
        fresh_tail_request_id is null
        or
        (
          (
            status in ('landed', 'persisted')
            and received_amount_raw is not null
            and received_token_decimals is not null
            and received_token_decimals = token_decimals
            and nullif(btrim(coalesce(bot_tx_sig, '')), '') is not null
            and submission_started_at is not null
            and landed_at is not null
          )
          or
          (
            status = 'uncertain'
            and received_amount_raw is null
            and received_token_decimals is null
            and nullif(btrim(coalesce(bot_tx_sig, '')), '') is not null
            and submission_started_at is not null
            and landed_at is null
          )
          or
          (
            status in ('claimed', 'submitted', 'failed_pre_submit')
            and received_amount_raw is null
            and received_token_decimals is null
            and landed_at is null
          )
        )
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.entry_signal_claims'::regclass
      and conname = 'entry_signal_claims_fresh_tail_epoch_fkey'
  ) then
    alter table public.entry_signal_claims
      add constraint entry_signal_claims_fresh_tail_epoch_fkey
      foreign key (fresh_tail_epoch_id)
      references public.custody_fresh_tail_epochs(id);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.entry_signal_claims'::regclass
      and conname = 'entry_signal_claims_fresh_tail_request_fkey'
  ) then
    alter table public.entry_signal_claims
      add constraint entry_signal_claims_fresh_tail_request_fkey
      foreign key (fresh_tail_request_id)
      references public.custody_fresh_tail_requests(id);
  end if;
end $$;

create table if not exists public.custody_fresh_tail_exit_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  epoch_id uuid not null,
  request_id uuid not null,
  token_mint text not null,
  entry_claim_id uuid not null references public.entry_signal_claims(id),
  position_id uuid not null,
  source_domain text not null check (source_domain in ('supply', 'custody')),
  supply_event_id uuid references public.custody_fresh_tail_supply_events(id),
  custody_event_id uuid references public.custody_fresh_tail_custody_events(id),
  trigger_kind text not null check (trigger_kind in (
    'direct_target_sell', 'mirror_custody_sell', 'terminal_outflow'
  )),
  status text not null default 'pending'
    check (status in ('pending', 'claimed', 'retry', 'uncertain', 'resolved', 'dismissed')),
  disposition text check (disposition is null or disposition in (
    'resolved', 'retry', 'uncertain', 'disabled_by_policy',
    'position_not_live', 'duplicate_sell_claim', 'entry_failed', 'position_closed'
  )),
  worker_id text,
  claim_token uuid,
  claim_generation bigint not null default 0 check (claim_generation >= 0),
  claim_expires_at timestamptz,
  sell_claim_id uuid,
  bot_tx_sig text,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  foreign key (request_id, user_id)
    references public.custody_fresh_tail_requests(id, user_id),
  check (
    (source_domain = 'supply' and supply_event_id is not null and custody_event_id is null)
    or
    (source_domain = 'custody' and custody_event_id is not null and supply_event_id is null)
  ),
  check (
    (status = 'claimed' and claim_token is not null and claim_expires_at is not null)
    or status <> 'claimed'
  ),
  check (
    (claim_token is null and claim_expires_at is null)
    or (claim_token is not null and claim_expires_at is not null)
  ),
  check (
    status <> 'uncertain'
    or (
      sell_claim_id is not null
      and nullif(btrim(coalesce(bot_tx_sig, '')), '') is not null
    )
  )
);

-- Keep reruns additive while allowing the drainer to distinguish a position
-- that is merely not persisted yet from terminal no-action outcomes.
alter table public.custody_fresh_tail_exit_intents
  drop constraint if exists custody_fresh_tail_exit_intents_disposition_check;
alter table public.custody_fresh_tail_exit_intents
  add constraint custody_fresh_tail_exit_intents_disposition_check check (
    disposition is null or disposition in (
      'resolved', 'retry', 'uncertain', 'disabled_by_policy',
      'position_not_live', 'duplicate_sell_claim', 'entry_failed', 'position_closed'
    )
  ) not valid;
alter table public.custody_fresh_tail_exit_intents
  validate constraint custody_fresh_tail_exit_intents_disposition_check;

create index if not exists custody_fresh_tail_exit_intents_drain_idx
  on public.custody_fresh_tail_exit_intents (user_id, status, created_at);

create unique index if not exists custody_fresh_tail_exit_supply_once_idx
  on public.custody_fresh_tail_exit_intents (entry_claim_id, supply_event_id)
  where supply_event_id is not null;

create unique index if not exists custody_fresh_tail_exit_custody_once_idx
  on public.custody_fresh_tail_exit_intents (entry_claim_id, custody_event_id)
  where custody_event_id is not null;

create table if not exists public.custody_fresh_tail_worker_heartbeat (
  user_id uuid not null,
  epoch_id uuid not null,
  worker_id text not null check (char_length(btrim(worker_id)) > 0),
  lease_token uuid not null,
  lease_generation bigint not null check (lease_generation > 0),
  lease_expires_at timestamptz not null,
  enabled boolean not null,
  shadow boolean not null,
  latest_head_slot bigint not null check (latest_head_slot >= 0),
  latest_head_blockhash text not null,
  latest_head_block_time timestamptz not null,
  root_required_count integer not null check (root_required_count = 3),
  root_covered_count integer not null check (root_covered_count between 0 and 3),
  root_backlog_count integer not null check (root_backlog_count between 0 and 3),
  max_root_lag_slots bigint not null check (max_root_lag_slots >= 0),
  active_mint_count integer not null check (active_mint_count >= 0),
  poisoned_mint_count integer not null check (poisoned_mint_count >= 0),
  retired_mint_count integer not null check (retired_mint_count >= 0),
  pending_candidate_count integer not null check (pending_candidate_count >= 0),
  oldest_pending_candidate_age_seconds bigint
    check (oldest_pending_candidate_age_seconds is null
      or oldest_pending_candidate_age_seconds >= 0),
  descendant_required_count integer not null check (descendant_required_count >= 0),
  descendant_covered_count integer not null check (descendant_covered_count >= 0),
  incomplete_backscan_count integer not null check (incomplete_backscan_count >= 0),
  exit_pending_count integer not null check (exit_pending_count >= 0),
  exit_retry_count integer not null check (exit_retry_count >= 0),
  exit_uncertain_count integer not null check (exit_uncertain_count >= 0),
  last_success_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (user_id, epoch_id),
  foreign key (epoch_id, user_id)
    references public.custody_fresh_tail_epochs(id, user_id)
);

-- Least privilege: clients may inspect only their own audit rows.  Only the
-- service role receives DML/EXECUTE below.
alter table public.custody_fresh_tail_epochs enable row level security;
alter table public.custody_fresh_tail_roots enable row level security;
alter table public.custody_fresh_tail_finalized_heads enable row level security;
alter table public.custody_fresh_tail_mints enable row level security;
alter table public.custody_fresh_tail_mint_rejections enable row level security;
alter table public.custody_fresh_tail_supply_events enable row level security;
alter table public.custody_fresh_tail_custody_events enable row level security;
alter table public.custody_fresh_tail_edges enable row level security;
alter table public.custody_fresh_tail_wallets enable row level security;
alter table public.custody_fresh_tail_requests enable row level security;
alter table public.custody_fresh_tail_cursors enable row level security;
alter table public.custody_fresh_tail_backscan_ranges enable row level security;
alter table public.custody_fresh_tail_coverage_attestations enable row level security;
alter table public.custody_fresh_tail_exit_intents enable row level security;
alter table public.custody_fresh_tail_worker_heartbeat enable row level security;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'custody_fresh_tail_epochs',
    'custody_fresh_tail_roots',
    'custody_fresh_tail_finalized_heads',
    'custody_fresh_tail_mints',
    'custody_fresh_tail_mint_rejections',
    'custody_fresh_tail_supply_events',
    'custody_fresh_tail_custody_events',
    'custody_fresh_tail_edges',
    'custody_fresh_tail_wallets',
    'custody_fresh_tail_requests',
    'custody_fresh_tail_cursors',
    'custody_fresh_tail_backscan_ranges',
    'custody_fresh_tail_coverage_attestations',
    'custody_fresh_tail_exit_intents',
    'custody_fresh_tail_worker_heartbeat'
  ] loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = v_table
        and policyname = 'read own fresh tail rows'
    ) then
      execute format(
        'create policy %I on public.%I for select to authenticated using (auth.uid() = user_id)',
        'read own fresh tail rows', v_table
      );
    end if;
    execute format(
      'revoke all on table public.%I from public, anon',
      v_table
    );
    execute format(
      'revoke insert, update, delete, truncate on table public.%I from authenticated',
      v_table
    );
    execute format('grant select on table public.%I to authenticated', v_table);
    execute format(
      'grant select, insert, update, delete on table public.%I to service_role',
      v_table
    );
  end loop;
end $$;

-- The heartbeat stores the active fencing token so the entry gate can prove
-- that telemetry came from the current lease holder.  Unlike the other audit
-- tables, it must therefore remain service-only rather than expose that
-- secret through the authenticated SELECT policy.
drop policy if exists "read own fresh tail rows"
  on public.custody_fresh_tail_worker_heartbeat;
revoke all on table public.custody_fresh_tail_worker_heartbeat
  from authenticated;
grant select, insert, update, delete
  on table public.custody_fresh_tail_worker_heartbeat to service_role;

create or replace function public.assert_custody_fresh_tail_lease(
  p_user_id uuid,
  p_epoch_id uuid,
  p_lease_token uuid,
  p_lease_generation bigint
)
returns public.custody_fresh_tail_epochs
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;

  select * into v_epoch
  from public.custody_fresh_tail_epochs
  where id = p_epoch_id and user_id = p_user_id
  for update;

  if not found
     or v_epoch.status <> 'active'
     or p_lease_token is null
     or v_epoch.lease_token is distinct from p_lease_token
     or v_epoch.lease_generation is distinct from p_lease_generation
     or v_epoch.lease_expires_at is null
     or v_epoch.lease_expires_at <= clock_timestamp() then
    raise exception using
      errcode = '55000',
      message = 'fresh-tail lease is missing, expired, or fenced';
  end if;

  return v_epoch;
end;
$$;

create or replace function public.attest_custody_fresh_tail_finalized_head(
  p_user_id uuid,
  p_epoch_id uuid,
  p_finalized_head_slot bigint,
  p_finalized_head_blockhash text,
  p_finalized_head_block_time timestamptz,
  p_lease_token uuid,
  p_lease_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_existing public.custody_fresh_tail_finalized_heads%rowtype;
  v_hash text := btrim(coalesce(p_finalized_head_blockhash, ''));
begin
  v_epoch := public.assert_custody_fresh_tail_lease(
    p_user_id, p_epoch_id, p_lease_token, p_lease_generation
  );
  if p_finalized_head_slot is null
     or p_finalized_head_slot < v_epoch.activation_slot
     or v_hash = '' or p_finalized_head_block_time is null
     or p_finalized_head_block_time < v_epoch.activation_block_time
     or p_finalized_head_block_time > clock_timestamp() then
    return jsonb_build_object('ok', false, 'reason', 'invalid_finalized_head');
  end if;

  select * into v_existing
  from public.custody_fresh_tail_finalized_heads
  where epoch_id = p_epoch_id and slot = p_finalized_head_slot
  for update;
  if found then
    if v_existing.blockhash <> v_hash
       or v_existing.block_time <> p_finalized_head_block_time then
      update public.custody_fresh_tail_epochs set
        status = 'invalidated', invalid_reason = 'finalized_head_conflict',
        updated_at = now()
      where id = p_epoch_id;
      return jsonb_build_object(
        'ok', false, 'reason', 'finalized_head_conflict',
        'epochId', p_epoch_id, 'slot', p_finalized_head_slot
      );
    end if;
    update public.custody_fresh_tail_finalized_heads set
      last_lease_generation = p_lease_generation,
      last_seen_at = clock_timestamp()
    where epoch_id = p_epoch_id and slot = p_finalized_head_slot;
    return jsonb_build_object(
      'ok', true, 'reason', 'already_attested', 'epochId', p_epoch_id,
      'slot', p_finalized_head_slot, 'blockhash', v_hash,
      'blockTime', p_finalized_head_block_time,
      'leaseGeneration', p_lease_generation
    );
  end if;

  insert into public.custody_fresh_tail_finalized_heads (
    epoch_id, user_id, slot, blockhash, block_time,
    first_lease_generation, last_lease_generation
  ) values (
    p_epoch_id, p_user_id, p_finalized_head_slot, v_hash,
    p_finalized_head_block_time, p_lease_generation, p_lease_generation
  );
  return jsonb_build_object(
    'ok', true, 'reason', 'attested', 'epochId', p_epoch_id,
    'slot', p_finalized_head_slot, 'blockhash', v_hash,
    'blockTime', p_finalized_head_block_time,
    'leaseGeneration', p_lease_generation
  );
end;
$$;



create or replace function public.is_custody_fresh_tail_parser_reviewed(
  p_parser_domain text,
  p_parser_abi_fingerprint text
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_domain text := lower(btrim(coalesce(p_parser_domain, '')));
  v_fingerprint text := lower(btrim(coalesce(p_parser_abi_fingerprint, '')));
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;
  -- Every enabled domain is pinned to its independently reviewed finalized
  -- decoder contract.  No domain may borrow another domain's fingerprint.
  return (v_domain, v_fingerprint) in (
    ('pump_root_buy_v1',
      'b8b6dbdcce44a2b61c55ba2fd74cd385fae489a95be291504eb8e7b15f88262d'),
    ('custody_target_buy_v1',
      'bd230909bd66718382a71c387324fefc840aa108089afcc01b61cb7115948f0c'),
    ('supply_sell_v1',
      'd6a4aa7b14969befcfa858192c539b2cbb4738db4a739f1230b4c82c001c4412'),
    ('custody_transfer_v1',
      'c50f0e09f75de355db936a95832046bc61f1d5b16eff81040528eadfc305422d'),
    ('custody_sell_v1',
      'f39f4582dbe8bd04f91375a61be0b83b750658cca7c51354cbeb335a86dab401'),
    ('custody_unresolved_v1',
      '8e6fe7600bfc983a35faa7cf1f6c79cdac5337080c551fa8accca4d62856995c'),
    ('custody_terminal_v1',
      '0858d3736e2eb29b82a1a9ef17b51246880561047aeb1ce8a12b701e3529aac4')
  );
end;
$$;

create or replace function public.reject_custody_fresh_tail_mint(
  p_user_id uuid,
  p_epoch_id uuid,
  p_token_mint text,
  p_source_tx_sig text,
  p_source_slot bigint,
  p_rejection_code text,
  p_parser_abi_fingerprint text,
  p_proof_fingerprint text,
  p_finalized_head_slot bigint,
  p_finalized_head_blockhash text,
  p_lease_token uuid,
  p_lease_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_existing public.custody_fresh_tail_mint_rejections%rowtype;
  v_mint text := btrim(coalesce(p_token_mint, ''));
  v_sig text := btrim(coalesce(p_source_tx_sig, ''));
  v_abi text := btrim(coalesce(p_parser_abi_fingerprint, ''));
  v_hash text := btrim(coalesce(p_finalized_head_blockhash, ''));
  v_fingerprint text := lower(btrim(coalesce(p_proof_fingerprint, '')));
begin
  v_epoch := public.assert_custody_fresh_tail_lease(
    p_user_id, p_epoch_id, p_lease_token, p_lease_generation
  );
  if v_mint = '' or v_sig = '' or v_abi = '' or v_hash = ''
     or p_source_slot is null or p_source_slot <= v_epoch.activation_slot
     or p_finalized_head_slot is null or p_finalized_head_slot < p_source_slot
     or p_rejection_code is null
     or p_rejection_code not in (
       'not_pump_fun', 'created_before_epoch', 'already_graduated',
       'unsupported_create', 'reviewed_abi_mismatch', 'create_not_found',
       'permanent_state_conflict', 'proof_unavailable_budget_exhausted'
     )
     or v_fingerprint !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_rejection');
  end if;
  if not exists (
    select 1 from public.custody_fresh_tail_finalized_heads h
    where h.epoch_id = p_epoch_id and h.user_id = p_user_id
      and h.slot = p_finalized_head_slot and h.blockhash = v_hash
  ) then
    return jsonb_build_object('ok', false, 'reason', 'finalized_head_not_attested');
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(v_mint));
  if exists (
    select 1 from public.custody_fresh_tail_mints
    where epoch_id = p_epoch_id and token_mint = v_mint
  ) then
    update public.custody_fresh_tail_mints set
      poisoned = true,
      poison_reason = 'conflicting_mint_rejection',
      updated_at = now()
    where epoch_id = p_epoch_id and token_mint = v_mint;
    return jsonb_build_object('ok', false, 'reason', 'active_mint_conflict');
  end if;

  select * into v_existing
  from public.custody_fresh_tail_mint_rejections
  where epoch_id = p_epoch_id and token_mint = v_mint
  for update;
  if found then
    if v_existing.source_tx_sig = v_sig
       and v_existing.source_slot = p_source_slot
       and v_existing.rejection_code = p_rejection_code
       and v_existing.parser_abi_fingerprint = v_abi
       and v_existing.proof_fingerprint = v_fingerprint then
      return jsonb_build_object(
        'ok', true, 'reason', 'already_rejected', 'epochId', p_epoch_id,
        'tokenMint', v_mint, 'rejectionCode', v_existing.rejection_code,
        'quarantined', v_existing.quarantined
      );
    end if;
    update public.custody_fresh_tail_mint_rejections set
      quarantined = true,
      conflict_count = conflict_count + 1,
      first_conflict_at = coalesce(first_conflict_at, now()),
      updated_at = now()
    where epoch_id = p_epoch_id and token_mint = v_mint;
    return jsonb_build_object('ok', false, 'reason', 'rejection_payload_conflict');
  end if;

  insert into public.custody_fresh_tail_mint_rejections (
    epoch_id, user_id, token_mint, source_tx_sig, source_slot,
    rejection_code, parser_abi_fingerprint, proof_fingerprint,
    finalized_head_slot, finalized_head_blockhash
  ) values (
    p_epoch_id, p_user_id, v_mint, v_sig, p_source_slot,
    p_rejection_code, v_abi, v_fingerprint,
    p_finalized_head_slot, v_hash
  );
  return jsonb_build_object(
    'ok', true, 'reason', 'rejected', 'epochId', p_epoch_id,
    'tokenMint', v_mint, 'rejectionCode', p_rejection_code,
    'quarantined', false
  );
end;
$$;

create or replace function public.attest_custody_fresh_tail_mint_creation(
  p_user_id uuid,
  p_epoch_id uuid,
  p_token_mint text,
  p_enrollment_event_key text,
  p_enrollment_tx_sig text,
  p_enrollment_slot bigint,
  p_enrollment_blockhash text,
  p_enrollment_block_time timestamptz,
  p_enrollment_target_wallet text,
  p_creation_tx_sig text,
  p_creation_slot bigint,
  p_creation_blockhash text,
  p_bonding_curve text,
  p_creator text,
  p_create_variant text,
  p_token_program text,
  p_mint_layout_fingerprint text,
  p_parser_abi_fingerprint text,
  p_total_supply_raw numeric,
  p_decimals integer,
  p_finalized_head_slot bigint,
  p_finalized_head_blockhash text,
  p_lease_token uuid,
  p_lease_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_existing public.custody_fresh_tail_mints%rowtype;
  v_mint text := btrim(coalesce(p_token_mint, ''));
  v_enrollment_key text := btrim(coalesce(p_enrollment_event_key, ''));
  v_enrollment_sig text := btrim(coalesce(p_enrollment_tx_sig, ''));
  v_enrollment_hash text := btrim(coalesce(p_enrollment_blockhash, ''));
  v_enrollment_target text := btrim(coalesce(p_enrollment_target_wallet, ''));
  v_sig text := btrim(coalesce(p_creation_tx_sig, ''));
  v_creation_hash text := btrim(coalesce(p_creation_blockhash, ''));
  v_head_hash text := btrim(coalesce(p_finalized_head_blockhash, ''));
  v_curve text := btrim(coalesce(p_bonding_curve, ''));
  v_creator text := btrim(coalesce(p_creator, ''));
  v_variant text := lower(btrim(coalesce(p_create_variant, '')));
  v_token_program text := btrim(coalesce(p_token_program, ''));
  v_layout text := lower(btrim(coalesce(p_mint_layout_fingerprint, '')));
  v_abi text := lower(btrim(coalesce(p_parser_abi_fingerprint, '')));
begin
  v_epoch := public.assert_custody_fresh_tail_lease(
    p_user_id, p_epoch_id, p_lease_token, p_lease_generation
  );
  if v_mint = '' or v_enrollment_key = '' or v_enrollment_sig = ''
     or v_enrollment_hash = '' or v_enrollment_target = ''
     or v_enrollment_key <> v_enrollment_sig || ':' || v_mint
       || ':supply:BUY:' || v_enrollment_target
     or v_sig = '' or v_creation_hash = '' or v_head_hash = ''
     or v_curve = '' or v_creator = ''
     or v_variant not in ('classic_v1', 'create_v2_token2022')
     or v_token_program = '' or v_layout !~ '^[0-9a-f]{64}$'
     or v_abi <>
       'ebe9ae1c8f38c24c3c6d4da1a3c9b90ffce4bf27e36f562bc67b090e9b7c343f'
     or (v_variant = 'classic_v1' and v_token_program <>
       'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
     or (v_variant = 'create_v2_token2022' and v_token_program <>
       'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
     or p_creation_slot is null or p_creation_slot <= v_epoch.activation_slot
     or p_enrollment_slot is null or p_enrollment_slot < p_creation_slot
     or p_enrollment_block_time is null
     or p_enrollment_block_time < v_epoch.activation_block_time
     or p_finalized_head_slot is null or p_finalized_head_slot < p_enrollment_slot
     or p_total_supply_raw is distinct from 1000000000000000::numeric
     or p_decimals is distinct from 6 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_creation_proof');
  end if;
  if not exists (
    select 1 from public.custody_fresh_tail_finalized_heads h
    where h.epoch_id = p_epoch_id and h.user_id = p_user_id
      and h.slot = p_finalized_head_slot and h.blockhash = v_head_hash
  ) then
    return jsonb_build_object('ok', false, 'reason', 'finalized_head_not_attested');
  end if;
  if not exists (
    select 1 from public.custody_fresh_tail_finalized_heads h
    where h.epoch_id = p_epoch_id and h.user_id = p_user_id
      and h.slot = p_creation_slot and h.blockhash = v_creation_hash
  ) then
    return jsonb_build_object('ok', false, 'reason', 'creation_block_not_attested');
  end if;
  if not exists (
    select 1 from public.custody_fresh_tail_finalized_heads h
    where h.epoch_id = p_epoch_id and h.user_id = p_user_id
      and h.slot = p_enrollment_slot and h.blockhash = v_enrollment_hash
      and h.block_time = p_enrollment_block_time
  ) then
    return jsonb_build_object('ok', false, 'reason', 'enrollment_block_not_attested');
  end if;
  if not exists (
    select 1 from public.custody_fresh_tail_roots r
    where r.epoch_id = p_epoch_id and r.user_id = p_user_id
      and r.wallet = v_enrollment_target
  ) then
    return jsonb_build_object('ok', false, 'reason', 'enrollment_root_mismatch');
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(v_mint));
  if exists (
    select 1 from public.custody_fresh_tail_mint_rejections
    where epoch_id = p_epoch_id and token_mint = v_mint
  ) then
    return jsonb_build_object('ok', false, 'reason', 'mint_tombstoned');
  end if;

  -- A legacy journey is a veto only when it predates this epoch or is not
  -- rooted in a fresh-tail event.  Fresh dual-writes after enrollment remain
  -- available to the existing exit system but never authorize this gate.
  if exists (
    select 1
    from public.custody_journeys j
    where j.user_id = p_user_id
      and j.token_mint = v_mint
      and j.status = 'active'
      and j.first_event_key <> v_enrollment_key
  ) then
    return jsonb_build_object('ok', false, 'reason', 'preexisting_legacy_journey');
  end if;

  select * into v_existing
  from public.custody_fresh_tail_mints
  where epoch_id = p_epoch_id and token_mint = v_mint
  for update;
  if found then
    if v_existing.status <> 'active' then
      return jsonb_build_object('ok', false, 'reason', 'mint_retired');
    end if;
    if v_existing.enrollment_event_key = v_enrollment_key
       and v_existing.enrollment_tx_sig = v_enrollment_sig
       and v_existing.enrollment_slot = p_enrollment_slot
       and v_existing.enrollment_blockhash = v_enrollment_hash
       and v_existing.enrollment_block_time = p_enrollment_block_time
       and v_existing.enrollment_target_wallet = v_enrollment_target
       and v_existing.creation_tx_sig = v_sig
       and v_existing.creation_slot = p_creation_slot
       and v_existing.creation_blockhash = v_creation_hash
       and v_existing.bonding_curve = v_curve
       and v_existing.creator = v_creator
       and v_existing.create_variant = v_variant
       and v_existing.token_program = v_token_program
       and v_existing.mint_layout_fingerprint = v_layout
       and v_existing.parser_abi_fingerprint = v_abi
       and v_existing.total_supply_raw = p_total_supply_raw
       and v_existing.decimals = p_decimals then
      return jsonb_build_object(
        'ok', true, 'reason', 'already_attested', 'epochId', p_epoch_id,
        'tokenMint', v_mint, 'scopeRevision', v_existing.scope_revision,
        'created', false
      );
    end if;
    update public.custody_fresh_tail_mints set
      poisoned = true, poison_reason = 'creation_proof_conflict', updated_at = now()
    where epoch_id = p_epoch_id and token_mint = v_mint;
    return jsonb_build_object('ok', false, 'reason', 'creation_proof_conflict');
  end if;

  insert into public.custody_fresh_tail_mints (
    epoch_id, user_id, token_mint, enrollment_event_key,
    enrollment_tx_sig, enrollment_slot, enrollment_blockhash,
    enrollment_block_time, enrollment_target_wallet,
    creation_tx_sig, creation_slot,
    creation_blockhash, bonding_curve, creator, create_variant, token_program,
    mint_layout_fingerprint, parser_abi_fingerprint,
    total_supply_raw, decimals, attested_head_slot, attested_head_blockhash
  ) values (
    p_epoch_id, p_user_id, v_mint, v_enrollment_key,
    v_enrollment_sig, p_enrollment_slot, v_enrollment_hash,
    p_enrollment_block_time, v_enrollment_target,
    v_sig, p_creation_slot,
    v_creation_hash, v_curve, v_creator, v_variant, v_token_program,
    v_layout, v_abi,
    p_total_supply_raw, p_decimals, p_finalized_head_slot, v_head_hash
  );
  return jsonb_build_object(
    'ok', true, 'reason', 'attested', 'epochId', p_epoch_id,
    'tokenMint', v_mint, 'enrollmentEventKey', v_enrollment_key,
    'enrollmentSlot', p_enrollment_slot,
    'scopeRevision', 0, 'created', true
  );
end;
$$;

create or replace function public.activate_custody_fresh_tail_epoch(
  p_user_id uuid,
  p_root_wallets text[],
  p_activation_slot bigint,
  p_activation_blockhash text,
  p_activation_block_time timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_config public.bot_config%rowtype;
  v_existing public.custody_fresh_tail_epochs%rowtype;
  v_roots text[];
  v_config_roots text[];
  v_epoch_id uuid;
  v_blockhash text := btrim(coalesce(p_activation_blockhash, ''));
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;
  if p_user_id is null
     or p_activation_slot is null or p_activation_slot < 0
     or v_blockhash = ''
     or p_activation_block_time is null
     or p_activation_block_time > now() then
    return jsonb_build_object('ok', false, 'reason', 'invalid_activation');
  end if;

  select array_agg(v order by v) into v_roots
  from (
    select distinct btrim(wallet) as v
    from unnest(coalesce(p_root_wallets, array[]::text[])) wallet
    where nullif(btrim(wallet), '') is not null
  ) normalized;

  if coalesce(cardinality(p_root_wallets), 0) <> 3
     or coalesce(cardinality(v_roots), 0) <> 3 then
    return jsonb_build_object('ok', false, 'reason', 'exactly_three_roots_required');
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext('fresh-tail-epoch'));
  select * into v_config
  from public.bot_config
  where user_id = p_user_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'config_not_found');
  end if;

  select array_agg(v order by v) into v_config_roots
  from (
    select distinct btrim(wallet) as v
    from unnest(array_remove(array_prepend(
      nullif(btrim(v_config.target_wallet), ''),
      coalesce(v_config.additional_target_wallets, array[]::text[])
    ), null)) wallet
    where nullif(btrim(wallet), '') is not null
  ) configured;

  if v_config.enabled is not false then
    return jsonb_build_object('ok', false, 'reason', 'entries_must_be_off');
  elsif v_config.supply_accumulation_mode_enabled is not true then
    return jsonb_build_object('ok', false, 'reason', 'supply_accumulation_disabled');
  elsif v_config.custody_journey_enabled is not true then
    return jsonb_build_object('ok', false, 'reason', 'custody_journey_disabled');
  elsif v_config.direct_target_sell_exit_mode = 'proportional' then
    return jsonb_build_object('ok', false, 'reason', 'proportional_exit_proof_unavailable');
  elsif coalesce(cardinality(v_config_roots), 0) <> 3
        or v_config_roots is distinct from v_roots then
    return jsonb_build_object('ok', false, 'reason', 'configured_roots_mismatch');
  end if;

  select * into v_existing
  from public.custody_fresh_tail_epochs
  where user_id = p_user_id and status = 'active'
  for update;
  if found then
    if v_existing.activation_slot = p_activation_slot
       and v_existing.activation_blockhash = v_blockhash
       and v_existing.root_wallets = v_roots then
      return jsonb_build_object(
        'ok', true, 'reason', 'already_active', 'epochId', v_existing.id,
        'activationSlot', v_existing.activation_slot,
        'activationBlockhash', v_existing.activation_blockhash,
        'rootWallets', v_existing.root_wallets, 'status', v_existing.status,
        'scopeRevision', v_existing.scope_revision
      );
    end if;
    return jsonb_build_object('ok', false, 'reason', 'active_epoch_exists');
  end if;

  insert into public.custody_fresh_tail_epochs (
    user_id, activation_slot, activation_blockhash, activation_block_time,
    root_wallets, root_fingerprint
  ) values (
    p_user_id, p_activation_slot, v_blockhash, p_activation_block_time,
    v_roots, encode(extensions.digest(to_jsonb(v_roots)::text, 'sha256'), 'hex')
  ) returning id into v_epoch_id;

  insert into public.custody_fresh_tail_finalized_heads (
    epoch_id, user_id, slot, blockhash, block_time,
    first_lease_generation, last_lease_generation
  ) values (
    v_epoch_id, p_user_id, p_activation_slot, v_blockhash,
    p_activation_block_time, 0, 0
  );

  insert into public.custody_fresh_tail_roots (
    epoch_id, user_id, wallet, ordinal, floor_slot, boundary_kind
  )
  select v_epoch_id, p_user_id, wallet, ordinal::integer,
    p_activation_slot, 'exclusive_slot'
  from unnest(v_roots) with ordinality roots(wallet, ordinal);

  insert into public.custody_fresh_tail_cursors (
    epoch_id, user_id, scope_mint, wallet, cursor_role, floor_slot,
    initial_boundary_kind, current_boundary_kind
  )
  select v_epoch_id, p_user_id, '*', wallet, 'root', p_activation_slot,
    'exclusive_slot', 'exclusive_slot'
  from unnest(v_roots) wallet;

  return jsonb_build_object(
    'ok', true, 'reason', 'activated', 'epochId', v_epoch_id,
    'activationSlot', p_activation_slot, 'activationBlockhash', v_blockhash,
    'rootWallets', v_roots, 'status', 'active', 'scopeRevision', 0
  );
end;
$$;

-- Restart discovery is deliberately separate from activation.  It neither
-- samples a new boundary nor depends on Entries state, and it never exposes
-- the current lease token to a replacement process.
create or replace function public.get_custody_fresh_tail_active_epoch(
  p_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_roots text[];
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;
  if p_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_epoch_lookup');
  end if;

  select * into v_epoch
  from public.custody_fresh_tail_epochs
  where user_id = p_user_id and status = 'active';
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_active_epoch');
  end if;
  select array_agg(wallet order by wallet) into v_roots
  from public.custody_fresh_tail_roots
  where epoch_id = v_epoch.id and user_id = p_user_id;
  if coalesce(cardinality(v_roots), 0) <> 3
     or v_roots is distinct from v_epoch.root_wallets
     or v_epoch.root_fingerprint <>
       encode(extensions.digest(to_jsonb(v_roots)::text, 'sha256'), 'hex') then
    return jsonb_build_object(
      'ok', false, 'reason', 'active_epoch_root_identity_corrupt',
      'epochId', v_epoch.id
    );
  end if;

  return jsonb_build_object(
    'ok', true, 'reason', 'active_epoch_found',
    'epochId', v_epoch.id,
    'activationSlot', v_epoch.activation_slot,
    'activationBlockhash', v_epoch.activation_blockhash,
    'activationBlockTime', v_epoch.activation_block_time,
    'rootWallets', v_epoch.root_wallets,
    'rootFingerprint', v_epoch.root_fingerprint,
    'scopeRevision', v_epoch.scope_revision,
    'leaseOwner', v_epoch.lease_owner,
    'leaseGeneration', v_epoch.lease_generation,
    'leaseExpiresAt', v_epoch.lease_expires_at,
    'status', v_epoch.status
  );
end;
$$;

create or replace function public.acquire_custody_fresh_tail_lease(
  p_user_id uuid,
  p_epoch_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 30,
  p_expected_lease_token uuid default null,
  p_expected_lease_generation bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_token uuid;
  v_generation bigint;
  v_expires timestamptz;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;
  if p_user_id is null or p_epoch_id is null or v_worker = ''
     or p_lease_seconds is null or p_lease_seconds not between 5 and 120
     or ((p_expected_lease_token is null) <> (p_expected_lease_generation is null))
     or (p_expected_lease_generation is not null and p_expected_lease_generation <= 0) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_lease_request');
  end if;

  select * into v_epoch
  from public.custody_fresh_tail_epochs
  where id = p_epoch_id and user_id = p_user_id
  for update;
  if not found or v_epoch.status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'epoch_not_active');
  end if;

  if v_epoch.lease_expires_at > clock_timestamp() then
    -- A worker name is diagnostic metadata, not a fencing credential.  An
    -- unexpired lease can only be renewed by presenting its exact secret token
    -- and generation; a restarted or duplicate same-name process must wait for
    -- expiry and acquire a new generation.
    if v_epoch.lease_owner is distinct from v_worker
       or p_expected_lease_token is null
       or v_epoch.lease_token is distinct from p_expected_lease_token
       or v_epoch.lease_generation is distinct from p_expected_lease_generation then
      return jsonb_build_object(
        'ok', false, 'reason', 'lease_busy_or_fenced',
        'epochId', v_epoch.id, 'leaseExpiresAt', v_epoch.lease_expires_at,
        'leaseGeneration', v_epoch.lease_generation
      );
    end if;
    v_token := v_epoch.lease_token;
    v_generation := v_epoch.lease_generation;
  else
    v_token := gen_random_uuid();
    v_generation := v_epoch.lease_generation + 1;
  end if;
  v_expires := clock_timestamp() + make_interval(secs => p_lease_seconds);

  update public.custody_fresh_tail_epochs set
    lease_owner = v_worker,
    lease_token = v_token,
    lease_generation = v_generation,
    lease_expires_at = v_expires,
    updated_at = now()
  where id = v_epoch.id;

  return jsonb_build_object(
    'ok', true,
    'reason', case when p_expected_lease_token is null then 'leased' else 'renewed' end,
    'epochId', v_epoch.id,
    'leaseToken', v_token, 'leaseGeneration', v_generation,
    'leaseExpiresAt', v_expires
  );
end;
$$;

create or replace function public.record_custody_fresh_tail_heartbeat(
  p_user_id uuid,
  p_epoch_id uuid,
  p_worker_id text,
  p_enabled boolean,
  p_shadow boolean,
  p_latest_head_slot bigint,
  p_latest_head_blockhash text,
  p_latest_head_block_time timestamptz,
  p_last_success_at timestamptz,
  p_last_error text,
  p_lease_token uuid,
  p_lease_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_head_hash text := btrim(coalesce(p_latest_head_blockhash, ''));
  v_last_error text := nullif(btrim(coalesce(p_last_error, '')), '');
  v_root_covered integer;
  v_root_backlog integer;
  v_max_root_lag bigint;
  v_active_mints integer;
  v_poisoned_mints integer;
  v_retired_mints integer;
  v_pending_candidates integer;
  v_oldest_candidate_age bigint;
  v_descendant_required integer;
  v_descendant_covered integer;
  v_incomplete_backscans integer;
  v_exit_pending integer;
  v_exit_retry integer;
  v_exit_uncertain integer;
begin
  v_epoch := public.assert_custody_fresh_tail_lease(
    p_user_id, p_epoch_id, p_lease_token, p_lease_generation
  );
  if v_worker = '' or v_worker <> v_epoch.lease_owner
     or p_enabled is null or p_shadow is null
     or p_latest_head_slot is null or v_head_hash = ''
     or p_latest_head_block_time is null
     or p_last_success_at > clock_timestamp() then
    return jsonb_build_object('ok', false, 'reason', 'invalid_heartbeat');
  end if;
  if not exists (
    select 1 from public.custody_fresh_tail_finalized_heads h
    where h.epoch_id = p_epoch_id and h.user_id = p_user_id
      and h.slot = p_latest_head_slot and h.blockhash = v_head_hash
      and h.block_time = p_latest_head_block_time
  ) or exists (
    select 1 from public.custody_fresh_tail_finalized_heads h
    where h.epoch_id = p_epoch_id and h.slot > p_latest_head_slot
  ) then
    return jsonb_build_object('ok', false, 'reason', 'heartbeat_head_not_latest');
  end if;

  select
    count(*) filter (where not c.backlog_detected and c.history_floor_proven
      and exists (
        select 1 from public.custody_fresh_tail_coverage_attestations a
        where a.epoch_id = p_epoch_id and a.lane_kind = 'main'
          and a.scope_mint = '*' and a.wallet = r.wallet
          and a.covered_head_slot = p_latest_head_slot
          and a.covered_head_blockhash = v_head_hash
          and a.coverage_revision = 0
          and a.lease_generation = p_lease_generation
      ))::integer,
    count(*) filter (where c.wallet is null or c.backlog_detected
      or not c.history_floor_proven)::integer,
    coalesce(max(greatest(0, p_latest_head_slot
      - coalesce(c.covered_through_slot, r.floor_slot))), 0)::bigint
  into v_root_covered, v_root_backlog, v_max_root_lag
  from public.custody_fresh_tail_roots r
  left join public.custody_fresh_tail_cursors c
    on c.epoch_id = r.epoch_id and c.scope_mint = '*' and c.wallet = r.wallet
  where r.epoch_id = p_epoch_id;

  select
    count(*) filter (where status = 'active' and not poisoned)::integer,
    count(*) filter (where poisoned)::integer,
    count(*) filter (where status = 'retired')::integer
  into v_active_mints, v_poisoned_mints, v_retired_mints
  from public.custody_fresh_tail_mints where epoch_id = p_epoch_id;

  select count(*)::integer,
    case when min(q.trigger_block_time) is null then null else
      greatest(0, extract(epoch from
        (clock_timestamp() - min(q.trigger_block_time)))::bigint) end
  into v_pending_candidates, v_oldest_candidate_age
  from public.custody_fresh_tail_requests q
  where q.epoch_id = p_epoch_id and q.status = 'settled'
    and q.expires_at > clock_timestamp()
    and not exists (
      select 1 from public.entry_signal_claims c
      where c.fresh_tail_request_id = q.id
    );

  select count(*)::integer,
    count(*) filter (where w.watch_status = 'active'
      and w.classification_reliable and not c.backlog_detected
      and c.history_floor_proven and c.coverage_revision = m.scope_revision
      and exists (
        select 1 from public.custody_fresh_tail_coverage_attestations a
        where a.epoch_id = p_epoch_id and a.lane_kind = 'main'
          and a.scope_mint = w.token_mint and a.wallet = w.wallet
          and a.covered_head_slot = p_latest_head_slot
          and a.covered_head_blockhash = v_head_hash
          and a.coverage_revision = m.scope_revision
          and a.lease_generation = p_lease_generation
      ))::integer
  into v_descendant_required, v_descendant_covered
  from public.custody_fresh_tail_wallets w
  join public.custody_fresh_tail_mints m
    on m.epoch_id = w.epoch_id and m.token_mint = w.token_mint
   and m.status = 'active' and not m.poisoned
  left join public.custody_fresh_tail_cursors c
    on c.epoch_id = w.epoch_id and c.scope_mint = w.token_mint
   and c.wallet = w.wallet
  where w.epoch_id = p_epoch_id;

  select count(*)::integer into v_incomplete_backscans
  from public.custody_fresh_tail_backscan_ranges r
  join public.custody_fresh_tail_mints m
    on m.epoch_id = r.epoch_id and m.token_mint = r.token_mint
   and m.status = 'active' and not m.poisoned
  where r.epoch_id = p_epoch_id
    and (r.backlog_detected or not r.history_floor_proven
      or r.coverage_revision <> m.scope_revision
      or not exists (
        select 1 from public.custody_fresh_tail_coverage_attestations a
        where a.epoch_id = p_epoch_id and a.lane_kind = 'backscan'
          and a.range_id = r.id and a.covered_head_slot = p_latest_head_slot
          and a.covered_head_blockhash = v_head_hash
          and a.coverage_revision = m.scope_revision
          and a.lease_generation = p_lease_generation
      ));

  select
    count(*) filter (where status = 'pending')::integer,
    count(*) filter (where status = 'retry')::integer,
    count(*) filter (where status = 'uncertain')::integer
  into v_exit_pending, v_exit_retry, v_exit_uncertain
  from public.custody_fresh_tail_exit_intents where epoch_id = p_epoch_id;

  insert into public.custody_fresh_tail_worker_heartbeat (
    user_id, epoch_id, worker_id, lease_token, lease_generation,
    lease_expires_at, enabled, shadow, latest_head_slot,
    latest_head_blockhash, latest_head_block_time,
    root_required_count, root_covered_count, root_backlog_count,
    max_root_lag_slots, active_mint_count, poisoned_mint_count,
    retired_mint_count, pending_candidate_count,
    oldest_pending_candidate_age_seconds, descendant_required_count,
    descendant_covered_count, incomplete_backscan_count,
    exit_pending_count, exit_retry_count, exit_uncertain_count,
    last_success_at, last_error, updated_at
  ) values (
    p_user_id, p_epoch_id, v_worker, p_lease_token, p_lease_generation,
    v_epoch.lease_expires_at, p_enabled, p_shadow, p_latest_head_slot,
    v_head_hash, p_latest_head_block_time,
    3, v_root_covered, v_root_backlog, v_max_root_lag,
    v_active_mints, v_poisoned_mints, v_retired_mints,
    v_pending_candidates, v_oldest_candidate_age,
    v_descendant_required, v_descendant_covered, v_incomplete_backscans,
    v_exit_pending, v_exit_retry, v_exit_uncertain,
    p_last_success_at, v_last_error, clock_timestamp()
  ) on conflict (user_id, epoch_id) do update set
    worker_id = excluded.worker_id, lease_token = excluded.lease_token,
    lease_generation = excluded.lease_generation,
    lease_expires_at = excluded.lease_expires_at,
    enabled = excluded.enabled, shadow = excluded.shadow,
    latest_head_slot = excluded.latest_head_slot,
    latest_head_blockhash = excluded.latest_head_blockhash,
    latest_head_block_time = excluded.latest_head_block_time,
    root_required_count = excluded.root_required_count,
    root_covered_count = excluded.root_covered_count,
    root_backlog_count = excluded.root_backlog_count,
    max_root_lag_slots = excluded.max_root_lag_slots,
    active_mint_count = excluded.active_mint_count,
    poisoned_mint_count = excluded.poisoned_mint_count,
    retired_mint_count = excluded.retired_mint_count,
    pending_candidate_count = excluded.pending_candidate_count,
    oldest_pending_candidate_age_seconds = excluded.oldest_pending_candidate_age_seconds,
    descendant_required_count = excluded.descendant_required_count,
    descendant_covered_count = excluded.descendant_covered_count,
    incomplete_backscan_count = excluded.incomplete_backscan_count,
    exit_pending_count = excluded.exit_pending_count,
    exit_retry_count = excluded.exit_retry_count,
    exit_uncertain_count = excluded.exit_uncertain_count,
    last_success_at = excluded.last_success_at,
    last_error = excluded.last_error, updated_at = excluded.updated_at;

  return jsonb_build_object(
    'ok', true, 'reason', 'heartbeat_recorded', 'epochId', p_epoch_id,
    'workerId', v_worker, 'leaseGeneration', p_lease_generation,
    'leaseExpiresAt', v_epoch.lease_expires_at,
    'latestHeadSlot', p_latest_head_slot,
    'rootRequiredCount', 3, 'rootCoveredCount', v_root_covered,
    'rootBacklogCount', v_root_backlog, 'maxRootLagSlots', v_max_root_lag,
    'activeMintCount', v_active_mints, 'poisonedMintCount', v_poisoned_mints,
    'retiredMintCount', v_retired_mints,
    'pendingCandidateCount', v_pending_candidates,
    'oldestPendingCandidateAgeSeconds', v_oldest_candidate_age,
    'descendantRequiredCount', v_descendant_required,
    'descendantCoveredCount', v_descendant_covered,
    'incompleteBackscanCount', v_incomplete_backscans,
    'exitPendingCount', v_exit_pending, 'exitRetryCount', v_exit_retry,
    'exitUncertainCount', v_exit_uncertain, 'updatedAt', clock_timestamp()
  );
end;
$$;

create or replace function public.get_custody_fresh_tail_work(
  p_user_id uuid,
  p_epoch_id uuid,
  p_lease_token uuid,
  p_lease_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_root_floor_slot bigint;
  v_active_mint_count bigint;
  v_active_wallet_count bigint;
  v_active_backscan_count bigint;
  v_live_request_count bigint;
  v_relevant_rejection_count bigint;
  v_active_binding_count bigint;
begin
  v_epoch := public.assert_custody_fresh_tail_lease(
    p_user_id, p_epoch_id, p_lease_token, p_lease_generation
  );

  select min(coalesce(c.last_processed_slot, c.floor_slot))
  into v_root_floor_slot
  from public.custody_fresh_tail_cursors c
  where c.epoch_id = p_epoch_id and c.scope_mint = '*'
    and c.cursor_role = 'root';
  v_root_floor_slot := coalesce(v_root_floor_slot, v_epoch.activation_slot);

  select count(*) into v_active_mint_count
  from public.custody_fresh_tail_mints m
  where m.epoch_id = p_epoch_id and m.status = 'active';
  select count(*) into v_active_wallet_count
  from public.custody_fresh_tail_wallets w
  join public.custody_fresh_tail_mints m
    on m.epoch_id = w.epoch_id and m.token_mint = w.token_mint
   and m.status = 'active'
  where w.epoch_id = p_epoch_id;
  select count(*) into v_active_backscan_count
  from public.custody_fresh_tail_backscan_ranges r
  join public.custody_fresh_tail_mints m
    on m.epoch_id = r.epoch_id and m.token_mint = r.token_mint
   and m.status = 'active'
  where r.epoch_id = p_epoch_id;
  select count(*) into v_live_request_count
  from public.custody_fresh_tail_requests q
  where q.epoch_id = p_epoch_id and q.status in ('pending', 'settled');
  select count(*) into v_relevant_rejection_count
  from public.custody_fresh_tail_mint_rejections r
  where r.epoch_id = p_epoch_id and r.source_slot >= v_root_floor_slot;
  select count(*) into v_active_binding_count
  from public.entry_signal_claims c
  join public.custody_fresh_tail_mints m
    on m.epoch_id = c.fresh_tail_epoch_id and m.token_mint = c.token_mint
   and m.status = 'active'
  where c.user_id = p_user_id and c.fresh_tail_epoch_id = p_epoch_id
    and c.fresh_tail_monitoring_armed_at is not null
    and (
      c.status in ('claimed', 'submitted', 'landed', 'uncertain')
      or exists (
        select 1 from public.positions p
        where p.id = c.planned_position_id and p.user_id = c.user_id
          and p.closed_at is null
      )
    );

  -- Never construct an unbounded JSON work snapshot.  Crossing a cap stops
  -- this isolated observer lane fail-closed; it cannot affect the main worker
  -- or authorize an entry with an incomplete view.
  if v_active_mint_count > 256
     or v_active_wallet_count > 2048
     or v_active_backscan_count > 2048
     or v_live_request_count > 256
     or v_relevant_rejection_count > 2048
     or v_active_binding_count > 512 then
    return jsonb_build_object(
      'ok', false, 'reason', 'work_resource_cap',
      'activeMintCount', v_active_mint_count,
      'activeWalletCount', v_active_wallet_count,
      'activeBackscanCount', v_active_backscan_count,
      'liveRequestCount', v_live_request_count,
      'relevantRejectionCount', v_relevant_rejection_count,
      'activeBindingCount', v_active_binding_count
    );
  end if;
  return jsonb_build_object(
    'ok', true,
    'reason', 'loaded',
    'epoch', jsonb_build_object(
      'epochId', v_epoch.id,
      'activationSlot', v_epoch.activation_slot,
      'activationBlockhash', v_epoch.activation_blockhash,
      'status', v_epoch.status,
      'scopeRevision', v_epoch.scope_revision,
      'leaseGeneration', v_epoch.lease_generation,
      'leaseExpiresAt', v_epoch.lease_expires_at
    ),
    'roots', coalesce((
      select jsonb_agg(jsonb_build_object(
        'wallet', r.wallet, 'ordinal', r.ordinal, 'floorSlot', r.floor_slot,
        'boundaryKind', r.boundary_kind
      ) order by r.ordinal)
      from public.custody_fresh_tail_roots r where r.epoch_id = p_epoch_id
    ), '[]'::jsonb),
    'latestFinalizedHead', coalesce((
      select jsonb_build_object(
        'slot', h.slot, 'blockhash', h.blockhash, 'blockTime', h.block_time,
        'firstLeaseGeneration', h.first_lease_generation,
        'lastLeaseGeneration', h.last_lease_generation
      )
      from public.custody_fresh_tail_finalized_heads h
      where h.epoch_id = p_epoch_id
      order by h.slot desc
      limit 1
    ), '{}'::jsonb),
    'mints', coalesce((
      select jsonb_agg(jsonb_build_object(
        'tokenMint', m.token_mint, 'creationSlot', m.creation_slot,
        'enrollmentEventKey', m.enrollment_event_key,
        'enrollmentTxSig', m.enrollment_tx_sig,
        'enrollmentSlot', m.enrollment_slot,
        'enrollmentBlockhash', m.enrollment_blockhash,
        'enrollmentBlockTime', m.enrollment_block_time,
        'lastSupplyEventBlockTime', coalesce((
          select max(e.block_time)
          from public.custody_fresh_tail_supply_events e
          where e.epoch_id = m.epoch_id and e.token_mint = m.token_mint
        ), m.enrollment_block_time),
        'enrollmentTargetWallet', m.enrollment_target_wallet,
        'bondingCurve', m.bonding_curve, 'creator', m.creator,
        'createVariant', m.create_variant, 'tokenProgram', m.token_program,
        'mintLayoutFingerprint', m.mint_layout_fingerprint,
        'parserAbiFingerprint', m.parser_abi_fingerprint,
        'totalSupplyRaw', m.total_supply_raw::text, 'decimals', m.decimals,
        'status', m.status,
        'scopeRevision', m.scope_revision, 'poisoned', m.poisoned,
        'poisonReason', m.poison_reason, 'retireReason', m.retire_reason,
        'retiredAt', m.retired_at
      ) order by m.token_mint)
      from public.custody_fresh_tail_mints m
      where m.epoch_id = p_epoch_id and m.status = 'active'
    ), '[]'::jsonb),
    'rejections', coalesce((
      select jsonb_agg(jsonb_build_object(
        'tokenMint', r.token_mint, 'sourceTxSig', r.source_tx_sig,
        'sourceSlot', r.source_slot, 'rejectionCode', r.rejection_code,
        'parserAbiFingerprint', r.parser_abi_fingerprint,
        'proofFingerprint', r.proof_fingerprint,
        'quarantined', r.quarantined, 'conflictCount', r.conflict_count
      ) order by r.token_mint)
      from public.custody_fresh_tail_mint_rejections r
      where r.epoch_id = p_epoch_id and r.source_slot >= v_root_floor_slot
    ), '[]'::jsonb),
    'wallets', coalesce((
      select jsonb_agg(jsonb_build_object(
        'tokenMint', w.token_mint, 'wallet', w.wallet,
        'parentWallet', w.parent_wallet, 'discoverySlot', w.discovery_slot,
        'boundaryKind', w.boundary_kind, 'watchStatus', w.watch_status,
        'classificationReliable', w.classification_reliable,
        'watchable', w.watch_status <> 'unwatchable',
        'addedRevision', w.added_revision
      ) order by w.token_mint, w.wallet)
      from public.custody_fresh_tail_wallets w
      join public.custody_fresh_tail_mints m
        on m.epoch_id = w.epoch_id and m.token_mint = w.token_mint
       and m.status = 'active'
      where w.epoch_id = p_epoch_id
    ), '[]'::jsonb),
    'cursors', coalesce((
      select jsonb_agg(jsonb_build_object(
        'scopeMint', c.scope_mint, 'wallet', c.wallet, 'role', c.cursor_role,
        'floorSlot', c.floor_slot, 'initialBoundaryKind', c.initial_boundary_kind,
        'boundaryKind', c.current_boundary_kind,
        'lastSignature', c.last_processed_signature,
        'lastSlot', c.last_processed_slot,
        'firstAvailableBlock', c.first_available_block,
        'historyFloorProven', c.history_floor_proven,
        'coveredThroughSlot', c.covered_through_slot,
        'coveredThroughBlockhash', c.covered_through_blockhash,
        'coverageRevision', c.coverage_revision,
        'backlogDetected', c.backlog_detected, 'lastError', c.last_error
      ) order by c.scope_mint, c.wallet)
      from public.custody_fresh_tail_cursors c
      where c.epoch_id = p_epoch_id
        and (c.scope_mint = '*' or exists (
          select 1 from public.custody_fresh_tail_mints m
          where m.epoch_id = c.epoch_id and m.token_mint = c.scope_mint
            and m.status = 'active'
        ))
    ), '[]'::jsonb),
    'backscanRanges', coalesce((
      select jsonb_agg(jsonb_build_object(
        'rangeId', r.id, 'tokenMint', r.token_mint, 'wallet', r.wallet,
        'floorSlot', r.floor_slot, 'boundaryKind', r.current_boundary_kind,
        'lastSignature', r.last_processed_signature,
        'lastSlot', r.last_processed_slot,
        'firstAvailableBlock', r.first_available_block,
        'historyFloorProven', r.history_floor_proven,
        'coveredThroughSlot', r.covered_through_slot,
        'coveredThroughBlockhash', r.covered_through_blockhash,
        'coverageRevision', r.coverage_revision,
        'backlogDetected', r.backlog_detected, 'lastError', r.last_error
      ) order by r.token_mint, r.wallet, r.floor_slot, r.id)
      from public.custody_fresh_tail_backscan_ranges r
      join public.custody_fresh_tail_mints m
        on m.epoch_id = r.epoch_id and m.token_mint = r.token_mint
       and m.status = 'active'
      where r.epoch_id = p_epoch_id
    ), '[]'::jsonb),
    'requests', coalesce((
      select jsonb_agg(jsonb_build_object(
        'requestId', q.id, 'tokenMint', q.token_mint, 'status', q.status,
        'triggerEventKey', q.trigger_event_key, 'triggerSlot', q.trigger_slot,
        'triggerBlockTime', q.trigger_block_time, 'expiresAt', q.expires_at,
        'requestedHeadSlot', q.requested_head_slot,
        'requestedHeadBlockhash', q.requested_head_blockhash,
        'headSnapshotParserAbiFingerprint', q.head_snapshot_parser_abi_fingerprint,
        'headCurveStateFingerprint', q.head_curve_state_fingerprint,
        'headCurveObservedSlot', q.head_curve_observed_slot,
        'headCurveComplete', q.head_curve_complete,
        'headVirtualTokenReservesRaw', q.head_virtual_token_reserves_raw::text,
        'headVirtualSolReservesLamports', q.head_virtual_sol_reserves_lamports::text,
        'headRealTokenReservesRaw', q.head_real_token_reserves_raw::text,
        'headRealSolReservesLamports', q.head_real_sol_reserves_lamports::text,
        'headCurveTotalSupplyRaw', q.head_curve_total_supply_raw::text,
        'headMintLayoutFingerprint', q.head_mint_layout_fingerprint,
        'headTokenProgram', q.head_token_program,
        'headMintSupplyRaw', q.head_mint_supply_raw::text,
        'headMintDecimals', q.head_mint_decimals,
        'scopeRevision', q.scope_revision, 'settledRevision', q.settled_revision,
        'settledLeaseGeneration', q.settled_lease_generation
      ) order by q.created_at)
      from public.custody_fresh_tail_requests q
      where q.epoch_id = p_epoch_id and q.status in ('pending', 'settled')
    ), '[]'::jsonb),
    'armedBindings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'entryClaimId', c.id, 'positionId', c.planned_position_id,
        'tokenMint', c.token_mint, 'sourceSlot', c.source_slot,
        'epochId', c.fresh_tail_epoch_id, 'requestId', c.fresh_tail_request_id,
        'armedAt', c.fresh_tail_monitoring_armed_at
      ) order by c.created_at)
      from public.entry_signal_claims c
      join public.custody_fresh_tail_mints m
        on m.epoch_id = c.fresh_tail_epoch_id and m.token_mint = c.token_mint
       and m.status = 'active'
      where c.user_id = p_user_id and c.fresh_tail_epoch_id = p_epoch_id
        and c.fresh_tail_monitoring_armed_at is not null
        and (
          c.status in ('claimed', 'submitted', 'landed', 'uncertain')
          or exists (
            select 1 from public.positions p
            where p.id = c.planned_position_id and p.user_id = c.user_id
              and p.closed_at is null
          )
        )
    ), '[]'::jsonb),
    'exitIntentHealth', coalesce((
      select jsonb_object_agg(status, count)
      from (
        select i.status, count(*)::bigint as count
        from public.custody_fresh_tail_exit_intents i
        where i.user_id = p_user_id and i.epoch_id = p_epoch_id
        group by i.status
      ) counts
    ), '{}'::jsonb)
  );
end;
$$;

create or replace function public.get_custody_fresh_tail_retirement_candidates(
  p_user_id uuid,
  p_epoch_id uuid,
  p_limit integer,
  p_lease_token uuid,
  p_lease_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_active_count bigint;
  v_overflow_count bigint;
  v_candidates jsonb := '[]'::jsonb;
begin
  v_epoch := public.assert_custody_fresh_tail_lease(
    p_user_id, p_epoch_id, p_lease_token, p_lease_generation
  );
  if p_limit is null or p_limit not between 1 and 100 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_retirement_candidate_limit');
  end if;

  select count(*) into v_active_count
  from public.custody_fresh_tail_mints m
  where m.epoch_id = p_epoch_id and m.user_id = p_user_id
    and m.status = 'active';
  v_overflow_count := greatest(v_active_count - 256, 0);
  if v_overflow_count = 0 then
    return jsonb_build_object(
      'ok', true, 'reason', 'within_resource_cap',
      'activeMintCount', v_active_count, 'overflowCount', 0,
      'candidates', v_candidates
    );
  end if;

  -- This is a bounded capacity-eviction list, not retirement authority. The
  -- retire RPC repeats every request/claim/position/intent check under the
  -- mint advisory lock and scope-revision CAS before changing lifecycle state.
  select coalesce(jsonb_agg(jsonb_build_object(
    'tokenMint', candidate.token_mint,
    'scopeRevision', candidate.scope_revision,
    'reason', candidate.retire_reason,
    'lastSupplyEventBlockTime', candidate.last_supply_at
  ) order by candidate.poisoned desc, candidate.last_supply_at, candidate.token_mint), '[]'::jsonb)
  into v_candidates
  from (
    select m.token_mint, m.scope_revision, m.poisoned,
      case when m.poisoned then 'unsupported_after_enrollment'
        else 'resource_cap' end as retire_reason,
      coalesce((
        select max(e.block_time)
        from public.custody_fresh_tail_supply_events e
        where e.epoch_id = m.epoch_id and e.token_mint = m.token_mint
      ), m.enrollment_block_time) as last_supply_at
    from public.custody_fresh_tail_mints m
    where m.epoch_id = p_epoch_id and m.user_id = p_user_id
      and m.status = 'active'
      and not exists (
        select 1 from public.custody_fresh_tail_requests q
        where q.epoch_id = m.epoch_id and q.token_mint = m.token_mint
          and q.status in ('pending', 'settled')
          and q.expires_at > clock_timestamp()
      )
      and not exists (
        select 1 from public.entry_signal_claims c
        where c.user_id = p_user_id and c.fresh_tail_epoch_id = m.epoch_id
          and c.token_mint = m.token_mint
          and c.fresh_tail_monitoring_armed_at is not null
          and (
            c.status in ('claimed', 'submitted', 'landed', 'uncertain')
            or (
              c.status = 'persisted'
              and not exists (
                select 1 from public.positions p
                where p.id = c.planned_position_id and p.user_id = c.user_id
                  and p.token_mint = c.token_mint and p.closed_at is not null
              )
            )
          )
      )
      and not exists (
        select 1
        from public.positions p
        join public.entry_signal_claims c on c.planned_position_id = p.id
        where p.user_id = p_user_id and p.token_mint = m.token_mint
          and p.closed_at is null and c.fresh_tail_epoch_id = m.epoch_id
      )
      and not exists (
        select 1 from public.custody_fresh_tail_exit_intents i
        where i.user_id = p_user_id and i.epoch_id = m.epoch_id
          and i.token_mint = m.token_mint
          and i.status not in ('resolved', 'dismissed')
      )
    order by m.poisoned desc, last_supply_at, m.token_mint
    limit least(p_limit::bigint, v_overflow_count)
  ) candidate;

  return jsonb_build_object(
    'ok', true, 'reason', case when jsonb_array_length(v_candidates) > 0
      then 'resource_retirement_candidates' else 'resource_cap_blocked' end,
    'activeMintCount', v_active_count,
    'overflowCount', v_overflow_count,
    'candidates', v_candidates
  );
end;
$$;

create or replace function public.record_custody_fresh_tail_supply_event(
  p_user_id uuid,
  p_epoch_id uuid,
  p_event_key text,
  p_tx_sig text,
  p_slot bigint,
  p_block_time timestamptz,
  p_target_wallet text,
  p_token_mint text,
  p_side text,
  p_amount_raw numeric,
  p_total_supply_raw numeric,
  p_decimals integer,
  p_market_cap_usd numeric,
  p_valuation_slot bigint,
  p_market_data_reliable boolean,
  p_pump_fun_verified boolean,
  p_classification_reliable boolean,
  p_parser_domain text,
  p_parser_abi_fingerprint text,
  p_finalized_head_slot bigint,
  p_finalized_head_blockhash text,
  p_lease_token uuid,
  p_lease_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_mint public.custody_fresh_tail_mints%rowtype;
  v_existing public.custody_fresh_tail_supply_events%rowtype;
  v_event_id uuid;
  v_event_key text := btrim(coalesce(p_event_key, ''));
  v_sig text := btrim(coalesce(p_tx_sig, ''));
  v_target text := btrim(coalesce(p_target_wallet, ''));
  v_token_mint text := btrim(coalesce(p_token_mint, ''));
  v_side text := lower(btrim(coalesce(p_side, '')));
  v_parser_domain text := lower(btrim(coalesce(p_parser_domain, '')));
  v_abi text := btrim(coalesce(p_parser_abi_fingerprint, ''));
  v_head_hash text := btrim(coalesce(p_finalized_head_blockhash, ''));
  v_fingerprint text;
begin
  v_epoch := public.assert_custody_fresh_tail_lease(
    p_user_id, p_epoch_id, p_lease_token, p_lease_generation
  );
  if v_event_key = '' or v_sig = '' or v_target = '' or v_token_mint = ''
     or v_side not in ('buy', 'sell')
     or v_event_key <> v_sig || ':' || v_token_mint || ':supply:'
       || upper(v_side) || ':' || v_target
     or p_market_data_reliable is null or p_pump_fun_verified is null
     or p_classification_reliable is null
     or p_slot is null or p_slot <= v_epoch.activation_slot
     or p_block_time is null or p_block_time < v_epoch.activation_block_time
     or p_amount_raw is null or p_amount_raw <= 0
     or p_total_supply_raw is distinct from 1000000000000000::numeric
     or p_decimals is distinct from 6
     or v_parser_domain <> (case when v_side = 'buy'
       then 'pump_root_buy_v1' else 'supply_sell_v1' end)
     or v_abi = '' or v_head_hash = ''
     or p_finalized_head_slot is null or p_finalized_head_slot < p_slot
     or (p_market_data_reliable and (
       p_market_cap_usd is null or p_market_cap_usd <= 0
       or p_valuation_slot is distinct from p_slot
     )) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_supply_event');
  end if;
  if p_classification_reliable is not true then
    return jsonb_build_object('ok', false, 'reason', 'classification_pending');
  end if;
  if not public.is_custody_fresh_tail_parser_reviewed(v_parser_domain, v_abi) then
    return jsonb_build_object('ok', false, 'reason', 'parser_not_reviewed');
  end if;
  if not exists (
    select 1 from public.custody_fresh_tail_finalized_heads h
    where h.epoch_id = p_epoch_id and h.user_id = p_user_id
      and h.slot = p_finalized_head_slot and h.blockhash = v_head_hash
      and p_block_time <= h.block_time
  ) then
    return jsonb_build_object('ok', false, 'reason', 'finalized_head_not_attested');
  end if;
  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(v_token_mint));
  select * into v_mint
  from public.custody_fresh_tail_mints
  where epoch_id = p_epoch_id and user_id = p_user_id and token_mint = v_token_mint
  for update;
  if not found or v_mint.status <> 'active' or v_mint.poisoned then
    return jsonb_build_object('ok', false, 'reason', 'mint_not_active');
  end if;
  if exists (
    select 1 from public.custody_fresh_tail_mint_rejections
    where epoch_id = p_epoch_id and token_mint = v_token_mint
  ) then
    return jsonb_build_object('ok', false, 'reason', 'mint_tombstoned');
  end if;
  if not exists (
    select 1 from public.custody_fresh_tail_roots
    where epoch_id = p_epoch_id and wallet = v_target
  ) then
    return jsonb_build_object('ok', false, 'reason', 'target_not_epoch_root');
  end if;
  if v_mint.total_supply_raw <> p_total_supply_raw
     or v_mint.decimals <> p_decimals then
    update public.custody_fresh_tail_mints set
      poisoned = true, poison_reason = 'supply_creation_mismatch', updated_at = now()
    where epoch_id = p_epoch_id and token_mint = v_token_mint;
    return jsonb_build_object('ok', false, 'reason', 'supply_creation_mismatch');
  end if;
  if v_event_key = v_mint.enrollment_event_key and (
    v_side <> 'buy'
    or v_sig <> v_mint.enrollment_tx_sig
    or p_slot <> v_mint.enrollment_slot
    or p_block_time <> v_mint.enrollment_block_time
    or v_target <> v_mint.enrollment_target_wallet
  ) then
    update public.custody_fresh_tail_mints set
      poisoned = true, poison_reason = 'enrollment_event_mismatch', updated_at = now()
    where epoch_id = p_epoch_id and token_mint = v_token_mint;
    return jsonb_build_object('ok', false, 'reason', 'enrollment_event_mismatch');
  end if;

  v_fingerprint := encode(extensions.digest(jsonb_build_object(
    'eventKey', v_event_key, 'txSig', v_sig, 'slot', p_slot,
    'blockTime', p_block_time, 'targetWallet', v_target,
    'tokenMint', v_token_mint, 'side', v_side,
    'amountRaw', p_amount_raw::text, 'totalSupplyRaw', p_total_supply_raw::text,
    'decimals', p_decimals, 'marketCapUsd', p_market_cap_usd::text,
    'valuationSlot', p_valuation_slot, 'marketDataReliable', p_market_data_reliable,
    'pumpFunVerified', p_pump_fun_verified,
    'classificationReliable', p_classification_reliable,
    'parserDomain', v_parser_domain,
    'parserAbiFingerprint', v_abi
  )::text, 'sha256'), 'hex');

  select * into v_existing
  from public.custody_fresh_tail_supply_events
  where epoch_id = p_epoch_id and event_key = v_event_key
  for update;
  if found then
    if v_existing.payload_fingerprint <> v_fingerprint
       or (v_existing.finalized_head_slot = p_finalized_head_slot
         and v_existing.finalized_head_blockhash <> v_head_hash) then
      update public.custody_fresh_tail_supply_events set
        quarantined = true,
        conflict_count = conflict_count + 1,
        first_conflict_at = coalesce(first_conflict_at, now())
      where id = v_existing.id;
      update public.custody_fresh_tail_mints set
        poisoned = true, poison_reason = 'supply_payload_conflict', updated_at = now()
      where epoch_id = p_epoch_id and token_mint = v_token_mint;
      if v_existing.finalized_head_slot = p_finalized_head_slot
         and v_existing.finalized_head_blockhash <> v_head_hash then
        update public.custody_fresh_tail_epochs set
          status = 'invalidated', invalid_reason = 'finalized_head_blockhash_conflict',
          updated_at = now()
        where id = p_epoch_id;
      end if;
      -- A payload conflict discovered after an entry was armed is itself
      -- terminal evidence.  Persist protective exit work before returning so
      -- a crash/replay cannot leave the landed position without an action.
      insert into public.custody_fresh_tail_exit_intents (
        user_id, epoch_id, request_id, token_mint, entry_claim_id,
        position_id, source_domain, supply_event_id, trigger_kind
      )
      select c.user_id, p_epoch_id, c.fresh_tail_request_id, v_token_mint,
        c.id, c.planned_position_id, 'supply', v_existing.id, 'terminal_outflow'
      from public.entry_signal_claims c
      where c.user_id = p_user_id
        and c.fresh_tail_epoch_id = p_epoch_id
        and c.token_mint = v_token_mint
        and c.fresh_tail_monitoring_armed_at is not null
      on conflict do nothing;
      return jsonb_build_object(
        'ok', false, 'reason', 'payload_conflict', 'epochId', p_epoch_id,
        'eventId', v_existing.id, 'eventKey', v_event_key,
        'duplicate', true, 'payloadMismatch', true, 'quarantined', true,
        'durableConflict', true, 'terminalPoison', true
      );
    end if;
    if p_finalized_head_slot > v_existing.finalized_head_slot then
      update public.custody_fresh_tail_supply_events set
        finalized_head_slot = p_finalized_head_slot,
        finalized_head_blockhash = v_head_hash
      where id = v_existing.id;
    end if;
    return jsonb_build_object(
      'ok', not v_existing.quarantined, 'reason', case
        when v_existing.quarantined then 'quarantined' else 'duplicate'
      end,
      'epochId', p_epoch_id, 'eventId', v_existing.id,
      'eventKey', v_event_key, 'duplicate', true,
      'payloadMismatch', false, 'quarantined', v_existing.quarantined,
      'amountRaw', v_existing.amount_raw::text
    );
  end if;

  insert into public.custody_fresh_tail_supply_events (
    epoch_id, user_id, event_key, payload_fingerprint, tx_sig, slot,
    block_time, target_wallet, token_mint, side, amount_raw,
    total_supply_raw, decimals, market_cap_usd, valuation_slot,
    market_data_reliable, pump_fun_verified, classification_reliable,
    parser_domain, parser_abi_fingerprint,
    finalized_head_slot, finalized_head_blockhash
  ) values (
    p_epoch_id, p_user_id, v_event_key, v_fingerprint, v_sig, p_slot,
    p_block_time, v_target, v_token_mint, v_side, p_amount_raw,
    p_total_supply_raw, p_decimals, p_market_cap_usd, p_valuation_slot,
    p_market_data_reliable, p_pump_fun_verified, p_classification_reliable,
    v_parser_domain, v_abi, p_finalized_head_slot, v_head_hash
  ) returning id into v_event_id;

  update public.custody_fresh_tail_requests set
    status = case when requested_head_slot < p_slot
      then 'invalidated' else 'pending' end,
    invalid_reason = case when requested_head_slot < p_slot
      then 'finalized_event_after_requested_head'
      else 'new_finalized_event_requires_resettle' end,
    settled_revision = null, settled_lease_generation = null,
    settled_at = null, updated_at = now()
  where epoch_id = p_epoch_id and token_mint = v_token_mint
    and status in ('pending', 'settled')
    and (requested_head_slot < p_slot or status = 'settled');

  if v_side = 'sell' then
    insert into public.custody_fresh_tail_exit_intents (
      user_id, epoch_id, request_id, token_mint, entry_claim_id,
      position_id, source_domain, supply_event_id, trigger_kind
    )
    select c.user_id, p_epoch_id, c.fresh_tail_request_id, v_token_mint,
      c.id, c.planned_position_id, 'supply', v_event_id, 'direct_target_sell'
    from public.entry_signal_claims c
    where c.user_id = p_user_id
      and c.fresh_tail_epoch_id = p_epoch_id
      and c.token_mint = v_token_mint
      and c.fresh_tail_monitoring_armed_at is not null
      and c.source_slot is not null and p_slot >= c.source_slot
    on conflict do nothing;
  end if;

  return jsonb_build_object(
    'ok', true, 'reason', 'recorded', 'epochId', p_epoch_id,
    'eventId', v_event_id, 'eventKey', v_event_key,
    'duplicate', false, 'payloadMismatch', false, 'quarantined', false,
    'amountRaw', p_amount_raw::text
  );
end;
$$;

create or replace function public.record_custody_fresh_tail_custody_event(
  p_user_id uuid,
  p_epoch_id uuid,
  p_event_key text,
  p_tx_sig text,
  p_slot bigint,
  p_block_time timestamptz,
  p_source_wallet text,
  p_token_mint text,
  p_event_kind text,
  p_amount_raw numeric,
  p_source_pre_raw numeric,
  p_source_post_raw numeric,
  p_decimals integer,
  p_recipients jsonb,
  p_classification text,
  p_classification_reliable boolean,
  p_watchable boolean,
  p_parser_domain text,
  p_parser_abi_fingerprint text,
  p_finalized_head_slot bigint,
  p_finalized_head_blockhash text,
  p_lease_token uuid,
  p_lease_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_mint public.custody_fresh_tail_mints%rowtype;
  v_existing public.custody_fresh_tail_custody_events%rowtype;
  v_event_id uuid;
  v_event_key text := btrim(coalesce(p_event_key, ''));
  v_sig text := btrim(coalesce(p_tx_sig, ''));
  v_source text := btrim(coalesce(p_source_wallet, ''));
  v_token_mint text := btrim(coalesce(p_token_mint, ''));
  v_kind text := upper(btrim(coalesce(p_event_kind, '')));
  v_classification text := btrim(coalesce(p_classification, ''));
  v_parser_domain text := lower(btrim(coalesce(p_parser_domain, '')));
  v_abi text := btrim(coalesce(p_parser_abi_fingerprint, ''));
  v_head_hash text := btrim(coalesce(p_finalized_head_blockhash, ''));
  v_recipients jsonb := '[]'::jsonb;
  v_fingerprint text;
  v_source_is_root boolean := false;
  v_terminal boolean := false;
  v_trigger_kind text;
begin
  v_epoch := public.assert_custody_fresh_tail_lease(
    p_user_id, p_epoch_id, p_lease_token, p_lease_generation
  );
  if v_event_key = '' or v_sig = '' or v_source = '' or v_token_mint = ''
     or v_kind not in (
       'TARGET_BUY', 'TRANSFER', 'SELL', 'UNRESOLVED_OUTFLOW', 'TERMINAL_OUTFLOW'
     )
     or v_event_key <> v_sig || ':' || v_token_mint || ':custody:'
       || v_kind || ':' || v_source
     or p_slot is null or p_slot <= v_epoch.activation_slot
     or p_block_time is null or p_block_time < v_epoch.activation_block_time
     or p_amount_raw is null or p_amount_raw <= 0
     or p_source_pre_raw is null or p_source_pre_raw < 0
     or p_source_post_raw is null or p_source_post_raw < 0
     or p_decimals is distinct from 6
     or p_watchable is null
     or v_classification = '' or v_parser_domain <> (case v_kind
       when 'TARGET_BUY' then 'custody_target_buy_v1'
       when 'TRANSFER' then 'custody_transfer_v1'
       when 'SELL' then 'custody_sell_v1'
       when 'UNRESOLVED_OUTFLOW' then 'custody_unresolved_v1'
       when 'TERMINAL_OUTFLOW' then 'custody_terminal_v1'
       else '' end)
     or v_abi = '' or v_head_hash = ''
     or p_finalized_head_slot is null or p_finalized_head_slot < p_slot
     or jsonb_typeof(coalesce(p_recipients, 'null'::jsonb)) <> 'array' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_custody_event');
  end if;

  if p_classification_reliable is not true then
    return jsonb_build_object('ok', false, 'reason', 'classification_pending');
  end if;
  if not public.is_custody_fresh_tail_parser_reviewed(v_parser_domain, v_abi) then
    return jsonb_build_object('ok', false, 'reason', 'parser_not_reviewed');
  end if;
  if not exists (
    select 1 from public.custody_fresh_tail_finalized_heads h
    where h.epoch_id = p_epoch_id and h.user_id = p_user_id
      and h.slot = p_finalized_head_slot and h.blockhash = v_head_hash
      and p_block_time <= h.block_time
  ) then
    return jsonb_build_object('ok', false, 'reason', 'finalized_head_not_attested');
  end if;

  if v_kind = 'TRANSFER' then
    if jsonb_array_length(p_recipients) not between 1 and 250
       or exists (
         select 1 from jsonb_array_elements(p_recipients) recipient
         where jsonb_typeof(recipient) <> 'object'
           or jsonb_typeof(recipient->'wallet') <> 'string'
           or nullif(btrim(recipient->>'wallet'), '') is null
           or coalesce(recipient->>'amountRaw', '') !~ '^[0-9]+$'
           or coalesce(recipient->>'preRaw', '') !~ '^[0-9]+$'
           or coalesce(recipient->>'postRaw', '') !~ '^[0-9]+$'
           or jsonb_typeof(recipient->'classification') <> 'string'
           or nullif(btrim(recipient->>'classification'), '') is null
           or jsonb_typeof(recipient->'classificationReliable') <> 'boolean'
           or jsonb_typeof(recipient->'watchable') <> 'boolean'
       ) then
      return jsonb_build_object('ok', false, 'reason', 'invalid_recipient_batch');
    end if;
    if exists (
      select 1 from jsonb_array_elements(p_recipients) recipient
      where (recipient->>'classificationReliable')::boolean is not true
    ) then
      return jsonb_build_object('ok', false, 'reason', 'classification_pending');
    end if;
    if (select count(*) from jsonb_array_elements(p_recipients)) <>
       (select count(distinct btrim(recipient->>'wallet'))
        from jsonb_array_elements(p_recipients) recipient)
       or exists (
         select 1 from jsonb_array_elements(p_recipients) recipient
         where btrim(recipient->>'wallet') = v_source
           or (recipient->>'amountRaw')::numeric <= 0
           or (recipient->>'postRaw')::numeric - (recipient->>'preRaw')::numeric
              <> (recipient->>'amountRaw')::numeric
       )
       or p_source_pre_raw - p_source_post_raw <> p_amount_raw
       or (select sum((recipient->>'amountRaw')::numeric)
           from jsonb_array_elements(p_recipients) recipient) <> p_amount_raw then
      return jsonb_build_object('ok', false, 'reason', 'nonconserving_recipient_batch');
    end if;

    select jsonb_agg(jsonb_build_object(
      'wallet', btrim(recipient->>'wallet'),
      'amountRaw', ((recipient->>'amountRaw')::numeric(78, 0))::text,
      'preRaw', ((recipient->>'preRaw')::numeric(78, 0))::text,
      'postRaw', ((recipient->>'postRaw')::numeric(78, 0))::text,
      'classification', btrim(recipient->>'classification'),
      'classificationReliable', (recipient->>'classificationReliable')::boolean,
      'watchable', (recipient->>'watchable')::boolean
    ) order by btrim(recipient->>'wallet')) into v_recipients
    from jsonb_array_elements(p_recipients) recipient;
  elsif jsonb_array_length(p_recipients) <> 0 then
    return jsonb_build_object('ok', false, 'reason', 'unexpected_recipients');
  end if;

  if v_kind = 'TARGET_BUY' then
    if p_source_post_raw - p_source_pre_raw <> p_amount_raw then
      return jsonb_build_object('ok', false, 'reason', 'nonconserving_target_buy');
    end if;
  elsif v_kind <> 'TRANSFER'
        and p_source_pre_raw - p_source_post_raw <> p_amount_raw then
    return jsonb_build_object('ok', false, 'reason', 'nonconserving_outflow');
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(v_token_mint));
  select * into v_mint
  from public.custody_fresh_tail_mints
  where epoch_id = p_epoch_id and user_id = p_user_id and token_mint = v_token_mint
  for update;
  if not found or v_mint.status <> 'active' or v_mint.poisoned then
    return jsonb_build_object('ok', false, 'reason', 'mint_not_active');
  end if;
  if v_mint.decimals <> p_decimals then
    update public.custody_fresh_tail_mints set
      poisoned = true, poison_reason = 'custody_creation_mismatch', updated_at = now()
    where epoch_id = p_epoch_id and token_mint = v_token_mint;
    return jsonb_build_object('ok', false, 'reason', 'custody_creation_mismatch');
  end if;

  select exists (
    select 1 from public.custody_fresh_tail_roots
    where epoch_id = p_epoch_id and wallet = v_source
  ) into v_source_is_root;
  if v_kind = 'TARGET_BUY' and not v_source_is_root then
    return jsonb_build_object('ok', false, 'reason', 'target_buy_not_epoch_root');
  elsif v_kind = 'SELL' and v_source_is_root then
    -- Root sells belong to the fresh Supply ledger.  Rejecting a duplicate
    -- Custody SELL prevents two independent exit intents for one root sale.
    return jsonb_build_object('ok', false, 'reason', 'root_sell_uses_supply_ledger');
  elsif v_kind <> 'TARGET_BUY' and not v_source_is_root and not exists (
    select 1 from public.custody_fresh_tail_wallets w
    where w.epoch_id = p_epoch_id and w.token_mint = v_token_mint
      and w.wallet = v_source and p_slot >= w.discovery_slot
  ) then
    return jsonb_build_object('ok', false, 'reason', 'source_not_in_fresh_scope');
  end if;

  if v_kind = 'TARGET_BUY' and not exists (
    select 1 from public.custody_fresh_tail_supply_events s
    where s.epoch_id = p_epoch_id and s.token_mint = v_token_mint
      and s.tx_sig = v_sig and s.slot = p_slot and s.target_wallet = v_source
      and s.side = 'buy' and s.amount_raw = p_amount_raw
      and not s.quarantined and s.classification_reliable
      and s.pump_fun_verified
      and public.is_custody_fresh_tail_parser_reviewed(
        s.parser_domain, s.parser_abi_fingerprint
      )
  ) then
    return jsonb_build_object('ok', false, 'reason', 'fresh_supply_buy_missing');
  end if;
  if v_kind = 'TRANSFER' and v_source_is_root and exists (
    select 1 from public.custody_fresh_tail_supply_events s
    where s.epoch_id = p_epoch_id and s.token_mint = v_token_mint
      and s.tx_sig = v_sig and s.slot = p_slot and s.target_wallet = v_source
      and s.side = 'buy'
  ) and not exists (
    select 1 from public.custody_fresh_tail_custody_events b
    where b.epoch_id = p_epoch_id and b.token_mint = v_token_mint
      and b.tx_sig = v_sig and b.slot = p_slot and b.source_wallet = v_source
      and b.event_kind = 'TARGET_BUY' and b.source_post_raw = p_source_pre_raw
      and not b.quarantined and b.classification_reliable
  ) then
    return jsonb_build_object('ok', false, 'reason', 'same_tx_buy_cohort_missing');
  end if;

  v_terminal := v_kind in ('UNRESOLVED_OUTFLOW', 'TERMINAL_OUTFLOW')
    or p_watchable is not true
    or exists (
      select 1 from jsonb_array_elements(v_recipients) recipient
      where (recipient->>'watchable')::boolean is not true
    );
  v_fingerprint := encode(extensions.digest(jsonb_build_object(
    'eventKey', v_event_key, 'txSig', v_sig, 'slot', p_slot,
    'blockTime', p_block_time, 'sourceWallet', v_source,
    'tokenMint', v_token_mint, 'eventKind', v_kind,
    'amountRaw', p_amount_raw::text, 'sourcePreRaw', p_source_pre_raw::text,
    'sourcePostRaw', p_source_post_raw::text, 'decimals', p_decimals,
    'recipients', v_recipients, 'classification', v_classification,
    'classificationReliable', p_classification_reliable,
    'watchable', p_watchable, 'parserDomain', v_parser_domain,
    'parserAbiFingerprint', v_abi
  )::text, 'sha256'), 'hex');

  select * into v_existing
  from public.custody_fresh_tail_custody_events
  where epoch_id = p_epoch_id and event_key = v_event_key
  for update;
  if found then
    if v_existing.payload_fingerprint <> v_fingerprint
       or (v_existing.finalized_head_slot = p_finalized_head_slot
         and v_existing.finalized_head_blockhash <> v_head_hash) then
      update public.custody_fresh_tail_custody_events set
        quarantined = true, terminal_poison = true,
        conflict_count = conflict_count + 1,
        first_conflict_at = coalesce(first_conflict_at, now())
      where id = v_existing.id;
      update public.custody_fresh_tail_mints set
        poisoned = true, poison_reason = 'custody_payload_conflict', updated_at = now()
      where epoch_id = p_epoch_id and token_mint = v_token_mint;
      if v_existing.finalized_head_slot = p_finalized_head_slot
         and v_existing.finalized_head_blockhash <> v_head_hash then
        update public.custody_fresh_tail_epochs set
          status = 'invalidated', invalid_reason = 'finalized_head_blockhash_conflict',
          updated_at = now()
        where id = p_epoch_id;
      end if;
      -- Quarantine is not enough after a live entry is armed: atomically fan
      -- the conflict into the durable exit outbox before acknowledging it.
      insert into public.custody_fresh_tail_exit_intents (
        user_id, epoch_id, request_id, token_mint, entry_claim_id,
        position_id, source_domain, custody_event_id, trigger_kind
      )
      select c.user_id, p_epoch_id, c.fresh_tail_request_id, v_token_mint,
        c.id, c.planned_position_id, 'custody', v_existing.id, 'terminal_outflow'
      from public.entry_signal_claims c
      where c.user_id = p_user_id
        and c.fresh_tail_epoch_id = p_epoch_id
        and c.token_mint = v_token_mint
        and c.fresh_tail_monitoring_armed_at is not null
      on conflict do nothing;
      return jsonb_build_object(
        'ok', false, 'reason', 'payload_conflict', 'epochId', p_epoch_id,
        'eventId', v_existing.id, 'eventKey', v_event_key,
        'duplicate', true, 'payloadMismatch', true, 'quarantined', true,
        'durableConflict', true, 'terminalPoison', true
      );
    end if;
    return jsonb_build_object(
      'ok', not v_existing.quarantined, 'reason', case
        when v_existing.quarantined then 'quarantined' else 'duplicate'
      end,
      'epochId', p_epoch_id, 'eventId', v_existing.id,
      'eventKey', v_event_key, 'duplicate', true,
      'payloadMismatch', false, 'quarantined', v_existing.quarantined,
      'amountRaw', v_existing.amount_raw::text, 'recipients', v_existing.recipients
    );
  end if;

  insert into public.custody_fresh_tail_custody_events (
    epoch_id, user_id, event_key, payload_fingerprint, tx_sig, slot,
    block_time, source_wallet, token_mint, event_kind, amount_raw,
    source_pre_raw, source_post_raw, decimals, recipients, classification,
    classification_reliable, watchable, parser_domain, parser_abi_fingerprint,
    finalized_head_slot, finalized_head_blockhash,
    classification_pending, terminal_poison
  ) values (
    p_epoch_id, p_user_id, v_event_key, v_fingerprint, v_sig, p_slot,
    p_block_time, v_source, v_token_mint, v_kind, p_amount_raw,
    p_source_pre_raw, p_source_post_raw, p_decimals, v_recipients,
    v_classification, true, p_watchable, v_parser_domain, v_abi,
    p_finalized_head_slot, v_head_hash, false, v_terminal
  ) returning id into v_event_id;

  update public.custody_fresh_tail_requests set
    status = case when requested_head_slot < p_slot
      then 'invalidated' else 'pending' end,
    invalid_reason = case when requested_head_slot < p_slot
      then 'finalized_event_after_requested_head'
      else 'new_finalized_event_requires_resettle' end,
    settled_revision = null, settled_lease_generation = null,
    settled_at = null, updated_at = now()
  where epoch_id = p_epoch_id and token_mint = v_token_mint
    and status in ('pending', 'settled')
    and (requested_head_slot < p_slot or status = 'settled');

  if v_kind = 'TRANSFER' then
    insert into public.custody_fresh_tail_edges (
      epoch_id, user_id, token_mint, custody_event_id, source_wallet,
      destination_wallet, discovery_slot, amount_raw, classification,
      classification_reliable, watchable
    )
    select p_epoch_id, p_user_id, v_token_mint, v_event_id, v_source,
      recipient->>'wallet', p_slot, (recipient->>'amountRaw')::numeric,
      recipient->>'classification',
      (recipient->>'classificationReliable')::boolean,
      (recipient->>'watchable')::boolean
    from jsonb_array_elements(v_recipients) recipient;
  end if;

  if v_kind = 'SELL' or v_terminal then
    v_trigger_kind := case
      when v_kind = 'SELL' then 'mirror_custody_sell'
      else 'terminal_outflow'
    end;
    insert into public.custody_fresh_tail_exit_intents (
      user_id, epoch_id, request_id, token_mint, entry_claim_id,
      position_id, source_domain, custody_event_id, trigger_kind
    )
    select c.user_id, p_epoch_id, c.fresh_tail_request_id, v_token_mint,
      c.id, c.planned_position_id, 'custody', v_event_id, v_trigger_kind
    from public.entry_signal_claims c
    where c.user_id = p_user_id
      and c.fresh_tail_epoch_id = p_epoch_id
      and c.token_mint = v_token_mint
      and c.fresh_tail_monitoring_armed_at is not null
      and c.source_slot is not null and p_slot >= c.source_slot
    on conflict do nothing;
  end if;

  return jsonb_build_object(
    'ok', true, 'reason', case when v_terminal then 'recorded_terminal' else 'recorded' end,
    'epochId', p_epoch_id, 'eventId', v_event_id, 'eventKey', v_event_key,
    'duplicate', false, 'payloadMismatch', false, 'quarantined', false,
    'terminalPoison', v_terminal, 'amountRaw', p_amount_raw::text,
    'recipients', v_recipients
  );
end;
$$;

create or replace function public.sync_custody_fresh_tail_scope(
  p_user_id uuid,
  p_epoch_id uuid,
  p_token_mint text,
  p_expected_scope_revision bigint,
  p_lease_token uuid,
  p_lease_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_mint public.custody_fresh_tail_mints%rowtype;
  v_wallet public.custody_fresh_tail_wallets%rowtype;
  v_edge record;
  v_token_mint text := btrim(coalesce(p_token_mint, ''));
  v_revision bigint;
  v_added text[] := array[]::text[];
  v_backscan_ids uuid[] := array[]::uuid[];
  v_range_id uuid;
begin
  v_epoch := public.assert_custody_fresh_tail_lease(
    p_user_id, p_epoch_id, p_lease_token, p_lease_generation
  );
  if v_token_mint = '' or p_expected_scope_revision is null
     or p_expected_scope_revision < 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_scope_request');
  end if;
  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(v_token_mint));
  select * into v_mint
  from public.custody_fresh_tail_mints
  where epoch_id = p_epoch_id and user_id = p_user_id and token_mint = v_token_mint
  for update;
  if not found or v_mint.status <> 'active' or v_mint.poisoned then
    return jsonb_build_object('ok', false, 'reason', 'mint_not_active');
  end if;
  if v_mint.scope_revision <> p_expected_scope_revision then
    return jsonb_build_object(
      'ok', false, 'reason', 'scope_revision_conflict',
      'scopeRevision', v_mint.scope_revision
    );
  end if;

  if exists (
    select 1
    from public.custody_journeys j
    where j.user_id = p_user_id and j.token_mint = v_token_mint
      and j.status = 'active'
      and j.first_event_key <> v_mint.enrollment_event_key
  ) then
    update public.custody_fresh_tail_mints set
      poisoned = true, poison_reason = 'preexisting_legacy_journey', updated_at = now()
    where epoch_id = p_epoch_id and token_mint = v_token_mint;
    return jsonb_build_object('ok', false, 'reason', 'preexisting_legacy_journey');
  end if;

  if exists (
    select 1 from public.custody_fresh_tail_custody_events e
    where e.epoch_id = p_epoch_id and e.token_mint = v_token_mint
      and (e.quarantined or e.classification_pending or e.terminal_poison
        or not e.classification_reliable
        or not public.is_custody_fresh_tail_parser_reviewed(
          e.parser_domain, e.parser_abi_fingerprint
        ))
  ) or exists (
    select 1 from public.custody_fresh_tail_edges e
    where e.epoch_id = p_epoch_id and e.token_mint = v_token_mint
      and (not e.classification_reliable or not e.watchable)
  ) then
    update public.custody_fresh_tail_mints set
      poisoned = true, poison_reason = 'fresh_custody_poison', updated_at = now()
    where epoch_id = p_epoch_id and token_mint = v_token_mint;
    return jsonb_build_object(
      'ok', false, 'reason', 'fresh_custody_poison',
      'epochId', p_epoch_id, 'tokenMint', v_token_mint,
      'scopeRevision', v_mint.scope_revision, 'poisoned', true
    );
  end if;

  if not exists (
    select 1 from public.custody_fresh_tail_edges e
    where e.epoch_id = p_epoch_id and e.token_mint = v_token_mint
      and e.applied_revision is null
  ) then
    return jsonb_build_object(
      'ok', true, 'reason', 'scope_unchanged', 'epochId', p_epoch_id,
      'tokenMint', v_token_mint, 'scopeRevision', v_mint.scope_revision,
      'addedWallets', to_jsonb(v_added), 'backscanRangeIds', to_jsonb(v_backscan_ids),
      'poisoned', false
    );
  end if;

  v_revision := v_mint.scope_revision + 1;
  for v_edge in
    select e.*, ce.event_key
    from public.custody_fresh_tail_edges e
    join public.custody_fresh_tail_custody_events ce on ce.id = e.custody_event_id
    where e.epoch_id = p_epoch_id and e.token_mint = v_token_mint
      and e.applied_revision is null
    order by e.discovery_slot, e.custody_event_id, e.destination_wallet
  loop
    -- Transfers back into a root are evidence, but roots already have the
    -- common exclusive cursor and never acquire a mint-scoped cursor.
    if exists (
      select 1 from public.custody_fresh_tail_roots r
      where r.epoch_id = p_epoch_id and r.wallet = v_edge.destination_wallet
    ) then
      continue;
    end if;

    select * into v_wallet
    from public.custody_fresh_tail_wallets w
    where w.epoch_id = p_epoch_id and w.token_mint = v_token_mint
      and w.wallet = v_edge.destination_wallet
    for update;
    if not found then
      insert into public.custody_fresh_tail_wallets (
        epoch_id, user_id, token_mint, wallet, parent_wallet,
        discovery_event_id, discovery_event_key, discovery_slot, floor_slot,
        boundary_kind, watch_status, classification,
        classification_reliable, added_revision
      ) values (
        p_epoch_id, p_user_id, v_token_mint, v_edge.destination_wallet,
        v_edge.source_wallet, v_edge.custody_event_id, v_edge.event_key,
        v_edge.discovery_slot, v_edge.discovery_slot, 'inclusive_slot',
        'active', v_edge.classification, true, v_revision
      );
      insert into public.custody_fresh_tail_cursors (
        epoch_id, user_id, scope_mint, wallet, cursor_role, floor_slot,
        initial_boundary_kind, current_boundary_kind, coverage_revision,
        backlog_detected, last_error, last_lease_generation
      ) values (
        p_epoch_id, p_user_id, v_token_mint, v_edge.destination_wallet,
        'descendant', v_edge.discovery_slot, 'inclusive_slot', 'inclusive_slot',
        v_revision, true, 'new_descendant_requires_scan', p_lease_generation
      );
      v_added := array_append(v_added, v_edge.destination_wallet);
    elsif v_edge.discovery_slot < v_wallet.discovery_slot then
      -- Preserve the advanced main cursor.  The lower inclusive floor gets a
      -- separate fenced lane, and the wallet's provenance records the true
      -- earliest edge for all future decisions.
      update public.custody_fresh_tail_wallets set
        parent_wallet = v_edge.source_wallet,
        discovery_event_id = v_edge.custody_event_id,
        discovery_event_key = v_edge.event_key,
        discovery_slot = v_edge.discovery_slot,
        floor_slot = v_edge.discovery_slot,
        classification = v_edge.classification,
        added_revision = v_revision,
        updated_at = now()
      where epoch_id = p_epoch_id and token_mint = v_token_mint
        and wallet = v_edge.destination_wallet;
      insert into public.custody_fresh_tail_backscan_ranges (
        epoch_id, user_id, token_mint, wallet, source_edge_event_id,
        floor_slot, coverage_revision, backlog_detected, last_error,
        last_lease_generation
      ) values (
        p_epoch_id, p_user_id, v_token_mint, v_edge.destination_wallet,
        v_edge.custody_event_id, v_edge.discovery_slot, v_revision, true,
        'retrograde_discovery_requires_backscan', p_lease_generation
      ) on conflict (epoch_id, token_mint, wallet, source_edge_event_id)
        do update set coverage_revision = excluded.coverage_revision,
          backlog_detected = true,
          last_error = excluded.last_error,
          updated_at = now()
      returning id into v_range_id;
      v_backscan_ids := array_append(v_backscan_ids, v_range_id);
    end if;
  end loop;

  update public.custody_fresh_tail_edges set
    applied_revision = v_revision, scope_applied_at = now()
  where epoch_id = p_epoch_id and token_mint = v_token_mint
    and applied_revision is null;
  update public.custody_fresh_tail_mints set
    scope_revision = v_revision, updated_at = now()
  where epoch_id = p_epoch_id and token_mint = v_token_mint;
  update public.custody_fresh_tail_epochs set
    scope_revision = scope_revision + 1, updated_at = now()
  where id = p_epoch_id;
  update public.custody_fresh_tail_cursors set
    backlog_detected = true,
    last_error = 'scope_revision_changed',
    updated_at = now()
  where epoch_id = p_epoch_id and scope_mint = v_token_mint
    and coverage_revision < v_revision;
  update public.custody_fresh_tail_backscan_ranges set
    backlog_detected = true,
    last_error = 'scope_revision_changed',
    coverage_revision = v_revision,
    completed_at = null,
    updated_at = now()
  where epoch_id = p_epoch_id and token_mint = v_token_mint
    and coverage_revision < v_revision;
  update public.custody_fresh_tail_requests set
    status = case when expires_at <= clock_timestamp() then 'expired' else 'pending' end,
    scope_revision = v_revision,
    settled_revision = null,
    settled_lease_generation = null,
    settled_at = null,
    invalid_reason = case when expires_at <= clock_timestamp()
      then 'coverage_expired' else null end,
    updated_at = now()
  where epoch_id = p_epoch_id and token_mint = v_token_mint
    and status in ('pending', 'settled');

  return jsonb_build_object(
    'ok', true, 'reason', 'scope_advanced', 'epochId', p_epoch_id,
    'tokenMint', v_token_mint, 'scopeRevision', v_revision,
    'addedWallets', to_jsonb(v_added), 'backscanRangeIds', to_jsonb(v_backscan_ids),
    'poisoned', false
  );
end;
$$;

create or replace function public.retire_custody_fresh_tail_mint(
  p_user_id uuid,
  p_epoch_id uuid,
  p_token_mint text,
  p_expected_scope_revision bigint,
  p_reason text,
  p_lease_token uuid,
  p_lease_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_mint public.custody_fresh_tail_mints%rowtype;
  v_token_mint text := btrim(coalesce(p_token_mint, ''));
  v_reason text := lower(btrim(coalesce(p_reason, '')));
  v_last_supply_at timestamptz;
  v_latest_head_at timestamptz;
begin
  v_epoch := public.assert_custody_fresh_tail_lease(
    p_user_id, p_epoch_id, p_lease_token, p_lease_generation
  );
  if v_token_mint = '' or p_expected_scope_revision is null
     or p_expected_scope_revision < 0
     or v_reason not in (
       'dormant_below_threshold', 'resource_cap', 'unsupported_after_enrollment'
     ) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_retirement');
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(v_token_mint));
  select * into v_mint
  from public.custody_fresh_tail_mints
  where epoch_id = p_epoch_id and user_id = p_user_id
    and token_mint = v_token_mint
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'mint_not_found');
  end if;
  if v_mint.status = 'retired' then
    return jsonb_build_object(
      'ok', v_mint.retire_reason = v_reason,
      'reason', case when v_mint.retire_reason = v_reason
        then 'already_retired' else 'retirement_reason_conflict' end,
      'epochId', p_epoch_id, 'tokenMint', v_token_mint,
      'scopeRevision', v_mint.scope_revision,
      'retireReason', v_mint.retire_reason, 'retiredAt', v_mint.retired_at
    );
  end if;
  if v_mint.scope_revision <> p_expected_scope_revision then
    return jsonb_build_object(
      'ok', false, 'reason', 'scope_revision_conflict',
      'scopeRevision', v_mint.scope_revision
    );
  end if;
  if exists (
    select 1 from public.custody_fresh_tail_requests q
    where q.epoch_id = p_epoch_id and q.token_mint = v_token_mint
      and q.status in ('pending', 'settled')
      and q.expires_at > clock_timestamp()
  ) then
    return jsonb_build_object('ok', false, 'reason', 'fresh_request_still_live');
  end if;
  if exists (
    select 1 from public.entry_signal_claims c
    where c.user_id = p_user_id and c.fresh_tail_epoch_id = p_epoch_id
      and c.token_mint = v_token_mint
      and c.fresh_tail_monitoring_armed_at is not null
      and (
        c.status in ('claimed', 'submitted', 'landed', 'uncertain')
        or (
          c.status = 'persisted'
          and not exists (
            select 1 from public.positions p
            where p.id = c.planned_position_id and p.user_id = c.user_id
              and p.token_mint = c.token_mint and p.closed_at is not null
          )
        )
      )
  ) or exists (
    select 1
    from public.positions p
    join public.entry_signal_claims c on c.planned_position_id = p.id
    where p.user_id = p_user_id and p.token_mint = v_token_mint
      and p.closed_at is null and c.fresh_tail_epoch_id = p_epoch_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'fresh_position_still_armed');
  end if;
  if exists (
    select 1 from public.custody_fresh_tail_exit_intents i
    where i.user_id = p_user_id and i.epoch_id = p_epoch_id
      and i.token_mint = v_token_mint
      and i.status not in ('resolved', 'dismissed')
  ) then
    return jsonb_build_object('ok', false, 'reason', 'fresh_exit_still_unresolved');
  end if;
  if v_reason = 'dormant_below_threshold' then
    -- V1 owns only the first finalized hour of a launch campaign. Retirement
    -- is permanent, so a later revival is deliberately outside this lane.
    select max(h.block_time) into v_latest_head_at
    from public.custody_fresh_tail_finalized_heads h
    where h.epoch_id = p_epoch_id and h.user_id = p_user_id;
    select coalesce(max(e.block_time), v_mint.enrollment_block_time)
    into v_last_supply_at
    from public.custody_fresh_tail_supply_events e
    where e.epoch_id = p_epoch_id and e.token_mint = v_token_mint;
    if v_latest_head_at is null then
      return jsonb_build_object('ok', false, 'reason', 'finalized_head_missing');
    end if;
    if v_last_supply_at is null
       or v_last_supply_at > v_latest_head_at - interval '1 hour' then
      return jsonb_build_object('ok', false, 'reason', 'mint_not_dormant');
    end if;
  end if;

  update public.custody_fresh_tail_requests set
    status = 'invalidated', invalid_reason = 'mint_retired',
    settled_revision = null, settled_lease_generation = null,
    settled_at = null, updated_at = now()
  where epoch_id = p_epoch_id and token_mint = v_token_mint
    and status in ('pending', 'settled');
  update public.custody_fresh_tail_mints set
    status = 'retired', retire_reason = v_reason,
    retired_at = clock_timestamp(), updated_at = now()
  where epoch_id = p_epoch_id and token_mint = v_token_mint
  returning * into v_mint;

  return jsonb_build_object(
    'ok', true, 'reason', 'retired', 'epochId', p_epoch_id,
    'tokenMint', v_token_mint, 'scopeRevision', v_mint.scope_revision,
    'retireReason', v_mint.retire_reason, 'retiredAt', v_mint.retired_at
  );
end;
$$;

create or replace function public.request_custody_fresh_tail_coverage(
  p_user_id uuid,
  p_epoch_id uuid,
  p_token_mint text,
  p_window_started_at timestamptz,
  p_trigger_event_key text,
  p_trigger_tx_sig text,
  p_trigger_slot bigint,
  p_target_wallet text,
  p_trigger_block_time timestamptz,
  p_finalized_head_slot bigint,
  p_finalized_head_blockhash text,
  p_finalized_head_block_time timestamptz,
  p_head_snapshot_parser_abi_fingerprint text,
  p_head_curve_state_fingerprint text,
  p_head_curve_observed_slot bigint,
  p_head_curve_complete boolean,
  p_head_virtual_token_reserves_raw numeric,
  p_head_virtual_sol_reserves_lamports numeric,
  p_head_real_token_reserves_raw numeric,
  p_head_real_sol_reserves_lamports numeric,
  p_head_curve_total_supply_raw numeric,
  p_head_mint_layout_fingerprint text,
  p_head_token_program text,
  p_head_mint_supply_raw numeric,
  p_head_mint_decimals integer,
  p_lease_token uuid,
  p_lease_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_mint public.custody_fresh_tail_mints%rowtype;
  v_config public.bot_config%rowtype;
  v_trigger public.custody_fresh_tail_supply_events%rowtype;
  v_existing public.custody_fresh_tail_requests%rowtype;
  v_request_id uuid;
  v_token_mint text := btrim(coalesce(p_token_mint, ''));
  v_event_key text := btrim(coalesce(p_trigger_event_key, ''));
  v_sig text := btrim(coalesce(p_trigger_tx_sig, ''));
  v_target text := btrim(coalesce(p_target_wallet, ''));
  v_head_hash text := btrim(coalesce(p_finalized_head_blockhash, ''));
  v_head_snapshot_abi text := lower(btrim(coalesce(
    p_head_snapshot_parser_abi_fingerprint, ''
  )));
  v_head_curve_fp text := lower(btrim(coalesce(p_head_curve_state_fingerprint, '')));
  v_head_layout text := lower(btrim(coalesce(p_head_mint_layout_fingerprint, '')));
  v_head_program text := btrim(coalesce(p_head_token_program, ''));
  v_net_raw numeric(78, 0);
  v_threshold_pct numeric;
begin
  v_epoch := public.assert_custody_fresh_tail_lease(
    p_user_id, p_epoch_id, p_lease_token, p_lease_generation
  );
  if v_token_mint = '' or v_event_key = '' or v_sig = '' or v_target = ''
     or p_window_started_at is null or p_trigger_block_time is null
     or p_window_started_at > p_trigger_block_time
     or p_trigger_slot is null or p_trigger_slot <= v_epoch.activation_slot
     or p_finalized_head_slot is null or p_finalized_head_slot < p_trigger_slot
     or v_head_hash = '' or p_finalized_head_block_time is null
     or p_finalized_head_block_time < p_trigger_block_time
     or p_finalized_head_block_time > now()
     or v_head_snapshot_abi <>
       '2f5de97b6527d4ec94082069d65abd2bf30523e45bf562aabe1e770e5eb4ad1d'
     or v_head_curve_fp !~ '^[0-9a-f]{64}$'
     or p_head_curve_observed_slot is distinct from p_finalized_head_slot
     or p_head_curve_complete is distinct from false
     or p_head_virtual_token_reserves_raw is null
     or p_head_virtual_token_reserves_raw <= 0
     or p_head_virtual_sol_reserves_lamports is null
     or p_head_virtual_sol_reserves_lamports <= 0
     or p_head_real_token_reserves_raw is null
     or p_head_real_token_reserves_raw <= 0
     or p_head_real_sol_reserves_lamports is null
     or p_head_real_sol_reserves_lamports < 0
     or p_head_curve_total_supply_raw is null
     or p_head_curve_total_supply_raw <= 0
     or v_head_layout !~ '^[0-9a-f]{64}$'
     or v_head_program = ''
     or p_head_mint_supply_raw is null or p_head_mint_supply_raw <= 0
     or p_head_mint_decimals is null
     or p_head_mint_decimals not between 0 and 18 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_coverage_request');
  end if;
  if not exists (
    select 1 from public.custody_fresh_tail_finalized_heads h
    where h.epoch_id = p_epoch_id and h.user_id = p_user_id
      and h.slot = p_finalized_head_slot and h.blockhash = v_head_hash
      and h.block_time = p_finalized_head_block_time
  ) then
    return jsonb_build_object('ok', false, 'reason', 'finalized_head_not_attested');
  end if;
  if exists (
    select 1 from public.custody_fresh_tail_finalized_heads h
    where h.epoch_id = p_epoch_id and h.slot > p_finalized_head_slot
  ) then
    return jsonb_build_object('ok', false, 'reason', 'finalized_head_not_latest');
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(v_token_mint));
  select * into v_mint
  from public.custody_fresh_tail_mints
  where epoch_id = p_epoch_id and user_id = p_user_id and token_mint = v_token_mint
  for update;
  if not found or v_mint.status <> 'active' or v_mint.poisoned then
    return jsonb_build_object('ok', false, 'reason', 'mint_not_active');
  end if;
  if p_head_curve_total_supply_raw is distinct from v_mint.total_supply_raw
     or v_head_layout <> v_mint.mint_layout_fingerprint
     or v_head_program <> v_mint.token_program
     or p_head_mint_supply_raw is distinct from v_mint.total_supply_raw
     or p_head_mint_decimals is distinct from v_mint.decimals then
    update public.custody_fresh_tail_mints set
      poisoned = true, poison_reason = 'head_curve_or_mint_state_mismatch',
      updated_at = now()
    where epoch_id = p_epoch_id and token_mint = v_token_mint;
    return jsonb_build_object(
      'ok', false, 'reason', 'head_curve_or_mint_state_mismatch'
    );
  end if;
  select * into v_config
  from public.bot_config where user_id = p_user_id for update;
  if not found or v_config.supply_accumulation_mode_enabled is not true
     or v_config.custody_journey_enabled is not true
     or v_config.direct_target_sell_exit_mode = 'proportional' then
    return jsonb_build_object('ok', false, 'reason', 'strategy_not_enabled');
  end if;
  if v_config.supply_accumulation_window_seconds is null
     or p_window_started_at <> p_trigger_block_time - make_interval(
       secs => v_config.supply_accumulation_window_seconds
     ) then
    return jsonb_build_object('ok', false, 'reason', 'window_identity_mismatch');
  end if;

  update public.custody_fresh_tail_requests q set
    status = 'expired', invalid_reason = 'coverage_expired', updated_at = now()
  where q.epoch_id = p_epoch_id and q.token_mint = v_token_mint
    and q.status in ('pending', 'settled')
    and q.expires_at <= clock_timestamp()
    and not exists (
      select 1 from public.entry_signal_claims c
      where c.fresh_tail_request_id = q.id
    );
  if exists (
    select 1 from public.entry_signal_claims c
    where c.user_id = p_user_id and c.fresh_tail_epoch_id = p_epoch_id
      and c.token_mint = v_token_mint
  ) then
    return jsonb_build_object('ok', false, 'reason', 'entry_claim_already_bound');
  end if;

  select * into v_existing
  from public.custody_fresh_tail_requests
  where epoch_id = p_epoch_id and trigger_event_key = v_event_key;
  if found then
    return jsonb_build_object(
      'ok', v_existing.status in ('pending', 'settled'),
      'reason', 'duplicate_request', 'epochId', p_epoch_id,
      'requestId', v_existing.id, 'tokenMint', v_existing.token_mint,
      'triggerEventKey', v_existing.trigger_event_key,
      'triggerSlot', v_existing.trigger_slot,
      'triggerBlockTime', v_existing.trigger_block_time,
      'expiresAt', v_existing.expires_at,
      'requestedHeadSlot', v_existing.requested_head_slot,
      'requestedHeadBlockhash', v_existing.requested_head_blockhash,
      'requestedHeadBlockTime', v_existing.requested_head_block_time,
      'headSnapshotParserAbiFingerprint',
        v_existing.head_snapshot_parser_abi_fingerprint,
      'headCurveStateFingerprint', v_existing.head_curve_state_fingerprint,
      'headCurveObservedSlot', v_existing.head_curve_observed_slot,
      'headCurveComplete', v_existing.head_curve_complete,
      'headVirtualTokenReservesRaw', v_existing.head_virtual_token_reserves_raw::text,
      'headVirtualSolReservesLamports', v_existing.head_virtual_sol_reserves_lamports::text,
      'headRealTokenReservesRaw', v_existing.head_real_token_reserves_raw::text,
      'headRealSolReservesLamports', v_existing.head_real_sol_reserves_lamports::text,
      'headCurveTotalSupplyRaw', v_existing.head_curve_total_supply_raw::text,
      'headMintLayoutFingerprint', v_existing.head_mint_layout_fingerprint,
      'headTokenProgram', v_existing.head_token_program,
      'headMintSupplyRaw', v_existing.head_mint_supply_raw::text,
      'headMintDecimals', v_existing.head_mint_decimals,
      'scopeRevision', v_existing.scope_revision,
      'settledRevision', v_existing.settled_revision,
      'settledLeaseGeneration', v_existing.settled_lease_generation
    );
  end if;
  if exists (
    select 1 from public.custody_fresh_tail_requests
    where epoch_id = p_epoch_id and token_mint = v_token_mint
      and status in ('pending', 'settled')
  ) then
    return jsonb_build_object('ok', false, 'reason', 'live_request_exists');
  end if;

  select * into v_trigger
  from public.custody_fresh_tail_supply_events
  where epoch_id = p_epoch_id and event_key = v_event_key
    and token_mint = v_token_mint
  for update;
  if not found
     or v_trigger.tx_sig <> v_sig or v_trigger.slot <> p_trigger_slot
     or v_trigger.block_time <> p_trigger_block_time
     or v_trigger.target_wallet <> v_target or v_trigger.side <> 'buy'
     or v_trigger.quarantined
     or not v_trigger.market_data_reliable
     or not v_trigger.pump_fun_verified
     or not v_trigger.classification_reliable
     or not public.is_custody_fresh_tail_parser_reviewed(
       v_trigger.parser_domain, v_trigger.parser_abi_fingerprint
     )
     or v_trigger.market_cap_usd is null
     or v_trigger.market_cap_usd < v_config.supply_accumulation_min_market_cap_usd
     or v_trigger.market_cap_usd >= v_config.supply_accumulation_max_market_cap_usd then
    return jsonb_build_object('ok', false, 'reason', 'trigger_not_eligible');
  end if;
  if p_trigger_block_time + interval '55 seconds' <= clock_timestamp() then
    return jsonb_build_object('ok', false, 'reason', 'trigger_expired');
  end if;
  if exists (
    select 1 from public.custody_fresh_tail_supply_events e
    where e.epoch_id = p_epoch_id and e.token_mint = v_token_mint
      and e.side = 'buy' and e.slot = p_trigger_slot
      and e.event_key <> v_event_key
  ) then
    return jsonb_build_object('ok', false, 'reason', 'same_slot_trigger_ambiguous');
  end if;
  if exists (
    select 1 from public.custody_fresh_tail_supply_events e
    where e.epoch_id = p_epoch_id and e.token_mint = v_token_mint
      and e.slot <= p_finalized_head_slot
      and (e.quarantined or not e.classification_reliable
        or not e.pump_fun_verified or e.side = 'sell'
        or not public.is_custody_fresh_tail_parser_reviewed(
          e.parser_domain, e.parser_abi_fingerprint
        ))
  ) or exists (
    select 1 from public.custody_fresh_tail_custody_events e
    where e.epoch_id = p_epoch_id and e.token_mint = v_token_mint
      and e.slot <= p_finalized_head_slot
      and (e.quarantined or e.classification_pending or e.terminal_poison
        or e.event_kind in ('SELL', 'UNRESOLVED_OUTFLOW', 'TERMINAL_OUTFLOW')
        or not public.is_custody_fresh_tail_parser_reviewed(
          e.parser_domain, e.parser_abi_fingerprint
        ))
  ) then
    return jsonb_build_object('ok', false, 'reason', 'fresh_sell_or_poison_seen');
  end if;
  if not exists (
    select 1
    from public.custody_fresh_tail_supply_events s
    join public.custody_fresh_tail_custody_events c
      on c.epoch_id = s.epoch_id and c.token_mint = s.token_mint
     and c.tx_sig = s.tx_sig and c.slot = s.slot
     and c.source_wallet = s.target_wallet and c.amount_raw = s.amount_raw
    where s.epoch_id = p_epoch_id and s.token_mint = v_token_mint
      and s.event_key = v_mint.enrollment_event_key
      and s.tx_sig = v_mint.enrollment_tx_sig
      and s.slot = v_mint.enrollment_slot
      and s.block_time = v_mint.enrollment_block_time
      and s.target_wallet = v_mint.enrollment_target_wallet
      and s.side = 'buy' and c.event_kind = 'TARGET_BUY'
      and not s.quarantined and not c.quarantined
      and s.classification_reliable and c.classification_reliable
      and s.pump_fun_verified
      and public.is_custody_fresh_tail_parser_reviewed(
        s.parser_domain, s.parser_abi_fingerprint
      )
      and public.is_custody_fresh_tail_parser_reviewed(
        c.parser_domain, c.parser_abi_fingerprint
      )
  ) then
    return jsonb_build_object('ok', false, 'reason', 'enrollment_evidence_missing');
  end if;
  if exists (
    select 1 from public.custody_fresh_tail_edges e
    where e.epoch_id = p_epoch_id and e.token_mint = v_token_mint
      and e.applied_revision is null
  ) then
    return jsonb_build_object('ok', false, 'reason', 'scope_not_fixed_point');
  end if;

  select greatest(0, coalesce(sum(case
    when e.side = 'buy' then e.amount_raw else -e.amount_raw end), 0))
  into v_net_raw
  from public.custody_fresh_tail_supply_events e
  where e.epoch_id = p_epoch_id and e.token_mint = v_token_mint
    and e.block_time >= p_window_started_at
    and e.block_time <= p_trigger_block_time
    and e.slot > v_epoch.activation_slot and e.slot <= p_trigger_slot
    and e.target_wallet = any(v_epoch.root_wallets)
    and not e.quarantined and e.classification_reliable and e.pump_fun_verified
    and public.is_custody_fresh_tail_parser_reviewed(
      e.parser_domain, e.parser_abi_fingerprint
    )
    and e.total_supply_raw = v_mint.total_supply_raw
    and e.decimals = v_mint.decimals;
  v_threshold_pct := (v_net_raw * 100) / v_mint.total_supply_raw;
  if v_threshold_pct < v_config.supply_accumulation_threshold_pct then
    return jsonb_build_object(
      'ok', false, 'reason', 'threshold_not_reached',
      'netAcquiredRaw', v_net_raw::text, 'netSupplyPct', v_threshold_pct
    );
  end if;

  insert into public.custody_fresh_tail_requests (
    epoch_id, user_id, token_mint, window_started_at,
    trigger_supply_event_id, trigger_event_key, trigger_tx_sig, trigger_slot,
    trigger_target_wallet, trigger_block_time, expires_at,
    requested_head_slot, requested_head_blockhash, requested_head_block_time,
    head_snapshot_parser_abi_fingerprint,
    head_curve_state_fingerprint, head_curve_observed_slot,
    head_curve_complete, head_virtual_token_reserves_raw,
    head_virtual_sol_reserves_lamports, head_real_token_reserves_raw,
    head_real_sol_reserves_lamports, head_curve_total_supply_raw,
    head_mint_layout_fingerprint, head_token_program,
    head_mint_supply_raw, head_mint_decimals,
    scope_revision
  ) values (
    p_epoch_id, p_user_id, v_token_mint, p_window_started_at,
    v_trigger.id, v_event_key, v_sig, p_trigger_slot, v_target,
    p_trigger_block_time, p_trigger_block_time + interval '55 seconds',
    p_finalized_head_slot, v_head_hash, p_finalized_head_block_time,
    v_head_snapshot_abi,
    v_head_curve_fp, p_head_curve_observed_slot, false,
    p_head_virtual_token_reserves_raw, p_head_virtual_sol_reserves_lamports,
    p_head_real_token_reserves_raw, p_head_real_sol_reserves_lamports,
    p_head_curve_total_supply_raw, v_head_layout, v_head_program,
    p_head_mint_supply_raw, p_head_mint_decimals,
    v_mint.scope_revision
  ) returning id into v_request_id;

  return jsonb_build_object(
    'ok', true, 'reason', 'coverage_requested', 'epochId', p_epoch_id,
    'requestId', v_request_id, 'tokenMint', v_token_mint,
    'triggerEventKey', v_event_key, 'triggerSlot', p_trigger_slot,
    'triggerBlockTime', p_trigger_block_time,
    'expiresAt', p_trigger_block_time + interval '55 seconds',
    'requestedHeadSlot', p_finalized_head_slot,
    'requestedHeadBlockhash', v_head_hash,
    'requestedHeadBlockTime', p_finalized_head_block_time,
    'headSnapshotParserAbiFingerprint', v_head_snapshot_abi,
    'headCurveStateFingerprint', v_head_curve_fp,
    'headCurveObservedSlot', p_head_curve_observed_slot,
    'headCurveComplete', false,
    'headVirtualTokenReservesRaw', p_head_virtual_token_reserves_raw::text,
    'headVirtualSolReservesLamports', p_head_virtual_sol_reserves_lamports::text,
    'headRealTokenReservesRaw', p_head_real_token_reserves_raw::text,
    'headRealSolReservesLamports', p_head_real_sol_reserves_lamports::text,
    'headCurveTotalSupplyRaw', p_head_curve_total_supply_raw::text,
    'headMintLayoutFingerprint', v_head_layout,
    'headTokenProgram', v_head_program,
    'headMintSupplyRaw', p_head_mint_supply_raw::text,
    'headMintDecimals', p_head_mint_decimals,
    'scopeRevision', v_mint.scope_revision, 'settledRevision', null,
    'settledLeaseGeneration', null,
    'amountRaw', v_trigger.amount_raw::text,
    'totalSupplyRaw', v_mint.total_supply_raw::text,
    'netAcquiredRaw', v_net_raw::text,
    'netSupplyPct', v_threshold_pct
  );
end;
$$;

create or replace function public.record_custody_fresh_tail_cursor(
  p_user_id uuid,
  p_epoch_id uuid,
  p_scope_mint text,
  p_wallet text,
  p_expected_last_signature text,
  p_next_last_signature text,
  p_next_last_slot bigint,
  p_last_block_time bigint,
  p_first_available_block bigint,
  p_covered_head_slot bigint,
  p_covered_head_blockhash text,
  p_coverage_revision bigint,
  p_backlog_detected boolean,
  p_last_error text,
  p_lease_token uuid,
  p_lease_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_cursor public.custody_fresh_tail_cursors%rowtype;
  v_scope text := btrim(coalesce(p_scope_mint, ''));
  v_wallet text := btrim(coalesce(p_wallet, ''));
  v_expected text := nullif(btrim(coalesce(p_expected_last_signature, '')), '');
  v_next text := nullif(btrim(coalesce(p_next_last_signature, '')), '');
  v_head_hash text := nullif(btrim(coalesce(p_covered_head_blockhash, '')), '');
  v_history_ok boolean;
begin
  v_epoch := public.assert_custody_fresh_tail_lease(
    p_user_id, p_epoch_id, p_lease_token, p_lease_generation
  );
  if v_scope = '' or v_wallet = '' or p_first_available_block is null
     or p_first_available_block < 0 or p_coverage_revision is null
     or p_coverage_revision < 0 or p_backlog_detected is null
     or ((p_covered_head_slot is null) <> (v_head_hash is null))
     or (p_covered_head_slot is not null and p_covered_head_slot < 0)
     or ((v_next is null) <> (p_next_last_slot is null)) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_cursor_update');
  end if;
  if p_covered_head_slot is not null and not exists (
    select 1 from public.custody_fresh_tail_finalized_heads h
    where h.epoch_id = p_epoch_id and h.user_id = p_user_id
      and h.slot = p_covered_head_slot and h.blockhash = v_head_hash
  ) then
    return jsonb_build_object('ok', false, 'reason', 'finalized_head_not_attested');
  end if;

  select * into v_cursor
  from public.custody_fresh_tail_cursors
  where epoch_id = p_epoch_id and user_id = p_user_id
    and scope_mint = v_scope and wallet = v_wallet
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'cursor_not_found');
  end if;
  if p_covered_head_slot is not null
     and p_covered_head_slot < v_cursor.floor_slot then
    return jsonb_build_object('ok', false, 'reason', 'head_before_cursor_floor');
  end if;
  if v_cursor.last_processed_signature is distinct from v_expected then
    return jsonb_build_object(
      'ok', false, 'reason', 'cursor_cas_conflict',
      'lastSignature', v_cursor.last_processed_signature
    );
  end if;
  if v_cursor.last_processed_signature is not null and v_next is null then
    return jsonb_build_object('ok', false, 'reason', 'exact_signature_required');
  end if;
  if v_next is not null and (
    (v_cursor.initial_boundary_kind = 'exclusive_slot'
      and p_next_last_slot <= v_cursor.floor_slot)
    or
    (v_cursor.initial_boundary_kind = 'inclusive_slot'
      and p_next_last_slot < v_cursor.floor_slot)
  ) then
    return jsonb_build_object('ok', false, 'reason', 'cursor_crossed_floor');
  end if;
  if v_cursor.cursor_role = 'root' and p_coverage_revision <> 0 then
    return jsonb_build_object('ok', false, 'reason', 'root_revision_must_be_zero');
  elsif v_cursor.cursor_role = 'descendant' and not exists (
    select 1 from public.custody_fresh_tail_mints m
    where m.epoch_id = p_epoch_id and m.token_mint = v_scope
      and m.status = 'active'
      and m.scope_revision = p_coverage_revision and not m.poisoned
  ) then
    return jsonb_build_object('ok', false, 'reason', 'scope_revision_conflict');
  end if;

  if p_covered_head_slot is not null and (
    exists (
      select 1 from public.custody_fresh_tail_cursors c
      where c.epoch_id = p_epoch_id
        and c.covered_through_slot = p_covered_head_slot
        and c.covered_through_blockhash is not null
        and c.covered_through_blockhash <> v_head_hash
    ) or exists (
      select 1 from public.custody_fresh_tail_backscan_ranges r
      where r.epoch_id = p_epoch_id
        and r.covered_through_slot = p_covered_head_slot
        and r.covered_through_blockhash is not null
        and r.covered_through_blockhash <> v_head_hash
    ) or exists (
      select 1 from public.custody_fresh_tail_coverage_attestations a
      where a.epoch_id = p_epoch_id
        and a.covered_head_slot = p_covered_head_slot
        and a.covered_head_blockhash <> v_head_hash
    )
  ) then
    update public.custody_fresh_tail_epochs set
      status = 'invalidated', invalid_reason = 'finalized_head_blockhash_conflict',
      updated_at = now()
    where id = p_epoch_id;
    return jsonb_build_object('ok', false, 'reason', 'finalized_head_blockhash_conflict');
  end if;

  v_history_ok := p_first_available_block <= v_cursor.floor_slot;
  update public.custody_fresh_tail_cursors set
    current_boundary_kind = case when v_next is null
      then initial_boundary_kind else 'exact_signature' end,
    last_processed_signature = v_next,
    last_processed_slot = p_next_last_slot,
    last_block_time = p_last_block_time,
    first_available_block = p_first_available_block,
    history_floor_proven = v_history_ok,
    covered_through_slot = case
      when v_history_ok and not p_backlog_detected then p_covered_head_slot
      else covered_through_slot end,
    covered_through_blockhash = case
      when v_history_ok and not p_backlog_detected then v_head_hash
      else covered_through_blockhash end,
    coverage_revision = p_coverage_revision,
    backlog_detected = p_backlog_detected or not v_history_ok,
    last_error = case when not v_history_ok then 'history_floor_unavailable'
      else nullif(btrim(coalesce(p_last_error, '')), '') end,
    last_success_at = case when v_history_ok and not p_backlog_detected
      then now() else last_success_at end,
    last_lease_generation = p_lease_generation,
    updated_at = now()
  where epoch_id = p_epoch_id and scope_mint = v_scope and wallet = v_wallet
  returning * into v_cursor;

  if v_cursor.history_floor_proven and not v_cursor.backlog_detected
     and p_covered_head_slot is not null then
    insert into public.custody_fresh_tail_coverage_attestations (
      epoch_id, user_id, lane_kind, scope_mint, wallet,
      covered_head_slot, covered_head_blockhash, coverage_revision,
      lease_generation
    ) values (
      p_epoch_id, p_user_id, 'main', v_scope, v_wallet,
      p_covered_head_slot, v_head_hash, p_coverage_revision,
      p_lease_generation
    ) on conflict do nothing;
  end if;

  return jsonb_build_object(
    'ok', v_cursor.history_floor_proven and not v_cursor.backlog_detected,
    'reason', case
      when not v_cursor.history_floor_proven then 'history_floor_unavailable'
      when v_cursor.backlog_detected then 'backlog_detected'
      else 'cursor_recorded' end,
    'boundaryKind', v_cursor.current_boundary_kind,
    'lastSignature', v_cursor.last_processed_signature,
    'coveredThroughSlot', v_cursor.covered_through_slot,
    'coveredThroughBlockhash', v_cursor.covered_through_blockhash,
    'coverageRevision', v_cursor.coverage_revision,
    'backlogDetected', v_cursor.backlog_detected
  );
end;
$$;

create or replace function public.record_custody_fresh_tail_backscan_cursor(
  p_user_id uuid,
  p_epoch_id uuid,
  p_range_id uuid,
  p_expected_last_signature text,
  p_next_last_signature text,
  p_next_last_slot bigint,
  p_last_block_time bigint,
  p_first_available_block bigint,
  p_covered_head_slot bigint,
  p_covered_head_blockhash text,
  p_coverage_revision bigint,
  p_backlog_detected boolean,
  p_last_error text,
  p_lease_token uuid,
  p_lease_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_range public.custody_fresh_tail_backscan_ranges%rowtype;
  v_expected text := nullif(btrim(coalesce(p_expected_last_signature, '')), '');
  v_next text := nullif(btrim(coalesce(p_next_last_signature, '')), '');
  v_head_hash text := nullif(btrim(coalesce(p_covered_head_blockhash, '')), '');
  v_history_ok boolean;
begin
  v_epoch := public.assert_custody_fresh_tail_lease(
    p_user_id, p_epoch_id, p_lease_token, p_lease_generation
  );
  if p_range_id is null or p_first_available_block is null
     or p_first_available_block < 0 or p_coverage_revision is null
     or p_coverage_revision < 0 or p_backlog_detected is null
     or ((p_covered_head_slot is null) <> (v_head_hash is null))
     or (p_covered_head_slot is not null and p_covered_head_slot < 0)
     or ((v_next is null) <> (p_next_last_slot is null)) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_backscan_update');
  end if;
  if p_covered_head_slot is not null and not exists (
    select 1 from public.custody_fresh_tail_finalized_heads h
    where h.epoch_id = p_epoch_id and h.user_id = p_user_id
      and h.slot = p_covered_head_slot and h.blockhash = v_head_hash
  ) then
    return jsonb_build_object('ok', false, 'reason', 'finalized_head_not_attested');
  end if;
  select * into v_range
  from public.custody_fresh_tail_backscan_ranges
  where id = p_range_id and epoch_id = p_epoch_id and user_id = p_user_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'backscan_not_found');
  end if;
  if p_covered_head_slot is not null
     and p_covered_head_slot < v_range.floor_slot then
    return jsonb_build_object('ok', false, 'reason', 'head_before_backscan_floor');
  end if;
  if v_range.last_processed_signature is distinct from v_expected then
    return jsonb_build_object(
      'ok', false, 'reason', 'backscan_cas_conflict',
      'lastSignature', v_range.last_processed_signature
    );
  end if;
  if v_range.last_processed_signature is not null and v_next is null then
    return jsonb_build_object('ok', false, 'reason', 'exact_signature_required');
  end if;
  if v_next is not null and p_next_last_slot < v_range.floor_slot then
    return jsonb_build_object('ok', false, 'reason', 'backscan_crossed_floor');
  end if;
  if not exists (
    select 1 from public.custody_fresh_tail_mints m
    where m.epoch_id = p_epoch_id and m.token_mint = v_range.token_mint
      and m.status = 'active'
      and m.scope_revision = p_coverage_revision and not m.poisoned
  ) then
    return jsonb_build_object('ok', false, 'reason', 'scope_revision_conflict');
  end if;
  if p_covered_head_slot is not null and (
    exists (
      select 1 from public.custody_fresh_tail_cursors c
      where c.epoch_id = p_epoch_id
        and c.covered_through_slot = p_covered_head_slot
        and c.covered_through_blockhash is not null
        and c.covered_through_blockhash <> v_head_hash
    ) or exists (
      select 1 from public.custody_fresh_tail_backscan_ranges r
      where r.epoch_id = p_epoch_id
        and r.covered_through_slot = p_covered_head_slot
        and r.covered_through_blockhash is not null
        and r.covered_through_blockhash <> v_head_hash
    ) or exists (
      select 1 from public.custody_fresh_tail_coverage_attestations a
      where a.epoch_id = p_epoch_id
        and a.covered_head_slot = p_covered_head_slot
        and a.covered_head_blockhash <> v_head_hash
    )
  ) then
    update public.custody_fresh_tail_epochs set
      status = 'invalidated', invalid_reason = 'finalized_head_blockhash_conflict',
      updated_at = now()
    where id = p_epoch_id;
    return jsonb_build_object('ok', false, 'reason', 'finalized_head_blockhash_conflict');
  end if;

  v_history_ok := p_first_available_block <= v_range.floor_slot;
  update public.custody_fresh_tail_backscan_ranges set
    current_boundary_kind = case when v_next is null
      then 'inclusive_slot' else 'exact_signature' end,
    last_processed_signature = v_next,
    last_processed_slot = p_next_last_slot,
    last_block_time = p_last_block_time,
    first_available_block = p_first_available_block,
    history_floor_proven = v_history_ok,
    covered_through_slot = case
      when v_history_ok and not p_backlog_detected then p_covered_head_slot
      else covered_through_slot end,
    covered_through_blockhash = case
      when v_history_ok and not p_backlog_detected then v_head_hash
      else covered_through_blockhash end,
    coverage_revision = p_coverage_revision,
    backlog_detected = p_backlog_detected or not v_history_ok,
    last_error = case when not v_history_ok then 'history_floor_unavailable'
      else nullif(btrim(coalesce(p_last_error, '')), '') end,
    last_success_at = case when v_history_ok and not p_backlog_detected
      then now() else last_success_at end,
    last_lease_generation = p_lease_generation,
    completed_at = case when v_history_ok and not p_backlog_detected
      and p_covered_head_slot is not null then now() else null end,
    updated_at = now()
  where id = p_range_id
  returning * into v_range;

  if v_range.history_floor_proven and not v_range.backlog_detected
     and p_covered_head_slot is not null then
    insert into public.custody_fresh_tail_coverage_attestations (
      epoch_id, user_id, lane_kind, range_id, covered_head_slot,
      covered_head_blockhash, coverage_revision, lease_generation
    ) values (
      p_epoch_id, p_user_id, 'backscan', p_range_id, p_covered_head_slot,
      v_head_hash, p_coverage_revision, p_lease_generation
    ) on conflict do nothing;
  end if;

  return jsonb_build_object(
    'ok', v_range.history_floor_proven and not v_range.backlog_detected,
    'reason', case
      when not v_range.history_floor_proven then 'history_floor_unavailable'
      when v_range.backlog_detected then 'backlog_detected'
      else 'backscan_recorded' end,
    'rangeId', v_range.id, 'boundaryKind', v_range.current_boundary_kind,
    'lastSignature', v_range.last_processed_signature,
    'coveredThroughSlot', v_range.covered_through_slot,
    'coveredThroughBlockhash', v_range.covered_through_blockhash,
    'coverageRevision', v_range.coverage_revision,
    'backlogDetected', v_range.backlog_detected
  );
end;
$$;

create or replace function public.settle_custody_fresh_tail_request(
  p_user_id uuid,
  p_epoch_id uuid,
  p_request_id uuid,
  p_expected_scope_revision bigint,
  p_lease_token uuid,
  p_lease_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_request public.custody_fresh_tail_requests%rowtype;
  v_mint public.custody_fresh_tail_mints%rowtype;
  v_observed_at timestamptz;
begin
  v_epoch := public.assert_custody_fresh_tail_lease(
    p_user_id, p_epoch_id, p_lease_token, p_lease_generation
  );
  if p_request_id is null or p_expected_scope_revision is null
     or p_expected_scope_revision < 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_settlement_request');
  end if;

  select * into v_request
  from public.custody_fresh_tail_requests
  where id = p_request_id and epoch_id = p_epoch_id and user_id = p_user_id
  for update;
  if not found or v_request.status not in ('pending', 'settled') then
    return jsonb_build_object('ok', false, 'reason', 'request_not_live');
  end if;
  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(v_request.token_mint));
  select * into v_mint
  from public.custody_fresh_tail_mints
  where epoch_id = p_epoch_id and token_mint = v_request.token_mint
  for update;
  if not found or v_mint.status <> 'active' or v_mint.poisoned then
    return jsonb_build_object('ok', false, 'reason', 'mint_not_active');
  end if;
  if v_request.expires_at <= clock_timestamp() then
    update public.custody_fresh_tail_requests set
      status = 'expired', invalid_reason = 'coverage_expired',
      settled_revision = null, settled_lease_generation = null,
      settled_at = null, updated_at = now()
    where id = p_request_id;
    return jsonb_build_object('ok', false, 'reason', 'request_expired');
  end if;
  if v_mint.scope_revision <> p_expected_scope_revision
     or v_request.scope_revision <> p_expected_scope_revision then
    return jsonb_build_object(
      'ok', false, 'reason', 'scope_revision_conflict',
      'scopeRevision', v_mint.scope_revision
    );
  end if;

  if (select count(*) from public.custody_fresh_tail_roots
      where epoch_id = p_epoch_id) <> 3
     or (select count(*) from public.custody_fresh_tail_cursors
         where epoch_id = p_epoch_id and cursor_role = 'root'
           and scope_mint = '*') <> 3
     or exists (
       select 1
       from public.custody_fresh_tail_roots r
       left join public.custody_fresh_tail_cursors c
         on c.epoch_id = r.epoch_id and c.scope_mint = '*'
        and c.wallet = r.wallet and c.cursor_role = 'root'
       where r.epoch_id = p_epoch_id
         and (
           c.wallet is null or c.backlog_detected or not c.history_floor_proven
           or not exists (
             select 1 from public.custody_fresh_tail_coverage_attestations a
             where a.epoch_id = p_epoch_id and a.lane_kind = 'main'
               and a.scope_mint = '*' and a.wallet = r.wallet
               and a.covered_head_slot = v_request.requested_head_slot
               and a.covered_head_blockhash = v_request.requested_head_blockhash
               and a.coverage_revision = 0
               and a.lease_generation = p_lease_generation
           )
         )
     ) then
    return jsonb_build_object('ok', false, 'reason', 'root_coverage_incomplete');
  end if;

  if exists (
    select 1
    from public.custody_fresh_tail_wallets w
    left join public.custody_fresh_tail_cursors c
      on c.epoch_id = w.epoch_id and c.scope_mint = w.token_mint
     and c.wallet = w.wallet and c.cursor_role = 'descendant'
    where w.epoch_id = p_epoch_id and w.token_mint = v_request.token_mint
      and (
        w.watch_status <> 'active' or not w.classification_reliable
        or c.wallet is null or c.backlog_detected or not c.history_floor_proven
        or c.coverage_revision <> p_expected_scope_revision
        or not exists (
          select 1 from public.custody_fresh_tail_coverage_attestations a
          where a.epoch_id = p_epoch_id and a.lane_kind = 'main'
            and a.scope_mint = w.token_mint and a.wallet = w.wallet
            and a.covered_head_slot = v_request.requested_head_slot
            and a.covered_head_blockhash = v_request.requested_head_blockhash
            and a.coverage_revision = p_expected_scope_revision
            and a.lease_generation = p_lease_generation
        )
      )
  ) then
    return jsonb_build_object('ok', false, 'reason', 'descendant_coverage_incomplete');
  end if;

  if exists (
    select 1 from public.custody_fresh_tail_backscan_ranges r
    where r.epoch_id = p_epoch_id and r.token_mint = v_request.token_mint
      and (
        r.coverage_revision <> p_expected_scope_revision
        or r.backlog_detected or not r.history_floor_proven
        or not exists (
          select 1 from public.custody_fresh_tail_coverage_attestations a
          where a.epoch_id = p_epoch_id and a.lane_kind = 'backscan'
            and a.range_id = r.id
            and a.covered_head_slot = v_request.requested_head_slot
            and a.covered_head_blockhash = v_request.requested_head_blockhash
            and a.coverage_revision = p_expected_scope_revision
            and a.lease_generation = p_lease_generation
        )
      )
  ) then
    return jsonb_build_object('ok', false, 'reason', 'backscan_coverage_incomplete');
  end if;

  if exists (
    select 1 from public.custody_fresh_tail_edges e
    where e.epoch_id = p_epoch_id and e.token_mint = v_request.token_mint
      and e.applied_revision is null
  ) then
    return jsonb_build_object('ok', false, 'reason', 'scope_not_fixed_point');
  end if;
  if not exists (
    select 1 from public.custody_fresh_tail_custody_events e
    where e.epoch_id = p_epoch_id and e.token_mint = v_request.token_mint
      and e.event_kind = 'TARGET_BUY'
      and e.tx_sig = v_request.trigger_tx_sig
      and e.slot = v_request.trigger_slot
      and e.source_wallet = v_request.trigger_target_wallet
      and e.classification_reliable and not e.quarantined
      and not e.terminal_poison
      and public.is_custody_fresh_tail_parser_reviewed(
        e.parser_domain, e.parser_abi_fingerprint
      )
  ) then
    return jsonb_build_object('ok', false, 'reason', 'fresh_target_buy_missing');
  end if;
  if not exists (
    select 1
    from public.custody_fresh_tail_supply_events s
    join public.custody_fresh_tail_custody_events c
      on c.epoch_id = s.epoch_id and c.token_mint = s.token_mint
     and c.tx_sig = s.tx_sig and c.slot = s.slot
     and c.source_wallet = s.target_wallet and c.amount_raw = s.amount_raw
    where s.epoch_id = p_epoch_id and s.token_mint = v_request.token_mint
      and s.event_key = v_mint.enrollment_event_key
      and s.tx_sig = v_mint.enrollment_tx_sig
      and s.slot = v_mint.enrollment_slot
      and s.block_time = v_mint.enrollment_block_time
      and s.target_wallet = v_mint.enrollment_target_wallet
      and s.side = 'buy' and c.event_kind = 'TARGET_BUY'
      and not s.quarantined and not c.quarantined
      and s.classification_reliable and c.classification_reliable
      and s.pump_fun_verified
      and public.is_custody_fresh_tail_parser_reviewed(
        s.parser_domain, s.parser_abi_fingerprint
      )
      and public.is_custody_fresh_tail_parser_reviewed(
        c.parser_domain, c.parser_abi_fingerprint
      )
  ) then
    return jsonb_build_object('ok', false, 'reason', 'enrollment_evidence_missing');
  end if;
  if exists (
    select 1 from public.custody_fresh_tail_supply_events e
    where e.epoch_id = p_epoch_id and e.token_mint = v_request.token_mint
      and e.slot <= v_request.requested_head_slot
      and (e.side = 'sell' or e.quarantined or not e.classification_reliable
        or not e.pump_fun_verified
        or not public.is_custody_fresh_tail_parser_reviewed(
          e.parser_domain, e.parser_abi_fingerprint
        ))
  ) or exists (
    select 1 from public.custody_fresh_tail_custody_events e
    where e.epoch_id = p_epoch_id and e.token_mint = v_request.token_mint
      and e.slot <= v_request.requested_head_slot
      and (e.event_kind in ('SELL', 'UNRESOLVED_OUTFLOW', 'TERMINAL_OUTFLOW')
        or e.quarantined or e.classification_pending or e.terminal_poison
        or not public.is_custody_fresh_tail_parser_reviewed(
          e.parser_domain, e.parser_abi_fingerprint
        ))
  ) then
    return jsonb_build_object('ok', false, 'reason', 'fresh_sell_or_poison_seen');
  end if;
  -- Legacy state is never positive authority.  It is consulted only as an
  -- additional permanent poison source.
  if exists (
    select 1 from public.custody_pending_events p
    where p.user_id = p_user_id and p.token_mint = v_request.token_mint
      and p.event_at >= v_epoch.activation_block_time
      and (
        p.status in ('expired', 'terminal')
        or coalesce(p.last_error_code, '') = 'payload_mismatch'
      )
  ) or exists (
    select 1 from public.custody_journeys j
    where j.user_id = p_user_id and j.token_mint = v_request.token_mint
      and j.status = 'active'
      and (j.first_event_key <> v_mint.enrollment_event_key
        or j.total_unresolved_outflow_tokens > 0)
  ) then
    return jsonb_build_object('ok', false, 'reason', 'legacy_poison_seen');
  end if;

  v_observed_at := clock_timestamp();
  update public.custody_fresh_tail_requests set
    status = 'settled', settled_revision = p_expected_scope_revision,
    settled_lease_generation = p_lease_generation,
    settled_at = v_observed_at, invalid_reason = null, updated_at = now()
  where id = p_request_id
  returning * into v_request;

  return jsonb_build_object(
    'ok', true, 'reason', 'settled', 'epochId', p_epoch_id,
    'requestId', v_request.id, 'tokenMint', v_request.token_mint,
    'triggerEventKey', v_request.trigger_event_key,
    'triggerSlot', v_request.trigger_slot,
    'triggerBlockTime', v_request.trigger_block_time,
    'expiresAt', v_request.expires_at,
    'requestedHeadSlot', v_request.requested_head_slot,
    'requestedHeadBlockhash', v_request.requested_head_blockhash,
    'requestedHeadBlockTime', v_request.requested_head_block_time,
    'headSnapshotParserAbiFingerprint',
      v_request.head_snapshot_parser_abi_fingerprint,
    'headCurveStateFingerprint', v_request.head_curve_state_fingerprint,
    'headCurveObservedSlot', v_request.head_curve_observed_slot,
    'headCurveComplete', v_request.head_curve_complete,
    'headVirtualTokenReservesRaw', v_request.head_virtual_token_reserves_raw::text,
    'headVirtualSolReservesLamports', v_request.head_virtual_sol_reserves_lamports::text,
    'headRealTokenReservesRaw', v_request.head_real_token_reserves_raw::text,
    'headRealSolReservesLamports', v_request.head_real_sol_reserves_lamports::text,
    'headCurveTotalSupplyRaw', v_request.head_curve_total_supply_raw::text,
    'headMintLayoutFingerprint', v_request.head_mint_layout_fingerprint,
    'headTokenProgram', v_request.head_token_program,
    'headMintSupplyRaw', v_request.head_mint_supply_raw::text,
    'headMintDecimals', v_request.head_mint_decimals,
    'scopeRevision', v_request.scope_revision,
    'settledRevision', v_request.settled_revision,
    'settledLeaseGeneration', v_request.settled_lease_generation,
    'proofObservedAt', v_observed_at
  );
end;
$$;

create or replace function public.bind_supply_entry_claim_fresh_tail(
  p_user_id uuid,
  p_claim_id uuid,
  p_epoch_id uuid,
  p_request_id uuid,
  p_source_tx_sig text,
  p_source_wallet text,
  p_token_mint text,
  p_source_slot bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_claim public.entry_signal_claims%rowtype;
  v_request public.custody_fresh_tail_requests%rowtype;
  v_sig text := btrim(coalesce(p_source_tx_sig, ''));
  v_wallet text := btrim(coalesce(p_source_wallet, ''));
  v_mint text := btrim(coalesce(p_token_mint, ''));
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;
  if p_user_id is null or p_claim_id is null or p_epoch_id is null
     or p_request_id is null or v_sig = '' or v_wallet = '' or v_mint = ''
     or p_source_slot is null or p_source_slot < 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_claim_binding');
  end if;
  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(v_mint));
  select * into v_epoch
  from public.custody_fresh_tail_epochs
  where id = p_epoch_id and user_id = p_user_id;
  if not found or v_epoch.status <> 'active'
     or v_epoch.lease_token is null or v_epoch.lease_owner is null
     or v_epoch.lease_expires_at is null
     or v_epoch.lease_expires_at <= clock_timestamp() then
    return jsonb_build_object('ok', false, 'reason', 'fresh_tail_monitor_stale');
  end if;
  select * into v_request
  from public.custody_fresh_tail_requests
  where id = p_request_id and epoch_id = p_epoch_id and user_id = p_user_id
  for update;
  if not found or v_request.status <> 'settled'
     or v_request.expires_at <= clock_timestamp()
     or v_request.settled_at is null
     or v_request.settled_at < clock_timestamp() - interval '4 seconds'
     or v_request.settled_revision is distinct from v_request.scope_revision
     or v_request.settled_lease_generation is distinct from v_epoch.lease_generation
     or v_request.trigger_tx_sig <> v_sig
     or v_request.trigger_target_wallet <> v_wallet
     or v_request.token_mint <> v_mint
     or v_request.trigger_slot <> p_source_slot then
    return jsonb_build_object('ok', false, 'reason', 'request_binding_mismatch');
  end if;
  select * into v_claim
  from public.entry_signal_claims
  where id = p_claim_id and user_id = p_user_id
  for update;
  if not found
     or v_claim.status <> 'claimed'
     or v_claim.entry_strategy <> 'supply_accumulation'
     or v_claim.source_tx_sig <> v_sig
     or v_claim.source_wallet <> v_wallet
     or v_claim.token_mint <> v_mint
     or v_claim.source_slot is distinct from p_source_slot then
    return jsonb_build_object('ok', false, 'reason', 'entry_claim_mismatch');
  end if;
  if v_claim.fresh_tail_epoch_id is not null then
    return jsonb_build_object(
      'ok', v_claim.fresh_tail_epoch_id = p_epoch_id
        and v_claim.fresh_tail_request_id = p_request_id,
      'reason', case
        when v_claim.fresh_tail_epoch_id = p_epoch_id
          and v_claim.fresh_tail_request_id = p_request_id
        then 'already_bound' else 'claim_already_bound_elsewhere' end,
      'claimId', v_claim.id, 'epochId', v_claim.fresh_tail_epoch_id,
      'requestId', v_claim.fresh_tail_request_id,
      'positionId', v_claim.planned_position_id, 'bound', true
    );
  end if;

  update public.entry_signal_claims set
    fresh_tail_epoch_id = p_epoch_id,
    fresh_tail_request_id = p_request_id,
    fresh_tail_monitoring_armed_at = clock_timestamp(),
    updated_at = now()
  where id = p_claim_id
    and fresh_tail_epoch_id is null and fresh_tail_request_id is null
  returning * into v_claim;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'claim_binding_cas_conflict');
  end if;

  insert into public.custody_fresh_tail_exit_intents (
    user_id, epoch_id, request_id, token_mint, entry_claim_id,
    position_id, source_domain, supply_event_id, trigger_kind
  )
  select p_user_id, p_epoch_id, p_request_id, v_mint, p_claim_id,
    v_claim.planned_position_id, 'supply', e.id, 'direct_target_sell'
  from public.custody_fresh_tail_supply_events e
  where e.epoch_id = p_epoch_id and e.token_mint = v_mint
    and e.side = 'sell' and e.slot >= p_source_slot
  on conflict do nothing;

  insert into public.custody_fresh_tail_exit_intents (
    user_id, epoch_id, request_id, token_mint, entry_claim_id,
    position_id, source_domain, custody_event_id, trigger_kind
  )
  select p_user_id, p_epoch_id, p_request_id, v_mint, p_claim_id,
    v_claim.planned_position_id, 'custody', e.id,
    case
      when e.event_kind = 'SELL' then 'mirror_custody_sell'
      else 'terminal_outflow'
    end
  from public.custody_fresh_tail_custody_events e
  where e.epoch_id = p_epoch_id and e.token_mint = v_mint
    and e.slot >= p_source_slot
    and (
      e.event_kind in ('SELL', 'UNRESOLVED_OUTFLOW', 'TERMINAL_OUTFLOW')
      or e.terminal_poison or not e.watchable
    )
    and not (
      e.event_kind = 'SELL' and exists (
        select 1 from public.custody_fresh_tail_roots r
        where r.epoch_id = p_epoch_id and r.wallet = e.source_wallet
      )
    )
  on conflict do nothing;

  return jsonb_build_object(
    'ok', true, 'reason', 'bound_and_armed', 'claimId', v_claim.id,
    'epochId', p_epoch_id, 'requestId', p_request_id,
    'positionId', v_claim.planned_position_id, 'bound', true,
    'armedAt', v_claim.fresh_tail_monitoring_armed_at
  );
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'request_already_claimed');
end;
$$;

create or replace function public.record_supply_entry_claim_fresh_tail_receipt(
  p_user_id uuid,
  p_claim_id uuid,
  p_epoch_id uuid,
  p_request_id uuid,
  p_bot_tx_sig text,
  p_received_amount_raw text,
  p_received_token_decimals integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_claim public.entry_signal_claims%rowtype;
  v_request public.custody_fresh_tail_requests%rowtype;
  v_mint public.custody_fresh_tail_mints%rowtype;
  v_signature text := btrim(coalesce(p_bot_tx_sig, ''));
  v_received_raw numeric(78, 0);
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;
  if p_user_id is null or p_claim_id is null or p_epoch_id is null
     or p_request_id is null or v_signature = ''
     or p_received_amount_raw is null
     or p_received_amount_raw !~ '^[1-9][0-9]*$'
     or char_length(p_received_amount_raw) > 78
     or p_received_token_decimals is null
     or p_received_token_decimals not between 0 and 18 then
    return jsonb_build_object(
      'ok', false, 'replay', false, 'reason', 'invalid_entry_receipt'
    );
  end if;
  v_received_raw := p_received_amount_raw::numeric;

  perform pg_advisory_xact_lock(
    hashtext(p_user_id::text), hashtext(p_claim_id::text)
  );
  select * into v_claim
  from public.entry_signal_claims
  where id = p_claim_id and user_id = p_user_id
  for update;
  if not found then
    return jsonb_build_object(
      'ok', false, 'replay', false, 'reason', 'entry_claim_not_found'
    );
  end if;
  if v_claim.entry_strategy <> 'supply_accumulation'
     or v_claim.entry_mode <> 'regular'
     or v_claim.fresh_tail_epoch_id is distinct from p_epoch_id
     or v_claim.fresh_tail_request_id is distinct from p_request_id
     or v_claim.fresh_tail_monitoring_armed_at is null then
    return jsonb_build_object(
      'ok', false, 'replay', false, 'reason', 'entry_receipt_binding_mismatch',
      'claimId', v_claim.id, 'positionId', v_claim.planned_position_id
    );
  end if;
  if v_claim.bot_tx_sig is distinct from v_signature
     or v_claim.submission_started_at is null
     or v_claim.last_valid_block_height is null
     or v_claim.last_valid_block_height <= 0
     or v_claim.fresh_tail_monitoring_armed_at > v_claim.submission_started_at then
    return jsonb_build_object(
      'ok', false, 'replay', false, 'reason', 'prepared_entry_identity_mismatch',
      'claimId', v_claim.id, 'positionId', v_claim.planned_position_id
    );
  end if;

  select * into v_request
  from public.custody_fresh_tail_requests
  where id = p_request_id and epoch_id = p_epoch_id and user_id = p_user_id;
  if not found
     or v_request.token_mint <> v_claim.token_mint
     or v_request.trigger_tx_sig <> v_claim.source_tx_sig
     or v_request.trigger_target_wallet <> v_claim.source_wallet
     or v_request.trigger_slot is distinct from v_claim.source_slot then
    return jsonb_build_object(
      'ok', false, 'replay', false, 'reason', 'entry_receipt_request_mismatch',
      'claimId', v_claim.id, 'positionId', v_claim.planned_position_id
    );
  end if;
  select * into v_mint
  from public.custody_fresh_tail_mints
  where epoch_id = p_epoch_id and user_id = p_user_id
    and token_mint = v_claim.token_mint;
  if not found
     or v_mint.decimals <> p_received_token_decimals
     or v_claim.token_decimals is distinct from p_received_token_decimals
     or v_received_raw > v_mint.total_supply_raw then
    return jsonb_build_object(
      'ok', false, 'replay', false, 'reason', 'entry_receipt_mint_mismatch',
      'claimId', v_claim.id, 'positionId', v_claim.planned_position_id
    );
  end if;

  if v_claim.status in ('landed', 'persisted') then
    if v_claim.received_amount_raw is distinct from p_received_amount_raw
       or v_claim.received_token_decimals is distinct from p_received_token_decimals
       or v_claim.landed_at is null then
      return jsonb_build_object(
        'ok', false, 'replay', false, 'reason', 'landed_entry_receipt_mismatch',
        'claimId', v_claim.id, 'positionId', v_claim.planned_position_id
      );
    end if;
    return jsonb_build_object(
      'ok', true, 'replay', true, 'reason', 'entry_receipt_already_recorded',
      'claimId', v_claim.id, 'positionId', v_claim.planned_position_id,
      'botTxSig', v_signature, 'receivedAmountRaw', v_claim.received_amount_raw,
      'receivedTokenDecimals', v_claim.received_token_decimals,
      'landedAt', v_claim.landed_at, 'status', v_claim.status
    );
  end if;
  if v_claim.status not in ('submitted', 'uncertain')
     or v_claim.received_amount_raw is not null
     or v_claim.received_token_decimals is not null
     or v_claim.landed_at is not null then
    return jsonb_build_object(
      'ok', false, 'replay', false, 'reason', 'entry_receipt_state_invalid',
      'claimId', v_claim.id, 'positionId', v_claim.planned_position_id,
      'status', v_claim.status
    );
  end if;

  update public.entry_signal_claims set
    status = 'landed',
    received_amount_raw = p_received_amount_raw,
    received_token_decimals = p_received_token_decimals,
    error_code = null,
    landed_at = clock_timestamp(),
    updated_at = now()
  where id = v_claim.id and user_id = p_user_id
    and status in ('submitted', 'uncertain')
    and bot_tx_sig = v_signature
    and fresh_tail_epoch_id = p_epoch_id
    and fresh_tail_request_id = p_request_id
    and received_amount_raw is null
    and received_token_decimals is null
    and landed_at is null
  returning * into v_claim;
  if not found then
    raise exception using
      errcode = '40001',
      message = 'fresh-tail entry receipt claim changed during exact CAS';
  end if;

  return jsonb_build_object(
    'ok', true, 'replay', false, 'reason', 'entry_receipt_recorded',
    'claimId', v_claim.id, 'positionId', v_claim.planned_position_id,
    'botTxSig', v_signature, 'receivedAmountRaw', v_claim.received_amount_raw,
    'receivedTokenDecimals', v_claim.received_token_decimals,
    'landedAt', v_claim.landed_at, 'status', v_claim.status
  );
end;
$$;

create or replace function public.claim_custody_fresh_tail_exit_intents(
  p_user_id uuid,
  p_worker_id text,
  p_limit integer default 25,
  p_claim_seconds integer default 180
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_intents jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;
  if p_user_id is null or v_worker = ''
     or p_limit is null or p_limit not between 1 and 100
     or p_claim_seconds is null or p_claim_seconds not between 180 and 600 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_intent_claim');
  end if;

  with candidates as materialized (
    select i.id
    from public.custody_fresh_tail_exit_intents i
    where i.user_id = p_user_id
      and (
        i.status = 'pending'
        or (
          i.status = 'retry'
          and i.updated_at <= clock_timestamp() - interval '1 second'
        )
        or (i.status = 'claimed' and i.claim_expires_at <= clock_timestamp())
      )
    order by case when i.status = 'pending' then 0 else 1 end, i.created_at, i.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update public.custody_fresh_tail_exit_intents i set
      status = 'claimed', disposition = null, worker_id = v_worker,
      claim_token = gen_random_uuid(),
      claim_generation = i.claim_generation + 1,
      claim_expires_at = clock_timestamp() + make_interval(secs => p_claim_seconds),
      updated_at = now()
    from candidates c
    where i.id = c.id
    returning i.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'intentId', i.id, 'claimToken', i.claim_token,
    'claimGeneration', i.claim_generation, 'claimExpiresAt', i.claim_expires_at,
    'entryClaimId', i.entry_claim_id, 'positionId', i.position_id,
    'epochId', i.epoch_id, 'requestId', i.request_id,
    'tokenMint', i.token_mint, 'sourceDomain', i.source_domain,
    'eventId', coalesce(i.supply_event_id, i.custody_event_id),
    'eventKey', coalesce(se.event_key, ce.event_key),
    'eventKind', coalesce(ce.event_kind, upper(se.side)),
    'triggerKind', i.trigger_kind, 'txSig', coalesce(se.tx_sig, ce.tx_sig),
    'slot', coalesce(se.slot, ce.slot),
    'blockTime', coalesce(se.block_time, ce.block_time),
    'sourceWallet', coalesce(se.target_wallet, ce.source_wallet),
    'amountRaw', coalesce(se.amount_raw, ce.amount_raw)::text,
    'decimals', coalesce(se.decimals, ce.decimals),
    'recipients', coalesce(ce.recipients, '[]'::jsonb),
    'classification', ce.classification,
    'classificationReliable', coalesce(se.classification_reliable, ce.classification_reliable),
    'watchable', ce.watchable, 'status', i.status
  ) order by i.created_at, i.id), '[]'::jsonb) into v_intents
  from claimed i
  left join public.custody_fresh_tail_supply_events se on se.id = i.supply_event_id
  left join public.custody_fresh_tail_custody_events ce on ce.id = i.custody_event_id;

  return jsonb_build_object('ok', true, 'reason', 'claimed', 'intents', v_intents);
end;
$$;

-- Uncertain execution is never returned by the normal execution claim.  A
-- reconciler must claim it through this separate API and prove the prior
-- transaction outcome before choosing resolved or retry.
create or replace function public.claim_custody_fresh_tail_uncertain_intents(
  p_user_id uuid,
  p_worker_id text,
  p_limit integer default 25,
  p_claim_seconds integer default 180
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_intents jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;
  if p_user_id is null or v_worker = ''
     or p_limit is null or p_limit not between 1 and 100
     or p_claim_seconds is null or p_claim_seconds not between 180 and 600 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_uncertain_claim');
  end if;

  with candidates as materialized (
    select i.id
    from public.custody_fresh_tail_exit_intents i
    where i.user_id = p_user_id and i.status = 'uncertain'
      and (i.claim_token is null or i.claim_expires_at <= clock_timestamp())
    order by i.updated_at, i.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update public.custody_fresh_tail_exit_intents i set
      worker_id = v_worker, claim_token = gen_random_uuid(),
      claim_generation = i.claim_generation + 1,
      claim_expires_at = clock_timestamp() + make_interval(secs => p_claim_seconds),
      updated_at = now()
    from candidates c
    where i.id = c.id
    returning i.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'intentId', i.id, 'claimToken', i.claim_token,
    'claimGeneration', i.claim_generation, 'claimExpiresAt', i.claim_expires_at,
    'entryClaimId', i.entry_claim_id, 'positionId', i.position_id,
    'epochId', i.epoch_id, 'requestId', i.request_id,
    'tokenMint', i.token_mint, 'sourceDomain', i.source_domain,
    'eventId', coalesce(i.supply_event_id, i.custody_event_id),
    'eventKey', coalesce(se.event_key, ce.event_key),
    'eventKind', coalesce(ce.event_kind, upper(se.side)),
    'triggerKind', i.trigger_kind, 'txSig', coalesce(se.tx_sig, ce.tx_sig),
    'slot', coalesce(se.slot, ce.slot),
    'blockTime', coalesce(se.block_time, ce.block_time),
    'sourceWallet', coalesce(se.target_wallet, ce.source_wallet),
    'amountRaw', coalesce(se.amount_raw, ce.amount_raw)::text,
    'decimals', coalesce(se.decimals, ce.decimals),
    'recipients', coalesce(ce.recipients, '[]'::jsonb),
    'classification', ce.classification,
    'classificationReliable', coalesce(se.classification_reliable, ce.classification_reliable),
    'watchable', ce.watchable,
    'priorSellClaimId', i.sell_claim_id, 'priorBotTxSig', i.bot_tx_sig,
    'priorErrorCode', i.error_code, 'status', i.status
  ) order by i.updated_at, i.id), '[]'::jsonb) into v_intents
  from claimed i
  left join public.custody_fresh_tail_supply_events se on se.id = i.supply_event_id
  left join public.custody_fresh_tail_custody_events ce on ce.id = i.custody_event_id;

  return jsonb_build_object(
    'ok', true, 'reason', 'uncertain_claimed', 'intents', v_intents
  );
end;
$$;

create or replace function public.resolve_custody_fresh_tail_exit_intent(
  p_user_id uuid,
  p_intent_id uuid,
  p_claim_token uuid,
  p_claim_generation bigint,
  p_expected_status text,
  p_disposition text,
  p_sell_claim_id uuid default null,
  p_bot_tx_sig text default null,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_intent public.custody_fresh_tail_exit_intents%rowtype;
  v_sell_claim public.sell_signal_claims%rowtype;
  v_entry_claim public.entry_signal_claims%rowtype;
  v_position public.positions%rowtype;
  v_config public.bot_config%rowtype;
  v_disposition text := lower(btrim(coalesce(p_disposition, '')));
  v_expected text := lower(btrim(coalesce(p_expected_status, '')));
  v_source_tx_sig text;
  v_source_wallet text;
  v_expected_trigger text;
  v_source_is_root boolean := false;
  v_status text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;
  if p_user_id is null or p_intent_id is null or p_claim_token is null
     or p_claim_generation is null or p_claim_generation <= 0
     or v_expected not in ('claimed', 'uncertain')
     or v_disposition not in (
       'resolved', 'retry', 'uncertain', 'disabled_by_policy',
       'position_not_live', 'duplicate_sell_claim', 'entry_failed', 'position_closed'
     ) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_intent_resolution');
  end if;
  select * into v_intent
  from public.custody_fresh_tail_exit_intents
  where id = p_intent_id and user_id = p_user_id
  for update;
  if not found
     or v_intent.status <> v_expected
     or v_intent.claim_token is distinct from p_claim_token
     or v_intent.claim_generation <> p_claim_generation
     or v_intent.claim_expires_at <= clock_timestamp() then
    return jsonb_build_object('ok', false, 'reason', 'intent_claim_fenced');
  end if;

  if v_intent.source_domain = 'supply' then
    select e.tx_sig, e.target_wallet into v_source_tx_sig, v_source_wallet
    from public.custody_fresh_tail_supply_events e
    where e.id = v_intent.supply_event_id
      and e.epoch_id = v_intent.epoch_id
      and e.user_id = p_user_id;
  else
    select e.tx_sig, e.source_wallet into v_source_tx_sig, v_source_wallet
    from public.custody_fresh_tail_custody_events e
    where e.id = v_intent.custody_event_id
      and e.epoch_id = v_intent.epoch_id
      and e.user_id = p_user_id;
  end if;
  if not found or nullif(btrim(coalesce(v_source_tx_sig, '')), '') is null
     or nullif(btrim(coalesce(v_source_wallet, '')), '') is null then
    return jsonb_build_object('ok', false, 'reason', 'intent_source_event_missing');
  end if;
  v_source_is_root := exists (
    select 1 from public.custody_fresh_tail_roots r
    where r.epoch_id = v_intent.epoch_id and r.user_id = p_user_id
      and r.wallet = v_source_wallet
  );
  v_expected_trigger := case v_intent.trigger_kind
    when 'direct_target_sell' then 'direct_target_sell'
    when 'mirror_custody_sell' then 'mirror_custody_sell'
    when 'terminal_outflow' then case when v_source_is_root
      then 'target_terminal_outflow' else 'terminal_outflow' end
    else null
  end;
  if v_expected_trigger is null then
    return jsonb_build_object('ok', false, 'reason', 'intent_trigger_invalid');
  end if;

  if v_expected = 'claimed' and v_disposition = 'resolved' then
    return jsonb_build_object(
      'ok', false, 'reason', 'pre_submit_uncertain_required'
    );
  end if;
  if v_disposition in ('uncertain', 'resolved')
     or (v_expected = 'uncertain' and v_disposition = 'retry') then
    if p_sell_claim_id is null
       or nullif(btrim(coalesce(p_bot_tx_sig, '')), '') is null then
      return jsonb_build_object(
        'ok', false, 'reason', 'prepared_sell_evidence_required'
      );
    end if;
    select * into v_sell_claim
    from public.sell_signal_claims c
    where c.id = p_sell_claim_id and c.user_id = p_user_id
    for update;
    if not found
       or v_sell_claim.position_id <> v_intent.position_id
       or v_sell_claim.source_tx_sig <> v_source_tx_sig
       or v_sell_claim.source_wallet <> v_source_wallet
       or v_sell_claim.trigger_kind <> v_expected_trigger
       or v_sell_claim.bot_tx_sig is distinct from btrim(p_bot_tx_sig)
       or v_sell_claim.recovery_version is distinct from 1
       or nullif(btrim(coalesce(v_sell_claim.recent_blockhash, '')), '') is null
       or v_sell_claim.last_valid_block_height is null
       or v_sell_claim.last_valid_block_height <= 0
       or v_sell_claim.executed_sell_amount_raw is null
       or v_sell_claim.prepared_wallet_balance_raw is null
       or v_sell_claim.position_amount_before_raw is null
       or v_sell_claim.token_decimals is null then
      return jsonb_build_object('ok', false, 'reason', 'sell_claim_evidence_mismatch');
    end if;
    if v_expected = 'claimed' and v_disposition = 'uncertain'
       and v_sell_claim.status not in ('submitted', 'uncertain', 'landed') then
      return jsonb_build_object('ok', false, 'reason', 'sell_claim_not_uncertain');
    end if;
    if v_expected = 'uncertain' and v_disposition = 'retry'
       and v_sell_claim.status <> 'failed_pre_submit' then
      return jsonb_build_object('ok', false, 'reason', 'sell_claim_retry_not_proven');
    end if;
    if v_disposition = 'resolved'
       and (
         v_sell_claim.status <> 'landed'
         or v_sell_claim.trade_id is null
         or v_sell_claim.persisted_at is null
         or v_sell_claim.receipt_pre_amount_raw is null
         or v_sell_claim.receipt_post_amount_raw is null
       ) then
      return jsonb_build_object('ok', false, 'reason', 'sell_claim_not_landed_exact');
    end if;
  end if;

  if v_expected = 'uncertain' and v_disposition = 'resolved'
     and (
       v_intent.sell_claim_id is null
       or nullif(btrim(coalesce(v_intent.bot_tx_sig, '')), '') is null
       or p_sell_claim_id is distinct from v_intent.sell_claim_id
       or nullif(btrim(coalesce(p_bot_tx_sig, '')), '')
         is distinct from v_intent.bot_tx_sig
     ) then
    -- Reconciliation may confirm only the exact durable prepared sell that
    -- put this intent into uncertain.  A caller cannot substitute a different
    -- claim or signature while marking the original attempt resolved.
    return jsonb_build_object(
      'ok', false, 'reason', 'resolution_evidence_mismatch'
    );
  end if;

  if v_disposition = 'entry_failed' then
    select * into v_entry_claim
    from public.entry_signal_claims c
    where c.id = v_intent.entry_claim_id and c.user_id = p_user_id;
    if not found or v_entry_claim.status <> 'failed_pre_submit' then
      return jsonb_build_object('ok', false, 'reason', 'entry_failure_not_proven');
    end if;
  elsif v_disposition = 'position_closed' then
    select * into v_position
    from public.positions p
    where p.id = v_intent.position_id and p.user_id = p_user_id;
    if not found or (
      v_position.closed_at is null
      and coalesce(v_position.amount_remaining_raw, '') <> '0'
    ) then
      return jsonb_build_object('ok', false, 'reason', 'closed_position_not_proven');
    end if;
  elsif v_disposition = 'disabled_by_policy' then
    select * into v_config
    from public.bot_config c where c.user_id = p_user_id;
    if not found or not (
      (v_intent.trigger_kind = 'direct_target_sell'
        and v_config.direct_target_sell_exit_mode = 'off')
      or (v_intent.trigger_kind = 'mirror_custody_sell'
        and coalesce(
          (to_jsonb(v_config) ->> 'mirror_custody_sell_exit_enabled')::boolean,
          false
        ) is not true)
      or (v_intent.trigger_kind = 'terminal_outflow' and v_source_is_root
        and v_config.target_terminal_outflow_exit_enabled is not true)
      or (v_intent.trigger_kind = 'terminal_outflow' and not v_source_is_root
        and v_config.terminal_outflow_exit_enabled is not true)
    ) then
      return jsonb_build_object('ok', false, 'reason', 'disabled_policy_not_proven');
    end if;
  end if;

  v_status := case
    when v_disposition = 'resolved' then 'resolved'
    -- A sell may be observed after entry submission but before the planned
    -- position is persisted.  Mere position absence is not proof that the buy
    -- failed, so it must remain retryable rather than permanently dismissed.
    when v_disposition in (
      'retry', 'position_not_live', 'duplicate_sell_claim'
    ) then 'retry'
    when v_disposition = 'uncertain' then 'uncertain'
    when v_disposition in (
      'disabled_by_policy', 'entry_failed', 'position_closed'
    ) then 'dismissed'
    else 'dismissed'
  end;
  update public.custody_fresh_tail_exit_intents set
    status = v_status,
    disposition = v_disposition,
    claim_token = case when v_status = 'uncertain' then claim_token else null end,
    claim_expires_at = case
      when v_status = 'uncertain' then claim_expires_at else null end,
    sell_claim_id = case
      when v_expected = 'uncertain' and v_disposition = 'resolved'
      then sell_claim_id else p_sell_claim_id end,
    bot_tx_sig = case
      when v_expected = 'uncertain' and v_disposition = 'resolved'
      then bot_tx_sig else nullif(btrim(coalesce(p_bot_tx_sig, '')), '') end,
    error_code = nullif(btrim(coalesce(p_error_code, '')), ''),
    resolved_at = case when v_status in ('resolved', 'dismissed') then now() else null end,
    updated_at = now()
  where id = p_intent_id
  returning * into v_intent;

  return jsonb_build_object(
    'ok', true, 'reason', 'intent_resolved', 'intentId', v_intent.id,
    'status', v_intent.status, 'disposition', v_intent.disposition,
    'claimGeneration', v_intent.claim_generation
  );
end;
$$;

create or replace function public.check_supply_accumulation_fresh_custody_gate(
  p_user_id uuid,
  p_token_mint text,
  p_window_started_at timestamptz,
  p_trigger_event_key text,
  p_trigger_tx_sig text,
  p_trigger_slot bigint,
  p_target_wallet text,
  p_epoch_id uuid,
  p_request_id uuid,
  p_claim_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_request public.custody_fresh_tail_requests%rowtype;
  v_mint public.custody_fresh_tail_mints%rowtype;
  v_trigger public.custody_fresh_tail_supply_events%rowtype;
  v_heartbeat public.custody_fresh_tail_worker_heartbeat%rowtype;
  v_config public.bot_config%rowtype;
  v_mint_text text := btrim(coalesce(p_token_mint, ''));
  v_event_key text := btrim(coalesce(p_trigger_event_key, ''));
  v_sig text := btrim(coalesce(p_trigger_tx_sig, ''));
  v_target text := btrim(coalesce(p_target_wallet, ''));
  v_config_roots text[];
  v_net_raw numeric(78, 0);
  v_net_pct numeric;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;
  if p_user_id is null or p_epoch_id is null or p_request_id is null
     or v_mint_text = '' or v_event_key = '' or v_sig = '' or v_target = ''
     or p_window_started_at is null or p_trigger_slot is null
     or p_trigger_slot < 0 then
    return jsonb_build_object('safe', false, 'reason', 'invalid_request');
  end if;
  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(v_mint_text));
  select * into v_epoch
  from public.custody_fresh_tail_epochs
  where id = p_epoch_id and user_id = p_user_id;
  if not found or v_epoch.status <> 'active' then
    return jsonb_build_object('safe', false, 'reason', 'epoch_not_active');
  end if;
  if v_epoch.lease_token is null or v_epoch.lease_owner is null
     or v_epoch.lease_expires_at is null
     or v_epoch.lease_expires_at <= clock_timestamp() then
    return jsonb_build_object('safe', false, 'reason', 'fresh_tail_monitor_stale');
  end if;
  select * into v_request
  from public.custody_fresh_tail_requests
  where id = p_request_id and epoch_id = p_epoch_id and user_id = p_user_id;
  if not found or v_request.status <> 'settled'
     or v_request.expires_at <= clock_timestamp()
     or v_request.settled_at is null
     or v_request.settled_at < clock_timestamp() - interval '4 seconds'
     or v_request.settled_at > clock_timestamp() then
    return jsonb_build_object('safe', false, 'reason', 'settlement_not_fresh');
  end if;
  if v_request.settled_lease_generation is distinct from v_epoch.lease_generation then
    return jsonb_build_object('safe', false, 'reason', 'settlement_lease_fenced');
  end if;
  select * into v_heartbeat
  from public.custody_fresh_tail_worker_heartbeat
  where user_id = p_user_id and epoch_id = p_epoch_id;
  if not found
     or v_heartbeat.worker_id is distinct from v_epoch.lease_owner
     or v_heartbeat.lease_token is distinct from v_epoch.lease_token
     or v_heartbeat.lease_generation is distinct from v_epoch.lease_generation
     or v_heartbeat.lease_expires_at <= clock_timestamp()
     or v_heartbeat.enabled is not true
     or v_heartbeat.shadow is not false
     or v_heartbeat.updated_at < clock_timestamp() - interval '4 seconds'
     or v_heartbeat.last_success_at is null
     or v_heartbeat.last_success_at < clock_timestamp() - interval '4 seconds'
     or v_heartbeat.last_success_at > clock_timestamp()
     or v_heartbeat.last_error is not null
     or v_heartbeat.root_required_count <> 3
     or v_heartbeat.root_covered_count <> 3
     or v_heartbeat.root_backlog_count <> 0
     or v_heartbeat.latest_head_slot < v_request.requested_head_slot then
    return jsonb_build_object('safe', false, 'reason', 'fresh_tail_worker_not_live');
  end if;
  if v_request.token_mint <> v_mint_text
     or v_request.window_started_at <> p_window_started_at
     or v_request.trigger_event_key <> v_event_key
     or v_request.trigger_tx_sig <> v_sig
     or v_request.trigger_slot <> p_trigger_slot
     or v_request.trigger_target_wallet <> v_target then
    return jsonb_build_object('safe', false, 'reason', 'request_identity_mismatch');
  end if;
  select * into v_mint
  from public.custody_fresh_tail_mints
  where epoch_id = p_epoch_id and user_id = p_user_id and token_mint = v_mint_text;
  if not found or v_mint.status <> 'active' or v_mint.poisoned
     or v_mint.creation_slot <= v_epoch.activation_slot
     or v_request.scope_revision <> v_mint.scope_revision
     or v_request.settled_revision <> v_mint.scope_revision
     or v_request.head_snapshot_parser_abi_fingerprint <>
       '2f5de97b6527d4ec94082069d65abd2bf30523e45bf562aabe1e770e5eb4ad1d'
     or v_request.head_curve_observed_slot <> v_request.requested_head_slot
     or v_request.head_curve_complete
     or v_request.head_curve_state_fingerprint !~ '^[0-9a-f]{64}$'
     or v_request.head_virtual_token_reserves_raw <= 0
     or v_request.head_virtual_sol_reserves_lamports <= 0
     or v_request.head_real_token_reserves_raw <= 0
     or v_request.head_real_sol_reserves_lamports < 0
     or v_request.head_curve_total_supply_raw <> v_mint.total_supply_raw
     or v_request.head_mint_layout_fingerprint <> v_mint.mint_layout_fingerprint
     or v_request.head_token_program <> v_mint.token_program
     or v_request.head_mint_supply_raw <> v_mint.total_supply_raw
     or v_request.head_mint_decimals <> v_mint.decimals then
    return jsonb_build_object('safe', false, 'reason', 'mint_or_revision_invalid');
  end if;
  if exists (
    select 1 from public.custody_fresh_tail_mint_rejections
    where epoch_id = p_epoch_id and token_mint = v_mint_text
  ) then
    return jsonb_build_object('safe', false, 'reason', 'mint_tombstoned');
  end if;

  select * into v_config from public.bot_config where user_id = p_user_id;
  if not found or v_config.enabled is not true
     or v_config.supply_accumulation_mode_enabled is not true
     or v_config.custody_journey_enabled is not true
     or v_config.direct_target_sell_exit_mode = 'proportional' then
    return jsonb_build_object('safe', false, 'reason', 'strategy_not_enabled');
  end if;
  if v_config.supply_accumulation_window_seconds is null
     or p_window_started_at <> v_request.trigger_block_time - make_interval(
       secs => v_config.supply_accumulation_window_seconds
     ) then
    return jsonb_build_object('safe', false, 'reason', 'window_identity_mismatch');
  end if;
  select array_agg(v order by v) into v_config_roots
  from (
    select distinct btrim(wallet) as v
    from unnest(array_remove(array_prepend(
      nullif(btrim(v_config.target_wallet), ''),
      coalesce(v_config.additional_target_wallets, array[]::text[])
    ), null)) wallet
    where nullif(btrim(wallet), '') is not null
  ) configured;
  if coalesce(cardinality(v_config_roots), 0) <> 3
     or v_config_roots is distinct from v_epoch.root_wallets then
    return jsonb_build_object('safe', false, 'reason', 'configured_roots_changed');
  end if;

  select * into v_trigger
  from public.custody_fresh_tail_supply_events
  where id = v_request.trigger_supply_event_id and epoch_id = p_epoch_id;
  if not found or v_trigger.event_key <> v_event_key
     or v_trigger.tx_sig <> v_sig or v_trigger.slot <> p_trigger_slot
     or v_trigger.target_wallet <> v_target or v_trigger.token_mint <> v_mint_text
     or v_trigger.side <> 'buy' or v_trigger.quarantined
     or not v_trigger.market_data_reliable or not v_trigger.pump_fun_verified
     or not v_trigger.classification_reliable
     or v_trigger.total_supply_raw <> v_mint.total_supply_raw
     or v_trigger.decimals <> v_mint.decimals
     or not public.is_custody_fresh_tail_parser_reviewed(
       v_trigger.parser_domain, v_trigger.parser_abi_fingerprint
     )
     or v_trigger.market_cap_usd is null
     or v_trigger.market_cap_usd < v_config.supply_accumulation_min_market_cap_usd
     or v_trigger.market_cap_usd >= v_config.supply_accumulation_max_market_cap_usd
     or exists (
       select 1 from public.custody_fresh_tail_supply_events later
       where later.epoch_id = p_epoch_id and later.token_mint = v_mint_text
         and later.side = 'buy'
         and (later.slot > p_trigger_slot
           or (later.slot = p_trigger_slot and later.event_key <> v_event_key))
         and later.slot <= v_request.requested_head_slot
     ) then
    return jsonb_build_object('safe', false, 'reason', 'trigger_not_exact_latest_buy');
  end if;

  select greatest(0, coalesce(sum(case
    when e.side = 'buy' then e.amount_raw else -e.amount_raw end), 0))
  into v_net_raw
  from public.custody_fresh_tail_supply_events e
  where e.epoch_id = p_epoch_id and e.token_mint = v_mint_text
    and e.block_time >= p_window_started_at
    and e.block_time <= v_request.trigger_block_time
    and e.slot > v_epoch.activation_slot and e.slot <= p_trigger_slot
    and e.target_wallet = any(v_epoch.root_wallets)
    and not e.quarantined and e.classification_reliable and e.pump_fun_verified
    and e.total_supply_raw = v_mint.total_supply_raw
    and e.decimals = v_mint.decimals
    and public.is_custody_fresh_tail_parser_reviewed(
      e.parser_domain, e.parser_abi_fingerprint
    );
  v_net_pct := (v_net_raw * 100) / v_mint.total_supply_raw;
  if v_net_pct < v_config.supply_accumulation_threshold_pct then
    return jsonb_build_object('safe', false, 'reason', 'fresh_threshold_not_reached');
  end if;

  if exists (
    select 1 from public.custody_fresh_tail_supply_events e
    where e.epoch_id = p_epoch_id and e.token_mint = v_mint_text
      and e.slot <= v_request.requested_head_slot
      and (e.side = 'sell' or e.quarantined or not e.classification_reliable
        or not e.pump_fun_verified
        or not public.is_custody_fresh_tail_parser_reviewed(
          e.parser_domain, e.parser_abi_fingerprint
        ))
  ) or exists (
    select 1 from public.custody_fresh_tail_custody_events e
    where e.epoch_id = p_epoch_id and e.token_mint = v_mint_text
      and e.slot <= v_request.requested_head_slot
      and (e.event_kind in ('SELL', 'UNRESOLVED_OUTFLOW', 'TERMINAL_OUTFLOW')
        or e.quarantined or e.classification_pending or e.terminal_poison
        or not e.classification_reliable
        or not public.is_custody_fresh_tail_parser_reviewed(
          e.parser_domain, e.parser_abi_fingerprint
        ))
  ) then
    return jsonb_build_object('safe', false, 'reason', 'fresh_sell_or_poison_seen');
  end if;
  if not exists (
    select 1 from public.custody_fresh_tail_custody_events e
    where e.epoch_id = p_epoch_id and e.token_mint = v_mint_text
      and e.event_kind = 'TARGET_BUY' and e.tx_sig = v_sig
      and e.slot = p_trigger_slot and e.source_wallet = v_target
      and not e.quarantined and e.classification_reliable
      and public.is_custody_fresh_tail_parser_reviewed(
        e.parser_domain, e.parser_abi_fingerprint
      )
  ) then
    return jsonb_build_object('safe', false, 'reason', 'fresh_target_buy_missing');
  end if;
  if not exists (
    select 1
    from public.custody_fresh_tail_supply_events s
    join public.custody_fresh_tail_custody_events c
      on c.epoch_id = s.epoch_id and c.token_mint = s.token_mint
     and c.tx_sig = s.tx_sig and c.slot = s.slot
     and c.source_wallet = s.target_wallet and c.amount_raw = s.amount_raw
    where s.epoch_id = p_epoch_id and s.token_mint = v_mint_text
      and s.event_key = v_mint.enrollment_event_key
      and s.tx_sig = v_mint.enrollment_tx_sig
      and s.slot = v_mint.enrollment_slot
      and s.block_time = v_mint.enrollment_block_time
      and s.target_wallet = v_mint.enrollment_target_wallet
      and s.side = 'buy' and c.event_kind = 'TARGET_BUY'
      and not s.quarantined and not c.quarantined
      and s.classification_reliable and c.classification_reliable
      and s.pump_fun_verified
      and public.is_custody_fresh_tail_parser_reviewed(
        s.parser_domain, s.parser_abi_fingerprint
      )
      and public.is_custody_fresh_tail_parser_reviewed(
        c.parser_domain, c.parser_abi_fingerprint
      )
  ) then
    return jsonb_build_object('safe', false, 'reason', 'enrollment_evidence_missing');
  end if;
  if exists (
    select 1 from public.custody_fresh_tail_edges e
    where e.epoch_id = p_epoch_id and e.token_mint = v_mint_text
      and e.applied_revision is null
  ) then
    return jsonb_build_object('safe', false, 'reason', 'scope_not_fixed_point');
  end if;

  if exists (
    select 1 from public.custody_fresh_tail_roots r
    left join public.custody_fresh_tail_cursors c
      on c.epoch_id = r.epoch_id and c.scope_mint = '*' and c.wallet = r.wallet
    where r.epoch_id = p_epoch_id
      and (c.wallet is null or c.backlog_detected or not c.history_floor_proven
        or not exists (
          select 1 from public.custody_fresh_tail_coverage_attestations a
          where a.epoch_id = p_epoch_id and a.lane_kind = 'main'
            and a.scope_mint = '*' and a.wallet = r.wallet
            and a.covered_head_slot = v_request.requested_head_slot
            and a.covered_head_blockhash = v_request.requested_head_blockhash
            and a.coverage_revision = 0
            and a.lease_generation = v_request.settled_lease_generation
        ))
  ) or exists (
    select 1 from public.custody_fresh_tail_wallets w
    left join public.custody_fresh_tail_cursors c
      on c.epoch_id = w.epoch_id and c.scope_mint = w.token_mint
     and c.wallet = w.wallet
    where w.epoch_id = p_epoch_id and w.token_mint = v_mint_text
      and (w.watch_status <> 'active' or c.wallet is null
        or c.backlog_detected or not c.history_floor_proven
        or c.coverage_revision <> v_mint.scope_revision
        or not exists (
          select 1 from public.custody_fresh_tail_coverage_attestations a
          where a.epoch_id = p_epoch_id and a.lane_kind = 'main'
            and a.scope_mint = v_mint_text and a.wallet = w.wallet
            and a.covered_head_slot = v_request.requested_head_slot
            and a.covered_head_blockhash = v_request.requested_head_blockhash
            and a.coverage_revision = v_mint.scope_revision
            and a.lease_generation = v_request.settled_lease_generation
        ))
  ) or exists (
    select 1 from public.custody_fresh_tail_backscan_ranges r
    where r.epoch_id = p_epoch_id and r.token_mint = v_mint_text
      and (r.backlog_detected or not r.history_floor_proven
        or r.coverage_revision <> v_mint.scope_revision
        or not exists (
          select 1 from public.custody_fresh_tail_coverage_attestations a
          where a.epoch_id = p_epoch_id and a.lane_kind = 'backscan'
            and a.range_id = r.id
            and a.covered_head_slot = v_request.requested_head_slot
            and a.covered_head_blockhash = v_request.requested_head_blockhash
            and a.coverage_revision = v_mint.scope_revision
            and a.lease_generation = v_request.settled_lease_generation
        ))
  ) then
    return jsonb_build_object('safe', false, 'reason', 'coverage_certificate_invalid');
  end if;

  if exists (
    select 1 from public.custody_pending_events p
    where p.user_id = p_user_id and p.token_mint = v_mint_text
      and p.event_at >= v_epoch.activation_block_time
      and (p.status in ('expired', 'terminal')
        or coalesce(p.last_error_code, '') = 'payload_mismatch')
  ) or exists (
    select 1 from public.custody_journeys j
    where j.user_id = p_user_id and j.token_mint = v_mint_text
      and j.status = 'active'
      and (j.first_event_key <> v_mint.enrollment_event_key
        or j.total_unresolved_outflow_tokens > 0)
  ) then
    return jsonb_build_object('safe', false, 'reason', 'legacy_poison_seen');
  end if;

  if p_claim_id is not null and not exists (
    select 1 from public.entry_signal_claims c
    where c.id = p_claim_id and c.user_id = p_user_id
      -- The final gate runs from executor.beforeSubmit only after the exact
      -- locally signed transaction has been persisted by onPrepared.  A merely
      -- claimed row is not submission authority and must never pass here.
      and c.status = 'submitted'
      and c.entry_strategy = 'supply_accumulation'
      and c.entry_mode = 'regular'
      and c.token_mint = v_mint_text and c.source_tx_sig = v_sig
      and c.source_wallet = v_target and c.source_slot = p_trigger_slot
      and c.planned_position_id is not null
      and c.amount_lamports > 0
      and c.planned_buy_usd > 0
      and c.token_decimals = v_mint.decimals
      and nullif(btrim(coalesce(c.bot_tx_sig, '')), '') is not null
      and c.submission_started_at is not null
      and c.last_valid_block_height is not null
      and c.last_valid_block_height > 0
      and c.error_code is null
      and c.landed_at is null and c.persisted_at is null
      and c.fresh_tail_epoch_id = p_epoch_id
      and c.fresh_tail_request_id = p_request_id
      and c.fresh_tail_monitoring_armed_at is not null
      and c.fresh_tail_monitoring_armed_at <= c.submission_started_at
  ) then
    return jsonb_build_object('safe', false, 'reason', 'claim_not_bound');
  end if;

  return jsonb_build_object(
    'safe', true, 'reason', 'fresh_custody_safe',
    'epochId', p_epoch_id, 'requestId', p_request_id,
    'tokenMint', v_mint_text, 'triggerEventKey', v_event_key,
    'txSig', v_sig, 'slot', p_trigger_slot,
    'triggerBlockTime', v_request.trigger_block_time,
    'targetWallet', v_target, 'expiresAt', v_request.expires_at,
    'requestedHeadSlot', v_request.requested_head_slot,
    'requestedHeadBlockhash', v_request.requested_head_blockhash,
    'requestedHeadBlockTime', v_request.requested_head_block_time,
    'headSnapshotParserAbiFingerprint',
      v_request.head_snapshot_parser_abi_fingerprint,
    'headCurveStateFingerprint', v_request.head_curve_state_fingerprint,
    'headCurveObservedSlot', v_request.head_curve_observed_slot,
    'headCurveComplete', v_request.head_curve_complete,
    'headVirtualTokenReservesRaw', v_request.head_virtual_token_reserves_raw::text,
    'headVirtualSolReservesLamports', v_request.head_virtual_sol_reserves_lamports::text,
    'headRealTokenReservesRaw', v_request.head_real_token_reserves_raw::text,
    'headRealSolReservesLamports', v_request.head_real_sol_reserves_lamports::text,
    'headCurveTotalSupplyRaw', v_request.head_curve_total_supply_raw::text,
    'headMintLayoutFingerprint', v_request.head_mint_layout_fingerprint,
    'headTokenProgram', v_request.head_token_program,
    'headMintSupplyRaw', v_request.head_mint_supply_raw::text,
    'headMintDecimals', v_request.head_mint_decimals,
    'scopeRevision', v_request.scope_revision,
    'settledRevision', v_request.settled_revision,
    'settledLeaseGeneration', v_request.settled_lease_generation,
    'proofObservedAt', v_request.settled_at
  ) || jsonb_build_object(
    'amountRaw', v_trigger.amount_raw::text,
    'decimals', v_mint.decimals,
    'totalSupplyRaw', v_mint.total_supply_raw::text,
    'netAcquiredRaw', v_net_raw::text,
    'netSupplyPct', v_net_pct,
    'thresholdPct', v_config.supply_accumulation_threshold_pct,
    'rootWallets', v_epoch.root_wallets,
    'windowStartedAt', p_window_started_at,
    'marketCapUsd', v_trigger.market_cap_usd,
    'minMarketCapUsd', v_config.supply_accumulation_min_market_cap_usd,
    'maxMarketCapUsd', v_config.supply_accumulation_max_market_cap_usd,
    'createVariant', v_mint.create_variant,
    'tokenProgram', v_mint.token_program,
    'bondingCurve', v_mint.bonding_curve,
    'creator', v_mint.creator,
    'mintLayoutFingerprint', v_mint.mint_layout_fingerprint,
    'creationParserAbiFingerprint', v_mint.parser_abi_fingerprint,
    'eventParserDomain', v_trigger.parser_domain,
    'eventParserAbiFingerprint', v_trigger.parser_abi_fingerprint,
    'monitorLeaseOwner', v_epoch.lease_owner,
    'monitorLeaseGeneration', v_epoch.lease_generation,
    'monitorLeaseExpiresAt', v_epoch.lease_expires_at
  );
end;
$$;

create or replace function public.get_custody_fresh_tail_entry_candidates(
  p_user_id uuid,
  p_limit integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_candidates jsonb := '[]'::jsonb;
  v_request public.custody_fresh_tail_requests%rowtype;
  v_result jsonb;
  v_count integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;
  if p_user_id is null or p_limit is null or p_limit not between 1 and 100 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_candidate_request');
  end if;

  -- Gate calls take per-mint advisory locks.  Walking requests in a stable
  -- order prevents two candidate pollers from acquiring those locks in
  -- opposite order.
  for v_request in
    select q.*
    from public.custody_fresh_tail_requests q
    where q.user_id = p_user_id and q.status = 'settled'
      and q.expires_at > clock_timestamp()
      and q.settled_at >= clock_timestamp() - interval '4 seconds'
      and not exists (
        select 1 from public.entry_signal_claims c
        where c.fresh_tail_request_id = q.id
      )
    order by q.trigger_block_time, q.id
  loop
    v_result := public.check_supply_accumulation_fresh_custody_gate(
      v_request.user_id, v_request.token_mint, v_request.window_started_at,
      v_request.trigger_event_key, v_request.trigger_tx_sig,
      v_request.trigger_slot, v_request.trigger_target_wallet,
      v_request.epoch_id, v_request.id, null
    );
    if v_result->>'safe' = 'true' then
      v_candidates := v_candidates || jsonb_build_array(v_result);
      v_count := v_count + 1;
      exit when v_count >= p_limit;
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true, 'reason', 'loaded', 'candidates', v_candidates,
    'observedAt', clock_timestamp()
  );
end;
$$;

-- Every SECURITY DEFINER routine in this isolated namespace is service-only.
do $$
declare
  v_function record;
begin
  for v_function in
    select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'assert_custody_fresh_tail_lease',
        'attest_custody_fresh_tail_finalized_head',
        'is_custody_fresh_tail_parser_reviewed',
        'activate_custody_fresh_tail_epoch',
        'get_custody_fresh_tail_active_epoch',
        'acquire_custody_fresh_tail_lease',
        'record_custody_fresh_tail_heartbeat',
        'get_custody_fresh_tail_work',
        'get_custody_fresh_tail_retirement_candidates',
        'reject_custody_fresh_tail_mint',
        'attest_custody_fresh_tail_mint_creation',
        'record_custody_fresh_tail_supply_event',
        'record_custody_fresh_tail_custody_event',
        'sync_custody_fresh_tail_scope',
        'retire_custody_fresh_tail_mint',
        'request_custody_fresh_tail_coverage',
        'record_custody_fresh_tail_cursor',
        'record_custody_fresh_tail_backscan_cursor',
        'settle_custody_fresh_tail_request',
        'bind_supply_entry_claim_fresh_tail',
        'record_supply_entry_claim_fresh_tail_receipt',
        'claim_custody_fresh_tail_exit_intents',
        'claim_custody_fresh_tail_uncertain_intents',
        'resolve_custody_fresh_tail_exit_intent',
        'check_supply_accumulation_fresh_custody_gate',
        'get_custody_fresh_tail_entry_candidates'
      )
  loop
    execute format(
      'revoke all on function %I.%I(%s) from public, anon, authenticated',
      v_function.nspname, v_function.proname, v_function.args
    );
    execute format(
      'grant execute on function %I.%I(%s) to service_role',
      v_function.nspname, v_function.proname, v_function.args
    );
  end loop;
end $$;

-- Fail the transaction if a dependency was accidentally reordered, an
-- identifier would be truncated, or an RPC was omitted from the install.
do $$
declare
  v_missing text[];
begin
  select array_agg(name order by name) into v_missing
  from unnest(array[
    'custody_fresh_tail_epochs', 'custody_fresh_tail_roots',
    'custody_fresh_tail_finalized_heads',
    'custody_fresh_tail_mints', 'custody_fresh_tail_mint_rejections',
    'custody_fresh_tail_supply_events', 'custody_fresh_tail_custody_events',
    'custody_fresh_tail_edges', 'custody_fresh_tail_wallets',
    'custody_fresh_tail_requests', 'custody_fresh_tail_cursors',
    'custody_fresh_tail_backscan_ranges',
    'custody_fresh_tail_coverage_attestations',
    'custody_fresh_tail_exit_intents',
    'custody_fresh_tail_worker_heartbeat'
  ]) name
  where to_regclass('public.' || name) is null;
  if v_missing is not null then
    raise exception 'fresh-tail table verification failed: %', v_missing;
  end if;

  select array_agg(name order by name) into v_missing
  from unnest(array[
    'assert_custody_fresh_tail_lease',
    'attest_custody_fresh_tail_finalized_head',
    'is_custody_fresh_tail_parser_reviewed',
    'activate_custody_fresh_tail_epoch',
    'get_custody_fresh_tail_active_epoch',
    'acquire_custody_fresh_tail_lease',
    'record_custody_fresh_tail_heartbeat',
    'get_custody_fresh_tail_work',
    'get_custody_fresh_tail_retirement_candidates',
    'reject_custody_fresh_tail_mint',
    'attest_custody_fresh_tail_mint_creation',
    'record_custody_fresh_tail_supply_event',
    'record_custody_fresh_tail_custody_event',
    'sync_custody_fresh_tail_scope',
    'retire_custody_fresh_tail_mint',
    'request_custody_fresh_tail_coverage',
    'record_custody_fresh_tail_cursor',
    'record_custody_fresh_tail_backscan_cursor',
    'settle_custody_fresh_tail_request',
    'bind_supply_entry_claim_fresh_tail',
    'record_supply_entry_claim_fresh_tail_receipt',
    'claim_custody_fresh_tail_exit_intents',
    'claim_custody_fresh_tail_uncertain_intents',
    'resolve_custody_fresh_tail_exit_intent',
    'check_supply_accumulation_fresh_custody_gate',
    'get_custody_fresh_tail_entry_candidates'
  ]) name
  where not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = name
  );
  if v_missing is not null then
    raise exception 'fresh-tail function verification failed: %', v_missing;
  end if;

  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname like '%fresh_tail%'
      and char_length(c.relname) > 63
  ) or exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like '%fresh_tail%'
      and char_length(p.proname) > 63
  ) then
    raise exception 'fresh-tail identifier exceeds PostgreSQL 63-byte limit';
  end if;
end $$;

commit;

-- SUPPLY_ACCUMULATION_FRESH_TAIL_CANONICAL_MIRROR_END

-- SELL_CLAIM_RECOVERY_CANONICAL_MIRROR_BEGIN
-- Durable, replay-safe sell accounting.
--
-- Apply this migration before deploying the matching worker.  Legacy claims
-- remain readable, but only attempts prepared by the v1 RPC are eligible for
-- automatic chain reconciliation.

begin;

-- Canonical follower-owned token quantity.  NULL is deliberately meaningful:
-- legacy/UI-only positions have no provable raw provenance and must fail
-- closed.  Never backfill this from amount_remaining or a wallet snapshot.
alter table public.positions
  add column if not exists amount_remaining_raw text;

alter table public.positions
  drop constraint if exists positions_amount_remaining_raw_check;
alter table public.positions
  add constraint positions_amount_remaining_raw_check check (
    amount_remaining_raw is null
    or (
      amount_remaining_raw ~ '^[0-9]+$'
      and char_length(amount_remaining_raw) <= 78
    )
  ) not valid;

-- Fresh entry persistence owns the only safe seed for canonical raw position
-- accounting.  Existing persisted rows are intentionally not backfilled.
alter table public.entry_signal_claims
  add column if not exists received_amount_raw text;

alter table public.entry_signal_claims
  drop constraint if exists entry_signal_claims_received_amount_raw_check;
alter table public.entry_signal_claims
  add constraint entry_signal_claims_received_amount_raw_check check (
    received_amount_raw is null
    or (
      received_amount_raw ~ '^[1-9][0-9]*$'
      and char_length(received_amount_raw) <= 78
    )
  ) not valid;

create or replace function public.seed_supply_position_raw_from_entry()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_position public.positions%rowtype;
begin
  if new.entry_strategy is distinct from 'supply_accumulation'
     or new.status is distinct from 'persisted' then
    return new;
  end if;
  if new.received_amount_raw is null then
    -- Legacy Supply claims predate exact receipts. Keep their position raw
    -- provenance NULL so direct recovered exits fail closed; the separate
    -- fresh-tail claim constraint requires a receipt for every fresh entry.
    return new;
  end if;
  select * into v_position
  from public.positions p
  where p.id = new.planned_position_id
    and p.user_id = new.user_id
    and p.token_mint = new.token_mint
  for update;
  if not found then
    raise exception using errcode = '23503', message = 'Fresh Supply position is missing';
  end if;
  if coalesce(v_position.decimals, -1) <> coalesce(new.token_decimals, -2) then
    raise exception using errcode = '23514', message = 'Fresh Supply receipt decimals mismatch';
  end if;
  if v_position.amount_remaining_raw is null then
    update public.positions set amount_remaining_raw = new.received_amount_raw
    where id = v_position.id and user_id = new.user_id;
  elsif v_position.amount_remaining_raw is distinct from new.received_amount_raw then
    raise exception using errcode = '23514', message = 'Fresh Supply raw replay mismatch';
  end if;
  return new;
end $$;

drop trigger if exists seed_supply_position_raw_from_entry_trigger
  on public.entry_signal_claims;
create trigger seed_supply_position_raw_from_entry_trigger
after insert or update of status, received_amount_raw
on public.entry_signal_claims
for each row execute function public.seed_supply_position_raw_from_entry();

-- The deployed scale RPC updates the claim last in the same transaction.  An
-- AFTER trigger makes its exact receipt part of the same commit without
-- relying on its numeric/UI position update.  NULL legacy provenance aborts
-- and rolls back the entire scale application, including its trade row.
create or replace function public.increment_supply_position_raw_from_scale()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_position public.positions%rowtype;
  v_next_raw numeric;
begin
  if new.status is distinct from 'persisted'
     or new.applied_at is null
     or new.received_amount_raw is null
     or (old.status = 'persisted' and old.applied_at is not null) then
    return new;
  end if;
  select * into v_position
  from public.positions p
  where p.id = new.position_id
    and p.user_id = new.user_id
    and p.token_mint = new.token_mint
  for update;
  if not found then
    raise exception using errcode = '23503', message = 'Supply scale position is missing';
  end if;
  if v_position.amount_remaining_raw is null then
    raise exception using
      errcode = '23514',
      message = 'Supply scale blocked because exact position raw provenance is unavailable';
  end if;
  if coalesce(v_position.decimals, -1) <> new.token_decimals then
    raise exception using errcode = '23514', message = 'Supply scale receipt decimals mismatch';
  end if;
  v_next_raw := v_position.amount_remaining_raw::numeric
    + new.received_amount_raw::numeric;
  update public.positions set amount_remaining_raw = v_next_raw::text
  where id = v_position.id and user_id = new.user_id;
  return new;
end $$;

drop trigger if exists increment_supply_position_raw_from_scale_trigger
  on public.supply_accumulation_scale_claims;
create trigger increment_supply_position_raw_from_scale_trigger
after update of status, received_amount_raw, applied_at
on public.supply_accumulation_scale_claims
for each row execute function public.increment_supply_position_raw_from_scale();

alter table public.sell_signal_claims
  add column if not exists recovery_version smallint,
  add column if not exists token_decimals integer,
  add column if not exists executed_sell_amount_raw text,
  add column if not exists prepared_wallet_balance_raw text,
  add column if not exists position_amount_before_raw text,
  add column if not exists recent_blockhash text,
  add column if not exists last_valid_block_height bigint,
  add column if not exists receipt_pre_amount_raw text,
  add column if not exists receipt_post_amount_raw text,
  add column if not exists trade_id uuid references public.trades(id) on delete set null,
  add column if not exists exit_reason text,
  add column if not exists mark_tp_taken boolean not null default false,
  add column if not exists mark_coordinated_exit boolean not null default false,
  add column if not exists mark_follower_seller_exit boolean not null default false,
  add column if not exists mirrored_sold_fraction numeric,
  add column if not exists execution_route text,
  add column if not exists execution_latency_ms integer,
  add column if not exists persisted_at timestamptz;

alter table public.sell_signal_claims
  drop constraint if exists sell_signal_claims_recovery_v1_check;
alter table public.sell_signal_claims
  add constraint sell_signal_claims_recovery_v1_check check (
    recovery_version is null
    or (
      recovery_version = 1
      and token_decimals between 0 and 18
      and executed_sell_amount_raw ~ '^[1-9][0-9]*$'
      and char_length(executed_sell_amount_raw) <= 78
      and prepared_wallet_balance_raw ~ '^[1-9][0-9]*$'
      and char_length(prepared_wallet_balance_raw) <= 78
      and position_amount_before_raw ~ '^[1-9][0-9]*$'
      and char_length(position_amount_before_raw) <= 78
      and executed_sell_amount_raw::numeric <= prepared_wallet_balance_raw::numeric
      and executed_sell_amount_raw::numeric <= position_amount_before_raw::numeric
      and bot_tx_sig is not null
      and btrim(bot_tx_sig) <> ''
      and recent_blockhash is not null
      and btrim(recent_blockhash) <> ''
      and last_valid_block_height is not null
      and last_valid_block_height > 0
      and (execution_latency_ms is null or execution_latency_ms >= 0)
      and (execution_route is null or execution_route in ('jito', 'rpc'))
      and (mirrored_sold_fraction is null or mirrored_sold_fraction between 0 and 1)
      and (
        (receipt_pre_amount_raw is null and receipt_post_amount_raw is null)
        or (
          receipt_pre_amount_raw ~ '^[1-9][0-9]*$'
          and char_length(receipt_pre_amount_raw) <= 78
          and receipt_post_amount_raw ~ '^[0-9]+$'
          and char_length(receipt_post_amount_raw) <= 78
          and receipt_pre_amount_raw::numeric - receipt_post_amount_raw::numeric
            = executed_sell_amount_raw::numeric
        )
      )
      and (
        status <> 'landed'
        or (
          receipt_pre_amount_raw is not null
          and receipt_post_amount_raw is not null
          and trade_id is not null
          and landed_at is not null
          and persisted_at is not null
        )
      )
    )
  ) not valid;

-- A locally signed transaction can belong to only one durable sell claim.
create unique index if not exists sell_signal_claims_bot_signature_idx
  on public.sell_signal_claims (user_id, bot_tx_sig)
  where bot_tx_sig is not null;

-- Makes transaction-ledger replay deterministic. Existing duplicates make the
-- migration fail instead of silently choosing an accounting row.
create unique index if not exists trades_sell_signature_idx
  on public.trades (user_id, tx_sig)
  where side = 'sell';

create or replace function public.prepare_sell_claim_attempt_v1(
  p_user_id uuid,
  p_claim_id uuid,
  p_bot_tx_sig text,
  p_recent_blockhash text,
  p_last_valid_block_height bigint,
  p_executed_sell_amount_raw text,
  p_prepared_wallet_balance_raw text,
  p_position_amount_before_raw text,
  p_token_decimals integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_signature text := btrim(coalesce(p_bot_tx_sig, ''));
  v_blockhash text := btrim(coalesce(p_recent_blockhash, ''));
  v_sell_raw numeric;
  v_wallet_raw numeric;
  v_position_raw numeric;
  v_claim public.sell_signal_claims%rowtype;
  v_position public.positions%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;
  if p_user_id is null or p_claim_id is null
     or v_signature = '' or char_length(v_signature) > 128
     or v_blockhash = '' or char_length(v_blockhash) > 128
     or p_executed_sell_amount_raw is null
     or p_executed_sell_amount_raw !~ '^[1-9][0-9]*$'
     or char_length(p_executed_sell_amount_raw) > 78
     or p_prepared_wallet_balance_raw is null
     or p_prepared_wallet_balance_raw !~ '^[1-9][0-9]*$'
     or char_length(p_prepared_wallet_balance_raw) > 78
     or p_position_amount_before_raw is null
     or p_position_amount_before_raw !~ '^[1-9][0-9]*$'
     or char_length(p_position_amount_before_raw) > 78
     or p_token_decimals is null or p_token_decimals < 0 or p_token_decimals > 18
     or p_last_valid_block_height is null
     or p_last_valid_block_height <= 0 then
    return jsonb_build_object('prepared', false, 'reason', 'invalid_request');
  end if;
  v_sell_raw := p_executed_sell_amount_raw::numeric;
  v_wallet_raw := p_prepared_wallet_balance_raw::numeric;
  if v_sell_raw > v_wallet_raw then
    return jsonb_build_object('prepared', false, 'reason', 'sell_exceeds_wallet_balance');
  end if;

  select * into v_claim
  from public.sell_signal_claims c
  where c.id = p_claim_id and c.user_id = p_user_id;
  if not found then
    return jsonb_build_object('prepared', false, 'reason', 'claim_not_found');
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(
      'helix-position-action:' || p_user_id::text || ':' || v_claim.position_id::text,
      0
    )
  );
  select * into v_claim
  from public.sell_signal_claims c
  where c.id = p_claim_id and c.user_id = p_user_id
  for update;
  if v_claim.status <> 'claimed'
     or v_claim.bot_tx_sig is not null
     or v_claim.recovery_version is not null then
    return jsonb_build_object('prepared', false, 'reason', 'claim_changed');
  end if;

  select * into v_position
  from public.positions p
  where p.id = v_claim.position_id and p.user_id = p_user_id
  for update;
  if not found then
    return jsonb_build_object('prepared', false, 'reason', 'position_not_found');
  end if;
  if v_position.closed_at is not null then
    return jsonb_build_object('prepared', false, 'reason', 'position_not_open');
  end if;
  if coalesce(v_position.decimals, -1) <> p_token_decimals then
    return jsonb_build_object('prepared', false, 'reason', 'position_decimals_mismatch');
  end if;
  if v_position.amount_remaining_raw is null then
    return jsonb_build_object('prepared', false, 'reason', 'position_raw_unavailable');
  end if;
  v_position_raw := v_position.amount_remaining_raw::numeric;
  if v_position.amount_remaining_raw is distinct from p_position_amount_before_raw then
    return jsonb_build_object('prepared', false, 'reason', 'position_balance_changed');
  end if;
  if v_position_raw <= 0 or v_sell_raw > v_position_raw then
    return jsonb_build_object('prepared', false, 'reason', 'sell_exceeds_position_balance');
  end if;

  update public.sell_signal_claims set
    status = 'submitted',
    recovery_version = 1,
    bot_tx_sig = v_signature,
    recent_blockhash = v_blockhash,
    last_valid_block_height = p_last_valid_block_height,
    executed_sell_amount_raw = p_executed_sell_amount_raw,
    prepared_wallet_balance_raw = p_prepared_wallet_balance_raw,
    position_amount_before_raw = p_position_amount_before_raw,
    token_decimals = p_token_decimals,
    submission_started_at = now(),
    error_code = null,
    updated_at = now()
  where id = v_claim.id and user_id = p_user_id
    and status = 'claimed' and bot_tx_sig is null and recovery_version is null;
  if not found then
    raise exception using errcode = '40001', message = 'sell claim changed during preparation';
  end if;
  return jsonb_build_object(
    'prepared', true,
    'reason', 'attempt_prepared',
    'positionAmountBeforeRaw', v_position_raw::text
  );
end $$;

create or replace function public.apply_landed_sell_claim_v1(
  p_user_id uuid,
  p_claim_id uuid,
  p_bot_tx_sig text,
  p_sold_amount_raw text,
  p_receipt_pre_amount_raw text,
  p_receipt_post_amount_raw text,
  p_token_decimals integer,
  p_route text default null,
  p_latency_ms integer default null,
  p_exit_price_usd numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_signature text := btrim(coalesce(p_bot_tx_sig, ''));
  v_sold_raw numeric;
  v_pre_raw numeric;
  v_post_raw numeric;
  v_current_raw numeric;
  v_new_raw numeric;
  v_scale numeric;
  v_amount_tokens numeric;
  v_amount_usd numeric;
  v_pnl_pct numeric;
  v_trade_id uuid;
  v_claim public.sell_signal_claims%rowtype;
  v_position public.positions%rowtype;
  v_existing_trade public.trades%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;
  if p_user_id is null or p_claim_id is null or v_signature = ''
     or p_sold_amount_raw is null or p_sold_amount_raw !~ '^[1-9][0-9]*$'
     or char_length(p_sold_amount_raw) > 78
     or p_receipt_pre_amount_raw is null or p_receipt_pre_amount_raw !~ '^[1-9][0-9]*$'
     or char_length(p_receipt_pre_amount_raw) > 78
     or p_receipt_post_amount_raw is null or p_receipt_post_amount_raw !~ '^[0-9]+$'
     or char_length(p_receipt_post_amount_raw) > 78
     or p_token_decimals is null or p_token_decimals < 0 or p_token_decimals > 18
     or (p_route is not null and p_route not in ('jito', 'rpc'))
     or (p_latency_ms is not null and p_latency_ms < 0)
     or (p_exit_price_usd is not null and p_exit_price_usd <= 0) then
    return jsonb_build_object('applied', false, 'replay', false, 'reason', 'invalid_request');
  end if;
  v_sold_raw := p_sold_amount_raw::numeric;
  v_pre_raw := p_receipt_pre_amount_raw::numeric;
  v_post_raw := p_receipt_post_amount_raw::numeric;
  if v_pre_raw - v_post_raw <> v_sold_raw then
    return jsonb_build_object('applied', false, 'replay', false, 'reason', 'receipt_delta_mismatch');
  end if;

  select * into v_claim
  from public.sell_signal_claims c
  where c.id = p_claim_id and c.user_id = p_user_id;
  if not found then
    return jsonb_build_object('applied', false, 'replay', false, 'reason', 'claim_not_found');
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(
      'helix-position-action:' || p_user_id::text || ':' || v_claim.position_id::text,
      0
    )
  );
  select * into v_claim
  from public.sell_signal_claims c
  where c.id = p_claim_id and c.user_id = p_user_id
  for update;
  select * into v_position
  from public.positions p
  where p.id = v_claim.position_id and p.user_id = p_user_id
  for update;
  if not found then
    return jsonb_build_object('applied', false, 'replay', false, 'reason', 'position_not_found');
  end if;

  if v_claim.recovery_version is distinct from 1
     or v_claim.bot_tx_sig is distinct from v_signature
     or v_claim.executed_sell_amount_raw is distinct from p_sold_amount_raw
     or v_claim.token_decimals is distinct from p_token_decimals then
    return jsonb_build_object('applied', false, 'replay', false, 'reason', 'prepared_attempt_mismatch');
  end if;
  if v_claim.status = 'landed' then
    if v_claim.receipt_pre_amount_raw is distinct from p_receipt_pre_amount_raw
       or v_claim.receipt_post_amount_raw is distinct from p_receipt_post_amount_raw
       or v_claim.trade_id is null then
      return jsonb_build_object('applied', false, 'replay', false, 'reason', 'persisted_receipt_mismatch');
    end if;
    select * into v_existing_trade
    from public.trades t
    where t.id = v_claim.trade_id
      and t.user_id = p_user_id
      and t.position_id = v_claim.position_id
      and t.side = 'sell'
      and t.token_mint = v_position.token_mint
      and t.tx_sig = v_signature;
    if not found then
      return jsonb_build_object('applied', false, 'replay', false, 'reason', 'persisted_trade_mismatch');
    end if;
    if trunc(v_existing_trade.amount_tokens * power(10::numeric, p_token_decimals)) <> v_sold_raw
       or v_existing_trade.amount_tokens * power(10::numeric, p_token_decimals) <> v_sold_raw then
      return jsonb_build_object('applied', false, 'replay', false, 'reason', 'persisted_trade_mismatch');
    end if;
    return jsonb_build_object(
      'applied', false, 'replay', true, 'reason', 'already_applied',
      'closed', v_position.closed_at is not null,
      'amountRemaining', v_position.amount_remaining::text,
      'tradeId', v_claim.trade_id::text
    );
  end if;
  if v_position.token_mint is null or coalesce(v_position.decimals, -1) <> p_token_decimals then
    return jsonb_build_object('applied', false, 'replay', false, 'reason', 'position_identity_mismatch');
  end if;
  if v_position.closed_at is not null then
    return jsonb_build_object('applied', false, 'replay', false, 'reason', 'position_already_closed');
  end if;
  if v_claim.status not in ('submitted', 'uncertain') then
    return jsonb_build_object('applied', false, 'replay', false, 'reason', 'claim_not_applyable');
  end if;
  if exists (
    select 1 from public.trades t
    where t.user_id = p_user_id and t.side = 'sell' and t.tx_sig = v_signature
  ) then
    return jsonb_build_object('applied', false, 'replay', false, 'reason', 'sell_signature_already_recorded');
  end if;

  v_scale := power(10::numeric, p_token_decimals);
  if v_position.amount_remaining_raw is null then
    return jsonb_build_object('applied', false, 'replay', false, 'reason', 'position_raw_unavailable');
  end if;
  v_current_raw := v_position.amount_remaining_raw::numeric;
  if v_current_raw::text is distinct from v_claim.position_amount_before_raw then
    return jsonb_build_object('applied', false, 'replay', false, 'reason', 'position_balance_changed');
  end if;
  if v_sold_raw <= v_current_raw then
    v_new_raw := v_current_raw - v_sold_raw;
  else
    return jsonb_build_object('applied', false, 'replay', false, 'reason', 'sell_exceeds_position_balance');
  end if;
  v_amount_tokens := v_sold_raw / v_scale;
  v_amount_usd := case when p_exit_price_usd is null then null else v_amount_tokens * p_exit_price_usd end;
  v_pnl_pct := case
    when p_exit_price_usd is null or coalesce(v_position.entry_price_usd, 0) <= 0 then null
    else ((p_exit_price_usd - v_position.entry_price_usd) / v_position.entry_price_usd) * 100
  end;
  v_trade_id := gen_random_uuid();

  insert into public.trades (
    id, user_id, position_id, side, token_mint, amount_tokens, amount_usd,
    price_usd, pnl_pct, tx_sig, reason, latency_ms, route
  ) values (
    v_trade_id, p_user_id, v_position.id, 'sell', v_position.token_mint,
    v_amount_tokens, v_amount_usd, p_exit_price_usd, v_pnl_pct, v_signature,
    coalesce(nullif(v_claim.exit_reason, ''), 'durable recovered exit'),
    p_latency_ms, p_route
  );

  update public.positions set
    amount_remaining = v_new_raw / v_scale,
    amount_remaining_raw = v_new_raw::text,
    closed_at = case when v_new_raw = 0 then now() else null end,
    tp_taken = case when v_claim.mark_tp_taken then true else tp_taken end,
    coordinated_exit_triggered = case
      when v_claim.mark_coordinated_exit then true else coordinated_exit_triggered end,
    follower_seller_exit_triggered = case
      when v_claim.mark_follower_seller_exit then true else follower_seller_exit_triggered end,
    mirrored_sold_fraction = case
      when v_claim.mirrored_sold_fraction is null then mirrored_sold_fraction
      else greatest(coalesce(mirrored_sold_fraction, 0), v_claim.mirrored_sold_fraction)
    end
  where id = v_position.id and user_id = p_user_id;

  update public.sell_signal_claims set
    status = 'landed',
    receipt_pre_amount_raw = p_receipt_pre_amount_raw,
    receipt_post_amount_raw = p_receipt_post_amount_raw,
    trade_id = v_trade_id,
    execution_route = p_route,
    execution_latency_ms = p_latency_ms,
    error_code = null,
    landed_at = coalesce(landed_at, now()),
    persisted_at = now(),
    updated_at = now()
  where id = v_claim.id and user_id = p_user_id
    and status in ('submitted', 'uncertain')
    and bot_tx_sig = v_signature;
  if not found then
    raise exception using errcode = '40001', message = 'sell claim changed during atomic application';
  end if;

  return jsonb_build_object(
    'applied', true, 'replay', false, 'reason', 'sell_applied',
    'closed', v_new_raw = 0,
    'amountRemaining', (v_new_raw / v_scale)::text,
    'tradeId', v_trade_id::text
  );
end $$;

revoke all on function public.prepare_sell_claim_attempt_v1(
  uuid, uuid, text, text, bigint, text, text, text, integer
) from public, anon, authenticated;
grant execute on function public.prepare_sell_claim_attempt_v1(
  uuid, uuid, text, text, bigint, text, text, text, integer
) to service_role;

revoke all on function public.apply_landed_sell_claim_v1(
  uuid, uuid, text, text, text, text, integer, text, integer, numeric
) from public, anon, authenticated;
grant execute on function public.apply_landed_sell_claim_v1(
  uuid, uuid, text, text, text, text, integer, text, integer, numeric
) to service_role;

commit;
-- SELL_CLAIM_RECOVERY_CANONICAL_MIRROR_END
