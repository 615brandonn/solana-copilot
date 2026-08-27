import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SUPPLY_SCALE_ACTION_DEADLINE_MS } from "./supply-accumulation-scale-policy.js";

const workerSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const scaleStoreSource = readFileSync(
  new URL("../src/supply-accumulation-scale-store.ts", import.meta.url),
  "utf8",
);

function section(startMarker: string, endMarker: string): string {
  const start = workerSource.indexOf(startMarker);
  const end = workerSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `worker section ${startMarker} was not found`);
  return workerSource.slice(start, end);
}

function nestedFunctionContaining(needle: string): string {
  return nestedFunctionsContaining(needle)[0];
}

function nestedFunctionsContaining(needle: string): string[] {
  const functions = new Map<number, string>();
  for (const occurrence of occurrences(workerSource, needle)) {
    const start = workerSource.lastIndexOf("\n  async function ", occurrence);
    assert.ok(start >= 0, `${needle} is not owned by a named runtime function`);
    const end = workerSource.indexOf("\n  async function ", occurrence + needle.length);
    functions.set(start, workerSource.slice(start + 1, end >= 0 ? end : workerSource.length));
  }
  assert.ok(functions.size > 0, `worker runtime does not contain ${needle}`);
  return [...functions.values()];
}

function functionName(source: string): string {
  const match = /^\s*async function ([A-Za-z0-9_]+)\s*\(/.exec(source);
  assert.ok(match, "runtime function name was not found");
  return match[1];
}

function occurrences(source: string, needle: string): number[] {
  const positions: number[] = [];
  for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + needle.length)) {
    positions.push(at);
  }
  return positions;
}

test("Supply initial and scale actions share one sub-60-second source deadline", () => {
  assert.ok(SUPPLY_SCALE_ACTION_DEADLINE_MS > 0);
  assert.ok(
    SUPPLY_SCALE_ACTION_DEADLINE_MS < 60_000,
    "Supply actions must become observation-only before 60 seconds",
  );

  const processSupply = section(
    "async function processSupplyAccumulationTargetBuy",
    "async function classifyTransferRecipients",
  );
  assert.match(processSupply, /isFreshAutomaticAction\(event, SUPPLY_SCALE_ACTION_DEADLINE_MS\)/);

  const validation = section(
    "async function validateSupplyAccumulationSubmission",
    "async function processSupplyAccumulationTargetBuy",
  );
  assert.ok(
    (validation.match(/confirmedSourceIsFresh\(source, SUPPLY_SCALE_ACTION_DEADLINE_MS\)/g) ?? [])
      .length >= 2,
    "the common initial/scale authorization must check chain time both before and after awaits",
  );

  const scale = nestedFunctionContaining("supplyAccumulationScaleStore.claimBuy(");
  assert.match(scale, /validateSupplyScaleSubmission\(/);
  assert.match(scale, /SUPPLY_SCALE_ACTION_DEADLINE_MS/);
});

test("the $20,000 ceiling never substitutes for active pre-graduation curve proof", () => {
  const curveViews = section(
    "async function loadSupplyCurveViews",
    "async function loadCanonicalSupplyEvidence",
  );
  assert.match(curveViews, /commitment: "confirmed"[\s\S]*?minContextSlot: event\.slot/);
  assert.match(curveViews, /commitment: "processed"[\s\S]*?minContextSlot: event\.slot/);
  assert.match(
    curveViews,
    /confirmedCurve\.complete\s*\|\|\s*processedCurve\.complete/,
    "a completed confirmed or processed curve must fail closed",
  );

  const initialValidation = section(
    "async function validateSupplyAccumulationSubmission",
    "async function processSupplyAccumulationTargetBuy",
  );
  const scaleValidation = section(
    "async function validateSupplyScaleSubmission",
    "function preparedSupplyScaleAttempt",
  );
  for (const validation of [initialValidation, scaleValidation]) {
    assert.match(validation, /const configuredCap = Math\.min\(20_000,/);
    assert.match(
      validation,
      /strictestPumpFunMarketCaps\(\s*\[curves\.confirmedCurve, curves\.processedCurve\]/,
    );
    assert.match(validation, /!caps\?\.belowCap/);
  }
});

test("an existing Supply position scales while the legacy no-position path is observation-only", () => {
  const processSupply = section(
    "async function processSupplyAccumulationTargetBuy",
    "async function classifyTransferRecipients",
  );
  const positionLookup = processSupply.indexOf('.from("positions")');
  const provenanceCheck = processSupply.indexOf("isSupplyEntryPosition(", positionLookup);
  const scaleCall = processSupply.indexOf("executeSupplyScaleInLocked", provenanceCheck);
  const observationOnly = processSupply.indexOf(
    "legacy Supply observation stored; finalized fresh-tail candidate poll owns initial entries",
    scaleCall,
  );

  assert.ok(positionLookup >= 0, "Supply routing must read the existing open position first");
  assert.match(
    processSupply.slice(positionLookup),
    /\.eq\("token_mint", event\.tokenMint\)[\s\S]*?\.is\("closed_at", null\)/,
  );
  assert.ok(
    provenanceCheck > positionLookup,
    "only a position created by Supply Accumulation may use its scale path",
  );
  assert.ok(scaleCall > provenanceCheck, "the existing Supply position must enter the scale path");
  assert.ok(
    observationOnly > scaleCall,
    "the no-position branch must become observation-only after the scale branch",
  );
  assert.match(
    processSupply.slice(scaleCall, observationOnly),
    /return;/,
    "an existing position must return before the observation-only no-position branch",
  );
  assert.equal(
    occurrences(processSupply, "await tryCopyBuyLocked(").length,
    0,
    "legacy Supply must never retain a fallback initial-position entry call",
  );
});

test("exact custody-trigger lag is retried briefly without holding the observation lane", () => {
  const waitForCustody = section(
    "async function waitForSupplyCustodyTrigger",
    "async function processSupplyAccumulationTargetBuy",
  );
  assert.match(waitForCustody, /Date\.now\(\) \+ 10_000/);
  assert.match(waitForCustody, /SUPPLY_SCALE_ACTION_DEADLINE_MS/);
  assert.match(
    waitForCustody,
    /gate\.safe \|\| gate\.reason !== "trigger_buy_not_verified"/,
    "only an exact trigger that the independent custody observer has not published yet may retry",
  );
  assert.match(waitForCustody, /isFreshAutomaticAction\(event, SUPPLY_SCALE_ACTION_DEADLINE_MS\)/);
  assert.doesNotMatch(
    waitForCustody,
    /supplyObservationQueue\.run/,
    "waiting on another process must not block same-mint sell evidence",
  );

  const processSupply = section(
    "async function processSupplyAccumulationTargetBuy",
    "async function classifyTransferRecipients",
  );
  const custodyAt = processSupply.indexOf("await waitForSupplyCustodyTrigger(event, state)");
  const tradeAt = processSupply.indexOf("await tradeExecutionQueue.run(");
  assert.ok(
    custodyAt >= 0 && tradeAt > custodyAt,
    "custody synchronization must precede claim/send",
  );
});

test("scale submission owns an exact durable plan at prepare and final authorization boundaries", () => {
  const scale = nestedFunctionContaining("supplyAccumulationScaleStore.claimBuy(");
  const claimAt = scale.indexOf("supplyAccumulationScaleStore.claimBuy(");
  const executeAt = scale.indexOf("await executeSwap(", claimAt);
  const preparedAt = scale.indexOf("onPrepared:", executeAt);
  const beforeSubmitAt = scale.indexOf("beforeSubmit:", preparedAt);
  assert.ok(
    claimAt >= 0 && executeAt > claimAt && preparedAt > executeAt && beforeSubmitAt > preparedAt,
  );
  assert.match(
    scale.slice(claimAt, executeAt),
    /claimed\.claim\?\.status === "claimed" && \(claimed\.claimed \|\| claimed\.replay\)/,
    "an exact lost-response replay may resume only the still-unsigned claimed row",
  );

  const exactAmount = /const ([A-Za-z0-9_]+) = Number\(BigInt\(claim\.amountLamports\)\)/.exec(
    scale,
  );
  assert.ok(exactAmount, "the executor amount must come from the exact claimed lamport plan");
  const exactAmountName = exactAmount[1];
  const escapedAmountName = exactAmountName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(
    scale,
    new RegExp(`await executeSwap\\([\\s\\S]*?amountLamports(?:,|:\\s*${escapedAmountName})`),
  );
  assert.match(
    scale,
    new RegExp(
      `validateSupplyScaleSubmission\\([\\s\\S]*?${escapedAmountName},[\\s\\S]*?claim\\.id`,
    ),
  );
  assert.match(
    scale.slice(claimAt, executeAt),
    /claim\.tierNumber\s*!==\s*initialValidation\.plan\.tierNumber/,
  );
  assert.match(
    scale.slice(claimAt, executeAt),
    /claim\.plannedBuyUsd\s*!==\s*initialValidation\.plan\.buyUsd/,
  );
  assert.match(
    scale.slice(claimAt, executeAt),
    /claim\.configFingerprint\s*!==\s*initialValidation\.plan\.configFingerprint/,
    "the durable claim must still be the exact plan whose lamport amount was calculated",
  );
  assert.match(
    scale.slice(preparedAt, beforeSubmitAt),
    /supplyAccumulationScaleStore\.beginSubmission\(/,
  );
  const beginSubmission = scaleStoreSource.slice(
    scaleStoreSource.indexOf("  async beginSubmission("),
    scaleStoreSource.indexOf("  async persistPrepared("),
  );
  assert.match(
    beginSubmission,
    /\.update\(\{[\s\S]*?status: "submitted"[\s\S]*?bot_tx_sig:[\s\S]*?last_valid_block_height:[\s\S]*?submission_started_at:/,
  );
  assert.match(
    beginSubmission,
    /\.eq\("id", claimId\)[\s\S]*?\.eq\("user_id", this\.userId\)[\s\S]*?\.eq\("status", "claimed"\)[\s\S]*?\.is\("bot_tx_sig", null\)[\s\S]*?\.is\("submission_started_at", null\)/,
    "onPrepared's store method must CAS the exact unsigned claimed row",
  );

  const beforeSubmit = scale.slice(beforeSubmitAt);
  assert.match(
    beforeSubmit,
    /validateSupplyScaleSubmission\([\s\S]*?claim\.id/,
    "beforeSubmit must reload the exact durable claim plan",
  );
  assert.match(
    beforeSubmit,
    /finalValidation\.plan\.configFingerprint\s*===\s*claim\.configFingerprint/,
  );
  assert.match(beforeSubmit, /finalValidation\.plan\.buyUsd\s*===\s*claim\.plannedBuyUsd/);

  const validation = section(
    "async function validateSupplyScaleSubmission",
    "function preparedSupplyScaleAttempt",
  );
  assert.match(
    validation,
    /supplyAccumulationScaleStore\.getPlan\([\s\S]*?claimId/,
    "the final validator must reload the exact claim-bound plan",
  );
  assert.match(validation, /loadSupplyCurveViews\(event\)/);
  assert.match(
    validation,
    /strictestPumpFunMarketCaps\(\s*\[curves\.confirmedCurve, curves\.processedCurve\]/,
    "both confirmed and processed curve views must enforce current and projected caps",
  );
  assert.match(validation, /!caps\?\.belowCap/);
  assert.match(validation, /caps\.currentMarketCapUsd < configuredFloor/);
});

test("exact landing receipt is atomically applied without re-registering monitoring", () => {
  const scale = nestedFunctionContaining("supplyAccumulationScaleStore.claimBuy(");
  const applyPaths = nestedFunctionsContaining("supplyAccumulationScaleStore.applyBuy(");
  const combinedScalePath = `${scale}\n${applyPaths.join("\n")}`;
  const receiptHelper = section(
    "async function exactSupplyScaleReceipt",
    "async function executeSupplyScaleInLocked",
  );

  assert.match(combinedScalePath, /exactSupplyScaleReceipt\(/);
  assert.match(receiptHelper, /confirmedTokenReceiptFromTx\(/);
  assert.match(combinedScalePath, /receipt\.amountRaw/);
  assert.match(
    combinedScalePath,
    /supplyAccumulationScaleStore\.markLanded\([\s\S]*?receipt\.amountRaw/,
  );
  assert.match(
    combinedScalePath,
    /supplyAccumulationScaleStore\.applyBuy\([\s\S]*?receipt\.amountRaw/,
    "the atomic accounting RPC must consume the exact confirmed raw receipt",
  );
  for (const applyPath of applyPaths) {
    assert.doesNotMatch(
      applyPath,
      /monitor\.onCopyBuy/,
      "scaling an existing position must never reset or duplicate its monitor registration",
    );
    const applyAt = applyPath.lastIndexOf("supplyAccumulationScaleStore.applyBuy(");
    const repairAt = applyPath.indexOf("completeSupplyScalePostApplyRepair(", applyAt);
    assert.ok(repairAt > applyAt, "every atomic apply path must enter durable post-apply repair");
  }
  const repair = nestedFunctionContaining("supplyAccumulationScaleStore.markPostApplyRepaired(");
  assert.match(repair, /supplyObservationQueue\.run\(repair\.tokenMint/);
  assert.match(
    repair,
    /positionPriceSanity\.delete\(/,
    "blended entry accounting must invalidate price-sanity state",
  );
  assert.match(
    repair,
    /positionPeakPrice\.delete\(/,
    "blended entry accounting must invalidate trailing peak state",
  );

  const handler = section(
    "async function handle(event: FeedEvent)",
    "async function observeTargetFirstBuy",
  );
  const sellBranch = handler.slice(handler.indexOf('if (event.side === "sell")'));
  const geyserSellPath = sellBranch.slice(0, sellBranch.indexOf("await handleFollowerSell(event)"));
  assert.match(geyserSellPath, /void supplyObservationQueue[\s\S]*?\.run\(event\.tokenMint/);
  assert.doesNotMatch(
    geyserSellPath,
    /scheduleSupplyBackground\(/,
    "a seen Geyser sell must register its mint tail immediately before any bounded outer queue",
  );
});

test("unresolved scale claims reconcile before feeds and on a periodic loop", () => {
  const reconciliation = nestedFunctionContaining(
    "supplyAccumulationScaleStore.loadUnresolvedClaims(",
  );
  const reconcileName = functionName(reconciliation);
  assert.match(reconciliation, /for \(const claim of claims\)/);
  assert.match(reconciliation, /claim\.status === "submitted"|claim\.status === "uncertain"/);
  assert.match(
    reconciliation,
    /status\?\.err && status\.confirmationStatus === "finalized"/,
    "only finalized on-chain failure may release a signed scale attempt",
  );
  assert.match(
    reconciliation,
    /scale-transaction-failure-not-yet-finalized/,
    "processed or confirmed failures must remain quarantined against fork changes",
  );
  assert.match(reconciliation, /rpc\.getBlockHeight\("finalized"\)/);
  assert.match(
    reconciliation,
    /prepared-scale-signature-expired-without-chain-record/,
    "a signed attempt may release only after finalized expiry and an exact missing history record",
  );
  assert.match(
    reconciliation,
    /getSignatureStatuses\(\[attempt\.botTxSig\],[\s\S]*?searchTransactionHistory:\s*true[\s\S]*?getBlockHeight\("finalized"\)[\s\S]*?getSignatureStatuses\(\[attempt\.botTxSig\],[\s\S]*?searchTransactionHistory:\s*true/,
    "expiry release must recheck full signature history after finalized block height passes",
  );
  assert.match(reconciliation, /applyRecoveredSupplyScaleClaim\(claim\)/);
  const recoveredApply = nestedFunctionContaining("async function applyRecoveredSupplyScaleClaim");
  assert.match(recoveredApply, /exactSupplyScaleReceipt\(/);
  assert.match(recoveredApply, /supplyAccumulationScaleStore\.applyBuy\(/);
  assert.doesNotMatch(reconciliation, /monitor\.onCopyBuy/);
  assert.match(reconciliation, /supplyAccumulationScaleStore\.loadPendingPostApplyRepairs\(\)/);
  assert.match(reconciliation, /completeSupplyScalePostApplyRepair\(/);

  const postApplyRepair = nestedFunctionContaining(
    "supplyAccumulationScaleStore.markPostApplyRepaired(",
  );
  const durableSellAt = postApplyRepair.indexOf("processDurableSupplySells(");
  const repairedAt = postApplyRepair.indexOf("supplyAccumulationScaleStore.markPostApplyRepaired(");
  assert.ok(
    durableSellAt >= 0 && repairedAt > durableSellAt,
    "the durable repair checkpoint must be written only after post-scale sells are replayed",
  );

  const declarationAt = workerSource.indexOf(`async function ${reconcileName}`);
  const monitorHydrationAt = workerSource.indexOf("await monitor.reconcileFollowersFromDatabase()");
  const pollerStartAt = workerSource.indexOf("poller.start(");
  const feedStartAt = workerSource.indexOf("feed.start(");
  const calls = occurrences(workerSource, `${reconcileName}(`).filter((at) => at !== declarationAt);
  assert.ok(
    calls.some((at) => at > monitorHydrationAt && at < pollerStartAt && at < feedStartAt),
    "scale claims must reconcile after the original position monitor is restored but before feeds start",
  );

  const escapedName = reconcileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(
    workerSource,
    new RegExp(
      `setInterval\\(\\(\\) => \\{[\\s\\S]{0,600}${escapedName}\\(\\)\\.catch[\\s\\S]{0,300}\\},\\s*(?:30_000|60_000)\\)`,
    ),
    "unresolved scale recovery must also run every 30–60 seconds",
  );
});
