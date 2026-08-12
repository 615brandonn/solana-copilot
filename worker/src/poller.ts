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
  tokenDelta,
  WSOL_MINT,
  type WalletTokenDelta,
} from "./swap-attribution.js";
import { hasVerifiedSwapSignal } from "./swap-signal.js";
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

export type PollerHandler = (event: FeedEvent) => Promise<void> | void;

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
  ) {}

  start(initialWallets: string[]) {
    initialWallets.forEach((wallet) => this.watch(wallet));
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.poll().catch((error) =>
        log.warn({ error: sanitizeRpcCursorError(error) }, "rpc fallback poll failed"));
    }, this.intervalMs);
    this.poll().catch((error) =>
      log.warn({ error: sanitizeRpcCursorError(error) }, "rpc fallback initial poll failed"));
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
    this.watched.set(wallet, {
      anchorSlot:
        currentAnchor !== undefined && nextAnchor !== undefined
          ? Math.min(currentAnchor, nextAnchor)
          : currentAnchor ?? nextAnchor,
    });
    const cached = this.cursorCache.get(wallet);
    if (cached) {
      this.applyCursorHealth(wallet, cached);
      return;
    }
    this.cursorHydrationPending.add(wallet);
    this.hydrateCursorHealth(wallet).catch((error) =>
      log.warn(
        { wallet, error: sanitizeRpcCursorError(error) },
        "RPC fallback cursor health hydration failed",
      ));
  }

  unwatch(wallet: string) {
    this.watched.delete(wallet);
    this.backlogWallets.delete(wallet);
    this.cursorHydrationPending.delete(wallet);
    // Durable cursor intentionally survives unwatch/re-watch cycles.
  }

  health() {
    const unavailableWallets = new Set([
      ...this.backlogWallets,
      ...this.cursorHydrationPending,
    ]);
    return {
      watchedCount: this.watched.size,
      lastPollAt: this.lastPollAt,
      secondsSinceLastPoll: this.lastPollAt ? Math.round((Date.now() - this.lastPollAt) / 1000) : null,
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
      for (let offset = 0; offset < entries.length; offset += 8) {
        const batch = entries.slice(offset, offset + 8);
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

    let cursor = this.cursorCache.get(wallet) ?? await this.cursorStore.load(wallet);
    if (cursor) {
      this.cursorCache.set(wallet, cursor);
      this.applyCursorHealth(wallet, cursor);
    }
    if (!cursor) {
      const anchorSlot = positiveSlot(options.anchorSlot);
      if (anchorSlot === undefined) {
        const head = await this.conn.getSignaturesForAddress(pubkey, { limit: 1 }, "confirmed");
        cursor = await this.cursorStore.ensure(wallet, head[0]?.slot ?? 0);
        this.cursorCache.set(wallet, cursor);
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
      cursor = await this.cursorStore.ensure(wallet, anchorSlot);
      this.cursorCache.set(wallet, cursor);
    }

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
      const request = planNextRpcSignaturePage(pages, cursor, paging);
      if (!request) break;
      const page = await this.conn.getSignaturesForAddress(pubkey, request, "confirmed");
      pages.push(page);
      const plan = planRpcSignaturePages(pages, cursor, paging);
      if (plan.complete || plan.backlogDetected) break;
    }

    const plan = planRpcSignaturePages(pages, cursor, paging);
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
      const txs = await this.conn.getParsedTransactions(
        signatureBatch.map((sig) => sig.signature),
        { commitment: "confirmed", maxSupportedTransactionVersion: 0 },
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
        const events = decodeParsedTransaction(wallet, tx as any);
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

function positiveSlot(value: number | undefined): number | undefined {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value : undefined;
}

export function decodeParsedTransaction(wallet: string, tx: any): FeedEvent[] {
  const out: FeedEvent[] = [];
  const meta = tx?.meta;
  if (!meta || meta.err !== null && meta.err !== undefined) return out;

  const signature = String(tx?.transaction?.signatures?.[0] ?? "");
  const slot = Number(tx?.slot ?? 0);
  const observedAtMs = Date.now();
  const parsedBlockTime = Number(tx?.blockTime);
  const blockTimeMs = Number.isFinite(parsedBlockTime) && parsedBlockTime > 0
    ? parsedBlockTime * 1000
    : undefined;
  const eventTimeMs = blockTimeMs ?? observedAtMs;
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
  const walletSigned = signerKeys.has(wallet);
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
    const side: "buy" | "sell" = delta > 0 ? "buy" : "sell";
    const sellAttribution = side === "sell"
      ? attributeVerifiedSell(
          attributionRows,
          row.mint,
          nativeSolDelta,
          hasSwapSignal,
          walletSigned,
          signerKeys.size,
        )
      : undefined;
    const verifiedSwapForWallet = side === "buy"
      ? walletCanAuthorizeSwap && (hasSolMove || hasSwapSignal)
      : Boolean(sellAttribution?.verified);
    if (verifiedSwapForWallet) {
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
        timestampMs: eventTimeMs,
        isPumpFun: row.mint.endsWith("pump"),
        verifiedSwap: hasSwapSignal,
        sellAttribution,
        blockTimeMs,
        observedAtMs,
      });
      if (side === "buy") emittedBuyMints.add(row.mint);
      continue;
    }

    if (delta < 0) {
      const recipients = findTransferRecipients(meta, row.mint, wallet, Math.abs(delta), accountKeys);
      if (recipients.length > 0) {
        const batchRecipients = recipients
          .map((recipient) => ({
            wallet: recipient.owner,
            amountTokens: recipient.amount,
            recipientPreAmount: recipient.pre,
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
      }))
      .sort((a, b) => a.wallet.localeCompare(b.wallet));
    const first = recipients[0]!;
    out.push({
      kind: "transfer",
      from: wallet,
      to: first.wallet,
      tokenMint: inferredBuy.tokenMint,
      amountTokens: inferredBuy.amountTokens,
      decimals: inferredBuy.decimals,
      recipientPreAmount: first.recipientPreAmount,
      recipients,
      slot,
      txSig: signature,
      timestampMs: eventTimeMs,
      blockTimeMs,
      observedAtMs,
    });
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
      if (!owner || !balance?.mint || balance.mint === WSOL_MINT || owner === wallet) continue;
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
): { tokenMint: string; amountTokens: number; decimals: number; recipients: Array<{ owner: string; amountTokens: number; pre: number }> } | null {
  if (!walletCanAuthorizeSwap || !hasSwapSignal || !hasWalletSpecificSpend(walletRows, solSpend)) return null;

  const rows = new Map<string, { tokenMint: string; amountTokens: number; decimals: number; recipients: Array<{ owner: string; amountTokens: number; pre: number }> }>();
  for (const balance of recipientBalanceRows(meta, wallet, accountKeys)) {
    if (!isOnCurveWallet(balance.owner)) continue;
    if (emittedBuyMints.has(balance.tokenMint) || negativeWalletMints.has(balance.tokenMint)) continue;
    const delta = balance.post - balance.pre;
    if (delta <= 1e-12) continue;
    const row: {
      tokenMint: string;
      amountTokens: number;
      decimals: number;
      recipients: Array<{ owner: string; amountTokens: number; pre: number }>;
    } = rows.get(balance.tokenMint) ?? {
      tokenMint: balance.tokenMint,
      amountTokens: 0,
      decimals: balance.decimals,
      recipients: [],
    };
    row.amountTokens += delta;
    row.decimals = balance.decimals;
    row.recipients.push({ owner: balance.owner, amountTokens: delta, pre: balance.pre });
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

function findTransferRecipients(
  meta: any,
  mint: string,
  sender: string,
  amount: number,
  accountKeys: string[],
): Array<{ owner: string; pre: number; amount: number }> {
  const senderRows = ownerMintRows(meta, sender, accountKeys).filter(
    (row) => row.mint === mint && tokenDelta(row) < -1e-12,
  );
  if (senderRows.length !== 1) return [];
  const peerRows = recipientBalanceRows(meta, sender, accountKeys)
    .filter((row) => row.tokenMint === mint);
  // Do not attribute transaction-wide recipients to this sender when another
  // owner also supplied the same mint. Parsed RPC payloads can contain several
  // independent transfers, so conservation alone is not enough in that case.
  if (peerRows.some((row) => row.post - row.pre < -1e-12)) return [];
  const recipients = peerRows
    .filter((row) => row.tokenMint === mint && row.post - row.pre > 1e-12)
    .map((row) => ({ owner: row.owner, pre: row.pre, amount: row.post - row.pre }));
  const received = recipients.reduce((sum, row) => sum + row.amount, 0);
  if (
    recipients.length === 0 ||
    Math.abs(received - amount) / Math.max(amount, 1e-9) >= 0.05
  ) {
    return [];
  }
  return recipients;
}
