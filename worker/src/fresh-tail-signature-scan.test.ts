import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import {
  scanFreshTailFinalizedSignatures,
  type FreshTailSignatureConnection,
} from "./fresh-tail-signature-scan.js";

const wallet = new PublicKey(Uint8Array.from({ length: 32 }, () => 4)).toBase58();

function row(signature: string, slot: number, options: { failed?: boolean } = {}) {
  return {
    signature,
    slot,
    blockTime: 1_800_000_000 + slot,
    err: options.failed ? { InstructionError: [0, "Custom"] } : null,
    memo: null,
    confirmationStatus: "finalized" as const,
  };
}

function fakeRpc(
  pages: ReturnType<typeof row>[][],
  firstAvailableBlock = 1,
  observedRequests: Array<Record<string, unknown>> = [],
): FreshTailSignatureConnection {
  let index = 0;
  return {
    async getSignaturesForAddress(_wallet, options, commitment) {
      observedRequests.push({ ...options, commitment });
      return (pages[index++] ?? []) as any;
    },
    async getFirstAvailableBlock() {
      return firstAvailableBlock;
    },
  } as FreshTailSignatureConnection;
}

test("root activation floor is exclusive and RPC proof is finalized at H", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const result = await scanFreshTailFinalizedSignatures(
    fakeRpc([[row("newest", 103), row("middle", 102)], [row("activation", 100)]], 1, requests),
    {
      wallet,
      boundary: { kind: "floor", slot: 100, inclusive: false },
      finalizedHeadSlot: 103,
      pageSize: 2,
    },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(
      result.signatures.map((item) => item.signature),
      ["middle", "newest"],
    );
    assert.equal(result.checkpoint?.signature, "newest");
    assert.equal(result.coveredThroughSlot, 103);
    assert.equal(result.firstAvailableBlock, 1);
  }
  assert.deepEqual(requests, [
    { limit: 2, minContextSlot: 103, commitment: "finalized" },
    { limit: 2, before: "middle", minContextSlot: 103, commitment: "finalized" },
  ]);
});

test("child discovery floor is inclusive, including every same-slot signature", async () => {
  const result = await scanFreshTailFinalizedSignatures(
    fakeRpc([[row("later", 104), row("same-b", 101), row("same-a", 101), row("older", 100)]]),
    {
      wallet,
      boundary: { kind: "floor", slot: 101, inclusive: true },
      finalizedHeadSlot: 104,
    },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(
      result.signatures.map((item) => item.signature),
      ["same-a", "same-b", "later"],
    );
  }
});

test("exact cursor resumes only from the exact signature and never a slot fallback", async () => {
  const success = await scanFreshTailFinalizedSignatures(
    fakeRpc([[row("new", 105), row("cursor", 103), row("same-slot-sibling", 103)]]),
    {
      wallet,
      boundary: { kind: "signature", signature: "cursor", slot: 103 },
      finalizedHeadSlot: 105,
    },
  );
  assert.equal(success.ok, true);
  if (success.ok)
    assert.deepEqual(
      success.signatures.map((item) => item.signature),
      ["new"],
    );

  const missing = await scanFreshTailFinalizedSignatures(
    fakeRpc([[row("new", 105), row("same-slot-sibling", 103), row("older", 102)], []]),
    {
      wallet,
      boundary: { kind: "signature", signature: "cursor", slot: 103 },
      finalizedHeadSlot: 105,
    },
  );
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "exact_cursor_missing");
});

test("floor exhaustion requires firstAvailableBlock at or before the floor", async () => {
  const complete = await scanFreshTailFinalizedSignatures(fakeRpc([[row("only", 102)], []], 99), {
    wallet,
    boundary: { kind: "floor", slot: 100, inclusive: false },
    finalizedHeadSlot: 102,
  });
  assert.equal(complete.ok, true);
  if (complete.ok) {
    assert.equal(complete.firstAvailableBlock, 99);
    assert.deepEqual(
      complete.signatures.map((item) => item.signature),
      ["only"],
    );
  }

  const pruned = await scanFreshTailFinalizedSignatures(fakeRpc([[row("only", 102)], []], 101), {
    wallet,
    boundary: { kind: "floor", slot: 100, inclusive: false },
    finalizedHeadSlot: 102,
  });
  assert.equal(pruned.ok, false);
  if (!pruned.ok) assert.equal(pruned.code, "history_pruned");
});

test("rows finalized after sampled H are validated but deferred", async () => {
  const result = await scanFreshTailFinalizedSignatures(
    fakeRpc([[row("after-head", 110), row("at-head", 108), row("cursor", 105)]]),
    {
      wallet,
      boundary: { kind: "signature", signature: "cursor", slot: 105 },
      finalizedHeadSlot: 108,
    },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(
      result.signatures.map((item) => item.signature),
      ["at-head"],
    );
    assert.equal(result.checkpoint?.signature, "at-head");
  }
});

test("failed finalized transactions remain in the contiguous checkpoint range", async () => {
  const result = await scanFreshTailFinalizedSignatures(
    fakeRpc([[row("failed", 102, { failed: true }), row("floor", 100)]]),
    {
      wallet,
      boundary: { kind: "floor", slot: 100, inclusive: false },
      finalizedHeadSlot: 102,
    },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.signatures.length, 1);
    assert.notEqual(result.signatures[0]?.err, null);
    assert.equal(result.checkpoint?.signature, "failed");
  }
});

test("duplicates, invalid order, and page budget exhaustion fail closed", async () => {
  const duplicate = await scanFreshTailFinalizedSignatures(
    fakeRpc([[row("dup", 105)], [row("dup", 105)]]),
    {
      wallet,
      boundary: { kind: "floor", slot: 100, inclusive: false },
      finalizedHeadSlot: 105,
      pageSize: 1,
    },
  );
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.code, "page_conflict");

  const reordered = await scanFreshTailFinalizedSignatures(
    fakeRpc([[row("old", 102), row("new", 103)]]),
    {
      wallet,
      boundary: { kind: "floor", slot: 100, inclusive: false },
      finalizedHeadSlot: 103,
    },
  );
  assert.equal(reordered.ok, false);
  if (!reordered.ok) assert.equal(reordered.code, "page_conflict");

  const capped = await scanFreshTailFinalizedSignatures(fakeRpc([[row("new", 103)]]), {
    wallet,
    boundary: { kind: "floor", slot: 100, inclusive: false },
    finalizedHeadSlot: 103,
    maxPages: 1,
  });
  assert.equal(capped.ok, false);
  if (!capped.ok) assert.equal(capped.code, "page_limit");
});

test("absolute scan deadline stops sequential pages and caps each RPC timeout", async () => {
  let clock = 10_000;
  let calls = 0;
  const rpc = {
    async getSignaturesForAddress() {
      calls += 1;
      clock += 600;
      return [row(`sig-${calls}`, 110 - calls)];
    },
    async getFirstAvailableBlock() {
      throw new Error("must not reach floor proof");
    },
  } as FreshTailSignatureConnection;
  const result = await scanFreshTailFinalizedSignatures(rpc, {
    wallet,
    boundary: { kind: "floor", slot: 100, inclusive: false },
    finalizedHeadSlot: 110,
    pageSize: 1,
    maxPages: 20,
    deadlineMs: 11_000,
    nowMs: () => clock,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "deadline_exceeded");
    assert.equal(result.retryable, true);
  }
  assert.equal(calls, 2);
});
