import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";

import {
  decodeParsedTransaction,
  decodeParsedTransactionWithCoverage,
  RpcBackfillPoller,
} from "./poller.js";
import type { RpcCursorStore, RpcWalletCursor } from "./rpc-cursor.js";
import { USDC_MINT, WSOL_MINT } from "./swap-attribution.js";
import { VERIFIED_SWAP_PROGRAMS } from "./swap-signal.js";

const target = Keypair.generate().publicKey.toBase58();
const payer = Keypair.generate().publicKey.toBase58();
const recipient = Keypair.generate().publicKey.toBase58();
const otherRecipient = Keypair.generate().publicKey.toBase58();
const INPUT_MINT = "input-token-mint";
const OTHER_INPUT_MINT = "other-input-token-mint";
const OUTPUT_MINT = "output-token-mint";
const OTHER_OUTPUT_MINT = "other-output-token-mint";

function testCursor(wallet: string, overrides: Partial<RpcWalletCursor> = {}): RpcWalletCursor {
  return {
    userId: "user-1",
    wallet,
    startSlot: 100,
    lastProcessedSignature: "sig-100",
    lastProcessedSlot: 100,
    lastBlockTime: 1_000,
    backlogDetected: false,
    lastSuccessAt: null,
    lastError: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

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

function parsedTx(options: {
  targetSigner?: boolean;
  secondSigner?: boolean;
  swapLogs?: boolean;
  logMessages?: string[];
  targetLamportDelta?: number;
  preTokens: unknown[];
  postTokens: unknown[];
}) {
  const accountKeys =
    options.targetSigner === false
      ? [
          { pubkey: payer, signer: true },
          { pubkey: target, signer: false },
          { pubkey: recipient, signer: false },
          { pubkey: otherRecipient, signer: false },
        ]
      : options.secondSigner
        ? [
            { pubkey: target, signer: true },
            { pubkey: payer, signer: true },
            { pubkey: recipient, signer: false },
            { pubkey: otherRecipient, signer: false },
          ]
        : [
            { pubkey: target, signer: true },
            { pubkey: recipient, signer: false },
            { pubkey: otherRecipient, signer: false },
          ];
  return {
    slot: 123,
    transaction: {
      signatures: ["signature"],
      message: { accountKeys },
    },
    meta: {
      fee: 5_000,
      preBalances: accountKeys.map(() => 1_000_000_000),
      postBalances: accountKeys.map((_entry, index) =>
        index === (options.targetSigner === false ? 1 : 0)
          ? 1_000_000_000 + (options.targetLamportDelta ?? -5_000)
          : 1_000_000_000,
      ),
      preTokenBalances: options.preTokens,
      postTokenBalances: options.postTokens,
      logMessages:
        options.logMessages ??
        (options.swapLogs
          ? [
              `Program ${VERIFIED_SWAP_PROGRAMS.jupiterV6} invoke [1]`,
              "Program log: Instruction: Route",
              `Program ${VERIFIED_SWAP_PROGRAMS.jupiterV6} success`,
            ]
          : []),
    },
  };
}

test("direct token-to-token swap carries the target's exact verified input", () => {
  const events = decodeParsedTransaction(
    target,
    parsedTx({
      swapLogs: true,
      preTokens: [tokenBalance(target, INPUT_MINT, 20), tokenBalance(target, OUTPUT_MINT, 0)],
      postTokens: [tokenBalance(target, INPUT_MINT, 0), tokenBalance(target, OUTPUT_MINT, 1_000)],
    }),
  );
  const buy = events.find(
    (event) => event.kind === "swap" && event.side === "buy" && event.tokenMint === OUTPUT_MINT,
  );
  assert.ok(buy && buy.kind === "swap");
  assert.deepEqual(buy.spentToken, {
    mint: INPUT_MINT,
    amountRaw: "20000000",
    amountTokens: 20,
    decimals: 6,
  });
  assert.equal(buy.amountUsd, undefined);
});

test("direct stablecoin input keeps an exact USD value", () => {
  const events = decodeParsedTransaction(
    target,
    parsedTx({
      swapLogs: true,
      preTokens: [tokenBalance(target, USDC_MINT, 100), tokenBalance(target, OUTPUT_MINT, 0)],
      postTokens: [tokenBalance(target, USDC_MINT, 40), tokenBalance(target, OUTPUT_MINT, 1_000)],
    }),
  );
  const buy = events.find(
    (event) => event.kind === "swap" && event.side === "buy" && event.tokenMint === OUTPUT_MINT,
  );
  assert.ok(buy && buy.kind === "swap");
  assert.equal(buy.amountUsd, 60);
  assert.equal(buy.spentToken, undefined);
  assert.equal(buy.tokenBalanceBefore, 0);
  assert.equal(buy.tokenBalanceAfter, 1_000);
  assert.equal(buy.tokenBalanceBeforeRaw, "0");
  assert.equal(buy.tokenBalanceAfterRaw, "1000000000");
});

test("RPC uses raw balance deltas when UI numbers collapse a one-unit acquisition", () => {
  const events = decodeParsedTransaction(
    target,
    parsedTx({
      swapLogs: true,
      preTokens: [
        tokenBalance(target, USDC_MINT, 60),
        exactTokenBalance(target, OUTPUT_MINT, "9007199254740992000", "9007199254740.992"),
      ],
      postTokens: [
        tokenBalance(target, USDC_MINT, 0),
        exactTokenBalance(target, OUTPUT_MINT, "9007199254740992001", "9007199254740.992"),
      ],
    }),
  );
  const buy = events.find((event) => event.kind === "swap" && event.side === "buy");
  assert.ok(buy?.kind === "swap");
  assert.equal(buy.amountRaw, "1");
  assert.equal(buy.amountTokens, 0.000001);
});

test("wrapped-SOL spending preserves the exact input instead of valuing account-level SOL", () => {
  const events = decodeParsedTransaction(
    target,
    parsedTx({
      swapLogs: true,
      preTokens: [tokenBalance(target, WSOL_MINT, 2, 9), tokenBalance(target, OUTPUT_MINT, 0)],
      postTokens: [tokenBalance(target, WSOL_MINT, 1, 9), tokenBalance(target, OUTPUT_MINT, 1_000)],
    }),
  );
  const buy = events.find(
    (event) => event.kind === "swap" && event.side === "buy" && event.tokenMint === OUTPUT_MINT,
  );
  assert.ok(buy && buy.kind === "swap");
  assert.ok(buy.solDelta < -1 && buy.solDelta > -1.001);
  assert.equal(buy.amountUsd, undefined);
  assert.deepEqual(buy.spentToken, {
    mint: WSOL_MINT,
    amountRaw: "1000000000",
    amountTokens: 1,
    decimals: 9,
  });
});

test("transaction-wide swap logs do not attribute a buy to a watched non-signer", () => {
  const events = decodeParsedTransaction(
    target,
    parsedTx({
      targetSigner: false,
      swapLogs: true,
      preTokens: [tokenBalance(target, INPUT_MINT, 20), tokenBalance(target, OUTPUT_MINT, 0)],
      postTokens: [tokenBalance(target, INPUT_MINT, 0), tokenBalance(target, OUTPUT_MINT, 1_000)],
    }),
  );
  assert.equal(
    events.some((event) => event.kind === "swap" && event.side === "buy"),
    false,
  );
});

test("native SOL requires a trusted swap and carries only the adjusted spend", () => {
  const noSignal = decodeParsedTransaction(
    target,
    parsedTx({
      swapLogs: false,
      targetLamportDelta: -1_000_000_000,
      preTokens: [tokenBalance(target, OUTPUT_MINT, 0)],
      postTokens: [tokenBalance(target, OUTPUT_MINT, 1_000)],
    }),
  );
  assert.equal(
    noSignal.some((event) => event.kind === "swap" && event.side === "buy"),
    false,
  );

  const trustedSwap = decodeParsedTransaction(
    target,
    parsedTx({
      swapLogs: true,
      targetLamportDelta: -1_000_000_000,
      preTokens: [tokenBalance(target, OUTPUT_MINT, 0)],
      postTokens: [tokenBalance(target, OUTPUT_MINT, 1_000)],
    }),
  );
  const buy = trustedSwap.find((event) => event.kind === "swap" && event.side === "buy");
  assert.ok(buy && buy.kind === "swap");
  assert.equal(buy.solSpend, 0.994995);
});

test("an untrusted program printing Swap cannot authorize a target buy", () => {
  const untrustedProgram = "11111111111111111111111111111111";
  const events = decodeParsedTransaction(
    target,
    parsedTx({
      logMessages: [
        `Program ${untrustedProgram} invoke [1]`,
        "Program log: Instruction: Swap",
        `Program ${untrustedProgram} success`,
      ],
      preTokens: [tokenBalance(target, INPUT_MINT, 20), tokenBalance(target, OUTPUT_MINT, 0)],
      postTokens: [tokenBalance(target, INPUT_MINT, 0), tokenBalance(target, OUTPUT_MINT, 1_000)],
    }),
  );
  assert.equal(
    events.some((event) => event.kind === "swap" && event.side === "buy"),
    false,
  );
});

test("plain outbound transfer remains a transfer and has no target-buy valuation", () => {
  const events = decodeParsedTransaction(
    target,
    parsedTx({
      swapLogs: false,
      preTokens: [tokenBalance(target, OUTPUT_MINT, 10), tokenBalance(recipient, OUTPUT_MINT, 0)],
      postTokens: [tokenBalance(target, OUTPUT_MINT, 0), tokenBalance(recipient, OUTPUT_MINT, 10)],
    }),
  );
  assert.deepEqual(
    events.map((event) => event.kind),
    ["transfer"],
  );
  assert.equal(events[0]?.kind === "transfer" ? events[0].to : undefined, recipient);
});

test("same-transaction buy and transfer-out preserves the verified input", () => {
  const events = decodeParsedTransaction(
    target,
    parsedTx({
      swapLogs: true,
      preTokens: [tokenBalance(target, INPUT_MINT, 20), tokenBalance(recipient, OUTPUT_MINT, 0)],
      postTokens: [
        tokenBalance(target, INPUT_MINT, 0),
        tokenBalance(recipient, OUTPUT_MINT, 1_000),
      ],
    }),
  );
  const buy = events.find(
    (event) => event.kind === "swap" && event.side === "buy" && event.tokenMint === OUTPUT_MINT,
  );
  assert.ok(buy && buy.kind === "swap");
  assert.equal(buy.spentToken?.mint, INPUT_MINT);
  assert.equal(buy.spentToken?.amountRaw, "20000000");
  assert.ok(
    events.some(
      (event) =>
        event.kind === "transfer" && event.tokenMint === OUTPUT_MINT && event.to === recipient,
    ),
  );
});

test("same-transaction partial forward keeps the legacy net buy and exact gross custody lot", () => {
  const events = decodeParsedTransaction(
    target,
    parsedTx({
      swapLogs: true,
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
    }),
  );
  const buys = events.filter((event) => event.kind === "swap" && event.side === "buy");
  assert.equal(buys.length, 1);
  const buy = buys[0];
  assert.ok(buy?.kind === "swap");
  assert.equal(buy.amountTokens, 40);
  assert.equal(buy.amountRaw, "40000000");
  assert.equal(buy.grossAmountTokens, 100);
  assert.equal(buy.grossAmountRaw, "100000000");
  assert.equal(buy.tokenBalanceBefore, 10);
  assert.equal(buy.tokenBalanceAfter, 50);
  assert.equal(buy.tokenBalanceBeforeRaw, "10000000");
  assert.equal(buy.tokenBalanceAfterRaw, "50000000");
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

test("custody coverage exposes an unsupported negative delta without changing legacy events", () => {
  const tx = parsedTx({
    preTokens: [exactTokenBalance(target, OUTPUT_MINT, "9007199254740992001", "9007199254740.992")],
    postTokens: [
      exactTokenBalance(target, OUTPUT_MINT, "9007199254740992000", "9007199254740.992"),
    ],
  });

  assert.deepEqual(decodeParsedTransaction(target, tx), []);
  const decoded = decodeParsedTransactionWithCoverage(target, tx);
  assert.deepEqual(decoded.events, []);
  assert.deepEqual(decoded.unresolvedOutflows, [
    {
      kind: "unresolved_outflow",
      wallet: target,
      tokenMint: OUTPUT_MINT,
      amountTokens: 0.000001,
      amountRaw: "1",
      preAmount: 9007199254740.992,
      postAmount: 9007199254740.992,
      preRaw: "9007199254740992001",
      postRaw: "9007199254740992000",
      decimals: 6,
      slot: 123,
      txSig: "signature",
      timestampMs: decoded.unresolvedOutflows[0]?.timestampMs,
      blockTimeMs: undefined,
      observedAtMs: decoded.unresolvedOutflows[0]?.observedAtMs,
      reason: "negative_token_delta_not_attributed",
    },
  ]);
});

test("custody coverage does not duplicate a conserving transfer as unresolved", () => {
  const decoded = decodeParsedTransactionWithCoverage(
    target,
    parsedTx({
      preTokens: [tokenBalance(target, OUTPUT_MINT, 10), tokenBalance(recipient, OUTPUT_MINT, 2)],
      postTokens: [tokenBalance(target, OUTPUT_MINT, 5), tokenBalance(recipient, OUTPUT_MINT, 7)],
    }),
  );

  assert.equal(decoded.events.filter((event) => event.kind === "transfer").length, 1);
  assert.deepEqual(decoded.unresolvedOutflows, []);
});

test("one spend with two distinct output mints fails closed", () => {
  const events = decodeParsedTransaction(
    target,
    parsedTx({
      swapLogs: true,
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
    }),
  );
  const buys = events.filter((event) => event.kind === "swap" && event.side === "buy");
  assert.equal(buys.length, 0);
});

test("ambiguous inputs and multiple inferred outputs are rejected", () => {
  const ambiguousInputEvents = decodeParsedTransaction(
    target,
    parsedTx({
      swapLogs: true,
      preTokens: [
        tokenBalance(target, INPUT_MINT, 20),
        tokenBalance(target, OTHER_INPUT_MINT, 20),
        tokenBalance(recipient, OUTPUT_MINT, 0),
      ],
      postTokens: [
        tokenBalance(target, INPUT_MINT, 0),
        tokenBalance(target, OTHER_INPUT_MINT, 0),
        tokenBalance(recipient, OUTPUT_MINT, 1_000),
      ],
    }),
  );
  assert.equal(
    ambiguousInputEvents.some(
      (event) => event.kind === "swap" && event.side === "buy" && event.tokenMint === OUTPUT_MINT,
    ),
    false,
  );

  const multipleOutputEvents = decodeParsedTransaction(
    target,
    parsedTx({
      swapLogs: true,
      preTokens: [
        tokenBalance(target, INPUT_MINT, 20),
        tokenBalance(recipient, OUTPUT_MINT, 0),
        tokenBalance(otherRecipient, OTHER_OUTPUT_MINT, 0),
      ],
      postTokens: [
        tokenBalance(target, INPUT_MINT, 0),
        tokenBalance(recipient, OUTPUT_MINT, 1_000),
        tokenBalance(otherRecipient, OTHER_OUTPUT_MINT, 1_000),
      ],
    }),
  );
  assert.equal(
    multipleOutputEvents.some(
      (event) =>
        event.kind === "swap" &&
        event.side === "buy" &&
        (event.tokenMint === OUTPUT_MINT || event.tokenMint === OTHER_OUTPUT_MINT),
    ),
    false,
  );
});

test("recipient token-account reallocation cannot manufacture an inferred buy", () => {
  const events = decodeParsedTransaction(
    target,
    parsedTx({
      swapLogs: true,
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
    }),
  );
  assert.equal(
    events.some((event) => event.kind === "swap" && event.side === "buy"),
    false,
  );
  assert.equal(
    events.some((event) => event.kind === "transfer"),
    false,
  );
});

test("RPC accepts a multi-signer sell only when the watched signer has one debit and one proceeds asset", () => {
  const events = decodeParsedTransaction(
    target,
    parsedTx({
      secondSigner: true,
      swapLogs: true,
      preTokens: [tokenBalance(target, OUTPUT_MINT, 100), tokenBalance(target, USDC_MINT, 0)],
      postTokens: [tokenBalance(target, OUTPUT_MINT, 25), tokenBalance(target, USDC_MINT, 60)],
    }),
  );

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

test("RPC rejects untrusted and ambiguous target sells", () => {
  const untrustedProgram = "11111111111111111111111111111111";
  const untrusted = decodeParsedTransaction(
    target,
    parsedTx({
      logMessages: [
        `Program ${untrustedProgram} invoke [1]`,
        "Program log: Instruction: Swap",
        `Program ${untrustedProgram} success`,
      ],
      preTokens: [tokenBalance(target, OUTPUT_MINT, 100), tokenBalance(target, USDC_MINT, 0)],
      postTokens: [tokenBalance(target, OUTPUT_MINT, 0), tokenBalance(target, USDC_MINT, 60)],
    }),
  );
  assert.equal(
    untrusted.some((event) => event.kind === "swap" && event.side === "sell"),
    false,
  );

  const nonSigner = decodeParsedTransaction(
    target,
    parsedTx({
      targetSigner: false,
      swapLogs: true,
      preTokens: [tokenBalance(target, OUTPUT_MINT, 100), tokenBalance(target, USDC_MINT, 0)],
      postTokens: [tokenBalance(target, OUTPUT_MINT, 0), tokenBalance(target, USDC_MINT, 60)],
    }),
  );
  assert.equal(
    nonSigner.some((event) => event.kind === "swap" && event.side === "sell"),
    false,
  );

  const ambiguous = decodeParsedTransaction(
    target,
    parsedTx({
      swapLogs: true,
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
    }),
  );
  assert.equal(
    ambiguous.some((event) => event.kind === "swap" && event.side === "sell"),
    false,
  );
});

test("RPC emits a single conserving batch with every split-transfer recipient", () => {
  const events = decodeParsedTransaction(
    target,
    parsedTx({
      swapLogs: false,
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
    }),
  );
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

test("RPC poller durably drains more than 5,000 signatures without skipping", async () => {
  const signatures = Array.from({ length: 5_101 }, (_, index) => {
    const slot = 5_201 - index;
    return {
      signature: `sig-${slot}`,
      slot,
      err: null,
      memo: null,
      blockTime: slot * 10,
      confirmationStatus: "confirmed" as const,
    };
  });
  signatures.push({
    signature: "sig-100",
    slot: 100,
    err: null,
    memo: null,
    blockTime: 1_000,
    confirmationStatus: "confirmed",
  });

  const advances: string[] = [];
  const parsedSignatures: string[] = [];
  let backlogMarks = 0;
  let successMarks = 0;
  let current: RpcWalletCursor = {
    userId: "user-1",
    wallet: target,
    startSlot: 100,
    lastProcessedSignature: "sig-100",
    lastProcessedSlot: 100,
    lastBlockTime: 1_000,
    backlogDetected: false,
    lastSuccessAt: null,
    lastError: null,
    createdAt: null,
    updatedAt: null,
  };
  const store: RpcCursorStore = {
    async load() {
      return { ...current };
    },
    async ensure() {
      return { ...current };
    },
    async advance(_wallet, signatureValue, slot, blockTime) {
      advances.push(signatureValue);
      current = {
        ...current,
        lastProcessedSignature: signatureValue,
        lastProcessedSlot: slot,
        lastBlockTime: blockTime,
      };
      return { ...current };
    },
    async markBacklog() {
      backlogMarks += 1;
      current = { ...current, backlogDetected: true, lastError: "sanitized" };
      return { ...current };
    },
    async markSuccess() {
      successMarks += 1;
      current = {
        ...current,
        backlogDetected: false,
        lastError: null,
        lastSuccessAt: new Date().toISOString(),
      };
      return { ...current };
    },
  };
  const connection = {
    async getSignaturesForAddress(_wallet: unknown, options: { limit: number; before?: string }) {
      const start = options.before
        ? signatures.findIndex((row) => row.signature === options.before) + 1
        : 0;
      return signatures.slice(start, start + options.limit);
    },
    async getParsedTransactions(requested: string[]) {
      parsedSignatures.push(...requested);
      return requested.map((signatureValue) => ({
        slot: Number(signatureValue.slice(4)),
        blockTime: null,
        transaction: {
          signatures: [signatureValue],
          message: { accountKeys: [{ pubkey: target, signer: true }] },
        },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [1_000_000_000],
          postBalances: [999_995_000],
          preTokenBalances: [],
          postTokenBalances: [],
          logMessages: [],
        },
      }));
    },
  };
  const poller = new RpcBackfillPoller(connection as any, async () => {}, store);

  await (poller as any).pollWallet(target, {});
  assert.equal(parsedSignatures.length, 5_000);
  assert.equal(new Set(parsedSignatures).size, 5_000);
  assert.equal(parsedSignatures[0], "sig-101");
  assert.equal(parsedSignatures.at(-1), "sig-5100");
  assert.equal(advances.length, 100);
  assert.equal(advances[0], "sig-150");
  assert.equal(advances.at(-1), "sig-5100");
  assert.equal(current.lastProcessedSignature, "sig-5100");
  assert.equal(backlogMarks, 1);
  assert.equal(successMarks, 0);
  assert.equal(poller.health().backlogWalletCount, 1);

  await (poller as any).pollWallet(target, {});
  assert.equal(parsedSignatures.length, 5_101);
  assert.equal(new Set(parsedSignatures).size, 5_101);
  assert.equal(parsedSignatures.at(-1), "sig-5201");
  assert.equal(advances.length, 103);
  assert.equal(advances.at(-1), "sig-5201");
  assert.equal(new Set(advances).size, 103);
  assert.equal(successMarks, 1);
  assert.equal(poller.health().backlogWalletCount, 0);
});

test("custody time-slices deep signature discovery and reuses the in-memory recovery queue", async () => {
  const signatures = Array.from({ length: 1_101 }, (_, index) => {
    const slot = 1_201 - index;
    return {
      signature: `sig-${slot}`,
      slot,
      err: null,
      memo: null,
      blockTime: slot,
    };
  });
  signatures.push({ signature: "sig-100", slot: 100, err: null, memo: null, blockTime: 100 });
  let current = testCursor(target, {
    startSlot: 100,
    lastProcessedSignature: "sig-100",
    lastProcessedSlot: 100,
  });
  let signaturePageCalls = 0;
  const handled: string[] = [];
  const store: RpcCursorStore = {
    async load() {
      return { ...current };
    },
    async ensure() {
      return { ...current };
    },
    async advance(_wallet, signature, slot, blockTime) {
      current = {
        ...current,
        lastProcessedSignature: signature,
        lastProcessedSlot: slot,
        lastBlockTime: blockTime,
      };
      return { ...current };
    },
    async markBacklog() {
      current = { ...current, backlogDetected: true };
      return { ...current };
    },
    async markSuccess() {
      current = { ...current, backlogDetected: false };
      return { ...current };
    },
  };
  const connection = {
    async getSignaturesForAddress(_wallet: unknown, options: { before?: string; limit: number }) {
      signaturePageCalls += 1;
      const start = options.before
        ? signatures.findIndex((row) => row.signature === options.before) + 1
        : 0;
      return signatures.slice(start, start + options.limit);
    },
    async getParsedTransactions(requested: string[]) {
      handled.push(...requested);
      return requested.map((signature) => ({
        slot: Number(signature.slice(4)),
        blockTime: null,
        transaction: {
          signatures: [signature],
          message: { accountKeys: [{ pubkey: target, signer: true }] },
        },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [1_000_000_000],
          postBalances: [999_995_000],
          preTokenBalances: [],
          postTokenBalances: [],
          logMessages: [],
        },
      }));
    },
  };
  const poller = new RpcBackfillPoller(connection as any, async () => {}, store, 1_200, true, {
    signaturePagesPerTurn: 1,
    recoveryChunkSize: 50,
  });

  await (poller as any).pollWallet(target, {});
  assert.equal(signaturePageCalls, 1);
  assert.equal(handled.length, 0);
  await (poller as any).pollWallet(target, {});
  assert.equal(signaturePageCalls, 2);
  assert.equal(handled.length, 50);
  await (poller as any).pollWallet(target, {});
  assert.equal(signaturePageCalls, 2);
  assert.equal(handled.length, 100);
  assert.deepEqual(handled.slice(0, 3), ["sig-101", "sig-102", "sig-103"]);
});

test("a failed batch checkpoint replays idempotently without skipping handled transactions", async () => {
  let current: RpcWalletCursor = {
    userId: "user-1",
    wallet: target,
    startSlot: 100,
    lastProcessedSignature: "sig-100",
    lastProcessedSlot: 100,
    lastBlockTime: 1_000,
    backlogDetected: false,
    lastSuccessAt: null,
    lastError: null,
    createdAt: null,
    updatedAt: null,
  };
  let failNextCheckpoint = true;
  let checkpointAttempts = 0;
  const store: RpcCursorStore = {
    async load() {
      return { ...current };
    },
    async ensure() {
      return { ...current };
    },
    async advance(_wallet, signatureValue, slot, blockTime) {
      checkpointAttempts += 1;
      if (failNextCheckpoint) {
        failNextCheckpoint = false;
        throw new Error("checkpoint unavailable");
      }
      current = {
        ...current,
        lastProcessedSignature: signatureValue,
        lastProcessedSlot: slot,
        lastBlockTime: blockTime,
      };
      return { ...current };
    },
    async markBacklog() {
      return { ...current, backlogDetected: true };
    },
    async markSuccess() {
      current = { ...current, backlogDetected: false };
      return { ...current };
    },
  };
  const signatures = [
    { signature: "sig-102", slot: 102, err: null, memo: null, blockTime: 1_020 },
    { signature: "sig-101", slot: 101, err: null, memo: null, blockTime: 1_010 },
    { signature: "sig-100", slot: 100, err: null, memo: null, blockTime: 1_000 },
  ];
  const connection = {
    async getSignaturesForAddress() {
      return signatures;
    },
    async getParsedTransactions(requested: string[]) {
      return requested.map((signatureValue) => {
        const slot = Number(signatureValue.slice(4));
        const tx = parsedTx({
          targetSigner: true,
          swapLogs: false,
          preTokens: [
            tokenBalance(target, OUTPUT_MINT, 10),
            tokenBalance(recipient, OUTPUT_MINT, 0),
          ],
          postTokens: [
            tokenBalance(target, OUTPUT_MINT, 0),
            tokenBalance(recipient, OUTPUT_MINT, 10),
          ],
        });
        return {
          ...tx,
          slot,
          blockTime: slot * 10,
          transaction: { ...tx.transaction, signatures: [signatureValue] },
        };
      });
    },
  };
  let handlerAttempts = 0;
  const durablyHandled = new Set<string>();
  const poller = new RpcBackfillPoller(
    connection as any,
    async (event) => {
      handlerAttempts += 1;
      durablyHandled.add(`${event.txSig}:${event.kind}:${event.tokenMint}`);
    },
    store,
  );

  await assert.rejects((poller as any).pollWallet(target, {}), /checkpoint unavailable/);
  assert.equal(current.lastProcessedSignature, "sig-100");
  assert.equal(handlerAttempts, 2);
  assert.equal(durablyHandled.size, 2);

  await (poller as any).pollWallet(target, {});
  assert.equal(current.lastProcessedSignature, "sig-102");
  assert.equal(checkpointAttempts, 2);
  assert.equal(handlerAttempts, 4);
  assert.equal(durablyHandled.size, 2);
});

test("RPC poller decodes the activation head before advancing a new cursor", async () => {
  const order: string[] = [];
  let current: RpcWalletCursor | null = null;
  const head = {
    signature: "activation-head",
    slot: 500,
    err: null,
    memo: null,
    blockTime: 5_000,
    confirmationStatus: "confirmed" as const,
  };
  const store: RpcCursorStore = {
    async load() {
      return current ? { ...current } : null;
    },
    async ensure(wallet, anchorSlot = 0) {
      current ??= {
        userId: "user-1",
        wallet,
        startSlot: anchorSlot,
        lastProcessedSignature: null,
        lastProcessedSlot: null,
        lastBlockTime: null,
        backlogDetected: false,
        lastSuccessAt: null,
        lastError: null,
        createdAt: null,
        updatedAt: null,
      };
      return { ...current };
    },
    async advance(_wallet, signatureValue, slot, blockTime) {
      order.push("advance");
      current = {
        ...current!,
        lastProcessedSignature: signatureValue,
        lastProcessedSlot: slot,
        lastBlockTime: blockTime,
      };
      return { ...current };
    },
    async markBacklog() {
      return { ...current!, backlogDetected: true };
    },
    async markSuccess() {
      current = { ...current!, backlogDetected: false, lastSuccessAt: new Date().toISOString() };
      return { ...current };
    },
  };
  let signatureCall = 0;
  const connection = {
    async getSignaturesForAddress() {
      signatureCall += 1;
      order.push(signatureCall === 1 ? "head" : "page");
      return [head];
    },
    async getParsedTransactions() {
      order.push("parsed");
      return [
        {
          slot: head.slot,
          blockTime: head.blockTime,
          transaction: {
            signatures: [head.signature],
            message: { accountKeys: [{ pubkey: target, signer: true }] },
          },
          meta: {
            err: null,
            fee: 5_000,
            preBalances: [1_000_000_000],
            postBalances: [999_995_000],
            preTokenBalances: [],
            postTokenBalances: [],
            logMessages: [],
          },
        },
      ];
    },
  };
  const poller = new RpcBackfillPoller(connection as any, async () => {}, store, 1_200, true);
  await (poller as any).pollWallet(target, {});
  assert.deepEqual(order, ["head", "page", "parsed", "advance"]);
  assert.equal((await store.load(target))?.lastProcessedSignature, head.signature);
});

test("custody unresolved outflow persistence must succeed before the cursor advances", async () => {
  let current: RpcWalletCursor = {
    userId: "user-1",
    wallet: target,
    startSlot: 100,
    lastProcessedSignature: "boundary",
    lastProcessedSlot: 100,
    lastBlockTime: 1_000,
    backlogDetected: false,
    lastSuccessAt: null,
    lastError: null,
    createdAt: null,
    updatedAt: null,
  };
  let advances = 0;
  const store: RpcCursorStore = {
    async load() {
      return { ...current };
    },
    async ensure() {
      return { ...current };
    },
    async advance(_wallet, signatureValue, slot, blockTime) {
      advances += 1;
      current = {
        ...current,
        lastProcessedSignature: signatureValue,
        lastProcessedSlot: slot,
        lastBlockTime: blockTime,
      };
      return { ...current };
    },
    async markBacklog() {
      return { ...current, backlogDetected: true };
    },
    async markSuccess() {
      return { ...current, backlogDetected: false };
    },
  };
  const connection = {
    async getSignaturesForAddress() {
      return [
        {
          signature: "unresolved-tx",
          slot: 101,
          err: null,
          memo: null,
          blockTime: 1_010,
        },
        { signature: "boundary", slot: 100, err: null, memo: null, blockTime: 1_000 },
      ];
    },
    async getParsedTransactions() {
      return [
        {
          slot: 101,
          blockTime: 1_010,
          transaction: {
            signatures: ["unresolved-tx"],
            message: { accountKeys: [{ pubkey: target, signer: true }] },
          },
          meta: {
            err: null,
            fee: 5_000,
            preBalances: [1_000_000_000],
            postBalances: [999_995_000],
            preTokenBalances: [tokenBalance(target, OUTPUT_MINT, 10)],
            postTokenBalances: [tokenBalance(target, OUTPUT_MINT, 5)],
            logMessages: [],
          },
        },
      ];
    },
  };
  let observations = 0;
  const poller = new RpcBackfillPoller(connection as any, async () => {}, store, 1_200, false, {
    onUnresolvedOutflow: async (event) => {
      observations += 1;
      assert.equal(event.source, "rpc");
      assert.equal(event.delivery, "catchup");
      throw new Error("persistence unavailable");
    },
  });

  await assert.rejects((poller as any).pollWallet(target, {}), /persistence unavailable/);
  assert.equal(observations, 1);
  assert.equal(advances, 0);
  assert.equal(current.lastProcessedSignature, "boundary");
});

test("an existing durable cursor is never raised to a newer watch anchor", async () => {
  let current: RpcWalletCursor = {
    userId: "user-1",
    wallet: target,
    startSlot: 100,
    lastProcessedSignature: "sig-100",
    lastProcessedSlot: 100,
    lastBlockTime: 1_000,
    backlogDetected: false,
    lastSuccessAt: null,
    lastError: null,
    createdAt: null,
    updatedAt: null,
  };
  const advanced: string[] = [];
  const parsed: string[] = [];
  const store: RpcCursorStore = {
    async load() {
      return { ...current };
    },
    async ensure() {
      return { ...current };
    },
    async advance(_wallet, signatureValue, slot, blockTime) {
      advanced.push(signatureValue);
      current = {
        ...current,
        lastProcessedSignature: signatureValue,
        lastProcessedSlot: slot,
        lastBlockTime: blockTime,
      };
      return { ...current };
    },
    async markBacklog() {
      return { ...current, backlogDetected: true };
    },
    async markSuccess() {
      return { ...current, backlogDetected: false };
    },
  };
  const signatures = [
    { signature: "sig-200", slot: 200, err: null, memo: null, blockTime: 2_000 },
    { signature: "sig-101", slot: 101, err: null, memo: null, blockTime: 1_010 },
    { signature: "sig-100", slot: 100, err: null, memo: null, blockTime: 1_000 },
  ];
  const connection = {
    async getSignaturesForAddress() {
      return signatures;
    },
    async getParsedTransactions(requested: string[]) {
      parsed.push(...requested);
      return requested.map((signatureValue) => ({
        slot: Number(signatureValue.slice(4)),
        blockTime: null,
        transaction: {
          signatures: [signatureValue],
          message: { accountKeys: [{ pubkey: target, signer: true }] },
        },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [1_000_000_000],
          postBalances: [999_995_000],
          preTokenBalances: [],
          postTokenBalances: [],
          logMessages: [],
        },
      }));
    },
  };
  const poller = new RpcBackfillPoller(connection as any, async () => {}, store);
  await (poller as any).pollWallet(target, { anchorSlot: 300 });
  assert.deepEqual(parsed, ["sig-101", "sig-200"]);
  assert.deepEqual(advanced, ["sig-200"]);
});

test("custody rewinds an existing wallet cursor for a newly discovered earlier mint anchor", async () => {
  let current: RpcWalletCursor = {
    userId: "user-1",
    wallet: target,
    startSlot: 180,
    lastProcessedSignature: "sig-200",
    lastProcessedSlot: 200,
    lastBlockTime: 2_000,
    backlogDetected: false,
    lastSuccessAt: null,
    lastError: null,
    createdAt: null,
    updatedAt: null,
  };
  let rewinds = 0;
  const advanced: string[] = [];
  const parsed: string[] = [];
  const store: RpcCursorStore = {
    async load() {
      return { ...current };
    },
    async ensure() {
      return { ...current };
    },
    async rewind(_wallet, anchorSlot) {
      rewinds += 1;
      current = {
        ...current,
        startSlot: anchorSlot,
        lastProcessedSignature: null,
        lastProcessedSlot: anchorSlot,
        lastBlockTime: null,
        backlogDetected: true,
      };
      return { ...current };
    },
    async advance(_wallet, signatureValue, slot, blockTime) {
      advanced.push(signatureValue);
      current = {
        ...current,
        lastProcessedSignature: signatureValue,
        lastProcessedSlot: slot,
        lastBlockTime: blockTime,
      };
      return { ...current };
    },
    async markBacklog() {
      return { ...current, backlogDetected: true };
    },
    async markSuccess() {
      current = { ...current, backlogDetected: false };
      return { ...current };
    },
  };
  const signatures = [
    { signature: "sig-200", slot: 200, err: null, memo: null, blockTime: 2_000 },
    { signature: "sig-175", slot: 175, err: null, memo: null, blockTime: 1_750 },
    { signature: "sig-150", slot: 150, err: null, memo: null, blockTime: 1_500 },
  ];
  const connection = {
    async getSignaturesForAddress() {
      return signatures;
    },
    async getParsedTransactions(requested: string[]) {
      parsed.push(...requested);
      return requested.map((signatureValue) => ({
        slot: Number(signatureValue.slice(4)),
        blockTime: null,
        transaction: {
          signatures: [signatureValue],
          message: { accountKeys: [{ pubkey: target, signer: true }] },
        },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [1_000_000_000],
          postBalances: [999_995_000],
          preTokenBalances: [],
          postTokenBalances: [],
          logMessages: [],
        },
      }));
    },
  };
  const poller = new RpcBackfillPoller(connection as any, async () => {}, store, 1_200, true, {
    allowEarlierAnchorRewind: true,
  });
  poller.watch(target);
  await new Promise<void>((resolve) => setImmediate(resolve));
  poller.watch(target, { anchorSlot: 150 });
  const recoveredWatch = (poller as any).watched.get(target);
  assert.equal(recoveredWatch.anchorSlot, 150);
  await (poller as any).pollWallet(target, recoveredWatch);
  assert.equal(rewinds, 1);
  assert.deepEqual(parsed, ["sig-150", "sig-175", "sig-200"]);
  assert.deepEqual(advanced, ["sig-200"]);

  await (poller as any).pollWallet(target, { anchorSlot: 150 });
  const restartedPoller = new RpcBackfillPoller(
    connection as any,
    async () => {},
    store,
    1_200,
    true,
    { allowEarlierAnchorRewind: true },
  );
  await (restartedPoller as any).pollWallet(target, { anchorSlot: 150 });
  assert.equal(rewinds, 1);
  assert.deepEqual(parsed, ["sig-150", "sig-175", "sig-200"]);
  assert.deepEqual(advanced, ["sig-200"]);
});

test("custody never rewinds an anchor already covered by the durable start slot", async () => {
  const current: RpcWalletCursor = {
    userId: "user-1",
    wallet: target,
    startSlot: 100,
    lastProcessedSignature: "sig-200",
    lastProcessedSlot: 200,
    lastBlockTime: 2_000,
    backlogDetected: false,
    lastSuccessAt: null,
    lastError: null,
    createdAt: null,
    updatedAt: null,
  };
  let rewinds = 0;
  const store: RpcCursorStore = {
    async load() {
      return { ...current };
    },
    async ensure() {
      return { ...current };
    },
    async rewind() {
      rewinds += 1;
      return { ...current };
    },
    async advance() {
      return { ...current };
    },
    async markBacklog() {
      return { ...current, backlogDetected: true };
    },
    async markSuccess() {
      return { ...current };
    },
  };
  const connection = {
    async getSignaturesForAddress() {
      return [{ signature: "sig-200", slot: 200, err: null, memo: null, blockTime: 2_000 }];
    },
    async getParsedTransactions() {
      return [];
    },
  };
  const poller = new RpcBackfillPoller(connection as any, async () => {}, store, 1_200, true, {
    allowEarlierAnchorRewind: true,
  });

  poller.watch(target, { anchorSlot: 150 });
  await (poller as any).pollWallet(target, { anchorSlot: 150 });
  poller.watch(target, { anchorSlot: 150 });
  await (poller as any).pollWallet(target, { anchorSlot: 150 });
  assert.equal(rewinds, 0);
});

test("RPC health is fail-closed while hydrating and restores a durable backlog", async () => {
  let resolveLoad!: (cursor: RpcWalletCursor | null) => void;
  const loadResult = new Promise<RpcWalletCursor | null>((resolve) => {
    resolveLoad = resolve;
  });
  const durableCursor: RpcWalletCursor = {
    userId: "user-1",
    wallet: target,
    startSlot: 100,
    lastProcessedSignature: "sig-100",
    lastProcessedSlot: 100,
    lastBlockTime: 1_000,
    backlogDetected: true,
    lastSuccessAt: null,
    lastError: "sanitized backlog",
    createdAt: null,
    updatedAt: null,
  };
  const store: RpcCursorStore = {
    async load() {
      return loadResult;
    },
    async ensure() {
      return { ...durableCursor };
    },
    async advance() {
      return { ...durableCursor };
    },
    async markBacklog() {
      return { ...durableCursor };
    },
    async markSuccess() {
      return { ...durableCursor, backlogDetected: false, lastError: null };
    },
  };
  const poller = new RpcBackfillPoller({} as any, async () => {}, store);

  poller.watch(target);
  assert.equal(poller.health().cursorHydrationPendingCount, 1);
  assert.equal(poller.health().backlogWalletCount, 1);

  resolveLoad(durableCursor);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(poller.health().cursorHydrationPendingCount, 0);
  assert.equal(poller.health().detectedBacklogWalletCount, 1);
  assert.equal(poller.health().backlogWalletCount, 1);

  poller.unwatch(target);
  assert.equal(poller.health().backlogWalletCount, 0);
});

test("startup cursor hydration uses one bulk store pass for the whole watch set", async () => {
  const secondWallet = Keypair.generate().publicKey.toBase58();
  const wallets = [target, secondWallet];
  let singleLoads = 0;
  let bulkLoads = 0;
  const store: RpcCursorStore = {
    async load() {
      singleLoads += 1;
      throw new Error("single cursor load should not run");
    },
    async loadMany(requested) {
      bulkLoads += 1;
      assert.deepEqual(requested, wallets);
      return new Map(requested.map((wallet) => [wallet, testCursor(wallet)]));
    },
    async ensure(wallet) {
      return testCursor(wallet);
    },
    async advance(wallet) {
      return testCursor(wallet);
    },
    async markBacklog(wallet) {
      return testCursor(wallet, { backlogDetected: true });
    },
    async markSuccess(wallet) {
      return testCursor(wallet);
    },
  };
  const poller = new RpcBackfillPoller({} as any, async () => {}, store, 1_200, false, {
    deferInitialCursorHydration: true,
  });

  wallets.forEach((wallet) => poller.watch(wallet));
  assert.equal(poller.health().cursorHydrationPendingCount, 2);
  await poller.hydrateWatchedCursors();

  assert.equal(bulkLoads, 1);
  assert.equal(singleLoads, 0);
  assert.equal(poller.health().cursorHydrationPendingCount, 0);
  assert.equal(poller.health().backlogWalletCount, 0);
});

test("a slow wallet lane does not block another wallet or overlap itself", async () => {
  const slowWallet = Keypair.generate().publicKey.toBase58();
  const fastWallet = Keypair.generate().publicKey.toBase58();
  let releaseSlow!: () => void;
  const slowGate = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  let slowCalls = 0;
  let fastCalls = 0;
  let activeSlow = 0;
  let maximumActiveSlow = 0;
  const store: RpcCursorStore = {
    async load(wallet) {
      return testCursor(wallet);
    },
    async ensure(wallet) {
      return testCursor(wallet);
    },
    async advance(wallet) {
      return testCursor(wallet);
    },
    async markBacklog(wallet) {
      return testCursor(wallet, { backlogDetected: true });
    },
    async markSuccess(wallet) {
      return testCursor(wallet);
    },
  };
  const poller = new RpcBackfillPoller({} as any, async () => {}, store, 1_200, false, {
    pollConcurrency: 2,
    maxWalletsPerPoll: 1,
    deferInitialCursorHydration: true,
  });
  (poller as any).pollWallet = async (wallet: string) => {
    if (wallet === slowWallet) {
      slowCalls += 1;
      activeSlow += 1;
      maximumActiveSlow = Math.max(maximumActiveSlow, activeSlow);
      await slowGate;
      activeSlow -= 1;
      return;
    }
    fastCalls += 1;
  };
  poller.watch(slowWallet);
  poller.watch(fastWallet);

  await (poller as any).poll();
  assert.equal(slowCalls, 1);
  assert.equal(poller.health().inFlightWalletCount, 1);

  await (poller as any).poll();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fastCalls, 1);
  assert.equal(slowCalls, 1);

  await (poller as any).poll();
  await (poller as any).poll();
  assert.equal(slowCalls, 1);
  assert.equal(maximumActiveSlow, 1);

  releaseSlow();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(activeSlow, 0);
  assert.equal(poller.health().inFlightWalletCount, 0);
});

test("historical recovery cannot consume the lane reserved for current wallets", async () => {
  const recoveryOne = Keypair.generate().publicKey.toBase58();
  const recoveryTwo = Keypair.generate().publicKey.toBase58();
  const currentWallet = Keypair.generate().publicKey.toBase58();
  let releaseRecovery!: () => void;
  const recoveryGate = new Promise<void>((resolve) => {
    releaseRecovery = resolve;
  });
  const started: string[] = [];
  const store: RpcCursorStore = {
    async load(wallet) {
      return testCursor(wallet);
    },
    async ensure(wallet) {
      return testCursor(wallet);
    },
    async advance(wallet) {
      return testCursor(wallet);
    },
    async markBacklog(wallet) {
      return testCursor(wallet, { backlogDetected: true });
    },
    async markSuccess(wallet) {
      return testCursor(wallet);
    },
  };
  const poller = new RpcBackfillPoller({} as any, async () => {}, store, 1_200, false, {
    pollConcurrency: 2,
    recoveryConcurrency: 1,
    maxWalletsPerPoll: 2,
    deferInitialCursorHydration: true,
  });
  (poller as any).pollWallet = async (wallet: string) => {
    started.push(wallet);
    if (wallet !== currentWallet) await recoveryGate;
  };
  poller.watch(recoveryOne);
  poller.watch(recoveryTwo);
  poller.watch(currentWallet);
  (poller as any).cursorHydrationPending.clear();
  (poller as any).backlogWallets.add(recoveryOne);
  (poller as any).backlogWallets.add(recoveryTwo);

  await (poller as any).poll();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(new Set(started), new Set([recoveryOne, currentWallet]));
  assert.equal((poller as any).walletLaneInFlight.get(recoveryOne), "recovery");
  assert.equal((poller as any).walletLaneInFlight.has(recoveryTwo), false);

  releaseRecovery();
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("recovery lanes rotate instead of relaunching the first deep wallet", async () => {
  const recoveryWallets = Array.from({ length: 3 }, () => Keypair.generate().publicKey.toBase58());
  const started: string[] = [];
  let releaseTurn: (() => void) | undefined;
  const store: RpcCursorStore = {
    async load(wallet) {
      return testCursor(wallet);
    },
    async ensure(wallet) {
      return testCursor(wallet);
    },
    async advance(wallet) {
      return testCursor(wallet);
    },
    async markBacklog(wallet) {
      return testCursor(wallet, { backlogDetected: true });
    },
    async markSuccess(wallet) {
      return testCursor(wallet);
    },
  };
  const poller = new RpcBackfillPoller({} as any, async () => {}, store, 1_200, false, {
    pollConcurrency: 2,
    recoveryConcurrency: 1,
    maxWalletsPerPoll: 2,
    deferInitialCursorHydration: true,
  });
  (poller as any).pollWallet = async (wallet: string) => {
    started.push(wallet);
    await new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
  };
  for (const wallet of recoveryWallets) {
    poller.watch(wallet);
    (poller as any).backlogWallets.add(wallet);
  }
  (poller as any).cursorHydrationPending.clear();

  for (let turn = 0; turn < recoveryWallets.length; turn += 1) {
    await (poller as any).poll();
    assert.equal(started.length, turn + 1);
    // Exercise a timer turn while the sole recovery lane is saturated. It must
    // not reset the round-robin position back to the first wallet.
    await (poller as any).poll();
    assert.equal(started.length, turn + 1);
    releaseTurn?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(started, recoveryWallets);
});

test("a failing wallet backs off independently while healthy wallets keep polling", async () => {
  const failingWallet = Keypair.generate().publicKey.toBase58();
  const healthyWallet = Keypair.generate().publicKey.toBase58();
  let failingCalls = 0;
  let healthyCalls = 0;
  let backlogMarks = 0;
  const store: RpcCursorStore = {
    async load(wallet) {
      return testCursor(wallet);
    },
    async ensure(wallet) {
      return testCursor(wallet);
    },
    async advance(wallet) {
      return testCursor(wallet);
    },
    async markBacklog(wallet) {
      backlogMarks += 1;
      return testCursor(wallet, { backlogDetected: true });
    },
    async markSuccess(wallet) {
      return testCursor(wallet);
    },
  };
  const poller = new RpcBackfillPoller({} as any, async () => {}, store, 1_200, false, {
    pollConcurrency: 2,
    maxWalletsPerPoll: 2,
    deferInitialCursorHydration: true,
  });
  (poller as any).pollWallet = async (wallet: string) => {
    if (wallet === failingWallet) {
      failingCalls += 1;
      throw new Error("provider unavailable");
    }
    healthyCalls += 1;
  };
  poller.watch(failingWallet);
  poller.watch(healthyWallet);

  await (poller as any).poll();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const firstRetryAt = (poller as any).walletRetryAt.get(failingWallet) as number;
  assert.equal(failingCalls, 1);
  assert.equal(healthyCalls, 1);
  assert.equal(backlogMarks, 1);
  assert.ok(firstRetryAt > Date.now());

  await (poller as any).poll();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(failingCalls, 1);
  assert.equal(healthyCalls, 2);

  (poller as any).walletRetryAt.set(failingWallet, Date.now() - 1);
  await (poller as any).poll();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const secondRetryAt = (poller as any).walletRetryAt.get(failingWallet) as number;
  assert.equal(failingCalls, 2);
  assert.equal(healthyCalls, 3);
  assert.equal(backlogMarks, 1);
  assert.ok(secondRetryAt > firstRetryAt);
  assert.equal(poller.health().failures, 2);
  assert.equal(poller.health().inFlightWalletCount, 0);
});
