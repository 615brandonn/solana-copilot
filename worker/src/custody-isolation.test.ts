import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CUSTODY_MODULES = [
  "custody-index.ts",
  "custody-runtime.ts",
  "custody-store.ts",
  "custody-classifier.ts",
  "custody-watch-registry.ts",
  "custody-learning.ts",
];

test("the Custody Journey process has no trading execution or position-state dependency", () => {
  const forbidden = [
    /from ["']\.\/executor\.js["']/,
    /from ["']\.\/crypto\.js["']/,
    /from ["']\.\/monitor\.js["']/,
    /executeSwap\s*\(/,
    /funding_keys/,
    /sell_signal_claims/,
    /entry_signal_claims/,
    /\.from\(["']positions["']\)/,
    /\.from\(["']trades["']\)/,
  ];
  for (const file of CUSTODY_MODULES) {
    const source = readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${file} must remain observation-only`);
    }
  }
});

test("custody health is stored separately from the trading-worker heartbeat", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/custody-index.ts", import.meta.url)),
    "utf8",
  );
  assert.match(source, /\.from\(["']custody_worker_heartbeat["']\)/);
  assert.doesNotMatch(source, /\.from\(["']worker_heartbeat["']\)/);
  assert.doesNotMatch(source, /new GeyserFeed/);
  assert.match(
    source,
    /new Connection\(env\.RPC_URL, \{ commitment: "confirmed" \}\)/,
    "custody accounting must not persist the trading feed's processed fork state",
  );
});
