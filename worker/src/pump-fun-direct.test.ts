import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  unpackAccount,
} from "@solana/spl-token";
import { type AccountInfo, PublicKey } from "@solana/web3.js";
import classicFixture from "./pump-fun-direct-classic.fixture.json" with { type: "json" };
import fixture from "./pump-fun-direct-v2.fixture.json" with { type: "json" };
import { REVIEWED_PUMP_SDK_VERSION, buildPumpFunDirectSwap } from "./pump-fun-direct.js";

const require = createRequire(import.meta.url);
const { GLOBAL_PDA, PUMP_FEE_CONFIG_PDA, bondingCurvePda, bondingCurveV2Pda, PUMP_PROGRAM_ID } =
  require("@pump-fun/pump-sdk") as typeof import("@pump-fun/pump-sdk");

const MINT = new PublicKey("Fw5xoxp3JYrW1ELUCQ98t3MvRiMKSFk7WBEsMs8Gpump");
const OWNER = new PublicKey("89YMNptpZLBo21N8uzPXCQ2M4QrpimfDhJGvibyR9fpW");
const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

type FixtureRow = (typeof fixture.accounts)[number];

function info(row: FixtureRow): AccountInfo<Buffer> {
  return {
    data: Buffer.from(row.dataBase64, "base64"),
    executable: row.executable,
    lamports: row.lamports,
    owner: new PublicKey(row.owner),
    rentEpoch: row.rentEpoch,
  };
}

function fakeConnection(
  options: {
    curveSize?: 115 | 151;
    nonzeroCurveReserved?: boolean;
    ataAmountRaw?: bigint;
    unsafeMintExtension?: boolean;
    completeCurve?: boolean;
    mintSupplyRaw?: bigint;
    unsafeMintAuthority?: boolean;
    wrongAtaOwner?: boolean;
    frozenAta?: boolean;
  } = {},
) {
  const rows = fixture.accounts.map(info);
  if (options.curveSize === 151) {
    rows[2] = {
      ...rows[2]!,
      data: Buffer.concat([
        rows[2]!.data,
        Buffer.alloc(35),
        Buffer.from([options.nonzeroCurveReserved ? 1 : 0]),
      ]),
    };
  }
  if (options.ataAmountRaw !== undefined) {
    rows[4] = { ...rows[4]!, data: Buffer.from(rows[4]!.data) };
    rows[4]!.data.writeBigUInt64LE(options.ataAmountRaw, 64);
  }
  if (options.unsafeMintExtension) {
    rows[3] = { ...rows[3]!, data: Buffer.from(rows[3]!.data) };
    // Token-2022 TLV data begins after the 82-byte Mint layout, 83 bytes of
    // account padding and the one-byte account type. Replace MetadataPointer
    // with TransferFeeConfig to prove unsupported transfer semantics fail shut.
    rows[3]!.data.writeUInt16LE(1, 166);
  }
  if (options.completeCurve) {
    rows[2] = { ...rows[2]!, data: Buffer.from(rows[2]!.data) };
    rows[2]!.data.writeUInt8(1, 48);
  }
  if (options.mintSupplyRaw !== undefined) {
    rows[3] = { ...rows[3]!, data: Buffer.from(rows[3]!.data) };
    rows[3]!.data.writeBigUInt64LE(options.mintSupplyRaw, 36);
  }
  if (options.unsafeMintAuthority) {
    rows[3] = { ...rows[3]!, data: Buffer.from(rows[3]!.data) };
    rows[3]!.data.writeUInt32LE(1, 0);
    Buffer.from(OWNER.toBytes()).copy(rows[3]!.data, 4);
  }
  if (options.wrongAtaOwner) {
    rows[4] = { ...rows[4]!, data: Buffer.from(rows[4]!.data) };
    Buffer.from(MINT.toBytes()).copy(rows[4]!.data, 32);
  }
  if (options.frozenAta) {
    rows[4] = { ...rows[4]!, data: Buffer.from(rows[4]!.data) };
    rows[4]!.data.writeUInt8(2, 108);
  }
  return {
    async getMultipleAccountsInfoAndContext(addresses: PublicKey[]) {
      assert.equal(addresses.length, 6);
      assert(addresses[0]!.equals(GLOBAL_PDA));
      assert(addresses[1]!.equals(PUMP_FEE_CONFIG_PDA));
      assert(addresses[2]!.equals(bondingCurvePda(MINT)));
      assert(addresses[3]!.equals(MINT));
      assert(
        addresses[4]!.equals(getAssociatedTokenAddressSync(MINT, OWNER, false, TOKEN_PROGRAM_ID)),
      );
      assert(
        addresses[5]!.equals(
          getAssociatedTokenAddressSync(MINT, OWNER, false, TOKEN_2022_PROGRAM_ID),
        ),
      );
      return {
        context: { slot: fixture.capturedSlot },
        value: [rows[0], rows[1], rows[2], rows[3], null, rows[4]],
      };
    },
  };
}

function fakeClassicConnection() {
  const rows = classicFixture.accounts.map((row) => (row ? info(row as FixtureRow) : null));
  const mint = new PublicKey(classicFixture.mint);
  return {
    async getMultipleAccountsInfoAndContext(addresses: PublicKey[]) {
      assert.equal(addresses.length, 6);
      const owner = new PublicKey(classicFixture.owner);
      assert(addresses[0]!.equals(GLOBAL_PDA));
      assert(addresses[1]!.equals(PUMP_FEE_CONFIG_PDA));
      assert(addresses[2]!.equals(bondingCurvePda(mint)));
      assert(addresses[3]!.equals(mint));
      assert(
        addresses[4]!.equals(getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID)),
      );
      assert(
        addresses[5]!.equals(
          getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID),
        ),
      );
      return {
        context: { slot: classicFixture.capturedSlot },
        value: [rows[0], rows[1], rows[2], rows[3], rows[4], null],
      };
    },
  };
}

test("official Pump SDK dependency is exact and reviewed", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { dependencies?: Record<string, string> };
  assert.equal(REVIEWED_PUMP_SDK_VERSION, "1.36.0");
  assert.equal(packageJson.dependencies?.["@pump-fun/pump-sdk"], "1.36.0");
});

test("builds current Token-2022 native-SOL buy with exact max-spend cap", async () => {
  const result = await buildPumpFunDirectSwap({
    connection: fakeConnection() as never,
    owner: OWNER,
    mint: MINT,
    side: "buy",
    amountRaw: 20_000_000n,
    slippageBps: 800,
  });

  assert(result.tokenProgram.equals(TOKEN_2022_PROGRAM_ID));
  assert.equal(result.maxSolCostLamports, 21_600_000n);
  assert(result.quotedTokenAmountRaw && result.quotedTokenAmountRaw > 0n);
  assert.equal(result.instructions.length, 1, "fixture ATA already exists");
  const buy = result.instructions[0]!;
  assert(buy.programId.equals(PUMP_PROGRAM_ID));
  assert.deepEqual(buy.data.subarray(0, 8), BUY_DISCRIMINATOR);
  assert.equal(buy.data.readBigUInt64LE(8), result.quotedTokenAmountRaw);
  assert.equal(buy.data.readBigUInt64LE(16), 21_600_000n);
  assert.equal(buy.data.length, 25, "reviewed Buy ABI includes track-volume flag");
  assert.equal(buy.keys.length, 18, "reviewed fee-recipient upgrade adds two accounts");
  assert(buy.keys[2]!.pubkey.equals(MINT));
  assert(buy.keys[8]!.pubkey.equals(TOKEN_2022_PROGRAM_ID));
  assert(buy.keys[16]!.pubkey.equals(bondingCurveV2Pda(MINT)));
});

test("preserves classic SPL Pump buys and creates only the canonical ATA", async () => {
  const mint = new PublicKey(classicFixture.mint);
  const result = await buildPumpFunDirectSwap({
    connection: fakeClassicConnection() as never,
    owner: new PublicKey(classicFixture.owner),
    mint,
    side: "buy",
    amountRaw: 20_000_000n,
    slippageBps: 800,
  });

  assert(result.tokenProgram.equals(TOKEN_PROGRAM_ID));
  assert.equal(result.preTradeAtaBalanceRaw, 0n);
  assert.equal(result.instructions.length, 2);
  assert(result.instructions[0]!.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
  assert(result.instructions[1]!.programId.equals(PUMP_PROGRAM_ID));
  assert.deepEqual(result.instructions[1]!.data.subarray(0, 8), BUY_DISCRIMINATOR);
  assert(result.instructions[1]!.keys[8]!.pubkey.equals(TOKEN_PROGRAM_ID));
});

test("builds Token-2022 emergency sell from only its reviewed ATA balance", async () => {
  const ataBalance = 9_007_199_254_740_993n;
  const amount = 1_000_000_000_000n;
  const result = await buildPumpFunDirectSwap({
    connection: fakeConnection({ ataAmountRaw: ataBalance }) as never,
    owner: OWNER,
    mint: MINT,
    side: "sell",
    amountRaw: amount,
    slippageBps: 800,
  });

  assert.equal(result.preTradeAtaBalanceRaw, ataBalance);
  assert(result.quotedSolAmountLamports && result.quotedSolAmountLamports > 0n);
  assert.equal(result.minSolOutputLamports, (result.quotedSolAmountLamports! * 9_200n) / 10_000n);
  const sell = result.instructions[0]!;
  assert.deepEqual(sell.data.subarray(0, 8), SELL_DISCRIMINATOR);
  assert.equal(sell.data.readBigUInt64LE(8), amount);
  assert.equal(sell.data.readBigUInt64LE(16), result.minSolOutputLamports);
  assert.equal(
    unpackAccount(
      result.associatedUser,
      info(fixture.accounts[4]!),
      TOKEN_2022_PROGRAM_ID,
    ).mint.toBase58(),
    MINT.toBase58(),
  );
});

test("accepts only reviewed zero-reserved 151-byte curve allocation", async () => {
  const accepted = await buildPumpFunDirectSwap({
    connection: fakeConnection({ curveSize: 151 }) as never,
    owner: OWNER,
    mint: MINT,
    side: "buy",
    amountRaw: 10_000_000n,
    slippageBps: 800,
  });
  assert.equal(accepted.observedSlot, fixture.capturedSlot);

  await assert.rejects(
    buildPumpFunDirectSwap({
      connection: fakeConnection({ curveSize: 151, nonzeroCurveReserved: true }) as never,
      owner: OWNER,
      mint: MINT,
      side: "buy",
      amountRaw: 10_000_000n,
      slippageBps: 800,
    }),
    /nonzero unreviewed reserved data/,
  );
});

test("rejects unsafe Token-2022 extensions and ATA overdrafts", async () => {
  await assert.rejects(
    buildPumpFunDirectSwap({
      connection: fakeConnection({ unsafeMintExtension: true }) as never,
      owner: OWNER,
      mint: MINT,
      side: "buy",
      amountRaw: 10_000_000n,
      slippageBps: 800,
    }),
    /extension set is unsupported/,
  );
  await assert.rejects(
    buildPumpFunDirectSwap({
      connection: fakeConnection({ ataAmountRaw: 99n }) as never,
      owner: OWNER,
      mint: MINT,
      side: "sell",
      amountRaw: 100n,
      slippageBps: 800,
    }),
    /exceeds the reviewed associated token account balance/,
  );
});

test("fails closed on completed, inconsistent, authoritative, or misowned state", async () => {
  const input = {
    owner: OWNER,
    mint: MINT,
    side: "buy" as const,
    amountRaw: 10_000_000n,
    slippageBps: 800,
  };
  await assert.rejects(
    buildPumpFunDirectSwap({
      ...input,
      connection: fakeConnection({ completeCurve: true }) as never,
    }),
    /curve is already complete/,
  );
  await assert.rejects(
    buildPumpFunDirectSwap({
      ...input,
      connection: fakeConnection({ mintSupplyRaw: 1n }) as never,
    }),
    /curve and mint supply disagree/,
  );
  await assert.rejects(
    buildPumpFunDirectSwap({
      ...input,
      connection: fakeConnection({ unsafeMintAuthority: true }) as never,
    }),
    /retains an unsafe authority/,
  );
  await assert.rejects(
    buildPumpFunDirectSwap({
      ...input,
      connection: fakeConnection({ wrongAtaOwner: true }) as never,
    }),
    /wrong identity/,
  );
  await assert.rejects(
    buildPumpFunDirectSwap({
      ...input,
      connection: fakeConnection({ frozenAta: true }) as never,
    }),
    /unsafe authority or account state/,
  );
});
