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

test("reserves a ready cluster until the caller explicitly commits it", () => {
  const tracker = new CoordinatedBuyTracker();
  tracker.record(cfg, buy("wallet-a", NOW));
  const ready = tracker.record(cfg, buy("wallet-b", NOW + 1_000));
  assert.equal(ready.ready, true);
  if (!ready.ready) return;

  assert.deepEqual(tracker.retry(cfg, "mint", NOW + 2_000), {
    ready: false,
    reason: "coordinated cluster reservation in progress",
    qualifyingWallets: 2,
  });
  assert.equal(tracker.commit(ready.reservationId, NOW + 2_000), true);
  assert.equal(tracker.commit(ready.reservationId), false);
  assert.deepEqual(tracker.retry(cfg, "mint", NOW + 3_000), {
    ready: false,
    reason: "coordinated cluster already triggered",
    qualifyingWallets: 2,
  });
});

test("release makes an unconsumed cluster eligible for a fresh reservation", () => {
  const tracker = new CoordinatedBuyTracker();
  tracker.record(cfg, buy("wallet-a", NOW));
  const first = tracker.record(cfg, buy("wallet-b", NOW + 1_000));
  assert.equal(first.ready, true);
  if (!first.ready) return;

  assert.equal(tracker.release(first.reservationId), true);
  const replacement = tracker.retry(cfg, "mint", NOW + 2_000);
  assert.equal(replacement.ready, true);
  if (!replacement.ready) return;
  assert.notEqual(replacement.reservationId, first.reservationId);
  assert.deepEqual(replacement.observations, first.observations);

  // A late completion from the old attempt cannot settle the replacement.
  assert.equal(tracker.commit(first.reservationId), false);
  assert.deepEqual(tracker.retry(cfg, "mint", NOW + 3_000), {
    ready: false,
    reason: "coordinated cluster reservation in progress",
    qualifyingWallets: 2,
  });
});

test("defer pins a cluster across the rolling window and atomically retries it", () => {
  const tracker = new CoordinatedBuyTracker();
  tracker.record(cfg, buy("wallet-a", NOW));
  const ready = tracker.record(cfg, buy("wallet-b", NOW + 1_000));
  assert.equal(ready.ready, true);
  if (!ready.ready) return;

  const retryAtMs = NOW + 3 * 60_000;
  assert.equal(
    tracker.defer(
      ready.reservationId,
      {
        retryAtMs,
        expiresAtMs: retryAtMs + 30_000,
      },
      NOW + 2_000,
    ),
    true,
  );
  assert.deepEqual(tracker.retry(cfg, "mint", retryAtMs - 1), {
    ready: false,
    reason: "coordinated cluster deferred",
    qualifyingWallets: 2,
    retryAtMs,
  });

  // The original observations are now outside the 30-second rolling window,
  // but the already-qualified cluster remains pinned until its hard deadline.
  const retried = tracker.retry(cfg, "mint", retryAtMs);
  assert.equal(retried.ready, true);
  if (!retried.ready) return;
  assert.equal(retried.reservationId, ready.reservationId);
  assert.deepEqual(retried.observations, ready.observations);
  assert.equal(retried.expiresAtMs, retryAtMs + 30_000);
  assert.equal(tracker.isReservationActive(retried.reservationId, retryAtMs + 1), true);

  // retry() is reservation-safe even if two timers fire at the same time.
  assert.deepEqual(tracker.retry(cfg, "mint", retryAtMs), {
    ready: false,
    reason: "coordinated cluster reservation in progress",
    qualifyingWallets: 2,
  });
});

test("the deferred hard deadline is enforced immediately before commit", () => {
  const tracker = new CoordinatedBuyTracker();
  tracker.record(cfg, buy("wallet-a", NOW));
  const ready = tracker.record(cfg, buy("wallet-b", NOW + 1_000));
  assert.equal(ready.ready, true);
  if (!ready.ready) return;
  assert.equal(
    tracker.defer(
      ready.reservationId,
      { retryAtMs: NOW + 5_000, expiresAtMs: NOW + 10_000 },
      NOW + 2_000,
    ),
    true,
  );
  const retried = tracker.retry(cfg, "mint", NOW + 5_000);
  assert.equal(retried.ready, true);
  if (!retried.ready) return;
  assert.equal(retried.expiresAtMs, NOW + 10_000);
  assert.equal(tracker.commit(retried.reservationId, NOW + 10_000), false);
  assert.equal(tracker.release(retried.reservationId), false);
});

test("a deferred cluster expires closed and cannot be revived from stale observations", () => {
  const tracker = new CoordinatedBuyTracker();
  tracker.record(cfg, buy("wallet-a", NOW));
  const ready = tracker.record(cfg, buy("wallet-b", NOW + 1_000));
  assert.equal(ready.ready, true);
  if (!ready.ready) return;

  assert.equal(
    tracker.defer(
      ready.reservationId,
      {
        retryAtMs: NOW + 60_000,
        expiresAtMs: NOW + 90_000,
      },
      NOW + 2_000,
    ),
    true,
  );
  assert.deepEqual(tracker.retry(cfg, "mint", NOW + 90_000), {
    ready: false,
    reason: "waiting for 2 more target wallet(s)",
    qualifyingWallets: 0,
  });
  assert.equal(tracker.commit(ready.reservationId), false);
});

test("invalid deferrals do not strand or consume the active reservation", () => {
  const tracker = new CoordinatedBuyTracker();
  tracker.record(cfg, buy("wallet-a", NOW));
  const ready = tracker.record(cfg, buy("wallet-b", NOW + 1_000));
  assert.equal(ready.ready, true);
  if (!ready.ready) return;

  assert.equal(
    tracker.defer(
      ready.reservationId,
      {
        retryAtMs: NOW + 10_000,
        expiresAtMs: NOW + 10_000,
      },
      NOW + 2_000,
    ),
    false,
  );
  assert.deepEqual(tracker.retry(cfg, "mint", NOW + 2_000), {
    ready: false,
    reason: "coordinated cluster reservation in progress",
    qualifyingWallets: 2,
  });
  assert.equal(tracker.release(ready.reservationId), true);
});

test("reservation lease expiry tombstones the exact cluster instead of re-firing it", () => {
  const tracker = new CoordinatedBuyTracker({ reservationLeaseMs: 5_000 });
  const longWindow = { ...cfg, coordinated_window_seconds: 300 };
  tracker.record(longWindow, buy("wallet-a", NOW));
  const ready = tracker.record(longWindow, buy("wallet-b", NOW + 1_000));
  assert.equal(ready.ready, true);
  if (!ready.ready) return;

  // Simulates a caller that threw without finally settling the reservation.
  assert.deepEqual(tracker.retry(longWindow, "mint", NOW + 6_000), {
    ready: false,
    reason: "coordinated cluster already triggered",
    qualifyingWallets: 2,
  });
  assert.equal(tracker.commit(ready.reservationId), false);
});

test("deferred expiry tombstones observations that are still inside a long window", () => {
  const tracker = new CoordinatedBuyTracker();
  const longWindow = { ...cfg, coordinated_window_seconds: 300 };
  tracker.record(longWindow, buy("wallet-a", NOW));
  const ready = tracker.record(longWindow, buy("wallet-b", NOW + 1_000));
  assert.equal(ready.ready, true);
  if (!ready.ready) return;
  assert.equal(
    tracker.defer(
      ready.reservationId,
      {
        retryAtMs: NOW + 5_000,
        expiresAtMs: NOW + 10_000,
      },
      NOW + 2_000,
    ),
    true,
  );

  assert.deepEqual(tracker.retry(longWindow, "mint", NOW + 10_000), {
    ready: false,
    reason: "coordinated cluster already triggered",
    qualifyingWallets: 2,
  });
});

test("deferred retry invalidates on coordinated config or target-scope changes", () => {
  const tracker = new CoordinatedBuyTracker();
  tracker.record(cfg, buy("wallet-a", NOW), "targets-v1");
  const ready = tracker.record(cfg, buy("wallet-b", NOW + 1_000), "targets-v1");
  assert.equal(ready.ready, true);
  if (!ready.ready) return;
  assert.equal(
    tracker.defer(
      ready.reservationId,
      {
        retryAtMs: NOW + 5_000,
        expiresAtMs: NOW + 30_000,
      },
      NOW + 2_000,
    ),
    true,
  );

  assert.deepEqual(tracker.retry(cfg, "mint", NOW + 5_000, "targets-v2"), {
    ready: false,
    reason: "coordinated cluster invalidated by configuration or target change",
    qualifyingWallets: 0,
  });

  const other = new CoordinatedBuyTracker();
  other.record(cfg, buy("wallet-a", NOW), "targets-v1");
  const otherReady = other.record(cfg, buy("wallet-b", NOW + 1_000), "targets-v1");
  assert.equal(otherReady.ready, true);
  if (!otherReady.ready) return;
  assert.equal(
    other.defer(
      otherReady.reservationId,
      {
        retryAtMs: NOW + 5_000,
        expiresAtMs: NOW + 30_000,
      },
      NOW + 2_000,
    ),
    true,
  );
  const changedCfg = { ...cfg, coordinated_target_buy_min_usd: 600 };
  assert.deepEqual(other.retry(changedCfg, "mint", NOW + 5_000, "targets-v1"), {
    ready: false,
    reason: "coordinated cluster invalidated by configuration or target change",
    qualifyingWallets: 0,
  });
});

test("target sell and global config refresh cancel pending clusters fail-closed", () => {
  const tracker = new CoordinatedBuyTracker();
  tracker.record(cfg, buy("wallet-a", NOW));
  const ready = tracker.record(cfg, buy("wallet-b", NOW + 1_000));
  assert.equal(ready.ready, true);
  if (!ready.ready) return;
  assert.equal(tracker.onTargetSell("mint"), true);
  assert.equal(tracker.commit(ready.reservationId), false);
  assert.deepEqual(tracker.retry(cfg, "mint", NOW + 2_000), {
    ready: false,
    reason: "waiting for 2 more target wallet(s)",
    qualifyingWallets: 0,
  });

  tracker.record(cfg, buy("wallet-a", NOW + 3_000, { tokenMint: "mint-2" }));
  const second = tracker.record(cfg, buy("wallet-b", NOW + 4_000, { tokenMint: "mint-2" }));
  assert.equal(second.ready, true);
  if (!second.ready) return;
  assert.equal(tracker.cancelAll(), 1);
  assert.equal(tracker.release(second.reservationId), false);
  assert.deepEqual(tracker.retry(cfg, "mint-2", NOW + 5_000), {
    ready: false,
    reason: "waiting for 2 more target wallet(s)",
    qualifyingWallets: 0,
  });
});

test("pending reservations are bounded and capacity is recovered by settlement", () => {
  const tracker = new CoordinatedBuyTracker({ maxPendingReservations: 1 });
  tracker.record(cfg, buy("wallet-a", NOW, { tokenMint: "mint-1" }));
  const first = tracker.record(cfg, buy("wallet-b", NOW + 1_000, { tokenMint: "mint-1" }));
  assert.equal(first.ready, true);
  if (!first.ready) return;

  tracker.record(cfg, buy("wallet-a", NOW + 2_000, { tokenMint: "mint-2" }));
  assert.deepEqual(tracker.record(cfg, buy("wallet-b", NOW + 3_000, { tokenMint: "mint-2" })), {
    ready: false,
    reason: "coordinated reservation capacity reached",
    qualifyingWallets: 2,
  });
  assert.equal(tracker.release(first.reservationId), true);
  assert.equal(tracker.retry(cfg, "mint-2", NOW + 4_000).ready, true);
});

test("full reset does not let an old reservation ID settle a new cluster", () => {
  const tracker = new CoordinatedBuyTracker();
  tracker.record(cfg, buy("wallet-a", NOW));
  const first = tracker.record(cfg, buy("wallet-b", NOW + 1_000));
  assert.equal(first.ready, true);
  if (!first.ready) return;
  tracker.reset();

  tracker.record(cfg, buy("wallet-a", NOW + 2_000));
  const second = tracker.record(cfg, buy("wallet-b", NOW + 3_000));
  assert.equal(second.ready, true);
  if (!second.ready) return;
  assert.notEqual(first.reservationId, second.reservationId);
  assert.equal(tracker.commit(first.reservationId), false);
  assert.equal(tracker.commit(second.reservationId, NOW + 4_000), true);
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
  assert.deepEqual(checkCoordinatedEntry(cfg, meta, false, NOW), {
    pass: true,
    ageMinutes: 20,
    ageSource: "dexscreener_pair",
  });
  assert.deepEqual(checkCoordinatedEntry(cfg, { ...meta, marketCapUsd: 16_000 }, false, NOW), {
    pass: false,
    reason: "coordinated market cap out of range",
    code: "market_cap_out_of_range",
  });
  assert.deepEqual(checkCoordinatedEntry(cfg, meta, true, NOW), {
    pass: false,
    reason: "already copied this coin",
    code: "already_traded",
  });
});

test("Pump coordinated age requires exact finalized Create evidence and chain time", () => {
  const strict = {
    ...cfg,
    coordinated_coin_age_min_minutes: 3,
    coordinated_coin_age_max_minutes: 60,
  };
  const pumpMeta = {
    marketCapUsd: 10_000,
    pairCreatedAtMs: NOW - 10 * 60_000,
    isPumpFun: true,
    socials: {},
  };
  assert.deepEqual(checkCoordinatedEntry(strict, pumpMeta, false, NOW), {
    pass: false,
    reason: "coin age unavailable",
    code: "coin_age_unavailable",
  });

  const exact = {
    ...pumpMeta,
    tokenCreatedAtMs: NOW - 3 * 60_000,
    tokenAgeEvaluatedAtMs: NOW,
    tokenAgeSource: "pump_finalized_create" as const,
  };
  assert.deepEqual(checkCoordinatedEntry(strict, exact, false, NOW), {
    pass: true,
    ageMinutes: 3,
    ageSource: "pump_finalized_create",
  });
  assert.equal(
    checkCoordinatedEntry(
      strict,
      { ...exact, tokenAgeEvaluatedAtMs: exact.tokenCreatedAtMs - 1 },
      false,
      NOW,
    ).pass,
    false,
  );
  assert.equal(
    checkCoordinatedEntry(strict, { ...exact, tokenCreatedAtMs: NOW - 60 * 60_000 }, false, NOW)
      .pass,
    true,
  );
  const tooOld = checkCoordinatedEntry(
    strict,
    { ...exact, tokenCreatedAtMs: NOW - 60 * 60_000 - 1 },
    false,
    NOW,
  );
  assert.equal(tooOld.pass, false);
  if (!tooOld.pass) assert.equal(tooOld.code, "coin_too_old");
});

test("too-young Pump evidence returns an exact retry delay", () => {
  const strict = {
    ...cfg,
    coordinated_coin_age_min_minutes: 3,
    coordinated_coin_age_max_minutes: 60,
  };
  const decision = checkCoordinatedEntry(
    strict,
    {
      marketCapUsd: 10_000,
      isPumpFun: true,
      socials: {},
      tokenCreatedAtMs: NOW - 2 * 60_000,
      tokenAgeEvaluatedAtMs: NOW,
      tokenAgeSource: "pump_finalized_create",
    },
    false,
    NOW,
  );
  assert.equal(decision.pass, false);
  if (!decision.pass) {
    assert.equal(decision.code, "coin_too_young");
    assert.equal(decision.retryAfterMs, 60_000);
  }
});

test("six-hour inactivity deadline is deterministic", () => {
  assert.equal(inactivityDeadlineMs(new Date(NOW), 6), NOW + 6 * 60 * 60_000);
});

test("distinct follower sellers trigger only once at the configured count", () => {
  assert.equal(shouldTriggerDistinctSellerExit(1, 2, false), false);
  assert.equal(shouldTriggerDistinctSellerExit(2, 2, false), true);
  assert.equal(shouldTriggerDistinctSellerExit(3, 2, true), false);
});
