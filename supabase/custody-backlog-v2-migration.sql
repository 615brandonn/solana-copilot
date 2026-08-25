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
