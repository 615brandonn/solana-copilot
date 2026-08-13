import assert from "node:assert/strict";
import test from "node:test";
import { evaluateConvictionLiveExecutionGate } from "./conviction-execution-policy.js";

const safe = {
  strategy: "conviction" as const,
  tradingMode: "live" as const,
  entriesEnabled: true,
  monitoringBlocked: false,
  fresh: true,
  uncertainEntry: false,
  existingExposureUsd: 5,
  requestedBuyUsd: 5,
  maxExposureUsd: 25,
};

test("live Conviction requires both the exclusive strategy and global Entries", () => {
  assert.equal(evaluateConvictionLiveExecutionGate(safe).allowed, true);
  assert.equal(
    evaluateConvictionLiveExecutionGate({ ...safe, strategy: "regular" }).allowed,
    false,
  );
  assert.equal(
    evaluateConvictionLiveExecutionGate({ ...safe, entriesEnabled: false }).allowed,
    false,
  );
  assert.equal(
    evaluateConvictionLiveExecutionGate({ ...safe, tradingMode: "shadow" }).allowed,
    false,
  );
});

test("monitoring, freshness, uncertainty, and exposure fail closed", () => {
  assert.equal(
    evaluateConvictionLiveExecutionGate({ ...safe, monitoringBlocked: true }).allowed,
    false,
  );
  assert.equal(evaluateConvictionLiveExecutionGate({ ...safe, fresh: false }).allowed, false);
  assert.equal(
    evaluateConvictionLiveExecutionGate({ ...safe, uncertainEntry: true }).allowed,
    false,
  );
  assert.deepEqual(
    evaluateConvictionLiveExecutionGate({
      ...safe,
      existingExposureUsd: 21,
      requestedBuyUsd: 5,
    }),
    { allowed: false, reason: "max position per token would be exceeded" },
  );
});
