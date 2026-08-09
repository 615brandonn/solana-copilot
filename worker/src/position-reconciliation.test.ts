import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateWalletTokenHoldings,
  groupObservedFollowerTransfers,
  ZeroBalanceConfirmationTracker,
} from "./position-reconciliation.js";

const positions = [
  { id: "held", token_mint: "mint-held" },
  { id: "flat", token_mint: "mint-flat" },
];

test("requires two successful zero-balance observations", () => {
  const tracker = new ZeroBalanceConfirmationTracker();
  assert.deepEqual(tracker.observe(positions, new Set(["mint-held"])), []);
  assert.deepEqual(tracker.observe(positions, new Set(["mint-held"])), ["flat"]);
});

test("a positive balance clears an earlier miss", () => {
  const tracker = new ZeroBalanceConfirmationTracker();
  assert.deepEqual(tracker.observe(positions, new Set(["mint-held"])), []);
  assert.deepEqual(tracker.observe(positions, new Set(["mint-held", "mint-flat"])), []);
  assert.deepEqual(tracker.observe(positions, new Set(["mint-held"])), []);
});

test("forgets positions that are no longer open", () => {
  const tracker = new ZeroBalanceConfirmationTracker();
  tracker.observe(positions, new Set(["mint-held"]));
  tracker.observe([positions[0]], new Set(["mint-held"]));
  assert.deepEqual(tracker.observe(positions, new Set(["mint-held"])), []);
});

test("aggregates positive wallet token accounts by mint", () => {
  assert.deepEqual(
    aggregateWalletTokenHoldings([
      { mint: "NO", amount: 2, decimals: 6 },
      { mint: "NO", amount: 3, decimals: 6 },
      { mint: "ZERO", amount: 0, decimals: 6 },
      { mint: "OTHER", amount: 1.5, decimals: 9 },
    ]),
    [
      { token_mint: "NO", amount: 5, decimals: 6 },
      { token_mint: "OTHER", amount: 1.5, decimals: 9 },
    ],
  );
});

test("groups direct follower recipients across configured target wallets", () => {
  const groups = groupObservedFollowerTransfers(
    [
      { token_mint: "NO", from_wallet: "target-a", to_wallet: "follower" },
      { token_mint: "NO", from_wallet: "target-b", to_wallet: "follower" },
      { token_mint: "NO", from_wallet: "target-a", to_wallet: "follower" },
      { token_mint: "NO", from_wallet: "target-a", to_wallet: "target-b" },
    ],
    new Set(["target-a", "target-b", "target-c"]),
  );
  assert.deepEqual(groups, [
    {
      tokenMint: "NO",
      wallet: "follower",
      sourceTargets: ["target-a", "target-b"],
    },
  ]);
});
