import assert from "node:assert/strict";
import test from "node:test";
import {
  SubmissionUncertainError,
  SubmittedTransactionFailedError,
  isPostSubmissionError,
  mayTryAlternateExecution,
  parseUniqueCsvSetting,
} from "./execution-safety.js";

test("post-submission errors block alternate transaction execution", () => {
  const uncertain = new SubmissionUncertainError({
    route: "rpc",
    txSig: "public-signature",
    detail: "timeout",
  });
  const failed = new SubmittedTransactionFailedError({
    route: "jito",
    txSig: "public-signature",
    detail: "instruction error",
  });

  assert.equal(isPostSubmissionError(uncertain), true);
  assert.equal(isPostSubmissionError(failed), true);
  assert.equal(mayTryAlternateExecution(uncertain), false);
  assert.equal(mayTryAlternateExecution(failed), false);
  assert.equal(mayTryAlternateExecution(new Error("quote failed before submission")), true);
});

test("submission errors sanitize diagnostics before an outer logger can preserve them", () => {
  const error = new SubmissionUncertainError({
    route: "jupiter-v2",
    detail: "Bearer secret-token api_key=super-secret <b>gateway error</b>",
  });

  assert.match(error.message, /Bearer \[REDACTED\]/);
  assert.match(error.message, /api_key=\[REDACTED\]/);
  assert.doesNotMatch(error.message, /secret-token|super-secret|<b>/);
});

test("Jito account configuration is trimmed and duplicate values are rejected safely", () => {
  assert.deepEqual(parseUniqueCsvSetting(" first , second,third ", "JITO_TIP_ACCOUNTS"), [
    "first",
    "second",
    "third",
  ]);

  assert.throws(
    () => parseUniqueCsvSetting("private-value,other,private-value", "JITO_TIP_ACCOUNTS"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /configured 3, unique 2/);
      assert.doesNotMatch(error.message, /private-value|other/);
      return true;
    },
  );
});
