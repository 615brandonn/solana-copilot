import { type Commitment, Connection, PublicKey } from "@solana/web3.js";
import { MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { BondingCurveAccount } from "pumpdotfun-sdk";

export const PUMP_FUN_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const BONDING_CURVE_SEED = Buffer.from("bonding-curve");
const BONDING_CURVE_DISCRIMINATOR = 6_966_180_631_402_821_399n;

export type PumpFunSupplySnapshot = {
  mint: string;
  observedSlot: number;
  totalSupplyRaw: bigint;
  decimals: number;
  virtualTokenReservesRaw: bigint;
  virtualSolReservesLamports: bigint;
  realTokenReservesRaw: bigint;
  complete: boolean;
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
  if (
    !account ||
    !account.owner.equals(PUMP_FUN_PROGRAM_ID) ||
    !mintAccount ||
    !mintAccount.owner.equals(TOKEN_PROGRAM_ID)
  ) {
    return null;
  }

  let curve: BondingCurveAccount;
  let decodedMint: ReturnType<typeof MintLayout.decode>;
  try {
    curve = BondingCurveAccount.fromBuffer(account.data);
    decodedMint = MintLayout.decode(mintAccount.data);
  } catch {
    return null;
  }
  if (
    curve.discriminator !== BONDING_CURVE_DISCRIMINATOR ||
    curve.tokenTotalSupply <= 0n ||
    curve.virtualTokenReserves <= 0n ||
    curve.virtualSolReserves <= 0n ||
    decodedMint.supply !== curve.tokenTotalSupply ||
    decodedMint.decimals < 0 ||
    decodedMint.decimals > 18
  ) {
    return null;
  }
  return {
    mint: tokenMint,
    observedSlot: response.context.slot,
    totalSupplyRaw: curve.tokenTotalSupply,
    decimals: decodedMint.decimals,
    virtualTokenReservesRaw: curve.virtualTokenReserves,
    virtualSolReservesLamports: curve.virtualSolReserves,
    realTokenReservesRaw: curve.realTokenReserves,
    complete: curve.complete,
  };
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
    // "Under $15k" is intentionally strict. Exactly $15,000 does not pass.
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
