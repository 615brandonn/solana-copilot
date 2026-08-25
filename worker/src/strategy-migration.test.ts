import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const migrationPath = fileURLToPath(
  new URL("../../supabase/strategy-lab-migration.sql", import.meta.url),
);
const sql = readFileSync(migrationPath, "utf8");
const schema = readFileSync(
  fileURLToPath(new URL("../../supabase/schema.sql", import.meta.url)),
  "utf8",
);

test("Strategy Lab migration is additive and contains no data deletion", () => {
  assert.doesNotMatch(sql, /\bdelete\s+from\b/i);
  assert.doesNotMatch(sql, /\btruncate\b/i);
  assert.doesNotMatch(sql, /\bdrop\s+(table|column|schema)\b/i);
  assert.match(sql, /create table if not exists public\.strategy_observations/i);
  assert.match(sql, /create or replace function public\.record_strategy_observations/i);
  assert.match(sql, /create or replace function public\.strategy_insights/i);
});

test("Strategy Lab schema is replay-safe and matches the worker contract", () => {
  assert.match(sql, /unique \(user_id, event_key\)/i);
  assert.match(sql, /on conflict \(user_id, event_key\) do update/i);
  assert.match(sql, /metadata jsonb not null default '\{\}'::jsonb/i);
  assert.match(sql, /source text not null default 'unknown'/i);
  assert.match(sql, /position_id uuid references public\.positions\(id\) on delete set null/i);
  assert.match(sql, /existing\.bot_decision in \('copied','mirrored'\)/i);
  assert.match(sql, /reaction_ms = case/i);
  assert.match(sql, /execution_ms = case/i);
});

test("canonical schema includes the Strategy Lab table and RPCs", () => {
  assert.match(schema, /create table if not exists public\.strategy_observations/i);
  assert.match(schema, /create or replace function public\.record_strategy_observations/i);
  assert.match(schema, /create or replace function public\.strategy_insights/i);
  const marker = "-- Strategy Lab schema (kept in sync with strategy-lab-migration.sql).";
  const sellCoverageMarker =
    "-- Sell coverage schema (kept in sync with sell-coverage-migration.sql).";
  const resumeMarker = "revoke all on function public.record_strategy_observations(jsonb)";
  const nextCanonicalMarker = "-- CUSTODY_BACKLOG_V2_CANONICAL_MIRROR_BEGIN";
  const strategyStart = schema.indexOf(marker);
  const sellCoverageStart = schema.indexOf(sellCoverageMarker, strategyStart);
  const strategyResume = schema.indexOf(resumeMarker, sellCoverageStart);
  const strategyEnd = schema.indexOf(nextCanonicalMarker, strategyResume);

  assert.notEqual(strategyStart, -1, "Strategy Lab schema marker is missing");
  assert.notEqual(sellCoverageStart, -1, "sell-coverage schema marker is missing");
  assert.notEqual(strategyResume, -1, "Strategy Lab schema resume marker is missing");
  assert.notEqual(strategyEnd, -1, "next canonical schema marker is missing");

  const canonicalBlock = [
    schema.slice(strategyStart + marker.length, sellCoverageStart).trim(),
    schema.slice(strategyResume, strategyEnd).trim(),
  ].join("\n\n");
  const migrationBlock = sql.slice(sql.indexOf("create table")).trim();
  assert.equal(canonicalBlock, migrationBlock);
});
