import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";

import { GeyserFeed, type FeedEvent } from "./geyser.js";
import { USDC_MINT, WSOL_MINT } from "./swap-attribution.js";
import { VERIFIED_SWAP_PROGRAMS } from "./swap-signal.js";

const target = Keypair.generate().publicKey.toBase58();
const payer = Keypair.generate().publicKey.toBase58();
const recipient = Keypair.generate().publicKey.toBase58();
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
      ? [payer, target, recipient]
      : options.secondSigner
        ? [target, payer, recipient]
        : [target, recipient];
  const requiredSignatures = options.targetSigner === false || options.secondSigner ? 2 : 1;
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
