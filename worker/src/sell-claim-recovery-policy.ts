export type SellClaimRecoveryInput = {
  status: unknown;
  botTxSig: string | null | undefined;
  recoveryVersion: number | null | undefined;
  staleUnsigned: boolean;
  chainEvidence:
    | "not_checked"
    | "missing"
    | "pending_success"
    | "pending_failure"
    | "finalized_success"
    | "finalized_failure";
  preparedBlockhashExpired: boolean;
  historyNullAfterExpiryRecheck: boolean;
  exactReceiptMatchesPrepared: boolean;
};

export type SellClaimRecoveryDecision = {
  action: "none" | "quarantine" | "release_for_retry" | "apply_exact_receipt";
  reason: string;
};

/**
 * Pure fail-closed policy for startup and periodic durable-sell recovery.
 *
 * `release_for_retry` means chain evidence proves the prepared transaction can
 * no longer land. `apply_exact_receipt` still requires one database transaction
 * to write the position, trade and terminal claim together.
 */
export function decideSellClaimRecovery(
  input: SellClaimRecoveryInput,
): SellClaimRecoveryDecision {
  if (input.status === "landed" || input.status === "failed_pre_submit") {
    return { action: "none", reason: "claim_terminal" };
  }
  if (
    input.status !== "claimed" &&
    input.status !== "submitted" &&
    input.status !== "uncertain"
  ) {
    return { action: "quarantine", reason: "unknown_claim_status" };
  }

  const signature = String(input.botTxSig ?? "").trim();
  if (!signature) {
    if (
      input.recoveryVersion == null &&
      input.staleUnsigned &&
      (input.status === "claimed" || input.status === "submitted")
    ) {
      return { action: "release_for_retry", reason: "stale_unsigned_pre_send_claim" };
    }
    return { action: "quarantine", reason: "unsigned_claim_not_yet_proven_stale" };
  }

  // Signatures prepared before the exact-amount/blockhash protocol cannot be
  // recovered automatically: the same chain result is compatible with more
  // than one database mutation boundary in the legacy code.
  if (input.recoveryVersion !== 1) {
    return { action: "quarantine", reason: "legacy_signed_claim_lacks_exact_attempt" };
  }

  if (input.chainEvidence === "finalized_failure") {
    return { action: "release_for_retry", reason: "transaction_failed_finalized" };
  }
  if (
    input.chainEvidence === "missing" &&
    input.preparedBlockhashExpired &&
    input.historyNullAfterExpiryRecheck
  ) {
    return { action: "release_for_retry", reason: "expired_signature_absent_after_recheck" };
  }
  if (input.chainEvidence === "finalized_success") {
    return input.exactReceiptMatchesPrepared
      ? { action: "apply_exact_receipt", reason: "finalized_exact_receipt" }
      : { action: "quarantine", reason: "finalized_receipt_mismatch" };
  }

  return {
    action: "quarantine",
    reason:
      input.chainEvidence === "pending_failure"
        ? "failure_not_finalized"
        : input.chainEvidence === "missing"
          ? "signature_absence_not_proven"
          : "transaction_not_finalized",
  };
}
