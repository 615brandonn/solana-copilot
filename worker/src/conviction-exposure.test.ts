import assert from "node:assert/strict";
import test from "node:test";
import { effectiveConvictionExposureUsd } from "./conviction-exposure.js";

test("shadow exposure preserves the real base and accumulates paper tiers", () => {
  assert.equal(
    effectiveConvictionExposureUsd({
      tradingMode: "shadow",
      actualPositionUsd: 10,
      executedTiers: [
        { mode: "shadow", amountUsd: 5 },
        { mode: "shadow", amountUsd: 5 },
        { mode: "live", amountUsd: 99 },
      ],
    }),
    20,
  );
});

test("live exposure uses only the authoritative real position", () => {
  assert.equal(
    effectiveConvictionExposureUsd({
      tradingMode: "live",
      actualPositionUsd: 12.5,
      executedTiers: [{ mode: "shadow", amountUsd: 25 }],
    }),
    12.5,
  );
});

test("invalid exposure inputs fail closed to non-negative finite amounts", () => {
  assert.equal(
    effectiveConvictionExposureUsd({
      tradingMode: "shadow",
      actualPositionUsd: Number.NaN,
      executedTiers: [
        { mode: "shadow", amountUsd: Number.POSITIVE_INFINITY },
        { mode: "shadow", amountUsd: -5 },
      ],
    }),
    0,
  );
});
