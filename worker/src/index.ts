// Helix worker entrypoint. Long-running Node process. Deploy on a
// low-latency VPS geographically close to Jito block engine + your RPC.

import pino from "pino";
import { randomUUID } from "node:crypto";
import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { env } from "./env.js";
import { db, type BotConfigRow } from "./db.js";
import { GeyserFeed, type FeedEvent, type SwapEvent, type TransferEvent } from "./geyser.js";
import { FollowerMonitor } from "./monitor.js";
import { executeSwap } from "./executor.js";
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

const log = pino({ level: env.LOG_LEVEL });
const WSOL = "So11111111111111111111111111111111111111112";
const STABLECOIN_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCo24RDUuUuJZq8bn6T", // USDT
]);
const rpc = new Connection(env.RPC_URL, { commitment: "processed" });

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
  if (byUser.error) throw new Error(`bot_config query failed: ${byUser.error.message}`);
  if (byUser.data) return byUser.data as BotConfigRow;
  const any = await db
    .from("bot_config")
    .select("*")
    .not("target_wallet", "is", null)
    .neq("target_wallet", "")
    .order("updated_at", { ascending: false })
    .limit(1);
  if (any.error) throw new Error(`bot_config identity check failed: ${any.error.message}`);
  const row = any.data?.[0];
  if (row) {
    throw new Error(
      `HELIX_USER_ID mismatch: worker requested ${userId}, but the configured dashboard row uses ${row.user_id}`,
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
      log.error(
        { user_id: userId },
        "readiness failed — no funding private key saved for this config user",
      );
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
        log.info({ user_id: cfg.user_id, targets: configuredTargetWallets(cfg) }, "config loaded");
        return cfg;
      }
      if (!logged) {
        log.warn({ userId }, "no target wallet configured yet — polling every 5s");
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
  const entriesInFlight = new Set<string>();
  const exitsInFlight = new Set<string>();
  const pendingTransfers = new Map<string, TransferEvent[]>();

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
        lastError = result.error.message;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      if (attempt < attempts) {
        log.warn({ label, attempt, lastError }, "database operation failed — retrying");
        await delay(attempt * 500);
      }
    }
    throw new Error(`${label} failed after ${attempts} attempts: ${lastError}`);
  }

  let targetWallets = new Set(configuredTargetWallets(cfg));
  if (targetWallets.size === 0) throw new Error("config loaded without a target wallet");

  async function releaseMonitoredPosition(positionId: string) {
    await monitor.releasePosition(positionId);
    // A target wallet can also appear in a transfer chain. Reassert target
    // subscriptions after releasing follower-only watches.
    for (const wallet of targetWallets) {
      await feed.watch(wallet);
      poller.watch(wallet);
    }
  }

  // Rehydrate any positions still open from a previous worker run so we keep
  // monitoring their followers across restarts.
  const { data: openPositions } = await db
    .from("positions")
    .select("id,token_mint,amount_remaining")
    .eq("user_id", cfg.user_id)
    .is("closed_at", null);
  for (const pos of openPositions ?? []) {
    if (Number(pos.amount_remaining) <= 0) continue;
    await monitor.onCopyBuy({
      positionId: pos.id,
      tokenMint: pos.token_mint,
      targetWallet: cfg.target_wallet ?? Array.from(targetWallets)[0],
    });
    const { data: followers } = await db
      .from("follower_wallets")
      .select("wallet")
      .eq("position_id", pos.id);
    for (const f of followers ?? []) {
      await feed.watch(f.wallet);
      poller.watch(f.wallet);
    }
  }

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
      { target: cfg.target_wallet, geyser: feed.health(), rpcFallback: poller.health() },
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

    if (error) throw new Error(`worker_heartbeat upsert failed: ${error.message}`);
  }

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

  // Take-profit / stop-loss watcher — polls prices every 4s for all open positions.
  setInterval(() => {
    checkTpSl().catch((err) => log.error({ err }, "tp/sl loop failed"));
  }, 4000);
  setInterval(() => {
    checkCoordinatedInactivity().catch((err) =>
      log.error({ err }, "coordinated inactivity loop failed"),
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

  async function checkCoordinatedInactivity() {
    const { data: positions, error } = await db
      .from("positions")
      .select(
        "id,token_mint,amount_remaining,decimals,last_root_buy_at,opened_at,entry_mode,coordinated_exit_triggered",
      )
      .eq("user_id", cfg.user_id)
      .eq("entry_mode", "coordinated")
      .is("closed_at", null);
    if (error) throw new Error(`coordinated inactivity query failed: ${error.message}`);
    const nowMs = Date.now();
    for (const pos of positions ?? []) {
      if (exitsInFlight.has(pos.id) || Number(pos.amount_remaining) <= 0) continue;
      if (!pos.coordinated_exit_triggered) {
        const { count, error: sellerCountError } = await db
          .from("follower_wallets")
          .select("id", { count: "exact", head: true })
          .eq("position_id", pos.id)
          .not("first_sell_at", "is", null);
        if (sellerCountError) {
          throw new Error(`coordinated seller-count query failed: ${sellerCountError.message}`);
        }
        if (
          shouldTriggerDistinctSellerExit(
            Number(count ?? 0),
            Number(cfg.coordinated_follower_sell_count),
            false,
          )
        ) {
          await executeCoordinatedPercentageExit(
            pos.id,
            pos.token_mint,
            Number(pos.amount_remaining),
            Number(pos.decimals ?? 0),
            Number(cfg.coordinated_follower_sell_pct),
            `coordinated ${count ?? 0} distinct follower seller(s) (retry check)`,
          );
          continue;
        }
      }
      const deadline = inactivityDeadlineMs(
        pos.last_root_buy_at ?? pos.opened_at,
        Number(cfg.coordinated_inactivity_hours),
      );
      if (deadline === undefined || nowMs < deadline) continue;
      await executeCoordinatedPercentageExit(
        pos.id,
        pos.token_mint,
        Number(pos.amount_remaining),
        Number(pos.decimals ?? 0),
        100,
        `coordinated target inactivity ${cfg.coordinated_inactivity_hours}h`,
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
  ) {
    if (exitsInFlight.has(positionId)) return;
    exitsInFlight.add(positionId);
    try {
      const secret = await loadSigner(cfg.user_id);
      if (!secret) {
        log.error("no funding key for tp/sl sell");
        return;
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
      const cur = await retryDb<{ amount_remaining: number } | null>(
        "load position after exit",
        () => db.from("positions").select("amount_remaining").eq("id", positionId).maybeSingle(),
      );
      if (!cur) throw new Error(`position ${positionId} disappeared after exit transaction landed`);
      const newRemaining = Math.max(0, Number(cur.amount_remaining) - sellUi);
      const closed = newRemaining <= 1e-9;
      const update: {
        amount_remaining: number;
        closed_at: string | null;
        tp_taken?: boolean;
        coordinated_exit_triggered?: boolean;
      } = {
        amount_remaining: newRemaining,
        closed_at: closed ? new Date().toISOString() : null,
      };
      if (markTpTaken) update.tp_taken = true;
      if (markCoordinatedExit) update.coordinated_exit_triggered = true;
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
    } finally {
      exitsInFlight.delete(positionId);
    }
  }

  async function executeCoordinatedPercentageExit(
    positionId: string,
    mint: string,
    remaining: number,
    decimals: number,
    sellPct: number,
    reason: string,
  ) {
    if (exitsInFlight.has(positionId)) return;
    const sellFraction = Math.min(1, Math.max(0, Number(sellPct) / 100));
    const sellUi = remaining * sellFraction;
    const sellRaw = Math.floor(sellUi * Math.pow(10, decimals));
    if (sellRaw <= 0 || sellUi <= 0) return;
    log.warn({ positionId, mint, sellPct, reason }, "coordinated exit triggered");
    await executeExitSell(positionId, mint, sellRaw, sellUi, reason, false, true);
  }

  async function handle(event: FeedEvent) {
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
      }
    } catch (err) {
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
    if (event.tokenMint === WSOL || STABLECOIN_MINTS.has(event.tokenMint)) return;
    const solPrice = await priceUsd(WSOL);
    const targetBuyUsd =
      event.amountUsd ??
      (solPrice !== undefined && Math.abs(event.solDelta) > 0.0005
        ? Math.abs(event.solDelta) * solPrice
        : undefined);
    event.amountUsd = targetBuyUsd;
    await recordOpenPositionTargetBuy(event);
    const firstBuy = await observeTargetFirstBuy(event.wallet, event.tokenMint);

    if (!cfg.enabled) {
      log.info(
        { wallet: event.wallet, mint: event.tokenMint },
        "entries off — target buy observed but not copied",
      );
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
    const ctx = monitor.activeForMint(ev.tokenMint);
    if (!targetWallets.has(ev.from)) {
      if (ctx)
        await monitor.recordChainedTransfer(ev.tokenMint, ev.from, ev.to, ev.amountTokens, {
          txSig: ev.txSig,
          slot: ev.slot,
        });
      return;
    }
    if (ctx) {
      await monitor.recordTransfer(ctx.positionId, ev.to, ev.amountTokens, {
        hopDepth: 1,
        parentWallet: ev.from,
        txSig: ev.txSig,
        slot: ev.slot,
      });
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
      return;
    }

    if (cfg.enabled) {
      // Some Laserstream payloads show the target's immediate post-buy token
      // movement as a transfer, while the actual swap has no positive net
      // target balance left to decode. Since this target's pattern is buy →
      // split to follower wallets, use that outbound transfer as a fallback
      // entry trigger instead of silently missing the trade.
      log.warn(
        {
          from: ev.from,
          to: ev.to,
          mint: ev.tokenMint,
          amountTokens: ev.amountTokens,
          txSig: ev.txSig,
        },
        "target transfer with no open position — using as fallback buy trigger",
      );

      await handleTargetBuy({
        kind: "swap",
        wallet: ev.from,
        side: "buy",
        tokenMint: ev.tokenMint,
        amountTokens: ev.amountTokens,
        decimals: ev.decimals,
        amountUsd: undefined,
        solDelta: 0,
        slot: ev.slot,
        txSig: ev.txSig,
        timestampMs: ev.timestampMs,
        isPumpFun: ev.tokenMint.endsWith("pump"),
      });

      const opened = monitor.activeForMint(ev.tokenMint);
      if (opened) {
        await monitor.recordTransfer(opened.positionId, ev.to, ev.amountTokens, {
          hopDepth: 1,
          parentWallet: ev.from,
          txSig: ev.txSig,
          slot: ev.slot,
        });
      }
      return;
    }
  }

  async function handleFollowerSell(ev: SwapEvent) {
    const ctx = monitor.activeForMint(ev.tokenMint);
    if (!ctx) return;
    if (targetWallets.has(ev.wallet)) return; // Only follower wallets drive the mirror

    const sellState = await monitor.recordFollowerSell(ctx.positionId, ev.wallet, ev.amountTokens, {
      txSig: ev.txSig,
      slot: ev.slot,
    });
    if (sellState === null) return;

    const { data: pos } = await db
      .from("positions")
      .select(
        "id,token_mint,amount_tokens,amount_remaining,decimals,mirrored_sold_fraction,entry_mode,coordinated_exit_triggered",
      )
      .eq("id", ctx.positionId)
      .maybeSingle();
    if (!pos) return;

    if ((pos.entry_mode ?? "regular") === "coordinated") {
      if (pos.coordinated_exit_triggered) return;
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
        return;
      }
      await executeCoordinatedPercentageExit(
        pos.id,
        pos.token_mint,
        Number(pos.amount_remaining),
        Number(pos.decimals ?? 0),
        Number(cfg.coordinated_follower_sell_pct),
        `coordinated ${sellState.distinctSellerCount} distinct follower seller(s)`,
      );
      return;
    }

    if (!cfg.proportional_follower_sells) return;

    const targetRemaining = Math.max(0, Number(pos.amount_tokens) * (1 - sellState.soldFraction));
    const sellUi = Number(pos.amount_remaining) - targetRemaining;
    if (sellUi <= 0) return;

    const decimals = Number(pos.decimals ?? 0);
    const sellRaw = Math.floor(sellUi * Math.pow(10, decimals));
    if (sellRaw <= 0) return;

    log.info(
      { positionId: pos.id, soldFraction: sellState.soldFraction, sellUi, sellRaw },
      "mirroring follower sell",
    );
    await executeMirrorSell(pos.id, pos.token_mint, sellRaw, sellUi, sellState.soldFraction, ctx);
  }

  async function executeMirrorSell(
    positionId: string,
    mint: string,
    sellRaw: number,
    sellUi: number,
    soldFraction: number,
    ctx: { positionId: string; tokenMint: string; targetWallet: string },
  ) {
    if (exitsInFlight.has(positionId)) return;
    exitsInFlight.add(positionId);
    try {
      const secret = await loadSigner(cfg.user_id);
      if (!secret) {
        log.error("no funding key for sell");
        return;
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

      const currentPosition = await retryDb<{ amount_remaining: number } | null>(
        "load position after mirror sell",
        () => db.from("positions").select("amount_remaining").eq("id", positionId).maybeSingle(),
      );
      if (!currentPosition) {
        throw new Error(`position ${positionId} disappeared after mirror sell landed`);
      }
      const newRemaining = Math.max(0, Number(currentPosition.amount_remaining) - sellUi);
      const closed = newRemaining <= 1e-9;
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
    } finally {
      exitsInFlight.delete(positionId);
    }
  }

  async function tryCopyBuy(
    event: SwapEvent,
    reason = "target copy buy",
    options: {
      entryMode: "regular" | "coordinated";
      firstBuy: boolean;
      targetBuyUsd: number | undefined;
      coordinatedWallets?: string[];
    },
  ): Promise<string | null> {
    if (!cfg.enabled || entriesInFlight.has(event.tokenMint)) return null;
    if (event.tokenMint === WSOL || STABLECOIN_MINTS.has(event.tokenMint)) {
      log.info(
        { mint: event.tokenMint, txSig: event.txSig },
        "target buy skipped — output is SOL/stablecoin, not a token entry",
      );
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
      return null;
    }

    const meta = await loadTokenMeta(event.tokenMint);
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
      return null;
    }

    entriesInFlight.add(event.tokenMint);
    try {
      let secret: string | null = null;
      try {
        secret = await loadSigner(cfg.user_id);
      } catch (err) {
        log.error({ err, user_id: cfg.user_id }, "funding key decrypt failed for copy buy");
        return null;
      }
      if (!secret) {
        log.error({ user_id: cfg.user_id }, "no funding key saved for this config user");
        return null;
      }

      const solPrice = await priceUsd(WSOL);
      if (solPrice === undefined) {
        log.error({ mint: event.tokenMint }, "copy buy blocked — live SOL/USD price unavailable");
        return null;
      }
      const buyUsd =
        options.entryMode === "coordinated"
          ? Number(cfg.coordinated_fixed_buy_usd)
          : Number(cfg.fixed_buy_usd);
      const amountLamports = Math.floor((buyUsd / solPrice) * 1e9);
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

      let result;
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
        log.error(
          { err, mint: event.tokenMint, amountLamports, route: cfg.execution_route },
          "copy buy failed before transaction landed",
        );
        return null;
      }

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
      return pos.id;
    } finally {
      entriesInFlight.delete(event.tokenMint);
    }
  }
}

process.on("unhandledRejection", (err) => log.error({ err }, "unhandled rejection"));
process.on("uncaughtException", (err) => log.error({ err }, "uncaught exception"));

main().catch((e) => {
  log.error(e, "worker crashed before startup completed");
  process.exit(1);
});
