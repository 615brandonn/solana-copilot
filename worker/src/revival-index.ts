// Observation-only Revival Campaign worker. This process intentionally has no
// executor, funding-key, position, trade, entry-claim, or sell-claim imports.

import pino from "pino";
import { Connection, PublicKey } from "@solana/web3.js";
import { env } from "./env.js";
import { db } from "./db.js";
import { safeDiagnostic } from "./diagnostics.js";
import type { FeedEvent, SwapEvent } from "./geyser.js";
import { RpcBackfillPoller } from "./poller.js";
import { createSupabaseRpcCursorStore } from "./rpc-cursor.js";
import {
  loadRevivalMarketSnapshot,
  loadRevivalSeedMarketSnapshotWithRetry,
  revivalMarketSamplingMode,
} from "./revival-market-data.js";
import {
  RevivalConfigTransitionError,
  RevivalRuntime,
  revivalObserverHeartbeatError,
  transitionRevivalObserverConfig,
} from "./revival-runtime.js";
import { createSupabaseRevivalStore } from "./revival-supabase-store.js";
import { normalizeRevivalConfig } from "./revival-engine.js";
import type { RevivalTrackerConfig } from "./revival-types.js";
import { resolveTargetBuyValue } from "./target-buy-valuation.js";
import { quoteTokenSpendUsd } from "./token-spend-quote.js";
import { priceUsd } from "./prices.js";
import { STABLECOIN_MINTS, WSOL_MINT } from "./swap-attribution.js";

const log = pino({ level: env.LOG_LEVEL });
const rpc = new Connection(env.RPC_URL, { commitment: "confirmed" });

type RevivalObserverConfig = RevivalTrackerConfig & { targetWallets: Set<string> };

function validWallet(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return new PublicKey(value.trim()).toBase58();
  } catch {
    return null;
  }
}

async function loadRevivalConfig(): Promise<RevivalObserverConfig> {
  const result = await db
    .from("bot_config")
    .select(
      "target_wallet,additional_target_wallets,revival_tracker_enabled,revival_market_cap_min_usd,revival_market_cap_max_usd",
    )
    .eq("user_id", env.HELIX_USER_ID)
    .maybeSingle();
  if (result.error) {
    throw new Error(`Revival config load failed: ${safeDiagnostic(result.error)}`);
  }
  const targetWallets = new Set(
    [
      result.data?.target_wallet,
      ...(Array.isArray(result.data?.additional_target_wallets)
        ? result.data.additional_target_wallets
        : []),
    ]
      .map(validWallet)
      .filter((wallet): wallet is string => wallet !== null),
  );
  const normalized = normalizeRevivalConfig({
    enabled: result.data?.revival_tracker_enabled === true,
    marketCapMinUsd: Number(result.data?.revival_market_cap_min_usd ?? 2_000),
    marketCapMaxUsd: Number(result.data?.revival_market_cap_max_usd ?? 15_000),
  });
  return { ...normalized, targetWallets };
}

function sameTargets(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && Array.from(left).every((wallet) => right.has(wallet));
}

function eventTimestampMs(event: FeedEvent): number {
  return event.blockTimeMs ?? event.timestampMs;
}

async function targetSwapValueUsd(event: SwapEvent): Promise<number | undefined> {
  if (event.side === "buy") {
    const value = await resolveTargetBuyValue(event, {
      quoteTokenSpendUsd,
      solPriceUsd: () => priceUsd(WSOL_MINT),
    });
    return value.amountUsd;
  }
  if (Number.isFinite(event.amountUsd) && Number(event.amountUsd) > 0) {
    return Number(event.amountUsd);
  }
  const attribution = event.sellAttribution;
  if (
    attribution?.verified === true &&
    attribution.proceedsMint &&
    STABLECOIN_MINTS.has(attribution.proceedsMint) &&
    Number.isFinite(attribution.proceedsAmount) &&
    Number(attribution.proceedsAmount) > 0
  ) {
    return Number(attribution.proceedsAmount);
  }
  return undefined;
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const store = createSupabaseRevivalStore(db, env.HELIX_USER_ID);
  let config = await loadRevivalConfig();
  const runtime = new RevivalRuntime(config, store);
  await runtime.initialize();
  let lastError: string | null = null;
  let marketSweepRunning = false;
  let tickRunning = false;
  let configRefreshRunning = false;
  let configTransitioning = false;
  let heartbeatRunning = false;
  let watchedTargets = new Set<string>();

  const observeMarket = async (tokenMint: string) => {
    const campaign = runtime.snapshot(tokenMint);
    const samplingMode = revivalMarketSamplingMode(campaign);
    if (samplingMode === "skip") return;
    const market =
      samplingMode === "seed_retry"
        ? await loadRevivalSeedMarketSnapshotWithRetry(tokenMint, {
            deadlineAtMs: campaign?.eligibilityDeadlineAtMs,
            maxRetryWindowMs: 15_000,
          })
        : await loadRevivalMarketSnapshot(tokenMint);
    await runtime.observeMarketSnapshot(tokenMint, market);
  };

  const handle = async (event: FeedEvent) => {
    if (configTransitioning) {
      throw new Error("Revival configuration is transitioning; retry this confirmed event");
    }
    const handlingConfig = config;
    if (!handlingConfig.enabled || event.kind !== "swap") return;
    const continuingCampaign = runtime.snapshot(event.tokenMint);
    const walletContinuesCampaign =
      continuingCampaign?.targetWallets.includes(event.wallet) === true;
    if (!handlingConfig.targetWallets.has(event.wallet) && !walletContinuesCampaign) return;
    if (event.tokenMint === WSOL_MINT || STABLECOIN_MINTS.has(event.tokenMint)) return;
    if (event.side === "sell" && !continuingCampaign) return;
    try {
      const amountUsd = await targetSwapValueUsd(event);
      if (configTransitioning || config !== handlingConfig) {
        throw new Error("Revival configuration changed during valuation; retry this event");
      }
      const verified =
        event.side === "buy"
          ? event.verifiedSwap === true
          : event.verifiedSwap === true && event.sellAttribution?.verified === true;
      const availableAtMs = Date.now();
      await runtime.observe({
        eventKey: `revival:target:${event.side}:${event.txSig}:${event.wallet}:${event.tokenMint}`,
        eventType: event.side === "buy" ? "TARGET_BUY" : "TARGET_SELL",
        tokenMint: event.tokenMint,
        eventAtMs: eventTimestampMs(event),
        availableAtMs,
        source: "rpc",
        txSig: event.txSig,
        slot: event.slot,
        targetWallet: event.wallet,
        verified,
        historical: eventTimestampMs(event) < availableAtMs - 15_000,
        amountTokens: Math.max(0, Number(event.amountTokens)),
        amountUsd,
        seedConfig: handlingConfig,
        metadata: {
          delivery: event.delivery ?? "catchup",
          verifiedSwap: event.verifiedSwap === true,
          sellAttributionVerified: event.sellAttribution?.verified === true,
          amountRaw: event.amountRaw ?? null,
          decimals: event.decimals,
        },
      });
      // Raw chain evidence is already durable. A transient market-provider
      // failure is recorded as a coverage snapshot and retried by the sweep;
      // it never makes the confirmed RPC cursor lose this transaction.
      if (runtime.snapshot(event.tokenMint)) await observeMarket(event.tokenMint);
      lastError = null;
    } catch (error) {
      lastError = safeDiagnostic(error);
      log.error(
        { error: lastError, kind: event.kind, mint: event.tokenMint },
        "Revival observation failed; trading worker is unaffected and cursor will retry",
      );
      throw error;
    }
  };

  const cursorStore = createSupabaseRpcCursorStore(
    db,
    env.HELIX_USER_ID,
    "revival_rpc_wallet_cursors",
  );
  const poller = new RpcBackfillPoller(rpc, handle, cursorStore, 1_000, true, {
    pollConcurrency: 4,
  });

  const applyWatches = async (_prior: RevivalObserverConfig, next: RevivalObserverConfig) => {
    if (!next.enabled) {
      for (const wallet of watchedTargets) poller.unwatch(wallet);
      watchedTargets = new Set();
      return;
    }
    const desiredTargets = new Set([
      ...next.targetWallets,
      ...(await store.loadActiveTargetWallets()),
    ]);
    for (const wallet of watchedTargets) {
      if (!desiredTargets.has(wallet)) poller.unwatch(wallet);
    }
    for (const wallet of desiredTargets) poller.watch(wallet);
    watchedTargets = desiredTargets;
  };

  await applyWatches(config, config);
  poller.start(config.enabled ? Array.from(watchedTargets) : []);

  setInterval(() => {
    if (configRefreshRunning) return;
    configRefreshRunning = true;
    void (async () => {
      let keepTransitionGate = configTransitioning;
      try {
        const next = await loadRevivalConfig();
        const configChanged =
          next.enabled !== config.enabled ||
          next.marketCapMinUsd !== config.marketCapMinUsd ||
          next.marketCapMaxUsd !== config.marketCapMaxUsd ||
          !sameTargets(next.targetWallets, config.targetWallets);
        const prior = config;
        const transitionNeeded = configChanged || configTransitioning;
        configTransitioning = transitionNeeded;
        keepTransitionGate = transitionNeeded;
        if (transitionNeeded) {
          // Watches must be fully applied before the new runtime/config object
          // becomes visible. The helper restores both sides on failure and
          // tells us when the gate must remain closed.
          config = await transitionRevivalObserverConfig({
            prior,
            next,
            applyWatches,
            applyRuntimeConfig: (candidate) => runtime.reconfigure(candidate),
          });
          keepTransitionGate = false;
        } else {
          await applyWatches(prior, prior);
        }
        if (configChanged) {
          log.info(
            {
              enabled: config.enabled,
              targetCount: config.targetWallets.size,
              seedMarketCapMinUsd: config.marketCapMinUsd,
              seedMarketCapMaxUsd: config.marketCapMaxUsd,
            },
            "Revival Shadow tracker configuration applied",
          );
        }
      } catch (error) {
        lastError = safeDiagnostic(error);
        if (error instanceof RevivalConfigTransitionError) {
          keepTransitionGate = !error.previousConfigurationRestored;
        }
        log.warn(
          { error: lastError, transitionGated: keepTransitionGate },
          keepTransitionGate
            ? "Revival config refresh failed; observation remains gated until watches recover"
            : "Revival config refresh failed; previous config retained",
        );
      } finally {
        configTransitioning = keepTransitionGate;
        configRefreshRunning = false;
      }
    })();
  }, 3_000);

  setInterval(() => {
    if (!config.enabled || configTransitioning || marketSweepRunning) return;
    marketSweepRunning = true;
    void (async () => {
      try {
        const mints = await runtime.activeCampaignMints();
        for (let offset = 0; offset < mints.length; offset += 3) {
          await Promise.all(mints.slice(offset, offset + 3).map(observeMarket));
        }
        lastError = null;
      } catch (error) {
        lastError = safeDiagnostic(error);
        log.warn({ error: lastError }, "Revival market sweep failed; next sweep will retry");
      } finally {
        marketSweepRunning = false;
      }
    })();
  }, 30_000);

  setInterval(() => {
    if (!config.enabled || configTransitioning || tickRunning) return;
    tickRunning = true;
    runtime
      .tick(Date.now())
      .catch((error) => {
        lastError = safeDiagnostic(error);
        log.warn({ error: lastError }, "Revival clock tick failed; state remains replayable");
      })
      .finally(() => {
        tickRunning = false;
      });
  }, 60_000);

  setInterval(() => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    const rpcHealth = poller.health();
    store
      .recordHeartbeat({
        startedAt,
        enabled: config.enabled,
        targetWalletCount: config.targetWallets.size,
        health: runtime.health(),
        rpcHealth,
        lastError: revivalObserverHeartbeatError(configTransitioning, lastError),
      })
      .catch((error) => {
        lastError = safeDiagnostic(error);
        log.warn({ error: lastError }, "Revival heartbeat write failed");
      })
      .finally(() => {
        heartbeatRunning = false;
      });
  }, 20_000);

  await store.recordHeartbeat({
    startedAt,
    enabled: config.enabled,
    targetWalletCount: config.targetWallets.size,
    health: runtime.health(),
    rpcHealth: poller.health(),
    lastError: revivalObserverHeartbeatError(configTransitioning, lastError),
  });
  log.info(
    {
      enabled: config.enabled,
      targetCount: config.targetWallets.size,
      seedMarketCapMinUsd: config.marketCapMinUsd,
      seedMarketCapMaxUsd: config.marketCapMaxUsd,
    },
    "Revival Campaign tracker started — SHADOW ONLY; no transaction capability",
  );
}

main().catch((error) => {
  log.fatal({ error: safeDiagnostic(error) }, "Revival observer failed during startup");
  process.exit(1);
});
