import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const migration = readFileSync(root("supabase/revival-hydration-index-migration.sql"), "utf8");
const schema = readFileSync(root("supabase/schema.sql"), "utf8");
const store = readFileSync(root("worker/src/revival-supabase-store.ts"), "utf8");

test("Revival hydration index is additive and matches the keyset access path", () => {
  assert.doesNotMatch(migration, /\b(?:drop|delete|truncate|update|insert)\b/i);
  assert.match(
    migration,
    /create index if not exists revival_events_hydration_idx\s+on public\.revival_events \(user_id, strategy_version_id, id\)/i,
  );
  assert.match(
    migration,
    /create index if not exists revival_events_projection_repair_idx\s+on public\.revival_events \(user_id, strategy_version_id, id\)\s+where campaign_id is null/i,
  );
});

test("Revival hydration resolves engine versions then scans by an advancing UUID key", () => {
  const start = store.indexOf("async loadEvents(tokenMint?: string)");
  const end = store.indexOf("async loadProjectionRepairMints()", start);
  assert.ok(start >= 0 && end > start, "loadEvents source section must exist");
  const source = store.slice(start, end);

  assert.match(source, /from\("revival_strategy_versions"\)[\s\S]*algorithm_version/i);
  assert.match(source, /eq\("strategy_version_id", strategyVersionId\)/);
  assert.match(source, /order\("id", \{ ascending: true \}\)/);
  assert.match(source, /query\.gt\("id", lastId\)/);
  assert.match(source, /output\.sort\(compareRevivalEventOrder\)/);
  assert.doesNotMatch(source, /\.range\(/, "OFFSET pagination must not return");
  assert.doesNotMatch(source, /!inner/, "the event scan must not use the slow hydration join");
});

test("Revival projection repair uses the same bounded keyset strategy", () => {
  const start = store.indexOf("async loadProjectionRepairMints()");
  const end = store.indexOf("async saveProjection", start);
  assert.ok(start >= 0 && end > start, "repair source section must exist");
  const source = store.slice(start, end);

  assert.match(source, /eq\("strategy_version_id", strategyVersionId\)/);
  assert.match(source, /is\("campaign_id", null\)/);
  assert.match(source, /order\("id", \{ ascending: true \}\)/);
  assert.match(source, /query\.gt\("id", lastId\)/);
  assert.doesNotMatch(source, /\.range\(/);
  assert.doesNotMatch(source, /!inner/);
});

test("canonical schema embeds the Revival hydration migration byte-for-byte", () => {
  const begin = "-- REVIVAL_HYDRATION_INDEX_CANONICAL_MIRROR_BEGIN";
  const end = "-- REVIVAL_HYDRATION_INDEX_CANONICAL_MIRROR_END";
  const beginIndex = schema.indexOf(begin);
  const endIndex = schema.indexOf(end);
  assert.ok(beginIndex >= 0 && endIndex > beginIndex);
  assert.equal(schema.indexOf(begin, beginIndex + begin.length), -1);
  assert.equal(schema.indexOf(end, endIndex + end.length), -1);
  assert.equal(schema.slice(beginIndex + begin.length, endIndex).trim(), migration.trim());
});
