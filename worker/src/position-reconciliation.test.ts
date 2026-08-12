import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateWalletTokenHoldings,
  groupObservedFollowerTransfers,
  isEligibleFollowerWallet,
  ReducedBalanceConfirmationTracker,
  ZeroBalanceConfirmationTracker,
} from "./position-reconciliation.js";
import { PublicKey } from "@solana/web3.js";

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

test("confirms a reduced on-chain position balance twice before capping accounting", () => {
  const tracker = new ReducedBalanceConfirmationTracker();
  const open = [{ id: "position", token_mint: "mint", amount_remaining: 100, decimals: 6 }];
  assert.deepEqual(tracker.observe(open, new Map([["mint", 60]])), []);
  assert.deepEqual(tracker.observe(open, new Map([["mint", 60]])), [
    { id: "position", amountRemaining: 60 },
  ]);
});

test("never increases a position and resets an unconfirmed balance change", () => {
  const tracker = new ReducedBalanceConfirmationTracker();
  const open = [{ id: "position", token_mint: "mint", amount_remaining: 100, decimals: 6 }];
  assert.deepEqual(tracker.observe(open, new Map([["mint", 60]])), []);
  assert.deepEqual(tracker.observe(open, new Map([["mint", 120]])), []);
  assert.deepEqual(tracker.observe(open, new Map([["mint", 55]])), []);
  assert.deepEqual(tracker.observe(open, new Map([["mint", 55]])), [
    { id: "position", amountRemaining: 55 },
  ]);
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

test("accepts normal wallets and rejects program-controlled pool recipients", () => {
  const normalWallet = "4BDAuaLKXVjZn65haQ3Sr6xWd1HuoPns4qVvaB7yFTBt";
  const pumpAmmPool = "HXHTLcG2Zqu9zYC4Uye1rx7vHepXQ4UAga6N7ShSou45";
  const pumpAmmProgram = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
  const [offCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool-recipient")],
    new PublicKey(pumpAmmProgram),
  );

  assert.equal(isEligibleFollowerWallet(normalWallet, null), true);
  assert.equal(isEligibleFollowerWallet(normalWallet, "11111111111111111111111111111111"), true);
  assert.equal(isEligibleFollowerWallet(pumpAmmPool, pumpAmmProgram), false);
  assert.equal(isEligibleFollowerWallet(offCurve.toBase58(), null), false);
});
