import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("every claimed exit persists its exact signed attempt before the first network send", () => {
  const start = source.indexOf("async function executeClaimedPercentageExit");
  const end = source.indexOf("const supplyBuyBackground", start);
  assert.ok(start >= 0 && end > start, "claimed-exit implementation was not found");
  const body = source.slice(start, end);

  const submittedAt = body.indexOf('{ status: "submitted", submission_started_at:');
  const preparedAt = body.indexOf("const persistPreparedSell", submittedAt);
  const executeAt = body.indexOf("const result = await executeExitSell", preparedAt);
  assert.ok(submittedAt >= 0 && submittedAt < preparedAt && preparedAt < executeAt);
  assert.match(
    body,
    /\.eq\("id", claim\.id\)[\s\S]*?\.eq\("status", "submitted"\)[\s\S]*?\.is\("bot_tx_sig", null\)[\s\S]*?\.select\("id"\)/,
  );
  assert.match(
    body,
    /const authorizePreparedSell[\s\S]*?\.eq\("status", "submitted"\)[\s\S]*?\.eq\("bot_tx_sig", preparedBotTxSig\)/,
  );
  assert.match(body, /executeExitSell\([\s\S]*?persistPreparedSell,[\s\S]*?authorizePreparedSell,/);
});

test("the exit executor forwards durable preparation and final authorization to every route", () => {
  const start = source.indexOf("async function executeExitSell");
  const end = source.indexOf("async function executeClaimedPercentageExit", start);
  assert.ok(start >= 0 && end > start, "exit executor was not found");
  const body = source.slice(start, end);
  assert.match(body, /onPrepared\?: ExecuteInput\["onPrepared"\]/);
  assert.match(body, /beforeSubmit\?: ExecuteInput\["beforeSubmit"\]/);
  assert.match(body, /onPrepared,\s*beforeSubmit,/);
});
