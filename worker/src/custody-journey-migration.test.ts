import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const sql = readFileSync(root("supabase/custody-journey-migration.sql"), "utf8");
const schema = readFileSync(root("supabase/schema.sql"), "utf8");
const dbSource = readFileSync(root("worker/src/db.ts"), "utf8");
const doctorSource = readFileSync(root("worker/src/doctor.ts"), "utf8");
const dashboardTypes = readFileSync(root("src/lib/supabase-types.ts"), "utf8");
const dashboardConfig = readFileSync(root("src/lib/bot-config.ts"), "utf8");
const dashboardSchema = readFileSync(root("src/lib/bot.schemas.ts"), "utf8");
const dashboardServer = readFileSync(root("src/lib/bot.server.ts"), "utf8");
const settingsPanel = readFileSync(root("src/components/dashboard/SettingsPanel.tsx"), "utf8");
const dashboardRoute = readFileSync(root("src/routes/index.tsx"), "utf8");
const custodyDoctorSource = doctorSource.slice(
  doctorSource.indexOf("async function checkCustodyJourneySchema"),
  doctorSource.indexOf("async function checkSellCoverageSchema"),
);

test("Custody Journey migration is additive and defaults observation OFF", () => {
  assert.doesNotMatch(sql, /\bdelete\s+from\b/i);
  assert.doesNotMatch(sql, /\btruncate\b/i);
  assert.doesNotMatch(sql, /\bdrop\s+(table|column|schema|function|policy)\b/i);
  assert.match(
    sql,
    /add column if not exists custody_journey_enabled boolean not null default false/i,
  );
  assert.doesNotMatch(sql, /\b(enabled|custody_journey_enabled)\s*=\s*true\b/i);
  assert.doesNotMatch(
    sql,
    /(?:alter|insert\s+into|update)\s+(?:table\s+)?public\.(?:positions|entry_signal_claims|sell_signal_claims)\b/i,
  );
});

test("Custody schema, health, and replay inbox contracts are complete", () => {
  for (const table of [
    "custody_journeys",
    "custody_journey_wallets",
    "custody_journey_events",
    "custody_wallet_profiles",
    "custody_rpc_wallet_cursors",
    "custody_worker_heartbeat",
    "custody_pending_events",
  ]) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}`, "i"));
  }
  assert.match(sql, /status in \('pending', 'applied', 'expired', 'terminal'\)/i);
  assert.match(sql, /retry_count integer not null default 0/i);
  assert.match(sql, /next_retry_at timestamptz not null default now\(\)/i);
  assert.match(sql, /expires_at timestamptz not null default \(now\(\) \+ interval '24 hours'\)/i);
  assert.match(
    sql,
    /create unique index if not exists custody_journeys_one_active_mint_idx[\s\S]*where status = 'active'/i,
  );
  assert.match(sql, /decoded_event_count bigint not null default 0/i);
  assert.match(sql, /rpc_backlog_wallet_count integer not null default 0/i);
  assert.match(sql, /degraded boolean not null default false/i);
});

test("Custody RPCs are service-only, replay-safe, and bounded", () => {
  for (const fn of [
    "record_custody_target_buy",
    "record_custody_transfer",
    "record_verified_custody_sell",
    "record_custody_unresolved_outflow",
    "replay_custody_pending_events",
  ]) {
    assert.match(sql, new RegExp(`create or replace function public\\.${fn}`, "i"));
    assert.match(sql, new RegExp(`revoke all on function public\\.${fn}`, "i"));
    assert.match(
      sql,
      new RegExp(`grant execute on function public\\.${fn}[\\s\\S]*?to service_role`, "i"),
    );
  }
  assert.match(sql, /security definer[\s\S]*set search_path = pg_catalog, public/i);
  assert.match(sql, /pg_advisory_xact_lock\(hashtext\(p_user_id::text\), hashtext\(v_mint\)\)/i);
  assert.match(sql, /request_fingerprint <> v_fingerprint/i);
  assert.match(sql, /'payloadMismatch'/i);
  assert.equal(
    (sql.match(/result_reason = 'payload_mismatch'/gi) ?? []).length,
    4,
    "all four record RPCs must durably mark duplicate payload conflicts",
  );
  assert.equal(
    (sql.match(/'payloadConflictObserved', true/gi) ?? []).length,
    4,
    "payload conflict audit markers must be present without storing the conflicting payload",
  );
  assert.equal((sql.match(/'payloadConflictObservedAt', now\(\)/gi) ?? []).length, 4);
  assert.match(sql, /v_effective_hop > 8/i);
  assert.match(sql, /v_active_wallet_count >= 250/i);
  assert.match(sql, /'hop_limit'/i);
  assert.match(sql, /'wallet_limit'/i);
  assert.match(sql, /for update skip locked/i);
  assert.doesNotMatch(sql, /retry_count\s*(?:\+\s*1\s*)?>=\s*32/i);
  assert.match(sql, /next_retry_at <= now\(\)/i);
  assert.match(sql, /make_interval\([\s\S]*least\(300/i);
  assert.match(sql, /target_wallet = v_(?:source_wallet|seller)/i);
  assert.match(sql, /additional_target_wallets/i);
  assert.equal(
    (sql.match(/'reason', 'staged_unscoped'/gi) ?? []).length,
    3,
    "transfer, sell, and unresolved outflow must durably stage new-mint wallet activity",
  );
  assert.equal(
    (sql.match(/v_pending_payload, 'pending', 'unscoped'/gi) ?? []).length,
    3,
  );
  assert.match(
    sql,
    /source_wallet = v_target[\s\S]*last_error_code = 'unscoped'[\s\S]*slot >= p_slot/i,
  );
  assert.match(
    sql,
    /last_error_code = 'unscoped'[\s\S]*source_wallet in \([\s\S]*jsonb_array_elements\(v_result_recipients\)/i,
  );
  assert.match(sql, /watch_anchor_slot bigint/i);
  assert.match(sql, /least\(existing_wallet\.watch_anchor_slot, excluded\.watch_anchor_slot\)/i);
  assert.equal(
    (sql.match(/and \(\s*p_slot < v_(?:seller_state|source)\.last_slot/gi) ?? []).length,
    2,
    "both custody sell and transfer must reject observations older than attributed state",
  );
  assert.equal(
    (
      sql.match(
        /p_slot = v_(?:seller_state|source)\.last_slot[\s\S]{0,120}v_tx_sig <> v_(?:seller_state|source)\.last_tx_sig/gi,
      ) ?? []
    ).length,
    2,
    "both custody sell and transfer must reject ambiguous different-tx events in the same slot",
  );
  assert.match(
    sql,
    /when p_slot < v_(?:seller_state|source)\.last_slot then 'predates_attribution_state'[\s\S]*else 'same_slot_order_unknown'/i,
  );
  assert.match(
    sql,
    /payload, status, last_error_code, journey_id, result[\s\S]*'terminal', v_terminal_reason/i,
  );
  assert.match(
    sql,
    /v_result->>'reason' in \([\s\S]*'predates_attribution_state'[\s\S]*'same_slot_order_unknown'[\s\S]*\) then/i,
  );
  assert.match(
    sql,
    /p_slot < v_existing_wallet\.last_slot[\s\S]*v_tx_sig <> v_existing_wallet\.last_tx_sig[\s\S]*partial_stale_target_buy[\s\S]*partial_same_slot_target_buy_order_unknown/i,
  );
  assert.match(
    sql,
    /partial_stale_target_buy[\s\S]*applied_amount_tokens, reconciled_amount_tokens, evidence_reliable[\s\S]*0, 0, false/i,
  );
  assert.match(
    sql,
    /for v_item in select value from jsonb_array_elements\(v_normalized\)[\s\S]*for update;[\s\S]*p_slot < v_destination\.last_slot[\s\S]*v_tx_sig <> v_destination\.last_tx_sig/i,
  );
  assert.match(sql, /partial_predates_destination_state/i);
  assert.match(sql, /partial_same_slot_destination_order_unknown/i);
  assert.match(
    sql,
    /if v_destination_chronology_reason is not null then[\s\S]*'appliedAmountTokens', 0[\s\S]*status = 'terminal'[\s\S]*return v_terminal_result/i,
  );
  assert.match(
    sql,
    /v_result->>'reason' in \([\s\S]*partial_predates_destination_state[\s\S]*partial_same_slot_destination_order_unknown[\s\S]*\) then/i,
  );
});

test("mixed wallets, raw evidence, split results, and same-tx acquisition are explicit", () => {
  assert.match(sql, /last_observed_balance_tokens numeric/i);
  assert.match(sql, /attributed_share numeric/i);
  assert.match(sql, /current_attributed_tokens \/ v_source_pre/i);
  assert.match(sql, /numeric\(78, 0\)/i);
  assert.match(sql, /v_requested_raw_total <> v_source_outflow_raw/i);
  assert.match(sql, /v_recipient_post_raw - v_recipient_pre_raw <> v_recipient_amount_raw/i);
  assert.match(
    sql,
    /if not v_raw_evidence_used and exists \([\s\S]*recipientPostRaw[\s\S]*raw evidence is incomplete/i,
  );
  assert.match(sql, /'rawEvidenceUsed', v_raw_evidence_used/i);
  assert.match(sql, /same_tx_verified_acquisition/i);
  assert.match(sql, /v_same_tx_buy_amount - v_requested_total/i);
  assert.match(sql, /if v_source_outflow = 0 and v_source_is_target then/i);
  assert.match(sql, /sameTransactionAcquisition/);
  assert.match(sql, /and slot is not distinct from p_slot/i);
  assert.match(sql, /v_same_tx_buy_amount - v_source_pre/i);
  assert.match(sql, /v_same_tx_buy_amount - \(v_source_post \+ v_requested_total\)/i);
  assert.match(sql, /\(v_chain_source_post - v_chain_source_pre\) - v_source_post/i);
  assert.match(sql, /v_same_tx_buy_raw <> v_source_pre_raw/i);
  assert.match(sql, /v_same_tx_buy_raw <> v_source_post_raw \+ v_requested_raw_total/i);
  assert.match(sql, /v_chain_source_post_raw - v_chain_source_pre_raw <> v_source_post_raw/i);
  assert.match(sql, /when v_wallet = any\(v_journey\.source_target_wallets\) then 0/i);
  assert.match(sql, /hop_depth = 0,/i);
  assert.match(sql, /'requestedAmountTokens'/i);
  assert.match(sql, /'appliedAmountTokens'/i);
  assert.match(sql, /'movedAmount'/i);
  assert.match(sql, /'watchStatus'/i);
  assert.match(sql, /'hopDepth'/i);
  assert.match(sql, /'boundaryReason'/i);
  assert.match(sql, /jsonb_array_length\(v_normalized\) = 1/i);
});

test("balance continuity is seeded and preserved across every custody boundary", () => {
  assert.match(
    sql,
    /custody target buy raw balance evidence[\s\S]*v_balance_pre := v_balance_pre_raw \/ v_balance_scale[\s\S]*v_balance_post := v_balance_post_raw \/ v_balance_scale/i,
  );
  assert.match(
    sql,
    /record_custody_target_buy[\s\S]*last_observed_balance_tokens, attributed_share, balance_evidence_reliable[\s\S]*v_balance_post/i,
  );
  assert.match(
    sql,
    /v_balance_pre < v_existing_wallet\.last_observed_balance_tokens[\s\S]*total_unresolved_outflow_tokens = total_unresolved_outflow_tokens \+ v_unresolved/i,
  );
  assert.match(
    sql,
    /v_source_pre := v_source_pre_raw \/ v_raw_scale[\s\S]*requestedAmountTokens', case[\s\S]*amountRaw'\)::numeric\(78, 0\) \/ v_raw_scale/i,
  );
  assert.match(
    sql,
    /v_destination\.last_observed_balance_tokens > 0[\s\S]*v_recipient_pre < v_destination\.last_observed_balance_tokens[\s\S]*v_destination_unresolved_total/i,
  );
  assert.match(sql, /'unresolvedRecipientOutflowTokens', v_destination_unresolved_total/i);
  assert.match(
    sql,
    /'coveragePartial',[\s\S]*v_destination_unresolved_total > 0[\s\S]*boundaryReason/i,
  );
  assert.match(sql, /v_effective_hop := case[\s\S]*greatest\(v_next_hop, v_destination\.hop_depth\)/i);
  assert.match(sql, /if v_effective_hop > 8 then/i);
  assert.ok(
    (sql.match(/select array_cat\(\s*v_released,/gi) ?? []).length >= 3,
    "flat paths must preserve the source wallet in releasedWallets",
  );
});

test("unresolved outflows are atomic, replayable, and never mislabeled as sales", () => {
  assert.match(sql, /create or replace function public\.record_custody_unresolved_outflow/i);
  assert.match(sql, /'eventType', 'CUSTODY_UNRESOLVED_OUTFLOW'/i);
  assert.match(sql, /'observationKind', 'CUSTODY_UNRESOLVED_OUTFLOW'/i);
  assert.match(sql, /v_pre_raw - v_post_raw <> v_amount_raw/i);
  assert.match(sql, /v_applied := least\(v_wallet_remaining, v_outflow \* least\(1, v_wallet_remaining \/ v_pre\)\)/i);
  assert.match(
    sql,
    /total_unresolved_outflow_tokens =\s*total_unresolved_outflow_tokens \+ v_total_unresolved/i,
  );
  assert.match(sql, /'partial_unresolved_outflow'/i);
  assert.match(sql, /'p_unresolved_outflow', true/i);
  assert.match(
    sql,
    /v_pending\.payload->>'p_unresolved_outflow'[\s\S]*record_custody_unresolved_outflow\(/i,
  );
  const unresolvedBody = sql.slice(
    sql.indexOf("create or replace function public.record_custody_unresolved_outflow"),
    sql.indexOf("create or replace function public.replay_custody_pending_events"),
  );
  assert.doesNotMatch(unresolvedBody, /total_verified_custody_sell_tokens\s*=/i);
});

test("staged payload conflicts cannot bypass quarantine or corrupt FOUND", () => {
  const transferBody = sql.slice(
    sql.indexOf("create or replace function public.record_custody_transfer"),
    sql.indexOf("create or replace function public.record_custody_unresolved_outflow"),
  );
  const sellBody = sql.slice(
    sql.indexOf("create or replace function public.record_verified_custody_sell"),
    sql.indexOf("create or replace function public.record_custody_transfer"),
  );
  for (const body of [sellBody, transferBody]) {
    assert.match(
      body,
      /select \* into v_pending[\s\S]*last_error_code = 'payload_mismatch'[\s\S]*select custody_journey_enabled/i,
    );
    assert.match(
      body,
      /select \* into v_journey[\s\S]*status = 'active'\s*for update;\s*if not found then/i,
      "active-journey FOUND must be consumed immediately",
    );
  }
  assert.ok(
    (sql.match(/status = 'terminal'[\s\S]{0,180}last_error_code = 'payload_mismatch'/gi) ?? [])
      .length >= 3,
  );
  assert.match(
    sql,
    /status = 'terminal'[\s\S]*last_error_code = 'payload_mismatch'[\s\S]*journey_id is null[\s\S]*source_wallet in/i,
  );
});

test("verified custody sells prefer complete exact raw evidence with UI fallback only when absent", () => {
  assert.match(
    sql,
    /v_raw_evidence_used :=[\s\S]*tokenBalanceBeforeRaw[\s\S]*tokenBalanceAfterRaw[\s\S]*soldAmountRaw[\s\S]*amountRaw/i,
  );
  assert.match(sql, /v_pre_raw numeric\(78, 0\)/i);
  assert.match(sql, /v_post_raw numeric\(78, 0\)/i);
  assert.match(sql, /v_sold_raw numeric\(78, 0\)/i);
  assert.match(sql, /v_pre_raw - v_post_raw <> v_sold_raw/i);
  assert.match(sql, /amountRaw'\)::numeric\(78, 0\) <> v_sold_raw/i);
  assert.match(sql, /v_raw_scale := power\(10::numeric, v_decimals\)/i);
  assert.match(sql, /v_pre := v_pre_raw \/ v_raw_scale/i);
  assert.match(sql, /v_post := v_post_raw \/ v_raw_scale/i);
  assert.match(sql, /v_outflow := v_sold_raw \/ v_raw_scale/i);
  assert.match(
    sql,
    /if v_raw_evidence_used then[\s\S]*raw evidence is incomplete[\s\S]*else[\s\S]*p_sold_amount_tokens <= 0[\s\S]*abs\(v_outflow - p_sold_amount_tokens\)/i,
  );
  assert.match(sql, /'soldAmountRaw', case when v_raw_evidence_used then v_sold_raw else null end/i);
  assert.match(
    sql,
    /'soldAmountTokens', case when v_raw_evidence_used then null else v_sold_amount end/i,
  );
  assert.match(sql, /p_sold_amount_tokens < 0/i);
  assert.doesNotMatch(sql, /p_sold_amount_tokens <= 0[\s\S]{0,500}invalid or unverified custody sell/i);
  assert.match(sql, /'p_sold_amount_tokens', v_sold_amount/i);
  assert.match(sql, /v_sold_amount \* least\(1, v_seller_state\.current_attributed_tokens \/ v_pre\)/i);
  assert.match(sql, /'rawEvidenceUsed', v_raw_evidence_used/i);
});

test("canonical schema contains the exact Custody Journey migration", () => {
  const marker = "-- CUSTODY_JOURNEY_CANONICAL_MIRROR_BEGIN";
  const nextMarker = "-- Conviction Mode schema (kept in sync with conviction-mode-migration.sql).";
  const start = schema.indexOf(marker);
  const end = schema.indexOf(nextMarker, start);
  assert.notEqual(start, -1, "Custody Journey schema marker is missing");
  assert.notEqual(end, -1, "Custody Journey schema end marker is missing");
  assert.equal(schema.slice(start + marker.length, end).trim(), sql.trim());
});

test("all PL/pgSQL DECLARE blocks use unique variable names", () => {
  const functions = sql.matchAll(
    /create or replace function[\s\S]*?as \$\$\s*declare\s*([\s\S]*?)\s*begin[\s\S]*?\$\$;/gi,
  );
  let checked = 0;
  for (const match of functions) {
    checked += 1;
    const names = Array.from(match[1].matchAll(/^\s*([a-z_][a-z0-9_]*)\s+/gim), (item) => item[1]);
    const duplicate = names.find((name, index) => names.indexOf(name) !== index);
    assert.equal(duplicate, undefined, `duplicate DECLARE variable: ${duplicate}`);
  }
  assert.equal(checked, 5);
});

test("worker config and doctor gate the isolated custody schema", () => {
  assert.match(dbSource, /custody_journey_enabled\?: boolean/);
  assert.match(dashboardTypes, /custody_journey_enabled: boolean/);
  assert.match(dashboardConfig, /custodyJourneyEnabled: boolean/);
  assert.match(dashboardConfig, /custodyJourneyEnabled: false/);
  assert.match(dashboardSchema, /custodyJourneyEnabled: z\.boolean\(\)/);
  assert.match(dashboardServer, /custodyJourneyEnabled: row\.custody_journey_enabled \?\? false/);
  assert.match(dashboardServer, /custody_journey_enabled: cfg\.custodyJourneyEnabled/);
  assert.match(settingsPanel, /checked=\{cfg\.custodyJourneyEnabled\}/);
  assert.match(settingsPanel, /observation only/i);
  assert.match(dashboardRoute, /CustodyJourneyDashboard enabled=\{cfg\.custodyJourneyEnabled\}/);
  assert.ok(custodyDoctorSource.length > 0, "custody doctor schema gate is missing");
  for (const table of [
    "custody_journeys",
    "custody_journey_wallets",
    "custody_journey_events",
    "custody_wallet_profiles",
    "custody_rpc_wallet_cursors",
    "custody_worker_heartbeat",
    "custody_pending_events",
  ]) {
    assert.match(
      custodyDoctorSource,
      new RegExp(`\\.from\\(["']${table}["']\\)`),
      `${table} missing from doctor schema gate`,
    );
  }
  assert.match(
    custodyDoctorSource,
    /\.from\("custody_journey_wallets"\)[\s\S]*?\.select\(\s*"[^"]*\bwatch_anchor_slot\b[^"]*"\s*,?\s*\)/,
    "doctor must reject schemas that predate the earliest durable watch anchor",
  );
  assert.match(
    custodyDoctorSource,
    /\.from\("custody_journeys"\)[\s\S]*?\.select\(\s*"[^"]*\btotal_unresolved_outflow_tokens\b[^"]*"\s*,?\s*\)/,
    "doctor must require journey-level unresolved-outflow accounting",
  );
  assert.match(
    custodyDoctorSource,
    /\.from\("custody_journey_wallets"\)[\s\S]*?\.select\(\s*"[^"]*\btotal_unresolved_outflow_tokens\b[^"]*"\s*,?\s*\)/,
    "doctor must require wallet-level unresolved-outflow accounting",
  );
  for (const rpc of [
    "record_custody_target_buy",
    "record_custody_transfer",
    "record_verified_custody_sell",
    "record_custody_unresolved_outflow",
    "replay_custody_pending_events",
  ]) {
    assert.match(
      custodyDoctorSource,
      new RegExp(`/rpc/${rpc}`),
      `${rpc} missing from doctor RPC readiness gate`,
    );
  }
  assert.match(doctorSource, /observation_only: true/);
  assert.doesNotMatch(doctorSource, /custody_worker_heartbeat[\s\S]{0,300}Entries switch/i);
});
