import assert from "node:assert/strict";
import test from "node:test";
import { type Connection, PublicKey } from "@solana/web3.js";
import {
  capExitRawAmount,
  decrementUiAmountByRaw,
  exactWalletBalanceFromParsedAccounts,
  rawAmountToUiString,
  readExactWalletTokenBalance,
  remainingUiAfterExactExit,
  uiAmountToRawFloor,
} from "./exit-sizing.js";

const REQUESTED_RAW = 10_037_688_434_567_072n;
const LIVE_RAW = 10_037_688_434_567_071n;

function parsedBalance(mint: string, amount: string, decimals = 6) {
  return {
    account: {
      data: {
        parsed: {
          type: "account",
          info: { mint, tokenAmount: { amount, decimals } },
        },
      },
    },
  };
}

test("an exit above 2^53 is capped by the exact live raw balance", () => {
  assert.ok(REQUESTED_RAW > BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(REQUESTED_RAW - LIVE_RAW, 1n);
  assert.equal(capExitRawAmount(REQUESTED_RAW, LIVE_RAW), LIVE_RAW);
  assert.equal(rawAmountToUiString(LIVE_RAW, 6), "10037688434.567071");
});

test("the legacy unsafe Number request is converted then capped without losing the live bigint", () => {
  const legacyRequested = Number(REQUESTED_RAW);
  assert.equal(Number.isSafeInteger(legacyRequested), false);
  assert.equal(capExitRawAmount(legacyRequested, LIVE_RAW), LIVE_RAW);
});

test("a rounded-down request never expands to unrelated live wallet holdings", () => {
  const liveRaw = 10_037_688_434_567_051n;
  const roundedDownRequest = uiAmountToRawFloor(10_037_688_434.56705, 6);
  assert.equal(roundedDownRequest, liveRaw - 1n);
  assert.equal(capExitRawAmount(roundedDownRequest, liveRaw), roundedDownRequest);

  const manualHoldings = 1_000_000_000n;
  assert.equal(capExitRawAmount(roundedDownRequest, liveRaw + manualHoldings), roundedDownRequest);
});

test("persisted remaining UI is derived by exact raw subtraction", () => {
  const result = decrementUiAmountByRaw("10037688434.567072", LIVE_RAW, 6);
  assert.equal(result.remainingRaw, 1n);
  assert.equal(result.remainingUi, 0.000001);
  assert.equal(uiAmountToRawFloor(result.remainingUi, 6), 1n);
});

test("selling the exact full live balance closes a position despite a +1 raw UI artifact", () => {
  assert.deepEqual(remainingUiAfterExactExit("10037688434.567072", LIVE_RAW, LIVE_RAW, 6), {
    remainingRaw: 0n,
    remainingUi: 0,
    walletDepleted: true,
  });
});

test("parsed wallet balances preserve exact raw units above 2^53", () => {
  assert.equal(
    exactWalletBalanceFromParsedAccounts(
      [parsedBalance("mint", "10037688434567070"), parsedBalance("mint", "1")],
      "mint",
      6,
    ),
    LIVE_RAW,
  );
});

test("malformed or inconsistent live balance evidence fails closed", () => {
  assert.throws(
    () => exactWalletBalanceFromParsedAccounts([parsedBalance("other", "1")], "mint", 6),
    /malformed or inconsistent/,
  );
  assert.throws(
    () => exactWalletBalanceFromParsedAccounts([parsedBalance("mint", "1.5")], "mint", 6),
    /malformed or inconsistent/,
  );
  assert.throws(
    () => exactWalletBalanceFromParsedAccounts([parsedBalance("mint", "1", 9)], "mint", 6),
    /malformed or inconsistent/,
  );
});

test("an unavailable or timed-out live balance RPC fails closed", async () => {
  const owner = new PublicKey("11111111111111111111111111111111");
  const mint = new PublicKey("So11111111111111111111111111111111111111112");
  const unavailable = {
    getParsedTokenAccountsByOwner: async () => {
      throw new Error("RPC unavailable");
    },
  } as unknown as Connection;
  await assert.rejects(readExactWalletTokenBalance(unavailable, owner, mint, 6), /RPC unavailable/);

  const hanging = {
    getParsedTokenAccountsByOwner: () => new Promise(() => undefined),
  } as unknown as Connection;
  await assert.rejects(readExactWalletTokenBalance(hanging, owner, mint, 6, 5), /timed out/);
});
