import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import pino from "pino";
import { env } from "./env.js";
import type { FeedEvent } from "./geyser.js";
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
  type WalletTokenDelta,
} from "./swap-attribution.js";
import { hasHostileExecutorSignal, hasVerifiedSwapSignal } from "./swap-signal.js";
import {
  planNextRpcSignaturePage,
  planRpcSignaturePages,
  sanitizeRpcCursorError,
  takeOldestRpcRecoveryChunk,
  type RpcCursorStore,
  type RpcWalletCursor,
} from "./rpc-cursor.js";

const log = pino({ level: env.LOG_LEVEL });
const RPC_SIGNATURE_PAGE_SIZE = 1_000;
const RPC_SIGNATURE_MAX_PAGES = 1_000;
const RPC_RECOVERY_CHUNK_SIZE = 5_000;
const RPC_READ_TIMEOUT_MS = 15_000;

export type PollerHandler = (event: FeedEvent) => Promise<void> | void;

export type UnresolvedOutflowEvent = {
  kind: "unresolved_outflow";
  wallet: string;
  tokenMint: string;
  amountTokens: number;
  amountRaw?: string;
  preAmount: number;
  postAmount: number;
  preRaw?: string;
  postRaw?: string;
  decimals: number;
  slot: number;
  txSig: string;
  timestampMs: number;
  blockTimeMs?: number;
  observedAtMs?: number;
  delivery?: "live" | "catchup";
  source?: "rpc" | "unknown";
  reason: "negative_token_delta_not_attributed";
};

export type RpcBackfillPollerOptions = {
  /** Custody-only coverage hook. Omit it to preserve the trading poller's behavior. */
  onUnresolvedOutflow?: (event: UnresolvedOutflowEvent) => Promise<void> | void;
  /** Custody-only: replay an older range when a new mint attribution predates this wallet cursor. */
  allowEarlierAnchorRewind?: boolean;
  /** Wallets polled per batch. Defaults to 8, the trading poller's baseline. */
  pollConcurrency?: number;
};

export type RpcWatchOptions = {
  anchorSlot?: number;
};

export class RpcBackfillPoller {
  private watched = new Map<string, RpcWatchOptions>();
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastPollAt?: number;
  private lastSuccessAt?: number;
  private backlogWallets = new Set<string>();
  // A newly watched wallet is fail-closed until its durable cursor has been
  // loaded. This prevents a persisted backlog from briefly disappearing from
  // health after a worker restart.
  private cursorHydrationPending = new Set<string>();
  private cursorHydrationInFlight = new Set<string>();
  private failures = 0;
  private cursorCache = new Map<string, RpcWalletCursor>();
  private cursorSuccessPersistedAt = new Map<string, number>();

  constructor(
    private conn: Connection,
    private onEvent: PollerHandler,
    private cursorStore: RpcCursorStore,
    private intervalMs = 1200,
    private includeActivationHead = false,
    private options: RpcBackfillPollerOptions = {},
  ) {}

  start(initialWallets: string[]) {
    initialWallets.forEach((wallet) => this.watch(wallet));
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.poll().catch((error) =>
        log.warn({ error: sanitizeRpcCursorError(error) }, "rpc fallback poll failed"),
      );
    }, this.intervalMs);
    this.poll().catch((error) =>
      log.warn({ error: sanitizeRpcCursorError(error) }, "rpc fallback initial poll failed"),
    );
    log.info(
      { watchedCount: this.watched.size, intervalMs: this.intervalMs },
      "durable RPC fallback poller started",
    );
  }

  watch(wallet: string, options: RpcWatchOptions = {}) {
    if (!wallet) return;
    const current = this.watched.get(wallet);
    const nextAnchor = positiveSlot(options.anchorSlot);
    const currentAnchor = positiveSlot(current?.anchorSlot);
    // An already-continuous target watch has no activation floor. Adding
    // another owner must not skip an unresolved target backlog.
    const mergedAnchor =
      currentAnchor !== undefined && nextAnchor !== undefined
        ? Math.min(currentAnchor, nextAnchor)
        : current
          ? currentAnchor
          : nextAnchor;
    this.watched.set(wallet, {
      anchorSlot: mergedAnchor,
    });
    const cached = this.cursorCache.get(wallet);
    if (cached) {
      const currentBoundary = cached.lastProcessedSlot ?? cached.startSlot;
      if (
        this.options.allowEarlierAnchorRewind === true &&
        nextAnchor !== undefined &&
        nextAnchor < currentBoundary
      ) {
        // Keep health fail-closed until pollWallet durably rewinds and begins
        // replay. Trading pollers leave this option off.
        this.cursorHydrationPending.add(wallet);
        this.backlogWallets.add(wallet);
        return;
      }
      this.applyCursorHealth(wallet, cached);
      return;
    }
    this.cursorHydrationPending.add(wallet);
    this.hydrateCursorHealth(wallet).catch((error) =>
      log.warn(
        { wallet, error: sanitizeRpcCursorError(error) },
        "RPC fallback cursor health hydration failed",
      ),
    );
  }

  unwatch(wallet: string) {
    this.watched.delete(wallet);
    this.backlogWallets.delete(wallet);
    this.cursorHydrationPending.delete(wallet);
    // Durable cursor intentionally survives unwatch/re-watch cycles.
  }

  health() {
    const unavailableWallets = new Set([...this.backlogWallets, ...this.cursorHydrationPending]);
    return {
      watchedCount: this.watched.size,
      lastPollAt: this.lastPollAt,
      secondsSinceLastPoll: this.lastPollAt
        ? Math.round((Date.now() - this.lastPollAt) / 1000)
        : null,
      lastSuccessAt: this.lastSuccessAt,
      secondsSinceLastSuccess: this.lastSuccessAt
        ? Math.round((Date.now() - this.lastSuccessAt) / 1000)
        : null,
      // The entry gate consumes this conservative count. Cursor hydration is
      // included because coverage is unknown until durable state is loaded.
      backlogWalletCount: unavailableWallets.size,
      detectedBacklogWalletCount: this.backlogWallets.size,
      cursorHydrationPendingCount: this.cursorHydrationPending.size,
      failures: this.failures,
    };
  }

  private async hydrateCursorHealth(wallet: string) {
    if (this.cursorHydrationInFlight.has(wallet)) return;
    this.cursorHydrationInFlight.add(wallet);
    try {
      const cursor = await this.cursorStore.load(wallet);
      if (!this.watched.has(wallet)) return;
      if (!cursor) {
        // Keep the wallet pending until pollWallet creates and successfully
        // establishes its baseline/anchor cursor.
        return;
      }
      // pollWallet may have loaded or advanced this cursor while the startup
      // hydration request was in flight. Never overwrite newer in-memory state
      // with an older response snapshot.
      if (this.cursorCache.has(wallet)) return;
      this.cursorCache.set(wallet, cursor);
      this.applyCursorHealth(wallet, cursor);
    } finally {
      this.cursorHydrationInFlight.delete(wallet);
    }
  }

  private applyCursorHealth(wallet: string, cursor: RpcWalletCursor) {
    this.cursorHydrationPending.delete(wallet);
    if (cursor.backlogDetected) this.backlogWallets.add(wallet);
    else this.backlogWallets.delete(wallet);
  }

  private async poll() {
    if (this.running) return;
    this.running = true;
    this.lastPollAt = Date.now();
    try {
      const entries = Array.from(this.watched.entries());
      const concurrency = Math.max(1, Math.trunc(Number(this.options.pollConcurrency ?? 8)));
      for (let offset = 0; offset < entries.length; offset += concurrency) {
        const batch = entries.slice(offset, offset + concurrency);
        const results = await Promise.allSettled(
          batch.map(([wallet, options]) => this.pollWallet(wallet, options)),
        );
        for (const [index, result] of results.entries()) {
          if (result.status === "fulfilled") continue;
          const wallet = batch[index]?.[0];
          this.failures += 1;
          if (wallet) {
            const newlyBacklogged = !this.backlogWallets.has(wallet);
            this.backlogWallets.add(wallet);
            if (newlyBacklogged) {
              try {
                const cursor = await this.cursorStore.markBacklog(wallet, result.reason);
                this.cursorCache.set(wallet, cursor);
              } catch (cursorError) {
                log.warn(
                  { wallet, error: sanitizeRpcCursorError(cursorError) },
                  "RPC fallback could not persist backlog state",
                );
              }
            }
          }
          log.warn(
            { wallet, error: sanitizeRpcCursorError(result.reason) },
            "RPC fallback wallet poll failed",
          );
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async pollWallet(wallet: string, options: RpcWatchOptions) {
    let pubkey: PublicKey;
    try {
      pubkey = new PublicKey(wallet);
    } catch {
      log.warn({ wallet }, "rpc fallback skipped invalid wallet");
      return;
    }

    let cursor = this.cursorCache.get(wallet) ?? (await this.cursorStore.load(wallet));
    if (cursor) {
      const anchorSlot = positiveSlot(options.anchorSlot);
      const currentBoundary = cursor.lastProcessedSlot ?? cursor.startSlot;
      if (
        this.options.allowEarlierAnchorRewind === true &&
        anchorSlot !== undefined &&
        anchorSlot < currentBoundary &&
        this.cursorStore.rewind
      ) {
        cursor = await this.cursorStore.rewind(wallet, anchorSlot);
        log.warn(
          { wallet, anchorSlot, priorBoundarySlot: currentBoundary },
          "RPC cursor rewound to cover newly discovered earlier custody attribution",
        );
      }
      this.cursorCache.set(wallet, cursor);
      this.applyCursorHealth(wallet, cursor);
    }
    if (!cursor) {
      const anchorSlot = positiveSlot(options.anchorSlot);
      if (anchorSlot === undefined) {
        const head = await rpcReadWithTimeout(
          this.conn.getSignaturesForAddress(pubkey, { limit: 1 }, "confirmed"),
          "signature head",
        );
        cursor = await this.cursorStore.ensure(wallet, head[0]?.slot ?? 0);
        this.cursorCache.set(wallet, cursor);
        if (!this.includeActivationHead) {
          if (head[0]) {
            cursor = await this.cursorStore.advance(
              wallet,
              head[0].signature,
              head[0].slot,
              head[0].blockTime ?? null,
            );
            this.cursorCache.set(wallet, cursor);
          }
          cursor = await this.cursorStore.markSuccess(wallet);
          this.cursorCache.set(wallet, cursor);
          this.applyCursorHealth(wallet, cursor);
          this.cursorSuccessPersistedAt.set(wallet, Date.now());
          this.lastSuccessAt = Date.now();
          this.backlogWallets.delete(wallet);
          log.info({ wallet, headSlot: head[0]?.slot ?? null }, "RPC target cursor baseline ready");
          return;
        }
        log.info(
          { wallet, headSlot: head[0]?.slot ?? null },
          "RPC target activation boundary ready; current head will be decoded",
        );
      }
      cursor = await this.cursorStore.ensure(wallet, anchorSlot);
      this.cursorCache.set(wallet, cursor);
    }

    // A pre-existing durable cursor is always authoritative. The watch anchor
    // only initializes a missing cursor; raising an older cursor to a newer DB
    // state would skip an unprocessed recovery gap.
    const recoveryBoundary = cursor;
    const pages: Awaited<ReturnType<Connection["getSignaturesForAddress"]>>[] = [];
    // Find the trusted lower boundary before releasing any work. The previous
    // 5,000-signature discovery cap could leave a busy wallet permanently
    // backlogged. Once the boundary is found, transaction handling remains
    // bounded to a durable 5,000-signature chunk per poll.
    const paging = {
      pageSize: RPC_SIGNATURE_PAGE_SIZE,
      maxPages: RPC_SIGNATURE_MAX_PAGES,
    };
    while (true) {
      const request = planNextRpcSignaturePage(pages, recoveryBoundary, paging);
      if (!request) break;
      const page = await rpcReadWithTimeout(
        this.conn.getSignaturesForAddress(pubkey, request, "confirmed"),
        "signature page",
      );
      pages.push(page);
      const plan = planRpcSignaturePages(pages, recoveryBoundary, paging);
      if (plan.complete || plan.backlogDetected) break;
    }

    const plan = planRpcSignaturePages(pages, recoveryBoundary, paging);
    if (plan.backlogDetected || !plan.complete) {
      this.backlogWallets.add(wallet);
      cursor = await this.cursorStore.markBacklog(
        wallet,
        plan.error ?? "RPC signature pagination backlog",
      );
      this.cursorCache.set(wallet, cursor);
      this.applyCursorHealth(wallet, cursor);
      return;
    }

    const recovery = takeOldestRpcRecoveryChunk(plan, RPC_RECOVERY_CHUNK_SIZE);

    for (let offset = 0; offset < recovery.signatures.length; offset += 50) {
      const signatureBatch = recovery.signatures.slice(offset, offset + 50);
      const txs = await rpcReadWithTimeout(
        this.conn.getParsedTransactions(
          signatureBatch.map((sig) => sig.signature),
          { commitment: "confirmed", maxSupportedTransactionVersion: 0 },
        ),
        "parsed transaction batch",
      );
      for (const [index, sig] of signatureBatch.entries()) {
        const tx = txs[index];
        if (!tx) {
          this.backlogWallets.add(wallet);
          cursor = await this.cursorStore.markBacklog(
            wallet,
            "RPC transaction was temporarily unavailable",
          );
          this.cursorCache.set(wallet, cursor);
          this.applyCursorHealth(wallet, cursor);
          return;
        }
        const decoded = decodeParsedTransactionWithCoverage(wallet, tx as any);
        const events = decoded.events;
        for (const event of events) {
          event.source = "rpc";
          event.delivery = "catchup";
          event.observedAtMs = Date.now();
          log.info(
            {
              kind: event.kind,
              wallet: event.kind === "swap" ? event.wallet : event.from,
              side: event.kind === "swap" ? event.side : undefined,
              mint: event.tokenMint,
              ageMs: event.blockTimeMs ? Math.max(0, Date.now() - event.blockTimeMs) : null,
            },
            "RPC fallback feed event",
          );
          await this.onEvent(event);
        }
        if (this.options.onUnresolvedOutflow) {
          for (const event of decoded.unresolvedOutflows) {
            event.source = "rpc";
            event.delivery = "catchup";
            event.observedAtMs = Date.now();
            log.warn(
              {
                wallet: event.wallet,
                mint: event.tokenMint,
                ageMs: event.blockTimeMs ? Math.max(0, Date.now() - event.blockTimeMs) : null,
                reason: event.reason,
              },
              "RPC custody outflow could not be classified as a verified sell or transfer",
            );
            await this.options.onUnresolvedOutflow(event);
          }
        }
        cursor = await this.cursorStore.advance(
          wallet,
          sig.signature,
          sig.slot,
          sig.blockTime ?? null,
        );
        this.cursorCache.set(wallet, cursor);
      }
    }
    if (recovery.hasMore) {
      this.backlogWallets.add(wallet);
      cursor = await this.cursorStore.markBacklog(
        wallet,
        new Error("RPC recovery backlog remains after safe chunk"),
      );
      this.cursorCache.set(wallet, cursor);
      this.applyCursorHealth(wallet, cursor);
      log.warn(
        { wallet, processed: recovery.signatures.length, remaining: recovery.remainingCount },
        "RPC fallback advanced one durable recovery chunk",
      );
      return;
    }
    const now = Date.now();
    const shouldPersistSuccess =
      cursor.backlogDetected ||
      recovery.signatures.length > 0 ||
      now - (this.cursorSuccessPersistedAt.get(wallet) ?? 0) >= 5 * 60_000;
    if (shouldPersistSuccess) {
      cursor = await this.cursorStore.markSuccess(wallet);
      this.cursorCache.set(wallet, cursor);
      this.applyCursorHealth(wallet, cursor);
      this.cursorSuccessPersistedAt.set(wallet, now);
    }
    this.lastSuccessAt = Date.now();
    this.cursorHydrationPending.delete(wallet);
    this.backlogWallets.delete(wallet);
  }
}

async function rpcReadWithTimeout<T>(request: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`RPC ${label} timed out`)), RPC_READ_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function positiveSlot(value: number | undefined): number | undefined {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value : undefined;
}

export function decodeParsedTransaction(wallet: string, tx: any): FeedEvent[] {
  return decodeParsedTransactionWithCoverage(wallet, tx).events;
}

export function decodeParsedTransactionWithCoverage(
  wallet: string,
  tx: any,
): { events: FeedEvent[]; unresolvedOutflows: UnresolvedOutflowEvent[] } {
  const out: FeedEvent[] = [];
  const unresolvedOutflows: UnresolvedOutflowEvent[] = [];
  const meta = tx?.meta;
  if (!meta || (meta.err !== null && meta.err !== undefined)) {
    return { events: out, unresolvedOutflows };
  }

  const signature = String(tx?.transaction?.signatures?.[0] ?? "");
  const slot = Number(tx?.slot ?? 0);
  const observedAtMs = Date.now();
  const parsedBlockTime = Number(tx?.blockTime);
  const blockTimeMs =
    Number.isFinite(parsedBlockTime) && parsedBlockTime > 0 ? parsedBlockTime * 1000 : undefined;
  const eventTimeMs = blockTimeMs ?? observedAtMs;
  const message = tx?.transaction?.message;
  const accountKeyEntries = message?.accountKeys ?? [];
  const accountKeys = accountKeyEntries.map(
    (key: any) => key?.pubkey?.toBase58?.() ?? String(key?.pubkey ?? key),
  );
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
  const hasSwapSignal =
    hasVerifiedSwapSignal(meta?.logMessages ?? []) ||
    hasHostileExecutorSignal(meta?.logMessages ?? []);
  const hasSolMove = Math.abs(solDelta) > 0.0005;
  const positiveOutputRows = rows.filter((row) => tokenDeltaSign(row) > 0);
  const walletSigned = signerKeys.has(wallet);
  const walletCanAuthorizeSwap = signerKeys.size === 1 && signerKeys.has(wallet);
  const negativeWalletMints = new Set(
    rows.filter((row) => tokenDeltaSign(row) < 0).map((row) => row.mint),
  );
  const globalOutputMints = new Set(positiveOutputRows.map((row) => row.mint));
  for (const recipientRow of recipientBalanceRows(meta, wallet, accountKeys)) {
    if (tokenDeltaSign(recipientRow) > 0 && !negativeWalletMints.has(recipientRow.tokenMint)) {
      globalOutputMints.add(recipientRow.tokenMint);
    }
  }
  const forwardedBuy = inferBuyForwardedOut(
    meta,
    wallet,
    accountKeys,
    attributionRows,
    solSpend,
    hasSwapSignal,
    walletCanAuthorizeSwap,
    negativeWalletMints,
  );

  for (const row of rows) {
    const sign = tokenDeltaSign(row);
    if (sign === 0) continue;
    const delta = tokenDelta(row);
    const side: "buy" | "sell" = sign > 0 ? "buy" : "sell";
    if (side === "buy" && forwardedBuy?.tokenMint === row.mint) continue;
    const sellAttribution =
      side === "sell"
        ? attributeVerifiedSell(
            attributionRows,
            row.mint,
            nativeSolDelta,
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
      if (side === "buy" && !hasSwapSignal) {
        log.info(
          { wallet, signature, mint: row.mint },
          "positive token delta skipped — no explicit swap instruction",
        );
        continue;
      }
      if (
        hasSolMove &&
        !hasSwapSignal &&
        ((side === "buy" && solDelta > 0) || (side === "sell" && solDelta < 0))
      )
        continue;
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
          { wallet, signature, mint: row.mint },
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
        tokenBalanceBefore: row.pre,
        tokenBalanceAfter: row.post,
        tokenBalanceBeforeRaw: row.rawExact ? row.preRaw.toString() : undefined,
        tokenBalanceAfterRaw: row.rawExact ? row.postRaw.toString() : undefined,
        decimals: row.decimals,
        amountUsd: verifiedSpend?.amountUsd,
        spentToken: verifiedSpend?.spentToken,
        solSpend: verifiedSpend?.solSpend,
        solDelta,
        slot,
        txSig: signature,
        timestampMs: eventTimeMs,
        isPumpFun: row.mint.endsWith("pump"),
        verifiedSwap: hasSwapSignal,
        sellAttribution,
        blockTimeMs,
        observedAtMs,
      });
      continue;
    }

    if (sign < 0) {
      const recipients = findTransferRecipients(
        meta,
        row.mint,
        wallet,
        Math.abs(delta),
        accountKeys,
      );
      if (recipients.length > 0) {
        const batchRecipients = recipients
          .map((recipient) => ({
            wallet: recipient.owner,
            amountTokens: recipient.amount,
            amountRaw: recipient.amountRaw,
            recipientPreAmount: recipient.pre,
            recipientPostAmount: recipient.post,
            recipientPreRaw: recipient.preRaw,
            recipientPostRaw: recipient.postRaw,
          }))
          .sort((a, b) => a.wallet.localeCompare(b.wallet));
        const first = batchRecipients[0]!;
        out.push({
          kind: "transfer",
          from: wallet,
          to: first.wallet,
          tokenMint: row.mint,
          amountTokens: batchRecipients.reduce((sum, recipient) => sum + recipient.amountTokens, 0),
          decimals: row.decimals,
          senderPreAmount: row.pre,
          senderPostAmount: row.post,
          senderPreRaw: row.rawExact ? row.preRaw.toString() : undefined,
          senderPostRaw: row.rawExact ? row.postRaw.toString() : undefined,
          recipientPreAmount: first.recipientPreAmount,
          recipients: batchRecipients,
          slot,
          txSig: signature,
          timestampMs: eventTimeMs,
          blockTimeMs,
          observedAtMs,
        });
      }
    }
  }

  const attributedNegativeMints = new Set(
    out.flatMap((event) => {
      if (event.kind === "transfer" && event.from === wallet) return [event.tokenMint];
      if (event.kind === "swap" && event.wallet === wallet && event.side === "sell") {
        return [event.tokenMint];
      }
      return [];
    }),
  );
  for (const row of rows) {
    if (tokenDeltaSign(row) >= 0 || attributedNegativeMints.has(row.mint)) continue;
    const deltaRaw = rawTokenDelta(row);
    unresolvedOutflows.push({
      kind: "unresolved_outflow",
      wallet,
      tokenMint: row.mint,
      amountTokens: Math.abs(tokenDelta(row)),
      amountRaw: deltaRaw !== undefined ? (-deltaRaw).toString() : undefined,
      preAmount: row.pre,
      postAmount: row.post,
      preRaw: row.rawExact ? row.preRaw.toString() : undefined,
      postRaw: row.rawExact ? row.postRaw.toString() : undefined,
      decimals: row.decimals,
      slot,
      txSig: signature,
      timestampMs: eventTimeMs,
      blockTimeMs,
      observedAtMs,
      reason: "negative_token_delta_not_attributed",
    });
  }

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
        { wallet, signature, mint: inferredBuy.tokenMint },
        "inferred target buy skipped — input/output attribution is ambiguous",
      );
      return { events: out, unresolvedOutflows };
    }
    log.warn(
      {
        wallet,
        signature,
        mint: inferredBuy.tokenMint,
        amountTokens: inferredBuy.amountTokens,
        recipients: inferredBuy.recipients.map((r) => ({
          wallet: r.owner,
          amountTokens: r.amountTokens,
        })),
        nativeSolDelta: solDelta,
        hasSwapSignal,
      },
      "rpc fallback inferred target buy from same-tx recipient balances",
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
      tokenBalanceBefore: inferredBuy.chainPreAmount,
      tokenBalanceAfter: inferredBuy.chainPostAmount,
      tokenBalanceBeforeRaw: inferredBuy.chainPreRaw,
      tokenBalanceAfterRaw: inferredBuy.chainPostRaw,
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
      txSig: signature,
      timestampMs: eventTimeMs,
      isPumpFun: inferredBuy.tokenMint.endsWith("pump"),
      verifiedSwap: hasSwapSignal,
      blockTimeMs,
      observedAtMs,
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
      txSig: signature,
      timestampMs: eventTimeMs,
      blockTimeMs,
      observedAtMs,
    });
  }

  return { events: out, unresolvedOutflows };
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
      row[field] += Number(
        balance?.uiTokenAmount?.uiAmountString ?? balance?.uiTokenAmount?.uiAmount ?? 0,
      );
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
  preRaw: bigint;
  postRaw: bigint;
  rawExact: boolean;
};

function recipientBalanceRows(
  meta: any,
  wallet: string,
  accountKeys: string[],
): RecipientBalanceRow[] {
  const ownerMintRows = new Map<string, RecipientBalanceRow>();
  const ingestRecipientBalances = (balances: any[], field: "pre" | "post") => {
    for (const balance of balances ?? []) {
      const owner = resolveTokenOwner(balance, balance?.mint, accountKeys, wallet);
      if (!owner || !balance?.mint || balance.mint === WSOL_MINT || owner === wallet) continue;
      const key = `${owner}::${balance.mint}`;
      const row = ownerMintRows.get(key) ?? {
        owner,
        tokenMint: balance.mint,
        pre: 0,
        post: 0,
        decimals: Number(balance?.uiTokenAmount?.decimals ?? 0),
        preRaw: 0n,
        postRaw: 0n,
        rawExact: true,
      };
      row[field] += Number(
        balance?.uiTokenAmount?.uiAmountString ?? balance?.uiTokenAmount?.uiAmount ?? 0,
      );
      const raw = parseRawTokenAmount(balance?.uiTokenAmount?.amount);
      if (raw === undefined) row.rawExact = false;
      else if (field === "pre") row.preRaw += raw;
      else row.postRaw += raw;
      row.decimals = Number(balance?.uiTokenAmount?.decimals ?? row.decimals);
      ownerMintRows.set(key, row);
    }
  };
  ingestRecipientBalances(meta?.preTokenBalances ?? [], "pre");
  ingestRecipientBalances(meta?.postTokenBalances ?? [], "post");
  return Array.from(ownerMintRows.values());
}

function inferBuyForwardedOut(
  meta: any,
  wallet: string,
  accountKeys: string[],
  walletRows: WalletTokenDelta[],
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
  if (!walletCanAuthorizeSwap || !hasSwapSignal || !hasWalletSpecificSpend(walletRows, solSpend))
    return null;

  const candidateMints = new Set(
    walletRows
      .filter((row) => row.mint !== WSOL_MINT && tokenDeltaSign(row) > 0)
      .map((row) => row.mint),
  );
  const rows = new Map<
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
  for (const balance of recipientBalanceRows(meta, wallet, accountKeys)) {
    if (!isOnCurveWallet(balance.owner)) continue;
    if (negativeWalletMints.has(balance.tokenMint) || tokenDeltaSign(balance) <= 0) continue;
    candidateMints.add(balance.tokenMint);
    const delta = tokenDelta(balance);
    const rawDelta = rawTokenDelta(balance);
    const row: {
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
    } = rows.get(balance.tokenMint) ?? {
      tokenMint: balance.tokenMint,
      forwardedAmountTokens: 0,
      forwardedAmountRaw: 0n,
      rawExact: true,
      decimals: balance.decimals,
      recipients: [],
    };
    row.forwardedAmountTokens += delta;
    if (rawDelta === undefined) {
      row.rawExact = false;
      row.forwardedAmountRaw = undefined;
    } else if (row.rawExact) {
      row.forwardedAmountRaw = (row.forwardedAmountRaw ?? 0n) + rawDelta;
    }
    row.decimals = balance.decimals;
    row.recipients.push({
      owner: balance.owner,
      amountTokens: delta,
      amountRaw: balance.rawExact ? (balance.postRaw - balance.preRaw).toString() : undefined,
      pre: balance.pre,
      post: balance.post,
      preRaw: balance.rawExact ? balance.preRaw.toString() : undefined,
      postRaw: balance.rawExact ? balance.postRaw.toString() : undefined,
    });
    rows.set(balance.tokenMint, row);
  }

  if (candidateMints.size !== 1) return null;
  const tokenMint = Array.from(candidateMints)[0]!;
  const forwarded = rows.get(tokenMint);
  if (!forwarded || forwarded.forwardedAmountTokens <= 0 || forwarded.recipients.length === 0)
    return null;

  const retained = walletRows.find((row) => row.mint === tokenMint);
  const retainedAmountTokens = retained && tokenDeltaSign(retained) > 0 ? tokenDelta(retained) : 0;
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

function resolveTokenOwner(
  balance: any,
  mint: string | undefined,
  accountKeys: string[],
  watchedWallet: string,
): string {
  if (balance?.owner) return String(balance.owner);
  const accountIndex = Number(balance?.accountIndex);
  const tokenAccount = Number.isFinite(accountIndex) ? accountKeys[accountIndex] : "";
  if (!tokenAccount || !mint) return "";
  try {
    const ata = getAssociatedTokenAddressSync(
      new PublicKey(mint),
      new PublicKey(watchedWallet),
      true,
    ).toBase58();
    if (ata === tokenAccount) return watchedWallet;
  } catch {
    return tokenAccount;
  }
  return tokenAccount;
}

function findTransferRecipients(
  meta: any,
  mint: string,
  sender: string,
  amount: number,
  accountKeys: string[],
): Array<{
  owner: string;
  pre: number;
  post: number;
  amount: number;
  amountRaw?: string;
  preRaw?: string;
  postRaw?: string;
}> {
  const senderRows = ownerMintRows(meta, sender, accountKeys).filter(
    (row) => row.mint === mint && tokenDeltaSign(row) < 0,
  );
  if (senderRows.length !== 1) return [];
  const peerRows = recipientBalanceRows(meta, sender, accountKeys).filter(
    (row) => row.tokenMint === mint,
  );
  // Do not attribute transaction-wide recipients to this sender when another
  // owner also supplied the same mint. Parsed RPC payloads can contain several
  // independent transfers, so conservation alone is not enough in that case.
  if (peerRows.some((row) => tokenDeltaSign(row) < 0)) return [];
  const recipients = peerRows
    .filter((row) => row.tokenMint === mint && tokenDeltaSign(row) > 0)
    .map((row) => ({
      owner: row.owner,
      pre: row.pre,
      post: row.post,
      amount: tokenDelta(row),
      amountRaw: row.rawExact ? (row.postRaw - row.preRaw).toString() : undefined,
      preRaw: row.rawExact ? row.preRaw.toString() : undefined,
      postRaw: row.rawExact ? row.postRaw.toString() : undefined,
    }));
  const received = recipients.reduce((sum, row) => sum + row.amount, 0);
  const senderRawDelta = rawTokenDelta(senderRows[0]!);
  const rawConserves =
    senderRawDelta !== undefined && recipients.every((row) => row.amountRaw !== undefined)
      ? recipients.reduce((sum, row) => sum + BigInt(row.amountRaw!), 0n) === -senderRawDelta
      : null;
  if (
    recipients.length === 0 ||
    (rawConserves === null
      ? Math.abs(received - amount) / Math.max(amount, 1e-9) >= 0.05
      : !rawConserves)
  ) {
    return [];
  }
  return recipients;
}
