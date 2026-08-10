import assert from "node:assert/strict";
import test from "node:test";

import { USDC_MINT, type VerifiedTokenSpend } from "./swap-attribution.js";
import { parseJupiterTokenSpendQuote, resolveTargetBuyValue } from "./target-buy-valuation.js";

const INPUT_MINT = "input-token";
const OUTPUT_MINT = "bought-token";
const spentToken: VerifiedTokenSpend = {
  mint: INPUT_MINT,
  amountRaw: "20000000",
  amountTokens: 20,
  decimals: 6,
};

test("existing stablecoin value wins without another lookup", async () => {
  let called = false;
  const result = await resolveTargetBuyValue(
    { tokenMint: OUTPUT_MINT, amountUsd: 75, solDelta: -1, spentToken },
    {
      quoteTokenSpendUsd: async () => {
        called = true;
        return 100;
      },
      solPriceUsd: async () => {
        called = true;
        return 80;
      },
    },
  );
  assert.deepEqual(result, { amountUsd: 75, source: "stablecoin" });
  assert.equal(called, false);
});

test("values one verified token input and preserves the existing threshold amount", async () => {
  const result = await resolveTargetBuyValue(
    { tokenMint: OUTPUT_MINT, solDelta: -0.001, spentToken },
    {
      quoteTokenSpendUsd: async (asset, output) => {
        assert.deepEqual(asset, spentToken);
        assert.equal(output, OUTPUT_MINT);
        return 80;
      },
      solPriceUsd: async () => 100,
    },
  );
  assert.deepEqual(result, { amountUsd: 80, source: "input-token-quote" });
});

test("missing token quote fails closed instead of treating SOL fee or rent as spend", async () => {
  const result = await resolveTargetBuyValue(
    { tokenMint: OUTPUT_MINT, solDelta: -0.01, spentToken },
    {
      quoteTokenSpendUsd: async () => undefined,
      solPriceUsd: async () => 100,
    },
  );
  assert.deepEqual(result, { amountUsd: undefined, source: "unavailable" });
});

test("only a separately verified native SOL spend is valued with a safety haircut", async () => {
  const dependencies = {
    quoteTokenSpendUsd: async () => undefined,
    solPriceUsd: async () => 100,
  };
  assert.deepEqual(
    await resolveTargetBuyValue({ tokenMint: OUTPUT_MINT, solDelta: -1 }, dependencies),
    { amountUsd: undefined, source: "unavailable" },
  );
  assert.deepEqual(
    await resolveTargetBuyValue(
      { tokenMint: OUTPUT_MINT, solDelta: -1, solSpend: 0.9 },
      dependencies,
    ),
    { amountUsd: 81, source: "sol" },
  );
});

function validQuote(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

const expected = {
  inputMint: INPUT_MINT,
  inputAmountRaw: spentToken.amountRaw,
  purchasedMint: OUTPUT_MINT,
};

test("accepts a conservative quote-only Jupiter value with a safety haircut", () => {
  assert.equal(parseJupiterTokenSpendQuote(validQuote(), expected), 72);
});

test("rejects a built transaction, mismatched amounts, circular routes, and unsafe quotes", () => {
  assert.equal(
    parseJupiterTokenSpendQuote(validQuote({ transaction: "unsigned-transaction" }), expected),
    undefined,
  );
  assert.equal(
    parseJupiterTokenSpendQuote(validQuote({ inAmount: "19999999" }), expected),
    undefined,
  );
  assert.equal(
    parseJupiterTokenSpendQuote(
      validQuote({
        routePlan: [{ swapInfo: { inputMint: INPUT_MINT, outputMint: OUTPUT_MINT } }],
      }),
      expected,
    ),
    undefined,
  );
  assert.equal(parseJupiterTokenSpendQuote(validQuote({ priceImpact: 11 }), expected), undefined);
  assert.equal(parseJupiterTokenSpendQuote(validQuote({ inUsdValue: 200 }), expected), undefined);
});

test("rejects malformed or error Jupiter responses instead of coercing fields", () => {
  assert.equal(parseJupiterTokenSpendQuote(validQuote({ priceImpact: null }), expected), undefined);
  assert.equal(
    parseJupiterTokenSpendQuote(validQuote({ routePlan: undefined }), expected),
    undefined,
  );
  assert.equal(parseJupiterTokenSpendQuote(validQuote({ routePlan: [] }), expected), undefined);
  assert.equal(parseJupiterTokenSpendQuote(validQuote({ routePlan: [{}] }), expected), undefined);
  assert.equal(
    parseJupiterTokenSpendQuote(validQuote({ router: "unknown-router" }), expected),
    undefined,
  );
  assert.equal(parseJupiterTokenSpendQuote(validQuote({ router: "iris" }), expected), undefined);
  assert.equal(parseJupiterTokenSpendQuote(validQuote({ errorCode: 1 }), expected), undefined);
  assert.equal(parseJupiterTokenSpendQuote(validQuote({ inUsdValue: "82" }), expected), undefined);
  assert.equal(
    parseJupiterTokenSpendQuote(validQuote({ outAmount: 80_000_000 }), expected),
    undefined,
  );
});
