import assert from "node:assert/strict";
import test from "node:test";

import type { BotConfigRow } from "./db.js";
import {
  checkCoordinatedEntry,
  CoordinatedBuyTracker,
  inactivityDeadlineMs,
  shouldTriggerDistinctSellerExit,
  type TargetBuyObservation,
} from "./coordinated-mode.js";

const NOW = Date.UTC(2026, 7, 6, 12, 0, 0);

const cfg = {
  coordinated_window_seconds: 30,
  coordinated_target_wallet_count: 2,
  coordinated_target_buy_min_usd: 100,
  coordinated_target_buy_max_usd: 1_000,
  coordinated_first_buy_only: false,
  coordinated_mc_min_usd: 1_000,
  coordinated_mc_max_usd: 15_000,
  coordinated_coin_age_min_minutes: 0,
  coordinated_coin_age_max_minutes: 60,
  coordinated_once_per_token: true,
} as BotConfigRow;

function buy(
  wallet: string,
  timestampMs: number,
  patch: Partial<TargetBuyObservation> = {},
): TargetBuyObservation {
  return {
    wallet,
    tokenMint: "mint",
    amountUsd: 500,
    firstBuy: true,
    timestampMs,
    txSig: `sig-${wallet}-${timestampMs}`,
    slot: timestampMs,
    decimals: 6,
    ...patch,
  };
}

test("requires distinct target wallets inside the rolling time window", () => {
  const tracker = new CoordinatedBuyTracker();
  const first = tracker.record(cfg, buy("wallet-a", NOW));
  assert.equal(first.ready, false);
  const duplicateWallet = tracker.record(cfg, buy("wallet-a", NOW + 5_000));
  assert.equal(duplicateWallet.ready, false);
  const second = tracker.record(cfg, buy("wallet-b", NOW + 10_000));
  assert.equal(second.ready, true);
  if (second.ready)
    assert.deepEqual(
      second.observations.map((row) => row.wallet),
      ["wallet-a", "wallet-b"],
    );
});

test("does not coordinate buys outside the window or USD range", () => {
  const tracker = new CoordinatedBuyTracker();
  tracker.record(cfg, buy("wallet-a", NOW));
  const late = tracker.record(cfg, buy("wallet-b", NOW + 31_000));
  assert.equal(late.ready, false);
  const tooSmall = tracker.record(cfg, buy("wallet-c", NOW + 32_000, { amountUsd: 99 }));
  assert.deepEqual(tooSmall, {
    ready: false,
    reason: "target buy outside coordinated USD range",
    qualifyingWallets: 0,
  });
});

test("first-buy-only requires every qualifying target observation to be a first buy", () => {
  const tracker = new CoordinatedBuyTracker();
  const strict = { ...cfg, coordinated_first_buy_only: true };
  tracker.record(strict, buy("wallet-a", NOW, { firstBuy: false }));
  const decision = tracker.record(strict, buy("wallet-b", NOW + 1_000));
  assert.equal(decision.ready, false);
});

test("coordinated entry uses its own market-cap, age, and once-per-token filters", () => {
  const meta = {
    marketCapUsd: 10_000,
    liquidityUsd: undefined,
    pairCreatedAtMs: NOW - 20 * 60_000,
    isPumpFun: false,
    socials: {},
  };
  assert.deepEqual(checkCoordinatedEntry(cfg, meta, false, NOW), { pass: true });
  assert.deepEqual(checkCoordinatedEntry(cfg, { ...meta, marketCapUsd: 16_000 }, false, NOW), {
    pass: false,
    reason: "coordinated market cap out of range",
  });
  assert.deepEqual(checkCoordinatedEntry(cfg, meta, true, NOW), {
    pass: false,
    reason: "already copied this coin",
  });
});

test("six-hour inactivity deadline is deterministic", () => {
  assert.equal(inactivityDeadlineMs(new Date(NOW), 6), NOW + 6 * 60 * 60_000);
});

test("distinct follower sellers trigger only once at the configured count", () => {
  assert.equal(shouldTriggerDistinctSellerExit(1, 2, false), false);
  assert.equal(shouldTriggerDistinctSellerExit(2, 2, false), true);
  assert.equal(shouldTriggerDistinctSellerExit(3, 2, true), false);
});
