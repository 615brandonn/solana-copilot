import test from "node:test";
import assert from "node:assert/strict";
import { CustodyWatchRegistry } from "./custody-watch-registry.js";
import type { CustodyRecordResult } from "./custody-types.js";

function harness(options: { failWatch?: boolean } = {}) {
  const order: string[] = [];
  const rpcWatches = new Set<string>();
  const poller = {
    watch(wallet: string) {
      order.push(`rpc-watch:${wallet}`);
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
});
