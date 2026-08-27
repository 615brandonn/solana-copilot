import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateEntryMonitoringGate,
  evaluateFreshTailEntryMonitoringGate,
} from "./entry-monitoring-gate.js";

const healthyFollowerState = (nowMs: number) => ({
  hasCompleted: true,
  lastCheckedAt: nowMs,
  lastSuccessfulAt: nowMs,
  checkedBalanceCount: 1,
  candidateMismatchCount: 0,
  mismatchCount: 0,
  degraded: false,
  lastError: null,
});

test("fresh-tail bypasses only legacy backlog and follower-balance prerequisites", () => {
  const nowMs = 2_000_000;
  const legacy = evaluateEntryMonitoringGate(
    {
      geyserConnected: true,
      rpcLastSuccessAt: nowMs,
      rpcBacklogWalletCount: 51,
      followerBalances: {
        ...healthyFollowerState(nowMs),
        mismatchCount: 3,
        degraded: true,
      },
    },
    nowMs,
  );
  assert.equal(legacy.blocked, true);
  assert.match(legacy.reasons.join("; "), /backlogged/);
  assert.match(legacy.reasons.join("; "), /mismatch/);

  const fresh = evaluateFreshTailEntryMonitoringGate(
    { geyserConnected: true, rpcLastSuccessAt: nowMs },
    nowMs,
  );
  assert.deepEqual(fresh, { blocked: false, reasons: [] });
});

test("fresh-tail keeps the shared live-monitor availability breaker", () => {
  const nowMs = 2_000_000;
  assert.equal(
    evaluateFreshTailEntryMonitoringGate(
      { geyserConnected: false, rpcLastSuccessAt: nowMs - 60_001 },
      nowMs,
    ).blocked,
    true,
  );
  assert.equal(
    evaluateFreshTailEntryMonitoringGate(
      { geyserConnected: false, rpcLastSuccessAt: nowMs - 60_000 },
      nowMs,
    ).blocked,
    false,
  );
});
