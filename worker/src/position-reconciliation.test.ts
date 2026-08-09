import assert from "node:assert/strict";
import test from "node:test";
import { ZeroBalanceConfirmationTracker } from "./position-reconciliation.js";

const positions = [
  { id: "held", token_mint: "mint-held" },
  { id: "flat", token_mint: "mint-flat" },
];

test("requires two successful zero-balance observations", () => {
  const tracker = new ZeroBalanceConfirmationTracker();
  assert.deepEqual(tracker.observe(positions, new Set(["mint-held"])), []);
  assert.deepEqual(tracker.observe(positions, new Set(["mint-held"])), ["flat"]);
});

test("a positive balance clears an earlier miss", () => {
  const tracker = new ZeroBalanceConfirmationTracker();
  assert.deepEqual(tracker.observe(positions, new Set(["mint-held"])), []);
  assert.deepEqual(tracker.observe(positions, new Set(["mint-held", "mint-flat"])), []);
  assert.deepEqual(tracker.observe(positions, new Set(["mint-held"])), []);
});

test("forgets positions that are no longer open", () => {
  const tracker = new ZeroBalanceConfirmationTracker();
  tracker.observe(positions, new Set(["mint-held"]));
  tracker.observe([positions[0]], new Set(["mint-held"]));
  assert.deepEqual(tracker.observe(positions, new Set(["mint-held"])), []);
});
