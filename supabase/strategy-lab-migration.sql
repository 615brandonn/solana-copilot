-- Helix Strategy Lab: additive, replay-safe observation storage and insights.
-- Safe to run more than once. This migration never deletes observation data.

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
