// Yellowstone Geyser gRPC subscription — this is the subsecond hot path.
// We subscribe to transactions that include the target wallet OR any active
// follower wallet, decode swap instructions, and hand each event to the executor.

import Client, { CommitmentLevel, SubscribeRequest } from "@triton-one/yellowstone-grpc";
import pino from "pino";
import { env } from "./env.js";

const log = pino({ level: env.LOG_LEVEL });

export type SwapEvent = {
  wallet: string;
  side: "buy" | "sell";
  tokenMint: string;
  amountTokens: number;
  amountUsd?: number;
  slot: number;
  txSig: string;
  timestampMs: number;
  isPumpFun: boolean;
};

export type OnSwap = (e: SwapEvent) => Promise<void> | void;

export class GeyserFeed {
  private client: Client;
  private watched = new Set<string>();
  private stream?: Awaited<ReturnType<Client["subscribe"]>>;
  private onSwap: OnSwap;

  constructor(onSwap: OnSwap) {
    this.client = new Client(env.YELLOWSTONE_GRPC_URL, env.YELLOWSTONE_TOKEN, {
      grpcMaxDecodingMessageSize: 64 * 1024 * 1024,
    });
    this.onSwap = onSwap;
  }

  async start(initialWallets: string[]) {
    initialWallets.forEach((w) => this.watched.add(w));
    this.stream = await this.client.subscribe();

    this.stream.on("data", (msg) => this.handleMessage(msg).catch((e) => log.error(e)));
    this.stream.on("error", (e) => log.error({ err: e }, "geyser stream error"));

    await this.push();
    log.info({ n: this.watched.size }, "geyser subscribed");
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

  private async handleMessage(msg: any) {
    const tx = msg?.transaction?.transaction;
    if (!tx) return;
    // TODO: decode via SPL Token / Raydium / Pump.fun IDLs to reconstruct SwapEvent.
    // Placeholder shape so the executor path is exercised end-to-end.
    const slot: number = Number(msg.transaction.slot ?? 0);
    const txSig: string = tx?.signature ? Buffer.from(tx.signature).toString("hex") : "";
    const wallet = tx?.meta?.loadedWritableAddresses?.[0] ?? "";
    if (!wallet) return;

    const event: SwapEvent = {
      wallet,
      side: "buy",           // decode from instruction
      tokenMint: "",         // decode from post token balances diff
      amountTokens: 0,
      slot,
      txSig,
      timestampMs: Date.now(),
      isPumpFun: false,
    };
    await this.onSwap(event);
  }
}
