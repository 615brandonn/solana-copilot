import { isPostSubmissionError } from "./execution-safety.js";

export type SellTriggerKind =
  | "direct_target_sell"
  | "terminal_outflow"
  | "target_terminal_outflow"
  | "take_profit"
  | "stop_loss"
  | "target_inactivity"
  | "distinct_follower"
  | "proportional_follower"
  | "crew_wallet";

export type DurableSellIdentity = {
  sourceTxSig: string;
  sourceWallet: string;
};

/** Stable identity shared by the immediate and periodic retry paths. */
export function periodicSellIdentity(
  positionId: string,
  triggerKind: Extract<
    SellTriggerKind,
    "take_profit" | "stop_loss" | "target_inactivity" | "distinct_follower"
  >,
  variant = "default",
): DurableSellIdentity {
  const safeVariant = String(variant || "default")
    .replace(/[^a-z0-9_-]/gi, "-")
    .slice(0, 80);
  return {
    sourceTxSig: `periodic:${positionId}:${triggerKind}:${safeVariant}`,
    sourceWallet: "helix-worker",
  };
}

export function canReclaimSellClaim(status: unknown): boolean {
  // A duplicate observer cannot prove that another process holding a freshly
  // claimed row has not begun submission. Only an explicit pre-submit failure
  // is safe to retry automatically.
  return status === "failed_pre_submit";
}

export function isSellClaimTerminalOrUncertain(status: unknown): boolean {
  return status === "submitted" || status === "landed" || status === "uncertain";
}

export function sellClaimFailureDisposition(error: unknown): {
  status: "failed_pre_submit" | "uncertain";
  botTxSig: string | null;
} {
  if (!isPostSubmissionError(error)) {
    return { status: "failed_pre_submit", botTxSig: null };
  }
  return { status: "uncertain", botTxSig: error.txSig ?? null };
}
