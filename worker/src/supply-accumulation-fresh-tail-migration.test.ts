import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const migration = readFileSync(
  root("supabase/supply-accumulation-fresh-tail-migration.sql"),
  "utf8",
);
const schema = readFileSync(root("supabase/schema.sql"), "utf8");
const doctor = readFileSync(root("worker/src/doctor.ts"), "utf8");
const types = readFileSync(root("src/lib/supabase-types.ts"), "utf8");

const tables = [
  "custody_fresh_tail_epochs",
  "custody_fresh_tail_roots",
  "custody_fresh_tail_finalized_heads",
  "custody_fresh_tail_mints",
  "custody_fresh_tail_mint_rejections",
  "custody_fresh_tail_supply_events",
  "custody_fresh_tail_custody_events",
  "custody_fresh_tail_edges",
  "custody_fresh_tail_wallets",
  "custody_fresh_tail_requests",
  "custody_fresh_tail_cursors",
  "custody_fresh_tail_backscan_ranges",
  "custody_fresh_tail_coverage_attestations",
  "custody_fresh_tail_exit_intents",
  "custody_fresh_tail_worker_heartbeat",
];

const rpcs = [
  "assert_custody_fresh_tail_lease",
  "is_custody_fresh_tail_parser_reviewed",
  "activate_custody_fresh_tail_epoch",
  "get_custody_fresh_tail_active_epoch",
  "acquire_custody_fresh_tail_lease",
  "record_custody_fresh_tail_heartbeat",
  "attest_custody_fresh_tail_finalized_head",
  "get_custody_fresh_tail_work",
  "reject_custody_fresh_tail_mint",
  "attest_custody_fresh_tail_mint_creation",
  "record_custody_fresh_tail_supply_event",
  "record_custody_fresh_tail_custody_event",
  "sync_custody_fresh_tail_scope",
  "retire_custody_fresh_tail_mint",
  "request_custody_fresh_tail_coverage",
  "record_custody_fresh_tail_cursor",
  "record_custody_fresh_tail_backscan_cursor",
  "settle_custody_fresh_tail_request",
  "bind_supply_entry_claim_fresh_tail",
  "record_supply_entry_claim_fresh_tail_receipt",
  "claim_custody_fresh_tail_exit_intents",
  "claim_custody_fresh_tail_uncertain_intents",
  "resolve_custody_fresh_tail_exit_intent",
  "check_supply_accumulation_fresh_custody_gate",
  "get_custody_fresh_tail_entry_candidates",
];

test("fresh-tail migration is transactional, additive, and leaves old gates/cursors alone", () => {
  assert.match(migration, /^begin;/im);
  assert.match(migration, /^commit;\s*$/im);
  assert.doesNotMatch(migration, /^\s*truncate\s+(?:table\s+)?/im);
  assert.doesNotMatch(migration, /\bdrop\s+(?:table|column|schema|function)\b/i);
  assert.doesNotMatch(
    migration,
    /create or replace function public\.check_supply_accumulation_custody_gate\s*\(/i,
  );
  assert.doesNotMatch(
    migration,
    /(?:insert\s+into|update|delete\s+from)\s+public\.(?:custody_rpc_wallet_cursors|rpc_wallet_cursors|bot_config|positions|trades|supply_accumulation_scale_claims)\b/i,
  );
});

test("all tables precede helpers and every RPC uses the hardened execution boundary", () => {
  const helperAt = migration.indexOf(
    "create or replace function public.assert_custody_fresh_tail_lease(",
  );
  assert.ok(helperAt > 0);
  for (const table of tables) {
    const tableAt = migration.indexOf(`create table if not exists public.${table} (`);
    assert.ok(tableAt >= 0, `${table} is missing`);
    assert.ok(tableAt < helperAt, `${table} must precede helper/RPC definitions`);
    assert.match(
      migration,
      new RegExp(`alter table public\\.${table} enable row level security;`, "i"),
    );
  }
  for (const rpc of rpcs) {
    const start = migration.indexOf(`create or replace function public.${rpc}(`);
    assert.ok(start >= helperAt, `${rpc} is missing or out of order`);
    const next = migration.indexOf("create or replace function public.", start + 1);
    const body = migration.slice(start, next < 0 ? migration.length : next);
    assert.match(body, /security definer/i);
    assert.match(body, /set search_path = pg_catalog, public, pg_temp/i);
    assert.match(
      body,
      /coalesce\(auth\.role\(\), ''\) <> 'service_role'|assert_custody_fresh_tail_lease/i,
    );
    assert.match(migration, new RegExp(`'${rpc}'`));
  }
  assert.match(migration, /revoke all on function[\s\S]*public, anon, authenticated/i);
  assert.match(migration, /grant execute on function[\s\S]*to service_role/i);
});

test("activation is one common finalized boundary with Entries OFF and exactly three roots", () => {
  assert.match(migration, /p_activation_slot bigint[\s\S]*p_activation_blockhash text/i);
  assert.match(migration, /v_config\.enabled is not false[\s\S]*'entries_must_be_off'/i);
  assert.match(migration, /supply_accumulation_mode_enabled is not true/i);
  assert.match(migration, /custody_journey_enabled is not true/i);
  assert.match(migration, /cardinality\(v_config_roots\), 0\) <> 3/i);
  assert.match(
    migration,
    /root_wallets text\[\] not null check \(cardinality\(root_wallets\) = 3\)/i,
  );
  assert.match(migration, /'exclusive_slot'/i);
  assert.match(migration, /custody_fresh_tail_finalized_heads/i);
  assert.match(migration, /'finalized_head_conflict'/i);
  assert.match(migration, /creation_block_not_attested/i);
});

test("lease renewal requires the prior secret token and generation", () => {
  const start = migration.indexOf(
    "create or replace function public.acquire_custody_fresh_tail_lease(",
  );
  const next = migration.indexOf("create or replace function public.", start + 1);
  const acquire = migration.slice(start, next);
  assert.match(acquire, /p_expected_lease_token uuid default null/i);
  assert.match(acquire, /p_expected_lease_generation bigint default null/i);
  assert.match(acquire, /v_epoch\.lease_token is distinct from p_expected_lease_token/i);
  assert.match(acquire, /v_epoch\.lease_generation is distinct from p_expected_lease_generation/i);
  assert.match(acquire, /lease_busy_or_fenced/i);
  assert.doesNotMatch(
    acquire,
    /lease_owner = v_worker[\s\S]{0,300}v_token := v_epoch\.lease_token/i,
  );
});

test("restart discovery reads the active epoch without activation or lease secrets", () => {
  const start = migration.indexOf(
    "create or replace function public.get_custody_fresh_tail_active_epoch(",
  );
  const next = migration.indexOf("create or replace function public.", start + 1);
  const lookup = migration.slice(start, next);
  assert.match(lookup, /where user_id = p_user_id and status = 'active'/i);
  assert.match(lookup, /'activationSlot', v_epoch\.activation_slot/i);
  assert.match(lookup, /'rootWallets', v_epoch\.root_wallets/i);
  assert.match(lookup, /'leaseGeneration', v_epoch\.lease_generation/i);
  assert.doesNotMatch(lookup, /bot_config|entries_must_be_off/i);
  assert.doesNotMatch(lookup, /'leaseToken'|v_epoch\.lease_token/i);
  assert.doesNotMatch(lookup, /\b(?:insert|update|delete)\b/i);
});

test("mint enrollment is epoch-level, strict Pump creation proof with durable rejections", () => {
  const signature = migration.slice(
    migration.indexOf("create or replace function public.attest_custody_fresh_tail_mint_creation("),
    migration.indexOf(
      ")\nreturns jsonb",
      migration.indexOf("attest_custody_fresh_tail_mint_creation("),
    ),
  );
  assert.doesNotMatch(signature, /request_id/i);
  for (const proof of [
    "creation_tx_sig",
    "creation_slot",
    "creation_blockhash",
    "bonding_curve",
    "creator",
    "create_variant",
    "token_program",
    "mint_layout_fingerprint",
    "parser_abi_fingerprint",
    "total_supply_raw",
    "decimals",
  ]) {
    assert.match(migration, new RegExp(proof, "i"));
  }
  assert.match(migration, /classic_v1[\s\S]*create_v2_token2022/i);
  assert.match(migration, /ebe9ae1c8f38c24c3c6d4da1a3c9b90ffce4bf27e36f562bc67b090e9b7c343f/i);
  assert.match(migration, /TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA/i);
  assert.match(migration, /TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb/i);
  assert.match(migration, /p_creation_slot <= v_epoch\.activation_slot/i);
  assert.match(migration, /create table if not exists public\.custody_fresh_tail_mint_rejections/i);
  assert.match(migration, /proof_unavailable_budget_exhausted/i);
});

test("fresh supply authorization never depends on legacy aggregate rows", () => {
  assert.match(migration, /create table if not exists public\.custody_fresh_tail_supply_events/i);
  assert.match(migration, /record_custody_fresh_tail_supply_event/i);
  assert.doesNotMatch(migration, /from public\.supply_accumulation_(?:events|state)\b/i);
  assert.match(migration, /e\.slot > v_epoch\.activation_slot/i);
  assert.match(migration, /e\.target_wallet = any\(v_epoch\.root_wallets\)/i);
  assert.match(migration, /when e\.side = 'buy' then e\.amount_raw else -e\.amount_raw/i);
  assert.match(migration, /v_net_raw \* 100\) \/ v_mint\.total_supply_raw/i);
  assert.match(migration, /v_trigger\.amount_raw::text/i);
  assert.match(migration, /p_parser_domain text/i);
  assert.match(migration, /b8b6dbdcce44a2b61c55ba2fd74cd385fae489a95be291504eb8e7b15f88262d/i);
  assert.match(migration, /'parser_not_reviewed'/i);
});

test("fresh custody transfers are one canonical conserving recipient batch", () => {
  assert.match(migration, /p_recipients jsonb/i);
  assert.match(migration, /jsonb_array_length\(p_recipients\) not between 1 and 250/i);
  assert.match(migration, /count\(distinct btrim\(recipient->>'wallet'\)\)/i);
  assert.match(
    migration,
    /p_source_pre_raw - p_source_post_raw <> p_amount_raw[\s\S]*sum\(\(recipient->>'amountRaw'\)::numeric\)[\s\S]*<> p_amount_raw/i,
  );
  assert.match(
    migration,
    /\(recipient->>'postRaw'\)::numeric - \(recipient->>'preRaw'\)::numeric[\s\S]*<> \(recipient->>'amountRaw'\)::numeric/i,
  );
  assert.match(migration, /order by btrim\(recipient->>'wallet'\)/i);
  assert.match(migration, /'classification_pending'/i);
  assert.match(migration, /terminal_poison/i);
});

test("fixed-point scope uses inclusive descendants and never rewinds a main cursor", () => {
  assert.match(migration, /boundary_kind text not null default 'inclusive_slot'/i);
  assert.match(migration, /e\.applied_revision is null/i);
  assert.match(migration, /scope_revision = v_revision/i);
  assert.match(migration, /v_edge\.discovery_slot < v_wallet\.discovery_slot/i);
  assert.match(migration, /custody_fresh_tail_backscan_ranges/i);
  const retrograde = migration.slice(
    migration.indexOf("elsif v_edge.discovery_slot < v_wallet.discovery_slot"),
    migration.indexOf("end if;", migration.indexOf("elsif v_edge.discovery_slot")),
  );
  assert.doesNotMatch(retrograde, /update public\.custody_fresh_tail_cursors/i);
  assert.match(migration, /applied_revision = v_revision/i);
});

test("cursor proof is exact-signature CAS, fenced, and proves the history floor", () => {
  assert.match(migration, /last_processed_signature is distinct from v_expected/i);
  assert.match(migration, /'exact_signature_required'/i);
  assert.match(migration, /current_boundary_kind = 'exact_signature'/i);
  assert.match(migration, /p_first_available_block <= v_cursor\.floor_slot/i);
  assert.match(migration, /p_first_available_block <= v_range\.floor_slot/i);
  assert.match(migration, /lease_generation is distinct from p_lease_generation/i);
  assert.match(migration, /lease_expires_at <= clock_timestamp\(\)/i);
  assert.match(migration, /custody_fresh_tail_coverage_attestations/i);
  assert.match(migration, /a\.lease_generation = p_lease_generation/i);
  assert.doesNotMatch(migration, /where r\.epoch_id = p_epoch_id and r\.completed_at is null/i);
});

test("requests are immutable identities, expire from finalized trigger time, and can recur", () => {
  assert.match(migration, /expires_at = trigger_block_time \+ interval '55 seconds'/i);
  assert.match(migration, /unique \(epoch_id, trigger_event_key\)/i);
  assert.match(migration, /where status in \('pending', 'settled'\)/i);
  assert.match(migration, /status = 'expired'/i);
  assert.match(migration, /requested_head_block_time/i);
  assert.match(migration, /p_finalized_head_slot < p_trigger_slot/i);
  assert.match(migration, /settled_at < clock_timestamp\(\) - interval '4 seconds'/i);
  assert.match(migration, /settled_lease_generation/i);
  assert.match(migration, /'settlement_lease_fenced'/i);
  assert.match(migration, /head_curve_observed_slot = requested_head_slot/i);
  assert.match(
    migration,
    /head_curve_complete boolean not null check \(not head_curve_complete\)/i,
  );
  assert.match(
    migration,
    /head_snapshot_parser_abi_fingerprint[\s\S]*2f5de97b6527d4ec94082069d65abd2bf30523e45bf562aabe1e770e5eb4ad1d/i,
  );
  assert.match(migration, /'headSnapshotParserAbiFingerprint'/i);
  assert.match(migration, /head_curve_state_fingerprint/i);
  assert.match(migration, /head_virtual_token_reserves_raw/i);
  assert.match(migration, /head_real_sol_reserves_lamports/i);
  assert.match(migration, /head_mint_layout_fingerprint <> v_mint\.mint_layout_fingerprint/i);
});

test("settle and final gate require all roots, descendants, backscans, and no poison", () => {
  assert.match(migration, /'root_coverage_incomplete'/i);
  assert.match(migration, /'descendant_coverage_incomplete'/i);
  assert.match(migration, /'backscan_coverage_incomplete'/i);
  assert.match(migration, /'scope_not_fixed_point'/i);
  assert.match(migration, /'fresh_target_buy_missing'/i);
  assert.match(migration, /'fresh_sell_or_poison_seen'/i);
  assert.match(migration, /p\.status in \('expired', 'terminal'\)/i);
  assert.doesNotMatch(migration, /p\.status <> 'applied'/i);
  assert.match(migration, /'preexisting_legacy_journey'/i);
  assert.match(migration, /p_claim_id is not null[\s\S]*'claim_not_bound'/i);
  assert.match(migration, /fresh_tail_epoch_id = p_epoch_id/i);
  assert.match(migration, /fresh_tail_request_id = p_request_id/i);
  const finalGate = migration.slice(
    migration.indexOf(
      "create or replace function public.check_supply_accumulation_fresh_custody_gate(",
    ),
    migration.indexOf("create or replace function public.get_custody_fresh_tail_entry_candidates("),
  );
  assert.match(finalGate, /p_claim_id is not null[\s\S]*c\.status = 'submitted'/i);
  assert.match(finalGate, /nullif\(btrim\(coalesce\(c\.bot_tx_sig, ''\)\), ''\) is not null/i);
  assert.match(finalGate, /c\.submission_started_at is not null/i);
  assert.match(finalGate, /c\.last_valid_block_height > 0/i);
  assert.match(finalGate, /c\.fresh_tail_monitoring_armed_at <= c\.submission_started_at/i);
  assert.doesNotMatch(finalGate, /p_claim_id is not null[\s\S]{0,1000}c\.status = 'claimed'/i);
  assert.match(
    finalGate,
    /custody_fresh_tail_worker_heartbeat[\s\S]*lease_token is distinct from v_epoch\.lease_token[\s\S]*shadow is not false[\s\S]*last_success_at < clock_timestamp\(\) - interval '4 seconds'[\s\S]*root_covered_count <> 3[\s\S]*root_backlog_count <> 0/i,
  );
  assert.match(finalGate, /v_config\.enabled is not true/i);
  assert.match(
    migration,
    /drop policy if exists "read own fresh tail rows"[\s\S]*custody_fresh_tail_worker_heartbeat[\s\S]*revoke all on table public\.custody_fresh_tail_worker_heartbeat[\s\S]*from authenticated/i,
  );
});

test("post-entry exits are permanent exact-once evidence, not SQL money movement", () => {
  assert.match(migration, /create table if not exists public\.custody_fresh_tail_exit_intents/i);
  assert.match(
    migration,
    /add constraint custody_fresh_tail_exit_intents_disposition_check[\s\S]*not valid;[\s\S]*validate constraint custody_fresh_tail_exit_intents_disposition_check;/i,
  );
  assert.match(migration, /custody_fresh_tail_exit_supply_once_idx/i);
  assert.match(migration, /custody_fresh_tail_exit_custody_once_idx/i);
  assert.match(migration, /for update skip locked/i);
  assert.match(migration, /claim_generation = i\.claim_generation \+ 1/i);
  assert.match(
    migration,
    /i\.status = 'retry'[\s\S]*i\.updated_at <= clock_timestamp\(\) - interval '1 second'/i,
  );
  assert.match(
    migration,
    /order by case when i\.status = 'pending' then 0 else 1 end, i\.created_at, i\.id/i,
  );
  assert.match(migration, /disabled_by_policy/i);
  assert.match(migration, /position_not_live/i);
  assert.match(
    migration,
    /when v_disposition in \([\s\S]*'retry'[\s\S]*'position_not_live'[\s\S]*'duplicate_sell_claim'[\s\S]*\) then 'retry'/i,
  );
  assert.match(
    migration,
    /when v_disposition in \([\s\S]*'disabled_by_policy'[\s\S]*'entry_failed'[\s\S]*'position_closed'[\s\S]*\) then 'dismissed'/i,
  );
  const resolver = migration.slice(
    migration.indexOf("create or replace function public.resolve_custody_fresh_tail_exit_intent("),
    migration.indexOf(
      "create or replace function public.check_supply_accumulation_fresh_custody_gate(",
    ),
  );
  assert.match(resolver, /then 'dismissed'/i);
  assert.match(migration, /claim_custody_fresh_tail_uncertain_intents/i);
  assert.equal(
    migration.match(/p_claim_seconds integer default 180/gi)?.length,
    2,
    "both exit claim APIs require the long recovery lease",
  );
  assert.equal(migration.match(/p_claim_seconds not between 180 and 600/gi)?.length, 2);
  assert.equal(
    migration.match(
      /'classificationReliable', coalesce\(se\.classification_reliable, ce\.classification_reliable\),[\s\S]{0,100}'watchable', ce\.watchable/gi,
    )?.length,
    2,
    "normal and uncertain claim payloads must satisfy the same strict parser",
  );
  assert.match(migration, /v_expected not in \('claimed', 'uncertain'\)/i);
  assert.match(migration, /'pre_submit_uncertain_required'/i);
  assert.match(
    migration,
    /v_disposition in \('uncertain', 'resolved'\)[\s\S]*v_expected = 'uncertain' and v_disposition = 'retry'[\s\S]*p_sell_claim_id is null[\s\S]*p_bot_tx_sig[\s\S]*'prepared_sell_evidence_required'/i,
  );
  assert.match(
    migration,
    /status <> 'uncertain'[\s\S]*sell_claim_id is not null[\s\S]*bot_tx_sig/i,
  );
  assert.match(
    resolver,
    /v_expected = 'uncertain' and v_disposition = 'resolved'[\s\S]*p_sell_claim_id is distinct from v_intent\.sell_claim_id[\s\S]*p_bot_tx_sig[\s\S]*is distinct from v_intent\.bot_tx_sig/i,
  );
  assert.match(resolver, /'resolution_evidence_mismatch'/i);
  assert.match(
    resolver,
    /from public\.custody_fresh_tail_roots r[\s\S]*r\.epoch_id = v_intent\.epoch_id[\s\S]*r\.wallet = v_source_wallet/i,
  );
  assert.match(
    resolver,
    /v_sell_claim\.position_id <> v_intent\.position_id[\s\S]*v_sell_claim\.source_tx_sig <> v_source_tx_sig[\s\S]*v_sell_claim\.source_wallet <> v_source_wallet[\s\S]*v_sell_claim\.trigger_kind <> v_expected_trigger[\s\S]*v_sell_claim\.bot_tx_sig is distinct from btrim\(p_bot_tx_sig\)/i,
  );
  assert.match(
    resolver,
    /v_sell_claim\.recovery_version is distinct from 1[\s\S]*v_sell_claim\.recent_blockhash[\s\S]*v_sell_claim\.last_valid_block_height <= 0[\s\S]*v_sell_claim\.executed_sell_amount_raw is null[\s\S]*v_sell_claim\.prepared_wallet_balance_raw is null[\s\S]*v_sell_claim\.position_amount_before_raw is null[\s\S]*v_sell_claim\.token_decimals is null/i,
  );
  assert.match(
    resolver,
    /v_disposition = 'resolved'[\s\S]*v_sell_claim\.status <> 'landed'[\s\S]*v_sell_claim\.trade_id is null[\s\S]*v_sell_claim\.persisted_at is null[\s\S]*v_sell_claim\.receipt_pre_amount_raw is null[\s\S]*v_sell_claim\.receipt_post_amount_raw is null/i,
  );
  assert.match(resolver, /v_disposition = 'entry_failed'[\s\S]*status <> 'failed_pre_submit'/i);
  assert.match(
    resolver,
    /v_disposition = 'position_closed'[\s\S]*closed_at is null[\s\S]*amount_remaining_raw[\s\S]*<> '0'/i,
  );
  assert.match(
    resolver,
    /v_disposition = 'disabled_by_policy'[\s\S]*to_jsonb\(v_config\)[\s\S]*mirror_custody_sell_exit_enabled/i,
  );
  assert.match(
    resolver,
    /when v_expected = 'uncertain' and v_disposition = 'resolved'[\s\S]*then sell_claim_id else p_sell_claim_id end/i,
  );
  assert.match(
    resolver,
    /when v_expected = 'uncertain' and v_disposition = 'resolved'[\s\S]*then bot_tx_sig else nullif/i,
  );
  assert.match(migration, /when v_status = 'uncertain' then claim_token/i);
  assert.equal(
    migration.match(/direct_target_sell_exit_mode = 'proportional'/gi)?.length,
    3,
    "proportional exits must block activation, coverage, and final candidates",
  );
  assert.match(migration, /'proportional_exit_proof_unavailable'/i);
  const supplyWriter = migration.slice(
    migration.indexOf("create or replace function public.record_custody_fresh_tail_supply_event("),
    migration.indexOf("create or replace function public.record_custody_fresh_tail_custody_event("),
  );
  const custodyWriter = migration.slice(
    migration.indexOf("create or replace function public.record_custody_fresh_tail_custody_event("),
    migration.indexOf("create or replace function public.sync_custody_fresh_tail_scope("),
  );
  assert.match(
    supplyWriter,
    /payload_fingerprint <> v_fingerprint[\s\S]*insert into public\.custody_fresh_tail_exit_intents[\s\S]*'supply', v_existing\.id, 'terminal_outflow'[\s\S]*'payload_conflict'/i,
  );
  assert.match(
    supplyWriter,
    /poisoned = true, poison_reason = 'supply_payload_conflict'[\s\S]*'durableConflict', true, 'terminalPoison', true/i,
  );
  assert.match(
    custodyWriter,
    /payload_fingerprint <> v_fingerprint[\s\S]*insert into public\.custody_fresh_tail_exit_intents[\s\S]*'custody', v_existing\.id, 'terminal_outflow'[\s\S]*'payload_conflict'/i,
  );
  assert.match(
    custodyWriter,
    /poisoned = true, poison_reason = 'custody_payload_conflict'[\s\S]*'durableConflict', true, 'terminalPoison', true/i,
  );
  assert.doesNotMatch(migration, /insert into public\.sell_signal_claims/i);
  assert.doesNotMatch(migration, /insert into public\.trades/i);
  assert.doesNotMatch(migration, /update public\.positions/i);
});

test("fresh entry landing stores one exact raw receipt with idempotent replay", () => {
  assert.match(migration, /add column if not exists received_amount_raw text/i);
  assert.match(migration, /add column if not exists received_token_decimals integer/i);
  assert.match(
    migration,
    /fresh_tail_request_id is null[\s\S]*status in \('landed', 'persisted'\)[\s\S]*received_amount_raw is not null[\s\S]*received_token_decimals = token_decimals/i,
  );
  const start = migration.indexOf(
    "create or replace function public.record_supply_entry_claim_fresh_tail_receipt(",
  );
  const next = migration.indexOf("create or replace function public.", start + 1);
  const receipt = migration.slice(start, next);
  assert.match(receipt, /p_received_amount_raw text/i);
  assert.match(receipt, /p_received_token_decimals integer/i);
  assert.match(receipt, /p_received_amount_raw !~ '\^\[1-9\]\[0-9\]\*\$'/i);
  assert.match(receipt, /v_claim\.bot_tx_sig is distinct from v_signature/i);
  assert.match(receipt, /v_claim\.fresh_tail_epoch_id is distinct from p_epoch_id/i);
  assert.match(receipt, /v_claim\.fresh_tail_request_id is distinct from p_request_id/i);
  assert.match(receipt, /v_claim\.status in \('landed', 'persisted'\)/i);
  assert.match(receipt, /'replay', true[\s\S]*'entry_receipt_already_recorded'/i);
  assert.match(receipt, /v_claim\.status not in \('submitted', 'uncertain'\)/i);
  assert.match(
    receipt,
    /update public\.entry_signal_claims set[\s\S]*status = 'landed'[\s\S]*received_amount_raw = p_received_amount_raw[\s\S]*received_token_decimals = p_received_token_decimals/i,
  );
  assert.match(receipt, /and status in \('submitted', 'uncertain'\)/i);
  assert.doesNotMatch(receipt, /insert into public\.(?:positions|trades)/i);
  assert.match(types, /received_amount_raw: string \| null/i);
  assert.match(types, /received_token_decimals: number \| null/i);
  assert.match(doctor, /received_amount_raw,received_token_decimals/i);
  assert.match(doctor, /\/rpc\/record_supply_entry_claim_fresh_tail_receipt/i);
});

test("RLS, grants, Doctor, and TypeScript mirrors cover the new contract", () => {
  assert.match(migration, /using \(auth\.uid\(\) = user_id\)/i);
  assert.match(migration, /grant select on table public\.%I to authenticated/i);
  for (const table of tables) {
    assert.match(doctor, new RegExp(`\\.from\\("${table}"\\)`));
    assert.match(types, new RegExp(`${table}: \\{`));
  }
  for (const rpc of rpcs) {
    assert.match(doctor, new RegExp(`/rpc/${rpc}`));
  }
});

test("all declared identifiers fit PostgreSQL and hashes use qualified SHA-256", () => {
  const identifiers = migration.matchAll(
    /(?:table|index|constraint|function)\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi,
  );
  for (const match of identifiers) {
    assert.ok(match[1].length <= 63, `${match[1]} exceeds PostgreSQL's identifier limit`);
  }
  assert.doesNotMatch(migration, /\bmd5\s*\(/i);
  assert.match(migration, /extensions\.digest\(/i);
  assert.match(migration, /'sha256'/i);
});

test("canonical schema embeds the fresh-tail migration byte-for-byte", () => {
  const begin = "-- SUPPLY_ACCUMULATION_FRESH_TAIL_CANONICAL_MIRROR_BEGIN";
  const end = "-- SUPPLY_ACCUMULATION_FRESH_TAIL_CANONICAL_MIRROR_END";
  const beginAt = schema.indexOf(begin);
  const endAt = schema.indexOf(end);
  assert.ok(beginAt >= 0, "canonical mirror begin marker is missing");
  assert.ok(endAt > beginAt, "canonical mirror end marker is missing");
  assert.equal(schema.slice(beginAt + begin.length, endAt).trim(), migration.trim());
});
