import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REVIVAL_MODULES = [
  "revival-index.ts",
  "revival-runtime.ts",
  "revival-supabase-store.ts",
  "revival-persistence.ts",
  "revival-market-data.ts",
  "revival-engine.ts",
  "revival-types.ts",
];

const source = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), "utf8");

test("Revival modules have no executor, key custody, claim, or trading-state dependency", () => {
  const forbidden = [
    /from ["']\.\/executor\.js["']/,
    /from ["']\.\/crypto\.js["']/,
    /from ["']\.\/monitor\.js["']/,
    /from ["']\.\/index\.js["']/,
    /executeSwap\s*\(/,
    /\.from\(["']funding_keys["']\)/,
    /\.from\(["']positions["']\)/,
    /\.from\(["']trades["']\)/,
    /\.from\(["']entry_signal_claims["']\)/,
    /\.from\(["']sell_signal_claims["']\)/,
  ];

  for (const file of REVIVAL_MODULES) {
    const moduleSource = source(file);
    for (const pattern of forbidden) {
      assert.doesNotMatch(moduleSource, pattern, `${file} must remain observation-only`);
    }
  }
});

test("Revival runs as a separate confirmed-RPC process with isolated cursor and heartbeat tables", () => {
  const entrypoint = source("revival-index.ts");
  const store = source("revival-supabase-store.ts");
  const tradingWorker = source("index.ts");

  assert.match(entrypoint, /new Connection\(env\.RPC_URL, \{ commitment: ["']confirmed["'] \}\)/);
  assert.match(entrypoint, /["']revival_rpc_wallet_cursors["']/);
  assert.match(store, /\.from\(["']revival_worker_heartbeat["']\)/);
  assert.doesNotMatch(entrypoint, /["']worker_heartbeat["']/);
  assert.doesNotMatch(
    tradingWorker,
    /from ["']\.\/revival-(?:index|runtime|engine|supabase-store)\.js["']/,
  );
});

test("every persisted Revival recommendation is structurally shadow-only", () => {
  const types = source("revival-types.ts");
  const engine = source("revival-engine.ts");

  assert.match(types, /executable: false/);
  assert.match(engine, /executable: false/);
  assert.doesNotMatch(types, /executable: true/);
  assert.doesNotMatch(engine, /executable: true/);
});

test("engine upgrades hydrate and watch only their own immutable projection generation", () => {
  const store = source("revival-supabase-store.ts");
  assert.ok(
    store.match(/\.eq\("algorithm_version", REVIVAL_ENGINE_VERSION\)/g)!.length >= 2,
    "hydration and repair must resolve only the current engine's strategy versions",
  );
  assert.ok(
    store.match(/\.eq\("strategy_version_id", strategyVersionId\)/g)!.length >= 2,
    "event scans must remain pinned to those immutable strategy versions",
  );
  assert.doesNotMatch(
    store,
    /strategy_version:revival_strategy_versions!inner\(algorithm_version\)/,
  );
  assert.ok(store.match(/\.eq\("engine_version", REVIVAL_ENGINE_VERSION\)/g)!.length >= 3);
});
