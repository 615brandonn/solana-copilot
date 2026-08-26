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
