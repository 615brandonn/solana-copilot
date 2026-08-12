import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const healthDir = new URL("../../src/routes/api/health/", import.meta.url);

function healthSource(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, healthDir)), "utf8");
}

test("public health routes never return raw exception or database messages", () => {
  const source = ["db.ts", "key-role.ts", "test-save.ts", "url-check.ts"]
    .map(healthSource)
    .join("\n");
  assert.doesNotMatch(source, /\b(?:error|err|e)\.message\b/i);
  assert.doesNotMatch(source, /\b(?:error|err|e)\.stack\b/i);
  assert.doesNotMatch(source, /keyPrefix|keyLength|urlEndsWith|details:\s*error/i);
});

test("the legacy write diagnostic remains permanently disabled", () => {
  const source = healthSource("test-save.ts");
  assert.match(source, /status:\s*410/);
  assert.doesNotMatch(source, /createClient|\.from\(|insert\(|upsert\(|update\(/);
});
