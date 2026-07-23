// Helix worker entrypoint. Long-running Node process. Deploy on a
// low-latency VPS geographically close to Jito block engine + your RPC.

import pino from "pino";
import { env } from "./env.js";
import { db, type BotConfigRow } from "./db.js";
import { GeyserFeed, type FeedEvent, type SwapEvent, type TransferEvent } from "./geyser.js";
import { FollowerMonitor } from "./monitor.js";
import { executeSwap } from "./executor.js";
import { decryptPrivateKey } from "./crypto.js";
import { checkEntry, loadTokenMeta } from "./filters.js";

const log = pino({ level: env.LOG_LEVEL });
const WSOL = "So11111111111111111111111111111111111111112";

async function loadConfig(userId: string): Promise<BotConfigRow | null> {
  const byUser = await db.from("bot_config").select("*").eq("user_id", userId).maybeSingle();
  if (byUser.error) log.error({ err: byUser.error }, "bot_config query error (by user_id)");
  if (byUser.data?.target_wallet) return byUser.data as BotConfigRow;
  const any = await db.from("bot_config").select("*")
    .not("target_wallet", "is", null).neq("target_wallet", "")
    .order("updated_at", { ascending: false }).limit(1);
  if (any.error) log.error({ err: any.error }, "bot_config query error (fallback)");
  const row = any.data?.[0];
  if (row) log.info({ found_user_id: row.user_id, target: row.target_wallet }, "using fallback bot_config row");
  return (row as BotConfigRow) ?? null;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loadSigner(userId: string): Promise<string | null> {
  const { data } = await db.from("funding_keys").select("ciphertext").eq("user_id", userId).maybeSingle();
  if (!data) return null;
  return decryptPrivateKey(data.ciphertext);
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

  const feed = new GeyserFeed(async (event) => handle(event));
  const monitor = new FollowerMonitor(feed);

  // Rehydrate any positions still open from a previous worker run so we keep
  // monitoring their followers across restarts.
  const { data: openPositions } = await db.from("positions")
    .select("id,token_mint,amount_remaining").eq("user_id", cfg.user_id).is("closed_at", null);
  for (const pos of openPositions ?? []) {
    if (Number(pos.amount_remaining) <= 0) continue;
    await monitor.onCopyBuy({ positionId: pos.id, tokenMint: pos.token_mint, targetWallet: cfg.target_wallet! });
    const { data: followers } = await db.from("follower_wallets").select("wallet").eq("position_id", pos.id);
    for (const f of followers ?? []) await feed.watch(f.wallet);
  }

  while (true) {
    try { await feed.start([cfg.target_wallet!]); break; }
    catch (err) { log.error({ err }, "geyser start failed — retrying in 2s"); await delay(2000); }
  }

  setInterval(async () => {
    try { const next = await loadConfig(cfg.user_id); if (next?.target_wallet) cfg = next; }
    catch (err) { log.error({ err }, "config refresh failed"); }
  }, 3000);

  async function handle(event: FeedEvent) {
    if (!cfg?.enabled && event.kind === "swap" && event.side === "buy" && event.wallet === cfg?.target_wallet) {
      log.info("bot disabled — skipping copy buy");
      return;
    }
    try {
      if (event.kind === "transfer") return handleTransfer(event);
      if (event.kind === "swap") {
        if (event.wallet === cfg.target_wallet && event.side === "buy") return tryCopyBuy(event);
        if (event.side === "sell") return handleFollowerSell(event);
      }
    } catch (err) { log.error({ err }, "handler failed"); }
  }

  async function handleTransfer(ev: TransferEvent) {
    if (ev.from !== cfg.target_wallet) return;
    const ctx = monitor.activeForMint(ev.tokenMint);
    if (!ctx) return; // Only track transfers for tokens we hold
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

    const newRemaining = Math.max(0, (await db.from("positions").select("amount_remaining").eq("id", positionId).single()).data!.amount_remaining - sellUi);
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

  async function tryCopyBuy(event: SwapEvent) {
    if (!cfg.enabled) return;
    const meta = await loadTokenMeta(event.tokenMint);
    const { data: prior } = await db.from("traded_tokens")
      .select("token_mint").eq("user_id", cfg.user_id).eq("token_mint", event.tokenMint).maybeSingle();
    const firstBuy = true;
    const decision = checkEntry(cfg, event, meta, { first: firstBuy, already: !!prior });
    if (!decision.pass) { log.info({ reason: decision.reason }, "filtered"); return; }

    const secret = await loadSigner(cfg.user_id);
    if (!secret) { log.error("no funding key"); return; }

    const solPrice = (await priceUsd(WSOL)) ?? 150;
    const amountLamports = Math.floor((cfg.fixed_buy_usd / solPrice) * 1e9);

    const result = await executeSwap({
      signerSecret: secret, inputMint: WSOL, outputMint: event.tokenMint,
      amountLamports, slippageBps: 300, route: cfg.execution_route, jitoTipSol: cfg.jito_tip_sol,
    });

    // Best-effort actual-received amount: worker doesn't have the confirmed
    // balance yet, so we estimate from Jupiter's quote embedded in swap route.
    const receivedUi = result.outUiAmount ?? 0;

    const { data: pos } = await db.from("positions").insert({
      user_id: cfg.user_id, token_mint: event.tokenMint,
      entry_price_usd: 0,
      amount_tokens: receivedUi,
      amount_remaining: receivedUi,
      decimals: event.decimals,
      mirrored_sold_fraction: 0,
      entry_tx_sig: result.txSig, entry_slot: event.slot,
    }).select("id").single();

    await db.from("trades").insert({
      user_id: cfg.user_id, position_id: pos?.id, side: "buy",
      token_mint: event.tokenMint, amount_tokens: receivedUi, amount_usd: cfg.fixed_buy_usd,
      tx_sig: result.txSig, reason: "target copy buy", latency_ms: result.latencyMs, route: result.route,
    });
    await db.from("traded_tokens").upsert({ user_id: cfg.user_id, token_mint: event.tokenMint });

    if (pos) await monitor.onCopyBuy({ positionId: pos.id, tokenMint: event.tokenMint, targetWallet: cfg.target_wallet! });
    log.info({ sig: result.txSig, ms: result.latencyMs }, "copy buy landed — follower monitor armed");
  }
}

process.on("unhandledRejection", (err) => log.error({ err }, "unhandled rejection"));
process.on("uncaughtException", (err) => log.error({ err }, "uncaught exception"));

main().catch((e) => { log.error(e, "worker crashed before startup completed"); process.exit(1); });
