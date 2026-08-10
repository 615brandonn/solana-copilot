import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import pino from "pino";
import { env } from "./env.js";
import type { FeedEvent } from "./geyser.js";
import {
  attributeVerifiedBuy,
  conservativeNativeSolSpend,
  hasWalletSpecificSpend,
  isOnCurveWallet,
  parseRawTokenAmount,
  tokenDelta,
  WSOL_MINT,
  type WalletTokenDelta,
} from "./swap-attribution.js";
import { hasVerifiedSwapSignal } from "./swap-signal.js";

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
  if (!meta || meta.err !== null && meta.err !== undefined) return out;

  const signature = String(tx?.transaction?.signatures?.[0] ?? "");
  const slot = Number(tx?.slot ?? 0);
  const message = tx?.transaction?.message;
  const accountKeyEntries = message?.accountKeys ?? [];
  const accountKeys = accountKeyEntries.map((key: any) => key?.pubkey?.toBase58?.() ?? String(key?.pubkey ?? key));
  const signerKeys = new Set<string>(
    accountKeyEntries
      .filter((key: any) => key?.signer === true)
      .map((key: any) => key?.pubkey?.toBase58?.() ?? String(key?.pubkey ?? key)),
  );
  if (signerKeys.size === 0) {
    const requiredSignatures = Number(message?.header?.numRequiredSignatures ?? 0);
    if (Number.isFinite(requiredSignatures) && requiredSignatures > 0) {
      accountKeys.slice(0, requiredSignatures).forEach((key: string) => signerKeys.add(key));
    }
  }
  const targetIndex = accountKeys.indexOf(wallet);
  const preLamports = targetIndex >= 0 ? Number(meta?.preBalances?.[targetIndex] ?? 0) : 0;
  const postLamports = targetIndex >= 0 ? Number(meta?.postBalances?.[targetIndex] ?? 0) : 0;
  const nativeSolDelta = (postLamports - preLamports) / 1e9;
  const solSpend = conservativeNativeSolSpend(
    nativeSolDelta,
    Number(meta?.fee ?? 0),
    accountKeys[0] === wallet,
  );

  const allRows = ownerMintRows(meta, wallet, accountKeys);
  const wsolRow = allRows.find((row) => row.mint === WSOL_MINT);
  const wsolDelta = wsolRow ? tokenDelta(wsolRow) : 0;
  const solDelta = nativeSolDelta + wsolDelta;
  const attributionRows = allRows;
  const rows = allRows.filter((row) => row.mint !== WSOL_MINT);
  const hasSwapSignal = hasVerifiedSwapSignal(meta?.logMessages ?? []);
  const hasSolMove = Math.abs(solDelta) > 0.0005;
  const positiveOutputRows = rows.filter((row) => tokenDelta(row) > 1e-12);
  const walletCanAuthorizeSwap = signerKeys.size === 1 && signerKeys.has(wallet);
  const emittedBuyMints = new Set<string>();
  const negativeWalletMints = new Set(
    rows.filter((row) => tokenDelta(row) < -1e-12).map((row) => row.mint),
  );
  const globalOutputMints = new Set(positiveOutputRows.map((row) => row.mint));
  for (const recipientRow of recipientBalanceRows(meta, wallet, accountKeys)) {
    if (
      recipientRow.post - recipientRow.pre > 1e-12 &&
      !negativeWalletMints.has(recipientRow.tokenMint)
    ) {
      globalOutputMints.add(recipientRow.tokenMint);
    }
  }

  for (const row of rows) {
    const delta = row.post - row.pre;
    if (Math.abs(delta) < 1e-12) continue;
    if (walletCanAuthorizeSwap && (hasSolMove || hasSwapSignal)) {
      const side: "buy" | "sell" = delta > 0 ? "buy" : "sell";
      if (side === "buy" && !hasSwapSignal) {
        log.info({ wallet, signature, mint: row.mint }, "positive token delta skipped — no explicit swap instruction");
        continue;
      }
      if (hasSolMove && !hasSwapSignal && ((side === "buy" && solDelta > 0) || (side === "sell" && solDelta < 0))) continue;
      const verifiedSpend = side === "buy"
        ? attributeVerifiedBuy(attributionRows, row.mint, globalOutputMints.size, solSpend, hasSwapSignal)
        : undefined;
      if (side === "buy" && !verifiedSpend?.verified) {
        log.info({ wallet, signature, mint: row.mint }, "positive token delta skipped — no unambiguous wallet-specific spend");
        continue;
      }
      out.push({
        kind: "swap",
        wallet,
        side,
        tokenMint: row.mint,
        amountTokens: Math.abs(delta),
        decimals: row.decimals,
        amountUsd: verifiedSpend?.amountUsd,
        spentToken: verifiedSpend?.spentToken,
        solSpend: verifiedSpend?.solSpend,
        solDelta,
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

  const inferredBuy = positiveOutputRows.length === 0
    ? inferBuyTransferredOut(
        meta,
        wallet,
        accountKeys,
        attributionRows,
        solSpend,
        hasSwapSignal,
        walletCanAuthorizeSwap,
        emittedBuyMints,
        negativeWalletMints,
      )
    : null;
  if (inferredBuy) {
    const verifiedSpend = attributeVerifiedBuy(
      attributionRows,
      inferredBuy.tokenMint,
      1,
      solSpend,
      hasSwapSignal,
    );
    if (!verifiedSpend.verified) {
      log.info({ wallet, signature, mint: inferredBuy.tokenMint }, "inferred target buy skipped — input/output attribution is ambiguous");
      return out;
    }
    log.warn({
      wallet,
      signature,
      mint: inferredBuy.tokenMint,
      amountTokens: inferredBuy.amountTokens,
      recipients: inferredBuy.recipients.map((r) => ({ wallet: r.owner, amountTokens: r.amountTokens })),
      nativeSolDelta: solDelta,
      hasSwapSignal,
    }, "rpc fallback inferred target buy from same-tx recipient balances");

    out.push({
      kind: "swap",
      wallet,
      side: "buy",
      tokenMint: inferredBuy.tokenMint,
      amountTokens: inferredBuy.amountTokens,
      decimals: inferredBuy.decimals,
      amountUsd: verifiedSpend.amountUsd,
      spentToken: verifiedSpend.spentToken,
      solSpend: verifiedSpend.solSpend,
      inferredRecipients: inferredBuy.recipients.map((recipient) => recipient.owner),
      solDelta,
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

function ownerMintRows(meta: any, owner: string, accountKeys: string[]): WalletTokenDelta[] {
  const rows = new Map<string, WalletTokenDelta>();
  const ingest = (balances: any[], field: "pre" | "post") => {
    for (const balance of balances ?? []) {
      const resolvedOwner = resolveTokenOwner(balance, balance?.mint, accountKeys, owner);
      if (resolvedOwner !== owner || !balance?.mint) continue;
      const row = rows.get(balance.mint) ?? {
        mint: balance.mint,
        pre: 0,
        post: 0,
        decimals: Number(balance?.uiTokenAmount?.decimals ?? 0),
        preRaw: 0n,
        postRaw: 0n,
        rawExact: true,
      };
      row[field] += Number(balance?.uiTokenAmount?.uiAmountString ?? balance?.uiTokenAmount?.uiAmount ?? 0);
      const raw = parseRawTokenAmount(balance?.uiTokenAmount?.amount);
      if (raw === undefined) row.rawExact = false;
      else if (field === "pre") row.preRaw += raw;
      else row.postRaw += raw;
      row.decimals = Number(balance?.uiTokenAmount?.decimals ?? row.decimals);
      rows.set(balance.mint, row);
    }
  };
  ingest(meta?.preTokenBalances ?? [], "pre");
  ingest(meta?.postTokenBalances ?? [], "post");
  return Array.from(rows.values());
}

type RecipientBalanceRow = {
  owner: string;
  tokenMint: string;
  pre: number;
  post: number;
  decimals: number;
};

function recipientBalanceRows(
  meta: any,
  wallet: string,
  accountKeys: string[],
): RecipientBalanceRow[] {
  const ownerMintRows = new Map<string, { owner: string; tokenMint: string; pre: number; post: number; decimals: number }>();
  const ingestRecipientBalances = (balances: any[], field: "pre" | "post") => {
    for (const balance of balances ?? []) {
      const owner = resolveTokenOwner(balance, balance?.mint, accountKeys, wallet);
      if (!owner || !balance?.mint || balance.mint === WSOL_MINT || owner === wallet || !isOnCurveWallet(owner)) continue;
      const key = `${owner}::${balance.mint}`;
      const row = ownerMintRows.get(key) ?? {
        owner,
        tokenMint: balance.mint,
        pre: 0,
        post: 0,
        decimals: Number(balance?.uiTokenAmount?.decimals ?? 0),
      };
      row[field] += Number(balance?.uiTokenAmount?.uiAmountString ?? balance?.uiTokenAmount?.uiAmount ?? 0);
      row.decimals = Number(balance?.uiTokenAmount?.decimals ?? row.decimals);
      ownerMintRows.set(key, row);
    }
  };
  ingestRecipientBalances(meta?.preTokenBalances ?? [], "pre");
  ingestRecipientBalances(meta?.postTokenBalances ?? [], "post");
  return Array.from(ownerMintRows.values());
}

function inferBuyTransferredOut(
  meta: any,
  wallet: string,
  accountKeys: string[],
  walletRows: WalletTokenDelta[],
  solSpend: number | undefined,
  hasSwapSignal: boolean,
  walletCanAuthorizeSwap: boolean,
  emittedBuyMints: Set<string>,
  negativeWalletMints: Set<string>,
): { tokenMint: string; amountTokens: number; decimals: number; recipients: Array<{ owner: string; amountTokens: number }> } | null {
  if (!walletCanAuthorizeSwap || !hasSwapSignal || !hasWalletSpecificSpend(walletRows, solSpend)) return null;

  const rows = new Map<string, { tokenMint: string; amountTokens: number; decimals: number; recipients: Array<{ owner: string; amountTokens: number }> }>();
  for (const balance of recipientBalanceRows(meta, wallet, accountKeys)) {
    if (emittedBuyMints.has(balance.tokenMint) || negativeWalletMints.has(balance.tokenMint)) continue;
    const delta = balance.post - balance.pre;
    if (delta <= 1e-12) continue;
    const row: {
      tokenMint: string;
      amountTokens: number;
      decimals: number;
      recipients: Array<{ owner: string; amountTokens: number }>;
    } = rows.get(balance.tokenMint) ?? {
      tokenMint: balance.tokenMint,
      amountTokens: 0,
      decimals: balance.decimals,
      recipients: [],
    };
    row.amountTokens += delta;
    row.decimals = balance.decimals;
    row.recipients.push({ owner: balance.owner, amountTokens: delta });
    rows.set(balance.tokenMint, row);
  }

  const candidates = Array.from(rows.values()).sort((a, b) => b.amountTokens - a.amountTokens);
  return candidates.length === 1 ? candidates[0] : null;
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
