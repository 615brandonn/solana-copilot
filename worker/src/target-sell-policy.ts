export type TargetSellMode = "off" | "proportional" | "fixed_pct" | "full";

export type TargetSellPolicyInput = {
  mode: TargetSellMode;
  verifiedSell: boolean;
  linkedToPosition: boolean;
  amountRemaining: number;
  targetPreAmount: number;
  targetPostAmount: number;
  configuredPct?: number;
};

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function clampToRemaining(amount: number, amountRemaining: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.min(amountRemaining, amount);
}

/**
 * Computes the local exit caused by a direct target-wallet sell.
 *
 * The caller must prove both that the event is a sell and that it belongs to
 * exactly one open position. Invalid balances, non-sells, and unknown policy
 * values deliberately return zero so an ambiguous event cannot trigger an
 * exit.
 */
export function computeTargetSellAmount(input: TargetSellPolicyInput): number {
  if (input.verifiedSell !== true || input.linkedToPosition !== true) return 0;
  if (!finiteNonNegative(input.amountRemaining) || input.amountRemaining === 0) return 0;
  if (!finiteNonNegative(input.targetPreAmount) || !finiteNonNegative(input.targetPostAmount)) {
    return 0;
  }
  if (input.targetPreAmount === 0 || input.targetPostAmount >= input.targetPreAmount) return 0;

  let requestedAmount: number;
  switch (input.mode) {
    case "off":
      return 0;
    case "proportional": {
      const soldFraction = (input.targetPreAmount - input.targetPostAmount) / input.targetPreAmount;
      requestedAmount = input.amountRemaining * soldFraction;
      break;
    }
    case "fixed_pct":
      if (!finiteNonNegative(input.configuredPct) || input.configuredPct > 100) {
        return 0;
      }
      requestedAmount = input.amountRemaining * (input.configuredPct / 100);
      break;
    case "full":
      requestedAmount = input.amountRemaining;
      break;
    default:
      return 0;
  }

  return clampToRemaining(requestedAmount, input.amountRemaining);
}
