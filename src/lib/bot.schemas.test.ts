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
  assert.equal(config.supplyAccumulationMaxMarketCapUsd, 15_000);
  assert.equal(config.supplyAccumulationWindowSeconds, 600);
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
    { supplyAccumulationMaxMarketCapUsd: 15_001 },
    { supplyAccumulationWindowSeconds: 29 },
    { supplyAccumulationWindowSeconds: 3_601 },
  ]) {
    assert.equal(BotConfigSchema.safeParse({ ...base, ...patch }).success, false);
  }
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
