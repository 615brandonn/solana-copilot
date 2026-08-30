import assert from "node:assert/strict";
import test from "node:test";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  FreshTailClaimBindingRejectedError,
  createFreshTailEntryStore,
  freshTailCandidateIsUsable,
  type FreshTailEntryDbClient,
} from "./fresh-tail-entry-store.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const NIL_USER_ID = "00000000-0000-0000-0000-000000000000";
const EPOCH_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const CLAIM_ID = "44444444-4444-4444-8444-444444444444";
const POSITION_ID = "55555555-5555-4555-8555-555555555555";
const TX_SIG = bs58.encode(Buffer.alloc(64, 7));
const BOT_TX_SIG = bs58.encode(Buffer.alloc(64, 8));
const BLOCKHASH = bs58.encode(Buffer.alloc(32, 9));
const ROOTS = [
  new PublicKey(Uint8Array.from({ length: 32 }, (_value, index) => index + 1)).toBase58(),
  new PublicKey(Uint8Array.from({ length: 32 }, (_value, index) => index + 2)).toBase58(),
  new PublicKey(Uint8Array.from({ length: 32 }, (_value, index) => index + 3)).toBase58(),
] as const;
const MINT = new PublicKey(Uint8Array.from({ length: 32 }, () => 10)).toBase58();
const CURVE = new PublicKey(Uint8Array.from({ length: 32 }, () => 11)).toBase58();
const CREATOR = new PublicKey(Uint8Array.from({ length: 32 }, () => 12)).toBase58();
const HASH = "a".repeat(64);

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    safe: true,
    reason: "fresh_custody_safe",
    epochId: EPOCH_ID,
    requestId: REQUEST_ID,
    tokenMint: MINT,
    triggerEventKey: `${TX_SIG}:${ROOTS[0]}:${MINT}:buy`,
    txSig: TX_SIG,
    slot: 100,
    triggerBlockTime: "2026-08-26T00:00:01.000Z",
    targetWallet: ROOTS[0],
    expiresAt: "2026-08-26T00:00:55.000Z",
    requestedHeadSlot: 103,
    requestedHeadBlockhash: BLOCKHASH,
    requestedHeadBlockTime: "2026-08-26T00:00:02.000Z",
    proofObservedAt: "2026-08-26T00:00:03.000Z",
    windowStartedAt: "2026-08-25T23:50:01.000Z",
    amountRaw: "30000000000000",
    decimals: 6,
    totalSupplyRaw: "1000000000000000",
    netAcquiredRaw: "100000000000000",
    netSupplyPct: 10,
    thresholdPct: 10,
    rootWallets: [...ROOTS],
    marketCapUsd: 10_000,
    minMarketCapUsd: 2_000,
    maxMarketCapUsd: 20_000,
    createVariant: "classic_v1",
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    bondingCurve: CURVE,
    creator: CREATOR,
    mintLayoutFingerprint: HASH,
    creationParserAbiFingerprint:
      "ebe9ae1c8f38c24c3c6d4da1a3c9b90ffce4bf27e36f562bc67b090e9b7c343f",
    eventParserDomain: "pump_root_buy_v1",
    eventParserAbiFingerprint: "b8b6dbdcce44a2b61c55ba2fd74cd385fae489a95be291504eb8e7b15f88262d",
    headSnapshotParserAbiFingerprint:
      "2f5de97b6527d4ec94082069d65abd2bf30523e45bf562aabe1e770e5eb4ad1d",
    headCurveStateFingerprint: "b".repeat(64),
    headCurveObservedSlot: 103,
    headCurveComplete: false,
    headVirtualTokenReservesRaw: "900000000000000",
    headVirtualSolReservesLamports: "40000000000",
    headRealTokenReservesRaw: "700000000000000",
    headRealSolReservesLamports: "10000000000",
    headCurveTotalSupplyRaw: "1000000000000000",
    headMintLayoutFingerprint: HASH,
    headTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    headMintSupplyRaw: "1000000000000000",
    headMintDecimals: 6,
    scopeRevision: 4,
    settledRevision: 4,
    settledLeaseGeneration: 2,
    ...overrides,
  };
}

function fakeClient(
  handler: (name: string, parameters: Record<string, unknown>) => unknown,
): FreshTailEntryDbClient {
  return {
    async rpc(name, parameters) {
      try {
        return { data: handler(name, parameters), error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
  };
}

test("passes a legacy nil PostgreSQL user UUID through unchanged", async () => {
  let parameters: Record<string, unknown> | undefined;
  const store = createFreshTailEntryStore(
    fakeClient((_name, args) => {
      parameters = args;
      return { ok: true, reason: "loaded", candidates: [] };
    }),
    NIL_USER_ID,
  );
  assert.deepEqual(await store.loadCandidates(1), []);
  assert.deepEqual(parameters, { p_user_id: NIL_USER_ID, p_limit: 1 });
  assert.throws(
    () => createFreshTailEntryStore(fakeClient(() => null), `${NIL_USER_ID}0`),
    /fresh-tail userId is not a UUID/,
  );

  const strictEvidenceStore = createFreshTailEntryStore(
    fakeClient(() => ({
      ok: true,
      reason: "loaded",
      candidates: [candidate({ epochId: NIL_USER_ID })],
    })),
    USER_ID,
  );
  await assert.rejects(strictEvidenceStore.loadCandidates(1), /fresh-tail epochId is not a UUID/);
});

test("loads only a pinned, internally consistent fresh custody certificate", async () => {
  let parameters: Record<string, unknown> | undefined;
  const store = createFreshTailEntryStore(
    fakeClient((name, args) => {
      assert.equal(name, "get_custody_fresh_tail_entry_candidates");
      parameters = args;
      return { ok: true, reason: "loaded", candidates: [candidate()] };
    }),
    USER_ID,
  );
  const [loaded] = await store.loadCandidates(1);
  assert.ok(loaded);
  assert.equal(loaded.tokenMint, MINT);
  assert.equal(loaded.netAcquiredRaw, "100000000000000");
  assert.deepEqual(parameters, { p_user_id: USER_ID, p_limit: 1 });
  assert.equal(freshTailCandidateIsUsable(loaded, Date.parse("2026-08-26T00:00:05.000Z")), true);
  assert.equal(freshTailCandidateIsUsable(loaded, Date.parse("2026-08-26T00:00:07.001Z")), false);
});

test("malformed, stale, unreviewed, and sub-threshold candidates fail closed", async () => {
  const invalid = [
    candidate({ eventParserAbiFingerprint: "c".repeat(64) }),
    candidate({ requestedHeadBlockhash: "not-base58" }),
    candidate({ netAcquiredRaw: "99999999999999", netSupplyPct: 9.999 }),
    candidate({ totalSupplyRaw: "999", headCurveTotalSupplyRaw: "999", headMintSupplyRaw: "999" }),
    candidate({ targetWallet: CREATOR }),
    candidate({ proofObservedAt: "2026-08-26T00:00:01.000Z" }),
  ];
  for (const value of invalid) {
    const store = createFreshTailEntryStore(
      fakeClient(() => ({ ok: true, reason: "loaded", candidates: [value] })),
      USER_ID,
    );
    await assert.rejects(store.loadCandidates(), /fresh-tail/);
  }
});

test("recheck binds every immutable candidate identity and exact claim", async () => {
  let gateParameters: Record<string, unknown> | undefined;
  const loadedCandidate = candidate();
  const store = createFreshTailEntryStore(
    fakeClient((name, parameters) => {
      if (name === "check_supply_accumulation_fresh_custody_gate") {
        gateParameters = parameters;
        return loadedCandidate;
      }
      if (name === "bind_supply_entry_claim_fresh_tail") {
        return {
          ok: true,
          bound: true,
          reason: "bound_and_armed",
          claimId: CLAIM_ID,
          epochId: EPOCH_ID,
          requestId: REQUEST_ID,
          positionId: POSITION_ID,
          armedAt: "2026-08-26T00:00:03.100Z",
        };
      }
      throw new Error(`unexpected ${name}`);
    }),
    USER_ID,
  );
  const parsed = (await store.recheck(
    (
      await createFreshTailEntryStore(
        fakeClient(() => ({ ok: true, reason: "loaded", candidates: [loadedCandidate] })),
        USER_ID,
      ).loadCandidates()
    )[0]!,
    null,
  ))!;
  assert.equal(gateParameters?.p_claim_id, null);
  const binding = await store.bindClaim(parsed, CLAIM_ID, POSITION_ID);
  assert.equal(binding.positionId, POSITION_ID);
});

test("a changed final-gate head and a rejected binding never authorize submission", async () => {
  const loader = createFreshTailEntryStore(
    fakeClient(() => ({ ok: true, reason: "loaded", candidates: [candidate()] })),
    USER_ID,
  );
  const loaded = (await loader.loadCandidates())[0]!;
  const changed = createFreshTailEntryStore(
    fakeClient((name) => {
      if (name === "check_supply_accumulation_fresh_custody_gate") {
        return candidate({ requestedHeadBlockhash: bs58.encode(Buffer.alloc(32, 5)) });
      }
      return { ok: false, bound: false, reason: "request_already_claimed" };
    }),
    USER_ID,
  );
  await assert.rejects(changed.recheck(loaded, null), /immutable candidate identity/);
  await assert.rejects(
    changed.bindClaim(loaded, CLAIM_ID, POSITION_ID),
    (error: unknown) =>
      error instanceof FreshTailClaimBindingRejectedError &&
      error.reason === "request_already_claimed",
  );
});

test("records only the exact prepared signature and raw landed receipt", async () => {
  const calls: Array<{ name: string; parameters: Record<string, unknown> }> = [];
  const store = createFreshTailEntryStore(
    fakeClient((name, parameters) => {
      calls.push({ name, parameters });
      return {
        ok: true,
        replay: false,
        reason: "entry_receipt_recorded",
        claimId: CLAIM_ID,
        positionId: POSITION_ID,
        botTxSig: BOT_TX_SIG,
        receivedAmountRaw: "123456789",
        receivedTokenDecimals: 6,
        landedAt: "2026-08-26T00:00:04.000Z",
        status: "landed",
      };
    }),
    USER_ID,
  );
  const parsed = (
    await createFreshTailEntryStore(
      fakeClient(() => ({ ok: true, reason: "loaded", candidates: [candidate()] })),
      USER_ID,
    ).loadCandidates()
  )[0]!;
  const receipt = await store.recordReceipt(
    parsed,
    CLAIM_ID,
    POSITION_ID,
    BOT_TX_SIG,
    "123456789",
    6,
  );
  assert.equal(receipt.receivedAmountRaw, "123456789");
  assert.deepEqual(calls[0], {
    name: "record_supply_entry_claim_fresh_tail_receipt",
    parameters: {
      p_user_id: USER_ID,
      p_claim_id: CLAIM_ID,
      p_epoch_id: EPOCH_ID,
      p_request_id: REQUEST_ID,
      p_bot_tx_sig: BOT_TX_SIG,
      p_received_amount_raw: "123456789",
      p_received_token_decimals: 6,
    },
  });
  await assert.rejects(
    store.recordReceipt(parsed, CLAIM_ID, POSITION_ID, BOT_TX_SIG, "1", 5),
    /certified mint/,
  );
});

test("restart recovery records or replays the frozen receipt RPC without a candidate reload", async () => {
  for (const replay of [false, true]) {
    const store = createFreshTailEntryStore(
      fakeClient((name, parameters) => {
        assert.equal(name, "record_supply_entry_claim_fresh_tail_receipt");
        assert.equal(parameters.p_epoch_id, EPOCH_ID);
        assert.equal(parameters.p_request_id, REQUEST_ID);
        return {
          ok: true,
          replay,
          reason: replay ? "entry_receipt_already_recorded" : "entry_receipt_recorded",
          claimId: CLAIM_ID,
          positionId: POSITION_ID,
          botTxSig: BOT_TX_SIG,
          receivedAmountRaw: "9007199254740993",
          receivedTokenDecimals: 6,
          landedAt: "2026-08-26T00:00:04.000Z",
          status: replay ? "persisted" : "landed",
        };
      }),
      USER_ID,
    );
    const receipt = await store.recordBoundReceipt(
      { epochId: EPOCH_ID, requestId: REQUEST_ID, tokenDecimals: 6 },
      CLAIM_ID,
      POSITION_ID,
      BOT_TX_SIG,
      "9007199254740993",
      6,
    );
    assert.equal(receipt.replay, replay);
    assert.equal(receipt.receivedAmountRaw, "9007199254740993");
  }
});

test("lost bind responses remain distinguishable from authoritative binding rejection", async () => {
  const parsed = (
    await createFreshTailEntryStore(
      fakeClient(() => ({ ok: true, reason: "loaded", candidates: [candidate()] })),
      USER_ID,
    ).loadCandidates()
  )[0]!;
  const transportFailure = createFreshTailEntryStore(
    fakeClient(() => {
      throw new Error("connection reset after commit");
    }),
    USER_ID,
  );
  await assert.rejects(
    transportFailure.bindClaim(parsed, CLAIM_ID, POSITION_ID),
    (error: unknown) =>
      error instanceof Error && !(error instanceof FreshTailClaimBindingRejectedError),
  );

  const mismatchedReceipt = createFreshTailEntryStore(
    fakeClient(() => ({
      ok: true,
      replay: true,
      reason: "entry_receipt_already_recorded",
      claimId: CLAIM_ID,
      positionId: POSITION_ID,
      botTxSig: BOT_TX_SIG,
      receivedAmountRaw: "2",
      receivedTokenDecimals: 6,
      landedAt: "2026-08-26T00:00:04.000Z",
      status: "landed",
    })),
    USER_ID,
  );
  await assert.rejects(
    mismatchedReceipt.recordBoundReceipt(
      { epochId: EPOCH_ID, requestId: REQUEST_ID, tokenDecimals: 6 },
      CLAIM_ID,
      POSITION_ID,
      BOT_TX_SIG,
      "1",
      6,
    ),
    /different durable identity/,
  );
});
