import assert from "node:assert/strict";
import test from "node:test";
import { attributablePositiveBalanceDelta } from "./execution-accounting.js";

test("Pump fallback accounting excludes pre-existing token holdings", () => {
  assert.equal(attributablePositiveBalanceDelta(95_000_000, 95_000_125.5), 125.5);
  assert.equal(attributablePositiveBalanceDelta(0, 125.5), 125.5);
});

test("Pump fallback accounting fails closed without a positive finite delta", () => {
  assert.equal(attributablePositiveBalanceDelta(10, 10), undefined);
  assert.equal(attributablePositiveBalanceDelta(10, 9), undefined);
  assert.equal(attributablePositiveBalanceDelta(Number.NaN, 10), undefined);
  assert.equal(attributablePositiveBalanceDelta(0, Number.POSITIVE_INFINITY), undefined);
});
