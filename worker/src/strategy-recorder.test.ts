import assert from "node:assert/strict";
import test from "node:test";

import type { FeedEvent } from "./geyser.js";
import {
  mergeStrategyObservations,
  observationFromEvent,
  StrategyRecorder,
  strategyEventsFromFeedEvent,
  strategyEventKey,
  strategyReactionMs,
} from "./strategy-recorder.js";

const USER_ID = "00000000-0000-0000-0000-000000000000";

const swap: FeedEvent = {
  kind: "swap",
  wallet: "target-wallet",
  side: "buy",
  tokenMint: "token-mint",
  amountTokens: 25,
  decimals: 6,
  amountUsd: 100,
  solDelta: -1,
  slot: 123,
  txSig: "transaction-signature",
  timestampMs: 1_700_000_000_000,
  isPumpFun: true,
  source: "geyser",
};

function row(event: FeedEvent = swap) {
  return observationFromEvent(
    event,
    {
      userId: USER_ID,
      targetWallet: "target-wallet",
      relationship: "target",
    },
    {},
    1_700_000_000_100,
  );
}

test("event keys deduplicate Geyser and RPC without collapsing different actions", () => {
  assert.equal(strategyEventKey(swap), "swap:transaction-signature:target-wallet:buy:token-mint");
  assert.equal(
    strategyEventKey({ ...swap, source: "rpc", timestampMs: swap.timestampMs + 5_000 }),
    strategyEventKey(swap),
  );
  assert.notEqual(strategyEventKey({ ...swap, side: "sell" }), strategyEventKey(swap));
  assert.notEqual(strategyEventKey({ ...swap, tokenMint: "other-mint" }), strategyEventKey(swap));
  assert.notEqual(strategyEventKey({ ...swap, wallet: "other-wallet" }), strategyEventKey(swap));

  const transfer: FeedEvent = {
    kind: "transfer",
    from: "target-wallet",
    to: "follower-a",
    tokenMint: "token-mint",
    amountTokens: 10,
    decimals: 6,
    slot: 123,
    txSig: "transaction-signature",
    timestampMs: swap.timestampMs,
    source: "geyser",
  };
  assert.equal(
    strategyEventKey(transfer),
    "transfer:transaction-signature:target-wallet:follower-a:token-mint",
  );
  assert.notEqual(strategyEventKey({ ...transfer, to: "follower-b" }), strategyEventKey(transfer));
});

test("split transfers expand into per-recipient Strategy Lab rows without an aggregate race", () => {
  const batch: FeedEvent = {
    kind: "transfer",
    from: "target-wallet",
    to: "follower-a",
    tokenMint: "token-mint",
    amountTokens: 100,
    decimals: 6,
    slot: 123,
    txSig: "split-signature",
    timestampMs: swap.timestampMs,
    recipients: [
      { wallet: "follower-a", amountTokens: 60 },
      { wallet: "follower-b", amountTokens: 40 },
    ],
  };
  const expanded = strategyEventsFromFeedEvent(batch);
  assert.deepEqual(
    expanded.map((event) =>
      event.kind === "transfer"
        ? { to: event.to, amount: event.amountTokens, nested: event.recipients }
        : null,
    ),
    [
      { to: "follower-a", amount: 60, nested: undefined },
      { to: "follower-b", amount: 40, nested: undefined },
    ],
  );
  assert.equal(new Set(expanded.map(strategyEventKey)).size, 2);
});

test("observation rows contain the Strategy Lab contract and injected timing", () => {
  const observation = row();
  assert.equal(observation.user_id, USER_ID);
  assert.equal(observation.relationship, "target");
  assert.equal(observation.event_kind, "swap");
  assert.equal(observation.side, "buy");
  assert.equal(observation.source, "geyser");
  assert.equal(observation.event_at, "2023-11-14T22:13:20.000Z");
  assert.equal(observation.detected_at, "2023-11-14T22:13:20.100Z");
  assert.deepEqual(observation.metadata, {});
});

test("reaction timing includes detection-to-decision and never understates execution", () => {
  assert.equal(strategyReactionMs(swap, swap.timestampMs + 1_250, 700), 1_250);
  assert.equal(strategyReactionMs(swap, swap.timestampMs + 500, 900), 900);
  assert.equal(strategyReactionMs(swap, swap.timestampMs - 100, -5), 0);
});

test("duplicate enrichment cannot erase a terminal decision or its timing", () => {
  const copied = observationFromEvent(
    swap,
    { userId: USER_ID, targetWallet: "target-wallet", relationship: "target" },
    {
      bot_decision: "copied",
      bot_reason: "copy landed",
      bot_tx_sig: "bot-signature",
      position_id: "00000000-0000-0000-0000-000000000001",
      reaction_ms: 800,
      execution_ms: 500,
      metadata: { stage: "landed" },
    },
    swap.timestampMs + 800,
  );
  const lateRpcBase = observationFromEvent(
    { ...swap, source: "rpc", amountUsd: undefined },
    { userId: USER_ID, targetWallet: "target-wallet", relationship: "observed" },
    { bot_decision: "filtered", bot_reason: "late stale decision", metadata: { rpc: true } },
    swap.timestampMs + 2_000,
  );
  const merged = mergeStrategyObservations(copied, lateRpcBase);
  assert.equal(merged.bot_decision, "copied");
  assert.equal(merged.bot_reason, "copy landed");
  assert.equal(merged.bot_tx_sig, "bot-signature");
  assert.equal(merged.reaction_ms, 800);
  assert.equal(merged.execution_ms, 500);
  assert.equal(merged.relationship, "target");
  assert.equal(merged.source, "geyser");
  assert.deepEqual(merged.metadata, { stage: "landed", rpc: true });
});

test("late feed copies cannot downgrade failed or submitted outcomes", () => {
  const base = row();
  const failed = { ...base, bot_decision: "failed" as const, bot_reason: "quote failed" };
  const lateTracked = { ...base, bot_decision: "tracked" as const, bot_reason: "late feed copy" };
  assert.equal(mergeStrategyObservations(failed, lateTracked).bot_decision, "failed");
  assert.equal(mergeStrategyObservations(failed, lateTracked).bot_reason, "quote failed");

  const submitted = {
    ...base,
    bot_decision: "copy_submitted" as const,
    bot_reason: "submitted",
  };
  assert.equal(mergeStrategyObservations(submitted, base).bot_decision, "copy_submitted");
  assert.equal(
    mergeStrategyObservations(submitted, {
      ...base,
      bot_decision: "copied",
      bot_reason: "landed",
    }).bot_decision,
    "copied",
  );
});

test("recorder coalesces concurrent feed copies while a write is stalled", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writes: Array<ReturnType<typeof row>[]> = [];
  const recorder = new StrategyRecorder(async (rows) => {
    writes.push(rows);
    await blocked;
  });

  assert.equal(recorder.record(row()), "queued");
  const flushing = recorder.flush();
  const richer = observationFromEvent(
    { ...swap, source: "rpc" },
    { userId: USER_ID, targetWallet: "target-wallet", relationship: "target" },
    { bot_decision: "filtered", bot_reason: "MC out of range" },
    swap.timestampMs + 200,
  );
  assert.equal(recorder.record(richer), "merged");
  assert.equal(recorder.health().pending, 1);
  release();
  await flushing;
  assert.equal(recorder.health().pending, 1, "newer enrichment remains queued");
  await recorder.flush();
  assert.equal(writes.length, 2);
  assert.equal(writes[1][0].bot_decision, "filtered");
  assert.equal(recorder.health().pending, 0);
});

test("failed writes remain queued for retry and never require the trading caller to await", async () => {
  let attempts = 0;
  const recorder = new StrategyRecorder(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("Supabase unavailable");
  });
  assert.equal(recorder.record(row()), "queued");
  await assert.rejects(recorder.flush(), /Supabase unavailable/);
  assert.equal(recorder.health().pending, 1);
  await recorder.flush();
  assert.equal(attempts, 2);
  assert.equal(recorder.health().pending, 0);
});

test("record is write-behind and does not invoke database I/O", () => {
  let writes = 0;
  const recorder = new StrategyRecorder(async () => {
    writes += 1;
  });
  recorder.record(row());
  assert.equal(writes, 0);
  assert.equal(recorder.health().pending, 1);
});

test("flush respects batch size and drains in order", async () => {
  const batches: string[][] = [];
  const recorder = new StrategyRecorder(
    async (rows) => {
      batches.push(rows.map((item) => item.tx_sig));
    },
    { maxPending: 4, batchSize: 2 },
  );
  recorder.record(row({ ...swap, txSig: "one" }));
  recorder.record(row({ ...swap, txSig: "two" }));
  recorder.record(row({ ...swap, txSig: "three" }));
  await recorder.flush();
  assert.deepEqual(batches, [["one", "two"]]);
  assert.equal(recorder.health().pending, 1);
  await recorder.flush();
  assert.deepEqual(batches, [["one", "two"], ["three"]]);
});

test("recorder remains bounded even when a flushed event returns from the recent cache", async () => {
  const recorder = new StrategyRecorder(async () => {}, {
    maxPending: 2,
    maxRecent: 2,
    batchSize: 2,
  });
  recorder.record(row({ ...swap, txSig: "one" }));
  recorder.record(row({ ...swap, txSig: "two" }));
  await recorder.flush();
  assert.equal(recorder.health().pending, 0);

  recorder.record(row({ ...swap, txSig: "three" }));
  recorder.record(row({ ...swap, txSig: "four" }));
  recorder.record(row({ ...swap, txSig: "two", source: "rpc" }));
  assert.equal(recorder.health().pending, 2);
  assert.equal(recorder.health().dropped, 1);
  assert.equal(recorder.health().recent, 2);
});
