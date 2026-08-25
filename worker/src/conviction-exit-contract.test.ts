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

test("new Conviction positions retain the regular exit policy", () => {
  const executeConviction = section(
    "async function executeConvictionAction",
    "async function handleTargetBuy",
  );
  assert.match(executeConviction, /entry_mode: openPosition\?\.entry_mode \?\? "regular"/);
});

test("TP, SL, configured follower exits, inactivity, and proportional mirroring remain active", () => {
  const tpSl = section("async function checkTpSl", "async function checkConfiguredPositionExits");
  assert.doesNotMatch(tpSl, /entry_mode \?\? "regular"\) === "coordinated"\) continue/);
  assert.match(tpSl, /cfg\.stop_loss_enabled/);
  assert.match(tpSl, /cfg\.take_profit_enabled/);

  const configured = section(
    "async function checkConfiguredPositionExits",
    "async function executeExitSell",
  );
  assert.match(configured, /cfg\.follower_seller_exit_enabled/);
  assert.match(configured, /cfg\.target_inactivity_exit_enabled/);

  const followerSell = section("async function handleFollowerSell", "async function tryCopyBuy");
  assert.match(followerSell, /cfg\.follower_seller_exit_enabled/);
  assert.match(followerSell, /cfg\.proportional_follower_sells/);
});

test("global direct-target and terminal-outflow sell coverage is not tied to entry strategy", () => {
  const targetOutflow = section(
    "async function handleTargetTerminalOutflows",
    "async function maybeExecuteTerminalBatchExit",
  );
  assert.match(targetOutflow, /cfg\.target_terminal_outflow_exit_enabled/);
  assert.doesNotMatch(targetOutflow, /automaticEntryStrategy\(cfg\)/);

  const followerOutflow = section(
    "async function maybeExecuteTerminalBatchExit",
    "async function handleDirectTargetSell",
  );
  assert.match(followerOutflow, /cfg\.terminal_outflow_exit_enabled/);
  assert.doesNotMatch(followerOutflow, /automaticEntryStrategy\(cfg\)/);

  const targetSell = section(
    "async function handleDirectTargetSell",
    "async function handleFollowerSell",
  );
  assert.match(targetSell, /cfg\.direct_target_sell_exit_mode/);
  assert.doesNotMatch(targetSell, /automaticEntryStrategy\(cfg\)/);
});
