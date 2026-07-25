// Yellowstone Geyser gRPC subscription — this is the subsecond hot path.
// We subscribe to transactions that include the target wallet OR any active
// follower wallet, decode swap instructions, and hand each event to the executor.

import { createRequire } from "node:module";
import type { SubscribeRequest } from "@triton-one/yellowstone-grpc";
import bs58 from "bs58";
import pino from "pino";
import { env } from "./env.js";

const log = pino({ level: env.LOG_LEVEL });
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const require = createRequire(import.meta.url);
const YellowstoneGrpc = require("@triton-one/yellowstone-grpc") as Record<string, any>;
const CommitmentLevel = YellowstoneGrpc.CommitmentLevel ?? YellowstoneGrpc.default?.CommitmentLevel ?? { PROCESSED: 0 };

function resolveClientCtor() {
  const candidates = [
    YellowstoneGrpc.Client,
    YellowstoneGrpc.default,
    YellowstoneGrpc.default?.Client,
    YellowstoneGrpc.YellowstoneClient,
    YellowstoneGrpc.default?.default,
  ];
  const ctor = candidates.find((candidate) => typeof candidate === "function");
  if (!ctor) {
    log.error(
      {
        exports: Object.keys(YellowstoneGrpc),
        defaultExports: YellowstoneGrpc.default ? Object.keys(YellowstoneGrpc.default) : [],
      },
      "could not find Yellowstone gRPC Client export",
    );
    throw new Error("Yellowstone gRPC Client export not found");
  }
  return ctor;
}

function createClient() {
  const ClientCtor = resolveClientCtor();
  try {
    return new ClientCtor(env.YELLOWSTONE_GRPC_URL, env.YELLOWSTONE_TOKEN, {
      grpcMaxDecodingMessageSize: 64 * 1024 * 1024,
    });
  } catch (err) {
    if (err instanceof TypeError && /constructor/i.test(err.message)) {
      return ClientCtor(env.YELLOWSTONE_GRPC_URL, env.YELLOWSTONE_TOKEN, {
        grpcMaxDecodingMessageSize: 64 * 1024 * 1024,
      });
    }
    throw err;
  }
}

export type SwapEvent = {
  kind: "swap";
  wallet: string;
  side: "buy" | "sell";
  tokenMint: string;
  amountTokens: number;
  decimals: number;
  amountUsd?: number;
  solDelta: number; // WSOL/SOL change for this wallet in this tx (negative = spent, positive = received)
  slot: number;
  txSig: string;
  timestampMs: number;
  isPumpFun: boolean;
};

export type TransferEvent = {
  kind: "transfer";
  from: string;               // sender (must be a watched wallet)
  to: string;                 // recipient
  tokenMint: string;
  amountTokens: number;
  decimals: number;
  slot: number;
  txSig: string;
  timestampMs: number;
};

export type FeedEvent = SwapEvent | TransferEvent;
export type OnSwap = (e: FeedEvent) => Promise<void> | void;

export class GeyserFeed {
  private client: any;
  private watched = new Set<string>();
  private stream?: any;
  private onSwap: OnSwap;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnecting = false;
  private stopped = false;
  private lastMessageAt?: number;
  private decodedEventCount = 0;

  constructor(onSwap: OnSwap) {
    this.client = createClient();
    this.onSwap = onSwap;
  }

  async start(initialWallets: string[]) {
    initialWallets.forEach((w) => this.watched.add(w));
    this.stopped = false;
    await this.connect();
  }

  async watch(wallet: string) {
    if (this.watched.has(wallet)) return;
    this.watched.add(wallet);
    await this.push();
  }

  async unwatch(wallet: string) {
    if (!this.watched.delete(wallet)) return;
    await this.push();
  }

  health() {
    return {
      watched: Array.from(this.watched),
      watchedCount: this.watched.size,
      lastMessageAt: this.lastMessageAt,
      secondsSinceLastMessage: this.lastMessageAt ? Math.round((Date.now() - this.lastMessageAt) / 1000) : null,
      decodedEventCount: this.decodedEventCount,
      connected: !!this.stream,
    };
  }

  private async push() {
    const stream = this.stream;
    if (!stream) return;
    const req: SubscribeRequest = {
      accounts: {},
      slots: {},
      transactions: {
        copy: {
          vote: false,
          failed: false,
          accountInclude: Array.from(this.watched),
          accountExclude: [],
          accountRequired: [],
        },
      },
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
      commitment: CommitmentLevel.PROCESSED,
    };
    await new Promise<void>((res, rej) => stream.write(req, (err: unknown) => (err ? rej(err) : res())));
  }

  private async connect() {
    if (this.reconnecting || this.stopped) return;
    this.reconnecting = true;
    try {
      this.stream?.removeAllListeners();
      this.stream?.end?.();
      this.stream = await this.client.subscribe();

      this.stream.on("data", (msg: any) => this.handleMessage(msg).catch((e: any) => log.error(e)));
      this.stream.on("error", (e: any) => {
        log.error({ err: e }, "geyser stream error");
        this.scheduleReconnect("stream error");
      });
      this.stream.on("end", () => this.scheduleReconnect("stream ended"));
      this.stream.on("close", () => this.scheduleReconnect("stream closed"));

      await this.push();
      log.info({ n: this.watched.size }, "geyser subscribed");
    } finally {
      this.reconnecting = false;
    }
  }

  private scheduleReconnect(reason: string) {
    if (this.stopped || this.reconnectTimer) return;
    log.warn({ reason }, "geyser reconnect scheduled");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect().catch((err) => {
        log.error({ err }, "geyser reconnect failed");
        this.scheduleReconnect("reconnect failed");
      });
    }, 1000);
  }

  private async handleMessage(msg: any) {
    this.lastMessageAt = Date.now();
    const tx = msg?.transaction?.transaction;
    if (!tx) return;
    const events = this.decodeEvents(msg, tx);
    if (events.length === 0) {
      log.debug({ slot: msg?.transaction?.slot }, "tx seen but no events decoded");
    }
    for (const ev of events) {
      this.decodedEventCount += 1;
      log.info({ kind: ev.kind, wallet: (ev as any).wallet ?? (ev as any).from, side: (ev as any).side, mint: ev.tokenMint }, "feed event");
      await this.onSwap(ev);
    }
  }

  private decodeEvents(msg: any, tx: any): FeedEvent[] {
    const out: FeedEvent[] = [];
    const slot: number = Number(msg.transaction.slot ?? 0);
    const meta = tx.meta ?? tx.transaction?.meta ?? msg.transaction.meta;
    const txSig = this.decodeSignature(tx.signature ?? tx.transaction?.signatures?.[0]);

    // Build per-(owner,mint) delta table across the whole tx.
    const table = this.buildOwnerMintDeltas(meta);
    const logMessages = (meta?.logMessages ?? []).map((line: unknown) => String(line).toLowerCase());
    const hasSwapSignal = logMessages.some((line: string) =>
      line.includes("instruction: buy") ||
      line.includes("instruction: sell") ||
      line.includes("instruction: swap") ||
      line.includes("instruction: route") ||
      line.includes("sharedaccountsroute") ||
      line.includes("exactoutroute"),
    );

    // Native SOL deltas per account key (lamports).
    const message = tx.transaction?.message ?? tx.message;
    const accountKeys = this.decodeAccountKeys([
      ...(message?.accountKeys ?? []),
      ...(meta?.loadedWritableAddresses ?? []),
      ...(meta?.loadedReadonlyAddresses ?? []),
    ]);
    const preBalances: number[] = (meta?.preBalances ?? []).map((n: any) => Number(n));
    const postBalances: number[] = (meta?.postBalances ?? []).map((n: any) => Number(n));
    const nativeSolDelta = (wallet: string): number => {
      const idx = accountKeys.indexOf(wallet);
      if (idx < 0) return 0;
      const pre = preBalances[idx] ?? 0;
      const post = postBalances[idx] ?? 0;
      return (post - pre) / 1e9; // SOL
    };

    for (const wallet of this.watched) {
      const wsolRow = table.find((r) => r.owner === wallet && r.mint === WSOL_MINT);
      const wsolDelta = (wsolRow?.post ?? 0) - (wsolRow?.pre ?? 0);
      const natDelta = nativeSolDelta(wallet);
      const solDelta = wsolDelta + natDelta;
      const hasSolMove = Math.abs(solDelta) > 0.0005; // > 0.0005 SOL rules out fee-only

      const walletRows = table.filter((r) => r.owner === wallet && r.mint !== WSOL_MINT);
      const emittedBuyMints = new Set<string>();
      const negativeWalletMints = new Set<string>();
      if (walletRows.length > 0) {
        log.info({
          wallet,
          txSig,
          solDelta,
          hasSolMove,
          hasSwapSignal,
          tokenDeltas: walletRows.map((r) => ({ mint: r.mint, delta: Number((r.post - r.pre).toFixed(12)), decimals: r.decimals })),
        }, "watched wallet token delta");
      }
      for (const row of walletRows) {
        const delta = row.post - row.pre;
        if (Math.abs(delta) < 1e-12) continue;
        if (delta < 0) negativeWalletMints.add(row.mint);

        if (hasSolMove || hasSwapSignal) {
          // SOL movement is the strongest signal. Some providers omit loaded
          // account keys, so we also accept explicit DEX/pump swap logs.
          const side: "buy" | "sell" = delta > 0 ? "buy" : "sell";
          // When we have a real SOL delta, require signs to match:
          // Buy: token+ and SOL-. Sell: token- and SOL+.
          if (hasSolMove && ((side === "buy" && solDelta > 0) || (side === "sell" && solDelta < 0))) {
            log.info({ wallet, txSig, mint: row.mint, side, solDelta, tokenDelta: delta }, "swap sign mismatch — skipped");
            continue;
          }
          out.push({
            kind: "swap",
            wallet,
            side,
            tokenMint: row.mint,
            amountTokens: Math.abs(delta),
            decimals: row.decimals,
            amountUsd: undefined,
            solDelta,
            slot,
            txSig,
            timestampMs: Date.now(),
            isPumpFun: row.mint.endsWith("pump"),
          });
          if (side === "buy") emittedBuyMints.add(row.mint);
        } else if (delta < 0) {
          // No SOL movement on this wallet: pure token transfer OUT.
          const peers = table.filter((p) => p.mint === row.mint && p.owner !== wallet);
          const peer = peers.find((p) => {
            const pd = p.post - p.pre;
            return pd > 0 && Math.abs(pd + delta) / Math.max(Math.abs(delta), 1e-9) < 0.05;
          });
          if (!peer) continue;
          out.push({
            kind: "transfer",
            from: wallet,
            to: peer.owner,
            tokenMint: row.mint,
            amountTokens: Math.abs(delta),
            decimals: row.decimals,
            slot,
            txSig,
            timestampMs: Date.now(),
          });
        }
      }

      // Many fast target wallets buy and transfer the bought token out inside
      // the same transaction. In that tx the target can have no positive final
      // token delta, so a pure owner-delta decoder misses the buy entirely.
      // If the watched wallet spent SOL or the tx has explicit swap logs, infer
      // the bought mint from positive token deltas on recipient wallets, while
      // excluding mints the watched wallet itself sent out (sell/transfer side).
      const inferredBuy = this.inferBuyTransferredOut(table, wallet, solDelta, hasSwapSignal, emittedBuyMints, negativeWalletMints);
      if (inferredBuy) {
        log.warn({
          wallet,
          txSig,
          mint: inferredBuy.tokenMint,
          amountTokens: inferredBuy.amountTokens,
          recipients: inferredBuy.recipients.map((r) => ({ wallet: r.owner, amountTokens: r.amountTokens })),
          solDelta,
          hasSwapSignal,
        }, "inferred target buy from same-tx recipient balances");

        out.push({
          kind: "swap",
          wallet,
          side: "buy",
          tokenMint: inferredBuy.tokenMint,
          amountTokens: inferredBuy.amountTokens,
          decimals: inferredBuy.decimals,
          amountUsd: undefined,
          solDelta,
          slot,
          txSig,
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
            txSig,
            timestampMs: Date.now(),
          });
        }
      }
    }

    return out;
  }

  private inferBuyTransferredOut(
    table: Array<{ owner: string; mint: string; pre: number; post: number; decimals: number }>,
    wallet: string,
    solDelta: number,
    hasSwapSignal: boolean,
    emittedBuyMints: Set<string>,
    negativeWalletMints: Set<string>,
  ): { tokenMint: string; amountTokens: number; decimals: number; recipients: Array<{ owner: string; amountTokens: number }> } | null {
    const likelySpentValue = solDelta < -0.0005 || hasSwapSignal;
    if (!likelySpentValue) return null;

    const byMint = new Map<string, { tokenMint: string; amountTokens: number; decimals: number; recipients: Array<{ owner: string; amountTokens: number }> }>();
    for (const row of table) {
      if (row.owner === wallet || row.mint === WSOL_MINT) continue;
      if (emittedBuyMints.has(row.mint) || negativeWalletMints.has(row.mint)) continue;
      const delta = row.post - row.pre;
      if (delta <= 1e-12) continue;
      const cur = byMint.get(row.mint) ?? { tokenMint: row.mint, amountTokens: 0, decimals: row.decimals, recipients: [] };
      cur.amountTokens += delta;
      cur.decimals = row.decimals;
      cur.recipients.push({ owner: row.owner, amountTokens: delta });
      byMint.set(row.mint, cur);
    }

    const candidates = Array.from(byMint.values())
      .filter((candidate) => candidate.amountTokens > 0 && candidate.recipients.length > 0)
      .sort((a, b) => b.amountTokens - a.amountTokens);
    return candidates[0] ?? null;
  }

  private toBase58(v: unknown): string {
    if (!v) return "";
    if (typeof v === "string") return v;
    if (v instanceof Uint8Array || Buffer.isBuffer(v)) return bs58.encode(Buffer.from(v as any));
    if (Array.isArray(v)) return bs58.encode(Buffer.from(v as any));
    if (typeof v === "object") {
      const obj = v as Record<string, unknown>;
      if (Array.isArray(obj.data)) return bs58.encode(Buffer.from(obj.data));
      if (obj.type === "Buffer" && Array.isArray(obj.data)) return bs58.encode(Buffer.from(obj.data));
      for (const key of ["pubkey", "publicKey", "key", "value", "bytes"]) {
        const decoded = this.toBase58(obj[key]);
        if (decoded) return decoded;
      }
      if (typeof obj.toBase58 === "function") {
        try { return String(obj.toBase58()); } catch { return ""; }
      }
      if (typeof obj.toString === "function") {
        const s = obj.toString();
        if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return s;
      }
    }
    return "";
  }

  private buildOwnerMintDeltas(meta: any): Array<{ owner: string; mint: string; pre: number; post: number; decimals: number }> {
    const key = (owner: string, mint: string) => `${owner}::${mint}`;
    const m = new Map<string, { owner: string; mint: string; pre: number; post: number; decimals: number }>();
    const ingest = (balances: any[], field: "pre" | "post") => {
      for (const b of balances ?? []) {
        const owner = this.toBase58(b?.owner);
        const mint = this.toBase58(b?.mint);
        if (!owner || !mint) continue;
        const k = key(owner, mint);
        const decimals = Number(b.uiTokenAmount?.decimals ?? 0);
        const row = m.get(k) ?? { owner, mint, pre: 0, post: 0, decimals };
        const amt = Number(b.uiTokenAmount?.uiAmountString ?? b.uiTokenAmount?.uiAmount ?? 0);
        row[field] += amt;
        row.decimals = Number(b.uiTokenAmount?.decimals ?? row.decimals);
        m.set(k, row);
      }
    };
    ingest(meta?.preTokenBalances ?? [], "pre");
    ingest(meta?.postTokenBalances ?? [], "post");
    return Array.from(m.values());
  }

  private decodeAccountKeys(keys: unknown[]): string[] {
    return keys.map((key) => this.toBase58(key)).filter(Boolean);
  }

  private decodeSignature(sig: unknown): string {
    if (!sig) return "";
    if (typeof sig === "string") return sig;
    if (sig instanceof Uint8Array || Buffer.isBuffer(sig)) return bs58.encode(Buffer.from(sig));
    if (Array.isArray(sig)) return bs58.encode(Buffer.from(sig));
    return "";
  }
}

