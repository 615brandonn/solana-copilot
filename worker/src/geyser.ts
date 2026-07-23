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

    const event = this.decodeSwapEvent(msg, tx);
    if (event) await this.onSwap(event);
  }

  private decodeSwapEvent(msg: any, tx: any): SwapEvent | null {
    const slot: number = Number(msg.transaction.slot ?? 0);
    const meta = tx.meta ?? tx.transaction?.meta ?? msg.transaction.meta;
    const message = tx.transaction?.message ?? tx.message;
    const accountKeys = this.decodeAccountKeys(message?.accountKeys ?? []);
    const txSig = this.decodeSignature(tx.signature ?? tx.transaction?.signatures?.[0]);

    for (const wallet of this.watched) {
      const tokenDelta = this.findLargestTokenDelta(meta, wallet);
      if (!tokenDelta || tokenDelta.mint === WSOL_MINT) continue;

      const walletIndex = accountKeys.indexOf(wallet);
      const solDeltaLamports = walletIndex >= 0
        ? Number(meta?.postBalances?.[walletIndex] ?? 0) - Number(meta?.preBalances?.[walletIndex] ?? 0)
        : 0;

      const side = tokenDelta.delta > 0 ? "buy" : "sell";
      if (side === "buy" && tokenDelta.delta <= 0) continue;
      if (side === "sell" && tokenDelta.delta >= 0) continue;

      return {
        wallet,
        side,
        tokenMint: tokenDelta.mint,
        amountTokens: Math.abs(tokenDelta.delta),
        amountUsd: undefined,
        slot,
        txSig,
        timestampMs: Date.now(),
        isPumpFun: tokenDelta.mint.endsWith("pump"),
      };
    }

    return null;
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

  private findLargestTokenDelta(meta: any, owner: string): { mint: string; delta: number } | null {
    const balances = new Map<string, { pre: number; post: number }>();
    for (const balance of meta?.preTokenBalances ?? []) {
      if (balance.owner !== owner || !balance.mint) continue;
      const row = balances.get(balance.mint) ?? { pre: 0, post: 0 };
      row.pre += Number(balance.uiTokenAmount?.uiAmountString ?? balance.uiTokenAmount?.uiAmount ?? 0);
      balances.set(balance.mint, row);
    }
    for (const balance of meta?.postTokenBalances ?? []) {
      if (balance.owner !== owner || !balance.mint) continue;
      const row = balances.get(balance.mint) ?? { pre: 0, post: 0 };
      row.post += Number(balance.uiTokenAmount?.uiAmountString ?? balance.uiTokenAmount?.uiAmount ?? 0);
      balances.set(balance.mint, row);
    }

    let largest: { mint: string; delta: number } | null = null;
    for (const [mint, row] of balances) {
      const delta = row.post - row.pre;
      if (!largest || Math.abs(delta) > Math.abs(largest.delta)) largest = { mint, delta };
    }
    return largest && Math.abs(largest.delta) > 0 ? largest : null;
  }
}
