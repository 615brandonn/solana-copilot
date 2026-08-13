import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const executorSource = readFileSync(new URL("../src/executor.ts", import.meta.url), "utf8");

test("Pump.fun fallback keeps transaction submission behind the caller-owned final gate", () => {
  const pumpStart = executorSource.indexOf("async function executePumpFunSwap");
  const pumpEnd = executorSource.indexOf("function tokenDeltaFromTx", pumpStart);
  assert.ok(pumpStart >= 0 && pumpEnd > pumpStart, "Pump.fun executor was not found");

  const pumpSource = executorSource.slice(pumpStart, pumpEnd);
  assert.match(pumpSource, /getBuyInstructionsBySolAmount/);
  assert.match(pumpSource, /getSellInstructionsByTokenAmount/);
  assert.match(
    pumpSource,
    /sendRawViaRpc\(tx, t0, "pump\.fun", knownSig, input\.beforeSubmit, false, "pump\.fun"\)/,
  );
  assert.doesNotMatch(pumpSource, /sdk\.(buy|sell)\s*\(/);
});

test("raw RPC submission authorizes after serialization and before the network call", () => {
  const sendStart = executorSource.indexOf("async function sendRawViaRpc");
  const sendEnd = executorSource.indexOf("async function waitForLanding", sendStart);
  assert.ok(sendStart >= 0 && sendEnd > sendStart, "raw RPC sender was not found");

  const sendSource = executorSource.slice(sendStart, sendEnd);
  const serializeAt = sendSource.indexOf("tx.serialize()");
  const authorizeAt = sendSource.indexOf("assertSubmissionAuthorized(beforeSubmit)");
  const networkAt = sendSource.indexOf("conn.sendRawTransaction");
  assert.ok(serializeAt >= 0 && serializeAt < authorizeAt);
  assert.ok(authorizeAt < networkAt);
});
