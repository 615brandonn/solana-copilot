import type { ConfirmedSignatureInfo } from "@solana/web3.js";

const RPC_CURSOR_TABLE = "rpc_wallet_cursors";
const DEFAULT_PAGE_SIZE = 1_000;
const DEFAULT_MAX_PAGES = 25;

/**
 * The durable RPC recovery point for one watched wallet.
 *
 * `startSlot` is the lower bound captured when the wallet is first watched.
 * It remains useful if the exact last processed signature has fallen out of an
 * RPC provider's history. Timestamps are ISO strings written by Postgres.
 */
export interface RpcWalletCursor {
  userId: string;
  wallet: string;
  startSlot: number;
  lastProcessedSignature: string | null;
  lastProcessedSlot: number | null;
  lastBlockTime: number | null;
  backlogDetected: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * Deliberately has no delete/unwatch operation. Stopping a live subscription
 * must not discard the recovery point needed when that wallet is watched again.
 */
export interface RpcCursorStore {
  load(wallet: string): Promise<RpcWalletCursor | null>;
  /**
   * Loads many durable cursors without issuing one database request per wallet.
   * Large custody watch sets use this during startup to avoid a thundering herd.
   */
  loadMany?(wallets: readonly string[]): Promise<Map<string, RpcWalletCursor>>;
  ensure(wallet: string, anchorSlot?: number): Promise<RpcWalletCursor>;
  /**
   * Moves only the recovery floor backward. Used by the custody observer when
   * a newly discovered mint proves that this already-watched wallet may have
   * relevant activity before its current wallet-wide cursor.
   */
  rewind?(wallet: string, anchorSlot: number): Promise<RpcWalletCursor>;
  advance(
    wallet: string,
    signature: string,
    slot: number,
    blockTime: number | null,
  ): Promise<RpcWalletCursor>;
  markBacklog(wallet: string, error?: unknown): Promise<RpcWalletCursor>;
  markSuccess(wallet: string): Promise<RpcWalletCursor>;
}

/** A minimal structural dependency that accepts the real Supabase client and test doubles. */
export interface SupabaseCursorClientLike {
  // Supabase's generated builder type is intentionally not repeated here. The
  // worker is untyped against its database schema, and callers only need `from`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

type RpcCursorRow = {
  user_id?: unknown;
  wallet?: unknown;
  start_slot?: unknown;
  last_processed_signature?: unknown;
  last_processed_slot?: unknown;
  last_block_time?: unknown;
  backlog_detected?: unknown;
  last_success_at?: unknown;
  last_error?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
};

type QueryResult = {
  data?: unknown;
  error?: unknown;
};

function normalizeRequiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`RPC cursor ${label} is required`);
  return normalized;
}

function normalizeSlot(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`RPC cursor ${label} must be a non-negative safe integer`);
  }
  return value;
}

function nullableInteger(value: unknown, label: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`RPC cursor contains an invalid ${label}`);
  }
  return parsed;
}

function nullableTimestamp(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function mapCursorRow(row: unknown): RpcWalletCursor {
  if (!row || typeof row !== "object") {
    throw new Error("RPC cursor persistence returned invalid cursor data");
  }
  const source = row as RpcCursorRow;
  const userId = typeof source.user_id === "string" ? source.user_id : "";
  const wallet = typeof source.wallet === "string" ? source.wallet : "";
  const startSlot = nullableInteger(source.start_slot, "start slot");
  if (!userId || !wallet || startSlot === null) {
    throw new Error("RPC cursor persistence returned invalid cursor data");
  }

  return {
    userId,
    wallet,
    startSlot,
    lastProcessedSignature:
      typeof source.last_processed_signature === "string" &&
      source.last_processed_signature.length > 0
        ? source.last_processed_signature
        : null,
    lastProcessedSlot: nullableInteger(source.last_processed_slot, "processed slot"),
    lastBlockTime: nullableInteger(source.last_block_time, "block time"),
    backlogDetected: source.backlog_detected === true,
    lastSuccessAt: nullableTimestamp(source.last_success_at),
    // Old rows may predate sanitization. Never surface their raw text back into
    // logs or health output.
    lastError: source.last_error == null ? null : sanitizeRpcCursorError(source.last_error),
    createdAt: nullableTimestamp(source.created_at),
    updatedAt: nullableTimestamp(source.updated_at),
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name} ${error.message}`;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : "";
  }
  return typeof error === "string" ? error : "";
}

/**
 * Reduces arbitrary provider/database errors to a small diagnostic category.
 * Raw messages are never persisted because they can contain RPC URLs, bearer
 * tokens, service-role keys, signed query strings, or transaction payloads.
 */
export function sanitizeRpcCursorError(error: unknown): string {
  const message = errorText(error).toLowerCase();
  if (/timed?\s*out|timeout|etimedout/.test(message)) return "RPC cursor request timed out";
  if (/too many requests|rate.?limit|\b429\b/.test(message))
    return "RPC cursor request was rate limited";
  if (/unauthori[sz]ed|authentication|invalid api|\b401\b/.test(message)) {
    return "RPC cursor authentication failed";
  }
  if (/forbidden|permission denied|\b403\b/.test(message)) return "RPC cursor permission denied";
  if (/abort|cancel/.test(message)) return "RPC cursor request was aborted";
  if (
    /pagination|page limit|cursor boundary|backlog|history gap|invalid signature order|no progress/.test(
      message,
    )
  ) {
    return "RPC signature pagination incomplete";
  }
  if (/network|fetch|socket|connection|econn|enotfound|dns/.test(message)) {
    return "RPC cursor network request failed";
  }
  if (/unavailable|overloaded|\b50[234]\b/.test(message)) return "RPC cursor service unavailable";
  if (/supabase|postgrest|postgres|database|relation|column/.test(message)) {
    return "RPC cursor database operation failed";
  }
  return "RPC cursor operation failed";
}

function throwQueryError(operation: string, result: QueryResult | null | undefined): void {
  if (!result?.error) return;
  throw new Error(`${operation}: ${sanitizeRpcCursorError(result.error)}`);
}

/**
 * Creates a durable cursor store scoped to one Helix user. `ensure` uses an
 * insert-only conflict policy, so later watch/unwatch cycles cannot move the
 * original start slot or clear progress.
 */
export function createSupabaseRpcCursorStore(
  client: SupabaseCursorClientLike,
  userId: string,
  table = RPC_CURSOR_TABLE,
): RpcCursorStore {
  const normalizedUserId = normalizeRequiredText(userId, "user id");
  const cursorTable = normalizeRequiredText(table, "table");

  const load = async (walletInput: string): Promise<RpcWalletCursor | null> => {
    const wallet = normalizeRequiredText(walletInput, "wallet");
    const result = (await client
      .from(cursorTable)
      .select(
        "user_id,wallet,start_slot,last_processed_signature,last_processed_slot,last_block_time,backlog_detected,last_success_at,last_error,created_at,updated_at",
      )
      .eq("user_id", normalizedUserId)
      .eq("wallet", wallet)
      .maybeSingle()) as QueryResult;
    throwQueryError("RPC cursor load failed", result);
    return result.data == null ? null : mapCursorRow(result.data);
  };

  const loadMany = async (
    walletInputs: readonly string[],
  ): Promise<Map<string, RpcWalletCursor>> => {
    const wallets = Array.from(
      new Set(walletInputs.map((wallet) => normalizeRequiredText(wallet, "wallet"))),
    );
    const loaded = new Map<string, RpcWalletCursor>();
    const chunks: string[][] = [];
    for (let offset = 0; offset < wallets.length; offset += 250) {
      chunks.push(wallets.slice(offset, offset + 250));
    }
    // Four bounded queries at a time replaces thousands of simultaneous
    // single-row cursor reads during a large custody restart.
    for (let offset = 0; offset < chunks.length; offset += 4) {
      const results = await Promise.all(
        chunks.slice(offset, offset + 4).map(async (chunk) => {
          const result = (await client
            .from(cursorTable)
            .select(
              "user_id,wallet,start_slot,last_processed_signature,last_processed_slot,last_block_time,backlog_detected,last_success_at,last_error,created_at,updated_at",
            )
            .eq("user_id", normalizedUserId)
            .in("wallet", chunk)) as QueryResult;
          throwQueryError("RPC cursor bulk load failed", result);
          if (!Array.isArray(result.data)) {
            throw new Error("RPC cursor bulk load failed: invalid cursor rows");
          }
          return result.data.map(mapCursorRow);
        }),
      );
      for (const rows of results) {
        for (const cursor of rows) loaded.set(cursor.wallet, cursor);
      }
    }
    return loaded;
  };

  const updateAndLoad = async (
    wallet: string,
    values: Record<string, unknown>,
    operation: string,
  ): Promise<RpcWalletCursor> => {
    const result = (await client
      .from(cursorTable)
      .update(values)
      .eq("user_id", normalizedUserId)
      .eq("wallet", wallet)
      .select(
        "user_id,wallet,start_slot,last_processed_signature,last_processed_slot,last_block_time,backlog_detected,last_success_at,last_error,created_at,updated_at",
      )
      .maybeSingle()) as QueryResult;
    throwQueryError(operation, result);
    if (result.data == null) throw new Error(`${operation}: RPC cursor was not initialized`);
    return mapCursorRow(result.data);
  };

  return {
    load,
    loadMany,

    async ensure(walletInput: string, anchorSlot?: number): Promise<RpcWalletCursor> {
      const wallet = normalizeRequiredText(walletInput, "wallet");
      const current = await load(wallet);
      if (current) return current;

      const insert: Record<string, unknown> = {
        user_id: normalizedUserId,
        wallet,
      };
      if (anchorSlot !== undefined) insert.start_slot = normalizeSlot(anchorSlot, "anchor slot");

      const result = (await client.from(cursorTable).upsert(insert, {
        onConflict: "user_id,wallet",
        ignoreDuplicates: true,
      })) as QueryResult;
      throwQueryError("RPC cursor initialization failed", result);

      const ensured = await load(wallet);
      if (!ensured) throw new Error("RPC cursor initialization failed: cursor was not persisted");
      return ensured;
    },

    async rewind(walletInput: string, anchorSlotInput: number): Promise<RpcWalletCursor> {
      const wallet = normalizeRequiredText(walletInput, "wallet");
      const anchorSlot = normalizeSlot(anchorSlotInput, "rewind anchor slot");
      const current = await load(wallet);
      if (!current) throw new Error("RPC cursor rewind failed: cursor was not initialized");
      // `startSlot` is the earliest boundary this cursor has already covered.
      // Comparing against lastProcessedSlot would rewind the same completed
      // history on every subscription reconciliation.
      if (anchorSlot >= current.startSlot) return current;
      return updateAndLoad(
        wallet,
        {
          start_slot: anchorSlot,
          last_processed_signature: null,
          last_processed_slot: anchorSlot,
          last_block_time: null,
          backlog_detected: true,
          last_error: "RPC signature pagination incomplete",
          updated_at: new Date().toISOString(),
        },
        "RPC cursor rewind failed",
      );
    },

    async advance(
      walletInput: string,
      signatureInput: string,
      slotInput: number,
      blockTimeInput: number | null,
    ): Promise<RpcWalletCursor> {
      const wallet = normalizeRequiredText(walletInput, "wallet");
      const signature = normalizeRequiredText(signatureInput, "signature");
      const slot = normalizeSlot(slotInput, "processed slot");
      const blockTime =
        blockTimeInput === null ? null : normalizeSlot(blockTimeInput, "block time");

      const current = await load(wallet);
      if (!current) throw new Error("RPC cursor advance failed: cursor was not initialized");
      if (current.lastProcessedSlot !== null && slot < current.lastProcessedSlot) {
        throw new Error("RPC cursor advance failed: processed slot would move backwards");
      }

      return updateAndLoad(
        wallet,
        {
          last_processed_signature: signature,
          last_processed_slot: slot,
          last_block_time: blockTime,
          updated_at: new Date().toISOString(),
        },
        "RPC cursor advance failed",
      );
    },

    async markBacklog(walletInput: string, error?: unknown): Promise<RpcWalletCursor> {
      const wallet = normalizeRequiredText(walletInput, "wallet");
      return updateAndLoad(
        wallet,
        {
          backlog_detected: true,
          last_error: sanitizeRpcCursorError(
            error ?? new Error("RPC signature pagination backlog"),
          ),
          updated_at: new Date().toISOString(),
        },
        "RPC cursor backlog update failed",
      );
    },

    async markSuccess(walletInput: string): Promise<RpcWalletCursor> {
      const wallet = normalizeRequiredText(walletInput, "wallet");
      const now = new Date().toISOString();
      return updateAndLoad(
        wallet,
        {
          backlog_detected: false,
          last_error: null,
          last_success_at: now,
          updated_at: now,
        },
        "RPC cursor success update failed",
      );
    },
  };
}

export interface RpcSignaturePagingOptions {
  /** Must match the `limit` sent to getSignaturesForAddress. */
  pageSize?: number;
  /** A safety cap. Hitting it returns no work and raises a backlog flag. */
  maxPages?: number;
}

export type RpcSignaturePlanBoundary =
  | "cursor"
  | "slot"
  | "history-end"
  | "pending"
  | "page-limit"
  | "history-gap"
  | "invalid-order"
  | "no-progress";

export interface RpcSignaturePlan {
  /** Safe work in global oldest-to-newest order. Empty until the boundary is reached. */
  signatures: ConfirmedSignatureInfo[];
  /** `before` for the next getSignaturesForAddress request. */
  nextBefore?: string;
  complete: boolean;
  backlogDetected: boolean;
  boundary: RpcSignaturePlanBoundary;
  error: string | null;
  pagesRead: number;
  uniqueSignaturesRead: number;
}

export interface RpcSignatureRequestPlan {
  limit: number;
  before?: string;
}

export interface RpcRecoveryChunk {
  /** The next contiguous signatures to process, always oldest first. */
  signatures: ConfirmedSignatureInfo[];
  /** True when newer contiguous work remains after this durable chunk. */
  hasMore: boolean;
  remainingCount: number;
}

export type RpcCursorBoundary = Pick<
  RpcWalletCursor,
  "startSlot" | "lastProcessedSignature" | "lastProcessedSlot"
>;

function pagingInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`RPC signature paging value must be between 1 and ${maximum}`);
  }
  return value;
}

function validateSignatureInfo(info: ConfirmedSignatureInfo): boolean {
  return (
    typeof info?.signature === "string" &&
    info.signature.length > 0 &&
    Number.isSafeInteger(info.slot) &&
    info.slot >= 0
  );
}

/**
 * Plans a safe catch-up from pages returned newest-first by Solana RPC.
 *
 * No signatures are released until either the exact cursor, its slot fallback,
 * or the end of available history is reached. Consequently, reaching a page
 * cap cannot advance past an unseen gap. Overlapping pages are de-duplicated
 * without re-sorting same-slot transactions.
 */
export function planRpcSignaturePages(
  pages: readonly (readonly ConfirmedSignatureInfo[])[],
  cursor: RpcCursorBoundary,
  options: RpcSignaturePagingOptions = {},
): RpcSignaturePlan {
  const pageSize = pagingInteger(options.pageSize, DEFAULT_PAGE_SIZE, 1_000);
  const maxPages = pagingInteger(options.maxPages, DEFAULT_MAX_PAGES, 10_000);
  const startSlot = normalizeSlot(cursor.startSlot, "start slot");
  const cursorSlot =
    cursor.lastProcessedSlot === null
      ? startSlot
      : normalizeSlot(cursor.lastProcessedSlot, "processed slot");
  const cursorSignature = cursor.lastProcessedSignature?.trim() || null;
  const seen = new Set<string>();
  const candidatesNewestFirst: ConfirmedSignatureInfo[] = [];
  const pageTails = new Set<string>();
  let priorSlot = Number.POSITIVE_INFINITY;
  let boundary: RpcSignaturePlanBoundary = "pending";
  let nextBefore: string | undefined;

  outer: for (const page of pages) {
    let pageTail: string | undefined;
    for (const info of page) {
      if (!validateSignatureInfo(info)) {
        boundary = "invalid-order";
        break outer;
      }
      pageTail = info.signature;
      if (seen.has(info.signature)) continue;
      seen.add(info.signature);

      // RPC promises newest-to-oldest ordering. Processing a response that
      // violates it could move the durable cursor across an unseen signature.
      if (info.slot > priorSlot) {
        boundary = "invalid-order";
        break outer;
      }
      priorSlot = info.slot;

      if (cursorSignature && info.signature === cursorSignature) {
        boundary = "cursor";
        break outer;
      }
      // Inclusive slot fallback deliberately replays the cursor slot. Without
      // the exact signature, excluding that slot could miss a sibling tx.
      if (info.slot < cursorSlot) {
        boundary = "slot";
        break outer;
      }
      candidatesNewestFirst.push(info);
    }

    if (pageTail) {
      if (pageTails.has(pageTail)) {
        boundary = "no-progress";
        break;
      }
      pageTails.add(pageTail);
      nextBefore = pageTail;
    }
  }

  const lastPage = pages.at(-1);
  const exhausted = lastPage !== undefined && lastPage.length < pageSize;
  if (boundary === "pending" && exhausted) {
    const oldestCandidate = candidatesNewestFirst.at(-1);
    if (
      (cursorSignature || cursorSlot > 0) &&
      (oldestCandidate === undefined || oldestCandidate.slot > cursorSlot)
    ) {
      // Exhaustion is not proof that an anchored boundary was reached. A
      // provider may have pruned everything at/before that slot, so releasing
      // newer work would cross an unseen history gap.
      boundary = "history-gap";
    } else if (oldestCandidate && oldestCandidate.slot <= cursorSlot) {
      boundary = "slot";
    } else {
      boundary = "history-end";
    }
  }

  const invalid =
    boundary === "invalid-order" || boundary === "no-progress" || boundary === "history-gap";
  const hitPageLimit = boundary === "pending" && pages.length >= maxPages;
  if (hitPageLimit) boundary = "page-limit";

  const complete = boundary === "cursor" || boundary === "slot" || boundary === "history-end";
  const backlogDetected = invalid || boundary === "page-limit";
  const error = backlogDetected
    ? sanitizeRpcCursorError(
        boundary === "invalid-order"
          ? new Error("invalid signature order")
          : boundary === "history-gap"
            ? new Error("RPC history gap before cursor boundary")
            : boundary === "no-progress"
              ? new Error("pagination made no progress")
              : new Error("pagination page limit reached before cursor boundary"),
      )
    : null;

  return {
    signatures: complete ? candidatesNewestFirst.slice().reverse() : [],
    nextBefore: complete || backlogDetected ? undefined : nextBefore,
    complete,
    backlogDetected,
    boundary,
    error,
    pagesRead: pages.length,
    uniqueSignaturesRead: seen.size,
  };
}

/** Returns the next pure RPC request plan, or null once complete/blocked. */
export function planNextRpcSignaturePage(
  pages: readonly (readonly ConfirmedSignatureInfo[])[],
  cursor: RpcCursorBoundary,
  options: RpcSignaturePagingOptions = {},
): RpcSignatureRequestPlan | null {
  const plan = planRpcSignaturePages(pages, cursor, options);
  if (plan.complete || plan.backlogDetected) return null;
  const limit = pagingInteger(options.pageSize, DEFAULT_PAGE_SIZE, 1_000);
  return plan.nextBefore ? { limit, before: plan.nextBefore } : { limit };
}

/**
 * Takes a bounded, contiguous recovery chunk only after pagination reached a
 * trusted cursor/history boundary. Large backlogs therefore make durable
 * progress without either buffering transaction payloads all at once or
 * advancing across an unseen gap.
 */
export function takeOldestRpcRecoveryChunk(
  plan: RpcSignaturePlan,
  maxSignatures: number,
): RpcRecoveryChunk {
  const limit = pagingInteger(maxSignatures, 5_000, 100_000);
  if (!plan.complete || plan.backlogDetected) {
    return { signatures: [], hasMore: false, remainingCount: 0 };
  }
  const signatures = plan.signatures.slice(0, limit);
  const remainingCount = Math.max(0, plan.signatures.length - signatures.length);
  return {
    signatures,
    hasMore: remainingCount > 0,
    remainingCount,
  };
}

/** De-duplicates one or more already-complete RPC pages and reverses API order. */
export function rpcSignaturesOldestFirst(
  signaturesNewestFirst: readonly ConfirmedSignatureInfo[],
): ConfirmedSignatureInfo[] {
  const seen = new Set<string>();
  const unique: ConfirmedSignatureInfo[] = [];
  let priorSlot = Number.POSITIVE_INFINITY;
  for (const info of signaturesNewestFirst) {
    if (!validateSignatureInfo(info) || info.slot > priorSlot) {
      throw new Error("RPC signatures are not in valid newest-first order");
    }
    if (seen.has(info.signature)) continue;
    seen.add(info.signature);
    priorSlot = info.slot;
    unique.push(info);
  }
  return unique.reverse();
}
