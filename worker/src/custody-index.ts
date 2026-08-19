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
  const poller = new RpcBackfillPoller(rpc, handle, cursorStore, 1_200, true, {
    onUnresolvedOutflow: handleUnresolvedOutflow,
    allowEarlierAnchorRewind: true,
    pollConcurrency: 32,
  });
  registry = new CustodyWatchRegistry(poller);

  const reconcileActiveWatches = async () => {
    const rows = await store.loadActiveWatches();
    runtime.reconcileActiveWatches(rows);
    await registry.reconcileJourneyWatches(rows);
    return rows;
  };

  let replayingPending = false;
  const replayPending = async () => {
    if (replayingPending || !currentConfig.enabled) return;
    replayingPending = true;
    try {
      const replay = await store.replayPending(100);
      for (const item of replay.results) {
        if (item.status !== "applied" || !item.journeyId) continue;
        await registry.apply(item, item.slot);
      }
      if (replay.appliedCount > 0) await reconcileActiveWatches();
      if (replay.processedCount > 0) {
        log.info(
          {
            processed: replay.processedCount,
            applied: replay.appliedCount,
            pending: replay.pendingCount,
            expired: replay.expiredCount,
            terminal: replay.terminalCount,
          },
          "custody out-of-order observations replayed",
        );
      }
    } catch (error) {
      lastError = safeDiagnostic(error);
      log.warn({ error: lastError }, "custody pending replay failed; durable inbox will retry");
    } finally {
      replayingPending = false;
    }
  };
  schedulePendingReplay = () => {
    queueMicrotask(() => void replayPending());
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
    ensureFeedStarted();
    log.info(
      {
        targetCount: config.targetWallets.size,
        watchedCount: registry.watchedWalletCount(),
      },
      "Custody Journey live monitoring enabled (observation only)",
    );
  };

  const disable = async () => {
    await registry.clear();
    runtime.reconcileActiveWatches([]);
    log.info("Custody Journey disabled; durable cursors and history preserved");
  };

  if (currentConfig.enabled) await enable(currentConfig);

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
  }, 15_000);

  setInterval(() => {
    void replayPending();
  }, 2_000);

  setInterval(() => {
    if (!currentConfig.enabled) return;
    refreshCustodyWalletLearning(db, env.HELIX_USER_ID)
      .then((updated) => {
        if (updated > 0) log.info({ updated }, "custody wallet behavior profiles learned");
      })
      .catch((error) =>
        log.warn(
          { error: safeDiagnostic(error) },
          "custody learning refresh failed; observations and trading are unaffected",
        ),
      );
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
    if (backlog === 0 || backlog < lastBacklogCount) lastBacklogProgressAt = now;
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
