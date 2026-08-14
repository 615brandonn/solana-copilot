// Yellowstone Geyser gRPC subscription — this is the subsecond hot path.
// We subscribe to transactions that include the target wallet OR any active
// follower wallet, decode swap instructions, and hand each event to the executor.

import { createRequire } from "node:module";
import type { SubscribeRequest } from "@triton-one/yellowstone-grpc";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import pino from "pino";
import { env } from "./env.js";
import { safeDiagnostic } from "./diagnostics.js";
import {
  attributeVerifiedBuy,
  attributeVerifiedSell,
  conservativeNativeSolSpend,
  hasWalletSpecificSpend,
  isOnCurveWallet,
  parseRawTokenAmount,
  rawTokenDelta,
  tokenDelta,
  tokenDeltaSign,
  WSOL_MINT,
  type VerifiedTokenSpend,
  type VerifiedSellAttribution,
  type WalletTokenDelta,
} from "./swap-attribution.js";
import { hasHostileExecutorSignal, hasVerifiedSwapSignal } from "./swap-signal.js";

const log = pino({ level: env.LOG_LEVEL });
const require = createRequire(import.meta.url);
const YellowstoneGrpc = require("@triton-one/yellowstone-grpc") as Record<string, any>;
const CommitmentLevel = YellowstoneGrpc.CommitmentLevel ??
  YellowstoneGrpc.default?.CommitmentLevel ?? { PROCESSED: 0 };
const GEYSER_HEALTH_MAX_SILENCE_MS = 60_000;
const GEYSER_LIVE_QUEUE_MAX_AGE_MS = 5_000;

type PendingGeyserMessage = {
  generation: number;
  receivedAtMs: number;
  message: any;
};

function sameWalletSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const wallet of left) {
    if (!right.has(wallet)) return false;
  }
  return true;
}

function symmetricDifferenceSize(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let difference = 0;
  for (const wallet of left) {
    if (!right.has(wallet)) difference += 1;
  }
  for (const wallet of right) {
    if (!left.has(wallet)) difference += 1;
  }
  return difference;
}

function sanitizeGeyserError(error: unknown): string {
  const message = safeDiagnostic(error).toLowerCase();
  if (/timed? out|timeout|etimedout/.test(message)) return "Geyser request timed out";
  if (/rate.?limit|too many requests|\b429\b/.test(message))
    return "Geyser request was rate limited";
  if (/unauthori[sz]ed|authentication|invalid api|\b401\b/.test(message)) {
    return "Geyser authentication failed";
  }
  if (/forbidden|permission denied|\b403\b/.test(message)) return "Geyser permission denied";
  if (/unavailable|overloaded|\b50[234]\b/.test(message)) return "Geyser service unavailable";
  if (/network|fetch|socket|connection|econn|enotfound|dns/.test(message)) {
    return "Geyser network request failed";
  }
  return "Geyser operation failed";
}

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
  /** Exact raw amount represented by amountTokens when token balances supplied it. */
  amountRaw?: string;
  /** Gross acquisition before a same-transaction forward; amountTokens stays legacy net. */
  grossAmountTokens?: number;
  grossAmountRaw?: string;
  /** Wallet balance boundary for this mint in the observed transaction. */
  tokenBalanceBefore?: number;
  tokenBalanceAfter?: number;
  tokenBalanceBeforeRaw?: string;
  tokenBalanceAfterRaw?: string;
  decimals: number;
  amountUsd?: number;
  spentToken?: VerifiedTokenSpend;
  solSpend?: number;
  inferredRecipients?: string[];
  /** Atomic forwards for custody only; does not activate legacy inferred-buy gates. */
  custodyForwardRecipients?: string[];
  solDelta: number; // WSOL/SOL change for this wallet in this tx (negative = spent, positive = received)
  slot: number;
  txSig: string;
  timestampMs: number;
  isPumpFun: boolean;
  verifiedSwap?: boolean;
  sellAttribution?: VerifiedSellAttribution;
  blockTimeMs?: number;
  observedAtMs?: number;
  delivery?: "live" | "catchup";
  source?: "geyser" | "rpc" | "unknown";
};

export type TransferRecipient = {
  wallet: string;
  amountTokens: number;
  amountRaw?: string;
  recipientPreAmount?: number;
  recipientPostAmount?: number;
  recipientPreRaw?: string;
  recipientPostRaw?: string;
};

export type TransferEvent = {
  kind: "transfer";
  from: string; // sender (must be a watched wallet)
  to: string; // recipient
  tokenMint: string;
  amountTokens: number;
  decimals: number;
  slot: number;
  txSig: string;
  timestampMs: number;
  /** Sender balance facts used for conservative pro-rata custody attribution. */
  senderPreAmount?: number;
  senderPostAmount?: number;
  senderPreRaw?: string;
  senderPostRaw?: string;
  recipientPreAmount?: number;
  recipientPostAmount?: number;
  /** True when sender balances model the acquired lot before/after an atomic forward. */
  sameTransactionAcquisition?: boolean;
  /** Actual transaction boundary balances, retained separately from the lot model. */
  chainSenderPreAmount?: number;
  chainSenderPostAmount?: number;
  chainSenderPreRaw?: string;
  chainSenderPostRaw?: string;
  /** Complete conserving recipient set for this sender/mint/transaction. */
  recipients?: TransferRecipient[];
  blockTimeMs?: number;
  observedAtMs?: number;
  delivery?: "live" | "catchup";
  source?: "geyser" | "rpc" | "unknown";
};

export type FeedEvent = SwapEvent | TransferEvent;
export type OnSwap = (e: FeedEvent) => Promise<void> | void;

export class GeyserFeed {
  private client: any;
  // `desiredWatched` is the subscription we want the server to have, while
  // `watched` is only updated after the server acknowledges a write. Keeping
  // them separate is important: a failed gRPC write must remain retryable and
  // must not make health/decoding claim coverage that was never established.
  private desiredWatched = new Set<string>();
  private watched = new Set<string>();
  private stream?: any;
  private onSwap: OnSwap;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnecting = false;
  private stopped = false;
  private lastMessageAt?: number;
  private lastMessageGeneration?: number;
  private decodedEventCount = 0;
  private processingMessage = false;
  private pendingMessages: PendingGeyserMessage[] = [];
  private streamGeneration = 0;
  private discardedQueuedMessageCount = 0;

  constructor(onSwap: OnSwap) {
    this.client = createClient();
    this.onSwap = onSwap;
  }

  async start(initialWallets: string[]) {
    initialWallets.forEach((w) => this.desiredWatched.add(w));
    this.stopped = false;
    if (this.desiredWatched.size === 0) {
      this.suspendStream("no watched wallets");
      return;
    }
    await this.connect();
  }

  async watch(wallet: string) {
    if (!wallet) return;
    this.desiredWatched.add(wallet);
    this.stopped = false;
    if (sameWalletSet(this.watched, this.desiredWatched)) return;
    try {
      if (this.stream) await this.push();
      else await this.connect();
    } catch (error) {
      this.scheduleReconnect("subscription update failed");
      throw new Error(sanitizeGeyserError(error));
    }
  }

  async unwatch(wallet: string) {
    if (!this.desiredWatched.delete(wallet)) return;
    if (this.desiredWatched.size === 0) {
      this.suspendStream("last wallet removed");
      return;
    }
    if (sameWalletSet(this.watched, this.desiredWatched)) return;
    try {
      await this.push();
    } catch (error) {
      this.scheduleReconnect("subscription update failed");
      throw new Error(sanitizeGeyserError(error));
    }
  }

  /** Permanently closes this feed instance until start/watch is called again. */
  stop(): void {
    this.stopped = true;
    this.desiredWatched.clear();
    this.suspendStream("feed stopped");
  }

  health(nowMs = Date.now()) {
    const pendingSubscriptionCount = symmetricDifferenceSize(this.watched, this.desiredWatched);
    const secondsSinceLastMessage =
      this.lastMessageAt === undefined
        ? null
        : Math.max(0, Math.round((nowMs - this.lastMessageAt) / 1000));
    const messageFresh =
      this.lastMessageAt !== undefined &&
      this.lastMessageGeneration === this.streamGeneration &&
      nowMs - this.lastMessageAt >= -5_000 &&
      nowMs - this.lastMessageAt <= GEYSER_HEALTH_MAX_SILENCE_MS;
    const subscriptionReady = !!this.stream && pendingSubscriptionCount === 0;
    return {
      watchedCount: this.watched.size,
      desiredWatchedCount: this.desiredWatched.size,
      pendingSubscriptionCount,
      lastMessageAt: this.lastMessageAt,
      secondsSinceLastMessage,
      decodedEventCount: this.decodedEventCount,
      messageFresh,
      subscriptionReady,
      pendingMessageCount: this.pendingMessages?.length ?? 0,
      discardedQueuedMessageCount: this.discardedQueuedMessageCount ?? 0,
      // Deployment gates consume `connected`. A writable transport is not
      // evidence that the remote feed is still delivering data, so require a
      // recent transaction/keepalive message as well as complete filters.
      connected: subscriptionReady && messageFresh,
      transportConnected: !!this.stream,
    };
  }

  private async push() {
    const stream = this.stream;
    if (!stream) return;
    const requestedWallets = Array.from(this.desiredWatched);
    if (requestedWallets.length === 0) {
      this.suspendStream("no watched wallets");
      return;
    }
    const req: SubscribeRequest = {
      accounts: {},
      slots: {},
      transactions: {
        copy: {
          vote: false,
          failed: false,
          accountInclude: requestedWallets,
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
    await new Promise<void>((res, rej) =>
      stream.write(req, (err: unknown) => (err ? rej(err) : res())),
    );
    // Ignore acknowledgements from a stream that was replaced while the write
    // was in flight. A later call will reconcile any concurrently changed
    // desired set.
    if (this.stream !== stream) return;
    this.watched = new Set(requestedWallets);
    if (!sameWalletSet(this.watched, this.desiredWatched)) {
      await this.push();
    }
  }

  private async connect() {
    if (this.reconnecting || this.stopped) return;
    if (this.desiredWatched.size === 0) {
      this.suspendStream("no watched wallets");
      return;
    }
    this.reconnecting = true;
    try {
      this.stream?.removeAllListeners();
      this.stream?.end?.();
      this.watched.clear();
      this.discardQueuedMessages("stream replaced");
      const stream = await this.client.subscribe();
      if (this.stopped || this.desiredWatched.size === 0) {
        stream?.removeAllListeners?.();
        stream?.end?.();
        return;
      }
      const generation = ++this.streamGeneration;
      this.stream = stream;

      stream.on("data", (msg: any) => this.processMessageWithBackpressure(msg, stream, generation));
      stream.on("error", (e: any) => {
        if (!this.isCurrentStream(stream, generation)) return;
        log.error({ error: sanitizeGeyserError(e) }, "geyser stream error");
        this.scheduleReconnect("stream error");
      });
      stream.on("end", () => {
        if (this.isCurrentStream(stream, generation)) this.scheduleReconnect("stream ended");
      });
      stream.on("close", () => {
        if (this.isCurrentStream(stream, generation)) this.scheduleReconnect("stream closed");
      });

      await this.push();
      log.info({ n: this.watched.size }, "geyser subscribed");
    } finally {
      this.reconnecting = false;
    }
  }

  private suspendStream(reason: string) {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const prior = this.stream;
    this.stream = undefined;
    this.streamGeneration = (this.streamGeneration ?? 0) + 1;
    this.watched.clear();
    this.discardQueuedMessages(reason);
    prior?.removeAllListeners?.();
    prior?.end?.();
  }

  private processMessageWithBackpressure(
    msg: any,
    stream = this.stream,
    generation = this.streamGeneration,
  ) {
    if (!stream || !this.isCurrentStream(stream, generation)) return;
    const receivedAtMs = Date.now();
    this.lastMessageAt = receivedAtMs;
    this.lastMessageGeneration = generation;
    // A Yellowstone stream can deliver messages much faster than downstream
    // database/event handling completes. Pause the readable side immediately
    // so async handlers cannot accumulate without bound and starve heartbeat
    // timers or exhaust the VPS memory.
    stream.pause?.();
    this.pendingMessages.push({ generation, receivedAtMs, message: msg });
    this.startMessageDrain();
  }

  private startMessageDrain() {
    if (this.processingMessage) return;
    const stream = this.stream;
    const generation = this.streamGeneration;
    if (!stream) return;
    if (!this.pendingMessages.some((pending) => pending.generation === generation)) {
      stream.resume?.();
      return;
    }
    this.processingMessage = true;
    this.drainMessages(stream, generation).finally(() => {
      this.processingMessage = false;
      if (this.stream === stream && !this.stopped) stream.resume?.();
      // A replacement stream can receive and pause while the old generation's
      // final handler is still unwinding. Always give the current generation
      // an opportunity to drain after releasing the global serial handler.
      this.startMessageDrain();
    });
  }

  private async drainMessages(stream: any, generation: number) {
    while (this.isCurrentStream(stream, generation) && this.pendingMessages.length > 0) {
      const pending = this.pendingMessages.shift();
      if (!pending) break;
      if (pending.generation !== generation) {
        this.discardedQueuedMessageCount += 1;
        continue;
      }
      try {
        await this.handleMessage(pending.message, generation, pending.receivedAtMs);
      } catch (err) {
        log.error({ error: sanitizeGeyserError(err) }, "geyser message handling failed");
      }
    }
  }

  private scheduleReconnect(reason: string) {
    if (this.stopped || this.reconnectTimer) return;
    const failedStream = this.stream;
    this.stream = undefined;
    this.streamGeneration += 1;
    this.watched.clear();
    this.discardQueuedMessages("stream disconnected");
    failedStream?.removeAllListeners?.();
    failedStream?.end?.();
    log.warn({ reason }, "geyser reconnect scheduled");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect().catch((err) => {
        log.error({ error: sanitizeGeyserError(err) }, "geyser reconnect failed");
        this.scheduleReconnect("reconnect failed");
      });
    }, 1000);
  }

  private async handleMessage(msg: any, generation: number, receivedAtMs: number) {
    if (generation !== this.streamGeneration || !this.stream) return;
    const tx = msg?.transaction?.transaction;
    if (!tx) return;
    const events = this.decodeEvents(msg, tx);
    if (events.length === 0) {
      const txSig = this.decodeSignature(tx.signature ?? tx.transaction?.signatures?.[0]);
      const message = tx.transaction?.message ?? tx.message;
      const accountKeys = this.decodeAccountKeys([
        ...(message?.accountKeys ?? []),
        ...(tx.meta?.loadedWritableAddresses ??
          tx.transaction?.meta?.loadedWritableAddresses ??
          msg.transaction.meta?.loadedWritableAddresses ??
          []),
        ...(tx.meta?.loadedReadonlyAddresses ??
          tx.transaction?.meta?.loadedReadonlyAddresses ??
          msg.transaction.meta?.loadedReadonlyAddresses ??
          []),
      ]);
      const matchedWatchedCount = accountKeys.reduce(
        (count, account) => count + (this.desiredWatched.has(account) ? 1 : 0),
        0,
      );
      log.warn(
        {
          slot: msg?.transaction?.slot,
          txSig,
          watchedCount: this.desiredWatched.size,
          matchedWatchedCount,
          accountKeysCount: accountKeys.length,
        },
        "tx seen but no events decoded",
      );
    }
    for (const ev of events) {
      if (generation !== this.streamGeneration || !this.stream) {
        this.discardedQueuedMessageCount += 1;
        log.warn("old-generation Geyser event discarded — confirmed RPC recovery remains active");
        return;
      }
      const queuedAgeMs = Math.max(0, Date.now() - receivedAtMs);
      const delayed = queuedAgeMs > GEYSER_LIVE_QUEUE_MAX_AGE_MS;
      ev.source = "geyser";
      ev.delivery = delayed ? "catchup" : "live";
      ev.observedAtMs = receivedAtMs;
      ev.timestampMs = receivedAtMs;
      // isFreshAutomaticAction uses blockTimeMs for catch-up deliveries. The
      // receive time is a conservative upper bound on the chain event time and
      // prevents delayed queued messages from being treated as freshly arrived.
      if (delayed && ev.blockTimeMs === undefined) ev.blockTimeMs = receivedAtMs;
      this.decodedEventCount += 1;
      log.debug(
        {
          kind: ev.kind,
          wallet: (ev as any).wallet ?? (ev as any).from,
          side: (ev as any).side,
          mint: ev.tokenMint,
        },
        "feed event",
      );
      await this.onSwap(ev);
    }
  }

  private isCurrentStream(stream: any, generation: number): boolean {
    return this.stream === stream && this.streamGeneration === generation;
  }

  private discardQueuedMessages(reason: string) {
    const discarded = this.pendingMessages?.length ?? 0;
    if (discarded === 0) return;
    this.pendingMessages = [];
    this.discardedQueuedMessageCount = (this.discardedQueuedMessageCount ?? 0) + discarded;
    log.warn(
      { discarded, reason },
      "queued Geyser messages discarded — confirmed RPC recovery remains active",
    );
  }

  private decodeEvents(msg: any, tx: any): FeedEvent[] {
    const out: FeedEvent[] = [];
    const slot: number = Number(msg.transaction.slot ?? 0);
    const meta = tx.meta ?? tx.transaction?.meta ?? msg.transaction.meta;
    if (!meta || (meta.err !== null && meta.err !== undefined)) return out;
    const txSig = this.decodeSignature(tx.signature ?? tx.transaction?.signatures?.[0]);

    // Native SOL deltas per account key (lamports).
    const message = tx.transaction?.message ?? tx.message;
    const staticAccountKeys = this.decodeAccountKeys(message?.accountKeys ?? []);
    const accountKeys = this.decodeAccountKeys([
      ...(message?.accountKeys ?? []),
      ...(meta?.loadedWritableAddresses ?? []),
      ...(meta?.loadedReadonlyAddresses ?? []),
    ]);
    const requiredSignatures = Number(
      message?.header?.numRequiredSignatures ?? message?.header?.num_required_signatures ?? 0,
    );
    const signerKeys = new Set(
      Number.isFinite(requiredSignatures) && requiredSignatures > 0
        ? staticAccountKeys.slice(0, requiredSignatures)
        : [],
    );

    // Build per-(owner,mint) delta table across the whole tx. Some Geyser/RPC
    // payloads omit token-balance owner, so accountIndex + ATA matching is used
    // as a fallback for every watched wallet.
    const table = this.buildOwnerMintDeltas(meta, accountKeys);
    const hasSwapSignal =
      hasVerifiedSwapSignal(meta?.logMessages ?? []) ||
      hasHostileExecutorSignal(meta?.logMessages ?? []);

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
      const solSpend = conservativeNativeSolSpend(
        natDelta,
        Number(meta?.fee ?? 0),
        accountKeys[0] === wallet,
      );
      const hasSolMove = Math.abs(solDelta) > 0.0005; // > 0.0005 SOL rules out fee-only

      const attributionRows = table.filter((r) => r.owner === wallet);
      const walletRows = attributionRows.filter((r) => r.mint !== WSOL_MINT);
      const positiveOutputRows = walletRows.filter((row) => tokenDeltaSign(row) > 0);
      const walletSigned = signerKeys.has(wallet);
      const walletCanAuthorizeSwap = signerKeys.size === 1 && signerKeys.has(wallet);
      const negativeWalletMints = new Set(
        walletRows.filter((row) => tokenDeltaSign(row) < 0).map((row) => row.mint),
      );
      const globalOutputMints = new Set(positiveOutputRows.map((row) => row.mint));
      for (const recipientRow of table) {
        if (
          recipientRow.owner !== wallet &&
          recipientRow.mint !== WSOL_MINT &&
          isOnCurveWallet(recipientRow.owner) &&
          tokenDeltaSign(recipientRow) > 0 &&
          !negativeWalletMints.has(recipientRow.mint)
        ) {
          globalOutputMints.add(recipientRow.mint);
        }
      }
      const forwardedBuy = this.inferBuyForwardedOut(
        table,
        wallet,
        solSpend,
        hasSwapSignal,
        walletCanAuthorizeSwap,
        negativeWalletMints,
      );
      if (walletRows.length > 0) {
        log.info(
          {
            wallet,
            txSig,
            solDelta,
            hasSolMove,
            hasSwapSignal,
            tokenDeltas: walletRows.map((r) => ({
              mint: r.mint,
              delta: tokenDelta(r),
              amountRaw: rawTokenDelta(r)?.toString(),
              decimals: r.decimals,
            })),
          },
          "watched wallet token delta",
        );
      }
      for (const row of walletRows) {
        const sign = tokenDeltaSign(row);
        if (sign === 0) continue;
        const delta = tokenDelta(row);
        const side: "buy" | "sell" = sign > 0 ? "buy" : "sell";
        // The legacy swap event for an atomic partial forward is emitted below
        // with the same net amount plus explicit gross custody evidence.
        if (side === "buy" && forwardedBuy?.tokenMint === row.mint) continue;
        const sellAttribution =
          side === "sell"
            ? attributeVerifiedSell(
                attributionRows,
                row.mint,
                natDelta,
                hasSwapSignal,
                walletSigned,
                signerKeys.size,
              )
            : undefined;
        const verifiedSwapForWallet =
          side === "buy"
            ? walletCanAuthorizeSwap && (hasSolMove || hasSwapSignal)
            : Boolean(sellAttribution?.verified);
        if (verifiedSwapForWallet) {
          // Buys retain the strict sole-signer rule. Sells may include a
          // separate fee payer only when the watched wallet's exact debit and
          // one proceeds asset make the ownership path unambiguous.
          // When we have a real SOL delta, require signs to match:
          // Buy: token+ and SOL-. Sell: token- and SOL+.
          if (side === "buy" && !hasSwapSignal) {
            log.info(
              { wallet, txSig, mint: row.mint },
              "positive token delta skipped — no explicit swap instruction",
            );
            continue;
          }
          if (
            hasSolMove &&
            !hasSwapSignal &&
            ((side === "buy" && solDelta > 0) || (side === "sell" && solDelta < 0))
          ) {
            log.info(
              { wallet, txSig, mint: row.mint, side, solDelta, tokenDelta: delta },
              "swap sign mismatch — skipped",
            );
            continue;
          }
          const verifiedSpend =
            side === "buy"
              ? attributeVerifiedBuy(
                  attributionRows,
                  row.mint,
                  globalOutputMints.size,
                  solSpend,
                  hasSwapSignal,
                )
              : undefined;
          if (side === "buy" && !verifiedSpend?.verified) {
            log.info(
              { wallet, txSig, mint: row.mint },
              "positive token delta skipped — no unambiguous wallet-specific spend",
            );
            continue;
          }
          out.push({
            kind: "swap",
            wallet,
            side,
            tokenMint: row.mint,
            amountTokens: Math.abs(delta),
            amountRaw: row.rawExact
              ? (row.postRaw - row.preRaw < 0n
                  ? row.preRaw - row.postRaw
                  : row.postRaw - row.preRaw
                ).toString()
              : undefined,
            decimals: row.decimals,
            amountUsd: verifiedSpend?.amountUsd,
            spentToken: verifiedSpend?.spentToken,
            solSpend: verifiedSpend?.solSpend,
            solDelta,
            slot,
            txSig,
            timestampMs: Date.now(),
            isPumpFun: row.mint.endsWith("pump"),
            verifiedSwap: hasSwapSignal,
            sellAttribution,
          });
        } else if (sign < 0) {
          // Pure token transfer OUT. Support split recipients only when this
          // wallet is the transaction's sole negative owner for the mint and
          // the positive recipient deltas conserve the complete amount.
          const negativeOwners = table.filter(
            (candidate) => candidate.mint === row.mint && tokenDeltaSign(candidate) < 0,
          );
          const peers = table.filter(
            (candidate) =>
              candidate.mint === row.mint &&
              candidate.owner !== wallet &&
              tokenDeltaSign(candidate) > 0,
          );
          const received = peers.reduce((sum, peer) => sum + tokenDelta(peer), 0);
          const sent = Math.abs(delta);
          const senderRawDelta = rawTokenDelta(row);
          const rawConserves =
            senderRawDelta !== undefined && peers.every((peer) => rawTokenDelta(peer) !== undefined)
              ? peers.reduce((sum, peer) => sum + (rawTokenDelta(peer) ?? 0n), 0n) ===
                -senderRawDelta
              : null;
          if (
            negativeOwners.length !== 1 ||
            negativeOwners[0]?.owner !== wallet ||
            peers.length === 0 ||
            (rawConserves === null
              ? Math.abs(received - sent) / Math.max(sent, 1e-9) >= 0.05
              : !rawConserves)
          ) {
            continue;
          }
          const recipients = peers
            .map((peer) => ({
              wallet: peer.owner,
              amountTokens: tokenDelta(peer),
              amountRaw: peer.rawExact ? (peer.postRaw - peer.preRaw).toString() : undefined,
              recipientPreAmount: peer.pre,
              recipientPostAmount: peer.post,
              recipientPreRaw: peer.rawExact ? peer.preRaw.toString() : undefined,
              recipientPostRaw: peer.rawExact ? peer.postRaw.toString() : undefined,
            }))
            .sort((a, b) => a.wallet.localeCompare(b.wallet));
          const first = recipients[0]!;
          out.push({
            kind: "transfer",
            from: wallet,
            to: first.wallet,
            tokenMint: row.mint,
            amountTokens: received,
            decimals: row.decimals,
            senderPreAmount: row.pre,
            senderPostAmount: row.post,
            senderPreRaw: row.rawExact ? row.preRaw.toString() : undefined,
            senderPostRaw: row.rawExact ? row.postRaw.toString() : undefined,
            recipientPreAmount: first.recipientPreAmount,
            recipients,
            slot,
            txSig,
            timestampMs: Date.now(),
          });
        }
      }

      // Many fast target wallets buy and transfer the bought token out inside
      // the same transaction. In that tx the target can have no positive final
      // token delta, so a pure owner-delta decoder misses the buy entirely.
      // Require the watched wallet to be a signer with its own economic debit.
      // Transaction-wide swap logs alone do not prove that every watched wallet
      // in the transaction bought the recipient token.
      const inferredBuy = forwardedBuy;
      if (inferredBuy) {
        const verifiedSpend = attributeVerifiedBuy(
          attributionRows,
          inferredBuy.tokenMint,
          1,
          solSpend,
          hasSwapSignal,
        );
        if (!verifiedSpend.verified) {
          log.info(
            { wallet, txSig, mint: inferredBuy.tokenMint },
            "inferred target buy skipped — input/output attribution is ambiguous",
          );
          continue;
        }
        log.warn(
          {
            wallet,
            txSig,
            mint: inferredBuy.tokenMint,
            amountTokens: inferredBuy.amountTokens,
            recipients: inferredBuy.recipients.map((r) => ({
              wallet: r.owner,
              amountTokens: r.amountTokens,
            })),
            solDelta,
            hasSwapSignal,
          },
          "inferred target buy from same-tx recipient balances",
        );

        out.push({
          kind: "swap",
          wallet,
          side: "buy",
          tokenMint: inferredBuy.tokenMint,
          amountTokens:
            inferredBuy.retainedAmountTokens > 0
              ? inferredBuy.retainedAmountTokens
              : inferredBuy.amountTokens,
          amountRaw:
            inferredBuy.retainedAmountTokens > 0
              ? inferredBuy.retainedAmountRaw
              : inferredBuy.amountRaw,
          grossAmountTokens: inferredBuy.amountTokens,
          grossAmountRaw: inferredBuy.amountRaw,
          decimals: inferredBuy.decimals,
          amountUsd: verifiedSpend.amountUsd,
          spentToken: verifiedSpend.spentToken,
          solSpend: verifiedSpend.solSpend,
          inferredRecipients:
            inferredBuy.retainedAmountTokens > 0
              ? undefined
              : inferredBuy.recipients.map((recipient) => recipient.owner),
          custodyForwardRecipients: inferredBuy.recipients.map((recipient) => recipient.owner),
          solDelta,
          slot,
          txSig,
          timestampMs: Date.now(),
          isPumpFun: inferredBuy.tokenMint.endsWith("pump"),
          verifiedSwap: hasSwapSignal,
        });

        const recipients = inferredBuy.recipients
          .map((recipient) => ({
            wallet: recipient.owner,
            amountTokens: recipient.amountTokens,
            recipientPreAmount: recipient.pre,
            amountRaw: recipient.amountRaw,
            recipientPostAmount: recipient.post,
            recipientPreRaw: recipient.preRaw,
            recipientPostRaw: recipient.postRaw,
          }))
          .sort((a, b) => a.wallet.localeCompare(b.wallet));
        const first = recipients[0]!;
        out.push({
          kind: "transfer",
          from: wallet,
          to: first.wallet,
          tokenMint: inferredBuy.tokenMint,
          amountTokens: inferredBuy.forwardedAmountTokens,
          decimals: inferredBuy.decimals,
          senderPreAmount: inferredBuy.amountTokens,
          senderPostAmount: inferredBuy.retainedAmountTokens,
          senderPreRaw: inferredBuy.amountRaw,
          senderPostRaw: inferredBuy.retainedAmountRaw,
          sameTransactionAcquisition: true,
          chainSenderPreAmount: inferredBuy.chainPreAmount,
          chainSenderPostAmount: inferredBuy.chainPostAmount,
          chainSenderPreRaw: inferredBuy.chainPreRaw,
          chainSenderPostRaw: inferredBuy.chainPostRaw,
          recipientPreAmount: first.recipientPreAmount,
          recipients,
          slot,
          txSig,
          timestampMs: Date.now(),
        });
      }
    }

    return out;
  }

  private inferBuyForwardedOut(
    table: Array<{ owner: string } & WalletTokenDelta>,
    wallet: string,
    solSpend: number | undefined,
    hasSwapSignal: boolean,
    walletCanAuthorizeSwap: boolean,
    negativeWalletMints: Set<string>,
  ): {
    tokenMint: string;
    amountTokens: number;
    amountRaw?: string;
    retainedAmountTokens: number;
    retainedAmountRaw?: string;
    forwardedAmountTokens: number;
    decimals: number;
    chainPreAmount: number;
    chainPostAmount: number;
    chainPreRaw?: string;
    chainPostRaw?: string;
    recipients: Array<{
      owner: string;
      amountTokens: number;
      amountRaw?: string;
      pre: number;
      post: number;
      preRaw?: string;
      postRaw?: string;
    }>;
  } | null {
    const walletRows = table.filter((row) => row.owner === wallet);
    if (!walletCanAuthorizeSwap || !hasSwapSignal || !hasWalletSpecificSpend(walletRows, solSpend))
      return null;

    const candidateMints = new Set(
      walletRows
        .filter((row) => row.mint !== WSOL_MINT && tokenDeltaSign(row) > 0)
        .map((row) => row.mint),
    );
    const byMint = new Map<
      string,
      {
        tokenMint: string;
        forwardedAmountTokens: number;
        forwardedAmountRaw?: bigint;
        rawExact: boolean;
        decimals: number;
        recipients: Array<{
          owner: string;
          amountTokens: number;
          amountRaw?: string;
          pre: number;
          post: number;
          preRaw?: string;
          postRaw?: string;
        }>;
      }
    >();
    for (const row of table) {
      if (row.owner === wallet || row.mint === WSOL_MINT || !isOnCurveWallet(row.owner)) continue;
      if (negativeWalletMints.has(row.mint) || tokenDeltaSign(row) <= 0) continue;
      candidateMints.add(row.mint);
      const delta = tokenDelta(row);
      const rawDelta = rawTokenDelta(row);
      const cur = byMint.get(row.mint) ?? {
        tokenMint: row.mint,
        forwardedAmountTokens: 0,
        forwardedAmountRaw: 0n,
        rawExact: true,
        decimals: row.decimals,
        recipients: [],
      };
      cur.forwardedAmountTokens += delta;
      if (rawDelta === undefined) {
        cur.rawExact = false;
        cur.forwardedAmountRaw = undefined;
      } else if (cur.rawExact) {
        cur.forwardedAmountRaw = (cur.forwardedAmountRaw ?? 0n) + rawDelta;
      }
      cur.decimals = row.decimals;
      cur.recipients.push({
        owner: row.owner,
        amountTokens: delta,
        amountRaw: row.rawExact ? (row.postRaw - row.preRaw).toString() : undefined,
        pre: row.pre,
        post: row.post,
        preRaw: row.rawExact ? row.preRaw.toString() : undefined,
        postRaw: row.rawExact ? row.postRaw.toString() : undefined,
      });
      byMint.set(row.mint, cur);
    }

    if (candidateMints.size !== 1) return null;
    const tokenMint = Array.from(candidateMints)[0]!;
    const forwarded = byMint.get(tokenMint);
    if (!forwarded || forwarded.forwardedAmountTokens <= 0 || forwarded.recipients.length === 0)
      return null;

    const retained = walletRows.find((row) => row.mint === tokenMint);
    const retainedAmountTokens =
      retained && tokenDeltaSign(retained) > 0 ? tokenDelta(retained) : 0;
    const retainedRaw = retained && tokenDeltaSign(retained) > 0 ? rawTokenDelta(retained) : 0n;
    const grossAmountTokens = retainedAmountTokens + forwarded.forwardedAmountTokens;
    const grossRaw =
      retainedRaw !== undefined && forwarded.rawExact
        ? retainedRaw + (forwarded.forwardedAmountRaw ?? 0n)
        : undefined;
    return {
      tokenMint,
      amountTokens: grossAmountTokens,
      amountRaw: grossRaw?.toString(),
      retainedAmountTokens,
      retainedAmountRaw: retainedRaw?.toString(),
      forwardedAmountTokens: forwarded.forwardedAmountTokens,
      decimals: forwarded.decimals,
      chainPreAmount: retained?.pre ?? 0,
      chainPostAmount: retained?.post ?? 0,
      chainPreRaw: retained?.rawExact ? retained.preRaw.toString() : undefined,
      chainPostRaw: retained?.rawExact ? retained.postRaw.toString() : undefined,
      recipients: forwarded.recipients,
    };
  }

  private toBase58(v: unknown): string {
    if (!v) return "";
    if (typeof v === "string") return v;
    if (v instanceof Uint8Array || Buffer.isBuffer(v)) return bs58.encode(Buffer.from(v as any));
    if (Array.isArray(v)) return bs58.encode(Buffer.from(v as any));
    if (typeof v === "object") {
      const obj = v as Record<string, unknown>;
      if (Array.isArray(obj.data)) return bs58.encode(Buffer.from(obj.data));
      if (obj.type === "Buffer" && Array.isArray(obj.data))
        return bs58.encode(Buffer.from(obj.data));
      for (const key of ["pubkey", "publicKey", "key", "value", "bytes"]) {
        const decoded = this.toBase58(obj[key]);
        if (decoded) return decoded;
      }
      if (typeof obj.toBase58 === "function") {
        try {
          return String(obj.toBase58());
        } catch {
          return "";
        }
      }
      if (typeof obj.toString === "function") {
        const s = obj.toString();
        if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return s;
      }
    }
    return "";
  }

  private buildOwnerMintDeltas(
    meta: any,
    accountKeys: string[],
  ): Array<{ owner: string } & WalletTokenDelta> {
    const key = (owner: string, mint: string) => `${owner}::${mint}`;
    const m = new Map<string, { owner: string } & WalletTokenDelta>();
    const ingest = (balances: any[], field: "pre" | "post") => {
      for (const b of balances ?? []) {
        const mint = this.toBase58(b?.mint);
        const owner = this.resolveTokenOwner(b, mint, accountKeys);
        if (!owner || !mint) continue;
        const k = key(owner, mint);
        const decimals = Number(b.uiTokenAmount?.decimals ?? 0);
        const row = m.get(k) ?? {
          owner,
          mint,
          pre: 0,
          post: 0,
          decimals,
          preRaw: 0n,
          postRaw: 0n,
          rawExact: true,
        };
        const amt = Number(b.uiTokenAmount?.uiAmountString ?? b.uiTokenAmount?.uiAmount ?? 0);
        row[field] += amt;
        const raw = parseRawTokenAmount(b.uiTokenAmount?.amount);
        if (raw === undefined) row.rawExact = false;
        else if (field === "pre") row.preRaw += raw;
        else row.postRaw += raw;
        row.decimals = Number(b.uiTokenAmount?.decimals ?? row.decimals);
        m.set(k, row);
      }
    };
    ingest(meta?.preTokenBalances ?? [], "pre");
    ingest(meta?.postTokenBalances ?? [], "post");
    return Array.from(m.values());
  }

  private resolveTokenOwner(balance: any, mint: string, accountKeys: string[]): string {
    const explicitOwner = this.toBase58(balance?.owner);
    if (explicitOwner) return explicitOwner;

    const accountIndex = Number(balance?.accountIndex);
    const tokenAccount = Number.isFinite(accountIndex) ? accountKeys[accountIndex] : "";
    if (!tokenAccount || !mint) return "";

    for (const wallet of this.watched) {
      try {
        const ata = getAssociatedTokenAddressSync(
          new PublicKey(mint),
          new PublicKey(wallet),
          true,
        ).toBase58();
        if (ata === tokenAccount) return wallet;
      } catch {
        continue;
      }
    }
    // Last resort: treat the token account itself as the watched entity. This
    // still lets us monitor that token account's future sell/transfer txs even
    // when the upstream payload omits the wallet owner.
    return tokenAccount;
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
