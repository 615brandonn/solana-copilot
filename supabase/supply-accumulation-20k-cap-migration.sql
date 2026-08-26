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
