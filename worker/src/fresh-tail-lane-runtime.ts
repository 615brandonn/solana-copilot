import type { ConfirmedSignatureInfo, ParsedTransactionWithMeta } from "@solana/web3.js";
import {
  scanFreshTailFinalizedSignatures,
  type FreshTailScanBoundary,
  type FreshTailSignatureConnection,
} from "./fresh-tail-signature-scan.js";
import {
  loadFreshTailFinalizedTransactions,
  type FreshTailTransactionConnection,
} from "./fresh-tail-transaction-loader.js";
import type { FreshTailFinalizedHead } from "./fresh-tail-finalized-head.js";
import type { FreshTailCursorWrite } from "./fresh-tail-store.js";

export type FreshTailLaneCursor = {
  scopeMint: string;
  wallet: string;
  role: "root" | "descendant";
  floorSlot: number;
  boundaryKind: "exclusive_slot" | "inclusive_slot" | "exact_signature";
  lastSignature: string | null;
  lastSlot: number | null;
  firstAvailableBlock: number | null;
  coverageRevision: number;
};

export type FreshTailLaneConnection = FreshTailSignatureConnection &
  FreshTailTransactionConnection;

export type FreshTailLaneResult = {
  processedSignatures: number;
  pagesRead: number;
  batchesRead: number;
  coverageRevision: number;
  nextLastSignature: string | null;
  nextLastSlot: number | null;
};

export class FreshTailLaneError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "FreshTailLaneError";
  }
}

export function freshTailBoundaryForCursor(cursor: FreshTailLaneCursor): FreshTailScanBoundary {
  if (cursor.boundaryKind === "exact_signature") {
    if (!cursor.lastSignature || !Number.isSafeInteger(cursor.lastSlot) || cursor.lastSlot! <= 0) {
      throw new FreshTailLaneError(
        "cursor_identity_invalid",
        false,
        "fresh-tail exact cursor is missing its durable signature identity",
      );
    }
    return { kind: "signature", signature: cursor.lastSignature, slot: cursor.lastSlot! };
  }
  if (cursor.lastSignature !== null || cursor.lastSlot !== null) {
    throw new FreshTailLaneError(
      "cursor_identity_invalid",
      false,
      "fresh-tail slot cursor unexpectedly contains an exact signature",
    );
  }
  return {
    kind: "floor",
    slot: cursor.floorSlot,
    inclusive: cursor.boundaryKind === "inclusive_slot",
  };
}

export function freshTailCandidateIsActionable(
  triggerBlockTimeMs: number,
  nowMs: number,
  actionWindowMs = 55_000,
  reserveMs = 4_000,
): boolean {
  return (
    Number.isSafeInteger(triggerBlockTimeMs) &&
    triggerBlockTimeMs > 0 &&
    Number.isSafeInteger(nowMs) &&
    nowMs >= triggerBlockTimeMs - 5_000 &&
    Number.isSafeInteger(actionWindowMs) &&
    actionWindowMs === 55_000 &&
    Number.isSafeInteger(reserveMs) &&
    reserveMs >= 0 &&
    reserveMs <= 10_000 &&
    nowMs < triggerBlockTimeMs + actionWindowMs - reserveMs
  );
}

/**
 * Processes one exact root/descendant lane. The caller's transaction callback
 * must durably persist every decoded event and apply every new child edge.
 * Only after every callback succeeds and the lease assertion still holds is
 * the durable cursor allowed to advance to the sampled canonical head.
 */
export async function processFreshTailLane(input: {
  rpc: FreshTailLaneConnection;
  cursor: FreshTailLaneCursor;
  head: FreshTailFinalizedHead;
  deadlineMs: number;
  nowMs?: () => number;
  assertLease: () => void | Promise<void>;
  persistTransaction: (
    transaction: ParsedTransactionWithMeta,
    signature: ConfirmedSignatureInfo,
    currentCoverageRevision: number,
  ) => Promise<number>;
  persistCursor: (write: FreshTailCursorWrite) => Promise<void>;
  pageSize?: number;
  maxPages?: number;
  rpcCallTimeoutMs?: number;
}): Promise<FreshTailLaneResult> {
  await input.assertLease();
  const boundary = freshTailBoundaryForCursor(input.cursor);
  const scan = await scanFreshTailFinalizedSignatures(input.rpc, {
    wallet: input.cursor.wallet,
    boundary,
    finalizedHeadSlot: input.head.slot,
    pageSize: input.pageSize,
    maxPages: input.maxPages,
    rpcCallTimeoutMs: input.rpcCallTimeoutMs,
    deadlineMs: input.deadlineMs,
    nowMs: input.nowMs,
  });
  if (!scan.ok) throw new FreshTailLaneError(scan.code, scan.retryable, scan.reason);

  const loaded = await loadFreshTailFinalizedTransactions(input.rpc, {
    signatures: scan.signatures,
    rpcCallTimeoutMs: input.rpcCallTimeoutMs,
    deadlineMs: input.deadlineMs,
    nowMs: input.nowMs,
  });
  if (!loaded.ok) throw new FreshTailLaneError(loaded.code, loaded.retryable, loaded.reason);

  let coverageRevision = input.cursor.coverageRevision;
  for (const row of loaded.transactions) {
    await input.assertLease();
    const persistedRevision = await input.persistTransaction(
      row.transaction,
      row.signature,
      coverageRevision,
    );
    if (!Number.isSafeInteger(persistedRevision) || persistedRevision < 0) {
      throw new FreshTailLaneError(
        "scope_revision_invalid",
        false,
        "fresh-tail transaction persistence returned an invalid scope revision",
      );
    }
    // SQL's shared three-root namespace is permanently revision zero. A root
    // transaction may enroll a mint and synchronously add a child at mint
    // revision one, but that child revision must never leak into the root
    // cursor write. Mint-scoped descendant/backscan lanes track it exactly.
    if (input.cursor.role === "descendant") coverageRevision = persistedRevision;
  }

  const checkpoint = scan.checkpoint;
  const nextLastSignature = checkpoint?.signature ?? input.cursor.lastSignature;
  const nextLastSlot = checkpoint?.slot ?? input.cursor.lastSlot;
  const firstAvailableBlock = scan.firstAvailableBlock ?? input.cursor.firstAvailableBlock;
  if (!Number.isSafeInteger(firstAvailableBlock) || firstAvailableBlock! < 0) {
    throw new FreshTailLaneError(
      "history_floor_unproved",
      false,
      "fresh-tail lane cannot advance without a durable first-available-block witness",
    );
  }

  await input.assertLease();
  await input.persistCursor({
    scopeMint: input.cursor.scopeMint,
    wallet: input.cursor.wallet,
    expectedLastSignature: input.cursor.lastSignature,
    nextLastSignature,
    nextLastSlot,
    lastBlockTimeSeconds: checkpoint?.blockTime ?? null,
    firstAvailableBlock: firstAvailableBlock!,
    coveredHead: input.head,
    coverageRevision,
    backlogDetected: false,
    lastError: null,
  });
  return {
    processedSignatures: loaded.transactions.length,
    pagesRead: scan.pagesRead,
    batchesRead: loaded.batchesRead,
    coverageRevision,
    nextLastSignature,
    nextLastSlot,
  };
}
