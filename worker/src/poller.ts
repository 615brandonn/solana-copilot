import { createHash } from "node:crypto";
import { Connection, PublicKey, type ConfirmedSignatureInfo } from "@solana/web3.js";
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
import { sanitizeRpcCursorError, type RpcCursorStore, type RpcWalletCursor } from "./rpc-cursor.js";

const log = pino({ level: env.LOG_LEVEL });
const RPC_SIGNATURE_PAGE_SIZE = 1_000;
const RPC_SIGNATURE_MAX_PAGES = 1_000;
const RPC_RECOVERY_CHUNK_SIZE = 5_000;
const RPC_READ_TIMEOUT_MS = 15_000;
const MAX_STICKY_RECOVERY_FAILURES = 3;

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
  /**
   * Maximum wallets visited by one timer turn. A rotating slice prevents one
   * large custody sweep from blocking fresher wallets for hours.
   */
  maxWalletsPerPoll?: number;
  /** Defer pre-start one-row cursor reads so startup can bulk hydrate them. */
  deferInitialCursorHydration?: boolean;
  /** Maximum lanes reserved-first for historical recovery. Defaults to all lanes. */
  recoveryConcurrency?: number;
  /** Signature-history pages discovered per wallet turn. Defaults to the full safe cap. */
  signaturePagesPerTurn?: number;
  /** Parsed signatures applied per wallet turn. Defaults to 5,000. */
  recoveryChunkSize?: number;
};

export type RpcWatchOptions = {
  anchorSlot?: number;
};

type RpcSignatureRequest = {
  limit: number;
  before?: string;
};

type CompactSignatureInfo = Pick<ConfirmedSignatureInfo, "signature" | "slot" | "blockTime">;

type SignaturePageDescriptor = {
  request: RpcSignatureRequest;
  entryCount: number;
  digest: string;
  candidateMask: string;
  candidateCount: number;
};

type ActiveRecoveryPage = {
  pageIndex: number;
  entries: CompactSignatureInfo[];
  candidateIndexesOldestFirst: number[];
  offset: number;
};

type SignatureRecoveryState = {
  boundarySignature: string | null;
  boundarySlot: number;
  descriptors: SignaturePageDescriptor[];
  pageTails: Set<string>;
  firstPage: CompactSignatureInfo[] | null;
  priorSlot: number;
  oldestCandidateSlot?: number;
  nextBefore?: string;
  discoveryComplete: boolean;
  remainingCount: number;
  replayPageIndex: number;
  activePage?: ActiveRecoveryPage;
};

export class RpcBackfillPoller {
  private watched = new Map<string, RpcWatchOptions>();
  private watchedEntriesCache?: [string, RpcWatchOptions][];
  private timer?: NodeJS.Timeout;
  private lastPollAt?: number;
  private lastSuccessAt?: number;
  private lastRecoveryProgressAt?: number;
  private processedSignatureCount = 0;
  private backlogWallets = new Set<string>();
  // A newly watched wallet is fail-closed until its durable cursor has been
  // loaded. This prevents a persisted backlog from briefly disappearing from
  // health after a worker restart.
  private cursorHydrationPending = new Set<string>();
  private cursorHydrationInFlight = new Set<string>();
  private failures = 0;
  private cursorCache = new Map<string, RpcWalletCursor>();
  private cursorSuccessPersistedAt = new Map<string, number>();
  private pollOffset = 0;
  private recoveryPollOffset = 0;
  private walletsInFlight = new Set<string>();
  private walletFailureCounts = new Map<string, number>();
  private walletRetryAt = new Map<string, number>();
  private walletLaneInFlight = new Map<string, "live" | "recovery">();
  /**
   * Only sticky recovery owners may retain signature history between turns.
   * Each state stores O(page count) descriptors plus at most two compact RPC
   * pages, rather than every signature object and a second flattened queue.
   */
  private recoveryOwners = new Set<string>();
  private signatureRecoveries = new Map<string, SignatureRecoveryState>();

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
    // Preserve the earliest explicit activation floor. A target may have been
    // watched without an anchor before a recovered journey proves that older
    // history must be replayed; dropping that later anchor would skip it.
    const mergedAnchor =
      currentAnchor !== undefined && nextAnchor !== undefined
        ? Math.min(currentAnchor, nextAnchor)
        : (currentAnchor ?? nextAnchor);
    if (!current || currentAnchor !== mergedAnchor) {
      this.watched.set(wallet, { anchorSlot: mergedAnchor });
      this.watchedEntriesCache = undefined;
    }
    const cached = this.cursorCache.get(wallet);
    if (cached) {
      if (
        this.options.allowEarlierAnchorRewind === true &&
        nextAnchor !== undefined &&
        nextAnchor < cached.startSlot
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
    if (this.options.deferInitialCursorHydration === true && !this.timer) return;
    this.hydrateCursorHealth(wallet).catch((error) =>
      log.warn(
        { wallet, error: sanitizeRpcCursorError(error) },
        "RPC fallback cursor health hydration failed",
      ),
    );
  }

  unwatch(wallet: string) {
    if (this.watched.delete(wallet)) this.watchedEntriesCache = undefined;
    this.backlogWallets.delete(wallet);
    this.cursorHydrationPending.delete(wallet);
    this.walletFailureCounts.delete(wallet);
    this.walletRetryAt.delete(wallet);
    this.cursorCache.delete(wallet);
    this.cursorSuccessPersistedAt.delete(wallet);
    this.releaseRecoveryOwnership(wallet, true);
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
      lastRecoveryProgressAt: this.lastRecoveryProgressAt,
      processedSignatureCount: this.processedSignatureCount,
      inFlightWalletCount: this.walletsInFlight.size,
      recoveryOwnerCount: this.recoveryOwners.size,
      retainedRecoveryWalletCount: this.signatureRecoveries.size,
      failures: this.failures,
    };
  }

  /**
   * Hydrates the current watch set in bounded database batches. Custody calls
   * this before starting its large polling set so health and recovery do not
   * depend on thousands of simultaneous one-row Supabase requests.
   */
  async hydrateWatchedCursors(): Promise<void> {
    const wallets = Array.from(this.cursorHydrationPending).filter((wallet) =>
      this.watched.has(wallet),
    );
    if (wallets.length === 0) return;
    if (this.cursorStore.loadMany) {
      const loaded = await this.cursorStore.loadMany(wallets);
      for (const [wallet, cursor] of loaded) {
        if (!this.watched.has(wallet)) continue;
        this.cursorCache.set(wallet, cursor);
        this.applyCursorHealth(wallet, cursor);
      }
      return;
    }
    for (let offset = 0; offset < wallets.length; offset += 16) {
      await Promise.all(
        wallets.slice(offset, offset + 16).map((wallet) => this.hydrateCursorHealth(wallet)),
      );
    }
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
    const anchorSlot = positiveSlot(this.watched.get(wallet)?.anchorSlot);
    if (
      this.options.allowEarlierAnchorRewind === true &&
      anchorSlot !== undefined &&
      anchorSlot < cursor.startSlot
    ) {
      this.cursorHydrationPending.add(wallet);
      this.backlogWallets.add(wallet);
      return;
    }
    this.cursorHydrationPending.delete(wallet);
    if (cursor.backlogDetected) this.backlogWallets.add(wallet);
    else this.backlogWallets.delete(wallet);
  }

  private isRecoveryWallet(wallet: string): boolean {
    return (
      this.backlogWallets.has(wallet) ||
      this.cursorHydrationPending.has(wallet) ||
      this.signatureRecoveries.has(wallet)
    );
  }

  private recoveryConcurrency(): number {
    const concurrency = Math.max(1, Math.trunc(Number(this.options.pollConcurrency ?? 8)));
    const configured = Math.trunc(Number(this.options.recoveryConcurrency ?? concurrency));
    return Math.max(1, Math.min(concurrency, configured || 1));
  }

  private acquireRecoveryOwnership(wallet: string): boolean {
    if (this.recoveryOwners.has(wallet)) return true;
    if (this.recoveryOwners.size >= this.recoveryConcurrency()) return false;
    this.recoveryOwners.add(wallet);
    return true;
  }

  private releaseRecoveryOwnership(wallet: string, discardState: boolean) {
    this.recoveryOwners.delete(wallet);
    if (discardState) this.signatureRecoveries.delete(wallet);
  }

  private watchedEntries(): [string, RpcWatchOptions][] {
    if (!this.watchedEntriesCache) {
      this.watchedEntriesCache = Array.from(this.watched.entries());
    }
    return this.watchedEntriesCache;
  }

  private async poll() {
    this.lastPollAt = Date.now();
    const allEntries = this.watchedEntries();
    if (allEntries.length === 0) return;
    const concurrency = Math.max(1, Math.trunc(Number(this.options.pollConcurrency ?? 8)));
    const available = Math.max(0, concurrency - this.walletsInFlight.size);
    if (available === 0) return;
    const configuredLimit = Math.trunc(Number(this.options.maxWalletsPerPoll ?? available));
    const launchLimit = Math.max(1, Math.min(available, configuredLimit || 1));
    const now = Date.now();
    const recoveryConcurrency = this.recoveryConcurrency();
    let recoveryInFlight = Array.from(this.walletLaneInFlight.values()).filter(
      (lane) => lane === "recovery",
    ).length;
    let launched = 0;

    const launch = (wallet: string, options: RpcWatchOptions, lane: "live" | "recovery") => {
      launched += 1;
      this.walletsInFlight.add(wallet);
      if (lane === "recovery") recoveryInFlight += 1;
      this.walletLaneInFlight.set(wallet, lane);
      void this.runWalletPoll(wallet, options);
    };

    // Drop owners that completed or were unwatched outside the normal lane
    // completion path. A productive owner otherwise remains sticky until its
    // trusted boundary and replay queue are fully drained.
    for (const wallet of this.recoveryOwners) {
      if (!this.watched.has(wallet) || !this.isRecoveryWallet(wallet)) {
        this.releaseRecoveryOwnership(wallet, !this.watched.has(wallet));
      }
    }

    // Fill empty sticky slots using a separate round-robin. This full watch-set
    // scan happens only when an owner slot opens, not every 750ms while deep
    // recovery is active.
    const recoveryStart = this.recoveryPollOffset % allEntries.length;
    let recoveryScanned = 0;
    while (recoveryScanned < allEntries.length && this.recoveryOwners.size < recoveryConcurrency) {
      const entryIndex = (recoveryStart + recoveryScanned) % allEntries.length;
      recoveryScanned += 1;
      const entry = allEntries[entryIndex];
      if (!entry) continue;
      const [wallet] = entry;
      if (!this.isRecoveryWallet(wallet)) continue;
      if ((this.walletRetryAt.get(wallet) ?? 0) > now) continue;
      if (!this.acquireRecoveryOwnership(wallet)) break;
      this.recoveryPollOffset = (entryIndex + 1) % allEntries.length;
    }

    // Sticky owners alone use the reserved historical lanes. This bounds every
    // retained discovery/replay state to recoveryConcurrency.
    const recoverySlots = Math.max(0, recoveryConcurrency - recoveryInFlight);
    const recoveryLaunchLimit = Math.min(recoverySlots, launchLimit);
    let recoveryLaunched = 0;
    for (const wallet of this.recoveryOwners) {
      if (recoveryLaunched >= recoveryLaunchLimit) break;
      if (this.walletsInFlight.has(wallet)) continue;
      if ((this.walletRetryAt.get(wallet) ?? 0) > now) continue;
      const options = this.watched.get(wallet);
      if (!options) continue;
      launch(wallet, options, "recovery");
      recoveryLaunched += 1;
    }

    // Fill every remaining launch slot from the independent live rotation.
    // Recovery wallets above the configured cap stay in the recovery lane;
    // they are never mislabeled as live merely because their reserved slots
    // are occupied or temporarily backing off.
    const liveStart = this.pollOffset % allEntries.length;
    let liveScanned = 0;
    let liveLaunched = 0;
    let nextLiveOffset = liveStart;
    while (liveScanned < allEntries.length && launched < launchLimit) {
      const entryIndex = (liveStart + liveScanned) % allEntries.length;
      liveScanned += 1;
      const entry = allEntries[entryIndex];
      if (!entry) continue;
      const [wallet] = entry;
      if (this.isRecoveryWallet(wallet)) continue;
      if (this.walletsInFlight.has(wallet)) continue;
      if ((this.walletRetryAt.get(wallet) ?? 0) > now) continue;
      launch(wallet, entry[1], "live");
      liveLaunched += 1;
      nextLiveOffset = (entryIndex + 1) % allEntries.length;
    }
    if (liveLaunched > 0) this.pollOffset = nextLiveOffset;
  }

  private async runWalletPoll(wallet: string, options: RpcWatchOptions): Promise<void> {
    const lane = this.walletLaneInFlight.get(wallet);
    try {
      await this.pollWallet(wallet, options);
      this.walletFailureCounts.delete(wallet);
      this.walletRetryAt.delete(wallet);
      if (lane === "recovery" && !this.isRecoveryWallet(wallet)) {
        this.releaseRecoveryOwnership(wallet, false);
      }
    } catch (error) {
      if (!this.watched.has(wallet)) return;
      const failures = (this.walletFailureCounts.get(wallet) ?? 0) + 1;
      this.walletFailureCounts.set(wallet, failures);
      // Preserve a bounded, already-verified discovery plan across transient
      // RPC/DB/event failures. Rediscovering a six-figure history from page one
      // after every timeout can prevent a wallet from ever reaching its durable
      // boundary. Structural integrity failures delete the state at their
      // detection site; invalid/new live wallets have no retained state. A
      // bounded failure lease also prevents two permanently poisoned plans from
      // monopolizing every historical lane forever. The durable cursor remains
      // authoritative when an expired plan is safely rediscovered later.
      const canRetainVerifiedPlan =
        this.signatureRecoveries.has(wallet) && failures < MAX_STICKY_RECOVERY_FAILURES;
      if (!canRetainVerifiedPlan) {
        this.releaseRecoveryOwnership(wallet, true);
      }
      this.failures += 1;
      // A failed provider/database lane backs off independently. Other wallets
      // continue on the reserved scheduler slots instead of joining a retry
      // stampede behind one unhealthy address.
      const baseDelayMs = Math.min(120_000, 2_000 * 2 ** Math.min(6, failures - 1));
      const jitter = 0.9 + (stableWalletJitter(wallet) % 21) / 100;
      this.walletRetryAt.set(wallet, Date.now() + Math.round(baseDelayMs * jitter));
      const newlyBacklogged = !this.backlogWallets.has(wallet);
      this.backlogWallets.add(wallet);
      if (newlyBacklogged || this.cursorCache.get(wallet)?.backlogDetected !== true) {
        try {
          const cursor = await this.cursorStore.markBacklog(wallet, error);
          this.cursorCache.set(wallet, cursor);
        } catch (cursorError) {
          this.cursorCache.delete(wallet);
          log.warn(
            { wallet, error: sanitizeRpcCursorError(cursorError) },
            "RPC fallback could not persist backlog state",
          );
        }
      }
      log.warn(
        {
          wallet,
          retryInMs: Math.max(0, (this.walletRetryAt.get(wallet) ?? 0) - Date.now()),
          error: sanitizeRpcCursorError(error),
        },
        "RPC fallback wallet poll failed",
      );
    } finally {
      this.walletsInFlight.delete(wallet);
      this.walletLaneInFlight.delete(wallet);
    }
  }

  private async markRecoveryBacklog(
    wallet: string,
    cursor: RpcWalletCursor,
    error: unknown,
  ): Promise<RpcWalletCursor> {
    this.backlogWallets.add(wallet);
    if (cursor.backlogDetected) return cursor;
    const marked = await this.cursorStore.markBacklog(wallet, error);
    this.cursorCache.set(wallet, marked);
    this.applyCursorHealth(wallet, marked);
    return marked;
  }

  private async pollWallet(wallet: string, options: RpcWatchOptions) {
    const enforceWatchLifecycle = this.watched.has(wallet);
    let pubkey: PublicKey;
    try {
      pubkey = new PublicKey(wallet);
    } catch (cause) {
      log.warn({ wallet }, "rpc fallback skipped invalid wallet");
      // Returning successfully would let an invalid backlogged wallet retain a
      // sticky recovery slot forever. Fail the lane so normal backoff releases
      // its ephemeral state and gives the next durable backlog a turn.
      throw new Error("RPC fallback watched wallet is invalid", { cause });
    }

    let cursor = this.cursorCache.get(wallet) ?? (await this.cursorStore.load(wallet));
    if (enforceWatchLifecycle && !this.watched.has(wallet)) return;
    if (cursor) {
      const anchorSlot = positiveSlot(options.anchorSlot);
      if (
        this.options.allowEarlierAnchorRewind === true &&
        anchorSlot !== undefined &&
        anchorSlot < cursor.startSlot &&
        this.cursorStore.rewind
      ) {
        const priorStartSlot = cursor.startSlot;
        cursor = await this.cursorStore.rewind(wallet, anchorSlot);
        this.signatureRecoveries.delete(wallet);
        log.warn(
          { wallet, anchorSlot, priorStartSlot },
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
        if (enforceWatchLifecycle && !this.watched.has(wallet)) return;
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

    const configuredChunkSize = Math.trunc(
      Number(this.options.recoveryChunkSize ?? RPC_RECOVERY_CHUNK_SIZE),
    );
    const chunkSize = Math.max(1, Math.min(RPC_RECOVERY_CHUNK_SIZE, configuredChunkSize || 1));

    // A pre-existing durable cursor is always authoritative. Signature history
    // is first discovered back to that trusted boundary without releasing any
    // events. Only compact page descriptors survive between turns. Completed
    // pages are then refetched and verified one at a time, oldest first.
    let recovery = this.signatureRecoveries.get(wallet);
    if (!recovery) recovery = createSignatureRecoveryState(cursor);

    if (!recovery.discoveryComplete) {
      const configuredPageBudget = Math.trunc(
        Number(this.options.signaturePagesPerTurn ?? RPC_SIGNATURE_MAX_PAGES),
      );
      const pageBudget = Math.max(1, Math.min(RPC_SIGNATURE_MAX_PAGES, configuredPageBudget || 1));
      let pagesReadThisTurn = 0;
      while (!recovery.discoveryComplete && pagesReadThisTurn < pageBudget) {
        const request: RpcSignatureRequest = {
          limit: RPC_SIGNATURE_PAGE_SIZE,
          ...(recovery.nextBefore ? { before: recovery.nextBefore } : {}),
        };
        const page = await rpcReadWithTimeout(
          this.conn.getSignaturesForAddress(pubkey, request, "confirmed"),
          "signature page",
        );
        if (enforceWatchLifecycle && !this.watched.has(wallet)) {
          this.signatureRecoveries.delete(wallet);
          return;
        }
        try {
          appendSignatureRecoveryPage(
            recovery,
            page,
            request,
            RPC_SIGNATURE_PAGE_SIZE,
            RPC_SIGNATURE_MAX_PAGES,
          );
        } catch (error) {
          this.signatureRecoveries.delete(wallet);
          cursor = await this.markRecoveryBacklog(wallet, cursor, error);
          throw error;
        }
        pagesReadThisTurn += 1;

        // A live lane may discover a deep wallet. It may retain a plan only by
        // claiming one of the bounded sticky recovery slots. Otherwise the
        // durable cursor remains unchanged and the reserved scheduler retries.
        if (!recovery.discoveryComplete && !this.acquireRecoveryOwnership(wallet)) {
          cursor = await this.markRecoveryBacklog(
            wallet,
            cursor,
            "RPC signature boundary discovery is waiting for a recovery slot",
          );
          return;
        }
      }

      if (!recovery.discoveryComplete) {
        if (!this.acquireRecoveryOwnership(wallet)) {
          cursor = await this.markRecoveryBacklog(
            wallet,
            cursor,
            "RPC signature boundary discovery is waiting for a recovery slot",
          );
          return;
        }
        this.signatureRecoveries.set(wallet, recovery);
        cursor = await this.markRecoveryBacklog(
          wallet,
          cursor,
          "RPC signature boundary discovery is still in progress",
        );
        this.lastRecoveryProgressAt = Date.now();
        this.lastSuccessAt = this.lastRecoveryProgressAt;
        return;
      }
    }

    if (recovery.remainingCount > chunkSize && !this.acquireRecoveryOwnership(wallet)) {
      cursor = await this.markRecoveryBacklog(
        wallet,
        cursor,
        "RPC signature replay is waiting for a recovery slot",
      );
      return;
    }
    if (this.recoveryOwners.has(wallet)) this.signatureRecoveries.set(wallet, recovery);

    let processedThisTurn = 0;
    while (processedThisTurn < chunkSize && recovery.replayPageIndex >= 0) {
      let activePage = recovery.activePage;
      if (!activePage || activePage.pageIndex !== recovery.replayPageIndex) {
        const descriptor = recovery.descriptors[recovery.replayPageIndex];
        if (!descriptor) {
          this.signatureRecoveries.delete(wallet);
          throw new Error("RPC recovery page descriptor is missing");
        }
        let page: readonly CompactSignatureInfo[];
        if (recovery.replayPageIndex === 0) {
          page = recovery.firstPage ?? [];
        } else {
          page = await rpcReadWithTimeout(
            this.conn.getSignaturesForAddress(pubkey, descriptor.request, "confirmed"),
            "recovery signature page",
          );
        }
        if (!signaturePageMatchesDescriptor(page, descriptor)) {
          this.signatureRecoveries.delete(wallet);
          throw new Error("RPC signature page changed during bounded recovery");
        }
        activePage = {
          pageIndex: recovery.replayPageIndex,
          entries: page.map(compactSignatureInfo),
          candidateIndexesOldestFirst: decodeCandidateIndexes(
            descriptor.candidateMask,
            descriptor.entryCount,
          ).reverse(),
          offset: 0,
        };
        recovery.activePage = activePage;
      }

      if (activePage.offset >= activePage.candidateIndexesOldestFirst.length) {
        recovery.activePage = undefined;
        recovery.replayPageIndex -= 1;
        continue;
      }

      const batchSize = Math.min(
        50,
        chunkSize - processedThisTurn,
        activePage.candidateIndexesOldestFirst.length - activePage.offset,
      );
      const signatureBatch = activePage.candidateIndexesOldestFirst
        .slice(activePage.offset, activePage.offset + batchSize)
        .map((index) => activePage.entries[index])
        .filter((entry): entry is CompactSignatureInfo => entry !== undefined);
      if (signatureBatch.length !== batchSize) {
        this.signatureRecoveries.delete(wallet);
        throw new Error("RPC recovery candidate descriptor is invalid");
      }
      const txs = await rpcReadWithTimeout(
        this.conn.getParsedTransactions(
          signatureBatch.map((sig) => sig.signature),
          { commitment: "confirmed", maxSupportedTransactionVersion: 0 },
        ),
        "parsed transaction batch",
      );
      if (enforceWatchLifecycle && !this.watched.has(wallet)) return;
      let checkpoint: (typeof signatureBatch)[number] | undefined;
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
          throw new Error("RPC transaction was temporarily unavailable");
        }
        const decoded = decodeParsedTransactionWithCoverage(wallet, tx as any);
        const events = decoded.events;
        for (const event of events) {
          event.source = "rpc";
          event.delivery = "catchup";
          event.observedAtMs = Date.now();
          log.debug(
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
        checkpoint = sig;
      }
      if (checkpoint) {
        // Event persistence is idempotent by source transaction. Checkpointing
        // once per handled batch cuts cursor database traffic by up to 50x;
        // a crash before this write safely replays already-committed events.
        if (enforceWatchLifecycle && !this.watched.has(wallet)) return;
        cursor = await this.cursorStore.advance(
          wallet,
          checkpoint.signature,
          checkpoint.slot,
          checkpoint.blockTime ?? null,
        );
        this.cursorCache.set(wallet, cursor);
        this.processedSignatureCount += signatureBatch.length;
        this.lastRecoveryProgressAt = Date.now();
        this.lastSuccessAt = this.lastRecoveryProgressAt;
        activePage.offset += signatureBatch.length;
        recovery.remainingCount -= signatureBatch.length;
        processedThisTurn += signatureBatch.length;
      }
    }
    const remainingRecovery = recovery.remainingCount;
    if (remainingRecovery > 0) {
      cursor = await this.markRecoveryBacklog(
        wallet,
        cursor,
        new Error("RPC recovery backlog remains after safe chunk"),
      );
      this.signatureRecoveries.set(wallet, recovery);
      log.debug(
        { wallet, processed: processedThisTurn, remaining: remainingRecovery },
        "RPC fallback advanced one durable recovery chunk",
      );
      return;
    }
    this.signatureRecoveries.delete(wallet);
    this.releaseRecoveryOwnership(wallet, false);
    const now = Date.now();
    const shouldPersistSuccess =
      cursor.backlogDetected ||
      processedThisTurn > 0 ||
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

function createSignatureRecoveryState(cursor: RpcWalletCursor): SignatureRecoveryState {
  const boundarySlot = cursor.lastProcessedSlot ?? cursor.startSlot;
  if (!Number.isSafeInteger(boundarySlot) || boundarySlot < 0) {
    throw new Error("RPC recovery cursor contains an invalid boundary slot");
  }
  return {
    boundarySignature: cursor.lastProcessedSignature?.trim() || null,
    boundarySlot,
    descriptors: [],
    pageTails: new Set<string>(),
    firstPage: null,
    priorSlot: Number.POSITIVE_INFINITY,
    nextBefore: undefined,
    discoveryComplete: false,
    remainingCount: 0,
    replayPageIndex: -1,
  };
}

function compactSignatureInfo(info: CompactSignatureInfo): CompactSignatureInfo {
  return {
    signature: info.signature,
    slot: info.slot,
    blockTime: info.blockTime ?? null,
  };
}

function signaturePageDigest(page: readonly CompactSignatureInfo[]): string {
  const digest = createHash("sha256");
  for (const info of page) {
    // `blockTime` is supplemental metadata and may legitimately move from null
    // to a number between otherwise identical RPC reads. Cursor safety depends
    // on the exact ordered signature/slot identity; the refetched blockTime is
    // used for the eventual checkpoint.
    digest.update(JSON.stringify([info.signature, info.slot]), "utf8");
    digest.update("\n", "utf8");
  }
  return digest.digest("hex");
}

function setCandidateBit(mask: Buffer, index: number) {
  mask[index >> 3] |= 1 << (index & 7);
}

function decodeCandidateIndexes(encodedMask: string, entryCount: number): number[] {
  const mask = Buffer.from(encodedMask, "base64");
  const indexes: number[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if ((mask[index >> 3] & (1 << (index & 7))) !== 0) indexes.push(index);
  }
  return indexes;
}

function signaturePageMatchesDescriptor(
  page: readonly CompactSignatureInfo[],
  descriptor: SignaturePageDescriptor,
): boolean {
  return page.length === descriptor.entryCount && signaturePageDigest(page) === descriptor.digest;
}

/**
 * Incrementally records one newest-first RPC page. The candidate mask captures
 * exactly which page rows are newer than the original durable boundary, while
 * the digest makes the later bounded refetch fail closed if provider history
 * changes. No event is released until a trusted boundary is reached.
 */
function appendSignatureRecoveryPage(
  state: SignatureRecoveryState,
  page: readonly ConfirmedSignatureInfo[],
  request: RpcSignatureRequest,
  pageSize: number,
  maxPages: number,
) {
  if (state.discoveryComplete) throw new Error("RPC signature discovery is already complete");
  if (state.descriptors.length >= maxPages) {
    throw new Error("RPC signature pagination page limit reached before cursor boundary");
  }

  const candidateMask = Buffer.alloc(Math.ceil(page.length / 8));
  let candidateCount = 0;
  let reachedBoundary = false;
  for (const [index, info] of page.entries()) {
    if (
      typeof info?.signature !== "string" ||
      info.signature.length === 0 ||
      !Number.isSafeInteger(info.slot) ||
      info.slot < 0
    ) {
      throw new Error("RPC signature page contains invalid signature data");
    }
    if (info.slot > state.priorSlot) {
      throw new Error("RPC signature page has invalid signature order");
    }
    state.priorSlot = info.slot;
    if (reachedBoundary) continue;
    if (state.boundarySignature && info.signature === state.boundarySignature) {
      reachedBoundary = true;
      continue;
    }
    // Inclusive slot fallback deliberately replays the cursor slot. Excluding
    // it when the exact signature disappeared could miss a sibling tx.
    if (info.slot < state.boundarySlot) {
      reachedBoundary = true;
      continue;
    }
    // Do not retain a backlog-sized global de-duplication Set. A provider page
    // overlap may replay the same source transaction, which is safe because
    // event persistence is idempotent; validated slot order still prevents a
    // cursor from crossing unseen history.
    setCandidateBit(candidateMask, index);
    candidateCount += 1;
    state.oldestCandidateSlot = info.slot;
  }

  const tail = page.at(-1)?.signature;
  if (tail) {
    if (state.pageTails.has(tail)) {
      throw new Error("RPC signature pagination made no progress");
    }
    state.pageTails.add(tail);
    state.nextBefore = tail;
  }

  const compactPage = page.map(compactSignatureInfo);
  if (state.descriptors.length === 0) state.firstPage = compactPage;
  state.descriptors.push({
    request: { ...request },
    entryCount: page.length,
    digest: signaturePageDigest(compactPage),
    candidateMask: candidateMask.toString("base64"),
    candidateCount,
  });
  state.remainingCount += candidateCount;

  if (reachedBoundary) {
    state.discoveryComplete = true;
  } else if (page.length < pageSize) {
    if (
      (state.boundarySignature || state.boundarySlot > 0) &&
      (state.oldestCandidateSlot === undefined || state.oldestCandidateSlot > state.boundarySlot)
    ) {
      throw new Error("RPC history gap before cursor boundary");
    }
    state.discoveryComplete = true;
  } else if (state.descriptors.length >= maxPages) {
    throw new Error("RPC signature pagination page limit reached before cursor boundary");
  }

  if (state.discoveryComplete) state.replayPageIndex = state.descriptors.length - 1;
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

function stableWalletJitter(wallet: string): number {
  let hash = 0;
  for (let index = 0; index < wallet.length; index += 1) {
    hash = (Math.imul(hash, 31) + wallet.charCodeAt(index)) >>> 0;
  }
  return hash;
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
