-- Fresh-tail replay identity and failed-shadow recovery hotfix.
--
-- Run this focused migration after the original Supply Accumulation fresh-tail
-- migration. It preserves every existing event, valuation, conflict counter,
-- poison marker, cursor, and heartbeat. The recovery RPC can only invalidate a
-- stopped shadow epoch that has no durable cursor progress or trading work.

begin;

do $$
begin
  if to_regclass('public.bot_config') is null
     or to_regclass('public.custody_fresh_tail_epochs') is null
     or to_regclass('public.custody_fresh_tail_mint_rejections') is null
     or to_regclass('public.custody_fresh_tail_supply_events') is null
     or to_regclass('public.custody_fresh_tail_worker_heartbeat') is null
     or to_regclass('public.entry_signal_claims') is null
     or to_regclass('public.positions') is null
     or to_regprocedure('extensions.digest(text,text)') is null
     or to_regprocedure(
       'public.reject_custody_fresh_tail_mint(uuid,uuid,text,text,bigint,text,text,text,bigint,text,uuid,bigint)'
     ) is null
     or to_regprocedure(
       'public.record_custody_fresh_tail_supply_event(uuid,uuid,text,text,bigint,timestamp with time zone,text,text,text,numeric,numeric,integer,numeric,bigint,boolean,boolean,boolean,text,text,bigint,text,uuid,bigint)'
     ) is null then
    raise exception using
      errcode = '42883',
      message = 'run the original Supply Accumulation fresh-tail migration first';
  end if;
end $$;

-- ALTER holds both ledgers through commit; no old function can write a row
-- between the evidence backfill and the replay-contract replacement.
alter table public.custody_fresh_tail_mint_rejections
  add column if not exists evidence_fingerprint text;
alter table public.custody_fresh_tail_supply_events
  add column if not exists evidence_fingerprint text;

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

-- The old payload fingerprint is a complete write-once audit hash, including
-- the first external valuation. Abort rather than migrate if any stored row no
-- longer matches that original contract.
do $$
begin
  if exists (
    select 1
    from public.custody_fresh_tail_supply_events e
    where e.payload_fingerprint <> encode(extensions.digest(jsonb_build_object(
      'eventKey', e.event_key, 'txSig', e.tx_sig, 'slot', e.slot,
      'blockTime', e.block_time, 'targetWallet', e.target_wallet,
      'tokenMint', e.token_mint, 'side', e.side,
      'amountRaw', e.amount_raw::text, 'totalSupplyRaw', e.total_supply_raw::text,
      'decimals', e.decimals, 'marketCapUsd', e.market_cap_usd::text,
      'valuationSlot', e.valuation_slot, 'marketDataReliable', e.market_data_reliable,
      'pumpFunVerified', e.pump_fun_verified,
      'classificationReliable', e.classification_reliable,
      'parserDomain', e.parser_domain,
      'parserAbiFingerprint', e.parser_abi_fingerprint
    )::text, 'sha256'), 'hex')
  ) then
    raise exception using
      errcode = '55000',
      message = 'fresh-tail supply payload audit failed before replay-identity upgrade';
  end if;
end $$;

update public.custody_fresh_tail_mint_rejections r set
  evidence_fingerprint = encode(extensions.digest(jsonb_build_object(
    'tokenMint', btrim(r.token_mint),
    'sourceTxSig', btrim(r.source_tx_sig),
    'sourceSlot', r.source_slot,
    'rejectionCode', r.rejection_code,
    'parserAbiFingerprint', btrim(r.parser_abi_fingerprint)
  )::text, 'sha256'), 'hex')
where r.evidence_fingerprint is null;

update public.custody_fresh_tail_supply_events e set
  evidence_fingerprint = encode(extensions.digest(jsonb_build_object(
    'eventKey', btrim(e.event_key), 'txSig', btrim(e.tx_sig), 'slot', e.slot,
    'blockTime', e.block_time, 'targetWallet', btrim(e.target_wallet),
    'tokenMint', btrim(e.token_mint), 'side', lower(btrim(e.side)),
    'amountRaw', e.amount_raw::text, 'totalSupplyRaw', e.total_supply_raw::text,
    'decimals', e.decimals,
    'pumpFunVerified', e.pump_fun_verified,
    'classificationReliable', e.classification_reliable,
    'parserDomain', lower(btrim(e.parser_domain)),
    'parserAbiFingerprint', btrim(e.parser_abi_fingerprint)
  )::text, 'sha256'), 'hex')
where e.evidence_fingerprint is null;

alter table public.custody_fresh_tail_mint_rejections
  alter column evidence_fingerprint set not null;
alter table public.custody_fresh_tail_supply_events
  alter column evidence_fingerprint set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.custody_fresh_tail_mint_rejections'::regclass
      and conname = 'custody_fresh_tail_mint_rejections_evidence_fingerprint_check'
  ) then
    alter table public.custody_fresh_tail_mint_rejections
      add constraint custody_fresh_tail_mint_rejections_evidence_fingerprint_check
      check (evidence_fingerprint ~ '^[0-9a-f]{64}$');
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.custody_fresh_tail_supply_events'::regclass
      and conname = 'custody_fresh_tail_supply_events_evidence_fingerprint_check'
  ) then
    alter table public.custody_fresh_tail_supply_events
      add constraint custody_fresh_tail_supply_events_evidence_fingerprint_check
      check (evidence_fingerprint ~ '^[0-9a-f]{64}$');
  end if;
end $$;

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
  v_existing_mint public.custody_fresh_tail_mints%rowtype;
  v_mint text := btrim(coalesce(p_token_mint, ''));
  v_sig text := btrim(coalesce(p_source_tx_sig, ''));
  v_abi text := btrim(coalesce(p_parser_abi_fingerprint, ''));
  v_hash text := btrim(coalesce(p_finalized_head_blockhash, ''));
  v_fingerprint text := lower(btrim(coalesce(p_proof_fingerprint, '')));
  v_evidence_fingerprint text;
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

  -- The caller fingerprint is retained as write-once audit evidence.  Replay
  -- identity is derived server-side from immutable finalized evidence so an
  -- older caller that included head/detail fields cannot poison a tombstone.
  v_evidence_fingerprint := encode(extensions.digest(jsonb_build_object(
    'tokenMint', v_mint, 'sourceTxSig', v_sig, 'sourceSlot', p_source_slot,
    'rejectionCode', p_rejection_code, 'parserAbiFingerprint', v_abi
  )::text, 'sha256'), 'hex');

  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(v_mint));
  select * into v_existing_mint
  from public.custody_fresh_tail_mints
  where epoch_id = p_epoch_id and token_mint = v_mint
  for update;
  if found and v_existing_mint.status = 'retired' then
    return jsonb_build_object(
      'ok', true, 'reason', 'mint_retired', 'epochId', p_epoch_id,
      'tokenMint', v_mint, 'retireReason', v_existing_mint.retire_reason
    );
  elsif found then
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
    if v_existing.evidence_fingerprint = v_evidence_fingerprint then
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
    evidence_fingerprint,
    finalized_head_slot, finalized_head_blockhash
  ) values (
    p_epoch_id, p_user_id, v_mint, v_sig, p_source_slot,
    p_rejection_code, v_abi, v_fingerprint, v_evidence_fingerprint,
    p_finalized_head_slot, v_hash
  );
  return jsonb_build_object(
    'ok', true, 'reason', 'rejected', 'epochId', p_epoch_id,
    'tokenMint', v_mint, 'rejectionCode', p_rejection_code,
    'quarantined', false
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
  v_evidence_fingerprint text;
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

  -- Preserve the complete first observation (including its external SOL/USD
  -- valuation) as write-once audit data.
  v_fingerprint := encode(extensions.digest(jsonb_build_object(
    'eventKey', v_event_key, 'txSig', v_sig, 'slot', p_slot,
    'blockTime', p_block_time, 'targetWallet', v_target,
    'tokenMint', v_token_mint, 'side', v_side,
    'amountRaw', p_amount_raw::text, 'totalSupplyRaw', p_total_supply_raw::text,
    'decimals', p_decimals, 'marketCapUsd', p_market_cap_usd::text,
    'valuationSlot', p_valuation_slot, 'marketDataReliable', p_market_data_reliable,
    'pumpFunVerified', p_pump_fun_verified,
    'classificationReliable', p_classification_reliable,
    'parserDomain', v_parser_domain,
    'parserAbiFingerprint', v_abi
  )::text, 'sha256'), 'hex');

  -- Conflict identity must be replay-stable.  The reserve-derived market cap
  -- uses a short-lived external SOL/USD quote, so it cannot participate in an
  -- immutable on-chain evidence hash.  Duplicate writes preserve the first
  -- valuation and compare only finalized transaction evidence.
  v_evidence_fingerprint := encode(extensions.digest(jsonb_build_object(
    'eventKey', v_event_key, 'txSig', v_sig, 'slot', p_slot,
    'blockTime', p_block_time, 'targetWallet', v_target,
    'tokenMint', v_token_mint, 'side', v_side,
    'amountRaw', p_amount_raw::text, 'totalSupplyRaw', p_total_supply_raw::text,
    'decimals', p_decimals,
    'pumpFunVerified', p_pump_fun_verified,
    'classificationReliable', p_classification_reliable,
    'parserDomain', v_parser_domain,
    'parserAbiFingerprint', v_abi
  )::text, 'sha256'), 'hex');

  select * into v_existing
  from public.custody_fresh_tail_supply_events
  where epoch_id = p_epoch_id and event_key = v_event_key
  for update;
  if found then
    if v_existing.evidence_fingerprint <> v_evidence_fingerprint
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
    epoch_id, user_id, event_key, payload_fingerprint, evidence_fingerprint, tx_sig, slot,
    block_time, target_wallet, token_mint, side, amount_raw,
    total_supply_raw, decimals, market_cap_usd, valuation_slot,
    market_data_reliable, pump_fun_verified, classification_reliable,
    parser_domain, parser_abi_fingerprint,
    finalized_head_slot, finalized_head_blockhash
  ) values (
    p_epoch_id, p_user_id, v_event_key, v_fingerprint, v_evidence_fingerprint, v_sig, p_slot,
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

create or replace function public.invalidate_failed_custody_fresh_tail_shadow_epoch(
  p_user_id uuid,
  p_epoch_id uuid,
  p_expected_lease_generation bigint,
  p_expected_latest_head_slot bigint,
  p_expected_latest_head_blockhash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_config public.bot_config%rowtype;
  v_epoch public.custody_fresh_tail_epochs%rowtype;
  v_heartbeat public.custody_fresh_tail_worker_heartbeat%rowtype;
  v_expected_hash text := btrim(coalesce(p_expected_latest_head_blockhash, ''));
  v_root_count integer;
  v_root_cursor_count integer;
  v_clean_root_cursor_count integer;
  v_poisoned_mint_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;
  if p_user_id is null or p_epoch_id is null
     or p_expected_lease_generation is null or p_expected_lease_generation <= 0
     or p_expected_latest_head_slot is null or p_expected_latest_head_slot < 0
     or v_expected_hash = '' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_shadow_invalidation');
  end if;

  -- Serialize against activation, and hold the epoch row so a stopped worker
  -- cannot reacquire its expired lease while the evidence is being checked.
  perform pg_advisory_xact_lock(
    hashtext(p_user_id::text), hashtext('fresh-tail-epoch')
  );
  select * into v_epoch
  from public.custody_fresh_tail_epochs
  where id = p_epoch_id and user_id = p_user_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'epoch_not_found');
  end if;
  if v_epoch.status = 'invalidated'
     and v_epoch.invalid_reason = 'failed_shadow_epoch_no_root_progress' then
    return jsonb_build_object(
      'ok', true, 'reason', 'already_invalidated', 'epochId', v_epoch.id,
      'invalidReason', v_epoch.invalid_reason
    );
  end if;
  if v_epoch.status <> 'active'
     or v_epoch.lease_generation <> p_expected_lease_generation then
    return jsonb_build_object('ok', false, 'reason', 'epoch_state_changed');
  end if;
  if v_epoch.lease_owner is null or v_epoch.lease_token is null
     or v_epoch.lease_expires_at is null
     or v_epoch.lease_expires_at > clock_timestamp() then
    return jsonb_build_object('ok', false, 'reason', 'observer_lease_still_live');
  end if;

  select * into v_config
  from public.bot_config
  where user_id = p_user_id
  for update;
  if not found
     or v_config.enabled is not false
     or v_config.supply_accumulation_mode_enabled is not true
     or v_config.custody_journey_enabled is not true
     or v_config.coordinated_mode_enabled is not false
     or v_config.conviction_mode_enabled is not false
     or v_config.direct_target_sell_exit_mode = 'proportional' then
    return jsonb_build_object('ok', false, 'reason', 'shadow_recovery_config_changed');
  end if;

  select * into v_heartbeat
  from public.custody_fresh_tail_worker_heartbeat
  where user_id = p_user_id and epoch_id = p_epoch_id
  for update;
  if not found
     or v_heartbeat.enabled is not true
     or v_heartbeat.shadow is not true
     or v_heartbeat.lease_generation <> p_expected_lease_generation
     or v_heartbeat.lease_token is distinct from v_epoch.lease_token
     or v_heartbeat.worker_id is distinct from v_epoch.lease_owner
     or v_heartbeat.lease_expires_at is null
     or v_heartbeat.lease_expires_at > clock_timestamp()
     or v_heartbeat.last_success_at is not null
     or v_heartbeat.root_required_count <> 3
     or v_heartbeat.root_covered_count <> 0
     or v_heartbeat.root_backlog_count <> 3
     or v_heartbeat.latest_head_slot <> p_expected_latest_head_slot
     or v_heartbeat.latest_head_blockhash <> v_expected_hash
     or coalesce(v_heartbeat.last_error, '') not like
       'fresh Pump creation proof exhausted its absolute wall-clock budget before finalized creation transaction load%' then
    return jsonb_build_object('ok', false, 'reason', 'failed_shadow_heartbeat_mismatch');
  end if;
  if not exists (
    select 1 from public.custody_fresh_tail_finalized_heads h
    where h.epoch_id = p_epoch_id and h.user_id = p_user_id
      and h.slot = p_expected_latest_head_slot
      and h.blockhash = v_expected_hash
      and h.block_time = v_heartbeat.latest_head_block_time
  ) then
    return jsonb_build_object('ok', false, 'reason', 'failed_shadow_head_not_attested');
  end if;

  select count(*)::integer into v_root_count
  from public.custody_fresh_tail_roots r
  where r.epoch_id = p_epoch_id and r.user_id = p_user_id;
  select
    count(*)::integer,
    count(*) filter (
      where c.scope_mint = '*'
        and c.cursor_role = 'root'
        and c.floor_slot = v_epoch.activation_slot
        and c.initial_boundary_kind = 'exclusive_slot'
        and c.current_boundary_kind = 'exclusive_slot'
        and c.last_processed_signature is null
        and c.last_processed_slot is null
        and c.last_block_time is null
        and c.first_available_block is null
        and c.history_floor_proven is false
        and c.covered_through_slot is null
        and c.covered_through_blockhash is null
        and c.coverage_revision = 0
        and c.last_success_at is null
    )::integer
  into v_root_cursor_count, v_clean_root_cursor_count
  from public.custody_fresh_tail_cursors c
  where c.epoch_id = p_epoch_id and c.scope_mint = '*'
    and c.cursor_role = 'root';
  if v_root_count <> 3 or v_root_cursor_count <> 3
     or v_clean_root_cursor_count <> 3
     or exists (
       select 1
       from public.custody_fresh_tail_roots r
       left join public.custody_fresh_tail_cursors c
         on c.epoch_id = r.epoch_id and c.scope_mint = '*' and c.wallet = r.wallet
       where r.epoch_id = p_epoch_id and (
         c.wallet is null or c.user_id <> r.user_id or c.floor_slot <> r.floor_slot
       )
     )
     or exists (
       select 1 from public.custody_fresh_tail_cursors c
       where c.epoch_id = p_epoch_id and (
         c.last_processed_signature is not null
         or c.last_processed_slot is not null
         or c.last_block_time is not null
         or c.first_available_block is not null
         or c.history_floor_proven
         or c.covered_through_slot is not null
         or c.covered_through_blockhash is not null
         or c.last_success_at is not null
       )
     )
     or exists (
       select 1 from public.custody_fresh_tail_backscan_ranges r
       where r.epoch_id = p_epoch_id and (
         r.last_processed_signature is not null
         or r.last_processed_slot is not null
         or r.last_block_time is not null
         or r.first_available_block is not null
         or r.history_floor_proven
         or r.covered_through_slot is not null
         or r.covered_through_blockhash is not null
         or r.last_success_at is not null
         or r.completed_at is not null
       )
     )
     or exists (
       select 1 from public.custody_fresh_tail_coverage_attestations a
       where a.epoch_id = p_epoch_id
     ) then
    return jsonb_build_object('ok', false, 'reason', 'cursor_progress_detected');
  end if;

  if exists (
    select 1 from public.custody_fresh_tail_requests q
    where q.epoch_id = p_epoch_id
  ) or exists (
    select 1 from public.entry_signal_claims c
    where c.user_id = p_user_id and c.fresh_tail_epoch_id = p_epoch_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'fresh_entry_work_exists');
  end if;
  if exists (
    select 1
    from public.positions p
    where p.user_id = p_user_id
      and exists (
        select 1 from public.custody_fresh_tail_mints m
        where m.epoch_id = p_epoch_id and m.user_id = p_user_id
          and m.token_mint = p.token_mint
      )
  ) then
    return jsonb_build_object('ok', false, 'reason', 'position_exists_for_enrolled_mint');
  end if;
  if exists (
    select 1 from public.custody_fresh_tail_exit_intents i
    where i.user_id = p_user_id and i.epoch_id = p_epoch_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'fresh_exit_work_exists');
  end if;
  if exists (
    select 1 from public.custody_fresh_tail_mint_rejections r
    where r.epoch_id = p_epoch_id and r.quarantined
  ) then
    return jsonb_build_object('ok', false, 'reason', 'rejection_conflict_present');
  end if;

  select count(*)::integer into v_poisoned_mint_count
  from public.custody_fresh_tail_mints m
  where m.epoch_id = p_epoch_id and m.user_id = p_user_id
    and m.status = 'active' and m.poisoned
    and m.poison_reason = 'supply_payload_conflict';
  if v_poisoned_mint_count = 0
     or exists (
       select 1
       from public.custody_fresh_tail_mints m
       where m.epoch_id = p_epoch_id and m.user_id = p_user_id
         and m.poisoned and (
           m.status <> 'active'
           or m.poison_reason is distinct from 'supply_payload_conflict'
           or not exists (
             select 1 from public.custody_fresh_tail_supply_events e
             where e.epoch_id = m.epoch_id and e.token_mint = m.token_mint
               and e.quarantined and e.conflict_count > 0
               and e.first_conflict_at is not null
           )
         )
     )
     or exists (
       select 1
       from public.custody_fresh_tail_supply_events e
       left join public.custody_fresh_tail_mints m
         on m.epoch_id = e.epoch_id and m.token_mint = e.token_mint
       where e.epoch_id = p_epoch_id and e.user_id = p_user_id
         and e.quarantined and (
           e.conflict_count <= 0 or e.first_conflict_at is null
           or m.token_mint is null or not m.poisoned
           or m.poison_reason is distinct from 'supply_payload_conflict'
         )
     ) then
    return jsonb_build_object('ok', false, 'reason', 'valuation_replay_conflict_not_proven');
  end if;

  update public.custody_fresh_tail_epochs set
    status = 'invalidated',
    invalid_reason = 'failed_shadow_epoch_no_root_progress',
    updated_at = clock_timestamp()
  where id = p_epoch_id and user_id = p_user_id
    and status = 'active'
    and lease_generation = p_expected_lease_generation;
  if not found then
    raise exception using
      errcode = '40001',
      message = 'fresh-tail epoch changed during failed-shadow invalidation';
  end if;

  return jsonb_build_object(
    'ok', true, 'reason', 'invalidated', 'epochId', p_epoch_id,
    'invalidReason', 'failed_shadow_epoch_no_root_progress',
    'preservedPoisonedMintCount', v_poisoned_mint_count,
    'latestHeadSlot', p_expected_latest_head_slot,
    'leaseGeneration', p_expected_lease_generation
  );
end;
$$;

-- Every hotfix SECURITY DEFINER routine remains service-only.
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
        'reject_custody_fresh_tail_mint',
        'record_custody_fresh_tail_supply_event',
        'invalidate_failed_custody_fresh_tail_shadow_epoch'
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

do $$
declare
  v_missing text[];
begin
  select array_agg(name order by name) into v_missing
  from unnest(array[
    'reject_custody_fresh_tail_mint',
    'record_custody_fresh_tail_supply_event',
    'invalidate_failed_custody_fresh_tail_shadow_epoch'
  ]) name
  where not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = name
      and p.prosecdef
  );
  if v_missing is not null then
    raise exception 'fresh-tail replay hotfix function verification failed: %', v_missing;
  end if;

  if exists (
    select 1
    from pg_attribute a
    where a.attrelid in (
      'public.custody_fresh_tail_mint_rejections'::regclass,
      'public.custody_fresh_tail_supply_events'::regclass
    )
      and a.attname = 'evidence_fingerprint'
      and (a.attisdropped or not a.attnotnull)
  ) or (
    select count(*)
    from pg_attribute a
    where a.attrelid in (
      'public.custody_fresh_tail_mint_rejections'::regclass,
      'public.custody_fresh_tail_supply_events'::regclass
    )
      and a.attname = 'evidence_fingerprint'
      and not a.attisdropped
  ) <> 2 then
    raise exception 'fresh-tail replay evidence columns are missing or nullable';
  end if;
end $$;

commit;
