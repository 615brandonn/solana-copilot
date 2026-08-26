import assert from "node:assert/strict";
import test from "node:test";
import {
  freshTailHeadProofIsFresh,
  resolveFreshTailExactFinalizedBlock,
  sampleFreshTailFinalizedHead,
  type FreshTailFinalizedHeadConnection,
} from "./fresh-tail-finalized-head.js";

function rpc(options: {
  slot?: number;
  blocks?: Map<number, { blockhash: string; blockTime: number | null } | null>;
  throwAt?: number;
  requests?: Array<{ slot: number; config: unknown }>;
} = {}): FreshTailFinalizedHeadConnection {
  return {
    async getSlot(commitment) {
      assert.equal(commitment, "finalized");
      return options.slot ?? 105;
    },
    async getBlock(slot, config) {
      options.requests?.push({ slot, config });
      if (options.throwAt === slot) throw new Error("temporary RPC failure");
      if (options.blocks?.has(slot)) return options.blocks.get(slot) as any;
      return {
        blockhash: `hash-${slot}`,
        blockTime: 1_800_000_000 + slot,
      } as any;
    },
  } as FreshTailFinalizedHeadConnection;
}

test("walks skipped finalized slots backward and returns exact hash and time", async () => {
  const requests: Array<{ slot: number; config: unknown }> = [];
  const blocks = new Map([
    [105, null],
    [104, null],
    [103, { blockhash: "canonical-103", blockTime: 1_800_000_103 }],
  ]);
  const result = await sampleFreshTailFinalizedHead(rpc({ blocks, requests }), {
    minimumSlot: 100,
    nowMs: () => 2_000_000_000_000,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.head, {
      slot: 103,
      blockhash: "canonical-103",
      blockTimeMs: 1_800_000_103_000,
      sampledAtMs: 2_000_000_000_000,
    });
    assert.equal(result.skippedSlots, 2);
  }
  assert.deepEqual(
    requests.map((item) => item.slot),
    [105, 104, 103],
  );
  assert.deepEqual(requests[0]?.config, {
    commitment: "finalized",
    transactionDetails: "none",
    rewards: false,
    maxSupportedTransactionVersion: 0,
  });
});

test("never walks a skipped head below the required trigger slot", async () => {
  const blocks = new Map<number, { blockhash: string; blockTime: number | null } | null>([
    [102, null],
    [101, null],
    [100, { blockhash: "too-old", blockTime: 1_800_000_100 }],
  ]);
  const result = await sampleFreshTailFinalizedHead(rpc({ slot: 102, blocks }), {
    minimumSlot: 101,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "head_unavailable");
    assert.equal(result.retryable, true);
  }
});

test("missing time on a real canonical block blocks instead of treating it as skipped", async () => {
  const requests: Array<{ slot: number; config: unknown }> = [];
  const blocks = new Map<number, { blockhash: string; blockTime: number | null } | null>([
    [105, { blockhash: "hash-105", blockTime: null }],
    [104, { blockhash: "hash-104", blockTime: 1_800_000_104 }],
  ]);
  const result = await sampleFreshTailFinalizedHead(rpc({ blocks, requests }), {
    minimumSlot: 100,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "head_block_time_unavailable");
  assert.deepEqual(
    requests.map((item) => item.slot),
    [105],
  );
});

test("RPC errors are retryable and malformed canonical identity is definitive", async () => {
  const temporary = await sampleFreshTailFinalizedHead(rpc({ throwAt: 105 }), {
    minimumSlot: 100,
  });
  assert.equal(temporary.ok, false);
  if (!temporary.ok) {
    assert.equal(temporary.code, "rpc_error");
    assert.equal(temporary.retryable, true);
  }

  const blocks = new Map<number, { blockhash: string; blockTime: number | null } | null>([
    [105, { blockhash: "", blockTime: 1_800_000_105 }],
  ]);
  const malformed = await sampleFreshTailFinalizedHead(rpc({ blocks }), { minimumSlot: 100 });
  assert.equal(malformed.ok, false);
  if (!malformed.ok) {
    assert.equal(malformed.code, "head_block_invalid");
    assert.equal(malformed.retryable, false);
  }
});

test("proof freshness accepts at most the configured 3-5 second authorization window", () => {
  assert.equal(freshTailHeadProofIsFresh(10_000, 14_000), true);
  assert.equal(freshTailHeadProofIsFresh(10_000, 14_001), false);
  assert.equal(freshTailHeadProofIsFresh(10_000, 15_000, 5_000), true);
  assert.equal(freshTailHeadProofIsFresh(10_000, 15_001, 5_000), false);
  assert.equal(freshTailHeadProofIsFresh(10_000, 9_999), false);
  assert.equal(freshTailHeadProofIsFresh(10_000, 11_000, 999), false);
});

test("absolute head deadline stops a long skipped-slot walk", async () => {
  let clock = 20_000;
  let blockCalls = 0;
  const slow = {
    async getSlot() {
      clock += 100;
      return 110;
    },
    async getBlock() {
      blockCalls += 1;
      clock += 500;
      return null;
    },
  } as FreshTailFinalizedHeadConnection;
  const result = await sampleFreshTailFinalizedHead(slow, {
    minimumSlot: 100,
    maxSkippedSlots: 64,
    deadlineMs: 21_000,
    nowMs: () => clock,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "deadline_exceeded");
  assert.equal(blockCalls, 2);
});

test("materially future canonical block time fails closed", async () => {
  const blocks = new Map<number, { blockhash: string; blockTime: number | null } | null>([
    [105, { blockhash: "hash-105", blockTime: 31 }],
  ]);
  const result = await sampleFreshTailFinalizedHead(rpc({ blocks }), {
    minimumSlot: 100,
    nowMs: () => 25_000,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "head_block_time_unavailable");
});

test("exact event block resolver never backwalks and binds transaction block time", async () => {
  const requests: Array<{ slot: number; config: unknown }> = [];
  const blocks = new Map<number, { blockhash: string; blockTime: number | null } | null>([
    [103, { blockhash: "enrollment-103", blockTime: 1_800_000_103 }],
  ]);
  const result = await resolveFreshTailExactFinalizedBlock(rpc({ blocks, requests }), {
    slot: 103,
    expectedBlockTimeMs: 1_800_000_103_000,
    nowMs: () => 2_000_000_000_000,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.head.blockhash, "enrollment-103");
    assert.equal(result.head.blockTimeMs, 1_800_000_103_000);
  }
  assert.deepEqual(requests.map((request) => request.slot), [103]);
});

test("null or time-mismatched exact event block fails closed without a fallback slot", async () => {
  const requests: Array<{ slot: number; config: unknown }> = [];
  const missing = await resolveFreshTailExactFinalizedBlock(
    rpc({ blocks: new Map([[103, null]]), requests }),
    { slot: 103 },
  );
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "head_unavailable");
  assert.deepEqual(requests.map((request) => request.slot), [103]);

  const mismatch = await resolveFreshTailExactFinalizedBlock(
    rpc({ blocks: new Map([[103, { blockhash: "hash", blockTime: 100 }]]) }),
    { slot: 103, expectedBlockTimeMs: 101_000, nowMs: () => 200_000 },
  );
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) {
    assert.equal(mismatch.code, "head_block_invalid");
    assert.equal(mismatch.retryable, false);
  }
});
