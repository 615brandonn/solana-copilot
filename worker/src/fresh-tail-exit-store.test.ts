import assert from "node:assert/strict";
import test from "node:test";
import {
  createFreshTailExitStore,
  parseFreshTailExitIntent,
  type FreshTailExitIntent,
} from "./fresh-tail-exit-store.js";

const USER = "00000000-0000-4000-8000-000000000001";
const NIL_USER = "00000000-0000-0000-0000-000000000000";
const INTENT = "00000000-0000-4000-8000-000000000002";
const TOKEN = "00000000-0000-4000-8000-000000000003";
const ENTRY = "00000000-0000-4000-8000-000000000004";
const POSITION = "00000000-0000-4000-8000-000000000005";
const EPOCH = "00000000-0000-4000-8000-000000000006";
const REQUEST = "00000000-0000-4000-8000-000000000007";
const EVENT = "00000000-0000-4000-8000-000000000008";
const SELL_CLAIM = "00000000-0000-4000-8000-000000000009";
const MINT = "So11111111111111111111111111111111111111112";

function row(status: "claimed" | "uncertain" = "claimed") {
  return {
    intentId: INTENT,
    claimToken: TOKEN,
    claimGeneration: 7,
    claimExpiresAt: "2026-08-27T21:00:30Z",
    entryClaimId: ENTRY,
    positionId: POSITION,
    epochId: EPOCH,
    requestId: REQUEST,
    tokenMint: MINT,
    sourceDomain: "custody",
    eventId: EVENT,
    eventKey: "custody:event:1",
    eventKind: "SELL",
    triggerKind: "mirror_custody_sell",
    txSig: "source-signature",
    slot: 365_000_001,
    blockTime: "2026-08-27T21:00:00Z",
    sourceWallet: MINT,
    amountRaw: "900719925474099312345",
    decimals: 6,
    classificationReliable: true,
    watchable: true,
    status,
    priorSellClaimId: status === "uncertain" ? SELL_CLAIM : null,
    priorBotTxSig: status === "uncertain" ? "prepared-signature" : null,
    priorErrorCode: null,
  };
}

test("passes a legacy nil PostgreSQL user UUID through unchanged", async () => {
  let parameters: Record<string, unknown> | undefined;
  const store = createFreshTailExitStore(
    {
      rpc: (_name, args) => {
        parameters = args;
        return Promise.resolve({ data: { ok: true, reason: "claimed", intents: [] }, error: null });
      },
    },
    NIL_USER,
    "worker-1",
  );
  assert.deepEqual(await store.claim(1, 180), []);
  assert.deepEqual(parameters, {
    p_user_id: NIL_USER,
    p_worker_id: "worker-1",
    p_limit: 1,
    p_claim_seconds: 180,
  });
  assert.throws(
    () =>
      createFreshTailExitStore(
        { rpc: () => Promise.resolve({ data: null, error: null }) },
        `${NIL_USER}0`,
        "worker-1",
      ),
    /fresh-tail exit userId is not a UUID/,
  );
  assert.throws(
    () => parseFreshTailExitIntent({ ...row(), intentId: NIL_USER }),
    /fresh-tail exit intentId is not a UUID/,
  );
});

test("fresh-tail exit parser preserves exact raw values and rejects unsigned uncertainty", () => {
  assert.equal(parseFreshTailExitIntent(row()).amountRaw, "900719925474099312345");
  assert.throws(
    () =>
      parseFreshTailExitIntent({
        ...row("uncertain"),
        priorBotTxSig: null,
      }),
    /prepared sell evidence/,
  );
});

test("claiming and two-phase landed resolution keep one exact fence and signature", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const responses: unknown[] = [
    { ok: true, reason: "claimed", intents: [row()] },
    {
      ok: true,
      reason: "intent_resolved",
      intentId: INTENT,
      status: "uncertain",
      disposition: "uncertain",
      claimGeneration: 7,
    },
    {
      ok: true,
      reason: "intent_resolved",
      intentId: INTENT,
      status: "resolved",
      disposition: "resolved",
      claimGeneration: 7,
    },
  ];
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return Promise.resolve({ data: responses.shift(), error: null });
    },
  };
  const store = createFreshTailExitStore(client, USER, "worker-1");
  const [claimed] = await store.claim(1, 180);
  assert.ok(claimed);
  const evidence = { sellClaimId: SELL_CLAIM, botTxSig: "prepared-signature" };
  await store.resolve(claimed, "claimed", "uncertain", evidence, null);
  const uncertain: FreshTailExitIntent = {
    ...claimed,
    status: "uncertain",
    priorSellClaimId: SELL_CLAIM,
    priorBotTxSig: "prepared-signature",
  };
  await store.resolve(uncertain, "uncertain", "resolved", evidence, null);

  assert.deepEqual(calls[0], {
    name: "claim_custody_fresh_tail_exit_intents",
    args: {
      p_user_id: USER,
      p_worker_id: "worker-1",
      p_limit: 1,
      p_claim_seconds: 180,
    },
  });
  for (const call of calls.slice(1)) {
    assert.equal(call.name, "resolve_custody_fresh_tail_exit_intent");
    assert.equal(call.args.p_intent_id, INTENT);
    assert.equal(call.args.p_claim_token, TOKEN);
    assert.equal(call.args.p_claim_generation, 7);
    assert.equal(call.args.p_sell_claim_id, SELL_CLAIM);
    assert.equal(call.args.p_bot_tx_sig, "prepared-signature");
  }
  assert.equal(calls[1]?.args.p_expected_status, "claimed");
  assert.equal(calls[1]?.args.p_disposition, "uncertain");
  assert.equal(calls[2]?.args.p_expected_status, "uncertain");
  assert.equal(calls[2]?.args.p_disposition, "resolved");
});

test("uncertain resolution cannot substitute another claim or signature", async () => {
  const store = createFreshTailExitStore(
    { rpc: () => Promise.resolve({ data: null, error: null }) },
    USER,
    "worker-1",
  );
  await assert.rejects(
    store.resolve(
      parseFreshTailExitIntent(row("uncertain")),
      "uncertain",
      "resolved",
      { sellClaimId: SELL_CLAIM, botTxSig: "different-signature" },
      null,
    ),
    /evidence changed/,
  );
});

test("claim leases and resolution statuses fail closed on an invalid contract", async () => {
  const shortLeaseStore = createFreshTailExitStore(
    { rpc: () => Promise.resolve({ data: null, error: null }) },
    USER,
    "worker-1",
  );
  await assert.rejects(shortLeaseStore.claim(1, 179), /lease duration/);
  await assert.rejects(
    shortLeaseStore.resolve(parseFreshTailExitIntent(row()), "uncertain", "retry", null, null),
    /expected status does not match/,
  );

  const wrongStatusStore = createFreshTailExitStore(
    {
      rpc: () =>
        Promise.resolve({
          data: {
            ok: true,
            reason: "intent_resolved",
            intentId: INTENT,
            status: "retry",
            disposition: "position_closed",
            claimGeneration: 7,
          },
          error: null,
        }),
    },
    USER,
    "worker-1",
  );
  await assert.rejects(
    wrongStatusStore.resolve(
      parseFreshTailExitIntent(row()),
      "claimed",
      "position_closed",
      null,
      null,
    ),
    /changed its fenced identity/,
  );
});
