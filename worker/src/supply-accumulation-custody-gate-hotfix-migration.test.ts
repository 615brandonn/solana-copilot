import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const migration = readFileSync(
  root("supabase/supply-accumulation-custody-gate-hotfix-migration.sql"),
  "utf8",
);
const entryMigration = readFileSync(
  root("supabase/supply-accumulation-entry-migration.sql"),
  "utf8",
);
const schema = readFileSync(root("supabase/schema.sql"), "utf8");

function between(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing start marker: ${start}`);
  assert.ok(endIndex > startIndex, `missing end marker: ${end}`);
  return source.slice(startIndex, endIndex).trim();
}

function normalizeReviewedGate(source: string): string {
  const cteStart = source.indexOf("  with config as materialized (");
  const windowStart = source.indexOf("  ), window_journeys as materialized (", cteStart);
  assert.ok(cteStart >= 0, "gate config CTE is missing");
  assert.ok(windowStart > cteStart, "gate window CTE is missing");
  let normalized = `${source.slice(0, cteStart)}  with /* reviewed health scope */\n${source.slice(
    windowStart,
  )}`;

  const backlogStart = normalized.indexOf(
    "      coalesce((select rpc_backlog_wallet_count = 0 from heartbeat), false)",
  );
  const backlogEndMarker = "        ) as backlog_clear,";
  const backlogEnd = normalized.indexOf(backlogEndMarker, backlogStart);
  assert.ok(backlogStart >= 0, "gate heartbeat backlog proof is missing");
  assert.ok(backlogEnd > backlogStart, "gate persisted backlog proof is missing");
  normalized = `${normalized.slice(0, backlogStart)}      /* reviewed persisted backlog scope */,${normalized.slice(
    backlogEnd + backlogEndMarker.length,
  )}`;
  return normalized;
}

test("custody gate hotfix is transactional, additive, rerunnable, and cursor immutable", () => {
  assert.match(migration, /^begin;/im);
  assert.match(migration, /^commit;/im);
  assert.equal(
    migration.match(/create or replace function public\.check_supply_accumulation_custody_gate\(/gi)
      ?.length,
    1,
  );
  assert.doesNotMatch(migration, /\btruncate\b/i);
  assert.doesNotMatch(migration, /\bdrop\s+(?:table|column|schema)\b/i);
  assert.doesNotMatch(
    migration,
    /(?:insert\s+into|update|delete\s+from)\s+public\.(?:custody_rpc_wallet_cursors|rpc_wallet_cursors)\b/i,
  );
  assert.doesNotMatch(
    migration,
    /(?:insert\s+into|update|delete\s+from)\s+public\.(?:bot_config|positions|trades|entry_signal_claims|supply_accumulation_scale_claims|sell_signal_claims)\b/i,
  );
});

test("replacement keeps the exact service-only signature and hardened search path", () => {
  assert.match(
    migration,
    /create or replace function public\.check_supply_accumulation_custody_gate\(\s*p_user_id uuid,\s*p_token_mint text,\s*p_window_started_at timestamptz,\s*p_trigger_tx_sig text,\s*p_trigger_slot bigint,\s*p_target_wallet text\s*\)\s*returns jsonb\s*language plpgsql\s*security definer\s*set search_path = pg_catalog, public, pg_temp/i,
  );
  assert.match(migration, /coalesce\(auth\.role\(\), ''\) <> 'service_role'/i);
  assert.match(migration, /errcode = '42501'/i);
  assert.match(
    migration,
    /pg_advisory_xact_lock\(hashtext\(p_user_id::text\), hashtext\(v_mint\)\)/i,
  );
});

test("persisted backlog is scoped only to configured targets or active positive custody wallets", () => {
  assert.match(
    migration,
    /array_prepend\(\s*nullif\(btrim\(target_wallet\), ''\),\s*coalesce\(additional_target_wallets, array\[\]::text\[\]\)\s*\)/i,
  );
  assert.match(migration, /configured_targets as materialized/i);
  assert.match(
    migration,
    /active_positive_custody_wallets as materialized[\s\S]*j\.status = 'active'[\s\S]*j\.current_attributed_tokens > 0[\s\S]*w\.watch_status = 'active'[\s\S]*w\.current_attributed_tokens > 0/i,
  );
  assert.match(
    migration,
    /relevant_backlog_wallets as materialized\s*\(\s*select wallet from configured_targets\s*union\s*select wallet from active_positive_custody_wallets/i,
  );
  assert.match(
    migration,
    /from public\.custody_rpc_wallet_cursors c\s+join relevant_backlog_wallets relevant\s+on relevant\.wallet = btrim\(c\.wallet\)\s+where c\.user_id = p_user_id\s+and c\.backlog_detected/i,
  );
  assert.doesNotMatch(
    migration,
    /from public\.custody_rpc_wallet_cursors c\s+where c\.user_id = p_user_id and c\.backlog_detected/i,
  );
});

test("global live heartbeat safety remains fresh, healthy, and backlog-free", () => {
  assert.match(migration, /coalesce\(\(select enabled from heartbeat\), false\)/i);
  assert.match(migration, /coalesce\(\(select not degraded from heartbeat\), false\)/i);
  assert.match(
    migration,
    /updated_at >= now\(\) - interval '60 seconds' and updated_at <= now\(\)/i,
  );
  assert.match(
    migration,
    /rpc_last_success_at is not null\s+and rpc_last_success_at >= now\(\) - interval '60 seconds'\s+and rpc_last_success_at <= now\(\)/i,
  );
  assert.match(
    migration,
    /coalesce\(\(select rpc_backlog_wallet_count = 0 from heartbeat\), false\)\s+and not exists/i,
  );
  const decision = between(migration, "  ), decision as (", "  select reason into v_reason");
  for (const reason of [
    "custody_heartbeat_missing",
    "custody_heartbeat_disabled",
    "custody_heartbeat_degraded",
    "custody_heartbeat_stale",
    "custody_rpc_stale",
    "custody_backlog",
  ]) {
    assert.match(decision, new RegExp(`'${reason}'`, "i"));
  }
});

test("only the reviewed health CTEs changed; trigger, sell, outflow, and attribution proofs are exact", () => {
  const originalGate = between(
    entryMigration,
    "create or replace function public.check_supply_accumulation_custody_gate(",
    "alter table public.supply_accumulation_events enable row level security;",
  );
  const replacementGate = between(
    migration,
    "create or replace function public.check_supply_accumulation_custody_gate(",
    "-- CREATE OR REPLACE preserves ownership.",
  );
  assert.equal(normalizeReviewedGate(replacementGate), normalizeReviewedGate(originalGate));
  assert.match(
    replacementGate,
    /e\.event_type = 'VERIFIED_TARGET_BUY'[\s\S]*e\.tx_sig = v_tx_sig[\s\S]*e\.slot = p_trigger_slot[\s\S]*e\.source_wallet = v_target[\s\S]*e\.evidence_reliable/i,
  );
  assert.match(replacementGate, /e\.event_type = 'VERIFIED_CUSTODY_SELL'/i);
  assert.match(replacementGate, /total_unresolved_outflow_tokens > 0/i);
  assert.match(replacementGate, /p\.status <> 'applied'/i);
});

test("preflight, least privilege, and postflight verification are explicit", () => {
  for (const object of [
    "bot_config",
    "custody_worker_heartbeat",
    "custody_rpc_wallet_cursors",
    "custody_journeys",
    "custody_journey_wallets",
    "custody_journey_events",
    "custody_pending_events",
  ]) {
    assert.match(migration, new RegExp(`to_regclass\\('public\\.${object}'\\) is null`, "i"));
  }
  assert.match(
    migration,
    /revoke all on function public\.check_supply_accumulation_custody_gate\([\s\S]*from public, anon, authenticated/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.check_supply_accumulation_custody_gate\([\s\S]*to service_role/i,
  );
  assert.match(migration, /pg_get_functiondef/i);
  for (const proof of [
    "configured_targets as materialized",
    "active_positive_custody_wallets as materialized",
    "join relevant_backlog_wallets relevant",
    "rpc_backlog_wallet_count = 0",
    "VERIFIED_TARGET_BUY",
    "VERIFIED_CUSTODY_SELL",
    "total_unresolved_outflow_tokens > 0",
  ]) {
    assert.match(
      migration,
      new RegExp(`position\\('${proof.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"),
    );
  }
});

test("canonical schema embeds the custody gate hotfix byte-for-byte", () => {
  const begin = "-- SUPPLY_ACCUMULATION_CUSTODY_GATE_HOTFIX_CANONICAL_MIRROR_BEGIN";
  const end = "-- SUPPLY_ACCUMULATION_CUSTODY_GATE_HOTFIX_CANONICAL_MIRROR_END";
  const beginIndex = schema.indexOf(begin);
  const endIndex = schema.indexOf(end);
  assert.ok(beginIndex >= 0, "canonical mirror begin marker is missing");
  assert.ok(endIndex > beginIndex, "canonical mirror end marker is missing");
  assert.equal(schema.slice(beginIndex + begin.length, endIndex).trim(), migration.trim());
});
