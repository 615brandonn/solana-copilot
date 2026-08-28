-- Supply Accumulation finalized fresh-tail custody proof.
--
-- This migration adds an isolated cursor namespace for new initial entries.
-- It never advances or resets a legacy cursor and never changes the existing
-- custody gate used by positions and scale buys.  The companion worker must
-- activate an epoch while Entries are OFF, then prove one common FINALIZED
-- head for all three roots and every mint-scoped descendant.

begin;

do $$
begin
  if to_regclass('public.bot_config') is null
     or to_regclass('public.entry_signal_claims') is null
     or to_regclass('public.positions') is null
     or to_regclass('public.custody_journeys') is null
     or to_regclass('public.custody_pending_events') is null
     or to_regprocedure(
       'public.check_supply_accumulation_custody_gate(uuid,text,timestamp with time zone,text,bigint,text)'
     ) is null
     or to_regprocedure('extensions.digest(text,text)') is null
     or to_regprocedure('extensions.digest(bytea,text)') is null
     or not exists (
       select 1
       from pg_attribute
       where attrelid = 'public.bot_config'::regclass
         and attname = 'supply_accumulation_min_market_cap_usd'
         and not attisdropped
     ) then
    raise exception using
      errcode = '42883',
      message = 'run the current Supply Accumulation, Custody Journey, and custody gate migrations first';
  end if;
end $$;

create table if not exists public.custody_fresh_tail_epochs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  status text not null default 'active'
    check (status in ('active', 'retired', 'invalidated')),
  activation_slot bigint not null check (activation_slot >= 0),
  activation_blockhash text not null check (char_length(btrim(activation_blockhash)) > 0),
  activation_block_time timestamptz not null,
  root_wallets text[] not null check (cardinality(root_wallets) = 3),
  root_fingerprint text not null check (char_length(root_fingerprint) = 64),
  scope_revision bigint not null default 0 check (scope_revision >= 0),
  lease_owner text,
  lease_token uuid,
  lease_generation bigint not null default 0 check (lease_generation >= 0),
  lease_expires_at timestamptz,
  invalid_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create unique index if not exists custody_fresh_tail_one_active_epoch_idx
  on public.custody_fresh_tail_epochs (user_id)
  where status = 'active';

create table if not exists public.custody_fresh_tail_roots (
  epoch_id uuid not null,
  user_id uuid not null,
  wallet text not null check (char_length(btrim(wallet)) > 0),
  ordinal integer not null check (ordinal between 1 and 3),
  floor_slot bigint not null check (floor_slot >= 0),
  boundary_kind text not null default 'exclusive_slot'
    check (boundary_kind = 'exclusive_slot'),
  created_at timestamptz not null default now(),
  primary key (epoch_id, wallet),
  unique (epoch_id, ordinal),
  foreign key (epoch_id, user_id)
    references public.custody_fresh_tail_epochs(id, user_id)
);

-- Exact finalized heads are sampled once by the leased observer.  Every event,
-- cursor certificate, creation proof, and request must reference one of these
-- immutable slot/hash/time observations.
create table if not exists public.custody_fresh_tail_finalized_heads (
  epoch_id uuid not null,
  user_id uuid not null,
  slot bigint not null check (slot >= 0),
  blockhash text not null check (char_length(btrim(blockhash)) > 0),
  block_time timestamptz not null,
  first_lease_generation bigint not null check (first_lease_generation >= 0),
  last_lease_generation bigint not null check (last_lease_generation >= 0),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (epoch_id, slot),
  foreign key (epoch_id, user_id)
    references public.custody_fresh_tail_epochs(id, user_id)
);

create table if not exists public.custody_fresh_tail_mints (
  epoch_id uuid not null,
  user_id uuid not null,
  token_mint text not null check (char_length(btrim(token_mint)) > 0),
  enrollment_event_key text not null
    check (char_length(btrim(enrollment_event_key)) > 0),
  enrollment_tx_sig text not null
    check (char_length(btrim(enrollment_tx_sig)) > 0),
  enrollment_slot bigint not null check (enrollment_slot >= 0),
  enrollment_blockhash text not null
    check (char_length(btrim(enrollment_blockhash)) > 0),
  enrollment_block_time timestamptz not null,
  enrollment_target_wallet text not null
    check (char_length(btrim(enrollment_target_wallet)) > 0),
  creation_tx_sig text not null check (char_length(btrim(creation_tx_sig)) > 0),
  creation_slot bigint not null check (creation_slot >= 0),
  creation_blockhash text not null check (char_length(btrim(creation_blockhash)) > 0),
  bonding_curve text not null check (char_length(btrim(bonding_curve)) > 0),
  creator text not null check (char_length(btrim(creator)) > 0),
  create_variant text not null
    check (create_variant in ('classic_v1', 'create_v2_token2022')),
  token_program text not null check (char_length(btrim(token_program)) > 0),
  mint_layout_fingerprint text not null
    check (mint_layout_fingerprint ~ '^[0-9a-f]{64}$'),
  parser_abi_fingerprint text not null
    check (
      parser_abi_fingerprint =
        'ebe9ae1c8f38c24c3c6d4da1a3c9b90ffce4bf27e36f562bc67b090e9b7c343f'
    ),
  total_supply_raw numeric(78, 0) not null
    check (total_supply_raw = 1000000000000000),
  decimals integer not null check (decimals = 6),
  attested_head_slot bigint not null check (attested_head_slot >= creation_slot),
  attested_head_blockhash text not null
    check (char_length(btrim(attested_head_blockhash)) > 0),
  status text not null default 'active'
    check (status in ('active', 'retired')),
  scope_revision bigint not null default 0 check (scope_revision >= 0),
  poisoned boolean not null default false,
  poison_reason text,
  retire_reason text,
  retired_at timestamptz,
  attested_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (epoch_id, token_mint),
  unique (epoch_id, user_id, token_mint),
  unique (epoch_id, enrollment_event_key),
  foreign key (epoch_id, user_id)
    references public.custody_fresh_tail_epochs(id, user_id),
  check (
    (status = 'active' and retire_reason is null and retired_at is null)
    or (status = 'retired' and retire_reason is not null and retired_at is not null)
  )
);

-- Definitive non-candidates are immutable tombstones rather than global cursor
-- blockers.  Transient RPC/history failures are not tombstoned.  A conflicting
-- replay permanently poisons the tombstone and cannot turn it into an entry.
create table if not exists public.custody_fresh_tail_mint_rejections (
  epoch_id uuid not null,
  user_id uuid not null,
  token_mint text not null check (char_length(btrim(token_mint)) > 0),
  source_tx_sig text not null check (char_length(btrim(source_tx_sig)) > 0),
  source_slot bigint not null check (source_slot >= 0),
  rejection_code text not null check (rejection_code in (
    'not_pump_fun', 'created_before_epoch', 'already_graduated',
    'unsupported_create', 'reviewed_abi_mismatch', 'create_not_found',
    'permanent_state_conflict', 'proof_unavailable_budget_exhausted',
    'trigger_expired_before_enrollment'
  )),
  parser_abi_fingerprint text not null,
  proof_fingerprint text not null check (char_length(proof_fingerprint) = 64),
  finalized_head_slot bigint not null check (finalized_head_slot >= source_slot),
  finalized_head_blockhash text not null,
  quarantined boolean not null default false,
  conflict_count integer not null default 0 check (conflict_count >= 0),
  first_conflict_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (epoch_id, token_mint),
  foreign key (epoch_id, user_id)
    references public.custody_fresh_tail_epochs(id, user_id)
);

-- Re-running the additive migration must widen the check on installations
-- created by an earlier revision; changing CREATE TABLE alone does not do so.
alter table public.custody_fresh_tail_mint_rejections
  drop constraint if exists custody_fresh_tail_mint_rejections_rejection_code_check;
alter table public.custody_fresh_tail_mint_rejections
  add constraint custody_fresh_tail_mint_rejections_rejection_code_check check (
    rejection_code in (
      'not_pump_fun', 'created_before_epoch', 'already_graduated',
      'unsupported_create', 'reviewed_abi_mismatch', 'create_not_found',
      'permanent_state_conflict', 'proof_unavailable_budget_exhausted',
      'trigger_expired_before_enrollment'
    )
  );

create index if not exists custody_fresh_tail_rejections_recovery_idx
  on public.custody_fresh_tail_mint_rejections (epoch_id, source_slot);

-- This is a fresh-owned finalized ledger.  Authorization never reads the
-- legacy supply_accumulation_events/state tables.
create table if not exists public.custody_fresh_tail_supply_events (
  id uuid primary key default gen_random_uuid(),
  epoch_id uuid not null,
  user_id uuid not null,
  event_key text not null check (char_length(btrim(event_key)) > 0),
  payload_fingerprint text not null check (char_length(payload_fingerprint) = 64),
  tx_sig text not null check (char_length(btrim(tx_sig)) > 0),
  slot bigint not null check (slot >= 0),
  block_time timestamptz not null,
  target_wallet text not null check (char_length(btrim(target_wallet)) > 0),
  token_mint text not null check (char_length(btrim(token_mint)) > 0),
  side text not null check (side in ('buy', 'sell')),
  amount_raw numeric(78, 0) not null check (amount_raw > 0),
  total_supply_raw numeric(78, 0) not null
    check (total_supply_raw = 1000000000000000),
  decimals integer not null check (decimals = 6),
  market_cap_usd numeric check (market_cap_usd is null or market_cap_usd > 0),
  valuation_slot bigint check (valuation_slot is null or valuation_slot >= 0),
  market_data_reliable boolean not null,
  pump_fun_verified boolean not null,
  classification_reliable boolean not null,
  parser_domain text not null,
  parser_abi_fingerprint text not null,
  finalized_head_slot bigint not null check (finalized_head_slot >= slot),
  finalized_head_blockhash text not null,
  quarantined boolean not null default false,
  conflict_count integer not null default 0 check (conflict_count >= 0),
  first_conflict_at timestamptz,
  recorded_at timestamptz not null default now(),
  unique (epoch_id, event_key),
  foreign key (epoch_id, user_id, token_mint)
    references public.custody_fresh_tail_mints(epoch_id, user_id, token_mint)
);

create index if not exists custody_fresh_tail_supply_window_idx
  on public.custody_fresh_tail_supply_events
    (epoch_id, token_mint, block_time, slot, target_wallet);

-- A transfer is one conserving, canonical recipient batch.  Partial recipient
-- writes are impossible: the whole JSON batch and its fingerprint are stored
-- in the same row/transaction.
create table if not exists public.custody_fresh_tail_custody_events (
  id uuid primary key default gen_random_uuid(),
  epoch_id uuid not null,
  user_id uuid not null,
  event_key text not null check (char_length(btrim(event_key)) > 0),
  payload_fingerprint text not null check (char_length(payload_fingerprint) = 64),
  tx_sig text not null check (char_length(btrim(tx_sig)) > 0),
  slot bigint not null check (slot >= 0),
  block_time timestamptz not null,
  source_wallet text not null check (char_length(btrim(source_wallet)) > 0),
  token_mint text not null check (char_length(btrim(token_mint)) > 0),
  event_kind text not null check (event_kind in (
    'TARGET_BUY', 'TRANSFER', 'SELL', 'UNRESOLVED_OUTFLOW', 'TERMINAL_OUTFLOW'
  )),
  amount_raw numeric(78, 0) not null check (amount_raw > 0),
  source_pre_raw numeric(78, 0) check (source_pre_raw is null or source_pre_raw >= 0),
  source_post_raw numeric(78, 0) check (source_post_raw is null or source_post_raw >= 0),
  decimals integer not null check (decimals = 6),
  recipients jsonb not null default '[]'::jsonb
    check (jsonb_typeof(recipients) = 'array'),
  classification text not null check (char_length(btrim(classification)) > 0),
  classification_reliable boolean not null,
  watchable boolean not null,
  parser_domain text not null,
  parser_abi_fingerprint text not null,
  finalized_head_slot bigint not null check (finalized_head_slot >= slot),
  finalized_head_blockhash text not null,
  classification_pending boolean not null default false,
  terminal_poison boolean not null default false,
  quarantined boolean not null default false,
  conflict_count integer not null default 0 check (conflict_count >= 0),
  first_conflict_at timestamptz,
  recorded_at timestamptz not null default now(),
  unique (epoch_id, event_key),
  foreign key (epoch_id, user_id, token_mint)
    references public.custody_fresh_tail_mints(epoch_id, user_id, token_mint)
);

create index if not exists custody_fresh_tail_custody_scope_idx
  on public.custody_fresh_tail_custody_events
    (epoch_id, token_mint, slot, source_wallet);

create table if not exists public.custody_fresh_tail_edges (
  epoch_id uuid not null,
  user_id uuid not null,
  token_mint text not null,
  custody_event_id uuid not null
    references public.custody_fresh_tail_custody_events(id),
  source_wallet text not null,
  destination_wallet text not null,
  discovery_slot bigint not null check (discovery_slot >= 0),
  amount_raw numeric(78, 0) not null check (amount_raw > 0),
  classification text not null,
  classification_reliable boolean not null,
  watchable boolean not null,
  applied_revision bigint check (applied_revision is null or applied_revision > 0),
  scope_applied_at timestamptz,
  recorded_at timestamptz not null default now(),
  primary key (epoch_id, custody_event_id, destination_wallet),
  foreign key (epoch_id, user_id, token_mint)
    references public.custody_fresh_tail_mints(epoch_id, user_id, token_mint)
);

create table if not exists public.custody_fresh_tail_wallets (
  epoch_id uuid not null,
  user_id uuid not null,
  token_mint text not null,
  wallet text not null check (char_length(btrim(wallet)) > 0),
  parent_wallet text not null check (char_length(btrim(parent_wallet)) > 0),
  discovery_event_id uuid not null
    references public.custody_fresh_tail_custody_events(id),
  discovery_event_key text not null,
  discovery_slot bigint not null check (discovery_slot >= 0),
  floor_slot bigint not null check (floor_slot = discovery_slot),
  boundary_kind text not null default 'inclusive_slot'
    check (boundary_kind = 'inclusive_slot'),
  watch_status text not null default 'active'
    check (watch_status in ('active', 'released', 'unwatchable')),
  classification text not null,
  classification_reliable boolean not null,
  added_revision bigint not null check (added_revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (epoch_id, token_mint, wallet),
  unique (epoch_id, user_id, token_mint, wallet),
  foreign key (epoch_id, user_id, token_mint)
    references public.custody_fresh_tail_mints(epoch_id, user_id, token_mint)
);

create table if not exists public.custody_fresh_tail_requests (
  id uuid primary key default gen_random_uuid(),
  epoch_id uuid not null,
  user_id uuid not null,
  token_mint text not null,
  status text not null default 'pending'
    check (status in ('pending', 'settled', 'expired', 'invalidated')),
  window_started_at timestamptz not null,
  trigger_supply_event_id uuid not null
    references public.custody_fresh_tail_supply_events(id),
  trigger_event_key text not null,
  trigger_tx_sig text not null,
  trigger_slot bigint not null check (trigger_slot >= 0),
  trigger_target_wallet text not null,
  trigger_block_time timestamptz not null,
  expires_at timestamptz not null,
  requested_head_slot bigint not null check (requested_head_slot >= trigger_slot),
  requested_head_blockhash text not null,
  requested_head_block_time timestamptz not null,
  head_snapshot_parser_abi_fingerprint text not null
    check (
      head_snapshot_parser_abi_fingerprint =
        '2f5de97b6527d4ec94082069d65abd2bf30523e45bf562aabe1e770e5eb4ad1d'
    ),
  head_curve_state_fingerprint text not null
    check (head_curve_state_fingerprint ~ '^[0-9a-f]{64}$'),
  head_curve_observed_slot bigint not null
    check (head_curve_observed_slot = requested_head_slot),
  head_curve_complete boolean not null check (not head_curve_complete),
  head_virtual_token_reserves_raw numeric(78, 0) not null
    check (head_virtual_token_reserves_raw > 0),
  head_virtual_sol_reserves_lamports numeric(78, 0) not null
    check (head_virtual_sol_reserves_lamports > 0),
  head_real_token_reserves_raw numeric(78, 0) not null
    check (head_real_token_reserves_raw > 0),
  head_real_sol_reserves_lamports numeric(78, 0) not null
    check (head_real_sol_reserves_lamports >= 0),
  head_curve_total_supply_raw numeric(78, 0) not null
    check (head_curve_total_supply_raw = 1000000000000000),
  head_mint_layout_fingerprint text not null
    check (head_mint_layout_fingerprint ~ '^[0-9a-f]{64}$'),
  head_token_program text not null,
  head_mint_supply_raw numeric(78, 0) not null
    check (head_mint_supply_raw = 1000000000000000),
  head_mint_decimals integer not null check (head_mint_decimals = 6),
  scope_revision bigint not null check (scope_revision >= 0),
  settled_revision bigint,
  settled_lease_generation bigint check (settled_lease_generation > 0),
  settled_at timestamptz,
  invalid_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at = trigger_block_time + interval '55 seconds'),
  check (
    (status = 'settled' and settled_revision is not null
      and settled_lease_generation is not null and settled_at is not null)
    or status <> 'settled'
  ),
  unique (id, user_id),
  unique (epoch_id, trigger_event_key),
  foreign key (epoch_id, user_id, token_mint)
    references public.custody_fresh_tail_mints(epoch_id, user_id, token_mint)
);

create unique index if not exists custody_fresh_tail_one_live_request_idx
  on public.custody_fresh_tail_requests (epoch_id, token_mint)
  where status in ('pending', 'settled');

-- scope_mint='*' is the three-root namespace.  A real mint is a descendant
-- namespace.  current_boundary_kind changes to exact_signature after progress;
-- it may never fall back to a slot boundary.
create table if not exists public.custody_fresh_tail_cursors (
  epoch_id uuid not null,
  user_id uuid not null,
  scope_mint text not null check (char_length(btrim(scope_mint)) > 0),
  wallet text not null check (char_length(btrim(wallet)) > 0),
  cursor_role text not null check (cursor_role in ('root', 'descendant')),
  floor_slot bigint not null check (floor_slot >= 0),
  initial_boundary_kind text not null
    check (initial_boundary_kind in ('exclusive_slot', 'inclusive_slot')),
  current_boundary_kind text not null
    check (current_boundary_kind in ('exclusive_slot', 'inclusive_slot', 'exact_signature')),
  last_processed_signature text,
  last_processed_slot bigint,
  last_block_time bigint,
  first_available_block bigint,
  history_floor_proven boolean not null default false,
  covered_through_slot bigint,
  covered_through_blockhash text,
  coverage_revision bigint not null default 0 check (coverage_revision >= 0),
  backlog_detected boolean not null default false,
  last_error text,
  last_success_at timestamptz,
  last_lease_generation bigint not null default 0 check (last_lease_generation >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (epoch_id, scope_mint, wallet),
  foreign key (epoch_id, user_id)
    references public.custody_fresh_tail_epochs(id, user_id),
  check (
    (cursor_role = 'root' and scope_mint = '*' and initial_boundary_kind = 'exclusive_slot')
    or
    (cursor_role = 'descendant' and scope_mint <> '*' and initial_boundary_kind = 'inclusive_slot')
  ),
  check (
    (last_processed_signature is null and last_processed_slot is null
      and current_boundary_kind = initial_boundary_kind)
    or
    (last_processed_signature is not null and last_processed_slot is not null
      and current_boundary_kind = 'exact_signature')
  ),
  check (
    (covered_through_slot is null and covered_through_blockhash is null)
    or
    (covered_through_slot is not null and covered_through_blockhash is not null)
  )
);

-- Retrograde discovery never rewinds a main cursor.  It creates an independent
-- inclusive exact-signature lane whose evidence remains auditable forever.
create table if not exists public.custody_fresh_tail_backscan_ranges (
  id uuid primary key default gen_random_uuid(),
  epoch_id uuid not null,
  user_id uuid not null,
  token_mint text not null,
  wallet text not null,
  source_edge_event_id uuid not null
    references public.custody_fresh_tail_custody_events(id),
  floor_slot bigint not null check (floor_slot >= 0),
  boundary_kind text not null default 'inclusive_slot'
    check (boundary_kind = 'inclusive_slot'),
  current_boundary_kind text not null default 'inclusive_slot'
    check (current_boundary_kind in ('inclusive_slot', 'exact_signature')),
  last_processed_signature text,
  last_processed_slot bigint,
  last_block_time bigint,
  first_available_block bigint,
  history_floor_proven boolean not null default false,
  covered_through_slot bigint,
  covered_through_blockhash text,
  coverage_revision bigint not null check (coverage_revision >= 0),
  backlog_detected boolean not null default true,
  last_error text,
  last_success_at timestamptz,
  last_lease_generation bigint not null default 0 check (last_lease_generation >= 0),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (epoch_id, token_mint, wallet, source_edge_event_id),
  foreign key (epoch_id, user_id, token_mint, wallet)
    references public.custody_fresh_tail_wallets(epoch_id, user_id, token_mint, wallet),
  check (
    (last_processed_signature is null and last_processed_slot is null
      and current_boundary_kind = 'inclusive_slot')
    or
    (last_processed_signature is not null and last_processed_slot is not null
      and current_boundary_kind = 'exact_signature')
  ),
  check (
    (covered_through_slot is null and covered_through_blockhash is null)
    or
    (covered_through_slot is not null and covered_through_blockhash is not null)
  )
);

create table if not exists public.custody_fresh_tail_coverage_attestations (
  id uuid primary key default gen_random_uuid(),
  epoch_id uuid not null,
  user_id uuid not null,
  lane_kind text not null check (lane_kind in ('main', 'backscan')),
  scope_mint text,
  wallet text,
  range_id uuid references public.custody_fresh_tail_backscan_ranges(id),
  covered_head_slot bigint not null check (covered_head_slot >= 0),
  covered_head_blockhash text not null,
  coverage_revision bigint not null check (coverage_revision >= 0),
  lease_generation bigint not null check (lease_generation > 0),
  attested_at timestamptz not null default now(),
  foreign key (epoch_id, user_id)
    references public.custody_fresh_tail_epochs(id, user_id),
  check (
    (lane_kind = 'main' and scope_mint is not null and wallet is not null
      and range_id is null)
    or
    (lane_kind = 'backscan' and range_id is not null
      and scope_mint is null and wallet is null)
  )
);

create unique index if not exists custody_fresh_tail_coverage_main_once_idx
  on public.custody_fresh_tail_coverage_attestations
    (epoch_id, scope_mint, wallet, covered_head_slot, coverage_revision,
      lease_generation)
  where lane_kind = 'main';

create unique index if not exists custody_fresh_tail_coverage_range_once_idx
  on public.custody_fresh_tail_coverage_attestations
    (range_id, covered_head_slot, coverage_revision, lease_generation)
  where lane_kind = 'backscan';

alter table public.entry_signal_claims
  add column if not exists fresh_tail_epoch_id uuid,
  add column if not exists fresh_tail_request_id uuid,
  add column if not exists fresh_tail_monitoring_armed_at timestamptz,
  add column if not exists received_amount_raw text,
  add column if not exists received_token_decimals integer;

create unique index if not exists entry_signal_claims_fresh_tail_request_once_idx
  on public.entry_signal_claims (fresh_tail_request_id)
  where fresh_tail_request_id is not null;

create index if not exists entry_signal_claims_fresh_tail_armed_idx
  on public.entry_signal_claims (fresh_tail_epoch_id, token_mint, created_at)
  where fresh_tail_monitoring_armed_at is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.entry_signal_claims'::regclass
      and conname = 'entry_signal_claims_fresh_tail_binding_check'
  ) then
    alter table public.entry_signal_claims
      add constraint entry_signal_claims_fresh_tail_binding_check check (
        (fresh_tail_epoch_id is null and fresh_tail_request_id is null
          and fresh_tail_monitoring_armed_at is null)
        or
        (fresh_tail_epoch_id is not null and fresh_tail_request_id is not null
          and fresh_tail_monitoring_armed_at is not null
          and entry_strategy = 'supply_accumulation')
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.entry_signal_claims'::regclass
      and conname = 'entry_signal_claims_fresh_receipt_pair_check'
  ) then
    alter table public.entry_signal_claims
      add constraint entry_signal_claims_fresh_receipt_pair_check check (
        (received_amount_raw is null and received_token_decimals is null)
        or
        (
          received_amount_raw ~ '^[1-9][0-9]*$'
          and char_length(received_amount_raw) <= 78
          and received_token_decimals between 0 and 18
        )
      );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.entry_signal_claims'::regclass
      and conname = 'entry_signal_claims_fresh_receipt_state_check'
  ) then
    -- Existing and future non-fresh claims are unaffected.  Once a claim is
    -- fresh-bound, only a confirmed exact receipt may advance it to landed.
    alter table public.entry_signal_claims
      add constraint entry_signal_claims_fresh_receipt_state_check check (
        fresh_tail_request_id is null
        or
        (
          (
            status in ('landed', 'persisted')
            and received_amount_raw is not null
            and received_token_decimals is not null
            and received_token_decimals = token_decimals
            and nullif(btrim(coalesce(bot_tx_sig, '')), '') is not null
            and submission_started_at is not null
            and landed_at is not null
          )
          or
          (
            status = 'uncertain'
            and received_amount_raw is null
            and received_token_decimals is null
            and nullif(btrim(coalesce(bot_tx_sig, '')), '') is not null
            and submission_started_at is not null
            and landed_at is null
          )
          or
          (
            status in ('claimed', 'submitted', 'failed_pre_submit')
            and received_amount_raw is null
            and received_token_decimals is null
            and landed_at is null
          )
        )
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.entry_signal_claims'::regclass
      and conname = 'entry_signal_claims_fresh_tail_epoch_fkey'
  ) then
    alter table public.entry_signal_claims
      add constraint entry_signal_claims_fresh_tail_epoch_fkey
      foreign key (fresh_tail_epoch_id)
      references public.custody_fresh_tail_epochs(id);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.entry_signal_claims'::regclass
      and conname = 'entry_signal_claims_fresh_tail_request_fkey'
  ) then
    alter table public.entry_signal_claims
      add constraint entry_signal_claims_fresh_tail_request_fkey
      foreign key (fresh_tail_request_id)
      references public.custody_fresh_tail_requests(id);
  end if;
end $$;

create table if not exists public.custody_fresh_tail_exit_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  epoch_id uuid not null,
  request_id uuid not null,
  token_mint text not null,
  entry_claim_id uuid not null references public.entry_signal_claims(id),
  position_id uuid not null,
  source_domain text not null check (source_domain in ('supply', 'custody')),
  supply_event_id uuid references public.custody_fresh_tail_supply_events(id),
  custody_event_id uuid references public.custody_fresh_tail_custody_events(id),
  trigger_kind text not null check (trigger_kind in (
    'direct_target_sell', 'mirror_custody_sell', 'terminal_outflow'
  )),
  status text not null default 'pending'
    check (status in ('pending', 'claimed', 'retry', 'uncertain', 'resolved', 'dismissed')),
  disposition text check (disposition is null or disposition in (
    'resolved', 'retry', 'uncertain', 'disabled_by_policy',
    'position_not_live', 'duplicate_sell_claim', 'entry_failed', 'position_closed'
  )),
  worker_id text,
  claim_token uuid,
  claim_generation bigint not null default 0 check (claim_generation >= 0),
  claim_expires_at timestamptz,
  sell_claim_id uuid,
  bot_tx_sig text,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  foreign key (request_id, user_id)
    references public.custody_fresh_tail_requests(id, user_id),
  check (
    (source_domain = 'supply' and supply_event_id is not null and custody_event_id is null)
    or
    (source_domain = 'custody' and custody_event_id is not null and supply_event_id is null)
  ),
  check (
    (status = 'claimed' and claim_token is not null and claim_expires_at is not null)
    or status <> 'claimed'
  ),
  check (
    (claim_token is null and claim_expires_at is null)
    or (claim_token is not null and claim_expires_at is not null)
  ),
  check (
    status <> 'uncertain'
    or (
      sell_claim_id is not null
      and nullif(btrim(coalesce(bot_tx_sig, '')), '') is not null
    )
  )
);

-- Keep reruns additive while allowing the drainer to distinguish a position
-- that is merely not persisted yet from terminal no-action outcomes.
alter table public.custody_fresh_tail_exit_intents
  drop constraint if exists custody_fresh_tail_exit_intents_disposition_check;
alter table public.custody_fresh_tail_exit_intents
  add constraint custody_fresh_tail_exit_intents_disposition_check check (
    disposition is null or disposition in (
      'resolved', 'retry', 'uncertain', 'disabled_by_policy',
      'position_not_live', 'duplicate_sell_claim', 'entry_failed', 'position_closed'
    )
  ) not valid;
alter table public.custody_fresh_tail_exit_intents
  validate constraint custody_fresh_tail_exit_intents_disposition_check;

create index if not exists custody_fresh_tail_exit_intents_drain_idx
  on public.custody_fresh_tail_exit_intents (user_id, status, created_at);

create unique index if not exists custody_fresh_tail_exit_supply_once_idx
  on public.custody_fresh_tail_exit_intents (entry_claim_id, supply_event_id)
  where supply_event_id is not null;

create unique index if not exists custody_fresh_tail_exit_custody_once_idx
  on public.custody_fresh_tail_exit_intents (entry_claim_id, custody_event_id)
  where custody_event_id is not null;

create table if not exists public.custody_fresh_tail_worker_heartbeat (
  user_id uuid not null,
  epoch_id uuid not null,
  worker_id text not null check (char_length(btrim(worker_id)) > 0),
  lease_token uuid not null,
  lease_generation bigint not null check (lease_generation > 0),
  lease_expires_at timestamptz not null,
  enabled boolean not null,
  shadow boolean not null,
  latest_head_slot bigint not null check (latest_head_slot >= 0),
  latest_head_blockhash text not null,
  latest_head_block_time timestamptz not null,
  root_required_count integer not null check (root_required_count = 3),
  root_covered_count integer not null check (root_covered_count between 0 and 3),
  root_backlog_count integer not null check (root_backlog_count between 0 and 3),
  max_root_lag_slots bigint not null check (max_root_lag_slots >= 0),
  active_mint_count integer not null check (active_mint_count >= 0),
  poisoned_mint_count integer not null check (poisoned_mint_count >= 0),
  retired_mint_count integer not null check (retired_mint_count >= 0),
  pending_candidate_count integer not null check (pending_candidate_count >= 0),
  oldest_pending_candidate_age_seconds bigint
    check (oldest_pending_candidate_age_seconds is null
      or oldest_pending_candidate_age_seconds >= 0),
  descendant_required_count integer not null check (descendant_required_count >= 0),
  descendant_covered_count integer not null check (descendant_covered_count >= 0),
  incomplete_backscan_count integer not null check (incomplete_backscan_count >= 0),
  exit_pending_count integer not null check (exit_pending_count >= 0),
  exit_retry_count integer not null check (exit_retry_count >= 0),
  exit_uncertain_count integer not null check (exit_uncertain_count >= 0),
  last_success_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (user_id, epoch_id),
  foreign key (epoch_id, user_id)
    references public.custody_fresh_tail_epochs(id, user_id)
);

-- Least privilege: clients may inspect only their own audit rows.  Only the
-- service role receives DML/EXECUTE below.
alter table public.custody_fresh_tail_epochs enable row level security;
alter table public.custody_fresh_tail_roots enable row level security;
alter table public.custody_fresh_tail_finalized_heads enable row level security;
alter table public.custody_fresh_tail_mints enable row level security;
alter table public.custody_fresh_tail_mint_rejections enable row level security;
alter table public.custody_fresh_tail_supply_events enable row level security;
alter table public.custody_fresh_tail_custody_events enable row level security;
alter table public.custody_fresh_tail_edges enable row level security;
alter table public.custody_fresh_tail_wallets enable row level security;
alter table public.custody_fresh_tail_requests enable row level security;
alter table public.custody_fresh_tail_cursors enable row level security;
alter table public.custody_fresh_tail_backscan_ranges enable row level security;
alter table public.custody_fresh_tail_coverage_attestations enable row level security;
alter table public.custody_fresh_tail_exit_intents enable row level security;
alter table public.custody_fresh_tail_worker_heartbeat enable row level security;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'custody_fresh_tail_epochs',
    'custody_fresh_tail_roots',
    'custody_fresh_tail_finalized_heads',
    'custody_fresh_tail_mints',
    'custody_fresh_tail_mint_rejections',
    'custody_fresh_tail_supply_events',
    'custody_fresh_tail_custody_events',
    'custody_fresh_tail_edges',
    'custody_fresh_tail_wallets',
    'custody_fresh_tail_requests',
    'custody_fresh_tail_cursors',
    'custody_fresh_tail_backscan_ranges',
    'custody_fresh_tail_coverage_attestations',
    'custody_fresh_tail_exit_intents',
    'custody_fresh_tail_worker_heartbeat'
  ] loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = v_table
        and policyname = 'read own fresh tail rows'
    ) then
      execute format(
        'create policy %I on public.%I for select to authenticated using (auth.uid() = user_id)',
        'read own fresh tail rows', v_table
      );
    end if;
    execute format(
      'revoke all on table public.%I from public, anon',
      v_table
    );
    execute format(
      'revoke insert, update, delete, truncate on table public.%I from authenticated',
      v_table
    );
    execute format('grant select on table public.%I to authenticated', v_table);
    execute format(
      'grant select, insert, update, delete on table public.%I to service_role',
      v_table
    );
  end loop;
end $$;

-- The heartbeat stores the active fencing token so the entry gate can prove
-- that telemetry came from the current lease holder.  Unlike the other audit
-- tables, it must therefore remain service-only rather than expose that
-- secret through the authenticated SELECT policy.
drop policy if exists "read own fresh tail rows"
  on public.custody_fresh_tail_worker_heartbeat;
revoke all on table public.custody_fresh_tail_worker_heartbeat
  from authenticated;
grant select, insert, update, delete
  on table public.custody_fresh_tail_worker_heartbeat to service_role;

create or replace function public.assert_custody_fresh_tail_lease(
  p_user_id uuid,
  p_epoch_id uuid,
  p_lease_token uuid,
  p_lease_generation bigint
)
returns public.custody_fresh_tail_epochs
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;

  select * into v_epoch
  from public.custody_fresh_tail_epochs
  where id = p_epoch_id and user_id = p_user_id
  for update;

  if not found
     or v_epoch.status <> 'active'
     or p_lease_token is null
     or v_epoch.lease_token is distinct from p_lease_token
     or v_epoch.lease_generation is distinct from p_lease_generation
     or v_epoch.lease_expires_at is null
     or v_epoch.lease_expires_at <= clock_timestamp() then
    raise exception using
      errcode = '55000',
      message = 'fresh-tail lease is missing, expired, or fenced';
  end if;

  return v_epoch;
end;
$$;

create or replace function public.attest_custody_fresh_tail_finalized_head(
  p_user_id uuid,
  p_epoch_id uuid,
  p_finalized_head_slot bigint,
  p_finalized_head_blockhash text,
  p_finalized_head_block_time timestamptz,
  p_lease_token uuid,
  p_lease_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_existing public.custody_fresh_tail_finalized_heads%rowtype;
  v_hash text := btrim(coalesce(p_finalized_head_blockhash, ''));
begin
  v_epoch := public.assert_custody_fresh_tail_lease(
    p_user_id, p_epoch_id, p_lease_token, p_lease_generation
  );
  if p_finalized_head_slot is null
     or p_finalized_head_slot < v_epoch.activation_slot
     or v_hash = '' or p_finalized_head_block_time is null
     or p_finalized_head_block_time < v_epoch.activation_block_time
     or p_finalized_head_block_time > clock_timestamp() then
    return jsonb_build_object('ok', false, 'reason', 'invalid_finalized_head');
  end if;

  select * into v_existing
  from public.custody_fresh_tail_finalized_heads
  where epoch_id = p_epoch_id and slot = p_finalized_head_slot
  for update;
  if found then
    if v_existing.blockhash <> v_hash
       or v_existing.block_time <> p_finalized_head_block_time then
      update public.custody_fresh_tail_epochs set
        status = 'invalidated', invalid_reason = 'finalized_head_conflict',
        updated_at = now()
      where id = p_epoch_id;
      return jsonb_build_object(
        'ok', false, 'reason', 'finalized_head_conflict',
        'epochId', p_epoch_id, 'slot', p_finalized_head_slot
      );
    end if;
    update public.custody_fresh_tail_finalized_heads set
      last_lease_generation = p_lease_generation,
      last_seen_at = clock_timestamp()
    where epoch_id = p_epoch_id and slot = p_finalized_head_slot;
    return jsonb_build_object(
      'ok', true, 'reason', 'already_attested', 'epochId', p_epoch_id,
      'slot', p_finalized_head_slot, 'blockhash', v_hash,
      'blockTime', p_finalized_head_block_time,
      'leaseGeneration', p_lease_generation
    );
  end if;

  insert into public.custody_fresh_tail_finalized_heads (
    epoch_id, user_id, slot, blockhash, block_time,
    first_lease_generation, last_lease_generation
  ) values (
    p_epoch_id, p_user_id, p_finalized_head_slot, v_hash,
    p_finalized_head_block_time, p_lease_generation, p_lease_generation
  );
  return jsonb_build_object(
    'ok', true, 'reason', 'attested', 'epochId', p_epoch_id,
    'slot', p_finalized_head_slot, 'blockhash', v_hash,
    'blockTime', p_finalized_head_block_time,
    'leaseGeneration', p_lease_generation
  );
end;
$$;



create or replace function public.is_custody_fresh_tail_parser_reviewed(
  p_parser_domain text,
  p_parser_abi_fingerprint text
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_domain text := lower(btrim(coalesce(p_parser_domain, '')));
  v_fingerprint text := lower(btrim(coalesce(p_parser_abi_fingerprint, '')));
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;
  -- Every enabled domain is pinned to its independently reviewed finalized
  -- decoder contract.  No domain may borrow another domain's fingerprint.
  return (v_domain, v_fingerprint) in (
    ('pump_root_buy_v1',
      'b8b6dbdcce44a2b61c55ba2fd74cd385fae489a95be291504eb8e7b15f88262d'),
    ('custody_target_buy_v1',
      'bd230909bd66718382a71c387324fefc840aa108089afcc01b61cb7115948f0c'),
    ('supply_sell_v1',
      'd6a4aa7b14969befcfa858192c539b2cbb4738db4a739f1230b4c82c001c4412'),
    ('custody_transfer_v1',
      'c50f0e09f75de355db936a95832046bc61f1d5b16eff81040528eadfc305422d'),
    ('custody_sell_v1',
      'f39f4582dbe8bd04f91375a61be0b83b750658cca7c51354cbeb335a86dab401'),
    ('custody_unresolved_v1',
      '8e6fe7600bfc983a35faa7cf1f6c79cdac5337080c551fa8accca4d62856995c'),
    ('custody_terminal_v1',
      '0858d3736e2eb29b82a1a9ef17b51246880561047aeb1ce8a12b701e3529aac4')
  );
end;
$$;

create or replace function public.reject_custody_fresh_tail_mint(
  p_user_id uuid,
  p_epoch_id uuid,
  p_token_mint text,
  p_source_tx_sig text,
  p_source_slot bigint,
  p_rejection_code text,
  p_parser_abi_fingerprint text,
  p_proof_fingerprint text,
  p_finalized_head_slot bigint,
  p_finalized_head_blockhash text,
  p_lease_token uuid,
  p_lease_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_existing public.custody_fresh_tail_mint_rejections%rowtype;
  v_mint text := btrim(coalesce(p_token_mint, ''));
  v_sig text := btrim(coalesce(p_source_tx_sig, ''));
  v_abi text := btrim(coalesce(p_parser_abi_fingerprint, ''));
  v_hash text := btrim(coalesce(p_finalized_head_blockhash, ''));
  v_fingerprint text := lower(btrim(coalesce(p_proof_fingerprint, '')));
begin
  v_epoch := public.assert_custody_fresh_tail_lease(
    p_user_id, p_epoch_id, p_lease_token, p_lease_generation
  );
  if v_mint = '' or v_sig = '' or v_abi = '' or v_hash = ''
     or p_source_slot is null or p_source_slot <= v_epoch.activation_slot
     or p_finalized_head_slot is null or p_finalized_head_slot < p_source_slot
     or p_rejection_code is null
     or p_rejection_code not in (
       'not_pump_fun', 'created_before_epoch', 'already_graduated',
       'unsupported_create', 'reviewed_abi_mismatch', 'create_not_found',
       'permanent_state_conflict', 'proof_unavailable_budget_exhausted',
       'trigger_expired_before_enrollment'
     )
     or v_fingerprint !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_rejection');
  end if;
  if not exists (
    select 1 from public.custody_fresh_tail_finalized_heads h
    where h.epoch_id = p_epoch_id and h.user_id = p_user_id
      and h.slot = p_finalized_head_slot and h.blockhash = v_hash
  ) then
    return jsonb_build_object('ok', false, 'reason', 'finalized_head_not_attested');
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(v_mint));
  if exists (
    select 1 from public.custody_fresh_tail_mints
    where epoch_id = p_epoch_id and token_mint = v_mint
  ) then
    update public.custody_fresh_tail_mints set
      poisoned = true,
      poison_reason = 'conflicting_mint_rejection',
      updated_at = now()
    where epoch_id = p_epoch_id and token_mint = v_mint;
    return jsonb_build_object('ok', false, 'reason', 'active_mint_conflict');
  end if;

  select * into v_existing
  from public.custody_fresh_tail_mint_rejections
  where epoch_id = p_epoch_id and token_mint = v_mint
  for update;
  if found then
    if v_existing.source_tx_sig = v_sig
       and v_existing.source_slot = p_source_slot
       and v_existing.rejection_code = p_rejection_code
       and v_existing.parser_abi_fingerprint = v_abi
       and v_existing.proof_fingerprint = v_fingerprint then
      return jsonb_build_object(
        'ok', true, 'reason', 'already_rejected', 'epochId', p_epoch_id,
        'tokenMint', v_mint, 'rejectionCode', v_existing.rejection_code,
        'quarantined', v_existing.quarantined
      );
    end if;
    update public.custody_fresh_tail_mint_rejections set
      quarantined = true,
      conflict_count = conflict_count + 1,
      first_conflict_at = coalesce(first_conflict_at, now()),
      updated_at = now()
    where epoch_id = p_epoch_id and token_mint = v_mint;
    return jsonb_build_object('ok', false, 'reason', 'rejection_payload_conflict');
  end if;

  insert into public.custody_fresh_tail_mint_rejections (
    epoch_id, user_id, token_mint, source_tx_sig, source_slot,
    rejection_code, parser_abi_fingerprint, proof_fingerprint,
    finalized_head_slot, finalized_head_blockhash
  ) values (
    p_epoch_id, p_user_id, v_mint, v_sig, p_source_slot,
    p_rejection_code, v_abi, v_fingerprint,
    p_finalized_head_slot, v_hash
  );
  return jsonb_build_object(
    'ok', true, 'reason', 'rejected', 'epochId', p_epoch_id,
    'tokenMint', v_mint, 'rejectionCode', p_rejection_code,
    'quarantined', false
  );
end;
$$;

create or replace function public.attest_custody_fresh_tail_mint_creation(
  p_user_id uuid,
  p_epoch_id uuid,
  p_token_mint text,
  p_enrollment_event_key text,
  p_enrollment_tx_sig text,
  p_enrollment_slot bigint,
  p_enrollment_blockhash text,
  p_enrollment_block_time timestamptz,
  p_enrollment_target_wallet text,
  p_creation_tx_sig text,
  p_creation_slot bigint,
  p_creation_blockhash text,
  p_bonding_curve text,
  p_creator text,
  p_create_variant text,
  p_token_program text,
  p_mint_layout_fingerprint text,
  p_parser_abi_fingerprint text,
  p_total_supply_raw numeric,
  p_decimals integer,
  p_finalized_head_slot bigint,
  p_finalized_head_blockhash text,
  p_lease_token uuid,
  p_lease_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_existing public.custody_fresh_tail_mints%rowtype;
  v_mint text := btrim(coalesce(p_token_mint, ''));
  v_enrollment_key text := btrim(coalesce(p_enrollment_event_key, ''));
  v_enrollment_sig text := btrim(coalesce(p_enrollment_tx_sig, ''));
  v_enrollment_hash text := btrim(coalesce(p_enrollment_blockhash, ''));
  v_enrollment_target text := btrim(coalesce(p_enrollment_target_wallet, ''));
  v_sig text := btrim(coalesce(p_creation_tx_sig, ''));
  v_creation_hash text := btrim(coalesce(p_creation_blockhash, ''));
  v_head_hash text := btrim(coalesce(p_finalized_head_blockhash, ''));
  v_curve text := btrim(coalesce(p_bonding_curve, ''));
  v_creator text := btrim(coalesce(p_creator, ''));
  v_variant text := lower(btrim(coalesce(p_create_variant, '')));
  v_token_program text := btrim(coalesce(p_token_program, ''));
  v_layout text := lower(btrim(coalesce(p_mint_layout_fingerprint, '')));
  v_abi text := lower(btrim(coalesce(p_parser_abi_fingerprint, '')));
begin
  v_epoch := public.assert_custody_fresh_tail_lease(
    p_user_id, p_epoch_id, p_lease_token, p_lease_generation
  );
  if v_mint = '' or v_enrollment_key = '' or v_enrollment_sig = ''
     or v_enrollment_hash = '' or v_enrollment_target = ''
     or v_enrollment_key <> v_enrollment_sig || ':' || v_mint
       || ':supply:BUY:' || v_enrollment_target
     or v_sig = '' or v_creation_hash = '' or v_head_hash = ''
     or v_curve = '' or v_creator = ''
     or v_variant not in ('classic_v1', 'create_v2_token2022')
     or v_token_program = '' or v_layout !~ '^[0-9a-f]{64}$'
     or v_abi <>
       'ebe9ae1c8f38c24c3c6d4da1a3c9b90ffce4bf27e36f562bc67b090e9b7c343f'
     or (v_variant = 'classic_v1' and v_token_program <>
       'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
     or (v_variant = 'create_v2_token2022' and v_token_program <>
       'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
     or p_creation_slot is null or p_creation_slot <= v_epoch.activation_slot
     or p_enrollment_slot is null or p_enrollment_slot < p_creation_slot
     or p_enrollment_block_time is null
     or p_enrollment_block_time < v_epoch.activation_block_time
     or p_finalized_head_slot is null or p_finalized_head_slot < p_enrollment_slot
     or p_total_supply_raw is distinct from 1000000000000000::numeric
     or p_decimals is distinct from 6 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_creation_proof');
  end if;
  if not exists (
    select 1 from public.custody_fresh_tail_finalized_heads h
    where h.epoch_id = p_epoch_id and h.user_id = p_user_id
      and h.slot = p_finalized_head_slot and h.blockhash = v_head_hash
  ) then
    return jsonb_build_object('ok', false, 'reason', 'finalized_head_not_attested');
  end if;
  if not exists (
    select 1 from public.custody_fresh_tail_finalized_heads h
    where h.epoch_id = p_epoch_id and h.user_id = p_user_id
      and h.slot = p_creation_slot and h.blockhash = v_creation_hash
  ) then
    return jsonb_build_object('ok', false, 'reason', 'creation_block_not_attested');
  end if;
  if not exists (
    select 1 from public.custody_fresh_tail_finalized_heads h
    where h.epoch_id = p_epoch_id and h.user_id = p_user_id
      and h.slot = p_enrollment_slot and h.blockhash = v_enrollment_hash
      and h.block_time = p_enrollment_block_time
  ) then
    return jsonb_build_object('ok', false, 'reason', 'enrollment_block_not_attested');
  end if;
  if not exists (
    select 1 from public.custody_fresh_tail_roots r
    where r.epoch_id = p_epoch_id and r.user_id = p_user_id
      and r.wallet = v_enrollment_target
  ) then
    return jsonb_build_object('ok', false, 'reason', 'enrollment_root_mismatch');
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(v_mint));
  if exists (
    select 1 from public.custody_fresh_tail_mint_rejections
    where epoch_id = p_epoch_id and token_mint = v_mint
  ) then
    return jsonb_build_object('ok', false, 'reason', 'mint_tombstoned');
  end if;

  -- A legacy journey is a veto only when it predates this epoch or is not
  -- rooted in a fresh-tail event.  Fresh dual-writes after enrollment remain
  -- available to the existing exit system but never authorize this gate.
  if exists (
    select 1
    from public.custody_journeys j
    where j.user_id = p_user_id
      and j.token_mint = v_mint
      and j.status = 'active'
      and j.first_event_key <> v_enrollment_key
  ) then
    return jsonb_build_object('ok', false, 'reason', 'preexisting_legacy_journey');
  end if;

  select * into v_existing
  from public.custody_fresh_tail_mints
  where epoch_id = p_epoch_id and token_mint = v_mint
  for update;
  if found then
    if v_existing.status <> 'active' then
      return jsonb_build_object('ok', false, 'reason', 'mint_retired');
    end if;
    if v_existing.enrollment_event_key = v_enrollment_key
       and v_existing.enrollment_tx_sig = v_enrollment_sig
       and v_existing.enrollment_slot = p_enrollment_slot
       and v_existing.enrollment_blockhash = v_enrollment_hash
       and v_existing.enrollment_block_time = p_enrollment_block_time
       and v_existing.enrollment_target_wallet = v_enrollment_target
       and v_existing.creation_tx_sig = v_sig
       and v_existing.creation_slot = p_creation_slot
       and v_existing.creation_blockhash = v_creation_hash
       and v_existing.bonding_curve = v_curve
       and v_existing.creator = v_creator
       and v_existing.create_variant = v_variant
       and v_existing.token_program = v_token_program
       and v_existing.mint_layout_fingerprint = v_layout
       and v_existing.parser_abi_fingerprint = v_abi
       and v_existing.total_supply_raw = p_total_supply_raw
       and v_existing.decimals = p_decimals then
      return jsonb_build_object(
        'ok', true, 'reason', 'already_attested', 'epochId', p_epoch_id,
        'tokenMint', v_mint, 'scopeRevision', v_existing.scope_revision,
        'created', false
      );
    end if;
    update public.custody_fresh_tail_mints set
      poisoned = true, poison_reason = 'creation_proof_conflict', updated_at = now()
    where epoch_id = p_epoch_id and token_mint = v_mint;
    return jsonb_build_object('ok', false, 'reason', 'creation_proof_conflict');
  end if;

  insert into public.custody_fresh_tail_mints (
    epoch_id, user_id, token_mint, enrollment_event_key,
    enrollment_tx_sig, enrollment_slot, enrollment_blockhash,
    enrollment_block_time, enrollment_target_wallet,
    creation_tx_sig, creation_slot,
    creation_blockhash, bonding_curve, creator, create_variant, token_program,
    mint_layout_fingerprint, parser_abi_fingerprint,
    total_supply_raw, decimals, attested_head_slot, attested_head_blockhash
  ) values (
    p_epoch_id, p_user_id, v_mint, v_enrollment_key,
    v_enrollment_sig, p_enrollment_slot, v_enrollment_hash,
    p_enrollment_block_time, v_enrollment_target,
    v_sig, p_creation_slot,
    v_creation_hash, v_curve, v_creator, v_variant, v_token_program,
    v_layout, v_abi,
    p_total_supply_raw, p_decimals, p_finalized_head_slot, v_head_hash
  );
  return jsonb_build_object(
    'ok', true, 'reason', 'attested', 'epochId', p_epoch_id,
    'tokenMint', v_mint, 'enrollmentEventKey', v_enrollment_key,
    'enrollmentSlot', p_enrollment_slot,
    'scopeRevision', 0, 'created', true
  );
end;
$$;

create or replace function public.activate_custody_fresh_tail_epoch(
  p_user_id uuid,
  p_root_wallets text[],
  p_activation_slot bigint,
  p_activation_blockhash text,
  p_activation_block_time timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_config public.bot_config%rowtype;
  v_existing public.custody_fresh_tail_epochs%rowtype;
  v_roots text[];
  v_config_roots text[];
  v_epoch_id uuid;
  v_blockhash text := btrim(coalesce(p_activation_blockhash, ''));
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;
  if p_user_id is null
     or p_activation_slot is null or p_activation_slot < 0
     or v_blockhash = ''
     or p_activation_block_time is null
     or p_activation_block_time > now() then
    return jsonb_build_object('ok', false, 'reason', 'invalid_activation');
  end if;

  select array_agg(v order by v) into v_roots
  from (
    select distinct btrim(wallet) as v
    from unnest(coalesce(p_root_wallets, array[]::text[])) wallet
    where nullif(btrim(wallet), '') is not null
  ) normalized;

  if coalesce(cardinality(p_root_wallets), 0) <> 3
     or coalesce(cardinality(v_roots), 0) <> 3 then
    return jsonb_build_object('ok', false, 'reason', 'exactly_three_roots_required');
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext('fresh-tail-epoch'));
  select * into v_config
  from public.bot_config
  where user_id = p_user_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'config_not_found');
  end if;

  select array_agg(v order by v) into v_config_roots
  from (
    select distinct btrim(wallet) as v
    from unnest(array_remove(array_prepend(
      nullif(btrim(v_config.target_wallet), ''),
      coalesce(v_config.additional_target_wallets, array[]::text[])
    ), null)) wallet
    where nullif(btrim(wallet), '') is not null
  ) configured;

  if v_config.enabled is not false then
    return jsonb_build_object('ok', false, 'reason', 'entries_must_be_off');
  elsif v_config.supply_accumulation_mode_enabled is not true then
    return jsonb_build_object('ok', false, 'reason', 'supply_accumulation_disabled');
  elsif v_config.custody_journey_enabled is not true then
    return jsonb_build_object('ok', false, 'reason', 'custody_journey_disabled');
  elsif v_config.direct_target_sell_exit_mode = 'proportional' then
    return jsonb_build_object('ok', false, 'reason', 'proportional_exit_proof_unavailable');
  elsif coalesce(cardinality(v_config_roots), 0) <> 3
        or v_config_roots is distinct from v_roots then
    return jsonb_build_object('ok', false, 'reason', 'configured_roots_mismatch');
  end if;

  select * into v_existing
  from public.custody_fresh_tail_epochs
  where user_id = p_user_id and status = 'active'
  for update;
  if found then
    if v_existing.activation_slot = p_activation_slot
       and v_existing.activation_blockhash = v_blockhash
       and v_existing.root_wallets = v_roots then
      return jsonb_build_object(
        'ok', true, 'reason', 'already_active', 'epochId', v_existing.id,
        'activationSlot', v_existing.activation_slot,
        'activationBlockhash', v_existing.activation_blockhash,
        'rootWallets', v_existing.root_wallets, 'status', v_existing.status,
        'scopeRevision', v_existing.scope_revision
      );
    end if;
    return jsonb_build_object('ok', false, 'reason', 'active_epoch_exists');
  end if;

  insert into public.custody_fresh_tail_epochs (
    user_id, activation_slot, activation_blockhash, activation_block_time,
    root_wallets, root_fingerprint
  ) values (
    p_user_id, p_activation_slot, v_blockhash, p_activation_block_time,
    v_roots, encode(extensions.digest(to_jsonb(v_roots)::text, 'sha256'), 'hex')
  ) returning id into v_epoch_id;

  insert into public.custody_fresh_tail_finalized_heads (
    epoch_id, user_id, slot, blockhash, block_time,
    first_lease_generation, last_lease_generation
  ) values (
    v_epoch_id, p_user_id, p_activation_slot, v_blockhash,
    p_activation_block_time, 0, 0
  );

  insert into public.custody_fresh_tail_roots (
    epoch_id, user_id, wallet, ordinal, floor_slot, boundary_kind
  )
  select v_epoch_id, p_user_id, wallet, ordinal::integer,
    p_activation_slot, 'exclusive_slot'
  from unnest(v_roots) with ordinality roots(wallet, ordinal);

  insert into public.custody_fresh_tail_cursors (
    epoch_id, user_id, scope_mint, wallet, cursor_role, floor_slot,
    initial_boundary_kind, current_boundary_kind
  )
  select v_epoch_id, p_user_id, '*', wallet, 'root', p_activation_slot,
    'exclusive_slot', 'exclusive_slot'
  from unnest(v_roots) wallet;

  return jsonb_build_object(
    'ok', true, 'reason', 'activated', 'epochId', v_epoch_id,
    'activationSlot', p_activation_slot, 'activationBlockhash', v_blockhash,
    'rootWallets', v_roots, 'status', 'active', 'scopeRevision', 0
  );
end;
$$;

-- Restart discovery is deliberately separate from activation.  It neither
-- samples a new boundary nor depends on Entries state, and it never exposes
-- the current lease token to a replacement process.
create or replace function public.get_custody_fresh_tail_active_epoch(
  p_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_roots text[];
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;
  if p_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_epoch_lookup');
  end if;

  select * into v_epoch
  from public.custody_fresh_tail_epochs
  where user_id = p_user_id and status = 'active';
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_active_epoch');
  end if;
  select array_agg(wallet order by wallet) into v_roots
  from public.custody_fresh_tail_roots
  where epoch_id = v_epoch.id and user_id = p_user_id;
  if coalesce(cardinality(v_roots), 0) <> 3
     or v_roots is distinct from v_epoch.root_wallets
     or v_epoch.root_fingerprint <>
       encode(extensions.digest(to_jsonb(v_roots)::text, 'sha256'), 'hex') then
    return jsonb_build_object(
      'ok', false, 'reason', 'active_epoch_root_identity_corrupt',
      'epochId', v_epoch.id
    );
  end if;

  return jsonb_build_object(
    'ok', true, 'reason', 'active_epoch_found',
    'epochId', v_epoch.id,
    'activationSlot', v_epoch.activation_slot,
    'activationBlockhash', v_epoch.activation_blockhash,
    'activationBlockTime', v_epoch.activation_block_time,
    'rootWallets', v_epoch.root_wallets,
    'rootFingerprint', v_epoch.root_fingerprint,
    'scopeRevision', v_epoch.scope_revision,
    'leaseOwner', v_epoch.lease_owner,
    'leaseGeneration', v_epoch.lease_generation,
    'leaseExpiresAt', v_epoch.lease_expires_at,
    'status', v_epoch.status
  );
end;
$$;

create or replace function public.acquire_custody_fresh_tail_lease(
  p_user_id uuid,
  p_epoch_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 30,
  p_expected_lease_token uuid default null,
  p_expected_lease_generation bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_token uuid;
  v_generation bigint;
  v_expires timestamptz;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;
  if p_user_id is null or p_epoch_id is null or v_worker = ''
     or p_lease_seconds is null or p_lease_seconds not between 5 and 120
     or ((p_expected_lease_token is null) <> (p_expected_lease_generation is null))
     or (p_expected_lease_generation is not null and p_expected_lease_generation <= 0) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_lease_request');
  end if;

  select * into v_epoch
  from public.custody_fresh_tail_epochs
  where id = p_epoch_id and user_id = p_user_id
  for update;
  if not found or v_epoch.status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'epoch_not_active');
  end if;

  if v_epoch.lease_expires_at > clock_timestamp() then
    -- A worker name is diagnostic metadata, not a fencing credential.  An
    -- unexpired lease can only be renewed by presenting its exact secret token
    -- and generation; a restarted or duplicate same-name process must wait for
    -- expiry and acquire a new generation.
    if v_epoch.lease_owner is distinct from v_worker
       or p_expected_lease_token is null
       or v_epoch.lease_token is distinct from p_expected_lease_token
       or v_epoch.lease_generation is distinct from p_expected_lease_generation then
      return jsonb_build_object(
        'ok', false, 'reason', 'lease_busy_or_fenced',
        'epochId', v_epoch.id, 'leaseExpiresAt', v_epoch.lease_expires_at,
        'leaseGeneration', v_epoch.lease_generation
      );
    end if;
    v_token := v_epoch.lease_token;
    v_generation := v_epoch.lease_generation;
  else
    v_token := gen_random_uuid();
    v_generation := v_epoch.lease_generation + 1;
  end if;
  v_expires := clock_timestamp() + make_interval(secs => p_lease_seconds);

  update public.custody_fresh_tail_epochs set
    lease_owner = v_worker,
    lease_token = v_token,
    lease_generation = v_generation,
    lease_expires_at = v_expires,
    updated_at = now()
  where id = v_epoch.id;

  return jsonb_build_object(
    'ok', true,
    'reason', case when p_expected_lease_token is null then 'leased' else 'renewed' end,
    'epochId', v_epoch.id,
    'leaseToken', v_token, 'leaseGeneration', v_generation,
    'leaseExpiresAt', v_expires
  );
end;
$$;

create or replace function public.record_custody_fresh_tail_heartbeat(
  p_user_id uuid,
  p_epoch_id uuid,
  p_worker_id text,
  p_enabled boolean,
  p_shadow boolean,
  p_latest_head_slot bigint,
  p_latest_head_blockhash text,
  p_latest_head_block_time timestamptz,
  p_last_success_at timestamptz,
  p_last_error text,
  p_lease_token uuid,
  p_lease_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_head_hash text := btrim(coalesce(p_latest_head_blockhash, ''));
  v_last_error text := nullif(btrim(coalesce(p_last_error, '')), '');
  v_root_covered integer;
  v_root_backlog integer;
  v_max_root_lag bigint;
  v_active_mints integer;
  v_poisoned_mints integer;
  v_retired_mints integer;
  v_pending_candidates integer;
  v_oldest_candidate_age bigint;
  v_descendant_required integer;
  v_descendant_covered integer;
  v_incomplete_backscans integer;
  v_exit_pending integer;
  v_exit_retry integer;
  v_exit_uncertain integer;
begin
  v_epoch := public.assert_custody_fresh_tail_lease(
    p_user_id, p_epoch_id, p_lease_token, p_lease_generation
  );
  if v_worker = '' or v_worker <> v_epoch.lease_owner
     or p_enabled is null or p_shadow is null
     or p_latest_head_slot is null or v_head_hash = ''
     or p_latest_head_block_time is null
     or p_last_success_at > clock_timestamp() then
    return jsonb_build_object('ok', false, 'reason', 'invalid_heartbeat');
  end if;
  if not exists (
    select 1 from public.custody_fresh_tail_finalized_heads h
    where h.epoch_id = p_epoch_id and h.user_id = p_user_id
      and h.slot = p_latest_head_slot and h.blockhash = v_head_hash
      and h.block_time = p_latest_head_block_time
  ) or exists (
    select 1 from public.custody_fresh_tail_finalized_heads h
    where h.epoch_id = p_epoch_id and h.slot > p_latest_head_slot
  ) then
    return jsonb_build_object('ok', false, 'reason', 'heartbeat_head_not_latest');
  end if;

  select
    count(*) filter (where not c.backlog_detected and c.history_floor_proven
      and exists (
        select 1 from public.custody_fresh_tail_coverage_attestations a
        where a.epoch_id = p_epoch_id and a.lane_kind = 'main'
          and a.scope_mint = '*' and a.wallet = r.wallet
          and a.covered_head_slot = p_latest_head_slot
          and a.covered_head_blockhash = v_head_hash
          and a.coverage_revision = 0
          and a.lease_generation = p_lease_generation
      ))::integer,
    count(*) filter (where c.wallet is null or c.backlog_detected
      or not c.history_floor_proven)::integer,
    coalesce(max(greatest(0, p_latest_head_slot
      - coalesce(c.covered_through_slot, r.floor_slot))), 0)::bigint
  into v_root_covered, v_root_backlog, v_max_root_lag
  from public.custody_fresh_tail_roots r
  left join public.custody_fresh_tail_cursors c
    on c.epoch_id = r.epoch_id and c.scope_mint = '*' and c.wallet = r.wallet
  where r.epoch_id = p_epoch_id;

  select
    count(*) filter (where status = 'active' and not poisoned)::integer,
    count(*) filter (where poisoned)::integer,
    count(*) filter (where status = 'retired')::integer
  into v_active_mints, v_poisoned_mints, v_retired_mints
  from public.custody_fresh_tail_mints where epoch_id = p_epoch_id;

  select count(*)::integer,
    case when min(q.trigger_block_time) is null then null else
      greatest(0, extract(epoch from
        (clock_timestamp() - min(q.trigger_block_time)))::bigint) end
  into v_pending_candidates, v_oldest_candidate_age
  from public.custody_fresh_tail_requests q
  where q.epoch_id = p_epoch_id and q.status = 'settled'
    and q.expires_at > clock_timestamp()
    and not exists (
      select 1 from public.entry_signal_claims c
      where c.fresh_tail_request_id = q.id
    );

  select count(*)::integer,
    count(*) filter (where w.watch_status = 'active'
      and w.classification_reliable and not c.backlog_detected
      and c.history_floor_proven and c.coverage_revision = m.scope_revision
      and exists (
        select 1 from public.custody_fresh_tail_coverage_attestations a
        where a.epoch_id = p_epoch_id and a.lane_kind = 'main'
          and a.scope_mint = w.token_mint and a.wallet = w.wallet
          and a.covered_head_slot = p_latest_head_slot
          and a.covered_head_blockhash = v_head_hash
          and a.coverage_revision = m.scope_revision
          and a.lease_generation = p_lease_generation
      ))::integer
  into v_descendant_required, v_descendant_covered
  from public.custody_fresh_tail_wallets w
  join public.custody_fresh_tail_mints m
    on m.epoch_id = w.epoch_id and m.token_mint = w.token_mint
   and m.status = 'active' and not m.poisoned
  left join public.custody_fresh_tail_cursors c
    on c.epoch_id = w.epoch_id and c.scope_mint = w.token_mint
   and c.wallet = w.wallet
  where w.epoch_id = p_epoch_id;

  select count(*)::integer into v_incomplete_backscans
  from public.custody_fresh_tail_backscan_ranges r
  join public.custody_fresh_tail_mints m
    on m.epoch_id = r.epoch_id and m.token_mint = r.token_mint
   and m.status = 'active' and not m.poisoned
  where r.epoch_id = p_epoch_id
    and (r.backlog_detected or not r.history_floor_proven
      or r.coverage_revision <> m.scope_revision
      or not exists (
        select 1 from public.custody_fresh_tail_coverage_attestations a
        where a.epoch_id = p_epoch_id and a.lane_kind = 'backscan'
          and a.range_id = r.id and a.covered_head_slot = p_latest_head_slot
          and a.covered_head_blockhash = v_head_hash
          and a.coverage_revision = m.scope_revision
          and a.lease_generation = p_lease_generation
      ));

  select
    count(*) filter (where status = 'pending')::integer,
    count(*) filter (where status = 'retry')::integer,
    count(*) filter (where status = 'uncertain')::integer
  into v_exit_pending, v_exit_retry, v_exit_uncertain
  from public.custody_fresh_tail_exit_intents where epoch_id = p_epoch_id;

  insert into public.custody_fresh_tail_worker_heartbeat (
    user_id, epoch_id, worker_id, lease_token, lease_generation,
    lease_expires_at, enabled, shadow, latest_head_slot,
    latest_head_blockhash, latest_head_block_time,
    root_required_count, root_covered_count, root_backlog_count,
    max_root_lag_slots, active_mint_count, poisoned_mint_count,
    retired_mint_count, pending_candidate_count,
    oldest_pending_candidate_age_seconds, descendant_required_count,
    descendant_covered_count, incomplete_backscan_count,
    exit_pending_count, exit_retry_count, exit_uncertain_count,
    last_success_at, last_error, updated_at
  ) values (
    p_user_id, p_epoch_id, v_worker, p_lease_token, p_lease_generation,
    v_epoch.lease_expires_at, p_enabled, p_shadow, p_latest_head_slot,
    v_head_hash, p_latest_head_block_time,
    3, v_root_covered, v_root_backlog, v_max_root_lag,
    v_active_mints, v_poisoned_mints, v_retired_mints,
    v_pending_candidates, v_oldest_candidate_age,
    v_descendant_required, v_descendant_covered, v_incomplete_backscans,
    v_exit_pending, v_exit_retry, v_exit_uncertain,
    p_last_success_at, v_last_error, clock_timestamp()
  ) on conflict (user_id, epoch_id) do update set
    worker_id = excluded.worker_id, lease_token = excluded.lease_token,
    lease_generation = excluded.lease_generation,
    lease_expires_at = excluded.lease_expires_at,
    enabled = excluded.enabled, shadow = excluded.shadow,
    latest_head_slot = excluded.latest_head_slot,
    latest_head_blockhash = excluded.latest_head_blockhash,
    latest_head_block_time = excluded.latest_head_block_time,
    root_required_count = excluded.root_required_count,
    root_covered_count = excluded.root_covered_count,
    root_backlog_count = excluded.root_backlog_count,
    max_root_lag_slots = excluded.max_root_lag_slots,
    active_mint_count = excluded.active_mint_count,
    poisoned_mint_count = excluded.poisoned_mint_count,
    retired_mint_count = excluded.retired_mint_count,
    pending_candidate_count = excluded.pending_candidate_count,
    oldest_pending_candidate_age_seconds = excluded.oldest_pending_candidate_age_seconds,
    descendant_required_count = excluded.descendant_required_count,
    descendant_covered_count = excluded.descendant_covered_count,
    incomplete_backscan_count = excluded.incomplete_backscan_count,
    exit_pending_count = excluded.exit_pending_count,
    exit_retry_count = excluded.exit_retry_count,
    exit_uncertain_count = excluded.exit_uncertain_count,
    last_success_at = excluded.last_success_at,
    last_error = excluded.last_error, updated_at = excluded.updated_at;

  return jsonb_build_object(
    'ok', true, 'reason', 'heartbeat_recorded', 'epochId', p_epoch_id,
    'workerId', v_worker, 'leaseGeneration', p_lease_generation,
    'leaseExpiresAt', v_epoch.lease_expires_at,
    'latestHeadSlot', p_latest_head_slot,
    'rootRequiredCount', 3, 'rootCoveredCount', v_root_covered,
    'rootBacklogCount', v_root_backlog, 'maxRootLagSlots', v_max_root_lag,
    'activeMintCount', v_active_mints, 'poisonedMintCount', v_poisoned_mints,
    'retiredMintCount', v_retired_mints,
    'pendingCandidateCount', v_pending_candidates,
    'oldestPendingCandidateAgeSeconds', v_oldest_candidate_age,
    'descendantRequiredCount', v_descendant_required,
    'descendantCoveredCount', v_descendant_covered,
    'incompleteBackscanCount', v_incomplete_backscans,
    'exitPendingCount', v_exit_pending, 'exitRetryCount', v_exit_retry,
    'exitUncertainCount', v_exit_uncertain, 'updatedAt', clock_timestamp()
  );
end;
$$;

create or replace function public.get_custody_fresh_tail_work(
  p_user_id uuid,
  p_epoch_id uuid,
  p_lease_token uuid,
  p_lease_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_root_floor_slot bigint;
  v_active_mint_count bigint;
  v_active_wallet_count bigint;
  v_active_backscan_count bigint;
  v_live_request_count bigint;
  v_relevant_rejection_count bigint;
  v_active_binding_count bigint;
begin
  v_epoch := public.assert_custody_fresh_tail_lease(
    p_user_id, p_epoch_id, p_lease_token, p_lease_generation
  );

  select min(coalesce(c.last_processed_slot, c.floor_slot))
  into v_root_floor_slot
  from public.custody_fresh_tail_cursors c
  where c.epoch_id = p_epoch_id and c.scope_mint = '*'
    and c.cursor_role = 'root';
  v_root_floor_slot := coalesce(v_root_floor_slot, v_epoch.activation_slot);

  select count(*) into v_active_mint_count
  from public.custody_fresh_tail_mints m
  where m.epoch_id = p_epoch_id and m.status = 'active';
  select count(*) into v_active_wallet_count
  from public.custody_fresh_tail_wallets w
  join public.custody_fresh_tail_mints m
    on m.epoch_id = w.epoch_id and m.token_mint = w.token_mint
   and m.status = 'active'
  where w.epoch_id = p_epoch_id;
  select count(*) into v_active_backscan_count
  from public.custody_fresh_tail_backscan_ranges r
  join public.custody_fresh_tail_mints m
    on m.epoch_id = r.epoch_id and m.token_mint = r.token_mint
   and m.status = 'active'
  where r.epoch_id = p_epoch_id;
  select count(*) into v_live_request_count
  from public.custody_fresh_tail_requests q
  where q.epoch_id = p_epoch_id and q.status in ('pending', 'settled');
  select count(*) into v_relevant_rejection_count
  from public.custody_fresh_tail_mint_rejections r
  where r.epoch_id = p_epoch_id and r.source_slot >= v_root_floor_slot;
  select count(*) into v_active_binding_count
  from public.entry_signal_claims c
  join public.custody_fresh_tail_mints m
    on m.epoch_id = c.fresh_tail_epoch_id and m.token_mint = c.token_mint
   and m.status = 'active'
  where c.user_id = p_user_id and c.fresh_tail_epoch_id = p_epoch_id
    and c.fresh_tail_monitoring_armed_at is not null
    and (
      c.status in ('claimed', 'submitted', 'landed', 'uncertain')
      or exists (
        select 1 from public.positions p
        where p.id = c.planned_position_id and p.user_id = c.user_id
          and p.closed_at is null
      )
    );

  -- Never construct an unbounded JSON work snapshot.  Crossing a cap stops
  -- this isolated observer lane fail-closed; it cannot affect the main worker
  -- or authorize an entry with an incomplete view.
  if v_active_mint_count > 256
     or v_active_wallet_count > 2048
     or v_active_backscan_count > 2048
     or v_live_request_count > 256
     or v_relevant_rejection_count > 2048
     or v_active_binding_count > 512 then
    return jsonb_build_object(
      'ok', false, 'reason', 'work_resource_cap',
      'activeMintCount', v_active_mint_count,
      'activeWalletCount', v_active_wallet_count,
      'activeBackscanCount', v_active_backscan_count,
      'liveRequestCount', v_live_request_count,
      'relevantRejectionCount', v_relevant_rejection_count,
      'activeBindingCount', v_active_binding_count
    );
  end if;
  return jsonb_build_object(
    'ok', true,
    'reason', 'loaded',
    'epoch', jsonb_build_object(
      'epochId', v_epoch.id,
      'activationSlot', v_epoch.activation_slot,
      'activationBlockhash', v_epoch.activation_blockhash,
      'status', v_epoch.status,
      'scopeRevision', v_epoch.scope_revision,
      'leaseGeneration', v_epoch.lease_generation,
      'leaseExpiresAt', v_epoch.lease_expires_at
    ),
    'roots', coalesce((
      select jsonb_agg(jsonb_build_object(
        'wallet', r.wallet, 'ordinal', r.ordinal, 'floorSlot', r.floor_slot,
        'boundaryKind', r.boundary_kind
      ) order by r.ordinal)
      from public.custody_fresh_tail_roots r where r.epoch_id = p_epoch_id
    ), '[]'::jsonb),
    'latestFinalizedHead', coalesce((
      select jsonb_build_object(
        'slot', h.slot, 'blockhash', h.blockhash, 'blockTime', h.block_time,
        'firstLeaseGeneration', h.first_lease_generation,
        'lastLeaseGeneration', h.last_lease_generation
      )
      from public.custody_fresh_tail_finalized_heads h
      where h.epoch_id = p_epoch_id
      order by h.slot desc
      limit 1
    ), '{}'::jsonb),
    'mints', coalesce((
      select jsonb_agg(jsonb_build_object(
        'tokenMint', m.token_mint, 'creationSlot', m.creation_slot,
        'enrollmentEventKey', m.enrollment_event_key,
        'enrollmentTxSig', m.enrollment_tx_sig,
        'enrollmentSlot', m.enrollment_slot,
        'enrollmentBlockhash', m.enrollment_blockhash,
        'enrollmentBlockTime', m.enrollment_block_time,
        'lastSupplyEventBlockTime', coalesce((
          select max(e.block_time)
          from public.custody_fresh_tail_supply_events e
          where e.epoch_id = m.epoch_id and e.token_mint = m.token_mint
        ), m.enrollment_block_time),
        'enrollmentTargetWallet', m.enrollment_target_wallet,
        'bondingCurve', m.bonding_curve, 'creator', m.creator,
        'createVariant', m.create_variant, 'tokenProgram', m.token_program,
        'mintLayoutFingerprint', m.mint_layout_fingerprint,
        'parserAbiFingerprint', m.parser_abi_fingerprint,
        'totalSupplyRaw', m.total_supply_raw::text, 'decimals', m.decimals,
        'status', m.status,
        'scopeRevision', m.scope_revision, 'poisoned', m.poisoned,
        'poisonReason', m.poison_reason, 'retireReason', m.retire_reason,
        'retiredAt', m.retired_at
      ) order by m.token_mint)
      from public.custody_fresh_tail_mints m
      where m.epoch_id = p_epoch_id and m.status = 'active'
    ), '[]'::jsonb),
    'rejections', coalesce((
      select jsonb_agg(jsonb_build_object(
        'tokenMint', r.token_mint, 'sourceTxSig', r.source_tx_sig,
        'sourceSlot', r.source_slot, 'rejectionCode', r.rejection_code,
        'parserAbiFingerprint', r.parser_abi_fingerprint,
        'proofFingerprint', r.proof_fingerprint,
        'quarantined', r.quarantined, 'conflictCount', r.conflict_count
      ) order by r.token_mint)
      from public.custody_fresh_tail_mint_rejections r
      where r.epoch_id = p_epoch_id and r.source_slot >= v_root_floor_slot
    ), '[]'::jsonb),
    'wallets', coalesce((
      select jsonb_agg(jsonb_build_object(
        'tokenMint', w.token_mint, 'wallet', w.wallet,
        'parentWallet', w.parent_wallet, 'discoverySlot', w.discovery_slot,
        'boundaryKind', w.boundary_kind, 'watchStatus', w.watch_status,
        'classificationReliable', w.classification_reliable,
        'watchable', w.watch_status <> 'unwatchable',
        'addedRevision', w.added_revision
      ) order by w.token_mint, w.wallet)
      from public.custody_fresh_tail_wallets w
      join public.custody_fresh_tail_mints m
        on m.epoch_id = w.epoch_id and m.token_mint = w.token_mint
       and m.status = 'active'
      where w.epoch_id = p_epoch_id
    ), '[]'::jsonb),
    'cursors', coalesce((
      select jsonb_agg(jsonb_build_object(
        'scopeMint', c.scope_mint, 'wallet', c.wallet, 'role', c.cursor_role,
        'floorSlot', c.floor_slot, 'initialBoundaryKind', c.initial_boundary_kind,
        'boundaryKind', c.current_boundary_kind,
        'lastSignature', c.last_processed_signature,
        'lastSlot', c.last_processed_slot,
        'firstAvailableBlock', c.first_available_block,
        'historyFloorProven', c.history_floor_proven,
        'coveredThroughSlot', c.covered_through_slot,
        'coveredThroughBlockhash', c.covered_through_blockhash,
        'coverageRevision', c.coverage_revision,
        'backlogDetected', c.backlog_detected, 'lastError', c.last_error
      ) order by c.scope_mint, c.wallet)
      from public.custody_fresh_tail_cursors c
      where c.epoch_id = p_epoch_id
        and (c.scope_mint = '*' or exists (
          select 1 from public.custody_fresh_tail_mints m
          where m.epoch_id = c.epoch_id and m.token_mint = c.scope_mint
            and m.status = 'active'
        ))
    ), '[]'::jsonb),
    'backscanRanges', coalesce((
      select jsonb_agg(jsonb_build_object(
        'rangeId', r.id, 'tokenMint', r.token_mint, 'wallet', r.wallet,
        'floorSlot', r.floor_slot, 'boundaryKind', r.current_boundary_kind,
        'lastSignature', r.last_processed_signature,
        'lastSlot', r.last_processed_slot,
        'firstAvailableBlock', r.first_available_block,
        'historyFloorProven', r.history_floor_proven,
        'coveredThroughSlot', r.covered_through_slot,
        'coveredThroughBlockhash', r.covered_through_blockhash,
        'coverageRevision', r.coverage_revision,
        'backlogDetected', r.backlog_detected, 'lastError', r.last_error
      ) order by r.token_mint, r.wallet, r.floor_slot, r.id)
      from public.custody_fresh_tail_backscan_ranges r
      join public.custody_fresh_tail_mints m
        on m.epoch_id = r.epoch_id and m.token_mint = r.token_mint
       and m.status = 'active'
      where r.epoch_id = p_epoch_id
    ), '[]'::jsonb),
    'requests', coalesce((
      select jsonb_agg(jsonb_build_object(
        'requestId', q.id, 'tokenMint', q.token_mint, 'status', q.status,
        'triggerEventKey', q.trigger_event_key, 'triggerSlot', q.trigger_slot,
        'triggerBlockTime', q.trigger_block_time, 'expiresAt', q.expires_at,
        'requestedHeadSlot', q.requested_head_slot,
        'requestedHeadBlockhash', q.requested_head_blockhash,
        'headSnapshotParserAbiFingerprint', q.head_snapshot_parser_abi_fingerprint,
        'headCurveStateFingerprint', q.head_curve_state_fingerprint,
        'headCurveObservedSlot', q.head_curve_observed_slot,
        'headCurveComplete', q.head_curve_complete,
        'headVirtualTokenReservesRaw', q.head_virtual_token_reserves_raw::text,
        'headVirtualSolReservesLamports', q.head_virtual_sol_reserves_lamports::text,
        'headRealTokenReservesRaw', q.head_real_token_reserves_raw::text,
        'headRealSolReservesLamports', q.head_real_sol_reserves_lamports::text,
        'headCurveTotalSupplyRaw', q.head_curve_total_supply_raw::text,
        'headMintLayoutFingerprint', q.head_mint_layout_fingerprint,
        'headTokenProgram', q.head_token_program,
        'headMintSupplyRaw', q.head_mint_supply_raw::text,
        'headMintDecimals', q.head_mint_decimals,
        'scopeRevision', q.scope_revision, 'settledRevision', q.settled_revision,
        'settledLeaseGeneration', q.settled_lease_generation
      ) order by q.created_at)
      from public.custody_fresh_tail_requests q
      where q.epoch_id = p_epoch_id and q.status in ('pending', 'settled')
    ), '[]'::jsonb),
    'armedBindings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'entryClaimId', c.id, 'positionId', c.planned_position_id,
        'tokenMint', c.token_mint, 'sourceSlot', c.source_slot,
        'epochId', c.fresh_tail_epoch_id, 'requestId', c.fresh_tail_request_id,
        'armedAt', c.fresh_tail_monitoring_armed_at
      ) order by c.created_at)
      from public.entry_signal_claims c
      join public.custody_fresh_tail_mints m
        on m.epoch_id = c.fresh_tail_epoch_id and m.token_mint = c.token_mint
       and m.status = 'active'
      where c.user_id = p_user_id and c.fresh_tail_epoch_id = p_epoch_id
        and c.fresh_tail_monitoring_armed_at is not null
        and (
          c.status in ('claimed', 'submitted', 'landed', 'uncertain')
          or exists (
            select 1 from public.positions p
            where p.id = c.planned_position_id and p.user_id = c.user_id
              and p.closed_at is null
          )
        )
    ), '[]'::jsonb),
    'exitIntentHealth', coalesce((
      select jsonb_object_agg(status, count)
      from (
        select i.status, count(*)::bigint as count
        from public.custody_fresh_tail_exit_intents i
        where i.user_id = p_user_id and i.epoch_id = p_epoch_id
        group by i.status
      ) counts
    ), '{}'::jsonb)
  );
end;
$$;

create or replace function public.get_custody_fresh_tail_retirement_candidates(
  p_user_id uuid,
  p_epoch_id uuid,
  p_limit integer,
  p_lease_token uuid,
  p_lease_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_active_count bigint;
  v_overflow_count bigint;
  v_candidates jsonb := '[]'::jsonb;
begin
  v_epoch := public.assert_custody_fresh_tail_lease(
    p_user_id, p_epoch_id, p_lease_token, p_lease_generation
  );
  if p_limit is null or p_limit not between 1 and 100 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_retirement_candidate_limit');
  end if;

  select count(*) into v_active_count
  from public.custody_fresh_tail_mints m
  where m.epoch_id = p_epoch_id and m.user_id = p_user_id
    and m.status = 'active';
  v_overflow_count := greatest(v_active_count - 256, 0);
  if v_overflow_count = 0 then
    return jsonb_build_object(
      'ok', true, 'reason', 'within_resource_cap',
      'activeMintCount', v_active_count, 'overflowCount', 0,
      'candidates', v_candidates
    );
  end if;

  -- This is a bounded capacity-eviction list, not retirement authority. The
  -- retire RPC repeats every request/claim/position/intent check under the
  -- mint advisory lock and scope-revision CAS before changing lifecycle state.
  select coalesce(jsonb_agg(jsonb_build_object(
    'tokenMint', candidate.token_mint,
    'scopeRevision', candidate.scope_revision,
    'reason', candidate.retire_reason,
    'lastSupplyEventBlockTime', candidate.last_supply_at
  ) order by candidate.poisoned desc, candidate.last_supply_at, candidate.token_mint), '[]'::jsonb)
  into v_candidates
  from (
    select m.token_mint, m.scope_revision, m.poisoned,
      case when m.poisoned then 'unsupported_after_enrollment'
        else 'resource_cap' end as retire_reason,
      coalesce((
        select max(e.block_time)
        from public.custody_fresh_tail_supply_events e
        where e.epoch_id = m.epoch_id and e.token_mint = m.token_mint
      ), m.enrollment_block_time) as last_supply_at
    from public.custody_fresh_tail_mints m
    where m.epoch_id = p_epoch_id and m.user_id = p_user_id
      and m.status = 'active'
      and not exists (
        select 1 from public.custody_fresh_tail_requests q
        where q.epoch_id = m.epoch_id and q.token_mint = m.token_mint
          and q.status in ('pending', 'settled')
          and q.expires_at > clock_timestamp()
      )
      and not exists (
        select 1 from public.entry_signal_claims c
        where c.user_id = p_user_id and c.fresh_tail_epoch_id = m.epoch_id
          and c.token_mint = m.token_mint
          and c.fresh_tail_monitoring_armed_at is not null
          and (
            c.status in ('claimed', 'submitted', 'landed', 'uncertain')
            or (
              c.status = 'persisted'
              and not exists (
                select 1 from public.positions p
                where p.id = c.planned_position_id and p.user_id = c.user_id
                  and p.token_mint = c.token_mint and p.closed_at is not null
              )
            )
          )
      )
      and not exists (
        select 1
        from public.positions p
        join public.entry_signal_claims c on c.planned_position_id = p.id
        where p.user_id = p_user_id and p.token_mint = m.token_mint
          and p.closed_at is null and c.fresh_tail_epoch_id = m.epoch_id
      )
      and not exists (
        select 1 from public.custody_fresh_tail_exit_intents i
        where i.user_id = p_user_id and i.epoch_id = m.epoch_id
          and i.token_mint = m.token_mint
          and i.status not in ('resolved', 'dismissed')
      )
    order by m.poisoned desc, last_supply_at, m.token_mint
    limit least(p_limit::bigint, v_overflow_count)
  ) candidate;

  return jsonb_build_object(
    'ok', true, 'reason', case when jsonb_array_length(v_candidates) > 0
      then 'resource_retirement_candidates' else 'resource_cap_blocked' end,
    'activeMintCount', v_active_count,
    'overflowCount', v_overflow_count,
    'candidates', v_candidates
  );
end;
$$;

create or replace function public.record_custody_fresh_tail_supply_event(
  p_user_id uuid,
  p_epoch_id uuid,
  p_event_key text,
  p_tx_sig text,
  p_slot bigint,
  p_block_time timestamptz,
  p_target_wallet text,
  p_token_mint text,
  p_side text,
  p_amount_raw numeric,
  p_total_supply_raw numeric,
  p_decimals integer,
  p_market_cap_usd numeric,
  p_valuation_slot bigint,
  p_market_data_reliable boolean,
  p_pump_fun_verified boolean,
  p_classification_reliable boolean,
  p_parser_domain text,
  p_parser_abi_fingerprint text,
  p_finalized_head_slot bigint,
  p_finalized_head_blockhash text,
  p_lease_token uuid,
  p_lease_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_mint public.custody_fresh_tail_mints%rowtype;
  v_existing public.custody_fresh_tail_supply_events%rowtype;
  v_event_id uuid;
  v_event_key text := btrim(coalesce(p_event_key, ''));
  v_sig text := btrim(coalesce(p_tx_sig, ''));
  v_target text := btrim(coalesce(p_target_wallet, ''));
  v_token_mint text := btrim(coalesce(p_token_mint, ''));
  v_side text := lower(btrim(coalesce(p_side, '')));
  v_parser_domain text := lower(btrim(coalesce(p_parser_domain, '')));
  v_abi text := btrim(coalesce(p_parser_abi_fingerprint, ''));
  v_head_hash text := btrim(coalesce(p_finalized_head_blockhash, ''));
  v_fingerprint text;
begin
  v_epoch := public.assert_custody_fresh_tail_lease(
    p_user_id, p_epoch_id, p_lease_token, p_lease_generation
  );
  if v_event_key = '' or v_sig = '' or v_target = '' or v_token_mint = ''
     or v_side not in ('buy', 'sell')
     or v_event_key <> v_sig || ':' || v_token_mint || ':supply:'
       || upper(v_side) || ':' || v_target
     or p_market_data_reliable is null or p_pump_fun_verified is null
     or p_classification_reliable is null
     or p_slot is null or p_slot <= v_epoch.activation_slot
     or p_block_time is null or p_block_time < v_epoch.activation_block_time
     or p_amount_raw is null or p_amount_raw <= 0
     or p_total_supply_raw is distinct from 1000000000000000::numeric
     or p_decimals is distinct from 6
     or v_parser_domain <> (case when v_side = 'buy'
       then 'pump_root_buy_v1' else 'supply_sell_v1' end)
     or v_abi = '' or v_head_hash = ''
     or p_finalized_head_slot is null or p_finalized_head_slot < p_slot
     or (p_market_data_reliable and (
       p_market_cap_usd is null or p_market_cap_usd <= 0
       or p_valuation_slot is distinct from p_slot
     )) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_supply_event');
  end if;
  if p_classification_reliable is not true then
    return jsonb_build_object('ok', false, 'reason', 'classification_pending');
  end if;
  if not public.is_custody_fresh_tail_parser_reviewed(v_parser_domain, v_abi) then
    return jsonb_build_object('ok', false, 'reason', 'parser_not_reviewed');
  end if;
  if not exists (
    select 1 from public.custody_fresh_tail_finalized_heads h
    where h.epoch_id = p_epoch_id and h.user_id = p_user_id
      and h.slot = p_finalized_head_slot and h.blockhash = v_head_hash
      and p_block_time <= h.block_time
  ) then
    return jsonb_build_object('ok', false, 'reason', 'finalized_head_not_attested');
  end if;
  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(v_token_mint));
  select * into v_mint
  from public.custody_fresh_tail_mints
  where epoch_id = p_epoch_id and user_id = p_user_id and token_mint = v_token_mint
  for update;
  if not found or v_mint.status <> 'active' or v_mint.poisoned then
    return jsonb_build_object('ok', false, 'reason', 'mint_not_active');
  end if;
  if exists (
    select 1 from public.custody_fresh_tail_mint_rejections
    where epoch_id = p_epoch_id and token_mint = v_token_mint
  ) then
    return jsonb_build_object('ok', false, 'reason', 'mint_tombstoned');
  end if;
  if not exists (
    select 1 from public.custody_fresh_tail_roots
    where epoch_id = p_epoch_id and wallet = v_target
  ) then
    return jsonb_build_object('ok', false, 'reason', 'target_not_epoch_root');
  end if;
  if v_mint.total_supply_raw <> p_total_supply_raw
     or v_mint.decimals <> p_decimals then
    update public.custody_fresh_tail_mints set
      poisoned = true, poison_reason = 'supply_creation_mismatch', updated_at = now()
    where epoch_id = p_epoch_id and token_mint = v_token_mint;
    return jsonb_build_object('ok', false, 'reason', 'supply_creation_mismatch');
  end if;
  if v_event_key = v_mint.enrollment_event_key and (
    v_side <> 'buy'
    or v_sig <> v_mint.enrollment_tx_sig
    or p_slot <> v_mint.enrollment_slot
    or p_block_time <> v_mint.enrollment_block_time
    or v_target <> v_mint.enrollment_target_wallet
  ) then
    update public.custody_fresh_tail_mints set
      poisoned = true, poison_reason = 'enrollment_event_mismatch', updated_at = now()
    where epoch_id = p_epoch_id and token_mint = v_token_mint;
    return jsonb_build_object('ok', false, 'reason', 'enrollment_event_mismatch');
  end if;

  v_fingerprint := encode(extensions.digest(jsonb_build_object(
    'eventKey', v_event_key, 'txSig', v_sig, 'slot', p_slot,
    'blockTime', p_block_time, 'targetWallet', v_target,
    'tokenMint', v_token_mint, 'side', v_side,
    'amountRaw', p_amount_raw::text, 'totalSupplyRaw', p_total_supply_raw::text,
    'decimals', p_decimals, 'pumpFunVerified', p_pump_fun_verified,
    'classificationReliable', p_classification_reliable,
    'parserDomain', v_parser_domain,
    'parserAbiFingerprint', v_abi
  )::text, 'sha256'), 'hex');

  select * into v_existing
  from public.custody_fresh_tail_supply_events
  where epoch_id = p_epoch_id and event_key = v_event_key
  for update;
  if found then
    -- SOL/USD is an off-chain observation and can legitimately differ when an
    -- uncheckpointed finalized event is replayed. Compare only canonical event
    -- identity here; retain the first accepted valuation for audit stability.
    if v_existing.tx_sig <> v_sig
       or v_existing.slot <> p_slot
       or v_existing.block_time <> p_block_time
       or v_existing.target_wallet <> v_target
       or v_existing.token_mint <> v_token_mint
       or v_existing.side <> v_side
       or v_existing.amount_raw <> p_amount_raw
       or v_existing.total_supply_raw <> p_total_supply_raw
       or v_existing.decimals <> p_decimals
       or v_existing.pump_fun_verified is distinct from p_pump_fun_verified
       or v_existing.classification_reliable is distinct from p_classification_reliable
       or v_existing.parser_domain <> v_parser_domain
       or v_existing.parser_abi_fingerprint <> v_abi
       or (v_existing.finalized_head_slot = p_finalized_head_slot
         and v_existing.finalized_head_blockhash <> v_head_hash) then
      update public.custody_fresh_tail_supply_events set
        quarantined = true,
        conflict_count = conflict_count + 1,
        first_conflict_at = coalesce(first_conflict_at, now())
      where id = v_existing.id;
      update public.custody_fresh_tail_mints set
        poisoned = true, poison_reason = 'supply_payload_conflict', updated_at = now()
      where epoch_id = p_epoch_id and token_mint = v_token_mint;
      if v_existing.finalized_head_slot = p_finalized_head_slot
         and v_existing.finalized_head_blockhash <> v_head_hash then
        update public.custody_fresh_tail_epochs set
          status = 'invalidated', invalid_reason = 'finalized_head_blockhash_conflict',
          updated_at = now()
        where id = p_epoch_id;
      end if;
      -- A payload conflict discovered after an entry was armed is itself
      -- terminal evidence.  Persist protective exit work before returning so
      -- a crash/replay cannot leave the landed position without an action.
      insert into public.custody_fresh_tail_exit_intents (
        user_id, epoch_id, request_id, token_mint, entry_claim_id,
        position_id, source_domain, supply_event_id, trigger_kind
      )
      select c.user_id, p_epoch_id, c.fresh_tail_request_id, v_token_mint,
        c.id, c.planned_position_id, 'supply', v_existing.id, 'terminal_outflow'
      from public.entry_signal_claims c
      where c.user_id = p_user_id
        and c.fresh_tail_epoch_id = p_epoch_id
        and c.token_mint = v_token_mint
        and c.fresh_tail_monitoring_armed_at is not null
      on conflict do nothing;
      return jsonb_build_object(
        'ok', false, 'reason', 'payload_conflict', 'epochId', p_epoch_id,
        'eventId', v_existing.id, 'eventKey', v_event_key,
        'duplicate', true, 'payloadMismatch', true, 'quarantined', true,
        'durableConflict', true, 'terminalPoison', true
      );
    end if;
    if p_finalized_head_slot > v_existing.finalized_head_slot then
      update public.custody_fresh_tail_supply_events set
        finalized_head_slot = p_finalized_head_slot,
        finalized_head_blockhash = v_head_hash
      where id = v_existing.id;
    end if;
    return jsonb_build_object(
      'ok', not v_existing.quarantined, 'reason', case
        when v_existing.quarantined then 'quarantined' else 'duplicate'
      end,
      'epochId', p_epoch_id, 'eventId', v_existing.id,
      'eventKey', v_event_key, 'duplicate', true,
      'payloadMismatch', false, 'quarantined', v_existing.quarantined,
      'amountRaw', v_existing.amount_raw::text
    );
  end if;

  insert into public.custody_fresh_tail_supply_events (
    epoch_id, user_id, event_key, payload_fingerprint, tx_sig, slot,
    block_time, target_wallet, token_mint, side, amount_raw,
    total_supply_raw, decimals, market_cap_usd, valuation_slot,
    market_data_reliable, pump_fun_verified, classification_reliable,
    parser_domain, parser_abi_fingerprint,
    finalized_head_slot, finalized_head_blockhash
  ) values (
    p_epoch_id, p_user_id, v_event_key, v_fingerprint, v_sig, p_slot,
    p_block_time, v_target, v_token_mint, v_side, p_amount_raw,
    p_total_supply_raw, p_decimals, p_market_cap_usd, p_valuation_slot,
    p_market_data_reliable, p_pump_fun_verified, p_classification_reliable,
    v_parser_domain, v_abi, p_finalized_head_slot, v_head_hash
  ) returning id into v_event_id;

  update public.custody_fresh_tail_requests set
    status = case when requested_head_slot < p_slot
      then 'invalidated' else 'pending' end,
    invalid_reason = case when requested_head_slot < p_slot
      then 'finalized_event_after_requested_head'
      else 'new_finalized_event_requires_resettle' end,
    settled_revision = null, settled_lease_generation = null,
    settled_at = null, updated_at = now()
  where epoch_id = p_epoch_id and token_mint = v_token_mint
    and status in ('pending', 'settled')
    and (requested_head_slot < p_slot or status = 'settled');

  if v_side = 'sell' then
    insert into public.custody_fresh_tail_exit_intents (
      user_id, epoch_id, request_id, token_mint, entry_claim_id,
      position_id, source_domain, supply_event_id, trigger_kind
    )
    select c.user_id, p_epoch_id, c.fresh_tail_request_id, v_token_mint,
      c.id, c.planned_position_id, 'supply', v_event_id, 'direct_target_sell'
    from public.entry_signal_claims c
    where c.user_id = p_user_id
      and c.fresh_tail_epoch_id = p_epoch_id
      and c.token_mint = v_token_mint
      and c.fresh_tail_monitoring_armed_at is not null
      and c.source_slot is not null and p_slot >= c.source_slot
    on conflict do nothing;
  end if;

  return jsonb_build_object(
    'ok', true, 'reason', 'recorded', 'epochId', p_epoch_id,
    'eventId', v_event_id, 'eventKey', v_event_key,
    'duplicate', false, 'payloadMismatch', false, 'quarantined', false,
    'amountRaw', p_amount_raw::text
  );
end;
$$;

create or replace function public.record_custody_fresh_tail_custody_event(
  p_user_id uuid,
  p_epoch_id uuid,
  p_event_key text,
  p_tx_sig text,
  p_slot bigint,
  p_block_time timestamptz,
  p_source_wallet text,
  p_token_mint text,
  p_event_kind text,
  p_amount_raw numeric,
  p_source_pre_raw numeric,
  p_source_post_raw numeric,
  p_decimals integer,
  p_recipients jsonb,
  p_classification text,
  p_classification_reliable boolean,
  p_watchable boolean,
  p_parser_domain text,
  p_parser_abi_fingerprint text,
  p_finalized_head_slot bigint,
  p_finalized_head_blockhash text,
  p_lease_token uuid,
  p_lease_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_mint public.custody_fresh_tail_mints%rowtype;
  v_existing public.custody_fresh_tail_custody_events%rowtype;
  v_event_id uuid;
  v_event_key text := btrim(coalesce(p_event_key, ''));
  v_sig text := btrim(coalesce(p_tx_sig, ''));
  v_source text := btrim(coalesce(p_source_wallet, ''));
  v_token_mint text := btrim(coalesce(p_token_mint, ''));
  v_kind text := upper(btrim(coalesce(p_event_kind, '')));
  v_classification text := btrim(coalesce(p_classification, ''));
  v_parser_domain text := lower(btrim(coalesce(p_parser_domain, '')));
  v_abi text := btrim(coalesce(p_parser_abi_fingerprint, ''));
  v_head_hash text := btrim(coalesce(p_finalized_head_blockhash, ''));
  v_recipients jsonb := '[]'::jsonb;
  v_fingerprint text;
  v_source_is_root boolean := false;
  v_terminal boolean := false;
  v_trigger_kind text;
begin
  v_epoch := public.assert_custody_fresh_tail_lease(
    p_user_id, p_epoch_id, p_lease_token, p_lease_generation
  );
  if v_event_key = '' or v_sig = '' or v_source = '' or v_token_mint = ''
     or v_kind not in (
       'TARGET_BUY', 'TRANSFER', 'SELL', 'UNRESOLVED_OUTFLOW', 'TERMINAL_OUTFLOW'
     )
     or v_event_key <> v_sig || ':' || v_token_mint || ':custody:'
       || v_kind || ':' || v_source
     or p_slot is null or p_slot <= v_epoch.activation_slot
     or p_block_time is null or p_block_time < v_epoch.activation_block_time
     or p_amount_raw is null or p_amount_raw <= 0
     or p_source_pre_raw is null or p_source_pre_raw < 0
     or p_source_post_raw is null or p_source_post_raw < 0
     or p_decimals is distinct from 6
     or p_watchable is null
     or v_classification = '' or v_parser_domain <> (case v_kind
       when 'TARGET_BUY' then 'custody_target_buy_v1'
       when 'TRANSFER' then 'custody_transfer_v1'
       when 'SELL' then 'custody_sell_v1'
       when 'UNRESOLVED_OUTFLOW' then 'custody_unresolved_v1'
       when 'TERMINAL_OUTFLOW' then 'custody_terminal_v1'
       else '' end)
     or v_abi = '' or v_head_hash = ''
     or p_finalized_head_slot is null or p_finalized_head_slot < p_slot
     or jsonb_typeof(coalesce(p_recipients, 'null'::jsonb)) <> 'array' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_custody_event');
  end if;

  if p_classification_reliable is not true then
    return jsonb_build_object('ok', false, 'reason', 'classification_pending');
  end if;
  if not public.is_custody_fresh_tail_parser_reviewed(v_parser_domain, v_abi) then
    return jsonb_build_object('ok', false, 'reason', 'parser_not_reviewed');
  end if;
  if not exists (
    select 1 from public.custody_fresh_tail_finalized_heads h
    where h.epoch_id = p_epoch_id and h.user_id = p_user_id
      and h.slot = p_finalized_head_slot and h.blockhash = v_head_hash
      and p_block_time <= h.block_time
  ) then
    return jsonb_build_object('ok', false, 'reason', 'finalized_head_not_attested');
  end if;

  if v_kind = 'TRANSFER' then
    if jsonb_array_length(p_recipients) not between 1 and 250
       or exists (
         select 1 from jsonb_array_elements(p_recipients) recipient
         where jsonb_typeof(recipient) <> 'object'
           or jsonb_typeof(recipient->'wallet') <> 'string'
           or nullif(btrim(recipient->>'wallet'), '') is null
           or coalesce(recipient->>'amountRaw', '') !~ '^[0-9]+$'
           or coalesce(recipient->>'preRaw', '') !~ '^[0-9]+$'
           or coalesce(recipient->>'postRaw', '') !~ '^[0-9]+$'
           or jsonb_typeof(recipient->'classification') <> 'string'
           or nullif(btrim(recipient->>'classification'), '') is null
           or jsonb_typeof(recipient->'classificationReliable') <> 'boolean'
           or jsonb_typeof(recipient->'watchable') <> 'boolean'
       ) then
      return jsonb_build_object('ok', false, 'reason', 'invalid_recipient_batch');
    end if;
    if exists (
      select 1 from jsonb_array_elements(p_recipients) recipient
      where (recipient->>'classificationReliable')::boolean is not true
    ) then
      return jsonb_build_object('ok', false, 'reason', 'classification_pending');
    end if;
    if (select count(*) from jsonb_array_elements(p_recipients)) <>
       (select count(distinct btrim(recipient->>'wallet'))
        from jsonb_array_elements(p_recipients) recipient)
       or exists (
         select 1 from jsonb_array_elements(p_recipients) recipient
         where btrim(recipient->>'wallet') = v_source
           or (recipient->>'amountRaw')::numeric <= 0
           or (recipient->>'postRaw')::numeric - (recipient->>'preRaw')::numeric
              <> (recipient->>'amountRaw')::numeric
       )
       or p_source_pre_raw - p_source_post_raw <> p_amount_raw
       or (select sum((recipient->>'amountRaw')::numeric)
           from jsonb_array_elements(p_recipients) recipient) <> p_amount_raw then
      return jsonb_build_object('ok', false, 'reason', 'nonconserving_recipient_batch');
    end if;

    select jsonb_agg(jsonb_build_object(
      'wallet', btrim(recipient->>'wallet'),
      'amountRaw', ((recipient->>'amountRaw')::numeric(78, 0))::text,
      'preRaw', ((recipient->>'preRaw')::numeric(78, 0))::text,
      'postRaw', ((recipient->>'postRaw')::numeric(78, 0))::text,
      'classification', btrim(recipient->>'classification'),
      'classificationReliable', (recipient->>'classificationReliable')::boolean,
      'watchable', (recipient->>'watchable')::boolean
    ) order by btrim(recipient->>'wallet')) into v_recipients
    from jsonb_array_elements(p_recipients) recipient;
  elsif jsonb_array_length(p_recipients) <> 0 then
    return jsonb_build_object('ok', false, 'reason', 'unexpected_recipients');
  end if;

  if v_kind = 'TARGET_BUY' then
    if p_source_post_raw - p_source_pre_raw <> p_amount_raw then
      return jsonb_build_object('ok', false, 'reason', 'nonconserving_target_buy');
    end if;
  elsif v_kind <> 'TRANSFER'
        and p_source_pre_raw - p_source_post_raw <> p_amount_raw then
    return jsonb_build_object('ok', false, 'reason', 'nonconserving_outflow');
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(v_token_mint));
  select * into v_mint
  from public.custody_fresh_tail_mints
  where epoch_id = p_epoch_id and user_id = p_user_id and token_mint = v_token_mint
  for update;
  if not found or v_mint.status <> 'active' or v_mint.poisoned then
    return jsonb_build_object('ok', false, 'reason', 'mint_not_active');
  end if;
  if v_mint.decimals <> p_decimals then
    update public.custody_fresh_tail_mints set
      poisoned = true, poison_reason = 'custody_creation_mismatch', updated_at = now()
    where epoch_id = p_epoch_id and token_mint = v_token_mint;
    return jsonb_build_object('ok', false, 'reason', 'custody_creation_mismatch');
  end if;

  select exists (
    select 1 from public.custody_fresh_tail_roots
    where epoch_id = p_epoch_id and wallet = v_source
  ) into v_source_is_root;
  if v_kind = 'TARGET_BUY' and not v_source_is_root then
    return jsonb_build_object('ok', false, 'reason', 'target_buy_not_epoch_root');
  elsif v_kind = 'SELL' and v_source_is_root then
    -- Root sells belong to the fresh Supply ledger.  Rejecting a duplicate
    -- Custody SELL prevents two independent exit intents for one root sale.
    return jsonb_build_object('ok', false, 'reason', 'root_sell_uses_supply_ledger');
  elsif v_kind <> 'TARGET_BUY' and not v_source_is_root and not exists (
    select 1 from public.custody_fresh_tail_wallets w
    where w.epoch_id = p_epoch_id and w.token_mint = v_token_mint
      and w.wallet = v_source and p_slot >= w.discovery_slot
  ) then
    return jsonb_build_object('ok', false, 'reason', 'source_not_in_fresh_scope');
  end if;

  if v_kind = 'TARGET_BUY' and not exists (
    select 1 from public.custody_fresh_tail_supply_events s
    where s.epoch_id = p_epoch_id and s.token_mint = v_token_mint
      and s.tx_sig = v_sig and s.slot = p_slot and s.target_wallet = v_source
      and s.side = 'buy' and s.amount_raw = p_amount_raw
      and not s.quarantined and s.classification_reliable
      and s.pump_fun_verified
      and public.is_custody_fresh_tail_parser_reviewed(
        s.parser_domain, s.parser_abi_fingerprint
      )
  ) then
    return jsonb_build_object('ok', false, 'reason', 'fresh_supply_buy_missing');
  end if;
  if v_kind = 'TRANSFER' and v_source_is_root and exists (
    select 1 from public.custody_fresh_tail_supply_events s
    where s.epoch_id = p_epoch_id and s.token_mint = v_token_mint
      and s.tx_sig = v_sig and s.slot = p_slot and s.target_wallet = v_source
      and s.side = 'buy'
  ) and not exists (
    select 1 from public.custody_fresh_tail_custody_events b
    where b.epoch_id = p_epoch_id and b.token_mint = v_token_mint
      and b.tx_sig = v_sig and b.slot = p_slot and b.source_wallet = v_source
      and b.event_kind = 'TARGET_BUY' and b.source_post_raw = p_source_pre_raw
      and not b.quarantined and b.classification_reliable
  ) then
    return jsonb_build_object('ok', false, 'reason', 'same_tx_buy_cohort_missing');
  end if;

  v_terminal := v_kind in ('UNRESOLVED_OUTFLOW', 'TERMINAL_OUTFLOW')
    or p_watchable is not true
    or exists (
      select 1 from jsonb_array_elements(v_recipients) recipient
      where (recipient->>'watchable')::boolean is not true
    );
  v_fingerprint := encode(extensions.digest(jsonb_build_object(
    'eventKey', v_event_key, 'txSig', v_sig, 'slot', p_slot,
    'blockTime', p_block_time, 'sourceWallet', v_source,
    'tokenMint', v_token_mint, 'eventKind', v_kind,
    'amountRaw', p_amount_raw::text, 'sourcePreRaw', p_source_pre_raw::text,
    'sourcePostRaw', p_source_post_raw::text, 'decimals', p_decimals,
    'recipients', v_recipients, 'classification', v_classification,
    'classificationReliable', p_classification_reliable,
    'watchable', p_watchable, 'parserDomain', v_parser_domain,
    'parserAbiFingerprint', v_abi
  )::text, 'sha256'), 'hex');

  select * into v_existing
  from public.custody_fresh_tail_custody_events
  where epoch_id = p_epoch_id and event_key = v_event_key
  for update;
  if found then
    if v_existing.payload_fingerprint <> v_fingerprint
       or (v_existing.finalized_head_slot = p_finalized_head_slot
         and v_existing.finalized_head_blockhash <> v_head_hash) then
      update public.custody_fresh_tail_custody_events set
        quarantined = true, terminal_poison = true,
        conflict_count = conflict_count + 1,
        first_conflict_at = coalesce(first_conflict_at, now())
      where id = v_existing.id;
      update public.custody_fresh_tail_mints set
        poisoned = true, poison_reason = 'custody_payload_conflict', updated_at = now()
      where epoch_id = p_epoch_id and token_mint = v_token_mint;
      if v_existing.finalized_head_slot = p_finalized_head_slot
         and v_existing.finalized_head_blockhash <> v_head_hash then
        update public.custody_fresh_tail_epochs set
          status = 'invalidated', invalid_reason = 'finalized_head_blockhash_conflict',
          updated_at = now()
        where id = p_epoch_id;
      end if;
      -- Quarantine is not enough after a live entry is armed: atomically fan
      -- the conflict into the durable exit outbox before acknowledging it.
      insert into public.custody_fresh_tail_exit_intents (
        user_id, epoch_id, request_id, token_mint, entry_claim_id,
        position_id, source_domain, custody_event_id, trigger_kind
      )
      select c.user_id, p_epoch_id, c.fresh_tail_request_id, v_token_mint,
        c.id, c.planned_position_id, 'custody', v_existing.id, 'terminal_outflow'
      from public.entry_signal_claims c
      where c.user_id = p_user_id
        and c.fresh_tail_epoch_id = p_epoch_id
        and c.token_mint = v_token_mint
        and c.fresh_tail_monitoring_armed_at is not null
      on conflict do nothing;
      return jsonb_build_object(
        'ok', false, 'reason', 'payload_conflict', 'epochId', p_epoch_id,
        'eventId', v_existing.id, 'eventKey', v_event_key,
        'duplicate', true, 'payloadMismatch', true, 'quarantined', true,
        'durableConflict', true, 'terminalPoison', true
      );
    end if;
    return jsonb_build_object(
      'ok', not v_existing.quarantined, 'reason', case
        when v_existing.quarantined then 'quarantined' else 'duplicate'
      end,
      'epochId', p_epoch_id, 'eventId', v_existing.id,
      'eventKey', v_event_key, 'duplicate', true,
      'payloadMismatch', false, 'quarantined', v_existing.quarantined,
      'amountRaw', v_existing.amount_raw::text, 'recipients', v_existing.recipients
    );
  end if;

  insert into public.custody_fresh_tail_custody_events (
    epoch_id, user_id, event_key, payload_fingerprint, tx_sig, slot,
    block_time, source_wallet, token_mint, event_kind, amount_raw,
    source_pre_raw, source_post_raw, decimals, recipients, classification,
    classification_reliable, watchable, parser_domain, parser_abi_fingerprint,
    finalized_head_slot, finalized_head_blockhash,
    classification_pending, terminal_poison
  ) values (
    p_epoch_id, p_user_id, v_event_key, v_fingerprint, v_sig, p_slot,
    p_block_time, v_source, v_token_mint, v_kind, p_amount_raw,
    p_source_pre_raw, p_source_post_raw, p_decimals, v_recipients,
    v_classification, true, p_watchable, v_parser_domain, v_abi,
    p_finalized_head_slot, v_head_hash, false, v_terminal
  ) returning id into v_event_id;

  update public.custody_fresh_tail_requests set
    status = case when requested_head_slot < p_slot
      then 'invalidated' else 'pending' end,
    invalid_reason = case when requested_head_slot < p_slot
      then 'finalized_event_after_requested_head'
      else 'new_finalized_event_requires_resettle' end,
    settled_revision = null, settled_lease_generation = null,
    settled_at = null, updated_at = now()
  where epoch_id = p_epoch_id and token_mint = v_token_mint
    and status in ('pending', 'settled')
    and (requested_head_slot < p_slot or status = 'settled');

  if v_kind = 'TRANSFER' then
    insert into public.custody_fresh_tail_edges (
      epoch_id, user_id, token_mint, custody_event_id, source_wallet,
      destination_wallet, discovery_slot, amount_raw, classification,
      classification_reliable, watchable
    )
    select p_epoch_id, p_user_id, v_token_mint, v_event_id, v_source,
      recipient->>'wallet', p_slot, (recipient->>'amountRaw')::numeric,
      recipient->>'classification',
      (recipient->>'classificationReliable')::boolean,
      (recipient->>'watchable')::boolean
    from jsonb_array_elements(v_recipients) recipient;
  end if;

  if v_kind = 'SELL' or v_terminal then
    v_trigger_kind := case
      when v_kind = 'SELL' then 'mirror_custody_sell'
      else 'terminal_outflow'
    end;
    insert into public.custody_fresh_tail_exit_intents (
      user_id, epoch_id, request_id, token_mint, entry_claim_id,
      position_id, source_domain, custody_event_id, trigger_kind
    )
    select c.user_id, p_epoch_id, c.fresh_tail_request_id, v_token_mint,
      c.id, c.planned_position_id, 'custody', v_event_id, v_trigger_kind
    from public.entry_signal_claims c
    where c.user_id = p_user_id
      and c.fresh_tail_epoch_id = p_epoch_id
      and c.token_mint = v_token_mint
      and c.fresh_tail_monitoring_armed_at is not null
      and c.source_slot is not null and p_slot >= c.source_slot
    on conflict do nothing;
  end if;

  return jsonb_build_object(
    'ok', true, 'reason', case when v_terminal then 'recorded_terminal' else 'recorded' end,
    'epochId', p_epoch_id, 'eventId', v_event_id, 'eventKey', v_event_key,
    'duplicate', false, 'payloadMismatch', false, 'quarantined', false,
    'terminalPoison', v_terminal, 'amountRaw', p_amount_raw::text,
    'recipients', v_recipients
  );
end;
$$;

create or replace function public.sync_custody_fresh_tail_scope(
  p_user_id uuid,
  p_epoch_id uuid,
  p_token_mint text,
  p_expected_scope_revision bigint,
  p_lease_token uuid,
  p_lease_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_mint public.custody_fresh_tail_mints%rowtype;
  v_wallet public.custody_fresh_tail_wallets%rowtype;
  v_edge record;
  v_token_mint text := btrim(coalesce(p_token_mint, ''));
  v_revision bigint;
  v_added text[] := array[]::text[];
  v_backscan_ids uuid[] := array[]::uuid[];
  v_range_id uuid;
begin
  v_epoch := public.assert_custody_fresh_tail_lease(
    p_user_id, p_epoch_id, p_lease_token, p_lease_generation
  );
  if v_token_mint = '' or p_expected_scope_revision is null
     or p_expected_scope_revision < 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_scope_request');
  end if;
  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(v_token_mint));
  select * into v_mint
  from public.custody_fresh_tail_mints
  where epoch_id = p_epoch_id and user_id = p_user_id and token_mint = v_token_mint
  for update;
  if not found or v_mint.status <> 'active' or v_mint.poisoned then
    return jsonb_build_object('ok', false, 'reason', 'mint_not_active');
  end if;
  if v_mint.scope_revision <> p_expected_scope_revision then
    return jsonb_build_object(
      'ok', false, 'reason', 'scope_revision_conflict',
      'scopeRevision', v_mint.scope_revision
    );
  end if;

  if exists (
    select 1
    from public.custody_journeys j
    where j.user_id = p_user_id and j.token_mint = v_token_mint
      and j.status = 'active'
      and j.first_event_key <> v_mint.enrollment_event_key
  ) then
    update public.custody_fresh_tail_mints set
      poisoned = true, poison_reason = 'preexisting_legacy_journey', updated_at = now()
    where epoch_id = p_epoch_id and token_mint = v_token_mint;
    return jsonb_build_object('ok', false, 'reason', 'preexisting_legacy_journey');
  end if;

  if exists (
    select 1 from public.custody_fresh_tail_custody_events e
    where e.epoch_id = p_epoch_id and e.token_mint = v_token_mint
      and (e.quarantined or e.classification_pending or e.terminal_poison
        or not e.classification_reliable
        or not public.is_custody_fresh_tail_parser_reviewed(
          e.parser_domain, e.parser_abi_fingerprint
        ))
  ) or exists (
    select 1 from public.custody_fresh_tail_edges e
    where e.epoch_id = p_epoch_id and e.token_mint = v_token_mint
      and (not e.classification_reliable or not e.watchable)
  ) then
    update public.custody_fresh_tail_mints set
      poisoned = true, poison_reason = 'fresh_custody_poison', updated_at = now()
    where epoch_id = p_epoch_id and token_mint = v_token_mint;
    return jsonb_build_object(
      'ok', false, 'reason', 'fresh_custody_poison',
      'epochId', p_epoch_id, 'tokenMint', v_token_mint,
      'scopeRevision', v_mint.scope_revision, 'poisoned', true
    );
  end if;

  if not exists (
    select 1 from public.custody_fresh_tail_edges e
    where e.epoch_id = p_epoch_id and e.token_mint = v_token_mint
      and e.applied_revision is null
  ) then
    return jsonb_build_object(
      'ok', true, 'reason', 'scope_unchanged', 'epochId', p_epoch_id,
      'tokenMint', v_token_mint, 'scopeRevision', v_mint.scope_revision,
      'addedWallets', to_jsonb(v_added), 'backscanRangeIds', to_jsonb(v_backscan_ids),
      'poisoned', false
    );
  end if;

  v_revision := v_mint.scope_revision + 1;
  for v_edge in
    select e.*, ce.event_key
    from public.custody_fresh_tail_edges e
    join public.custody_fresh_tail_custody_events ce on ce.id = e.custody_event_id
    where e.epoch_id = p_epoch_id and e.token_mint = v_token_mint
      and e.applied_revision is null
    order by e.discovery_slot, e.custody_event_id, e.destination_wallet
  loop
    -- Transfers back into a root are evidence, but roots already have the
    -- common exclusive cursor and never acquire a mint-scoped cursor.
    if exists (
      select 1 from public.custody_fresh_tail_roots r
      where r.epoch_id = p_epoch_id and r.wallet = v_edge.destination_wallet
    ) then
      continue;
    end if;

    select * into v_wallet
    from public.custody_fresh_tail_wallets w
    where w.epoch_id = p_epoch_id and w.token_mint = v_token_mint
      and w.wallet = v_edge.destination_wallet
    for update;
    if not found then
      insert into public.custody_fresh_tail_wallets (
        epoch_id, user_id, token_mint, wallet, parent_wallet,
        discovery_event_id, discovery_event_key, discovery_slot, floor_slot,
        boundary_kind, watch_status, classification,
        classification_reliable, added_revision
      ) values (
        p_epoch_id, p_user_id, v_token_mint, v_edge.destination_wallet,
        v_edge.source_wallet, v_edge.custody_event_id, v_edge.event_key,
        v_edge.discovery_slot, v_edge.discovery_slot, 'inclusive_slot',
        'active', v_edge.classification, true, v_revision
      );
      insert into public.custody_fresh_tail_cursors (
        epoch_id, user_id, scope_mint, wallet, cursor_role, floor_slot,
        initial_boundary_kind, current_boundary_kind, coverage_revision,
        backlog_detected, last_error, last_lease_generation
      ) values (
        p_epoch_id, p_user_id, v_token_mint, v_edge.destination_wallet,
        'descendant', v_edge.discovery_slot, 'inclusive_slot', 'inclusive_slot',
        v_revision, true, 'new_descendant_requires_scan', p_lease_generation
      );
      v_added := array_append(v_added, v_edge.destination_wallet);
    elsif v_edge.discovery_slot < v_wallet.discovery_slot then
      -- Preserve the advanced main cursor.  The lower inclusive floor gets a
      -- separate fenced lane, and the wallet's provenance records the true
      -- earliest edge for all future decisions.
      update public.custody_fresh_tail_wallets set
        parent_wallet = v_edge.source_wallet,
        discovery_event_id = v_edge.custody_event_id,
        discovery_event_key = v_edge.event_key,
        discovery_slot = v_edge.discovery_slot,
        floor_slot = v_edge.discovery_slot,
        classification = v_edge.classification,
        added_revision = v_revision,
        updated_at = now()
      where epoch_id = p_epoch_id and token_mint = v_token_mint
        and wallet = v_edge.destination_wallet;
      insert into public.custody_fresh_tail_backscan_ranges (
        epoch_id, user_id, token_mint, wallet, source_edge_event_id,
        floor_slot, coverage_revision, backlog_detected, last_error,
        last_lease_generation
      ) values (
        p_epoch_id, p_user_id, v_token_mint, v_edge.destination_wallet,
        v_edge.custody_event_id, v_edge.discovery_slot, v_revision, true,
        'retrograde_discovery_requires_backscan', p_lease_generation
      ) on conflict (epoch_id, token_mint, wallet, source_edge_event_id)
        do update set coverage_revision = excluded.coverage_revision,
          backlog_detected = true,
          last_error = excluded.last_error,
          updated_at = now()
      returning id into v_range_id;
      v_backscan_ids := array_append(v_backscan_ids, v_range_id);
    end if;
  end loop;

  update public.custody_fresh_tail_edges set
    applied_revision = v_revision, scope_applied_at = now()
  where epoch_id = p_epoch_id and token_mint = v_token_mint
    and applied_revision is null;
  update public.custody_fresh_tail_mints set
    scope_revision = v_revision, updated_at = now()
  where epoch_id = p_epoch_id and token_mint = v_token_mint;
  update public.custody_fresh_tail_epochs set
    scope_revision = scope_revision + 1, updated_at = now()
  where id = p_epoch_id;
  update public.custody_fresh_tail_cursors set
    backlog_detected = true,
    last_error = 'scope_revision_changed',
    updated_at = now()
  where epoch_id = p_epoch_id and scope_mint = v_token_mint
    and coverage_revision < v_revision;
  update public.custody_fresh_tail_backscan_ranges set
    backlog_detected = true,
    last_error = 'scope_revision_changed',
    coverage_revision = v_revision,
    completed_at = null,
    updated_at = now()
  where epoch_id = p_epoch_id and token_mint = v_token_mint
    and coverage_revision < v_revision;
  update public.custody_fresh_tail_requests set
    status = case when expires_at <= clock_timestamp() then 'expired' else 'pending' end,
    scope_revision = v_revision,
    settled_revision = null,
    settled_lease_generation = null,
    settled_at = null,
    invalid_reason = case when expires_at <= clock_timestamp()
      then 'coverage_expired' else null end,
    updated_at = now()
  where epoch_id = p_epoch_id and token_mint = v_token_mint
    and status in ('pending', 'settled');

  return jsonb_build_object(
    'ok', true, 'reason', 'scope_advanced', 'epochId', p_epoch_id,
    'tokenMint', v_token_mint, 'scopeRevision', v_revision,
    'addedWallets', to_jsonb(v_added), 'backscanRangeIds', to_jsonb(v_backscan_ids),
    'poisoned', false
  );
end;
$$;

create or replace function public.retire_custody_fresh_tail_mint(
  p_user_id uuid,
  p_epoch_id uuid,
  p_token_mint text,
  p_expected_scope_revision bigint,
  p_reason text,
  p_lease_token uuid,
  p_lease_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_mint public.custody_fresh_tail_mints%rowtype;
  v_token_mint text := btrim(coalesce(p_token_mint, ''));
  v_reason text := lower(btrim(coalesce(p_reason, '')));
  v_last_supply_at timestamptz;
  v_latest_head_at timestamptz;
begin
  v_epoch := public.assert_custody_fresh_tail_lease(
    p_user_id, p_epoch_id, p_lease_token, p_lease_generation
  );
  if v_token_mint = '' or p_expected_scope_revision is null
     or p_expected_scope_revision < 0
     or v_reason not in (
       'dormant_below_threshold', 'resource_cap', 'unsupported_after_enrollment'
     ) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_retirement');
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(v_token_mint));
  select * into v_mint
  from public.custody_fresh_tail_mints
  where epoch_id = p_epoch_id and user_id = p_user_id
    and token_mint = v_token_mint
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'mint_not_found');
  end if;
  if v_mint.status = 'retired' then
    return jsonb_build_object(
      'ok', v_mint.retire_reason = v_reason,
      'reason', case when v_mint.retire_reason = v_reason
        then 'already_retired' else 'retirement_reason_conflict' end,
      'epochId', p_epoch_id, 'tokenMint', v_token_mint,
      'scopeRevision', v_mint.scope_revision,
      'retireReason', v_mint.retire_reason, 'retiredAt', v_mint.retired_at
    );
  end if;
  if v_mint.scope_revision <> p_expected_scope_revision then
    return jsonb_build_object(
      'ok', false, 'reason', 'scope_revision_conflict',
      'scopeRevision', v_mint.scope_revision
    );
  end if;
  if exists (
    select 1 from public.custody_fresh_tail_requests q
    where q.epoch_id = p_epoch_id and q.token_mint = v_token_mint
      and q.status in ('pending', 'settled')
      and q.expires_at > clock_timestamp()
  ) then
    return jsonb_build_object('ok', false, 'reason', 'fresh_request_still_live');
  end if;
  if exists (
    select 1 from public.entry_signal_claims c
    where c.user_id = p_user_id and c.fresh_tail_epoch_id = p_epoch_id
      and c.token_mint = v_token_mint
      and c.fresh_tail_monitoring_armed_at is not null
      and (
        c.status in ('claimed', 'submitted', 'landed', 'uncertain')
        or (
          c.status = 'persisted'
          and not exists (
            select 1 from public.positions p
            where p.id = c.planned_position_id and p.user_id = c.user_id
              and p.token_mint = c.token_mint and p.closed_at is not null
          )
        )
      )
  ) or exists (
    select 1
    from public.positions p
    join public.entry_signal_claims c on c.planned_position_id = p.id
    where p.user_id = p_user_id and p.token_mint = v_token_mint
      and p.closed_at is null and c.fresh_tail_epoch_id = p_epoch_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'fresh_position_still_armed');
  end if;
  if exists (
    select 1 from public.custody_fresh_tail_exit_intents i
    where i.user_id = p_user_id and i.epoch_id = p_epoch_id
      and i.token_mint = v_token_mint
      and i.status not in ('resolved', 'dismissed')
  ) then
    return jsonb_build_object('ok', false, 'reason', 'fresh_exit_still_unresolved');
  end if;
  if v_reason = 'dormant_below_threshold' then
    -- V1 owns only the first finalized hour of a launch campaign. Retirement
    -- is permanent, so a later revival is deliberately outside this lane.
    select max(h.block_time) into v_latest_head_at
    from public.custody_fresh_tail_finalized_heads h
    where h.epoch_id = p_epoch_id and h.user_id = p_user_id;
    select coalesce(max(e.block_time), v_mint.enrollment_block_time)
    into v_last_supply_at
    from public.custody_fresh_tail_supply_events e
    where e.epoch_id = p_epoch_id and e.token_mint = v_token_mint;
    if v_latest_head_at is null then
      return jsonb_build_object('ok', false, 'reason', 'finalized_head_missing');
    end if;
    if v_last_supply_at is null
       or v_last_supply_at > v_latest_head_at - interval '1 hour' then
      return jsonb_build_object('ok', false, 'reason', 'mint_not_dormant');
    end if;
  end if;

  update public.custody_fresh_tail_requests set
    status = 'invalidated', invalid_reason = 'mint_retired',
    settled_revision = null, settled_lease_generation = null,
    settled_at = null, updated_at = now()
  where epoch_id = p_epoch_id and token_mint = v_token_mint
    and status in ('pending', 'settled');
  update public.custody_fresh_tail_mints set
    status = 'retired', retire_reason = v_reason,
    retired_at = clock_timestamp(), updated_at = now()
  where epoch_id = p_epoch_id and token_mint = v_token_mint
  returning * into v_mint;

  return jsonb_build_object(
    'ok', true, 'reason', 'retired', 'epochId', p_epoch_id,
    'tokenMint', v_token_mint, 'scopeRevision', v_mint.scope_revision,
    'retireReason', v_mint.retire_reason, 'retiredAt', v_mint.retired_at
  );
end;
$$;

create or replace function public.request_custody_fresh_tail_coverage(
  p_user_id uuid,
  p_epoch_id uuid,
  p_token_mint text,
  p_window_started_at timestamptz,
  p_trigger_event_key text,
  p_trigger_tx_sig text,
  p_trigger_slot bigint,
  p_target_wallet text,
  p_trigger_block_time timestamptz,
  p_finalized_head_slot bigint,
  p_finalized_head_blockhash text,
  p_finalized_head_block_time timestamptz,
  p_head_snapshot_parser_abi_fingerprint text,
  p_head_curve_state_fingerprint text,
  p_head_curve_observed_slot bigint,
  p_head_curve_complete boolean,
  p_head_virtual_token_reserves_raw numeric,
  p_head_virtual_sol_reserves_lamports numeric,
  p_head_real_token_reserves_raw numeric,
  p_head_real_sol_reserves_lamports numeric,
  p_head_curve_total_supply_raw numeric,
  p_head_mint_layout_fingerprint text,
  p_head_token_program text,
  p_head_mint_supply_raw numeric,
  p_head_mint_decimals integer,
  p_lease_token uuid,
  p_lease_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_mint public.custody_fresh_tail_mints%rowtype;
  v_config public.bot_config%rowtype;
  v_trigger public.custody_fresh_tail_supply_events%rowtype;
  v_existing public.custody_fresh_tail_requests%rowtype;
  v_request_id uuid;
  v_token_mint text := btrim(coalesce(p_token_mint, ''));
  v_event_key text := btrim(coalesce(p_trigger_event_key, ''));
  v_sig text := btrim(coalesce(p_trigger_tx_sig, ''));
  v_target text := btrim(coalesce(p_target_wallet, ''));
  v_head_hash text := btrim(coalesce(p_finalized_head_blockhash, ''));
  v_head_snapshot_abi text := lower(btrim(coalesce(
    p_head_snapshot_parser_abi_fingerprint, ''
  )));
  v_head_curve_fp text := lower(btrim(coalesce(p_head_curve_state_fingerprint, '')));
  v_head_layout text := lower(btrim(coalesce(p_head_mint_layout_fingerprint, '')));
  v_head_program text := btrim(coalesce(p_head_token_program, ''));
  v_net_raw numeric(78, 0);
  v_threshold_pct numeric;
begin
  v_epoch := public.assert_custody_fresh_tail_lease(
    p_user_id, p_epoch_id, p_lease_token, p_lease_generation
  );
  if v_token_mint = '' or v_event_key = '' or v_sig = '' or v_target = ''
     or p_window_started_at is null or p_trigger_block_time is null
     or p_window_started_at > p_trigger_block_time
     or p_trigger_slot is null or p_trigger_slot <= v_epoch.activation_slot
     or p_finalized_head_slot is null or p_finalized_head_slot < p_trigger_slot
     or v_head_hash = '' or p_finalized_head_block_time is null
     or p_finalized_head_block_time < p_trigger_block_time
     or p_finalized_head_block_time > now()
     or v_head_snapshot_abi <>
       '2f5de97b6527d4ec94082069d65abd2bf30523e45bf562aabe1e770e5eb4ad1d'
     or v_head_curve_fp !~ '^[0-9a-f]{64}$'
     or p_head_curve_observed_slot is distinct from p_finalized_head_slot
     or p_head_curve_complete is distinct from false
     or p_head_virtual_token_reserves_raw is null
     or p_head_virtual_token_reserves_raw <= 0
     or p_head_virtual_sol_reserves_lamports is null
     or p_head_virtual_sol_reserves_lamports <= 0
     or p_head_real_token_reserves_raw is null
     or p_head_real_token_reserves_raw <= 0
     or p_head_real_sol_reserves_lamports is null
     or p_head_real_sol_reserves_lamports < 0
     or p_head_curve_total_supply_raw is null
     or p_head_curve_total_supply_raw <= 0
     or v_head_layout !~ '^[0-9a-f]{64}$'
     or v_head_program = ''
     or p_head_mint_supply_raw is null or p_head_mint_supply_raw <= 0
     or p_head_mint_decimals is null
     or p_head_mint_decimals not between 0 and 18 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_coverage_request');
  end if;
  if not exists (
    select 1 from public.custody_fresh_tail_finalized_heads h
    where h.epoch_id = p_epoch_id and h.user_id = p_user_id
      and h.slot = p_finalized_head_slot and h.blockhash = v_head_hash
      and h.block_time = p_finalized_head_block_time
  ) then
    return jsonb_build_object('ok', false, 'reason', 'finalized_head_not_attested');
  end if;
  if exists (
    select 1 from public.custody_fresh_tail_finalized_heads h
    where h.epoch_id = p_epoch_id and h.slot > p_finalized_head_slot
  ) then
    return jsonb_build_object('ok', false, 'reason', 'finalized_head_not_latest');
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(v_token_mint));
  select * into v_mint
  from public.custody_fresh_tail_mints
  where epoch_id = p_epoch_id and user_id = p_user_id and token_mint = v_token_mint
  for update;
  if not found or v_mint.status <> 'active' or v_mint.poisoned then
    return jsonb_build_object('ok', false, 'reason', 'mint_not_active');
  end if;
  if p_head_curve_total_supply_raw is distinct from v_mint.total_supply_raw
     or v_head_layout <> v_mint.mint_layout_fingerprint
     or v_head_program <> v_mint.token_program
     or p_head_mint_supply_raw is distinct from v_mint.total_supply_raw
     or p_head_mint_decimals is distinct from v_mint.decimals then
    update public.custody_fresh_tail_mints set
      poisoned = true, poison_reason = 'head_curve_or_mint_state_mismatch',
      updated_at = now()
    where epoch_id = p_epoch_id and token_mint = v_token_mint;
    return jsonb_build_object(
      'ok', false, 'reason', 'head_curve_or_mint_state_mismatch'
    );
  end if;
  select * into v_config
  from public.bot_config where user_id = p_user_id for update;
  if not found or v_config.supply_accumulation_mode_enabled is not true
     or v_config.custody_journey_enabled is not true
     or v_config.direct_target_sell_exit_mode = 'proportional' then
    return jsonb_build_object('ok', false, 'reason', 'strategy_not_enabled');
  end if;
  if v_config.supply_accumulation_window_seconds is null
     or p_window_started_at <> p_trigger_block_time - make_interval(
       secs => v_config.supply_accumulation_window_seconds
     ) then
    return jsonb_build_object('ok', false, 'reason', 'window_identity_mismatch');
  end if;

  update public.custody_fresh_tail_requests q set
    status = 'expired', invalid_reason = 'coverage_expired', updated_at = now()
  where q.epoch_id = p_epoch_id and q.token_mint = v_token_mint
    and q.status in ('pending', 'settled')
    and q.expires_at <= clock_timestamp()
    and not exists (
      select 1 from public.entry_signal_claims c
      where c.fresh_tail_request_id = q.id
    );
  if exists (
    select 1 from public.entry_signal_claims c
    where c.user_id = p_user_id and c.fresh_tail_epoch_id = p_epoch_id
      and c.token_mint = v_token_mint
  ) then
    return jsonb_build_object('ok', false, 'reason', 'entry_claim_already_bound');
  end if;

  select * into v_existing
  from public.custody_fresh_tail_requests
  where epoch_id = p_epoch_id and trigger_event_key = v_event_key;
  if found then
    return jsonb_build_object(
      'ok', v_existing.status in ('pending', 'settled'),
      'reason', 'duplicate_request', 'epochId', p_epoch_id,
      'requestId', v_existing.id, 'tokenMint', v_existing.token_mint,
      'triggerEventKey', v_existing.trigger_event_key,
      'triggerSlot', v_existing.trigger_slot,
      'triggerBlockTime', v_existing.trigger_block_time,
      'expiresAt', v_existing.expires_at,
      'requestedHeadSlot', v_existing.requested_head_slot,
      'requestedHeadBlockhash', v_existing.requested_head_blockhash,
      'requestedHeadBlockTime', v_existing.requested_head_block_time,
      'headSnapshotParserAbiFingerprint',
        v_existing.head_snapshot_parser_abi_fingerprint,
      'headCurveStateFingerprint', v_existing.head_curve_state_fingerprint,
      'headCurveObservedSlot', v_existing.head_curve_observed_slot,
      'headCurveComplete', v_existing.head_curve_complete,
      'headVirtualTokenReservesRaw', v_existing.head_virtual_token_reserves_raw::text,
      'headVirtualSolReservesLamports', v_existing.head_virtual_sol_reserves_lamports::text,
      'headRealTokenReservesRaw', v_existing.head_real_token_reserves_raw::text,
      'headRealSolReservesLamports', v_existing.head_real_sol_reserves_lamports::text,
      'headCurveTotalSupplyRaw', v_existing.head_curve_total_supply_raw::text,
      'headMintLayoutFingerprint', v_existing.head_mint_layout_fingerprint,
      'headTokenProgram', v_existing.head_token_program,
      'headMintSupplyRaw', v_existing.head_mint_supply_raw::text,
      'headMintDecimals', v_existing.head_mint_decimals,
      'scopeRevision', v_existing.scope_revision,
      'settledRevision', v_existing.settled_revision,
      'settledLeaseGeneration', v_existing.settled_lease_generation
    );
  end if;
  if exists (
    select 1 from public.custody_fresh_tail_requests
    where epoch_id = p_epoch_id and token_mint = v_token_mint
      and status in ('pending', 'settled')
  ) then
    return jsonb_build_object('ok', false, 'reason', 'live_request_exists');
  end if;

  select * into v_trigger
  from public.custody_fresh_tail_supply_events
  where epoch_id = p_epoch_id and event_key = v_event_key
    and token_mint = v_token_mint
  for update;
  if not found
     or v_trigger.tx_sig <> v_sig or v_trigger.slot <> p_trigger_slot
     or v_trigger.block_time <> p_trigger_block_time
     or v_trigger.target_wallet <> v_target or v_trigger.side <> 'buy'
     or v_trigger.quarantined
     or not v_trigger.market_data_reliable
     or not v_trigger.pump_fun_verified
     or not v_trigger.classification_reliable
     or not public.is_custody_fresh_tail_parser_reviewed(
       v_trigger.parser_domain, v_trigger.parser_abi_fingerprint
     )
     or v_trigger.market_cap_usd is null
     or v_trigger.market_cap_usd < v_config.supply_accumulation_min_market_cap_usd
     or v_trigger.market_cap_usd >= v_config.supply_accumulation_max_market_cap_usd then
    return jsonb_build_object('ok', false, 'reason', 'trigger_not_eligible');
  end if;
  if p_trigger_block_time + interval '55 seconds' <= clock_timestamp() then
    return jsonb_build_object('ok', false, 'reason', 'trigger_expired');
  end if;
  if exists (
    select 1 from public.custody_fresh_tail_supply_events e
    where e.epoch_id = p_epoch_id and e.token_mint = v_token_mint
      and e.side = 'buy' and e.slot = p_trigger_slot
      and e.event_key <> v_event_key
  ) then
    return jsonb_build_object('ok', false, 'reason', 'same_slot_trigger_ambiguous');
  end if;
  if exists (
    select 1 from public.custody_fresh_tail_supply_events e
    where e.epoch_id = p_epoch_id and e.token_mint = v_token_mint
      and e.slot <= p_finalized_head_slot
      and (e.quarantined or not e.classification_reliable
        or not e.pump_fun_verified or e.side = 'sell'
        or not public.is_custody_fresh_tail_parser_reviewed(
          e.parser_domain, e.parser_abi_fingerprint
        ))
  ) or exists (
    select 1 from public.custody_fresh_tail_custody_events e
    where e.epoch_id = p_epoch_id and e.token_mint = v_token_mint
      and e.slot <= p_finalized_head_slot
      and (e.quarantined or e.classification_pending or e.terminal_poison
        or e.event_kind in ('SELL', 'UNRESOLVED_OUTFLOW', 'TERMINAL_OUTFLOW')
        or not public.is_custody_fresh_tail_parser_reviewed(
          e.parser_domain, e.parser_abi_fingerprint
        ))
  ) then
    return jsonb_build_object('ok', false, 'reason', 'fresh_sell_or_poison_seen');
  end if;
  if not exists (
    select 1
    from public.custody_fresh_tail_supply_events s
    join public.custody_fresh_tail_custody_events c
      on c.epoch_id = s.epoch_id and c.token_mint = s.token_mint
     and c.tx_sig = s.tx_sig and c.slot = s.slot
     and c.source_wallet = s.target_wallet and c.amount_raw = s.amount_raw
    where s.epoch_id = p_epoch_id and s.token_mint = v_token_mint
      and s.event_key = v_mint.enrollment_event_key
      and s.tx_sig = v_mint.enrollment_tx_sig
      and s.slot = v_mint.enrollment_slot
      and s.block_time = v_mint.enrollment_block_time
      and s.target_wallet = v_mint.enrollment_target_wallet
      and s.side = 'buy' and c.event_kind = 'TARGET_BUY'
      and not s.quarantined and not c.quarantined
      and s.classification_reliable and c.classification_reliable
      and s.pump_fun_verified
      and public.is_custody_fresh_tail_parser_reviewed(
        s.parser_domain, s.parser_abi_fingerprint
      )
      and public.is_custody_fresh_tail_parser_reviewed(
        c.parser_domain, c.parser_abi_fingerprint
      )
  ) then
    return jsonb_build_object('ok', false, 'reason', 'enrollment_evidence_missing');
  end if;
  if exists (
    select 1 from public.custody_fresh_tail_edges e
    where e.epoch_id = p_epoch_id and e.token_mint = v_token_mint
      and e.applied_revision is null
  ) then
    return jsonb_build_object('ok', false, 'reason', 'scope_not_fixed_point');
  end if;

  select greatest(0, coalesce(sum(case
    when e.side = 'buy' then e.amount_raw else -e.amount_raw end), 0))
  into v_net_raw
  from public.custody_fresh_tail_supply_events e
  where e.epoch_id = p_epoch_id and e.token_mint = v_token_mint
    and e.block_time >= p_window_started_at
    and e.block_time <= p_trigger_block_time
    and e.slot > v_epoch.activation_slot and e.slot <= p_trigger_slot
    and e.target_wallet = any(v_epoch.root_wallets)
    and not e.quarantined and e.classification_reliable and e.pump_fun_verified
    and public.is_custody_fresh_tail_parser_reviewed(
      e.parser_domain, e.parser_abi_fingerprint
    )
    and e.total_supply_raw = v_mint.total_supply_raw
    and e.decimals = v_mint.decimals;
  v_threshold_pct := (v_net_raw * 100) / v_mint.total_supply_raw;
  if v_threshold_pct < v_config.supply_accumulation_threshold_pct then
    return jsonb_build_object(
      'ok', false, 'reason', 'threshold_not_reached',
      'netAcquiredRaw', v_net_raw::text, 'netSupplyPct', v_threshold_pct
    );
  end if;

  insert into public.custody_fresh_tail_requests (
    epoch_id, user_id, token_mint, window_started_at,
    trigger_supply_event_id, trigger_event_key, trigger_tx_sig, trigger_slot,
    trigger_target_wallet, trigger_block_time, expires_at,
    requested_head_slot, requested_head_blockhash, requested_head_block_time,
    head_snapshot_parser_abi_fingerprint,
    head_curve_state_fingerprint, head_curve_observed_slot,
    head_curve_complete, head_virtual_token_reserves_raw,
    head_virtual_sol_reserves_lamports, head_real_token_reserves_raw,
    head_real_sol_reserves_lamports, head_curve_total_supply_raw,
    head_mint_layout_fingerprint, head_token_program,
    head_mint_supply_raw, head_mint_decimals,
    scope_revision
  ) values (
    p_epoch_id, p_user_id, v_token_mint, p_window_started_at,
    v_trigger.id, v_event_key, v_sig, p_trigger_slot, v_target,
    p_trigger_block_time, p_trigger_block_time + interval '55 seconds',
    p_finalized_head_slot, v_head_hash, p_finalized_head_block_time,
    v_head_snapshot_abi,
    v_head_curve_fp, p_head_curve_observed_slot, false,
    p_head_virtual_token_reserves_raw, p_head_virtual_sol_reserves_lamports,
    p_head_real_token_reserves_raw, p_head_real_sol_reserves_lamports,
    p_head_curve_total_supply_raw, v_head_layout, v_head_program,
    p_head_mint_supply_raw, p_head_mint_decimals,
    v_mint.scope_revision
  ) returning id into v_request_id;

  return jsonb_build_object(
    'ok', true, 'reason', 'coverage_requested', 'epochId', p_epoch_id,
    'requestId', v_request_id, 'tokenMint', v_token_mint,
    'triggerEventKey', v_event_key, 'triggerSlot', p_trigger_slot,
    'triggerBlockTime', p_trigger_block_time,
    'expiresAt', p_trigger_block_time + interval '55 seconds',
    'requestedHeadSlot', p_finalized_head_slot,
    'requestedHeadBlockhash', v_head_hash,
    'requestedHeadBlockTime', p_finalized_head_block_time,
    'headSnapshotParserAbiFingerprint', v_head_snapshot_abi,
    'headCurveStateFingerprint', v_head_curve_fp,
    'headCurveObservedSlot', p_head_curve_observed_slot,
    'headCurveComplete', false,
    'headVirtualTokenReservesRaw', p_head_virtual_token_reserves_raw::text,
    'headVirtualSolReservesLamports', p_head_virtual_sol_reserves_lamports::text,
    'headRealTokenReservesRaw', p_head_real_token_reserves_raw::text,
    'headRealSolReservesLamports', p_head_real_sol_reserves_lamports::text,
    'headCurveTotalSupplyRaw', p_head_curve_total_supply_raw::text,
    'headMintLayoutFingerprint', v_head_layout,
    'headTokenProgram', v_head_program,
    'headMintSupplyRaw', p_head_mint_supply_raw::text,
    'headMintDecimals', p_head_mint_decimals,
    'scopeRevision', v_mint.scope_revision, 'settledRevision', null,
    'settledLeaseGeneration', null,
    'amountRaw', v_trigger.amount_raw::text,
    'totalSupplyRaw', v_mint.total_supply_raw::text,
    'netAcquiredRaw', v_net_raw::text,
    'netSupplyPct', v_threshold_pct
  );
end;
$$;

create or replace function public.record_custody_fresh_tail_cursor(
  p_user_id uuid,
  p_epoch_id uuid,
  p_scope_mint text,
  p_wallet text,
  p_expected_last_signature text,
  p_next_last_signature text,
  p_next_last_slot bigint,
  p_last_block_time bigint,
  p_first_available_block bigint,
  p_covered_head_slot bigint,
  p_covered_head_blockhash text,
  p_coverage_revision bigint,
  p_backlog_detected boolean,
  p_last_error text,
  p_lease_token uuid,
  p_lease_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_cursor public.custody_fresh_tail_cursors%rowtype;
  v_scope text := btrim(coalesce(p_scope_mint, ''));
  v_wallet text := btrim(coalesce(p_wallet, ''));
  v_expected text := nullif(btrim(coalesce(p_expected_last_signature, '')), '');
  v_next text := nullif(btrim(coalesce(p_next_last_signature, '')), '');
  v_head_hash text := nullif(btrim(coalesce(p_covered_head_blockhash, '')), '');
  v_history_ok boolean;
begin
  v_epoch := public.assert_custody_fresh_tail_lease(
    p_user_id, p_epoch_id, p_lease_token, p_lease_generation
  );
  if v_scope = '' or v_wallet = '' or p_first_available_block is null
     or p_first_available_block < 0 or p_coverage_revision is null
     or p_coverage_revision < 0 or p_backlog_detected is null
     or ((p_covered_head_slot is null) <> (v_head_hash is null))
     or (p_covered_head_slot is not null and p_covered_head_slot < 0)
     or ((v_next is null) <> (p_next_last_slot is null)) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_cursor_update');
  end if;
  if p_covered_head_slot is not null and not exists (
    select 1 from public.custody_fresh_tail_finalized_heads h
    where h.epoch_id = p_epoch_id and h.user_id = p_user_id
      and h.slot = p_covered_head_slot and h.blockhash = v_head_hash
  ) then
    return jsonb_build_object('ok', false, 'reason', 'finalized_head_not_attested');
  end if;

  select * into v_cursor
  from public.custody_fresh_tail_cursors
  where epoch_id = p_epoch_id and user_id = p_user_id
    and scope_mint = v_scope and wallet = v_wallet
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'cursor_not_found');
  end if;
  if p_covered_head_slot is not null
     and p_covered_head_slot < v_cursor.floor_slot then
    return jsonb_build_object('ok', false, 'reason', 'head_before_cursor_floor');
  end if;
  if v_cursor.last_processed_signature is distinct from v_expected then
    return jsonb_build_object(
      'ok', false, 'reason', 'cursor_cas_conflict',
      'lastSignature', v_cursor.last_processed_signature
    );
  end if;
  if v_cursor.last_processed_signature is not null and v_next is null then
    return jsonb_build_object('ok', false, 'reason', 'exact_signature_required');
  end if;
  if v_next is not null and (
    (v_cursor.initial_boundary_kind = 'exclusive_slot'
      and p_next_last_slot <= v_cursor.floor_slot)
    or
    (v_cursor.initial_boundary_kind = 'inclusive_slot'
      and p_next_last_slot < v_cursor.floor_slot)
  ) then
    return jsonb_build_object('ok', false, 'reason', 'cursor_crossed_floor');
  end if;
  if v_cursor.cursor_role = 'root' and p_coverage_revision <> 0 then
    return jsonb_build_object('ok', false, 'reason', 'root_revision_must_be_zero');
  elsif v_cursor.cursor_role = 'descendant' and not exists (
    select 1 from public.custody_fresh_tail_mints m
    where m.epoch_id = p_epoch_id and m.token_mint = v_scope
      and m.status = 'active'
      and m.scope_revision = p_coverage_revision and not m.poisoned
  ) then
    return jsonb_build_object('ok', false, 'reason', 'scope_revision_conflict');
  end if;

  if p_covered_head_slot is not null and (
    exists (
      select 1 from public.custody_fresh_tail_cursors c
      where c.epoch_id = p_epoch_id
        and c.covered_through_slot = p_covered_head_slot
        and c.covered_through_blockhash is not null
        and c.covered_through_blockhash <> v_head_hash
    ) or exists (
      select 1 from public.custody_fresh_tail_backscan_ranges r
      where r.epoch_id = p_epoch_id
        and r.covered_through_slot = p_covered_head_slot
        and r.covered_through_blockhash is not null
        and r.covered_through_blockhash <> v_head_hash
    ) or exists (
      select 1 from public.custody_fresh_tail_coverage_attestations a
      where a.epoch_id = p_epoch_id
        and a.covered_head_slot = p_covered_head_slot
        and a.covered_head_blockhash <> v_head_hash
    )
  ) then
    update public.custody_fresh_tail_epochs set
      status = 'invalidated', invalid_reason = 'finalized_head_blockhash_conflict',
      updated_at = now()
    where id = p_epoch_id;
    return jsonb_build_object('ok', false, 'reason', 'finalized_head_blockhash_conflict');
  end if;

  v_history_ok := p_first_available_block <= v_cursor.floor_slot;
  update public.custody_fresh_tail_cursors set
    current_boundary_kind = case when v_next is null
      then initial_boundary_kind else 'exact_signature' end,
    last_processed_signature = v_next,
    last_processed_slot = p_next_last_slot,
    last_block_time = p_last_block_time,
    first_available_block = p_first_available_block,
    history_floor_proven = v_history_ok,
    covered_through_slot = case
      when v_history_ok and not p_backlog_detected then p_covered_head_slot
      else covered_through_slot end,
    covered_through_blockhash = case
      when v_history_ok and not p_backlog_detected then v_head_hash
      else covered_through_blockhash end,
    coverage_revision = p_coverage_revision,
    backlog_detected = p_backlog_detected or not v_history_ok,
    last_error = case when not v_history_ok then 'history_floor_unavailable'
      else nullif(btrim(coalesce(p_last_error, '')), '') end,
    last_success_at = case when v_history_ok and not p_backlog_detected
      then now() else last_success_at end,
    last_lease_generation = p_lease_generation,
    updated_at = now()
  where epoch_id = p_epoch_id and scope_mint = v_scope and wallet = v_wallet
  returning * into v_cursor;

  if v_cursor.history_floor_proven and not v_cursor.backlog_detected
     and p_covered_head_slot is not null then
    insert into public.custody_fresh_tail_coverage_attestations (
      epoch_id, user_id, lane_kind, scope_mint, wallet,
      covered_head_slot, covered_head_blockhash, coverage_revision,
      lease_generation
    ) values (
      p_epoch_id, p_user_id, 'main', v_scope, v_wallet,
      p_covered_head_slot, v_head_hash, p_coverage_revision,
      p_lease_generation
    ) on conflict do nothing;
  end if;

  return jsonb_build_object(
    'ok', v_cursor.history_floor_proven and not v_cursor.backlog_detected,
    'reason', case
      when not v_cursor.history_floor_proven then 'history_floor_unavailable'
      when v_cursor.backlog_detected then 'backlog_detected'
      else 'cursor_recorded' end,
    'boundaryKind', v_cursor.current_boundary_kind,
    'lastSignature', v_cursor.last_processed_signature,
    'coveredThroughSlot', v_cursor.covered_through_slot,
    'coveredThroughBlockhash', v_cursor.covered_through_blockhash,
    'coverageRevision', v_cursor.coverage_revision,
    'backlogDetected', v_cursor.backlog_detected
  );
end;
$$;

create or replace function public.record_custody_fresh_tail_backscan_cursor(
  p_user_id uuid,
  p_epoch_id uuid,
  p_range_id uuid,
  p_expected_last_signature text,
  p_next_last_signature text,
  p_next_last_slot bigint,
  p_last_block_time bigint,
  p_first_available_block bigint,
  p_covered_head_slot bigint,
  p_covered_head_blockhash text,
  p_coverage_revision bigint,
  p_backlog_detected boolean,
  p_last_error text,
  p_lease_token uuid,
  p_lease_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_range public.custody_fresh_tail_backscan_ranges%rowtype;
  v_expected text := nullif(btrim(coalesce(p_expected_last_signature, '')), '');
  v_next text := nullif(btrim(coalesce(p_next_last_signature, '')), '');
  v_head_hash text := nullif(btrim(coalesce(p_covered_head_blockhash, '')), '');
  v_history_ok boolean;
begin
  v_epoch := public.assert_custody_fresh_tail_lease(
    p_user_id, p_epoch_id, p_lease_token, p_lease_generation
  );
  if p_range_id is null or p_first_available_block is null
     or p_first_available_block < 0 or p_coverage_revision is null
     or p_coverage_revision < 0 or p_backlog_detected is null
     or ((p_covered_head_slot is null) <> (v_head_hash is null))
     or (p_covered_head_slot is not null and p_covered_head_slot < 0)
     or ((v_next is null) <> (p_next_last_slot is null)) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_backscan_update');
  end if;
  if p_covered_head_slot is not null and not exists (
    select 1 from public.custody_fresh_tail_finalized_heads h
    where h.epoch_id = p_epoch_id and h.user_id = p_user_id
      and h.slot = p_covered_head_slot and h.blockhash = v_head_hash
  ) then
    return jsonb_build_object('ok', false, 'reason', 'finalized_head_not_attested');
  end if;
  select * into v_range
  from public.custody_fresh_tail_backscan_ranges
  where id = p_range_id and epoch_id = p_epoch_id and user_id = p_user_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'backscan_not_found');
  end if;
  if p_covered_head_slot is not null
     and p_covered_head_slot < v_range.floor_slot then
    return jsonb_build_object('ok', false, 'reason', 'head_before_backscan_floor');
  end if;
  if v_range.last_processed_signature is distinct from v_expected then
    return jsonb_build_object(
      'ok', false, 'reason', 'backscan_cas_conflict',
      'lastSignature', v_range.last_processed_signature
    );
  end if;
  if v_range.last_processed_signature is not null and v_next is null then
    return jsonb_build_object('ok', false, 'reason', 'exact_signature_required');
  end if;
  if v_next is not null and p_next_last_slot < v_range.floor_slot then
    return jsonb_build_object('ok', false, 'reason', 'backscan_crossed_floor');
  end if;
  if not exists (
    select 1 from public.custody_fresh_tail_mints m
    where m.epoch_id = p_epoch_id and m.token_mint = v_range.token_mint
      and m.status = 'active'
      and m.scope_revision = p_coverage_revision and not m.poisoned
  ) then
    return jsonb_build_object('ok', false, 'reason', 'scope_revision_conflict');
  end if;
  if p_covered_head_slot is not null and (
    exists (
      select 1 from public.custody_fresh_tail_cursors c
      where c.epoch_id = p_epoch_id
        and c.covered_through_slot = p_covered_head_slot
        and c.covered_through_blockhash is not null
        and c.covered_through_blockhash <> v_head_hash
    ) or exists (
      select 1 from public.custody_fresh_tail_backscan_ranges r
      where r.epoch_id = p_epoch_id
        and r.covered_through_slot = p_covered_head_slot
        and r.covered_through_blockhash is not null
        and r.covered_through_blockhash <> v_head_hash
    ) or exists (
      select 1 from public.custody_fresh_tail_coverage_attestations a
      where a.epoch_id = p_epoch_id
        and a.covered_head_slot = p_covered_head_slot
        and a.covered_head_blockhash <> v_head_hash
    )
  ) then
    update public.custody_fresh_tail_epochs set
      status = 'invalidated', invalid_reason = 'finalized_head_blockhash_conflict',
      updated_at = now()
    where id = p_epoch_id;
    return jsonb_build_object('ok', false, 'reason', 'finalized_head_blockhash_conflict');
  end if;

  v_history_ok := p_first_available_block <= v_range.floor_slot;
  update public.custody_fresh_tail_backscan_ranges set
    current_boundary_kind = case when v_next is null
      then 'inclusive_slot' else 'exact_signature' end,
    last_processed_signature = v_next,
    last_processed_slot = p_next_last_slot,
    last_block_time = p_last_block_time,
    first_available_block = p_first_available_block,
    history_floor_proven = v_history_ok,
    covered_through_slot = case
      when v_history_ok and not p_backlog_detected then p_covered_head_slot
      else covered_through_slot end,
    covered_through_blockhash = case
      when v_history_ok and not p_backlog_detected then v_head_hash
      else covered_through_blockhash end,
    coverage_revision = p_coverage_revision,
    backlog_detected = p_backlog_detected or not v_history_ok,
    last_error = case when not v_history_ok then 'history_floor_unavailable'
      else nullif(btrim(coalesce(p_last_error, '')), '') end,
    last_success_at = case when v_history_ok and not p_backlog_detected
      then now() else last_success_at end,
    last_lease_generation = p_lease_generation,
    completed_at = case when v_history_ok and not p_backlog_detected
      and p_covered_head_slot is not null then now() else null end,
    updated_at = now()
  where id = p_range_id
  returning * into v_range;

  if v_range.history_floor_proven and not v_range.backlog_detected
     and p_covered_head_slot is not null then
    insert into public.custody_fresh_tail_coverage_attestations (
      epoch_id, user_id, lane_kind, range_id, covered_head_slot,
      covered_head_blockhash, coverage_revision, lease_generation
    ) values (
      p_epoch_id, p_user_id, 'backscan', p_range_id, p_covered_head_slot,
      v_head_hash, p_coverage_revision, p_lease_generation
    ) on conflict do nothing;
  end if;

  return jsonb_build_object(
    'ok', v_range.history_floor_proven and not v_range.backlog_detected,
    'reason', case
      when not v_range.history_floor_proven then 'history_floor_unavailable'
      when v_range.backlog_detected then 'backlog_detected'
      else 'backscan_recorded' end,
    'rangeId', v_range.id, 'boundaryKind', v_range.current_boundary_kind,
    'lastSignature', v_range.last_processed_signature,
    'coveredThroughSlot', v_range.covered_through_slot,
    'coveredThroughBlockhash', v_range.covered_through_blockhash,
    'coverageRevision', v_range.coverage_revision,
    'backlogDetected', v_range.backlog_detected
  );
end;
$$;

create or replace function public.settle_custody_fresh_tail_request(
  p_user_id uuid,
  p_epoch_id uuid,
  p_request_id uuid,
  p_expected_scope_revision bigint,
  p_lease_token uuid,
  p_lease_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_request public.custody_fresh_tail_requests%rowtype;
  v_mint public.custody_fresh_tail_mints%rowtype;
  v_observed_at timestamptz;
begin
  v_epoch := public.assert_custody_fresh_tail_lease(
    p_user_id, p_epoch_id, p_lease_token, p_lease_generation
  );
  if p_request_id is null or p_expected_scope_revision is null
     or p_expected_scope_revision < 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_settlement_request');
  end if;

  select * into v_request
  from public.custody_fresh_tail_requests
  where id = p_request_id and epoch_id = p_epoch_id and user_id = p_user_id
  for update;
  if not found or v_request.status not in ('pending', 'settled') then
    return jsonb_build_object('ok', false, 'reason', 'request_not_live');
  end if;
  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(v_request.token_mint));
  select * into v_mint
  from public.custody_fresh_tail_mints
  where epoch_id = p_epoch_id and token_mint = v_request.token_mint
  for update;
  if not found or v_mint.status <> 'active' or v_mint.poisoned then
    return jsonb_build_object('ok', false, 'reason', 'mint_not_active');
  end if;
  if v_request.expires_at <= clock_timestamp() then
    update public.custody_fresh_tail_requests set
      status = 'expired', invalid_reason = 'coverage_expired',
      settled_revision = null, settled_lease_generation = null,
      settled_at = null, updated_at = now()
    where id = p_request_id;
    return jsonb_build_object('ok', false, 'reason', 'request_expired');
  end if;
  if v_mint.scope_revision <> p_expected_scope_revision
     or v_request.scope_revision <> p_expected_scope_revision then
    return jsonb_build_object(
      'ok', false, 'reason', 'scope_revision_conflict',
      'scopeRevision', v_mint.scope_revision
    );
  end if;

  if (select count(*) from public.custody_fresh_tail_roots
      where epoch_id = p_epoch_id) <> 3
     or (select count(*) from public.custody_fresh_tail_cursors
         where epoch_id = p_epoch_id and cursor_role = 'root'
           and scope_mint = '*') <> 3
     or exists (
       select 1
       from public.custody_fresh_tail_roots r
       left join public.custody_fresh_tail_cursors c
         on c.epoch_id = r.epoch_id and c.scope_mint = '*'
        and c.wallet = r.wallet and c.cursor_role = 'root'
       where r.epoch_id = p_epoch_id
         and (
           c.wallet is null or c.backlog_detected or not c.history_floor_proven
           or not exists (
             select 1 from public.custody_fresh_tail_coverage_attestations a
             where a.epoch_id = p_epoch_id and a.lane_kind = 'main'
               and a.scope_mint = '*' and a.wallet = r.wallet
               and a.covered_head_slot = v_request.requested_head_slot
               and a.covered_head_blockhash = v_request.requested_head_blockhash
               and a.coverage_revision = 0
               and a.lease_generation = p_lease_generation
           )
         )
     ) then
    return jsonb_build_object('ok', false, 'reason', 'root_coverage_incomplete');
  end if;

  if exists (
    select 1
    from public.custody_fresh_tail_wallets w
    left join public.custody_fresh_tail_cursors c
      on c.epoch_id = w.epoch_id and c.scope_mint = w.token_mint
     and c.wallet = w.wallet and c.cursor_role = 'descendant'
    where w.epoch_id = p_epoch_id and w.token_mint = v_request.token_mint
      and (
        w.watch_status <> 'active' or not w.classification_reliable
        or c.wallet is null or c.backlog_detected or not c.history_floor_proven
        or c.coverage_revision <> p_expected_scope_revision
        or not exists (
          select 1 from public.custody_fresh_tail_coverage_attestations a
          where a.epoch_id = p_epoch_id and a.lane_kind = 'main'
            and a.scope_mint = w.token_mint and a.wallet = w.wallet
            and a.covered_head_slot = v_request.requested_head_slot
            and a.covered_head_blockhash = v_request.requested_head_blockhash
            and a.coverage_revision = p_expected_scope_revision
            and a.lease_generation = p_lease_generation
        )
      )
  ) then
    return jsonb_build_object('ok', false, 'reason', 'descendant_coverage_incomplete');
  end if;

  if exists (
    select 1 from public.custody_fresh_tail_backscan_ranges r
    where r.epoch_id = p_epoch_id and r.token_mint = v_request.token_mint
      and (
        r.coverage_revision <> p_expected_scope_revision
        or r.backlog_detected or not r.history_floor_proven
        or not exists (
          select 1 from public.custody_fresh_tail_coverage_attestations a
          where a.epoch_id = p_epoch_id and a.lane_kind = 'backscan'
            and a.range_id = r.id
            and a.covered_head_slot = v_request.requested_head_slot
            and a.covered_head_blockhash = v_request.requested_head_blockhash
            and a.coverage_revision = p_expected_scope_revision
            and a.lease_generation = p_lease_generation
        )
      )
  ) then
    return jsonb_build_object('ok', false, 'reason', 'backscan_coverage_incomplete');
  end if;

  if exists (
    select 1 from public.custody_fresh_tail_edges e
    where e.epoch_id = p_epoch_id and e.token_mint = v_request.token_mint
      and e.applied_revision is null
  ) then
    return jsonb_build_object('ok', false, 'reason', 'scope_not_fixed_point');
  end if;
  if not exists (
    select 1 from public.custody_fresh_tail_custody_events e
    where e.epoch_id = p_epoch_id and e.token_mint = v_request.token_mint
      and e.event_kind = 'TARGET_BUY'
      and e.tx_sig = v_request.trigger_tx_sig
      and e.slot = v_request.trigger_slot
      and e.source_wallet = v_request.trigger_target_wallet
      and e.classification_reliable and not e.quarantined
      and not e.terminal_poison
      and public.is_custody_fresh_tail_parser_reviewed(
        e.parser_domain, e.parser_abi_fingerprint
      )
  ) then
    return jsonb_build_object('ok', false, 'reason', 'fresh_target_buy_missing');
  end if;
  if not exists (
    select 1
    from public.custody_fresh_tail_supply_events s
    join public.custody_fresh_tail_custody_events c
      on c.epoch_id = s.epoch_id and c.token_mint = s.token_mint
     and c.tx_sig = s.tx_sig and c.slot = s.slot
     and c.source_wallet = s.target_wallet and c.amount_raw = s.amount_raw
    where s.epoch_id = p_epoch_id and s.token_mint = v_request.token_mint
      and s.event_key = v_mint.enrollment_event_key
      and s.tx_sig = v_mint.enrollment_tx_sig
      and s.slot = v_mint.enrollment_slot
      and s.block_time = v_mint.enrollment_block_time
      and s.target_wallet = v_mint.enrollment_target_wallet
      and s.side = 'buy' and c.event_kind = 'TARGET_BUY'
      and not s.quarantined and not c.quarantined
      and s.classification_reliable and c.classification_reliable
      and s.pump_fun_verified
      and public.is_custody_fresh_tail_parser_reviewed(
        s.parser_domain, s.parser_abi_fingerprint
      )
      and public.is_custody_fresh_tail_parser_reviewed(
        c.parser_domain, c.parser_abi_fingerprint
      )
  ) then
    return jsonb_build_object('ok', false, 'reason', 'enrollment_evidence_missing');
  end if;
  if exists (
    select 1 from public.custody_fresh_tail_supply_events e
    where e.epoch_id = p_epoch_id and e.token_mint = v_request.token_mint
      and e.slot <= v_request.requested_head_slot
      and (e.side = 'sell' or e.quarantined or not e.classification_reliable
        or not e.pump_fun_verified
        or not public.is_custody_fresh_tail_parser_reviewed(
          e.parser_domain, e.parser_abi_fingerprint
        ))
  ) or exists (
    select 1 from public.custody_fresh_tail_custody_events e
    where e.epoch_id = p_epoch_id and e.token_mint = v_request.token_mint
      and e.slot <= v_request.requested_head_slot
      and (e.event_kind in ('SELL', 'UNRESOLVED_OUTFLOW', 'TERMINAL_OUTFLOW')
        or e.quarantined or e.classification_pending or e.terminal_poison
        or not public.is_custody_fresh_tail_parser_reviewed(
          e.parser_domain, e.parser_abi_fingerprint
        ))
  ) then
    return jsonb_build_object('ok', false, 'reason', 'fresh_sell_or_poison_seen');
  end if;
  -- Legacy state is never positive authority.  It is consulted only as an
  -- additional permanent poison source.
  if exists (
    select 1 from public.custody_pending_events p
    where p.user_id = p_user_id and p.token_mint = v_request.token_mint
      and p.event_at >= v_epoch.activation_block_time
      and (
        p.status in ('expired', 'terminal')
        or coalesce(p.last_error_code, '') = 'payload_mismatch'
      )
  ) or exists (
    select 1 from public.custody_journeys j
    where j.user_id = p_user_id and j.token_mint = v_request.token_mint
      and j.status = 'active'
      and (j.first_event_key <> v_mint.enrollment_event_key
        or j.total_unresolved_outflow_tokens > 0)
  ) then
    return jsonb_build_object('ok', false, 'reason', 'legacy_poison_seen');
  end if;

  v_observed_at := clock_timestamp();
  update public.custody_fresh_tail_requests set
    status = 'settled', settled_revision = p_expected_scope_revision,
    settled_lease_generation = p_lease_generation,
    settled_at = v_observed_at, invalid_reason = null, updated_at = now()
  where id = p_request_id
  returning * into v_request;

  return jsonb_build_object(
    'ok', true, 'reason', 'settled', 'epochId', p_epoch_id,
    'requestId', v_request.id, 'tokenMint', v_request.token_mint,
    'triggerEventKey', v_request.trigger_event_key,
    'triggerSlot', v_request.trigger_slot,
    'triggerBlockTime', v_request.trigger_block_time,
    'expiresAt', v_request.expires_at,
    'requestedHeadSlot', v_request.requested_head_slot,
    'requestedHeadBlockhash', v_request.requested_head_blockhash,
    'requestedHeadBlockTime', v_request.requested_head_block_time,
    'headSnapshotParserAbiFingerprint',
      v_request.head_snapshot_parser_abi_fingerprint,
    'headCurveStateFingerprint', v_request.head_curve_state_fingerprint,
    'headCurveObservedSlot', v_request.head_curve_observed_slot,
    'headCurveComplete', v_request.head_curve_complete,
    'headVirtualTokenReservesRaw', v_request.head_virtual_token_reserves_raw::text,
    'headVirtualSolReservesLamports', v_request.head_virtual_sol_reserves_lamports::text,
    'headRealTokenReservesRaw', v_request.head_real_token_reserves_raw::text,
    'headRealSolReservesLamports', v_request.head_real_sol_reserves_lamports::text,
    'headCurveTotalSupplyRaw', v_request.head_curve_total_supply_raw::text,
    'headMintLayoutFingerprint', v_request.head_mint_layout_fingerprint,
    'headTokenProgram', v_request.head_token_program,
    'headMintSupplyRaw', v_request.head_mint_supply_raw::text,
    'headMintDecimals', v_request.head_mint_decimals,
    'scopeRevision', v_request.scope_revision,
    'settledRevision', v_request.settled_revision,
    'settledLeaseGeneration', v_request.settled_lease_generation,
    'proofObservedAt', v_observed_at
  );
end;
$$;

create or replace function public.bind_supply_entry_claim_fresh_tail(
  p_user_id uuid,
  p_claim_id uuid,
  p_epoch_id uuid,
  p_request_id uuid,
  p_source_tx_sig text,
  p_source_wallet text,
  p_token_mint text,
  p_source_slot bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_claim public.entry_signal_claims%rowtype;
  v_request public.custody_fresh_tail_requests%rowtype;
  v_sig text := btrim(coalesce(p_source_tx_sig, ''));
  v_wallet text := btrim(coalesce(p_source_wallet, ''));
  v_mint text := btrim(coalesce(p_token_mint, ''));
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;
  if p_user_id is null or p_claim_id is null or p_epoch_id is null
     or p_request_id is null or v_sig = '' or v_wallet = '' or v_mint = ''
     or p_source_slot is null or p_source_slot < 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_claim_binding');
  end if;
  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(v_mint));
  select * into v_epoch
  from public.custody_fresh_tail_epochs
  where id = p_epoch_id and user_id = p_user_id;
  if not found or v_epoch.status <> 'active'
     or v_epoch.lease_token is null or v_epoch.lease_owner is null
     or v_epoch.lease_expires_at is null
     or v_epoch.lease_expires_at <= clock_timestamp() then
    return jsonb_build_object('ok', false, 'reason', 'fresh_tail_monitor_stale');
  end if;
  select * into v_request
  from public.custody_fresh_tail_requests
  where id = p_request_id and epoch_id = p_epoch_id and user_id = p_user_id
  for update;
  if not found or v_request.status <> 'settled'
     or v_request.expires_at <= clock_timestamp()
     or v_request.settled_at is null
     or v_request.settled_at < clock_timestamp() - interval '4 seconds'
     or v_request.settled_revision is distinct from v_request.scope_revision
     or v_request.settled_lease_generation is distinct from v_epoch.lease_generation
     or v_request.trigger_tx_sig <> v_sig
     or v_request.trigger_target_wallet <> v_wallet
     or v_request.token_mint <> v_mint
     or v_request.trigger_slot <> p_source_slot then
    return jsonb_build_object('ok', false, 'reason', 'request_binding_mismatch');
  end if;
  select * into v_claim
  from public.entry_signal_claims
  where id = p_claim_id and user_id = p_user_id
  for update;
  if not found
     or v_claim.status <> 'claimed'
     or v_claim.entry_strategy <> 'supply_accumulation'
     or v_claim.source_tx_sig <> v_sig
     or v_claim.source_wallet <> v_wallet
     or v_claim.token_mint <> v_mint
     or v_claim.source_slot is distinct from p_source_slot then
    return jsonb_build_object('ok', false, 'reason', 'entry_claim_mismatch');
  end if;
  if v_claim.fresh_tail_epoch_id is not null then
    return jsonb_build_object(
      'ok', v_claim.fresh_tail_epoch_id = p_epoch_id
        and v_claim.fresh_tail_request_id = p_request_id,
      'reason', case
        when v_claim.fresh_tail_epoch_id = p_epoch_id
          and v_claim.fresh_tail_request_id = p_request_id
        then 'already_bound' else 'claim_already_bound_elsewhere' end,
      'claimId', v_claim.id, 'epochId', v_claim.fresh_tail_epoch_id,
      'requestId', v_claim.fresh_tail_request_id,
      'positionId', v_claim.planned_position_id, 'bound', true
    );
  end if;

  update public.entry_signal_claims set
    fresh_tail_epoch_id = p_epoch_id,
    fresh_tail_request_id = p_request_id,
    fresh_tail_monitoring_armed_at = clock_timestamp(),
    updated_at = now()
  where id = p_claim_id
    and fresh_tail_epoch_id is null and fresh_tail_request_id is null
  returning * into v_claim;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'claim_binding_cas_conflict');
  end if;

  insert into public.custody_fresh_tail_exit_intents (
    user_id, epoch_id, request_id, token_mint, entry_claim_id,
    position_id, source_domain, supply_event_id, trigger_kind
  )
  select p_user_id, p_epoch_id, p_request_id, v_mint, p_claim_id,
    v_claim.planned_position_id, 'supply', e.id, 'direct_target_sell'
  from public.custody_fresh_tail_supply_events e
  where e.epoch_id = p_epoch_id and e.token_mint = v_mint
    and e.side = 'sell' and e.slot >= p_source_slot
  on conflict do nothing;

  insert into public.custody_fresh_tail_exit_intents (
    user_id, epoch_id, request_id, token_mint, entry_claim_id,
    position_id, source_domain, custody_event_id, trigger_kind
  )
  select p_user_id, p_epoch_id, p_request_id, v_mint, p_claim_id,
    v_claim.planned_position_id, 'custody', e.id,
    case
      when e.event_kind = 'SELL' then 'mirror_custody_sell'
      else 'terminal_outflow'
    end
  from public.custody_fresh_tail_custody_events e
  where e.epoch_id = p_epoch_id and e.token_mint = v_mint
    and e.slot >= p_source_slot
    and (
      e.event_kind in ('SELL', 'UNRESOLVED_OUTFLOW', 'TERMINAL_OUTFLOW')
      or e.terminal_poison or not e.watchable
    )
    and not (
      e.event_kind = 'SELL' and exists (
        select 1 from public.custody_fresh_tail_roots r
        where r.epoch_id = p_epoch_id and r.wallet = e.source_wallet
      )
    )
  on conflict do nothing;

  return jsonb_build_object(
    'ok', true, 'reason', 'bound_and_armed', 'claimId', v_claim.id,
    'epochId', p_epoch_id, 'requestId', p_request_id,
    'positionId', v_claim.planned_position_id, 'bound', true,
    'armedAt', v_claim.fresh_tail_monitoring_armed_at
  );
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'request_already_claimed');
end;
$$;

create or replace function public.record_supply_entry_claim_fresh_tail_receipt(
  p_user_id uuid,
  p_claim_id uuid,
  p_epoch_id uuid,
  p_request_id uuid,
  p_bot_tx_sig text,
  p_received_amount_raw text,
  p_received_token_decimals integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_claim public.entry_signal_claims%rowtype;
  v_request public.custody_fresh_tail_requests%rowtype;
  v_mint public.custody_fresh_tail_mints%rowtype;
  v_signature text := btrim(coalesce(p_bot_tx_sig, ''));
  v_received_raw numeric(78, 0);
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;
  if p_user_id is null or p_claim_id is null or p_epoch_id is null
     or p_request_id is null or v_signature = ''
     or p_received_amount_raw is null
     or p_received_amount_raw !~ '^[1-9][0-9]*$'
     or char_length(p_received_amount_raw) > 78
     or p_received_token_decimals is null
     or p_received_token_decimals not between 0 and 18 then
    return jsonb_build_object(
      'ok', false, 'replay', false, 'reason', 'invalid_entry_receipt'
    );
  end if;
  v_received_raw := p_received_amount_raw::numeric;

  perform pg_advisory_xact_lock(
    hashtext(p_user_id::text), hashtext(p_claim_id::text)
  );
  select * into v_claim
  from public.entry_signal_claims
  where id = p_claim_id and user_id = p_user_id
  for update;
  if not found then
    return jsonb_build_object(
      'ok', false, 'replay', false, 'reason', 'entry_claim_not_found'
    );
  end if;
  if v_claim.entry_strategy <> 'supply_accumulation'
     or v_claim.entry_mode <> 'regular'
     or v_claim.fresh_tail_epoch_id is distinct from p_epoch_id
     or v_claim.fresh_tail_request_id is distinct from p_request_id
     or v_claim.fresh_tail_monitoring_armed_at is null then
    return jsonb_build_object(
      'ok', false, 'replay', false, 'reason', 'entry_receipt_binding_mismatch',
      'claimId', v_claim.id, 'positionId', v_claim.planned_position_id
    );
  end if;
  if v_claim.bot_tx_sig is distinct from v_signature
     or v_claim.submission_started_at is null
     or v_claim.last_valid_block_height is null
     or v_claim.last_valid_block_height <= 0
     or v_claim.fresh_tail_monitoring_armed_at > v_claim.submission_started_at then
    return jsonb_build_object(
      'ok', false, 'replay', false, 'reason', 'prepared_entry_identity_mismatch',
      'claimId', v_claim.id, 'positionId', v_claim.planned_position_id
    );
  end if;

  select * into v_request
  from public.custody_fresh_tail_requests
  where id = p_request_id and epoch_id = p_epoch_id and user_id = p_user_id;
  if not found
     or v_request.token_mint <> v_claim.token_mint
     or v_request.trigger_tx_sig <> v_claim.source_tx_sig
     or v_request.trigger_target_wallet <> v_claim.source_wallet
     or v_request.trigger_slot is distinct from v_claim.source_slot then
    return jsonb_build_object(
      'ok', false, 'replay', false, 'reason', 'entry_receipt_request_mismatch',
      'claimId', v_claim.id, 'positionId', v_claim.planned_position_id
    );
  end if;
  select * into v_mint
  from public.custody_fresh_tail_mints
  where epoch_id = p_epoch_id and user_id = p_user_id
    and token_mint = v_claim.token_mint;
  if not found
     or v_mint.decimals <> p_received_token_decimals
     or v_claim.token_decimals is distinct from p_received_token_decimals
     or v_received_raw > v_mint.total_supply_raw then
    return jsonb_build_object(
      'ok', false, 'replay', false, 'reason', 'entry_receipt_mint_mismatch',
      'claimId', v_claim.id, 'positionId', v_claim.planned_position_id
    );
  end if;

  if v_claim.status in ('landed', 'persisted') then
    if v_claim.received_amount_raw is distinct from p_received_amount_raw
       or v_claim.received_token_decimals is distinct from p_received_token_decimals
       or v_claim.landed_at is null then
      return jsonb_build_object(
        'ok', false, 'replay', false, 'reason', 'landed_entry_receipt_mismatch',
        'claimId', v_claim.id, 'positionId', v_claim.planned_position_id
      );
    end if;
    return jsonb_build_object(
      'ok', true, 'replay', true, 'reason', 'entry_receipt_already_recorded',
      'claimId', v_claim.id, 'positionId', v_claim.planned_position_id,
      'botTxSig', v_signature, 'receivedAmountRaw', v_claim.received_amount_raw,
      'receivedTokenDecimals', v_claim.received_token_decimals,
      'landedAt', v_claim.landed_at, 'status', v_claim.status
    );
  end if;
  if v_claim.status not in ('submitted', 'uncertain')
     or v_claim.received_amount_raw is not null
     or v_claim.received_token_decimals is not null
     or v_claim.landed_at is not null then
    return jsonb_build_object(
      'ok', false, 'replay', false, 'reason', 'entry_receipt_state_invalid',
      'claimId', v_claim.id, 'positionId', v_claim.planned_position_id,
      'status', v_claim.status
    );
  end if;

  update public.entry_signal_claims set
    status = 'landed',
    received_amount_raw = p_received_amount_raw,
    received_token_decimals = p_received_token_decimals,
    error_code = null,
    landed_at = clock_timestamp(),
    updated_at = now()
  where id = v_claim.id and user_id = p_user_id
    and status in ('submitted', 'uncertain')
    and bot_tx_sig = v_signature
    and fresh_tail_epoch_id = p_epoch_id
    and fresh_tail_request_id = p_request_id
    and received_amount_raw is null
    and received_token_decimals is null
    and landed_at is null
  returning * into v_claim;
  if not found then
    raise exception using
      errcode = '40001',
      message = 'fresh-tail entry receipt claim changed during exact CAS';
  end if;

  return jsonb_build_object(
    'ok', true, 'replay', false, 'reason', 'entry_receipt_recorded',
    'claimId', v_claim.id, 'positionId', v_claim.planned_position_id,
    'botTxSig', v_signature, 'receivedAmountRaw', v_claim.received_amount_raw,
    'receivedTokenDecimals', v_claim.received_token_decimals,
    'landedAt', v_claim.landed_at, 'status', v_claim.status
  );
end;
$$;

create or replace function public.claim_custody_fresh_tail_exit_intents(
  p_user_id uuid,
  p_worker_id text,
  p_limit integer default 25,
  p_claim_seconds integer default 180
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_intents jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;
  if p_user_id is null or v_worker = ''
     or p_limit is null or p_limit not between 1 and 100
     or p_claim_seconds is null or p_claim_seconds not between 180 and 600 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_intent_claim');
  end if;

  with candidates as materialized (
    select i.id
    from public.custody_fresh_tail_exit_intents i
    where i.user_id = p_user_id
      and (
        i.status = 'pending'
        or (
          i.status = 'retry'
          and i.updated_at <= clock_timestamp() - interval '1 second'
        )
        or (i.status = 'claimed' and i.claim_expires_at <= clock_timestamp())
      )
    order by case when i.status = 'pending' then 0 else 1 end, i.created_at, i.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update public.custody_fresh_tail_exit_intents i set
      status = 'claimed', disposition = null, worker_id = v_worker,
      claim_token = gen_random_uuid(),
      claim_generation = i.claim_generation + 1,
      claim_expires_at = clock_timestamp() + make_interval(secs => p_claim_seconds),
      updated_at = now()
    from candidates c
    where i.id = c.id
    returning i.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'intentId', i.id, 'claimToken', i.claim_token,
    'claimGeneration', i.claim_generation, 'claimExpiresAt', i.claim_expires_at,
    'entryClaimId', i.entry_claim_id, 'positionId', i.position_id,
    'epochId', i.epoch_id, 'requestId', i.request_id,
    'tokenMint', i.token_mint, 'sourceDomain', i.source_domain,
    'eventId', coalesce(i.supply_event_id, i.custody_event_id),
    'eventKey', coalesce(se.event_key, ce.event_key),
    'eventKind', coalesce(ce.event_kind, upper(se.side)),
    'triggerKind', i.trigger_kind, 'txSig', coalesce(se.tx_sig, ce.tx_sig),
    'slot', coalesce(se.slot, ce.slot),
    'blockTime', coalesce(se.block_time, ce.block_time),
    'sourceWallet', coalesce(se.target_wallet, ce.source_wallet),
    'amountRaw', coalesce(se.amount_raw, ce.amount_raw)::text,
    'decimals', coalesce(se.decimals, ce.decimals),
    'recipients', coalesce(ce.recipients, '[]'::jsonb),
    'classification', ce.classification,
    'classificationReliable', coalesce(se.classification_reliable, ce.classification_reliable),
    'watchable', ce.watchable, 'status', i.status
  ) order by i.created_at, i.id), '[]'::jsonb) into v_intents
  from claimed i
  left join public.custody_fresh_tail_supply_events se on se.id = i.supply_event_id
  left join public.custody_fresh_tail_custody_events ce on ce.id = i.custody_event_id;

  return jsonb_build_object('ok', true, 'reason', 'claimed', 'intents', v_intents);
end;
$$;

-- Uncertain execution is never returned by the normal execution claim.  A
-- reconciler must claim it through this separate API and prove the prior
-- transaction outcome before choosing resolved or retry.
create or replace function public.claim_custody_fresh_tail_uncertain_intents(
  p_user_id uuid,
  p_worker_id text,
  p_limit integer default 25,
  p_claim_seconds integer default 180
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_intents jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;
  if p_user_id is null or v_worker = ''
     or p_limit is null or p_limit not between 1 and 100
     or p_claim_seconds is null or p_claim_seconds not between 180 and 600 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_uncertain_claim');
  end if;

  with candidates as materialized (
    select i.id
    from public.custody_fresh_tail_exit_intents i
    where i.user_id = p_user_id and i.status = 'uncertain'
      and (i.claim_token is null or i.claim_expires_at <= clock_timestamp())
    order by i.updated_at, i.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update public.custody_fresh_tail_exit_intents i set
      worker_id = v_worker, claim_token = gen_random_uuid(),
      claim_generation = i.claim_generation + 1,
      claim_expires_at = clock_timestamp() + make_interval(secs => p_claim_seconds),
      updated_at = now()
    from candidates c
    where i.id = c.id
    returning i.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'intentId', i.id, 'claimToken', i.claim_token,
    'claimGeneration', i.claim_generation, 'claimExpiresAt', i.claim_expires_at,
    'entryClaimId', i.entry_claim_id, 'positionId', i.position_id,
    'epochId', i.epoch_id, 'requestId', i.request_id,
    'tokenMint', i.token_mint, 'sourceDomain', i.source_domain,
    'eventId', coalesce(i.supply_event_id, i.custody_event_id),
    'eventKey', coalesce(se.event_key, ce.event_key),
    'eventKind', coalesce(ce.event_kind, upper(se.side)),
    'triggerKind', i.trigger_kind, 'txSig', coalesce(se.tx_sig, ce.tx_sig),
    'slot', coalesce(se.slot, ce.slot),
    'blockTime', coalesce(se.block_time, ce.block_time),
    'sourceWallet', coalesce(se.target_wallet, ce.source_wallet),
    'amountRaw', coalesce(se.amount_raw, ce.amount_raw)::text,
    'decimals', coalesce(se.decimals, ce.decimals),
    'recipients', coalesce(ce.recipients, '[]'::jsonb),
    'classification', ce.classification,
    'classificationReliable', coalesce(se.classification_reliable, ce.classification_reliable),
    'watchable', ce.watchable,
    'priorSellClaimId', i.sell_claim_id, 'priorBotTxSig', i.bot_tx_sig,
    'priorErrorCode', i.error_code, 'status', i.status
  ) order by i.updated_at, i.id), '[]'::jsonb) into v_intents
  from claimed i
  left join public.custody_fresh_tail_supply_events se on se.id = i.supply_event_id
  left join public.custody_fresh_tail_custody_events ce on ce.id = i.custody_event_id;

  return jsonb_build_object(
    'ok', true, 'reason', 'uncertain_claimed', 'intents', v_intents
  );
end;
$$;

create or replace function public.resolve_custody_fresh_tail_exit_intent(
  p_user_id uuid,
  p_intent_id uuid,
  p_claim_token uuid,
  p_claim_generation bigint,
  p_expected_status text,
  p_disposition text,
  p_sell_claim_id uuid default null,
  p_bot_tx_sig text default null,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_intent public.custody_fresh_tail_exit_intents%rowtype;
  v_sell_claim public.sell_signal_claims%rowtype;
  v_entry_claim public.entry_signal_claims%rowtype;
  v_position public.positions%rowtype;
  v_config public.bot_config%rowtype;
  v_disposition text := lower(btrim(coalesce(p_disposition, '')));
  v_expected text := lower(btrim(coalesce(p_expected_status, '')));
  v_source_tx_sig text;
  v_source_wallet text;
  v_expected_trigger text;
  v_source_is_root boolean := false;
  v_status text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;
  if p_user_id is null or p_intent_id is null or p_claim_token is null
     or p_claim_generation is null or p_claim_generation <= 0
     or v_expected not in ('claimed', 'uncertain')
     or v_disposition not in (
       'resolved', 'retry', 'uncertain', 'disabled_by_policy',
       'position_not_live', 'duplicate_sell_claim', 'entry_failed', 'position_closed'
     ) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_intent_resolution');
  end if;
  select * into v_intent
  from public.custody_fresh_tail_exit_intents
  where id = p_intent_id and user_id = p_user_id
  for update;
  if not found
     or v_intent.status <> v_expected
     or v_intent.claim_token is distinct from p_claim_token
     or v_intent.claim_generation <> p_claim_generation
     or v_intent.claim_expires_at <= clock_timestamp() then
    return jsonb_build_object('ok', false, 'reason', 'intent_claim_fenced');
  end if;

  if v_intent.source_domain = 'supply' then
    select e.tx_sig, e.target_wallet into v_source_tx_sig, v_source_wallet
    from public.custody_fresh_tail_supply_events e
    where e.id = v_intent.supply_event_id
      and e.epoch_id = v_intent.epoch_id
      and e.user_id = p_user_id;
  else
    select e.tx_sig, e.source_wallet into v_source_tx_sig, v_source_wallet
    from public.custody_fresh_tail_custody_events e
    where e.id = v_intent.custody_event_id
      and e.epoch_id = v_intent.epoch_id
      and e.user_id = p_user_id;
  end if;
  if not found or nullif(btrim(coalesce(v_source_tx_sig, '')), '') is null
     or nullif(btrim(coalesce(v_source_wallet, '')), '') is null then
    return jsonb_build_object('ok', false, 'reason', 'intent_source_event_missing');
  end if;
  v_source_is_root := exists (
    select 1 from public.custody_fresh_tail_roots r
    where r.epoch_id = v_intent.epoch_id and r.user_id = p_user_id
      and r.wallet = v_source_wallet
  );
  v_expected_trigger := case v_intent.trigger_kind
    when 'direct_target_sell' then 'direct_target_sell'
    when 'mirror_custody_sell' then 'mirror_custody_sell'
    when 'terminal_outflow' then case when v_source_is_root
      then 'target_terminal_outflow' else 'terminal_outflow' end
    else null
  end;
  if v_expected_trigger is null then
    return jsonb_build_object('ok', false, 'reason', 'intent_trigger_invalid');
  end if;

  if v_expected = 'claimed' and v_disposition = 'resolved' then
    return jsonb_build_object(
      'ok', false, 'reason', 'pre_submit_uncertain_required'
    );
  end if;
  if v_disposition in ('uncertain', 'resolved')
     or (v_expected = 'uncertain' and v_disposition = 'retry') then
    if p_sell_claim_id is null
       or nullif(btrim(coalesce(p_bot_tx_sig, '')), '') is null then
      return jsonb_build_object(
        'ok', false, 'reason', 'prepared_sell_evidence_required'
      );
    end if;
    select * into v_sell_claim
    from public.sell_signal_claims c
    where c.id = p_sell_claim_id and c.user_id = p_user_id
    for update;
    if not found
       or v_sell_claim.position_id <> v_intent.position_id
       or v_sell_claim.source_tx_sig <> v_source_tx_sig
       or v_sell_claim.source_wallet <> v_source_wallet
       or v_sell_claim.trigger_kind <> v_expected_trigger
       or v_sell_claim.bot_tx_sig is distinct from btrim(p_bot_tx_sig)
       or v_sell_claim.recovery_version is distinct from 1
       or nullif(btrim(coalesce(v_sell_claim.recent_blockhash, '')), '') is null
       or v_sell_claim.last_valid_block_height is null
       or v_sell_claim.last_valid_block_height <= 0
       or v_sell_claim.executed_sell_amount_raw is null
       or v_sell_claim.prepared_wallet_balance_raw is null
       or v_sell_claim.position_amount_before_raw is null
       or v_sell_claim.token_decimals is null then
      return jsonb_build_object('ok', false, 'reason', 'sell_claim_evidence_mismatch');
    end if;
    if v_expected = 'claimed' and v_disposition = 'uncertain'
       and v_sell_claim.status not in ('submitted', 'uncertain', 'landed') then
      return jsonb_build_object('ok', false, 'reason', 'sell_claim_not_uncertain');
    end if;
    if v_expected = 'uncertain' and v_disposition = 'retry'
       and v_sell_claim.status <> 'failed_pre_submit' then
      return jsonb_build_object('ok', false, 'reason', 'sell_claim_retry_not_proven');
    end if;
    if v_disposition = 'resolved'
       and (
         v_sell_claim.status <> 'landed'
         or v_sell_claim.trade_id is null
         or v_sell_claim.persisted_at is null
         or v_sell_claim.receipt_pre_amount_raw is null
         or v_sell_claim.receipt_post_amount_raw is null
       ) then
      return jsonb_build_object('ok', false, 'reason', 'sell_claim_not_landed_exact');
    end if;
  end if;

  if v_expected = 'uncertain' and v_disposition = 'resolved'
     and (
       v_intent.sell_claim_id is null
       or nullif(btrim(coalesce(v_intent.bot_tx_sig, '')), '') is null
       or p_sell_claim_id is distinct from v_intent.sell_claim_id
       or nullif(btrim(coalesce(p_bot_tx_sig, '')), '')
         is distinct from v_intent.bot_tx_sig
     ) then
    -- Reconciliation may confirm only the exact durable prepared sell that
    -- put this intent into uncertain.  A caller cannot substitute a different
    -- claim or signature while marking the original attempt resolved.
    return jsonb_build_object(
      'ok', false, 'reason', 'resolution_evidence_mismatch'
    );
  end if;

  if v_disposition = 'entry_failed' then
    select * into v_entry_claim
    from public.entry_signal_claims c
    where c.id = v_intent.entry_claim_id and c.user_id = p_user_id;
    if not found or v_entry_claim.status <> 'failed_pre_submit' then
      return jsonb_build_object('ok', false, 'reason', 'entry_failure_not_proven');
    end if;
  elsif v_disposition = 'position_closed' then
    select * into v_position
    from public.positions p
    where p.id = v_intent.position_id and p.user_id = p_user_id;
    if not found or (
      v_position.closed_at is null
      and coalesce(v_position.amount_remaining_raw, '') <> '0'
    ) then
      return jsonb_build_object('ok', false, 'reason', 'closed_position_not_proven');
    end if;
  elsif v_disposition = 'disabled_by_policy' then
    select * into v_config
    from public.bot_config c where c.user_id = p_user_id;
    if not found or not (
      (v_intent.trigger_kind = 'direct_target_sell'
        and v_config.direct_target_sell_exit_mode = 'off')
      or (v_intent.trigger_kind = 'mirror_custody_sell'
        and coalesce(
          (to_jsonb(v_config) ->> 'mirror_custody_sell_exit_enabled')::boolean,
          false
        ) is not true)
      or (v_intent.trigger_kind = 'terminal_outflow' and v_source_is_root
        and v_config.target_terminal_outflow_exit_enabled is not true)
      or (v_intent.trigger_kind = 'terminal_outflow' and not v_source_is_root
        and v_config.terminal_outflow_exit_enabled is not true)
    ) then
      return jsonb_build_object('ok', false, 'reason', 'disabled_policy_not_proven');
    end if;
  end if;

  v_status := case
    when v_disposition = 'resolved' then 'resolved'
    -- A sell may be observed after entry submission but before the planned
    -- position is persisted.  Mere position absence is not proof that the buy
    -- failed, so it must remain retryable rather than permanently dismissed.
    when v_disposition in (
      'retry', 'position_not_live', 'duplicate_sell_claim'
    ) then 'retry'
    when v_disposition = 'uncertain' then 'uncertain'
    when v_disposition in (
      'disabled_by_policy', 'entry_failed', 'position_closed'
    ) then 'dismissed'
    else 'dismissed'
  end;
  update public.custody_fresh_tail_exit_intents set
    status = v_status,
    disposition = v_disposition,
    claim_token = case when v_status = 'uncertain' then claim_token else null end,
    claim_expires_at = case
      when v_status = 'uncertain' then claim_expires_at else null end,
    sell_claim_id = case
      when v_expected = 'uncertain' and v_disposition = 'resolved'
      then sell_claim_id else p_sell_claim_id end,
    bot_tx_sig = case
      when v_expected = 'uncertain' and v_disposition = 'resolved'
      then bot_tx_sig else nullif(btrim(coalesce(p_bot_tx_sig, '')), '') end,
    error_code = nullif(btrim(coalesce(p_error_code, '')), ''),
    resolved_at = case when v_status in ('resolved', 'dismissed') then now() else null end,
    updated_at = now()
  where id = p_intent_id
  returning * into v_intent;

  return jsonb_build_object(
    'ok', true, 'reason', 'intent_resolved', 'intentId', v_intent.id,
    'status', v_intent.status, 'disposition', v_intent.disposition,
    'claimGeneration', v_intent.claim_generation
  );
end;
$$;

create or replace function public.check_supply_accumulation_fresh_custody_gate(
  p_user_id uuid,
  p_token_mint text,
  p_window_started_at timestamptz,
  p_trigger_event_key text,
  p_trigger_tx_sig text,
  p_trigger_slot bigint,
  p_target_wallet text,
  p_epoch_id uuid,
  p_request_id uuid,
  p_claim_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_request public.custody_fresh_tail_requests%rowtype;
  v_mint public.custody_fresh_tail_mints%rowtype;
  v_trigger public.custody_fresh_tail_supply_events%rowtype;
  v_heartbeat public.custody_fresh_tail_worker_heartbeat%rowtype;
  v_config public.bot_config%rowtype;
  v_mint_text text := btrim(coalesce(p_token_mint, ''));
  v_event_key text := btrim(coalesce(p_trigger_event_key, ''));
  v_sig text := btrim(coalesce(p_trigger_tx_sig, ''));
  v_target text := btrim(coalesce(p_target_wallet, ''));
  v_config_roots text[];
  v_net_raw numeric(78, 0);
  v_net_pct numeric;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;
  if p_user_id is null or p_epoch_id is null or p_request_id is null
     or v_mint_text = '' or v_event_key = '' or v_sig = '' or v_target = ''
     or p_window_started_at is null or p_trigger_slot is null
     or p_trigger_slot < 0 then
    return jsonb_build_object('safe', false, 'reason', 'invalid_request');
  end if;
  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(v_mint_text));
  select * into v_epoch
  from public.custody_fresh_tail_epochs
  where id = p_epoch_id and user_id = p_user_id;
  if not found or v_epoch.status <> 'active' then
    return jsonb_build_object('safe', false, 'reason', 'epoch_not_active');
  end if;
  if v_epoch.lease_token is null or v_epoch.lease_owner is null
     or v_epoch.lease_expires_at is null
     or v_epoch.lease_expires_at <= clock_timestamp() then
    return jsonb_build_object('safe', false, 'reason', 'fresh_tail_monitor_stale');
  end if;
  select * into v_request
  from public.custody_fresh_tail_requests
  where id = p_request_id and epoch_id = p_epoch_id and user_id = p_user_id;
  if not found or v_request.status <> 'settled'
     or v_request.expires_at <= clock_timestamp()
     or v_request.settled_at is null
     or v_request.settled_at < clock_timestamp() - interval '4 seconds'
     or v_request.settled_at > clock_timestamp() then
    return jsonb_build_object('safe', false, 'reason', 'settlement_not_fresh');
  end if;
  if v_request.settled_lease_generation is distinct from v_epoch.lease_generation then
    return jsonb_build_object('safe', false, 'reason', 'settlement_lease_fenced');
  end if;
  select * into v_heartbeat
  from public.custody_fresh_tail_worker_heartbeat
  where user_id = p_user_id and epoch_id = p_epoch_id;
  if not found
     or v_heartbeat.worker_id is distinct from v_epoch.lease_owner
     or v_heartbeat.lease_token is distinct from v_epoch.lease_token
     or v_heartbeat.lease_generation is distinct from v_epoch.lease_generation
     or v_heartbeat.lease_expires_at <= clock_timestamp()
     or v_heartbeat.enabled is not true
     or v_heartbeat.shadow is not false
     or v_heartbeat.updated_at < clock_timestamp() - interval '4 seconds'
     or v_heartbeat.last_success_at is null
     or v_heartbeat.last_success_at < clock_timestamp() - interval '4 seconds'
     or v_heartbeat.last_success_at > clock_timestamp()
     or v_heartbeat.last_error is not null
     or v_heartbeat.root_required_count <> 3
     or v_heartbeat.root_covered_count <> 3
     or v_heartbeat.root_backlog_count <> 0
     or v_heartbeat.latest_head_slot < v_request.requested_head_slot then
    return jsonb_build_object('safe', false, 'reason', 'fresh_tail_worker_not_live');
  end if;
  if v_request.token_mint <> v_mint_text
     or v_request.window_started_at <> p_window_started_at
     or v_request.trigger_event_key <> v_event_key
     or v_request.trigger_tx_sig <> v_sig
     or v_request.trigger_slot <> p_trigger_slot
     or v_request.trigger_target_wallet <> v_target then
    return jsonb_build_object('safe', false, 'reason', 'request_identity_mismatch');
  end if;
  select * into v_mint
  from public.custody_fresh_tail_mints
  where epoch_id = p_epoch_id and user_id = p_user_id and token_mint = v_mint_text;
  if not found or v_mint.status <> 'active' or v_mint.poisoned
     or v_mint.creation_slot <= v_epoch.activation_slot
     or v_request.scope_revision <> v_mint.scope_revision
     or v_request.settled_revision <> v_mint.scope_revision
     or v_request.head_snapshot_parser_abi_fingerprint <>
       '2f5de97b6527d4ec94082069d65abd2bf30523e45bf562aabe1e770e5eb4ad1d'
     or v_request.head_curve_observed_slot <> v_request.requested_head_slot
     or v_request.head_curve_complete
     or v_request.head_curve_state_fingerprint !~ '^[0-9a-f]{64}$'
     or v_request.head_virtual_token_reserves_raw <= 0
     or v_request.head_virtual_sol_reserves_lamports <= 0
     or v_request.head_real_token_reserves_raw <= 0
     or v_request.head_real_sol_reserves_lamports < 0
     or v_request.head_curve_total_supply_raw <> v_mint.total_supply_raw
     or v_request.head_mint_layout_fingerprint <> v_mint.mint_layout_fingerprint
     or v_request.head_token_program <> v_mint.token_program
     or v_request.head_mint_supply_raw <> v_mint.total_supply_raw
     or v_request.head_mint_decimals <> v_mint.decimals then
    return jsonb_build_object('safe', false, 'reason', 'mint_or_revision_invalid');
  end if;
  if exists (
    select 1 from public.custody_fresh_tail_mint_rejections
    where epoch_id = p_epoch_id and token_mint = v_mint_text
  ) then
    return jsonb_build_object('safe', false, 'reason', 'mint_tombstoned');
  end if;

  select * into v_config from public.bot_config where user_id = p_user_id;
  if not found or v_config.enabled is not true
     or v_config.supply_accumulation_mode_enabled is not true
     or v_config.custody_journey_enabled is not true
     or v_config.direct_target_sell_exit_mode = 'proportional' then
    return jsonb_build_object('safe', false, 'reason', 'strategy_not_enabled');
  end if;
  if v_config.supply_accumulation_window_seconds is null
     or p_window_started_at <> v_request.trigger_block_time - make_interval(
       secs => v_config.supply_accumulation_window_seconds
     ) then
    return jsonb_build_object('safe', false, 'reason', 'window_identity_mismatch');
  end if;
  select array_agg(v order by v) into v_config_roots
  from (
    select distinct btrim(wallet) as v
    from unnest(array_remove(array_prepend(
      nullif(btrim(v_config.target_wallet), ''),
      coalesce(v_config.additional_target_wallets, array[]::text[])
    ), null)) wallet
    where nullif(btrim(wallet), '') is not null
  ) configured;
  if coalesce(cardinality(v_config_roots), 0) <> 3
     or v_config_roots is distinct from v_epoch.root_wallets then
    return jsonb_build_object('safe', false, 'reason', 'configured_roots_changed');
  end if;

  select * into v_trigger
  from public.custody_fresh_tail_supply_events
  where id = v_request.trigger_supply_event_id and epoch_id = p_epoch_id;
  if not found or v_trigger.event_key <> v_event_key
     or v_trigger.tx_sig <> v_sig or v_trigger.slot <> p_trigger_slot
     or v_trigger.target_wallet <> v_target or v_trigger.token_mint <> v_mint_text
     or v_trigger.side <> 'buy' or v_trigger.quarantined
     or not v_trigger.market_data_reliable or not v_trigger.pump_fun_verified
     or not v_trigger.classification_reliable
     or v_trigger.total_supply_raw <> v_mint.total_supply_raw
     or v_trigger.decimals <> v_mint.decimals
     or not public.is_custody_fresh_tail_parser_reviewed(
       v_trigger.parser_domain, v_trigger.parser_abi_fingerprint
     )
     or v_trigger.market_cap_usd is null
     or v_trigger.market_cap_usd < v_config.supply_accumulation_min_market_cap_usd
     or v_trigger.market_cap_usd >= v_config.supply_accumulation_max_market_cap_usd
     or exists (
       select 1 from public.custody_fresh_tail_supply_events later
       where later.epoch_id = p_epoch_id and later.token_mint = v_mint_text
         and later.side = 'buy'
         and (later.slot > p_trigger_slot
           or (later.slot = p_trigger_slot and later.event_key <> v_event_key))
         and later.slot <= v_request.requested_head_slot
     ) then
    return jsonb_build_object('safe', false, 'reason', 'trigger_not_exact_latest_buy');
  end if;

  select greatest(0, coalesce(sum(case
    when e.side = 'buy' then e.amount_raw else -e.amount_raw end), 0))
  into v_net_raw
  from public.custody_fresh_tail_supply_events e
  where e.epoch_id = p_epoch_id and e.token_mint = v_mint_text
    and e.block_time >= p_window_started_at
    and e.block_time <= v_request.trigger_block_time
    and e.slot > v_epoch.activation_slot and e.slot <= p_trigger_slot
    and e.target_wallet = any(v_epoch.root_wallets)
    and not e.quarantined and e.classification_reliable and e.pump_fun_verified
    and e.total_supply_raw = v_mint.total_supply_raw
    and e.decimals = v_mint.decimals
    and public.is_custody_fresh_tail_parser_reviewed(
      e.parser_domain, e.parser_abi_fingerprint
    );
  v_net_pct := (v_net_raw * 100) / v_mint.total_supply_raw;
  if v_net_pct < v_config.supply_accumulation_threshold_pct then
    return jsonb_build_object('safe', false, 'reason', 'fresh_threshold_not_reached');
  end if;

  if exists (
    select 1 from public.custody_fresh_tail_supply_events e
    where e.epoch_id = p_epoch_id and e.token_mint = v_mint_text
      and e.slot <= v_request.requested_head_slot
      and (e.side = 'sell' or e.quarantined or not e.classification_reliable
        or not e.pump_fun_verified
        or not public.is_custody_fresh_tail_parser_reviewed(
          e.parser_domain, e.parser_abi_fingerprint
        ))
  ) or exists (
    select 1 from public.custody_fresh_tail_custody_events e
    where e.epoch_id = p_epoch_id and e.token_mint = v_mint_text
      and e.slot <= v_request.requested_head_slot
      and (e.event_kind in ('SELL', 'UNRESOLVED_OUTFLOW', 'TERMINAL_OUTFLOW')
        or e.quarantined or e.classification_pending or e.terminal_poison
        or not e.classification_reliable
        or not public.is_custody_fresh_tail_parser_reviewed(
          e.parser_domain, e.parser_abi_fingerprint
        ))
  ) then
    return jsonb_build_object('safe', false, 'reason', 'fresh_sell_or_poison_seen');
  end if;
  if not exists (
    select 1 from public.custody_fresh_tail_custody_events e
    where e.epoch_id = p_epoch_id and e.token_mint = v_mint_text
      and e.event_kind = 'TARGET_BUY' and e.tx_sig = v_sig
      and e.slot = p_trigger_slot and e.source_wallet = v_target
      and not e.quarantined and e.classification_reliable
      and public.is_custody_fresh_tail_parser_reviewed(
        e.parser_domain, e.parser_abi_fingerprint
      )
  ) then
    return jsonb_build_object('safe', false, 'reason', 'fresh_target_buy_missing');
  end if;
  if not exists (
    select 1
    from public.custody_fresh_tail_supply_events s
    join public.custody_fresh_tail_custody_events c
      on c.epoch_id = s.epoch_id and c.token_mint = s.token_mint
     and c.tx_sig = s.tx_sig and c.slot = s.slot
     and c.source_wallet = s.target_wallet and c.amount_raw = s.amount_raw
    where s.epoch_id = p_epoch_id and s.token_mint = v_mint_text
      and s.event_key = v_mint.enrollment_event_key
      and s.tx_sig = v_mint.enrollment_tx_sig
      and s.slot = v_mint.enrollment_slot
      and s.block_time = v_mint.enrollment_block_time
      and s.target_wallet = v_mint.enrollment_target_wallet
      and s.side = 'buy' and c.event_kind = 'TARGET_BUY'
      and not s.quarantined and not c.quarantined
      and s.classification_reliable and c.classification_reliable
      and s.pump_fun_verified
      and public.is_custody_fresh_tail_parser_reviewed(
        s.parser_domain, s.parser_abi_fingerprint
      )
      and public.is_custody_fresh_tail_parser_reviewed(
        c.parser_domain, c.parser_abi_fingerprint
      )
  ) then
    return jsonb_build_object('safe', false, 'reason', 'enrollment_evidence_missing');
  end if;
  if exists (
    select 1 from public.custody_fresh_tail_edges e
    where e.epoch_id = p_epoch_id and e.token_mint = v_mint_text
      and e.applied_revision is null
  ) then
    return jsonb_build_object('safe', false, 'reason', 'scope_not_fixed_point');
  end if;

  if exists (
    select 1 from public.custody_fresh_tail_roots r
    left join public.custody_fresh_tail_cursors c
      on c.epoch_id = r.epoch_id and c.scope_mint = '*' and c.wallet = r.wallet
    where r.epoch_id = p_epoch_id
      and (c.wallet is null or c.backlog_detected or not c.history_floor_proven
        or not exists (
          select 1 from public.custody_fresh_tail_coverage_attestations a
          where a.epoch_id = p_epoch_id and a.lane_kind = 'main'
            and a.scope_mint = '*' and a.wallet = r.wallet
            and a.covered_head_slot = v_request.requested_head_slot
            and a.covered_head_blockhash = v_request.requested_head_blockhash
            and a.coverage_revision = 0
            and a.lease_generation = v_request.settled_lease_generation
        ))
  ) or exists (
    select 1 from public.custody_fresh_tail_wallets w
    left join public.custody_fresh_tail_cursors c
      on c.epoch_id = w.epoch_id and c.scope_mint = w.token_mint
     and c.wallet = w.wallet
    where w.epoch_id = p_epoch_id and w.token_mint = v_mint_text
      and (w.watch_status <> 'active' or c.wallet is null
        or c.backlog_detected or not c.history_floor_proven
        or c.coverage_revision <> v_mint.scope_revision
        or not exists (
          select 1 from public.custody_fresh_tail_coverage_attestations a
          where a.epoch_id = p_epoch_id and a.lane_kind = 'main'
            and a.scope_mint = v_mint_text and a.wallet = w.wallet
            and a.covered_head_slot = v_request.requested_head_slot
            and a.covered_head_blockhash = v_request.requested_head_blockhash
            and a.coverage_revision = v_mint.scope_revision
            and a.lease_generation = v_request.settled_lease_generation
        ))
  ) or exists (
    select 1 from public.custody_fresh_tail_backscan_ranges r
    where r.epoch_id = p_epoch_id and r.token_mint = v_mint_text
      and (r.backlog_detected or not r.history_floor_proven
        or r.coverage_revision <> v_mint.scope_revision
        or not exists (
          select 1 from public.custody_fresh_tail_coverage_attestations a
          where a.epoch_id = p_epoch_id and a.lane_kind = 'backscan'
            and a.range_id = r.id
            and a.covered_head_slot = v_request.requested_head_slot
            and a.covered_head_blockhash = v_request.requested_head_blockhash
            and a.coverage_revision = v_mint.scope_revision
            and a.lease_generation = v_request.settled_lease_generation
        ))
  ) then
    return jsonb_build_object('safe', false, 'reason', 'coverage_certificate_invalid');
  end if;

  if exists (
    select 1 from public.custody_pending_events p
    where p.user_id = p_user_id and p.token_mint = v_mint_text
      and p.event_at >= v_epoch.activation_block_time
      and (p.status in ('expired', 'terminal')
        or coalesce(p.last_error_code, '') = 'payload_mismatch')
  ) or exists (
    select 1 from public.custody_journeys j
    where j.user_id = p_user_id and j.token_mint = v_mint_text
      and j.status = 'active'
      and (j.first_event_key <> v_mint.enrollment_event_key
        or j.total_unresolved_outflow_tokens > 0)
  ) then
    return jsonb_build_object('safe', false, 'reason', 'legacy_poison_seen');
  end if;

  if p_claim_id is not null and not exists (
    select 1 from public.entry_signal_claims c
    where c.id = p_claim_id and c.user_id = p_user_id
      -- The final gate runs from executor.beforeSubmit only after the exact
      -- locally signed transaction has been persisted by onPrepared.  A merely
      -- claimed row is not submission authority and must never pass here.
      and c.status = 'submitted'
      and c.entry_strategy = 'supply_accumulation'
      and c.entry_mode = 'regular'
      and c.token_mint = v_mint_text and c.source_tx_sig = v_sig
      and c.source_wallet = v_target and c.source_slot = p_trigger_slot
      and c.planned_position_id is not null
      and c.amount_lamports > 0
      and c.planned_buy_usd > 0
      and c.token_decimals = v_mint.decimals
      and nullif(btrim(coalesce(c.bot_tx_sig, '')), '') is not null
      and c.submission_started_at is not null
      and c.last_valid_block_height is not null
      and c.last_valid_block_height > 0
      and c.error_code is null
      and c.landed_at is null and c.persisted_at is null
      and c.fresh_tail_epoch_id = p_epoch_id
      and c.fresh_tail_request_id = p_request_id
      and c.fresh_tail_monitoring_armed_at is not null
      and c.fresh_tail_monitoring_armed_at <= c.submission_started_at
  ) then
    return jsonb_build_object('safe', false, 'reason', 'claim_not_bound');
  end if;

  return jsonb_build_object(
    'safe', true, 'reason', 'fresh_custody_safe',
    'epochId', p_epoch_id, 'requestId', p_request_id,
    'tokenMint', v_mint_text, 'triggerEventKey', v_event_key,
    'txSig', v_sig, 'slot', p_trigger_slot,
    'triggerBlockTime', v_request.trigger_block_time,
    'targetWallet', v_target, 'expiresAt', v_request.expires_at,
    'requestedHeadSlot', v_request.requested_head_slot,
    'requestedHeadBlockhash', v_request.requested_head_blockhash,
    'requestedHeadBlockTime', v_request.requested_head_block_time,
    'headSnapshotParserAbiFingerprint',
      v_request.head_snapshot_parser_abi_fingerprint,
    'headCurveStateFingerprint', v_request.head_curve_state_fingerprint,
    'headCurveObservedSlot', v_request.head_curve_observed_slot,
    'headCurveComplete', v_request.head_curve_complete,
    'headVirtualTokenReservesRaw', v_request.head_virtual_token_reserves_raw::text,
    'headVirtualSolReservesLamports', v_request.head_virtual_sol_reserves_lamports::text,
    'headRealTokenReservesRaw', v_request.head_real_token_reserves_raw::text,
    'headRealSolReservesLamports', v_request.head_real_sol_reserves_lamports::text,
    'headCurveTotalSupplyRaw', v_request.head_curve_total_supply_raw::text,
    'headMintLayoutFingerprint', v_request.head_mint_layout_fingerprint,
    'headTokenProgram', v_request.head_token_program,
    'headMintSupplyRaw', v_request.head_mint_supply_raw::text,
    'headMintDecimals', v_request.head_mint_decimals,
    'scopeRevision', v_request.scope_revision,
    'settledRevision', v_request.settled_revision,
    'settledLeaseGeneration', v_request.settled_lease_generation,
    'proofObservedAt', v_request.settled_at
  ) || jsonb_build_object(
    'amountRaw', v_trigger.amount_raw::text,
    'decimals', v_mint.decimals,
    'totalSupplyRaw', v_mint.total_supply_raw::text,
    'netAcquiredRaw', v_net_raw::text,
    'netSupplyPct', v_net_pct,
    'thresholdPct', v_config.supply_accumulation_threshold_pct,
    'rootWallets', v_epoch.root_wallets,
    'windowStartedAt', p_window_started_at,
    'marketCapUsd', v_trigger.market_cap_usd,
    'minMarketCapUsd', v_config.supply_accumulation_min_market_cap_usd,
    'maxMarketCapUsd', v_config.supply_accumulation_max_market_cap_usd,
    'createVariant', v_mint.create_variant,
    'tokenProgram', v_mint.token_program,
    'bondingCurve', v_mint.bonding_curve,
    'creator', v_mint.creator,
    'mintLayoutFingerprint', v_mint.mint_layout_fingerprint,
    'creationParserAbiFingerprint', v_mint.parser_abi_fingerprint,
    'eventParserDomain', v_trigger.parser_domain,
    'eventParserAbiFingerprint', v_trigger.parser_abi_fingerprint,
    'monitorLeaseOwner', v_epoch.lease_owner,
    'monitorLeaseGeneration', v_epoch.lease_generation,
    'monitorLeaseExpiresAt', v_epoch.lease_expires_at
  );
end;
$$;

create or replace function public.get_custody_fresh_tail_entry_candidates(
  p_user_id uuid,
  p_limit integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_candidates jsonb := '[]'::jsonb;
  v_request public.custody_fresh_tail_requests%rowtype;
  v_result jsonb;
  v_count integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;
  if p_user_id is null or p_limit is null or p_limit not between 1 and 100 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_candidate_request');
  end if;

  -- Gate calls take per-mint advisory locks.  Walking requests in a stable
  -- order prevents two candidate pollers from acquiring those locks in
  -- opposite order.
  for v_request in
    select q.*
    from public.custody_fresh_tail_requests q
    where q.user_id = p_user_id and q.status = 'settled'
      and q.expires_at > clock_timestamp()
      and q.settled_at >= clock_timestamp() - interval '4 seconds'
      and not exists (
        select 1 from public.entry_signal_claims c
        where c.fresh_tail_request_id = q.id
      )
    order by q.trigger_block_time, q.id
  loop
    v_result := public.check_supply_accumulation_fresh_custody_gate(
      v_request.user_id, v_request.token_mint, v_request.window_started_at,
      v_request.trigger_event_key, v_request.trigger_tx_sig,
      v_request.trigger_slot, v_request.trigger_target_wallet,
      v_request.epoch_id, v_request.id, null
    );
    if v_result->>'safe' = 'true' then
      v_candidates := v_candidates || jsonb_build_array(v_result);
      v_count := v_count + 1;
      exit when v_count >= p_limit;
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true, 'reason', 'loaded', 'candidates', v_candidates,
    'observedAt', clock_timestamp()
  );
end;
$$;

-- Every SECURITY DEFINER routine in this isolated namespace is service-only.
do $$
declare
  v_function record;
begin
  for v_function in
    select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'assert_custody_fresh_tail_lease',
        'attest_custody_fresh_tail_finalized_head',
        'is_custody_fresh_tail_parser_reviewed',
        'activate_custody_fresh_tail_epoch',
        'get_custody_fresh_tail_active_epoch',
        'acquire_custody_fresh_tail_lease',
        'record_custody_fresh_tail_heartbeat',
        'get_custody_fresh_tail_work',
        'get_custody_fresh_tail_retirement_candidates',
        'reject_custody_fresh_tail_mint',
        'attest_custody_fresh_tail_mint_creation',
        'record_custody_fresh_tail_supply_event',
        'record_custody_fresh_tail_custody_event',
        'sync_custody_fresh_tail_scope',
        'retire_custody_fresh_tail_mint',
        'request_custody_fresh_tail_coverage',
        'record_custody_fresh_tail_cursor',
        'record_custody_fresh_tail_backscan_cursor',
        'settle_custody_fresh_tail_request',
        'bind_supply_entry_claim_fresh_tail',
        'record_supply_entry_claim_fresh_tail_receipt',
        'claim_custody_fresh_tail_exit_intents',
        'claim_custody_fresh_tail_uncertain_intents',
        'resolve_custody_fresh_tail_exit_intent',
        'check_supply_accumulation_fresh_custody_gate',
        'get_custody_fresh_tail_entry_candidates'
      )
  loop
    execute format(
      'revoke all on function %I.%I(%s) from public, anon, authenticated',
      v_function.nspname, v_function.proname, v_function.args
    );
    execute format(
      'grant execute on function %I.%I(%s) to service_role',
      v_function.nspname, v_function.proname, v_function.args
    );
  end loop;
end $$;

-- Fail the transaction if a dependency was accidentally reordered, an
-- identifier would be truncated, or an RPC was omitted from the install.
do $$
declare
  v_missing text[];
begin
  select array_agg(name order by name) into v_missing
  from unnest(array[
    'custody_fresh_tail_epochs', 'custody_fresh_tail_roots',
    'custody_fresh_tail_finalized_heads',
    'custody_fresh_tail_mints', 'custody_fresh_tail_mint_rejections',
    'custody_fresh_tail_supply_events', 'custody_fresh_tail_custody_events',
    'custody_fresh_tail_edges', 'custody_fresh_tail_wallets',
    'custody_fresh_tail_requests', 'custody_fresh_tail_cursors',
    'custody_fresh_tail_backscan_ranges',
    'custody_fresh_tail_coverage_attestations',
    'custody_fresh_tail_exit_intents',
    'custody_fresh_tail_worker_heartbeat'
  ]) name
  where to_regclass('public.' || name) is null;
  if v_missing is not null then
    raise exception 'fresh-tail table verification failed: %', v_missing;
  end if;

  select array_agg(name order by name) into v_missing
  from unnest(array[
    'assert_custody_fresh_tail_lease',
    'attest_custody_fresh_tail_finalized_head',
    'is_custody_fresh_tail_parser_reviewed',
    'activate_custody_fresh_tail_epoch',
    'get_custody_fresh_tail_active_epoch',
    'acquire_custody_fresh_tail_lease',
    'record_custody_fresh_tail_heartbeat',
    'get_custody_fresh_tail_work',
    'get_custody_fresh_tail_retirement_candidates',
    'reject_custody_fresh_tail_mint',
    'attest_custody_fresh_tail_mint_creation',
    'record_custody_fresh_tail_supply_event',
    'record_custody_fresh_tail_custody_event',
    'sync_custody_fresh_tail_scope',
    'retire_custody_fresh_tail_mint',
    'request_custody_fresh_tail_coverage',
    'record_custody_fresh_tail_cursor',
    'record_custody_fresh_tail_backscan_cursor',
    'settle_custody_fresh_tail_request',
    'bind_supply_entry_claim_fresh_tail',
    'record_supply_entry_claim_fresh_tail_receipt',
    'claim_custody_fresh_tail_exit_intents',
    'claim_custody_fresh_tail_uncertain_intents',
    'resolve_custody_fresh_tail_exit_intent',
    'check_supply_accumulation_fresh_custody_gate',
    'get_custody_fresh_tail_entry_candidates'
  ]) name
  where not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = name
  );
  if v_missing is not null then
    raise exception 'fresh-tail function verification failed: %', v_missing;
  end if;

  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname like '%fresh_tail%'
      and char_length(c.relname) > 63
  ) or exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like '%fresh_tail%'
      and char_length(p.proname) > 63
  ) then
    raise exception 'fresh-tail identifier exceeds PostgreSQL 63-byte limit';
  end if;
end $$;

commit;
