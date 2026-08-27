import type { FreshTailExitIntent } from "./fresh-tail-exit-store.js";
import type { SellTriggerKind } from "./sell-claim-policy.js";

export type FreshTailExitPolicyConfig = {
  directTargetSellMode: "off" | "proportional" | "fixed_pct" | "full";
  directTargetSellPct: number;
  mirrorCustodySellEnabled: boolean;
  mirrorCustodySellPct: number;
  terminalOutflowEnabled: boolean;
  terminalOutflowPct: number;
  targetTerminalOutflowEnabled: boolean;
  targetTerminalOutflowPct: number;
};

export type FreshTailExitPlan =
  | {
      action: "execute";
      sellPct: number;
      sellTriggerKind: SellTriggerKind;
      reason: string;
    }
  | {
      action: "retry" | "disabled";
      reason: string;
    };

function validPct(value: number): number | null {
  return Number.isFinite(value) && value > 0 && value <= 100 ? value : null;
}

/**
 * Maps finalized fresh-tail evidence onto the existing user-configured exit
 * policy. Proportional target selling deliberately stays closed because the
 * durable fresh-tail event records the exact sold amount but not the target's
 * exact pre-sale balance needed to prove a fraction.
 */
export function planFreshTailExit(
  intent: FreshTailExitIntent,
  cfg: FreshTailExitPolicyConfig,
  sourceIsLinkedRoot: boolean,
): FreshTailExitPlan {
  if (!intent.classificationReliable) {
    return { action: "retry", reason: "fresh-tail exit classification is not reliable" };
  }
  switch (intent.triggerKind) {
    case "direct_target_sell": {
      if (cfg.directTargetSellMode === "off") {
        return { action: "disabled", reason: "direct target sell response is disabled" };
      }
      if (cfg.directTargetSellMode === "proportional") {
        return {
          action: "retry",
          reason: "proportional target exit lacks an exact durable pre-sale balance",
        };
      }
      const sellPct = cfg.directTargetSellMode === "full" ? 100 : validPct(cfg.directTargetSellPct);
      if (sellPct === null) {
        return { action: "retry", reason: "direct target sell percentage is invalid" };
      }
      return {
        action: "execute",
        sellPct,
        sellTriggerKind: "direct_target_sell",
        reason: `finalized fresh-tail direct target sell (${cfg.directTargetSellMode})`,
      };
    }
    case "mirror_custody_sell": {
      if (!cfg.mirrorCustodySellEnabled) {
        return { action: "disabled", reason: "custody sell response is disabled" };
      }
      const sellPct = validPct(cfg.mirrorCustodySellPct);
      if (sellPct === null) {
        return { action: "retry", reason: "custody sell percentage is invalid" };
      }
      return {
        action: "execute",
        sellPct,
        sellTriggerKind: "mirror_custody_sell",
        reason: "finalized fresh-tail descendant custody sell",
      };
    }
    case "terminal_outflow": {
      const enabled = sourceIsLinkedRoot
        ? cfg.targetTerminalOutflowEnabled
        : cfg.terminalOutflowEnabled;
      if (!enabled) {
        return { action: "disabled", reason: "terminal custody response is disabled" };
      }
      const sellPct = validPct(
        sourceIsLinkedRoot ? cfg.targetTerminalOutflowPct : cfg.terminalOutflowPct,
      );
      if (sellPct === null) {
        return { action: "retry", reason: "terminal custody percentage is invalid" };
      }
      return {
        action: "execute",
        sellPct,
        sellTriggerKind: sourceIsLinkedRoot ? "target_terminal_outflow" : "terminal_outflow",
        reason: sourceIsLinkedRoot
          ? "finalized fresh-tail root terminal custody outflow"
          : "finalized fresh-tail descendant terminal custody outflow",
      };
    }
  }
}
