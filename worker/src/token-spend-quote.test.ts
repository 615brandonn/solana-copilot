import assert from "node:assert/strict";
import test from "node:test";

import { USDC_MINT, type VerifiedTokenSpend } from "./swap-attribution.js";
import { createTokenSpendQuoter } from "./token-spend-quote.js";

const INPUT_MINT = "input-token";
const OUTPUT_MINT = "bought-token";
const spentToken: VerifiedTokenSpend = {
  mint: INPUT_MINT,
  amountRaw: "20000000",
  amountTokens: 20,
  decimals: 6,
};

function validQuote() {
  return {
    transaction: null,
    inputMint: INPUT_MINT,
    outputMint: USDC_MINT,
    inAmount: spentToken.amountRaw,
    outAmount: "80000000",
    inUsdValue: 82,
    outUsdValue: 80,
    priceImpact: 2,
    router: "metis",
    routePlan: [
      {
        swapInfo: {
          inputMint: INPUT_MINT,
          outputMint: USDC_MINT,
        },
      },
    ],
  };
}

test("a transient quote failure is retried inside one bounded request", async () => {
  let calls = 0;
  const quote = createTokenSpendQuoter({
    apiKey: "test-key",
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => validQuote() };
    },
  });

  assert.equal(await quote(spentToken, OUTPUT_MINT), 72);
  assert.equal(calls, 2);
});

test("concurrent feed copies share the retry after a transient failure", async () => {
  let calls = 0;
  let release!: () => void;
  const firstAttempt = new Promise<void>((resolve) => {
    release = resolve;
  });
  const quote = createTokenSpendQuoter({
    apiKey: "test-key",
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        await firstAttempt;
        return { ok: false, json: async () => ({}) };
      }
      return { ok: true, json: async () => validQuote() };
    },
  });

  const geyser = quote(spentToken, OUTPUT_MINT);
  const rpc = quote(spentToken, OUTPUT_MINT);
  release();
  assert.deepEqual(await Promise.all([geyser, rpc]), [72, 72]);
  assert.equal(calls, 2);
});

test("identical concurrent quotes coalesce and successful results are cached", async () => {
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const quote = createTokenSpendQuoter({
    apiKey: "test-key",
    fetchImpl: async () => {
      calls += 1;
      await blocked;
      return { ok: true, json: async () => validQuote() };
    },
  });

  const geyser = quote(spentToken, OUTPUT_MINT);
  const rpc = quote(spentToken, OUTPUT_MINT);
  release();
  assert.deepEqual(await Promise.all([geyser, rpc]), [72, 72]);
  assert.equal(await quote(spentToken, OUTPUT_MINT), 72);
  assert.equal(calls, 1);
});
