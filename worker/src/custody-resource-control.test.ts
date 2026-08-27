import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const custodyIndexSource = readFileSync(
  new URL("../src/custody-index.ts", import.meta.url),
  "utf8",
);
const custodyRuntimeSource = readFileSync(
  new URL("../src/custody-runtime.ts", import.meta.url),
  "utf8",
);

test("high-cardinality Custody maintenance stays off the hot path", () => {
  assert.match(custodyIndexSource, /const ACTIVE_WATCH_RECONCILE_INTERVAL_MS = 5 \* 60_000/);
  assert.match(custodyIndexSource, /}, ACTIVE_WATCH_RECONCILE_INTERVAL_MS\);/);
  assert.doesNotMatch(
    custodyIndexSource,
    /refreshCustodyWalletLearning/,
    "the all-ledger learning pass must not run inside the live observer",
  );
  assert.doesNotMatch(
    custodyIndexSource,
    /if \(appliedCount > 0\) await reconcileActiveWatches\(\)/,
    "incremental replay results must not trigger a full watch-table reload",
  );
});

test("routine Custody persistence is not serialized into production info logs", () => {
  const marker = '"custody journey observation persisted"';
  const markerAt = custodyRuntimeSource.indexOf(marker);
  assert.ok(markerAt > 0, "routine persistence log marker is missing");
  const nearbySource = custodyRuntimeSource.slice(Math.max(0, markerAt - 700), markerAt);
  assert.match(nearbySource, /log\.debug\(/);
  assert.doesNotMatch(nearbySource, /log\.info\(/);
});
