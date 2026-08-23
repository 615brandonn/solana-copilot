import assert from "node:assert/strict";
import test from "node:test";
import {
  RevivalConfigTransitionError,
  RevivalRuntime,
  revivalObserverHeartbeatError,
  transitionRevivalObserverConfig,
} from "./revival-runtime.js";
import type { RevivalProjectionChanges, RevivalStore } from "./revival-supabase-store.js";
import type { RevivalEvent, RevivalReplayResult, RevivalTrackerConfig } from "./revival-types.js";

const START = 1_800_000_000_000;

test("an unsafe config transition remains degraded even if other work clears its error", () => {
  assert.equal(revivalObserverHeartbeatError(true, null), "revival_config_transition_incomplete");
  assert.equal(revivalObserverHeartbeatError(true, "watch_restore_failed"), "watch_restore_failed");
  assert.equal(revivalObserverHeartbeatError(false, null), null);
});

class MemoryStore implements RevivalStore {
  readonly events: RevivalEvent[] = [];
  readonly savedChanges: RevivalProjectionChanges[] = [];
  readonly repairMints = new Set<string>();
  loadEventsCalls = 0;
  failNextProjection = false;
  enrichNextDuplicate = false;

  async ensureStrategyVersion(_config: RevivalTrackerConfig) {
    return "strategy-v1";
  }

  async insertEvent(event: RevivalEvent) {
    const existing = this.events.find((row) => row.eventKey === event.eventKey);
    if (existing) {
      if (this.enrichNextDuplicate) {
        this.enrichNextDuplicate = false;
        existing.amountUsd = event.amountUsd;
        return "enriched" as const;
      }
      return "duplicate" as const;
    }
    this.events.push(event);
    return "inserted" as const;
  }

  async loadEvents(tokenMint?: string) {
    this.loadEventsCalls += 1;
    return this.events.filter((row) => !tokenMint || row.tokenMint === tokenMint);
  }

  async loadProjectionRepairMints() {
    return Array.from(this.repairMints);
  }

  async saveProjection(_result: RevivalReplayResult, changes: RevivalProjectionChanges) {
    if (this.failNextProjection) {
      this.failNextProjection = false;
      throw new Error("projection write failed");
    }
    this.savedChanges.push(changes);
  }

  async loadActiveCampaignMints() {
    return [];
  }

  async loadActiveTargetWallets() {
    return [];
  }

  async recordHeartbeat() {}
}

function seedEvent(): RevivalEvent {
  return {
    eventKey: "seed",
    eventType: "TARGET_BUY",
    tokenMint: "mint-a",
    eventAtMs: START,
    availableAtMs: START,
    source: "rpc",
    targetWallet: "target-a",
    verified: true,
    historical: false,
    amountUsd: 400,
    market: {
      provider: "dexscreener",
      observedAtMs: START,
      marketCapUsd: 8_000,
      priceUsd: 0.001,
      reliable: true,
    },
  };
}

test("new Revival observations advance incrementally and projected duplicates are read/write free", async () => {
  const store = new MemoryStore();
  const runtime = new RevivalRuntime(
    { enabled: true, marketCapMinUsd: 2_000, marketCapMaxUsd: 15_000 },
    store,
  );
  await runtime.initialize();
  assert.equal(store.loadEventsCalls, 1, "startup hydrates all events with one paginated scan");

  const seed = seedEvent();
  await runtime.observe(seed);
  assert.equal(
    store.loadEventsCalls,
    1,
    "a new mint advances from the initialized empty projection",
  );

  const market: RevivalEvent = {
    eventKey: "market:one",
    eventType: "MARKET_SNAPSHOT",
    tokenMint: "mint-a",
    eventAtMs: START + 30_000,
    availableAtMs: START + 30_000,
    source: "market",
    verified: true,
    historical: false,
    market: {
      provider: "dexscreener",
      observedAtMs: START + 30_000,
      marketCapUsd: 9_000,
      priceUsd: 0.0011,
      reliable: true,
    },
  };
  await runtime.observe(market);
  assert.equal(store.loadEventsCalls, 1, "an appended event must not replay all prior history");
  assert.equal(store.savedChanges.at(-1)?.events.length, 1);
  assert.equal(runtime.health().eventCount, 2);

  const duplicate = await runtime.observe(market);
  assert.equal(duplicate.duplicate, true);
  assert.equal(store.loadEventsCalls, 1, "a known projected duplicate performs no history read");
  assert.equal(store.savedChanges.length, 2, "a known projected duplicate performs no write");
  assert.equal(runtime.health().eventCount, 2);
});

test("a duplicate repairs the exact crash boundary only when its prior projection failed", async () => {
  const store = new MemoryStore();
  const runtime = new RevivalRuntime({ enabled: true }, store);
  await runtime.initialize();
  store.failNextProjection = true;

  await assert.rejects(runtime.observe(seedEvent()), /projection write failed/);
  assert.equal(store.events.length, 1, "raw evidence remains durable");
  assert.equal(runtime.snapshot("mint-a"), undefined, "failed projection is not published");

  const repaired = await runtime.observe(seedEvent());
  assert.equal(repaired.duplicate, true);
  assert.equal(store.loadEventsCalls, 2, "one mint replay repairs the partial write");
  assert.equal(runtime.snapshot("mint-a")?.state, "SEEDED");
  const writesAfterRepair = store.savedChanges.length;

  await runtime.observe(seedEvent());
  assert.equal(store.loadEventsCalls, 2, "later exact duplicates stay on the fast path");
  assert.equal(store.savedChanges.length, writesAfterRepair);
});

test("a richer duplicate rebuilds commitment after durable USD enrichment", async () => {
  const store = new MemoryStore();
  const runtime = new RevivalRuntime({ enabled: true }, store);
  await runtime.initialize();
  const unvalued = { ...seedEvent(), amountUsd: undefined };
  await runtime.observe(unvalued);
  assert.equal(runtime.snapshot("mint-a")?.targetGrossBuysUsd, 0);

  store.enrichNextDuplicate = true;
  const enriched = await runtime.observe({ ...unvalued, amountUsd: 400 });
  assert.equal(enriched.duplicate, true);
  assert.equal(store.loadEventsCalls, 2, "enrichment replays the affected mint exactly once");
  assert.equal(runtime.snapshot("mint-a")?.targetGrossBuysUsd, 400);

  await runtime.observe({ ...unvalued, amountUsd: 400 });
  assert.equal(store.loadEventsCalls, 2, "unchanged duplicates return to the zero-read fast path");
});

test("equal-availability arrivals rebuild into canonical chain order", async () => {
  const store = new MemoryStore();
  const runtime = new RevivalRuntime({ enabled: true }, store);
  await runtime.initialize();
  const availableAtMs = START + 5_000;
  const newer: RevivalEvent = {
    ...seedEvent(),
    eventKey: "buy:newer",
    eventAtMs: START + 1_000,
    availableAtMs,
    targetWallet: "target-b",
    amountUsd: 600,
  };
  const older: RevivalEvent = {
    ...seedEvent(),
    eventKey: "buy:older",
    eventAtMs: START,
    availableAtMs,
    amountUsd: 400,
  };

  await runtime.observe(newer);
  await runtime.observe(older);

  const campaign = runtime.snapshot("mint-a");
  assert.equal(store.loadEventsCalls, 2, "the equal-time causal reorder rebuilds exactly one mint");
  assert.equal(campaign?.seedEventKey, "buy:older");
  assert.equal(campaign?.targetGrossBuysUsd, 1_000);
  assert.equal(campaign?.state, "ENTRY_READY");
});

test("startup replays in bulk and persists only mints marked for crash repair", async () => {
  const store = new MemoryStore();
  for (let index = 0; index < 20; index += 1) {
    store.events.push({
      ...seedEvent(),
      eventKey: `seed-${index}`,
      tokenMint: `mint-${index}`,
    });
  }
  store.repairMints.add("mint-3");
  store.repairMints.add("mint-17");
  const runtime = new RevivalRuntime({ enabled: true }, store);

  await runtime.initialize();

  assert.equal(store.loadEventsCalls, 1);
  assert.equal(runtime.health().eventCount, 20);
  assert.equal(runtime.health().activeCampaignCount, 20);
  assert.equal(store.savedChanges.length, 2);
  assert.deepEqual(store.savedChanges.map((change) => change.events[0]?.tokenMint).sort(), [
    "mint-17",
    "mint-3",
  ]);
});

test("runtime health exposes current provider reliability and recovery", async () => {
  const store = new MemoryStore();
  const runtime = new RevivalRuntime({ enabled: true }, store);
  await runtime.initialize();
  const healthStart = Date.now() - 5_000;
  await runtime.observe({
    ...seedEvent(),
    eventAtMs: healthStart,
    availableAtMs: healthStart,
    market: { ...seedEvent().market!, observedAtMs: healthStart },
  });

  await runtime.observeMarketSnapshot("mint-a", {
    provider: "dexscreener",
    observedAtMs: healthStart + 1_000,
    reliable: false,
    reason: "provider_unavailable",
  });
  assert.equal(runtime.health().marketProviderReliable, false);
  assert.equal(runtime.health().consecutiveMarketProviderFailures, 1);
  assert.equal(runtime.health().lastReliableMarketSnapshotAt, healthStart);

  await runtime.observeMarketSnapshot("mint-a", {
    provider: "dexscreener",
    observedAtMs: healthStart + 2_000,
    marketCapUsd: 8_100,
    priceUsd: 0.0011,
    reliable: true,
  });
  assert.equal(runtime.health().marketProviderReliable, true);
  assert.equal(runtime.health().consecutiveMarketProviderFailures, 0);
  assert.ok(runtime.health().lastReliableMarketSnapshotAt);
});

test("events for an active campaign stay pinned to its original strategy config", async () => {
  const store = new MemoryStore();
  const runtime = new RevivalRuntime(
    { enabled: true, marketCapMinUsd: 2_000, marketCapMaxUsd: 15_000 },
    store,
  );
  await runtime.initialize();
  await runtime.observe(seedEvent());
  await runtime.reconfigure({
    enabled: true,
    marketCapMinUsd: 50_000,
    marketCapMaxUsd: 100_000,
  });
  await runtime.observeMarketSnapshot("mint-a", {
    provider: "dexscreener",
    observedAtMs: START + 1_000,
    marketCapUsd: 20_000,
    reliable: true,
  });

  const persisted = store.events.at(-1)?.seedConfig;
  assert.equal(persisted?.marketCapMinUsd, 2_000);
  assert.equal(persisted?.marketCapMaxUsd, 15_000);
  assert.equal(runtime.snapshot("mint-a")?.eligibilityStatus, "eligible");
});

test("a post-TTL buy starts the next campaign with current settings", async () => {
  const store = new MemoryStore();
  const runtime = new RevivalRuntime(
    { enabled: true, marketCapMinUsd: 2_000, marketCapMaxUsd: 15_000 },
    store,
  );
  await runtime.initialize();
  await runtime.observe(seedEvent());
  await runtime.reconfigure({
    enabled: true,
    marketCapMinUsd: 50_000,
    marketCapMaxUsd: 100_000,
  });

  await runtime.observe({
    ...seedEvent(),
    eventKey: "seed:next-generation",
    eventAtMs: START + 24 * 60 * 60_000 + 1,
    availableAtMs: START + 24 * 60 * 60_000 + 1,
    market: {
      ...seedEvent().market!,
      observedAtMs: START + 24 * 60 * 60_000 + 1,
      marketCapUsd: 60_000,
    },
  });

  const next = runtime.snapshot("mint-a");
  assert.equal(next?.seedEventKey, "seed:next-generation");
  assert.equal(next?.config.marketCapMinUsd, 50_000);
  assert.equal(next?.config.marketCapMaxUsd, 100_000);
  assert.equal(next?.eligibilityStatus, "eligible");
});

test("observer config transition restores prior watches and runtime config on failure", async () => {
  const calls: string[] = [];
  await assert.rejects(
    transitionRevivalObserverConfig({
      prior: "prior",
      next: "next",
      applyWatches: async (prior, next) => {
        calls.push(`watches:${prior}->${next}`);
        if (next === "next") throw new Error("watch hydration failed");
      },
      applyRuntimeConfig: async (config) => {
        calls.push(`runtime:${config}`);
      },
    }),
    (error: unknown) =>
      error instanceof RevivalConfigTransitionError && error.previousConfigurationRestored,
  );
  assert.deepEqual(calls, ["watches:prior->next", "watches:next->prior", "runtime:prior"]);
});

test("observer config transition reports an unsafe rollback so the caller keeps its gate closed", async () => {
  await assert.rejects(
    transitionRevivalObserverConfig({
      prior: "prior",
      next: "next",
      applyWatches: async (_prior, next) => {
        throw new Error(next === "next" ? "apply failed" : "restore failed");
      },
      applyRuntimeConfig: async () => undefined,
    }),
    (error: unknown) =>
      error instanceof RevivalConfigTransitionError && !error.previousConfigurationRestored,
  );
});
