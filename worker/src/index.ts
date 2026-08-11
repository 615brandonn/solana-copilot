// Helix worker entrypoint. Long-running Node process. Deploy on a
// low-latency VPS geographically close to Jito block engine + your RPC.

import pino from "pino";
import { randomUUID } from "node:crypto";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { env } from "./env.js";
import { db, type BotConfigRow } from "./db.js";
import { GeyserFeed, type FeedEvent, type SwapEvent, type TransferEvent } from "./geyser.js";
import { FollowerMonitor } from "./monitor.js";
import { executeSwap, type ExecuteResult } from "./executor.js";
import { decryptPrivateKey } from "./crypto.js";
import { checkEntry, loadTokenMeta } from "./filters.js";
import { RpcBackfillPoller } from "./poller.js";
import { isMissingReadinessColumnError, toIsoTimestamp } from "./health.js";
import { priceUsd } from "./prices.js";
import {
  checkCoordinatedEntry,
  CoordinatedBuyTracker,
  inactivityDeadlineMs,
  shouldTriggerDistinctSellerExit,
  type TargetBuyObservation,
} from "./coordinated-mode.js";
import { isFlatPosition, proportionalMirrorSell } from "./follower-math.js";
import { safeDiagnostic } from "./diagnostics.js";
import {
  KeyedExecutionQueue,
  RecentAsyncResultCache,
  RecentEventDeduper,
} from "./event-deduper.js";
import { resolveTargetBuyValue } from "./target-buy-valuation.js";
import { quoteTokenSpendUsd } from "./token-spend-quote.js";
import {
  groupObservedFollowerTransfers,
  isEligibleFollowerWallet,
  walletTokenHoldings,
  type WalletTokenHolding,
  ZeroBalanceConfirmationTracker,
} from "./position-reconciliation.js";
import {
  observationFromEvent,
  StrategyRecorder,
  strategyReactionMs,
  type StrategyDecision,
  type StrategyObservationPatch,
} from "./strategy-recorder.js";

const log = pino({ level: env.LOG_LEVEL });
const WSOL = "So11111111111111111111111111111111111111112";
const STABLECOIN_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCo24RDUuUuJZq8bn6T", // USDT
]);
const rpc = new Connection(env.RPC_URL, { commitment: "processed" });
const followerRecipientEligibility = new Map<string, boolean>();

type CopyBuyOptions = {
  entryMode: "regular" | "coordinated";
  firstBuy: boolean;
  targetBuyUsd: number | undefined;
  coordinatedWallets?: string[];
};

async function isEligibleFollowerRecipient(address: string): Promise<boolean> {
  const cached = followerRecipientEligibility.get(address);
  if (cached !== undefined) return cached;
  try {
    const publicKey = new PublicKey(address);
    const account = await rpc.getAccountInfo(publicKey, "confirmed");
    const eligible = isEligibleFollowerWallet(address, account?.owner.toBase58() ?? null);
    if (followerRecipientEligibility.size >= 10_000) {
      followerRecipientEligibility.delete(followerRecipientEligibility.keys().next().value ?? "");
    }
    followerRecipientEligibility.set(address, eligible);
    return eligible;
  } catch (err) {
    log.warn(
      { address, err: safeDiagnostic(err) },
      "follower recipient classification failed — excluding unknown recipient",
    );
    return false;
  }
}

function configuredTargetWallets(config: BotConfigRow): string[] {
  return Array.from(
    new Set(
      [config.target_wallet ?? "", ...(config.additional_target_wallets ?? [])]
        .map((wallet) => wallet.trim())
        .filter(Boolean),
    ),
  );
}

async function loadConfig(userId: string): Promise<BotConfigRow | null> {
  const byUser = await db.from("bot_config").select("*").eq("user_id", userId).maybeSingle();
  if (byUser.error)
    throw new Error(`bot_config query failed: ${safeDiagnostic(byUser.error.message)}`);
  if (byUser.data) return byUser.data as BotConfigRow;
  const any = await db
    .from("bot_config")
    .select("*")
    .not("target_wallet", "is", null)
    .neq("target_wallet", "")
    .order("updated_at", { ascending: false })
    .limit(1);
  if (any.error)
    throw new Error(`bot_config identity check failed: ${safeDiagnostic(any.error.message)}`);
  const row = any.data?.[0];
  if (row) {
    throw new Error(
      "HELIX_USER_ID mismatch: worker identity does not match the configured dashboard row",
    );
  }
  return null;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loadSigner(userId: string): Promise<string | null> {
  const { data, error } = await db
    .from("funding_keys")
    .select("ciphertext")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`funding_keys query failed: ${error.message}`);
  if (!data) return null;
  return decryptPrivateKey(data.ciphertext);
}

type FundingWalletReadiness = {
  ready: boolean;
  walletPubkey: string | null;
  error: string | null;
  checkedAt: string;
};

async function checkFundingWalletReadiness(
  userId: string,
  fixedBuyUsd: number,
): Promise<FundingWalletReadiness> {
  const checkedAt = new Date().toISOString();
  try {
    const secret = await loadSigner(userId);
    if (!secret) {
      log.error({}, "readiness failed — no funding private key saved for this config user");
      return {
        ready: false,
        walletPubkey: null,
        error: "Funding key missing for worker user",
        checkedAt,
      };
    }

    const decoded = bs58.decode(secret.trim());
    if (decoded.length !== 64) {
      log.error(
        { decodedBytes: decoded.length },
        "readiness failed — funding private key is not a 64-byte Phantom/Solana secret key",
      );
      return {
        ready: false,
        walletPubkey: null,
        error: `Funding key decoded to ${decoded.length} bytes instead of 64`,
        checkedAt,
      };
    }

    const signer = Keypair.fromSecretKey(decoded);
    const walletPubkey = signer.publicKey.toBase58();
    try {
      const balanceLamports = await rpc.getBalance(signer.publicKey, "processed");
      const solBalance = balanceLamports / 1e9;
      log.info(
        {
          fundingWallet: walletPubkey,
          solBalance,
          fixedBuyUsd,
        },
        "funding wallet ready",
      );

      if (solBalance < 0.02) {
        log.warn(
          { fundingWallet: walletPubkey, solBalance },
          "funding wallet SOL balance is very low",
        );
      }
    } catch (err) {
      log.warn(
        { err, fundingWallet: walletPubkey },
        "funding key is valid but wallet balance check failed",
      );
    }
    return { ready: true, walletPubkey, error: null, checkedAt };
  } catch (err) {
    log.error({ err }, "readiness failed — could not decrypt/check funding wallet");
    return {
      ready: false,
      walletPubkey: null,
      error: err instanceof Error ? err.message : String(err),
      checkedAt,
    };
  }
}

async function waitForConfig(userId: string): Promise<BotConfigRow> {
  let logged = false;
  while (true) {
    try {
      const cfg = await loadConfig(userId);
      if (cfg?.target_wallet) {
        log.info({ targetCount: configuredTargetWallets(cfg).length }, "config loaded");
        return cfg;
      }
      if (!logged) {
        log.warn("no target wallet configured yet — polling every 5s");
        logged = true;
      }
    } catch (err) {
      log.error({ err }, "config unavailable — preserving worker and retrying in 5s");
    }
    await delay(5000);
  }
}

async function main() {
  const USER_ID = env.HELIX_USER_ID;
  let cfg = await waitForConfig(USER_ID);
  let fundingReadiness = await checkFundingWalletReadiness(cfg.user_id, cfg.fixed_buy_usd);

  const feed = new GeyserFeed(async (event) => handle(event));
  const poller = new RpcBackfillPoller(rpc, async (event) => handle(event));
  const monitor = new FollowerMonitor(feed, poller);
  const coordinatedBuys = new CoordinatedBuyTracker();
  const entryExecutionQueue = new KeyedExecutionQueue();
  const exitsInFlight = new Set<string>();
  const pendingTransfers = new Map<string, TransferEvent[]>();
  const targetBuyDeduper = new RecentEventDeduper();
  const targetBuyActivityAccounting = new RecentAsyncResultCache<void>();
  const targetFirstBuyAccounting = new RecentAsyncResultCache<boolean>();
  const uncertainEntryMints = new Set<string>();

  async function retryDb<T>(
    label: string,
    operation: () => PromiseLike<{ data: T; error: { message: string } | null }>,
    attempts = 4,
  ): Promise<T> {
    let lastError = "unknown database error";
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const result = await operation();
        if (!result.error) return result.data;
        lastError = safeDiagnostic(result.error.message);
      } catch (err) {
        lastError = safeDiagnostic(err);
      }
      if (attempt < attempts) {
        log.warn({ label, attempt, error: lastError }, "database operation failed — retrying");
        await delay(attempt * 500);
      }
    }
    throw new Error(`${label} failed after ${attempts} attempts: ${lastError}`);
  }

  let targetWallets = new Set(configuredTargetWallets(cfg));
  if (targetWallets.size === 0) throw new Error("config loaded without a target wallet");

  let lastStrategyRecorderErrorAt = 0;
  const strategyRecorder = new StrategyRecorder(
    async (rows) => {
      const { error } = await db.rpc("record_strategy_observations", { p_rows: rows });
      if (error)
        throw new Error(`strategy recorder batch failed: ${safeDiagnostic(error.message)}`);
    },
    {
      onError: (err) => {
        const now = Date.now();
        if (now - lastStrategyRecorderErrorAt < 30_000) return;
        lastStrategyRecorderErrorAt = now;
        log.warn(
          { err: safeDiagnostic(err) },
          "strategy recorder unavailable — trading continues and observations remain buffered",
        );
      },
      onDrop: (dropped) => {
        if (dropped === 1 || dropped % 100 === 0) {
          log.warn({ dropped }, "strategy recorder queue full — oldest observation dropped");
        }
      },
    },
  );
  strategyRecorder.start();

  function recordStrategyEvent(event: FeedEvent, patch: StrategyObservationPatch = {}) {
    const actor = event.kind === "swap" ? event.wallet : event.from;
    const position = monitor.activeForMint(event.tokenMint);
    const relationship = targetWallets.has(actor) ? "target" : position ? "follower" : "observed";
    const primaryTarget =
      cfg.target_wallet ?? position?.targetWallet ?? Array.from(targetWallets)[0];
    if (!primaryTarget) return;
    const additionalTarget = targetWallets.has(actor) && actor !== primaryTarget;
    strategyRecorder.record(
      observationFromEvent(
        event,
        {
          userId: cfg.user_id,
          targetWallet: primaryTarget,
          relationship,
          positionId: position?.positionId,
        },
        {
          ...patch,
          metadata: {
            ...(patch.metadata ?? {}),
            ...(additionalTarget ? { additionalTargetWallet: true } : {}),
          },
        },
      ),
    );
  }

  function recordStrategyDecision(
    event: FeedEvent,
    decision: StrategyDecision,
    reason: string,
    patch: StrategyObservationPatch = {},
  ) {
    recordStrategyEvent(event, {
      ...patch,
      bot_decision: decision,
      bot_reason: reason,
    });
  }

  async function releaseMonitoredPosition(positionId: string) {
    await monitor.releasePosition(positionId);
    // A target wallet can also appear in a transfer chain. Reassert target
    // subscriptions after releasing follower-only watches.
    for (const wallet of targetWallets) {
      await feed.watch(wallet);
      poller.watch(wallet);
    }
  }

  const zeroBalanceTracker = new ZeroBalanceConfirmationTracker();
  let latestWalletHoldings: WalletTokenHolding[] = [];
  type ObservedFollowerHolding = {
    token_mint: string;
    wallet: string;
    amount: number;
    decimals: number;
    source_target_count: number;
    last_updated: string;
  };
  let latestObservedFollowerHoldings: ObservedFollowerHolding[] = [];

  async function reconcileFlatWalletPositions() {
    if (!fundingReadiness.ready || !fundingReadiness.walletPubkey) return;
    const { data: positions, error } = await db
      .from("positions")
      .select("id,token_mint")
      .eq("user_id", cfg.user_id)
      .is("closed_at", null);
    if (error) throw new Error(`position reconciliation query failed: ${safeDiagnostic(error)}`);

    // Only a successful RPC snapshot advances the two-observation guard.
    latestWalletHoldings = await walletTokenHoldings(rpc, fundingReadiness.walletPubkey);
    const positiveMints = new Set(latestWalletHoldings.map((row) => row.token_mint));
    const confirmedFlat = zeroBalanceTracker.observe(positions ?? [], positiveMints);
    if (confirmedFlat.length === 0) return;

    const closedAt = new Date().toISOString();
    for (const positionId of confirmedFlat) {
      const { error: updateError } = await db
        .from("positions")
        .update({ amount_remaining: 0, closed_at: closedAt })
        .eq("id", positionId)
        .eq("user_id", cfg.user_id)
        .is("closed_at", null);
      if (updateError) {
        throw new Error(`position reconciliation update failed: ${safeDiagnostic(updateError)}`);
      }
      await releaseMonitoredPosition(positionId);
    }
    log.info(
      { closedPositionCount: confirmedFlat.length },
      "closed positions confirmed flat by consecutive wallet snapshots",
    );
  }

  async function refreshObservedFollowerHoldings() {
    if (latestWalletHoldings.length === 0) {
      latestObservedFollowerHoldings = [];
      return;
    }
    const heldMints = latestWalletHoldings.map((row) => row.token_mint);
    const targets = Array.from(targetWallets);
    const transfers: Array<{
      token_mint: string;
      to_wallet: string | null;
      from_wallet: string | null;
      event_at: string;
    }> = [];
    for (const tokenMint of heldMints) {
      for (const targetWallet of targets) {
        const rows = await retryDb<typeof transfers>(
          "load observed follower transfers",
          async () => {
            const result = await db
              .from("strategy_observations")
              .select("token_mint,to_wallet,from_wallet,event_at")
              .eq("user_id", cfg.user_id)
              .eq("token_mint", tokenMint)
              .eq("from_wallet", targetWallet)
              .eq("relationship", "target")
              .eq("event_kind", "transfer")
              .not("to_wallet", "is", null)
              .order("event_at", { ascending: false })
              .limit(500);
            return {
              data: (result.data ?? []) as typeof transfers,
              error: result.error,
            };
          },
        );
        transfers.push(...rows);
      }
    }

    const grouped = groupObservedFollowerTransfers(transfers, new Set(targets));
    const pending: typeof grouped = [];
    for (let offset = 0; offset < grouped.length; offset += 8) {
      const batch = grouped.slice(offset, offset + 8);
      const eligibility = await Promise.all(
        batch.map((row) => isEligibleFollowerRecipient(row.wallet)),
      );
      for (const [index, row] of batch.entries()) {
        if (eligibility[index]) pending.push(row);
      }
    }
    const refreshed: ObservedFollowerHolding[] = [];
    for (let offset = 0; offset < pending.length; offset += 8) {
      const batch = pending.slice(offset, offset + 8);
      const results = await Promise.allSettled(
        batch.map(async (row) => {
          const accounts = await rpc.getParsedTokenAccountsByOwner(
            new PublicKey(row.wallet),
            { mint: new PublicKey(row.tokenMint) },
            "confirmed",
          );
          let amount = 0;
          let decimals = 0;
          for (const account of accounts.value) {
            const info = account.account.data.parsed.info as {
              tokenAmount: { decimals?: number; uiAmountString?: string };
            };
            amount += Number(info.tokenAmount.uiAmountString ?? 0);
            decimals = Number(info.tokenAmount.decimals ?? decimals);
          }
          return {
            token_mint: row.tokenMint,
            wallet: row.wallet,
            amount: Math.max(0, amount),
            decimals,
            source_target_count: row.sourceTargets.length,
            last_updated: new Date().toISOString(),
          } satisfies ObservedFollowerHolding;
        }),
      );
      for (const result of results) {
        if (result.status === "fulfilled") refreshed.push(result.value);
      }
    }
    latestObservedFollowerHoldings = refreshed;
  }

  // Rehydrate any positions still open from a previous worker run so we keep
  // monitoring their followers across restarts.
  const openPositions = await retryDb<
    Array<{ id: string; token_mint: string; amount_remaining: number }> | null
  >("load open positions for follower recovery", () =>
    db
      .from("positions")
      .select("id,token_mint,amount_remaining")
      .eq("user_id", cfg.user_id)
      .is("closed_at", null),
  );
  for (const pos of openPositions ?? []) {
    if (Number(pos.amount_remaining) <= 0) continue;
    await monitor.onCopyBuy({
      positionId: pos.id,
      tokenMint: pos.token_mint,
      targetWallet: cfg.target_wallet ?? Array.from(targetWallets)[0],
    });
  }
  await monitor.reconcileFollowersFromDatabase();

  while (true) {
    try {
      await feed.start(Array.from(targetWallets));
      break;
    } catch (err) {
      log.error({ err }, "geyser start failed — retrying in 2s");
      await delay(2000);
    }
  }
  poller.start(Array.from(targetWallets));

  // A transient database/stream failure must not leave a persisted follower
  // wallet unmonitored for the rest of the worker's lifetime. Reconciliation
  // only restores missing watches; the hot sell path remains event-driven.
  setInterval(() => {
    monitor
      .reconcileFollowersFromDatabase()
      .catch((err) => log.error({ err: safeDiagnostic(err) }, "follower subscription repair failed"));
  }, 10_000);

  setInterval(async () => {
    try {
      const next = await loadConfig(cfg.user_id);
      if (!next?.target_wallet) return;
      const previousTargets = targetWallets;
      const nextTargets = new Set(configuredTargetWallets(next));
      cfg = next;
      for (const wallet of previousTargets) {
        if (nextTargets.has(wallet)) continue;
        await feed.unwatch(wallet);
        poller.unwatch(wallet);
      }
      for (const wallet of nextTargets) {
        if (previousTargets.has(wallet)) continue;
        await feed.watch(wallet);
        poller.watch(wallet);
      }
      targetWallets = nextTargets;
      if (Array.from(previousTargets).sort().join(",") !== Array.from(nextTargets).sort().join(","))
        log.info({ targets: Array.from(nextTargets) }, "target wallet subscriptions updated");
    } catch (err) {
      log.error({ err }, "config refresh failed");
    }
  }, 3000);

  setInterval(() => {
    log.info(
      {
        target: cfg.target_wallet,
        geyser: feed.health(),
        rpcFallback: poller.health(),
        strategyRecorder: strategyRecorder.health(),
      },
      "stream heartbeat",
    );
  }, 30000);

  const workerStartedAt = new Date().toISOString();

  async function writeWorkerHeartbeat() {
    const geyser = feed.health();
    const rpcFallback = poller.health();
    const baseHeartbeat = {
      user_id: cfg.user_id,
      target_wallet: cfg.target_wallet ?? null,
      started_at: workerStartedAt,
      updated_at: new Date().toISOString(),
      geyser_connected: Boolean(geyser.connected),
      last_geyser_message_at: toIsoTimestamp(geyser.lastMessageAt),
      decoded_event_count: Number(geyser.decodedEventCount ?? 0),
      rpc_last_poll_at: toIsoTimestamp(rpcFallback.lastPollAt),
    };
    const readinessHeartbeat = {
      ...baseHeartbeat,
      funding_key_ready: fundingReadiness.ready,
      funding_key_checked_at: fundingReadiness.checkedAt,
      funding_wallet_pubkey: fundingReadiness.walletPubkey,
      last_error: fundingReadiness.error,
      wallet_holdings: latestWalletHoldings,
      observed_follower_holdings: latestObservedFollowerHoldings,
    };
    let { error } = await db
      .from("worker_heartbeat")
      .upsert(readinessHeartbeat, { onConflict: "user_id" });

    if (error && isMissingReadinessColumnError(error.message)) {
      log.warn(
        { err: error },
        "heartbeat readiness columns missing — writing compatible base heartbeat",
      );
      ({ error } = await db
        .from("worker_heartbeat")
        .upsert(baseHeartbeat, { onConflict: "user_id" }));
    }

    if (error) throw new Error(`worker_heartbeat upsert failed: ${safeDiagnostic(error.message)}`);
  }

  await reconcileFlatWalletPositions().catch((err) =>
    log.error({ err: safeDiagnostic(err) }, "position reconciliation failed"),
  );
  await writeWorkerHeartbeat().catch((err) => log.error({ err }, "database heartbeat failed"));
  setInterval(() => {
    writeWorkerHeartbeat().catch((err) => log.error({ err }, "database heartbeat failed"));
  }, 20_000);
  setInterval(() => {
    checkFundingWalletReadiness(cfg.user_id, cfg.fixed_buy_usd)
      .then((next) => {
        fundingReadiness = next;
      })
      .catch((err) => log.error({ err }, "funding readiness refresh failed"));
  }, 60_000);
  refreshObservedFollowerHoldings().catch((err) =>
    log.error({ err: safeDiagnostic(err) }, "observed follower holdings refresh failed"),
  );
  setInterval(() => {
    reconcileFlatWalletPositions()
      .then(() => refreshObservedFollowerHoldings())
      .catch((err) => log.error({ err: safeDiagnostic(err) }, "wallet holdings refresh failed"));
  }, 60_000);

  // Take-profit / stop-loss watcher — polls prices every 4s for all open positions.
  setInterval(() => {
    checkTpSl().catch((err) => log.error({ err }, "tp/sl loop failed"));
  }, 4000);
  setInterval(() => {
    checkConfiguredPositionExits().catch((err) =>
      log.error({ err }, "configured position exit loop failed"),
    );
  }, 30_000);

  async function checkTpSl() {
    if (!cfg.take_profit_enabled && !cfg.stop_loss_enabled) return;
    const { data: positions } = await db
      .from("positions")
      .select(
        "id,token_mint,entry_price_usd,amount_tokens,amount_remaining,decimals,tp_taken,mirrored_sold_fraction,entry_mode",
      )
      .eq("user_id", cfg.user_id)
      .is("closed_at", null);
    for (const pos of positions ?? []) {
      if ((pos.entry_mode ?? "regular") === "coordinated") continue;
      const remaining = Number(pos.amount_remaining);
      const entry = Number(pos.entry_price_usd);
      if (remaining <= 0 || entry <= 0) continue;
      const price = await priceUsd(pos.token_mint);
      if (!price || price <= 0) continue;
      const gainPct = ((price - entry) / entry) * 100;

      if (cfg.stop_loss_enabled && gainPct <= -Math.abs(cfg.stop_loss_pct)) {
        const decimals = Number(pos.decimals ?? 0);
        const sellRaw = Math.floor(remaining * Math.pow(10, decimals));
        if (sellRaw <= 0) continue;
        log.warn(
          { positionId: pos.id, gainPct: gainPct.toFixed(2) },
          "stop-loss triggered — selling all",
        );
        await executeExitSell(
          pos.id,
          pos.token_mint,
          sellRaw,
          remaining,
          `stop-loss ${gainPct.toFixed(1)}%`,
        );
        continue;
      }

      if (cfg.take_profit_enabled && !pos.tp_taken && gainPct >= Math.abs(cfg.take_profit_pct)) {
        const sellFraction = Math.min(1, Math.max(0, Number(cfg.take_profit_sell_pct) / 100));
        const sellUi = remaining * sellFraction;
        const decimals = Number(pos.decimals ?? 0);
        const sellRaw = Math.floor(sellUi * Math.pow(10, decimals));
        if (sellRaw <= 0) continue;
        log.info(
          { positionId: pos.id, gainPct: gainPct.toFixed(2), sellFraction },
          "take-profit triggered",
        );
        await executeExitSell(
          pos.id,
          pos.token_mint,
          sellRaw,
          sellUi,
          `take-profit ${gainPct.toFixed(1)}%`,
          true,
        );
      }
    }
  }

  async function checkConfiguredPositionExits() {
    const { data: positions, error } = await db
      .from("positions")
      .select(
        "id,token_mint,amount_remaining,decimals,last_root_buy_at,opened_at,entry_mode,coordinated_exit_triggered,follower_seller_exit_triggered",
      )
      .eq("user_id", cfg.user_id)
      .is("closed_at", null);
    if (error) throw new Error(`configured position exit query failed: ${error.message}`);
    const nowMs = Date.now();
    for (const pos of positions ?? []) {
      if (exitsInFlight.has(pos.id) || Number(pos.amount_remaining) <= 0) continue;
      const coordinated = (pos.entry_mode ?? "regular") === "coordinated";
      const sellerExitEnabled = coordinated || Boolean(cfg.follower_seller_exit_enabled);
      const sellerExitTriggered = coordinated
        ? Boolean(pos.coordinated_exit_triggered)
        : Boolean(pos.follower_seller_exit_triggered);
      const requiredSellers = coordinated
        ? Number(cfg.coordinated_follower_sell_count)
        : Number(cfg.follower_seller_exit_count);
      const sellerExitPct = coordinated
        ? Number(cfg.coordinated_follower_sell_pct)
        : Number(cfg.follower_seller_exit_pct);
      if (sellerExitEnabled && !sellerExitTriggered) {
        const { count, error: sellerCountError } = await db
          .from("follower_wallets")
          .select("id", { count: "exact", head: true })
          .eq("position_id", pos.id)
          .not("first_sell_at", "is", null);
        if (sellerCountError) {
          throw new Error(`seller-count query failed: ${sellerCountError.message}`);
        }
        if (shouldTriggerDistinctSellerExit(Number(count ?? 0), requiredSellers, false)) {
          await executePercentageExit(
            pos.id,
            pos.token_mint,
            Number(pos.amount_remaining),
            Number(pos.decimals ?? 0),
            sellerExitPct,
            `${coordinated ? "coordinated" : "main"} ${count ?? 0} distinct follower seller(s) (retry check)`,
            coordinated ? "coordinated" : "main-follower",
          );
          continue;
        }
      }
      const inactivityEnabled = coordinated || Boolean(cfg.target_inactivity_exit_enabled);
      if (!inactivityEnabled) continue;
      const inactivityHours = coordinated
        ? Number(cfg.coordinated_inactivity_hours)
        : Number(cfg.target_inactivity_hours);
      const deadline = inactivityDeadlineMs(pos.last_root_buy_at ?? pos.opened_at, inactivityHours);
      if (deadline === undefined || nowMs < deadline) continue;
      await executePercentageExit(
        pos.id,
        pos.token_mint,
        Number(pos.amount_remaining),
        Number(pos.decimals ?? 0),
        100,
        `${coordinated ? "coordinated" : "main"} target inactivity ${inactivityHours}h`,
        coordinated ? "coordinated" : "none",
      );
    }
  }

  async function executeExitSell(
    positionId: string,
    mint: string,
    sellRaw: number,
    sellUi: number,
    reason: string,
    markTpTaken = false,
    markCoordinatedExit = false,
    markFollowerSellerExit = false,
    strategyEvent?: SwapEvent,
  ): Promise<ExecuteResult | null> {
    if (exitsInFlight.has(positionId)) return null;
    exitsInFlight.add(positionId);
    try {
      const secret = await loadSigner(cfg.user_id);
      if (!secret) {
        log.error("no funding key for tp/sl sell");
        if (strategyEvent) {
          recordStrategyDecision(strategyEvent, "failed", "funding key is not available for sell", {
            position_id: positionId,
          });
        }
        return null;
      }
      if (strategyEvent) {
        recordStrategyDecision(strategyEvent, "mirror_submitted", reason, {
          position_id: positionId,
        });
      }
      const result = await executeSwap({
        signerSecret: secret,
        inputMint: mint,
        outputMint: WSOL,
        amountLamports: sellRaw,
        slippageBps: 500,
        route: cfg.execution_route,
        jitoTipSol: cfg.jito_tip_sol,
      });
      if (strategyEvent) {
        recordStrategyDecision(strategyEvent, "mirrored", "follower-triggered exit landed", {
          position_id: positionId,
          bot_tx_sig: result.txSig,
          reaction_ms: strategyReactionMs(strategyEvent, Date.now(), result.latencyMs),
          execution_ms: result.latencyMs,
          metadata: { persistencePending: true },
        });
      }
      const cur = await retryDb<{ amount_remaining: number } | null>(
        "load position after exit",
        () => db.from("positions").select("amount_remaining").eq("id", positionId).maybeSingle(),
      );
      if (!cur) throw new Error(`position ${positionId} disappeared after exit transaction landed`);
      const newRemaining = Math.max(0, Number(cur.amount_remaining) - sellUi);
      const closed = isFlatPosition(newRemaining);
      const update: {
        amount_remaining: number;
        closed_at: string | null;
        tp_taken?: boolean;
        coordinated_exit_triggered?: boolean;
        follower_seller_exit_triggered?: boolean;
      } = {
        amount_remaining: newRemaining,
        closed_at: closed ? new Date().toISOString() : null,
      };
      if (markTpTaken) update.tp_taken = true;
      if (markCoordinatedExit) update.coordinated_exit_triggered = true;
      if (markFollowerSellerExit) update.follower_seller_exit_triggered = true;
      await retryDb("save position after exit", () =>
        db.from("positions").update(update).eq("id", positionId),
      );
      await retryDb("save exit trade", () =>
        db.from("trades").insert({
          user_id: cfg.user_id,
          position_id: positionId,
          side: "sell",
          token_mint: mint,
          amount_tokens: sellUi,
          tx_sig: result.txSig,
          reason,
          latency_ms: result.latencyMs,
          route: result.route,
        }),
      );
      log.info({ sig: result.txSig, reason, closed }, "exit sell landed");
      if (closed) await releaseMonitoredPosition(positionId);
      if (strategyEvent) {
        recordStrategyDecision(
          strategyEvent,
          "mirrored",
          "follower-triggered exit landed and saved",
          {
            position_id: positionId,
            bot_tx_sig: result.txSig,
            reaction_ms: strategyReactionMs(strategyEvent, Date.now(), result.latencyMs),
            execution_ms: result.latencyMs,
            metadata: { persistencePending: false, closed },
          },
        );
      }
      return result;
    } finally {
      exitsInFlight.delete(positionId);
    }
  }

  async function executePercentageExit(
    positionId: string,
    mint: string,
    remaining: number,
    decimals: number,
    sellPct: number,
    reason: string,
    trigger: "coordinated" | "main-follower" | "none",
    strategyEvent?: SwapEvent,
  ): Promise<ExecuteResult | null> {
    if (exitsInFlight.has(positionId)) return null;
    const sellFraction = Math.min(1, Math.max(0, Number(sellPct) / 100));
    const sellUi = remaining * sellFraction;
    const sellRaw = Math.floor(sellUi * Math.pow(10, decimals));
    if (sellRaw <= 0 || sellUi <= 0) return null;
    log.warn({ positionId, mint, sellPct, reason }, "configured exit triggered");
    return executeExitSell(
      positionId,
      mint,
      sellRaw,
      sellUi,
      reason,
      false,
      trigger === "coordinated",
      trigger === "main-follower",
      strategyEvent,
    );
  }

  async function handle(event: FeedEvent) {
    // This is bounded in-memory work. Supabase persistence happens on the
    // recorder timer and cannot delay the serial Geyser hot path.
    recordStrategyEvent(event);
    try {
      if (event.kind === "transfer") return handleTransfer(event);
      if (event.kind === "swap") {
        if (targetWallets.has(event.wallet) && event.side === "buy") {
          await handleTargetBuy(event);
          return;
        }
        if (event.side === "sell") return handleFollowerSell(event);
        log.info(
          {
            eventWallet: event.wallet,
            targets: Array.from(targetWallets),
            side: event.side,
            mint: event.tokenMint,
            txSig: event.txSig,
          },
          "swap event ignored — not target buy or follower sell",
        );
        recordStrategyDecision(event, "tracked", "observed wallet buy outside target entry flow");
      }
    } catch (err) {
      recordStrategyDecision(event, "failed", safeDiagnostic(err));
      log.error({ err }, "handler failed");
    }
  }

  async function observeTargetFirstBuy(targetWallet: string, tokenMint: string): Promise<boolean> {
    const { data: prior, error } = await db
      .from("target_traded_tokens")
      .select("token_mint")
      .eq("target_wallet", targetWallet)
      .eq("token_mint", tokenMint)
      .maybeSingle();
    if (error) throw new Error(`target first-buy lookup failed: ${error.message}`);
    if (prior) return false;
    const { error: insertError } = await db
      .from("target_traded_tokens")
      .upsert({ target_wallet: targetWallet, token_mint: tokenMint });
    if (insertError) throw new Error(`target first-buy record failed: ${insertError.message}`);
    return true;
  }

  async function recordOpenPositionTargetBuy(event: SwapEvent) {
    const { data: pos, error } = await db
      .from("positions")
      .select("id,root_buy_count")
      .eq("user_id", cfg.user_id)
      .eq("token_mint", event.tokenMint)
      .is("closed_at", null)
      .order("opened_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`open-position target-buy lookup failed: ${error.message}`);
    if (!pos) return;
    const { error: updateError } = await db
      .from("positions")
      .update({
        root_buy_count: Number(pos.root_buy_count ?? 0) + 1,
        last_root_buy_at: new Date(event.timestampMs).toISOString(),
        last_root_buy_wallet: event.wallet,
      })
      .eq("id", pos.id);
    if (updateError) throw new Error(`target-buy activity update failed: ${updateError.message}`);
  }

  async function handleTargetBuy(event: SwapEvent) {
    if (event.tokenMint === WSOL || STABLECOIN_MINTS.has(event.tokenMint)) {
      recordStrategyDecision(event, "skipped", "output is SOL or a stablecoin");
      return;
    }
    const transactionId = event.txSig || `slot-${event.slot}`;
    const dedupeKey = `${event.wallet}:${transactionId}:${event.tokenMint}`;
    if (event.inferredRecipients?.length) {
      const recipientChecks = await Promise.all(
        event.inferredRecipients.map((recipient) => isEligibleFollowerRecipient(recipient)),
      );
      if (recipientChecks.some((eligible) => !eligible)) {
        log.info(
          {
            wallet: event.wallet,
            mint: event.tokenMint,
            txSig: event.txSig,
            recipientCount: event.inferredRecipients.length,
          },
          "inferred target buy rejected — output recipient is not an eligible external wallet",
        );
        recordStrategyDecision(
          event,
          "skipped",
          "inferred output recipient is program controlled, off-curve, or unavailable",
        );
        return;
      }
    }

    // Preserve first-buy and inactivity accounting even when valuation is
    // temporarily unavailable, but share it across Geyser/RPC copies.
    await targetBuyActivityAccounting.getOrCreate(dedupeKey, () =>
      recordOpenPositionTargetBuy(event),
    );
    const firstBuy = await targetFirstBuyAccounting.getOrCreate(dedupeKey, () =>
      observeTargetFirstBuy(event.wallet, event.tokenMint),
    );

    const valuation = await resolveTargetBuyValue(event, {
      quoteTokenSpendUsd,
      solPriceUsd: () => priceUsd(WSOL),
    });
    const targetBuyUsd = valuation.amountUsd;
    event.amountUsd = targetBuyUsd;
    recordStrategyEvent(event, {
      amount_usd: targetBuyUsd,
      metadata: {
        valuationSource: valuation.source,
        inputMint: event.spentToken?.mint,
      },
    });
    log.info(
      {
        wallet: event.wallet,
        mint: event.tokenMint,
        txSig: event.txSig,
        valuationSource: valuation.source,
        targetBuyUsd: targetBuyUsd === undefined ? "unknown" : Number(targetBuyUsd.toFixed(2)),
        inputMint: event.spentToken?.mint,
      },
      "target buy value resolved",
    );

    const requiresKnownValue = cfg.coordinated_mode_enabled
      ? true
      : Number(cfg.min_target_buy_usd) > 0;
    if (requiresKnownValue && targetBuyUsd === undefined) {
      log.info(
        { wallet: event.wallet, mint: event.tokenMint, txSig: event.txSig },
        "target buy value unavailable — waiting for a richer duplicate observation",
      );
      recordStrategyDecision(event, "filtered", "target buy size unavailable", {
        metadata: { valuationSource: valuation.source },
      });
      return;
    }

    if (!targetBuyDeduper.claim(dedupeKey, event.timestampMs)) {
      log.info(
        { wallet: event.wallet, mint: event.tokenMint, txSig: event.txSig },
        "duplicate target buy observation ignored",
      );
      return;
    }

    // A proven pre-submission failure may be retried by the other feed. Once a
    // submission is possible or uncertain, retain the claim to prevent a
    // duplicate purchase.
    try {
      await processTargetBuy(event, targetBuyUsd, firstBuy);
    } catch (err) {
      if (!uncertainEntryMints.has(event.tokenMint)) {
        targetBuyDeduper.release(dedupeKey);
      }
      throw err;
    }
  }

  async function processTargetBuy(
    event: SwapEvent,
    targetBuyUsd: number | undefined,
    firstBuy: boolean,
  ) {
    if (!cfg.enabled) {
      log.info(
        { wallet: event.wallet, mint: event.tokenMint },
        "entries off — target buy observed but not copied",
      );
      recordStrategyDecision(event, "skipped", "new entries disabled");
      return;
    }

    if (!cfg.coordinated_mode_enabled) {
      await tryCopyBuy(event, "target copy buy", {
        entryMode: "regular",
        firstBuy,
        targetBuyUsd,
      });
      return;
    }

    const observation: TargetBuyObservation = {
      wallet: event.wallet,
      tokenMint: event.tokenMint,
      amountUsd: targetBuyUsd,
      firstBuy,
      timestampMs: event.timestampMs,
      txSig: event.txSig,
      slot: event.slot,
      decimals: event.decimals,
    };
    const coordination = coordinatedBuys.record(cfg, observation);
    if (!coordination.ready) {
      log.info(
        {
          wallet: event.wallet,
          mint: event.tokenMint,
          reason: coordination.reason,
          qualifyingWallets: coordination.qualifyingWallets,
          requiredWallets: cfg.coordinated_target_wallet_count,
        },
        "coordinated buy waiting / filtered",
      );
      recordStrategyDecision(
        event,
        coordination.reason.startsWith("waiting for") ? "tracked" : "filtered",
        coordination.reason,
        {
          metadata: {
            entryMode: "coordinated",
            qualifyingWallets: coordination.qualifyingWallets,
            requiredWallets: cfg.coordinated_target_wallet_count,
          },
        },
      );
      return;
    }

    await tryCopyBuy(event, `coordinated ${coordination.observations.length}-wallet copy buy`, {
      entryMode: "coordinated",
      firstBuy,
      targetBuyUsd,
      coordinatedWallets: coordination.observations.map((row) => row.wallet),
    });
  }

  async function handleTransfer(ev: TransferEvent) {
    if (!(await isEligibleFollowerRecipient(ev.to))) {
      log.info(
        { from: ev.from, to: ev.to, mint: ev.tokenMint, txSig: ev.txSig },
        "program-controlled or off-curve transfer recipient excluded from follower monitoring",
      );
      recordStrategyDecision(ev, "skipped", "transfer recipient is not an eligible wallet");
      return;
    }
    const ctx = monitor.activeForMint(ev.tokenMint);
    if (!targetWallets.has(ev.from)) {
      if (ctx) {
        const tracked = await monitor.recordChainedTransfer(
          ev.tokenMint,
          ev.from,
          ev.to,
          ev.amountTokens,
          {
            txSig: ev.txSig,
            slot: ev.slot,
          },
        );
        recordStrategyDecision(
          ev,
          tracked ? "tracked" : "skipped",
          tracked ? "follower transfer retained" : "follower transfer not attributable",
          { position_id: ctx.positionId },
        );
      } else {
        recordStrategyDecision(ev, "skipped", "no active copied position for transfer");
      }
      return;
    }
    if (ctx) {
      const tracked = await monitor.recordTransfer(ctx.positionId, ev.to, ev.amountTokens, {
        hopDepth: 1,
        parentWallet: ev.from,
        txSig: ev.txSig,
        slot: ev.slot,
      });
      recordStrategyDecision(
        ev,
        tracked ? "tracked" : "skipped",
        tracked ? "target transfer wallet retained" : "duplicate target transfer ignored",
        { position_id: ctx.positionId },
      );
      return;
    }

    if (cfg.coordinated_mode_enabled) {
      const windowMs = Math.max(1, Number(cfg.coordinated_window_seconds)) * 1000;
      const recent = (pendingTransfers.get(ev.tokenMint) ?? []).filter(
        (row) => ev.timestampMs - row.timestampMs <= windowMs,
      );
      recent.push(ev);
      pendingTransfers.set(ev.tokenMint, recent);
      log.info(
        { from: ev.from, to: ev.to, mint: ev.tokenMint },
        "coordinated transfer held pending an entry",
      );
      recordStrategyDecision(ev, "tracked", "coordinated transfer held pending an entry");
      return;
    }

    log.info(
      { from: ev.from, to: ev.to, mint: ev.tokenMint, txSig: ev.txSig },
      "target transfer observed without a verified swap — not treated as an entry",
    );
    recordStrategyDecision(ev, "tracked", "target transfer observed without an open position");
  }

  async function handleFollowerSell(ev: SwapEvent) {
    const ctx = monitor.activeForMint(ev.tokenMint);
    if (!ctx) {
      recordStrategyDecision(ev, "skipped", "no active copied position for this token");
      return;
    }
    if (targetWallets.has(ev.wallet)) {
      recordStrategyDecision(ev, "tracked", "direct target sell observed", {
        position_id: ctx.positionId,
      });
      return; // Only follower wallets drive the mirror
    }

    const sellState = await monitor.recordFollowerSell(ctx.positionId, ev.wallet, ev.amountTokens, {
      txSig: ev.txSig,
      slot: ev.slot,
    });
    if (sellState === null) {
      recordStrategyDecision(ev, "skipped", "sell wallet is not retained or event is duplicate", {
        position_id: ctx.positionId,
      });
      return;
    }

    const { data: pos } = await db
      .from("positions")
      .select(
        "id,token_mint,amount_tokens,amount_remaining,decimals,mirrored_sold_fraction,entry_mode,coordinated_exit_triggered,follower_seller_exit_triggered",
      )
      .eq("id", ctx.positionId)
      .maybeSingle();
    if (!pos) {
      recordStrategyDecision(ev, "failed", "active position could not be loaded", {
        position_id: ctx.positionId,
      });
      return;
    }

    if ((pos.entry_mode ?? "regular") === "coordinated") {
      if (pos.coordinated_exit_triggered) {
        recordStrategyDecision(ev, "tracked", "coordinated follower exit already triggered", {
          position_id: pos.id,
        });
        return;
      }
      if (
        !shouldTriggerDistinctSellerExit(
          sellState.distinctSellerCount,
          Number(cfg.coordinated_follower_sell_count),
          false,
        )
      ) {
        log.info(
          {
            positionId: pos.id,
            distinctSellerCount: sellState.distinctSellerCount,
            required: cfg.coordinated_follower_sell_count,
          },
          "coordinated follower exit waiting",
        );
        recordStrategyDecision(ev, "tracked", "waiting for coordinated follower-seller threshold", {
          position_id: pos.id,
          metadata: { distinctSellerCount: sellState.distinctSellerCount },
        });
        return;
      }
      const exitReason = `coordinated ${sellState.distinctSellerCount} distinct follower seller(s)`;
      await executePercentageExit(
        pos.id,
        pos.token_mint,
        Number(pos.amount_remaining),
        Number(pos.decimals ?? 0),
        Number(cfg.coordinated_follower_sell_pct),
        exitReason,
        "coordinated",
        ev,
      );
      return;
    }

    if (cfg.follower_seller_exit_enabled && !pos.follower_seller_exit_triggered) {
      const thresholdReached = shouldTriggerDistinctSellerExit(
        sellState.distinctSellerCount,
        Number(cfg.follower_seller_exit_count),
        false,
      );
      if (!thresholdReached) {
        log.info(
          {
            positionId: pos.id,
            distinctSellerCount: sellState.distinctSellerCount,
            required: cfg.follower_seller_exit_count,
          },
          "main follower exit waiting",
        );
        recordStrategyDecision(ev, "tracked", "waiting for follower-seller threshold", {
          position_id: pos.id,
          metadata: { distinctSellerCount: sellState.distinctSellerCount },
        });
      } else {
        const exitReason = `main ${sellState.distinctSellerCount} distinct follower seller(s)`;
        await executePercentageExit(
          pos.id,
          pos.token_mint,
          Number(pos.amount_remaining),
          Number(pos.decimals ?? 0),
          Number(cfg.follower_seller_exit_pct),
          exitReason,
          "main-follower",
          ev,
        );
        return;
      }
    }

    if (!cfg.proportional_follower_sells) {
      recordStrategyDecision(
        ev,
        "tracked",
        "follower sell recorded; proportional mirroring is off",
        {
          position_id: pos.id,
        },
      );
      return;
    }

    const sellUi = proportionalMirrorSell(
      Number(pos.amount_tokens),
      Number(pos.amount_remaining),
      sellState.soldFraction,
    );
    if (sellUi <= 0) {
      recordStrategyDecision(ev, "tracked", "follower sell required no additional mirror amount", {
        position_id: pos.id,
      });
      return;
    }

    const decimals = Number(pos.decimals ?? 0);
    const sellRaw = Math.floor(sellUi * Math.pow(10, decimals));
    if (sellRaw <= 0) {
      recordStrategyDecision(ev, "tracked", "calculated mirror amount rounded to zero", {
        position_id: pos.id,
      });
      return;
    }

    log.info(
      { positionId: pos.id, soldFraction: sellState.soldFraction, sellUi, sellRaw },
      "mirroring follower sell",
    );
    await executeMirrorSell(
      pos.id,
      pos.token_mint,
      sellRaw,
      sellUi,
      sellState.soldFraction,
      ctx,
      ev,
    );
  }

  async function executeMirrorSell(
    positionId: string,
    mint: string,
    sellRaw: number,
    sellUi: number,
    soldFraction: number,
    ctx: { positionId: string; tokenMint: string; targetWallet: string },
    strategyEvent: SwapEvent,
  ): Promise<ExecuteResult | null> {
    if (exitsInFlight.has(positionId)) return null;
    exitsInFlight.add(positionId);
    try {
      const secret = await loadSigner(cfg.user_id);
      if (!secret) {
        log.error("no funding key for sell");
        recordStrategyDecision(strategyEvent, "failed", "funding key is not available for sell", {
          position_id: positionId,
        });
        return null;
      }

      recordStrategyDecision(
        strategyEvent,
        "mirror_submitted",
        "proportional follower sell submitted",
        {
          position_id: positionId,
          metadata: { soldFraction },
        },
      );
      const result = await executeSwap({
        signerSecret: secret,
        inputMint: mint,
        outputMint: WSOL,
        amountLamports: sellRaw,
        slippageBps: 500,
        route: cfg.execution_route,
        jitoTipSol: cfg.jito_tip_sol,
      });
      recordStrategyDecision(strategyEvent, "mirrored", "proportional follower sell landed", {
        position_id: positionId,
        bot_tx_sig: result.txSig,
        reaction_ms: strategyReactionMs(strategyEvent, Date.now(), result.latencyMs),
        execution_ms: result.latencyMs,
        metadata: { soldFraction, persistencePending: true },
      });

      const currentPosition = await retryDb<{ amount_remaining: number } | null>(
        "load position after mirror sell",
        () => db.from("positions").select("amount_remaining").eq("id", positionId).maybeSingle(),
      );
      if (!currentPosition) {
        throw new Error(`position ${positionId} disappeared after mirror sell landed`);
      }
      const newRemaining = Math.max(0, Number(currentPosition.amount_remaining) - sellUi);
      const closed = isFlatPosition(newRemaining);
      await retryDb("save position after mirror sell", () =>
        db
          .from("positions")
          .update({
            amount_remaining: newRemaining,
            mirrored_sold_fraction: soldFraction,
            closed_at: closed ? new Date().toISOString() : null,
          })
          .eq("id", positionId),
      );

      await retryDb("save mirror-sell trade", () =>
        db.from("trades").insert({
          user_id: cfg.user_id,
          position_id: positionId,
          side: "sell",
          token_mint: mint,
          amount_tokens: sellUi,
          tx_sig: result.txSig,
          reason: `mirror ${Math.round(soldFraction * 100)}% followers`,
          latency_ms: result.latencyMs,
          route: result.route,
        }),
      );

      log.info({ sig: result.txSig, ms: result.latencyMs, closed }, "mirror sell landed");
      if (closed) await releaseMonitoredPosition(positionId);
      recordStrategyDecision(
        strategyEvent,
        "mirrored",
        "proportional follower sell landed and saved",
        {
          position_id: positionId,
          bot_tx_sig: result.txSig,
          reaction_ms: strategyReactionMs(strategyEvent, Date.now(), result.latencyMs),
          execution_ms: result.latencyMs,
          metadata: { soldFraction, persistencePending: false, closed },
        },
      );
      return result;
    } finally {
      exitsInFlight.delete(positionId);
    }
  }

  async function tryCopyBuy(
    event: SwapEvent,
    reason = "target copy buy",
    options: CopyBuyOptions,
  ): Promise<string | null> {
    if (!cfg.enabled) {
      recordStrategyDecision(event, "skipped", "new entries disabled");
      return null;
    }
    return entryExecutionQueue.run(event.tokenMint, () => tryCopyBuyLocked(event, reason, options));
  }

  async function tryCopyBuyLocked(
    event: SwapEvent,
    reason: string,
    options: CopyBuyOptions,
  ): Promise<string | null> {
    if (!cfg.enabled) {
      log.info(
        { mint: event.tokenMint, txSig: event.txSig },
        "entry cancelled after queue wait — Entries is OFF",
      );
      recordStrategyDecision(event, "skipped", "Entries turned off while entry was queued");
      return null;
    }
    if (uncertainEntryMints.has(event.tokenMint)) {
      log.error(
        { mint: event.tokenMint, txSig: event.txSig },
        "entry blocked — an earlier submission for this coin needs reconciliation",
      );
      recordStrategyDecision(event, "skipped", "coin quarantined after an uncertain submission");
      return null;
    }
    if (event.tokenMint === WSOL || STABLECOIN_MINTS.has(event.tokenMint)) {
      log.info(
        { mint: event.tokenMint, txSig: event.txSig },
        "target buy skipped — output is SOL/stablecoin, not a token entry",
      );
      recordStrategyDecision(event, "skipped", "output is SOL or a stablecoin");
      return null;
    }

    log.info(
      {
        target: event.wallet,
        coordinatedWallets: options.coordinatedWallets,
        entryMode: options.entryMode,
        mint: event.tokenMint,
        tokenAmount: event.amountTokens,
        solDelta: event.solDelta,
        txSig: event.txSig,
        reason,
      },
      "target buy candidate",
    );

    const { data: openPosition, error: openPositionError } = await db
      .from("positions")
      .select("id")
      .eq("user_id", cfg.user_id)
      .eq("token_mint", event.tokenMint)
      .is("closed_at", null)
      .limit(1)
      .maybeSingle();
    if (openPositionError)
      throw new Error(`open-position entry check failed: ${openPositionError.message}`);
    if (openPosition) {
      log.info(
        { mint: event.tokenMint, positionId: openPosition.id },
        "entry skipped — position already open for coin",
      );
      recordStrategyDecision(event, "skipped", "a copied position for this token is already open", {
        position_id: openPosition.id,
      });
      return null;
    }

    const meta = await loadTokenMeta(event.tokenMint);
    const metaPatch: StrategyObservationPatch = {
      market_cap_usd: meta.marketCapUsd,
      liquidity_usd: meta.liquidityUsd,
      has_socials: Boolean(meta.socials.website || meta.socials.twitter || meta.socials.telegram),
      metadata: {
        entryMode: options.entryMode,
        pairCreatedAtMs: meta.pairCreatedAtMs,
        isPumpFun: meta.isPumpFun,
        firstBuy: options.firstBuy,
      },
    };
    recordStrategyEvent(event, metaPatch);
    const { data: prior, error: priorError } = await db
      .from("traded_tokens")
      .select("token_mint")
      .eq("user_id", cfg.user_id)
      .eq("token_mint", event.tokenMint)
      .maybeSingle();
    if (priorError) throw new Error(`traded-token lookup failed: ${priorError.message}`);

    const decision =
      options.entryMode === "coordinated"
        ? checkCoordinatedEntry(cfg, meta, Boolean(prior), event.timestampMs)
        : checkEntry(cfg, event, meta, { first: options.firstBuy, already: Boolean(prior) });
    if (!decision.pass) {
      log.info(
        {
          reason: decision.reason,
          entryMode: options.entryMode,
          mint: event.tokenMint,
          targetBuyUsd:
            options.targetBuyUsd === undefined ? "unknown" : options.targetBuyUsd.toFixed(2),
          meta,
        },
        "filtered",
      );
      recordStrategyDecision(event, "filtered", decision.reason, {
        ...metaPatch,
        amount_usd: options.targetBuyUsd,
        metadata: {
          ...metaPatch.metadata,
          alreadyTraded: Boolean(prior),
        },
      });
      return null;
    }

    {
      let secret: string | null = null;
      try {
        secret = await loadSigner(cfg.user_id);
      } catch (err) {
        log.error({ err, user_id: cfg.user_id }, "funding key decrypt failed for copy buy");
        recordStrategyDecision(event, "failed", "funding key could not be loaded", metaPatch);
        return null;
      }
      if (!secret) {
        log.error({ user_id: cfg.user_id }, "no funding key saved for this config user");
        recordStrategyDecision(event, "failed", "funding key is not available", metaPatch);
        return null;
      }

      const solPrice = await priceUsd(WSOL);
      if (solPrice === undefined) {
        log.error({ mint: event.tokenMint }, "copy buy blocked — live SOL/USD price unavailable");
        recordStrategyDecision(event, "failed", "live SOL/USD price is unavailable", metaPatch);
        return null;
      }
      const buyUsd =
        options.entryMode === "coordinated"
          ? Number(cfg.coordinated_fixed_buy_usd)
          : Number(cfg.fixed_buy_usd);
      const amountLamports = Math.floor((buyUsd / solPrice) * 1e9);
      if (!cfg.enabled) {
        log.info(
          { mint: event.tokenMint, txSig: event.txSig },
          "entry cancelled immediately before submission — Entries is OFF",
        );
        recordStrategyDecision(
          event,
          "skipped",
          "Entries turned off immediately before submission",
          metaPatch,
        );
        return null;
      }
      log.info(
        {
          mint: event.tokenMint,
          buyUsd,
          entryMode: options.entryMode,
          solPrice,
          amountLamports,
          route: cfg.execution_route,
        },
        "submitting copy buy",
      );
      recordStrategyDecision(event, "copy_submitted", reason, {
        ...metaPatch,
        amount_usd: options.targetBuyUsd,
        metadata: {
          ...metaPatch.metadata,
          configuredBuyUsd: buyUsd,
          route: cfg.execution_route,
        },
      });

      let result: ExecuteResult;
      try {
        result = await executeSwap({
          signerSecret: secret,
          inputMint: WSOL,
          outputMint: event.tokenMint,
          amountLamports,
          slippageBps: 300,
          route: cfg.execution_route,
          jitoTipSol: cfg.jito_tip_sol,
          outputDecimals: event.decimals,
        });
      } catch (err) {
        uncertainEntryMints.add(event.tokenMint);
        recordStrategyDecision(
          event,
          "failed",
          "copy submission failed or landing is uncertain; coin quarantined",
          {
            ...metaPatch,
            amount_usd: options.targetBuyUsd,
            reaction_ms: strategyReactionMs(event),
            metadata: {
              ...metaPatch.metadata,
              diagnostic: safeDiagnostic(err),
              quarantined: true,
            },
          },
        );
        log.error(
          { err, mint: event.tokenMint, amountLamports, route: cfg.execution_route },
          "copy buy failed or landing is uncertain — coin quarantined",
        );
        return null;
      }
      uncertainEntryMints.add(event.tokenMint);
      recordStrategyDecision(event, "copied", "copy buy landed; saving position", {
        ...metaPatch,
        amount_usd: options.targetBuyUsd,
        bot_tx_sig: result.txSig,
        reaction_ms: strategyReactionMs(event, Date.now(), result.latencyMs),
        execution_ms: result.latencyMs,
        metadata: {
          ...metaPatch.metadata,
          configuredBuyUsd: buyUsd,
          receivedTokens: result.outUiAmount,
          route: result.route,
          persistencePending: true,
        },
      });

      const receivedUi = result.outUiAmount ?? 0;
      const entryPrice =
        receivedUi > 0 ? buyUsd / receivedUi : ((await priceUsd(event.tokenMint)) ?? 0);
      const targetBuyAt = new Date(event.timestampMs).toISOString();

      const positionId = randomUUID();
      const pos = await retryDb<{ id: string } | null>("save landed copy-buy position", () =>
        db
          .from("positions")
          .upsert(
            {
              id: positionId,
              user_id: cfg.user_id,
              token_mint: event.tokenMint,
              entry_price_usd: entryPrice,
              amount_tokens: receivedUi,
              amount_remaining: receivedUi,
              decimals: event.decimals,
              mirrored_sold_fraction: 0,
              tp_taken: false,
              entry_tx_sig: result.txSig,
              entry_slot: event.slot,
              entry_mode: options.entryMode,
              coordinated_exit_triggered: false,
              follower_seller_exit_triggered: false,
              root_buy_count: options.coordinatedWallets?.length ?? 1,
              last_root_buy_at: targetBuyAt,
              last_root_buy_wallet: event.wallet,
            },
            { onConflict: "id" },
          )
          .select("id")
          .maybeSingle(),
      );
      if (!pos) {
        throw new Error(
          `copy buy ${result.txSig} landed but position ${positionId} could not be read back`,
        );
      }
      uncertainEntryMints.delete(event.tokenMint);

      const { error: tradeError } = await db.from("trades").insert({
        user_id: cfg.user_id,
        position_id: pos.id,
        side: "buy",
        token_mint: event.tokenMint,
        amount_tokens: receivedUi,
        amount_usd: buyUsd,
        tx_sig: result.txSig,
        reason,
        latency_ms: result.latencyMs,
        route: result.route,
      });
      if (tradeError)
        log.error(
          { err: tradeError, positionId: pos.id },
          "copy buy landed but trade log save failed",
        );
      const { error: tradedTokenError } = await db
        .from("traded_tokens")
        .upsert({ user_id: cfg.user_id, token_mint: event.tokenMint });
      if (tradedTokenError)
        log.error(
          { err: tradedTokenError, mint: event.tokenMint },
          "could not save traded-token history",
        );

      await monitor.onCopyBuy({
        positionId: pos.id,
        tokenMint: event.tokenMint,
        targetWallet: event.wallet,
      });
      if (options.entryMode === "coordinated") {
        for (const transfer of pendingTransfers.get(event.tokenMint) ?? []) {
          const windowMs = Math.max(1, Number(cfg.coordinated_window_seconds)) * 1000;
          if (event.timestampMs - transfer.timestampMs > windowMs) continue;
          await monitor.recordTransfer(pos.id, transfer.to, transfer.amountTokens, {
            hopDepth: 1,
            parentWallet: transfer.from,
            txSig: transfer.txSig,
            slot: transfer.slot,
          });
        }
        pendingTransfers.delete(event.tokenMint);
      }
      log.info(
        {
          sig: result.txSig,
          ms: result.latencyMs,
          entryMode: options.entryMode,
          targetBuyUsd:
            options.targetBuyUsd === undefined ? "unknown" : options.targetBuyUsd.toFixed(2),
        },
        "copy buy landed — follower monitor armed",
      );
      recordStrategyDecision(event, "copied", "copy buy landed and follower monitoring was armed", {
        ...metaPatch,
        position_id: pos.id,
        amount_usd: options.targetBuyUsd,
        bot_tx_sig: result.txSig,
        reaction_ms: strategyReactionMs(event, Date.now(), result.latencyMs),
        execution_ms: result.latencyMs,
        metadata: {
          ...metaPatch.metadata,
          configuredBuyUsd: buyUsd,
          receivedTokens: receivedUi,
          entryPriceUsd: entryPrice,
          route: result.route,
          persistencePending: false,
        },
      });
      return pos.id;
    }
  }
}

process.on("unhandledRejection", (err) => log.error({ err }, "unhandled rejection"));
process.on("uncaughtException", (err) => log.error({ err }, "uncaught exception"));

main().catch((e) => {
  log.error(e, "worker crashed before startup completed");
  process.exit(1);
});
