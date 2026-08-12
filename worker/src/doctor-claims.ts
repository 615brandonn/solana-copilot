export type ActiveSellClaim = {
  status: unknown;
  updated_at: unknown;
};

export type SellClaimGate = {
  blocked: boolean;
  total: number;
  uncertain: number;
  submitted: number;
  claimed: number;
  staleSubmitted: number;
  staleClaimed: number;
  invalidTimestamp: number;
};

export type EntryClaimGate = {
  blocked: boolean;
  total: number;
  uncertain: number;
  landed: number;
  submitted: number;
  claimed: number;
};

export const CLAIMED_STALE_AFTER_MS = 15_000;
export const SUBMITTED_STALE_AFTER_MS = 30_000;

/**
 * A deployment may not restart over any in-flight or uncertain exit. The short
 * thresholds distinguish a likely-active claim from a stalled one for the
 * operator; both states block the gate because restarting either is unsafe.
 */
export function evaluateSellClaimGate(rows: ActiveSellClaim[], nowMs = Date.now()): SellClaimGate {
  const gate: SellClaimGate = {
    blocked: false,
    total: 0,
    uncertain: 0,
    submitted: 0,
    claimed: 0,
    staleSubmitted: 0,
    staleClaimed: 0,
    invalidTimestamp: 0,
  };

  for (const row of rows) {
    if (row.status !== "uncertain" && row.status !== "submitted" && row.status !== "claimed") {
      continue;
    }
    gate.total += 1;
    gate[row.status] += 1;
    const updatedAtMs =
      typeof row.updated_at === "string" || typeof row.updated_at === "number"
        ? Date.parse(String(row.updated_at))
        : Number.NaN;
    if (!Number.isFinite(updatedAtMs)) {
      gate.invalidTimestamp += 1;
      if (row.status === "submitted") gate.staleSubmitted += 1;
      if (row.status === "claimed") gate.staleClaimed += 1;
      continue;
    }
    const ageMs = Math.max(0, nowMs - updatedAtMs);
    if (row.status === "submitted" && ageMs >= SUBMITTED_STALE_AFTER_MS) {
      gate.staleSubmitted += 1;
    }
    if (row.status === "claimed" && ageMs >= CLAIMED_STALE_AFTER_MS) {
      gate.staleClaimed += 1;
    }
  }
  gate.blocked = gate.total > 0;
  return gate;
}

/**
 * Every nonterminal entry state blocks a deployment. In particular, `landed`
 * means the on-chain buy may exist while its position has not been persisted;
 * restarting over that state could create an unmanaged holding or duplicate it.
 */
export function evaluateEntryClaimGate(rows: Array<{ status: unknown }>): EntryClaimGate {
  const gate: EntryClaimGate = {
    blocked: false,
    total: 0,
    uncertain: 0,
    landed: 0,
    submitted: 0,
    claimed: 0,
  };

  for (const row of rows) {
    if (
      row.status !== "uncertain" &&
      row.status !== "landed" &&
      row.status !== "submitted" &&
      row.status !== "claimed"
    ) {
      continue;
    }
    gate.total += 1;
    gate[row.status] += 1;
  }
  gate.blocked = gate.total > 0;
  return gate;
}
