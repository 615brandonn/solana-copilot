import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConfirmedSignatureInfo,
  ParsedTransactionWithMeta,
} from "@solana/web3.js";
import {
  loadFreshTailFinalizedTransactions,
  type FreshTailTransactionConnection,
} from "./fresh-tail-transaction-loader.js";

function signature(
  value: string,
  slot: number,
  options: { blockTime?: number | null; failed?: boolean } = {},
): ConfirmedSignatureInfo {
  return {
    signature: value,
    slot,
    blockTime: options.blockTime === undefined ? 100 + slot : options.blockTime,
    confirmationStatus: "finalized",
    err: options.failed ? { InstructionError: [0, "Custom"] } : null,
    memo: null,
  };
}

function transaction(row: ConfirmedSignatureInfo): ParsedTransactionWithMeta {
  return {
    slot: row.slot,
    blockTime: row.blockTime ?? 100 + row.slot,
    meta: {
      err: row.err,
      fee: 5_000,
      preBalances: [],
      postBalances: [],
      preTokenBalances: [],
      postTokenBalances: [],
      logMessages: [],
      innerInstructions: [],
      loadedAddresses: { writable: [], readonly: [] },
      computeUnitsConsumed: 1,
      rewards: [],
      status: row.err ? { Err: row.err } : { Ok: null },
    },
    transaction: {
      signatures: [row.signature],
      message: { accountKeys: [], instructions: [], recentBlockhash: "hash" } as any,
    },
    version: "legacy",
  } as ParsedTransactionWithMeta;
}

function rpc(
  handler: (
    signatures: string[],
    call: number,
  ) => Promise<Array<ParsedTransactionWithMeta | null>>,
): FreshTailTransactionConnection & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async getParsedTransactions(signatures: string[], options: any) {
      assert.equal(options.commitment, "finalized");
      assert.equal(options.maxSupportedTransactionVersion, 0);
      calls.push([...signatures]);
      return handler(signatures, calls.length);
    },
  } as FreshTailTransactionConnection & { calls: string[][] };
}

test("rebinds reordered RPC batches and preserves durable scan order", async () => {
  const rows = [signature("oldest", 10), signature("middle", 11), signature("newest", 12)];
  const connection = rpc(async (requested) =>
    [...requested].reverse().map((value) => transaction(rows.find((row) => row.signature === value)!)),
  );
  const result = await loadFreshTailFinalizedTransactions(connection, {
    signatures: rows,
    batchSize: 2,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.batchesRead, 2);
  assert.deepEqual(
    result.transactions.map((row) => row.signature.signature),
    ["oldest", "middle", "newest"],
  );
  assert.deepEqual(connection.calls, [["oldest", "middle"], ["newest"]]);
});

test("accepts a finalized failed transaction while preserving failure identity", async () => {
  const row = signature("failed", 20, { failed: true });
  const result = await loadFreshTailFinalizedTransactions(
    rpc(async () => [transaction(row)]),
    { signatures: [row] },
  );
  assert.equal(result.ok, true);
});

test("fails closed on absent, substituted, duplicate, or stale transaction identity", async () => {
  const row = signature("expected", 30);
  const unavailable = await loadFreshTailFinalizedTransactions(rpc(async () => [null]), {
    signatures: [row],
  });
  assert.deepEqual(
    unavailable.ok ? null : [unavailable.code, unavailable.retryable],
    ["transaction_unavailable", true],
  );

  const substituted = transaction(signature("other", 30));
  const wrongSet = await loadFreshTailFinalizedTransactions(rpc(async () => [substituted]), {
    signatures: [row],
  });
  assert.equal(wrongSet.ok ? null : wrongSet.code, "transaction_identity_conflict");

  const duplicateRows = await loadFreshTailFinalizedTransactions(rpc(async () => []), {
    signatures: [row, row],
  });
  assert.equal(duplicateRows.ok ? null : duplicateRows.code, "invalid_request");

  const stale = transaction(row);
  stale.slot = 31;
  const staleResult = await loadFreshTailFinalizedTransactions(rpc(async () => [stale]), {
    signatures: [row],
  });
  assert.equal(staleResult.ok ? null : staleResult.code, "transaction_identity_conflict");
});

test("does not begin another batch after the shared absolute deadline", async () => {
  const rows = [signature("first", 40), signature("second", 41)];
  let now = 1_000;
  const connection = rpc(async (requested) => {
    now = 2_001;
    return requested.map((value) => transaction(rows.find((row) => row.signature === value)!));
  });
  const result = await loadFreshTailFinalizedTransactions(connection, {
    signatures: rows,
    batchSize: 1,
    deadlineMs: 2_000,
    nowMs: () => now,
  });
  assert.deepEqual(
    result.ok ? null : [result.code, result.retryable, result.batchesRead],
    ["deadline_exceeded", true, 1],
  );
  assert.equal(connection.calls.length, 1);
});

test("empty signature coverage succeeds without touching RPC", async () => {
  const connection = rpc(async () => {
    throw new Error("must not call RPC");
  });
  const result = await loadFreshTailFinalizedTransactions(connection, { signatures: [] });
  assert.deepEqual(result, { ok: true, transactions: [], batchesRead: 0 });
  assert.equal(connection.calls.length, 0);
});
