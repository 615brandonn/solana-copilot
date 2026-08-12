import assert from "node:assert/strict";
import test from "node:test";

import {
  canReclaimSellClaim,
  isSellClaimTerminalOrUncertain,
  periodicSellIdentity,
  sellClaimFailureDisposition,
} from "./sell-claim-policy.js";
import { SubmissionUncertainError } from "./execution-safety.js";

test("immediate and retry loops can share one deterministic periodic claim", () => {
  assert.deepEqual(
    periodicSellIdentity("position", "distinct_follower", "coordinated"),
    periodicSellIdentity("position", "distinct_follower", "coordinated"),
  );
  assert.notDeepEqual(
    periodicSellIdentity("position", "distinct_follower", "coordinated"),
    periodicSellIdentity("position", "distinct_follower", "regular"),
  );
});

test("only proven pre-submission claims are reclaimable", () => {
  assert.equal(canReclaimSellClaim("claimed"), false);
  assert.equal(canReclaimSellClaim("failed_pre_submit"), true);
  for (const status of ["submitted", "landed", "uncertain"]) {
    assert.equal(canReclaimSellClaim(status), false);
    assert.equal(isSellClaimTerminalOrUncertain(status), true);
  }
});

test("post-submission uncertainty preserves its signature and cannot be retried", () => {
  assert.deepEqual(sellClaimFailureDisposition(new Error("quote rejected")), {
    status: "failed_pre_submit",
    botTxSig: null,
  });
  assert.deepEqual(
    sellClaimFailureDisposition(
      new SubmissionUncertainError({ route: "rpc", txSig: "known-signature" }),
    ),
    { status: "uncertain", botTxSig: "known-signature" },
  );
});
