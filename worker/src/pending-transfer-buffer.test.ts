import assert from "node:assert/strict";
import test from "node:test";

import { PendingTransferBuffer } from "./pending-transfer-buffer.js";
import type { TransferEvent } from "./geyser.js";

function transfer(txSig: string, overrides: Partial<TransferEvent> = {}): TransferEvent {
  return {
    kind: "transfer",
    from: "target",
    to: `recipient-${txSig}`,
    tokenMint: "mint-a",
    amountTokens: 1,
    decimals: 6,
    slot: 100,
    txSig,
    timestampMs: 1_000,
    source: "geyser",
    ...overrides,
  };
}

test("deduplicates an atomic recipient batch by signature, sender, and mint", () => {
  const pending = new PendingTransferBuffer();
  const original = transfer("sig");

  assert.equal(pending.add(original, 1_000), true);
  assert.equal(pending.add({ ...original, amountTokens: 2, source: "rpc" }, 1_001), false);
  assert.equal(pending.add({ ...original, txSig: "other-sig" }, 1_002), true);
  assert.equal(pending.add({ ...original, from: "other-sender" }, 1_003), true);
  assert.equal(pending.add({ ...original, to: "other-recipient" }, 1_004), false);
  assert.equal(pending.add({ ...original, tokenMint: "mint-b" }, 1_005), true);
  assert.equal(pending.size, 4);
});

test("enforces the per-mint limit without evicting another mint", () => {
  const pending = new PendingTransferBuffer({
    ttlMs: 10_000,
    maxEntries: 10,
    maxEntriesPerMint: 2,
  });

  pending.add(transfer("a-1"), 1);
  pending.add(transfer("b-1", { tokenMint: "mint-b" }), 2);
  pending.add(transfer("a-2"), 3);
  pending.add(transfer("a-3"), 4);

  assert.deepEqual(
    pending.drainForLandedBuy("mint-a", 0, 5).map((event) => event.txSig),
    ["a-2", "a-3"],
  );
  assert.deepEqual(
    pending.drainForLandedBuy("mint-b", 0, 5).map((event) => event.txSig),
    ["b-1"],
  );
});

test("enforces the global limit by evicting the oldest transfer", () => {
  const pending = new PendingTransferBuffer({
    ttlMs: 10_000,
    maxEntries: 3,
    maxEntriesPerMint: 3,
  });

  pending.add(transfer("a-1"), 1);
  pending.add(transfer("b-1", { tokenMint: "mint-b" }), 2);
  pending.add(transfer("a-2"), 3);
  pending.add(transfer("c-1", { tokenMint: "mint-c" }), 4);

  assert.deepEqual(
    pending.drainForLandedBuy("mint-a", 0, 5).map((event) => event.txSig),
    ["a-2"],
  );
  assert.equal(pending.size, 2);
});

test("expires entries by observation time and permits them to be observed again", () => {
  const pending = new PendingTransferBuffer({
    ttlMs: 100,
    maxEntries: 10,
    maxEntriesPerMint: 10,
  });
  const event = transfer("sig");

  assert.equal(pending.add(event, 1_000), true);
  assert.equal(pending.add(event, 1_100), false);
  assert.equal(pending.add(event, 1_101), true);
  assert.deepEqual(pending.drainForLandedBuy("mint-a", 0, 1_201), [event]);
  assert.deepEqual(pending.drainForLandedBuy("mint-a", 0, 1_202), []);
});

test("a landed buy drains only transfers at or after its slot", () => {
  const pending = new PendingTransferBuffer();
  pending.add(transfer("before", { slot: 99 }), 1_000);
  pending.add(transfer("same", { slot: 100 }), 1_001);
  pending.add(transfer("after", { slot: 101 }), 1_002);

  assert.deepEqual(
    pending.drainForLandedBuy("mint-a", 100, 1_003).map((event) => event.txSig),
    ["same", "after"],
  );
  assert.equal(pending.sizeForMint("mint-a"), 0);
});

test("missing transfer or entry slots fall back to TTL eligibility", () => {
  const pending = new PendingTransferBuffer({
    ttlMs: 100,
    maxEntries: 10,
    maxEntriesPerMint: 10,
  });
  pending.add(transfer("missing-transfer-slot", { slot: 0 }), 1_000);
  pending.add(transfer("normal-slot", { slot: 50 }), 1_001);

  assert.deepEqual(
    pending.drainForLandedBuy("mint-a", 100, 1_050).map((event) => event.txSig),
    ["missing-transfer-slot"],
  );

  pending.add(transfer("missing-entry-slot", { slot: 1 }), 2_000);
  assert.deepEqual(
    pending.drainForLandedBuy("mint-a", undefined, 2_050).map((event) => event.txSig),
    ["missing-entry-slot"],
  );
});

test("drain preserves first-observed chronological order", () => {
  const pending = new PendingTransferBuffer();
  pending.add(transfer("first", { timestampMs: 3_000 }), 10);
  pending.add(transfer("second", { timestampMs: 1_000 }), 20);
  pending.add(transfer("third", { timestampMs: 2_000 }), 30);

  assert.deepEqual(
    pending.drainForLandedBuy("mint-a", 1, 40).map((event) => event.txSig),
    ["first", "second", "third"],
  );
  assert.deepEqual(pending.drainForLandedBuy("mint-a", 1, 41), []);
});

test("rejects unbounded or unusable limits", () => {
  assert.throws(
    () => new PendingTransferBuffer({ maxEntries: 0 }),
    /maxEntries must be a positive integer/,
  );
  assert.throws(
    () => new PendingTransferBuffer({ maxEntriesPerMint: Number.POSITIVE_INFINITY }),
    /maxEntriesPerMint must be a positive integer/,
  );
  assert.throws(() => new PendingTransferBuffer({ ttlMs: -1 }), /ttlMs must be a positive integer/);
});
