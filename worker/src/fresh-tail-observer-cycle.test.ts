import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConfirmedSignatureInfo,
  Connection,
  ParsedTransactionWithMeta,
} from "@solana/web3.js";
import { FreshTailObserver, type FreshTailObserverConfig } from "./fresh-tail-observer.js";
import type {
  FreshTailActiveEpoch,
  FreshTailCursorWrite,
  FreshTailLease,
  FreshTailMutationResult,
  FreshTailStore,
  FreshTailWork,
  FreshTailWorkCursor,
  FreshTailWorkMint,
  FreshTailWorkRequest,
} from "./fresh-tail-store.js";

const EPOCH_ID = "00000000-0000-4000-8000-000000000001";
const LEASE_ONE = "00000000-0000-4000-8000-000000000101";
const LEASE_TWO = "00000000-0000-4000-8000-000000000102";
const REQUEST_ID = "00000000-0000-4000-8000-000000000201";
const BASE_TIME_MS = 1_787_600_000_000;
const ROOT_BUY_SLOT = 110;
const CHILD_EVENT_SLOT = 111;
const ROOT_BUY_SIGNATURE = "root-buy-signature";
const CHILD_EVENT_SIGNATURE = "child-event-signature";
const MINT = "So11111111111111111111111111111111111111112";
const DESCENDANT = "Stake11111111111111111111111111111111111111";
const ROOTS = [
  "11111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "SysvarRent111111111111111111111111111111111",
].sort() as [string, string, string];

const CONFIG: FreshTailObserverConfig = {
  observerEnabled: true,
  entriesEnabled: false,
  shadow: true,
  rootWallets: ROOTS,
  windowSeconds: 30,
};

function ok(reason: string, fields: Record<string, unknown> = {}): FreshTailMutationResult {
  return { ok: true, reason, ...fields };
}

function signature(value: string, slot: number, blockTime: number): ConfirmedSignatureInfo {
  return {
    signature: value,
    slot,
    blockTime,
    confirmationStatus: "finalized",
    err: null,
    memo: null,
  };
}

function transaction(value: string, slot: number, blockTime: number): ParsedTransactionWithMeta {
  return {
    slot,
    blockTime,
    meta: { err: null } as ParsedTransactionWithMeta["meta"],
    transaction: {
      signatures: [value],
      message: { accountKeys: [], instructions: [], recentBlockhash: "hash" } as never,
    },
  } as ParsedTransactionWithMeta;
}

type HeadDefinition = { blockhash: string; blockTime: number };

class FinalizedRpc {
  readonly calls: string[] = [];
  private readonly sampledSlots = [100, 120, 120, 121];
  private sampleIndex = 0;

  private readonly heads = new Map<number, HeadDefinition>([
    [100, { blockhash: "block-100", blockTime: BASE_TIME_MS / 1_000 - 20 }],
    [120, { blockhash: "block-120", blockTime: BASE_TIME_MS / 1_000 - 1 }],
    [121, { blockhash: "block-121", blockTime: BASE_TIME_MS / 1_000 }],
  ]);

  async getSlot(): Promise<number> {
    const slot = this.sampledSlots[this.sampleIndex++] ?? 200;
    this.calls.push(`head:${slot}`);
    return slot;
  }

  async getBlock(slot: number): Promise<HeadDefinition | null> {
    this.calls.push(`block:${slot}`);
    return this.heads.get(slot) ?? null;
  }

  async getFirstAvailableBlock(): Promise<number> {
    return 1;
  }

  async getSignaturesForAddress(
    wallet: { toBase58(): string },
    options: { before?: string },
  ): Promise<ConfirmedSignatureInfo[]> {
    const address = wallet.toBase58();
    this.calls.push(`scan:${address}:${options.before ?? "floor"}`);
    if (address === ROOTS[0]) {
      if (options.before === ROOT_BUY_SIGNATURE) return [];
      return [
        signature(ROOT_BUY_SIGNATURE, ROOT_BUY_SLOT, BASE_TIME_MS / 1_000 - 10),
        signature("root-floor", 100, BASE_TIME_MS / 1_000 - 20),
      ];
    }
    if (address === DESCENDANT) {
      if (options.before === CHILD_EVENT_SIGNATURE) return [];
      return [
        signature(CHILD_EVENT_SIGNATURE, CHILD_EVENT_SLOT, BASE_TIME_MS / 1_000 - 9),
        signature("child-floor", ROOT_BUY_SLOT - 1, BASE_TIME_MS / 1_000 - 11),
      ];
    }
    return [];
  }

  async getParsedTransactions(signatures: string[]): Promise<ParsedTransactionWithMeta[]> {
    this.calls.push(`load:${signatures.join(",")}`);
    return signatures.map((value) => {
      if (value === ROOT_BUY_SIGNATURE) {
        return transaction(value, ROOT_BUY_SLOT, BASE_TIME_MS / 1_000 - 10);
      }
      assert.equal(value, CHILD_EVENT_SIGNATURE);
      return transaction(value, CHILD_EVENT_SLOT, BASE_TIME_MS / 1_000 - 9);
    });
  }
}

class ManualScheduler {
  private nextHandle = 1;
  private readonly callbacks = new Map<number, () => void>();

  get activeCount(): number {
    return this.callbacks.size;
  }

  setInterval(callback: () => void, delayMs: number): number {
    assert.equal(delayMs, 4_000);
    const handle = this.nextHandle++;
    this.callbacks.set(handle, callback);
    return handle;
  }

  clearInterval(handle: unknown): void {
    assert.equal(typeof handle, "number");
    this.callbacks.delete(handle as number);
  }

  async fireAll(): Promise<void> {
    for (const callback of [...this.callbacks.values()]) callback();
    // The keepalive deliberately does not expose its in-flight promise. Drain
    // the immediate fake-store continuation and its identity/finally checks.
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  }
}

class DurableFreshTailStore {
  readonly calls: string[] = [];
  readonly settleGenerations: number[] = [];
  readonly heartbeats: Array<{ generation: number; head: number; worker: string }> = [];
  readonly acquisitions: Array<{
    worker: string;
    expectedToken: string | null;
    expectedGeneration: number | null;
    outcome: "leased" | "renewed" | "busy";
  }> = [];

  private epoch: FreshTailActiveEpoch | null = null;
  private lease: (FreshTailLease & { owner: string }) | null = null;
  private latestHead: { slot: number; blockhash: string; blockTime: string } | null = null;
  private mint: FreshTailWorkMint | null = null;
  private request: FreshTailWorkRequest | null = null;
  private scopeDirty = false;
  private rootIngested = false;
  private rejectNextRenewal = false;
  private delayedRenewal: {
    started: () => void;
    released: Promise<void>;
  } | null = null;
  private readonly cursors = new Map<string, FreshTailWorkCursor>();

  constructor(private readonly nowMs: () => number) {}

  rejectKeepaliveOnce(): void {
    this.rejectNextRenewal = true;
  }

  delayKeepaliveOnce(): { started: Promise<void>; release: () => void } {
    assert.equal(this.delayedRenewal, null);
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.delayedRenewal = { started: markStarted, released };
    return { started, release };
  }

  private cursorKey(scopeMint: string, wallet: string): string {
    return `${scopeMint}:${wallet}`;
  }

  private assertLease(input: FreshTailLease): void {
    assert.ok(this.lease, "a mutation was attempted without a durable lease");
    assert.equal(input.epochId, EPOCH_ID);
    assert.equal(input.leaseToken, this.lease.leaseToken);
    assert.equal(input.leaseGeneration, this.lease.leaseGeneration);
    assert.ok(Date.parse(this.lease.leaseExpiresAt) > this.nowMs(), "lease expired");
  }

  private snapshotEpoch(): FreshTailActiveEpoch | null {
    if (!this.epoch) return null;
    return {
      ...this.epoch,
      rootWallets: [...this.epoch.rootWallets] as [string, string, string],
      leaseOwner: this.lease?.owner ?? null,
      leaseGeneration: this.lease?.leaseGeneration ?? this.epoch.leaseGeneration,
      leaseExpiresAt: this.lease?.leaseExpiresAt ?? null,
    };
  }

  async loadActiveEpoch(): Promise<FreshTailActiveEpoch | null> {
    this.calls.push("load_epoch");
    return this.snapshotEpoch();
  }

  async activate(
    rootWallets: readonly string[],
    activation: { slot: number; blockhash: string; blockTimeMs: number },
  ): Promise<FreshTailMutationResult> {
    assert.equal(this.epoch, null);
    assert.deepEqual(rootWallets, ROOTS);
    this.calls.push("activate");
    this.epoch = {
      epochId: EPOCH_ID,
      activationSlot: activation.slot,
      activationBlockhash: activation.blockhash,
      activationBlockTime: new Date(activation.blockTimeMs).toISOString(),
      rootWallets: [...ROOTS],
      rootFingerprint: "a".repeat(64),
      scopeRevision: 0,
      leaseOwner: null,
      leaseGeneration: 0,
      leaseExpiresAt: null,
      status: "active",
    };
    ROOTS.forEach((wallet, index) => {
      this.cursors.set(this.cursorKey("*", wallet), {
        scopeMint: "*",
        wallet,
        role: "root",
        floorSlot: activation.slot,
        initialBoundaryKind: "exclusive_slot",
        boundaryKind: "exclusive_slot",
        lastSignature: null,
        lastSlot: null,
        firstAvailableBlock: null,
        historyFloorProven: false,
        coveredThroughSlot: null,
        coveredThroughBlockhash: null,
        coverageRevision: 0,
        backlogDetected: false,
        lastError: null,
      });
    });
    return ok("activated", { epochId: EPOCH_ID });
  }

  async acquireLease(
    epochId: string,
    workerId: string,
    leaseSeconds: number,
    expectedLease: FreshTailLease | null,
  ): Promise<FreshTailLease | null> {
    assert.equal(epochId, EPOCH_ID);
    const expectedGeneration = expectedLease?.leaseGeneration ?? null;
    const expectedToken = expectedLease?.leaseToken ?? null;
    if (this.lease && Date.parse(this.lease.leaseExpiresAt) > this.nowMs()) {
      if (expectedLease && this.delayedRenewal) {
        const delayed = this.delayedRenewal;
        this.delayedRenewal = null;
        delayed.started();
        await delayed.released;
      }
      if (expectedLease && this.rejectNextRenewal) {
        this.rejectNextRenewal = false;
        this.acquisitions.push({
          worker: workerId,
          expectedToken,
          expectedGeneration,
          outcome: "busy",
        });
        return null;
      }
      const ownsLease =
        this.lease.owner === workerId &&
        expectedLease?.leaseToken === this.lease.leaseToken &&
        expectedLease?.leaseGeneration === this.lease.leaseGeneration;
      if (!ownsLease) {
        this.acquisitions.push({
          worker: workerId,
          expectedToken,
          expectedGeneration,
          outcome: "busy",
        });
        return null;
      }
      this.lease.leaseExpiresAt = new Date(this.nowMs() + leaseSeconds * 1_000).toISOString();
      this.acquisitions.push({
        worker: workerId,
        expectedToken,
        expectedGeneration,
        outcome: "renewed",
      });
      return { ...this.lease };
    }
    const generation = (this.lease?.leaseGeneration ?? 0) + 1;
    this.lease = {
      epochId,
      leaseToken: generation === 1 ? LEASE_ONE : LEASE_TWO,
      leaseGeneration: generation,
      leaseExpiresAt: new Date(this.nowMs() + leaseSeconds * 1_000).toISOString(),
      owner: workerId,
    };
    this.acquisitions.push({
      worker: workerId,
      expectedToken,
      expectedGeneration,
      outcome: "leased",
    });
    return { ...this.lease };
  }

  async attestHead(
    _epochId: string,
    lease: FreshTailLease,
    head: { slot: number; blockhash: string; blockTimeMs: number },
  ): Promise<FreshTailMutationResult> {
    this.assertLease(lease);
    this.calls.push(`attest_head:${head.slot}:g${lease.leaseGeneration}`);
    if (!this.latestHead || head.slot >= this.latestHead.slot) {
      this.latestHead = {
        slot: head.slot,
        blockhash: head.blockhash,
        blockTime: new Date(head.blockTimeMs).toISOString(),
      };
    }
    return ok("attested");
  }

  async getRetirementCandidates(
    _epochId: string,
    lease: FreshTailLease,
    _limit: number,
  ): Promise<[]> {
    this.assertLease(lease);
    return [];
  }

  async attestMintCreation(
    _epochId: string,
    lease: FreshTailLease,
  ): Promise<FreshTailMutationResult> {
    this.assertLease(lease);
    assert.equal(this.mint, null, "root enrollment must be idempotently checkpointed");
    this.calls.push("enroll_mint");
    this.mint = {
      tokenMint: MINT,
      enrollmentEventKey: "root-buy-event:0",
      enrollmentTxSig: ROOT_BUY_SIGNATURE,
      enrollmentSlot: ROOT_BUY_SLOT,
      enrollmentBlockhash: "block-110",
      enrollmentBlockTime: new Date(BASE_TIME_MS - 10_000).toISOString(),
      lastSupplyEventBlockTime: new Date(BASE_TIME_MS - 10_000).toISOString(),
      enrollmentTargetWallet: ROOTS[0],
      creationSlot: 105,
      bondingCurve: "Vote111111111111111111111111111111111111111",
      creator: ROOTS[0],
      createVariant: "create_v2_token2022",
      tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
      mintLayoutFingerprint: "b".repeat(64),
      parserAbiFingerprint: "c".repeat(64),
      totalSupplyRaw: "1000000000000000",
      decimals: 6,
      status: "active",
      scopeRevision: 0,
      poisoned: false,
      poisonReason: null,
    };
    return ok("mint_attested", { tokenMint: MINT });
  }

  async recordSupplyEvent(
    _epochId: string,
    lease: FreshTailLease,
  ): Promise<FreshTailMutationResult> {
    this.assertLease(lease);
    this.calls.push("record_exact_supply_event");
    return ok("supply_event_recorded");
  }

  async recordCustodyEvent(
    _epochId: string,
    lease: FreshTailLease,
  ): Promise<FreshTailMutationResult> {
    this.assertLease(lease);
    if (!this.rootIngested) {
      this.calls.push("record_root_custody_edge");
      this.rootIngested = true;
      this.scopeDirty = true;
      this.cursors.set(this.cursorKey(MINT, DESCENDANT), {
        scopeMint: MINT,
        wallet: DESCENDANT,
        role: "descendant",
        floorSlot: ROOT_BUY_SLOT,
        initialBoundaryKind: "inclusive_slot",
        boundaryKind: "inclusive_slot",
        lastSignature: null,
        lastSlot: null,
        firstAvailableBlock: null,
        historyFloorProven: false,
        coveredThroughSlot: null,
        coveredThroughBlockhash: null,
        coverageRevision: 1,
        backlogDetected: false,
        lastError: null,
      });
    } else {
      this.calls.push("record_descendant_exact_event");
    }
    return ok("custody_event_recorded");
  }

  async syncScope(
    _epochId: string,
    lease: FreshTailLease,
    tokenMint: string,
    expectedRevision: number,
  ): Promise<FreshTailMutationResult> {
    this.assertLease(lease);
    assert.equal(tokenMint, MINT);
    assert.ok(this.mint);
    assert.equal(expectedRevision, this.mint.scopeRevision);
    if (this.scopeDirty) {
      this.mint.scopeRevision += 1;
      this.scopeDirty = false;
    }
    this.calls.push(`sync_scope:${this.mint.scopeRevision}`);
    return ok("scope_synced", { scopeRevision: this.mint.scopeRevision });
  }

  async requestCoverage(_epochId: string, lease: FreshTailLease): Promise<FreshTailMutationResult> {
    this.assertLease(lease);
    assert.ok(this.mint);
    this.calls.push("request_coverage");
    this.request = {
      requestId: REQUEST_ID,
      tokenMint: MINT,
      status: "pending",
      triggerEventKey: "root-buy-event:0",
      triggerSlot: ROOT_BUY_SLOT,
      triggerBlockTime: new Date(BASE_TIME_MS - 10_000).toISOString(),
      // The real SQL window is 55 seconds from the trigger. The observer must
      // retain the 4-second submission reserve across a crash takeover.
      expiresAt: new Date(BASE_TIME_MS + 45_000).toISOString(),
      requestedHeadSlot: 120,
      requestedHeadBlockhash: "block-120",
      scopeRevision: this.mint.scopeRevision,
      settledRevision: null,
      settledLeaseGeneration: null,
    };
    return ok("coverage_requested", { requestId: REQUEST_ID });
  }

  async recordCursor(
    _epochId: string,
    lease: FreshTailLease,
    write: FreshTailCursorWrite,
  ): Promise<FreshTailMutationResult> {
    this.assertLease(lease);
    const key = this.cursorKey(write.scopeMint, write.wallet);
    const cursor = this.cursors.get(key);
    assert.ok(cursor, `missing cursor ${key}`);
    assert.equal(cursor.lastSignature, write.expectedLastSignature);
    cursor.lastSignature = write.nextLastSignature;
    cursor.lastSlot = write.nextLastSlot;
    cursor.firstAvailableBlock = write.firstAvailableBlock;
    cursor.historyFloorProven = true;
    cursor.coveredThroughSlot = write.coveredHead.slot;
    cursor.coveredThroughBlockhash = write.coveredHead.blockhash;
    cursor.coverageRevision = write.coverageRevision;
    cursor.boundaryKind = write.nextLastSignature ? "exact_signature" : cursor.initialBoundaryKind;
    cursor.backlogDetected = write.backlogDetected;
    cursor.lastError = write.lastError;
    this.calls.push(
      `cursor:${write.scopeMint}:${write.wallet}:${write.nextLastSignature ?? "floor"}:g${lease.leaseGeneration}`,
    );
    return ok("cursor_recorded");
  }

  async getWork(_epochId: string, lease: FreshTailLease): Promise<FreshTailWork> {
    this.assertLease(lease);
    assert.ok(this.epoch);
    const roots = ROOTS.map((wallet, index) => ({
      wallet,
      ordinal: index + 1,
      floorSlot: this.epoch!.activationSlot,
      boundaryKind: "exclusive_slot" as const,
    }));
    return {
      ok: true,
      reason: "work",
      epoch: {
        epochId: EPOCH_ID,
        activationSlot: this.epoch.activationSlot,
        activationBlockhash: this.epoch.activationBlockhash,
        status: "active",
        scopeRevision: this.mint?.scopeRevision ?? 0,
        leaseGeneration: lease.leaseGeneration,
        leaseExpiresAt: lease.leaseExpiresAt,
      },
      roots,
      latestFinalizedHead: this.latestHead
        ? {
            ...this.latestHead,
            firstLeaseGeneration: 1,
            lastLeaseGeneration: lease.leaseGeneration,
          }
        : {},
      mints: this.mint ? [{ ...this.mint }] : [],
      rejections: [],
      wallets: this.mint
        ? [
            {
              tokenMint: MINT,
              wallet: DESCENDANT,
              parentWallet: ROOTS[0],
              discoverySlot: ROOT_BUY_SLOT,
              boundaryKind: "inclusive_slot",
              watchStatus: "active",
              classificationReliable: true,
              watchable: true,
              addedRevision: 1,
            },
          ]
        : [],
      cursors: [...this.cursors.values()].map((cursor) => ({ ...cursor })),
      backscanRanges: [],
      requests: this.request ? [{ ...this.request }] : [],
      armedBindings: [],
      exitIntentHealth: {},
    };
  }

  async settleRequest(
    _epochId: string,
    lease: FreshTailLease,
    requestId: string,
    expectedRevision: number,
  ): Promise<FreshTailMutationResult> {
    this.assertLease(lease);
    assert.equal(requestId, REQUEST_ID);
    assert.ok(this.request);
    assert.equal(expectedRevision, this.request.scopeRevision);
    assert.ok(Date.parse(this.request.expiresAt) > this.nowMs(), "expired request was settled");
    this.request.status = "settled";
    this.request.settledRevision = expectedRevision;
    this.request.settledLeaseGeneration = lease.leaseGeneration;
    this.settleGenerations.push(lease.leaseGeneration);
    this.calls.push(`settle:g${lease.leaseGeneration}`);
    return ok("settled");
  }

  async retireMint(_epochId: string, lease: FreshTailLease): Promise<FreshTailMutationResult> {
    this.assertLease(lease);
    return { ok: false, reason: "mint_not_dormant" };
  }

  async saveHeartbeat(input: {
    workerId: string;
    lease: FreshTailLease;
    latestHead: { slot: number };
  }): Promise<FreshTailMutationResult> {
    this.assertLease(input.lease);
    this.heartbeats.push({
      generation: input.lease.leaseGeneration,
      head: input.latestHead.slot,
      worker: input.workerId,
    });
    this.calls.push(`heartbeat:${input.latestHead.slot}:g${input.lease.leaseGeneration}`);
    return ok("heartbeat_recorded");
  }
}

type ObserverInternals = {
  persistRootTransaction(
    transaction: ParsedTransactionWithMeta,
    row: ConfirmedSignatureInfo,
    root: string,
    contracts: Map<string, unknown>,
    contractsByCurve: Map<string, unknown>,
    revisions: Map<string, number>,
  ): Promise<Array<{ event: Record<string, unknown>; contract: Record<string, unknown> }>>;
  requestCandidate(candidate: { event: Record<string, unknown> }): Promise<void>;
  persistScopedTransaction(
    transaction: ParsedTransactionWithMeta,
    wallet: string,
    contract: Record<string, unknown>,
    roots: ReadonlySet<string>,
    head: Record<string, unknown>,
    deadlineMs: number,
    currentRevision: number,
  ): Promise<number>;
};

function observerWithMockedChainParsers(input: {
  rpc: FinalizedRpc;
  store: DurableFreshTailStore;
  workerId: string;
  nowMs: () => number;
  scheduler: ManualScheduler;
  duringRootIngestion?: () => Promise<void>;
}): FreshTailObserver {
  const observer = new FreshTailObserver({
    rpc: input.rpc as unknown as Connection,
    store: input.store as unknown as FreshTailStore,
    workerId: input.workerId,
    nowMs: input.nowMs,
    scheduler: input.scheduler,
    getSolPriceUsd: async () => ({ usd: 200, observedAtMs: input.nowMs() }),
  });
  const internals = observer as unknown as ObserverInternals;
  const observerLease = (): FreshTailLease => {
    const lease = (observer as unknown as { lease: FreshTailLease | null }).lease;
    assert.ok(lease, "observer lease disappeared before a fenced mutation");
    return lease;
  };
  internals.persistRootTransaction = async (
    tx,
    row,
    root,
    contracts,
    contractsByCurve,
    revisions,
  ) => {
    assert.equal(tx.transaction.signatures[0], ROOT_BUY_SIGNATURE);
    assert.equal(row.signature, ROOT_BUY_SIGNATURE);
    assert.equal(root, ROOTS[0]);
    await input.duringRootIngestion?.();
    const lease = observerLease();
    await input.store.attestMintCreation(EPOCH_ID, lease);
    await input.store.recordSupplyEvent(EPOCH_ID, lease);
    await input.store.recordCustodyEvent(EPOCH_ID, lease);
    const synced = await input.store.syncScope(EPOCH_ID, lease, MINT, 0);
    const revision = Number(synced.scopeRevision);
    const contract = {
      mint: MINT,
      bondingCurve: "Vote111111111111111111111111111111111111111",
      creator: ROOTS[0],
      createVariant: "create_v2_token2022",
      tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
      totalSupplyRaw: "1000000000000000",
      decimals: 6,
    };
    contracts.set(MINT, contract);
    contractsByCurve.set(contract.bondingCurve, contract);
    revisions.set(MINT, revision);
    return [
      {
        event: {
          eventKey: "root-buy-event:0",
          txSig: ROOT_BUY_SIGNATURE,
          slot: ROOT_BUY_SLOT,
          blockTimeMs: BASE_TIME_MS - 10_000,
          targetWallet: ROOTS[0],
          tokenMint: MINT,
        },
        contract,
      },
    ];
  };
  internals.requestCandidate = async () => {
    const lease = observerLease();
    await input.store.requestCoverage(EPOCH_ID, lease);
  };
  internals.persistScopedTransaction = async (
    tx,
    wallet,
    _contract,
    _roots,
    _head,
    _deadlineMs,
    currentRevision,
  ) => {
    assert.equal(tx.transaction.signatures[0], CHILD_EVENT_SIGNATURE);
    assert.equal(wallet, DESCENDANT);
    const lease = observerLease();
    await input.store.recordCustodyEvent(EPOCH_ID, lease);
    const synced = await input.store.syncScope(EPOCH_ID, lease, MINT, currentRevision);
    return Number(synced.scopeRevision);
  };
  return observer;
}

test("observer cycle is durable end-to-end and restart is fenced at the exact lease generation", async () => {
  let nowMs = BASE_TIME_MS;
  const now = () => nowMs;
  const rpc = new FinalizedRpc();
  const store = new DurableFreshTailStore(now);
  const scheduler = new ManualScheduler();
  const first = observerWithMockedChainParsers({
    rpc,
    store,
    workerId: "worker-one",
    nowMs: now,
    scheduler,
    duringRootIngestion: async () => {
      // Model a long but still actionable fixed-point cycle. The 15-second
      // lease would expire here without exact-token keepalives.
      for (let renewal = 0; renewal < 4; renewal += 1) {
        nowMs += 5_000;
        const before = store.acquisitions.length;
        await scheduler.fireAll();
        assert.equal(store.acquisitions.length, before + 1);
      }
    },
  });

  const initial = await first.cycle(CONFIG);
  assert.deepEqual(initial, {
    status: "observed",
    epochId: EPOCH_ID,
    leaseGeneration: 1,
    finalizedHeadSlot: 120,
    requestsSettled: 1,
  });
  assert.equal(nowMs, BASE_TIME_MS + 20_000);
  assert.equal(scheduler.activeCount, 0, "cycle leaked its keepalive timer");
  assert.deepEqual(
    store.acquisitions.slice(1, 5).map((row) => ({
      token: row.expectedToken,
      generation: row.expectedGeneration,
      outcome: row.outcome,
    })),
    Array.from({ length: 4 }, () => ({
      token: LEASE_ONE,
      generation: 1,
      outcome: "renewed",
    })),
  );
  const orderedMilestones = [
    "activate",
    "enroll_mint",
    "record_exact_supply_event",
    "record_root_custody_edge",
    "sync_scope:1",
    "request_coverage",
    "record_descendant_exact_event",
    "settle:g1",
    "heartbeat:120:g1",
  ];
  for (let index = 1; index < orderedMilestones.length; index += 1) {
    assert.ok(
      store.calls.indexOf(orderedMilestones[index - 1]!) <
        store.calls.indexOf(orderedMilestones[index]!),
      `${orderedMilestones[index - 1]} must precede ${orderedMilestones[index]}`,
    );
  }
  assert.match(
    store.calls.find((call) => call.startsWith(`cursor:${MINT}:${DESCENDANT}:`)) ?? "",
    new RegExp(`${CHILD_EVENT_SIGNATURE}:g1$`),
  );

  // The same process renews only by presenting its prior secret token and
  // generation, then reproduces current-generation coverage before heartbeat.
  nowMs = BASE_TIME_MS + 21_000;
  const renewed = await first.cycle(CONFIG);
  assert.equal(renewed.status, "observed");
  assert.equal(renewed.leaseGeneration, 1);
  assert.equal(renewed.finalizedHeadSlot, 120);
  assert.equal(store.acquisitions[5]?.outcome, "renewed");
  assert.equal(store.acquisitions[5]?.expectedToken, LEASE_ONE);
  assert.equal(store.acquisitions[5]?.expectedGeneration, 1);
  assert.equal(scheduler.activeCount, 0, "renewal cycle leaked its keepalive timer");

  const replacement = observerWithMockedChainParsers({
    rpc,
    store,
    workerId: "worker-two",
    nowMs: now,
    scheduler,
  });
  const busy = await replacement.cycle(CONFIG);
  assert.deepEqual(busy, {
    status: "lease_busy",
    epochId: EPOCH_ID,
    leaseGeneration: null,
    finalizedHeadSlot: null,
    requestsSettled: 0,
  });

  // A crash-replacement waits at most the short fencing lease. The original
  // 55-second request is still inside its 4-second reserve, so generation two
  // can reproduce coverage and safely settle the durable request.
  nowMs = BASE_TIME_MS + 37_000;
  const resumed = await replacement.cycle(CONFIG);
  assert.equal(resumed.status, "observed");
  assert.equal(resumed.epochId, EPOCH_ID);
  assert.equal(resumed.leaseGeneration, 2);
  assert.equal(resumed.finalizedHeadSlot, 121);
  assert.equal(resumed.requestsSettled, 1);
  assert.deepEqual(store.settleGenerations, [1, 1, 2]);
  assert.deepEqual(
    store.heartbeats.map(({ generation, head }) => ({ generation, head })),
    [
      { generation: 1, head: 120 },
      { generation: 1, head: 120 },
      { generation: 2, head: 121 },
    ],
  );
  assert.equal(scheduler.activeCount, 0, "restart cycle leaked its keepalive timer");
  assert.ok(
    rpc.calls.some((call) => call === `scan:${ROOTS[0]}:floor`) &&
      rpc.calls.some((call) => call === `scan:${DESCENDANT}:floor`),
  );

  const writesBeforeStaleAttempt = store.calls.length;
  const stale = await first.cycle(CONFIG);
  assert.equal(stale.status, "lease_busy");
  assert.equal(
    store.calls.length,
    writesBeforeStaleAttempt + 1,
    "stale worker may only reload epoch",
  );
  assert.deepEqual(store.acquisitions.at(-1), {
    worker: "worker-one",
    expectedToken: LEASE_ONE,
    expectedGeneration: 1,
    outcome: "busy",
  });
  assert.equal(store.calls.filter((call) => call === "activate").length, 1);
});

test("a rejected keepalive clears authority, aborts later writes, and releases its timer", async () => {
  let nowMs = BASE_TIME_MS;
  const now = () => nowMs;
  const rpc = new FinalizedRpc();
  const store = new DurableFreshTailStore(now);
  const scheduler = new ManualScheduler();
  const observer = observerWithMockedChainParsers({
    rpc,
    store,
    workerId: "failed-keepalive-worker",
    nowMs: now,
    scheduler,
    duringRootIngestion: async () => {
      store.rejectKeepaliveOnce();
      nowMs += 5_000;
      await scheduler.fireAll();
    },
  });

  await assert.rejects(
    observer.cycle(CONFIG),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "lease_keepalive_fenced",
  );
  assert.equal(scheduler.activeCount, 0, "failed cycle leaked its keepalive timer");
  for (const forbidden of [
    "enroll_mint",
    "record_exact_supply_event",
    "record_root_custody_edge",
    "request_coverage",
  ]) {
    assert.equal(store.calls.includes(forbidden), false, `${forbidden} ran after lease loss`);
  }
  assert.equal(
    store.calls.some((call) => call.startsWith("cursor:")),
    false,
  );
  assert.equal(
    store.calls.some((call) => call.startsWith("heartbeat:")),
    false,
  );

  // Local authority stays cleared. A same-process retry cannot smuggle the old
  // token into CAS; it waits for the still-authoritative database lease.
  const retry = await observer.cycle(CONFIG);
  assert.equal(retry.status, "lease_busy");
  assert.deepEqual(store.acquisitions.at(-1), {
    worker: "failed-keepalive-worker",
    expectedToken: null,
    expectedGeneration: null,
    outcome: "busy",
  });
  assert.equal(scheduler.activeCount, 0);
});

test("cycle teardown clears the timer and awaits an in-flight exact renewal", async () => {
  let nowMs = BASE_TIME_MS;
  const now = () => nowMs;
  const rpc = new FinalizedRpc();
  const store = new DurableFreshTailStore(now);
  const scheduler = new ManualScheduler();
  const delayed = store.delayKeepaliveOnce();
  const observer = observerWithMockedChainParsers({
    rpc,
    store,
    workerId: "delayed-keepalive-worker",
    nowMs: now,
    scheduler,
    duringRootIngestion: async () => {
      nowMs += 5_000;
      await scheduler.fireAll();
    },
  });

  let cycleSettled = false;
  const cycle = observer.cycle(CONFIG).finally(() => {
    cycleSettled = true;
  });
  await delayed.started;
  for (let turn = 0; turn < 200 && scheduler.activeCount !== 0; turn += 1) {
    await Promise.resolve();
  }
  assert.equal(scheduler.activeCount, 0, "teardown did not clear the keepalive timer");
  assert.equal(cycleSettled, false, "cycle returned before its in-flight renewal completed");

  delayed.release();
  const result = await cycle;
  assert.equal(result.status, "observed");
  assert.equal(result.leaseGeneration, 1);
  assert.equal(cycleSettled, true);
  assert.deepEqual(store.acquisitions.at(-1), {
    worker: "delayed-keepalive-worker",
    expectedToken: LEASE_ONE,
    expectedGeneration: 1,
    outcome: "renewed",
  });
  assert.equal(scheduler.activeCount, 0);
});
