import { PublicKey, type Connection, type ParsedTransactionWithMeta } from "@solana/web3.js";
import {
  parsePumpFunCreateTransaction,
  PUMP_FUN_CREATE_PROOF_ABI,
} from "./pump-fun-create-proof.js";
import {
  sampleFreshTailFinalizedHead,
  type FreshTailFinalizedHead,
} from "./fresh-tail-finalized-head.js";
import { solanaRpcWithTimeout } from "./pump-fun-supply.js";

const DEFAULT_PAGE_SIZE = 1_000;
const DEFAULT_MAX_SIGNATURE_PAGES = 8;
const DEFAULT_RPC_TIMEOUT_MS = 4_000;
const DEFAULT_OPERATION_BUDGET_MS = 12_000;
const MAX_OPERATION_BUDGET_MS = 30_000;
const TRANSACTION_BATCH_SIZE = 50;

const DEFAULT_MAX_CACHE_ENTRIES = 2_048;
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60_000;
const MIN_CACHE_TTL_MS = 1_000;
const MAX_CACHE_TTL_MS = 24 * 60 * 60_000;
const MAX_CACHE_ENTRIES_LIMIT = 10_000;

export type PumpFunCreationTimeProof = {
  parserAbi: typeof PUMP_FUN_CREATE_PROOF_ABI;
  mint: string;
  creator: string;
  bondingCurve: string;
  createVariant: "classic_v1" | "create_v2_token2022";
  tokenProgram: string;
  txSig: string;
  slot: number;
  blockTimeMs: number;
  blockhash: string;
  transactionIndex: number;
  finalizedHeadSlot: number;
  resolvedAtMs: number;
};

export type PumpFunCreationTimeFailureCode =
  | "invalid_request"
  | "deadline_exceeded"
  | "rpc_error"
  | "finalized_head_unavailable"
  | "signature_history_pruned"
  | "signature_page_limit"
  | "signature_page_conflict"
  | "transaction_unavailable"
  | "transaction_identity_conflict"
  | "malformed_create_instruction"
  | "create_not_found"
  | "create_conflict"
  | "creation_block_unavailable"
  | "creation_block_conflict"
  | "finalized_event_unavailable"
  | "finalized_event_conflict"
  | "block_time_unavailable";

export type PumpFunFinalizedEventProof = {
  txSig: string;
  slot: number;
  blockTimeMs: number;
  blockhash: string;
  transactionIndex: number;
};

export type PumpFunCreationTimeResult =
  | {
      ok: true;
      proof: PumpFunCreationTimeProof;
      source: "rpc" | "cache";
      evaluatedAt: FreshTailFinalizedHead;
      evaluatedAtBlockTimeMs: number;
      finalizedEvents: PumpFunFinalizedEventProof[];
    }
  | {
      ok: false;
      code: PumpFunCreationTimeFailureCode;
      reason: string;
      retryable: boolean;
    };

export type PumpFunCreationTimeRequest = {
  mint: string;
  /** An optional lower finality bound for callers without an exact event identity. */
  minimumFinalizedSlot?: number;
  /** Exact contributing buys; status and block inclusion are re-proved on every call. */
  requiredFinalizedEvents?: Array<{ slot: number; txSig: string }>;
  maxSkippedHeadSlots?: number;
  pageSize?: number;
  maxSignaturePages?: number;
  rpcCallTimeoutMs?: number;
  /** Caller-owned absolute deadline. The resolver also enforces its own 30s ceiling. */
  deadlineMs?: number;
  nowMs?: () => number;
};

export type PumpFunCreationTimeConnection = Pick<
  Connection,
  | "getSlot"
  | "getBlock"
  | "getSignaturesForAddress"
  | "getFirstAvailableBlock"
  | "getParsedTransactions"
  | "getBlockSignatures"
  | "getSignatureStatuses"
>;

export type PumpFunCreationTimeResolverOptions = {
  maxCacheEntries?: number;
  cacheTtlMs?: number;
};

type SignatureRow = Awaited<ReturnType<Connection["getSignaturesForAddress"]>>[number];

type Deadline = {
  deadlineMs: number;
  rpcCallTimeoutMs: number;
  nowMs: () => number;
};

type CreateCandidate = {
  row: SignatureRow;
  tx: ParsedTransactionWithMeta;
  parsed: Extract<ReturnType<typeof parsePumpFunCreateTransaction>, { kind: "valid" }>["value"];
};

type CacheEntry = {
  proof: PumpFunCreationTimeProof;
  cachedAtMs: number;
};

type PumpFunCreationTimeFailure = Extract<PumpFunCreationTimeResult, { ok: false }>;
type CreationResolution =
  | { ok: true; proof: PumpFunCreationTimeProof }
  | PumpFunCreationTimeFailure;

function positiveSafeInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeSafeInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number | null {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function failure(
  code: PumpFunCreationTimeFailureCode,
  reason: string,
  retryable = false,
): PumpFunCreationTimeFailure {
  return { ok: false, code, reason, retryable };
}

function remainingRpcTimeout(deadline: Deadline): number | null {
  const remaining = deadline.deadlineMs - Number(deadline.nowMs());
  return Number.isFinite(remaining) && remaining > 0
    ? Math.max(1, Math.min(deadline.rpcCallTimeoutMs, Math.floor(remaining)))
    : null;
}

function deadlineFailure(operation: string): PumpFunCreationTimeFailure {
  return failure(
    "deadline_exceeded",
    `Pump creation-time proof exhausted its absolute deadline before ${operation}`,
    true,
  );
}

function rpcFailureOrDeadline(
  deadline: Deadline,
  operation: string,
  error: unknown,
): PumpFunCreationTimeFailure {
  if (remainingRpcTimeout(deadline) === null) return deadlineFailure(operation);
  return failure(
    "rpc_error",
    `${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
    true,
  );
}

function validSignatureRow(row: SignatureRow): boolean {
  return (
    typeof row?.signature === "string" &&
    row.signature.trim().length > 0 &&
    positiveSafeInteger(row.slot) !== null &&
    (row.blockTime === null || positiveSafeInteger(row.blockTime) !== null) &&
    row.confirmationStatus === "finalized" &&
    row.err !== undefined
  );
}

/**
 * Resolves an immutable Pump creation timestamp from finalized Solana history.
 * Only successful results are cached; every uncertainty remains fail-closed and
 * retryable failures can be retried by the caller without a negative-cache lag.
 */
export class PumpFunCreationTimeResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<CreationResolution>>();
  private readonly maxCacheEntries: number;
  private readonly cacheTtlMs: number;

  constructor(
    private readonly rpc: PumpFunCreationTimeConnection,
    options: PumpFunCreationTimeResolverOptions = {},
  ) {
    const maxCacheEntries = boundedInteger(
      options.maxCacheEntries,
      DEFAULT_MAX_CACHE_ENTRIES,
      1,
      MAX_CACHE_ENTRIES_LIMIT,
    );
    const cacheTtlMs = boundedInteger(
      options.cacheTtlMs,
      DEFAULT_CACHE_TTL_MS,
      MIN_CACHE_TTL_MS,
      MAX_CACHE_TTL_MS,
    );
    if (maxCacheEntries === null || cacheTtlMs === null) {
      throw new RangeError("Pump creation-time cache bounds are invalid");
    }
    this.maxCacheEntries = maxCacheEntries;
    this.cacheTtlMs = cacheTtlMs;
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  clearCache(): void {
    this.cache.clear();
  }

  async resolve(request: PumpFunCreationTimeRequest): Promise<PumpFunCreationTimeResult> {
    let mint: PublicKey;
    try {
      mint = new PublicKey(request.mint);
    } catch {
      return failure("invalid_request", "mint is not a Solana public key");
    }
    const mintAddress = mint.toBase58();
    const minimumFinalizedSlot =
      request.minimumFinalizedSlot === undefined
        ? null
        : positiveSafeInteger(request.minimumFinalizedSlot);
    if (
      request.requiredFinalizedEvents !== undefined &&
      !Array.isArray(request.requiredFinalizedEvents)
    ) {
      return failure("invalid_request", "required finalized events must be an array");
    }
    const requiredFinalizedEvents = request.requiredFinalizedEvents ?? [];
    const normalizedEvents = requiredFinalizedEvents.map((event) => ({
      slot: positiveSafeInteger(event?.slot),
      txSig: event?.txSig?.trim() ?? "",
    }));
    const maxSkippedHeadSlots = boundedInteger(request.maxSkippedHeadSlots, 64, 0, 512);
    const pageSize = boundedInteger(request.pageSize, DEFAULT_PAGE_SIZE, 1, 1_000);
    const maxSignaturePages = boundedInteger(
      request.maxSignaturePages,
      DEFAULT_MAX_SIGNATURE_PAGES,
      1,
      32,
    );
    const rpcCallTimeoutMs = boundedInteger(
      request.rpcCallTimeoutMs,
      DEFAULT_RPC_TIMEOUT_MS,
      250,
      30_000,
    );
    const nowMs = request.nowMs ?? Date.now;
    const startedAtMs = Number(nowMs());
    const requestedDeadlineMs = Number(
      request.deadlineMs ?? startedAtMs + DEFAULT_OPERATION_BUDGET_MS,
    );
    if (
      (request.minimumFinalizedSlot !== undefined && minimumFinalizedSlot === null) ||
      requiredFinalizedEvents.length > 8 ||
      normalizedEvents.some((event) => event.slot === null || !event.txSig) ||
      new Set(normalizedEvents.map((event) => event.txSig)).size !== normalizedEvents.length ||
      maxSkippedHeadSlots === null ||
      pageSize === null ||
      maxSignaturePages === null ||
      rpcCallTimeoutMs === null ||
      !Number.isSafeInteger(startedAtMs) ||
      startedAtMs <= 0 ||
      !Number.isSafeInteger(requestedDeadlineMs)
    ) {
      return failure("invalid_request", "Pump creation-time request is invalid");
    }
    if (requestedDeadlineMs <= startedAtMs) {
      return deadlineFailure("cache lookup");
    }
    const deadline: Deadline = {
      deadlineMs: Math.min(requestedDeadlineMs, startedAtMs + MAX_OPERATION_BUDGET_MS),
      rpcCallTimeoutMs,
      nowMs,
    };

    const requiredFloor = Math.max(
      1,
      minimumFinalizedSlot ?? 1,
      ...normalizedEvents.map((event) => event.slot ?? 1),
    );
    const sampledHead = await sampleFreshTailFinalizedHead(this.rpc, {
      minimumSlot: requiredFloor,
      maxSkippedSlots: maxSkippedHeadSlots,
      rpcCallTimeoutMs,
      deadlineMs: deadline.deadlineMs,
      nowMs,
    });
    if (!sampledHead.ok) {
      if (sampledHead.code === "deadline_exceeded") {
        return failure("deadline_exceeded", sampledHead.reason, sampledHead.retryable);
      }
      if (sampledHead.code === "rpc_error") {
        if (
          remainingRpcTimeout(deadline) === null ||
          (/timed out/i.test(sampledHead.reason) &&
            deadline.deadlineMs - startedAtMs <= rpcCallTimeoutMs)
        ) {
          return deadlineFailure("the finalized head read");
        }
        return failure("rpc_error", sampledHead.reason, sampledHead.retryable);
      }
      return failure("finalized_head_unavailable", sampledHead.reason, sampledHead.retryable);
    }

    const finalizedEvents = await this.verifyRequiredFinalizedEvents(
      normalizedEvents as Array<{ slot: number; txSig: string }>,
      sampledHead.head,
      deadline,
    );
    if (!("events" in finalizedEvents)) return finalizedEvents;

    let source: "rpc" | "cache" = "cache";
    let proof = this.readCache(mintAddress, startedAtMs);
    if (!proof) {
      source = "rpc";
      const flightKey = this.cacheKey(mintAddress);
      let pending = this.inFlight.get(flightKey);
      if (!pending) {
        pending = this.resolveCreationProof(
          mint,
          sampledHead.head.slot,
          pageSize,
          maxSignaturePages,
          deadline,
        );
        this.inFlight.set(flightKey, pending);
        const cleanup = () => {
          if (this.inFlight.get(flightKey) === pending) this.inFlight.delete(flightKey);
        };
        void pending.then(cleanup, cleanup);
      }
      const waitTimeoutMs = remainingRpcTimeout(deadline);
      if (waitTimeoutMs === null) return deadlineFailure("the in-flight creation proof");
      let resolved: CreationResolution;
      try {
        resolved = await solanaRpcWithTimeout(pending, waitTimeoutMs);
      } catch (error) {
        return rpcFailureOrDeadline(deadline, "in-flight creation proof", error);
      }
      if (!resolved.ok) return resolved;
      proof = resolved.proof;
      this.writeCache(proof, Number(nowMs()));
    }

    // Creation scans can consume most of their bounded budget. Re-sample the
    // exact finalized head after the scan so a token cannot cross the maximum
    // age boundary while an older pre-scan timestamp still authorizes it.
    const finalHead = await sampleFreshTailFinalizedHead(this.rpc, {
      minimumSlot: sampledHead.head.slot,
      maxSkippedSlots: maxSkippedHeadSlots,
      rpcCallTimeoutMs,
      deadlineMs: deadline.deadlineMs,
      nowMs,
    });
    if (!finalHead.ok) {
      if (finalHead.code === "deadline_exceeded") {
        return failure("deadline_exceeded", finalHead.reason, finalHead.retryable);
      }
      if (finalHead.code === "rpc_error") {
        if (remainingRpcTimeout(deadline) === null) {
          return deadlineFailure("the final evaluation head read");
        }
        return failure("rpc_error", finalHead.reason, finalHead.retryable);
      }
      return failure("finalized_head_unavailable", finalHead.reason, finalHead.retryable);
    }
    if (
      finalHead.head.slot < sampledHead.head.slot ||
      finalHead.head.blockTimeMs < sampledHead.head.blockTimeMs
    ) {
      return failure(
        "finalized_head_unavailable",
        "finalized evaluation head regressed during creation-time resolution",
        true,
      );
    }
    const evaluatedAt = finalHead.head;

    if (proof.slot > evaluatedAt.slot || proof.blockTimeMs > evaluatedAt.blockTimeMs) {
      return failure(
        "creation_block_conflict",
        "Pump creation proof is later than the sampled finalized evaluation head",
      );
    }
    if (
      finalizedEvents.events.some(
        (event) =>
          proof.slot > event.slot ||
          proof.blockTimeMs > event.blockTimeMs ||
          event.blockTimeMs > evaluatedAt.blockTimeMs ||
          (proof.slot === event.slot &&
            (proof.blockhash !== event.blockhash ||
              (proof.txSig !== event.txSig && proof.transactionIndex >= event.transactionIndex))),
      )
    ) {
      return failure(
        "finalized_event_conflict",
        "finalized event, Pump creation, and evaluation head chronology do not agree",
      );
    }
    if (remainingRpcTimeout(deadline) === null) {
      return deadlineFailure("returning the creation-time proof");
    }

    return {
      ok: true,
      proof,
      source,
      evaluatedAt,
      evaluatedAtBlockTimeMs: evaluatedAt.blockTimeMs,
      finalizedEvents: finalizedEvents.events,
    };
  }

  private cacheKey(mint: string): string {
    // The resolver instance is connection/cluster scoped; the reviewed parser
    // ABI is explicit so a future parser upgrade cannot reuse an older proof.
    return `${PUMP_FUN_CREATE_PROOF_ABI}:${mint}`;
  }

  private readCache(mint: string, nowMs: number): PumpFunCreationTimeProof | null {
    const key = this.cacheKey(mint);
    const entry = this.cache.get(key);
    if (!entry) return null;
    const ageMs = nowMs - entry.cachedAtMs;
    if (!Number.isSafeInteger(ageMs) || ageMs < 0 || ageMs > this.cacheTtlMs) {
      this.cache.delete(key);
      return null;
    }
    // Map insertion order is the LRU order.
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.proof;
  }

  private writeCache(proof: PumpFunCreationTimeProof, nowMs: number): void {
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0) return;
    const key = this.cacheKey(proof.mint);
    this.cache.delete(key);
    this.cache.set(key, { proof, cachedAtMs: nowMs });
    while (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
  }

  private async verifyRequiredFinalizedEvents(
    events: Array<{ slot: number; txSig: string }>,
    evaluatedAt: FreshTailFinalizedHead,
    deadline: Deadline,
  ): Promise<{ events: PumpFunFinalizedEventProof[] } | PumpFunCreationTimeFailure> {
    if (events.length === 0) return { events: [] };
    if (events.some((event) => event.slot > evaluatedAt.slot)) {
      return failure(
        "finalized_event_unavailable",
        "sampled finalized head has not reached every required event slot",
        true,
      );
    }

    const statusTimeoutMs = remainingRpcTimeout(deadline);
    if (statusTimeoutMs === null) return deadlineFailure("the finalized event status proof");
    let statuses: Awaited<ReturnType<Connection["getSignatureStatuses"]>>;
    try {
      statuses = await solanaRpcWithTimeout(
        this.rpc.getSignatureStatuses(
          events.map((event) => event.txSig),
          { searchTransactionHistory: true },
        ),
        statusTimeoutMs,
      );
    } catch (error) {
      return rpcFailureOrDeadline(deadline, "finalized event status read", error);
    }
    const statusContextSlot = positiveSafeInteger(statuses?.context?.slot);
    if (
      !statuses ||
      !Array.isArray(statuses.value) ||
      statuses.value.length !== events.length ||
      statusContextSlot === null
    ) {
      return failure(
        "finalized_event_conflict",
        "finalized event status response does not match its request",
      );
    }
    if (statusContextSlot < Math.max(...events.map((event) => event.slot))) {
      return failure(
        "finalized_event_unavailable",
        "RPC status context has not reached every required event slot",
        true,
      );
    }
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      const status = statuses.value[index];
      if (!status) {
        return failure(
          "finalized_event_unavailable",
          "a required event has no finalized transaction status",
          true,
        );
      }
      if (status.err !== null || positiveSafeInteger(status.slot) !== event.slot) {
        return failure(
          "finalized_event_conflict",
          "a required event is failed or moved from its claimed slot",
        );
      }
      if (status.confirmationStatus !== "finalized") {
        return failure(
          "finalized_event_unavailable",
          "a required event has not reached finalized commitment",
          true,
        );
      }
    }

    const proofs: PumpFunFinalizedEventProof[] = [];
    const blocksBySlot = new Map<number, Awaited<ReturnType<Connection["getBlockSignatures"]>>>();
    for (const event of events) {
      let block = blocksBySlot.get(event.slot);
      if (!block) {
        const timeoutMs = remainingRpcTimeout(deadline);
        if (timeoutMs === null) return deadlineFailure("an exact finalized event block");
        try {
          block = await solanaRpcWithTimeout(
            this.rpc.getBlockSignatures(event.slot, "finalized"),
            timeoutMs,
          );
        } catch (error) {
          return rpcFailureOrDeadline(deadline, "exact finalized event block read", error);
        }
        if (!block) {
          return failure(
            "finalized_event_unavailable",
            "a required finalized event block is unavailable",
            true,
          );
        }
        blocksBySlot.set(event.slot, block);
      }
      const blockhash = typeof block.blockhash === "string" ? block.blockhash.trim() : "";
      const blockTime = positiveSafeInteger(block.blockTime);
      if (blockTime === null) {
        return failure(
          "block_time_unavailable",
          "a required finalized event block time is unavailable",
          true,
        );
      }
      if (
        !blockhash ||
        !Array.isArray(block.signatures) ||
        block.signatures.filter((signature) => signature === event.txSig).length !== 1
      ) {
        return failure(
          "finalized_event_conflict",
          "a required transaction is missing, duplicated, or moved from its claimed block",
        );
      }
      proofs.push({
        txSig: event.txSig,
        slot: event.slot,
        blockhash,
        blockTimeMs: blockTime * 1_000,
        transactionIndex: block.signatures.indexOf(event.txSig),
      });
    }
    return { events: proofs };
  }

  private async resolveCreationProof(
    mint: PublicKey,
    finalizedHeadSlot: number,
    pageSize: number,
    maxSignaturePages: number,
    deadline: Deadline,
  ): Promise<CreationResolution> {
    const scanned = await this.scanSignatures(
      mint,
      finalizedHeadSlot,
      pageSize,
      maxSignaturePages,
      deadline,
    );
    if (!("rows" in scanned)) return scanned;

    const firstAvailableTimeoutMs = remainingRpcTimeout(deadline);
    if (firstAvailableTimeoutMs === null) {
      return deadlineFailure("the first-available-block proof");
    }
    let firstAvailableBlock: number;
    try {
      firstAvailableBlock = await solanaRpcWithTimeout(
        this.rpc.getFirstAvailableBlock(),
        firstAvailableTimeoutMs,
      );
    } catch (error) {
      return rpcFailureOrDeadline(deadline, "first available block read", error);
    }
    if (
      nonNegativeSafeInteger(firstAvailableBlock) === null ||
      firstAvailableBlock > finalizedHeadSlot
    ) {
      return failure("signature_page_conflict", "RPC returned an invalid finalized history floor");
    }

    const candidate = await this.findCreateCandidate(
      mint.toBase58(),
      scanned.rows,
      finalizedHeadSlot,
      deadline,
    );
    if (!("candidate" in candidate)) return candidate;
    if (!candidate.candidate) {
      return failure(
        firstAvailableBlock > 0 ? "signature_history_pruned" : "create_not_found",
        firstAvailableBlock > 0
          ? "RPC history floor cannot prove that an earlier Pump create was not pruned"
          : "reviewed Pump create instruction was not found in finalized mint history",
        firstAvailableBlock === 0,
      );
    }
    if (firstAvailableBlock > candidate.candidate.row.slot) {
      return failure(
        "signature_history_pruned",
        "RPC history begins after the claimed Pump creation slot",
      );
    }
    return this.verifyCreationBlock(
      mint.toBase58(),
      candidate.candidate,
      finalizedHeadSlot,
      deadline,
    );
  }

  private async scanSignatures(
    mint: PublicKey,
    finalizedHeadSlot: number,
    pageSize: number,
    maxPages: number,
    deadline: Deadline,
  ): Promise<{ rows: SignatureRow[] } | PumpFunCreationTimeFailure> {
    const rows: SignatureRow[] = [];
    const seen = new Set<string>();
    let before: string | undefined;
    let previousSlot = Number.POSITIVE_INFINITY;

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const timeoutMs = remainingRpcTimeout(deadline);
      if (timeoutMs === null) return deadlineFailure("a finalized mint signature page");
      let page: SignatureRow[];
      try {
        page = await solanaRpcWithTimeout(
          this.rpc.getSignaturesForAddress(
            mint,
            {
              limit: pageSize,
              ...(before ? { before } : {}),
              minContextSlot: finalizedHeadSlot,
            },
            "finalized",
          ),
          timeoutMs,
        );
      } catch (error) {
        return rpcFailureOrDeadline(deadline, "finalized mint signature scan", error);
      }
      if (!Array.isArray(page)) {
        return failure("signature_page_conflict", "RPC returned a malformed signature page");
      }
      if (page.length === 0) return { rows };
      if (page.length > pageSize) {
        return failure("signature_page_conflict", "RPC exceeded the requested signature page size");
      }

      for (const row of page) {
        if (!validSignatureRow(row)) {
          return failure(
            "signature_page_conflict",
            "finalized mint signature history contains a malformed row",
          );
        }
        if (seen.has(row.signature) || row.slot > previousSlot) {
          return failure(
            "signature_page_conflict",
            "finalized mint signature pages are duplicated or unordered",
          );
        }
        seen.add(row.signature);
        previousSlot = row.slot;
        if (row.slot <= finalizedHeadSlot) rows.push(row);
      }

      const tail = page[page.length - 1];
      if (!tail?.signature || tail.signature === before) {
        return failure("signature_page_conflict", "signature pagination made no progress");
      }
      before = tail.signature;
    }

    return failure(
      "signature_page_limit",
      "finalized mint history did not terminate within the fixed page budget",
    );
  }

  private async findCreateCandidate(
    mint: string,
    rows: SignatureRow[],
    finalizedHeadSlot: number,
    deadline: Deadline,
  ): Promise<{ candidate: CreateCandidate | null } | PumpFunCreationTimeFailure> {
    const successfulRows = rows.filter((row) => row.err === null);
    let create: CreateCandidate | null = null;

    for (let offset = 0; offset < successfulRows.length; offset += TRANSACTION_BATCH_SIZE) {
      const batch = successfulRows.slice(offset, offset + TRANSACTION_BATCH_SIZE);
      const timeoutMs = remainingRpcTimeout(deadline);
      if (timeoutMs === null) return deadlineFailure("a finalized transaction batch");
      let transactions: Array<ParsedTransactionWithMeta | null>;
      try {
        transactions = await solanaRpcWithTimeout(
          this.rpc.getParsedTransactions(
            batch.map((row) => row.signature),
            { commitment: "finalized", maxSupportedTransactionVersion: 0 },
          ),
          timeoutMs,
        );
      } catch (error) {
        return rpcFailureOrDeadline(deadline, "finalized transaction batch read", error);
      }
      if (!Array.isArray(transactions) || transactions.length !== batch.length) {
        return failure(
          "transaction_identity_conflict",
          "finalized transaction batch length does not match its request",
        );
      }
      if (transactions.some((tx) => tx === null)) {
        return failure(
          "transaction_unavailable",
          "a finalized mint transaction required for creation proof is unavailable",
          true,
        );
      }

      // Batch response ordering is not an RPC contract. Rebind each response
      // to its exact first signature and reject duplicates or substitutions.
      const bySignature = new Map<string, ParsedTransactionWithMeta>();
      for (const transaction of transactions) {
        const tx = transaction!;
        const txSig = String(tx.transaction.signatures[0] ?? "");
        if (!txSig || bySignature.has(txSig)) {
          return failure(
            "transaction_identity_conflict",
            "finalized transaction batch has a missing or duplicate identity",
          );
        }
        bySignature.set(txSig, tx);
      }
      if (
        bySignature.size !== batch.length ||
        batch.some((row) => !bySignature.has(row.signature))
      ) {
        return failure(
          "transaction_identity_conflict",
          "finalized transaction batch does not match the requested signatures",
        );
      }

      for (const row of batch) {
        const tx = bySignature.get(row.signature)!;
        const txSig = String(tx.transaction.signatures[0] ?? "");
        const txSlot = positiveSafeInteger(tx.slot);
        const txBlockTime = positiveSafeInteger(tx.blockTime);
        if (
          txSig !== row.signature ||
          txSlot !== row.slot ||
          txSlot > finalizedHeadSlot ||
          txBlockTime === null ||
          (row.blockTime !== null && row.blockTime !== txBlockTime) ||
          tx.meta?.err !== null
        ) {
          return failure(
            "transaction_identity_conflict",
            "finalized transaction does not match its signature-page identity",
          );
        }
        const parsed = parsePumpFunCreateTransaction(tx, mint);
        if (parsed.kind === "malformed") {
          return failure("malformed_create_instruction", parsed.reason);
        }
        if (parsed.kind !== "valid") continue;
        if (create) {
          return failure("create_conflict", "more than one finalized Pump create proof exists");
        }
        create = { row, tx, parsed: parsed.value };
      }
    }

    return { candidate: create };
  }

  private async verifyCreationBlock(
    mint: string,
    create: CreateCandidate,
    finalizedHeadSlot: number,
    deadline: Deadline,
  ): Promise<CreationResolution> {
    const timeoutMs = remainingRpcTimeout(deadline);
    if (timeoutMs === null) return deadlineFailure("the exact finalized creation block");
    let block: Awaited<ReturnType<Connection["getBlockSignatures"]>>;
    try {
      block = await solanaRpcWithTimeout(
        this.rpc.getBlockSignatures(create.row.slot, "finalized"),
        timeoutMs,
      );
    } catch (error) {
      return rpcFailureOrDeadline(deadline, "exact finalized creation block read", error);
    }
    if (!block) {
      return failure(
        "creation_block_unavailable",
        "finalized Pump creation block is unavailable",
        true,
      );
    }
    const blockhash = typeof block.blockhash === "string" ? block.blockhash.trim() : "";
    const blockTime = positiveSafeInteger(block.blockTime);
    const txBlockTime = positiveSafeInteger(create.tx.blockTime);
    if (blockTime === null || txBlockTime === null) {
      return failure(
        "block_time_unavailable",
        "finalized Pump creation block time is unavailable",
        true,
      );
    }
    if (
      !blockhash ||
      !Array.isArray(block.signatures) ||
      block.signatures.filter((signature) => signature === create.row.signature).length !== 1 ||
      blockTime !== txBlockTime ||
      (create.row.blockTime !== null && create.row.blockTime !== blockTime)
    ) {
      return failure(
        "creation_block_conflict",
        "finalized creation transaction, signature history, and block do not agree",
      );
    }
    const resolvedAtMs = Number(deadline.nowMs());
    if (!Number.isSafeInteger(resolvedAtMs) || resolvedAtMs <= 0) {
      return failure("invalid_request", "Pump creation-time clock became invalid");
    }
    if (resolvedAtMs >= deadline.deadlineMs) {
      return deadlineFailure("returning the exact finalized creation block");
    }
    const blockTimeMs = blockTime * 1_000;
    return {
      ok: true,
      proof: {
        parserAbi: PUMP_FUN_CREATE_PROOF_ABI,
        mint,
        creator: create.parsed.creator,
        bondingCurve: create.parsed.bondingCurve,
        createVariant: create.parsed.variant,
        tokenProgram: create.parsed.tokenProgram,
        txSig: create.row.signature,
        slot: create.row.slot,
        blockTimeMs,
        blockhash,
        transactionIndex: block.signatures.indexOf(create.row.signature),
        finalizedHeadSlot,
        resolvedAtMs,
      },
    };
  }
}
