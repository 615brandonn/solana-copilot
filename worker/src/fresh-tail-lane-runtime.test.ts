import assert from "node:assert/strict";
import test from "node:test";
import type { ConfirmedSignatureInfo, ParsedTransactionWithMeta } from "@solana/web3.js";
import {
  freshTailBoundaryForCursor,
  freshTailCandidateIsActionable,
  processFreshTailLane,
  type FreshTailLaneConnection,
  type FreshTailLaneCursor,
} from "./fresh-tail-lane-runtime.js";

const wallet = "11111111111111111111111111111111";
const head = {
  slot: 120,
  blockhash: "head-hash",
  blockTimeMs: 1_000_000,
  sampledAtMs: 1_001_000,
};

function row(value: string, slot: number): ConfirmedSignatureInfo {
  return {
    signature: value,
    slot,
    blockTime: 1_000,
    confirmationStatus: "finalized",
    err: null,
    memo: null,
  };
}

function tx(value: string, slot: number): ParsedTransactionWithMeta {
  return {
    slot,
    blockTime: 1_000,
    meta: { err: null } as any,
    transaction: {
      signatures: [value],
      message: { accountKeys: [], instructions: [], recentBlockhash: "hash" } as any,
    },
    version: "legacy",
  } as ParsedTransactionWithMeta;
}

function rpc(rows: ConfirmedSignatureInfo[]): FreshTailLaneConnection {
  return {
    async getSignaturesForAddress(_wallet: any, options: any) {
      if (options.before) return [];
      return rows;
    },
    async getFirstAvailableBlock() {
      return 1;
    },
    async getParsedTransactions(signatures: string[]) {
      return [...signatures].reverse().map((value) => {
        const match = rows.find((candidate) => candidate.signature === value)!;
        return tx(value, match.slot);
      });
    },
  } as FreshTailLaneConnection;
}

function cursor(overrides: Partial<FreshTailLaneCursor> = {}): FreshTailLaneCursor {
  return {
    scopeMint: "*",
    wallet,
    role: "root",
    floorSlot: 100,
    boundaryKind: "exclusive_slot",
    lastSignature: null,
    lastSlot: null,
    firstAvailableBlock: null,
    coverageRevision: 0,
    ...overrides,
  };
}

test("event and child persistence finish before the parent cursor advances", async () => {
  const order: string[] = [];
  await processFreshTailLane({
    rpc: rpc([row("new", 110), row("floor", 100)]),
    cursor: cursor(),
    head,
    deadlineMs: Date.now() + 10_000,
    assertLease: () => {
      order.push("lease");
    },
    async persistTransaction() {
      order.push("event");
      await Promise.resolve();
      order.push("child");
      return 1;
    },
    async persistCursor(write) {
      order.push("cursor");
      assert.equal(write.nextLastSignature, "new");
      assert.equal(write.coverageRevision, 0);
    },
  });
  assert.ok(order.indexOf("event") < order.indexOf("child"));
  assert.ok(order.indexOf("child") < order.indexOf("cursor"));
});

test("root child scope bump never leaks into the permanent revision-zero cursor", async () => {
  const writes: number[] = [];
  await processFreshTailLane({
    rpc: rpc([row("root-buy-forward", 110), row("floor", 100)]),
    cursor: cursor(),
    head,
    deadlineMs: Date.now() + 10_000,
    assertLease: () => undefined,
    async persistTransaction() {
      // Event, child edge, and sync have durably advanced the mint revision.
      return 9;
    },
    async persistCursor(write) {
      writes.push(write.coverageRevision);
    },
  });
  assert.deepEqual(writes, [0]);
});

test("event failure or lease loss leaves the durable cursor untouched", async () => {
  let cursorWrites = 0;
  await assert.rejects(
    processFreshTailLane({
      rpc: rpc([row("new", 110), row("floor", 100)]),
      cursor: cursor(),
      head,
      deadlineMs: Date.now() + 10_000,
      assertLease: () => undefined,
      persistTransaction: async () => {
        throw new Error("child persistence failed");
      },
      persistCursor: async () => {
        cursorWrites += 1;
      },
    }),
    /child persistence failed/,
  );
  assert.equal(cursorWrites, 0);

  let assertions = 0;
  await assert.rejects(
    processFreshTailLane({
      rpc: rpc([row("new", 110), row("floor", 100)]),
      cursor: cursor(),
      head,
      deadlineMs: Date.now() + 10_000,
      assertLease: () => {
        assertions += 1;
        if (assertions >= 3) throw new Error("lease lost");
      },
      persistTransaction: async () => 0,
      persistCursor: async () => {
        cursorWrites += 1;
      },
    }),
    /lease lost/,
  );
  assert.equal(cursorWrites, 0);
});

test("restart resumes from the exact durable signature without a slot fallback", async () => {
  const durable = cursor({
    boundaryKind: "exact_signature",
    lastSignature: "cursor-sig",
    lastSlot: 109,
    firstAvailableBlock: 1,
  });
  assert.deepEqual(freshTailBoundaryForCursor(durable), {
    kind: "signature",
    signature: "cursor-sig",
    slot: 109,
  });
  const processed: string[] = [];
  await processFreshTailLane({
    rpc: rpc([row("new", 110), row("cursor-sig", 109)]),
    cursor: durable,
    head,
    deadlineMs: Date.now() + 10_000,
    assertLease: () => undefined,
    async persistTransaction(_tx, signature) {
      processed.push(signature.signature);
      return 0;
    },
    async persistCursor(write) {
      assert.equal(write.expectedLastSignature, "cursor-sig");
      assert.equal(write.nextLastSignature, "new");
    },
  });
  assert.deepEqual(processed, ["new"]);
});

test("a gap beyond eight pages fails closed without event or cursor writes", async () => {
  const rows = Array.from({ length: 8_001 }, (_, index) => row(`new-${index}`, 9_000 - index));
  rows.push(row("cursor-sig", 999));
  const bySignature = new Map(rows.map((entry, index) => [entry.signature, index]));
  const deepRpc = {
    async getSignaturesForAddress(_wallet: unknown, options: { before?: string }) {
      const start = options.before ? (bySignature.get(options.before) ?? rows.length) + 1 : 0;
      return rows.slice(start, start + 1_000);
    },
    async getFirstAvailableBlock() {
      return 1;
    },
    async getParsedTransactions() {
      throw new Error("transactions must not load before the exact boundary is discovered");
    },
  } as FreshTailLaneConnection;
  let eventWrites = 0;
  let cursorWrites = 0;
  await assert.rejects(
    processFreshTailLane({
      rpc: deepRpc,
      cursor: cursor({
        boundaryKind: "exact_signature",
        lastSignature: "cursor-sig",
        lastSlot: 999,
        firstAvailableBlock: 1,
      }),
      head: { ...head, slot: 9_000 },
      deadlineMs: Date.now() + 10_000,
      assertLease: () => undefined,
      persistTransaction: async () => {
        eventWrites += 1;
        return 0;
      },
      persistCursor: async () => {
        cursorWrites += 1;
      },
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "page_limit",
  );
  assert.equal(eventWrites, 0);
  assert.equal(cursorWrites, 0);
});

test("55-second candidate deadline reserves time for settlement and submission", () => {
  const trigger = 1_000_000;
  assert.equal(freshTailCandidateIsActionable(trigger, trigger + 50_999), true);
  assert.equal(freshTailCandidateIsActionable(trigger, trigger + 51_000), false);
  assert.equal(freshTailCandidateIsActionable(trigger, trigger + 55_000), false);
});
