import assert from "node:assert/strict";
import test from "node:test";

import { computeTargetSellAmount, type TargetSellPolicyInput } from "./target-sell-policy.js";

const validInput: TargetSellPolicyInput = {
  mode: "proportional",
  verifiedSell: true,
  linkedToPosition: true,
  amountRemaining: 80,
  targetPreAmount: 100,
  targetPostAmount: 60,
};

function amount(overrides: Partial<TargetSellPolicyInput> = {}): number {
  return computeTargetSellAmount({ ...validInput, ...overrides });
}

test("off mode never exits", () => {
  assert.equal(amount({ mode: "off" }), 0);
});

test("proportional mode mirrors the target's verified sold fraction", () => {
  assert.equal(amount(), 32);
  assert.equal(amount({ targetPostAmount: 0 }), 80);
});

test("fixed percentage mode exits the configured share of the remaining position", () => {
  assert.equal(amount({ mode: "fixed_pct", configuredPct: 25 }), 20);
  assert.equal(amount({ mode: "fixed_pct", configuredPct: 0 }), 0);
  assert.equal(amount({ mode: "fixed_pct", configuredPct: 100 }), 80);
});

test("full mode exits no more than the position remaining", () => {
  assert.equal(amount({ mode: "full" }), 80);
  assert.equal(amount({ mode: "full", amountRemaining: Number.MAX_VALUE }), Number.MAX_VALUE);
});

test("an exit requires both verified sell attribution and an unambiguous position link", () => {
  assert.equal(amount({ mode: "full", verifiedSell: false }), 0);
  assert.equal(amount({ mode: "full", linkedToPosition: false }), 0);
});

test("unchanged or increasing target balances are not sells", () => {
  assert.equal(amount({ mode: "full", targetPostAmount: 100 }), 0);
  assert.equal(amount({ mode: "full", targetPostAmount: 101 }), 0);
  assert.equal(amount({ mode: "full", targetPreAmount: 0, targetPostAmount: 0 }), 0);
});

test("invalid and ambiguous numeric inputs fail closed", () => {
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.equal(amount({ mode: "full", amountRemaining: invalid }), 0);
    assert.equal(amount({ mode: "full", targetPreAmount: invalid }), 0);
    assert.equal(amount({ mode: "full", targetPostAmount: invalid }), 0);
  }

  assert.equal(amount({ mode: "invalid" as TargetSellPolicyInput["mode"] }), 0);
});

test("fixed percentage configuration must be finite and between zero and one hundred", () => {
  assert.equal(amount({ mode: "fixed_pct", configuredPct: undefined }), 0);
  assert.equal(amount({ mode: "fixed_pct", configuredPct: Number.NaN }), 0);
  assert.equal(amount({ mode: "fixed_pct", configuredPct: Number.POSITIVE_INFINITY }), 0);
  assert.equal(amount({ mode: "fixed_pct", configuredPct: -0.1 }), 0);
  assert.equal(amount({ mode: "fixed_pct", configuredPct: 100.1 }), 0);
});

test("all modes return a finite amount clamped to the open position", () => {
  for (const mode of ["off", "proportional", "fixed_pct", "full"] as const) {
    const result = amount({ mode, configuredPct: 100 });
    assert.equal(Number.isFinite(result), true);
    assert.equal(result >= 0, true);
    assert.equal(result <= validInput.amountRemaining, true);
  }
});
