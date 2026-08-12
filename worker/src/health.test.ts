import assert from "node:assert/strict";
import test from "node:test";

import { isMissingReadinessColumnError, toIsoTimestamp } from "./health.js";

test("normalizes heartbeat timestamps from milliseconds, seconds, strings, and dates", () => {
  const expected = "2023-11-14T22:13:20.000Z";
  assert.equal(toIsoTimestamp(1_700_000_000_000), expected);
  assert.equal(toIsoTimestamp(1_700_000_000), expected);
  assert.equal(toIsoTimestamp(expected), expected);
  assert.equal(toIsoTimestamp(new Date(expected)), expected);
});

test("rejects invalid heartbeat timestamps", () => {
  assert.equal(toIsoTimestamp(undefined), null);
  assert.equal(toIsoTimestamp("not-a-date"), null);
});

test("recognizes old heartbeat schemas so the worker can use the compatible payload", () => {
  assert.equal(
    isMissingReadinessColumnError(
      "Could not find the 'funding_key_ready' column in the schema cache",
    ),
    true,
  );
  assert.equal(
    isMissingReadinessColumnError(
      "Could not find the 'follower_balance_mismatch_count' column in the schema cache",
    ),
    true,
  );
  assert.equal(
    isMissingReadinessColumnError("permission denied for table worker_heartbeat"),
    false,
  );
});
