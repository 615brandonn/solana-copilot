import test from "node:test";
import assert from "node:assert/strict";
import { learnCustodyWalletProfile } from "./custody-learning.js";

const now = Date.UTC(2026, 7, 13);

test("repeated verified sellers become candidates, never confirmed named exchanges", () => {
  const learned = learnCustodyWalletProfile(
    {
      wallet: "wallet",
      journeyCount: 3,
      transferOutCount: 2,
      verifiedSellCount: 4,
      activeHoldingCount: 0,
      firstSeenAtMs: now - 10_000,
    },
    now,
  );
  assert.equal(learned?.inferredType, "hot_wallet_candidate");
  assert.ok((learned?.confidence ?? 1) < 0.9);
  assert.ok(!learned?.inferredLabel.toLowerCase().includes("exchange"));
});

test("repeated outgoing custody movement learns a routing candidate", () => {
  const learned = learnCustodyWalletProfile(
    {
      wallet: "wallet",
      journeyCount: 2,
      transferOutCount: 3,
      verifiedSellCount: 0,
      activeHoldingCount: 1,
      firstSeenAtMs: now - 10_000,
    },
    now,
  );
  assert.equal(learned?.inferredType, "routing_wallet");
});

test("cold-storage suggestion needs multi-journey long holding and no observed outflow", () => {
  assert.equal(
    learnCustodyWalletProfile(
      {
        wallet: "wallet",
        journeyCount: 3,
        transferOutCount: 0,
        verifiedSellCount: 0,
        activeHoldingCount: 3,
        firstSeenAtMs: now - 6 * 24 * 60 * 60_000,
      },
      now,
    ),
    null,
  );
  assert.equal(
    learnCustodyWalletProfile(
      {
        wallet: "wallet",
        journeyCount: 3,
        transferOutCount: 0,
        verifiedSellCount: 0,
        activeHoldingCount: 3,
        firstSeenAtMs: now - 8 * 24 * 60 * 60_000,
      },
      now,
    )?.inferredType,
    "cold_storage_candidate",
  );
});
