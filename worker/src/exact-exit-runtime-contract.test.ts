import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workerSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

function section(startMarker: string, endMarker: string): string {
  const start = workerSource.indexOf(startMarker);
  const end = workerSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `worker section ${startMarker} was not found`);
  return workerSource.slice(start, end);
}

test("claimed exits preserve exact raw sizing and persist the executor-capped amount", () => {
  const executeExit = section(
    "async function executeExitSell",
    "async function executeClaimedPercentageExit",
  );
  assert.match(executeExit, /sellRaw: bigint/);
  assert.match(executeExit, /inputDecimals: decimals/);
  assert.match(executeExit, /onInputAmountCapped:/);
  assert.match(executeExit, /executedSellAmountRaw: executedSellRaw\.toString\(\)/);
  assert.match(executeExit, /if \(!onLanded\)[\s\S]*const persisted = await onLanded\(/);
  assert.doesNotMatch(executeExit, /\.from\("positions"\)[\s\S]*\.update\(/);

  const claimedExit = section(
    "async function executeClaimedPercentageExit",
    "const supplyBuyBackground",
  );
  assert.match(claimedExit, /currentPosition\.amount_remaining_raw/);
  assert.match(claimedExit, /const positionRaw = BigInt\(currentPositionRawText\)/);
  assert.match(
    claimedExit,
    /sellRaw = uiAmountToRawFloor\(requestedSellAmount, currentDecimals\)/,
  );
  assert.match(claimedExit, /sellRaw = \(positionRaw \* BigInt\(scaledPct\)\) \/ 100_000_000n/);
  assert.match(claimedExit, /sellRaw,[\s\S]*currentDecimals,[\s\S]*reason/);
  assert.match(claimedExit, /sellClaimRecoveryStore\.apply\(/);
  assert.doesNotMatch(claimedExit, /Math\.floor\([^\n]*Math\.pow/);
});

test("only explicit pre-submit failures retry and stale landing identity is cleared", () => {
  const claimedExit = section(
    "async function executeClaimedPercentageExit",
    "const supplyBuyBackground",
  );
  assert.match(claimedExit, /select\("id,status,error_code,bot_tx_sig,landed_at"\)/);
  assert.match(
    claimedExit,
    /status: "claimed",[\s\S]*?error_code: `retrying failed_pre_submit; prior error: \$\{priorFailure\}`,[\s\S]*?bot_tx_sig: null,[\s\S]*?landed_at: null/,
  );
  assert.match(claimedExit, /\.eq\("status", "failed_pre_submit"\)/);
  assert.match(claimedExit, /retrying proven pre-submit sell failure/);
});

test("uncertain and merely claimed sells stay quarantined for manual reconciliation", () => {
  assert.doesNotMatch(workerSource, /recoverStrandedSellClaims/);
  assert.doesNotMatch(workerSource, /stranded sell claim reopened/);
});
