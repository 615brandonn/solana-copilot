import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG } from "./bot-config";
import { BotConfigSchema } from "./bot.schemas";

test("database-valid long coordinated windows survive dashboard validation", () => {
  const config = BotConfigSchema.parse({
    ...DEFAULT_CONFIG,
    coordinatedCoinAgeMinMinutes: 0,
    coordinatedCoinAgeMaxMinutes: 1_051_200,
    coordinatedInactivityHours: 87_600,
  });

  assert.equal(config.coordinatedCoinAgeMaxMinutes, 1_051_200);
  assert.equal(config.coordinatedInactivityHours, 87_600);
});

test("Supply Accumulation defaults are deployment-safe and exact", () => {
  const config = BotConfigSchema.parse(DEFAULT_CONFIG);
  assert.equal(config.supplyAccumulationModeEnabled, false);
  assert.equal(config.supplyAccumulationThresholdPct, 10);
  assert.equal(config.supplyAccumulationBuyUsd, 20);
  assert.equal(config.supplyAccumulationMinMarketCapUsd, 2_000);
  assert.equal(config.supplyAccumulationMaxMarketCapUsd, 15_000);
  assert.equal(config.supplyAccumulationWindowSeconds, 600);
  assert.equal(config.supplyAccumulationScale2Enabled, false);
  assert.equal(config.supplyAccumulationScale2ThresholdPct, 12);
  assert.equal(config.supplyAccumulationScale2BuyUsd, 10);
  assert.equal(config.supplyAccumulationScale3Enabled, false);
  assert.equal(config.supplyAccumulationScale3ThresholdPct, 15);
  assert.equal(config.supplyAccumulationScale3BuyUsd, 10);
  assert.equal(config.supplyAccumulationScale4Enabled, false);
  assert.equal(config.supplyAccumulationScale4ThresholdPct, 18);
  assert.equal(config.supplyAccumulationScale4BuyUsd, 10);
});

test("Supply Accumulation accepts only the bounded live strategy contract", () => {
  const base = {
    ...DEFAULT_CONFIG,
    targetWallet: "Em8J3gBWapfVBGVhVipwQnLrqCvnWBnLajw6XFsFECPF",
    custodyJourneyEnabled: true,
    supplyAccumulationModeEnabled: true,
  };
  assert.equal(BotConfigSchema.parse(base).supplyAccumulationModeEnabled, true);

  for (const patch of [
    { supplyAccumulationThresholdPct: 9.99 },
    { supplyAccumulationThresholdPct: 20.01 },
    { supplyAccumulationBuyUsd: 0 },
    { supplyAccumulationMinMarketCapUsd: 15_000 },
    { supplyAccumulationMinMarketCapUsd: 3_000, supplyAccumulationMaxMarketCapUsd: 2_999 },
    { supplyAccumulationMaxMarketCapUsd: 15_001 },
    { supplyAccumulationWindowSeconds: 29 },
    { supplyAccumulationWindowSeconds: 3_601 },
  ]) {
    assert.equal(BotConfigSchema.safeParse({ ...base, ...patch }).success, false);
  }
});

test("Supply Accumulation scale tiers are optional, contiguous, and strictly increasing", () => {
  const base = {
    ...DEFAULT_CONFIG,
    targetWallet: "Em8J3gBWapfVBGVhVipwQnLrqCvnWBnLajw6XFsFECPF",
    custodyJourneyEnabled: true,
    supplyAccumulationModeEnabled: true,
  };

  assert.equal(
    BotConfigSchema.safeParse({
      ...base,
      supplyAccumulationScale2Enabled: true,
      supplyAccumulationScale3Enabled: true,
      supplyAccumulationScale4Enabled: true,
    }).success,
    true,
  );
  assert.equal(
    BotConfigSchema.safeParse({ ...base, supplyAccumulationScale3Enabled: true }).success,
    false,
  );
  assert.equal(
    BotConfigSchema.safeParse({
      ...base,
      supplyAccumulationScale2Enabled: true,
      supplyAccumulationScale2ThresholdPct: 10,
    }).success,
    false,
  );
  assert.equal(
    BotConfigSchema.safeParse({
      ...base,
      supplyAccumulationScale2Enabled: true,
      supplyAccumulationScale3Enabled: true,
      supplyAccumulationScale3ThresholdPct: 12,
    }).success,
    false,
  );
  assert.equal(
    BotConfigSchema.safeParse({
      ...base,
      supplyAccumulationBuyUsd: 999_990,
      supplyAccumulationScale2Enabled: true,
      supplyAccumulationScale2BuyUsd: 11,
    }).success,
    false,
  );
});

test("Supply Accumulation fails closed without roots, custody, or exclusivity", () => {
  assert.equal(
    BotConfigSchema.safeParse({
      ...DEFAULT_CONFIG,
      custodyJourneyEnabled: true,
      supplyAccumulationModeEnabled: true,
    }).success,
    false,
  );
  assert.equal(
    BotConfigSchema.safeParse({
      ...DEFAULT_CONFIG,
      targetWallet: "Em8J3gBWapfVBGVhVipwQnLrqCvnWBnLajw6XFsFECPF",
      custodyJourneyEnabled: true,
      supplyAccumulationModeEnabled: true,
      coordinatedModeEnabled: true,
    }).success,
    false,
  );
  assert.equal(
    BotConfigSchema.safeParse({
      ...DEFAULT_CONFIG,
      targetWallet: "Em8J3gBWapfVBGVhVipwQnLrqCvnWBnLajw6XFsFECPF",
      supplyAccumulationModeEnabled: true,
      custodyJourneyEnabled: false,
    }).success,
    false,
  );
});
