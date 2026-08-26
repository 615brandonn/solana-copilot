import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { SellClaimRecoveryStore, parseSellRecoveryClaim } from "./sell-claim-recovery-store.js";

const USER = "00000000-0000-4000-8000-000000000001";
const CLAIM = "00000000-0000-4000-8000-000000000002";
const POSITION = "00000000-0000-4000-8000-000000000003";
const SIG = "prepared-signature";
const BLOCKHASH = "recent-blockhash";
const SOLD = "900719925474099312345";
const PRE = "900719925474099312362";
const POST = "17";

type Response = { data: unknown; error: { message: string } | null };
type Trace = { method: string; args: unknown[] };

class FakeQuery implements PromiseLike<Response> {
  readonly trace: Trace[] = [];
  constructor(
    readonly operation: "select" | "update",
    readonly payload: Record<string, unknown> | null,
    private readonly response: Response,
  ) {}
  private call(method: string, ...args: unknown[]): this {
    this.trace.push({ method, args });
    return this;
  }
  select(...args: unknown[]) {
    return this.call("select", ...args);
  }
  eq(...args: unknown[]) {
    return this.call("eq", ...args);
  }
  is(...args: unknown[]) {
    return this.call("is", ...args);
  }
  in(...args: unknown[]) {
    return this.call("in", ...args);
  }
  order(...args: unknown[]) {
    return this.call("order", ...args);
  }
  limit(...args: unknown[]) {
    return this.call("limit", ...args);
  }
  maybeSingle() {
    return this.call("maybeSingle");
  }
  then<TResult1 = Response, TResult2 = never>(
    onfulfilled?: ((value: Response) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.response).then(onfulfilled, onrejected);
  }
}

class FakeClient {
  readonly rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  readonly queries: FakeQuery[] = [];
  rpcResponse: Response = { data: null, error: null };
  queryResponse: Response = { data: null, error: null };
  rpc(name: string, args: Record<string, unknown>) {
    this.rpcCalls.push({ name, args });
    return Promise.resolve(this.rpcResponse);
  }
  from(table: string) {
    assert.equal(table, "sell_signal_claims");
    return {
      select: (...args: unknown[]) => {
        const query = new FakeQuery("select", null, this.queryResponse);
        this.queries.push(query);
        return query.select(...args);
      },
      update: (payload: Record<string, unknown>) => {
        const query = new FakeQuery("update", payload, this.queryResponse);
        this.queries.push(query);
        return query;
      },
    };
  }
}

function hasTrace(query: FakeQuery, method: string, ...args: unknown[]): boolean {
  return query.trace.some(
    (entry) => entry.method === method && isDeepStrictEqual(entry.args, args),
  );
}

function signedClaim(status: "submitted" | "uncertain" = "submitted") {
  return {
    id: CLAIM,
    user_id: USER,
    position_id: POSITION,
    status,
    bot_tx_sig: SIG,
    recovery_version: 1,
    token_decimals: 6,
    executed_sell_amount_raw: SOLD,
    prepared_wallet_balance_raw: PRE,
    position_amount_before_raw: PRE,
    recent_blockhash: BLOCKHASH,
    last_valid_block_height: "9007199254740993",
    receipt_pre_amount_raw: null,
    receipt_post_amount_raw: null,
    trade_id: null,
    submission_started_at: "2026-08-26T10:00:00Z",
    created_at: "2026-08-26T09:59:59Z",
    updated_at: "2026-08-26T10:00:00Z",
  };
}

test("claim parser preserves every exact integer as text", () => {
  const claim = parseSellRecoveryClaim(signedClaim());
  assert.equal(claim.executedSellAmountRaw, SOLD);
  assert.equal(claim.preparedWalletBalanceRaw, PRE);
  assert.equal(claim.lastValidBlockHeight, "9007199254740993");
});

test("prepare publishes signature, blockhash, expiry, and exact raw values in one RPC", async () => {
  const client = new FakeClient();
  client.rpcResponse = {
    data: { prepared: true, reason: "attempt_prepared", positionAmountBeforeRaw: PRE },
    error: null,
  };
  const store = new SellClaimRecoveryStore(client as never, USER);
  await store.prepare(CLAIM, {
    txSig: SIG,
    recentBlockhash: BLOCKHASH,
    lastValidBlockHeight: 345_000_000,
    executedSellAmountRaw: SOLD,
    preparedWalletBalanceRaw: PRE,
    positionAmountBeforeRaw: PRE,
    tokenDecimals: 6,
  });
  assert.deepEqual(client.rpcCalls, [
    {
      name: "prepare_sell_claim_attempt_v1",
      args: {
        p_user_id: USER,
        p_claim_id: CLAIM,
        p_bot_tx_sig: SIG,
        p_recent_blockhash: BLOCKHASH,
        p_last_valid_block_height: 345_000_000,
        p_executed_sell_amount_raw: SOLD,
        p_prepared_wallet_balance_raw: PRE,
        p_position_amount_before_raw: PRE,
        p_token_decimals: 6,
      },
    },
  ]);
});

test("final authorization is bound to the exact submitted v1 signature", async () => {
  const client = new FakeClient();
  client.queryResponse = { data: { id: CLAIM }, error: null };
  const store = new SellClaimRecoveryStore(client as never, USER);
  assert.equal(await store.authorize(CLAIM, SIG), true);
  const query = client.queries[0]!;
  for (const [column, value] of [
    ["id", CLAIM],
    ["user_id", USER],
    ["status", "submitted"],
    ["recovery_version", 1],
    ["bot_tx_sig", SIG],
  ] as const) {
    assert.ok(hasTrace(query, "eq", column, value));
  }
});

test("atomic apply sends the exact finalized debit and accepts lost-response replay", async () => {
  const client = new FakeClient();
  client.rpcResponse = {
    data: {
      applied: false,
      replay: true,
      reason: "already_applied",
      closed: true,
      amountRemaining: "0",
      tradeId: "trade-id",
    },
    error: null,
  };
  const store = new SellClaimRecoveryStore(client as never, USER);
  const result = await store.apply(
    CLAIM,
    SIG,
    { amountRaw: SOLD, preAmountRaw: PRE, postAmountRaw: POST, decimals: 6 },
    "rpc",
    123,
    null,
  );
  assert.equal(result.replay, true);
  assert.equal(result.closed, true);
  assert.deepEqual(client.rpcCalls[0], {
    name: "apply_landed_sell_claim_v1",
    args: {
      p_user_id: USER,
      p_claim_id: CLAIM,
      p_bot_tx_sig: SIG,
      p_sold_amount_raw: SOLD,
      p_receipt_pre_amount_raw: PRE,
      p_receipt_post_amount_raw: POST,
      p_token_decimals: 6,
      p_route: "rpc",
      p_latency_ms: 123,
      p_exit_price_usd: null,
    },
  });
});

test("receipt mismatch is rejected before the database can mutate accounting", async () => {
  const client = new FakeClient();
  const store = new SellClaimRecoveryStore(client as never, USER);
  await assert.rejects(
    store.apply(
      CLAIM,
      SIG,
      { amountRaw: SOLD, preAmountRaw: PRE, postAmountRaw: "18", decimals: 6 },
      null,
      null,
      null,
    ),
    /delta does not match/,
  );
  assert.equal(client.rpcCalls.length, 0);
});

test("failure and uncertainty updates retain exact CAS ownership", async () => {
  const client = new FakeClient();
  client.queryResponse = { data: { id: CLAIM }, error: null };
  const store = new SellClaimRecoveryStore(client as never, USER);
  assert.equal(
    await store.markFailure(parseSellRecoveryClaim(signedClaim()), "finalized-failure"),
    true,
  );
  let query = client.queries[0]!;
  assert.ok(hasTrace(query, "eq", "status", "submitted"));
  assert.ok(hasTrace(query, "eq", "bot_tx_sig", SIG));

  assert.equal(await store.markUncertain(CLAIM, SIG, "not-finalized"), true);
  query = client.queries[1]!;
  assert.ok(hasTrace(query, "eq", "status", "submitted"));
  assert.ok(hasTrace(query, "eq", "recovery_version", 1));
  assert.ok(hasTrace(query, "eq", "bot_tx_sig", SIG));
});
