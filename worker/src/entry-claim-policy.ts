import { isPostSubmissionError } from "./execution-safety.js";

export type EntryClaimStatus =
  | "claimed"
  | "submitted"
  | "landed"
  | "persisted"
  | "failed_pre_submit"
  | "uncertain";

export type DurableEntryClaim = {
  planned_position_id: string;
  token_mint: string;
  bot_tx_sig: string | null;
  status: EntryClaimStatus;
};

export type DurableEntryPosition = {
  id: string;
  token_mint: string;
  entry_tx_sig: string | null;
};

/** Only an explicitly recorded pre-submission failure may be retried automatically. */
export function canReclaimEntryClaim(status: unknown): boolean {
  return status === "failed_pre_submit";
}

/** These states quarantine the mint across process restarts. */
export function isUnresolvedEntryClaim(status: unknown): boolean {
  return (
    status === "claimed" || status === "submitted" || status === "landed" || status === "uncertain"
  );
}

/**
 * A startup reconciliation may close a claim only when the exact position ID,
 * mint, and bot signature written by that claim already exist. A wallet balance
 * alone is deliberately insufficient because it may be a manual holding.
 */
export function entryClaimMatchesPersistedPosition(
  claim: DurableEntryClaim,
  position: DurableEntryPosition | null | undefined,
): boolean {
  return Boolean(
    position &&
    claim.bot_tx_sig &&
    position.entry_tx_sig &&
    position.id === claim.planned_position_id &&
    position.token_mint === claim.token_mint &&
    position.entry_tx_sig === claim.bot_tx_sig,
  );
}

export function entryClaimFailureDisposition(error: unknown): {
  status: "failed_pre_submit" | "uncertain";
  botTxSig: string | null;
} {
  if (!isPostSubmissionError(error)) {
    return { status: "failed_pre_submit", botTxSig: null };
  }
  return { status: "uncertain", botTxSig: error.txSig ?? null };
}
