import assert from "node:assert/strict";
import test from "node:test";
import {
  attributablePositiveBalanceDelta,
  confirmedTokenReceiptFromTx,
} from "./execution-accounting.js";

test("Pump fallback accounting excludes pre-existing token holdings", () => {
  assert.equal(attributablePositiveBalanceDelta(95_000_000, 95_000_125.5), 125.5);
  assert.equal(attributablePositiveBalanceDelta(0, 125.5), 125.5);
});

test("Pump fallback accounting fails closed without a positive finite delta", () => {
  assert.equal(attributablePositiveBalanceDelta(10, 10), undefined);
  assert.equal(attributablePositiveBalanceDelta(10, 9), undefined);
  assert.equal(attributablePositiveBalanceDelta(Number.NaN, 10), undefined);
  assert.equal(attributablePositiveBalanceDelta(0, Number.POSITIVE_INFINITY), undefined);
});

function balance(owner: string, mint: string, amount: string, decimals = 6) {
  return { owner, mint, uiTokenAmount: { amount, decimals } };
}

test("confirmed receipt sums every matching token account and ignores unrelated balances", () => {
  const receipt = confirmedTokenReceiptFromTx(
    {
      meta: {
        preTokenBalances: [
          balance("owner", "mint", "1000000"),
          balance("owner", "mint", "2000000"),
          balance("other", "mint", "999999999"),
          balance("owner", "other-mint", "999999999"),
        ],
        postTokenBalances: [
          balance("owner", "mint", "3500000"),
          balance("owner", "mint", "2000000"),
          balance("other", "mint", "1"),
        ],
      },
    },
    "owner",
    "mint",
  );
  assert.deepEqual(receipt, { amountRaw: "2500000", amountUi: 2.5, decimals: 6 });
});

test("confirmed receipt preserves raw deltas above Number's exact range", () => {
  const receipt = confirmedTokenReceiptFromTx(
    {
      meta: {
        preTokenBalances: [balance("owner", "mint", "1", 0)],
        postTokenBalances: [balance("owner", "mint", "9007199254740994", 0)],
      },
    },
    "owner",
    "mint",
  );
  assert.equal(receipt?.amountRaw, "9007199254740993");
  assert.equal(receipt?.decimals, 0);
});

test("confirmed receipt fails closed on non-positive, inconsistent, or malformed evidence", () => {
  assert.equal(
    confirmedTokenReceiptFromTx(
      {
        meta: {
          preTokenBalances: [balance("owner", "mint", "10")],
          postTokenBalances: [balance("owner", "mint", "10")],
        },
      },
      "owner",
      "mint",
    ),
    undefined,
  );
  assert.equal(
    confirmedTokenReceiptFromTx(
      {
        meta: {
          preTokenBalances: [balance("owner", "mint", "10")],
          postTokenBalances: [balance("owner", "mint", "9")],
        },
      },
      "owner",
      "mint",
    ),
    undefined,
  );
  for (const raw of ["-1", "1.5", "not-a-number"]) {
    assert.equal(
      confirmedTokenReceiptFromTx(
        {
          meta: {
            preTokenBalances: [balance("owner", "mint", raw)],
            postTokenBalances: [balance("owner", "mint", "10")],
          },
        },
        "owner",
        "mint",
      ),
      undefined,
    );
  }
  assert.equal(
    confirmedTokenReceiptFromTx(
      {
        meta: {
          preTokenBalances: [balance("owner", "mint", "1", 6)],
          postTokenBalances: [balance("owner", "mint", "2", 9)],
        },
      },
      "owner",
      "mint",
    ),
    undefined,
  );
});
