import assert from "node:assert/strict";
import test from "node:test";
import { planFreshTailExit, type FreshTailExitPolicyConfig } from "./fresh-tail-exit-policy.js";
import type { FreshTailExitIntent } from "./fresh-tail-exit-store.js";

const base = {
  directTargetSellMode: "full",
  directTargetSellPct: 25,
  mirrorCustodySellEnabled: true,
  mirrorCustodySellPct: 40,
  terminalOutflowEnabled: true,
  terminalOutflowPct: 60,
  targetTerminalOutflowEnabled: true,
  targetTerminalOutflowPct: 80,
} satisfies FreshTailExitPolicyConfig;

const intent = {
  triggerKind: "direct_target_sell",
  classificationReliable: true,
} as FreshTailExitIntent;

test("fresh-tail policy preserves configured full, fixed, custody, and terminal exits", () => {
  assert.deepEqual(planFreshTailExit(intent, base, true), {
    action: "execute",
    sellPct: 100,
    sellTriggerKind: "direct_target_sell",
    reason: "finalized fresh-tail direct target sell (full)",
  });
  assert.equal(
    planFreshTailExit(
      intent,
      { ...base, directTargetSellMode: "fixed_pct", directTargetSellPct: 33 },
      true,
    ).action,
    "execute",
  );
  assert.deepEqual(
    planFreshTailExit({ ...intent, triggerKind: "mirror_custody_sell" }, base, false),
    {
      action: "execute",
      sellPct: 40,
      sellTriggerKind: "mirror_custody_sell",
      reason: "finalized fresh-tail descendant custody sell",
    },
  );
  const targetTerminal = planFreshTailExit(
    { ...intent, triggerKind: "terminal_outflow" },
    base,
    true,
  );
  const descendantTerminal = planFreshTailExit(
    { ...intent, triggerKind: "terminal_outflow" },
    base,
    false,
  );
  assert.equal(targetTerminal.action, "execute");
  assert.equal(descendantTerminal.action, "execute");
  if (targetTerminal.action !== "execute" || descendantTerminal.action !== "execute") {
    assert.fail("terminal exits unexpectedly failed closed");
  }
  assert.equal(targetTerminal.sellTriggerKind, "target_terminal_outflow");
  assert.equal(descendantTerminal.sellTriggerKind, "terminal_outflow");
});

test("fresh-tail policy fails closed without proportional proof or enabled policy", () => {
  assert.deepEqual(
    planFreshTailExit(intent, { ...base, directTargetSellMode: "proportional" }, true).action,
    "retry",
  );
  assert.equal(
    planFreshTailExit(intent, { ...base, directTargetSellMode: "off" }, true).action,
    "disabled",
  );
  assert.equal(
    planFreshTailExit(
      { ...intent, triggerKind: "mirror_custody_sell" },
      { ...base, mirrorCustodySellEnabled: false },
      false,
    ).action,
    "disabled",
  );
  assert.equal(
    planFreshTailExit({ ...intent, classificationReliable: false }, base, true).action,
    "retry",
  );
});
