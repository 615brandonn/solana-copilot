export type FollowerBalance = {
  initial_amount: number;
  current_amount: number;
  /** Tokens that left the lineage without a verified on-chain sale. */
  unexplained_outflow_amount?: number;
};

export function nextFollowerHop(parentHop: number, maxHop = 3): number | null {
  const normalized = Math.max(1, Math.floor(Number(parentHop) || 1));
  const cappedMax = Math.max(1, Math.min(5, Math.floor(Number(maxHop) || 3)));
  return normalized >= cappedMax ? null : normalized + 1;
}

export function followerSoldFraction(rows: FollowerBalance[]): number {
  const initial = rows.reduce((sum, row) => sum + Math.max(0, Number(row.initial_amount)), 0);
  const currentOrUnresolved = rows.reduce(
    (sum, row) =>
      sum +
      Math.max(0, Number(row.current_amount)) +
      Math.max(0, Number(row.unexplained_outflow_amount ?? 0)),
    0,
  );
  if (initial <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - currentOrUnresolved / initial));
}

export function chainedTransferAmount(currentAmount: number, requestedAmount: number): number {
  return Math.min(
    Math.max(0, Number(currentAmount) || 0),
    Math.max(0, Number(requestedAmount) || 0),
  );
}

export function proportionalMirrorSell(
  positionInitial: number,
  positionRemaining: number,
  soldFraction: number,
): number {
  const initial = Math.max(0, Number(positionInitial) || 0);
  const remaining = Math.max(0, Number(positionRemaining) || 0);
  const fraction = Math.min(1, Math.max(0, Number(soldFraction) || 0));
  const desiredRemaining = initial * (1 - fraction);
  return Math.min(remaining, Math.max(0, remaining - desiredRemaining));
}

export function isFlatPosition(amountRemaining: number, epsilon = 1e-9): boolean {
  return Math.max(0, Number(amountRemaining) || 0) <= epsilon;
}
