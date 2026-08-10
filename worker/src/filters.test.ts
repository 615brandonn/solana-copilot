import assert from "node:assert/strict";
import test from "node:test";

import type { BotConfigRow } from "./db.js";
import { checkEntry, type TokenMeta } from "./filters.js";
import type { SwapEvent } from "./geyser.js";

const NOW_MS = Date.UTC(2026, 7, 2, 0, 0, 0);

const config: BotConfigRow = {
  id: "config-id",
  user_id: "00000000-0000-0000-0000-000000000000",
  enabled: true,
  target_wallet: "target",
  execution_route: "rpc",
  jito_tip_sol: 0.001,
  fixed_buy_usd: 25,
  coordinated_mode_enabled: false,
  coordinated_fixed_buy_usd: 25,
  coordinated_target_wallet_count: 2,
  coordinated_window_seconds: 30,
  coordinated_mc_min_usd: 0,
  coordinated_mc_max_usd: 15_000,
  coordinated_coin_age_min_minutes: 0,
  coordinated_coin_age_max_minutes: 60,
  coordinated_target_buy_min_usd: 0,
  coordinated_target_buy_max_usd: 1_000_000,
  coordinated_first_buy_only: false,
  coordinated_once_per_token: true,
  coordinated_follower_sell_count: 1,
  coordinated_follower_sell_pct: 100,
  coordinated_inactivity_hours: 6,
  min_target_buy_usd: 10,
  mc_min_usd: 1_000,
  mc_max_usd: 100_000,
  liq_min_usd: 500,
  liq_max_usd: 50_000,
  token_age_filter_enabled: true,
  token_age_min_minutes: 0,
  token_age_max_minutes: 60,
  pump_fun_only: false,
  require_socials: false,
  only_first_buy_ever: false,
  only_once_per_token: true,
  take_profit_enabled: true,
  take_profit_pct: 100,
  take_profit_sell_pct: 50,
  stop_loss_enabled: true,
  stop_loss_pct: 30,
  proportional_follower_sells: true,
  follower_seller_exit_enabled: false,
  follower_seller_exit_count: 1,
  follower_seller_exit_pct: 100,
  target_inactivity_exit_enabled: false,
  target_inactivity_hours: 6,
};

const event: SwapEvent = {
  kind: "swap",
  wallet: "target",
  side: "buy",
  tokenMint: "mint",
  amountTokens: 1_000,
  decimals: 6,
  amountUsd: 20,
  solDelta: -0.1,
  slot: 1,
  txSig: "signature",
  timestampMs: NOW_MS,
  isPumpFun: false,
};

const meta: TokenMeta = {
  marketCapUsd: 10_000,
  liquidityUsd: 5_000,
  pairCreatedAtMs: NOW_MS - 30 * 60_000,
  isPumpFun: false,
  socials: {},
};

test("passes a token inside the configured age range", () => {
  assert.deepEqual(checkEntry(config, event, meta, { first: true, already: false }, NOW_MS), {
    pass: true,
  });
});

test("rejects a token older than the configured maximum", () => {
  const decision = checkEntry(
    config,
    event,
    { ...meta, pairCreatedAtMs: NOW_MS - 61 * 60_000 },
    { first: true, already: false },
    NOW_MS,
  );
  assert.equal(decision.pass, false);
  if (!decision.pass) assert.match(decision.reason, /token age 61\.0m outside 0-60m/);
});

test("rejects missing age metadata when the age filter is enabled", () => {
  const decision = checkEntry(
    config,
    event,
    { ...meta, pairCreatedAtMs: undefined },
    { first: true, already: false },
    NOW_MS,
  );
  assert.deepEqual(decision, { pass: false, reason: "token age unavailable" });
});

test("preserves existing behavior when the age filter is disabled", () => {
  const decision = checkEntry(
    { ...config, token_age_filter_enabled: false },
    event,
    { ...meta, pairCreatedAtMs: undefined },
    { first: true, already: false },
    NOW_MS,
  );
  assert.deepEqual(decision, { pass: true });
});

test("fails closed when target buy size or strict market data is unavailable", () => {
  assert.deepEqual(
    checkEntry(config, { ...event, amountUsd: undefined }, meta, { first: true, already: false }),
    { pass: false, reason: "target buy size unavailable" },
  );
  assert.deepEqual(
    checkEntry(
      config,
      event,
      { ...meta, marketCapUsd: undefined },
      { first: true, already: false },
    ),
    { pass: false, reason: "market cap unavailable" },
  );
  assert.deepEqual(
    checkEntry(
      config,
      event,
      { ...meta, liquidityUsd: undefined },
      { first: true, already: false },
    ),
    { pass: false, reason: "liquidity unavailable" },
  );
});

test("applies the existing minimum to a newly resolved target-buy value", () => {
  const fiftyDollarMinimum = { ...config, min_target_buy_usd: 50 };
  assert.deepEqual(
    checkEntry(
      fiftyDollarMinimum,
      { ...event, amountUsd: 80 },
      meta,
      { first: true, already: false },
      NOW_MS,
    ),
    { pass: true },
  );
  assert.deepEqual(
    checkEntry(
      fiftyDollarMinimum,
      { ...event, amountUsd: 40 },
      meta,
      { first: true, already: false },
      NOW_MS,
    ),
    { pass: false, reason: "target buy $40 < min $50" },
  );
});
