import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSupplyAccumulationState,
  SupplyAccumulationStore,
} from "./supply-accumulation-store.js";

const state = {
  ok: true,
  reason: "ready",
  userId: "user",
  tokenMint: "mint",
  modeEnabled: true,
  windowSeconds: 600,
  asOf: new Date(0).toISOString(),
  windowStartedAt: new Date(0).toISOString(),
  totalSupplyRaw: "1000",
  decimals: 6,
  grossBuyRaw: "100",
  grossSellRaw: "0",
  netAcquiredRaw: "100",
  netSupplyBps: 1000,
  netSupplyPct: 10,
  buyCount: 2,
  sellCount: 0,
  rootWallets: ["root"],
  lastEventKey: "event",
  lastEventAt: new Date(0).toISOString(),
  lastEventSlot: "1",
  latestMarketCapUsd: 14999,
  valuationSlot: "1",
  marketDataReliable: true,
  pumpFunVerified: true,
  classificationReliable: true,
  payloadConflict: false,
  dataReliable: true,
  directSettlementSeen: false,
  thresholdPct: 10,
  thresholdReached: true,
  maxMarketCapUsd: 15000,
  underMarketCap: true,
  entryReady: true,
};

test("strict state parser preserves exact raw strings", () => {
  assert.deepEqual(parseSupplyAccumulationState(state), state);
});

test("malformed RPC responses fail closed", () => {
  assert.throws(() => parseSupplyAccumulationState(null), /malformed/);
  assert.throws(() => parseSupplyAccumulationState({ ...state, netAcquiredRaw: 100 }), /malformed/);
  assert.throws(() => parseSupplyAccumulationState({ ...state, entryReady: "true" }), /missing/);
  assert.throws(() => parseSupplyAccumulationState({ ...state, decimals: 6.5 }), /decimals/);
});

const trigger = { txSig: "trigger-sig", slot: 77, targetWallet: "root" };

function custodyGateStore(data: unknown, errorMessage?: string) {
  const client = {
    from: () => {
      throw new Error("custody gate must use its atomic RPC");
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      assert.equal(name, "check_supply_accumulation_custody_gate");
      assert.deepEqual(args, {
        p_user_id: "user",
        p_token_mint: "mint",
        p_window_started_at: new Date(0).toISOString(),
        p_trigger_tx_sig: trigger.txSig,
        p_trigger_slot: trigger.slot,
        p_target_wallet: trigger.targetWallet,
      });
      return { data, error: errorMessage ? { message: errorMessage } : null };
    },
  };
  return new SupplyAccumulationStore(client as never, "user");
}

test("custody gate delegates the trigger proof and observer health check atomically", async () => {
  assert.deepEqual(
    await custodyGateStore({ safe: true, reason: "custody_safe" }).custodyDistributionGate(
      "mint",
      new Date(0).toISOString(),
      trigger,
    ),
    { safe: true, reason: "custody_safe" },
  );
  assert.deepEqual(
    await custodyGateStore({
      safe: false,
      reason: "verified_custody_sell_seen",
    }).custodyDistributionGate("mint", new Date(0).toISOString(), trigger),
    { safe: false, reason: "verified_custody_sell_seen" },
  );
  await assert.rejects(
    custodyGateStore(null).custodyDistributionGate("mint", new Date(0).toISOString(), trigger),
    /malformed/,
  );
  await assert.rejects(
    custodyGateStore(
      { safe: false, reason: "custody_backlog" },
      "database unavailable",
    ).custodyDistributionGate("mint", new Date(0).toISOString(), trigger),
    /database unavailable/,
  );
});

function sellStore(rows: Record<string, unknown>[]) {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq", "gte", "order", "limit"]) query[method] = () => query;
  query.then = (resolve: (value: { data: Record<string, unknown>[]; error: null }) => unknown) =>
    Promise.resolve({ data: rows, error: null }).then(resolve);
  return new SupplyAccumulationStore(
    {
      from: (table: string) => {
        assert.equal(table, "supply_accumulation_events");
        return query;
      },
      rpc: async () => ({ data: null, error: null }),
    } as never,
    "user",
  );
}

test("durable sell recovery preserves exact raw attribution evidence", async () => {
  const eventAt = new Date(1_000).toISOString();
  assert.deepEqual(
    await sellStore([
      {
        target_wallet: "root",
        token_mint: "mint",
        tx_sig: "sell-sig",
        slot: 80,
        event_at: eventAt,
        decimals: 6,
        metadata: {
          amountRaw: "2500000",
          tokenBalanceBeforeRaw: "10000000",
          tokenBalanceAfterRaw: "7500000",
          soldAmountRaw: "2500000",
        },
      },
      {
        target_wallet: "root-two",
        token_mint: "mint",
        tx_sig: "sell-sig-two",
        slot: 81,
        event_at: new Date(2_000).toISOString(),
        decimals: 6,
        metadata: {
          amountRaw: "1000000",
          tokenBalanceBeforeRaw: "7500000",
          tokenBalanceAfterRaw: "6500000",
          soldAmountRaw: "1000000",
        },
      },
    ]).verifiedSellsAfter("mint", 77),
    [
      {
        targetWallet: "root",
        tokenMint: "mint",
        txSig: "sell-sig",
        slot: 80,
        eventAtMs: 1_000,
        amountRaw: "2500000",
        decimals: 6,
        tokenBalanceBeforeRaw: "10000000",
        tokenBalanceAfterRaw: "7500000",
        soldAmountRaw: "2500000",
      },
      {
        targetWallet: "root-two",
        tokenMint: "mint",
        txSig: "sell-sig-two",
        slot: 81,
        eventAtMs: 2_000,
        amountRaw: "1000000",
        decimals: 6,
        tokenBalanceBeforeRaw: "7500000",
        tokenBalanceAfterRaw: "6500000",
        soldAmountRaw: "1000000",
      },
    ],
  );
  await assert.rejects(
    sellStore([
      {
        target_wallet: "root",
        token_mint: "mint",
        tx_sig: "sell-sig",
        slot: 80,
        event_at: eventAt,
        decimals: 6,
        metadata: {
          amountRaw: "-1",
          tokenBalanceBeforeRaw: "10",
          tokenBalanceAfterRaw: "9",
          soldAmountRaw: "1",
        },
      },
    ]).verifiedSellsAfter("mint", 77),
    /malformed/,
  );
  await assert.rejects(
    sellStore(Array.from({ length: 1_001 }, () => ({}))).verifiedSellsAfter("mint", 77),
    /safe recovery bound/,
  );
});
