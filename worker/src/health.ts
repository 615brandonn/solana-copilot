export function toIsoTimestamp(value: unknown): string | null {
  let parsed: Date;
  if (value instanceof Date) parsed = value;
  else if (typeof value === "number") {
    parsed = new Date(value < 1_000_000_000_000 ? value * 1000 : value);
  } else if (typeof value === "string") parsed = new Date(value);
  else return null;
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function isMissingReadinessColumnError(message: string): boolean {
  return /funding_key_ready|funding_key_checked_at|funding_wallet_pubkey|last_error|rpc_last_success_at|rpc_backlog_wallet_count|monitoring_degraded|follower_balance_last_checked_at|follower_balance_candidate_count|follower_balance_mismatch_count|follower_balance_reconciliation_degraded|follower_balance_last_error|schema cache/i.test(
    message,
  );
}
