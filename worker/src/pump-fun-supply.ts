import { createHash } from "node:crypto";
import { type Commitment, Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ExtensionType,
  getExtensionData,
  getExtensionTypes,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackMint,
} from "@solana/spl-token";
import { unpack as unpackTokenMetadata } from "@solana/spl-token-metadata";

export const PUMP_FUN_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const PUMP_FUN_STANDARD_TOTAL_SUPPLY_RAW = 1_000_000_000_000_000n;
const BONDING_CURVE_SEED = Buffer.from("bonding-curve");
const BONDING_CURVE_DISCRIMINATOR = 6_966_180_631_402_821_399n;

export const PUMP_FUN_SNAPSHOT_PARSER_SCHEMA = [
  "pump_fun_snapshot_v1",
  "program=6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  "curve_discriminator=6966180631402821399le",
  "curve_layouts=classic:49|115|151-zero-tail;create_v2_token2022:115|151-zero-tail",
  "curve_fields=virtual_token_u64,virtual_sol_u64,real_token_u64,real_sol_u64,total_supply_u64,complete_bool,creator_pubkey,mayhem_bool,cashback_bool,quote_mint_system",
  "mint_classic=Tokenkeg+len82+no_extensions",
  "mint_v2=TokenzQ+MetadataPointer(self,immutable)+TokenMetadata(immutable,no-additional-metadata)",
  "mint_common=initialized+null_mint_authority+null_freeze_authority+supply_equals_curve_total+decimals6",
  "identity=sha256_exact_curve_bytes+sha256_exact_mint_bytes+observed_context_slot",
].join(";");
export const PUMP_FUN_SNAPSHOT_PARSER_ABI_FINGERPRINT = createHash("sha256")
  .update(PUMP_FUN_SNAPSHOT_PARSER_SCHEMA)
  .digest("hex");

export type PumpFunSupplySnapshot = {
  mint: string;
  observedSlot: number;
  totalSupplyRaw: bigint;
  decimals: number;
  virtualTokenReservesRaw: bigint;
  virtualSolReservesLamports: bigint;
  realTokenReservesRaw: bigint;
  realSolReservesLamports: bigint;
  complete: boolean;
  createVariant?: "classic_v1" | "create_v2_token2022";
  tokenProgram?: string;
  creator?: string;
  isMayhemMode?: boolean;
  isCashbackEnabled?: boolean;
  quoteMint?: string;
  mintLayoutFingerprint?: string;
  curveStateFingerprint?: string;
};

export type ReviewedPumpFunStateExpectation = {
  createVariant?: "classic_v1" | "create_v2_token2022";
  tokenProgram?: string;
  creator?: string;
  name?: string;
  symbol?: string;
  uri?: string;
  isMayhemMode?: boolean;
  isCashbackEnabled?: boolean;
};

export type PumpFunMarketCapCheck = {
  currentMarketCapUsd: number;
  projectedPostBuyMarketCapUsd: number;
  belowCap: boolean;
};

export type ConfirmedSourceTransaction = {
  slot: number;
  blockTimeMs: number;
  confirmationStatus: "confirmed" | "finalized";
};

export async function solanaRpcWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Solana RPC call timed out")),
          Math.max(1, timeoutMs),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function pumpFunBondingCurveAddress(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [BONDING_CURVE_SEED, mint.toBuffer()],
    PUMP_FUN_PROGRAM_ID,
  )[0];
}

function readCurveU64(data: Buffer, offset: number): bigint | null {
  try {
    return data.readBigUInt64LE(offset);
  } catch {
    return null;
  }
}

/**
 * Decodes only reviewed Pump curve + mint layouts. Current 151-byte curves are
 * accepted only while the 36-byte post-IDL tail remains all zero. Token-2022
 * mints are limited to immutable self-pointing metadata; transfer fees, hooks,
 * scaled UI amounts, non-transferable flags, and every other extension fail.
 */
export function decodeReviewedPumpFunSupplyAccounts(
  mint: PublicKey,
  curveAccount: { owner: PublicKey; data: Buffer | Uint8Array },
  mintAccount: { owner: PublicKey; data: Buffer | Uint8Array },
  observedSlot: number,
  expected: ReviewedPumpFunStateExpectation = {},
): PumpFunSupplySnapshot | null {
  if (
    !Number.isSafeInteger(observedSlot) ||
    observedSlot <= 0 ||
    !curveAccount.owner.equals(PUMP_FUN_PROGRAM_ID)
  ) {
    return null;
  }
  const tokenProgram = mintAccount.owner.toBase58();
  const createVariant = mintAccount.owner.equals(TOKEN_PROGRAM_ID)
    ? "classic_v1"
    : mintAccount.owner.equals(TOKEN_2022_PROGRAM_ID)
      ? "create_v2_token2022"
      : null;
  if (
    !createVariant ||
    (expected.createVariant && expected.createVariant !== createVariant) ||
    (expected.tokenProgram && expected.tokenProgram !== tokenProgram)
  ) {
    return null;
  }

  const curveData = Buffer.from(curveAccount.data);
  const permittedCurveLengths =
    createVariant === "create_v2_token2022" ? [115, 151] : [49, 115, 151];
  if (!permittedCurveLengths.includes(curveData.length)) return null;
  if (curveData.length === 151 && curveData.subarray(115).some((byte) => byte !== 0)) {
    return null;
  }
  const discriminator = readCurveU64(curveData, 0);
  const virtualTokenReservesRaw = readCurveU64(curveData, 8);
  const virtualSolReservesLamports = readCurveU64(curveData, 16);
  const realTokenReservesRaw = readCurveU64(curveData, 24);
  const realSolReservesLamports = readCurveU64(curveData, 32);
  const totalSupplyRaw = readCurveU64(curveData, 40);
  const completeByte = curveData[48];
  if (
    discriminator !== BONDING_CURVE_DISCRIMINATOR ||
    virtualTokenReservesRaw === null ||
    virtualTokenReservesRaw <= 0n ||
    virtualSolReservesLamports === null ||
    virtualSolReservesLamports <= 0n ||
    realTokenReservesRaw === null ||
    realSolReservesLamports === null ||
    totalSupplyRaw === null ||
    totalSupplyRaw <= 0n ||
    (completeByte !== 0 && completeByte !== 1)
  ) {
    return null;
  }
  let creator: string | undefined;
  let isMayhemMode: boolean | undefined;
  let isCashbackEnabled: boolean | undefined;
  let quoteMint: string | undefined;
  if (curveData.length >= 115) {
    try {
      creator = new PublicKey(curveData.subarray(49, 81)).toBase58();
      isMayhemMode = curveData[81] === 1;
      isCashbackEnabled = curveData[82] === 1;
      quoteMint = new PublicKey(curveData.subarray(83, 115)).toBase58();
    } catch {
      return null;
    }
    if (
      (curveData[81] !== 0 && curveData[81] !== 1) ||
      (curveData[82] !== 0 && curveData[82] !== 1) ||
      quoteMint !== SystemProgram.programId.toBase58() ||
      (expected.creator && expected.creator !== creator) ||
      (expected.isMayhemMode !== undefined && expected.isMayhemMode !== isMayhemMode) ||
      (expected.isCashbackEnabled !== undefined &&
        expected.isCashbackEnabled !== isCashbackEnabled)
    ) {
      return null;
    }
  } else if (
    createVariant !== "classic_v1" ||
    expected.isMayhemMode === true ||
    expected.isCashbackEnabled === true
  ) {
    return null;
  }

  const mintData = Buffer.from(mintAccount.data);
  let decodedMint: ReturnType<typeof unpackMint>;
  try {
    decodedMint = unpackMint(mint, { ...mintAccount, data: mintData } as any, mintAccount.owner);
  } catch {
    return null;
  }
  if (
    !decodedMint.isInitialized ||
    decodedMint.mintAuthority !== null ||
    decodedMint.freezeAuthority !== null ||
    decodedMint.supply !== totalSupplyRaw ||
    decodedMint.decimals !== 6
  ) {
    return null;
  }
  const extensionTypes = getExtensionTypes(decodedMint.tlvData).sort((left, right) => left - right);
  if (createVariant === "classic_v1") {
    if (mintData.length !== 82 || extensionTypes.length !== 0) return null;
  } else {
    if (
      curveData.length < 115 ||
      extensionTypes.length !== 2 ||
      extensionTypes[0] !== ExtensionType.MetadataPointer ||
      extensionTypes[1] !== ExtensionType.TokenMetadata
    ) {
      return null;
    }
    const pointerData = getExtensionData(ExtensionType.MetadataPointer, decodedMint.tlvData);
    const metadataData = getExtensionData(ExtensionType.TokenMetadata, decodedMint.tlvData);
    if (!pointerData || !metadataData) return null;
    try {
      const metadata = unpackTokenMetadata(metadataData);
      if (
        pointerData.length !== 64 ||
        pointerData.subarray(0, 32).some((byte) => byte !== 0) ||
        new PublicKey(pointerData.subarray(32, 64)).toBase58() !== mint.toBase58() ||
        metadata.updateAuthority !== undefined ||
        metadata.mint.toBase58() !== mint.toBase58() ||
        metadata.additionalMetadata.length !== 0 ||
        (expected.name !== undefined && metadata.name !== expected.name) ||
        (expected.symbol !== undefined && metadata.symbol !== expected.symbol) ||
        (expected.uri !== undefined && metadata.uri !== expected.uri)
      ) {
        return null;
      }
    } catch {
      return null;
    }
  }

  return {
    mint: mint.toBase58(),
    observedSlot,
    totalSupplyRaw,
    decimals: decodedMint.decimals,
    virtualTokenReservesRaw,
    virtualSolReservesLamports,
    realTokenReservesRaw,
    realSolReservesLamports,
    complete: completeByte === 1,
    createVariant,
    tokenProgram,
    creator,
    isMayhemMode,
    isCashbackEnabled,
    quoteMint,
    mintLayoutFingerprint: createHash("sha256").update(mintData).digest("hex"),
    curveStateFingerprint: createHash("sha256").update(curveData).digest("hex"),
  };
}

export async function loadPumpFunSupplySnapshot(
  connection: Connection,
  tokenMint: string,
  options: { commitment?: Commitment; minContextSlot?: number; rpcCallTimeoutMs?: number } = {},
): Promise<PumpFunSupplySnapshot | null> {
  let mint: PublicKey;
  try {
    mint = new PublicKey(tokenMint);
  } catch {
    return null;
  }
  const bondingCurve = pumpFunBondingCurveAddress(mint);
  const response = await solanaRpcWithTimeout(
    connection.getMultipleAccountsInfoAndContext([bondingCurve, mint], {
      commitment: options.commitment ?? "confirmed",
      ...(options.minContextSlot && options.minContextSlot > 0
        ? { minContextSlot: Math.trunc(options.minContextSlot) }
        : {}),
    }),
    options.rpcCallTimeoutMs ?? 2_000,
  );
  const [account, mintAccount] = response.value;
  if (!account || !mintAccount) return null;
  return decodeReviewedPumpFunSupplyAccounts(
    mint,
    { owner: account.owner, data: account.data },
    { owner: mintAccount.owner, data: mintAccount.data },
    response.context.slot,
  );
}

function marketCapLamports(
  totalSupplyRaw: bigint,
  virtualSolReservesLamports: bigint,
  virtualTokenReservesRaw: bigint,
): bigint | null {
  if (totalSupplyRaw <= 0n || virtualSolReservesLamports <= 0n || virtualTokenReservesRaw <= 0n) {
    return null;
  }
  return (totalSupplyRaw * virtualSolReservesLamports) / virtualTokenReservesRaw;
}

export function projectedPumpFunMarketCaps(
  snapshot: PumpFunSupplySnapshot,
  solPriceUsd: number,
  buyLamports: bigint,
  maxMarketCapUsd: number,
): PumpFunMarketCapCheck | null {
  if (
    snapshot.complete ||
    !Number.isFinite(solPriceUsd) ||
    solPriceUsd <= 0 ||
    buyLamports <= 0n ||
    !Number.isFinite(maxMarketCapUsd) ||
    maxMarketCapUsd <= 0
  ) {
    return null;
  }

  const currentLamports = marketCapLamports(
    snapshot.totalSupplyRaw,
    snapshot.virtualSolReservesLamports,
    snapshot.virtualTokenReservesRaw,
  );
  if (currentLamports === null) return null;

  const invariant = snapshot.virtualSolReservesLamports * snapshot.virtualTokenReservesRaw;
  const postVirtualSol = snapshot.virtualSolReservesLamports + buyLamports;
  const formulaPostVirtualToken = invariant / postVirtualSol + 1n;
  const formulaTokenOut = snapshot.virtualTokenReservesRaw - formulaPostVirtualToken;
  const tokenOut =
    formulaTokenOut < snapshot.realTokenReservesRaw
      ? formulaTokenOut
      : snapshot.realTokenReservesRaw;
  const postVirtualToken = snapshot.virtualTokenReservesRaw - tokenOut;
  const postLamports = marketCapLamports(snapshot.totalSupplyRaw, postVirtualSol, postVirtualToken);
  if (postLamports === null) return null;

  const currentMarketCapUsd = (Number(currentLamports) / 1e9) * solPriceUsd;
  const projectedPostBuyMarketCapUsd = (Number(postLamports) / 1e9) * solPriceUsd;
  if (!Number.isFinite(currentMarketCapUsd) || !Number.isFinite(projectedPostBuyMarketCapUsd)) {
    return null;
  }
  return {
    currentMarketCapUsd,
    projectedPostBuyMarketCapUsd,
    // "Under the configured ceiling" is strict. Equality does not pass.
    belowCap:
      currentMarketCapUsd < maxMarketCapUsd && projectedPostBuyMarketCapUsd < maxMarketCapUsd,
  };
}

export function maximumSpendWithSlippageLamports(
  nominalLamports: bigint,
  slippageBps: number,
): bigint | null {
  if (
    nominalLamports <= 0n ||
    !Number.isSafeInteger(slippageBps) ||
    slippageBps < 0 ||
    slippageBps > 10_000
  ) {
    return null;
  }
  const denominator = 10_000n;
  const numerator = nominalLamports * BigInt(10_000 + slippageBps);
  return (numerator + denominator - 1n) / denominator;
}

export function strictestPumpFunMarketCaps(
  snapshots: readonly PumpFunSupplySnapshot[],
  solPriceUsd: number,
  maxSpendLamports: bigint,
  maxMarketCapUsd: number,
): PumpFunMarketCapCheck | null {
  if (snapshots.length === 0) return null;
  const expectedSupply = snapshots[0]?.totalSupplyRaw;
  if (
    expectedSupply === undefined ||
    snapshots.some((snapshot) => snapshot.totalSupplyRaw !== expectedSupply)
  ) {
    return null;
  }
  const checks = snapshots.map((snapshot) =>
    projectedPumpFunMarketCaps(snapshot, solPriceUsd, maxSpendLamports, maxMarketCapUsd),
  );
  if (checks.some((check) => check === null)) return null;
  const complete = checks as PumpFunMarketCapCheck[];
  return {
    currentMarketCapUsd: Math.max(...complete.map((check) => check.currentMarketCapUsd)),
    projectedPostBuyMarketCapUsd: Math.max(
      ...complete.map((check) => check.projectedPostBuyMarketCapUsd),
    ),
    belowCap: complete.every((check) => check.belowCap),
  };
}

export function pumpFunCurrentMarketCapUsd(
  snapshot: PumpFunSupplySnapshot,
  solPriceUsd: number,
): number | undefined {
  if (!Number.isFinite(solPriceUsd) || solPriceUsd <= 0) return undefined;
  const lamports = marketCapLamports(
    snapshot.totalSupplyRaw,
    snapshot.virtualSolReservesLamports,
    snapshot.virtualTokenReservesRaw,
  );
  if (lamports === null) return undefined;
  const value = (Number(lamports) / 1e9) * solPriceUsd;
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function pumpFunTokenPriceUsd(
  snapshot: PumpFunSupplySnapshot,
  solPriceUsd: number,
): number | undefined {
  if (
    snapshot.virtualTokenReservesRaw <= 0n ||
    snapshot.virtualSolReservesLamports <= 0n ||
    !Number.isInteger(snapshot.decimals) ||
    snapshot.decimals < 0 ||
    snapshot.decimals > 18 ||
    !Number.isFinite(solPriceUsd) ||
    solPriceUsd <= 0
  ) {
    return undefined;
  }
  const rawTokenPriceSol =
    Number(snapshot.virtualSolReservesLamports) / 1e9 / Number(snapshot.virtualTokenReservesRaw);
  const uiTokenPriceUsd = rawTokenPriceSol * 10 ** snapshot.decimals * solPriceUsd;
  return Number.isFinite(uiTokenPriceUsd) && uiTokenPriceUsd > 0 ? uiTokenPriceUsd : undefined;
}

export function exactSupplyShareBps(netAcquiredRaw: bigint, totalSupplyRaw: bigint): bigint {
  if (netAcquiredRaw <= 0n || totalSupplyRaw <= 0n) return 0n;
  return (netAcquiredRaw * 10_000n) / totalSupplyRaw;
}

export function reachesSupplyThreshold(
  netAcquiredRaw: bigint,
  totalSupplyRaw: bigint,
  thresholdPct: number,
): boolean {
  if (
    netAcquiredRaw <= 0n ||
    totalSupplyRaw <= 0n ||
    !Number.isFinite(thresholdPct) ||
    thresholdPct < 10 ||
    thresholdPct > 20
  ) {
    return false;
  }
  const thresholdBasisPoints = BigInt(Math.round(thresholdPct * 100));
  return netAcquiredRaw * 10_000n >= totalSupplyRaw * thresholdBasisPoints;
}

export async function loadConfirmedSourceTransaction(
  connection: Connection,
  signature: string,
  options: {
    expectedSlot: number;
    knownBlockTimeMs?: number;
    timeoutMs?: number;
    pollIntervalMs?: number;
    rpcCallTimeoutMs?: number;
    searchTransactionHistory?: boolean;
  },
): Promise<ConfirmedSourceTransaction | null> {
  if (!signature || !Number.isSafeInteger(options.expectedSlot) || options.expectedSlot <= 0) {
    return null;
  }
  const timeoutMs = Math.max(0, options.timeoutMs ?? 1_500);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 100);
  const rpcCallTimeoutMs = Math.max(1, options.rpcCallTimeoutMs ?? 1_500);
  const deadline = Date.now() + timeoutMs;
  do {
    const statuses = await solanaRpcWithTimeout(
      connection.getSignatureStatuses([signature], {
        searchTransactionHistory: options.searchTransactionHistory === true,
      }),
      rpcCallTimeoutMs,
    );
    const status = statuses.value[0];
    if (status?.err) return null;
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      if (status.slot !== options.expectedSlot) return null;
      const knownBlockTimeMs = Number(options.knownBlockTimeMs);
      const blockTimeMs =
        Number.isFinite(knownBlockTimeMs) && knownBlockTimeMs > 0
          ? knownBlockTimeMs
          : Number(
              await solanaRpcWithTimeout(connection.getBlockTime(status.slot), rpcCallTimeoutMs),
            ) * 1_000;
      if (!Number.isFinite(blockTimeMs) || blockTimeMs <= 0) return null;
      return {
        slot: status.slot,
        blockTimeMs,
        confirmationStatus: status.confirmationStatus,
      };
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  } while (Date.now() <= deadline);
  return null;
}

export function confirmedSourceIsFresh(
  source: ConfirmedSourceTransaction,
  maxAgeMs: number,
  nowMs = Date.now(),
): boolean {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0 || !Number.isFinite(nowMs)) return false;
  const ageMs = nowMs - source.blockTimeMs;
  return ageMs >= -5_000 && ageMs <= maxAgeMs;
}
