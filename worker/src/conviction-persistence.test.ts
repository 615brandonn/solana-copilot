import assert from "node:assert/strict";
import test from "node:test";
import { ConvictionEngine } from "./conviction-engine.js";
import {
  convictionEventDbRow,
  convictionEventFromDbRow,
  convictionStateDbRow,
} from "./conviction-persistence.js";

const event = {
  eventId: "swap:sig:wallet:buy:mint",
  timestampMs: 1_800_000_000_000,
  wallet: "wallet",
  tokenMint: "mint",
  type: "DEX_BUY" as const,
  amountUsd: 1_250,
  amountTokens: 42,
  symbol: "COIN",
  marketCapUsd: 50_000,
  liquidityUsd: 20_000,
  classificationReliable: true,
};

test("event database mapping is lossless for engine-relevant fields", () => {
  const row = convictionEventDbRow({
    userId: "00000000-0000-0000-0000-000000000000",
    event,
    txSig: "sig",
    slot: 123,
    source: "geyser",
  });
  const restored = convictionEventFromDbRow(row);
  assert.ok(restored);
  assert.equal(restored.eventId, event.eventId);
  assert.equal(restored.amountUsd, event.amountUsd);
  assert.equal(restored.symbol, event.symbol);
  assert.equal(restored.classificationReliable, true);
});

test("token state mapping exposes rolling windows, score reasons, and position exposure", () => {
  const engine = new ConvictionEngine({
    enabled: true,
    clusterWallets: ["wallet", "wallet-2", "wallet-3"],
    minCapitalVelocityUsdPerMinute: 0,
    minCapitalAcceleration: -1,
  });
  engine.process(event);
  engine.setPositionUsd("mint", 5);
  const row = convictionStateDbRow(
    "00000000-0000-0000-0000-000000000000",
    engine.snapshot("mint")!,
  );
  assert.equal(row.our_current_position_usd, 5);
  assert.equal(row.net_flow_1m_usd, 1_250);
  assert.equal(row.wallet_net_usd.wallet, 1_250);
  assert.ok(Array.isArray(row.score_reasons));
  assert.ok("windows" in row.rolling_metrics);
});

test("malformed persisted rows fail closed instead of creating synthetic capital", () => {
  assert.equal(
    convictionEventFromDbRow({
      event_key: "x",
      event_at: "not-a-time",
      wallet: "wallet",
      token_mint: "mint",
      classification: "DEX_BUY",
      amount_usd: 100,
    }),
    null,
  );
});

test("nullable market metadata stays unavailable instead of becoming a synthetic zero", () => {
  const restored = convictionEventFromDbRow({
    event_key: "event",
    event_at: new Date(event.timestampMs).toISOString(),
    wallet: "wallet",
    token_mint: "mint",
    classification: "DEX_BUY",
    classification_reliable: true,
    amount_tokens: 10,
    amount_usd: 100,
    market_cap_usd: null,
    liquidity_usd: null,
    metadata: {},
  });
  assert.ok(restored);
  assert.equal(restored.marketCapUsd, undefined);
  assert.equal(restored.liquidityUsd, undefined);
  assert.equal(restored.tokenCreatedAtMs, undefined);
});

test("an out-of-leaderboard snapshot maps to the schema-safe unranked value", () => {
  const engine = new ConvictionEngine({
    enabled: true,
    clusterWallets: ["wallet", "wallet-2", "wallet-3"],
    leaderboardActiveMs: 1,
  });
  engine.process(event);
  engine.leaderboard(30, event.timestampMs + 2);
  const row = convictionStateDbRow(
    "00000000-0000-0000-0000-000000000000",
    engine.snapshot("mint")!,
  );
  assert.equal(row.current_rank, null);
  assert.equal(row.rank_direction, "unranked");
});
