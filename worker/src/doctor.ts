import "dotenv/config";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { env } from "./env.js";
import { db, type BotConfigRow } from "./db.js";
import { decryptPrivateKey } from "./crypto.js";
import { decodeParsedTransaction } from "./poller.js";

const WSOL = "So11111111111111111111111111111111111111112";
const rpc = new Connection(env.RPC_URL, { commitment: "confirmed" });

function line(label: string, value: unknown) {
  console.log(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

function fail(label: string, value: unknown) {
  console.log(`❌ ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

function pass(label: string, value: unknown) {
  console.log(`✅ ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

async function loadConfig(): Promise<BotConfigRow | null> {
  const byUser = await db.from("bot_config").select("*").eq("user_id", env.HELIX_USER_ID).maybeSingle();
  if (byUser.error) throw new Error(`bot_config query failed: ${byUser.error.message}`);
  if (byUser.data) return byUser.data as BotConfigRow;

  const any = await db.from("bot_config").select("*")
    .not("target_wallet", "is", null).neq("target_wallet", "")
    .order("updated_at", { ascending: false }).limit(1);
  if (any.error) throw new Error(`bot_config fallback query failed: ${any.error.message}`);
  return (any.data?.[0] as BotConfigRow | undefined) ?? null;
}

async function loadFundingKey(userId: string) {
  const { data, error } = await db.from("funding_keys").select("ciphertext").eq("user_id", userId).maybeSingle();
  if (error) throw new Error(`funding_keys query failed: ${error.message}`);
  if (!data) return null;
  return decryptPrivateKey(data.ciphertext);
}

function validatePubkey(label: string, value: string | null | undefined): PublicKey | null {
  if (!value) {
    fail(label, "missing");
    return null;
  }
  try {
    const key = new PublicKey(value);
    pass(label, key.toBase58());
    return key;
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err));
    return null;
  }
}

function amountFromTokenBalance(balance: any) {
  return Number(balance?.uiTokenAmount?.uiAmountString ?? balance?.uiTokenAmount?.uiAmount ?? 0);
}

function analyzeTargetTx(tx: any, target: string) {
  const meta = tx?.meta;
  const accountKeys = (tx?.transaction?.message?.accountKeys ?? []).map((k: any) => k?.pubkey?.toBase58?.() ?? String(k?.pubkey ?? k));
  const targetIndex = accountKeys.indexOf(target);
  const preLamports = targetIndex >= 0 ? Number(meta?.preBalances?.[targetIndex] ?? 0) : 0;
  const postLamports = targetIndex >= 0 ? Number(meta?.postBalances?.[targetIndex] ?? 0) : 0;
  const nativeSolDelta = (postLamports - preLamports) / 1e9;
  const logs = (meta?.logMessages ?? []).map((v: unknown) => String(v).toLowerCase());
  const swapSignal = logs.some((v: string) =>
    v.includes("instruction: buy") ||
    v.includes("instruction: sell") ||
    v.includes("instruction: swap") ||
    v.includes("instruction: route") ||
    v.includes("sharedaccountsroute") ||
    v.includes("exactoutroute")
  );

  const rows = new Map<string, { mint: string; pre: number; post: number; decimals: number }>();
  const ingest = (balances: any[], field: "pre" | "post") => {
    for (const b of balances ?? []) {
      if (b?.owner !== target || b?.mint === WSOL) continue;
      const row = rows.get(b.mint) ?? { mint: b.mint, pre: 0, post: 0, decimals: Number(b?.uiTokenAmount?.decimals ?? 0) };
      row[field] += amountFromTokenBalance(b);
      rows.set(b.mint, row);
    }
  };
  ingest(meta?.preTokenBalances ?? [], "pre");
  ingest(meta?.postTokenBalances ?? [], "post");

  const deltas = Array.from(rows.values()).map((row) => ({
    mint: row.mint,
    delta: Number((row.post - row.pre).toFixed(12)),
    decimals: row.decimals,
  })).filter((row) => Math.abs(row.delta) > 1e-12);

  const decodedEvents = decodeParsedTransaction(target, tx);
  const decodedTargetBuys = decodedEvents.filter((event) => event.kind === "swap" && event.wallet === target && event.side === "buy");
  const decodedTargetTransfers = decodedEvents.filter((event) => event.kind === "transfer" && event.from === target);
  const wouldTriggerBuy = deltas.some((row) => row.delta > 0) && (nativeSolDelta < -0.0005 || swapSignal);
  const wouldTriggerFallbackTransfer = deltas.some((row) => row.delta < 0) && !(Math.abs(nativeSolDelta) > 0.0005 || swapSignal);
  const inferredBuy = inferBuyTransferredOut(meta, target, nativeSolDelta, swapSignal, deltas);

  return {
    signature: tx?.transaction?.signatures?.[0],
    nativeSolDelta,
    swapSignal,
    targetTokenDeltas: deltas,
    liveDecoderEvents: decodedEvents,
    inferredSameTxBuy: inferredBuy,
    wouldTriggerBuy,
    wouldTriggerInferredBuy: !!inferredBuy,
    wouldTriggerFallbackTransfer,
    liveWorkerWouldCopyBuy: decodedTargetBuys.length > 0 || decodedTargetTransfers.length > 0,
  };
}

function inferBuyTransferredOut(meta: any, target: string, solDelta: number, swapSignal: boolean, targetDeltas: Array<{ mint: string; delta: number; decimals: number }>) {
  const likelySpentValue = solDelta < -0.0005 || (Math.abs(solDelta) <= 0.0005 && swapSignal);
  if (!likelySpentValue) return null;

  const alreadyPositive = new Set(targetDeltas.filter((row) => row.delta > 0).map((row) => row.mint));
  const targetNegative = new Set(targetDeltas.filter((row) => row.delta < 0).map((row) => row.mint));
  const preByOwnerMint = new Map<string, number>();
  for (const balance of meta?.preTokenBalances ?? []) {
    if (!balance?.owner || !balance?.mint || balance.owner === target || balance.mint === WSOL) continue;
    preByOwnerMint.set(`${balance.owner}::${balance.mint}`, amountFromTokenBalance(balance));
  }

  const byMint = new Map<string, { mint: string; amountTokens: number; decimals: number; recipients: Array<{ wallet: string; amountTokens: number }> }>();
  for (const balance of meta?.postTokenBalances ?? []) {
    if (!balance?.owner || !balance?.mint || balance.owner === target || balance.mint === WSOL) continue;
    if (alreadyPositive.has(balance.mint) || targetNegative.has(balance.mint)) continue;
    const pre = preByOwnerMint.get(`${balance.owner}::${balance.mint}`) ?? 0;
    const post = amountFromTokenBalance(balance);
    const delta = post - pre;
    if (delta <= 1e-12) continue;
    const cur = byMint.get(balance.mint) ?? {
      mint: balance.mint,
      amountTokens: 0,
      decimals: Number(balance?.uiTokenAmount?.decimals ?? 0),
      recipients: [],
    };
    cur.amountTokens += delta;
    cur.decimals = Number(balance?.uiTokenAmount?.decimals ?? cur.decimals);
    cur.recipients.push({ wallet: balance.owner, amountTokens: delta });
    byMint.set(balance.mint, cur);
  }

  return Array.from(byMint.values()).sort((a, b) => b.amountTokens - a.amountTokens)[0] ?? null;
}

async function main() {
  console.log("\nHelix Doctor — copy-trading pipeline check\n");
  line("HELIX_USER_ID", env.HELIX_USER_ID);
  line("RPC_URL host", new URL(env.RPC_URL).host);
  line("YELLOWSTONE_GRPC_URL host", new URL(env.YELLOWSTONE_GRPC_URL).host);
  line("YELLOWSTONE_TOKEN set", env.YELLOWSTONE_TOKEN ? "yes" : "no");

  const cfg = await loadConfig();
  if (!cfg) {
    fail("Config", "no bot_config row found in Supabase");
    return;
  }

  pass("Config row", { user_id: cfg.user_id, target_wallet: cfg.target_wallet, enabled: cfg.enabled });
  if (!cfg.enabled) fail("Bot armed switch", "OFF — turn BOT ARMED on in the dashboard");
  else pass("Bot armed switch", "ON");

  line("Buy/filter settings", {
    fixed_buy_usd: cfg.fixed_buy_usd,
    min_target_buy_usd: cfg.min_target_buy_usd,
    mc_min_usd: cfg.mc_min_usd,
    mc_max_usd: cfg.mc_max_usd,
    liq_min_usd: cfg.liq_min_usd,
    liq_max_usd: cfg.liq_max_usd,
    pump_fun_only: cfg.pump_fun_only,
    require_socials: cfg.require_socials,
    only_first_buy_ever: cfg.only_first_buy_ever,
    only_once_per_token: cfg.only_once_per_token,
    execution_route: cfg.execution_route,
  });

  const target = validatePubkey("Target wallet", cfg.target_wallet);
  if (!target) return;

  let secret: string | null = null;
  let fundingKeyErrored = false;
  try {
    secret = await loadFundingKey(cfg.user_id);
  } catch (err) {
    fundingKeyErrored = true;
    fail("Funding key", err instanceof Error ? err.message : String(err));
    fail("Next step", "On the VPS run: bun run save-key — paste the Phantom private key there, then run bun run doctor again");
  }
  if (!secret) {
    if (!fundingKeyErrored) {
      fail("Funding key", `missing for config user_id ${cfg.user_id}`);
      fail("Next step", "On the VPS run: bun run save-key — paste the Phantom private key there, then run bun run doctor again");
    }
  } else {
    try {
      const decoded = bs58.decode(secret.trim());
      if (decoded.length !== 64) fail("Funding key", `decoded to ${decoded.length} bytes, expected 64`);
      else {
        const signer = Keypair.fromSecretKey(decoded);
        const sol = await rpc.getBalance(signer.publicKey, "confirmed") / 1e9;
        pass("Funding key", { wallet: signer.publicKey.toBase58(), solBalance: sol });
        if (sol < 0.02) fail("Funding wallet balance", "very low SOL balance; buys may fail");
      }
    } catch (err) {
      fail("Funding key decrypt/parse", err instanceof Error ? err.message : String(err));
    }
  }

  try {
    const version = await rpc.getVersion();
    pass("RPC connection", version);
  } catch (err) {
    fail("RPC connection", err instanceof Error ? err.message : String(err));
    return;
  }

  const targetSol = await rpc.getBalance(target, "confirmed") / 1e9;
  pass("Target wallet RPC lookup", { solBalance: targetSol });

  const signatures = await rpc.getSignaturesForAddress(target, { limit: 10 }, "confirmed");
  if (signatures.length === 0) {
    fail("Recent target activity", "RPC sees no recent transactions for this target wallet");
    return;
  }

  pass("Recent target activity", signatures.map((sig) => ({
    signature: sig.signature,
    time: sig.blockTime ? new Date(sig.blockTime * 1000).toISOString() : null,
    err: sig.err,
  })));

  const txs = await rpc.getParsedTransactions(signatures.slice(0, 5).map((sig) => sig.signature), {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const analyses = txs.filter(Boolean).map((tx) => analyzeTargetTx(tx, target.toBase58()));
  line("Last 5 tx decoder check", analyses);

  const trigger = analyses.find((row) => row.liveWorkerWouldCopyBuy || row.wouldTriggerBuy || row.wouldTriggerInferredBuy || row.wouldTriggerFallbackTransfer);
  if (trigger) pass("Decoder verdict", "At least one recent tx should trigger the live worker path. If PM2 logs did not show feed event, Laserstream/RPC polling is the likely break.");
  else fail("Decoder verdict", "Recent target txs do not look like target buys/transfers to this decoder. The target may be buying from another wallet/signing account, or the tx format needs a new parser.");

  console.log("\nNext command if this passes but bot is silent:\npm2 logs helix-worker --lines 200 --nostream | grep -E \"stream heartbeat|feed event|target buy candidate|filtered|submitting copy buy|copy buy|Pump.fun|funding wallet\"\n");
}

main().catch((err) => {
  fail("Doctor crashed", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});