import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, SYSVAR_RENT_PUBKEY, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";
import {
  PumpFunCreationTimeResolver,
  type PumpFunCreationTimeConnection,
} from "./pump-fun-creation-time.js";
import {
  PUMP_FUN_CREATE_DISCRIMINATOR,
  PUMP_FUN_CREATE_PROOF_ABI,
  PUMP_FUN_CREATE_V2_DISCRIMINATOR,
} from "./pump-fun-create-proof.js";
import { PUMP_FUN_PROGRAM_ID, pumpFunBondingCurveAddress } from "./pump-fun-supply.js";

const BASE_TIME_SECONDS = 1_800_000_000;
const NOW_MS = (BASE_TIME_SECONDS + 10_000) * 1_000;
const HEAD_SLOT = 500;
const EVENT_SLOT = 450;
const EVENT_SIG = "coordinated-event-signature";
const MAYHEM_PROGRAM_ID = new PublicKey("MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e");
const EVENT_AUTHORITY = new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1");
const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

type Variant = "classic_v1" | "create_v2_token2022";

function key(fill: number): PublicKey {
  return new PublicKey(Uint8Array.from({ length: 32 }, () => fill));
}

function borshString(value: string): Buffer {
  const body = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(body.length);
  return Buffer.concat([length, body]);
}

function createData(variant: Variant, creator: PublicKey): string {
  return bs58.encode(
    Buffer.concat([
      Buffer.from(
        variant === "classic_v1" ? PUMP_FUN_CREATE_DISCRIMINATOR : PUMP_FUN_CREATE_V2_DISCRIMINATOR,
      ),
      borshString("Finalized"),
      borshString("AGE"),
      borshString("https://example.invalid/finalized.json"),
      creator.toBuffer(),
      ...(variant === "create_v2_token2022" ? [Buffer.from([0, 0])] : []),
    ]),
  );
}

function createAccounts(variant: Variant, mint: PublicKey, creator: PublicKey): PublicKey[] {
  const mintAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from("mint-authority")],
    PUMP_FUN_PROGRAM_ID,
  )[0];
  const bondingCurve = pumpFunBondingCurveAddress(mint);
  const global = PublicKey.findProgramAddressSync([Buffer.from("global")], PUMP_FUN_PROGRAM_ID)[0];
  if (variant === "classic_v1") {
    const curveAta = getAssociatedTokenAddressSync(
      mint,
      bondingCurve,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const metadata = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      METADATA_PROGRAM_ID,
    )[0];
    return [
      mint,
      mintAuthority,
      bondingCurve,
      curveAta,
      global,
      METADATA_PROGRAM_ID,
      metadata,
      creator,
      SystemProgram.programId,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      SYSVAR_RENT_PUBKEY,
      EVENT_AUTHORITY,
      PUMP_FUN_PROGRAM_ID,
    ];
  }

  const curveAta = getAssociatedTokenAddressSync(
    mint,
    bondingCurve,
    true,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const globalParams = PublicKey.findProgramAddressSync(
    [Buffer.from("global-params")],
    MAYHEM_PROGRAM_ID,
  )[0];
  const solVault = PublicKey.findProgramAddressSync(
    [Buffer.from("sol-vault")],
    MAYHEM_PROGRAM_ID,
  )[0];
  const mayhemState = PublicKey.findProgramAddressSync(
    [Buffer.from("mayhem-state"), mint.toBuffer()],
    MAYHEM_PROGRAM_ID,
  )[0];
  const mayhemTokenVault = getAssociatedTokenAddressSync(
    mint,
    solVault,
    true,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return [
    mint,
    mintAuthority,
    bondingCurve,
    curveAta,
    global,
    creator,
    SystemProgram.programId,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    MAYHEM_PROGRAM_ID,
    globalParams,
    solVault,
    mayhemState,
    mayhemTokenVault,
    EVENT_AUTHORITY,
    PUMP_FUN_PROGRAM_ID,
  ];
}

function parsedTransaction(options: {
  mint: PublicKey;
  creator: PublicKey;
  variant: Variant;
  signature: string;
  slot: number;
  create: boolean;
  malformed?: boolean;
  blockTime?: number;
}) {
  const accounts = options.create
    ? createAccounts(options.variant, options.mint, options.creator)
    : [options.mint, options.creator, PUMP_FUN_PROGRAM_ID];
  const writableIndexes = new Set(
    options.variant === "classic_v1" ? [0, 2, 3, 6, 7] : [0, 2, 3, 5, 9, 11, 12, 13],
  );
  const messageAccounts = accounts.map((pubkey, index) => ({
    pubkey,
    signer: pubkey.equals(options.mint) || pubkey.equals(options.creator),
    writable: options.create ? writableIndexes.has(index) : index === 0,
    source: "transaction" as const,
  }));
  return {
    slot: options.slot,
    blockTime: options.blockTime ?? BASE_TIME_SECONDS + options.slot,
    transaction: {
      signatures: [options.signature],
      message: {
        accountKeys: messageAccounts,
        recentBlockhash: "recent-blockhash",
        instructions: options.create
          ? [
              {
                programId: PUMP_FUN_PROGRAM_ID,
                accounts: options.malformed ? accounts.slice(0, -1) : accounts,
                data: createData(options.variant, options.creator),
              },
            ]
          : [],
      },
    },
    meta: {
      err: null,
      fee: 5_000,
      preBalances: messageAccounts.map(() => 0),
      postBalances: messageAccounts.map(() => 0),
      innerInstructions: [],
      preTokenBalances: [],
      postTokenBalances: [],
      logMessages: [],
      rewards: [],
    },
  } as any;
}

type MintFixture = {
  mint: PublicKey;
  creator: PublicKey;
  variant: Variant;
  createSig: string;
  createSlot: number;
  rows: any[];
};

class FakeRpc {
  readonly fixtures = new Map<string, MintFixture>();
  readonly transactions = new Map<string, any | null>();
  readonly blocks = new Map<number, any>();
  readonly statuses = new Map<string, any | null>();
  signatureCalls = 0;
  transactionCalls = 0;
  statusCalls = 0;
  firstAvailableBlock = 1;
  headSlot = HEAD_SLOT;
  headBlockTime = BASE_TIME_SECONDS + HEAD_SLOT;
  headSequence: number[] = [];

  constructor() {
    this.blocks.set(HEAD_SLOT, this.block(HEAD_SLOT, [], this.headBlockTime));
    this.addEvent(EVENT_SIG, EVENT_SLOT);
  }

  block(slot: number, signatures: string[], blockTime = BASE_TIME_SECONDS + slot) {
    return {
      blockhash: `blockhash-${slot}`,
      previousBlockhash: `blockhash-${slot - 1}`,
      parentSlot: slot - 1,
      signatures,
      blockTime,
    };
  }

  addEvent(signature: string, slot: number, blockTime = BASE_TIME_SECONDS + slot): void {
    this.statuses.set(signature, {
      slot,
      confirmations: null,
      err: null,
      confirmationStatus: "finalized",
    });
    const prior = this.blocks.get(slot);
    this.blocks.set(slot, this.block(slot, [...(prior?.signatures ?? []), signature], blockTime));
  }

  addMint(options: {
    mint: PublicKey;
    creator: PublicKey;
    variant: Variant;
    createSig: string;
    createSlot: number;
  }): MintFixture {
    const unrelatedSig = `${options.createSig}-later`;
    const fixture: MintFixture = {
      ...options,
      rows: [
        {
          signature: unrelatedSig,
          slot: options.createSlot + 1,
          blockTime: BASE_TIME_SECONDS + options.createSlot + 1,
          err: null,
          memo: null,
          confirmationStatus: "finalized",
        },
        {
          signature: options.createSig,
          slot: options.createSlot,
          blockTime: BASE_TIME_SECONDS + options.createSlot,
          err: null,
          memo: null,
          confirmationStatus: "finalized",
        },
      ],
    };
    this.fixtures.set(options.mint.toBase58(), fixture);
    this.transactions.set(
      unrelatedSig,
      parsedTransaction({
        ...options,
        signature: unrelatedSig,
        slot: options.createSlot + 1,
        create: false,
      }),
    );
    this.transactions.set(
      options.createSig,
      parsedTransaction({
        ...options,
        signature: options.createSig,
        slot: options.createSlot,
        create: true,
      }),
    );
    this.blocks.set(options.createSlot, this.block(options.createSlot, [options.createSig]));
    return fixture;
  }

  async getSlot() {
    return this.headSequence.shift() ?? this.headSlot;
  }

  async getBlock(slot: number) {
    return this.blocks.get(slot) ?? null;
  }

  async getBlockSignatures(slot: number) {
    return this.blocks.get(slot) ?? null;
  }

  async getSignatureStatuses(signatures: string[]) {
    this.statusCalls += 1;
    return {
      context: { slot: this.headSlot },
      value: signatures.map((signature) => this.statuses.get(signature) ?? null),
    };
  }

  async getSignaturesForAddress(address: PublicKey, options?: { before?: string }) {
    this.signatureCalls += 1;
    const fixture = this.fixtures.get(address.toBase58());
    if (!fixture || options?.before) return [];
    return fixture.rows;
  }

  async getFirstAvailableBlock() {
    return this.firstAvailableBlock;
  }

  async getParsedTransactions(signatures: string[]) {
    this.transactionCalls += 1;
    // Deliberately reverse results: response order is not an identity proof.
    return signatures.map((signature) => this.transactions.get(signature) ?? null).reverse();
  }

  connection(): PumpFunCreationTimeConnection {
    return this as unknown as PumpFunCreationTimeConnection;
  }
}

function request(mint: PublicKey, overrides: Record<string, unknown> = {}) {
  return {
    mint: mint.toBase58(),
    requiredFinalizedEvents: [{ slot: EVENT_SLOT, txSig: EVENT_SIG }],
    nowMs: () => NOW_MS,
    ...overrides,
  };
}

function assertFailure(
  result: Awaited<ReturnType<PumpFunCreationTimeResolver["resolve"]>>,
  code: string,
) {
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, code);
}

test("resolves classic Pump creation and evaluates age from exact finalized block times", async () => {
  const rpc = new FakeRpc();
  const mint = key(1);
  const creator = key(2);
  rpc.addMint({
    mint,
    creator,
    variant: "classic_v1",
    createSig: "classic-create",
    createSlot: 400,
  });
  const resolver = new PumpFunCreationTimeResolver(rpc.connection());

  const result = await resolver.resolve(request(mint));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.source, "rpc");
  assert.equal(result.proof.parserAbi, PUMP_FUN_CREATE_PROOF_ABI);
  assert.equal(result.proof.createVariant, "classic_v1");
  assert.equal(result.proof.tokenProgram, TOKEN_PROGRAM_ID.toBase58());
  assert.equal(result.proof.blockTimeMs, (BASE_TIME_SECONDS + 400) * 1_000);
  assert.equal(result.finalizedEvents[0]?.blockTimeMs, (BASE_TIME_SECONDS + EVENT_SLOT) * 1_000);
  assert.equal(result.evaluatedAtBlockTimeMs, (BASE_TIME_SECONDS + HEAD_SLOT) * 1_000);
  assert.equal(result.evaluatedAtBlockTimeMs - result.proof.blockTimeMs, (HEAD_SLOT - 400) * 1_000);
});

test("resolves the reviewed CreateV2 Token-2022 ABI", async () => {
  const rpc = new FakeRpc();
  const mint = key(3);
  rpc.addMint({
    mint,
    creator: key(4),
    variant: "create_v2_token2022",
    createSig: "v2-create",
    createSlot: 410,
  });

  const result = await new PumpFunCreationTimeResolver(rpc.connection()).resolve(request(mint));

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.proof.createVariant, "create_v2_token2022");
    assert.equal(result.proof.tokenProgram, TOKEN_2022_PROGRAM_ID.toBase58());
  }
});

test("a processed buy can become resolvable after the finalized head catches up", async () => {
  const rpc = new FakeRpc();
  const mint = key(32);
  rpc.addMint({
    mint,
    creator: key(33),
    variant: "classic_v1",
    createSig: "finality-lag-create",
    createSlot: 400,
  });
  rpc.headSlot = EVENT_SLOT - 1;
  rpc.blocks.set(rpc.headSlot, rpc.block(rpc.headSlot, []));
  const resolver = new PumpFunCreationTimeResolver(rpc.connection());

  const pending = await resolver.resolve(request(mint));
  assertFailure(pending, "finalized_head_unavailable");
  if (!pending.ok) assert.equal(pending.retryable, true);
  assert.equal(rpc.signatureCalls, 0, "finality polling must not spend the creation scan budget");

  rpc.headSlot = HEAD_SLOT;
  const resolved = await resolver.resolve(request(mint));
  assert.equal(resolved.ok, true);
  assert.ok(rpc.signatureCalls > 0);
});

test("re-samples the finalized evaluation head after an exhaustive creation scan", async () => {
  const rpc = new FakeRpc();
  const mint = key(30);
  rpc.addMint({
    mint,
    creator: key(31),
    variant: "classic_v1",
    createSig: "moving-head-create",
    createSlot: 400,
  });
  rpc.blocks.set(510, rpc.block(510, [], BASE_TIME_SECONDS + 510));
  rpc.headSequence = [HEAD_SLOT, 510];

  const result = await new PumpFunCreationTimeResolver(rpc.connection()).resolve(request(mint));

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.evaluatedAt.slot, 510);
    assert.equal(result.evaluatedAtBlockTimeMs, (BASE_TIME_SECONDS + 510) * 1_000);
  }
});

test("re-proves all contributing finalized buys even when creation comes from cache", async () => {
  const rpc = new FakeRpc();
  const mint = key(5);
  rpc.addMint({
    mint,
    creator: key(6),
    variant: "classic_v1",
    createSig: "cached-create",
    createSlot: 400,
  });
  rpc.addEvent("second-event", EVENT_SLOT + 1);
  rpc.addEvent("third-event", EVENT_SLOT + 2);
  const events = [
    { slot: EVENT_SLOT, txSig: EVENT_SIG },
    { slot: EVENT_SLOT + 1, txSig: "second-event" },
    { slot: EVENT_SLOT + 2, txSig: "third-event" },
  ];
  const resolver = new PumpFunCreationTimeResolver(rpc.connection());
  const first = await resolver.resolve(request(mint, { requiredFinalizedEvents: events }));
  assert.equal(first.ok, true);
  const scans = rpc.signatureCalls;

  const second = await resolver.resolve(request(mint, { requiredFinalizedEvents: events }));
  assert.equal(second.ok, true);
  if (second.ok) {
    assert.equal(second.source, "cache");
    assert.equal(second.finalizedEvents.length, 3);
  }
  assert.equal(rpc.signatureCalls, scans);
  assert.equal(rpc.statusCalls, 2);

  rpc.blocks.set(EVENT_SLOT + 2, rpc.block(EVENT_SLOT + 2, []));
  const moved = await resolver.resolve(request(mint, { requiredFinalizedEvents: events }));
  assertFailure(moved, "finalized_event_conflict");
  assert.equal(rpc.signatureCalls, scans, "event failure must occur before any creation rescan");
});

test("fails closed when an event status is unavailable, failed, non-finalized, or moved", async () => {
  const rpc = new FakeRpc();
  const mint = key(7);
  rpc.addMint({
    mint,
    creator: key(8),
    variant: "classic_v1",
    createSig: "event-create",
    createSlot: 400,
  });
  const resolver = new PumpFunCreationTimeResolver(rpc.connection());

  rpc.statuses.set(EVENT_SIG, null);
  assertFailure(await resolver.resolve(request(mint)), "finalized_event_unavailable");

  rpc.statuses.set(EVENT_SIG, {
    slot: EVENT_SLOT + 1,
    confirmations: null,
    err: null,
    confirmationStatus: "finalized",
  });
  assertFailure(await resolver.resolve(request(mint)), "finalized_event_conflict");

  rpc.statuses.set(EVENT_SIG, {
    slot: EVENT_SLOT,
    confirmations: 1,
    err: null,
    confirmationStatus: "confirmed",
  });
  const confirming = await resolver.resolve(request(mint));
  assertFailure(confirming, "finalized_event_unavailable");
  if (!confirming.ok) assert.equal(confirming.retryable, true);

  rpc.statuses.set(EVENT_SIG, {
    slot: EVENT_SLOT,
    confirmations: null,
    err: { InstructionError: [0, "Custom"] },
    confirmationStatus: "finalized",
  });
  assertFailure(await resolver.resolve(request(mint)), "finalized_event_conflict");
});

test("rejects a creation proof after any contributing buy", async () => {
  const rpc = new FakeRpc();
  const mint = key(9);
  rpc.addMint({
    mint,
    creator: key(10),
    variant: "classic_v1",
    createSig: "late-create",
    createSlot: 460,
  });

  const result = await new PumpFunCreationTimeResolver(rpc.connection()).resolve(request(mint));

  assertFailure(result, "finalized_event_conflict");
});

test("same-slot creation must be canonically ordered before every contributing buy", async () => {
  const mint = key(25);
  const creator = key(26);
  const rpc = new FakeRpc();
  rpc.addMint({
    mint,
    creator,
    variant: "classic_v1",
    createSig: "same-slot-create",
    createSlot: 400,
  });
  rpc.addEvent("same-slot-event", 400);
  const sameSlotRequest = request(mint, {
    requiredFinalizedEvents: [{ slot: 400, txSig: "same-slot-event" }],
  });

  const ordered = await new PumpFunCreationTimeResolver(rpc.connection()).resolve(sameSlotRequest);
  assert.equal(ordered.ok, true);

  rpc.blocks.set(400, rpc.block(400, ["same-slot-event", "same-slot-create"]));
  const reversed = await new PumpFunCreationTimeResolver(rpc.connection()).resolve(sameSlotRequest);
  assertFailure(reversed, "finalized_event_conflict");
});

test("fails closed on pruned history, page exhaustion, unavailable transactions, and malformed ABI", async () => {
  const mint = key(11);
  const creator = key(12);

  {
    const rpc = new FakeRpc();
    rpc.addMint({
      mint,
      creator,
      variant: "classic_v1",
      createSig: "pruned-create",
      createSlot: 400,
    });
    rpc.firstAvailableBlock = 401;
    assertFailure(
      await new PumpFunCreationTimeResolver(rpc.connection()).resolve(request(mint)),
      "signature_history_pruned",
    );
  }

  {
    const rpc = new FakeRpc();
    rpc.addMint({
      mint,
      creator,
      variant: "classic_v1",
      createSig: "limited-create",
      createSlot: 400,
    });
    const limited = await new PumpFunCreationTimeResolver(rpc.connection()).resolve(
      request(mint, { maxSignaturePages: 1 }),
    );
    assertFailure(limited, "signature_page_limit");
    if (!limited.ok) assert.equal(limited.retryable, false);
  }

  {
    const rpc = new FakeRpc();
    rpc.addMint({
      mint,
      creator,
      variant: "classic_v1",
      createSig: "missing-create",
      createSlot: 400,
    });
    rpc.transactions.set("missing-create", null);
    assertFailure(
      await new PumpFunCreationTimeResolver(rpc.connection()).resolve(request(mint)),
      "transaction_unavailable",
    );
  }

  {
    const rpc = new FakeRpc();
    const fixture = rpc.addMint({
      mint,
      creator,
      variant: "classic_v1",
      createSig: "bad-create",
      createSlot: 400,
    });
    rpc.transactions.set(
      fixture.createSig,
      parsedTransaction({
        ...fixture,
        signature: fixture.createSig,
        slot: fixture.createSlot,
        create: true,
        malformed: true,
      }),
    );
    assertFailure(
      await new PumpFunCreationTimeResolver(rpc.connection()).resolve(request(mint)),
      "malformed_create_instruction",
    );
  }
});

test("rejects multiple reviewed creates and exact creation-block identity conflicts", async () => {
  const mint = key(13);
  const creator = key(14);
  {
    const rpc = new FakeRpc();
    const fixture = rpc.addMint({
      mint,
      creator,
      variant: "classic_v1",
      createSig: "create-one",
      createSlot: 400,
    });
    const secondSig = "create-two";
    fixture.rows.unshift({
      signature: secondSig,
      slot: 401,
      blockTime: BASE_TIME_SECONDS + 401,
      err: null,
      memo: null,
      confirmationStatus: "finalized",
    });
    rpc.transactions.set(
      secondSig,
      parsedTransaction({
        mint,
        creator,
        variant: "classic_v1",
        signature: secondSig,
        slot: 401,
        create: true,
      }),
    );
    assertFailure(
      await new PumpFunCreationTimeResolver(rpc.connection()).resolve(request(mint)),
      "create_conflict",
    );
  }

  {
    const rpc = new FakeRpc();
    rpc.addMint({
      mint,
      creator,
      variant: "classic_v1",
      createSig: "block-create",
      createSlot: 400,
    });
    rpc.blocks.set(400, rpc.block(400, ["different-signature"]));
    assertFailure(
      await new PumpFunCreationTimeResolver(rpc.connection()).resolve(request(mint)),
      "creation_block_conflict",
    );
  }

  {
    const rpc = new FakeRpc();
    rpc.addMint({
      mint,
      creator,
      variant: "classic_v1",
      createSig: "time-create",
      createSlot: 400,
    });
    rpc.blocks.set(400, rpc.block(400, ["time-create"], BASE_TIME_SECONDS + 399));
    assertFailure(
      await new PumpFunCreationTimeResolver(rpc.connection()).resolve(request(mint)),
      "creation_block_conflict",
    );
  }
});

test("fails closed on wrong-mint creates, non-finalized rows, substituted transactions, and missing time", async () => {
  const mint = key(27);
  const creator = key(28);

  {
    const rpc = new FakeRpc();
    const fixture = rpc.addMint({
      mint,
      creator,
      variant: "classic_v1",
      createSig: "wrong-mint-create",
      createSlot: 400,
    });
    rpc.transactions.set(
      fixture.createSig,
      parsedTransaction({
        mint: key(29),
        creator,
        variant: "classic_v1",
        signature: fixture.createSig,
        slot: fixture.createSlot,
        create: true,
      }),
    );
    assertFailure(
      await new PumpFunCreationTimeResolver(rpc.connection()).resolve(request(mint)),
      "malformed_create_instruction",
    );
  }

  {
    const rpc = new FakeRpc();
    const fixture = rpc.addMint({
      mint,
      creator,
      variant: "classic_v1",
      createSig: "non-finalized-create",
      createSlot: 400,
    });
    fixture.rows[0].confirmationStatus = "confirmed";
    assertFailure(
      await new PumpFunCreationTimeResolver(rpc.connection()).resolve(request(mint)),
      "signature_page_conflict",
    );
  }

  {
    const rpc = new FakeRpc();
    const fixture = rpc.addMint({
      mint,
      creator,
      variant: "classic_v1",
      createSig: "substituted-create",
      createSlot: 400,
    });
    const substituted = parsedTransaction({
      mint,
      creator,
      variant: "classic_v1",
      signature: "different-identity",
      slot: fixture.createSlot,
      create: true,
    });
    rpc.transactions.set(fixture.createSig, substituted);
    assertFailure(
      await new PumpFunCreationTimeResolver(rpc.connection()).resolve(request(mint)),
      "transaction_identity_conflict",
    );
  }

  {
    const rpc = new FakeRpc();
    rpc.addMint({
      mint,
      creator,
      variant: "classic_v1",
      createSig: "missing-time-create",
      createSlot: 400,
    });
    rpc.blocks.set(400, rpc.block(400, ["missing-time-create"], undefined as any));
    rpc.blocks.get(400).blockTime = null;
    assertFailure(
      await new PumpFunCreationTimeResolver(rpc.connection()).resolve(request(mint)),
      "block_time_unavailable",
    );
  }

  {
    const rpc = new FakeRpc();
    const fixture = rpc.addMint({
      mint,
      creator,
      variant: "classic_v1",
      createSig: "failed-create-only",
      createSlot: 400,
    });
    fixture.rows.find((row) => row.signature === fixture.createSig)!.err = {
      InstructionError: [0, "Custom"],
    };
    rpc.firstAvailableBlock = 0;
    assertFailure(
      await new PumpFunCreationTimeResolver(rpc.connection()).resolve(request(mint)),
      "create_not_found",
    );
  }
});

test("positive cache is TTL/LRU bounded and never caches a failed resolution", async () => {
  const rpc = new FakeRpc();
  const firstMint = key(15);
  const secondMint = key(16);
  rpc.addMint({
    mint: firstMint,
    creator: key(17),
    variant: "classic_v1",
    createSig: "first-create",
    createSlot: 400,
  });
  rpc.addMint({
    mint: secondMint,
    creator: key(18),
    variant: "classic_v1",
    createSig: "second-create",
    createSlot: 410,
  });
  let clock = NOW_MS;
  const resolver = new PumpFunCreationTimeResolver(rpc.connection(), {
    maxCacheEntries: 1,
    cacheTtlMs: 1_000,
  });
  const timedRequest = (mint: PublicKey) => request(mint, { nowMs: () => clock });

  assert.equal((await resolver.resolve(timedRequest(firstMint))).ok, true);
  assert.equal((await resolver.resolve(timedRequest(secondMint))).ok, true);
  assert.equal(resolver.cacheSize, 1);
  const callsAfterTwo = rpc.signatureCalls;
  assert.equal((await resolver.resolve(timedRequest(firstMint))).ok, true);
  assert.ok(rpc.signatureCalls > callsAfterTwo, "evicted proof must be re-resolved");

  const callsBeforeExpiry = rpc.signatureCalls;
  clock += 1_001;
  assert.equal((await resolver.resolve(timedRequest(firstMint))).ok, true);
  assert.ok(rpc.signatureCalls > callsBeforeExpiry, "expired proof must be re-resolved");

  const failedMint = key(19);
  rpc.addMint({
    mint: failedMint,
    creator: key(20),
    variant: "classic_v1",
    createSig: "failed-create",
    createSlot: 420,
  });
  rpc.transactions.set("failed-create", null);
  assertFailure(await resolver.resolve(timedRequest(failedMint)), "transaction_unavailable");
  rpc.transactions.set(
    "failed-create",
    parsedTransaction({
      mint: failedMint,
      creator: key(20),
      variant: "classic_v1",
      signature: "failed-create",
      slot: 420,
      create: true,
    }),
  );
  assert.equal((await resolver.resolve(timedRequest(failedMint))).ok, true);
});

test("concurrent misses use one per-mint creation scan and failures clear singleflight", async () => {
  const rpc = new FakeRpc();
  const mint = key(21);
  rpc.addMint({
    mint,
    creator: key(22),
    variant: "classic_v1",
    createSig: "flight-create",
    createSlot: 400,
  });
  const resolver = new PumpFunCreationTimeResolver(rpc.connection());

  const [left, right] = await Promise.all([
    resolver.resolve(request(mint)),
    resolver.resolve(request(mint)),
  ]);
  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  assert.equal(rpc.signatureCalls, 2, "one scan consists of one data page and one empty page");
  assert.equal(rpc.transactionCalls, 1);

  resolver.clearCache();
  rpc.transactions.set("flight-create", null);
  assertFailure(await resolver.resolve(request(mint)), "transaction_unavailable");
  rpc.transactions.set(
    "flight-create",
    parsedTransaction({
      mint,
      creator: key(22),
      variant: "classic_v1",
      signature: "flight-create",
      slot: 400,
      create: true,
    }),
  );
  assert.equal((await resolver.resolve(request(mint))).ok, true);
});

test("request, event-count, cache bounds, and absolute deadline are fixed", async () => {
  const rpc = new FakeRpc();
  const mint = key(23);
  rpc.addMint({
    mint,
    creator: key(24),
    variant: "classic_v1",
    createSig: "bounds-create",
    createSlot: 400,
  });
  const resolver = new PumpFunCreationTimeResolver(rpc.connection());

  assertFailure(await resolver.resolve({ mint: "not-a-key" }), "invalid_request");
  assertFailure(
    await resolver.resolve(
      request(mint, {
        requiredFinalizedEvents: Array.from({ length: 9 }, (_, index) => ({
          slot: EVENT_SLOT,
          txSig: `event-${index}`,
        })),
      }),
    ),
    "invalid_request",
  );
  assertFailure(await resolver.resolve(request(mint, { deadlineMs: NOW_MS })), "deadline_exceeded");
  assert.throws(
    () => new PumpFunCreationTimeResolver(rpc.connection(), { maxCacheEntries: 10_001 }),
    RangeError,
  );
  assert.throws(
    () => new PumpFunCreationTimeResolver(rpc.connection(), { cacheTtlMs: 999 }),
    RangeError,
  );

  const hanging = {
    ...rpc.connection(),
    getSlot: async () => new Promise<number>(() => undefined),
  } as PumpFunCreationTimeConnection;
  const wallClockStarted = Date.now();
  const timedOut = await new PumpFunCreationTimeResolver(hanging).resolve({
    mint: mint.toBase58(),
    rpcCallTimeoutMs: 250,
    deadlineMs: wallClockStarted + 20,
    nowMs: Date.now,
  });
  assertFailure(timedOut, "deadline_exceeded");
});
