import { fetch } from "undici";
import { env } from "./env.js";
import { USDC_MINT, type VerifiedTokenSpend } from "./swap-attribution.js";
import { parseJupiterTokenSpendQuote } from "./target-buy-valuation.js";

const QUOTE_TIMEOUT_MS = 800;
const SUCCESS_TTL_MS = 3_000;
const MAX_CACHE_ENTRIES = 512;

type QuoteCacheEntry = { value: number | undefined; expiresAt: number };
type QuoteFetch = (
  url: URL,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

type TokenSpendQuoterOptions = {
  apiKey: string;
  fetchImpl?: QuoteFetch;
  now?: () => number;
  timeoutMs?: number;
};

export function createTokenSpendQuoter(options: TokenSpendQuoterOptions) {
  const quoteCache = new Map<string, QuoteCacheEntry>();
  const quoteInFlight = new Map<string, Promise<number | undefined>>();
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as QuoteFetch);
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? QUOTE_TIMEOUT_MS;

  function trimQuoteCache(currentTime = now()) {
    for (const [key, entry] of quoteCache) {
      if (entry.expiresAt <= currentTime) quoteCache.delete(key);
    }
    while (quoteCache.size > MAX_CACHE_ENTRIES) {
      const oldest = quoteCache.keys().next().value;
      if (oldest === undefined) break;
      quoteCache.delete(oldest);
    }
  }

  async function fetchTokenSpendUsdOnce(
    spentToken: VerifiedTokenSpend,
    purchasedMint: string,
  ): Promise<number | undefined> {
    if (!options.apiKey || spentToken.mint === purchasedMint) return undefined;
    if (!/^\d+$/.test(spentToken.amountRaw) || BigInt(spentToken.amountRaw) <= 0n) {
      return undefined;
    }

    const url = new URL("https://api.jup.ag/swap/v2/order");
    url.searchParams.set("inputMint", spentToken.mint);
    url.searchParams.set("outputMint", USDC_MINT);
    url.searchParams.set("amount", spentToken.amountRaw);
    // Intentionally omit `taker`: Jupiter returns a quote only and cannot build
    // or submit a transaction without a wallet address.
    try {
      const response = await fetchImpl(url, {
        headers: { "x-api-key": options.apiKey },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return undefined;
      return parseJupiterTokenSpendQuote(await response.json(), {
        inputMint: spentToken.mint,
        inputAmountRaw: spentToken.amountRaw,
        purchasedMint,
      });
    } catch {
      return undefined;
    }
  }

  async function fetchTokenSpendUsd(
    spentToken: VerifiedTokenSpend,
    purchasedMint: string,
  ): Promise<number | undefined> {
    // Coalesced Geyser/RPC callers share this bounded retry. A transient first
    // timeout or 429 therefore cannot make both feeds permanently miss the
    // same otherwise-verifiable target buy.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const value = await fetchTokenSpendUsdOnce(spentToken, purchasedMint);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  return async function quoteTokenSpendUsd(
    spentToken: VerifiedTokenSpend,
    purchasedMint: string,
  ): Promise<number | undefined> {
    const key = `${spentToken.mint}:${spentToken.amountRaw}:${purchasedMint}`;
    const currentTime = now();
    const cached = quoteCache.get(key);
    if (cached && cached.expiresAt > currentTime) return cached.value;
    const pending = quoteInFlight.get(key);
    if (pending) return pending;

    const request = fetchTokenSpendUsd(spentToken, purchasedMint)
      .then((value) => {
        // Do not cache failures: a later RPC copy of the same transaction gets
        // one fresh chance after a transient timeout/429 on the Geyser path.
        if (value !== undefined) {
          quoteCache.set(key, { value, expiresAt: now() + SUCCESS_TTL_MS });
          trimQuoteCache();
        }
        return value;
      })
      .finally(() => quoteInFlight.delete(key));
    quoteInFlight.set(key, request);
    return request;
  };
}

export const quoteTokenSpendUsd = createTokenSpendQuoter({
  apiKey: env.JUPITER_API_KEY ?? "",
});
