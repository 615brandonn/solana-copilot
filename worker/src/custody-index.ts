// Observation-only Custody Journey worker. This process intentionally does not
// import the executor, funding-key code, positions, Entries, or sell policies.

import pino from "pino";
import { Connection, PublicKey } from "@solana/web3.js";
import { env } from "./env.js";
import { db } from "./db.js";
import { safeDiagnostic } from "./diagnostics.js";
import type { FeedEvent } from "./geyser.js";
import { RpcBackfillPoller, type UnresolvedOutflowEvent } from "./poller.js";
import { createSupabaseRpcCursorStore } from "./rpc-cursor.js";
import { createSupabaseCustodyStore } from "./custody-store.js";
import { CustodyRuntime } from "./custody-runtime.js";
import { CustodyWatchRegistry } from "./custody-watch-registry.js";
import { refreshCustodyWalletLearning } from "./custody-learning.js";

const log = pino({ level: env.LOG_LEVEL });
// Custody accounting deliberately follows a confirmed canonical timeline.
// The trading worker keeps its independent processed/Geyser path for speed.
const rpc = new Connection(env.RPC_URL, { commitment: "confirmed" });

type CustodyConfig = {
  enabled: boolean;
  targetWallets: Set<string>;
  degradedBacklogFraction: number;
  degradedSweepStaleMinutes: number;
};

function validWallet(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return new PublicKey(value.trim()).toBase58();
  } catch {
    return null;
  }
}

async function loadCustodyConfig(): Promise<CustodyConfig> {
  const { data, error } = await db
    .from("bot_config")
    .select(
      "target_wallet,additional_target_wallets,custody_journey_enabled,custody_degraded_backlog_fraction,custody_degraded_sweep_stale_minutes",
    )
    .eq("user_id", env.HELIX_USER_ID)
    .maybeSingle();
  if (error) throw new Error(`custody config load failed: ${safeDiagnostic(error)}`);
  const targets = [
    data?.target_wallet,
    ...(Array.isArray(data?.additional_target_wallets) ? data.additional_target_wallets : []),
  ]
    .map(validWallet)
    .filter((wallet): wallet is string => wallet !== null);
  const fractionRaw = Number(data?.custody_degraded_backlog_fraction);
  const staleRaw = Number(data?.custody_degraded_sweep_stale_minutes);
  return {
    enabled: data?.custody_journey_enabled === true,
    targetWallets: new Set(targets),
    degradedBacklogFraction: Number.isFinite(fractionRaw)
      ? Math.min(1, Math.max(0, fractionRaw))
      : 0.25,
    degradedSweepStaleMinutes: Number.isFinite(staleRaw) && staleRaw > 0 ? staleRaw : 240,
  };
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const store = createSupabaseCustodyStore(db, env.HELIX_USER_ID);
  let currentConfig = await loadCustodyConfig();
  let lastEventAt: string | null = null;
  let lastError: string | null = null;
  let pollerStarted = false;
  let decodedEventCount = 0;
  // Backlog progress signal for the heartbeat's degraded flag: sweeps can take
  // hours, so we track when the backlog last shrank rather than poll recency.
  let lastBacklogCount = Number.POSITIVE_INFINITY;
  let lastBacklogProgressAt = Date.now();
  let schedulePendingReplay = () => undefined;

  // Assigned after the feed/poller callbacks close over it to break their
  // construction cycle; it is never replaced afterward.
  // eslint-disable-next-line prefer-const
  let registry: CustodyWatchRegistry;
  const runtime = new CustodyRuntime(store, rpc, async (result, event) => {
    lastEventAt = new Date(event.blockTimeMs ?? event.timestampMs).toISOString();
    await registry.apply(result, event.slot);
    if (result.applied) schedulePendingReplay();
  });
  const handle = async (event: FeedEvent) => {
    try {
      decodedEventCount += 1;
      await runtime.observe(event, {
        enabled: currentConfig.enabled,
        targetWallets: currentConfig.targetWallets,
      });
      lastError = null;
    } catch (error) {
      lastError = safeDiagnostic(error);
      log.error(
        { error: lastError, kind: event.kind, mint: event.tokenMint },
        "custody observation failed; trading worker is unaffected",
      );
      throw error;
    }
  };
  const handleUnresolvedOutflow = async (event: UnresolvedOutflowEvent) => {
    try {
      decodedEventCount += 1;
      await runtime.observeUnresolvedOutflow(event, {
        enabled: currentConfig.enabled,
        targetWallets: currentConfig.targetWallets,
      });
      lastError = null;
    } catch (error) {
      lastError = safeDiagnostic(error);
      log.error(
        { error: lastError, kind: event.kind, mint: event.tokenMint },
        "custody unresolved outflow persistence failed; cursor will retry",
      );
      throw error;
    }
  };

  const cursorStore = createSupabaseRpcCursorStore(
    db,
    env.HELIX_USER_ID,
    "custody_rpc_wallet_cursors",
  );
  // Custody includes the activation-head signature so a buy at the exact
  // enable/start boundary cannot fall between cursor creation and polling.
  // The trading worker retains the poller's legacy baseline behavior.
  const poller = new RpcBackfillPoller(rpc, handle, cursorStore, 750, true, {
    onUnresolvedOutflow: handleUnresolvedOutflow,
    allowEarlierAnchorRewind: true,
    pollConcurrency: 16,
    maxWalletsPerPoll: 16,
    deferInitialCursorHydration: true,
    recoveryConcurrency: 4,
    signaturePagesPerTurn: 2,
    recoveryChunkSize: 250,
  });
  registry = new CustodyWatchRegistry(poller);

  let activeWatchReconcile: ReturnType<typeof store.loadActiveWatches> | null = null;
  const reconcileActiveWatches = (): ReturnType<typeof store.loadActiveWatches> => {
    if (activeWatchReconcile) return activeWatchReconcile;
    activeWatchReconcile = (async () => {
      const rows = await store.loadActiveWatches();
      runtime.reconcileActiveWatches(rows);
      await registry.reconcileJourneyWatches(rows);
      return rows;
    })().finally(() => {
      activeWatchReconcile = null;
    });
    return activeWatchReconcile;
  };

  const PENDING_REPLAY_BATCH_SIZE = 25;
  const PENDING_REPLAY_MAX_BURST = 250;
  const PENDING_REPLAY_DEBOUNCE_MS = 1_000;
  const PENDING_REPLAY_IDLE_MS = 5 * 60_000;
  const PENDING_REPLAY_ERROR_BASE_MS = 15_000;
  let replayingPending = false;
  let pendingReplayRequested = false;
  let pendingReplayFailures = 0;
  let pendingReplayTimer: NodeJS.Timeout | undefined;
  let pendingReplayScheduledAt = Number.POSITIVE_INFINITY;

  const armPendingReplay = (delayMs: number) => {
    if (!currentConfig.enabled) return;
    const boundedDelay = Math.max(0, Math.trunc(delayMs));
    const scheduledAt = Date.now() + boundedDelay;
    if (pendingReplayTimer && pendingReplayScheduledAt <= scheduledAt) return;
    if (pendingReplayTimer) clearTimeout(pendingReplayTimer);
    pendingReplayScheduledAt = scheduledAt;
    pendingReplayTimer = setTimeout(() => {
      pendingReplayTimer = undefined;
      pendingReplayScheduledAt = Number.POSITIVE_INFINITY;
      void replayPending();
    }, boundedDelay);
  };

  const cancelPendingReplay = () => {
    if (pendingReplayTimer) clearTimeout(pendingReplayTimer);
    pendingReplayTimer = undefined;
    pendingReplayScheduledAt = Number.POSITIVE_INFINITY;
    pendingReplayRequested = false;
  };

  const replayPending = async () => {
    if (!currentConfig.enabled) return;
    if (replayingPending) {
      pendingReplayRequested = true;
      return;
    }
    replayingPending = true;
    pendingReplayRequested = false;
    let nextDelayMs = PENDING_REPLAY_IDLE_MS;
    let processedCount = 0;
    let appliedCount = 0;
    let pendingCount = 0;
    let expiredCount = 0;
    let terminalCount = 0;
    try {
      while (processedCount < PENDING_REPLAY_MAX_BURST) {
        const replay = await store.replayPending(PENDING_REPLAY_BATCH_SIZE);
        processedCount += replay.processedCount;
        appliedCount += replay.appliedCount;
        pendingCount += replay.pendingCount;
        expiredCount += replay.expiredCount;
        terminalCount += replay.terminalCount;

        for (const item of replay.results) {
          if (item.status !== "applied" || !item.journeyId) continue;
          await registry.apply(item, item.slot);
        }

        const progress = replay.appliedCount + replay.expiredCount + replay.terminalCount;
        if (progress === 0 || replay.processedCount < PENDING_REPLAY_BATCH_SIZE) break;
        if (processedCount >= PENDING_REPLAY_MAX_BURST) {
          nextDelayMs = PENDING_REPLAY_DEBOUNCE_MS;
          break;
        }
        // Yield between productive batches so live confirmed-RPC observations
        // are never monopolized by historical inbox maintenance.
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }

      // Registry updates above are incremental. Refresh the complete durable
      // scope once per productive burst, not once per 25-row batch.
      if (appliedCount > 0) await reconcileActiveWatches();
      const resolvedCount = appliedCount + expiredCount + terminalCount;
      if (processedCount > 0) {
        const fields = {
          processed: processedCount,
          applied: appliedCount,
          pending: pendingCount,
          expired: expiredCount,
          terminal: terminalCount,
        };
        if (resolvedCount > 0) {
          log.info(fields, "custody out-of-order observations replayed");
        } else {
          log.debug(fields, "custody pending replay found no newly resolvable observations");
        }
      }
      pendingReplayFailures = 0;
    } catch (error) {
      lastError = safeDiagnostic(error);
      log.warn({ error: lastError }, "custody pending replay failed; durable inbox will retry");
      pendingReplayFailures += 1;
      nextDelayMs = Math.min(
        PENDING_REPLAY_IDLE_MS,
        PENDING_REPLAY_ERROR_BASE_MS * 2 ** Math.min(4, pendingReplayFailures - 1),
      );
    } finally {
      replayingPending = false;
      if (currentConfig.enabled) {
        armPendingReplay(
          pendingReplayFailures > 0
            ? nextDelayMs
            : pendingReplayRequested
              ? PENDING_REPLAY_DEBOUNCE_MS
              : nextDelayMs,
        );
      }
    }
  };
  schedulePendingReplay = () => {
    if (!currentConfig.enabled) return;
    if (replayingPending) {
      pendingReplayRequested = true;
      return;
    }
    armPendingReplay(PENDING_REPLAY_DEBOUNCE_MS);
  };

  const ensureFeedStarted = () => {
    if (!pollerStarted) {
      poller.start([]);
      pollerStarted = true;
    }
  };

  const enable = async (config: CustodyConfig) => {
    await reconcileActiveWatches();
    await registry.setTargets(config.targetWallets);
    await poller.hydrateWatchedCursors();
    ensureFeedStarted();
    schedulePendingReplay();
    log.info(
      {
        targetCount: config.targetWallets.size,
        watchedCount: registry.watchedWalletCount(),
      },
      "Custody Journey live monitoring enabled (observation only)",
    );
  };

  const disable = async () => {
    cancelPendingReplay();
    await registry.clear();
    runtime.reconcileActiveWatches([]);
    log.info("Custody Journey disabled; durable cursors and history preserved");
  };

  /**
   * One-shot startup catch-up: finds open positions that have no active custody
   * journey and creates one for each. This covers positions that were opened
   * before custody tracking was enabled or before the custody worker was
   * running. After backfill the RPC poller will scan from each position's
   * entry slot and discover any custody transfers Alien made since entry.
   */
  let custodyBackfillRunning = false;
  const runCustodyBackfill = async (config: CustodyConfig): Promise<void> => {
    if (!config.enabled || config.targetWallets.size === 0 || custodyBackfillRunning) return;
    custodyBackfillRunning = true;
    const targetList = Array.from(config.targetWallets);
    try {
      const count = await store.backfillMissingJourneys(targetList);
      if (count > 0) {
        log.info(
          { count, targetCount: targetList.length },
          "custody backfill: created missing journeys for open positions; reconciling watches",
        );
        await reconcileActiveWatches();
      } else {
        log.debug("custody backfill: all open positions already have custody journeys");
      }
    } catch (error) {
      log.warn(
        { error: safeDiagnostic(error) },
        "custody backfill failed; normal monitoring continues unaffected",
      );
    } finally {
      custodyBackfillRunning = false;
    }
  };

  if (currentConfig.enabled) {
    await enable(currentConfig);
    void runCustodyBackfill(currentConfig);
  }

  let refreshing = false;
  setInterval(() => {
    if (refreshing) return;
    refreshing = true;
    loadCustodyConfig()
      .then(async (next) => {
        const wasEnabled = currentConfig.enabled;
        const targetsChanged =
          [...currentConfig.targetWallets].sort().join(",") !==
          [...next.targetWallets].sort().join(",");
        if (next.enabled && (!wasEnabled || targetsChanged)) {
          // Publish the new active config only after its durable watches are
          // restored. A transient DB failure therefore retries on the next
          // refresh instead of leaving an enabled-but-unarmed observer.
          await enable(next);
          if (targetsChanged) runtime.clearClassificationCache();
          currentConfig = next;
          schedulePendingReplay();
        } else if (next.enabled) {
          currentConfig = next;
          ensureFeedStarted();
        } else {
          currentConfig = next;
          if (wasEnabled) await disable();
        }
      })
      .catch((error) => {
        lastError = safeDiagnostic(error);
        log.warn({ error: lastError }, "custody config refresh failed; prior state preserved");
      })
      .finally(() => {
        refreshing = false;
      });
  }, 3_000);

  setInterval(() => {
    if (!currentConfig.enabled) return;
    reconcileActiveWatches().catch((error) => {
      lastError = safeDiagnostic(error);
      log.warn({ error: lastError }, "custody subscription reconciliation failed");
    });
  }, 60_000);

  // Periodic backfill: catches positions opened after startup
  setInterval(() => {
    if (!currentConfig.enabled || currentConfig.targetWallets.size === 0) return;
    void runCustodyBackfill(currentConfig);
  }, 10 * 60_000);

  let custodyLearningRunning = false;
  setInterval(() => {
    if (!currentConfig.enabled || custodyLearningRunning) return;
    custodyLearningRunning = true;
    refreshCustodyWalletLearning(db, env.HELIX_USER_ID)
      .then((updated) => {
        if (updated > 0) log.info({ updated }, "custody wallet behavior profiles learned");
      })
      .catch((error) =>
        log.warn(
          { error: safeDiagnostic(error) },
          "custody learning refresh failed; observations and trading are unaffected",
        ),
      )
      .finally(() => {
        custodyLearningRunning = false;
      });
  }, 5 * 60_000);

  async function writeHeartbeat() {
    const fallback = poller.health();
    const { count, error: countError } = await db
      .from("custody_journeys")
      .select("id", { count: "exact", head: true })
      .eq("user_id", env.HELIX_USER_ID)
      .eq("status", "active");
    if (countError) throw new Error(`custody journey count failed: ${safeDiagnostic(countError)}`);
    const now = Date.now();
    // Degraded must mean genuine failure, not work-in-progress: a full sweep of
    // the watch list legitimately takes hours, so a non-empty backlog or a poll
    // older than 30s says nothing. Progress is "the backlog shrank recently".
    const backlog = Number(fallback.backlogWalletCount ?? 0);
    const recoveryProgressAt = Number(fallback.lastRecoveryProgressAt ?? 0);
    if (
      backlog === 0 ||
      backlog < lastBacklogCount ||
      (Number.isFinite(recoveryProgressAt) && recoveryProgressAt > lastBacklogProgressAt)
    ) {
      lastBacklogProgressAt = now;
    }
    lastBacklogCount = backlog;
    const staleWindowMs = currentConfig.degradedSweepStaleMinutes * 60_000;
    const noProgressMs = now - lastBacklogProgressAt;
    const pollerDead = !fallback.lastSuccessAt || now - fallback.lastSuccessAt > 5 * 60_000;
    const sweepStalled = backlog > 0 && noProgressMs > staleWindowMs;
    const backlogUnbounded =
      backlog > currentConfig.degradedBacklogFraction * registry.watchedWalletCount() &&
      noProgressMs > staleWindowMs;
    const degraded =
      currentConfig.enabled && (!pollerStarted || pollerDead || sweepStalled || backlogUnbounded);
    const { error } = await db.from("custody_worker_heartbeat").upsert(
      {
        user_id: env.HELIX_USER_ID,
        started_at: startedAt,
        updated_at: new Date().toISOString(),
        enabled: currentConfig.enabled,
        // Custody intentionally uses one confirmed RPC timeline. The trading
        // worker retains its independent low-latency processed Geyser feed.
        geyser_connected: false,
        last_geyser_message_at: null,
        decoded_event_count: decodedEventCount,
        rpc_last_poll_at: fallback.lastPollAt ? new Date(fallback.lastPollAt).toISOString() : null,
        rpc_last_success_at: fallback.lastSuccessAt
          ? new Date(fallback.lastSuccessAt).toISOString()
          : null,
        rpc_backlog_wallet_count: Number(fallback.backlogWalletCount ?? 0),
        watched_wallet_count: registry.watchedWalletCount(),
        active_journey_count: Number(count ?? 0),
        last_event_at: lastEventAt,
        degraded,
        last_error: lastError,
      },
      { onConflict: "user_id" },
    );
    if (error) throw new Error(`custody heartbeat failed: ${safeDiagnostic(error)}`);
  }

  await writeHeartbeat();
  setInterval(() => {
    writeHeartbeat().catch((error) =>
      log.error(
        { error: safeDiagnostic(error) },
        "custody heartbeat failed; trading heartbeat is independent",
      ),
    );
  }, 20_000);
}

main().catch((error) => {
  log.fatal({ error: safeDiagnostic(error) }, "Custody Journey worker crashed safely");
  // Timers may already exist. A hard non-zero exit lets PM2 restart instead of
  // leaving a half-alive observer without a heartbeat.
  process.exit(1);
});
