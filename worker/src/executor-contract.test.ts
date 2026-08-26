import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const executorSource = readFileSync(new URL("../src/executor.ts", import.meta.url), "utf8");

test("Pump.fun fallback keeps transaction submission behind the caller-owned final gate", () => {
  const pumpStart = executorSource.indexOf("async function executePumpFunSwap");
  const pumpEnd = executorSource.indexOf("async function notifyTransactionPrepared", pumpStart);
  assert.ok(pumpStart >= 0 && pumpEnd > pumpStart, "Pump.fun executor was not found");

  const pumpSource = executorSource.slice(pumpStart, pumpEnd);
  assert.match(pumpSource, /await buildPumpFunDirectSwap\(\{/);
  assert.match(pumpSource, /side: isBuy \? "buy" : "sell"/);
  assert.match(pumpSource, /amountRaw: exactRawAmount\(/);
  assert.match(pumpSource, /const pumpInstructions = direct\.instructions/);
  assert.match(pumpSource, /const receipt = confirmedTokenReceiptFromTx\(/);
  assert.match(pumpSource, /receipt\.decimals !== direct\.decimals/);
  assert.match(pumpSource, /landed buy lacks an exact matching transaction token receipt/);
  assert.match(pumpSource, /outRawAmount = receipt\.amountRaw/);
  assert.match(pumpSource, /outDecimals = receipt\.decimals/);
  assert.doesNotMatch(pumpSource, /getAccount\(/);
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

test("Pump.fun post-submit RPC reads are bounded and never guess from a later wallet snapshot", () => {
  const pumpStart = executorSource.indexOf("async function executePumpFunSwap");
  const pumpEnd = executorSource.indexOf("async function notifyTransactionPrepared", pumpStart);
  const pumpSource = executorSource.slice(pumpStart, pumpEnd);
  assert.match(pumpSource, /await executorRpcWithTimeout\([\s\S]*?getLatestBlockhash/);
  assert.match(pumpSource, /await loadConfirmedPumpTransaction\(knownSig\)/);

  const landingStart = executorSource.indexOf("async function waitForLanding");
  const landingEnd = executorSource.indexOf("async function sendViaJito", landingStart);
  const landingSource = executorSource.slice(landingStart, landingEnd);
  assert.match(landingSource, /await executorRpcWithTimeout\([\s\S]*?getSignatureStatuses/);
  assert.match(executorSource, /await submitKnownSignatureWithTimeout\(\{/);
});

test("owned Pump.fun transactions expose their signed identity before any final gate or send", () => {
  const pumpStart = executorSource.indexOf("async function executePumpFunSwap");
  const pumpEnd = executorSource.indexOf("async function notifyTransactionPrepared", pumpStart);
  assert.ok(pumpStart >= 0 && pumpEnd > pumpStart, "Pump.fun executor was not found");

  const pumpSource = executorSource.slice(pumpStart, pumpEnd);
  assert.match(pumpSource, /const \{ blockhash, lastValidBlockHeight \}/);
  const signAt = pumpSource.indexOf("tx.sign([signer])");
  const signatureAt = pumpSource.indexOf("const knownSig = signedTransactionSignature(tx)");
  const serializationAt = pumpSource.indexOf("createPreparedTransactionNotifier(", signatureAt);
  const preparedAt = pumpSource.indexOf("await ensurePrepared()", serializationAt);
  const sendAt = pumpSource.indexOf("await sendRawViaRpc(");
  assert.ok(signAt >= 0 && signAt < signatureAt);
  assert.ok(signatureAt < serializationAt && serializationAt < preparedAt);
  assert.ok(preparedAt < sendAt);
  assert.match(
    pumpSource,
    /createPreparedTransactionNotifier\([\s\S]*?knownSig,[\s\S]*?lastValidBlockHeight/,
  );

  assert.match(executorSource, /onPrepared\?: \(prepared: PreparedTransaction\)/);
  assert.match(executorSource, /recentBlockhash: string/);
  assert.match(executorSource, /lastValidBlockHeight\?: number/);
});

test("a failed Pump.fun preparation callback cancels every submission route", () => {
  const notifyStart = executorSource.indexOf("async function notifyTransactionPrepared");
  const notifyEnd = executorSource.indexOf("function signedTransactionSignature", notifyStart);
  assert.ok(
    notifyStart >= 0 && notifyEnd > notifyStart,
    "preparation callback helper was not found",
  );

  const notifySource = executorSource.slice(notifyStart, notifyEnd);
  assert.match(notifySource, /await input\.onPrepared\(prepared\)/);
  assert.match(notifySource, /throw new SubmissionCancelledBeforeSendError/);
});

test("all locally signed routes durably publish one exact attempt before their first send", () => {
  const sharedStart = executorSource.indexOf("async function submitSignedSwapTx");
  const sharedEnd = executorSource.indexOf("export async function executeSwap", sharedStart);
  const sharedSource = executorSource.slice(sharedStart, sharedEnd);
  assert.match(sharedSource, /createPreparedTransactionNotifier\(/);
  assert.match(sharedSource, /sendViaJito\([\s\S]*?ensurePrepared/);
  assert.match(sharedSource, /sendRawViaRpc\([\s\S]*?ensurePrepared/);

  const managedStart = executorSource.indexOf("async function executeJupiterManagedV2");
  const managedEnd = executorSource.indexOf("async function executePumpFunSwap", managedStart);
  const managedSource = executorSource.slice(managedStart, managedEnd);
  const preparedAt = managedSource.indexOf("await ensurePrepared()");
  const authorizedAt = managedSource.indexOf("await assertSubmissionAuthorized", preparedAt);
  const executeAt = managedSource.indexOf("await fetch(`${JUPITER_V2_BASE}/execute`", authorizedAt);
  assert.ok(preparedAt >= 0 && preparedAt < authorizedAt && authorizedAt < executeAt);
  assert.match(executorSource, /recentBlockhash: tx\.message\.recentBlockhash/);
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

test("every SOL exit resolves an exact live raw cap before any route is built", () => {
  const swapStart = executorSource.indexOf("export async function executeSwap");
  const swapEnd = executorSource.indexOf("function errorMessage", swapStart);
  assert.ok(swapStart >= 0 && swapEnd > swapStart, "executeSwap router was not found");

  const swapSource = executorSource.slice(swapStart, swapEnd);
  const exitGateAt = swapSource.indexOf("if (input.outputMint === WSOL_MINT)");
  const liveBalanceAt = swapSource.indexOf("await readExactWalletTokenBalance", exitGateAt);
  const capAt = swapSource.indexOf("capExitRawAmount(", liveBalanceAt);
  const exactAssignmentAt = swapSource.indexOf(
    "input = { ...input, amountLamports: amountRaw }",
    capAt,
  );
  const firstRouteAt = swapSource.indexOf("if (input.pumpFunDirectOnly === true)");
  assert.ok(exitGateAt >= 0 && exitGateAt < liveBalanceAt);
  assert.ok(liveBalanceAt < capAt && capAt < exactAssignmentAt);
  assert.ok(exactAssignmentAt < firstRouteAt);
  assert.match(swapSource, /input\.onInputAmountCapped\?\.\(\{/);
  assert.match(executorSource, /amountLamports: number \| string \| bigint/);
  assert.doesNotMatch(executorSource, /fullBalanceExit/);
});

test("raw RPC submission authorizes after serialization and before the network call", () => {
  const sendStart = executorSource.indexOf("async function sendRawViaRpc");
  const sendEnd = executorSource.indexOf("async function waitForLanding", sendStart);
  assert.ok(sendStart >= 0 && sendEnd > sendStart, "raw RPC sender was not found");

  const sendSource = executorSource.slice(sendStart, sendEnd);
  const serializeAt = sendSource.indexOf("tx.serialize()");
  const preparedAt = sendSource.indexOf("ensurePrepared?.()");
  const authorizeAt = sendSource.indexOf("assertSubmissionAuthorized(beforeSubmit)");
  const networkAt = sendSource.indexOf("conn.sendRawTransaction");
  assert.ok(serializeAt >= 0 && serializeAt < preparedAt && preparedAt < authorizeAt);
  assert.ok(authorizeAt < networkAt);
});
