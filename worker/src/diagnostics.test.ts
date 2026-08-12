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

test("safe diagnostics redact URL userinfo, path credentials, and sensitive query values", () => {
  const pathToken = `sk-proj-${"A1b2".repeat(12)}`;
  const text = safeDiagnostic(
    `connect postgresql://project-user:p%40ssword@db.example.test:5432/postgres; ` +
      `GET https://api.example.test/v1/${pathToken}/status?token=query-secret returned PGRST204`,
  );

  assert.match(text, /postgresql:\/\/\[REDACTED_USERINFO\]@db\.example\.test:5432\/postgres/);
  assert.match(text, /\/v1\/\[REDACTED_PATH\]\/status\?token=\[REDACTED\]/);
  assert.match(text, /PGRST204/);
  assert.doesNotMatch(text, /project-user|p%40ssword|query-secret|sk-proj-/);
});

test("safe diagnostics redact common token formats and identifiers but retain useful codes", () => {
  const jwt = `${"eyJ" + "a".repeat(20)}.${"eyJ" + "b".repeat(20)}.${"c".repeat(24)}`;
  const wallet = "33D8B9hpN1P5UwoUzSt64iwaVyh1DrYkPRMpd6hbx9ZZ";
  const uuid = "12345678-1234-4234-9234-123456789abc";
  const text = safeDiagnostic(
    `status=522 code=PGRST204 jwt=${jwt} wallet=${wallet} user_id=${uuid}`,
  );

  assert.match(text, /status=522/);
  assert.match(text, /code=PGRST204/);
  assert.match(text, /\[REDACTED_JWT\]/);
  assert.match(text, /\[REDACTED_ID\]/);
  assert.doesNotMatch(text, /33D8B9|12345678-1234|eyJaaaa/);
});

test("deployment identifiers are represented without their value", () => {
  assert.equal(redactedIdentifier("12345678-1234-1234-1234-123456789abc"), "[configured:36 chars]");
  assert.equal(redactedIdentifier(undefined), "missing");
});
