import assert from "node:assert/strict";
import test from "node:test";

import {
  canReclaimEntryClaim,
  entryClaimFailureDisposition,
  entryClaimMatchesPersistedPosition,
  isUnresolvedEntryClaim,
  type DurableEntryClaim,
} from "./entry-claim-policy.js";
import { SubmissionUncertainError } from "./execution-safety.js";

const claim: DurableEntryClaim = {
  planned_position_id: "planned-position",
  token_mint: "mint",
  bot_tx_sig: "bot-signature",
  status: "landed",
};

test("entry claims quarantine every state that could have submitted a buy", () => {
  for (const status of ["claimed", "submitted", "landed", "uncertain"]) {
    assert.equal(isUnresolvedEntryClaim(status), true);
    assert.equal(canReclaimEntryClaim(status), false);
  }
  assert.equal(isUnresolvedEntryClaim("persisted"), false);
  assert.equal(isUnresolvedEntryClaim("failed_pre_submit"), false);
  assert.equal(canReclaimEntryClaim("failed_pre_submit"), true);
});

test("startup reconciliation requires the exact planned position and bot signature", () => {
  assert.equal(
    entryClaimMatchesPersistedPosition(claim, {
      id: "planned-position",
      token_mint: "mint",
      entry_tx_sig: "bot-signature",
    }),
    true,
  );
  assert.equal(
    entryClaimMatchesPersistedPosition(claim, {
      id: "manual-position",
      token_mint: "mint",
      entry_tx_sig: "bot-signature",
    }),
    false,
  );
  assert.equal(
    entryClaimMatchesPersistedPosition(claim, {
      id: "planned-position",
      token_mint: "mint",
      entry_tx_sig: "manual-signature",
    }),
    false,
  );
  assert.equal(entryClaimMatchesPersistedPosition({ ...claim, bot_tx_sig: null }, null), false);
});

test("only proven pre-submission entry failures can be retried", () => {
  assert.deepEqual(entryClaimFailureDisposition(new Error("quote unavailable")), {
    status: "failed_pre_submit",
    botTxSig: null,
  });
  assert.deepEqual(
    entryClaimFailureDisposition(
      new SubmissionUncertainError({ route: "rpc", txSig: "known-signature" }),
    ),
    { status: "uncertain", botTxSig: "known-signature" },
  );
});
