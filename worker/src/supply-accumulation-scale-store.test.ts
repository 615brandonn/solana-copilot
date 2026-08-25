import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import {
  SUPPLY_SCALE_UNRESOLVED_STATUSES,
  SupplyAccumulationScaleStore,
  SupplyScaleStoreError,
  isSupplyScalePreSubmitGuardError,
  parseSupplyScaleApplyResult,
  parseSupplyScaleClaim,
  parseSupplyScaleClaimRow,
  parseSupplyScalePlan,
  type SupplyScaleClaimStatus,
} from "./supply-accumulation-scale-store.js";

const USER = "00000000-0000-4000-8000-000000000001";
const CLAIM = "00000000-0000-4000-8000-000000000002";
const POSITION = "00000000-0000-4000-8000-000000000003";
const TRADE = "00000000-0000-4000-8000-000000000004";
const MINT = "mint-address";
const EVENT = "source-event-key";
const SIG = "prepared-signature";
const RAW = "900719925474099312345678901234567890";
const HEIGHT = "9007199254740993123";
const CREATED_AT = "2026-08-25T20:00:00.123456+00:00";
const UPDATED_AT = "2026-08-25T20:00:01.654321+00:00";
const SUBMITTED_AT = "2026-08-25T20:00:02.456789+00:00";
const LANDED_AT = "2026-08-25T20:00:03.987654+00:00";
const REPAIRED_AT = "2026-08-25T20:00:04.123456+00:00";
const SUBMITTED_AT_Z = "2026-08-25T20:00:02.456789Z";
const LANDED_AT_Z = "2026-08-25T20:00:03.987654Z";
const FINGERPRINT = "a".repeat(64);

type Row = Record<string, unknown>;

function camelClaim(status: SupplyScaleClaimStatus = "claimed"): Row {
  const signed =
    status === "submitted" ||
    status === "landed" ||
    status === "persisted" ||
    status === "uncertain";
  const receipt = status === "landed" || status === "persisted";
  const persisted = status === "persisted";
  return {
    id: CLAIM,
    userId: USER,
    tokenMint: MINT,
    positionId: POSITION,
    tierNumber: 2,
    status,
    sourceEventKey: EVENT,
    sourceTxSig: "source-signature",
    sourceWallet: "source-wallet",
    sourceSlot: "9007199254740994",
    tokenDecimals: 6,
    thresholdPct: 12,
    plannedBuyUsd: 10,
    amountLamports: "9007199254740995",
    configFingerprint: FINGERPRINT,
    botTxSig: signed ? SIG : null,
    lastValidBlockHeight: signed ? HEIGHT : null,
    receivedAmountRaw: receipt ? RAW : null,
    tradeId: persisted ? TRADE : null,
    errorCode: status === "failed_pre_submit" || status === "uncertain" ? "safe-error" : null,
    submissionStartedAt: signed ? SUBMITTED_AT : null,
    landedAt: receipt ? LANDED_AT : null,
    persistedAt: persisted ? LANDED_AT : null,
    appliedAt: persisted ? LANDED_AT : null,
    postApplyRepairedAt: null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  };
}

function snakeClaim(status: SupplyScaleClaimStatus = "claimed"): Row {
  const claim = camelClaim(status);
  return {
    id: claim.id,
    user_id: claim.userId,
    token_mint: claim.tokenMint,
    position_id: claim.positionId,
    tier_number: claim.tierNumber,
    status: claim.status,
    source_event_key: claim.sourceEventKey,
    source_tx_sig: claim.sourceTxSig,
    source_wallet: claim.sourceWallet,
    source_slot: claim.sourceSlot,
    token_decimals: claim.tokenDecimals,
    threshold_pct: claim.thresholdPct,
    planned_buy_usd: claim.plannedBuyUsd,
    amount_lamports: claim.amountLamports,
    config_fingerprint: claim.configFingerprint,
    bot_tx_sig: claim.botTxSig,
    last_valid_block_height: claim.lastValidBlockHeight,
    received_amount_raw: claim.receivedAmountRaw,
    trade_id: claim.tradeId,
    error_code: claim.errorCode,
    submission_started_at: claim.submissionStartedAt,
    landed_at: claim.landedAt,
    persisted_at: claim.persistedAt,
    applied_at: claim.appliedAt,
    post_apply_repaired_at: claim.postApplyRepairedAt,
    created_at: claim.createdAt,
    updated_at: claim.updatedAt,
  };
}

function plan(overrides: Row = {}): Row {
  return {
    ok: true,
    eligible: true,
    reason: "eligible",
    userId: USER,
    tokenMint: MINT,
    positionId: POSITION,
    sourceEventKey: EVENT,
    claimId: null,
    tierNumber: 2,
    thresholdPct: 12,
    buyUsd: 10,
    configFingerprint: FINGERPRINT,
    sourceTxSig: "source-signature",
    sourceWallet: "source-wallet",
    sourceSlot: "9007199254740994",
    tokenDecimals: 6,
    netSupplyPct: 12.5,
    marketCapUsd: 4_000,
    minMarketCapUsd: 2_000,
    maxMarketCapUsd: 15_000,
    ...overrides,
  };
}

type Trace = { method: string; args: unknown[] };
type Response = { data: unknown; error: { code?: string; message?: string } | null };

class FakeQuery implements PromiseLike<Response> {
  readonly trace: Trace[] = [];

  constructor(
    readonly operation: "select" | "update",
    readonly payload: Row | null,
    private readonly response: Response,
  ) {}

  private call(method: string, ...args: unknown[]): this {
    this.trace.push({ method, args });
    return this;
  }

  select(...args: unknown[]): this {
    return this.call("select", ...args);
  }
  eq(...args: unknown[]): this {
    return this.call("eq", ...args);
  }
  is(...args: unknown[]): this {
    return this.call("is", ...args);
  }
  not(...args: unknown[]): this {
    return this.call("not", ...args);
  }
  in(...args: unknown[]): this {
    return this.call("in", ...args);
  }
  or(...args: unknown[]): this {
    return this.call("or", ...args);
  }
  order(...args: unknown[]): this {
    return this.call("order", ...args);
  }
  limit(...args: unknown[]): this {
    return this.call("limit", ...args);
  }

  async maybeSingle(): Promise<Response> {
    return this.response;
  }

  then<TResult1 = Response, TResult2 = never>(
    onfulfilled?: ((value: Response) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.response).then(onfulfilled, onrejected);
  }
}

class FakeClient {
  readonly rpcCalls: Array<{ name: string; args: Row }> = [];
  readonly queries: FakeQuery[] = [];
  private readonly rpcResponses: Response[] = [];
  private readonly tableResponses: Response[] = [];

  queueRpc(data: unknown, error: Response["error"] = null): void {
    this.rpcResponses.push({ data, error });
  }

  queueTable(data: unknown, error: Response["error"] = null): void {
    this.tableResponses.push({ data, error });
  }

  async rpc(name: string, args: Row): Promise<Response> {
    this.rpcCalls.push({ name, args });
    return this.rpcResponses.shift() ?? { data: null, error: { message: "missing fake RPC" } };
  }

  from(table: string) {
    assert.equal(table, "supply_accumulation_scale_claims");
    const make = (operation: "select" | "update", payload: Row | null) => {
      const query = new FakeQuery(
        operation,
        payload,
        this.tableResponses.shift() ?? {
          data: null,
          error: { message: "missing fake table response" },
        },
      );
      this.queries.push(query);
      return query;
    };
    return {
      select: (...args: unknown[]) => make("select", null).select(...args),
      update: (payload: Row) => make("update", payload),
    };
  }
}

function store(client: FakeClient): SupplyAccumulationScaleStore {
  return new SupplyAccumulationScaleStore(client as never, USER);
}

function hasTrace(query: FakeQuery, method: string, ...args: unknown[]): boolean {
  return query.trace.some(
    (entry) => entry.method === method && isDeepStrictEqual(entry.args, args),
  );
}

test("plan parser accepts progressive null evidence but requires complete eligible evidence", () => {
  const parsed = parseSupplyScalePlan(plan());
  assert.equal(parsed.sourceSlot, "9007199254740994");

  assert.deepEqual(
    parseSupplyScalePlan(
      plan({
        ok: false,
        eligible: false,
        reason: "invalid_request",
        userId: null,
        tokenMint: null,
        positionId: null,
        sourceEventKey: null,
        claimId: null,
        tierNumber: null,
        thresholdPct: null,
        buyUsd: null,
        configFingerprint: null,
        sourceTxSig: null,
        sourceWallet: null,
        sourceSlot: null,
        tokenDecimals: null,
        netSupplyPct: null,
        marketCapUsd: null,
        minMarketCapUsd: null,
        maxMarketCapUsd: null,
      }),
    ).reason,
    "invalid_request",
  );

  assert.throws(
    () => parseSupplyScalePlan(plan({ sourceSlot: 9_007_199_254_740_991 })),
    /sourceSlot/,
  );
  assert.throws(() => parseSupplyScalePlan(plan({ sourceWallet: null })), /missing sourceWallet/);
  assert.throws(
    () => parseSupplyScalePlan(plan({ configFingerprint: "short" })),
    /configFingerprint/,
  );
  assert.throws(() => parseSupplyScalePlan(plan({ thresholdPct: "12" })), /thresholdPct/);
  assert.throws(
    () => parseSupplyScalePlan(plan({ ok: false, eligible: true })),
    /cannot be eligible/,
  );
});

test("claim parsers preserve exact raw values above 2^53 and reject ambiguous lifecycle states", () => {
  assert.equal(parseSupplyScaleClaim(camelClaim("landed")).receivedAmountRaw, RAW);
  assert.equal(parseSupplyScaleClaimRow(snakeClaim("landed")).receivedAmountRaw, RAW);

  assert.throws(
    () => parseSupplyScaleClaim({ ...camelClaim(), status: "processing" }),
    /ambiguous status/,
  );
  assert.throws(
    () => parseSupplyScaleClaim({ ...camelClaim(), botTxSig: SIG }),
    /impossible claimed lifecycle/,
  );
  assert.throws(
    () => parseSupplyScaleClaim({ ...camelClaim("submitted"), lastValidBlockHeight: null }),
    /impossible submitted lifecycle/,
  );
  assert.throws(
    () => parseSupplyScaleClaim({ ...camelClaim("landed"), landedAt: null }),
    /impossible landed lifecycle/,
  );
  assert.throws(
    () => parseSupplyScaleClaim({ ...camelClaim("landed"), receivedAmountRaw: 42 }),
    /receivedAmountRaw/,
  );
  assert.throws(
    () => parseSupplyScaleClaimRow({ ...snakeClaim("landed"), received_amount_raw: 42 }),
    /receivedAmountRaw/,
  );
  assert.throws(
    () => parseSupplyScaleClaim({ ...camelClaim("landed"), postApplyRepairedAt: REPAIRED_AT }),
    /repair marker before atomic application/,
  );
});

test("RPC methods use exact SQL argument names and never coerce exact integers to Number", async () => {
  const client = new FakeClient();
  client.queueRpc(plan());
  client.queueRpc({ claimed: true, replay: false, reason: "claimed", claim: camelClaim() });
  client.queueRpc({
    applied: true,
    replay: false,
    reason: "applied",
    claimId: CLAIM,
    positionId: POSITION,
    tierNumber: 2,
    tradeId: TRADE,
    amountTokens: "900719925474099312345.123456",
    amountRemaining: "900719925474099312345.123456",
    entryPriceUsd: "0.000000000000000001",
  });
  const adapter = store(client);

  await adapter.getPlan(MINT, POSITION, EVENT);
  await adapter.claimBuy(MINT, POSITION, EVENT, "9007199254740995");
  const applied = await adapter.applyBuy(CLAIM, SIG, RAW, 6, "rpc", 123);
  assert.equal(applied.amountTokens, "900719925474099312345.123456");

  assert.deepEqual(client.rpcCalls, [
    {
      name: "get_supply_accumulation_scale_plan",
      args: {
        p_user_id: USER,
        p_token_mint: MINT,
        p_position_id: POSITION,
        p_source_event_key: EVENT,
        p_claim_id: null,
      },
    },
    {
      name: "claim_supply_accumulation_scale_buy",
      args: {
        p_user_id: USER,
        p_token_mint: MINT,
        p_position_id: POSITION,
        p_source_event_key: EVENT,
        p_amount_lamports: "9007199254740995",
      },
    },
    {
      name: "apply_supply_accumulation_scale_buy",
      args: {
        p_user_id: USER,
        p_claim_id: CLAIM,
        p_bot_tx_sig: SIG,
        p_received_amount_raw: RAW,
        p_token_decimals: 6,
        p_route: "rpc",
        p_latency_ms: 123,
      },
    },
  ]);
});

test("beginSubmission is one atomic claimed-to-signed-submitted CAS", async () => {
  const client = new FakeClient();
  client.queueTable(snakeClaim("submitted"));
  const result = await store(client).beginSubmission(CLAIM, SIG, HEIGHT, SUBMITTED_AT_Z);
  assert.equal(result.status, "submitted");
  const query = client.queries[0]!;
  assert.deepEqual(query.payload, {
    status: "submitted",
    bot_tx_sig: SIG,
    last_valid_block_height: HEIGHT,
    submission_started_at: SUBMITTED_AT_Z,
    error_code: null,
    updated_at: SUBMITTED_AT_Z,
  });
  assert.ok(hasTrace(query, "eq", "id", CLAIM));
  assert.ok(hasTrace(query, "eq", "user_id", USER));
  assert.ok(hasTrace(query, "eq", "status", "claimed"));
  assert.ok(hasTrace(query, "is", "bot_tx_sig", null));
  assert.ok(hasTrace(query, "is", "submission_started_at", null));
  const projection = query.trace.find((entry) => entry.method === "select")?.args[0];
  assert.equal(typeof projection, "string");
  for (const exactCast of [
    "source_slot::text",
    "amount_lamports::text",
    "last_valid_block_height::text",
    "received_amount_raw::text",
  ]) {
    assert.ok(String(projection).includes(exactCast));
  }
});

test("persistPrepared is a read-only exact attempt verifier", async () => {
  const client = new FakeClient();
  client.queueTable(snakeClaim("submitted"));
  await store(client).persistPrepared(CLAIM, SIG, HEIGHT, SUBMITTED_AT);
  const query = client.queries[0]!;
  assert.equal(query.operation, "select");
  assert.equal(query.payload, null);
  for (const pair of [
    ["id", CLAIM],
    ["user_id", USER],
    ["status", "submitted"],
    ["bot_tx_sig", SIG],
    ["last_valid_block_height", HEIGHT],
    ["submission_started_at", SUBMITTED_AT],
  ]) {
    assert.ok(hasTrace(query, "eq", ...pair));
  }
});

test("markLanded resolves exact submitted or uncertain attempts without replacing different raw evidence", async () => {
  for (const sourceStatus of ["submitted", "uncertain"] as const) {
    const client = new FakeClient();
    client.queueTable(snakeClaim("landed"));
    await store(client).markLanded(
      CLAIM,
      { botTxSig: SIG, lastValidBlockHeight: HEIGHT, submissionStartedAt: SUBMITTED_AT },
      RAW,
      6,
      LANDED_AT_Z,
    );
    const query = client.queries[0]!;
    assert.equal(query.payload?.status, "landed");
    assert.equal(query.payload?.received_amount_raw, RAW);
    assert.ok(hasTrace(query, "in", "status", ["submitted", "uncertain"]));
    assert.ok(hasTrace(query, "eq", "bot_tx_sig", SIG));
    assert.ok(hasTrace(query, "eq", "last_valid_block_height", HEIGHT));
    assert.ok(hasTrace(query, "eq", "submission_started_at", SUBMITTED_AT));
    assert.ok(hasTrace(query, "or", `received_amount_raw.is.null,received_amount_raw.eq.${RAW}`));
    assert.ok(sourceStatus);
  }
});

test("finalized uncertain chain errors can release only the exact signed attempt", async () => {
  const client = new FakeClient();
  client.queueTable(snakeClaim("failed_pre_submit"));
  await store(client).markFailure(
    CLAIM,
    {
      status: "failed_pre_submit",
      expectedStatus: "uncertain",
      errorCode: "finalized_chain_error",
      attempt: { botTxSig: SIG, lastValidBlockHeight: HEIGHT, submissionStartedAt: SUBMITTED_AT },
    },
    UPDATED_AT,
  );
  const query = client.queries[0]!;
  assert.equal(query.payload?.status, "failed_pre_submit");
  assert.equal(query.payload?.bot_tx_sig, null);
  assert.equal(query.payload?.received_amount_raw, null);
  assert.ok(hasTrace(query, "eq", "status", "uncertain"));
  assert.ok(hasTrace(query, "eq", "bot_tx_sig", SIG));
  assert.ok(hasTrace(query, "eq", "last_valid_block_height", HEIGHT));
  assert.ok(hasTrace(query, "eq", "submission_started_at", SUBMITTED_AT));
});

test("unresolved loading is bounded, ordered, and excludes terminal or ambiguous statuses", async () => {
  const client = new FakeClient();
  client.queueTable([
    snakeClaim("claimed"),
    snakeClaim("submitted"),
    snakeClaim("landed"),
    snakeClaim("uncertain"),
  ]);
  const claims = await store(client).loadUnresolvedClaims();
  assert.deepEqual(
    claims.map((claim) => claim.status),
    [...SUPPLY_SCALE_UNRESOLVED_STATUSES],
  );
  const query = client.queries[0]!;
  assert.ok(hasTrace(query, "eq", "user_id", USER));
  assert.ok(hasTrace(query, "in", "status", [...SUPPLY_SCALE_UNRESOLVED_STATUSES]));
  assert.ok(hasTrace(query, "order", "created_at", { ascending: true }));
  assert.ok(hasTrace(query, "order", "id", { ascending: true }));
  assert.ok(hasTrace(query, "limit", 1_001));

  const malformed = new FakeClient();
  malformed.queueTable([{ ...snakeClaim("claimed"), status: "processing" }]);
  await assert.rejects(store(malformed).loadUnresolvedClaims(), /ambiguous status/);
});

test("persisted scale fills retain a durable post-apply sell-repair checkpoint", async () => {
  const markedClient = new FakeClient();
  markedClient.queueTable({
    ...snakeClaim("persisted"),
    post_apply_repaired_at: REPAIRED_AT,
  });
  const marked = await store(markedClient).markPostApplyRepaired(CLAIM, SIG, REPAIRED_AT);
  assert.equal(marked.postApplyRepairedAt, REPAIRED_AT);
  const update = markedClient.queries[0]!;
  assert.deepEqual(update.payload, {
    post_apply_repaired_at: REPAIRED_AT,
    updated_at: REPAIRED_AT,
  });
  assert.ok(hasTrace(update, "eq", "status", "persisted"));
  assert.ok(hasTrace(update, "eq", "bot_tx_sig", SIG));
  assert.ok(hasTrace(update, "not", "applied_at", "is", null));
  assert.ok(hasTrace(update, "is", "post_apply_repaired_at", null));

  const pendingClient = new FakeClient();
  pendingClient.queueTable([snakeClaim("persisted")]);
  const pending = await store(pendingClient).loadPendingPostApplyRepairs();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.postApplyRepairedAt, null);
  const query = pendingClient.queries[0]!;
  assert.ok(hasTrace(query, "eq", "status", "persisted"));
  assert.ok(hasTrace(query, "is", "post_apply_repaired_at", null));
  assert.ok(hasTrace(query, "order", "applied_at", { ascending: true }));
  assert.ok(hasTrace(query, "limit", 1_001));
});

test("pre-submit database guards are classified as safe non-retry blocks", async () => {
  for (const code of ["55000", "23514"]) {
    const client = new FakeClient();
    client.queueRpc(null, { code, message: "position action conflict" });
    await assert.rejects(store(client).getPlan(MINT, POSITION, EVENT), (error: unknown) => {
      assert.ok(error instanceof SupplyScaleStoreError);
      assert.equal(error.code, code);
      assert.equal(isSupplyScalePreSubmitGuardError(error), true);
      return true;
    });
  }
  assert.equal(
    isSupplyScalePreSubmitGuardError(new SupplyScaleStoreError("x", { code: "40001" })),
    false,
  );
});

test("apply parser rejects zero or malformed persisted accounting evidence", () => {
  const base = {
    applied: true,
    replay: false,
    reason: "applied",
    claimId: CLAIM,
    positionId: POSITION,
    tierNumber: 2,
    tradeId: TRADE,
    amountTokens: "1",
    amountRemaining: "1",
    entryPriceUsd: "0.1",
  };
  assert.equal(parseSupplyScaleApplyResult(base).entryPriceUsd, "0.1");
  assert.throws(
    () => parseSupplyScaleApplyResult({ ...base, amountTokens: "0.000" }),
    /accounting evidence/,
  );
  assert.equal(
    parseSupplyScaleApplyResult({
      ...base,
      applied: false,
      replay: true,
      reason: "already_applied",
      amountRemaining: "0",
    }).amountRemaining,
    "0",
    "an idempotent replay remains valid after later exits close the position",
  );
  assert.throws(
    () => parseSupplyScaleApplyResult({ ...base, amountRemaining: "0" }),
    /accounting evidence/,
  );
  assert.throws(() => parseSupplyScaleApplyResult({ ...base, amountTokens: 1 }), /amountTokens/);
});
