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

test("Supply Accumulation enters through the durable regular-position contract", () => {
  const claimOwnership = section(
    "async function beginEntryClaimSubmission",
    "async function claimEntrySubmission",
  );
  assert.match(
    claimOwnership,
    /beginEntryClaimSubmission[\s\S]*\.eq\("status", "claimed"\)[\s\S]*\.is\("bot_tx_sig", null\)[\s\S]*\.is\("submission_started_at", null\)[\s\S]*\.select\("id"\)/,
  );
  assert.match(
    claimOwnership,
    /persistPreparedSupplyEntryClaim[\s\S]*\.eq\("status", "submitted"\)[\s\S]*\.eq\("submission_started_at", submissionStartedAt\)[\s\S]*\.is\("bot_tx_sig", null\)[\s\S]*\.select\("id"\)/,
  );
  const supply = section(
    "async function processSupplyAccumulationTargetBuy",
    "async function classifyTransferRecipients",
  );
  assert.match(supply, /entryStrategy: "supply_accumulation"/);
  assert.match(supply, /entryMode: "regular"/);
  assert.match(supply, /coordinatedWallets: state\.rootWallets/);

  const copy = section("async function tryCopyBuy", 'process.on("unhandledRejection"');
  assert.match(
    copy,
    /claimEntrySubmission\(\s*event,\s*options\.entryMode,\s*amountLamports,\s*buyUsd,\s*expectedStrategy,\s*options\.coordinatedWallets,\s*\)/,
  );
  assert.match(copy, /beginEntryClaimSubmission\(entryClaim\.id, entrySubmissionStartedAt\)/);
  assert.match(
    copy,
    /onPrepared:[\s\S]*persistPreparedSupplyEntryClaim\([\s\S]*entrySubmissionStartedAt/,
  );
  assert.match(copy, /entry_mode: options\.entryMode/);
  assert.match(copy, /monitor\.onCopyBuy/);
  assert.match(
    copy,
    /const linkedTargets = new Set\(\[event\.wallet, \.\.\.\(options\.coordinatedWallets/,
  );
  assert.ok(
    copy.indexOf("const linkedTargets = new Set") < copy.indexOf("await monitor.onCopyBuy"),
    "durable target links must exist before the live monitor exposes the position",
  );
  assert.ok(
    copy.indexOf("await processDurableSupplySells(pos.id") < copy.indexOf('status: "persisted"'),
    "all durable in-flight sells must be handled before the entry claim is finalized",
  );
  assert.match(
    workerSource,
    /await processDurableSupplySells\(position\.id, claim\.token_mint, sourceSlot, false\)/,
  );
  assert.match(workerSource, /!exactDurableRecovery && !isFreshAutomaticAction\(ev, 120_000\)/);
  const recovery = section(
    "async function recoverPreparedSupplyEntryClaim",
    "async function reconcileUnresolvedEntryClaims",
  );
  assert.ok(
    (recovery.match(/solanaRpcWithTimeout\(/g) ?? []).length >= 2,
    "startup claim recovery must bound every Solana RPC read",
  );
  assert.doesNotMatch(recovery, /prepared-transaction-expired-unlanded|getBlockHeight/);
  assert.match(
    recovery,
    /A processed signature proves[\s\S]*every other ambiguous state stays quarantined/,
  );
  assert.match(recovery, /await processDurableSupplySells\([\s\S]*status: "persisted"/);
  const reconciliation = section(
    "async function reconcileUnresolvedEntryClaims",
    "let targetWallets = new Set",
  );
  assert.match(
    reconciliation,
    /claim\.entry_strategy === "supply_accumulation"[\s\S]*!claim\.bot_tx_sig[\s\S]*unsignedAttemptIsStale[\s\S]*claim\.status === "claimed"[\s\S]*claim\.status === "submitted"[\s\S]*status: "failed_pre_submit"[\s\S]*\.eq\("status", claim\.status\)[\s\S]*\.is\("bot_tx_sig", null\)/,
  );
});

test("all established sell paths remain independent of the active entry selector", () => {
  const tpSl = section("async function checkTpSl", "async function checkConfiguredPositionExits");
  for (const exit of [
    "take_profit_enabled",
    "stop_loss_enabled",
    "trailing_stop_enabled",
    "mirror_custody_sell_exit_enabled",
  ]) {
    assert.match(tpSl, new RegExp(`cfg\\.${exit}`));
  }
  assert.doesNotMatch(tpSl, /automaticEntryStrategy\(cfg\)/);
  assert.match(tpSl, /positionPriceUsd\(pos\.id, pos\.token_mint/);
  const priceHelper = section("async function positionPriceUsd", "async function checkTpSl");
  assert.match(
    priceHelper,
    /const indexedPrice = await priceUsd\(tokenMint\);[\s\S]*if \(indexedPrice !== undefined\) return indexedPrice;[\s\S]*isSupplyEntryPosition\(positionId\)/,
  );

  const configured = section(
    "async function checkConfiguredPositionExits",
    "async function executeExitSell",
  );
  assert.match(configured, /cfg\.follower_seller_exit_enabled/);
  assert.match(configured, /cfg\.target_inactivity_exit_enabled/);
  assert.doesNotMatch(configured, /automaticEntryStrategy\(cfg\)/);

  const executor = section("async function executeExitSell", "async function handleTargetBuy");
  assert.match(
    executor,
    /if \(await isSupplyEntryPosition\(positionId\)\)[\s\S]*pumpFunDirectFirst = Boolean/,
  );

  const eventDriven = section(
    "async function handleTargetTerminalOutflows",
    "async function tryCopyBuy",
  );
  for (const exit of [
    "target_terminal_outflow_exit_enabled",
    "terminal_outflow_exit_enabled",
    "direct_target_sell_exit_mode",
    "crew_exit_enabled",
    "proportional_follower_sells",
  ]) {
    assert.match(eventDriven, new RegExp(`cfg\\.${exit}`));
  }
});
