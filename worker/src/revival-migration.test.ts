import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const migration = readFileSync(root("supabase/revival-campaign-migration.sql"), "utf8");
const schema = readFileSync(root("supabase/schema.sql"), "utf8");
const workerDb = readFileSync(root("worker/src/db.ts"), "utf8");
const doctor = readFileSync(root("worker/src/doctor.ts"), "utf8");
const packageJson = readFileSync(root("worker/package.json"), "utf8");
const botConfig = readFileSync(root("src/lib/bot-config.ts"), "utf8");
const botSchemas = readFileSync(root("src/lib/bot.schemas.ts"), "utf8");
const botServer = readFileSync(root("src/lib/bot.server.ts"), "utf8");
const supabaseTypes = readFileSync(root("src/lib/supabase-types.ts"), "utf8");

const REVIVAL_TABLES = [
  "revival_strategy_versions",
  "revival_campaigns",
  "revival_events",
  "revival_transitions",
  "revival_market_snapshots",
  "revival_shadow_actions",
  "revival_outcomes",
  "revival_rpc_wallet_cursors",
  "revival_worker_heartbeat",
];

test("Revival migration is additive, defaults OFF, and uses the exact $2k-$15k seed band", () => {
  assert.doesNotMatch(migration, /\bdelete\s+from\b/i);
  assert.doesNotMatch(migration, /\btruncate\b/i);
  assert.doesNotMatch(migration, /\bdrop\b/i);
  assert.match(
    migration,
    /add column if not exists revival_tracker_enabled boolean not null default false/i,
  );
  assert.match(
    migration,
    /add column if not exists revival_market_cap_min_usd numeric not null default 2000/i,
  );
  assert.match(
    migration,
    /add column if not exists revival_market_cap_max_usd numeric not null default 15000/i,
  );
  assert.match(migration, /revival_market_cap_max_usd >= revival_market_cap_min_usd/i);
  assert.doesNotMatch(migration, /revival_tracker_enabled\s*=\s*true/i);
});

test("Revival migration cannot mutate trading, position, funding, or claim tables", () => {
  const forbiddenTradingMutation =
    /(?:alter\s+table|insert\s+into|update|delete\s+from|truncate\s+table)\s+public\.(?:positions|trades|funding_keys|entry_signal_claims|sell_signal_claims)\b/i;
  assert.doesNotMatch(migration, forbiddenTradingMutation);
  assert.doesNotMatch(migration, /\bmode\s*=\s*["']live["']/i);
  assert.doesNotMatch(migration, /\btrading_mode\b/i);
});

test("all Revival tables are present, RLS protected, and service-write/authenticated-read only", () => {
  for (const table of REVIVAL_TABLES) {
    assert.match(
      migration,
      new RegExp(`create table if not exists public\\.${table}\\b`, "i"),
      `${table} must be created additively`,
    );
    assert.match(
      migration,
      new RegExp(`alter table public\\.${table} enable row level security`, "i"),
      `${table} must enable RLS`,
    );
    assert.match(
      migration,
      new RegExp(`["']${table}["']`),
      `${table} must participate in the own-row policy loop`,
    );
  }

  assert.match(
    migration,
    /create policy %I on public\.%I for select to authenticated using \(user_id = auth\.uid\(\)\)/i,
  );
  assert.match(migration, /revoke all on table[\s\S]*from public, anon, authenticated/i);
  assert.match(migration, /grant select on table[\s\S]*to authenticated/i);
  assert.match(migration, /grant select, insert, update on table[\s\S]*to service_role/i);
  assert.doesNotMatch(migration, /grant\s+delete\b/i);
});

test("database action rows are CHECK-constrained to non-executable shadow mode", () => {
  assert.match(migration, /mode text not null default 'shadow' check \(mode = 'shadow'\)/i);
  assert.match(
    migration,
    /executable boolean not null default false check \(executable = false\)/i,
  );
  assert.doesNotMatch(migration, /check\s*\([^)]*mode[^)]*live/i);
  assert.doesNotMatch(migration, /executable\s*=\s*true/i);
});

test("campaign identity and market coverage are durable across engine versions", () => {
  assert.match(migration, /seed_tx_index integer/i);
  assert.match(migration, /last_market_observed_at timestamptz/i);
  assert.match(
    migration,
    /alter table public\.revival_campaigns[\s\S]*add column if not exists seed_tx_index integer,[\s\S]*add column if not exists last_market_observed_at timestamptz/i,
  );
  assert.match(migration, /unique \(user_id, engine_version, token_mint, campaign_number\)/i);
  assert.match(
    migration,
    /create unique index if not exists revival_campaigns_one_open_mint_engine_idx\s+on public\.revival_campaigns \(user_id, engine_version, token_mint\)\s+where closed_at is null/i,
  );
  assert.doesNotMatch(migration, /unique \(user_id, token_mint, campaign_number\)/i);
  assert.doesNotMatch(
    migration,
    /on public\.revival_campaigns \(user_id, token_mint\)\s+where closed_at is null/i,
  );
});

test("canonical schema embeds the Revival migration byte-for-byte", () => {
  const begin = "-- REVIVAL_CAMPAIGN_CANONICAL_MIRROR_BEGIN";
  const end = "-- REVIVAL_CAMPAIGN_CANONICAL_MIRROR_END";
  const beginIndex = schema.indexOf(begin);
  const endIndex = schema.indexOf(end);

  assert.ok(beginIndex >= 0, "canonical mirror begin marker is missing");
  assert.ok(endIndex > beginIndex, "canonical mirror end marker is missing or out of order");
  assert.equal(schema.indexOf(begin, beginIndex + begin.length), -1, "begin marker must be unique");
  assert.equal(schema.indexOf(end, endIndex + end.length), -1, "end marker must be unique");

  const embedded = schema.slice(beginIndex + begin.length, endIndex).trim();
  assert.equal(embedded, migration.trim());
});

test("Revival config round-trips with one safe toggle and the exact seed-cap defaults", () => {
  for (const source of [workerDb, supabaseTypes]) {
    assert.match(source, /revival_tracker_enabled\??:\s*boolean/i);
    assert.match(source, /revival_market_cap_min_usd\??:\s*number/i);
    assert.match(source, /revival_market_cap_max_usd\??:\s*number/i);
  }
  assert.match(botConfig, /revivalTrackerEnabled:\s*false/i);
  assert.match(botConfig, /revivalMarketCapMinUsd:\s*2_000/i);
  assert.match(botConfig, /revivalMarketCapMaxUsd:\s*15_000/i);
  assert.match(botSchemas, /revivalMarketCapMinUsd\s*<=\s*config\.revivalMarketCapMaxUsd/i);
  assert.match(botServer, /revivalTrackerEnabled:\s*row\.revival_tracker_enabled\s*\?\?\s*false/i);
  assert.match(botServer, /revival_market_cap_min_usd:\s*cfg\.revivalMarketCapMinUsd/i);
  assert.match(botServer, /revival_market_cap_max_usd:\s*cfg\.revivalMarketCapMaxUsd/i);
  assert.doesNotMatch(
    [workerDb, botConfig, botSchemas, botServer, supabaseTypes].join("\n"),
    /revival(?:Tracker|_tracker)?(?:Trading)?Mode|revival.*\blive\b/i,
  );
});

test("Doctor and process scripts require the isolated Revival schema and observer entrypoint", () => {
  for (const table of REVIVAL_TABLES) assert.match(doctor, new RegExp(table));
  assert.match(doctor, /revival_tracker_enabled/i);
  assert.match(doctor, /rpc_backlog_wallet_count/i);
  assert.match(doctor, /heartbeatFresh/i);
  for (const requiredWriteColumn of [
    "target_wallets",
    "unique_target_wallet_count",
    "seed_price_usd",
    "seed_tx_index",
    "last_market_observed_at",
    "target_gross_buys_usd",
    "tx_sig",
    "amount_tokens",
    "pair_address",
    "dex_id",
    "source_event_key",
    "metadata",
  ]) {
    assert.match(doctor, new RegExp(requiredWriteColumn), `${requiredWriteColumn} must be probed`);
  }
  assert.match(doctor, /Legacy REVIVAL_ONLY_MODE/);
  assert.match(doctor, /money-moving entry route/);
  const parsed = JSON.parse(packageJson) as { scripts?: Record<string, string> };
  assert.equal(parsed.scripts?.revival, "node dist/revival-index.js");
  assert.equal(parsed.scripts?.["revival:dev"], "tsx src/revival-index.ts");
});
