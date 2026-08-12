import assert from "node:assert/strict";
import test from "node:test";

import type { GeyserFeed } from "./geyser.js";
import { FollowerMonitor } from "./monitor.js";
import type { RpcBackfillPoller } from "./poller.js";

test("RPC follower coverage survives a Geyser registration failure and retry", async () => {
  const calls: string[] = [];
  let geyserAttempts = 0;
  const feed = {
    watch: async (_wallet: string) => {
      calls.push("geyser");
      geyserAttempts += 1;
      if (geyserAttempts === 1) {
        throw new Error("subscription failed with sb_secret_NEVER_EXPOSE");
      }
    },
  } as unknown as GeyserFeed;
  const poller = {
    watch: (_wallet: string, _options: { anchorSlot?: number }) => calls.push("rpc"),
  } as unknown as RpcBackfillPoller;
  const monitor = new FollowerMonitor(feed, poller);
  const retainFollower = (
    monitor as unknown as {
      retainFollower(positionId: string, wallet: string, anchorSlot?: number): Promise<void>;
    }
  ).retainFollower.bind(monitor);

  await assert.rejects(retainFollower("position-1", "wallet-1", 123), (error: unknown) => {
    assert.equal(String(error).includes("sb_secret_NEVER_EXPOSE"), false);
    return true;
  });
  assert.deepEqual(calls, ["rpc", "geyser"]);
  assert.equal(monitor.isFollowerRetained("wallet-1"), true);

  // The local ownership row already exists, but the exact same registration
  // path still retries both idempotent feeds instead of returning early.
  await retainFollower("position-1", "wallet-1", 123);
  assert.deepEqual(calls, ["rpc", "geyser", "rpc", "geyser"]);
});

test("one failed split-recipient Geyser watch cannot starve later RPC registrations", async () => {
  const calls: string[] = [];
  const feed = {
    watch: async (wallet: string) => {
      calls.push(`geyser:${wallet}`);
      if (wallet === "wallet-1") {
        throw new Error("subscription failed with sb_secret_NEVER_EXPOSE");
      }
    },
  } as unknown as GeyserFeed;
  const poller = {
    watch: (wallet: string) => calls.push(`rpc:${wallet}`),
  } as unknown as RpcBackfillPoller;
  const monitor = new FollowerMonitor(feed, poller);
  const retainFollowers = (
    monitor as unknown as {
      retainFollowers(
        registrations: Array<{ positionId: string; wallet: string; anchorSlot?: number }>,
      ): Promise<void>;
    }
  ).retainFollowers.bind(monitor);

  await assert.rejects(
    retainFollowers([
      { positionId: "position-1", wallet: "wallet-1", anchorSlot: 123 },
      { positionId: "position-1", wallet: "wallet-2", anchorSlot: 123 },
    ]),
    (error: unknown) => {
      assert.equal(String(error).includes("sb_secret_NEVER_EXPOSE"), false);
      return true;
    },
  );

  assert.deepEqual(calls, [
    "rpc:wallet-1",
    "rpc:wallet-2",
    "geyser:wallet-1",
    "geyser:wallet-2",
  ]);
  assert.equal(monitor.isFollowerRetained("wallet-1"), true);
  assert.equal(monitor.isFollowerRetained("wallet-2"), true);
});
