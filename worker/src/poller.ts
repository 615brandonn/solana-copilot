import { Connection, PublicKey } from "@solana/web3.js";
import pino from "pino";
import { env } from "./env.js";
import type { FeedEvent } from "./geyser.js";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const log = pino({ level: env.LOG_LEVEL });

export type PollerHandler = (event: FeedEvent) => Promise<void> | void;

export class RpcBackfillPoller {
  private watched = new Set<string>();
  private seen = new Set<string>();
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

function decodeParsedTransaction(wallet: string, tx: any): FeedEvent[] {
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

  const rows = ownerMintRows(meta, wallet);
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

  for (const row of rows) {
    const delta = row.post - row.pre;
    if (Math.abs(delta) < 1e-12) continue;

    if (hasSolMove || hasSwapSignal) {
      const side: "buy" | "sell" = delta > 0 ? "buy" : "sell";
      if (hasSolMove && ((side === "buy" && nativeSolDelta > 0) || (side === "sell" && nativeSolDelta < 0))) continue;
      out.push({
        kind: "swap",
        wallet,
        side,
        tokenMint: row.mint,
        amountTokens: Math.abs(delta),
        decimals: row.decimals,
        amountUsd: undefined,
        solDelta: nativeSolDelta,
        slot,
        txSig: signature,
        timestampMs: Date.now(),
        isPumpFun: row.mint.endsWith("pump"),
      });
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

  return out;
}

function ownerMintRows(meta: any, owner: string) {
  const rows = new Map<string, { mint: string; pre: number; post: number; decimals: number }>();
  const ingest = (balances: any[], field: "pre" | "post") => {
    for (const balance of balances ?? []) {
      if (balance?.owner !== owner || balance?.mint === WSOL_MINT) continue;
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