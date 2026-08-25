import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const executorSource = readFileSync(new URL("../src/executor.ts", import.meta.url), "utf8");

test("Pump.fun fallback keeps transaction submission behind the caller-owned final gate", () => {
  const pumpStart = executorSource.indexOf("async function executePumpFunSwap");
  const pumpEnd = executorSource.indexOf("async function notifyPumpTransactionPrepared", pumpStart);
  assert.ok(pumpStart >= 0 && pumpEnd > pumpStart, "Pump.fun executor was not found");

  const pumpSource = executorSource.slice(pumpStart, pumpEnd);
  assert.match(pumpSource, /getBuyInstructionsBySolAmount/);
  assert.match(pumpSource, /getSellInstructionsByTokenAmount/);
  assert.match(
    pumpSource,
    /sendRawViaRpc\([\s\S]*?"pump\.fun",[\s\S]*?knownSig,[\s\S]*?input\.beforeSubmit,[\s\S]*?false,[\s\S]*?"pump\.fun",[\s\S]*?serialized,[\s\S]*?\)/,
  );
  assert.doesNotMatch(pumpSource, /sdk\.(buy|sell)\s*\(/);
});

test("curve-proven supply entries can bypass slower aggregators without changing exits", () => {
  assert.match(
    executorSource,
    /if \(input\.pumpFunDirectOnly === true\) \{\s*return executePumpFunSwap\(input, signer, t0\);\s*\}/,
  );
  assert.match(executorSource, /pumpFunDirectOnly\?: boolean/);
});

test("owned Pump.fun transactions expose their signed identity before any final gate or send", () => {
  const pumpStart = executorSource.indexOf("async function executePumpFunSwap");
  const pumpEnd = executorSource.indexOf("async function notifyPumpTransactionPrepared", pumpStart);
  assert.ok(pumpStart >= 0 && pumpEnd > pumpStart, "Pump.fun executor was not found");

  const pumpSource = executorSource.slice(pumpStart, pumpEnd);
  assert.match(pumpSource, /const \{ blockhash, lastValidBlockHeight \}/);
  const signAt = pumpSource.indexOf("tx.sign([signer])");
  const signatureAt = pumpSource.indexOf("const knownSig = signedTransactionSignature(tx)");
  const serializationAt = pumpSource.indexOf("const serialized = tx.serialize()", signatureAt);
  const preparedAt = pumpSource.indexOf("await notifyPumpTransactionPrepared(input");
  const sendAt = pumpSource.indexOf("await sendRawViaRpc(");
  assert.ok(signAt >= 0 && signAt < signatureAt);
  assert.ok(signatureAt < serializationAt && serializationAt < preparedAt);
  assert.ok(preparedAt < sendAt);
  assert.match(pumpSource, /txSig: knownSig,\s*lastValidBlockHeight,/);

  assert.match(executorSource, /onPrepared\?: \(prepared: \{/);
  assert.match(executorSource, /txSig: string;\s*lastValidBlockHeight: number\s*}/);
});

test("a failed Pump.fun preparation callback cancels every submission route", () => {
  const notifyStart = executorSource.indexOf("async function notifyPumpTransactionPrepared");
  const notifyEnd = executorSource.indexOf("function tokenBalanceUi", notifyStart);
  assert.ok(
    notifyStart >= 0 && notifyEnd > notifyStart,
    "preparation callback helper was not found",
  );

  const notifySource = executorSource.slice(notifyStart, notifyEnd);
  assert.match(notifySource, /await input\.onPrepared\(prepared\)/);
  assert.match(notifySource, /throw new SubmissionCancelledBeforeSendError/);
});

test("direct-first Pump.fun exits fall back only after a recoverable pre-submit failure", () => {
  const swapStart = executorSource.indexOf("export async function executeSwap");
  const swapEnd = executorSource.indexOf("function errorMessage", swapStart);
  assert.ok(swapStart >= 0 && swapEnd > swapStart, "executeSwap router was not found");

  const swapSource = executorSource.slice(swapStart, swapEnd);
  assert.match(swapSource, /input\.pumpFunDirectFirst === true && input\.outputMint !== WSOL_MINT/);
  const directFirstAt = swapSource.indexOf("if (pumpFunDirectFirst)");
  const dflowAt = swapSource.indexOf("if (env.DFLOW_ENABLED)");
  assert.ok(directFirstAt >= 0 && directFirstAt < dflowAt);
  assert.match(
    swapSource,
    /if \(!mayTryAlternateExecution\(err\)\) \{[\s\S]*?alternate routes blocked[\s\S]*?throw err;/,
  );
  assert.match(
    swapSource,
    /Pump\.fun direct-first exit failed before submission — falling back to aggregators/,
  );

  const finalPumpAt = swapSource.lastIndexOf("return await executePumpFunSwap(input, signer, t0)");
  const noRetryAt = swapSource.lastIndexOf("if (pumpFunDirectFirst)");
  assert.ok(noRetryAt > dflowAt && noRetryAt < finalPumpAt);
  assert.match(executorSource, /pumpFunDirectFirst\?: boolean/);
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
