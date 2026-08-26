import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const migration = readFileSync(root("supabase/supply-accumulation-entry-migration.sql"), "utf8");
const schema = readFileSync(root("supabase/schema.sql"), "utf8");
const botConfig = readFileSync(root("src/lib/bot-config.ts"), "utf8");
const botSchemas = readFileSync(root("src/lib/bot.schemas.ts"), "utf8");
const botServer = readFileSync(root("src/lib/bot.server.ts"), "utf8");
const appTypes = readFileSync(root("src/lib/supabase-types.ts"), "utf8");
const workerDb = readFileSync(root("worker/src/db.ts"), "utf8");
const doctor = readFileSync(root("worker/src/doctor.ts"), "utf8");
const supplySettings = readFileSync(
  root("src/components/dashboard/SupplyAccumulationSettingsCard.tsx"),
  "utf8",
);
const settingsPanel = readFileSync(root("src/components/dashboard/SettingsPanel.tsx"), "utf8");

test("Supply Accumulation migration is additive and defaults safely OFF", () => {
  assert.doesNotMatch(migration, /\bdelete\s+from\b/i);
  assert.doesNotMatch(migration, /\btruncate\b/i);
  assert.doesNotMatch(migration, /\bdrop\s+(table|column|schema)\b/i);
  assert.match(
    migration,
    /add column if not exists supply_accumulation_mode_enabled boolean not null default false/i,
  );
  assert.match(migration, /supply_accumulation_threshold_pct numeric not null default 10/i);
  assert.match(migration, /supply_accumulation_buy_usd numeric not null default 20/i);
  assert.match(migration, /supply_accumulation_max_market_cap_usd numeric not null default 15000/i);
  assert.match(migration, /supply_accumulation_window_seconds integer not null default 600/i);
  assert.match(migration, /supply_accumulation_threshold_pct between 10 and 20/i);
  assert.match(migration, /supply_accumulation_max_market_cap_usd <= 15000/i);
  assert.match(migration, /supply_accumulation_window_seconds between 30 and 3600/i);
  assert.match(migration, /not supply_accumulation_mode_enabled or custody_journey_enabled/i);
  assert.match(migration, /coalesce\(cardinality\(additional_target_wallets\), 0\) > 0/i);
  assert.doesNotMatch(migration, /supply_accumulation_mode_enabled\s*=\s*true/i);
});

test("raw event storage and rolling state are exact and replay-safe", () => {
  assert.match(migration, /create table if not exists public\.supply_accumulation_events/i);
  assert.match(migration, /create table if not exists public\.supply_accumulation_state/i);
  assert.match(migration, /amount_raw numeric\(78, 0\)/i);
  assert.match(migration, /total_supply_raw numeric\(78, 0\)/i);
  assert.match(migration, /decimals integer not null check \(decimals between 0 and 18\)/i);
  assert.match(migration, /unique \(user_id, event_key\)/i);
  assert.match(migration, /pg_advisory_xact_lock/i);
  assert.match(migration, /v_gross_buy_raw - v_gross_sell_raw/i);
  assert.match(migration, /make_interval\(secs => v_window_seconds\)/i);
  assert.match(migration, /v_latest_market_cap_usd < v_max_market_cap_usd/i);
  assert.match(migration, /v_net_supply_bps \/ 100\) >= v_threshold_pct/i);
  assert.match(migration, /v_target = any/i);
  assert.match(
    migration,
    /e\.total_supply_raw <> v_total_supply_raw[\s\S]*e\.decimals <> p_decimals/i,
  );
  assert.match(migration, /'supply_or_decimals_mismatch'/i);
  assert.match(migration, /direct_settlement_seen boolean not null default false/i);
  assert.match(
    migration,
    /exists\(select 1 from usable where metadata @> '\{"grossForwarded": true\}'::jsonb\)/i,
  );
});

test("state follows chain slot order and fails closed on an unordered same-slot sell", () => {
  assert.match(migration, /select max\(slot\)\s+into v_last_event_slot/i);
  assert.match(
    migration,
    /e\.slot = v_last_event_slot[\s\S]*e\.side = 'sell'[\s\S]*into v_max_slot_has_sell/i,
  );
  assert.match(
    migration,
    /v_last_event_side := case when v_max_slot_has_sell then 'sell' else 'buy' end/i,
  );
  assert.match(
    migration,
    /order by valuation_slot desc nulls last, slot desc, event_at desc, id desc/i,
  );
  assert.doesNotMatch(migration, /order by event_at desc, slot desc/i);
});

test("duplicate payload conflicts quarantine evidence and exact replays may enrich valuation", () => {
  assert.match(
    migration,
    /request_fingerprint text not null check \(char_length\(request_fingerprint\) = 64\)/i,
  );
  assert.match(migration, /encode\(extensions\.digest\([\s\S]*'sha256'\), 'hex'\)/i);
  const fingerprint =
    migration.match(/v_fingerprint := encode\(extensions\.digest\(([\s\S]*?)\), 'hex'\);/i)?.[1] ??
    "";
  assert.doesNotMatch(fingerprint, /market_cap|valuation_slot|metadata/i);
  assert.match(migration, /request_fingerprint <> v_fingerprint[\s\S]*quarantined = true/i);
  assert.match(migration, /conflict_count = conflict_count \+ 1/i);
  assert.match(migration, /'reason', 'payload_mismatch'/i);
  assert.match(
    migration,
    /'reason', case when v_enriched then 'duplicate_enriched' else 'duplicate' end/i,
  );
  assert.match(migration, /market_data_reliable = market_data_reliable or v_enriched/i);
  assert.match(
    migration,
    /when metadata @> '\{"grossForwarded": true\}'::jsonb\s+or p_metadata @> '\{"grossForwarded": true\}'::jsonb\s+then metadata \|\| p_metadata \|\| '\{"grossForwarded": true\}'::jsonb/i,
  );
});

test("RPCs and tables are private-write, own-row read, and return strict state", () => {
  for (const table of ["supply_accumulation_events", "supply_accumulation_state"]) {
    assert.match(
      migration,
      new RegExp(`alter table public\\.${table} enable row level security`, "i"),
    );
    assert.match(
      migration,
      new RegExp(`grant select on table public\\.${table} to authenticated`, "i"),
    );
  }
  assert.match(
    migration,
    /revoke all on function public\.record_supply_accumulation_event\([\s\S]*from public, anon, authenticated/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.record_supply_accumulation_event\([\s\S]*to service_role/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.get_supply_accumulation_state\([\s\S]*to service_role/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.check_supply_accumulation_custody_gate\([\s\S]*to service_role/i,
  );
  assert.match(
    migration,
    /revoke all on function public\.check_supply_accumulation_custody_gate\([\s\S]*from public, anon, authenticated/i,
  );
  assert.equal(
    migration.match(/security definer\s+set search_path = pg_catalog, public, pg_temp/gi)?.length,
    3,
  );
  assert.equal(migration.match(/coalesce\(auth\.role\(\), ''\) <> 'service_role'/gi)?.length, 3);
  assert.match(migration, /errcode = '42501'/i);
  for (const key of [
    "netSupplyPct",
    "thresholdReached",
    "underMarketCap",
    "directSettlementSeen",
    "payloadConflict",
    "dataReliable",
    "entryReady",
  ]) {
    assert.match(migration, new RegExp(`'${key}'`));
  }
});

test("custody gate is one service-only fail-closed database snapshot", () => {
  assert.match(
    migration,
    /create or replace function public\.check_supply_accumulation_custody_gate\(\s*p_user_id uuid,\s*p_token_mint text,\s*p_window_started_at timestamptz,\s*p_trigger_tx_sig text,\s*p_trigger_slot bigint,\s*p_target_wallet text\s*\)/i,
  );
  assert.match(migration, /with config as materialized[\s\S]*heartbeat as materialized/i);
  assert.match(migration, /updated_at >= now\(\) - interval '60 seconds'/i);
  assert.match(migration, /rpc_last_success_at >= now\(\) - interval '60 seconds'/i);
  assert.match(migration, /rpc_backlog_wallet_count = 0/i);
  assert.match(
    migration,
    /e\.event_type = 'VERIFIED_TARGET_BUY'[\s\S]*e\.tx_sig = v_tx_sig[\s\S]*e\.slot = p_trigger_slot[\s\S]*e\.source_wallet = v_target[\s\S]*e\.evidence_reliable/i,
  );
  assert.match(
    migration,
    /e\.event_type = 'VERIFIED_CUSTODY_SELL'[\s\S]*e\.evidence_reliable[\s\S]*e\.applied_amount_tokens > 0/i,
  );
  assert.match(migration, /total_unresolved_outflow_tokens > 0/i);
  assert.match(migration, /p\.status <> 'applied'/i);
  assert.match(migration, /w\.watch_status = 'active'[\s\S]*w\.current_attributed_tokens > 0/i);
  assert.match(migration, /'safe', v_reason = 'custody_safe'[\s\S]*'reason', v_reason/i);
  assert.doesNotMatch(migration, /check_supply_accumulation_custody_gate[\s\S]*limit 1000/i);
});

test("the standard-position sell claim constraint covers every worker exit", () => {
  for (const kind of [
    "direct_target_sell",
    "terminal_outflow",
    "target_terminal_outflow",
    "take_profit",
    "stop_loss",
    "target_inactivity",
    "distinct_follower",
    "proportional_follower",
    "crew_wallet",
    "trailing_stop",
    "mirror_custody_sell",
  ]) {
    assert.match(migration, new RegExp(`'${kind}'`));
  }
  assert.match(migration, /drop constraint if exists sell_signal_claims_trigger_kind_check/i);
  assert.match(migration, /add constraint sell_signal_claims_trigger_kind_check check/i);
  assert.doesNotMatch(migration, /alter table public\.positions/i);
});

test("entry claim recovery metadata is nullable, bounded, and never backfilled", () => {
  for (const [field, type] of [
    ["entry_strategy", "text"],
    ["source_slot", "bigint"],
    ["token_decimals", "integer"],
    ["contributing_wallets", "text\\[\\]"],
    ["planned_buy_usd", "numeric"],
    ["last_valid_block_height", "bigint"],
  ]) {
    assert.match(migration, new RegExp(`add column if not exists ${field} ${type}[,;]`, "i"));
  }
  assert.match(
    migration,
    /entry_strategy is null\s+or entry_strategy in \('supply_accumulation', 'regular', 'coordinated', 'conviction'\)/i,
  );
  assert.match(migration, /token_decimals is null or token_decimals between 0 and 18/i);
  assert.match(migration, /planned_buy_usd is null or planned_buy_usd > 0/i);
  assert.doesNotMatch(migration, /entry_strategy text not null/i);
  assert.doesNotMatch(migration, /token_decimals integer not null/i);
  assert.doesNotMatch(migration, /planned_buy_usd numeric not null/i);
  assert.doesNotMatch(migration, /update\s+public\.entry_signal_claims/i);
  assert.doesNotMatch(
    migration,
    /alter table public\.entry_signal_claims[\s\S]*alter column entry_mode/i,
  );
});

test("canonical schema embeds the Supply Accumulation migration byte-for-byte", () => {
  const begin = "-- SUPPLY_ACCUMULATION_CANONICAL_MIRROR_BEGIN";
  const end = "-- SUPPLY_ACCUMULATION_CANONICAL_MIRROR_END";
  const beginIndex = schema.indexOf(begin);
  const endIndex = schema.indexOf(end);
  assert.ok(beginIndex >= 0, "canonical mirror begin marker is missing");
  assert.ok(endIndex > beginIndex, "canonical mirror end marker is missing");
  const embedded = schema.slice(beginIndex + begin.length, endIndex).trim();
  assert.equal(embedded, migration.trim());
});

test("config round-trips through app, server, worker, and Doctor", () => {
  for (const field of [
    "supplyAccumulationModeEnabled",
    "supplyAccumulationThresholdPct",
    "supplyAccumulationBuyUsd",
    "supplyAccumulationMaxMarketCapUsd",
    "supplyAccumulationWindowSeconds",
  ]) {
    assert.match(botConfig, new RegExp(`${field}:`));
    assert.match(botSchemas, new RegExp(`${field}:`));
  }
  for (const field of [
    "supply_accumulation_mode_enabled",
    "supply_accumulation_threshold_pct",
    "supply_accumulation_buy_usd",
    "supply_accumulation_max_market_cap_usd",
    "supply_accumulation_window_seconds",
  ]) {
    assert.match(appTypes, new RegExp(field));
    assert.match(workerDb, new RegExp(field));
    assert.match(botServer, new RegExp(field));
    assert.match(doctor, new RegExp(field));
  }
  assert.match(doctor, /record_supply_accumulation_event/);
  assert.match(doctor, /get_supply_accumulation_state/);
  assert.match(doctor, /check_supply_accumulation_custody_gate/);
  assert.match(doctor, /direct_settlement_seen/);
  for (const field of [
    "entry_strategy",
    "source_slot",
    "token_decimals",
    "contributing_wallets",
    "planned_buy_usd",
    "last_valid_block_height",
  ]) {
    assert.match(doctor, new RegExp(field));
  }
  assert.match(doctor, /standard position exits preserved/);
});

test("settings require and disclose the atomic custody gate", () => {
  assert.match(supplySettings, /Custody Journey must be ON for every Supply Accumulation entry/);
  assert.match(supplySettings, /exact target buy/);
  assert.match(supplySettings, /positive live attribution/);
  assert.match(supplySettings, /verified[\s\S]*descendant sell/);
  assert.match(supplySettings, /unresolved outflow/);
  assert.match(supplySettings, /degraded observer/);
  assert.match(supplySettings, /stale proof/);
  assert.match(supplySettings, /targetCount === 0 \|\| !cfg\.custodyJourneyEnabled/);
  assert.match(settingsPanel, /disabled=\{cfg\.supplyAccumulationModeEnabled\}/);
});
