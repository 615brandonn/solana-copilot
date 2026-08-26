import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, SYSVAR_RENT_PUBKEY, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";
import {
  attestFreshPumpFunCreate,
  parsePumpFunCreateTransaction,
  PUMP_FUN_CREATE_DISCRIMINATOR,
  PUMP_FUN_CREATE_V2_DISCRIMINATOR,
  type PumpFunCreateProofConnection,
} from "./pump-fun-create-proof.js";
import { buildVerifiedFreshRootBuyEvidence } from "./fresh-tail-root-buy-evidence.js";
import { PUMP_FUN_PROGRAM_ID, pumpFunBondingCurveAddress } from "./pump-fun-supply.js";

const ACTIVATION_SLOT = 100;
const CREATE_SLOT = 120;
const TRIGGER_SLOT = 130;
const HEAD_SLOT = 135;
const ACTIVATION_HASH = "activation-hash";
const HEAD_HASH = "head-hash";
const CREATE_SIG = "create-signature";
const TRIGGER_SIG = "trigger-signature";
const TOTAL_SUPPLY = 1_000_000_000_000_000n;
const CURVE_DISCRIMINATOR = 6_966_180_631_402_821_399n;

const REAL_V2_FIXTURES = [
  {
    signature:
      "uiLfF4RewLaCU4kucB1twK4SoYaCB1eL6RXboPAkxbT2QN26AmBXukEcyB1KbarDp5PCUNC3VWvE1aGxQXGrrsq",
    slot: 441_792_992,
    blockTime: 1_787_720_346,
    mint: "Fw5xoxp3JYrW1ELUCQ98t3MvRiMKSFk7WBEsMs8Gpump",
    creator: "89YMNptpZLBo21N8uzPXCQ2M4QrpimfDhJGvibyR9fpW",
    accounts: [
      "Fw5xoxp3JYrW1ELUCQ98t3MvRiMKSFk7WBEsMs8Gpump",
      "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM",
      "GfzNVBBisCRUpqCmFMvBu4XTJGRzXYxcQE7SUqAZjAHR",
      "Gi27YJXXtwydVRnK9LDsg7oZky6WDNMuR3sSRSkizPtu",
      "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf",
      "89YMNptpZLBo21N8uzPXCQ2M4QrpimfDhJGvibyR9fpW",
      "11111111111111111111111111111111",
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      "MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e",
      "13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ",
      "BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s",
      "1suDwHVnyzUxwP1YXzBVxrFQq19HeeXwcBCb3pquost",
      "EmQbXf7AKm3x3MyNg6ps1oLujoGtAdhdKtvbxprbw9Dp",
      "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1",
      "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    ],
    data: "qG1h6wdkxsnZKZEP4gHFdazr9fWeG9rGwsAvS4yj5qhwnWuc8tJirZE9JZwRiK4hbxk8TrDpaEd1pbcPsj6maMSSRe4GtvP4ngbBPepQ23pRM7MK4sSYLCfr76W78oo8mLEk1GocCLJ919cnaDSQxAhTgY6uxQyvZEL7W2hWzrnihGkBqUHWewi",
    mintData:
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIDGpH6NAwAGAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARIAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAN3el2sNX+izp+oW0dQhauLHIpS22qs/E1Bl/e/21dyfEwCgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3d6Xaw1f6LOn6hbR1CFq4scilLbaqz8TUGX97/bV3J8VAAAAU1RBUlQgREVWVklORyBXSVRIIDMwBQAAAERFTlpBNgAAAGh0dHBzOi8vbWV0YWRhdGEuajd0cmFja2VyLmlvL21ldGFkYXRhL29kTHNDRUsyWUcuanNvbgAAAAA=",
    curveData:
      "F7f4N2DYrGBkRMAI684DAM796v0GAAAAZKytvFnQAgDOUccBAAAAAACAxqR+jQMAAGox52y3xlaaRuCdHzLlDxg2g94XyItFoIdgXyLdscXbAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
  },
  {
    signature:
      "bbD7CeVD51pwo4hdbpKQSFgaXGPH82zP8dDQ69FnPm52sa1ibvacettPjqCrFaxdkz3zi2ZS4gh2Aa8aveQ9uPm",
    slot: 441_794_503,
    blockTime: 1_787_720_899,
    mint: "6c8yQdXnvoVEgJGDSHZRaUABvodaCqnR2veU8rt2pump",
    creator: "Bnk1RDypaa4tmXUPZ99a8s1NhTuaAjJuHdNcPesRqmU",
    accounts: [
      "6c8yQdXnvoVEgJGDSHZRaUABvodaCqnR2veU8rt2pump",
      "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM",
      "FpFHKuTmUD9MAwg912XJuBfFkQ6MZh8yQBVsqBoeQ8KF",
      "5zvUQy6EFfzmyNe5DBtyrpupAM1YhQQYuByg1w5pHZtB",
      "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf",
      "Bnk1RDypaa4tmXUPZ99a8s1NhTuaAjJuHdNcPesRqmU",
      "11111111111111111111111111111111",
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      "MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e",
      "13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ",
      "BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s",
      "CMEh6UTow6r5FDYqLJgdzmePsT7ybkVXJydYtXcVdTp",
      "72CVLK4ACmfifHfoAQ9LY3xUah3iuxxMTMFUie9Zqg5f",
      "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1",
      "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    ],
    data: "2MJr4FV2wMPZnvUKemB5N8QYqHsHnCcF8uPPK5Rqb6ymXY39zEEwyJ9CmSJPeYPBAzztMVTk8BzatsjFhV9HwyXkvtRxg7JwUUXPz8tk7ULmn6fBXNW52AyEZcc5Xtve7pssqvPCJugADUdpjyw9RKu3TN7seE5nmytv4Jr4SRr7NEENXpXDFPbh6NGAC4tWDXxdUaswNEj",
  },
] as const;

function realV2CreateTx(fixture: (typeof REAL_V2_FIXTURES)[number]) {
  const writable = new Set([0, 2, 3, 5, 9, 11, 12, 13]);
  return {
    slot: fixture.slot,
    blockTime: fixture.blockTime,
    transaction: {
      signatures: [fixture.signature],
      message: {
        accountKeys: fixture.accounts.map((address, index) => ({
          pubkey: new PublicKey(address),
          signer: index === 0 || index === 5,
          writable: writable.has(index),
          source: "transaction" as const,
        })),
        recentBlockhash: "real-finalized-fixture",
        instructions: [
          {
            programId: PUMP_FUN_PROGRAM_ID,
            accounts: fixture.accounts.map((address) => new PublicKey(address)),
            data: fixture.data,
          },
        ],
      },
    },
    meta: {
      err: null,
      fee: 5_000,
      preBalances: fixture.accounts.map(() => 0),
      postBalances: fixture.accounts.map(() => 0),
      innerInstructions: [],
      preTokenBalances: [],
      postTokenBalances: [],
      logMessages: [],
      rewards: [],
    },
  } as any;
}

function realV2TriggerTx(fixture: (typeof REAL_V2_FIXTURES)[0], signature: string, slot: number) {
  const root = new PublicKey(fixture.creator);
  const tokenMint = new PublicKey(fixture.mint);
  return {
    slot,
    blockTime: fixture.blockTime + (slot - fixture.slot),
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [
          { pubkey: root, signer: true, writable: true, source: "transaction" },
          { pubkey: tokenMint, signer: false, writable: false, source: "transaction" },
          { pubkey: PUMP_FUN_PROGRAM_ID, signer: false, writable: false, source: "transaction" },
        ],
        recentBlockhash: "real-trigger-fixture",
        instructions: [],
      },
    },
    meta: {
      err: null,
      fee: 5_000,
      preBalances: [1, 0, 0],
      postBalances: [0, 0, 0],
      innerInstructions: [],
      preTokenBalances: [],
      postTokenBalances: [],
      logMessages: [],
      rewards: [],
    },
  } as any;
}

function realV2AttestationFixture(mintDataOverride?: Buffer) {
  const fixture = REAL_V2_FIXTURES[0];
  const createTx = realV2CreateTx(fixture);
  const triggerSignature = "real-v2-trigger-fixture";
  const triggerSlot = fixture.slot + 1;
  const triggerTx = realV2TriggerTx(fixture, triggerSignature, triggerSlot);
  const activationSlot = fixture.slot - 1;
  const headSlot = fixture.slot + 2;
  let signaturePage = 0;
  const rpc = {
    async getBlock(slot: number) {
      return { blockhash: slot === activationSlot ? "v2-activation" : "v2-head" } as any;
    },
    async getBlockSignatures() {
      return { blockhash: "v2-creation-block", signatures: [fixture.signature] } as any;
    },
    async getSignaturesForAddress() {
      return (
        [
          [
            {
              signature: triggerSignature,
              slot: triggerSlot,
              blockTime: triggerTx.blockTime,
              err: null,
              memo: null,
              confirmationStatus: "finalized",
            },
            {
              signature: fixture.signature,
              slot: fixture.slot,
              blockTime: fixture.blockTime,
              err: null,
              memo: null,
              confirmationStatus: "finalized",
            },
          ],
          [],
        ][signaturePage++] ?? []
      ) as any;
    },
    async getFirstAvailableBlock() {
      return 1;
    },
    async getParsedTransactions() {
      // Intentionally reverse the JSON-RPC batch result: response ordering is
      // not guaranteed and identity must be rebound by signature.
      return [createTx, triggerTx] as any;
    },
    async getMultipleAccountsInfoAndContext() {
      return {
        context: { slot: headSlot },
        value: [
          {
            data: Buffer.from(fixture.curveData, "base64"),
            executable: false,
            lamports: 1,
            owner: PUMP_FUN_PROGRAM_ID,
            rentEpoch: 0,
          },
          {
            data: mintDataOverride ?? Buffer.from(fixture.mintData, "base64"),
            executable: false,
            lamports: 1,
            owner: TOKEN_2022_PROGRAM_ID,
            rentEpoch: 0,
          },
        ],
      } as any;
    },
  } as PumpFunCreateProofConnection;
  return {
    rpc,
    request: {
      mint: fixture.mint,
      activation: { slot: activationSlot, blockhash: "v2-activation" },
      requestedHead: { slot: headSlot, blockhash: "v2-head" },
      triggerSlot,
      triggerTxSig: triggerSignature,
      triggerBuyEvidence: buildVerifiedFreshRootBuyEvidence(triggerTx, {
        txSig: triggerSignature,
        slot: triggerSlot,
        blockTimeMs: triggerTx.blockTime * 1_000,
        rootWallet: fixture.creator,
        mint: fixture.mint,
        bondingCurve: fixture.accounts[2],
        grossAmountRaw: "126235294117647",
        successful: true,
        finalized: true,
        pumpFunVerified: true,
      }),
    },
  };
}

function key(fill: number): PublicKey {
  return new PublicKey(Uint8Array.from({ length: 32 }, () => fill));
}

const mint = key(1);
const creator = key(2);
const eventAuthority = new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1");
const metadataProgram = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value);
  return out;
}

function borshString(value: string): Buffer {
  const body = Buffer.from(value, "utf8");
  return Buffer.concat([u32(body.length), body]);
}

function createData(creatorArg = creator): string {
  return bs58.encode(
    Buffer.concat([
      PUMP_FUN_CREATE_DISCRIMINATOR,
      borshString("Fresh"),
      borshString("NEW"),
      borshString("https://example.invalid/meta.json"),
      creatorArg.toBuffer(),
    ]),
  );
}

function createAccounts(): PublicKey[] {
  const mintAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from("mint-authority")],
    PUMP_FUN_PROGRAM_ID,
  )[0];
  const bondingCurve = pumpFunBondingCurveAddress(mint);
  const curveAta = getAssociatedTokenAddressSync(
    mint,
    bondingCurve,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const global = PublicKey.findProgramAddressSync(
    [Buffer.from("global")],
    PUMP_FUN_PROGRAM_ID,
  )[0];
  const metadata = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), metadataProgram.toBuffer(), mint.toBuffer()],
    metadataProgram,
  )[0];
  return [
    mint,
    mintAuthority,
    bondingCurve,
    curveAta,
    global,
    metadataProgram,
    metadata,
    creator,
    SystemProgram.programId,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    SYSVAR_RENT_PUBKEY,
    eventAuthority,
    PUMP_FUN_PROGRAM_ID,
  ];
}

function parsedTx(options: {
  signature: string;
  slot: number;
  create?: boolean;
  accounts?: PublicKey[];
  data?: string;
  mintSigner?: boolean;
  creatorSigner?: boolean;
  blockTime?: number;
  failed?: boolean;
}) {
  const instructionAccounts = options.accounts ?? createAccounts();
  const allKeys = Array.from(
    new Map(
      [creator, mint, PUMP_FUN_PROGRAM_ID, ...instructionAccounts].map((pubkey) => [
        pubkey.toBase58(),
        pubkey,
      ]),
    ).values(),
  );
  const writableInstructionKeys = new Set(
    [0, 2, 3, 6, 7]
      .map((index) => instructionAccounts[index]?.toBase58())
      .filter((value): value is string => Boolean(value)),
  );
  const messageAccounts = allKeys.map((pubkey) => ({
    pubkey,
    signer:
      (pubkey.equals(mint) && options.mintSigner !== false) ||
      (pubkey.equals(creator) && options.creatorSigner !== false),
    writable: writableInstructionKeys.has(pubkey.toBase58()),
    source: "transaction" as const,
  }));
  return {
    slot: options.slot,
    blockTime: options.blockTime ?? 1_800_000_000 + options.slot,
    transaction: {
      signatures: [options.signature],
      message: {
        accountKeys: messageAccounts,
        recentBlockhash: "recent",
        instructions: options.create
          ? [
              {
                programId: PUMP_FUN_PROGRAM_ID,
                accounts: instructionAccounts,
                data: options.data ?? createData(),
              },
            ]
          : [],
      },
    },
    meta: {
      err: options.failed ? { InstructionError: [0, "Custom"] } : null,
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

function curveData(complete = false): Buffer {
  const out = Buffer.alloc(49);
  [
    CURVE_DISCRIMINATOR,
    1_073_000_000_000_000n,
    30_000_000_000n,
    793_100_000_000_000n,
    0n,
    TOTAL_SUPPLY,
  ].forEach((value, index) => out.writeBigUInt64LE(value, index * 8));
  out.writeUInt8(complete ? 1 : 0, 48);
  return out;
}

function mintData(): Buffer {
  const out = Buffer.alloc(82);
  out.writeUInt32LE(0, 0);
  PublicKey.default.toBuffer().copy(out, 4);
  out.writeBigUInt64LE(TOTAL_SUPPLY, 36);
  out.writeUInt8(6, 44);
  out.writeUInt8(1, 45);
  out.writeUInt32LE(0, 46);
  PublicKey.default.toBuffer().copy(out, 50);
  return out;
}

type RpcOptions = {
  signaturePages?: any[][];
  transactions?: Map<string, any | null>;
  firstAvailableBlock?: number;
  activationHash?: string;
  headHash?: string;
  stateSlot?: number;
  curveOwner?: PublicKey;
  curveComplete?: boolean;
  creationBlockSignatures?: string[];
};

function fakeRpc(options: RpcOptions = {}): PumpFunCreateProofConnection {
  const signaturePages = options.signaturePages ?? [
    [
      {
        signature: TRIGGER_SIG,
        slot: TRIGGER_SLOT,
        blockTime: 1_800_000_000 + TRIGGER_SLOT,
        err: null,
        memo: null,
        confirmationStatus: "finalized",
      },
      {
        signature: CREATE_SIG,
        slot: CREATE_SLOT,
        blockTime: 1_800_000_000 + CREATE_SLOT,
        err: null,
        memo: null,
        confirmationStatus: "finalized",
      },
    ],
    [],
  ];
  const transactions =
    options.transactions ??
    new Map([
      [CREATE_SIG, parsedTx({ signature: CREATE_SIG, slot: CREATE_SLOT, create: true })],
      [TRIGGER_SIG, parsedTx({ signature: TRIGGER_SIG, slot: TRIGGER_SLOT })],
    ]);
  let pageIndex = 0;
  return {
    async getBlock(slot: number) {
      const blockhash =
        slot === ACTIVATION_SLOT
          ? (options.activationHash ?? ACTIVATION_HASH)
          : (options.headHash ?? HEAD_HASH);
      return {
        blockhash,
        ...(slot === CREATE_SLOT ? { signatures: [CREATE_SIG] } : {}),
      } as any;
    },
    async getBlockSignatures() {
      return {
        blockhash: "creation-hash",
        signatures: options.creationBlockSignatures ?? [CREATE_SIG],
      } as any;
    },
    async getSignaturesForAddress() {
      return (signaturePages[pageIndex++] ?? []) as any;
    },
    async getFirstAvailableBlock() {
      return options.firstAvailableBlock ?? 1;
    },
    async getParsedTransactions(signatures: string[]) {
      return signatures.map((signature) => transactions.get(signature) ?? null) as any;
    },
    async getMultipleAccountsInfoAndContext() {
      return {
        context: { slot: options.stateSlot ?? HEAD_SLOT },
        value: [
          {
            data: curveData(options.curveComplete === true),
            executable: false,
            lamports: 1,
            owner: options.curveOwner ?? PUMP_FUN_PROGRAM_ID,
            rentEpoch: 0,
          },
          {
            data: mintData(),
            executable: false,
            lamports: 1,
            owner: TOKEN_PROGRAM_ID,
            rentEpoch: 0,
          },
        ],
      } as any;
    },
  } as PumpFunCreateProofConnection;
}

function request(
  options: {
    headSlot?: number;
    triggerSlot?: number;
    triggerTxSig?: string;
    triggerTx?: any;
    evidenceMint?: string;
    evidenceRoot?: string;
    deadlineMs?: number;
    nowMs?: () => number;
  } = {},
) {
  const triggerSlot = options.triggerSlot ?? TRIGGER_SLOT;
  const triggerTxSig = options.triggerTxSig ?? TRIGGER_SIG;
  const triggerTx =
    options.triggerTx ?? parsedTx({ signature: triggerTxSig, slot: triggerSlot });
  return {
    mint: mint.toBase58(),
    activation: { slot: ACTIVATION_SLOT, blockhash: ACTIVATION_HASH },
    requestedHead: { slot: options.headSlot ?? HEAD_SLOT, blockhash: HEAD_HASH },
    triggerSlot,
    triggerTxSig,
    ...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}),
    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
    triggerBuyEvidence: buildVerifiedFreshRootBuyEvidence(triggerTx, {
      txSig: triggerTxSig,
      slot: triggerSlot,
      blockTimeMs: Number(triggerTx.blockTime) * 1_000,
      rootWallet: options.evidenceRoot ?? creator.toBase58(),
      mint: options.evidenceMint ?? mint.toBase58(),
      bondingCurve: pumpFunBondingCurveAddress(mint).toBase58(),
      grossAmountRaw: "1000000",
      successful: true,
      finalized: true,
      pumpFunVerified: true,
    }),
  };
}

test("strict parser accepts the reviewed Pump create ABI", () => {
  const result = parsePumpFunCreateTransaction(
    parsedTx({ signature: CREATE_SIG, slot: CREATE_SLOT, create: true }),
    mint.toBase58(),
  );
  assert.equal(result.kind, "valid");
  if (result.kind === "valid") {
    assert.equal(result.value.creator, creator.toBase58());
    assert.equal(result.value.bondingCurve, pumpFunBondingCurveAddress(mint).toBase58());
  }
});

test("strict parser accepts two independently captured finalized CreateV2 fixtures", () => {
  assert.deepEqual([...PUMP_FUN_CREATE_V2_DISCRIMINATOR], [
    214, 144, 76, 236, 95, 139, 49, 180,
  ]);
  for (const fixture of REAL_V2_FIXTURES) {
    const result = parsePumpFunCreateTransaction(realV2CreateTx(fixture), fixture.mint);
    assert.equal(result.kind, "valid", fixture.mint);
    if (result.kind === "valid") {
      assert.equal(result.value.creator, fixture.creator);
      assert.equal(result.value.bondingCurve, fixture.accounts[2]);
      assert.equal(result.value.variant, "create_v2_token2022");
      assert.equal(result.value.tokenProgram, TOKEN_2022_PROGRAM_ID.toBase58());
    }
  }
});

test("real CreateV2 attestation accepts only the frozen safe Token-2022 mint layout", async () => {
  const validFixture = realV2AttestationFixture();
  const valid = await attestFreshPumpFunCreate(validFixture.rpc, validFixture.request);
  assert.equal(valid.ok, true, valid.ok ? "" : JSON.stringify(valid));
  if (valid.ok) {
    assert.equal(valid.proof.createVariant, "create_v2_token2022");
    assert.equal(valid.proof.tokenProgram, TOKEN_2022_PROGRAM_ID.toBase58());
    assert.match(valid.proof.abi, /^[0-9a-f]{64}$/);
    assert.match(valid.proof.mintLayoutFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(valid.proof.totalSupplyRaw, "1000000000000000");
    assert.equal(valid.proof.decimals, 6);
  }

  const paddedCurve = Buffer.concat([
    Buffer.from(REAL_V2_FIXTURES[0].curveData, "base64"),
    Buffer.alloc(36),
  ]);
  const paddedFixture = realV2AttestationFixture();
  paddedFixture.rpc.getMultipleAccountsInfoAndContext = async () => ({
    context: { slot: paddedFixture.request.requestedHead.slot },
    value: [
      {
        data: paddedCurve,
        executable: false,
        lamports: 1,
        owner: PUMP_FUN_PROGRAM_ID,
        rentEpoch: 0,
      },
      {
        data: Buffer.from(REAL_V2_FIXTURES[0].mintData, "base64"),
        executable: false,
        lamports: 1,
        owner: TOKEN_2022_PROGRAM_ID,
        rentEpoch: 0,
      },
    ],
  }) as any;
  const padded = await attestFreshPumpFunCreate(paddedFixture.rpc, paddedFixture.request);
  assert.equal(padded.ok, true, padded.ok ? "" : JSON.stringify(padded));

  const nonzeroTail = Buffer.from(paddedCurve);
  nonzeroTail[150] = 1;
  const unknownCurveFixture = realV2AttestationFixture();
  unknownCurveFixture.rpc.getMultipleAccountsInfoAndContext = async () => ({
    context: { slot: unknownCurveFixture.request.requestedHead.slot },
    value: [
      {
        data: nonzeroTail,
        executable: false,
        lamports: 1,
        owner: PUMP_FUN_PROGRAM_ID,
        rentEpoch: 0,
      },
      {
        data: Buffer.from(REAL_V2_FIXTURES[0].mintData, "base64"),
        executable: false,
        lamports: 1,
        owner: TOKEN_2022_PROGRAM_ID,
        rentEpoch: 0,
      },
    ],
  }) as any;
  const unknownCurve = await attestFreshPumpFunCreate(
    unknownCurveFixture.rpc,
    unknownCurveFixture.request,
  );
  assert.equal(unknownCurve.ok, false);
  if (!unknownCurve.ok) assert.equal(unknownCurve.code, "curve_state_invalid");

  const unsafeMint = Buffer.from(REAL_V2_FIXTURES[0].mintData, "base64");
  // Token-2022 TLV starts at offset 166. Mutate MetadataPointer (18) into
  // TransferFeeConfig (1); any behavioral extension outside 18+19 is rejected.
  unsafeMint.writeUInt16LE(ExtensionType.TransferFeeConfig, 166);
  const unsafeFixture = realV2AttestationFixture(unsafeMint);
  const unsafe = await attestFreshPumpFunCreate(unsafeFixture.rpc, unsafeFixture.request);
  assert.equal(unsafe.ok, false);
  if (!unsafe.ok) {
    assert.equal(unsafe.code, "curve_state_invalid");
    assert.equal(unsafe.retryable, false);
  }
});

test("strict parser rejects a create discriminator with a changed account contract", () => {
  const accounts = createAccounts();
  accounts[4] = key(9);
  const result = parsePumpFunCreateTransaction(
    parsedTx({ signature: CREATE_SIG, slot: CREATE_SLOT, create: true, accounts }),
    mint.toBase58(),
  );
  assert.deepEqual(result, {
    kind: "malformed",
    reason: "Pump create account contract does not match",
  });
});

test("strict parser rejects missing mint signer and mismatched creator argument", () => {
  assert.equal(
    parsePumpFunCreateTransaction(
      parsedTx({
        signature: CREATE_SIG,
        slot: CREATE_SLOT,
        create: true,
        mintSigner: false,
      }),
      mint.toBase58(),
    ).kind,
    "malformed",
  );
  const result = parsePumpFunCreateTransaction(
    parsedTx({
      signature: CREATE_SIG,
      slot: CREATE_SLOT,
      create: true,
      data: createData(key(7)),
    }),
    mint.toBase58(),
  );
  assert.deepEqual(result, {
    kind: "malformed",
    reason: "Pump create creator argument does not match its signer",
  });
});

test("attestor proves finalized boundaries, creation, and current Pump state", async () => {
  const result = await attestFreshPumpFunCreate(fakeRpc(), request());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.proof.txSig, CREATE_SIG);
    assert.equal(result.proof.slot, CREATE_SLOT);
    assert.equal(result.proof.creator, creator.toBase58());
    assert.equal(result.proof.blockhash, "creation-hash");
    assert.match(result.proof.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(result.proof.totalSupplyRaw, TOTAL_SUPPLY.toString());
    assert.equal(result.proof.stateObservedSlot, HEAD_SLOT);
  }
});

test("stable creation fingerprint is unchanged when a retry verifies at a later head", async () => {
  const first = await attestFreshPumpFunCreate(fakeRpc(), request());
  const later = await attestFreshPumpFunCreate(
    fakeRpc({ stateSlot: HEAD_SLOT + 10 }),
    request({ headSlot: HEAD_SLOT + 5 }),
  );
  assert.equal(first.ok, true);
  assert.equal(later.ok, true);
  if (first.ok && later.ok) {
    assert.equal(later.proof.fingerprint, first.proof.fingerprint);
    assert.equal(first.proof.requestedHeadSlot, HEAD_SLOT);
    assert.equal(later.proof.requestedHeadSlot, HEAD_SLOT + 5);
    assert.equal(later.proof.stateObservedSlot, HEAD_SLOT + 10);
  }
});

test("attestor permits a decoder-bound same-transaction create and root buy", async () => {
  const sameTxSig = "same-tx-create-buy";
  const sameTx = parsedTx({ signature: sameTxSig, slot: TRIGGER_SLOT, create: true });
  const result = await attestFreshPumpFunCreate(
    fakeRpc({
      signaturePages: [
        [
          {
            signature: sameTxSig,
            slot: TRIGGER_SLOT,
            blockTime: 1_800_000_000 + TRIGGER_SLOT,
            err: null,
            memo: null,
            confirmationStatus: "finalized",
          },
        ],
        [],
      ],
      transactions: new Map([[sameTxSig, sameTx]]),
      creationBlockSignatures: [sameTxSig],
    }),
    request({ triggerTxSig: sameTxSig, triggerTx: sameTx }),
  );
  assert.equal(result.ok, true);
});

test("attestor permits separately decoded same-slot root buy only after canonical create order", async () => {
  const sameSlotCreate = "same-slot-create";
  const triggerTx = parsedTx({ signature: TRIGGER_SIG, slot: TRIGGER_SLOT });
  const pages = [
    [
      {
        signature: TRIGGER_SIG,
        slot: TRIGGER_SLOT,
        blockTime: 1_800_000_000 + TRIGGER_SLOT,
        err: null,
        memo: null,
        confirmationStatus: "finalized",
      },
      {
        signature: sameSlotCreate,
        slot: TRIGGER_SLOT,
        blockTime: 1_800_000_000 + TRIGGER_SLOT,
        err: null,
        memo: null,
        confirmationStatus: "finalized",
      },
    ],
    [],
  ];
  const transactions = new Map([
    [TRIGGER_SIG, triggerTx],
    [sameSlotCreate, parsedTx({ signature: sameSlotCreate, slot: TRIGGER_SLOT, create: true })],
  ]);
  const ordered = await attestFreshPumpFunCreate(
    fakeRpc({
      signaturePages: pages,
      transactions,
      creationBlockSignatures: [sameSlotCreate, TRIGGER_SIG],
    }),
    request({ triggerTx }),
  );
  assert.equal(ordered.ok, true);

  const reversed = await attestFreshPumpFunCreate(
    fakeRpc({
      signaturePages: pages,
      transactions,
      creationBlockSignatures: [TRIGGER_SIG, sameSlotCreate],
    }),
    request({ triggerTx }),
  );
  assert.equal(reversed.ok, false);
  if (!reversed.ok) assert.equal(reversed.code, "same_slot_order_unproved");
});

test("attestor rejects a creation after the enrollment trigger", async () => {

  const afterTriggerCreate = "after-trigger-create";
  const after = await attestFreshPumpFunCreate(
    fakeRpc({
      signaturePages: [
        [
          {
            signature: afterTriggerCreate,
            slot: TRIGGER_SLOT + 1,
            blockTime: 1_800_000_000 + TRIGGER_SLOT + 1,
            err: null,
            memo: null,
            confirmationStatus: "finalized",
          },
        ],
        [],
      ],
      transactions: new Map([
        [
          afterTriggerCreate,
          parsedTx({ signature: afterTriggerCreate, slot: TRIGGER_SLOT + 1, create: true }),
        ],
      ]),
    }),
    request({ headSlot: TRIGGER_SLOT + 2 }),
  );
  assert.equal(after.ok, false);
  if (!after.ok) assert.equal(after.code, "creation_not_before_trigger");
});

test("attestor rejects caller-fabricated trigger root, mint, signature, or slot evidence", async () => {
  const wrongMint = await attestFreshPumpFunCreate(
    fakeRpc(),
    request({ evidenceMint: key(9).toBase58() }),
  );
  assert.equal(wrongMint.ok, false);
  if (!wrongMint.ok) assert.equal(wrongMint.code, "trigger_evidence_invalid");

  const wrongRoot = await attestFreshPumpFunCreate(
    fakeRpc(),
    request({ evidenceRoot: key(10).toBase58() }),
  );
  assert.equal(wrongRoot.ok, false);
  if (!wrongRoot.ok) assert.equal(wrongRoot.code, "trigger_evidence_invalid");

  const mismatchedTx = parsedTx({ signature: "other-trigger", slot: TRIGGER_SLOT + 1 });
  const wrongIdentity = await attestFreshPumpFunCreate(
    fakeRpc(),
    request({ triggerTx: mismatchedTx }),
  );
  assert.equal(wrongIdentity.ok, false);
  if (!wrongIdentity.ok) assert.equal(wrongIdentity.code, "trigger_evidence_invalid");
});

test("attestor rejects a changed finalized head blockhash", async () => {
  const result = await attestFreshPumpFunCreate(fakeRpc({ headHash: "different" }), request());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "head_block_mismatch");
});

test("attestor rejects successful activity at or before activation", async () => {
  const result = await attestFreshPumpFunCreate(
    fakeRpc({
      signaturePages: [
        [
          {
            signature: CREATE_SIG,
            slot: CREATE_SLOT,
            blockTime: 1_800_000_000 + CREATE_SLOT,
            err: null,
            memo: null,
            confirmationStatus: "finalized",
          },
          {
            signature: "old-signature",
            slot: ACTIVATION_SLOT,
            blockTime: 1_800_000_000 + ACTIVATION_SLOT,
            err: null,
            memo: null,
            confirmationStatus: "finalized",
          },
        ],
      ],
    }),
    request(),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "pre_activation_activity");
});

test("attestor requires unpruned RPC history to reach the activation floor", async () => {
  const result = await attestFreshPumpFunCreate(
    fakeRpc({ firstAvailableBlock: ACTIVATION_SLOT + 1 }),
    request(),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "signature_history_pruned");
});

test("attestor fails closed on reordered pages and unavailable transactions", async () => {
  const reordered = await attestFreshPumpFunCreate(
    fakeRpc({
      signaturePages: [
        [
          {
            signature: CREATE_SIG,
            slot: CREATE_SLOT,
            blockTime: 1_800_000_000 + CREATE_SLOT,
            err: null,
            memo: null,
            confirmationStatus: "finalized",
          },
          {
            signature: TRIGGER_SIG,
            slot: TRIGGER_SLOT,
            blockTime: 1_800_000_000 + TRIGGER_SLOT,
            err: null,
            memo: null,
            confirmationStatus: "finalized",
          },
        ],
      ],
    }),
    request(),
  );
  assert.equal(reordered.ok, false);
  if (!reordered.ok) assert.equal(reordered.code, "signature_page_conflict");

  const unavailable = await attestFreshPumpFunCreate(
    fakeRpc({ transactions: new Map([[CREATE_SIG, null]]) }),
    request(),
  );
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) assert.equal(unavailable.code, "transaction_unavailable");
});

test("attestor fails closed when an older transaction before creation is unavailable or mismatched", async () => {
  const olderRow = {
    signature: "older-signature",
    slot: 110,
    blockTime: 1_800_000_110,
    err: null,
    memo: null,
    confirmationStatus: "finalized",
  };
  const pages = [
    [
      {
        signature: TRIGGER_SIG,
        slot: TRIGGER_SLOT,
        blockTime: 1_800_000_000 + TRIGGER_SLOT,
        err: null,
        memo: null,
        confirmationStatus: "finalized",
      },
      {
        signature: CREATE_SIG,
        slot: CREATE_SLOT,
        blockTime: 1_800_000_000 + CREATE_SLOT,
        err: null,
        memo: null,
        confirmationStatus: "finalized",
      },
      olderRow,
    ],
    [],
  ];
  const unavailable = await attestFreshPumpFunCreate(
    fakeRpc({
      signaturePages: pages,
      transactions: new Map([
        [CREATE_SIG, parsedTx({ signature: CREATE_SIG, slot: CREATE_SLOT, create: true })],
        [TRIGGER_SIG, parsedTx({ signature: TRIGGER_SIG, slot: TRIGGER_SLOT })],
        [olderRow.signature, null],
      ]),
    }),
    request(),
  );
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) assert.equal(unavailable.code, "transaction_unavailable");

  const mismatched = await attestFreshPumpFunCreate(
    fakeRpc({
      signaturePages: pages,
      transactions: new Map([
        [CREATE_SIG, parsedTx({ signature: CREATE_SIG, slot: CREATE_SLOT, create: true })],
        [TRIGGER_SIG, parsedTx({ signature: TRIGGER_SIG, slot: TRIGGER_SLOT })],
        [
          olderRow.signature,
          parsedTx({ signature: olderRow.signature, slot: olderRow.slot + 1 }),
        ],
      ]),
    }),
    request(),
  );
  assert.equal(mismatched.ok, false);
  if (!mismatched.ok) assert.equal(mismatched.code, "transaction_identity_conflict");
});

test("attestor scans after creation and rejects a second successful create proof", async () => {
  const secondCreateSig = "second-create-signature";
  const result = await attestFreshPumpFunCreate(
    fakeRpc({
      signaturePages: [
        [
          {
            signature: TRIGGER_SIG,
            slot: TRIGGER_SLOT,
            blockTime: 1_800_000_000 + TRIGGER_SLOT,
            err: null,
            memo: null,
            confirmationStatus: "finalized",
          },
          {
            signature: secondCreateSig,
            slot: CREATE_SLOT + 1,
            blockTime: 1_800_000_000 + CREATE_SLOT + 1,
            err: null,
            memo: null,
            confirmationStatus: "finalized",
          },
          {
            signature: CREATE_SIG,
            slot: CREATE_SLOT,
            blockTime: 1_800_000_000 + CREATE_SLOT,
            err: null,
            memo: null,
            confirmationStatus: "finalized",
          },
        ],
        [],
      ],
      transactions: new Map([
        [CREATE_SIG, parsedTx({ signature: CREATE_SIG, slot: CREATE_SLOT, create: true })],
        [
          secondCreateSig,
          parsedTx({ signature: secondCreateSig, slot: CREATE_SLOT + 1, create: true }),
        ],
        [TRIGGER_SIG, parsedTx({ signature: TRIGGER_SIG, slot: TRIGGER_SLOT })],
      ]),
    }),
    request(),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "create_conflict");
});

test("attestor rejects a completed Pump curve", async () => {
  const result = await attestFreshPumpFunCreate(fakeRpc({ curveComplete: true }), request());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "curve_completed");
    assert.equal(result.retryable, false);
  }
});

test("attestor rejects create identity conflicts and invalid current curve ownership", async () => {
  const wrongSlot = await attestFreshPumpFunCreate(
    fakeRpc({
      transactions: new Map([
        [CREATE_SIG, parsedTx({ signature: CREATE_SIG, slot: CREATE_SLOT + 1, create: true })],
        [TRIGGER_SIG, parsedTx({ signature: TRIGGER_SIG, slot: TRIGGER_SLOT })],
      ]),
    }),
    request(),
  );
  assert.equal(wrongSlot.ok, false);
  if (!wrongSlot.ok) assert.equal(wrongSlot.code, "transaction_identity_conflict");

  const wrongOwner = await attestFreshPumpFunCreate(
    fakeRpc({ curveOwner: key(8) }),
    request(),
  );
  assert.equal(wrongOwner.ok, false);
  if (!wrongOwner.ok) {
    assert.equal(wrongOwner.code, "curve_state_invalid");
    assert.equal(wrongOwner.retryable, false);
  }
});

test("attestor enforces one absolute deadline across sequential RPC calls", async () => {
  const clock = [1_000, 1_000, 1_100];
  const result = await attestFreshPumpFunCreate(
    fakeRpc(),
    request({
      deadlineMs: 1_100,
      nowMs: () => clock.shift() ?? 1_100,
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "deadline_exceeded");
    assert.equal(result.retryable, true);
  }
});

test("attestor reports deadline_exceeded when an RPC hangs through the remaining budget", async () => {
  const rpc = fakeRpc() as any;
  rpc.getBlock = async () => await new Promise(() => {});
  const result = await attestFreshPumpFunCreate(
    rpc,
    request({ deadlineMs: Date.now() + 20 }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "deadline_exceeded");
    assert.equal(result.retryable, true);
  }
});
