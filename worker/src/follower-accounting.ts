export type RootFollowerTransferResult = {
  applied: boolean;
  duplicate: boolean;
  appliedAmount: number;
  triggerEligible: boolean;
};

export type FollowerSellAccountingResult = {
  applied: boolean;
  duplicate: boolean;
  appliedAmount: number;
  soldFraction: number;
  distinctSellerCount: number;
  firstSellByWallet: boolean;
  triggerEligible: boolean;
  freshForAction: boolean;
};

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function row(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function parseRootFollowerTransferResult(value: unknown): RootFollowerTransferResult | null {
  const result = row(value);
  if (result.payloadMismatch === true) {
    throw new Error("atomic root follower transfer replay payload mismatch");
  }
  const applied = result.applied === true;
  const duplicate = result.duplicate === true;
  if (!applied && !duplicate) return null;
  return {
    applied,
    duplicate,
    appliedAmount: Math.max(0, finiteNumber(result.appliedAmount) ?? 0),
    triggerEligible: result.triggerEligible === true,
  };
}

export function parseFollowerSellAccountingResult(
  value: unknown,
): FollowerSellAccountingResult | null {
  const result = row(value);
  if (result.payloadMismatch === true) {
    throw new Error("atomic follower sell replay payload mismatch");
  }
  const applied = result.applied === true;
  const duplicate = result.duplicate === true;
  const appliedAmount = Math.max(0, finiteNumber(result.appliedAmount) ?? 0);
  // A duplicate is actionable only when the original event actually debited a
  // retained wallet. This prevents an unknown/zero-balance replay from causing
  // a sell based on an unrelated aggregate snapshot.
  if (appliedAmount <= 0 || (!applied && !duplicate)) return null;
  return {
    applied,
    duplicate,
    appliedAmount,
    soldFraction: Math.min(1, Math.max(0, finiteNumber(result.soldFraction) ?? 0)),
    distinctSellerCount: Math.max(0, Math.trunc(finiteNumber(result.distinctSellerCount) ?? 0)),
    firstSellByWallet: result.firstSellByWallet === true,
    triggerEligible: result.triggerEligible === true,
    freshForAction: result.freshForAction === true,
  };
}
