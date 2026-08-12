import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAIMED_STALE_AFTER_MS,
  SUBMITTED_STALE_AFTER_MS,
  evaluateEntryClaimGate,
  evaluateSellClaimGate,
} from "./doctor-claims.js";

const nowMs = Date.parse("2026-08-11T12:00:00.000Z");

test("every uncertain claim blocks immediately regardless of age", () => {
  const gate = evaluateSellClaimGate(
    [{ status: "uncertain", updated_at: new Date(nowMs).toISOString() }],
    nowMs,
  );
  assert.equal(gate.blocked, true);
  assert.equal(gate.uncertain, 1);
});

test("fresh submitted and claimed actions block restart without a blind grace pass", () => {
  const gate = evaluateSellClaimGate(
    [
      { status: "submitted", updated_at: new Date(nowMs - 1_000).toISOString() },
      { status: "claimed", updated_at: new Date(nowMs - 1_000).toISOString() },
    ],
    nowMs,
  );
  assert.equal(gate.blocked, true);
  assert.equal(gate.total, 2);
  assert.equal(gate.staleSubmitted, 0);
  assert.equal(gate.staleClaimed, 0);
});

test("short thresholds identify stalled submitted and claimed actions", () => {
  const gate = evaluateSellClaimGate(
    [
      {
        status: "submitted",
        updated_at: new Date(nowMs - SUBMITTED_STALE_AFTER_MS).toISOString(),
      },
      {
        status: "claimed",
        updated_at: new Date(nowMs - CLAIMED_STALE_AFTER_MS).toISOString(),
      },
      { status: "claimed", updated_at: "not-a-date" },
    ],
    nowMs,
  );
  assert.equal(gate.staleSubmitted, 1);
  assert.equal(gate.staleClaimed, 2);
  assert.equal(gate.invalidTimestamp, 1);
});

test("terminal and retryable pre-submit rows do not block deployment", () => {
  const gate = evaluateSellClaimGate(
    [
      { status: "landed", updated_at: new Date(nowMs).toISOString() },
      { status: "failed_pre_submit", updated_at: new Date(nowMs).toISOString() },
    ],
    nowMs,
  );
  assert.equal(gate.blocked, false);
  assert.equal(gate.total, 0);
});

test("every unresolved entry state blocks deployment, including landed", () => {
  const gate = evaluateEntryClaimGate([
    { status: "claimed" },
    { status: "submitted" },
    { status: "landed" },
    { status: "uncertain" },
  ]);
  assert.deepEqual(gate, {
    blocked: true,
    total: 4,
    uncertain: 1,
    landed: 1,
    submitted: 1,
    claimed: 1,
  });
});

test("persisted and failed pre-submit entry claims do not block deployment", () => {
  const gate = evaluateEntryClaimGate([{ status: "persisted" }, { status: "failed_pre_submit" }]);
  assert.equal(gate.blocked, false);
  assert.equal(gate.total, 0);
});
