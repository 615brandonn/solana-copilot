import anchor from "@coral-xyz/anchor";
import { createRequire } from "node:module";
import {
  ExtensionType,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getExtensionTypes,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import type { BondingCurve, FeeConfig, Global } from "@pump-fun/pump-sdk";
import {
  type AccountInfo,
  type Commitment,
  type Connection,
  PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";

export const REVIEWED_PUMP_SDK_VERSION = "1.36.0";
// pump-sdk 1.36.0's published ESM barrel eagerly loads an invalid ESM build of
// its optional agent-payments dependency. Its reviewed CommonJS export is
// valid. Loading that exact export explicitly avoids a process-start crash
// without copying or weakening the official instruction builder.
const require = createRequire(import.meta.url);
const { BN } = anchor;
const pumpSdkRuntime = require("@pump-fun/pump-sdk") as typeof import("@pump-fun/pump-sdk");
const {
  GLOBAL_PDA,
  PUMP_FEE_CONFIG_PDA,
  PUMP_FEE_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  PUMP_SDK,
  bondingCurvePda,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
} = pumpSdkRuntime;
const CURVE_LEGACY_V2_SIZE = 115;
const CURVE_CURRENT_SIZE = 151;
const CURVE_RESERVED_START = CURVE_LEGACY_V2_SIZE;
const MAX_SLIPPAGE_BPS = 5_000;

export type PumpFunDirectSide = "buy" | "sell";

export type PumpFunDirectBuildInput = {
  connection: Connection;
  owner: PublicKey;
  mint: PublicKey;
  side: PumpFunDirectSide;
  /** Nominal SOL lamports for buys; exact token raw units for sells. */
  amountRaw: bigint;
  slippageBps: number;
  commitment?: Commitment;
  timeoutMs?: number;
};

export type PumpFunDirectBuildResult = {
  instructions: TransactionInstruction[];
  observedSlot: number;
  tokenProgram: PublicKey;
  decimals: number;
  totalSupplyRaw: bigint;
  quotedTokenAmountRaw?: bigint;
  quotedSolAmountLamports?: bigint;
  maxSolCostLamports?: bigint;
  minSolOutputLamports?: bigint;
  preTradeAtaBalanceRaw: bigint;
  associatedUser: PublicKey;
};

type LoadedPumpState = {
  observedSlot: number;
  tokenProgram: PublicKey;
  decimals: number;
  totalSupplyRaw: bigint;
  global: Global;
  feeConfig: FeeConfig;
  bondingCurve: BondingCurve;
  associatedUser: PublicKey;
  associatedUserAccountInfo: AccountInfo<Buffer> | null;
  associatedUserBalanceRaw: bigint;
};

function checkedAmount(value: bigint, label: string): bigint {
  if (value <= 0n || value > (1n << 64n) - 1n) {
    throw new Error(`${label} must be a positive u64`);
  }
  return value;
}

function checkedSlippageBps(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_SLIPPAGE_BPS) {
    throw new Error(`Pump.fun slippage must be an integer from 0 to ${MAX_SLIPPAGE_BPS} bps`);
  }
  return value;
}

function ceilBps(value: bigint, bps: number): bigint {
  return (value * BigInt(10_000 + bps) + 9_999n) / 10_000n;
}

function floorBps(value: bigint, bps: number): bigint {
  return (value * BigInt(10_000 - bps)) / 10_000n;
}

function isZeroPublicKey(value: PublicKey): boolean {
  return value.equals(PublicKey.default);
}

function chooseDeterministicAddress(
  candidates: readonly PublicKey[],
  owner: PublicKey,
  mint: PublicKey,
  label: string,
): PublicKey {
  const usable = candidates.filter((value) => !isZeroPublicKey(value));
  if (usable.length === 0 || usable.length !== candidates.length) {
    throw new Error(`Pump.fun ${label} set is missing or malformed`);
  }
  const ownerBytes = owner.toBytes();
  const mintBytes = mint.toBytes();
  let selector = 0;
  for (let index = 0; index < 32; index += 1) {
    selector = (selector + ownerBytes[index]! + mintBytes[31 - index]!) >>> 0;
  }
  return usable[selector % usable.length]!;
}

function feeRecipient(global: Global, curve: BondingCurve, owner: PublicKey, mint: PublicKey) {
  const candidates = curve.isMayhemMode
    ? [global.reservedFeeRecipient, ...global.reservedFeeRecipients]
    : [global.feeRecipient, ...global.feeRecipients];
  if (candidates.length !== 8) {
    throw new Error("Pump.fun fee-recipient set is not the reviewed eight-account layout");
  }
  return chooseDeterministicAddress(candidates, owner, mint, "fee-recipient");
}

function buybackFeeRecipient(global: Global, owner: PublicKey, mint: PublicKey) {
  if (global.buybackFeeRecipients.length !== 8) {
    throw new Error("Pump.fun buyback-recipient set is not the reviewed eight-account layout");
  }
  return chooseDeterministicAddress(global.buybackFeeRecipients, owner, mint, "buyback-recipient");
}

function assertReviewedCurveAllocation(data: Buffer): void {
  if (data.length === CURVE_LEGACY_V2_SIZE) return;
  if (data.length !== CURVE_CURRENT_SIZE) {
    throw new Error(`Pump.fun curve has unsupported account size ${data.length}`);
  }
  if (data.subarray(CURVE_RESERVED_START).some((byte) => byte !== 0)) {
    throw new Error("Pump.fun curve has nonzero unreviewed reserved data");
  }
}

function assertReviewedMintExtensions(
  tokenProgram: PublicKey,
  mintData: Buffer,
  mintState: ReturnType<typeof unpackMint>,
) {
  const extensions = getExtensionTypes(mintState.tlvData);
  if (tokenProgram.equals(TOKEN_PROGRAM_ID)) {
    if (extensions.length !== 0) {
      throw new Error("legacy SPL Pump.fun mint unexpectedly contains extensions");
    }
    return;
  }
  const reviewed = [ExtensionType.MetadataPointer, ExtensionType.TokenMetadata];
  if (
    extensions.length !== reviewed.length ||
    reviewed.some((extension, index) => extensions[index] !== extension)
  ) {
    throw new Error(
      `Token-2022 Pump.fun mint extension set is unsupported: ${extensions.join(",") || "none"}`,
    );
  }
  if (mintData.length <= 82) {
    throw new Error("Token-2022 Pump.fun mint is missing reviewed extension data");
  }
}

function requireOwnedAccount(
  account: AccountInfo<Buffer> | null,
  owner: PublicKey,
  label: string,
): AccountInfo<Buffer> {
  if (!account || !account.owner.equals(owner)) {
    throw new Error(`${label} is missing or owned by an unexpected program`);
  }
  return account;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Pump.fun direct state RPC timed out")),
          Math.max(1, timeoutMs),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function loadPumpState(input: PumpFunDirectBuildInput): Promise<LoadedPumpState> {
  const bondingCurveAddress = bondingCurvePda(input.mint);
  const legacyAssociatedUser = getAssociatedTokenAddressSync(
    input.mint,
    input.owner,
    false,
    TOKEN_PROGRAM_ID,
  );
  const token2022AssociatedUser = getAssociatedTokenAddressSync(
    input.mint,
    input.owner,
    false,
    TOKEN_2022_PROGRAM_ID,
  );
  const response = await withTimeout(
    input.connection.getMultipleAccountsInfoAndContext(
      [
        GLOBAL_PDA,
        PUMP_FEE_CONFIG_PDA,
        bondingCurveAddress,
        input.mint,
        legacyAssociatedUser,
        token2022AssociatedUser,
      ],
      { commitment: input.commitment ?? "processed" },
    ),
    input.timeoutMs ?? 2_500,
  );
  if (
    !response ||
    !response.context ||
    !Number.isSafeInteger(response.context.slot) ||
    response.context.slot <= 0
  ) {
    throw new Error("Pump.fun direct state RPC returned an invalid context");
  }
  const [
    globalInfoValue,
    feeConfigInfoValue,
    curveInfoValue,
    mintInfoValue,
    legacyUserInfoValue,
    token2022UserInfoValue,
  ] = response.value;
  if (!mintInfoValue) throw new Error("Pump.fun mint account is missing");
  const tokenProgram = mintInfoValue.owner;
  if (!tokenProgram.equals(TOKEN_PROGRAM_ID) && !tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error("Pump.fun mint uses an unsupported token program");
  }
  const associatedUser = tokenProgram.equals(TOKEN_PROGRAM_ID)
    ? legacyAssociatedUser
    : token2022AssociatedUser;
  const userInfoValue = tokenProgram.equals(TOKEN_PROGRAM_ID)
    ? legacyUserInfoValue
    : token2022UserInfoValue;
  const globalInfo = requireOwnedAccount(globalInfoValue, PUMP_PROGRAM_ID, "Pump.fun global");
  const feeConfigInfo = requireOwnedAccount(
    feeConfigInfoValue,
    PUMP_FEE_PROGRAM_ID,
    "Pump.fun fee config",
  );
  const curveInfo = requireOwnedAccount(curveInfoValue, PUMP_PROGRAM_ID, "Pump.fun curve");
  const mintInfo = requireOwnedAccount(mintInfoValue, tokenProgram, "Pump.fun mint");
  assertReviewedCurveAllocation(curveInfo.data);

  let global: Global;
  let feeConfig: FeeConfig;
  let bondingCurve: BondingCurve;
  let mintState: ReturnType<typeof unpackMint>;
  try {
    global = PUMP_SDK.decodeGlobal(globalInfo);
    feeConfig = PUMP_SDK.decodeFeeConfig(feeConfigInfo);
    bondingCurve = PUMP_SDK.decodeBondingCurve(curveInfo);
    mintState = unpackMint(input.mint, mintInfo, tokenProgram);
  } catch {
    throw new Error("Pump.fun direct state decoding failed");
  }
  if (!global.initialized) throw new Error("Pump.fun global configuration is not initialized");
  if (bondingCurve.complete) throw new Error("Pump.fun curve is already complete");
  if (
    !bondingCurve.quoteMint.equals(PublicKey.default) &&
    !bondingCurve.quoteMint.equals(NATIVE_MINT)
  ) {
    throw new Error("Pump.fun curve is not paired with native SOL");
  }
  if (
    bondingCurve.virtualTokenReserves.lten(0) ||
    bondingCurve.virtualQuoteReserves.lten(0) ||
    bondingCurve.realTokenReserves.lten(0) ||
    bondingCurve.tokenTotalSupply.lten(0)
  ) {
    throw new Error("Pump.fun curve has invalid reserves or supply");
  }
  if (mintState.supply !== BigInt(bondingCurve.tokenTotalSupply.toString())) {
    throw new Error("Pump.fun curve and mint supply disagree");
  }
  if (mintState.decimals < 0 || mintState.decimals > 18) {
    throw new Error("Pump.fun mint decimals are unsupported");
  }
  if (!mintState.isInitialized) {
    throw new Error("Pump.fun mint is not initialized");
  }
  if (mintState.mintAuthority !== null || mintState.freezeAuthority !== null) {
    throw new Error("Pump.fun mint retains an unsafe authority");
  }
  assertReviewedMintExtensions(tokenProgram, mintInfo.data, mintState);

  let associatedUserBalanceRaw = 0n;
  if (userInfoValue) {
    const userInfo = requireOwnedAccount(userInfoValue, tokenProgram, "Pump.fun user ATA");
    let tokenAccount: ReturnType<typeof unpackAccount>;
    try {
      tokenAccount = unpackAccount(associatedUser, userInfo, tokenProgram);
    } catch {
      throw new Error("Pump.fun user ATA is malformed");
    }
    if (!tokenAccount.owner.equals(input.owner) || !tokenAccount.mint.equals(input.mint)) {
      throw new Error("Pump.fun user ATA has the wrong identity");
    }
    if (
      !tokenAccount.isInitialized ||
      tokenAccount.isFrozen ||
      tokenAccount.isNative ||
      tokenAccount.delegate !== null ||
      tokenAccount.closeAuthority !== null
    ) {
      throw new Error("Pump.fun user ATA has an unsafe authority or account state");
    }
    const accountExtensions = getExtensionTypes(tokenAccount.tlvData);
    const expectedAccountExtensions = tokenProgram.equals(TOKEN_2022_PROGRAM_ID)
      ? [ExtensionType.ImmutableOwner]
      : [];
    if (
      accountExtensions.length !== expectedAccountExtensions.length ||
      expectedAccountExtensions.some((extension, index) => accountExtensions[index] !== extension)
    ) {
      throw new Error("Pump.fun user ATA has unsupported token-account extensions");
    }
    associatedUserBalanceRaw = tokenAccount.amount;
  }

  return {
    observedSlot: response.context.slot,
    tokenProgram,
    decimals: mintState.decimals,
    totalSupplyRaw: mintState.supply,
    global,
    feeConfig,
    bondingCurve,
    associatedUser,
    associatedUserAccountInfo: userInfoValue,
    associatedUserBalanceRaw,
  };
}

export async function buildPumpFunDirectSwap(
  input: PumpFunDirectBuildInput,
): Promise<PumpFunDirectBuildResult> {
  checkedAmount(input.amountRaw, input.side === "buy" ? "buy SOL amount" : "sell token amount");
  const slippageBps = checkedSlippageBps(input.slippageBps);
  const state = await loadPumpState(input);
  const fee = feeRecipient(state.global, state.bondingCurve, input.owner, input.mint);
  const buyback = buybackFeeRecipient(state.global, input.owner, input.mint);
  const base = {
    observedSlot: state.observedSlot,
    tokenProgram: state.tokenProgram,
    decimals: state.decimals,
    totalSupplyRaw: state.totalSupplyRaw,
    preTradeAtaBalanceRaw: state.associatedUserBalanceRaw,
    associatedUser: state.associatedUser,
  };

  if (input.side === "buy") {
    const nominalSol = new BN(input.amountRaw.toString());
    const quotedTokens = getBuyTokenAmountFromSolAmount({
      global: state.global,
      feeConfig: state.feeConfig,
      mintSupply: new BN(state.totalSupplyRaw.toString()),
      bondingCurve: state.bondingCurve,
      amount: nominalSol,
      quoteMint: NATIVE_MINT,
    });
    const quotedTokenAmountRaw = checkedAmount(
      BigInt(quotedTokens.toString()),
      "quoted token amount",
    );
    const maxSolCostLamports = checkedAmount(
      ceilBps(input.amountRaw, slippageBps),
      "maximum SOL cost",
    );
    const instructions: TransactionInstruction[] = [];
    if (!state.associatedUserAccountInfo) {
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          input.owner,
          state.associatedUser,
          input.owner,
          input.mint,
          state.tokenProgram,
        ),
      );
    }
    instructions.push(
      await PUMP_SDK.getBuyInstructionRaw({
        user: input.owner,
        mint: input.mint,
        creator: state.bondingCurve.creator,
        amount: new BN(quotedTokenAmountRaw.toString()),
        solAmount: new BN(maxSolCostLamports.toString()),
        feeRecipient: fee,
        buybackFeeRecipient: buyback,
        tokenProgram: state.tokenProgram,
      }),
    );
    return {
      ...base,
      instructions,
      quotedTokenAmountRaw,
      quotedSolAmountLamports: input.amountRaw,
      maxSolCostLamports,
    };
  }

  if (!state.associatedUserAccountInfo) {
    throw new Error(
      "Pump.fun sell blocked because the reviewed associated token account is missing",
    );
  }
  if (state.associatedUserBalanceRaw < input.amountRaw) {
    throw new Error("Pump.fun sell amount exceeds the reviewed associated token account balance");
  }
  const quotedSol = getSellSolAmountFromTokenAmount({
    global: state.global,
    feeConfig: state.feeConfig,
    mintSupply: new BN(state.totalSupplyRaw.toString()),
    bondingCurve: state.bondingCurve,
    amount: new BN(input.amountRaw.toString()),
  });
  const quotedSolAmountLamports = checkedAmount(BigInt(quotedSol.toString()), "quoted SOL output");
  const minSolOutputLamports = checkedAmount(
    floorBps(quotedSolAmountLamports, slippageBps),
    "minimum SOL output",
  );
  const instruction = await PUMP_SDK.getSellInstructionRaw({
    user: input.owner,
    mint: input.mint,
    creator: state.bondingCurve.creator,
    amount: new BN(input.amountRaw.toString()),
    solAmount: new BN(minSolOutputLamports.toString()),
    feeRecipient: fee,
    buybackFeeRecipient: buyback,
    tokenProgram: state.tokenProgram,
    cashback: state.bondingCurve.isCashbackCoin,
  });
  return {
    ...base,
    instructions: [instruction],
    quotedSolAmountLamports,
    minSolOutputLamports,
  };
}
