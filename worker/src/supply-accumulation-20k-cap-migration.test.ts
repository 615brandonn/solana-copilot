import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const migration = readFileSync(root("supabase/supply-accumulation-20k-cap-migration.sql"), "utf8");
const entryMigration = readFileSync(
  root("supabase/supply-accumulation-entry-migration.sql"),
  "utf8",
);
const scaleMigration = readFileSync(
  root("supabase/supply-accumulation-scale-buys-migration.sql"),
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

test("20k migration is transactional, rerunnable, and never changes live strategy state", () => {
  assert.match(migration, /^begin;/im);
  assert.match(migration, /^commit;/im);
  assert.doesNotMatch(migration, /\bdelete\s+from\b/i);
  assert.doesNotMatch(migration, /\btruncate\b/i);
  assert.doesNotMatch(migration, /\bdrop\s+(table|column|schema)\b/i);
  assert.doesNotMatch(migration, /update\s+public\.bot_config/i);
  assert.doesNotMatch(migration, /supply_accumulation_mode_enabled\s*=\s*true/i);
  assert.doesNotMatch(migration, /\benabled\s*=\s*true/i);
  assert.match(migration, /alter column supply_accumulation_max_market_cap_usd set default 20000/i);
  for (const constraint of [
    "bot_config_supply_accumulation_values_check",
    "bot_config_supply_accumulation_market_cap_range_check",
    "supply_accumulation_state_max_market_cap_usd_check",
    "supply_accumulation_state_market_cap_range_check",
  ]) {
    assert.match(migration, new RegExp(`drop constraint if exists ${constraint}`, "i"));
    assert.match(migration, new RegExp(`add constraint ${constraint} check`, "i"));
  }
  assert.doesNotMatch(migration, /alter table public\.(positions|trades|sell_signal_claims)/i);
});

test("all four deployed database routines move to the same strict 20k contract", () => {
  for (const signature of [
    "get_supply_accumulation_state_without_floor_v1\\(",
    "get_supply_accumulation_state\\(",
    "materialize_supply_accumulation_market_cap_range\\(\\)",
    "get_supply_accumulation_scale_plan\\(",
  ]) {
    assert.match(migration, new RegExp(`create or replace function public\\.${signature}`, "i"));
  }
  assert.equal(migration.match(/security definer/gi)?.length, 4);
  assert.equal(migration.match(/set search_path = pg_catalog, public, pg_temp/gi)?.length, 4);
  assert.equal(migration.match(/coalesce\(auth\.role\(\), ''\) <> 'service_role'/gi)?.length, 3);
  assert.doesNotMatch(migration, /(?:default|:=|<=|>)\s*15000/i);
  assert.match(migration, /supply_accumulation_max_market_cap_usd <= 20000/i);
  assert.match(migration, /max_market_cap_usd <= 20000/i);
  assert.match(migration, /v_latest_market_cap_usd < v_max_market_cap_usd/i);
  assert.match(
    migration,
    /v_state\.latest_market_cap_usd >= v_config\.supply_accumulation_max_market_cap_usd/i,
  );
  assert.match(migration, /not v_event\.is_pump_fun/i);
  assert.match(migration, /v_pump_fun_verified boolean := false/i);
});

test("routine replacements preserve the reviewed v1, v2, trigger, and scale-plan bodies", () => {
  const expectedV1 = between(
    entryMigration,
    "create or replace function public.get_supply_accumulation_state(",
    "create or replace function public.record_supply_accumulation_event(",
  )
    .replace(
      "create or replace function public.get_supply_accumulation_state(",
      "create or replace function public.get_supply_accumulation_state_without_floor_v1(",
    )
    .replace(/15000/g, "20000");
  const actualV1 = between(
    migration,
    "create or replace function public.get_supply_accumulation_state_without_floor_v1(",
    "-- Keep the state trigger, v2 floor wrapper, and durable scale planner",
  );
  assert.equal(actualV1, expectedV1);

  const expectedTrigger = between(
    scaleMigration,
    "create or replace function public.materialize_supply_accumulation_market_cap_range()",
    "drop trigger if exists materialize_supply_accumulation_market_cap_range_trigger",
  ).replace(/15000/g, "20000");
  const actualTrigger = between(
    migration,
    "create or replace function public.materialize_supply_accumulation_market_cap_range()",
    "create or replace function public.get_supply_accumulation_state(",
  );
  assert.equal(actualTrigger, expectedTrigger);

  const expectedWrapper = between(
    scaleMigration,
    "create or replace function public.get_supply_accumulation_state(",
    "create table if not exists public.supply_accumulation_scale_claims",
  ).replace(/15000/g, "20000");
  const actualWrapper = between(
    migration,
    "create or replace function public.get_supply_accumulation_state(",
    "create or replace function public.get_supply_accumulation_scale_plan(",
  );
  assert.equal(actualWrapper, expectedWrapper);

  const expectedPlan = between(
    scaleMigration,
    "create or replace function public.get_supply_accumulation_scale_plan(",
    "create or replace function public.apply_supply_accumulation_scale_buy(",
  ).replace(/15000/g, "20000");
  const actualPlan = between(
    migration,
    "create or replace function public.get_supply_accumulation_scale_plan(",
    "-- CREATE OR REPLACE preserves ownership",
  );
  assert.equal(actualPlan, expectedPlan);
});

test("routine permissions remain service-only and RLS is not weakened", () => {
  for (const fn of [
    "get_supply_accumulation_state_without_floor_v1",
    "get_supply_accumulation_state",
    "get_supply_accumulation_scale_plan",
  ]) {
    assert.match(
      migration,
      new RegExp(`revoke all on function public\\.${fn}\\([\\s\\S]*?authenticated`, "i"),
    );
    assert.match(
      migration,
      new RegExp(`grant execute on function public\\.${fn}\\([\\s\\S]*?service_role`, "i"),
    );
  }
  assert.match(
    migration,
    /revoke all on function public\.materialize_supply_accumulation_market_cap_range\(\)[\s\S]*?authenticated/i,
  );
  assert.doesNotMatch(migration, /disable row level security/i);
  assert.doesNotMatch(migration, /grant (?:insert|update|delete)[^;]*authenticated/i);
});

test("canonical schema embeds the 20k compatibility migration byte-for-byte", () => {
  const begin = "-- SUPPLY_ACCUMULATION_20K_CAP_CANONICAL_MIRROR_BEGIN";
  const end = "-- SUPPLY_ACCUMULATION_20K_CAP_CANONICAL_MIRROR_END";
  const beginIndex = schema.indexOf(begin);
  const endIndex = schema.indexOf(end);
  assert.ok(beginIndex >= 0, "canonical mirror begin marker is missing");
  assert.ok(endIndex > beginIndex, "canonical mirror end marker is missing");
  assert.equal(schema.slice(beginIndex + begin.length, endIndex).trim(), migration.trim());
});
