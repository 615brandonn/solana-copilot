-- Helix sell-coverage reliability upgrade.
-- Additive and idempotent: no rows are deleted or rewritten.

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
