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
