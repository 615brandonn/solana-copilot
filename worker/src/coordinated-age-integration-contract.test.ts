import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("coordinated Pump age binds every contributing buy to finalized creation evidence", () => {
  assert.match(
    source,
    /requiredFinalizedEvents:\s*coordination\.observations\.map\([\s\S]*?slot:\s*observation\.slot,[\s\S]*?txSig:\s*observation\.txSig/,
  );
  assert.match(source, /tokenCreatedAtMs:\s*resolution\.proof\.blockTimeMs/);
  assert.match(source, /tokenAgeEvaluatedAtMs:\s*resolution\.evaluatedAtBlockTimeMs/);
  assert.match(source, /tokenAgeSource:\s*"pump_finalized_create"/);
  assert.doesNotMatch(
    source,
    /tokenAgeSource:\s*"pump_finalized_create"[\s\S]{0,200}pairCreatedAtMs/,
  );
});

test("deferred coordinated buys are fenced by sells, config, deadlines, and current metadata", () => {
  assert.match(source, /const coordinatedEntryBackground = new BoundedBackgroundQueue\(8, 256\)/);
  assert.match(source, /scheduleCoordinatedEvaluation\(event, coordination, false\)/);
  assert.match(source, /observeCoordinatedTargetSell\(event\.tokenMint, event\.slot\)/);
  assert.match(source, /coordinatedBuys\.onTargetSell\(event\.tokenMint\)/);
  assert.match(
    source,
    /coordinatedClusterHasNoInterveningTargetSell\([\s\S]*?coordinatedSellStateFor\(event\.tokenMint\)\.highestSlot/,
  );
  assert.match(source, /cancelAllCoordinatedSignals\(\)/);
  assert.match(source, /marketDataExpiresAtMs:\s*marketDataObservedAtMs/);
  assert.match(source, /coordinatedAuthorizationCurrent\(\)/);
  assert.match(source, /coordinated-proof-revoked-after-claim/);
  assert.match(
    source,
    /beforeSubmit:\s*async \(\) => \{[\s\S]*?coordinatedAuthorizationCurrent\(\)/,
  );
});

test("processed target buys wait for finality on a separate bounded schedule", () => {
  assert.match(source, /const coordinatedFinalityWaits = new Map<string, number>\(\)/);
  assert.match(source, /coordinatedCreationFinalityIsPending\(resolution\)/);
  assert.match(source, /coordinatedFinalityRetryDelayMs\(completedWaits\)/);
  assert.match(source, /waiting for finalized coordinated buys/);
  assert.match(source, /coordinatedResolutionAttempts\.set\(event\.tokenMint, attempt\)/);
});

test("the reservation is consumed before generic copy execution becomes ambiguous", () => {
  const commit = source.indexOf("!coordinatedBuys.commit(coordination.reservationId, Date.now())");
  const execute = source.indexOf(
    "await tryCopyBuy(event, `coordinated ${coordination.observations.length}-wallet copy buy`",
  );
  assert.ok(commit >= 0, "coordinated reservation commit is missing");
  assert.ok(execute > commit, "generic copy execution must begin only after reservation commit");
});

test("curve pricing cannot manufacture coordinated token age", () => {
  const filters = readFileSync(new URL("../src/filters.ts", import.meta.url), "utf8");
  const fallback = filters.slice(
    filters.indexOf("export async function loadTokenMetaWithCurveFallback"),
  );
  assert.match(fallback, /marketCapUsd:\s*curve\.marketCapUsd/);
  assert.doesNotMatch(fallback, /tokenCreatedAtMs:\s*curve/);
  assert.doesNotMatch(fallback, /pairCreatedAtMs:\s*curve/);
  assert.match(source, /minContextSlot:\s*Number\(minContextSlot\)/);
  assert.match(source, /snapshot\.observedSlot < Number\(minContextSlot\)/);
});
