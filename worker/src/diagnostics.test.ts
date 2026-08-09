import assert from "node:assert/strict";
import test from "node:test";
import { redactedIdentifier, safeDiagnostic } from "./diagnostics.js";

test("safe diagnostics strip HTML, redact credentials, and cap output", () => {
  const text = safeDiagnostic(
    `<html><body>timeout Bearer abc123? api_key=secret ${"x".repeat(800)}</body></html>`,
  );
  assert.doesNotMatch(text, /<html>|abc123|secret/);
  assert.match(text, /\[REDACTED\]/);
  assert.ok(text.length <= 501);
});

test("deployment identifiers are represented without their value", () => {
  assert.equal(redactedIdentifier("12345678-1234-1234-1234-123456789abc"), "[configured:36 chars]");
  assert.equal(redactedIdentifier(undefined), "missing");
});
