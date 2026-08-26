import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const recoveryStoreSource = readFileSync(
  new URL("../src/sell-claim-recovery-store.ts", import.meta.url),
  "utf8",
);

test("every claimed exit persists its exact signed attempt before the first network send", () => {
  const start = source.indexOf("async function executeClaimedPercentageExit");
  const end = source.indexOf("const supplyBuyBackground", start);
  assert.ok(start >= 0 && end > start, "claimed-exit implementation was not found");
  const body = source.slice(start, end);

  const preparedAt = body.indexOf("const persistPreparedSell");
  const executeAt = body.indexOf("const result = await executeExitSell", preparedAt);
  assert.ok(preparedAt >= 0 && preparedAt < executeAt);
  assert.match(
    body,
    /sellClaimRecoveryStore\.prepare\(claim\.id,[\s\S]*positionAmountBeforeRaw: currentPositionRawText/,
  );
  assert.match(
    body,
    /const authorizePreparedSell[\s\S]*?sellClaimRecoveryStore\.authorize\(claim\.id, preparedBotTxSig\)/,
  );
  assert.match(
    recoveryStoreSource,
    /async authorize\([\s\S]*?\.eq\("status", "submitted"\)[\s\S]*?\.eq\("recovery_version", 1\)[\s\S]*?\.eq\("bot_tx_sig", requiredString\(txSig,/,
  );
  assert.match(body, /executeExitSell\([\s\S]*?persistPreparedSell,[\s\S]*?authorizePreparedSell,/);
});

test("the exit executor forwards durable preparation and final authorization to every route", () => {
  const start = source.indexOf("async function executeExitSell");
  const end = source.indexOf("async function executeClaimedPercentageExit", start);
  assert.ok(start >= 0 && end > start, "exit executor was not found");
  const body = source.slice(start, end);
  assert.match(body, /onPrepared\?: \(prepared: PreparedSellContext\)/);
  assert.match(body, /beforeSubmit\?: ExecuteInput\["beforeSubmit"\]/);
  assert.match(body, /onPrepared: async \(prepared\)[\s\S]*await onPrepared\?\.[\s\S]*beforeSubmit,/);
});
