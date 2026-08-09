import "dotenv/config";
import { Connection, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { env } from "./env.js";
import { db, type BotConfigRow } from "./db.js";
import { decodeParsedTransaction } from "./poller.js";
import { checkEntry, loadTokenMeta } from "./filters.js";
import type { SwapEvent, TransferEvent } from "./geyser.js";
import { priceUsd } from "./prices.js";

const WSOL = "So11111111111111111111111111111111111111112";
const rpc = new Connection(env.RPC_URL, { commitment: "confirmed" });
type TransactionMeta = NonNullable<ParsedTransactionWithMeta["meta"]>;
type TokenBalance = NonNullable<TransactionMeta["preTokenBalances"]>[number];

function print(label: string, value: unknown) {
  console.log(`${label}: ${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);
}

async function loadConfig(): Promise<BotConfigRow | null> {
  const byUser = await db
    .from("bot_config")
    .select("*")
    .eq("user_id", env.HELIX_USER_ID)
    .maybeSingle();
  if (byUser.error) throw new Error(`bot_config query failed: ${byUser.error.message}`);
  if (byUser.data?.target_wallet) return byUser.data as BotConfigRow;

  const any = await db
    .from("bot_config")
    .select("*")
    .not("target_wallet", "is", null)
    .neq("target_wallet", "")
    .order("updated_at", { ascending: false })
    .limit(1);
  if (any.error) throw new Error(`bot_config fallback query failed: ${any.error.message}`);
  const row = any.data?.[0] as BotConfigRow | undefined;
  if (row) {
    throw new Error(
      "HELIX_USER_ID mismatch: worker identity does not match the configured dashboard row",
    );
  }
  return null;
}

function tokenDeltasFor(tx: ParsedTransactionWithMeta, wallet: string) {
  const rows = new Map<
    string,
    { mint: string; pre: number; post: number; owner?: string; decimals: number }
  >();
  const ingest = (balances: readonly TokenBalance[], field: "pre" | "post") => {
    for (const balance of balances ?? []) {
      if (balance?.owner !== wallet || !balance?.mint || balance.mint === WSOL) continue;
      const row = rows.get(balance.mint) ?? {
        mint: balance.mint,
        pre: 0,
        post: 0,
        owner: balance.owner,
        decimals: Number(balance?.uiTokenAmount?.decimals ?? 0),
      };
      row[field] += Number(
        balance?.uiTokenAmount?.uiAmountString ?? balance?.uiTokenAmount?.uiAmount ?? 0,
      );
      row.decimals = Number(balance?.uiTokenAmount?.decimals ?? row.decimals);
      rows.set(balance.mint, row);
    }
  };
  ingest(tx?.meta?.preTokenBalances ?? [], "pre");
  ingest(tx?.meta?.postTokenBalances ?? [], "post");
  return Array.from(rows.values())
    .map((row) => ({
      mint: row.mint,
      delta: Number((row.post - row.pre).toFixed(12)),
      decimals: row.decimals,
    }))
    .filter((row) => Math.abs(row.delta) > 1e-12);
}

async function explainCandidate(cfg: BotConfigRow, event: SwapEvent) {
  const solPrice = await priceUsd(WSOL);
  const targetBuyUsd =
    event.amountUsd ??
    (solPrice !== undefined && Math.abs(event.solDelta) > 0.0005
      ? Math.abs(event.solDelta) * solPrice
      : undefined);
  event.amountUsd = targetBuyUsd;

  const meta = await loadTokenMeta(event.tokenMint);
  const { data: prior } = await db
    .from("traded_tokens")
    .select("token_mint")
    .eq("user_id", cfg.user_id)
    .eq("token_mint", event.tokenMint)
    .maybeSingle();
  const { data: targetPrior } = await db
    .from("target_traded_tokens")
    .select("token_mint")
    .eq("target_wallet", cfg.target_wallet ?? "")
    .eq("token_mint", event.tokenMint)
    .maybeSingle();
  const decision = checkEntry(
    cfg,
    event,
    { ...meta, isPumpFun: meta.isPumpFun || event.isPumpFun },
    {
      first: !targetPrior,
      already: !!prior,
    },
  );

  print("Candidate verdict", {
    tokenMint: event.tokenMint,
    side: event.side,
    targetBuyUsd: targetBuyUsd === undefined ? "unknown" : Number(targetBuyUsd.toFixed(2)),
    wouldPassFilters: decision.pass,
    filterReason: decision.pass ? null : decision.reason,
    tokenMeta: meta,
    fixedBuyUsd: cfg.fixed_buy_usd,
    estimatedSolSpend:
      solPrice === undefined ? "unavailable" : Number((cfg.fixed_buy_usd / solPrice).toFixed(6)),
  });
}

async function main() {
  const signature = process.argv[2]?.trim();
  if (!signature) {
    console.log("Usage: npm --prefix worker run trace -- <target transaction signature>");
    process.exit(1);
  }

  const cfg = await loadConfig();
  if (!cfg?.target_wallet) throw new Error("No target wallet saved in bot_config");
  new PublicKey(cfg.target_wallet);

  console.log("\nHelix trace — single transaction diagnosis\n");
  print("Target wallet", cfg.target_wallet);
  print("Bot armed", cfg.enabled);
  print("Signature", signature);

  const tx = await rpc.getParsedTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx)
    throw new Error("RPC could not load that transaction. Check the signature or RPC provider.");

  const logs = (tx.meta?.logMessages ?? []).map((line) => String(line).toLowerCase());
  const swapSignal = logs.some(
    (line) =>
      line.includes("instruction: buy") ||
      line.includes("instruction: sell") ||
      line.includes("instruction: swap") ||
      line.includes("instruction: route") ||
      line.includes("sharedaccountsroute") ||
      line.includes("exactoutroute"),
  );

  const events = decodeParsedTransaction(cfg.target_wallet, tx);
  print("Raw target token deltas", tokenDeltasFor(tx, cfg.target_wallet));
  print("Swap-like logs found", swapSignal);
  print("Decoded bot events", events);

  const targetBuys = events.filter(
    (event): event is SwapEvent =>
      event.kind === "swap" && event.wallet === cfg.target_wallet && event.side === "buy",
  );
  const targetTransfers = events.filter(
    (event): event is TransferEvent =>
      event.kind === "transfer" && event.from === cfg.target_wallet,
  );

  if (targetBuys.length === 0 && targetTransfers.length === 0) {
    print(
      "Why it did not copy",
      "This transaction did not decode as a target buy or target outbound token transfer. Most likely the address entered is not the actual trading signer/owner for this swap, or this tx format needs another decoder path.",
    );
    return;
  }

  for (const event of targetBuys) await explainCandidate(cfg, event);
  for (const event of targetTransfers) {
    print("Transfer fallback candidate", {
      tokenMint: event.tokenMint,
      recipient: event.to,
      amountTokens: event.amountTokens,
      note: "The live worker treats this as a fallback buy trigger if no position is already open for this mint.",
    });
  }
}

main().catch((err) => {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
