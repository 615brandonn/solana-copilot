import assert from "node:assert/strict";
import test from "node:test";
import type { SwapEvent, TransferEvent } from "./geyser.js";
import { classifyConvictionSwap, classifyConvictionTransfers } from "./conviction-classifier.js";

const targets = new Set(["wallet-a", "wallet-b", "wallet-c"]);

function swap(overrides: Partial<SwapEvent> = {}): SwapEvent {
  return {
    kind: "swap",
    wallet: "wallet-a",
    side: "buy",
    tokenMint: "mint-x",
    amountTokens: 10,
    decimals: 6,
    amountUsd: 100,
    solDelta: -1,
    slot: 1,
    txSig: "sig",
    timestampMs: 1_000,
    isPumpFun: false,
    verifiedSwap: true,
    ...overrides,
  };
}

test("verified cluster swaps classify as buys and sells", () => {
  assert.deepEqual(classifyConvictionSwap(swap(), targets), {
    classification: "DEX_BUY",
    reliable: true,
  });
  assert.deepEqual(
    classifyConvictionSwap(
      swap({
        side: "sell",
        sellAttribution: { verified: true, signerCount: 1 },
      }),
      targets,
    ),
    { classification: "DEX_SELL", reliable: true },
  );
});

test("unverified or non-cluster swaps fail closed", () => {
  assert.deepEqual(classifyConvictionSwap(swap({ verifiedSwap: false }), targets), {
    classification: "UNKNOWN",
    reliable: false,
  });
  assert.deepEqual(classifyConvictionSwap(swap({ wallet: "someone-else" }), targets), {
    classification: "UNKNOWN",
    reliable: false,
  });
});

function transfer(from: string, recipients: string[]): TransferEvent {
  return {
    kind: "transfer",
    from,
    to: recipients[0] ?? "",
    tokenMint: "mint-x",
    amountTokens: recipients.length * 10,
    decimals: 6,
    slot: 2,
    txSig: "transfer-sig",
    timestampMs: 2_000,
    recipients: recipients.map((wallet) => ({ wallet, amountTokens: 10 })),
  };
}

test("internal cluster transfers are identified without new-capital semantics", () => {
  assert.equal(
    classifyConvictionTransfers(transfer("wallet-a", ["wallet-b"]), targets)[0]?.classification,
    "INTERNAL_CLUSTER_TRANSFER",
  );
});

test("external movements remain transfers rather than fabricated buys or sells", () => {
  assert.equal(
    classifyConvictionTransfers(transfer("wallet-a", ["external"]), targets)[0]?.classification,
    "EXTERNAL_TRANSFER_OUT",
  );
  assert.equal(
    classifyConvictionTransfers(transfer("external", ["wallet-c"]), targets)[0]?.classification,
    "EXTERNAL_TRANSFER_IN",
  );
});
