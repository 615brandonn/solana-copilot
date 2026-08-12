import assert from "node:assert/strict";
import test from "node:test";

import {
  parseFollowerSellAccountingResult,
  parseRootFollowerTransferResult,
} from "./follower-accounting.js";

test("a duplicate root transfer remains subscription-repairable without being reapplied", () => {
  assert.deepEqual(
    parseRootFollowerTransferResult({
      applied: false,
      duplicate: true,
      appliedAmount: 42,
      triggerEligible: false,
    }),
    {
      applied: false,
      duplicate: true,
      appliedAmount: 42,
      triggerEligible: false,
    },
  );
});

test("a duplicate follower sell returns the original action snapshot", () => {
  assert.deepEqual(
    parseFollowerSellAccountingResult({
      applied: false,
      duplicate: true,
      appliedAmount: 25,
      soldFraction: 0.75,
      distinctSellerCount: 2,
      firstSellByWallet: true,
      triggerEligible: true,
      freshForAction: true,
    }),
    {
      applied: false,
      duplicate: true,
      appliedAmount: 25,
      soldFraction: 0.75,
      distinctSellerCount: 2,
      firstSellByWallet: true,
      triggerEligible: true,
      freshForAction: true,
    },
  );
});

test("unknown and zero-balance follower sells cannot become actions on replay", () => {
  assert.equal(
    parseFollowerSellAccountingResult({
      applied: false,
      duplicate: true,
      appliedAmount: 0,
      soldFraction: 1,
      triggerEligible: true,
      freshForAction: true,
    }),
    null,
  );
});

test("a payload mismatch fails closed instead of trusting inconsistent feed data", () => {
  assert.throws(
    () =>
      parseFollowerSellAccountingResult({
        duplicate: true,
        appliedAmount: 10,
        payloadMismatch: true,
      }),
    /payload mismatch/,
  );
  assert.throws(
    () => parseRootFollowerTransferResult({ duplicate: true, payloadMismatch: true }),
    /payload mismatch/,
  );
});
