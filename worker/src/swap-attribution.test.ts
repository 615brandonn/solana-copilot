import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";

import {
  attributeVerifiedBuy,
  attributeVerifiedSell,
  conservativeNativeSolSpend,
  hasWalletSpecificSpend,
  isOnCurveWallet,
  parseRawTokenAmount,
  tokenDelta,
  tokenDeltaSign,
  USDC_MINT,
  verifiedSpendForOutput,
  type WalletTokenDelta,
} from "./swap-attribution.js";

const INPUT_MINT = "input-mint";
const OUTPUT_MINT = "output-mint";

function row(
  mint: string,
  pre: number,
  post: number,
  decimals = 6,
  rawExact = true,
): WalletTokenDelta {
  const scale = 10 ** decimals;
  return {
    mint,
    pre,
    post,
    decimals,
    preRaw: BigInt(Math.round(pre * scale)),
    postRaw: BigInt(Math.round(post * scale)),
    rawExact,
  };
}

test("attributes one stablecoin input to one output", () => {
  assert.deepEqual(
    verifiedSpendForOutput([row(USDC_MINT, 100, 40), row(OUTPUT_MINT, 0, 1_000)], OUTPUT_MINT, 1),
    { amountUsd: 60 },
  );
});

test("preserves an exact non-stable input amount for quote-only valuation", () => {
  assert.deepEqual(
    verifiedSpendForOutput([row(INPUT_MINT, 25, 5), row(OUTPUT_MINT, 0, 1_000)], OUTPUT_MINT, 1),
    {
      spentToken: {
        mint: INPUT_MINT,
        amountRaw: "20000000",
        amountTokens: 20,
        decimals: 6,
      },
    },
  );
});

test("ambiguous inputs, outputs, and imprecise raw balances fail closed", () => {
  const output = row(OUTPUT_MINT, 0, 1_000);
  assert.deepEqual(
    verifiedSpendForOutput([row("input-a", 10, 0), row("input-b", 10, 0), output], OUTPUT_MINT, 1),
    {},
  );
  assert.deepEqual(verifiedSpendForOutput([row(INPUT_MINT, 10, 0), output], OUTPUT_MINT, 2), {});
  assert.deepEqual(
    verifiedSpendForOutput([row(INPUT_MINT, 10, 0, 6, false), output], OUTPUT_MINT, 1),
    {},
  );
});

test("only an unambiguous exact token or adjusted native-SOL input verifies a buy", () => {
  const output = row(OUTPUT_MINT, 0, 1_000);
  assert.equal(
    attributeVerifiedBuy([row(INPUT_MINT, 10, 0), output], OUTPUT_MINT, 1, 0, true).verified,
    true,
  );
  assert.deepEqual(attributeVerifiedBuy([output], OUTPUT_MINT, 1, 0.9, true), {
    solSpend: 0.9,
    verified: true,
  });
  assert.equal(attributeVerifiedBuy([output], OUTPUT_MINT, 1, 0.9, false).verified, false);
  assert.equal(attributeVerifiedBuy([output], OUTPUT_MINT, 1, undefined, true).verified, false);
  assert.equal(
    attributeVerifiedBuy(
      [row("input-a", 10, 0), row("input-b", 10, 0), output],
      OUTPUT_MINT,
      1,
      0.9,
      true,
    ).verified,
    false,
  );
});

test("wallet-specific spend requires a debit, not a transaction-wide swap log", () => {
  assert.equal(hasWalletSpecificSpend([row(INPUT_MINT, 0, 10)], 0), false);
  assert.equal(hasWalletSpecificSpend([row(INPUT_MINT, 10, 0)], 0), true);
  assert.equal(hasWalletSpecificSpend([], 0.9), true);
  assert.equal(hasWalletSpecificSpend([], undefined), false);
});

test("native SOL spend removes fees and a fixed overhead cushion", () => {
  assert.equal(conservativeNativeSolSpend(-1, 5_000, true), 0.994995);
  assert.equal(conservativeNativeSolSpend(-0.004, 5_000, true), undefined);
  assert.equal(conservativeNativeSolSpend(1, 5_000, true), undefined);
});

test("raw token parsing and on-curve recipient checks fail closed", () => {
  assert.equal(parseRawTokenAmount("12345678901234567890"), 12345678901234567890n);
  assert.equal(parseRawTokenAmount("1.2"), undefined);
  assert.equal(parseRawTokenAmount(-1), undefined);
  assert.equal(parseRawTokenAmount(Number.MAX_SAFE_INTEGER + 1), undefined);

  const wallet = Keypair.generate().publicKey;
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool")],
    Keypair.generate().publicKey,
  );
  assert.equal(isOnCurveWallet(wallet.toBase58()), true);
  assert.equal(isOnCurveWallet(pda.toBase58()), false);
  assert.equal(isOnCurveWallet("not-a-wallet"), false);
});

test("raw deltas decide sign and amount when lossy UI balances are identical", () => {
  const exact: WalletTokenDelta = {
    mint: OUTPUT_MINT,
    pre: 9_007_199_254_740.992,
    post: 9_007_199_254_740.992,
    decimals: 6,
    preRaw: 9_007_199_254_740_992_000n,
    postRaw: 9_007_199_254_740_992_001n,
    rawExact: true,
  };
  assert.equal(tokenDeltaSign(exact), 1);
  assert.equal(tokenDelta(exact), 0.000001);
  assert.equal(tokenDeltaSign({ ...exact, preRaw: exact.postRaw, postRaw: exact.preRaw }), -1);
});

test("verifies a single- or multi-signer sell only with attributable proceeds", () => {
  const sold = row(OUTPUT_MINT, 100, 25);
  const usdc = row(USDC_MINT, 0, 60);
  assert.deepEqual(attributeVerifiedSell([sold, usdc], OUTPUT_MINT, 0, true, true, 2), {
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
  assert.equal(attributeVerifiedSell([sold], OUTPUT_MINT, 1, true, true, 1).verified, true);
});

test("sell attribution rejects transfers, unrelated signers, and ambiguous balance flows", () => {
  const sold = row(OUTPUT_MINT, 100, 0);
  assert.equal(attributeVerifiedSell([sold], OUTPUT_MINT, 1, false, true, 1).verified, false);
  assert.equal(attributeVerifiedSell([sold], OUTPUT_MINT, 1, true, false, 1).verified, false);
  assert.equal(
    attributeVerifiedSell(
      [sold, row(USDC_MINT, 0, 60), row(INPUT_MINT, 0, 5)],
      OUTPUT_MINT,
      0,
      true,
      true,
      1,
    ).verified,
    false,
  );
  assert.equal(
    attributeVerifiedSell(
      [sold, row(INPUT_MINT, 10, 0), row(USDC_MINT, 0, 60)],
      OUTPUT_MINT,
      0,
      true,
      true,
      1,
    ).verified,
    false,
  );
});
