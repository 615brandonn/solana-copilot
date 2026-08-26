import { PublicKey, type ConfirmedSignatureInfo, type Connection } from "@solana/web3.js";
import { solanaRpcWithTimeout } from "./pump-fun-supply.js";

const DEFAULT_PAGE_SIZE = 1_000;
const DEFAULT_MAX_PAGES = 8;
const DEFAULT_RPC_TIMEOUT_MS = 4_000;
const DEFAULT_OPERATION_BUDGET_MS = 45_000;

export type FreshTailFloorBoundary = {
  kind: "floor";
  slot: number;
  /** Roots exclude activation; newly discovered children include their discovery slot. */
  inclusive: boolean;
};

export type FreshTailExactBoundary = {
  kind: "signature";
  signature: string;
  slot: number;
};

export type FreshTailScanBoundary = FreshTailFloorBoundary | FreshTailExactBoundary;

export type FreshTailSignatureScanFailureCode =
  | "invalid_request"
  | "deadline_exceeded"
  | "rpc_error"
  | "history_pruned"
  | "exact_cursor_missing"
  | "page_limit"
  | "page_conflict";

export type FreshTailSignatureScanResult =
  | {
      ok: true;
      signatures: ConfirmedSignatureInfo[];
      checkpoint: ConfirmedSignatureInfo | null;
      firstAvailableBlock: number | null;
      coveredThroughSlot: number;
      pagesRead: number;
    }
  | {
      ok: false;
      code: FreshTailSignatureScanFailureCode;
      reason: string;
      retryable: boolean;
      pagesRead: number;
    };

export type FreshTailSignatureScanRequest = {
  wallet: string;
  boundary: FreshTailScanBoundary;
  finalizedHeadSlot: number;
  pageSize?: number;
  maxPages?: number;
  rpcCallTimeoutMs?: number;
  /** Absolute wall-clock deadline; callers should leave time to settle/send. */
  deadlineMs?: number;
  nowMs?: () => number;
};

export type FreshTailSignatureConnection = Pick<
  Connection,
  "getSignaturesForAddress" | "getFirstAvailableBlock"
>;

function positiveSlot(value: unknown): number | null {
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

function fail(
  code: FreshTailSignatureScanFailureCode,
  reason: string,
  pagesRead: number,
  retryable = false,
): FreshTailSignatureScanResult {
  return { ok: false, code, reason, retryable, pagesRead };
}

function validSignatureRow(row: ConfirmedSignatureInfo): boolean {
  return (
    typeof row?.signature === "string" &&
    row.signature.trim().length > 0 &&
    positiveSlot(row.slot) !== null &&
    (row.blockTime === null ||
      (Number.isSafeInteger(row.blockTime) && Number(row.blockTime) > 0)) &&
    row.confirmationStatus === "finalized" &&
    row.err !== undefined
  );
}

/**
 * Reads one finalized address range without ever falling back from an exact
 * signature cursor to a slot. Work is released only after the trusted lower
 * boundary has been found (or an unpruned floor has been exhausted).
 */
export async function scanFreshTailFinalizedSignatures(
  rpc: FreshTailSignatureConnection,
  request: FreshTailSignatureScanRequest,
): Promise<FreshTailSignatureScanResult> {
  let wallet: PublicKey;
  try {
    wallet = new PublicKey(request.wallet);
  } catch {
    return fail("invalid_request", "fresh-tail wallet is not a public key", 0);
  }
  const headSlot = positiveSlot(request.finalizedHeadSlot);
  const boundarySlot = positiveSlot(request.boundary.slot);
  const pageSize = boundedInteger(request.pageSize, DEFAULT_PAGE_SIZE, 1, 1_000);
  const maxPages = boundedInteger(request.maxPages, DEFAULT_MAX_PAGES, 1, 64);
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
    headSlot === null ||
    boundarySlot === null ||
    pageSize === null ||
    maxPages === null ||
    timeoutMs === null ||
    !Number.isSafeInteger(startedAtMs) ||
    startedAtMs <= 0 ||
    !Number.isSafeInteger(deadlineMs) ||
    boundarySlot > headSlot ||
    (request.boundary.kind === "signature" && !request.boundary.signature.trim())
  ) {
    return fail("invalid_request", "fresh-tail signature range is invalid", 0);
  }

  const remainingTimeout = (): number | null => {
    const remaining = deadlineMs - Number(nowMs());
    return Number.isFinite(remaining) && remaining > 0
      ? Math.max(1, Math.min(timeoutMs, Math.floor(remaining)))
      : null;
  };

  const seen = new Set<string>();
  const newestFirst: ConfirmedSignatureInfo[] = [];
  let previousSlot = Number.POSITIVE_INFINITY;
  let before: string | undefined;
  let reachedBoundary = false;
  let firstAvailableBlock: number | null = null;
  let pagesRead = 0;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    let page: ConfirmedSignatureInfo[];
    const pageTimeoutMs = remainingTimeout();
    if (pageTimeoutMs === null) {
      return fail(
        "deadline_exceeded",
        "fresh-tail signature scan exhausted its absolute wall-clock budget",
        pagesRead,
        true,
      );
    }
    try {
      page = await solanaRpcWithTimeout(
        rpc.getSignaturesForAddress(
          wallet,
          {
            limit: pageSize,
            ...(before ? { before } : {}),
            minContextSlot: headSlot,
          },
          "finalized",
        ),
        pageTimeoutMs,
      );
    } catch (error) {
      return fail(
        "rpc_error",
        `fresh-tail finalized signature read failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        pagesRead,
        true,
      );
    }
    pagesRead += 1;

    if (page.length === 0) {
      if (request.boundary.kind === "signature") {
        return fail(
          "exact_cursor_missing",
          "fresh-tail exact durable signature is absent from RPC history",
          pagesRead,
          true,
        );
      }
      try {
        const floorTimeoutMs = remainingTimeout();
        if (floorTimeoutMs === null) {
          return fail(
            "deadline_exceeded",
            "fresh-tail signature scan exhausted its absolute wall-clock budget",
            pagesRead,
            true,
          );
        }
        firstAvailableBlock = await solanaRpcWithTimeout(
          rpc.getFirstAvailableBlock(),
          floorTimeoutMs,
        );
      } catch (error) {
        return fail(
          "rpc_error",
          `fresh-tail first available block read failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          pagesRead,
          true,
        );
      }
      if (!Number.isSafeInteger(firstAvailableBlock) || firstAvailableBlock < 0) {
        return fail(
          "page_conflict",
          "fresh-tail RPC returned an invalid first available block",
          pagesRead,
        );
      }
      if (firstAvailableBlock > boundarySlot) {
        return fail(
          "history_pruned",
          "fresh-tail RPC history does not reach the durable slot floor",
          pagesRead,
        );
      }
      reachedBoundary = true;
      break;
    }

    let pageTail: string | undefined;
    for (const row of page) {
      if (!validSignatureRow(row) || seen.has(row.signature) || row.slot > previousSlot) {
        return fail(
          "page_conflict",
          "fresh-tail signature pages are duplicated, unordered, or malformed",
          pagesRead,
        );
      }
      seen.add(row.signature);
      previousSlot = row.slot;
      pageTail = row.signature;

      if (request.boundary.kind === "signature") {
        if (row.signature === request.boundary.signature) {
          if (row.slot !== boundarySlot) {
            return fail(
              "page_conflict",
              "fresh-tail exact signature moved to a different slot",
              pagesRead,
            );
          }
          reachedBoundary = true;
          break;
        }
      } else {
        const crossedFloor = request.boundary.inclusive
          ? row.slot < boundarySlot
          : row.slot <= boundarySlot;
        if (crossedFloor) {
          reachedBoundary = true;
          break;
        }
      }

      if (row.slot <= headSlot) newestFirst.push(row);
    }

    if (reachedBoundary) break;
    if (!pageTail || pageTail === before) {
      return fail("page_conflict", "fresh-tail pagination made no progress", pagesRead);
    }
    before = pageTail;
  }

  if (!reachedBoundary) {
    return fail(
      "page_limit",
      "fresh-tail pagination did not reach its trusted boundary within the fixed page budget",
      pagesRead,
      true,
    );
  }

  // A floor cursor must durably attest that RPC history reaches the floor even
  // when the final page itself contained an older row. The row proves this
  // logically, but SQL stores firstAvailableBlock as the provider-retention
  // witness and must never receive a guessed value.
  if (request.boundary.kind === "floor" && firstAvailableBlock === null) {
    const floorTimeoutMs = remainingTimeout();
    if (floorTimeoutMs === null) {
      return fail(
        "deadline_exceeded",
        "fresh-tail signature scan exhausted its budget before history-floor proof",
        pagesRead,
        true,
      );
    }
    try {
      firstAvailableBlock = await solanaRpcWithTimeout(
        rpc.getFirstAvailableBlock(),
        floorTimeoutMs,
      );
    } catch (error) {
      return fail(
        "rpc_error",
        `fresh-tail first available block read failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        pagesRead,
        true,
      );
    }
    if (!Number.isSafeInteger(firstAvailableBlock) || firstAvailableBlock < 0) {
      return fail(
        "page_conflict",
        "fresh-tail RPC returned an invalid first available block",
        pagesRead,
      );
    }
    if (firstAvailableBlock > boundarySlot) {
      return fail(
        "history_pruned",
        "fresh-tail RPC history does not reach the durable slot floor",
        pagesRead,
      );
    }
  }

  return {
    ok: true,
    // Reversal preserves RPC's within-slot order instead of inventing a slot
    // tie-breaker. The checkpoint is the newest processed row, not the last
    // element after an arbitrary sort.
    signatures: newestFirst.slice().reverse(),
    checkpoint: newestFirst[0] ?? null,
    firstAvailableBlock,
    coveredThroughSlot: headSlot,
    pagesRead,
  };
}
