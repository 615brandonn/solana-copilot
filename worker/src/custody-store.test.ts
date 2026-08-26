import assert from "node:assert/strict";
import test from "node:test";

import {
  createSupabaseCustodyStore,
  parseCustodyPendingReplayResult,
  parseCustodyRecordResult,
} from "./custody-store.js";
import type { SwapEvent, TransferEvent } from "./geyser.js";
import type { UnresolvedOutflowEvent } from "./poller.js";

const rpcResult = {
  applied: true,
  duplicate: false,
  payloadMismatch: false,
  reason: "applied",
  journeyId: "journey",
  eventId: "event",
  journeyStatus: "active",
  appliedAmountTokens: 1,
  watchedWallets: [],
  releasedWallets: [],
  journeyReleased: false,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function targetBuy(txSig: string, tokenMint: string): SwapEvent {
  return {
    kind: "swap",
    wallet: "target",
    side: "buy",
    tokenMint,
    amountTokens: 1,
    decimals: 6,
    solDelta: -1,
    slot: 1,
    txSig,
    timestampMs: 1_000,
    isPumpFun: false,
    verifiedSwap: true,
  };
}

async function flushTasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("custody RPC payloads preserve gross acquisition and exact raw evidence", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return { data: rpcResult, error: null };
    },
  };
  const store = createSupabaseCustodyStore(client as never, "user-id");
  const metadata = (index: number) =>
    calls[index]?.args.p_metadata as Record<string, unknown> | undefined;

  const buy: SwapEvent = {
    kind: "swap",
    wallet: "target",
    side: "buy",
    tokenMint: "mint",
    amountTokens: 40,
    amountRaw: "40000000",
    grossAmountTokens: 100,
    grossAmountRaw: "100000000",
    custodyForwardRecipients: ["recipient"],
    tokenBalanceBefore: 10,
    tokenBalanceAfter: 50,
    tokenBalanceBeforeRaw: "10000000",
    tokenBalanceAfterRaw: "50000000",
    decimals: 6,
    solDelta: -1,
    slot: 1,
    txSig: "same-tx",
    timestampMs: 1_000,
    isPumpFun: false,
    verifiedSwap: true,
  };
  await store.recordTargetBuy(buy);
  assert.equal(calls[0]?.name, "record_custody_target_buy");
  assert.equal(calls[0]?.args.p_amount_tokens, 100);
  assert.equal(metadata(0)?.amountRaw, "100000000");
  assert.equal(metadata(0)?.legacyNetAmountRaw, "40000000");
  assert.equal(metadata(0)?.tokenBalanceBeforeRaw, "10000000");
  assert.equal(metadata(0)?.tokenBalanceAfterRaw, "50000000");
  assert.deepEqual(metadata(0)?.sameTransactionRecipients, ["recipient"]);

  const transfer: TransferEvent = {
    kind: "transfer",
    from: "target",
    to: "recipient",
    tokenMint: "mint",
    amountTokens: 60,
    decimals: 6,
    senderPreAmount: 100,
    senderPostAmount: 40,
    senderPreRaw: "100000000",
    senderPostRaw: "40000000",
    sameTransactionAcquisition: true,
    chainSenderPreAmount: 10,
    chainSenderPostAmount: 50,
    chainSenderPreRaw: "10000000",
    chainSenderPostRaw: "50000000",
    slot: 1,
    txSig: "same-tx",
    timestampMs: 1_000,
  };
  await store.recordTransfer(transfer, [
    {
      wallet: "recipient",
      amountTokens: 60,
      amountRaw: "60000000",
      recipientPreAmount: 5,
      recipientPostAmount: 65,
      recipientPreRaw: "5000000",
      recipientPostRaw: "65000000",
      watchable: true,
      inferredType: "unknown",
      inferredLabel: null,
      confidence: 0,
      source: "onchain_account",
      evidence: "ordinary on-chain account",
    },
  ]);
  assert.equal(calls[1]?.name, "record_custody_transfer");
  assert.equal(metadata(1)?.sameTransactionAcquisition, true);
  assert.equal(metadata(1)?.chainSenderPreRaw, "10000000");
  assert.equal(metadata(1)?.chainSenderPostRaw, "50000000");
  const recipients = calls[1]?.args.p_recipients as Array<Record<string, unknown>> | undefined;
  assert.equal(recipients?.[0]?.amountRaw, "60000000");

  const sell: SwapEvent = {
    ...buy,
    side: "sell",
    amountTokens: 1,
    amountRaw: "1",
    grossAmountTokens: undefined,
    grossAmountRaw: undefined,
    txSig: "sell-tx",
    sellAttribution: {
      verified: true,
      tokenBalanceBefore: 100,
      tokenBalanceAfter: 99.999999,
      tokenBalanceBeforeRaw: "100000000",
      tokenBalanceAfterRaw: "99999999",
      soldAmountRaw: "1",
      proceedsMint: "proceeds",
      proceedsAmount: 0.000001,
      proceedsAmountRaw: "1",
      proceedsDecimals: 6,
      signerCount: 1,
    },
  };
  await store.recordVerifiedSell(sell);
  assert.equal(metadata(2)?.soldAmountRaw, "1");
  assert.equal(metadata(2)?.tokenBalanceAfterRaw, "99999999");
  assert.equal(metadata(2)?.proceedsAmountRaw, "1");

  const unresolved: UnresolvedOutflowEvent = {
    kind: "unresolved_outflow",
    wallet: "target",
    tokenMint: "mint",
    amountTokens: 25,
    amountRaw: "25000000",
    preAmount: 100,
    postAmount: 75,
    preRaw: "100000000",
    postRaw: "75000000",
    decimals: 6,
    slot: 3,
    txSig: "unresolved-tx",
    timestampMs: 3_000,
    source: "rpc",
    delivery: "catchup",
    reason: "negative_token_delta_not_attributed",
  };
  await store.recordUnresolvedOutflow(unresolved);
  assert.equal(calls[3]?.name, "record_custody_unresolved_outflow");
  assert.equal(calls[3]?.args.p_wallet, "target");
  assert.equal(calls[3]?.args.p_pre_amount_tokens, 100);
  assert.equal(calls[3]?.args.p_post_amount_tokens, 75);
  assert.equal(metadata(3)?.amountRaw, "25000000");
  assert.equal(metadata(3)?.preRaw, "100000000");
  assert.equal(metadata(3)?.postRaw, "75000000");
  assert.equal(metadata(3)?.reason, "negative_token_delta_not_attributed");
});

test("custody writes serialize per mint while different mints remain parallel", async () => {
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const started: string[] = [];
  let active = 0;
  let maxActive = 0;
  const client = {
    async rpc(_name: string, args: Record<string, unknown>) {
      const txSig = String(args.p_tx_sig);
      const gate = deferred();
      gates.set(txSig, gate);
      started.push(txSig);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate.promise;
      active -= 1;
      return { data: rpcResult, error: null };
    },
  };
  const store = createSupabaseCustodyStore(client as never, "user-id");

  const first = store.recordTargetBuy(targetBuy("same-1", "same-mint"));
  const second = store.recordTargetBuy(targetBuy("same-2", "same-mint"));
  const other = store.recordTargetBuy(targetBuy("other-1", "other-mint"));
  await flushTasks();

  assert.deepEqual(started, ["same-1", "other-1"]);
  assert.equal(maxActive, 2);
  gates.get("same-1")?.resolve();
  gates.get("other-1")?.resolve();
  await Promise.all([first, other]);
  await flushTasks();

  assert.deepEqual(started, ["same-1", "other-1", "same-2"]);
  gates.get("same-2")?.resolve();
  await second;
});

test("a failed custody write releases its mint queue for replay", async () => {
  const started: string[] = [];
  const client = {
    async rpc(_name: string, args: Record<string, unknown>) {
      const txSig = String(args.p_tx_sig);
      started.push(txSig);
      return txSig === "failed"
        ? { data: null, error: { message: "database unavailable" } }
        : { data: rpcResult, error: null };
    },
  };
  const store = createSupabaseCustodyStore(client as never, "user-id");

  const failed = store.recordTargetBuy(targetBuy("failed", "same-mint"));
  const replay = store.recordTargetBuy(targetBuy("replay", "same-mint"));
  await assert.rejects(failed, /record_custody_target_buy failed/);
  await replay;

  assert.deepEqual(started, ["failed", "replay"]);
});

test("custody persistence responses fail closed when malformed", () => {
  assert.throws(() => parseCustodyRecordResult(null), /invalid record result/);
  assert.throws(
    () => parseCustodyRecordResult({ ...rpcResult, watchedWallets: "wallet" }),
    /invalid watched wallets/,
  );
  assert.throws(
    () => parseCustodyRecordResult({ ...rpcResult, applied: true, eventId: null }),
    /without durable identifiers/,
  );
  assert.throws(
    () => parseCustodyPendingReplayResult({ processedCount: 0, results: [] }),
    /invalid applied count/,
  );
});

test("a durable payload conflict is returned for coverage reporting instead of wedging RPC", async () => {
  const client = {
    async rpc() {
      return {
        data: {
          ...rpcResult,
          applied: false,
          duplicate: true,
          payloadMismatch: true,
          reason: "payload_mismatch",
        },
        error: null,
      };
    },
  };
  const store = createSupabaseCustodyStore(client as never, "user-id");
  const result = await store.recordTargetBuy({
    kind: "swap",
    wallet: "target",
    side: "buy",
    tokenMint: "mint",
    amountTokens: 1,
    decimals: 6,
    solDelta: -1,
    slot: 1,
    txSig: "tx",
    timestampMs: 1_000,
    isPumpFun: false,
    verifiedSwap: true,
  });
  assert.equal(result.payloadMismatch, true);
  assert.equal(result.reason, "payload_mismatch");
});

test("active custody watches are loaded in complete deterministic pages", async () => {
  const rows = Array.from({ length: 1_001 }, (_, index) => ({
    journey_id: `journey-${Math.floor(index / 250)}`,
    wallet: `wallet-${String(index).padStart(4, "0")}`,
    token_mint: `mint-${Math.floor(index / 500)}`,
    watch_anchor_slot: index === 1_000 ? 700 : index + 1,
    last_slot: index + 1,
    current_attributed_tokens: 1,
  }));
  const ranges: Array<[number, number]> = [];
  const builder = {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    gt() {
      return this;
    },
    order() {
      return this;
    },
    async range(from: number, to: number) {
      ranges.push([from, to]);
      return { data: rows.slice(from, to + 1), error: null };
    },
  };
  const client = {
    from() {
      return builder;
    },
  };
  const store = createSupabaseCustodyStore(client as never, "user-id");
  const watches = await store.loadActiveWatches();
  assert.equal(watches.length, 1_001);
  assert.deepEqual(ranges, [
    [0, 999],
    [1_000, 1_999],
  ]);
  assert.deepEqual(watches.at(-1), {
    journeyId: "journey-4",
    wallet: "wallet-1000",
    tokenMint: "mint-2",
    anchorSlot: 700,
  });
});

test("active attribution scope checks use wallet and mint and fail closed on database errors", async () => {
  const filters: Array<[string, unknown]> = [];
  let response: { data: unknown; error: { message: string } | null } = {
    data: [{ journey_id: "journey" }],
    error: null,
  };
  const builder = {
    select() {
      return this;
    },
    eq(column: string, value: unknown) {
      filters.push([column, value]);
      return this;
    },
    gt(column: string, value: unknown) {
      filters.push([column, value]);
      return this;
    },
    async limit() {
      return response;
    },
  };
  const store = createSupabaseCustodyStore(
    {
      from(table: string) {
        assert.equal(table, "custody_journey_wallets");
        return builder;
      },
    } as never,
    "user-id",
  );
  assert.equal(await store.hasActiveAttribution("wallet", "mint"), true);
  assert.deepEqual(filters, [
    ["user_id", "user-id"],
    ["wallet", "wallet"],
    ["token_mint", "mint"],
    ["watch_status", "active"],
    ["current_attributed_tokens", 0],
  ]);

  response = { data: [], error: null };
  assert.equal(await store.hasActiveAttribution("wallet", "other-mint"), false);
  response = { data: null, error: { message: "temporary database outage" } };
  await assert.rejects(
    store.hasActiveAttribution("wallet", "mint"),
    /custody attribution scope check failed/,
  );
});
