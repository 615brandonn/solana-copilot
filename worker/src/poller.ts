import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import pino from "pino";
import { env } from "./env.js";
import type { FeedEvent } from "./geyser.js";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const STABLECOIN_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCo24RDUuUuJZq8bn6T", // USDT
]);
const log = pino({ level: env.LOG_LEVEL });

export type PollerHandler = (event: FeedEvent) => Promise<void> | void;

export class RpcBackfillPoller {
  private watched = new Set<string>();
  private seen = new Set<string>();
  private initialized = new Set<string>();
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastPollAt?: number;

  constructor(private conn: Connection, private onEvent: PollerHandler, private intervalMs = 1200) {}

  start(initialWallets: string[]) {
    initialWallets.forEach((wallet) => this.watch(wallet));
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.poll().catch((err) => log.warn({ err }, "rpc fallback poll failed"));
    }, this.intervalMs);
    this.poll().catch((err) => log.warn({ err }, "rpc fallback initial poll failed"));
    log.info({ watched: Array.from(this.watched), intervalMs: this.intervalMs }, "rpc fallback poller started");
  }

  watch(wallet: string) {
    if (!wallet) return;
    this.watched.add(wallet);
  }

  unwatch(wallet: string) {
    this.watched.delete(wallet);
    this.initialized.delete(wallet);
  }

  health() {
    return {
      watchedCount: this.watched.size,
      lastPollAt: this.lastPollAt,
      secondsSinceLastPoll: this.lastPollAt ? Math.round((Date.now() - this.lastPollAt) / 1000) : null,
      seenCacheSize: this.seen.size,
    };
  }

  private async poll() {
    if (this.running) return;
    this.running = true;
    this.lastPollAt = Date.now();
    try {
      for (const wallet of Array.from(this.watched)) {
        await this.pollWallet(wallet);
      }
    } finally {
      this.running = false;
    }
  }

  private async pollWallet(wallet: string) {
    let pubkey: PublicKey;
    try {
      pubkey = new PublicKey(wallet);
    } catch {
      log.warn({ wallet }, "rpc fallback skipped invalid wallet");
      return;
    }

    const signatures = await this.conn.getSignaturesForAddress(pubkey, { limit: 12 }, "confirmed");
    if (!this.initialized.has(wallet)) {
      signatures.forEach((sig) => this.seen.add(sig.signature));
      this.initialized.add(wallet);
      log.info({ wallet, baselineSignatures: signatures.length }, "rpc fallback wallet baseline ready");
      return;
    }

    const fresh = signatures.filter((sig) => !this.seen.has(sig.signature)).reverse();
    for (const sig of fresh) this.seen.add(sig.signature);
    if (this.seen.size > 2000) this.seen = new Set(Array.from(this.seen).slice(-1000));
    if (fresh.length === 0) return;

    const txs = await this.conn.getParsedTransactions(fresh.map((sig) => sig.signature), {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });

    for (const tx of txs) {
      if (!tx) continue;
      const events = decodeParsedTransaction(wallet, tx as any);
      for (const event of events) {
        log.info({ kind: event.kind, wallet: (event as any).wallet ?? (event as any).from, side: (event as any).side, mint: event.tokenMint }, "rpc fallback feed event");
        await this.onEvent(event);
      }
    }
  }
}

export function decodeParsedTransaction(wallet: string, tx: any): FeedEvent[] {
  const out: FeedEvent[] = [];
  const meta = tx?.meta;
  if (!meta) return out;

  const signature = String(tx?.transaction?.signatures?.[0] ?? "");
  const slot = Number(tx?.slot ?? 0);
  const accountKeys = (tx?.transaction?.message?.accountKeys ?? []).map((key: any) => key?.pubkey?.toBase58?.() ?? String(key?.pubkey ?? key));
  const targetIndex = accountKeys.indexOf(wallet);
  const preLamports = targetIndex >= 0 ? Number(meta?.preBalances?.[targetIndex] ?? 0) : 0;
  const postLamports = targetIndex >= 0 ? Number(meta?.postBalances?.[targetIndex] ?? 0) : 0;
  const nativeSolDelta = (postLamports - preLamports) / 1e9;

  const rows = ownerMintRows(meta, wallet, accountKeys);
  const logMessages = (meta?.logMessages ?? []).map((line: unknown) => String(line).toLowerCase());
  const hasSwapSignal = logMessages.some((line: string) =>
    line.includes("instruction: buy") ||
    line.includes("instruction: sell") ||
    line.includes("instruction: swap") ||
    line.includes("instruction: route") ||
    line.includes("sharedaccountsroute") ||
    line.includes("exactoutroute"),
  );
  const hasSolMove = Math.abs(nativeSolDelta) > 0.0005;
  const stablecoinSpentUsd = usdStablecoinSpent(rows);
  const emittedBuyMints = new Set<string>();
  const negativeWalletMints = new Set<string>();

  for (const row of rows) {
    const delta = row.post - row.pre;
    if (Math.abs(delta) < 1e-12) continue;
    if (delta < 0) negativeWalletMints.add(row.mint);

    if (hasSolMove || hasSwapSignal) {
      const side: "buy" | "sell" = delta > 0 ? "buy" : "sell";
      if (hasSolMove && !hasSwapSignal && ((side === "buy" && nativeSolDelta > 0) || (side === "sell" && nativeSolDelta < 0))) continue;
      out.push({
        kind: "swap",
        wallet,
        side,
        tokenMint: row.mint,
        amountTokens: Math.abs(delta),
        decimals: row.decimals,
        amountUsd: side === "buy" ? stablecoinSpentUsd : undefined,
        solDelta: nativeSolDelta,
        slot,
        txSig: signature,
        timestampMs: Date.now(),
        isPumpFun: row.mint.endsWith("pump"),
      });
      if (side === "buy") emittedBuyMints.add(row.mint);
      continue;
    }

    if (delta < 0) {
      const recipient = findTransferRecipient(meta, row.mint, wallet, Math.abs(delta));
      if (!recipient) continue;
      out.push({
        kind: "transfer",
        from: wallet,
        to: recipient,
        tokenMint: row.mint,
        amountTokens: Math.abs(delta),
        decimals: row.decimals,
        slot,
        txSig: signature,
        timestampMs: Date.now(),
      });
    }
  }

  const inferredBuy = inferBuyTransferredOut(meta, wallet, accountKeys, nativeSolDelta, hasSwapSignal, emittedBuyMints, negativeWalletMints);
  if (inferredBuy) {
    log.warn({
      wallet,
      signature,
      mint: inferredBuy.tokenMint,
      amountTokens: inferredBuy.amountTokens,
      recipients: inferredBuy.recipients.map((r) => ({ wallet: r.owner, amountTokens: r.amountTokens })),
      nativeSolDelta,
      hasSwapSignal,
    }, "rpc fallback inferred target buy from same-tx recipient balances");

    out.push({
      kind: "swap",
      wallet,
      side: "buy",
      tokenMint: inferredBuy.tokenMint,
      amountTokens: inferredBuy.amountTokens,
      decimals: inferredBuy.decimals,
      amountUsd: stablecoinSpentUsd,
      solDelta: nativeSolDelta,
      slot,
      txSig: signature,
      timestampMs: Date.now(),
      isPumpFun: inferredBuy.tokenMint.endsWith("pump"),
    });

    for (const recipient of inferredBuy.recipients) {
      out.push({
        kind: "transfer",
        from: wallet,
        to: recipient.owner,
        tokenMint: inferredBuy.tokenMint,
        amountTokens: recipient.amountTokens,
        decimals: inferredBuy.decimals,
        slot,
        txSig: signature,
        timestampMs: Date.now(),
      });
    }
  }

  return out;
}

function ownerMintRows(meta: any, owner: string, accountKeys: string[]) {
  const rows = new Map<string, { mint: string; pre: number; post: number; decimals: number }>();
  const ingest = (balances: any[], field: "pre" | "post") => {
    for (const balance of balances ?? []) {
      const resolvedOwner = resolveTokenOwner(balance, balance?.mint, accountKeys, owner);
      if (resolvedOwner !== owner || balance?.mint === WSOL_MINT) continue;
      const row = rows.get(balance.mint) ?? { mint: balance.mint, pre: 0, post: 0, decimals: Number(balance?.uiTokenAmount?.decimals ?? 0) };
      row[field] += Number(balance?.uiTokenAmount?.uiAmountString ?? balance?.uiTokenAmount?.uiAmount ?? 0);
      row.decimals = Number(balance?.uiTokenAmount?.decimals ?? row.decimals);
      rows.set(balance.mint, row);
    }
  };
  ingest(meta?.preTokenBalances ?? [], "pre");
  ingest(meta?.postTokenBalances ?? [], "post");
  return Array.from(rows.values());
}

function usdStablecoinSpent(rows: Array<{ mint: string; pre: number; post: number }>): number | undefined {
  const spent = rows
    .filter((row) => STABLECOIN_MINTS.has(row.mint))
    .reduce((sum, row) => {
      const delta = row.post - row.pre;
      return delta < 0 ? sum + Math.abs(delta) : sum;
    }, 0);
  return spent > 0 ? spent : undefined;
}

function inferBuyTransferredOut(
  meta: any,
  wallet: string,
  accountKeys: string[],
  solDelta: number,
  hasSwapSignal: boolean,
  emittedBuyMints: Set<string>,
  negativeWalletMints: Set<string>,
): { tokenMint: string; amountTokens: number; decimals: number; recipients: Array<{ owner: string; amountTokens: number }> } | null {
  const likelySpentValue = solDelta < -0.0005 || hasSwapSignal;
  if (!likelySpentValue) return null;

  const rows = new Map<string, { tokenMint: string; amountTokens: number; decimals: number; recipients: Array<{ owner: string; amountTokens: number }> }>();
  const preByOwnerMint = new Map<string, number>();
  for (const balance of meta?.preTokenBalances ?? []) {
    const owner = resolveTokenOwner(balance, balance?.mint, accountKeys, wallet);
    if (!owner || !balance?.mint || balance.mint === WSOL_MINT || owner === wallet) continue;
    preByOwnerMint.set(`${owner}::${balance.mint}`, Number(balance?.uiTokenAmount?.uiAmountString ?? balance?.uiTokenAmount?.uiAmount ?? 0));
  }

  for (const balance of meta?.postTokenBalances ?? []) {
    const owner = resolveTokenOwner(balance, balance?.mint, accountKeys, wallet);
    if (!owner || !balance?.mint || balance.mint === WSOL_MINT || owner === wallet) continue;
    if (emittedBuyMints.has(balance.mint) || negativeWalletMints.has(balance.mint)) continue;
    const post = Number(balance?.uiTokenAmount?.uiAmountString ?? balance?.uiTokenAmount?.uiAmount ?? 0);
    const pre = preByOwnerMint.get(`${owner}::${balance.mint}`) ?? 0;
    const delta = post - pre;
    if (delta <= 1e-12) continue;
    const row = rows.get(balance.mint) ?? {
      tokenMint: balance.mint,
      amountTokens: 0,
      decimals: Number(balance?.uiTokenAmount?.decimals ?? 0),
      recipients: [],
    };
    row.amountTokens += delta;
    row.decimals = Number(balance?.uiTokenAmount?.decimals ?? row.decimals);
    row.recipients.push({ owner, amountTokens: delta });
    rows.set(balance.mint, row);
  }

  const candidates = Array.from(rows.values()).sort((a, b) => b.amountTokens - a.amountTokens);
  return candidates[0] ?? null;
}

function resolveTokenOwner(balance: any, mint: string | undefined, accountKeys: string[], watchedWallet: string): string {
  if (balance?.owner) return String(balance.owner);
  const accountIndex = Number(balance?.accountIndex);
  const tokenAccount = Number.isFinite(accountIndex) ? accountKeys[accountIndex] : "";
  if (!tokenAccount || !mint) return "";
  try {
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(watchedWallet), true).toBase58();
    if (ata === tokenAccount) return watchedWallet;
  } catch {
    return tokenAccount;
  }
  return tokenAccount;
}

function findTransferRecipient(meta: any, mint: string, sender: string, amount: number): string | null {
  const before = new Map<string, number>();
  for (const balance of meta?.preTokenBalances ?? []) {
    if (balance?.mint !== mint || !balance?.owner || balance.owner === sender) continue;
    before.set(balance.owner, (before.get(balance.owner) ?? 0) + Number(balance?.uiTokenAmount?.uiAmountString ?? balance?.uiTokenAmount?.uiAmount ?? 0));
  }

  for (const balance of meta?.postTokenBalances ?? []) {
    if (balance?.mint !== mint || !balance?.owner || balance.owner === sender) continue;
    const post = Number(balance?.uiTokenAmount?.uiAmountString ?? balance?.uiTokenAmount?.uiAmount ?? 0);
    const delta = post - (before.get(balance.owner) ?? 0);
    if (delta > 0 && Math.abs(delta - amount) / Math.max(amount, 1e-9) < 0.05) return balance.owner;
  }
  return null;
}