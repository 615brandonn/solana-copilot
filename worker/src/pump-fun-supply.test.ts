import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmedSourceIsFresh,
  exactSupplyShareBps,
  loadConfirmedSourceTransaction,
  maximumSpendWithSlippageLamports,
  projectedPumpFunMarketCaps,
  pumpFunTokenPriceUsd,
  reachesSupplyThreshold,
  strictestPumpFunMarketCaps,
  type PumpFunSupplySnapshot,
} from "./pump-fun-supply.js";
import type { Connection } from "@solana/web3.js";

const snapshot: PumpFunSupplySnapshot = {
  mint: "mint",
  observedSlot: 1,
  totalSupplyRaw: 1_000_000_000_000_000n,
  decimals: 6,
  virtualTokenReservesRaw: 1_073_000_000_000_000n,
  virtualSolReservesLamports: 30_000_000_000n,
  realTokenReservesRaw: 793_100_000_000_000n,
  complete: false,
};

test("exact raw supply math blocks 3% and triggers at the configured 10% boundary", () => {
  assert.equal(exactSupplyShareBps(30n, 1_000n), 300n);
  assert.equal(reachesSupplyThreshold(30n, 1_000n, 10), false);
  assert.equal(reachesSupplyThreshold(99n, 1_000n, 10), false);
  assert.equal(reachesSupplyThreshold(100n, 1_000n, 10), true);
  assert.equal(reachesSupplyThreshold(199n, 1_000n, 20), false);
  assert.equal(reachesSupplyThreshold(200n, 1_000n, 20), true);
});

test("invalid thresholds and floating-point fallbacks fail closed", () => {
  assert.equal(reachesSupplyThreshold(1_000n, 1_000n, 3), false);
  assert.equal(reachesSupplyThreshold(1_000n, 1_000n, 21), false);
  assert.equal(reachesSupplyThreshold(1_000n, 0n, 10), false);
});

test("market-cap guard checks both current and conservatively projected post-buy values", () => {
  const small = projectedPumpFunMarketCaps(snapshot, 100, 20_000_000n, 15_000);
  assert.ok(small);
  assert.equal(small.belowCap, true);
  assert.ok(small.projectedPostBuyMarketCapUsd >= small.currentMarketCapUsd);

  const exactCap = small.currentMarketCapUsd;
  const rejected = projectedPumpFunMarketCaps(snapshot, 100, 20_000_000n, exactCap);
  assert.ok(rejected);
  assert.equal(rejected.belowCap, false, "exactly at the configured ceiling is not under it");
});

test("cap projection uses the transaction's full slippage allowance and strictest curve view", () => {
  assert.equal(maximumSpendWithSlippageLamports(100n, 800), 108n);
  assert.equal(maximumSpendWithSlippageLamports(101n, 800), 110n);
  assert.equal(maximumSpendWithSlippageLamports(100n, -1), null);

  const newer = {
    ...snapshot,
    observedSlot: 2,
    virtualSolReservesLamports: snapshot.virtualSolReservesLamports + 1_000_000_000n,
    virtualTokenReservesRaw: snapshot.virtualTokenReservesRaw - 1_000_000_000n,
  };
  const strict = strictestPumpFunMarketCaps([snapshot, newer], 100, 108n, 15_000);
  assert.ok(strict);
  const newerOnly = projectedPumpFunMarketCaps(newer, 100, 108n, 15_000);
  assert.ok(newerOnly);
  assert.equal(strict.currentMarketCapUsd, newerOnly.currentMarketCapUsd);
  assert.equal(strict.projectedPostBuyMarketCapUsd, newerOnly.projectedPostBuyMarketCapUsd);
  assert.equal(
    strictestPumpFunMarketCaps(
      [snapshot, { ...newer, totalSupplyRaw: snapshot.totalSupplyRaw + 1n }],
      100,
      108n,
      15_000,
    ),
    null,
  );
});

test("completed curves and missing price evidence fail closed", () => {
  assert.equal(projectedPumpFunMarketCaps({ ...snapshot, complete: true }, 100, 1n, 15_000), null);
  assert.equal(projectedPumpFunMarketCaps(snapshot, 0, 1n, 15_000), null);
});

test("Pump reserve ratio provides a token-price fallback before aggregators index it", () => {
  const price = pumpFunTokenPriceUsd(snapshot, 100);
  assert.ok(price);
  const marketCap = projectedPumpFunMarketCaps(snapshot, 100, 1n, Number.MAX_VALUE);
  assert.ok(marketCap);
  assert.ok(Math.abs(price * 1_000_000_000 - marketCap.currentMarketCapUsd) < 0.01);
});

test("the source transaction must be confirmed or finalized before entry", async () => {
  const connection = (
    confirmationStatus: "processed" | "confirmed" | "finalized",
    err = false,
    slot = 7,
  ) =>
    ({
      getSignatureStatuses: async () => ({
        context: { slot },
        value: [
          {
            slot,
            confirmations: confirmationStatus === "finalized" ? null : 1,
            err: err ? { InstructionError: [0, "failure"] } : null,
            confirmationStatus,
          },
        ],
      }),
      getBlockTime: async () => 1_800_000_000,
    }) as unknown as Connection;

  assert.deepEqual(
    await loadConfirmedSourceTransaction(connection("confirmed"), "sig", {
      expectedSlot: 7,
      timeoutMs: 0,
    }),
    { slot: 7, blockTimeMs: 1_800_000_000_000, confirmationStatus: "confirmed" },
  );
  assert.equal(
    (
      await loadConfirmedSourceTransaction(connection("finalized"), "sig", {
        expectedSlot: 7,
        knownBlockTimeMs: 1_900_000_000_000,
        timeoutMs: 0,
      })
    )?.confirmationStatus,
    "finalized",
  );
  assert.equal(
    await loadConfirmedSourceTransaction(connection("processed"), "sig", {
      expectedSlot: 7,
      timeoutMs: 0,
    }),
    null,
  );
  assert.equal(
    await loadConfirmedSourceTransaction(connection("confirmed", true), "sig", {
      expectedSlot: 7,
      timeoutMs: 0,
    }),
    null,
  );
  assert.equal(
    await loadConfirmedSourceTransaction(connection("confirmed", false, 8), "sig", {
      expectedSlot: 7,
      timeoutMs: 0,
    }),
    null,
  );
  assert.equal(
    await loadConfirmedSourceTransaction(connection("confirmed"), "", {
      expectedSlot: 7,
      timeoutMs: 0,
    }),
    null,
  );
});

test("confirmed source freshness uses authoritative chain time, not delayed receive time", () => {
  const source = {
    slot: 7,
    blockTimeMs: 1_000_000,
    confirmationStatus: "confirmed" as const,
  };
  assert.equal(confirmedSourceIsFresh(source, 15_000, 1_014_999), true);
  assert.equal(confirmedSourceIsFresh(source, 15_000, 1_015_001), false);
});

test("source confirmation bounds hung status and block-time RPC calls", async () => {
  const never = new Promise<never>(() => undefined);
  const statusHung = {
    getSignatureStatuses: async () => never,
  } as unknown as Connection;
  const statusStarted = Date.now();
  await assert.rejects(
    loadConfirmedSourceTransaction(statusHung, "sig", {
      expectedSlot: 7,
      timeoutMs: 0,
      rpcCallTimeoutMs: 5,
    }),
    /timed out/,
  );
  assert.ok(Date.now() - statusStarted < 250);

  const blockTimeHung = {
    getSignatureStatuses: async () => ({
      value: [
        {
          slot: 7,
          confirmations: 1,
          err: null,
          confirmationStatus: "confirmed",
        },
      ],
    }),
    getBlockTime: async () => never,
  } as unknown as Connection;
  const blockStarted = Date.now();
  await assert.rejects(
    loadConfirmedSourceTransaction(blockTimeHung, "sig", {
      expectedSlot: 7,
      timeoutMs: 0,
      rpcCallTimeoutMs: 5,
    }),
    /timed out/,
  );
  assert.ok(Date.now() - blockStarted < 250);
});
