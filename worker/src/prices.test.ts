import assert from "node:assert/strict";
import test from "node:test";

import { parseJupiterPrice } from "./price-parser.js";
import { dexScreenerPriceForBase } from "./prices.js";

const MINT = "So11111111111111111111111111111111111111112";

test("parses current Jupiter Price API v3 responses", () => {
  assert.equal(parseJupiterPrice({ [MINT]: { usdPrice: 147.48 } }, MINT), 147.48);
});

test("keeps compatibility with legacy Jupiter price responses", () => {
  assert.equal(parseJupiterPrice({ data: { [MINT]: { price: 150.25 } } }, MINT), 150.25);
});

test("rejects missing, zero, and malformed prices", () => {
  assert.equal(parseJupiterPrice({}, MINT), undefined);
  assert.equal(parseJupiterPrice({ [MINT]: { usdPrice: 0 } }, MINT), undefined);
  assert.equal(parseJupiterPrice({ [MINT]: { usdPrice: "bad" } }, MINT), undefined);
});

test("DexScreener fallback never treats a quote-token pair price as the requested mint price", () => {
  const payload = {
    pairs: [
      {
        baseToken: { address: "USDC" },
        quoteToken: { address: "SOL" },
        priceUsd: "1",
        liquidity: { usd: 10_000_000 },
      },
      {
        baseToken: { address: "SOL" },
        quoteToken: { address: "USDC" },
        priceUsd: "150",
        liquidity: { usd: 1_000_000 },
      },
    ],
  };
  assert.equal(dexScreenerPriceForBase(payload, "SOL"), 150);
  assert.equal(dexScreenerPriceForBase(payload, "MISSING"), undefined);
});
