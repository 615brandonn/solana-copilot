import assert from "node:assert/strict";
import test from "node:test";

import {
  coordinatedCreationFinalityIsPending,
  coordinatedClusterHasNoInterveningTargetSell,
  coordinatedEntryAuthorizationIsCurrent,
  coordinatedFinalityRetryDelayMs,
  type CoordinatedEntryAuthorization,
  type CoordinatedEntryRuntimeFence,
} from "./coordinated-entry-authorization.js";

const NOW = Date.UTC(2026, 7, 30, 12, 0, 0);
const authorization: CoordinatedEntryAuthorization = {
  expiresAtMs: NOW + 60_000,
  marketDataExpiresAtMs: NOW + 15_000,
  targetScopeFingerprint: "wallet-a|wallet-b|wallet-c",
  configFingerprint: "config-v1",
  sellRevision: 7,
  finalizedBuySignatures: ["sig-a", "sig-b", "sig-c"],
};
const runtime: CoordinatedEntryRuntimeFence = {
  nowMs: NOW,
  entriesEnabled: true,
  configTransitioning: false,
  entryStrategy: "coordinated",
  targetScopeFingerprint: authorization.targetScopeFingerprint,
  configFingerprint: authorization.configFingerprint,
  sellRevision: authorization.sellRevision,
};

test("exact coordinated authorization remains current only inside every fence", () => {
  assert.equal(coordinatedEntryAuthorizationIsCurrent(authorization, runtime), true);

  const changes: Array<Partial<CoordinatedEntryRuntimeFence>> = [
    { nowMs: authorization.expiresAtMs },
    { nowMs: authorization.marketDataExpiresAtMs },
    { entriesEnabled: false },
    { configTransitioning: true },
    { entryStrategy: "regular" },
    { targetScopeFingerprint: "wallet-a|wallet-b|other" },
    { configFingerprint: "config-v2" },
    { sellRevision: authorization.sellRevision + 1 },
  ];
  for (const change of changes) {
    assert.equal(
      coordinatedEntryAuthorizationIsCurrent(authorization, { ...runtime, ...change }),
      false,
      JSON.stringify(change),
    );
  }
});

test("sell chronology rejects reordered, same-slot, and intervening target dumps", () => {
  const buys = [100, 110, 120];
  assert.equal(coordinatedClusterHasNoInterveningTargetSell(buys, 0), true);
  assert.equal(coordinatedClusterHasNoInterveningTargetSell(buys, 99), true);
  assert.equal(coordinatedClusterHasNoInterveningTargetSell(buys, 100), false);
  assert.equal(coordinatedClusterHasNoInterveningTargetSell(buys, 115), false);
  assert.equal(coordinatedClusterHasNoInterveningTargetSell(buys, 130), false);
  assert.equal(coordinatedClusterHasNoInterveningTargetSell([], 0), false);
  assert.equal(coordinatedClusterHasNoInterveningTargetSell([0, 1], 0), false);
});

test("invalid clocks and equality at either deadline fail closed", () => {
  for (const nowMs of [0, Number.NaN, NOW + 15_000, NOW + 60_000]) {
    assert.equal(
      coordinatedEntryAuthorizationIsCurrent(authorization, { ...runtime, nowMs }),
      false,
    );
  }
});

test("normal processed-to-finalized lag gets a bounded independent retry schedule", () => {
  assert.equal(
    coordinatedCreationFinalityIsPending({
      code: "finalized_head_unavailable",
      retryable: true,
    }),
    true,
  );
  assert.equal(
    coordinatedCreationFinalityIsPending({
      code: "finalized_event_unavailable",
      retryable: true,
    }),
    true,
  );
  assert.equal(coordinatedFinalityRetryDelayMs(0), 12_000);
  assert.equal(coordinatedFinalityRetryDelayMs(1), 15_000);
  assert.equal(coordinatedFinalityRetryDelayMs(2), 15_000);
  assert.equal(coordinatedFinalityRetryDelayMs(3), null);
  assert.equal(
    coordinatedCreationFinalityIsPending({
      code: "finalized_event_conflict",
      retryable: false,
    }),
    false,
  );
});
