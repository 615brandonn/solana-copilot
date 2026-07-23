// Helix worker entrypoint. Long-running Node process. Deploy on a
// low-latency VPS geographically close to Jito block engine + your RPC.
//
// Architecture:
//   Geyser gRPC feed → dispatcher → { copy-buy | follower-sell }
//                                       ↓             ↓
//                                    executor      executor
//                                       ↓             ↓
//                                    supabase log  supabase log
//
// The dashboard (Cloudflare Pages) writes settings to Supabase; the worker
// polls bot_config on a short interval (or listens to Realtime).

import pino from "pino";
import { env } from "./env.js";
import { db, type BotConfigRow } from "./db.js";
import { GeyserFeed, type SwapEvent } from "./geyser.js";
import { FollowerMonitor } from "./monitor.js";
import { executeSwap } from "./executor.js";
import { decryptPrivateKey } from "./crypto.js";
import { checkEntry, loadTokenMeta } from "./filters.js";

const log = pino({ level: env.LOG_LEVEL });

async function loadConfig(userId: string): Promise<BotConfigRow | null> {
  const byUser = await db.from("bot_config").select("*").eq("user_id", userId).maybeSingle();
  if (byUser.error) log.error({ err: byUser.error }, "bot_config query error (by user_id)");
  if (byUser.data?.target_wallet) return byUser.data as BotConfigRow;

  // Single-user deploy safety: if HELIX_USER_ID is wrong, or an older blank row
  // exists, prefer the newest row that actually has a target wallet configured.
  const any = await db
    .from("bot_config")
    .select("*")
    .not("target_wallet", "is", null)
    .neq("target_wallet", "")
    .order("updated_at", { ascending: false })
    .limit(1);
  if (any.error) log.error({ err: any.error }, "bot_config query error (fallback)");
  const row = any.data?.[0];
  if (row) log.info({ found_user_id: row.user_id, target: row.target_wallet }, "using fallback bot_config row");
  return (row as BotConfigRow) ?? null;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    if (cfg?.target_wallet) {
      log.info({ user_id: cfg.user_id, target: cfg.target_wallet }, "config loaded");
      return cfg;
    }
    if (!logged) {
      log.warn({ userId }, "no target wallet configured yet — polling every 5s");
      logged = true;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function main() {
  const USER_ID = env.HELIX_USER_ID;
  let cfg = await waitForConfig(USER_ID);
  const ACTIVE_USER_ID = cfg.user_id;

  const feed = new GeyserFeed(async (event) => handle(event));
  const monitor = new FollowerMonitor(feed);
  while (true) {
    try {
      await feed.start([cfg.target_wallet!]);
      break;
    } catch (err) {
      log.error({ err }, "geyser start failed — retrying in 2s");
      await delay(2000);
    }
  }

  // Poll config every 3s — cheap and simple. Swap for Supabase Realtime later.
  setInterval(async () => {
    try {
      const next = await loadConfig(ACTIVE_USER_ID);
      if (next?.target_wallet) cfg = next;
    } catch (err) {
      log.error({ err }, "config refresh failed — keeping last good config");
    }
  }, 3000);

  async function handle(event: SwapEvent) {
    if (!cfg) return;
    const isTarget = event.wallet === cfg.target_wallet;

    if (isTarget && event.side === "buy") {
      await tryCopyBuy(event);
      return;
    }

    // Otherwise this is a follower swap (target's transfer recipients).
    const { data: pos } = await db.from("positions")
      .select("id,token_mint,amount_remaining")
      .eq("user_id", cfg.user_id).eq("token_mint", event.tokenMint).is("closed_at", null).maybeSingle();
    if (!pos) return;

    if (cfg.proportional_follower_sells && event.side === "sell") {
      const agg = await monitor.onFollowerSwap(event, pos.id);
      if (!agg) return;
      // Mirror: bring our remaining down to (1 - soldFraction) of entry amount.
      // Compute delta and issue a sell for exactly that much.
      // (Concrete sizing left as a follow-up — depends on entry_amount_tokens.)
      log.info({ soldFraction: agg.soldFraction }, "would mirror follower exit");
    }
  }

  async function tryCopyBuy(event: SwapEvent) {
    if (!cfg) return;
    const meta = await loadTokenMeta(event.tokenMint);
    const { data: prior } = await db.from("traded_tokens")
      .select("token_mint").eq("user_id", cfg.user_id).eq("token_mint", event.tokenMint).maybeSingle();
    const firstBuy = true; // TODO: check target's on-chain buy history for this mint
    const decision = checkEntry(cfg, event, meta, { first: firstBuy, already: !!prior });
    if (!decision.pass) { log.info({ reason: decision.reason }, "filtered"); return; }

    const secret = await loadSigner(cfg.user_id);
    if (!secret) { log.error("no funding key"); return; }

    const solPrice = (await priceUsd("So11111111111111111111111111111111111111112")) ?? 150;
    const amountLamports = Math.floor((cfg.fixed_buy_usd / solPrice) * 1e9);

    const result = await executeSwap({
      signerSecret: secret,
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: event.tokenMint,
      amountLamports,
      slippageBps: 300,
      route: cfg.execution_route,
      jitoTipSol: cfg.jito_tip_sol,
    });

    const { data: pos } = await db.from("positions").insert({
      user_id: cfg.user_id,
      token_mint: event.tokenMint,
      entry_price_usd: 0,
      amount_tokens: 0,
      amount_remaining: 0,
      entry_tx_sig: result.txSig,
      entry_slot: event.slot,
    }).select("id").single();

    await db.from("trades").insert({
      user_id: cfg.user_id, position_id: pos?.id, side: "buy",
      token_mint: event.tokenMint, amount_tokens: 0, amount_usd: cfg.fixed_buy_usd,
      tx_sig: result.txSig, reason: "target copy buy", latency_ms: result.latencyMs, route: result.route,
    });
    await db.from("traded_tokens").upsert({ user_id: cfg.user_id, token_mint: event.tokenMint });

    if (pos) await monitor.onCopyBuy(pos.id, event.tokenMint, cfg.target_wallet!);
    log.info({ sig: result.txSig, ms: result.latencyMs }, "copy buy landed");
  }
}

process.on("unhandledRejection", (err) => log.error({ err }, "unhandled rejection"));
process.on("uncaughtException", (err) => log.error({ err }, "uncaught exception"));

main().catch((e) => { log.error(e, "worker crashed before startup completed"); process.exit(1); });
