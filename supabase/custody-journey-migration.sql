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
