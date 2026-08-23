import assert from "node:assert/strict";
import test from "node:test";
import {
  loadRevivalSeedMarketSnapshotWithRetry,
  revivalMarketSamplingMode,
  revivalMarketSnapshotFromDexScreener,
} from "./revival-market-data.js";
import type { RevivalCampaignSnapshot } from "./revival-types.js";

const MINT = "revival-market-mint";

function campaignSamplingFixture(
  eligibilityStatus: RevivalCampaignSnapshot["eligibilityStatus"],
  seedHistorical: boolean,
): RevivalCampaignSnapshot {
  return { eligibilityStatus, seedHistorical } as RevivalCampaignSnapshot;
}

test("historical pending seeds never enter the admission retry loop", () => {
  assert.equal(
    revivalMarketSamplingMode(campaignSamplingFixture("pending_market_data", true)),
    "skip",
  );
  assert.equal(
    revivalMarketSamplingMode(campaignSamplingFixture("pending_market_data", false)),
    "seed_retry",
  );
  assert.equal(revivalMarketSamplingMode(campaignSamplingFixture("eligible", false)), "single");
});

test("DexScreener selection uses the highest-liquidity Solana base-token pair", () => {
  const snapshot = revivalMarketSnapshotFromDexScreener(
    {
      pairs: [
        {
          chainId: "ethereum",
          pairAddress: "wrong-chain",
          baseToken: { address: MINT, symbol: "WRONG" },
          quoteToken: { address: "quote" },
          liquidity: { usd: 9_999_999 },
          marketCap: 1,
        },
        {
          chainId: "solana",
          pairAddress: "low-liquidity",
          baseToken: { address: MINT, symbol: "LOW" },
          quoteToken: { address: "quote-a" },
          liquidity: { usd: 500 },
          marketCap: 5_000,
          fdv: 50_000,
        },
        {
          chainId: "solana",
          pairAddress: "quote-token-must-be-ignored",
          dexId: "raydium",
          baseToken: { address: "quote-b", symbol: "QUOTE" },
          quoteToken: { address: MINT, symbol: "REVIVE" },
          liquidity: { usd: 8_000 },
          marketCap: 9_000,
          fdv: 90_000,
          priceUsd: "0.0009",
          volume: { m5: 50, h1: 500, h6: 2_000, h24: 5_000 },
          txns: { m5: { buys: 3, sells: 1 }, h1: { buys: 20, sells: 4 } },
          boosts: { active: 2 },
        },
        {
          chainId: "solana",
          pairAddress: "highest-liquidity",
          dexId: "orca",
          baseToken: { address: MINT, symbol: "REVIVE" },
          quoteToken: { address: "quote-d" },
          liquidity: { usd: 7_000 },
          marketCap: 8_500,
          fdv: 85_000,
          priceUsd: "0.00085",
          volume: { m5: 50, h1: 500, h6: 2_000, h24: 5_000 },
          txns: { m5: { buys: 3, sells: 1 }, h1: { buys: 20, sells: 4 } },
          boosts: { active: 2 },
        },
        {
          chainId: "solana",
          pairAddress: "different-mint",
          baseToken: { address: "another-mint" },
          quoteToken: { address: "quote-c" },
          liquidity: { usd: 99_000 },
          marketCap: 12_000,
        },
      ],
    },
    MINT,
    123_456,
  );

  assert.equal(snapshot.pairAddress, "highest-liquidity");
  assert.equal(snapshot.dexId, "orca");
  assert.equal(snapshot.symbol, "REVIVE");
  assert.equal(snapshot.marketCapUsd, 8_500);
  assert.equal(snapshot.fdvUsd, 85_000);
  assert.equal(snapshot.valuationKind, "market_cap");
  assert.equal(snapshot.liquidityUsd, 7_000);
  assert.equal(snapshot.buysH1, 20);
  assert.equal(snapshot.reliable, true);
});

test("FDV remains separate and is never substituted for missing market cap", () => {
  const snapshot = revivalMarketSnapshotFromDexScreener(
    {
      pairs: [
        {
          chainId: "solana",
          pairAddress: "fdv-only",
          baseToken: { address: MINT, symbol: "REVIVE" },
          quoteToken: { address: "quote" },
          liquidity: { usd: 4_000 },
          fdv: 12_000,
        },
      ],
    },
    MINT,
    123_456,
  );

  assert.equal(snapshot.marketCapUsd, undefined);
  assert.equal(snapshot.fdvUsd, 12_000);
  assert.equal(snapshot.valuationKind, "fdv");
  assert.equal(snapshot.reliable, false);
  assert.equal(snapshot.reason, "market_cap_unavailable_fdv_not_substituted");
});

test("seed market lookup retries an unreliable response and stops on reliable evidence", async () => {
  let nowMs = 1_000;
  let calls = 0;
  const snapshot = await loadRevivalSeedMarketSnapshotWithRetry(MINT, {
    now: () => nowMs,
    sleep: async (delayMs) => {
      nowMs += delayMs;
    },
    retryDelaysMs: [250, 750, 1_500],
    load: async () => {
      calls += 1;
      return {
        provider: "dexscreener",
        observedAtMs: nowMs,
        reliable: calls === 3,
        marketCapUsd: calls === 3 ? 8_000 : undefined,
        reason: calls === 3 ? undefined : "provider_unavailable",
      };
    },
  });

  assert.equal(calls, 3);
  assert.equal(nowMs, 2_000);
  assert.equal(snapshot.reliable, true);
  assert.equal(snapshot.marketCapUsd, 8_000);
  assert.equal(snapshot.attemptCount, 3);
  assert.equal(snapshot.retryWindowExhausted, undefined);
});

test("seed market retry never runs beyond its 15 second causal budget", async () => {
  let nowMs = 10_000;
  let calls = 0;
  const snapshot = await loadRevivalSeedMarketSnapshotWithRetry(MINT, {
    now: () => nowMs,
    sleep: async (delayMs) => {
      nowMs += delayMs;
    },
    maxRetryWindowMs: 15_000,
    retryDelaysMs: [4_000, 4_000, 4_000, 4_000, 4_000],
    load: async () => {
      calls += 1;
      return {
        provider: "dexscreener",
        observedAtMs: nowMs,
        reliable: false,
        reason: "provider_unavailable",
      };
    },
  });

  assert.equal(nowMs, 25_000);
  assert.equal(calls, 4, "no request may start at or after the deadline");
  assert.equal(snapshot.attemptCount, 4);
  assert.equal(snapshot.retryWindowExhausted, true);
});

test("an earlier campaign deadline bounds seed retries even more tightly", async () => {
  let nowMs = 5_000;
  const snapshot = await loadRevivalSeedMarketSnapshotWithRetry(MINT, {
    now: () => nowMs,
    sleep: async (delayMs) => {
      nowMs += delayMs;
    },
    deadlineAtMs: 6_000,
    maxRetryWindowMs: 15_000,
    retryDelaysMs: [750, 750],
    load: async () => ({
      provider: "dexscreener",
      observedAtMs: nowMs,
      reliable: false,
      reason: "provider_unavailable",
    }),
  });

  assert.equal(nowMs, 6_000);
  assert.equal(snapshot.attemptCount, 2);
  assert.equal(snapshot.retryWindowExhausted, true);
});
