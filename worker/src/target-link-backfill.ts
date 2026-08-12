export type CoordinatedPositionEvidence = {
  positionId: string;
  tokenMint: string;
  entryMode: string;
  rootBuyCount: number;
  anchorAt: string | null;
  lastRootBuyWallet: string | null;
};

export type StrategyBuyEvidence = {
  actor_wallet: string;
  event_at: string;
  metadata?: Record<string, unknown> | null;
};

/**
 * Returns links only when Strategy Lab contains a complete coordinated cohort
 * inside the configured entry window. Partial evidence returns nothing; the
 * caller must never fill missing wallets by guessing from configuration.
 */
export function authoritativeCoordinatedTargetLinks(input: {
  position: CoordinatedPositionEvidence;
  observations: StrategyBuyEvidence[];
  configuredTargets: ReadonlySet<string>;
  windowSeconds: number;
}): string[] {
  const { position } = input;
  const required = Math.max(2, Math.floor(Number(position.rootBuyCount) || 0));
  const anchorMs = Date.parse(position.anchorAt ?? "");
  const windowMs = Math.max(1, Number(input.windowSeconds) || 0) * 1_000;
  if (position.entryMode !== "coordinated" || !Number.isFinite(anchorMs)) return [];

  const wallets = new Set<string>();
  for (const observation of input.observations) {
    const eventMs = Date.parse(observation.event_at);
    if (!Number.isFinite(eventMs) || eventMs < anchorMs - windowMs || eventMs > anchorMs + 5_000) {
      continue;
    }
    if (!input.configuredTargets.has(observation.actor_wallet)) continue;
    if (observation.metadata?.entryMode !== "coordinated") continue;
    wallets.add(observation.actor_wallet);
  }
  if (position.lastRootBuyWallet && !wallets.has(position.lastRootBuyWallet)) return [];
  if (wallets.size < required) return [];
  return Array.from(wallets).sort();
}
