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

  private async push() {
    if (!this.stream) return;
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
    await new Promise<void>((res, rej) => this.stream!.write(req, (err: unknown) => (err ? rej(err) : res())));
  }

  private async connect() {
    if (this.reconnecting || this.stopped) return;
    this.reconnecting = true;
    try {
      this.stream?.removeAllListeners();
      this.stream?.end?.();
      this.stream = await this.client.subscribe();

      this.stream.on("data", (msg) => this.handleMessage(msg).catch((e) => log.error(e)));
      this.stream.on("error", (e) => {
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
    const tx = msg?.transaction?.transaction;
    if (!tx) return;
    const events = this.decodeEvents(msg, tx);
    for (const ev of events) await this.onSwap(ev);
  }

  private decodeEvents(msg: any, tx: any): FeedEvent[] {
    const out: FeedEvent[] = [];
    const slot: number = Number(msg.transaction.slot ?? 0);
    const meta = tx.meta ?? tx.transaction?.meta ?? msg.transaction.meta;
    const txSig = this.decodeSignature(tx.signature ?? tx.transaction?.signatures?.[0]);

    // Build per-(owner,mint) delta table across the whole tx.
    const table = this.buildOwnerMintDeltas(meta);
    // For fast lookup: mint -> [{owner, pre, post, decimals}]
    const byMint = new Map<string, Array<{ owner: string; pre: number; post: number; decimals: number }>>();
    for (const row of table) {
      const list = byMint.get(row.mint) ?? [];
      list.push(row);
      byMint.set(row.mint, list);
    }

    for (const wallet of this.watched) {
      // Consider each mint the wallet is involved in
      const walletRows = table.filter((r) => r.owner === wallet);
      for (const row of walletRows) {
        if (row.mint === WSOL_MINT) continue;
        const delta = row.post - row.pre;
        if (Math.abs(delta) < 1e-12) continue;

        // Is this a transfer? Look for a counterparty on the same mint with opposite-sign delta of ~equal magnitude.
        const peers = (byMint.get(row.mint) ?? []).filter((p) => p.owner !== wallet);
        const transferPeer = peers.find((p) => {
          const pd = p.post - p.pre;
          return Math.sign(pd) === -Math.sign(delta) && Math.abs(pd + delta) / Math.max(Math.abs(delta), 1e-9) < 0.02;
        });

        if (transferPeer && delta < 0) {
          // Target sent tokens to a peer wallet.
          out.push({
            kind: "transfer",
            from: wallet,
            to: transferPeer.owner,
            tokenMint: row.mint,
            amountTokens: Math.abs(delta),
            decimals: row.decimals,
            slot,
            txSig,
            timestampMs: Date.now(),
          });
          continue;
        }

        // Otherwise treat as swap (buy or sell). Skip pure incoming transfers we don't own the sender for.
        if (transferPeer && delta > 0 && !this.watched.has(transferPeer.owner)) {
          // We're the recipient of an unrelated transfer — ignore as swap.
          continue;
        }

        const side: "buy" | "sell" = delta > 0 ? "buy" : "sell";
        out.push({
          kind: "swap",
          wallet,
          side,
          tokenMint: row.mint,
          amountTokens: Math.abs(delta),
          decimals: row.decimals,
          amountUsd: undefined,
          slot,
          txSig,
          timestampMs: Date.now(),
          isPumpFun: row.mint.endsWith("pump"),
        });
      }
    }

    return out;
  }

  private buildOwnerMintDeltas(meta: any): Array<{ owner: string; mint: string; pre: number; post: number; decimals: number }> {
    const key = (owner: string, mint: string) => `${owner}::${mint}`;
    const m = new Map<string, { owner: string; mint: string; pre: number; post: number; decimals: number }>();
    const ingest = (balances: any[], field: "pre" | "post") => {
      for (const b of balances ?? []) {
        if (!b?.owner || !b?.mint) continue;
        const k = key(b.owner, b.mint);
        const row = m.get(k) ?? { owner: b.owner, mint: b.mint, pre: 0, post: 0, decimals: Number(b.uiTokenAmount?.decimals ?? 0) };
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
    return keys.map((key) => {
      if (typeof key === "string") return key;
      if (key instanceof Uint8Array || Buffer.isBuffer(key)) return bs58.encode(Buffer.from(key));
      if (Array.isArray(key)) return bs58.encode(Buffer.from(key));
      return "";
    }).filter(Boolean);
  }

  private decodeSignature(sig: unknown): string {
    if (!sig) return "";
    if (typeof sig === "string") return sig;
    if (sig instanceof Uint8Array || Buffer.isBuffer(sig)) return bs58.encode(Buffer.from(sig));
    if (Array.isArray(sig)) return bs58.encode(Buffer.from(sig));
    return "";
  }
}

