import assert from "node:assert/strict";
import test from "node:test";

import {
  KeyedExecutionQueue,
  RecentAsyncResultCache,
  RecentEventDeduper,
} from "./event-deduper.js";

test("deduplicates Geyser/RPC/fallback observations within the TTL", () => {
  const deduper = new RecentEventDeduper(1_000, 10);
  assert.equal(deduper.claim("wallet:signature:mint", 10_000), true);
  assert.equal(deduper.claim("wallet:signature:mint", 10_500), false);
  assert.equal(deduper.claim("wallet:other-signature:mint", 10_500), true);
  assert.equal(deduper.claim("wallet:signature:other-mint", 10_500), true);
  assert.equal(deduper.claim("wallet:signature:mint", 11_001), true);
});

test("a proven pre-submission failure can release an event for retry", () => {
  const deduper = new RecentEventDeduper();
  assert.equal(deduper.claim("event"), true);
  assert.equal(deduper.claim("event"), false);
  deduper.release("event");
  assert.equal(deduper.claim("event"), true);
});

test("shares target observation accounting across concurrent feed copies", async () => {
  const cache = new RecentAsyncResultCache<boolean>();
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const factory = async () => {
    calls += 1;
    await blocked;
    return true;
  };

  const first = cache.getOrCreate("wallet:signature:mint", factory);
  const duplicate = cache.getOrCreate("wallet:signature:mint", factory);
  release();
  assert.deepEqual(await Promise.all([first, duplicate]), [true, true]);
  assert.equal(calls, 1);
});

test("failed observation accounting can be retried", async () => {
  const cache = new RecentAsyncResultCache<boolean>();
  let calls = 0;
  await assert.rejects(
    cache.getOrCreate("event", async () => {
      calls += 1;
      throw new Error("database unavailable");
    }),
  );
  assert.equal(await cache.getOrCreate("event", async () => true), true);
  assert.equal(calls, 1);
});

test("a later accounting failure does not repeat an earlier completed side effect", async () => {
  const activity = new RecentAsyncResultCache<void>();
  const firstBuy = new RecentAsyncResultCache<boolean>();
  let activityCalls = 0;
  let firstBuyCalls = 0;
  const observe = async () => {
    await activity.getOrCreate("event", async () => {
      activityCalls += 1;
    });
    return firstBuy.getOrCreate("event", async () => {
      firstBuyCalls += 1;
      if (firstBuyCalls === 1) throw new Error("first-buy store unavailable");
      return true;
    });
  };

  await assert.rejects(observe());
  assert.equal(await observe(), true);
  assert.equal(activityCalls, 1);
  assert.equal(firstBuyCalls, 2);
});

test("per-mint execution queue preserves a distinct concurrent second entry", async () => {
  const queue = new KeyedExecutionQueue();
  const calls: string[] = [];
  let release!: () => void;
  let markFirstStarted!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const first = queue.run("mint", async () => {
    calls.push("first-start");
    markFirstStarted();
    await blocked;
    calls.push("first-end");
    return "landed";
  });
  const second = queue.run("mint", async () => {
    calls.push("second-start");
    return "checked";
  });
  await firstStarted;
  assert.deepEqual(calls, ["first-start"]);
  release();
  assert.deepEqual(await Promise.all([first, second]), ["landed", "checked"]);
  assert.deepEqual(calls, ["first-start", "first-end", "second-start"]);
});

test("per-mint execution queue allows different mints concurrently", async () => {
  const queue = new KeyedExecutionQueue();
  let firstStarted = false;
  let secondStarted = false;
  let markFirstStarted!: () => void;
  let markSecondStarted!: () => void;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bothStarted = Promise.all([
    new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    }),
    new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    }),
  ]);
  const first = queue.run("mint-a", async () => {
    firstStarted = true;
    markFirstStarted();
    await blocked;
  });
  const second = queue.run("mint-b", async () => {
    secondStarted = true;
    markSecondStarted();
  });
  await bothStarted;
  assert.equal(firstStarted, true);
  assert.equal(secondStarted, true);
  release();
  await Promise.all([first, second]);
});
