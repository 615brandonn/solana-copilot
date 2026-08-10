import { USDC_MINT, type VerifiedTokenSpend } from "./swap-attribution.js";

const USDC_DECIMALS = 6;
const QUOTE_HAIRCUT = 0.9;
const SOL_VALUATION_HAIRCUT = 0.9;
const MAX_PRICE_IMPACT_PERCENT = 10;
const MAX_REASONABLE_USD_VALUE = 10_000_000;

export type TargetBuyValueInput = {
  tokenMint: string;
  amountUsd?: number;
  solDelta: number;
  solSpend?: number;
  spentToken?: VerifiedTokenSpend;
};

export type TargetBuyValuation = {
  amountUsd: number | undefined;
  source: "stablecoin" | "input-token-quote" | "sol" | "unavailable";
};

export type TargetBuyValuationDependencies = {
  quoteTokenSpendUsd: (
    spentToken: VerifiedTokenSpend,
    purchasedMint: string,
  ) => Promise<number | undefined>;
  solPriceUsd: () => Promise<number | undefined>;
};

export async function resolveTargetBuyValue(
  event: TargetBuyValueInput,
  dependencies: TargetBuyValuationDependencies,
): Promise<TargetBuyValuation> {
  if (Number.isFinite(event.amountUsd) && Number(event.amountUsd) > 0) {
    return { amountUsd: Number(event.amountUsd), source: "stablecoin" };
  }

  // A verified SPL-token debit is stronger evidence than native SOL movement,
  // because native movement also includes transaction fees and account rent.
  if (event.spentToken) {
    try {
      const amountUsd = await dependencies.quoteTokenSpendUsd(event.spentToken, event.tokenMint);
      if (Number.isFinite(amountUsd) && Number(amountUsd) > 0) {
        return { amountUsd: Number(amountUsd), source: "input-token-quote" };
      }
    } catch {
      // Fail closed. Do not reinterpret fee/rent SOL as the purchase amount.
    }
    return { amountUsd: undefined, source: "unavailable" };
  }

  if (Number.isFinite(event.solSpend) && Number(event.solSpend) > 0) {
    try {
      const solPrice = await dependencies.solPriceUsd();
      if (Number.isFinite(solPrice) && Number(solPrice) > 0) {
        return {
          amountUsd: Number(event.solSpend) * Number(solPrice) * SOL_VALUATION_HAIRCUT,
          source: "sol",
        };
      }
    } catch {
      // Fail closed below.
    }
  }

  return { amountUsd: undefined, source: "unavailable" };
}

type JupiterOrderQuote = {
  transaction?: unknown;
  inputMint?: unknown;
  outputMint?: unknown;
  inAmount?: unknown;
  outAmount?: unknown;
  inUsdValue?: unknown;
  outUsdValue?: unknown;
  priceImpact?: unknown;
  router?: unknown;
  error?: unknown;
  errorMessage?: unknown;
  errorCode?: unknown;
  routePlan?: unknown;
};

const ALLOWED_JUPITER_ROUTERS = new Set(["metis", "jupiterz", "dflow", "okx"]);

function finitePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function parseJupiterTokenSpendQuote(
  payload: unknown,
  expected: { inputMint: string; inputAmountRaw: string; purchasedMint: string },
): number | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const quote = payload as JupiterOrderQuote;
  if (quote.error || quote.errorMessage) return undefined;
  if (quote.errorCode !== undefined && quote.errorCode !== null && quote.errorCode !== 0) {
    return undefined;
  }
  if (quote.transaction !== null && quote.transaction !== undefined) return undefined;
  if (quote.inputMint !== expected.inputMint || quote.outputMint !== USDC_MINT) return undefined;
  if (typeof quote.inAmount !== "string" || quote.inAmount !== expected.inputAmountRaw) {
    return undefined;
  }
  if (typeof quote.router !== "string" || !ALLOWED_JUPITER_ROUTERS.has(quote.router)) {
    return undefined;
  }
  if (!Array.isArray(quote.routePlan) || quote.routePlan.length === 0) return undefined;
  if (typeof quote.priceImpact !== "number" || !Number.isFinite(quote.priceImpact)) {
    return undefined;
  }

  let outAmountRaw: bigint;
  try {
    if (typeof quote.outAmount !== "string") return undefined;
    const text = quote.outAmount;
    if (!/^\d+$/.test(text)) return undefined;
    outAmountRaw = BigInt(text);
  } catch {
    return undefined;
  }
  if (outAmountRaw <= 0n) return undefined;

  const outAmountUsd = Number(outAmountRaw) / 10 ** USDC_DECIMALS;
  const inUsdValue = finitePositiveNumber(quote.inUsdValue);
  const outUsdValue = finitePositiveNumber(quote.outUsdValue);
  const priceImpact = quote.priceImpact;
  if (
    !Number.isFinite(outAmountUsd) ||
    outAmountUsd <= 0 ||
    outAmountUsd > MAX_REASONABLE_USD_VALUE ||
    inUsdValue === undefined ||
    outUsdValue === undefined ||
    !Number.isFinite(priceImpact) ||
    Math.abs(priceImpact) > MAX_PRICE_IMPACT_PERCENT
  ) {
    return undefined;
  }

  const values = [outAmountUsd, inUsdValue, outUsdValue];
  const low = Math.min(...values);
  const high = Math.max(...values);
  if (low <= 0 || high / low > 1.25) return undefined;

  for (const leg of quote.routePlan) {
    if (!leg || typeof leg !== "object") return undefined;
    const swapInfo = (leg as Record<string, unknown>).swapInfo;
    if (!swapInfo || typeof swapInfo !== "object") return undefined;
    const row = swapInfo as Record<string, unknown>;
    if (typeof row.inputMint !== "string" || typeof row.outputMint !== "string") {
      return undefined;
    }
    if (row.inputMint === expected.purchasedMint || row.outputMint === expected.purchasedMint) {
      return undefined;
    }
  }

  // Use the most conservative of Jupiter's executable USDC output and its USD
  // estimates, then add a safety haircut before applying the user's minimum.
  return low * QUOTE_HAIRCUT;
}
