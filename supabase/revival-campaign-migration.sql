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
