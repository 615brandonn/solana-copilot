import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";

import { decodeParsedTransaction } from "./poller.js";
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

function parsedTx(options: {
  targetSigner?: boolean;
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
