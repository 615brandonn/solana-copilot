import assert from "node:assert/strict";
import test from "node:test";

import { evaluateEntryMonitoringGate } from "./entry-monitoring-gate.js";
import {
  FollowerBalanceReconciler,
  followerBalanceKey,
  followerBalanceShortfall,
  groupActiveFollowerBalances,
  type ActiveFollowerBalance,
  type FollowerBalanceAlertObservation,
  type FollowerBalanceStore,
} from "./follower-balance-reconciler.js";

test("groups the same wallet and mint before comparing with its real token balance", () => {
  assert.deepEqual(
    groupActiveFollowerBalances([
      { wallet: "wallet", tokenMint: "mint", currentAmount: 40, positionId: "a", decimals: 6 },
      { wallet: "wallet", tokenMint: "mint", currentAmount: 60, positionId: "b", decimals: 6 },
      { wallet: "wallet", tokenMint: "other", currentAmount: 5, positionId: "c", decimals: 9 },
    ]),
    [
      {
        wallet: "wallet",
        tokenMint: "mint",
        expectedAmount: 100,
        activePositionCount: 2,
        decimals: 6,
      },
      {
        wallet: "wallet",
        tokenMint: "other",
        expectedAmount: 5,
        activePositionCount: 1,
        decimals: 9,
      },
    ],
  );
});

test("only a material on-chain shortfall is a mismatch", () => {
  assert.equal(followerBalanceShortfall(100, 100, 6), 0);
  assert.equal(followerBalanceShortfall(100, 101, 6), 0);
  assert.equal(followerBalanceShortfall(100, 99.999999, 6), 0);
  assert.ok(followerBalanceShortfall(100, 90, 6) > 9.99);
});

function fakeStore(active: ActiveFollowerBalance[]) {
  const alerts = new Map<
    string,
    { observation: FollowerBalanceAlertObservation; occurrenceCount: number; confirmed: boolean }
  >();
  const resolved: string[] = [];
  const store: FollowerBalanceStore = {
    async loadActiveBalances() {
      return active;
    },
    async loadOpenAlertKeys() {
      return new Set(alerts.keys());
    },
    async recordMismatch(_userId, observation) {
      const key = followerBalanceKey(observation.wallet, observation.tokenMint);
      const existing = alerts.get(key);
      const sameOrLower =
        !existing ||
        observation.observedAmount <=
          existing.observation.observedAmount + observation.comparisonTolerance;
      const occurrenceCount = existing && sameOrLower ? existing.occurrenceCount + 1 : 1;
      alerts.set(key, {
        observation,
        occurrenceCount,
        confirmed: Boolean(existing?.confirmed) || occurrenceCount >= 2,
      });
    },
    async resolveMatch(_userId, balance) {
      const key = followerBalanceKey(balance.wallet, balance.tokenMint);
      alerts.delete(key);
      resolved.push(key);
    },
    async resolveInactive(_userId, activeKeys) {
      for (const key of alerts.keys()) {
        if (!activeKeys.has(key)) alerts.delete(key);
      }
    },
    async countConfirmed() {
      return Array.from(alerts.values()).filter((alert) => alert.confirmed).length;
    },
    async countCandidates() {
      return Array.from(alerts.values()).filter((alert) => !alert.confirmed).length;
    },
  };
  return { store, alerts, resolved };
}

test("requires two stable shortfall observations before blocking new entries", async () => {
  const active = [
    {
      wallet: "wallet",
      tokenMint: "mint",
      expectedAmount: 100,
      activePositionCount: 1,
      decimals: 6,
    },
  ];
  const state = fakeStore(active);
  const reconciler = new FollowerBalanceReconciler("user", state.store, {
    async read() {
      return { amount: 25, decimals: 6 };
    },
  });

  const firstHealth = await reconciler.run();
  assert.equal(
    active[0].expectedAmount,
    100,
    "reconciliation must never rewrite follower accounting",
  );
  assert.equal(firstHealth.mismatchCount, 0, "one lagging confirmed-RPC snapshot is not blocking");
  assert.equal(firstHealth.candidateMismatchCount, 1);
  const health = await reconciler.run();
  assert.equal(health.mismatchCount, 1, "the same shortfall twice becomes blocking");
  assert.equal(health.degraded, false);
  assert.equal(
    evaluateEntryMonitoringGate({
      geyserConnected: true,
      rpcLastSuccessAt: Date.now(),
      rpcBacklogWalletCount: 0,
      followerBalances: health,
    }).blocked,
    true,
  );
});

test("resolves an existing alert after the on-chain balance recovers", async () => {
  const active = [
    {
      wallet: "wallet",
      tokenMint: "mint",
      expectedAmount: 100,
      activePositionCount: 1,
      decimals: 6,
    },
  ];
  const state = fakeStore(active);
  const existingObservation = {
    ...active[0],
    observedAmount: 20,
    shortfallAmount: 80,
    comparisonTolerance: 0.000001,
    checkedAt: new Date().toISOString(),
  };
  state.alerts.set(followerBalanceKey("wallet", "mint"), {
    observation: existingObservation,
    occurrenceCount: 2,
    confirmed: true,
  });
  const reconciler = new FollowerBalanceReconciler("user", state.store, {
    async read() {
      return { amount: 100, decimals: 6 };
    },
  });
  const health = await reconciler.run();
  assert.equal(health.mismatchCount, 0);
  assert.equal(state.alerts.size, 0);
  assert.deepEqual(state.resolved, [followerBalanceKey("wallet", "mint")]);
});

test("does not write a no-op resolution for a healthy wallet with no alert", async () => {
  const active = [
    {
      wallet: "wallet",
      tokenMint: "mint",
      expectedAmount: 100,
      activePositionCount: 1,
      decimals: 6,
    },
  ];
  const state = fakeStore(active);
  const reconciler = new FollowerBalanceReconciler("user", state.store, {
    async read() {
      return { amount: 100, decimals: 6 };
    },
  });
  await reconciler.run();
  assert.deepEqual(state.resolved, []);
});

test("a materially rising observed balance resets shortfall confirmation", async () => {
  const active = [
    {
      wallet: "wallet",
      tokenMint: "mint",
      expectedAmount: 100,
      activePositionCount: 1,
      decimals: 6,
    },
  ];
  const state = fakeStore(active);
  const observed = [10, 50, 50];
  const reconciler = new FollowerBalanceReconciler("user", state.store, {
    async read() {
      return { amount: observed.shift() ?? 50, decimals: 6 };
    },
  });
  assert.equal((await reconciler.run()).mismatchCount, 0);
  assert.equal(
    (await reconciler.run()).mismatchCount,
    0,
    "a rising balance looks like RPC catching up and starts confirmation over",
  );
  assert.equal((await reconciler.run()).mismatchCount, 1);
});

test("caps concurrent RPC balance reads and degrades safely on a failed read", async () => {
  const active = Array.from({ length: 12 }, (_, index) => ({
    wallet: `wallet-${index}`,
    tokenMint: "mint",
    expectedAmount: 1,
    activePositionCount: 1,
    decimals: 6,
  }));
  const state = fakeStore(active);
  let inFlight = 0;
  let maximum = 0;
  const reconciler = new FollowerBalanceReconciler(
    "user",
    state.store,
    {
      async read(wallet) {
        inFlight += 1;
        maximum = Math.max(maximum, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
        if (wallet === "wallet-4") throw new Error("temporary RPC failure");
        return { amount: 1, decimals: 6 };
      },
    },
    3,
  );
  const health = await reconciler.run();
  assert.equal(maximum, 3);
  assert.equal(health.checkedBalanceCount, 11);
  assert.equal(health.degraded, true);
  assert.match(health.lastError ?? "", /no failed lookup was treated as a sale/i);
});

test("gate blocks backlog and stale reconciliation but stays open when every monitor is healthy", () => {
  const now = Date.now();
  const healthy = {
    hasCompleted: true,
    lastCheckedAt: now,
    lastSuccessfulAt: now,
    checkedBalanceCount: 1,
    candidateMismatchCount: 0,
    mismatchCount: 0,
    degraded: false,
    lastError: null,
  };
  assert.equal(
    evaluateEntryMonitoringGate(
      {
        geyserConnected: true,
        rpcLastSuccessAt: null,
        rpcBacklogWalletCount: 0,
        followerBalances: healthy,
      },
      now,
    ).blocked,
    false,
  );
  assert.equal(
    evaluateEntryMonitoringGate(
      {
        geyserConnected: true,
        rpcLastSuccessAt: now,
        rpcBacklogWalletCount: 1,
        followerBalances: healthy,
      },
      now,
    ).blocked,
    true,
  );
  assert.equal(
    evaluateEntryMonitoringGate(
      {
        geyserConnected: true,
        rpcLastSuccessAt: now,
        rpcBacklogWalletCount: 0,
        followerBalances: { ...healthy, lastCheckedAt: now - 121_000 },
      },
      now,
    ).blocked,
    true,
  );
});
