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
