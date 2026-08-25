import test from "node:test";
import assert from "node:assert/strict";
import { CustodyWatchRegistry } from "./custody-watch-registry.js";
import type { CustodyRecordResult } from "./custody-types.js";

function harness(options: { failWatch?: boolean } = {}) {
  const order: string[] = [];
  const watchCalls: Array<{ wallet: string; anchorSlot?: number }> = [];
  const rpcWatches = new Set<string>();
  const poller = {
    watch(wallet: string, watchOptions: { anchorSlot?: number } = {}) {
      order.push(`rpc-watch:${wallet}`);
      watchCalls.push({ wallet, anchorSlot: watchOptions.anchorSlot });
      rpcWatches.add(wallet);
    },
    unwatch(wallet: string) {
      order.push(`rpc-unwatch:${wallet}`);
      rpcWatches.delete(wallet);
    },
  };
  void options;
  return {
    order,
    watchCalls,
    rpcWatches,
    registry: new CustodyWatchRegistry(poller as never),
  };
}

function result(
  journeyId: string,
  watchedWallets: string[] = [],
  releasedWallets: string[] = [],
): CustodyRecordResult {
  return {
    applied: true,
    duplicate: false,
    payloadMismatch: false,
    reason: "recorded",
    journeyId,
    eventId: "event",
    journeyStatus: "active",
    appliedAmountTokens: 1,
    watchedWallets,
    releasedWallets,
    journeyReleased: false,
  };
}

test("confirmed RPC coverage is installed for each durable journey watch", async () => {
  const h = harness();
  await h.registry.apply(result("journey-a", ["wallet-a"]), 10);
  assert.deepEqual(h.order, ["rpc-watch:wallet-a"]);
  assert.equal(h.registry.isWatched("wallet-a"), true);
});

test("shared wallets are not unwatched until every journey owner releases them", async () => {
  const h = harness();
  await h.registry.apply(result("journey-a", ["shared"]), 10);
  await h.registry.apply(result("journey-b", ["shared"]), 20);
  await h.registry.apply(result("journey-a", [], ["shared"]), 30);
  assert.equal(h.registry.isWatched("shared"), true);
  assert.equal(h.rpcWatches.has("shared"), true);
  assert.equal(h.order.filter((entry) => entry === "rpc-unwatch:shared").length, 0);

  await h.registry.apply(result("journey-b", [], ["shared"]), 40);
  assert.equal(h.registry.isWatched("shared"), false);
  assert.equal(h.rpcWatches.has("shared"), false);
  assert.equal(h.order.filter((entry) => entry === "rpc-unwatch:shared").length, 1);
});

test("removing a target role preserves a journey role for the same wallet", async () => {
  const h = harness();
  await h.registry.setTargets(["shared"]);
  await h.registry.apply(result("journey-a", ["shared"]), 10);
  await h.registry.setTargets([]);
  assert.equal(h.registry.isWatched("shared"), true);
  assert.equal(h.rpcWatches.has("shared"), true);
  assert.deepEqual(h.watchCalls, [
    { wallet: "shared", anchorSlot: undefined },
    { wallet: "shared", anchorSlot: 10 },
  ]);
});

test("unchanged durable reconciliation does not churn the low-level watch", async () => {
  const h = harness();
  const row = {
    journeyId: "journey-a",
    wallet: "wallet-a",
    tokenMint: "mint-a",
    anchorSlot: 100,
  };

  await h.registry.reconcileJourneyWatches([row]);
  await h.registry.reconcileJourneyWatches([row]);
  await h.registry.reconcileJourneyWatches([{ ...row, anchorSlot: 120 }]);

  assert.deepEqual(h.watchCalls, [{ wallet: "wallet-a", anchorSlot: 100 }]);
});

test("reconciliation forwards only a genuinely earlier owner anchor", async () => {
  const h = harness();
  const base = {
    journeyId: "journey-a",
    wallet: "shared",
    tokenMint: "mint-a",
    anchorSlot: 100,
  };

  await h.registry.reconcileJourneyWatches([base]);
  await h.registry.reconcileJourneyWatches([
    base,
    { ...base, journeyId: "journey-b", tokenMint: "mint-b", anchorSlot: 150 },
  ]);
  await h.registry.reconcileJourneyWatches([
    base,
    { ...base, journeyId: "journey-b", tokenMint: "mint-b", anchorSlot: 150 },
    { ...base, journeyId: "journey-c", tokenMint: "mint-c", anchorSlot: 75 },
  ]);

  assert.deepEqual(h.watchCalls, [
    { wallet: "shared", anchorSlot: 100 },
    { wallet: "shared", anchorSlot: 75 },
  ]);
});

test("an existing owner can lower its anchor exactly once", async () => {
  const h = harness();
  await h.registry.apply(result("journey-a", ["wallet-a"]), 100);
  await h.registry.apply(result("journey-a", ["wallet-a"]), 125);
  await h.registry.apply(result("journey-a", ["wallet-a"]), 80);
  await h.registry.apply(result("journey-a", ["wallet-a"]), 80);

  assert.deepEqual(h.watchCalls, [
    { wallet: "wallet-a", anchorSlot: 100 },
    { wallet: "wallet-a", anchorSlot: 80 },
  ]);
});

test("an owner anchor change is a no-op when another owner already covers earlier history", async () => {
  const h = harness();
  await h.registry.apply(result("journey-a", ["shared"]), 50);
  await h.registry.apply(result("journey-b", ["shared"]), 100);
  await h.registry.apply(result("journey-b", ["shared"]), 75);

  assert.deepEqual(h.watchCalls, [{ wallet: "shared", anchorSlot: 50 }]);
});
