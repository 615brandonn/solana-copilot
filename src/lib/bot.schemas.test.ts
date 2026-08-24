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
