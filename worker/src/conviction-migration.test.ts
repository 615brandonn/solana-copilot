import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const migration = readFileSync(
  fileURLToPath(new URL("../../supabase/conviction-mode-migration.sql", import.meta.url)),
  "utf8",
);
const schema = readFileSync(
  fileURLToPath(new URL("../../supabase/schema.sql", import.meta.url)),
  "utf8",
);
const workerDbSource = readFileSync(
  fileURLToPath(new URL("../src/db.ts", import.meta.url)),
  "utf8",
);
const doctorSource = readFileSync(
  fileURLToPath(new URL("../src/doctor.ts", import.meta.url)),
  "utf8",
);
const dashboardTypesSource = readFileSync(
  fileURLToPath(new URL("../../src/lib/supabase-types.ts", import.meta.url)),
  "utf8",
);
const dashboardConfigSource = readFileSync(
  fileURLToPath(new URL("../../src/lib/bot-config.ts", import.meta.url)),
  "utf8",
);
const dashboardSchemaSource = readFileSync(
  fileURLToPath(new URL("../../src/lib/bot.schemas.ts", import.meta.url)),
  "utf8",
);
const dashboardMappingSource = readFileSync(
  fileURLToPath(new URL("../../src/lib/bot.server.ts", import.meta.url)),
  "utf8",
);
const convictionSettingsSource = readFileSync(
  fileURLToPath(
    new URL("../../src/components/dashboard/ConvictionSettingsCard.tsx", import.meta.url),
  ),
  "utf8",
);

test("Conviction Mode migration is additive and safe by default", () => {
  assert.doesNotMatch(migration, /\bdelete\b/i);
  assert.doesNotMatch(migration, /\btruncate\b/i);
  assert.doesNotMatch(migration, /\bdrop\b/i);
  assert.doesNotMatch(migration, /\binsert\s+into\b/i);
  assert.doesNotMatch(migration, /\bupdate\s+public\./i);
  assert.doesNotMatch(migration, /\balter\s+column\b/i);
  assert.match(migration, /conviction_mode_enabled boolean not null default false/i);
  assert.match(migration, /conviction_trading_mode text not null default 'shadow'/i);
  assert.match(migration, /conviction_rapid_follow_enabled boolean not null default false/i);
  assert.match(migration, /conviction_min_recent_net_inflow_usd numeric not null default 0\.01/i);
  assert.doesNotMatch(migration, /conviction_base_entry_buy_usd/i);
  assert.match(migration, /conviction_max_position_per_token_usd numeric not null default 25/i);
  assert.match(
    migration,
    /conviction_tier_buy_amounts_usd numeric\[\] not null\s+default array\[5, 5, 5, 10\]::numeric\[\]/i,
  );
  assert.match(dashboardConfigSource, /convictionModeEnabled:\s*false/i);
  assert.match(dashboardConfigSource, /convictionTradingMode:\s*"shadow"/i);
  assert.match(dashboardConfigSource, /convictionRapidFollowEnabled:\s*false/i);
  assert.match(dashboardConfigSource, /convictionMinRecentNetInflowUsd:\s*0\.01/i);
  assert.match(
    migration,
    /bot_config_conviction_recent_net_inflow_check[\s\S]*check \(conviction_min_recent_net_inflow_usd >= 0\)/i,
  );
  assert.match(convictionSettingsSource, /value=\{cfg\.convictionMinRecentNetInflowUsd\}/i);
  assert.doesNotMatch(dashboardConfigSource, /convictionBaseEntryBuyUsd/i);
});

test("Conviction persistence is tenant-isolated and replay safe", () => {
  for (const table of [
    "conviction_events",
    "conviction_token_state",
    "conviction_rank_history",
    "conviction_transitions",
    "conviction_tiers",
  ]) {
    assert.match(migration, new RegExp(`create table if not exists public\\.${table}`, "i"));
    assert.match(
      migration,
      new RegExp(`alter table public\\.${table} enable row level security`, "i"),
    );
  }
  assert.match(migration, /unique \(user_id, event_key\)/i);
  assert.match(migration, /primary key \(user_id, token_mint\)/i);
  assert.doesNotMatch(migration, /unique\s*\(user_id, token_mint, tier_number\s*\)/i);
  assert.match(
    migration,
    /create unique index if not exists conviction_tiers_user_mint_tier_mode_idx\s+on public\.conviction_tiers \(user_id, token_mint, tier_number, trading_mode\)/i,
  );
  assert.match(
    migration,
    /create or replace function public\.conviction_tier_identity_health\(\)/i,
  );
  assert.match(
    migration,
    /returns table\(mode_scoped_unique boolean, legacy_unscoped_unique boolean\)/i,
  );
  assert.match(
    migration,
    /revoke all on function public\.conviction_tier_identity_health\(\) from public, anon, authenticated/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.conviction_tier_identity_health\(\) to service_role/i,
  );
  assert.match(doctorSource, /rpc\("conviction_tier_identity_health"\)/i);
  assert.match(doctorSource, /mode_scoped_unique !== true/i);
  assert.match(migration, /'shadowed'[\s\S]*'uncertain'/i);
  assert.match(
    migration,
    /conviction_tier_buy_amounts_usd[\s\S]*<= conviction_max_position_per_token_usd/i,
  );
  assert.match(migration, /our_current_position_usd numeric not null default 0/i);
  assert.doesNotMatch(migration, /current_exposure_usd/i);
  assert.match(
    migration,
    /cardinality\(additional_target_wallets\) >= 2[\s\S]*additional_target_wallets\[1\] <> additional_target_wallets\[2\][\s\S]*target_wallet <> additional_target_wallets\[1\][\s\S]*target_wallet <> additional_target_wallets\[2\]/i,
  );
  assert.match(migration, /bot_config_conviction_wallets_v2_check/i);
  assert.match(migration, /coalesce\(cardinality\(additional_target_wallets\), 0\) >= 2/i);
  assert.match(
    migration,
    /coalesce\(nullif\(btrim\(additional_target_wallets\[1\]\), ''\), ''\) <> ''/i,
  );
  assert.match(migration, /bot_config_conviction_wallets_v3_check/i);
  assert.match(migration, /coalesce\(cardinality\(additional_target_wallets\), 0\) = 2/i);
  assert.match(
    migration,
    /btrim\(additional_target_wallets\[1\]\) <> btrim\(additional_target_wallets\[2\]\)/i,
  );
  assert.match(migration, /btrim\(target_wallet\) <> btrim\(additional_target_wallets\[1\]\)/i);
  assert.match(dashboardSchemaSource, /configuredTargetCount !== 3/i);
  assert.match(doctorSource, /cfg\.conviction_mode_enabled && targetCount !== 3/i);
  assert.match(workerDbSource, /additional_target_wallets\?: string\[\]/i);
  assert.match(migration, /grant select on public\.conviction_events[\s\S]*to authenticated/i);
  assert.match(
    migration,
    /grant select, insert, update on public\.conviction_events[\s\S]*to service_role/i,
  );
  for (const policy of [
    "read own conviction events",
    "read own conviction state",
    "read own conviction ranks",
    "read own conviction transitions",
    "read own conviction tiers",
  ]) {
    assert.match(migration, new RegExp(`create policy "${policy}"`, "i"));
  }
});

test("canonical schema contains the exact Conviction Mode migration", () => {
  const marker = "-- Conviction Mode schema (kept in sync with conviction-mode-migration.sql).";
  const nextMarker = "-- Strategy Lab schema (kept in sync with strategy-lab-migration.sql).";
  const start = schema.indexOf(marker);
  const end = schema.indexOf(nextMarker, start);
  assert.notEqual(start, -1, "Conviction Mode schema marker is missing");
  assert.notEqual(end, -1, "Conviction Mode schema end marker is missing");
  assert.equal(schema.slice(start + marker.length, end).trim(), migration.trim());
});

test("Conviction config columns stay synchronized across migration, worker, and dashboard", () => {
  const columns = Array.from(
    migration.matchAll(/add column if not exists (conviction_[a-z0-9_]+)/gi),
    (match) => match[1],
  );
  assert.equal(new Set(columns).size, 36, "expected the complete unique Conviction config set");

  for (const column of columns) {
    const camel = column.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
    assert.match(
      workerDbSource,
      new RegExp(`\\b${column}\\?\\s*:`),
      `${column} missing in worker DB type`,
    );
    assert.match(
      doctorSource,
      new RegExp(`"${column}"`),
      `${column} missing in doctor schema gate`,
    );
    assert.match(
      dashboardTypesSource,
      new RegExp(`\\b${column}\\s*:`),
      `${column} missing in dashboard DB type`,
    );
    assert.match(
      dashboardConfigSource,
      new RegExp(`\\b${camel}\\s*:`),
      `${camel} missing in dashboard config/defaults`,
    );
    assert.match(
      dashboardSchemaSource,
      new RegExp(`\\b${camel}\\s*:`),
      `${camel} missing in save validator`,
    );
    assert.match(
      dashboardMappingSource,
      new RegExp(`\\b${column}\\s*:`),
      `${column} missing in dashboard persistence mapping`,
    );
  }
});
