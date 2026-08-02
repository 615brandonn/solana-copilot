// Helix worker entrypoint. Long-running Node process. Deploy on a
// low-latency VPS geographically close to Jito block engine + your RPC.

import pino from "pino";
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

const log = pino({ level: env.LOG_LEVEL });
const WSOL = "So11111111111111111111111111111111111111112";
const STABLECOIN_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCo24RDUuUuJZq8bn6T", // USDT
]);
const rpc = new Connection(env.RPC_URL, { commitment: "processed" });

async function loadConfig(userId: string): Promise<BotConfigRow | null> {
  const byUser = await db.from("bot_config").select("*").eq("user_id", userId).maybeSingle();
  if (byUser.error) log.error({ err: byUser.error }, "bot_config query error (by user_id)");
  if (byUser.data?.target_wallet) return byUser.data as BotConfigRow;
  const any = await db.from("bot_config").select("*")
    .not("target_wallet", "is", null).neq("target_wallet", "")
    .order("updated_at", { ascending: false }).limit(1);
  if (any.error) log.error({ err: any.error }, "bot_config query error (fallback)");
  const row = any.data?.[0];
  if (row) log.warn({ requested_user_id: userId, found_user_id: row.user_id, target: row.target_wallet }, "using fallback bot_config row — HELIX_USER_ID may not match dashboard config");
  return (row as BotConfigRow) ?? null;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loadSigner(userId: string): Promise<string | null> {
  const { data } = await db.from("funding_keys").select("ciphertext").eq("user_id", userId).maybeSingle();
  if (!data) return null;
  return decryptPrivateKey(data.ciphertext);
}

async function logFundingWalletReadiness(userId: string, fixedBuyUsd: number) {
  try {
    const secret = await loadSigner(userId);
    if (!secret) {
      log.error({ user_id: userId }, "readiness failed — no funding private key saved for this config user");
      return;
    }

    const decoded = bs58.decode(secret.trim());
    if (decoded.length !== 64) {
      log.error({ decodedBytes: decoded.length }, "readiness failed — funding private key is not a 64-byte Phantom/Solana secret key");
      return;
    }

    const signer = Keypair.fromSecretKey(decoded);
    const balanceLamports = await rpc.getBalance(signer.publicKey, "processed");
    const solBalance = balanceLamports / 1e9;
    log.info({
      fundingWallet: signer.publicKey.toBase58(),
      solBalance,
      fixedBuyUsd,
    }, "funding wallet ready");

    if (solBalance < 0.02) {
      log.warn({ fundingWallet: signer.publicKey.toBase58(), solBalance }, "funding wallet SOL balance is very low");
    }
  } catch (err) {
    log.error({ err }, "readiness failed — could not decrypt/check funding wallet");
  }
}

async function priceUsd(mint: string): Promise<number | undefined> {
  try {
    const r = await fetch(`${env.PRICE_API_URL}?ids=${mint}`);
    const j = (await r.json()) as any;
    return j?.data?.[mint]?.price;
  } catch { return undefined; }
}

async function waitForConfig(userId: string): Promise<BotConfigRow> {
  let logged = false;
  while (true) {
    const cfg = await loadConfig(userId);
    if (cfg?.target_wallet) { log.info({ user_id: cfg.user_id, target: cfg.target_wallet }, "config loaded"); return cfg; }
    if (!logged) { log.warn({ userId }, "no target wallet configured yet — polling every 5s"); logged = true; }
    await delay(5000);
  }
}

async function main() {
  const USER_ID = env.HELIX_USER_ID;
  let cfg = await waitForConfig(USER_ID);
  await logFundingWalletReadiness(cfg.user_id, cfg.fixed_buy_usd);

  const feed = new GeyserFeed(async (event) => handle(event));
  const poller = new RpcBackfillPoller(rpc, async (event) => handle(event));
  const monitor = new FollowerMonitor(feed, poller);

  const initialTargetWallet = cfg.target_wallet;
  if (!initialTargetWallet) throw new Error("config loaded without a target wallet");

  // Rehydrate any positions still open from a previous worker run so we keep
  // monitoring their followers across restarts.
  const { data: openPositions } = await db.from("positions")
    .select("id,token_mint,amount_remaining").eq("user_id", cfg.user_id).is("closed_at", null);
  for (const pos of openPositions ?? []) {
    if (Number(pos.amount_remaining) <= 0) continue;
    await monitor.onCopyBuy({ positionId: pos.id, tokenMint: pos.token_mint, targetWallet: initialTargetWallet });
    const { data: followers } = await db.from("follower_wallets").select("wallet").eq("position_id", pos.id);
    for (const f of followers ?? []) {
      await feed.watch(f.wallet);
      poller.watch(f.wallet);
    }
  }

  while (true) {
    try { await feed.start([initialTargetWallet]); break; }
    catch (err) { log.error({ err }, "geyser start failed — retrying in 2s"); await delay(2000); }
  }
  poller.start([initialTargetWallet]);

  setInterval(async () => {
    try {
      const previousTarget = cfg.target_wallet;
      const next = await loadConfig(cfg.user_id);
      if (!next?.target_wallet) return;
      cfg = next;
      if (previousTarget && previousTarget !== next.target_wallet) {
        await feed.unwatch(previousTarget);
        poller.unwatch(previousTarget);
        await feed.watch(next.target_wallet);
        poller.watch(next.target_wallet);
        log.info({ previousTarget, nextTarget: next.target_wallet }, "target wallet subscription updated");
      }
    }
    catch (err) { log.error({ err }, "config refresh failed"); }
  }, 3000);

  setInterval(() => {
    log.info({ target: cfg.target_wallet, geyser: feed.health(), rpcFallback: poller.health() }, "stream heartbeat");
  }, 30000);

  // Take-profit / stop-loss watcher — polls prices every 4s for all open positions.
  setInterval(() => { checkTpSl().catch((err) => log.error({ err }, "tp/sl loop failed")); }, 4000);

  async function checkTpSl() {
    if (!cfg?.enabled) return;
    if (!cfg.take_profit_enabled && !cfg.stop_loss_enabled) return;
    const { data: positions } = await db.from("positions")
      .select("id,token_mint,entry_price_usd,amount_tokens,amount_remaining,decimals,tp_taken,mirrored_sold_fraction")
      .eq("user_id", cfg.user_id).is("closed_at", null);
    for (const pos of positions ?? []) {
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
        log.warn({ positionId: pos.id, gainPct: gainPct.toFixed(2) }, "stop-loss triggered — selling all");
        await executeExitSell(pos.id, pos.token_mint, sellRaw, remaining, `stop-loss ${gainPct.toFixed(1)}%`);
        continue;
      }

      if (cfg.take_profit_enabled && !pos.tp_taken && gainPct >= Math.abs(cfg.take_profit_pct)) {
        const sellFraction = Math.min(1, Math.max(0, Number(cfg.take_profit_sell_pct) / 100));
        const sellUi = remaining * sellFraction;
        const decimals = Number(pos.decimals ?? 0);
        const sellRaw = Math.floor(sellUi * Math.pow(10, decimals));
        if (sellRaw <= 0) continue;
        log.info({ positionId: pos.id, gainPct: gainPct.toFixed(2), sellFraction }, "take-profit triggered");
        await executeExitSell(pos.id, pos.token_mint, sellRaw, sellUi, `take-profit ${gainPct.toFixed(1)}%`, true);
      }
    }
  }

  async function executeExitSell(positionId: string, mint: string, sellRaw: number, sellUi: number, reason: string, markTpTaken = false) {
    const secret = await loadSigner(cfg.user_id);
    if (!secret) { log.error("no funding key for tp/sl sell"); return; }
    const result = await executeSwap({
      signerSecret: secret, inputMint: mint, outputMint: WSOL,
      amountLamports: sellRaw, slippageBps: 500,
      route: cfg.execution_route, jitoTipSol: cfg.jito_tip_sol,
    });
    const { data: cur } = await db.from("positions").select("amount_remaining").eq("id", positionId).single();
    const newRemaining = Math.max(0, Number(cur?.amount_remaining ?? 0) - sellUi);
    const closed = newRemaining <= 1e-9;
    const update: any = { amount_remaining: newRemaining, closed_at: closed ? new Date().toISOString() : null };
    if (markTpTaken) update.tp_taken = true;
    await db.from("positions").update(update).eq("id", positionId);
    await db.from("trades").insert({
      user_id: cfg.user_id, position_id: positionId, side: "sell",
      token_mint: mint, amount_tokens: sellUi,
      tx_sig: result.txSig, reason, latency_ms: result.latencyMs, route: result.route,
    });
    log.info({ sig: result.txSig, reason, closed }, "exit sell landed");
    if (closed) await monitor.releasePosition(positionId);
  }


  async function handle(event: FeedEvent) {
    if (!cfg?.enabled) {
      log.info("bot disabled — skipping event");
      return;
    }
    try {
      if (event.kind === "transfer") return handleTransfer(event);
      if (event.kind === "swap") {
        if (event.wallet === cfg.target_wallet && event.side === "buy") {
          await tryCopyBuy(event);
          return;
        }
        if (event.side === "sell") return handleFollowerSell(event);
        log.info({ eventWallet: event.wallet, targetWallet: cfg.target_wallet, side: event.side, mint: event.tokenMint, txSig: event.txSig }, "swap event ignored — not target buy or follower sell");
      }
    } catch (err) { log.error({ err }, "handler failed"); }
  }

  async function handleTransfer(ev: TransferEvent) {
    if (ev.from !== cfg.target_wallet) return;
    const ctx = monitor.activeForMint(ev.tokenMint);
    if (!ctx) {
      // Some Laserstream payloads show the target's immediate post-buy token
      // movement as a transfer, while the actual swap has no positive net
      // target balance left to decode. Since this target's pattern is buy →
      // split to follower wallets, use that outbound transfer as a fallback
      // entry trigger instead of silently missing the trade.
      log.warn({
        from: ev.from,
        to: ev.to,
        mint: ev.tokenMint,
        amountTokens: ev.amountTokens,
        txSig: ev.txSig,
      }, "target transfer with no open position — using as fallback buy trigger");

      const positionId = await tryCopyBuy({
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
      }, "target transfer fallback");

      if (positionId) await monitor.recordTransfer(positionId, ev.to, ev.amountTokens);
      return;
    }
    await monitor.recordTransfer(ctx.positionId, ev.to, ev.amountTokens);
  }

  async function handleFollowerSell(ev: SwapEvent) {
    const ctx = monitor.activeForMint(ev.tokenMint);
    if (!ctx) return;
    if (ev.wallet === cfg.target_wallet) return; // Only follower wallets drive the mirror

    const soldFraction = await monitor.recordFollowerSell(ctx.positionId, ev.wallet, ev.amountTokens);
    if (soldFraction === null) return;

    if (!cfg.proportional_follower_sells) return;

    const { data: pos } = await db.from("positions")
      .select("id,token_mint,amount_tokens,amount_remaining,decimals,mirrored_sold_fraction")
      .eq("id", ctx.positionId).maybeSingle();
    if (!pos) return;

    const targetRemaining = Math.max(0, Number(pos.amount_tokens) * (1 - soldFraction));
    const sellUi = Number(pos.amount_remaining) - targetRemaining;
    if (sellUi <= 0) return;

    const decimals = Number(pos.decimals ?? 0);
    const sellRaw = Math.floor(sellUi * Math.pow(10, decimals));
    if (sellRaw <= 0) return;

    log.info({ positionId: pos.id, soldFraction, sellUi, sellRaw }, "mirroring follower sell");
    await executeMirrorSell(pos.id, pos.token_mint, sellRaw, sellUi, soldFraction, ctx);
  }

  async function executeMirrorSell(positionId: string, mint: string, sellRaw: number, sellUi: number, soldFraction: number, ctx: { positionId: string; tokenMint: string; targetWallet: string }) {
    const secret = await loadSigner(cfg.user_id);
    if (!secret) { log.error("no funding key for sell"); return; }

    const result = await executeSwap({
      signerSecret: secret,
      inputMint: mint,
      outputMint: WSOL,
      amountLamports: sellRaw,
      slippageBps: 500,
      route: cfg.execution_route,
      jitoTipSol: cfg.jito_tip_sol,
    });

    const { data: currentPosition, error: currentPositionError } = await db.from("positions").select("amount_remaining").eq("id", positionId).single();
    if (currentPositionError || !currentPosition) {
      log.error({ err: currentPositionError, positionId }, "could not load position after mirror sell");
      return;
    }
    const newRemaining = Math.max(0, Number(currentPosition.amount_remaining) - sellUi);
    const closed = newRemaining <= 1e-9;
    await db.from("positions").update({
      amount_remaining: newRemaining,
      mirrored_sold_fraction: soldFraction,
      closed_at: closed ? new Date().toISOString() : null,
    }).eq("id", positionId);

    await db.from("trades").insert({
      user_id: cfg.user_id, position_id: positionId, side: "sell",
      token_mint: mint, amount_tokens: sellUi,
      tx_sig: result.txSig, reason: `mirror ${Math.round(soldFraction * 100)}% followers`,
      latency_ms: result.latencyMs, route: result.route,
    });

    log.info({ sig: result.txSig, ms: result.latencyMs, closed }, "mirror sell landed");
    if (closed) await monitor.releasePosition(positionId);
  }

  async function tryCopyBuy(event: SwapEvent, reason = "target copy buy"): Promise<string | null> {
    if (!cfg.enabled) return null;
    if (event.tokenMint === WSOL || STABLECOIN_MINTS.has(event.tokenMint)) {
      log.info({ mint: event.tokenMint, txSig: event.txSig }, "target buy skipped — output is SOL/stablecoin, not a token entry");
      return null;
    }
    const targetWallet = cfg.target_wallet;
    if (!targetWallet) {
      log.warn("target buy skipped because config target wallet is empty");
      return null;
    }
    log.info({
      target: event.wallet,
      mint: event.tokenMint,
      tokenAmount: event.amountTokens,
      solDelta: event.solDelta,
      txSig: event.txSig,
      reason,
    }, "target buy candidate");
    const meta = await loadTokenMeta(event.tokenMint);
    const { data: prior } = await db.from("traded_tokens")
      .select("token_mint").eq("user_id", cfg.user_id).eq("token_mint", event.tokenMint).maybeSingle();
    // Best-effort USD size of the target's buy using the wallet's WSOL/SOL delta in this tx.
    const solPrice = (await priceUsd(WSOL)) ?? 150;
    const targetBuyUsd = event.amountUsd ?? (Math.abs(event.solDelta) > 0.0005 ? Math.abs(event.solDelta) * solPrice : undefined);
    event.amountUsd = targetBuyUsd;
    // First-buy tracking: "first buy of this mint by this target since the bot started monitoring".
    const { data: targetPrior } = await db.from("target_traded_tokens")
      .select("token_mint").eq("target_wallet", targetWallet).eq("token_mint", event.tokenMint).maybeSingle();
    const firstBuy = !targetPrior;
    if (firstBuy) {
      const { error: firstSeenError } = await db.from("target_traded_tokens")
        .upsert({ target_wallet: targetWallet, token_mint: event.tokenMint });
      if (firstSeenError) {
        log.error({ err: firstSeenError, targetWallet, mint: event.tokenMint }, "could not record target's first observed buy");
      }
    }
    const decision = checkEntry(cfg, event, meta, { first: firstBuy, already: !!prior });
    if (!decision.pass) {
      log.info({
        reason: decision.reason,
        mint: event.tokenMint,
        targetBuyUsd: targetBuyUsd === undefined ? "unknown" : targetBuyUsd.toFixed(2),
        meta,
        cfg: {
          minTargetBuyUsd: cfg.min_target_buy_usd,
          mcMinUsd: cfg.mc_min_usd,
          mcMaxUsd: cfg.mc_max_usd,
          liqMinUsd: cfg.liq_min_usd,
          liqMaxUsd: cfg.liq_max_usd,
          tokenAgeFilterEnabled: cfg.token_age_filter_enabled,
          tokenAgeMinMinutes: cfg.token_age_min_minutes,
          tokenAgeMaxMinutes: cfg.token_age_max_minutes,
          pumpFunOnly: cfg.pump_fun_only,
          requireSocials: cfg.require_socials,
          onlyFirstBuyEver: cfg.only_first_buy_ever,
          onlyOncePerToken: cfg.only_once_per_token,
        },
      }, "filtered");
      return null;
    }

    let secret: string | null = null;
    try {
      secret = await loadSigner(cfg.user_id);
    } catch (err) {
      log.error({ err, user_id: cfg.user_id }, "funding key decrypt failed for copy buy");
      return null;
    }
    if (!secret) { log.error({ user_id: cfg.user_id }, "no funding key saved for this config user"); return null; }

    const amountLamports = Math.floor((cfg.fixed_buy_usd / solPrice) * 1e9);
    log.info({
      mint: event.tokenMint,
      fixedBuyUsd: cfg.fixed_buy_usd,
      solPrice,
      amountLamports,
      route: cfg.execution_route,
    }, "submitting copy buy");

    let result;
    try {
      result = await executeSwap({
        signerSecret: secret, inputMint: WSOL, outputMint: event.tokenMint,
        amountLamports, slippageBps: 300, route: cfg.execution_route, jitoTipSol: cfg.jito_tip_sol,
        outputDecimals: event.decimals,
      });
    } catch (err) {
      log.error({ err, mint: event.tokenMint, amountLamports, route: cfg.execution_route }, "copy buy failed before transaction landed");
      return null;
    }

    // Best-effort actual-received amount: worker doesn't have the confirmed
    // balance yet, so we estimate from Jupiter's quote embedded in swap route.
    const receivedUi = result.outUiAmount ?? 0;

    const entryPrice = (await priceUsd(event.tokenMint)) ?? (receivedUi > 0 ? cfg.fixed_buy_usd / receivedUi : 0);

    const { data: pos } = await db.from("positions").insert({
      user_id: cfg.user_id, token_mint: event.tokenMint,
      entry_price_usd: entryPrice,
      amount_tokens: receivedUi,
      amount_remaining: receivedUi,
      decimals: event.decimals,
      mirrored_sold_fraction: 0,
      tp_taken: false,
      entry_tx_sig: result.txSig, entry_slot: event.slot,
    }).select("id").single();

    await db.from("trades").insert({
      user_id: cfg.user_id, position_id: pos?.id, side: "buy",
      token_mint: event.tokenMint, amount_tokens: receivedUi, amount_usd: cfg.fixed_buy_usd,
      tx_sig: result.txSig, reason, latency_ms: result.latencyMs, route: result.route,
    });
    await db.from("traded_tokens").upsert({ user_id: cfg.user_id, token_mint: event.tokenMint });

    if (pos) await monitor.onCopyBuy({ positionId: pos.id, tokenMint: event.tokenMint, targetWallet });
    log.info({
      sig: result.txSig,
      ms: result.latencyMs,
      targetBuyUsd: targetBuyUsd === undefined ? "unknown" : targetBuyUsd.toFixed(2),
    }, "copy buy landed — follower monitor armed");
    return pos?.id ?? null;
  }
}

process.on("unhandledRejection", (err) => log.error({ err }, "unhandled rejection"));
process.on("uncaughtException", (err) => log.error({ err }, "uncaught exception"));

main().catch((e) => { log.error(e, "worker crashed before startup completed"); process.exit(1); });
