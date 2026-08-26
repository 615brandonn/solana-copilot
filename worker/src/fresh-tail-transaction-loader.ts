import type {
  ConfirmedSignatureInfo,
  Connection,
  ParsedTransactionWithMeta,
} from "@solana/web3.js";
import { solanaRpcWithTimeout } from "./pump-fun-supply.js";

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_RPC_TIMEOUT_MS = 4_000;
const DEFAULT_OPERATION_BUDGET_MS = 45_000;

export type FreshTailParsedTransaction = {
  signature: ConfirmedSignatureInfo;
  transaction: ParsedTransactionWithMeta;
};

export type FreshTailTransactionLoadFailureCode =
  | "invalid_request"
  | "deadline_exceeded"
  | "rpc_error"
  | "transaction_unavailable"
  | "transaction_identity_conflict";

export type FreshTailTransactionLoadResult =
  | { ok: true; transactions: FreshTailParsedTransaction[]; batchesRead: number }
  | {
      ok: false;
      code: FreshTailTransactionLoadFailureCode;
      reason: string;
      retryable: boolean;
      batchesRead: number;
    };

export type FreshTailTransactionLoadRequest = {
  signatures: readonly ConfirmedSignatureInfo[];
  batchSize?: number;
  rpcCallTimeoutMs?: number;
  /** Absolute wall-clock deadline shared with the enclosing lane processor. */
  deadlineMs?: number;
  nowMs?: () => number;
};

export type FreshTailTransactionConnection = Pick<Connection, "getParsedTransactions">;

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

function positiveSlot(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function failure(
  code: FreshTailTransactionLoadFailureCode,
  reason: string,
  batchesRead: number,
  retryable = false,
): FreshTailTransactionLoadResult {
  return { ok: false, code, reason, retryable, batchesRead };
}

function validSignatureRow(row: ConfirmedSignatureInfo): boolean {
  return (
    typeof row?.signature === "string" &&
    row.signature.trim().length > 0 &&
    positiveSlot(row.slot) !== null &&
    row.confirmationStatus === "finalized" &&
    row.err !== undefined &&
    (row.blockTime === null ||
      (Number.isSafeInteger(row.blockTime) && Number(row.blockTime) > 0))
  );
}

/**
 * Loads the exact finalized transactions selected by a signature scan. RPC
 * batch order is not trusted: every response is rebound to its first signature
 * and then returned in the caller's durable scan order. Any missing, duplicate,
 * stale, or identity-mismatched row blocks cursor advancement.
 */
export async function loadFreshTailFinalizedTransactions(
  rpc: FreshTailTransactionConnection,
  request: FreshTailTransactionLoadRequest,
): Promise<FreshTailTransactionLoadResult> {
  const batchSize = boundedInteger(request.batchSize, DEFAULT_BATCH_SIZE, 1, 50);
  const timeoutMs = boundedInteger(
    request.rpcCallTimeoutMs,
    DEFAULT_RPC_TIMEOUT_MS,
    250,
    30_000,
  );
  const nowMs = request.nowMs ?? Date.now;
  const startedAtMs = Number(nowMs());
  const deadlineMs = Number(request.deadlineMs ?? startedAtMs + DEFAULT_OPERATION_BUDGET_MS);
  if (
    batchSize === null ||
    timeoutMs === null ||
    !Number.isSafeInteger(startedAtMs) ||
    startedAtMs <= 0 ||
    !Number.isSafeInteger(deadlineMs) ||
    !Array.isArray(request.signatures)
  ) {
    return failure("invalid_request", "fresh-tail transaction load request is invalid", 0);
  }

  const seenRequested = new Set<string>();
  for (const row of request.signatures) {
    if (!validSignatureRow(row) || seenRequested.has(row.signature)) {
      return failure(
        "invalid_request",
        "fresh-tail transaction signature set is malformed or duplicated",
        0,
      );
    }
    seenRequested.add(row.signature);
  }

  const loaded: FreshTailParsedTransaction[] = [];
  let batchesRead = 0;
  for (let offset = 0; offset < request.signatures.length; offset += batchSize) {
    const batch = request.signatures.slice(offset, offset + batchSize);
    const remainingMs = deadlineMs - Number(nowMs());
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      return failure(
        "deadline_exceeded",
        "fresh-tail transaction loader exhausted its absolute wall-clock budget",
        batchesRead,
        true,
      );
    }

    let transactions: Array<ParsedTransactionWithMeta | null>;
    try {
      transactions = await solanaRpcWithTimeout(
        rpc.getParsedTransactions(
          batch.map((row) => row.signature),
          { commitment: "finalized", maxSupportedTransactionVersion: 0 },
        ),
        Math.max(1, Math.min(timeoutMs, Math.floor(remainingMs))),
      );
    } catch (error) {
      return failure(
        "rpc_error",
        `fresh-tail finalized transaction batch failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        batchesRead,
        true,
      );
    }
    batchesRead += 1;
    if (transactions.length !== batch.length || transactions.some((tx) => tx === null)) {
      return failure(
        "transaction_unavailable",
        "a finalized transaction required for fresh-tail coverage is unavailable",
        batchesRead,
        true,
      );
    }

    const bySignature = new Map<string, ParsedTransactionWithMeta>();
    for (const transaction of transactions) {
      const tx = transaction!;
      const signature = String(tx.transaction?.signatures?.[0] ?? "").trim();
      if (!signature || bySignature.has(signature)) {
        return failure(
          "transaction_identity_conflict",
          "fresh-tail transaction batch contains a missing or duplicate identity",
          batchesRead,
        );
      }
      bySignature.set(signature, tx);
    }
    if (
      bySignature.size !== batch.length ||
      batch.some((row) => !bySignature.has(row.signature))
    ) {
      return failure(
        "transaction_identity_conflict",
        "fresh-tail transaction batch does not match the requested signature set",
        batchesRead,
      );
    }

    for (const row of batch) {
      const transaction = bySignature.get(row.signature)!;
      const slot = positiveSlot(transaction.slot);
      const blockTime = Number(transaction.blockTime);
      if (
        slot !== row.slot ||
        !Number.isSafeInteger(blockTime) ||
        blockTime <= 0 ||
        (row.blockTime !== null && blockTime !== row.blockTime) ||
        !transaction.meta ||
        (row.err === null) !== (transaction.meta.err === null)
      ) {
        return failure(
          "transaction_identity_conflict",
          "fresh-tail parsed transaction does not match its finalized signature identity",
          batchesRead,
        );
      }
      loaded.push({ signature: row, transaction });
    }
  }

  return { ok: true, transactions: loaded, batchesRead };
}
