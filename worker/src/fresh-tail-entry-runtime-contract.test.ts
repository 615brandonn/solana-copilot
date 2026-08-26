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

function occurrences(source: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + needle.length)) {
    found.push(at);
  }
  return found;
}

test("fresh-tail polling is entry-enabled, non-overlapping, and serialized by mint", () => {
  const startup = section("let freshTailEntryPollRunning", "const runFollowerBalanceReconciliation");
  assert.match(startup, /!cfg\.enabled/);
  assert.match(startup, /automaticEntryStrategy\(cfg\) !== "supply_accumulation"/);
  assert.match(startup, /freshTailEntryStore\.loadCandidates\(25\)/);
  assert.match(startup, /setInterval\(\(\) => void pollFreshTailEntries\(\), 250\)/);
  assert.ok(
    startup.indexOf("freshTailEntryPollRunning = true") <
      startup.indexOf("freshTailEntryStore.loadCandidates"),
  );
  assert.ok(
    startup.lastIndexOf("freshTailEntryPollRunning = false") >
      startup.indexOf("freshTailEntryStore.loadCandidates"),
  );

  const candidate = section(
    "async function processFreshTailEntryCandidate",
    "function convictionEventIdentity",
  );
  assert.match(candidate, /tradeExecutionQueue\.run\(candidate\.tokenMint/);
  assert.match(candidate, /await tryCopyBuyLocked\(/);
  assert.match(candidate, /freshTailCandidate: candidate/);
  assert.doesNotMatch(candidate, /executeSupplyScaleInLocked|supplyAccumulationScaleStore/);
});

test("both preclaim and prepared-claim gates require a fresh certificate and dual active curves", () => {
  const validation = section(
    "async function validateFreshTailEntrySubmission",
    "type SupplyScaleSubmissionValidation",
  );
  const initialRecheckAt = validation.indexOf("freshTailEntryStore.recheck(candidate, claimId)");
  const priceAt = validation.indexOf("await priceUsd(WSOL)");
  const curvesAt = validation.indexOf("await loadFreshTailCurveViews(rechecked)");
  const finalRecheckAt = validation.indexOf(
    "freshTailEntryStore.recheck(rechecked, claimId)",
    curvesAt,
  );
  const synchronousCapsAt = validation.indexOf("const maxSpendLamports", finalRecheckAt);
  assert.ok(
    initialRecheckAt >= 0 &&
      priceAt > initialRecheckAt &&
      curvesAt > priceAt &&
      finalRecheckAt > curvesAt &&
      synchronousCapsAt > finalRecheckAt,
  );
  assert.equal(
    occurrences(validation.slice(finalRecheckAt), "await ").length,
    0,
    "no await may follow the final certificate recheck before authorization",
  );
  assert.match(validation, /freshTailCandidateIsUsable\(rechecked\)/);
  assert.match(validation, /isFreshAutomaticAction\(event, SUPPLY_SCALE_ACTION_DEADLINE_MS\)/);
  assert.match(validation, /const configuredCap = Math\.min\(20_000,/);
  assert.match(validation, /strictestPumpFunMarketCaps\(/);
  assert.match(validation, /!caps\?\.belowCap/);

  const curveViews = section("async function loadFreshTailCurveViews", "async function loadSupplyCurveViews");
  assert.match(
    curveViews,
    /commitment: "confirmed"[\s\S]*minContextSlot: candidate\.requestedHeadSlot/,
  );
  assert.match(
    curveViews,
    /commitment: "processed"[\s\S]*minContextSlot: candidate\.requestedHeadSlot/,
  );
  assert.match(curveViews, /freshTailCurveMatchesCandidate\(confirmedCurve, candidate\)/);
  assert.match(curveViews, /freshTailCurveMatchesCandidate\(processedCurve, candidate\)/);
});

test("fresh claim is armed before submission and final authorization owns the submitted claim", () => {
  const copy = section("async function tryCopyBuyLocked", 'process.on("unhandledRejection"');
  const claimAt = copy.indexOf("const entryClaim = await claimEntrySubmission(");
  const bindAt = copy.indexOf("await freshTailEntryStore.bindClaim(", claimAt);
  const beginAt = copy.indexOf("await beginEntryClaimSubmission(", bindAt);
  const executeAt = copy.indexOf("result = await executeSwap(", beginAt);
  const preparedAt = copy.indexOf("await persistPreparedSupplyEntryClaim(", executeAt);
  const finalGateAt = copy.indexOf("await validateFreshTailEntrySubmission(", preparedAt);
  const claimIdentityAt = copy.indexOf("entryClaim.id", finalGateAt);
  assert.ok(
    claimAt >= 0 &&
      bindAt > claimAt &&
      beginAt > bindAt &&
      executeAt > beginAt &&
      preparedAt > executeAt &&
      finalGateAt > preparedAt &&
      claimIdentityAt > finalGateAt,
  );
  assert.match(
    copy.slice(bindAt, beginAt),
    /FreshTailClaimBindingRejectedError[\s\S]*status: "failed_pre_submit"[\s\S]*throw err/,
  );
});

test("fresh landing and recovery use the exact frozen receipt before numeric ledgers", () => {
  const copy = section("async function tryCopyBuyLocked", 'process.on("unhandledRejection"');
  const exactRequiredAt = copy.indexOf('typeof result.outRawAmount !== "string"');
  const receiptAt = copy.indexOf("freshTailEntryStore.recordReceipt(", exactRequiredAt);
  const stringAt = copy.indexOf("rawAmountToUiString(", receiptAt);
  const positionAt = copy.indexOf('.from("positions")', stringAt);
  const tradeAt = copy.indexOf('.from("trades")', positionAt);
  assert.ok(
    exactRequiredAt >= 0 &&
      receiptAt > exactRequiredAt &&
      stringAt > receiptAt &&
      positionAt > stringAt &&
      tradeAt > positionAt,
  );
  assert.match(copy.slice(positionAt, tradeAt), /amount_tokens: receivedAmountForLedger/);
  assert.match(copy.slice(tradeAt), /amount_tokens: receivedAmountForLedger/);

  const recovery = section(
    "async function recoverPreparedSupplyEntryClaim",
    "async function reconcileUnresolvedEntryClaims",
  );
  const storedRawAt = recovery.indexOf("claim.received_amount_raw");
  const exactChainAt = recovery.indexOf("receipt.amountRaw");
  const recoveryRpcAt = recovery.indexOf("freshTailEntryStore.recordBoundReceipt(");
  const recoveryStringAt = recovery.indexOf("rawAmountToUiString(", recoveryRpcAt);
  assert.ok(
    storedRawAt >= 0 && exactChainAt > storedRawAt && recoveryRpcAt > exactChainAt && recoveryStringAt > recoveryRpcAt,
  );
  assert.match(recovery, /amount_tokens: receivedAmountForLedger/);
  assert.match(recovery, /amount_remaining: receivedAmountForLedger/);
});

test("legacy Supply initial, scale, and exit routes remain present", () => {
  const supply = section(
    "async function processSupplyAccumulationTargetBuy",
    "async function classifyTransferRecipients",
  );
  assert.match(supply, /executeSupplyScaleInLocked/);
  assert.match(supply, /await tryCopyBuyLocked/);
  const copy = section("async function tryCopyBuyLocked", 'process.on("unhandledRejection"');
  assert.match(copy, /validateSupplyAccumulationSubmission\(/);
  assert.match(copy, /processDurableSupplySells\(/);
  assert.match(workerSource, /async function executeExitSell/);
});
