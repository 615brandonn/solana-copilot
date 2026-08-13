import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";

import { GeyserFeed, type FeedEvent } from "./geyser.js";
import { USDC_MINT, WSOL_MINT } from "./swap-attribution.js";
import { VERIFIED_SWAP_PROGRAMS } from "./swap-signal.js";

const target = Keypair.generate().publicKey.toBase58();
const payer = Keypair.generate().publicKey.toBase58();
const recipient = Keypair.generate().publicKey.toBase58();
const otherRecipient = Keypair.generate().publicKey.toBase58();
const INPUT_MINT = "input-token-mint";
const OUTPUT_MINT = "output-token-mint";
const OTHER_OUTPUT_MINT = "other-output-token-mint";

function tokenBalance(owner: string, mint: string, amount: number, decimals = 6) {
  const raw = BigInt(Math.round(amount * 10 ** decimals));
  return {
    owner,
    mint,
    uiTokenAmount: {
      amount: raw.toString(),
      decimals,
      uiAmount: amount,
      uiAmountString: String(amount),
    },
  };
}

function exactTokenBalance(
  owner: string,
  mint: string,
  amountRaw: string,
  uiAmountString: string,
  decimals = 6,
) {
  return {
    owner,
    mint,
    uiTokenAmount: {
      amount: amountRaw,
      decimals,
      uiAmount: Number(uiAmountString),
      uiAmountString,
    },
  };
}

const trustedLogs = [
  `Program ${VERIFIED_SWAP_PROGRAMS.jupiterV6} invoke [1]`,
  "Program log: Instruction: Route",
  `Program ${VERIFIED_SWAP_PROGRAMS.jupiterV6} success`,
];

function decode(options: {
  targetSigner?: boolean;
  secondSigner?: boolean;
  logs?: string[];
  targetLamportDelta?: number;
  preTokens: unknown[];
  postTokens: unknown[];
}): FeedEvent[] {
  const accountKeys =
    options.targetSigner === false
      ? [payer, target, recipient, otherRecipient]
      : options.secondSigner
        ? [target, payer, recipient, otherRecipient]
        : [target, recipient, otherRecipient];
  const requiredSignatures = options.secondSigner ? 2 : 1;
  const targetIndex = accountKeys.indexOf(target);
  const preBalances = accountKeys.map(() => 1_000_000_000);
  const postBalances = preBalances.map((balance, index) =>
    index === targetIndex ? balance + (options.targetLamportDelta ?? -5_000) : balance,
  );
  const meta = {
    err: null,
    fee: 5_000,
    preBalances,
    postBalances,
    preTokenBalances: options.preTokens,
    postTokenBalances: options.postTokens,
    logMessages: options.logs ?? trustedLogs,
  };
  const feed = Object.create(GeyserFeed.prototype) as {
    watched: Set<string>;
    decodeEvents(message: unknown, transaction: unknown): FeedEvent[];
  };
  feed.watched = new Set([target]);
  return feed.decodeEvents(
    { transaction: { slot: 123, meta } },
    {
      signature: "signature",
      meta,
      transaction: {
        message: {
          accountKeys,
          header: { numRequiredSignatures: requiredSignatures },
        },
      },
    },
  );
}

function buys(events: FeedEvent[]) {
  return events.filter((event) => event.kind === "swap" && event.side === "buy");
}

test("Geyser preserves exact token and wrapped-SOL input attribution", () => {
  const tokenEvents = decode({
    preTokens: [tokenBalance(target, INPUT_MINT, 20), tokenBalance(target, OUTPUT_MINT, 0)],
    postTokens: [tokenBalance(target, INPUT_MINT, 0), tokenBalance(target, OUTPUT_MINT, 1_000)],
  });
  const tokenBuy = buys(tokenEvents)[0];
  assert.ok(tokenBuy?.kind === "swap");
  assert.equal(tokenBuy.spentToken?.mint, INPUT_MINT);
  assert.equal(tokenBuy.spentToken?.amountRaw, "20000000");

  const wsolEvents = decode({
    preTokens: [tokenBalance(target, WSOL_MINT, 2, 9), tokenBalance(target, OUTPUT_MINT, 0)],
    postTokens: [tokenBalance(target, WSOL_MINT, 1, 9), tokenBalance(target, OUTPUT_MINT, 1_000)],
  });
  const wsolBuy = buys(wsolEvents)[0];
  assert.ok(wsolBuy?.kind === "swap");
  assert.equal(wsolBuy.spentToken?.mint, WSOL_MINT);
  assert.equal(wsolBuy.spentToken?.amountRaw, "1000000000");
});

test("Geyser uses raw balance deltas when UI numbers collapse a one-unit acquisition", () => {
  const before = "9007199254740992000";
  const after = "9007199254740992001";
  const events = decode({
    preTokens: [
      tokenBalance(target, USDC_MINT, 60),
      exactTokenBalance(target, OUTPUT_MINT, before, "9007199254740.992"),
    ],
    postTokens: [
      tokenBalance(target, USDC_MINT, 0),
      exactTokenBalance(target, OUTPUT_MINT, after, "9007199254740.992"),
    ],
  });
  const buy = buys(events)[0];
  assert.ok(buy?.kind === "swap");
  assert.equal(buy.amountRaw, "1");
  assert.equal(buy.amountTokens, 0.000001);
});

test("Geyser emits net legacy buy plus gross custody acquisition for an atomic partial forward", () => {
  const events = decode({
    preTokens: [
      tokenBalance(target, USDC_MINT, 100),
      tokenBalance(target, OUTPUT_MINT, 10),
      tokenBalance(recipient, OUTPUT_MINT, 5),
    ],
    postTokens: [
      tokenBalance(target, USDC_MINT, 40),
      tokenBalance(target, OUTPUT_MINT, 50),
      tokenBalance(recipient, OUTPUT_MINT, 65),
    ],
  });
  const buy = buys(events)[0];
  assert.equal(buys(events).length, 1);
  assert.ok(buy?.kind === "swap");
  assert.equal(buy.amountTokens, 40);
  assert.equal(buy.amountRaw, "40000000");
  assert.equal(buy.grossAmountTokens, 100);
  assert.equal(buy.grossAmountRaw, "100000000");
  assert.equal(buy.inferredRecipients, undefined);
  assert.deepEqual(buy.custodyForwardRecipients, [recipient]);

  const transfer = events.find((event) => event.kind === "transfer");
  assert.ok(transfer?.kind === "transfer");
  assert.equal(transfer.amountTokens, 60);
  assert.equal(transfer.sameTransactionAcquisition, true);
  assert.equal(transfer.senderPreRaw, "100000000");
  assert.equal(transfer.senderPostRaw, "40000000");
  assert.equal(transfer.chainSenderPreRaw, "10000000");
  assert.equal(transfer.chainSenderPostRaw, "50000000");
  assert.equal(transfer.recipients?.[0]?.amountRaw, "60000000");
});

test("Geyser accepts adjusted native SOL only with one trusted signer", () => {
  const nativeEvents = decode({
    targetLamportDelta: -1_000_000_000,
    preTokens: [tokenBalance(target, OUTPUT_MINT, 0)],
    postTokens: [tokenBalance(target, OUTPUT_MINT, 1_000)],
  });
  const nativeBuy = buys(nativeEvents)[0];
  assert.ok(nativeBuy?.kind === "swap");
  assert.equal(nativeBuy.solSpend, 0.994995);

  const nonSigner = decode({
    targetSigner: false,
    targetLamportDelta: -1_000_000_000,
    preTokens: [tokenBalance(target, OUTPUT_MINT, 0)],
    postTokens: [tokenBalance(target, OUTPUT_MINT, 1_000)],
  });
  assert.equal(buys(nonSigner).length, 0);

  const multipleSigners = decode({
    secondSigner: true,
    targetLamportDelta: -1_000_000_000,
    preTokens: [tokenBalance(target, OUTPUT_MINT, 0)],
    postTokens: [tokenBalance(target, OUTPUT_MINT, 1_000)],
  });
  assert.equal(buys(multipleSigners).length, 0);
});

test("Geyser rejects an untrusted swap word and prevents direct/inferred double buys", () => {
  const untrusted = "11111111111111111111111111111111";
  const fakeLogs = [
    `Program ${untrusted} invoke [1]`,
    "Program log: Instruction: Swap",
    `Program ${untrusted} success`,
  ];
  const fakeEvents = decode({
    logs: fakeLogs,
    preTokens: [tokenBalance(target, USDC_MINT, 60), tokenBalance(target, OUTPUT_MINT, 0)],
    postTokens: [tokenBalance(target, USDC_MINT, 0), tokenBalance(target, OUTPUT_MINT, 1_000)],
  });
  assert.equal(buys(fakeEvents).length, 0);

  const mixedOutputs = decode({
    preTokens: [
      tokenBalance(target, USDC_MINT, 60),
      tokenBalance(target, OUTPUT_MINT, 0),
      tokenBalance(recipient, OTHER_OUTPUT_MINT, 0),
    ],
    postTokens: [
      tokenBalance(target, USDC_MINT, 0),
      tokenBalance(target, OUTPUT_MINT, 1_000),
      tokenBalance(recipient, OTHER_OUTPUT_MINT, 2_000),
    ],
  });
  assert.equal(buys(mixedOutputs).length, 0);
});

test("Geyser aggregates recipient accounts before inferring an external buy", () => {
  const reallocation = decode({
    preTokens: [
      tokenBalance(target, USDC_MINT, 60),
      tokenBalance(recipient, OUTPUT_MINT, 100),
      tokenBalance(recipient, OUTPUT_MINT, 0),
    ],
    postTokens: [
      tokenBalance(target, USDC_MINT, 0),
      tokenBalance(recipient, OUTPUT_MINT, 0),
      tokenBalance(recipient, OUTPUT_MINT, 100),
    ],
  });
  assert.equal(buys(reallocation).length, 0);
});

test("a failed subscription write stays pending and is retried for the same wallet", async () => {
  let writes = 0;
  let shouldFail = true;
  const stream = {
    write: (_request: unknown, callback: (error?: Error) => void) => {
      writes += 1;
      callback(shouldFail ? new Error("private endpoint failed") : undefined);
    },
  };
  const feed = Object.create(GeyserFeed.prototype) as any;
  feed.desiredWatched = new Set<string>();
  feed.watched = new Set<string>();
  feed.stream = stream;
  feed.streamGeneration = 1;
  feed.stopped = false;
  feed.reconnectTimer = undefined;
  feed.scheduleReconnect = () => {};

  await assert.rejects(feed.watch(target), /Geyser operation failed/);
  assert.equal(feed.desiredWatched.has(target), true);
  assert.equal(feed.watched.has(target), false);
  assert.equal(feed.health().pendingSubscriptionCount, 1);
  assert.equal(feed.health().connected, false);
  assert.equal(feed.health().transportConnected, true);

  shouldFail = false;
  await feed.watch(target);
  assert.equal(writes, 2);
  assert.equal(feed.watched.has(target), true);
  assert.equal(feed.health().pendingSubscriptionCount, 0);
  assert.equal(feed.health().subscriptionReady, true);
  assert.equal(feed.health().messageFresh, false);
  assert.equal(feed.health().connected, false);
  feed.lastMessageAt = Date.now();
  feed.lastMessageGeneration = 1;
  assert.equal(feed.health().connected, true);
});

test("a disconnected watch restarts the suspended stream without claiming subscription early", async () => {
  let connects = 0;
  const feed = Object.create(GeyserFeed.prototype) as any;
  feed.desiredWatched = new Set<string>();
  feed.watched = new Set<string>();
  feed.stream = undefined;
  feed.stopped = false;
  feed.lastMessageAt = undefined;
  feed.pendingMessages = [];
  feed.discardedQueuedMessageCount = 0;
  feed.decodedEventCount = 0;
  feed.connect = async () => {
    connects += 1;
  };

  await feed.watch(target);
  const health = feed.health();
  assert.equal(connects, 1);
  assert.equal(health.desiredWatchedCount, 1);
  assert.equal(health.watchedCount, 0);
  assert.equal(health.pendingSubscriptionCount, 1);
  assert.equal(health.connected, false);
});

test("an empty start and final unwatch close the stream without writing an empty filter", async () => {
  let connects = 0;
  let writes = 0;
  let ends = 0;
  const stream = {
    write(_request: unknown, callback: (error?: Error) => void) {
      writes += 1;
      callback();
    },
    removeAllListeners() {},
    end() {
      ends += 1;
    },
  };
  const feed = Object.create(GeyserFeed.prototype) as any;
  feed.desiredWatched = new Set<string>();
  feed.watched = new Set<string>();
  feed.stream = stream;
  feed.streamGeneration = 1;
  feed.pendingMessages = [];
  feed.discardedQueuedMessageCount = 0;
  feed.stopped = false;
  feed.connect = async () => {
    connects += 1;
  };

  await feed.start([]);
  assert.equal(connects, 0);
  assert.equal(writes, 0);
  assert.equal(ends, 1);
  assert.equal(feed.stream, undefined);

  feed.stream = stream;
  feed.desiredWatched = new Set([target]);
  feed.watched = new Set([target]);
  await feed.unwatch(target);
  assert.equal(writes, 0);
  assert.equal(ends, 2);
  assert.equal(feed.desiredWatched.size, 0);
  assert.equal(feed.stream, undefined);
});

test("Geyser health requires recent message evidence, not only a writable stream", () => {
  const now = 1_000_000;
  const feed = Object.create(GeyserFeed.prototype) as any;
  feed.desiredWatched = new Set([target]);
  feed.watched = new Set([target]);
  feed.stream = {};
  feed.streamGeneration = 1;
  feed.pendingMessages = [];
  feed.discardedQueuedMessageCount = 0;
  feed.decodedEventCount = 0;

  feed.lastMessageAt = now - 59_000;
  feed.lastMessageGeneration = 1;
  assert.equal(feed.health(now).messageFresh, true);
  assert.equal(feed.health(now).connected, true);

  feed.lastMessageAt = now - 61_000;
  assert.equal(feed.health(now).messageFresh, false);
  assert.equal(feed.health(now).connected, false);
  assert.equal(feed.health(now).transportConnected, true);

  feed.lastMessageAt = now - 1_000;
  feed.lastMessageGeneration = 0;
  assert.equal(feed.health(now).connected, false);
});

test("a replacement stream discards the old queue and drains its own paused message", async () => {
  const handled: string[] = [];
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const oldStream = {
    pause() {},
    resume() {},
  };
  let newStreamResumed = 0;
  const newStream = {
    pause() {},
    resume() {
      newStreamResumed += 1;
    },
  };
  const feed = Object.create(GeyserFeed.prototype) as any;
  feed.stream = oldStream;
  feed.streamGeneration = 1;
  feed.pendingMessages = [];
  feed.processingMessage = false;
  feed.stopped = false;
  feed.discardedQueuedMessageCount = 0;
  feed.handleMessage = async (message: { id: string }) => {
    handled.push(message.id);
    if (message.id === "old-in-flight") {
      markFirstStarted();
      await firstRelease;
    }
  };

  feed.processMessageWithBackpressure({ id: "old-in-flight" }, oldStream, 1);
  await firstStarted;
  feed.processMessageWithBackpressure({ id: "old-queued" }, oldStream, 1);
  assert.equal(feed.pendingMessages.length, 1);

  feed.stream = undefined;
  feed.streamGeneration = 2;
  feed.discardQueuedMessages("test reconnect");
  feed.stream = newStream;
  feed.streamGeneration = 3;
  feed.processMessageWithBackpressure({ id: "new-live" }, newStream, 3);
  releaseFirst();

  for (let attempt = 0; attempt < 10 && !handled.includes("new-live"); attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(handled, ["old-in-flight", "new-live"]);
  assert.equal(feed.discardedQueuedMessageCount, 1);
  assert.ok(newStreamResumed > 0);
});

test("a delayed queued Geyser event is freshness-gated as catch-up", async () => {
  const delivered: FeedEvent[] = [];
  const receivedAtMs = Date.now() - 6_000;
  const feed = Object.create(GeyserFeed.prototype) as any;
  feed.stream = {};
  feed.streamGeneration = 7;
  feed.decodedEventCount = 0;
  feed.discardedQueuedMessageCount = 0;
  feed.decodeEvents = () => [
    {
      kind: "transfer",
      from: target,
      to: recipient,
      tokenMint: OUTPUT_MINT,
      amountTokens: 10,
      decimals: 6,
      slot: 123,
      txSig: "delayed-signature",
      timestampMs: Date.now(),
    } satisfies FeedEvent,
  ];
  feed.onSwap = async (event: FeedEvent) => {
    delivered.push(event);
  };

  await feed.handleMessage({ transaction: { transaction: {} } }, 7, receivedAtMs);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.delivery, "catchup");
  assert.equal(delivered[0]?.blockTimeMs, receivedAtMs);
  assert.equal(delivered[0]?.observedAtMs, receivedAtMs);
});

test("Geyser accepts a multi-signer sell only with one watched-wallet debit and one proceeds asset", () => {
  const events = decode({
    secondSigner: true,
    preTokens: [tokenBalance(target, OUTPUT_MINT, 100), tokenBalance(target, USDC_MINT, 0)],
    postTokens: [tokenBalance(target, OUTPUT_MINT, 25), tokenBalance(target, USDC_MINT, 60)],
  });

  const sells = events.filter((event) => event.kind === "swap" && event.side === "sell");
  assert.equal(sells.length, 1);
  const sell = sells[0];
  assert.ok(sell?.kind === "swap");
  assert.equal(sell.tokenMint, OUTPUT_MINT);
  assert.equal(sell.verifiedSwap, true);
  assert.deepEqual(sell.sellAttribution, {
    verified: true,
    tokenBalanceBefore: 100,
    tokenBalanceAfter: 25,
    tokenBalanceBeforeRaw: "100000000",
    tokenBalanceAfterRaw: "25000000",
    soldAmountRaw: "75000000",
    soldFraction: 0.75,
    proceedsMint: USDC_MINT,
    proceedsAmount: 60,
    proceedsAmountRaw: "60000000",
    proceedsDecimals: 6,
    signerCount: 2,
  });
});

test("Geyser rejects untrusted and ambiguous target sells", () => {
  const untrustedProgram = "11111111111111111111111111111111";
  const untrusted = decode({
    logs: [
      `Program ${untrustedProgram} invoke [1]`,
      "Program log: Instruction: Swap",
      `Program ${untrustedProgram} success`,
    ],
    preTokens: [tokenBalance(target, OUTPUT_MINT, 100), tokenBalance(target, USDC_MINT, 0)],
    postTokens: [tokenBalance(target, OUTPUT_MINT, 0), tokenBalance(target, USDC_MINT, 60)],
  });
  assert.equal(
    untrusted.some((event) => event.kind === "swap" && event.side === "sell"),
    false,
  );

  const nonSigner = decode({
    targetSigner: false,
    preTokens: [tokenBalance(target, OUTPUT_MINT, 100), tokenBalance(target, USDC_MINT, 0)],
    postTokens: [tokenBalance(target, OUTPUT_MINT, 0), tokenBalance(target, USDC_MINT, 60)],
  });
  assert.equal(
    nonSigner.some((event) => event.kind === "swap" && event.side === "sell"),
    false,
  );

  const ambiguous = decode({
    preTokens: [
      tokenBalance(target, OUTPUT_MINT, 100),
      tokenBalance(target, USDC_MINT, 0),
      tokenBalance(target, OTHER_OUTPUT_MINT, 0),
    ],
    postTokens: [
      tokenBalance(target, OUTPUT_MINT, 0),
      tokenBalance(target, USDC_MINT, 60),
      tokenBalance(target, OTHER_OUTPUT_MINT, 5),
    ],
  });
  assert.equal(
    ambiguous.some((event) => event.kind === "swap" && event.side === "sell"),
    false,
  );
});

test("Geyser emits a single conserving batch with every split-transfer recipient", () => {
  const events = decode({
    logs: [],
    preTokens: [
      tokenBalance(target, OUTPUT_MINT, 100),
      tokenBalance(recipient, OUTPUT_MINT, 5),
      tokenBalance(otherRecipient, OUTPUT_MINT, 10),
    ],
    postTokens: [
      tokenBalance(target, OUTPUT_MINT, 0),
      tokenBalance(recipient, OUTPUT_MINT, 65),
      tokenBalance(otherRecipient, OUTPUT_MINT, 50),
    ],
  });
  const transfers = events.filter((event) => event.kind === "transfer");
  assert.equal(transfers.length, 1);
  const batch = transfers[0];
  assert.ok(batch?.kind === "transfer");
  assert.equal(batch.amountTokens, 100);
  assert.equal(batch.senderPreAmount, 100);
  assert.equal(batch.senderPostAmount, 0);
  assert.equal(batch.senderPreRaw, "100000000");
  assert.equal(batch.senderPostRaw, "0");
  assert.deepEqual((batch.recipients ?? []).map((row) => row.amountRaw).sort(), [
    "40000000",
    "60000000",
  ]);
  assert.deepEqual(
    (batch.recipients ?? [])
      .map((row) => [row.recipientPreRaw, row.recipientPostRaw])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    [
      ["5000000", "65000000"],
      ["10000000", "50000000"],
    ].sort((a, b) => a[0].localeCompare(b[0])),
  );
  const recipients = (batch.recipients ?? []).map((row) => ({
    to: row.wallet,
    amount: row.amountTokens,
    pre: row.recipientPreAmount,
    post: row.recipientPostAmount,
  }));
  const expected = [
    { to: recipient, amount: 60, pre: 5, post: 65 },
    { to: otherRecipient, amount: 40, pre: 10, post: 50 },
  ].sort((a, b) => a.to.localeCompare(b.to));
  assert.deepEqual(recipients, expected);
});
