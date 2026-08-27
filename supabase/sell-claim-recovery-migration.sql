-- Durable, replay-safe sell accounting.
--
-- Apply this migration before deploying the matching worker.  Legacy claims
-- remain readable, but only attempts prepared by the v1 RPC are eligible for
-- automatic chain reconciliation.

begin;

-- Canonical follower-owned token quantity.  NULL is deliberately meaningful:
-- legacy/UI-only positions have no provable raw provenance and must fail
-- closed.  Never backfill this from amount_remaining or a wallet snapshot.
alter table public.positions
  add column if not exists amount_remaining_raw text;

alter table public.positions
  drop constraint if exists positions_amount_remaining_raw_check;
alter table public.positions
  add constraint positions_amount_remaining_raw_check check (
    amount_remaining_raw is null
    or (
      amount_remaining_raw ~ '^[0-9]+$'
      and char_length(amount_remaining_raw) <= 78
    )
  ) not valid;

-- Fresh entry persistence owns the only safe seed for canonical raw position
-- accounting.  Existing persisted rows are intentionally not backfilled.
alter table public.entry_signal_claims
  add column if not exists received_amount_raw text;

alter table public.entry_signal_claims
  drop constraint if exists entry_signal_claims_received_amount_raw_check;
alter table public.entry_signal_claims
  add constraint entry_signal_claims_received_amount_raw_check check (
    received_amount_raw is null
    or (
      received_amount_raw ~ '^[1-9][0-9]*$'
      and char_length(received_amount_raw) <= 78
    )
  ) not valid;

create or replace function public.seed_supply_position_raw_from_entry()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_position public.positions%rowtype;
begin
  if new.entry_strategy is distinct from 'supply_accumulation'
     or new.status is distinct from 'persisted' then
    return new;
  end if;
  if new.received_amount_raw is null then
    -- Legacy Supply claims predate exact receipts. Keep their position raw
    -- provenance NULL so direct recovered exits fail closed; the separate
    -- fresh-tail claim constraint requires a receipt for every fresh entry.
    return new;
  end if;
  select * into v_position
  from public.positions p
  where p.id = new.planned_position_id
    and p.user_id = new.user_id
    and p.token_mint = new.token_mint
  for update;
  if not found then
    raise exception using errcode = '23503', message = 'Fresh Supply position is missing';
  end if;
  if coalesce(v_position.decimals, -1) <> coalesce(new.token_decimals, -2) then
    raise exception using errcode = '23514', message = 'Fresh Supply receipt decimals mismatch';
  end if;
  if v_position.amount_remaining_raw is null then
    update public.positions set amount_remaining_raw = new.received_amount_raw
    where id = v_position.id and user_id = new.user_id;
  elsif v_position.amount_remaining_raw is distinct from new.received_amount_raw then
    raise exception using errcode = '23514', message = 'Fresh Supply raw replay mismatch';
  end if;
  return new;
end $$;

drop trigger if exists seed_supply_position_raw_from_entry_trigger
  on public.entry_signal_claims;
create trigger seed_supply_position_raw_from_entry_trigger
after insert or update of status, received_amount_raw
on public.entry_signal_claims
for each row execute function public.seed_supply_position_raw_from_entry();

-- The deployed scale RPC updates the claim last in the same transaction.  An
-- AFTER trigger makes its exact receipt part of the same commit without
-- relying on its numeric/UI position update.  NULL legacy provenance aborts
-- and rolls back the entire scale application, including its trade row.
create or replace function public.increment_supply_position_raw_from_scale()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_position public.positions%rowtype;
  v_next_raw numeric;
begin
  if new.status is distinct from 'persisted'
     or new.applied_at is null
     or new.received_amount_raw is null
     or (old.status = 'persisted' and old.applied_at is not null) then
    return new;
  end if;
  select * into v_position
  from public.positions p
  where p.id = new.position_id
    and p.user_id = new.user_id
    and p.token_mint = new.token_mint
  for update;
  if not found then
    raise exception using errcode = '23503', message = 'Supply scale position is missing';
  end if;
  if v_position.amount_remaining_raw is null then
    raise exception using
      errcode = '23514',
      message = 'Supply scale blocked because exact position raw provenance is unavailable';
  end if;
  if coalesce(v_position.decimals, -1) <> new.token_decimals then
    raise exception using errcode = '23514', message = 'Supply scale receipt decimals mismatch';
  end if;
  v_next_raw := v_position.amount_remaining_raw::numeric
    + new.received_amount_raw::numeric;
  update public.positions set amount_remaining_raw = v_next_raw::text
  where id = v_position.id and user_id = new.user_id;
  return new;
end $$;

drop trigger if exists increment_supply_position_raw_from_scale_trigger
  on public.supply_accumulation_scale_claims;
create trigger increment_supply_position_raw_from_scale_trigger
after update of status, received_amount_raw, applied_at
on public.supply_accumulation_scale_claims
for each row execute function public.increment_supply_position_raw_from_scale();

alter table public.sell_signal_claims
  add column if not exists recovery_version smallint,
  add column if not exists token_decimals integer,
  add column if not exists executed_sell_amount_raw text,
  add column if not exists prepared_wallet_balance_raw text,
  add column if not exists position_amount_before_raw text,
  add column if not exists recent_blockhash text,
  add column if not exists last_valid_block_height bigint,
  add column if not exists receipt_pre_amount_raw text,
  add column if not exists receipt_post_amount_raw text,
  add column if not exists trade_id uuid references public.trades(id) on delete set null,
  add column if not exists exit_reason text,
  add column if not exists mark_tp_taken boolean not null default false,
  add column if not exists mark_coordinated_exit boolean not null default false,
  add column if not exists mark_follower_seller_exit boolean not null default false,
  add column if not exists mirrored_sold_fraction numeric,
  add column if not exists execution_route text,
  add column if not exists execution_latency_ms integer,
  add column if not exists persisted_at timestamptz;

alter table public.sell_signal_claims
  drop constraint if exists sell_signal_claims_recovery_v1_check;
alter table public.sell_signal_claims
  add constraint sell_signal_claims_recovery_v1_check check (
    recovery_version is null
    or (
      recovery_version = 1
      and token_decimals between 0 and 18
      and executed_sell_amount_raw ~ '^[1-9][0-9]*$'
      and char_length(executed_sell_amount_raw) <= 78
      and prepared_wallet_balance_raw ~ '^[1-9][0-9]*$'
      and char_length(prepared_wallet_balance_raw) <= 78
      and position_amount_before_raw ~ '^[1-9][0-9]*$'
      and char_length(position_amount_before_raw) <= 78
      and executed_sell_amount_raw::numeric <= prepared_wallet_balance_raw::numeric
      and executed_sell_amount_raw::numeric <= position_amount_before_raw::numeric
      and bot_tx_sig is not null
      and btrim(bot_tx_sig) <> ''
      and recent_blockhash is not null
      and btrim(recent_blockhash) <> ''
      and last_valid_block_height is not null
      and last_valid_block_height > 0
      and (execution_latency_ms is null or execution_latency_ms >= 0)
      and (execution_route is null or execution_route in ('jito', 'rpc'))
      and (mirrored_sold_fraction is null or mirrored_sold_fraction between 0 and 1)
      and (
        (receipt_pre_amount_raw is null and receipt_post_amount_raw is null)
        or (
          receipt_pre_amount_raw ~ '^[1-9][0-9]*$'
          and char_length(receipt_pre_amount_raw) <= 78
          and receipt_post_amount_raw ~ '^[0-9]+$'
          and char_length(receipt_post_amount_raw) <= 78
          and receipt_pre_amount_raw::numeric - receipt_post_amount_raw::numeric
            = executed_sell_amount_raw::numeric
        )
      )
      and (
        status <> 'landed'
        or (
          receipt_pre_amount_raw is not null
          and receipt_post_amount_raw is not null
          and trade_id is not null
          and landed_at is not null
          and persisted_at is not null
        )
      )
    )
  ) not valid;

-- A locally signed transaction can belong to only one durable sell claim.
create unique index if not exists sell_signal_claims_bot_signature_idx
  on public.sell_signal_claims (user_id, bot_tx_sig)
  where bot_tx_sig is not null;

-- Makes transaction-ledger replay deterministic. Existing duplicates make the
-- migration fail instead of silently choosing an accounting row.
create unique index if not exists trades_sell_signature_idx
  on public.trades (user_id, tx_sig)
  where side = 'sell';

create or replace function public.prepare_sell_claim_attempt_v1(
  p_user_id uuid,
  p_claim_id uuid,
  p_bot_tx_sig text,
  p_recent_blockhash text,
  p_last_valid_block_height bigint,
  p_executed_sell_amount_raw text,
  p_prepared_wallet_balance_raw text,
  p_position_amount_before_raw text,
  p_token_decimals integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_signature text := btrim(coalesce(p_bot_tx_sig, ''));
  v_blockhash text := btrim(coalesce(p_recent_blockhash, ''));
  v_sell_raw numeric;
  v_wallet_raw numeric;
  v_position_raw numeric;
  v_claim public.sell_signal_claims%rowtype;
  v_position public.positions%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;
  if p_user_id is null or p_claim_id is null
     or v_signature = '' or char_length(v_signature) > 128
     or v_blockhash = '' or char_length(v_blockhash) > 128
     or p_executed_sell_amount_raw is null
     or p_executed_sell_amount_raw !~ '^[1-9][0-9]*$'
     or char_length(p_executed_sell_amount_raw) > 78
     or p_prepared_wallet_balance_raw is null
     or p_prepared_wallet_balance_raw !~ '^[1-9][0-9]*$'
     or char_length(p_prepared_wallet_balance_raw) > 78
     or p_position_amount_before_raw is null
     or p_position_amount_before_raw !~ '^[1-9][0-9]*$'
     or char_length(p_position_amount_before_raw) > 78
     or p_token_decimals is null or p_token_decimals < 0 or p_token_decimals > 18
     or p_last_valid_block_height is null
     or p_last_valid_block_height <= 0 then
    return jsonb_build_object('prepared', false, 'reason', 'invalid_request');
  end if;
  v_sell_raw := p_executed_sell_amount_raw::numeric;
  v_wallet_raw := p_prepared_wallet_balance_raw::numeric;
  if v_sell_raw > v_wallet_raw then
    return jsonb_build_object('prepared', false, 'reason', 'sell_exceeds_wallet_balance');
  end if;

  select * into v_claim
  from public.sell_signal_claims c
  where c.id = p_claim_id and c.user_id = p_user_id;
  if not found then
    return jsonb_build_object('prepared', false, 'reason', 'claim_not_found');
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(
      'helix-position-action:' || p_user_id::text || ':' || v_claim.position_id::text,
      0
    )
  );
  select * into v_claim
  from public.sell_signal_claims c
  where c.id = p_claim_id and c.user_id = p_user_id
  for update;
  if v_claim.status <> 'claimed'
     or v_claim.bot_tx_sig is not null
     or v_claim.recovery_version is not null then
    return jsonb_build_object('prepared', false, 'reason', 'claim_changed');
  end if;

  select * into v_position
  from public.positions p
  where p.id = v_claim.position_id and p.user_id = p_user_id
  for update;
  if not found then
    return jsonb_build_object('prepared', false, 'reason', 'position_not_found');
  end if;
  if v_position.closed_at is not null then
    return jsonb_build_object('prepared', false, 'reason', 'position_not_open');
  end if;
  if coalesce(v_position.decimals, -1) <> p_token_decimals then
    return jsonb_build_object('prepared', false, 'reason', 'position_decimals_mismatch');
  end if;
  if v_position.amount_remaining_raw is null then
    return jsonb_build_object('prepared', false, 'reason', 'position_raw_unavailable');
  end if;
  v_position_raw := v_position.amount_remaining_raw::numeric;
  if v_position.amount_remaining_raw is distinct from p_position_amount_before_raw then
    return jsonb_build_object('prepared', false, 'reason', 'position_balance_changed');
  end if;
  if v_position_raw <= 0 or v_sell_raw > v_position_raw then
    return jsonb_build_object('prepared', false, 'reason', 'sell_exceeds_position_balance');
  end if;

  update public.sell_signal_claims set
    status = 'submitted',
    recovery_version = 1,
    bot_tx_sig = v_signature,
    recent_blockhash = v_blockhash,
    last_valid_block_height = p_last_valid_block_height,
    executed_sell_amount_raw = p_executed_sell_amount_raw,
    prepared_wallet_balance_raw = p_prepared_wallet_balance_raw,
    position_amount_before_raw = p_position_amount_before_raw,
    token_decimals = p_token_decimals,
    submission_started_at = now(),
    error_code = null,
    updated_at = now()
  where id = v_claim.id and user_id = p_user_id
    and status = 'claimed' and bot_tx_sig is null and recovery_version is null;
  if not found then
    raise exception using errcode = '40001', message = 'sell claim changed during preparation';
  end if;
  return jsonb_build_object(
    'prepared', true,
    'reason', 'attempt_prepared',
    'positionAmountBeforeRaw', v_position_raw::text
  );
end $$;

create or replace function public.apply_landed_sell_claim_v1(
  p_user_id uuid,
  p_claim_id uuid,
  p_bot_tx_sig text,
  p_sold_amount_raw text,
  p_receipt_pre_amount_raw text,
  p_receipt_post_amount_raw text,
  p_token_decimals integer,
  p_route text default null,
  p_latency_ms integer default null,
  p_exit_price_usd numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_signature text := btrim(coalesce(p_bot_tx_sig, ''));
  v_sold_raw numeric;
  v_pre_raw numeric;
  v_post_raw numeric;
  v_current_raw numeric;
  v_new_raw numeric;
  v_scale numeric;
  v_amount_tokens numeric;
  v_amount_usd numeric;
  v_pnl_pct numeric;
  v_trade_id uuid;
  v_claim public.sell_signal_claims%rowtype;
  v_position public.positions%rowtype;
  v_existing_trade public.trades%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;
  if p_user_id is null or p_claim_id is null or v_signature = ''
     or p_sold_amount_raw is null or p_sold_amount_raw !~ '^[1-9][0-9]*$'
     or char_length(p_sold_amount_raw) > 78
     or p_receipt_pre_amount_raw is null or p_receipt_pre_amount_raw !~ '^[1-9][0-9]*$'
     or char_length(p_receipt_pre_amount_raw) > 78
     or p_receipt_post_amount_raw is null or p_receipt_post_amount_raw !~ '^[0-9]+$'
     or char_length(p_receipt_post_amount_raw) > 78
     or p_token_decimals is null or p_token_decimals < 0 or p_token_decimals > 18
     or (p_route is not null and p_route not in ('jito', 'rpc'))
     or (p_latency_ms is not null and p_latency_ms < 0)
     or (p_exit_price_usd is not null and p_exit_price_usd <= 0) then
    return jsonb_build_object('applied', false, 'replay', false, 'reason', 'invalid_request');
  end if;
  v_sold_raw := p_sold_amount_raw::numeric;
  v_pre_raw := p_receipt_pre_amount_raw::numeric;
  v_post_raw := p_receipt_post_amount_raw::numeric;
  if v_pre_raw - v_post_raw <> v_sold_raw then
    return jsonb_build_object('applied', false, 'replay', false, 'reason', 'receipt_delta_mismatch');
  end if;

  select * into v_claim
  from public.sell_signal_claims c
  where c.id = p_claim_id and c.user_id = p_user_id;
  if not found then
    return jsonb_build_object('applied', false, 'replay', false, 'reason', 'claim_not_found');
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(
      'helix-position-action:' || p_user_id::text || ':' || v_claim.position_id::text,
      0
    )
  );
  select * into v_claim
  from public.sell_signal_claims c
  where c.id = p_claim_id and c.user_id = p_user_id
  for update;
  select * into v_position
  from public.positions p
  where p.id = v_claim.position_id and p.user_id = p_user_id
  for update;
  if not found then
    return jsonb_build_object('applied', false, 'replay', false, 'reason', 'position_not_found');
  end if;

  if v_claim.recovery_version is distinct from 1
     or v_claim.bot_tx_sig is distinct from v_signature
     or v_claim.executed_sell_amount_raw is distinct from p_sold_amount_raw
     or v_claim.token_decimals is distinct from p_token_decimals then
    return jsonb_build_object('applied', false, 'replay', false, 'reason', 'prepared_attempt_mismatch');
  end if;
  if v_claim.status = 'landed' then
    if v_claim.receipt_pre_amount_raw is distinct from p_receipt_pre_amount_raw
       or v_claim.receipt_post_amount_raw is distinct from p_receipt_post_amount_raw
       or v_claim.trade_id is null then
      return jsonb_build_object('applied', false, 'replay', false, 'reason', 'persisted_receipt_mismatch');
    end if;
    select * into v_existing_trade
    from public.trades t
    where t.id = v_claim.trade_id
      and t.user_id = p_user_id
      and t.position_id = v_claim.position_id
      and t.side = 'sell'
      and t.token_mint = v_position.token_mint
      and t.tx_sig = v_signature;
    if not found then
      return jsonb_build_object('applied', false, 'replay', false, 'reason', 'persisted_trade_mismatch');
    end if;
    if trunc(v_existing_trade.amount_tokens * power(10::numeric, p_token_decimals)) <> v_sold_raw
       or v_existing_trade.amount_tokens * power(10::numeric, p_token_decimals) <> v_sold_raw then
      return jsonb_build_object('applied', false, 'replay', false, 'reason', 'persisted_trade_mismatch');
    end if;
    return jsonb_build_object(
      'applied', false, 'replay', true, 'reason', 'already_applied',
      'closed', v_position.closed_at is not null,
      'amountRemaining', v_position.amount_remaining::text,
      'tradeId', v_claim.trade_id::text
    );
  end if;
  if v_position.token_mint is null or coalesce(v_position.decimals, -1) <> p_token_decimals then
    return jsonb_build_object('applied', false, 'replay', false, 'reason', 'position_identity_mismatch');
  end if;
  if v_position.closed_at is not null then
    return jsonb_build_object('applied', false, 'replay', false, 'reason', 'position_already_closed');
  end if;
  if v_claim.status not in ('submitted', 'uncertain') then
    return jsonb_build_object('applied', false, 'replay', false, 'reason', 'claim_not_applyable');
  end if;
  if exists (
    select 1 from public.trades t
    where t.user_id = p_user_id and t.side = 'sell' and t.tx_sig = v_signature
  ) then
    return jsonb_build_object('applied', false, 'replay', false, 'reason', 'sell_signature_already_recorded');
  end if;

  v_scale := power(10::numeric, p_token_decimals);
  if v_position.amount_remaining_raw is null then
    return jsonb_build_object('applied', false, 'replay', false, 'reason', 'position_raw_unavailable');
  end if;
  v_current_raw := v_position.amount_remaining_raw::numeric;
  if v_current_raw::text is distinct from v_claim.position_amount_before_raw then
    return jsonb_build_object('applied', false, 'replay', false, 'reason', 'position_balance_changed');
  end if;
  if v_sold_raw <= v_current_raw then
    v_new_raw := v_current_raw - v_sold_raw;
  else
    return jsonb_build_object('applied', false, 'replay', false, 'reason', 'sell_exceeds_position_balance');
  end if;
  v_amount_tokens := v_sold_raw / v_scale;
  v_amount_usd := case when p_exit_price_usd is null then null else v_amount_tokens * p_exit_price_usd end;
  v_pnl_pct := case
    when p_exit_price_usd is null or coalesce(v_position.entry_price_usd, 0) <= 0 then null
    else ((p_exit_price_usd - v_position.entry_price_usd) / v_position.entry_price_usd) * 100
  end;
  v_trade_id := gen_random_uuid();

  insert into public.trades (
    id, user_id, position_id, side, token_mint, amount_tokens, amount_usd,
    price_usd, pnl_pct, tx_sig, reason, latency_ms, route
  ) values (
    v_trade_id, p_user_id, v_position.id, 'sell', v_position.token_mint,
    v_amount_tokens, v_amount_usd, p_exit_price_usd, v_pnl_pct, v_signature,
    coalesce(nullif(v_claim.exit_reason, ''), 'durable recovered exit'),
    p_latency_ms, p_route
  );

  update public.positions set
    amount_remaining = v_new_raw / v_scale,
    amount_remaining_raw = v_new_raw::text,
    closed_at = case when v_new_raw = 0 then now() else null end,
    tp_taken = case when v_claim.mark_tp_taken then true else tp_taken end,
    coordinated_exit_triggered = case
      when v_claim.mark_coordinated_exit then true else coordinated_exit_triggered end,
    follower_seller_exit_triggered = case
      when v_claim.mark_follower_seller_exit then true else follower_seller_exit_triggered end,
    mirrored_sold_fraction = case
      when v_claim.mirrored_sold_fraction is null then mirrored_sold_fraction
      else greatest(coalesce(mirrored_sold_fraction, 0), v_claim.mirrored_sold_fraction)
    end
  where id = v_position.id and user_id = p_user_id;

  update public.sell_signal_claims set
    status = 'landed',
    receipt_pre_amount_raw = p_receipt_pre_amount_raw,
    receipt_post_amount_raw = p_receipt_post_amount_raw,
    trade_id = v_trade_id,
    execution_route = p_route,
    execution_latency_ms = p_latency_ms,
    error_code = null,
    landed_at = coalesce(landed_at, now()),
    persisted_at = now(),
    updated_at = now()
  where id = v_claim.id and user_id = p_user_id
    and status in ('submitted', 'uncertain')
    and bot_tx_sig = v_signature;
  if not found then
    raise exception using errcode = '40001', message = 'sell claim changed during atomic application';
  end if;

  return jsonb_build_object(
    'applied', true, 'replay', false, 'reason', 'sell_applied',
    'closed', v_new_raw = 0,
    'amountRemaining', (v_new_raw / v_scale)::text,
    'tradeId', v_trade_id::text
  );
end $$;

revoke all on function public.prepare_sell_claim_attempt_v1(
  uuid, uuid, text, text, bigint, text, text, text, integer
) from public, anon, authenticated;
grant execute on function public.prepare_sell_claim_attempt_v1(
  uuid, uuid, text, text, bigint, text, text, text, integer
) to service_role;

revoke all on function public.apply_landed_sell_claim_v1(
  uuid, uuid, text, text, text, text, integer, text, integer, numeric
) from public, anon, authenticated;
grant execute on function public.apply_landed_sell_claim_v1(
  uuid, uuid, text, text, text, text, integer, text, integer, numeric
) to service_role;

commit;
