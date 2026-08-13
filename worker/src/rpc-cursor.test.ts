import assert from "node:assert/strict";
import test from "node:test";
import type { ConfirmedSignatureInfo } from "@solana/web3.js";

import {
  createSupabaseRpcCursorStore,
  planNextRpcSignaturePage,
  planRpcSignaturePages,
  rpcSignaturesOldestFirst,
  sanitizeRpcCursorError,
  takeOldestRpcRecoveryChunk,
} from "./rpc-cursor.js";

type Row = Record<string, unknown>;

class MemoryQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: Array<[string, unknown]> = [];
  private returnRows = false;

  constructor(
    private readonly rows: Row[],
    private readonly operation: "select" | "upsert" | "update",
    private readonly values?: Row,
    private readonly options?: { ignoreDuplicates?: boolean },
  ) {}

  select(): this {
    this.returnRows = true;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push([column, value]);
    return this;
  }

  private matches(row: Row): boolean {
    return this.filters.every(([column, value]) => row[column] === value);
  }

  private execute(): { data: unknown; error: unknown } {
    if (this.operation === "select") {
      return { data: this.rows.filter((row) => this.matches(row)), error: null };
    }
    if (this.operation === "upsert") {
      const values = this.values ?? {};
      const existing = this.rows.find(
        (row) => row.user_id === values.user_id && row.wallet === values.wallet,
      );
      if (!existing) {
        const now = new Date().toISOString();
        this.rows.push({
          start_slot: 0,
          last_processed_signature: null,
          last_processed_slot: null,
          last_block_time: null,
          backlog_detected: false,
          last_success_at: null,
          last_error: null,
          created_at: now,
          updated_at: now,
          ...values,
        });
      } else if (!this.options?.ignoreDuplicates) {
        Object.assign(existing, values);
      }
      return { data: null, error: null };
    }

    const changed = this.rows.filter((row) => this.matches(row));
    changed.forEach((row) => Object.assign(row, this.values));
    return { data: this.returnRows ? changed : null, error: null };
  }

  async maybeSingle(): Promise<{ data: unknown; error: unknown }> {
    const result = this.execute();
    const rows = Array.isArray(result.data) ? result.data : [];
    return { data: rows[0] ?? null, error: result.error };
  }

  then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
    onfulfilled?:
      | ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }
}

class MemorySupabase {
  readonly rows: Row[] = [];

  from(table: string) {
    assert.equal(table, "rpc_wallet_cursors");
    return {
      select: (_columns?: string) => new MemoryQuery(this.rows, "select"),
      upsert: (values: Row, options?: { ignoreDuplicates?: boolean }) =>
        new MemoryQuery(this.rows, "upsert", values, options),
      update: (values: Row) => new MemoryQuery(this.rows, "update", values),
    };
  }
}

function signature(signatureValue: string, slot: number): ConfirmedSignatureInfo {
  return {
    signature: signatureValue,
    slot,
    err: null,
    memo: null,
    blockTime: slot * 10,
    confirmationStatus: "confirmed",
  };
}

function cursor(
  overrides: Partial<{
    startSlot: number;
    lastProcessedSignature: string | null;
    lastProcessedSlot: number | null;
  }> = {},
) {
  return {
    startSlot: overrides.startSlot ?? 100,
    lastProcessedSignature:
      overrides.lastProcessedSignature === undefined ? "sig-100" : overrides.lastProcessedSignature,
    lastProcessedSlot:
      overrides.lastProcessedSlot === undefined ? 100 : overrides.lastProcessedSlot,
  };
}

test("stores independent durable cursors and ensure never resets an existing wallet", async () => {
  const client = new MemorySupabase();
  const store = createSupabaseRpcCursorStore(client, "user-1");

  await store.ensure("wallet-a", 100);
  await store.ensure("wallet-b", 200);
  await store.advance("wallet-a", "sig-a", 110, 1_234);
  const ensuredAgain = await store.ensure("wallet-a", 999);

  assert.equal(ensuredAgain.startSlot, 100);
  assert.equal(ensuredAgain.lastProcessedSignature, "sig-a");
  assert.equal(ensuredAgain.lastProcessedSlot, 110);
  assert.equal((await store.load("wallet-b"))?.startSlot, 200);
  assert.equal("delete" in store, false);
  assert.equal("unwatch" in store, false);
});

test("custody can durably rewind an existing wallet cursor to an earlier attribution anchor", async () => {
  const client = new MemorySupabase();
  const store = createSupabaseRpcCursorStore(client, "user-1");
  await store.ensure("wallet-a", 100);
  await store.advance("wallet-a", "sig-200", 200, 2_000);

  const rewound = await store.rewind!("wallet-a", 150);
  assert.equal(rewound.startSlot, 100);
  assert.equal(rewound.lastProcessedSignature, null);
  assert.equal(rewound.lastProcessedSlot, 150);
  assert.equal(rewound.lastBlockTime, null);
  assert.equal(rewound.backlogDetected, true);

  const unchanged = await store.rewind!("wallet-a", 175);
  assert.equal(unchanged.lastProcessedSlot, 150);
});

test("backlog diagnostics are sanitized and success never advances the cursor", async () => {
  const client = new MemorySupabase();
  const store = createSupabaseRpcCursorStore(client, "user-1");
  await store.ensure("wallet-a", 100);
  await store.advance("wallet-a", "sig-a", 110, 1_234);

  const secret = "sb_secret_NEVER_STORE_THIS";
  const failed = await store.markBacklog(
    "wallet-a",
    new Error(`fetch https://rpc.example.test/?api-key=${secret} timed out`),
  );
  assert.equal(failed.backlogDetected, true);
  assert.equal(failed.lastError, "RPC cursor request timed out");
  assert.equal(JSON.stringify(client.rows).includes(secret), false);

  const recovered = await store.markSuccess("wallet-a");
  assert.equal(recovered.backlogDetected, false);
  assert.equal(recovered.lastError, null);
  assert.equal(recovered.lastProcessedSignature, "sig-a");
  assert.equal(recovered.lastProcessedSlot, 110);
  assert.ok(recovered.lastSuccessAt);
});

test("advance rejects cursor regression", async () => {
  const client = new MemorySupabase();
  const store = createSupabaseRpcCursorStore(client, "user-1");
  await store.ensure("wallet-a", 100);
  await store.advance("wallet-a", "sig-new", 110, null);
  await assert.rejects(store.advance("wallet-a", "sig-old", 109, null), /move backwards/);
  assert.equal((await store.load("wallet-a"))?.lastProcessedSignature, "sig-new");
});

test("sanitizer never retains arbitrary error payloads", () => {
  const secret = "service_role_password_is_hunter2";
  const sanitized = sanitizeRpcCursorError(new Error(secret));
  assert.equal(sanitized, "RPC cursor operation failed");
  assert.equal(sanitized.includes(secret), false);
});

test("collects overlapping RPC pages globally oldest-first after finding the cursor", () => {
  const pages = [
    [signature("sig-109", 109), signature("sig-108", 108), signature("sig-107", 107)],
    [signature("sig-107", 107), signature("sig-106", 106), signature("sig-100", 100)],
  ];
  const plan = planRpcSignaturePages(pages, cursor(), { pageSize: 3, maxPages: 3 });

  assert.equal(plan.complete, true);
  assert.equal(plan.backlogDetected, false);
  assert.equal(plan.boundary, "cursor");
  assert.deepEqual(
    plan.signatures.map((item) => item.signature),
    ["sig-106", "sig-107", "sig-108", "sig-109"],
  );
});

test("plans the next page without exposing partial newest-first work", () => {
  const pages = [[signature("sig-109", 109), signature("sig-108", 108), signature("sig-107", 107)]];
  const plan = planRpcSignaturePages(pages, cursor(), { pageSize: 3, maxPages: 3 });

  assert.equal(plan.complete, false);
  assert.equal(plan.backlogDetected, false);
  assert.deepEqual(plan.signatures, []);
  assert.deepEqual(planNextRpcSignaturePage(pages, cursor(), { pageSize: 3, maxPages: 3 }), {
    limit: 3,
    before: "sig-107",
  });
});

test("a page cap flags backlog and never releases a gap-crossing partial batch", () => {
  const pages = [[signature("sig-109", 109), signature("sig-108", 108), signature("sig-107", 107)]];
  const plan = planRpcSignaturePages(pages, cursor(), { pageSize: 3, maxPages: 1 });

  assert.equal(plan.complete, false);
  assert.equal(plan.backlogDetected, true);
  assert.equal(plan.boundary, "page-limit");
  assert.deepEqual(plan.signatures, []);
  assert.equal(plan.error, "RPC signature pagination incomplete");
  assert.equal(planNextRpcSignaturePage(pages, cursor(), { pageSize: 3, maxPages: 1 }), null);
});

test("a backlog larger than 5,000 advances in contiguous durable chunks", () => {
  const newestFirst = Array.from({ length: 5_101 }, (_, index) => {
    const slot = 5_201 - index;
    return signature(`sig-${slot}`, slot);
  });
  newestFirst.push(signature("sig-100", 100));
  const pages: ConfirmedSignatureInfo[][] = [];
  for (let offset = 0; offset < newestFirst.length; offset += 1_000) {
    pages.push(newestFirst.slice(offset, offset + 1_000));
  }

  const plan = planRpcSignaturePages(pages, cursor(), {
    pageSize: 1_000,
    maxPages: 10,
  });
  assert.equal(plan.complete, true);
  assert.equal(plan.signatures.length, 5_101);

  const firstChunk = takeOldestRpcRecoveryChunk(plan, 5_000);
  assert.equal(firstChunk.hasMore, true);
  assert.equal(firstChunk.remainingCount, 101);
  assert.equal(firstChunk.signatures[0]?.signature, "sig-101");
  assert.equal(firstChunk.signatures.at(-1)?.signature, "sig-5100");

  // After the last signature in that chunk is durably committed, the next
  // scan starts exactly there and releases only the contiguous newer tail.
  const nextPlan = planRpcSignaturePages(
    [[signature("sig-5201", 5_201), signature("sig-5100", 5_100)]],
    cursor({ lastProcessedSignature: "sig-5100", lastProcessedSlot: 5_100 }),
    { pageSize: 1_000, maxPages: 10 },
  );
  const secondChunk = takeOldestRpcRecoveryChunk(nextPlan, 5_000);
  assert.deepEqual(
    secondChunk.signatures.map((item) => item.signature),
    ["sig-5201"],
  );
  assert.equal(secondChunk.hasMore, false);
});

test("recovery chunks never release work before a trusted boundary", () => {
  const incomplete = planRpcSignaturePages(
    [[signature("sig-109", 109), signature("sig-108", 108)]],
    cursor(),
    { pageSize: 2, maxPages: 1 },
  );
  assert.equal(incomplete.backlogDetected, true);
  assert.deepEqual(takeOldestRpcRecoveryChunk(incomplete, 5_000), {
    signatures: [],
    hasMore: false,
    remainingCount: 0,
  });
});

test("falls back inclusively to the durable slot when the exact signature is absent", () => {
  const pages = [
    [
      signature("sig-108", 108),
      signature("sig-107", 107),
      signature("same-slot-replay", 100),
      signature("sig-099", 99),
    ],
  ];
  const plan = planRpcSignaturePages(pages, cursor(), { pageSize: 4 });

  assert.equal(plan.boundary, "slot");
  assert.deepEqual(
    plan.signatures.map((item) => item.signature),
    ["same-slot-replay", "sig-107", "sig-108"],
  );
});

test("a short final page safely marks the end of available history", () => {
  const pages = [[signature("sig-103", 103), signature("sig-102", 102)]];
  const plan = planRpcSignaturePages(
    pages,
    cursor({ startSlot: 0, lastProcessedSignature: null, lastProcessedSlot: null }),
    { pageSize: 3 },
  );

  assert.equal(plan.boundary, "history-end");
  assert.deepEqual(
    plan.signatures.map((item) => item.signature),
    ["sig-102", "sig-103"],
  );
});

test("a provider history gap before a known cursor fails closed", () => {
  const plan = planRpcSignaturePages(
    [[signature("sig-109", 109), signature("sig-108", 108)]],
    cursor(),
    { pageSize: 3 },
  );

  assert.equal(plan.complete, false);
  assert.equal(plan.backlogDetected, true);
  assert.equal(plan.boundary, "history-gap");
  assert.equal(plan.error, "RPC signature pagination incomplete");
  assert.deepEqual(plan.signatures, []);
});

test("a provider history gap before a slot-only activation anchor fails closed", () => {
  const plan = planRpcSignaturePages(
    [[signature("sig-309", 309), signature("sig-308", 308)]],
    cursor({ startSlot: 300, lastProcessedSignature: null, lastProcessedSlot: 300 }),
    { pageSize: 3 },
  );

  assert.equal(plan.complete, false);
  assert.equal(plan.backlogDetected, true);
  assert.equal(plan.boundary, "history-gap");
  assert.deepEqual(plan.signatures, []);
});

test("invalid provider order and repeated page tails fail closed", () => {
  const invalidOrder = planRpcSignaturePages(
    [[signature("sig-101", 101), signature("sig-102", 102)]],
    cursor(),
    { pageSize: 2 },
  );
  assert.equal(invalidOrder.backlogDetected, true);
  assert.equal(invalidOrder.boundary, "invalid-order");
  assert.deepEqual(invalidOrder.signatures, []);

  const repeated = planRpcSignaturePages(
    [
      [signature("sig-109", 109), signature("sig-108", 108)],
      [signature("sig-109", 109), signature("sig-108", 108)],
    ],
    cursor(),
    { pageSize: 2, maxPages: 3 },
  );
  assert.equal(repeated.backlogDetected, true);
  assert.equal(repeated.boundary, "no-progress");
});

test("standalone ordering preserves same-slot RPC order and removes overlap", () => {
  const ordered = rpcSignaturesOldestFirst([
    signature("newest", 3),
    signature("same-slot-newer", 2),
    signature("same-slot-older", 2),
    signature("same-slot-older", 2),
    signature("oldest", 1),
  ]);
  assert.deepEqual(
    ordered.map((item) => item.signature),
    ["oldest", "same-slot-older", "same-slot-newer", "newest"],
  );
});
