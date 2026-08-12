import assert from "node:assert/strict";
import test from "node:test";

import type { TransferEvent } from "./geyser.js";
import {
  allocateCohortTransfer,
  transferEventForRecipient,
  transferRecipients,
} from "./transfer-batch.js";

function transfer(overrides: Partial<TransferEvent> = {}): TransferEvent {
  return {
    kind: "transfer",
    from: "sender",
    to: "wallet-b",
    tokenMint: "mint",
    amountTokens: 100,
    decimals: 6,
    slot: 10,
    txSig: "signature",
    timestampMs: 1_000,
    recipients: [
      { wallet: "wallet-b", amountTokens: 40, recipientPreAmount: 10 },
      { wallet: "wallet-a", amountTokens: 35, recipientPreAmount: 0 },
      { wallet: "wallet-a", amountTokens: 25, recipientPreAmount: 2 },
    ],
    ...overrides,
  };
}

test("normalizes a full transfer batch deterministically and merges duplicate owners", () => {
  assert.deepEqual(transferRecipients(transfer()), [
    { wallet: "wallet-a", amountTokens: 60, recipientPreAmount: 2 },
    { wallet: "wallet-b", amountTokens: 40, recipientPreAmount: 10 },
  ]);
});

test("legacy single-recipient events remain supported", () => {
  const event = transfer({ recipients: undefined, to: "legacy", amountTokens: 12 });
  assert.deepEqual(transferRecipients(event), [
    { wallet: "legacy", amountTokens: 12, recipientPreAmount: 0 },
  ]);
});

test("split cohort allocation conserves supply when the wallet is pre-funded", () => {
  const allocation = allocateCohortTransfer(25, [
    {
      wallet: "wallet-a",
      amountTokens: 60,
      recipientPreAmount: 0,
      track: true,
      triggerEligible: true,
      destinationClass: "follower",
    },
    {
      wallet: "wallet-b",
      amountTokens: 40,
      recipientPreAmount: 0,
      track: true,
      triggerEligible: true,
      destinationClass: "follower",
    },
  ]);
  assert.equal(allocation.movedAmount, 25);
  assert.equal(allocation.trackedAmount, 25);
  assert.equal(allocation.actionableTrackedAmount, 25);
  assert.equal(allocation.unresolvedAmount, 0);
  assert.equal(allocation.recipients[0]?.movedAmount, 15);
  assert.equal(allocation.recipients[1]?.movedAmount, 10);
});

test("mixed tracked and terminal recipients are accounted once", () => {
  const allocation = allocateCohortTransfer(100, [
    {
      wallet: "follower",
      amountTokens: 60,
      track: true,
      triggerEligible: true,
      destinationClass: "follower",
    },
    {
      wallet: "vault",
      amountTokens: 40,
      track: false,
      triggerEligible: false,
      destinationClass: "program_or_off_curve",
    },
  ]);
  assert.equal(allocation.movedAmount, 100);
  assert.equal(allocation.trackedAmount, 60);
  assert.equal(allocation.actionableTrackedAmount, 60);
  assert.equal(allocation.terminalAmount, 40);
  assert.equal(allocation.unresolvedAmount, 40);
});

test("observation-only child movement stays unresolved in the actionable source", () => {
  const allocation = allocateCohortTransfer(100, [
    {
      wallet: "pre-funded-child",
      amountTokens: 75,
      recipientPreAmount: 1_000,
      track: true,
      triggerEligible: false,
      destinationClass: "follower",
    },
  ]);
  assert.equal(allocation.trackedAmount, 75);
  assert.equal(allocation.actionableTrackedAmount, 0);
  assert.equal(allocation.terminalAmount, 0);
  assert.equal(allocation.unresolvedAmount, 75);
});

test("child events keep per-wallet Strategy Lab identity without nested recipients", () => {
  const event = transfer();
  const recipient = transferRecipients(event)[0]!;
  const child = transferEventForRecipient(event, recipient, 15);
  assert.equal(child.to, "wallet-a");
  assert.equal(child.amountTokens, 15);
  assert.equal(child.recipients, undefined);
});
