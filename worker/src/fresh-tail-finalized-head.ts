import type { Connection } from "@solana/web3.js";
import { solanaRpcWithTimeout } from "./pump-fun-supply.js";

const DEFAULT_RPC_TIMEOUT_MS = 4_000;
const DEFAULT_MAX_SKIPPED_SLOTS = 64;
const DEFAULT_OPERATION_BUDGET_MS = 15_000;
const MAX_FUTURE_BLOCK_TIME_MS = 5_000;

export type FreshTailFinalizedHead = {
  slot: number;
  blockhash: string;
  blockTimeMs: number;
  sampledAtMs: number;
};

export type FreshTailFinalizedHeadFailureCode =
  | "invalid_request"
  | "deadline_exceeded"
  | "rpc_error"
  | "head_below_minimum"
  | "head_unavailable"
  | "head_block_invalid"
  | "head_block_time_unavailable";

export type FreshTailFinalizedHeadResult =
  | { ok: true; head: FreshTailFinalizedHead; skippedSlots: number }
  | {
      ok: false;
      code: FreshTailFinalizedHeadFailureCode;
      reason: string;
      retryable: boolean;
    };

export type FreshTailFinalizedHeadRequest = {
  /** A trigger/activation floor the canonical head is never allowed to cross. */
  minimumSlot: number;
  maxSkippedSlots?: number;
  rpcCallTimeoutMs?: number;
  /** Absolute wall-clock deadline; this sampler never owns the full 55s window. */
  deadlineMs?: number;
  nowMs?: () => number;
};

export type FreshTailFinalizedHeadConnection = Pick<Connection, "getSlot" | "getBlock">;

export type FreshTailExactFinalizedBlockRequest = {
  slot: number;
  expectedBlockTimeMs?: number;
  rpcCallTimeoutMs?: number;
  deadlineMs?: number;
  nowMs?: () => number;
};

function safePositiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
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
  code: FreshTailFinalizedHeadFailureCode,
  reason: string,
  retryable: boolean,
): FreshTailFinalizedHeadResult {
  return { ok: false, code, reason, retryable };
}

/**
 * Samples an exact canonical finalized head. `getSlot("finalized")` may name a
 * skipped slot, so null blocks are walked backwards. A real block with missing
 * identity/time is not treated as skipped, and the walk can never cross the
 * trigger/activation floor supplied by the caller.
 */
export async function sampleFreshTailFinalizedHead(
  rpc: FreshTailFinalizedHeadConnection,
  request: FreshTailFinalizedHeadRequest,
): Promise<FreshTailFinalizedHeadResult> {
  const minimumSlot = safePositiveInteger(request.minimumSlot);
  const maxSkippedSlots = boundedInteger(
    request.maxSkippedSlots,
    DEFAULT_MAX_SKIPPED_SLOTS,
    0,
    512,
  );
  const timeoutMs = boundedInteger(
    request.rpcCallTimeoutMs,
    DEFAULT_RPC_TIMEOUT_MS,
    250,
    30_000,
  );
  const nowMs = request.nowMs ?? Date.now;
  const startedAtMs = Number(nowMs());
  const deadlineMs = Number(request.deadlineMs ?? startedAtMs + DEFAULT_OPERATION_BUDGET_MS);
  if (minimumSlot === null || maxSkippedSlots === null || timeoutMs === null) {
    return failure("invalid_request", "fresh-tail finalized head request is invalid", false);
  }
  if (
    !Number.isSafeInteger(startedAtMs) ||
    startedAtMs <= 0 ||
    !Number.isSafeInteger(deadlineMs)
  ) {
    return failure("invalid_request", "fresh-tail finalized head clock is invalid", false);
  }

  const remainingTimeout = (): number | null => {
    const remaining = deadlineMs - Number(nowMs());
    return Number.isFinite(remaining) && remaining > 0
      ? Math.max(1, Math.min(timeoutMs, Math.floor(remaining)))
      : null;
  };

  let reportedSlot: number;
  const slotTimeoutMs = remainingTimeout();
  if (slotTimeoutMs === null) {
    return failure(
      "deadline_exceeded",
      "fresh-tail finalized head sampling deadline elapsed before the slot read",
      true,
    );
  }
  try {
    reportedSlot = await solanaRpcWithTimeout(rpc.getSlot("finalized"), slotTimeoutMs);
  } catch (error) {
    return failure(
      "rpc_error",
      `fresh-tail finalized slot read failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      true,
    );
  }
  if (safePositiveInteger(reportedSlot) === null) {
    return failure("head_block_invalid", "RPC returned an invalid finalized slot", false);
  }
  if (reportedSlot < minimumSlot) {
    return failure(
      "head_below_minimum",
      "finalized head has not reached the required trigger slot",
      true,
    );
  }

  let skippedSlots = 0;
  for (let slot = reportedSlot; slot >= minimumSlot; slot -= 1) {
    if (skippedSlots > maxSkippedSlots) {
      return failure(
        "head_unavailable",
        "no canonical finalized block was found within the skipped-slot budget",
        true,
      );
    }
    let block: Awaited<ReturnType<Connection["getBlock"]>>;
    const blockTimeoutMs = remainingTimeout();
    if (blockTimeoutMs === null) {
      return failure(
        "deadline_exceeded",
        "fresh-tail finalized head exhausted its absolute wall-clock budget",
        true,
      );
    }
    try {
      block = await solanaRpcWithTimeout(
        rpc.getBlock(slot, {
          commitment: "finalized",
          transactionDetails: "none",
          rewards: false,
          maxSupportedTransactionVersion: 0,
        }),
        blockTimeoutMs,
      );
    } catch (error) {
      return failure(
        "rpc_error",
        `fresh-tail finalized block read failed at ${slot}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        true,
      );
    }
    if (!block) {
      skippedSlots += 1;
      continue;
    }

    const blockhash = typeof block.blockhash === "string" ? block.blockhash.trim() : "";
    if (!blockhash) {
      return failure("head_block_invalid", "canonical finalized blockhash is missing", false);
    }
    const blockTime = Number(block.blockTime);
    if (!Number.isSafeInteger(blockTime) || blockTime <= 0) {
      return failure(
        "head_block_time_unavailable",
        "canonical finalized block time is unavailable",
        true,
      );
    }
    const sampledAtMs = Number(nowMs());
    if (!Number.isSafeInteger(sampledAtMs) || sampledAtMs <= 0) {
      return failure("invalid_request", "fresh-tail sampling clock is invalid", false);
    }
    if (blockTime * 1_000 > sampledAtMs + MAX_FUTURE_BLOCK_TIME_MS) {
      return failure(
        "head_block_time_unavailable",
        "canonical finalized block time is materially ahead of the worker clock",
        true,
      );
    }
    return {
      ok: true,
      head: { slot, blockhash, blockTimeMs: blockTime * 1_000, sampledAtMs },
      skippedSlots,
    };
  }

  return failure(
    "head_unavailable",
    "all finalized slots at or above the required floor were skipped",
    true,
  );
}

/** Resolves the exact finalized block containing an enrollment/creation event.
 * Unlike head sampling this never walks: a null block at an event's claimed
 * slot makes the transaction identity unprovable and must be retried. */
export async function resolveFreshTailExactFinalizedBlock(
  rpc: Pick<Connection, "getBlock">,
  request: FreshTailExactFinalizedBlockRequest,
): Promise<FreshTailFinalizedHeadResult> {
  const slot = safePositiveInteger(request.slot);
  const timeoutMs = boundedInteger(
    request.rpcCallTimeoutMs,
    DEFAULT_RPC_TIMEOUT_MS,
    250,
    30_000,
  );
  const expectedBlockTimeMs =
    request.expectedBlockTimeMs === undefined
      ? null
      : safePositiveInteger(request.expectedBlockTimeMs);
  const nowMs = request.nowMs ?? Date.now;
  const sampledAt = Number(nowMs());
  const deadlineMs = Number(request.deadlineMs ?? sampledAt + DEFAULT_OPERATION_BUDGET_MS);
  if (
    slot === null ||
    timeoutMs === null ||
    (request.expectedBlockTimeMs !== undefined && expectedBlockTimeMs === null) ||
    !Number.isSafeInteger(sampledAt) ||
    sampledAt <= 0 ||
    !Number.isSafeInteger(deadlineMs)
  ) {
    return failure("invalid_request", "exact finalized block request is invalid", false);
  }
  const remaining = deadlineMs - Number(nowMs());
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return failure(
      "deadline_exceeded",
      "exact finalized block deadline elapsed before the RPC read",
      true,
    );
  }
  let block: Awaited<ReturnType<Connection["getBlock"]>>;
  try {
    block = await solanaRpcWithTimeout(
      rpc.getBlock(slot, {
        commitment: "finalized",
        transactionDetails: "none",
        rewards: false,
        maxSupportedTransactionVersion: 0,
      }),
      Math.max(1, Math.min(timeoutMs, Math.floor(remaining))),
    );
  } catch (error) {
    return failure(
      "rpc_error",
      `exact finalized block read failed at ${slot}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      true,
    );
  }
  if (!block) {
    return failure(
      "head_unavailable",
      "the claimed finalized event slot has no canonical block",
      true,
    );
  }
  const blockhash = typeof block.blockhash === "string" ? block.blockhash.trim() : "";
  const blockTimeSeconds = Number(block.blockTime);
  if (!blockhash) {
    return failure("head_block_invalid", "exact finalized blockhash is missing", false);
  }
  if (!Number.isSafeInteger(blockTimeSeconds) || blockTimeSeconds <= 0) {
    return failure(
      "head_block_time_unavailable",
      "exact finalized block time is unavailable",
      true,
    );
  }
  const blockTimeMs = blockTimeSeconds * 1_000;
  const finishedAt = Number(nowMs());
  if (!Number.isSafeInteger(finishedAt) || finishedAt <= 0) {
    return failure("invalid_request", "exact finalized block clock is invalid", false);
  }
  if (blockTimeMs > finishedAt + MAX_FUTURE_BLOCK_TIME_MS) {
    return failure(
      "head_block_time_unavailable",
      "exact finalized block time is materially ahead of the worker clock",
      true,
    );
  }
  if (expectedBlockTimeMs !== null && expectedBlockTimeMs !== blockTimeMs) {
    return failure(
      "head_block_invalid",
      "finalized transaction and exact block time do not match",
      false,
    );
  }
  return {
    ok: true,
    head: { slot, blockhash, blockTimeMs, sampledAtMs: finishedAt },
    skippedSlots: 0,
  };
}

/** Call immediately before the final SQL authorization. A stale proof must be
 * re-headed and re-settled; callers must perform no await between the successful
 * final authorization and handing the transaction to the network sender. */
export function freshTailHeadProofIsFresh(
  sampledAtMs: number,
  nowMs = Date.now(),
  maximumAgeMs = 4_000,
): boolean {
  return (
    Number.isSafeInteger(sampledAtMs) &&
    sampledAtMs > 0 &&
    Number.isSafeInteger(nowMs) &&
    nowMs >= sampledAtMs &&
    Number.isSafeInteger(maximumAgeMs) &&
    maximumAgeMs >= 1_000 &&
    maximumAgeMs <= 5_000 &&
    nowMs - sampledAtMs <= maximumAgeMs
  );
}
