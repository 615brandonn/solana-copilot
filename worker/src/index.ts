// Helix worker entrypoint. Long-running Node process. Deploy on a
// low-latency VPS geographically close to Jito block engine + your RPC.

import pino from "pino";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { env } from "./env.js";
import { db, type BotConfigRow } from "./db.js";
import { GeyserFeed, type FeedEvent, type SwapEvent, type TransferEvent } from "./geyser.js";
import { FollowerMonitor } from "./monitor.js";
import {
  executeSwap,
  quotePumpFunMarketCapSol,
  quoteSolPriceUsd,
  warmExecutionInfrastructure,
} from "./executor.js";
import { decryptPrivateKey } from "./crypto.js";
import { checkEntry, checkTargetBuyMinimum, loadTokenMeta } from "./filters.js";
import { RpcBackfillPoller } from "./poller.js";
import { aggregateFollowerSoldFraction } from "./follower-math.js";
import { reactionLatencyMs, sellValuation } from "./trade-metrics.js";
import { buyLamportsForUsd, usdValueOfLamports } from "./buy-sizing.js";
import { isTrackableWalletAddress } from "./wallet-policy.js";
import { BoundedSerialQueue } from "./bounded-serial-queue.js";
import { BoundedKeyedSerialQueue } from "./bounded-keyed-serial-queue.js";
import { isPositionManagementEvent, isRelevantStrategyEvent } from "./event-relevance.js";
import { configuredTargetWallets, normalizeAdditionalTargetWallets } from "./target-network.js";
import { targetBuyFreshness } from "./freshness.js";
import {
  capSellRawToBalance,
  mirrorSellRawForDesiredBalance,
  reconciledRemainingUi,
} from "./sell-balance.js";
import {
  observationFromEvent,
  StrategyRecorder,
  type StrategyObservationPatch,
} from "./strategy-recorder.js";
import { selectAuthoritativeMarketCap } from "./market-cap.js";
import {
  effectiveScannerEntryLimits,
  evaluateLargeBuySignal,
  TargetBuyHistory,
} from "./large-buy-scanner.js";
import { decideNetworkBuy } from "./network-scaling.js";
import {
  BUY_CONFIG_MAX_STALE_MS,
  canUseConfigSnapshot,
  configSnapshotAgeMs,
} from "./config-freshness.js";
import {
  FirstBuyHistory,
  firstBuyFilterState,
  type FirstBuyClaim,
} from "./first-buy-history.js";

const log = pino({ level: env.LOG_LEVEL });
const WSOL = "So11111111111111111111111111111111111111112";
const STABLECOIN_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCo24RDUuUuJZq8bn6T", // USDT
]);
const rpc = new Connection(env.RPC_URL, { commitment: "processed" });

async function loadConfig(userId: string): Promise<BotConfigRow | null> {
  const byUser = await db.from("bot_config").select("*").eq("user_id", userId).maybeSingle();
  if (byUser.error) throw new Error(`bot_config query failed: ${byUser.error.message}`);
  if (byUser.data?.target_wallet) return byUser.data as BotConfigRow;
  if (!env.ALLOW_CONFIG_FALLBACK) return null;
  const any = await db
    .from("bot_config")
    .select("*")
    .not("target_wallet", "is", null)
    .neq("target_wallet", "")
    .order("updated_at", { ascending: false })
    .limit(1);
  if (any.error) throw new Error(`bot_config fallback query failed: ${any.error.message}`);
  const row = any.data?.[0];
  if (row)
    log.warn(
      { requested_user_id: userId, found_user_id: row.user_id, target: row.target_wallet },
      "using fallback bot_config row — HELIX_USER_ID may not match dashboard config",
    );
  return (row as BotConfigRow) ?? null;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function uiAmountToRaw(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) return 0n;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new Error(`invalid token decimals: ${decimals}`);
  }
  if (amount >= 1e21) {
    throw new Error("token UI amount is too large to convert safely");
  }
  const [whole, fraction = ""] = amount.toFixed(decimals).split(".");
  return (
    BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction || "").padEnd(decimals, "0") || "0")
  );
}

function rawAmountToUi(amount: bigint, decimals: number): number {
  if (amount <= 0n) return 0;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new Error(`invalid token decimals: ${decimals}`);
  }
  const digits = amount.toString().padStart(decimals + 1, "0");
  const split = digits.length - decimals;
  return Number(`${digits.slice(0, split)}.${digits.slice(split)}`);
}

async function fundingTokenBalanceRaw(signerSecret: string, mint: string): Promise<bigint> {
  const decodedSecret = bs58.decode(signerSecret.trim());
  if (decodedSecret.length !== 64) {
    throw new Error(`funding private key decoded to ${decodedSecret.length} bytes`);
  }
  const owner = Keypair.fromSecretKey(decodedSecret).publicKey;
  const response = await rpc.getParsedTokenAccountsByOwner(
    owner,
    { mint: new PublicKey(mint) },
    "processed",
  );
  return response.value.reduce((sum, row) => {
    const raw = row.account.data.parsed?.info?.tokenAmount?.amount;
    return sum + (/^\d+$/.test(String(raw ?? "")) ? BigInt(String(raw)) : 0n);
  }, 0n);
}

async function capitalSnapshot(
  userId: string,
  signerSecret: string,
  solPriceUsd: number,
  jitoTipSol: number,
): Promise<{ availableUsd: number; openCampaignCostUsd: number; bankrollUsd: number }> {
  const decodedSecret = bs58.decode(signerSecret.trim());
  if (decodedSecret.length !== 64) {
    throw new Error(`funding private key decoded to ${decodedSecret.length} bytes`);
  }
  const owner = Keypair.fromSecretKey(decodedSecret).publicKey;
  const [{ value: balanceLamports }, positionsResult] = await Promise.all([
    rpc.getBalanceAndContext(owner, "processed"),
    db
      .from("positions")
      .select("entry_price_usd,amount_remaining,bot_cost_basis_usd")
      .eq("user_id", userId)
      .is("closed_at", null),
  ]);
  if (positionsResult.error) {
    throw new Error(`open campaign capital query failed: ${positionsResult.error.message}`);
  }

  // Keep enough SOL outside the swap input for the configured Jito tip,
  // transaction fees, and a possible associated-token-account creation.
  const feeReserveSol = Math.max(0.006, Number(jitoTipSol) + 0.004);
  const availableUsd = Math.max(0, (balanceLamports / 1e9 - feeReserveSol) * solPriceUsd);
  const openCampaignCostUsd = (positionsResult.data ?? []).reduce((sum, position) => {
    const persistedBasis = Number(position.bot_cost_basis_usd ?? 0);
    if (Number.isFinite(persistedBasis) && persistedBasis > 0) return sum + persistedBasis;
    const estimated =
      Number(position.entry_price_usd ?? 0) * Number(position.amount_remaining ?? 0);
    return sum + (Number.isFinite(estimated) && estimated > 0 ? estimated : 0);
  }, 0);
  return {
    availableUsd,
    openCampaignCostUsd,
    bankrollUsd: availableUsd + openCampaignCostUsd,
  };
}

function validateConfig(cfg: BotConfigRow): BotConfigRow {
  if (!cfg.target_wallet) throw new Error("target wallet is missing");
  try {
    new PublicKey(cfg.target_wallet);
  } catch {
    throw new Error(`target wallet is invalid: ${cfg.target_wallet}`);
  }
  const additionalTargetWallets = normalizeAdditionalTargetWallets(
    cfg.target_wallet,
    cfg.additional_target_wallets,
  );
  for (const wallet of additionalTargetWallets) {
    try {
      new PublicKey(wallet);
    } catch {
      throw new Error(`additional target wallet is invalid: ${wallet}`);
    }
  }
  const fixedBuyUsd = Number(cfg.fixed_buy_usd);
  if (!Number.isFinite(fixedBuyUsd) || fixedBuyUsd <= 0) {
    throw new Error(`fixed_buy_usd must be greater than zero; received ${cfg.fixed_buy_usd}`);
  }
  if (Number(cfg.mc_min_usd) > Number(cfg.mc_max_usd)) {
    throw new Error("mc_min_usd cannot exceed mc_max_usd");
  }
  if (Number(cfg.liq_min_usd) > Number(cfg.liq_max_usd)) {
    throw new Error("liq_min_usd cannot exceed liq_max_usd");
  }
  const normalized = {
    ...cfg,
    additional_target_wallets: additionalTargetWallets,
    require_24h_uptrend: cfg.require_24h_uptrend ?? false,
    large_buy_scanner_enabled: cfg.large_buy_scanner_enabled ?? false,
    large_buy_scanner_max_mc_usd: Number(cfg.large_buy_scanner_max_mc_usd ?? 10_000),
    large_buy_scanner_min_buy_usd: Number(cfg.large_buy_scanner_min_buy_usd ?? 500),
    large_buy_scanner_multiplier: Number(cfg.large_buy_scanner_multiplier ?? 2),
    large_buy_scanner_history_window: Number(cfg.large_buy_scanner_history_window ?? 20),
    network_scaling_enabled: cfg.network_scaling_enabled ?? true,
    starter_position_pct: Number(cfg.starter_position_pct ?? 5),
    max_position_pct: Number(cfg.max_position_pct ?? 15),
    new_entry_reserve_pct: Number(cfg.new_entry_reserve_pct ?? 50),
    target_copy_ratio_pct: Number(cfg.target_copy_ratio_pct ?? 1),
    min_scale_buy_usd: Number(cfg.min_scale_buy_usd ?? 1),
  };
  if (
    !Number.isFinite(normalized.large_buy_scanner_max_mc_usd) ||
    normalized.large_buy_scanner_max_mc_usd <= 0
  ) {
    throw new Error("large_buy_scanner_max_mc_usd must be greater than zero");
  }
  if (
    !Number.isFinite(normalized.large_buy_scanner_min_buy_usd) ||
    normalized.large_buy_scanner_min_buy_usd <= 0
  ) {
    throw new Error("large_buy_scanner_min_buy_usd must be greater than zero");
  }
  if (
    !Number.isFinite(normalized.large_buy_scanner_multiplier) ||
    normalized.large_buy_scanner_multiplier < 1
  ) {
    throw new Error("large_buy_scanner_multiplier must be at least 1");
  }
  if (
    !Number.isInteger(normalized.large_buy_scanner_history_window) ||
    normalized.large_buy_scanner_history_window < 5 ||
    normalized.large_buy_scanner_history_window > 200
  ) {
    throw new Error("large_buy_scanner_history_window must be an integer from 5 to 200");
  }
  if (
    !Number.isFinite(normalized.starter_position_pct) ||
    normalized.starter_position_pct <= 0 ||
    normalized.starter_position_pct > 100
  ) {
    throw new Error("starter_position_pct must be greater than 0 and no more than 100");
  }
  if (
    !Number.isFinite(normalized.max_position_pct) ||
    normalized.max_position_pct < normalized.starter_position_pct ||
    normalized.max_position_pct > 100
  ) {
    throw new Error("max_position_pct must be at least the starter percentage and no more than 100");
  }
  if (
    !Number.isFinite(normalized.new_entry_reserve_pct) ||
    normalized.new_entry_reserve_pct < 0 ||
    normalized.new_entry_reserve_pct > 95
  ) {
    throw new Error("new_entry_reserve_pct must be from 0 to 95");
  }
  if (
    !Number.isFinite(normalized.target_copy_ratio_pct) ||
    normalized.target_copy_ratio_pct <= 0 ||
    normalized.target_copy_ratio_pct > 100
  ) {
    throw new Error("target_copy_ratio_pct must be greater than 0 and no more than 100");
  }
  if (
    !Number.isFinite(normalized.min_scale_buy_usd) ||
    normalized.min_scale_buy_usd <= 0
  ) {
    throw new Error("min_scale_buy_usd must be greater than zero");
  }
  return normalized;
}

const SIGNER_CACHE_TTL_MS = 60_000;
const signerCache = new Map<string, { secret: string; expiresAt: number }>();

async function loadSigner(userId: string): Promise<string | null> {
  const cached = signerCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.secret;

  const { data, error } = await db
    .from("funding_keys")
    .select("ciphertext")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`funding key query failed: ${error.message}`);
  if (!data) {
    signerCache.delete(userId);
    return null;
  }
  const secret = decryptPrivateKey(data.ciphertext);
  signerCache.set(userId, { secret, expiresAt: Date.now() + SIGNER_CACHE_TTL_MS });
  return secret;
}

async function logFundingWalletReadiness(userId: string, fixedBuyUsd: number) {
  try {
    const secret = await loadSigner(userId);
    if (!secret) {
      log.error(
        { user_id: userId },
        "readiness failed — no funding private key saved for this config user",
      );
      return;
    }

    const decoded = bs58.decode(secret.trim());
    if (decoded.length !== 64) {
      log.error(
        { decodedBytes: decoded.length },
        "readiness failed — funding private key is not a 64-byte Phantom/Solana secret key",
      );
      return;
    }

    const signer = Keypair.fromSecretKey(decoded);
    const balanceLamports = await rpc.getBalance(signer.publicKey, "processed");
    const solBalance = balanceLamports / 1e9;
    log.info(
      {
        fundingWallet: signer.publicKey.toBase58(),
        solBalance,
        fixedBuyUsd,
      },
      "funding wallet ready",
    );

    if (solBalance < 0.02) {
      log.warn(
        { fundingWallet: signer.publicKey.toBase58(), solBalance },
        "funding wallet SOL balance is very low",
      );
    }
  } catch (err) {
    log.error({ err }, "readiness failed — could not decrypt/check funding wallet");
  }
}

const PRICE_CACHE_FRESH_MS = 10_000;
const PRICE_CACHE_FALLBACK_MS = 60_000;
const priceCache = new Map<string, { priceUsd: number; observedAt: number }>();

async function pricesUsd(mints: string[]): Promise<Map<string, number>> {
  const now = Date.now();
  const uniqueMints = Array.from(new Set(mints.filter(Boolean)));
  const result = new Map<string, number>();
  const missing: string[] = [];

  for (const mint of uniqueMints) {
    const cached = priceCache.get(mint);
    if (cached && now - cached.observedAt <= PRICE_CACHE_FRESH_MS) {
      result.set(mint, cached.priceUsd);
    } else {
      missing.push(mint);
    }
  }

  // Price V3 accepts up to 50 mints. One batched TP/SL request replaces a
  // separate request for every open position.
  for (let offset = 0; offset < missing.length; offset += 50) {
    const batch = missing.slice(offset, offset + 50);
    try {
      const url = new URL(env.PRICE_API_URL);
      url.searchParams.set("ids", batch.join(","));
      const response = await fetch(url, {
        signal: AbortSignal.timeout(env.HTTP_TIMEOUT_MS),
        headers: env.JUPITER_API_KEY ? { "x-api-key": env.JUPITER_API_KEY } : undefined,
      });
      if (!response.ok) throw new Error(`price API HTTP ${response.status}`);
      const json = (await response.json()) as any;
      const observedAt = Date.now();
      for (const mint of batch) {
        const value = json?.[mint]?.usdPrice ?? json?.data?.[mint]?.price;
        const price = Number(value);
        if (!Number.isFinite(price) || price <= 0) continue;
        result.set(mint, price);
        priceCache.set(mint, { priceUsd: price, observedAt });
      }
    } catch (err) {
      log.warn({ err, mintCount: batch.length }, "batched price lookup unavailable");
      for (const mint of batch) {
        const cached = priceCache.get(mint);
        if (cached && now - cached.observedAt <= PRICE_CACHE_FALLBACK_MS) {
          result.set(mint, cached.priceUsd);
        }
      }
    }
  }

  if (priceCache.size > 500) {
    for (const [mint, cached] of priceCache) {
      if (now - cached.observedAt > PRICE_CACHE_FALLBACK_MS) priceCache.delete(mint);
    }
  }
  return result;
}

async function priceUsd(mint: string): Promise<number | undefined> {
  return (await pricesUsd([mint])).get(mint);
}

let recentSolPrice:
  | { priceUsd: number; source: "Jupiter Price API" | "Jupiter SOL/USDC quote"; observedAt: number }
  | undefined;

async function reliableSolPriceUsd(): Promise<
  { priceUsd: number; source: "Jupiter Price API" | "Jupiter SOL/USDC quote" } | undefined
> {
  const directPrice = await priceUsd(WSOL);
  if (directPrice !== undefined) {
    recentSolPrice = {
      priceUsd: directPrice,
      source: "Jupiter Price API",
      observedAt: Date.now(),
    };
    return recentSolPrice;
  }

  const quotePrice = await quoteSolPriceUsd();
  if (quotePrice !== undefined) {
    recentSolPrice = {
      priceUsd: quotePrice,
      source: "Jupiter SOL/USDC quote",
      observedAt: Date.now(),
    };
    return recentSolPrice;
  }

  if (recentSolPrice && Date.now() - recentSolPrice.observedAt <= 60_000) {
    log.warn(
      { solPriceUsd: recentSolPrice.priceUsd, ageMs: Date.now() - recentSolPrice.observedAt },
      "using recently verified SOL/USD price",
    );
    return { priceUsd: recentSolPrice.priceUsd, source: recentSolPrice.source };
  }
  return undefined;
}

async function waitForConfig(userId: string): Promise<BotConfigRow> {
  let logged = false;
  while (true) {
    try {
      const cfg = await loadConfig(userId);
      if (cfg?.target_wallet) {
        const normalized = validateConfig(cfg);
        log.info(
          {
            user_id: normalized.user_id,
            target: normalized.target_wallet,
            additionalTargets: normalized.additional_target_wallets,
          },
          "config loaded",
        );
        return normalized;
      }
    } catch (err) {
      log.error({ err }, "config load failed — polling every 5s");
    }
    if (!logged) {
      log.warn({ userId }, "no target wallet configured yet — polling every 5s");
      logged = true;
    }
    await delay(5000);
  }
}

async function main() {
  const USER_ID = env.HELIX_USER_ID;
  const workerStartedAt = new Date().toISOString();
  let heartbeatSchemaWarningLogged = false;
  let cfg = await waitForConfig(USER_ID);
  let configConfirmedAt = Date.now();
  let targetWallets = configuredTargetWallets(cfg.target_wallet, cfg.additional_target_wallets);
  await logFundingWalletReadiness(cfg.user_id, cfg.fixed_buy_usd);
  // Warm the execution transports and the SOL/USD conversion in parallel.
  // Keeping the price cache hot removes a price HTTP request from the critical
  // path of the next fixed-dollar buy.
  await Promise.all([
    warmExecutionInfrastructure(),
    reliableSolPriceUsd().catch((err) => {
      log.warn({ err }, "initial SOL/USD warm-up unavailable");
      return undefined;
    }),
  ]);

  const pendingEvents = new Set<string>();
  const completedEvents = new Map<string, number>();
  const enqueuedAtByEvent = new Map<string, number>();
  // New entries are serialized because they share one capital budget. Events
  // for an existing position are serialized only by mint, allowing urgent
  // exits for unrelated coins to bypass a slow buy or a different slow exit.
  const entryEventQueue = new BoundedSerialQueue<FeedEvent>(env.EVENT_QUEUE_MAX);
  const positionEventQueue = new BoundedKeyedSerialQueue<FeedEvent>(
    env.EVENT_QUEUE_MAX,
    env.POSITION_EVENT_CONCURRENCY,
  );
  let lastQueueFullWarningAt = 0;
  const monitorRef: { current?: FollowerMonitor } = {};
  let lastStrategyRecorderErrorAt = 0;
  let lastStrategyPruneAt = 0;
  let solPriceWarmRunning = false;

  setInterval(() => {
    if (solPriceWarmRunning) return;
    solPriceWarmRunning = true;
    reliableSolPriceUsd()
      .catch((err) => log.debug({ err }, "background SOL/USD warm-up unavailable"))
      .finally(() => {
        solPriceWarmRunning = false;
      });
  }, 5_000);

  const strategyRecorder = new StrategyRecorder(
    async (rows) => {
      const { error } = await db.rpc("record_strategy_observations", { p_rows: rows });
      if (error) throw new Error(`strategy recorder batch failed: ${error.message}`);

      const now = Date.now();
      if (now - lastStrategyPruneAt >= 24 * 60 * 60_000) {
        lastStrategyPruneAt = now;
        const cutoff = new Date(now - env.STRATEGY_RETENTION_DAYS * 24 * 60 * 60_000).toISOString();
        const { error: pruneError } = await db
          .from("strategy_observations")
          .delete()
          .eq("user_id", cfg.user_id)
          .lt("event_at", cutoff);
        if (pruneError) {
          log.warn({ err: pruneError }, "strategy observation retention cleanup failed");
        }
      }
    },
    {
      maxPending: env.STRATEGY_RECORDER_QUEUE_MAX,
      onError: (err) => {
        const now = Date.now();
        if (now - lastStrategyRecorderErrorAt < 30_000) return;
        lastStrategyRecorderErrorAt = now;
        log.warn(
          { err },
          "strategy recorder unavailable; trading continues and observations remain buffered",
        );
      },
      onDrop: (dropped) => {
        if (dropped === 1 || dropped % 100 === 0) {
          log.warn({ dropped }, "strategy recorder queue full; oldest observation dropped");
        }
      },
    },
  );
  if (env.STRATEGY_RECORDER_ENABLED) strategyRecorder.start();

  const targetBuyHistory = new TargetBuyHistory();
  const firstBuyHistory = new FirstBuyHistory(rpc, cfg.user_id);
  await firstBuyHistory.start(targetWallets);
  async function loadTargetBuyHistory(targetWallet: string): Promise<number[]> {
    const { data, error } = await db
      .from("strategy_observations")
      .select("amount_usd")
      .eq("user_id", cfg.user_id)
      .eq("target_wallet", targetWallet)
      .eq("relationship", "target")
      .eq("event_kind", "swap")
      .eq("side", "buy")
      .not("amount_usd", "is", null)
      .order("event_at", { ascending: false })
      .limit(200);
    if (error) {
      log.warn(
        { err: error, targetWallet },
        "large-buy scanner history unavailable; scanner will fail closed until live history is collected",
      );
      return [];
    }
    const amounts = (data ?? [])
      .map((row) => Number(row.amount_usd))
      .filter((value) => Number.isFinite(value) && value > 0)
      .reverse();
    log.info(
      { targetWallet, samples: amounts.length },
      "large-buy scanner target history hydrated",
    );
    return amounts;
  }
  const networkBuyHistory = (
    await Promise.all(Array.from(targetWallets, (wallet) => loadTargetBuyHistory(wallet)))
  )
    .flat()
    .slice(-200);
  targetBuyHistory.hydrate(networkBuyHistory);

  const recordStrategyEvent = (event: FeedEvent, patch: StrategyObservationPatch = {}) => {
    if (!env.STRATEGY_RECORDER_ENABLED || !cfg.target_wallet) return;
    const ctx = monitorRef.current?.activeForMint(event.tokenMint);
    const actor = event.kind === "swap" ? event.wallet : event.from;
    const relationship =
      targetWallets.has(actor)
        ? "target"
        : ctx && monitorRef.current?.isFollower(ctx.positionId, actor)
          ? "follower"
          : "observed";
    const enrichedPatch = targetWallets.has(actor) && actor !== cfg.target_wallet
      ? {
          ...patch,
          metadata: {
            ...(patch.metadata ?? {}),
            additionalTargetWallet: true,
          },
        }
      : patch;
    strategyRecorder.record(
      observationFromEvent(
        event,
        {
          userId: cfg.user_id,
          targetWallet: cfg.target_wallet,
          relationship,
          positionId: ctx?.positionId,
        },
        enrichedPatch,
      ),
    );
  };

  // The live stream and RPC fallback can deliver different follower sells at
  // almost the same moment. Process relevant events in order so two percentage
  // updates cannot race. The queue is bounded so an upstream burst cannot grow
  // the Node heap without limit. RPC fallback retries events rejected at the
  // boundary.
  const dispatchEvent = async (event: FeedEvent) => {
    // Recording performs only bounded in-memory work here. Database writes
    // happen later on a separate timer and never delay the trading queue.
    recordStrategyEvent(event);
    // A restart, transient database failure, or missed transfer can leave the
    // in-memory follower set behind Supabase. Before the relevance filter can
    // silently discard an exit, verify an unknown sell/transfer source against
    // the persisted ownership row for this exact open position and mint.
    const ownershipWallet =
      event.kind === "swap" ? (event.side === "sell" ? event.wallet : undefined) : event.from;
    const ownershipCtx = monitorRef.current?.activeForMint(event.tokenMint);
    if (
      ownershipWallet &&
      ownershipCtx &&
      !targetWallets.has(ownershipWallet) &&
      !monitorRef.current?.isFollower(ownershipCtx.positionId, ownershipWallet)
    ) {
      await monitorRef.current?.ensureFollower(
        ownershipCtx.positionId,
        ownershipWallet,
        event.slot,
        event.txSig,
      );
    }

    const relevant = isRelevantStrategyEvent(
      event,
      cfg.target_wallet,
      targetWallets,
      (tokenMint, wallet) => {
        const ctx = monitorRef.current?.activeForMint(tokenMint);
        return !!ctx && !!monitorRef.current?.isFollower(ctx.positionId, wallet);
      },
      (tokenMint) => !!monitorRef.current?.activeForMint(tokenMint),
    );
    if (!relevant) {
      return Promise.resolve();
    }

    const key = feedEventKey(event);
    if (completedEvents.has(key)) return Promise.resolve();
    const active = monitorRef.current?.activeForMint(event.tokenMint);
    // Keep one position's transfers, scale-ins, and sells ordered, while
    // allowing unrelated positions to progress independently.
    const positionScoped = !!active;
    enqueuedAtByEvent.set(key, Date.now());
    const queued = positionScoped
      ? positionEventQueue.enqueue(event.tokenMint, key, event, handle)
      : entryEventQueue.enqueue(key, event, handle);
    if (queued.status !== "queued") enqueuedAtByEvent.delete(key);
    if (queued.status === "full") {
      const now = Date.now();
      if (now - lastQueueFullWarningAt >= 5_000) {
        lastQueueFullWarningAt = now;
        log.error(
          {
            queue: positionScoped ? "position" : "entry",
            health: positionScoped ? positionEventQueue.health() : entryEventQueue.health(),
            kind: event.kind,
            mint: event.tokenMint,
          },
          "event queue full — live event deferred to RPC fallback",
        );
      }
      return Promise.reject(new Error("event queue full"));
    }
    // A backfill event is acknowledged when the bounded queue accepts it.
    // Waiting for landing here blocked checks of every later follower wallet.
    void queued.done.catch((err) => {
      log.error({ err, key }, "queued feed event failed");
    });
    return Promise.resolve();
  };
  const feed = new GeyserFeed(dispatchEvent);
  const poller = new RpcBackfillPoller(rpc, dispatchEvent);
  const monitor = new FollowerMonitor(feed, poller);
  monitorRef.current = monitor;
  monitor.setTargetWallets(targetWallets);
  const buyingMints = new Set<string>();
  const sessionTradedMints = new Set<string>();
  const sellingPositions = new Set<string>();
  const landedButUnreconciledSells = new Set<string>();

  const initialTargetWallet = cfg.target_wallet;
  if (!initialTargetWallet) throw new Error("config loaded without a target wallet");
  const initialTargetWallets = Array.from(targetWallets);

  // Rehydrate any positions still open from a previous worker run so we keep
  // monitoring their followers across restarts.
  const { data: openPositions, error: openPositionsError } = await db
    .from("positions")
    .select("id,token_mint,amount_remaining")
    .eq("user_id", cfg.user_id)
    .is("closed_at", null);
  if (openPositionsError)
    throw new Error(`open positions query failed: ${openPositionsError.message}`);
  for (const pos of openPositions ?? []) {
    if (Number(pos.amount_remaining) <= 0) continue;
    await monitor.onCopyBuy({
      positionId: pos.id,
      tokenMint: pos.token_mint,
      targetWallet: initialTargetWallet,
    });
    const { data: followers, error: followersError } = await db
      .from("follower_wallets")
      .select("wallet,last_seen_slot,last_seen_signature")
      .eq("position_id", pos.id)
      .gt("hop_depth", 0)
      .gt("current_amount", 0);
    if (followersError)
      throw new Error(`follower rehydrate query failed: ${followersError.message}`);
    for (const f of followers ?? []) {
      await monitor.restoreFollower(
        pos.id,
        f.wallet,
        f.last_seen_slot === null ? undefined : Number(f.last_seen_slot),
        f.last_seen_signature ?? undefined,
      );
    }
  }

  // Repair any persisted follower ownership that was absent from memory before
  // accepting live events. This also re-subscribes those wallets immediately.
  await monitor.reconcileFollowersFromDatabase();

  // A follower sell is persisted before its mirror transaction is built. If
  // Jupiter is temporarily unavailable or the process restarts, compare that
  // persisted target state with the funding wallet's real token balance and
  // safely finish only the missing portion.
  await reconcilePersistedFollowerSells();

  while (true) {
    try {
      await feed.start(initialTargetWallets);
      break;
    } catch (err) {
      log.error({ err }, "geyser start failed — retrying in 2s");
      await delay(2000);
    }
  }
  poller.start(initialTargetWallets);

  let followerSellReconciliationRunning = false;
  setInterval(() => {
    if (followerSellReconciliationRunning) return;
    followerSellReconciliationRunning = true;
    reconcilePersistedFollowerSells()
      .catch((err) => log.error({ err }, "follower sell reconciliation loop failed"))
      .finally(() => {
        followerSellReconciliationRunning = false;
      });
  }, 15_000);

  let followerSubscriptionReconciliationRunning = false;
  setInterval(() => {
    if (followerSubscriptionReconciliationRunning) return;
    followerSubscriptionReconciliationRunning = true;
    monitor
      .reconcileFollowersFromDatabase()
      .catch((err) => log.error({ err }, "follower subscription reconciliation loop failed"))
      .finally(() => {
        followerSubscriptionReconciliationRunning = false;
      });
  }, 15_000);

  async function writeHeartbeat() {
    const geyserHealth = feed.health();
    const rpcHealth = poller.health();
    const { error } = await db.from("worker_heartbeat").upsert(
      {
        user_id: cfg.user_id,
        target_wallet: cfg.target_wallet,
        started_at: workerStartedAt,
        updated_at: new Date().toISOString(),
        geyser_connected: geyserHealth.connected,
        last_geyser_message_at: geyserHealth.lastMessageAt
          ? new Date(geyserHealth.lastMessageAt).toISOString()
          : null,
        decoded_event_count: geyserHealth.decodedEventCount,
        rpc_last_poll_at: rpcHealth.lastPollAt
          ? new Date(rpcHealth.lastPollAt).toISOString()
          : null,
      },
      { onConflict: "user_id" },
    );
    if (error && !heartbeatSchemaWarningLogged) {
      heartbeatSchemaWarningLogged = true;
      log.warn(
        { err: error },
        "worker heartbeat could not be saved — apply the latest supabase/schema.sql",
      );
    }
  }
  await writeHeartbeat();
  let heartbeatRunning = false;
  setInterval(() => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    writeHeartbeat()
      .catch((err) => log.warn({ err }, "worker heartbeat failed"))
      .finally(() => {
        heartbeatRunning = false;
      });
  }, 10_000);

  let configRefreshRunning = false;
  setInterval(() => {
    if (configRefreshRunning) return;
    configRefreshRunning = true;
    refreshConfig()
      .catch((err) => log.error({ err }, "config refresh failed"))
      .finally(() => {
        configRefreshRunning = false;
      });
  }, 3000);

  async function refreshConfig() {
    const previousTarget = cfg.target_wallet;
    const previousTargets = targetWallets;
    const next = await loadConfig(cfg.user_id);
    if (!next?.target_wallet) return;
    const normalizedNext = validateConfig(next);
    configConfirmedAt = Date.now();
    const nextTarget = normalizedNext.target_wallet;
    if (!nextTarget) return;
    const nextTargets = configuredTargetWallets(
      nextTarget,
      normalizedNext.additional_target_wallets,
    );
    cfg = normalizedNext;
    targetWallets = nextTargets;
    monitor.setTargetWallets(nextTargets);
    firstBuyHistory.sync(nextTargets);

    for (const wallet of previousTargets) {
      if (nextTargets.has(wallet) || monitor.isFollowerWalletRetained(wallet)) continue;
      await feed.unwatch(wallet);
      poller.unwatch(wallet);
    }
    for (const wallet of nextTargets) {
      if (previousTargets.has(wallet)) continue;
      await feed.watch(wallet);
      poller.watch(wallet);
    }
    const targetNetworkChanged =
      previousTarget !== nextTarget ||
      previousTargets.size !== nextTargets.size ||
      Array.from(previousTargets).some((wallet) => !nextTargets.has(wallet));
    if (targetNetworkChanged) {
      const refreshedHistory = (
        await Promise.all(Array.from(nextTargets, (wallet) => loadTargetBuyHistory(wallet)))
      )
        .flat()
        .slice(-200);
      targetBuyHistory.hydrate(refreshedHistory);
      log.info(
        {
          previousTarget,
          nextTarget,
          targetWallets: Array.from(nextTargets),
        },
        "target network subscriptions updated",
      );
    }
  }

  setInterval(() => {
    const memory = process.memoryUsage();
    log.info(
      {
        target: cfg.target_wallet,
        additionalTargets: cfg.additional_target_wallets,
        geyser: feed.health(),
        rpcFallback: poller.health(),
        entryEventQueue: entryEventQueue.health(),
        positionEventQueue: positionEventQueue.health(),
        strategyRecorder: strategyRecorder.health(),
        firstBuyHistory: firstBuyHistory.health(targetWallets),
        memoryMb: {
          rss: Math.round(memory.rss / 1024 / 1024),
          heapUsed: Math.round(memory.heapUsed / 1024 / 1024),
        },
      },
      "stream heartbeat",
    );
  }, 30000);

  // Take-profit / stop-loss watcher — polls prices every 4s for all open positions.
  let tpSlRunning = false;
  setInterval(() => {
    if (tpSlRunning) return;
    tpSlRunning = true;
    checkTpSl()
      .catch((err) => log.error({ err }, "tp/sl loop failed"))
      .finally(() => {
        tpSlRunning = false;
      });
  }, 4000);

  async function checkTpSl() {
    if (!cfg?.enabled) return;
    if (!cfg.take_profit_enabled && !cfg.stop_loss_enabled) return;
    const { data: positions, error: positionsError } = await db
      .from("positions")
      .select(
        "id,token_mint,entry_price_usd,amount_tokens,amount_remaining,decimals,tp_taken,mirrored_sold_fraction",
      )
      .eq("user_id", cfg.user_id)
      .is("closed_at", null);
    if (positionsError) throw new Error(`tp/sl positions query failed: ${positionsError.message}`);
    const eligiblePositions = (positions ?? []).filter(
      (pos) => Number(pos.amount_remaining) > 0 && Number(pos.entry_price_usd) > 0,
    );
    const tokenPrices = await pricesUsd(eligiblePositions.map((pos) => pos.token_mint));
    for (const pos of eligiblePositions) {
      const remaining = Number(pos.amount_remaining);
      const entry = Number(pos.entry_price_usd);
      const price = tokenPrices.get(pos.token_mint);
      if (!price || price <= 0) continue;
      const gainPct = ((price - entry) / entry) * 100;

      if (cfg.stop_loss_enabled && gainPct <= -Math.abs(cfg.stop_loss_pct)) {
        const decimals = Number(pos.decimals ?? 0);
        const sellRaw = uiAmountToRaw(remaining, decimals);
        if (sellRaw <= 0n) continue;
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
        const sellRaw = uiAmountToRaw(sellUi, decimals);
        if (sellRaw <= 0n) continue;
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

  async function executeExitSell(
    positionId: string,
    mint: string,
    sellRaw: bigint,
    sellUi: number,
    reason: string,
    markTpTaken = false,
  ) {
    beginPositionSell(positionId);
    try {
      const secret = await loadSigner(cfg.user_id);
      if (!secret) throw new Error("no funding key for tp/sl sell");
      const { data: cur, error: currentError } = await db
        .from("positions")
        .select("amount_remaining,entry_price_usd,decimals")
        .eq("id", positionId)
        .single();
      if (currentError || !cur)
        throw new Error(
          `position reload before sell failed: ${currentError?.message ?? "not found"}`,
        );
      const decimals = Number(cur.decimals ?? 0);
      const walletBalanceRaw = await fundingTokenBalanceRaw(secret, mint);
      const actualSellRaw = capSellRawToBalance(sellRaw, walletBalanceRaw);
      const walletBalanceUi = rawAmountToUi(walletBalanceRaw, decimals);
      if (actualSellRaw <= 0n) {
        const update: any = {
          amount_remaining: 0,
          bot_cost_basis_usd: 0,
          closed_at: new Date().toISOString(),
        };
        if (markTpTaken) update.tp_taken = true;
        const { error: zeroUpdateError } = await db
          .from("positions")
          .update(update)
          .eq("id", positionId);
        if (zeroUpdateError)
          throw new Error(`zero-balance position update failed: ${zeroUpdateError.message}`);
        log.warn(
          { positionId, mint, requestedSellUi: sellUi, reason },
          "exit skipped because funding wallet token balance is zero; position closed",
        );
        await monitor.releasePosition(positionId);
        return;
      }
      const actualSellUi = rawAmountToUi(actualSellRaw, decimals);
      if (actualSellRaw < sellRaw) {
        log.warn(
          {
            positionId,
            mint,
            requestedRaw: sellRaw.toString(),
            availableRaw: walletBalanceRaw.toString(),
            actualRaw: actualSellRaw.toString(),
          },
          "exit sell amount capped to funding wallet token balance",
        );
      }
      const result = await executeSwap({
        signerSecret: secret,
        inputMint: mint,
        outputMint: WSOL,
        amountRaw: actualSellRaw,
        slippageBps: 500,
        route: cfg.execution_route,
        jitoTipSol: cfg.jito_tip_sol,
        outputDecimals: 9,
        preferDirectPump: mint.endsWith("pump"),
      });
      landedButUnreconciledSells.add(positionId);
      const newRemaining = reconciledRemainingUi(
        Number(cur.amount_remaining),
        walletBalanceUi,
        actualSellUi,
      );
      const closed = newRemaining <= 1e-9;
      const update: any = {
        amount_remaining: newRemaining,
        bot_cost_basis_usd: Math.max(0, Number(cur.entry_price_usd ?? 0) * newRemaining),
        closed_at: closed ? new Date().toISOString() : null,
      };
      if (markTpTaken) update.tp_taken = true;
      const { error: updateError } = await db.from("positions").update(update).eq("id", positionId);
      if (updateError) throw new Error(`position update after sell failed: ${updateError.message}`);
      const valuationPrices = await pricesUsd([WSOL, mint]);
      const solPrice = valuationPrices.get(WSOL);
      const tokenPrice = valuationPrices.get(mint);
      const valuation = sellValuation(
        actualSellUi,
        Number(cur.entry_price_usd ?? 0),
        result.outUiAmount,
        solPrice,
        tokenPrice,
      );
      const { error: tradeError } = await db.from("trades").insert({
        user_id: cfg.user_id,
        position_id: positionId,
        side: "sell",
        token_mint: mint,
        amount_tokens: actualSellUi,
        amount_usd: valuation.amountUsd,
        price_usd: valuation.priceUsd,
        pnl_pct: valuation.pnlPct,
        tx_sig: result.txSig,
        reason,
        latency_ms: result.latencyMs,
        route: result.route,
        valuation_source: result.outUiAmountSource ?? "token-price-fallback",
      });
      if (tradeError)
        log.error(
          { err: tradeError, sig: result.txSig },
          "exit sell landed but trade log insert failed",
        );
      landedButUnreconciledSells.delete(positionId);
      log.info({ sig: result.txSig, reason, closed }, "exit sell landed");
      if (closed) await monitor.releasePosition(positionId);
    } finally {
      sellingPositions.delete(positionId);
    }
  }

  async function handle(event: FeedEvent) {
    const key = feedEventKey(event);
    const enqueuedAt = enqueuedAtByEvent.get(key);
    enqueuedAtByEvent.delete(key);
    const queueWaitMs = enqueuedAt === undefined ? undefined : Math.max(0, Date.now() - enqueuedAt);
    if (pendingEvents.has(key) || completedEvents.has(key)) {
      log.debug({ key }, "duplicate feed event skipped");
      return;
    }
    pendingEvents.add(key);
    let completed = false;
    try {
      // Claim every live target-network buy before the entry switch, filters,
      // or execution. A rejected/failed/offline buy is still part of the
      // target's history and must prevent a later buy from appearing "first".
      const firstBuyClaim =
        event.kind === "swap" && event.side === "buy" && targetWallets.has(event.wallet)
          ? await firstBuyHistory.claimLive(event)
          : undefined;
      if (!cfg?.enabled) {
        const positionManagementEvent = isPositionManagementEvent(
          event,
          cfg.target_wallet,
          targetWallets,
          (tokenMint, wallet) => {
            const ctx = monitor.activeForMint(tokenMint);
            return !!ctx && monitor.isFollower(ctx.positionId, wallet);
          },
          (tokenMint) => !!monitor.activeForMint(tokenMint),
        );
        if (!positionManagementEvent) {
          recordStrategyEvent(event, {
            bot_decision: "skipped",
            bot_reason: "new entries disabled",
          });
          log.info("new entries disabled - skipping non-exit event");
          completed = true;
          return;
        }
      }
      if (event.kind === "transfer") {
        await handleTransfer(event);
        completed = true;
        return;
      }
      if (event.kind === "swap") {
        if (targetWallets.has(event.wallet) && event.side === "buy") {
          await runCopyBuy(
            event,
            event.wallet === cfg.target_wallet
              ? "primary target copy buy"
              : "network target copy buy",
            queueWaitMs,
            firstBuyClaim,
          );
          completed = true;
          return;
        }
        if (event.side === "sell") {
          await handleFollowerSell(event, queueWaitMs);
          completed = true;
          return;
        }
        log.info(
          {
            eventWallet: event.wallet,
            targetWallet: cfg.target_wallet,
            side: event.side,
            mint: event.tokenMint,
            txSig: event.txSig,
          },
          "swap event ignored — not target buy or follower sell",
        );
        completed = true;
      }
    } catch (err) {
      // Follower state is persisted before a mirror sell is attempted. The
      // reconciliation loop compares that state with the wallet's on-chain
      // balance, so a missed sell can be retried without blindly replaying the
      // original transaction.
      completed = true;
      recordStrategyEvent(event, {
        bot_decision: "failed",
        bot_reason: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
      });
      log.error({ err, key }, "handler failed — event will not be replayed automatically");
    } finally {
      pendingEvents.delete(key);
      if (completed) rememberCompletedEvent(key);
    }
  }

  async function handleTransfer(ev: TransferEvent) {
    const ctx = monitor.activeForMint(ev.tokenMint);
    const fromIsTarget = targetWallets.has(ev.from);
    const toIsTarget = targetWallets.has(ev.to);

    if (fromIsTarget) {
      if (!toIsTarget && !isTrackableWalletAddress(ev.to)) {
        log.info(
          { from: ev.from, to: ev.to, mint: ev.tokenMint, txSig: ev.txSig },
          "target transfer recipient ignored — address is program controlled or invalid",
        );
        return;
      }

      if (!ctx) {
        const canTriggerNetworkFallback =
          cfg.enabled && targetWallets.has(ev.from) && env.ALLOW_TRANSFER_BUY_FALLBACK;
        if (!canTriggerNetworkFallback) {
          log.info(
            {
              from: ev.from,
              to: ev.to,
              mint: ev.tokenMint,
              txSig: ev.txSig,
            },
            "standalone target-network transfer ignored - no copied position is open",
          );
          return;
        }
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

        const positionId = await runCopyBuy(
          {
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
            source: ev.source,
          },
          "target transfer fallback",
        );

        if (positionId) {
          if (toIsTarget) {
            await monitor.recordTargetCustodyTransfer(
              positionId,
              ev.from,
              ev.to,
              ev.amountTokens,
              ev.slot,
              ev.txSig,
            );
          } else {
            await monitor.recordTargetTransfer(
              positionId,
              ev.from,
              ev.to,
              ev.amountTokens,
              ev.slot,
              ev.txSig,
            );
          }
          recordStrategyEvent(ev, {
            position_id: positionId,
            bot_decision: "tracked",
            bot_reason: toIsTarget
              ? "target-to-target custody transfer retained"
              : "target transfer wallet retained",
          });
        }
        return;
      }
      const tracked = toIsTarget
        ? await monitor.recordTargetCustodyTransfer(
            ctx.positionId,
            ev.from,
            ev.to,
            ev.amountTokens,
            ev.slot,
            ev.txSig,
          )
        : await monitor.recordTargetTransfer(
            ctx.positionId,
            ev.from,
            ev.to,
            ev.amountTokens,
            ev.slot,
            ev.txSig,
          );
      recordStrategyEvent(ev, {
        position_id: ctx.positionId,
        bot_decision: tracked ? "tracked" : "skipped",
        bot_reason: tracked
          ? toIsTarget
            ? "target custody ownership reconciled"
            : "target transfer ownership reconciled and wallet retained"
          : "target transfer was rejected by ownership safety policy",
      });
      return;
    }

    if (!ctx) return;
    const fromIsFollower = await monitor.ensureFollower(
      ctx.positionId,
      ev.from,
      ev.slot,
      ev.txSig,
    );
    if (!fromIsFollower) {
      recordStrategyEvent(ev, {
        position_id: ctx.positionId,
        bot_decision: "skipped",
        bot_reason: "transfer source rejected by database follower ownership check",
      });
      return;
    }
    if (toIsTarget) {
      const tracked = await monitor.recordFollowerReturnToTarget(
        ctx.positionId,
        ev.from,
        ev.to,
        ev.amountTokens,
        ev.slot,
        ev.txSig,
      );
      recordStrategyEvent(ev, {
        position_id: ctx.positionId,
        bot_decision: tracked ? "tracked" : "skipped",
        bot_reason: tracked
          ? "follower inventory moved into target custody"
          : "follower return to target was not attributed",
      });
      return;
    }
    if (!isTrackableWalletAddress(ev.to)) {
      log.info(
        {
          positionId: ctx.positionId,
          from: ev.from,
          to: ev.to,
          mint: ev.tokenMint,
          txSig: ev.txSig,
        },
        "descendant transfer recipient ignored — address is program controlled or invalid",
      );
      return;
    }

    const tracked = await monitor.recordFollowerTransfer(
      ctx.positionId,
      ev.from,
      ev.to,
      ev.amountTokens,
      ev.slot,
      ev.txSig,
    );
    recordStrategyEvent(ev, {
      position_id: ctx.positionId,
      bot_decision: tracked ? "tracked" : "skipped",
      bot_reason: tracked
        ? "descendant transfer wallet retained"
        : "descendant transfer not retained",
    });
  }

  async function runCopyBuy(
    event: SwapEvent,
    reason = "target copy buy",
    queueWaitMs?: number,
    preclaimedFirstBuy?: FirstBuyClaim,
  ) {
    const firstBuyClaim = preclaimedFirstBuy ?? (await firstBuyHistory.claimLive(event));
    if (buyingMints.has(event.tokenMint)) {
      recordStrategyEvent(event, {
        bot_decision: "skipped",
        bot_reason: "another buy for this mint is already in flight",
      });
      log.warn(
        { mint: event.tokenMint, txSig: event.txSig },
        "copy buy skipped — another buy for this mint is already in flight",
      );
      return null;
    }
    buyingMints.add(event.tokenMint);
    try {
      return await tryCopyBuy(event, reason, queueWaitMs, firstBuyClaim);
    } finally {
      buyingMints.delete(event.tokenMint);
    }
  }

  function feedEventKey(event: FeedEvent) {
    const transactionIdentity =
      event.txSig ||
      (event.slot !== undefined ? `slot-${event.slot}` : `observed-${event.timestampMs}`);
    if (event.kind === "transfer") {
      return ["transfer", transactionIdentity, event.from, event.to, event.tokenMint].join(":");
    }
    return ["swap", transactionIdentity, event.wallet, event.side, event.tokenMint].join(":");
  }

  function rememberCompletedEvent(key: string) {
    const now = Date.now();
    completedEvents.set(key, now);
    if (completedEvents.size <= 5_000) return;
    const cutoff = now - 10 * 60_000;
    for (const [candidate, seenAt] of completedEvents) {
      if (seenAt < cutoff || completedEvents.size > 4_000) completedEvents.delete(candidate);
      if (completedEvents.size <= 4_000) break;
    }
  }

  async function handleFollowerSell(ev: SwapEvent, queueWaitMs?: number) {
    const followerHandlerStartedAt = Date.now();
    const ctx = monitor.activeForMint(ev.tokenMint);
    if (!ctx) {
      recordStrategyEvent(ev, {
        bot_decision: "skipped",
        bot_reason: "no active copied position for this token",
      });
      return;
    }
    if (!targetWallets.has(ev.wallet)) {
      const owned = await monitor.ensureFollower(
        ctx.positionId,
        ev.wallet,
        ev.slot,
        ev.txSig,
      );
      if (!owned) {
        recordStrategyEvent(ev, {
          position_id: ctx.positionId,
          bot_decision: "skipped",
          bot_reason: "sell wallet rejected by database follower ownership check",
        });
        return;
      }
      log.info(
        { positionId: ctx.positionId, wallet: ev.wallet, mint: ev.tokenMint, txSig: ev.txSig },
        "follower sell ownership confirmed",
      );
    }
    const persistStartedAt = Date.now();
    const soldFraction = await monitor.recordFollowerSell(
      ctx.positionId,
      ev.wallet,
      ev.amountTokens,
      ev.slot,
      ev.txSig,
    );
    const followerStateMs = Date.now() - persistStartedAt;
    if (soldFraction === null) {
      recordStrategyEvent(ev, {
        position_id: ctx.positionId,
        bot_decision: targetWallets.has(ev.wallet) ? "tracked" : "skipped",
        bot_reason:
          targetWallets.has(ev.wallet)
            ? "target sell observed with no returned follower inventory in target custody"
            : "sell wallet is not retained for this active position",
      });
      return;
    }

    if (!cfg.proportional_follower_sells) {
      recordStrategyEvent(ev, {
        position_id: ctx.positionId,
        bot_decision: "tracked",
        bot_reason: "follower sell recorded; proportional mirroring is disabled",
        metadata: { soldFraction },
      });
      return;
    }

    recordStrategyEvent(ev, {
      position_id: ctx.positionId,
      bot_decision: "mirror_submitted",
      bot_reason:
        targetWallets.has(ev.wallet)
          ? "proportional target-custody sell submitted"
          : "proportional follower sell submitted",
      metadata: { soldFraction },
    });
    const outcome = await executeMirrorSell(
      ctx.positionId,
      ctx.tokenMint,
      soldFraction,
      ev.timestampMs,
    );
    recordStrategyEvent(ev, {
      position_id: ctx.positionId,
      bot_decision: "mirrored",
      bot_reason:
        outcome.kind === "landed"
          ? targetWallets.has(ev.wallet)
            ? "proportional target-custody sell landed"
            : "proportional follower sell landed"
          : "attributed sell was already reflected in the funding wallet",
      bot_tx_sig: outcome.txSig,
      reaction_ms: outcome.reactionMs,
      execution_ms: outcome.executionMs,
      metadata: {
        soldFraction,
        outcome: outcome.kind,
        queueWaitMs,
        followerStateMs,
        handlerToCompleteMs: Date.now() - followerHandlerStartedAt,
        executionStages: outcome.timings,
      },
    });
    log.info(
      {
        positionId: ctx.positionId,
        mint: ctx.tokenMint,
        queueWaitMs,
        followerStateMs,
        handlerToCompleteMs: Date.now() - followerHandlerStartedAt,
        executionStages: outcome.timings,
      },
      "follower sell latency breakdown",
    );
  }

  async function executeMirrorSell(
    positionId: string,
    mint: string,
    soldFraction: number,
    detectedAtMs?: number,
  ) {
    beginPositionSell(positionId);
    try {
      const [secret, { data: currentPosition, error: currentPositionError }] = await Promise.all([
        loadSigner(cfg.user_id),
        db
          .from("positions")
          .select("amount_tokens,amount_remaining,entry_price_usd,decimals,mirrored_sold_fraction")
          .eq("id", positionId)
          .single(),
      ]);
      if (!secret) throw new Error("no funding key for sell");
      if (currentPositionError || !currentPosition) {
        throw new Error(
          `position reload before mirror sell failed: ${currentPositionError?.message ?? "not found"}`,
        );
      }
      const decimals = Number(currentPosition.decimals ?? 0);
      const positionInitialUi = Number(currentPosition.amount_tokens);
      const positionInitialRaw = uiAmountToRaw(positionInitialUi, decimals);
      const effectiveSoldFraction = Math.max(
        Number(currentPosition.mirrored_sold_fraction ?? 0),
        Math.min(1, Math.max(0, soldFraction)),
      );
      const desiredRemainingUi = positionInitialUi * (1 - effectiveSoldFraction);
      const desiredRemainingRaw = uiAmountToRaw(desiredRemainingUi, decimals);
      const walletBalanceRaw = await fundingTokenBalanceRaw(secret, mint);
      const walletBalanceUi = rawAmountToUi(walletBalanceRaw, decimals);
      const sellRaw = capSellRawToBalance(
        mirrorSellRawForDesiredBalance(positionInitialRaw, walletBalanceRaw, desiredRemainingRaw),
        walletBalanceRaw,
      );
      if (sellRaw <= 0n) {
        const newRemaining = Math.min(
          Math.max(0, Number(currentPosition.amount_remaining)),
          walletBalanceUi,
        );
        const closed = newRemaining <= 1e-9;
        const { error: reconcileError } = await db
          .from("positions")
          .update({
            amount_remaining: newRemaining,
            bot_cost_basis_usd: Math.max(
              0,
              Number(currentPosition.entry_price_usd ?? 0) * newRemaining,
            ),
            mirrored_sold_fraction: effectiveSoldFraction,
            closed_at: closed ? new Date().toISOString() : null,
          })
          .eq("id", positionId);
        if (reconcileError)
          throw new Error(`mirror balance reconciliation failed: ${reconcileError.message}`);
        log.info(
          {
            positionId,
            mint,
            soldFraction: effectiveSoldFraction,
            walletBalanceRaw: walletBalanceRaw.toString(),
            desiredRemainingRaw: desiredRemainingRaw.toString(),
            closed,
          },
          "persisted follower sell already reflected in funding wallet balance",
        );
        if (closed) await monitor.releasePosition(positionId);
        return { kind: "reconciled" as const, timings: undefined };
      }
      const sellUi = rawAmountToUi(sellRaw, decimals);
      log.info(
        {
          positionId,
          soldFraction: effectiveSoldFraction,
          sellUi,
          sellRaw: sellRaw.toString(),
          walletBalanceRaw: walletBalanceRaw.toString(),
        },
        "mirroring follower sell",
      );
      const result = await executeSwap({
        signerSecret: secret,
        inputMint: mint,
        outputMint: WSOL,
        amountRaw: sellRaw,
        slippageBps: 500,
        route: cfg.execution_route,
        jitoTipSol: cfg.jito_tip_sol,
        outputDecimals: 9,
        preferDirectPump: mint.endsWith("pump"),
      });
      const reactionMs = reactionLatencyMs(result.latencyMs, detectedAtMs);
      landedButUnreconciledSells.add(positionId);

      const newRemaining = reconciledRemainingUi(
        Number(currentPosition.amount_remaining),
        walletBalanceUi,
        sellUi,
      );
      const closed = newRemaining <= 1e-9;
      const { error: positionUpdateError } = await db
        .from("positions")
        .update({
          amount_remaining: newRemaining,
          bot_cost_basis_usd: Math.max(
            0,
            Number(currentPosition.entry_price_usd ?? 0) * newRemaining,
          ),
          mirrored_sold_fraction: effectiveSoldFraction,
          closed_at: closed ? new Date().toISOString() : null,
        })
        .eq("id", positionId);
      if (positionUpdateError)
        throw new Error(`position update after mirror sell failed: ${positionUpdateError.message}`);
      const valuationPrices = await pricesUsd([WSOL, mint]);
      const solPrice = valuationPrices.get(WSOL);
      const tokenPrice = valuationPrices.get(mint);
      const valuation = sellValuation(
        sellUi,
        Number(currentPosition.entry_price_usd ?? 0),
        result.outUiAmount,
        solPrice,
        tokenPrice,
      );

      const { error: tradeError } = await db.from("trades").insert({
        user_id: cfg.user_id,
        position_id: positionId,
        side: "sell",
        token_mint: mint,
        amount_tokens: sellUi,
        amount_usd: valuation.amountUsd,
        price_usd: valuation.priceUsd,
        pnl_pct: valuation.pnlPct,
        tx_sig: result.txSig,
        reason: `mirror ${Math.round(effectiveSoldFraction * 100)}% followers`,
        latency_ms: reactionMs,
        route: result.route,
        valuation_source: result.outUiAmountSource ?? "token-price-fallback",
      });
      if (tradeError)
        log.error(
          { err: tradeError, sig: result.txSig },
          "mirror sell landed but trade log insert failed",
        );
      landedButUnreconciledSells.delete(positionId);

      log.info(
        { sig: result.txSig, reactionMs, executionMs: result.latencyMs, closed },
        "mirror sell landed",
      );
      if (closed) await monitor.releasePosition(positionId);
      return {
        kind: "landed" as const,
        txSig: result.txSig,
        reactionMs,
        executionMs: result.latencyMs,
        timings: result.timings,
      };
    } finally {
      sellingPositions.delete(positionId);
    }
  }

  async function reconcilePersistedFollowerSells() {
    if (!cfg.proportional_follower_sells) return;
    const { data: positions, error: positionsError } = await db
      .from("positions")
      .select("id,token_mint,mirrored_sold_fraction")
      .eq("user_id", cfg.user_id)
      .is("closed_at", null)
      .gt("amount_remaining", 0);
    if (positionsError)
      throw new Error(`follower reconciliation position query failed: ${positionsError.message}`);

    for (const pos of positions ?? []) {
      if (sellingPositions.has(pos.id) || landedButUnreconciledSells.has(pos.id)) continue;
      const { data: followers, error: followersError } = await db
        .from("follower_wallets")
        .select("initial_amount,current_amount")
        .eq("position_id", pos.id);
      if (followersError) {
        log.error(
          { err: followersError, positionId: pos.id },
          "persisted follower sell reconciliation lookup failed",
        );
        continue;
      }
      if (!followers?.length) continue;
      const soldFraction = aggregateFollowerSoldFraction(followers);
      const recordedFraction = Number(pos.mirrored_sold_fraction ?? 0);
      if (soldFraction <= recordedFraction + 1e-12) continue;
      try {
        log.warn(
          { positionId: pos.id, mint: pos.token_mint, soldFraction, recordedFraction },
          "reconciling persisted follower sell",
        );
        await executeMirrorSell(pos.id, pos.token_mint, soldFraction);
      } catch (err) {
        log.error(
          { err, positionId: pos.id, mint: pos.token_mint, soldFraction },
          "persisted follower sell reconciliation failed; will retry",
        );
      }
      await delay(250);
    }
  }

  function beginPositionSell(positionId: string) {
    if (landedButUnreconciledSells.has(positionId)) {
      throw new Error(
        `position ${positionId} has a landed sell that was not reconciled in Supabase; refusing to sell again`,
      );
    }
    if (sellingPositions.has(positionId)) {
      throw new Error(`position ${positionId} already has a sell in flight`);
    }
    sellingPositions.add(positionId);
  }

  async function tryCopyBuy(
    event: SwapEvent,
    reason = "target copy buy",
    queueWaitMs?: number,
    firstBuyClaim?: FirstBuyClaim,
  ): Promise<string | null> {
    const handlerStartedAt = Date.now();
    const configUserId = cfg.user_id;
    const freshness = targetBuyFreshness(
      event.timestampMs,
      handlerStartedAt,
      env.MAX_BUY_EVENT_AGE_MS,
    );
    if (!freshness.fresh) {
      recordStrategyEvent(event, {
        bot_decision: "skipped",
        bot_reason: `stale target buy (${freshness.ageMs} ms old)`,
        metadata: {
          eventAgeMs: freshness.ageMs,
          maxBuyEventAgeMs: env.MAX_BUY_EVENT_AGE_MS,
        },
      });
      log.warn(
        {
          mint: event.tokenMint,
          txSig: event.txSig,
          eventAgeMs: freshness.ageMs,
          maxBuyEventAgeMs: env.MAX_BUY_EVENT_AGE_MS,
        },
        "stale target buy skipped",
      );
      return null;
    }
    if (event.tokenMint === WSOL || STABLECOIN_MINTS.has(event.tokenMint)) {
      recordStrategyEvent(event, {
        bot_decision: "skipped",
        bot_reason: "output is SOL or a stablecoin, not a token entry",
      });
      log.info(
        { mint: event.tokenMint, txSig: event.txSig },
        "target buy skipped — output is SOL/stablecoin, not a token entry",
      );
      return null;
    }
    const primaryTargetWallet = cfg.target_wallet;
    const targetWallet = event.wallet;
    if (!primaryTargetWallet || !targetWallets.has(targetWallet)) {
      recordStrategyEvent(event, {
        bot_decision: "skipped",
        bot_reason: "event wallet is not in the configured target network",
      });
      log.warn({ eventWallet: targetWallet }, "target buy skipped because wallet is not configured");
      return null;
    }
    const configAgeMs = configSnapshotAgeMs(configConfirmedAt);
    if (!canUseConfigSnapshot(configConfirmedAt)) {
      recordStrategyEvent(event, {
        bot_decision: "skipped",
        bot_reason: `last confirmed dashboard config is stale (${configAgeMs} ms old)`,
      });
      log.error(
        {
          mint: event.tokenMint,
          txSig: event.txSig,
          configAgeMs,
          maxConfigAgeMs: BUY_CONFIG_MAX_STALE_MS,
        },
        "target buy skipped because Supabase config has not refreshed recently",
      );
      return null;
    }
    const buyCfg = Object.freeze({ ...cfg });
    if (!buyCfg.enabled) {
      recordStrategyEvent(event, {
        bot_decision: "skipped",
        bot_reason: "bot disabled by fresh config check",
      });
      log.info(
        { mint: event.tokenMint, configUpdatedAt: buyCfg.updated_at },
        "target buy skipped because the latest dashboard config is disabled",
      );
      return null;
    }
    if (configAgeMs > 6_000) {
      log.warn(
        { configAgeMs, maxConfigAgeMs: BUY_CONFIG_MAX_STALE_MS },
        "using recently confirmed cached bot config while Supabase refresh is delayed",
      );
    }
    log.info(
      {
        target: event.wallet,
        mint: event.tokenMint,
        tokenAmount: event.amountTokens,
        solDelta: event.solDelta,
        txSig: event.txSig,
        reason,
      },
      "target buy candidate",
    );
    // If scaling is disabled, this event can only be a new entry. Size it
    // before per-token database reads so a clearly undersized target buy can
    // never hold the serial entry queue behind a slow Supabase request.
    if (!buyCfg.network_scaling_enabled) {
      const earlySolPriceResult = await reliableSolPriceUsd();
      const earlyTargetBuyUsd =
        event.amountUsd ??
        (earlySolPriceResult && Math.abs(event.solDelta) > 0.0005
          ? Math.abs(event.solDelta) * earlySolPriceResult.priceUsd
          : undefined);
      event.amountUsd = earlyTargetBuyUsd;
      const earlyEntryLimits = effectiveScannerEntryLimits(
        {
          enabled: buyCfg.large_buy_scanner_enabled,
          maxMarketCapUsd: Number(buyCfg.large_buy_scanner_max_mc_usd),
          minTargetBuyUsd: Number(buyCfg.large_buy_scanner_min_buy_usd),
          unusualMultiplier: Number(buyCfg.large_buy_scanner_multiplier),
          historyWindow: Number(buyCfg.large_buy_scanner_history_window),
        },
        Number(buyCfg.min_target_buy_usd),
        Number(buyCfg.mc_min_usd),
        Number(buyCfg.mc_max_usd),
      );
      const minimumDecision = checkTargetBuyMinimum(
        earlyEntryLimits.minTargetBuyUsd,
        event,
      );
      if (!minimumDecision.pass) {
        recordStrategyEvent(event, {
          amount_usd: earlyTargetBuyUsd,
          bot_decision: "filtered",
          bot_reason: minimumDecision.reason,
          metadata: {
            solPrice: earlySolPriceResult?.priceUsd,
            solPriceSource: earlySolPriceResult?.source,
            earlyPreflight: true,
            effectiveEntryLimitSource: earlyEntryLimits.source,
          },
        });
        log.info(
          {
            reason: minimumDecision.reason,
            mint: event.tokenMint,
            targetBuyUsd:
              earlyTargetBuyUsd === undefined ? "unknown" : earlyTargetBuyUsd.toFixed(2),
            effectiveMinTargetBuyUsd: earlyEntryLimits.minTargetBuyUsd,
          },
          "filtered before per-token database checks",
        );
        return null;
      }
    }
    // These reads are independent. Starting them together removes several
    // network round trips from the detection-to-submission path.
    const metaPromise = loadTokenMeta(event.tokenMint);
    // A live Pump.fun curve is authoritative even when DexScreener has already
    // published a value, because the public index can lag a fast curve.
    const pumpMarketCapSolPromise =
      event.isPumpFun || event.tokenMint.endsWith("pump")
        ? quotePumpFunMarketCapSol(event.tokenMint)
        : Promise.resolve(undefined);
    const openPositionPromise = db
      .from("positions")
      .select(
        "id,entry_price_usd,amount_tokens,amount_remaining,decimals,network_target_spend_usd,bot_cost_basis_usd,campaign_bankroll_usd,root_buy_count",
      )
      .eq("user_id", configUserId)
      .eq("token_mint", event.tokenMint)
      .is("closed_at", null)
      .limit(1)
      .maybeSingle();
    const priorPromise = db
      .from("traded_tokens")
      .select("token_mint")
      .eq("user_id", configUserId)
      .eq("token_mint", event.tokenMint)
      .maybeSingle();
    const solPricePromise = reliableSolPriceUsd();
    const signerPromise = loadSigner(configUserId);
    const preflightStartedAt = Date.now();
    const [
      loadedMeta,
      { data: openPosition, error: openPositionError },
      { data: prior, error: priorError },
      solPriceResult,
      secret,
      pumpMarketCapSol,
    ] = await Promise.all([
      metaPromise,
      openPositionPromise,
      priorPromise,
      solPricePromise,
      signerPromise,
      pumpMarketCapSolPromise,
    ]);
    const preflightMs = Date.now() - preflightStartedAt;
    if (!buyCfg.enabled) {
      recordStrategyEvent(event, {
        bot_decision: "skipped",
        bot_reason: "bot disabled by fresh config check",
      });
      log.info(
        { mint: event.tokenMint, configUpdatedAt: buyCfg.updated_at },
        "target buy skipped because the latest dashboard config is disabled",
      );
      return null;
    }
    const freshTargetWallets = configuredTargetWallets(
      buyCfg.target_wallet,
      buyCfg.additional_target_wallets,
    );
    if (
      buyCfg.target_wallet !== primaryTargetWallet ||
      !freshTargetWallets.has(event.wallet)
    ) {
      recordStrategyEvent(event, {
        bot_decision: "skipped",
        bot_reason: "target wallet changed while the buy candidate was being checked",
      });
      log.warn(
        {
          eventWallet: event.wallet,
          previousTargetWallet: primaryTargetWallet,
          freshTargetWallet: buyCfg.target_wallet,
        },
        "stale target buy skipped after fresh config reload",
      );
      return null;
    }
    const firstBuyState = firstBuyFilterState(
      firstBuyHistory.isReady(freshTargetWallets),
      firstBuyClaim,
    );
    if (buyCfg.only_first_buy_ever && !firstBuyState.ready) {
      recordStrategyEvent(event, {
        bot_decision: "skipped",
        bot_reason: firstBuyState.reason,
        metadata: {
          firstBuyHistory: firstBuyHistory.health(freshTargetWallets),
        },
      });
      log.warn(
        {
          mint: event.tokenMint,
          txSig: event.txSig,
          reason: firstBuyState.reason,
          history: firstBuyHistory.health(freshTargetWallets),
        },
        "first-ever target buy skipped because history is not ready",
      );
      return null;
    }
    let meta = loadedMeta;
    const marketCapSelection = selectAuthoritativeMarketCap(
      loadedMeta.marketCapUsd,
      pumpMarketCapSol,
      solPriceResult?.priceUsd,
    );
    meta = {
      ...meta,
      marketCapUsd: marketCapSelection.marketCapUsd,
      lookupError:
        marketCapSelection.marketCapUsd !== undefined && meta.liquidityUsd === undefined
          ? "DexScreener base-token pair is missing liquidity data"
          : meta.lookupError,
    };
    const marketCapSource = marketCapSelection.source;
    const hasSocials = Boolean(
      meta.socials.website || meta.socials.twitter || meta.socials.telegram,
    );
    const metaPatch: StrategyObservationPatch = {
      market_cap_usd: meta.marketCapUsd,
      liquidity_usd: meta.liquidityUsd,
      has_socials: hasSocials,
      metadata: {
        metadataLookupError: meta.lookupError,
        isPumpFun: meta.isPumpFun,
        marketCapSource,
        dexMarketCapUsd: marketCapSelection.dexMarketCapUsd,
        pumpOnChainMarketCapUsd: marketCapSelection.pumpOnChainMarketCapUsd,
        configuredMarketCapRangeUsd: [buyCfg.mc_min_usd, buyCfg.mc_max_usd],
        configUpdatedAt: buyCfg.updated_at,
        priceChange24hPct: meta.priceChange24hPct,
      },
    };
    recordStrategyEvent(event, metaPatch);
    if (openPositionError)
      throw new Error(`open position lookup failed: ${openPositionError.message}`);
    if (openPosition && !buyCfg.network_scaling_enabled) {
      recordStrategyEvent(event, {
        ...metaPatch,
        position_id: openPosition.id,
        bot_decision: "skipped",
        bot_reason: "a copied position for this token is already open",
      });
      log.info(
        { mint: event.tokenMint, positionId: openPosition.id },
        "target buy skipped — a position for this mint is already open",
      );
      return null;
    }
    if (priorError) throw new Error(`traded token lookup failed: ${priorError.message}`);
    // Best-effort USD size of the target's buy using the wallet's WSOL/SOL delta in this tx.
    if (!solPriceResult) {
      recordStrategyEvent(event, {
        ...metaPatch,
        bot_decision: "skipped",
        bot_reason: "reliable SOL/USD price unavailable",
      });
      log.warn(
        { mint: event.tokenMint, fixedBuyUsd: buyCfg.fixed_buy_usd },
        "buy skipped — reliable SOL/USD price unavailable",
      );
      return null;
    }
    const solPrice = solPriceResult.priceUsd;
    const targetBuyUsd =
      event.amountUsd ??
      (Math.abs(event.solDelta) > 0.0005 ? Math.abs(event.solDelta) * solPrice : undefined);
    event.amountUsd = targetBuyUsd;
    const scannerDecision = evaluateLargeBuySignal(
      {
        enabled: buyCfg.large_buy_scanner_enabled,
        maxMarketCapUsd: Number(buyCfg.large_buy_scanner_max_mc_usd),
        minTargetBuyUsd: Number(buyCfg.large_buy_scanner_min_buy_usd),
        unusualMultiplier: Number(buyCfg.large_buy_scanner_multiplier),
        historyWindow: Number(buyCfg.large_buy_scanner_history_window),
      },
      targetBuyUsd,
      meta.marketCapUsd,
      targetBuyHistory.recent(Number(buyCfg.large_buy_scanner_history_window)),
    );
    targetBuyHistory.observe(feedEventKey(event), targetBuyUsd);
    recordStrategyEvent(event, {
      ...metaPatch,
      amount_usd: targetBuyUsd,
      metadata: {
        ...metaPatch.metadata,
        solPrice,
        solPriceSource: solPriceResult.source,
        largeBuyScanner: scannerDecision,
      },
    });
    if (!openPosition && !scannerDecision.pass) {
      recordStrategyEvent(event, {
        ...metaPatch,
        amount_usd: targetBuyUsd,
        bot_decision: "filtered",
        bot_reason: scannerDecision.reason,
        metadata: {
          ...metaPatch.metadata,
          solPrice,
          solPriceSource: solPriceResult.source,
          largeBuyScanner: scannerDecision,
        },
      });
      log.info(
        {
          mint: event.tokenMint,
          targetBuyUsd,
          marketCapUsd: meta.marketCapUsd,
          scanner: scannerDecision,
        },
        "large-buy scanner filtered target buy",
      );
      return null;
    }
    // One atomic, user-scoped history is shared by the entire configured target
    // network. Scale-ins on an already-open position bypass this entry-only
    // filter below, so conviction scaling continues to work.
    const firstBuy = firstBuyState.first;
    const scannerSettings = {
      enabled: buyCfg.large_buy_scanner_enabled,
      maxMarketCapUsd: Number(buyCfg.large_buy_scanner_max_mc_usd),
      minTargetBuyUsd: Number(buyCfg.large_buy_scanner_min_buy_usd),
      unusualMultiplier: Number(buyCfg.large_buy_scanner_multiplier),
      historyWindow: Number(buyCfg.large_buy_scanner_history_window),
    };
    const effectiveEntryLimits = effectiveScannerEntryLimits(
      scannerSettings,
      Number(buyCfg.min_target_buy_usd),
      Number(buyCfg.mc_min_usd),
      Number(buyCfg.mc_max_usd),
    );
    const effectiveBuyCfg = Object.freeze({
      ...buyCfg,
      min_target_buy_usd: effectiveEntryLimits.minTargetBuyUsd,
      mc_min_usd: effectiveEntryLimits.minMarketCapUsd,
      mc_max_usd: effectiveEntryLimits.maxMarketCapUsd,
    });
    const decision = checkEntry(effectiveBuyCfg, event, meta, {
      first: firstBuy,
      already: !!prior || sessionTradedMints.has(event.tokenMint),
    }, openPosition ? "scale" : "entry");
    if (!decision.pass) {
      recordStrategyEvent(event, {
        ...metaPatch,
        amount_usd: targetBuyUsd,
        bot_decision: "filtered",
        bot_reason: decision.reason,
        metadata: {
          ...metaPatch.metadata,
          firstBuy,
          alreadyTraded: !!prior || sessionTradedMints.has(event.tokenMint),
        },
      });
      log.info(
        {
          reason: decision.reason,
          mint: event.tokenMint,
          targetBuyUsd: targetBuyUsd === undefined ? "unknown" : targetBuyUsd.toFixed(2),
          meta,
          cfg: {
            minTargetBuyUsd: buyCfg.min_target_buy_usd,
            mcMinUsd: buyCfg.mc_min_usd,
            mcMaxUsd: buyCfg.mc_max_usd,
            effectiveMinTargetBuyUsd: effectiveEntryLimits.minTargetBuyUsd,
            effectiveMcMinUsd: effectiveEntryLimits.minMarketCapUsd,
            effectiveMcMaxUsd: effectiveEntryLimits.maxMarketCapUsd,
            effectiveEntryLimitSource: effectiveEntryLimits.source,
            liqMinUsd: buyCfg.liq_min_usd,
            liqMaxUsd: buyCfg.liq_max_usd,
            pumpFunOnly: buyCfg.pump_fun_only,
            requireSocials: buyCfg.require_socials,
            require24hUptrend: buyCfg.require_24h_uptrend,
            largeBuyScannerEnabled: buyCfg.large_buy_scanner_enabled,
            largeBuyScannerDecision: scannerDecision,
            onlyFirstBuyEver: buyCfg.only_first_buy_ever,
            onlyOncePerToken: buyCfg.only_once_per_token,
            configUpdatedAt: buyCfg.updated_at,
          },
        },
        "filtered",
      );
      return null;
    }
    log.info(
      {
        mint: event.tokenMint,
        marketCapUsd: meta.marketCapUsd,
        marketCapRangeUsd: [
          effectiveEntryLimits.minMarketCapUsd,
          effectiveEntryLimits.maxMarketCapUsd,
        ],
        marketCapRangeSource: effectiveEntryLimits.source,
        liquidityUsd: meta.liquidityUsd,
        liquidityRangeUsd: [buyCfg.liq_min_usd, buyCfg.liq_max_usd],
        priceChange24hPct: meta.priceChange24hPct,
        require24hUptrend: buyCfg.require_24h_uptrend,
        marketCapSource,
        dexMarketCapUsd: marketCapSelection.dexMarketCapUsd,
        pumpOnChainMarketCapUsd: marketCapSelection.pumpOnChainMarketCapUsd,
        configUpdatedAt: buyCfg.updated_at,
      },
      "entry filters passed",
    );

    if (!secret) {
      recordStrategyEvent(event, {
        ...metaPatch,
        amount_usd: targetBuyUsd,
        bot_decision: "failed",
        bot_reason: "funding key is not available",
      });
      log.error({ user_id: buyCfg.user_id }, "no funding key saved for this config user");
      return null;
    }

    if (openPosition && (targetBuyUsd === undefined || targetBuyUsd <= 0)) {
      recordStrategyEvent(event, {
        ...metaPatch,
        position_id: openPosition.id,
        bot_decision: "skipped",
        bot_reason: "network scale-in skipped because target buy size is unavailable",
      });
      log.info(
        { mint: event.tokenMint, positionId: openPosition.id, targetWallet },
        "network scale-in waiting for an attributable target buy size",
      );
      return openPosition.id;
    }

    let cumulativeTargetSpendUsd = targetBuyUsd ?? 0;
    let targetBuyCount = 1;
    if (openPosition) {
      const { data: targetBuyRecordRaw, error: targetBuyRecordError } = await db.rpc(
        "record_network_target_buy",
        {
          p_position_id: openPosition.id,
          p_event_key: feedEventKey(event),
          p_target_wallet: targetWallet,
          p_tx_sig: event.txSig,
          p_amount_usd: targetBuyUsd,
          p_amount_tokens: event.amountTokens,
          p_event_at: new Date(event.timestampMs).toISOString(),
        },
      );
      if (targetBuyRecordError) {
        throw new Error(`network target buy persistence failed: ${targetBuyRecordError.message}`);
      }
      const targetBuyRecord = (Array.isArray(targetBuyRecordRaw)
        ? targetBuyRecordRaw[0]
        : targetBuyRecordRaw) as {
        status?: string;
        cumulative_target_spend_usd?: number | string;
        target_buy_count?: number | string;
      } | null;
      if (targetBuyRecord?.status === "duplicate") {
        log.info(
          { mint: event.tokenMint, positionId: openPosition.id, targetWallet },
          "duplicate network target buy skipped",
        );
        return openPosition.id;
      }
      if (targetBuyRecord?.status !== "recorded") {
        throw new Error(
          `network target buy was not recorded: ${targetBuyRecord?.status ?? "no result"}`,
        );
      }
      cumulativeTargetSpendUsd = Number(targetBuyRecord.cumulative_target_spend_usd ?? 0);
      targetBuyCount = Number(targetBuyRecord.target_buy_count ?? 0);
    }

    const capital = await capitalSnapshot(
      buyCfg.user_id,
      secret,
      solPrice,
      Number(buyCfg.jito_tip_sol),
    );
    const currentPositionCostUsd = openPosition
      ? Number(openPosition.bot_cost_basis_usd ?? 0) > 0
        ? Number(openPosition.bot_cost_basis_usd)
        : Number(openPosition.entry_price_usd ?? 0) * Number(openPosition.amount_remaining ?? 0)
      : 0;
    const sizing = decideNetworkBuy({
      bankrollUsd: capital.bankrollUsd,
      availableUsd: capital.availableUsd,
      openCampaignCostUsd: capital.openCampaignCostUsd,
      currentPositionCostUsd,
      cumulativeTargetSpendUsd,
      isNewPosition: !openPosition,
      fixedBuyUsd: Number(buyCfg.fixed_buy_usd),
      settings: {
        enabled: buyCfg.network_scaling_enabled,
        starterPositionPct: Number(buyCfg.starter_position_pct),
        maxPositionPct: Number(buyCfg.max_position_pct),
        newEntryReservePct: Number(buyCfg.new_entry_reserve_pct),
        targetCopyRatioPct: Number(buyCfg.target_copy_ratio_pct),
        minScaleBuyUsd: Number(buyCfg.min_scale_buy_usd),
      },
    });
    if (sizing.buyUsd <= 0) {
      recordStrategyEvent(event, {
        ...metaPatch,
        position_id: openPosition?.id,
        amount_usd: targetBuyUsd,
        bot_decision: "skipped",
        bot_reason: `capital-aware sizing: ${sizing.reason}`,
        metadata: {
          ...metaPatch.metadata,
          sizing,
          capital,
          cumulativeTargetSpendUsd,
          targetBuyCount,
        },
      });
      log.info(
        {
          mint: event.tokenMint,
          positionId: openPosition?.id,
          targetWallet,
          cumulativeTargetSpendUsd,
          targetBuyCount,
          capital,
          sizing,
        },
        "capital-aware target buy recorded without spending",
      );
      return openPosition?.id ?? null;
    }

    const amountLamports = buyLamportsForUsd(sizing.buyUsd, solPrice);
    const plannedBuyUsd = usdValueOfLamports(amountLamports, solPrice);
    log.info(
      {
        mint: event.tokenMint,
        fixedBuyUsd: buyCfg.fixed_buy_usd,
        capitalAwareBuyUsd: sizing.buyUsd,
        sizingReason: sizing.reason,
        desiredPositionUsd: sizing.desiredPositionUsd,
        positionCapUsd: sizing.positionCapUsd,
        cumulativeTargetSpendUsd,
        targetBuyCount,
        plannedBuyUsd,
        solPrice,
        solPriceSource: solPriceResult.source,
        amountLamports: amountLamports.toString(),
        route: buyCfg.execution_route,
      },
      "submitting copy buy",
    );
    recordStrategyEvent(event, {
      ...metaPatch,
      amount_usd: targetBuyUsd,
      bot_decision: "copy_submitted",
      bot_reason: reason,
      metadata: {
        ...metaPatch.metadata,
        plannedBuyUsd,
        solPrice,
        solPriceSource: solPriceResult.source,
      },
    });

    const result = await executeSwap({
      signerSecret: secret,
      inputMint: WSOL,
      outputMint: event.tokenMint,
      amountRaw: amountLamports,
      slippageBps: 300,
      route: buyCfg.execution_route,
      jitoTipSol: buyCfg.jito_tip_sol,
      outputDecimals: event.decimals,
      preferDirectPump: event.isPumpFun || event.tokenMint.endsWith("pump"),
      marketCapGuard:
        event.isPumpFun || event.tokenMint.endsWith("pump")
          ? {
              minUsd: effectiveEntryLimits.minMarketCapUsd,
              maxUsd: effectiveEntryLimits.maxMarketCapUsd,
              solPriceUsd: solPrice,
            }
          : undefined,
    });
    const persistenceStartedAt = Date.now();
    const reactionMs = reactionLatencyMs(result.latencyMs, event.timestampMs);
    sessionTradedMints.add(event.tokenMint);

    const executedInputRaw = result.inRawAmount ? BigInt(result.inRawAmount) : amountLamports;
    if (executedInputRaw !== amountLamports) {
      throw new Error(
        `landed buy input ${executedInputRaw} did not match requested input ${amountLamports}`,
      );
    }
    const executedBuyUsd = usdValueOfLamports(executedInputRaw, solPrice);

    // executeSwap prefers the confirmed wallet-balance increase and falls back
    // to the route quote only when the balance observation is unavailable.
    const receivedUi = result.outUiAmount ?? 0;

    // Cost basis must be the bot's exact input divided by its confirmed token
    // receipt. A public display price can differ sharply on thin new tokens.
    const entryPrice =
      receivedUi > 0 ? executedBuyUsd / receivedUi : ((await priceUsd(event.tokenMint)) ?? 0);

    let pos: { id: string } | null = null;
    let positionError: { message: string } | null = null;
    if (openPosition) {
      const previousTotal = Number(openPosition.amount_tokens ?? 0);
      const previousRemaining = Number(openPosition.amount_remaining ?? 0);
      const previousEntryPrice = Number(openPosition.entry_price_usd ?? 0);
      const previousRemainingBasis =
        Number(openPosition.bot_cost_basis_usd ?? 0) > 0
          ? Number(openPosition.bot_cost_basis_usd)
          : previousEntryPrice * previousRemaining;
      const newTotal = previousTotal + receivedUi;
      const newRemaining = previousRemaining + receivedUi;
      const newRemainingBasis = previousRemainingBasis + executedBuyUsd;
      const blendedEntryPrice =
        newRemaining > 0 ? newRemainingBasis / newRemaining : entryPrice;
      const mirroredSoldFraction =
        newTotal > 0 ? Math.max(0, Math.min(1, 1 - newRemaining / newTotal)) : 0;
      const updateResult = await db
        .from("positions")
        .update({
          entry_price_usd: blendedEntryPrice,
          amount_tokens: newTotal,
          amount_remaining: newRemaining,
          bot_cost_basis_usd: newRemainingBasis,
          campaign_bankroll_usd:
            Number(openPosition.campaign_bankroll_usd ?? 0) > 0
              ? Number(openPosition.campaign_bankroll_usd)
              : capital.bankrollUsd,
          mirrored_sold_fraction: mirroredSoldFraction,
        })
        .eq("id", openPosition.id)
        .select("id")
        .single();
      pos = updateResult.data;
      positionError = updateResult.error;
    } else {
      const insertResult = await db
        .from("positions")
        .insert({
          user_id: buyCfg.user_id,
          token_mint: event.tokenMint,
          entry_price_usd: entryPrice,
          amount_tokens: receivedUi,
          amount_remaining: receivedUi,
          decimals: event.decimals,
          mirrored_sold_fraction: 0,
          tp_taken: false,
          entry_tx_sig: result.txSig,
          entry_slot: event.slot,
          network_target_spend_usd: cumulativeTargetSpendUsd,
          bot_cost_basis_usd: executedBuyUsd,
          campaign_bankroll_usd: capital.bankrollUsd,
          root_buy_count: targetBuyCount,
          last_root_buy_at: new Date(event.timestampMs).toISOString(),
          last_root_buy_wallet: targetWallet,
        })
        .select("id")
        .single();
      pos = insertResult.data;
      positionError = insertResult.error;
      if (pos && targetBuyUsd !== undefined && targetBuyUsd > 0) {
        const { error: targetEventError } = await db.from("network_target_buy_events").insert({
          position_id: pos.id,
          event_key: feedEventKey(event),
          target_wallet: targetWallet,
          tx_sig: event.txSig || null,
          amount_usd: targetBuyUsd,
          amount_tokens: event.amountTokens,
          event_at: new Date(event.timestampMs).toISOString(),
        });
        if (targetEventError) {
          log.error(
            { err: targetEventError, positionId: pos.id, targetWallet },
            "initial network target buy event could not be saved",
          );
        }
      }
    }

    const { error: tradeError } = await db.from("trades").insert({
      user_id: buyCfg.user_id,
      position_id: pos?.id,
      side: "buy",
      token_mint: event.tokenMint,
      amount_tokens: receivedUi,
      amount_usd: executedBuyUsd,
      price_usd: entryPrice,
      tx_sig: result.txSig,
      reason: openPosition
        ? `network scale-in from ${targetWallet.slice(0, 6)}`
        : reason,
      latency_ms: reactionMs,
      route: result.route,
      valuation_source:
        result.outUiAmountSource === "wallet-token-delta"
          ? "exact-input-and-wallet-token-delta"
          : "exact-input-and-route-output",
    });
    const { error: tradedTokenError } = await db
      .from("traded_tokens")
      .upsert({ user_id: buyCfg.user_id, token_mint: event.tokenMint });
    const { error: targetTokenError } = await db
      .from("target_traded_tokens")
      .upsert({ target_wallet: targetWallet, token_mint: event.tokenMint });

    if (positionError || !pos) {
      recordStrategyEvent(event, {
        ...metaPatch,
        amount_usd: targetBuyUsd,
        bot_decision: "copied",
        bot_reason: "copy buy landed, but its position could not be saved",
        bot_tx_sig: result.txSig,
        reaction_ms: reactionMs,
        execution_ms: result.latencyMs,
        metadata: {
          ...metaPatch.metadata,
          plannedBuyUsd,
          executedBuyUsd,
          exactInputLamports: executedInputRaw.toString(),
          priceImpactPct: result.priceImpactPct,
          receivedTokens: receivedUi,
          positionSaveError: positionError?.message ?? "position row missing",
        },
      });
      log.fatal(
        {
          err: positionError,
          sig: result.txSig,
          mint: event.tokenMint,
          tradeLogError: tradeError,
        },
        "COPY BUY LANDED but its position could not be saved — automatic exits are blocked for this trade",
      );
      return null;
    }
    if (tradeError)
      log.error(
        { err: tradeError, sig: result.txSig },
        "copy buy landed but trade log insert failed",
      );
    if (tradedTokenError)
      log.error(
        { err: tradedTokenError, mint: event.tokenMint },
        "copy buy landed but once-per-token marker failed",
      );
    if (targetTokenError)
      log.error(
        { err: targetTokenError, mint: event.tokenMint },
        "copy buy landed but target history marker failed",
      );

    if (!openPosition) {
      await monitor.onCopyBuy({
        positionId: pos.id,
        tokenMint: event.tokenMint,
        targetWallet: primaryTargetWallet,
      });
    }
    const persistenceAndMonitorMs = Date.now() - persistenceStartedAt;
    const handlerToCompleteMs = Date.now() - handlerStartedAt;
    recordStrategyEvent(event, {
      ...metaPatch,
      position_id: pos.id,
      amount_usd: targetBuyUsd,
      bot_decision: "copied",
      bot_reason: "copy buy landed and follower monitoring was armed",
      bot_tx_sig: result.txSig,
      reaction_ms: reactionMs,
      execution_ms: result.latencyMs,
      metadata: {
        ...metaPatch.metadata,
        plannedBuyUsd,
        executedBuyUsd,
        exactInputLamports: executedInputRaw.toString(),
        priceImpactPct: result.priceImpactPct,
        receivedTokens: receivedUi,
        entryPriceUsd: entryPrice,
        solPrice,
        solPriceSource: solPriceResult.source,
        queueWaitMs,
        preflightMs,
        persistenceAndMonitorMs,
        handlerToCompleteMs,
        executionStages: result.timings,
      },
    });
    log.info(
      {
        sig: result.txSig,
        reactionMs,
        executionMs: result.latencyMs,
        plannedBuyUsd,
        executedBuyUsd,
        exactInputLamports: executedInputRaw.toString(),
        priceImpactPct: result.priceImpactPct,
        solPrice,
        solPriceSource: solPriceResult.source,
        targetBuyUsd: targetBuyUsd === undefined ? "unknown" : targetBuyUsd.toFixed(2),
        queueWaitMs,
        preflightMs,
        persistenceAndMonitorMs,
        handlerToCompleteMs,
        executionStages: result.timings,
      },
      "copy buy landed — follower monitor armed",
    );
    return pos?.id ?? null;
  }
}

process.on("unhandledRejection", (err) => {
  log.fatal({ err }, "unhandled rejection; exiting so the service manager can restart safely");
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  log.fatal({ err }, "uncaught exception; exiting so the service manager can restart safely");
  process.exit(1);
});

main().catch((e) => {
  log.error(e, "worker crashed before startup completed");
  process.exit(1);
});
