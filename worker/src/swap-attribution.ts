import { PublicKey } from "@solana/web3.js";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCo24RDUuUuJZq8bn6T";
export const STABLECOIN_MINTS = new Set([USDC_MINT, USDT_MINT]);

const TOKEN_EPSILON = 1e-12;
export const MATERIAL_SOL_DELTA = 0.0005;
const SOL_OVERHEAD_CUSHION = 0.005;

export type WalletTokenDelta = {
  mint: string;
  pre: number;
  post: number;
  decimals: number;
  preRaw: bigint;
  postRaw: bigint;
  rawExact: boolean;
};

export type VerifiedTokenSpend = {
  mint: string;
  amountRaw: string;
  amountTokens: number;
  decimals: number;
};

export type VerifiedSpend = {
  amountUsd?: number;
  spentToken?: VerifiedTokenSpend;
  solSpend?: number;
};

export type VerifiedBuyAttribution = VerifiedSpend & {
  verified: boolean;
};

export type VerifiedSellAttribution = {
  verified: boolean;
  tokenBalanceBefore?: number;
  tokenBalanceAfter?: number;
  tokenBalanceBeforeRaw?: string;
  tokenBalanceAfterRaw?: string;
  soldAmountRaw?: string;
  soldFraction?: number;
  proceedsMint?: string;
  proceedsAmount?: number;
  proceedsAmountRaw?: string;
  proceedsDecimals?: number;
  signerCount: number;
};

export function parseRawTokenAmount(value: unknown): bigint | undefined {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    return undefined;
  }
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    return undefined;
  }
  const text = String(value);
  if (!/^\d+$/.test(text)) return undefined;
  try {
    return BigInt(text);
  } catch {
    return undefined;
  }
}

type TokenDeltaInput = Pick<WalletTokenDelta, "pre" | "post"> &
  Partial<Pick<WalletTokenDelta, "preRaw" | "postRaw" | "rawExact" | "decimals">>;

/** Returns an exact delta only when both raw balance sides were available. */
export function rawTokenDelta(row: TokenDeltaInput): bigint | undefined {
  return row.rawExact === true && typeof row.preRaw === "bigint" && typeof row.postRaw === "bigint"
    ? row.postRaw - row.preRaw
    : undefined;
}

/**
 * UI token balances are IEEE-754 numbers and can collapse distinct raw balances
 * to the same value. Use the raw delta for the economic amount when possible.
 */
export function tokenDelta(row: TokenDeltaInput): number {
  const raw = rawTokenDelta(row);
  const decimals = row.decimals;
  if (raw !== undefined && Number.isSafeInteger(decimals) && decimals! >= 0) {
    const amount = Number(raw) / 10 ** decimals!;
    if (Number.isFinite(amount)) return amount;
  }
  return row.post - row.pre;
}

/** Exact raw balances decide direction; epsilon is only a legacy fallback. */
export function tokenDeltaSign(row: TokenDeltaInput): -1 | 0 | 1 {
  const raw = rawTokenDelta(row);
  if (raw !== undefined) return raw > 0n ? 1 : raw < 0n ? -1 : 0;
  const delta = row.post - row.pre;
  if (!Number.isFinite(delta) || Math.abs(delta) <= TOKEN_EPSILON) return 0;
  return delta > 0 ? 1 : -1;
}

export function hasWalletSpecificSpend(
  rows: TokenDeltaInput[],
  solSpend: number | undefined,
): boolean {
  return (
    (solSpend !== undefined && solSpend > MATERIAL_SOL_DELTA) ||
    rows.some((row) => tokenDeltaSign(row) < 0)
  );
}

/**
 * Produces a conservative native-SOL input estimate. Transaction fees are
 * removed when this wallet is the fee payer, and a fixed cushion covers a
 * typical token-account rent charge or small landing tip. Valuation applies
 * an additional haircut later.
 */
export function conservativeNativeSolSpend(
  nativeSolDelta: number,
  feeLamports: number,
  targetIsFeePayer: boolean,
): number | undefined {
  if (!Number.isFinite(nativeSolDelta) || nativeSolDelta >= -MATERIAL_SOL_DELTA) {
    return undefined;
  }
  const feeSol =
    targetIsFeePayer && Number.isFinite(feeLamports) && feeLamports > 0 ? feeLamports / 1e9 : 0;
  const spend = -nativeSolDelta - feeSol - SOL_OVERHEAD_CUSHION;
  return Number.isFinite(spend) && spend > MATERIAL_SOL_DELTA ? spend : undefined;
}

/**
 * Attribute spend to an output only when the transaction has exactly one
 * acquired output and exactly one token input for this wallet. Ambiguous
 * multi-input/multi-output transactions intentionally remain unvalued.
 */
export function verifiedSpendForOutput(
  rows: WalletTokenDelta[],
  outputMint: string,
  outputCandidateCount: number,
): VerifiedSpend {
  if (outputCandidateCount !== 1) return {};

  const inputs = rows.filter((row) => row.mint !== outputMint && tokenDeltaSign(row) < 0);
  if (inputs.length !== 1) return {};

  const input = inputs[0];
  if (STABLECOIN_MINTS.has(input.mint)) {
    if (!input.rawExact || input.decimals !== 6) return {};
    const rawDelta = input.postRaw - input.preRaw;
    if (rawDelta >= 0n) return {};
    const amountRaw = -rawDelta;
    if (amountRaw > BigInt(Number.MAX_SAFE_INTEGER)) return {};
    const amountUsd = Number(amountRaw) / 10 ** input.decimals;
    return Number.isFinite(amountUsd) && amountUsd > 0 ? { amountUsd } : {};
  }

  if (!input.rawExact) return {};
  const rawDelta = input.postRaw - input.preRaw;
  if (rawDelta >= 0n) return {};
  const amountRaw = -rawDelta;
  const amountTokens = Math.abs(tokenDelta(input));
  if (!Number.isFinite(amountTokens) || amountTokens <= 0) return {};

  return {
    spentToken: {
      mint: input.mint,
      amountRaw: amountRaw.toString(),
      amountTokens,
      decimals: input.decimals,
    },
  };
}

/**
 * A buy is attributable only when there is one output plus one exact token
 * input from the same signer, or a separately adjusted native-SOL spend.
 */
export function attributeVerifiedBuy(
  rows: WalletTokenDelta[],
  outputMint: string,
  outputCandidateCount: number,
  solSpend: number | undefined,
  hasSwapSignal: boolean,
): VerifiedBuyAttribution {
  if (!hasSwapSignal) return { verified: false };
  const spend = verifiedSpendForOutput(rows, outputMint, outputCandidateCount);
  if (spend.amountUsd !== undefined || spend.spentToken !== undefined) {
    return { ...spend, verified: true };
  }
  const competingTokenInputs = rows.some(
    (row) => row.mint !== outputMint && tokenDeltaSign(row) < 0,
  );
  if (competingTokenInputs) return { verified: false };
  if (outputCandidateCount === 1 && solSpend !== undefined && solSpend > MATERIAL_SOL_DELTA) {
    return { solSpend, verified: true };
  }
  return { verified: false };
}

/**
 * Attribute a sale to a watched wallet from its own balance changes. This is
 * deliberately stricter than merely seeing a transaction-wide "Swap" log:
 * the wallet must sign, exactly one token must leave it, and exactly one
 * proceeds asset must return to it. Native SOL and WSOL are treated as the
 * same proceeds asset so account closing does not manufacture ambiguity.
 */
export function attributeVerifiedSell(
  rows: WalletTokenDelta[],
  soldMint: string,
  nativeSolDelta: number,
  hasSwapSignal: boolean,
  walletSigned: boolean,
  signerCount: number,
): VerifiedSellAttribution {
  const rejected = { verified: false, signerCount };
  if (!hasSwapSignal || !walletSigned || !Number.isInteger(signerCount) || signerCount < 1) {
    return rejected;
  }

  const sold = rows.find((row) => row.mint === soldMint);
  const soldPrePositive = sold
    ? sold.rawExact
      ? sold.preRaw > 0n
      : Number.isFinite(sold.pre) && sold.pre > 0
    : false;
  if (!sold || !soldPrePositive || tokenDeltaSign(sold) >= 0) {
    return rejected;
  }
  const soldAmount = -tokenDelta(sold);
  if (!Number.isFinite(soldAmount) || soldAmount <= 0) return rejected;

  const debits = rows.filter((row) => tokenDeltaSign(row) < 0);
  if (debits.length !== 1 || debits[0]?.mint !== soldMint) return rejected;

  const positiveTokens = rows.filter(
    (row) => row.mint !== soldMint && row.mint !== WSOL_MINT && tokenDeltaSign(row) > 0,
  );
  const wsolProceeds = rows
    .filter((row) => row.mint === WSOL_MINT)
    .reduce((sum, row) => sum + (tokenDeltaSign(row) > 0 ? tokenDelta(row) : 0), 0);
  const nativeProceeds = Number.isFinite(nativeSolDelta) ? Math.max(0, nativeSolDelta) : 0;
  const solProceeds = wsolProceeds + nativeProceeds;
  const proceedsCount = positiveTokens.length + (solProceeds > MATERIAL_SOL_DELTA ? 1 : 0);
  if (proceedsCount !== 1) return rejected;

  const tokenProceeds = positiveTokens[0];
  const proceedsMint = tokenProceeds?.mint ?? WSOL_MINT;
  const proceedsAmount = tokenProceeds ? tokenDelta(tokenProceeds) : solProceeds;
  if (!Number.isFinite(proceedsAmount) || proceedsAmount <= 0) return rejected;

  const soldRaw = rawTokenDelta(sold);
  const proceedsRaw = tokenProceeds ? rawTokenDelta(tokenProceeds) : undefined;
  const soldFraction =
    soldRaw !== undefined && sold.preRaw > 0n
      ? Number(-soldRaw) / Number(sold.preRaw)
      : soldAmount / sold.pre;

  return {
    verified: true,
    tokenBalanceBefore: sold.pre,
    tokenBalanceAfter: Math.max(0, sold.post),
    tokenBalanceBeforeRaw: sold.rawExact ? sold.preRaw.toString() : undefined,
    tokenBalanceAfterRaw: sold.rawExact ? sold.postRaw.toString() : undefined,
    soldAmountRaw: soldRaw !== undefined ? (-soldRaw).toString() : undefined,
    soldFraction: Number.isFinite(soldFraction)
      ? Math.min(1, Math.max(0, soldFraction))
      : undefined,
    proceedsMint,
    proceedsAmount,
    proceedsAmountRaw: proceedsRaw !== undefined ? proceedsRaw.toString() : undefined,
    proceedsDecimals: tokenProceeds?.decimals,
    signerCount,
  };
}

export function isOnCurveWallet(address: string): boolean {
  try {
    const key = new PublicKey(address);
    return PublicKey.isOnCurve(key.toBytes());
  } catch {
    return false;
  }
}
