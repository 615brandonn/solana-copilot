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
