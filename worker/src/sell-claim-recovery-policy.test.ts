import assert from "node:assert/strict";
import test from "node:test";
import {
  decideSellClaimRecovery,
  type SellClaimRecoveryInput,
} from "./sell-claim-recovery-policy.js";

const BASE: SellClaimRecoveryInput = {
  status: "submitted",
  botTxSig: "signature",
  recoveryVersion: 1,
  staleUnsigned: true,
  chainEvidence: "missing",
  preparedBlockhashExpired: false,
  historyNullAfterExpiryRecheck: false,
  exactReceiptMatchesPrepared: false,
};

test("only a stale claim with no prepared signature is released as pre-send", () => {
  assert.deepEqual(
    decideSellClaimRecovery({
      ...BASE,
      status: "claimed",
      botTxSig: null,
      recoveryVersion: null,
      chainEvidence: "not_checked",
    }),
    { action: "release_for_retry", reason: "stale_unsigned_pre_send_claim" },
  );
  for (const variation of [
    { staleUnsigned: false },
    { botTxSig: "signature" },
    { recoveryVersion: 1 },
    { status: "uncertain" },
  ]) {
    assert.equal(
      decideSellClaimRecovery({
        ...BASE,
        status: "claimed",
        botTxSig: null,
        recoveryVersion: null,
        chainEvidence: "not_checked",
        ...variation,
      }).action,
      "quarantine",
    );
  }
});

test("a legacy signed claim always stays quarantined", () => {
  for (const chainEvidence of [
    "missing",
    "pending_success",
    "pending_failure",
    "finalized_success",
    "finalized_failure",
  ] as const) {
    assert.equal(
      decideSellClaimRecovery({
        ...BASE,
        recoveryVersion: null,
        chainEvidence,
        preparedBlockhashExpired: true,
        historyNullAfterExpiryRecheck: true,
        exactReceiptMatchesPrepared: true,
      }).action,
      "quarantine",
    );
  }
});

test("a missing signature is released only after expiry and a second history null", () => {
  assert.deepEqual(
    decideSellClaimRecovery({
      ...BASE,
      preparedBlockhashExpired: true,
      historyNullAfterExpiryRecheck: true,
    }),
    { action: "release_for_retry", reason: "expired_signature_absent_after_recheck" },
  );
  assert.equal(
    decideSellClaimRecovery({ ...BASE, preparedBlockhashExpired: true }).action,
    "quarantine",
  );
  assert.equal(
    decideSellClaimRecovery({ ...BASE, historyNullAfterExpiryRecheck: true }).action,
    "quarantine",
  );
});

test("only finalized chain failure releases a recorded signature", () => {
  assert.deepEqual(
    decideSellClaimRecovery({ ...BASE, chainEvidence: "finalized_failure" }),
    { action: "release_for_retry", reason: "transaction_failed_finalized" },
  );
  assert.deepEqual(
    decideSellClaimRecovery({ ...BASE, chainEvidence: "pending_failure" }),
    { action: "quarantine", reason: "failure_not_finalized" },
  );
});

test("only a finalized exact receipt crosses the atomic-apply boundary", () => {
  assert.deepEqual(
    decideSellClaimRecovery({
      ...BASE,
      chainEvidence: "finalized_success",
      exactReceiptMatchesPrepared: true,
    }),
    { action: "apply_exact_receipt", reason: "finalized_exact_receipt" },
  );
  assert.deepEqual(
    decideSellClaimRecovery({
      ...BASE,
      chainEvidence: "finalized_success",
      exactReceiptMatchesPrepared: false,
    }),
    { action: "quarantine", reason: "finalized_receipt_mismatch" },
  );
  for (const chainEvidence of ["not_checked", "pending_success", "missing"] as const) {
    assert.equal(
      decideSellClaimRecovery({
        ...BASE,
        chainEvidence,
        exactReceiptMatchesPrepared: true,
      }).action,
      "quarantine",
    );
  }
});

test("terminal claims are no-ops and unknown states fail closed", () => {
  for (const status of ["landed", "failed_pre_submit"]) {
    assert.deepEqual(decideSellClaimRecovery({ ...BASE, status }), {
      action: "none",
      reason: "claim_terminal",
    });
  }
  assert.deepEqual(decideSellClaimRecovery({ ...BASE, status: "mystery" }), {
    action: "quarantine",
    reason: "unknown_claim_status",
  });
});
