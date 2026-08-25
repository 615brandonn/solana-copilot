import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import type { SwapEvent, TransferEvent } from "./geyser.js";
import { CustodyRuntime, isVerifiedCustodySell } from "./custody-runtime.js";
import type { CustodyRecordResult, CustodyStore } from "./custody-types.js";
import type { UnresolvedOutflowEvent } from "./poller.js";

const result: CustodyRecordResult = {
  applied: true,
  duplicate: false,
  payloadMismatch: false,
  reason: "applied",
  journeyId: "journey",
  eventId: "event",
  journeyStatus: "active",
  appliedAmountTokens: 10,
  watchedWallets: [],
  releasedWallets: [],
  journeyReleased: false,
};

function swap(overrides: Partial<SwapEvent> = {}): SwapEvent {
  return {
    kind: "swap",
    wallet: "target",
    side: "buy",
    tokenMint: "mint",
    amountTokens: 10,
    decimals: 6,
    solDelta: -1,
    slot: 1,
    txSig: "tx",
    timestampMs: 1_000,
    isPumpFun: false,
    verifiedSwap: true,
    ...overrides,
  };
}

function transfer(overrides: Partial<TransferEvent> = {}): TransferEvent {
  return {
    kind: "transfer",
    from: "target",
    to: "recipient",
    tokenMint: "mint",
    amountTokens: 10,
    decimals: 6,
    slot: 2,
    txSig: "transfer-tx",
    timestampMs: 2_000,
    recipients: [{ wallet: "recipient", amountTokens: 10, recipientPreAmount: 5 }],
    ...overrides,
  };
}

function unresolved(overrides: Partial<UnresolvedOutflowEvent> = {}): UnresolvedOutflowEvent {
  return {
    kind: "unresolved_outflow",
    wallet: "target",
    tokenMint: "mint",
    amountTokens: 5,
    amountRaw: "5000000",
    preAmount: 10,
    postAmount: 5,
    preRaw: "10000000",
    postRaw: "5000000",
    decimals: 6,
    slot: 3,
    txSig: "unresolved-tx",
    timestampMs: 3_000,
    reason: "negative_token_delta_not_attributed",
    ...overrides,
  };
}

function fakeStore() {
  const calls = {
    buys: 0,
    transfers: 0,
    sells: 0,
    unresolved: 0,
    transferRecipients: 0,
    scopeChecks: 0,
  };
  let activeAttribution = true;
  const store: CustodyStore = {
    async recordTargetBuy() {
      calls.buys += 1;
      return result;
    },
    async recordTransfer(_event, recipients) {
      calls.transfers += 1;
      calls.transferRecipients += recipients.length;
      return result;
    },
    async recordVerifiedSell() {
      calls.sells += 1;
      return result;
    },
    async recordUnresolvedOutflow() {
      calls.unresolved += 1;
      return result;
    },
    async hasActiveAttribution() {
      calls.scopeChecks += 1;
      return activeAttribution;
    },
    async loadActiveWatches() {
      return [];
    },
    async backfillMissingJourneys() {
      return 0;
    },
    async replayPending() {
      return {
        processedCount: 0,
        appliedCount: 0,
        pendingCount: 0,
        expiredCount: 0,
        terminalCount: 0,
        results: [],
      };
    },
  };
  return {
    store,
    calls,
    setActiveAttribution(value: boolean) {
      activeAttribution = value;
    },
  };
}

test("Entries state is absent and an enabled verified target buy starts observation", async () => {
  const { store, calls } = fakeStore();
  const runtime = new CustodyRuntime(store, { getAccountInfo: async () => null } as never);
  await runtime.observe(swap(), { enabled: true, targetWallets: new Set(["target"]) });
  assert.equal(calls.buys, 1);
  assert.equal(calls.transfers, 0);
  assert.equal(calls.sells, 0);
});

test("disabled, unverified, and non-target buys fail closed", async () => {
  const { store, calls } = fakeStore();
  const runtime = new CustodyRuntime(store, { getAccountInfo: async () => null } as never);
  await runtime.observe(swap(), { enabled: false, targetWallets: new Set(["target"]) });
  await runtime.observe(swap({ verifiedSwap: false }), {
    enabled: true,
    targetWallets: new Set(["target"]),
  });
  await runtime.observe(swap({ wallet: "other" }), {
    enabled: true,
    targetWallets: new Set(["target"]),
  });
  assert.deepEqual(calls, {
    buys: 0,
    transfers: 0,
    sells: 0,
    unresolved: 0,
    transferRecipients: 0,
    scopeChecks: 0,
  });
});

test("unattributed negative deltas use custody scope and durable unresolved persistence", async () => {
  const { store, calls, setActiveAttribution } = fakeStore();
  setActiveAttribution(false);
  const runtime = new CustodyRuntime(store, { getAccountInfo: async () => null } as never);

  await runtime.observeUnresolvedOutflow(unresolved(), {
    enabled: true,
    targetWallets: new Set(["target"]),
  });
  await runtime.observeUnresolvedOutflow(unresolved({ wallet: "unrelated", txSig: "ignored" }), {
    enabled: true,
    targetWallets: new Set(["target"]),
  });
  await runtime.observeUnresolvedOutflow(unresolved({ txSig: "disabled" }), {
    enabled: false,
    targetWallets: new Set(["target"]),
  });

  runtime.reconcileActiveWatches([
    { journeyId: "journey-x", wallet: "shared", tokenMint: "mint-x", anchorSlot: 1 },
  ]);
  await runtime.observeUnresolvedOutflow(
    unresolved({ wallet: "shared", tokenMint: "mint-y", txSig: "cross-mint" }),
    { enabled: true, targetWallets: new Set(["target"]) },
  );

  assert.equal(calls.unresolved, 2);
  assert.equal(calls.scopeChecks, 1);
});

test("exact raw amount controls custody positivity when the UI amount is lossy", async () => {
  const { store, calls } = fakeStore();
  const runtime = new CustodyRuntime(store, { getAccountInfo: async () => null } as never);
  await runtime.observe(swap({ amountTokens: 0, amountRaw: "1" }), {
    enabled: true,
    targetWallets: new Set(["target"]),
  });
  await runtime.observe(swap({ amountTokens: 10, amountRaw: "0", txSig: "zero-raw" }), {
    enabled: true,
    targetWallets: new Set(["target"]),
  });
  assert.equal(calls.buys, 1);
});

test("ordinary transfers stay transfers and never become sells", async () => {
  const { store, calls } = fakeStore();
  const runtime = new CustodyRuntime(store, { getAccountInfo: async () => null } as never);
  await runtime.observe(transfer(), { enabled: true, targetWallets: new Set(["target"]) });
  assert.equal(calls.transfers, 1);
  assert.equal(calls.sells, 0);
});

test("a totally unrelated wallet and mint never enter durable custody persistence", async () => {
  const recipient = Keypair.generate().publicKey.toBase58();
  const { store, calls, setActiveAttribution } = fakeStore();
  setActiveAttribution(false);
  let lookups = 0;
  const runtime = new CustodyRuntime(store, {
    getAccountInfo: async () => {
      lookups += 1;
      return null;
    },
  } as never);
  const transferResult = await runtime.observe(
    transfer({
      from: "unrelated",
      to: recipient,
      recipients: [{ wallet: recipient, amountTokens: 10 }],
    }),
    { enabled: true, targetWallets: new Set(["target"]) },
  );
  const sellResult = await runtime.observe(
    swap({
      wallet: "unrelated",
      side: "sell",
      sellAttribution: { verified: true, signerCount: 1 },
    }),
    { enabled: true, targetWallets: new Set(["target"]) },
  );
  assert.equal(transferResult, null);
  assert.equal(sellResult, null);
  assert.equal(calls.transfers, 0);
  assert.equal(calls.sells, 0);
  assert.equal(calls.scopeChecks, 2);
  assert.equal(lookups, 0);
});

test("configured targets stage new-mint transfers and sells for a later verified buy", async () => {
  const { store, calls, setActiveAttribution } = fakeStore();
  setActiveAttribution(false);
  const runtime = new CustodyRuntime(store, { getAccountInfo: async () => null } as never);
  await runtime.observe(transfer(), { enabled: true, targetWallets: new Set(["target"]) });
  await runtime.observe(
    swap({ side: "sell", sellAttribution: { verified: true, signerCount: 1 } }),
    { enabled: true, targetWallets: new Set(["target"]) },
  );
  assert.equal(calls.transfers, 1);
  assert.equal(calls.sells, 1);
  assert.equal(calls.scopeChecks, 0);
});

test("a wallet watched for one mint stages another mint until upstream attribution arrives", async () => {
  const { store, calls, setActiveAttribution } = fakeStore();
  setActiveAttribution(false);
  const runtime = new CustodyRuntime(store, { getAccountInfo: async () => null } as never);
  runtime.reconcileActiveWatches([
    { journeyId: "journey-x", wallet: "shared", tokenMint: "mint-x", anchorSlot: 1 },
  ]);
  await runtime.observe(transfer({ from: "shared", tokenMint: "mint-y" }), {
    enabled: true,
    targetWallets: new Set(["target"]),
  });
  await runtime.observe(
    swap({
      wallet: "shared",
      tokenMint: "mint-y",
      side: "sell",
      sellAttribution: { verified: true, signerCount: 1 },
    }),
    { enabled: true, targetWallets: new Set(["target"]) },
  );
  assert.equal(calls.transfers, 1);
  assert.equal(calls.sells, 1);
  assert.equal(calls.scopeChecks, 0);
});

test("a durable target buy opens its wallet+mint scope before same-transaction forwarding", async () => {
  const { store, calls, setActiveAttribution } = fakeStore();
  setActiveAttribution(false);
  const runtime = new CustodyRuntime(store, { getAccountInfo: async () => null } as never);
  await runtime.observe(swap({ txSig: "same-tx" }), {
    enabled: true,
    targetWallets: new Set(["target"]),
  });
  await runtime.observe(transfer({ txSig: "same-tx", sameTransactionAcquisition: true }), {
    enabled: true,
    targetWallets: new Set(["target"]),
  });
  assert.equal(calls.buys, 1);
  assert.equal(calls.transfers, 1);
  assert.equal(calls.scopeChecks, 0);
});

test("loaded wallet+mint scope preserves downstream-before-upstream pending replay", async () => {
  const { store, calls, setActiveAttribution } = fakeStore();
  setActiveAttribution(false);
  const runtime = new CustodyRuntime(store, { getAccountInfo: async () => null } as never);
  runtime.reconcileActiveWatches([
    { journeyId: "journey", wallet: "target", tokenMint: "mint", anchorSlot: 1 },
  ]);
  await runtime.observe(transfer(), { enabled: true, targetWallets: new Set(["target"]) });
  assert.equal(calls.transfers, 1);
  assert.equal(calls.scopeChecks, 0);
});

test("a transient classifier outage leaves the event retryable instead of truncating custody", async () => {
  const recipient = Keypair.generate().publicKey.toBase58();
  let persisted = false;
  const { store } = fakeStore();
  store.recordTransfer = async (_event, recipients) => {
    persisted = recipients.length > 0;
    return result;
  };
  const runtime = new CustodyRuntime(store, {
    getAccountInfo: async () => {
      throw new Error("temporary provider failure");
    },
  } as never);
  await assert.rejects(
    runtime.observe(
      transfer({
        to: recipient,
        recipients: [{ wallet: recipient, amountTokens: 10 }],
      }),
      { enabled: true, targetWallets: new Set(["target"]) },
    ),
    /classification unavailable/,
  );
  assert.equal(persisted, false);
});

test("a hung classifier lookup is bounded and rejects so the confirmed cursor retries", async () => {
  const recipient = Keypair.generate().publicKey.toBase58();
  const { store, calls } = fakeStore();
  const runtime = new CustodyRuntime(
    store,
    { getAccountInfo: async () => new Promise<never>(() => undefined) } as never,
    () => undefined,
    { classificationLookupTimeoutMs: 20 },
  );
  const startedAt = Date.now();
  await assert.rejects(
    runtime.observe(
      transfer({ to: recipient, recipients: [{ wallet: recipient, amountTokens: 10 }] }),
      { enabled: true, targetWallets: new Set(["target"]) },
    ),
    /classification unavailable/,
  );
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(calls.transfers, 0);
});

test("a one-raw-unit transfer is not discarded by floating-point epsilon", async () => {
  const { store, calls } = fakeStore();
  const runtime = new CustodyRuntime(store, { getAccountInfo: async () => null } as never);
  await runtime.observe(
    transfer({
      amountTokens: 1e-18,
      recipients: [
        {
          wallet: "recipient",
          amountTokens: 1e-18,
          amountRaw: "1",
          recipientPreRaw: "9007199254740992000",
          recipientPostRaw: "9007199254740992001",
        },
      ],
    }),
    { enabled: true, targetWallets: new Set(["target"]) },
  );
  assert.equal(calls.transfers, 1);
  assert.equal(calls.transferRecipients, 1);
});

test("only strict verified sell attribution closes attributed custody", async () => {
  assert.equal(isVerifiedCustodySell(swap({ side: "sell" })), false);
  const verified = swap({
    side: "sell",
    sellAttribution: { verified: true, signerCount: 1 },
  });
  assert.equal(isVerifiedCustodySell(verified), true);
  const { store, calls } = fakeStore();
  const runtime = new CustodyRuntime(store, { getAccountInfo: async () => null } as never);
  await runtime.observe(verified, { enabled: true, targetWallets: new Set(["target"]) });
  assert.equal(calls.sells, 1);
});
