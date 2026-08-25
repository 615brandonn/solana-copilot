import {
  activeRevivalCampaign,
  advanceRevivalProjection,
  compareRevivalEventOrder,
  normalizeRevivalConfig,
  replayRevivalEvents,
} from "./revival-engine.js";
import type { RevivalStore } from "./revival-supabase-store.js";
import type {
  RevivalCampaignSnapshot,
  RevivalEvent,
  RevivalMarketSnapshot,
  RevivalReplayResult,
  RevivalRuntimeHealth,
  RevivalTrackerConfig,
} from "./revival-types.js";

export type RevivalRuntimeObservation = {
  duplicate: boolean;
  projection: RevivalReplayResult;
};

export function revivalObserverHeartbeatError(
  configTransitioning: boolean,
  lastError: string | null,
): string | null {
  return configTransitioning ? (lastError ?? "revival_config_transition_incomplete") : lastError;
}

export class RevivalConfigTransitionError extends Error {
  constructor(
    message: string,
    readonly previousConfigurationRestored: boolean,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RevivalConfigTransitionError";
  }
}

/**
 * Stage watches first, publish the runtime configuration second, and restore
 * both on failure. The observer keeps its event gate closed when restoration
 * itself fails, so no callback can run under a half-applied watch/config set.
 */
export async function transitionRevivalObserverConfig<T>(input: {
  prior: T;
  next: T;
  applyWatches: (prior: T, next: T) => Promise<void>;
  applyRuntimeConfig: (config: T) => Promise<void>;
}): Promise<T> {
  try {
    await input.applyWatches(input.prior, input.next);
    await input.applyRuntimeConfig(input.next);
    return input.next;
  } catch (error) {
    try {
      await input.applyWatches(input.next, input.prior);
      await input.applyRuntimeConfig(input.prior);
    } catch (restoreError) {
      throw new RevivalConfigTransitionError(
        "Revival configuration transition failed and prior watches could not be restored",
        false,
        { transitionError: error, restoreError },
      );
    }
    throw new RevivalConfigTransitionError(
      "Revival configuration transition failed; prior configuration was restored",
      true,
      error,
    );
  }
}

export class RevivalRuntime {
  private config: RevivalTrackerConfig;
  private initialized = false;
  private operationTail: Promise<void> = Promise.resolve();
  private readonly projections = new Map<string, RevivalReplayResult>();
  private readonly eventCounts = new Map<string, number>();
  /** Events whose projection write completed, or was verified on startup. */
  private readonly projectedEventKeys = new Set<string>();
  private readonly lastAppliedEvents = new Map<string, RevivalEvent>();
  private eventCount = 0;
  private lastObservationAt: number | null = null;
  private lastMarketSnapshotAt: number | null = null;
  private lastReliableMarketSnapshotAt: number | null = null;
  private marketProviderReliable: boolean | null = null;
  private consecutiveMarketProviderFailures = 0;
  private lastError: string | null = null;

  constructor(
    config: Partial<RevivalTrackerConfig>,
    private readonly store: RevivalStore,
  ) {
    this.config = normalizeRevivalConfig(config);
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  initialize(): Promise<void> {
    return this.runExclusive(async () => {
      if (this.initialized) return;
      await this.initializeUnlocked();
    });
  }

  reconfigure(config: Partial<RevivalTrackerConfig>): Promise<void> {
    return this.runExclusive(async () => {
      const next = normalizeRevivalConfig(config);
      await this.store.ensureStrategyVersion(next);
      this.config = next;
    });
  }

  observe(event: RevivalEvent): Promise<RevivalRuntimeObservation> {
    return this.runExclusive(async () => {
      if (!this.initialized) await this.initializeUnlocked();
      const activeCampaign = this.snapshotUnlocked(event.tokenMint);
      const rollsIntoNewCampaign =
        activeCampaign !== undefined &&
        event.eventType === "TARGET_BUY" &&
        event.verified &&
        event.eventAtMs - activeCampaign.seededAtMs > activeCampaign.config.campaignTtlMs;
      const normalized: RevivalEvent = {
        ...event,
        // An active campaign remains pinned to the strategy version that
        // admitted it, even when dashboard settings change mid-campaign. A
        // buy beyond its TTL seeds a new campaign with the current settings.
        seedConfig: normalizeRevivalConfig(
          !rollsIntoNewCampaign && activeCampaign
            ? activeCampaign.config
            : (event.seedConfig ?? this.config),
        ),
      };
      try {
        const write = await this.store.insertEvent(normalized);
        if (write === "inserted") this.recordObservedEvent(normalized);
        let projection: RevivalReplayResult;
        if (write === "inserted") {
          projection = await this.applyInsertedEventUnlocked(normalized);
          this.projectedEventKeys.add(normalized.eventKey);
        } else if (write === "duplicate" && this.projectedEventKeys.has(normalized.eventKey)) {
          // The exact event was already projected successfully in this
          // process (or verified/repaired during startup). Do no historical
          // reads or writes on an ordinary feed duplicate.
          projection =
            this.projections.get(normalized.tokenMint) ??
            ({ campaigns: [], transitions: [], actions: [] } satisfies RevivalReplayResult);
        } else {
          // The event row may have landed before a previous projection write
          // failed. One bounded mint replay repairs that crash boundary.
          projection = await this.rebuildMintUnlocked(normalized.tokenMint);
        }
        this.lastError = null;
        return { duplicate: write !== "inserted", projection };
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : "revival_observation_failed";
        throw error;
      }
    });
  }

  observeMarketSnapshot(
    tokenMint: string,
    market: RevivalMarketSnapshot,
  ): Promise<RevivalRuntimeObservation> {
    return this.observe({
      eventKey: `revival:market:${tokenMint}:${market.provider}:${market.pairAddress ?? "unknown"}:${market.observedAtMs}`,
      eventType: "MARKET_SNAPSHOT",
      tokenMint,
      eventAtMs: market.observedAtMs,
      availableAtMs: Date.now(),
      source: "market",
      verified: market.reliable,
      historical: false,
      market,
      seedConfig: this.config,
      metadata: { sampleIntervalMs: 30_000 },
    });
  }

  tick(nowMs = Date.now()): Promise<void> {
    return this.runExclusive(async () => {
      if (!this.initialized) await this.initializeUnlocked();
      const activeMints = this.activeCampaignMintsUnlocked();
      const bucket = Math.floor(nowMs / 60_000) * 60_000;
      for (const tokenMint of activeMints) {
        const event: RevivalEvent = {
          eventKey: `revival:clock:${tokenMint}:${bucket}`,
          eventType: "CLOCK_TICK",
          tokenMint,
          eventAtMs: nowMs,
          availableAtMs: nowMs,
          source: "clock",
          verified: true,
          historical: false,
          seedConfig: this.snapshotUnlocked(tokenMint)?.config ?? this.config,
        };
        const write = await this.store.insertEvent(event);
        if (write === "inserted") {
          this.recordObservedEvent(event);
          await this.applyInsertedEventUnlocked(event);
          this.projectedEventKeys.add(event.eventKey);
        } else if (!this.projectedEventKeys.has(event.eventKey)) {
          await this.rebuildMintUnlocked(tokenMint);
        }
      }
    });
  }

  activeCampaignMints(): Promise<string[]> {
    return this.runExclusive(async () => {
      if (!this.initialized) await this.initializeUnlocked();
      return this.activeCampaignMintsUnlocked();
    });
  }

  snapshot(tokenMint: string): RevivalCampaignSnapshot | undefined {
    return this.snapshotUnlocked(tokenMint);
  }

  private snapshotUnlocked(tokenMint: string): RevivalCampaignSnapshot | undefined {
    const campaigns = this.projections.get(tokenMint)?.campaigns ?? [];
    return [...campaigns].reverse().find(activeRevivalCampaign);
  }

  health(): RevivalRuntimeHealth {
    const active = Array.from(this.projections.values())
      .flatMap((projection) => projection.campaigns)
      .filter(activeRevivalCampaign);
    return {
      initialized: this.initialized,
      eventCount: this.eventCount,
      activeCampaignCount: active.length,
      pendingMarketDataCount: active.filter(
        (campaign) => campaign.eligibilityStatus === "pending_market_data",
      ).length,
      lastObservationAt: this.lastObservationAt,
      lastMarketSnapshotAt: this.lastMarketSnapshotAt,
      lastReliableMarketSnapshotAt: this.lastReliableMarketSnapshotAt,
      marketProviderReliable: this.marketProviderReliable,
      consecutiveMarketProviderFailures: this.consecutiveMarketProviderFailures,
      lastError: this.lastError,
    };
  }

  private async initializeUnlocked(): Promise<void> {
    if (this.initialized) return;
    await this.store.ensureStrategyVersion(this.config);
    // One paginated bulk read replaces the prior N+1 startup sequence. Every
    // event is replayed in memory, while only mints with an unlinked durable
    // event are written back for crash repair.
    const events = await this.store.loadEvents();
    this.hydrateUnlocked(events);
    const repairMints = new Set(await this.store.loadProjectionRepairMints());
    const repairJobs = Array.from(repairMints)
      .map((mint) => {
        const projection = this.projections.get(mint);
        if (!projection) return undefined;
        const mintEvents = events.filter((event) => event.tokenMint === mint);
        return () =>
          this.store.saveProjection(projection, {
            events: mintEvents,
            transitions: projection.transitions,
            actions: projection.actions,
            campaignKeys: projection.campaigns.map((campaign) => campaign.campaignKey),
          });
      })
      .filter((job): job is () => Promise<void> => job !== undefined);
    for (let offset = 0; offset < repairJobs.length; offset += 4) {
      await Promise.all(repairJobs.slice(offset, offset + 4).map((job) => job()));
    }
    // Every loaded event is now either projection-complete or deliberately
    // irrelevant to campaign state. Repair-required mints succeeded above.
    this.projectedEventKeys.clear();
    for (const event of events) this.projectedEventKeys.add(event.eventKey);
    this.initialized = true;
  }

  private hydrateUnlocked(events: readonly RevivalEvent[]): void {
    this.projections.clear();
    this.eventCounts.clear();
    this.lastAppliedEvents.clear();
    this.eventCount = events.length;
    this.lastObservationAt = null;
    this.lastMarketSnapshotAt = null;
    this.lastReliableMarketSnapshotAt = null;
    this.marketProviderReliable = null;
    this.consecutiveMarketProviderFailures = 0;
    const grouped = new Map<string, RevivalEvent[]>();
    for (const event of events) {
      const rows = grouped.get(event.tokenMint) ?? [];
      rows.push(event);
      grouped.set(event.tokenMint, rows);
      this.recordObservedEvent(event);
    }
    for (const [mint, rows] of grouped) {
      rows.sort(compareRevivalEventOrder);
      this.projections.set(mint, replayRevivalEvents(rows));
      this.eventCounts.set(mint, rows.length);
      const latest = rows.at(-1);
      if (latest) this.lastAppliedEvents.set(mint, latest);
    }
  }

  private recordObservedEvent(event: RevivalEvent): void {
    this.lastObservationAt = Math.max(this.lastObservationAt ?? 0, event.availableAtMs);
    if (!event.market) return;
    // During startup events arrive in durable available-at order. During live
    // operation a stale completion must not overwrite newer provider health.
    if (event.availableAtMs < (this.lastMarketSnapshotAt ?? 0)) return;
    this.lastMarketSnapshotAt = event.availableAtMs;
    const reliable = event.market?.reliable === true;
    this.marketProviderReliable = reliable;
    if (reliable) {
      this.lastReliableMarketSnapshotAt = event.availableAtMs;
      this.consecutiveMarketProviderFailures = 0;
    } else {
      this.consecutiveMarketProviderFailures += 1;
    }
  }

  private async rebuildMintUnlocked(tokenMint: string): Promise<RevivalReplayResult> {
    const events = await this.store.loadEvents(tokenMint);
    const projection = replayRevivalEvents(events);
    await this.store.saveProjection(projection, {
      events,
      transitions: projection.transitions,
      actions: projection.actions,
      campaignKeys: projection.campaigns.map((campaign) => campaign.campaignKey),
    });
    this.projections.set(tokenMint, projection);
    for (const event of events) this.projectedEventKeys.add(event.eventKey);
    const latest = [...events].sort(compareRevivalEventOrder).at(-1);
    if (latest) this.lastAppliedEvents.set(tokenMint, latest);
    this.eventCounts.set(tokenMint, events.length);
    this.eventCount = Array.from(this.eventCounts.values()).reduce(
      (total, count) => total + count,
      0,
    );
    return projection;
  }

  private async applyInsertedEventUnlocked(event: RevivalEvent): Promise<RevivalReplayResult> {
    const prior = this.projections.get(event.tokenMint);
    const latestAppliedEvent = this.lastAppliedEvents.get(event.tokenMint);
    if (prior && latestAppliedEvent && compareRevivalEventOrder(event, latestAppliedEvent) <= 0) {
      return this.rebuildMintUnlocked(event.tokenMint);
    }
    const base = prior ?? { campaigns: [], transitions: [], actions: [] };
    const projection = advanceRevivalProjection(base, event);
    const newTransitions = projection.transitions.slice(base.transitions.length);
    const newActions = projection.actions.slice(base.actions.length);
    const priorActiveCampaignKey = prior
      ? [...prior.campaigns].reverse().find(activeRevivalCampaign)?.campaignKey
      : undefined;
    const campaignKeys = Array.from(
      new Set([
        ...(priorActiveCampaignKey ? [priorActiveCampaignKey] : []),
        ...newTransitions.map((transition) => transition.campaignKey),
        ...newActions.map((action) => action.campaignKey),
        ...projection.campaigns
          .filter(
            (campaign) =>
              campaign.seedEventKey === event.eventKey || campaign.lastEventKey === event.eventKey,
          )
          .map((campaign) => campaign.campaignKey),
      ]),
    );
    await this.store.saveProjection(projection, {
      events: [event],
      transitions: newTransitions,
      actions: newActions,
      campaignKeys,
    });
    this.projections.set(event.tokenMint, projection);
    this.lastAppliedEvents.set(event.tokenMint, event);
    this.eventCounts.set(event.tokenMint, (this.eventCounts.get(event.tokenMint) ?? 0) + 1);
    this.eventCount = Array.from(this.eventCounts.values()).reduce(
      (total, count) => total + count,
      0,
    );
    return projection;
  }

  private activeCampaignMintsUnlocked(): string[] {
    return Array.from(this.projections.entries())
      .filter(([, projection]) => projection.campaigns.some(activeRevivalCampaign))
      .map(([mint]) => mint)
      .sort();
  }
}
