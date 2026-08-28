import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const sql = readFileSync(root("supabase/custody-backlog-v2-migration.sql"), "utf8");
const custodySql = readFileSync(root("supabase/custody-journey-migration.sql"), "utf8");
const capabilitiesSql = readFileSync(
  root("supabase/custody-pending-queue-capabilities-migration.sql"),
  "utf8",
);
const schema = readFileSync(root("supabase/schema.sql"), "utf8");
const doctor = readFileSync(root("worker/src/doctor.ts"), "utf8");

test("custody backlog v2 preserves every evidence row and classifies scheduler state", () => {
  assert.doesNotMatch(sql, /\bdelete\s+from\b/i);
  assert.doesNotMatch(sql, /\btruncate\b/i);
  assert.doesNotMatch(sql, /\bdrop\s+(?:table|column|schema)\b/i);
  assert.doesNotMatch(
    sql,
    /(?:insert\s+into|update)\s+public\.(?:positions|trades|entry_signal_claims|sell_signal_claims)\b/i,
  );
  assert.match(sql, /add column if not exists queue_state text not null default 'ready'/i);
  for (const state of [
    "ready",
    "dormant_scope",
    "waiting_dependency",
    "transient_retry",
    "resolved",
  ]) {
    assert.match(sql, new RegExp(`'${state}'`, "i"));
  }
  assert.match(
    sql,
    /last_error_code = 'unscoped'[\s\S]*then 'dormant_scope'[\s\S]*then 'infinity'::timestamptz/i,
  );
  assert.match(
    sql,
    /last_error_code in \([\s\S]*'pending_upstream'[\s\S]*'source_not_attributed'[\s\S]*'seller_not_attributed'[\s\S]*then 'waiting_dependency'/i,
  );
  assert.match(sql, /when queue_state = 'waiting_dependency' then 'waiting_dependency'/i);
  assert.match(
    sql,
    /queue_state = 'waiting_dependency'[\s\S]*new\.next_retry_at := new\.expires_at/i,
  );
  assert.match(
    sql,
    /new\.queue_state = 'waiting_dependency'[\s\S]*new\.expires_at = 'infinity'::timestamptz[\s\S]*new\.expires_at := now\(\) \+ interval '24 hours'/i,
  );
});

test("custody backlog v2 indexes finite due work and exact dependency wakeups", () => {
  assert.match(
    sql,
    /create index if not exists custody_pending_events_due_v2_idx[\s\S]*user_id, next_retry_at[\s\S]*next_retry_at < 'infinity'::timestamptz/i,
  );
  assert.match(
    sql,
    /create index if not exists custody_pending_events_wake_v2_idx[\s\S]*user_id, token_mint, source_wallet, slot, id/i,
  );
  assert.match(
    sql,
    /create index if not exists custody_pending_events_expiry_v2_idx[\s\S]*queue_state = 'waiting_dependency'[\s\S]*expires_at < 'infinity'::timestamptz/i,
  );
  assert.match(sql, /create or replace function public\.wake_custody_pending_dependencies_v2/i);
  assert.match(
    sql,
    /pending\.user_id = new\.user_id[\s\S]*pending\.token_mint = new\.token_mint[\s\S]*pending\.source_wallet = new\.wallet/i,
  );
  assert.match(sql, /pending\.journey_id is null or pending\.journey_id = new\.journey_id/i);
  assert.match(
    sql,
    /v_anchor_slot is null or pending\.slot is null or pending\.slot >= v_anchor_slot/i,
  );
  assert.match(
    sql,
    /after insert or update of current_attributed_tokens, last_slot, watch_status[\s\S]*on public\.custody_journey_wallets/i,
  );
});

test("custody backlog v2 serializes replay and retries only SQL exceptions", () => {
  assert.match(
    sql,
    /pg_try_advisory_xact_lock\([\s\S]*hashtext\('custody_pending_replay_v2'\)[\s\S]*hashtext\(p_user_id::text\)/i,
  );
  assert.match(
    sql,
    /queue_state in \('ready', 'waiting_dependency', 'transient_retry'\)[\s\S]*next_retry_at <= now\(\)[\s\S]*order by \(slot is null\), slot, event_at, created_at, id/i,
  );
  assert.match(sql, /for update skip locked/i);
  assert.match(sql, /exception when others[\s\S]*get stacked diagnostics[\s\S]*returned_sqlstate/i);
  assert.doesNotMatch(sql, /message_text|last_error_detail/i);
  assert.equal(
    (sql.match(/retry_count\s*=\s*retry_count\s*\+\s*1/gi) ?? []).length,
    1,
    "dependency waits must not consume timed retry attempts",
  );
  assert.match(
    sql,
    /v_queue_state := 'transient_retry'[\s\S]*least\([\s\S]*3600::double precision[\s\S]*random\(\)/i,
  );
  assert.match(sql, /when v_queue_state = 'waiting_dependency' then expires_at/i);
  assert.match(
    sql,
    /if v_pending\.expires_at <= now\(\)[\s\S]*v_pending\.queue_state <> 'waiting_dependency'[\s\S]*elsif v_pending\.expires_at <= now\(\)[\s\S]*v_reason := 'pending_expired'/i,
  );
  assert.match(
    sql,
    /if v_reason = 'pending_upstream'[\s\S]*VERIFIED_CUSTODY_SELL[\s\S]*'seller_not_attributed'[\s\S]*'source_not_attributed'/i,
  );
  assert.match(sql, /'schemaVersion', 2, 'busy', true/i);
  assert.match(sql, /'schemaVersion', 2, 'busy', false/i);
});

test("custody queue health is service-only and reports honest queue classes", () => {
  assert.match(
    sql,
    /create or replace function public\.custody_pending_queue_health\(p_user_id uuid\)/i,
  );
  assert.match(
    sql,
    /create or replace function public\.custody_pending_queue_health[\s\S]*auth\.role\(\) <> 'service_role'/i,
  );
  for (const field of [
    "schemaVersion",
    "indexesReady",
    "replayDueCount",
    "actionableDueCount",
    "scheduledRetryCount",
    "waitingDependencyCount",
    "dormantScopeCount",
    "expiryDueCount",
    "oldestActionableEventAt",
    "oldestWaitingEventAt",
    "maxRetryCount",
    "totalEvidenceCount",
  ]) {
    assert.match(sql, new RegExp(`'${field}'`, "i"));
  }
  assert.match(
    sql,
    /revoke all on function public\.custody_pending_queue_health\(uuid\)[\s\S]*from public, anon, authenticated/i,
  );
  assert.match(
    sql,
    /grant execute on function public\.custody_pending_queue_health\(uuid\)[\s\S]*to service_role/i,
  );
});

test("Doctor requires only custody RPCs that are reproducible from checked-in SQL", () => {
  const custodyCheck = doctor.slice(
    doctor.indexOf("async function checkCustodyJourneySchema"),
    doctor.indexOf("async function checkRevivalTrackerSchema"),
  );
  const requiredRpcNames = [...custodyCheck.matchAll(/"\/rpc\/([a-z0-9_]+)"/g)].map(
    (match) => match[1],
  );
  assert.ok(requiredRpcNames.length > 0, "Doctor must probe the custody RPC contract");
  for (const rpcName of requiredRpcNames) {
    assert.match(
      `${custodySql}\n${sql}\n${capabilitiesSql}`,
      new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${rpcName}\\s*\\(`, "i"),
      `Doctor requires ${rpcName}, but no checked-in custody migration defines it`,
    );
  }
});

test("Doctor uses a constant-time service-only Custody capability proof", () => {
  assert.match(
    capabilitiesSql,
    /create or replace function public\.custody_pending_queue_capabilities\(p_user_id uuid\)/i,
  );
  assert.match(capabilitiesSql, /set search_path = pg_catalog, public, pg_temp/i);
  assert.match(capabilitiesSql, /coalesce\(auth\.role\(\), ''\) <> 'service_role'/i);
  for (const index of [
    "custody_pending_events_due_v2_idx",
    "custody_pending_events_wake_v2_idx",
    "custody_pending_events_expiry_v2_idx",
  ]) {
    assert.match(capabilitiesSql, new RegExp(`to_regclass\\('public\\.${index}'\\)`, "i"));
  }
  assert.doesNotMatch(capabilitiesSql, /from\s+public\.custody_pending_events/i);
  assert.match(
    capabilitiesSql,
    /revoke all on function public\.custody_pending_queue_capabilities\(uuid\)[\s\S]*from public, anon, authenticated/i,
  );
  assert.match(
    capabilitiesSql,
    /grant execute on function public\.custody_pending_queue_capabilities\(uuid\)[\s\S]*to service_role/i,
  );

  const custodyCheck = doctor.slice(
    doctor.indexOf("async function checkCustodyJourneySchema"),
    doctor.indexOf("async function checkRevivalTrackerSchema"),
  );
  assert.match(custodyCheck, /db\.rpc\(\s*"custody_pending_queue_capabilities"/i);
  assert.doesNotMatch(custodyCheck, /db\.rpc\(\s*"custody_pending_queue_health"/i);
});

test("canonical schema contains the exact Custody capability migration", () => {
  const startMarker = "-- CUSTODY_PENDING_QUEUE_CAPABILITIES_CANONICAL_MIRROR_BEGIN\n";
  const endMarker = "-- CUSTODY_PENDING_QUEUE_CAPABILITIES_CANONICAL_MIRROR_END";
  const start = schema.indexOf(startMarker);
  const end = schema.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, "Custody capability schema markers are missing");
  assert.equal(schema.slice(start + startMarker.length, end), capabilitiesSql);
});

test("canonical schema contains the exact custody backlog v2 migration", () => {
  const startMarker = "-- CUSTODY_BACKLOG_V2_CANONICAL_MIRROR_BEGIN";
  const endMarker = "-- CUSTODY_BACKLOG_V2_CANONICAL_MIRROR_END";
  const start = schema.indexOf(startMarker);
  const end = schema.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, "custody backlog v2 schema marker is missing");
  assert.notEqual(end, -1, "custody backlog v2 schema end marker is missing");
  assert.equal(schema.slice(start + startMarker.length, end).trim(), sql.trim());
});
