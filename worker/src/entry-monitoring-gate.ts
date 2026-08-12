import type { FollowerBalanceReconciliationHealth } from "./follower-balance-reconciler.js";

export type EntryMonitoringSignals = {
  geyserConnected: boolean;
  rpcLastSuccessAt: number | null;
  rpcBacklogWalletCount: number;
  followerBalances: FollowerBalanceReconciliationHealth;
};

export type EntryMonitoringGate = {
  blocked: boolean;
  reasons: string[];
};

export function evaluateEntryMonitoringGate(
  signals: EntryMonitoringSignals,
  nowMs = Date.now(),
): EntryMonitoringGate {
  const reasons: string[] = [];
  const rpcFresh = signals.rpcLastSuccessAt !== null && nowMs - signals.rpcLastSuccessAt <= 60_000;
  if (!signals.geyserConnected && !rpcFresh) {
    reasons.push("both Geyser and RPC monitoring are unavailable or stale");
  }
  if (Math.max(0, signals.rpcBacklogWalletCount) > 0) {
    reasons.push("RPC wallet catch-up is still backlogged");
  }
  if (!signals.followerBalances.hasCompleted) {
    reasons.push("follower balance reconciliation has not completed");
  } else {
    const reconciliationFresh =
      signals.followerBalances.lastCheckedAt !== null &&
      nowMs - signals.followerBalances.lastCheckedAt <= 120_000;
    if (!reconciliationFresh) reasons.push("follower balance reconciliation is stale");
    if (signals.followerBalances.degraded) {
      reasons.push("follower balance reconciliation is degraded");
    }
    if (signals.followerBalances.mismatchCount > 0) {
      reasons.push(
        `${signals.followerBalances.mismatchCount} follower balance mismatch(es) require review`,
      );
    }
  }
  return { blocked: reasons.length > 0, reasons };
}
