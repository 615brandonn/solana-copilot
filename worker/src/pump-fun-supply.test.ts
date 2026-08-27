import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmedSourceIsFresh,
  decodeReviewedPumpFunSupplyAccounts,
  exactSupplyShareBps,
  loadConfirmedSourceTransaction,
  loadPumpFunSupplySnapshot,
  maximumSpendWithSlippageLamports,
  projectedPumpFunMarketCaps,
  pumpFunTokenPriceUsd,
  reachesSupplyThreshold,
  strictestPumpFunMarketCaps,
  type PumpFunSupplySnapshot,
} from "./pump-fun-supply.js";
import { PublicKey, type Connection } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

const REAL_V2_MINT = new PublicKey("Fw5xoxp3JYrW1ELUCQ98t3MvRiMKSFk7WBEsMs8Gpump");
const REAL_V2_MINT_DATA = Buffer.from(
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIDGpH6NAwAGAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARIAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAN3el2sNX+izp+oW0dQhauLHIpS22qs/E1Bl/e/21dyfEwCgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3d6Xaw1f6LOn6hbR1CFq4scilLbaqz8TUGX97/bV3J8VAAAAU1RBUlQgREVWVklORyBXSVRIIDMwBQAAAERFTlpBNgAAAGh0dHBzOi8vbWV0YWRhdGEuajd0cmFja2VyLmlvL21ldGFkYXRhL29kTHNDRUsyWUcuanNvbgAAAAA=",
  "base64",
);
const REAL_V2_CURVE_115 = Buffer.from(
  "F7f4N2DYrGBkRMAI684DAM796v0GAAAAZKytvFnQAgDOUccBAAAAAACAxqR+jQMAAGox52y3xlaaRuCdHzLlDxg2g94XyItFoIdgXyLdscXbAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
  "base64",
);

const snapshot: PumpFunSupplySnapshot = {
  mint: "mint",
  observedSlot: 1,
  totalSupplyRaw: 1_000_000_000_000_000n,
  decimals: 6,
  virtualTokenReservesRaw: 1_073_000_000_000_000n,
  virtualSolReservesLamports: 30_000_000_000n,
  realTokenReservesRaw: 793_100_000_000_000n,
  realSolReservesLamports: 0n,
  complete: false,
};

test("reviewed shared loader accepts active Token-2022 Pump state at confirmed/processed", async () => {
  const commitments: string[] = [];
  const connection = {
    async getMultipleAccountsInfoAndContext(_keys: PublicKey[], config: any) {
      commitments.push(config.commitment);
      return {
        context: { slot: 441_792_999 },
        value: [
          {
            owner: new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"),
            data: REAL_V2_CURVE_115,
          },
          { owner: TOKEN_2022_PROGRAM_ID, data: REAL_V2_MINT_DATA },
        ],
      } as any;
    },
  } as unknown as Connection;
  for (const commitment of ["confirmed", "processed"] as const) {
    const loaded = await loadPumpFunSupplySnapshot(connection, REAL_V2_MINT.toBase58(), {
      commitment,
      minContextSlot: 441_792_999,
    });
    assert.ok(loaded);
    assert.equal(loaded.complete, false);
    assert.equal(loaded.createVariant, "create_v2_token2022");
    assert.equal(loaded.tokenProgram, TOKEN_2022_PROGRAM_ID.toBase58());
    assert.equal(loaded.totalSupplyRaw, 1_000_000_000_000_000n);
    assert.equal(loaded.decimals, 6);
    assert.match(loaded.curveStateFingerprint ?? "", /^[0-9a-f]{64}$/);
  }
  assert.deepEqual(commitments, ["confirmed", "processed"]);
});

test("reviewed shared loader accepts 115/zero-tail 151 curves and rejects unknown tail use", () => {
  const account = (curveData: Buffer, mintData = REAL_V2_MINT_DATA) =>
    decodeReviewedPumpFunSupplyAccounts(
      REAL_V2_MINT,
      {
        owner: new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"),
        data: curveData,
      },
      { owner: TOKEN_2022_PROGRAM_ID, data: mintData },
      441_792_999,
    );
  assert.ok(account(REAL_V2_CURVE_115));
  assert.ok(account(Buffer.concat([REAL_V2_CURVE_115, Buffer.alloc(36)])));
  const futureTail = Buffer.concat([REAL_V2_CURVE_115, Buffer.alloc(36)]);
  futureTail[150] = 1;
  assert.equal(account(futureTail), null);

  const wrongSupply = Buffer.from(REAL_V2_MINT_DATA);
  wrongSupply.writeBigUInt64LE(999n, 36);
  assert.equal(account(REAL_V2_CURVE_115, wrongSupply), null);
  const wrongDecimals = Buffer.from(REAL_V2_MINT_DATA);
  wrongDecimals[44] = 9;
  assert.equal(account(REAL_V2_CURVE_115, wrongDecimals), null);

  const unsafeExtension = Buffer.from(REAL_V2_MINT_DATA);
  const metadataPointerHeader = unsafeExtension.indexOf(Buffer.from([18, 0, 64, 0]));
  assert.ok(metadataPointerHeader >= 0);
  unsafeExtension[metadataPointerHeader] = 1;
  assert.equal(account(REAL_V2_CURVE_115, unsafeExtension), null);
});

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
  const small = projectedPumpFunMarketCaps(snapshot, 100, 20_000_000n, 20_000);
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
  const strict = strictestPumpFunMarketCaps([snapshot, newer], 100, 108n, 20_000);
  assert.ok(strict);
  const newerOnly = projectedPumpFunMarketCaps(newer, 100, 108n, 20_000);
  assert.ok(newerOnly);
  assert.equal(strict.currentMarketCapUsd, newerOnly.currentMarketCapUsd);
  assert.equal(strict.projectedPostBuyMarketCapUsd, newerOnly.projectedPostBuyMarketCapUsd);
  assert.equal(
    strictestPumpFunMarketCaps(
      [snapshot, { ...newer, totalSupplyRaw: snapshot.totalSupplyRaw + 1n }],
      100,
      108n,
      20_000,
    ),
    null,
  );
});

test("completed curves and missing price evidence fail closed", () => {
  assert.equal(projectedPumpFunMarketCaps({ ...snapshot, complete: true }, 100, 1n, 20_000), null);
  assert.equal(
    strictestPumpFunMarketCaps(
      [snapshot, { ...snapshot, observedSlot: 2, complete: true }],
      100,
      1n,
      20_000,
    ),
    null,
    "either completed chain view must block an entry",
  );
  assert.equal(projectedPumpFunMarketCaps(snapshot, 0, 1n, 20_000), null);
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
