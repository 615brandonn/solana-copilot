export type ConvictionExposureTier = {
  mode: "shadow" | "live";
  amountUsd: number;
};

/**
 * LIVE exposure is the authoritative on-chain position cost. SHADOW exposure
 * is that same real base plus every durable hypothetical tier, so repeated
 * observations and restarts cannot reset or exceed the paper cap silently.
 */
export function effectiveConvictionExposureUsd(input: {
  tradingMode: "shadow" | "live";
  actualPositionUsd: number;
  executedTiers: readonly ConvictionExposureTier[];
}): number {
  const actual =
    Number.isFinite(input.actualPositionUsd) && input.actualPositionUsd > 0
      ? input.actualPositionUsd
      : 0;
  if (input.tradingMode === "live") return actual;
  const paper = input.executedTiers
    .filter((tier) => tier.mode === "shadow")
    .reduce(
      (sum, tier) =>
        sum + (Number.isFinite(tier.amountUsd) && tier.amountUsd > 0 ? tier.amountUsd : 0),
      0,
    );
  return actual + paper;
}
