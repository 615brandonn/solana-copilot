import assert from "node:assert/strict";
import test from "node:test";

import { targetTerminalOutflowExitPct } from "./target-outflow-policy.js";

test("target terminal-outflow response is fail-closed and defaults to no exit", () => {
  const base = {
    enabled: true,
    configuredPct: 100,
    sourceLinked: true,
    fresh: true,
    classificationSucceeded: true,
    terminalAmount: 10,
  };
  assert.equal(targetTerminalOutflowExitPct({ ...base, enabled: false }), 0);
  assert.equal(targetTerminalOutflowExitPct({ ...base, sourceLinked: false }), 0);
  assert.equal(targetTerminalOutflowExitPct({ ...base, fresh: false }), 0);
  assert.equal(targetTerminalOutflowExitPct({ ...base, classificationSucceeded: false }), 0);
  assert.equal(targetTerminalOutflowExitPct({ ...base, terminalAmount: 0 }), 0);
  assert.equal(targetTerminalOutflowExitPct(base), 100);
});

test("a terminal transfer is only a configurable custody-risk signal, not proof of sale", () => {
  assert.equal(
    targetTerminalOutflowExitPct({
      enabled: true,
      configuredPct: 35,
      sourceLinked: true,
      fresh: true,
      classificationSucceeded: true,
      terminalAmount: 1,
    }),
    35,
  );
});
